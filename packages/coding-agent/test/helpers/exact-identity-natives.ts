import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	NativeDirectoryTreeResult,
	NativeDirectoryTreeSnapshot,
	NativeExactFileIdentity,
	NativeExactUnlinkResult,
} from "@gajae-code/natives";
import {
	type SessionStateLockNativeBindings,
	setSessionStateLockNativeBindings,
} from "../../src/gjc-runtime/session-state-lock";
import { exactRemoveDirectoryTreeOp, snapshotDirectoryTreeOp } from "./exact-identity-tree-ops";

/**
 * A faithful in-process stand-in for the identity-bound deletion primitives.
 *
 * The behaviour under test is a REFUSAL: a removal must not happen when the object at the
 * pathname is no longer the exact one the caller proved. A double that reports success
 * would assert nothing and would let a read-then-`rm` implementation pass, so this
 * implementation re-derives `dev`/`ino`/`nlink`/`size`/`mtimeNs`/SHA-256 from the CURRENT
 * test filesystem and compares it against the supplied identity before touching anything.
 * A mismatch leaves every byte in place, exactly as the addon does.
 *
 * It is installed only where the compiled addon is absent, so CI still exercises the real
 * descriptor-relative implementation.
 */

function sha256Of(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function exactUnlink(target: string, identity: NativeExactFileIdentity): NativeExactUnlinkResult {
	let stat: fs.BigIntStats;
	try {
		stat = fs.lstatSync(target, { bigint: true });
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { ok: false, code: "not_found" }
			: { ok: false, code: "io_error" };
	}
	if (stat.isSymbolicLink()) return { ok: false, code: "reparse_point" };
	if (identity.directory === true ? !stat.isDirectory() : !stat.isFile())
		return { ok: false, code: "not_regular_file" };
	const bytes = stat.isFile() ? fs.readFileSync(target) : Buffer.alloc(0);
	if (
		stat.dev !== identity.dev ||
		stat.ino !== identity.ino ||
		(identity.nlink !== undefined && stat.nlink !== identity.nlink) ||
		stat.size !== identity.size ||
		stat.mtimeNs !== identity.mtimeNs ||
		(identity.sha256 !== undefined && identity.sha256 !== sha256Of(bytes))
	)
		return { ok: false, code: "identity_mismatch" };
	if (identity.directory === true) fs.rmdirSync(target);
	else fs.unlinkSync(target);
	return { ok: true };
}

async function exactUnlinkAsync(
	target: string,
	identity: NativeExactFileIdentity,
	timeoutMs?: number | null,
): Promise<NativeExactUnlinkResult> {
	return await settleWithTypedTimeout(Promise.resolve(exactUnlink(target, identity)), timeoutMs, performance.now(), {
		ok: false,
		code: "timed_out",
	});
}

/** Shared with the worker-thread doubles so the two shapes cannot drift. */
const snapshotDirectoryTree = snapshotDirectoryTreeOp;
const exactRemoveDirectoryTree = exactRemoveDirectoryTreeOp;

/**
 * A worker-thread stand-in for the addon's dedicated `pi-natives-*` threads.
 *
 * The reviewer's objection to the previous doubles was REAL: an async double that
 * runs the whole recursive walk inline is synchronous in everything but name, so
 * no test could ever observe JS-thread blocking or validate timeout behavior. This
 * implementation runs the identical walk on a real worker thread with the same
 * semantics the addon exposes: the JS thread returns immediately, a wedged walk
 * cannot stall the event loop, and `timeoutMs` settles with the same typed
 * `timed_out` refusal instead of a partial capture.
 *
 * A single worker is shared across calls, mirroring the addon's bounded
 * outstanding-worker budget: concurrent calls queue behind one walk exactly as
 * saturated admission does, so tests observe real queuing behavior.
 */
const exactDirectoryTreeWorker = new Worker(new URL("./exact-identity-tree-worker.ts", import.meta.url).href, {
	type: "module",
});

interface ExactDirectoryTreeWorkerRequest {
	id: number;
	op: "snapshot" | "remove";
	root: string;
	snapshot?: NativeDirectoryTreeSnapshot;
}

let exactDirectoryTreeWorkerNextId = 1;
const exactDirectoryTreeWorkerPending = new Map<number, PromiseWithResolvers<unknown>>();

exactDirectoryTreeWorker.onmessage = (event: MessageEvent<{ id: number; result: unknown }>) => {
	const pending = exactDirectoryTreeWorkerPending.get(event.data.id);
	if (!pending) return;
	exactDirectoryTreeWorkerPending.delete(event.data.id);
	pending.resolve(event.data.result);
};

exactDirectoryTreeWorker.onerror = () => {
	// Every waiter fails closed as an I/O refusal; the lock protocol never deletes
	// on an indeterminate answer.
	for (const pending of exactDirectoryTreeWorkerPending.values()) {
		pending.reject(new Error("exact identity tree worker failed"));
	}
	exactDirectoryTreeWorkerPending.clear();
};

function runOnExactDirectoryTreeWorker(request: Omit<ExactDirectoryTreeWorkerRequest, "id">): Promise<unknown> {
	const id = exactDirectoryTreeWorkerNextId++;
	const pending = Promise.withResolvers<unknown>();
	exactDirectoryTreeWorkerPending.set(id, pending);
	exactDirectoryTreeWorker.postMessage({ ...request, id });
	return pending.promise;
}

/** Mirrors `snapshot_directory_tree_async` on a real worker thread with typed timeout refusal. */
async function snapshotDirectoryTreeAsync(
	root: string,
	timeoutMs?: number | undefined | null,
): Promise<NativeDirectoryTreeResult> {
	const startedAt = performance.now();
	const settled = runOnExactDirectoryTreeWorker({ op: "snapshot", root }) as Promise<NativeDirectoryTreeResult>;
	return await settleWithTypedTimeout(settled, timeoutMs, startedAt, { ok: false, code: "timed_out" });
}

/** Mirrors `exact_remove_directory_tree_async` on a real worker thread with typed timeout refusal. */
async function exactRemoveDirectoryTreeAsync(
	root: string,
	snapshot: NativeDirectoryTreeSnapshot,
	_parentIdentity?: unknown,
	timeoutMs?: number | undefined | null,
): Promise<NativeExactUnlinkResult> {
	const startedAt = performance.now();
	const settled = runOnExactDirectoryTreeWorker({
		op: "remove",
		root,
		snapshot,
	}) as Promise<NativeExactUnlinkResult>;
	return await settleWithTypedTimeout(settled, timeoutMs, startedAt, { ok: false, code: "timed_out" });
}

/**
 * The addon settles `timeout_ms` with a typed refusal value while the worker keeps
 * running; the JS side never blocks on the worker's completion. The double must do
 * the same, or the deadline path under test would only ever see settled work.
 */
async function settleWithTypedTimeout<T>(
	settled: Promise<T>,
	timeoutMs: number | undefined | null,
	startedAt: number,
	timeoutValue: T,
): Promise<T> {
	if (timeoutMs === undefined || timeoutMs === null) return await settled;
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.resolve(), Math.max(1, timeoutMs - (performance.now() - startedAt)));
	timer.unref();
	try {
		return await Promise.race([settled, timeout.promise.then(() => timeoutValue)]);
	} finally {
		clearTimeout(timer);
	}
}

export const exactIdentityNativeBindings: SessionStateLockNativeBindings = {
	exactUnlink,
	exactUnlinkAsync,
	snapshotDirectoryTree,
	snapshotDirectoryTreeAsync: (root, timeoutMs) => snapshotDirectoryTreeAsync(root, timeoutMs),
	exactRemoveDirectoryTree,
	exactRemoveDirectoryTreeAsync: (root, snapshot, parentIdentity, timeoutMs) =>
		exactRemoveDirectoryTreeAsync(root, snapshot, parentIdentity, timeoutMs),
};

/** Whether the compiled addon actually loads in this environment. */
function compiledNativesAvailable(): boolean {
	try {
		const native = require("@gajae-code/natives") as {
			exactUnlink?: unknown;
			exactUnlinkAsync?: unknown;
			snapshotDirectoryTree?: (path: string) => NativeDirectoryTreeResult;
			snapshotDirectoryTreeAsync?: unknown;
			exactRemoveDirectoryTree?: (path: string, snapshot: NativeDirectoryTreeSnapshot) => NativeExactUnlinkResult;
			exactRemoveDirectoryTreeAsync?: unknown;
		};
		if (
			typeof native.exactUnlink === "function" &&
			typeof native.exactUnlinkAsync === "function" &&
			typeof native.snapshotDirectoryTreeAsync === "function" &&
			typeof native.exactRemoveDirectoryTreeAsync === "function"
		) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-native-capability-"));
			const directory = path.join(root, "claim");
			try {
				fs.mkdirSync(directory);
				const snapshot = native.snapshotDirectoryTree?.(directory);
				const removed =
					snapshot?.ok && snapshot.snapshot
						? (native.exactRemoveDirectoryTree?.(directory, snapshot.snapshot) ?? { ok: false })
						: { ok: false };
				return (
					(removed.ok || (removed.code === "cleanup_pending" && typeof removed.detachedPath === "string")) &&
					!fs.existsSync(directory)
				);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Point the coordinator state lock at deletion primitives that actually work here.
 *
 * Where the compiled addon is present it is left in place, so CI exercises the real
 * descriptor-relative implementation; only where it is absent does the stand-in take over.
 * Either way the lock protocol itself — not the addon's availability — is what the calling
 * suite ends up testing.
 */
export function installExactIdentityNatives(): void {
	setSessionStateLockNativeBindings(compiledNativesAvailable() ? undefined : () => exactIdentityNativeBindings);
}
