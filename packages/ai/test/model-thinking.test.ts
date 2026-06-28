import { describe, expect, it } from "bun:test";
import {
	applyGeneratedModelPolicies,
	clampThinkingLevelForModel,
	Effort,
	enrichModelThinking,
	linkOpenAIPromotionTargets,
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	requireSupportedEffort,
} from "@gajae-code/ai/model-thinking";
import type { Api, Model, Provider } from "@gajae-code/ai/types";

function createModel<TApi extends Api>(overrides: {
	id: string;
	api: TApi;
	provider: Provider;
	reasoning?: boolean;
}): Model<TApi> {
	return enrichModelThinking({
		id: overrides.id,
		name: overrides.id,
		api: overrides.api,
		provider: overrides.provider,
		baseUrl: "",
		reasoning: overrides.reasoning ?? true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	});
}

describe("model thinking metadata", () => {
	it("stores supported efforts for Codex mini in model metadata", () => {
		const model = createModel({
			id: "gpt-5.1-codex-mini",
			api: "openai-codex-responses",
			provider: "openai-codex",
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Medium,
			maxLevel: Effort.High,
		});
		expect(() => requireSupportedEffort(model, Effort.Low)).toThrow(/Supported efforts: medium, high/);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(/Supported efforts: medium, high/);
	});

	it("stores xhigh support directly in metadata for GPT-5.2", () => {
		const model = createModel({
			id: "gpt-5.2-codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
		});
		expect(requireSupportedEffort(model, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("maps Gemini 3 Pro only for supported levels", () => {
		const model = createModel({
			id: "gemini-3-pro-preview",
			api: "google-generative-ai",
			provider: "google",
		});

		expect(model.thinking).toEqual({
			mode: "google-level",
			minLevel: Effort.Low,
			maxLevel: Effort.High,
			levels: [Effort.Low, Effort.High],
		});
		expect(mapEffortToGoogleThinkingLevel(model, Effort.Low)).toBe("LOW");
		expect(mapEffortToGoogleThinkingLevel(model, Effort.High)).toBe("HIGH");
		expect(() => mapEffortToGoogleThinkingLevel(model, Effort.Medium)).toThrow(/not supported/);
	});

	it("encodes anthropic transport mode in metadata", () => {
		const opus45 = createModel({
			id: "claude-opus-4-5",
			api: "anthropic-messages",
			provider: "anthropic",
		});
		const opus46 = createModel({
			id: "claude-opus-4.6",
			api: "anthropic-messages",
			provider: "anthropic",
		});
		const opus47 = createModel({
			id: "claude-opus-4.7",
			api: "anthropic-messages",
			provider: "anthropic",
		});
		const opus47Bedrock = createModel({
			id: "us.anthropic.claude-opus-4-7",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
		});
		const sonnet46 = createModel({
			id: "claude-sonnet-4.6",
			api: "anthropic-messages",
			provider: "anthropic",
		});

		expect(opus45.thinking?.mode).toBe("anthropic-budget-effort");
		expect(opus46.thinking?.mode).toBe("anthropic-adaptive");
		expect(sonnet46.thinking?.mode).toBe("anthropic-adaptive");
		expect(opus46.thinking).toEqual({
			mode: "anthropic-adaptive",
			minLevel: Effort.Minimal,
			maxLevel: Effort.Max,
			levels: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		});
		expect(sonnet46.thinking).toEqual({
			mode: "anthropic-adaptive",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		});
		// Older Opus adaptive models expose max but not the newer xhigh literal.
		expect(() => mapEffortToAnthropicAdaptiveEffort(opus46, Effort.XHigh)).toThrow(/not supported/);
		expect(mapEffortToAnthropicAdaptiveEffort(opus46, Effort.Max)).toBe("max");
		// Opus 4.7+ on Messages API exposes both Anthropic's real xhigh and max presets.
		expect(mapEffortToAnthropicAdaptiveEffort(opus47, Effort.XHigh)).toBe("xhigh");
		expect(mapEffortToAnthropicAdaptiveEffort(opus47, Effort.Max)).toBe("max");
		// Bedrock Converse supports max, but not the Messages-only xhigh preset.
		expect(() => mapEffortToAnthropicAdaptiveEffort(opus47Bedrock, Effort.XHigh)).toThrow(/not supported/);
		expect(mapEffortToAnthropicAdaptiveEffort(opus47Bedrock, Effort.Max)).toBe("max");
		expect(() => mapEffortToAnthropicAdaptiveEffort(sonnet46, Effort.XHigh)).toThrow(/not supported/);
		expect(() => mapEffortToAnthropicAdaptiveEffort(sonnet46, Effort.Max)).toThrow(/not supported/);
	});
});

describe("generated model policies", () => {
	it("refreshes thinking metadata and applies parsed catalog corrections", () => {
		const models: Model<Api>[] = [
			{
				id: "claude-opus-4-5",
				name: "Claude Opus 4.5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://example.com",
				reasoning: true,
				thinking: {
					mode: "budget",
					minLevel: Effort.High,
					maxLevel: Effort.High,
				},
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 1000000,
				maxTokens: 32000,
			},
			{
				id: "anthropic.claude-opus-4-6-v1:0",
				name: "Claude Opus 4.6",
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				baseUrl: "https://example.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 1000000,
				maxTokens: 32000,
			},
			{
				id: "gpt-5.2-codex",
				name: "GPT-5.2 Codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://example.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 32000,
			},
			{
				id: "gpt-5.4-mini",
				name: "GPT-5.4 mini",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://example.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 32000,
				priority: 2,
			},
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.thinking).toEqual({
			mode: "anthropic-budget-effort",
			minLevel: Effort.Minimal,
			maxLevel: Effort.XHigh,
		});
		expect(models[0]?.cost.cacheRead).toBe(0.5);
		expect(models[0]?.cost.cacheWrite).toBe(6.25);
		expect(models[1]?.thinking).toEqual({
			mode: "anthropic-adaptive",
			minLevel: Effort.Minimal,
			maxLevel: Effort.Max,
			levels: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		});
		expect(models[1]?.cost.cacheRead).toBe(0.5);
		expect(models[1]?.cost.cacheWrite).toBe(6.25);
		expect(models[1]?.contextWindow).toBe(1000000);
		expect(models[2]?.contextWindow).toBe(272000);
		expect(models[3]?.contextWindow).toBe(272000);
		expect(models[3]?.priority).toBe(1);
	});

	it("normalizes Copilot generated fallback limits", () => {
		const models: Model<Api>[] = [
			{
				...createModel({
					id: "claude-opus-4.6",
					api: "anthropic-messages",
					provider: "github-copilot",
				}),
				contextWindow: 144000,
				maxTokens: 64000,
			},
			{
				...createModel({
					id: "gpt-5.4-mini",
					api: "openai-responses",
					provider: "github-copilot",
				}),
				contextWindow: 400000,
				maxTokens: 128000,
			},
			{
				...createModel({
					id: "grok-code-fast-1",
					api: "openai-completions",
					provider: "github-copilot",
				}),
				contextWindow: 128000,
				maxTokens: 64000,
			},
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(168000);
		expect(models[0]?.maxTokens).toBe(32000);
		expect(models[1]?.contextWindow).toBe(272000);
		expect(models[1]?.maxTokens).toBe(128000);
		expect(models[2]?.contextWindow).toBe(192000);
		expect(models[2]?.maxTokens).toBe(64000);
	});

	it("links spark variants to gpt-5.5 and leaves gpt-5.5 with no demotion target", () => {
		const models = [
			createModel({
				id: "gpt-5.3-codex-spark",
				api: "openai-codex-responses",
				provider: "openai-codex",
			}),
			createModel({
				id: "gpt-5.5",
				api: "openai-codex-responses",
				provider: "openai-codex",
			}),
			createModel({
				id: "gpt-5.4",
				api: "openai-codex-responses",
				provider: "openai-codex",
			}),
		];

		linkOpenAIPromotionTargets(models);

		expect(models[0]?.contextPromotionTarget).toBe("openai-codex/gpt-5.5");
		// gpt-5.5 remains the largest OpenAI code backend target and must not demote to gpt-5.4.
		expect(models[1]?.contextPromotionTarget).toBeUndefined();
	});

	it("keeps Codex gpt-5.5 at the effective 272K request cap even if discovery advertises 1M", () => {
		const models: Model<Api>[] = [
			{
				...createModel({
					id: "gpt-5.5",
					api: "openai-codex-responses",
					provider: "openai-codex",
				}),
				// OpenAI code discovery/cache can advertise the total 1M window, but
				// the usable request prompt cap remains lower on this transport.
				contextWindow: 1_000_000,
				maxTokens: 128000,
			},
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(272_000);
	});

	it("keeps first-party OpenAI gpt-5.5 at the 1M context window", () => {
		const models: Model<Api>[] = [
			{
				...createModel({
					id: "gpt-5.5",
					api: "openai-responses",
					provider: "openai",
				}),
				contextWindow: 272000,
				maxTokens: 128000,
			},
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(1_000_000);
	});

	it("sets freeform apply_patch metadata for first-party GPT-5 Responses models", () => {
		const models: Model<Api>[] = [
			createModel({
				id: "gpt-5.4",
				api: "openai-responses",
				provider: "openai",
			}),
			createModel({
				id: "gpt-5.3-codex-spark",
				api: "openai-codex-responses",
				provider: "openai-codex",
			}),
			{
				...createModel({
					id: "gpt-5.3-codex-spark",
					api: "openai-responses",
					provider: "opencode",
				}),
				applyPatchToolType: "freeform",
			},
			{
				...createModel({
					id: "gpt-5.4",
					api: "openai-completions",
					provider: "litellm",
				}),
				applyPatchToolType: "freeform",
			},
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.applyPatchToolType).toBe("freeform");
		expect(models[1]?.applyPatchToolType).toBe("freeform");
		expect(models[2]?.applyPatchToolType).toBeUndefined();
		expect(models[3]?.applyPatchToolType).toBeUndefined();
	});
});

describe("model thinking runtime helpers", () => {
	it("clamps from explicit metadata instead of inferring from model id", () => {
		const model: Model<"openai-codex-responses"> = {
			id: "custom-reasoner",
			name: "Custom Reasoner",
			api: "openai-codex-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: {
				mode: "effort",
				minLevel: Effort.Medium,
				maxLevel: Effort.High,
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		};

		expect(clampThinkingLevelForModel(model, Effort.Minimal)).toBe(Effort.Medium);
		expect(clampThinkingLevelForModel(model, Effort.XHigh)).toBe(Effort.High);
		expect(clampThinkingLevelForModel(model, Effort.High)).toBe(Effort.High);
	});

	it("does not clamp unsupported xhigh to max for Opus models without xhigh support", () => {
		const model = createModel({
			id: "claude-opus-4.6",
			api: "anthropic-messages",
			provider: "anthropic",
		});

		expect(clampThinkingLevelForModel(model, Effort.XHigh)).toBe(Effort.High);
		expect(clampThinkingLevelForModel(model, Effort.Max)).toBe(Effort.Max);
	});

	it('forces "off" for non-reasoning models', () => {
		const model = createModel({
			id: "plain-model",
			api: "openai-responses",
			provider: "openai",
			reasoning: false,
		});

		expect(clampThinkingLevelForModel(model, Effort.High)).toBeUndefined();
	});

	it("enables xhigh for openai-completions API (custom models)", () => {
		const model = createModel({
			id: "custom-model",
			api: "openai-completions",
			provider: "custom",
		});

		// openai-completions should support xhigh by default
		expect(model.thinking?.maxLevel).toBe(Effort.XHigh);
		expect(requireSupportedEffort(model, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("does not expose xhigh for binary-thinking openai-compat transports", () => {
		const model = enrichModelThinking({
			id: "glm-4.7",
			name: "GLM-4.7",
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://api.z.ai/v1",
			reasoning: true,
			compat: {
				thinkingFormat: "zai",
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32000,
		} satisfies Model<"openai-completions">);

		expect(model.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		});
		expect(requireSupportedEffort(model, Effort.High)).toBe(Effort.High);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(
			/Supported efforts: minimal, low, medium, high/,
		);
	});

	it("derives binary-thinking fallback from resolved compat when catalog compat is partial", () => {
		const model = enrichModelThinking({
			id: "qwen/qwen3-32b",
			name: "Qwen 3 32B",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			compat: {
				supportsToolChoice: true,
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32000,
		} satisfies Model<"openai-completions">);

		expect(model.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		});
		expect(requireSupportedEffort(model, Effort.High)).toBe(Effort.High);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(
			/Supported efforts: minimal, low, medium, high/,
		);
	});

	it("enables xhigh for openai-responses and openai-codex-responses APIs", () => {
		const responsesModel = createModel({
			id: "custom-responses",
			api: "openai-responses",
			provider: "custom",
		});

		const codexModel = createModel({
			id: "custom-codex",
			api: "openai-codex-responses",
			provider: "custom",
		});

		// Both should support xhigh
		expect(responsesModel.thinking?.maxLevel).toBe(Effort.XHigh);
		expect(codexModel.thinking?.maxLevel).toBe(Effort.XHigh);
		expect(requireSupportedEffort(responsesModel, Effort.XHigh)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(codexModel, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("rejects reasoning models that are missing thinking metadata at runtime", () => {
		const model = {
			id: "broken-reasoner",
			name: "Broken Reasoner",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"openai-responses">;

		expect(() => requireSupportedEffort(model, Effort.High)).toThrow(/missing thinking metadata/);
	});

	it("drops empty thinking metadata so presence checks stay meaningful", () => {
		const model = enrichModelThinking({
			id: "plain-model",
			name: "Plain Model",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: false,
			thinking: {
				mode: "effort",
				minLevel: Effort.High,
				maxLevel: Effort.Low,
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} satisfies Model<"openai-responses">);

		expect(model.thinking).toBeUndefined();
	});
});
