import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Usage } from "@gajae-code/ai/core";
import { $env } from "@gajae-code/utils";
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

const parsePositiveIntegerEnvironment = (keys: string[], defaultValue: number): number => {
	for (const key of keys) {
		const value = $env[key];
		if (!value || value.trim().length === 0) continue;
		if (!/^\d+$/.test(value)) return defaultValue;
		const number = Number(value);
		return Number.isSafeInteger(number) && number > 0 ? number : defaultValue;
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parsePositiveIntegerEnvironment(
	["GJC_TASK_MAX_OUTPUT_BYTES", "PI_TASK_MAX_OUTPUT_BYTES"],
	500_000,
);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parsePositiveIntegerEnvironment(
	["GJC_TASK_MAX_OUTPUT_LINES", "PI_TASK_MAX_OUTPUT_LINES"],
	5000,
);

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

const repositoryBindingSchema = z
	.object({
		schema: z.literal("gjc.repository_binding.v1"),
		worktreeRoot: z.string().min(1).describe("canonical git worktree root"),
		commonDir: z.string().min(1).nullable().describe("git common dir, or null outside a git checkout"),
		relativeSubdir: z.string().min(1).optional().describe("optional repo-relative subdirectory; not an absolute cwd"),
		displayPath: z.string().min(1).optional().describe("human-facing path; never used for authority"),
		head: z.string().min(1).optional(),
		branch: z.string().min(1).optional(),
	})
	.strict()
	.describe("authoritative repository identity for multi-repo fail-closed spawn");

const createTaskItemSchema = (_contextEnabled: boolean) =>
	z.object({
		id: z.string().max(48).refine(isValidTaskId, TASK_ID_DESCRIPTION).describe("filesystem-safe task identifier"),
		description: z.string().describe("ui label, not seen by subagent"),
		assignment: z.string().describe(assignmentDescription),
		tier: z
			.enum(["fast", "balanced", "strong"])
			.optional()
			.describe("Advisory unless autorouting is enabled; omitted routes as balanced."),
		executionMode: z
			.enum(["default", "ultragoal-red-team"])
			.optional()
			.describe(
				"typed executor mode: default keeps ordinary executor behavior; ultragoal-red-team injects the Ultragoal QA/red-team prompt fragment. Prefer this over free-form assignment text (#2698).",
			),
		inheritContext: z
			.enum(["none", "receipt", "last-turn", "bounded", "full"])
			.optional()
			.describe(
				"fork-context mode: none/omitted copies no parent context; receipt copies a minimal receipt-sized snapshot; last-turn copies only the latest exchange; bounded copies the bounded default snapshot; full copies a larger sanitized snapshot up to the configured/model token cap",
			),
		repositoryBinding: repositoryBindingSchema
			.optional()
			.describe(
				"authoritative repository identity; omitted items are stamped from session cwd before discovery/spawn and still fail closed on sibling drift",
			),
		duplicate_policy: z.enum(["warn", "supersede"]).optional().describe("duplicate launch policy; defaults to warn"),
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
	duplicate_policy?: "warn" | "supersede";
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

/** Durable full-fidelity review findings artifact associated with a task result. */
export interface ReviewFindingsArtifactRef {
	uri: `artifact://${string}`;
	sizeBytes: number;
	sha256: string;
	findingCount: number;
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
	/** Whether the resolved subagent model runs under the effective fast service tier. */
	fastMode?: boolean;
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
		kind: "first_event_timeout" | "idle_stream_stall" | "provider_error";
		provider?: string;
		lastProviderProgressAtMs?: number;
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
	/** Safe diagnostic retained in terminal progress when setup fails before the first LLM request. */
	setupFailure?: SetupFailureSummary;
	/**
	 * Snapshot of the most recent `task` tool call's in-flight `TaskToolDetails`,
	 * captured from `tool_execution_update`. Lets the parent UI surface live
	 * nested-subagent progress while this agent is still inside its own `task`
	 * call. Cleared when the call ends — finalized data lives in
	 * `extractedToolData.task` after that.
	 */
	inflightTaskDetails?: TaskToolDetails;
}

/** Bounded diagnostic retained when subagent setup fails before an LLM request starts. */
export interface SetupFailureSummary {
	summary: string;
}

const SETUP_FAILURE_SUMMARY_MAX_CHARS = 280;
const SETUP_FAILURE_SUMMARY_MAX_BYTES = 1_024;
const AUTHORIZATION_HEADER_VALUE_PATTERN = /(["']?(?:Proxy-)?Authorization\b["']?\s*:\s*)[^\r\n]*/gi;
const COOKIE_HEADER_VALUE_PATTERN = /(["']?(?:Set-)?Cookie\b["']?\s*:\s*)[^\r\n]*/gi;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/?#\s:@]+:[^@/?#\s]+@/gi;
const API_KEY_LABEL_VALUE_PATTERN = /(["']?api\s+key["']?\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s&]+)/gi;
const SENSITIVE_SETUP_FAILURE_VALUE_PATTERN =
	/(["']?(?:(?:[A-Za-z][A-Za-z0-9]*[_.-])*?)(?:access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|signing[_-]?key|secret|password|passwd|pwd|authorization|credential|token)(?:[_.-][A-Za-z0-9]+)*["']?)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&]+)/gi;
const BARE_PROVIDER_TOKEN_PATTERN =
	/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16})\b/g;
const LOCAL_ABSOLUTE_PATH_PATTERN = /(^|[\s("'`=])((?:\/(?!\/)[^\s/:?"'`()[\]{},;<>]+){2,})/g;
const WINDOWS_ABSOLUTE_PATH_PATTERN =
	/(^|[\s("'`=])([A-Za-z]:\\(?:[^\\/:?"'`()[\]{},;<>\s]+\\)+[^\\/:?"'`()[\]{},;<>\s]+)/g;
const LOCAL_FILE_URI_PATTERN = /\bfile:\/\/(?:localhost)?(?:\/[^\s/:?"'`()[\]{},;<>]+)+/gi;
const SENSITIVE_PATH_BASENAME_PATTERN =
	/(?:^|[_.-])(?:access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|signing[_-]?key|secrets?|password|passwd|pwd|authorization|credential|token)(?:[_.-]|$)|^(?:\.env(?:\..*)?|credentials?(?:\.[A-Za-z0-9_-]+)?|id_(?:rsa|ed25519)|.+\.(?:pem|p12|pfx|key))$|^(?:sk|pk|rk|gh[opsur]|github_pat|xox[baprs])[_-][A-Za-z0-9_-]+$/i;

function redactPathBasename(path: string): string {
	const basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	return SENSITIVE_PATH_BASENAME_PATTERN.test(basename) ? "[redacted]" : basename;
}

function redactLocalAbsolutePath(_match: string, prefix: string, absolutePath: string): string {
	return `${prefix}<path>/${redactPathBasename(absolutePath)}`;
}

function redactLocalFileUri(uri: string): string {
	return `file://<path>/${redactPathBasename(uri)}`;
}

function normalizeSetupFailureText(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g, "")
		.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
		.replace(/\t/g, " ");
}

function capSetupFailureSummary(value: string): string {
	const ellipsis = "…";
	const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
	const chunks: string[] = [];
	let chars = 0;
	let bytes = 0;
	for (const codePoint of value) {
		const codePointBytes = Buffer.byteLength(codePoint, "utf8");
		if (chars + 1 > SETUP_FAILURE_SUMMARY_MAX_CHARS || bytes + codePointBytes > SETUP_FAILURE_SUMMARY_MAX_BYTES) {
			while (
				chunks.length > 0 &&
				(chars + 1 > SETUP_FAILURE_SUMMARY_MAX_CHARS || bytes + ellipsisBytes > SETUP_FAILURE_SUMMARY_MAX_BYTES)
			) {
				const removed = chunks.pop()!;
				chars -= 1;
				bytes -= Buffer.byteLength(removed, "utf8");
			}
			return `${chunks.join("")}${ellipsis}`;
		}
		chunks.push(codePoint);
		chars += 1;
		bytes += codePointBytes;
	}
	return chunks.join("");
}

/** Create a bounded diagnostic that preserves a setup failure's cause without exposing credentials or local paths. */
export function createSetupFailureSummary(error: unknown): SetupFailureSummary {
	const message = normalizeSetupFailureText(error instanceof Error ? error.message : String(error));
	const summary = message
		.replace(AUTHORIZATION_HEADER_VALUE_PATTERN, "$1[redacted]")
		.replace(COOKIE_HEADER_VALUE_PATTERN, "$1[redacted]")
		.replace(URL_CREDENTIAL_PATTERN, "$1[redacted]@")
		.replace(API_KEY_LABEL_VALUE_PATTERN, "$1[redacted]")
		.replace(LOCAL_FILE_URI_PATTERN, redactLocalFileUri)
		.replace(LOCAL_ABSOLUTE_PATH_PATTERN, redactLocalAbsolutePath)
		.replace(WINDOWS_ABSOLUTE_PATH_PATTERN, redactLocalAbsolutePath)
		.replace(SENSITIVE_SETUP_FAILURE_VALUE_PATTERN, "$1$2[redacted]")
		.replace(BARE_PROVIDER_TOKEN_PATTERN, "[redacted]")
		.replace(/\s+/g, " ")
		.trim();
	return {
		summary: capSetupFailureSummary(summary) || "Subagent setup failed.",
	};
}

export interface TaskRecoveryArtifactRef {
	uri: string;
	sizeBytes: number;
	sha256: string;
	/** Recovery artifacts remain readable for the parent session lifetime. */
	durability: "session";
}

/** Bounded duplicate-launch disposition carried into task receipts. */
export interface DuplicateDisposition {
	action: "warned" | "superseded";
	predecessorIds: string[];
}

export interface TaskPersistenceResult {
	outcome: "applied" | "no_changes" | "recovery_available";
	ownerWorktreeApplied: boolean;
	recoveryRef?: TaskRecoveryArtifactRef;
}

export type RoutingSubstitution = "auth_substituted" | "assistant_model_mismatch";

/** A typed failure observed while an autorouting candidate is still before the real provider fence. */
export type AutoroutingPreflightFailure =
	| {
			kind: "local";
			op: "auth_resolve" | "session_open" | "tool_bootstrap" | "preflight_validation";
			transient: boolean;
	  }
	| { kind: "transport"; class: import("@gajae-code/ai/utils/fallback-transport").FallbackTriggerClass };

export type AutoroutingAttemptCode =
	| "probe_passed"
	| "accepted"
	| "spawn_transient_retry"
	| "credential_unavailable"
	| "config_invalid_terminal"
	| "post_acceptance_failure"
	| "unclassified_terminal";

export type AutoroutingAttempt = {
	selector: string;
	phase: "probe" | "durable";
	code: AutoroutingAttemptCode;
};

export type AutoroutingSkip = {
	selector: string;
	code: import("../config/autorouting-contract").AutoroutingReasonCode;
};

export interface TaskRoutingEvidence {
	tier: "fast" | "balanced" | "strong";
	requestedTier?: "fast" | "balanced" | "strong";
	defaultTierApplied?: true;
	source: "tiers" | { preset: string };
	requestedSelector: string;
	authResolvedModel?: string;
	effectiveModel?: string;
	notExecuted?: true;
	substitutions: RoutingSubstitution[];
	manualFallbackReason?: "tier_unmatched" | "tier_missing_in_map";
	freshOnResume?: true;
	note?: string;
	skips?: AutoroutingSkip[];
	omittedSkipCount?: number;
	omittedByCode?: Partial<Record<AutoroutingSkip["code"], number>>;
	attempts?: AutoroutingAttempt[];
	terminal?: "preflight_exhausted" | "all_candidates_skipped";
}

const AUTOROUTING_ATTEMPT_CODES = new Set<AutoroutingAttemptCode>([
	"probe_passed",
	"accepted",
	"spawn_transient_retry",
	"credential_unavailable",
	"config_invalid_terminal",
	"post_acceptance_failure",
	"unclassified_terminal",
]);

function validBoundedSelector(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function assertRoutingEvidenceInvariant(evidence: TaskRoutingEvidence): void {
	const terminalWithoutModel = evidence.terminal !== undefined || evidence.notExecuted === true;
	if (!terminalWithoutModel && (!evidence.effectiveModel || evidence.effectiveModel.length > 256))
		throw new Error("Invalid effective routing model.");
	if (evidence.authResolvedModel && evidence.authResolvedModel === evidence.effectiveModel)
		throw new Error("authResolvedModel must differ from effectiveModel when present.");
	if (evidence.authResolvedModel !== undefined && !validBoundedSelector(evidence.authResolvedModel))
		throw new Error("Invalid auth-resolved routing model.");

	if (evidence.requestedSelector.length > 256) throw new Error("Invalid requested routing selector.");
	if (evidence.skips && evidence.skips.length > 16) throw new Error("Too many autorouting skips.");
	if (evidence.attempts && evidence.attempts.length > 6) throw new Error("Too many autorouting attempts.");
	if (
		evidence.omittedSkipCount !== undefined &&
		(!Number.isSafeInteger(evidence.omittedSkipCount) || evidence.omittedSkipCount < 0)
	)
		throw new Error("Invalid omitted autorouting skip count.");
	for (const [code, count] of Object.entries(evidence.omittedByCode ?? {})) {
		if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid omitted autorouting skip aggregate.");
		if (
			!(
				code in
				{
					tier_unmatched: true,
					tier_missing_in_map: true,
					config_invalid: true,
					map_absent: true,
					selector_not_provider_qualified: true,
					auth_substituted: true,
					assistant_model_mismatch: true,
					provider_disabled: true,
					snapshot_missing: true,
					credential_unavailable: true,
					preflight_spawn_failed: true,
					preflight_exhausted: true,
				}
			)
		)
			throw new Error("Invalid omitted autorouting skip code.");
	}
	for (const skip of evidence.skips ?? []) {
		if (!validBoundedSelector(skip.selector)) throw new Error("Invalid autorouting skip selector.");
		if (
			!(
				skip.code in
				{
					tier_unmatched: true,
					tier_missing_in_map: true,
					config_invalid: true,
					map_absent: true,
					selector_not_provider_qualified: true,
					auth_substituted: true,
					assistant_model_mismatch: true,
					provider_disabled: true,
					snapshot_missing: true,
					credential_unavailable: true,
					preflight_spawn_failed: true,
					preflight_exhausted: true,
				}
			)
		)
			throw new Error("Invalid autorouting skip code.");
	}
	for (const attempt of evidence.attempts ?? []) {
		if (!validBoundedSelector(attempt.selector) || !AUTOROUTING_ATTEMPT_CODES.has(attempt.code))
			throw new Error("Invalid autorouting attempt.");
		if (attempt.code === "accepted" && attempt.phase !== "durable")
			throw new Error("accepted requires durable phase.");
		if (attempt.code === "probe_passed" && attempt.phase !== "probe")
			throw new Error("probe_passed requires probe phase.");
		if (attempt.phase === "probe" && attempt.code === "post_acceptance_failure")
			throw new Error("post_acceptance_failure requires durable phase.");
		if (attempt.phase === "durable" && attempt.code === "probe_passed")
			throw new Error("probe_passed requires probe phase.");
	}
	if (evidence.terminal === undefined && evidence.omittedSkipCount && !evidence.skips)
		throw new Error("Omitted skips require skip evidence.");
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
	routing?: TaskRoutingEvidence;

	modelOverride?: string | string[];
	modelSubstitutionWarning?: ModelSubstitutionWarning;
	/** Whether the resolved subagent model ran under the effective fast service tier. */
	fastMode?: boolean;
	error?: string;
	/** Safe diagnostic for a failure before the subagent sent its first LLM request. */
	setupFailure?: SetupFailureSummary;
	/** Internal typed autorouting preflight outcome; receipt sanitization omits this field. */
	preflightFailure?: AutoroutingPreflightFailure;
	preflightFenceCrossed?: boolean;
	preflightProbeAccepted?: boolean;
	preflightCommitFailure?: boolean;
	aborted?: boolean;
	abortReason?: string;

	duplicateDisposition?: DuplicateDisposition;
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
	/** Receipt-safe owner-worktree persistence result for isolated execution. */
	persistence?: TaskPersistenceResult;
	/** Identity-bound patch artifact captured before isolation cleanup. */
	recoveryRef?: TaskRecoveryArtifactRef;
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/** Full wrapper-owned review evidence, kept separate from caller completion data. */
	reviewFindingsRef?: ReviewFindingsArtifactRef;
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
	/**
	 * Resolved repository identity used for this task after pre-discovery stamping
	 * and fail-closed validation (#2901).
	 */
	repositoryBinding?: {
		schema: "gjc.repository_binding.v1";
		worktreeRoot: string;
		commonDir: string | null;
		relativeSubdir?: string;
		displayPath?: string;
		head?: string;
		branch?: string;
	};
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
