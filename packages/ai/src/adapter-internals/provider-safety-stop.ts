import type { AssistantMessage } from "../types";

/** This module is intentionally outside the package export map. */
const PROVIDER_SAFETY_STOP_ADAPTER_BRAND = Symbol("provider-safety-stop-adapter-brand");

export type ProviderSafetyStopAdapterCapability = {
	readonly [PROVIDER_SAFETY_STOP_ADAPTER_BRAND]: true;
};

/** The one unforgeable capability shared by first-party adapter parse sites. */
export const PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY = Object.freeze({
	[PROVIDER_SAFETY_STOP_ADAPTER_BRAND]: true,
}) as ProviderSafetyStopAdapterCapability;

const authenticatedProviderSafetyStops = new WeakSet<object>();

/**
 * Structured refusal vocabulary per first-party adapter. The Google entries
 * mirror the closed lists in `google-shared.ts`.
 */
const STRUCTURED_REFUSAL_SIGNALS: ReadonlySet<string> = new Set([
	// anthropic-messages: stop_reason / stop_details.type
	"refusal",
	"sensitive",
	// openai-completions: finish_reason / error.code
	"content_filter",
	// google-generative-ai: candidate finishReason
	"SAFETY",
	"IMAGE_SAFETY",
	"PROHIBITED_CONTENT",
	"IMAGE_PROHIBITED_CONTENT",
	"SPII",
	"BLOCKLIST",
	"RECITATION",
	"IMAGE_RECITATION",
	"MODEL_ARMOR",
	// google-generative-ai: promptFeedback.blockReason
	"JAILBREAK",
]);

/**
 * Mint terminal authority only from a first-party adapter parse site. The
 * capability is branded by a module-private symbol and is not available from
 * the public `@gajae-code/ai` surface. An unrecognized structured signal fails
 * closed, so adapter mistakes remain fallback-eligible.
 */
export function mintProviderSafetyStop(
	message: AssistantMessage,
	signal: string,
	capability: ProviderSafetyStopAdapterCapability,
): boolean {
	if (capability !== PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY || !STRUCTURED_REFUSAL_SIGNALS.has(signal)) return false;
	authenticatedProviderSafetyStops.add(message);
	message.errorKind = "provider_safety_stop";
	return true;
}

/**
 * Restore authority for a message that crossed a first-party trusted
 * transport boundary (the pi-native auth-gateway loopback channel). The
 * gateway serializes an adapter-minted message to SSE and the client parses
 * a fresh object, which loses the process-local mark. The typed kind is only
 * ever written by a first-party mint on the gateway side, so a terminal
 * error pair arriving over that channel re-establishes exactly the authority
 * serialization dropped — it never creates authority for a message the
 * gateway did not already authenticate (#4777 review follow-up).
 */
export function restoreProviderSafetyStopFromTrustedTransport(
	message: AssistantMessage,
	capability: ProviderSafetyStopAdapterCapability,
): boolean {
	if (capability !== PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY) return false;
	if (message.stopReason !== "error" || message.errorKind !== "provider_safety_stop") return false;
	authenticatedProviderSafetyStops.add(message);
	return true;
}

/** Identity check for terminal provider safety-stop authority. */
export function isProviderSafetyStopAuthenticated(message: unknown): boolean {
	return typeof message === "object" && message !== null && authenticatedProviderSafetyStops.has(message);
}

/**
 * Drop terminal authority for a message. Exposing revocation publicly is
 * safe by construction: it can only remove authority, never grant it, so a
 * hostile caller cannot use it to forge a stop — only to degrade a genuine
 * one to an ordinary fallback-eligible error. The managed runtime uses it to
 * expire marks once a stop has been adjudicated, before the committed
 * message is exposed to later stream dispatches (#4777 review follow-up).
 */
export function revokeProviderSafetyStop(message: unknown): void {
	if (typeof message !== "object" || message === null) return;
	authenticatedProviderSafetyStops.delete(message);
}
