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
	type AuthCredentialSelector,
	type CredentialDisabledEvent,
	type Message,
	type Model,
	type ProviderSessionState,
	type SimpleStreamOptions,
	streamSimple,
} from "@gajae-code/ai";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@gajae-code/ai/providers/openai-codex-responses";
import type { Component } from "@gajae-code/tui";
import {
	$flag,
	getAgentDbPath,
	getAgentDir,
	getProjectDir,
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
import { type AsyncJob, AsyncJobManager, isBackgroundJobSupportEnabled, jobElapsedMs } from "../async";
import { loadCapability } from "../capability";
import { type Rule, ruleCapability, setActiveRules } from "../capability/rule";
import { kNoAuth, ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	parseModelPattern,
	resolveAllowedModels,
	resolveModelChainWithAuth,
	resolveModelRoleValue,
	type ScopedModelSelection,
} from "../config/model-resolver";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "../config/prompt-templates";
import { Settings, type SkillsSettings } from "../config/settings";
import { CursorExecHandlers } from "../cursor";
import type { BashRestrictionProfile } from "../tools/bash-allowed-prefixes";
import "../discovery";
import { resolveConfigValue } from "../config/resolve-config-value";
import { getEmbeddedDefaultGjcSkills } from "../defaults/gjc-defaults";
import { BUNDLED_GROK_BUILD_EXTENSION_ID, getBundledGrokBuildExtensionFactory } from "../defaults/gjc-grok-cli";
import { initializeWithSettings } from "../discovery";
import { disposeAllVmContexts, disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "../eval/py/executor";
import { TtsrManager } from "../export/ttsr";
import type { CustomCommandsLoadResult, LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import {
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
import {
	buildPluginMcpConfigs,
	loadAlwaysOnPluginTools,
	renderAlwaysOnSystemAppendices,
} from "../extensibility/gjc-plugins/runtime-adapters";
import { loadActiveSubskillTools } from "../extensibility/gjc-plugins/tools";
import { loadSkills, type Skill, type SkillWarning, setActiveSkills } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type { HindsightSessionState } from "../hindsight/state";
import { LocalProtocolHandler, type LocalProtocolOptions } from "../internal-urls";
import { resolveMemoryBackend } from "../memory-backend";
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { MCPManager } from "../runtime-mcp";
import { createNotificationsExtension } from "../sdk/bus";
import {
	getNotificationConfig,
	isNotificationHostEligible,
	type NotificationConfig,
	SPAWN_PROVENANCE_ENV,
	shouldRegisterNotificationsExtension,
} from "../sdk/bus/config";
import { NotificationSessionController } from "../sdk/bus/session-control";
import { shouldHostSdk } from "../sdk/host";
import {
	collectEnvSecrets,
	deobfuscateSessionContext,
	loadSecrets,
	obfuscateMessages,
	SecretObfuscator,
} from "../secrets";
import { AgentSession, type ForkContextSeed } from "../session/agent-session";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";
import { AuthBrokerClient, AuthStorage, RemoteAuthCredentialStore } from "../session/auth-storage";
import { type CustomMessage, convertToLlm } from "../session/messages";
import { createReadonlySessionManager, SessionManager } from "../session/session-manager";
import { formatNoModelsAvailableFallback } from "../setup/model-onboarding-guidance";
import { closeAllConnections } from "../ssh/connection-manager";
import { unmountAll } from "../ssh/sshfs-mount";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
} from "../system-prompt";
import { AgentOutputManager } from "../task/output-manager";
import { parseThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "../thinking";
import { isMCPBridgeTool } from "../tool-discovery/tool-index";
import {
	applyConfiguredSearchTimeout,
	BashTool,
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	discoverStartupLspServers,
	EditTool,
	EvalTool,
	FindTool,
	getConfiguredSearchProviderPreference,
	getSearchTools,
	HIDDEN_TOOLS,
	isConfigurableSearchProviderId,
	type LspStartupServerInfo,
	loadSshTool,
	ReadTool,
	ResolveTool,
	SearchTool,
	setPreferredImageProvider,
	setPreferredSearchProvider,
	setSearchFallbackProviders,
	type Tool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
} from "../tools";
import { ToolContextStore } from "../tools/context";
import { getImageGenTools } from "../tools/image-gen";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { guardToolForUltragoalAsk } from "../tools/ultragoal-ask-guard";
import { EventBus } from "../utils/event-bus";
import { buildNamedToolChoice, buildNamedToolChoiceResult } from "../utils/tool-choice";
import { buildWorkspaceTree, type WorkspaceTree } from "../workspace-tree";
import {
	attachLifecycleStartupCapability,
	lifecycleStartupCapabilityOption,
	type SdkStartupCapability,
} from "./startup-capability";

type AsyncResultEntry = {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
};

type AsyncResultJobDetails = {
	jobId: string;
	type?: "bash" | "task";
	label?: string;
	durationMs?: number;
};

type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => ({
		jobId: entry.jobId,
		result: entry.result,
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
	}));
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
		})),
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

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern string (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string;
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
	/** Runtime credential selector for multi-account auth pools. */
	credentialSelector?: { provider?: string; selector: AuthCredentialSelector; raw: string };

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Explicit parent/phase used to load active GJC sub-skill tools for this session. */
	gjcSubskillToolContext?: { parent: string; phase: string; sessionId?: string; cwd?: string };
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
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
	/** Optional shared agent registry for IRC routing. Default: AgentRegistry.global(). */
	agentRegistry?: AgentRegistry;
	/** Parent task ID prefix for nested artifact naming (e.g., "6-Extensions") */
	parentTaskPrefix?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Override local:// protocol options for subagent local:// sharing. Default: uses the session's own artifacts dir and session ID. */
	localProtocolOptions?: LocalProtocolOptions;

	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;
	/** Whether this host mode can own a notification session endpoint. Default: true. */
	notificationHostModeSupported?: boolean;

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
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers configured for lazy startup in interactive mode */
	lspServers?: LspStartupServerInfo[];
	/** Shared event bus for tool/extension communication */
	eventBus: EventBus;
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

export {
	// Individual tool classes (for custom usage)
	BashTool,
	// Tool classes and factories
	BUILTIN_TOOLS,
	createTools,
	EditTool,
	EvalTool,
	FindTool,
	HIDDEN_TOOLS,
	loadSshTool,
	ReadTool,
	ResolveTool,
	SearchTool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
};

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
export async function discoverAuthStorage(agentDir: string = getDefaultAgentDir()): Promise<AuthStorage> {
	const brokerConfig = await resolveAuthBrokerConfig();
	const credentialRankingMode = resolveCredentialRankingMode();
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

/**
 * Opt-in multi-account credential ranking mode, read from the
 * `GJC_CREDENTIAL_RANKING_MODE` env var. Unset/unknown → `undefined`, leaving
 * {@link AuthStorage}'s default (`balanced`) untouched. `earliest-reset`
 * switches to earliest-expiry-first selection so soon-to-reset tumbling-window
 * quota is drained before it is lost.
 */
function resolveCredentialRankingMode(): "balanced" | "earliest-reset" | undefined {
	const raw = process.env.GJC_CREDENTIAL_RANKING_MODE?.trim();
	if (raw === "balanced" || raw === "earliest-reset") return raw;
	return undefined;
}

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
	_agentDir?: string,
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
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
export async function discoverSlashCommands(_cwd?: string): Promise<FileSlashCommand[]> {
	return [];
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

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

let pythonCleanupRegistered = false;

function registerPythonCleanup(): void {
	if (pythonCleanupRegistered) return;
	pythonCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
}

let jsVmCleanupRegistered = false;

function registerJsVmCleanup(): void {
	if (jsVmCleanupRegistered) return;
	jsVmCleanupRegistered = true;
	postmortem.register("js-vm-cleanup", disposeAllVmContexts);
}

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
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
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
		for (const hook of hooks) {
			// Constrained plugin hooks register exactly their declared event handler
			// through the standard extension API; the loader already denied every
			// session-mutation/command/exec capability at load time. At execution we
			// additionally enforce the declared `target`: a tool-scoped hook only
			// fires for its declared tool, never for arbitrary tool events.
			const target = hook.target;
			const handler = target
				? (event: { toolName?: string; tool?: { name?: string }; name?: string }, ...rest: unknown[]) => {
						const toolName = event?.toolName ?? event?.tool?.name ?? event?.name;
						if (toolName !== target) return undefined;
						return (hook.handler as (...a: unknown[]) => unknown)(event, ...rest);
					}
				: hook.handler;
			(api.on as (event: string, handler: (...args: unknown[]) => unknown) => void)(hook.event, handler);
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
 * import { getModel } from '@gajae-code/ai';
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
	const byName = new Map(skills.map(skill => [skill.name, skill]));
	for (const defaultSkill of getEmbeddedDefaultGjcSkills()) {
		if (!byName.has(defaultSkill.name)) {
			byName.set(defaultSkill.name, defaultSkill);
		}
	}
	return [...byName.values()];
}

export function resolveIntentTracingEnabled(intentTracingSetting: boolean | undefined, hasUI: boolean): boolean {
	return (!!intentTracingSetting || $flag("PI_INTENT_TRACING")) && hasUI;
}

const MCP_CONFIG_PATH_AND_MANAGER_ERROR = "mcpConfigPath and mcpManager are mutually exclusive";
const MCP_CONFIG_PATH_ABSOLUTE_ERROR = "mcpConfigPath requires an absolute path";
const MCP_TOOLS_ONLY_MANAGER_SUBSESSION_ERROR = "tools-only MCP managers cannot be reused in sub-sessions";
const MCP_CONFIG_PATH_SUBSESSION_ERROR = "mcpConfigPath cannot be used in sub-sessions";
const MAX_EXACT_MCP_TOOL_COLLISION_NAMES = 10;
const MAX_EXACT_MCP_TOOL_NAME_LENGTH = 100;

class ExactMcpToolNameCollisionError extends Error {
	constructor(toolNames: Iterable<string>) {
		const names = [...new Set(toolNames)]
			.sort()
			.slice(0, MAX_EXACT_MCP_TOOL_COLLISION_NAMES)
			.map(name => name.slice(0, MAX_EXACT_MCP_TOOL_NAME_LENGTH));
		super(`Exact MCP tool name collision: ${names.join(", ")}`);
	}
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

export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const lifecycleStartupCapability = (
		options as CreateAgentSessionOptions & { [lifecycleStartupCapabilityOption]?: SdkStartupCapability }
	)[lifecycleStartupCapabilityOption];
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
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();
	registerPythonCleanup();
	registerJsVmCleanup();

	// Pin authStorage to modelRegistry.authStorage: ModelRegistry.getApiKey() routes refresh
	// failures through that instance, so any divergent storage handed to the bridge / mcpManager
	// / session would silently miss credential_disabled events.
	const ownsAuthStorage = options.modelRegistry === undefined && options.authStorage === undefined;
	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir)));
	const authStorage = modelRegistry.authStorage;
	if (options.authStorage && options.authStorage !== authStorage) {
		throw new Error(
			"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
		);
	}
	let agent: Agent;
	let session!: AgentSession;
	let hasSession = false;
	let hasRegistered = false;
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
	const closeOwnedAuthStorage = (): void => {
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
		let runtimeCredentialSelectorInstalled = false;
		const installRuntimeCredentialSelector = (provider: string): void => {
			if (!options.credentialSelector || runtimeCredentialSelectorInstalled) return;
			authStorage.setRuntimeCredentialSelector(provider, options.credentialSelector.selector);
			runtimeCredentialSelectorInstalled = true;
		};
		const earlyCredentialSelectorProvider = options.credentialSelector?.provider ?? options.model?.provider;
		if (earlyCredentialSelectorProvider) {
			installRuntimeCredentialSelector(earlyCredentialSelectorProvider);
		}
		const settings = options.settings ?? (await logger.time("settings", Settings.init, { cwd, agentDir }));
		modelRegistry.applyConfiguredModelBindings(settings);
		logger.time("initializeWithSettings", initializeWithSettings, settings);
		const canRefreshModelsBeforeCredentialSelector =
			!options.credentialSelector || runtimeCredentialSelectorInstalled || options.modelRegistry !== undefined;
		if (!options.modelRegistry && canRefreshModelsBeforeCredentialSelector) {
			modelRegistry.refreshInBackground();
		}
		// Kick off workspace tree discovery early. The native workspace scan returns
		// both the rendered-tree input and the AGENTS.md directory-context index, so
		// startup does not perform a second recursive filesystem search. Subagents
		// inherit the parent's resolved values via options.
		const STARTUP_SCAN_DEADLINE_MS = 5000;
		const workspaceTreePromise: Promise<WorkspaceTree> = options.workspaceTree
			? Promise.resolve(options.workspaceTree)
			: logger.time("buildWorkspaceTree", () => buildWorkspaceTree(cwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }));
		workspaceTreePromise.catch(() => {});

		// Independent discoveries that depend only on cwd/agentDir — kicked off in parallel and awaited
		// at their respective consumer sites. Their work can overlap with model resolution, secret loading,
		// session-context build, tool creation, MCP discovery, and extension discovery.
		const contextFilesPromise = options.contextFiles
			? Promise.resolve(options.contextFiles)
			: logger.time("discoverContextFiles", discoverContextFiles, cwd, agentDir);
		contextFilesPromise.catch(() => {});
		const promptTemplatesPromise = options.promptTemplates
			? Promise.resolve(options.promptTemplates)
			: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir);
		promptTemplatesPromise.catch(() => {});
		const slashCommandsPromise = options.slashCommands ? Promise.resolve(options.slashCommands) : Promise.resolve([]);
		slashCommandsPromise.catch(() => {});

		// Initialize provider preferences from settings
		const webSearchProvider = getConfiguredSearchProviderPreference(settings);
		setPreferredSearchProvider(webSearchProvider);
		const webSearchFallback = settings.get("web_search.fallback");
		if (Array.isArray(webSearchFallback)) {
			setSearchFallbackProviders(
				webSearchFallback.filter(value => typeof value === "string" && isConfigurableSearchProviderId(value)),
			);
		}
		applyConfiguredSearchTimeout(settings);

		const imageProvider = settings.get("providers.image");
		if (
			imageProvider === "auto" ||
			imageProvider === "openai" ||
			imageProvider === "gemini" ||
			imageProvider === "openrouter" ||
			imageProvider === "antigravity"
		) {
			setPreferredImageProvider(imageProvider);
		}

		const sessionManager =
			options.sessionManager ??
			(await logger.time("sessionManager", async () => {
				const sessionDir = SessionManager.getDefaultSessionDir(cwd, agentDir);
				return SessionManager.create(cwd, sessionDir);
			}));
		const logicalSessionId = sessionManager.getSessionId();
		const providerSessionId = options.providerSessionId ?? options.forkContextSeed?.cacheIdentity ?? logicalSessionId;
		const modelApiKeyAvailability = new Map<string, boolean>();
		const getModelAvailabilityKey = (candidate: Model): string =>
			`${candidate.provider}\u0000${candidate.baseUrl ?? ""}`;
		const hasModelApiKey = async (candidate: Model): Promise<boolean> => {
			const availabilityKey = getModelAvailabilityKey(candidate);
			const cached = modelApiKeyAvailability.get(availabilityKey);
			if (cached !== undefined) {
				return cached;
			}

			const credentialSelector =
				options.credentialSelector && !runtimeCredentialSelectorInstalled
					? options.credentialSelector.provider === undefined ||
						options.credentialSelector.provider === candidate.provider
						? options.credentialSelector.selector
						: undefined
					: undefined;
			if (options.credentialSelector?.provider && options.credentialSelector.provider !== candidate.provider) {
				modelApiKeyAvailability.set(availabilityKey, false);
				return false;
			}
			const key = await modelRegistry
				.getApiKey(candidate, providerSessionId, { credentialSelector })
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
		if (settings.get("secrets.enabled")) {
			const fileEntries = await logger.time("loadSecrets", loadSecrets, cwd, agentDir);
			const envEntries = collectEnvSecrets();
			const allEntries = [...envEntries, ...fileEntries];
			if (allEntries.length > 0) {
				obfuscator = new SecretObfuscator(allEntries);
			}
		}
		const secretsEnabled = obfuscator?.hasSecrets() === true;

		// Check if session has existing data to restore
		const existingSession = logger.time("loadSessionContext", () =>
			deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
		);
		const existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
		const hasExistingSession = existingBranch.length > 0;
		const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
		const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

		const hasExplicitModel = options.model !== undefined || options.modelPattern !== undefined;
		const modelMatchPreferences = {
			usageOrder: settings.getStorage()?.getModelUsageOrder(),
		};
		const allowedModels = await logger.time("resolveAllowedModels", () =>
			resolveAllowedModels(modelRegistry, settings, modelMatchPreferences),
		);
		const defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
			resolveModelRoleValue(settings.getModelRole("default"), allowedModels, {
				settings,
				matchPreferences: modelMatchPreferences,
				modelRegistry,
			}),
		);
		let model = options.model;
		let modelFallbackMessage: string | undefined;
		const persistedDefaultChain = existingSession.configuredModelChains.default?.entries;
		const defaultModelEntries =
			persistedDefaultChain && persistedDefaultChain.length > 0
				? persistedDefaultChain
				: existingSession.models.default
					? [existingSession.models.default]
					: [];
		// If session has data, restore its configured default chain rather than the
		// scalar runtime model, which may be a stale fallback from the prior run.
		if (!hasExplicitModel && !model && hasExistingSession && defaultModelEntries.length > 0) {
			await logger.time("restoreSessionModel", async () => {
				const restoredDefaultResolution = await resolveModelChainWithAuth(
					defaultModelEntries,
					modelRegistry,
					settings,
					providerSessionId,
					{ managedFallback: defaultModelEntries.length > 1 },
				);
				model = restoredDefaultResolution.model;
				if (!model) modelFallbackMessage = `Could not restore model ${defaultModelEntries.join(" -> ")}`;
			});
		}

		// If still no model, try settings default.
		// Skip settings fallback when an explicit model was requested.
		if (!hasExplicitModel && !model && defaultRoleSpec.model) {
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
			// Fire-and-forget TLS+H2 handshake to the model's host so it overlaps
			// with the rest of session setup (extension/skill load, tool registry,
			// system prompt build). Without this, the first `fetch(...)` pays the
			// full handshake serially — 100–300 ms transcontinental for
			// api.anthropic.com from a residential IP. Every session frontend benefits
			// (interactive, print, SDK, ACP).
			preconnectModelHost(model.baseUrl);
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
				disabledExtensions: settings.get("disabledExtensions"),
			});
			skills = withEmbeddedDefaultGjcSkills(skillsResult.skills);
			skillWarnings = skillsResult.warnings;
		} else {
			// GJC's four public workflow skills are bundled into the binary so the
			// default workflow surface survives accidental .gjc deletion. Arbitrary
			// filesystem skill discovery remains gated by skills.enabled above.
			skills = getEmbeddedDefaultGjcSkills();
			skillWarnings = [];
		}

		// Discover rules and bucket them in one pass to avoid repeated scans over large rule sets.
		const { ttsrManager, rulebookRules, alwaysApplyRules } = await logger.time("discoverTtsrRules", async () => {
			const ttsrSettings = settings.getGroup("ttsr");
			const ttsrManager = new TtsrManager(ttsrSettings);
			const rulesResult =
				options.rules !== undefined
					? { items: options.rules, warnings: undefined }
					: await loadCapability<Rule>(ruleCapability.id, { cwd });
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
		const [contextFiles, resolvedWorkspaceTree] = await Promise.all([
			contextFilesPromise,
			raceWithDeadline("buildWorkspaceTree", workspaceTreePromise),
		]);

		const backgroundJobsEnabled = isBackgroundJobSupportEnabled(settings);
		const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
		const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
		const ASYNC_PREVIEW_MAX_CHARS = 4_000;
		const formatAsyncResultForFollowUp = async (result: string): Promise<string> => {
			if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
				return result;
			}

			const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
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
		const asyncJobManager =
			backgroundJobsEnabled && !options.parentTaskPrefix
				? new AsyncJobManager({
						maxRunningJobs: asyncMaxJobs,
						onJobComplete: async (jobId, result, job) => {
							if (!session || asyncJobManager!.isDeliverySuppressed(jobId)) return;
							const formattedResult = await formatAsyncResultForFollowUp(result);
							if (asyncJobManager!.isDeliverySuppressed(jobId)) return;

							const durationMs = job ? jobElapsedMs(job) : undefined;
							session.yieldQueue.enqueue<AsyncResultEntry>("async-result", {
								jobId,
								result: formattedResult,
								job,
								durationMs,
							});
						},
					})
				: undefined;

		let promptMetadataModel: Model | undefined;
		const getActiveModelString = (): string | undefined => {
			const activeModel = promptMetadataModel ?? agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			if (model) return formatModelString(model);
			return undefined;
		};
		const toolSession: ToolSession = {
			get cwd() {
				return sessionManager.getCwd();
			},
			hasUI: options.hasUI ?? false,
			enableLsp,
			get hasEditTool() {
				const requestedToolNames = options.toolNames
					? [...new Set(options.toolNames.map(name => name.toLowerCase()))]
					: undefined;
				return !requestedToolNames || requestedToolNames.includes("edit");
			},
			skipPythonPreflight: options.skipPythonPreflight,
			contextFiles,
			workspaceTree: resolvedWorkspaceTree,
			skills,
			eventBus,
			outputSchema: options.outputSchema,
			requireYieldTool: options.requireYieldTool,
			taskDepth: options.taskDepth ?? 0,
			currentAgentType: options.currentAgentType,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getEvalKernelOwnerId: () => evalKernelOwnerId,
			assertEvalExecutionAllowed: () => session?.assertEvalExecutionAllowed(),
			trackEvalExecution: (execution, abortController) =>
				session ? session.trackEvalExecution(execution, abortController) : execution,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getActiveSkillState: () => session?.getActiveSkillState(),
			getActiveSkillPhase: () => session?.getActiveSkillPhase(),
			getHindsightSessionState: () => session?.getHindsightSessionState(),
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
			getAgentId: () => resolvedAgentId,
			bashAllowedPrefixes: options.bashAllowedPrefixes,
			bashRestrictionProfile: options.bashRestrictionProfile,
			goalToolAllowedOps: options.goalToolAllowedOps,
			discoverableToolAllowedNames: options.discoverableToolAllowedNames,
			getToolByName: name => session?.getToolByName(name),
			agentRegistry,
			getSessionSpawns: () => options.spawns ?? "*",
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
			getSelectedDiscoveredToolNames: () => session.getSelectedDiscoveredToolNames(),
			activateDiscoveredTools: toolNames => session.activateDiscoveredTools(toolNames),
			getCheckpointState: () => session.getCheckpointState(),
			setCheckpointState: state => session.setCheckpointState(state ?? undefined),
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: name => {
				const m = session.model;
				return m ? buildNamedToolChoice(name, m) : undefined;
			},
			buildToolChoiceResult: name => buildNamedToolChoiceResult(name, session.model),
			steer: msg =>
				session.agent.steer({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: false,
					details: msg.details,
					attribution: "agent",
					timestamp: Date.now(),
				}),
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
			settings,
			authStorage,
			modelRegistry,
			getTelemetry: () => agent?.telemetry,
			buildForkContextSeed: forkOptions => session.buildForkContextSeed(forkOptions),
		};

		// Wire process-wide internal URL singletons owned by their real classes.
		// Top-level sessions install the active snapshots; subagents inherit them.
		// Artifact and agent-output URLs resolve via `AgentRegistry.global()` —
		// the protocol handlers walk each ref's `sessionManager.getArtifactsDir()`,
		// which collapses to the parent's dir for subagents (they adopt the
		// parent's ArtifactManager) so one lookup hits everything.
		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		if (!options.parentTaskPrefix) {
			setActiveSkills(skills);
			setActiveRules([...rulebookRules, ...alwaysApplyRules]);
			if (asyncJobManager) AsyncJobManager.setInstance(asyncJobManager);
		}
		if (options.localProtocolOptions) {
			disposeLocalProtocolOverride = LocalProtocolHandler.installOverride(options.localProtocolOptions);
		}
		toolSession.getArtifactsDir = getArtifactsDir;
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);

		// Create built-in tools (already wrapped with meta notice formatting)
		const builtinTools = await logger.time("createAllTools", createTools, toolSession, options.toolNames);

		// MCP runtime discovery is quarantined for the GJC surface. A top-level
		// session may load only a caller-supplied exact config; project and user
		// MCP configs are never discovered here. Existing managers remain available
		// for legacy in-process callers, and plugin-bundle managers are created
		// below after `customTools` is populated.
		let mcpManager: MCPManager | undefined = options.mcpManager;
		let ownsMcpManager = false;
		const explicitMcpConfigPath = !isCanonicalSubSession && !options.mcpManager ? options.mcpConfigPath : undefined;
		const customTools: CustomTool[] = [];
		const exactMcpToolNames: string[] = [];

		// Add image tools when the active model or configured image providers can generate images.
		const imageGenTools = await logger.time("getImageGenTools", () => getImageGenTools(modelRegistry, model));
		if (imageGenTools.length > 0) {
			customTools.push(...(imageGenTools as unknown as CustomTool[]));
		}

		// Add web search tools
		if (options.toolNames?.includes("web_search")) {
			customTools.push(...getSearchTools());
		}

		const getReservedSubskillToolNames = () => [
			...new Set([
				...builtinTools.map(tool => tool.name),
				...(options.toolNames?.map(name => name.toLowerCase()) ?? []),
				...(options.customTools?.map(tool => (isCustomTool(tool) ? tool.name : tool.name)) ?? []),
				...customTools.map(tool => tool.name),
			]),
		];

		const gjcSubskillToolContext = options.gjcSubskillToolContext;
		if (gjcSubskillToolContext?.parent.trim() && gjcSubskillToolContext.phase.trim()) {
			const pluginTools = await loadActiveSubskillTools({
				cwd: gjcSubskillToolContext.cwd ?? cwd,
				sessionId: gjcSubskillToolContext.sessionId ?? logicalSessionId,
				parent: gjcSubskillToolContext.parent,
				phase: gjcSubskillToolContext.phase,
				reservedToolNames: getReservedSubskillToolNames(),
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
				});
				if (pluginTools.length > 0) {
					customTools.push(...pluginTools);
				}
			}
		}

		// Always-on GJC plugin bundle tools (validated registry surfaces). This is
		// additive and a no-op when no plugins are installed for the cwd. Surfaces
		// are hash-verified and collision-checked; declared names are authoritative.
		try {
			const pluginToolResult = await loadAlwaysOnPluginTools({
				cwd,
				reservedToolNames: [...getReservedSubskillToolNames(), ...customTools.map(tool => tool.name)],
			});
			if (pluginToolResult.tools.length > 0) customTools.push(...pluginToolResult.tools);
			for (const q of pluginToolResult.quarantine) {
				logger.warn("Quarantined GJC plugin surface", { plugin: q.plugin, surface: q.surfaceId, code: q.code });
			}
		} catch (error) {
			logger.warn("Failed to load always-on GJC plugin tools", { error });
		}

		const preExactCustomToolNames = customTools.map(tool => tool.name);
		if (explicitMcpConfigPath !== undefined) {
			const owned = new MCPManager(cwd, null, { toolsOnly: true });
			owned.setAuthStorage(authStorage);
			mcpManager = owned;
			ownsMcpManager = true;
			cleanupOwnedMcpManager = () => owned.disconnectAll();
			const result = await owned.discoverAndConnect({ configPath: explicitMcpConfigPath });
			const resultTools = result.tools as CustomTool[];
			exactMcpToolNames.push(...resultTools.map(tool => tool.name));
			customTools.push(...resultTools);
			if (result.errors.size > 0 || result.tools.length === 0) {
				logger.warn("MCP tools could not be loaded.");
			}
		} else if (!mcpManager && !isCanonicalSubSession) {
			// Always-on GJC plugin-bundle MCP servers. Top-level sessions own a manager
			// and connect the validated servers; subagents inherit the parent's manager
			// via options.mcpManager and never spawn their own (prevents duplicate
			// processes and leaks). Per the plugin product contract, connected MCP tools
			// are surfaced as always-on tools rather than gated behind MCP selection.
			try {
				const { configs, quarantine } = await buildPluginMcpConfigs({ cwd });
				for (const q of quarantine) {
					logger.warn("Quarantined GJC plugin MCP", { plugin: q.plugin, surface: q.surfaceId, code: q.code });
				}
				if (Object.keys(configs).length > 0) {
					const owned = new MCPManager(cwd);
					try {
						const sources = Object.fromEntries(
							Object.keys(configs).map(name => [
								name,
								{ provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" as const },
							]),
						);
						const result = await owned.connectServers(configs, sources as never);
						for (const [server, err] of result.errors) {
							logger.warn("GJC plugin MCP connect failed", { path: `mcp:${server}`, error: err });
						}
						if (result.connectedServers.length > 0) {
							mcpManager = owned;
							ownsMcpManager = true;
							customTools.push(...(result.tools as CustomTool[]));
						} else {
							await owned.disconnectAll().catch(() => {});
						}
					} catch (error) {
						// Avoid leaking partially-started server processes on failure.
						await owned.disconnectAll().catch(() => {});
						throw error;
					}
				}
			} catch (error) {
				logger.warn("Failed to wire GJC plugin MCP servers", { error });
			}
		} else if (isCanonicalSubSession) {
			// Subagent: inherit the parent's always-on plugin MCP tools WITHOUT
			// owning the manager (no connect, no callbacks, no disposal). The
			// top-level session installed its manager as the process-global
			// instance; reading getTools() surfaces the same always-on tools so the
			// product decision holds for subagent sessions too.
			const singleton = MCPManager.instance();
			const inherited = mcpManager ?? (singleton?.isToolsOnly() ? undefined : singleton);
			if (inherited) {
				try {
					const inheritedTools = inherited.getTools();
					if (inheritedTools.length > 0) customTools.push(...(inheritedTools as CustomTool[]));
				} catch (error) {
					logger.warn("Failed to inherit plugin MCP tools in subagent", { error });
				}
			}
		}
		// Exact-config managers are session-local. Plugin managers keep their
		// existing top-level singleton behavior for bundled runtime surfaces.
		if (mcpManager && !mcpManager.isToolsOnly() && !isCanonicalSubSession && explicitMcpConfigPath === undefined) {
			MCPManager.setInstance(mcpManager);
		}

		// Custom tool and extension discovery is quarantined from the public GJC utility surface.
		// Explicit SDK extension factories are still honored; callers use them to
		// register in-process tools/providers without enabling filesystem discovery.
		const inlineExtensions: ExtensionFactory[] = [...(options.extensions ?? [])];
		if (customTools.length > 0) {
			inlineExtensions.push(createCustomToolsExtension(customTools));
		}

		// Always-on constrained plugin hooks (validated registry surfaces). Additive
		// and a no-op without installed plugins; the loader denies all dangerous APIs.
		try {
			const pluginHookResult = await loadConstrainedPluginHooks({ cwd });
			if (pluginHookResult.hooks.length > 0) {
				inlineExtensions.push(createPluginHooksExtension(pluginHookResult.hooks));
			}
			for (const q of pluginHookResult.quarantine) {
				logger.warn("Quarantined GJC plugin hook", { plugin: q.plugin, surface: q.surfaceId, code: q.code });
			}
		} catch (error) {
			logger.warn("Failed to load constrained GJC plugin hooks", { error });
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
		const notificationHostEligible = isNotificationHostEligible({
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
		});
		if (
			lifecycleStartupCapability ||
			shouldRegisterNotificationsExtension({
				env: process.env,
				cfg: notificationCfg,
				taskDepth,
				parentTaskPrefix: options.parentTaskPrefix,
				currentAgentType: options.currentAgentType,
				spawnedByGjc,
			}) ||
			shouldHostSdk(notificationCfg, isTopLevelSdkSession)
		) {
			inlineExtensions.push(async api => {
				try {
					if (lifecycleStartupCapability) attachLifecycleStartupCapability(api, lifecycleStartupCapability);
					if (lifecycleStartupCapability && process.env.GJC_SDK_TEST_FACTORY_FAILURE === cwd)
						throw new Error(process.env.GJC_SDK_TEST_FACTORY_SECRET ?? "Lifecycle factory test failure.");
					createNotificationsExtension(api, {
						settings,
						controller: notificationSessionController,
						spawnedByGjc,
						runEphemeralTurn: async (promptText, signal) => {
							if (!session) throw new Error("Ephemeral turns are unavailable.");
							const { replyText } = await session.runEphemeralTurn({ promptText, signal });
							return { replyText };
						},
					});
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

		// Resolve deferred --model pattern now that extension models are registered.
		if (!model && options.modelPattern) {
			const availableModels = modelRegistry.getAll();
			const matchPreferences = {
				usageOrder: settings.getStorage()?.getModelUsageOrder(),
			};
			const { model: resolved } = parseModelPattern(options.modelPattern, availableModels, matchPreferences, {
				modelRegistry,
			});
			if (resolved) {
				model = resolved;
				modelFallbackMessage = undefined;
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
		if (!model && !options.modelPattern) {
			// Re-resolve the allowed set: extension factories above may have
			// registered providers/models that weren't visible at startup.
			const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
			for (const candidate of fallbackCandidates) {
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

		if (options.credentialSelector && !runtimeCredentialSelectorInstalled) {
			const credentialProvider = options.credentialSelector.provider ?? model?.provider;
			if (!credentialProvider) {
				throw new Error(
					`--credential ${options.credentialSelector.raw} requires a resolved model or an explicit provider prefix`,
				);
			}
			installRuntimeCredentialSelector(credentialProvider);
			if (!options.modelRegistry && !canRefreshModelsBeforeCredentialSelector) {
				modelRegistry.refreshInBackground();
			}
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
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				session.abort();
			},
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
				model: agent?.state.model,
				isIdle: () => !session?.isStreaming,
				hasQueuedMessages: () => (session?.queuedMessageCount ?? 0) > 0,
				abort: () => session?.abort(),
				settings,
			});
			wrappedExtensionTools = (options.customTools ?? [])
				.filter(isCustomTool)
				.map(tool => CustomToolAdapter.wrap(tool, customToolContext));
		}

		// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
		const toolRegistry = new Map<string, Tool>();
		let builtinCandidateTools = [...builtinTools];
		for (const tool of builtinTools) {
			toolRegistry.set(tool.name, tool);
		}
		const goalStateToolNames = ["goal"] as const;
		if (settings.get("goal.enabled")) {
			for (const name of goalStateToolNames) {
				if (toolRegistry.has(name)) continue;
				const goalStateTool = await logger.time(`createTools:${name}:session`, BUILTIN_TOOLS[name], toolSession);
				if (goalStateTool) {
					const wrappedGoalStateTool = wrapToolWithMetaNotice(goalStateTool);
					builtinCandidateTools.push(wrappedGoalStateTool);
					toolRegistry.set(wrappedGoalStateTool.name, wrappedGoalStateTool);
				}
			}
		}
		for (const tool of wrappedExtensionTools) {
			toolRegistry.set(tool.name, tool);
		}
		if (extensionRunner) {
			for (const tool of toolRegistry.values()) {
				toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
			}
		}
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
			}
		}
		// Exact-config MCP tools cannot claim a name already represented by the final candidate catalog.
		// Other catalog collisions retain their legacy override behavior.
		if (exactMcpToolNames.length > 0) {
			const catalogToolNames = [
				...builtinCandidateTools.map(tool => tool.name),
				...preExactCustomToolNames,
				...wrappedExtensionTools.map(tool => tool.name),
			];
			const collidingToolNames = findExactMcpToolNameCollisions(exactMcpToolNames, catalogToolNames);
			if (collidingToolNames.length > 0) {
				throw new ExactMcpToolNameCollisionError(collidingToolNames);
			}
		}

		const reloadSshTool = async (): Promise<AgentTool | null> => {
			if (!requestedToolNameSet.has("ssh")) return null;
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
			tools: toolRegistry,
			getToolContext: () => toolContextStore.getContext(),
			emitEvent: event => cursorEventEmitter?.(event),
			createEventEmitter: () => agent.createExternalEventEmitterForCurrentRun(),
		});

		const repeatToolDescriptions = settings.get("repeatToolDescriptions");
		const eagerTasks = settings.get("task.eager");
		const intentTracingEnabled = resolveIntentTracingEnabled(
			settings.get("tools.intentTracing"),
			options.hasUI ?? false,
		);
		const intentField = intentTracingEnabled ? INTENT_FIELD : undefined;
		const rebuildSystemPrompt = async (
			toolNames: string[],
			tools: Map<string, AgentTool>,
			candidateModel?: Model,
		): Promise<BuildSystemPromptResult> => {
			toolContextStore.setToolNames(toolNames);
			const promptTools = (() => {
				const previousPromptMetadataModel = promptMetadataModel;
				promptMetadataModel = candidateModel;
				try {
					return buildSystemPromptToolMetadata(tools);
				} finally {
					promptMetadataModel = previousPromptMetadataModel;
				}
			})();
			const memoryInstructions = await resolveMemoryBackend(settings).buildDeveloperInstructions(
				agentDir,
				settings,
				session,
			);

			const appendPrompt: string | undefined = memoryInstructions ?? undefined;
			let pluginSystemAppendices = "";
			try {
				pluginSystemAppendices = await renderAlwaysOnSystemAppendices({ cwd });
			} catch (error) {
				logger.warn("Failed to render GJC plugin system appendices", { error });
			}
			const defaultPrompt = await buildSystemPromptInternal({
				cwd,
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
				eagerTasks,
				secretsEnabled,
				workspaceTree: workspaceTreePromise,
				subagent: options.parentTaskPrefix !== undefined,
			});

			if (options.systemPrompt === undefined) {
				return defaultPrompt;
			}
			if (Array.isArray(options.systemPrompt)) {
				return { systemPrompt: options.systemPrompt };
			}
			return {
				systemPrompt: options.systemPrompt(defaultPrompt.systemPrompt),
			};
		};

		const toolNamesFromRegistry = Array.from(toolRegistry.keys());
		const requestedToolNames = options.toolNames
			? [
					...new Set([
						...options.toolNames.map(name => name.toLowerCase()),
						...(settings.get("goal.enabled") ? ["goal"] : []),
					]),
				]
			: toolNamesFromRegistry;
		const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
		const requestedToolNameSet = new Set(normalizedRequested);
		// Normalize the user-facing mcp.discoveryMode alias once at session construction.
		const toolsDiscoveryModeSetting = settings.get("tools.discoveryMode");
		const effectiveDiscoveryMode: "off" | "mcp-only" | "all" =
			toolsDiscoveryModeSetting !== "off"
				? (toolsDiscoveryModeSetting as "mcp-only" | "all")
				: settings.get("mcp.discoveryMode") || explicitMcpConfigPath !== undefined
					? "mcp-only"
					: "off";
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
		if (mcpDiscoveryEnabled) {
			const defaultServerNames = new Set(settings.get("mcp.discoveryDefaultServers") ?? []);
			for (const tool of toolRegistry.values()) {
				if (!isMCPBridgeTool(tool)) continue;
				discoverableMCPToolNames.add(tool.name);
				if (initialRequestedActiveToolNames.includes(tool.name)) {
					explicitlyRequestedMCPToolNames.push(tool.name);
				}
				const serverName = (tool as AgentTool & { mcpServerName?: string }).mcpServerName;
				if (serverName && defaultServerNames.has(serverName)) {
					discoveryDefaultServerToolNames.push(tool.name);
				}
			}
		}
		let initialToolNames = [...initialRequestedActiveToolNames];
		if (mcpDiscoveryEnabled) {
			const restoredSelectedMCPToolNames = existingSession.selectedMCPToolNames.filter(name =>
				toolRegistry.has(name),
			);
			defaultSelectedMCPToolNames = [
				...new Set([
					...discoveryDefaultServerToolNames,
					...explicitlyRequestedMCPToolNames,
					...(explicitMcpConfigPath !== undefined ? exactMcpToolNames : []),
				]),
			];
			initialSelectedMCPToolNames = existingSession.hasPersistedMCPToolSelection
				? restoredSelectedMCPToolNames
				: [...new Set([...restoredSelectedMCPToolNames, ...defaultSelectedMCPToolNames])];
			initialToolNames = [
				...new Set([
					...initialRequestedActiveToolNames.filter(name => !discoverableMCPToolNames.has(name)),
					...initialSelectedMCPToolNames,
				]),
			];
		}

		// Custom tools and extension-registered tools are always included regardless of toolNames filter
		const alwaysInclude: string[] = [
			...(options.customTools?.map(t => (isCustomTool(t) ? t.name : t.name)) ?? []),
			...registeredTools.filter(t => !t.definition.defaultInactive).map(t => t.definition.name),
		];
		for (const name of alwaysInclude) {
			if (mcpDiscoveryEnabled && discoverableMCPToolNames.has(name)) {
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
			const essentialBuiltinNames = new Set(computeEssentialBuiltinNames(settings));
			const explicitlyRequestedToolNames = new Set(options.toolNames?.map(name => name.toLowerCase()) ?? []);
			// Back-compat: persisted activations live under selectedMCPToolNames today (built-in
			// activation persistence is a follow-up). MCP names won't collide with built-in names.
			const restoredDiscoveredNames = new Set(existingSession.selectedMCPToolNames);
			initialToolNames = initialToolNames.filter(name => {
				const tool = toolRegistry.get(name);
				if (!tool?.loadMode) return true; // not a built-in — leave MCP/custom/extension to existing logic
				if (tool.loadMode === "essential") return true;
				if (essentialBuiltinNames.has(name)) return true;
				if (explicitlyRequestedToolNames.has(name)) return true;
				if (restoredDiscoveredNames.has(name)) return true;
				return false;
			});
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

		const promptTemplates = await promptTemplatesPromise;
		toolSession.promptTemplates = promptTemplates;

		const slashCommands = await slashCommandsPromise;

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
			if (!obfuscator?.hasSecrets()) return converted;
			return obfuscateMessages(obfuscator, converted);
		};
		const transformContext = async (messages: AgentMessage[], _signal?: AbortSignal) => {
			// External Agent events dispatch listeners without awaiting them. The
			// session-owned barrier makes any pre-admission artifact transformation
			// visible before this provider context is normalized.
			await session?.awaitPendingContextTransformations();
			return extensionRunner ? await extensionRunner.emitContext(messages) : messages;
		};
		const onPayload = extensionRunner
			? async (payload: unknown, _model?: Model) => {
					return await extensionRunner.emitBeforeProviderRequest(payload);
				}
			: undefined;
		const onResponse: SimpleStreamOptions["onResponse"] | undefined = extensionRunner
			? async (response, model) => {
					await extensionRunner.emitAfterProviderResponse(response, model);
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
			interruptMode: settings.get("interruptMode") ?? "immediate",
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
			kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
			shouldPause: options.shouldPause,
			preferWebsockets: preferOpenAICodexWebsockets,
			getToolContext: tc => toolContextStore.getContext(tc),
			getApiKey: async provider => {
				// Read agent.sessionId at call time so credential selection stays aligned
				// with metadataResolver after /new, fork, resume, or branch switches.
				const key = await modelRegistry.getApiKeyForProvider(provider, agent.providerSessionId ?? agent.sessionId);
				if (!key) {
					throw new Error(`No API key found for provider "${provider}"`);
				}
				return key;
			},
			getAuthCredentialType: provider =>
				modelRegistry.getSessionCredentialType(provider, agent.providerSessionId ?? agent.sessionId),
			streamFn: (streamModel, context, streamOptions) =>
				streamSimple(streamModel, context, {
					...streamOptions,
					onAuthError: async (provider, oldKey, error) => {
						await modelRegistry.authStorage.invalidateCredentialMatching(provider, oldKey, {
							signal: streamOptions?.signal,
							sessionId: agent.sessionId,
						});
						logger.debug("Retrying provider request after credential invalidation", {
							provider,
							error: error instanceof Error ? error.message : String(error),
						});
						return modelRegistry.getApiKeyForProvider(provider, agent.sessionId);
					},
				}),
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

		cursorEventEmitter = event => agent.emitExternalEvent(event);

		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.replaceMessages(existingSession.messages);
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

		session = new AgentSession({
			agent,
			thinkingLevel,
			sessionManager,
			settings,
			notificationSessionController,
			evalKernelOwnerId,
			// Defined only for top-level sessions (creation is gated above).
			// AgentSession uses this to decide whether it may dispose the global
			// AsyncJobManager on teardown; subagents inherit the parent's and
			// **MUST NOT** tear it down.
			ownedAsyncJobManager: asyncJobManager,
			// Only an MCP manager owned by this session is torn down on dispose;
			// subagents and callers that merely observe a manager must not (see
			// AgentSession.dispose).
			ownedMcpManager: ownsMcpManager ? mcpManager : undefined,
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
			toolRegistry,
			workflowGateToolSession: toolSession,
			transformContext,
			onPayload,
			onResponse,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			getMcpServerInstructions:
				explicitMcpConfigPath === undefined && mcpManager ? () => mcpManager.getServerInstructions() : undefined,
			workspaceTree: resolvedWorkspaceTree,
			reloadSshTool,
			requestedToolNames: requestedToolNameSet,
			discoverableToolAllowedNames: options.discoverableToolAllowedNames,
			mcpDiscoveryEnabled,
			discoveryMode: effectiveDiscoveryMode,
			initialSelectedMCPToolNames,
			defaultSelectedMCPToolNames,
			persistInitialMCPToolSelection: !hasExistingSession,
			defaultSelectedMCPServerNames: settings.get("mcp.discoveryDefaultServers") ?? [],
			ttsrManager,
			obfuscator,
			agentId: resolvedAgentId,
			agentRegistry,
			providerSessionId: options.providerSessionId,
			providerCacheSessionId: providerSessionId,
			forkContextSeed: options.forkContextSeed,
			providerSessionState: options.providerSessionState,
		});
		hasSession = true;
		if (asyncJobManager) {
			session.yieldQueue.register<AsyncResultEntry>("async-result", {
				isStale: entry => asyncJobManager.isDeliverySuppressed(entry.jobId),
				build: buildAsyncResultBatchMessage,
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
						closeOwnedAuthStorage();
					}
				}
			};
		}

		if (model?.api === "openai-codex-responses") {
			const codexModel = model;
			const codexTransport = getOpenAICodexTransportDetails(codexModel, {
				sessionId: providerSessionId,
				baseUrl: codexModel.baseUrl,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: session.providerSessionState,
			});
			if (codexTransport.websocketPreferred) {
				void (async () => {
					try {
						const codexPrewarmApiKey = await modelRegistry.getApiKey(codexModel, providerSessionId);
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
				? discoverStartupLspServers(cwd)
				: undefined;

		logger.time("startMemoryStartupTask", () =>
			Promise.resolve(
				resolveMemoryBackend(settings).start({
					session,
					settings,
					modelRegistry,
					agentDir,
					taskDepth,
					parentHindsightSessionState: options.parentHindsightSessionState,
				}),
			),
		);

		// Exact-config managers do not receive reactive callbacks; their tools are
		// registered once in the session-owned catalog.
		if (mcpManager && !options.mcpManager && explicitMcpConfigPath === undefined) {
			// The owned plugin-bundle manager surfaces its tools as always-on custom
			// tools (registered above), so it must NOT drive refreshMCPTools — that
			// path strips MCP bridge tools and re-gates them behind MCP selection,
			// which would deactivate the always-on plugin tools. Reactive tool
			// updates remain wired only for externally supplied managers.
			// The owned manager is disconnected by AgentSession.dispose via
			// ownedMcpManager; only externally supplied managers wire reactive
			// refreshMCPTools (the owned always-on path must not, or it would
			// deactivate the plugin tools).
			if (!ownsMcpManager) {
				mcpManager.setOnToolsChanged(tools => {
					void session.refreshMCPTools(tools);
				});
			}
			// Wire prompt refresh → rebuild MCP prompt slash commands
			mcpManager.setOnPromptsChanged(serverName => {
				const promptCommands = buildMCPPromptCommands(mcpManager);
				session.setMCPPromptCommands(promptCommands);
				logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
			});
			const notificationDebounceTimers = new Map<string, Timer>();
			const clearDebounceTimers = () => {
				for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
				notificationDebounceTimers.clear();
			};
			postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
			mcpManager.setOnResourcesChanged((serverName, uri) => {
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
						// Re-check: user may have disabled notifications during the debounce window
						if (!settings.get("mcp.notifications")) return;
						session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
					}, debounceMs),
				);
			});
		}

		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager: ownsMcpManager && mcpManager?.isToolsOnly() ? undefined : mcpManager,
			modelFallbackMessage,
			lspServers,
			eventBus,
		};
	} catch (error) {
		// Release the subscription if the throw happened after install but before the
		// dispose-wrap took ownership.
		releaseCredentialDisabledSubscription();
		try {
			if (hasSession) {
				await session.dispose();
			} else {
				if (hasRegistered) agentRegistry.unregister(resolvedAgentId);
				await cleanupOwnedMcpManager?.();
				await disposeKernelSessionsByOwner(evalKernelOwnerId);
				await disposeVmContextsByOwner(evalKernelOwnerId);
			}
		} catch {
			logger.warn("Failed to clean up createAgentSession resources after startup error");
		} finally {
			releaseLocalProtocolOverride();
			try {
				closeOwnedAuthStorage();
			} catch {
				logger.warn("Failed to close owned auth storage after startup error");
			}
		}
		throw error;
	}
}

/**
 * Best-effort preconnect to the model's API host. Bun's `fetch.preconnect`
 * primes DNS + TCP + TLS + H2 so the first real request reuses the warm
 * connection. Errors are swallowed: preconnect is an optimization, never a
 * hard dependency.
 */
function preconnectModelHost(baseUrl: string | undefined): void {
	if (!baseUrl) return;
	const preconnect = (globalThis.fetch as typeof fetch & { preconnect?: (url: string) => void }).preconnect;
	if (typeof preconnect !== "function") return;
	try {
		preconnect(baseUrl);
	} catch {
		// Best effort.
	}
}
