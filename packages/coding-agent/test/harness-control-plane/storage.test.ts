import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	appendEvent,
	assertSafeSessionId,
	controlSocketPath,
	generateSessionId,
	MAX_UNIX_SOCKET_PATH_BYTES,
	readEvents,
	readReceiptIndex,
	readSessionState,
	rememberHarnessSessionRoot,
	resolveHarnessRoot,
	resolveHarnessSessionRoot,
	StorageError,
	sessionPaths,
	writeReceiptImmutable,
	writeSessionState,
} from "../../src/harness-control-plane/storage";
import {
	type EventEnvelope,
	SESSION_SCHEMA_VERSION,
	type SessionHandle,
	type SessionState,
} from "../../src/harness-control-plane/types";

let root: string;
let registryRoot: string;
let registryEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "harness-store-"));
	registryRoot = await mkdtemp(path.join(tmpdir(), "harness-root-registry-"));
	registryEnv = { ...process.env, GJC_HARNESS_ROOT_REGISTRY_DIR: registryRoot };
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(registryRoot, { recursive: true, force: true });
});

function state(sessionId: string): SessionState {
	const now = new Date().toISOString();
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId,
		lifecycle: "started",
		harness: "gajae-code",
		handle: { sessionId, harness: "gajae-code", workspace: "." } as SessionHandle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
	};
}

function envelope(cursor: number): EventEnvelope {
	return {
		eventId: `e-${cursor}`,
		cursor,
		createdAt: new Date().toISOString(),
		severity: "info",
		kind: "test",
		state: { sessionId: "h-1", lifecycle: "started", harness: "gajae-code", ownerLive: false, blockers: [] },
		evidence: {},
		nextAllowedActions: [],
		writer: { ownerId: "owner-1", leaseEpoch: 1 },
	};
}

function registryPath(sessionId: string): string {
	return path.join(registryRoot, `${sessionId}.json`);
}

function mode(bits: number): number {
	return bits & 0o777;
}

describe("harness storage", () => {
	it("round-trips session state under sessions/<id>/state.json", async () => {
		const id = "h-roundtrip";
		await writeSessionState(root, state(id));
		const loaded = await readSessionState(root, id);
		expect(loaded?.sessionId).toBe(id);
		expect(sessionPaths(root, id).state.endsWith(path.join("sessions", id, "state.json"))).toBe(true);
	});

	it("returns null for a missing session", async () => {
		expect(await readSessionState(root, "h-missing")).toBeNull();
	});

	it("rejects unsafe session ids", () => {
		expect(() => assertSafeSessionId("../escape")).toThrow(StorageError);
		expect(() => assertSafeSessionId("ok-123")).not.toThrow();
	});

	it("receipts are immutable: re-writing the same id fails closed", async () => {
		const id = "h-receipt";
		await writeSessionState(root, state(id));
		const receipt = { receiptId: "r-1", family: "vanish" as const, valid: true, createdAt: new Date().toISOString() };
		const entry = await writeReceiptImmutable(root, id, "vanish", "r-1", receipt);
		expect(entry.family).toBe("vanish");
		await expect(writeReceiptImmutable(root, id, "vanish", "r-1", receipt)).rejects.toThrow(
			/receipt_immutable_conflict/,
		);
		const index = await readReceiptIndex(root, id, "vanish");
		expect(index).toHaveLength(1);
	});

	it("events append + tail by cursor (tail-only, never mutated)", async () => {
		const id = "h-events";
		await writeSessionState(root, state(id));
		await appendEvent(root, id, envelope(1));
		await appendEvent(root, id, envelope(2));
		await appendEvent(root, id, envelope(3));
		expect(await readEvents(root, id, 0)).toHaveLength(3);
		const tail = await readEvents(root, id, 1);
		expect(tail.map(e => e.cursor)).toEqual([2, 3]);
	});

	it("resolveHarnessRoot honors GJC_HARNESS_STATE_ROOT then cwd default", () => {
		expect(resolveHarnessRoot({ root: "/x/y" })).toBe(path.resolve("/x/y"));
		expect(resolveHarnessRoot({ env: { GJC_HARNESS_STATE_ROOT: "/z" } as NodeJS.ProcessEnv })).toBe(
			path.resolve("/z"),
		);
		expect(resolveHarnessRoot({ cwd: "/repo", env: {} as NodeJS.ProcessEnv })).toBe(
			path.join("/repo", ".gjc", "state", "harness"),
		);
	});

	it("generateSessionId produces safe ids", () => {
		expect(() => assertSafeSessionId(generateSessionId())).not.toThrow();
	});

	it("controlSocketPath is stable, short, and records metadata", async () => {
		const id = "h-socket";
		const socketDir = await mkdtemp(path.join(tmpdir(), "h-"));
		const first = controlSocketPath(root, id, { GJC_HARNESS_SOCKET_DIR: socketDir } as NodeJS.ProcessEnv);
		const second = controlSocketPath(root, id, { GJC_HARNESS_SOCKET_DIR: socketDir } as NodeJS.ProcessEnv);
		expect(first).toBe(second);
		expect(Buffer.byteLength(first)).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES);
		expect(first.startsWith(socketDir)).toBe(true);
		expect(path.basename(first)).toMatch(/^c-[0-9a-f]{16}\.sock$/);
		const metadata = JSON.parse(await readFile(first.replace(/\.sock$/, ".json"), "utf8")) as Record<string, unknown>;
		expect(metadata).toEqual({ root, sessionId: id });
	});

	it("controlSocketPath uses GJC_HARNESS_SOCKET_DIR when set", async () => {
		const socketDir = await mkdtemp(path.join(tmpdir(), "e-"));
		const socketPath = controlSocketPath(root, "h-env", { GJC_HARNESS_SOCKET_DIR: socketDir } as NodeJS.ProcessEnv);
		expect(socketPath.startsWith(socketDir)).toBe(true);
	});

	it("controlSocketPath falls back to tmp base when override is too long", async () => {
		const oldTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = "/tmp";
		try {
			const longDir = path.join(root, "x".repeat(80));
			const socketPath = controlSocketPath(root, "h-fallback", {
				GJC_HARNESS_SOCKET_DIR: longDir,
			} as NodeJS.ProcessEnv);
			expect(socketPath.startsWith(longDir)).toBe(false);
			expect(socketPath.includes("gjch")).toBe(true);
			expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES);
		} finally {
			if (oldTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = oldTmpdir;
		}
	});

	it("controlSocketPath throws socket_path_too_long when tmp base is too long", async () => {
		const oldTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = path.join(root, "t".repeat(80));
		try {
			expect(() =>
				controlSocketPath(root, "h-too-long", {
					GJC_HARNESS_SOCKET_DIR: path.join(root, "o".repeat(80)),
				} as NodeJS.ProcessEnv),
			).toThrow(/socket_path_too_long/);
		} finally {
			if (oldTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = oldTmpdir;
		}
	});

	it("controlSocketPath extends the hash on metadata collision", async () => {
		const id = "h-collision";
		const socketDir = path.join("/tmp", `c-${process.pid}`);
		const digest = createHash("sha256").update(`${root}\0${id}`).digest("hex");
		await mkdir(socketDir, { recursive: true });
		await writeFile(
			path.join(socketDir, `c-${digest.slice(0, 16)}.json`),
			`${JSON.stringify({ root: "other", sessionId: id })}\n`,
		);
		const socketPath = controlSocketPath(root, id, { GJC_HARNESS_SOCKET_DIR: socketDir } as NodeJS.ProcessEnv);
		expect(path.basename(socketPath)).toBe(`c-${digest.slice(0, 24)}.sock`);
	});

	it("does not pick an arbitrary registered root when explicit session ids collide", async () => {
		const id = `h-collide-${process.pid}`;
		const leftRoot = await mkdtemp(path.join(tmpdir(), "h-left-"));
		const rightRoot = await mkdtemp(path.join(tmpdir(), "h-right-"));
		try {
			await writeSessionState(leftRoot, { ...state(id), handle: { ...state(id).handle, workspace: "/repo/left" } });
			await writeSessionState(rightRoot, {
				...state(id),
				handle: { ...state(id).handle, workspace: "/repo/right" },
			});
			await rememberHarnessSessionRoot(leftRoot, id, registryEnv);
			await rememberHarnessSessionRoot(rightRoot, id, registryEnv);

			await expect(resolveHarnessSessionRoot(root, id, registryEnv)).rejects.toThrow(
				/ambiguous_harness_session_root/,
			);
			expect(await resolveHarnessSessionRoot(root, id, registryEnv, { expectedWorkspace: "/repo/left" })).toBe(
				path.resolve(leftRoot),
			);
			expect(await resolveHarnessSessionRoot(root, id, registryEnv, { expectedWorkspace: "/repo/right" })).toBe(
				path.resolve(rightRoot),
			);
			await expect(
				resolveHarnessSessionRoot(root, id, registryEnv, { expectedWorkspace: "/repo/missing" }),
			).rejects.toThrow(/session_workspace_mismatch/);
		} finally {
			await rm(leftRoot, { recursive: true, force: true });
			await rm(rightRoot, { recursive: true, force: true });
		}
	});

	it("uses expectedWorkspace registry disambiguation instead of stale local same-session state", async () => {
		const id = `h-stale-local-${process.pid}`;
		const registeredRoot = await mkdtemp(path.join(tmpdir(), "h-registered-"));
		try {
			await writeSessionState(root, { ...state(id), handle: { ...state(id).handle, workspace: "/repo/stale" } });
			await writeSessionState(registeredRoot, {
				...state(id),
				handle: { ...state(id).handle, workspace: "/repo/expected" },
			});
			await rememberHarnessSessionRoot(registeredRoot, id, registryEnv);

			expect(await resolveHarnessSessionRoot(root, id, registryEnv, { expectedWorkspace: "/repo/expected" })).toBe(
				path.resolve(registeredRoot),
			);
		} finally {
			await rm(registeredRoot, { recursive: true, force: true });
		}
	});

	it("stores global registry files with private permissions", async () => {
		const id = `h-private-${process.pid}`;
		const file = registryPath(id);
		const dir = path.dirname(file);
		await rm(dir, { recursive: true, force: true });
		await rememberHarnessSessionRoot(root, id, registryEnv);
		const dirStat = await stat(dir);
		const fileStat = await stat(file);
		expect(mode(dirStat.mode)).toBe(0o700);
		expect(mode(fileStat.mode)).toBe(0o600);

		await chmod(dir, 0o775);
		await chmod(file, 0o664);
		await rememberHarnessSessionRoot(root, id, registryEnv);
		expect(mode((await stat(dir)).mode)).toBe(0o700);
		expect(mode((await stat(file)).mode)).toBe(0o600);
	});
});
