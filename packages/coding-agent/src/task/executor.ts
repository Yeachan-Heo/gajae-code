/**
 * In-process execution for subagents.
 *
 * Runs each subagent on the main thread and forwards AgentEvents for progress tracking.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, AgentIdentity, AgentTelemetryConfig, ThinkingLevel } from "@gajae-code/agent-core";
import { recordHandoff, resolveTelemetry } from "@gajae-code/agent-core";
import type { ServiceTier } from "@gajae-code/ai";
import { type JsonSchemaValidationIssue, validateJsonSchemaValue } from "@gajae-code/ai/utils/schema";
import { logger, prompt, untilAborted } from "@gajae-code/utils";
import { AsyncJobManager } from "../async";
import { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveModelOverrideWithAuthFallback } from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import { Settings } from "../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings-schema";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import { buildAgentSubskillInjection, renderAgentPromptAdditions } from "../extensibility/gjc-plugins";
import { buildSkillPromptMessage, type Skill } from "../extensibility/skills";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import submitReminderTemplate from "../prompts/system/subagent-yield-reminder.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession, discoverAuthStorage } from "../sdk";
import type { AgentSession, AgentSessionEvent, ForkContextSeed } from "../session/agent-session";
import type { ArtifactManager } from "../session/artifacts";
import type { AuthStorage } from "../session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import { truncateTail } from "../session/streaming-output";
import type { ContextFileEntry } from "../tools";
import { jtdToJsonSchema, normalizeSchema } from "../tools/jtd-to-json-schema";
import { type ReportFindingDetails, toReviewFinding } from "../tools/review";
import { ToolAbortError } from "../tools/tool-errors";
import type { EventBus } from "../utils/event-bus";
import { buildNamedToolChoiceResult } from "../utils/tool-choice";
import type { WorkspaceTree } from "../workspace-tree";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type ModelSubstitutionWarning,
	type ReviewFinding,
	type SingleResult,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type TaskToolDetails,
} from "./types";

/** Agent event types to forward for progress tracking. */
const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent =>
	agentEventTypes.has(event.type as AgentEvent["type"]);

function normalizeModelPatterns(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map(entry => entry.trim()).filter(Boolean);
	}
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

function renderIrcPeerRoster(selfId: string): string {
	const peers = AgentRegistry.global()
		.list()
		.filter(ref => ref.id !== selfId && (ref.status === "running" || ref.status === "idle"));
	if (peers.length === 0) return "- (no other live agents)";
	return peers.map(peer => `- \`${peer.id}\` — ${peer.displayName} (${peer.kind}, ${peer.status})`).join("\n");
}

function getReportFindingKey(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title : null;
	const filePath = typeof record.file_path === "string" ? record.file_path : null;
	const lineStart = typeof record.line_start === "number" ? record.line_start : null;
	const lineEnd = typeof record.line_end === "number" ? record.line_end : null;
	const priority = typeof record.priority === "string" ? record.priority : null;
	if (!title || !filePath || lineStart === null || lineEnd === null) {
		return null;
	}
	return `${filePath}:${lineStart}:${lineEnd}:${priority ?? ""}:${title}`;
}

/** Options for subagent execution */
export interface ExecutorOptions {
	cwd: string;
	worktree?: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	context?: string;
	description?: string;
	index: number;
	id: string;
	modelOverride?: string | string[];
	runMode?: "initial" | "resume" | "message";
	resumeMessage?: string;
	subagentId?: string;
	/**
	 * Active model selector of the parent session, used as an auth-aware fallback
	 * if the resolved subagent model has no working credentials. See #985.
	 */
	parentActiveModelPattern?: string;
	parentSessionId?: string;
	thinkingLevel?: ThinkingLevel;
	outputSchema?: unknown;
	/** Parent task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	enableLsp?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	sessionFile?: string | null;
	persistArtifacts?: boolean;
	artifactsDir?: string;
	/** Path to parent conversation context file */
	contextFile?: string;
	/** Whether the parent runtime actually exposes IRC coordination. */
	ircAvailable?: boolean;
	eventBus?: EventBus;
	contextFiles?: ContextFileEntry[];
	skills?: Skill[];
	promptTemplates?: PromptTemplate[];
	workspaceTree?: WorkspaceTree;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	/**
	 * Live service-tier intent of the parent session (`AgentSession.serviceTier`),
	 * used as the inherited tier when `task.serviceTier === "inherit"`. Passing the
	 * live value (not the stale settings snapshot) lets a runtime `/fast on` reach
	 * subagents, and a main-model fast-mode auto-disable does not clobber it.
	 */
	inheritedServiceTier?: ServiceTier;
	/** Override local:// protocol options so subagent shares parent's local:// root */
	localProtocolOptions?: LocalProtocolOptions;
	/**
	 * Parent session's ArtifactManager. Subagent adopts it so artifact IDs are
	 * unique across the whole agent tree and all artifacts land in the parent's
	 * artifacts directory (no per-subagent subdir).
	 */
	parentArtifactManager?: ArtifactManager;
	parentHindsightSessionState?: HindsightSessionState;
	/**
	 * Parent agent's OpenTelemetry configuration. When defined, the subagent's
	 * loop is started with the same tracer/hooks but its own agent identity
	 * stamped, so its `invoke_agent` / `chat` / `execute_tool` spans appear as
	 * a sub-tree under the parent's active `execute_tool task` span. A
	 * `handoff` span is emitted on dispatch to mark the parent → subagent
	 * transition explicitly.
	 */
	parentTelemetry?: AgentTelemetryConfig;
	/** Skills to autoload via sendCustomMessage before the first prompt */
	autoloadSkills?: Skill[];
	forkContextSeed?: ForkContextSeed;
}

function parseStringifiedJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

interface OutputValidator {
	validate: (value: unknown) => { ok: true } | { ok: false; message: string; missingRequired: string[] };
	requiredFields: string[];
}

function buildOutputValidator(schema: unknown): { validator?: OutputValidator; error?: string } {
	const { normalized, error } = normalizeSchema(schema);
	if (error) return { error };
	if (normalized === undefined) return {};
	const jsonSchema = jtdToJsonSchema(normalized);
	const required = extractRequiredFields(jsonSchema);
	return {
		validator: {
			requiredFields: required,
			validate: value => {
				const result = validateJsonSchemaValue(jsonSchema, value);
				if (result.success) return { ok: true };
				const missing = computeMissingRequired(required, value);
				const message = formatValidationIssue(result.issues[0]) ?? "schema validation failed";
				return { ok: false, message, missingRequired: missing };
			},
		},
	};
}

function extractRequiredFields(jsonSchema: unknown): string[] {
	if (!jsonSchema || typeof jsonSchema !== "object") return [];
	const required = (jsonSchema as { required?: unknown }).required;
	return Array.isArray(required) ? required.filter((k): k is string => typeof k === "string") : [];
}

function computeMissingRequired(required: readonly string[], value: unknown): string[] {
	if (required.length === 0) return [];
	if (value === null || value === undefined) return [...required];
	if (typeof value !== "object" || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	return required.filter(key => !(key in record) || record[key] === undefined);
}

function formatValidationIssue(issue: JsonSchemaValidationIssue | undefined): string | undefined {
	if (!issue) return undefined;
	const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
	return `${path}: ${issue.message}`;
}

function previewOffendingData(value: unknown, maxLength = 500): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "null";
	} catch {
		serialized = String(value);
	}
	return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
}

function tryParseJsonOutput(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function extractCompletionData(parsed: unknown): unknown {
	if (!parsed || typeof parsed !== "object") return parsed;
	const record = parsed as Record<string, unknown>;
	if ("data" in record) {
		return record.data;
	}
	return parsed;
}

function normalizeCompleteData(data: unknown, reportFindings?: ReviewFinding[]): unknown {
	let normalized = parseStringifiedJson(data ?? null);
	if (
		Array.isArray(reportFindings) &&
		reportFindings.length > 0 &&
		normalized &&
		typeof normalized === "object" &&
		!Array.isArray(normalized)
	) {
		const record = normalized as Record<string, unknown>;
		if (!("findings" in record)) {
			normalized = { ...record, findings: reportFindings };
		}
	}
	return normalized;
}

function resolveFallbackCompletion(rawOutput: string, outputSchema: unknown): { data: unknown } | null {
	const parsed = tryParseJsonOutput(rawOutput);
	if (parsed === undefined) return null;
	const candidate = parseStringifiedJson(extractCompletionData(parsed));
	if (candidate === undefined) return null;
	const { validator, error } = buildOutputValidator(outputSchema);
	if (error) return null;
	if (validator && !validator.validate(candidate).ok) return null;
	return { data: candidate };
}

export interface YieldItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;
}

interface FinalizeSubprocessOutputArgs {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	doneAborted: boolean;
	signalAborted: boolean;
	yieldItems?: YieldItem[];
	reportFindings?: ReviewFinding[];
	outputSchema: unknown;
}

interface FinalizeSubprocessOutputResult {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	abortedViaYield: boolean;
	hasYield: boolean;
}

export const SUBAGENT_WARNING_NULL_YIELD = "SYSTEM WARNING: Subagent called yield with null data.";
export const SUBAGENT_WARNING_MISSING_YIELD =
	"SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.";

/** Build a schema_violation outcome — surfaced as a non-zero exit so callers treat it as a failure. */
function buildSchemaViolationOutcome(
	failure: { message: string; missingRequired: string[] },
	data: unknown,
): { rawOutput: string; stderr: string; exitCode: number } {
	const missing = failure.missingRequired;
	const headline =
		missing.length > 0
			? `schema_violation: missing required fields: ${missing.join(", ")}`
			: `schema_violation: ${failure.message}`;
	const payload = {
		error: "schema_violation",
		message: failure.message,
		missingRequired: missing,
		data: previewOffendingData(data),
	};
	let rawOutput: string;
	try {
		rawOutput = JSON.stringify(payload, null, 2);
	} catch {
		rawOutput = `{"error":"schema_violation","message":${JSON.stringify(headline)}}`;
	}
	return { rawOutput, stderr: headline, exitCode: 1 };
}

export function finalizeSubprocessOutput(args: FinalizeSubprocessOutputArgs): FinalizeSubprocessOutputResult {
	let { rawOutput, exitCode, stderr } = args;
	const { yieldItems, reportFindings, doneAborted, signalAborted, outputSchema } = args;
	let abortedViaYield = false;
	const hasYield = Array.isArray(yieldItems) && yieldItems.length > 0;

	if (hasYield) {
		const lastYield = yieldItems[yieldItems.length - 1];
		if (lastYield?.status === "aborted") {
			abortedViaYield = true;
			exitCode = 0;
			stderr = lastYield.error || "Subagent aborted task";
			try {
				rawOutput = JSON.stringify({ aborted: true, error: lastYield.error }, null, 2);
			} catch {
				rawOutput = `{"aborted":true,"error":"${lastYield.error || "Unknown error"}"}`;
			}
		} else {
			const submitData = lastYield?.data;
			if (submitData === null || submitData === undefined) {
				rawOutput = rawOutput ? `${SUBAGENT_WARNING_NULL_YIELD}\n\n${rawOutput}` : SUBAGENT_WARNING_NULL_YIELD;
			} else {
				const completeData = normalizeCompleteData(submitData, reportFindings);
				const { validator, error: schemaError } = buildOutputValidator(outputSchema);
				if (schemaError) {
					rawOutput = `{"error":"schema_violation","message":"invalid output schema: ${schemaError.replace(/"/g, '\\"')}"}`;
					stderr = `schema_violation: invalid output schema: ${schemaError}`;
					exitCode = 1;
				} else {
					const verdict = validator ? validator.validate(completeData) : { ok: true as const };
					if (!verdict.ok) {
						const outcome = buildSchemaViolationOutcome(verdict, completeData);
						rawOutput = outcome.rawOutput;
						stderr = outcome.stderr;
						exitCode = outcome.exitCode;
					} else {
						try {
							rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
						} catch (err) {
							const errorMessage = err instanceof Error ? err.message : String(err);
							rawOutput = `{"error":"Failed to serialize yield data: ${errorMessage}"}`;
						}
						exitCode = 0;
						stderr = "";
					}
				}
			}
		}
	} else {
		const allowFallback = exitCode === 0 && !doneAborted && !signalAborted;
		const { normalized: normalizedSchema, error: schemaError } = normalizeSchema(outputSchema);
		const hasOutputSchema = normalizedSchema !== undefined && !schemaError;
		const fallback = allowFallback ? resolveFallbackCompletion(rawOutput, outputSchema) : null;
		if (fallback) {
			const completeData = normalizeCompleteData(fallback.data, reportFindings);
			const { validator } = buildOutputValidator(outputSchema);
			const verdict = validator ? validator.validate(completeData) : { ok: true as const };
			if (!verdict.ok) {
				const outcome = buildSchemaViolationOutcome(verdict, completeData);
				rawOutput = outcome.rawOutput;
				stderr = outcome.stderr;
				exitCode = outcome.exitCode;
			} else {
				try {
					rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
				} catch (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					rawOutput = `{"error":"Failed to serialize fallback completion: ${errorMessage}"}`;
				}
				exitCode = 0;
				stderr = "";
			}
		} else if (!hasOutputSchema && allowFallback && rawOutput.trim().length > 0) {
			exitCode = 0;
			stderr = "";
		} else if (exitCode === 0) {
			const hasRawOutput = rawOutput.trim().length > 0;
			rawOutput = rawOutput ? `${SUBAGENT_WARNING_MISSING_YIELD}\n\n${rawOutput}` : SUBAGENT_WARNING_MISSING_YIELD;
			if (hasOutputSchema || !hasRawOutput) {
				exitCode = 1;
				stderr = SUBAGENT_WARNING_MISSING_YIELD;
			}
		}
	}

	return { rawOutput, exitCode, stderr, abortedViaYield, hasYield };
}

/**
 * Extract a short preview from tool args for display.
 */
function extractToolArgsPreview(args: Record<string, unknown>): string {
	// Priority order for preview
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 59)}…` : value;
		}
	}

	return "";
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = getNumberField(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Tokens for progress display: input + output + cacheWrite per turn.
 *
 * Deliberately excludes cacheRead. With prompt caching, cacheRead in each turn
 * equals the full cached context (potentially hundreds of KB), so summing it
 * across all turns produces a cumulative total that is N×context_size — far
 * larger than the context window and misleading as a "work done" metric.
 * cacheWrite is kept because each byte is written once, not repeated per turn.
 * The cost segment handles billing; dedicated cache_read/cache_write segments
 * handle cache-specific monitoring.
 */
function getUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;

	const input = firstNumberField(record, ["input", "input_tokens", "inputTokens"]) ?? 0;
	const output = firstNumberField(record, ["output", "output_tokens", "outputTokens"]) ?? 0;
	const cacheWrite = firstNumberField(record, ["cacheWrite", "cache_write", "cacheWriteTokens"]) ?? 0;
	const computed = input + output + cacheWrite;
	if (computed > 0) return computed;
	// Fallback for providers that only surface a pre-summed total without individual
	// field breakdown. This total includes cacheRead, but returning it is still better
	// than silently showing 0 for those providers.
	return firstNumberField(record, ["totalTokens", "total_tokens"]) ?? 0;
}

export function createSubagentSettings(baseSettings: Settings, inheritedServiceTier?: ServiceTier): Settings {
	const snapshot: Partial<Record<SettingPath, unknown>> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		snapshot[key] = baseSettings.get(key);
	}
	// Subagent-scoped service-tier override: "inherit" uses the parent session's
	// LIVE intent (so a runtime `/fast on` reaches subagents and a main-model
	// fast-mode auto-disable never clobbers it); any explicit value applies only
	// to subagent sessions and wins over inherited intent.
	const taskServiceTier = baseSettings.get("task.serviceTier");
	if (taskServiceTier === "inherit") {
		snapshot.serviceTier = inheritedServiceTier ?? "none";
	} else {
		snapshot.serviceTier = taskServiceTier;
	}
	return Settings.isolated({
		...snapshot,
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
	});
}

/**
 * Run a single agent in-process.
 */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const {
		cwd,
		agent,
		task,
		assignment,
		index,
		id,
		worktree,
		modelOverride,
		thinkingLevel,
		outputSchema,
		enableLsp,
		signal,
		onProgress,
	} = options;
	const startTime = Date.now();

	// Initialize progress
	const progress: AgentProgress = {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		status: "running",
		task,
		assignment,
		description: options.description,
		lastIntent: undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		modelOverride,
	};

	// Check if already aborted
	if (signal?.aborted) {
		return {
			index,
			id,
			agent: agent.name,
			agentSource: agent.source,
			task,
			assignment,
			description: options.description,
			exitCode: 1,
			output: "",
			stderr: "Cancelled before start",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			modelOverride,
			error: "Cancelled before start",
			aborted: true,
			abortReason: "Cancelled before start",
		};
	}

	// Set up artifact paths and write input file upfront if artifacts dir provided
	let subtaskSessionFile: string | undefined = options.sessionFile ?? undefined;
	if (!subtaskSessionFile && options.artifactsDir) {
		subtaskSessionFile = path.join(options.artifactsDir, `${id}.jsonl`);
	}

	const settings = options.settings ?? Settings.isolated();
	const subagentSettings = createSubagentSettings(settings, options.inheritedServiceTier);
	const maxRecursionDepth = settings.get("task.maxRecursionDepth") ?? 2;
	const maxRuntimeMs = Math.max(0, Math.trunc(Number(settings.get("task.maxRuntimeMs") ?? 0) || 0));
	const parentDepth = options.taskDepth ?? 0;
	const childDepth = parentDepth + 1;
	const atMaxDepth = maxRecursionDepth >= 0 && childDepth >= maxRecursionDepth;

	// Add tools if specified
	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0) {
		toolNames = agent.tools;
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolNames.includes("task") && !atMaxDepth) {
			toolNames = [...toolNames, "task"];
		}
	}

	if (atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	if (toolNames?.includes("exec")) {
		const allowEvalPy = settings.get("eval.py") ?? true;
		const allowEvalJs = settings.get("eval.js") ?? true;
		const expanded = toolNames.filter(name => name !== "exec");
		if (allowEvalPy || allowEvalJs) expanded.push("eval");
		expanded.push("bash");
		toolNames = Array.from(new Set(expanded));
	}

	const modelPatterns = normalizeModelPatterns(modelOverride ?? agent.model);
	const sessionFile = subtaskSessionFile ?? null;
	const spawnsEnv = atMaxDepth
		? ""
		: agent.spawns === undefined
			? ""
			: agent.spawns === "*"
				? "*"
				: agent.spawns.join(",");

	const lspEnabled = enableLsp ?? true;
	const ircEnabled = options.ircAvailable === true;
	const contextFileForPrompt = ircEnabled ? undefined : options.contextFile;
	const skipPythonPreflight = Array.isArray(toolNames) && !toolNames.includes("eval");

	const outputChunks: string[] = [];
	const finalOutputChunks: string[] = [];
	const RECENT_OUTPUT_TAIL_BYTES = 8 * 1024;
	let recentOutputTail = "";
	let stderr = "";
	let resolved = false;
	type AbortReason = "signal" | "terminate" | "timeout";
	let abortSent = false;
	let abortReason: AbortReason | undefined;
	let runtimeLimitExceeded = false;
	const listenerController = new AbortController();
	const listenerSignal = listenerController.signal;
	const abortController = new AbortController();
	const abortSignal = abortController.signal;
	let activeSession: AgentSession | null = null;
	let unsubscribe: (() => void) | null = null;
	let yieldCalled = false;
	let pauseRequested = false;
	let paused = false;
	let modelSubstitutionWarning: ModelSubstitutionWarning | undefined;
	let resolvedModelString: string | undefined;
	let lastAssistantModelString: string | undefined;
	let effectiveThinkingLevelForWarning: ThinkingLevel | undefined;

	// Accumulate usage incrementally from message_end events (no memory for streaming events)
	const accumulatedUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let hasUsage = false;

	const requestAbort = (reason: AbortReason) => {
		if (reason === "timeout") {
			runtimeLimitExceeded = true;
		}
		if (abortSent) {
			if (reason === "signal" && abortReason !== "signal" && abortReason !== "timeout") {
				abortReason = "signal";
			}
			return;
		}
		if (resolved) return;
		abortSent = true;
		abortReason = reason;
		abortController.abort();
		if (activeSession) {
			void activeSession.abort();
		}
	};

	// Handle abort signal
	const onAbort = () => {
		if (!resolved) requestAbort("signal");
	};
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true, signal: listenerSignal });
	}

	// Wall-clock hard limit. Defense-in-depth for the case where a provider stream
	// hang escapes the inference-layer watchdog (see openai-completions
	// `isOpenAICompletionsProgressChunk`). Disabled by default; set
	// `task.maxRuntimeMs > 0` to cap each subagent's lifetime.
	let runtimeTimeoutId: NodeJS.Timeout | undefined;
	if (maxRuntimeMs > 0) {
		runtimeTimeoutId = setTimeout(() => {
			if (!resolved) {
				logger.warn("Subagent runtime limit exceeded; aborting", {
					id,
					agent: agent.name,
					maxRuntimeMs,
				});
				requestAbort("timeout");
			}
		}, maxRuntimeMs);
	}

	const resolveSignalAbortReason = (): string => {
		const reason = signal?.reason;
		if (reason instanceof Error) {
			const message = reason.message.trim();
			if (message.length > 0) return message;
		} else if (typeof reason === "string") {
			const message = reason.trim();
			if (message.length > 0) return message;
		}
		return "Cancelled by caller";
	};
	const resolveAbortReasonText = (): string => {
		if (runtimeLimitExceeded) {
			return `Subagent runtime limit exceeded (task.maxRuntimeMs=${maxRuntimeMs})`;
		}
		return resolveSignalAbortReason();
	};
	const PROGRESS_COALESCE_MS = 150;
	let lastProgressEmitMs = 0;
	let progressTimeoutId: NodeJS.Timeout | null = null;

	const emitProgressNow = () => {
		progress.durationMs = Date.now() - startTime;
		onProgress?.({ ...progress });
		if (options.eventBus) {
			options.eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				assignment,
				progress: { ...progress },
				sessionFile: subtaskSessionFile,
			});
		}
		lastProgressEmitMs = Date.now();
	};

	const scheduleProgress = (flush = false) => {
		if (flush) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		const now = Date.now();
		const elapsed = now - lastProgressEmitMs;
		if (lastProgressEmitMs === 0 || elapsed >= PROGRESS_COALESCE_MS) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		if (progressTimeoutId) return;
		progressTimeoutId = setTimeout(() => {
			progressTimeoutId = null;
			emitProgressNow();
		}, PROGRESS_COALESCE_MS - elapsed);
	};

	const getMessageContent = (message: unknown): unknown => {
		if (message && typeof message === "object" && "content" in message) {
			return (message as { content?: unknown }).content;
		}
		return undefined;
	};

	const getMessageUsage = (message: unknown): unknown => {
		if (message && typeof message === "object" && "usage" in message) {
			return (message as { usage?: unknown }).usage;
		}
		return undefined;
	};

	const getMessageModelString = (message: unknown): string | undefined => {
		if (!message || typeof message !== "object") return undefined;
		const record = message as { provider?: unknown; model?: unknown };
		return typeof record.provider === "string" && typeof record.model === "string"
			? `${record.provider}/${record.model}`
			: undefined;
	};

	const updateRecentOutputLines = () => {
		const lines = recentOutputTail.split("\n").filter(line => line.trim());
		progress.recentOutput = lines.slice(-8).reverse();
	};

	const appendRecentOutputTail = (text: string) => {
		if (!text) return;
		recentOutputTail += text;
		if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
			recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
		}
		updateRecentOutputLines();
	};

	const replaceRecentOutputFromContent = (content: unknown[]) => {
		recentOutputTail = "";
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as { type?: unknown; text?: unknown };
			if (record.type !== "text" || typeof record.text !== "string") continue;
			if (!record.text) continue;
			recentOutputTail += record.text;
			if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
				recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
			}
		}
		updateRecentOutputLines();
	};

	const resetRecentOutput = () => {
		recentOutputTail = "";
		progress.recentOutput = [];
	};

	const processEvent = (event: AgentEvent) => {
		if (resolved) return;

		if (options.eventBus) {
			options.eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				assignment,
				event,
			});
		}

		const now = Date.now();
		let flushProgress = false;

		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") {
					resetRecentOutput();
				}
				break;

			case "tool_execution_start": {
				progress.toolCount++;
				progress.currentTool = event.toolName;
				progress.currentToolArgs = extractToolArgsPreview(
					(event as { toolArgs?: Record<string, unknown> }).toolArgs || event.args || {},
				);
				progress.currentToolStartMs = now;
				const intent = event.intent?.trim();
				if (intent) {
					progress.lastIntent = intent;
				}
				// Reset any prior in-flight task snapshot so we don't show stale
				// nested progress when the agent enters a fresh `task` call.
				if (event.toolName === "task") {
					progress.inflightTaskDetails = undefined;
				}
				break;
			}

			case "tool_execution_end": {
				if (progress.currentTool) {
					progress.recentTools.unshift({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
					// Keep only last 5
					if (progress.recentTools.length > 5) {
						progress.recentTools.pop();
					}
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartMs = undefined;
				// The finalized TaskToolDetails will be captured below into
				// `extractedToolData.task`; drop the in-flight snapshot so the
				// renderer doesn't double-count it against the final entry.
				if (event.toolName === "task") {
					progress.inflightTaskDetails = undefined;
				}

				// Check for registered subagent tool handler
				const handler = subprocessToolRegistry.getHandler(event.toolName);
				const eventArgs = (event as { args?: Record<string, unknown> }).args ?? {};
				if (handler) {
					// Extract data using handler
					if (handler.extractData) {
						const data = handler.extractData({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						});
						if (data !== undefined) {
							progress.extractedToolData = progress.extractedToolData || {};
							const existing = progress.extractedToolData[event.toolName] || [];
							const findingKey = event.toolName === "report_finding" ? getReportFindingKey(data) : null;
							if (findingKey) {
								const existingIndex = existing.findIndex(item => getReportFindingKey(item) === findingKey);
								if (existingIndex >= 0) {
									existing[existingIndex] = data;
								} else {
									existing.push(data);
								}
							} else {
								existing.push(data);
							}
							progress.extractedToolData[event.toolName] = existing;
							if (event.toolName === "yield") {
								yieldCalled = true;
							}
						}
					}

					// Check if handler wants to terminate the session
					if (
						handler.shouldTerminate?.({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						})
					) {
						requestAbort("terminate");
					}
				}
				flushProgress = true;
				break;
			}

			case "tool_execution_update": {
				// Surface nested-subagent progress mid-flight. The child task
				// tool emits incremental `onUpdate` calls carrying its current
				// `TaskToolDetails` (results + progress); we stash the latest
				// snapshot so the parent UI can render the in-flight subtree
				// without waiting for the call to finish.
				if (event.toolName === "task") {
					const partial = (event as { partialResult?: { details?: unknown } }).partialResult;
					const details = partial && typeof partial === "object" ? partial.details : undefined;
					if (details && typeof details === "object" && "results" in (details as TaskToolDetails)) {
						progress.inflightTaskDetails = details as TaskToolDetails;
						flushProgress = true;
					}
				}
				break;
			}

			case "message_update": {
				if (event.message?.role !== "assistant") break;
				const assistantEvent = (
					event as AgentEvent & {
						assistantMessageEvent?: { type?: string; delta?: string };
					}
				).assistantMessageEvent;
				if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
					appendRecentOutputTail(assistantEvent.delta);
					break;
				}
				if (assistantEvent && assistantEvent.type !== "text_delta") {
					break;
				}
				const updateContent =
					getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
				if (updateContent && Array.isArray(updateContent)) {
					replaceRecentOutputFromContent(updateContent);
				}
				break;
			}

			case "message_end": {
				// Extract text from assistant and toolResult messages (not user prompts)
				const role = event.message?.role;
				if (role === "assistant") {
					const messageContent =
						getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
					if (messageContent && Array.isArray(messageContent)) {
						for (const block of messageContent) {
							if (block.type === "text" && block.text) {
								outputChunks.push(block.text);
							}
						}
					}
					const assistantModel = getMessageModelString(event.message);
					if (assistantModel) {
						lastAssistantModelString = assistantModel;
						if (resolvedModelString && assistantModel !== resolvedModelString && !modelSubstitutionWarning) {
							modelSubstitutionWarning = {
								requested: resolvedModelString,
								effective: assistantModel,
								reason: "assistant_model_mismatch",
							};
							progress.modelSubstitutionWarning = modelSubstitutionWarning;
							activeSession?.sessionManager.appendModelChange(assistantModel, undefined, {
								previousModel: resolvedModelString,
								reason: modelSubstitutionWarning.reason,
								thinkingLevel: effectiveThinkingLevelForWarning ?? null,
							});
							logger.warn("Subagent assistant response reported a substituted effective model", {
								requested: resolvedModelString,
								effective: assistantModel,
								agent: agent.name,
								id,
							});
						}
					}
				}
				// Extract and accumulate usage (prefer message.usage, fallback to event.usage)
				const messageUsage = getMessageUsage(event.message) || (event as AgentEvent & { usage?: unknown }).usage;
				if (messageUsage && typeof messageUsage === "object") {
					// Only count assistant messages (not tool results, etc.)
					if (role === "assistant") {
						const usageRecord = messageUsage as Record<string, unknown>;
						const costRecord = (messageUsage as { cost?: Record<string, unknown> }).cost;
						hasUsage = true;
						accumulatedUsage.input += getNumberField(usageRecord, "input") ?? 0;
						accumulatedUsage.output += getNumberField(usageRecord, "output") ?? 0;
						accumulatedUsage.cacheRead += getNumberField(usageRecord, "cacheRead") ?? 0;
						accumulatedUsage.cacheWrite += getNumberField(usageRecord, "cacheWrite") ?? 0;
						accumulatedUsage.totalTokens += getNumberField(usageRecord, "totalTokens") ?? 0;
						if (costRecord) {
							accumulatedUsage.cost.input += getNumberField(costRecord, "input") ?? 0;
							accumulatedUsage.cost.output += getNumberField(costRecord, "output") ?? 0;
							accumulatedUsage.cost.cacheRead += getNumberField(costRecord, "cacheRead") ?? 0;
							accumulatedUsage.cost.cacheWrite += getNumberField(costRecord, "cacheWrite") ?? 0;
							accumulatedUsage.cost.total += getNumberField(costRecord, "total") ?? 0;
							progress.cost = accumulatedUsage.cost.total;
						}
					}
					// Accumulate tokens for progress display
					progress.tokens += getUsageTokens(messageUsage);
					// Track latest per-turn context size so the UI can show
					// "current context", not just cumulative billing volume.
					if (role === "assistant") {
						const perTurnTotal = getNumberField(messageUsage as Record<string, unknown>, "totalTokens");
						if (perTurnTotal !== undefined && perTurnTotal > 0) {
							progress.contextTokens = perTurnTotal;
						}
					}
				}
				break;
			}

			case "agent_end":
				// Extract final content from assistant messages only (not user prompts)
				if (event.messages && Array.isArray(event.messages)) {
					for (const msg of event.messages) {
						if ((msg as { role?: string })?.role !== "assistant") continue;
						const messageContent = getMessageContent(msg);
						if (messageContent && Array.isArray(messageContent)) {
							for (const block of messageContent) {
								if (block.type === "text" && block.text) {
									finalOutputChunks.push(block.text);
								}
							}
						}
					}
				}
				paused = (event as { stopReason?: string }).stopReason === "paused";
				flushProgress = true;
				break;
		}

		scheduleProgress(flushProgress);
	};

	const runSubagent = async (): Promise<{
		exitCode: number;
		error?: string;
		aborted?: boolean;
		abortReason?: string;
		durationMs: number;
	}> => {
		const sessionAbortController = new AbortController();
		let exitCode = 0;
		let error: string | undefined;
		let aborted = false;
		let abortReasonText: string | undefined;
		const checkAbort = () => {
			if (abortSignal.aborted) {
				aborted = abortReason === "signal" || runtimeLimitExceeded || abortReason === undefined;
				if (aborted) {
					abortReasonText ??= resolveAbortReasonText();
				}
				exitCode = 1;
				throw new ToolAbortError();
			}
		};
		const awaitAbortable = async <T>(promise: Promise<T>): Promise<T> => {
			checkAbort();
			const { promise: abortPromise, reject } = Promise.withResolvers<never>();
			const onAbort = () => {
				try {
					checkAbort();
				} catch (err) {
					reject(err);
				}
			};
			abortSignal.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.race([promise, abortPromise]);
			} finally {
				abortSignal.removeEventListener("abort", onAbort);
			}
		};

		try {
			checkAbort();
			// Pin authStorage to modelRegistry.authStorage — mirrors the createAgentSession invariant.
			const registryFromParent = options.modelRegistry !== undefined;
			const modelRegistry =
				options.modelRegistry ??
				new ModelRegistry(options.authStorage ?? (await awaitAbortable(discoverAuthStorage())));
			const authStorage = modelRegistry.authStorage;
			if (options.authStorage && options.authStorage !== authStorage) {
				throw new Error(
					"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
				);
			}
			checkAbort();
			if (!registryFromParent) {
				await awaitAbortable(modelRegistry.refresh());
			} else {
				logger.debug("runSubagent: reusing parent modelRegistry; skipping refresh");
			}
			checkAbort();

			const {
				model,
				thinkingLevel: resolvedThinkingLevel,
				explicitThinkingLevel,
				authFallbackUsed,
				requestedModel,
				fallbackReason,
			} = await awaitAbortable(
				resolveModelOverrideWithAuthFallback(
					modelPatterns,
					options.parentActiveModelPattern,
					modelRegistry,
					settings,
					options.parentSessionId,
				),
			);
			if (model) {
				resolvedModelString = formatModelString(model);
			}
			if (authFallbackUsed && model && requestedModel) {
				modelSubstitutionWarning = {
					requested: formatModelString(requestedModel),
					effective: formatModelString(model),
					reason: fallbackReason ?? "auth_unavailable",
				};
				progress.modelSubstitutionWarning = modelSubstitutionWarning;
				logger.warn("Subagent model has no working credentials; falling back to parent session model", {
					requested: modelSubstitutionWarning.requested,
					parentModel: options.parentActiveModelPattern,
					resolvedProvider: model.provider,
					resolvedModel: model.id,
				});
			}
			// Record which model the subagent actually runs on (and any auth fallback,
			// see #985) so the subagent panel can surface it to the user.
			if (model) {
				AsyncJobManager.instance()?.updateSubagentModel?.(options.subagentId ?? id, {
					requestedModel: modelSubstitutionWarning?.requested ?? resolvedModelString,
					effectiveModel: resolvedModelString,
					modelFellBack: authFallbackUsed === true,
				});
			}
			if (model?.contextWindow && model.contextWindow > 0) {
				progress.contextWindow = model.contextWindow;
			}
			const effectiveThinkingLevel = explicitThinkingLevel
				? resolvedThinkingLevel
				: (thinkingLevel ?? resolvedThinkingLevel);
			effectiveThinkingLevelForWarning = effectiveThinkingLevel;

			const sessionManager = sessionFile
				? await awaitAbortable(SessionManager.open(sessionFile))
				: SessionManager.inMemory(worktree ?? cwd);
			if (options.parentArtifactManager) {
				sessionManager.adoptArtifactManager(options.parentArtifactManager);
			}

			// Subagents do not inherit or discover MCP runtime tools in the GJC surface.
			const enableMCP = false;

			// Derive subagent-scoped telemetry from the parent's config so the
			// child loop's spans nest under the parent's active execute_tool span
			// (OTEL context propagation handles parent linkage automatically),
			// carry the subagent's own agent identity, and use the subagent's
			// own session id for `gen_ai.conversation.id`.
			const subagentAgentIdentity: AgentIdentity | undefined = options.parentTelemetry
				? { id, name: agent.name, description: agent.description }
				: undefined;
			const subagentTelemetry: AgentTelemetryConfig | undefined =
				options.parentTelemetry && subagentAgentIdentity
					? {
							...options.parentTelemetry,
							agent: subagentAgentIdentity,
							// Clear parent's conversationId; the child loop falls back to
							// its own AgentLoopConfig.sessionId.
							conversationId: undefined,
						}
					: undefined;

			if (options.parentTelemetry && subagentAgentIdentity) {
				const parentTelemetryHandle = resolveTelemetry(
					options.parentTelemetry,
					options.parentTelemetry.conversationId,
				);
				recordHandoff(parentTelemetryHandle, {
					fromAgent: options.parentTelemetry.agent,
					toAgent: subagentAgentIdentity,
				});
			}

			const { normalized: normalizedOutputSchema } = normalizeSchema(outputSchema);

			const forkContextNotice = options.forkContextSeed
				? `This subagent was started with a forked snapshot of the parent conversation. Included ${options.forkContextSeed.metadata.includedMessages} message(s), skipped ${options.forkContextSeed.metadata.skippedMessages}, approximately ${options.forkContextSeed.metadata.approximateTokens} tokens. The snapshot is not live.${ircEnabled ? " Use IRC for live coordination." : " Rely on the explicit assignment and supplied context for coordination."}`
				: "";

			const agentSubskillBlock = await buildAgentSubskillInjection({
				cwd,
				sessionId: options.parentSessionId,
				agentName: agent.name,
			});

			let agentPromptAdditions = { appendix: "", advertisement: "" };
			try {
				agentPromptAdditions = await renderAgentPromptAdditions({ cwd, agentName: agent.name });
			} catch (error) {
				logger.warn("Failed to render GJC plugin agent prompt additions", { error });
			}

			const { session } = await awaitAbortable(
				createAgentSession({
					cwd: worktree ?? cwd,
					authStorage,
					modelRegistry,
					settings: subagentSettings,
					model,
					thinkingLevel: effectiveThinkingLevel,
					modelSubstitution:
						modelSubstitutionWarning?.reason === "auth_unavailable" && requestedModel
							? { requestedModel, reason: modelSubstitutionWarning.reason }
							: undefined,
					toolNames,
					outputSchema,
					requireYieldTool: true,
					contextFiles: options.contextFiles,
					skills: options.skills,
					promptTemplates: options.promptTemplates,
					workspaceTree: options.workspaceTree,
					systemPrompt: defaultPrompt => {
						const subagentPrompt = prompt.render(subagentSystemPromptTemplate, {
							agent: agent.systemPrompt,
							context: options.context?.trim() ?? "",
							worktree: worktree ?? "",
							outputSchema: normalizedOutputSchema,
							contextFile: contextFileForPrompt,
							ircPeers: ircEnabled ? renderIrcPeerRoster(id) : "",
							ircSelfId: ircEnabled ? id : "",
							forkContext: forkContextNotice,
						});
						// Order: base agent prompt -> agent appendix -> Tier-1 advertisement -> Tier-2 body.
						const appendixPart = agentPromptAdditions.appendix ? `\n\n${agentPromptAdditions.appendix}` : "";
						const advertPart = agentPromptAdditions.advertisement
							? `\n\n${agentPromptAdditions.advertisement}`
							: "";
						const promptWithSubskills = `${subagentPrompt}${appendixPart}${advertPart}${agentSubskillBlock}`;
						return defaultPrompt.length === 0
							? [promptWithSubskills]
							: [...defaultPrompt.slice(0, -1), promptWithSubskills, defaultPrompt[defaultPrompt.length - 1]];
					},
					sessionManager,
					hasUI: false,
					spawns: spawnsEnv,
					taskDepth: childDepth,
					currentAgentType: agent.name,
					gjcSubskillToolContext: {
						cwd,
						sessionId: options.parentSessionId,
						parent: agent.name,
						phase: "prompt",
					},
					parentHindsightSessionState: options.parentHindsightSessionState,
					parentTaskPrefix: id,
					agentId: id,
					agentDisplayName: agent.name,
					bashAllowedPrefixes: agent.bashAllowedPrefixes,
					enableLsp: lspEnabled,
					skipPythonPreflight,
					enableMCP,
					localProtocolOptions: options.localProtocolOptions,
					telemetry: subagentTelemetry,
					forkContextSeed: options.forkContextSeed,
					shouldPause: () => pauseRequested,
				}),
			);

			activeSession = session;
			const liveSubagentId = options.subagentId ?? id;
			const manager = AsyncJobManager.instance();
			if (manager) {
				manager.registerLiveHandle(liveSubagentId, {
					requestPause: () => {
						pauseRequested = true;
					},
					injectMessage: async (content, deliverAs, opts) => {
						if (deliverAs === "nextTurn") {
							await session.prompt(content, { attribution: "agent" });
							return;
						}
						if (deliverAs === "steer") {
							const from = opts?.fromAgentId ?? manager.getSubagentRecord(liveSubagentId)?.ownerId ?? "?";
							session.emitSubagentSteerObservation({ from, to: liveSubagentId, body: content });
						}
						await session.sendUserMessage(content, { deliverAs });
					},
				});
			}

			// Emit lifecycle start event
			if (options.eventBus) {
				options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id,
					agent: agent.name,
					agentSource: agent.source,
					description: options.description,
					status: "started",
					sessionFile: subtaskSessionFile,
					index,
				});
			}

			const subagentToolNames = session.getActiveToolNames();
			const parentOwnedToolNames = new Set(["todo_write"]);
			const filteredSubagentTools = subagentToolNames.filter(name => !parentOwnedToolNames.has(name));
			if (filteredSubagentTools.length !== subagentToolNames.length) {
				await awaitAbortable(session.setActiveToolsByName(filteredSubagentTools));
			}

			session.sessionManager.appendSessionInit({
				systemPrompt: session.agent.state.systemPrompt.join("\n\n"),
				task,
				tools: session.getActiveToolNames(),
				outputSchema,
				forkContext: options.forkContextSeed?.metadata,
			});

			abortSignal.addEventListener(
				"abort",
				() => {
					void session.abort();
				},
				{ once: true, signal: sessionAbortController.signal },
			);
			// Defensive: if the wall-clock timer (or external signal) fired during
			// the awaited setup above, the listener registration races the dispatch
			// and may not observe the already-fired abort event. Mirror it manually.
			if (abortSignal.aborted) {
				void session.abort();
			}

			const extensionRunner = session.extensionRunner;
			const pendingExtensionMessages: Promise<void>[] = [];
			if (extensionRunner) {
				extensionRunner.initialize(
					{
						sendMessage: (message, options) => {
							const sendPromise = session.sendCustomMessage(message, options).catch(e => {
								logger.error("Extension sendMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
							pendingExtensionMessages.push(sendPromise);
						},
						sendUserMessage: (content, options) => {
							const sendPromise = session.sendUserMessage(content, options).catch(e => {
								logger.error("Extension sendUserMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
							pendingExtensionMessages.push(sendPromise);
						},
						appendEntry: (customType, data) => {
							session.sessionManager.appendCustomEntry(customType, data);
						},
						setLabel: (targetId, label) => {
							session.sessionManager.appendLabelChange(targetId, label);
						},
						getActiveTools: () => session.getActiveToolNames(),
						getAllTools: () => session.getAllToolNames(),
						setActiveTools: (toolNames: string[]) =>
							session.setActiveToolsByName(toolNames.filter(name => !parentOwnedToolNames.has(name))),
						getCommands: () => getSessionSlashCommands(session),
						setModel: model => runExtensionSetModel(session, model),
						getThinkingLevel: () => session.thinkingLevel,
						setThinkingLevel: level => session.setThinkingLevel(level),
						getSessionName: () => session.sessionManager.getSessionName(),
						setSessionName: async name => {
							await session.sessionManager.setSessionName(name, "user");
						},
					},
					{
						getModel: () => session.model,
						isIdle: () => !session.isStreaming,
						abort: () => session.abort(),
						hasPendingMessages: () => session.queuedMessageCount > 0,
						shutdown: () => {},
						getContextUsage: () => session.getContextUsage(),
						getSystemPrompt: () => session.systemPrompt,
						compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
					},
				);
				extensionRunner.onError(err => {
					logger.error("Extension error", { path: err.extensionPath, error: err.error });
				});
				await awaitAbortable(extensionRunner.emit({ type: "session_start" }));
				while (pendingExtensionMessages.length > 0) {
					await awaitAbortable(Promise.all(pendingExtensionMessages.splice(0)));
				}
			}

			const MAX_YIELD_RETRIES = 3;
			unsubscribe = session.subscribe(event => {
				if (event.type === "auto_retry_start") {
					progress.retryState = {
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						unbounded: event.unbounded,
						delayMs: event.delayMs,
						errorMessage: event.errorMessage,
						startedAtMs: Date.now(),
					};
					progress.retryFailure = undefined;
					scheduleProgress(true);
					return;
				}
				if (event.type === "auto_retry_end") {
					const attempt = progress.retryState?.attempt ?? event.attempt;
					progress.retryState = undefined;
					if (!event.success) {
						progress.retryFailure = {
							attempt,
							errorMessage: event.finalError ?? "Auto-retry failed",
						};
					}
					scheduleProgress(true);
					return;
				}
				if (isAgentEvent(event)) {
					try {
						processEvent(event);
					} catch (err) {
						logger.error("Subagent event processing failed", {
							error: err instanceof Error ? err.message : String(err),
						});
						requestAbort("terminate");
					}
				}
			});

			checkAbort();
			// Autoload skills via sendCustomMessage (same mechanic as /skill:<name>)
			if (options.autoloadSkills?.length) {
				for (const skill of options.autoloadSkills) {
					const { message } = await buildSkillPromptMessage(skill, "");
					await session.sendCustomMessage(
						{
							customType: SKILL_PROMPT_MESSAGE_TYPE,
							content: message,
							display: false,
							details: { name: skill.name, path: skill.filePath },
						},
						{ triggerTurn: false },
					);
				}
			}
			const runMode = options.runMode ?? "initial";
			if (runMode === "message") {
				await awaitAbortable(session.prompt(options.resumeMessage ?? "", { attribution: "agent" }));
				await awaitAbortable(session.waitForIdle());
			} else if (runMode === "resume") {
				await awaitAbortable(
					session.prompt("Continue from the paused subagent session state.", { attribution: "agent" }),
				);
				await awaitAbortable(session.waitForIdle());
			} else {
				await awaitAbortable(session.prompt(task, { attribution: "agent" }));
				await awaitAbortable(session.waitForIdle());
			}

			const reminderToolChoiceResult = buildNamedToolChoiceResult("yield", session.model);

			let retryCount = 0;
			while (!paused && !yieldCalled && retryCount < MAX_YIELD_RETRIES && !abortSignal.aborted) {
				// Skip reminders when the model returned a terminal error (e.g.
				// rate-limit cap hit, auth failure). Re-prompting would just
				// hit the same wall, multiplying the failure noise without
				// any chance of producing a yield.
				const lastBeforeReminder = session.getLastAssistantMessage();
				if (lastBeforeReminder?.stopReason === "error") break;
				try {
					retryCount++;
					const reminder = prompt.render(submitReminderTemplate, {
						retryCount,
						maxRetries: MAX_YIELD_RETRIES,
					});

					const isFinalRetry = retryCount >= MAX_YIELD_RETRIES;
					await awaitAbortable(
						session.prompt(reminder, {
							attribution: "agent",
							...(isFinalRetry && reminderToolChoiceResult.exactNamed && reminderToolChoiceResult.choice
								? { toolChoice: reminderToolChoiceResult.choice }
								: {}),
						}),
					);
					await awaitAbortable(session.waitForIdle());
				} catch (err) {
					// An abort (parent cancel, session shutdown, timeout) rejects
					// awaitAbortable with ToolAbortError — a cancellation, not a prompt
					// failure. Mirror the outer catch's `!abortSignal.aborted` guard so
					// expected cancellations aren't logged at error level.
					if (abortSignal.aborted || err instanceof ToolAbortError) break;
					logger.error("Subagent prompt failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			await awaitAbortable(session.waitForIdle());
			if (!paused && !yieldCalled && !abortSignal.aborted) {
				exitCode = 0;
			}

			const lastAssistant = session.getLastAssistantMessage();
			if (lastAssistant) {
				if (lastAssistant.stopReason === "aborted") {
					aborted = abortReason === "signal" || runtimeLimitExceeded || abortReason === undefined;
					if (aborted) {
						abortReasonText ??= resolveAbortReasonText();
					}
					exitCode = 1;
				} else if (lastAssistant.stopReason === "error") {
					exitCode = 1;
					error ??= lastAssistant.errorMessage || "Subagent failed";
				}
				if (paused) {
					exitCode = 0;
					error = undefined;
				}
			}
			if (lastAssistantModelString && resolvedModelString && lastAssistantModelString !== resolvedModelString) {
				modelSubstitutionWarning ??= {
					requested: resolvedModelString,
					effective: lastAssistantModelString,
					reason: "assistant_model_mismatch",
				};
				progress.modelSubstitutionWarning = modelSubstitutionWarning;
			}
		} catch (err) {
			exitCode = 1;
			if (!abortSignal.aborted) {
				error = err instanceof Error ? err.stack || err.message : String(err);
			}
		} finally {
			if (abortSignal.aborted) {
				aborted = abortReason === "signal" || runtimeLimitExceeded || abortReason === undefined;
				if (aborted) {
					abortReasonText ??= resolveAbortReasonText();
				}
				if (exitCode === 0) exitCode = 1;
			}
			sessionAbortController.abort();
			AsyncJobManager.instance()?.removeLiveHandle(options.subagentId ?? id);
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// Ignore unsubscribe errors
				}
				unsubscribe = null;
			}
			if (activeSession) {
				const session = activeSession;
				activeSession = null;
				try {
					await untilAborted(AbortSignal.timeout(5000), () => session.dispose());
				} catch {
					// Ignore cleanup errors
				}
			}
		}

		return {
			exitCode,
			error,
			aborted,
			abortReason: aborted ? abortReasonText : undefined,
			durationMs: Date.now() - startTime,
		};
	};

	const done = await runSubagent();
	resolved = true;
	listenerController.abort();
	if (runtimeTimeoutId !== undefined) {
		clearTimeout(runtimeTimeoutId);
		runtimeTimeoutId = undefined;
	}

	if (progressTimeoutId) {
		clearTimeout(progressTimeoutId);
		progressTimeoutId = null;
	}

	let exitCode = done.exitCode;
	if (done.error) {
		stderr = done.error;
	}

	// Use final output if available, otherwise accumulated output
	let rawOutput = finalOutputChunks.length > 0 ? finalOutputChunks.join("") : outputChunks.join("");
	const yieldItems = progress.extractedToolData?.yield as YieldItem[] | undefined;
	const reportFindingDetails = progress.extractedToolData?.report_finding as ReportFindingDetails[] | undefined;
	const reportFindings: ReviewFinding[] | undefined = reportFindingDetails?.map(toReviewFinding);
	const finalized = finalizeSubprocessOutput({
		rawOutput,
		exitCode,
		stderr,
		doneAborted: Boolean(done.aborted),
		signalAborted: Boolean(signal?.aborted),
		yieldItems,
		reportFindings,
		outputSchema,
	});
	rawOutput = finalized.rawOutput;
	exitCode = finalized.exitCode;
	stderr = finalized.stderr;
	const lastYield = yieldItems?.[yieldItems.length - 1];
	const yieldAbortReason = lastYield?.status === "aborted" ? lastYield.error || "Subagent aborted task" : undefined;
	const { abortedViaYield, hasYield } = finalized;
	const { content: truncatedOutput, truncated } = truncateTail(rawOutput, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});

	// Write output artifact (input and jsonl already written in real-time)
	// Compute output metadata for agent:// URL integration
	let outputMeta: { lineCount: number; charCount: number; byteSize?: number; sha256?: string } | undefined;
	let outputPath: string | undefined;
	if (options.artifactsDir) {
		const candidateOutputPath = path.join(options.artifactsDir, `${id}.md`);
		try {
			await Bun.write(candidateOutputPath, rawOutput);
			const byteSize = Buffer.byteLength(rawOutput, "utf8");
			const lineCount = rawOutput.split("\n").length;
			const sha256 = createHash("sha256").update(rawOutput).digest("hex");
			const createdAt = new Date().toISOString();
			await Bun.write(
				`${candidateOutputPath}.meta.json`,
				JSON.stringify({ id, kind: "agent-output", sizeBytes: byteSize, lineCount, sha256, createdAt }, null, 2),
			);
			outputPath = candidateOutputPath;
			outputMeta = {
				lineCount,
				charCount: rawOutput.length,
				byteSize,
				sha256,
			};
		} catch {
			// Output or metadata write failed: never advertise an unverifiable
			// artifact. Best-effort remove any orphaned `.md`/sidecar so a later
			// agent:// read cannot serve unverified content. Non-fatal.
			outputPath = undefined;
			outputMeta = undefined;
			try {
				await fs.rm(candidateOutputPath, { force: true });
				await fs.rm(`${candidateOutputPath}.meta.json`, { force: true });
			} catch {
				// best-effort cleanup; ignore
			}
		}
	}

	// Update final progress. A wall-clock timeout always wins: if the runtime
	// limit fired we report aborted/failed regardless of whether a yield landed
	// while we were tearing the session down. The yield data is still surfaced
	// to the caller via `progress.extractedToolData`, but the exit status must
	// reflect the timeout so on-call doesn't mistake a stuck run for success.
	if (runtimeLimitExceeded && exitCode === 0) {
		exitCode = 1;
	}
	const wasAborted =
		runtimeLimitExceeded || abortedViaYield || (!hasYield && (done.aborted || signal?.aborted || false));
	const finalAbortReason = wasAborted
		? runtimeLimitExceeded
			? resolveAbortReasonText()
			: abortedViaYield
				? yieldAbortReason
				: (done.abortReason ?? (signal?.aborted ? resolveSignalAbortReason() : resolveAbortReasonText()))
		: undefined;
	progress.status = paused ? "paused" : wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	scheduleProgress(true);

	// Emit lifecycle end event after finalization so yield status is reflected
	if (options.eventBus) {
		options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: agent.name,
			agentSource: agent.source,
			description: options.description,
			status: progress.status as "completed" | "failed" | "aborted" | "paused",
			sessionFile: subtaskSessionFile,
			index,
		});
	}

	return {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		task,
		assignment,
		description: options.description,
		lastIntent: progress.lastIntent,
		exitCode,
		output: truncatedOutput,
		stderr,
		truncated: Boolean(truncated),
		durationMs: Date.now() - startTime,
		tokens: progress.tokens,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
		modelOverride,
		modelSubstitutionWarning,
		error: exitCode !== 0 && stderr ? stderr : undefined,
		aborted: wasAborted,
		abortReason: finalAbortReason,
		paused,
		usage: hasUsage ? accumulatedUsage : undefined,
		outputPath,
		extractedToolData: progress.extractedToolData,
		retryFailure: progress.retryFailure,
		outputMeta,
	};
}
