import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	appendEvent,
	assertSafeSessionId,
	generateSessionId,
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
});
