/**
 * Pure helpers for the Telegram `/menu` button-first command surface.
 *
 * The Telegram menu is expressed as session-owned synthetic `kind:"ask"`
 * notification actions (no native protocol change). Every menu/submenu/model
 * picker/skill prompt is an answerable ask whose id is NAMESPACED so it can
 * never collide with a real workflow ask (`ask:<uuid>`) or gate id. The session
 * keeps the semantic meaning in a pending-action registry keyed by that id; the
 * daemon only renders options and routes the chosen index/text back.
 *
 * Pure module: no I/O, no session imports (only the policy types), unit-testable.
 */

import { classifyTypedSlash, MENU_CATEGORIES, type MenuCategory } from "./command-policy";

/** Discriminating prefixes for synthetic menu action ids. */
export const SYNTHETIC_ACTION_KINDS = ["menu", "submenu", "model"] as const;
export type SyntheticActionKind = (typeof SYNTHETIC_ACTION_KINDS)[number];

/** Guidance posted when a raw typed slash command is redirected to the menu. */
export const MENU_GUIDANCE = "Use /menu (or /m) to open the command buttons (Skills, Model, Notify).";

/** Top-level palette entries, in render order. Labels are user-facing button text. */
export const TOP_LEVEL_MENU: ReadonlyArray<{ category: MenuCategory; label: string }> = [
	{ category: "skills", label: "Skills" },
	{ category: "model", label: "Model" },
	{ category: "notify", label: "Notify" },
];

/** A session-local pending synthetic action, keyed in the registry by its action id. */
export type PendingMenuAction =
	| { type: "menu"; optionCategories: MenuCategory[] }
	| { type: "submenu"; category: MenuCategory; optionIds: string[] }
	| { type: "model"; modelRefs: string[] };

/** True for an exact `/menu` or its short alias `/m` (case-insensitive, whitespace-tolerant). */
export function parseMenuTrigger(text: string): boolean {
	const t = text.trim().toLowerCase();
	return t === "/menu" || t === "/m";
}

function randomUuid(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	// Deterministic-enough fallback for environments without WebCrypto.
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Build a namespaced synthetic action id, e.g. `menu:<uuid>`. */
export function makeSyntheticActionId(kind: SyntheticActionKind, uuid: string = randomUuid()): string {
	return `${kind}:${uuid}`;
}

/** Parse a namespaced synthetic action id back into its kind + uuid, or undefined. */
function parseSyntheticActionId(id: string): { kind: SyntheticActionKind; uuid: string } | undefined {
	const idx = id.indexOf(":");
	if (idx <= 0) return undefined;
	const kind = id.slice(0, idx);
	const uuid = id.slice(idx + 1);
	if (!uuid) return undefined;
	if (!(SYNTHETIC_ACTION_KINDS as readonly string[]).includes(kind)) return undefined;
	return { kind: kind as SyntheticActionKind, uuid };
}

/** True when `id` is one of our namespaced synthetic action ids (not a workflow ask/gate id). */
export function isSyntheticActionId(id: string): boolean {
	return parseSyntheticActionId(id) !== undefined;
}

/**
 * Decide whether a typed (non-button) inbound text should be redirected to
 * `/menu` guidance instead of executed or injected.
 *
 * - exact `/menu`              → not redirected (it is the trigger itself).
 * - existing config command    → not redirected (handled by the config parser).
 * - any other `/`-command      → redirected with menu guidance.
 * - denied (`/model <args>`, destructive, shell/eval) → redirected with the
 *   policy reason plus menu guidance.
 * - ordinary text              → not redirected (free-text injection).
 */
export type RedirectDecision = { redirect: false } | { redirect: true; message: string };

export function redirectTypedSlash(text: string): RedirectDecision {
	if (parseMenuTrigger(text)) return { redirect: false };
	const cls = classifyTypedSlash(text);
	switch (cls.kind) {
		case "not_command":
		case "config":
			return { redirect: false };
		case "denied":
			return { redirect: true, message: `${cls.reason}. ${MENU_GUIDANCE}` };
		case "command":
			return { redirect: true, message: MENU_GUIDANCE };
	}
}

/**
 * Decide how the notifications inbound path should treat a free-text Telegram
 * message, BEFORE it is injected as a user turn. Keeps the index.ts glue thin
 * and unit-testable.
 *
 * - `open_menu`   — exact `/menu`: render the top-level palette.
 * - `guidance`    — a raw typed command (or denied command): post `message`
 *   instead of injecting/executing it.
 * - `passthrough` — ordinary text (or config command): let the existing
 *   user_message / config_command handling proceed unchanged.
 */
export type MenuInboundDecision =
	| { kind: "open_menu" }
	| { kind: "guidance"; message: string }
	| { kind: "passthrough" };

export function decideMenuInbound(text: string): MenuInboundDecision {
	if (parseMenuTrigger(text)) return { kind: "open_menu" };
	const redirect = redirectTypedSlash(text);
	if (redirect.redirect) return { kind: "guidance", message: redirect.message };
	return { kind: "passthrough" };
}

/** Re-export the canonical category order for menu construction convenience. */
export { MENU_CATEGORIES };
