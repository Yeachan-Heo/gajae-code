import { beforeAll, describe, expect, test } from "bun:test";
import { STATUS_LINE_PRESETS } from "../src/modes/components/status-line/presets";
import { renderSegment, type SegmentContext } from "../src/modes/components/status-line/segments";
import { EMPTY_JOBS_SNAPSHOT, type JobsSnapshot } from "../src/modes/jobs-observer";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function makeCtx(jobs: JobsSnapshot): SegmentContext {
	return {
		session: { state: {} } as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		goalMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		jobs,
		sessionStartTime: Date.now(),
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("jobs status-line segment", () => {
	test("AC2 hidden when idle (no active jobs, no failure)", () => {
		const rendered = renderSegment("jobs", makeCtx(EMPTY_JOBS_SNAPSHOT));
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	test("AC1 shows monitor and cron counts when active", () => {
		const rendered = renderSegment(
			"jobs",
			makeCtx({
				...EMPTY_JOBS_SNAPSHOT,
				activeMonitorCount: 2,
				activeCronCount: 3,
				worstState: "running",
			}),
		);
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("2");
		expect(rendered.content).toContain("3");
	});

	test("AC2/AC3 stays visible (red) on unacknowledged failure even with zero active", () => {
		const rendered = renderSegment(
			"jobs",
			makeCtx({
				...EMPTY_JOBS_SNAPSHOT,
				worstState: "failed",
				failedUnacknowledged: true,
			}),
		);
		expect(rendered.visible).toBe(true);
		expect(rendered.content.length).toBeGreaterThan(0);
	});

	test("AC4 jobs segment is present in the right side of every preset", () => {
		for (const [name, preset] of Object.entries(STATUS_LINE_PRESETS)) {
			expect(preset.rightSegments, `preset ${name} should include jobs`).toContain("jobs");
		}
	});
});
