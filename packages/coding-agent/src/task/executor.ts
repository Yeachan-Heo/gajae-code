/**
 * In-process execution for subagents.
 *
 * Runs each subagent on the main thread and forwards AgentEvents for progress tracking.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import type {
	AgentEvent,
	AgentIdentity,
	AgentMessage,
	AgentTelemetryConfig,
	ThinkingLevel,
} from "@gajae-code/agent-core";
import { recordHandoff, resolveTelemetry } from "@gajae-code/agent-core";
import { estimateMessageTokensHeuristic } from "@gajae-code/agent-core/compaction";
import {
	type AssistantMessage,
	isFastModeEffectiveForProvider,
	type Message,
	type Model,
	modelSupportsServiceTier,
	type ServiceTier,
} from "@gajae-code/ai/core";
import {
	classifyFallbackTrigger,
	type TransportFailureFacts,
	transportFailureFacts,
} from "@gajae-code/ai/utils/fallback-transport";
import { type JsonSchemaValidationIssue, validateJsonSchemaValue } from "@gajae-code/ai/utils/schema";
import * as canonicalSdk from "@gajae-code/coding-agent/sdk";
import { logger, prompt, untilAborted } from "@gajae-code/utils";
import { AsyncJobManager } from "../async";
import { AUTOROUTING_SELECTOR_MAX_LENGTH, type AutoroutingReasonCode } from "../config/autorouting-contract";
import { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveModelOverrideWithAuthFallback } from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import { Settings } from "../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings-schema";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import { buildAgentSubskillInjection, renderAgentPromptAdditions } from "../extensibility/gjc-plugins";
import { buildSkillPromptMessage, type Skill } from "../extensibility/skills";
import { sessionRoot } from "../gjc-runtime/session-layout";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import submitReminderTemplate from "../prompts/system/subagent-yield-reminder.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import { discoverAuthStorage } from "../sdk";
import type { AgentSession, AgentSessionEvent, ForkContextSeed } from "../session/agent-session";
import { ArtifactManager } from "../session/artifacts";
import type { AuthStorage } from "../session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import { SessionManager, type SessionMemoryMode } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import { truncateTail } from "../session/streaming-output";
// Ensure mandatory subagent result extraction is available even when a session is mocked.
import "../tools/yield";
import type { ContextFileEntry } from "../tools";
import { jtdToJsonSchema, normalizeSchema } from "../tools/jtd-to-json-schema";
import type { ReportFindingDetails } from "../tools/review";
import { ToolAbortError } from "../tools/tool-errors";
import type { EventBus } from "../utils/event-bus";
import { buildNamedToolChoiceResult } from "../utils/tool-choice";
import type { WorkspaceTree } from "../workspace-tree";
import { validateAllocatedTaskId } from "./id";
import { classifyProviderRetryFromTransport, providerNameFromModel } from "./provider-retry-status";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import { persistTaskTokenLog, taskTokenLogFromUsage } from "./token-log";
import {
	type AgentDefinition,
	type AgentProgress,
	type AutoroutingAttempt,
	type AutoroutingAttemptCode,
	type AutoroutingPreflightFailure,
	assertRoutingEvidenceInvariant,
	createLocalErrorSummary,
	createSetupFailureSummary,
	hasCompleteUsageCostBreakdown,
	isAssistantLocalErrorKind,
	type LocalErrorSummary,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type ModelSubstitutionWarning,
	type ReviewFindingsArtifactRef,
	type SetupFailureSummary,
	type SingleResult,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type TaskRoutingEvidence,
	type TaskToolDetails,
} from "./types";

export type { AutoroutingPreflightFailure } from "./types";

import { type ExecutorExecutionMode, resolveUltragoalRedTeamActivation } from "./ultragoal-redteam-activation";

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

const providerStreamingUpdateTypes = new Set<string>([
	"text_start",
	"text_delta",
	"text_end",
	"thinking_start",
	"thinking_delta",
	"thinking_end",
	"reasoning_summary_start",
	"reasoning_summary_delta",
	"reasoning_summary_end",
	"toolcall_start",
	"toolcall_delta",
	"toolcall_end",
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

function getSubagentCanonicalScope(parentSessionId: string | undefined, subagentId: string): string | undefined {
	if (!parentSessionId) return undefined;
	return JSON.stringify(["subagent-canonical", parentSessionId, subagentId]);
}

function renderIrcPeerRoster(agentRegistry: AgentRegistry, selfId: string): string {
	const peers = agentRegistry
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

const FORK_CONTEXT_MINIMUM_RESERVED_OUTPUT_TOKENS = 4_096;
const FORK_CONTEXT_FIXED_PROMPT_AND_TOOL_OVERHEAD_TOKENS = 4_096;

export function trimForkContextSeedForModel(seed: ForkContextSeed, model: Model | undefined): ForkContextSeed {
	const contextWindow = model?.contextWindow;
	if (!contextWindow || contextWindow <= 0) return seed;
	const reservedOutputTokens = Math.max(
		FORK_CONTEXT_MINIMUM_RESERVED_OUTPUT_TOKENS,
		model && Number.isFinite(model.maxTokens) ? Math.max(0, Math.trunc(model.maxTokens)) : 0,
	);
	const ceiling = Math.max(
		0,
		Math.trunc(contextWindow) - reservedOutputTokens - FORK_CONTEXT_FIXED_PROMPT_AND_TOOL_OVERHEAD_TOKENS,
	);
	const maxTokens = Math.min(seed.metadata.maxTokens, ceiling);
	const skippedReasons = { ...seed.metadata.skippedReasons };
	let skippedMessages = seed.metadata.skippedMessages;
	let approximateTokens = 0;
	const messages: Message[] = [];
	for (let i = seed.messages.length - 1; i >= 0; i--) {
		const message = seed.messages[i]!;
		const tokens = estimateMessageTokensHeuristic(message);
		if (maxTokens <= 0 || approximateTokens + tokens > maxTokens) {
			skippedMessages++;
			skippedReasons["child-context-ceiling"] = (skippedReasons["child-context-ceiling"] ?? 0) + 1;
			continue;
		}
		messages.unshift(message);
		approximateTokens += tokens;
	}
	return {
		...seed,
		messages,
		agentMessages: messages.map(message => structuredClone(message) as AgentMessage),
		metadata: {
			...seed.metadata,
			includedMessages: messages.length,
			skippedMessages,
			approximateTokens,
			maxTokens,
			skippedReasons,
		},
	};
}

/** Options for subagent execution */
export interface ExecutorOptions {
	cwd: string;
	worktree?: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	/**
	 * Typed executor execution mode. When set, overrides assignment-text heuristics
	 * for ultragoal red-team prompt injection (#2698 / #2456).
	 */
	executionMode?: ExecutorExecutionMode;
	context?: string;
	description?: string;
	routing?: TaskRoutingEvidence;
	/** Ordered, normalized autorouting candidates for the cross-phase preflight ledger. */
	autoroutingCandidates?: string[];
	autoroutingSkips?: Array<{ selector: string; code: AutoroutingReasonCode }>;
	autoroutingPreflightErrors?: Map<string, unknown>;
	autoroutingPreflight?: boolean;
	autoroutingAttemptId?: string;
	preflightProbe?: boolean;
	preflightDurable?: boolean;
	preflightFenceCallback?: () => void;

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
	/**
	 * Whether the live parent session has an active model profile. When set,
	 * persisted `task.agentModelOverrides` may resolve through preset-equivalent
	 * aliases (bare profile aliases re-resolve to an equivalent provider variant).
	 * Manual/direct parents (no active profile) keep exact resolution.
	 */
	parentActiveModelProfile?: string;
	parentSessionId?: string;
	parentCredentialSessionId?: string;
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
	/** Parent session's registry; shared by child sessions for IRC routing and roster visibility. */
	agentRegistry?: AgentRegistry;
	/**
	 * Parent service-tier intent captured when the child is spawned. Used when
	 * `task.serviceTier === "inherit"` so request serialization and reporting use
	 * the same immutable child settings snapshot.
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
	managedPersistence?: ManagedTaskPersistence;
	/**
	 * The parent session's ENDPOINT-owned AsyncJobManager (resolved by the
	 * TaskTool via forEndpoint(sessionId) ?? instance()). Model metadata and
	 * live-handle state for THIS subagent are recorded in the SAME manager the
	 * task job runs in — with concurrent top-level sessions the process-global
	 * instance belongs to a different session and would surface this subagent
	 * under the wrong session's record (review thread P1).
	 */
	asyncJobManager?: AsyncJobManager;
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
	/**
	 * W6b: the parent's scope-held MCP facade, forwarded so the subagent inherits
	 * always-on MCP tools without the removed process-global singleton.
	 */
	parentMcpManager?: import("../runtime-mcp/manager").MCPManager;
}

export class ManagedTaskPersistence {
	readonly #artifacts: ArtifactManager;
	readonly #taskId: string;

	constructor(artifacts: ArtifactManager, taskId: string) {
		this.#artifacts = artifacts;
		this.#taskId = validateAllocatedTaskId(taskId);
		if (!artifacts.getManagedSubtreeRootAuthority())
			throw new Error("Managed task persistence authority is unavailable");
	}

	async openSession(cwd: string, sessionMemoryMode: SessionMemoryMode = "shadow"): Promise<SessionManager> {
		const store = this.#artifacts.getManagedStore();
		if (!store) throw new Error("Managed task persistence authority is unavailable");
		this.#artifacts.assertManagedBinding();
		const sessionFile = path.join(this.#artifacts.dir, `${this.#taskId}.jsonl`);
		const session = await SessionManager.openNestedManaged(
			sessionFile,
			SessionManager.nestedManagedDestination(store, this.#artifacts.dir),
			store,
			undefined,
			cwd,
			sessionMemoryMode,
		);
		this.#artifacts.assertManagedBinding();
		return session;
	}
	async openStagedSession(attemptId = this.#taskId): Promise<SessionManager> {
		const store = this.#artifacts.getManagedStore();
		if (!store) throw new Error("Managed task persistence authority is unavailable");
		this.#artifacts.assertManagedBinding();
		const sessionFile = path.join(this.#artifacts.dir, `${this.#taskId}.jsonl`);
		const session = await SessionManager.stagedNestedManaged(
			sessionFile,
			SessionManager.nestedManagedDestination(store, this.#artifacts.dir),
			store,
			undefined,
			attemptId,
		);
		const stagedArtifacts = this.#artifacts.createAttemptStaging(attemptId);
		session.adoptArtifactManager(stagedArtifacts, this.#artifacts);
		this.#artifacts.assertManagedBinding();
		return session;
	}

	async publishOutput(rawOutput: string, metadata: Uint8Array): Promise<void> {
		await withArtifactManagerFinalizationTurn(this.#artifacts, () =>
			this.#artifacts.publishManagedOutputGeneration(
				`${this.#taskId}.md.selector.json`,
				`${this.#taskId}.md`,
				Buffer.from(rawOutput, "utf8"),
				metadata,
			),
		);
	}
}

export function createManagedTaskPersistence(artifacts: ArtifactManager, taskId: string): ManagedTaskPersistence {
	return new ManagedTaskPersistence(artifacts, taskId);
}

const MAX_REVIEW_FINDINGS_ARTIFACT_BYTES = 16 * 1024 * 1024;
const REVIEW_FINDINGS_ARTIFACT_FAILURE = "Review findings artifact publication failed.";
const artifactManagerFinalizationTails = new WeakMap<ArtifactManager, Promise<void>>();

interface ReviewFindingsArtifactPayload {
	version: 1;
	kind: "review-findings";
	taskId: string;
	findingCount: number;
	findings: ReportFindingDetails[];
}

async function withArtifactManagerFinalizationTurn<T>(
	manager: ArtifactManager,
	operation: () => Promise<T>,
): Promise<T> {
	const priorTail = artifactManagerFinalizationTails.get(manager);
	const turn = Promise.withResolvers<void>();
	artifactManagerFinalizationTails.set(manager, turn.promise);

	try {
		await priorTail?.catch(() => undefined);
		return await operation();
	} finally {
		turn.resolve();
		if (artifactManagerFinalizationTails.get(manager) === turn.promise) {
			artifactManagerFinalizationTails.delete(manager);
		}
	}
}

async function publishReviewFindingsArtifact(
	manager: ArtifactManager,
	taskId: string,
	findings: ReportFindingDetails[],
): Promise<ReviewFindingsArtifactRef> {
	const payload: ReviewFindingsArtifactPayload = {
		version: 1,
		kind: "review-findings",
		taskId,
		findingCount: findings.length,
		findings,
	};
	const serialized = JSON.stringify(payload, null, 2);
	const sizeBytes = Buffer.byteLength(serialized, "utf8");
	if (sizeBytes > MAX_REVIEW_FINDINGS_ARTIFACT_BYTES) throw new Error("review findings artifact exceeds limit");
	const sha256 = createHash("sha256").update(serialized).digest("hex");
	const artifactId = await withArtifactManagerFinalizationTurn(manager, () =>
		manager.save(serialized, "review-findings", { maxBytes: sizeBytes }),
	);
	return { uri: `artifact://${artifactId}`, sizeBytes, sha256, findingCount: findings.length };
}

export function renderSubagentUserPrompt(assignment: string, independentMode: boolean): string {
	return prompt.render(subagentUserPromptTemplate, { assignment: assignment.trim(), independentMode });
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
const PLACEHOLDER_YIELD_PATTERNS = [
	/^see (?:the )?message body(?:\b|[\s—:.,-])/i,
	/^(?:complete\s+\w+\s+)?returned inline(?:\b|[\s—:.,-])/i,
	/^leader persists(?:\b|[\s—:.,-])/i,
	/^caller persists(?:\b|[\s—:.,-])/i,
];

const PLACEHOLDER_YIELD_FIELD_NAMES = new Set([
	"artifactmarkdown",
	"finalmarkdown",
	"fullplan",
	"markdown",
	"planmarkdown",
]);

function looksLikePlaceholderYieldString(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 500) return false;
	return PLACEHOLDER_YIELD_PATTERNS.some(pattern => pattern.test(trimmed));
}

function normalizePlaceholderYieldFieldName(key: string): string {
	return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function findPlaceholderYieldPath(value: unknown, path = "$", depth = 0, inspectStrings = true): string | undefined {
	if (typeof value === "string") {
		return inspectStrings && looksLikePlaceholderYieldString(value) ? path : undefined;
	}
	if (!value || typeof value !== "object" || depth > 4) return undefined;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const found = findPlaceholderYieldPath(value[i], `${path}[${i}]`, depth + 1, false);
			if (found) return found;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const [key, item] of Object.entries(record)) {
		const shouldInspectString = PLACEHOLDER_YIELD_FIELD_NAMES.has(normalizePlaceholderYieldFieldName(key));
		const found = findPlaceholderYieldPath(item, `${path}.${key}`, depth + 1, shouldInspectString);
		if (found) return found;
	}
	return undefined;
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

function normalizeCompleteData(data: unknown): unknown {
	return parseStringifiedJson(data ?? null);
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
	terminalFailure?: boolean;
	doneAborted: boolean;
	signalAborted: boolean;
	yieldItems?: YieldItem[];
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
export const SUBAGENT_WARNING_PLACEHOLDER_YIELD =
	"SYSTEM WARNING: Subagent yield data contains a placeholder instead of the actual result.";

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
	const dataPreview = previewOffendingData(data);
	const payload = {
		error: "schema_violation",
		message: failure.message,
		missingRequired: missing,
		data,
	};
	let rawOutput: string;
	try {
		rawOutput = JSON.stringify(payload, null, 2);
	} catch {
		rawOutput = `{"error":"schema_violation","message":${JSON.stringify(headline)}}`;
	}
	return { rawOutput, stderr: `${headline}. Offending data preview: ${dataPreview}`, exitCode: 1 };
}

function buildPlaceholderYieldOutcome(
	placeholderPath: string,
	data: unknown,
): { rawOutput: string; stderr: string; exitCode: number } {
	return buildSchemaViolationOutcome(
		{
			message:
				`${SUBAGENT_WARNING_PLACEHOLDER_YIELD} Offending path: ${placeholderPath}. ` +
				"Return the real payload in yield.result.data or persist a durable artifact receipt.",
			missingRequired: [],
		},
		data,
	);
}

export function finalizeSubprocessOutput(args: FinalizeSubprocessOutputArgs): FinalizeSubprocessOutputResult {
	let { rawOutput, exitCode, stderr } = args;
	const { yieldItems, terminalFailure = false, doneAborted, signalAborted, outputSchema } = args;
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
				const completeData = normalizeCompleteData(submitData);
				const { validator, error: schemaError } = buildOutputValidator(outputSchema);
				if (schemaError) {
					const outcome = buildSchemaViolationOutcome(
						{
							message: `invalid output schema: ${schemaError}`,
							missingRequired: [],
						},
						completeData,
					);
					rawOutput = outcome.rawOutput;
					stderr = outcome.stderr;
					exitCode = outcome.exitCode;
				} else {
					const placeholderPath = findPlaceholderYieldPath(completeData);
					if (placeholderPath) {
						const outcome = buildPlaceholderYieldOutcome(placeholderPath, completeData);
						rawOutput = outcome.rawOutput;
						stderr = outcome.stderr;
						exitCode = outcome.exitCode;
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
							// A valid yield can preserve policy-safe public review output after a
							// terminal provider failure, but it cannot convert that failed run
							// into a successful subagent result. A normal yield starts with a
							// non-zero provisional exit code, so use the explicit terminal fact
							// rather than the provisional code to distinguish the two cases.
							if (!terminalFailure) {
								exitCode = 0;
								stderr = "";
							}
						}
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
			const completeData = normalizeCompleteData(fallback.data);
			const { validator } = buildOutputValidator(outputSchema);
			const placeholderPath = findPlaceholderYieldPath(completeData);
			if (placeholderPath) {
				const outcome = buildPlaceholderYieldOutcome(placeholderPath, completeData);
				rawOutput = outcome.rawOutput;
				stderr = outcome.stderr;
				exitCode = outcome.exitCode;
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
						rawOutput = `{"error":"Failed to serialize fallback completion: ${errorMessage}"}`;
					}
					exitCode = 0;
					stderr = "";
				}
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
 * Finalize routing evidence at the executor return boundary: the effective
 * model is the terminal provider-reported model when present, otherwise the
 * auth-resolved model; substitution causes are appended in order.
 */
export function finalizeRoutingEvidence(
	routing: TaskRoutingEvidence | undefined,
	state: {
		resolvedModelString: string | undefined;
		lastAssistantModelString: string | undefined;
		authFallbackUsed: boolean;
		assistantModelMismatch: boolean;
	},
): TaskRoutingEvidence | undefined {
	if (!routing) return undefined;
	const terminalModel = state.lastAssistantModelString ?? state.resolvedModelString;
	const effectiveModel = terminalModel === undefined ? undefined : boundedSelector(terminalModel);
	const substitutions: TaskRoutingEvidence["substitutions"] = [];
	if (state.authFallbackUsed) substitutions.push("auth_substituted");
	if (state.assistantModelMismatch) substitutions.push("assistant_model_mismatch");
	if (!effectiveModel) {
		if (!routing.notExecuted && !routing.terminal && !routing.attempts) return undefined;
		const terminalEvidence = { ...routing, substitutions };
		assertRoutingEvidenceInvariant(terminalEvidence);
		return terminalEvidence;
	}
	const evidence = {
		...routing,
		effectiveModel,
		...(state.resolvedModelString && state.resolvedModelString !== terminalModel
			? { authResolvedModel: boundedSelector(state.resolvedModelString) }
			: {}),
		substitutions,
	};
	assertRoutingEvidenceInvariant(evidence);
	return evidence;
}

/**
 * Run a single agent in-process.
 */
class AutoroutingProbeAcceptedError extends Error {
	readonly code = "autorouting_probe_accepted";
	constructor() {
		super("autorouting_probe_accepted");
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function formatExecutionError(error: unknown): string {
	if (error instanceof AggregateError) {
		const causes = error.errors.map(cause => (cause instanceof Error ? cause.message : String(cause))).join("; ");
		return causes ? `${error.message}: ${causes}` : error.message;
	}
	return error instanceof Error ? error.stack || error.message : String(error);
}

function transportFactsFromError(error: unknown): TransportFailureFacts | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = error as { transportFailure?: unknown };
	if (!value.transportFailure || typeof value.transportFailure !== "object") return undefined;
	return value.transportFailure as TransportFailureFacts;
}

/**
 * True only for the explicit "no credential found for this candidate" signal thrown at the
 * auth_resolve preflight step, never for an unexpected exception the credential lookup itself
 * raised (keychain access denied, corrupted store, I/O failure). auth_resolve is the one op
 * that always advances to the next candidate regardless of any transient marker, so it must
 * only ever be reached via this explicit, typed signal — not by inferring intent from which
 * preflight phase happened to be executing when an unrelated error was thrown.
 */
function isCredentialMissingSignal(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && (error as { credentialMissing?: unknown }).credentialMissing === true,
	);
}

export function classifyAutoroutingPreflightFailure(
	error: unknown,
	op: Extract<AutoroutingPreflightFailure, { kind: "local" }>["op"],
): AutoroutingPreflightFailure {
	const facts = transportFactsFromError(error) ?? transportFailureFacts(error);
	if (facts) return { kind: "transport", class: classifyFallbackTrigger(facts).class };
	const typedTransient =
		error && typeof error === "object" && typeof (error as { transient?: unknown }).transient === "boolean"
			? (error as { transient: boolean }).transient
			: undefined;
	// An exception raised while op is auth_resolve is only the deliberate missing-credential
	// signal when it carries the explicit marker; any other error surfacing during that window
	// (an unexpected keychain/config failure) must fail closed like every other unclassified
	// local error, not silently advance as if credentials were simply absent.
	const resolvedOp = op === "auth_resolve" && !isCredentialMissingSignal(error) ? "preflight_validation" : op;
	return {
		kind: "local",
		op: resolvedOp,
		// Local setup failures are fail-closed: only an explicit transient marker
		// can advance a candidate. Unknown session/tool errors are terminal.
		transient: typedTransient === true,
	};
}

/**
 * Map a preflight failure to the attempt code that is recorded in routing evidence AND whether the
 * ledger may advance to the next candidate. These are two different questions: a
 * `config_invalid_terminal` / `unclassified_terminal` code is recorded *and* stops the ledger, so
 * the caller must never infer "advance" from the mere presence of a code.
 */
function autoroutingAttemptDisposition(failure: AutoroutingPreflightFailure): {
	code: AutoroutingAttemptCode;
	advance: boolean;
} {
	if (failure.kind === "local" && failure.op === "auth_resolve")
		return { code: "credential_unavailable", advance: true };
	if (
		failure.kind === "local" &&
		(failure.op === "session_open" || failure.op === "tool_bootstrap") &&
		failure.transient
	)
		return { code: "spawn_transient_retry", advance: true };
	if (failure.kind === "local" && (!failure.transient || failure.op === "preflight_validation"))
		return { code: "config_invalid_terminal", advance: false };
	return { code: "unclassified_terminal", advance: false };
}

export async function runSubprocessOnce(options: ExecutorOptions): Promise<SingleResult> {
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
	const configuredSubagentServiceTier = subagentSettings.get("serviceTier");
	const subagentServiceTier = configuredSubagentServiceTier === "none" ? undefined : configuredSubagentServiceTier;
	const isFastForModel = (candidate: Model | undefined): boolean =>
		candidate !== undefined &&
		isFastModeEffectiveForProvider(subagentServiceTier, candidate.provider, modelSupportsServiceTier(candidate));
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
	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
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
	let ownedModelRegistry: ModelRegistry | undefined;
	let ownedAuthStorage: AuthStorage | undefined;
	let unsubscribe: (() => void) | null = null;
	let yieldCalled = false;
	let pauseRequested = false;
	let paused = false;
	let modelSubstitutionWarning: ModelSubstitutionWarning | undefined;
	let authFallbackUsed = false;
	let assistantModelMismatch = false;
	let resolvedModelString: string | undefined;
	let lastAssistantModelString: string | undefined;
	let activeProviderModelString: string | undefined;
	let effectiveThinkingLevelForWarning: ThinkingLevel | undefined;
	let lastProviderProgressAtMs: number | undefined;
	let sessionEventOrdinal = 0;
	let retryStartOrdinal = 0;
	const seenAssistantMessages = new WeakSet<AgentMessage>();
	let llmRequestStarted = false;
	let preflightFenceCrossed = false;
	let preflightFailure: AutoroutingPreflightFailure | undefined;
	let preflightCommitFailure = false;
	let lifecycleStarted = false;
	let liveHandleRegistered = false;
	let probeAccepted = false;
	let preflightOperation: Extract<AutoroutingPreflightFailure, { kind: "local" }>["op"] = "preflight_validation";
	const seenAssistantMessageIdentities = new Set<string>();

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
	let usageCostBreakdownComplete = true;

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
		const progressSnapshot = structuredClone(progress);
		onProgress?.(progressSnapshot);
		if (options.eventBus) {
			options.eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				assignment,
				progress: progressSnapshot,
				sessionFile: sessionFile ?? undefined,
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

	const getAssistantMessageIdentity = (message: AgentMessage): string | undefined => {
		if (message.role !== "assistant") return undefined;
		const model = getMessageModelString(message);
		const timestamp = "timestamp" in message ? message.timestamp : undefined;
		if (!model || typeof timestamp !== "number") return undefined;
		const responseId = "responseId" in message && typeof message.responseId === "string" ? message.responseId : "";
		return JSON.stringify([model, timestamp, responseId]);
	};

	const rememberAssistantMessage = (message: AgentMessage): void => {
		seenAssistantMessages.add(message);
		const identity = getAssistantMessageIdentity(message);
		if (identity) seenAssistantMessageIdentities.add(identity);
	};

	const isProviderAssistantMessage = (message: AgentMessage): message is AssistantMessage =>
		message.role === "assistant" &&
		"stopReason" in message &&
		Array.isArray(message.content) &&
		getMessageModelString(message) !== undefined;

	const isSuccessfulProviderAssistantMessage = (message: AgentMessage): message is AssistantMessage =>
		isProviderAssistantMessage(message) &&
		message.stopReason !== "error" &&
		message.stopReason !== "aborted" &&
		message.errorMessage === undefined &&
		message.errorKind === undefined &&
		message.transportFailure === undefined;

	const hasMatchingActiveProviderModel = (message: AgentMessage): message is AssistantMessage =>
		isProviderAssistantMessage(message) &&
		activeProviderModelString !== undefined &&
		getMessageModelString(message) === activeProviderModelString;

	const isProviderStreamingUpdate = (event: Extract<AgentEvent, { type: "message_update" }>): boolean => {
		const update = event.assistantMessageEvent;
		if (!update || typeof update !== "object" || !providerStreamingUpdateTypes.has(update.type)) return false;
		if (!("partial" in update) || getMessageModelString(update.partial) !== activeProviderModelString) return false;
		switch (update.type) {
			case "text_delta":
			case "thinking_delta":
			case "reasoning_summary_delta":
			case "toolcall_delta":
				return typeof update.delta === "string";
			default:
				return typeof update.contentIndex === "number";
		}
	};

	const getProviderTextDelta = (event: Extract<AgentEvent, { type: "message_update" }>): string | undefined => {
		const update = (event as { assistantMessageEvent?: unknown }).assistantMessageEvent;
		if (!update || typeof update !== "object") return undefined;
		const record = update as { type?: unknown; delta?: unknown };
		return record.type === "text_delta" && typeof record.delta === "string" ? record.delta : undefined;
	};

	const isProviderBackedRecoveryEvent = (
		event: Extract<AgentEvent, { type: "message_start" | "message_update" }>,
		eventOrdinal: number,
	): boolean => {
		const messageIdentity = getAssistantMessageIdentity(event.message);
		if (
			!progress.retryState ||
			eventOrdinal <= retryStartOrdinal ||
			seenAssistantMessages.has(event.message) ||
			(messageIdentity !== undefined && seenAssistantMessageIdentities.has(messageIdentity))
		)
			return false;
		if (!hasMatchingActiveProviderModel(event.message)) return false;
		if (event.type === "message_start") return isSuccessfulProviderAssistantMessage(event.message);
		return isProviderStreamingUpdate(event);
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

	const resetRecentOutput = () => {
		recentOutputTail = "";
		progress.recentOutput = [];
	};

	const forwardSubagentEvent = (
		event: AgentEvent | Extract<AgentSessionEvent, { type: "model_fallback_switched" }>,
	) => {
		if (!options.eventBus) return;
		options.eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			index,
			agent: agent.name,
			agentSource: agent.source,
			task,
			assignment,
			event,
		});
	};

	const processEvent = (event: AgentEvent, eventOrdinal: number) => {
		if (resolved) return;

		forwardSubagentEvent(event);

		const now = Date.now();
		let flushProgress = false;
		// A retry is recovered at the first assistant provider event, before the
		// session emits auto_retry_end after message completion.

		switch (event.type) {
			case "message_start": {
				if (event.message.role !== "assistant") break;
				const retryWasActive = Boolean(progress.retryState);
				const recoversRetry = isProviderBackedRecoveryEvent(event, eventOrdinal);
				rememberAssistantMessage(event.message);
				if (recoversRetry || !retryWasActive) {
					lastProviderProgressAtMs = now;
					resetRecentOutput();
				}
				if (recoversRetry) {
					progress.retryState = undefined;
					flushProgress = true;
				}
				break;
			}

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
				if (event.message.role !== "assistant") break;
				const retryWasActive = Boolean(progress.retryState);
				const recoversRetry = isProviderBackedRecoveryEvent(event, eventOrdinal);
				if (!retryWasActive) rememberAssistantMessage(event.message);
				if (recoversRetry || !retryWasActive) lastProviderProgressAtMs = now;
				if (recoversRetry) {
					progress.retryState = undefined;
					flushProgress = true;
				}
				const textDelta = getProviderTextDelta(event);
				if (textDelta !== undefined) appendRecentOutputTail(textDelta);
				break;
			}

			case "message_end": {
				// Extract text from assistant and toolResult messages (not user prompts)
				const role = event.message?.role;
				if (role === "assistant") {
					if (isSuccessfulProviderAssistantMessage(event.message)) lastProviderProgressAtMs = now;
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
						activeProviderModelString = assistantModel;
						if (resolvedModelString && assistantModel !== resolvedModelString && !modelSubstitutionWarning) {
							modelSubstitutionWarning = {
								requested: resolvedModelString,
								effective: assistantModel,
								reason: "assistant_model_mismatch",
							};
							assistantModelMismatch = true;

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
						usageCostBreakdownComplete &&= hasCompleteUsageCostBreakdown(usageRecord);
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
		localErrorSummary?: LocalErrorSummary;
		aborted?: boolean;
		abortReason?: string;
		setupFailure?: SetupFailureSummary;
		probeAccepted?: boolean;
		preflightFailure?: AutoroutingPreflightFailure;
		preflightFenceCrossed?: boolean;
		preflightCommitFailure?: boolean;
		durationMs: number;
	}> => {
		let openedSessionManager: SessionManager | null = null;
		let liveHandleManager: AsyncJobManager | undefined;
		const liveSubagentId = options.subagentId ?? id;
		const sessionAbortController = new AbortController();
		let exitCode = 0;
		let error: string | undefined;
		let localErrorSummary: LocalErrorSummary | undefined;
		let aborted = false;
		let abortReasonText: string | undefined;
		let setupFailure: SetupFailureSummary | undefined;
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
			const registryAuthStorage =
				options.authStorage ??
				options.modelRegistry?.authStorage ??
				(await awaitAbortable(discoverAuthStorage(settings.getAgentDir())));
			if (options.modelRegistry === undefined && options.authStorage === undefined)
				ownedAuthStorage = registryAuthStorage;
			ownedModelRegistry = options.modelRegistry
				? undefined
				: new ModelRegistry(registryAuthStorage, path.join(settings.getAgentDir(), "models.yml"), settings, {
						agentDir: settings.getAgentDir(),
						automaticRefresh: false,
					});
			const modelRegistry = options.modelRegistry ?? ownedModelRegistry!;
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

			const canonicalChildScope = getSubagentCanonicalScope(options.parentSessionId, options.subagentId ?? id);

			if (options.preflightProbe || options.preflightDurable) preflightOperation = "auth_resolve";
			const {
				model,
				thinkingLevel: resolvedThinkingLevel,
				explicitThinkingLevel,
				authFallbackUsed: resolvedAuthFallbackUsed,
				requestedModel,
				fallbackReason,
				activeIndex,
				parentFallbackSelector,
				skips,
			} = await awaitAbortable(
				resolveModelOverrideWithAuthFallback(
					modelPatterns,
					options.preflightProbe || options.preflightDurable ? undefined : options.parentActiveModelPattern,
					modelRegistry,
					settings,
					options.parentCredentialSessionId ?? options.parentSessionId,
					{
						managedFallback: true,
						...(options.parentActiveModelProfile ? { aliasIntent: "preset-equivalent" } : {}),
					},
					canonicalChildScope,
				),
			);
			if (
				(options.preflightProbe || options.preflightDurable) &&
				model &&
				typeof modelRegistry.getApiKey === "function"
			) {
				preflightOperation = "auth_resolve";
				const exactKey = await awaitAbortable(
					modelRegistry.getApiKey(model, options.parentCredentialSessionId ?? options.parentSessionId),
				);
				if (!exactKey)
					throw Object.assign(new Error("autorouting credential unavailable"), {
						transient: false,
						// Explicit signal: credentials were looked up successfully and are simply absent for
						// this candidate. Distinguishes the deliberate "advance to next candidate" case from
						// an unexpected error the lookup itself threw (see classifyAutoroutingPreflightFailure).
						credentialMissing: true,
					});
			}
			authFallbackUsed = resolvedAuthFallbackUsed;
			if (model) {
				resolvedModelString = formatModelString(model);
				activeProviderModelString = resolvedModelString;
			}
			progress.fastMode = isFastForModel(model);
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
				(options.asyncJobManager ?? AsyncJobManager.instance())?.updateSubagentModel?.(options.subagentId ?? id, {
					requestedModel: modelSubstitutionWarning?.requested ?? resolvedModelString,
					effectiveModel: resolvedModelString,
					modelFellBack: authFallbackUsed === true,
					fastMode: progress.fastMode,
				});
			}
			if (model?.contextWindow && model.contextWindow > 0) {
				progress.contextWindow = model.contextWindow;
			}
			const forkContextSeed = options.forkContextSeed
				? trimForkContextSeedForModel(options.forkContextSeed, model)
				: undefined;
			const effectiveThinkingLevel = explicitThinkingLevel
				? resolvedThinkingLevel
				: (thinkingLevel ?? resolvedThinkingLevel);
			effectiveThinkingLevelForWarning = effectiveThinkingLevel;

			preflightOperation = "session_open";
			const sessionManager = options.preflightProbe
				? SessionManager.inMemory(worktree ?? cwd)
				: options.preflightDurable
					? options.managedPersistence
						? await awaitAbortable(
								options.managedPersistence.openStagedSession(options.autoroutingAttemptId ?? id),
							)
						: sessionFile
							? await awaitAbortable(
									SessionManager.openStaged(sessionFile, undefined, options.autoroutingAttemptId ?? id),
								)
							: SessionManager.inMemory(worktree ?? cwd)
					: options.managedPersistence
						? await awaitAbortable(
								options.managedPersistence.openSession(
									worktree ?? cwd,
									subagentSettings.get("sessionMemory.mode"),
								),
							)
						: sessionFile
							? await awaitAbortable(
									SessionManager.open(
										sessionFile,
										SessionManager.explicitDestination(path.dirname(sessionFile)),
										new FileSessionStorage(),
										subagentSettings.get("session.directoryMigration") === "disabled"
											? "disabled"
											: "copy-retain",
										subagentSettings.get("sessionMemory.mode"),
									),
								)
							: SessionManager.inMemory(worktree ?? cwd);
			openedSessionManager = sessionManager;
			if (options.parentArtifactManager && !options.preflightProbe && !options.preflightDurable) {
				sessionManager.adoptArtifactManager(options.parentArtifactManager);
			} else if (options.preflightDurable && !options.managedPersistence) {
				// Only the unmanaged durable preflight adopts its attempt staging here. With
				// managedPersistence the session came from openStagedSession(), which already
				// adopted exactly one task-scoped attempt root; adopting a second instance over
				// the same root would leave the first unreachable from commit/discard.
				const attemptId = options.autoroutingAttemptId ?? id;
				const parentArtifacts =
					options.parentArtifactManager ??
					(sessionFile
						? new ArtifactManager(sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -6) : sessionFile)
						: undefined);
				if (parentArtifacts)
					sessionManager.adoptArtifactManager(parentArtifacts.createAttemptStaging(attemptId), parentArtifacts);
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
			let subagentTokenTurn = 0;
			const tokenLogDir = options.parentSessionId
				? path.join(sessionRoot(cwd, options.parentSessionId), "token-logs")
				: undefined;
			const subagentTelemetry: AgentTelemetryConfig | undefined =
				options.parentTelemetry && subagentAgentIdentity
					? {
							...options.parentTelemetry,
							agent: subagentAgentIdentity,
							// Clear parent's conversationId; the child loop falls back to
							// its own AgentLoopConfig.sessionId.
							conversationId: undefined,
							// Intentionally REPLACES (does not chain) the parent's onChatUsage:
							// the parent handler attributes turns to subagentId "root", so
							// chaining it here would double-log every subagent turn under root.
							// Subagent turns are attributed to this child's id instead.
							onChatUsage: async event => {
								if (!tokenLogDir) return;
								subagentTokenTurn += 1;
								await persistTaskTokenLog(
									taskTokenLogFromUsage(event.usage, {
										subagentId: id,
										agent: agent.name,
										// Monotonic 1-based sequence per subagent session
										// (event.stepNumber is 0-based and -1 for oneshots).
										turn: subagentTokenTurn,
										at: new Date().toISOString(),
										model: event.model,
										cost: event.cost,
									}),
									{ dir: tokenLogDir },
								);
							},
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

			const forkContextNotice =
				forkContextSeed && forkContextSeed.metadata.includedMessages > 0
					? `This subagent was started with a forked snapshot of the parent conversation. Included ${forkContextSeed.metadata.includedMessages} message(s), skipped ${forkContextSeed.metadata.skippedMessages}, approximately ${forkContextSeed.metadata.approximateTokens} tokens. The snapshot is not live.${ircEnabled ? " Use IRC for live coordination." : " Rely on the explicit assignment and supplied context for coordination."}`
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

			if (options.preflightProbe || options.preflightDurable) preflightOperation = "tool_bootstrap";
			const { session } = await awaitAbortable(
				canonicalSdk.createAgentSession({
					cwd: worktree ?? cwd,
					authStorage,
					modelRegistry,
					settings: subagentSettings,
					providerSessionId: canonicalChildScope,
					model,
					thinkingLevel: effectiveThinkingLevel,
					activeModelProfile: options.parentActiveModelProfile,
					credentialSessionId: options.parentCredentialSessionId ?? options.parentSessionId,
					modelSubstitution:
						modelSubstitutionWarning?.reason === "auth_unavailable" && requestedModel
							? { requestedModel, reason: modelSubstitutionWarning.reason }
							: undefined,
					toolNames,
					alwaysActiveToolNames: ircEnabled ? ["irc"] : undefined,
					outputSchema,
					requireYieldTool: true,
					contextFiles: options.contextFiles,
					skills: options.skills,
					promptTemplates: options.promptTemplates,
					workspaceTree: options.workspaceTree,
					systemPrompt: defaultPrompt => {
						const subagentPrompt = prompt.render(subagentSystemPromptTemplate, {
							agent: prompt.render(agent.systemPrompt, {
								// Typed executionMode wins; assignment text is compatibility-only (#2698 / #2456).
								ultragoalRedTeam: resolveUltragoalRedTeamActivation({
									executionMode: options.executionMode,
									assignment: options.assignment ?? task,
								}),
							}),
							context: options.context?.trim() ?? "",
							worktree: worktree ?? "",
							outputSchema: normalizedOutputSchema,
							contextFile: contextFileForPrompt,
							ircPeers: ircEnabled ? renderIrcPeerRoster(agentRegistry, id) : "",
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
					inheritedAsyncJobManager: options.asyncJobManager,
					inheritedMcpManager: options.parentMcpManager,
					agentId: id,
					agentDisplayName: agent.name,
					agentRosterLabel: options.description,
					bashAllowedPrefixes: agent.bashAllowedPrefixes,
					enableLsp: lspEnabled,
					skipPythonPreflight,
					enableMCP,
					localProtocolOptions: options.localProtocolOptions,
					telemetry: subagentTelemetry,
					forkContextSeed,
					agentRegistry,
					shouldPause: () => pauseRequested,
				}),
			);

			activeSession = session;
			const configuredChildChain = parentFallbackSelector ? [parentFallbackSelector] : modelPatterns;
			session.setConfiguredModelChain("default", configuredChildChain, "subagent", agent.name, true);
			if (!parentFallbackSelector) {
				session.seedDefaultFallbackResolution(activeIndex ?? 0, skips);
			}
			const liveSubagentId = options.subagentId ?? id;
			const manager = options.asyncJobManager ?? AsyncJobManager.instance();
			liveHandleManager = manager ?? undefined;
			const registerLiveHandle = (): void => {
				if (options.preflightProbe || liveHandleRegistered || !manager) return;
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
				liveHandleRegistered = true;
			};
			const emitLifecycleStart = (): void => {
				if (options.preflightProbe || lifecycleStarted || !options.eventBus) return;
				options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id,
					agent: agent.name,
					agentSource: agent.source,
					description: options.description,
					status: "started",
					sessionFile: sessionFile ?? undefined,
					index,
				});
				lifecycleStarted = true;
			};
			if (!options.preflightProbe && !options.preflightDurable) {
				registerLiveHandle();
				emitLifecycleStart();
			}

			const subagentToolNames = session.getActiveToolNames();
			const parentOwnedToolNames = new Set(["todo_write"]);
			const filteredSubagentTools = subagentToolNames.filter(name => !parentOwnedToolNames.has(name));
			if (filteredSubagentTools.length !== subagentToolNames.length) {
				await awaitAbortable(session.setActiveToolsByName(filteredSubagentTools));
			}

			if (!options.preflightProbe && !options.preflightDurable) {
				session.sessionManager.appendSessionInit({
					systemPrompt: session.agent.state.systemPrompt.join("\n\n"),
					task,
					tools: session.getActiveToolNames(),
					outputSchema,
					forkContext: options.forkContextSeed?.metadata,
				});
			}

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
			// Disposable preflight probes execute an in-memory candidate session purely to observe a
			// live model provider; they are discarded at the acceptance fence, so user/session
			// extensions (session_start emits and tool wrappers) must never run against them.
			if (extensionRunner && !options.preflightProbe) {
				extensionRunner.initialize(
					{
						// Extension sends are INDEPENDENT producers (see runtime-init):
						// classify them at the trusted adapter so a terminal abort keeps
						// them rather than dropping them as turn-owned continuations.
						sendMessage: (message, options) => {
							const sendPromise = session
								.sendCustomMessage(message, { ...options, origin: "external" })
								.catch(e => {
									logger.error("Extension sendMessage failed", {
										error: e instanceof Error ? e.message : String(e),
									});
								});
							pendingExtensionMessages.push(sendPromise);
						},
						sendUserMessage: (content, options) => {
							const send = session.sendUserMessage(content, options);
							const observedSend = send.catch(e => {
								logger.error("Extension sendUserMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
							pendingExtensionMessages.push(observedSend);
							return send;
						},
						appendEntry: (customType, data) => {
							session.sessionManager.appendCustomEntry(customType, data);
						},
						setLabel: (targetId, label) => {
							session.sessionManager.appendLabelChange(targetId, label);
						},
						getActiveTools: () => session.getActiveToolNames(),
						getAllTools: () => session.getAllToolNames(),
						resolveTool: name => {
							const tool = session.getToolByName(name);
							return tool
								? { safeSummary: tool.safeSummary, safeSummaryFields: tool.safeSummaryFields }
								: undefined;
						},
						setActiveTools: (toolNames: string[]) =>
							session.setActiveToolsByName(toolNames.filter(name => !parentOwnedToolNames.has(name))),
						getCommands: () => getSessionSlashCommands(session),
						setModel: model => runExtensionSetModel(session, model),
						getThinkingLevel: () => session.thinkingLevel,
						setThinkingLevel: (level, persist) => session.setThinkingLevel(level, persist),
						getThinkingVisibility: () => session.getThinkingVisibility(),
						setThinkingVisibility: (visibility, persist) => session.setThinkingVisibility(visibility, persist),
						cycleThinkingLevel: () => session.cycleThinkingLevel(),
						setThinkingLevelForControl: (level, persist) => session.setThinkingLevelForControl(level, persist),
						setThinkingVisibilityForControl: (visibility, persist) =>
							session.setThinkingVisibilityForControl(visibility, persist),
						setModelTemporaryForControl: (model, expectedSessionId, thinkingLevel) =>
							session.setModelTemporaryForControl(model, expectedSessionId, thinkingLevel),
						fetchUsageReportsForControl: () => session.fetchUsageReportsForControl(),
						getThinkingScopeForControl: () => session.getThinkingScopeForControl(),
						getSessionName: () => session.sessionManager.getSessionName(),
						setSessionName: async name => {
							await session.sessionManager.setSessionName(name, "user");
						},
					},
					{
						getModel: () => session.model,
						getCredentialSessionId: () => session.credentialSessionId,
						isIdle: () => !session.isStreaming,
						getActivePromptHandle: () => session.activePromptHandle,
						abort: () => session.abort(),
						abortPromptAndWait: (handle, options) => session.abortPromptAndWait(handle, options),
						hasPendingMessages: () => session.queuedMessageCount > 0,
						getPendingMessageCounts: () => session.pendingMessageCounts,
						getTranscript: () => session.getTranscript(),
						getTranscriptBody: entryId => session.getTranscriptBody(entryId),
						getGoalState: () => session.getGoalModeState(),
						getTodoState: () => session.getTodoPhases(),
						getQueuedMessages: () => session.getQueuedMessageEntries(),
						getActiveTools: () => session.getActiveToolNames(),
						getAllTools: () => session.getAllToolNames(),
						resolveTool: name => {
							const tool = session.getToolByName(name);
							return tool
								? { safeSummary: tool.safeSummary, safeSummaryFields: tool.safeSummaryFields }
								: undefined;
						},
						shutdown: () => {},
						getContextUsage: () => session.getContextUsage(),
						getSystemPrompt: () => session.systemPrompt,
						compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
						clearContext: () => session.clearContext(),
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
				sessionEventOrdinal += 1;
				const eventOrdinal = sessionEventOrdinal;
				if (event.type === "auto_retry_start") {
					retryStartOrdinal = eventOrdinal;
					for (const message of session.messages) {
						if (message.role === "assistant") rememberAssistantMessage(message);
					}
					const failedAssistant = session.getLastAssistantMessage();
					progress.retryState = {
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						unbounded: event.unbounded,
						kind: classifyProviderRetryFromTransport({
							providerCode: failedAssistant?.transportFailure?.providerCode,
							errorMessage: event.errorMessage,
						}),
						provider: providerNameFromModel(
							activeProviderModelString ?? lastAssistantModelString ?? resolvedModelString,
						),
						lastProviderProgressAtMs,
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
				if (event.type === "model_fallback_switched") {
					activeProviderModelString = event.to;
					progress.fastMode = isFastForModel(session.model);
					// Keep the fallback metadata on the SAME manager the initial
					// update used: another session may have become the
					// process-global instance, and writing to it would leave this
					// session's subagent metadata stale or overwrite an unrelated
					// same-ID record (review thread P2).
					(options.asyncJobManager ?? AsyncJobManager.instance())?.updateSubagentModel?.(
						options.subagentId ?? id,
						{
							requestedModel: modelSubstitutionWarning?.requested ?? resolvedModelString,
							effectiveModel: event.to,
							modelFellBack: true,
							fastMode: progress.fastMode,
						},
					);
					scheduleProgress(true);
					forwardSubagentEvent(event);
					return;
				}
				if (isAgentEvent(event)) {
					try {
						processEvent(event, eventOrdinal);
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
			if (options.preflightProbe || options.preflightDurable) preflightOperation = "preflight_validation";
			const runMode = options.runMode ?? "initial";
			let postFencePublication: Promise<void> | undefined;
			const publishPostFence = async (): Promise<void> => {
				if (!options.preflightDurable) return;
				if (postFencePublication) return postFencePublication;
				postFencePublication = (async () => {
					if (!openedSessionManager) throw new Error("preflight session manager unavailable");
					try {
						// The staged transcript and artifacts become visible only here, at
						// the real provider acceptance fence.
						await openedSessionManager.commitStaged({ deferArtifactFinalize: true });
						session.sessionManager.appendSessionInit({
							systemPrompt: session.agent.state.systemPrompt.join("\n\n"),
							task,
							tools: session.getActiveToolNames(),
							outputSchema,
							forkContext: options.forkContextSeed?.metadata,
						});
						await openedSessionManager.refreshStagedCommitSnapshot();
						registerLiveHandle();
						emitLifecycleStart();
						openedSessionManager.finalizeStagedCommit();
					} catch (error) {
						preflightCommitFailure = true;
						try {
							await openedSessionManager.rollbackCommittedStaged();
						} catch (cleanupError) {
							throw new AggregateError(
								[toError(error), toError(cleanupError)],
								"Post-fence publication and cleanup both failed.",
							);
						}
						throw error;
					}
				})();
				return postFencePublication;
			};
			const markLlmRequestStarted = async () => {
				if (options.preflightProbe) throw new AutoroutingProbeAcceptedError();
				if (options.preflightDurable) await publishPostFence();
				llmRequestStarted = true;
				preflightFenceCrossed = true;
				options.preflightFenceCallback?.();
			};
			const promptOptions = {
				attribution: "agent" as const,
				// A prompt is an LLM request only after AgentSession accepts its
				// preflight fence. Rejections remain setup failures.
				onPreflightAccepted: markLlmRequestStarted,
				onPreflightAcceptCommit: markLlmRequestStarted,
			};
			if (runMode === "message") {
				await awaitAbortable(session.prompt(options.resumeMessage ?? "", promptOptions));
				await awaitAbortable(session.waitForIdle());
			} else if (runMode === "resume") {
				await awaitAbortable(session.prompt("Continue from the paused subagent session state.", promptOptions));
				await awaitAbortable(session.waitForIdle());
			} else {
				await awaitAbortable(session.prompt(task, promptOptions));
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
					// A terminal local (non-provider) failure carries an actionable
					// kind: surface it in the parent receipt instead of the generic
					// "Task failed; error recorded." preview (#4618). Overflow
					// summaries are built ONLY from the structured, identity-checked
					// `bufferOverflow` shape - never the free-form `errorMessage`,
					// which a foreign self-labeled error can fill with arbitrary
					// text. A self-labeled overflow WITHOUT the shape degrades to a
					// neutral sentence instead of forwarding message text.
					if (isAssistantLocalErrorKind(lastAssistant.errorKind)) {
						localErrorSummary = createLocalErrorSummary(
							lastAssistant.errorKind,
							lastAssistant.errorMessage ?? error,
							lastAssistant.bufferOverflow,
						);
					}
				}
				if (options.preflightDurable && preflightFenceCrossed) {
					const facts =
						(lastAssistant as AssistantMessage & { transportFailure?: TransportFailureFacts }).transportFailure ??
						transportFailureFacts(lastAssistant);
					preflightFailure = facts
						? { kind: "transport", class: classifyFallbackTrigger(facts).class }
						: { kind: "transport", class: "other" };
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
				assistantModelMismatch = true;
			}
		} catch (err) {
			exitCode = 1;
			if (err instanceof AutoroutingProbeAcceptedError) {
				probeAccepted = true;
				exitCode = 0;
				error = undefined;
			} else if (!abortSignal.aborted) {
				error = formatExecutionError(err);
				if (options.preflightDurable && preflightFenceCrossed) {
					const facts = transportFactsFromError(err) ?? transportFailureFacts(err);
					preflightFailure = facts
						? { kind: "transport", class: classifyFallbackTrigger(facts).class }
						: { kind: "transport", class: "other" };
				} else if (options.preflightProbe || options.preflightDurable) {
					preflightFailure = classifyAutoroutingPreflightFailure(err, preflightOperation);
				}
				if (!llmRequestStarted)
					setupFailure = createSetupFailureSummary(err instanceof AggregateError ? error : err);
			}
		} finally {
			if (options.preflightDurable && !preflightFenceCrossed && openedSessionManager) {
				try {
					await openedSessionManager.discardStaged();
				} catch (cleanupError) {
					const primary = error ?? "Autorouting preflight candidate failed before acceptance.";
					error = `${primary}\nCleanup failure: ${formatExecutionError(cleanupError)}`;
					setupFailure ??= createSetupFailureSummary(error);
					// Fail closed: a failed pre-fence discard may have left candidate-owned staging
					// residue behind, so the zero-residue guarantee no longer holds for this attempt.
					// Downgrade any transient classification to terminal so the ledger stops here
					// instead of advancing to the next candidate over unknown residue.
					preflightFailure = { kind: "local", op: "preflight_validation", transient: false };
				}
			}
			if (abortSignal.aborted) {
				aborted = abortReason === "signal" || runtimeLimitExceeded || abortReason === undefined;
				if (aborted) {
					abortReasonText ??= resolveAbortReasonText();
				}
				if (exitCode === 0) exitCode = 1;
			}
			sessionAbortController.abort();
			if (liveHandleRegistered) liveHandleManager?.removeLiveHandle(liveSubagentId);
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
			ownedModelRegistry?.dispose();
			ownedModelRegistry = undefined;
			ownedAuthStorage?.close();
			ownedAuthStorage = undefined;
		}

		return {
			exitCode,
			error,
			localErrorSummary,
			aborted,
			abortReason: aborted ? abortReasonText : undefined,
			setupFailure,
			probeAccepted,
			preflightFailure,
			preflightFenceCrossed,
			preflightCommitFailure,
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
	const finalized = finalizeSubprocessOutput({
		rawOutput,
		exitCode,
		stderr,
		terminalFailure: done.error !== undefined || Boolean(done.aborted),
		doneAborted: Boolean(done.aborted),
		signalAborted: Boolean(signal?.aborted),
		yieldItems,
		outputSchema,
	});
	rawOutput = finalized.rawOutput;
	exitCode = finalized.exitCode;
	stderr = finalized.stderr;
	let reviewFindingsRef: ReviewFindingsArtifactRef | undefined;
	let reviewFindingsPublicationFailed = false;
	if (reportFindingDetails && reportFindingDetails.length > 0) {
		try {
			const manager = options.parentArtifactManager;
			if (!manager) throw new Error("review findings artifact authority unavailable");
			reviewFindingsRef = await publishReviewFindingsArtifact(manager, id, reportFindingDetails);
		} catch {
			reviewFindingsPublicationFailed = true;
			exitCode = 1;
			stderr = REVIEW_FINDINGS_ARTIFACT_FAILURE;
			paused = false;
		}
	}
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
	// Never overwrite the artifact with empty output: a failed/no-op resume leg
	// carries no new information and must preserve the previous retained output.
	if (options.artifactsDir && rawOutput.length > 0) {
		const managedPersistence = options.managedPersistence;
		try {
			const byteSize = Buffer.byteLength(rawOutput, "utf8");
			const lineCount = rawOutput.split("\n").length;
			const sha256 = createHash("sha256").update(rawOutput).digest("hex");
			const createdAt = new Date().toISOString();
			if (!managedPersistence) await Bun.write(path.join(options.artifactsDir, `${id}.md`), rawOutput);
			const metadataBytes = Buffer.from(
				JSON.stringify({ id, kind: "agent-output", sizeBytes: byteSize, lineCount, sha256, createdAt }, null, 2),
				"utf8",
			);
			if (managedPersistence) await managedPersistence.publishOutput(rawOutput, metadataBytes);
			else await Bun.write(path.join(options.artifactsDir, `${id}.md.meta.json`), metadataBytes);
			outputMeta = {
				lineCount,
				charCount: rawOutput.length,
				byteSize,
				sha256,
			};
		} catch (error) {
			if (!managedPersistence) {
				// A missing sidecar keeps a partial immutable output invisible to agent://.
				outputMeta = undefined;
			} else {
				const message = error instanceof Error ? error.message : String(error);
				stderr = `${stderr}${stderr ? "\n" : ""}Managed output publication failed: ${message}`;
				exitCode = 1;
				paused = false;
				progress.retryFailure = { attempt: 0, errorMessage: `Managed output publication failed: ${message}` };
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
		runtimeLimitExceeded ||
		(!reviewFindingsPublicationFailed &&
			(abortedViaYield || (!hasYield && (done.aborted || signal?.aborted || false))));
	const finalAbortReason = wasAborted
		? runtimeLimitExceeded
			? resolveAbortReasonText()
			: abortedViaYield
				? yieldAbortReason
				: (done.abortReason ?? (signal?.aborted ? resolveSignalAbortReason() : resolveAbortReasonText()))
		: undefined;
	progress.setupFailure = done.setupFailure;
	progress.status = paused ? "paused" : wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	if (!options.preflightProbe) scheduleProgress(true);

	// Emit lifecycle end event after finalization so yield status is reflected
	if (lifecycleStarted && !options.preflightProbe && options.eventBus) {
		options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: agent.name,
			agentSource: agent.source,
			description: options.description,
			status: progress.status as "completed" | "failed" | "aborted" | "paused",
			sessionFile: sessionFile ?? undefined,
			index,
		});
	}

	const routingEvidence = finalizeRoutingEvidence(options.routing, {
		resolvedModelString,
		lastAssistantModelString,
		authFallbackUsed,
		assistantModelMismatch,
	});

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
		routing: routingEvidence,
		contextWindow: progress.contextWindow,
		modelOverride,
		modelSubstitutionWarning,
		fastMode: progress.fastMode,
		error: exitCode !== 0 && stderr ? stderr : undefined,
		setupFailure: done.setupFailure,
		localErrorSummary: done.localErrorSummary,
		preflightFailure: done.preflightFailure,
		preflightFenceCrossed: done.preflightFenceCrossed,
		preflightCommitFailure: done.preflightCommitFailure,
		preflightProbeAccepted: done.probeAccepted,
		aborted: wasAborted,
		abortReason: finalAbortReason,
		paused,
		usage: hasUsage ? accumulatedUsage : undefined,
		usageCostBreakdownComplete: hasUsage && usageCostBreakdownComplete ? true : undefined,
		outputPath: undefined,
		extractedToolData: progress.extractedToolData,
		retryFailure: progress.retryFailure,
		outputMeta,
		reviewFindingsRef,
	};
}

export function boundedSelector(value: string): string {
	const bounded = value
		.normalize("NFKC")
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "")
		.slice(0, AUTOROUTING_SELECTOR_MAX_LENGTH);
	return bounded || "<omitted-selector>";
}

export function buildBoundedRoutingSkips(
	skips: ExecutorOptions["autoroutingSkips"],
): Pick<TaskRoutingEvidence, "skips" | "omittedSkipCount" | "omittedByCode"> {
	if (!skips || skips.length === 0) return {};
	const retained = skips.slice(0, 16).map(skip => ({ selector: boundedSelector(skip.selector), code: skip.code }));
	const omitted = skips.slice(16);
	const omittedByCode: NonNullable<TaskRoutingEvidence["omittedByCode"]> = {};
	for (const skip of omitted) omittedByCode[skip.code] = (omittedByCode[skip.code] ?? 0) + 1;
	return {
		skips: retained,
		...(omitted.length > 0 ? { omittedSkipCount: omitted.length, omittedByCode } : {}),
	};
}

function evidenceWithAttempts(
	routing: TaskRoutingEvidence | undefined,
	attempts: readonly AutoroutingAttempt[],
	terminal?: TaskRoutingEvidence["terminal"],
): TaskRoutingEvidence | undefined {
	if (!routing) return undefined;
	const evidence: TaskRoutingEvidence = {
		...routing,
		requestedSelector: boundedSelector(routing.requestedSelector),
		attempts: attempts.map(attempt => ({ ...attempt, selector: boundedSelector(attempt.selector) })),
		...(terminal ? { terminal, notExecuted: true, effectiveModel: undefined } : {}),
	};
	assertRoutingEvidenceInvariant(evidence);
	return evidence;
}

function preflightTerminalResult(
	options: ExecutorOptions,
	attempts: readonly AutoroutingAttempt[],
	terminal: "preflight_exhausted" | "all_candidates_skipped",
	prior?: SingleResult,
): SingleResult {
	const result: SingleResult = prior
		? { ...prior }
		: {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				assignment: options.assignment,
				description: options.description,
				exitCode: 1,
				output: "",
				stderr: "Autorouting preflight exhausted.",
				truncated: false,
				durationMs: 0,
				tokens: 0,
			};
	// Preserve a diagnostic from the last attempt so terminalization does not erase why the candidate
	// failed (including an appended pre-fence cleanup failure). It MUST go through
	// createSetupFailureSummary, the established egress sanitizer: it redacts authorization/cookie
	// headers, URL credentials, API-key labels, bare provider tokens and local/Windows absolute paths,
	// collapses all whitespace (so CR/LF/TAB cannot survive for newline injection), and caps length.
	// Never interpolate a raw `error` string here — it may carry a full stack with secrets or paths.
	const rawDiagnostic =
		typeof prior?.error === "string" && prior.error.trim().length > 0
			? prior.error
			: (prior?.setupFailure?.summary ?? "");
	const sanitizedDiagnostic = rawDiagnostic.trim() ? createSetupFailureSummary(rawDiagnostic).summary : "";
	const priorDiagnostic =
		sanitizedDiagnostic && sanitizedDiagnostic !== "Subagent setup failed." ? sanitizedDiagnostic : "";
	result.exitCode = 1;
	result.output = "";
	result.stderr = priorDiagnostic
		? `Autorouting preflight exhausted. Last candidate diagnostic: ${priorDiagnostic}`
		: "Autorouting preflight exhausted.";
	result.error = result.stderr;
	result.setupFailure = {
		summary: priorDiagnostic
			? `Autorouting preflight did not accept a candidate. Last candidate diagnostic: ${priorDiagnostic}`
			: "Autorouting preflight did not accept a candidate.",
	};
	result.routing = evidenceWithAttempts(options.routing, attempts, terminal);
	return result;
}

/** Run routed initial tasks through the bounded probe/durable candidate ledger. */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	if (
		!options.autoroutingPreflight ||
		(options.runMode ?? "initial") !== "initial" ||
		!options.autoroutingCandidates
	) {
		return runSubprocessOnce(options);
	}
	const attempts: AutoroutingAttempt[] = [];
	const consumed = new Set<string>();
	const skips = buildBoundedRoutingSkips(options.autoroutingSkips);
	// Candidates were already validated and pinned against the live model snapshot by
	// normalizeTierSelector before reaching here. boundedSelector is an evidence/telemetry
	// sanitizer (NFKC normalization, control-char stripping, 256-char truncation) meant for
	// text that gets rendered or persisted; running it on the live selector could compose
	// characters differently or truncate a long-but-valid selector, sending execution to a
	// model that never passed preflight. Only bound the copies that reach evidence/telemetry
	// (attempts, skips, requestedSelector), never the selector actually used for modelOverride.
	const candidates = options.autoroutingCandidates.filter(selector => selector.length > 0);
	const durablePublicationAvailable =
		options.managedPersistence !== undefined ||
		(typeof options.sessionFile === "string" && options.sessionFile.length > 0);
	const routedOptions = options.routing ? { ...options.routing, ...skips } : options.routing;
	if (candidates.length === 0)
		return preflightTerminalResult({ ...options, routing: routedOptions }, attempts, "all_candidates_skipped");
	let prior: SingleResult | undefined;
	for (const selector of candidates) {
		if (consumed.has(selector) || consumed.size >= 3) continue;
		consumed.add(selector);
		if (options.autoroutingPreflightErrors?.has(selector)) {
			const preflightError = options.autoroutingPreflightErrors.get(selector);
			const failure = classifyAutoroutingPreflightFailure(preflightError, "auth_resolve");
			const { code } = autoroutingAttemptDisposition(failure);
			attempts.push({ selector, phase: "probe", code });
			return preflightTerminalResult({ ...options, routing: routedOptions }, attempts, "preflight_exhausted");
		}
		const probe = await runSubprocessOnce({
			...options,
			autoroutingPreflight: false,
			preflightProbe: true,
			preflightDurable: false,
			modelOverride: [selector],
			parentActiveModelPattern: undefined,
			autoroutingCandidates: undefined,
			autoroutingSkips: undefined,
			sessionFile: null,
			artifactsDir: undefined,
			persistArtifacts: false,
			managedPersistence: undefined,
			parentArtifactManager: undefined,
			routing: undefined,
		});
		prior = probe;
		if (!probe.preflightProbeAccepted) {
			const failure = probe.preflightFailure ?? { kind: "local", op: "preflight_validation", transient: false };
			const { code, advance } = autoroutingAttemptDisposition(failure);
			attempts.push({ selector, phase: "probe", code });
			if (!advance)
				return preflightTerminalResult(
					{ ...options, routing: routedOptions },
					attempts,
					"preflight_exhausted",
					probe,
				);
			continue;
		}
		attempts.push({ selector, phase: "probe", code: "probe_passed" });
		const durable = await runSubprocessOnce({
			...options,
			autoroutingPreflight: false,
			preflightProbe: false,
			// A synchronous Task may have no child transcript or artifact authority. In
			// that case there is nothing durable to publish at the provider fence, so
			// execute the accepted candidate through the artifact-only path instead of
			// asking an in-memory SessionManager to commit a nonexistent staged session.
			preflightDurable: durablePublicationAvailable,
			autoroutingAttemptId: `${options.id}-${consumed.size}`,
			modelOverride: [selector],
			parentActiveModelPattern: undefined,
			autoroutingCandidates: undefined,
			autoroutingSkips: undefined,
			routing: routedOptions,
		});
		prior = durable;
		if (durable.preflightCommitFailure) {
			attempts.push({ selector, phase: "durable", code: "post_acceptance_failure" });
			return { ...durable, routing: evidenceWithAttempts(durable.routing ?? routedOptions, attempts) };
		}
		if (durable.preflightFenceCrossed) {
			if (durable.exitCode === 0) {
				attempts.push({ selector, phase: "durable", code: "accepted" });
				return { ...durable, routing: evidenceWithAttempts(durable.routing ?? routedOptions, attempts) };
			}
			attempts.push({ selector, phase: "durable", code: "post_acceptance_failure" });
			return { ...durable, routing: evidenceWithAttempts(durable.routing ?? routedOptions, attempts) };
		}
		const failure = durable.preflightFailure ?? { kind: "local", op: "preflight_validation", transient: false };
		const { code, advance } = autoroutingAttemptDisposition(failure);
		attempts.push({ selector, phase: "durable", code });
		if (!advance)
			return preflightTerminalResult(
				{ ...options, routing: routedOptions },
				attempts,
				"preflight_exhausted",
				durable,
			);
	}
	return preflightTerminalResult({ ...options, routing: routedOptions }, attempts, "preflight_exhausted", prior);
}
