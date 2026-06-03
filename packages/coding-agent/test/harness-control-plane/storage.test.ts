import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	resolveHarnessRoot,
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

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "harness-store-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
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
});
