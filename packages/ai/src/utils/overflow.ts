import type { AssistantMessage } from "../types";
import type { TransportFailureFacts } from "./fallback-transport";

/**
 * Regex patterns to detect context overflow errors from different providers.
 *
 * These patterns match error messages returned when the input exceeds
 * the model's context window.
 *
 * Provider-specific patterns (with example error messages):
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - Anthropic 413: "request_too_large" / "Request exceeds the maximum size" (payload too large)
 * - HTTP 413 variants: "Payload Too Large" / "Request Entity Too Large"
 * - z.ai / GLM: Returns finish_reason: "model_context_window_exceeded" mapped to error message
 * - z.ai: Does NOT error, accepts overflow silently - handled via usage.input > contextWindow
 * - Ollama: Silently truncates input - not detectable via error message
 */
const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (all backends)
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/requested tokens?.*exceed.*context (window|length|size)/i, // llama.cpp / OpenAI-compatible local servers
	/context (window|length|size).*(exceeded|overflow|too small)/i, // Generic local server variants
	/(prompt|input).*(too long|too large).*(context|n_ctx)/i, // llama.cpp phrasing variants
	/requested tokens?.*(exceeds?|greater than).*(n_ctx|context)/i, // llama.cpp n_ctx variants
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
	/request_too_large/i, // Anthropic 413 (request body too large)
	/request exceeds the maximum size/i, // Anthropic 413 variant
	/payload too large/i, // Generic HTTP 413 variant
	/entity too large/i, // Generic HTTP 413 variant
	/\b413\b.*\b(request|payload|entity)\b.*\btoo large\b/i, // "413 Request Entity Too Large" variants
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
];
/**
 * Threshold below which a "successful" (stopReason "stop") response with empty
 * content is considered anomalous. Some proxies (notably LiteLLM) return an
 * empty `choices[0].message.content` with a near-zero `usage` (e.g. input: 1,
 * output: 1) when the upstream model context window is exceeded, instead of
 * surfacing a proper error. The total token count for such a response is well
 * below any realistic turn, so we treat it as a proxy-level overflow signal.
 */
const EMPTY_RESPONSE_USAGE_THRESHOLD = 5;
/**
 * Check if an assistant message represents a context overflow error.
 *
 * This handles three cases:
 * 1. Error-based overflow: Most providers return stopReason "error" with a
 *    specific error message pattern.
 * 2. Silent overflow: Some providers accept overflow requests and return
 *    successfully. For these, we check if usage.input exceeds the context window.
 * 3. Proxy-level overflow: Some proxies (e.g. LiteLLM) return a "successful"
 *    response with empty content and a fabricated near-zero usage when the
 *    upstream model's context window is exceeded.
 *
 * ## Reliability by Provider
 *
 * **Reliable detection (returns error with detectable message):**
 * - Anthropic: "prompt is too long: X tokens > Y maximum"
 * - OpenAI (Completions & Responses): "exceeds the context window"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI (Grok): "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - Cerebras: 400/413 status code (no body)
 * - Mistral: 400/413 status code (no body)
 * - HTTP 413 payload/entity-too-large variants
 * - OpenRouter (all backends): "maximum context length is X tokens"
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 * - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
 * - Anthropic 413: "request_too_large" (request body exceeds size limit)
 * - HTTP 413: "Payload Too Large" / "Request Entity Too Large"
 *
 * **Unreliable detection:**
 * - z.ai: Sometimes accepts overflow silently (detectable via usage.input > contextWindow),
 *   sometimes returns rate limit errors. Pass contextWindow param to detect silent overflow.
 * - Ollama: Silently truncates input without error. Cannot be detected via this function.
 * - LiteLLM proxy: Returns a "successful" response with empty content and a
 *   fabricated near-zero usage (e.g. input: 1, output: 1) when the upstream
 *   model's context window is exceeded. Detected via Case 3 (empty content +
 *   anomalously low usage). Note: the LiteLLM proxy's context limit may differ
 *   from the underlying model's advertised contextWindow (e.g. configured via
 *   `model_info.max_tokens` in LiteLLM's config.yaml), so Case 2 (which compares
 *   usage.input against contextWindow) may not catch it.
 *   The response will have usage.input < expected, but we don't know the expected value.
 *
 * ## Custom Providers
 *
 * If you've added custom models via settings.json, this function may not detect
 * overflow errors from those providers. To add support:
 *
 * 1. Send a request that exceeds the model's context window
 * 2. Check the errorMessage in the response
 * 3. Create a regex pattern that matches the error
 * 4. The pattern should be added to OVERFLOW_PATTERNS in this file, or
 *    check the errorMessage yourself before calling this function
 *
 * @param message - The assistant message to check
 * @param contextWindow - Optional context window size for detecting silent overflow (z.ai)
 * @returns true if the message indicates a context overflow
 */
/**
 * Authoritatively classify a context overflow from the assistant result and
 * normalized transport facts. Typed facts take precedence over provider prose:
 * an explicit non-overflow transport failure cannot be upgraded by hostile or
 * misleading error text.
 */
const OVERFLOW_PROVIDER_CODES = new Set(["context_length_exceeded", "request_too_large"]);
const NON_OVERFLOW_PROVIDER_CODES = new Set([
	"invalid_request_error",
	"authentication_error",
	"invalid_api_key",
	"invalid_token",
	"token_expired",
	"unauthorized",
	"forbidden",
	"insufficient_quota",
	"quota_exceeded",
	"quota_exhausted",
	"usage_limit_reached",
	"usage_not_included",
	"out_of_credits",
	"rate_limit",
	"rate_limit_error",
	"rate_limit_exceeded",
	"too_many_requests",
]);

function transportCodes(transportFailure: TransportFailureFacts | undefined): string[] {
	return [transportFailure?.openaiErrorCode, transportFailure?.anthropicErrorType, transportFailure?.providerCode]
		.filter((code): code is string => typeof code === "string")
		.map(code => code.toLowerCase());
}

function hasTypedNonOverflowCode(transportFailure: TransportFailureFacts | undefined): boolean {
	return transportCodes(transportFailure).some(code => NON_OVERFLOW_PROVIDER_CODES.has(code));
}

function isTypedNoBodyOverflow(
	message: AssistantMessage,
	transportFailure: TransportFailureFacts | undefined,
): boolean {
	if (transportFailure?.status !== 400 && transportFailure?.status !== 413) return false;
	return !message.errorMessage || /\b4(00|13)\s*(status code)?\s*\(no body\)/i.test(message.errorMessage);
}

export function classifyContextOverflow(
	message: AssistantMessage,
	transportFailure?: TransportFailureFacts,
	contextWindow?: number,
): boolean {
	if (transportFailure?.status === 429) return false;
	const typedCodes = transportCodes(transportFailure);
	if (typedCodes.some(code => OVERFLOW_PROVIDER_CODES.has(code))) return true;
	if (hasTypedNonOverflowCode(transportFailure)) return false;
	if (isTypedNoBodyOverflow(message, transportFailure)) return true;

	const errorMessage = message.errorMessage;
	if (message.stopReason === "error" && errorMessage) {
		if (OVERFLOW_PATTERNS.some(pattern => pattern.test(errorMessage))) return true;
		if (/\b4(00|13)\s*(status code)?\s*\(no body\)/i.test(errorMessage)) return true;
	}

	if (contextWindow) {
		const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		if (inputTokens > contextWindow) return true;
	}

	return (
		message.stopReason === "stop" &&
		message.content.length === 0 &&
		message.usage.input + message.usage.output <= EMPTY_RESPONSE_USAGE_THRESHOLD
	);
}

/**
 * Check if an assistant message represents a context overflow error.
 *
 * Callers with normalized transport facts should use {@link classifyContextOverflow}
 * so typed provider codes take precedence over error prose.
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	return classifyContextOverflow(message, undefined, contextWindow);
}

/**
 * Get the overflow patterns for testing purposes.
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
