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
import { resolveLaunchDisposition } from "./cli/launch-disposition";
import { runListModelsCommand } from "./cli/list-models";
import { selectSession } from "./cli/session-picker";
import { findConfigFile } from "./config";
import { activateModelProfile, ModelProfileCredentialError } from "./config/model-profile-activation";
import { ModelRegistry, ModelsConfigFile } from "./config/model-registry";
import { resolveCliModel, resolveModelRoleValue, resolveModelScope, type ScopedModel } from "./config/model-resolver";
import { selectorHead } from "./config/model-selector-value";
import { getDefault, type SettingPath, Settings, settings } from "./config/settings";
import { BUNDLED_GROK_BUILD_EXTENSION_ID, getBundledGrokBuildExtensionFactory } from "./defaults/gjc-grok-cli";
import { initializeWithSettings } from "./discovery";
import { exportFromFile } from "./export/html";
import type { ExtensionUIContext } from "./extensibility/extensions/types";
import { admitManagedOwnerBeforeCli, completeManagedOwnerRecovery } from "./gjc-runtime/managed-owner-admission";
import { isManagedOwnerSupervisorArgv, runManagedOwnerSupervisor } from "./gjc-runtime/managed-owner-supervisor";
import { persistCoordinatorRuntimeInputReady } from "./gjc-runtime/session-state-sidecar";
import { isTmuxOwnerIsolationCliArgv, runTmuxOwnerIsolationCliFromStdin } from "./gjc-runtime/tmux-owner-isolation-cli";
import type { AcpStartupOptions } from "./modes/acp/startup-options";
import type { SessionSelectionResult } from "./modes/components/session-selector";
import type { InteractiveMode } from "./modes/interactive-mode";
import type { PrintModeOptions } from "./modes/print-mode";
import { initTheme, stopThemeWatcher } from "./modes/theme/theme";
import type { SubmittedUserInput } from "./modes/types";
import { applyCliRuntimeApiKeyOverride } from "./runtime-api-key";
import { parseCliCredentialSelector } from "./runtime-credential-selector";
import type { MCPManager } from "./runtime-mcp";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
} from "./sdk";
import type { AgentSession } from "./session/agent-session";

import {
	type ResumeSessionIdentity,
	resolveResumableSession,
	type SessionDestination,
	type SessionDirectoryMigrationPolicy,
	type SessionInfo,
	SessionManager,
	type StrictSessionOpenResult,
} from "./session/session-manager";
import { runStartupCredentialAutoImportIfNeeded } from "./setup/credential-auto-import";
import { formatModelOnboardingGuidance } from "./setup/model-onboarding-guidance";
import { executeBuiltinSlashCommand } from "./slash-commands/builtin-registry";
import { resolvePromptInput } from "./system-prompt";
import { persistTaskTokenLog, resolveTaskTokenLogDir, taskTokenLogFromUsage } from "./task/token-log";
import type { LspStartupServerInfo } from "./tools";
import { getDisplayChangelogEntries, getInstalledVersionChangelogEntry, getNewEntries } from "./utils/changelog";
import type { EventBus } from "./utils/event-bus";

async function checkForNewVersion(currentVersion: string): Promise<string | undefined> {
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

export type StartupUpdateRoute = "interactive" | "print" | "text" | "json" | "acp";

export function classifyStartupUpdateRoute(
	parsed: Pick<Args, "print" | "mode">,
	autoPrint: boolean,
): StartupUpdateRoute {
	if (!parsed.print && !autoPrint && parsed.mode === undefined) return "interactive";
	if (parsed.print) return "print";
	return parsed.mode === "acp" ? "acp" : "text";
}

/** Coordinates the non-blocking update check around the interactive UI lifecycle. */
export class StartupUpdateOrchestrator {
	#versionCheckPromise: Promise<string | undefined> | undefined;
	readonly #route: StartupUpdateRoute;
	readonly #enabled: () => boolean;
	readonly #check: () => Promise<string | undefined>;

	constructor(route: StartupUpdateRoute, enabled: () => boolean, check: () => Promise<string | undefined>) {
		this.#route = route;
		this.#enabled = enabled;
		this.#check = check;
	}

	startBeforeInteractiveInitialization(): void {
		if (this.#route !== "interactive" || !this.#enabled() || this.#versionCheckPromise) return;
		try {
			this.#versionCheckPromise = this.#check().catch(() => undefined);
		} catch {
			this.#versionCheckPromise = Promise.resolve(undefined);
		}
	}

	attachAfterInteractiveInitialization(notify: (version: string) => void): void {
		this.#versionCheckPromise
			?.then(version => {
				if (version && this.#enabled()) notify(version);
			})
			.catch(() => {});
	}
}

export interface StartupUpdateInteractiveMode {
	init: () => Promise<void>;
	showNewVersionNotification: (version: string) => void;
}

export async function initializeInteractiveModeWithStartupUpdate(
	mode: StartupUpdateInteractiveMode,
	startupUpdate: StartupUpdateOrchestrator,
): Promise<void> {
	await mode.init();
	startupUpdate.attachAfterInteractiveInitialization(version => mode.showNewVersionNotification(version));
}

const ACP_DEFAULTED_SETTING_PATHS: SettingPath[] = [
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
	// Memory subsystems are off-by-default for embedded (ACP) hosts; embedders
	// that want memory should opt in explicitly through their own settings layer.
	"memory.backend",
	"memories.enabled",
];

function applyAcpDefaultSettingOverrides(targetSettings: Settings = settings): void {
	for (const settingPath of ACP_DEFAULTED_SETTING_PATHS) {
		targetSettings.override(settingPath, getDefault(settingPath));
	}
}

/**
 * Translate only ACP startup settings with a canonical SDK control carrier.
 * Every other local-session flag is rejected so the broker-backed ACP host
 * never appears to accept options it cannot apply to its remote session.
 */
export function resolveAcpStartupOptions(
	parsed: Pick<
		Args,
		| "allowHome"
		| "apiKey"
		| "appendSystemPrompt"
		| "credential"
		| "continue"
		| "default"
		| "cwd"
		| "fileArgs"
		| "fork"
		| "hooks"
		| "messages"
		| "mpreset"
		| "mcpConfig"
		| "model"
		| "models"
		| "noLsp"
		| "noPty"
		| "noRules"
		| "noSession"
		| "noSkills"
		| "noTitle"
		| "noTools"
		| "pluginDirs"
		| "print"
		| "provider"
		| "providerSessionId"
		| "resume"
		| "sessionDir"
		| "skills"
		| "slow"
		| "smol"
		| "plan"
		| "systemPrompt"
		| "thinking"
		| "tmux"
		| "tools"
		| "extensions"
		| "unknownFlags"
	>,
	sessionOptions: Pick<CreateAgentSessionOptions, "model" | "modelPattern" | "thinkingLevel">,
): AcpStartupOptions {
	const unsupported = [
		...(parsed.allowHome ? ["--allow-home"] : []),
		...(parsed.default ? ["--default"] : []),
		...(parsed.apiKey ? ["--api-key"] : []),
		...(parsed.appendSystemPrompt ? ["--append-system-prompt"] : []),
		...(parsed.credential ? ["--credential"] : []),
		...(parsed.continue ? ["--continue"] : []),
		...(parsed.cwd ? ["--cwd"] : []),
		...(parsed.fileArgs.length > 0 ? ["@file"] : []),
		...(parsed.fork ? ["--fork"] : []),
		...(parsed.hooks?.length ? ["--hook"] : []),
		...(parsed.messages.length > 0 ? ["initial prompt"] : []),
		...(parsed.models?.length ? ["--models"] : []),
		...(parsed.mcpConfig !== undefined ? ["--mcp-config"] : []),
		...(parsed.noLsp ? ["--no-lsp"] : []),
		...(parsed.noPty ? ["--no-pty"] : []),
		...(parsed.noRules ? ["--no-rules"] : []),
		...(parsed.noSession ? ["--no-session"] : []),
		...(parsed.noSkills ? ["--no-skills"] : []),
		...(parsed.noTitle ? ["--no-title"] : []),
		...(parsed.noTools ? ["--no-tools"] : []),
		...(parsed.pluginDirs?.length ? ["--plugin-dir"] : []),
		...(parsed.print ? ["--print"] : []),
		...(parsed.provider && !parsed.model ? ["--provider"] : []),
		...(parsed.providerSessionId ? ["--provider-session-id"] : []),
		...(parsed.resume ? ["--resume"] : []),
		...(parsed.sessionDir ? ["--session-dir"] : []),
		...(parsed.skills?.length ? ["--skills"] : []),
		...(parsed.slow ? ["--slow"] : []),
		...(parsed.smol ? ["--smol"] : []),
		...(parsed.plan ? ["--plan"] : []),
		...(parsed.systemPrompt ? ["--system-prompt"] : []),
		...(parsed.tmux ? ["--tmux"] : []),
		...(parsed.tools?.length ? ["--tools"] : []),
		...(parsed.extensions?.length ? ["--extension"] : []),
		...(parsed.unknownFlags.size > 0 ? ["extension flags"] : []),
	];
	if (unsupported.length > 0) {
		throw new Error(
			`Unsupported under SDK-backed ACP: ${unsupported.join(", ")}. Use ACP session configuration or SDK controls after session creation.`,
		);
	}
	if (parsed.model && (!sessionOptions.model || sessionOptions.modelPattern)) {
		throw new Error(
			"Unsupported under SDK-backed ACP: --model could not be resolved to a canonical model ID. Use session/set_config_option after session creation.",
		);
	}
	return {
		...(parsed.mpreset ? { modelPreset: parsed.mpreset } : {}),
		...(parsed.model && sessionOptions.model
			? { modelId: `${sessionOptions.model.provider}/${sessionOptions.model.id}` }
			: {}),
		...((parsed.model || parsed.thinking) && sessionOptions.thinkingLevel
			? { thinkingLevel: sessionOptions.thinkingLevel }
			: {}),
	};
}

async function readPipedInput(): Promise<string | undefined> {
	if (process.stdin.isTTY === true) return undefined;
	try {
		const text = await Bun.stdin.text();
		if (text.trim().length === 0) return undefined;
		return text;
	} catch {
		return undefined;
	}
}

async function readPipedInputIfReady(): Promise<string | undefined> {
	if (process.stdin.isTTY === true) return undefined;

	const ready = Promise.withResolvers<void>();
	const onReadable = () => ready.resolve();
	const onEnd = () => ready.resolve();
	const onError = () => ready.resolve();
	process.stdin.once("readable", onReadable);
	process.stdin.once("end", onEnd);
	process.stdin.once("error", onError);
	await Promise.race([ready.promise, new Promise<void>(resolve => setImmediate(resolve))]);
	process.stdin.removeListener("readable", onReadable);
	process.stdin.removeListener("end", onEnd);
	process.stdin.removeListener("error", onError);

	const chunks: Buffer[] = [];
	for (let chunk = process.stdin.read(); chunk !== null; chunk = process.stdin.read()) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	if (chunks.length === 0) return undefined;
	const text = Buffer.concat(chunks).toString("utf8");
	return text.trim() ? text : undefined;
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

type CreateSessionForMain = (
	options: CreateAgentSessionOptions,
	context?: { skipPostCreateModelRefresh?: boolean },
) => Promise<CreateAgentSessionResult>;

type StartupModelProfileArgs = {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	parsedArgs: Pick<Args, "default" | "model" | "mpreset" | "thinking">;
	startupModel?: CreateAgentSessionOptions["model"];
	startupThinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
};

async function applyStartupModelProfilesWithPolicy(
	args: StartupModelProfileArgs,
	onCredentialError?: (error: ModelProfileCredentialError) => void,
): Promise<void> {
	const applyProfile = async (
		profileName: string,
		persistDefault: boolean,
		options: { thinkingLevelOverride?: CreateAgentSessionOptions["thinkingLevel"] } = {},
	): Promise<void> => {
		try {
			await activateModelProfile(
				{ session: args.session, modelRegistry: args.modelRegistry, settings: args.settings, profileName },
				{ persistDefault, thinkingLevelOverride: options.thinkingLevelOverride },
			);
		} catch (error) {
			if (onCredentialError && error instanceof ModelProfileCredentialError) {
				onCredentialError(error);
				return;
			}
			throw error;
		}
	};

	// Capture the explicitly-selected startup model BEFORE profile activation can
	// override it. startupModel covers the eager path; session.model covers the
	// deferred `--model <pattern>` path resolved inside createAgentSession.
	const explicitModel = args.parsedArgs.model ? (args.startupModel ?? args.session.model) : undefined;
	const defaultProfile = args.settings.get("modelProfile.default");
	if (defaultProfile || args.parsedArgs.mpreset) {
		await args.modelRegistry.refresh("online-if-uncached");
	}

	if (defaultProfile) {
		await applyProfile(defaultProfile, false, {
			thinkingLevelOverride: args.settings.has("defaultThinkingLevel")
				? args.settings.get("defaultThinkingLevel")
				: undefined,
		});
	}
	if (args.parsedArgs.mpreset) {
		await applyProfile(args.parsedArgs.mpreset, args.parsedArgs.default === true);
	}

	// Explicit CLI --model/--thinking must win over any activated or skipped profile.
	if (explicitModel) {
		await args.session.setModelTemporary(explicitModel, args.startupThinkingLevel ?? args.parsedArgs.thinking, {
			persistAsSessionDefault: true,
			cause: "startup-override",
		});
		const selector = `${explicitModel.provider}/${explicitModel.id}`;
		args.session.setConfiguredModelChain("default", [selector], "startup-override", undefined, true);
		args.session.seedDefaultFallbackResolution(0, []);
	} else if (args.parsedArgs.thinking && args.session.model) {
		await args.session.setModelTemporary(args.session.model, args.parsedArgs.thinking, { cause: "startup-override" });
	}
}

export async function applyStartupModelProfiles(args: StartupModelProfileArgs): Promise<void> {
	await applyStartupModelProfilesWithPolicy(args);
}

async function exitForStartupModelProfileError(args: StartupModelProfileArgs, error: unknown): Promise<never> {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${chalk.red(`Error: ${message}`)}\n`);
	await args.session.dispose();
	process.exit(1);
}

export async function applyStartupModelProfilesOrExit(args: StartupModelProfileArgs): Promise<void> {
	try {
		await applyStartupModelProfiles(args);
	} catch (error) {
		await exitForStartupModelProfileError(args, error);
	}
}

export function isStartupModelProfileCredentialRecoveryEligible(options: {
	isInteractive: boolean;
	hasInteractiveTerminal: boolean;
	initialMessage: string | undefined;
	initialMessages: readonly string[];
	resumeAction: "continue-tail" | "open-idle" | undefined;
}): boolean {
	return (
		options.isInteractive &&
		options.hasInteractiveTerminal &&
		options.initialMessage === undefined &&
		options.initialMessages.length === 0 &&
		options.resumeAction !== "continue-tail"
	);
}

export async function applyStartupModelProfilesForRoot(
	args: StartupModelProfileArgs & {
		isInteractive: boolean;
		hasInteractiveTerminal: boolean;
		initialMessage: string | undefined;
		initialMessages: readonly string[];
		resumeAction: "continue-tail" | "open-idle" | undefined;
	},
): Promise<{ recoverableErrors: string[] }> {
	if (!isStartupModelProfileCredentialRecoveryEligible(args)) {
		await applyStartupModelProfilesOrExit(args);
		return { recoverableErrors: [] };
	}

	const recoverableErrors: string[] = [];
	try {
		await applyStartupModelProfilesWithPolicy(args, error => recoverableErrors.push(error.message));
	} catch (error) {
		await exitForStartupModelProfileError(args, error);
	}
	return { recoverableErrors };
}

interface InteractiveModeFactoryOptions {
	session: AgentSession;
	version: string;
	changelogMarkdown: string | undefined;
	setExtensionUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	lspServers: LspStartupServerInfo[] | undefined;
	mcpManager: MCPManager | undefined;
	eventBus?: EventBus;
}

type CreateInteractiveMode = (options: InteractiveModeFactoryOptions) => InteractiveMode;

type ResumePickerTerminalCheck = () => boolean;
type ListForResumePickerReadOnly = (cwd: string, sessionDir?: string) => Promise<SessionInfo[]>;
type SelectResumeSession = (sessions: SessionInfo[]) => Promise<SessionSelectionResult>;
type OpenExistingSessionStrict = (
	identity: ResumeSessionIdentity,
	destination: SessionDestination,
	storage?: undefined,
	migrationPolicy?: SessionDirectoryMigrationPolicy,
) => Promise<StrictSessionOpenResult>;

export const BARE_RESUME_CONFLICT_ERROR =
	"--resume without a session cannot be combined with --continue, --fork, or --no-session.";
export const BARE_RESUME_INTERACTIVE_ERROR = "--resume requires an interactive terminal; use --resume <id>.";
export const BARE_RESUME_OPEN_ERROR = "Could not open the selected session. Use --resume <id>.";

function isBareResume(parsed: Args): boolean {
	return (
		parsed.resume === true &&
		parsed.version !== true &&
		parsed.listModels === undefined &&
		parsed.export === undefined
	);
}

function hasBareResumeConflict(parsed: Args): boolean {
	return parsed.continue === true || parsed.fork !== undefined || parsed.noSession === true;
}

function isNormalLocalInteractiveRoute(parsed: Args): boolean {
	return parsed.mode === undefined && parsed.print !== true;
}

function hasResumePickerTerminal(): boolean {
	return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function runInteractiveMode(
	session: AgentSession,
	version: string,
	changelogMarkdown: string | undefined,
	notifs: (InteractiveModeNotify | null)[],
	startupUpdate: StartupUpdateOrchestrator,
	initialMessages: string[],
	setExtensionUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	lspServers: LspStartupServerInfo[] | undefined,
	mcpManager: MCPManager | undefined,
	eventBus?: EventBus,
	initialMessage?: string,
	initialImages?: ImageContent[],
	createInteractiveMode?: CreateInteractiveMode,
	resumeAction?: "continue-tail" | "open-idle",
): Promise<void> {
	const mode = createInteractiveMode
		? createInteractiveMode({
				session,
				version,
				changelogMarkdown,
				setExtensionUIContext,
				lspServers,
				mcpManager,
				eventBus,
			})
		: new (await import("./modes/interactive-mode")).InteractiveMode(
				session,
				version,
				changelogMarkdown,
				setExtensionUIContext,
				lspServers,
				mcpManager,
				eventBus,
			);

	await initializeInteractiveModeWithStartupUpdate(mode, startupUpdate);
	try {
		await persistCoordinatorRuntimeInputReady();
	} catch (error) {
		logger.warn("Failed to persist coordinator runtime input readiness", { error: String(error) });
		throw error;
	}

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

	const hasStartupInput = initialMessage !== undefined || initialMessages.length > 0;
	if (!hasStartupInput && resumeAction === "continue-tail") {
		try {
			await session.continuePersistedHistory();
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
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

	const entries = getDisplayChangelogEntries();
	if (entries.length === 0) {
		return undefined;
	}

	const lastVersion = settings.get("lastChangelogVersion");
	if (!lastVersion) {
		settings.set("lastChangelogVersion", VERSION);
		await flushChangelogVersion();
		return getInstalledVersionChangelogEntry(entries, VERSION)?.content;
	}

	if (lastVersion !== VERSION) {
		const newEntries = getNewEntries(entries, lastVersion);
		settings.set("lastChangelogVersion", VERSION);
		await flushChangelogVersion();
		if (newEntries.length > 0) {
			return newEntries.map(e => e.content).join("\n\n");
		}
	}

	return getInstalledVersionChangelogEntry(entries, VERSION)?.content;
}

async function flushChangelogVersion(): Promise<void> {
	try {
		await settings.flush();
	} catch (error: unknown) {
		logger.warn("Failed to persist lastChangelogVersion", { error });
	}
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	activeSettings: Settings = settings,
): Promise<SessionManager | undefined> {
	const migrationPolicy = activeSettings.get("session.directoryMigration") === "disabled" ? "disabled" : "copy-retain";
	const sessionDestination = () =>
		parsed.sessionDir
			? SessionManager.explicitDestination(parsed.sessionDir)
			: SessionManager.managedDestination(cwd, activeSettings.getAgentDir());
	if (parsed.resume === true) {
		return undefined;
	}
	if (parsed.fork) {
		if (parsed.noSession) {
			throw new Error("--fork requires session persistence");
		}
		const forkSource = parsed.fork;
		if (forkSource.includes("/") || forkSource.includes("\\") || forkSource.endsWith(".jsonl")) {
			return await SessionManager.forkFrom(forkSource, cwd, sessionDestination(), undefined, migrationPolicy);
		}
		const match = await resolveResumableSession(forkSource, cwd, parsed.sessionDir);
		if (!match) {
			throw new Error(`Session "${forkSource}" not found.`);
		}
		return await SessionManager.forkFrom(match.session.path, cwd, sessionDestination(), undefined, migrationPolicy);
	}

	if (parsed.noSession) {
		return SessionManager.inMemory();
	}
	if (typeof parsed.resume === "string") {
		const sessionArg = parsed.resume;
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			return await SessionManager.open(
				sessionArg,
				SessionManager.explicitDestination(path.dirname(sessionArg)),
				undefined,
				migrationPolicy,
			);
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
				return await SessionManager.forkFrom(
					match.session.path,
					cwd,
					sessionDestination(),
					undefined,
					migrationPolicy,
				);
			}
		}
		return await SessionManager.open(match.session.path, sessionDestination(), undefined, migrationPolicy);
	}
	if (parsed.continue) {
		return await SessionManager.continueRecent(cwd, sessionDestination(), undefined, migrationPolicy);
	}
	// --resume without value is handled separately (needs picker UI)
	// If --session-dir provided without --continue/--resume, create new session there
	if (parsed.sessionDir) {
		return SessionManager.create(cwd, SessionManager.explicitDestination(parsed.sessionDir));
	}
	// A lifecycle `/session_create` child must start a FRESH session that adopts
	// the pre-allocated id (GJC_SESSION_ID), never auto-resume existing history in
	// the target cwd — otherwise the daemon/tmux id and the session header id
	// diverge and close/resume-by-create-id break. Resume children are launched
	// with `--resume <id>` (handled above) and carry no GJC_LIFECYCLE_REQUEST_ID.
	if (
		process.env.GJC_LIFECYCLE_REQUEST_ID &&
		/^[A-Za-z0-9._-]{1,128}$/.test(process.env.GJC_SESSION_ID?.trim() ?? "")
	) {
		return undefined;
	}
	// Auto-resume: behave like --continue if the setting is enabled and a prior
	// session exists. When a prior session is resumed, mark parsed.continue so
	// buildSessionOptions restores the session's model/thinking instead of
	// overriding them with CLI defaults.
	if (activeSettings.get("autoResume")) {
		const manager = await SessionManager.continueRecent(cwd, sessionDestination(), undefined, migrationPolicy);
		if (manager.getEntries().length > 0) {
			parsed.continue = true;
		}
		return manager;
	}
	return SessionManager.create(cwd, SessionManager.managedDestination(cwd, activeSettings.getAgentDir()));
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
	if (parsed.mcpConfig !== undefined) options.mcpConfigPath = parsed.mcpConfig;

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
				: scopedModels.find(
						scopedModel => scopedModel.model.id.toLowerCase() === selectorHead(remembered)?.toLowerCase(),
					);
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

	// Scoped models for Alt+N cycling - fill in default thinking levels when not explicit
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

/**
 * Research-mode (RLM) preset hook. Lets `gjc rlm` augment the session options
 * (system prompt, restricted toolset, custom python tool) and assert the tool
 * boundary once the session's tool registry is fully assembled.
 */
export interface RlmPreset {
	applyOptions: (options: CreateAgentSessionOptions, settings: Settings) => void;
	onSessionCreated?: (session: AgentSession) => void | Promise<void>;
}

type RunPrintMode = (session: AgentSession, options: PrintModeOptions) => Promise<void>;

export interface RunRootCommandDependencies {
	createAgentSession?: typeof createAgentSession;
	discoverAuthStorage?: typeof discoverAuthStorage;
	runAcpMode?: (options?: { agentDir?: string }) => Promise<void>;
	settings?: Settings;
	rlmPreset?: RlmPreset;
	suppressProcessExit?: boolean;
	startupUpdate?: { check: () => Promise<string | undefined> };
	initTheme?: typeof initTheme;
	readPipedInput?: typeof readPipedInput;
	stdinIsTTY?: boolean;
	runStartupCredentialAutoImportIfNeeded?: typeof runStartupCredentialAutoImportIfNeeded;
	getChangelogForDisplay?: typeof getChangelogForDisplay;
	createInteractiveMode?: CreateInteractiveMode;
	runPrintMode?: RunPrintMode;
	isResumePickerTerminal?: ResumePickerTerminalCheck;
	listForResumePickerReadOnly?: ListForResumePickerReadOnly;
	selectResumeSession?: SelectResumeSession;
	openExistingSessionStrict?: OpenExistingSessionStrict;
	initializeSettings?: typeof Settings.init;
	loadSettingsForScope?: typeof Settings.loadForScope;
}

export async function runRootCommand(
	parsed: Args,
	rawArgs: string[],
	deps: RunRootCommandDependencies = {},
): Promise<void> {
	const parsedArgs = parsed;
	let initialThemeInitialized = false;
	let autoChdirApplied = false;
	let bareResumeSessionManager: SessionManager | undefined;
	let bareResumeAction: "continue-tail" | "open-idle" | undefined;

	if (isBareResume(parsedArgs)) {
		if (hasBareResumeConflict(parsedArgs)) {
			process.stderr.write(`${BARE_RESUME_CONFLICT_ERROR}\n`);
			if (!deps.suppressProcessExit) process.exitCode = 1;
			return;
		}
		if (!isNormalLocalInteractiveRoute(parsedArgs) || !(deps.isResumePickerTerminal ?? hasResumePickerTerminal)()) {
			process.stderr.write(`${BARE_RESUME_INTERACTIVE_ERROR}\n`);
			if (!deps.suppressProcessExit) process.exitCode = 1;
			return;
		}

		logger.startTiming();
		await logger.time("initTheme:initial", deps.initTheme ?? initTheme);
		initialThemeInitialized = true;

		await logger.time("maybeAutoChdir", maybeAutoChdir, parsedArgs);
		autoChdirApplied = true;
		const resumeCwd = getProjectDir();
		const sessions = await (deps.listForResumePickerReadOnly ?? SessionManager.listForResumePickerReadOnly)(
			resumeCwd,
			parsedArgs.sessionDir,
		);
		if (sessions.length === 0) {
			process.stdout.write(`${chalk.dim("No sessions found")}\n`);
			return;
		}
		const selection = deps.selectResumeSession
			? await deps.selectResumeSession(sessions)
			: await selectSession(sessions, parsedArgs.sessionDir);
		if (selection.kind === "cancelled") {
			return;
		}
		const resumeMigrationPolicy =
			(await (deps.loadSettingsForScope ?? Settings.loadForScope)({ cwd: resumeCwd })).get(
				"session.directoryMigration",
			) === "disabled"
				? "disabled"
				: "copy-retain";
		let opened: StrictSessionOpenResult;
		try {
			opened = await (deps.openExistingSessionStrict ?? SessionManager.openExistingStrict)(
				selection.identity,
				parsedArgs.sessionDir
					? SessionManager.explicitDestination(parsedArgs.sessionDir)
					: SessionManager.managedDestination(resumeCwd, settings.getAgentDir()),
				undefined,
				resumeMigrationPolicy,
			);
		} catch {
			process.stderr.write(`${BARE_RESUME_OPEN_ERROR}\n`);
			if (!deps.suppressProcessExit) process.exitCode = 1;
			return;
		}
		if (opened.kind === "error") {
			process.stderr.write(`${BARE_RESUME_OPEN_ERROR}\n`);
			if (!deps.suppressProcessExit) process.exitCode = 1;
			return;
		}
		bareResumeSessionManager = opened.manager;
		bareResumeAction = selection.action;
	}

	if (!initialThemeInitialized) {
		logger.startTiming();
		// Initialize theme early with defaults (CLI commands need symbols).
		// It is re-initialized with user preferences later.
		await logger.time("initTheme:initial", deps.initTheme ?? initTheme);
	}

	if (!autoChdirApplied) {
		await logger.time("maybeAutoChdir", maybeAutoChdir, parsedArgs);
	}

	const notifs: (InteractiveModeNotify | null)[] = [];

	// Create AuthStorage and ModelRegistry upfront
	const authStorage = await logger.time("discoverModels", deps.discoverAuthStorage ?? discoverAuthStorage);
	const modelRegistry = new ModelRegistry(authStorage);

	if (parsedArgs.version) {
		process.stdout.write(`${VERSION}\n`);
		process.exit(0);
	}

	if (parsedArgs.listModels !== undefined) {
		await modelRegistry.refresh("online-if-uncached");
		const searchPattern = typeof parsedArgs.listModels === "string" ? parsedArgs.listModels : undefined;
		await runListModelsCommand({
			modelRegistry,
			cwd: getProjectDir(),
			extensionFactories: [
				{ factory: getBundledGrokBuildExtensionFactory(), name: BUNDLED_GROK_BUILD_EXTENSION_ID },
			],
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

	const cwd = getProjectDir();
	const settingsInstance =
		deps.settings ?? (await logger.time("settings:init", deps.initializeSettings ?? Settings.init, { cwd }));
	if (parsedArgs.mode === "acp") {
		applyAcpDefaultSettingOverrides(settingsInstance);
	}
	modelRegistry.applyConfiguredModelBindings(settingsInstance);
	if (parsedArgs.noPty) {
		Bun.env.PI_NO_PTY = "1";
	}
	if (parsedArgs.noTitle || parsedArgs.mode === "acp") {
		Bun.env.PI_NO_TITLE = "1";
	}
	const hasPreparedInput = parsedArgs.messages.length > 0 || parsedArgs.fileArgs.length > 0;
	const { pipedInput, fileText, fileImages } = await logger.time("prepareInitialMessage", async () => {
		const pipedInput =
			parsedArgs.mode === "acp"
				? undefined
				: deps.readPipedInput
					? await deps.readPipedInput()
					: hasPreparedInput
						? await readPipedInputIfReady()
						: await readPipedInput();
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
	const disposition = resolveLaunchDisposition({
		stdinIsTTY: deps.stdinIsTTY ?? process.stdin.isTTY,
		pipedInput,
		hasPreparedInput,
		print: Boolean(parsedArgs.print),
		mode: parsedArgs.mode,
	});
	if (disposition.nonInteractiveError) {
		process.stderr.write(`${chalk.red(disposition.nonInteractiveError)}\n`);
		process.exit(1);
	}
	const autoPrint = disposition.autoPrint;
	const startupUpdateRoute = classifyStartupUpdateRoute(parsedArgs, autoPrint);
	const startupUpdate = new StartupUpdateOrchestrator(
		startupUpdateRoute,
		() => settingsInstance.get("startup.checkUpdate"),
		deps.startupUpdate?.check ?? (() => checkForNewVersion(VERSION)),
	);
	const isInteractive = disposition.isInteractive;
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
		deps.initTheme ?? initTheme,
		isInteractive,
		settingsInstance.get("symbolPreset"),
		settingsInstance.get("colorBlindMode"),
		settingsInstance.get("theme.dark"),
		settingsInstance.get("theme.light"),
	);

	const credentialAutoImportNotice = isInteractive
		? await logger.time(
				"credentialAutoImport",
				deps.runStartupCredentialAutoImportIfNeeded ?? runStartupCredentialAutoImportIfNeeded,
				{
					authStorage,
					modelRegistry,
					agentDir: settingsInstance.getAgentDir(),
				},
			)
		: undefined;

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

	// Create session manager based on CLI flags. A bare resume was strictly opened
	// before startup discovery, so it never reaches create-or-open behavior here.
	const sessionManager =
		bareResumeSessionManager ??
		(await logger.time("createSessionManager", createSessionManager, parsedArgs, cwd, settingsInstance));

	// Restore the resumed session's working directory so the HUD branch, the
	// project path, and the agent's tools all match where the session was
	// created. A `--worktree` session lives in a linked worktree whose path
	// differs from where `--continue`/`--resume` is invoked, which would
	// otherwise leave the HUD pinned to the main checkout's branch.
	if (sessionManager && !parsedArgs.cwd) {
		const sessionCwd = sessionManager.getCwd();
		if (sessionCwd && normalizePathForComparison(sessionCwd) !== normalizePathForComparison(getProjectDir())) {
			try {
				if ((await fs.stat(sessionCwd)).isDirectory()) {
					setProjectDir(sessionCwd);
				}
			} catch {
				// Session cwd no longer exists (e.g. worktree removed); keep current dir.
			}
		}
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
	// Resolve the token-log dir lazily on the first chat-usage event: a fresh
	// launch's session dir does not exist yet at this point (the SDK creates it),
	// so eager resolution would miss it. Re-resolve when the SessionManager id
	// changes mid-run (fork/new) so root turns keep landing in the SAME
	// `<session>/token-logs` dir the task executor uses for subagent turns.
	let rootTokenLogDir: string | undefined;
	let rootTokenLogSessionId: string | undefined;
	let rootTokenLogResolved = false;
	let rootTokenTurn = 0;
	const baseTelemetry = sessionOptions.telemetry;
	sessionOptions.telemetry = {
		...(baseTelemetry ?? {}),
		onChatUsage: async event => {
			await baseTelemetry?.onChatUsage?.(event);
			const currentSessionId = sessionManager?.getSessionId();
			if (!rootTokenLogResolved || (currentSessionId && currentSessionId !== rootTokenLogSessionId)) {
				rootTokenLogDir = await resolveTaskTokenLogDir(process.cwd(), sessionManager);
				// Reset the per-session turn counter when the log dir moves to a new
				// session so each session's log starts at turn 1.
				if (rootTokenLogSessionId !== undefined && currentSessionId !== rootTokenLogSessionId) rootTokenTurn = 0;
				rootTokenLogSessionId = currentSessionId;
				rootTokenLogResolved = true;
			}
			if (!rootTokenLogDir) return;
			rootTokenTurn += 1;
			await persistTaskTokenLog(
				taskTokenLogFromUsage(event.usage, {
					subagentId: "root",
					agent: event.agent?.name ?? "main",
					// Monotonic 1-based sequence of persisted usage events for this
					// session (event.stepNumber is 0-based and -1 for oneshot spans).
					turn: rootTokenTurn,
					at: new Date().toISOString(),
					model: event.model,
					cost: event.cost,
				}),
				{ dir: rootTokenLogDir },
			);
		},
	};
	sessionOptions.authStorage = authStorage;
	sessionOptions.modelRegistry = modelRegistry;
	sessionOptions.hasUI = isInteractive;
	sessionOptions.notificationHostModeSupported = isInteractive;
	sessionOptions.sdkHostModeSupported = isInteractive;
	sessionOptions.settings = settingsInstance;
	const hasRootStartupProfile = Boolean(settingsInstance.get("modelProfile.default") || parsedArgs.mpreset);

	// Research-mode (RLM) preset: augment session options before session creation.
	deps.rlmPreset?.applyOptions(sessionOptions, settingsInstance);
	const acpStartupOptions = mode === "acp" ? resolveAcpStartupOptions(parsedArgs, sessionOptions) : undefined;

	// Handle CLI --api-key as runtime override (not persisted)
	if (parsedArgs.apiKey && parsedArgs.credential) {
		process.stderr.write(`${chalk.red("--api-key and --credential cannot be used together")}\n`);
		process.exit(1);
	}

	if (parsedArgs.credential) {
		try {
			sessionOptions.credentialSelector = parseCliCredentialSelector(parsedArgs.credential);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`${chalk.red(message)}\n`);
			process.exit(1);
		}
	}
	if (parsedArgs.apiKey) {
		if (!sessionOptions.model && !sessionOptions.modelPattern) {
			process.stderr.write(
				`${chalk.red("--api-key requires a model to be specified via --model, --provider/--model, or --models")}\n`,
			);
			process.exit(1);
		}
		applyCliRuntimeApiKeyOverride(authStorage, parsedArgs.apiKey, sessionOptions.model);
	}

	if (
		!deps.suppressProcessExit &&
		deps.createAgentSession === undefined &&
		parsedArgs.noSession === true &&
		!parsedArgs.continue &&
		parsedArgs.resume === undefined &&
		parsedArgs.fork === undefined &&
		!isInteractive &&
		mode !== "acp" &&
		!hasRootStartupProfile &&
		!sessionOptions.model &&
		!sessionOptions.modelPattern &&
		modelRegistry.getAvailable().length === 0
	) {
		process.stderr.write(`${chalk.red(`No models available. ${formatModelOnboardingGuidance()}`)}\n`);
		process.stderr.write(
			`${chalk.yellow(`\nAdvanced manual config remains available at ${ModelsConfigFile.path()}`)}\n`,
		);
		process.exitCode = 1;
		authStorage.close();
		stopThemeWatcher();
		await postmortem.cleanup();
		return;
	}
	const createAgentSessionImpl = deps.createAgentSession ?? createAgentSession;
	const createSession: CreateSessionForMain = async (options, context): Promise<CreateAgentSessionResult> => {
		const result = await logger.time("createAgentSession", createAgentSessionImpl, options);
		// Kick off background model discovery only after createAgentSession finishes its parallel
		// discovery arms; running these concurrently contends for the event loop and stretches
		// every parallel arm by ~30ms. Startup model profiles do their own foreground refresh
		// before activation so project-scoped defaults can resolve freshly discovered models.
		if (!context?.skipPostCreateModelRefresh) {
			modelRegistry.refreshInBackground();
		}
		return result;
	};

	if (mode === "acp") {
		try {
			await (deps.runAcpMode ?? (await import("./modes/acp")).runAcpMode)({
				agentDir: settingsInstance.getAgentDir(),
				...(acpStartupOptions ? { startupOptions: acpStartupOptions } : {}),
			});
		} finally {
			authStorage.close();
			stopThemeWatcher();
			if (!deps.suppressProcessExit) await postmortem.cleanup();
		}
	} else {
		const { session, setToolUIContext, modelFallbackMessage, lspServers, mcpManager, eventBus } = await createSession(
			sessionOptions,
			{ skipPostCreateModelRefresh: hasRootStartupProfile },
		);
		applyCliRuntimeApiKeyOverride(authStorage, parsedArgs.apiKey, session.model);

		// Research-mode (RLM) preset: hard tool-boundary assertion after the registry is assembled.
		if (deps.rlmPreset?.onSessionCreated) {
			try {
				await deps.rlmPreset.onSessionCreated(session);
			} catch (error) {
				try {
					await session.dispose();
				} catch {
					logger.warn("Failed to dispose session after RLM post-create error");
				}
				throw error;
			}
		}

		if (!(parsedArgs.authBootstrap === true && isInteractive)) {
			const { recoverableErrors } = await applyStartupModelProfilesForRoot({
				session,
				settings: settingsInstance,
				modelRegistry,
				parsedArgs,
				startupModel: sessionOptions.model,
				startupThinkingLevel: sessionOptions.thinkingLevel,
				isInteractive,
				hasInteractiveTerminal: hasResumePickerTerminal(),
				initialMessage,
				initialMessages: parsedArgs.messages,
				resumeAction: bareResumeAction,
			});
			for (const recoverableError of recoverableErrors) {
				notifs.push({ kind: "error", message: recoverableError });
			}
		}

		if (modelFallbackMessage) {
			notifs.push({ kind: "warn", message: modelFallbackMessage });
		}

		const modelRegistryError = modelRegistry.getError();
		if (modelRegistryError) {
			notifs.push({ kind: "error", message: modelRegistryError.message });
		}
		if (credentialAutoImportNotice) {
			notifs.push({ kind: "info", message: credentialAutoImportNotice });
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
			await session.dispose();
			stopThemeWatcher();
			await postmortem.quit(1);
			process.exit(1);
		}

		if (isInteractive) {
			let exitForTiming = false;
			try {
				startupUpdate.startBeforeInteractiveInitialization();
				const changelogMarkdown = await logger.time(
					"main:getChangelogForDisplay",
					deps.getChangelogForDisplay ?? getChangelogForDisplay,
					parsedArgs,
				);

				const scopedModelsForDisplay = sessionOptions.scopedModels ?? scopedModels;
				if (scopedModelsForDisplay.length > 0) {
					const modelList = scopedModelsForDisplay
						.map(scopedModel => {
							const thinkingStr = !scopedModel.thinkingLevel ? `:${scopedModel.thinkingLevel}` : "";
							return `${scopedModel.model.id}${thinkingStr}`;
						})
						.join(", ");
					process.stdout.write(`${chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Alt+N to cycle)")}`)}\n`);
				}

				if ($env.PI_TIMING) {
					logger.printTimings();
					exitForTiming = $env.PI_TIMING === "x";
				}

				if (!exitForTiming) {
					logger.endTiming();
					await runInteractiveMode(
						session,
						VERSION,
						changelogMarkdown,
						notifs,
						startupUpdate,
						parsedArgs.messages,
						setToolUIContext,
						lspServers,
						mcpManager,
						eventBus,
						initialMessage,
						initialImages,
						deps.createInteractiveMode,
						bareResumeAction,
					);
				}
			} catch (error) {
				try {
					await session.dispose();
				} catch {
					logger.warn("Failed to dispose session after interactive error");
				}
				throw error;
			}

			if (exitForTiming) {
				await session.dispose();
				process.exit(0);
			}
		} else {
			const runPrint = deps.runPrintMode ?? (await import("./modes/print-mode")).runPrintMode;
			try {
				await runPrint(session, {
					mode,
					messages: parsedArgs.messages,
					initialMessage,
					initialImages,
					suppressProcessExit: deps.suppressProcessExit,
				});
				if ($env.PI_TIMING) {
					logger.printTimings();
				}
			} finally {
				stopThemeWatcher();
				authStorage.close();
				if (!deps.suppressProcessExit) await postmortem.cleanup();
			}
		}
	}
}

export async function main(args: string[]): Promise<void> {
	if (isTmuxOwnerIsolationCliArgv(args)) {
		await runTmuxOwnerIsolationCliFromStdin();
		return;
	}
	if (isManagedOwnerSupervisorArgv(args)) {
		await runManagedOwnerSupervisor();
		return;
	}
	const admission = await admitManagedOwnerBeforeCli();
	if (admission.kind === "blocked") return;
	if (admission.kind === "recovery") {
		await completeManagedOwnerRecovery(admission.context);
		return;
	}
	const { runCli } = await import("./cli");
	await runCli(args.length === 0 ? ["launch"] : args);
}
