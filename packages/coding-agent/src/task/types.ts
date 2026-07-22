import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Usage } from "@gajae-code/ai";
import { $pickenv } from "@gajae-code/utils";
import * as z from "zod/v4";
import { isValidTaskId, TASK_ID_DESCRIPTION } from "./id";
import type { TaskResultReceipt } from "./receipt";
import type { SpawnRoiReconciliation } from "./roi-reconciliation";
import { getTaskSimpleModeCapabilities, type TaskSimpleMode } from "./simple-mode";
import type { SpawnPlanReceipt } from "./spawn-gate";
import type { NestedRepoPatch } from "./worktree";

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";
export type ForkContextPolicy = "forbidden" | "allowed";
export type ForkContextMode = "none" | "receipt" | "last-turn" | "bounded" | "full";

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($pickenv("GJC_TASK_MAX_OUTPUT_BYTES", "PI_TASK_MAX_OUTPUT_BYTES"), 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($pickenv("GJC_TASK_MAX_OUTPUT_LINES", "PI_TASK_MAX_OUTPUT_LINES"), 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** EventBus channel for aggregated subagent progress */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** EventBus channel for subagent lifecycle (start/end) */
export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

/** Payload emitted on TASK_SUBAGENT_PROGRESS_CHANNEL */
export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
}

/** Payload emitted on TASK_SUBAGENT_LIFECYCLE_CHANNEL */
export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: AgentSource;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted" | "paused";
	sessionFile?: string;
	index: number;
}

const assignmentDescription = "per-task instructions; self-contained";
const spawnPlanSchema = z
	.object({
		whyParallel: z.string(),
		whyNotLocal: z.string(),
		independence: z.string(),
		expectedReceiptShape: z.string(),
		maxInlineTokens: z.number(),
	})
	.describe("justification required before spawning more than four tasks");

const createTaskItemSchema = (_contextEnabled: boolean) =>
	z.object({
		id: z.string().max(48).refine(isValidTaskId, TASK_ID_DESCRIPTION).describe("filesystem-safe task identifier"),
		description: z.string().describe("ui label, not seen by subagent"),
		assignment: z.string().describe(assignmentDescription),
		inheritContext: z
			.enum(["none", "receipt", "last-turn", "bounded", "full"])
			.optional()
			.describe(
				"fork-context mode: none/omitted copies no parent context; receipt copies a minimal receipt-sized snapshot; last-turn copies only the latest exchange; bounded copies the bounded default snapshot; full copies a larger sanitized snapshot up to the configured/model token cap",
			),
	});

/** Single task item for parallel execution (default shape with context enabled). */
export const taskItemSchema = createTaskItemSchema(true);
export type TaskItem = z.infer<typeof taskItemSchema>;

const createTaskSchema = (options: { isolationEnabled: boolean; simpleMode: TaskSimpleMode }) => {
	const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(options.simpleMode);
	let itemSchema = createTaskItemSchema(contextEnabled);
	if (!contextEnabled) {
		itemSchema = itemSchema.superRefine((item, ctx) => {
			if (item.inheritContext !== undefined && item.inheritContext !== "none") {
				ctx.addIssue({
					code: "custom",
					path: ["inheritContext"],
					message: "Independent tasks cannot inherit parent context; omit inheritContext or set it to none.",
				});
			}
		});
	}

	let schema = z.object({
		agent: z.string().describe("agent type"),
		tasks: z.array(itemSchema).describe("tasks to execute in parallel"),
		spawnPlan: spawnPlanSchema.optional(),
	});
	if (contextEnabled) {
		schema = schema.extend({
			context: z.string().optional().describe("shared background prepended to each assignment"),
		});
	}

	if (customSchemaEnabled) {
		schema = schema.extend({
			schema: z.string().optional().describe("jtd schema for expected response shape"),
		});
	}

	if (options.isolationEnabled) {
		schema = schema.extend({
			isolated: z.boolean().optional().describe("run in isolated env; returns patches"),
		});
	}

	return schema;
};

export const taskSchema = createTaskSchema({ isolationEnabled: true, simpleMode: "default" });
export const taskSchemaNoIsolation = createTaskSchema({ isolationEnabled: false, simpleMode: "default" });
const taskSchemaSchemaFree = createTaskSchema({ isolationEnabled: true, simpleMode: "schema-free" });
const taskSchemaSchemaFreeNoIsolation = createTaskSchema({ isolationEnabled: false, simpleMode: "schema-free" });
const taskSchemaIndependent = createTaskSchema({ isolationEnabled: true, simpleMode: "independent" });
const taskSchemaIndependentNoIsolation = createTaskSchema({ isolationEnabled: false, simpleMode: "independent" });
const ALL_TASK_SCHEMAS = [
	taskSchema,
	taskSchemaNoIsolation,
	taskSchemaSchemaFree,
	taskSchemaSchemaFreeNoIsolation,
	taskSchemaIndependent,
	taskSchemaIndependentNoIsolation,
] as const;

type DynamicTaskSchema = (typeof ALL_TASK_SCHEMAS)[number];
export type TaskSchema = typeof taskSchema;
/** Active task tool parameter schema for the current simple-mode / isolation flags */
export type TaskToolSchemaInstance = DynamicTaskSchema;

export function getTaskSchema(options: { isolationEnabled: boolean; simpleMode: TaskSimpleMode }): DynamicTaskSchema {
	switch (options.simpleMode) {
		case "schema-free":
			return options.isolationEnabled ? taskSchemaSchemaFree : taskSchemaSchemaFreeNoIsolation;
		case "independent":
			return options.isolationEnabled ? taskSchemaIndependent : taskSchemaIndependentNoIsolation;
		default:
			return options.isolationEnabled ? taskSchema : taskSchemaNoIsolation;
	}
}

export interface TaskParams {
	agent: string;
	context?: string;
	schema?: string;
	spawnPlan?: SpawnPlanReceipt;
	tasks: TaskItem[];
	isolated?: boolean;
}

/** A code review finding reported by the reviewer agent */
export interface ReviewFinding {
	title: string;
	body: string;
	priority: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

/** Review summary submitted by the reviewer agent */
export interface ReviewSummary {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

/** Structured review data extracted from reviewer agent */
export interface ReviewData {
	findings: ReviewFinding[];
	summary?: ReviewSummary;
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ThinkingLevel;
	output?: unknown;
	blocking?: boolean;
	autoloadSkills?: string[];
	hide?: boolean;
	forkContext?: ForkContextPolicy;
	bashAllowedPrefixes?: string[];
	source: AgentSource;
	filePath?: string;
}

export interface ModelSubstitutionWarning {
	requested: string;
	effective: string;
	reason: "auth_unavailable" | "assistant_model_mismatch";
}

/** Progress tracking for a single agent */
export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted" | "paused";
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	/** Cumulative input + output + cacheWrite tokens across all turns. Excludes cacheRead (re-reads cached context every turn, making cumulative sum misleading). */
	tokens: number;
	/**
	 * Current per-turn context size: latest assistant message's `usage.totalTokens`.
	 * This is the number to compare against `contextWindow` — what compaction
	 * decides on, what the user typically reads as "how full is the context".
	 * Distinct from `tokens`, which is a lifetime billing-volume counter.
	 */
	contextTokens?: number;
	/** Model's context window in tokens, when known. Lets the UI render `<curr>/<window>` gauges. */
	contextWindow?: number;
	/** Cumulative billing cost in USD, accumulated incrementally from message_end events. */
	cost: number;
	durationMs: number;
	modelOverride?: string | string[];
	modelSubstitutionWarning?: ModelSubstitutionWarning;
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/**
	 * Auto-retry state when the subagent is sleeping between provider retries
	 * (e.g. 429 rate-limit with retry-after). Cleared when the retry resolves
	 * or fails. Surfacing this to the parent prevents the task tool from
	 * looking indefinitely "in progress" when a child is actually blocked on
	 * provider quota.
	 */
	retryState?: {
		attempt: number;
		maxAttempts: number;
		unbounded?: boolean;
		delayMs: number;
		errorMessage: string;
		startedAtMs: number;
	};
	/**
	 * Terminal retry failure surfaced once the subagent gave up retrying
	 * (e.g. retry-after exceeded the cap, or all attempts exhausted). Carries
	 * the final error so the parent UI can render "blocked: rate-limited"
	 * instead of waiting for a status that never arrives.
	 */
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	/**
	 * Snapshot of the most recent `task` tool call's in-flight `TaskToolDetails`,
	 * captured from `tool_execution_update`. Lets the parent UI surface live
	 * nested-subagent progress while this agent is still inside its own `task`
	 * call. Cleared when the call ends — finalized data lives in
	 * `extractedToolData.task` after that.
	 */
	inflightTaskDetails?: TaskToolDetails;
}

/** Result from a single agent execution */
export interface SingleResult {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	/** Cumulative input + output + cacheWrite tokens across all turns. Excludes cacheRead (re-reads cached context every turn, making cumulative sum misleading). */
	tokens: number;
	/** Latest per-turn context size at task completion. See `AgentProgress.contextTokens`. */
	contextTokens?: number;
	/** Model's context window in tokens, when known. */
	contextWindow?: number;
	modelOverride?: string | string[];
	modelSubstitutionWarning?: ModelSubstitutionWarning;
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	paused?: boolean;
	/** Aggregated usage from the subprocess, accumulated incrementally from message_end events. */
	usage?: Usage;
	/** True only when every usage-contributing assistant supplied a complete, non-negative raw cost breakdown. */
	usageCostBreakdownComplete?: true;
	/** Output path for the task result */
	outputPath?: string;
	/** Patch path for isolated worktree output */
	patchPath?: string;
	/** Branch name for isolated branch-mode output */
	branchName?: string;
	/** Nested repo patches to apply after parent merge */
	nestedPatches?: NestedRepoPatch[];
	/** Whether isolated execution produced a non-empty root or nested patch. */
	producedChanges?: boolean;
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/**
	 * Terminal retry failure, when the subagent exited because the auto-retry
	 * loop gave up (retry-after exceeded the cap, or all attempts exhausted).
	 * Lets the parent task tool surface a "blocked: rate-limited" outcome
	 * instead of a generic failure.
	 */
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	/** Output metadata for agent:// URL integration */
	outputMeta?: { lineCount: number; charCount: number; byteSize?: number; sha256?: string };
	/** Fork-context seed accounting for this subagent, when inherited parent context was cloned. */
	forkContext?: { mode: ForkContextMode; clonedTokens: number };
	/**
	 * Advisory fork-context mode recommendation for this task (logged only;
	 * never changes the actual mode selection).
	 */
	forkContextAdvisory?: { recommendedMode: ForkContextMode; reasons: string[] };
}

/** True only for complete, factual five-bucket cost accounting. */
export function hasCompleteUsageCostBreakdown(usage: unknown): boolean {
	if (!usage || typeof usage !== "object") return false;
	const cost = (usage as { cost?: unknown }).cost;
	if (!cost || typeof cost !== "object") return false;
	return ["input", "output", "cacheRead", "cacheWrite", "total"].every(key => {
		const value = (cost as Record<string, unknown>)[key];
		return typeof value === "number" && Number.isFinite(value) && value >= 0;
	});
}

/** True only when every usage-contributing result has explicit, complete cost provenance. */
export function hasCompleteAggregateUsageCostBreakdown(
	results: readonly Pick<SingleResult, "usage" | "usageCostBreakdownComplete">[],
): boolean {
	return results.every(
		result =>
			result.usage === undefined ||
			(result.usageCostBreakdownComplete === true && hasCompleteUsageCostBreakdown(result.usage)),
	);
}

/** Tool details for TUI rendering */
export interface TaskToolDetails {
	projectAgentsDir: string | null;
	results: TaskResultReceipt[];
	totalDurationMs: number;
	/** Aggregated usage across all subagents. */
	usage?: Usage;
	/** True only when every usage-contributing subagent supplied a complete raw cost breakdown. */
	usageCostBreakdownComplete?: true;
	/** Aggregate cloned tokens copied into fork-context seeds across subagents. */
	forkContextClonedTokens?: number;
	roiSummary?: {
		childCount: number;
		totalTokens: number;
		totalCostTotal?: number;
		totalClonedTokens?: number;
		/** Advisory ids for terminal children that spent tokens without detectable output/review/changes. */
		lowRoiChildIds: string[];
	};
	roiReconciliation?: SpawnRoiReconciliation;
	progress?: AgentProgress[];
	async?: {
		state: "running" | "paused" | "queued" | "completed" | "failed";
		jobId: string;
		type: "task";
	};
}
/**
 * Persisted per-turn / per-subagent token record (Phase 0 instrumentation).
 *
 * Additive: this does not alter any existing task result shape. It is the
 * durable, model-independent unit the deterministic orchestration-token
 * benchmark (`@gajae-code/orchestration-token-benchmark`) consumes to measure
 * token efficiency without any live-model calls.
 */
export interface TaskTokenLog {
	/** Subagent id, or "root" for the orchestrator's own turn. */
	subagentId: string;
	/** Agent name for attribution, when known. */
	agent?: string;
	/** 1-based turn index within the subagent's session. */
	turn: number;
	/** ISO-8601 timestamp the turn completed. */
	at: string;
	/** Cost-bearing input tokens (excludes cache reads), mirrors `Usage.input`. */
	input: number;
	/** Total output tokens for the turn, mirrors `Usage.output`. */
	output: number;
	/** Tokens read from the prompt cache, mirrors `Usage.cacheRead`. */
	cacheRead: number;
	/** Tokens written to the prompt cache, mirrors `Usage.cacheWrite`. */
	cacheWrite: number;
	/** input + output + cacheRead + cacheWrite. */
	totalTokens: number;
	/** Latest per-turn context-window occupancy, when known. */
	contextTokens?: number;
	/** Estimated USD cost for the turn, when known. */
	cost?: number;
	/** Model id used for the turn, when known. */
	model?: string;
}

/**
 * Deterministic aggregate token metrics computed from a set of `TaskTokenLog`
 * entries. The cache-hit-rate field is the primary prompt-cache signal called
 * out by the prefix-stability invariant (see the approved plan).
 */
export interface TaskTokenMetrics {
	/** Number of token-log entries aggregated. */
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	/** cacheRead / (input + cacheRead); 0 when there is no input-class traffic. */
	cacheHitRate: number;
}
