/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	AgentBusyError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	AppendOnlyContextManager,
	resolveTelemetry,
	type StablePrefixSnapshot,
	ThinkingLevel,
} from "@gajae-code/agent-core";
import { normalizeMessagesForProvider } from "@gajae-code/agent-core/agent-loop";
import {
	AUTO_HANDOFF_THRESHOLD_FOCUS,
	CompactionCancelledError,
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	calculatePromptTokens,
	collectEntriesForBranchSummary,
	compact,
	type EmergencyCompactionSample,
	emergencyCompactionReason,
	estimateMessageTokensHeuristic,
	generateBranchSummary,
	generateHandoff,
	prepareCompaction,
	type SummaryOptions,
	shouldCompact,
} from "@gajae-code/agent-core/compaction";
import { DEFAULT_PRUNE_CONFIG, pruneToolOutputs } from "@gajae-code/agent-core/compaction/pruning";
import type {
	AssistantMessage,
	Context,
	Effort,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	ToolChoice,
	Usage,
	UsageReport,
} from "@gajae-code/ai";
import {
	calculateRateLimitBackoffMs,
	clearAnthropicFastModeFallback,
	getSupportedEfforts,
	isContextOverflow,
	isUsageLimitError,
	modelsAreEqual,
	parseRateLimitReason,
	resolveServiceTier,
	streamSimple,
} from "@gajae-code/ai";

export interface ForkContextSeedMetadata {
	sourceSessionId: string;
	parentMessageCount: number;
	includedMessages: number;
	skippedMessages: number;
	approximateTokens: number;
	maxMessages: number;
	maxTokens: number;
	skippedReasons: Record<string, number>;
}

export interface PurgeQueuedCustomMessagesResult {
	agentSteering: number;
	agentFollowUp: number;
	pendingNextTurn: number;
	displaySteering: number;
	displayFollowUp: number;
	totalExecutable: number;
}

export interface ForkContextSeed {
	messages: Message[];
	agentMessages: AgentMessage[];
	metadata: ForkContextSeedMetadata;
	cacheIdentity?: string;
	appendOnlyPrefixSnapshot?: StablePrefixSnapshot;
}

export interface ForkContextSeedOptions {
	maxMessages: number;
	maxTokens: number;
	cacheIdentity?: string;
	signal?: AbortSignal;
}

import { MacOSPowerAssertion } from "@gajae-code/natives";
import {
	extractRetryHint,
	isEnoent,
	isUnexpectedSocketCloseMessage,
	logger,
	prompt,
	Snowflake,
} from "@gajae-code/utils";
import { type AsyncJob, type AsyncJobDeliveryState, AsyncJobManager } from "../async";
import { reset as resetCapabilities } from "../capability";
import type { Rule } from "../capability/rule";
import { MODEL_ROLE_IDS, type ModelRegistry } from "../config/model-registry";
import {
	extractExplicitThinkingSelector,
	formatModelSelectorValue,
	formatModelString,
	parseModelString,
	type ResolvedModelRoleValue,
	resolveModelRoleValue,
	type ScopedModelSelection,
} from "../config/model-resolver";
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import { onAppendOnlyModeChanged } from "../config/settings";
import { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { loadCapability } from "../discovery";
import { expandApplyPatchToEntries, normalizeDiff, normalizeToLF, ParseError, previewPatch, stripBom } from "../edit";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import {
	disposeKernelSessionsByOwner,
	executePython as executePythonCommand,
	type PythonResult,
} from "../eval/py/executor";
import { type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor";
import { exportSessionToHtml } from "../export/html";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import type {
	ExtensionCommandContext,
	ExtensionRunner,
	ExtensionUIContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
} from "../extensibility/extensions";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import type { LoadedSubskillActivation } from "../extensibility/gjc-plugins";
import { resolveCurrentPhaseForParent } from "../extensibility/gjc-plugins/injection";
import { readActiveSubskillsForParent, toActiveSubskillEntry } from "../extensibility/gjc-plugins/state";
import { loadActiveSubskillTools } from "../extensibility/gjc-plugins/tools";
import type { HookCommandContext } from "../extensibility/hooks/types";
import type { Skill, SkillWarning } from "../extensibility/skills";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { buildGjcRuntimeSessionEnv, consumePendingGoalModeRequest } from "../gjc-runtime/goal-mode-request";
import {
	assertNonEmptyGjcSessionId,
	modeStatePath as sessionModeStatePath,
	sessionStateDir,
} from "../gjc-runtime/session-layout";
import { persistCoordinatorRuntimeStateFromEvent } from "../gjc-runtime/session-state-sidecar";
import { writeArtifact } from "../gjc-runtime/state-writer";
import { requestGjcWorkerIntegrationAttempt } from "../gjc-runtime/team-runtime";
import { GoalRuntime } from "../goals/runtime";
import type { Goal, GoalModeState } from "../goals/state";
import type { HindsightSessionState } from "../hindsight/state";
import { ensureWorkflowSkillActivationState } from "../hooks/skill-state";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import { shutdownAll as shutdownAllLspClients } from "../lsp/client";
import { resolveMemoryBackend } from "../memory-backend";
import type { WorkflowGateEmitter } from "../modes/shared/agent-wire/unattended-session";
import { getCurrentThemeName, theme } from "../modes/theme/theme";
import type { PlanModeState } from "../plan-mode/state";
import autoContinuePrompt from "../prompts/system/auto-continue.md" with { type: "text" };
import eagerTodoPrompt from "../prompts/system/eager-todo.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import planModeActivePrompt from "../prompts/system/plan-mode-active.md" with { type: "text" };
import planModeReferencePrompt from "../prompts/system/plan-mode-reference.md" with { type: "text" };
import planModeToolDecisionReminderPrompt from "../prompts/system/plan-mode-tool-decision-reminder.md" with {
	type: "text",
};
import ttsrInterruptTemplate from "../prompts/system/ttsr-interrupt.md" with { type: "text" };
import ttsrToolReminderTemplate from "../prompts/system/ttsr-tool-reminder.md" with { type: "text" };
import { type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import {
	buildDiscoverableMCPSearchIndex,
	collectDiscoverableMCPTools,
	type DiscoverableMCPSearchIndex,
	type DiscoverableMCPTool,
	isMCPBridgeTool,
	isMCPToolName,
	selectDiscoverableMCPToolNamesByServer,
} from "../runtime-mcp/discoverable-tool-metadata";
import { MCPManager } from "../runtime-mcp/manager";
import { deobfuscateSessionContext, type SecretObfuscator } from "../secrets/obfuscator";
import { formatNoCredentialOnboardingError, formatNoModelOnboardingError } from "../setup/model-onboarding-guidance";
import {
	isCanonicalGjcWorkflowSkill,
	readVisibleSkillActiveState,
	syncSkillActiveState,
} from "../skill-state/active-state";
import { assertWorkflowMutationAllowed } from "../skill-state/deep-interview-mutation-guard";
import { invalidateHostMetadata } from "../ssh/connection-manager";
import { resolveThinkingLevelForModel, toReasoningEffort } from "../thinking";
import {
	buildDiscoverableToolSearchIndex,
	collectDiscoverableTools,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
} from "../tool-discovery/tool-index";
import type { AskAnswerSource, ToolSession } from "../tools";
import { AskTool } from "../tools/ask";
import { getAskAnswerSource as getAskAnswerSourceFromRegistry } from "../tools/ask-answer-registry";
import { assertEditableFile } from "../tools/auto-generated-guard";
import { releaseTabsForOwner } from "../tools/browser/tab-supervisor";
import type { CheckpointState } from "../tools/checkpoint";
import { outputMeta, wrapToolWithMetaNotice } from "../tools/output-meta";
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";
import { getLatestTodoPhasesFromEntries, type TodoItem, type TodoPhase } from "../tools/todo-write";
import { ToolAbortError, ToolError } from "../tools/tool-errors";
import { clampTimeout } from "../tools/tool-timeouts";
import { guardToolForUltragoalAsk } from "../tools/ultragoal-ask-guard";
import { parseCommandArgs } from "../utils/command-args";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { extractFileMentions, generateFileMentionMessages } from "../utils/file-mentions";
import { buildNamedToolChoice, buildNamedToolChoiceResult } from "../utils/tool-choice";
import type { AuthStorage } from "./auth-storage";
import type { ClientBridge, ClientBridgePermissionOption, ClientBridgePermissionOutcome } from "./client-bridge";
import {
	type ContributionPrepOptions,
	type ContributionPrepResult,
	prepareContributionPrep,
} from "./contribution-prep";
import {
	type BashExecutionMessage,
	type CompactionSummaryMessage,
	type CustomMessage,
	convertToLlm,
	type FileMentionMessage,
	type PythonExecutionMessage,
	readPendingDisplayTag,
	SILENT_ABORT_MARKER,
	SKILL_PROMPT_MESSAGE_TYPE,
} from "./messages";
import { formatSessionDumpText } from "./session-dump-format";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	NewSessionOptions,
	SessionContext,
	SessionManager,
} from "./session-manager";
import { getLatestCompactionEntry } from "./session-manager";
import { ToolChoiceQueue } from "./tool-choice-queue";
import { YieldQueue } from "./yield-queue";

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| AgentEvent
	| { type: "auto_compaction_start"; reason: "threshold" | "overflow" | "idle"; action: "context-full" | "handoff" }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "handoff";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason (no model, no candidates, nothing to compact). */
			skipped?: boolean;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			unbounded?: boolean;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| { type: "thinking_level_changed"; thinkingLevel: ThinkingLevel | undefined }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState };

function isUnderProjectGjc(cwd: string, targetPath: string): boolean {
	const relative = path.relative(path.join(path.resolve(cwd), ".gjc"), path.resolve(targetPath));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
export type AsyncJobSnapshotItem = Pick<
	AsyncJob,
	"id" | "type" | "status" | "label" | "startTime" | "endTime" | "metadata"
>;

export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
	delivery: AsyncJobDeliveryState;
}

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: ScopedModelSelection[];
	/** Initial session thinking selector. */
	thinkingLevel?: ThinkingLevel;
	/** Prompt templates for expansion */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands for expansion */
	slashCommands?: FileSlashCommand[];
	/** Extension runner (created in main.ts with wrapped tools) */
	extensionRunner?: ExtensionRunner;
	/** Loaded skills (already discovered by SDK) */
	skills?: Skill[];
	/** Skill loading warnings (already captured by SDK) */
	skillWarnings?: SkillWarning[];
	/** Custom commands (TypeScript slash commands) */
	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Task recursion depth for nested sessions. Top-level sessions use 0. */
	taskDepth?: number;
	/** Tool registry for LSP and settings */
	toolRegistry?: Map<string, AgentTool>;
	/** Tool-session factory context used to lazily attach workflow-gate-only tools. */
	workflowGateToolSession?: ToolSession;
	/** Current session pre-LLM message transform pipeline */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	/** Provider payload hook used by the active session request path */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** Provider response hook used by the active session request path */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** Raw SSE hook used by the active session request path */
	onSseEvent?: SimpleStreamOptions["onSseEvent"];
	/** Per-session raw SSE diagnostic buffer */
	rawSseDebugBuffer?: RawSseDebugBuffer;
	/** Current session message-to-LLM conversion pipeline */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** System prompt builder that can consider tool availability. Returns ordered provider-facing blocks. */
	rebuildSystemPrompt?: (toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>;
	/** Rebuild the SSH tool from current capability discovery results. */
	reloadSshTool?: () => Promise<AgentTool | null>;
	requestedToolNames?: ReadonlySet<string>;
	/** Optional per-session allowlist for tools exposed through search_tool_bm25. */
	discoverableToolAllowedNames?: readonly string[];
	/**
	 * Optional accessor for live MCP server instructions. Read by the session's
	 * `rebuildSystemPrompt`-skip optimization to detect server-side instruction
	 * changes (e.g. an MCP server upgrade) that would otherwise pass the tool-set
	 * signature comparison and silently keep a stale prompt cached.
	 */
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	/** Enable hidden-by-default MCP tool discovery for this session. */
	mcpDiscoveryEnabled?: boolean;
	/** MCP tool names to activate for the current session when discovery mode is enabled. */
	initialSelectedMCPToolNames?: string[];
	/** Whether constructor-provided MCP defaults should be persisted immediately. */
	persistInitialMCPToolSelection?: boolean;
	/** MCP server names whose tools should seed discovery-mode sessions whenever those servers are connected. */
	defaultSelectedMCPServerNames?: string[];
	/** MCP tool names that should seed brand-new sessions created from this AgentSession. */
	defaultSelectedMCPToolNames?: string[];
	/** TTSR manager for time-traveling stream rules */
	ttsrManager?: TtsrManager;
	/** Secret obfuscator for deobfuscating streaming edit content */
	obfuscator?: SecretObfuscator;
	/** Logical owner for retained Python kernels created by this session. */
	evalKernelOwnerId?: string;
	/**
	 * AsyncJobManager that this session installed as the process-global instance.
	 * Only set for top-level sessions; subagents inherit the parent's manager and
	 * **MUST NOT** dispose it on their own teardown.
	 */
	ownedAsyncJobManager?: AsyncJobManager;
	/** Optional fork-context seed used to initialize a child session before its first prompt. */
	forkContextSeed?: ForkContextSeed;
	/** Optional provider state override. Fork-context children should omit this by default. */
	providerSessionState?: Map<string, ProviderSessionState>;
	/** Agent identity (registry id like "0-Main" or "3-Alice") used for IRC routing. */
	agentId?: string;
	/** Shared agent registry (for forwarding IRC observations to the main session UI). */
	agentRegistry?: AgentRegistry;
	/**
	 * Override the provider-facing session ID for all API requests from this session.
	 * When absent, `sessionManager.getSessionId()` is used. Needed when benchmark or
	 * SDK callers issue probes / prewarming with an explicit `--provider-session-id`
	 * so that credential sticky selection is consistent with the session's streaming calls.
	 */
	providerSessionId?: string;
	/** Optional provider-facing cache identity, distinct from logical session identity. */
	providerCacheSessionId?: string;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). */
	streamingBehavior?: "steer" | "followUp";
	/** Optional tool choice override for the next LLM call. */
	toolChoice?: ToolChoice;
	/** Send as developer/system message instead of user. Providers that support it use the developer role; others fall back to user. */
	synthetic?: boolean;
	/** Explicit billing/initiator attribution for the prompt. Defaults to user prompts as `user` and synthetic prompts as `agent`. */
	attribution?: MessageAttribution;
	/** Skip pre-send compaction checks for this prompt (internal use for maintenance flows). */
	skipCompactionCheck?: boolean;
}

/** Result from a handoff operation. */
export interface HandoffResult {
	document: string;
	savedPath?: string;
}

export interface SessionHandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Result from cycleRoleModels() */
export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
}

/** Internal marker for hook messages queued through the agent loop */
// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */

type RetryFallbackChains = Record<string, string[]>;

type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

interface ActiveRetryFallbackState {
	role: string;
	originalSelector: string;
	originalThinkingLevel: ThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ThinkingLevel | undefined;
}

function parseRetryFallbackSelector(selector: string): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed);
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: parsed.thinkingLevel,
	};
}

function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	const selector = formatModelString(model);
	return thinkingLevel ? `${selector}:${thinkingLevel}` : selector;
}

function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

const IRC_REPLY_MAX_BYTES = 4096;

/**
 * Hard cap for {@link AgentSession.disposeChildSubprocesses}. A `SIGINT`/`SIGTERM` handler
 * awaits this teardown before exiting, so it must never block longer than this even if a
 * subprocess (wedged Chrome renderer, stuck Python cell) refuses to settle.
 */
const SIGNAL_TEARDOWN_TIMEOUT_MS = 5_000;

/**
 * Collapse degenerate IRC ephemeral replies before they hit the relay.
 * Models occasionally loop on a single line (~16 reports of N-times-repeated
 * replies); compress runs longer than 3 down to one instance + `[…N×]`, then
 * cap at 4 KiB so a runaway reply can't flood the channel.
 */
function dedupeIrcReply(text: string): string {
	if (!text) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const runLen = j - i;
		if (runLen > 3) {
			out.push(lines[i], `[…${runLen}×]`);
		} else {
			for (let k = 0; k < runLen; k++) out.push(lines[i]);
		}
		i = j;
	}
	let result = out.join("\n");
	if (Buffer.byteLength(result, "utf8") > IRC_REPLY_MAX_BYTES) {
		// Trim by characters until we're under the byte budget — handles multi-byte
		// glyphs at the boundary without splitting them.
		const suffix = "\n[…truncated]";
		const budget = IRC_REPLY_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
		while (Buffer.byteLength(result, "utf8") > budget) {
			result = result.slice(0, -1);
		}
		result += suffix;
	}
	return result;
}

/**
 * Build the per-request `metadata` payload for the Anthropic provider, shaped
 * like real Anthropic Code's `getAPIMetadata` output (`{ session_id, account_uuid,
 * device_id }`) so the backend buckets requests under one session and attributes
 * them to the authenticated OAuth account when available. Resolved at request
 * time so token refreshes and login/logout transitions don't strand a stale
 * account UUID in memory. `account_uuid` and `device_id` are omitted for
 * non-Anthropic providers to avoid leaking the user's Anthropic model identity to
 * third-party APIs (including Anthropic-format-compatible proxies such as
 * cloudflare-ai-gateway or gitlab-duo).
 *
 * `provider` is the target provider string (e.g. `"anthropic"`) and gates the
 * `account_uuid` and `device_id` lookups — only `"anthropic"` requests carry them.
 *
 * `sessionId` is forwarded to the auth-storage session-sticky lookup so that
 * multi-credential setups attribute to the same OAuth account used for the
 * actual API request rather than always picking the first credential.
 *
 * `authStorage` is treated as optional so test fixtures that stub `modelRegistry`
 * without a real storage layer still work; the resolver simply skips the lookup
 * and emits `{ session_id }` alone, matching the no-OAuth-credential path.
 */
function buildSessionMetadata(
	sessionId: string,
	provider: string,
	authStorage: AuthStorage | undefined,
): Record<string, unknown> {
	const userId: Record<string, string> = { session_id: sessionId };
	// Only look up account_uuid when the request is going to Anthropic. Injecting
	// a Anthropic model OAuth account_uuid into requests bound for other providers (including
	// Anthropic-format-compatible proxies like cloudflare-ai-gateway or gitlab-duo)
	// would leak the user's Anthropic identity to unrelated third-party APIs.
	if (provider === "anthropic") {
		const accountUuid = authStorage?.getOAuthAccountId("anthropic", sessionId);
		if (typeof accountUuid === "string" && accountUuid.length > 0) {
			userId.account_uuid = accountUuid;
			// Derive device_id from account_uuid so the payload matches the real CC
			// getAPIMetadata shape without hardware fingerprinting. A SHA-256 of a
			// namespaced account UUID produces a stable 64-hex value that is
			// indistinguishable from a randomly generated device ID on the wire, is
			// deterministic per account (survives reinstalls), and is auditable: it
			// is derived solely from the OAuth UUID the user already consented to
			// share with Anthropic. Omitted when no OAuth credential is available
			// (API-key callers) to avoid sending a hash of an empty string.
			userId.device_id = crypto.createHash("sha256").update(`gjc-device-id-v1:${accountUuid}`).digest("hex");
		}
	}
	return { user_id: JSON.stringify(userId) };
}

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: _theme => Promise.resolve({ success: false, error: "UI not available" }),
	setFooter: () => {},
	setHeader: () => {},
	setEditorComponent: () => {},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

function createHandoffContext(document: string): string {
	return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}

// ============================================================================
// ACP Permission Gate
// ============================================================================

/** Tools that require user permission before execution when an ACP client is connected. */
const PERMISSION_REQUIRED_TOOLS = new Set(["bash", "monitor", "edit", "delete", "move"]);

function isShellExecutionPermissionTool(toolName: string): boolean {
	return toolName === "bash" || toolName === "monitor";
}

/** Permission options presented to the client on each gated tool call. */
const PERMISSION_OPTIONS: ClientBridgePermissionOption[] = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

const PERMISSION_OPTIONS_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option]));

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function collectStringPaths(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getEditDestructiveIntent(args: unknown): { kind: "delete" | "move"; paths: string[] } | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const a = args as Record<string, unknown>;

	const edits = Array.isArray(a.edits) ? a.edits : undefined;
	if (edits) {
		const path = getStringProperty(a, "path");
		if (path) {
			for (const edit of edits) {
				if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
				const op = getStringProperty(edit as Record<string, unknown>, "op");
				if (op === "delete") return { kind: "delete", paths: [path] };
			}
		}
		for (const edit of edits) {
			if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
			const entry = edit as Record<string, unknown>;
			const op = getStringProperty(entry, "op");
			const rename = getStringProperty(entry, "rename");
			if (op !== "create" && rename) return { kind: "move", paths: path ? [path, rename] : [rename] };
		}
	}

	const input = getStringProperty(a, "input");
	if (input) {
		try {
			const entries = expandApplyPatchToEntries({ input });
			const deleteEntry = entries.find(entry => entry.op === "delete");
			if (deleteEntry) return { kind: "delete", paths: [deleteEntry.path] };
			const moveEntry = entries.find(entry => entry.rename);
			if (moveEntry?.rename) return { kind: "move", paths: [moveEntry.path, moveEntry.rename] };
		} catch {
			// If the edit input is not an apply_patch envelope, it is not a delete/move operation.
		}
	}

	return undefined;
}

function getPermissionIntent(
	toolName: string,
	args: unknown,
): { toolName: string; title: string; paths?: string[]; cacheKey: string } | undefined {
	const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
	if (isShellExecutionPermissionTool(toolName)) {
		const cmd = getStringProperty(a, "command")?.slice(0, 80);
		return { toolName, title: cmd || toolName, cacheKey: toolName };
	}
	if (toolName === "delete") {
		const p = getStringProperty(a, "path");
		return { toolName, title: p ? `Delete ${p}` : toolName, paths: p ? [p] : undefined, cacheKey: toolName };
	}
	if (toolName === "move") {
		const from = getStringProperty(a, "oldPath") ?? getStringProperty(a, "path") ?? getStringProperty(a, "from");
		const to = getStringProperty(a, "newPath") ?? getStringProperty(a, "to") ?? getStringProperty(a, "destination");
		if (from && to) return { toolName, title: `Move ${from} to ${to}`, paths: [from, to], cacheKey: toolName };
		return {
			toolName,
			title: from ? `Move ${from}` : toolName,
			paths: from ? [from] : undefined,
			cacheKey: toolName,
		};
	}
	if (toolName === "edit") {
		const intent = getEditDestructiveIntent(args);
		if (!intent) return undefined;
		if (intent.kind === "delete") {
			return {
				toolName,
				title: `Delete ${intent.paths[0] ?? "edit target"}`,
				paths: intent.paths,
				cacheKey: "edit:delete",
			};
		}
		const from = intent.paths[0];
		const to = intent.paths[1];
		return {
			toolName,
			title: from && to ? `Move ${from} to ${to}` : `Move ${from ?? to ?? "edit target"}`,
			paths: intent.paths,
			cacheKey: "edit:move",
		};
	}
	return undefined;
}

function extractPermissionLocations(
	args: unknown,
	cwd: string,
	explicitPaths?: string[],
): { path: string; line?: number }[] {
	if (!args || typeof args !== "object") return [];
	const a = args as Record<string, unknown>;
	const out: { path: string; line?: number }[] = [];
	const pushPath = (value: unknown) => {
		if (typeof value !== "string" || value.length === 0) return;
		// ACP locations carry file paths that the editor host will open or focus;
		// they must be absolute or the client cannot resolve them. Resolve raw
		// tool args (often cwd-relative) against the session cwd before sending.
		let resolved: string;
		try {
			resolved = resolveToCwd(value, cwd);
		} catch {
			return;
		}
		if (out.some(location => location.path === resolved)) return;
		out.push({ path: resolved });
	};
	if (explicitPaths) {
		for (const p of explicitPaths) {
			pushPath(p);
		}
		return out;
	}
	pushPath(a.path);
	pushPath(a.file);
	for (const p of collectStringPaths(a.paths)) {
		pushPath(p);
	}
	pushPath(a.oldPath);
	pushPath(a.newPath);
	pushPath(a.from);
	pushPath(a.to);
	pushPath(a.source);
	pushPath(a.destination);
	return out;
}

// ============================================================================
// AgentSession Class
// ============================================================================

/** Internal record stored in the steering/followUp display queues. The optional
 *  `tag` is set only by `enqueueCustomMessageDisplay` (used for skill-prompt
 *  custom messages queued during streaming) and is matched by the custom-role
 *  `message_start` dequeue branch; user-message pushes leave it undefined and
 *  rely on the existing text-equality match. */
type QueuedDisplayEntry = { text: string; tag?: string };

/** A custom message contributed at the before-agent-start point. */
export type BeforeAgentStartInternalMessage = Pick<
	CustomMessage,
	"customType" | "content" | "display" | "details" | "attribution"
>;

type ProviderReplaySourceCacheEntry = { source: string; hash: bigint };

/**
 * Internal (first-party, non-user-hook) contributor invoked at the active
 * before-agent-start point alongside the extension runner. Returns an optional
 * custom message to append to the prompt context. Errors are nonfatal.
 */
export type BeforeAgentStartContributor = (event: {
	prompt: string;
	images?: ImageContent[];
	sessionId: string | undefined;
}) => Promise<BeforeAgentStartInternalMessage | undefined>;

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly taskDepth: number;
	readonly yieldQueue: YieldQueue;

	#powerAssertion: MacOSPowerAssertion | undefined;

	readonly configWarnings: string[] = [];

	#scopedModels: ScopedModelSelection[];
	#thinkingLevel: ThinkingLevel | undefined;
	#activeModelProfile: string | undefined;
	#promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];

	// Event subscription state
	#unsubscribeAgent?: () => void;
	#unsubscribeAppendOnly?: () => void;
	/** Last (enable, providerId) tuple resolved by `#syncAppendOnlyContext` — used to skip no-op invalidations. */
	#lastAppendOnlyResolution?: { enable: boolean; providerId: string | undefined };
	#eventListeners: AgentSessionEventListener[] = [];

	/** Tracks pending steering messages for UI display. Removed when delivered.
	 *  Entry shape: `{ text }` for plain-text steers (user-message dequeue
	 *  matches by `.text`); `{ text, tag }` for queued custom messages (skill
	 *  invocations dispatched while streaming) — the custom-role dequeue
	 *  matches by `.tag` so duplicate-args queued skills cannot collide. */
	#steeringMessages: QueuedDisplayEntry[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered.
	 *  See `#steeringMessages` for entry shape. */
	#followUpMessages: QueuedDisplayEntry[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	#pendingNextTurnMessages: CustomMessage[] = [];
	#scheduledHiddenNextTurnGeneration: number | undefined = undefined;
	#planModeState: PlanModeState | undefined;
	#goalModeState: GoalModeState | undefined;
	#workflowGateEmitter: WorkflowGateEmitter | undefined;
	#goalRuntime: GoalRuntime;
	#goalTurnCounter = 0;
	#planReferenceSent = false;
	#planReferencePath = "local://PLAN.md";
	#clientBridge: ClientBridge | undefined;
	#allowAcpAgentInitiatedTurns = false;
	/** Per-session memory of allow_always / reject_always decisions for gated tools. */
	#acpPermissionDecisions: Map<string, "allow_always" | "reject_always"> = new Map();

	// Compaction state
	#compactionAbortController: AbortController | undefined = undefined;
	#autoCompactionAbortController: AbortController | undefined = undefined;
	#resourceSampler: () => EmergencyCompactionSample = () => this.#defaultResourceSample();
	#prePromptContextCheckPromise: Promise<void> | undefined = undefined;

	// Branch summarization state
	#branchSummaryAbortController: AbortController | undefined = undefined;

	// Handoff state
	#handoffAbortController: AbortController | undefined = undefined;
	#skipPostTurnMaintenanceAssistantTimestamp: number | undefined = undefined;

	// Retry state
	#retryAbortController: AbortController | undefined = undefined;
	#retryNowRequested = false;
	#retryAttempt = 0;
	#retryPromise: Promise<void> | undefined = undefined;
	#retryResolve: (() => void) | undefined = undefined;
	#activeRetryFallback: ActiveRetryFallbackState | undefined = undefined;
	// Todo completion reminder state
	#todoReminderCount = 0;
	#lastGoalReminderAssistantTimestamp: number | undefined = undefined;
	#todoPhases: TodoPhase[] = [];
	#toolChoiceQueue = new ToolChoiceQueue();

	// Bash execution state
	#bashAbortControllers = new Set<AbortController>();
	#pendingBashMessages: BashExecutionMessage[] = [];
	#foregroundBashBackgroundRequestHandler: (() => void) | undefined;

	// Python execution state
	#evalAbortControllers = new Set<AbortController>();
	#evalKernelOwnerId: string;
	/**
	 * AsyncJobManager owned by this session (top-level only). Subagents leave
	 * this undefined and **MUST NOT** dispose the global instance on teardown.
	 */
	readonly #ownedAsyncJobManager: AsyncJobManager | undefined;
	#pendingPythonMessages: PythonExecutionMessage[] = [];
	#activeEvalExecutions = new Set<Promise<unknown>>();
	#evalExecutionDisposing = false;

	// Background-channel IRC exchanges queued while the recipient was streaming.
	// Drained into history (via emitExternalEvent) once the recipient becomes idle.
	#pendingBackgroundExchanges: CustomMessage[][] = [];
	#scheduledBackgroundExchangeFlush = false;
	// Agent identity + registry for IRC relay forwarding to the main session UI.
	#agentId: string | undefined;
	#agentRegistry: AgentRegistry | undefined;
	#providerSessionId: string | undefined;
	#providerCacheSessionId: string | undefined;
	#isDisposed = false;
	// Extension system
	#extensionRunner: ExtensionRunner | undefined = undefined;
	#turnIndex = 0;
	// First-party internal before-agent-start contributors (not user hooks).
	#beforeAgentStartContributors: BeforeAgentStartContributor[] = [];

	#skills: Skill[];
	#skillWarnings: SkillWarning[];

	// Custom commands (TypeScript slash commands)
	#customCommands: LoadedCustomCommand[] = [];
	/** MCP prompt commands (updated dynamically when prompts are loaded) */
	#mcpPromptCommands: LoadedCustomCommand[] = [];

	#skillsSettings: SkillsSettings | undefined;
	#activeSkillState: { skill: string; sessionId?: string } | undefined;

	// Model registry for API key resolution
	#modelRegistry: ModelRegistry;

	// Tool registry and prompt builder for extensions
	#toolRegistry: Map<string, AgentTool>;
	#workflowGateToolSession: ToolSession | undefined;
	#transformContext: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	#onPayload: SimpleStreamOptions["onPayload"] | undefined;
	#onResponse: SimpleStreamOptions["onResponse"] | undefined;
	#onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#rebuildSystemPrompt:
		| ((toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>)
		| undefined;
	#getMcpServerInstructions: (() => Map<string, string> | undefined) | undefined;
	#reloadSshTool: (() => Promise<AgentTool | null>) | undefined;
	#requestedToolNames: ReadonlySet<string> | undefined;
	#baseSystemPrompt: string[];
	/**
	 * Signature of the (toolNames, tool descriptions) tuple passed to the most
	 * recent successful `rebuildSystemPrompt` call. Used to skip redundant rebuilds
	 * when MCP servers reconnect without changing their tool definitions, which is
	 * the dominant cause of prompt-cache invalidation in long sessions.
	 */
	#lastAppliedToolSignature: string | undefined;
	#mcpDiscoveryEnabled = false;
	#discoverableMCPTools = new Map<string, DiscoverableMCPTool>();
	#discoverableMCPSearchIndex: DiscoverableMCPSearchIndex | null = null;
	#selectedMCPToolNames = new Set<string>();
	// Generic tool discovery (covers built-in + MCP + extension when tools.discoveryMode === "all")
	#discoverableToolSearchIndex: DiscoverableToolSearchIndex | null = null;
	#selectedDiscoveredToolNames = new Set<string>();
	#discoverableToolAllowedNames: ReadonlySet<string> | undefined;
	#rpcHostToolNames = new Set<string>();
	#gjcSubskillToolNames = new Set<string>();
	#gjcSubskillToolSignature: string | undefined;
	#defaultSelectedMCPServerNames = new Set<string>();
	#defaultSelectedMCPToolNames = new Set<string>();
	#sessionDefaultSelectedMCPToolNames = new Map<string, string[]>();

	// TTSR manager for time-traveling stream rules
	#ttsrManager: TtsrManager | undefined = undefined;
	#pendingTtsrInjections: Rule[] = [];
	/** Per-tool TTSR rules whose `interruptMode` opted out of aborting the stream.
	 *  These are folded into the matched tool call's `toolResult` content as an
	 *  in-band system reminder, instead of spawning a separate follow-up turn. */
	#perToolTtsrInjections = new Map<string, Rule[]>();
	#ttsrAbortPending = false;
	#ttsrRetryToken = 0;
	#ttsrResumePromise: Promise<void> | undefined = undefined;
	#ttsrResumeResolve: (() => void) | undefined = undefined;

	/** One-shot flag set in InteractiveMode.#approvePlan(compactBeforeExecute=true)
	 *  before the plan-mode → compaction transition. Consumed inside
	 *  #handleAgentEvent for the matching `message_end` + `stopReason: "aborted"`;
	 *  cleared unconditionally by the caller's `finally` so it cannot leak into
	 *  later unrelated aborts (e.g. when compaction returns cancelled/failed
	 *  without producing an aborted message_end). */
	#planCompactAbortPending = false;

	/** One-shot flag armed by `abort({ silent: true })` (e.g. Esc consuming a
	 *  queued steer). Consumed in #handleAgentEvent to stamp `SILENT_ABORT_MARKER`
	 *  on the resulting aborted assistant `message_end` so the interrupt does not
	 *  surface a red "Operation aborted" line; cleared by a later non-silent abort
	 *  or by `abort`'s safety net when no aborted message_end is produced. */
	#silentAbortPending = false;
	/** Monotonic counter for `enqueueCustomMessageDisplay` tag generation;
	 *  combined with `Date.now()` so tags stay unique even across rapid
	 *  same-tick enqueues. */
	#customDisplayTagCounter = 0;
	#postPromptTasks = new Set<Promise<void>>();
	#postPromptTasksPromise: Promise<void> | undefined = undefined;
	#postPromptTasksResolve: (() => void) | undefined = undefined;
	#postPromptTasksAbortController = new AbortController();

	#streamingEditAbortTriggered = false;
	#streamingEditCheckedLineCounts = new Map<string, number>();

	#streamingEditPrecheckedToolCallIds = new Set<string>();

	#streamingEditFileCache = new Map<string, string>();
	#promptInFlightCount = 0;
	// Wire-level agent_end emission deferred until #promptInFlightCount drops to 0.
	// Internal extension hooks and post-emit work (auto-retry, auto-compaction, todo
	// checks in #handleAgentEvent) still fire on the original schedule — only the
	// `#emit(event)` that reaches external subscribers (rpc-mode stdout, ACP bridge,
	// Cursor exec, TUI listeners) is held back. Without this, a client that resumes
	// on `agent_end` can fire its next `prompt` before #promptWithMessage's finally
	// has decremented #promptInFlightCount, hitting AgentBusyError. Flushed from
	// both #endInFlight (normal) and #resetInFlight (abort).
	#pendingAgentEndEmit: AgentSessionEvent | undefined;
	#obfuscator: SecretObfuscator | undefined;
	#checkpointState: CheckpointState | undefined = undefined;
	#providerReplaySourceCache = new WeakMap<AgentMessage, ProviderReplaySourceCacheEntry>();
	#pendingRewindReport: string | undefined = undefined;
	#lastSuccessfulYieldToolCallId: string | undefined = undefined;
	#promptGeneration = 0;
	#providerSessionState = new Map<string, ProviderSessionState>();
	#hindsightSessionState: HindsightSessionState | undefined = undefined;
	readonly rawSseDebugBuffer: RawSseDebugBuffer;

	#acquirePowerAssertion(): void {
		if (process.platform !== "darwin") return;
		if (this.#powerAssertion) return;
		const idle = this.settings.get("power.preventIdleSleep");
		const system = this.settings.get("power.preventSystemSleep");
		const user = this.settings.get("power.declareUserActive");
		const display = this.settings.get("power.preventDisplaySleep");
		// All four off → user opted out; do nothing.
		if (!idle && !system && !user && !display) return;
		try {
			this.#powerAssertion = MacOSPowerAssertion.start({
				reason: "Gajae Code agent session",
				idle,
				system,
				user,
				display,
			});
		} catch (error) {
			logger.warn("Failed to acquire macOS power assertion", { error: String(error) });
		}
	}

	#releasePowerAssertion(): void {
		const assertion = this.#powerAssertion;
		this.#powerAssertion = undefined;
		if (!assertion) return;
		try {
			assertion.stop();
		} catch (error) {
			logger.warn("Failed to release macOS power assertion", { error: String(error) });
		}
	}

	#beginInFlight(): void {
		this.#promptInFlightCount++;
		if (this.#promptInFlightCount === 1) {
			this.#acquirePowerAssertion();
		}
	}

	#endInFlight(): void {
		this.#promptInFlightCount = Math.max(0, this.#promptInFlightCount - 1);
		if (this.#promptInFlightCount === 0) {
			this.#releasePowerAssertion();
			this.#flushPendingBackgroundExchanges();
			this.#flushPendingAgentEnd();
		}
	}

	#resetInFlight(): void {
		this.#promptInFlightCount = 0;
		this.#releasePowerAssertion();
		this.#flushPendingBackgroundExchanges();
		this.#flushPendingAgentEnd();
	}

	#flushPendingAgentEnd(): void {
		const pending = this.#pendingAgentEndEmit;
		if (!pending) return;
		this.#pendingAgentEndEmit = undefined;
		this.#emit(pending);
	}

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settings = config.settings;
		this.taskDepth = config.taskDepth ?? 0;
		// Power assertions are taken per turn (see #beginInFlight); nothing acquired here.
		this.#evalKernelOwnerId = config.evalKernelOwnerId ?? `agent-session:${Snowflake.next()}`;
		this.#ownedAsyncJobManager = config.ownedAsyncJobManager;
		this.#scopedModels = config.scopedModels ?? [];
		this.#thinkingLevel = config.thinkingLevel;
		this.#promptTemplates = config.promptTemplates ?? [];
		this.#slashCommands = config.slashCommands ?? [];
		this.#extensionRunner = config.extensionRunner;
		this.#skills = config.skills ?? [];
		this.#skillWarnings = config.skillWarnings ?? [];
		this.#customCommands = config.customCommands ?? [];
		this.#skillsSettings = config.skillsSettings;
		this.#modelRegistry = config.modelRegistry;
		if (config.providerSessionState) {
			this.#providerSessionState = config.providerSessionState;
		}
		this.#validateRetryFallbackChains();
		this.#toolRegistry = config.toolRegistry ?? new Map();
		this.#workflowGateToolSession = config.workflowGateToolSession;
		this.#requestedToolNames = config.requestedToolNames;
		this.#transformContext = config.transformContext ?? (messages => messages);
		this.#onPayload = config.onPayload;
		this.rawSseDebugBuffer = config.rawSseDebugBuffer ?? new RawSseDebugBuffer();
		// Avoid wrapping in an `async` closure when no user callback is configured: the
		// outer await on `#onResponse` (provider-response.ts) tolerates a sync void return,
		// and skipping the wrapper drops a per-event `newPromiseCapability` allocation that
		// shows up as ~3.5% self time in streaming profiles.
		const configuredOnResponse = config.onResponse;
		this.#onResponse = configuredOnResponse
			? async (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
					await configuredOnResponse(response, model);
				}
			: (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
				};
		const configuredOnSseEvent = config.onSseEvent;
		this.#onSseEvent = configuredOnSseEvent
			? (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
					configuredOnSseEvent(event, model);
				}
			: (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
				};
		this.agent.setProviderResponseInterceptor(this.#onResponse);
		this.agent.setRawSseEventInterceptor(this.#onSseEvent);
		this.#setGuardedAgentTools(this.agent.state.tools);
		this.yieldQueue = new YieldQueue({
			isStreaming: () => this.isStreaming,
			injectStreaming: message => this.agent.followUp(message),
			injectIdle: async messages => {
				const first = messages[0];
				if (!first) return;
				await this.agent.prompt(messages.length === 1 ? first : messages);
			},
			scheduleIdleFlush: run => {
				this.#schedulePostPromptTask(
					async () => {
						await run();
					},
					{ delayMs: 1 },
				);
			},
		});
		this.agent.setOnBeforeYield(() => this.yieldQueue.flush("streaming"));
		this.#convertToLlm = config.convertToLlm ?? convertToLlm;
		this.#rebuildSystemPrompt = config.rebuildSystemPrompt;
		this.#getMcpServerInstructions = config.getMcpServerInstructions;
		this.#reloadSshTool = config.reloadSshTool;
		this.#baseSystemPrompt = this.agent.state.systemPrompt;
		this.#mcpDiscoveryEnabled = config.mcpDiscoveryEnabled ?? false;
		this.#discoverableToolAllowedNames = config.discoverableToolAllowedNames
			? new Set(config.discoverableToolAllowedNames.map(name => name.toLowerCase()))
			: undefined;
		this.#setDiscoverableMCPTools(this.#collectDiscoverableMCPToolsFromRegistry());
		this.#selectedMCPToolNames = new Set(config.initialSelectedMCPToolNames ?? []);
		this.#defaultSelectedMCPServerNames = new Set(config.defaultSelectedMCPServerNames ?? []);
		this.#defaultSelectedMCPToolNames = new Set(config.defaultSelectedMCPToolNames ?? []);
		this.#pruneSelectedMCPToolNames();
		const persistedSelectedMCPToolNames = this.buildDisplaySessionContext().selectedMCPToolNames;
		const currentSelectedMCPToolNames = this.getSelectedMCPToolNames();
		const persistInitialMCPToolSelection =
			config.persistInitialMCPToolSelection ?? this.sessionManager.getBranch().length === 0;
		if (
			this.#mcpDiscoveryEnabled &&
			persistInitialMCPToolSelection &&
			!this.#selectedMCPToolNamesMatch(persistedSelectedMCPToolNames, currentSelectedMCPToolNames)
		) {
			this.sessionManager.appendMCPToolSelection(currentSelectedMCPToolNames);
		}
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionManager.getSessionFile(),
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);
		this.#ttsrManager = config.ttsrManager;
		this.#obfuscator = config.obfuscator;
		this.#agentId = config.agentId;
		this.#agentRegistry = config.agentRegistry;
		this.#providerSessionId = config.providerSessionId;
		this.#providerCacheSessionId = config.providerCacheSessionId;
		this.agent.setAssistantMessageEventInterceptor((message, assistantMessageEvent) => {
			const event: AgentEvent = {
				type: "message_update",
				message,
				assistantMessageEvent,
			};
			const generation = this.#promptGeneration;
			this.#preCacheStreamingEditFile(event);
			this.#maybeAbortStreamingEdit(event, generation);
		});
		// Per-tool TTSR reminders are folded into the matched tool's result via this hook.
		this.agent.afterToolCall = ctx => this.#ttsrAfterToolCall(ctx);
		this.agent.providerSessionState = this.#providerSessionState;
		this.#syncAgentSessionId();
		this.#syncTodoPhasesFromBranch();
		this.#goalRuntime = new GoalRuntime({
			getState: () => this.#goalModeState,
			setState: state => {
				this.#goalModeState = state;
			},
			getCurrentUsage: () => {
				const usage = this.getSessionStats().tokens;
				return {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				};
			},
			emit: event => {
				if (event.type === "goal_updated") {
					return this.#emitSessionEvent({ type: "goal_updated", goal: event.goal, state: event.state });
				}
			},
			persist: (mode, state) => {
				if (mode === "none") {
					this.sessionManager.appendModeChange("none");
				} else if (state) {
					this.sessionManager.appendModeChange(mode, { goal: state.goal });
				}
			},
			sendHiddenMessage: async message => {
				await this.sendCustomMessage(
					{
						customType: message.customType,
						content: message.content,
						display: false,
						attribution: "agent",
					},
					{ deliverAs: message.deliverAs },
				);
			},
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, hooks, auto-compaction, retry logic)
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
		// Re-evaluate append-only context mode when the setting changes at runtime.
		this.#unsubscribeAppendOnly = onAppendOnlyModeChanged(_value => this.#syncAppendOnlyContext(this.model));
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this.#modelRegistry;
	}

	/** Advance the tool-choice queue and return the next directive for the upcoming LLM call. */
	nextToolChoice(): ToolChoice | undefined {
		return this.#toolChoiceQueue.nextToolChoice();
	}

	/**
	 * Force the next model call to target a specific active tool, then terminate
	 * the agent loop. Pushes a two-step sequence [forced, "none"] so the model
	 * calls exactly the forced tool once and then cannot call another.
	 */
	setForcedToolChoice(toolName: string): void {
		if (!this.getActiveToolNames().includes(toolName)) {
			throw new Error(`Tool "${toolName}" is not currently active.`);
		}

		const forced = buildNamedToolChoice(toolName, this.model);
		if (!forced || typeof forced === "string") {
			throw new Error("Current model does not support forcing a specific tool.");
		}

		this.#toolChoiceQueue.pushSequence([forced, "none"], {
			label: "user-force",
			onRejected: () => "requeue",
		});
	}

	/** The tool-choice queue: forces forthcoming tool invocations and carries handlers. */
	get toolChoiceQueue(): ToolChoiceQueue {
		return this.#toolChoiceQueue;
	}

	/** Current skill prompt executing in this session, if any. */
	getActiveSkillState(): { skill: string; session_id?: string } | undefined {
		if (!this.#activeSkillState) return undefined;
		return {
			skill: this.#activeSkillState.skill,
			...(this.#activeSkillState.sessionId ? { session_id: this.#activeSkillState.sessionId } : {}),
		};
	}

	/** Best-effort accessor for the active skill's `current_phase` field from
	 *  its persisted mode-state file. Used by the `skill` tool to enforce the
	 *  terminal-phase chain guard. Returns undefined when no active skill is
	 *  recorded or the mode-state file is missing/unreadable; callers should
	 *  treat undefined as a non-terminal phase (refuses to chain). */
	getActiveSkillPhase(): string | undefined {
		const active = this.#activeSkillState;
		if (!active) return undefined;
		if (!isCanonicalGjcWorkflowSkill(active.skill)) return undefined;
		const sessionId = active.sessionId ?? this.sessionManager.getSessionId();
		try {
			assertNonEmptyGjcSessionId(sessionId, "AgentSession.getActiveSkillPhase");
			// Keep the session-state-dir construction explicit here so the chain guard
			// refuses to fall back to a legacy root `.gjc/state` read.
			const stateDir = sessionStateDir(this.sessionManager.getCwd(), sessionId);
			const filePath = path.join(
				stateDir,
				path.basename(sessionModeStatePath(this.sessionManager.getCwd(), sessionId, active.skill)),
			);
			const raw = fs.readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(raw) as { current_phase?: unknown };
			return typeof parsed.current_phase === "string" ? parsed.current_phase : undefined;
		} catch {
			return undefined;
		}
	}

	/** Peek the in-flight directive's invocation handler for use by the resolve tool. */
	peekQueueInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekInFlightInvoker();
	}

	/** Standing (long-lived) handler the `resolve` tool falls back to when no
	 *  queue invoker is in flight. Used by plan mode so the agent can submit
	 *  approval via `resolve` without forcing the tool choice every turn. */
	#standingResolveHandler: ((input: unknown) => Promise<unknown> | unknown) | undefined;

	peekStandingResolveHandler(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#standingResolveHandler;
	}

	setStandingResolveHandler(handler: ((input: unknown) => Promise<unknown> | unknown) | null): void {
		this.#standingResolveHandler = handler ?? undefined;
	}

	/** Provider-scoped mutable state store for transport/session caches. */
	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#providerSessionState;
	}

	async buildForkContextSeed(options: ForkContextSeedOptions): Promise<ForkContextSeed> {
		const transformedMessages = await this.#transformContext([...this.messages], options.signal);
		const convertedMessages = await this.#convertToLlm(transformedMessages);
		const providerMessages = this.model
			? normalizeMessagesForProvider(convertedMessages, this.model)
			: convertedMessages;
		const maxMessages = Math.min(500, Math.max(0, Math.trunc(options.maxMessages)));
		const maxTokens = Math.max(0, Math.trunc(options.maxTokens));
		const selected: Message[] = [];
		const skippedReasons: Record<string, number> = {};
		let skippedMessages = 0;
		let approximateTokens = 0;

		const recordSkip = (reason: string) => {
			skippedMessages++;
			skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
		};

		const sanitizeMessage = (message: Message): Message | undefined => {
			if (message.role === "developer") {
				recordSkip("developer-role");
				return undefined;
			}
			if (message.role === "toolResult") {
				recordSkip("tool-result-role");
				return undefined;
			}
			if (message.role !== "user" && message.role !== "assistant") {
				recordSkip("unsupported-role");
				return undefined;
			}
			const cloned = cloneJsonValueForForkSeed(message) as Message;
			if ("providerPayload" in cloned) {
				delete (cloned as { providerPayload?: unknown }).providerPayload;
			}
			if (Array.isArray(cloned.content)) {
				const sanitizedContent: TextContent[] = [];
				for (const block of cloned.content) {
					if (block.type === "text") {
						sanitizedContent.push(block);
					} else if (block.type === "image") {
						sanitizedContent.push({ type: "text", text: "[Image omitted from fork-context seed]" });
					} else if (block.type !== "thinking") {
						recordSkip(`unsupported-content-${block.type}`);
					}
				}
				return { ...cloned, content: sanitizedContent } as Message;
			}
			return cloned;
		};

		for (let i = providerMessages.length - 1; i >= 0; i--) {
			if (selected.length >= maxMessages) {
				recordSkip("message-limit");
				continue;
			}
			const sanitized = sanitizeMessage(providerMessages[i]!);
			if (!sanitized) continue;
			const messageTokens = estimateMessageTokensHeuristic(sanitized);
			if (maxTokens > 0 && approximateTokens + messageTokens > maxTokens) {
				recordSkip("token-limit");
				continue;
			}
			selected.unshift(sanitized);
			approximateTokens += messageTokens;
		}

		const messages = selected;
		let appendOnlyPrefixSnapshot: StablePrefixSnapshot | undefined;
		const appendOnly = this.agent.appendOnlyContext;
		if (appendOnly) {
			if (!appendOnly.prefix.built) {
				appendOnly.prefix.build(this.agent.state, { intentTracing: this.agent.intentTracing });
			}
			appendOnlyPrefixSnapshot = appendOnly.prefix.exportSnapshot() ?? undefined;
		}
		return {
			messages,
			agentMessages: messages.map(message => cloneJsonValueForForkSeed(message) as AgentMessage),
			metadata: {
				sourceSessionId: this.sessionId,
				parentMessageCount: providerMessages.length,
				includedMessages: messages.length,
				skippedMessages,
				approximateTokens,
				maxMessages,
				maxTokens,
				skippedReasons,
			},
			cacheIdentity: options.cacheIdentity ?? this.sessionId,
			appendOnlyPrefixSnapshot,
		};
	}

	getHindsightSessionState(): HindsightSessionState | undefined {
		return this.#hindsightSessionState;
	}

	setHindsightSessionState(state: HindsightSessionState | undefined): HindsightSessionState | undefined {
		const previous = this.#hindsightSessionState;
		this.#hindsightSessionState = state;
		return previous;
	}

	/** TTSR manager for time-traveling stream rules */
	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsrManager;
	}

	/** Whether a TTSR abort is pending (stream was aborted to inject rules) */
	get isTtsrAbortPending(): boolean {
		return this.#ttsrAbortPending;
	}

	/** Whether the plan-mode → compaction transition's expected internal abort is
	 *  pending. Consumed by `#handleAgentEvent` to stamp `SILENT_ABORT_MARKER`
	 *  on the next aborted assistant message_end; cleared unconditionally by
	 *  `InteractiveMode.#approvePlan`'s `finally` block. */
	get isPlanCompactAbortPending(): boolean {
		return this.#planCompactAbortPending;
	}

	/** Arm the silent-abort marker for the next aborted assistant message_end.
	 *  Caller MUST clear via `clearPlanCompactAbortPending()` in a `finally`
	 *  to guarantee no leak. */
	markPlanCompactAbortPending(): void {
		this.#planCompactAbortPending = true;
	}

	/** Unconditionally clear the silent-abort flag. Idempotent: safe when the
	 *  flag was never set OR was already consumed by `#handleAgentEvent`. */
	clearPlanCompactAbortPending(): void {
		this.#planCompactAbortPending = false;
	}

	/** Register a compact display string for a custom message that the caller is
	 *  about to dispatch via `promptCustomMessage` / `sendCustomMessage`.
	 *  Returns a stable tag the caller MUST embed in
	 *  `CustomMessage.details.__pendingDisplayTag` so the agent-side
	 *  `message_start` handler can remove the matching display entry when the
	 *  queued message is consumed.
	 *
	 *  Does NOT push to the agent's steering/followUp queue — that happens
	 *  separately inside `sendCustomMessage`. */
	enqueueCustomMessageDisplay(text: string, mode: "steer" | "followUp"): string {
		const tag = `gjc-cmd-${Date.now()}-${++this.#customDisplayTagCounter}`;
		const displayText = text.trim();
		if (!displayText) return tag;
		const entry: QueuedDisplayEntry = { text: displayText, tag };
		if (mode === "steer") {
			this.#steeringMessages.push(entry);
		} else {
			this.#followUpMessages.push(entry);
		}
		return tag;
	}

	getAgentId(): string | undefined {
		return this.#agentId;
	}

	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
		const manager = AsyncJobManager.instance();
		if (!manager) return null;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const running = manager.getRunningJobs(ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
			endTime: job.endTime,
			metadata: job.metadata,
		}));
		const recent = manager.getRecentJobs(options?.recentLimit ?? 5, ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
			endTime: job.endTime,
			metadata: job.metadata,
		}));
		const delivery = manager.getDeliveryState(ownerFilter);
		return { running, recent, delivery };
	}

	/**
	 * Cancel async jobs registered by *this* agent only. Used by lifecycle
	 * transitions (newSession, switchSession, handoff, dispose) so a subagent
	 * cleans up its own background work without touching its parent's jobs.
	 * No-op when no manager is installed or this session has no agent id.
	 */
	#cancelOwnAsyncJobs(): void {
		if (!this.#agentId) return;
		const manager = AsyncJobManager.instance();
		if (!manager) return;
		// Run owner cleanups first so cron timers (and any other owner-scoped
		// resource cleanup) cannot register fresh jobs while we tear down the
		// existing ones. Cleanup callbacks are error-isolated inside the manager.
		manager.runOwnerCleanups({ ownerId: this.#agentId });
		manager.cancelAll({ ownerId: this.#agentId });
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	#emit(event: AgentSessionEvent): void {
		// Copy array before iteration to avoid mutation during iteration
		const listeners = [...this.#eventListeners];
		for (const l of listeners) {
			l(event);
		}
	}

	/**
	 * Emit a UI-only notice to the session. Surfaces in interactive mode as a
	 * `showWarning` / `showError` / `showStatus` line; non-interactive modes
	 * receive the event through the normal subscribe stream.
	 *
	 * Notices are NOT added to agent state and never reach the LLM — use this
	 * for out-of-band conditions the user should see but the model shouldn't
	 * react to (e.g. background queue flush failures).
	 */
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
		this.#emit({ type: "notice", level, message, source });
	}

	#queuedExtensionEvents: Promise<void> = Promise.resolve();

	#queueExtensionEvent(event: AgentSessionEvent): Promise<void> {
		const emit = async () => {
			await this.#emitExtensionEvent(event);
		};
		const queued = this.#queuedExtensionEvents.then(emit, emit);
		this.#queuedExtensionEvents = queued.catch(() => {});
		return queued;
	}

	async #emitSessionEvent(event: AgentSessionEvent): Promise<void> {
		await persistCoordinatorRuntimeStateFromEvent(event, {
			sessionId: this.sessionId,
			cwd: this.sessionManager.getCwd(),
			sessionFile: this.sessionManager.getSessionFile(),
		});
		if (event.type === "message_update") {
			this.#emit(event);
			void this.#queueExtensionEvent(event);
			return;
		}
		await this.#emitExtensionEvent(event);
		// Hold the wire-level agent_end until in-flight prompts unwind. Subscribers
		// (rpc-mode, ACP, Cursor) treat agent_end as the "session is idle" signal;
		// emitting while #promptInFlightCount > 0 lets a client fire its next
		// `prompt` into a session that still reports isStreaming === true. Flush
		// happens in #endInFlight / #resetInFlight. A later agent_end (e.g. from
		// an auto-compaction turn that starts before the original prompt unwinds)
		// supersedes the pending one, which is what subscribers want — they only
		// care about the final settle.
		if (event.type === "agent_end" && this.#promptInFlightCount > 0) {
			this.#pendingAgentEndEmit = event;
			return;
		}
		this.#emit(event);
	}

	// Track last assistant message for auto-compaction check
	#lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	#handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			const messageText = this.#getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first (match by .text on tagged records)
				const steeringIndex = this.#steeringMessages.findIndex(e => e.text === messageText);
				if (steeringIndex !== -1) {
					this.#steeringMessages.splice(steeringIndex, 1);
				} else {
					// Check follow-up queue
					const followUpIndex = this.#followUpMessages.findIndex(e => e.text === messageText);
					if (followUpIndex !== -1) {
						this.#followUpMessages.splice(followUpIndex, 1);
					}
				}
			}
		}

		// Tag-based dequeue for custom messages (skills queued via promptCustomMessage).
		// The InputController attached a stable tag via CustomMessage.details when it
		// registered the display chip; pull it back here to remove the matching entry
		// from the pending bar atomically with the agent's queue consumption. Match by
		// tag (not text) — two queued skills with identical args cannot collide.
		if (event.type === "message_start" && event.message.role === "custom") {
			const tag = readPendingDisplayTag(event.message.details);
			if (tag) {
				const steerIdx = this.#steeringMessages.findIndex(e => e.tag === tag);
				if (steerIdx !== -1) {
					this.#steeringMessages.splice(steerIdx, 1);
				} else {
					const followUpIdx = this.#followUpMessages.findIndex(e => e.tag === tag);
					if (followUpIdx !== -1) {
						this.#followUpMessages.splice(followUpIdx, 1);
					}
				}
			}
			await this.#syncSkillPromptActiveStateSafely(event.message, true);
		}

		// Plan-mode → compaction transition: stamp `SILENT_ABORT_MARKER` on the
		// persisted message BEFORE the obfuscator's display-side copy below.
		// Invariant (must hold across refactors): this branch precedes the
		// `let displayEvent = event; ... displayEvent = { ...event, message: { ...message, content: deobfuscated } }`
		// block. After stamping, both `displayEvent.message` (via the spread)
		// and `event.message` (in-place mutation, used by SessionManager
		// persistence) carry the marker, guaranteeing streaming render and
		// history replay branch identically. The one-shot flag is consumed
		// here, scoped strictly to this aborted message_end; the caller's
		// `finally` (in `InteractiveMode.#approvePlan`) clears it again on
		// every terminal compaction outcome (`ok` / `cancelled` / `failed` /
		// throw) so a leaked flag cannot silence a later unrelated abort.
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason === "aborted" &&
			(this.#planCompactAbortPending || this.#silentAbortPending)
		) {
			(event.message as AssistantMessage).errorMessage = SILENT_ABORT_MARKER;
			this.#planCompactAbortPending = false;
			this.#silentAbortPending = false;
		}

		// Deobfuscate assistant message content for display emission — the LLM echoes back
		// obfuscated placeholders, but listeners (TUI, extensions, exporters) must see real
		// values. The original event.message stays obfuscated so the persistence path below
		// writes `#HASH#` tokens to the session file; convertToLlm re-obfuscates outbound
		// traffic on the next turn. Walks text, thinking, and toolCall arguments/intent.
		let displayEvent: AgentEvent = event;
		const obfuscator = this.#obfuscator;
		if (obfuscator && event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			const deobfuscatedContent = obfuscator.deobfuscateObject(message.content);
			if (deobfuscatedContent !== message.content) {
				displayEvent = { ...event, message: { ...message, content: deobfuscatedContent } };
			}
		}

		if (event.type === "turn_start") {
			const usage = this.getSessionStats().tokens;
			this.#goalRuntime.onTurnStart(`turn-${++this.#goalTurnCounter}`, {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			});
		}

		await this.#emitSessionEvent(displayEvent);

		if (event.type === "turn_start") {
			this.#resetStreamingEditState();
			// TTSR: Reset buffer on turn start
			this.#ttsrManager?.resetBuffer();
		}

		// TTSR: Increment message count on turn end (for repeat-after-gap tracking)
		if (event.type === "turn_end" && this.#ttsrManager) {
			this.#ttsrManager.incrementMessageCount();
		}
		// Finalize the tool-choice queue's in-flight yield after tools have executed.
		// This must happen at turn_end (not message_end) because onInvoked handlers
		// run during tool execution, which happens between message_end and turn_end.
		if (event.type === "turn_end" && this.#toolChoiceQueue.hasInFlight) {
			const msg = event.message as AssistantMessage;
			if (msg.stopReason === "aborted" || msg.stopReason === "error") {
				this.#toolChoiceQueue.reject(msg.stopReason === "error" ? "error" : "aborted");
			} else {
				this.#toolChoiceQueue.resolve();
			}
		}
		if (event.type === "tool_execution_end") {
			if (event.toolName === "goal") {
				await this.#goalRuntime.onGoalToolCompleted();
			} else {
				await this.#goalRuntime.onToolCompleted(event.toolName);
			}
			if (event.toolName === "bash" && !event.isError) {
				await this.#activatePendingGjcGoalModeRequest();
			}
		}
		if (event.type === "tool_execution_end" && event.toolName === "yield" && !event.isError) {
			this.#lastSuccessfulYieldToolCallId = event.toolCallId;
		}
		if (event.type === "turn_end" && this.#pendingRewindReport) {
			const report = this.#pendingRewindReport;
			this.#pendingRewindReport = undefined;
			await this.#applyRewind(report);
		}

		// TTSR: Check for pattern matches on assistant text/thinking and tool argument deltas
		if (event.type === "message_update" && this.#ttsrManager?.hasRules()) {
			const assistantEvent = event.assistantMessageEvent;
			let matchContext: TtsrMatchContext | undefined;

			if (assistantEvent.type === "text_delta") {
				matchContext = { source: "text" };
			} else if (assistantEvent.type === "thinking_delta") {
				matchContext = { source: "thinking" };
			} else if (assistantEvent.type === "toolcall_delta") {
				matchContext = this.#getTtsrToolMatchContext(event.message, assistantEvent.contentIndex);
			}

			if (matchContext && "delta" in assistantEvent) {
				const matches = this.#ttsrManager.checkDelta(assistantEvent.delta, matchContext);
				if (matches.length > 0) {
					// Decide first: a non-interrupting tool-source match attaches to the
					// specific tool call's result instead of driving a loop-wide follow-up.
					const shouldInterrupt = this.#shouldInterruptForTtsrMatch(matches, matchContext);
					const perToolId = shouldInterrupt ? undefined : this.#extractTtsrToolCallId(matchContext);
					if (perToolId) {
						this.#addPerToolTtsrInjections(perToolId, matches);
						this.#emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
					} else {
						// Queue rules for injection; mark as injected only after successful enqueue.
						this.#addPendingTtsrInjections(matches);

						if (shouldInterrupt) {
							// Abort the stream immediately — do not gate on extension callbacks
							this.#ttsrAbortPending = true;
							this.#ensureTtsrResumePromise();
							this.agent.abort();
							// Notify extensions (fire-and-forget, does not block abort)
							this.#emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
							// Schedule retry after a short delay
							const retryToken = ++this.#ttsrRetryToken;
							const generation = this.#promptGeneration;
							const targetMessageTimestamp =
								event.message.role === "assistant" ? event.message.timestamp : undefined;
							this.#schedulePostPromptTask(
								async () => {
									if (this.#ttsrRetryToken !== retryToken) {
										this.#resolveTtsrResume();
										return;
									}

									const targetAssistantIndex = this.#findTtsrAssistantIndex(targetMessageTimestamp);
									if (!this.#ttsrAbortPending || this.#promptGeneration !== generation) {
										this.#ttsrAbortPending = false;
										this.#pendingTtsrInjections = [];
										this.#perToolTtsrInjections.clear();
										this.#resolveTtsrResume();
										return;
									}
									this.#ttsrAbortPending = false;
									this.#perToolTtsrInjections.clear();
									const ttsrSettings = this.#ttsrManager?.getSettings();
									if (ttsrSettings?.contextMode === "discard" && targetAssistantIndex !== -1) {
										// Remove the partial/aborted assistant turn from agent state when it was persisted.
										this.agent.replaceMessages(this.agent.state.messages.slice(0, targetAssistantIndex));
									}
									// Inject TTSR rules as system reminder before retry
									const injection = this.#getTtsrInjectionContent();
									if (injection) {
										const details = { rules: injection.rules.map(rule => rule.name) };
										this.agent.appendMessage({
											role: "custom",
											customType: "ttsr-injection",
											content: injection.content,
											display: false,
											details,
											attribution: "agent",
											timestamp: Date.now(),
										});
										this.sessionManager.appendCustomMessageEntry(
											"ttsr-injection",
											injection.content,
											false,
											details,
											"agent",
										);
										this.#markTtsrInjected(details.rules);
									}
									try {
										await this.agent.continue();
									} catch {
										this.#resolveTtsrResume();
									}
								},
								{ delayMs: 50 },
							);
							return;
						}
					}
				}
			}
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_start" ||
				event.assistantMessageEvent.type === "toolcall_delta" ||
				event.assistantMessageEvent.type === "toolcall_end")
		) {
			void this.#preCacheStreamingEditFile(event);
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_end" || event.assistantMessageEvent.type === "toolcall_delta")
		) {
			this.#maybeAbortStreamingEdit(event, this.#promptGeneration);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a hook/custom message
			if (event.message.role === "hookMessage" || event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
					event.message.attribution ?? "agent",
				);
				if (event.message.role === "custom" && event.message.customType === "ttsr-injection") {
					this.#markTtsrInjected(this.#extractTtsrRuleNames(event.message.details));
				}
			} else if (
				event.message.role === "user" ||
				event.message.role === "developer" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult" ||
				event.message.role === "fileMention"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this.#lastAssistantMessage = event.message;
				const assistantMsg = event.message as AssistantMessage;
				const currentGrantsAnthropicPriority =
					this.serviceTier === "priority" || this.serviceTier === "claude-only";
				if (assistantMsg.disabledFeatures?.includes("priority") && currentGrantsAnthropicPriority) {
					this.setServiceTier(undefined);
					this.emitNotice(
						"warning",
						"Priority/fast mode rejected for this model; retried without it. Fast mode is now off.",
						"priority",
					);
				}
				// Resolve TTSR resume gate before checking for new deferred injections.
				// Gate on #ttsrAbortPending, not stopReason: a non-TTSR abort (e.g. streaming
				// edit) also produces stopReason === "aborted" but has no continuation coming.
				// Only skip when #ttsrAbortPending is true (TTSR continuation is imminent).
				if (!this.#ttsrAbortPending) {
					this.#resolveTtsrResume();
				}
				this.#queueDeferredTtsrInjectionIfNeeded(assistantMsg);
				if (this.#handoffAbortController) {
					this.#skipPostTurnMaintenanceAssistantTimestamp = assistantMsg.timestamp;
				}
				if (
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted" &&
					this.#retryAttempt > 0
				) {
					if (this.#activeRetryFallback && this.model) {
						await this.#emitSessionEvent({
							type: "retry_fallback_succeeded",
							model: formatRetryFallbackSelector(this.model, this.thinkingLevel),
							role: this.#activeRetryFallback.role,
						});
					}
					await this.#emitSessionEvent({
						type: "auto_retry_end",
						success: true,
						attempt: this.#retryAttempt,
					});
					this.#retryAttempt = 0;
					// Settle the retry gate here, colocated with the success event, rather
					// than relying on the generic #resolveRetry() at the end of the
					// agent_end branch. That tail resolver is bypassed by every early
					// return in agent_end (successful `yield`, handoff-abort skip-maintenance,
					// missing assistant message), so a retry that recovers on a yield turn
					// would otherwise leave #retryPromise unresolved — wedging
					// #waitForPostPromptRecovery and the session as permanently busy.
					// #resolveRetry() is idempotent, so the later tail call is a no-op.
					this.#resolveRetry();
				}
			}

			if (event.message.role === "toolResult") {
				const { toolName, details, isError, content } = event.message as {
					toolName?: string;
					details?: { path?: string; phases?: TodoPhase[]; report?: string; startedAt?: string };
					isError?: boolean;
					content?: Array<TextContent | ImageContent>;
				};
				// Invalidate streaming edit cache when edit tool completes to prevent stale data
				if (toolName === "edit" && details?.path) {
					this.#invalidateFileCacheForPath(details.path);
				}
				if (toolName === "todo_write" && !isError && Array.isArray(details?.phases)) {
					this.setTodoPhases(details.phases);
				}
				if (toolName === "todo_write" && isError) {
					const errorText = content?.find(part => part.type === "text")?.text;
					const reminderText = [
						"<system-reminder>",
						"todo_write failed, so todo progress is not visible to the user.",
						errorText ? `Failure: ${errorText}` : "Failure: todo_write returned an error.",
						"Fix the todo payload and call todo_write again before continuing.",
						"</system-reminder>",
					].join("\n");
					await this.sendCustomMessage(
						{
							customType: "todo-write-error-reminder",
							content: reminderText,
							display: false,
							details: { toolName, errorText },
						},
						{ deliverAs: "nextTurn" },
					);
				}
				if (toolName === "checkpoint" && !isError) {
					const checkpointEntryId = this.sessionManager.getEntries().at(-1)?.id ?? null;
					this.#checkpointState = {
						checkpointMessageCount: this.agent.state.messages.length,
						checkpointEntryId,
						startedAt: details?.startedAt ?? new Date().toISOString(),
					};
					this.#pendingRewindReport = undefined;
				}
				if (toolName === "rewind" && !isError && this.#checkpointState) {
					const detailReport = typeof details?.report === "string" ? details.report.trim() : "";
					const textReport = content?.find(part => part.type === "text")?.text?.trim() ?? "";
					const report = detailReport || textReport;
					if (report.length > 0) {
						this.#pendingRewindReport = report;
					}
				}
			}
		}

		// Check auto-retry and auto-compaction after agent completes
		if (event.type === "agent_end") {
			const usage = this.getSessionStats().tokens;
			await this.#goalRuntime.onAgentEnd({
				currentUsage: {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				},
			});
			if (this.#activeSkillState) {
				const { skill, sessionId } = this.#activeSkillState;
				await this.#syncSkillPromptActiveStateSafely(
					{ customType: SKILL_PROMPT_MESSAGE_TYPE, details: { name: skill } },
					false,
				);
				if (this.#activeSkillState?.skill === skill && this.#activeSkillState.sessionId === sessionId) {
					this.#activeSkillState = undefined;
				}
			}
			const fallbackAssistant = [...event.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			const msg = this.#lastAssistantMessage ?? fallbackAssistant;
			this.#lastAssistantMessage = undefined;
			if (!msg) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				return;
			}

			// Invalidate GitHub Copilot credentials on auth failure so stale tokens
			// aren't reused on the next request
			if (
				msg.stopReason === "error" &&
				msg.provider === "github-copilot" &&
				msg.errorMessage?.includes("GitHub Copilot authentication failed")
			) {
				await this.#modelRegistry.authStorage.remove("github-copilot");
			}

			if (this.#skipPostTurnMaintenanceAssistantTimestamp === msg.timestamp) {
				this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;
				this.#lastSuccessfulYieldToolCallId = undefined;
				return;
			}

			if (this.#assistantEndedWithSuccessfulYield(msg)) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				if (msg.stopReason !== "error" && msg.stopReason !== "aborted" && (await this.#checkGoalCompletion(msg))) {
					return;
				}
				return;
			}
			this.#lastSuccessfulYieldToolCallId = undefined;

			// Check for retryable errors first (overloaded, rate limit, server errors)
			if (this.#isRetryableError(msg)) {
				const didRetry = await this.#handleRetryableError(msg);
				if (didRetry) return; // Retry was initiated, don't proceed to compaction
			}
			if (this.#retryAttempt > 0) {
				// A prior retry ended on a non-retryable (terminal) message: emit
				// the terminal retry-end and reset so observers clear retry state.
				const attempt = this.#retryAttempt;
				this.#retryAttempt = 0;
				await this.#emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt,
					finalError: msg.errorMessage,
				});
			}
			this.#resolveRetry();

			const compactionTask = this.#checkCompaction(msg);
			this.#trackPostPromptTask(compactionTask);
			await compactionTask;
			// Check for incomplete todos only after a final assistant stop, not intermediate tool-use turns.
			const hasToolCalls = msg.content.some(content => content.type === "toolCall");
			if (hasToolCalls) {
				return;
			}
			if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
				if (this.#enforceRewindBeforeYield()) {
					return;
				}
				if (await this.#checkGoalCompletion(msg)) {
					return;
				}
				await this.#checkTodoCompletion();
			}
		}
	};

	/** Resolve the pending retry promise */
	#resolveRetry(): void {
		if (this.#retryResolve) {
			this.#retryResolve();
			this.#retryResolve = undefined;
			this.#retryPromise = undefined;
		}
	}

	/** Create the TTSR resume gate promise if one doesn't already exist. */
	#ensureTtsrResumePromise(): void {
		if (this.#ttsrResumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#ttsrResumePromise = promise;
		this.#ttsrResumeResolve = resolve;
	}

	/** Resolve and clear the TTSR resume gate. */
	#resolveTtsrResume(): void {
		if (!this.#ttsrResumeResolve) return;
		this.#ttsrResumeResolve();
		this.#ttsrResumeResolve = undefined;
		this.#ttsrResumePromise = undefined;
	}

	#ensurePostPromptTasksPromise(): void {
		if (this.#postPromptTasksPromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#postPromptTasksPromise = promise;
		this.#postPromptTasksResolve = resolve;
	}

	#resolvePostPromptTasks(): void {
		if (!this.#postPromptTasksResolve) return;
		this.#postPromptTasksResolve();
		this.#postPromptTasksResolve = undefined;
		this.#postPromptTasksPromise = undefined;
	}

	#trackPostPromptTask(task: Promise<void>): void {
		this.#postPromptTasks.add(task);
		this.#ensurePostPromptTasksPromise();
		void task
			.catch(() => {})
			.finally(() => {
				this.#postPromptTasks.delete(task);
				if (this.#postPromptTasks.size === 0) {
					this.#resolvePostPromptTasks();
				}
			});
	}

	#schedulePostPromptTask(
		task: (signal: AbortSignal) => Promise<void>,
		options?: { delayMs?: number; generation?: number; onSkip?: () => void },
	): void {
		const delayMs = options?.delayMs ?? 0;
		const signal = this.#postPromptTasksAbortController.signal;
		const scheduled = (async () => {
			if (delayMs > 0) {
				try {
					await scheduler.wait(delayMs, { signal });
				} catch {
					return;
				}
			}
			if (signal.aborted) {
				options?.onSkip?.();
				return;
			}
			if (options?.generation !== undefined && this.#promptGeneration !== options.generation) {
				options.onSkip?.();
				return;
			}
			await task(signal);
		})();
		this.#trackPostPromptTask(scheduled);
	}

	#scheduleAgentContinue(options?: {
		delayMs?: number;
		generation?: number;
		shouldContinue?: () => boolean;
		onSkip?: (reason: "generation_changed" | "aborted_signal" | "queue_drained") => void;
		onError?: (error: unknown) => void;
	}): void {
		const scheduledGeneration = options?.generation;
		const signal = this.#postPromptTasksAbortController.signal;
		this.#schedulePostPromptTask(
			async () => {
				if (signal.aborted) {
					options?.onSkip?.("aborted_signal");
					return;
				}
				if (scheduledGeneration !== undefined && this.#promptGeneration !== scheduledGeneration) {
					options?.onSkip?.("generation_changed");
					return;
				}
				if (options?.shouldContinue && !options.shouldContinue()) {
					options.onSkip?.("queue_drained");
					return;
				}
				try {
					await this.#maybeRestoreRetryFallbackPrimary();
					await this.agent.continue();
				} catch (error) {
					logger.warn("agent.continue failed after scheduling", {
						error: error instanceof Error ? error.message : String(error),
					});
					options?.onError?.(error);
				}
			},
			{ delayMs: options?.delayMs },
		);
	}

	#logCompactionContinuationSkipped(
		source: "auto_continue_prompt" | "queued_continue" | "overflow_retry",
		reason: string,
	): void {
		logger.warn("Auto-compaction continuation skipped", { source, reason });
	}

	#logCompactionContinuationError(
		source: "auto_continue_prompt" | "queued_continue" | "overflow_retry",
		error: unknown,
	): void {
		logger.warn("Auto-compaction continuation failed", {
			source,
			reason: error instanceof Error && error.name === "AgentBusyError" ? "queue_drained" : "not_resumable_tail",
			error: error instanceof Error ? error.message : String(error),
		});
	}

	#isResumableAgentTail(): boolean {
		const lastMsg = this.agent.state.messages.at(-1);
		return lastMsg !== undefined && lastMsg.role !== "assistant";
	}

	#stripOverflowFailedTurnForRetry(): void {
		const messages = this.agent.state.messages;
		const lastMsg = messages.at(-1);
		const contextWindow = this.model?.contextWindow ?? 0;
		if (lastMsg?.role === "assistant" && isContextOverflow(lastMsg as AssistantMessage, contextWindow)) {
			this.agent.replaceMessages(messages.slice(0, -1));
		}
	}

	#scheduleAutoContinuePrompt(generation: number): void {
		const continuePrompt = async () => {
			await this.#promptWithMessage(
				{
					role: "developer",
					content: [{ type: "text", text: autoContinuePrompt }],
					attribution: "agent",
					timestamp: Date.now(),
				},
				autoContinuePrompt,
				{ skipPostPromptRecoveryWait: true, skipCompactionCheck: true },
			);
		};
		const scheduledGeneration = generation;
		const signal = this.#postPromptTasksAbortController.signal;
		this.#trackPostPromptTask(
			(async () => {
				await Promise.resolve();
				if (signal.aborted) {
					this.#logCompactionContinuationSkipped("auto_continue_prompt", "aborted_signal");
					return;
				}
				if (this.#promptGeneration !== scheduledGeneration) {
					this.#logCompactionContinuationSkipped("auto_continue_prompt", "generation_changed");
					return;
				}
				try {
					await continuePrompt();
				} catch (error) {
					this.#logCompactionContinuationError("auto_continue_prompt", error);
				}
			})(),
		);
	}

	async #cancelPostPromptTasks(): Promise<void> {
		this.#postPromptTasksAbortController.abort();
		this.#postPromptTasksAbortController = new AbortController();
		this.#resolveTtsrResume();

		const pendingTasks = Array.from(this.#postPromptTasks);
		if (pendingTasks.length === 0) {
			this.#resolvePostPromptTasks();
			return;
		}

		await Promise.allSettled(pendingTasks);
		if (this.#postPromptTasks.size === 0) {
			this.#resolvePostPromptTasks();
		}
	}

	#abandonPostPromptTasks(): void {
		this.#postPromptTasksAbortController.abort();
		this.#postPromptTasksAbortController = new AbortController();
		this.#postPromptTasks.clear();
		this.#resolveTtsrResume();
		this.#resolvePostPromptTasks();
	}

	/**
	 * Wait for retry, TTSR resume, and any background continuation to settle.
	 * Loops because a TTSR continuation can trigger a retry (or vice-versa),
	 * and fire-and-forget `agent.continue()` may still be streaming after
	 * the TTSR resume gate resolves.
	 */
	async #waitForPostPromptRecovery(): Promise<void> {
		while (true) {
			if (this.#retryPromise) {
				await this.#retryPromise;
				continue;
			}
			if (this.#ttsrResumePromise) {
				await this.#ttsrResumePromise;
				continue;
			}
			if (this.#postPromptTasksPromise) {
				await this.#postPromptTasksPromise;
				continue;
			}
			// Tracked post-prompt tasks cover deferred continuations scheduled from
			// event handlers. Keep the streaming fallback for direct agent activity
			// outside the scheduler.
			if (this.agent.state.isStreaming) {
				await this.agent.waitForIdle();
				continue;
			}
			break;
		}
	}

	/** Get TTSR injection payload and clear pending injections. */
	#getTtsrInjectionContent(): { content: string; rules: Rule[] } | undefined {
		if (this.#pendingTtsrInjections.length === 0) return undefined;
		const rules = this.#pendingTtsrInjections;
		const content = rules
			.map(r => prompt.render(ttsrInterruptTemplate, { name: r.name, path: r.path, content: r.content }))
			.join("\n\n");
		this.#pendingTtsrInjections = [];
		return { content, rules };
	}

	#addPendingTtsrInjections(rules: Rule[]): void {
		const seen = new Set(this.#pendingTtsrInjections.map(rule => rule.name));
		for (const rule of rules) {
			if (seen.has(rule.name)) continue;
			this.#pendingTtsrInjections.push(rule);
			seen.add(rule.name);
		}
	}

	/** Tool-call id whose argument deltas triggered a TTSR match, when known. */
	#extractTtsrToolCallId(matchContext: TtsrMatchContext): string | undefined {
		if (matchContext.source !== "tool") return undefined;
		const key = matchContext.streamKey;
		if (typeof key !== "string" || !key.startsWith("toolcall:")) return undefined;
		const id = key.slice("toolcall:".length);
		return id.length > 0 ? id : undefined;
	}

	#addPerToolTtsrInjections(toolCallId: string, rules: Rule[]): void {
		const bucket = this.#perToolTtsrInjections.get(toolCallId) ?? [];
		const seen = new Set(bucket.map(rule => rule.name));
		// Dedupe against rules already bucketed for other tool calls in this
		// same assistant message so one rule attaches to exactly one tool call.
		const claimedElsewhere = new Set<string>();
		for (const [otherId, otherBucket] of this.#perToolTtsrInjections) {
			if (otherId === toolCallId) continue;
			for (const rule of otherBucket) claimedElsewhere.add(rule.name);
		}
		const newlyAdded: string[] = [];
		for (const rule of rules) {
			if (seen.has(rule.name) || claimedElsewhere.has(rule.name)) continue;
			bucket.push(rule);
			seen.add(rule.name);
			newlyAdded.push(rule.name);
		}
		if (bucket.length === 0) return;
		this.#perToolTtsrInjections.set(toolCallId, bucket);
		// Claim the rules in the TTSR manager so subsequent deltas in this same
		// turn (e.g. a sibling tool call's argument stream) don't re-match them.
		// Persistence still happens in #ttsrAfterToolCall when the tool actually
		// produces a result we can fold the reminder into.
		if (newlyAdded.length > 0) {
			this.#ttsrManager?.markInjectedByNames(newlyAdded);
		}
	}

	/** `afterToolCall` hook: fold any per-tool TTSR reminders into the result. */
	#ttsrAfterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		const rules = this.#perToolTtsrInjections.get(ctx.toolCall.id);
		if (!rules || rules.length === 0) return undefined;
		this.#perToolTtsrInjections.delete(ctx.toolCall.id);
		const reminder = rules
			.map(r => prompt.render(ttsrToolReminderTemplate, { name: r.name, path: r.path, content: r.content }))
			.join("\n\n");
		// The TTSR manager was already claimed at bucket time; only persistence remains.
		const ruleNames = rules.map(r => r.name.trim()).filter(n => n.length > 0);
		if (ruleNames.length > 0) {
			this.sessionManager.appendTtsrInjection(ruleNames);
		}
		return {
			content: [{ type: "text", text: reminder }, ...ctx.result.content],
		};
	}

	#extractTtsrRuleNames(details: unknown): string[] {
		if (!details || typeof details !== "object" || Array.isArray(details)) {
			return [];
		}
		const rules = (details as { rules?: unknown }).rules;
		if (!Array.isArray(rules)) {
			return [];
		}
		return rules.filter((ruleName): ruleName is string => typeof ruleName === "string");
	}

	#markTtsrInjected(ruleNames: string[]): void {
		const uniqueRuleNames = Array.from(
			new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
		);
		if (uniqueRuleNames.length === 0) {
			return;
		}
		this.#ttsrManager?.markInjectedByNames(uniqueRuleNames);
		this.sessionManager.appendTtsrInjection(uniqueRuleNames);
	}

	#findTtsrAssistantIndex(targetTimestamp: number | undefined): number {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") {
				continue;
			}
			if (targetTimestamp === undefined || message.timestamp === targetTimestamp) {
				return i;
			}
		}
		return -1;
	}

	#shouldInterruptForTtsrMatch(matches: Rule[], matchContext: TtsrMatchContext): boolean {
		const globalMode = this.#ttsrManager?.getSettings().interruptMode ?? "always";
		for (const rule of matches) {
			const mode = rule.interruptMode ?? globalMode;
			if (mode === "never") continue;
			if (mode === "prose-only" && (matchContext.source === "text" || matchContext.source === "thinking"))
				return true;
			if (mode === "tool-only" && matchContext.source === "tool") return true;
			if (mode === "always") return true;
		}
		return false;
	}

	#queueDeferredTtsrInjectionIfNeeded(assistantMsg: AssistantMessage): void {
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			// Tools that hadn't started by abort/error will never produce results to
			// fold injections into — drop their stale per-tool entries.
			this.#perToolTtsrInjections.clear();
		}
		if (this.#ttsrAbortPending || this.#pendingTtsrInjections.length === 0) {
			return;
		}
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			this.#pendingTtsrInjections = [];
			return;
		}

		const injection = this.#getTtsrInjectionContent();
		if (!injection) {
			return;
		}
		this.agent.followUp({
			role: "custom",
			customType: "ttsr-injection",
			content: injection.content,
			display: false,
			details: { rules: injection.rules.map(rule => rule.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#ensureTtsrResumePromise();
		// Mark as injected after this custom message is delivered and persisted (handled in message_end).
		// followUp() only enqueues; resume on the next tick once streaming settles.
		this.#scheduleAgentContinue({
			delayMs: 1,
			generation: this.#promptGeneration,
			onSkip: () => {
				this.#resolveTtsrResume();
			},
			shouldContinue: () => {
				if (this.agent.state.isStreaming || !this.agent.hasQueuedMessages()) {
					this.#resolveTtsrResume();
					return false;
				}
				return true;
			},
			onError: () => {
				this.#resolveTtsrResume();
			},
		});
	}

	/** Build TTSR match context for tool call argument deltas. */
	#getTtsrToolMatchContext(message: AgentMessage, contentIndex: number): TtsrMatchContext {
		const context: TtsrMatchContext = { source: "tool" };
		if (message.role !== "assistant") {
			return context;
		}

		const content = message.content;
		if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) {
			return context;
		}

		const block = content[contentIndex];
		if (!block || typeof block !== "object" || block.type !== "toolCall") {
			return context;
		}

		const toolCall = block as ToolCall;
		context.toolName = toolCall.name;
		context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
		context.filePaths = this.#extractTtsrFilePathsFromArgs(toolCall.arguments);
		return context;
	}

	/** Extract path-like arguments from tool call payload for TTSR glob matching. */
	#extractTtsrFilePathsFromArgs(args: unknown): string[] | undefined {
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			return undefined;
		}

		const rawPaths: string[] = [];
		for (const [key, value] of Object.entries(args)) {
			const normalizedKey = key.toLowerCase();
			if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
				rawPaths.push(value);
				continue;
			}
			if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
				for (const candidate of value) {
					if (typeof candidate === "string") {
						rawPaths.push(candidate);
					}
				}
			}
		}

		const normalizedPaths = rawPaths.flatMap(pathValue => this.#normalizeTtsrPathCandidates(pathValue));
		if (normalizedPaths.length === 0) {
			return undefined;
		}

		return Array.from(new Set(normalizedPaths));
	}

	/** Convert a path argument into stable relative/absolute candidates for glob checks. */
	#normalizeTtsrPathCandidates(rawPath: string): string[] {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const normalizedInput = trimmed.replaceAll("\\", "/");
		const candidates = new Set<string>([normalizedInput]);
		if (normalizedInput.startsWith("./")) {
			candidates.add(normalizedInput.slice(2));
		}

		const cwd = this.sessionManager.getCwd();
		const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
		candidates.add(absolutePath.replaceAll("\\", "/"));

		const relativePath = path.relative(cwd, absolutePath).replaceAll("\\", "/");
		if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
			candidates.add(relativePath);
		}

		return Array.from(candidates);
	}
	/** Extract text content from a message */
	#getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter(c => c.type === "text");
		const text = textBlocks.map(c => (c as TextContent).text).join("");
		if (text.length > 0) return text;
		const hasImages = content.some(c => c.type === "image");
		return hasImages ? "[Image]" : "";
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	#findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	#resetStreamingEditState(): void {
		this.#streamingEditAbortTriggered = false;
		this.#streamingEditCheckedLineCounts.clear();
		this.#streamingEditPrecheckedToolCallIds.clear();
		this.#streamingEditFileCache.clear();
	}

	#getStreamingEditToolCall(event: AgentEvent):
		| {
				toolCall: ToolCall;
				path: string;
				resolvedPath: string;
				diff?: string;
				op?: string;
				rename?: string;
		  }
		| undefined {
		if (event.type !== "message_update") return undefined;
		if (event.message.role !== "assistant") return undefined;

		const contentIndex = event.assistantMessageEvent.contentIndex ?? 0;
		const messageContent = event.message.content;
		if (!Array.isArray(messageContent) || contentIndex < 0 || contentIndex >= messageContent.length) {
			return undefined;
		}

		const toolCall = messageContent[contentIndex] as ToolCall;
		if (toolCall.name !== "edit") return undefined;

		const args = toolCall.arguments;
		if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
		if ("old_text" in args || "new_text" in args) return undefined;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) return undefined;

		// `local://` URLs (e.g. local://PLAN.md for plan-mode) resolve to a real
		// on-disk artifacts path; pre-caching works as long as we ask the
		// local-protocol handler. Other internal-scheme URLs have no stable filesystem representation;
		// skip pre-cache entirely for those — the edit tool itself will reject
		// them through its normal dispatch path.
		const resolvedPath = this.#resolveSessionFsPath(path);
		if (resolvedPath === undefined) return undefined;

		return {
			toolCall,
			path,
			resolvedPath,
			diff: typeof args.diff === "string" ? args.diff : undefined,
			op: typeof args.op === "string" ? args.op : undefined,
			rename: typeof args.rename === "string" ? args.rename : undefined,
		};
	}

	#lastStreamingEditToolCallId: string | undefined;
	#abortStreamingEditForAutoGeneratedPath(toolCall: ToolCall, path: string, resolvedPath: string): void {
		if (this.#lastStreamingEditToolCallId === toolCall.id) return;
		this.#lastStreamingEditToolCallId = toolCall.id;
		void assertEditableFile(resolvedPath, path).catch(err => {
			// peekFile and other I/O can reject with ENOENT, etc. Only ToolError means
			// auto-generated detection; other failures are left for the edit tool.
			if (!(err instanceof ToolError)) return;
			if (this.#lastStreamingEditToolCallId !== toolCall.id) return;

			if (!this.#streamingEditAbortTriggered) {
				this.#streamingEditAbortTriggered = true;
				logger.warn("Streaming edit aborted due to auto-generated file guard", {
					toolCallId: toolCall.id,
					path,
				});
				this.agent.abort();
			}
		});
	}

	#preCacheStreamingEditFile(event: AgentEvent): void {
		if (this.#streamingEditAbortTriggered) return;
		if (event.type !== "message_update") return;

		const assistantEvent = event.assistantMessageEvent;
		if (
			assistantEvent.type !== "toolcall_start" &&
			assistantEvent.type !== "toolcall_delta" &&
			assistantEvent.type !== "toolcall_end"
		) {
			return;
		}

		const streamingEdit = this.#getStreamingEditToolCall(event);
		if (!streamingEdit) return;

		// The auto-generated guard runs unconditionally: editing a generated file
		// is never the user's intent, and the cost of a false-positive abort is one
		// wasted turn vs. silently corrupting a regenerated source.
		const shouldCheckAutoGenerated =
			!streamingEdit.toolCall.id || !this.#streamingEditPrecheckedToolCallIds.has(streamingEdit.toolCall.id);
		if (shouldCheckAutoGenerated) {
			if (streamingEdit.toolCall.id) {
				this.#streamingEditPrecheckedToolCallIds.add(streamingEdit.toolCall.id);
			}
			this.#abortStreamingEditForAutoGeneratedPath(
				streamingEdit.toolCall,
				streamingEdit.path,
				streamingEdit.resolvedPath,
			);
		}

		// File-cache priming feeds #maybeAbortStreamingEdit's removed-lines check,
		// which is the optional patch-preview verification gated by
		// edit.streamingAbort. Skip the read when the setting is off.
		if (this.settings.get("edit.streamingAbort")) {
			this.#ensureFileCache(streamingEdit.resolvedPath);
		}
	}

	#ensureFileCache(resolvedPath: string): void {
		if (this.#streamingEditFileCache.has(resolvedPath)) return;

		try {
			const rawText = fs.readFileSync(resolvedPath, "utf-8");
			const { text } = stripBom(rawText);
			this.#streamingEditFileCache.set(resolvedPath, normalizeToLF(text));
		} catch {
			// Don't cache on read errors (including ENOENT) - let the edit tool handle them
		}
	}

	/** Invalidate cache for a file after an edit completes to prevent stale data */
	#invalidateFileCacheForPath(filePath: string): void {
		const resolvedPath = this.#resolveSessionFsPath(filePath);
		if (resolvedPath === undefined) return;
		this.#streamingEditFileCache.delete(resolvedPath);
	}

	/**
	 * Resolve a path supplied to a tool to a real filesystem path.
	 *
	 * - `local://` URLs route through the local-protocol handler so they map
	 *   onto the session's on-disk artifacts directory; pre-caching, ENOENT
	 *   handling, and post-edit invalidation all work normally.
	 * - Other internal-scheme URLs have no stable filesystem path; this returns
	 *   `undefined` so callers skip filesystem-only operations.
	 * - Cwd-relative and absolute paths resolve via `resolveToCwd`.
	 */
	#resolveSessionFsPath(filePath: string): string | undefined {
		const normalized = normalizeLocalScheme(filePath);
		if (normalized.startsWith("local:")) {
			return resolveLocalUrlToPath(normalized, this.#localProtocolOptions());
		}
		if (normalized.includes("://")) {
			return undefined;
		}
		return resolveToCwd(normalized, this.sessionManager.getCwd());
	}

	#localProtocolOptions(): LocalProtocolOptions {
		return {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		};
	}

	#maybeAbortStreamingEdit(event: AgentEvent, generation: number): void {
		if (!this.settings.get("edit.streamingAbort")) return;
		if (this.#streamingEditAbortTriggered) return;
		if (event.type !== "message_update") return;

		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type !== "toolcall_end" && assistantEvent.type !== "toolcall_delta") return;

		const streamingEdit = this.#getStreamingEditToolCall(event);
		if (!streamingEdit?.toolCall.id) return;

		const { toolCall, path, resolvedPath, diff, op, rename } = streamingEdit;
		if (!diff) return;
		if (op && op !== "update") return;

		if (!diff.includes("\n")) return;
		const lastNewlineIndex = diff.lastIndexOf("\n");
		if (lastNewlineIndex < 0) return;
		const diffForCheck = diff.endsWith("\n") ? diff : diff.slice(0, lastNewlineIndex + 1);
		if (diffForCheck.trim().length === 0) return;

		let normalizedDiff = normalizeDiff(diffForCheck.replace(/\r/g, ""));
		if (!normalizedDiff) return;
		// Deobfuscate the diff so removed lines match real file content
		if (this.#obfuscator) normalizedDiff = this.#obfuscator.deobfuscate(normalizedDiff);
		if (!normalizedDiff) return;
		const lines = normalizedDiff.split("\n");
		const hasChangeLine = lines.some(line => line.startsWith("+") || line.startsWith("-"));
		if (!hasChangeLine) return;

		const lineCount = lines.length;
		const lastChecked = this.#streamingEditCheckedLineCounts.get(toolCall.id);
		if (lastChecked !== undefined && lineCount <= lastChecked) return;
		this.#streamingEditCheckedLineCounts.set(toolCall.id, lineCount);

		const removedLines = lines
			.filter(line => line.startsWith("-") && !line.startsWith("--- "))
			.map(line => line.slice(1));
		if (removedLines.length > 0) {
			let cachedContent = this.#streamingEditFileCache.get(resolvedPath);
			if (cachedContent === undefined) {
				this.#ensureFileCache(resolvedPath);
				cachedContent = this.#streamingEditFileCache.get(resolvedPath);
			}
			if (cachedContent !== undefined) {
				const missing = removedLines.find(line => !cachedContent.includes(normalizeToLF(line)));
				if (missing) {
					this.#streamingEditAbortTriggered = true;
					logger.warn("Streaming edit aborted due to patch preview failure", {
						toolCallId: toolCall.id,
						path,
						error: `Failed to find expected lines in ${path}:\n${missing}`,
					});
					this.agent.abort();
				}
				return;
			}
			if (assistantEvent.type === "toolcall_delta") return;
			void this.#checkRemovedLinesAsync(generation, toolCall.id, path, resolvedPath, removedLines);
			return;
		}

		if (assistantEvent.type === "toolcall_delta") return;
		void this.#checkPreviewPatchAsync(generation, toolCall.id, path, rename, normalizedDiff);
	}

	async #checkRemovedLinesAsync(
		generation: number,
		toolCallId: string,
		path: string,
		resolvedPath: string,
		removedLines: string[],
	): Promise<void> {
		if (this.#streamingEditAbortTriggered) return;
		try {
			const { text } = stripBom(await Bun.file(resolvedPath).text());
			if (this.#promptGeneration !== generation) return;
			const normalizedContent = normalizeToLF(text);
			const missing = removedLines.find(line => !normalizedContent.includes(normalizeToLF(line)));
			if (missing) {
				this.#streamingEditAbortTriggered = true;
				logger.warn("Streaming edit aborted due to patch preview failure", {
					toolCallId,
					path,
					error: `Failed to find expected lines in ${path}:\n${missing}`,
				});
				this.agent.abort();
			}
		} catch (err) {
			// Ignore ENOENT (file not found) - let the edit tool handle missing files
			// Also ignore other errors during async fallback
			if (!isEnoent(err)) {
				// Log unexpected errors but don't abort
			}
		}
	}

	async #checkPreviewPatchAsync(
		generation: number,
		toolCallId: string,
		path: string,
		rename: string | undefined,
		normalizedDiff: string,
	): Promise<void> {
		if (this.#streamingEditAbortTriggered) return;
		try {
			await previewPatch(
				{ path, op: "update", rename, diff: normalizedDiff },
				{
					cwd: this.sessionManager.getCwd(),
					allowFuzzy: this.settings.get("edit.fuzzyMatch"),
					fuzzyThreshold: this.settings.get("edit.fuzzyThreshold"),
				},
			);
		} catch (error) {
			if (this.#promptGeneration !== generation) return;
			if (error instanceof ParseError) return;
			this.#streamingEditAbortTriggered = true;
			logger.warn("Streaming edit aborted due to patch preview failure", {
				toolCallId,
				path,
				error: error instanceof Error ? error.message : String(error),
			});
			this.agent.abort();
		}
	}

	/** Emit extension events based on session events */
	async #emitExtensionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "turn_end") {
			await requestGjcWorkerIntegrationAttempt(this.sessionManager.getCwd(), process.env).catch(error => {
				logger.warn("GJC team worker integration request failed", { error: String(error) });
			});
		}
		if (!this.#extensionRunner) return;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await this.#extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this.#extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const hookEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.#turnIndex,
				timestamp: Date.now(),
			};
			await this.#extensionRunner.emit(hookEvent);
		} else if (event.type === "turn_end") {
			const hookEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.#turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.#extensionRunner.emit(hookEvent);
			this.#turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "auto_compaction_start") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_start",
				reason: event.reason,
				action: event.action,
			});
		} else if (event.type === "auto_compaction_end") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_end",
				action: event.action,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			});
		} else if (event.type === "auto_retry_start") {
			await this.#extensionRunner.emit({
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				unbounded: event.unbounded,
			});
		} else if (event.type === "auto_retry_end") {
			await this.#extensionRunner.emit({
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
			});
		} else if (event.type === "ttsr_triggered") {
			await this.#extensionRunner.emit({ type: "ttsr_triggered", rules: event.rules });
		} else if (event.type === "todo_reminder") {
			await this.#extensionRunner.emit({
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			});
		} else if (event.type === "goal_updated") {
			await this.#extensionRunner.emit({
				type: "goal_updated",
				goal: event.goal,
				state: event.state,
			});
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this.#eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	#reconnectToAgent(): void {
		if (this.#unsubscribeAgent) return; // Already connected
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	/**
	 * Set agent.sessionId from the session manager and install a dynamic
	 * metadata resolver so every API request carries `metadata.user_id` shaped
	 * like real Anthropic Code's `getAPIMetadata` output: `{ session_id,
	 * account_uuid }` (the latter only when an Anthropic OAuth credential with
	 * a known account UUID is loaded). Resolving live keeps the value in sync
	 * with auth-state changes (login/logout, token refresh that surfaces a new
	 * account uuid) without needing to re-call `#syncAgentSessionId()` on every
	 * such event.
	 */
	#syncAgentSessionId(sessionId?: string): void {
		const sid = this.#providerSessionId ?? sessionId ?? this.sessionManager.getSessionId();
		this.agent.sessionId = sid;
		this.agent.providerSessionId = this.#providerCacheSessionId ?? sid;
		this.agent.setMetadataResolver((provider: string) =>
			buildSessionMetadata(sid, provider, this.#modelRegistry.authStorage),
		);
	}

	#rekeyHindsightMemoryForCurrentSessionId(): void {
		if (resolveMemoryBackend(this.settings).id !== "hindsight") return;
		const sid = this.agent.sessionId;
		if (!sid) return;
		this.getHindsightSessionState()?.setSessionId(sid);
	}

	/** New session file: reset auto-recall / retain-threshold counters for the new transcript. */
	#resetHindsightConversationTrackingIfHindsight(): void {
		if (resolveMemoryBackend(this.settings).id !== "hindsight") return;
		const state = this.getHindsightSessionState();
		if (!state || state.aliasOf) return;
		state.resetConversationTracking();
	}

	/**
	 * Remove all listeners, flush pending writes, and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	async dispose(): Promise<void> {
		this.#isDisposed = true;
		this.#pendingBackgroundExchanges = [];
		this.yieldQueue.clear();
		this.agent.setOnBeforeYield(undefined);
		this.#evalExecutionDisposing = true;
		try {
			if (this.#extensionRunner?.hasHandlers("session_shutdown")) {
				await this.#extensionRunner.emit({ type: "session_shutdown" });
			}
		} catch (error) {
			logger.warn("Failed to emit session_shutdown event", { error: String(error) });
		}
		await this.#cancelPostPromptTasks();
		// Cancel jobs this agent registered so a subagent's teardown doesn't
		// leak its background bash/task work into the parent's manager. Only
		// the session that owns the manager goes on to dispose it (which itself
		// nukes any leftover jobs and pending deliveries).
		this.#cancelOwnAsyncJobs();
		const ownedAsyncManager = this.#ownedAsyncJobManager;
		if (ownedAsyncManager) {
			const drained = await ownedAsyncManager.dispose({ timeoutMs: 3_000 });
			const deliveryState = ownedAsyncManager.getDeliveryState();
			if (drained === false && deliveryState) {
				logger.warn("Async job completion deliveries still pending during dispose", { ...deliveryState });
			}
			if (AsyncJobManager.instance() === ownedAsyncManager) {
				AsyncJobManager.setInstance(undefined);
			}
		}
		const mcpManager = MCPManager.instance();
		if (mcpManager) {
			await mcpManager.disconnectAll();
			if (MCPManager.instance() === mcpManager) {
				MCPManager.setInstance(undefined);
			}
		}
		await shutdownAllLspClients();
		// F13: release only THIS session's browser tabs on dispose (kill:false → remote
		// browsers disconnect, headless close gracefully). Scoped by the session id the
		// browser tool tagged tabs with, so other live sessions' tabs are untouched.
		// No-op when this session opened no tabs. Failure is logged, not thrown.
		await releaseTabsForOwner(this.sessionManager.getSessionId()).catch((error: unknown) =>
			logger.warn("session dispose: releaseTabsForOwner failed", { error }),
		);
		const pythonExecutionsSettled = await this.#prepareEvalExecutionsForDispose();
		if (!pythonExecutionsSettled) {
			logger.warn(
				"Detaching retained Python kernel ownership during dispose while Python execution is still active",
			);
		}
		await disposeKernelSessionsByOwner(this.#evalKernelOwnerId);
		await disposeVmContextsByOwner(this.#evalKernelOwnerId);
		this.#releasePowerAssertion();
		await this.sessionManager.close();
		this.#closeAllProviderSessions("dispose");
		const hindsightState = this.setHindsightSessionState(undefined);
		await hindsightState?.flushRetainQueue();
		hindsightState?.dispose();
		this.#disconnectFromAgent();
		if (this.#unsubscribeAppendOnly) {
			this.#unsubscribeAppendOnly();
			this.#unsubscribeAppendOnly = undefined;
		}
		this.#eventListeners = [];
	}

	/**
	 * Bounded, best-effort teardown of the subprocess-spawning resources this session
	 * owns: the browser tool's headless/spawned Chrome and the Python eval kernel + JS VM
	 * contexts. Unlike {@link dispose}, this touches only child processes and is time-boxed,
	 * so a top-level `SIGINT`/`SIGTERM`/`SIGHUP` handler can run it without hanging — without
	 * it, an external kill bypasses `dispose()` and orphans Chrome/Python to PID 1 (#698).
	 *
	 * Idempotent: every step is a no-op once the graceful {@link dispose} path has released
	 * the resources. Never throws; per-step failures are logged and the whole run is capped
	 * at `timeoutMs` so a wedged subprocess can't stall process exit.
	 */
	async disposeChildSubprocesses(timeoutMs = SIGNAL_TEARDOWN_TIMEOUT_MS): Promise<void> {
		const sessionId = this.sessionManager.getSessionId();
		const kernelOwnerId = this.#evalKernelOwnerId;
		const work = Promise.allSettled([
			// kill:true so a forced exit also reaps spawned-app Chrome we own (headless
			// always closes; connected/attached browsers only disconnect — never killed).
			releaseTabsForOwner(sessionId, { kill: true }).catch((error: unknown) =>
				logger.warn("signal teardown: releaseTabsForOwner failed", { error }),
			),
			disposeKernelSessionsByOwner(kernelOwnerId).catch((error: unknown) =>
				logger.warn("signal teardown: disposeKernelSessionsByOwner failed", { error }),
			),
			disposeVmContextsByOwner(kernelOwnerId).catch((error: unknown) =>
				logger.warn("signal teardown: disposeVmContextsByOwner failed", { error }),
			),
		]);
		await Promise.race([work, Bun.sleep(timeoutMs)]);
	}

	#closeAllProviderSessions(reason: string): void {
		for (const [providerKey, state] of this.#providerSessionState) {
			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state", {
					providerKey,
					reason,
					error: String(error),
				});
			}
		}

		this.#providerSessionState.clear();
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	get serviceTier(): ServiceTier | undefined {
		return this.agent.serviceTier;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#promptInFlightCount > 0;
	}

	/** Wait until streaming and deferred recovery work are fully settled. */
	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
		await this.#waitForPostPromptRecovery();
	}

	async drainAsyncJobDeliveriesForAcp(options?: { timeoutMs?: number }): Promise<boolean> {
		const manager = AsyncJobManager.instance();
		if (!manager) return false;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const before = manager.getDeliveryState(ownerFilter);
		if (before.queued === 0 && !before.delivering) return false;
		const previousAllowAcpAgentInitiatedTurns = this.#allowAcpAgentInitiatedTurns;
		this.#allowAcpAgentInitiatedTurns = true;
		try {
			const drained = await manager.drainDeliveries({ timeoutMs: options?.timeoutMs, filter: ownerFilter });
			const after = manager.getDeliveryState(ownerFilter);
			return drained && (before.queued !== after.queued || before.delivering !== after.delivering);
		} finally {
			this.#allowAcpAgentInitiatedTurns = previousAllowAcpAgentInitiatedTurns;
		}
	}

	/** Most recent assistant message in agent state. */
	getLastAssistantMessage(): AssistantMessage | undefined {
		return this.#findLastAssistantMessage();
	}
	/** Current effective system prompt blocks (includes any per-turn extension modifications) */
	get systemPrompt(): string[] {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this.#retryAttempt;
	}

	#collectDiscoverableMCPToolsFromRegistry(): Map<string, DiscoverableMCPTool> {
		return new Map(collectDiscoverableMCPTools(this.#toolRegistry.values()).map(tool => [tool.name, tool] as const));
	}

	#setDiscoverableMCPTools(discoverableMCPTools: Map<string, DiscoverableMCPTool>): void {
		this.#discoverableMCPTools = discoverableMCPTools;
		this.#invalidateDiscoveryCaches();
	}

	/** Single point for invalidating cached discovery indices. Call after any change that can
	 *  affect which tools should be discoverable: registry mutations (refreshMCPTools,
	 *  refreshRpcHostTools) or active-tool mutations (#applyActiveToolsByName). */
	#invalidateDiscoveryCaches(): void {
		this.#discoverableMCPSearchIndex = null;
		this.#discoverableToolSearchIndex = null;
	}

	#filterSelectableMCPToolNames(toolNames: Iterable<string>): string[] {
		return Array.from(toolNames).filter(name => this.#discoverableMCPTools.has(name) && this.#toolRegistry.has(name));
	}

	#getConfiguredDefaultSelectedMCPToolNames(): string[] {
		return this.#filterSelectableMCPToolNames([
			...this.#defaultSelectedMCPToolNames,
			...selectDiscoverableMCPToolNamesByServer(
				this.#discoverableMCPTools.values(),
				this.#defaultSelectedMCPServerNames,
			),
		]);
	}

	#pruneSelectedMCPToolNames(): void {
		this.#selectedMCPToolNames = new Set(this.#filterSelectableMCPToolNames(this.#selectedMCPToolNames));
	}

	#selectedMCPToolNamesMatch(left: string[], right: string[]): boolean {
		return left.length === right.length && left.every((name, index) => name === right[index]);
	}

	#rememberSessionDefaultSelectedMCPToolNames(
		sessionFile: string | null | undefined,
		toolNames: Iterable<string>,
	): void {
		if (!sessionFile) return;
		this.#sessionDefaultSelectedMCPToolNames.set(
			path.resolve(sessionFile),
			this.#filterSelectableMCPToolNames(toolNames),
		);
	}

	#getSessionDefaultSelectedMCPToolNames(sessionFile: string | null | undefined): string[] {
		if (!sessionFile) return [];
		return this.#sessionDefaultSelectedMCPToolNames.get(path.resolve(sessionFile)) ?? [];
	}

	#persistSelectedMCPToolNamesIfChanged(previousSelectedMCPToolNames: string[]): void {
		if (!this.#mcpDiscoveryEnabled) return;
		const nextSelectedMCPToolNames = this.getSelectedMCPToolNames();
		if (this.#selectedMCPToolNamesMatch(previousSelectedMCPToolNames, nextSelectedMCPToolNames)) {
			return;
		}
		this.sessionManager.appendMCPToolSelection(nextSelectedMCPToolNames);
	}

	#getActiveNonMCPToolNames(): string[] {
		return this.getActiveToolNames().filter(
			name => !this.#discoverableMCPTools.has(name) && this.#toolRegistry.has(name),
		);
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map(t => t.name);
	}

	/** Whether the edit tool is registered in this session. */
	get hasEditTool(): boolean {
		return this.#toolRegistry.has("edit");
	}

	/**
	 * Get a tool by name from the registry.
	 */
	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name);
	}

	/**
	 * Register a UI/control-plane request handler for a currently foregrounded
	 * managed bash execution. This is intentionally narrower than generic
	 * process/job control: unsupported tool types simply do not register a
	 * handler, so Ctrl+B-style folding fails closed instead of aborting or
	 * shell-suspending arbitrary work.
	 */
	registerForegroundBashBackgroundRequestHandler(handler: () => void): () => void {
		this.#foregroundBashBackgroundRequestHandler = handler;
		return () => {
			if (this.#foregroundBashBackgroundRequestHandler === handler) {
				this.#foregroundBashBackgroundRequestHandler = undefined;
			}
		};
	}

	/**
	 * Returns whether a managed foreground bash call is currently backgroundable.
	 * UI key handlers use this to avoid consuming normal editor shortcuts when
	 * no fold target exists.
	 */
	hasForegroundBashBackgroundRequestHandler(): boolean {
		return this.#foregroundBashBackgroundRequestHandler !== undefined;
	}

	/**
	 * Ask the active managed foreground bash call to return as a background job.
	 * Returns false when no supported foreground tool is currently backgroundable.
	 */
	requestForegroundBashBackground(): boolean {
		const handler = this.#foregroundBashBackgroundRequestHandler;
		if (!handler) return false;
		handler();
		return true;
	}

	/**
	 * Get all configured tool names (built-in via --tools or default, plus custom tools).
	 */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	#getEditModeSession() {
		return {
			settings: this.settings,
			getActiveModelString: () => (this.model ? formatModelString(this.model) : undefined),
		} as const;
	}

	#resolveActiveEditMode(): EditMode {
		return resolveEditMode(this.#getEditModeSession());
	}

	async #syncEditToolModeAfterModelChange(previousEditMode: EditMode): Promise<void> {
		const currentEditMode = this.#resolveActiveEditMode();
		if (previousEditMode !== currentEditMode && this.getActiveToolNames().includes("edit")) {
			await this.refreshBaseSystemPrompt();
		}
	}

	isMCPDiscoveryEnabled(): boolean {
		return this.#mcpDiscoveryEnabled;
	}

	/** @deprecated Use {@link getDiscoverableTools} with `{ source: "mcp" }` instead.
	 *  Preserves the legacy `description`-bearing MCP shape for back-compat callers. */
	getDiscoverableMCPTools(): DiscoverableMCPTool[] {
		return Array.from(this.#discoverableMCPTools.values()).map(t => ({
			name: t.name,
			label: t.label,
			description: t.description,
			serverName: t.serverName,
			mcpToolName: t.mcpToolName,
			schemaKeys: t.schemaKeys,
		}));
	}

	/** @deprecated Use {@link getDiscoverableToolSearchIndex} instead.
	 *  Returns the legacy MCP search index whose documents expose `tool.description`. */
	getDiscoverableMCPSearchIndex(): DiscoverableMCPSearchIndex {
		if (!this.#discoverableMCPSearchIndex) {
			this.#discoverableMCPSearchIndex = buildDiscoverableMCPSearchIndex(this.#discoverableMCPTools.values());
		}
		return this.#discoverableMCPSearchIndex;
	}

	getSelectedMCPToolNames(): string[] {
		if (!this.#mcpDiscoveryEnabled) {
			return this.getActiveToolNames().filter(name => isMCPToolName(name) && this.#toolRegistry.has(name));
		}
		return this.#filterSelectableMCPToolNames(this.#selectedMCPToolNames);
	}

	async activateDiscoveredMCPTools(toolNames: string[]): Promise<string[]> {
		const nextSelectedMCPToolNames = new Set(this.#selectedMCPToolNames);
		const activated: string[] = [];
		for (const name of toolNames) {
			if (!this.#discoverableMCPTools.has(name) || !this.#toolRegistry.has(name)) {
				continue;
			}
			nextSelectedMCPToolNames.add(name);
			activated.push(name);
		}
		if (activated.length === 0) {
			return [];
		}
		const nextActive = [
			...this.#getActiveNonMCPToolNames(),
			...this.#filterSelectableMCPToolNames(nextSelectedMCPToolNames),
		];
		await this.setActiveToolsByName(nextActive);
		return [...new Set(activated)];
	}

	// ── Generic tool discovery (covers built-in + MCP + extension) ────────────

	/** Resolve effective discovery mode: tools.discoveryMode wins; mcp.discoveryMode is back-compat alias. */
	#resolveEffectiveDiscoveryMode(): "off" | "mcp-only" | "all" {
		const toolsMode = this.settings.get("tools.discoveryMode");
		if (toolsMode !== "off") return toolsMode as "off" | "mcp-only" | "all";
		if (this.settings.get("mcp.discoveryMode")) return "mcp-only";
		return "off";
	}

	isToolDiscoveryEnabled(): boolean {
		return this.#resolveEffectiveDiscoveryMode() !== "off";
	}

	getDiscoverableTools(filter?: { source?: DiscoverableTool["source"] }): DiscoverableTool[] {
		// For "all" mode we combine built-in registry entries + MCP tools.
		// For "mcp-only" mode we only return MCP tools.
		const mode = this.#resolveEffectiveDiscoveryMode();
		const activeNames = new Set(this.getActiveToolNames());
		const mcpTools: DiscoverableTool[] = Array.from(this.#discoverableMCPTools.values())
			.filter(t => !activeNames.has(t.name))
			.map(t => ({
				name: t.name,
				label: t.label,
				summary: t.description,
				source: "mcp" as const,
				serverName: t.serverName,
				mcpToolName: t.mcpToolName,
				schemaKeys: t.schemaKeys,
			}));
		const builtinTools: DiscoverableTool[] = mode === "all" ? this.#collectDiscoverableBuiltinTools() : [];
		const allTools = [...builtinTools, ...mcpTools];
		return filter?.source ? allTools.filter(t => t.source === filter.source) : allTools;
	}

	/** Collect built-in tools the model can discover via search_tool_bm25. Restricted to tool
	 *  definitions whose `loadMode === "discoverable"`. This keeps hidden/internal tools
	 *  (resolve, yield, report_finding) out of the index and avoids mislabeling
	 *  extension/custom default-inactive tools as built-ins. */
	#collectDiscoverableBuiltinTools(): DiscoverableTool[] {
		const activeNames = new Set(this.getActiveToolNames());
		const result: DiscoverableTool[] = [];
		for (const tool of this.#toolRegistry.values()) {
			if (tool.loadMode !== "discoverable") continue;
			if (activeNames.has(tool.name)) continue;
			if (this.#discoverableToolAllowedNames && !this.#discoverableToolAllowedNames.has(tool.name)) continue;
			const collected = collectDiscoverableTools([tool], { source: "builtin" });
			result.push(...collected);
		}
		return result;
	}

	getDiscoverableToolSearchIndex(): DiscoverableToolSearchIndex {
		if (!this.#discoverableToolSearchIndex) {
			this.#discoverableToolSearchIndex = buildDiscoverableToolSearchIndex(this.getDiscoverableTools());
		}
		return this.#discoverableToolSearchIndex;
	}

	/** Invalidate the generic search index cache (call after tool set changes).
	 *  Delegates to {@link #invalidateDiscoveryCaches} so all discovery-related caches stay in sync. */
	#invalidateDiscoverableToolSearchIndex(): void {
		this.#invalidateDiscoveryCaches();
	}

	getSelectedDiscoveredToolNames(): string[] {
		// Union of MCP-selected and generic non-MCP selected. Non-MCP selections are only
		// selected while they are still active; otherwise BM25 must be able to rediscover them.
		const activeNames = new Set(this.getActiveToolNames());
		const mcpSelected = this.getSelectedMCPToolNames();
		const nonMcpSelected = Array.from(this.#selectedDiscoveredToolNames).filter(
			name => activeNames.has(name) && this.#toolRegistry.has(name) && !isMCPToolName(name),
		);
		return [...new Set([...mcpSelected, ...nonMcpSelected])];
	}

	async activateDiscoveredTools(toolNames: string[]): Promise<string[]> {
		const mcpNames = toolNames.filter(name => this.#discoverableMCPTools.has(name));
		const nonMcpNames = toolNames.filter(name => !this.#discoverableMCPTools.has(name));
		const activated: string[] = [];

		// Activate MCP tools via existing path
		if (mcpNames.length > 0) {
			const activatedMcp = await this.activateDiscoveredMCPTools(mcpNames);
			activated.push(...activatedMcp);
		}

		// Activate non-MCP tools (built-ins that are in the registry but not currently active)
		if (nonMcpNames.length > 0) {
			const currentActiveNames = new Set(this.getActiveToolNames());
			const newlyAdded: string[] = [];
			for (const name of nonMcpNames) {
				if (this.#discoverableToolAllowedNames && !this.#discoverableToolAllowedNames.has(name)) continue;
				if (this.#toolRegistry.has(name) && !currentActiveNames.has(name)) {
					newlyAdded.push(name);
					this.#selectedDiscoveredToolNames.add(name);
					activated.push(name);
				}
			}
			if (newlyAdded.length > 0) {
				const nextActive = [...this.getActiveToolNames(), ...newlyAdded];
				await this.setActiveToolsByName(nextActive);
				this.#invalidateDiscoverableToolSearchIndex();
			}
		}

		return [...new Set(activated)];
	}

	/**
	 * Wrap a tool with a permission-gate proxy when an ACP client is connected.
	 * Only wraps tools whose name is in PERMISSION_REQUIRED_TOOLS and only when
	 * the bridge exposes `requestPermission`. No-ops for all other cases.
	 */
	#wrapToolForAcpPermission<T extends AgentTool>(tool: T): T {
		const bridge = this.#clientBridge;
		// Match the capability+method gating pattern used by read/write/bash.
		if (!bridge?.capabilities.requestPermission || !bridge.requestPermission) return tool;
		if (!PERMISSION_REQUIRED_TOOLS.has(tool.name)) return tool;
		return new Proxy(tool, {
			get: (target, prop) => {
				if (prop !== "execute") return Reflect.get(target, prop, target);
				return async (
					toolCallId: string,
					args: unknown,
					signal: AbortSignal | undefined,
					onUpdate: never,
					ctx: never,
				) => {
					const permissionIntent = getPermissionIntent(target.name, args);
					if (!permissionIntent) {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					const isShellExecutionTool = isShellExecutionPermissionTool(target.name);
					const command =
						isShellExecutionTool && args && typeof args === "object" && !Array.isArray(args)
							? getStringProperty(args as Record<string, unknown>, "command")
							: undefined;
					const commandContent = command
						? [{ type: "content" as const, content: { type: "text" as const, text: `$ ${command}` } }]
						: undefined;
					// Short-circuit on persisted decisions.
					const persisted = this.#acpPermissionDecisions.get(permissionIntent.cacheKey);
					if (persisted === "allow_always") {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					if (persisted === "reject_always") {
						throw new ToolError(`Tool call rejected by user (preference)`);
					}
					if (signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					type PermissionRaceResult =
						| { kind: "permission"; outcome: ClientBridgePermissionOutcome }
						| { kind: "aborted" };
					const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<PermissionRaceResult>();
					const onAbort = () => resolveAbort({ kind: "aborted" });
					signal?.addEventListener("abort", onAbort, { once: true });
					let raced: PermissionRaceResult;
					try {
						const permissionPromise = bridge.requestPermission!(
							{
								toolCallId,
								toolName: target.name,
								title: permissionIntent.title,
								...(isShellExecutionTool ? { kind: "execute" } : {}),
								status: "pending",
								rawInput: args,
								...(commandContent ? { content: commandContent } : {}),
								locations: extractPermissionLocations(
									args,
									this.sessionManager.getCwd(),
									permissionIntent.paths,
								),
							},
							PERMISSION_OPTIONS,
							signal,
						).then(outcome => ({ kind: "permission" as const, outcome }));
						raced = await Promise.race([permissionPromise, abortPromise]);
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
					if (raced.kind === "aborted" || signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					const outcome = raced.outcome;
					if (outcome.outcome === "cancelled") {
						throw new ToolAbortError("Permission request cancelled");
					}
					const selectedOption = PERMISSION_OPTIONS_BY_ID.get(outcome.optionId);
					if (!selectedOption) {
						throw new ToolError(`Tool permission response used unknown option ID: ${outcome.optionId}`);
					}
					if (selectedOption.kind === "allow_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "allow_always");
					} else if (selectedOption.kind === "reject_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "reject_always");
					}
					if (selectedOption.kind === "reject_once" || selectedOption.kind === "reject_always") {
						throw new ToolError(`Tool call rejected by user (${target.name})`);
					}
					return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
				};
			},
		}) as T;
	}

	/**
	 * Wrap a tool with the deep-interview mutation guard. This guard is intentionally
	 * outermost so active interviews reject product-code mutation before ACP permission
	 * prompts or tool execution can run.
	 */
	#wrapToolForDeepInterviewMutationGuard<T extends AgentTool>(tool: T): T {
		if (!["edit", "write", "ast_edit"].includes(tool.name)) return tool;
		return new Proxy(tool, {
			get: (target, prop) => {
				if (prop !== "execute") return Reflect.get(target, prop, target);
				return async (
					toolCallId: string,
					args: unknown,
					signal: AbortSignal | undefined,
					onUpdate: never,
					ctx: never,
				) => {
					await assertWorkflowMutationAllowed({
						cwd: this.sessionManager.getCwd(),
						sessionId: this.sessionManager.getSessionId(),
						tool: target,
						args,
					});
					return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
				};
			},
		}) as T;
	}

	#prepareToolForExecution<T extends AgentTool>(tool: T): T {
		return this.#wrapToolForDeepInterviewMutationGuard(
			this.#wrapToolForAcpPermission(guardToolForUltragoalAsk(tool, () => this.sessionManager.getCwd())),
		);
	}

	#setGuardedAgentTools(tools: AgentTool[]): void {
		this.agent.setTools(tools.map(tool => this.#prepareToolForExecution(tool)));
	}

	async #applyActiveToolsByName(
		toolNames: string[],
		options?: { persistMCPSelection?: boolean; previousSelectedMCPToolNames?: string[] },
	): Promise<void> {
		toolNames = [...new Set(toolNames.map(name => name.toLowerCase()))];
		const previousSelectedMCPToolNames = options?.previousSelectedMCPToolNames ?? this.getSelectedMCPToolNames();
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this.#toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		if (this.#mcpDiscoveryEnabled) {
			this.#selectedMCPToolNames = new Set(
				validToolNames.filter(
					name => isMCPToolName(name) && this.#discoverableMCPTools.has(name) && this.#toolRegistry.has(name),
				),
			);
		}
		const activeNameSet = new Set(validToolNames);
		for (const name of Array.from(this.#selectedDiscoveredToolNames)) {
			if (!activeNameSet.has(name) || this.#discoverableMCPTools.has(name) || !this.#toolRegistry.has(name)) {
				this.#selectedDiscoveredToolNames.delete(name);
			}
		}
		this.#setGuardedAgentTools(tools);

		// Active tool set changed → discoverable tool list (which excludes already-active tools)
		// is now stale. Invalidate before any prompt-template hook reads the discovery list.
		this.#invalidateDiscoveryCaches();

		// Rebuild base system prompt with new tool set, but only when the tool set
		// actually changed. MCP servers can reconnect at arbitrary times and call
		// `refreshMCPTools` -> `#applyActiveToolsByName` even though the resulting
		// tool list is byte-identical. Skipping the rebuild keeps the system prompt
		// stable, which is required for Anthropic prompt caching to keep hitting.
		if (this.#rebuildSystemPrompt) {
			const signature = this.#computeAppliedToolSignature(validToolNames, tools);
			if (signature !== this.#lastAppliedToolSignature) {
				const built = await this.#rebuildSystemPrompt(validToolNames, this.#toolRegistry);
				this.#baseSystemPrompt = built.systemPrompt;
				this.agent.setSystemPrompt(this.#baseSystemPrompt);
				this.#lastAppliedToolSignature = signature;
			}
		}
		if (options?.persistMCPSelection !== false) {
			this.#persistSelectedMCPToolNamesIfChanged(previousSelectedMCPToolNames);
		}
	}

	/**
	 * Reload the SSH tool from disk-backed capability discovery and make the
	 * refreshed definition visible to the next model call without restarting.
	 */
	async refreshSshTool(options?: { activateIfAvailable?: boolean }): Promise<void> {
		resetCapabilities();
		if (!this.#reloadSshTool) return;
		const previousSshTool = this.#toolRegistry.get("ssh");
		const previousActiveToolNames = this.getActiveToolNames();
		const hadSshTool = previousSshTool !== undefined;
		const wasActive = previousActiveToolNames.includes("ssh");
		const previousHostNames =
			previousSshTool && "hostNames" in previousSshTool && Array.isArray(previousSshTool.hostNames)
				? [...previousSshTool.hostNames]
				: [];
		const candidateHostNames = new Set(previousHostNames);
		const capability = await loadCapability<{ name: string }>("ssh", { cwd: this.sessionManager.getCwd() });
		for (const host of capability.items) {
			if (typeof host?.name === "string") {
				candidateHostNames.add(host.name);
			}
		}
		await invalidateHostMetadata(candidateHostNames);
		const sshAllowed = this.#requestedToolNames === undefined || this.#requestedToolNames.has("ssh");
		const refreshedTool = await this.#reloadSshTool();
		if (refreshedTool) {
			this.#toolRegistry.set(refreshedTool.name, refreshedTool);
		} else {
			this.#toolRegistry.delete("ssh");
			this.#selectedDiscoveredToolNames.delete("ssh");
		}

		const nextActive = previousActiveToolNames.filter(name => name !== "ssh" && this.#toolRegistry.has(name));
		if (refreshedTool && sshAllowed && (wasActive || (options?.activateIfAvailable && !hadSshTool))) {
			nextActive.push(refreshedTool.name);
		}
		await this.#applyActiveToolsByName(nextActive);
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect before the next model call.
	 */
	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		await this.#applyActiveToolsByName(toolNames);
	}

	async #restoreMCPSelectionsForSessionContext(
		sessionContext: SessionContext,
		options?: { fallbackSelectedMCPToolNames?: Iterable<string> },
	): Promise<void> {
		if (!this.#mcpDiscoveryEnabled) return;
		const nextActiveNonMCPToolNames = this.#getActiveNonMCPToolNames();
		const fallbackSelectedMCPToolNames =
			options?.fallbackSelectedMCPToolNames ?? this.#getConfiguredDefaultSelectedMCPToolNames();
		const restoredMCPToolNames = sessionContext.hasPersistedMCPToolSelection
			? this.#filterSelectableMCPToolNames(sessionContext.selectedMCPToolNames)
			: this.#filterSelectableMCPToolNames(fallbackSelectedMCPToolNames);
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionFile,
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);
		await this.#applyActiveToolsByName([...nextActiveNonMCPToolNames, ...restoredMCPToolNames], {
			persistMCPSelection: false,
		});
	}
	/** Rebuild the base system prompt using the current active tool set. */
	async refreshBaseSystemPrompt(): Promise<void> {
		if (!this.#rebuildSystemPrompt) return;
		const activeToolNames = this.getActiveToolNames();
		const built = await this.#rebuildSystemPrompt(activeToolNames, this.#toolRegistry);
		this.#baseSystemPrompt = built.systemPrompt;
		this.agent.setSystemPrompt(this.#baseSystemPrompt);
		// Refresh the cached signature so a subsequent `#applyActiveToolsByName` with
		// the same tool set does not re-rebuild on top of the explicit refresh we
		// just performed (and conversely, a different set forces a fresh rebuild).
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool != null);
		this.#lastAppliedToolSignature = this.#computeAppliedToolSignature(activeToolNames, activeTools);
	}

	async #buildSystemPromptForAgentStart(promptText: string): Promise<string[]> {
		const backend = resolveMemoryBackend(this.settings);
		if (!backend.beforeAgentStartPrompt) return this.#baseSystemPrompt;

		try {
			const injected = await backend.beforeAgentStartPrompt(this, promptText);
			if (!injected) return this.#baseSystemPrompt;
			return [...this.#baseSystemPrompt, injected];
		} catch (err) {
			logger.debug("Memory backend beforeAgentStartPrompt failed", {
				backend: backend.id,
				error: String(err),
			});
			return this.#baseSystemPrompt;
		}
	}

	/**
	 * Compose a stable signature for the inputs that `rebuildSystemPrompt` reads.
	 * Two calls producing identical signatures are guaranteed to produce identical
	 * system prompt bytes, so the rebuild can be skipped.
	 *
	 * The signature covers:
	 *   1. Active tool names in order (the prompt renders them in this order).
	 *   2. Active tool labels, descriptions, and wire-visible names — all are
	 *      rendered into the prompt body (see `system-prompt.md` `{{label}}: \`{{name}}\``
	 *      and `toolPromptNames` in `buildSystemPrompt`). The wire name comes from
	 *      `tool.customWireName` and overrides the internal name on the model wire
	 *      (e.g. `edit` exposes itself as `apply_patch` to GPT-5 in apply_patch mode);
	 *      a stale wire name would desync prompt guidance from actual tool routing.
	 *   3. When MCP discovery is on, every registry tool's name+label+description+
	 *      customWireName, since `rebuildSystemPrompt` summarizes discoverable MCP
	 *      tools that are not in the active set.
	 *   4. MCP server instructions text (per server), since `rebuildSystemPrompt`
	 *      embeds these in the appended prompt under "## MCP Server Instructions".
	 *      A server upgrade can change instructions while keeping tools identical.
	 *
	 * Settings-driven tool metadata is covered automatically: built-in tools that
	 * depend on settings expose `description`/`label` via getters (see `TaskTool`,
	 * `SearchToolBm25Tool`, `EditTool`), and the signature reads them live on every
	 * call - so a settings flip that mutates the rendered string differs the signature
	 * the next time `#applyActiveToolsByName` runs. Do not refactor `describeTool` to
	 * cache per-tool strings without preserving this property.
	 *
	 * Inputs NOT covered: tool input schemas; memory instructions read from disk;
	 * and SDK-init-time closure constants in `sdk.ts` (`repeatToolDescriptions`,
	 * `eagerTasks`, `intentField`, `mcpDiscoveryEnabled`, `secretsEnabled`). The
	 * closure-captured ones cannot change at runtime regardless of skip behavior.
	 * For everything else, callers must explicitly call `refreshBaseSystemPrompt()`
	 * after side-effecting changes; see e.g. the memory hooks and
	 * `#syncEditToolModeAfterModelChange`.
	 *
	 * The current calendar date IS covered (appended as a segment) because
	 * `buildSystemPrompt` injects it into the prompt body (`Today is '{{date}}'`).
	 * Without this, a session spanning midnight with only tool-stable MCP
	 * reconnects would keep yesterday's date indefinitely.
	 */
	#computeAppliedToolSignature(toolNames: string[], tools: AgentTool[]): string {
		// Order-preserving join: any reorder must produce a different signature so
		// the rebuild fires and the new tool list reaches the API.
		const nameSegment = toolNames.join("\u0001");
		const describeTool = (tool: AgentTool): string =>
			`${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}`;
		const descriptionSegment = tools.map(describeTool).join("\u0002");
		let registrySegment = "";
		if (this.#mcpDiscoveryEnabled) {
			// Registry iteration order is not load-bearing for the prompt content, so we
			// sort to keep the signature insensitive to incidental insertion order.
			const entries: string[] = [];
			for (const tool of this.#toolRegistry.values()) {
				entries.push(describeTool(tool));
			}
			entries.sort();
			registrySegment = entries.join("\u0004");
		}
		let instructionsSegment = "";
		const serverInstructions = this.#getMcpServerInstructions?.();
		if (serverInstructions && serverInstructions.size > 0) {
			// Sort by server name so transport flap order does not perturb the signature.
			const entries: string[] = [];
			for (const [server, instructions] of serverInstructions) {
				entries.push(`${server}=${instructions}`);
			}
			entries.sort();
			instructionsSegment = entries.join("\u0006");
		}
		const date = new Date().toISOString().slice(0, 10);
		return `${nameSegment}\u0003${descriptionSegment}\u0005${registrySegment}\u0007${instructionsSegment}|${date}`;
	}

	/**
	 * Replace MCP tools in the registry and recompute the visible MCP tool set immediately.
	 * This allows /mcp add/remove/reauth to take effect without restarting the session.
	 */
	async refreshMCPTools(mcpTools: CustomTool[]): Promise<void> {
		const previousSelectedMCPToolNames = this.getSelectedMCPToolNames();
		const existingNames = Array.from(this.#toolRegistry.keys());
		for (const name of existingNames) {
			const tool = this.#toolRegistry.get(name);
			if (this.#discoverableMCPTools.has(name) || (tool && isMCPBridgeTool(tool))) {
				this.#toolRegistry.delete(name);
			}
		}

		const getCustomToolContext = (): CustomToolContext => ({
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				this.agent.abort();
			},
		});

		for (const customTool of mcpTools) {
			const wrapped = CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool;
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
		}

		this.#setDiscoverableMCPTools(this.#collectDiscoverableMCPToolsFromRegistry());
		this.#pruneSelectedMCPToolNames();
		if (!this.buildDisplaySessionContext().hasPersistedMCPToolSelection) {
			this.#selectedMCPToolNames = new Set([
				...this.#selectedMCPToolNames,
				...this.#getConfiguredDefaultSelectedMCPToolNames(),
			]);
		}
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionFile,
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);

		const nextActive = [...this.#getActiveNonMCPToolNames(), ...this.getSelectedMCPToolNames()];
		await this.#applyActiveToolsByName(nextActive, { previousSelectedMCPToolNames });
	}

	/**
	 * Replace RPC host-owned tools and refresh the active tool set before the next model call.
	 */
	async refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		const nextToolNames = rpcTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("RPC host tool names must be unique");
		}
		if (uniqueToolNames.has("ask")) {
			throw new Error('RPC host tool "ask" is reserved and cannot be supplied by the host');
		}

		for (const name of uniqueToolNames) {
			if (this.#toolRegistry.has(name) && !this.#rpcHostToolNames.has(name)) {
				throw new Error(`RPC host tool "${name}" conflicts with an existing tool`);
			}
		}

		const previousRpcHostToolNames = new Set(this.#rpcHostToolNames);
		const previousActiveToolNames = this.getActiveToolNames();
		for (const name of previousRpcHostToolNames) {
			this.#toolRegistry.delete(name);
		}
		this.#rpcHostToolNames.clear();

		for (const tool of rpcTools) {
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(tool, this.#extensionRunner) : tool
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
			this.#rpcHostToolNames.add(finalTool.name);
		}

		// Registry contents changed — invalidate discovery caches so the next BM25 lookup sees
		// the new RPC-host tool set. (#applyActiveToolsByName below also invalidates, but doing
		// it here too keeps the contract local to "registry mutated".)
		this.#invalidateDiscoveryCaches();

		const activeNonRpcToolNames = previousActiveToolNames.filter(name => !previousRpcHostToolNames.has(name));
		const preservedRpcToolNames = previousActiveToolNames.filter(
			name => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
		);
		const autoActivatedRpcToolNames = rpcTools
			.filter(tool => !tool.hidden && !previousRpcHostToolNames.has(tool.name))
			.map(tool => tool.name);
		await this.#applyActiveToolsByName(
			Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
		);
	}

	async #hasActiveGjcSubskillTools(parent: string, sessionId: string | undefined): Promise<boolean> {
		if (!parent.trim()) return false;
		const cwd = this.sessionManager.getCwd();
		const phase = await resolveCurrentPhaseForParent({ cwd, sessionId, parent });
		const entries = await readActiveSubskillsForParent({ cwd, sessionId, parent, phase });
		return entries.some(entry => (entry.toolPaths ?? []).some(toolPath => toolPath.trim().length > 0));
	}

	#getCustomToolContext(): CustomToolContext {
		return {
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				this.agent.abort();
			},
		};
	}

	#computeGjcSubskillToolSignature(tools: CustomTool[]): string {
		return tools
			.map(tool => `${tool.name}\u0000${tool.description}\u0000${JSON.stringify(tool.parameters)}`)
			.sort()
			.join("\u0001");
	}

	/**
	 * Refresh plugin sub-skill tools after workflow/sub-skill activation or phase changes.
	 */
	async refreshGjcSubskillTools(): Promise<void> {
		const activeState = await readVisibleSkillActiveState(
			this.sessionManager.getCwd(),
			this.sessionManager.getSessionId(),
		);
		const activeSkill =
			this.#activeSkillState?.skill ??
			activeState?.skill ??
			activeState?.active_skills?.find(entry => entry.active !== false)?.skill;
		const parent = activeSkill?.trim();
		if (!parent) {
			if (this.#gjcSubskillToolNames.size === 0) return;
			const previousGjcSubskillToolNames = new Set(this.#gjcSubskillToolNames);
			const previousActiveToolNames = this.getActiveToolNames();
			for (const name of previousGjcSubskillToolNames) {
				this.#toolRegistry.delete(name);
			}
			this.#gjcSubskillToolNames.clear();
			this.#invalidateDiscoveryCaches();
			await this.#applyActiveToolsByName(
				previousActiveToolNames.filter(name => !previousGjcSubskillToolNames.has(name)),
			);
			return;
		}

		const cwd = this.sessionManager.getCwd();
		const sessionId =
			this.#activeSkillState?.sessionId ?? activeState?.session_id ?? this.sessionManager.getSessionId();
		if (this.#gjcSubskillToolNames.size === 0 && !(await this.#hasActiveGjcSubskillTools(parent, sessionId))) return;

		const phase = await resolveCurrentPhaseForParent({ cwd, sessionId, parent });
		const reservedToolNames = Array.from(this.#toolRegistry.keys()).filter(
			name => !this.#gjcSubskillToolNames.has(name),
		);
		const customTools = await loadActiveSubskillTools({ cwd, sessionId, parent, phase, reservedToolNames });
		const nextToolNames = customTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("GJC sub-skill tool names must be unique");
		}

		const previousGjcSubskillToolNames = new Set(this.#gjcSubskillToolNames);
		const nextSignature = this.#computeGjcSubskillToolSignature(customTools);
		if (this.#gjcSubskillToolSignature === nextSignature) {
			return;
		}

		const previousActiveToolNames = this.getActiveToolNames();
		for (const name of previousGjcSubskillToolNames) {
			this.#toolRegistry.delete(name);
		}
		this.#gjcSubskillToolNames.clear();
		this.#gjcSubskillToolSignature = undefined;

		const getCustomToolContext = () => this.#getCustomToolContext();
		for (const customTool of customTools) {
			const wrapped = CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool;
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
			this.#gjcSubskillToolNames.add(finalTool.name);
		}
		this.#gjcSubskillToolSignature = nextSignature;

		this.#invalidateDiscoveryCaches();
		const activeNonGjcSubskillToolNames = previousActiveToolNames.filter(
			name => !previousGjcSubskillToolNames.has(name),
		);
		const preservedGjcSubskillToolNames = previousActiveToolNames.filter(
			name => previousGjcSubskillToolNames.has(name) && this.#gjcSubskillToolNames.has(name),
		);
		const autoActivatedGjcSubskillToolNames = customTools
			.filter(tool => !tool.hidden && !previousGjcSubskillToolNames.has(tool.name))
			.map(tool => tool.name);
		await this.#applyActiveToolsByName(
			Array.from(
				new Set([
					...activeNonGjcSubskillToolNames,
					...preservedGjcSubskillToolNames,
					...autoActivatedGjcSubskillToolNames,
				]),
			),
		);
	}

	/** Whether auto-compaction is currently running */
	get isCompacting(): boolean {
		return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined;
	}

	/**
	 * Whether idle-flush tasks, auto-continuations, or other short-lived
	 * post-prompt work are pending.  True in the brief window after
	 * `session.prompt()` returns but before a scheduled background delivery
	 * (e.g. an async-job result) has finished its own streaming turn.
	 * Loop-mode and similar auto-submit paths should treat this as a block
	 * to avoid racing against the delivery turn.
	 */
	get hasPostPromptWork(): boolean {
		return this.#postPromptTasks.size > 0;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	buildDisplaySessionContext(): SessionContext {
		return deobfuscateSessionContext(this.sessionManager.buildSessionContext(), this.#obfuscator);
	}

	/** Convert session messages using the same pre-LLM pipeline as the active session. */
	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		const transformedMessages = await this.#transformContext(messages, signal);
		return await this.#convertToLlm(transformedMessages);
	}

	/** Apply session-level stream hooks to a direct side request. */
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider = "anthropic"): SimpleStreamOptions {
		const sessionOnPayload = this.#onPayload;
		const sessionOnResponse = this.#onResponse;
		const sessionMetadata = this.agent.metadataForProvider(provider);
		const sessionOnSseEvent = this.#onSseEvent;
		if (!sessionOnPayload && !sessionOnResponse && !sessionMetadata && !sessionOnSseEvent) return options;

		const preparedOptions: SimpleStreamOptions = { ...options };

		// Stamp session metadata (e.g. user_id={session_id}) onto direct-call requests so
		// they share the same session bucket as Agent.prompt-routed requests on Anthropic
		// OAuth. Caller-provided metadata wins so explicit overrides are respected.
		if (sessionMetadata && !options.metadata) {
			preparedOptions.metadata = sessionMetadata;
		}

		if (sessionOnPayload) {
			if (!options.onPayload) {
				preparedOptions.onPayload = sessionOnPayload;
			} else {
				const requestOnPayload = options.onPayload;
				preparedOptions.onPayload = async (payload, model) => {
					const sessionPayload = await sessionOnPayload(payload, model);
					const sessionResolvedPayload = sessionPayload ?? payload;
					const requestPayload = await requestOnPayload(sessionResolvedPayload, model);
					return requestPayload ?? sessionResolvedPayload;
				};
			}
		}

		if (sessionOnResponse) {
			if (!options.onResponse) {
				preparedOptions.onResponse = sessionOnResponse;
			} else {
				const requestOnResponse = options.onResponse;
				preparedOptions.onResponse = async (response, model) => {
					await sessionOnResponse(response, model);
					await requestOnResponse(response, model);
				};
			}
		}

		if (sessionOnSseEvent) {
			if (!options.onSseEvent) {
				preparedOptions.onSseEvent = sessionOnSseEvent;
			} else {
				const requestOnSseEvent = options.onSseEvent;
				preparedOptions.onSseEvent = (event, model) => {
					sessionOnSseEvent(event, model);
					requestOnSseEvent(event, model);
				};
			}
		}

		return preparedOptions;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	/** Current interrupt mode */
	get interruptMode(): "immediate" | "wait" {
		return this.agent.getInterruptMode();
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.#providerSessionId ?? this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<ScopedModelSelection> {
		return this.#scopedModels;
	}

	/** Prompt templates */
	getPlanModeState(): PlanModeState | undefined {
		return this.#planModeState;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.#planModeState = state;
		if (state?.enabled) {
			this.#planReferenceSent = false;
			this.#planReferencePath = state.planFilePath;
		}
	}

	getGoalModeState(): GoalModeState | undefined {
		return this.#goalModeState;
	}

	setGoalModeState(state: GoalModeState | undefined): void {
		this.#goalModeState = state;
	}

	getWorkflowGateEmitter(): WorkflowGateEmitter | undefined {
		return this.#workflowGateEmitter;
	}

	getAskAnswerSource(): AskAnswerSource | undefined {
		return getAskAnswerSourceFromRegistry(this.sessionId);
	}

	setWorkflowGateEmitter(emitter: WorkflowGateEmitter | undefined): void {
		this.#workflowGateEmitter = emitter;
		if (emitter) {
			this.#ensureWorkflowGateAskTool();
		}
	}

	#ensureWorkflowGateAskTool(): void {
		if (this.#toolRegistry.has("ask")) return;
		if (!this.#workflowGateToolSession) return;

		const askTool = AskTool.createIf(this.#workflowGateToolSession);
		if (!askTool) return;

		const wrappedTool = wrapToolWithMetaNotice(askTool as unknown as AgentTool);
		const finalTool: AgentTool = this.#extensionRunner
			? new ExtensionToolWrapper(wrappedTool, this.#extensionRunner)
			: wrappedTool;
		this.#toolRegistry.set(finalTool.name, finalTool);

		if (!this.getActiveToolNames().includes(finalTool.name)) {
			const activeTools = [...this.agent.state.tools, finalTool];
			this.#setGuardedAgentTools(activeTools);
			this.#invalidateDiscoveryCaches();
			void this.refreshBaseSystemPrompt().catch(error => {
				logger.warn("Failed to refresh system prompt after workflow gate ask tool registration", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
	}

	get goalRuntime(): GoalRuntime {
		return this.#goalRuntime;
	}

	markPlanReferenceSent(): void {
		this.#planReferenceSent = true;
	}

	setPlanReferencePath(path: string): void {
		this.#planReferencePath = path;
	}

	get clientBridge(): ClientBridge | undefined {
		return this.#clientBridge;
	}

	setClientBridge(bridge: ClientBridge | undefined): void {
		this.#clientBridge = bridge;
		this.#acpPermissionDecisions.clear();
		const activeToolNames = this.getActiveToolNames();
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined);
		this.#setGuardedAgentTools(activeTools);
	}

	getCheckpointState(): CheckpointState | undefined {
		return this.#checkpointState;
	}

	setCheckpointState(state: CheckpointState | undefined): void {
		this.#checkpointState = state;
		if (!state) {
			this.#pendingRewindReport = undefined;
		}
	}

	/**
	 * Inject the plan mode context message into the conversation history.
	 */
	async sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = await this.#buildPlanModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	async sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = this.#buildGoalModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				attribution: message.attribution,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	async #activatePendingGjcGoalModeRequest(): Promise<boolean> {
		if (!this.settings.get("goal.enabled")) return false;
		const pendingGoal = await consumePendingGoalModeRequest(
			this.sessionManager.getCwd(),
			this.sessionManager.getSessionId(),
		);
		if (!pendingGoal) return false;
		const currentState = this.getGoalModeState();
		if (currentState?.goal && currentState.goal.status !== "complete" && currentState.goal.status !== "dropped") {
			return false;
		}

		const previousTools = this.getActiveToolNames();
		const goalTools = [...new Set([...previousTools, "goal"])];
		await this.#goalRuntime.createGoal({ objective: pendingGoal.objective });
		await this.setActiveToolsByName(goalTools);
		if (this.isStreaming) {
			await this.sendGoalModeContext({ deliverAs: "steer" });
		}
		return true;
	}

	resolveRoleModel(role: string): Model | undefined {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model).model;
	}

	/**
	 * Resolve a role to its model AND thinking level.
	 * Unlike resolveRoleModel(), this preserves the thinking level suffix
	 * from role configuration (e.g., "anthropic/Anthropic model-sonnet-4-5:xhigh").
	 */
	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model);
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#promptTemplates;
	}

	/** Replace file-based slash commands used for prompt expansion. */
	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	/** Custom commands (TypeScript slash commands and MCP prompts) */
	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		if (this.#mcpPromptCommands.length === 0) return this.#customCommands;
		return [...this.#customCommands, ...this.#mcpPromptCommands];
	}

	/** Update the MCP prompt commands list. Called when server prompts are (re)loaded. */
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#mcpPromptCommands = commands;
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Build a plan mode message.
	 * Returns null if plan mode is not enabled.
	 * @returns The plan mode message, or null if plan mode is not enabled.
	 */
	async #buildPlanReferenceMessage(): Promise<CustomMessage | null> {
		if (this.#planModeState?.enabled) return null;
		if (this.#planReferenceSent) return null;

		const planFilePath = this.#planReferencePath;
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, this.#localProtocolOptions());
		let planContent: string;
		try {
			planContent = await Bun.file(resolvedPlanPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}

		const content = prompt.render(planModeReferencePrompt, {
			planFilePath,
			planContent,
		});

		this.#planReferenceSent = true;

		return {
			role: "custom",
			customType: "plan-mode-reference",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	async #buildPlanModeMessage(): Promise<CustomMessage | null> {
		const state = this.#planModeState;
		if (!state?.enabled) return null;
		const sessionPlanUrl = "local://PLAN.md";
		const resolvedPlanPath = state.planFilePath.startsWith("local:")
			? resolveLocalUrlToPath(normalizeLocalScheme(state.planFilePath), this.#localProtocolOptions())
			: resolveToCwd(state.planFilePath, this.sessionManager.getCwd());
		const resolvedSessionPlan = resolveLocalUrlToPath(sessionPlanUrl, this.#localProtocolOptions());
		const displayPlanPath =
			state.planFilePath.startsWith("local:") || resolvedPlanPath !== resolvedSessionPlan
				? state.planFilePath
				: sessionPlanUrl;

		const planExists = fs.existsSync(resolvedPlanPath);
		const content = prompt.render(planModeActivePrompt, {
			planFilePath: displayPlanPath,
			planExists,
			askToolName: "ask",
			writeToolName: "write",
			editToolName: "edit",
			reentry: state.reentry ?? false,
			iterative: state.workflow === "iterative",
		});

		return {
			role: "custom",
			customType: "plan-mode-context",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildGoalModeMessage(): CustomMessage | null {
		const content = this.#goalRuntime.buildActivePrompt();
		if (!content) return null;
		return {
			role: "custom",
			customType: "goal-mode-context",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		// Handle extension commands first (execute immediately, even during streaming)
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this.#tryExecuteExtensionCommand(text);
			if (handled) {
				return;
			}

			// Try custom commands (TypeScript slash commands)
			const customResult = await this.#tryExecuteCustomCommand(text);
			if (customResult !== null) {
				if (customResult === "") {
					return;
				}
				text = customResult;
			}

			// Try file-based slash commands (markdown files from commands/ directories)
			// Only if text still starts with "/" (wasn't transformed by custom command)
			if (text.startsWith("/")) {
				text = expandSlashCommand(text, this.#slashCommands);
			}
		}

		// Expand file-based prompt templates if requested
		const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text;

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			if (options.streamingBehavior === "followUp") {
				await this.#queueFollowUp(expandedText, options?.images);
			} else {
				await this.#queueSteer(expandedText, options?.images);
			}
			return;
		}

		// Skip eager todo prelude when the user has already queued a directive
		const hasPendingUserDirective = this.#toolChoiceQueue.inspect().includes("user-force");
		const eagerTodoPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#createEagerTodoPrelude(expandedText) : undefined;

		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (options?.images) {
			userContent.push(...options.images);
		}

		const promptAttribution = options?.attribution ?? (options?.synthetic ? "agent" : "user");
		const message = options?.synthetic
			? { role: "developer" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() }
			: { role: "user" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() };
		await this.refreshGjcSubskillTools();

		if (eagerTodoPrelude?.toolChoice) {
			this.#toolChoiceQueue.pushOnce(eagerTodoPrelude.toolChoice, {
				label: "eager-todo",
			});
		}

		try {
			await this.#promptWithMessage(message, expandedText, {
				...options,
				prependMessages: eagerTodoPrelude ? [eagerTodoPrelude.message] : undefined,
			});
		} finally {
			// Clean up residual eager-todo directive if the prompt never consumed it
			// (e.g., compaction aborted, validation failed).
			this.#toolChoiceQueue.removeByLabel("eager-todo");
		}
		if (!options?.synthetic) {
			await this.#enforcePlanModeToolDecision();
		}
	}

	async #syncSkillPromptActiveState(
		message: Pick<CustomMessage<unknown>, "customType" | "details">,
		active: boolean,
	): Promise<void> {
		if (message.customType !== SKILL_PROMPT_MESSAGE_TYPE) return;
		const details = message.details;
		if (!details || typeof details !== "object") return;
		const name = (details as { name?: unknown }).name;
		if (typeof name !== "string" || !name.trim()) return;
		const skill = name.trim();
		const sessionId = this.sessionManager.getSessionId();
		// Canonical GJC workflow skills (deep-interview, ralplan, ultragoal, team)
		// own their `.gjc/state/skill-active-state.json` row through the
		// `gjc state handoff` and `gjc state clear` runtime verbs. The prompt
		// observer must not overwrite an existing row (that clobbered handoff
		// lineage `handoff_from`/`handoff_at` and desynced the HUD). But a fresh
		// `/skill:<name>` invocation has no row yet, so seed `.gjc/state`
		// idempotently here: `ensureWorkflowSkillActivationState` writes the
		// initial mode-state + active row only when the skill is not already
		// active, so the mutation guard and Stop hook engage immediately instead
		// of relying on the skill prompt to run its own state-init steps.
		if (active) {
			await ensureWorkflowSkillActivationState({ cwd: this.sessionManager.getCwd(), skill, sessionId });
			const subskillDetails = details as {
				subskillActivation?: LoadedSubskillActivation;
				subskillActivationSet?: LoadedSubskillActivation[];
			};
			const subskillActivations =
				subskillDetails.subskillActivationSet && subskillDetails.subskillActivationSet.length > 0
					? subskillDetails.subskillActivationSet
					: subskillDetails.subskillActivation
						? [subskillDetails.subskillActivation]
						: [];
			if (subskillActivations.length > 0) {
				const skillBoundActivation = subskillDetails.subskillActivation ?? subskillActivations[0];
				await syncSkillActiveState({
					cwd: this.sessionManager.getCwd(),
					skill,
					active: true,
					phase: skillBoundActivation?.phase,
					sessionId,
					active_subskills: subskillActivations.map(toActiveSubskillEntry),
				});
			}
		}
		// In-memory tracking keeps `getActiveSkillState` accurate for the chain guard.
		this.#activeSkillState = active ? { skill, sessionId } : undefined;
		if (active) {
			await this.refreshGjcSubskillTools();
		}
	}

	async #syncSkillPromptActiveStateSafely(
		message: Pick<CustomMessage<unknown>, "customType" | "details">,
		active: boolean,
	): Promise<void> {
		try {
			await this.#syncSkillPromptActiveState(message, active);
		} catch {
			// Skill HUD state is observational; a filesystem write failure must not
			// interrupt the prompt turn it is visualizing. The native Stop hook still
			// performs authoritative workflow blocking from persisted state.
		}
	}

	async promptCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice">,
	): Promise<void> {
		const textContent =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");

		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			await this.sendCustomMessage(message, { deliverAs: options.streamingBehavior });
			return;
		}

		const customMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};

		await this.#syncSkillPromptActiveStateSafely(customMessage, true);
		try {
			await this.#promptWithMessage(customMessage, textContent, options);
		} finally {
			await this.#syncSkillPromptActiveStateSafely(customMessage, false);
		}
	}

	async #promptWithMessage(
		message: AgentMessage,
		expandedText: string,
		options?: Pick<PromptOptions, "toolChoice" | "images" | "skipCompactionCheck"> & {
			prependMessages?: AgentMessage[];
			skipPostPromptRecoveryWait?: boolean;
		},
	): Promise<void> {
		this.#beginInFlight();
		const generation = this.#promptGeneration;
		try {
			// Flush any pending bash messages before the new prompt
			this.#flushPendingBashMessages();
			this.#flushPendingPythonMessages();
			this.#flushPendingBackgroundExchanges();

			// Reset todo reminder count on new user prompt
			this.#todoReminderCount = 0;

			await this.#maybeRestoreRetryFallbackPrimary();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelOnboardingError());
			}

			// Validate API key
			const apiKey = await this.#modelRegistry.getApiKey(this.model, this.sessionId);
			if (!apiKey) {
				throw new Error(formatNoCredentialOnboardingError(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses)
			const lastAssistant = this.#findLastAssistantMessage();
			if (lastAssistant && !options?.skipCompactionCheck) {
				await this.#checkCompaction(lastAssistant, false);
			}
			if (!options?.skipCompactionCheck) {
				await this.#checkEstimatedContextBeforePrompt([
					...(options?.prependMessages ?? []),
					message,
					...this.#pendingNextTurnMessages,
				]);
			}

			// Build messages array (session context, eager todo prelude, then active prompt message)
			const messages: AgentMessage[] = [];
			const planReferenceMessage = await this.#buildPlanReferenceMessage?.();
			if (planReferenceMessage) {
				messages.push(planReferenceMessage);
			}
			const planModeMessage = await this.#buildPlanModeMessage();
			if (planModeMessage) {
				messages.push(planModeMessage);
			}
			const goalModeMessage = this.#buildGoalModeMessage();
			if (goalModeMessage) {
				messages.push(goalModeMessage);
			}
			if (options?.prependMessages) {
				messages.push(...options.prependMessages);
			}

			messages.push(message);

			// Early bail-out: if a newer abort/prompt cycle started during setup,
			// return before mutating shared state (nextTurn messages, system prompt).
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this.#pendingNextTurnMessages) {
				messages.push(msg);
			}
			this.#pendingNextTurnMessages = [];

			// Auto-read @filepath mentions
			const fileMentions = extractFileMentions(expandedText);
			if (fileMentions.length > 0) {
				const fileMentionMessages = await generateFileMentionMessages(fileMentions, this.sessionManager.getCwd(), {
					autoResizeImages: this.settings.get("images.autoResize"),
					useHashLines: resolveFileDisplayMode(this).hashLines,
				});
				messages.push(...fileMentionMessages);
			}

			const beforeAgentStartSystemPrompt = await this.#buildSystemPromptForAgentStart(expandedText);

			const promptAttribution: "user" | "agent" | undefined =
				"attribution" in message ? message.attribution : undefined;

			// Emit before_agent_start extension event
			if (this.#extensionRunner) {
				const result = await this.#extensionRunner.emitBeforeAgentStart(
					expandedText,
					options?.images,
					beforeAgentStartSystemPrompt,
				);
				if (result?.messages) {
					this.#appendBeforeAgentStartCustomMessages(messages, result.messages, promptAttribution, message.role);
				}

				if (result?.systemPrompt !== undefined) {
					this.agent.setSystemPrompt(result.systemPrompt);
				} else {
					this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
				}
			} else {
				this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
			}

			// Invoke first-party internal before-agent-start contributors. These run
			// alongside the extension runner (not via user-loaded hooks) and append
			// through the same custom-message attribution path. Errors are nonfatal.
			if (this.#beforeAgentStartContributors.length > 0) {
				const contributed: BeforeAgentStartInternalMessage[] = [];
				for (const contributor of this.#beforeAgentStartContributors) {
					try {
						const msg = await contributor({
							prompt: expandedText,
							images: options?.images,
							sessionId: this.sessionId,
						});
						if (msg) contributed.push(msg);
					} catch (err) {
						logger.debug("before_agent_start contributor failed", { error: String(err) });
					}
				}
				this.#appendBeforeAgentStartCustomMessages(messages, contributed, promptAttribution, message.role);
			}

			// Bail out if a newer abort/prompt cycle has started since we began setup
			if (this.#promptGeneration !== generation) {
				return;
			}

			const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined;
			await this.#promptAgentWithIdleRetry(messages, agentPromptOptions);
			if (!options?.skipPostPromptRecoveryWait) {
				await this.#waitForPostPromptRecovery();
			}
		} finally {
			this.#endInFlight();
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	async #tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this.#extensionRunner) return false;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.#extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this.#extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this.#extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	#createCommandContext(): ExtensionCommandContext {
		if (this.#extensionRunner) {
			return this.#extensionRunner.createCommandContext();
		}

		return {
			ui: noOpUIContext,
			hasUI: false,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model ?? undefined,
			isIdle: () => !this.isStreaming,
			abort: () => {
				void this.abort();
			},
			hasPendingMessages: () => this.queuedMessageCount > 0,
			shutdown: () => {
				void this.dispose();
				process.exit(0);
			},
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			getContextUsage: () => this.getContextUsage(),
			waitForIdle: () => this.waitForIdle(),
			newSession: async options => {
				const success = await this.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}
				if (options?.setup) {
					await options.setup(this.sessionManager);
				}
				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.branch(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.navigateTree(targetId, { summarize: options?.summarize });
				return { cancelled: result.cancelled };
			},
			compact: async instructionsOrOptions => {
				const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
				const options =
					instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
				await this.compact(instructions, options);
			},
			switchSession: async sessionPath => {
				const success = await this.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await this.reload();
			},
			getSystemPrompt: () => this.systemPrompt,
		};
	}

	/**
	 * Try to execute a custom command. Returns the prompt string if found, null otherwise.
	 * If the command returns void, returns empty string to indicate it was handled.
	 */
	async #tryExecuteCustomCommand(text: string): Promise<string | null> {
		if (this.#customCommands.length === 0 && this.#mcpPromptCommands.length === 0) return null;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		// Find matching command
		const loaded =
			this.#customCommands.find(c => c.command.name === commandName) ??
			this.#mcpPromptCommands.find(c => c.command.name === commandName);
		if (!loaded) return null;

		// Get command context from extension runner (includes session control methods)
		const baseCtx = this.#createCommandContext();
		const ctx = {
			...baseCtx,
			hasQueuedMessages: baseCtx.hasPendingMessages,
		} as unknown as HookCommandContext;

		try {
			const args = parseCommandArgs(argsString);
			const result = await loaded.command.execute(args, ctx);
			// If result is a string, it's a prompt to send to LLM
			// If void/undefined, command handled everything
			return result ?? "";
		} catch (err) {
			// Emit error via extension runner
			if (this.#extensionRunner) {
				this.#extensionRunner.emitError({
					extensionPath: `custom-command:${commandName}`,
					event: "command",
					error: err instanceof Error ? err.message : String(err),
				});
			} else {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Custom command failed", { commandName, error: message });
			}
			return ""; // Command was handled (with error)
		}
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to process after the agent would otherwise stop.
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	async #queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		const displayText = text || (images && images.length > 0 ? "[Image]" : "");
		this.#steeringMessages.push({ text: displayText });
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			attribution: "user",
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	async #queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		const displayText = text || (images && images.length > 0 ? "[Image]" : "");
		this.#followUpMessages.push({ text: displayText });
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			attribution: "user",
			timestamp: Date.now(),
		});
		// When fully idle AND the session is in a resumable assistant-ended state,
		// schedule an immediate continue so the queued follow-up is delivered
		// without waiting for the next user turn. We gate on isStreaming (model
		// actively producing), isRetrying (auto-retry backoff is sleeping between
		// attempts, #retryPromise set), and the last message being assistant —
		// agent.continue() only dequeues follow-ups from an assistant-ended state;
		// resuming from user/toolResult state runs an extra model call on the
		// stale prompt before draining the queue.
		if (this.#canAutoContinueForFollowUp()) {
			this.#scheduleAgentContinue({
				shouldContinue: () => this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages(),
			});
		}
	}

	/**
	 * Gate for idle-path follow-up auto-continue. See `#queueFollowUp` for rationale.
	 */
	#canAutoContinueForFollowUp(): boolean {
		if (this.isStreaming) return false;
		if (this.isRetrying) return false;
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		return last?.role === "assistant";
	}

	queueDeferredMessage(message: CustomMessage): void {
		this.#queueHiddenNextTurnMessage(message, true);
	}

	queueDeferredMessageForTests(message: CustomMessage, triggerTurn = true): void {
		this.#queueHiddenNextTurnMessage(message, triggerTurn);
	}

	#queueHiddenNextTurnMessage(message: CustomMessage, triggerTurn: boolean): void {
		this.#pendingNextTurnMessages.push(message);
		if (!triggerTurn) return;
		const generation = this.#promptGeneration;
		if (this.#scheduledHiddenNextTurnGeneration === generation) {
			return;
		}
		this.#scheduledHiddenNextTurnGeneration = generation;
		this.#schedulePostPromptTask(
			async () => {
				if (this.#scheduledHiddenNextTurnGeneration === generation) {
					this.#scheduledHiddenNextTurnGeneration = undefined;
				}
				if (this.#pendingNextTurnMessages.length === 0) {
					return;
				}
				try {
					await this.#promptQueuedHiddenNextTurnMessages();
				} catch {
					// Leave the hidden next-turn messages queued for the next explicit prompt.
				}
			},
			{
				generation,
				onSkip: () => {
					if (this.#scheduledHiddenNextTurnGeneration === generation) {
						this.#scheduledHiddenNextTurnGeneration = undefined;
					}
				},
			},
		);
	}

	async #promptQueuedHiddenNextTurnMessages(): Promise<void> {
		if (this.#pendingNextTurnMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.#pendingNextTurnMessages];
		this.#pendingNextTurnMessages = [];
		const message = queuedMessages[queuedMessages.length - 1];
		if (!message) {
			return;
		}

		const prependMessages = queuedMessages.slice(0, -1);
		const textContent = this.#getCustomMessageTextContent(message);
		await this.#syncSkillPromptActiveStateSafely(message, true);
		try {
			await this.#promptWithMessage(message, textContent, {
				prependMessages,
				skipPostPromptRecoveryWait: true,
			});
		} catch (error) {
			this.#pendingNextTurnMessages = [...queuedMessages, ...this.#pendingNextTurnMessages];
			throw error;
		} finally {
			await this.#syncSkillPromptActiveStateSafely(message, false);
		}
	}

	#getCustomMessageTextContent(message: Pick<CustomMessage, "content">): string {
		if (typeof message.content === "string") {
			return message.content;
		}
		return message.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("");
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	#throwIfExtensionCommand(text: string): void {
		if (!this.#extensionRunner) return;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.#extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queue as steer/follow-up or store for next turn
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn unless the client cannot own it
	 * - Not streaming + no trigger: appends to state/session, no turn
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};
		if (this.isStreaming) {
			if (options?.deliverAs === "nextTurn") {
				this.#queueHiddenNextTurnMessage(appMessage, options?.triggerTurn ?? false);
				return;
			}

			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
			return;
		}

		if (options?.deliverAs === "nextTurn") {
			if (options?.triggerTurn) {
				if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
					this.#queueHiddenNextTurnMessage(appMessage, false);
					return;
				}
				await this.#syncSkillPromptActiveStateSafely(appMessage, true);
				try {
					await this.#promptWithMessage(appMessage, this.#getCustomMessageTextContent(appMessage), {
						skipPostPromptRecoveryWait: true,
					});
				} finally {
					await this.#syncSkillPromptActiveStateSafely(appMessage, false);
				}
				return;
			}
			this.agent.appendMessage(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
				message.attribution ?? "agent",
			);
			return;
		}

		if (options?.triggerTurn) {
			if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
				this.#queueHiddenNextTurnMessage(appMessage, false);
				return;
			}
			await this.#syncSkillPromptActiveStateSafely(appMessage, true);
			try {
				await this.#promptWithMessage(appMessage, this.#getCustomMessageTextContent(appMessage), {
					skipPostPromptRecoveryWait: true,
				});
			} finally {
				await this.#syncSkillPromptActiveStateSafely(appMessage, false);
			}
			return;
		}

		this.agent.appendMessage(appMessage);
		this.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
			message.attribution ?? "agent",
		);
	}

	/** Remove undelivered queued custom messages matching `predicate` from executable queues and tagged display mirrors. */
	purgeQueuedCustomMessages(predicate: (message: CustomMessage) => boolean): PurgeQueuedCustomMessagesResult {
		const isMatch = (m: AgentMessage): boolean => m.role === "custom" && predicate(m as CustomMessage);
		const removedTags = new Set<string>();
		for (const m of [...this.agent.snapshotSteering(), ...this.agent.snapshotFollowUp()]) {
			if (isMatch(m)) {
				const tag = readPendingDisplayTag((m as CustomMessage).details);
				if (tag) removedTags.add(tag);
			}
		}
		const agentRemoved = this.agent.removeQueuedMessages(isMatch);
		const beforeNext = this.#pendingNextTurnMessages.length;
		for (const m of this.#pendingNextTurnMessages) {
			if (predicate(m)) {
				const tag = readPendingDisplayTag(m.details);
				if (tag) removedTags.add(tag);
			}
		}
		this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(m => !predicate(m));
		const pendingNextTurn = beforeNext - this.#pendingNextTurnMessages.length;
		let displaySteering = 0;
		let displayFollowUp = 0;
		if (removedTags.size > 0) {
			const beforeS = this.#steeringMessages.length;
			this.#steeringMessages = this.#steeringMessages.filter(e => !(e.tag && removedTags.has(e.tag)));
			displaySteering = beforeS - this.#steeringMessages.length;
			const beforeF = this.#followUpMessages.length;
			this.#followUpMessages = this.#followUpMessages.filter(e => !(e.tag && removedTags.has(e.tag)));
			displayFollowUp = beforeF - this.#followUpMessages.length;
		}
		return {
			agentSteering: agentRemoved.steering,
			agentFollowUp: agentRemoved.followUp,
			pendingNextTurn,
			displaySteering,
			displayFollowUp,
			totalExecutable: agentRemoved.total + pendingNextTurn,
		};
	}

	/**
	 * Send a user message to the agent.
	 * When deliverAs is set, queue the message instead of starting a new turn.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		if (options?.deliverAs === "followUp") {
			await this.#queueFollowUp(text, images);
			return;
		}
		if (options?.deliverAs === "steer") {
			await this.#queueSteer(text, images);
			return;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			images,
		});
	}

	/**
	 * Clear queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = this.#steeringMessages.map(e => e.text);
		const followUp = this.#followUpMessages.map(e => e.text);
		this.#steeringMessages = [];
		this.#followUpMessages = [];
		this.agent.clearAllQueues();
		return { steering, followUp };
	}

	/** Number of pending messages (includes steering, follow-up, and next-turn messages) */
	get queuedMessageCount(): number {
		return this.#steeringMessages.length + this.#followUpMessages.length + this.#pendingNextTurnMessages.length;
	}

	/** Whether the agent has queued steering messages that a `user_interrupt`
	 *  abort would resume into (steer-on-interrupt). Drives the Esc-on-steer UX:
	 *  the first Esc consumes the steer and auto-continues, a second Esc aborts. */
	get hasQueuedSteering(): boolean {
		return this.agent.hasQueuedSteering();
	}

	/** Get pending messages (read-only). Returns the public text-only view;
	 *  internal `{text, tag?}` records are mapped to `.text` so callers
	 *  (`updatePendingMessagesDisplay`, `restoreQueuedMessagesToEditor`) see
	 *  the unchanged historical shape. */
	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return {
			steering: this.#steeringMessages.map(e => e.text),
			followUp: this.#followUpMessages.map(e => e.text),
		};
	}

	/**
	 * Pop the last queued message (steering first, then follow-up).
	 * Used by dequeue keybinding to restore messages to editor one at a time.
	 * Returns the popped entry's `.text`; the tag (if any) dies with the
	 * record — no orphan state can outlive the queue entry.
	 */
	popLastQueuedMessage(): string | undefined {
		// Pop from steering first (LIFO)
		if (this.#steeringMessages.length > 0) {
			const entry = this.#steeringMessages.pop();
			this.agent.popLastSteer();
			return entry?.text;
		}
		// Then from follow-up
		if (this.#followUpMessages.length > 0) {
			const entry = this.#followUpMessages.pop();
			this.agent.popLastFollowUp();
			return entry?.text;
		}
		return undefined;
	}

	get skillsSettings(): SkillsSettings | undefined {
		return this.#skillsSettings;
	}

	/** Skills loaded by SDK (always includes bundled GJC workflow defaults unless explicitly overridden by SDK callers) */
	get skills(): readonly Skill[] {
		return this.#skills;
	}

	/** Skill loading warnings captured by SDK */
	get skillWarnings(): readonly SkillWarning[] {
		return this.#skillWarnings;
	}

	getTodoPhases(): TodoPhase[] {
		return this.#cloneTodoPhases(this.#todoPhases);
	}

	setTodoPhases(phases: TodoPhase[]): void {
		this.#todoPhases = this.#cloneTodoPhases(phases);
	}

	#syncTodoPhasesFromBranch(): void {
		const phases = getLatestTodoPhasesFromEntries(this.sessionManager.getBranch());
		// Strip completed/abandoned tasks — they were done in a previous run,
		// so they have no bearing on progress tracking for the new turn.
		for (const phase of phases) {
			phase.tasks = phase.tasks.filter(t => t.status !== "completed" && t.status !== "abandoned");
		}
		this.setTodoPhases(phases.filter(p => p.tasks.length > 0));
	}

	#cloneTodoPhases(phases: TodoPhase[]): TodoPhase[] {
		return phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => {
				const out: TodoItem = { content: task.content, status: task.status };
				if (task.notes && task.notes.length > 0) out.notes = [...task.notes];
				return out;
			}),
		}));
	}

	// Auto-clear of completed/abandoned tasks was removed: the timer-driven
	// splice mutated canonical `#todoPhases` between tool calls, so the model
	// observed phase totals shrinking ("5 → 4") after marking tasks done. The
	// `tasks.todoClearDelay` setting is now inert; completed tasks survive
	// until the next explicit `todo_write` call removes them via `rm`/`drop`.

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(options?: {
		goalReason?: "interrupted" | "internal";
		timeoutMs?: number;
		cause?:
			| "user_interrupt"
			| "new_session"
			| "session_switch"
			| "compaction"
			| "handoff"
			| "tool_abort"
			| "internal";
		/** Suppress the "Operation aborted" line on the resulting aborted message
		 *  by stamping `SILENT_ABORT_MARKER`. Used when Esc consumes a queued steer
		 *  and resumes via steer-on-interrupt, so the interrupt reads as a quiet
		 *  hand-off rather than a failure. */
		silent?: boolean;
	}): Promise<void> {
		if (options?.silent) {
			this.#silentAbortPending = true;
		} else {
			this.#silentAbortPending = false;
		}
		this.abortRetry();
		this.#promptGeneration++;
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.abortCompaction();
		this.abortHandoff();
		this.abortBash();
		this.abortEval();
		const postPromptDrain = this.#cancelPostPromptTasks();
		this.agent.abort();
		const cleanup = Promise.all([postPromptDrain, this.agent.waitForIdle()]).then(
			() => ({ type: "settled" as const }),
			(error: unknown) => ({ type: "error" as const, error }),
		);
		cleanup.catch(() => {});
		const timeoutMs = options?.timeoutMs;
		if (timeoutMs !== undefined && timeoutMs > 0) {
			const outcome = await Promise.race([cleanup, Bun.sleep(timeoutMs).then(() => ({ type: "timeout" as const }))]);
			if (outcome.type === "timeout") {
				this.#abandonPostPromptTasks();
				this.agent.forceAbort("Abort cleanup timed out");
				this.emitNotice(
					"warning",
					"Abort cleanup timed out; forced session recovery. The previous provider stream or tool may still be unwinding in the background.",
					"abort",
				);
			} else if (outcome.type === "error") {
				throw outcome.error;
			}
		} else {
			const outcome = await cleanup;
			if (outcome.type === "error") {
				throw outcome.error;
			}
		}
		await this.#goalRuntime.onTaskAborted({ reason: options?.goalReason ?? "interrupted" });
		// Clear prompt-in-flight state: waitForIdle resolves when the agent loop's finally
		// block runs, but nested prompt setup/finalizers may still be unwinding. Without this,
		// a subsequent prompt() can incorrectly observe the session as busy after an abort.
		this.#resetInFlight();
		// Safety net: clear the silent-abort flag if it was never consumed (the
		// abort produced no aborted assistant message_end to stamp). Prevents the
		// marker from leaking onto a later, unrelated abort.
		this.#silentAbortPending = false;
		// Safety net: if the agent loop aborted without producing an assistant
		// message (e.g. failed before the first stream), the in-flight yield was
		// never resolved or rejected by the normal message_end path. Reject it now
		// so any requeue callback still fires and the queue stays consistent.
		if (this.#toolChoiceQueue.hasInFlight) {
			this.#toolChoiceQueue.reject("aborted");
		}

		// Steer-on-interrupt: after a genuine user interrupt, resume with any
		// queued steering instead of going idle. Lifecycle/teardown causes
		// (default "internal") suppress this; new-session/handoff additionally
		// clear the steering queue, and compaction resumes via its own path.
		if ((options?.cause ?? "internal") === "user_interrupt" && this.agent.hasQueuedSteering()) {
			this.#scheduleAgentContinue({
				delayMs: 1,
				generation: this.#promptGeneration,
				shouldContinue: () => this.agent.hasQueuedSteering(),
			});
		}
	}

	/**
	 * Start a new session, optionally with initial messages and parent tracking.
	 * Clears all messages and starts a new session.
	 * Listeners are preserved and will continue receiving events.
	 * @param options - Optional initial messages and parent session path
	 * @returns true if completed, false if cancelled by hook
	 */
	async newSession(options?: NewSessionOptions): Promise<boolean> {
		const previousSessionFile = this.sessionFile;
		const nextDiscoverySessionToolNames = this.#mcpDiscoveryEnabled
			? [
					...this.#getActiveNonMCPToolNames(),
					...this.#filterSelectableMCPToolNames(this.#defaultSelectedMCPToolNames),
				]
			: undefined;

		// Emit session_before_switch event with reason "new" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort();
		this.#cancelOwnAsyncJobs();
		this.#closeAllProviderSessions("new session");
		this.agent.reset();
		if (options?.drop && previousSessionFile) {
			try {
				await this.sessionManager.dropSession(previousSessionFile);
			} catch (err) {
				logger.error("Failed to delete session during /drop", { err });
			}
		} else {
			await this.sessionManager.flush();
		}
		await this.sessionManager.newSession(options);
		this.setTodoPhases([]);
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#resetHindsightConversationTrackingIfHindsight();
		this.#steeringMessages = [];
		this.#followUpMessages = [];
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		this.sessionManager.appendThinkingLevelChange(this.thinkingLevel);
		if (this.model) {
			this.sessionManager.appendModelChange(`${this.model.provider}/${this.model.id}`);
		}
		this.sessionManager.appendServiceTierChange(this.serviceTier ?? null);
		if (nextDiscoverySessionToolNames) {
			await this.#applyActiveToolsByName(nextDiscoverySessionToolNames, { persistMCPSelection: false });
			if (this.getSelectedMCPToolNames().length > 0) {
				this.sessionManager.appendMCPToolSelection(this.getSelectedMCPToolNames());
			}
		}
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionFile,
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);

		this.#todoReminderCount = 0;
		this.#planReferenceSent = false;
		this.#planReferencePath = "local://PLAN.md";
		this.#reconnectToAgent();

		// Emit session_switch event with reason "new" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		return true;
	}

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string, source: "auto" | "user" = "auto"): Promise<boolean> {
		return this.sessionManager.setSessionName(name, source);
	}

	/**
	 * Fork the current session, creating a new session file with the exact same state.
	 * Copies all entries and artifacts to the new session.
	 * Unlike newSession(), this preserves all messages in the agent state.
	 * @returns true if completed, false if cancelled by hook or not persisting
	 */
	async fork(): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "fork" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "fork",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		// Flush current session to ensure all entries are written
		await this.sessionManager.flush();

		// Fork the session (creates new session file with same entries)
		const forkResult = await this.sessionManager.fork();
		if (!forkResult) {
			return false;
		}

		// Copy artifacts directory if it exists
		const oldArtifactDir = forkResult.oldSessionFile.slice(0, -6);
		const newArtifactDir = forkResult.newSessionFile.slice(0, -6);

		try {
			const oldDirStat = await fs.promises.stat(oldArtifactDir);
			if (oldDirStat.isDirectory()) {
				await fs.promises.cp(oldArtifactDir, newArtifactDir, { recursive: true });
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to copy artifacts during fork", {
					oldArtifactDir,
					newArtifactDir,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Update agent session ID
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();

		// Emit session_switch event with reason "fork" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "fork",
				previousSessionFile,
			});
		}

		return true;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * Set model directly.
	 * Validates API key, saves to session and settings.
	 * @throws Error if no API key available for the model
	 */
	async setModel(
		model: Model,
		role: string = "default",
		options?: { selector?: string; thinkingLevel?: ThinkingLevel },
	): Promise<void> {
		const previousEditMode = this.#resolveActiveEditMode();
		const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(model);
		this.sessionManager.appendModelChange(`${model.provider}/${model.id}`, role);
		this.settings.setModelRole(
			role,
			this.#formatRoleModelValue(role, model, options?.selector, options?.thinkingLevel),
		);
		this.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);

		// Apply the explicitly selected thinking level when the selector supplies one;
		// otherwise prefer the model's configured defaultLevel, then preserve the current level.
		this.setThinkingLevel(options?.thinkingLevel ?? model.thinking?.defaultLevel ?? this.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);
	}

	setActiveModelProfile(name: string | undefined): void {
		this.#activeModelProfile = name;
	}

	getActiveModelProfile(): string | undefined {
		return this.#activeModelProfile;
	}

	/**
	 * The model selector ("provider/id") that resume restores as the session
	 * default — the latest session-log `model_change` with role="default".
	 * Model-profile activation snapshots this before mutating the session so a
	 * failed-activation rollback can restore the pre-activation resume default
	 * instead of promoting a transient runtime model to the resume default.
	 */
	getSessionDefaultModelSelector(): string | undefined {
		return this.sessionManager.buildSessionContext().models.default;
	}

	/**
	 * Re-assert the session resume default ("provider/id") in the session log
	 * WITHOUT touching the live runtime model. Appends a `model_change` with
	 * role="default"; never writes to global settings (apply-for-this-session
	 * semantics). Used by model-profile activation rollback to neutralize the
	 * profile main model the failed activation already recorded as the default.
	 */
	recordResumeDefaultModel(selector: string): void {
		this.sessionManager.appendModelChange(selector, "default");
	}

	/**
	 * Set model temporarily (for this session only).
	 * Validates API key, saves to session log but NOT to settings.
	 *
	 * The change is recorded in the session log as `role: "temporary"` by
	 * default, which means it is NOT restored as the session default on resume —
	 * transient retry/fallback/context-promotion/plan switches must not clobber
	 * the user's explicit pick (issue #849). Model-profile activation passes
	 * `persistAsSessionDefault: true` so the profile's main model becomes the
	 * session default and survives resume, while still not being written to
	 * global settings (new sessions keep the global default).
	 * @throws Error if no API key available for the model
	 */
	async setModelTemporary(
		model: Model,
		thinkingLevel?: ThinkingLevel,
		options?: { persistAsSessionDefault?: boolean },
	): Promise<void> {
		const previousEditMode = this.#resolveActiveEditMode();
		const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(model);
		this.sessionManager.appendModelChange(
			`${model.provider}/${model.id}`,
			options?.persistAsSessionDefault ? "default" : "temporary",
		);
		this.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);

		// Apply explicit thinking level if given; otherwise prefer the model's
		// configured defaultLevel; otherwise re-clamp the current level.
		this.setThinkingLevel(thinkingLevel ?? model.thinking?.defaultLevel ?? this.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.#scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	/**
	 * Cycle through configured role models in a fixed order.
	 * Skips missing roles.
	 * @param roleOrder - Order of roles to cycle through (e.g., ["default"])
	 * @param options - Optional settings: `temporary` to not persist to settings
	 */
	async cycleRoleModels(
		roleOrder: readonly string[],
		options?: { temporary?: boolean },
	): Promise<RoleModelCycleResult | undefined> {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const currentModel = this.model;
		if (!currentModel) return undefined;
		const matchPreferences = { usageOrder: this.settings.getStorage()?.getModelUsageOrder() };
		const roleModels: Array<{
			role: string;
			model: Model;
			thinkingLevel?: ThinkingLevel;
			explicitThinkingLevel: boolean;
		}> = [];

		for (const role of roleOrder) {
			const roleModelStr =
				role === "default"
					? (this.settings.getModelRole("default") ?? `${currentModel.provider}/${currentModel.id}`)
					: this.settings.getModelRole(role);
			if (!roleModelStr) continue;

			const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
				settings: this.settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
			});
			if (!resolved.model) continue;

			roleModels.push({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
			});
		}

		if (roleModels.length <= 1) return undefined;

		const lastRole = this.sessionManager.getLastModelChangeRole();
		let currentIndex = lastRole ? roleModels.findIndex(entry => entry.role === lastRole) : -1;
		if (currentIndex === -1) {
			currentIndex = roleModels.findIndex(entry => modelsAreEqual(entry.model, currentModel));
		}
		if (currentIndex === -1) currentIndex = 0;

		const nextIndex = (currentIndex + 1) % roleModels.length;
		const next = roleModels[nextIndex];

		if (options?.temporary) {
			await this.setModelTemporary(next.model, next.explicitThinkingLevel ? next.thinkingLevel : undefined);
		} else {
			await this.setModel(next.model, next.role);
			if (next.explicitThinkingLevel && next.thinkingLevel !== undefined) {
				this.setThinkingLevel(next.thinkingLevel);
			}
		}

		return { model: next.model, thinkingLevel: this.thinkingLevel, role: next.role };
	}

	async #getScopedModelsWithApiKey(): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> = [];

		for (const scoped of this.#scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#modelRegistry.getApiKeyForProvider(provider, this.sessionId);
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// Apply model
		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(next.model);
		this.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		this.settings.setModelRole("default", this.#formatRoleModelValue("default", next.model));
		this.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		// Apply the scoped model's configured thinking level
		this.setThinkingLevel(next.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#modelRegistry.getApiKey(nextModel, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(nextModel);
		this.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`);
		this.settings.setModelRole("default", this.#formatRoleModelValue("default", nextModel));
		this.settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);
		// Re-apply the current thinking level for the newly selected model
		this.setThinkingLevel(this.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	/**
	 * Get all available models with valid API keys.
	 */
	getAvailableModels(): Model[] {
		return this.#modelRegistry.getAvailable();
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Saves the effective metadata-clamped level to session and settings only if it changes.
	 */
	setThinkingLevel(level: ThinkingLevel | undefined, persist: boolean = false): void {
		const effectiveLevel = resolveThinkingLevelForModel(this.model, level);
		const isChanging = effectiveLevel !== this.#thinkingLevel;

		this.#thinkingLevel = effectiveLevel;
		this.agent.setThinkingLevel(toReasoningEffort(effectiveLevel));

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
				this.settings.set("defaultThinkingLevel", effectiveLevel);
			}
			this.#emit({ type: "thinking_level_changed", thinkingLevel: effectiveLevel });
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.model?.reasoning) return undefined;

		const levels = [ThinkingLevel.Off, ...this.getAvailableThinkingLevels()];
		const currentLevel = this.thinkingLevel === ThinkingLevel.Inherit ? ThinkingLevel.Off : this.thinkingLevel;
		const currentIndex = currentLevel ? levels.indexOf(currentLevel) : -1;
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (!nextLevel) return undefined;

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * True when *any* fast-mode-granting service tier is configured, regardless
	 * of whether the active model's provider actually realizes it. Used by the
	 * toggle (`/fast on|off`) so re-toggling a scoped tier (`openai-only`,
	 * `Anthropic model-only`) doesn't silently broaden it to unscoped `priority`.
	 *
	 * For "is fast mode actually applied to the next request?" use
	 * {@link isFastModeActive} instead — that one respects the model's provider.
	 */
	isFastModeEnabled(): boolean {
		return (
			this.serviceTier === "priority" || this.serviceTier === "claude-only" || this.serviceTier === "openai-only"
		);
	}

	/**
	 * True when the configured `serviceTier` resolves to `"priority"` for the
	 * given model `provider`. Returns false for scoped tiers that don't match
	 * (e.g. `"openai-only"` on an anthropic provider) and when `provider` is
	 * undefined. This is the canonical provider-aware fast-mode predicate.
	 */
	isFastForProvider(provider?: string): boolean {
		// Fast mode applies to a concrete model's provider. With no provider
		// (no model selected) it cannot apply, even under an unscoped `priority`
		// tier that `resolveServiceTier` would otherwise pass through.
		if (provider === undefined) return false;
		return resolveServiceTier(this.serviceTier, provider) === "priority";
	}

	/**
	 * Effective service tier applied to task-tool subagent sessions
	 * (executor/architect/planner/critic). They run under `task.serviceTier`
	 * unless it is `"inherit"`, in which case they inherit the main session
	 * tier — mirroring `createSubagentSettings`.
	 */
	#subagentServiceTier(): ServiceTier | undefined {
		const configured = this.settings.get("task.serviceTier");
		if (configured === "inherit") return this.serviceTier;
		if (configured === "none") return undefined;
		return configured;
	}

	/**
	 * Provider-aware fast-mode predicate for task-tool subagent roles, evaluated
	 * against the effective subagent tier (`task.serviceTier`) rather than the
	 * main session tier. Use this for `task.agentModelOverrides` role rows so the
	 * ⚡ glyph reflects the tier the subagent actually runs under.
	 */
	isFastForSubagentProvider(provider?: string): boolean {
		if (provider === undefined) return false;
		return resolveServiceTier(this.#subagentServiceTier(), provider) === "priority";
	}

	/**
	 * True when the configured `serviceTier` resolves to `"priority"` for the
	 * *currently selected model's provider*. Returns false for scoped tiers
	 * that don't match (e.g. `"openai-only"` on an anthropic model) and when
	 * no model is selected.
	 */
	isFastModeActive(): boolean {
		return this.isFastForProvider(this.model?.provider);
	}

	setServiceTier(serviceTier: ServiceTier | undefined): void {
		if (this.serviceTier === serviceTier) return;
		// Re-arming priority on Anthropic? Clear the per-session auto-fallback
		// sticky disable so the next request actually carries `speed: "fast"`
		// again. Without this, `/fast on` (or user switching to a tier that
		// grants anthropic priority) after an auto-disable is a silent no-op
		// and the warning notice fires every turn.
		if (serviceTier === "priority" || serviceTier === "claude-only") {
			clearAnthropicFastModeFallback(this.#providerSessionState);
		}
		this.agent.serviceTier = serviceTier;
		this.sessionManager.appendServiceTierChange(serviceTier ?? null);
	}

	setFastMode(enabled: boolean): void {
		if (enabled && this.isFastModeEnabled()) {
			// Already on under any scope — keep the user's scoped value.
			return;
		}
		this.setServiceTier(enabled ? "priority" : undefined);
	}

	toggleFastMode(): boolean {
		const enabled = !this.isFastModeEnabled();
		this.setFastMode(enabled);
		return enabled;
	}

	/**
	 * Get available thinking levels for current model.
	 */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		if (!this.model) return [];
		return getSupportedEfforts(this.model);
	}

	// =========================================================================
	// Message Queue Mode Management
	// =========================================================================

	/**
	 * Set steering mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settings.set("steeringMode", mode);
	}

	/**
	 * Set follow-up mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settings.set("followUpMode", mode);
	}

	/**
	 * Set interrupt mode.
	 * Saves to settings.
	 */
	setInterruptMode(mode: "immediate" | "wait"): void {
		this.agent.setInterruptMode(mode);
		this.settings.set("interruptMode", mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	async #pruneToolOutputs(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const branchEntries = this.sessionManager.getBranch();
		const result = pruneToolOutputs(branchEntries, DEFAULT_PRUNE_CONFIG);
		if (result.prunedCount === 0) {
			return undefined;
		}

		// getBranch() returns materialized copies for blob-externalized entries, so
		// the pruning mutations must be written back into the canonical store.
		this.sessionManager.applyEntryMessageUpdates(result.prunedEntries);
		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return result;
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 * @param options Optional callbacks for completion/error handling
	 */
	async compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
		if (this.#compactionAbortController) {
			throw new Error("Compaction already in progress");
		}
		this.#disconnectFromAgent();
		await this.abort();
		const compactionAbortController = new AbortController();
		this.#compactionAbortController = compactionAbortController;

		try {
			if (!this.model) {
				throw new Error("No model selected");
			}

			const compactionSettings = this.settings.getGroup("compaction");
			const pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, compactionSettings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
				const result = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new CompactionCancelledError();
				}

				if (result?.compaction) {
					hookCompaction = result.compaction;
					fromExtension = true;
				}
			}

			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction);

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else {
				// Generate compaction result. Only convert known abort-shaped
				// rejections (AbortError raised while the abort signal is set,
				// or an already-typed sentinel) into `CompactionCancelledError`
				// so downstream callers can discriminate cancel from generic
				// failure via `instanceof` without inspecting message strings.
				// Real compaction bugs (network, server, parsing, etc.) keep
				// their original shape — they must not be silently relabeled
				// as cancellations even if the signal happens to be aborted
				// for an unrelated reason. Assignments live inside the try
				// block because every catch path throws — the post-try reads
				// of the result-derived locals are reachable only on success.
				try {
					const result = await this.#compactWithFallbackModel(
						preparation,
						customInstructions,
						compactionAbortController.signal,
						{
							promptOverride: compactionPrep.hookPrompt,
							extraContext: compactionPrep.hookContext,
							remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
							convertToLlm,
						},
					);
					summary = result.summary;
					shortSummary = result.shortSummary;
					firstKeptEntryId = result.firstKeptEntryId;
					tokensBefore = result.tokensBefore;
					details = result.details;
					preserveData = { ...(compactionPrep.preserveData ?? {}), ...(result.preserveData ?? {}) };
				} catch (err) {
					if (err instanceof CompactionCancelledError) {
						throw err;
					}
					if (compactionAbortController.signal.aborted && err instanceof Error && err.name === "AbortError") {
						throw new CompactionCancelledError();
					}
					throw err;
				}
			}

			if (compactionAbortController.signal.aborted) {
				throw new CompactionCancelledError();
			}

			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();
			this.#closeCodexProviderSessionsForHistoryRewrite();

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			options?.onComplete?.(compactionResult);
			return compactionResult;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			options?.onError?.(err);
			throw error;
		} finally {
			if (this.#compactionAbortController === compactionAbortController) {
				this.#compactionAbortController = undefined;
			}
			this.#reconnectToAgent();
		}
	}

	/**
	 * Ask the active memory backend for an extra-context block to splice into
	 * the compaction summary prompt. Both the manual and auto compaction paths
	 * funnel through this helper so the behaviour stays identical.
	 *
	 * Failures are swallowed: a memory backend going sideways MUST NOT block
	 * compaction (which is itself the recovery path for context overflow).
	 */
	async #collectMemoryBackendContext(preparation: {
		messagesToSummarize: AgentMessage[];
		turnPrefixMessages: AgentMessage[];
	}): Promise<string | undefined> {
		const backend = resolveMemoryBackend(this.settings);
		if (!backend.preCompactionContext) return undefined;
		const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
		try {
			return await backend.preCompactionContext(messages, this.settings, this);
		} catch (err) {
			logger.debug("Memory backend preCompactionContext failed", {
				backend: backend.id,
				error: String(err),
			});
			return undefined;
		}
	}

	/**
	 * Cancel in-progress context maintenance (manual compaction, auto-compaction, or auto-handoff).
	 */
	abortCompaction(): void {
		this.#compactionAbortController?.abort();
		this.#autoCompactionAbortController?.abort();
		this.#handoffAbortController?.abort();
	}

	/** Trigger idle compaction through the auto-compaction flow (with UI events). */
	async runIdleCompaction(): Promise<void> {
		if (this.isStreaming || this.isCompacting) return;
		await this.#runAutoCompaction("idle", false, true);
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this.#branchSummaryAbortController?.abort();
	}

	/**
	 * Cancel in-progress handoff generation.
	 */
	abortHandoff(): void {
		this.#handoffAbortController?.abort();
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#handoffAbortController !== undefined;
	}

	/**
	 * Generate a handoff document with a oneshot LLM call, then start a new session with it.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @param options Handoff execution options
	 * @returns The handoff document text, or undefined if cancelled/failed
	 */
	async handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
		const entries = this.sessionManager.getBranch();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			throw new Error("Nothing to hand off (no messages yet)");
		}

		this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;

		this.#handoffAbortController = new AbortController();
		const handoffAbortController = this.#handoffAbortController;
		const handoffSignal = handoffAbortController.signal;
		const sourceSignal = options?.signal;
		const onSourceAbort = () => {
			if (!handoffSignal.aborted) {
				handoffAbortController.abort();
			}
		};
		if (sourceSignal) {
			sourceSignal.addEventListener("abort", onSourceAbort, { once: true });
			if (sourceSignal.aborted) {
				onSourceAbort();
			}
		}

		try {
			if (handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}

			const model = this.model;
			if (!model) {
				throw new Error("No model selected for handoff");
			}
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}

			const handoffText = await generateHandoff(
				this.agent.state.messages,
				model,
				apiKey,
				{
					...this.#maintenanceProviderTransport(),
					systemPrompt: this.#baseSystemPrompt,
					tools: this.agent.state.tools,
					customInstructions,
					convertToLlm,
					initiatorOverride: "agent",
					metadata: this.agent.metadataForProvider(model.provider),
					telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),
				},
				handoffSignal,
			);

			if (handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}
			if (!handoffText) {
				return undefined;
			}

			// Start a new session
			const previousSessionFile = this.sessionFile;
			await this.sessionManager.flush();
			this.#cancelOwnAsyncJobs();
			await this.sessionManager.newSession(previousSessionFile ? { parentSession: previousSessionFile } : undefined);
			this.agent.reset();
			this.#syncAgentSessionId();
			this.#rekeyHindsightMemoryForCurrentSessionId();
			this.#resetHindsightConversationTrackingIfHindsight();
			this.#steeringMessages = [];
			this.#followUpMessages = [];
			this.#pendingNextTurnMessages = [];
			this.#scheduledHiddenNextTurnGeneration = undefined;
			this.#todoReminderCount = 0;
			if (model) {
				this.sessionManager.appendModelChange(`${model.provider}/${model.id}`);
			}
			this.sessionManager.appendThinkingLevelChange(this.thinkingLevel);
			this.sessionManager.appendServiceTierChange(this.serviceTier ?? null);

			// Inject the handoff document as a custom message
			const handoffContent = createHandoffContext(handoffText);
			this.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true, undefined, "agent");
			await this.sessionManager.ensureOnDisk();
			let savedPath: string | undefined;
			if (options?.autoTriggered && this.settings.get("compaction.handoffSaveToDisk")) {
				const artifactsDir = this.sessionManager.getArtifactsDir();
				if (artifactsDir) {
					const handoffFilePath = path.join(artifactsDir, createHandoffFileName());
					try {
						if (isUnderProjectGjc(this.sessionManager.getCwd(), handoffFilePath)) {
							await writeArtifact(handoffFilePath, `${handoffText}\n`, {
								cwd: this.sessionManager.getCwd(),
								audit: { category: "artifact", verb: "write", owner: "gjc-runtime" },
							});
						} else {
							await Bun.write(handoffFilePath, `${handoffText}\n`);
						}
						savedPath = handoffFilePath;
					} catch (error) {
						logger.warn("Failed to save handoff document to disk", {
							path: handoffFilePath,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				} else {
					logger.debug("Skipping handoff document save because session is not persisted");
				}
			}

			// Rebuild agent messages from session
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();

			return { document: handoffText, savedPath };
		} catch (error) {
			if (handoffSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
				throw new Error("Handoff cancelled");
			}
			throw error;
		} finally {
			sourceSignal?.removeEventListener("abort", onSourceAbort);
			this.#handoffAbortController = undefined;
		}
	}

	async prepareContributionPrep(options: ContributionPrepOptions = {}): Promise<ContributionPrepResult> {
		return prepareContributionPrep(
			{
				sessionId: this.sessionId,
				cwd: this.sessionManager.getCwd(),
				sessionFile: this.sessionFile,
				messages: this.agent.state.messages,
				customInstructions: options.customInstructions,
			},
			options,
		);
	}

	/**
	 * Check if context maintenance or promotion is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Three cases (in order):
	 * 1. Overflow + promotion: promote to larger model, retry without maintenance
	 * 2. Overflow + no promotion target: run context maintenance, auto-retry on same model
	 * 3. Threshold: Context over threshold, run context maintenance (no auto-retry)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	async #checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;
		const contextWindow = this.model?.contextWindow ?? 0;
		const generation = this.#promptGeneration;
		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. OpenAI code backend) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;
		// This handles the case where an error was kept after compaction (in the "kept" region).
		// The error shouldn't trigger another compaction since we already compacted.
		// Example: opus fails -> switch to OpenAI code backend -> compact -> switch back to opus -> opus error
		// is still in context but shouldn't trigger compaction again.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const errorIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp < new Date(compactionEntry.timestamp).getTime();
		if (sameModel && !errorIsFromBeforeCompaction && isContextOverflow(assistantMessage, contextWindow)) {
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.replaceMessages(messages.slice(0, -1));
			}

			// Try context promotion first - switch to a larger model and retry without compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				// Retry on the promoted (larger) model without compacting
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return;
			}

			// No promotion target available fall through to compaction
			const compactionSettings = this.settings.getGroup("compaction");
			if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
				await this.#runAutoCompaction("overflow", true);
			}
			return;
		}
		const compactionSettings = this.settings.getGroup("compaction");
		if (!compactionSettings.enabled || compactionSettings.strategy === "off") return;

		// Case 2: Threshold - turn succeeded but context is getting large
		// Skip if this was an error (non-overflow errors don't have usage data)
		if (assistantMessage.stopReason === "error") return;
		let contextTokens = calculateContextTokens(assistantMessage.usage);
		const maxOutputTokens = this.model?.maxTokens ?? 0;
		// Cache-epoch invariant: pruning rewrites already-sent toolResult history,
		// which breaks the provider prompt-cache prefix mid-epoch. Only prune at a
		// sanctioned maintenance boundary, i.e. when the un-pruned context already
		// crosses the compaction threshold. Pruning may then avert full compaction.
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings, maxOutputTokens)) return;
		const pruneResult = await this.#pruneToolOutputs();
		if (pruneResult) {
			contextTokens = Math.max(0, contextTokens - pruneResult.tokensSaved);
		}
		if (shouldCompact(contextTokens, contextWindow, compactionSettings, maxOutputTokens)) {
			// Try promotion first — if a larger model is available, switch instead of compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (!promoted) {
				await this.#runAutoCompaction("threshold", false);
			}
		}
	}

	async #checkEstimatedContextBeforePrompt(pendingMessages: readonly AgentMessage[] = []): Promise<void> {
		if (this.#prePromptContextCheckPromise) {
			await this.#prePromptContextCheckPromise;
		}

		const checkPromise = this.#checkEstimatedContextBeforePromptOnce(pendingMessages);
		this.#prePromptContextCheckPromise = checkPromise;
		try {
			await checkPromise;
		} finally {
			if (this.#prePromptContextCheckPromise === checkPromise) {
				this.#prePromptContextCheckPromise = undefined;
			}
		}
	}

	/** Test seam: override the emergency-compaction resource sampler so tests never read real RSS. */
	setResourceSampler(sampler: () => EmergencyCompactionSample): void {
		this.#resourceSampler = sampler;
	}

	#defaultResourceSample(): EmergencyCompactionSample {
		let providerBytes = 0;
		let imageBytes = 0;
		for (const message of this.state.messages) {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") {
				providerBytes += content.length;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (!block || typeof block !== "object") continue;
					const typed = block as { text?: unknown; data?: unknown };
					if (typeof typed.text === "string") providerBytes += typed.text.length;
					if (typeof typed.data === "string") {
						imageBytes += typed.data.length;
						providerBytes += typed.data.length;
					}
				}
			}
		}
		return {
			heapUsedBytes: process.memoryUsage().heapUsed,
			providerBytes,
			messageCount: this.state.messages.length,
			imageBytes,
		};
	}

	async #checkEstimatedContextBeforePromptOnce(pendingMessages: readonly AgentMessage[]): Promise<void> {
		const model = this.model;
		if (!model) return;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return;
		// F6: non-disableable emergency floor — compact before OOM even when token-based
		// compaction is disabled or its threshold is set too high (weak-hardware protection).
		const emergencyReason = emergencyCompactionReason(this.#resourceSampler());
		if (emergencyReason) {
			logger.warn("Emergency compaction triggered (resource floor exceeded)", { reason: emergencyReason });
			await this.#runAutoCompaction("overflow", false, false, {
				continueAfterMaintenance: false,
				deferHandoffMaintenance: false,
				force: true,
			});
			return;
		}
		const compactionSettings = this.settings.getGroup("compaction");
		if (!compactionSettings.enabled || compactionSettings.strategy === "off") return;

		let contextTokens = this.#estimateContextTokensForCompaction(pendingMessages).tokens;
		const maxOutputTokens = model.maxTokens ?? 0;
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings, maxOutputTokens)) return;

		const pruneResult = await this.#pruneToolOutputs();
		if (pruneResult) {
			contextTokens = Math.max(0, contextTokens - pruneResult.tokensSaved);
		}
		if (shouldCompact(contextTokens, contextWindow, compactionSettings, maxOutputTokens)) {
			await this.#runAutoCompaction("threshold", false, false, {
				continueAfterMaintenance: false,
				deferHandoffMaintenance: false,
			});
		}
	}

	#assistantEndedWithSuccessfulYield(assistantMessage: AssistantMessage): boolean {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		if (!toolCallId) return false;
		const lastToolCall = assistantMessage.content
			.slice()
			.reverse()
			.find((content): content is ToolCall => content.type === "toolCall");
		return lastToolCall?.name === "yield" && lastToolCall.id === toolCallId;
	}

	#enforceRewindBeforeYield(): boolean {
		if (!this.#checkpointState || this.#pendingRewindReport) {
			return false;
		}
		const reminder = [
			"<system-warning>",
			"You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.",
			"</system-warning>",
		].join("\n");
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	async #applyRewind(report: string): Promise<void> {
		const checkpointState = this.#checkpointState;
		if (!checkpointState) {
			return;
		}
		const safeCount = Math.max(0, Math.min(checkpointState.checkpointMessageCount, this.agent.state.messages.length));
		this.agent.replaceMessages(this.agent.state.messages.slice(0, safeCount));
		try {
			this.sessionManager.branchWithSummary(checkpointState.checkpointEntryId, report, {
				startedAt: checkpointState.startedAt,
			});
		} catch (error) {
			logger.warn("Rewind branch checkpoint missing, falling back to root", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.sessionManager.branchWithSummary(null, report, { startedAt: checkpointState.startedAt });
		}
		const details = { startedAt: checkpointState.startedAt, rewoundAt: new Date().toISOString() };
		this.agent.appendMessage({
			role: "custom",
			customType: "rewind-report",
			content: report,
			display: false,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.sessionManager.appendCustomMessageEntry("rewind-report", report, false, details, "agent");
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
	}
	async #enforcePlanModeToolDecision(): Promise<void> {
		if (!this.#planModeState?.enabled) {
			return;
		}
		const assistantMessage = this.#findLastAssistantMessage();
		if (!assistantMessage) {
			return;
		}
		if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
			return;
		}

		const calledRequiredTool = assistantMessage.content.some(
			content => content.type === "toolCall" && (content.name === "ask" || content.name === "resolve"),
		);
		if (calledRequiredTool) {
			return;
		}
		const hasRequiredTools = this.#toolRegistry.has("ask") && this.#toolRegistry.has("resolve");
		if (!hasRequiredTools) {
			logger.warn("Plan mode enforcement skipped because ask/resolve tools are unavailable", {
				activeToolNames: this.agent.state.tools.map(tool => tool.name),
			});
			return;
		}

		const reminder = prompt.render(planModeToolDecisionReminderPrompt, {
			askToolName: "ask",
		});

		await this.prompt(reminder, {
			synthetic: true,
			expandPromptTemplates: false,
			toolChoice: "required",
		});
	}

	#createEagerTodoPrelude(promptText: string): { message: AgentMessage; toolChoice?: ToolChoice } | undefined {
		const eagerTodosEnabled = this.settings.get("todo.eager");
		const todosEnabled = this.settings.get("todo.enabled");
		if (!eagerTodosEnabled || !todosEnabled) {
			return undefined;
		}

		if (this.#planModeState?.enabled) {
			return undefined;
		}
		if (this.getTodoPhases().length > 0) {
			return undefined;
		}

		// Only inject on the first user message of the conversation. Subsequent user
		// turns must not receive the eager todo reminder — they often correct, clarify,
		// or redirect the prior task, and forcing a brand-new todo list there is wrong.
		const hasPriorUserMessage = this.agent.state.messages.some(m => m.role === "user");
		if (hasPriorUserMessage) {
			return undefined;
		}

		const trimmedPromptText = promptText.trimEnd();
		if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) {
			return undefined;
		}

		if (!this.#toolRegistry.has("todo_write")) {
			logger.warn("Eager todo enforcement skipped because todo_write is unavailable", {
				activeToolNames: this.agent.state.tools.map(tool => tool.name),
			});
			return undefined;
		}

		const todoWriteToolChoiceResult = buildNamedToolChoiceResult("todo_write", this.model);
		const todoWriteToolChoice = todoWriteToolChoiceResult.exactNamed ? todoWriteToolChoiceResult.choice : undefined;
		if (!todoWriteToolChoiceResult.exactNamed) {
			logger.debug("Eager todo enforcement degraded; sending reminder without forced tool choice", {
				modelApi: this.model?.api,
				modelId: this.model?.id,
				resolvedLevel: todoWriteToolChoiceResult.resolved?.resolvedLevel,
				reason: todoWriteToolChoiceResult.resolved?.reason,
			});
		}

		const eagerTodoReminder = prompt.render(eagerTodoPrompt);

		return {
			message: {
				role: "custom",
				customType: "eager-todo-prelude",
				content: eagerTodoReminder,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			toolChoice: todoWriteToolChoice,
		};
	}

	async #checkGoalCompletion(assistantMessage: AssistantMessage): Promise<boolean> {
		const state = this.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") {
			this.#lastGoalReminderAssistantTimestamp = undefined;
			return false;
		}
		if (this.#lastGoalReminderAssistantTimestamp === assistantMessage.timestamp) {
			return false;
		}
		this.#lastGoalReminderAssistantTimestamp = assistantMessage.timestamp;

		const continuationPrompt = this.#goalRuntime.buildContinuationPrompt();
		if (!continuationPrompt) return false;
		const reminder = [
			"<system-reminder>",
			"You stopped while a goal is still active and uncleared.",
			"Continue working on the active goal until it is verified complete, paused, or dropped.",
			"",
			continuationPrompt,
			"</system-reminder>",
		].join("\n");

		logger.debug("Goal completion: sending active-goal reminder", { goalId: state.goal.id });
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}
	/**
	 * Check if agent stopped with incomplete todos and prompt to continue.
	 */
	async #checkTodoCompletion(): Promise<void> {
		// Skip todo reminders when the most recent turn was driven by an explicit user force —
		// the user wanted exactly that tool, not a follow-up nag about incomplete todos.
		const lastServedLabel = this.#toolChoiceQueue.consumeLastServedLabel();
		if (lastServedLabel === "user-force") {
			return;
		}

		const remindersEnabled = this.settings.get("todo.reminders");
		const todosEnabled = this.settings.get("todo.enabled");
		if (!remindersEnabled || !todosEnabled) {
			this.#todoReminderCount = 0;
			return;
		}

		const remindersMax = this.settings.get("todo.reminders.max");
		if (this.#todoReminderCount >= remindersMax) {
			logger.debug("Todo completion: max reminders reached", { count: this.#todoReminderCount });
			return;
		}

		const phases = this.getTodoPhases();
		if (phases.length === 0) {
			this.#todoReminderCount = 0;
			return;
		}

		const incompleteByPhase = phases
			.map(phase => ({
				name: phase.name,
				tasks: phase.tasks
					.filter(
						(task): task is TodoItem & { status: "pending" | "in_progress" } =>
							task.status === "pending" || task.status === "in_progress",
					)
					.map(task => ({ content: task.content, status: task.status })),
			}))
			.filter(phase => phase.tasks.length > 0);
		const incomplete = incompleteByPhase.flatMap(phase => phase.tasks);
		if (incomplete.length === 0) {
			this.#todoReminderCount = 0;
			return;
		}

		// Build reminder message
		this.#todoReminderCount++;
		const todoList = incompleteByPhase
			.map(phase => `- ${phase.name}\n${phase.tasks.map(task => `  - ${task.content}`).join("\n")}`)
			.join("\n");
		const reminder =
			`<system-reminder>\n` +
			`You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}\n\n` +
			`Please continue working on these tasks or mark them complete if finished.\n` +
			`(Reminder ${this.#todoReminderCount}/${remindersMax})\n` +
			`</system-reminder>`;

		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#todoReminderCount,
		});

		// Emit event for UI to render notification
		await this.#emitSessionEvent({
			type: "todo_reminder",
			todos: incomplete,
			attempt: this.#todoReminderCount,
			maxAttempts: remindersMax,
		});

		// Inject reminder and continue the conversation
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
	}

	/**
	 * Attempt context promotion to a larger model.
	 * Returns true if promotion succeeded (caller should retry without compacting).
	 */
	async #tryContextPromotion(assistantMessage: AssistantMessage): Promise<boolean> {
		const promotionSettings = this.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const currentModel = this.model;
		if (!currentModel) return false;
		if (assistantMessage.provider !== currentModel.provider || assistantMessage.model !== currentModel.id)
			return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		try {
			await this.setModelTemporary(targetModel);
			logger.debug("Context promotion switched model on overflow", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Context promotion failed", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async #resolveContextPromotionTarget(currentModel: Model, contextWindow: number): Promise<Model | undefined> {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const candidate = this.#resolveContextPromotionConfiguredTarget(currentModel, availableModels);
		if (!candidate) return undefined;
		if (modelsAreEqual(candidate, currentModel)) return undefined;
		if (candidate.contextWindow <= contextWindow) return undefined;
		const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
		if (!apiKey) return undefined;
		return candidate;
	}

	#setModelWithProviderSessionReset(model: Model): void {
		const currentModel = this.model;
		if (currentModel) {
			this.#closeProviderSessionsForModelSwitch(currentModel, model);
		}
		this.agent.setModel(model);

		// Re-evaluate append-only context mode — provider or setting may have changed
		this.#syncAppendOnlyContext(model);
	}

	#closeCodexProviderSessionsForHistoryRewrite(): void {
		const currentModel = this.model;
		if (currentModel?.api !== "openai-codex-responses") return;
		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
	}

	/**
	 * Re-evaluate append-only context mode, creating or destroying the
	 * manager as needed. Called on model switch AND setting change.
	 */
	#syncAppendOnlyContext(model: Model | null | undefined): void {
		const setting = this.settings.get("provider.appendOnlyContext") ?? "auto";
		const providerId = model?.provider;
		const enable = setting === "on" || (setting === "auto" && providerId === "deepseek");
		const prev = this.#lastAppendOnlyResolution;
		if (prev && prev.enable === enable && prev.providerId === providerId) return;
		this.#lastAppendOnlyResolution = { enable, providerId };

		if (enable && !this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(new AppendOnlyContextManager());
		} else if (enable && this.agent.appendOnlyContext) {
			// Already active — invalidate prefix + log so the next turn
			// rebuilds for the current model's normalization.
			this.agent.appendOnlyContext.invalidateForModelChange();
		} else if (!enable && this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(undefined);
		}
	}

	#closeProviderSessionsForModelSwitch(currentModel: Model, nextModel: Model): void {
		const providerKeys = new Set<string>();
		if (currentModel.api === "openai-codex-responses" || nextModel.api === "openai-codex-responses") {
			providerKeys.add("openai-codex-responses");
		}
		if (currentModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${currentModel.provider}`);
		}
		if (nextModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${nextModel.provider}`);
		}

		for (const providerKey of providerKeys) {
			const state = this.#providerSessionState.get(providerKey);
			if (!state) continue;

			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state during model switch", {
					providerKey,
					error: String(error),
				});
			}

			this.#providerSessionState.delete(providerKey);
		}
	}

	#normalizeProviderReplayValue(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map(item => this.#normalizeProviderReplayValue(item));
		}
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, entryValue]) => [key, this.#normalizeProviderReplayValue(entryValue)]),
			);
		}
		return value;
	}

	#normalizeSessionMessageForProviderReplay(message: AgentMessage): unknown {
		switch (message.role) {
			case "user":
			case "developer":
				return {
					role: message.role,
					content: this.#normalizeProviderReplayValue(message.content),
					providerPayload: message.providerPayload,
				};
			case "assistant": {
				const isResponsesFamilyMessage =
					message.api === "openai-responses" || message.api === "openai-codex-responses";
				return {
					role: message.role,
					content:
						isResponsesFamilyMessage && Array.isArray(message.content)
							? message.content.flatMap(block => {
									if (block.type === "thinking") {
										return [];
									}
									if (block.type === "toolCall") {
										return [
											{
												type: block.type,
												id: block.id,
												name: block.name,
												arguments: block.arguments,
											},
										];
									}
									if (block.type === "text") {
										return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
									}
									return [this.#normalizeProviderReplayValue(block)];
								})
							: this.#normalizeProviderReplayValue(message.content),
					api: message.api,
					provider: message.provider,
					model: message.model,
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
					providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
				};
			}
			case "toolResult":
				return {
					role: message.role,
					toolName: message.toolName,
					toolCallId: message.toolCallId,
					isError: message.isError,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "bashExecution":
				return {
					role: message.role,
					command: message.command,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "pythonExecution":
				return {
					role: message.role,
					code: message.code,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "custom":
			case "hookMessage":
				return {
					role: message.role,
					customType: message.customType,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "branchSummary":
				return { role: message.role, summary: message.summary };
			case "compactionSummary":
				return {
					role: message.role,
					summary: message.summary,
					providerPayload: message.providerPayload,
				};
			case "fileMention":
				return {
					role: message.role,
					files: message.files.map(file => ({
						path: file.path,
						content: file.content,
						image: file.image,
					})),
				};
			default:
				return this.#normalizeProviderReplayValue(message);
		}
	}

	#getProviderReplaySource(message: AgentMessage): ProviderReplaySourceCacheEntry {
		const cached = this.#providerReplaySourceCache.get(message);
		if (cached) return cached;
		const source = JSON.stringify(this.#normalizeSessionMessageForProviderReplay(message));
		const hash = this.#hashProviderReplaySource(source);
		const entry = { source, hash };
		this.#providerReplaySourceCache.set(message, entry);
		return entry;
	}

	#hashProviderReplaySource(source: string): bigint {
		return Bun.hash.xxHash64(source);
	}

	#didSessionMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
		if (previousMessages.length !== nextMessages.length) return true;

		const previousSources: ProviderReplaySourceCacheEntry[] = [];
		const nextSources: ProviderReplaySourceCacheEntry[] = [];
		for (let i = 0; i < previousMessages.length; i++) {
			const previous = this.#getProviderReplaySource(previousMessages[i]!);
			const next = this.#getProviderReplaySource(nextMessages[i]!);
			if (previous.hash !== next.hash) return true;
			previousSources.push(previous);
			nextSources.push(next);
		}

		for (let i = 0; i < previousSources.length; i++) {
			if (previousSources[i]!.source !== nextSources[i]!.source) return true;
		}
		return false;
	}

	#getModelKey(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#formatRoleModelValue(
		role: string,
		model: Model,
		selectorOverride?: string,
		thinkingLevelOverride?: ThinkingLevel,
	): string {
		const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
		if (thinkingLevelOverride !== undefined) {
			return formatModelSelectorValue(modelKey, thinkingLevelOverride);
		}
		const existingRoleValue = this.settings.getModelRole(role);
		if (!existingRoleValue) return modelKey;

		const thinkingLevel = extractExplicitThinkingSelector(existingRoleValue, this.settings);
		return formatModelSelectorValue(modelKey, thinkingLevel);
	}
	#resolveContextPromotionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		const configuredTarget = currentModel.contextPromotionTarget?.trim();
		if (!configuredTarget) return undefined;

		const parsed = parseModelString(configuredTarget);
		if (parsed) {
			const explicitModel = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			if (explicitModel) return explicitModel;
		}

		return availableModels.find(m => m.provider === currentModel.provider && m.id === configuredTarget);
	}

	#resolveRoleModelFull(
		role: string,
		availableModels: Model[],
		currentModel: Model | undefined,
	): ResolvedModelRoleValue {
		const roleModelStr =
			role === "default"
				? (this.settings.getModelRole("default") ??
					(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
				: this.settings.getModelRole(role);

		if (!roleModelStr) {
			return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
		}

		return resolveModelRoleValue(roleModelStr, availableModels, {
			settings: this.settings,
			matchPreferences: { usageOrder: this.settings.getStorage()?.getModelUsageOrder() },
			modelRegistry: this.#modelRegistry,
		});
	}

	#getCompactionModelCandidates(availableModels: Model[]): Model[] {
		const candidates: Model[] = [];
		const seen = new Set<string>();

		const addCandidate = (model: Model | undefined): void => {
			if (!model) return;
			const key = this.#getModelKey(model);
			if (seen.has(key)) return;
			seen.add(key);
			candidates.push(model);
		};

		const currentModel = this.model;
		// Prefer the active session's model: it's what the user is actively using,
		// and routing compaction to a different provider (e.g. an OpenAI default
		// model while the chat is on Anthropic) changes provider-specific behavior
		// like remote compaction endpoints. Role-based candidates only kick in
		// as auth fallbacks when the current model has no usable credentials.
		addCandidate(currentModel);
		for (const role of MODEL_ROLE_IDS) {
			addCandidate(this.#resolveRoleModelFull(role, availableModels, currentModel).model);
		}

		// Last-resort fallback: the largest-context model that shares the ACTIVE
		// model's provider. Scoping this to the current provider keeps auto-
		// compaction on the user's configured/custom route instead of silently
		// defaulting to an unrelated provider (e.g. a stray OpenAI credential
		// with no remaining credit) just because it happens to be in the bundled
		// catalog. Cross-provider compaction stays possible, but only when the
		// user opts in explicitly via modelRoles (handled by the loop above).
		const fallbackProvider = currentModel?.provider;
		const sortedByContext = [...availableModels]
			.filter(model => fallbackProvider === undefined || model.provider === fallbackProvider)
			.sort((a, b) => b.contextWindow - a.contextWindow);
		for (const model of sortedByContext) {
			if (!seen.has(this.#getModelKey(model))) {
				addCandidate(model);
				break;
			}
		}

		return candidates;
	}
	#isCompactionAuthFailure(error: unknown): boolean {
		if (!(error instanceof Error)) return false;
		return /auth_unavailable|no auth available/i.test(error.message);
	}

	#buildCompactionAuthError(): Error {
		const currentModel = this.model;
		if (!currentModel) {
			return new Error(
				"Compaction requires a model with usable credentials, but no authenticated compaction model is available.",
			);
		}
		return new Error(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}. ` +
				`Configure ${currentModel.provider} credentials or assign an authenticated fallback via modelRoles.default.`,
		);
	}

	/**
	 * Transport-affinity fields forwarded into local maintenance one-shot LLM
	 * calls (compaction, handoff, branch summary) so they reuse the live turn's
	 * provider session state and configured WebSocket transport preference
	 * instead of falling back to a fresh HTTP/SSE session. Mirrors the
	 * `providerSessionId ?? sessionId` affinity the agent loop sends per turn.
	 */
	#maintenanceProviderTransport(): {
		sessionId: string | undefined;
		providerSessionState: Map<string, ProviderSessionState>;
		preferWebsockets: boolean | undefined;
	} {
		return {
			sessionId: this.agent.providerSessionId ?? this.agent.sessionId,
			providerSessionState: this.#providerSessionState,
			preferWebsockets: this.agent.preferWebsockets,
		};
	}

	async #compactWithFallbackModel(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		options?: SummaryOptions,
	): Promise<CompactionResult> {
		const candidates = this.#getCompactionModelCandidates(this.#modelRegistry.getAvailable());
		const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId);

		for (const candidate of candidates) {
			const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
			if (!apiKey) continue;

			try {
				return await compact(preparation, candidate, apiKey, customInstructions, signal, {
					...options,
					...this.#maintenanceProviderTransport(),
					metadata: this.agent.metadataForProvider(candidate.provider),
					convertToLlm,
					telemetry,
					authCredentialType: this.#modelRegistry.getSessionCredentialType(candidate.provider, this.sessionId),
				});
			} catch (error) {
				if (!this.#isCompactionAuthFailure(error)) {
					throw error;
				}
			}
		}

		throw this.#buildCompactionAuthError();
	}

	async #prepareCompactionFromHooks(
		preparation: CompactionPreparation,
		hookCompaction: CompactionResult | undefined,
	): Promise<
		| {
				kind: "fromHook";
				summary: string;
				shortSummary: string | undefined;
				firstKeptEntryId: string;
				tokensBefore: number;
				details: unknown;
				preserveData: Record<string, unknown> | undefined;
		  }
		| {
				kind: "needsLlm";
				hookContext: string[] | undefined;
				hookPrompt: string | undefined;
				preserveData: Record<string, unknown> | undefined;
		  }
	> {
		let hookContext: string[] | undefined;
		let hookPrompt: string | undefined;
		let preserveData: Record<string, unknown> | undefined;

		if (!hookCompaction && this.#extensionRunner?.hasHandlers("session.compacting")) {
			const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
			const result = (await this.#extensionRunner.emit({
				type: "session.compacting",
				sessionId: this.sessionId,
				messages: compactMessages,
			})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

			hookContext = result?.context;
			hookPrompt = result?.prompt;
			preserveData = result?.preserveData;
		}

		const memoryBackendContext = await this.#collectMemoryBackendContext(preparation);
		if (memoryBackendContext) {
			hookContext = hookContext ? [...hookContext, memoryBackendContext] : [memoryBackendContext];
		}

		if (hookCompaction) {
			preserveData ??= hookCompaction.preserveData;
			return {
				kind: "fromHook",
				summary: hookCompaction.summary,
				shortSummary: hookCompaction.shortSummary,
				firstKeptEntryId: hookCompaction.firstKeptEntryId,
				tokensBefore: hookCompaction.tokensBefore,
				details: hookCompaction.details,
				preserveData,
			};
		}

		return { kind: "needsLlm", hookContext, hookPrompt, preserveData };
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	async #runAutoCompaction(
		reason: "overflow" | "threshold" | "idle",
		willRetry: boolean,
		deferred = false,
		options?: { continueAfterMaintenance?: boolean; deferHandoffMaintenance?: boolean; force?: boolean },
	): Promise<void> {
		const compactionSettings = this.settings.getGroup("compaction");
		// `force` is the non-disableable emergency floor (F6): it bypasses the user's
		// disabled/off settings so a resource-floor breach still compacts before OOM.
		if (!options?.force && compactionSettings.strategy === "off") return;
		if (!options?.force && reason !== "idle" && !compactionSettings.enabled) return;
		const generation = this.#promptGeneration;
		if (
			options?.deferHandoffMaintenance !== false &&
			!deferred &&
			reason !== "overflow" &&
			reason !== "idle" &&
			compactionSettings.strategy === "handoff"
		) {
			this.#schedulePostPromptTask(
				async signal => {
					await Promise.resolve();
					if (signal.aborted) return;
					await this.#runAutoCompaction(reason, willRetry, true, options);
				},
				{ generation },
			);
			return;
		}

		let action: "context-full" | "handoff" =
			compactionSettings.strategy === "handoff" && reason !== "overflow" ? "handoff" : "context-full";
		const continueAfterMaintenance = options?.continueAfterMaintenance !== false;
		await this.#emitSessionEvent({ type: "auto_compaction_start", reason, action });
		// Abort any older auto-compaction before installing this run's controller.
		this.#autoCompactionAbortController?.abort();
		const autoCompactionAbortController = new AbortController();
		this.#autoCompactionAbortController = autoCompactionAbortController;
		const autoCompactionSignal = autoCompactionAbortController.signal;

		try {
			if (compactionSettings.strategy === "handoff" && reason !== "overflow") {
				const handoffFocus = AUTO_HANDOFF_THRESHOLD_FOCUS;
				const handoffResult = await this.handoff(handoffFocus, {
					autoTriggered: true,
					signal: this.#autoCompactionAbortController.signal,
				});
				if (!handoffResult) {
					const aborted = autoCompactionSignal.aborted;
					if (aborted) {
						await this.#emitSessionEvent({
							type: "auto_compaction_end",
							action,
							result: undefined,
							aborted: true,
							willRetry: false,
						});
						return;
					}
					logger.warn("Auto-handoff returned no document; falling back to context-full maintenance", {
						reason,
					});
					action = "context-full";
				}
				if (handoffResult) {
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
					});
					if (
						continueAfterMaintenance &&
						!autoCompactionSignal.aborted &&
						reason !== "idle" &&
						compactionSettings.autoContinue !== false
					) {
						this.#scheduleAutoContinuePrompt(generation);
					}
					return;
				}
			}

			if (!this.model) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return;
			}

			const availableModels = this.#modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return;
			}

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, compactionSettings);
			if (!preparation) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				if (willRetry) {
					this.#stripOverflowFailedTurnForRetry();
					if (this.#isResumableAgentTail()) {
						this.#scheduleAgentContinue({
							delayMs: 100,
							generation,
							onSkip: skipReason => this.#logCompactionContinuationSkipped("overflow_retry", skipReason),
							onError: error => this.#logCompactionContinuationError("overflow_retry", error),
						});
					} else {
						const tail = this.agent.state.messages.at(-1) as AssistantMessage | undefined;
						logger.warn("Auto-compaction continuation skipped", {
							source: "overflow_retry",
							reason: "not_resumable_tail",
							role: tail?.role,
							stopReason: tail?.stopReason,
						});
					}
				} else if (continueAfterMaintenance && reason !== "idle" && this.agent.hasQueuedMessages()) {
					this.#scheduleAgentContinue({
						delayMs: 100,
						generation,
						shouldContinue: () => this.agent.hasQueuedMessages(),
						onSkip: skipReason => this.#logCompactionContinuationSkipped("queued_continue", skipReason),
						onError: error => this.#logCompactionContinuationError("queued_continue", error),
					});
				} else if (continueAfterMaintenance && reason !== "idle" && compactionSettings.autoContinue !== false) {
					this.#scheduleAutoContinuePrompt(generation);
				}
				return;
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
				const hookResult = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: autoCompactionSignal,
				})) as SessionBeforeCompactResult | undefined;

				if (hookResult?.cancel) {
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return;
				}

				if (hookResult?.compaction) {
					hookCompaction = hookResult.compaction;
					fromExtension = true;
				}
			}

			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction);

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else {
				const candidates = this.#getCompactionModelCandidates(availableModels);
				const retrySettings = this.settings.getGroup("retry");
				const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId);
				let compactResult: CompactionResult | undefined;
				let lastError: unknown;

				for (const candidate of candidates) {
					const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
					if (!apiKey) continue;

					let attempt = 0;
					while (true) {
						try {
							compactResult = await compact(preparation, candidate, apiKey, undefined, autoCompactionSignal, {
								...this.#maintenanceProviderTransport(),
								promptOverride: compactionPrep.hookPrompt,
								extraContext: compactionPrep.hookContext,
								remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
								metadata: this.agent.metadataForProvider(candidate.provider),
								initiatorOverride: "agent",
								convertToLlm,
								telemetry,
								authCredentialType: this.#modelRegistry.getSessionCredentialType(
									candidate.provider,
									this.sessionId,
								),
							});
							break;
						} catch (error) {
							if (autoCompactionSignal.aborted) {
								throw error;
							}

							const message = error instanceof Error ? error.message : String(error);
							if (this.#isCompactionAuthFailure(error)) {
								lastError = this.#buildCompactionAuthError();
								break;
							}
							const retryAfterMs = this.#parseRetryAfterMsFromError(message);
							const shouldRetry =
								retrySettings.enabled &&
								attempt < retrySettings.maxRetries &&
								(retryAfterMs !== undefined ||
									this.#isTransientErrorMessage(message) ||
									isUsageLimitError(message));
							if (!shouldRetry) {
								lastError = error;
								break;
							}

							const baseDelayMs = retrySettings.baseDelayMs * 2 ** attempt;
							const delayMs = retryAfterMs !== undefined ? Math.max(baseDelayMs, retryAfterMs) : baseDelayMs;

							// If retry delay is too long (>30s), try next candidate instead of waiting
							const maxAcceptableDelayMs = 30_000;
							if (delayMs > maxAcceptableDelayMs) {
								const hasMoreCandidates = candidates.indexOf(candidate) < candidates.length - 1;
								if (hasMoreCandidates) {
									logger.warn("Auto-compaction retry delay too long, trying next model", {
										delayMs,
										retryAfterMs,
										error: message,
										model: `${candidate.provider}/${candidate.id}`,
									});
									lastError = error;
									break; // Exit retry loop, continue to next candidate
								}
								// No more candidates - we have to wait
							}

							attempt++;
							logger.warn("Auto-compaction failed, retrying", {
								attempt,
								maxRetries: retrySettings.maxRetries,
								delayMs,
								retryAfterMs,
								error: message,
								model: `${candidate.provider}/${candidate.id}`,
							});
							await scheduler.wait(delayMs, { signal: autoCompactionSignal });
						}
					}

					if (compactResult) {
						break;
					}
				}

				if (!compactResult) {
					if (lastError) {
						throw lastError;
					}
					throw new Error("Compaction failed: no available model");
				}

				summary = compactResult.summary;
				shortSummary = compactResult.shortSummary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
				preserveData = { ...(compactionPrep.preserveData ?? {}), ...(compactResult.preserveData ?? {}) };
			}

			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return;
			}

			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();
			this.#closeCodexProviderSessionsForHistoryRewrite();

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const result: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			await this.#emitSessionEvent({ type: "auto_compaction_end", action, result, aborted: false, willRetry });

			if (willRetry) {
				this.#stripOverflowFailedTurnForRetry();
				if (!this.#isResumableAgentTail()) {
					const tail = this.agent.state.messages.at(-1) as AssistantMessage | undefined;
					logger.warn("Auto-compaction continuation skipped", {
						source: "overflow_retry",
						reason: "not_resumable_tail",
						role: tail?.role,
						stopReason: tail?.stopReason,
					});
				} else {
					this.#scheduleAgentContinue({
						delayMs: 100,
						generation,
						onSkip: reason => this.#logCompactionContinuationSkipped("overflow_retry", reason),
						onError: error => this.#logCompactionContinuationError("overflow_retry", error),
					});
				}
			} else if (continueAfterMaintenance && reason !== "idle" && this.agent.hasQueuedMessages()) {
				// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
				// Kick the loop so queued messages are actually delivered.
				this.#scheduleAgentContinue({
					delayMs: 100,
					generation,
					shouldContinue: () => this.agent.hasQueuedMessages(),
					onSkip: reason => this.#logCompactionContinuationSkipped("queued_continue", reason),
					onError: error => this.#logCompactionContinuationError("queued_continue", error),
				});
			} else if (continueAfterMaintenance && reason !== "idle" && compactionSettings.autoContinue !== false) {
				this.#scheduleAutoContinuePrompt(generation);
			}
		} catch (error) {
			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return;
			}
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
		} finally {
			if (this.#autoCompactionAbortController === autoCompactionAbortController) {
				this.#autoCompactionAbortController = undefined;
			}
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settings.set("compaction.enabled", enabled);
		if (enabled && this.settings.get("compaction.strategy") === "off") {
			this.settings.set("compaction.strategy", "context-full");
		}
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settings.get("compaction.enabled") && this.settings.get("compaction.strategy") !== "off";
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Whether an error should be retried. Uses the ordered classifier:
	 * context-overflow routes to compaction; clearly-terminal coded errors
	 * (auth/400/not-found) surface immediately; usage-limit, transient, and
	 * unknown/no-code errors are retryable.
	 */
	#isRetryableError(message: AssistantMessage): boolean {
		const classification = this.#classifyErrorForRetry(message);
		return (
			classification === "usage_limit" ||
			classification === "transient" ||
			classification === "unknown" ||
			classification === "first_event_timeout"
		);
	}

	#isTransientErrorMessage(errorMessage: string): boolean {
		return (
			this.#isTransientEnvelopeErrorMessage(errorMessage) || this.#isTransientTransportErrorMessage(errorMessage)
		);
	}

	#isTransientEnvelopeErrorMessage(errorMessage: string): boolean {
		// Match Anthropic stream-envelope failures that indicate a broken stream before any content starts.
		return /anthropic stream envelope error:/i.test(errorMessage) && /before message_start/i.test(errorMessage);
	}

	#isTransientTransportErrorMessage(errorMessage: string): boolean {
		// Match: overloaded_error, provider returned error, rate limit, 429, 500, 502, 503, 504,
		// service unavailable, provider-suggested retry, network/connection/socket errors, fetch failed,
		// terminated, retry delay exceeded
		return (
			isUnexpectedSocketCloseMessage(errorMessage) ||
			/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response/i.test(
				errorMessage,
			)
		);
	}

	#isFirstEventTimeoutErrorMessage(errorMessage: string): boolean {
		// First-event timeout: the stream watchdog aborted because no event
		// arrived within the first-event window. Matches the shared lazy-stream
		// message and the per-provider variants
		// ("<Provider> stream timed out while waiting for the first event").
		return /timed?\s*out while waiting for the first event|timeout waiting for first/i.test(errorMessage);
	}

	/**
	 * Whether a first-event timeout on the error's provider should fail closed —
	 * i.e. retry a bounded number of times (capped at retry.maxRetries) and then
	 * surface, instead of joining the unbounded transient-retry class.
	 *
	 * Targets the ollama-chat API, which is exclusively ollama-cloud (local
	 * Ollama uses the openai-responses API). That remote, queued backend can
	 * stall before its first token even for tiny prompts; an unbounded
	 * continuation retry re-issues the full request on every attempt and can
	 * silently spike upstream usage (#713). First-party providers keep their
	 * existing unbounded first-event-timeout retry behavior.
	 */
	#shouldFailClosedOnFirstEventTimeout(message: AssistantMessage): boolean {
		// Prefer the active model's API (the model that produced the error);
		// the errored message's API is a fallback for the rare case where the
		// session model has already moved on.
		return this.model?.api === "ollama-chat" || message.api === "ollama-chat";
	}

	#isTerminalErrorMessage(errorMessage: string): boolean {
		// Errors that will never succeed on retry (auth/permission, malformed
		// request, unknown/unsupported model). These surface immediately rather
		// than retry forever.
		return /unauthorized|forbidden|authentication_error|permission_error|permission denied|invalid api key|invalid_request_error|invalid request|bad request|bad_request|validation_error|unprocessable|payload too large|payment required|insufficient_quota|insufficient credits|missing required (parameter|field)|invalid schema|invalid tool_choice|unsupported (parameter|value|model)|model_not_found|no such model|unknown model|does not (exist|support)|request was aborted|request aborted|the user aborted/i.test(
			errorMessage,
		);
	}

	#extractExplicitHttpStatusFromErrorMessage(errorMessage: string): number | undefined {
		// Parse only explicit HTTP/status wording. Do not treat generic
		// `error: 400` as an HTTP status because rate-limit copy can say
		// "rate limit error: 400 requests per minute".
		const match = /\b(?:http(?:\s+status)?|status(?:[\s_-]+code)?)(?:\s+|[:=]\s*)(\d{3})\b/i.exec(errorMessage);
		if (!match) return undefined;
		const status = Number(match[1]);
		return Number.isFinite(status) && status >= 100 && status <= 599 ? status : undefined;
	}

	/**
	 * Ordered retry classification: overflow (compaction) -> terminal (surface)
	 * -> usage_limit (rotation) -> first_event_timeout (bounded retry) ->
	 * transient (retry) -> unknown (retry).
	 */
	#classifyErrorForRetry(
		message: AssistantMessage,
	): "none" | "overflow" | "terminal" | "usage_limit" | "first_event_timeout" | "transient" | "unknown" {
		if (message.stopReason !== "error" || !message.errorMessage) return "none";
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return "overflow";
		const err = message.errorMessage;
		// Stream-envelope errors are only transient in the pre-message_start
		// variant; any other envelope failure is structural and must surface.
		if (/anthropic stream envelope error:/i.test(err)) {
			return this.#isTransientEnvelopeErrorMessage(err) ? "transient" : "terminal";
		}
		const explicitStatus = this.#extractExplicitHttpStatusFromErrorMessage(err);
		const structuredStatus = message.errorStatus;
		const terminalStatus = explicitStatus ?? structuredStatus;
		const isTerminalHttp4xx =
			terminalStatus !== undefined &&
			terminalStatus >= 400 &&
			terminalStatus < 500 &&
			terminalStatus !== 408 &&
			terminalStatus !== 425 &&
			terminalStatus !== 429;
		if (this.#isTerminalErrorMessage(err)) return "terminal";
		if (isUsageLimitError(err)) return "usage_limit";
		// Explicit HTTP/status wording is authoritative. Structured provider status
		// is also authoritative except for rate-limit copy where providers may have
		// parsed an incidental quota number such as "400 requests per minute".
		if (isTerminalHttp4xx && (explicitStatus !== undefined || !/rate.?limit|too many requests/i.test(err))) {
			return "terminal";
		}
		// A first-event timeout on ollama-cloud (the ollama-chat API) must not
		// join the unbounded transient class: each continuation retry re-issues
		// the full request to a remote, billable backend, so an unbounded loop
		// can silently spike usage (#713). Bound it to retry.maxRetries instead.
		if (this.#isFirstEventTimeoutErrorMessage(err) && this.#shouldFailClosedOnFirstEventTimeout(message)) {
			return "first_event_timeout";
		}
		if (this.#isTransientErrorMessage(err)) return "transient";
		return "unknown";
	}

	#getRetryFallbackChains(): RetryFallbackChains {
		const configuredChains = this.settings.get("retry.fallbackChains");
		if (!configuredChains || typeof configuredChains !== "object") return {};
		return configuredChains as RetryFallbackChains;
	}

	#validateRetryFallbackChains(): void {
		const configuredChains = this.settings.get("retry.fallbackChains");
		if (configuredChains === undefined) return;
		if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
			const msg = "retry.fallbackChains must be a mapping of role names to selector arrays.";
			logger.warn(msg);
			this.configWarnings.push(msg);
			return;
		}

		for (const [role, chain] of Object.entries(configuredChains)) {
			if (!Array.isArray(chain)) {
				const msg = `Fallback chain for role '${role}' must be an array of selector strings.`;
				logger.warn(msg);
				this.configWarnings.push(msg);
				continue;
			}
			for (const selectorStr of chain) {
				if (typeof selectorStr !== "string") {
					const msg = `Fallback chain for role '${role}' contains a non-string selector.`;
					logger.warn(msg);
					this.configWarnings.push(msg);
					continue;
				}
				const parsed = parseRetryFallbackSelector(selectorStr);
				if (!parsed) {
					const msg = `Invalid fallback selector format in role '${role}': ${selectorStr}`;
					logger.warn(msg);
					this.configWarnings.push(msg);
					continue;
				}
				const exists = this.#modelRegistry.find(parsed.provider, parsed.id);
				if (!exists) {
					const msg = `Fallback chain for role '${role}' references unknown model: ${selectorStr}`;
					logger.warn(msg);
					this.configWarnings.push(msg);
				}
			}
		}
	}

	#getRetryFallbackRevertPolicy(): RetryFallbackRevertPolicy {
		return this.settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry";
	}

	#getRetryFallbackPrimarySelector(role: string): RetryFallbackSelector | undefined {
		const configuredSelector = this.settings.getModelRole(role);
		return configuredSelector ? parseRetryFallbackSelector(configuredSelector) : undefined;
	}

	#clearActiveRetryFallback(): void {
		this.#activeRetryFallback = undefined;
	}

	#isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean {
		return this.#modelRegistry.isSelectorSuppressed(selector.raw);
	}

	#noteRetryFallbackCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void {
		let cooldownMs = retryAfterMs;
		if (!cooldownMs || cooldownMs <= 0) {
			const reason = parseRateLimitReason(errorMessage);
			cooldownMs = reason === "UNKNOWN" ? 5 * 60 * 1000 : calculateRateLimitBackoffMs(reason);
		}
		this.#modelRegistry.suppressSelector(currentSelector, Date.now() + cooldownMs);
	}

	#resolveRetryFallbackRole(currentSelector: string): string | undefined {
		const parsedCurrent = parseRetryFallbackSelector(currentSelector);
		if (!parsedCurrent) return undefined;
		const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
		for (const role of Object.keys(this.#getRetryFallbackChains())) {
			const primarySelector = this.#getRetryFallbackPrimarySelector(role);
			if (!primarySelector) continue;
			if (primarySelector.raw === currentSelector) return role;
			if (formatRetryFallbackBaseSelector(primarySelector) === currentBaseSelector) return role;
		}
		return undefined;
	}

	#getRetryFallbackEffectiveChain(role: string): RetryFallbackSelector[] {
		const primarySelector = this.#getRetryFallbackPrimarySelector(role);
		if (!primarySelector) return [];
		const chain = [primarySelector];
		const seen = new Set<string>([primarySelector.raw]);
		for (const selector of this.#getRetryFallbackChains()[role] ?? []) {
			const parsed = parseRetryFallbackSelector(selector);
			if (!parsed || seen.has(parsed.raw)) continue;
			seen.add(parsed.raw);
			chain.push(parsed);
		}
		return chain;
	}

	#findRetryFallbackCandidates(role: string, currentSelector: string): RetryFallbackSelector[] {
		const chain = this.#getRetryFallbackEffectiveChain(role);
		if (chain.length <= 1) return [];
		const parsedCurrent = parseRetryFallbackSelector(currentSelector);
		const currentBaseSelector = parsedCurrent ? formatRetryFallbackBaseSelector(parsedCurrent) : undefined;
		const exactIndex = chain.findIndex(selector => selector.raw === currentSelector);
		if (exactIndex >= 0) return chain.slice(exactIndex + 1);
		const baseIndex = currentBaseSelector
			? chain.findIndex(selector => formatRetryFallbackBaseSelector(selector) === currentBaseSelector)
			: -1;
		if (baseIndex >= 0) return chain.slice(baseIndex + 1);
		return chain.slice(1);
	}

	async #applyRetryFallbackCandidate(
		role: string,
		selector: RetryFallbackSelector,
		currentSelector: string,
	): Promise<void> {
		const candidate = this.#modelRegistry.find(selector.provider, selector.id);
		if (!candidate) {
			throw new Error(`Retry fallback model not found: ${selector.raw}`);
		}
		const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for retry fallback ${selector.raw}`);
		}

		const currentThinkingLevel = this.thinkingLevel;
		const nextThinkingLevel = selector.thinkingLevel ?? currentThinkingLevel;

		this.#setModelWithProviderSessionReset(candidate);
		this.sessionManager.appendModelChange(`${candidate.provider}/${candidate.id}`, "temporary");
		this.settings.getStorage()?.recordModelUsage(`${candidate.provider}/${candidate.id}`);
		this.setThinkingLevel(nextThinkingLevel);
		if (!this.#activeRetryFallback) {
			this.#activeRetryFallback = {
				role,
				originalSelector: currentSelector,
				originalThinkingLevel: currentThinkingLevel,
				lastAppliedFallbackThinkingLevel: nextThinkingLevel,
			};
		} else {
			this.#activeRetryFallback.lastAppliedFallbackThinkingLevel = nextThinkingLevel;
		}
		await this.#emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: selector.raw,
			role,
		});
	}

	async #tryRetryModelFallback(currentSelector: string): Promise<boolean> {
		const role = this.#activeRetryFallback?.role ?? this.#resolveRetryFallbackRole(currentSelector);
		if (!role) return false;

		for (const selector of this.#findRetryFallbackCandidates(role, currentSelector)) {
			if (this.#isRetryFallbackSelectorSuppressed(selector)) continue;
			const candidate = this.#modelRegistry.find(selector.provider, selector.id);
			if (!candidate) continue;
			const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
			if (!apiKey) continue;
			await this.#applyRetryFallbackCandidate(role, selector, currentSelector);
			return true;
		}

		return false;
	}

	async #maybeRestoreRetryFallbackPrimary(): Promise<void> {
		if (!this.#activeRetryFallback) return;
		if (this.#getRetryFallbackRevertPolicy() !== "cooldown-expiry") return;

		const {
			originalSelector: originalSelectorRaw,
			originalThinkingLevel,
			lastAppliedFallbackThinkingLevel,
		} = this.#activeRetryFallback;
		const originalSelector = parseRetryFallbackSelector(originalSelectorRaw);
		if (!originalSelector) {
			this.#clearActiveRetryFallback();
			return;
		}

		const currentModel = this.model;
		if (!currentModel) return;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.thinkingLevel);
		if (currentSelector === originalSelector.raw) {
			if (!this.#isRetryFallbackSelectorSuppressed(originalSelector)) {
				this.#clearActiveRetryFallback();
			}
			return;
		}
		if (this.#isRetryFallbackSelectorSuppressed(originalSelector)) return;

		const primaryModel = this.#modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return;
		const apiKey = await this.#modelRegistry.getApiKey(primaryModel, this.sessionId);
		if (!apiKey) return;

		const currentThinkingLevel = this.thinkingLevel;
		const thinkingToApply =
			currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel;
		this.#setModelWithProviderSessionReset(primaryModel);
		this.sessionManager.appendModelChange(`${primaryModel.provider}/${primaryModel.id}`, "temporary");
		this.settings.getStorage()?.recordModelUsage(`${primaryModel.provider}/${primaryModel.id}`);
		this.setThinkingLevel(thinkingToApply);
		this.#clearActiveRetryFallback();
	}

	#parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		const now = Date.now();
		const retryAfterMsMatch = /retry-after-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (retryAfterMsMatch) {
			return Math.max(0, Number(retryAfterMsMatch[1]));
		}

		const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(errorMessage);
		if (retryAfterMatch) {
			const value = retryAfterMatch[1];
			const seconds = Number(value);
			if (!Number.isNaN(seconds)) {
				return Math.max(0, seconds * 1000);
			}
			const dateMs = Date.parse(value);
			if (!Number.isNaN(dateMs)) {
				return Math.max(0, dateMs - now);
			}
		}

		const retryHintMs = extractRetryHint(undefined, errorMessage);
		if (retryHintMs !== undefined) {
			return retryHintMs;
		}

		const resetMsMatch = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMsMatch) {
			const resetMs = Number(resetMsMatch[1]);
			if (!Number.isNaN(resetMs)) {
				if (resetMs > 1_000_000_000_000) {
					return Math.max(0, resetMs - now);
				}
				return Math.max(0, resetMs);
			}
		}

		const resetMatch = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMatch) {
			const resetSeconds = Number(resetMatch[1]);
			if (!Number.isNaN(resetSeconds)) {
				if (resetSeconds > 1_000_000_000) {
					return Math.max(0, resetSeconds * 1000 - now);
				}
				return Math.max(0, resetSeconds * 1000);
			}
		}

		// Smart Fallback if no exact headers found
		return undefined;
	}

	/**
	 * Handle retryable errors with exponential backoff.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	async #handleRetryableError(message: AssistantMessage): Promise<boolean> {
		const retrySettings = this.settings.getGroup("retry");
		if (!retrySettings.enabled) return false;
		const retryClassification = this.#classifyErrorForRetry(message);
		const unboundedClass = retryClassification === "transient" || retryClassification === "unknown";

		const generation = this.#promptGeneration;
		this.#retryAttempt++;

		// Create retry promise on first attempt so waitForRetry() can await it
		// Ensure only one promise exists (avoid orphaned promises from concurrent calls)
		if (!this.#retryPromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#retryPromise = promise;
			this.#retryResolve = resolve;
		}

		if (!unboundedClass && this.#retryAttempt > retrySettings.maxRetries) {
			// Max retries exceeded, emit final failure and reset
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this.#retryAttempt = 0;
			this.#resolveRetry(); // Resolve so waitForRetry() completes
			return false;
		}

		const errorMessage = message.errorMessage || "Unknown error";
		const parsedRetryAfterMs = this.#parseRetryAfterMsFromError(errorMessage);
		let delayMs = retrySettings.baseDelayMs * 2 ** (this.#retryAttempt - 1);
		let switchedCredential = false;
		let switchedModel = false;

		if (this.model && isUsageLimitError(errorMessage)) {
			const retryAfterMs = parsedRetryAfterMs ?? calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage));
			const switched = await this.#modelRegistry.authStorage.markUsageLimitReached(
				this.model.provider,
				this.sessionId,
				{
					retryAfterMs,
					baseUrl: this.model.baseUrl,
				},
			);
			if (switched) {
				switchedCredential = true;
				delayMs = 0;
			} else if (retryAfterMs > delayMs) {
				// No more accounts to switch to — wait out the backoff
				delayMs = retryAfterMs;
			}
		}

		const currentSelector = this.model ? formatRetryFallbackSelector(this.model, this.thinkingLevel) : undefined;
		if (!switchedCredential && currentSelector) {
			this.#noteRetryFallbackCooldown(currentSelector, parsedRetryAfterMs, errorMessage);
			switchedModel = await this.#tryRetryModelFallback(currentSelector);
			if (switchedModel) {
				delayMs = 0;
			} else if (parsedRetryAfterMs && parsedRetryAfterMs > delayMs) {
				delayMs = parsedRetryAfterMs;
			}
		}

		// Fail-fast cap: if the provider asks us to wait longer than
		// retry.maxDelayMs and we have no fallback credential or model to
		// switch to, surface the error instead of sleeping. Defends against
		// 3-hour Anthropic rate-limit windows that would otherwise leave a
		// subagent (or interactive session) silently hung. The original
		// assistant error message is preserved in agent state so the caller
		// can act on it.
		const maxDelayMs = retrySettings.maxDelayMs;
		if (unboundedClass && !switchedCredential && !switchedModel) {
			// Retry forever: honor a provider-supplied wait, otherwise cap the
			// exponential backoff at the ceiling instead of giving up.
			if (parsedRetryAfterMs !== undefined) {
				delayMs = Math.max(delayMs, parsedRetryAfterMs);
			} else if (maxDelayMs > 0) {
				delayMs = Math.min(delayMs, maxDelayMs);
			}
		}
		if (!unboundedClass && maxDelayMs > 0 && delayMs > maxDelayMs && !switchedCredential && !switchedModel) {
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: `Provider requested ${delayMs}ms wait, exceeds retry.maxDelayMs (${maxDelayMs}ms). Original error: ${errorMessage}`,
			});
			this.#resolveRetry();
			return false;
		}

		// Create and install the backoff abort controller BEFORE emitting
		// auto_retry_start, so a synchronous retryNow()/abortRetry() invoked from
		// an event subscriber (e.g. the TUI Esc handler) is not lost in the gap
		// between the event and the controller assignment.
		const retryAbortController = new AbortController();
		this.#retryAbortController?.abort();
		this.#retryAbortController = retryAbortController;
		this.#retryNowRequested = false;

		await this.#emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#retryAttempt,
			maxAttempts: retrySettings.maxRetries,
			delayMs,
			errorMessage,
			unbounded: unboundedClass,
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.replaceMessages(messages.slice(0, -1));
		}

		// Wait with exponential backoff (abortable).
		try {
			await scheduler.wait(delayMs, { signal: retryAbortController.signal });
		} catch {
			if (this.#retryAbortController !== retryAbortController) {
				return false;
			}
			this.#retryAbortController = undefined;
			if (this.#retryNowRequested) {
				// Retry-now: skip the remaining backoff and fall through to
				// re-attempt immediately (keeps the retry session alive).
				this.#retryNowRequested = false;
			} else {
				// Aborted during sleep (cancel) - emit end event so UI can clean up
				const attempt = this.#retryAttempt;
				this.#retryAttempt = 0;
				await this.#emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt,
					finalError: "Retry cancelled",
				});
				this.#resolveRetry();
				return false;
			}
		}
		if (this.#retryAbortController === retryAbortController) {
			this.#retryAbortController = undefined;
		}

		// Retry via continue() outside the agent_end event callback chain.
		// If the scheduled continue cannot run — it throws (e.g. AgentBusyError from a
		// concurrent turn, or "Cannot continue ...") or is skipped because a newer
		// generation took over — the agent_end that normally resolves #retryPromise
		// never arrives. Finalize the retry in that case so #waitForPostPromptRecovery
		// (and the in-flight prompt holding it open) cannot wedge the session as
		// permanently busy, which would turn every later prompt() into a
		// non-recoverable AgentBusyError loop.
		this.#scheduleAgentContinue({
			delayMs: 1,
			generation,
			onError: () => this.#failRetryRecovery("Retry continuation failed to start"),
			onSkip: () => this.#failRetryRecovery("Retry continuation was superseded"),
		});

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.#retryNowRequested = false;
		this.#retryAbortController?.abort();
		// Note: #retryAttempt is reset in the catch block of #handleRetryableError
		this.#resolveRetry();
	}

	/**
	 * Skip the current retry backoff and re-attempt immediately. Distinct from
	 * abortRetry(), which cancels the retry and returns to idle. No-op when no
	 * retry backoff is active.
	 */
	retryNow(): void {
		if (!this.#retryAbortController) return;
		this.#retryNowRequested = true;
		this.#retryAbortController.abort();
	}

	/**
	 * Finalize a pending auto-retry that can no longer reach a resolving agent_end
	 * (the scheduled continue threw or was superseded). Without this, #retryPromise
	 * stays unresolved, #waitForPostPromptRecovery never returns, the owning
	 * prompt's in-flight count is never released, and the session reports
	 * `isStreaming === true` forever — turning every later prompt() into a
	 * non-recoverable AgentBusyError. No-op once the retry has already settled.
	 */
	#failRetryRecovery(reason: string): void {
		if (!this.#retryPromise) return;
		const attempt = this.#retryAttempt;
		this.#retryAttempt = 0;
		void this.#emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: reason,
		});
		this.#resolveRetry();
	}

	async #promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.agent.prompt(messages, options);
				return;
			} catch (err) {
				if (!(err instanceof AgentBusyError)) {
					throw err;
				}
				if (Date.now() >= deadline) {
					throw new Error("Timed out waiting for prior agent run to finish before prompting.");
				}
				await this.agent.waitForIdle();
			}
		}
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settings.get("retry.enabled") ?? true;
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settings.set("retry.enabled", enabled);
	}
	/**
	 * Manually retry the last failed assistant turn.
	 * Removes the error message from agent state and re-attempts with a fresh retry budget.
	 * @returns true if retry was initiated, false if no failed turn to retry or agent is busy
	 */
	async retry(): Promise<boolean> {
		if (this.isStreaming || this.isCompacting || this.isRetrying) return false;

		const messages = this.agent.state.messages;
		const lastMsg = messages[messages.length - 1];
		if (lastMsg?.role !== "assistant") return false;

		const assistantMsg = lastMsg as AssistantMessage;
		if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") return false;

		// Remove the failed/aborted assistant message (same as auto-retry does before re-attempting)
		this.agent.replaceMessages(messages.slice(0, -1));

		// Reset retry budget for a fresh attempt
		this.#retryAttempt = 0;

		// Re-attempt the turn
		this.#scheduleAgentContinue({ delayMs: 1 });

		return true;
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	async #saveBashOriginalArtifact(originalText: string): Promise<string | undefined> {
		try {
			return await this.sessionManager.saveArtifact(originalText, "bash-original");
		} catch {
			return undefined;
		}
	}

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<BashResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();

		if (this.#extensionRunner?.hasHandlers("user_bash")) {
			const hookResult = await this.#extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd,
			});
			if (hookResult?.result) {
				this.recordBashResult(command, hookResult.result, options);
				if (hookResult.result.exitCode === 0 && !hookResult.result.cancelled) {
					await this.#activatePendingGjcGoalModeRequest();
				}
				return hookResult.result;
			}
		}

		const abortController = new AbortController();
		this.#bashAbortControllers.add(abortController);

		try {
			const result = await executeBashCommand(command, {
				onChunk,
				signal: abortController.signal,
				sessionKey: this.sessionId,
				cwd,
				timeout: clampTimeout("bash") * 1000,
				env: buildGjcRuntimeSessionEnv({
					sessionFile: this.sessionManager.getSessionFile(),
					sessionId: this.sessionId,
					cwd,
				}),
				onMinimizedSave: originalText => this.#saveBashOriginalArtifact(originalText),
			});

			this.recordBashResult(command, result, options);
			if (result.exitCode === 0 && !result.cancelled) {
				await this.#activatePendingGjcGoalModeRequest();
			}
			return result;
		} finally {
			this.#bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this.#pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of this.#bashAbortControllers) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this.#bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this.#pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	#flushPendingBashMessages(): void {
		if (this.#pendingBashMessages.length === 0) return;

		for (const bashMessage of this.#pendingBashMessages) {
			// Add to agent state
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this.#pendingBashMessages = [];
	}

	// =========================================================================
	// User-Initiated Python Execution
	// =========================================================================

	/**
	 * Execute Python code in the shared kernel.
	 * Uses the same kernel session as eval's Python backend, allowing collaborative editing.
	 * @param code The Python code to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, execution won't be sent to LLM ($$ prefix)
	 */
	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();
		this.assertEvalExecutionAllowed();

		const abortController = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
			if (this.#extensionRunner?.hasHandlers("user_python")) {
				const hookResult = await this.#extensionRunner.emitUserPython({
					type: "user_python",
					code,
					excludeFromContext,
					cwd,
				});
				this.assertEvalExecutionAllowed();
				if (hookResult?.result) {
					this.recordPythonResult(code, hookResult.result, options);
					return hookResult.result;
				}
			}

			// Use the same session ID as eval's Python backend for kernel sharing
			const sessionFile = this.sessionManager.getSessionFile();
			const sessionId = sessionFile ? `session:${sessionFile}:cwd:${cwd}` : `cwd:${cwd}`;
			const result = await executePythonCommand(code, {
				cwd,
				sessionId,
				kernelOwnerId: this.#evalKernelOwnerId,
				kernelMode: this.settings.get("python.kernelMode"),
				onChunk,
				signal: abortController.signal,
			});
			this.recordPythonResult(code, result, options);
			return result;
		})();
		return await this.trackEvalExecution(execution, abortController);
	}

	assertEvalExecutionAllowed(): void {
		if (this.#evalExecutionDisposing) {
			throw new Error("Python execution is unavailable while session disposal is in progress");
		}
	}

	/**
	 * Track Python work started outside AgentSession.executePython so dispose can await and abort it too.
	 */
	trackEvalExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#evalAbortControllers.add(abortController);
		this.#activeEvalExecutions.add(execution);
		void execution.then(
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
		);
		return execution;
	}

	/**
	 * Record a Python execution result in session history.
	 */
	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const pythonMessage: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			this.#pendingPythonMessages.push(pythonMessage);
		} else {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}
	}

	/**
	 * Cancel running Python execution.
	 */
	abortEval(): void {
		for (const abortController of this.#evalAbortControllers) {
			abortController.abort();
		}
	}

	async #waitForEvalExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeEvalExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#activeEvalExecutions)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#activeEvalExecutions.size > 0) {
				return false;
			}
		}
		return true;
	}

	async #prepareEvalExecutionsForDispose(): Promise<boolean> {
		if (!(await this.#waitForEvalExecutionsToSettle(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abortEval();
			if (!(await this.#waitForEvalExecutionsToSettle(1_000))) {
				logger.warn(
					"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
				);
				return false;
			}
		}
		return true;
	}

	/** Whether a Python execution is currently running */
	get isEvalRunning(): boolean {
		return this.#evalAbortControllers.size > 0;
	}

	/** Whether there are pending Python messages waiting to be flushed */
	get hasPendingPythonMessages(): boolean {
		return this.#pendingPythonMessages.length > 0;
	}

	/**
	 * Flush pending Python messages to agent state and session.
	 */
	#flushPendingPythonMessages(): void {
		if (this.#pendingPythonMessages.length === 0) return;

		for (const pythonMessage of this.#pendingPythonMessages) {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}

		this.#pendingPythonMessages = [];
	}

	// =========================================================================
	// Background-Channel IRC Exchanges
	// =========================================================================

	/**
	 * Generate an ephemeral reply to a background message (e.g. an IRC ping from
	 * another agent) using this session's current model + system prompt + history.
	 *
	 * The reply is computed via a side-channel `streamSimple` call (analogous to
	 * `/btw`) so it never blocks on the recipient's in-flight tool calls.  After
	 * the reply is generated, both the incoming question and the auto-reply are
	 * queued for injection into the recipient's persisted history so the model
	 * sees the exchange on its next turn.  Injection happens immediately when the
	 * session is idle, otherwise it is deferred until streaming ends.
	 */
	async respondAsBackground(args: {
		from: string;
		message: string;
		awaitReply?: boolean;
		signal?: AbortSignal;
	}): Promise<{ replyText: string | null }> {
		const awaitReply = args.awaitReply !== false;
		const incomingTimestamp = Date.now();
		const incomingRecord: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: `[IRC \`${args.from}\` → you]\n\n${args.message}`,
			display: true,
			details: { from: args.from, message: args.message },
			attribution: "agent",
			timestamp: incomingTimestamp,
		};
		void this.#emitSessionEvent({ type: "irc_message", message: incomingRecord });
		this.#forwardIrcRelayToMain({
			from: args.from,
			to: this.#agentId ?? "?",
			body: args.message,
			kind: "message",
			timestamp: incomingTimestamp,
		});

		if (!awaitReply) {
			this.#queueBackgroundExchangeInjection([incomingRecord]);
			return { replyText: null };
		}

		const incomingPrompt = prompt.render(ircIncomingTemplate, {
			from: args.from,
			message: args.message,
		});
		const { replyText } = await this.runEphemeralTurn({
			promptText: incomingPrompt,
			signal: args.signal,
		});

		const replyRecord: CustomMessage = {
			role: "custom",
			customType: "irc:autoreply",
			content: `[IRC you → \`${args.from}\` (auto)]\n\n${replyText}`,
			display: true,
			details: { to: args.from, reply: replyText },
			attribution: "agent",
			timestamp: Date.now(),
		};
		void this.#emitSessionEvent({ type: "irc_message", message: replyRecord });
		this.#forwardIrcRelayToMain({
			from: this.#agentId ?? "?",
			to: args.from,
			body: replyText,
			kind: "reply",
			timestamp: replyRecord.timestamp,
		});
		this.#queueBackgroundExchangeInjection([incomingRecord, replyRecord]);

		return { replyText };
	}

	/**
	 * Forward an IRC exchange observation to the main agent's session UI so the
	 * user can see every IRC conversation in the main transcript, even when the
	 * main agent is not a direct participant. The relay record is display-only:
	 * it is NOT injected into the main agent's persisted history.
	 */
	#forwardIrcRelayToMain(args: {
		from: string;
		to: string;
		body: string;
		kind: "message" | "reply";
		timestamp: number;
	}): void {
		const registry = this.#agentRegistry;
		if (!registry) return;
		// If this session is the main agent, the local emit already reached the main UI.
		if (this.#agentId === MAIN_AGENT_ID) return;
		const mainRef = registry.get(MAIN_AGENT_ID);
		const mainSession = mainRef?.session;
		if (!mainSession || mainSession === this) return;
		const arrow = args.kind === "reply" ? "→ (auto)" : "→";
		const relayRecord: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${args.from}\` ${arrow} \`${args.to}\`]\n\n${args.body}`,
			display: true,
			details: { from: args.from, to: args.to, body: args.body, kind: args.kind },
			attribution: "agent",
			timestamp: args.timestamp,
		};
		mainSession.emitIrcRelayObservation(relayRecord);
	}

	/**
	 * Emit an IRC relay observation event on this session for UI rendering only.
	 * Does not persist the record to history. Public so other sessions can forward.
	 */
	emitIrcRelayObservation(record: CustomMessage): void {
		void this.#emitSessionEvent({ type: "irc_message", message: record });
	}

	/**
	 * Run a single ephemeral side-channel turn against this session's current
	 * model + system prompt + history.  No tools are used; the side request
	 * does not block on, or interfere with, any in-flight main turn.  The
	 * session's history and persisted state are NOT modified by this call.
	 *
	 * Used by `respondAsBackground` (IRC) and `BtwController` (`/btw`) to share
	 * the snapshot + stream pipeline.  The snapshot includes any in-flight
	 * streaming assistant text so the model sees the half-finished response
	 * rather than missing context.
	 */
	async runEphemeralTurn(args: {
		promptText: string;
		onTextDelta?: (delta: string) => void;
		signal?: AbortSignal;
	}): Promise<{ replyText: string; assistantMessage: AssistantMessage }> {
		const model = this.model;
		if (!model) {
			throw new Error("No active model on session");
		}
		const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const snapshot = this.#buildEphemeralSnapshot(args.promptText);
		const llmMessages = await this.convertMessagesToLlm(snapshot, args.signal);
		const context: Context = {
			systemPrompt: this.systemPrompt,
			messages: llmMessages,
			// Empty tools array: with toolChoice="none" some encoders still serialize the
			// recipient's tool catalog and the model leaks raw call markup
			// (<function_calls>, DSML envelopes) into IRC replies. Stripping tools here
			// removes the surface entirely.
			tools: [],
		};
		const options = this.prepareSimpleStreamOptions(
			{
				apiKey,
				sessionId: this.sessionId,
				reasoning: toReasoningEffort(this.thinkingLevel),
				hideThinkingSummary: this.agent.hideThinkingSummary,
				serviceTier: this.serviceTier,
				signal: args.signal,
				toolChoice: "none",
			},
			model.provider,
		);

		let replyText = "";
		let assistantMessage: AssistantMessage | undefined;
		const stream = streamSimple(model, context, options);
		for await (const event of stream) {
			if (event.type === "text_delta") {
				replyText += event.delta;
				if (args.onTextDelta) args.onTextDelta(event.delta);
				continue;
			}
			if (event.type === "done") {
				assistantMessage = event.message;
				break;
			}
			if (event.type === "error") {
				throw new Error(event.error.errorMessage || "Ephemeral turn failed");
			}
		}

		if (!assistantMessage) {
			throw new Error("Ephemeral turn ended without a final message");
		}
		return { replyText: dedupeIrcReply(replyText.trim()), assistantMessage };
	}

	/**
	 * Build a message snapshot for an ephemeral side-channel turn.  Includes
	 * the in-flight streaming assistant message (if any) so the model sees
	 * the partial response in context, then appends the prompt as a virtual
	 * user message.
	 */
	#buildEphemeralSnapshot(promptText: string): AgentMessage[] {
		const messages = [...this.messages];
		const streaming = this.agent.state.streamMessage;
		if (streaming && streaming.role === "assistant") {
			const preservedBlocks: AssistantMessage["content"] = [];
			// Preserve thinking blocks: DeepSeek-class encoders replay them as
			// `reasoning_content` and reject the request (HTTP 400) when the field
			// goes missing on a turn that previously emitted thinking.
			for (const c of streaming.content) {
				if (c.type === "thinking") preservedBlocks.push(c);
			}
			const streamingText = streaming.content
				.filter((c): c is TextContent => c.type === "text")
				.map(c => c.text)
				.join("");
			if (streamingText) {
				preservedBlocks.push({ type: "text", text: streamingText });
			}
			if (preservedBlocks.length > 0) {
				const normalized: AssistantMessage = {
					...streaming,
					content: preservedBlocks,
				};
				const lastMessage = messages.at(-1);
				if (lastMessage?.role === "assistant") {
					messages[messages.length - 1] = normalized;
				} else {
					messages.push(normalized);
				}
			}
		}
		messages.push({
			role: "user",
			content: [{ type: "text", text: promptText }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		return messages;
	}

	#queueBackgroundExchangeInjection(messages: CustomMessage[]): void {
		this.#pendingBackgroundExchanges.push(messages);
		if (!this.isStreaming) {
			this.#flushPendingBackgroundExchanges();
			return;
		}
		this.#scheduleBackgroundExchangeFlush();
	}

	#scheduleBackgroundExchangeFlush(): void {
		if (this.#scheduledBackgroundExchangeFlush) return;
		this.#scheduledBackgroundExchangeFlush = true;
		const attempt = (): void => {
			if (this.#pendingBackgroundExchanges.length === 0 || this.#isDisposed) {
				this.#pendingBackgroundExchanges = [];
				this.#scheduledBackgroundExchangeFlush = false;
				return;
			}
			if (this.isStreaming) {
				// Re-poll while streaming, but do not let this housekeeping timer
				// keep the event loop alive on its own (CPU-7).
				const pollTimer = setTimeout(attempt, 50);
				pollTimer.unref?.();
				return;
			}
			this.#scheduledBackgroundExchangeFlush = false;
			this.#flushPendingBackgroundExchanges();
		};
		const kickoff = setTimeout(attempt, 0);
		kickoff.unref?.();
	}

	#flushPendingBackgroundExchanges(): void {
		if (this.#pendingBackgroundExchanges.length === 0) return;
		const batches = this.#pendingBackgroundExchanges;
		this.#pendingBackgroundExchanges = [];
		for (const batch of batches) {
			for (const msg of batch) {
				// emitExternalEvent on message_end appends to agent state and dispatches
				// to all session listeners, which in turn handle TUI rendering and
				// sessionManager persistence via #handleAgentEvent.
				this.agent.emitExternalEvent({ type: "message_start", message: msg });
				this.agent.emitExternalEvent({ type: "message_end", message: msg });
			}
		}
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Reload the current session from disk.
	 *
	 * Intended for extension commands and headless modes to re-read the current session
	 * file and re-emit session_switch hooks.
	 */
	async reload(): Promise<void> {
		const sessionFile = this.sessionFile;
		if (!sessionFile) return;
		await this.switchSession(sessionFile);
	}

	/**
	 * Switch to a different session file.
	 * Aborts current operation, loads messages, restores model/thinking.
	 * Listeners are preserved and will continue receiving events.
	 * @returns true if switch completed, false if cancelled by hook
	 */
	async switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();
		const switchingToDifferentSession = previousSessionFile
			? path.resolve(previousSessionFile) !== path.resolve(sessionPath)
			: true;
		// Emit session_before_switch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort();

		// Flush pending writes before switching so restore snapshots reflect committed state.
		await this.sessionManager.flush();
		const previousSessionState = this.sessionManager.captureState();
		const previousSessionContext = this.buildDisplaySessionContext();
		// switchSession replaces these arrays wholesale during load/rollback, so retaining
		// the existing message objects is sufficient and avoids structured-clone failures for
		// extension/custom metadata that is valid to persist but not cloneable.
		const previousAgentMessages = [...this.agent.state.messages];
		const previousSteeringMessages = [...this.#steeringMessages];
		const previousFollowUpMessages = [...this.#followUpMessages];
		const previousPendingNextTurnMessages = [...this.#pendingNextTurnMessages];
		const previousScheduledHiddenNextTurnGeneration = this.#scheduledHiddenNextTurnGeneration;
		const previousModel = this.model;
		const previousThinkingLevel = this.#thinkingLevel;
		const previousServiceTier = this.agent.serviceTier;
		const previousSelectedMCPToolNames = new Set(this.#selectedMCPToolNames);
		const previousTools = [...this.agent.state.tools];
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const previousSystemPrompt = this.agent.state.systemPrompt;
		const previousFallbackSelectedMCPToolNames = previousSessionFile
			? this.#getSessionDefaultSelectedMCPToolNames(previousSessionFile)
			: undefined;
		const previousAgentSteeringQueue = this.agent.snapshotSteering();
		const previousAgentFollowUpQueue = this.agent.snapshotFollowUp();

		this.#steeringMessages = [];
		this.#followUpMessages = [];
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		try {
			await this.sessionManager.setSessionFile(sessionPath);
			this.#syncAgentSessionId();
			this.#rekeyHindsightMemoryForCurrentSessionId();

			const sessionContext = this.buildDisplaySessionContext();
			const didReloadConversationChange =
				!switchingToDifferentSession &&
				this.#didSessionMessagesChange(previousSessionContext.messages, sessionContext.messages);
			const fallbackSelectedMCPToolNames = this.#getSessionDefaultSelectedMCPToolNames(sessionPath);
			await this.#restoreMCPSelectionsForSessionContext(sessionContext, { fallbackSelectedMCPToolNames });

			// The target session is loaded and MCP selections are restored: the
			// switch is committed far enough to discard pre-switch delivery queues.
			// Clear before session_switch hooks, so messages enqueued by hooks belong
			// to the new session and remain deliverable.
			this.agent.clearAllQueues();

			// Emit session_switch event to hooks
			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_switch",
					reason: "resume",
					previousSessionFile,
				});
			}

			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();
			if (switchingToDifferentSession) {
				this.#closeAllProviderSessions("session switch");
			} else if (didReloadConversationChange) {
				this.#closeAllProviderSessions("session reload");
			}

			// Restore model if saved
			const defaultModelStr = sessionContext.models.default;
			if (defaultModelStr) {
				const slashIdx = defaultModelStr.indexOf("/");
				if (slashIdx > 0) {
					const provider = defaultModelStr.slice(0, slashIdx);
					const modelId = defaultModelStr.slice(slashIdx + 1);
					const availableModels = this.#modelRegistry.getAvailable();
					const match = availableModels.find(m => m.provider === provider && m.id === modelId);
					if (match) {
						const currentModel = this.model;
						const shouldResetProviderState =
							switchingToDifferentSession ||
							(currentModel !== undefined &&
								(currentModel.provider !== match.provider ||
									currentModel.id !== match.id ||
									currentModel.api !== match.api));
						if (shouldResetProviderState) {
							this.#setModelWithProviderSessionReset(match);
						} else {
							this.agent.setModel(match);
						}
					}
				}
			}

			const hasThinkingEntry = this.sessionManager.getBranch().some(entry => entry.type === "thinking_level_change");
			const hasServiceTierEntry = this.sessionManager
				.getBranch()
				.some(entry => entry.type === "service_tier_change");
			const defaultThinkingLevel = this.settings.get("defaultThinkingLevel");
			const configuredServiceTier = this.settings.get("serviceTier");
			const nextThinkingLevel = resolveThinkingLevelForModel(
				this.model,
				hasThinkingEntry ? (sessionContext.thinkingLevel as ThinkingLevel | undefined) : defaultThinkingLevel,
			);
			this.#thinkingLevel = nextThinkingLevel;
			this.agent.setThinkingLevel(toReasoningEffort(nextThinkingLevel));
			this.agent.serviceTier = hasServiceTierEntry
				? sessionContext.serviceTier
				: configuredServiceTier === "none"
					? undefined
					: configuredServiceTier;

			if (switchingToDifferentSession) {
				this.#resetHindsightConversationTrackingIfHindsight();
			}
			this.#reconnectToAgent();
			return true;
		} catch (error) {
			this.sessionManager.restoreState(previousSessionState);
			this.#syncAgentSessionId(previousSessionState.sessionId);
			this.#rekeyHindsightMemoryForCurrentSessionId();
			let restoreMcpError: unknown;
			try {
				await this.#restoreMCPSelectionsForSessionContext(previousSessionContext, {
					fallbackSelectedMCPToolNames: previousFallbackSelectedMCPToolNames,
				});
			} catch (mcpError) {
				restoreMcpError = mcpError;
				logger.warn("Failed to restore MCP selections after switch error", {
					previousSessionFile,
					targetSessionFile: sessionPath,
					error: String(mcpError),
				});
				this.#selectedMCPToolNames = new Set(previousSelectedMCPToolNames);
				this.#setGuardedAgentTools(previousTools);
				this.#baseSystemPrompt = previousBaseSystemPrompt;
				this.agent.setSystemPrompt(previousSystemPrompt);
			}
			this.#baseSystemPrompt = previousBaseSystemPrompt;
			this.agent.setSystemPrompt(previousSystemPrompt);
			this.agent.replaceMessages(previousAgentMessages);
			this.#steeringMessages = previousSteeringMessages;
			this.#followUpMessages = previousFollowUpMessages;
			this.#pendingNextTurnMessages = previousPendingNextTurnMessages;
			this.#scheduledHiddenNextTurnGeneration = previousScheduledHiddenNextTurnGeneration;
			this.agent.clearAllQueues();
			this.agent.restoreSteering(previousAgentSteeringQueue);
			this.agent.restoreFollowUp(previousAgentFollowUpQueue);
			if (previousModel) {
				this.agent.setModel(previousModel);
			}
			this.#thinkingLevel = previousThinkingLevel;
			this.agent.setThinkingLevel(toReasoningEffort(previousThinkingLevel));
			this.agent.serviceTier = previousServiceTier;
			this.#syncTodoPhasesFromBranch();
			this.#reconnectToAgent();
			if (restoreMcpError) {
				throw restoreMcpError;
			}
			throw error;
		}
	}

	/**
	 * Create a branch from a specific entry.
	 * Emits before_branch/branch session events to hooks.
	 *
	 * @param entryId ID of the entry to branch from
	 * @returns Object with:
	 *   - selectedText: The text of the selected user message (for editor pre-fill)
	 *   - cancelled: True if a hook cancelled the branch
	 */
	async branch(entryId: string): Promise<{
		selectedText: string;
		cancelled: boolean;
	}> {
		const previousSessionFile = this.sessionFile;
		const selectedEntry = this.sessionManager.getEntry(entryId);

		if (selectedEntry?.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for branching");
		}

		const selectedText = this.#extractUserMessageText(selectedEntry.message.content);

		let skipConversationRestore = false;

		// Emit session_before_branch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { selectedText, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}

		// Clear pending messages (bound to old session state)
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		// Flush pending writes before branching
		await this.sessionManager.flush();
		this.#cancelOwnAsyncJobs();

		if (!selectedEntry.parentId) {
			await this.sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			this.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.#syncTodoPhasesFromBranch();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#resetHindsightConversationTrackingIfHindsight();

		// Reload messages from entries (works for both file and in-memory mode)
		const sessionContext = this.buildDisplaySessionContext();

		await this.#restoreMCPSelectionsForSessionContext(sessionContext);

		// Emit session_branch event to hooks (after branch completes)
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		if (!skipConversationRestore) {
			this.agent.replaceMessages(sessionContext.messages);
			this.#closeCodexProviderSessionsForHistoryRewrite();
		}

		return { selectedText, cancelled: false };
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike branch() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string } = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
		/** Raw session context built during navigation — pass to renderInitialMessages to skip a second O(N) walk. */
		sessionContext?: SessionContext;
	}> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data
		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};

		// Set up abort controller for summarization
		this.#branchSummaryAbortController = new AbortController();
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// Emit session_before_tree event
		if (this.#extensionRunner?.hasHandlers("session_before_tree")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this.#branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				hookSummary = result.summary;
				fromExtension = true;
			}
		}

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
			const model = this.model!;
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}
			const branchSummarySettings = this.settings.getGroup("branchSummary");
			const result = await generateBranchSummary(entriesToSummarize, {
				...this.#maintenanceProviderTransport(),
				model,
				apiKey,
				signal: this.#branchSummaryAbortController.signal,
				customInstructions: options.customInstructions,
				reserveTokens: branchSummarySettings.reserveTokens,
				metadata: this.agent.metadataForProvider(model.provider),
				convertToLlm,
				telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),
			});
			this.#branchSummaryAbortController = undefined;
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (hookSummary) {
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = this.#extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message") {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
		} else {
			// Non-user message: leaf = selected node
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary)
		// Summary is attached at the navigation target position (newLeafId), not the old branch
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			// Create summary at target position (can be null for root)
			const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);
			summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
		} else if (newLeafId === null) {
			// No summary, navigating to root - reset leaf
			this.sessionManager.resetLeaf();
		} else {
			// No summary, navigating to non-root
			this.sessionManager.branch(newLeafId);
		}

		// Update agent state — build display context to populate agent messages.
		const stateContext = this.sessionManager.buildSessionContext();
		const displayContext = deobfuscateSessionContext(stateContext, this.#obfuscator);
		await this.#restoreMCPSelectionsForSessionContext(displayContext);
		this.agent.replaceMessages(displayContext.messages);
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		this.#branchSummaryAbortController = undefined;

		// Emit session_tree event; only handlers can mutate session entries, so skip
		// the emit and the context rebuild when no handlers are registered (mirrors
		// the session_before_tree guard above).
		if (this.#extensionRunner?.hasHandlers("session_tree")) {
			await this.#extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});
			const rawContext = this.sessionManager.buildSessionContext();
			return { editorText, cancelled: false, summaryEntry, sessionContext: rawContext };
		}
		return { editorText, cancelled: false, summaryEntry, sessionContext: stateContext };
	}

	/**
	 * Get all user messages from session for branch selector.
	 */
	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this.#extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	#extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;
		let totalPremiumRequests = 0;
		const getTaskToolUsage = (details: unknown): Usage | undefined => {
			if (!details || typeof details !== "object") return undefined;
			const record = details as Record<string, unknown>;
			const usage = record.usage;
			if (!usage || typeof usage !== "object") return undefined;
			return usage as Usage;
		};

		// Single pass over messages (replaces three role filters plus a separate usage
		// loop) so per-turn stats stay O(messages + assistant content blocks), not O(4N).
		for (const message of state.messages) {
			if (message.role === "user") {
				userMessages += 1;
			} else if (message.role === "assistant") {
				assistantMessages += 1;
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter(c => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalPremiumRequests += assistantMsg.usage.premiumRequests ?? 0;
				totalCost += assistantMsg.usage.cost.total;
			} else if (message.role === "toolResult") {
				toolResults += 1;
				if (message.toolName === "task") {
					const usage = getTaskToolUsage(message.details);
					if (usage) {
						totalInput += usage.input;
						totalOutput += usage.output;
						totalCacheRead += usage.cacheRead;
						totalCacheWrite += usage.cacheWrite;
						totalPremiumRequests += usage.premiumRequests ?? 0;
						totalCost += usage.cost.total;
					}
				}
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			premiumRequests: totalPremiumRequests,
		};
	}

	/**
	 * Get current context usage statistics.
	 * Uses the last assistant message's usage data when available,
	 * otherwise estimates tokens for all messages.
	 */
	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = this.#estimateContextTokens();
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		const authStorage = this.#modelRegistry.authStorage;
		if (!authStorage.fetchUsageReports) return null;
		return authStorage.fetchUsageReports({
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}

	/**
	 * Estimate context tokens from messages, using the last assistant usage when available.
	 */
	#estimateContextTokens(): {
		tokens: number;
	} {
		return this.#estimateContextTokensWith(message => this.#estimateMessageDisplayTokens(message));
	}

	#estimateContextTokensForCompaction(pendingMessages: readonly AgentMessage[]): {
		tokens: number;
	} {
		const estimate = this.#estimateContextTokensWith(message => this.#estimateMessageCompactionDeltaTokens(message));
		return {
			tokens: estimate.tokens + this.#estimateMessagesCompactionDeltaTokens(pendingMessages),
		};
	}

	#estimateContextTokensWith(estimateMessage: (message: AgentMessage) => number): {
		tokens: number;
	} {
		const messages = this.messages;

		// Find last assistant message with usage
		let lastUsageIndex: number | null = null;
		let lastUsage: Usage | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				if (assistantMsg.usage) {
					lastUsage = assistantMsg.usage;
					lastUsageIndex = i;
					break;
				}
			}
		}

		if (!lastUsage || lastUsageIndex === null) {
			// No usage data - estimate all messages
			let estimated = 0;
			for (const message of messages) {
				estimated += estimateMessage(message);
			}
			return {
				tokens: estimated,
			};
		}

		const usageTokens = calculatePromptTokens(lastUsage);
		let trailingTokens = 0;
		for (let i = lastUsageIndex + 1; i < messages.length; i++) {
			trailingTokens += estimateMessage(messages[i]);
		}

		return {
			tokens: usageTokens + trailingTokens,
		};
	}

	#estimateMessagesCompactionDeltaTokens(messages: readonly AgentMessage[]): number {
		let tokens = 0;
		for (const message of messages) {
			tokens += this.#estimateMessageCompactionDeltaTokens(message);
		}
		return tokens;
	}

	#estimateMessageDisplayTokens(message: AgentMessage): number {
		let tokens = 0;
		for (const llmMessage of convertToLlm([message])) {
			tokens += estimateMessageTokensHeuristic(llmMessage);
		}
		return tokens;
	}

	/**
	 * Conservative inflation applied to the native-free chars/4 estimate of the
	 * UNSENT context delta. chars/4 undercounts dense code/CJK, so we bias high
	 * to compact slightly early rather than overflow the model window before the
	 * next provider response re-anchors the exact count.
	 */
	#compactionDeltaInflation = 1.2;
	#compactionDeltaTokenCache = new WeakMap<AgentMessage, { len: number; tokens: number }>();

	/**
	 * Cheap content-size signal to invalidate the compaction-delta token cache on mutation. Recursively
	 * sums string lengths across the whole message (depth-bounded), so it covers every
	 * provider-visible shape (text/thinking/tool args, toolResult output, tool names, etc.)
	 * without allocating a serialized copy. A size-preserving in-place edit yields only a
	 * benign estimate drift.
	 */
	#messageTokenSize(value: unknown, depth = 0): number {
		if (depth > 6) return 0;
		if (typeof value === "string") return value.length;
		if (typeof value === "number" || typeof value === "boolean") return 8;
		if (Array.isArray(value)) {
			let size = 0;
			for (const item of value) size += this.#messageTokenSize(item, depth + 1);
			return size;
		}
		if (value && typeof value === "object") {
			let size = 0;
			for (const item of Object.values(value)) size += this.#messageTokenSize(item, depth + 1);
			return size;
		}
		return 0;
	}

	#estimateMessageCompactionDeltaTokens(message: AgentMessage): number {
		// Provider usage anchors the already-sent context (see calculatePromptTokens); this
		// estimates only the UNSENT delta with the native-free chars/4 heuristic, inflated by
		// #compactionDeltaInflation so dense input cannot undercount us past the compaction
		// threshold before the next provider response re-anchors the exact count. Cached per
		// message object, invalidated by a cheap content-size signal; a rare size-preserving
		// in-place edit yields only a benign estimate drift, never wrong output.
		const len = this.#messageTokenSize(message);
		const cached = this.#compactionDeltaTokenCache.get(message);
		if (cached && cached.len === len) return cached.tokens;
		let heuristic = 0;
		for (const llmMessage of convertToLlm([message])) {
			heuristic += estimateMessageTokensHeuristic(llmMessage);
		}
		const tokens = Math.ceil(heuristic * this.#compactionDeltaInflation);
		this.#compactionDeltaTokenCache.set(message, { len, tokens });
		return tokens;
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = getCurrentThemeName();
		return exportSessionToHtml(this.sessionManager, this.state, { outputPath, themeName });
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.#getLastCopyCandidateAssistantMessage();
		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of lastAssistant.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	hasCopyCandidateAssistantMessage(): boolean {
		return this.#getLastCopyCandidateAssistantMessage() !== undefined;
	}

	#getLastCopyCandidateAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "assistant") continue;

			const assistantMessage = message as AssistantMessage;
			// Skip aborted messages with no content
			if (assistantMessage.stopReason === "aborted" && assistantMessage.content.length === 0) continue;

			return assistantMessage;
		}

		return undefined;
	}
	/**
	 * Get text content of the most recent visible handoff message.
	 * Fresh handoff sessions store the handoff context as a custom message, not
	 * an assistant message, so callers that copy the "last" message can use this
	 * as a fallback before the new session has an assistant response.
	 */
	getLastVisibleHandoffText(): string | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "custom") continue;

			const customMessage = message as CustomMessage;
			if (customMessage.customType !== "handoff" || !customMessage.display) continue;

			if (typeof customMessage.content === "string") {
				return customMessage.content.trim() || undefined;
			}

			let text = "";
			for (const content of customMessage.content) {
				if (content.type === "text") {
					text += content.text;
				}
			}
			return text.trim() || undefined;
		}

		return undefined;
	}

	/**
	 * Format the entire session as plain text for clipboard export.
	 * Includes user messages, assistant text, thinking blocks, tool calls, and tool results.
	 */
	formatSessionAsText(): string {
		return formatSessionDumpText({
			messages: this.messages,
			systemPrompt: this.agent.state.systemPrompt,
			model: this.agent.state.model,
			thinkingLevel: this.#thinkingLevel,
			tools: this.agent.state.tools,
		});
	}

	/**
	 * Format the conversation as compact context for subagents.
	 * Includes only user messages and assistant text responses.
	 * Excludes: system prompt, tool definitions, tool calls/results, thinking blocks.
	 */
	formatCompactContext(): string {
		const lines: string[] = [];
		lines.push("# Conversation Context");
		lines.push("");
		lines.push(
			"This is a summary of the parent conversation. Read this if you need additional context about what was discussed or decided.",
		);
		lines.push("");

		for (const msg of this.messages) {
			if (msg.role === "user" || msg.role === "developer") {
				lines.push(msg.role === "developer" ? "## Developer" : "## User");
				lines.push("");
				if (typeof msg.content === "string") {
					lines.push(msg.content);
				} else {
					for (const c of msg.content) {
						if (c.type === "text") {
							lines.push(c.text);
						} else if (c.type === "image") {
							lines.push("[Image attached]");
						}
					}
				}
				lines.push("");
			} else if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				// Only include text content, skip tool calls and thinking
				const textParts: string[] = [];
				for (const c of assistantMsg.content) {
					if (c.type === "text" && c.text.trim()) {
						textParts.push(c.text);
					}
				}
				if (textParts.length > 0) {
					lines.push("## Assistant");
					lines.push("");
					lines.push(textParts.join("\n\n"));
					lines.push("");
				}
			} else if (msg.role === "fileMention") {
				const fileMsg = msg as FileMentionMessage;
				const paths = fileMsg.files.map(f => f.path).join(", ");
				lines.push(`[Files referenced: ${paths}]`);
				lines.push("");
			} else if (msg.role === "compactionSummary") {
				const compactMsg = msg as CompactionSummaryMessage;
				lines.push("## Earlier Context (Summarized)");
				lines.push("");
				lines.push(compactMsg.summary);
				lines.push("");
			}
			// Skip: toolResult, bashExecution, pythonExecution, branchSummary, custom, hookMessage
		}

		return lines.join("\n").trim();
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this.#extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Register a first-party internal before-agent-start contributor. Returns an
	 * unregister function. This is NOT user-facing hook discovery; it is an
	 * in-core seam invoked alongside the extension runner.
	 */
	registerBeforeAgentStartContributor(contributor: BeforeAgentStartContributor): () => void {
		this.#beforeAgentStartContributors.push(contributor);
		return () => {
			const idx = this.#beforeAgentStartContributors.indexOf(contributor);
			if (idx !== -1) this.#beforeAgentStartContributors.splice(idx, 1);
		};
	}

	/**
	 * Append before-agent-start custom messages (from the extension runner or
	 * internal contributors) using one shared attribution/defaulting path.
	 */
	#appendBeforeAgentStartCustomMessages(
		target: AgentMessage[],
		returned: readonly BeforeAgentStartInternalMessage[],
		promptAttribution: "user" | "agent" | undefined,
		messageRole: string,
	): void {
		for (const msg of returned) {
			target.push({
				role: "custom",
				customType: msg.customType,
				content: msg.content,
				display: msg.display,
				details: msg.details,
				attribution: msg.attribution ?? promptAttribution ?? (messageRole === "user" ? "user" : "agent"),
				timestamp: Date.now(),
			});
		}
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this.#extensionRunner;
	}
}

function cloneJsonValueForForkSeed<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
