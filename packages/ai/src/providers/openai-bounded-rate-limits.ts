import type { FetchImpl } from "../types";
import { getRetryAfterMsFromHeaders } from "../utils/retry-after";

const OPENAI_RETRY_DELAY_CAP_MS = 60_000;

// Mirror of `wrapAnthropicFetchForBoundedRateLimits`: OpenAI-compatible providers
// (e.g. opencode-go) return HTTP 429 for *permanent* usage/quota exhaustion — a
// monthly-cap reset that can be days away. The OpenAI SDK treats 429 as transient
// and retries up to `maxRetries`, honoring an out-of-range `Retry-After`; the
// `create()` call then hangs before the error can surface to the agent loop, so
// no assistant error is produced and the session-level retry/fallback never runs.
// Detect exhaustion and set `x-should-retry: false` so the SDK gives up at once
// and the session retry layer applies its own fail-fast (retry-after > maxDelayMs).
//
// Shared by every adapter that drives a raw OpenAI SDK client — openai-completions,
// openai-responses, and azure-openai-responses. Adapters that route through
// `fetchWithRetry` (codex, bedrock, ollama, gemini-cli) already bound 429 retries
// themselves and do not need this wrapper.
export function isOpenAIUsageExhaustionResponse(
	bodyText: string,
	retryAfterMs: number | undefined,
	retryDelayCapMs: number,
): boolean {
	if (retryAfterMs !== undefined && retryAfterMs > retryDelayCapMs) return true;
	return /monthly usage limit|usage limit reached|usage_limit_reached|out_of_credits|insufficient_quota|quota[ _]?exceeded/i.test(
		bodyText,
	);
}

export function wrapOpenAIFetchForBoundedRateLimits(
	baseFetch: FetchImpl,
	maxRetryDelayMs: number | undefined,
): FetchImpl {
	const retryDelayCapMs = maxRetryDelayMs ?? OPENAI_RETRY_DELAY_CAP_MS;
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const response = await baseFetch(input, init);
			if (response.status !== 429 || retryDelayCapMs === 0) return response;

			const headers = new Headers(response.headers);
			const retryAfterMs = getRetryAfterMsFromHeaders(headers);
			const bodyText = await response
				.clone()
				.text()
				.catch(() => "");
			if (!isOpenAIUsageExhaustionResponse(bodyText, retryAfterMs, retryDelayCapMs)) return response;

			headers.set("x-should-retry", "false");
			return new Response(bodyText, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		},
		baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {},
	);
}
