import { describe, expect, test } from "bun:test";
import { isRetiredModelKey } from "../src/model-retirements";
import { Effort, getSupportedEfforts } from "../src/model-thinking";
import type { GeneratedProvider } from "../src/models";
import { getBundledModel, getBundledModels, getBundledProviders } from "../src/models";

function gemini37SiblingId(modelId: string): string {
	return modelId.replaceAll("gemini-3.6-flash", "gemini-3.7-flash").replaceAll("gemini-3-6-flash", "gemini-3-7-flash");
}

describe("preset catalog model entries", () => {
	test("bundles Astra and Fable 5.1 with the thinking ladders used by model profiles", () => {
		const astra = getBundledModel("openai-codex", "gpt-6-astra");
		expect(astra).toMatchObject({
			id: "gpt-6-astra",
			name: "GPT-6-Astra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
		});
		expect(astra.thinking).toEqual({ mode: "effort", minLevel: Effort.Low, maxLevel: Effort.Max });
		expect(getSupportedEfforts(astra)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);

		const fable = getBundledModel("anthropic", "claude-fable-5-1");
		expect(fable).toMatchObject({
			id: "claude-fable-5-1",
			name: "Anthropic Fable 5.1",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
		});
		expect(fable.thinking).toEqual({
			mode: "anthropic-adaptive",
			minLevel: Effort.Minimal,
			maxLevel: Effort.XHigh,
		});
		expect(getSupportedEfforts(fable)).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
	});

	test("bundles Kilo Ox Alpha with its reviewed capability contract", () => {
		const model = getBundledModel("kilo", "stealth/ox-alpha");

		expect(model.id).toBe("stealth/ox-alpha");
		expect(model.provider).toBe("kilo");
		expect(model.name).toBe("Ox Alpha");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1_048_576);
		expect(model.maxTokens).toBe(131_072);
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(model.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.Max,
			defaultLevel: Effort.Max,
			levels: [Effort.Low, Effort.High, Effort.Max],
		});
	});

	test("keeps Groq compound systems reasoning-control free", () => {
		for (const id of ["groq/compound", "groq/compound-mini"] as const) {
			const model = getBundledModel("groq", id);
			expect(model.reasoning).toBe(false);
			expect(model.thinking).toBeUndefined();
		}
	});

	test("bundles kimi-code/kimi-k2.7-code", () => {
		const model = getBundledModel("kimi-code", "kimi-k2.7-code");

		expect(model.id).toBe("kimi-k2.7-code");
		expect(model.provider).toBe("kimi-code");
		expect(model.name).toBe("Kimi K2.7 Code");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("text");
		expect(model.thinking).toEqual({ mode: "effort", minLevel: Effort.Minimal, maxLevel: Effort.High });
	});

	test("bundles zai/glm-5.3 flagship", () => {
		const model = getBundledModel("zai", "glm-5.3");

		expect(model.id).toBe("glm-5.3");
		expect(model.provider).toBe("zai");
		expect(model.name).toBe("GLM-5.3");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("text");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.Max,
			defaultLevel: Effort.Max,
			levels: [Effort.Low, Effort.High, Effort.Max],
		});
	});

	test("bundles zai/glm-5.3-flash with the canonical multimodal contract", () => {
		const model = getBundledModel("zai", "glm-5.3-flash");

		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.Max,
			defaultLevel: Effort.Max,
			levels: [Effort.Low, Effort.High, Effort.Max],
		});
	});

	test("bundles google-gemini-cli/gemini-3.5-flash", () => {
		const model = getBundledModel("google-gemini-cli", "gemini-3.5-flash");

		expect(model.id).toBe("gemini-3.5-flash");
		expect(model.provider).toBe("google-gemini-cli");
		expect(model.api).toBe("google-gemini-cli");
		expect(model.baseUrl).toBe("https://cloudcode-pa.googleapis.com");
		expect(model.name).toBe("Gemini 3.5 Flash");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("image");
		expect(model.contextWindow).toBe(1_048_576);
		expect(model.maxTokens).toBe(65_536);
		expect(model.thinking).toEqual({ mode: "google-level", minLevel: Effort.Minimal, maxLevel: Effort.High });
	});

	test("bundles google/gemini-3.7-flash flagship", () => {
		const model = getBundledModel("google", "gemini-3.7-flash");

		expect(model.id).toBe("gemini-3.7-flash");
		expect(model.provider).toBe("google");
		expect(model.api).toBe("google-generative-ai");
		expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
		expect(model.name).toBe("Gemini 3.7 Flash");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("image");
		expect(model.contextWindow).toBe(1_048_576);
		expect(model.maxTokens).toBe(65_536);
		expect(model.cost).toEqual({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
		expect(model.thinking).toEqual({ mode: "google-level", minLevel: Effort.Low, maxLevel: Effort.High });
	});

	test("bundles google-gemini-cli/gemini-3.7-flash", () => {
		const model = getBundledModel("google-gemini-cli", "gemini-3.7-flash");

		expect(model.id).toBe("gemini-3.7-flash");
		expect(model.provider).toBe("google-gemini-cli");
		expect(model.api).toBe("google-gemini-cli");
		expect(model.baseUrl).toBe("https://cloudcode-pa.googleapis.com");
		expect(model.name).toBe("Gemini 3.7 Flash");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("image");
		expect(model.contextWindow).toBe(1_048_576);
		expect(model.maxTokens).toBe(65_536);
		expect(model.thinking).toEqual({ mode: "google-level", minLevel: Effort.Low, maxLevel: Effort.High });
	});

	test("mirrors every bundled Gemini 3.6 Flash selector onto 3.7", () => {
		const missing: string[] = [];
		const mismatched: string[] = [];

		for (const provider of getBundledProviders()) {
			const models = getBundledModels(provider as GeneratedProvider);
			for (const source of models) {
				if (!/gemini-3[.-]6-flash/.test(source.id)) continue;
				if (source.id.endsWith("-minimal")) continue;
				const siblingId = gemini37SiblingId(source.id);
				if (isRetiredModelKey(provider, siblingId)) continue;
				const sibling = getBundledModel(provider as GeneratedProvider, siblingId);
				if (!sibling) {
					missing.push(`${provider}/${siblingId}`);
					continue;
				}
				if (
					sibling.api !== source.api ||
					sibling.provider !== source.provider ||
					sibling.baseUrl !== source.baseUrl
				) {
					mismatched.push(`${provider}/${siblingId}`);
				}
			}
		}

		expect(missing).toEqual([]);
		expect(mismatched).toEqual([]);
		expect(getBundledModel("cursor", "gemini-3.7-flash-minimal")).toBeUndefined();
	});

	test("pins google-level Gemini 3.7 Flash thinking to low/medium/high", () => {
		const selectors = [
			["google", "gemini-3.7-flash"],
			["google-gemini-cli", "gemini-3.7-flash"],
			["google-antigravity", "gemini-3.7-flash-tiered"],
			["opencode-zen", "gemini-3.7-flash"],
		] as const;

		for (const [provider, id] of selectors) {
			const model = getBundledModel(provider, id);
			expect(model, `${provider}/${id}`).toBeDefined();
			expect(model.thinking, `${provider}/${id}`).toEqual({
				mode: "google-level",
				minLevel: Effort.Low,
				maxLevel: Effort.High,
			});
		}
	});

	test("bundles minimax-code/MiniMax-M3 canonical id (issue #3896)", () => {
		const model = getBundledModel("minimax-code", "MiniMax-M3");

		expect(model.id).toBe("MiniMax-M3");
		expect(model.provider).toBe("minimax-code");
		expect(model.name).toBe("MiniMax-M3");
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.thinking).toBeUndefined();
	});
});
