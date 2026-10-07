/**
 * Wire contract of the `session.progress` (Q32) snapshot, `gjc.project_progress.v1`.
 *
 * This module is a dependency leaf on purpose: the production ACP agent renders
 * `/progress` from this contract and must not reach the in-process session
 * graph (enforced by `scripts/verify-gjc-sdk-canonicalization.ts`, which also
 * follows type-only imports). Status unions are restated here; the projection
 * in `progress-snapshot.ts` assigns the runtime statuses to them, so a new
 * runtime status that the contract lacks fails type checking.
 */
import { sanitizeDisplayLine } from "@gajae-code/utils";

/** Ultragoal story status (`UltragoalGoalStatus`). */
export type ProgressStoryStatus =
	| "pending"
	| "active"
	| "complete"
	| "failed"
	| "blocked"
	| "review_blocked"
	| "superseded";
/** Session goal status (`GoalStatus`). */
export type ProgressGoalStatus = "active" | "paused" | "complete" | "dropped";
/** Todo item status (`TodoStatus`). */
export type ProgressTodoStatus = "pending" | "in_progress" | "completed" | "abandoned";
/** Workflow HUD chip severity (`WorkflowHudSeverity`). */
export type ProgressChipSeverity = "info" | "warning" | "blocked" | "error" | "success";

/** Durable `.gjc` session-state sources that can fail to read. */
export type ProgressDurableSource = "workflow-state" | "ultragoal-plan";

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

export type ProgressSignalKind = "blocker" | "pending" | "note";

export type ProgressSignalSource = "ultragoal" | "workflow" | "subagents" | "todos" | "goal" | "state";

export interface ProgressAgentCounts {
	total: number;
	running: number;
	/** Subagents that are queued or paused. */
	waiting: number;
	completed: number;
	failed: number;
	cancelled: number;
}

export interface ProgressReviewVerdict {
	skill: string;
	verdict: string;
}

export const PROJECT_PROGRESS_SNAPSHOT_SCHEMA = "gjc.project_progress.v1";

/** Bounds keep one snapshot well under a single SDK query page. */
export const PROGRESS_SNAPSHOT_LIMITS = { stories: 100, todos: 100, workflows: 16, attention: 50, text: 300 } as const;

export interface ProgressSnapshotStory {
	id: string;
	title: string;
	status: ProgressStoryStatus;
	/** A completion-verification (quality-gate) receipt is recorded on the story. */
	verificationReceipt: boolean;
}

export interface ProgressSnapshotTodo {
	content: string;
	status: ProgressTodoStatus;
}

export interface ProgressSnapshotWorkflow {
	skill: string;
	phase: string;
	summary: string | null;
	chips: { label: string; value: string | null; severity: ProgressChipSeverity | null }[];
}

export interface ProgressSnapshotAttention {
	kind: ProgressSignalKind;
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
		/** `state === "complete"`: units done, goal (if any) complete, no subagents running, queued, or paused. */
		complete: boolean;
		explanation: string;
	};
	execution: {
		goal: { objective: string; status: ProgressGoalStatus; timeUsedSeconds: number } | null;
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
		/**
		 * Active story, else the next pending one, matching the Ultragoal scheduler.
		 * Blocked, review-blocked, and failed stories are never reported here (failed
		 * stories are retried only on explicit request); `null` when nothing is schedulable.
		 */
		story: { id: string; title: string } | null;
		/** In-progress todo, else the next pending one. */
		todo: string | null;
		workflows: ProgressSnapshotWorkflow[];
		/** Active workflows beyond `PROGRESS_SNAPSHOT_LIMITS.workflows` that `workflows` leaves out. */
		omittedWorkflows: number;
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
		/** Sources whose primary record was unreadable but whose contents were recovered from authoritative per-entry records. */
		recovered: ProgressDurableSource[];
		/** Sources whose readable derived snapshot listed entries the authoritative per-entry records do not; those stale entries were discarded. */
		discarded: ProgressDurableSource[];
		/** Sources listing entries whose authority could not be established; those entries are excluded and their absence is unconfirmed. */
		unresolved: ProgressDurableSource[];
	};
}

/** Strip terminal escapes/control characters and bound length; durable text is untrusted. */
export function boundSnapshotText(text: string, max: number = PROGRESS_SNAPSHOT_LIMITS.text): string {
	const clean = sanitizeDisplayLine(text).replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
