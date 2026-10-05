/**
 * Read-only project progress projection. One report feeds both the
 * human-facing `/progress` view and the machine-facing `session.progress`
 * SDK snapshot (see `progress-snapshot.ts`).
 *
 * The completion indicator is derived exclusively from countable units that
 * carry a durable completion status. It never weights units by size, never
 * credits partial work on an open unit, and never infers progress from
 * conversation text, elapsed time, or token spend. When no countable basis
 * exists the indicator is reported as unknown instead of guessed.
 */
import type { SubagentLifecycle } from "../async/job-manager";
import type { UltragoalGoalStatus } from "../gjc-runtime/ultragoal-runtime";
import type { GoalStatus } from "../goals/state";
import type { WorkflowHudSeverity } from "../skill-state/active-state";
import type { TodoStatus } from "../tools/todo-write";

export interface ProgressGoalInput {
	objective: string;
	status: GoalStatus;
	timeUsedSeconds: number;
}

export interface ProgressTodoInput {
	content: string;
	status: TodoStatus;
}

export interface ProgressWorkflowChip {
	label: string;
	value?: string;
	severity?: WorkflowHudSeverity;
}

export interface ProgressWorkflowInput {
	skill: string;
	phase: string;
	summary?: string;
	chips: ProgressWorkflowChip[];
}

export interface ProgressStoryInput {
	id: string;
	title: string;
	status: UltragoalGoalStatus;
	/** A completion-verification (quality-gate) receipt is recorded on the story. */
	hasVerificationReceipt: boolean;
}

export interface ProgressUltragoalInput {
	objective: string;
	stories: ProgressStoryInput[];
}

/** Durable `.gjc` session-state sources that can fail to read. */
export type ProgressDurableSource = "workflow-state" | "ultragoal-plan";

export const PROGRESS_SOURCE_LABELS: Record<ProgressDurableSource, string> = {
	"workflow-state": "Workflow state",
	"ultragoal-plan": "Ultragoal plan",
};

export interface ProjectProgressInput {
	goal?: ProgressGoalInput;
	todos: ProgressTodoInput[];
	workflows: ProgressWorkflowInput[];
	ultragoal?: ProgressUltragoalInput;
	subagents: SubagentLifecycle[];
	/** Whether session-scoped `.gjc` state (workflows, ultragoal plan) was consulted at all. */
	sessionStateRead: boolean;
	/** Durable sources that exist but could not be read; excluded from the estimate. */
	unreadable: ProgressDurableSource[];
}

export type ProgressBasisKind = "ultragoal-stories" | "todos" | "goal-status" | "none";

export type ProgressHeadline =
	| "complete"
	| "awaiting-completion"
	| "blocked"
	| "in-progress"
	| "not-started"
	| "paused"
	| "dropped"
	| "no-tracked-work";

export type ProgressSignalSource = "ultragoal" | "workflow" | "subagents" | "todos" | "goal" | "state";

export interface ProgressSignal {
	kind: "blocker" | "pending" | "note";
	/** Which durable state produced the signal. */
	source: ProgressSignalSource;
	/** Stable identifier inside the source: story id, workflow skill, or durable source key. */
	ref?: string;
	text: string;
}

export interface ProgressCompletion {
	basis: ProgressBasisKind;
	done: number;
	total: number;
	/**
	 * Displayed whole percent, or undefined when no countable basis exists.
	 * Never rounds up to 100 while a unit is open, nor down to 0 once a unit is done.
	 */
	percent: number | undefined;
}

export interface ProgressStoryCounts {
	total: number;
	complete: number;
	active: number;
	pending: number;
	blocked: number;
	superseded: number;
	verified: number;
	current?: { id: string; title: string };
}

export interface ProgressTodoCounts {
	total: number;
	completed: number;
	inProgress: number;
	pending: number;
	abandoned: number;
	current?: string;
}

export interface ProgressAgentCounts {
	total: number;
	running: number;
	waiting: number;
	completed: number;
	failed: number;
	cancelled: number;
}

export interface ProgressReviewVerdict {
	skill: string;
	verdict: string;
}

/** Verification evidence that durable state actually records; nothing is inferred. */
export interface ProgressVerification {
	/** Complete stories that carry a quality-gate completion receipt (only when stories are complete). */
	storyReceipts?: { complete: number; withReceipt: number };
	/** Latest review verdict chips published by active workflows. */
	reviewVerdicts: ProgressReviewVerdict[];
}

export interface ProjectProgressReport {
	headline: ProgressHeadline;
	completion: ProgressCompletion;
	/** How the completion indicator was derived, in plain words. */
	basisExplanation: string;
	goal?: ProgressGoalInput;
	/** The ultragoal plan the story counts were derived from. */
	ultragoal?: ProgressUltragoalInput;
	stories?: ProgressStoryCounts;
	todoItems: ProgressTodoInput[];
	todos?: ProgressTodoCounts;
	workflows: ProgressWorkflowInput[];
	agents: ProgressAgentCounts;
	verification: ProgressVerification;
	signals: ProgressSignal[];
	sessionStateRead: boolean;
	unreadable: ProgressDurableSource[];
}

const BLOCKING_STORY_STATUSES: ReadonlySet<UltragoalGoalStatus> = new Set(["failed", "blocked", "review_blocked"]);

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function countStories(ultragoal: ProgressUltragoalInput): ProgressStoryCounts {
	const counts: ProgressStoryCounts = {
		total: 0,
		complete: 0,
		active: 0,
		pending: 0,
		blocked: 0,
		superseded: 0,
		verified: 0,
	};
	for (const story of ultragoal.stories) {
		if (story.status === "superseded") {
			counts.superseded++;
			continue;
		}
		counts.total++;
		if (story.status === "complete") {
			counts.complete++;
			if (story.hasVerificationReceipt) counts.verified++;
		} else if (story.status === "active") counts.active++;
		else if (story.status === "pending") counts.pending++;
		else if (BLOCKING_STORY_STATUSES.has(story.status)) counts.blocked++;
	}
	const current =
		ultragoal.stories.find(story => story.status === "active") ??
		ultragoal.stories.find(story => story.status !== "complete" && story.status !== "superseded");
	if (current) counts.current = { id: current.id, title: current.title };
	return counts;
}

function countTodos(todos: readonly ProgressTodoInput[]): ProgressTodoCounts {
	const counts: ProgressTodoCounts = { total: 0, completed: 0, inProgress: 0, pending: 0, abandoned: 0 };
	for (const todo of todos) {
		if (todo.status === "abandoned") {
			counts.abandoned++;
			continue;
		}
		counts.total++;
		if (todo.status === "completed") counts.completed++;
		else if (todo.status === "in_progress") counts.inProgress++;
		else counts.pending++;
	}
	const current = todos.find(todo => todo.status === "in_progress") ?? todos.find(todo => todo.status === "pending");
	if (current) counts.current = current.content;
	return counts;
}

function countAgents(statuses: readonly SubagentLifecycle[]): ProgressAgentCounts {
	const counts: ProgressAgentCounts = {
		total: statuses.length,
		running: 0,
		waiting: 0,
		completed: 0,
		failed: 0,
		cancelled: 0,
	};
	for (const status of statuses) {
		if (status === "running") counts.running++;
		else if (status === "queued" || status === "paused") counts.waiting++;
		else if (status === "completed") counts.completed++;
		else if (status === "failed") counts.failed++;
		else counts.cancelled++;
	}
	return counts;
}

/** Whole percent that never overstates (no 100 while open) nor erases (no 0 once started) progress. */
export function displayPercent(done: number, total: number): number | undefined {
	if (total <= 0) return undefined;
	if (done >= total) return 100;
	if (done <= 0) return 0;
	return Math.min(99, Math.max(1, Math.round((done / total) * 100)));
}

function selectCompletion(
	stories: ProgressStoryCounts | undefined,
	todos: ProgressTodoCounts | undefined,
	goal: ProgressGoalInput | undefined,
): { completion: ProgressCompletion; explanation: string } {
	if (stories && stories.total > 0) {
		return {
			completion: {
				basis: "ultragoal-stories",
				done: stories.complete,
				total: stories.total,
				percent: displayPercent(stories.complete, stories.total),
			},
			explanation:
				"Ultragoal stories marked complete in the durable plan (goals.json). Every story counts equally regardless of size; superseded stories are excluded; open stories earn no partial credit.",
		};
	}
	if (todos && todos.total > 0) {
		return {
			completion: {
				basis: "todos",
				done: todos.completed,
				total: todos.total,
				percent: displayPercent(todos.completed, todos.total),
			},
			explanation:
				"Session todo items marked completed. Every item counts equally regardless of size; abandoned items are excluded; in-progress items earn no partial credit.",
		};
	}
	if (goal?.status === "complete") {
		return {
			completion: { basis: "goal-status", done: 1, total: 1, percent: 100 },
			explanation: "The session goal is marked complete; no finer-grained plan or todo list was recorded.",
		};
	}
	return {
		completion: { basis: "none", done: 0, total: 0, percent: undefined },
		explanation:
			"No ultragoal plan or todo list is recorded, so there is nothing countable to measure. Create a plan (/skill:ultragoal) or a todo list to get a completion estimate.",
	};
}

function workflowSignals(workflows: readonly ProgressWorkflowInput[]): ProgressSignal[] {
	const signals: ProgressSignal[] = [];
	for (const workflow of workflows) {
		for (const chip of workflow.chips) {
			const text = `${workflow.skill}: ${chip.label}${chip.value ? ` ${chip.value}` : ""}`;
			const base = { source: "workflow" as const, ref: workflow.skill, text };
			if (chip.severity === "blocked" || chip.severity === "error") signals.push({ kind: "blocker", ...base });
			else if (chip.severity === "warning") signals.push({ kind: "pending", ...base });
		}
	}
	return signals;
}

function collectVerification(
	stories: ProgressStoryCounts | undefined,
	workflows: readonly ProgressWorkflowInput[],
): ProgressVerification {
	const reviewVerdicts: ProgressReviewVerdict[] = [];
	for (const workflow of workflows) {
		const verdict = workflow.chips.find(chip => chip.label === "verdict" && chip.value);
		if (verdict?.value) reviewVerdicts.push({ skill: workflow.skill, verdict: verdict.value });
	}
	return {
		...(stories && stories.complete > 0
			? { storyReceipts: { complete: stories.complete, withReceipt: stories.verified } }
			: {}),
		reviewVerdicts,
	};
}

/** Human-readable verification lines; the structured form is `ProgressVerification`. */
export function verificationLines(verification: ProgressVerification): string[] {
	const lines: string[] = [];
	const receipts = verification.storyReceipts;
	if (receipts) {
		lines.push(
			`${receipts.withReceipt} of ${plural(receipts.complete, "complete story", "complete stories")} carry a recorded quality-gate receipt`,
		);
	}
	for (const { skill, verdict } of verification.reviewVerdicts) lines.push(`${skill} review verdict: ${verdict}`);
	return lines;
}

export function computeProjectProgress(input: ProjectProgressInput): ProjectProgressReport {
	const stories = input.ultragoal ? countStories(input.ultragoal) : undefined;
	const todos = input.todos.length > 0 ? countTodos(input.todos) : undefined;
	const agents = countAgents(input.subagents);
	const { completion, explanation } = selectCompletion(stories, todos, input.goal);

	const signals: ProgressSignal[] = [];
	if (input.ultragoal) {
		for (const story of input.ultragoal.stories) {
			if (BLOCKING_STORY_STATUSES.has(story.status)) {
				signals.push({
					kind: "blocker",
					source: "ultragoal",
					ref: story.id,
					text: `Story ${story.id} is ${story.status.replace("_", " ")}: ${story.title}`,
				});
			}
		}
	}
	// The ultragoal HUD chips summarize the same goals.json stories reported above;
	// repeating them would list every blocked story twice.
	signals.push(
		...workflowSignals(
			input.ultragoal ? input.workflows.filter(workflow => workflow.skill !== "ultragoal") : input.workflows,
		),
	);
	if (agents.running + agents.waiting > 0) {
		signals.push({
			kind: "pending",
			source: "subagents",
			text: `${plural(agents.running + agents.waiting, "subagent")} still running or queued; their work counts only once it is recorded in the plan or todos.`,
		});
	}
	if (agents.failed > 0)
		signals.push({
			kind: "note",
			source: "subagents",
			text: `${plural(agents.failed, "subagent")} failed this session.`,
		});
	if (completion.basis === "ultragoal-stories" && todos && todos.inProgress + todos.pending > 0) {
		signals.push({
			kind: "note",
			source: "todos",
			text: `Open todos (${todos.inProgress + todos.pending}) are tracked separately; the estimate follows the ultragoal plan.`,
		});
	}
	for (const source of input.unreadable) {
		signals.push({
			kind: "note",
			source: "state",
			ref: source,
			text: `${PROGRESS_SOURCE_LABELS[source]} could not be read and is excluded from the estimate.`,
		});
	}

	const headline = selectHeadline(input, completion, stories, todos, agents, signals);
	if (headline === "awaiting-completion" && input.goal && input.goal.status !== "complete") {
		signals.push({
			kind: "pending",
			source: "goal",
			text: "All tracked units are done, but the session goal is not marked complete yet.",
		});
	}

	return {
		headline,
		completion,
		basisExplanation: explanation,
		...(input.goal ? { goal: input.goal } : {}),
		...(input.ultragoal ? { ultragoal: input.ultragoal } : {}),
		...(stories ? { stories } : {}),
		todoItems: input.todos,
		...(todos ? { todos } : {}),
		workflows: input.workflows,
		agents,
		verification: collectVerification(stories, input.workflows),
		signals,
		sessionStateRead: input.sessionStateRead,
		unreadable: input.unreadable,
	};
}

function selectHeadline(
	input: ProjectProgressInput,
	completion: ProgressCompletion,
	stories: ProgressStoryCounts | undefined,
	todos: ProgressTodoCounts | undefined,
	agents: ProgressAgentCounts,
	signals: readonly ProgressSignal[],
): ProgressHeadline {
	const goalStatus = input.goal?.status;
	if (goalStatus === "dropped") return "dropped";
	if (signals.some(signal => signal.kind === "blocker")) return "blocked";
	const allDone = completion.total > 0 && completion.done >= completion.total;
	if (allDone) {
		const goalOpen = goalStatus !== undefined && goalStatus !== "complete";
		return goalOpen || agents.running + agents.waiting > 0 ? "awaiting-completion" : "complete";
	}
	if (goalStatus === "paused") return "paused";
	const somethingMoving =
		completion.done > 0 ||
		(stories?.active ?? 0) > 0 ||
		(todos?.inProgress ?? 0) > 0 ||
		agents.running > 0 ||
		goalStatus === "active";
	if (somethingMoving) return "in-progress";
	if (completion.total > 0) return "not-started";
	return input.workflows.length > 0 ? "in-progress" : "no-tracked-work";
}

export const PROGRESS_HEADLINE_LABELS: Record<ProgressHeadline, string> = {
	complete: "Complete",
	"awaiting-completion": "Tracked work done, awaiting completion",
	blocked: "Blocked",
	"in-progress": "In progress",
	"not-started": "Not started",
	paused: "Paused",
	dropped: "Dropped",
	"no-tracked-work": "No tracked work",
};

const BASIS_UNIT_LABELS: Record<Exclude<ProgressBasisKind, "none">, string> = {
	"ultragoal-stories": "ultragoal stories complete",
	todos: "todo items completed",
	"goal-status": "session goal complete",
};

/** Styling hooks so the TUI can colour output while ACP/text mode stays plain. */
export interface ProgressRenderStyle {
	bold(text: string): string;
	fg(color: "accent" | "success" | "warning" | "error" | "dim" | "muted", text: string): string;
}

export interface ProgressRenderOptions {
	style?: ProgressRenderStyle;
	/** Sanitizes and bounds untrusted durable text to one display line of at most `max` columns. */
	clip: (text: string, max: number) => string;
	barWidth?: number;
}

const PLAIN_STYLE: ProgressRenderStyle = { bold: text => text, fg: (_color, text) => text };

function headlineColor(headline: ProgressHeadline): "success" | "warning" | "error" | "accent" | "muted" {
	switch (headline) {
		case "complete":
			return "success";
		case "blocked":
			return "error";
		case "awaiting-completion":
		case "paused":
			return "warning";
		case "dropped":
		case "no-tracked-work":
			return "muted";
		default:
			return "accent";
	}
}

function formatElapsed(seconds: number): string {
	const minutes = Math.floor(Math.max(0, seconds) / 60);
	if (minutes < 1) return "<1m";
	const hours = Math.floor(minutes / 60);
	return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** Render the overview as display lines (no trailing newline). */
export function renderProjectProgress(report: ProjectProgressReport, options: ProgressRenderOptions): string[] {
	const style = options.style ?? PLAIN_STYLE;
	const clip = options.clip;
	const width = options.barWidth ?? 24;
	const label = (text: string) => style.fg("dim", text.padEnd(14));
	const lines: string[] = [];
	const color = headlineColor(report.headline);

	lines.push(`${style.bold("Project progress")}  ${style.fg(color, PROGRESS_HEADLINE_LABELS[report.headline])}`);
	const { completion } = report;
	if (completion.percent === undefined) {
		lines.push(`${style.fg("dim", `[${"·".repeat(width)}]`)} unknown`);
	} else {
		const filled = Math.round((completion.percent / 100) * width);
		const bar = `${style.fg(color, "█".repeat(filled))}${style.fg("dim", "░".repeat(width - filled))}`;
		const unit = BASIS_UNIT_LABELS[completion.basis as Exclude<ProgressBasisKind, "none">];
		lines.push(
			`[${bar}] ~${completion.percent}%  ${style.fg("muted", `${completion.done} of ${completion.total} ${unit}`)}`,
		);
	}
	lines.push(style.fg("dim", `Basis: ${report.basisExplanation}`));
	lines.push("");

	if (report.goal) {
		lines.push(
			`${label("Goal")}${report.goal.status} · ${formatElapsed(report.goal.timeUsedSeconds)} · ${clip(report.goal.objective, 100)}`,
		);
	}
	if (report.stories) {
		const s = report.stories;
		const parts = [`${s.complete}/${s.total} complete`];
		if (s.active > 0) parts.push(`${s.active} active`);
		if (s.pending > 0) parts.push(`${s.pending} pending`);
		if (s.blocked > 0) parts.push(style.fg("error", `${s.blocked} blocked`));
		if (s.superseded > 0) parts.push(`${s.superseded} superseded`);
		lines.push(`${label("Ultragoal")}${parts.join(" · ")}`);
		if (s.current) lines.push(`${label("")}next: ${s.current.id} ${clip(s.current.title, 90)}`);
	}
	if (report.todos) {
		const t = report.todos;
		const parts = [`${t.completed}/${t.total} completed`];
		if (t.inProgress > 0) parts.push(`${t.inProgress} in progress`);
		if (t.pending > 0) parts.push(`${t.pending} pending`);
		if (t.abandoned > 0) parts.push(`${t.abandoned} abandoned`);
		lines.push(`${label("Todos")}${parts.join(" · ")}`);
		if (t.current) lines.push(`${label("")}now: ${clip(t.current, 90)}`);
	}
	if (report.workflows.length === 0) {
		lines.push(`${label("Workflows")}${style.fg("dim", "none active")}`);
	} else {
		report.workflows.forEach((workflow, index) => {
			const chips = workflow.chips
				.filter(chip => chip.value)
				.slice(0, 4)
				.map(chip => `${chip.label} ${clip(chip.value ?? "", 40)}`);
			const detail = [workflow.phase, ...chips].join(" · ");
			lines.push(`${label(index === 0 ? "Workflows" : "")}${clip(workflow.skill, 24)}: ${clip(detail, 110)}`);
			if (workflow.summary) lines.push(`${label("")}${style.fg("muted", clip(workflow.summary, 100))}`);
		});
	}
	const a = report.agents;
	if (a.total === 0) {
		lines.push(`${label("Agents")}${style.fg("dim", "no subagents this session")}`);
	} else {
		const parts: string[] = [];
		if (a.running > 0) parts.push(`${a.running} running`);
		if (a.waiting > 0) parts.push(`${a.waiting} queued/paused`);
		if (a.completed > 0) parts.push(`${a.completed} completed`);
		if (a.failed > 0) parts.push(style.fg("error", `${a.failed} failed`));
		if (a.cancelled > 0) parts.push(`${a.cancelled} cancelled`);
		lines.push(`${label("Agents")}${parts.join(" · ")}`);
	}
	const verification = verificationLines(report.verification);
	if (verification.length === 0) {
		lines.push(`${label("Verification")}${style.fg("dim", "no durable verification evidence recorded")}`);
	} else {
		verification.forEach((line, index) => {
			lines.push(`${label(index === 0 ? "Verification" : "")}${clip(line, 110)}`);
		});
	}

	if (report.signals.length > 0) {
		lines.push("", style.bold("Attention"));
		for (const signal of report.signals) {
			const marker =
				signal.kind === "blocker"
					? style.fg("error", "✖")
					: signal.kind === "pending"
						? style.fg("warning", "…")
						: style.fg("dim", "·");
			lines.push(`  ${marker} ${clip(signal.text, 140)}`);
		}
	}
	return lines;
}
