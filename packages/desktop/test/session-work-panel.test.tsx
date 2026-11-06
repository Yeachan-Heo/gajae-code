import { describe, expect, test } from "bun:test";
import type { DesktopSession } from "@gajae-code/desktop-host/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivityPanelProps } from "../src/ActivityPanel";
import { SessionWorkPanel } from "../src/SessionWorkPanel";

const session: DesktopSession = {
	id: "fixture", projectId: "fixture", title: "Fixture", status: "done", starred: false,
	imageInput: null, operatorRunning: false, controlGeneration: null, messages: [],
	todos: [{ name: "Implementation", tasks: [{ content: "Compose session work", status: "in_progress" }] }],
	goal: { objective: "Ship session work", status: "active", tokensUsed: 12, timeUsedSeconds: 3 },
};
const activity: ActivityPanelProps = {
	snapshot: {
		sessionGeneration: "fixture", connectionGeneration: "fixture", available: true,
		jobs: [], tasks: [], crons: [], truncated: { jobs: false, tasks: false, crons: false },
		activeMonitorCount: 0, activeCronCount: 0, worstState: "none", failedUnacknowledged: false,
		sessionState: { goal: { enabled: true, status: "active", tokensUsed: 12, timeUsedSeconds: 3 }, workflow: { skill: "ralplan" }, gates: { available: true, pending: [], truncated: false } },
	},
	onRefresh: () => {}, onOperate: () => {}, onAcknowledge: () => {}, onInspect: () => {}, onOpenGate: () => {},
};

// Rendering evidence only; these callbacks do not exercise SDK mutations.
describe("SessionWorkPanel", () => {
	test("composes TODO, actionable goal, workflow and activity while retaining goal usage metrics", () => {
		const html = renderToStaticMarkup(<SessionWorkPanel session={session} activity={activity} onOperateGoal={() => {}} onClose={() => {}} />);
		for (const text of ["session-work-panel", "session-work-body", "Compose session work", "Ship session work", "Jobs", "Plan tasks", "Agent tasks", "Schedules", "ralplan", "Input requests"]) expect(html).toContain(text);
		expect(html).toContain('aria-label="Close session work"');
		expect(html).toContain('aria-label="Refresh"');
		expect(html).not.toContain("Jobs, schedules and input requests for this conversation");
		expect(html).toContain("Goal mode on");
		expect(html).toContain("tokens used 12 · time used 3s");
	});

	test("keeps empty tasks, missing goal and independent errors explicit", () => {
		const html = renderToStaticMarkup(<SessionWorkPanel session={{ ...session, todos: [], goal: undefined }} activity={{ ...activity, snapshot: null, error: "Activity failed" }} goalError="Goal failed" onOperateGoal={() => {}} onClose={() => {}} />);
		expect(html).toContain("No tasks yet.");
		expect(html).toContain("Goal failed");
		expect(html).toContain("Activity failed");
		expect(html).toContain("could not be read");
		expect(html.match(/role="alert"/gu)).toHaveLength(2);
	});

	for (const status of ["running", "waiting"] as const) {
		test(`disables goal operations while ${status}`, () => {
			const html = renderToStaticMarkup(<SessionWorkPanel session={{ ...session, status }} activity={activity} onOperateGoal={() => {}} onClose={() => {}} />);
			const actions = [...html.matchAll(/<button[^>]*class="[^"]*goal-action[^>]*>/gu)];
			expect(actions).toHaveLength(3);
			for (const action of actions) expect(action[0]).toContain('disabled=""');
		});
	}
});
