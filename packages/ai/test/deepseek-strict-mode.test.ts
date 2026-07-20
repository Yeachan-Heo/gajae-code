import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// DeepSeek model-family detection (used by convertTools in openai-completions.ts)
// ---------------------------------------------------------------------------

const isDeepseek = (modelId: string): boolean => /deepseek/i.test(modelId);

describe("DeepSeek model-family detection", () => {
	it("matches deepseek/deepseek-v4-pro via OpenRouter", () => {
		expect(isDeepseek("deepseek/deepseek-v4-pro")).toBe(true);
	});

	it("matches deepseek/deepseek-v4-flash via OpenRouter", () => {
		expect(isDeepseek("deepseek/deepseek-v4-flash")).toBe(true);
	});

	it("matches deepseek-reasoner via direct API", () => {
		expect(isDeepseek("deepseek-reasoner")).toBe(true);
	});

	it("matches deepseek-chat via direct API", () => {
		expect(isDeepseek("deepseek-chat")).toBe(true);
	});

	it("matches case-insensitively (DeepSeek)", () => {
		expect(isDeepseek("DeepSeek/deepseek-v4-pro")).toBe(true);
	});

	it("does NOT match claude-sonnet", () => {
		expect(isDeepseek("anthropic/claude-sonnet-4-20250514")).toBe(false);
	});

	it("does NOT match gpt-5", () => {
		expect(isDeepseek("openai/gpt-5")).toBe(false);
	});

	it("does NOT match empty string", () => {
		expect(isDeepseek("")).toBe(false);
	});
});
