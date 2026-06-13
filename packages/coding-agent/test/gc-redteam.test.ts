import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileLocksGcAdapter } from "@gajae-code/coding-agent/config/file-lock-gc";
import {
	collectGcReport,
	computeExitCode,
	type GcContext,
	type GcPidProbe,
	type GcRecord,
	type GcStoreAdapter,
	gcPidProbe,
	runGjcGcCommand,
} from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import { teamWorkersGcAdapter } from "@gajae-code/coding-agent/gjc-runtime/team-gc";
import { harnessLeasesGcAdapter } from "@gajae-code/coding-agent/harness-control-plane/gc-adapter";

const tempDirs: string[] = [];
const originalKill = process.kill.bind(process);

const EPERM_PID = 91_001;
const UNKNOWN_PID = 91_002;
const ALIVE_PID = 91_003;
const DEAD_PID = 91_004;

afterEach(async () => {
	process.kill = originalKill;
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTemp(prefix = "gc-redteam-"): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ctxFor(base: string, registryDir: string, probe: GcPidProbe): GcContext {
	return {
		probe,
		force: false,
		env: {
			...process.env,
			GJC_HARNESS_ROOT_REGISTRY_DIR: registryDir,
			GJC_RECEIPT_SPOOL_DIR: path.join(base, "spool"),
		},
		cwd: base,
	};
}

function adversarialProbe(pid: number) {
	if (pid === DEAD_PID) return { status: "dead" } as const;
	if (pid === EPERM_PID) return { status: "keep", reason: "eperm" } as const;
	if (pid === UNKNOWN_PID) return { status: "keep", reason: "unknown", error: "EINVAL" } as const;
	return { status: "keep", reason: "alive" } as const;
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

async function seedHarnessLease(base: string, registryDir: string, sessionId: string, pid: number): Promise<string> {
	const root = path.join(base, "harness-root");
	await writeJson(path.join(registryDir, `${sessionId}.json`), {
		sessionId,
		roots: [{ root, updatedAt: new Date().toISOString() }],
	});
	const leaseFile = path.join(root, "sessions", sessionId, "lease.json");
	await writeJson(leaseFile, lease(sessionId, pid));
	return leaseFile;
}

async function seedFileLock(base: string, id: string, pid: number): Promise<string> {
	const lockDir = path.join(base, "spool", `${id}.lock`);
	await writeJson(path.join(lockDir, "info"), { pid, timestamp: 1 });
	return lockDir;
}

async function seedTeamWorker(
	base: string,
	registryDir: string,
	workerId: string,
	pid: number,
	lifecycleState: "running" | "failed" | "stopped" = "running",
): Promise<string> {
	const harnessRoot = path.join(base, "state", "harness");
	const teamRoot = path.join(base, "state", "team");
	await writeJson(path.join(registryDir, `team-${workerId}.json`), {
		sessionId: `team-${workerId}`,
		roots: [{ root: harnessRoot, updatedAt: new Date().toISOString() }],
	});
	const workerDir = path.join(teamRoot, "red", "workers", workerId);
	await writeJson(path.join(workerDir, "heartbeat.json"), {
		pid,
		last_turn_at: new Date().toISOString(),
		turn_count: 0,
	});
	await writeJson(path.join(workerDir, "lifecycle.json"), {
		pid,
		lifecycle_state: lifecycleState,
		stop_reason: lifecycleState === "running" ? null : "adversarial terminal state",
	});
	return workerDir;
}

async function collectSingle(adapter: GcStoreAdapter, ctx: GcContext): Promise<GcRecord> {
	const result = await adapter.collect(ctx);
	expect(result.errors).toEqual([]);
	expect(result.records).toHaveLength(1);
	return result.records[0]!;
}

function fakeAdapter(
	store: GcStoreAdapter["store"],
	records: GcRecord[],
	prune: (record: GcRecord) => Promise<{ removed: boolean; error?: string; skipped?: string }>,
): GcStoreAdapter {
	return {
		store,
		async collect() {
			return { records: records.map(r => ({ ...r })), errors: [] };
		},
		prune,
	};
}

function record(store: GcStoreAdapter["store"], id: string): GcRecord {
	return {
		store,
		id,
		status: "dead",
		stale: true,
		removable: true,
		action: "none",
		reason: "adversarial_removable",
	};
}

async function reapedPid(): Promise<number> {
	const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
	return proc.pid;
}

function errnoError(code: string): NodeJS.ErrnoException {
	const err = new Error(code) as NodeJS.ErrnoException;
	err.code = code;
	return err;
}

function stubKill(impl: (pid: number, sig?: string | number) => void): void {
	process.kill = ((pid: number, sig?: string | number) => {
		impl(pid, sig);
		return true;
	}) as typeof process.kill;
}

describe("gc red-team invariants", () => {
	test("EPERM-probed records are never removable across real harness/file-lock/team adapters and prune never prunes them", async () => {
		const base = await makeTemp();
		const registryDir = path.join(base, "reg");
		const harnessLease = await seedHarnessLease(base, registryDir, "h-eperm", EPERM_PID);
		const lockDir = await seedFileLock(base, "eperm", EPERM_PID);
		const workerDir = await seedTeamWorker(base, registryDir, "w-eperm", EPERM_PID);
		const ctx = ctxFor(base, registryDir, adversarialProbe);

		const harnessRec = await collectSingle(harnessLeasesGcAdapter, ctx);
		const fileLockRec = await collectSingle(fileLocksGcAdapter, ctx);
		const teamRec = await collectSingle(teamWorkersGcAdapter, ctx);

		for (const rec of [harnessRec, fileLockRec, teamRec]) {
			expect(rec.pid_status).toBe("eperm");
			expect(rec.removable).toBe(false);
			expect(rec.action).toBe("none");
		}

		const report = await collectGcReport(
			[harnessLeasesGcAdapter, fileLocksGcAdapter, teamWorkersGcAdapter],
			ctx,
			true,
		);
		expect(report.counts.removed).toBe(0);
		expect(report.counts.failed).toBe(0);
		expect(report.counts.would_remove).toBe(0);
		expect(report.stores.harness_leases[0]?.action).toBe("none");
		expect(report.stores.file_locks[0]?.action).toBe("none");
		expect(report.stores.team_workers[0]?.action).toBe("none");
		expect(await fs.exists(harnessLease)).toBe(true);
		expect(await fs.exists(lockDir)).toBe(true);
		expect(await fs.exists(workerDir)).toBe(true);
	});

	test("unknown probe errors fail closed as kept, never removable, and prune mode does not remove", async () => {
		const base = await makeTemp();
		const registryDir = path.join(base, "reg");
		const leaseFile = await seedHarnessLease(base, registryDir, "h-unknown", UNKNOWN_PID);
		const lockDir = await seedFileLock(base, "unknown", UNKNOWN_PID);
		const workerDir = await seedTeamWorker(base, registryDir, "w-unknown", UNKNOWN_PID);
		const ctx = ctxFor(base, registryDir, adversarialProbe);

		const report = await collectGcReport(
			[harnessLeasesGcAdapter, fileLocksGcAdapter, teamWorkersGcAdapter],
			ctx,
			true,
		);
		const records = [report.stores.harness_leases[0]!, report.stores.file_locks[0]!, report.stores.team_workers[0]!];
		for (const rec of records) {
			expect(rec.removable).toBe(false);
			expect(rec.action).toBe("none");
			expect(["alive", "unknown"]).toContain(rec.pid_status ?? "none");
		}
		expect(report.counts.removed).toBe(0);
		expect(report.counts.failed).toBe(0);
		expect(await fs.exists(leaseFile)).toBe(true);
		expect(await fs.exists(lockDir)).toBe(true);
		expect(await fs.exists(workerDir)).toBe(true);
	});

	test("dry-run JSON with a real reaped dead lease deletes nothing on disk and exits zero", async () => {
		const base = await makeTemp();
		const registryDir = path.join(base, "reg");
		const leaseFile = await seedHarnessLease(base, registryDir, "h-dry-run", await reapedPid());
		const result = await runGjcGcCommand(["--json"], base, {
			...process.env,
			GJC_HARNESS_ROOT_REGISTRY_DIR: registryDir,
		});
		const report = JSON.parse(result.stdout);

		expect(result.status).toBe(0);
		expect(report.dry_run).toBe(true);
		expect(report.stores.harness_leases[0]?.action).toBe("would_remove");
		expect(await fs.exists(leaseFile)).toBe(true);
	});

	test("--prune partial failure keeps failure visible while successful removable records are removed", async () => {
		const adapter = fakeAdapter(
			"harness_leases",
			[record("harness_leases", "throws"), record("harness_leases", "ok")],
			async r => {
				if (r.id === "throws") throw new Error("adversarial prune explosion");
				return { removed: true };
			},
		);
		const report = await collectGcReport([adapter], ctxFor("/tmp", "/tmp/reg", adversarialProbe), true);
		const byId = Object.fromEntries(report.stores.harness_leases.map(r => [r.id, r]));

		expect(byId.throws?.action).toBe("remove_failed");
		expect(byId.throws?.removed).toBe(false);
		expect(byId.ok?.action).toBe("removed");
		expect(byId.ok?.removed).toBe(true);
		expect(report.counts.removed).toBe(1);
		expect(report.counts.failed).toBe(1);
		expect(computeExitCode(report)).toBe(1);
	});

	test("team workers in failed/stopped lifecycle remain non-removable when their pid is alive", async () => {
		const base = await makeTemp();
		const registryDir = path.join(base, "reg");
		await seedTeamWorker(base, registryDir, "w-failed-live", ALIVE_PID, "failed");
		await seedTeamWorker(base, registryDir, "w-stopped-live", ALIVE_PID, "stopped");
		const result = await teamWorkersGcAdapter.collect(ctxFor(base, registryDir, adversarialProbe));
		expect(result.errors).toEqual([]);
		const byId = Object.fromEntries(result.records.map(r => [r.id, r]));

		expect(byId["red/w-failed-live"]?.pid_status).toBe("alive");
		expect(byId["red/w-failed-live"]?.removable).toBe(false);
		expect(byId["red/w-failed-live"]?.status).toBe("alive");
		expect(byId["red/w-stopped-live"]?.pid_status).toBe("alive");
		expect(byId["red/w-stopped-live"]?.removable).toBe(false);
		expect(byId["red/w-stopped-live"]?.status).toBe("alive");
	});

	test("TOCTOU prune skip is reported as skipped, not removed or failed, and exits zero", async () => {
		const adapter = fakeAdapter("file_locks", [record("file_locks", "became-live")], async () => ({
			removed: false,
			skipped: "became_live_before_delete",
		}));
		const report = await collectGcReport([adapter], ctxFor("/tmp", "/tmp/reg", adversarialProbe), true);
		const rec = report.stores.file_locks[0]!;

		expect(rec.action).toBe("skipped");
		expect(rec.removed).toBe(false);
		expect(report.counts.removed).toBe(0);
		expect(report.counts.failed).toBe(0);
		expect(computeExitCode(report)).toBe(0);
	});

	test("unknown gc flag exits with parse status 2", async () => {
		const result = await runGjcGcCommand(["--bogus"], "/tmp", process.env, []);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown_flag:--bogus");
	});

	test("real gcPidProbe maps process.kill ESRCH/EPERM/EINVAL fail-closed and restores process.kill", () => {
		stubKill(() => {
			throw errnoError("ESRCH");
		});
		expect(gcPidProbe(12345)).toEqual({ status: "dead" });

		stubKill(() => {
			throw errnoError("EPERM");
		});
		expect(gcPidProbe(12345)).toEqual({ status: "keep", reason: "eperm" });

		stubKill(() => {
			throw errnoError("EINVAL");
		});
		expect(gcPidProbe(12345)).toEqual({ status: "keep", reason: "unknown", error: "EINVAL" });

		process.kill = originalKill;
		expect(process.kill).toBe(originalKill);
	});
});
