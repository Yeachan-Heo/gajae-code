import { describe, expect, it } from "bun:test";
import { getBundledModel, THINKING_CONTROL_MODES } from "@gajae-code/ai";
import {
	applyGeneratedModelPolicies,
	clampThinkingLevelForModel,
	Effort,
	enrichModelThinking,
	getSupportedEfforts,
	linkOpenAIPromotionTargets,
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	modelSupportsReasoningControl,
	requireSupportedEffort,
} from "@gajae-code/ai/model-thinking";
import type { Api, Model, Provider, ThinkingControlMode } from "@gajae-code/ai/types";

const TEST_PROVIDER_BASE_URLS: Partial<Record<Provider, string>> = {
	"alibaba-token-plan": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
	"kimi-code": "https://api.kimi.com/coding/v1",
	"opencode-go": "https://opencode.ai/zen/go/v1",
	"opencode-zen": "https://opencode.ai/zen/v1",
	"openai-codex": "https://chatgpt.com/backend-api",
	openrouter: "https://openrouter.ai/api/v1",
	xai: "https://api.x.ai/v1",
	zai: "https://api.z.ai/v1",
};

function createModel<TApi extends Api>(overrides: {
	id: string;
	api: TApi;
	provider: Provider;
	reasoning?: boolean;
	compat?: Model<TApi>["compat"];
}): Model<TApi> {
	return enrichModelThinking({
		id: overrides.id,
		name: overrides.id,
		api: overrides.api,
		provider: overrides.provider,
		baseUrl: TEST_PROVIDER_BASE_URLS[overrides.provider] ?? "",
		reasoning: overrides.reasoning ?? true,
		compat: overrides.compat,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	});
}

describe("thinking control modes", () => {
	it("exports the canonical runtime vocabulary without duplicates", () => {
		const modes: readonly ThinkingControlMode[] = THINKING_CONTROL_MODES;
		expect(modes).toEqual(["effort", "budget", "google-level", "anthropic-adaptive", "anthropic-budget-effort"]);
		expect(new Set(modes).size).toBe(modes.length);
	});
});

describe("model thinking metadata", () => {
	it("derives conservative direct xAI effort ranges from the Grok generation", () => {
		const grok45 = createModel({
			id: "grok-4.5",
			api: "openai-completions",
			provider: "xai",
		});
		const grok46 = createModel({
			id: "grok-4.6",
			api: "openai-completions",
			provider: "xai",
		});
		const grok45Preview = createModel({
			id: "grok-4.5-preview",
			api: "openai-completions",
			provider: "xai",
		});
		const grok5 = createModel({
			id: "grok-5",
			api: "openai-completions",
			provider: "xai",
		});
		const grok420 = createModel({
			id: "grok-4.20-0309-reasoning",
			api: "openai-completions",
			provider: "xai",
		});

		expect(grok45.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.High,
		});
		expect(grok46.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
		});
		expect(grok45Preview.thinking).toEqual(grok45.thinking);
		expect(grok5.thinking).toEqual(grok45.thinking);
		expect(grok420.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		});
		expect(() => requireSupportedEffort(grok45, Effort.Minimal)).toThrow(/not supported/);
		expect(() => requireSupportedEffort(grok45, Effort.XHigh)).toThrow(/not supported/);
		expect(() => requireSupportedEffort(grok46, Effort.Minimal)).toThrow(/not supported/);
		expect(() => requireSupportedEffort(grok46, Effort.Max)).toThrow(/not supported/);
		expect(() => requireSupportedEffort(grok5, Effort.XHigh)).toThrow(/not supported/);
		expect(() => requireSupportedEffort(grok420, Effort.XHigh)).toThrow(/not supported/);
	});

	it("exposes Alibaba DeepSeek V4 Flash's documented low/high/max efforts", () => {
		const model = createModel({
			id: "deepseek-v4-flash-0731",
			api: "openai-completions",
			provider: "alibaba-token-plan",
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.Max,
			levels: [Effort.Low, Effort.High, Effort.Max],
		});
		expect(requireSupportedEffort(model, Effort.Max)).toBe(Effort.Max);
	});

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

	it("exposes Gemini 3.7 Flash low/medium/high and rejects minimal", () => {
		const flash37 = createModel({
			id: "gemini-3.7-flash",
			api: "google-generative-ai",
			provider: "google",
		});
		const flash36 = createModel({
			id: "gemini-3.6-flash",
			api: "google-generative-ai",
			provider: "google",
		});

		expect(flash37.thinking).toEqual({
			mode: "google-level",
			minLevel: Effort.Low,
			maxLevel: Effort.High,
		});
		expect(flash36.thinking).toEqual({
			mode: "google-level",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		});
		expect(mapEffortToGoogleThinkingLevel(flash37, Effort.Low)).toBe("LOW");
		expect(mapEffortToGoogleThinkingLevel(flash37, Effort.Medium)).toBe("MEDIUM");
		expect(mapEffortToGoogleThinkingLevel(flash37, Effort.High)).toBe("HIGH");
		expect(() => requireSupportedEffort(flash37, Effort.Minimal)).toThrow(/not supported/);
		expect(requireSupportedEffort(flash36, Effort.Minimal)).toBe(Effort.Minimal);
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
		const sonnet5 = createModel({
			id: "claude-sonnet-5",
			api: "anthropic-messages",
			provider: "anthropic",
		});
		const sonnet5Bedrock = createModel({
			id: "us.anthropic.claude-sonnet-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
		});

		expect(opus45.thinking?.mode).toBe("anthropic-budget-effort");
		expect(opus46.thinking?.mode).toBe("anthropic-adaptive");
		expect(sonnet46.thinking?.mode).toBe("anthropic-adaptive");
		expect(sonnet5.thinking?.mode).toBe("anthropic-adaptive");
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
		expect(sonnet5.thinking).toEqual({
			mode: "anthropic-adaptive",
			minLevel: Effort.Minimal,
			maxLevel: Effort.Max,
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
		// Sonnet 5 officially exposes both Anthropic's real xhigh and max presets.
		expect(mapEffortToAnthropicAdaptiveEffort(sonnet5, Effort.High)).toBe("high");
		expect(mapEffortToAnthropicAdaptiveEffort(sonnet5, Effort.XHigh)).toBe("xhigh");
		expect(mapEffortToAnthropicAdaptiveEffort(sonnet5, Effort.Max)).toBe("max");
		expect(requireSupportedEffort(sonnet5, Effort.XHigh)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(sonnet5, Effort.Max)).toBe(Effort.Max);
		expect(clampThinkingLevelForModel(sonnet5, Effort.XHigh)).toBe(Effort.XHigh);
		expect(clampThinkingLevelForModel(sonnet5, Effort.Max)).toBe(Effort.Max);
		// Older Sonnet generations stay fail-closed: no xhigh, no max.
		expect(() => requireSupportedEffort(sonnet46, Effort.XHigh)).toThrow(/not supported/);
		expect(() => requireSupportedEffort(sonnet46, Effort.Max)).toThrow(/not supported/);
		// Bedrock Converse lacks the Messages-only xhigh preset, so Bedrock
		// Sonnet 5 stays clamped to high (no xhigh, no max).
		expect(sonnet5Bedrock.thinking?.maxLevel).toBe(Effort.High);
		expect(() => mapEffortToAnthropicAdaptiveEffort(sonnet5Bedrock, Effort.XHigh)).toThrow(/not supported/);
		expect(() => mapEffortToAnthropicAdaptiveEffort(sonnet5Bedrock, Effort.Max)).toThrow(/not supported/);
	});

	it("classifies Fable 5 as adaptive thinking with xhigh support (discovery metadata regression)", () => {
		const fable = createModel({
			id: "claude-fable-5",
			api: "anthropic-messages",
			provider: "anthropic",
		});
		const fableBedrock = createModel({
			id: "us.anthropic.claude-fable-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
		});

		// Discovery previously parsed Fable as an unknown family and cached
		// mode:"budget", which made requests send `enabled`+budget_tokens —
		// Fable then returned signature-only thinking (billed, nothing shown).
		expect(fable.thinking?.mode).toBe("anthropic-adaptive");
		expect(fable.thinking?.minLevel).toBe(Effort.Minimal);
		expect(fable.thinking?.maxLevel).toBe(Effort.XHigh);
		expect(mapEffortToAnthropicAdaptiveEffort(fable, Effort.XHigh)).toBe("xhigh");
		expect(() => mapEffortToAnthropicAdaptiveEffort(fable, Effort.Max)).toThrow(/not supported/);

		// Bedrock Converse lacks the Messages-only xhigh preset (same split
		// as Opus 4.7+), so Bedrock Fable stays clamped to high.
		expect(fableBedrock.thinking?.mode).toBe("anthropic-adaptive");
		expect(fableBedrock.thinking?.maxLevel).toBe(Effort.High);
		expect(mapEffortToAnthropicAdaptiveEffort(fableBedrock, Effort.High)).toBe("high");
		expect(() => mapEffortToAnthropicAdaptiveEffort(fableBedrock, Effort.XHigh)).toThrow(/not supported/);
	});
});

describe("generated model policies", () => {
	it("corrects stale direct xAI Grok reasoning metadata before enrichment", () => {
		const models = [
			createModel({ id: "grok-4.5", api: "openai-completions", provider: "xai", reasoning: false }),
			createModel({ id: "grok-4.6", api: "openai-completions", provider: "xai", reasoning: false }),

			createModel({ id: "grok-4.6", api: "openai-completions", provider: "openrouter", reasoning: false }),
			createModel({ id: "mlx-reasoner", api: "openai-completions", provider: "omlx", reasoning: false }),
			createModel({ id: "grok-5", api: "openai-completions", provider: "xai", reasoning: false }),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]).toMatchObject({
			reasoning: true,
			thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
		});
		expect(models[1]).toMatchObject({
			reasoning: true,
			maxTokens: 32_000,
			thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.XHigh },
		});
		expect(models[0]?.maxTokens).toBe(32_000);
		expect(models[2]?.reasoning).toBe(false);
		expect(models[2]?.thinking).toBeUndefined();
		expect(models[3]).toMatchObject({
			reasoning: true,
			compat: { supportsReasoningEffort: true, thinkingFormat: "qwen-chat-template" },
		});
		expect(models[4]?.reasoning).toBe(false);
		expect(models[4]?.thinking).toBeUndefined();
	});

	it("keeps catalog reasoning flags authoritative outside the stale-row corrections", () => {
		const staleFutureRow = [
			createModel({ id: "grok-4.7", api: "openai-completions", provider: "xai", reasoning: false }),
		];
		applyGeneratedModelPolicies(staleFutureRow);
		// The pin is a per-row data correction for observed staleness, not a
		// family rule; unobserved rows keep whatever the catalog says.
		expect(staleFutureRow[0]?.reasoning).toBe(false);
		expect(staleFutureRow[0]?.thinking).toBeUndefined();

		const nonReasoning = [
			createModel({
				id: "grok-4.20-0309-non-reasoning",
				api: "openai-completions",
				provider: "xai",
				reasoning: false,
			}),
		];
		applyGeneratedModelPolicies(nonReasoning);
		expect(nonReasoning[0]?.reasoning).toBe(false);
		expect(nonReasoning[0]?.thinking).toBeUndefined();
	});

	it("derives conservative thinking config for future direct xAI generations with catalog reasoning", () => {
		const model = createModel({ id: "grok-4.7", api: "openai-completions", provider: "xai" });

		expect(model.thinking).toMatchObject({ mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High });
	});

	it("corrects Alibaba DeepSeek V4 Flash discovery before thinking enrichment", () => {
		const models: Model<Api>[] = [
			createModel({
				id: "deepseek-v4-flash-0731",
				api: "openai-completions",
				provider: "alibaba-token-plan",
				reasoning: false,
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]).toMatchObject({
			name: "DeepSeek V4 Flash 0731",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			thinking: {
				mode: "effort",
				minLevel: Effort.Low,
				maxLevel: Effort.Max,
				levels: [Effort.Low, Effort.High, Effort.Max],
			},
		});
	});

	it("pins Kilo Ox Alpha capabilities when generic discovery omits them", () => {
		const models: Model<Api>[] = [
			createModel({
				id: "stealth/ox-alpha",
				api: "openai-completions",
				provider: "kilo",
				reasoning: false,
			}),
		];
		models[0]!.input = ["text"];
		models[0]!.contextWindow = 222_222;
		models[0]!.maxTokens = 8_888;

		applyGeneratedModelPolicies(models);

		expect(models[0]).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			thinking: {
				mode: "effort",
				minLevel: Effort.Low,
				maxLevel: Effort.Max,
				defaultLevel: Effort.Max,
				levels: [Effort.Low, Effort.High, Effort.Max],
			},
		});
	});

	it("pins the measured Cursor Kimi K3 context window across regeneration", () => {
		const models = [
			createModel({ id: "kimi-k3-low", api: "cursor-agent", provider: "cursor", reasoning: false }),
			createModel({ id: "kimi-k3-high", api: "cursor-agent", provider: "cursor", reasoning: false }),
			createModel({ id: "kimi-k3-max", api: "cursor-agent", provider: "cursor", reasoning: false }),
			createModel({ id: "kimi-k3", api: "cursor-agent", provider: "cursor", reasoning: false }),
			createModel({ id: "kimi-k3-low", api: "openai-completions", provider: "openrouter" }),
		];
		for (const model of models.slice(0, 3)) {
			model.contextWindow = 200_000;
			model.maxTokens = 64_000;
		}

		applyGeneratedModelPolicies(models);

		expect(models.slice(0, 3).map(model => model.contextWindow)).toEqual([1_048_576, 1_048_576, 1_048_576]);
		expect(models.slice(0, 3).map(model => model.maxTokens)).toEqual([64_000, 64_000, 64_000]);
		expect(models[3]?.contextWindow).toBe(200_000);
		expect(models[4]?.contextWindow).toBe(200_000);

		models[0]!.contextWindow = 2_000_000;
		applyGeneratedModelPolicies(models);
		expect(models[0]?.contextWindow).toBe(1_048_576);
	});

	it("removes unsupported reasoning controls only from Groq compound systems", () => {
		const models = [
			createModel({ id: "groq/compound", api: "openai-completions", provider: "groq" }),
			createModel({ id: "groq/compound-mini", api: "openai-completions", provider: "groq" }),
			createModel({ id: "groq/compound", api: "openai-completions", provider: "openrouter" }),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.reasoning).toBe(false);
		expect(models[0]?.thinking).toBeUndefined();
		expect(models[1]?.reasoning).toBe(false);
		expect(models[1]?.thinking).toBeUndefined();
		expect(models[2]?.reasoning).toBe(true);
		expect(models[2]?.thinking).toBeDefined();
	});

	it("maps only first-class MiniMax M3 routes to the official 1M context (issue #3896)", () => {
		const models = [
			createModel({ id: "MiniMax-M3", api: "anthropic-messages", provider: "minimax" }),
			createModel({ id: "MiniMax-M3[1m]", api: "anthropic-messages", provider: "minimax" }),
			createModel({ id: "MiniMax-M3[1m]", api: "anthropic-messages", provider: "minimax-cn" }),
			createModel({ id: "MiniMax-M3", api: "openai-completions", provider: "minimax-code" }),
			createModel({ id: "MiniMax-M3", api: "openai-completions", provider: "minimax-code-cn" }),
			createModel({ id: "minimax-m3", api: "openai-completions", provider: "openai-codex" }),
			{
				...createModel({ id: "minimax-m3", api: "openai-completions", provider: "opencode-zen" }),
				contextWindow: 512_000,
			},
		];

		applyGeneratedModelPolicies(models);

		expect(models.slice(0, 5).map(model => model.contextWindow)).toEqual([
			1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000,
		]);
		expect(models.slice(5).map(model => model.contextWindow)).toEqual([200_000, 512_000]);
	});

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

	it("stores GPT-5.6 Sol/Terra/Luna effort metadata through max", () => {
		const models = [
			createModel({
				id: "gpt-5.6-sol",
				api: "openai-responses",
				provider: "openai",
			}),
			createModel({
				id: "gpt-5.6-terra",
				api: "openai-codex-responses",
				provider: "openai-codex",
			}),
			createModel({
				id: "gpt-5.6-luna",
				api: "openai-responses",
				provider: "openai",
			}),
			createModel({
				id: "gpt-5.6",
				api: "openai-responses",
				provider: "openai",
			}),
		];

		for (const model of models) {
			expect(model.thinking).toEqual({
				mode: "effort",
				minLevel: Effort.Low,
				maxLevel: Effort.Max,
			});
			expect(requireSupportedEffort(model, Effort.Max)).toBe(Effort.Max);
			expect(() => requireSupportedEffort(model, Effort.Minimal)).toThrow(
				/Supported efforts: low, medium, high, xhigh, max/,
			);
		}
	});

	it("parses the GPT-6 Astra variant as a post-5.6 OpenAI model", () => {
		const model = createModel({ id: "gpt-6-astra", api: "openai-codex-responses", provider: "openai-codex" });

		expect(model.thinking).toEqual({ mode: "effort", minLevel: Effort.Low, maxLevel: Effort.Max });
		expect(requireSupportedEffort(model, Effort.Max)).toBe(Effort.Max);
		expect(() => requireSupportedEffort(model, Effort.Minimal)).toThrow(
			/Supported efforts: low, medium, high, xhigh, max/,
		);
	});

	it("forces only Codex product GPT-5.6 tiers to the 372K prompt budget", () => {
		const models: Model<Api>[] = [
			{
				...createModel({ id: "gpt-5.6-sol", api: "openai-codex-responses", provider: "openai-codex" }),
				contextWindow: 1_050_000,
				maxTokens: 128000,
			},
			{
				...createModel({ id: "gpt-5.6-terra", api: "openai-responses", provider: "openai" }),
				contextWindow: 1_050_000,
				maxTokens: 128000,
			},
			{
				...createModel({ id: "gpt-5.6-luna", api: "openai-codex-responses", provider: "custom" }),
				contextWindow: 200_000,
				maxTokens: 128000,
			},
			{
				...createModel({ id: "gpt-5.6-codex", api: "openai-codex-responses", provider: "openai-codex" }),
				contextWindow: 373_000,
				maxTokens: 128000,
			},
		];

		applyGeneratedModelPolicies(models);

		expect(models.map(model => model.contextWindow)).toEqual([372_000, 1_050_000, 372_000, 272_000]);
		expect(models[0]?.applyPatchToolType).toBe("freeform");
		expect(models[1]?.applyPatchToolType).toBe("freeform");
	});

	it("forces every GPT-5.6 tier id to 372K through generated policies regardless of observation", () => {
		const models: Model<Api>[] = [];
		for (const id of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const) {
			for (const contextWindow of [200_000, 272_000, 373_000, 1_050_000]) {
				models.push({
					...createModel({ id, api: "openai-codex-responses", provider: "openai-codex" }),
					contextWindow,
					maxTokens: 128000,
				});
			}
		}
		applyGeneratedModelPolicies(models);
		for (const model of models) {
			expect(model.contextWindow).toBe(372_000);
		}
	});
});

describe("model thinking runtime helpers", () => {
	it("clamps from explicit metadata instead of inferring from model id", () => {
		const model: Model<"openai-codex-responses"> = {
			id: "custom-reasoner",
			name: "Custom Reasoner",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
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
			compat: { supportsReasoningEffort: true },
		});

		// Explicitly opted-in custom openai-completions models support xhigh.
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

	it("uses Kimi K3's discrete low, high, and max efforts", () => {
		const model = createModel({
			id: "k3",
			api: "openai-completions",
			provider: "kimi-code",
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.Max,
			levels: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.High,
		});
		expect(requireSupportedEffort(model, Effort.Max)).toBe(Effort.Max);
		expect(() => requireSupportedEffort(model, Effort.Medium)).toThrow(/Supported efforts: low, high, max/);
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

	it("preserves Muse Spark xhigh through shared runtime policy inference", () => {
		const models: Model<"openai-completions">[] = [
			{
				id: "meta/muse-spark-1.2",
				name: "Meta: Muse Spark 1.2",
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
			},
		];

		applyGeneratedModelPolicies(models);
		const model = models[0]!;

		expect(model.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Minimal,
			maxLevel: Effort.XHigh,
		});
		expect(requireSupportedEffort(model, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("marks generic dynamically discovered Muse Spark routes as reasoning-capable", () => {
		const models: Model<"openai-completions">[] = [
			{
				id: "meta/muse-spark-1.2",
				name: "Meta: Muse Spark 1.2",
				api: "openai-completions",
				provider: "kilo",
				baseUrl: "https://api.kilo.ai/api/gateway",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
			},
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]).toMatchObject({
			reasoning: true,
			thinking: {
				mode: "effort",
				minLevel: Effort.Minimal,
				maxLevel: Effort.XHigh,
			},
		});
	});

	it("requires explicit transport capability for custom OpenAI-compatible reasoning controls", () => {
		const completionsModel = createModel({
			id: "custom-completions",
			api: "openai-completions",
			provider: "custom",
		});
		const responsesModel = createModel({
			id: "custom-responses",
			api: "openai-responses",
			provider: "custom",
		});
		const optedInResponsesModel = createModel({
			id: "custom-responses-opted-in",
			api: "openai-responses",
			provider: "custom",
			compat: { supportsReasoningEffort: true },
		});
		const configurableKnownLabel = enrichModelThinking({
			...createModel({ id: "litellm-responses", api: "openai-responses", provider: "litellm" }),
			baseUrl: "http://localhost:4000/v1",
		});
		const hostileLookalike = enrichModelThinking({
			...createModel({ id: "hostile-responses", api: "openai-responses", provider: "custom" }),
			baseUrl: "https://api.openai.com.evil.example/v1",
		});
		const officialCustomRoute = enrichModelThinking({
			...createModel({ id: "official-custom", api: "openai-responses", provider: "custom" }),
			baseUrl: "https://api.openai.com/v1",
		});
		const officialCustomCompletionsRoute = enrichModelThinking({
			...createModel({ id: "official-custom-completions", api: "openai-completions", provider: "custom" }),
			baseUrl: "https://api.openai.com/v1",
		});

		const codexModel = createModel({
			id: "bundled-codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
		});

		expect(completionsModel.thinking).toBeUndefined();
		expect(responsesModel.thinking).toBeUndefined();
		expect(configurableKnownLabel.thinking).toBeUndefined();
		expect(hostileLookalike.thinking).toBeUndefined();
		expect(officialCustomRoute.thinking?.maxLevel).toBe(Effort.XHigh);
		expect(officialCustomCompletionsRoute.thinking?.maxLevel).toBe(Effort.XHigh);
		expect(modelSupportsReasoningControl(officialCustomCompletionsRoute, "https://proxy.example.com/v1")).toBe(false);
		expect(optedInResponsesModel.thinking?.maxLevel).toBe(Effort.XHigh);
		expect(codexModel.thinking?.maxLevel).toBe(Effort.XHigh);
		expect(requireSupportedEffort(optedInResponsesModel, Effort.XHigh)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(codexModel, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("preserves reasoning controls for audited OpenRouter, OpenCode, and Kilo models", () => {
		const models = [
			getBundledModel("openrouter", "openai/gpt-5.4"),
			getBundledModel("opencode-go", "deepseek-v4-flash"),
			getBundledModel("opencode-zen", "claude-fable-5"),
			getBundledModel("kilo", "anthropic/claude-sonnet-4.5"),
		];

		for (const model of models) {
			expect(model.reasoning).toBe(true);
			expect(model.thinking).toBeDefined();
			expect(getSupportedEfforts(model).length).toBeGreaterThan(0);
		}
	});

	it("rejects reasoning models that are missing thinking metadata at runtime", () => {
		const model = {
			id: "broken-reasoner",
			name: "Broken Reasoner",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
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
