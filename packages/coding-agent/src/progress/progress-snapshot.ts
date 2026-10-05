/**
 * Machine-facing projection of the project progress report (SDK query
 * `session.progress`, Q32). It is a pure re-shaping of `ProjectProgressReport`:
 * every number, state, and attention item comes from the same computation as
 * the human `/progress` view, so the two can never disagree. Absent evidence
 * is `null`/empty, never estimated.
 */
import { sanitizeDisplayLine } from "@gajae-code/utils";
import type { UltragoalGoalStatus } from "../gjc-runtime/ultragoal-runtime";
import type { GoalStatus } from "../goals/state";
import type { WorkflowHudSeverity } from "../skill-state/active-state";
import type { TodoStatus } from "../tools/todo-write";
import type {
	ProgressAgentCounts,
	ProgressBasisKind,
	ProgressDurableSource,
	ProgressHeadline,
	ProgressReviewVerdict,
	ProgressSignal,
	ProgressSignalSource,
	ProjectProgressReport,
} from "./project-progress";

export const PROJECT_PROGRESS_SNAPSHOT_SCHEMA = "gjc.project_progress.v1";

/** Bounds keep one snapshot well under a single SDK query page. */
export const PROGRESS_SNAPSHOT_LIMITS = { stories: 100, todos: 100, workflows: 16, attention: 50, text: 300 } as const;

export interface ProgressSnapshotStory {
	id: string;
	title: string;
	status: UltragoalGoalStatus;
	/** A completion-verification (quality-gate) receipt is recorded on the story. */
	verificationReceipt: boolean;
}

export interface ProgressSnapshotTodo {
	content: string;
	status: TodoStatus;
}

export interface ProgressSnapshotWorkflow {
	skill: string;
	phase: string;
	summary: string | null;
	chips: { label: string; value: string | null; severity: WorkflowHudSeverity | null }[];
}

export interface ProgressSnapshotAttention {
	kind: ProgressSignal["kind"];
	source: ProgressSignalSource;
	ref: string | null;
	text: string;
}

export interface ProjectProgressSnapshot {
	schema: typeof PROJECT_PROGRESS_SNAPSHOT_SCHEMA;
	/** Overall completion state; identical to the `/progress` headline. */
	state: ProgressHeadline;
	completion: {
		/** Which countable units the indicator was derived from; `none` means nothing is countable. */
		basis: ProgressBasisKind;
		done: number;
		total: number;
		/** Whole percent; `null` when `basis` is `none`. Never 100 while a unit is open. */
		percent: number | null;
		/** Every counted unit is done (the session may still be awaiting goal completion or subagents). */
		allUnitsDone: boolean;
		/** `state === "complete"`: units done, goal (if any) complete, no subagents running or queued. */
		complete: boolean;
		explanation: string;
	};
	execution: {
		goal: { objective: string; status: GoalStatus; timeUsedSeconds: number } | null;
		ultragoal: {
			objective: string;
			counts: {
				total: number;
				complete: number;
				active: number;
				pending: number;
				blocked: number;
				superseded: number;
			};
			stories: ProgressSnapshotStory[];
			omittedStories: number;
		} | null;
		todos: {
			counts: { total: number; completed: number; inProgress: number; pending: number; abandoned: number };
			items: ProgressSnapshotTodo[];
			omittedItems: number;
		} | null;
	};
	activeWork: {
		/** Active story, else the next schedulable one. */
		story: { id: string; title: string } | null;
		/** In-progress todo, else the next pending one. */
		todo: string | null;
		workflows: ProgressSnapshotWorkflow[];
		agents: ProgressAgentCounts;
	};
	verification: {
		/** Present only when at least one story is complete. */
		storyReceipts: { complete: number; withReceipt: number; withoutReceipt: number } | null;
		reviewVerdicts: ProgressReviewVerdict[];
	};
	attention: ProgressSnapshotAttention[];
	omittedAttention: number;
	sources: {
		/** Session-scoped `.gjc` state (workflows, ultragoal plan) was consulted. */
		sessionStateRead: boolean;
		/** Sources that exist but could not be read; excluded from every count. */
		unreadable: ProgressDurableSource[];
	};
}

/** Strip terminal escapes/control characters and bound length; durable text is untrusted. */
export function boundSnapshotText(text: string, max: number = PROGRESS_SNAPSHOT_LIMITS.text): string {
	const clean = sanitizeDisplayLine(text).replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function bounded<T, U>(items: readonly T[], limit: number, map: (item: T) => U): { kept: U[]; omitted: number } {
	return { kept: items.slice(0, limit).map(map), omitted: Math.max(0, items.length - limit) };
}

export function toProjectProgressSnapshot(report: ProjectProgressReport): ProjectProgressSnapshot {
	const { completion } = report;
	const stories = report.stories;
	const ultragoal =
		report.ultragoal && stories
			? (() => {
					const { kept, omitted } = bounded(report.ultragoal.stories, PROGRESS_SNAPSHOT_LIMITS.stories, story => ({
						id: boundSnapshotText(story.id, 64),
						title: boundSnapshotText(story.title),
						status: story.status,
						verificationReceipt: story.hasVerificationReceipt,
					}));
					return {
						objective: boundSnapshotText(report.ultragoal.objective),
						counts: {
							total: stories.total,
							complete: stories.complete,
							active: stories.active,
							pending: stories.pending,
							blocked: stories.blocked,
							superseded: stories.superseded,
						},
						stories: kept,
						omittedStories: omitted,
					};
				})()
			: null;
	const todos = report.todos
		? (() => {
				const { kept, omitted } = bounded(report.todoItems, PROGRESS_SNAPSHOT_LIMITS.todos, todo => ({
					content: boundSnapshotText(todo.content),
					status: todo.status,
				}));
				const t = report.todos;
				return {
					counts: {
						total: t.total,
						completed: t.completed,
						inProgress: t.inProgress,
						pending: t.pending,
						abandoned: t.abandoned,
					},
					items: kept,
					omittedItems: omitted,
				};
			})()
		: null;
	const workflows = report.workflows.slice(0, PROGRESS_SNAPSHOT_LIMITS.workflows).map(workflow => ({
		skill: boundSnapshotText(workflow.skill, 64),
		phase: boundSnapshotText(workflow.phase, 64),
		summary: workflow.summary ? boundSnapshotText(workflow.summary) : null,
		chips: workflow.chips.map(chip => ({
			label: boundSnapshotText(chip.label, 64),
			value: chip.value ? boundSnapshotText(chip.value) : null,
			severity: chip.severity ?? null,
		})),
	}));
	const attention = bounded(report.signals, PROGRESS_SNAPSHOT_LIMITS.attention, signal => ({
		kind: signal.kind,
		source: signal.source,
		ref: signal.ref === undefined ? null : boundSnapshotText(signal.ref, 64),
		text: boundSnapshotText(signal.text),
	}));
	const receipts = report.verification.storyReceipts;
	return {
		schema: PROJECT_PROGRESS_SNAPSHOT_SCHEMA,
		state: report.headline,
		completion: {
			basis: completion.basis,
			done: completion.done,
			total: completion.total,
			percent: completion.percent ?? null,
			allUnitsDone: completion.total > 0 && completion.done >= completion.total,
			complete: report.headline === "complete",
			explanation: report.basisExplanation,
		},
		execution: {
			goal: report.goal
				? {
						objective: boundSnapshotText(report.goal.objective),
						status: report.goal.status,
						timeUsedSeconds: report.goal.timeUsedSeconds,
					}
				: null,
			ultragoal,
			todos,
		},
		activeWork: {
			story: stories?.current
				? { id: boundSnapshotText(stories.current.id, 64), title: boundSnapshotText(stories.current.title) }
				: null,
			todo: report.todos?.current ? boundSnapshotText(report.todos.current) : null,
			workflows,
			agents: { ...report.agents },
		},
		verification: {
			storyReceipts: receipts
				? {
						complete: receipts.complete,
						withReceipt: receipts.withReceipt,
						withoutReceipt: receipts.complete - receipts.withReceipt,
					}
				: null,
			reviewVerdicts: report.verification.reviewVerdicts.map(({ skill, verdict }) => ({
				skill: boundSnapshotText(skill, 64),
				verdict: boundSnapshotText(verdict, 64),
			})),
		},
		attention: attention.kept,
		omittedAttention: attention.omitted,
		sources: { sessionStateRead: report.sessionStateRead, unreadable: [...report.unreadable] },
	};
}
