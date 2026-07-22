import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { resolveOpenAICompat } from "../src/providers/openai-completions-compat";
import type { Model } from "../src/types";

describe("DeepSeek strict mode via OpenRouter (compat boundary)", () => {
	function model(provider: string, id: string, baseUrl: string): Model<"openai-completions"> {
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider,
			id,
			baseUrl,
			reasoning: true,
		} as Model<"openai-completions">;
	}

	// ── DeepSeek via OpenRouter → must be disabled ──

	it("disables strict mode for DeepSeek V4 via OpenRouter", () => {
		const compat = resolveOpenAICompat(
			model("openrouter", "deepseek/deepseek-v4-pro", "https://openrouter.ai/api/v1"),
		);
		expect(compat.supportsStrictMode).toBe(false);
	});

	it("disables strict mode for DeepSeek V4 flash via OpenRouter", () => {
		const compat = resolveOpenAICompat(
			model("openrouter", "deepseek/deepseek-v4-flash", "https://openrouter.ai/api/v1"),
		);
		expect(compat.supportsStrictMode).toBe(false);
	});

	// ── Non-DeepSeek via OpenRouter → must remain enabled ──

	it("keeps strict mode for Claude via OpenRouter", () => {
		const compat = resolveOpenAICompat(
			model("openrouter", "anthropic/claude-sonnet-4-20250514", "https://openrouter.ai/api/v1"),
		);
		expect(compat.supportsStrictMode).toBe(true);
	});

	it("keeps strict mode for GPT via OpenRouter", () => {
		const compat = resolveOpenAICompat(model("openrouter", "openai/gpt-5", "https://openrouter.ai/api/v1"));
		expect(compat.supportsStrictMode).toBe(true);
	});

	// ── DeepSeek via non-OpenRouter → must remain enabled ──

	it("keeps strict mode for DeepSeek direct API", () => {
		const compat = resolveOpenAICompat(model("deepseek", "deepseek-chat", "https://api.deepseek.com/v1"));
		expect(compat.supportsStrictMode).toBe(true);
	});

	it("keeps strict mode disabled for DeepSeek via NVIDIA NIM (unchanged — nvidia does not support strict)", () => {
		const compat = resolveOpenAICompat(
			model("nvidia", "deepseek-ai/deepseek-v4-flash", "https://integrate.api.nvidia.com/v1"),
		);
		expect(compat.supportsStrictMode).toBe(false);
	});
});
