import { describe, expect, it } from "bun:test";
import * as path from "node:path";

interface LatencyWorkerResult {
	recordCount: number;
	dictionaryArtifactEnabled: boolean;
	coldRangeReads: number;
	warmRangeReads: number;
	childrenRangeReads: number;
	branchRangeReads: number;
	coldMs: { p50: number; p95: number; p99: number };
	warmMs: { p50: number; p95: number };
	childrenMs: { p50: number; p95: number };
	branchSwitchMs: { p50: number; p95: number; p99: number };
	stats: { coldRetirementActive: boolean; totalAccountedBytes: number };
}

const enabled = process.env.GJC_SESSION_MEMORY_LATENCY === "1";

describe.skipIf(!enabled)("session memory latency / I-O (AC11)", () => {
	it("serves cold random, warm cached, parent-children, and 10k branch-switch operations within approved p95 budgets", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-latency-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: { ...process.env, GJC_SESSION_MEMORY_SECONDARY_ARTIFACT_MODE: "enabled" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as LatencyWorkerResult;

		// The retired dictionary artifact must be active for the bounded lookup path.
		expect(measured.dictionaryArtifactEnabled).toBe(true);
		expect(measured.stats.coldRetirementActive).toBe(true);
		expect(measured.stats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);

		// Per-turn cold I/O = 0 on the active path: warm (cached) lookups add zero
		// range reads — the load-independent invariant.
		expect(measured.warmRangeReads).toBe(0);
		// Each cold random lookup is exactly one bounded dictionary partition read
		// (1 block + ≤1 patch seek), never a full index scan.
		expect(measured.coldRangeReads).toBeLessThanOrEqual(50);
		expect(measured.childrenRangeReads).toBeGreaterThan(0);
		expect(measured.childrenRangeReads).toBeLessThanOrEqual(256);
		expect(measured.branchRangeReads).toBeGreaterThan(0);
		expect(measured.branchRangeReads).toBeLessThanOrEqual(30);

		// Approved AC11 local-NVMe p95 budgets (stage-02-revision:167):
		// cold random read ≤ 5 ms and a 10k-cold-entry branch switch ≤ 200 ms.
		// The gate is opt-in (GJC_SESSION_MEMORY_LATENCY=1) like the RSS suite so
		// unrelated shared-host load cannot make normal CI flaky.
		expect(measured.coldMs.p95).toBeLessThanOrEqual(5);
		expect(measured.branchSwitchMs.p95).toBeLessThanOrEqual(200);
		expect(measured.warmMs.p95).toBeLessThanOrEqual(5);
		expect(measured.childrenMs.p95).toBeLessThanOrEqual(1_000);
	}, 120_000);
});
