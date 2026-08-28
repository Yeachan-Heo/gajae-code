import * as path from "node:path";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTelemetryConfig,
	type AgentTool,
	type AppendOnlyContextManager,
	INTENT_FIELD,
	ThinkingLevel,
} from "@gajae-code/agent-core";
import {
	type AssistantMessage,
	type AttemptScopeRef,
	type AuthCredentialSelector,
	type CredentialDisabledEvent,
	codexToolWireName,
	DEFAULT_MODEL_PER_PROVIDER,
	type KnownProvider,
	type Message,
	type Model,
	type ProviderSessionState,
	resolveOAuthStorageProvider,
	type SimpleStreamOptions,
	streamSimple,
	type ToolResultMessage,
} from "@gajae-code/ai/core";
import type { Component } from "@gajae-code/tui";
import {
	$flag,
	getAgentDbPath,
	getAgentDir,
	getProjectDir,
	getTrustedHomeDir,
	logger,
	postmortem,
	prompt,
	Snowflake,
} from "@gajae-code/utils";
import {
	createAppendOnlyContextManager,
	providerSupportsAppendOnlyAuto,
	resolveAppendOnlyMode,
} from "../append-only-mode";
import {
	type AsyncJob,
	AsyncJobManager,
	asyncJobEndpointId as deriveAsyncJobEndpointId,
	isBackgroundJobSupportEnabled,
	jobElapsedMs,
} from "../async";
import { resolveBrowserBackend } from "../browser-backend";
import { loadCapability, reset as resetCapabilities } from "../capability";
import { type Rule, ruleCapability, setActiveRules } from "../capability/rule";
import type { SourceMeta } from "../capability/types";
import { AUTOROUTING_INACTIVE_WARNING } from "../config/autorouting-contract";
import { resolveModelProfileName } from "../config/model-profile-contract";
import { resolveProfileBindings } from "../config/model-profiles";
import { kNoAuth, ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	parseModelPattern,
	parseModelString,
	resolveAllowedModels,
	resolveModelChainWithAuth,
	resolveModelRoleValue,
	type ScopedModelSelection,
} from "../config/model-resolver";
import { normalizeModelSelectorValue } from "../config/model-selector-value";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "../config/prompt-templates";
import { Settings, type SkillsSettings } from "../config/settings";
import { resolveEagerTaskDelegation } from "../config/task-delegation";
import { CursorExecHandlers } from "../cursor";
import { EditTool } from "../edit";
import type { MasterModeContext } from "../master-mode/context";
import { describeFoldReceipt } from "../session/fold-coordinator";
import type { BashRestrictionProfile } from "../tools/bash-allowed-prefixes";
import { SearchTool } from "../tools/search";
import "../discovery";
import { resolveConfigValue } from "../config/resolve-config-value";
import { getEmbeddedDefaultGjcSkills } from "../defaults/gjc-defaults";
import { BUNDLED_GROK_BUILD_EXTENSION_ID, getBundledGrokBuildExtensionFactory } from "../defaults/gjc-grok-cli";
import { initializeWithSettings, releaseSettingsScope } from "../discovery";
import { TtsrManager } from "../export/ttsr";
import type { CustomCommandsLoadResult, LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import {
	createCustomToolSettings,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	type ToolDefinition,
	wrapRegisteredTools,
} from "../extensibility/extensions";
import { ExtensionRuntime } from "../extensibility/extensions/loader";
import { type ConstrainedPluginHook, loadConstrainedPluginHooks } from "../extensibility/gjc-plugins/constrained-hooks";
import { resolveCurrentPhaseForParent } from "../extensibility/gjc-plugins/injection";
import { currentActivationFingerprint } from "../extensibility/gjc-plugins/lifecycle";
import {
	buildPluginMcpConfigs,
	getGjcPluginToolDeclarations,
	loadAlwaysOnPluginTools,
	renderAlwaysOnSystemAppendices,
} from "../extensibility/gjc-plugins/runtime-adapters";
import {
	GjcRuntimeFindingAccumulator,
	type GjcRuntimeSnapshotProvider,
	GjcRuntimeSnapshotStore,
	gjcActivationGenerationFor,
} from "../extensibility/gjc-plugins/runtime-quarantine";
import { loadActiveSubskillTools } from "../extensibility/gjc-plugins/tools";
import { discoverAndLoadHookExtensions } from "../extensibility/hooks/loader";
import { loadSkills, type Skill, type SkillWarning, setActiveSkills } from "../extensibility/skills";
import { type FileSlashCommand, loadSlashCommands } from "../extensibility/slash-commands";
import type { HindsightSessionState } from "../hindsight/state";
import { normalizePluginHook } from "../hooks/normalize";
import { initializeLocalRoot, LocalProtocolHandler, type LocalProtocolOptions } from "../internal-urls";
import { getMemoryRootForSession } from "../internal-urls/memory-protocol";
import type { LspStartupServerInfo } from "../lsp";
import { shutdownAll as shutdownAllLspClients } from "../lsp/client";
import { createMasterPeerSnapshotContributor, MASTER_PEER_SNAPSHOT_CUSTOM_TYPE } from "../master-mode/first-request";
import btwUserPrompt from "../prompts/system/btw-user.md" with { type: "text" };
import masterModeTemplate from "../prompts/system/master-mode.md" with { type: "text" };
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { createLazyService } from "../runtime/lazy-service";
import {
	createOptionalRuntimeServices,
	type OptionalRuntimeServicesOverrides,
} from "../runtime/optional-runtime-services";
import { loadAllMCPConfigs, MCPManager } from "../runtime-mcp";
import type { MCPServerConfig } from "../runtime-mcp/types";
import {
	getNotificationConfig,
	isGenericNotificationHostEligible,
	type NotificationConfig,
	SPAWN_PROVENANCE_ENV,
	shouldRegisterGenericNotificationsExtension,
} from "../sdk/bus/config";
import { createReconciliationStore, type ReconciliationStore } from "../sdk/bus/reconciliation-store";
import { NotificationSessionController } from "../sdk/bus/session-control";
import { shouldHostSdk } from "../sdk/host";
import { markAutoroutingInactive } from "../sdk/host/internal-autorouting-state";
import { createSdkSessionRuntimeExtension, registerSdkOnlyNotificationCommand } from "../sdk/host/session-runtime";
import { createSdkWebSocketTransport } from "../sdk/host/websocket-transport";
import type { SecretObfuscator } from "../secrets";
import * as secretApi from "../secrets";
import { AgentSession, type AgentSessionRescopeParticipant, type ForkContextSeed } from "../session/agent-session";
import { AuthBrokerClient, AuthStorage, RemoteAuthCredentialStore } from "../session/auth-storage";
import { type CustomMessage, convertToLlm } from "../session/messages";
import { createReadonlySessionManager, SessionManager } from "../session/session-manager";
import {
	parsePersistedCredentialSelector,
	resolveStartupAuthConfig,
	type StartupAuthConfigSnapshot,
} from "../session/startup-auth-config";
import {
	isOwnedCompletionEnvelopeAllowed,
	lookupOwnedRegistration,
	type OwnedCompletionEnvelope,
	retireOwnedRegistrationsForEndpoint,
	unregisterOwnedRegistration,
} from "../session/terminal-abort";
import { formatNoModelsAvailableFallback } from "../setup/model-onboarding-guidance";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
	loadProjectContextFilesResult as loadContextFilesResultInternal,
} from "../system-prompt";
import { AgentOutputManager } from "../task/output-manager";
import { parseThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "../thinking";
import { isMCPBridgeTool, selectRestorableDiscoveredBuiltinToolNames } from "../tool-discovery/tool-index";
import {
	type AutomationToolName,
	type AutomationTools,
	BUILTIN_TOOL_DESCRIPTORS,
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	HIDDEN_TOOLS,
	resolveEffectiveDiscoveryMode,
	type Tool,
	type ToolSession,
} from "../tools";
import { ToolContextStore } from "../tools/context";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { guardToolForUltragoalAsk } from "../tools/ultragoal-ask-guard";
import { EventBus } from "../utils/event-bus";
import { buildNamedToolChoice, buildNamedToolChoiceResult } from "../utils/tool-choice";
import type { WorkspaceTree } from "../workspace-tree";
import { createSessionLifecycleService } from "./lifecycle/client";
import {
	attachLifecycleStartupCapability,
	lifecycleMcpStartupTimeoutOption,
	lifecycleStartupCapabilityOption,
	type SdkStartupCapability,
} from "./startup-capability";

export type { AutomationToolName, AutomationTools } from "../tools";

type AsyncResultEntry = {
	jobId: string;
	generation: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
	/** Exact owned-completion origin when the job is registered left-running work of a terminal turn. */
	ownedCompletion?: OwnedCompletionEnvelope;
};

type AsyncResultJobDetails = {
	jobId: string;
	type?: "bash" | "task";
	label?: string;
	durationMs?: number;
};

type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
	/** Private origin envelope(s); absent = ordinary delivery. Never a public field. */
	ownedCompletions?: OwnedCompletionEnvelope[];
};

type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

/** Capture the cursor edit grant before the model-facing edit entry is removed. */
export function captureCursorEditTool<T>(
	toolRegistry: ReadonlyMap<string, unknown>,
	createReplaceTool: () => T,
): T | undefined {
	return toolRegistry.has("edit") ? createReplaceTool() : undefined;
}

function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	// Partition denied owned-completion entries out ENTIRELY before batch
	// construction (AC 36 zero final calls from stopped work): a denied entry —
	// owned scope, forged tuple, or vanished scope — must never reach
	// followUp/prompt, even inside a mixed batch. Allowed owned-completion and
	// ordinary entries are delivered normally.
	const survivors = entries.filter(
		entry => entry.ownedCompletion === undefined || isOwnedCompletionEnvelopeAllowed(entry.ownedCompletion),
	);
	// Denied entries never reach followUp/prompt (AC 36), so no later
	// settlement boundary sees them — retire their terminal tuples HERE,
	// otherwise an owned_unsettled abort's later completion keeps occupying
	// the global registration and retained-policy capacities (review P2).
	const denied = entries.filter(
		(entry): entry is AsyncResultEntry & { ownedCompletion: OwnedCompletionEnvelope } =>
			entry.ownedCompletion !== undefined && !isOwnedCompletionEnvelopeAllowed(entry.ownedCompletion),
	);
	if (denied.length > 0) {
		// Resolve the manager from the registration's OWN endpoint: the
		// process-global instance is the last-created session, so when B's
		// manager is global with the same local job id still running, the
		// terminality check would observe B's running job and refuse to
		// unregister A's already-terminal tuple (review thread P2).
		const manager =
			AsyncJobManager.forEndpoint(denied[0]?.ownedCompletion.registration.endpointId) ?? AsyncJobManager.instance();
		for (const entry of denied) {
			const registration = entry.ownedCompletion.registration;
			const job = manager?.getJob(registration.jobId);
			const status = job?.generation === registration.jobGeneration ? job?.status : undefined;
			if (job === undefined || status === "completed" || status === "cancelled" || status === "failed") {
				unregisterOwnedRegistration(registration);
			}
		}
	}
	if (survivors.length === 0) return null;
	const jobs = survivors.map(entry => ({
		jobId: entry.jobId,
		result: entry.result,
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
	}));
	const ownedCompletions = survivors
		.filter(
			(entry): entry is AsyncResultEntry & { ownedCompletion: OwnedCompletionEnvelope } =>
				entry.ownedCompletion !== undefined,
		)
		.map(entry => entry.ownedCompletion);
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
		})),
		// Private origin envelope for the AgentSession injector; absent for
		// ordinary deliveries. Only ALLOWED owned-completion entries survive
		// partitioning, so the injector never sees a denied envelope here.
		...(ownedCompletions.length > 0 ? { ownedCompletions } : {}),
	};
	return {
		role: "custom",
		customType: "async-result",
		content: prompt.render(asyncResultTemplate, {
			multiple: jobs.length > 1,
			jobs,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

/**
 * Reconcile a resumed transcript that ends on an unpaired tool call.
 *
 * When a subagent finishes by calling `yield` (or any turn is torn down right
 * after a tool executes), the terminating abort can land before the tool
 * result is persisted, leaving the saved session ending on an assistant
 * `toolCall` with no matching `toolResult`. Replaying that history verbatim on
 * resume produces an invalid provider request (a tool_use not followed by a
 * tool_result) and the resumed turn fails immediately. Synthesize a placeholder
 * result for any such trailing unpaired tool call so a resumed session always
 * starts from a valid, paired history. No-op for well-formed transcripts.
 */
/** Whether the cached SDK-only reconciliation store still matches the current
 *  session identity. session_switch/session_branch can move to a DIFFERENT
 *  transcript that retains the same copied session id, so the cache is keyed
 *  by BOTH the session id and the session-file path (including a null-to-file
 *  transition); a mismatch means the store must be recreated or the successor
 *  reads/writes the predecessor's reconciliation file (review thread P2). */
export function sdkOnlyStoreMatches(
	cached: { sessionId: string; sessionFile: string | undefined } | undefined,
	sessionId: string,
	sessionFile: string | undefined,
): boolean {
	return cached !== undefined && cached.sessionId === sessionId && cached.sessionFile === sessionFile;
}

export function reconcileTrailingToolCalls(messages: AgentMessage[]): AgentMessage[] {
	let lastAssistantIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			lastAssistantIdx = i;
			break;
		}
	}
	if (lastAssistantIdx === -1) return messages;
	const lastAssistant = messages[lastAssistantIdx] as AssistantMessage;
	const toolCalls = lastAssistant.content.filter(
		(part): part is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => part.type === "toolCall",
	);
	if (toolCalls.length === 0) return messages;
	const satisfied = new Set<string>();
	for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "toolResult") satisfied.add(message.toolCallId);
	}
	const missing = toolCalls.filter(toolCall => !satisfied.has(toolCall.id));
	if (missing.length === 0) return messages;
	const now = Date.now();
	const synthesized: ToolResultMessage[] = missing.map(toolCall => ({
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{
				type: "text",
				text: "Tool result was not persisted before the previous turn ended; synthesized on resume to keep tool_use/tool_result pairing valid.",
			},
		],
		details: {},
		isError: false,
		timestamp: now,
	}));
	return [...messages, ...synthesized];
}

function buildMcpNotificationBatchMessage(entries: McpNotificationEntry[]): AgentMessage | null {
	const resources: McpNotificationEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = `${entry.serverName}\0${entry.uri}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resources.push(entry);
	}
	if (resources.length === 0) return null;
	const lines = [`[MCP notification] ${resources.length} resource(s) updated:`];
	for (const resource of resources) {
		lines.push(`- server="${resource.serverName}" uri=${resource.uri}`);
	}
	lines.push('Use read(path="mcp://<uri>") to inspect if relevant.');
	return {
		role: "user",
		content: [{ type: "text", text: lines.join("\n") }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}

function sanitizeRosterLabel(value: string): string {
	const normalized = value
		.replace(/[\p{Cc}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > 48 ? `${normalized.slice(0, 47)}…` : normalized;
}

function humanizeAgentTaskId(id: string): string {
	return id
		.replace(/([a-z\d])([A-Z])/g, "$1 $2")
		.replace(/[-_]+/g, " ")
		.trim();
}

function resolveAgentRosterLabel(label: string | undefined, agentId: string, displayName: string): string {
	return (
		sanitizeRosterLabel(label ?? "") ||
		sanitizeRosterLabel(humanizeAgentTaskId(agentId)) ||
		sanitizeRosterLabel(displayName)
	);
}
// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Global config directory. Default: ~/.gjc/agent */
	agentDir?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;
	/** @internal Allows the first-party CLI root to mutate its own registry and observe an admission attempt. */
	modelRegistryStartupMutation?: { owner: "cli-root"; onAttempt(): void };

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern string (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string;
	/** Active profile inherited by a nested SDK/subagent session. */
	activeModelProfile?: string;
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ThinkingLevel;
	/** Runtime substitution metadata for the initial model_change session event. */
	modelSubstitution?: { requestedModel: Model; reason: string };
	/** Models available for cycling (Alt+N in interactive mode) */
	scopedModels?: ScopedModelSelection[];

	/** System prompt blocks. Array replaces default, function receives default blocks and returns final blocks. */
	systemPrompt?: string[] | ((defaultPrompt: string[]) => string[]);
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;
	/** Optional credential-selection session identity, distinct from provider transport/cache identity. */
	credentialSessionId?: string;
	/** Runtime credential selector for multi-account auth pools. */
	credentialSelector?: { provider?: string; selector: AuthCredentialSelector; raw: string };
	/** Soft runtime credential preference; quota/rate-limit failures may rotate away from it. */
	preferredCredentialSelector?: { provider?: string; selector: AuthCredentialSelector; raw: string };
	/** Durable global pin intent loaded from startup-auth config; session bootstrap resolves it without mutating shared storage. */
	startupAuthConfig?: StartupAuthConfigSnapshot;

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/**
	 * Host-owned implementations for the built-in `browser` and `computer`
	 * surfaces. These are materialized as built-ins, retain built-in provenance
	 * and activation behavior, and receive cancellation through AgentTool's
	 * AbortSignal. A matching custom or extension tool is rejected.
	 */
	automationTools?: AutomationTools;
	/** Explicit parent/phase used to load active GJC sub-skill tools for this session. */
	gjcSubskillToolContext?: { parent: string; phase: string; sessionId?: string; cwd?: string };
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Explicit hook module paths to load in addition to native discovery. */
	hookPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Pre-loaded extensions (skips file discovery).
	 * @internal Used by CLI when extensions are loaded early to parse custom flags.
	 */
	preloadedExtensions?: LoadExtensionsResult;

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/** Skills. Default: bundled GJC defaults, plus filesystem skills when enabled */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/** Context files (AGENTS.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-built workspace tree (skips re-scanning; passed by parents to subagents). */
	workspaceTree?: WorkspaceTree;
	/** Prompt templates. Default: discovered from cwd/.gjc/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/** @deprecated MCP runtime discovery is quarantined and ignored. */
	enableMCP?: boolean;
	/** Existing MCP manager to reuse (skips discovery, propagates to toolSession).
	 * Mutually exclusive with mcpConfigPath. */
	mcpManager?: MCPManager;
	/** Load MCP tools for a top-level session only from this caller-owned absolute config file path.
	 * Mutually exclusive with mcpManager. */
	mcpConfigPath?: string;
	/**
	 * Whether conventional MCP autoload is enabled for a top-level standalone
	 * session (default: true). When false, native user `~/.gjc/agent/mcp.json`
	 * and project `.gjc/mcp.json` registrations are not discovered or connected
	 * at startup. Plugin-bundle MCPs and `mcpConfigPath` exact-file sessions
	 * are unaffected. CLI: `--no-mcp`.
	 */
	enableMcpAutoload?: boolean;
	/**
	 * Defer connecting an exact MCP config until the interactive UI is ready.
	 * @internal CLI-only startup optimization; SDK callers retain synchronous loading by default.
	 */
	deferMcpConfigStartup?: boolean;
	/** Process-local master authority. Never persist or pass to lifecycle children. */
	masterModeContext?: MasterModeContext;
	/**
	 * Defer memory backend startup until the caller has applied startup model profiles.
	 * @internal CLI-only ordering guard; SDK callers retain immediate startup by default.
	 */
	deferMemoryBackendStartup?: boolean;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Skip Python kernel availability check and prelude warmup */
	skipPythonPreflight?: boolean;
	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];

	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Current role-agent type/name for nested task sessions. */
	currentAgentType?: string;
	/** Parent Hindsight state to alias for subagent private memory backend compatibility. */
	parentHindsightSessionState?: HindsightSessionState;
	/** Pre-allocated agent identity for IRC routing. Default: "0-Main" for top-level, parentTaskPrefix-derived for sub. */
	agentId?: string;
	/** Display name for the agent in IRC. Default: "main" or "sub". */
	agentDisplayName?: string;
	/** Compact task label for hidden IRC roster reminders. */
	agentRosterLabel?: string;
	/** Optional restricted bash command prefixes for read-only role agents. */
	bashAllowedPrefixes?: string[];
	/** Restriction policy paired with bashAllowedPrefixes. */
	bashRestrictionProfile?: BashRestrictionProfile;
	/** Optional per-session restriction for goal tool operations. */
	goalToolAllowedOps?: readonly ("create" | "get" | "complete" | "resume" | "drop" | "pause")[];
	/** Optional per-session allowlist for tools exposed through search_tool_bm25. */
	discoverableToolAllowedNames?: readonly string[];
	/**
	 * Discoverable built-in tools that must stay in the initial active set even when
	 * `tools.discoveryMode === "all"` would otherwise hide them behind `search_tool_bm25`.
	 * Used for coordination tools (e.g. `irc`) that a subagent must be able to use
	 * immediately without first spending a discovery round-trip to find them.
	 */
	alwaysActiveToolNames?: readonly string[];
	/** Optional shared agent registry for IRC routing. Default: AgentRegistry.global(). */
	agentRegistry?: AgentRegistry;
	/** Parent task ID prefix for nested artifact naming (e.g., "6-Extensions") */
	parentTaskPrefix?: string;
	/** Parent manager borrowed by a child session; never disposed by the child. */
	inheritedAsyncJobManager?: AsyncJobManager;
	/**
	 * W6b: the parent's scope-held MCP facade, handed to a canonical sub-session so
	 * it can inherit always-on MCP tools without owning the manager. Replaces the
	 * removed `MCPManager.instance()` inheritance path; the sub-session never
	 * connects, registers callbacks, or disposes this manager.
	 */
	inheritedMcpManager?: import("../runtime-mcp/manager").MCPManager;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Override local:// protocol options for subagent local:// sharing. Default: uses the session's own artifacts dir and session ID. */
	localProtocolOptions?: LocalProtocolOptions;

	/** Settings instance. Default: a scope-local Settings.loadForScope({ cwd, agentDir }). */
	settings?: Settings;
	/** Internal/advanced runtime-service injection. Omitted services use session defaults. */
	runtimeServices?: OptionalRuntimeServicesOverrides;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;
	/** Whether this host mode can own a notification session endpoint. Default: true. */
	notificationHostModeSupported?: boolean;
	/** Whether this host mode can own the root SDK endpoint. Default: true. */
	sdkHostModeSupported?: boolean;
	/** Override configured Discord/Slack daemon readiness, primarily for embedded hosts and deterministic tests. */
	ensureNotificationProviderDaemon?: (provider: "discord" | "slack", settings: Settings) => Promise<unknown>;

	/**
	 * Opt-in OpenTelemetry instrumentation forwarded to the underlying Agent.
	 * Passing `{}` enables the loop's GenAI-semantic-convention spans. See
	 * {@link AgentTelemetryConfig} for the full surface (hooks, content capture,
	 * cost estimator, agent identity).
	 *
	 * Safe to enable without an OTEL SDK registered in the host: the
	 * `@opentelemetry/api` package returns a no-op tracer in that case.
	 */
	telemetry?: AgentTelemetryConfig;
	/** Optional fork-context seed used to initialize a child session before its first prompt. */
	forkContextSeed?: ForkContextSeed;
	/** Optional provider state override. Fork-context children should omit this by default. */
	providerSessionState?: Map<string, ProviderSessionState>;
	/** Cooperative pause checkpoint passed through to Agent. */
	shouldPause?: () => boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled or an exact tools-only config is session-owned) */
	mcpManager?: MCPManager;
	/** Starts a deferred exact-config MCP connection. Present only when deferMcpConfigStartup was requested. */
	startDeferredMcpConfig?: () => Promise<DeferredMcpConfigStartupResult>;
	/** Starts a deferred memory backend. Present only when deferMemoryBackendStartup was requested. */
	startDeferredMemoryBackend?: () => Promise<void>;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers configured for lazy startup in interactive mode */
	lspServers?: LspStartupServerInfo[];
	/** Shared event bus for tool/extension communication */
	eventBus: EventBus;
	/**
	 * Read-only view of GJC bundle runtime evidence for the activation generation
	 * this session published. Undefined when no GJC bundles participated.
	 */
	gjcRuntimeSnapshot?: GjcRuntimeSnapshotProvider;
}

export interface DeferredMcpConfigStartupResult {
	loadedToolCount: number;
	hasErrors: boolean;
}

// Re-exports

export type { PromptTemplate } from "../config/prompt-templates";
export { Settings, type SkillsSettings } from "../config/settings";
export type { CustomCommand, CustomCommandFactory } from "../extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "../extensibility/custom-tools/types";
export type * from "../extensibility/extensions";
export type { Skill } from "../extensibility/skills";
export type { FileSlashCommand } from "../extensibility/slash-commands";
export type { Tool } from "../tools";
export { buildDirectoryTree, buildWorkspaceTree, type DirectoryTree, type WorkspaceTree } from "../workspace-tree";

export { BUILTIN_TOOLS, createTools, HIDDEN_TOOLS, type ToolSession };

export async function loadSshTool(session: ToolSession) {
	return (await import("../tools/ssh")).loadSshTool(session);
}

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

// Discovery Functions

/**
 * Create an AuthStorage instance.
 *
 * Default: local SQLite store at `<agentDir>/agent.db`.
 *
 * Broker mode: when `GJC_AUTH_BROKER_URL` is set, credentials are pulled from
 * a remote auth-broker over the wire. Refresh tokens never leave the broker;
 * the client receives access tokens with `refresh = "__remote__"` and calls
 * back into the broker through the {@link AuthStorageOptions.refreshOAuthCredential}
 * override to re-mint access tokens when needed.
 */
export async function discoverAuthStorage(
	agentDir: string = getDefaultAgentDir(),
	startupAuth?: StartupAuthConfigSnapshot,
): Promise<AuthStorage> {
	const resolvedStartupAuth = startupAuth ?? (await resolveStartupAuthConfig(agentDir));
	const brokerConfig = resolvedStartupAuth.broker;
	const credentialRankingMode = resolvedStartupAuth.credentialRankingMode;
	if (brokerConfig) {
		const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("Auth broker returned no initial snapshot");
		const store = new RemoteAuthCredentialStore({ client, initialSnapshot: initialResult.snapshot });
		// Refresh + usage hooks live on RemoteAuthCredentialStore; AuthStorage
		// discovers them automatically when no explicit option overrides them.
		const storage = new AuthStorage(store, {
			configValueResolver: resolveConfigValue,
			sourceLabel: `broker ${brokerConfig.url}`,
			credentialRankingMode,
		});
		try {
			await storage.reload();
		} catch (error) {
			try {
				storage.close();
			} catch {
				// Preserve the initial reload failure.
			}
			throw error;
		}
		return storage;
	}
	const dbPath = getAgentDbPath(agentDir);
	const storage = await AuthStorage.create(dbPath, {
		configValueResolver: resolveConfigValue,
		sourceLabel: `local ${dbPath}`,
		credentialRankingMode,
	});
	try {
		await storage.reload();
	} catch (error) {
		try {
			storage.close();
		} catch {
			// Preserve the initial reload failure.
		}
		throw error;
	}
	return storage;
}

/** Ranking is resolved as part of the typed startup-auth snapshot. */

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(_cwd?: string): Promise<LoadExtensionsResult> {
	return { extensions: [], errors: [], runtime: new ExtensionRuntime() };
}

/**
 * Discover skills from cwd and agentDir.
 */
export async function discoverSkills(
	_cwd?: string,
	_agentDir?: string,
	_settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return { skills: [], warnings: [] };
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	agentDir?: string,
	settings?: Settings,
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir,
		settings,
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getDefaultAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(
	cwd?: string,
	agentDir?: string,
	settings?: Settings,
): Promise<FileSlashCommand[]> {
	return await loadSlashCommands({ cwd: cwd ?? getProjectDir(), agentDir, settings });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(_cwd?: string, _agentDir?: string): Promise<CustomCommandsLoadResult> {
	return { commands: [], errors: [] };
}

// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	agentDir?: string;
	settings?: Settings;
	appendPrompt?: string;
	repeatToolDescriptions?: boolean;
}

/**
 * Build the default provider-facing system prompt blocks.
 *
 * The returned `systemPrompt` preserves the stable harness prompt and dynamic project context
 * as separate entries so providers can cache prompt prefixes without concatenating blocks.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settings: options.settings,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		repeatToolDescriptions: options.repeatToolDescriptions,
	});
}

// Internal Helpers

function createCustomToolContext(ctx: ExtensionContext): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		settings: ctx.settings ? createCustomToolSettings(ctx.settings) : undefined,
		get credentialSessionId() {
			return ctx.credentialSessionId;
		},
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
	};
}

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// To distinguish, we mark converted tools with a hidden symbol property.
	// If the tool doesn't have this marker, it's a CustomTool that needs conversion.
	return !(tool as any).__isToolDefinition;
}

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

/*
 * Append-only context-mode resolution + manager construction live in
 * ./append-only-mode so the initial build, the runtime model/setting-change
 * path, and the status UI share one implementation. Re-exported for importers/tests.
 */
export { createAppendOnlyContextManager, providerSupportsAppendOnlyAuto, resolveAppendOnlyMode };

function customToolToDefinition(tool: CustomTool): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		concurrency: tool.concurrency,
		hidden: tool.hidden,
		deferrable: tool.deferrable,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx), signal),
		onSession: tool.onSession ? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx)) : undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					// Return empty component if undefined to match Component type requirement
					return component ?? ({ render: () => [] } as unknown as Component);
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	return definition;
}

function createCustomToolsExtension(tools: CustomTool[]): ExtensionFactory {
	return api => {
		for (const tool of tools) {
			api.registerTool(customToolToDefinition(tool));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of tools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: safeErrorForLog(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_compaction_start", async (event, ctx) =>
			runOnSession({ reason: "auto_compaction_start", trigger: event.reason, action: event.action }, ctx),
		);
		api.on("auto_compaction_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_end",
					action: event.action,
					result: event.result,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					unbounded: event.unbounded,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}

export function createPluginHooksExtension(hooks: ConstrainedPluginHook[]): ExtensionFactory {
	return api => {
		const normalizedHooks = hooks.map(hook => ({
			hook,
			result: normalizePluginHook({
				declaredEvent: hook.event,
				target: hook.target,
				phase: hook.phase,
				plugin: hook.plugin,
				source: `plugin:${hook.plugin}`,
			}),
		}));
		const diagnostics = normalizedHooks.flatMap(entry => entry.result.diagnostics);
		if (normalizedHooks.some(entry => !entry.result.hook)) {
			throw new Error(diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join("; "));
		}

		for (const { hook, result } of normalizedHooks) {
			const normalized = result.hook;
			if (!normalized) throw new Error("Hook normalization invariant violated");
			const registrationEvent = normalized.runtimeEvent;
			const target = normalized.toolName === "*" ? undefined : normalized.toolName;
			const handler = target
				? (event: { toolName?: string; tool?: { name?: string }; name?: string }, ...rest: unknown[]) => {
						const toolName = event?.toolName ?? event?.tool?.name ?? event?.name;
						if (toolName !== target) return undefined;
						return (hook.handler as (...a: unknown[]) => unknown)(event, ...rest);
					}
				: hook.handler;
			(api.on as (event: string, handler: (...args: unknown[]) => unknown) => void)(registrationEvent, handler);
		}
	};
}

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}
/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@gajae-code/ai/core';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'Anthropic model-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: ['You are helpful.'],
 *   tools: codingTools({ cwd: getProjectDir() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */

function withEmbeddedDefaultGjcSkills(skills: Skill[]): Skill[] {
	const byName = new Map<string, Skill>();
	for (const skill of skills) {
		const key = skill.name.toLowerCase();
		if (!byName.has(key)) byName.set(key, skill);
	}
	// The four public GJC workflow skills are a product invariant: even if a
	// caller-supplied or filesystem skill shares a name, the bundled definition
	// wins so workflow routing can never be silently hijacked.
	for (const defaultSkill of getEmbeddedDefaultGjcSkills()) {
		byName.set(defaultSkill.name.toLowerCase(), defaultSkill);
	}
	return [...byName.values()];
}

/**
 * Intent tracing (`_i`) is a model-facing reasoning aid, not a UI feature: it
 * makes the model state a tool call's purpose before the call executes, and the
 * loop turns that string into `tool_execution_start.intent` for every consumer
 * (TUI transcript, ACP `tool_call.title`, telemetry, session dumps).
 *
 * The per-call token cost is only worth forcing on the operator-facing session,
 * so canonical sub-sessions (role agents spawned through `task`) stay omitted.
 * Surface shape must not decide this — an ACP or print-mode top-level session is
 * the same conversation the operator would have run in the TUI.
 */
export function resolveIntentTracingEnabled(
	intentTracingSetting: boolean | undefined,
	options: { subSession: boolean },
): boolean {
	return (!!intentTracingSetting || $flag("PI_INTENT_TRACING")) && !options.subSession;
}

const MCP_CONFIG_PATH_AND_MANAGER_ERROR = "mcpConfigPath and mcpManager are mutually exclusive";
const MCP_CONFIG_PATH_ABSOLUTE_ERROR = "mcpConfigPath requires an absolute path";
const MCP_TOOLS_ONLY_MANAGER_SUBSESSION_ERROR = "tools-only MCP managers cannot be reused in sub-sessions";
const MCP_CONFIG_PATH_SUBSESSION_ERROR = "mcpConfigPath cannot be used in sub-sessions";
const MAX_EXACT_MCP_TOOL_COLLISION_NAMES = 10;
const DEFERRED_MCP_CONFIG_STARTUP_ERROR = "MCP tools could not be loaded.";
const MAX_EXACT_MCP_TOOL_NAME_LENGTH = 100;
const pluginMcpManagerServers = new WeakMap<MCPManager, ReadonlySet<string>>();
const conventionalMcpManagerServers = new WeakMap<MCPManager, ReadonlySet<string>>();

class ExactMcpToolNameCollisionError extends Error {
	constructor(toolNames: Iterable<string>) {
		const names = [...new Set(toolNames)]
			.sort()
			.slice(0, MAX_EXACT_MCP_TOOL_COLLISION_NAMES)
			.map(name => name.slice(0, MAX_EXACT_MCP_TOOL_NAME_LENGTH));
		super(`Exact MCP tool name collision: ${names.join(", ")}`);
	}
}

class McpManagerCleanupError extends Error {
	readonly code = "MCP_MANAGER_CLEANUP_FAILED";
	constructor(cause: unknown) {
		super(`Owned MCP manager cleanup failed: ${safeErrorDescription(cause)}`, { cause });
		this.name = "McpManagerCleanupError";
	}
}

class McpManagerCleanupDiagnosticError extends Error {
	readonly code = "MCP_MANAGER_CLEANUP_FAILED";
	readonly primaryError: unknown;
	readonly cleanupDiagnostic: { code: "MCP_MANAGER_CLEANUP_FAILED"; cause: unknown };
	constructor(primaryError: unknown, cleanupError: unknown) {
		super(safeErrorDescription(primaryError), { cause: primaryError });
		this.name = "McpManagerCleanupDiagnosticError";
		this.primaryError = primaryError;
		this.cleanupDiagnostic = { code: "MCP_MANAGER_CLEANUP_FAILED", cause: cleanupError };
	}
}

function safeErrorDescription(value: unknown): string {
	let isError = false;
	try {
		isError = value instanceof Error;
	} catch {
		// Hostile proxies can throw from getPrototypeOf during instanceof.
	}
	if (isError) {
		try {
			const message = (value as { message?: unknown }).message;
			if (typeof message === "string") return message;
		} catch {
			// Hostile error getters must not replace the primary failure.
		}
	}
	try {
		return String(value);
	} catch {
		return "<unprintable error>";
	}
}

function safeIsInstanceOf<T extends object>(value: unknown, ctor: abstract new (...args: any[]) => T): boolean {
	try {
		return value instanceof ctor;
	} catch {
		return false;
	}
}

function safeReadProperty(value: unknown, key: string): unknown {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
	try {
		return (value as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}

function safeCleanupDiagnosticForLog(value: unknown): { code: string; cause: string } | undefined {
	if (value === undefined) return undefined;
	const code = safeReadProperty(value, "code");
	const nestedCause = safeReadProperty(value, "cause");
	return {
		code: typeof code === "string" ? code : "MCP_MANAGER_CLEANUP_FAILED",
		cause: safeErrorDescription(nestedCause === undefined ? value : nestedCause),
	};
}
function safeReadCleanupDiagnostic(value: unknown): unknown {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
	try {
		return (value as { cleanupDiagnostic?: unknown }).cleanupDiagnostic;
	} catch {
		return undefined;
	}
}

function safeErrorForLog(value: unknown): unknown {
	return safeErrorDescription(value);
}

function sanitizeProviderForLog(provider: string): string {
	const sanitized = provider.replace(/[^\x20-\x7e]/g, "?").slice(0, 128);
	return sanitized.length > 0 ? sanitized : "<empty>";
}

function attachMcpCleanupDiagnostic(primary: unknown, cleanup: unknown): unknown {
	const diagnostic = { code: "MCP_MANAGER_CLEANUP_FAILED" as const, cause: cleanup };
	if (primary && (typeof primary === "object" || typeof primary === "function")) {
		try {
			Object.defineProperty(primary, "cleanupDiagnostic", {
				value: diagnostic,
				enumerable: false,
				configurable: true,
			});
			const attached = safeReadCleanupDiagnostic(primary);
			if (attached === diagnostic) return primary;
		} catch {
			// Frozen/proxy errors cannot carry an own diagnostic; preserve both through a typed wrapper.
		}
	}
	return new McpManagerCleanupDiagnosticError(primary, cleanup);
}

function findExactMcpToolNameCollisions(
	exactMcpToolNames: readonly string[],
	catalogToolNames: Iterable<string>,
): string[] {
	const exactMcpToolNameCounts = new Map<string, number>();
	for (const toolName of exactMcpToolNames) {
		exactMcpToolNameCounts.set(toolName, (exactMcpToolNameCounts.get(toolName) ?? 0) + 1);
	}
	const catalogToolNameCounts = new Map<string, number>();
	for (const toolName of catalogToolNames) {
		catalogToolNameCounts.set(toolName, (catalogToolNameCounts.get(toolName) ?? 0) + 1);
	}
	const collisions: string[] = [];
	for (const [toolName, exactMcpToolNameCount] of exactMcpToolNameCounts) {
		if (exactMcpToolNameCount > 1 || (catalogToolNameCounts.get(toolName) ?? 0) > 1) {
			collisions.push(toolName);
		}
	}
	return collisions;
}

function findDeferredExactMcpToolNameCollisions(
	exactMcpToolNames: readonly string[],
	catalogToolNames: Iterable<string>,
): string[] {
	const catalog = new Set(catalogToolNames);
	const seen = new Set<string>();
	const collisions = new Set<string>();
	for (const toolName of exactMcpToolNames) {
		if (catalog.has(toolName) || seen.has(toolName)) collisions.add(toolName);
		seen.add(toolName);
	}
	return [...collisions];
}

/**
 * Order candidates so each known provider's curated default model is tried
 * before the rest of the catalog.
 *
 * Provider catalogs are not ranked by fitness — a withdrawn model whose ID
 * carries an older date suffix sorts ahead of its current replacement — so
 * picking the first credentialed entry can start an unconfigured install on a
 * model the provider no longer serves. `DEFAULT_MODEL_PER_PROVIDER` is the
 * curated table `findInitialModel` already sweeps for the same purpose;
 * reusing it keeps both unconfigured paths on one source of truth. Candidates
 * that are not a provider default keep their original relative order.
 */
export function orderByProviderDefaultFirst(
	candidates: readonly Model[],
	providerOrder: readonly string[] = Object.keys(DEFAULT_MODEL_PER_PROVIDER),
): Model[] {
	const preferred: Model[] = [];
	const rest: Model[] = [];
	const preferredCandidates = new Set<Model>();
	const seenProviders = new Set<string>();
	for (const rawProvider of [...providerOrder, ...Object.keys(DEFAULT_MODEL_PER_PROVIDER)]) {
		const provider = rawProvider.trim().toLowerCase();
		if (!provider || seenProviders.has(provider) || !(provider in DEFAULT_MODEL_PER_PROVIDER)) continue;
		seenProviders.add(provider);
		const defaultId = DEFAULT_MODEL_PER_PROVIDER[provider as KnownProvider];
		for (const candidate of candidates) {
			if (candidate.provider.trim().toLowerCase() === provider && candidate.id === defaultId) {
				preferred.push(candidate);
				preferredCandidates.add(candidate);
			}
		}
	}
	if (preferred.length === 0) return [...candidates];
	for (const candidate of candidates) {
		if (!preferredCandidates.has(candidate)) rest.push(candidate);
	}
	return [...preferred, ...rest];
}

const AUTOMATION_TOOL_NAMES = new Set<AutomationToolName>(["browser", "computer"]);

function validateAutomationTools(options: CreateAgentSessionOptions): AutomationTools {
	const automationTools = options.automationTools ?? {};
	const entries = Object.entries(automationTools);
	for (const [name, tool] of entries) {
		if (!AUTOMATION_TOOL_NAMES.has(name as AutomationToolName)) {
			throw new Error(`Unsupported SDK automation tool name: ${name}`);
		}
		if (!tool || tool.name !== name) {
			throw new Error(`SDK automation tool ${name} must expose the built-in name ${JSON.stringify(name)}`);
		}
	}
	const externalNames = new Set(entries.map(([name]) => name));
	const collisions = [
		...new Set((options.customTools ?? []).map(tool => tool.name).filter(name => externalNames.has(name))),
	];
	if (collisions.length > 0) {
		throw new Error(`SDK automation tools cannot collide with custom tools: ${collisions.join(", ")}`);
	}
	return automationTools;
}

export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const automationTools = validateAutomationTools(options);
	const masterModeContext = options.masterModeContext;
	const lifecycleStartupCapability = (
		options as CreateAgentSessionOptions & { [lifecycleStartupCapabilityOption]?: SdkStartupCapability }
	)[lifecycleStartupCapabilityOption];
	// ACP lifecycle launches carry their own MCP startup budget; every other
	// consumer keeps the manager's short default ceiling.
	const lifecycleMcpStartupTimeoutMs = (
		options as CreateAgentSessionOptions & { [lifecycleMcpStartupTimeoutOption]?: number }
	)[lifecycleMcpStartupTimeoutOption];
	const isCanonicalSubSession =
		(options.taskDepth ?? 0) > 0 || Boolean(options.parentTaskPrefix) || Boolean(options.currentAgentType);
	if (isCanonicalSubSession && options.mcpConfigPath !== undefined) {
		throw new Error(MCP_CONFIG_PATH_SUBSESSION_ERROR);
	}
	if (options.mcpConfigPath !== undefined && options.mcpManager !== undefined) {
		throw new Error(MCP_CONFIG_PATH_AND_MANAGER_ERROR);
	}
	if (options.mcpConfigPath !== undefined && !path.isAbsolute(options.mcpConfigPath)) {
		throw new Error(MCP_CONFIG_PATH_ABSOLUTE_ERROR);
	}
	if (isCanonicalSubSession && options.mcpManager?.isToolsOnly()) {
		throw new Error(MCP_TOOLS_ONLY_MANAGER_SUBSESSION_ERROR);
	}
	if (isCanonicalSubSession && options.inheritedMcpManager?.isToolsOnly()) {
		throw new Error(MCP_TOOLS_ONLY_MANAGER_SUBSESSION_ERROR);
	}
	const cwd = options.cwd ?? getProjectDir();
	const explicitMcpConfigPath = !isCanonicalSubSession && !options.mcpManager ? options.mcpConfigPath : undefined;
	const agentDir = options.agentDir ?? options.settings?.getAgentDir() ?? getDefaultAgentDir();
	const eventBus = options.eventBus ?? new EventBus();
	const hasInjectedAuth = options.authStorage !== undefined || options.modelRegistry !== undefined;

	// Pin authStorage to modelRegistry.authStorage: ModelRegistry.getApiKey() routes refresh
	// failures through that instance, so any divergent storage handed to the bridge / mcpManager
	// / session would silently miss credential_disabled events.
	// Injected auth is already the caller's authority; do not discover global
	// startup auth or apply persistent pins while constructing this session.
	const startupAuthConfig = hasInjectedAuth
		? undefined
		: (options.startupAuthConfig ?? (await resolveStartupAuthConfig(agentDir)));
	const ownsModelRegistry = options.modelRegistry === undefined;
	const ownsAuthStorage = options.modelRegistry === undefined && options.authStorage === undefined;
	const authStorage =
		options.modelRegistry?.authStorage ??
		options.authStorage ??
		(await logger.time("discoverModels", () => discoverAuthStorage(agentDir, startupAuthConfig)));
	const ownsScopedSettings = options.settings === undefined;
	let settings = options.settings ?? (await logger.time("settings", Settings.loadForScope, { cwd, agentDir }));
	const initialOwnedSettings = ownsScopedSettings ? settings : undefined;
	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), settings, { agentDir });
	const authStorageOwner = modelRegistry.getAuthStorageOwner();
	if (options.authStorage && options.authStorage !== authStorage) {
		throw new Error(
			"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
		);
	}

	let agent: Agent;
	let sessionAgent: Agent | undefined;
	let session!: AgentSession;
	let sessionManager!: SessionManager;
	let hasSession = false;
	let processCwdClaimed = false;
	let hasRegistered = false;
	let asyncJobManager: AsyncJobManager | undefined;
	let asyncJobManagerAdmitted = false;
	let priorAsyncJobManager: AsyncJobManager | undefined;
	let cleanupOwnedMcpManager: (() => Promise<void>) | undefined;
	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	const resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID;
	const resolvedAgentDisplayName = options.agentDisplayName ?? (isCanonicalSubSession ? "sub" : "main");
	const resolvedAgentRosterLabel = resolveAgentRosterLabel(
		options.agentRosterLabel,
		resolvedAgentId,
		resolvedAgentDisplayName,
	);
	const evalKernelOwnerId = `agent-session:${Snowflake.next()}`;
	let disposeLocalProtocolOverride: (() => void) | undefined;
	let localProtocolOverrideReleased = false;
	const releaseLocalProtocolOverride = (): void => {
		if (localProtocolOverrideReleased) return;
		localProtocolOverrideReleased = true;
		disposeLocalProtocolOverride?.();
	};
	const enableLsp = options.enableLsp ?? true;
	let authStorageClosed = false;
	let credentialScopeId: string | undefined;
	let credentialScopeLeased = false;
	let closeOwnedSettings: () => Promise<void> = async () => {};
	const closeOwnedAuthStorage = async (): Promise<void> => {
		if (ownsModelRegistry) await modelRegistry.dispose();
		if (!hasSession && credentialScopeLeased && credentialScopeId) {
			authStorage.releaseCredentialScope(credentialScopeId);
			credentialScopeLeased = false;
		}
		if (!ownsAuthStorage || authStorageClosed) return;
		authStorageClosed = true;
		authStorage.close();
	};
	let unsubscribeCredentialDisabled: (() => void) | undefined;
	const releaseCredentialDisabledSubscription = (): void => {
		const unsubscribe = unsubscribeCredentialDisabled;
		unsubscribeCredentialDisabled = undefined;
		unsubscribe?.();
	};

	try {
		// Subscribe before any getApiKey() call so startup model probes can't fire a
		// credential_disabled event past us. An embedder's constructor handler makes the
		// listener set non-empty from construction, which defeats AuthStorage's no-listener
		// buffer — so we can't rely on it to catch startup events for the extension runner.
		const startupCredentialDisabledEvents: CredentialDisabledEvent[] = [];
		let credentialDisabledTarget: ExtensionRunner | undefined;
		unsubscribeCredentialDisabled = authStorage.onCredentialDisabled(event => {
			if (credentialDisabledTarget) {
				// Discard return: any handler error is routed through runner.onError listeners.
				void credentialDisabledTarget.emitCredentialDisabled(event);
			} else {
				startupCredentialDisabledEvents.push(event);
			}
		});
		const applyCredentialSelector = (scopeId: string, provider: string, selector: AuthCredentialSelector): void => {
			authStorage.setSessionCredentialSelector(scopeId, provider, selector, authStorageOwner);
		};
		const ownsScopedSettings = options.settings === undefined;
		let settings = options.settings ?? (await logger.time("settings", Settings.loadForScope, { cwd, agentDir }));
		if (ownsModelRegistry) modelRegistry.setScopedSettings(settings);
		const initialOwnedSettings = ownsScopedSettings ? settings : undefined;
		const autoroutingInactive =
			settings.get("task.autorouting.enabled") === true && !settings.getEffectiveAutorouting().active;
		closeOwnedSettings = async (): Promise<void> => {
			if (!ownsScopedSettings) return;
			try {
				await settings.close();
			} finally {
				releaseSettingsScope(settings);
				if (initialOwnedSettings && initialOwnedSettings !== settings) {
					await initialOwnedSettings.close();
					releaseSettingsScope(initialOwnedSettings);
				}
			}
		};
		// Cwd-derived runtime state must follow a rescope (`move_session`, `/move`),
		// so services resolve the LIVE session cwd per activation instead of
		// capturing the launch root. Before the manager exists the launch cwd is the
		// only truth available, and it is also the manager's initial cwd.
		let liveSessionManager: SessionManager | undefined;
		const getLiveCwd = (): string => liveSessionManager?.getCwd() ?? cwd;
		const runtimeServices = createOptionalRuntimeServices(settings, options.runtimeServices, { cwd: getLiveCwd });
		modelRegistry.setScopedSettings(settings);
		modelRegistry.applyConfiguredModelBindings(settings);
		logger.time("initializeWithSettings", initializeWithSettings, settings);
		const startupModelReference =
			options.model === undefined
				? options.modelPattern
					? parseModelString(options.modelPattern)
					: undefined
				: options.modelRegistryStartupMutation?.owner === "cli-root"
					? { provider: options.model.provider, id: options.model.id }
					: undefined;
		const startupRegistryMutationAuthorized =
			options.modelRegistry === undefined || options.modelRegistryStartupMutation?.owner === "cli-root";
		const startupCredentialSelector =
			startupModelReference &&
			options.credentialSelector &&
			(!options.credentialSelector.provider ||
				options.credentialSelector.provider.toLowerCase() === startupModelReference.provider.toLowerCase())
				? options.credentialSelector.selector
				: undefined;
		const startupCredentialProviderMismatch =
			startupModelReference !== undefined &&
			options.credentialSelector?.provider !== undefined &&
			options.credentialSelector.provider.toLowerCase() !== startupModelReference.provider.toLowerCase();
		const attemptedStartupCacheAdmission =
			startupModelReference !== undefined &&
			startupRegistryMutationAuthorized &&
			options.credentialSelector !== undefined &&
			modelRegistry.requiresStoredLiteralCredentialCacheAdmission(
				startupModelReference.provider,
				startupModelReference.id,
			);
		if (attemptedStartupCacheAdmission) options.modelRegistryStartupMutation?.onAttempt();
		if (startupModelReference && startupCredentialSelector) {
			if (attemptedStartupCacheAdmission) {
				modelRegistry.admitCachedProviderForStoredLiteralCredential(
					startupModelReference.provider,
					startupCredentialSelector,
				);
			}
		}
		if (!options.modelRegistry && !attemptedStartupCacheAdmission) {
			modelRegistry.refreshInBackground();
		}
		// Resolve the workspace tree through its runtime service. The compatibility
		// default starts the native scan at the legacy startup trigger; lazy mode
		// leaves the service idle until the first-turn prompt barrier. The native scan
		// returns both rendered-tree input and the AGENTS.md directory-context index.
		const STARTUP_SCAN_DEADLINE_MS = 5000;
		const workspaceTreeMode = settings.get("workspaceTree.mode");
		const emptyWorkspaceTree: WorkspaceTree = {
			rootPath: path.resolve(cwd),
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		};
		let workspaceTreePromise: Promise<WorkspaceTree> = options.workspaceTree
			? Promise.resolve(options.workspaceTree)
			: workspaceTreeMode === "lazy"
				? Promise.resolve(emptyWorkspaceTree)
				: logger.time("buildWorkspaceTree", () =>
						runtimeServices.workspaceTree.get("legacy-startup").then(runtime => runtime.snapshot),
					);
		workspaceTreePromise.catch(() => {});

		// Independent discoveries that depend only on cwd/agentDir — kicked off in parallel and awaited
		// at their respective consumer sites. Their work can overlap with model resolution, secret loading,
		// session-context build, tool creation, MCP discovery, and extension discovery.
		const contextFilesResultPromise = options.contextFiles
			? Promise.resolve({ contextFiles: options.contextFiles, warnings: [] })
			: logger.time("discoverContextFiles", loadContextFilesResultInternal, { cwd, agentDir, settings });
		contextFilesResultPromise.catch(() => {});
		const promptTemplatesPromise = options.promptTemplates
			? Promise.resolve(options.promptTemplates)
			: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir);
		promptTemplatesPromise.catch(() => {});
		// SDK sessions do not implicitly activate local customization commands. Hosts
		// that want file-backed commands must provide them explicitly, keeping utility
		// surfaces free of ambient profile discovery.
		const slashCommandsPromise = Promise.resolve(options.slashCommands ?? []);
		slashCommandsPromise.catch(() => {});
		let slashCommands: FileSlashCommand[] = [];

		// Initialize provider preferences from settings
		const { getConfiguredSearchProviderPreference, setPreferredSearchProvider, setSearchFallbackProviders } =
			await import("../web/search/provider");
		const { isConfigurableSearchProviderId } = await import("../web/search/types");
		const { applyConfiguredSearchTimeout } = await import("../web/search/providers/utils");
		const webSearchProvider = getConfiguredSearchProviderPreference(settings);
		setPreferredSearchProvider(webSearchProvider);
		const webSearchFallback = settings.get("web_search.fallback");
		if (Array.isArray(webSearchFallback)) {
			setSearchFallbackProviders(
				webSearchFallback.filter(value => typeof value === "string" && isConfigurableSearchProviderId(value)),
			);
		}
		applyConfiguredSearchTimeout(settings);

		sessionManager =
			options.sessionManager ??
			(await logger.time("sessionManager", async () => {
				return SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
			}));
		liveSessionManager = sessionManager;
		const logicalSessionId = sessionManager.getSessionId();
		// Fork-context seeds carry conversation content only, never provider identity:
		// a shared continuity id would make concurrent subagents present the same
		// session_id upstream, where session-owning transports reject the extra
		// downstreams (owner_busy) and degrade those turns to uncached HTTP.
		const providerSessionId = options.providerSessionId ?? logicalSessionId;
		// AsyncJobManager ownership is distinct from both the persisted logical
		// header and provider cache affinity. Managed child transcripts may share a
		// logical header, while unrelated top-level sessions may intentionally share
		// providerSessionId. Bind explicit provider scopes to the independently
		// persisted transcript path so ownership is collision-free and stable across
		// detached resume; ordinary sessions keep the transition-aware logical id.
		const sessionFile = sessionManager.getSessionFile();
		const asyncJobEndpointId = deriveAsyncJobEndpointId(
			options.providerSessionId === undefined ? undefined : providerSessionId,
			logicalSessionId,
			sessionFile,
		);
		const credentialSessionId = options.credentialSessionId ?? providerSessionId;
		credentialScopeId = credentialSessionId;

		const scopeAlreadyLeased = authStorage.hasCredentialScopeLease(credentialSessionId);
		authStorage.acquireCredentialScope(credentialSessionId);
		credentialScopeLeased = true;
		const configuredPins = hasInjectedAuth ? {} : (startupAuthConfig?.credentialPins ?? {});
		const persistedPinStoreMatches =
			startupAuthConfig?.credentialPinStoreIdentity === startupAuthConfig?.credentialStoreIdentity;
		// AuthStorage has no scope-level "pinned but unavailable" marker. Keep the
		// discarded durable pin identity local to this credential scope so startup
		// config cannot immediately replace it with a different account; later
		// request-time resolution for this provider remains ordinary AUTO ranking.
		const staleDurableCredentialPins = new Set<string>();
		if (options.credentialSelector) {
			const provider = options.credentialSelector.provider ?? options.model?.provider;
			if (provider) applyCredentialSelector(credentialSessionId, provider, options.credentialSelector.selector);
		}
		const preferredCredentialProvider = options.preferredCredentialSelector
			? (options.preferredCredentialSelector.provider ??
				authStorage.resolveRuntimePreferredCredentialSelectorProvider(options.preferredCredentialSelector.selector))
			: undefined;
		if (options.preferredCredentialSelector && preferredCredentialProvider) {
			authStorage.setRuntimePreferredCredentialSelector(
				preferredCredentialProvider,
				options.preferredCredentialSelector.selector,
			);
		}
		const modelApiKeyAvailability = new Map<string, boolean>();
		const getModelAvailabilityKey = (candidate: Model): string =>
			`${candidate.provider}\u0000${candidate.baseUrl ?? ""}`;
		const hasModelApiKey = async (candidate: Model): Promise<boolean> => {
			const availabilityKey = getModelAvailabilityKey(candidate);
			const cached = modelApiKeyAvailability.get(availabilityKey);
			if (cached !== undefined) {
				return cached;
			}

			const credentialSelector = options.credentialSelector?.provider
				? undefined
				: options.credentialSelector?.selector;
			if (options.credentialSelector?.provider && options.credentialSelector.provider !== candidate.provider) {
				modelApiKeyAvailability.set(availabilityKey, false);
				return false;
			}
			// A preferred (soft) credential is always installed synchronously above, so
			// availability just needs to exclude candidates from a different provider —
			// `--prefer-credential` names one provider's account, and letting a
			// different-provider default model win here would silently strand the
			// preference.
			if (preferredCredentialProvider && preferredCredentialProvider !== candidate.provider) {
				modelApiKeyAvailability.set(availabilityKey, false);
				return false;
			}
			const key = await modelRegistry
				.getApiKey(candidate, credentialSessionId, { credentialSelector })
				.catch(error => {
					if (credentialSelector) {
						logger.debug("Credential selector did not match model availability candidate", {
							provider: candidate.provider,
							model: candidate.id,
							error: error instanceof Error ? error.message : String(error),
						});
						return undefined;
					}
					throw error;
				});
			const hasKey = Boolean(key) && (!credentialSelector || key !== kNoAuth);
			modelApiKeyAvailability.set(availabilityKey, hasKey);
			return hasKey;
		};

		// Load and create secret obfuscator early so resumed session state and prompt warnings
		// reflect actual loaded secrets, not just the setting toggle.
		let obfuscator: SecretObfuscator | undefined;
		let deobfuscateSessionContextFn: typeof import("../secrets").deobfuscateSessionContext | undefined;
		let obfuscateMessagesFn: typeof import("../secrets").obfuscateMessages | undefined;
		if (settings.get("secrets.enabled")) {
			const secrets = await import("../secrets");
			deobfuscateSessionContextFn = secrets.deobfuscateSessionContext;
			obfuscateMessagesFn = secrets.obfuscateMessages;
			const fileEntries = await logger.time("loadSecrets", secrets.loadSecrets, cwd, agentDir);
			const envEntries = secrets.collectEnvSecrets();
			const allEntries = [...envEntries, ...fileEntries];
			if (allEntries.length > 0) {
				obfuscator = secrets.createSecretObfuscator(allEntries);
			}
		}
		let secretsEnabled = obfuscator?.hasSecrets() === true;

		// Check if session has existing data to restore
		const existingSession = logger.time("loadSessionContext", () =>
			deobfuscateSessionContextFn
				? deobfuscateSessionContextFn(sessionManager.buildSessionContext(), obfuscator)
				: sessionManager.buildSessionContext(),
		);
		const existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
		const hasExistingSession = existingBranch.length > 0;
		const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
		const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

		for (const entry of existingBranch) {
			if (entry.type !== "custom" || entry.customType !== "auth-credential-pin") continue;
			const data = entry.data;
			if (!data || typeof data !== "object") continue;
			const record = data as {
				v?: unknown;
				scopeId?: unknown;
				provider?: unknown;
				pin?: unknown;
				credentialStoreIdentity?: unknown;
			};
			if (record.v !== 1 || record.scopeId !== credentialSessionId || typeof record.provider !== "string") continue;
			const pin = record.pin as { auto?: unknown; kind?: unknown; value?: unknown } | undefined;
			// Durable replay must never abort session startup: a pinned account may
			// have been removed, disabled, or deduplicated since the pin was written.
			// Pin identity is preserved by leaving the provider unpinned on failure —
			// never silently retarget to another account; the user re-pins or picks AUTO.
			try {
				if (pin?.auto === true) {
					authStorage.setSessionCredentialAuto(record.provider, credentialSessionId);
					staleDurableCredentialPins.delete(resolveOAuthStorageProvider(record.provider));
				} else if (
					pin &&
					(pin.kind === "id" || pin.kind === "email" || pin.kind === "account" || pin.kind === "project") &&
					typeof pin.value === "string"
				) {
					if (
						pin.kind === "id" &&
						(!startupAuthConfig?.credentialStoreIdentity ||
							record.credentialStoreIdentity !== startupAuthConfig.credentialStoreIdentity)
					) {
						throw new Error("Durable numeric credential pin authority changed");
					}
					authStorage.setSessionCredentialSelector(
						credentialSessionId,
						record.provider,
						{
							kind: pin.kind,
							value: pin.value,
						},
						authStorageOwner,
					);
					staleDurableCredentialPins.delete(resolveOAuthStorageProvider(record.provider));
				}
			} catch {
				// A newer stale pin must not leave an earlier replayed selector active.
				authStorage.clearSessionCredentialSelector(record.provider, credentialSessionId);
				staleDurableCredentialPins.add(resolveOAuthStorageProvider(record.provider));
			}
		}
		if (staleDurableCredentialPins.size > 0) {
			logger.warn("Stale durable credential pin discarded; re-pin or select AUTO explicitly", {
				providers: [...staleDurableCredentialPins].map(sanitizeProviderForLog),
			});
		}
		if (!scopeAlreadyLeased) {
			for (const [provider, rawSelector] of Object.entries(configuredPins)) {
				if (staleDurableCredentialPins.has(resolveOAuthStorageProvider(provider))) continue;
				if (
					authStorage.hasSessionCredentialSelector(provider, credentialSessionId) ||
					authStorage.hasSessionCredentialAuto(provider, credentialSessionId)
				)
					continue;
				const selector = parsePersistedCredentialSelector(rawSelector);
				if (!selector) continue;
				if (selector.kind === "id" && !persistedPinStoreMatches) {
					logger.warn("Numeric persistent credential pin discarded after credential-store authority changed", {
						provider: sanitizeProviderForLog(provider),
					});
					continue;
				}
				applyCredentialSelector(credentialSessionId, provider, selector);
			}
		}
		if (options.credentialSelector?.provider) {
			applyCredentialSelector(
				credentialSessionId,
				options.credentialSelector.provider,
				options.credentialSelector.selector,
			);
		}

		const hasExplicitModel = options.model !== undefined || options.modelPattern !== undefined;
		const modelMatchPreferences = {
			usageOrder: settings.getStorage()?.getModelUsageOrder(),
		};
		const persistedProfiles = modelRegistry.getModelProfiles();
		const resolvedInheritedProfileName = options.activeModelProfile
			? resolveModelProfileName(options.activeModelProfile, persistedProfiles)
			: undefined;
		const acceptedInheritedProfileName =
			resolvedInheritedProfileName && persistedProfiles.has(resolvedInheritedProfileName)
				? resolvedInheritedProfileName
				: undefined;
		const inheritedProfileOwnsDefault = acceptedInheritedProfileName
			? resolveProfileBindings(persistedProfiles.get(acceptedInheritedProfileName)!).defaultSelector !== undefined
			: false;
		const settingsProfileAliasIntent: { aliasIntent: "preset-equivalent" } | undefined = inheritedProfileOwnsDefault
			? { aliasIntent: "preset-equivalent" }
			: undefined;
		const allowedModels = await logger.time("resolveAllowedModels", () =>
			resolveAllowedModels(modelRegistry, settings, modelMatchPreferences),
		);
		const defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
			resolveModelRoleValue(settings.getModelRole("default"), allowedModels, {
				settings,
				matchPreferences: modelMatchPreferences,
				modelRegistry,
				...(settingsProfileAliasIntent ?? {}),
				sessionId: providerSessionId,
				credentialSessionId,
			}),
		);
		const configuredDefaultPatterns = normalizeModelSelectorValue(settings.getModelRole("default"));
		let model = options.model;
		let modelFallbackMessage: string | undefined;
		if (!hasExplicitModel && configuredDefaultPatterns.length > 0 && !defaultRoleSpec.model) {
			modelFallbackMessage = `Model ${configuredDefaultPatterns.join(" -> ")} not found`;
		}
		const resumeModelBehavior = settings.get("session.resumeModelBehavior");
		const persistedDefaultChain = existingSession.configuredModelChains.default;
		const defaultModelEntries =
			resumeModelBehavior === "useCurrentDefault"
				? []
				: persistedDefaultChain?.entries && persistedDefaultChain.entries.length > 0
					? persistedDefaultChain.entries
					: existingSession.models.default
						? [existingSession.models.default]
						: [];
		const persistedProfileName =
			persistedDefaultChain?.origin === "profile-activation" ? persistedDefaultChain.identity : undefined;
		const resolvedPersistedProfileName = persistedProfileName
			? resolveModelProfileName(persistedProfileName, persistedProfiles)
			: undefined;
		const acceptedPersistedProfileName =
			resolvedPersistedProfileName &&
			persistedProfiles.has(resolvedPersistedProfileName) &&
			(!acceptedInheritedProfileName || acceptedInheritedProfileName === resolvedPersistedProfileName) &&
			resumeModelBehavior !== "useCurrentDefault"
				? resolvedPersistedProfileName
				: undefined;
		const persistedProfileOwnsDefault = acceptedPersistedProfileName
			? resolveProfileBindings(persistedProfiles.get(acceptedPersistedProfileName)!).defaultSelector !== undefined
			: false;
		const startupActiveModelProfile =
			acceptedInheritedProfileName ??
			(!hasExplicitModel && acceptedPersistedProfileName ? acceptedPersistedProfileName : undefined);
		// If session has data, restore its configured default chain rather than the
		// scalar runtime model, which may be a stale fallback from the prior run.
		if (!hasExplicitModel && !model && hasExistingSession && defaultModelEntries.length > 0) {
			await logger.time("restoreSessionModel", async () => {
				const restoredDefaultResolution = await resolveModelChainWithAuth(
					defaultModelEntries,
					modelRegistry,
					settings,
					credentialSessionId,
					{
						managedFallback: defaultModelEntries.length > 1,
						canonicalSessionId: providerSessionId,
						...(persistedProfileOwnsDefault ? { aliasIntent: "preset-equivalent" as const } : {}),
					},
				);
				model = restoredDefaultResolution.model;
				// A restored session model from a different provider than an active
				// `--prefer-credential` preference is discarded rather than kept: the
				// preference names one provider's account, and silently resuming on
				// another provider would strand it without any error.
				if (model && preferredCredentialProvider && model.provider !== preferredCredentialProvider) {
					model = undefined;
				}
				if (!model) modelFallbackMessage = `Could not restore model ${defaultModelEntries.join(" -> ")}`;
			});
		}

		// If still no model, try settings default.
		// Skip settings fallback when an explicit model was requested.
		if (
			!hasExplicitModel &&
			!model &&
			defaultRoleSpec.model &&
			(!preferredCredentialProvider || defaultRoleSpec.model.provider === preferredCredentialProvider)
		) {
			const settingsDefaultModel = defaultRoleSpec.model;
			logger.time("resolveSettingsDefaultModel", () => {
				// defaultRoleSpec.model already comes from modelRegistry.getAvailable(),
				// so re-validating auth here just repeats the expensive lookup path.
				model = settingsDefaultModel;
			});
		}

		const taskDepth = options.taskDepth ?? 0;

		let thinkingLevel = options.thinkingLevel;
		const hasExplicitDefaultThinkingLevel = settings.has("defaultThinkingLevel");
		let thinkingLevelFromSchemaDefault = false;

		// If session has data and includes a thinking entry, restore an explicit session
		// override. A persisted inherit marker deliberately re-enters the normal
		// default-role/global/model resolution path instead of resolving to `undefined`.
		const restoredThinkingLevel =
			hasExistingSession && hasThinkingEntry ? parseThinkingLevel(existingSession.thinkingLevel) : undefined;
		if (thinkingLevel === undefined && restoredThinkingLevel !== ThinkingLevel.Inherit) {
			thinkingLevel = restoredThinkingLevel;
		}

		if (thinkingLevel === undefined && !hasExplicitModel && defaultRoleSpec.explicitThinkingLevel) {
			thinkingLevel = defaultRoleSpec.thinkingLevel;
		}

		// An explicit user/project default should win over the model's bundled
		// defaultLevel. The schema default is only a final fallback so model metadata
		// can keep driving first-run behavior until the user chooses "Set as default".
		if (thinkingLevel === undefined && hasExplicitDefaultThinkingLevel) {
			thinkingLevel = settings.get("defaultThinkingLevel");
		}

		if (thinkingLevel === undefined && model?.thinking?.defaultLevel !== undefined) {
			thinkingLevel = model.thinking.defaultLevel;
		}

		if (thinkingLevel === undefined) {
			thinkingLevel = settings.get("defaultThinkingLevel");
			thinkingLevelFromSchemaDefault = true;
		}
		if (model) {
			const resolvedModel = model;
			thinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
				resolveThinkingLevelForModel(resolvedModel, thinkingLevel),
			);
			// Keep the legacy startup trigger for the model-host preconnect. The
			// runtime service preserves the best-effort fetch.preconnect contract while
			// allowing startup.networkPrewarm=false to skip the call entirely.
			void runtimeServices.networkPrewarm
				.get("legacy-startup")
				.then(prewarm => prewarm.preconnect(resolvedModel.baseUrl))
				.catch(error => {
					logger.warn("Model-host prewarm service failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
		}

		let skills: Skill[];
		let skillWarnings: SkillWarning[];
		if (options.skills !== undefined) {
			// The four public GJC workflow skills are a product invariant, not
			// ordinary filesystem-discovered skills. Keep them available even for
			// explicit SDK skill lists so startup and command routing survive
			// accidental `.gjc` deletion or overzealous caller filtering.
			skills = withEmbeddedDefaultGjcSkills(options.skills);
			skillWarnings = [];
		} else if (settings.get("skills.enabled")) {
			const skillsResult = await logger.time("loadSkills", loadSkills, {
				...settings.getGroup("skills"),
				cwd,
				agentDir,
				disabledExtensions: settings.get("disabledExtensions"),
				settings,
			});
			skills = withEmbeddedDefaultGjcSkills(skillsResult.skills);
			skillWarnings = skillsResult.warnings;
		} else {
			// GJC's four public workflow skills are bundled into the binary so the
			// default workflow surface survives accidental .gjc deletion. Filesystem
			// skill discovery is enabled by default (`skills.enabled`), so this
			// branch only runs when the user explicitly disabled it.
			skills = getEmbeddedDefaultGjcSkills();
			skillWarnings = [];
		}

		// Discover rules and bucket them in one pass to avoid repeated scans over large rule sets.
		let { ttsrManager, rulebookRules, alwaysApplyRules } = await logger.time("discoverTtsrRules", async () => {
			const ttsrSettings = settings.getGroup("ttsr");
			const ttsrManager = new TtsrManager(ttsrSettings);
			const rulesResult =
				options.rules !== undefined
					? { items: options.rules, warnings: undefined }
					: await loadCapability<Rule>(ruleCapability.id, { cwd, agentDir, settings });
			const rulebookRules: Rule[] = [];
			const alwaysApplyRules: Rule[] = [];
			for (const rule of rulesResult.items) {
				const isTtsrRule = rule.condition && rule.condition.length > 0 ? ttsrManager.addRule(rule) : false;
				if (isTtsrRule) {
					continue;
				}
				if (rule.alwaysApply === true) {
					alwaysApplyRules.push(rule);
					continue;
				}
				if (rule.description) {
					rulebookRules.push(rule);
				}
			}
			if (ttsrManager.getSettings().enabled !== false) {
				if ((existingSession.ttsrMessageCount ?? 0) > 0) {
					ttsrManager.restoreMessageCount(existingSession.ttsrMessageCount ?? 0);
				}
				if (existingSession.injectedTtsrRuleRecords && existingSession.injectedTtsrRuleRecords.length > 0) {
					ttsrManager.restoreInjected(existingSession.injectedTtsrRuleRecords);
				} else if (existingSession.injectedTtsrRules.length > 0) {
					ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
				}
			}
			return { ttsrManager, rulebookRules, alwaysApplyRules };
		});

		// Resolve contextFiles up-front (it's needed before tool creation). The
		// workspace tree scan is slow on large repos and we MUST NOT block startup on
		// it. On timeout we forward `undefined` to ToolSession; buildSystemPromptInternal
		// will re-race the same promise through its own withDeadline path. Background
		// work continues so caches still warm.
		const raceWithDeadline = async <T>(name: string, work: Promise<T>): Promise<T | undefined> => {
			let timedOut = false;
			const result = await Promise.race([
				work,
				Bun.sleep(STARTUP_SCAN_DEADLINE_MS).then(() => {
					timedOut = true;
					return undefined;
				}),
			]);
			if (timedOut) {
				logger.warn("Startup scan exceeded deadline; deferring to system prompt fallback", {
					name,
					timeoutMs: STARTUP_SCAN_DEADLINE_MS,
					cwd,
				});
			}
			return result;
		};
		const [contextFilesResult, resolvedWorkspaceTree] = await Promise.all([
			contextFilesResultPromise,
			raceWithDeadline("buildWorkspaceTree", workspaceTreePromise),
		]);
		// Mutable: a rescope re-discovers cwd-derived project instructions so the
		// model is never shown the launcher root's AGENTS.md alongside the new cwd.
		let contextFiles = contextFilesResult.contextFiles;
		let liveWorkspaceTree: WorkspaceTree | undefined = resolvedWorkspaceTree;
		const discoveredContextFileWarnings = contextFilesResult.warnings;

		const backgroundJobsEnabled = isBackgroundJobSupportEnabled(settings);
		const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
		const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
		const ASYNC_PREVIEW_MAX_CHARS = 4_000;
		const formatAsyncResultForFollowUp = async (result: string, allowArtifact = true): Promise<string> => {
			if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
				return result;
			}

			const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
			// A delivery already denied by a scope:"owned" gate never reaches the
			// model: allocating an artifact for it would leave the stopped job's
			// output in an unreferenced artifact after the flush drops it (review
			// thread P2). Only the inline preview is produced.
			if (!allowArtifact) return preview;
			try {
				const { path: artifactPath, id: artifactId } = await sessionManager.allocateArtifactPath("async");
				if (artifactPath && artifactId) {
					await Bun.write(artifactPath, result);
					return `${preview}\nFull output: artifact://${artifactId}`;
				}
			} catch (error) {
				logger.warn("Failed to persist async follow-up artifact", {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			return preview;
		};
		// Only top-level sessions own an AsyncJobManager. Subagents reach the
		// parent's manager via `AsyncJobManager.instance()` (set below), so creating
		// a second instance here just to leave it orphaned wastes a constructor and
		// risks accidental disposal of the parent's manager on subagent teardown.
		asyncJobManager =
			backgroundJobsEnabled && !options.parentTaskPrefix
				? new AsyncJobManager({
						maxRunningJobs: asyncMaxJobs,
						onJobComplete: async (jobId, result, job) => {
							if (!session) return;
							// Mandated boundary comment (corrected turn semantics):
							// turn-scope abort blocks only deliveries whose origin is a
							// continuation of the aborted turn. Owned-completion deliveries
							// from work deliberately left running are intentionally allowed
							// to resume the agent through the normal followUp/prompt path
							// and receive a fresh turn attempt. Recover the immutable origin
							// BEFORE formatting or artifact allocation; missing metadata
							// fails closed to an ordinary delivery.
							// Preserve ownership on the queued entry REGARDLESS of whether a
							// terminal scope exists yet: the registration is determined at
							// job-registration time, and the scope is determined at abort
							// time (or later, at flush). A completion finished before the
							// abort must not become an ordinary entry that owned cleanup
							// cannot identify/purge (review thread P1).
							// Owned tuples are keyed by the LOGICAL endpoint, not a
							// provider-facing session id. providerSessionId may differ
							// from sessionManager.getSessionId(), so session.sessionId
							// would miss the tuple and turn a left-running completion
							// into an ordinary follow-up (review thread P1).
							const endpointId = AsyncJobManager.endpointIdOf(asyncJobManager) ?? asyncJobEndpointId;
							const registration = job ? lookupOwnedRegistration(jobId, job.generation, endpointId) : undefined;
							const ownedCompletion = registration
								? {
										lineageIdHash: registration.lineageIdHash,
										promptAttemptEpoch: registration.promptAttemptEpoch,
										registration,
									}
								: undefined;
							// Check suppression and classify the captured envelope BEFORE
							// formatting/artifact allocation: a delivery already suppressed
							// by the manager (owned-stop cancel/acknowledge) or already
							// denied by a scope:"owned" gate must not allocate an
							// unreferenced artifact (review thread P2).
							if (asyncJobManager!.isDeliverySuppressed(jobId, job?.generation)) return;
							const deniedOwnedDelivery =
								ownedCompletion !== undefined && !isOwnedCompletionEnvelopeAllowed(ownedCompletion);
							// Fold disposition is decided by the coordinator's durable slot state.
							// `parked` means the fold transaction has not finished capturing its
							// receipt yet; it replays this completion itself, so enqueuing here
							// would double-deliver.
							const foldDisposition = job
								? session.foldCoordinator.onDelivery(job, result)
								: ({ kind: "ordinary" } as const);
							if (foldDisposition.kind === "parked") {
								if (job) asyncJobManager?.retainParkedDelivery(job, result);
								return;
							}
							const formattedResult = await formatAsyncResultForFollowUp(result, !deniedOwnedDelivery);
							if (
								foldDisposition.kind === "receipt" &&
								job &&
								!session.foldCoordinator.claimCompletionDelivery(job)
							)
								return;
							// A folded job's result must arrive with its receipt so the wake turn
							// completes the original task rather than merely reporting output.
							const deliveredResult =
								foldDisposition.kind === "receipt"
									? `${formattedResult}\n\n${describeFoldReceipt(foldDisposition.receipt)}`
									: formattedResult;
							// Exactly one transcript notice per completion: a retried delivery
							// reuses the same job object, so the claim guards against repeats.
							if (
								foldDisposition.kind === "receipt" &&
								job &&
								session.foldCoordinator.claimCompletionNotice(job)
							) {
								session.emitNotice(
									"info",
									`Folded job ${foldDisposition.receipt.jobId} (${foldDisposition.receipt.label}) finished.`,
									"fold",
								);
							}

							const durationMs = job ? jobElapsedMs(job) : undefined;
							session.yieldQueue.enqueue<AsyncResultEntry>("async-result", {
								jobId,
								generation: job?.generation ?? "",
								result: deliveredResult,
								job,
								durationMs,
								...(ownedCompletion
									? {
											ownedCompletion: {
												lineageIdHash: ownedCompletion.lineageIdHash,
												promptAttemptEpoch: ownedCompletion.promptAttemptEpoch,
												registration: ownedCompletion.registration,
											},
										}
									: {}),
							});
							if (job) asyncJobManager?.retainDeliveryClaim(job);
						},
					})
				: options.inheritedAsyncJobManager;

		let promptMetadataModel: Model | undefined;
		const getActiveModelString = (): string | undefined => {
			const activeModel = promptMetadataModel ?? agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			if (model) return formatModelString(model);
			return undefined;
		};
		let mcpManager: MCPManager | undefined = options.mcpManager;
		let ownsMcpManager = false;
		const cwdCapturingToolNames: string[] = [];
		const ownedConventionalMcpServerNames = new Set<string>();
		let ownedConventionalMcpToolNames: string[] = [];
		let publishOwnedConventionalMcpTools = false;
		let syncConventionalToolsForManager: ((tools: CustomTool[]) => Promise<void>) | undefined;
		let replacementMcpToolsSync: Promise<void> = Promise.resolve();
		let replacementMcpGeneration = 0;
		let ownedPluginServersConnected = false;
		const notificationDebounceTimers = new Map<string, Timer>();
		const stagedMcpCleanup = new Map<MCPManager, () => void>();
		const wireMcpManagerCallbacks = (
			manager: MCPManager,
			isCurrent: () => boolean = () => true,
			callbackGeneration = replacementMcpGeneration,
		): void => {
			manager.setOnPromptsChanged(serverName => {
				if (!isCurrent()) return;
				const promptCommands = buildMCPPromptCommands(manager);
				session.setMCPPromptCommands(promptCommands);
				logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
			});
			manager.setOnResourcesChanged((serverName, uri) => {
				if (!isCurrent()) return;
				logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
				if (!settings.get("mcp.notifications")) return;
				const debounceMs = settings.get("mcp.notificationDebounceMs");
				const key = `${serverName}:${uri}`;
				const existing = notificationDebounceTimers.get(key);
				if (existing) clearTimeout(existing);
				notificationDebounceTimers.set(
					key,
					setTimeout(() => {
						notificationDebounceTimers.delete(key);
						if (!settings.get("mcp.notifications")) return;
						if (!isCurrent() || callbackGeneration !== replacementMcpGeneration || mcpManager !== manager) return;
						session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
					}, debounceMs),
				);
			});
		};
		const rebindCwdCapturingAuthority = async (to: string): Promise<void> => {
			if (!session) return;
			const generation = ++replacementMcpGeneration;
			if (settings.getCwd() !== to) {
				settings = await settings.cloneForCwd(to);
				session.setSettings(settings);
				toolSession.settings = settings;
			}
			if (settings.get("secrets.enabled")) {
				const entries = [...secretApi.collectEnvSecrets(), ...(await secretApi.loadSecrets(to, agentDir))];
				obfuscator = entries.length > 0 ? secretApi.createSecretObfuscator(entries) : undefined;
				secretsEnabled = obfuscator?.hasSecrets() === true;
				session.setObfuscator(obfuscator);
			} else {
				obfuscator = undefined;
				secretsEnabled = false;
				session.setObfuscator(undefined);
			}
			modelRegistry.setScopedSettings(settings);
			modelRegistry.applyConfiguredModelBindings(settings);
			for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
			notificationDebounceTimers.clear();
			let replacementReady = false;
			let pendingReplacementTools: CustomTool[] | undefined;
			if (options.mcpManager && !ownsMcpManager) {
				throw new Error(
					"Cannot rescope a session with caller-owned MCP authority; recreate the session at the target cwd.",
				);
			}
			await session.refreshGjcSubskillTools();
			const previousCwdCapturing = [...cwdCapturingToolNames];
			const nextCwdCapturing: string[] = [];
			const nextCustomTools: CustomTool[] = [];
			const declarations = await getGjcPluginToolDeclarations(to, agentDir);
			const pluginToolResult = await loadAlwaysOnPluginTools({
				cwd: to,
				agentDir,
				reservedToolNames: session.getAllToolNames().filter(name => !previousCwdCapturing.includes(name)),
				declarations,
			});
			nextCustomTools.push(...pluginToolResult.tools);
			nextCwdCapturing.push(...pluginToolResult.tools.map(tool => tool.name));
			if (!options.mcpManager && explicitMcpConfigPath === undefined) {
				const previousManager = mcpManager;
				pluginMcpToolNames.length = 0;
				conventionalMcpToolNames.length = 0;
				let nextManager: MCPManager | undefined;
				let replacementPluginNames = new Set<string>();
				let replacementConventionalNames = new Set<string>();
				try {
					const loaded = await loadAllMCPConfigs(to, {
						agentDir,
						enableProjectConfig: settings.has("mcp.enableProjectConfig")
							? settings.get("mcp.enableProjectConfig")
							: true,
						autoloadOnly: true,
						nativeOnly: true,
						settings,
					});
					const { configs: pluginConfigs, sources: pluginSources } = await buildPluginMcpConfigs({
						cwd: to,
						agentDir,
					});
					const pluginNames = new Set(Object.keys(pluginConfigs));
					replacementPluginNames = pluginNames;
					replacementConventionalNames = new Set(Object.keys(loaded.configs));
					const mergedConfigs = { ...loaded.configs, ...pluginConfigs };
					const mergedSources = {
						...loaded.sources,
						...pluginSources,
					};
					if (Object.keys(mergedConfigs).length > 0) {
						nextManager = new MCPManager(to, null, {
							sharedPoolIdleMs: settings.get("mcp.sharedPoolIdleMs"),
							agentDir,
							settings,
						});
						stagedMcpCleanup.set(
							nextManager,
							session.registerToolSessionCleanup(() => nextManager?.disconnectAll()),
						);
						nextManager.setAuthStorage(authStorage);
						wireMcpManagerCallbacks(
							nextManager,
							() => generation === replacementMcpGeneration && mcpManager === nextManager,
							generation,
						);
						nextManager.setOnToolsChanged(tools => {
							if (generation !== replacementMcpGeneration) return;
							if (!replacementReady) {
								pendingReplacementTools = tools as CustomTool[];
								return;
							}
							replacementMcpToolsSync = replacementMcpToolsSync
								.then(() => {
									if (generation !== replacementMcpGeneration || mcpManager !== nextManager) return;
									return session.refreshMCPTools(tools as CustomTool[]);
								})
								.then(() => {
									if (generation !== replacementMcpGeneration || mcpManager !== nextManager) return;
									return session.rebindMCPSelectionMetadata({
										mandatoryToolNames: (tools as CustomTool[])
											.filter(
												tool => tool.mcpServerName !== undefined && pluginNames.has(tool.mcpServerName),
											)
											.map(tool => tool.name),
										defaultSelectedToolNames: (tools as CustomTool[]).map(tool => tool.name),
									});
								})
								.then(() => {
									if (
										generation === replacementMcpGeneration &&
										mcpManager === nextManager &&
										pluginNames.size > 0 &&
										!Object.keys(loaded.configs).some(
											name => nextManager?.getConnectionStatus(name) === "connecting",
										)
									) {
										nextManager?.sealConnectionSet();
									}
								})
								.catch(error => {
									logger.warn("Failed to refresh relocated MCP tools", { error: safeErrorForLog(error) });
								});
						});
						const result = await nextManager.connectServers(mergedConfigs, mergedSources as never);
						await session.rebindMCPSelectionMetadata({
							mandatoryToolNames: result.tools
								.filter(tool => tool.mcpServerName !== undefined && pluginNames.has(tool.mcpServerName))
								.map(tool => tool.name),
							defaultSelectedToolNames: result.tools.map(tool => tool.name),
						});
						if (
							pluginNames.size > 0 &&
							!Object.keys(loaded.configs).some(name => nextManager?.getConnectionStatus(name) === "connecting")
						) {
							nextManager.sealConnectionSet();
						}
						nextCustomTools.push(...(result.tools as CustomTool[]));
						nextCwdCapturing.push(...result.tools.map(tool => tool.name));
						for (const tool of result.tools) {
							const serverName = tool.mcpServerName;
							if (serverName === undefined) continue;
							if (pluginNames.has(serverName)) pluginMcpToolNames.push(tool.name);
							else conventionalMcpToolNames.push(tool.name);
						}
					}
				} catch (error) {
					let cleanupError: unknown;
					try {
						await nextManager?.disconnectAll();
					} catch (disconnectError) {
						cleanupError = disconnectError;
					}
					if (cleanupError === undefined && nextManager) {
						stagedMcpCleanup.get(nextManager)?.();
						stagedMcpCleanup.delete(nextManager);
					}
					if (cleanupError !== undefined) throw attachMcpCleanupDiagnostic(error, cleanupError);
					throw error;
				}
				if (previousManager && previousManager !== nextManager) {
					try {
						await previousManager.disconnectAll();
					} catch (error) {
						let cleanupError: unknown;
						try {
							await nextManager?.disconnectAll();
						} catch (disconnectError) {
							cleanupError = disconnectError;
						}
						if (cleanupError === undefined && nextManager) {
							stagedMcpCleanup.get(nextManager)?.();
							stagedMcpCleanup.delete(nextManager);
						}
						if (cleanupError !== undefined) throw attachMcpCleanupDiagnostic(error, cleanupError);
						throw error;
					}
				}
				if (nextManager) {
					pluginMcpManagerServers.set(nextManager, replacementPluginNames);
					conventionalMcpManagerServers.set(nextManager, replacementConventionalNames);
				} else {
					await session.rebindMCPSelectionMetadata({ mandatoryToolNames: [], defaultSelectedToolNames: [] });
				}
				mcpManager = nextManager;
				ownsMcpManager = Boolean(nextManager);
				await session.replaceOwnedMcpManager(nextManager);
				session.setMCPPromptCommands(nextManager ? buildMCPPromptCommands(nextManager) : []);
				replacementReady = true;
				if (pendingReplacementTools) {
					const pending = pendingReplacementTools;
					pendingReplacementTools = undefined;
					replacementMcpToolsSync = replacementMcpToolsSync
						.then(() => {
							if (generation !== replacementMcpGeneration || mcpManager !== nextManager) return;
							return session.refreshMCPTools(pending);
						})
						.then(() => {
							if (generation !== replacementMcpGeneration || mcpManager !== nextManager) return;
							return session.rebindMCPSelectionMetadata({
								mandatoryToolNames: pending
									.filter(
										tool =>
											tool.mcpServerName !== undefined && replacementPluginNames.has(tool.mcpServerName),
									)
									.map(tool => tool.name),
								defaultSelectedToolNames: pending.map(tool => tool.name),
							});
						})
						.catch(error => {
							logger.warn("Failed to refresh relocated MCP tools", { error: safeErrorForLog(error) });
						});
				}
				await replacementMcpToolsSync;
				if (generation !== replacementMcpGeneration) return;
				await session.refreshMCPTools((nextManager?.getTools() ?? []) as CustomTool[]);
				if (nextManager) {
					stagedMcpCleanup.get(nextManager)?.();
					stagedMcpCleanup.delete(nextManager);
				}
			}
			cwdCapturingToolNames.length = 0;
			cwdCapturingToolNames.push(...nextCwdCapturing);
			await session.replaceNamedCustomTools(
				previousCwdCapturing.filter(name => !nextCustomTools.some(tool => tool.name === name)),
				nextCustomTools,
			);
		};

		/**
		 * Re-discover the cwd-derived read-only state the model is shown after a
		 * committed rescope: project instructions, skills, and the workspace tree.
		 * Without this the volatile message pairs the NEW cwd with the launch
		 * root's AGENTS.md and tree, and subagents inherit the same mismatch.
		 */
		const applyRescopedReadState = async (to: string): Promise<void> => {
			try {
				if (settings.getCwd() !== to) settings = await settings.cloneForCwd(to);
				session?.setSettings(settings);
				toolSession.settings = settings;
			} catch (error) {
				logger.warn("Failed to reload settings after session rescope", {
					error: safeErrorForLog(error),
					cwd: to,
				});
				throw error;
			}
			if (settings.get("secrets.enabled")) {
				try {
					const entries = [...secretApi.collectEnvSecrets(), ...(await secretApi.loadSecrets(to, agentDir))];
					obfuscator = entries.length > 0 ? secretApi.createSecretObfuscator(entries) : undefined;
					secretsEnabled = obfuscator?.hasSecrets() === true;
					session?.setObfuscator(obfuscator);
				} catch (error) {
					obfuscator = undefined;
					secretsEnabled = false;
					session?.setObfuscator(undefined);
					logger.warn("Failed to reload secrets after session rescope", {
						error: safeErrorForLog(error),
						cwd: to,
					});
					throw error;
				}
			} else {
				obfuscator = undefined;
				secretsEnabled = false;
				session?.setObfuscator(undefined);
			}
			extensionRunner?.rebindScope(to, settings);
			if (options.contextFiles === undefined) {
				try {
					const rediscovered = await loadContextFilesResultInternal({ cwd: to, agentDir, settings });
					contextFiles = rediscovered.contextFiles;
				} catch (error) {
					contextFiles = [];
					logger.warn("Failed to re-discover context files after session rescope", {
						error: safeErrorForLog(error),
					});
				}
			}
			if (options.skills === undefined && settings.get("skills.enabled")) {
				try {
					const reloaded = await loadSkills({
						...settings.getGroup("skills"),
						cwd: to,
						agentDir,
						disabledExtensions: settings.get("disabledExtensions"),
						settings,
					});
					skills = withEmbeddedDefaultGjcSkills(reloaded.skills);
					if (!options.parentTaskPrefix) setActiveSkills(skills);
					await session?.replaceSkills(skills);
				} catch (error) {
					skills = [];
					if (!options.parentTaskPrefix) setActiveSkills([]);
					await session?.replaceSkills([]);
					logger.warn("Failed to reload skills after session rescope", { error: safeErrorForLog(error) });
				}
			} else if (options.skills === undefined) {
				skills = [];
				if (!options.parentTaskPrefix) setActiveSkills([]);
				await session?.replaceSkills([]);
			}
			if (options.rules === undefined) {
				try {
					const rulesResult = await loadCapability<Rule>(ruleCapability.id, { cwd: to, agentDir, settings });
					const nextTtsrManager = new TtsrManager(settings.getGroup("ttsr"));
					const nextRulebookRules: Rule[] = [];
					const nextAlwaysApplyRules: Rule[] = [];
					for (const rule of rulesResult.items) {
						if (rule.condition && rule.condition.length > 0 && nextTtsrManager.addRule(rule)) continue;
						if (rule.alwaysApply === true) nextAlwaysApplyRules.push(rule);
						else if (rule.description) nextRulebookRules.push(rule);
					}
					ttsrManager = nextTtsrManager;
					rulebookRules = nextRulebookRules;
					alwaysApplyRules = nextAlwaysApplyRules;
					if (!options.parentTaskPrefix) setActiveRules([...rulebookRules, ...alwaysApplyRules]);
					session?.setTtsrManager(ttsrManager);
				} catch (error) {
					logger.warn("Failed to reload rules after session rescope", {
						error: safeErrorForLog(error),
						cwd: to,
					});
				}
			}
			try {
				promptTemplates =
					options.promptTemplates === undefined
						? await discoverPromptTemplates(to, agentDir)
						: options.promptTemplates;
				session?.setPromptTemplates(promptTemplates);
			} catch (error) {
				logger.warn("Failed to reload prompt templates after session rescope", {
					error: safeErrorForLog(error),
					cwd: to,
				});
			}
			if (options.slashCommands === undefined) {
				try {
					slashCommands = await loadSlashCommands({ cwd: to, agentDir, settings });
					session?.setSlashCommands(slashCommands);
				} catch (error) {
					slashCommands = [];
					session?.setSlashCommands([]);
					logger.warn("Failed to reload slash commands after session rescope", {
						error: safeErrorForLog(error),
						cwd: to,
					});
				}
			}
			// The launch-bound tree is retired immediately: a stale root-scoped tree is
			// worse than none, and the next turn re-scans at the new cwd.
			if (options.workspaceTree === undefined) {
				liveWorkspaceTree = undefined;
				workspaceTreePromise = Promise.resolve({
					rootPath: to,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				});
			}
			workspaceTreePromise.catch(() => {});
			try {
				session?.retireWorkspaceTreeForRescope();
				await session?.refreshBaseSystemPrompt();
			} catch (error) {
				logger.warn("Committed session rescope could not refresh the post-move prompt", {
					error: safeErrorForLog(error),
					cwd: to,
				});
			}
		};

		const canAgentRescopeSessionCwd =
			!isCanonicalSubSession &&
			!options.bashRestrictionProfile &&
			(options.bashAllowedPrefixes ?? []).length === 0 &&
			!options.mcpManager &&
			!options.inheritedMcpManager &&
			explicitMcpConfigPath === undefined;
		const rescopeSessionCwdParticipant: AgentSessionRescopeParticipant | undefined = canAgentRescopeSessionCwd
			? {
					assertCanRescope: () => {
						if (options.mcpManager && !ownsMcpManager) {
							throw new Error(
								"Cannot rescope a session with caller-owned MCP authority; recreate the session at the target cwd.",
							);
						}
					},
					rebindCwdCapturingAuthority,
					applyRescopedReadState,
				}
			: undefined;
		const canExposeMoveSession = canAgentRescopeSessionCwd && options.workspaceTree === undefined;

		const toolSession: ToolSession = {
			get cwd() {
				return sessionManager.getCwd();
			},
			hasUI: options.hasUI ?? false,
			workflowGateEligible: true,
			enableLsp,
			get hasEditTool() {
				const requestedToolNames = options.toolNames
					? [...new Set(options.toolNames.map(name => name.toLowerCase()))]
					: undefined;
				return !requestedToolNames || requestedToolNames.includes("edit");
			},
			skipPythonPreflight: options.skipPythonPreflight,
			// Getters, not snapshots: subagents launched after a rescope inherit the
			// CURRENT cwd's context files, skills, and tree rather than the launch
			// root's, which would otherwise pair the new cwd with retired instructions.
			get contextFiles() {
				return contextFiles;
			},
			get workspaceTree() {
				return liveWorkspaceTree;
			},
			get skills() {
				return skills;
			},
			get rules() {
				return [...rulebookRules, ...alwaysApplyRules];
			},
			get localProtocolOptions() {
				return (
					options.localProtocolOptions ?? {
						getArtifactsDir: () => sessionManager.getArtifactsDir(),
						isManagedDestination: () => sessionManager.isManagedDestination(),
						getManagedLegacyLocalMigrationSource: () => sessionManager.getManagedLegacyLocalMigrationSource(),
						getCredentialSessionId: () => credentialSessionId,
						getSessionId: () => sessionManager.getSessionId(),
					}
				);
			},
			get memoryRoot() {
				return getMemoryRootForSession(agentDir, sessionManager.getCwd());
			},
			eventBus,
			outputSchema: options.outputSchema,
			requireYieldTool: options.requireYieldTool,
			taskDepth: options.taskDepth ?? 0,
			currentAgentType: options.currentAgentType,
			...(canExposeMoveSession
				? {
						rescopeSessionCwd: (() => {
							let moveConsumed = false;
							return async (target: string): Promise<{ from: string; to: string }> => {
								if (moveConsumed) {
									throw new Error(
										"This session has already been rescoped; only one agent-invoked move is allowed per session.",
									);
								}
								if (session?.getEffectiveActiveWorkflowSkillState()) {
									throw new Error(
										"A workflow skill is active in this session; finish or exit it before rescoping.",
									);
								}
								if (options.mcpManager && !ownsMcpManager) {
									throw new Error(
										"Cannot rescope a session with caller-owned MCP authority; recreate the session at the target cwd.",
									);
								}
								return sessionManager.runExclusiveCwdTransition(async () => {
									if (moveConsumed) {
										throw new Error(
											"This session has already been rescoped; only one agent-invoked move is allowed per session.",
										);
									}
									if (session?.getEffectiveActiveWorkflowSkillState()) {
										throw new Error(
											"A workflow skill became active while waiting for the cwd transition; finish or exit it before rescoping.",
										);
									}
									const from = sessionManager.getCwd();
									const sourceHandle = await SessionManager.openNoFollowDirectory(from);
									const sourceOpened = await sourceHandle.stat({ bigint: true });
									if (!sourceOpened.isDirectory()) {
										await sourceHandle.close().catch(() => {});
										throw new Error(`Current session directory is no longer a directory: ${from}`);
									}
									try {
										const resolvedPath = path.resolve(from, target);
										let canonicalFrom: string;
										let canonicalTarget: string;
										try {
											canonicalFrom = await fs.realpath(from);
											canonicalTarget = await fs.realpath(resolvedPath);
										} catch (error) {
											// macOS `realpath(3)` reports EACCES on an unreadable
											// directory where Linux succeeds and fails later at the
											// `access` probe; keep both platforms on the access message.
											const code = (error as NodeJS.ErrnoException)?.code;
											if (code === "EACCES" || code === "EPERM") {
												throw new Error(
													`Directory identity or access unavailable: ${resolvedPath}${
														error instanceof Error ? ` (${error.message})` : ""
													}`,
												);
											}
											throw new Error(`Directory does not exist or is not a directory: ${resolvedPath}`);
										}
										if (!(await fs.stat(canonicalTarget)).isDirectory()) {
											throw new Error(`Directory does not exist or is not a directory: ${resolvedPath}`);
										}
										const relative = path.relative(canonicalFrom, canonicalTarget);
										if (relative === "") {
											throw new Error(
												`Target ${canonicalTarget} is the current session directory; nothing to move.`,
											);
										}
										if (
											relative === ".." ||
											relative.startsWith(`..${path.sep}`) ||
											path.isAbsolute(relative)
										) {
											throw new Error(
												`Refusing to rescope outside the current session directory: ${canonicalTarget} is not within ${canonicalFrom}. move_session only narrows the session scope; ask the user to restart or /move for a broader relocation.`,
											);
										}
										let targetHandle: nodeFs.promises.FileHandle | undefined;
										let expectedIdentity: { dev: bigint; ino: bigint };
										try {
											targetHandle = await SessionManager.openNoFollowDirectory(canonicalTarget);
											const opened = await targetHandle.stat({ bigint: true });
											if (!opened.isDirectory()) {
												throw new Error(`Directory does not exist or is not a directory: ${resolvedPath}`);
											}
											const revalidatedFrom = await fs.realpath(from);
											const revalidatedTarget = await fs.realpath(resolvedPath);
											const revalidatedRelative = path.relative(revalidatedFrom, revalidatedTarget);
											if (
												revalidatedFrom !== canonicalFrom ||
												revalidatedTarget !== canonicalTarget ||
												revalidatedRelative === "" ||
												revalidatedRelative === ".." ||
												revalidatedRelative.startsWith(`..${path.sep}`) ||
												path.isAbsolute(revalidatedRelative)
											) {
												throw new Error(
													`Directory identity changed during confinement validation: ${resolvedPath}`,
												);
											}
											const named = await fs.lstat(revalidatedTarget, { bigint: true });
											const namedSource = await fs.lstat(revalidatedFrom, { bigint: true });
											if (
												!namedSource.isDirectory() ||
												namedSource.isSymbolicLink() ||
												namedSource.dev !== sourceOpened.dev ||
												namedSource.ino !== sourceOpened.ino ||
												!named.isDirectory() ||
												named.isSymbolicLink() ||
												named.dev !== opened.dev ||
												named.ino !== opened.ino
											) {
												throw new Error(
													`Directory identity changed during confinement validation: ${resolvedPath}`,
												);
											}
											expectedIdentity = { dev: opened.dev, ino: opened.ino };
											await fs.access(canonicalTarget, nodeFs.constants.R_OK | nodeFs.constants.X_OK);
										} catch (error) {
											await targetHandle?.close().catch(() => {});
											if (error instanceof Error && error.message.startsWith("Directory does not exist")) {
												throw error;
											}
											throw new Error(
												`Directory identity or access unavailable: ${canonicalTarget}${
													error instanceof Error ? ` (${error.message})` : ""
												}`,
											);
										}
										// Process-cwd authority is an explicit claim, never inferred from
										// `process.cwd() === from`: sibling sessions launched at the same
										// root both satisfy that, so acting on it would chdir the process
										// and clear process-global caches underneath the sibling.
										const ownsProcessCwd = SessionManager.isProcessCwdOwner(sessionManager);
										const restoreLaunchRoot = async (failure: unknown): Promise<never> => {
											const restoreErrors: Error[] = [];
											if (ownsProcessCwd) {
												try {
													setProjectDir(canonicalFrom);
													if (path.resolve(process.cwd()) !== path.resolve(canonicalFrom)) {
														throw new Error("Process cwd did not restore to the launch root.");
													}
													await SessionManager.assertProcessCwdIdentity({
														dev: sourceOpened.dev,
														ino: sourceOpened.ino,
													});
												} catch (error) {
													restoreErrors.push(error instanceof Error ? error : new Error(String(error)));
												}
												try {
													resetCapabilities();
													const restoreRegistry = await resolveActiveProjectRegistryPath(
														canonicalFrom,
													).catch(() => undefined);
													clearPluginRootsAndCaches(restoreRegistry ? [restoreRegistry] : undefined);
												} catch (error) {
													restoreErrors.push(error instanceof Error ? error : new Error(String(error)));
												}
											}
											try {
												await rebindCwdCapturingAuthority(canonicalFrom);
											} catch (error) {
												restoreErrors.push(error instanceof Error ? error : new Error(String(error)));
											}
											if (restoreErrors.length > 0) {
												throw new AggregateError(
													restoreErrors,
													"Failed to restore launch-root rescope authority.",
													{
														cause: failure,
													},
												);
											}
											throw failure;
										};
										try {
											// Every fallible step that the moved session depends on runs
											// BEFORE the session-file commit, so a failure here leaves the
											// session exactly where it was and the tool call is a clean
											// rejection rather than a half-moved session.
											if (ownsProcessCwd) {
												setProjectDir(canonicalTarget);
												try {
													// `setProjectDir` chdirs a NAME. Confirm the process actually
													// landed on the pinned directory, so a path replaced after
													// the name checks cannot escape the validated descendant.
													await SessionManager.assertProcessCwdIdentity(expectedIdentity);
												} catch (error) {
													setProjectDir(canonicalFrom);
													await SessionManager.assertProcessCwdIdentity({
														dev: sourceOpened.dev,
														ino: sourceOpened.ino,
													});
													throw error;
												}
											}
											let rescopeFailure: unknown;
											try {
												if (ownsProcessCwd) {
													resetCapabilities();
													const projectRegistry = await resolveActiveProjectRegistryPath(canonicalTarget);
													clearPluginRootsAndCaches(projectRegistry ? [projectRegistry] : undefined);
												}
												// Plugin/MCP/Python authority must be rebound successfully
												// before committing; swallowing a failure here is what leaves
												// a moved session holding launch-root tool authority.
												await rebindCwdCapturingAuthority(canonicalTarget);
											} catch (error) {
												rescopeFailure = error;
											}
											if (rescopeFailure !== undefined) {
												await restoreLaunchRoot(rescopeFailure);
											}
											try {
												await sessionManager.flush();
												// Commit last: `moveTo` re-validates the pinned identity through
												// the still-open handle at the state-changing boundary.
												await sessionManager.moveTo(canonicalTarget, {
													expectedIdentity,
													targetHandle,
													expectedSourceIdentity: { dev: sourceOpened.dev, ino: sourceOpened.ino },
													sourceHandle,
												});
											} catch (error) {
												const committedCwd = sessionManager.getCwd();
												const stayedAtLaunchRoot = path.resolve(committedCwd) === path.resolve(from);
												if (stayedAtLaunchRoot) await restoreLaunchRoot(error);
												// SessionManager can publish the durable move before a later metadata
												// write fails. Treat that state as committed rather than reporting a
												// rejection after the session has moved.
												moveConsumed = true;
												logger.warn("Session rescope committed before finalization failed", {
													error: safeErrorForLog(error),
													cwd: committedCwd,
												});
											}
											moveConsumed = true;
											if (ownsProcessCwd) {
												try {
													await shutdownAllLspClients();
												} catch (error) {
													logger.warn("Failed to reset launch-root LSP clients after session rescope", {
														error: safeErrorForLog(error),
													});
												}
											}
											// Cwd-derived read-only state the prompt and subagents consume.
											// Best-effort by design: the move is committed, and a failed
											// re-discovery must not present a committed move as a failure.
											await applyRescopedReadState(sessionManager.getCwd());
											try {
												await session?.refreshSshTool({ activateIfAvailable: true });
											} catch (error) {
												// Non-fatal: the session has moved; the SSH tool refreshes
												// on its next activation attempt.
												logger.warn("Committed session rescope could not refresh the SSH tool", {
													error: safeErrorForLog(error),
													cwd: sessionManager.getCwd(),
												});
											}
											return { from, to: sessionManager.getCwd() };
										} finally {
											await targetHandle.close().catch(() => {});
										}
									} finally {
										await sourceHandle.close().catch(() => {});
									}
								});
							};
						})(),
					}
				: {}),
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getEvalKernelOwnerId: () => evalKernelOwnerId,
			assertEvalExecutionAllowed: () => session?.assertEvalExecutionAllowed(),
			trackEvalExecution: (execution, abortController) =>
				session ? session.trackEvalExecution(execution, abortController) : execution,
			getAsyncJobManager: () => asyncJobManager,
			waitForUserSteering: signal => {
				if (agent) return agent.waitForSteeringArrival(signal);
				const { promise, resolve } = Promise.withResolvers<void>();
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
				return promise;
			},
			// Subagents inherit the parent's manager; its registered endpoint is
			// authoritative for owned-registration keying and endpoint-first
			// manager lookup (the child's own id is never registered), so tools
			// pass the same endpoint the manager's completion callback resolves
			// (review thread P1). For a top-level session this equals the
			// session id.
			getSessionId: () => AsyncJobManager.endpointIdOf(asyncJobManager) ?? asyncJobEndpointId,
			registerForegroundFoldParticipant: adapter =>
				session?.registerForegroundFoldParticipant(adapter) ?? (() => {}),
			hasForegroundBashBackgroundRequestHandler: () => session?.hasForegroundBashBackgroundRequestHandler() ?? false,
			requestForegroundBashBackground: (reason, adapter) =>
				Promise.resolve(session?.requestForegroundBashBackground(reason, adapter) ?? false),
			getToolInterruptPolicy: () => agent?.getToolInterruptPolicy() ?? "abort_tools",

			getSessionHome: () => getTrustedHomeDir(),
			getCredentialSessionId: () => session?.credentialSessionId ?? credentialSessionId,
			getMcpManager: () => mcpManager ?? options.inheritedMcpManager,
			isManagedSessionDestination: () => sessionManager.isManagedDestination(),
			getActiveSkillState: () => session?.getActiveSkillState(),
			getActiveSkillPhase: () => session?.getActiveSkillPhase(),
			getDeepInterviewAskStage: () => session?.getDeepInterviewAskStage(),
			getHindsightSessionState: () => session?.getHindsightSessionState(),
			getSessionAgentDir: () => agentDir,
			get model() {
				return agent?.state.model ?? model;
			},
			get serviceTier() {
				// Live parent service-tier intent (e.g. runtime `/fast on|off`), inherited
				// by `inherit` subagents. Only fall back to the startup tier when there is
				// no live agent yet — never `??`, or an intentional `/fast off`
				// (serviceTier === undefined) would be resurrected to the startup value.
				return agent ? agent.serviceTier : initialServiceTier;
			},
			isFastForSubagentProvider: (provider, supportsServiceTier) =>
				session?.isFastForSubagentProvider(provider, supportsServiceTier) ?? false,
			getAgentId: () => resolvedAgentId,
			bashAllowedPrefixes: options.bashAllowedPrefixes,
			bashRestrictionProfile: options.bashRestrictionProfile,
			goalToolAllowedOps: options.goalToolAllowedOps,
			discoverableToolAllowedNames: options.discoverableToolAllowedNames,
			getToolByName: name => session?.getToolByName(name),
			getToolForExecution: name => session?.getToolForExecution(name),
			agentRegistry,
			getSessionSpawns: () => options.spawns ?? "*",
			getMasterBashCapability: () => masterModeContext?.getCapability(),
			getMasterOwnerSessionId: () => masterModeContext?.ownerSessionId,
			getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
			getActiveModelString,
			getPlanModeState: () => session?.getPlanModeState(),
			getGoalModeState: () => session?.getGoalModeState(),
			getWorkflowGateEmitter: () => session?.getWorkflowGateEmitter(),
			getAskAnswerSource: () => session?.getAskAnswerSource(),
			getGoalRuntime: () => session?.goalRuntime,
			getClientBridge: () => session?.clientBridge,
			getCompactContext: () => session.formatCompactContext(),
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			// Generic tool discovery (unified — covers built-in + MCP + extension)
			isToolDiscoveryEnabled: () => session.isToolDiscoveryEnabled(),
			getDiscoverableTools: filter => session.getDiscoverableTools(filter),
			getDiscoverableToolSearchIndex: () => session.getDiscoverableToolSearchIndex(),
			getSelectedDiscoveredToolNames: () => session?.getSelectedDiscoveredToolNames() ?? [],
			activateDiscoveredTools: toolNames => session.activateDiscoveredTools(toolNames),
			getCheckpointState: () => session.getCheckpointState(),
			setCheckpointState: state => session.setCheckpointState(state ?? undefined),
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: name => {
				const m = session.model;
				return m ? buildNamedToolChoice(name, m) : undefined;
			},
			buildToolChoiceResult: name => buildNamedToolChoiceResult(name, session.model),
			sendCustomMessage: (msg, opts) => session.sendCustomMessage(msg, opts),
			purgeQueuedCustomMessages: predicate => session.purgeQueuedCustomMessages(predicate),
			peekQueueInvoker: () => session.peekQueueInvoker(),
			peekStandingResolveHandler: () => session.peekStandingResolveHandler(),
			setStandingResolveHandler: handler => session.setStandingResolveHandler(handler),
			allocateOutputArtifact: async toolType => {
				try {
					return await sessionManager.allocateArtifactPath(toolType);
				} catch {
					return {};
				}
			},
			getArtifactManager: () => sessionManager.getArtifactManager(),
			isArtifactManagerAuthorized: manager => sessionManager.isArtifactManagerAuthorized(manager),
			adoptArtifactManager: manager => sessionManager.adoptArtifactManager(manager),
			releaseArtifactManager: manager => sessionManager.releaseArtifactManager(manager),
			ensureArtifactManager: () => sessionManager.ensureArtifactManager(),
			registerSessionCleanup: cleanup => session?.registerToolSessionTransitionCleanup(cleanup) ?? (() => {}),
			mcpConfigPath: explicitMcpConfigPath,
			settings,
			authStorage,
			modelRegistry,
			getTelemetry: () => agent?.telemetry,
			buildForkContextSeed: forkOptions => session.buildForkContextSeed(forkOptions),
		};

		// Wire process-wide internal URL singletons owned by their real classes.
		// Top-level sessions install the active snapshots; subagents inherit them.
		// Artifact and agent-output URLs resolve against explicitly authorized
		// directories only (see `authorizedArtifactsDirsFromContext`): the
		// caller's own `sessionManager.getArtifactsDir()` plus, when this session
		// adopted a shared `ArtifactManager` (subagent tree membership),
		// `getAuthorizedArtifactsDirs` below. There is no registry-wide lookup.
		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		const localProtocolOptions = options.localProtocolOptions ?? {
			getArtifactsDir,
			isManagedDestination: () => sessionManager.isManagedDestination(),
			getManagedLegacyLocalMigrationSource: () => sessionManager.getManagedLegacyLocalMigrationSource(),
			getSessionId: () => sessionManager.getSessionId(),
			getCredentialSessionId: () => credentialSessionId,
		};
		if (!options.parentTaskPrefix) {
			setActiveSkills(skills);
			setActiveRules([...rulebookRules, ...alwaysApplyRules]);
			// Claim process-cwd authority for the FIRST top-level session launched at
			// the process cwd. A later sibling launched at the same root does not get
			// the claim, so its rescope leaves process-global state (chdir,
			// capabilities, plugin caches, browser tab cwd) untouched.
			if (!isCanonicalSubSession && path.resolve(process.cwd()) === path.resolve(sessionManager.getCwd())) {
				processCwdClaimed = SessionManager.claimProcessCwdOwnership(sessionManager);
			}
			if (asyncJobManager) {
				// Register under the session endpoint so concurrent sessions'
				// owned work settles in the correct manager (review thread P1).
				// `session` is not yet constructed here; the provider identity is
				// the endpoint identity. ADMIT THE ENDPOINT FIRST: a second
				// top-level session constructed or resumed under an endpoint id
				// already held by another LIVE manager must fail construction
				// BEFORE the global instance is replaced — otherwise the
				// rejected construction leaves this orphan manager as the
				// process-global instance, redirecting global-manager
				// consumers away from the live session (review thread P1).
				if (!AsyncJobManager.registerForEndpoint(asyncJobEndpointId, asyncJobManager)) {
					throw new Error(
						`Cannot construct session "${asyncJobEndpointId}": the endpoint id is already held by another live async job manager`,
					);
				}
				asyncJobManagerAdmitted = true;
				priorAsyncJobManager = AsyncJobManager.instance();
				AsyncJobManager.setInstance(asyncJobManager);
			}
		}
		await initializeLocalRoot(localProtocolOptions);
		if (options.localProtocolOptions) {
			disposeLocalProtocolOverride = LocalProtocolHandler.installOverride(options.localProtocolOptions);
		}
		toolSession.getArtifactsDir = getArtifactsDir;
		// Live parent profile accessor for task/subagent dispatch: profile-owned
		// persisted model overrides may resolve through preset-equivalent aliases
		// only while an active profile claims them (see task/executor.ts).
		(toolSession as ToolSession & { getActiveModelProfile?: () => string | undefined }).getActiveModelProfile = () =>
			session?.getActiveModelProfile();
		toolSession.getAuthorizedArtifactsDirs = () => {
			const manager = sessionManager.getArtifactManager();
			return manager ? [manager.dir] : [];
		};
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);

		// Create built-in tools (already wrapped with meta notice formatting)
		const builtinTools = await logger.time(
			"createAllTools",
			createTools,
			toolSession,
			options.toolNames,
			automationTools,
		);

		// A top-level session loads MCP tools from three bounded surfaces: a
		// caller-supplied exact config (`--mcp-config`), conventional native
		// user/project registrations (`~/.gjc/agent/mcp.json` and `.gjc/mcp.json`
		// written by `gjc mcp add`; disabled by `--no-mcp`), and plugin-bundle
		// MCP servers (created below after `customTools` is populated). Existing
		// caller-supplied managers remain available for legacy in-process callers.
		const customTools: CustomTool[] = [];
		const exactMcpToolNames: string[] = [];
		const pluginMcpToolNames: string[] = [];
		const conventionalMcpToolNames: string[] = [];
		let deferredExactMcpConfig: { manager: MCPManager; configPath: string } | undefined;

		// Add image tools when an image role model is configured.
		const { getImageGenTools } = await import("../tools/image-gen");
		const imageGenTools = await logger.time("getImageGenTools", () => getImageGenTools(modelRegistry, settings));
		if (imageGenTools.length > 0) {
			customTools.push(...(imageGenTools as unknown as CustomTool[]));
		}
		// Add web search tools
		if (options.toolNames?.includes("web_search")) {
			const { getSearchTools } = await import("../web/search");
			customTools.push(...getSearchTools(settings));
		}

		const getReservedSubskillToolNames = () => [
			...new Set([
				...builtinTools.map(tool => tool.name),
				...(options.toolNames?.map(name => name.toLowerCase()) ?? []),
				...(options.customTools?.map(tool => (isCustomTool(tool) ? tool.name : tool.name)) ?? []),
				...customTools.map(tool => tool.name),
			]),
		];
		// Registry load performs v1-to-v2 metadata migration without importing
		// plugin implementations. Keep this declaration phase before any subskill
		// tool activation so an entry cannot be live on both paths.
		const gjcToolDeclarations = await getGjcPluginToolDeclarations(cwd, agentDir);

		const gjcSubskillToolContext = options.gjcSubskillToolContext;
		if (gjcSubskillToolContext?.parent.trim() && gjcSubskillToolContext.phase.trim()) {
			const pluginTools = await loadActiveSubskillTools({
				cwd: gjcSubskillToolContext.cwd ?? cwd,
				sessionId: gjcSubskillToolContext.sessionId ?? logicalSessionId,
				parent: gjcSubskillToolContext.parent,
				phase: gjcSubskillToolContext.phase,
				reservedToolNames: getReservedSubskillToolNames(),
				agentDir,
			});
			if (pluginTools.length > 0) {
				customTools.push(...pluginTools);
			}
		} else {
			for (const skill of skills) {
				const phase = await resolveCurrentPhaseForParent({
					cwd,
					sessionId: logicalSessionId,
					parent: skill.name,
				});
				const pluginTools = await loadActiveSubskillTools({
					cwd,
					sessionId: logicalSessionId,
					parent: skill.name,
					phase,
					reservedToolNames: getReservedSubskillToolNames(),
					agentDir,
				});
				if (pluginTools.length > 0) {
					customTools.push(...pluginTools);
				}
			}
		}

		// GJC bundle runtime evidence for this activation. Producers below return
		// findings into this caller-owned accumulator and never publish; exactly one
		// complete snapshot is published once every producer has run.
		const gjcRuntimeStore = new GjcRuntimeSnapshotStore();
		let gjcProducersComplete = true;
		let gjcActivationGeneration = 0;
		try {
			gjcActivationGeneration = gjcActivationGenerationFor(await currentActivationFingerprint({ cwd, agentDir }));
		} catch (error) {
			// Without a readable activation generation no snapshot can be proven
			// current, so publish nothing rather than a snapshot consumers cannot
			// validate against.
			gjcProducersComplete = false;
			logger.warn("Failed to derive GJC bundle activation generation", { error: safeErrorForLog(error) });
		}
		const gjcFindings = new GjcRuntimeFindingAccumulator(gjcActivationGeneration);

		// Always-on GJC plugin bundle tools (validated registry surfaces). This is
		// additive and a no-op when no plugins are installed for the cwd. Surfaces
		// are hash-verified and collision-checked; declared names are authoritative.
		try {
			const pluginToolResult = await loadAlwaysOnPluginTools({
				cwd,
				reservedToolNames: [...getReservedSubskillToolNames(), ...customTools.map(tool => tool.name)],
				declarations: gjcToolDeclarations,
				agentDir,
			});
			if (pluginToolResult.tools.length > 0) {
				customTools.push(...pluginToolResult.tools);
				cwdCapturingToolNames.push(...pluginToolResult.tools.map(tool => tool.name));
			}
			for (const q of pluginToolResult.quarantine) {
				gjcFindings.add({ identity: q.identity, surfaceId: q.surfaceId, code: q.code, message: q.message });
				logger.warn("Quarantined GJC plugin surface", { plugin: q.plugin, surface: q.surfaceId, code: q.code });
			}
		} catch (error) {
			gjcProducersComplete = false;
			logger.warn("Failed to load always-on GJC plugin tools", { error: safeErrorForLog(error) });
		}

		const preExactCustomToolNames = customTools.map(tool => tool.name);
		if (explicitMcpConfigPath !== undefined) {
			const owned = new MCPManager(cwd, null, {
				toolsOnly: true,
				sharedPoolIdleMs: settings.get("mcp.sharedPoolIdleMs"),
				agentDir,
				settings,
				...(lifecycleMcpStartupTimeoutMs !== undefined
					? { maxStartupTimeoutMs: lifecycleMcpStartupTimeoutMs }
					: {}),
			});
			owned.setAuthStorage(authStorage);
			mcpManager = owned;
			ownsMcpManager = true;
			cleanupOwnedMcpManager = () => owned.disconnectAll();
			if (options.deferMcpConfigStartup) {
				deferredExactMcpConfig = { manager: owned, configPath: explicitMcpConfigPath };
			} else {
				const result = await owned.discoverAndConnect({ configPath: explicitMcpConfigPath });
				const resultTools = result.tools as CustomTool[];
				exactMcpToolNames.push(...resultTools.map(tool => tool.name));
				customTools.push(...resultTools);
				cwdCapturingToolNames.push(...resultTools.map(tool => tool.name));
				if (result.errors.size > 0 || result.tools.length === 0) {
					logger.warn("MCP tools could not be loaded.");
				}
			}
		} else if (!mcpManager && !isCanonicalSubSession) {
			// Conventional MCP autoload: top-level standalone sessions consume
			// enabled registrations from GJC's own native configs — project
			// `.gjc/mcp.json` and user `~/.gjc/agent/mcp.json` (written by
			// `gjc mcp add`). Native project scope wins over native user scope on
			// name collisions (capability priority), and plugin-bundle MCPs below
			// override conventional entries with the same name. Claude Code/Codex
			// MCP files are explicit import sources into `.gjc` (#4291), never
			// implicit runtime authorities here. `--no-mcp` opts a session out;
			// `--mcp-config` exact-file sessions never reach here. The owned manager's
			// tools are surfaced as always-on custom tools (like plugin MCPs), so an
			// ordinary session exposes them without needing MCP discovery mode.
			let conventionalConfigs: Record<string, MCPServerConfig> = {};
			let conventionalSources: Record<string, SourceMeta> = {};
			if (options.enableMcpAutoload !== false) {
				try {
					const loaded = await loadAllMCPConfigs(cwd, {
						// User scope is this session's agent directory, the same file
						// `gjc mcp add` (user scope) writes; an SDK embedder that runs on
						// its own agent directory autoloads its own registrations.
						agentDir,
						// Project-scope native config loads by default; only an
						// explicitly configured `mcp.enableProjectConfig: false`
						// disables it (the legacy schema default stays false for
						// foreign-format discovery consumers of the capability system).
						enableProjectConfig: settings.has("mcp.enableProjectConfig")
							? settings.get("mcp.enableProjectConfig")
							: true,
						autoloadOnly: true,
						// Runtime authority is GJC's native `.gjc` config in both scopes;
						// Claude Code/Codex MCP files are explicit import sources into
						// `.gjc`, not implicit competing runtime authorities.
						nativeOnly: true,
						settings,
					});
					conventionalConfigs = loaded.configs;
					conventionalSources = loaded.sources;
					for (const warning of loaded.warnings) {
						logger.warn("MCP conventional discovery warning", { warning });
					}
					if (loaded.configurationWarning) {
						logger.warn("MCP configuration unavailable.");
					}
				} catch (error) {
					logger.warn("Failed to discover conventional MCP servers", { error: safeErrorForLog(error) });
				}
			}
			// Always-on GJC plugin-bundle MCP servers, merged over conventional
			// servers on name collisions. Top-level sessions own a manager and
			// connect the validated servers; subagents inherit the parent's manager
			// via options.mcpManager and never spawn their own (prevents duplicate
			// processes and leaks). Per the plugin product contract, connected MCP
			// tools are surfaced as always-on tools rather than gated behind MCP
			// selection.
			try {
				const { configs, sources: pluginSources, quarantine } = await buildPluginMcpConfigs({ cwd, agentDir });
				for (const q of quarantine) {
					gjcFindings.add({ identity: q.identity, surfaceId: q.surfaceId, code: q.code, message: q.message });
					logger.warn("Quarantined GJC plugin MCP", { plugin: q.plugin, surface: q.surfaceId, code: q.code });
				}
				const pluginNames = new Set(Object.keys(configs));
				const mergedConfigs = { ...conventionalConfigs, ...configs };
				const mergedSources = {
					...conventionalSources,
					...pluginSources,
				};
				if (Object.keys(mergedConfigs).length > 0) {
					const owned = new MCPManager(cwd, null, {
						sharedPoolIdleMs: settings.get("mcp.sharedPoolIdleMs"),
						agentDir,
						settings,
					});
					owned.setAuthStorage(authStorage);
					cleanupOwnedMcpManager = () => owned.disconnectAll();
					try {
						const result = await owned.connectServers(mergedConfigs, mergedSources as never);
						for (const [server, err] of result.errors) {
							// A server that failed to connect leaves this generation
							// incomplete: its surfaces produced no evidence, so publishing
							// would present a partial pass as a clear one.
							gjcProducersComplete = false;
							logger.warn("GJC plugin MCP connect failed", {
								path: `mcp:${server}`,
								error: safeErrorForLog(err),
							});
						}
						const connectedPluginNames = new Set(result.connectedServers.filter(name => pluginNames.has(name)));
						// Retain while any conventional server is still live: "connecting"
						// covers the declared-timeout window, and a server that landed in
						// "connected" inside the microtask between connectServers() resolving
						// and this synchronous check must not be torn down either.
						const unsettledConventionalNames = Object.keys(conventionalConfigs).filter(
							name => owned.getConnectionStatus(name) !== "disconnected",
						);
						const retainOwnedManager =
							result.connectedServers.length > 0 || unsettledConventionalNames.length > 0;
						if (retainOwnedManager) {
							mcpManager = owned;
							ownsMcpManager = true;
							customTools.push(...(result.tools as CustomTool[]));
							cwdCapturingToolNames.push(...result.tools.map(tool => tool.name));
							for (const name of Object.keys(conventionalConfigs)) ownedConventionalMcpServerNames.add(name);
							pluginMcpManagerServers.set(owned, connectedPluginNames);
							conventionalMcpManagerServers.set(owned, new Set(Object.keys(conventionalConfigs)));
							for (const tool of result.tools) {
								const serverName = tool.mcpServerName;
								if (serverName === undefined) continue;
								if (connectedPluginNames.has(serverName)) pluginMcpToolNames.push(tool.name);
								else {
									conventionalMcpToolNames.push(tool.name);
									ownedConventionalMcpToolNames.push(tool.name);
								}
							}
							publishOwnedConventionalMcpTools = ownedConventionalMcpServerNames.size > 0;
							ownedPluginServersConnected = connectedPluginNames.size > 0;
							// Plugin-bundle connections are fixed for the session lifetime only
							// when no conventional server is still connecting in the same manager;
							// otherwise the seal is re-applied once they settle (below).
							if (connectedPluginNames.size > 0 && unsettledConventionalNames.length === 0)
								owned.sealConnectionSet();
						} else {
							try {
								await owned.disconnectAll();
								cleanupOwnedMcpManager = undefined;
							} catch (cleanupError) {
								cleanupOwnedMcpManager = undefined;
								throw new McpManagerCleanupError(cleanupError);
							}
						}
					} catch (error) {
						if (safeIsInstanceOf(error, McpManagerCleanupError)) throw error;
						// Avoid leaking partially-started server processes on failure.
						let cleanupError: unknown;
						try {
							await owned.disconnectAll();
						} catch (disconnectError) {
							cleanupError = disconnectError;
						} finally {
							cleanupOwnedMcpManager = undefined;
						}
						if (cleanupError !== undefined) throw attachMcpCleanupDiagnostic(error, cleanupError);
						throw error;
					}
				}
			} catch (error) {
				if (safeIsInstanceOf(error, McpManagerCleanupError)) throw error;
				gjcProducersComplete = false;
				const cleanupDiagnostic = safeReadCleanupDiagnostic(error);
				logger.warn("Failed to wire GJC plugin MCP servers", {
					error: safeErrorForLog(error),
					cleanupDiagnostic: safeCleanupDiagnosticForLog(cleanupDiagnostic),
				});
			}
		} else if (isCanonicalSubSession) {
			// Subagents inherit the parent's always-on plugin and conventional MCP
			// tools WITHOUT owning the manager (no connect, no callbacks, no
			// disposal). The facade is carried explicitly by the parent session
			// scope; process-global state is never consulted for MCP routing.
			const inherited = mcpManager ?? options.inheritedMcpManager;
			if (inherited) {
				try {
					const inheritedTools = inherited.getTools();
					if (inheritedTools.length > 0) customTools.push(...(inheritedTools as CustomTool[]));
					const pluginServers = pluginMcpManagerServers.get(inherited);
					const conventionalServers = conventionalMcpManagerServers.get(inherited);
					for (const tool of inheritedTools) {
						const serverName = tool.mcpServerName;
						if (serverName === undefined) continue;
						if (pluginServers?.has(serverName)) pluginMcpToolNames.push(tool.name);
						else if (conventionalServers?.has(serverName)) conventionalMcpToolNames.push(tool.name);
					}
				} catch (error) {
					logger.warn("Failed to inherit MCP tools in subagent", { error: safeErrorForLog(error) });
				}
			}
		}
		// MCP routing is scope-held; no process-global manager registration.

		// General extension discovery is quarantined from the public SDK surface.
		// Recognized hook conventions are the bounded exception: their descriptors
		// normalize before import and then adapt into the authoritative ExtensionRunner.
		const inlineExtensions: ExtensionFactory[] = [...(options.extensions ?? [])];
		const discoveredHookExtensions: Array<{ factory: ExtensionFactory; name: string }> = [];
		if (customTools.length > 0) {
			inlineExtensions.push(createCustomToolsExtension(customTools));
		}
		if (!options.disableExtensionDiscovery) {
			try {
				const hookExtensions = await discoverAndLoadHookExtensions(
					options.hookPaths ?? [],
					cwd,
					agentDir,
					settings,
				);
				discoveredHookExtensions.push(...hookExtensions.factories);
				for (const error of hookExtensions.errors) {
					logger.warn("Rejected discovered hook", { path: error.path, error: error.error });
				}
			} catch (error) {
				logger.warn("Failed to discover hook extensions", { error: safeErrorForLog(error) });
			}
		}

		// Always-on constrained plugin hooks (validated registry surfaces). Additive
		// and a no-op without installed plugins; the loader denies all dangerous APIs.
		try {
			const pluginHookResult = await loadConstrainedPluginHooks({ cwd, agentDir });
			if (pluginHookResult.hooks.length > 0) {
				inlineExtensions.push(createPluginHooksExtension(pluginHookResult.hooks));
			}
			for (const q of pluginHookResult.quarantine) {
				gjcFindings.add({ identity: q.identity, surfaceId: q.surfaceId, code: q.code, message: q.message });
				logger.warn("Quarantined GJC plugin hook", { plugin: q.plugin, surface: q.surfaceId, code: q.code });
			}
		} catch (error) {
			gjcProducersComplete = false;
			logger.warn("Failed to load constrained GJC plugin hooks", { error: safeErrorForLog(error) });
		}

		let notificationCfg: NotificationConfig | undefined;
		try {
			notificationCfg = getNotificationConfig(settings);
		} catch {
			notificationCfg = undefined;
		}
		const isTopLevelSdkSession = !isCanonicalSubSession;
		// Consume the GJC spawn-provenance marker: read it once, then remove it
		// from this process's env so it is never re-inherited by children this
		// session later spawns (marker is per-spawn, not dynastic — each GJC child
		// spawn site sets it explicitly). Suppression under `sessionScope=primary`
		// keeps auto-spawned children (team workers, harness owners) silent while
		// explicit SDK session opt-in (GJC_NOTIFICATIONS=1) still wins.
		const spawnProvenance = process.env[SPAWN_PROVENANCE_ENV];
		const spawnedByGjc = typeof spawnProvenance === "string" && spawnProvenance.trim().length > 0;
		delete process.env[SPAWN_PROVENANCE_ENV];
		const notificationHostEligible = isGenericNotificationHostEligible({
			env: process.env,
			hostModeSupported: options.notificationHostModeSupported ?? true,
			taskDepth,
			parentTaskPrefix: options.parentTaskPrefix,
			currentAgentType: options.currentAgentType,
			sessionScope: notificationCfg?.sessionScope,
			spawnedByGjc,
		});
		const notificationSessionController = new NotificationSessionController({
			eligible: notificationHostEligible,
			getConfig: () => getNotificationConfig(settings),
			spawnedByGjc,
		});
		const notificationsExtensionEligible = Boolean(
			lifecycleStartupCapability ||
				shouldRegisterGenericNotificationsExtension({
					env: process.env,
					cfg: notificationCfg,
					taskDepth,
					parentTaskPrefix: options.parentTaskPrefix,
					currentAgentType: options.currentAgentType,
					spawnedByGjc,
				}),
		);
		const sdkHostEligible =
			shouldHostSdk(notificationCfg, isTopLevelSdkSession) && (options.sdkHostModeSupported ?? true);
		const notificationAdapterService = createLazyService({
			id: "sdk.notifications.adapters",
			enabled: () => notificationsExtensionEligible || sdkHostEligible,
			initialize: async () => ({
				value: (await import("../sdk/bus")).createNotificationsExtension,
			}),
		});
		if (notificationsExtensionEligible || sdkHostEligible) {
			inlineExtensions.push(async api => {
				try {
					if (autoroutingInactive) markAutoroutingInactive(api);
					if (lifecycleStartupCapability) attachLifecycleStartupCapability(api, lifecycleStartupCapability);
					if (lifecycleStartupCapability && process.env.GJC_SDK_TEST_FACTORY_FAILURE === cwd)
						throw new Error(process.env.GJC_SDK_TEST_FACTORY_SECRET ?? "Lifecycle factory test failure.");
					if (notificationsExtensionEligible) {
						const createNotificationsExtension = await notificationAdapterService.get("session-extension");
						createNotificationsExtension(api, {
							settings,

							controller: notificationSessionController,
							spawnedByGjc,
							sdkHostModeSupported: options.sdkHostModeSupported,
							...(masterModeContext
								? {
										masterCapability: masterModeContext.getCapability(),
										masterAttestationEpoch: masterModeContext.attestationEpoch,
										masterOwnerSessionId: masterModeContext.ownerSessionId,
									}
								: {}),
							// INTERNAL terminal-abort seams, threaded directly from the
							// owning session (NOT on the public extension context).
							terminalAbortSeams: {
								getTerminalTurnEpoch: () => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									return session.getTerminalTurnEpoch();
								},
								cancelPendingPreflightForTerminalAbort: () => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									session.cancelPendingPreflightForTerminalAbort();
								},
								captureTerminalAbortSteeringSnapshot: () => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									return session.captureTerminalAbortSteeringSnapshot();
								},
								discardTerminalAbortSteeringSnapshot: (token: number) => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									session.discardTerminalAbortSteeringSnapshot(token);
								},
								rebindTerminalAbortSteeringSnapshot: (token: number) => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									session.rebindTerminalAbortSteeringSnapshot(token);
								},
								abortPromptAndWaitWithTerminal: (handle, seamOptions) => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									return session.abortPromptAndWait(handle, seamOptions);
								},
							},
							ensureProviderDaemon: options.ensureNotificationProviderDaemon,
							runBtwTurn: async (question, signal) => {
								if (!session) throw new Error("Ephemeral turns are unavailable.");
								const { replyText } = await session.runEphemeralTurn({
									purpose: "btw",
									turn: { question, scope: session.createBtwConversationScope(btwUserPrompt) },
									signal,
								});
								return { replyText };
							},
						});
					} else if (sdkHostEligible) {
						registerSdkOnlyNotificationCommand(api);
						let sdkOnlyReconciliationStore:
							| { sessionId: string; sessionFile: string | undefined; store: ReconciliationStore }
							| undefined;
						createSdkSessionRuntimeExtension(api, {
							agentDir,
							brokerRegistrationRequired: lifecycleStartupCapability !== undefined,
							...(lifecycleStartupCapability?.lifecycleRequestId
								? { lifecycleRequestId: lifecycleStartupCapability.lifecycleRequestId }
								: {}),
							createTransport: input => createSdkWebSocketTransport(input),
							settings,
							configOverrides: new Map(),
							...(masterModeContext
								? {
										masterCapability: masterModeContext.getCapability(),
										masterAttestationEpoch: masterModeContext.attestationEpoch,
										masterOwnerSessionId: masterModeContext.ownerSessionId,
									}
								: {}),
							// INTERNAL terminal-abort seams, threaded directly from the
							// owning session (NOT on the public extension context).
							terminalAbortSeams: {
								getReconciliationStore: () => {
									const sessionId = sessionManager.getSessionId();
									const sessionFile = sessionManager.getSessionFile();
									// session_switch/session_branch may move to a DIFFERENT transcript
									// that retains the same copied session id: the store must be
									// recreated (keyed by session id AND file path, including a
									// null-to-file transition) or the successor reads/writes the
									// predecessor's reconciliation file, spuriously replaying or
									// conflicting with its keys and losing its own replay authority
									// after restart (review thread P2).
									if (
										!sdkOnlyReconciliationStore ||
										!sdkOnlyStoreMatches(sdkOnlyReconciliationStore, sessionId, sessionFile)
									) {
										sdkOnlyReconciliationStore = {
											sessionId,
											sessionFile,
											store: createReconciliationStore({
												sessionFile,
												sessionId,
											}),
										};
									}
									return sdkOnlyReconciliationStore.store;
								},
								getTerminalTurnEpoch: () => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									return session.getTerminalTurnEpoch();
								},
								getActivePromptHandle: () => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									return session.activePromptHandle;
								},
								cancelPendingPreflightForTerminalAbort: () => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									session.cancelPendingPreflightForTerminalAbort();
								},
								captureTerminalAbortSteeringSnapshot: () => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									return session.captureTerminalAbortSteeringSnapshot();
								},
								discardTerminalAbortSteeringSnapshot: (token: number) => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									session.discardTerminalAbortSteeringSnapshot(token);
								},
								rebindTerminalAbortSteeringSnapshot: (token: number) => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									session.rebindTerminalAbortSteeringSnapshot(token);
								},
								abortPromptAndWaitWithTerminal: (handle, seamOptions) => {
									if (!session) throw new Error("Terminal abort session is not initialized.");
									return session.abortPromptAndWait(handle, seamOptions);
								},
							},
						});
					}
				} catch (error) {
					lifecycleStartupCapability?.settleFailure(
						lifecycleStartupCapability.normalizeFailure("registration", "factory_absent", error),
					);
					throw error;
				}
			});
		}

		// Extension/module discovery is quarantined; retain only the private
		// runtime needed for bundled product extensions, explicitly supplied SDK
		// extension factories, and custom tools. Filesystem extension paths remain
		// ignored here even when options.additionalExtensionPaths is supplied.
		const extensionsResult: LoadExtensionsResult = options.preloadedExtensions ?? {
			extensions: [],
			errors: [],
			runtime: new ExtensionRuntime(),
		};

		if (!extensionsResult.extensions.some(extension => extension.path === BUNDLED_GROK_BUILD_EXTENSION_ID)) {
			const bundledGrokExtension = await loadExtensionFromFactory(
				getBundledGrokBuildExtensionFactory(),
				cwd,
				eventBus,
				extensionsResult.runtime,
				BUNDLED_GROK_BUILD_EXTENSION_ID,
			);
			extensionsResult.extensions.push(bundledGrokExtension);
		}

		// Load inline extensions from factories
		if (inlineExtensions.length > 0) {
			for (let i = 0; i < inlineExtensions.length; i++) {
				const factory = inlineExtensions[i];
				const loaded = await loadExtensionFromFactory(
					factory,
					cwd,
					eventBus,
					extensionsResult.runtime,
					`<inline-${i}>`,
				);
				extensionsResult.extensions.push(loaded);
			}
		}
		for (const entry of discoveredHookExtensions) {
			const loaded = await loadExtensionFromFactory(
				entry.factory,
				cwd,
				eventBus,
				extensionsResult.runtime,
				entry.name,
			);
			extensionsResult.extensions.push(loaded);
		}

		// Process provider registrations queued during extension loading.
		// This must happen before the runner is created so that models registered by
		// extensions are available for model selection on session resume / fallback.
		const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
		modelRegistry.syncExtensionSources(activeExtensionSources);
		for (const sourceId of new Set(activeExtensionSources)) {
			modelRegistry.clearSourceRegistrations(sourceId);
		}
		if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
			for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
				modelRegistry.registerProvider(name, config, sourceId);
			}
			extensionsResult.runtime.pendingProviderRegistrations = [];
		}

		let startupCredentialModelRejected = false;
		if (startupModelReference && (startupCredentialSelector || startupCredentialProviderMismatch)) {
			const validated =
				!startupCredentialProviderMismatch &&
				startupCredentialSelector !== undefined &&
				modelRegistry.validateModelForStoredLiteralCredential(
					startupModelReference.provider,
					startupModelReference.id,
					startupCredentialSelector,
				);
			const currentStartupModel = modelRegistry.find(startupModelReference.provider, startupModelReference.id);
			const providerMismatchRejectsTarget =
				startupCredentialProviderMismatch &&
				modelRegistry.requiresStoredLiteralCredentialCacheAdmission(
					startupModelReference.provider,
					startupModelReference.id,
				);
			if (
				(!validated && (startupCredentialSelector !== undefined || providerMismatchRejectsTarget)) ||
				!currentStartupModel
			) {
				startupCredentialModelRejected = true;
				if (model?.provider === startupModelReference.provider && model.id === startupModelReference.id) {
					model = undefined;
				}
				modelFallbackMessage = `Model "${
					options.modelPattern ?? `${startupModelReference.provider}/${startupModelReference.id}`
				}" not found`;
			} else if (model?.provider === startupModelReference.provider && model.id === startupModelReference.id) {
				model = currentStartupModel;
			}
		}

		// Resolve deferred --model pattern now that extension models are registered.
		if (!model && options.modelPattern && !startupCredentialModelRejected) {
			const availableModels = modelRegistry.getAll();
			const matchPreferences = {
				usageOrder: settings.getStorage()?.getModelUsageOrder(),
			};
			const { model: resolved, thinkingLevel: resolvedThinkingLevel } = parseModelPattern(
				options.modelPattern,
				availableModels,
				matchPreferences,
				{
					modelRegistry,
					sessionId: logicalSessionId,
					credentialSessionId,
				},
			);
			if (resolved) {
				model = resolved;
				modelFallbackMessage = undefined;
				if (resolvedThinkingLevel !== undefined) {
					thinkingLevel = resolvedThinkingLevel;
					thinkingLevelFromSchemaDefault = false;
				}
				if (thinkingLevelFromSchemaDefault && resolved.thinking?.defaultLevel !== undefined) {
					thinkingLevel = resolved.thinking.defaultLevel;
					thinkingLevelFromSchemaDefault = false;
				}
				thinkingLevel = resolveThinkingLevelForModel(resolved, thinkingLevel);
			} else {
				modelFallbackMessage = `Model "${options.modelPattern}" not found`;
			}
		}

		// Fall back to first available model with a valid API key, honoring the
		// path-scoped `enabledModels` allow-list when configured. Skip when the
		// user explicitly requested a model via --model that wasn't found.
		if (
			!model &&
			!options.modelPattern &&
			!startupCredentialModelRejected &&
			(configuredDefaultPatterns.length === 0 || preferredCredentialProvider !== undefined)
		) {
			// Re-resolve the allowed set: extension factories above may have
			// registered providers/models that weren't visible at startup.
			const allowedFallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
			// A fresh provider discovery can disprove a bundled model while the
			// general available catalog retains it for offline/profile compatibility.
			// Exclude only those positively disproved bundled entries from the
			// unconfigured startup path; explicit model/profile resolution above keeps
			// its existing precedence and semantics.
			const profileAvailableKeys = new Set(
				modelRegistry
					.getAvailableForProfileActivation()
					.map(candidate => `${candidate.provider}\u0000${candidate.id}`),
			);
			const fallbackCandidates = allowedFallbackCandidates.filter(candidate =>
				profileAvailableKeys.has(`${candidate.provider}\u0000${candidate.id}`),
			);
			// Candidate order is not a quality signal: catalogs sort retired models
			// ahead of current ones whenever their IDs carry older date suffixes, so
			// an unconfigured install would otherwise start on a model its provider
			// has already withdrawn. Sweep each known provider's curated default
			// first — the same table `findInitialModel` consults — and only then fall
			// back to catalog order.
			for (const candidate of orderByProviderDefaultFirst(
				fallbackCandidates,
				modelRegistry.automaticProviderOrder(credentialSessionId),
			)) {
				if (await hasModelApiKey(candidate)) {
					model = candidate;
					break;
				}
			}
			if (model) {
				if (modelFallbackMessage) {
					modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
				}
			} else {
				const patterns = settings.get("enabledModels");
				modelFallbackMessage =
					patterns && patterns.length > 0
						? `No model available matching enabledModels (${patterns.join(", ")}) with usable credentials. ${formatNoModelsAvailableFallback()}`
						: formatNoModelsAvailableFallback();
			}
		}
		if (options.credentialSelector && !options.credentialSelector.provider && model) {
			applyCredentialSelector(credentialSessionId, model.provider, options.credentialSelector.selector);
		}

		if (options.credentialSelector && !options.credentialSelector.provider && !model?.provider) {
			throw new Error(
				`--credential ${options.credentialSelector.raw} requires a resolved model or an explicit provider prefix`,
			);
		}
		// Safety net: every resolution branch above already filters candidates by
		// `preferredCredentialProvider` (session restore, settings default, fallback
		// scan via `hasModelApiKey`), but an explicit `--model`/`--models` request for
		// a different provider takes priority earlier in resolution and would
		// otherwise silently ignore the preference. Fail closed with a clear error
		// instead.
		if (model && preferredCredentialProvider && model.provider !== preferredCredentialProvider) {
			throw new Error(
				`--prefer-credential ${options.preferredCredentialSelector?.raw ?? ""} matches ${preferredCredentialProvider}, but the resolved model uses ${model.provider}`,
			);
		}
		const customCommandsResult: CustomCommandsLoadResult = { commands: [], errors: [] };

		let extensionRunner: ExtensionRunner | undefined;
		if (extensionsResult.extensions.length > 0) {
			extensionRunner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
				{
					kind: isCanonicalSubSession ? "sub" : "main",
					taskDepth,
					...(options.parentTaskPrefix ? { parentTaskPrefix: options.parentTaskPrefix } : {}),
					...(options.currentAgentType ? { currentAgentType: options.currentAgentType } : {}),
				},
				settings,
				() => session?.credentialSessionId ?? credentialSessionId,
			);
		}

		if (extensionRunner) {
			credentialDisabledTarget = extensionRunner;
			for (const event of startupCredentialDisabledEvents.splice(0)) {
				// Discard return: any handler error is routed through runner.onError listeners.
				void extensionRunner.emitCredentialDisabled(event);
			}
		} else {
			// No runner to forward to; release our subscription. The embedder's own
			// onCredentialDisabled (if any) keeps firing through its own subscription.
			startupCredentialDisabledEvents.length = 0;
			releaseCredentialDisabledSubscription();
		}

		const getSessionContext = () => ({
			sessionManager: createReadonlySessionManager(sessionManager),
			modelRegistry,
			get credentialSessionId() {
				return session.credentialSessionId;
			},
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => session.abort(),
			settings,
		});
		const toolContextStore = new ToolContextStore(getSessionContext);

		const registeredTools = extensionRunner?.getAllRegisteredTools() ?? [];
		let wrappedExtensionTools: Tool[];

		if (extensionRunner) {
			// With extension runner: convert CustomTools to ToolDefinitions and wrap all together
			const allCustomTools = [
				...registeredTools,
				...(options.customTools?.map(tool => {
					const definition = isCustomTool(tool) ? customToolToDefinition(tool) : tool;
					return { definition, extensionPath: "<sdk>" };
				}) ?? []),
			];
			wrappedExtensionTools = wrapRegisteredTools(allCustomTools, extensionRunner);
		} else {
			// Without extension runner: wrap CustomTools directly with CustomToolAdapter
			// ToolDefinition items require ExtensionContext and cannot be used without a runner
			const customToolContext = (): CustomToolContext => ({
				sessionManager: createReadonlySessionManager(sessionManager),
				modelRegistry,
				get credentialSessionId() {
					return session?.credentialSessionId ?? credentialSessionId;
				},
				model: agent?.state.model,
				isIdle: () => !session?.isStreaming,
				hasQueuedMessages: () => (session?.queuedMessageCount ?? 0) > 0,
				abort: () => session?.abort(),
				settings: createCustomToolSettings(settings),
			});
			wrappedExtensionTools = (options.customTools ?? [])
				.filter(isCustomTool)
				.map(tool => CustomToolAdapter.wrap(tool, customToolContext));
		}
		const automationToolNames = new Set(Object.keys(automationTools));
		const automationToolCollisions = [
			...new Set(wrappedExtensionTools.map(tool => tool.name).filter(name => automationToolNames.has(name))),
		];
		if (automationToolCollisions.length > 0) {
			throw new Error(
				`SDK automation tools cannot collide with extension or MCP tools: ${automationToolCollisions.join(", ")}`,
			);
		}

		// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
		const toolRegistry = new Map<string, Tool>();
		/**
		 * Identity — not name — provenance for the coordinator-visible tool label.
		 *
		 * Every tool object this builder constructs from a built-in descriptor is recorded
		 * here as it is created, BEFORE extension, MCP, and custom tools overwrite registry
		 * names below. An extension or custom tool that registers itself as `bash` replaces
		 * the registry entry with an object that was never recorded, so the label resolves to
		 * `custom` instead of impersonating the built-in.
		 */
		const builtinToolIdentities = new Set<object>();
		let builtinCandidateTools = [...builtinTools];
		for (const tool of builtinTools) {
			toolRegistry.set(tool.name, tool);
			builtinToolIdentities.add(tool);
		}
		const goalStateToolNames = ["goal"] as const;
		if (settings.get("goal.enabled")) {
			for (const name of goalStateToolNames) {
				if (toolRegistry.has(name)) continue;
				const goalStateTool = await logger.time(
					`createTools:${name}:session`,
					BUILTIN_TOOL_DESCRIPTORS[name].load,
					toolSession,
				);
				if (goalStateTool) {
					const wrappedGoalStateTool = wrapToolWithMetaNotice(goalStateTool);
					builtinCandidateTools.push(wrappedGoalStateTool);
					toolRegistry.set(wrappedGoalStateTool.name, wrappedGoalStateTool);
					builtinToolIdentities.add(wrappedGoalStateTool);
				}
			}
		}
		for (const tool of wrappedExtensionTools) {
			toolRegistry.set(tool.name, tool);
		}
		if (extensionRunner) {
			for (const tool of toolRegistry.values()) {
				const wrapped = new ExtensionToolWrapper(tool, extensionRunner);
				// A wrapper built from a proven built-in inherits that provenance; one built
				// from an extension/custom tool does not.
				if (builtinToolIdentities.has(tool)) builtinToolIdentities.add(wrapped);
				toolRegistry.set(tool.name, wrapped);
			}
		}
		const rawCursorReplaceEditTool = captureCursorEditTool(toolRegistry, () => new EditTool(toolSession, "replace"));
		const cursorReplaceEditTool: AgentTool | undefined = rawCursorReplaceEditTool
			? extensionRunner
				? (new ExtensionToolWrapper(rawCursorReplaceEditTool, extensionRunner) as AgentTool)
				: (rawCursorReplaceEditTool as AgentTool)
			: undefined;
		if (model?.provider === "cursor") {
			toolRegistry.delete("edit");
			builtinCandidateTools = builtinCandidateTools.filter(tool => tool.name !== "edit");
		}

		const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
		if (!hasDeferrableTools) {
			toolRegistry.delete("resolve");
		} else if (!toolRegistry.has("resolve")) {
			const resolveTool = await logger.time("createTools:resolve:session", HIDDEN_TOOLS.resolve, toolSession);
			if (resolveTool) {
				const wrappedResolveTool = wrapToolWithMetaNotice(resolveTool);
				builtinCandidateTools.push(wrappedResolveTool);
				toolRegistry.set(wrappedResolveTool.name, wrappedResolveTool);
				builtinToolIdentities.add(wrappedResolveTool);
			}
		}
		// Exact-config MCP tools cannot claim a name already represented by the final candidate catalog.
		// Other catalog collisions retain their legacy override behavior.
		const exactMcpCatalogToolNames = [
			...builtinCandidateTools.map(tool => tool.name),
			...preExactCustomToolNames,
			...wrappedExtensionTools.map(tool => tool.name),
		];
		if (exactMcpToolNames.length > 0) {
			const collidingToolNames = findExactMcpToolNameCollisions(exactMcpToolNames, exactMcpCatalogToolNames);
			if (collidingToolNames.length > 0) {
				throw new ExactMcpToolNameCollisionError(collidingToolNames);
			}
		}

		const reloadSshTool = async (): Promise<AgentTool | null> => {
			if (!requestedToolNameSet.has("ssh")) return null;
			const { loadSshTool } = await import("../tools/ssh");
			const sshTool = (await loadSshTool({
				...toolSession,
				cwd: sessionManager.getCwd(),
			})) as unknown as AgentTool | null;
			if (!sshTool) return null;
			const wrapped = wrapToolWithMetaNotice(sshTool);
			return (extensionRunner ? new ExtensionToolWrapper(wrapped, extensionRunner) : wrapped) as AgentTool;
		};

		let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
		const cursorExecHandlers = new CursorExecHandlers({
			cwd,
			getCwd: () => sessionManager.getCwd(),
			tools: toolRegistry,
			getEditReplaceTool: () => cursorReplaceEditTool,
			createSearchTool: options => {
				if (!toolRegistry.has("search")) return undefined;
				const search = new SearchTool(toolSession, options);
				return extensionRunner
					? (new ExtensionToolWrapper(search as unknown as AgentTool, extensionRunner) as AgentTool)
					: (search as unknown as AgentTool);
			},
			getToolContext: () => toolContextStore.getContext(),
			emitEvent: event => cursorEventEmitter?.(event),
			createEventEmitter: () => agent.createExternalEventEmitterForCurrentRun(),
		});

		const repeatToolDescriptions = settings.get("repeatToolDescriptions");
		// Re-resolved per prompt build so a profile activated after session start is
		// reflected on the next refresh. Vendor-separated worker roles imply eager
		// delegation unless `task.eager` is configured explicitly.
		const resolveEagerTasks = (): boolean => {
			const profileName = startupActiveModelProfile ?? settings.get("modelProfile.default");
			const resolvedProfileName = profileName ? resolveModelProfileName(profileName, persistedProfiles) : undefined;
			return resolveEagerTaskDelegation({
				settings,
				profile: resolvedProfileName ? persistedProfiles.get(resolvedProfileName) : undefined,
			}).eagerTasks;
		};
		const eagerTasks = resolveEagerTasks();
		const intentTracingEnabled = resolveIntentTracingEnabled(settings.get("tools.intentTracing"), {
			subSession: isCanonicalSubSession,
		});
		const emittedContextFileWarnings = new Set(discoveredContextFileWarnings);
		const contextFileWarnings = [...discoveredContextFileWarnings];
		for (const warning of discoveredContextFileWarnings) {
			logger.warn("Context file discovery warning", { warning });
		}
		const intentField = intentTracingEnabled ? INTENT_FIELD : undefined;
		const rebuildSystemPrompt = async (
			toolNames: string[],
			tools: Map<string, AgentTool>,
			candidateModel?: Model,
		): Promise<BuildSystemPromptResult> => {
			// This callback is reused for later prompt/tool/model rebuilds. Retire
			// the previous generation's evidence up front: from here until a
			// complete pass republishes, consumers must read `unavailable` rather
			// than a snapshot describing a generation that no longer applies.
			// Invalidating at entry (not beside the publish) means an await or a
			// throw in between cannot leave stale evidence readable. The reserved
			// epoch additionally fences overlapping rebuilds, so a slower earlier
			// pass cannot publish over a newer one.
			const gjcPassEpoch = gjcRuntimeStore.beginPass();
			toolContextStore.setToolNames(toolNames);
			const promptTools = (() => {
				const previousPromptMetadataModel = promptMetadataModel;
				promptMetadataModel = candidateModel;
				try {
					const activeModel = candidateModel ?? agent?.state.model ?? model;
					// Codex renames reserved tool names on the wire; the prompt must
					// refer to the tools by the names the model actually receives.
					const overrides =
						activeModel?.api === "openai-codex-responses"
							? Object.fromEntries(
									Array.from(tools.keys())
										.filter(name => codexToolWireName(name) !== name)
										.map(name => [name, { wireName: codexToolWireName(name) }]),
								)
							: {};
					return buildSystemPromptToolMetadata(tools, overrides);
				} finally {
					promptMetadataModel = previousPromptMetadataModel;
				}
			})();
			// Lazy memory services stay idle through the initial prompt build. The legacy
			// startup boundary below is the first activation point; using `peek()` here
			// avoids an eager default-path initialization before that boundary. Startup
			// refreshes the prompt after prewarming so enabled backends still publish their
			// developer instructions before the session is returned.
			const memoryBackend = runtimeServices.memoryBackend.peek();
			const memoryInstructions = memoryBackend
				? await memoryBackend.buildDeveloperInstructions(agentDir, settings, session)
				: undefined;

			const browserBackend = resolveBrowserBackend(settings);
			const appendPrompt =
				[memoryInstructions, browserBackend.developerInstructions].filter(Boolean).join("\n\n") || undefined;
			let pluginSystemAppendices = "";
			try {
				pluginSystemAppendices = await renderAlwaysOnSystemAppendices({ cwd: getLiveCwd(), agentDir });
			} catch (error) {
				gjcProducersComplete = false;
				logger.warn("Failed to render GJC plugin system appendices", { error: safeErrorForLog(error) });
			}

			// Publication point for GJC bundle runtime evidence. Appendix rendering
			// is the last producer, so only here is the generation complete.
			//
			// The previous generation was already retired at callback entry, so a
			// partial pass simply never republishes and consumers keep reading
			// `unavailable` rather than a stale generation.
			if (gjcProducersComplete) gjcRuntimeStore.publish(gjcFindings.snapshot(), gjcPassEpoch);
			const defaultPrompt = await buildSystemPromptInternal({
				// Live cwd: the prompt is rebuilt after a rescope, and describing the
				// retired launcher root there is what makes the model pick wrong paths.
				cwd: getLiveCwd(),
				agentDir,
				settings,
				skills,
				contextFiles,
				tools: promptTools,
				toolNames,
				rules: rulebookRules,
				alwaysApplyRules,
				skillsSettings: settings.getGroup("skills"),
				appendSystemPrompt: appendPrompt,
				pluginAppendices: pluginSystemAppendices,
				repeatToolDescriptions,
				intentField,
				toolDiscoveryActive: effectiveDiscoveryMode === "all" || mcpDiscoveryEnabled,
				eagerTasks: resolveEagerTasks(),
				secretsEnabled,
				workspaceTree: workspaceTreePromise,
				subagent: options.parentTaskPrefix !== undefined,
			});

			for (const warning of defaultPrompt.warnings) {
				if (emittedContextFileWarnings.has(warning)) continue;
				emittedContextFileWarnings.add(warning);
				contextFileWarnings.push(warning);
				if (hasSession) session.configWarnings.push(warning);
				logger.warn("Context file discovery warning", { warning });
			}
			// The master doctrine block is appended exactly once, AFTER any custom
			// system-prompt transformation, and only for the master session itself.
			const withMasterGuidance = (built: BuildSystemPromptResult): BuildSystemPromptResult =>
				masterModeContext ? { ...built, systemPrompt: [...built.systemPrompt, masterModeTemplate.trim()] } : built;
			if (options.systemPrompt === undefined) {
				return withMasterGuidance(defaultPrompt);
			}
			if (Array.isArray(options.systemPrompt)) {
				return withMasterGuidance({ systemPrompt: options.systemPrompt, warnings: defaultPrompt.warnings });
			}
			return withMasterGuidance({
				systemPrompt: options.systemPrompt(defaultPrompt.systemPrompt),
				warnings: defaultPrompt.warnings,
			});
		};

		const toolNamesFromRegistry = Array.from(toolRegistry.keys());
		const hasExplicitToolNames = options.toolNames !== undefined;
		const hasExplicitEmptyToolSelection = hasExplicitToolNames && options.toolNames!.length === 0;
		// `goal` is session state rather than a work tool, so it is folded into an
		// explicit selection that already asks for tools. An *empty* explicit
		// selection is the `--no-tools` contract ("Disable all built-in tools", see
		// cli/root-flags.ts), and re-populating it with `goal` would leave exactly one
		// built-in tool live against that promise.
		const wantsGoalStateTool = hasExplicitToolNames && options.toolNames!.length > 0;
		const requestedToolNames = hasExplicitToolNames
			? [
					...new Set([
						...options.toolNames!.map(name => name.toLowerCase()),
						...(wantsGoalStateTool && settings.get("goal.enabled") ? ["goal"] : []),
					]),
				]
			: toolNamesFromRegistry;
		const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
		const explicitRequestedToolNames = hasExplicitToolNames ? normalizedRequested : [];
		const requestedToolNameSet = new Set(normalizedRequested);
		const effectiveDiscoveryMode = resolveEffectiveDiscoveryMode(settings, explicitMcpConfigPath);
		const mcpDiscoveryEnabled = effectiveDiscoveryMode !== "off";
		const defaultInactiveToolNames = new Set(
			registeredTools.filter(tool => tool.definition.defaultInactive).map(tool => tool.definition.name),
		);
		const requestedActiveToolNames = normalizedRequested;
		const initialRequestedActiveToolNames = options.toolNames
			? requestedActiveToolNames
			: requestedActiveToolNames.filter(name => !defaultInactiveToolNames.has(name));
		const discoverableMCPToolNames = new Set<string>();
		const explicitlyRequestedMCPToolNames: string[] = [];
		const discoveryDefaultServerToolNames: string[] = [];
		let initialSelectedMCPToolNames: string[] = [];
		let defaultSelectedMCPToolNames: string[] = [];
		let initialBaselineDiscoveredBuiltinToolNames: string[] = [];
		let initialSelectedDiscoveredBuiltinToolNames: string[] = [];
		let hasExplicitMCPToolSelection = false;
		let hasExplicitDiscoveredBuiltinToolSelection = false;
		let explicitlyRequestedDiscoveredBuiltinToolNames: string[] = [];
		if (mcpDiscoveryEnabled) {
			const defaultServerNames = new Set(settings.get("mcp.discoveryDefaultServers") ?? []);
			for (const tool of toolRegistry.values()) {
				if (!isMCPBridgeTool(tool)) continue;
				discoverableMCPToolNames.add(tool.name);
				if (explicitRequestedToolNames.includes(tool.name)) {
					explicitlyRequestedMCPToolNames.push(tool.name);
				}
				const serverName = (tool as AgentTool & { mcpServerName?: string }).mcpServerName;
				if (serverName && defaultServerNames.has(serverName)) {
					discoveryDefaultServerToolNames.push(tool.name);
				}
			}
		}
		const mandatoryMCPToolNameSet = new Set(pluginMcpToolNames);
		const selectableExplicitMCPToolNames = explicitlyRequestedMCPToolNames.filter(
			name => !mandatoryMCPToolNameSet.has(name),
		);
		let initialToolNames = [...initialRequestedActiveToolNames];
		if (mcpDiscoveryEnabled) {
			const restoredSelectedMCPToolNames = deferredExactMcpConfig
				? existingSession.selectedMCPToolNames.filter(name => !mandatoryMCPToolNameSet.has(name))
				: existingSession.selectedMCPToolNames.filter(
						name => toolRegistry.has(name) && !mandatoryMCPToolNameSet.has(name),
					);
			if (
				!deferredExactMcpConfig &&
				existingSession.hasPersistedMCPToolSelection &&
				restoredSelectedMCPToolNames.length !== existingSession.selectedMCPToolNames.length
			) {
				sessionManager.appendMCPToolSelection(restoredSelectedMCPToolNames);
			}
			defaultSelectedMCPToolNames = [
				...new Set([
					...discoveryDefaultServerToolNames,
					...(explicitMcpConfigPath !== undefined ? exactMcpToolNames : []),
					// Conventional autoload servers are selected by default so their
					// tools are exposed in sessions that enable MCP discovery mode.
					...conventionalMcpToolNames,
				]),
			];
			hasExplicitMCPToolSelection =
				hasExplicitToolNames && (options.toolNames!.length === 0 || selectableExplicitMCPToolNames.length > 0);
			initialSelectedMCPToolNames = existingSession.hasPersistedMCPToolSelection
				? restoredSelectedMCPToolNames
				: hasExplicitMCPToolSelection
					? selectableExplicitMCPToolNames
					: defaultSelectedMCPToolNames;
			initialToolNames = [
				...new Set([
					...initialRequestedActiveToolNames.filter(name => !discoverableMCPToolNames.has(name)),
					...initialSelectedMCPToolNames,
				]),
			];
		}

		// Custom, extension-registered, and plugin-bundle MCP tools are always
		// included regardless of the caller's built-in tool filter. Plugin MCPs
		// and conventional autoload MCPs remain always-on even when generic MCP
		// discovery is disabled.
		const alwaysInclude: string[] = [
			...(options.customTools?.map(t => (isCustomTool(t) ? t.name : t.name)) ?? []),
			...registeredTools.filter(t => !t.definition.defaultInactive).map(t => t.definition.name),
			...pluginMcpToolNames,
			...conventionalMcpToolNames,
		];
		const pluginMcpToolNameSet = new Set(pluginMcpToolNames);
		for (const name of alwaysInclude) {
			if (mcpDiscoveryEnabled && discoverableMCPToolNames.has(name) && !pluginMcpToolNameSet.has(name)) {
				continue;
			}
			if (toolRegistry.has(name) && !initialToolNames.includes(name)) {
				initialToolNames.push(name);
			}
		}

		// When tools.discoveryMode === "all", hide non-essential built-in discoverable tools
		// from the initial set unless they were explicitly requested or restored from persistence.
		// The model finds them via search_tool_bm25 and activates them on demand.
		if (effectiveDiscoveryMode === "all") {
			const alwaysActiveDiscoveredBuiltinNames = new Set(
				(options.alwaysActiveToolNames ?? []).map(name => name.toLowerCase()),
			);
			const essentialBuiltinNames = new Set(computeEssentialBuiltinNames(settings));
			// `task.eager` promises delegation preference. In discovery mode the task tool
			// would otherwise be hidden, making the matching prompt instruction unreachable.
			if (eagerTasks) essentialBuiltinNames.add("task");
			const allowedDiscoveredBuiltinNames = options.discoverableToolAllowedNames
				? new Set(options.discoverableToolAllowedNames.map(name => name.toLowerCase()))
				: undefined;
			const baselineInitialToolNames = initialToolNames.filter(name => {
				const tool = toolRegistry.get(name);
				if (!tool?.loadMode) return true; // not a built-in — leave MCP/custom/extension to existing logic
				if (tool.loadMode === "essential") return true;
				if (alwaysActiveDiscoveredBuiltinNames.has(name)) return true;
				return essentialBuiltinNames.has(name);
			});
			explicitlyRequestedDiscoveredBuiltinToolNames = selectRestorableDiscoveredBuiltinToolNames(
				explicitRequestedToolNames,
				toolRegistry,
				allowedDiscoveredBuiltinNames,
			).filter(name => !essentialBuiltinNames.has(name));
			const requestedDiscoveredBuiltinToolNameSet = new Set(explicitlyRequestedDiscoveredBuiltinToolNames);
			initialBaselineDiscoveredBuiltinToolNames = selectRestorableDiscoveredBuiltinToolNames(
				baselineInitialToolNames.filter(name => !requestedDiscoveredBuiltinToolNameSet.has(name)),
				toolRegistry,
				allowedDiscoveredBuiltinNames,
			);
			const restoredDiscoveredNames = selectRestorableDiscoveredBuiltinToolNames(
				existingSession.selectedDiscoveredBuiltinToolNames ?? [],
				toolRegistry,
				allowedDiscoveredBuiltinNames,
				essentialBuiltinNames,
			);
			initialSelectedDiscoveredBuiltinToolNames = hasExplicitEmptyToolSelection
				? []
				: existingSession.hasPersistedDiscoveredBuiltinToolSelection
					? restoredDiscoveredNames
					: explicitlyRequestedDiscoveredBuiltinToolNames;
			initialToolNames = [...new Set([...baselineInitialToolNames, ...initialSelectedDiscoveredBuiltinToolNames])];
			hasExplicitDiscoveredBuiltinToolSelection =
				hasExplicitToolNames &&
				(options.toolNames!.length === 0 || explicitlyRequestedDiscoveredBuiltinToolNames.length > 0);
		}

		// Pre-register in the global agent registry BEFORE building the system prompt,
		// so that subagents launched in the same parallel batch can see each other in
		// their initial `# IRC Peers` block (rendered inside `rebuildSystemPrompt`).
		// The session reference is attached after construction below.
		agentRegistry.register({
			id: resolvedAgentId,
			displayName: resolvedAgentDisplayName,
			rosterLabel: resolvedAgentRosterLabel,
			kind: isCanonicalSubSession ? "sub" : "main",
			parentId: options.parentTaskPrefix,
			session: null,
			sessionFile: sessionManager.getSessionFile() ?? null,
			status: "running",
		});
		hasRegistered = true;

		const { systemPrompt } = await logger.time(
			"buildSystemPrompt",
			rebuildSystemPrompt,
			initialToolNames,
			toolRegistry,
		);

		let promptTemplates = await promptTemplatesPromise;
		toolSession.promptTemplates = promptTemplates;

		slashCommands = await slashCommandsPromise;

		// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
		const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlm(messages);
			// Check setting dynamically so mid-session changes take effect
			if (!settings.get("images.blockImages")) {
				return converted;
			}
			// Filter out ImageContent from all messages, replacing with text placeholder
			return converted.map(msg => {
				if (msg.role === "user" || msg.role === "toolResult") {
					const content = msg.content;
					if (Array.isArray(content)) {
						const hasImages = content.some(c => c.type === "image");
						if (hasImages) {
							const filteredContent = content
								.map(c =>
									c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
								)
								.filter((c, i, arr) => {
									// Dedupe consecutive "Image reading is disabled." texts
									if (!(c.type === "text" && c.text === "Image reading is disabled." && i > 0)) return true;
									const prev = arr[i - 1];
									return !(prev.type === "text" && prev.text === "Image reading is disabled.");
								});
							return { ...msg, content: filteredContent };
						}
					}
				}
				return msg;
			});
		};

		// Final convertToLlm: chain block-images filter with secret obfuscation
		const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlmWithBlockImages(messages);
			if (!obfuscator?.hasSecrets() || !obfuscateMessagesFn) return converted;
			return obfuscateMessagesFn(obfuscator, converted);
		};
		const transformContext = async (messages: AgentMessage[], _signal?: AbortSignal, scope?: AttemptScopeRef) => {
			// External Agent events dispatch listeners without awaiting them. The
			// session-owned barrier makes any pre-admission artifact transformation
			// visible before this provider context is normalized.
			await session?.awaitPendingContextTransformations();
			return extensionRunner ? await extensionRunner.emitContext(messages, scope) : messages;
		};
		const onPayload = extensionRunner
			? async (payload: unknown, _model?: Model, scope?: AttemptScopeRef) => {
					return await extensionRunner.emitBeforeProviderRequest(payload, scope);
				}
			: undefined;
		const onResponse: SimpleStreamOptions["onResponse"] | undefined = extensionRunner
			? async (response, model, scope) => {
					await extensionRunner.emitAfterProviderResponse(response, model, scope);
				}
			: undefined;

		const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
			toolContextStore.setUIContext(uiContext, hasUI);
		};

		const initialTools = initialToolNames
			.map(name => toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined)
			// AgentSession tool wrapping is not installed until after Agent construction.
			.map(tool =>
				guardToolForUltragoalAsk(
					tool,
					() => sessionManager.getCwd(),
					() => ({
						activeSkillState: session?.getActiveSkillState(),
						sessionId: sessionManager.getSessionId?.() ?? null,
					}),
					() => session?.getSessionAgentDir(),
				),
			);

		const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "off";
		const preferOpenAICodexWebsockets =
			openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
		const serviceTierSetting = settings.get("serviceTier");
		const retrySettings = settings.getGroup("retry");

		const initialServiceTier = hasServiceTierEntry
			? existingSession.serviceTier
			: serviceTierSetting === "none"
				? undefined
				: serviceTierSetting;

		const appendOnlyContext =
			model && resolveAppendOnlyMode(settings.get("provider.appendOnlyContext"), model.provider)
				? createAppendOnlyContextManager(model.provider)
				: undefined;
		if (appendOnlyContext && options.forkContextSeed && !hasExistingSession) {
			if (options.forkContextSeed.appendOnlyPrefixSnapshot) {
				(
					appendOnlyContext.prefix as typeof appendOnlyContext.prefix & {
						importSnapshot(
							snapshot: NonNullable<ForkContextSeed["appendOnlyPrefixSnapshot"]>,
							options: { intentTracing: boolean },
						): void;
					}
				).importSnapshot(options.forkContextSeed.appendOnlyPrefixSnapshot, { intentTracing: !!intentField });
			}
			(
				appendOnlyContext as AppendOnlyContextManager & {
					seedNormalizedMessages(messages: readonly Message[]): void;
				}
			).seedNormalizedMessages(options.forkContextSeed.messages);
		}

		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(thinkingLevel),
				tools: initialTools,
				...(options.forkContextSeed && !hasExistingSession
					? { messages: options.forkContextSeed.agentMessages }
					: {}),
			},
			convertToLlm: convertToLlmFinal,
			onPayload,
			onResponse,
			sessionId: logicalSessionId,
			providerSessionId,
			transformContext,
			steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
			followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
			toolInterruptPolicy: settings.get("toolInterruptPolicy") ?? "abort_tools",
			thinkingBudgets: settings.getGroup("thinkingBudgets"),
			temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined,
			topP: settings.get("topP") >= 0 ? settings.get("topP") : undefined,
			topK: settings.get("topK") >= 0 ? settings.get("topK") : undefined,
			minP: settings.get("minP") >= 0 ? settings.get("minP") : undefined,
			presencePenalty: settings.get("presencePenalty") >= 0 ? settings.get("presencePenalty") : undefined,
			repetitionPenalty: settings.get("repetitionPenalty") >= 0 ? settings.get("repetitionPenalty") : undefined,
			serviceTier: initialServiceTier,
			hideThinkingSummary: settings.get("hideThinkingBlock"),
			maxRetryDelayMs: retrySettings.maxDelayMs,
			requestMaxRetries: retrySettings.requestMaxRetries,
			streamMaxRetries: retrySettings.streamMaxRetries,
			streamFirstEventTimeoutMs: settings.has("retry.streamFirstEventTimeoutMs")
				? retrySettings.streamFirstEventTimeoutMs
				: undefined,
			kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
			shouldPause: options.shouldPause,
			preferWebsockets: preferOpenAICodexWebsockets,
			getToolContext: tc => toolContextStore.getContext(tc),
			getApiKey: async provider => {
				// AgentLoop asks by provider, but the active model carries the
				// model-scoped credential selector. Read it at call time so model
				// changes are honored after /new, fork, resume, or branch switches.
				const liveModel = sessionAgent?.state.model ?? model;
				const key =
					liveModel?.provider === provider
						? await modelRegistry.getApiKey(liveModel, credentialSessionId)
						: undefined;
				const providerKey = key ?? (await modelRegistry.getApiKeyForProvider(provider, credentialSessionId));
				if (!providerKey) {
					throw new Error(`No API key found for provider "${provider}"`);
				}
				return providerKey;
			},
			getAuthCredentialType: provider => modelRegistry.getSessionCredentialType(provider, credentialSessionId),
			streamFn: async (streamModel, context, streamOptions) => {
				const requestStartedAt = performance.now();
				let stream: Awaited<ReturnType<typeof streamSimple>>;
				try {
					const effectiveApiKey = await modelRegistry.getApiKey(streamModel, credentialSessionId);
					stream = await streamSimple(streamModel, context, {
						...streamOptions,
						apiKey: effectiveApiKey,
						authCredentialType: modelRegistry.getSessionCredentialType(streamModel.provider, credentialSessionId),
						onAuthError: async (provider, oldKey, error) => {
							await modelRegistry.authStorage.invalidateCredentialMatching(provider, oldKey, {
								signal: streamOptions?.signal,
								sessionId: credentialSessionId,
								owner: modelRegistry.getAuthStorageOwner(),
							});
							logger.debug("Retrying provider request after credential invalidation", {
								provider,
								error: error instanceof Error ? error.message : String(error),
							});
							return modelRegistry.getApiKey(streamModel, credentialSessionId, {
								signal: streamOptions?.signal,
							});
						},
					});
				} catch (error) {
					const prewarm = await runtimeServices.networkPrewarm.get("first-request");
					prewarm.recordFirstRequestLatency(performance.now() - requestStartedAt);
					throw error;
				}
				const prewarm = await runtimeServices.networkPrewarm.get("first-request");
				if (prewarm.enabled) return stream;
				let recorded = false;
				const recordLatency = (): void => {
					if (recorded) return;
					recorded = true;
					prewarm.recordFirstRequestLatency(performance.now() - requestStartedAt);
				};
				const originalPush = stream.push.bind(stream);
				stream.push = event => {
					recordLatency();
					originalPush(event);
				};
				const originalFail = stream.fail.bind(stream);
				stream.fail = error => {
					recordLatency();
					originalFail(error);
				};
				const originalEnd = stream.end.bind(stream);
				stream.end = result => {
					recordLatency();
					originalEnd(result);
				};
				return stream;
			},
			cursorExecHandlers,
			transformToolCallArguments: (args, _toolName) => {
				let result = args;
				const maxTimeout = settings.get("tools.maxTimeout");
				if (maxTimeout > 0 && typeof result.timeout === "number") {
					result = { ...result, timeout: Math.min(result.timeout, maxTimeout) };
				}
				if (obfuscator?.hasSecrets()) {
					result = obfuscator.deobfuscateObject(result);
				}
				return result;
			},
			onToolChoiceIncapability: event => {
				const droppedLabel = session?.toolChoiceQueue.degradeInFlight(event.reason);
				logger.debug("Dropped in-flight tool choice after runtime incapability", {
					droppedLabel,
					api: event.api,
					provider: event.provider,
					model: event.model,
					requestedLevel: event.requestedLevel,
					resolvedLevel: event.resolvedLevel,
					reason: event.reason,
					registryKey: event.registryKey,
				});
			},
			intentTracing: !!intentField,
			getToolChoice: () => session?.nextToolChoice(),
			telemetry: options.telemetry,
			appendOnlyContext,
		});
		sessionAgent = agent;

		cursorEventEmitter = event => agent.emitExternalEvent(event);

		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.replaceMessages(reconcileTrailingToolCalls(existingSession.messages));
		} else {
			// Save initial model, thinking level, and service tier for new sessions so they can be restored on resume.
			if (model) {
				const substitution = options.modelSubstitution;
				sessionManager.appendModelChange(
					`${model.provider}/${model.id}`,
					undefined,
					substitution
						? {
								previousModel: `${substitution.requestedModel.provider}/${substitution.requestedModel.id}`,
								reason: substitution.reason,
								thinkingLevel: thinkingLevel ?? null,
							}
						: undefined,
				);
			}
			sessionManager.appendThinkingLevelChange(options.thinkingLevel ?? ThinkingLevel.Inherit);
			if (initialServiceTier) {
				sessionManager.appendServiceTierChange(initialServiceTier);
			}
		}

		const deferredMcpTurnReady = deferredExactMcpConfig ? Promise.withResolvers<void>() : undefined;
		if (deferredMcpTurnReady) void deferredMcpTurnReady.promise.catch(() => {});

		session = new AgentSession({
			agent,
			thinkingLevel,
			sessionManager,
			settings,
			// The session's REQUESTED agent directory when the caller explicitly
			// supplied it, independent of the reused global Settings singleton
			// (which may belong to an earlier session). When the option is
			// absent, the injected settings instance's own profile wins via the
			// AgentSession fallback - never the process default.
			agentDir: options.agentDir,
			memoryBackend: runtimeServices.memoryBackend,
			notificationSessionController,
			evalKernelOwnerId,
			// Defined only for top-level sessions (creation is gated above).
			// AgentSession uses this to decide whether it may dispose the global
			// AsyncJobManager on teardown; subagents inherit the parent's and
			// **MUST NOT** tear it down.
			ownedAsyncJobManager: asyncJobManager,
			disposeAsyncJobManager: !options.parentTaskPrefix,
			// Only an MCP manager owned by this session is torn down on dispose;
			// subagents and callers that merely observe a manager must not (see
			// AgentSession.dispose).
			ownedMcpManager: ownsMcpManager ? mcpManager : undefined,
			startupTurnBarrier: deferredMcpTurnReady?.promise,
			scopedModels: options.scopedModels,
			promptTemplates,
			slashCommands,
			extensionRunner,
			customCommands: customCommandsResult.commands,
			skills,
			skillWarnings,
			skillsSettings: settings.getGroup("skills"),
			modelRegistry,
			taskDepth,
			workflowGatePublication: isCanonicalSubSession ? "local" : "endpoint",
			toolRegistry,
			builtinToolIdentities,
			workflowGateToolSession: toolSession,
			transformContext,
			onPayload,
			onResponse,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			getMcpServerInstructions:
				explicitMcpConfigPath === undefined ? () => mcpManager?.getServerInstructions() : undefined,
			workspaceTree: options.workspaceTree ?? (workspaceTreeMode === "eager" ? resolvedWorkspaceTree : undefined),
			workspaceTreeService: options.workspaceTree ? undefined : runtimeServices.workspaceTree,
			networkPrewarmService: runtimeServices.networkPrewarm,
			onWorkspaceTreeReady: async tree => {
				workspaceTreePromise = Promise.resolve(tree);
				await session?.refreshBaseSystemPrompt();
			},
			reloadSshTool,
			rescopeSessionCwdParticipant,
			requestedToolNames: requestedToolNameSet,
			explicitEmptyToolSelection: hasExplicitEmptyToolSelection,
			discoverableToolAllowedNames: options.discoverableToolAllowedNames,
			mcpDiscoveryEnabled,
			discoveryMode: effectiveDiscoveryMode,
			initialSelectedMCPToolNames,
			preserveUnavailableInitialMCPToolSelection: deferredExactMcpConfig !== undefined,
			initialMCPToolSelectionIsExplicit: hasExplicitMCPToolSelection,
			initialDiscoveredBuiltinToolSelectionIsExplicit: hasExplicitDiscoveredBuiltinToolSelection,
			initialSelectedDiscoveredBuiltinToolNames,
			initialBaselineDiscoveredBuiltinToolNames,
			defaultSelectedMCPToolNames,
			mandatoryMCPToolNames: pluginMcpToolNames,
			persistInitialMCPToolSelection: !hasExistingSession && hasExplicitMCPToolSelection,
			persistInitialDiscoveredBuiltinToolSelection: !hasExistingSession && hasExplicitDiscoveredBuiltinToolSelection,
			initialPersistedMCPToolNames: selectableExplicitMCPToolNames,
			initialPersistedDiscoveredBuiltinToolNames: explicitlyRequestedDiscoveredBuiltinToolNames,
			defaultSelectedMCPServerNames: settings.get("mcp.discoveryDefaultServers") ?? [],
			ttsrManager,
			obfuscator,
			agentId: resolvedAgentId,
			agentRegistry,
			asyncJobProviderSessionId: options.providerSessionId,
			providerSessionId: options.providerSessionId,
			credentialSessionId,
			credentialStoreIdentity: startupAuthConfig?.credentialStoreIdentity,
			providerCacheSessionId: providerSessionId,
			forkContextSeed: options.forkContextSeed,
			providerSessionState: options.providerSessionState,
		});
		session.setActiveModelProfile(startupActiveModelProfile);
		session.configWarnings.push(...contextFileWarnings);
		// Determined once, here, where settings are already available. Keep the
		// durable warning for interactive and print consumers; ACP delivery is
		// carried by the host replay ring through the internal runtime seam above.
		if (autoroutingInactive) session.configWarnings.push(AUTOROUTING_INACTIVE_WARNING);
		hasSession = true;
		if (masterModeContext) {
			// One scoped, no-probe peer snapshot immediately before the FIRST accepted
			// provider request; see createMasterPeerSnapshotContributor for the
			// discard/reuse/no-duplicate semantics.
			const capturedSession = session;
			session.registerBeforeAgentStartContributor(
				createMasterPeerSnapshotContributor({
					lifecycle: createSessionLifecycleService(agentDir),
					ownerSessionId: masterModeContext.ownerSessionId,
					getSessionId: () => sessionManager.getSessionId(),
					scope: masterModeContext.scope,
					getCwd: getLiveCwd,
					hasPersistedInjection: () =>
						capturedSession.sessionManager
							.getBranch()
							.some(
								entry =>
									entry.type === "message" &&
									(entry.message as { customType?: string }).customType === MASTER_PEER_SNAPSHOT_CUSTOM_TYPE,
							),
					onError: error =>
						logger.debug("master peer snapshot injection failed", { error: safeErrorForLog(error) }),
				}),
			);
		}
		const sessionAsyncJobManager = asyncJobManager;
		if (sessionAsyncJobManager) {
			session.yieldQueue.register<AsyncResultEntry>("async-result", {
				isStale: entry => {
					const stale = sessionAsyncJobManager.isDeliverySuppressed(entry.jobId, entry.generation);
					if (stale) sessionAsyncJobManager.releaseDeliveryClaim(entry.generation);
					return stale;
				},
				// Build one message per ownership origin so an owned-scope drop of
				// one turn's message never suppresses other turns'/ordinary
				// completions batched in the same flush (review thread P2).
				groupKey: entry =>
					entry.ownedCompletion
						? `${entry.ownedCompletion.lineageIdHash}\u0000${entry.ownedCompletion.promptAttemptEpoch}`
						: "ordinary",
				build: entries => {
					try {
						return buildAsyncResultBatchMessage(entries);
					} finally {
						for (const entry of entries) sessionAsyncJobManager.releaseDeliveryClaim(entry.generation);
					}
				},
			});
		}
		session.yieldQueue.register<McpNotificationEntry>("mcp-notification", {
			build: buildMcpNotificationBatchMessage,
		});

		// Attach the live session to the pre-registered ref so peers can route IRC
		// messages here. Refresh sessionFile in case it was unavailable at pre-register
		// time. The dispose wrapper below unregisters on teardown.
		agentRegistry.attachSession(resolvedAgentId, session, sessionManager.getSessionFile() ?? null);
		{
			const originalDispose = session.dispose.bind(session);
			session.dispose = async () => {
				try {
					await originalDispose();
				} finally {
					try {
						agentRegistry.unregister(resolvedAgentId);
						releaseCredentialDisabledSubscription();
						releaseLocalProtocolOverride();
					} finally {
						// The endpoint is gone: its owned registrations can never
						// reach a delivery settlement boundary, and foreign-endpoint
						// tuples are deliberately never classified terminal by other
						// managers — retire them before unregistering the manager so
						// repeated session churn cannot saturate the registry
						// (review thread P2). The endpoint is the manager's live
						// registration key, which survives newSession/switchSession
						// rekeying and may differ from the persisted logical session id.
						if (!options.parentTaskPrefix) {
							retireOwnedRegistrationsForEndpoint(
								AsyncJobManager.endpointIdOf(asyncJobManager) ?? asyncJobEndpointId,
							);
							AsyncJobManager.unregisterManager(asyncJobManager);
						}
						await closeOwnedAuthStorage();
						await closeOwnedSettings();
					}
				}
			};
		}

		if (model?.api === "openai-codex-responses") {
			const codexModel = model;
			// W5d: the Codex provider module loads only inside this conditional
			// branch. Statically-traceable require keeps it lazy AND bundled in
			// compiled binaries (#1939 pattern).
			const { getOpenAICodexTransportDetails, prewarmOpenAICodexResponses } =
				require("@gajae-code/ai/providers/openai-codex-responses") as typeof import("@gajae-code/ai/providers/openai-codex-responses");
			const codexTransport = getOpenAICodexTransportDetails(codexModel, {
				sessionId: providerSessionId,
				baseUrl: codexModel.baseUrl,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: session.providerSessionState,
			});
			if (codexTransport.websocketPreferred) {
				void (async () => {
					try {
						const codexPrewarmApiKey = await modelRegistry.getApiKey(codexModel, credentialSessionId);
						if (!codexPrewarmApiKey) return;
						await logger.time("prewarmOpenAICodexResponses", prewarmOpenAICodexResponses, codexModel, {
							apiKey: codexPrewarmApiKey,
							sessionId: providerSessionId,
							preferWebsockets: preferOpenAICodexWebsockets,
							providerSessionState: session.providerSessionState,
						});
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.debug("Codex websocket prewarm failed", {
							error: errorMessage,
							provider: codexModel.provider,
							model: codexModel.id,
						});
					}
				})();
			}
		}

		// Discover configured LSP servers for the interactive status display without starting them.
		// LSP-backed write operations create clients on demand through `getOrCreateClient`.
		const lspServers =
			enableLsp && options.hasUI && settings.get("lsp.diagnosticsOnWrite")
				? (await import("../lsp")).discoverStartupLspServers(cwd, agentDir)
				: undefined;

		let memoryStartupTask: Promise<void> | undefined;
		// Activation runs through the lazy runtime service so the backend stays off
		// the startup graph until either this legacy call or a real memory use
		// triggers it. `deferMemoryBackendStartup` keeps the caller-driven timing.
		const startMemoryBackend = (): Promise<void> => {
			if (memoryStartupTask) return memoryStartupTask;
			memoryStartupTask = logger.time("startMemoryStartupTask", async () => {
				// The legacy startup call is the sole activation boundary. `prewarm()` records
				// that trigger while retaining the service's typed diagnostic on initialization
				// failure; inspect the status so a failed prewarm is still visible to startup.
				await runtimeServices.memoryBackend.prewarm("legacy-startup");
				const memoryStatus = runtimeServices.memoryBackend.status();
				if (memoryStatus.state !== "ready") {
					if (memoryStatus.error !== undefined) throw memoryStatus.error;
					throw new Error(
						`Memory backend did not become ready during legacy startup (state: ${memoryStatus.state}).`,
					);
				}
				const memoryBackend = runtimeServices.memoryBackend.peek();
				if (!memoryBackend) throw new Error("Memory backend became ready without a resident value.");
				await memoryBackend.start({
					session,
					settings,
					modelRegistry,
					agentDir,
					taskDepth,
					parentHindsightSessionState: options.parentHindsightSessionState,
				});
				// Rebuild after activation so the first returned prompt retains the legacy
				// memory instructions without initializing the backend during prompt build.
				await session.refreshBaseSystemPrompt();
			});
			return memoryStartupTask;
		};
		// The non-deferred path must JOIN the task so a startup failure rejects
		// createAgentSession rather than surfacing as an unhandled rejection.
		if (!options.deferMemoryBackendStartup) await startMemoryBackend();

		// Exact-config managers do not receive reactive callbacks; their tools are
		// registered once in the session-owned catalog.
		if (mcpManager && !options.mcpManager && explicitMcpConfigPath === undefined) {
			if (publishOwnedConventionalMcpTools) {
				// Late conventional connections can publish near-simultaneously.
				// Serialize the swaps so an older snapshot cannot interleave with a
				// newer one inside replaceNamedCustomTools and leave a stale list.
				// Each link swallows (and logs) its own failure so one bad
				// publication cannot kill the chain for every later one.
				let conventionalToolsSync: Promise<void> = Promise.resolve();
				syncConventionalToolsForManager = (tools: CustomTool[]): Promise<void> => {
					conventionalToolsSync = conventionalToolsSync
						.then(async () => {
							if (session.isDisposed) return;
							const nextTools = tools.filter(tool =>
								tool.mcpServerName ? ownedConventionalMcpServerNames.has(tool.mcpServerName) : false,
							);
							const previousNames = ownedConventionalMcpToolNames;
							ownedConventionalMcpToolNames = nextTools.map(tool => tool.name);
							const previousSet = new Set(previousNames);
							cwdCapturingToolNames.splice(
								0,
								cwdCapturingToolNames.length,
								...cwdCapturingToolNames.filter(name => !previousSet.has(name)),
								...ownedConventionalMcpToolNames,
							);
							await session.replaceNamedCustomTools(previousNames, nextTools);
							// Mixed plugin + conventional sessions deferred the seal while
							// a conventional server was still connecting; restore the
							// fixed-connection plugin contract once every conventional
							// server has reached a terminal state.
							if (
								ownedPluginServersConnected &&
								mcpManager !== undefined &&
								!mcpManager.isConnectionSetSealed() &&
								![...ownedConventionalMcpServerNames].some(
									name => mcpManager?.getConnectionStatus(name) === "connecting",
								)
							) {
								mcpManager.sealConnectionSet();
							}
						})
						.catch(error => {
							logger.warn("Failed to publish conventional MCP tools", { error: safeErrorForLog(error) });
						});
					return conventionalToolsSync;
				};
				const managerGeneration = replacementMcpGeneration;
				const managerForCallbacks = mcpManager;
				mcpManager.setOnToolsChanged(tools => {
					if (mcpManager !== managerForCallbacks || managerGeneration !== replacementMcpGeneration) return;
					void syncConventionalToolsForManager?.(tools as CustomTool[]);
				});
				void syncConventionalToolsForManager(mcpManager.getTools() as CustomTool[]);
			} else if (!ownsMcpManager) {
				mcpManager.setOnToolsChanged(tools => {
					void session.refreshMCPTools(tools);
				});
			}
			const clearDebounceTimers = () => {
				for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
				notificationDebounceTimers.clear();
			};
			postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
			const activeManager = mcpManager;
			wireMcpManagerCallbacks(mcpManager, () => activeManager === mcpManager);
		}

		// Constructor-time workflow-gate tool restoration is deferred by one
		// microtask (the ToolSession closure needs `session` assigned). Await it
		// so a resumed canonical workflow session returns with `ask` resident.
		await session.workflowGateToolRestoration;
		let startDeferredMcpConfig: (() => Promise<DeferredMcpConfigStartupResult>) | undefined;
		if (deferredExactMcpConfig) {
			const { manager, configPath } = deferredExactMcpConfig;
			let cancelled = false;
			let startupPromise: Promise<DeferredMcpConfigStartupResult> | undefined;
			session.registerToolSessionCleanup(async () => {
				cancelled = true;
				deferredMcpTurnReady?.resolve();
				if (startupPromise) {
					await manager.disconnectAll().catch(() => {});
					await startupPromise.catch(() => {});
				}
			});
			startDeferredMcpConfig = () => {
				if (!startupPromise && session.isDisposed) {
					return Promise.reject(new Error(DEFERRED_MCP_CONFIG_STARTUP_ERROR));
				}
				startupPromise ??= (async () => {
					try {
						const result = await manager.discoverAndConnect({ configPath });
						const resultTools = result.tools as CustomTool[];
						const toolNames = resultTools.map(tool => tool.name);
						const collidingToolNames = findDeferredExactMcpToolNameCollisions(
							toolNames,
							exactMcpCatalogToolNames,
						);
						if (collidingToolNames.length > 0) {
							throw new ExactMcpToolNameCollisionError(collidingToolNames);
						}
						if (!cancelled && !session.isDisposed) {
							await session.refreshMCPTools(resultTools);
							if (
								!session.isDisposed &&
								(!mcpDiscoveryEnabled || !existingSession.hasPersistedMCPToolSelection)
							) {
								await session.activateDiscoveredTools(toolNames);
							}
						}
						deferredMcpTurnReady?.resolve();
						const hasErrors = result.errors.size > 0 || result.tools.length === 0;
						if (hasErrors) logger.warn(DEFERRED_MCP_CONFIG_STARTUP_ERROR);
						return { loadedToolCount: cancelled || session.isDisposed ? 0 : resultTools.length, hasErrors };
					} catch {
						const startupError = new Error(DEFERRED_MCP_CONFIG_STARTUP_ERROR);
						deferredMcpTurnReady?.reject(startupError);
						await manager.disconnectAll().catch(() => {});
						throw startupError;
					}
				})();
				return startupPromise;
			};
		}
		// Expose the published evidence on the session itself so UI surfaces that
		// only hold a session (Settings) can consume it without threading the
		// creation result through every controller.
		session.gjcRuntimeSnapshot = gjcRuntimeStore;
		session.gjcActivationGeneration = gjcActivationGeneration;
		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager: ownsMcpManager && mcpManager?.isToolsOnly() ? undefined : mcpManager,
			startDeferredMcpConfig,
			startDeferredMemoryBackend: options.deferMemoryBackendStartup ? startMemoryBackend : undefined,
			modelFallbackMessage,
			lspServers,
			eventBus,
			gjcRuntimeSnapshot: gjcRuntimeStore,
		};
	} catch (error) {
		// Release the subscription if the throw happened after install but before the
		// dispose-wrap took ownership.
		releaseCredentialDisabledSubscription();
		let cleanupDiagnostic: unknown;
		try {
			if (hasSession) {
				await session.dispose();
			} else {
				if (hasRegistered) agentRegistry.unregister(resolvedAgentId);
				// Admission happens before session construction. Any later startup
				// failure must remove THIS manager's endpoint mapping and restore
				// the prior global only when this manager is still global: otherwise
				// a retry under the same endpoint is falsely rejected and an orphan
				// redirects global-manager consumers away from the live session
				// (review thread P1).
				if (asyncJobManagerAdmitted && asyncJobManager) {
					AsyncJobManager.unregisterManager(asyncJobManager);
					if (AsyncJobManager.instance() === asyncJobManager) {
						AsyncJobManager.setInstance(priorAsyncJobManager);
					}
					await asyncJobManager.dispose({ timeoutMs: 100 });
				}
				await cleanupOwnedMcpManager?.();
				const [{ disposeKernelSessionsByOwner }, { disposeVmContextsByOwner }] = await Promise.all([
					import("../eval/py/executor"),
					import("../eval/js/context-manager"),
				]);
				await disposeKernelSessionsByOwner(evalKernelOwnerId);
				await disposeVmContextsByOwner(evalKernelOwnerId);
				await closeOwnedSettings();
			}
		} catch (cleanupError) {
			cleanupDiagnostic = cleanupError;
			logger.warn("Failed to clean up createAgentSession resources after startup error", {
				error: safeErrorForLog(error),
				cleanupDiagnostic: safeCleanupDiagnosticForLog(cleanupDiagnostic),
			});
		} finally {
			if (processCwdClaimed) {
				SessionManager.releaseProcessCwdOwnership(sessionManager);
				processCwdClaimed = false;
			}
			releaseLocalProtocolOverride();
			try {
				await closeOwnedAuthStorage();
			} catch (authCleanupError) {
				logger.warn("Failed to close owned auth storage after startup error", { error: authCleanupError });
			}
		}
		if (cleanupDiagnostic !== undefined) throw attachMcpCleanupDiagnostic(error, cleanupDiagnostic);
		throw error;
	}
}
