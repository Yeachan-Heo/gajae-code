/**
 * `/import-session` slash-command surface (issue #3709).
 *
 * The documented CLI contract:
 *
 *     /import-session <transcript-file> [--provider codex|claude]
 *
 * The file argument is an explicit user-selected Codex rollout transcript,
 * Claude Code transcript, or claude.ai export. Provider detection is automatic;
 * `--provider` narrows it and fails closed on a mismatch.
 */

import { parseCommandArgs } from "../utils/command-args";
import { formatSessionImportError, importExternalSession } from "./service";
import type { SessionImportCompleted, SessionImportProviderId } from "./types";

export const IMPORT_SESSION_USAGE = "Usage: /import-session <transcript-file> [--provider codex|claude]";

export type ParsedImportSessionArgs =
	| { kind: "ok"; sourcePath: string; provider?: SessionImportProviderId }
	| { kind: "error"; message: string };

export function parseImportSessionArgs(args: string): ParsedImportSessionArgs {
	const tokens = parseCommandArgs(args);
	let provider: SessionImportProviderId | undefined;
	const positional: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--provider" || token.startsWith("--provider=")) {
			const value = token === "--provider" ? tokens[++index] : token.slice("--provider=".length);
			if (value !== "codex" && value !== "claude") {
				return { kind: "error", message: `--provider must be codex or claude.\n${IMPORT_SESSION_USAGE}` };
			}
			if (provider && provider !== value) {
				return { kind: "error", message: `Conflicting --provider values.\n${IMPORT_SESSION_USAGE}` };
			}
			provider = value;
			continue;
		}
		if (token.startsWith("--")) {
			return { kind: "error", message: `Unknown option: ${token}\n${IMPORT_SESSION_USAGE}` };
		}
		positional.push(token);
	}
	if (positional.length === 0) return { kind: "error", message: IMPORT_SESSION_USAGE };
	if (positional.length > 1) {
		return {
			kind: "error",
			message: `Expected exactly one transcript file; got ${positional.length} arguments.\n${IMPORT_SESSION_USAGE}`,
		};
	}
	return { kind: "ok", sourcePath: positional[0]!, ...(provider ? { provider } : {}) };
}

export type SessionImportCommandOutcome =
	| { kind: "imported"; result: SessionImportCompleted }
	| { kind: "error"; message: string };

/**
 * Shared non-UI flow for both the text/ACP handler and the TUI handler:
 * import into a NEW session file; the caller decides how to present/switch.
 * Never mutates the current session.
 */
export async function runSessionImportCommand(args: string, cwd: string): Promise<SessionImportCommandOutcome> {
	const parsed = parseImportSessionArgs(args);
	if (parsed.kind === "error") return { kind: "error", message: parsed.message };
	try {
		const result = await importExternalSession({
			sourcePath: parsed.sourcePath,
			...(parsed.provider ? { provider: parsed.provider } : {}),
			cwd,
		});
		return { kind: "imported", result };
	} catch (error) {
		return { kind: "error", message: formatSessionImportError(error) };
	}
}
