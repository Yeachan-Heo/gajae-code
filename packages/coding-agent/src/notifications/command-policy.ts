/**
 * Minimal allowlist policy for the Telegram `/menu` surface.
 *
 * Raw shell/eval escapes, persistent session/provider changes, and `/model <args>`
 * stay local-only. Telegram model changes go through the temporary picker.
 */

/** The MVP palette categories. Order is the rendered top-level order. */
export const MENU_CATEGORIES = ["skills", "model", "notify"] as const;

export type MenuCategory = (typeof MENU_CATEGORIES)[number];

/** Telegram thread config commands that remain handled by the existing parser. */
export const CONFIG_COMMAND_NAMES = ["verbose", "lean", "verbosity", "redact"] as const;

/**
 * Command names that must never be reachable from the Telegram surface, because
 * they mutate durable state, delete data, or only make sense in the local TUI.
 * Matched case-insensitively against the first slash token.
 */
export const DENIED_COMMAND_NAMES = [
	// destructive / persistent session + memory + provider mutations
	"session",
	"memory",
	"provider",
	"login",
	"logout",
	"compact",
	"clear",
	"reset",
	"move",
	"mcp",
	// TUI-only selectors / dashboards with no text-mode contract
	"resume",
	"export",
	"theme",
	"vim",
] as const;

/** Normalize a raw inbound string into a leading slash command name + raw args. */
export function parseSlashName(text: string): { name: string; args: string } | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const body = trimmed.slice(1);
	// Split on the earliest whitespace or ':' so `/skill:ralplan x` and
	// `/model gpt` both yield a name and the remaining args.
	const match = /^([^\s:]+)([\s:]+)?([\s\S]*)$/.exec(body);
	if (!match) return { name: "", args: "" };
	const name = (match[1] ?? "").toLowerCase();
	const args = (match[3] ?? "").trim();
	return { name, args };
}

/** True when `text` is one of the existing in-thread config commands. */
export function isConfigCommand(text: string): boolean {
	const parsed = parseSlashName(text);
	return !!parsed && (CONFIG_COMMAND_NAMES as readonly string[]).includes(parsed.name);
}

/** True when `text` is a `/model` invocation that carries arguments. */
export function isModelCommandWithArgs(text: string): boolean {
	const parsed = parseSlashName(text);
	return !!parsed && parsed.name === "model" && parsed.args.length > 0;
}

/**
 * True when `text` must be rejected from the Telegram surface entirely:
 * shell/eval escapes, explicitly denied command names, or `/model <args>`
 * (which would persist a default/role instead of a temporary change).
 */
export function isDeniedCommand(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.startsWith("!") || trimmed.startsWith("$")) return true;
	if (isModelCommandWithArgs(trimmed)) return true;
	const parsed = parseSlashName(trimmed);
	if (!parsed) return false;
	return (DENIED_COMMAND_NAMES as readonly string[]).includes(parsed.name);
}

/**
 * Validate a skill invocation against the session-provided allowed skill ids.
 * The session is authoritative for which skills exist; the policy only enforces
 * that the id is non-empty and present in that allowlist.
 */
export function isAllowedSkillInvocation(skillName: string, allowedSkillIds: readonly string[]): boolean {
	const id = skillName.trim().toLowerCase();
	if (!id) return false;
	return allowedSkillIds.some(allowed => allowed.trim().toLowerCase() === id);
}

/**
 * Classify a typed (not button-driven) slash input for routing:
 * - `config`   — keep existing in-thread config behavior.
 * - `denied`   — never execute; surface a rejection.
 * - `command`  — a `/`-prefixed input that is not config and not denied; the
 *   Telegram surface redirects these to `/menu` guidance instead of executing
 *   raw typed commands.
 * - `not_command` — not slash-prefixed; ordinary text (free-text injection).
 */
export type TypedSlashClass =
	| { kind: "config" }
	| { kind: "denied"; reason: string }
	| { kind: "command" }
	| { kind: "not_command" };

export function classifyTypedSlash(text: string): TypedSlashClass {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) {
		// `!`/`$` escapes are not `/`-commands but are still denied surfaces.
		if (trimmed.startsWith("!") || trimmed.startsWith("$")) {
			return { kind: "denied", reason: "shell and eval escapes are not available over Telegram" };
		}
		return { kind: "not_command" };
	}
	if (isConfigCommand(trimmed)) return { kind: "config" };
	if (isDeniedCommand(trimmed)) {
		return {
			kind: "denied",
			reason: isModelCommandWithArgs(trimmed)
				? "use the Model menu to switch models for this session only"
				: "this command is not available over Telegram",
		};
	}
	return { kind: "command" };
}
