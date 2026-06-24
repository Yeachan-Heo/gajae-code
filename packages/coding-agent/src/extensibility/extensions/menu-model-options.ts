/**
 * Pure construction of the Telegram `/menu` model picker options.
 *
 * The picker always offers a curated DEFAULT set (so common models are
 * selectable even before they appear in this session's recent-usage history),
 * with the current model pinned first and recent-usage models filling the rest.
 * Everything is intersected with the session's actually-available models so a
 * tap never resolves to a model with no configured provider/API key.
 *
 * Pure module: no I/O, no session imports (only the shared option type).
 */

import type { MenuModelOption } from "./types";

/** A model the session can actually switch to, reduced to ref + display label. */
export interface AvailableModelLite {
	ref: string;
	label: string;
}

/**
 * Curated default models offered in the picker, in render order. `ref` is the
 * canonical `provider/id`; `label` is the friendly button text. Only entries
 * that are actually available in the session are shown.
 */
export const DEFAULT_MENU_MODELS: ReadonlyArray<{ ref: string; label: string }> = [
	{ ref: "anthropic/claude-opus-4-8", label: "claude-opus-4-8" },
	{ ref: "openai-codex/gpt-5.5", label: "gpt-5.5" },
	{ ref: "opencode-go/glm-5.2", label: "glm-5.2" },
	{ ref: "cursor/composer-2.5", label: "composer-2.5" },
];

/** Default cap on rendered model buttons (Telegram inline keyboards stay small). */
export const DEFAULT_MAX_MODEL_OPTIONS = 8;

/**
 * Build the ordered, deduped, availability-filtered model option list:
 * current model first (marked), then the curated defaults, then recent-usage
 * models. Friendly default labels win over the raw model id.
 */
export function buildMenuModelOptions(input: {
	available: readonly AvailableModelLite[];
	currentRef?: string;
	mruRefs?: readonly string[];
	max?: number;
}): MenuModelOption[] {
	const { available, currentRef, mruRefs = [], max = DEFAULT_MAX_MODEL_OPTIONS } = input;
	const availableByRef = new Map(available.map(model => [model.ref, model] as const));
	const defaultLabelByRef = new Map(DEFAULT_MENU_MODELS.map(model => [model.ref, model.label] as const));

	const options: MenuModelOption[] = [];
	const seen = new Set<string>();
	const labelFor = (ref: string): string => defaultLabelByRef.get(ref) ?? availableByRef.get(ref)?.label ?? ref;

	const push = (ref: string, current?: boolean): void => {
		if (seen.has(ref) || !availableByRef.has(ref)) return;
		options.push(current ? { ref, label: labelFor(ref), current: true } : { ref, label: labelFor(ref) });
		seen.add(ref);
	};

	if (currentRef) push(currentRef, true);
	for (const model of DEFAULT_MENU_MODELS) push(model.ref);
	for (const ref of mruRefs) push(ref);

	return options.slice(0, max);
}
