import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileLocksGcAdapter } from "@gajae-code/coding-agent/config/file-lock-gc";
import type { GcContext, GcPidProbe } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import { teamWorkersGcAdapter } from "@gajae-code/coding-agent/gjc-runtime/team-gc";
import {
	harnessLeasesGcAdapter,
	registryEntriesGcAdapter,
} from "@gajae-code/coding-agent/harness-control-plane/gc-adapter";

const DEAD_PID = 4242;
const ALIVE_PID = 4243;

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTemp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-stores-"));
	tempDirs.push(dir);
	return dir;
}

/** Dead only for DEAD_PID; everything else is a live (kept) process. */
const splitProbe: GcPidProbe = pid => (pid === DEAD_PID ? { status: "dead" } : { status: "keep", reason: "alive" });

function ctxFor(base: string, registryDir: string, probe: GcPidProbe = splitProbe): GcContext {
	return { probe, force: false, env: { ...process.env, GJC_HARNESS_ROOT_REGISTRY_DIR: registryDir }, cwd: base };
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function lease(sessionId: string, pid: number) {
	const now = new Date();
	return {
		ownerId: `owner-${sessionId}`,
		sessionId,
		pid,
		leaseTokenHash: "deadbeef",
		endpoint: null,
		eventsPath: "events.jsonl",
		heartbeatAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
		leaseEpoch: 1,
		writer: { ownerId: `owner-${sessionId}`, leaseEpoch: 1 },
	};
}

describe("harnessLeasesGcAdapter", () => {
	test("dead-pid lease is removable; prune reaps the lease file", async () => {
		const base = await makeTemp();
		const root = path.join(base, "root");
		const registryDir = path.join(base, "reg");
		await writeJson(path.join(registryDir, "h-dead.json"), {
			sessionId: "h-dead",
			roots: [{ root, updatedAt: new Date().toISOString() }],
		});
		const leaseFile = path.join(root, "sessions", "h-dead", "lease.json");
		await writeJson(leaseFile, lease("h-dead", DEAD_PID));

		const ctx = ctxFor(base, registryDir);
		const { records } = await harnessLeasesGcAdapter.collect(ctx);
		const rec = records.find(r => r.id === "h-dead");
		expect(rec).toBeDefined();
		expect(rec?.removable).toBe(true);
		expect(rec?.status).toBe("dead");
		expect(rec?.pid_status).toBe("dead");

		const outcome = await harnessLeasesGcAdapter.prune(rec!, ctx);
		expect(outcome.removed).toBe(true);
		expect(await fs.exists(leaseFile)).toBe(false);
	});

	test("live-pid lease is kept (never removable)", async () => {
		const base = await makeTemp();
		const root = path.join(base, "root");
		const registryDir = path.join(base, "reg");
		await writeJson(path.join(registryDir, "h-live.json"), {
			sessionId: "h-live",
			roots: [{ root, updatedAt: new Date().toISOString() }],
		});
		await writeJson(path.join(root, "sessions", "h-live", "lease.json"), lease("h-live", ALIVE_PID));

		const { records } = await harnessLeasesGcAdapter.collect(ctxFor(base, registryDir));
		const rec = records.find(r => r.id === "h-live");
		expect(rec?.removable).toBe(false);
	});
});

describe("registryEntriesGcAdapter", () => {
	test("registry pointing at a missing session dir is a removable dangling entry", async () => {
		const base = await makeTemp();
		const root = path.join(base, "root");
		const registryDir = path.join(base, "reg");
		await fs.mkdir(path.join(root, "sessions"), { recursive: true });
		await writeJson(path.join(registryDir, "h-gone.json"), {
			sessionId: "h-gone",
			roots: [{ root, updatedAt: new Date().toISOString() }],
		});

		const { records } = await registryEntriesGcAdapter.collect(ctxFor(base, registryDir));
		const rec = records.find(r => r.id === "h-gone");
		expect(rec).toBeDefined();
		expect(rec?.removable).toBe(true);
		expect(rec?.status).toBe("dangling");
	});

	test("registry whose session dir still exists is not dangling", async () => {
		const base = await makeTemp();
		const root = path.join(base, "root");
		const registryDir = path.join(base, "reg");
		await fs.mkdir(path.join(root, "sessions", "h-here"), { recursive: true });
		await writeJson(path.join(registryDir, "h-here.json"), {
			sessionId: "h-here",
			roots: [{ root, updatedAt: new Date().toISOString() }],
		});

		const { records } = await registryEntriesGcAdapter.collect(ctxFor(base, registryDir));
		expect(records.find(r => r.id === "h-here")).toBeUndefined();
	});
});

describe("fileLocksGcAdapter", () => {
	test("dead-pid lock removable; live + malformed locks kept; old timestamp alone never removable", async () => {
		const base = await makeTemp();
		const spoolDir = path.join(base, "spool");
		const deadLock = path.join(spoolDir, "dead.lock");
		const aliveLock = path.join(spoolDir, "alive.lock");
		const oldLiveLock = path.join(spoolDir, "old.lock");
		const malformedLock = path.join(spoolDir, "bad.lock");
		await writeJson(path.join(deadLock, "info"), { pid: DEAD_PID, timestamp: Date.now() });
		await writeJson(path.join(aliveLock, "info"), { pid: ALIVE_PID, timestamp: Date.now() });
		await writeJson(path.join(oldLiveLock, "info"), { pid: ALIVE_PID, timestamp: 1 });
		await fs.mkdir(malformedLock, { recursive: true });
		await fs.writeFile(path.join(malformedLock, "info"), "not json", "utf8");

		const ctx: GcContext = {
			probe: splitProbe,
			force: false,
			env: { ...process.env, GJC_RECEIPT_SPOOL_DIR: spoolDir },
			cwd: base,
		};
		const { records } = await fileLocksGcAdapter.collect(ctx);
		const byPath = new Map(records.map(r => [path.resolve(r.path ?? r.id), r]));
		expect(byPath.get(path.resolve(deadLock))?.removable).toBe(true);
		expect(byPath.get(path.resolve(aliveLock))?.removable).toBe(false);
		expect(byPath.get(path.resolve(oldLiveLock))?.removable).toBe(false);
		expect(byPath.get(path.resolve(malformedLock))?.removable).toBe(false);

		// prune removes only the dead lock dir after re-probe.
		const outcome = await fileLocksGcAdapter.prune(byPath.get(path.resolve(deadLock))!, ctx);
		expect(outcome.removed).toBe(true);
		expect(await fs.exists(deadLock)).toBe(false);
		expect(await fs.exists(aliveLock)).toBe(true);
	});
});

describe("teamWorkersGcAdapter (PID dominance)", () => {
	test("dead-pid worker removable; live-pid worker with failed lifecycle is KEPT", async () => {
		const base = await makeTemp();
		const harnessRoot = path.join(base, "state", "harness");
		const teamRoot = path.join(base, "state", "team");
		const registryDir = path.join(base, "reg");
		await writeJson(path.join(registryDir, "h-x.json"), {
			sessionId: "h-x",
			roots: [{ root: harnessRoot, updatedAt: new Date().toISOString() }],
		});
		const deadWorker = path.join(teamRoot, "alpha", "workers", "w-dead");
		const liveFailedWorker = path.join(teamRoot, "alpha", "workers", "w-live-failed");
		await writeJson(path.join(deadWorker, "heartbeat.json"), {
			pid: DEAD_PID,
			last_turn_at: new Date().toISOString(),
			turn_count: 0,
		});
		await writeJson(path.join(deadWorker, "lifecycle.json"), {
			pid: DEAD_PID,
			lifecycle_state: "running",
			stop_reason: null,
		});
		await writeJson(path.join(liveFailedWorker, "heartbeat.json"), {
			pid: ALIVE_PID,
			last_turn_at: new Date().toISOString(),
			turn_count: 0,
		});
		await writeJson(path.join(liveFailedWorker, "lifecycle.json"), {
			pid: ALIVE_PID,
			lifecycle_state: "failed",
			stop_reason: "crashed",
		});

		const { records } = await teamWorkersGcAdapter.collect(ctxFor(base, registryDir));
		const dead = records.find(r => r.id === "alpha/w-dead");
		const liveFailed = records.find(r => r.id === "alpha/w-live-failed");
		expect(dead?.removable).toBe(true);
		expect(dead?.status).toBe("dead");
		// PID liveness dominates the failed lifecycle => kept.
		expect(liveFailed?.removable).toBe(false);
	});

	test("dead heartbeat pid but LIVE lifecycle pid is KEPT (all-PID dominance)", async () => {
		const base = await makeTemp();
		const harnessRoot = path.join(base, "state", "harness");
		const teamRoot = path.join(base, "state", "team");
		const registryDir = path.join(base, "reg");
		await writeJson(path.join(registryDir, "h-mixed.json"), {
			sessionId: "h-mixed",
			roots: [{ root: harnessRoot, updatedAt: new Date().toISOString() }],
		});
		const mixedWorker = path.join(teamRoot, "alpha", "workers", "w-mixed");
		// heartbeat pid is dead, but the lifecycle pid is a live process => keep.
		await writeJson(path.join(mixedWorker, "heartbeat.json"), {
			pid: DEAD_PID,
			last_turn_at: new Date().toISOString(),
			turn_count: 0,
		});
		await writeJson(path.join(mixedWorker, "lifecycle.json"), {
			pid: ALIVE_PID,
			lifecycle_state: "running",
			stop_reason: null,
		});

		const { records } = await teamWorkersGcAdapter.collect(ctxFor(base, registryDir));
		const mixed = records.find(r => r.id === "alpha/w-mixed");
		expect(mixed?.removable).toBe(false);
	});
});
