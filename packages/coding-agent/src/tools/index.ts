import type { AgentTelemetryConfig, AgentTool } from "@gajae-code/agent-core";
import type { Model, ServiceTier, ToolChoice } from "@gajae-code/ai/core";
import { $env, logger } from "@gajae-code/utils";
import type { AsyncJobManager } from "../async";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState, GoalRuntime } from "../goals";
import type { HindsightSessionState } from "../hindsight/state";
import type { WorkflowGateEmitter } from "../modes/shared/agent-wire/workflow-gate-broker";
import type { PlanModeState } from "../plan-mode/state";
import type { AgentRegistry } from "../registry/agent-registry";
import type {
	ForkContextSeed,
	ForkContextSeedOptions,
	PurgeQueuedCustomMessagesResult,
} from "../session/agent-session";
import type { ArtifactManager } from "../session/artifacts";
import type { ClientBridge } from "../session/client-bridge";
import type { FoldAdapter } from "../session/fold-coordinator";
import type { CustomMessage } from "../session/messages";
import type { ToolChoiceQueue } from "../session/tool-choice-queue";
import type { SkillActiveEntry } from "../skill-state/active-state";
import type { AgentOutputManager } from "../task/output-manager";
import type { DiscoverableTool, DiscoverableToolSearchIndex } from "../tool-discovery/tool-index";
import type { EventBus } from "../utils/event-bus";
import type { WorkspaceTree } from "../workspace-tree";
import type { BashRestrictionProfile } from "./bash-allowed-prefixes";
import type { CheckpointState } from "./checkpoint";
import { isComputerLoadablePlatform } from "./computer-policy";
import {
	BUILTIN_TOOL_DESCRIPTORS,
	BUILTIN_TOOLS,
	HIDDEN_TOOL_DESCRIPTORS,
	LazyAgentTool,
	PLATFORM_EXCLUDED_TOOL_DESCRIPTORS,
	resolveEffectiveDiscoveryMode,
	type ToolAvailabilityContext,
} from "./descriptors";
import { wrapToolWithMetaNotice } from "./output-meta";
import type { TodoPhase } from "./todo-write";

export type { LspStartupServerInfo } from "../lsp";
export type { BashToolDetails, BashToolInput } from "./bash";
export * from "./descriptors";
export type { FindToolDetails, FindToolInput } from "./find";
export type { ReadToolDetails, ReadToolInput } from "./read";
export type { SearchToolDetails, SearchToolInput } from "./search";
export { TOOL_CATALOG } from "./tool-catalog.generated";
export type { WriteToolDetails, WriteToolInput } from "./write";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any, any, any>;

/** Built-in automation surfaces that an SDK host may back with its own transport. */
export type AutomationToolName = "browser" | "computer";

/**
 * Host-owned implementations for the built-in automation surfaces.
 *
 * Each implementation must use the matching built-in name. The normal
 * AgentTool execute signature carries cancellation through its AbortSignal,
 * while the implementation owns the model-facing schema and description.
 */
export type AutomationTools = Partial<Record<AutomationToolName, Tool>>;

export type ContextFileEntry = {
	path: string;
	content: string;
	depth?: number;
};

export type {
	DiscoverableTool,
	DiscoverableToolSearchIndex,
	DiscoverableToolSearchResult,
	DiscoverableToolSource,
} from "../tool-discovery/tool-index";

/** A typed remote action available to an ask answer source. */
export type AskRemoteControlId = "navigation_forward";

export interface AskRemoteControl {
	id: AskRemoteControlId;
	kind: "navigation";
	label: "Next" | "Done";
	enabled: boolean;
}

export interface AskAnswerRequest {
	question: string;
	options: string[];
	interaction: "selector" | "custom_editor" | "clarification_editor";
	controls: readonly AskRemoteControl[];
	/** Optional zero-based recommendation into the authoritative raw options. */
	recommendedIndex?: number;
	/** True while the question accepts several options before the navigation control commits. */
	multi?: boolean;
	/**
	 * Options currently selected in the multi-select loop, as authoritative option
	 * labels. Remote transports render the selection state so a toggle is visible.
	 */
	selectedOptions?: readonly string[];
	/** Milliseconds before a remote source auto-selects; absent means no timeout. */
	timeoutMs?: number;
	/** Number of trailing synthetic transition entries (Other/clarification) appended by the ask tool. */
	transitionCount?: number;
}

export type AskRemoteInteraction =
	| { kind: "value"; value: string }
	| { kind: "control"; controlId: AskRemoteControlId };

export type AskSettlement =
	| { kind: "commit" }
	| {
			kind: "resolve_without_commit";
			reason:
				| "toggle"
				| "other_transition"
				| "clarification_transition"
				| "clarification_submitted"
				| "empty_navigation"
				| "back_navigation"
				| "cancelled"
				| "aborted"
				| "timed_out"
				| "exception"
				| "shutdown";
	  }
	| {
			kind: "invalid";
			reason:
				| "invalid_option"
				| "invalid_control"
				| "invalid_structured_answer"
				| "empty_custom"
				| "empty_clarification";
	  };

export type AskSelectedAckOutcome =
	| { status: "delivered"; messageId: number }
	| {
			status: "failed";
			reason:
				| "unsupported"
				| "no_participant"
				| "ambiguous_participant"
				| "route_missing"
				| "expired"
				| "cancelled"
				| "telegram_rejected"
				| "session_closed";
	  }
	| { status: "unknown"; reason: "transport_ambiguous" | "origin_disconnected" | "host_timeout" | "shutdown" };

export type AskSettlementResult =
	| { kind: "committed"; ack: AskSelectedAckOutcome }
	| { kind: "resolved_without_commit" }
	| { kind: "invalid_closed" };

export interface AskRemoteReceipt {
	source: "remote";
	interaction: AskRemoteInteraction;
	settle(value: AskSettlement): Promise<AskSettlementResult>;
}

export type AskAnswerSourceResult = AskRemoteReceipt | string | undefined;

/**
 * Source of remote answers for interactive asks. `awaitAnswer` remains the legacy
 * wire for existing integrations; typed sources opt into `awaitAnswerRequest`.
 * This keeps a string-only source from accidentally acquiring acknowledgement
 * authority while allowing SDK-routed interactions to settle durably.
 */
export interface AskAnswerSource {
	awaitAnswer(question: string, options: string[], signal?: AbortSignal): Promise<string | undefined>;
	awaitAnswerRequest?(request: AskAnswerRequest, signal?: AbortSignal): Promise<AskAnswerSourceResult>;
}

/** Session context for tool factories */
export interface ToolSession {
	/** Current working directory */
	cwd: string;
	/** Whether UI is available */
	hasUI: boolean;
	/** Whether this session will bind a workflow-gate emitter after tool construction. */
	workflowGateEligible?: boolean;
	/** Skip Python kernel availability check and warmup */
	skipPythonPreflight?: boolean;
	/** Pre-loaded context files (AGENTS.md, etc) */
	contextFiles?: ContextFileEntry[];
	/** Pre-loaded workspace tree (forwarded to subagents to skip re-scanning) */
	workspaceTree?: WorkspaceTree;
	/** Pre-loaded skills */
	/**
	 * Explicit user home for runtime skill discovery. Tests construct sessions
	 * against an isolated home because the trusted-home resolver deliberately
	 * ignores `$HOME` on Linux (it reads the NSS account database instead), so a
	 * `process.env.HOME` override cannot steer user-scope discovery there.
	 *
	 * Production sessions leave this unset and the trusted OS home governs.
	 * Runtime discovery only; never threaded into capability loading.
	 */
	home?: string;
	skills?: Skill[];
	/** Currently executing skill prompt, when this tool session is inside one. */
	getActiveSkillState?: () => Pick<SkillActiveEntry, "skill" | "session_id"> | undefined;
	/** Get the active skill prompt's current phase so the skill tool can apply
	 *  its terminal-phase chain guard. Returns the raw phase string or undefined
	 *  when no active skill (or accessor) is available. */
	getActiveSkillPhase?: () => string | undefined;
	/** Restrict provider-facing deep-interview ask metadata to the active workflow stage. */
	getDeepInterviewAskStage?: () => "topology" | "post-topology" | undefined;
	/** Pre-loaded prompt templates */
	promptTemplates?: PromptTemplate[];
	/** Whether LSP integrations are enabled */
	enableLsp?: boolean;
	/** Whether an edit-capable tool is available in this session (controls hashline output) */
	hasEditTool?: boolean;
	/** Event bus for tool/extension communication */
	eventBus?: EventBus;
	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/** Current role-agent type/name for nested task sessions. */
	currentAgentType?: string;
	/** Get session file */
	getSessionFile: () => string | null;
	/** Get eval kernel owner ID for session-scoped retained-kernel cleanup. */
	getEvalKernelOwnerId?: () => string | null;
	/** Reject new eval (python or js) work once session disposal has started. */
	assertEvalExecutionAllowed?: () => void;
	/** Track tool-owned eval work so session disposal can await/abort it like direct session eval runs. */
	trackEvalExecution?<T>(execution: Promise<T>, abortController: AbortController): Promise<T>;
	/** Register a foldable foreground wait so the fold chord can move it into a background job. */
	registerForegroundFoldParticipant?: (adapter: FoldAdapter) => () => void;
	/** Whether a foreground wait is currently foldable into a background job. */
	hasForegroundBashBackgroundRequestHandler?: () => boolean;
	/** Request that the active foreground wait fold into a background job, if supported. */
	requestForegroundBashBackground?: () => Promise<boolean>;

	/** Get the session-owned or inherited async job manager. */
	getAsyncJobManager?: () => AsyncJobManager | undefined;
	/** Resolves when the session queues user steering (or `signal` aborts) without consuming it; wait-style tools use this to end their observation early. */
	waitForUserSteering?: (signal: AbortSignal) => Promise<void>;
	/** Get session ID */
	getSessionId?: () => string | null;
	/** Get credential-selection session identity. */
	getCredentialSessionId?: () => string | null;
	/** Scope-held MCP facade for mcp:// resolution. */
	getMcpManager?: () => import("../runtime-mcp/manager").MCPManager | undefined;
	/** Whether local:// must use external managed scratch instead of artifacts/local. */
	isManagedSessionDestination?: () => boolean;
	/** Get Hindsight runtime state for this agent session. */
	getHindsightSessionState?: () => HindsightSessionState | undefined;
	/** Agent identity used for IRC routing. Returns the registry id (e.g. "0-Main", "0-AuthLoader"). */
	getAgentId?: () => string | null;
	/** Look up a registered tool by name (used by the eval js backend's tool bridge). */
	getToolByName?: (name: string) => AgentTool | undefined;
	/** Look up a registered tool with the session's execution guards applied. */
	getToolForExecution?: (name: string) => AgentTool | undefined;
	/** Purge undelivered queued custom messages matching the predicate. Returns counts. */
	purgeQueuedCustomMessages?: (predicate: (message: CustomMessage) => boolean) => PurgeQueuedCustomMessagesResult;
	/** Agent registry for IRC routing across live sessions. */
	agentRegistry?: AgentRegistry;
	/** Optional restricted bash command prefixes for read-only role agents and constrained modes. */
	bashAllowedPrefixes?: string[];
	/** Restriction policy for sessions that deliberately expose a narrow bash surface. */
	bashRestrictionProfile?: BashRestrictionProfile;
	/** Process-local master capability injected into direct Bash children only. */
	getMasterBashCapability?: () => string | undefined;
	/** Stable master lineage identity used across session switches and branches. */
	getMasterOwnerSessionId?: () => string | undefined;
	/** Optional per-session allowlist for tools exposed through search_tool_bm25. */
	discoverableToolAllowedNames?: readonly string[];
	/** Throw instead of warn when toolNames contains an unknown name. */
	strictToolNames?: boolean;
	/** Get artifacts directory for artifact:// URLs */
	getArtifactsDir?: () => string | null;
	/** Additional artifacts directories explicitly authorized for this session's tree (parent/child/sibling reads). Derived only from the explicitly adopted/shared `ArtifactManager`; never enumerates unrelated live sessions. */
	getAuthorizedArtifactsDirs?: () => readonly string[];
	/** Get the ArtifactManager backing this session (shared across parent + subagents). */
	getArtifactManager?: () => ArtifactManager | null;
	/** Prove that an ArtifactManager belongs to this concrete session or its explicitly adopted parent tree. */
	isArtifactManagerAuthorized?: (manager: ArtifactManager) => boolean;
	/** Adopt a task-created fallback manager into the concrete session owner. */
	adoptArtifactManager?: (manager: ArtifactManager) => void;
	/** Linearizably establish the concrete session owner's canonical artifact manager. */
	ensureArtifactManager?: () => Promise<ArtifactManager | null>;
	/** Release a task-created fallback manager when its logical session ends. */
	releaseArtifactManager?: (manager: ArtifactManager) => void;
	/** Register teardown work owned by the current logical session. */
	registerSessionCleanup?: (cleanup: () => Promise<void> | void) => () => void;
	/** Allocate a new artifact path and ID for session-scoped truncated output. */
	allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }>;
	/** Get session spawns */
	getSessionSpawns: () => string | null;
	/** Get resolved model string if explicitly set for this session */
	getModelString?: () => string | undefined;
	/** Current model, when selected. */
	model?: Model;
	/** Get the current session model string, regardless of how it was chosen */
	getActiveModelString?: () => string | undefined;
	/** Auth storage for passing to subagents (avoids re-discovery) */
	authStorage?: import("../session/auth-storage").AuthStorage;
	/** Model registry for passing to subagents (avoids re-discovery) */
	modelRegistry?: import("../config/model-registry").ModelRegistry;
	/** Agent output manager for unique agent:// IDs across task invocations */
	agentOutputManager?: AgentOutputManager;
	/** Settings instance for passing to subagents */
	settings: Settings;
	/**
	 * The session's REQUESTED effective agent directory, independent of the
	 * global Settings singleton (which can be reused across sessions).
	 */
	getSessionAgentDir?: () => string;
	/** Live service-tier intent of the parent session, inherited by `inherit` subagents. */
	serviceTier?: ServiceTier;
	/** Whether the effective subagent tier grants fast mode for a resolved provider. */
	isFastForSubagentProvider?: (provider?: string, supportsServiceTier?: boolean) => boolean;
	/** Plan mode state (if active) */
	getPlanModeState?: () => PlanModeState | undefined;
	/** Goal mode state (if active or paused) */
	getGoalModeState?: () => GoalModeState | undefined;
	/** SDK workflow-gate emitter, when a remote gate responder is connected. */
	getWorkflowGateEmitter?: () => WorkflowGateEmitter | undefined;
	/**
	 * Optional SDK-routed answer source for interactive asks. When present, the
	 * tool races the local UI selection against the remote SDK answer.
	 * No-op when undefined: the ask path behaves exactly as before.
	 */
	getAskAnswerSource?: () => AskAnswerSource | undefined;
	/** Optional per-session restriction for goal tool operations. */
	goalToolAllowedOps?: readonly ("create" | "get" | "complete" | "resume" | "drop" | "pause")[];
	/** Goal runtime for the active agent session. */
	getGoalRuntime?: () => GoalRuntime | undefined;
	/**
	 * Agent-invokable session rescope (issue #4629): move the whole session to
	 * an existing directory, running the same sequence as the `/move` handler
	 * (flush → moveTo → setProjectDir → plugin/capability cache reset). Absent
	 * in contexts where relocation must not happen: subagent sessions
	 * (taskDepth > 0) and read-only/restricted bash profiles. Bound to one
	 * successful move per session, rejects re-entrant calls, and only narrows:
	 * the canonical (realpath) target must be a strict descendant of the
	 * canonical current cwd. Throws when the target does not exist, is not a
	 * directory, or escapes the current scope.
	 */
	rescopeSessionCwd?: (path: string) => Promise<{ from: string; to: string }>;
	/** Bridge to the connected client (e.g. ACP editor host). Tools should route fs/terminal/permission requests through this when available. */
	getClientBridge?: () => ClientBridge | undefined;
	/** Get compact conversation context for subagents (excludes tool results, system prompts) */
	getCompactContext?: () => string;
	/** Get cached todo phases for this session. */
	getTodoPhases?: () => TodoPhase[];
	/** Replace cached todo phases for this session. */
	setTodoPhases?: (phases: TodoPhase[]) => void;
	// ── Generic tool discovery (unified — covers built-in + MCP + extension) ──
	/** Explicit top-level MCP config path; affects effective discovery mode before manager setup. */
	mcpConfigPath?: string;
	/** Whether any form of tool discovery is active (tools.discoveryMode !== "off" or mcp.discoveryMode). */
	isToolDiscoveryEnabled?: () => boolean;
	/** Get all hidden-but-discoverable tools for search_tool_bm25 prompts. */
	getDiscoverableTools?: (filter?: {
		source?: import("../tool-discovery/tool-index").DiscoverableToolSource;
	}) => DiscoverableTool[];
	/** Get the cached generic discoverable search index. */
	getDiscoverableToolSearchIndex?: () => DiscoverableToolSearchIndex;
	/** Get tool names activated by prior search_tool_bm25 calls (all sources). */
	getSelectedDiscoveredToolNames?: () => string[];
	/** Merge tool selections into the active session tool set. */
	activateDiscoveredTools?: (toolNames: string[]) => Promise<string[]>;
	/** The tool-choice queue used to force forthcoming tool invocations and carry invocation handlers. */
	getToolChoiceQueue?(): ToolChoiceQueue;
	/** Build a model-provider-specific ToolChoice that targets the named tool, or undefined if unsupported. */
	buildToolChoice?(toolName: string): ToolChoice | undefined;
	/** Build a named tool-choice decision, preserving whether exact named forcing survived capability degradation. */
	buildToolChoiceResult?(toolName: string): import("../utils/tool-choice").NamedToolChoiceResult;
	/** Peek the currently in-flight tool-choice queue directive's invocation handler. Used by the `resolve` tool to dispatch to the pending action. */
	peekQueueInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Peek the long-lived "standing" resolve handler registered by a mode (e.g. plan mode).
	 *  Consulted by the `resolve` tool as a fallback when no queue invoker is in flight,
	 *  letting modes accept `resolve` invocations without forcing the tool choice every turn. */
	peekStandingResolveHandler?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Register or clear the standing resolve handler. Passing `null` clears it. */
	setStandingResolveHandler?(handler: ((input: unknown) => Promise<unknown> | unknown) | null): void;
	/** Get active checkpoint state if any. */
	getCheckpointState?: () => CheckpointState | undefined;
	/** Set or clear active checkpoint state. */
	setCheckpointState?: (state: CheckpointState | null) => void;

	/** Per-session cache of file contents as last shown to the model by
	 *  `read`/`search`. Used by hashline anchor-stale recovery to reconstruct
	 *  the version the model authored anchors against when the file changed
	 *  out-of-band. Lazily initialized by `getFileReadCache`. */
	fileReadCache?: import("../edit/file-read-cache").FileReadCache;

	/** Per-session log of unresolved git merge conflict regions surfaced by
	 *  `read`. Each entry gets a stable id N referenced by `write conflict://N`
	 *  to splice the recorded region with replacement content. Lazily initialized
	 *  by `getConflictHistory`. */
	conflictHistory?: import("./conflict-detect").ConflictHistory;

	/** Queue a hidden message to be injected at the next agent turn. */
	queueDeferredMessage?(message: CustomMessage): void;
	/** Dispatch a custom message through the active session. Used by the `skill`
	 *  tool to dispatch another skill prompt same-turn after recording a handoff. */
	sendCustomMessage?(
		message: Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;
	/** Get the active OpenTelemetry config so subagent dispatch can forward
	 *  the parent's tracer/hooks with the subagent's own identity stamped. */
	getTelemetry?: () => AgentTelemetryConfig | undefined;
	/** Build a sanitized fork-context seed for task subagents. */
	buildForkContextSeed?: (options: ForkContextSeedOptions) => Promise<ForkContextSeed>;
}

export type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

export type BuiltinToolLoadMode = "essential" | "discoverable";

/** Default essential tool names when tools.essentialOverride is empty. */
export const DEFAULT_ESSENTIAL_TOOL_NAMES: readonly string[] = [
	"read",
	"bash",
	"edit",
	"write",
	"search",
	"find",
] as const;

/**
 * Resolve the active essential built-in tool names from settings.
 * Returns `tools.essentialOverride` if non-empty (filtered to known built-ins),
 * otherwise `DEFAULT_ESSENTIAL_TOOL_NAMES`.
 */
export function computeEssentialBuiltinNames(settings: Settings): string[] {
	const override = settings.get("tools.essentialOverride") ?? [];
	const cleaned = override.map(name => name.trim()).filter(Boolean);
	if (cleaned.length > 0) {
		return cleaned.filter(name => name in BUILTIN_TOOLS);
	}
	return [...DEFAULT_ESSENTIAL_TOOL_NAMES];
}

/**
 * Public callable factory map. External callers may invoke `BUILTIN_TOOLS.read(session)` or
 * `BUILTIN_TOOLS[name](session)` to construct a public coding-harness tool directly.
 *
 * Hindsight memory helpers are intentionally excluded: memory is a private backend
 * integration, not a public gajae-code tool surface.
 */
export interface BuiltinCapabilityCatalogEntry {
	name: string;
	label: string;
	summary: string;
	docsPath: string;
	callableBuiltin: boolean;
	defaultEnabled: boolean;
}

export const BUILTIN_CAPABILITY_CATALOG: readonly BuiltinCapabilityCatalogEntry[] = isComputerLoadablePlatform()
	? [
			{
				name: "computer",
				label: "Computer",
				summary:
					"Apple Silicon macOS desktop screenshot and input control; enabled by default on supported hosts and supervisor-gated.",
				docsPath: "docs/tools/computer.md",
				callableBuiltin: false,
				defaultEnabled: true,
			},
		]
	: [];

const GOAL_MODE_TOOL_NAMES = [] as const;

export type ToolName = keyof typeof BUILTIN_TOOLS;

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
}

/**
 * Parse the `GJC_PY` multi-value token into per-backend booleans.
 *
 * Tokens (case-insensitive):
 * - `0` / `bash` → JavaScript only (`{ py: false, js: true }`)
 * - `1` / `py`   → Python only (`{ py: true, js: false }`)
 * - `js`         → JavaScript only (`{ py: false, js: true }`)
 * - `mix` / `both` → both backends (`{ py: true, js: true }`)
 *
 * Returns `null` when `GJC_PY` is unset, empty, or holds an unrecognized
 * token, so the caller can fall back to the legacy `PI_PY` / `PI_JS` flags or
 * per-key settings. This matches the documented contract that invalid values
 * are ignored.
 */
export function parseGjcPy(env: Record<string, string | undefined>): { py: boolean; js: boolean } | null {
	const raw = env.GJC_PY;
	if (raw === undefined) return null;
	const token = raw.trim().toLowerCase();
	if (token === "") return null;
	switch (token) {
		case "0":
		case "bash":
			return { py: false, js: true };
		case "1":
		case "py":
			return { py: true, js: false };
		case "js":
			return { py: false, js: true };
		case "mix":
		case "both":
			return { py: true, js: true };
		default:
			return null;
	}
}

function isTruthyPythonFlag(value: string | undefined): boolean {
	return value !== undefined && ["1", "true", "yes", "on", "y"].includes(value.trim().toLowerCase());
}

/**
 * Parse legacy `PI_PY` / `PI_JS` boolean flags. Each is a boolean flag; unset
 * means "not specified, defer to settings". Returns `null` when neither is set
 * so the caller can fall through to `readEvalBackendsAllowance` per key.
 */
function parseLegacyEvalEnvFlags(env: Record<string, string | undefined>): EvalBackendsAllowance | null {
	const pyEnv = env.PI_PY;
	const jsEnv = env.PI_JS;
	if (pyEnv === undefined && jsEnv === undefined) return null;
	return {
		python: pyEnv === undefined ? true : isTruthyPythonFlag(pyEnv),
		js: jsEnv === undefined ? true : isTruthyPythonFlag(jsEnv),
	};
}

/**
 * Resolve eval-backend allowance from environment only. `GJC_PY` wins when set
 * to a recognized token; otherwise the legacy `PI_PY` / `PI_JS` flags apply.
 * Returns `null` when no env override is set so the caller can defer to settings.
 */
export function resolveEvalBackendsFromEnv(env: Record<string, string | undefined>): EvalBackendsAllowance | null {
	const gjc = parseGjcPy(env);
	if (gjc) return { python: gjc.py, js: gjc.js };
	return parseLegacyEvalEnvFlags(env);
}

/** Read per-backend allowance from settings (defaults true). */
export function readEvalBackendsAllowance(session: ToolSession): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
	};
}

/**
 * Materialize the active eval backend allowance. `GJC_PY` takes precedence
 * over the legacy `PI_PY` / `PI_JS` env flags, which in turn override the
 * per-key settings (defaults true). When no env override is set, settings win.
 */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	return resolveEvalBackendsFromEnv($env) ?? readEvalBackendsAllowance(session);
}

/**
 * Create tools from the descriptor registry.
 */
export async function createTools(
	session: ToolSession,
	toolNames?: string[],
	automationTools: AutomationTools = {},
): Promise<Tool[]> {
	const includeYield = session.requireYieldTool === true;
	const enableLsp = session.enableLsp ?? true;
	let requestedTools =
		toolNames && toolNames.length > 0 ? [...new Set(toolNames.map(name => name.toLowerCase()))] : undefined;
	const goalEnabled = session.settings.get("goal.enabled");
	const goalStateToolNames = [...GOAL_MODE_TOOL_NAMES];
	if (goalEnabled && requestedTools && !requestedTools.includes("goal")) {
		requestedTools = [...requestedTools, "goal"];
	}
	if (goalEnabled && requestedTools) {
		for (const name of goalStateToolNames) {
			if (!requestedTools.includes(name)) requestedTools.push(name);
		}
	}
	const backends = resolveEvalBackends(session);
	const allowPython = backends.python;
	const allowJs = backends.js;
	const skipPythonPreflight = session.skipPythonPreflight === true;
	// Eval tool is enabled if EITHER backend is reachable. We only need to know
	// whether python is reachable when JS is disabled — otherwise allowEval is
	// already true and the python-availability check can be deferred to first
	// invocation of the python backend (already handled inside the executor).
	let pythonAvailable = true;
	if (
		!skipPythonPreflight &&
		allowPython &&
		!allowJs &&
		(requestedTools === undefined || requestedTools.includes("eval"))
	) {
		const { checkPythonKernelAvailability } = await import("../eval/py/kernel");
		const availability = await logger.time(
			"createTools:pythonCheck",
			checkPythonKernelAvailability,
			session.cwd,
			undefined,
			undefined,
			session.settings,
		);
		pythonAvailable = availability.ok;
		if (!availability.ok) {
			logger.warn("Python kernel unavailable and JS backend disabled; eval will be unavailable", {
				reason: availability.reason,
			});
		}
	}

	const effectivePythonAllowed = allowPython && pythonAvailable;
	// Eval is exposed whenever any backend is reachable. The python backend may
	// be unreachable, in which case eval dispatches exclusively to js.
	const allowEval = effectivePythonAllowed || allowJs;

	// Auto-include AST counterparts when their text-based sibling is present
	if (requestedTools) {
		if (
			requestedTools.includes("search") &&
			!requestedTools.includes("ast_grep") &&
			session.settings.get("astGrep.enabled")
		) {
			requestedTools.push("ast_grep");
		}
		if (
			requestedTools.includes("edit") &&
			!requestedTools.includes("ast_edit") &&
			session.settings.get("astEdit.enabled")
		) {
			requestedTools.push("ast_edit");
		}
		if (
			requestedTools.includes("bash") &&
			!requestedTools.includes("recipe") &&
			session.settings.get("recipe.enabled")
		) {
			requestedTools.push("recipe");
		}
	}
	// Resolve effective tool discovery mode through the shared policy used by SDK session construction.
	const effectiveDiscoveryMode = resolveEffectiveDiscoveryMode(session.settings, session.mcpConfigPath);
	const discoveryActive = effectiveDiscoveryMode !== "off";

	const availabilityContext: ToolAvailabilityContext = {
		includeYield,
		enableLsp,
		goalEnabled,
		goalStateToolNames,
		allowEval,
		discoveryActive,
	};
	const builtinToolDescriptors: Record<string, (typeof BUILTIN_TOOL_DESCRIPTORS)[string]> = {
		...BUILTIN_TOOL_DESCRIPTORS,
		...(automationTools.computer && !BUILTIN_TOOL_DESCRIPTORS.computer
			? { computer: PLATFORM_EXCLUDED_TOOL_DESCRIPTORS.computer }
			: {}),
	};
	const allToolDescriptors: Record<string, (typeof BUILTIN_TOOL_DESCRIPTORS)[string]> = {
		...builtinToolDescriptors,
		...HIDDEN_TOOL_DESCRIPTORS,
	};
	const allToolDescriptorEntries = Object.entries(allToolDescriptors) as Array<
		[string, (typeof BUILTIN_TOOL_DESCRIPTORS)[string]]
	>;
	const allToolsByRequestName = new Map<string, [string, (typeof BUILTIN_TOOL_DESCRIPTORS)[string]]>();
	for (const [name, descriptor] of allToolDescriptorEntries) {
		allToolsByRequestName.set(name.toLowerCase(), [name, descriptor]);
	}
	if (includeYield && requestedTools && !requestedTools.includes("yield")) {
		requestedTools.push("yield");
	}

	if (requestedTools) {
		const unknownToolNames = requestedTools.filter(name => !allToolsByRequestName.has(name));
		if (unknownToolNames.length > 0) {
			const message = `Unknown tool name${unknownToolNames.length === 1 ? "" : "s"}: ${unknownToolNames.join(", ")}`;
			if (session.strictToolNames) throw new Error(message);
			logger.warn(message);
		}
	}
	const filteredRequestedTools = requestedTools
		?.map(name => allToolsByRequestName.get(name))
		.filter((entry): entry is [string, (typeof BUILTIN_TOOL_DESCRIPTORS)[string]] => entry !== undefined)
		.filter(
			([name, descriptor]) =>
				automationTools[name as AutomationToolName] !== undefined ||
				descriptor.isAvailable(session, availabilityContext),
		);
	const baseEntries =
		filteredRequestedTools !== undefined
			? filteredRequestedTools.filter(([name]) => name !== "resolve")
			: [
					...Object.entries(builtinToolDescriptors)
						.filter(
							([name, descriptor]) =>
								automationTools[name as AutomationToolName] !== undefined ||
								descriptor.isAvailable(session, availabilityContext),
						)
						.map(([name, descriptor]) => [name, descriptor] as const),
					...(includeYield ? ([["yield", HIDDEN_TOOL_DESCRIPTORS.yield]] as const) : []),
				];

	const selectedDiscoveredNames = new Set(
		[...(requestedTools ?? []), ...(session.getSelectedDiscoveredToolNames?.() ?? [])].map(name =>
			name.toLowerCase(),
		),
	);
	const materialize = async ([name, descriptor]: readonly [string, (typeof BUILTIN_TOOL_DESCRIPTORS)[string]]) => {
		const externalAutomationTool = automationTools[name as AutomationToolName];
		if (externalAutomationTool) {
			return wrapToolWithMetaNotice(new LazyAgentTool(descriptor, externalAutomationTool, undefined, session));
		}
		const defer =
			effectiveDiscoveryMode !== "off" &&
			descriptor.metadata.loadMode === "discoverable" &&
			!selectedDiscoveredNames.has(name.toLowerCase());
		if (defer) {
			return wrapToolWithMetaNotice(
				new LazyAgentTool(descriptor, undefined, () => descriptor.load(session), session),
			);
		}
		const materialized = await logger.time(`createTools:${name}`, descriptor.load, session);
		return materialized
			? wrapToolWithMetaNotice(new LazyAgentTool(descriptor, materialized, undefined, session))
			: null;
	};
	const tools: LazyAgentTool[] = [];
	for (const entry of baseEntries) {
		const materialized = await materialize(entry);
		if (materialized) tools.push(materialized);
	}
	if (!tools.some(tool => tool.name === "resolve")) {
		const resolveDescriptor = HIDDEN_TOOL_DESCRIPTORS.resolve;
		const resolveTool = await logger.time("createTools:resolve", resolveDescriptor.load, session);
		if (resolveTool) {
			tools.push(wrapToolWithMetaNotice(new LazyAgentTool(resolveDescriptor, resolveTool, undefined, session)));
		}
	}

	return tools;
}
