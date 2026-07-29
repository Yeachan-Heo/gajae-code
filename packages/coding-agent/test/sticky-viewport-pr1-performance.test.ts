import { describe, expect, it } from "bun:test";
import { runStickyViewportPr1Benchmark } from "../scripts/benchmark-sticky-viewport-pr1";

describe("sticky viewport PR1 structural benchmark", () => {
	it("keeps deterministic structural invariants while timing and memory remain advisory", async () => {
		const result = await runStickyViewportPr1Benchmark();
		expect(result.schemaVersion).toBe(1);
		expect(result.advisory.timingAndMemoryOnly).toBe(true);
		const stickySuffixWorkloads = result.workloads.filter(workload => workload.name.startsWith("sticky-suffix"));
		expect(stickySuffixWorkloads.map(workload => workload.name)).toEqual([
			"sticky-suffix-10000-rows-height-1",
			"sticky-suffix-10000-rows-height-3",
			"sticky-suffix-10000-rows-height-10",
			"sticky-suffix-100000-rows-height-1",
			"sticky-suffix-100000-rows-height-3",
			"sticky-suffix-100000-rows-height-10",
		]);
		for (const workload of stickySuffixWorkloads) {
			expect(workload.hard.largeFlatFrameSliceCalls).toBe(0);
			expect(workload.hard.pinnedSuffixOverflowFrames).toBe(1);
			expect(workload.hard.pinnedSuffixSelectedRows).toBeGreaterThan(0);
			expect(workload.hard.pinnedSuffixSelectedRows).toBeLessThanOrEqual(
				Number(workload.name.match(/height-(\d+)/)?.[1]),
			);
		}
		const output = result.workloads.find(workload => workload.name === "equal-output-source-1000");
		expect(output?.hard).toEqual({ equalNoops: 1_000, renderRequests: 0 });
		const sidebar = result.workloads.find(workload => workload.name === "irc-sidebar-near-cap-cache");
		expect(sidebar?.hard.ledgerEpochAdvances).toBe(10_000);
		expect(sidebar?.hard.unchangedProjectionMisses).toBe(1);
		expect(sidebar?.hard.unchangedProjectionHits).toBe(99);
		expect(sidebar?.hard.unchangedStyledMisses).toBe(1);
		expect(sidebar?.hard.unchangedStyledHits).toBe(99);
		expect(sidebar?.hard.mutationProjectionMisses).toBe(2);
		expect(sidebar?.hard.mutationStyledMisses).toBe(2);
		expect(Number(sidebar?.hard.mutationWrapCalls)).toBeGreaterThan(Number(sidebar?.hard.unchangedWrapCalls));
	});
});
