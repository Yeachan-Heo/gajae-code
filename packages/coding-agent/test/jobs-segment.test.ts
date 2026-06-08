import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/status-line";
import { STATUS_LINE_PRESETS } from "../src/modes/components/status-line/presets";
import { renderSegment, type SegmentContext } from "../src/modes/components/status-line/segments";
import { EMPTY_JOBS_SNAPSHOT, type JobsSnapshot } from "../src/modes/jobs-observer";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});
afterAll(() => {
	resetSettingsForTest();
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

function makeStatusLineSession(running: Array<{ id: string; type: "bash" | "task"; metadata?: { monitor?: true } }>) {
	return {
		state: { messages: [] },
		isStreaming: false,
		getAsyncJobSnapshot: () => ({
			running: running.map(job => ({
				...job,
				status: "running" as const,
				label: job.id,
				startTime: Date.now(),
			})),
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		}),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		sessionManager: {
			getSessionName: () => "test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
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

	test("status line does not append legacy job count for a monitor already shown in jobs segment", () => {
		const component = new StatusLineComponent(
			makeStatusLineSession([{ id: "monitor-1", type: "bash", metadata: { monitor: true } }]),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["jobs"],
			showSkillHud: false,
		});
		component.setJobs({
			...EMPTY_JOBS_SNAPSHOT,
			activeMonitorCount: 1,
			worstState: "running",
		});

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("1");
		expect(rendered).not.toContain("job running");
	});

	test("status line keeps legacy job count for non-monitor background jobs", () => {
		const component = new StatusLineComponent(makeStatusLineSession([{ id: "task-1", type: "task" }]));
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["jobs"],
			showSkillHud: false,
		});

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("job running");
	});
});
