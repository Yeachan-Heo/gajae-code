import type { AssistantMessage, Model } from "@gajae-code/ai/core";
import { truncateToWidth } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import { resolveSelector } from "../config/model-resolver";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "../config/model-selector-value";
import { splitSelectorThinkingSuffix } from "../thinking";
import { isLegacyProviderSafetyStopMessage } from "./provider-safety-stop";

/**
 * Manual model-switch command shown after a provider safety stop. Must stay in
 * sync with the canonical `/model` slash command surface (builtin-registry).
 */
const MODEL_SWITCH_COMMAND = "/model";

/**
 * Hard display bound for the model selector interpolated into the hint. Custom
 * and discovered model IDs are user/config-controlled strings, so the hint must
 * stay bounded no matter how long or hostile the configured entry is.
 */
const MODEL_SELECTOR_MAX_DISPLAY_WIDTH = 64;

/**
 * Unicode format characters (Cf): zero-width joiners/spaces, bidi overrides,
 * soft hyphens. `sanitizeText` covers ANSI and C0/C1/DEL but not these, and a
 * bidi override inside a custom model ID could visually reorder the hint line.
 */
const UNICODE_FORMAT_RE = /\p{Cf}/gu;

/**
 * Normalize a model selector for display: strip ANSI escape sequences and
 * control characters, remove Unicode format characters, replace tabs with
 * spaces, and bound the width. One shared implementation so the TUI render and
 * the print-mode stderr render interpolate the identical safe value (#4653
 * review: centralize selector sanitization instead of leaving each surface to
 * bound itself).
 */
export function sanitizeModelSelectorForDisplay(selector: string): string {
	const withoutControl = sanitizeText(selector.replaceAll("\t", " ").trim()).replace(UNICODE_FORMAT_RE, "");
	return truncateToWidth(withoutControl, MODEL_SELECTOR_MAX_DISPLAY_WIDTH);
}
/**
 * Session capabilities the hint resolver reads. Everything is optional so
 * lightweight host/test contexts without model plumbing degrade to the static
 * guidance instead of throwing.
 */
export interface ProviderSafetyStopHintSession {
	getConfiguredModelChainState?(
		role: string,
	): { entries: readonly string[]; origin: string; identity?: string; explicitHead: boolean } | undefined;
	settings?: { getModelRole?(role: string): ModelSelectorValue | undefined };
	getAvailableModels?(): Model[];
}

/** Whether an assistant message terminated as a provider safety stop (typed or legacy-persisted). */
export function isProviderSafetyStop(message: AssistantMessage): boolean {
	return (
		message.errorKind === "provider_safety_stop" ||
		(message.errorMessage !== undefined && isLegacyProviderSafetyStopMessage(message.errorMessage))
	);
}

/**
 * The `provider/id` identity of the model that produced an assistant message.
 * The message's own `provider`/`model` fields are the authoritative identity of
 * the refusing attempt (they survive model switches after the error).
 */
export function refusingModelSelector(message: AssistantMessage): string | undefined {
	if (!message.provider || !message.model) return undefined;
	return `${message.provider}/${message.model}`;
}

/**
 * Resolve a safe, valid alternate model selector from the default role's
 * configured chain — one that is NOT the model that refused. Presentation-only:
 * reads configured intent, dispatches nothing, and mutates nothing (#4650).
 *
 * An entry is named only when the authoritative model selector resolver accepts
 * it (`resolveSelector` with `allowInvalidThinkingSelectorFallback: false`, so
 * malformed suffixes like `:bogus` fail closed while route-suffixed IDs keep
 * their exact-ID semantics) AND the concrete model it resolves to differs from
 * the refuser.
 *
 * The returned selector is RECONSTRUCTED from the resolved model — always
 * `provider/id` qualified, never the original entry (#4653 review: the hint
 * resolver runs without usage-preference context, so a bare/fuzzy/glob entry
 * that resolves here can paste-resolve differently under the real `/model`
 * command's usage-preference context; a provider-qualified selector pins the
 * advertised command to exactly the model that was validated). Only a thinking
 * suffix that itself validated is carried over, so the suggested command is one
 * the resolver parses with identical semantics.
 */
export function resolveSafetyStopAlternateSelector(
	refuserSelector: string | undefined,
	chain: ModelSelectorValue | readonly string[] | undefined,
	availableModels: readonly Model[],
): string | undefined {
	if (!refuserSelector) return undefined;
	const entries = Array.isArray(chain)
		? chain.map(entry => String(entry))
		: normalizeModelSelectorValue(chain as ModelSelectorValue | undefined);
	if (entries.length === 0) return undefined;
	const candidates = [...availableModels];
	const refuserParsed = resolveSelector(refuserSelector, candidates, {
		allowInvalidThinkingSelectorFallback: false,
	}).model;
	// The refuser must itself resolve; otherwise identity comparison is unsafe
	// and only static guidance is honest.
	if (!refuserParsed) return undefined;
	const refuserBaseId = splitSelectorThinkingSuffix(refuserParsed.id).selector;
	for (const entry of entries) {
		const resolved = resolveSelector(entry, candidates, {
			allowInvalidThinkingSelectorFallback: false,
		});
		// Only offer entries the resolver fully accepts, and never the refuser
		// itself (a bare thinking-level change is not an alternate model).
		const resolvedModel = resolved.model;
		if (!resolvedModel) continue;
		if (
			resolvedModel.provider === refuserParsed.provider &&
			splitSelectorThinkingSuffix(resolvedModel.id).selector === refuserBaseId
		) {
			continue;
		}
		// Reconstruct from the resolved model: a provider-qualified selector is
		// exact-pin semantics in every resolver context, so the advertised
		// command names the model that was actually validated here. The resolved
		// model's own id is kept verbatim (route suffixes in `id` are legal).
		return resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined
			? `${resolvedModel.provider}/${resolvedModel.id}:${resolved.thinkingLevel}`
			: `${resolvedModel.provider}/${resolvedModel.id}`;
	}
	return undefined;
}

/**
 * Bounded guidance shown after a provider safety stop: the failure is
 * model-specific, the context need not be discarded, and the session continues
 * after a manual switch. The configured alternate and the canonical manual
 * switch command are named only when a validated alternate was resolved; the
 * hint never claims the alternate is guaranteed to accept the same context.
 */
export function formatProviderSafetyStopHint(alternateSelector: string | undefined): string {
	const head =
		"Provider safety stop: the provider refused this request and the turn ended without retry. Such refusals are often specific to the (model, context) pair — this conversation is not necessarily at fault and does not need to be discarded.";
	const safeSelector = alternateSelector ? sanitizeModelSelectorForDisplay(alternateSelector) : undefined;
	const tail = safeSelector
		? `The session can continue after a manual model switch. Your default model chain also contains "${safeSelector}" — to try it, run: ${MODEL_SWITCH_COMMAND} ${safeSelector}. Success is not guaranteed, but the same context frequently works on a different model.`
		: `The session can continue after a manual model switch: run ${MODEL_SWITCH_COMMAND} <provider/model> or open the model selector with ${MODEL_SWITCH_COMMAND}.`;
	return `${head} ${tail}`;
}

/**
 * Resolve the hint to display for a terminal provider safety stop, against the
 * session's current configured default chain and available catalog. Returns a
 * hint string for safety stops (static guidance when no valid alternate can be
 * named) and `undefined` for every other error kind, so unrelated errors keep
 * their existing rendering untouched.
 */
export function resolveProviderSafetyStopHint(
	message: AssistantMessage,
	session: ProviderSafetyStopHintSession | undefined,
): string | undefined {
	if (!isProviderSafetyStop(message)) return undefined;
	let alternateSelector: string | undefined;
	if (session) {
		const chain =
			session.getConfiguredModelChainState?.("default")?.entries ?? session.settings?.getModelRole?.("default");
		const availableModels = typeof session.getAvailableModels === "function" ? session.getAvailableModels() : [];
		alternateSelector = resolveSafetyStopAlternateSelector(refusingModelSelector(message), chain, availableModels);
	}
	return formatProviderSafetyStopHint(alternateSelector);
}

/**
 * Compose the display error line for a provider safety stop: the provider's own
 * refusal text is always retained verbatim, with the hint appended on a new
 * line. Returns `undefined` for non-safety-stop errors.
 */
export function formatProviderSafetyStopDisplayError(
	message: AssistantMessage,
	alternateSelector: string | undefined,
): string | undefined {
	if (!isProviderSafetyStop(message)) return undefined;
	const raw = message.errorMessage && message.errorMessage.length > 0 ? message.errorMessage : undefined;
	const hint = formatProviderSafetyStopHint(alternateSelector);
	return raw ? `${raw}\n${hint}` : hint;
}
