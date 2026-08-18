import type { AssistantMessage, Model } from "@gajae-code/ai/core";
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
 * the refuser. The named entry is the chain entry itself, so the suggested
 * `/model` command is one the resolver actually parses.
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
		}).model;
		// Only offer entries the resolver fully accepts, and never the refuser
		// itself (a bare thinking-level change is not an alternate model).
		if (!resolved) continue;
		if (
			resolved.provider === refuserParsed.provider &&
			splitSelectorThinkingSuffix(resolved.id).selector === refuserBaseId
		) {
			continue;
		}
		return entry;
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
	const tail = alternateSelector
		? `The session can continue after a manual model switch. Your default model chain also contains "${alternateSelector}" — to try it, run: ${MODEL_SWITCH_COMMAND} ${alternateSelector}. Success is not guaranteed, but the same context frequently works on a different model.`
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
