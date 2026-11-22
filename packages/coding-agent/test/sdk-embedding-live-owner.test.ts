import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findEmbeddedLiveOwner } from "../src/sdk/embedding";
import type { SessionLifecycleClient } from "../src/sdk/lifecycle/service";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function agentDir() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-embedding-owner-")));
	cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
	return directory;
}

const sessionId = "0b0f8a52-6a8f-4a59-9d1c-1f3c2d4e5f60";
/** A broker answer for one exact session.list request. */
function broker(sessions: Array<{ sessionId: string; live?: boolean }>, seen: unknown[] = []): SessionLifecycleClient {
	return {
		global: async (operation, input) => {
			seen.push({ operation, input });
			return { ok: true, result: { indexSeq: 1, sessions, warnings: [] } };
		},
	};
}

test("with no broker running it answers at once and starts nothing", async () => {
	const dir = await agentDir();
	const started = Date.now();
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId })).toEqual({
		kind: "unknown",
		reason: "broker_absent",
	});
	expect(Date.now() - started).toBeLessThan(500);
	expect(await Bun.file(path.join(dir, "sdk", "broker.json")).exists()).toBe(false);
});

test("reports a live owner only for the exact session the broker lists as live", async () => {
	const dir = await agentDir();
	const seen: unknown[] = [];
	expect(
		await findEmbeddedLiveOwner({ agentDir: dir, sessionId, client: broker([{ sessionId, live: true }], seen) }),
	).toEqual({ kind: "live" });
	// One exact lookup: no workspace scan, no saved-session recap.
	expect(seen).toEqual([{ operation: "session.list", input: { resolveSessionId: sessionId } }]);
	expect(
		await findEmbeddedLiveOwner({ agentDir: dir, sessionId, client: broker([{ sessionId, live: false }]) }),
	).toEqual({ kind: "none" });
	expect(
		await findEmbeddedLiveOwner({
			agentDir: dir,
			sessionId,
			client: broker([{ sessionId: "1b0f8a52-6a8f-4a59-9d1c-1f3c2d4e5f60", live: true }]),
		}),
	).toEqual({ kind: "none" });
});

test("a broker that fails or does not answer in time is reported as unknown", async () => {
	const dir = await agentDir();
	const failing: SessionLifecycleClient = {
		global: async () => {
			throw new Error("connection refused");
		},
	};
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, client: failing })).toEqual({
		kind: "unknown",
		reason: "broker_unavailable",
	});
	const silent: SessionLifecycleClient = { global: () => Promise.withResolvers<unknown>().promise };
	const started = Date.now();
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, client: silent, timeoutMs: 50 })).toEqual({
		kind: "unknown",
		reason: "broker_unavailable",
	});
	expect(Date.now() - started).toBeLessThan(1000);
});
