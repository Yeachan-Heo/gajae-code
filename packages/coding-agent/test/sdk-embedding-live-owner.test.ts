import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { findEmbeddedLiveOwner } from "../src/sdk/embedding";
import type { SessionLifecycleClient } from "../src/sdk/lifecycle/service";
import {
	cleanupFixtureRoots,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

const cleanups: Array<() => Promise<void>> = [];
const brokerRoots: FixtureRootCleanup[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	await cleanupFixtureRoots(brokerRoots);
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

test("a real broker accepts the exact lookup and answers none for a transcript nobody holds", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-embedding-owner-broker-")));
	const dir = path.join(root, "agent");
	const env = createFixtureBrokerEnvironment(root, dir);
	await Promise.all([dir, env.TMPDIR!, env.XDG_CONFIG_HOME!].map(item => fs.mkdir(item, { recursive: true })));
	const started = await withFixtureBrokerEnvironment(() => startFixtureBrokerWithLeaseForTest({ agentDir: dir, env }));
	brokerRoots.push(createFixtureRootCleanup(root, dir, started.lease));
	// `unknown` here would mean the broker refused the request shape, actor or target.
	expect(await findEmbeddedLiveOwner({ agentDir: dir, sessionId, timeoutMs: 10_000 })).toEqual({ kind: "none" });
}, 60_000);
