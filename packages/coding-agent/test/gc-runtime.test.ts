import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectGcReport,
	computeExitCode,
	type GcContext,
	type GcPidProbe,
	type GcRecord,
	type GcStoreAdapter,
	gcPidProbe,
	gcProbeToLeasePidStatus,
	runGjcGcCommand,
} from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { SessionIndex } from "../src/sdk/broker/session-index";

const originalAgentDir = getAgentDir();
let perTestAgentDir: string;

beforeEach(async () => {
	perTestAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-runtime-agent-"));
	setAgentDir(perTestAgentDir);
});

async function sessionIndexAgentDir(): Promise<string> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-session-index-"));
	setAgentDir(agentDir);
	return agentDir;
}

async function appendSessionIndexEvent(agentDir: string): Promise<void> {
	const index = await new SessionIndex(agentDir).open();
	await index.append({
		type: "host_registered",
		sessionId: "gc-session",
		locator: { repo: "/tmp/repo", stateRoot: "/tmp/state" },
		endpointGeneration: 1,
		pid: process.pid,
		endpointMtimeMs: Date.now(),
	});
}

const originalKill = process.kill.bind(process);

afterEach(async () => {
	process.kill = originalKill;
	setAgentDir(originalAgentDir);
	await fs.rm(perTestAgentDir, { recursive: true, force: true });
});

function stubKill(impl: (pid: number) => void): void {
	process.kill = ((pid: number, _sig?: string | number) => {
		impl(pid);
		return true;
	}) as typeof process.kill;
}

function errnoError(code: string): NodeJS.ErrnoException {
	const err = new Error(code) as NodeJS.ErrnoException;
	err.code = code;
	return err;
}

const keepProbe: GcPidProbe = () => ({ status: "keep", reason: "alive" });

function fakeAdapter(
	store: GcStoreAdapter["store"],
	records: GcRecord[],
	prune?: (record: GcRecord) => Promise<{ removed: boolean; error?: string; skipped?: string }>,
): GcStoreAdapter {
	return {
		store,
		async collect() {
			return { records: records.map(r => ({ ...r })), errors: [] };
		},
		async prune(record) {
			return prune ? prune(record) : { removed: true };
		},
	};
}

function ctx(probe: GcPidProbe = keepProbe): GcContext {
	return { probe, force: false, env: {}, cwd: "/tmp" };
}

function record(store: GcStoreAdapter["store"], over: Partial<GcRecord> = {}): GcRecord {
	return {
		store,
		id: over.id ?? "r1",
		status: over.status ?? "dead",
		stale: over.stale ?? true,
		removable: over.removable ?? true,
		action: "none",
		reason: over.reason ?? "test",
		...over,
	};
}

describe("gcPidProbe (liveness-only, fail-closed)", () => {
	test("alive process => keep/alive", () => {
		stubKill(() => {});
		expect(gcPidProbe(1234)).toEqual({ status: "keep", reason: "alive" });
	});

	test("ESRCH => dead (the only removable status)", () => {
		stubKill(() => {
			throw errnoError("ESRCH");
		});
		expect(gcPidProbe(1234)).toEqual({ status: "dead" });
	});

	test("EPERM => keep/eperm (owned by another user)", () => {
		stubKill(() => {
			throw errnoError("EPERM");
		});
		expect(gcPidProbe(1234)).toEqual({ status: "keep", reason: "eperm" });
	});

	test("unknown error => keep/unknown (never dead)", () => {
		stubKill(() => {
			throw errnoError("EINVAL");
		});
		const result = gcPidProbe(1234);
		expect(result.status).toBe("keep");
		expect(result.reason).toBe("unknown");
	});

	test("invalid pid => keep/unknown, never probes", () => {
		stubKill(() => {
			throw new Error("should not be called");
		});
		for (const pid of [0, -1, Number.NaN, 1.5]) {
			expect(gcPidProbe(pid).status).toBe("keep");
		}
	});
});

describe("gcProbeToLeasePidStatus", () => {
	test("maps dead/eperm/alive/unknown onto lease pid status", () => {
		expect(gcProbeToLeasePidStatus(() => ({ status: "dead" }))(1)).toBe("dead");
		expect(gcProbeToLeasePidStatus(() => ({ status: "keep", reason: "eperm" }))(1)).toBe("eperm");
		expect(gcProbeToLeasePidStatus(() => ({ status: "keep", reason: "alive" }))(1)).toBe("alive");
		// unknown maps to alive so classifyLeaseStatus never treats it as dead
		expect(gcProbeToLeasePidStatus(() => ({ status: "keep", reason: "unknown" }))(1)).toBe("alive");
	});
});

describe("computeExitCode", () => {
	test("dry-run with no errors => 0", () => {
		expect(computeExitCode({ dry_run: true, stores: {} as never, counts: { failed: 0 } as never, errors: [] })).toBe(
			0,
		);
	});

	test("hard discovery errors => 1 (both modes)", () => {
		const errors = [{ store: "file_locks" as const, scope: "discovery", message: "boom" }];
		expect(computeExitCode({ dry_run: true, stores: {} as never, counts: { failed: 0 } as never, errors })).toBe(1);
		expect(computeExitCode({ dry_run: false, stores: {} as never, counts: { failed: 0 } as never, errors })).toBe(1);
	});

	test("prune with a failed intended removal => 1; dry-run ignores failed count", () => {
		expect(computeExitCode({ dry_run: false, stores: {} as never, counts: { failed: 2 } as never, errors: [] })).toBe(
			1,
		);
		expect(computeExitCode({ dry_run: true, stores: {} as never, counts: { failed: 2 } as never, errors: [] })).toBe(
			0,
		);
	});
});

describe("collectGcReport", () => {
	test("dry-run marks removable records would_remove and never prunes", async () => {
		let pruned = false;
		const adapter = fakeAdapter("harness_leases", [record("harness_leases", { removable: true })], async () => {
			pruned = true;
			return { removed: true };
		});
		const report = await collectGcReport([adapter], ctx(), false);
		expect(report.dry_run).toBe(true);
		expect(report.stores.harness_leases[0]?.action).toBe("would_remove");
		expect(report.counts.would_remove).toBe(1);
		expect(pruned).toBe(false);
	});

	test("non-removable records are kept (action none) and never pruned", async () => {
		const adapter = fakeAdapter("team_workers", [
			record("team_workers", { removable: false, status: "alive", stale: false }),
		]);
		const report = await collectGcReport([adapter], ctx(), true);
		expect(report.stores.team_workers[0]?.action).toBe("none");
		expect(report.counts.removed).toBe(0);
	});

	test("prune: removed / skipped / failed map to actions and counts", async () => {
		const adapter = fakeAdapter(
			"file_locks",
			[
				record("file_locks", { id: "ok", removable: true }),
				record("file_locks", { id: "skip", removable: true }),
				record("file_locks", { id: "fail", removable: true }),
			],
			async r => {
				if (r.id === "ok") return { removed: true };
				if (r.id === "skip") return { removed: false, skipped: "became_live" };
				return { removed: false, error: "EACCES" };
			},
		);
		const report = await collectGcReport([adapter], ctx(), true);
		const byId = Object.fromEntries(report.stores.file_locks.map(r => [r.id, r]));
		expect(byId.ok?.action).toBe("removed");
		expect(byId.skip?.action).toBe("skipped");
		expect(byId.fail?.action).toBe("remove_failed");
		expect(report.counts.removed).toBe(1);
		expect(report.counts.failed).toBe(1);
		expect(computeExitCode(report)).toBe(1);
	});

	test("adapter.collect throwing becomes a hard error (scope=collect)", async () => {
		const broken: GcStoreAdapter = {
			store: "tmux_sessions",
			async collect() {
				throw new Error("kaboom");
			},
			async prune() {
				return { removed: false };
			},
		};
		const report = await collectGcReport([broken], ctx(), false);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]?.scope).toBe("collect");
		expect(computeExitCode(report)).toBe(1);
	});
});

describe("runGjcGcCommand", () => {
	const adapters = [fakeAdapter("harness_leases", [])];

	test("unknown flag => status 2 with stderr", async () => {
		const result = await runGjcGcCommand(["--nope"], "/tmp", {}, adapters);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown_flag");
	});
	test("rejects repair combined with prune or dry-run", async () => {
		for (const args of [
			["--repair-session-index", "--prune"],
			["--repair-session-index", "--dry-run"],
		]) {
			const result = await runGjcGcCommand(args, "/tmp", {}, adapters);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("repair_session_index_cannot_combine");
		}
	});

	test("--json emits a report with all five store arrays", async () => {
		const result = await runGjcGcCommand(["--json"], "/tmp", {}, adapters);
		expect(result.status).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.dry_run).toBe(true);
		expect(parsed.operation).toBe("dry_run");
		expect(Object.keys(parsed.stores).sort()).toEqual([
			"file_locks",
			"harness_leases",
			"registry_entries",
			"team_workers",
			"tmux_sessions",
		]);
	});

	test("default text mode reports dry run", async () => {
		const result = await runGjcGcCommand([], "/tmp", {}, adapters);
		expect(result.stdout).toContain("dry run");
	});

	test("--dry-run overrides --prune", async () => {
		let pruned = false;
		const a = fakeAdapter("harness_leases", [record("harness_leases", { removable: true })], async () => {
			pruned = true;
			return { removed: true };
		});
		const result = await runGjcGcCommand(["--prune", "--dry-run", "--json"], "/tmp", {}, [a]);
		expect(pruned).toBe(false);
		expect(JSON.parse(result.stdout).dry_run).toBe(true);
	});

	test("--prune actually prunes removable records", async () => {
		let pruned = 0;
		const a = fakeAdapter("harness_leases", [record("harness_leases", { removable: true })], async () => {
			pruned++;
			return { removed: true };
		});
		const result = await runGjcGcCommand(["--prune", "--json"], "/tmp", {}, [a]);
		expect(pruned).toBe(1);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.dry_run).toBe(false);
		expect(parsed.counts.removed).toBe(1);
		expect(result.status).toBe(0);
	});

	test("includes healthy session-index diagnosis in ordinary JSON output", async () => {
		const agentDir = await sessionIndexAgentDir();
		await appendSessionIndexEvent(agentDir);
		const result = await runGjcGcCommand(["--json"], "/tmp", {}, adapters);
		const report = JSON.parse(result.stdout);
		expect(report.session_index).toMatchObject({ status: "healthy", valid_prefix_seq: 1 });
		expect(result.status).toBe(0);
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	test("reports corrupt session-index diagnostics without repairing", async () => {
		const agentDir = await sessionIndexAgentDir();
		await appendSessionIndexEvent(agentDir);
		const log = path.join(agentDir, "sdk", "sessions", "index.jsonl");
		await fs.appendFile(log, "broken\n");
		const before = await fs.readFile(log, "utf8");
		const result = await runGjcGcCommand(["--json"], "/tmp", {}, adapters);
		const report = JSON.parse(result.stdout);
		expect(report.session_index).toMatchObject({ status: "corrupt", valid_prefix_seq: 1 });
		expect(await fs.readFile(log, "utf8")).toBe(before);
		expect(result.status).toBe(1);
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	test("fails closed for unsupported session-index versions", async () => {
		const agentDir = await sessionIndexAgentDir();
		const log = path.join(agentDir, "sdk", "sessions", "index.jsonl");
		await fs.mkdir(path.dirname(log), { recursive: true });
		await fs.writeFile(log, `${JSON.stringify({ version: 99 })}\n`);
		const result = await runGjcGcCommand(["--json"], "/tmp", {}, adapters);
		const report = JSON.parse(result.stdout);
		expect(report.session_index.status).toBe("unsupported");
		expect(report.session_index.reason).toContain("Unsupported SDK state version");
		expect(result.status).toBe(1);
		await fs.rm(agentDir, { recursive: true, force: true });
	});
});
