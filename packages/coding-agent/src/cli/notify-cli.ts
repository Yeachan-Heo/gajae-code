/**
 * Notify CLI command handlers.
 *
 * Handles `gjc notify` setup/status and the hidden daemon entrypoint.
 */
import { createInterface } from "node:readline/promises";
import { APP_NAME } from "@gajae-code/utils/dirs";
import chalk from "chalk";
import { Settings, type SettingsAtomicPatch } from "../config/settings";
import { type EnsureChatDaemonResult, ensureDiscordDaemon, ensureSlackDaemon } from "../sdk/bus/chat-daemon-control";
import { getNotificationConfig, maskToken, tokenFingerprint } from "../sdk/bus/config";
import {
	clearTelegramActivationMarker,
	createTelegramActivationMarker,
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
import { ensureTelegramDaemonRunningDetailed, readDaemonState } from "../sdk/bus/telegram-daemon";
import { runDaemonInternal } from "../sdk/bus/telegram-daemon-cli";
import {
	runTelegramSetup as runTelegramPairingSetup,
	type TelegramSetupPreflight,
	type TelegramSetupTimers,
} from "../sdk/bus/telegram-setup";

export type NotifyAction = "setup" | "status" | "health" | "test" | "recovery" | "daemon-internal";
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
	probe?: boolean;
	message?: string;
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
	ensureProviderDaemon?: (
		provider: "discord" | "slack",
		settings: Settings,
	) => Promise<EnsureChatDaemonResult | "failed">;
}

export function parseNotifyArgs(args: string[]): NotifyCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "notify") {
		return undefined;
	}

	const action = args[1];
	if (action === "setup" || action === "status") {
		const rest = args.slice(2);
		const flag = (name: string): string | undefined => {
			const i = rest.indexOf(name);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		const valueFlags = [
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
		];
		if (
			valueFlags.some(name => {
				const index = rest.indexOf(name);
				const value = index >= 0 ? rest[index + 1] : undefined;
				return index >= 0 && (!value || value.startsWith("--"));
			})
		)
			return undefined;
		const provider = rest[0]?.startsWith("--") ? undefined : rest[0];
		if (provider !== undefined && provider !== "telegram" && provider !== "discord" && provider !== "slack") {
			return undefined;
		}
		return {
			action,
			rawArgs: rest,
			...(provider ? { provider } : {}),
			token: flag("--token"),
			chatId: flag("--chat-id"),
			...(flag("--discord-bot-token") ? { discordBotToken: flag("--discord-bot-token") } : {}),
			...(flag("--discord-application-id") ? { discordApplicationId: flag("--discord-application-id") } : {}),
			...(flag("--discord-guild-id") ? { discordGuildId: flag("--discord-guild-id") } : {}),
			...(flag("--discord-parent-channel-id")
				? { discordParentChannelId: flag("--discord-parent-channel-id") }
				: {}),
			...(flag("--slack-bot-token") ? { slackBotToken: flag("--slack-bot-token") } : {}),
			...(flag("--slack-app-token") ? { slackAppToken: flag("--slack-app-token") } : {}),
			...(flag("--slack-workspace-id") ? { slackWorkspaceId: flag("--slack-workspace-id") } : {}),
			...(flag("--slack-channel-id") ? { slackChannelId: flag("--slack-channel-id") } : {}),
			...(flag("--slack-authorized-user-id") ? { slackAuthorizedUserId: flag("--slack-authorized-user-id") } : {}),
			redact: rest.includes("--redact"),
		};
	}
	if (action === "health" || action === "test" || action === "recovery") {
		const rest = args.slice(2);
		const flag = (name: string): string | undefined => {
			const i = rest.indexOf(name);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		return {
			action,
			rawArgs: rest,
			probe: rest.includes("--probe"),
			message: flag("--message"),
		};
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
			await runRecovery(deps);
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
	const patches: SettingsAtomicPatch[] = [
		{ path: "notifications.discord.botToken", op: "set", value: botToken },
		{ path: "notifications.discord.applicationId", op: "set", value: applicationId },
		{ path: "notifications.discord.guildId", op: "set", value: guildId },
		{ path: "notifications.discord.parentChannelId", op: "set", value: parentChannelId },
		{ path: "notifications.enabled", op: "set", value: true },
	];
	if (cmd.redact) patches.push({ path: "notifications.redact", op: "set", value: true });
	await settings.commitAtomicBatch(patches);
	const daemon = await ensureConfiguredProviderDaemon("discord", settings, deps);
	process.stdout.write(
		`Discord notifications enabled. botToken=${maskToken(botToken)} applicationId=${applicationId} guildId=${guildId} parentChannelId=${parentChannelId} daemon=${daemon}\n`,
	);
}

async function runSlackSetup(cmd: NotifyCommandArgs, deps: NotifyCommandDeps): Promise<void> {
	const botToken = await promptSetupValue(cmd.slackBotToken, "--slack-bot-token", true, deps);
	const appToken = await promptSetupValue(cmd.slackAppToken, "--slack-app-token", true, deps);
	const workspaceId = await promptSetupValue(cmd.slackWorkspaceId, "--slack-workspace-id", false, deps);
	const channelId = await promptSetupValue(cmd.slackChannelId, "--slack-channel-id", false, deps);
	const authorizedUserId = cmd.slackAuthorizedUserId?.trim() || undefined;
	const settings = await getSettings(deps);
	const patches: SettingsAtomicPatch[] = [
		{ path: "notifications.slack.botToken", op: "set", value: botToken },
		{ path: "notifications.slack.appToken", op: "set", value: appToken },
		{ path: "notifications.slack.workspaceId", op: "set", value: workspaceId },
		{ path: "notifications.slack.channelId", op: "set", value: channelId },
		authorizedUserId === undefined
			? { path: "notifications.slack.authorizedUserId", op: "unset" }
			: { path: "notifications.slack.authorizedUserId", op: "set", value: authorizedUserId },
		{ path: "notifications.enabled", op: "set", value: true },
	];
	if (cmd.redact) patches.push({ path: "notifications.redact", op: "set", value: true });
	await settings.commitAtomicBatch(patches);
	const daemon = await ensureConfiguredProviderDaemon("slack", settings, deps);
	process.stdout.write(
		`Slack notifications enabled. botToken=${maskToken(botToken)} appToken=${maskToken(appToken)} workspaceId=${workspaceId} channelId=${channelId} authorizedUserId=${authorizedUserId ?? "(unset; inbound denied)"} daemon=${daemon}\n`,
	);
}

async function ensureConfiguredProviderDaemon(
	provider: "discord" | "slack",
	settings: Settings,
	deps: NotifyCommandDeps,
): Promise<EnsureChatDaemonResult | "failed"> {
	try {
		if (deps.ensureProviderDaemon) return await deps.ensureProviderDaemon(provider, settings);
		return provider === "discord" ? await ensureDiscordDaemon(settings) : await ensureSlackDaemon(settings);
	} catch {
		return "failed";
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
		];
		if (deps.setupRedact ?? cmd.redact) patches.push({ path: "notifications.redact", op: "set", value: true });
		const receipt = await settings.commitAtomicBatch(patches);
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
					await ensureTelegramDaemonRunningDetailed({
						settings,
						cwd: process.cwd(),
						sessionId: `notify-cli-${process.pid}`,
					}),
				persistInactive: async marker => await persistTelegramActivationMarker(settings, marker),
				clearInactive: async marker => await clearTelegramActivationMarker(settings, marker),
				marker: activationMarker,
			},
		});
		if (activation.status === "blocked_identity") {
			const restored = await activation.restore();
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
	} catch (error) {
		const detail = sanitizeDiagnostic(error instanceof Error ? error.message : "unknown persistence failure", token);
		throw new Error(`Unable to persist and activate Telegram notification settings: ${detail}`);
	}
	process.stdout.write(
		`Notifications enabled. botToken=${maskToken(token)} chatId=${result.chatId} threaded=${result.threadedLabel}\n`,
	);
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
	const cfg = getNotificationConfig(settings);
	try {
		const state = await readDaemonState(settings);
		if (!state) return { storedChatId: cfg.chatId };
		const validPid = Number.isSafeInteger(state.pid) && state.pid > 0;
		// Owner-proof: only block discovery for a daemon we can positively prove is
		// live (present state with a valid, alive pid). A malformed/no-pid record is
		// not evidence of a live poller, mirroring recoverNotifications' semantics.
		if (!validPid) return { storedChatId: cfg.chatId };
		return {
			storedChatId: cfg.chatId,
			daemon: {
				live: (deps.setupPidAlive ?? daemonPidAlive)(state.pid),
				tokenFingerprint: typeof state.tokenFingerprint === "string" ? state.tokenFingerprint : undefined,
				chatId: typeof state.chatId === "string" ? state.chatId : undefined,
			},
		};
	} catch {
		// A state read failure is not proof of a live daemon; proceed normally. The
		// daemon's own 409 handling remains the backstop against poller contention.
		return { storedChatId: cfg.chatId };
	}
}

function daemonPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
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
		text: cmd.message,
		deps: { fetchImpl: deps.fetchImpl, apiBase: deps.apiBase },
	});
	process.stdout.write(`${formatNotificationTestResult(result)}\n`);
	if (!result.ok && deps.setExitCode) deps.setExitCode(1);
	else if (!result.ok) process.exitCode = 1;
}

async function runRecovery(deps: NotifyCommandDeps): Promise<void> {
	const settings = await getSettings(deps);
	const report = await recoverNotifications({ settings });
	process.stdout.write(`${formatNotificationRecoveryReport(report)}\n`);
}

export function printNotifyHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} notify`)} - Configure Telegram, Discord, or Slack notifications

${chalk.bold("Interactive path:")}
  In a running GJC session, use /settings → Notifications for setup, health, test, recovery,
  reconnect, global enable/disable, adapter-local Telegram removal, and session on/off.
  The CLI subcommands below remain the authoritative headless and automation fallback.

${chalk.bold("Usage:")}
  ${APP_NAME} notify setup [telegram]
  ${APP_NAME} notify setup discord --discord-bot-token <token> --discord-application-id <id> --discord-guild-id <id> --discord-parent-channel-id <id>
  ${APP_NAME} notify setup slack --slack-bot-token <token> --slack-app-token <token> --slack-workspace-id <id> --slack-channel-id <id> [--slack-authorized-user-id <id>]
  ${APP_NAME} notify status
  ${APP_NAME} notify health [--probe]
  ${APP_NAME} notify test [--message <text>]
  ${APP_NAME} notify recovery

${chalk.bold("Subcommands:")}
  setup     Pair Telegram or save complete non-interactive Discord/Slack notification settings
  status    Show notification configuration without secrets
  health    Report config, daemon-ownership and endpoint health (--probe adds a Telegram reachability check)
  test      Send a one-off test notification through the configured Telegram adapter
  recovery  Clear dead-owner daemon locks and stale per-session endpoint files (never touches a live owner)

${chalk.bold("Examples:")}
  ${APP_NAME} notify setup
  ${APP_NAME} notify setup --token <botToken> --chat-id <chatId> [--redact]
  ${APP_NAME} notify setup discord --discord-bot-token <token> --discord-application-id <id> --discord-guild-id <id> --discord-parent-channel-id <id>
  ${APP_NAME} notify setup slack --slack-bot-token <token> --slack-app-token <token> --slack-workspace-id <id> --slack-channel-id <id> [--slack-authorized-user-id <id>]
  ${APP_NAME} notify status
  ${APP_NAME} notify health --probe
  ${APP_NAME} notify test --message "hello from gjc"
  ${APP_NAME} notify recovery

${chalk.bold("Threaded Mode:")}
  GJC uses Telegram private-chat topics for per-session threads. Setup verifies the bot
  capability via getMe.has_topics_enabled. Enable Threaded Mode in @BotFather > Bot Settings
  > Threads Settings; bots cannot toggle it through the Bot API. If Telegram refuses topic
  creation at runtime, GJC delivers flat to the paired private chat with outbound notifications
  and inline ask buttons only, then nudges you to enable Threaded Mode for free-text replies
  and session commands.
`);
}
