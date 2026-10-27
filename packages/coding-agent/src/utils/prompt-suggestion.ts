/**
 * Next-prompt suggestion contract, ported from the OpenAI Codex TUI prompt
 * suggestions (openai/codex#47911, #47929). The request text is Codex's
 * desktop fallback prompt kept verbatim, wrapped the way Codex sends it as an
 * app-generated user fragment with the JSON schema it must answer.
 *
 * The request runs as an ephemeral turn over the session's own model, thinking
 * level, system prompt, and history (Codex forks the live thread), and the reply
 * must be exactly `{"suggestion": string | null}`.
 */

import promptSuggestionRequest from "../prompts/system/prompt-suggestion.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";

export const PROMPT_SUGGESTION_REQUEST = promptSuggestionRequest.trim();

/** Codex caps a suggestion at 240 characters (Unicode scalar values). */
export const PROMPT_SUGGESTION_MAX_CHARS = 240;

/** Control characters and Unicode line/paragraph separators break the one-line contract. */
const NON_SINGLE_LINE = /[\p{Cc}\u2028\u2029]/u;

/** Rust `str::trim` strips Unicode `White_Space` (includes U+0085, excludes U+FEFF), unlike `String#trim`. */
const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/**
 * True when the top-level object has more than one member. serde with
 * `deny_unknown_fields` rejects both unknown and duplicate fields, so a valid
 * reply has exactly one; `JSON.parse` would silently collapse duplicates.
 * Only called on text that already parsed as JSON.
 */
function hasMultipleTopLevelMembers(json: string): boolean {
	let depth = 0;
	let inString = false;
	for (let i = 0; i < json.length; i++) {
		const ch = json[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") depth--;
		else if (ch === "," && depth === 1) return true;
	}
	return false;
}

/**
 * Parse the model reply. Only an object whose sole key is `suggestion` holding a
 * non-empty, single-line string of at most 240 characters is accepted; the string
 * is trimmed. Anything else, including `{"suggestion": null}`, yields null. Mirrors
 * Codex `parse_suggestion` (serde: unknown/duplicate fields and unpaired surrogates
 * are errors; Rust `trim` and `char::is_control`).
 */
export function parsePromptSuggestion(response: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(response);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const keys = Object.keys(parsed);
	if (keys.length !== 1 || keys[0] !== "suggestion") return null;
	if (hasMultipleTopLevelMembers(response)) return null;
	const value = (parsed as { suggestion: unknown }).suggestion;
	if (typeof value !== "string" || !value.isWellFormed()) return null;
	const text = value.replace(EDGE_WHITE_SPACE, "");
	if (text.length === 0 || [...text].length > PROMPT_SUGGESTION_MAX_CHARS || NON_SINGLE_LINE.test(text)) return null;
	return text;
}

/**
 * Ask the session's live model for the user's likely next message. The turn is
 * ephemeral: it reads the current history but never writes to it.
 */
export async function generatePromptSuggestion(
	session: Pick<AgentSession, "runEphemeralTurn">,
	signal: AbortSignal,
): Promise<string | null> {
	const { replyText, assistantMessage } = await session.runEphemeralTurn({
		promptText: PROMPT_SUGGESTION_REQUEST,
		signal,
		ircRosterClaim: null,
		maintenanceCall: true,
	});
	if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") return null;
	return parsePromptSuggestion(replyText);
}
