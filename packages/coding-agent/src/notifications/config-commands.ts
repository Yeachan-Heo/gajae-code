/**
 * In-thread configuration slash commands for the threaded session surface.
 *
 * Replies are thread-native now (the old `/answer <sessionId> …` command is
 * removed), but the user can still adjust per-surface behaviour from inside a
 * session thread with small slash commands:
 *
 * - `/verbose`            switch the mirror to verbose (full tool output + reasoning)
 * - `/lean`               switch back to lean (assistant text + tool names)
 * - `/verbosity lean|verbose`
 * - `/redact on|off`      toggle redaction of streamed content
 *
 * This parser is pure so the command grammar is unit-testable; the daemon maps
 * the returned change onto a `config_command` frame / settings update.
 */

/** A parsed in-thread configuration change. */
export interface ConfigCommandChange {
	verbosity?: "lean" | "verbose";
	redact?: boolean;
}

export type TelegramControlCommandName = "reasoning" | "usage" | "context" | "compact";

export type TelegramControlCommand =
	| { name: "reasoning"; action: "cycle" | "status" | "set"; level?: string }
	| { name: "usage" }
	| { name: "context" }
	| { name: "compact"; instructions?: string };

export type TelegramControlCommandParseResult =
	| { kind: "none" }
	| { kind: "ignored"; commandName: TelegramControlCommandName }
	| { kind: "command"; command: TelegramControlCommand }
	| { kind: "invalid"; commandName: TelegramControlCommandName; usage: string };

const TELEGRAM_CONTROL_COMMANDS = new Set<TelegramControlCommandName>(["reasoning", "usage", "context", "compact"]);
const TELEGRAM_REASONING_LEVELS = new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function splitTelegramBotSuffix(rawCommand: string): { name: string; suffix?: string } {
	const [name, suffix] = rawCommand.toLowerCase().split("@", 2);
	return suffix ? { name, suffix } : { name };
}

export function telegramControlCommandUsage(commandName: TelegramControlCommandName): string {
	switch (commandName) {
		case "reasoning":
			return "Usage: /reasoning [cycle|inherit|off|minimal|low|medium|high|xhigh|max]";
		case "usage":
			return "Usage: /usage";
		case "context":
			return "Usage: /context";
		case "compact":
			return "Usage: /compact [instructions]";
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
			if (rest.length !== 1) return { kind: "invalid", commandName, usage };
			const levelOrAction = rest[0]!.toLowerCase();
			if (levelOrAction === "cycle") return { kind: "command", command: { name: "reasoning", action: "cycle" } };
			if (TELEGRAM_REASONING_LEVELS.has(levelOrAction)) {
				return { kind: "command", command: { name: "reasoning", action: "set", level: levelOrAction } };
			}
			return { kind: "invalid", commandName, usage };
		}
	}
}

/**
 * Parse an in-thread config command. Returns the requested change, or
 * `undefined` when the text is not a recognised config command (so the daemon
 * can fall through to treating it as a free-text injection).
 */
export function parseInThreadConfigCommand(text: string): ConfigCommandChange | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
	const command = rawCommand?.toLowerCase();
	const arg = rest[0]?.toLowerCase();

	switch (command) {
		case "verbose":
			return { verbosity: "verbose" };
		case "lean":
			return { verbosity: "lean" };
		case "verbosity":
			if (arg === "lean" || arg === "verbose") return { verbosity: arg };
			return undefined;
		case "redact":
			if (arg === "on" || arg === "true" || arg === "1") return { redact: true };
			if (arg === "off" || arg === "false" || arg === "0") return { redact: false };
			return undefined;
		default:
			return undefined;
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
