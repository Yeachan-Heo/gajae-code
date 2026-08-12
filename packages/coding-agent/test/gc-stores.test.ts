import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectFileLocksForGc, fileLocksGcAdapter } from "@gajae-code/coding-agent/config/file-lock-gc";
import type { GcContext, GcPidProbe } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import { collectGcReport, computeExitCode } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
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
		const { records, errors, warnings } = await collectFileLocksForGc(ctx, { roots: [spoolDir] });
		const byPath = new Map(records.map(r => [path.resolve(r.path ?? r.id), r]));
		expect(byPath.get(path.resolve(deadLock))?.removable).toBe(true);
		expect(byPath.get(path.resolve(aliveLock))?.removable).toBe(false);
		expect(byPath.get(path.resolve(oldLiveLock))?.removable).toBe(false);
		expect(byPath.get(path.resolve(malformedLock))?.removable).toBe(false);
		expect(errors).toEqual([]);
		expect(warnings ?? []).toEqual([]);

		// prune removes only the dead lock dir after re-probe.
		const outcome = await fileLocksGcAdapter.prune(byPath.get(path.resolve(deadLock))!, ctx);
		expect(outcome.removed).toBe(true);
		expect(await fs.exists(deadLock)).toBe(false);
		expect(await fs.exists(aliveLock)).toBe(true);
	});

	test("walk cap is a per-root warning and does not skip remaining roots (#3852)", async () => {
		const base = await makeTemp();
		const agentDir = path.join(base, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		// Flood the agent root so a tiny budget truncates it; spool stays small.
		const flooded = path.join(agentDir, "flood");
		await fs.mkdir(flooded, { recursive: true });
		for (let i = 0; i < 8; i++) {
			await fs.writeFile(path.join(flooded, `f${i}`), "x", "utf8");
		}

		const spoolDir = path.join(base, "spool");
		const spoolLock = path.join(spoolDir, "spool-dead.lock");
		await writeJson(path.join(spoolLock, "info"), { pid: DEAD_PID, timestamp: Date.now() });

		const ctx: GcContext = {
			probe: splitProbe,
			force: false,
			env: { ...process.env, GJC_RECEIPT_SPOOL_DIR: spoolDir },
			cwd: base,
		};
		// Budget of 3 is enough to start agent root but not exhaust its flood,
		// while still fully scanning the small spool root (independent budget).
		const roots = [agentDir, spoolDir];
		const result = await collectFileLocksForGc(ctx, { maxWalkEntries: 3, roots });
		expect(result.errors).toEqual([]);
		const warnings = result.warnings ?? [];
		expect(warnings.length).toBeGreaterThan(0);
		for (const warning of warnings) {
			expect(warning.store).toBe("file_locks");
			expect(warning.message).toContain("file lock discovery capped at 3 entries for root");
			expect(warning.message).toContain("scanned");
		}
		// Spool lock must still be discovered after agent root truncation.
		const spoolRec = result.records.find(r => path.resolve(r.path ?? r.id) === path.resolve(spoolLock));
		expect(spoolRec?.removable).toBe(true);

		const report = await collectGcReport(
			[
				{
					store: "file_locks",
					collect: async c => collectFileLocksForGc(c, { maxWalkEntries: 3, roots }),
					prune: fileLocksGcAdapter.prune.bind(fileLocksGcAdapter),
				},
			],
			ctx,
			false,
		);
		expect(report.errors).toEqual([]);
		expect(report.warnings.length).toBeGreaterThan(0);
		expect(computeExitCode(report)).toBe(0);
	});
});
