import { describe, expect, it } from "bun:test";
import { summarizeSanityRep } from "../bench/multisession/run";
import type { CohortSample, RepRecord, RunnerEvent } from "../bench/multisession/types";
import { buildWorkloadScript } from "../bench/multisession/workload";

function sample(tick: number, armTotal: number | null): CohortSample {
	return {
		t: tick * 1_000,
		tick,
		phase: "running",
		complete: armTotal !== null,
		incompleteReasons: armTotal === null ? ["unresolved-ownership"] : [],
		members: [],
		excluded: [],
		armTotal,
		armRssTotal: armTotal,
		driverFootprint: 1,
	};
}

function rep(runnerEvents: RunnerEvent[], samples: CohortSample[]): RepRecord {
	return {
		arm: "worker",
		n: 3,
		rep: 0,
		samples,
		gatedWindowTicks: [],
		teardownTick: null,
		runnerEvents,
		coldReadyMs: [],
		warmAdmissionMs: [],
		visibilityCheck: { passed: true },
		orphans: { owned: [], unresolved: [], complete: true, errors: [] },
	};
}

describe("multi-session sanity summary", () => {
	it("counts completed sessions, keeps only successful turn latencies, and peaks over complete samples", () => {
		const summary = summarizeSanityRep(
			rep(
				[
					{ type: "turn", sessionIndex: 0, turn: 1, startedAt: 100, endedAt: 450, ok: true },
					{ type: "turn", sessionIndex: 1, turn: 1, startedAt: 100, endedAt: 900, ok: false },
					{ type: "error", sessionIndex: 1, message: "provider rejected the request" },
					{ type: "done", sessionIndex: 0, evidenceDir: "/e/0" },
					{ type: "done", sessionIndex: 2, evidenceDir: "/e/2" },
				],
				[sample(0, 300), sample(1, null), sample(2, 700), sample(3, 500)],
			),
		);
		expect(summary).toEqual({
			arm: "worker",
			sessions: 3,
			completedSessions: 2,
			errors: ["provider rejected the request"],
			turnLatencyMs: [350],
			peakArmFootprint: 700,
			orphans: { owned: [], unresolved: [], complete: true, errors: [] },
		});
	});

	it("reports no peak when no sample was complete", () => {
		expect(summarizeSanityRep(rep([], [sample(0, null)])).peakArmFootprint).toBeNull();
	});

	it("keeps the sanity script to tool-free real-provider text turns", () => {
		const script = buildWorkloadScript("sanity");
		expect(script.map(turn => turn.key)).toEqual(["sanity-1", "sanity-2", "sanity-3"]);
		expect(script.every(turn => turn.action.kind === "text" && turn.prompt.includes("do not use any tools"))).toBe(
			true,
		);
	});
});
