import type { AssistantMessage } from "../types";

/**
 * Terminal provider safety-stop authority (issue #4777 review follow-up).
 *
 * `errorKind: "provider_safety_stop"` makes a failure terminal: retry policy
 * suppresses it and managed fallback never advances the chain to another
 * model. When that authority traveled as plain message data, any provider or
 * custom stream payload could self-label a refusal and deny the user their
 * configured fallback — a compromised endpoint could force refusal by naming
 * the typed kind.
 *
 * Authority therefore never travels on the data channel. It lives in this
 * module-scoped {@link WeakSet}, minted only by {@link applyProviderSafetyStop}
 * when first-party adapter code calls it with a structured refusal signal it
 * actually parsed from the provider's response (Anthropic `stop_reason`
 * refusal/sensitive, OpenAI `content_filter`, Google prompt/candidate block
 * reasons). Every re-entry boundary re-checks identity: structured clones,
 * JSON round-trips, persisted-and-reloaded messages, and re-emitted stream
 * payloads are new objects and carry no authority, so transport and
 * persistence can preserve the label for display but can never upgrade an
 * unauthenticated payload into a terminal stop.
 */
const authenticatedProviderSafetyStops = new WeakSet<object>();

/**
 * Structured refusal vocabulary per first-party adapter. The google entries
 * mirror the closed lists in `google-shared.ts`
 * (`isGoogleCandidateSafetyStopReason` / `isGooglePromptSafetyStopReason`);
 * keep them in sync.
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
 * Mint terminal safety-stop authority for one message object. Adapter-side
 * use only: call it at the parse site, with the structured refusal signal that
 * was actually validated against the provider's response. An unrecognized
 * signal fails closed — the message keeps whatever it had and gains no
 * authority — so an adapter bug degrades to ordinary fallback, never to a
 * forced refusal.
 *
 * Returns whether authority was minted.
 */
export function applyProviderSafetyStop(message: AssistantMessage, signal: string): boolean {
	if (!STRUCTURED_REFUSAL_SIGNALS.has(signal)) return false;
	authenticatedProviderSafetyStops.add(message);
	message.errorKind = "provider_safety_stop";
	return true;
}

/**
 * Identity check for terminal safety-stop authority. True only for the exact
 * object a first-party adapter marked in this process. Copies, clones,
 * JSON/persistence round-trips, and fresh objects carrying the field are all
 * unauthenticated — data alone is never terminal.
 */
export function isProviderSafetyStopAuthenticated(message: unknown): boolean {
	return typeof message === "object" && message !== null && authenticatedProviderSafetyStops.has(message);
}
/**
 * Transfer terminal safety-stop authority from a live marked message onto the
 * rebuilt message a boundary constructed from it. Callers can never mint
 * authority: the target is marked only when the source already was. Used by
 * the managed snapshot shell so the rebuilt assistant message keeps provenance
 * across the clone boundary (#4777).
 */
export function transferProviderSafetyStop(from: unknown, to: AssistantMessage): void {
	if (typeof from === "object" && from !== null && authenticatedProviderSafetyStops.has(from)) {
		authenticatedProviderSafetyStops.add(to);
	}
}
