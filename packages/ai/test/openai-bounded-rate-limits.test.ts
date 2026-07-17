import { describe, expect, it } from "bun:test";
import {
	isOpenAIUsageExhaustionResponse,
	wrapOpenAIFetchForBoundedRateLimits,
} from "@gajae-code/ai/providers/openai-bounded-rate-limits";

describe("isOpenAIUsageExhaustionResponse", () => {
	it("flags an out-of-range Retry-After as exhaustion", () => {
		expect(isOpenAIUsageExhaustionResponse("", 20 * 60_000, 60_000)).toBe(true);
	});

	it("does not flag a short Retry-After without a body marker", () => {
		expect(isOpenAIUsageExhaustionResponse("", 5_000, 60_000)).toBe(false);
	});

	it("flags monthly usage-limit body copy (opencode-go)", () => {
		expect(
			isOpenAIUsageExhaustionResponse("Monthly usage limit reached. Resets in 15 days.", undefined, 60_000),
		).toBe(true);
	});

	it("flags out_of_credits / insufficient_quota bodies", () => {
		expect(isOpenAIUsageExhaustionResponse('{"error":{"type":"insufficient_quota"}}', undefined, 60_000)).toBe(true);
		expect(isOpenAIUsageExhaustionResponse("out_of_credits", undefined, 60_000)).toBe(true);
	});

	it("does not flag a plain transient 429 body", () => {
		expect(isOpenAIUsageExhaustionResponse("Too Many Requests", 1_000, 60_000)).toBe(false);
	});
});

describe("wrapOpenAIFetchForBoundedRateLimits", () => {
	const makeFetch =
		(status: number, body: string, headers: Record<string, string> = {}) =>
		async (): Promise<Response> =>
			new Response(body, { status, headers });

	it("injects x-should-retry:false on a usage-exhaustion 429", async () => {
		const wrapped = wrapOpenAIFetchForBoundedRateLimits(
			makeFetch(429, "Monthly usage limit reached. Resets in 15 days."),
			60_000,
		);
		const res = await wrapped("https://example/v1/chat/completions");
		expect(res.status).toBe(429);
		expect(res.headers.get("x-should-retry")).toBe("false");
		// Body is preserved so the surfaced error still explains the cause.
		expect(await res.text()).toContain("Monthly usage limit reached");
	});

	it("leaves a transient 429 untouched so the SDK may still retry", async () => {
		const wrapped = wrapOpenAIFetchForBoundedRateLimits(
			makeFetch(429, "Too Many Requests", { "retry-after": "1" }),
			60_000,
		);
		const res = await wrapped("https://example/v1/chat/completions");
		expect(res.headers.get("x-should-retry")).toBeNull();
	});

	it("passes non-429 responses through unchanged", async () => {
		const wrapped = wrapOpenAIFetchForBoundedRateLimits(makeFetch(200, "ok"), 60_000);
		const res = await wrapped("https://example/v1/chat/completions");
		expect(res.status).toBe(200);
		expect(res.headers.get("x-should-retry")).toBeNull();
	});

	it("is disabled when the retry-delay cap is 0", async () => {
		const wrapped = wrapOpenAIFetchForBoundedRateLimits(makeFetch(429, "Monthly usage limit reached."), 0);
		const res = await wrapped("https://example/v1/chat/completions");
		expect(res.headers.get("x-should-retry")).toBeNull();
	});
});
