/**
 * Notify CLI command handlers.
 *
 * Handles `gjc notify` setup/status and the hidden daemon entrypoint.
 */
import { createInterface } from "node:readline/promises";
import { APP_NAME } from "@gajae-code/utils/dirs";
import chalk from "chalk";
import { Settings, type SettingsAtomicPatch } from "../config/settings";
import { SessionIndex } from "../sdk/broker/session-index";
import {
	ChatDaemonController,
	type EnsureChatDaemonResult,
	ensureDiscordDaemon,
	ensureSlackDaemon,
} from "../sdk/bus/chat-daemon-control";
import { getNotificationConfig, maskToken, tokenFingerprint } from "../sdk/bus/config";
import { type ActivatedPreparedSession, activatePreparedSession } from "../sdk/bus/existing-thread-readiness";
import {
	clearTelegramActivationMarker,
	createTelegramActivationMarker,
	mutateNotificationProvider,
	type NotificationProviderRuntimeAuthority,
	observedTelegramActivationMarker,
	type ProposedTelegramIdentity,
	persistTelegramActivationMarker,
	proposedTelegramIdentity,
	reconcileCommittedTelegramConfiguration,
} from "../sdk/bus/notification-orchestration";
import {
	buildNotificationStatusReport,
	checkNotificationHealth,
	formatNotificationHealthReport,
	formatNotificationRecoveryReport,
	formatNotificationStatusReport,
	formatNotificationTestResult,
	recoverNotifications,
	sanitizeDiagnostic,
	sendNotificationTest,
} from "../sdk/bus/notification-service";
import {
	type BoundSlackThread,
	bindConfiguredSlackThread,
	isBoundedSlackRootTs,
	SlackThreadBindingError,
} from "../sdk/bus/slack-thread-binding";
import {
	type EnsureTelegramDaemonDetailedResult,
	ensureTelegramDaemonRunningDetailed,
	resolveTelegramSetupPreflight,
} from "../sdk/bus/telegram-daemon";
import { runDaemonInternal } from "../sdk/bus/telegram-daemon-cli";
import { TelegramDaemonController } from "../sdk/bus/telegram-daemon-control";
import {
	runTelegramSetup as runTelegramPairingSetup,
	type TelegramSetupPreflight,
	type TelegramSetupTimers,
} from "../sdk/bus/telegram-setup";

export type NotifyAction =
	| "setup"
	| "status"
	| "health"
	| "test"
	| "recovery"
	| "bind-thread"
	| "activate-thread"
	| "daemon-internal";
export type NotifySetupProvider = "telegram" | "discord" | "slack";

export interface NotifyCommandArgs {
	action: NotifyAction;
	smoke?: boolean;
	rawArgs: string[];
	provider?: NotifySetupProvider;
	token?: string;
	chatId?: string;
	discordBotToken?: string;
	discordApplicationId?: string;
	discordGuildId?: string;
	discordParentChannelId?: string;
	slackBotToken?: string;
	slackAppToken?: string;
	slackWorkspaceId?: string;
	slackChannelId?: string;
	slackAuthorizedUserId?: string;
	redact?: boolean;
	forceDaemonLock?: boolean;
	probe?: boolean;
	message?: string;
	sessionId?: string;
	threadTs?: string;
}

export interface NotifyCommandDeps {
	fetchImpl?: typeof fetch;
	apiBase?: string;
	settings?: Settings;
	setupToken?: string;
	pollTimeoutMs?: number;
	pollIntervalMs?: number;
	setupChatId?: string;
	setupRedact?: boolean;
	setupInteractive?: boolean;
	threadedModePrompt?: (message: string) => Promise<string>;
	tokenPrompt?: () => Promise<string>;
	setExitCode?: (code: number) => void;
	exitProcess?: (code: number) => void;
	valuePrompt?: (label: string, masked: boolean) => Promise<string>;
	/** Optional daemon ownership facts collected by an embedding host. */
	setupPreflight?: TelegramSetupPreflight;
	/** Injectable timers and cancellation for setup pairing. */
	setupTimers?: TelegramSetupTimers;
	setupAbortSignal?: AbortSignal;
	setupPidAlive?: (pid: number) => boolean;
	/** Injectable process-start provenance reader for ambient Telegram setup preflight. */
	setupPidIncarnation?: (pid: number) => string | undefined;
	ensureProviderDaemon?: (provider: "discord" | "slack", settings: Settings) => Promise<EnsureChatDaemonResult>;
	ensureTelegramDaemon?: (settings: Settings) => Promise<EnsureTelegramDaemonDetailedResult>;
	bindSlackThread?: (input: { settings: Settings; sessionId: string; threadTs: string }) => Promise<BoundSlackThread>;
	activatePreparedSession?: (input: { settings: Settings; sessionId: string }) => Promise<ActivatedPreparedSession>;
}

export function parseNotifyArgs(args: string[]): NotifyCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "notify") return undefined;
	const action = args[1];
	const providerValue = (value: string | undefined): NotifySetupProvider | undefined =>
		value === "telegram" || value === "discord" || value === "slack" ? value : undefined;
	const parseFlags = (
		rest: string[],
		valueFlags: ReadonlySet<string>,
		booleanFlags: ReadonlySet<string>,
	): Map<string, string | true> | undefined => {
		const parsed = new Map<string, string | true>();
		for (let index = 0; index < rest.length; index++) {
			const flag = rest[index];
			if (!flag?.startsWith("--") || parsed.has(flag)) return undefined;
			if (booleanFlags.has(flag)) {
				parsed.set(flag, true);
				continue;
			}
			if (!valueFlags.has(flag)) return undefined;
			const value = rest[++index];
			if (!value || value.startsWith("--")) return undefined;
			parsed.set(flag, value);
		}
		return parsed;
	};

	if (action === "setup") {
		const rest = args.slice(2);
		const positional = rest[0]?.startsWith("--") ? undefined : rest.shift();
		const provider = positional === undefined ? undefined : providerValue(positional);
		if (positional !== undefined && !provider) return undefined;
		const flags = parseFlags(
			rest,
			new Set([
				"--token",
				"--chat-id",
				"--discord-bot-token",
				"--discord-application-id",
				"--discord-guild-id",
				"--discord-parent-channel-id",
				"--slack-bot-token",
				"--slack-app-token",
				"--slack-workspace-id",
				"--slack-channel-id",
				"--slack-authorized-user-id",
			]),
			new Set(["--redact"]),
		);
		if (!flags) return undefined;
		const value = (name: string): string | undefined => {
			const found = flags.get(name);
			return typeof found === "string" ? found : undefined;
		};
		return {
			action,
			rawArgs: args.slice(2),
			...(provider ? { provider } : {}),
			token: value("--token"),
			chatId: value("--chat-id"),
			discordBotToken: value("--discord-bot-token"),
			discordApplicationId: value("--discord-application-id"),
			discordGuildId: value("--discord-guild-id"),
			discordParentChannelId: value("--discord-parent-channel-id"),
			slackBotToken: value("--slack-bot-token"),
			slackAppToken: value("--slack-app-token"),
			slackWorkspaceId: value("--slack-workspace-id"),
			slackChannelId: value("--slack-channel-id"),
			slackAuthorizedUserId: value("--slack-authorized-user-id"),
			redact: flags.get("--redact") === true,
		};
	}
	if (action === "status") {
		return args.length === 2 ? { action, rawArgs: [] } : undefined;
	}
	if (action === "health" || action === "test") {
		const rest = args.slice(2);
		const flags = parseFlags(
			rest,
			new Set(action === "health" ? ["--provider"] : ["--provider", "--message"]),
			new Set(action === "health" ? ["--probe"] : []),
		);
		if (!flags) return undefined;
		const rawProvider = flags.get("--provider");
		const provider = typeof rawProvider === "string" ? providerValue(rawProvider) : undefined;
		if (rawProvider !== undefined && !provider) return undefined;
		return {
			action,
			rawArgs: rest,
			...(provider ? { provider } : {}),
			probe: flags.get("--probe") === true,
			message: typeof flags.get("--message") === "string" ? (flags.get("--message") as string) : undefined,
		};
	}
	if (action === "recovery") {
		const flags = parseFlags(args.slice(2), new Set(), new Set(["--force-daemon-lock"]));
		return flags
			? { action, rawArgs: args.slice(2), forceDaemonLock: flags.get("--force-daemon-lock") === true }
			: undefined;
	}
	if (action === "bind-thread") {
		const rest = args.slice(2);
		const flags = parseFlags(rest, new Set(["--session-id", "--thread-ts"]), new Set());
		if (!flags) return undefined;
		const sessionId = flags.get("--session-id");
		const threadTs = flags.get("--thread-ts");
		if (typeof sessionId !== "string" || typeof threadTs !== "string") return undefined;
		return { action, rawArgs: rest, sessionId, threadTs };
	}
	if (action === "activate-thread") {
		const rest = args.slice(2);
		const flags = parseFlags(rest, new Set(["--session-id"]), new Set());
		if (!flags) return undefined;
		const sessionId = flags.get("--session-id");
		if (typeof sessionId !== "string") return undefined;
		return { action, rawArgs: rest, sessionId };
	}
	if (action === "daemon-internal") {
		return {
			action,
			smoke: args.slice(2).includes("--smoke"),
			rawArgs: args.slice(2),
		};
	}
	return undefined;
}

export async function runNotifyCommand(cmd: NotifyCommandArgs, deps: NotifyCommandDeps = {}): Promise<void> {
	switch (cmd.action) {
		case "setup":
			await runSetup(cmd, {
				...deps,
				setupToken: deps.setupToken ?? cmd.token,
				setupChatId: deps.setupChatId ?? cmd.chatId,
				setupRedact: deps.setupRedact ?? cmd.redact,
			});
			return;
		case "status":
			await runStatus(deps);
			return;
		case "health":
			await runHealth(deps, cmd);
			return;
		case "test":
			await runTest(deps, cmd);
			return;
		case "recovery":
			await runRecovery(deps, cmd.forceDaemonLock);
			return;
		case "bind-thread":
			await runBindThread(cmd, deps);
			return;
		case "activate-thread":
			await runActivateThread(cmd, deps);
			return;
		case "daemon-internal":
			if (cmd.smoke) {
				await runDaemonInternal(["--smoke"]);
			} else {
				await runDaemonInternal(cmd.rawArgs);
			}
			return;
	}
}

export async function runNotifyCliCommand(cmd: NotifyCommandArgs, deps: NotifyCommandDeps = {}): Promise<void> {
	try {
		await runNotifyCommand(cmd, deps);
	} catch (error) {
		if (cmd.action !== "setup" || !(error instanceof Error)) {
			throw error;
		}

		const cancelled =
			error.message === "Telegram bot token prompt cancelled." || error.message === "Telegram setup cancelled.";
		process.stderr.write(cancelled ? "Notify setup cancelled.\n" : `Error: ${error.message}\n`);
		const code = cancelled ? 130 : 1;
		if (deps.setExitCode) {
			deps.setExitCode(code);
		} else {
			process.exitCode = code;
		}
		const exitProcess = deps.exitProcess ?? (deps.setExitCode ? undefined : process.exit);
		exitProcess?.(code);
	}
}

async function getSettings(deps: NotifyCommandDeps): Promise<Settings> {
	if (deps.settings) return deps.settings;
	return await Settings.init();
}

async function runSetup(cmd: NotifyCommandArgs, deps: NotifyCommandDeps): Promise<void> {
	const provider = cmd.provider ?? "telegram";
	if (provider === "discord") {
		await runDiscordSetup(cmd, deps);
		return;
	}
	if (provider === "slack") {
		await runSlackSetup(cmd, deps);
		return;
	}
	await runTelegramSetup(cmd, deps);
}

function requiredSetupValue(value: string | undefined, flag: string): string {
	if (!value?.trim()) throw new Error(`${flag} is required for non-interactive setup.`);
	if (value.trim().startsWith("--")) throw new Error(`${flag} must not start with --.`);
	return value.trim();
}

async function promptSetupValue(
	value: string | undefined,
	flag: string,
	masked: boolean,
	deps: NotifyCommandDeps,
): Promise<string> {
	if (value?.trim()) return requiredSetupValue(value, flag);
	if (!resolveSetupInteractive(deps)) return requiredSetupValue(value, flag);
	return requiredSetupValue(await (deps.valuePrompt ?? promptForValue)(`${flag.slice(2)}: `, masked), flag);
}

async function runDiscordSetup(cmd: NotifyCommandArgs, deps: NotifyCommandDeps): Promise<void> {
	const botToken = await promptSetupValue(cmd.discordBotToken, "--discord-bot-token", true, deps);
	const applicationId = await promptSetupValue(cmd.discordApplicationId, "--discord-application-id", false, deps);
	const guildId = await promptSetupValue(cmd.discordGuildId, "--discord-guild-id", false, deps);
	const parentChannelId = await promptSetupValue(
		cmd.discordParentChannelId,
		"--discord-parent-channel-id",
		false,
		deps,
	);
	const settings = await getSettings(deps);
	let activationFailure: string | undefined;
	let activationOutcome: EnsureChatDaemonResult | undefined;
	const runtime: NotificationProviderRuntimeAuthority = {
		activate: async provider => {
			if (provider !== "discord") throw new Error("Unexpected provider activation request.");
			try {
				const result = await ensureConfiguredProviderDaemon("discord", settings, deps);
				if (result === "disabled") throw new Error("Discord runtime did not activate.");
				activationOutcome = result;
			} catch (error) {
				activationFailure = error instanceof Error ? error.message : "Discord runtime activation failed.";
				throw error;
			}
		},
		deactivate: async () => undefined,
	};
	const result = await mutateNotificationProvider({
		settings,
		mutation: {
			provider: "discord",
			botToken: { action: "replace", value: botToken },
			applicationId,
			guildId,
			parentChannelId,
		},
		configureAndActivate: true,
		...(cmd.redact ? { redact: true } : {}),
		runtime,
	});
	if (result.status === "commit_failed")
		throw new Error("Discord configuration was not saved because the CAS commit failed.");
	if (result.status !== "activated") {
		const detail = `runtime activation failed: ${activationFailure ?? result.status}`;
		process.stderr.write(`Discord configuration saved, but ${detail}.\n`);
		if (deps.setExitCode) deps.setExitCode(1);
		else process.exitCode = 1;
		return;
	}
	process.stdout.write(
		`Discord configuration saved and activated. botToken=${maskToken(botToken)} applicationId=${applicationId} guildId=${guildId} parentChannelId=${parentChannelId} daemon=${activationOutcome ?? "attached"}\n`,
	);
}

async function runSlackSetup(cmd: NotifyCommandArgs, deps: NotifyCommandDeps): Promise<void> {
	const botToken = await promptSetupValue(cmd.slackBotToken, "--slack-bot-token", true, deps);
	const appToken = await promptSetupValue(cmd.slackAppToken, "--slack-app-token", true, deps);
	const workspaceId = await promptSetupValue(cmd.slackWorkspaceId, "--slack-workspace-id", false, deps);
	const channelId = await promptSetupValue(cmd.slackChannelId, "--slack-channel-id", false, deps);
	const authorizedUserId = cmd.slackAuthorizedUserId?.trim() || undefined;
	const settings = await getSettings(deps);
	let activationFailure: string | undefined;
	let activationOutcome: EnsureChatDaemonResult | undefined;
	const runtime: NotificationProviderRuntimeAuthority = {
		activate: async provider => {
			if (provider !== "slack") throw new Error("Unexpected provider activation request.");
			try {
				const result = await ensureConfiguredProviderDaemon("slack", settings, deps);
				if (result === "disabled") throw new Error("Slack runtime did not activate.");
				activationOutcome = result;
			} catch (error) {
				activationFailure = error instanceof Error ? error.message : "Slack runtime activation failed.";
				throw error;
			}
		},
		deactivate: async () => undefined,
	};
	const result = await mutateNotificationProvider({
		settings,
		mutation: {
			provider: "slack",
			botToken: { action: "replace", value: botToken },
			appToken: { action: "replace", value: appToken },
			workspaceId,
			channelId,
			authorizedUserId,
		},
		configureAndActivate: true,
		...(cmd.redact ? { redact: true } : {}),
		runtime,
	});
	if (result.status === "commit_failed")
		throw new Error("Slack configuration was not saved because the CAS commit failed.");
	if (result.status !== "activated") {
		const detail = `runtime activation failed: ${activationFailure ?? result.status}`;
		process.stderr.write(`Slack configuration saved, but ${detail}.\n`);
		if (deps.setExitCode) deps.setExitCode(1);
		else process.exitCode = 1;
		return;
	}
	process.stdout.write(
		`Slack configuration saved and activated. botToken=${maskToken(botToken)} appToken=${maskToken(appToken)} workspaceId=${workspaceId} channelId=${channelId} authorizedUserId=${authorizedUserId ?? "(unset; inbound denied)"} daemon=${activationOutcome ?? "attached"}\n`,
	);
}

async function ensureConfiguredProviderDaemon(
	provider: "discord" | "slack",
	settings: Settings,
	deps: NotifyCommandDeps,
): Promise<EnsureChatDaemonResult> {
	try {
		if (deps.ensureProviderDaemon) return await deps.ensureProviderDaemon(provider, settings);
		return provider === "discord" ? await ensureDiscordDaemon(settings) : await ensureSlackDaemon(settings);
	} catch (error) {
		const cfg = getNotificationConfig(settings);
		const detail = sanitizeDiagnostic(
			sanitizeDiagnostic(
				error instanceof Error ? error.message : String(error),
				provider === "discord" ? cfg.discord.botToken : cfg.slack.appToken,
			),
			provider === "discord" ? cfg.discord.botToken : cfg.slack.botToken,
		);
		throw new Error(`${provider === "discord" ? "Discord" : "Slack"} daemon did not become ready: ${detail}`, {
			cause: error,
		});
	}
}

async function runTelegramSetup(cmd: NotifyCommandArgs, deps: NotifyCommandDeps): Promise<void> {
	const settings = await getSettings(deps);
	const token = deps.setupToken ?? cmd.token ?? (await (deps.tokenPrompt ?? promptForToken)());
	if (!token.trim()) throw new Error("Telegram bot token is required.");

	const result = await runTelegramPairingSetup({
		token,
		preflight: deps.setupPreflight ?? (await resolveSetupPreflight(settings, deps)),
		revalidatePreflight: async () => deps.setupPreflight ?? (await resolveSetupPreflight(settings, deps)),
		chatId: deps.setupChatId,
		interactive: resolveSetupInteractive(deps),
		threadedModePrompt: deps.threadedModePrompt ?? promptForThreadedMode,
		pollTimeoutMs: deps.pollTimeoutMs,
		pollIntervalMs: deps.pollIntervalMs,
		signal: deps.setupAbortSignal,
		deps: {
			fetchImpl: deps.fetchImpl ?? globalThis.fetch,
			apiBase: deps.apiBase,
			timers: deps.setupTimers,
		},
		onEvent: event => {
			const output = event.kind === "rejected_chat" ? process.stderr : process.stdout;
			output.write(event.message);
		},
	});
	if (!result.ok) throw new Error(result.detail);
	if (result.pairingSource === "provided") {
		process.stdout.write(`Using provided chat id ${result.chatId} (non-interactive).\n`);
	}
	let settingsCommitted = false;
	let commitAttempted = false;
	try {
		const proposedIdentity = deps.setupPreflight
			? proposedIdentityFromSetupPreflight(deps.setupPreflight, token.trim(), result.chatId)
			: await proposedTelegramIdentity({
					settings,
					botToken: token.trim(),
					chatId: result.chatId,
					chatDisplay: result.chatId,
				});
		if (proposedIdentity.status === "foreign" || proposedIdentity.status === "unknown") {
			throw new Error(
				"Telegram activation was not saved because the current daemon owner has an untrusted identity.",
			);
		}

		const inactiveMarkerToClear = observedTelegramActivationMarker(settings, token.trim(), result.chatId);
		const patches: SettingsAtomicPatch[] = [
			{ path: "notifications.telegram.botToken", op: "set", value: token.trim() },
			{ path: "notifications.telegram.chatId", op: "set", value: result.chatId },
			{ path: "notifications.enabled", op: "set", value: true },
			{ path: "notifications.telegram.enabled", op: "set", value: true },
		];
		if (deps.setupRedact ?? cmd.redact) patches.push({ path: "notifications.redact", op: "set", value: true });
		commitAttempted = true;
		const receipt = await settings.commitAtomicBatch(patches);
		settingsCommitted = true;
		const activationMarker = createTelegramActivationMarker({
			botToken: token.trim(),
			chatId: result.chatId,
			state: "blocked",
			reason: "identity_mismatch",
		});
		const activation = await reconcileCommittedTelegramConfiguration({
			receipt,
			inactiveMarkerToClear,
			activation: {
				// The CLI does not host a session endpoint. The settings editor supplies
				// its live controller here; a CLI identity block therefore has no local
				// endpoint to stop before the durable rollback below.
				controller: {
					enterBlockedRuntime: async () => undefined,
					clearBlockedRuntime: async () => undefined,
					reconcileCurrentSession: async () => undefined,
				},
				reconnect: async () =>
					deps.ensureTelegramDaemon
						? await deps.ensureTelegramDaemon(settings)
						: await ensureTelegramDaemonRunningDetailed({
								settings,
								cwd: process.cwd(),
								sessionId: `notify-cli-${process.pid}`,
								registerRoot: false,
							}),
				persistInactive: async marker => await persistTelegramActivationMarker(settings, marker),
				clearInactive: async marker => await clearTelegramActivationMarker(settings, marker),
				marker: activationMarker,
			},
		});
		if (activation.status === "blocked_identity") {
			const restored = await activation.restore();
			if (restored.status === "restored" || restored.status === "still_blocked") settingsCommitted = false;
			const detail =
				restored.status === "restored"
					? "Telegram activation was blocked by a foreign daemon; previous settings were restored."
					: restored.status === "still_blocked"
						? "Telegram activation remains blocked by a foreign daemon; previous settings were restored."
						: restored.status === "conflict"
							? "Telegram activation was blocked and settings changed concurrently; refusing to report setup success."
							: "Telegram activation was blocked; refusing to report setup success.";
			throw new Error(detail);
		}
		if (activation.status === "activation_failed") {
			receipt.discard();
			throw new Error(activation.message);
		}
		receipt.discard();
	} catch (error) {
		const detail = sanitizeDiagnostic(error instanceof Error ? error.message : "unknown persistence failure", token);
		// The wording must describe what a follow-up `notify status` will show. A failure
		// raised after the durable write landed — including one raised from inside the
		// commit itself — must not claim the settings were not persisted, or the operator
		// walks away believing Telegram is off while the daemon is armed for that token.
		// Observed state wins; the code-path flag is only the fallback for an unreadable read.
		const observed = telegramIntentIsPersisted(settings, token.trim(), result.chatId);
		const persisted = observed ?? settingsCommitted;
		// A commit that was entered and then failed, whose durable state is also unreadable,
		// is genuinely undecided: `commitAtomicBatch` can persist and still throw. Claiming
		// either outcome would be a guess, so say so and point at the authoritative check.
		if (!persisted && observed === undefined && commitAttempted) {
			throw new Error(
				"Telegram notification settings may or may not have been saved, and the stored configuration could not be read; " +
					`run \`gjc notify status\` before retrying: ${detail}`,
			);
		}
		throw new Error(
			persisted
				? `Telegram notification settings were saved, but activation or recovery failed: ${detail}`
				: `Unable to persist and activate Telegram notification settings: ${detail}`,
		);
	}
	process.stdout.write(
		`Notifications enabled. botToken=${maskToken(token)} chatId=${result.chatId} threaded=${result.threadedLabel}\n`,
	);
}

/**
 * Whether the durable settings already carry the Telegram intent this setup run attempted to
 * write: the same identity *and* the enabled state it would have produced. Matching the token
 * and chat id alone is not enough — a previously disabled configuration can already hold both,
 * and a commit that fails before enabling Telegram has persisted nothing new.
 *
 * Returns `undefined` when the durable state cannot be observed, so the caller can fall back
 * instead of reporting a state nobody read.
 */
function telegramIntentIsPersisted(settings: Settings, botToken: string, chatId: string): boolean | undefined {
	try {
		const cfg = getNotificationConfig(settings);
		return (
			cfg.enabled === true && cfg.telegram?.enabled === true && cfg.botToken === botToken && cfg.chatId === chatId
		);
	} catch {
		return undefined;
	}
}

function proposedIdentityFromSetupPreflight(
	preflight: TelegramSetupPreflight,
	botToken: string,
	chatId: string,
): ProposedTelegramIdentity {
	const daemon = preflight.daemon;
	if (!daemon?.live) return { status: "absent" };
	if (typeof daemon.tokenFingerprint !== "string" || typeof daemon.chatId !== "string") {
		return { status: "unknown" };
	}
	return daemon.tokenFingerprint === tokenFingerprint(botToken) && daemon.chatId === chatId
		? { status: "same" }
		: { status: "foreign" };
}

async function resolveSetupPreflight(settings: Settings, deps: NotifyCommandDeps): Promise<TelegramSetupPreflight> {
	if (deps.setupPreflight) return deps.setupPreflight;
	return await resolveTelegramSetupPreflight(settings, {
		pidAlive: deps.setupPidAlive,
		pidIncarnation: deps.setupPidIncarnation,
	});
}

type TokenPromptInput = NodeJS.ReadStream & {
	isRaw?: boolean;
	setRawMode?: (mode: boolean) => unknown;
	pause?: () => unknown;
};

type TokenPromptOutput = Pick<NodeJS.WriteStream, "write">;

async function promptForMaskedValue(
	label: string,
	input: TokenPromptInput = process.stdin,
	output: TokenPromptOutput = process.stdout,
): Promise<string> {
	if (!input.isTTY) {
		throw new Error("notify setup requires an interactive TTY unless setupToken is injected.");
	}
	if (typeof input.setRawMode !== "function") {
		throw new Error("notify setup requires a TTY with raw input support unless setupToken is injected.");
	}

	output.write(label);
	const wasRaw = input.isRaw === true;
	input.setRawMode(true);

	return await new Promise<string>((resolve, reject) => {
		let value = "";
		let settled = false;

		const cleanup = () => {
			input.off("data", onData);
			input.off("error", onError);
			input.setRawMode?.(wasRaw);
			input.pause?.();
			output.write("\n");
		};

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};

		const accept = () => finish(() => resolve(value.trim()));
		const cancel = () => finish(() => reject(new Error("Telegram bot token prompt cancelled.")));
		const onError = (error: Error) => finish(() => reject(error));
		const onData = (chunk: Buffer | string) => {
			for (const char of String(chunk)) {
				if (char === "\r" || char === "\n") {
					accept();
					return;
				}
				if (char === "\u0003") {
					cancel();
					return;
				}
				if (char === "\u0004") {
					if (value) accept();
					else cancel();
					return;
				}
				if (char === "\u007f" || char === "\b") {
					value = value.slice(0, -1);
					continue;
				}
				if (char >= " ") value += char;
			}
		};

		input.on("data", onData);
		input.once("error", onError);
		input.resume();
	});
}

export async function promptForToken(
	input: TokenPromptInput = process.stdin,
	output: TokenPromptOutput = process.stdout,
): Promise<string> {
	return await promptForMaskedValue("Telegram BotFather token: ", input, output);
}

async function promptForValue(label: string, masked: boolean): Promise<string> {
	if (masked) return await promptForMaskedValue(label);
	if (!process.stdin.isTTY) {
		throw new Error("notify setup requires an interactive TTY unless all setup values are supplied as flags.");
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	try {
		return (await rl.question(label)).trim();
	} finally {
		rl.close();
	}
}

function resolveSetupInteractive(deps: NotifyCommandDeps): boolean {
	if (deps.setupInteractive !== undefined) return deps.setupInteractive;
	return Boolean(process.stdin.isTTY) && !deps.setupChatId?.trim();
}

async function promptForThreadedMode(message: string): Promise<string> {
	if (!process.stdin.isTTY) return "skip";
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	try {
		return (await rl.question(message)).trim();
	} finally {
		rl.close();
	}
}

async function runStatus(deps: NotifyCommandDeps): Promise<void> {
	const settings = await getSettings(deps);
	const report = buildNotificationStatusReport(settings);
	process.stdout.write(
		`${chalk.bold("Notifications")}\n${formatNotificationStatusReport(report).split("\n").slice(1).join("\n")}\n`,
	);
}

async function runHealth(deps: NotifyCommandDeps, cmd: NotifyCommandArgs): Promise<void> {
	const settings = await getSettings(deps);
	const report = await checkNotificationHealth({
		settings,
		provider: cmd.provider,
		probe: cmd.probe,
		deps: { fetchImpl: deps.fetchImpl, apiBase: deps.apiBase },
	});
	process.stdout.write(`${formatNotificationHealthReport(report)}\n`);
	if (report.overall === "error" && deps.setExitCode) deps.setExitCode(1);
	else if (report.overall === "error") process.exitCode = 1;
}

async function runTest(deps: NotifyCommandDeps, cmd: NotifyCommandArgs): Promise<void> {
	const settings = await getSettings(deps);
	const result = await sendNotificationTest({
		settings,
		provider: cmd.provider,
		text: cmd.message,
		deps: {
			fetchImpl: deps.fetchImpl,
			apiBase: deps.apiBase,
			providerRuntimeStatus: async provider => {
				const status =
					provider === "telegram"
						? await new TelegramDaemonController(settings).status()
						: await new ChatDaemonController(settings, provider).status();
				return status.health === "running" ? "ready" : "inactive";
			},
		},
	});
	process.stdout.write(`${formatNotificationTestResult(result)}\n`);
	if (!result.ok && deps.setExitCode) deps.setExitCode(1);
	else if (!result.ok) process.exitCode = 1;
}

async function runRecovery(deps: NotifyCommandDeps, forceDaemonLock = false): Promise<void> {
	const settings = await getSettings(deps);
	const report = await recoverNotifications({ settings, forceDaemonLock });
	process.stdout.write(`${formatNotificationRecoveryReport(report)}\n`);
}

/** Target and credential inputs stay owned by `notify setup`; binding never re-routes a session elsewhere. */
const BIND_THREAD_REJECTED_INPUTS: readonly (keyof NotifyCommandArgs)[] = [
	"provider",
	"token",
	"chatId",
	"discordBotToken",
	"discordApplicationId",
	"discordGuildId",
	"discordParentChannelId",
	"slackBotToken",
	"slackAppToken",
	"slackWorkspaceId",
	"slackChannelId",
	"slackAuthorizedUserId",
	"message",
	"probe",
	"redact",
	"forceDaemonLock",
	"smoke",
];

export interface BindThreadInvocation {
	sessionId: string;
	threadTs: string;
}

/**
 * Enforce the exact `bind-thread` grammar at every entrypoint.
 *
 * The command accepts only a session and a root; a positional argument, an
 * unrelated notify flag, or a target/credential input is a rejection rather than
 * something silently ignored, so no other invocation shape can reach the
 * binding authority.
 */
export function assertStrictBindThreadInvocation(cmd: NotifyCommandArgs): BindThreadInvocation {
	const rejected = BIND_THREAD_REJECTED_INPUTS.filter(key => {
		const value = cmd[key];
		return value !== undefined && value !== false && value !== "";
	});
	if (rejected.length > 0)
		throw new Error(
			`notify bind-thread accepts only --session-id and --thread-ts (rejected: ${rejected.join(", ")}).`,
		);
	const { sessionId, threadTs } = cmd;
	if (!sessionId || !threadTs) throw new Error("notify bind-thread requires --session-id and --thread-ts.");
	const allowed = new Set(["--session-id", sessionId, "--thread-ts", threadTs]);
	const stray = cmd.rawArgs.filter(token => !allowed.has(token));
	if (stray.length > 0)
		throw new Error(`notify bind-thread does not accept additional arguments (rejected: ${stray.join(", ")}).`);
	if (!isBoundedSlackRootTs(threadTs))
		throw new SlackThreadBindingError(
			"invalid_root",
			"Slack root timestamp must be a bounded <seconds>.<fraction> message timestamp.",
		);
	return { sessionId, threadTs };
}

/** Adopt an existing Slack thread for a live session; the operator supplies only session and root identity. */
async function runBindThread(cmd: NotifyCommandArgs, deps: NotifyCommandDeps): Promise<void> {
	const { sessionId, threadTs } = assertStrictBindThreadInvocation(cmd);
	const bind = deps.bindSlackThread ?? (input => bindConfiguredSlackThread(input));
	const bound = await bind({ settings: await getSettings(deps), sessionId, threadTs });
	process.stdout.write(`${formatBoundSlackThread(bound)}\n`);
}

/** Confirmation carries identifiers only: no tokens, message bodies, or control secrets. */
export function formatBoundSlackThread(bound: BoundSlackThread): string {
	return [
		`${chalk.green("Bound")} Slack thread for session ${bound.sessionId}`,
		`  session generation: ${bound.endpointGeneration}`,
		`  workspace/channel:  ${bound.teamId}/${bound.channelId}`,
		`  thread root:        ${bound.rootTs}`,
		`  daemon owner:       ${bound.ownerId} (generation ${bound.daemonGeneration})`,
	].join("\n");
}

/** Activation carries only a session; a root or target here is a rejection, not an override. */
const ACTIVATE_THREAD_REJECTED_INPUTS: readonly (keyof NotifyCommandArgs)[] = [
	...BIND_THREAD_REJECTED_INPUTS,
	"threadTs",
];

export interface ActivateThreadInvocation {
	sessionId: string;
}

/**
 * Enforce the exact `activate-thread` grammar at every entrypoint.
 *
 * Activation names one prepared session and nothing else: the root it adopts is
 * already the applied binding, so a supplied root, target, or credential is a
 * rejection rather than something silently ignored.
 */
export function assertStrictActivateThreadInvocation(cmd: NotifyCommandArgs): ActivateThreadInvocation {
	const rejected = ACTIVATE_THREAD_REJECTED_INPUTS.filter(key => {
		const value = cmd[key];
		return value !== undefined && value !== false && value !== "";
	});
	if (rejected.length > 0)
		throw new Error(`notify activate-thread accepts only --session-id (rejected: ${rejected.join(", ")}).`);
	const { sessionId } = cmd;
	if (!sessionId) throw new Error("notify activate-thread requires --session-id.");
	const allowed = new Set(["--session-id", sessionId]);
	const stray = cmd.rawArgs.filter(token => !allowed.has(token));
	if (stray.length > 0)
		throw new Error(`notify activate-thread does not accept additional arguments (rejected: ${stray.join(", ")}).`);
	return { sessionId };
}

/**
 * Publish the readiness a prepared session withheld.
 *
 * The session's own host owns the decision: this command only proves discovery
 * authority and asks it to activate, so activation before a binding exists is
 * refused by the session rather than forced by the operator.
 */
async function runActivateThread(cmd: NotifyCommandArgs, deps: NotifyCommandDeps): Promise<void> {
	const { sessionId } = assertStrictActivateThreadInvocation(cmd);
	const activate =
		deps.activatePreparedSession ??
		(async (input: { settings: Settings; sessionId: string }) =>
			await activatePreparedSession({
				sessionIndex: await new SessionIndex(input.settings.getAgentDir()).open(),
				sessionId: input.sessionId,
			}));
	const activated = await activate({ settings: await getSettings(deps), sessionId });
	process.stdout.write(`${formatActivatedSession(activated)}\n`);
}

/** Confirmation carries identifiers only: no endpoints, tokens, or thread content. */
export function formatActivatedSession(activated: ActivatedPreparedSession): string {
	return [
		`${chalk.green("Activated")} session ${activated.sessionId} (${activated.status})`,
		`  session generation: ${activated.endpointGeneration}`,
	].join("\n");
}

export function printNotifyHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} notify`)} - Configure Telegram, Discord, or Slack notifications

${chalk.bold("Interactive path:")}
  In a running GJC session, use /settings → Notifications for first-class Telegram, Discord,
  and Slack configure/edit/repair, desired intent, health, test, removal, global master, and session controls.
  The CLI subcommands below remain the authoritative headless and automation fallback.

${chalk.bold("Usage:")}
  ${APP_NAME} notify setup [telegram]
  ${APP_NAME} notify setup discord --discord-bot-token <token> --discord-application-id <id> --discord-guild-id <id> --discord-parent-channel-id <id>
  ${APP_NAME} notify setup slack --slack-bot-token <token> --slack-app-token <token> --slack-workspace-id <id> --slack-channel-id <id> [--slack-authorized-user-id <id>]
  ${APP_NAME} notify status
  ${APP_NAME} notify health [--provider telegram|discord|slack] [--probe]
  ${APP_NAME} notify test [--provider telegram|discord|slack] [--message <text>]
  ${APP_NAME} notify recovery [--force-daemon-lock]
  ${APP_NAME} notify bind-thread --session-id <sessionId> --thread-ts <rootTs>
  ${APP_NAME} notify activate-thread --session-id <sessionId>

${chalk.bold("Subcommands:")}
  setup     Pair Telegram or atomically save and activate complete Discord/Slack settings
  status    Show global master and provider configured/repair/desired/effective state without secrets
  health    Report selected provider state; --probe uses REST only and never opens Gateway/Socket Mode
  test      Send a one-off test through one selected or uniquely effective provider
  recovery  Clear dead-owner daemon locks and stale per-session endpoint files (never touches a live owner); --force-daemon-lock retries only with the same fail-closed dead-owner proof
  bind-thread      Adopt an existing Slack thread as a live session's root; target and credentials come from setup only
  activate-thread  Publish the readiness a prepared session withheld once its thread binding is applied

${chalk.bold("Examples:")}
  ${APP_NAME} notify setup
  ${APP_NAME} notify setup --token <botToken> --chat-id <chatId> [--redact]
  ${APP_NAME} notify setup discord --discord-bot-token <token> --discord-application-id <id> --discord-guild-id <id> --discord-parent-channel-id <id>
  ${APP_NAME} notify setup slack --slack-bot-token <token> --slack-app-token <token> --slack-workspace-id <id> --slack-channel-id <id> [--slack-authorized-user-id <id>]
  ${APP_NAME} notify status
  ${APP_NAME} notify health --provider discord --probe
  ${APP_NAME} notify test --provider slack --message "hello from gjc"
  ${APP_NAME} notify recovery
  ${APP_NAME} notify bind-thread --session-id 01J... --thread-ts 1785573662.132329
  ${APP_NAME} notify activate-thread --session-id 01J...

${chalk.bold("Threaded Mode:")}
  GJC uses Telegram private-chat topics for per-session threads. Setup verifies the bot
  capability via getMe.has_topics_enabled. Enable Threaded Mode in @BotFather > Bot Settings
  > Threads Settings; bots cannot toggle it through the Bot API. If Telegram refuses topic
  creation at runtime, GJC delivers flat to the paired private chat with outbound notifications
  and inline ask buttons only, then nudges you to enable Threaded Mode for free-text replies
  and session commands.
`);
}
