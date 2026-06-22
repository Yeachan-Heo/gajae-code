/**
 * Notify CLI command handlers.
 *
 * Handles `gjc notify` setup/status and the hidden daemon entrypoint.
 */
import { createInterface } from "node:readline/promises";
import { APP_NAME } from "@gajae-code/utils";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { getNotificationConfig, maskToken } from "../notifications/config";

export type NotifyAction = "setup" | "status" | "daemon-internal";

export interface NotifyCommandArgs {
	action: NotifyAction;
	smoke?: boolean;
	rawArgs: string[];
	token?: string;
	chatId?: string;
	redact?: boolean;
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
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
}

interface TelegramUpdate {
	update_id: number;
	message?: {
		chat?: {
			id?: number | string;
			type?: string;
		};
	};
}

const DEFAULT_API_BASE = "https://api.telegram.org";
const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

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
		return {
			action,
			rawArgs: rest,
			token: flag("--token"),
			chatId: flag("--chat-id"),
			redact: rest.includes("--redact"),
		};
	}
	if (action === "daemon-internal") {
		return {
			action,
			smoke: args.slice(2).includes("--smoke"),
			rawArgs: args.slice(2),
		};
	}

	return { action: "status", rawArgs: args.slice(1) };
}

export async function runNotifyCommand(cmd: NotifyCommandArgs, deps: NotifyCommandDeps = {}): Promise<void> {
	switch (cmd.action) {
		case "setup":
			await runSetup({
				...deps,
				setupToken: deps.setupToken ?? cmd.token,
				setupChatId: deps.setupChatId ?? cmd.chatId,
				setupRedact: deps.setupRedact ?? cmd.redact,
			});
			return;
		case "status":
			await runStatus(deps);
			return;
		case "daemon-internal": {
			const m = await import("../notifications/telegram-daemon-cli");
			if (cmd.smoke) {
				await m.runDaemonSmoke();
			} else {
				await m.runDaemonInternal(cmd.rawArgs);
			}
			return;
		}
	}
}

async function getSettings(deps: NotifyCommandDeps): Promise<Settings> {
	return deps.settings ?? (await Settings.init());
}

async function runSetup(deps: NotifyCommandDeps): Promise<void> {
	const settings = await getSettings(deps);
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const apiBase = deps.apiBase ?? DEFAULT_API_BASE;
	const token = deps.setupToken ?? (await promptForToken());
	if (!token.trim()) {
		throw new Error("Telegram bot token is required.");
	}

	await callTelegram(fetchImpl, apiBase, token, "getMe", {});
	process.stdout.write(
		"Token validated. Message your bot now from the private Telegram chat to pair notifications.\n",
	);

	let chatId: string;
	if (deps.setupChatId?.trim()) {
		chatId = deps.setupChatId.trim();
		process.stdout.write(`Using provided chat id ${chatId} (non-interactive).\n`);
	} else {
		const stale = await getUpdates(fetchImpl, apiBase, token, { timeout: 0, allowed_updates: ["message"] });
		const offset = nextOffset(stale);
		chatId = await waitForPrivateChat(fetchImpl, apiBase, token, {
			offset,
			pollTimeoutMs: deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
			pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
		});
	}

	settings.set("notifications.telegram.botToken", token);
	settings.set("notifications.telegram.chatId", chatId);
	settings.set("notifications.enabled", true);
	if (deps.setupRedact) settings.set("notifications.redact", true);
	await settings.flush();

	process.stdout.write(`Notifications enabled. botToken=${maskToken(token)} chatId=${chatId}\n`);
}

async function promptForToken(): Promise<string> {
	if (!process.stdin.isTTY) {
		throw new Error("notify setup requires an interactive TTY unless setupToken is injected.");
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	try {
		return (await rl.question("Telegram BotFather token: ")).trim();
	} finally {
		rl.close();
	}
}

async function runStatus(deps: NotifyCommandDeps): Promise<void> {
	const settings = await getSettings(deps);
	const cfg = getNotificationConfig(settings);
	process.stdout.write(
		`${chalk.bold("Notifications")}\n` +
			`  enabled: ${cfg.enabled}\n` +
			`  botToken: ${maskToken(cfg.botToken)}\n` +
			`  chatId: ${cfg.chatId ?? "(unset)"}\n` +
			`  redact: ${cfg.redact}\n`,
	);
}

async function waitForPrivateChat(
	fetchImpl: typeof fetch,
	apiBase: string,
	token: string,
	opts: { offset: number | undefined; pollTimeoutMs: number; pollIntervalMs: number },
): Promise<string> {
	const deadline = Date.now() + opts.pollTimeoutMs;
	let offset = opts.offset;
	let sawRejectedChatType: string | undefined;

	while (Date.now() <= deadline) {
		const updates = await getUpdates(fetchImpl, apiBase, token, { offset, timeout: 0, allowed_updates: ["message"] });
		offset = nextOffset(updates, offset);
		for (const update of updates) {
			const chat = update.message?.chat;
			if (!chat) continue;
			if (chat.type === "private" && chat.id !== undefined) {
				return String(chat.id);
			}
			if (chat.type === "group" || chat.type === "supergroup" || chat.type === "channel") {
				sawRejectedChatType = chat.type;
				process.stderr.write(
					`Rejected ${chat.type} chat. Pairing requires a private Telegram chat with the bot.\n`,
				);
			}
		}
		if (opts.pollIntervalMs > 0) {
			await new Promise(resolve =>
				setTimeout(resolve, Math.min(opts.pollIntervalMs, Math.max(0, deadline - Date.now()))),
			);
		}
	}

	if (sawRejectedChatType) {
		throw new Error(`Pairing rejected ${sawRejectedChatType} chat; message the bot from a private chat.`);
	}
	throw new Error("Timed out waiting for a private Telegram message to pair notifications.");
}

function nextOffset(updates: TelegramUpdate[], fallback?: number): number | undefined {
	let max = fallback === undefined ? undefined : fallback - 1;
	for (const update of updates) {
		if (typeof update.update_id === "number" && (max === undefined || update.update_id > max)) {
			max = update.update_id;
		}
	}
	return max === undefined ? fallback : max + 1;
}

async function getUpdates(
	fetchImpl: typeof fetch,
	apiBase: string,
	token: string,
	params: Record<string, unknown>,
): Promise<TelegramUpdate[]> {
	return await callTelegram<TelegramUpdate[]>(fetchImpl, apiBase, token, "getUpdates", params);
}

async function callTelegram<T>(
	fetchImpl: typeof fetch,
	apiBase: string,
	token: string,
	method: string,
	body: Record<string, unknown>,
): Promise<T> {
	const response = await fetchImpl(`${apiBase.replace(/\/$/, "")}/bot${token}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	let payload: TelegramApiResponse<T>;
	try {
		payload = (await response.json()) as TelegramApiResponse<T>;
	} catch {
		throw new Error(`Telegram ${method} returned invalid JSON.`);
	}
	if (!response.ok || !payload.ok) {
		throw new Error(`Telegram ${method} failed: ${payload.description ?? response.statusText}`);
	}
	return payload.result as T;
}

export function printNotifyHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} notify`)} - Configure Telegram notifications

${chalk.bold("Usage:")}
  ${APP_NAME} notify setup
  ${APP_NAME} notify setup --token <botToken> --chat-id <chatId> [--redact]
  ${APP_NAME} notify status

${chalk.bold("Subcommands:")}
  setup     Pair a Telegram bot token with a private chat
  status    Show notification configuration without secrets

${chalk.bold("Examples:")}
  ${APP_NAME} notify setup
  ${APP_NAME} notify setup --token <botToken> --chat-id <chatId> [--redact]
  ${APP_NAME} notify status
`);
}
