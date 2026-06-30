import { describe, expect, it } from "bun:test";
import { applyAnthropicUsageExtras } from "@gajae-code/ai/providers/anthropic";
import { parseChunkUsage } from "@gajae-code/ai/providers/openai-completions";
import type { Model, Usage } from "@gajae-code/ai/types";

const OPENAI_MODEL: Model<"openai-completions"> = {
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function blankUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("openai-completions parseChunkUsage", () => {
	it("does not double-count reasoning_tokens (subset of completion_tokens)", () => {
		// OpenAI spec: reasoning_tokens is a subset of completion_tokens (the total billed output).
		// A 100-token completion that included 40 reasoning tokens should report output=100, not 140.
		const usage = parseChunkUsage(
			{
				prompt_tokens: 1_000,
				completion_tokens: 100,
				prompt_tokens_details: { cached_tokens: 200 },
				completion_tokens_details: { reasoning_tokens: 40 },
			},
			OPENAI_MODEL,
			undefined,
		);

		expect(usage.output).toBe(100);
		expect(usage.input).toBe(800);
		expect(usage.cacheRead).toBe(200);
		expect(usage.totalTokens).toBe(1_100);
		expect(usage.reasoningTokens).toBe(40);
	});

	it("omits reasoningTokens when no reasoning_tokens are reported", () => {
		const usage = parseChunkUsage({ prompt_tokens: 50, completion_tokens: 25 }, OPENAI_MODEL, undefined);

		expect(usage.reasoningTokens).toBeUndefined();
		expect(usage.output).toBe(25);
	});

	it("attributes OpenRouter cache_write_tokens to cacheWrite, not input", () => {
		// OpenRouter (https://openrouter.ai/docs/guides/best-practices/prompt-caching)
		// reports cache writes via prompt_tokens_details.cache_write_tokens and
		// INCLUDES them in prompt_tokens. Naively subtracting only cached_tokens
		// leaves cache-write tokens stuck in `input`.
		const usage = parseChunkUsage(
			{
				prompt_tokens: 6_000,
				completion_tokens: 250,
				prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 5_500 },
			},
			OPENAI_MODEL,
			undefined,
		);

		expect(usage.input).toBe(500);
		expect(usage.cacheWrite).toBe(5_500);
		expect(usage.cacheRead).toBe(0);
		expect(usage.totalTokens).toBe(6_250);
	});

	it("attributes OpenRouter cache_read_tokens correctly when cache is warm", () => {
		const usage = parseChunkUsage(
			{
				prompt_tokens: 6_000,
				completion_tokens: 250,
				prompt_tokens_details: { cached_tokens: 5_800, cache_write_tokens: 0 },
			},
			OPENAI_MODEL,
			undefined,
		);

		expect(usage.input).toBe(200);
		expect(usage.cacheRead).toBe(5_800);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(6_250);
	});

	it("maps DeepSeek prompt cache hit and miss fields", () => {
		const usage = parseChunkUsage(
			{
				prompt_tokens: 6_000,
				completion_tokens: 250,
				prompt_cache_hit_tokens: 5_800,
				prompt_cache_miss_tokens: 200,
			},
			OPENAI_MODEL,
			undefined,
		);

		expect(usage.input).toBe(200);
		expect(usage.cacheRead).toBe(5_800);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(6_250);
	});

	it("does not infer cache usage when routed providers omit cache metadata", () => {
		const usage = parseChunkUsage(
			{
				prompt_tokens: 6_000,
				completion_tokens: 250,
			},
			OPENAI_MODEL,
			undefined,
		);

		expect(usage.input).toBe(6_000);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(6_250);
	});
});

describe("anthropic applyAnthropicUsageExtras", () => {
	it("captures cache TTL breakdown when both buckets are non-zero", () => {
		const usage = blankUsage();
		applyAnthropicUsageExtras(usage, {
			cache_creation: {
				ephemeral_5m_input_tokens: 1_200,
				ephemeral_1h_input_tokens: 800,
			},
		});

		expect(usage.cttl).toEqual({ ephemeral5m: 1_200, ephemeral1h: 800 });
	});

	it("only sets the bucket the provider populated", () => {
		const usage = blankUsage();
		applyAnthropicUsageExtras(usage, {
			cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 },
		});

		expect(usage.cttl).toEqual({ ephemeral5m: 50 });
		expect(usage.cttl?.ephemeral1h).toBeUndefined();
	});

	it("captures server tool requests", () => {
		const usage = blankUsage();
		applyAnthropicUsageExtras(usage, {
			server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 },
		});

		expect(usage.server).toEqual({ webSearch: 3, webFetch: 1 });
	});

	it("leaves serverToolUse undefined when both counters are zero", () => {
		const usage = blankUsage();
		applyAnthropicUsageExtras(usage, {
			server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
		});

		expect(usage.server).toBeUndefined();
	});

	it("does not clobber a previously-populated breakdown when called with no cache_creation field (message_delta case)", () => {
		// message_start populated the 5m/1h split; message_delta lacks cache_creation
		// but reports cumulative server_tool_use. The helper must not erase the breakdown
		// already on the usage object.
		const usage = blankUsage();
		usage.cttl = { ephemeral5m: 100, ephemeral1h: 200 };

		applyAnthropicUsageExtras(usage, {
			server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
		});

		expect(usage.cttl).toEqual({ ephemeral5m: 100, ephemeral1h: 200 });
		expect(usage.server).toEqual({ webSearch: 2 });
	});

	it("treats null SDK fields as absent (cache_creation: null skips breakdown)", () => {
		const usage = blankUsage();
		applyAnthropicUsageExtras(usage, {
			cache_creation: null,
			server_tool_use: null,
		});

		expect(usage.cttl).toBeUndefined();
		expect(usage.server).toBeUndefined();
	});
});
