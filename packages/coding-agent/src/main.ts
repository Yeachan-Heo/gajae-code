/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import type { ImageContent } from "@gajae-code/ai";
import {
	$env,
	getProjectDir,
	logger,
	normalizePathForComparison,
	postmortem,
	setProjectDir,
	VERSION,
} from "@gajae-code/utils";
import chalk from "chalk";
import type { Args } from "./cli/args";
import { processFileArguments } from "./cli/file-processor";
import { buildInitialMessage } from "./cli/initial-message";
import { runListModelsCommand } from "./cli/list-models";
import { selectSession } from "./cli/session-picker";
import { findConfigFile } from "./config";
import { ModelRegistry, ModelsConfigFile } from "./config/model-registry";
import { resolveCliModel, resolveModelRoleValue, resolveModelScope, type ScopedModel } from "./config/model-resolver";
import { getDefault, type SettingPath, Settings, settings } from "./config/settings";
import { initializeWithSettings } from "./discovery";
import { exportFromFile } from "./export/html";
import type { ExtensionUIContext } from "./extensibility/extensions/types";
import { InteractiveMode, runAcpMode, runPrintMode, runRpcMode } from "./modes";
import { initTheme, stopThemeWatcher } from "./modes/theme/theme";
import type { SubmittedUserInput } from "./modes/types";
import type { MCPManager } from "./runtime-mcp";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
} from "./sdk";
import type { AgentSession } from "./session/agent-session";
import type { AuthStorage } from "./session/auth-storage";
import { resolveResumableSession, type SessionInfo, SessionManager } from "./session/session-manager";
import { formatModelOnboardingGuidance } from "./setup/model-onboarding-guidance";
import { executeBuiltinSlashCommand } from "./slash-commands/builtin-registry";
import { resolvePromptInput } from "./system-prompt";
import type { LspStartupServerInfo } from "./tools";
import { getDisplayChangelogEntries, getNewEntries } from "./utils/changelog";
import type { EventBus } from "./utils/event-bus";

async function checkForNewVersion(currentVersion: string): Promise<string | undefined> {
	if (!settings.get("startup.checkUpdate")) {
		return;
	}
	try {
		const response = await fetch("https://registry.npmjs.org/@gajae-code/coding-agent/latest");
		if (!response.ok) return undefined;

		const data = (await response.json()) as { version?: string };
		const latestVersion = data.version;

		if (latestVersion && Bun.semver.order(latestVersion, currentVersion) > 0) {
			return latestVersion;
		}

		return undefined;
	} catch {
		return undefined;
	}
}

const RPC_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"todo.enabled",
	"todo.reminders",
	"todo.reminders.max",
	"todo.eager",
	"async.enabled",
	"async.maxJobs",
	"bash.autoBackground.enabled",
	"bash.autoBackground.thresholdMs",
	"task.isolation.mode",
	"task.isolation.merge",
	"task.isolation.commits",
	"task.eager",
	"task.simple",
	"task.maxConcurrency",
	"task.maxRecursionDepth",
	"task.disabledAgents",
	"task.agentModelOverrides",
	// Memory subsystems are off-by-default for RPC hosts; embedders that want
	// memory should opt in explicitly through their own settings layer.
	"memory.backend",
	"memories.enabled",
];

function applyRpcDefaultSettingOverrides(targetSettings: Settings = settings): void {
	for (const settingPath of RPC_DEFAULTED_SETTING_PATHS) {
		targetSettings.override(settingPath, getDefault(settingPath));
	}
}

async function readPipedInput(): Promise<string | undefined> {
	if (process.stdin.isTTY !== false) return undefined;
	try {
		const text = await Bun.stdin.text();
		if (text.trim().length === 0) return undefined;
		return text;
	} catch {
		return undefined;
	}
}

export interface InteractiveModeNotify {
	kind: "warn" | "error" | "info";
	message: string;
}

export async function submitInteractiveInput(
	mode: Pick<
		InteractiveMode,
		"markPendingSubmissionStarted" | "finishPendingSubmission" | "showError" | "checkShutdownRequested"
	>,
	session: Pick<AgentSession, "prompt" | "promptCustomMessage">,
	input: SubmittedUserInput,
): Promise<void> {
	if (input.cancelled) {
		return;
	}

	try {
		// Continue shortcuts submit an already-started empty prompt with no optimistic user message.
		if (!input.started && !mode.markPendingSubmissionStarted(input)) {
			return;
		}
		if (input.customType) {
			await session.promptCustomMessage({
				customType: input.customType,
				content: input.text,
				display: input.display ?? false,
				attribution: "agent",
			});
		} else {
			await session.prompt(input.text, { images: input.images });
		}
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
		mode.showError(errorMessage);
	} finally {
		mode.finishPendingSubmission(input);
		await mode.checkShutdownRequested();
	}
}

function applyExtensionFlagValues(session: AgentSession, rawArgs: string[]): Map<string, boolean | string> {
	const extensionRunner = session.extensionRunner;
	if (!extensionRunner) {
		return new Map();
	}

	const extFlags = extensionRunner.getFlags();
	if (extFlags.size > 0) {
		for (let i = 0; i < rawArgs.length; i++) {
			const arg = rawArgs[i];
			if (!arg.startsWith("--")) {
				continue;
			}
			const flagName = arg.slice(2);
			const extFlag = extFlags.get(flagName);
			if (!extFlag) {
				continue;
			}
			if (extFlag.type === "boolean") {
				extensionRunner.setFlagValue(flagName, true);
				continue;
			}
			if (i + 1 < rawArgs.length) {
				extensionRunner.setFlagValue(flagName, rawArgs[++i]);
			}
		}
	}

	return extensionRunner.getFlagValues();
}

type AcpSessionFactory = (cwd: string) => Promise<AgentSession>;

export interface AcpSessionFactoryOptions {
	baseOptions: CreateAgentSessionOptions;
	settings: Settings;
	sessionDir?: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	parsedArgs: Pick<Args, "apiKey">;
	rawArgs: string[];
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}

/**
 * Build the per-`session/new` factory used by ACP mode.
 *
 * MCP servers in ACP sessions are owned exclusively by the ACP client, which
 * supplies them through `session/new.mcpServers` and re-applies them via
 * {@link AcpAgent#configureMcpServers}. We therefore force `enableMCP: false`
 * on every session created here so {@link createAgentSession} skips the on-disk
 * `.mcp.json` discovery path — otherwise host MCP tools land in the session's
 * tool registry and shadow the client-supplied servers (issue #1234).
 */
export function createAcpSessionFactory(args: AcpSessionFactoryOptions): AcpSessionFactory {
	return async cwd => {
		const nextSettings = await args.settings.cloneForCwd(cwd);
		const nextSessionManager = SessionManager.create(cwd, args.sessionDir);
		const agentId = `acp:${nextSessionManager.getSessionId()}`;
		const { session: nextSession } = await args.createSession({
			...args.baseOptions,
			cwd,
			sessionManager: nextSessionManager,
			settings: nextSettings,
			authStorage: args.authStorage,
			modelRegistry: args.modelRegistry,
			agentId,
			hasUI: false,
			enableMCP: false,
		});
		if (args.parsedArgs.apiKey && !args.baseOptions.model && nextSession.model) {
			args.authStorage.setRuntimeApiKey(nextSession.model.provider, args.parsedArgs.apiKey);
		}
		applyExtensionFlagValues(nextSession, args.rawArgs);
		return nextSession;
	};
}

async function runInteractiveMode(
	session: AgentSession,
	version: string,
	changelogMarkdown: string | undefined,
	notifs: (InteractiveModeNotify | null)[],
	versionCheckPromise: Promise<string | undefined>,
	initialMessages: string[],
	setExtensionUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	lspServers: LspStartupServerInfo[] | undefined,
	mcpManager: MCPManager | undefined,
	eventBus?: EventBus,
	initialMessage?: string,
	initialImages?: ImageContent[],
): Promise<void> {
	const mode = new InteractiveMode(
		session,
		version,
		changelogMarkdown,
		setExtensionUIContext,
		lspServers,
		mcpManager,
		eventBus,
	);

	await mode.init();

	versionCheckPromise
		.then(newVersion => {
			if (!settings.get("startup.checkUpdate")) {
				return;
			}
			if (newVersion) {
				mode.showNewVersionNotification(newVersion);
			}
		})
		.catch(() => {});

	mode.renderInitialMessages(undefined, { preserveExistingChat: true });

	for (const notify of notifs) {
		if (!notify) {
			continue;
		}
		if (notify.kind === "warn") {
			mode.showWarning(notify.message);
		} else if (notify.kind === "error") {
			mode.showError(notify.message);
		} else if (notify.kind === "info") {
			mode.showStatus(notify.message);
		}
	}

	if (initialMessage !== undefined) {
		try {
			await session.prompt(initialMessage, { images: initialImages });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	for (const message of initialMessages) {
		try {
			let text = message;
			const slashResult = await executeBuiltinSlashCommand(text, {
				ctx: mode,
				handleBackgroundCommand: () => mode.handleBackgroundCommand(),
			});
			if (slashResult === true) continue;
			if (typeof slashResult === "string") text = slashResult;
			await session.prompt(text);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	while (true) {
		const input = await mode.getUserInput();
		await submitInteractiveInput(mode, session, input);
	}
}

async function promptForkSession(session: SessionInfo): Promise<boolean> {
	if (!process.stdin.isTTY) {
		return false;
	}
	const message = `Session found in different project: ${session.cwd}. Fork into current directory? [y/N] `;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(message)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

async function getChangelogForDisplay(parsed: Args): Promise<string | undefined> {
	if (parsed.continue || parsed.resume) {
		return undefined;
	}

	const lastVersion = settings.get("lastChangelogVersion");
	if (lastVersion === VERSION) {
		// Steady state: user already saw the current version's changelog. Skip the file read + parse.
		return undefined;
	}

	const entries = getDisplayChangelogEntries();

	if (!lastVersion) {
		if (entries.length > 0) {
			settings.set("lastChangelogVersion", VERSION);
			await flushChangelogVersion();
			return entries.map(e => e.content).join("\n\n");
		}
	} else {
		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			settings.set("lastChangelogVersion", VERSION);
			await flushChangelogVersion();
			return newEntries.map(e => e.content).join("\n\n");
		}
	}

	return undefined;
}

async function flushChangelogVersion(): Promise<void> {
	try {
		await settings.flush();
	} catch (error: unknown) {
		logger.warn("Failed to persist lastChangelogVersion", { error });
	}
}

async function createSessionManager(
	parsed: Args,
	cwd: string,
	activeSettings: Settings = settings,
): Promise<SessionManager | undefined> {
	if (parsed.fork) {
		if (parsed.noSession) {
			throw new Error("--fork requires session persistence");
		}
		const forkSource = parsed.fork;
		if (forkSource.includes("/") || forkSource.includes("\\") || forkSource.endsWith(".jsonl")) {
			return await SessionManager.forkFrom(forkSource, cwd, parsed.sessionDir);
		}
		const match = await resolveResumableSession(forkSource, cwd, parsed.sessionDir);
		if (!match) {
			throw new Error(`Session "${forkSource}" not found.`);
		}
		return await SessionManager.forkFrom(match.session.path, cwd, parsed.sessionDir);
	}

	if (parsed.noSession) {
		return SessionManager.inMemory();
	}
	if (typeof parsed.resume === "string") {
		const sessionArg = parsed.resume;
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			return await SessionManager.open(sessionArg, parsed.sessionDir);
		}
		const match = await resolveResumableSession(sessionArg, cwd, parsed.sessionDir);
		if (!match) {
			throw new Error(`Session "${sessionArg}" not found.`);
		}
		if (match.scope === "global") {
			const normalizedCwd = normalizePathForComparison(cwd);
			const normalizedMatchCwd = normalizePathForComparison(match.session.cwd || cwd);
			if (normalizedCwd !== normalizedMatchCwd) {
				const shouldFork = await promptForkSession(match.session);
				if (!shouldFork) {
					throw new Error(`Session "${sessionArg}" is in another project (${match.session.cwd}).`);
				}
				return await SessionManager.forkFrom(match.session.path, cwd, parsed.sessionDir);
			}
		}
		return await SessionManager.open(match.session.path, parsed.sessionDir);
	}
	if (parsed.continue) {
		return await SessionManager.continueRecent(cwd, parsed.sessionDir);
	}
	// --resume without value is handled separately (needs picker UI)
	// If --session-dir provided without --continue/--resume, create new session there
	if (parsed.sessionDir) {
		return SessionManager.create(cwd, parsed.sessionDir);
	}
	// Auto-resume: behave like --continue if the setting is enabled and a prior
	// session exists. When a prior session is resumed, mark parsed.continue so
	// buildSessionOptions restores the session's model/thinking instead of
	// overriding them with CLI defaults.
	if (activeSettings.get("autoResume")) {
		const manager = await SessionManager.continueRecent(cwd, parsed.sessionDir);
		if (manager.getEntries().length > 0) {
			parsed.continue = true;
		}
		return manager;
	}
	// Default case (new session) returns undefined, SDK will create one
	return undefined;
}

async function maybeAutoChdir(parsed: Args): Promise<void> {
	if (parsed.allowHome || parsed.cwd) {
		return;
	}

	const home = os.homedir();
	if (!home) {
		return;
	}

	const normalizePath = normalizePathForComparison;

	const cwd = normalizePath(getProjectDir());
	const normalizedHome = normalizePath(home);
	if (cwd !== normalizedHome) {
		return;
	}

	const isDirectory = async (p: string) => {
		try {
			const s = await fs.stat(p);
			return s.isDirectory();
		} catch {
			return false;
		}
	};

	const candidates = [path.join(home, "tmp"), "/tmp", "/var/tmp"];
	for (const candidate of candidates) {
		try {
			if (!(await isDirectory(candidate))) {
				continue;
			}
			setProjectDir(candidate);
			return;
		} catch {
			// Try next candidate.
		}
	}

	try {
		const fallback = os.tmpdir();
		if (fallback && normalizePath(fallback) !== cwd && (await isDirectory(fallback))) {
			setProjectDir(fallback);
		}
	} catch {
		// Ignore fallback errors.
	}
}

/** Discover APPEND_SYSTEM.md file if no CLI append system prompt was provided */
function discoverAppendSystemPromptFile(): string | undefined {
	const projectPath = findConfigFile("APPEND_SYSTEM.md", { user: false });
	if (projectPath) {
		return projectPath;
	}
	const globalPath = findConfigFile("APPEND_SYSTEM.md", { user: true });
	if (globalPath) {
		return globalPath;
	}
	return undefined;
}

async function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	sessionManager: SessionManager | undefined,
	modelRegistry: ModelRegistry,
	activeSettings: Settings,
): Promise<{ options: CreateAgentSessionOptions }> {
	const options: CreateAgentSessionOptions = {
		cwd: parsed.cwd ?? getProjectDir(),
	};

	const systemPromptSource = parsed.systemPrompt;
	const resolvedSystemPrompt = await resolvePromptInput(systemPromptSource, "system prompt");
	const appendPromptSource = parsed.appendSystemPrompt ?? discoverAppendSystemPromptFile();
	const resolvedAppendPrompt = await resolvePromptInput(appendPromptSource, "append system prompt");

	if (sessionManager) {
		options.sessionManager = sessionManager;
	}
	if (parsed.providerSessionId) {
		options.providerSessionId = parsed.providerSessionId;
	}

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	const modelMatchPreferences = {
		usageOrder: activeSettings.getStorage()?.getModelUsageOrder(),
	};
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
			preferences: modelMatchPreferences,
		});
		if (resolved.warning) {
			process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
		}
		if (resolved.error) {
			if (!parsed.provider && !parsed.model.includes(":")) {
				// Model not found in built-in registry — defer resolution to after extensions load
				// (extensions may register additional providers/models via registerProvider)
				options.modelPattern = parsed.model;
			} else {
				process.stderr.write(`${chalk.red(resolved.error)}\n`);
				process.exit(1);
			}
		} else if (resolved.model) {
			options.model = resolved.model;
			activeSettings.overrideModelRoles({
				default: resolved.selector ?? `${resolved.model.provider}/${resolved.model.id}`,
			});
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
			}
		}
	} else if (scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
		const remembered = activeSettings.getModelRole("default");
		if (remembered) {
			const rememberedSpec = resolveModelRoleValue(
				remembered,
				scopedModels.map(scopedModel => scopedModel.model),
				{
					settings: activeSettings,
					matchPreferences: modelMatchPreferences,
					modelRegistry,
				},
			);
			const rememberedResolvedModel = rememberedSpec.model;
			const rememberedModel = rememberedResolvedModel
				? scopedModels.find(
						scopedModel =>
							scopedModel.model.provider === rememberedResolvedModel.provider &&
							scopedModel.model.id === rememberedResolvedModel.id,
					)
				: scopedModels.find(scopedModel => scopedModel.model.id.toLowerCase() === remembered.toLowerCase());
			if (rememberedModel) {
				options.model = rememberedModel.model;
				// Apply explicit thinking level from remembered role value
				if (!parsed.thinking && rememberedSpec.explicitThinkingLevel && rememberedSpec.thinkingLevel) {
					options.thinkingLevel = rememberedSpec.thinkingLevel;
				}
			}
		}
		if (!options.model) options.model = scopedModels[0].model;
	}

	// Thinking level
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	} else if (
		scopedModels.length > 0 &&
		scopedModels[0].explicitThinkingLevel === true &&
		!parsed.continue &&
		!parsed.resume
	) {
		options.thinkingLevel = scopedModels[0].thinkingLevel;
	}

	// Scoped models for Ctrl+P cycling - fill in default thinking levels when not explicit
	if (scopedModels.length > 0) {
		const defaultThinkingLevel = activeSettings.get("defaultThinkingLevel");
		options.scopedModels = scopedModels.map(scopedModel => ({
			model: scopedModel.model,
			thinkingLevel: scopedModel.explicitThinkingLevel
				? (scopedModel.thinkingLevel ?? defaultThinkingLevel)
				: defaultThinkingLevel,
			explicitThinkingLevel: scopedModel.explicitThinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// System prompt
	if (resolvedSystemPrompt && resolvedAppendPrompt) {
		options.systemPrompt = defaultPrompt => [resolvedSystemPrompt, resolvedAppendPrompt, ...defaultPrompt.slice(1)];
	} else if (resolvedSystemPrompt) {
		options.systemPrompt = defaultPrompt => [resolvedSystemPrompt, ...defaultPrompt.slice(1)];
	} else if (resolvedAppendPrompt) {
		options.systemPrompt = defaultPrompt => [...defaultPrompt, resolvedAppendPrompt];
	}

	// Tools
	if (parsed.noTools) {
		options.toolNames = parsed.tools && parsed.tools.length > 0 ? parsed.tools : [];
	} else if (parsed.tools) {
		options.toolNames = parsed.tools;
	}

	if (parsed.noLsp) {
		options.enableLsp = false;
	}

	// Rules
	if (parsed.noRules) {
		options.rules = [];
	}

	options.disableExtensionDiscovery = true;
	options.additionalExtensionPaths = [];

	return { options };
}

interface RunRootCommandDependencies {
	createAgentSession?: typeof createAgentSession;
	discoverAuthStorage?: typeof discoverAuthStorage;
	runAcpMode?: typeof runAcpMode;
	settings?: Settings;
}

export async function runRootCommand(
	parsed: Args,
	rawArgs: string[],
	deps: RunRootCommandDependencies = {},
): Promise<void> {
	logger.startTiming();

	// Initialize theme early with defaults (CLI commands need symbols)
	// Will be re-initialized with user preferences later
	await logger.time("initTheme:initial", initTheme);

	const parsedArgs = parsed;
	await logger.time("maybeAutoChdir", maybeAutoChdir, parsedArgs);

	const notifs: (InteractiveModeNotify | null)[] = [];

	// Create AuthStorage and ModelRegistry upfront
	const authStorage = await logger.time("discoverModels", deps.discoverAuthStorage ?? discoverAuthStorage);
	const modelRegistry = new ModelRegistry(authStorage);

	if (parsedArgs.version) {
		process.stdout.write(`${VERSION}\n`);
		process.exit(0);
	}

	if (parsedArgs.listModels !== undefined) {
		await modelRegistry.refresh("online");
		const searchPattern = typeof parsedArgs.listModels === "string" ? parsedArgs.listModels : undefined;
		await runListModelsCommand({
			modelRegistry,
			cwd: getProjectDir(),
			additionalExtensionPaths: [],
			settingsExtensions: [],
			disabledExtensionIds: [],
			disableExtensionDiscovery: true,
			searchPattern,
		});
		process.exit(0);
	}

	if (parsedArgs.export) {
		let result: string;
		try {
			const outputPath = parsedArgs.messages.length > 0 ? parsedArgs.messages[0] : undefined;
			result = await exportFromFile(parsedArgs.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			process.stderr.write(`${chalk.red(`Error: ${message}`)}\n`);
			process.exit(1);
		}
		process.stdout.write(`Exported to: ${result}\n`);
		process.exit(0);
	}

	if ((parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui") && parsedArgs.fileArgs.length > 0) {
		process.stderr.write(`${chalk.red("Error: @file arguments are not supported in RPC mode")}\n`);
		process.exit(1);
	}

	const cwd = getProjectDir();
	const settingsInstance = deps.settings ?? (await logger.time("settings:init", Settings.init, { cwd }));
	if (parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui" || parsedArgs.mode === "acp") {
		applyRpcDefaultSettingOverrides(settingsInstance);
	}
	modelRegistry.applyConfiguredModelBindings(settingsInstance);
	if (parsedArgs.noPty || parsedArgs.mode === "rpc-ui") {
		Bun.env.PI_NO_PTY = "1";
	}
	if (parsedArgs.noTitle || parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui" || parsedArgs.mode === "acp") {
		Bun.env.PI_NO_TITLE = "1";
	}
	const { pipedInput, fileText, fileImages } = await logger.time("prepareInitialMessage", async () => {
		const pipedInput = await readPipedInput();
		if (parsedArgs.fileArgs.length === 0) {
			return { pipedInput, fileText: undefined, fileImages: undefined };
		}
		const processed = await processFileArguments(parsedArgs.fileArgs, {
			autoResizeImages: settingsInstance.get("images.autoResize"),
		});
		return { pipedInput, fileText: processed.text, fileImages: processed.images };
	});
	const { initialMessage, initialImages } = buildInitialMessage({
		parsed: parsedArgs,
		fileText,
		fileImages,
		stdinContent: pipedInput,
	});
	const autoPrint = pipedInput !== undefined && !parsedArgs.print && parsedArgs.mode === undefined;
	const isInteractive = !parsedArgs.print && !autoPrint && parsedArgs.mode === undefined;
	const mode = parsedArgs.mode || "text";

	// Initialize discovery system with settings for provider persistence
	logger.time("initializeWithSettings", initializeWithSettings, settingsInstance);

	// Apply model role overrides from CLI args or env vars (ephemeral, not persisted)
	const smolModel = parsedArgs.smol ?? $env.PI_SMOL_MODEL;
	const slowModel = parsedArgs.slow ?? $env.PI_SLOW_MODEL;
	const planModel = parsedArgs.plan ?? $env.PI_PLAN_MODEL;
	if (smolModel || slowModel || planModel) {
		settingsInstance.overrideModelRoles({
			smol: smolModel,
			slow: slowModel,
			plan: planModel,
		});
	}

	await logger.time(
		"initTheme:final",
		initTheme,
		isInteractive,
		settingsInstance.get("symbolPreset"),
		settingsInstance.get("colorBlindMode"),
		settingsInstance.get("theme.dark"),
		settingsInstance.get("theme.light"),
	);

	let scopedModels: ScopedModel[] = [];
	const modelPatterns = parsedArgs.models ?? settingsInstance.get("enabledModels");
	const modelMatchPreferences = {
		usageOrder: settingsInstance.getStorage()?.getModelUsageOrder(),
	};
	if (modelPatterns && modelPatterns.length > 0) {
		scopedModels = await logger.time(
			"resolveModelScope",
			resolveModelScope,
			modelPatterns,
			modelRegistry,
			modelMatchPreferences,
		);
	}

	// Create session manager based on CLI flags
	let sessionManager = await logger.time(
		"createSessionManager",
		createSessionManager,
		parsedArgs,
		cwd,
		settingsInstance,
	);

	// Handle --resume (no value): show session picker
	if (parsedArgs.resume === true && !parsedArgs.fork) {
		const sessions = await logger.time("SessionManager.list", SessionManager.list, cwd, parsedArgs.sessionDir);
		if (sessions.length === 0) {
			process.stdout.write(`${chalk.dim("No sessions found")}\n`);
			return;
		}
		const selectedPath = await logger.time("selectSession", selectSession, sessions);
		if (!selectedPath) {
			process.stdout.write(`${chalk.dim("No session selected")}\n`);
			return;
		}
		sessionManager = await SessionManager.open(selectedPath);
	}

	const { options: sessionOptions } = await logger.time(
		"buildSessionOptions",
		buildSessionOptions,
		parsedArgs,
		scopedModels,
		sessionManager,
		modelRegistry,
		settingsInstance,
	);
	sessionOptions.authStorage = authStorage;
	sessionOptions.modelRegistry = modelRegistry;
	sessionOptions.hasUI = isInteractive || mode === "rpc-ui";
	sessionOptions.settings = settingsInstance;

	// Handle CLI --api-key as runtime override (not persisted)
	if (parsedArgs.apiKey) {
		if (!sessionOptions.model && !sessionOptions.modelPattern) {
			process.stderr.write(
				`${chalk.red("--api-key requires a model to be specified via --model, --provider/--model, or --models")}\n`,
			);
			process.exit(1);
		}
		if (sessionOptions.model) {
			authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsedArgs.apiKey);
		}
	}

	const createAgentSessionImpl = deps.createAgentSession ?? createAgentSession;
	const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		const result = await logger.time("createAgentSession", createAgentSessionImpl, options);
		// Kick off background model discovery only after createAgentSession finishes its parallel
		// discovery arms; running these concurrently contends for the event loop and stretches
		// every parallel arm by ~30ms.
		modelRegistry.refreshInBackground();
		return result;
	};

	if (mode === "acp") {
		const createAcpSession = createAcpSessionFactory({
			baseOptions: sessionOptions,
			settings: settingsInstance,
			sessionDir: parsedArgs.sessionDir,
			authStorage,
			modelRegistry,
			parsedArgs,
			rawArgs,
			createSession,
		});
		await (deps.runAcpMode ?? runAcpMode)(createAcpSession);
	} else {
		const { session, setToolUIContext, modelFallbackMessage, lspServers, mcpManager, eventBus } =
			await createSession(sessionOptions);
		if (parsedArgs.apiKey && !sessionOptions.model && session.model) {
			authStorage.setRuntimeApiKey(session.model.provider, parsedArgs.apiKey);
		}

		if (modelFallbackMessage) {
			notifs.push({ kind: "warn", message: modelFallbackMessage });
		}

		const modelRegistryError = modelRegistry.getError();
		if (modelRegistryError) {
			notifs.push({ kind: "error", message: modelRegistryError.message });
		}

		if (isInteractive && !session.model && !modelFallbackMessage) {
			notifs.push({
				kind: "info",
				message: `No usable model is configured yet. ${formatModelOnboardingGuidance()}`,
			});
		}

		applyExtensionFlagValues(session, rawArgs);

		if (!isInteractive && !session.model) {
			process.stderr.write(
				`${chalk.red(modelFallbackMessage ?? `No models available. ${formatModelOnboardingGuidance()}`)}\n`,
			);
			process.stderr.write(
				`${chalk.yellow(`\nAdvanced manual config remains available at ${ModelsConfigFile.path()}`)}\n`,
			);
			process.exit(1);
		}

		if (mode === "rpc" || mode === "rpc-ui") {
			await runRpcMode(session, mode === "rpc-ui" ? setToolUIContext : undefined);
		} else if (isInteractive) {
			const versionCheckPromise = checkForNewVersion(VERSION).catch(() => undefined);
			const changelogMarkdown = await logger.time("main:getChangelogForDisplay", getChangelogForDisplay, parsedArgs);

			const scopedModelsForDisplay = sessionOptions.scopedModels ?? scopedModels;
			if (scopedModelsForDisplay.length > 0) {
				const modelList = scopedModelsForDisplay
					.map(scopedModel => {
						const thinkingStr = !scopedModel.thinkingLevel ? `:${scopedModel.thinkingLevel}` : "";
						return `${scopedModel.model.id}${thinkingStr}`;
					})
					.join(", ");
				process.stdout.write(`${chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`)}\n`);
			}

			if ($env.PI_TIMING) {
				logger.printTimings();
				if ($env.PI_TIMING === "x") {
					process.exit(0);
				}
			}

			logger.endTiming();
			await runInteractiveMode(
				session,
				VERSION,
				changelogMarkdown,
				notifs,
				versionCheckPromise,
				parsedArgs.messages,
				setToolUIContext,
				lspServers,
				mcpManager,
				eventBus,
				initialMessage,
				initialImages,
			);
		} else {
			await runPrintMode(session, {
				mode,
				messages: parsedArgs.messages,
				initialMessage,
				initialImages,
			});
			if ($env.PI_TIMING) {
				logger.printTimings();
			}
			await session.dispose();
			stopThemeWatcher();
			await postmortem.quit(0);
		}
	}
}

export async function main(args: string[]): Promise<void> {
	const { runCli } = await import("./cli");
	await runCli(args.length === 0 ? ["launch"] : args);
}
