import { describe, expect, it } from "bun:test";
import {
	clampThinkingLevelForModel,
	Effort,
	enrichModelThinking,
	getSupportedEfforts,
	refreshModelThinking,
} from "@gajae-code/ai/model-thinking";
import { resolveOpenAICompat, resolveWireReasoningEffort } from "@gajae-code/ai/providers/openai-completions-compat";
import type { Model } from "@gajae-code/ai/types";
import { getBundledModel } from "../src/models";

function customDeepSeekProxy(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return enrichModelThinking({
		id: "cline-pass/deepseek-v4-flash",
		name: "DeepSeek V4 Flash via ClinePass",
		api: "openai-completions",
		provider: "clinepass",
		baseUrl: "https://api.cline.bot/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 16_384,
		...overrides,
	});
}

describe("#3858 DeepSeek V4 proxy effort clamp / wire visibility", () => {
	it("keeps :max as a first-class GJC level for namespaced custom DeepSeek V4 models", () => {
		const model = customDeepSeekProxy();
		expect(model.thinking?.maxLevel).toBe(Effort.Max);
		expect(getSupportedEfforts(model)).toContain(Effort.Max);
		expect(clampThinkingLevelForModel(model, Effort.Max)).toBe(Effort.Max);
		expect(clampThinkingLevelForModel(model, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("maps GJC xhigh/max to DeepSeek wire max on custom openai-compatible proxies", () => {
		const model = customDeepSeekProxy();
		const compat = resolveOpenAICompat(model);
		expect(compat.reasoningEffortMap).toMatchObject({
			minimal: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		});
		expect(resolveWireReasoningEffort(model, Effort.Max)).toEqual({
			effort: Effort.Max,
			wire: "max",
			remapped: false,
			hasMapEntry: true,
		});
		expect(resolveWireReasoningEffort(model, Effort.XHigh)).toEqual({
			effort: Effort.XHigh,
			wire: "max",
			remapped: true,
			hasMapEntry: true,
		});
	});

	it("refreshes bundled DeepSeek V4 thinking so max is not silently clamped to xhigh", () => {
		const bundled = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
		const refreshed = refreshModelThinking(bundled);
		expect(refreshed.thinking?.maxLevel).toBe(Effort.Max);
		expect(clampThinkingLevelForModel(refreshed, Effort.Max)).toBe(Effort.Max);
		expect(resolveWireReasoningEffort(refreshed, Effort.Max).wire).toBe("max");
	});

	it("does not invent a DeepSeek effort map for unrelated custom models", () => {
		const model = enrichModelThinking({
			id: "corp/generic-reasoner",
			name: "Generic Reasoner",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		}) as Model<"openai-completions">;

		expect(model.thinking?.maxLevel).toBe(Effort.XHigh);
		expect(clampThinkingLevelForModel(model, Effort.Max)).toBe(Effort.XHigh);
		const wire = resolveWireReasoningEffort(model, Effort.XHigh);
		expect(wire).toEqual({
			effort: Effort.XHigh,
			wire: "xhigh",
			remapped: false,
			hasMapEntry: false,
		});
	});
});
