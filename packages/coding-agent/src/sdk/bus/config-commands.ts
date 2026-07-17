import { type NotificationVerbosity, parseNotificationVerbosityStrict } from "./notification-verbosity";

/**
 * In-thread configuration slash commands for the threaded session surface.
 *
 * Replies are thread-native now (the old `/answer <sessionId> …` command is
 * removed), but the user can still adjust per-surface behaviour from inside a
 * session thread with small slash commands:
 *
 * - `/quiet`              switch to action-only remote pings (asks/idles + user-initiated results)
 * - `/verbose`            switch the mirror to bounded tool-owned summaries + provider-displayable reasoning summaries
 * - `/lean`               switch back to lean (assistant text + tool names)
 * - `/verbosity quiet|lean|verbose`
 * - `/redact on|off`      toggle redaction of streamed content
 *
 * This parser is pure so the command grammar is unit-testable; the daemon maps
 * a `change` result onto a `config_command` frame / settings update. Recognised
 * roots with invalid arguments resolve to `invalid` so the daemon replies with
 * a usage error and **never** falls through to free-text injection; only
 * unrecognised commands and plain text resolve to `none`.
 */

/** A parsed in-thread configuration change. */
export interface ConfigCommandChange {
	verbosity?: NotificationVerbosity;
	redact?: boolean;
}

/**
 * Discriminated parse result for in-thread config commands.
 *
 * - `none`    — not a recognised config command (plain text or an unknown
 *   slash command); the daemon falls through to free-text / pending-ask handling.
 * - `invalid` — a *recognised* root with missing/invalid arguments; the daemon
 *   replies with `usage` and **never** treats it as free text.
 * - `change`  — a valid config command; the daemon forwards `change` as a
 *   `config_command` frame.
 */
export type InThreadConfigCommandResult =
	| { kind: "none" }
	| { kind: "invalid"; usage: string }
	| { kind: "change"; change: ConfigCommandChange };

export type TelegramControlCommandName = "reasoning" | "usage" | "context" | "compact" | "model";

export type TelegramControlCommand =
	| { name: "reasoning"; action: "cycle" | "status" | "set" | "show" | "hide"; level?: string; global?: boolean }
	| { name: "usage" }
	| { name: "context" }
	| { name: "compact"; instructions?: string }
	| { name: "model"; action: "list" | "set"; selector?: string };

export type TelegramControlCommandParseResult =
	| { kind: "none" }
	| { kind: "ignored"; commandName: TelegramControlCommandName }
	| { kind: "command"; command: TelegramControlCommand }
	| { kind: "invalid"; commandName: TelegramControlCommandName; usage: string };

const TELEGRAM_CONTROL_COMMANDS = new Set<TelegramControlCommandName>([
	"reasoning",
	"usage",
	"context",
	"compact",
	"model",
]);
const TELEGRAM_REASONING_LEVELS = new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function splitTelegramBotSuffix(rawCommand: string): { name: string; suffix?: string } {
	const [name, suffix] = rawCommand.toLowerCase().split("@", 2);
	return suffix ? { name, suffix } : { name };
}

export function telegramControlCommandUsage(commandName: TelegramControlCommandName): string {
	switch (commandName) {
		case "reasoning":
			return "Usage: /reasoning [cycle|inherit|reset|off|none|minimal|low|medium|high|xhigh|max|show|hide] [--global for set/reset/show/hide]";
		case "usage":
			return "Usage: /usage";
		case "context":
			return "Usage: /context";
		case "compact":
			return "Usage: /compact [instructions]";
		case "model":
			return "Usage: /model [provider/model]";
	}
}

/** Parse deterministic Telegram session-control commands. Recognised roots fail closed. */
export function parseTelegramControlCommand(text: string, botUsername?: string): TelegramControlCommandParseResult {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { kind: "none" };
	const [rawRoot, ...rest] = trimmed.slice(1).split(/\s+/);
	if (!rawRoot) return { kind: "none" };
	const { name: root, suffix } = splitTelegramBotSuffix(rawRoot);
	if (!TELEGRAM_CONTROL_COMMANDS.has(root as TelegramControlCommandName)) return { kind: "none" };
	const commandName = root as TelegramControlCommandName;
	if (suffix && (!botUsername || suffix !== botUsername.toLowerCase())) return { kind: "ignored", commandName };
	const usage = telegramControlCommandUsage(commandName);

	switch (commandName) {
		case "usage":
		case "context":
			return rest.length === 0
				? { kind: "command", command: { name: commandName } }
				: { kind: "invalid", commandName, usage };
		case "compact": {
			const instructions = trimmed.slice(rawRoot.length + 1).trim();
			return { kind: "command", command: instructions ? { name: "compact", instructions } : { name: "compact" } };
		}
		case "reasoning": {
			if (rest.length === 0) return { kind: "command", command: { name: "reasoning", action: "status" } };
			const action = rest[0]!.toLowerCase();
			if (action === "cycle") {
				return rest.length === 1
					? { kind: "command", command: { name: "reasoning", action: "cycle" } }
					: { kind: "invalid", commandName, usage };
			}
			const global = rest[1]?.toLowerCase() === "--global";
			if (rest.length > 2 || (rest.length === 2 && !global)) return { kind: "invalid", commandName, usage };
			if (action === "show" || action === "hide") {
				return {
					kind: "command",
					command: { name: "reasoning", action, ...(global ? { global: true } : {}) },
				};
			}
			const level = action === "none" ? "off" : action === "reset" ? "inherit" : action;
			if (TELEGRAM_REASONING_LEVELS.has(level)) {
				return {
					kind: "command",
					command: { name: "reasoning", action: "set", level, ...(global ? { global: true } : {}) },
				};
			}
			return { kind: "invalid", commandName, usage };
		}
		case "model":
			if (rest.length === 0) return { kind: "command", command: { name: "model", action: "list" } };
			return rest.length === 1
				? { kind: "command", command: { name: "model", action: "set", selector: rest[0]! } }
				: { kind: "invalid", commandName, usage };
	}
}

/**
 * Parse an in-thread config command into a discriminated result.
 *
 * - `none`    — plain text or an unrecognised slash command; the daemon falls
 *   through to free-text / pending-ask handling.
 * - `invalid` — a recognised root with missing/invalid arguments; the daemon
 *   replies with `usage` and never treats the input as free text.
 * - `change`  — a valid config command to forward as a `config_command` frame.
 *
 * Verbosity arguments are parsed strictly ({@link parseNotificationVerbosityStrict}):
 * only exact `quiet` / `lean` / `verbose` is accepted, so a recognised
 * `/verbosity` root with a bad argument resolves to `invalid` rather than
 * coercing to `lean` or becoming free text.
 */
export function parseInThreadConfigCommand(text: string): InThreadConfigCommandResult {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { kind: "none" };
	const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
	const command = rawCommand?.toLowerCase();
	const arg = rest[0]?.toLowerCase();

	switch (command) {
		case "quiet":
			return rest.length === 0
				? { kind: "change", change: { verbosity: "quiet" } }
				: { kind: "invalid", usage: "Usage: /quiet" };
		case "verbose":
			return rest.length === 0
				? { kind: "change", change: { verbosity: "verbose" } }
				: { kind: "invalid", usage: "Usage: /verbose" };
		case "lean":
			return rest.length === 0
				? { kind: "change", change: { verbosity: "lean" } }
				: { kind: "invalid", usage: "Usage: /lean" };
		case "verbosity": {
			if (rest.length === 1) {
				const verbosity = parseNotificationVerbosityStrict(arg);
				if (verbosity) return { kind: "change", change: { verbosity } };
			}
			return { kind: "invalid", usage: "Usage: /verbosity quiet|lean|verbose" };
		}
		case "redact":
			if (rest.length !== 1) return { kind: "invalid", usage: "Usage: /redact on|off" };
			if (arg === "on" || arg === "true" || arg === "1") return { kind: "change", change: { redact: true } };
			if (arg === "off" || arg === "false" || arg === "0") return { kind: "change", change: { redact: false } };
			return { kind: "invalid", usage: "Usage: /redact on|off" };
		default:
			return { kind: "none" };
	}
}

/**
 * Parse a `/rich on|off` toggle. Returns `true`/`false` for a recognised
 * on/off argument, or `undefined` otherwise (not a `/rich` command, or `/rich`
 * with a missing/invalid argument). This is intentionally SEPARATE from
 * `parseInThreadConfigCommand`: `/verbose`/`/redact` are producer/session config
 * forwarded over the WS, whereas rich is Telegram-daemon delivery policy handled
 * daemon-locally, so it never becomes a `config_command` frame or a user turn.
 */
export function parseRichToggleCommand(text: string): boolean | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
	// Accept the "/rich@botname" form Telegram appends in group chats.
	if (rawCommand?.toLowerCase().split("@")[0] !== "rich") return undefined;
	const arg = rest[0]?.toLowerCase();
	if (arg === "on" || arg === "true" || arg === "1") return true;
	if (arg === "off" || arg === "false" || arg === "0") return false;
	return undefined;
}
