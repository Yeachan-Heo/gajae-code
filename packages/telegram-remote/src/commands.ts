/**
 * Command parser for the fixed v0 vocabulary. Anything outside the five
 * commands resolves to `{ kind: "unknown" }`; the gateway never falls back to
 * shell, raw RPC, or free-form prompts.
 */
import type { ParsedCommand } from "./types";

/** Strip a Telegram `@botname` suffix from a command token. */
function stripMention(token: string): string {
	const at = token.indexOf("@");
	return at === -1 ? token : token.slice(0, at);
}

/**
 * Parse a raw Telegram message into a {@link ParsedCommand}.
 *
 * Tokenization is whitespace-based. The leading token must be a `/command`;
 * non-command text and blank input resolve to `unknown`.
 */
export function parseCommand(text: string): ParsedCommand {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) {
		return { kind: "unknown" };
	}

	const tokens = trimmed.split(/\s+/);
	const command = stripMention(tokens[0] ?? "")
		.slice(1)
		.toLowerCase();
	const args = tokens.slice(1);

	switch (command) {
		case "help":
			return { kind: "help" };
		case "start":
			// Telegram-conventional onboarding command; payload (if any) is ignored.
			return { kind: "start" };
		case "presets":
			return { kind: "presets" };
		case "attach":
			return { kind: "attach", socketPath: args[0] ?? null };
		case "detach":
			return { kind: "detach" };
		case "status":
			return { kind: "status" };
		case "abort":
			return { kind: "abort" };
		case "sessions": {
			const query = args.length > 0 ? args.join(" ").trim() : null;
			return { kind: "sessions", query: query || null };
		}
		case "observe":
			return { kind: "observe", sessionId: args[0] ?? null };
		case "start-session": {
			const presetId = args[0] ?? null;
			const task = args.length > 1 ? args.slice(1).join(" ") : null;
			return { kind: "start_session", presetId, task };
		}
		case "stop": {
			const sessionId = args[0] ?? null;
			const confirm = (args[1] ?? "").toLowerCase() === "confirm";
			return { kind: "stop", sessionId, confirm };
		}
		default:
			return { kind: "unknown" };
	}
}
