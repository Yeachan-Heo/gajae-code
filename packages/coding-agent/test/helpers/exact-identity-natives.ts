import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	NativeDirectoryTreeEntry,
	NativeDirectoryTreeResult,
	NativeDirectoryTreeSnapshot,
	NativeExactFileIdentity,
	NativeExactUnlinkResult,
} from "@gajae-code/natives";
import {
	type SessionStateLockNativeBindings,
	setSessionStateLockNativeBindings,
} from "../../src/gjc-runtime/session-state-lock";

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

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function sha256Of(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function exactUnlink(target: string, identity: NativeExactFileIdentity): NativeExactUnlinkResult {
	let stat: fs.BigIntStats;
	try {
		stat = fs.lstatSync(target, { bigint: true });
	} catch (error) {
		return isEnoent(error) ? { ok: false, code: "not_found" } : { ok: false, code: "io_error" };
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
	fs.unlinkSync(target);
	return { ok: true };
}

function treeEntries(root: string, relativePath: string, into: NativeDirectoryTreeEntry[]): string | undefined {
	const absolute = relativePath === "" ? root : path.join(root, relativePath);
	const stat = fs.lstatSync(absolute, { bigint: true });
	if (stat.isSymbolicLink()) return "reparse_point";
	if (!stat.isDirectory() && !stat.isFile()) return "unsupported_entry";
	const bytes = stat.isFile() ? fs.readFileSync(absolute) : undefined;
	into.push({
		relativePath,
		kind: stat.isDirectory() ? "directory" : "file",
		dev: String(stat.dev),
		ino: String(stat.ino),
		nlink: String(stat.nlink),
		size: String(stat.size),
		mtimeNs: String(stat.mtimeNs),
		ctimeNs: String(stat.ctimeNs),
		...(bytes ? { sha256: sha256Of(bytes) } : {}),
	});
	if (!stat.isDirectory()) return undefined;
	for (const name of fs.readdirSync(absolute).sort()) {
		const failure = treeEntries(root, relativePath === "" ? name : `${relativePath}/${name}`, into);
		if (failure) return failure;
	}
	return undefined;
}

function snapshotDirectoryTree(root: string): NativeDirectoryTreeResult {
	const entries: NativeDirectoryTreeEntry[] = [];
	try {
		const failure = treeEntries(root, "", entries);
		if (failure) return { ok: false, code: failure };
	} catch (error) {
		return isEnoent(error) ? { ok: false, code: "not_found" } : { ok: false, code: "io_error" };
	}
	const rootEntry = entries[0];
	if (rootEntry?.kind !== "directory") return { ok: false, code: "not_a_directory" };
	return { ok: true, snapshot: { rootDev: rootEntry.dev, rootIno: rootEntry.ino, entries } };
}

function exactRemoveDirectoryTree(root: string, snapshot: NativeDirectoryTreeSnapshot): NativeExactUnlinkResult {
	const observed = snapshotDirectoryTree(root);
	if (!observed.ok || !observed.snapshot) return { ok: false, code: observed.code ?? "io_error" };
	// Byte-for-byte tree equality: a changed owner token, an added payload, a replaced
	// inode, and a wholesale re-creation are all the same verdict — not ours to delete.
	if (JSON.stringify(observed.snapshot) !== JSON.stringify(snapshot)) return { ok: false, code: "identity_mismatch" };
	fs.rmSync(root, { recursive: true });
	return { ok: true };
}

export const exactIdentityNativeBindings: SessionStateLockNativeBindings = {
	exactUnlink,
	snapshotDirectoryTree,
	exactRemoveDirectoryTree,
};

/** Whether the compiled addon actually loads in this environment. */
function compiledNativesAvailable(): boolean {
	try {
		return typeof (require("@gajae-code/natives") as { exactUnlink?: unknown }).exactUnlink === "function";
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
