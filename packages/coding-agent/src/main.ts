/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import type { ImageContent } from "@gajae-code/ai/core";
import {
	$pickenv,
	getAgentDir,
	getProjectDir,
	logger,
	normalizePathForComparison,
	postmortem,
	setProjectDir,
	VERSION,
} from "@gajae-code/utils";
import { startupProjectEnvSnapshot } from "@gajae-code/utils/env";
import { canonicalEnvKey } from "@gajae-code/utils/env-file";
import chalk from "chalk";
import { selectAppendSystemPromptFile } from "./cli/append-system-prompt";
import { type Args, resolvePlanModelOverride } from "./cli/args";
import { processFileArguments } from "./cli/file-processor";
import { fetchGithubChannelRelease } from "./cli/github-release";
import { buildInitialMessage } from "./cli/initial-message";
import { resolveLaunchDisposition } from "./cli/launch-disposition";
import { runListModelsCommand } from "./cli/list-models";
import { selectSession } from "./cli/session-picker";
import { getConfigDirs } from "./config";
import { FileLockAcquireError, FileLockStagingCleanupError } from "./config/file-lock";
import {
	activateModelProfile,
	applyModelProfileRuntimeBindings,
	ModelProfileCredentialError,
} from "./config/model-profile-activation";
import { UnknownModelProfileError } from "./config/model-profile-contract";
import { ModelRegistry, ModelsConfigFile } from "./config/model-registry";
import {
	parseModelString,
	refreshMissingQualifiedModelProviders,
	resolveCliModel,
	resolveModelRoleValue,
	resolveModelScope,
	resolveStartupModelRefreshSelectors,
	type ScopedModel,
} from "./config/model-resolver";
import { selectorHead } from "./config/model-selector-value";
import { getDefault, type SettingPath, Settings, settings } from "./config/settings";
import { resolveMachineLocalUpdateChannel, type UpdateChannel } from "./config/update-channel";
import { BUNDLED_GROK_BUILD_EXTENSION_ID, getBundledGrokBuildExtensionFactory } from "./defaults/gjc-grok-cli";
import { initializeWithSettings } from "./discovery";
import { exportFromFile } from "./export/html";
import type { ExtensionUIContext } from "./extensibility/extensions/types";
import { releaseLaunchWorktreeReservationAfterRegistration } from "./gjc-runtime/launch-worktree-reservation";
import { persistCoordinatorRuntimeInputReady } from "./gjc-runtime/session-state-sidecar";
import { assertMasterLaunchArgs, assertMasterLaunchDisposition, createMasterModeContext } from "./master-mode/context";
import type { AcpStartupOptions } from "./modes/acp/startup-options";
import type { SessionSelectionResult } from "./modes/components/session-selector";
import type { InteractiveMode } from "./modes/interactive-mode";
import type { PrintModeOptions } from "./modes/print-mode";
import { initTheme, stopThemeWatcher } from "./modes/theme/theme";
import type { SubmittedUserInput } from "./modes/types";
import { applyCliRuntimeApiKeyOverride } from "./runtime-api-key";
import { type CliCredentialSelector, parseCliCredentialSelector } from "./runtime-credential-selector";
import type { MCPManager } from "./runtime-mcp";
// Leaf path, not the barrel: the capability registry must stay out of the
// runtime-mcp import graph that every root command would otherwise load.
import { attachExactMcpControls } from "./runtime-mcp/redaction";
import { issueSessionMcpControlGrant } from "./runtime-mcp/session-controls-grant";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
} from "./sdk";
import { processIncarnation } from "./sdk/broker/process-incarnation";
import {
	newMasterAttestationEpoch,
	resolveSessionLocator,
	SessionIndex,
	type SessionLocatorV2,
} from "./sdk/broker/session-index";
import type { AgentSession } from "./session/agent-session";
import { ManagedAppendIdentityMismatchError } from "./session/internal/managed-session-storage";
import { SessionMigrationBusyError } from "./session/internal/session-open-errors";
import { setPrimaryControlSurface } from "./session/primary-control-surface";
import {
	type ResumeSessionIdentity,
	resolveResumableSession,
	SESSION_OVERSIZED_RECOVERY_MESSAGE,
	SessionArtifactCapacityError,
	type SessionDestination,
	type SessionDirectoryMigrationPolicy,
	type SessionInfo,
	SessionManager,
	SessionTranscriptOversizedError,
	type StrictSessionOpenResult,
} from "./session/session-manager";
import { resolveStartupAuthConfig } from "./session/startup-auth-config";
import { runStartupCredentialAutoImportIfNeeded } from "./setup/credential-auto-import";
import {
	readOnboardingState,
	shouldOfferAutomaticOnboarding,
	shouldOfferOnboarding,
} from "./setup/frictionless-onboarding";
import { formatModelOnboardingGuidance } from "./setup/model-onboarding-guidance";
import { executeBuiltinSlashCommand } from "./slash-commands/builtin-registry";
import { resolvePromptInput } from "./system-prompt";
import { persistTaskTokenLog, resolveTaskTokenLogDir, taskTokenLogFromUsage } from "./task/token-log";
import type { LspStartupServerInfo } from "./tools";
import { getDisplayChangelogEntries, getInstalledVersionChangelogEntry, getNewEntries } from "./utils/changelog";
import type { EventBus } from "./utils/event-bus";
import { installHerdrReporter } from "./utils/herdr-pane";

const MANAGED_OWNER_SUPERVISOR_ARG = "--internal-managed-owner-supervisor";
const MANAGED_OWNER_CHILD_TOKEN_ENV = "GJC_MANAGED_OWNER_CHILD_TOKEN";
const TMUX_OWNER_ISOLATION_ARG = "--internal-tmux-owner-isolation";

async function checkForNewVersion(
	currentVersion: string,
	channel: UpdateChannel = "stable",
): Promise<string | undefined> {
	try {
		const { version } = await fetchGithubChannelRelease({ channel });
		return Bun.semver.order(version, currentVersion) > 0 ? version : undefined;
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
	"task.autorouting.enabled",
	"task.autorouting.tiers",
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
		| "preferCredential"
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
		| "noMcp"
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
		...(parsed.preferCredential ? ["--prefer-credential"] : []),
		...(parsed.continue ? ["--continue"] : []),
		...(parsed.cwd ? ["--cwd"] : []),
		...(parsed.fileArgs.length > 0 ? ["@file"] : []),
		...(parsed.fork ? ["--fork"] : []),
		...(parsed.hooks?.length ? ["--hook"] : []),
		...(parsed.messages.length > 0 ? ["initial prompt"] : []),
		...(parsed.models?.length ? ["--models"] : []),
		...(parsed.mcpConfig !== undefined ? ["--mcp-config"] : []),
		...(parsed.noMcp ? ["--no-mcp"] : []),
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
		...(parsed.skills !== undefined ? ["--skills"] : []),
		...(parsed.plan ? ["--plan"] : []),
		...(parsed.systemPrompt ? ["--system-prompt"] : []),
		...(parsed.tmux ? ["--tmux"] : []),
		...(parsed.tools !== undefined ? ["--tools"] : []),
		...(parsed.extensions?.length ? ["--extension"] : []),
		...(parsed.unknownFlags.size > 0 ? [`unknown flags: ${[...parsed.unknownFlags.keys()].join(" ")}`] : []),
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
		| "markPendingSubmissionStarted"
		| "finishPendingSubmission"
		| "showError"
		| "checkShutdownRequested"
		| "waitForAgentEnd"
	>,
	session: Pick<AgentSession, "prompt" | "promptCustomMessage"> & {
		continuePersistedHistory?: AgentSession["continuePersistedHistory"];
	},
	input: SubmittedUserInput,
): Promise<void> {
	if (input.cancelled) {
		return;
	}

	try {
		if (input.started) {
			if (!session.continuePersistedHistory) throw new Error("Session continuation is unavailable.");
			await session.continuePersistedHistory();
			return;
		}
		// Continue shortcuts submit an already-started empty prompt with no optimistic user message.
		if (!mode.markPendingSubmissionStarted(input)) {
			return;
		}
		const agentEnd = mode.waitForAgentEnd();
		try {
			const prompt = input.customType
				? session.promptCustomMessage({
						customType: input.customType,
						content: input.text,
						display: input.display ?? false,
						attribution: "agent",
					})
				: session.prompt(input.text, { images: input.images });
			const promptResult = prompt.then(
				() => ({ type: "prompt" as const }),
				(error: unknown) => ({ type: "error" as const, error }),
			);
			const result = await Promise.race([
				promptResult,
				agentEnd.promise.then(() => ({ type: "agent_end" as const })),
			]);
			if (result.type === "error") {
				const errorMessage = result.error instanceof Error ? result.error.message : "Unknown error occurred";
				mode.showError(errorMessage);
			} else if (result.type === "agent_end") {
				void prompt.catch((error: unknown) => {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					mode.showError(errorMessage);
				});
			}
		} finally {
			agentEnd.dispose();
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
	parsedArgs: Pick<Args, "continue" | "default" | "fork" | "model" | "mpreset" | "resume" | "thinking">;
	startupModel?: CreateAgentSessionOptions["model"];
	startupThinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	preferCachedModels?: boolean;
	preferCachedDefaultProfile?: boolean;
};

type StartupModelProfileFailure = {
	profileName: string;
	error: ModelProfileCredentialError | UnknownModelProfileError;
};

function staleDefaultProfileMessage(error: UnknownModelProfileError, profileCatalogRefreshUnavailable = false): string {
	const refreshNotice = profileCatalogRefreshUnavailable
		? " The online profile catalog could not be refreshed; continuing with the last accepted catalog."
		: "";
	return `Configured modelProfile.default is stale: unknown model profile ${JSON.stringify(error.details.requestedProfile)}. Select a replacement in the UI. To clear it, remove modelProfile.default from the project's .gjc/config.yml or .gjc/settings.json if set there, or run gjc config reset modelProfile.default for the global setting.${refreshNotice}`;
}

async function applyStartupModelProfilesWithPolicy(
	args: StartupModelProfileArgs,
	onCredentialError?: (error: ModelProfileCredentialError) => void,
	onUnknownDefault?: (error: UnknownModelProfileError, profileCatalogRefreshUnavailable: boolean) => void,
): Promise<void> {
	let profileCatalogRefreshUnavailable = false;
	let profilePassFailures: StartupModelProfileFailure[] = [];
	let unhandledProfileName: string | undefined;
	const applyProfile = async (
		profileName: string,
		persistDefault: boolean,
		options: {
			thinkingLevelOverride?: CreateAgentSessionOptions["thinkingLevel"];
			tolerateCredentialError?: boolean;
			tolerateUnknownDefault?: boolean;
			runtimeBindingsOnly?: boolean;
			userSelectionRevision?: number;
		} = {},
	): Promise<boolean> => {
		const isCurrent =
			options.userSelectionRevision === undefined
				? undefined
				: () => args.session.getUserModelSelectionRevision() === options.userSelectionRevision;
		if (isCurrent && !isCurrent()) return false;
		const apply = async (): Promise<boolean> => {
			if (isCurrent && !isCurrent()) return false;
			if (options.runtimeBindingsOnly) {
				await applyModelProfileRuntimeBindings(
					{
						session: args.session,
						modelRegistry: args.modelRegistry,
						settings: args.settings,
						profileName,
					},
					isCurrent,
				);
			} else {
				await activateModelProfile(
					{ session: args.session, modelRegistry: args.modelRegistry, settings: args.settings, profileName },
					{
						persistDefault,
						thinkingLevelOverride: options.thinkingLevelOverride,
						isCurrent,
					},
				);
			}
			return true;
		};
		try {
			return isCurrent ? await args.session.withSdkControlMutation(apply) : await apply();
		} catch (error) {
			if (error instanceof ModelProfileCredentialError && (onCredentialError || options.tolerateCredentialError)) {
				profilePassFailures.push({ profileName, error });
				logger.warn("Startup model profile not applied: missing provider credentials", {
					profile: profileName,
					errorClass: error.name,
					providers: error.providers,
					role: error.role,
				});
				if (!onCredentialError) process.stderr.write(`${chalk.yellow(`Warning: ${error.message}`)}\n`);
				return false;
			}
			if (error instanceof UnknownModelProfileError && options.tolerateUnknownDefault) {
				profilePassFailures.push({ profileName, error });
				logger.warn("Startup model profile not applied: unknown profile", {
					profile: profileName,
					errorClass: error.name,
					catalogRefreshUnavailable: profileCatalogRefreshUnavailable,
				});
				if (!onUnknownDefault)
					process.stderr.write(
						`${chalk.yellow(`Warning: ${staleDefaultProfileMessage(error, profileCatalogRefreshUnavailable)}`)}\n`,
					);
				return false;
			}
			unhandledProfileName = profileName;
			throw error;
		}
	};

	// An explicit startup selector (--mpreset or --model) fully replaces the
	// persisted default profile for this session, so a failing default must not
	// abort a non-interactive run: it is reported as a warning and the explicit
	// selection proceeds. Without an explicit selector, failures remain fatal
	// except for a stale default on input-free interactive startup.
	const tolerateDefaultProfileFailure = args.parsedArgs.mpreset !== undefined || args.parsedArgs.model !== undefined;

	// Capture the explicitly-selected startup model BEFORE profile activation can
	// override it. startupModel covers the eager path; session.model covers the
	// deferred `--model <pattern>` path resolved inside createAgentSession.
	const explicitModel = args.parsedArgs.model ? (args.startupModel ?? args.session.model) : undefined;
	const defaultProfile = args.settings.get("modelProfile.default");
	const preferCachedProfiles =
		(args.preferCachedModels === true && args.parsedArgs.mpreset !== undefined) ||
		(args.preferCachedDefaultProfile === true && defaultProfile !== undefined);
	let modelSelectionChangedDuringRecovery = false;
	const applyConfiguredProfiles = async (
		allowMissingDefault: boolean,
		profileNames?: ReadonlySet<string>,
		userSelectionRevision?: number,
	): Promise<boolean> => {
		profilePassFailures = [];
		unhandledProfileName = undefined;
		let applied = true;
		if (defaultProfile && (!profileNames || profileNames.has(defaultProfile))) {
			applied =
				(await applyProfile(defaultProfile, false, {
					thinkingLevelOverride: args.settings.has("defaultThinkingLevel")
						? args.settings.get("defaultThinkingLevel")
						: undefined,
					tolerateCredentialError: tolerateDefaultProfileFailure,
					tolerateUnknownDefault:
						onUnknownDefault !== undefined || (allowMissingDefault && tolerateDefaultProfileFailure),
					runtimeBindingsOnly: args.session.hasRecoveredDefaultFallbackChain(),
					userSelectionRevision,
				})) && applied;
		}
		if (args.parsedArgs.mpreset && (!profileNames || profileNames.has(args.parsedArgs.mpreset))) {
			applied =
				(await applyProfile(args.parsedArgs.mpreset, args.parsedArgs.default === true, {
					userSelectionRevision,
				})) && applied;
		}
		return applied;
	};
	const profilesFromFirstFailure = (failedProfiles: ReadonlySet<string>): ReadonlySet<string> => {
		const orderedProfiles = [defaultProfile, args.parsedArgs.mpreset].filter(
			(name): name is string => name !== undefined,
		);
		const firstFailureIndex = orderedProfiles.findIndex(name => failedProfiles.has(name));
		return firstFailureIndex === -1 ? failedProfiles : new Set(orderedProfiles.slice(firstFailureIndex));
	};
	const applyFailedProfiles = async (
		failedProfiles: ReadonlySet<string>,
		userSelectionRevision: number,
	): Promise<boolean> => {
		const applied = await applyConfiguredProfiles(true, failedProfiles, userSelectionRevision);
		if (
			applied &&
			defaultProfile !== undefined &&
			failedProfiles.has(defaultProfile) &&
			args.parsedArgs.mpreset !== undefined &&
			!failedProfiles.has(args.parsedArgs.mpreset)
		) {
			return applyProfile(args.parsedArgs.mpreset, args.parsedArgs.default === true, { userSelectionRevision });
		}
		return applied;
	};
	const refreshAuthAndCatalog = async (continueOnRefreshError: boolean): Promise<void> => {
		try {
			await args.modelRegistry.authStorage?.reload();
		} catch (error) {
			logger.warn("Failed to reload auth before startup model profile recovery", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		try {
			await args.modelRegistry.refreshModelPresetProfilesFromRegistry();
		} catch (error) {
			if (!continueOnRefreshError && args.modelRegistry.getError()) throw error;
			profileCatalogRefreshUnavailable = true;
			logger.warn("Failed to refresh model profile catalog before startup recovery", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		try {
			await args.modelRegistry.refresh("online-if-uncached", args.session.credentialSessionId);
		} catch (error) {
			if (!continueOnRefreshError) throw error;
			logger.warn("Failed to refresh model catalog before startup profile recovery", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const reportFinalProfileFailures = (markDefaultUnavailable = true): void => {
		for (const failure of profilePassFailures) {
			if (failure.error instanceof ModelProfileCredentialError) {
				onCredentialError?.(failure.error);
			} else {
				onUnknownDefault?.(failure.error, profileCatalogRefreshUnavailable);
			}
		}
		if (
			markDefaultUnavailable &&
			(onCredentialError || onUnknownDefault) &&
			args.parsedArgs.mpreset === undefined &&
			args.parsedArgs.model === undefined
		) {
			const defaultFailure = profilePassFailures.find(failure => failure.profileName === defaultProfile);
			if (defaultFailure) args.session.setUnavailableModelProfile(defaultFailure.profileName);
		}
	};

	// Deferred --mpreset startup can overlap selector input; never reapply its
	// captured profile after the user has selected a newer model.
	if (preferCachedProfiles) {
		let applied: boolean;
		let refreshedOnline = false;
		const selectionRevision = args.session.getUserModelSelectionRevision();
		try {
			applied = await applyConfiguredProfiles(false, undefined, selectionRevision);
		} catch (error) {
			if (error instanceof ModelProfileCredentialError) throw error;
			if (error instanceof UnknownModelProfileError) {
				await refreshAuthAndCatalog(onCredentialError !== undefined || onUnknownDefault !== undefined);
			} else {
				await args.modelRegistry.refresh("online-if-uncached", args.session.credentialSessionId);
			}
			if (args.session.getUserModelSelectionRevision() !== selectionRevision) return;
			refreshedOnline = true;
			const failedProfiles = new Set(profilePassFailures.map(failure => failure.profileName));
			if (unhandledProfileName) failedProfiles.add(unhandledProfileName);
			const profilesToRetry = profilesFromFirstFailure(failedProfiles);
			applied = await applyConfiguredProfiles(
				true,
				profilesToRetry.size > 0 ? profilesToRetry : undefined,
				selectionRevision,
			);
			if (args.session.getUserModelSelectionRevision() !== selectionRevision) return;
		}
		if (args.session.getUserModelSelectionRevision() !== selectionRevision) {
			modelSelectionChangedDuringRecovery = true;
			applied = false;
		}
		if (
			!modelSelectionChangedDuringRecovery &&
			!applied &&
			profilePassFailures.length > 0 &&
			(onCredentialError !== undefined || onUnknownDefault !== undefined)
		) {
			if (!refreshedOnline) {
				const failedProfiles = new Set(profilePassFailures.map(failure => failure.profileName));
				await refreshAuthAndCatalog(true);
				refreshedOnline = true;
				if (args.session.getUserModelSelectionRevision() !== selectionRevision) {
					modelSelectionChangedDuringRecovery = true;
					applied = false;
				} else {
					applied = await applyFailedProfiles(failedProfiles, selectionRevision);
					if (args.session.getUserModelSelectionRevision() !== selectionRevision) {
						modelSelectionChangedDuringRecovery = true;
						applied = false;
					}
				}
			}
			if (applied) args.session.setUnavailableModelProfile(undefined);
			else reportFinalProfileFailures(!modelSelectionChangedDuringRecovery);
		}
		if (applied && !refreshedOnline)
			args.modelRegistry.refreshInBackground("online-if-uncached", args.session.credentialSessionId);
	} else {
		if (defaultProfile || args.parsedArgs.mpreset) {
			await args.modelRegistry.refresh("online-if-uncached", args.session.credentialSessionId);
		}
		await applyConfiguredProfiles(true);
	}

	// Explicit CLI --model/--thinking must win over any activated or skipped profile.
	if (explicitModel && !modelSelectionChangedDuringRecovery) {
		await args.session.setModelTemporary(explicitModel, args.startupThinkingLevel ?? args.parsedArgs.thinking, {
			persistAsSessionDefault: true,
			cause: "startup-override",
		});
		const selector = `${explicitModel.provider}/${explicitModel.id}`;
		args.session.setConfiguredModelChain("default", [selector], "startup-override", undefined, true);
		args.session.seedDefaultFallbackResolution(0, []);
	} else if (!modelSelectionChangedDuringRecovery && args.parsedArgs.thinking && args.session.model) {
		await args.session.setModelTemporary(args.session.model, args.parsedArgs.thinking, { cause: "startup-override" });
	}
}

export async function applyStartupModelProfiles(args: StartupModelProfileArgs): Promise<void> {
	await applyStartupModelProfilesWithPolicy(args);
}

async function exitForStartupModelProfileError(args: StartupModelProfileArgs, error: unknown): Promise<never> {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(
		error instanceof ManagedAppendIdentityMismatchError
			? `${error.operatorMessage}\n`
			: `${chalk.red(`Error: ${message}`)}\n`,
	);
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

function isStartupModelProfileStaleDefaultRecoveryEligible(
	options: Parameters<typeof isStartupModelProfileCredentialRecoveryEligible>[0] & {
		parsedArgs: Pick<Args, "continue" | "fork" | "resume">;
	},
): boolean {
	return (
		isStartupModelProfileCredentialRecoveryEligible(options) &&
		options.parsedArgs.continue !== true &&
		options.parsedArgs.fork === undefined &&
		((options.parsedArgs.resume === undefined && options.resumeAction === undefined) ||
			(options.parsedArgs.resume === true && options.resumeAction === "open-idle"))
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
	const policyArgs = {
		...args,
		preferCachedModels: args.isInteractive,
		preferCachedDefaultProfile: args.isInteractive,
	};
	const recoverableErrors: string[] = [];
	const onCredentialError = isStartupModelProfileCredentialRecoveryEligible(args)
		? (error: ModelProfileCredentialError) => recoverableErrors.push(error.message)
		: undefined;
	const onUnknownDefault = isStartupModelProfileStaleDefaultRecoveryEligible(args)
		? (error: UnknownModelProfileError, profileCatalogRefreshUnavailable: boolean) =>
				recoverableErrors.push(staleDefaultProfileMessage(error, profileCatalogRefreshUnavailable))
		: undefined;
	try {
		await applyStartupModelProfilesWithPolicy(policyArgs, onCredentialError, onUnknownDefault);
	} catch (error) {
		await exitForStartupModelProfileError(args, error);
	}
	return { recoverableErrors };
}

type DeferredModelProfileStartup = () => Promise<{ recoverableErrors: string[] }>;
class DeferredModelProfileStartupError extends Error {
	readonly profileError: unknown;

	constructor(profileError: unknown) {
		super("Deferred model profile startup failed");
		this.profileError = profileError;
	}
}

async function applyDeferredStartupModelProfilesForRoot(
	args: StartupModelProfileArgs & {
		isInteractive: boolean;
		hasInteractiveTerminal: boolean;
		initialMessage: string | undefined;
		initialMessages: readonly string[];
		resumeAction: "continue-tail" | "open-idle" | undefined;
	},
): Promise<{ recoverableErrors: string[] }> {
	const recoverableErrors: string[] = [];
	const onCredentialError = isStartupModelProfileCredentialRecoveryEligible(args)
		? (error: ModelProfileCredentialError) => recoverableErrors.push(error.message)
		: undefined;
	await applyStartupModelProfilesWithPolicy({ ...args, preferCachedModels: true }, onCredentialError, error =>
		recoverableErrors.push(staleDefaultProfileMessage(error)),
	);
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
type ListForResumePickerReadOnly = (cwd: string, sessionDir?: string, storage?: undefined) => Promise<SessionInfo[]>;

type ListManagedForResumePickerReadOnly = (
	cwd: string,
	managedAgentDir?: string,
	storage?: undefined,
) => Promise<SessionInfo[]>;

type ResolveManagedAgentDirForScope = (cwd: string) => string;

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

/** Resolves only the managed agent root needed for pre-consent picker inventory. */
export function resolveManagedAgentDirForScope(_cwd: string): string {
	return getAgentDir();
}
export const BARE_RESUME_OPEN_ERROR = "Could not open the selected session. Use --resume <id>.";
const SESSION_ARTIFACT_CAPACITY_RECOVERY_MESSAGE =
	"The selected legacy session's artifacts exceed the supported migration capacity. Archive or remove only that legacy session's artifacts after confirming they are no longer needed, then retry.";

export class SessionForkDeclinedError extends Error {
	readonly code = "session_fork_declined" as const;
	readonly #sessionId: string;
	readonly #projectDirectory: string;

	constructor(sessionId: string, projectDirectory: string) {
		super(
			`Session "${sessionId}" is in another project (${projectDirectory}). Re-run from that directory, or accept the fork when prompted.`,
		);
		this.name = "SessionForkDeclinedError";
		this.#sessionId = sessionId;
		this.#projectDirectory = projectDirectory;
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	get projectDirectory(): string {
		return this.#projectDirectory;
	}
}

export class SessionNotFoundError extends Error {
	readonly code = "session_not_found" as const;
	readonly #sessionId: string;

	constructor(sessionId: string) {
		super(`Session "${sessionId}" not found.`);
		this.name = "SessionNotFoundError";
		this.#sessionId = sessionId;
	}

	get sessionId(): string {
		return this.#sessionId;
	}
}

export function operatorFacingSessionOpenMessage(value: unknown): string | undefined {
	const code =
		value instanceof SessionForkDeclinedError
			? value.code
			: value instanceof SessionNotFoundError
				? value.code
				: value instanceof SessionArtifactCapacityError
					? value.code
					: value instanceof SessionMigrationBusyError
						? value.code
						: value instanceof SessionTranscriptOversizedError
							? value.code
							: typeof value === "string"
								? value
								: undefined;
	if (code === "session_fork_declined" && value instanceof SessionForkDeclinedError) return value.message;
	if (code === "session_not_found" && value instanceof SessionNotFoundError) return value.message;
	if (code === "artifact_capacity_exceeded") return SESSION_ARTIFACT_CAPACITY_RECOVERY_MESSAGE;
	if (code === "oversized") return SESSION_OVERSIZED_RECOVERY_MESSAGE;
	if (code === "migration_busy") return new SessionMigrationBusyError().message;
	return undefined;
}

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

export function shouldNotifyModelFallback(authBootstrap: boolean | undefined, isInteractive: boolean): boolean {
	return !(authBootstrap === true && isInteractive);
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
	startDeferredMcpConfig?: CreateAgentSessionResult["startDeferredMcpConfig"],
	startDeferredModelProfiles?: DeferredModelProfileStartup,
	options?: { stopAfterFirstPaint?: boolean },
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

	await logger.time("interactive:init", () => initializeInteractiveModeWithStartupUpdate(mode, startupUpdate));
	try {
		await persistCoordinatorRuntimeInputReady();
	} catch (error) {
		logger.warn("Failed to persist coordinator runtime input readiness", { error: String(error) });
		throw error;
	}

	if (
		shouldOfferAutomaticOnboarding({
			normalInteractive: true,
			automation:
				/^(?:1|true|yes|on)$/i.test(process.env.CI ?? "") ||
				/^(?:1|true|yes|on)$/i.test(process.env.GJC_AUTOMATION ?? "") ||
				// The timing probe must never block on a fresh-profile onboarding
				// selector waiting for input that will never come.
				options?.stopAfterFirstPaint === true,
			initialMessage,
			initialMessages,
			initialImages,
			resumeAction,
		})
	) {
		const agentDir = session.getSessionAgentDir?.() ?? session.settings?.getAgentDir?.();
		if (agentDir) {
			const onboardingState = await readOnboardingState(agentDir);
			if (shouldOfferOnboarding(onboardingState)) await mode.showFrictionlessOnboarding();
		}
	}
	logger.time("interactive:firstPaint", () => mode.renderInitialMessages(undefined, { preserveExistingChat: true }));
	if (options?.stopAfterFirstPaint) {
		// GJC_TIMING=x probe: the cold-start measurement ends here, so tear the UI
		// down with the same shutdown/stop order the interactive exit path uses.
		await mode.shutdown();
		mode.stop();
		return;
	}

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
	if (startDeferredMcpConfig) {
		mode.showStatus("Connecting MCP tools…");
		void startDeferredMcpConfig()
			.then(result => {
				if (result.hasErrors) {
					mode.showWarning(
						result.loadedToolCount > 0 ? "Some MCP tools could not be loaded." : "MCP tools could not be loaded.",
					);
					return;
				}
				mode.showStatus(`${result.loadedToolCount} MCP tool${result.loadedToolCount === 1 ? "" : "s"} connected`);
			})
			.catch(() => {
				logger.warn("Deferred MCP startup failed.");
				mode.showError("MCP tools could not be loaded.");
			});
	}
	let deferredModelProfileFailure: Promise<never> | undefined;
	if (startDeferredModelProfiles) {
		mode.showStatus("Loading model profile…");
		deferredModelProfileFailure = startDeferredModelProfiles().then(
			result => {
				for (const error of result.recoverableErrors) mode.showError(error);
				mode.showStatus("Model profile ready");
				return Promise.withResolvers<never>().promise;
			},
			error => {
				const message = error instanceof Error ? error.message : "Model profile could not be loaded.";
				mode.showError(message);
				throw new DeferredModelProfileStartupError(error);
			},
		);
	}

	// Startup input bypasses the editor submit path, so seed the automatic title
	// here. Only text that `prompt` actually dispatches to a loaded skill is
	// skipped; unknown `/skill:` text is submitted as an ordinary prompt and is
	// titled like one. It must run before the prompt (the title gate skips
	// sessions that already hold a user message), and a title failure must never
	// drop the prompt.
	const maybeGenerateStartupTitle = (text: string, images?: readonly unknown[]): void => {
		try {
			if (session.resolvePromptSkillInvocation(text, images) || session.isLocallyHandledSlashCommand(text)) return;
			mode.maybeGenerateSessionTitle(text);
		} catch (error: unknown) {
			logger.warn("Startup session title generation failed", { error: String(error) });
		}
	};

	const runStartupInputAndPromptLoop = async (): Promise<never> => {
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
				maybeGenerateStartupTitle(initialMessage, initialImages);
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
				maybeGenerateStartupTitle(text);
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
	};

	const inputLoop = runStartupInputAndPromptLoop();
	if (!deferredModelProfileFailure) {
		await inputLoop;
		return;
	}
	try {
		await Promise.race([inputLoop, deferredModelProfileFailure]);
	} catch (error) {
		if (!(error instanceof DeferredModelProfileStartupError)) throw error;
		try {
			await mode.shutdown();
		} finally {
			mode.stop();
		}
		await inputLoop.catch(() => {});
		throw error.profileError;
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

export async function getChangelogForDisplay(parsed: Args): Promise<string | undefined> {
	if (parsed.continue || parsed.resume) {
		return undefined;
	}

	const entries = getDisplayChangelogEntries();
	if (entries.length === 0) {
		return undefined;
	}

	const lastVersion = settings.get("lastChangelogVersion");
	if (!lastVersion) {
		if (settings.canWriteDurableConfig()) {
			settings.set("lastChangelogVersion", VERSION);
			await flushChangelogVersion();
		}
		return getInstalledVersionChangelogEntry(entries, VERSION)?.content;
	}

	if (lastVersion !== VERSION) {
		const newEntries = getNewEntries(entries, lastVersion);
		if (settings.canWriteDurableConfig()) {
			settings.set("lastChangelogVersion", VERSION);
			await flushChangelogVersion();
		}
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
	const sessionMemoryMode = activeSettings.get("sessionMemory.mode");
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
			return await SessionManager.forkFrom(
				forkSource,
				cwd,
				sessionDestination(),
				undefined,
				migrationPolicy,
				sessionMemoryMode,
			);
		}
		const match = await resolveResumableSession(
			forkSource,
			cwd,
			parsed.sessionDir,
			undefined,
			parsed.sessionDir ? undefined : activeSettings.getAgentDir(),
		);
		if (!match) {
			throw new SessionNotFoundError(forkSource);
		}
		return await SessionManager.forkFrom(
			match.session.path,
			cwd,
			sessionDestination(),
			undefined,
			migrationPolicy,
			sessionMemoryMode,
		);
	}

	if (parsed.noSession) {
		return SessionManager.inMemory();
	}
	if (typeof parsed.resume === "string") {
		const sessionArg = parsed.resume;
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			const destination = parsed.sessionDir
				? SessionManager.explicitDestination(parsed.sessionDir)
				: SessionManager.explicitDestination(path.dirname(sessionArg));
			return await SessionManager.open(sessionArg, destination, undefined, migrationPolicy, sessionMemoryMode);
		}
		const match = await resolveResumableSession(
			sessionArg,
			cwd,
			parsed.sessionDir,
			undefined,
			parsed.sessionDir ? undefined : activeSettings.getAgentDir(),
		);
		if (!match) {
			throw new SessionNotFoundError(sessionArg);
		}
		if (match.scope === "global") {
			const normalizedCwd = normalizePathForComparison(cwd);
			const normalizedMatchCwd = normalizePathForComparison(match.session.cwd || cwd);
			if (normalizedCwd !== normalizedMatchCwd) {
				const shouldFork = await promptForkSession(match.session);
				if (!shouldFork) {
					throw new SessionForkDeclinedError(sessionArg, match.session.cwd);
				}
				return await SessionManager.forkFrom(
					match.session.path,
					cwd,
					sessionDestination(),
					undefined,
					migrationPolicy,
					sessionMemoryMode,
				);
			}
		}
		return await SessionManager.open(
			match.session.path,
			sessionDestination(),
			undefined,
			migrationPolicy,
			sessionMemoryMode,
		);
	}
	if (parsed.continue) {
		return await SessionManager.continueRecent(
			cwd,
			sessionDestination(),
			undefined,
			migrationPolicy,
			sessionMemoryMode,
		);
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
		const manager = await SessionManager.continueRecent(
			cwd,
			sessionDestination(),
			undefined,
			migrationPolicy,
			sessionMemoryMode,
		);
		if (manager.hasHistoryEntries()) {
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

/** User APPEND_SYSTEM.md only. Repository copies are not appended. */
function discoverAppendSystemPromptFile(): string | undefined {
	const candidates = getConfigDirs("", { existingOnly: false }).flatMap(entry => {
		const filePath = path.join(entry.path, "APPEND_SYSTEM.md");
		return existsSync(filePath) ? [{ level: entry.level, path: filePath }] : [];
	});
	return selectAppendSystemPromptFile(candidates);
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
	if (parsed.noMcp === true) options.enableMcpAutoload = false;

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

	// Session startup discovers extension modules from the canonical locations, so
	// these stay at their defaults. `--extension` / `--no-extensions` are retired
	// ACP-only launch flags and deliberately do not feed the local startup path.
	options.disableExtensionDiscovery = false;
	options.additionalExtensionPaths = [];

	return { options };
}

type RunPrintMode = (session: AgentSession, options: PrintModeOptions) => Promise<void>;

export interface RunRootCommandDependencies {
	createAgentSession?: typeof createAgentSession;
	createSessionManager?: typeof createSessionManager;
	registerDirectSession?: typeof registerDirectSession;
	discoverAuthStorage?: typeof discoverAuthStorage;
	resolveStartupAuthConfig?: typeof resolveStartupAuthConfig;
	runAcpMode?: (options?: { agentDir?: string }) => Promise<void>;
	settings?: Settings;
	suppressProcessExit?: boolean;
	startupUpdate?: { check: () => Promise<string | undefined> };
	initTheme?: typeof initTheme;
	readPipedInput?: typeof readPipedInput;
	stdinIsTTY?: boolean;
	runStartupCredentialAutoImportIfNeeded?: typeof runStartupCredentialAutoImportIfNeeded;
	getChangelogForDisplay?: typeof getChangelogForDisplay;
	createInteractiveMode?: CreateInteractiveMode;
	runPrintMode?: RunPrintMode;
	quit?: (code: number) => Promise<void>;
	isResumePickerTerminal?: ResumePickerTerminalCheck;
	listForResumePickerReadOnly?: ListForResumePickerReadOnly;
	listManagedForResumePickerReadOnly?: ListManagedForResumePickerReadOnly;
	resolveManagedAgentDirForScope?: ResolveManagedAgentDirForScope;
	selectResumeSession?: SelectResumeSession;
	openExistingSessionStrict?: OpenExistingSessionStrict;
	initializeSettings?: typeof Settings.init;
	loadSettingsForScope?: typeof Settings.loadForScope;
}

type DirectSessionManager = Pick<SessionManager, "getCwd" | "getSessionFile" | "getSessionId">;

/**
 * Direct CLI liveness is meaningful only for sessions with a durable transcript.
 * An in-memory manager has no artifacts for GC to fence and must not touch the
 * shared SDK session-index lock.
 */
export function directSessionRegistrationId(
	sessionManager: DirectSessionManager | undefined,
	lifecycleRequestId: string | undefined,
): string | undefined {
	if (lifecycleRequestId || sessionManager?.getSessionFile() === undefined) return undefined;
	return sessionManager.getSessionId();
}

interface DirectSessionRegistrationDependencies {
	createIndex?: (agentDir: string) => SessionIndex;
	processIncarnation?: typeof processIncarnation;
	registerPostmortem?: typeof postmortem.register;
	masterRole?: { ownerSessionId: string; attestationEpoch: string };
}

/**
 * Handle for a direct CLI session's broker-index registration.
 *
 * A direct session registers once at startup, but `/new`, `/resume` and forks
 * replace the manager's session id inside the same process. The index row is
 * keyed on that id, so without a follow-up the successor is never indexed and the
 * predecessor stays live for as long as this pid is alive (the broker keeps
 * heartbeating a live pid). `syncIdentity` moves the registration to whichever
 * id the manager the session has adopted currently reports.
 */
export interface DirectSessionRegistration {
	/**
	 * Register the current manager's session id and release the one it replaced.
	 *
	 * `adoptedManager` rebinds the registration to the manager the session now
	 * owns: a bounded cold-sidecar fork adopts its own forked manager before it
	 * emits `session_switch`, so the wired handler must hand that manager over or
	 * the sync keeps reading the startup manager's predecessor id.
	 */
	syncIdentity(adoptedManager?: DirectSessionManager): Promise<void>;
}

const NOOP_DIRECT_SESSION_REGISTRATION: DirectSessionRegistration = { syncIdentity: async () => {} };

/**
 * Appends allowed for one successor registration before the switch gives up and
 * keeps the predecessor registered. `SessionIndex.append` takes the shared index
 * lock independently per append, so a peer holding it is a transient failure.
 */
const DIRECT_SESSION_REGISTRATION_ATTEMPTS = 3;

/** Register a durable direct CLI session while leaving ephemeral sessions lock-free. */
export async function registerDirectSession(
	sessionManager: DirectSessionManager | undefined,
	agentDir: string,
	lifecycleRequestId: string | undefined,
	dependencies: DirectSessionRegistrationDependencies = {},
): Promise<DirectSessionRegistration> {
	const initialSessionId = directSessionRegistrationId(sessionManager, lifecycleRequestId);
	if (!initialSessionId || !sessionManager) return NOOP_DIRECT_SESSION_REGISTRATION;
	const sessionIndex = dependencies.createIndex?.(agentDir) ?? new SessionIndex(agentDir);
	const directSessionIncarnation = (dependencies.processIncarnation ?? processIncarnation)(process.pid);
	// The session can adopt a different manager mid-process (bounded cold-sidecar
	// fork), so every read goes through the manager that is current now.
	let activeManager = sessionManager;
	let registeredLocator: SessionLocatorV2 | undefined;
	let registeredSessionId: string | undefined;
	// Predecessors whose `host_unregistered` append has not succeeded yet. Once the
	// successor is registered the old id is no longer `registeredSessionId`, so a
	// release that failed here would otherwise be lost and keep the predecessor live
	// in the index for the rest of the process. An entry is dropped as soon as its id
	// is current again: replaying it would retire a session this process reactivated.
	const pendingPredecessorReleases: Array<{ sessionId: string; locator: SessionLocatorV2 | undefined }> = [];
	const forgetPendingRelease = (sessionId: string): void => {
		for (let index = pendingPredecessorReleases.length - 1; index >= 0; index--) {
			if (pendingPredecessorReleases[index]?.sessionId === sessionId) pendingPredecessorReleases.splice(index, 1);
		}
	};

	const register = async (sessionId: string): Promise<void> => {
		const locator = await resolveSessionLocator(activeManager.getCwd(), agentDir);
		try {
			await sessionIndex.append({
				type: "host_registered",
				sessionId,
				locator,
				endpointGeneration: 0,
				pid: process.pid,
				...(directSessionIncarnation ? { processIncarnation: directSessionIncarnation } : {}),
				...(dependencies.masterRole && directSessionIncarnation
					? {
							masterRole: {
								version: 2 as const,
								ownerSessionId: dependencies.masterRole.ownerSessionId,
								launchPid: process.pid,
								launchProcessIncarnation: directSessionIncarnation,
								role: "master" as const,
								attestationEpoch: dependencies.masterRole.attestationEpoch,
							},
						}
					: {}),
			});
		} catch (error) {
			// A lock-release refusal after the row is durable is a real startup failure:
			// the next process would observe a registered session whose lock generation
			// this process can no longer prove. Surface it instead of adopting the row.
			if (error instanceof Error && /^Failed to release file lock:/u.test(error.message)) throw error;
			// `SessionIndex.append` can reject after its row is already durable (awaited
			// post-append maintenance), so a rejection does not prove the registration is
			// missing. Adopt the id when this process already owns a live row for it, so a
			// later switch still releases it; otherwise the switch keeps failing and the
			// previous identity stays registered.
			if (!isRegisteredLive(sessionId)) throw error;
			logger.warn("Direct session registration append failed after its row was durable", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		// This id is current again: any queued release for it is stale.
		forgetPendingRelease(sessionId);
		registeredLocator = locator;
		registeredSessionId = sessionId;
	};
	const isRegisteredLive = (sessionId: string): boolean => {
		try {
			return sessionIndex
				.listSessions()
				.sessions.some(row => row.sessionId === sessionId && row.pid === process.pid && row.live === true);
		} catch {
			return false;
		}
	};
	const unregister = async (sessionId: string, locator: SessionLocatorV2 | undefined): Promise<void> => {
		if (!locator) return;
		await sessionIndex.append({
			type: "host_unregistered",
			sessionId,
			locator,
			endpointGeneration: 0,
			pid: process.pid,
		});
	};

	/**
	 * Release queued predecessors in order. A failed append keeps its entry, so the
	 * next sync or the teardown handler retries it; the failure itself is a warning
	 * rather than a failed identity switch, matching the best-effort release of the
	 * launch worktree reservation below.
	 */
	const releasePendingPredecessors = async (): Promise<void> => {
		while (pendingPredecessorReleases.length > 0) {
			const predecessor = pendingPredecessorReleases[0]!;
			// Defence in depth for the reactivation order: never retire the id this
			// process currently publishes as its own.
			if (predecessor.sessionId === registeredSessionId) {
				pendingPredecessorReleases.shift();
				continue;
			}
			try {
				await unregister(predecessor.sessionId, predecessor.locator);
			} catch (error) {
				logger.warn("Failed to release a superseded session registration", {
					error: error instanceof Error ? error.message : String(error),
				});
				return;
			}
			pendingPredecessorReleases.shift();
		}
	};

	/**
	 * Register `sessionId`, retrying a bounded number of times so a transient
	 * index-lock loss self-heals instead of leaving the successor unregistered
	 * until the next identity change.
	 */
	const registerWithRetry = async (sessionId: string): Promise<void> => {
		for (let attempt = 1; ; attempt++) {
			try {
				await register(sessionId);
				return;
			} catch (error) {
				// Only lock contention self-heals. A refused release is an identity
				// verdict; retrying it would mask a committed registration whose lock
				// generation no longer matches.
				const code = (error as NodeJS.ErrnoException | undefined)?.code;
				const transient =
					code === "sharing_violation" ||
					code === "access_denied" ||
					code === "EBUSY" ||
					code === "EPERM" ||
					code === "EACCES" ||
					code === "ENOTEMPTY" ||
					code === "removal_record_busy";
				if (!transient || attempt >= DIRECT_SESSION_REGISTRATION_ATTEMPTS) throw error;
				await Bun.sleep(50 * attempt);
			}
		}
	};

	/**
	 * Move the registration to the id `activeManager` currently reports.
	 *
	 * A successor append that cannot land after its bounded retries keeps the
	 * predecessor registered and the successor unregistered, so every later call
	 * (any session event, or teardown) retries the successor instead of leaving it
	 * unindexed for the life of the process.
	 */
	const syncToActiveManager = async (): Promise<void> => {
		const currentId = activeManager.getSessionFile() === undefined ? undefined : activeManager.getSessionId();
		// A predecessor left over from a failed release is retried here even when
		// the identity itself did not change.
		if (!currentId || currentId === registeredSessionId) {
			await releasePendingPredecessors();
			return;
		}
		// The predecessor is released under the locator it was registered with, and
		// only after the successor's own append succeeded.
		const predecessorId = registeredSessionId;
		const predecessorLocator = registeredLocator;
		await registerWithRetry(currentId);
		if (predecessorId) {
			pendingPredecessorReleases.push({ sessionId: predecessorId, locator: predecessorLocator });
			await releasePendingPredecessors();
		}
	};

	await register(initialSessionId);
	if (registeredLocator?.worktreeRoot != null) {
		try {
			await releaseLaunchWorktreeReservationAfterRegistration(agentDir, registeredLocator.worktreeRoot);
		} catch (error) {
			logger.warn("Failed to release launch worktree reservation after host registration", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	// Teardown registers the id the session is on now — a post-switch append that
	// failed would otherwise leave the active transcript unindexed — then releases
	// everything this process still holds.
	(dependencies.registerPostmortem ?? postmortem.register)("direct-session-index", async _reason => {
		try {
			await syncToActiveManager();
		} catch (error) {
			logger.warn("Failed to register the active direct session during teardown", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		if (registeredSessionId) await unregister(registeredSessionId, registeredLocator);
		await releasePendingPredecessors();
	});

	let syncing: Promise<void> = Promise.resolve();
	return {
		syncIdentity: adoptedManager => {
			// Serialized: a rapid /new /new must register in order and never interleave.
			const run = syncing.then(async () => {
				// An ephemeral manager owns nothing the index could fence, so the tracked
				// manager survives an adoption that has no durable transcript.
				if (adoptedManager?.getSessionFile() !== undefined) activeManager = adoptedManager;
				await syncToActiveManager();
			});
			syncing = run.catch(() => {});
			return run;
		},
	};
}

function directSessionIndexLockFailureMessage(error: unknown, agentDir: string): string | undefined {
	if (error instanceof FileLockStagingCleanupError) {
		return (
			"Session index lock staging cleanup failed; acquisition stopped instead of retrying with another staging directory.\n" +
			`Lock: ${error.lockPath}\nStaging: ${error.stagingPath}\nCode: ${error.code ?? "unknown"}\n${error.message}`
		);
	}
	if (error instanceof FileLockAcquireError) {
		const code = error.publicationFailureCode ?? error.code;
		if (error.publicationFailureCode === "sharing_violation" || error.holderIsLive)
			return (
				"Session index is busy (validated lock-publication contention). Retry in a few seconds.\n" +
				`Lock: ${error.lockPath}\nCode: ${code}\n${error.message}`
			);
		return (
			"Session index lock acquisition failed; no session was registered.\n" +
			`Lock: ${error.lockPath}\nCode: ${code}\nHolder: ${error.holder}`
		);
	}
	if (!(error instanceof Error) || !/^Failed to publish file lock:/u.test(error.message)) return undefined;
	const code =
		(error as NodeJS.ErrnoException).code ??
		error.message.match(/^Failed to publish file lock: ([a-z0-9_]+)/u)?.[1] ??
		"unknown";
	const lockPath = path.join(agentDir, "sdk", "sessions", "index.jsonl.lock");
	return `Session index lock publication failed; no session was registered.\nLock: ${lockPath}\nCode: ${code}\n${error.message}`;
}

/**
 * Apply the `--no-pty` / `--no-title` terminal-control flags to the environment.
 *
 * Sets the canonical `GJC_*` name (so an explicit flag wins over a user-set
 * `GJC_*` value under the GJC-first resolver — CLI authority) and the legacy
 * `PI_*` name for backward compatibility. `--acp` mode implies `--no-title`.
 */
export function applyTerminalControlFlagsToEnv(
	parsed: Pick<Args, "noPty" | "noTitle" | "mode">,
	env: NodeJS.ProcessEnv = Bun.env,
): void {
	if (parsed.noPty) {
		env.GJC_NO_PTY = "1";
		env.PI_NO_PTY = "1";
	}
	if (parsed.noTitle || parsed.mode === "acp") {
		env.GJC_NO_TITLE = "1";
		env.PI_NO_TITLE = "1";
	}
}

/**
 * Whether the live `HERDR_BIN_PATH` must not be used as Herdr's executable.
 *
 * A static project declaration is rejected when the live value is that
 * declaration, including surrounding whitespace. A dynamic declaration is
 * ambiguous with Bun's preload, so any live value is rejected and Herdr falls
 * back to `PATH`. A shell export is kept when the project declaration is
 * absent or is a different static string.
 */
export function rejectProjectHerdrBinPath(
	runtime: string | undefined,
	declared: string | undefined,
	dynamic: boolean,
): boolean {
	if (runtime === undefined) return false;
	if (dynamic) return true;
	if (declared === undefined) return false;
	return runtime === declared || runtime.trim() === declared;
}

/** Drop a project-supplied Herdr executable before this command spawns anything. */
export function dropProjectSuppliedHerdrBinPath(env: NodeJS.ProcessEnv): void {
	const snapshot = startupProjectEnvSnapshot();
	const key = canonicalEnvKey("HERDR_BIN_PATH");
	if (!rejectProjectHerdrBinPath(env.HERDR_BIN_PATH, snapshot.values[key], snapshot.dynamic.has(key))) return;
	delete env.HERDR_BIN_PATH;
}

export async function runRootCommand(
	parsed: Args,
	rawArgs: string[],
	deps: RunRootCommandDependencies = {},
): Promise<void> {
	dropProjectSuppliedHerdrBinPath(process.env);
	const parsedArgs = parsed;
	assertMasterLaunchArgs(parsedArgs);
	let initialThemeInitialized = false;
	let autoChdirApplied = false;
	let bareResumeSessionManager: SessionManager | undefined;
	let bareResumeAction: "continue-tail" | "open-idle" | undefined;
	let bareResumeCleanupFailed = false;

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
		const managedAgentDir = parsedArgs.sessionDir
			? undefined
			: (deps.resolveManagedAgentDirForScope ?? resolveManagedAgentDirForScope)(resumeCwd);
		const sessions = parsedArgs.sessionDir
			? await (deps.listForResumePickerReadOnly ?? SessionManager.listForResumePickerReadOnly)(
					resumeCwd,
					parsedArgs.sessionDir,
				)
			: await (deps.listManagedForResumePickerReadOnly ?? SessionManager.listManagedForResumePickerReadOnly)(
					resumeCwd,
					managedAgentDir,
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
		const scopedSettings = await (deps.loadSettingsForScope ?? Settings.loadForScope)({ cwd: resumeCwd });
		try {
			const resumeMigrationPolicy =
				scopedSettings.get("session.directoryMigration") === "disabled" ? "disabled" : "copy-retain";
			let opened: StrictSessionOpenResult;
			try {
				opened = await (deps.openExistingSessionStrict ?? SessionManager.openExistingStrict)(
					selection.identity,
					parsedArgs.sessionDir
						? SessionManager.explicitDestination(parsedArgs.sessionDir)
						: SessionManager.managedDestination(resumeCwd, scopedSettings.getAgentDir()),
					undefined,
					resumeMigrationPolicy,
				);
			} catch (error) {
				process.stderr.write(`${operatorFacingSessionOpenMessage(error) ?? BARE_RESUME_OPEN_ERROR}\n`);
				if (!deps.suppressProcessExit) process.exitCode = 1;
				return;
			}
			if (opened.kind === "error") {
				process.stderr.write(`${operatorFacingSessionOpenMessage(opened.reason) ?? BARE_RESUME_OPEN_ERROR}\n`);
				if (!deps.suppressProcessExit) process.exitCode = 1;
				return;
			}
			bareResumeSessionManager = opened.manager;
			bareResumeAction = selection.action;
		} catch (error) {
			process.stderr.write(`${operatorFacingSessionOpenMessage(error) ?? BARE_RESUME_OPEN_ERROR}\n`);
			if (!deps.suppressProcessExit) process.exitCode = 1;
			return;
		} finally {
			try {
				await scopedSettings.close?.();
			} catch (error) {
				await bareResumeSessionManager?.close().catch(() => undefined);
				bareResumeSessionManager = undefined;
				bareResumeCleanupFailed = true;
				logger.warn("Resume settings cleanup failed; discarded opened session manager", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (bareResumeCleanupFailed) {
			if (!deps.suppressProcessExit) process.exitCode = 1;
			return;
		}
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

	// Keep store authority and persistent pin intent in the same startup snapshot.
	// Injected discoverers own their auth unless they also supply a config resolver.
	const agentDir = deps.settings?.getAgentDir() ?? getAgentDir();
	const resolveAuthConfig =
		deps.resolveStartupAuthConfig ?? (deps.discoverAuthStorage ? undefined : resolveStartupAuthConfig);
	const startupAuthConfig = await resolveAuthConfig?.(agentDir);
	const authStorage = await logger.time("discoverModels", () =>
		(deps.discoverAuthStorage ?? discoverAuthStorage)(agentDir, startupAuthConfig),
	);
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
	applyTerminalControlFlagsToEnv(parsedArgs);
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
	// Master admission runs unconditionally and BEFORE any session state is
	// opened or created. Nesting it under nonInteractiveError skipped it for a
	// non-TTY launch carrying prepared input, which resolves to autoPrint with no
	// error, so `--master <prompt>` proceeded as an ordinary auto-print run.
	try {
		assertMasterLaunchDisposition({
			master: parsedArgs.master,
			isInteractive: disposition.isInteractive,
			autoPrint: disposition.autoPrint,
			nonInteractiveError: disposition.nonInteractiveError,
		});
	} catch (error) {
		process.stderr.write(`${chalk.red(error instanceof Error ? error.message : "Invalid master launch")}\n`);
		if (!deps.suppressProcessExit) process.exitCode = 1;
		return;
	}
	if (disposition.nonInteractiveError) {
		process.stderr.write(`${chalk.red(disposition.nonInteractiveError)}\n`);
		process.exit(1);
	}
	const autoPrint = disposition.autoPrint;
	const startupUpdateRoute = classifyStartupUpdateRoute(parsedArgs, autoPrint);
	const startupUpdate = new StartupUpdateOrchestrator(
		startupUpdateRoute,
		() => settingsInstance.get("startup.checkUpdate"),
		deps.startupUpdate?.check ??
			(() => checkForNewVersion(VERSION, resolveMachineLocalUpdateChannel(settingsInstance))),
	);
	const isInteractive = disposition.isInteractive;
	const mode = parsedArgs.mode || "text";
	// One-shot print runs (`gjc -p`, auto-print) never display provider usage, so
	// credential selection must not probe usage endpoints from every short-lived
	// process; it reuses reports that long-lived hosts already cached (#5939).
	if (!isInteractive && mode !== "acp") authStorage.setUsageProbeMode("cache-only");

	// Initialize discovery system with settings for provider persistence
	logger.time("initializeWithSettings", initializeWithSettings, settingsInstance);

	// Plan mode switches to the `plan` model role; --plan / GJC_PLAN_MODEL override it
	// for this run only (ephemeral, not persisted).
	const planModelOverride = resolvePlanModelOverride(parsedArgs);
	if (planModelOverride) settingsInstance.overrideModelRoles({ plan: planModelOverride });
	// Apply --clipboard-transport / --clipboard-ssh-host as ephemeral runtime
	// overrides (CLI > persisted config > "auto" default). Not persisted.
	if (parsedArgs.clipboardTransport) {
		settingsInstance.override("clipboard.transport", parsedArgs.clipboardTransport);
	}
	if (parsedArgs.clipboardSshHost) {
		settingsInstance.override("clipboard.sshHost", parsedArgs.clipboardSshHost);
	}
	if (parsedArgs.clipboardTransport === "ssh" && !settingsInstance.get("clipboard.sshHost")) {
		process.stderr.write(
			`${chalk.red("Error: --clipboard-transport ssh requires --clipboard-ssh-host <alias> (or clipboard.sshHost in config)")}\n`,
		);
		process.exit(1);
	}

	await logger.time(
		"initTheme:final",
		deps.initTheme ?? initTheme,
		isInteractive && settingsInstance.get("theme.watchFiles"),
		settingsInstance.get("symbolPreset"),
		settingsInstance.get("colorBlindMode"),
		settingsInstance.get("theme.dark"),
		settingsInstance.get("theme.light"),
		settingsInstance.get("syntaxHighlighting.enabled"),
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

	if (parsedArgs.apiKey && parsedArgs.credential) {
		process.stderr.write(`${chalk.red("--api-key and --credential cannot be used together")}\n`);
		process.exit(1);
	}
	if (parsedArgs.credential && parsedArgs.preferCredential) {
		process.stderr.write(`${chalk.red("--credential and --prefer-credential cannot be used together")}\n`);
		process.exit(1);
	}
	if (parsedArgs.apiKey && parsedArgs.preferCredential) {
		process.stderr.write(`${chalk.red("--api-key and --prefer-credential cannot be used together")}\n`);
		process.exit(1);
	}

	let credentialSelector: CliCredentialSelector | undefined;
	let preferredCredentialSelector: CliCredentialSelector | undefined;
	try {
		credentialSelector = parsedArgs.credential ? parseCliCredentialSelector(parsedArgs.credential) : undefined;
		preferredCredentialSelector = parsedArgs.preferCredential
			? parseCliCredentialSelector(parsedArgs.preferCredential)
			: undefined;
		if (preferredCredentialSelector) {
			const provider =
				preferredCredentialSelector.provider ??
				authStorage.resolveRuntimePreferredCredentialSelectorProvider(preferredCredentialSelector.selector);
			authStorage.setRuntimePreferredCredentialSelector(provider, preferredCredentialSelector.selector);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${chalk.red(message)}\n`);
		process.exit(1);
	}

	const hasRootStartupProfile = Boolean(settingsInstance.get("modelProfile.default") || parsedArgs.mpreset);
	const startupModelSelectors = resolveStartupModelRefreshSelectors(
		{
			model: parsedArgs.model,
			provider: parsedArgs.provider,
			credential: parsedArgs.credential,
			continue: parsedArgs.continue,
			resume: parsedArgs.resume,
			hasStartupProfile: hasRootStartupProfile,
		},
		settingsInstance,
	);
	const explicitStartupModelSelector = parsedArgs.model
		? typeof startupModelSelectors === "string"
			? startupModelSelectors
			: parsedArgs.model
		: undefined;
	if (parsedArgs.apiKey && explicitStartupModelSelector) {
		const parsedModel = parseModelString(explicitStartupModelSelector);
		if (parsedModel) authStorage.setRuntimeApiKey(parsedModel.provider, parsedArgs.apiKey);
	}
	await logger.time(
		"refreshStartupModelProviders",
		refreshMissingQualifiedModelProviders,
		startupModelSelectors,
		modelRegistry,
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

	// Create session manager based on CLI flags. A bare resume was strictly opened
	// before startup discovery, so it never reaches create-or-open behavior here.
	let sessionManager: SessionManager | undefined = bareResumeSessionManager;
	if (!sessionManager) {
		try {
			sessionManager = await logger.time(
				"createSessionManager",
				deps.createSessionManager ?? createSessionManager,
				parsedArgs,
				cwd,
				settingsInstance,
			);
		} catch (error) {
			const message = operatorFacingSessionOpenMessage(error);
			if (!message) throw error;
			process.stderr.write(`${message}\n`);
			if (!deps.suppressProcessExit) process.exitCode = 1;
			authStorage.close();
			stopThemeWatcher();
			await postmortem.cleanup();
			return;
		}
	}

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
	const masterModeContext =
		parsedArgs.master === true && sessionManager
			? createMasterModeContext(
					parsedArgs.masterScope ?? "repo",
					sessionManager.getSessionId(),
					newMasterAttestationEpoch(),
				)
			: undefined;

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
		// C3 telemetry split: the default token-log wrapper is usage-only —
		// spans stay off unless an SDK embedder supplied its own telemetry
		// config, which remains authoritative.
		...(baseTelemetry ?? { spans: false }),
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
	let rootStartupCacheAdmissionAttempted = false;
	sessionOptions.authStorage = authStorage;
	sessionOptions.modelRegistry = modelRegistry;
	sessionOptions.startupAuthConfig = startupAuthConfig;
	sessionOptions.modelRegistryStartupMutation = {
		owner: "cli-root",
		onAttempt: () => {
			rootStartupCacheAdmissionAttempted = true;
		},
	};
	sessionOptions.hasUI = isInteractive;
	sessionOptions.notificationHostModeSupported = isInteractive;
	sessionOptions.sdkHostModeSupported = isInteractive;
	setPrimaryControlSurface(sessionOptions, "cli");
	sessionOptions.settings = settingsInstance;
	sessionOptions.masterModeContext = masterModeContext;
	// Interactive launches paint before MCP connects: the deferred starter runs
	// after first paint and a startup turn barrier keeps the first prompt from
	// racing tool registration. A no-op whenever no MCP servers apply — exact
	// `--mcp-config`, conventional autoload, or plugin bundles (plugins never
	// defer; their connect evidence is published during session creation).
	// ACP/print/SDK sessions connect eagerly and are not carved out here.
	if (isInteractive) {
		// Root TUI sessions may control conventional autoload declarations after first paint.
		// The grant is minted here only; SDK callers of createAgentSession cannot mint one.
		// Exact --mcp-config sessions retain their existing capability path.
		sessionOptions.deferMcpConfigStartup = true;
		if (sessionOptions.mcpConfigPath === undefined && sessionOptions.enableMcpAutoload !== false)
			sessionOptions.sessionMcpControlGrant = issueSessionMcpControlGrant();
	}
	// ACP is not carved out: `gjc acp` is broker-backed and never builds a local
	// session here, and the broker-launched lifecycle child defers memory startup
	// unconditionally (createLifecycleAgentSession) so readiness never waits on
	// the memory pipeline's LLM work.
	const deferMemoryBackendStartup = hasRootStartupProfile && !(parsedArgs.authBootstrap === true && isInteractive);
	sessionOptions.deferMemoryBackendStartup = deferMemoryBackendStartup;

	const acpStartupOptions = mode === "acp" ? resolveAcpStartupOptions(parsedArgs, sessionOptions) : undefined;

	// Handle CLI credential selection and --api-key as runtime overrides (not persisted).
	if (credentialSelector) sessionOptions.credentialSelector = credentialSelector;
	if (preferredCredentialSelector) sessionOptions.preferredCredentialSelector = preferredCredentialSelector;
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
	// Register a resumed direct session before constructing the agent: GC holds the
	// same index lock while deleting artifacts, so startup and deletion are fenced.
	// Ephemeral sessions have no durable artifacts or liveness authority to fence.
	const sessionAgentDir = settingsInstance.getAgentDir();
	let directSessionRegistration: DirectSessionRegistration;
	try {
		directSessionRegistration = await (deps.registerDirectSession ?? registerDirectSession)(
			sessionManager,
			sessionAgentDir,
			process.env.GJC_LIFECYCLE_REQUEST_ID,
			{
				masterRole: masterModeContext
					? {
							ownerSessionId: masterModeContext.ownerSessionId,
							attestationEpoch: masterModeContext.attestationEpoch,
						}
					: undefined,
			},
		);
	} catch (error) {
		const message = directSessionIndexLockFailureMessage(error, sessionAgentDir);
		if (message === undefined) throw error;
		process.stderr.write(`${message}\n`);
		if (!deps.suppressProcessExit) process.exitCode = 1;
		await sessionManager?.close().catch(closeError => {
			logger.warn("Failed to close session manager after session-index registration failure", {
				error: closeError instanceof Error ? closeError.message : String(closeError),
			});
		});
		authStorage.close();
		stopThemeWatcher();
		await postmortem.cleanup();
		return;
	}
	// /new, /resume and forks replace the manager's session id in this same process.
	// Follow it, or the broker index keeps listing the predecessor as live forever.
	//
	// The extension context is not a usable source here: `ExtensionRunner` is
	// constructed with the startup manager and `createContext()` keeps handing that
	// facade back, while a bounded cold-sidecar fork replaces only the session's own
	// manager. Read the live session at dispatch time instead.
	let liveSession: AgentSession | undefined;
	sessionOptions.extensions = [
		...(sessionOptions.extensions ?? []),
		pi => {
			const sync = async (): Promise<void> => {
				try {
					await directSessionRegistration.syncIdentity(liveSession?.sessionManager);
				} catch (error) {
					logger.warn("Failed to move direct session registration to the new session id", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			};
			pi.on("session_switch", sync);
			pi.on("session_branch", sync);
			// A transition whose append failed is retried at the next turn boundary, not
			// only on another identity change.
			pi.on("agent_end", sync);
		},
	];
	const createAgentSessionImpl = deps.createAgentSession ?? createAgentSession;
	const createSession: CreateSessionForMain = async (options, context): Promise<CreateAgentSessionResult> => {
		const result = await logger.time("createAgentSession", createAgentSessionImpl, options);
		// Kick off background model discovery only after createAgentSession finishes its parallel
		// discovery arms; running these concurrently contends for the event loop and stretches
		// every parallel arm by ~30ms. Startup model profiles do their own foreground refresh
		// before activation so project-scoped defaults can resolve freshly discovered models.
		if (!context?.skipPostCreateModelRefresh && !rootStartupCacheAdmissionAttempted) {
			modelRegistry.refreshInBackground("online-if-uncached", result.session.credentialSessionId);
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
		const {
			session,
			setToolUIContext,
			modelFallbackMessage,
			lspServers,
			mcpManager,
			startDeferredMcpConfig,
			startDeferredMemoryBackend,
			eventBus,
		} = await createSession(sessionOptions, { skipPostCreateModelRefresh: hasRootStartupProfile });
		liveSession = session;
		applyCliRuntimeApiKeyOverride(authStorage, parsedArgs.apiKey, session.model);
		// Herdr integration: report gjc lifecycle state when running in a Herdr pane.
		installHerdrReporter(listener => session.subscribe(listener));

		// Exact MCP capability attaches at the root interactive entry point.
		// Granted by creation path, not by call order:
		// only a session this root command built for an interactive run with an
		// explicit --mcp-config gets one. Sessions built through createAgentSession
		// directly, sub-sessions, ACP, and print/text/json runs never reach here.
		if (isInteractive && sessionOptions.mcpConfigPath) {
			attachExactMcpControls(session, {
				grantSource: "root-interactive-exact-config",
				configPath: sessionOptions.mcpConfigPath,
			});
		}

		let startDeferredModelProfiles: DeferredModelProfileStartup | undefined;
		if (!(parsedArgs.authBootstrap === true && isInteractive)) {
			const profileArgs = {
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
			};
			if (isInteractive && parsedArgs.mpreset) {
				const ready = Promise.withResolvers<void>();
				session.extendStartupTurnBarrier(ready.promise);
				startDeferredModelProfiles = async () => {
					try {
						const result = await applyDeferredStartupModelProfilesForRoot(profileArgs);
						await startDeferredMemoryBackend?.();
						ready.resolve();
						return result;
					} catch (error) {
						ready.reject(error);
						throw error;
					}
				};
			} else {
				const { recoverableErrors } = await applyStartupModelProfilesForRoot(profileArgs);
				await startDeferredMemoryBackend?.();
				for (const recoverableError of recoverableErrors) {
					notifs.push({ kind: "error", message: recoverableError });
				}
			}
		}

		if (modelFallbackMessage && shouldNotifyModelFallback(parsedArgs.authBootstrap, isInteractive)) {
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
			const timingEnv = $pickenv("GJC_TIMING", "PI_TIMING");
			const exitForTiming = timingEnv === "x";
			let changelogMarkdown: string | undefined;
			try {
				startupUpdate.startBeforeInteractiveInitialization();
				changelogMarkdown = await logger.time(
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

				if (timingEnv && !exitForTiming) {
					logger.printTimings();
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
						startDeferredMcpConfig,
						startDeferredModelProfiles,
					);
				}
			} catch (error) {
				try {
					await session.dispose();
				} catch {
					logger.warn("Failed to dispose session after interactive error");
				}
				if (error !== null && typeof error === "object" && "code" in error && error.code === "cancelled") {
					return;
				}
				throw error;
			}

			if (exitForTiming) {
				// GJC_TIMING=x measures through the first transcript paint, so the
				// cold-start number includes interactive init and time-to-first-render.
				// The probe's deliverable is the timing report: a mode boot or teardown
				// failure is logged, but session disposal still precedes the exit (the
				// contract under startup-update-contract) and the report still prints.
				// This block sits outside the try/catch so the mock-throwing exit in
				// tests cannot unwind into a second disposal.
				try {
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
						startDeferredMcpConfig,
						startDeferredModelProfiles,
						{ stopAfterFirstPaint: true },
					);
				} catch (error) {
					logger.warn("Timing probe interactive boot failed", { error: String(error) });
				}
				// Report before teardown so Total ends at first paint, not at the end
				// of session persistence and resource cleanup.
				logger.printTimings();
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
				if ($pickenv("GJC_TIMING", "PI_TIMING")) {
					logger.printTimings();
				}
			} finally {
				stopThemeWatcher();
				authStorage.close();
				if (!deps.suppressProcessExit) await postmortem.cleanup();
			}
			if (!deps.suppressProcessExit) {
				await (deps.quit ?? postmortem.quit)(typeof process.exitCode === "number" ? process.exitCode : 0);
			}
		}
	}
}

export async function main(args: string[]): Promise<void> {
	if (args.length === 1 && args[0] === TMUX_OWNER_ISOLATION_ARG) {
		const { runTmuxOwnerIsolationCliFromStdin } = await import("./gjc-runtime/tmux-owner-isolation-cli");
		await runTmuxOwnerIsolationCliFromStdin();
		return;
	}
	if (args[0] === MANAGED_OWNER_SUPERVISOR_ARG) {
		const { runManagedOwnerSupervisor } = await import("./gjc-runtime/managed-owner-supervisor");
		await runManagedOwnerSupervisor(args);
		return;
	}
	if (process.env[MANAGED_OWNER_CHILD_TOKEN_ENV] !== undefined) {
		const { admitManagedOwnerBeforeCli, completeManagedOwnerRecovery } = await import(
			"./gjc-runtime/managed-owner-admission"
		);
		const admission = await admitManagedOwnerBeforeCli();
		if (admission.kind === "blocked") return;
		if (admission.kind === "recovery") {
			await completeManagedOwnerRecovery(admission.context);
			return;
		}
	}
	const { runCli } = await import("./cli");
	await runCli(args.length === 0 ? ["launch"] : args);
}
