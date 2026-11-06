import { describe, expect, test } from "bun:test";
import type { DesktopSession } from "@gajae-code/desktop-host/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivityPanelProps } from "../src/ActivityPanel";
import { hasSessionWorkContent, SessionWorkPanel } from "../src/SessionWorkPanel";

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
		const html = renderToStaticMarkup(<SessionWorkPanel session={session} activity={activity} onOperateGoal={() => {}} />);
		for (const text of ["session-work-panel", "session-work-body", "Compose session work", "Ship session work", "Plan tasks", "ralplan"]) expect(html).toContain(text);
		expect(html).not.toContain('aria-label="Close session work"');
		expect(html).not.toContain('aria-label="Refresh"');
		for (const text of ["Jobs", "Agent tasks", "Schedules", "Input requests", "No goal", "No tasks"]) expect(html).not.toContain(text);
		expect(html).not.toContain("Jobs, schedules and input requests for this conversation");
		expect(html).not.toContain("Goal mode on");
		expect(html).toContain("tokens used 12");
		expect(html).toContain("time used 3s");
	});

	test("keeps empty tasks, missing goal and independent errors explicit", () => {
		const html = renderToStaticMarkup(<SessionWorkPanel session={{ ...session, todos: [], goal: undefined }} activity={{ ...activity, snapshot: null, error: "Activity failed" }} goalError="Goal failed" onOperateGoal={() => {}} />);
		expect(html).not.toContain("No tasks yet.");
		expect(html).not.toContain("Plan tasks");
		expect(html).not.toContain("No session work yet.");
		expect(html).toContain("Goal failed");
		expect(html).toContain("Activity failed");
		expect(html).toContain("could not be read");
		expect(html.match(/role="alert"/gu)).toHaveLength(2);
	});

	const emptySession: DesktopSession = { ...session, todos: [{ name: "Empty phase", tasks: [] }], goal: undefined };
	const emptySnapshot = {
		...activity.snapshot!, available: true as const, jobs: [], tasks: [], crons: [],
		truncated: { jobs: false, tasks: false, crons: false }, activeMonitorCount: 0, activeCronCount: 0,
		worstState: "none" as const, failedUnacknowledged: false,
		sessionState: { goal: null, workflow: null, gates: { available: true as const, pending: [], truncated: false } },
	};

	test("explicit empty card has one empty line and no absent groups or refresh", () => {
		expect(hasSessionWorkContent(emptySession, emptySnapshot)).toBe(false);
		expect(hasSessionWorkContent(emptySession, null)).toBe(false);
		const html = renderToStaticMarkup(<SessionWorkPanel session={emptySession} activity={{ ...activity, snapshot: emptySnapshot }} onOperateGoal={() => {}} />);
		expect(html).toContain("No session work yet.");
		for (const text of ["Plan tasks", "Goal", "Jobs", "Agent tasks", "Schedules", "Workflow", "Input requests", "Refresh", "0 active"]) expect(html).not.toContain(text);
	});

	test("unavailable observations stay explicit without automatically opening", () => {
		const snapshot = { sessionGeneration: "fixture", connectionGeneration: "fixture", available: false as const, reason: "Observation disconnected" };
		expect(hasSessionWorkContent(emptySession, snapshot)).toBe(false);
		const html = renderToStaticMarkup(<SessionWorkPanel session={emptySession} activity={{ ...activity, snapshot }} onOperateGoal={() => {}} />);
		expect(html).toContain("Observation disconnected");
		expect(html).not.toContain("No session work yet.");
		expect(html).not.toContain("Refresh");
	});

	test("each meaningful source independently opens the card", () => {
		expect(hasSessionWorkContent({ ...emptySession, todos: session.todos }, emptySnapshot)).toBe(true);
		expect(hasSessionWorkContent({ ...emptySession, goal: session.goal }, emptySnapshot)).toBe(true);
		for (const snapshot of [
			{ ...emptySnapshot, sessionState: { ...emptySnapshot.sessionState, goal: activity.snapshot?.sessionState?.goal ?? null } },
			{ ...emptySnapshot, sessionState: { ...emptySnapshot.sessionState, workflow: { skill: "ralplan" } } },
			{ ...emptySnapshot, failedUnacknowledged: true },
			{ ...emptySnapshot, activeMonitorCount: 1 },
			{ ...emptySnapshot, activeCronCount: 1 },
			...(["jobs", "tasks", "crons"] as const).map(key => ({ ...emptySnapshot, truncated: { ...emptySnapshot.truncated, [key]: true } })),
			{ ...emptySnapshot, sessionState: { ...emptySnapshot.sessionState, gates: { ...emptySnapshot.sessionState.gates, truncated: true } } },
			{ ...emptySnapshot, sessionState: { ...emptySnapshot.sessionState, gates: { available: true as const, truncated: false, pending: [{ ref: { sessionGeneration: "fixture", connectionGeneration: "fixture", key: "gate" }, kind: "question" as const, stage: "Answer", createdAt: "2026-01-01T00:00:00Z", answerable: true }] } } },
			{ ...emptySnapshot, jobs: [{ type: "job" as const, ref: { sessionGeneration: "fixture", connectionGeneration: "fixture", key: "job" }, id: "job", kind: "shell", label: "Check", status: "running" as const, controls: [], backgrounded: true, deliveryState: "pending" as const, outputAvailable: false }] },
			{ ...emptySnapshot, tasks: [{ type: "task" as const, ref: { sessionGeneration: "fixture", connectionGeneration: "fixture", key: "task" }, id: "task", status: "paused" as const, controls: [] }] },
			{ ...emptySnapshot, crons: [{ type: "cron" as const, ref: { sessionGeneration: "fixture", connectionGeneration: "fixture", key: "cron" }, id: "cron", schedule: "Every hour", recurring: true, firing: false, controls: [] }] },
		]) expect(hasSessionWorkContent(emptySession, snapshot)).toBe(true);
	});

	for (const status of ["running", "waiting"] as const) {
		test(`disables goal operations while ${status}`, () => {
			const html = renderToStaticMarkup(<SessionWorkPanel session={{ ...session, status }} activity={activity} onOperateGoal={() => {}} />);
			const actions = [...html.matchAll(/<button[^>]*class="[^"]*goal-action[^>]*>/gu)];
			expect(actions).toHaveLength(3);
			for (const action of actions) expect(action[0]).toContain('disabled=""');
		});
	}
});
