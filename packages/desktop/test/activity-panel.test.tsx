import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	DesktopActivityRef,
	DesktopActivitySessionState,
	DesktopActivitySnapshot,
} from "../../desktop-host/src/activity-protocol";
import { ActivityPanel, type ActivityPanelProps } from "../src/ActivityPanel";

const scope = { sessionGeneration: "session-fixture", connectionGeneration: "connection-fixture" };
const ref = (key: string): DesktopActivityRef => ({ ...scope, key });
const callbacks: Omit<ActivityPanelProps, "snapshot"> = {
	onRefresh: () => {},
	onOperate: () => {},
	onAcknowledge: () => {},
	onInspect: () => {},
	onOpenGate: () => {},
};

function snapshot(): DesktopActivitySnapshot & { available: true } {
	return {
		...scope,
		available: true,
		jobs: [],
		tasks: [],
		crons: [],
		truncated: { jobs: false, tasks: false, crons: false },
		activeMonitorCount: 0,
		activeCronCount: 0,
		worstState: "none",
		failedUnacknowledged: false,
	};
}

function sessionState(): DesktopActivitySessionState {
	return {
		goal: { enabled: true, status: "paused", tokensUsed: 123, timeUsedSeconds: 42 },
		workflow: { skill: "ralplan" },
		gates: {
			available: true,
			pending: [
				{ ref: ref("gate-question"), kind: "question", stage: "Design review", createdAt: "2026-10-28T18:00:00Z", answerable: true },
				{ ref: ref("gate-approval"), kind: "approval", stage: "ralplan", createdAt: "2026-10-28T18:01:00Z", answerable: false, reason: "Producer that does not support remote answers" },
			],
			truncated: false,
		},
	};
}

function render(value: DesktopActivitySnapshot | null, props: Partial<ActivityPanelProps> = {}): string {
	return renderToStaticMarkup(<ActivityPanel {...callbacks} snapshot={value} {...props} />);
}

function button(html: string, label: string): string {
	const found = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)].find(match => match[0].endsWith(`${label}</button>`));
	if (!found) throw new Error(`Missing rendered button: ${label}`);
	return found[0];
}

// Presentation-only tests. No callback here is evidence of a host or SDK mutation.
describe("desktop activity panel", () => {
	test("renders only declared controls, even when status alone would suggest a different action", () => {
		const value = snapshot();
		value.jobs = [
			{ type: "job", ref: ref("job-readonly"), id: "job-1", kind: "shell", label: "Running but read only", status: "running", controls: [], backgrounded: true, deliveryState: "pending", outputAvailable: false, reason: "No public control was declared" },
			{ type: "job", ref: ref("job-cancel"), id: "job-2", kind: "shell", label: "Cancelable job", status: "queued", controls: ["cancel"], backgrounded: false, deliveryState: "delivered", outputAvailable: true },
		];
		value.tasks = [{ type: "task", ref: ref("task-resume"), id: "task-1", status: "paused", controls: ["resume"], requestedModel: "requested/model", effectiveModel: "effective/model" }];
		value.crons = [{ type: "cron", ref: ref("cron-delete"), id: "cron-1", schedule: "0 * * * *", controls: ["delete"], recurring: true, firing: false }];
		const html = render(value);
		expect(button(html, "Cancel")).not.toContain('disabled=""');
		expect(button(html, "Resume")).not.toContain('disabled=""');
		expect(button(html, "Delete")).not.toContain('disabled=""');
		expect(html).not.toContain(">Stop</button>");
		expect(html).not.toContain(">Pause</button>");
		expect(html).toContain("No controls provided · Read only");
		expect(html).toContain("No public control was declared");
		expect(html).toContain("effective/model");
		expect(html).toContain("Output available");
		expect(html).toContain("No output provided");
		expect(html).not.toContain("Cancellation completed");
	});

	test("uses distinct stop and pause labels and disables every operation while pending", () => {
		const value = snapshot();
		value.jobs = [{ type: "job", ref: ref("stop-job"), id: "job", kind: "shell", label: "Stop control", status: "running", controls: ["stop"], backgrounded: false, deliveryState: "failed-visible", outputAvailable: false }];
		value.tasks = [{ type: "task", ref: ref("pause-task"), id: "task", status: "running", controls: ["pause", "cancel"], reason: "Controls declared by the SDK" }];
		value.failedUnacknowledged = true;
		value.sessionState = sessionState();
		const html = render(value, { pending: true });
		for (const label of ["Refresh", "View details", "Stop", "Pause", "Cancel", "Acknowledge failures", "View request"]) {
			expect(button(html, label)).toContain('disabled=""');
		}
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("delivery failure shown");
		expect(html).toContain("The information below is the last received.");
		expect(html).not.toContain("Answer sent");
	});

	test("separates disconnected, pending, error and unavailable from observed empty lists", () => {
		const disconnected = render(null);
		expect(disconnected).toContain("Activity information is not connected.");
		expect(disconnected).not.toContain("No entries to show.");
		const pending = render(null, { pending: true });
		expect(pending).toContain("Waiting for activity reads, operations or the connection…");
		expect(pending).not.toContain("No entries to show.");
		const failed = render(null, { error: "Connection failed" });
		expect(failed).toContain('role="alert"');
		expect(failed).toContain("Connection failed");
		expect(failed).not.toContain("No entries to show.");
		const unavailable = render({ ...scope, available: false, reason: "Observation unsupported" });
		expect(unavailable).toContain("Job observation is unavailable");
		expect(unavailable).toContain("Observation unsupported");
		expect(unavailable).not.toContain("0 running monitors");
		expect(unavailable).not.toContain("No entries to show.");
		const empty = render(snapshot());
		expect(empty.match(/No entries to show\./gu)).toHaveLength(3);
		expect(empty).not.toContain("Job observation is unavailable");
		const stale = render(snapshot(), { error: "Refresh failed" });
		expect(stale).toContain("The last read showed no entries.");
		expect(stale).not.toContain("No entries to show.");
		expect(stale).toContain("It does not mean the change succeeded.");
	});

	test("keeps canonical monitor and cron counts separate from overlapping visible rows", () => {
		const value = snapshot();
		value.activeMonitorCount = 7;
		value.activeCronCount = 3;
		value.worstState = "failed";
		value.failedUnacknowledged = true;
		value.jobs = [{ type: "job", ref: ref("job"), id: "same-work", label: "Observed failure", kind: "task", status: "failed", controls: [], backgrounded: true, deliveryState: "delivered", outputAvailable: false, error: "Actual error summary" }];
		value.tasks = [{ type: "task", ref: ref("task"), id: "same-work", status: "failed", controls: [] }];
		value.truncated.jobs = true;
		const html = render(value);
		expect(html).toContain("7 running monitors · 3 active schedules");
		expect(html).toContain("Observed state: Failed");
		expect(html.match(/1 shown/gu)).toHaveLength(2);
		expect(html).toContain("not added together.");
		expect(html).toContain("The counts above are not totals.");
		expect(html).toContain("Actual error summary");
		expect(button(html, "Acknowledge failures")).not.toContain('disabled=""');
		expect(render({ ...value, failedUnacknowledged: false })).not.toContain("Acknowledge failures");
	});

	test("shows goal, workflow and gates even when job observation is unavailable", () => {
		const html = render({ ...scope, available: false, reason: "No public job observation", sessionState: sessionState() });
		expect(html).toContain("Goal mode on · Paused · tokens used 123 · time used 42s");
		expect(html).toContain("ralplan");
		expect(html).toContain("2 shown");
		expect(html).toContain("Question ·");
		expect(html).toContain("Approval request ·");
		expect(html.match(/View request<\/button>/gu)).toHaveLength(2);
		expect(button(html, "View request")).not.toContain('disabled=""');
		expect(html).toContain("Remote answers are not supported.");
		expect(html).toContain("Open the details to review it, then answer.");
		expect(html).not.toContain("Approval request</button>");
		expect(html).not.toContain("gate-approval");
		expect(html).not.toContain("session-fixture");
		expect(html).not.toContain("Acknowledge failures");
	});

	test("does not confuse unavailable or absent gate summaries with no pending gates", () => {
		const value = snapshot();
		expect(render(value)).toContain("No input request information was provided.");
		value.sessionState = { goal: null, workflow: null, gates: { available: false, reason: "Gate emitter unavailable" } };
		const unavailable = render(value);
		expect(unavailable).toContain("Input request read unavailable");
		expect(unavailable).toContain("Gate emitter unavailable");
		expect(unavailable).not.toContain("No input requests are pending.");
		value.sessionState.gates = { available: true, pending: [], truncated: true };
		const empty = render(value);
		expect(empty).toContain("No input requests are pending.");
		expect(empty).toContain("Some input requests are omitted because the display limit was reached.");
		expect(render(value, { pending: true })).toContain("The last read showed no input requests.");
	});

	test("bounds long Korean/CJK and unbroken fields and escapes producer HTML as text", () => {
		const value = snapshot();
		const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
		value.jobs = [{ type: "job", ref: ref("long-job"), id: "x".repeat(5000), label: `긴 한국어 日本語 中文 ${"가".repeat(5000)}`, kind: hostile, status: "failed", controls: [], backgrounded: false, deliveryState: "failed-visible", outputAvailable: false, reason: `${hostile}${"r".repeat(5000)}`, error: hostile }];
		value.sessionState = sessionState();
		value.sessionState.workflow = { skill: "w".repeat(5000) };
		if (value.sessionState.gates.available) value.sessionState.gates.pending[0]!.reason = "artifact:///private/plan.html";
		const html = render(value, { error: `${hostile}${"e".repeat(5000)}` });
		expect(html).toContain("긴 한국어 日本語 中文");
		expect(html).toContain("content truncated");
		expect(html).not.toContain("가".repeat(241));
		expect(html).not.toContain("x".repeat(1025));
		expect(html).not.toContain("r".repeat(1025));
		expect(html).not.toContain("w".repeat(241));
		expect(html).not.toContain("e".repeat(1025));
		expect(html).toContain("&lt;img");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("href=");
		expect(html).toContain("artifact:///private/plan.html");
		expect(html).toContain("<details");
		expect(html).toContain("<summary");
		expect(html).toContain('class="activity-entry-main"');
	});
});
