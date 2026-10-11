/**
 * Read-only project progress projection. One report is re-shaped into the
 * machine-facing `session.progress` SDK snapshot (`progress-snapshot.ts`), and
 * the human-facing `/progress` view renders that same snapshot
 * (`render-progress.ts`) in the TUI, text mode, and ACP.
 *
 * The completion indicator is derived exclusively from countable units that
 * carry a durable completion status. It never weights units by size, never
 * credits partial work on an open unit, and never infers progress from
 * conversation text, elapsed time, or token spend. When no countable basis
 * exists the indicator is reported as unknown instead of guessed.
 */
import type { SubagentLifecycle } from "../async/job-manager";
import { selectNextSchedulableGoal, type UltragoalGoalStatus } from "../gjc-runtime/ultragoal-runtime";
import type { GoalStatus } from "../goals/state";
import type { WorkflowHudSeverity } from "../skill-state/active-state";
import type { TodoStatus } from "../tools/todo-write";
import type {
	ProgressAgentCounts,
	ProgressBasisKind,
	ProgressDurableSource,
	ProgressHeadline,
	ProgressReviewVerdict,
	ProgressSignalKind,
	ProgressSignalSource,
} from "./progress-contract";

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
	/** Durable sources whose primary record was unreadable but whose contents were recovered from authoritative per-entry records. */
	recovered: ProgressDurableSource[];
	/** Durable sources whose readable derived snapshot listed entries the authoritative per-entry records do not; those stale entries were discarded. */
	discarded: ProgressDurableSource[];
	/** Durable sources listing entries whose authority could not be established; those entries are excluded and their absence is unconfirmed. */
	unresolved: ProgressDurableSource[];
}

export interface ProgressSignal {
	kind: ProgressSignalKind;
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
	/** Active story, else the next pending one; blocked, review-blocked, and failed stories are never selected. */
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
	recovered: ProgressDurableSource[];
	discarded: ProgressDurableSource[];
	unresolved: ProgressDurableSource[];
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
	// Mirror the Ultragoal scheduler. A read-only projection never opts into
	// `--retry-failed`, so failed stories are not presented as next work.
	const current = selectNextSchedulableGoal(ultragoal.stories, false);
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
			text: `${plural(agents.running + agents.waiting, "subagent")} still running, queued, or paused; their work counts only once it is recorded in the plan or todos.`,
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
	for (const source of input.recovered) {
		signals.push({
			kind: "note",
			source: "state",
			ref: source,
			text: `${PROGRESS_SOURCE_LABELS[source]} snapshot could not be read; its contents were recovered from authoritative per-entry records.`,
		});
	}
	for (const source of input.discarded) {
		signals.push({
			kind: "note",
			source: "state",
			ref: source,
			text: `${PROGRESS_SOURCE_LABELS[source]} snapshot is stale; workflows it lists without an authoritative per-entry record were discarded, not reported as active.`,
		});
	}
	for (const source of input.unresolved) {
		signals.push({
			kind: "note",
			source: "state",
			ref: source,
			text: `${PROGRESS_SOURCE_LABELS[source]} lists workflows whose authority cannot be established; they are not reported as active, and their absence is unconfirmed.`,
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
		recovered: input.recovered,
		discarded: input.discarded,
		unresolved: input.unresolved,
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
