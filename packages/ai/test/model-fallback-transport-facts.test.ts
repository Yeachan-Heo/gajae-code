import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Context, FetchImpl, Model } from "@gajae-code/ai";
import {
	assertManagedAttempt,
	beginAttempt,
	classifyFallbackTrigger,
	getBundledModel,
	streamAnthropic,
	streamOpenAICompletions,
	transportFailureFacts,
} from "@gajae-code/ai";

describe("fallback transport facts", () => {
	it("emits transport facts for SDK provider errors", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6") as Model<"anthropic-messages">;
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
		const providerError = Object.assign(new Error("rate limited"), {
			status: 429,
			code: "rate_limit_error",
			headers: new Headers({ "retry-after": "7" }),
		});
		const client = {
			messages: {
				create: (() => {
					throw providerError;
				}) as unknown as Anthropic["messages"]["create"],
			},
		} as Anthropic;

		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.transportFailure).toMatchObject({
			kind: "transport",
			status: 429,
			providerCode: "rate_limit_error",
		});
		expect(result.transportFailure?.headers).toBeInstanceOf(Headers);
		expect(
			result.transportFailure?.headers instanceof Headers
				? result.transportFailure.headers.get("retry-after")
				: undefined,
		).toBe("7");
	});

	it("emits transport facts captured from fetch error responses", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
		const fetch = (async () =>
			new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "quota exhausted" } }), {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "11" },
			})) as unknown as FetchImpl;

		const result = await streamOpenAICompletions(model, context, { apiKey: "test-key", fetch }).result();

		expect(result.transportFailure).toMatchObject({
			kind: "transport",
			status: 429,
			providerCode: "insufficient_quota",
		});
		expect(result.transportFailure?.headers).toBeInstanceOf(Headers);
		expect(
			result.transportFailure?.headers instanceof Headers
				? result.transportFailure.headers.get("retry-after")
				: undefined,
		).toBe("11");
	});
	it("classifies typed provider failures and Retry-After headers", () => {
		expect(
			classifyFallbackTrigger({
				kind: "transport",
				status: 429,
				headers: new Headers({ "retry-after": "2" }),
			}),
		).toEqual({ class: "rate_limit", retryAfterMs: 2000 });
		expect(
			classifyFallbackTrigger({
				kind: "transport",
				status: 429,
				providerCode: "insufficient_quota",
				headers: new Headers({ "retry-after-ms": "125" }),
			}),
		).toEqual({ class: "quota", retryAfterMs: 125 });
		expect(classifyFallbackTrigger({ kind: "transport", status: 401 })).toEqual({ class: "auth" });
		expect(classifyFallbackTrigger({ kind: "transport", status: 503 })).toEqual({ class: "server" });
	});

	it("normalizes provider transport metadata without parsing error text", () => {
		const quotaError = Object.assign(new Error("provider response"), {
			status: 429,
			code: "insufficient_quota",
			headers: new Headers({ "retry-after-ms": "125" }),
		});
		const quotaFacts = transportFailureFacts(quotaError);
		expect(quotaFacts).toMatchObject({ kind: "transport", status: 429, providerCode: "insufficient_quota" });
		expect(quotaFacts?.headers).toBeInstanceOf(Headers);
		expect(classifyFallbackTrigger(quotaFacts)).toEqual({ class: "quota", retryAfterMs: 125 });

		expect(classifyFallbackTrigger(transportFailureFacts({ status: 401 }))).toEqual({ class: "auth" });
		expect(classifyFallbackTrigger(transportFailureFacts({ status: 503 }))).toEqual({ class: "server" });
		expect(transportFailureFacts({ code: "invalid_api_key" })).toMatchObject({
			kind: "transport",
			providerCode: "invalid_api_key",
		});
	});

	it("does not attach transport facts to non-transport provider errors", () => {
		const applicationError = Object.assign(new Error("tool schema validation failed"), {
			code: "invalid_tool_schema",
		});
		expect(transportFailureFacts(applicationError)).toBeUndefined();
		expect(classifyFallbackTrigger(transportFailureFacts(applicationError))).toEqual({ class: "other" });
	});

	it("preserves Retry-After header units and dates", () => {
		const future = new Date(Date.now() + 10_000).toUTCString();
		const past = new Date(Date.now() - 10_000).toUTCString();
		const classify = (headers: Record<string, string>) =>
			classifyFallbackTrigger({ kind: "transport", status: 429, headers });

		expect(classify({ "retry-after": "2" })).toEqual({ class: "rate_limit", retryAfterMs: 2000 });
		expect(classify({ "retry-after-ms": "125" })).toEqual({ class: "rate_limit", retryAfterMs: 125 });
		expect(classify({ "retry-after-ms": "12.5" })).toEqual({ class: "rate_limit", retryAfterMs: 13 });
		expect(classify({ "retry-after-ms": "invalid" })).toEqual({ class: "rate_limit" });
		expect(classify({ "retry-after": future }).retryAfterMs).toBeGreaterThan(8_000);
		expect(classify({ "retry-after": past })).toEqual({ class: "rate_limit", retryAfterMs: 0 });
	});

	it("does not classify application error text as a transport failure", () => {
		for (const message of ["internal error", "rate limit exceeded", "invalid API key"]) {
			expect(classifyFallbackTrigger(new Error(message))).toEqual({ class: "other" });
		}
	});

	it("issues an opaque marker for exactly one managed invocation", () => {
		const token = beginAttempt("provider/model", 3);
		expect(token).toMatchObject({ modelKey: "provider/model", attemptId: 3 });
		assertManagedAttempt({ fallbackManaged: true, fallbackAttempt: token });
		expect(() => assertManagedAttempt({ fallbackManaged: true, fallbackAttempt: token })).toThrow("cannot reuse");
	});

	it("rejects forged managed attempt tokens", () => {
		expect(() =>
			assertManagedAttempt({
				fallbackManaged: true,
				fallbackAttempt: { modelKey: "provider/model", attemptId: 3 } as ReturnType<typeof beginAttempt>,
			}),
		).toThrow("requires a token");
	});
});
