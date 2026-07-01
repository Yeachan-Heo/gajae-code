import { describe, expect, it } from "bun:test";
import { calculateRateLimitBackoffMs, isUsageLimitError, parseRateLimitReason } from "@gajae-code/ai/rate-limit-utils";

describe("parseRateLimitReason", () => {
	it("classifies Google Quota exceeded as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Quota exceeded for aiplatform.googleapis.com"),
		).toBe("QUOTA_EXHAUSTED");
	});

	// "Resource has been exhausted (e.g. check quota)" is a quota/daily-limit error — long wait.
	// Only the literal phrase "resource exhausted" (gRPC status name) is MODEL_CAPACITY.
	it("classifies 'Resource has been exhausted (e.g. check quota)' as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Resource has been exhausted (e.g. check quota)."),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies 'resource exhausted' (exact gRPC phrase) as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("resource exhausted")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	it("classifies Too many requests as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Cloud Code Assist API error (429): Too many requests")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies per minute errors as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Requests per minute limit reached")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies overloaded 529 as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("Service overloaded 529")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	it("classifies internal server error as SERVER_ERROR", () => {
		expect(parseRateLimitReason("Internal Server Error (500)")).toBe("SERVER_ERROR");
	});

	it("returns UNKNOWN for unrecognised messages", () => {
		expect(parseRateLimitReason("Something completely unexpected happened")).toBe("UNKNOWN");
	});

	it("classifies Codex usage limit error as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Codex error event: The usage limit has been reached (code=usage_limit_reached)"),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies model/message-limit exhaustion as QUOTA_EXHAUSTED", () => {
		expect(parseRateLimitReason("429 model_limit_reached: limit for this model reached")).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("You have reached the message limit for this model")).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies Anthropic account exhaustion as QUOTA_EXHAUSTED", () => {
		expect(parseRateLimitReason("This request would exceed your account's rate limit. Please try again later.")).toBe(
			"QUOTA_EXHAUSTED",
		);
		expect(parseRateLimitReason("anthropic-ratelimit-unified-overage-disabled-reason=out_of_credits")).toBe(
			"QUOTA_EXHAUSTED",
		);
	});
});

describe("calculateRateLimitBackoffMs", () => {
	it("returns 45–75s range for MODEL_CAPACITY_EXHAUSTED (jitter)", () => {
		for (let i = 0; i < 20; i++) {
			const ms = calculateRateLimitBackoffMs("MODEL_CAPACITY_EXHAUSTED");
			expect(ms).toBeGreaterThanOrEqual(45_000);
			expect(ms).toBeLessThanOrEqual(75_000);
		}
	});
});

describe("isUsageLimitError", () => {
	it("detects model/message-limit exhaustion as persistent usage limits", () => {
		expect(isUsageLimitError("429 model_limit_reached: limit for this model reached")).toBe(true);
		expect(isUsageLimitError("You have reached the message limit for this model")).toBe(true);
	});

	it("detects explicit resource-exhausted quota messages but not capacity wording", () => {
		expect(
			isUsageLimitError("Cloud Code Assist API error (429): Resource has been exhausted (e.g. check quota)."),
		).toBe(true);
		expect(isUsageLimitError("resource exhausted")).toBe(false);
	});

	it("detects Anthropic account exhaustion without treating generic retry-after as usage exhaustion", () => {
		expect(isUsageLimitError("This request would exceed your account's rate limit. Please try again later.")).toBe(
			true,
		);
		expect(isUsageLimitError("anthropic-ratelimit-unified-overage-disabled-reason=out_of_credits")).toBe(true);
		expect(isUsageLimitError("429 rate limit exceeded retry-after-ms=62291000")).toBe(false);
		expect(isUsageLimitError("429 rate limit exceeded retry-after-ms=5000")).toBe(false);
	});

	it("does not classify generic rate limits as usage exhaustion", () => {
		expect(isUsageLimitError("429 rate limit exceeded, please retry in 5s")).toBe(false);
		expect(isUsageLimitError("Requests per minute limit reached")).toBe(false);
	});
});
