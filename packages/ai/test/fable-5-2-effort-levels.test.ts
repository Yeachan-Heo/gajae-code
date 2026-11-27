import { describe, expect, it } from "bun:test";
import { clampThinkingLevelForModel, Effort, getBundledModel, getSupportedEfforts } from "@gajae-code/ai";
import { isAnthropicThinkingAlwaysOn } from "@gajae-code/ai/model-thinking";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { Context, Model } from "@gajae-code/ai/types";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function directFable52(): Model<"anthropic-messages"> {
	const model = getBundledModel<"anthropic-messages">("anthropic", "claude-fable-5-2");
	if (!model) throw new Error("Expected bundled Anthropic Fable 5.2");
	return model;
}

function capturePayload(model: Model<"anthropic-messages">, reasoning: Effort): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	const controller = new AbortController();
	controller.abort();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-test",
		signal: controller.signal,
		thinkingEnabled: true,
		reasoning,
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

describe("Fable 5.2 reasoning contract", () => {
	it("offers both xhigh and max on the direct Anthropic Messages API", () => {
		expect(getSupportedEfforts(directFable52())).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
	});

	it("sends max effort unclamped as adaptive thinking", async () => {
		const model = directFable52();
		expect(clampThinkingLevelForModel(model, Effort.Max)).toBe(Effort.Max);
		const payload = await capturePayload(model, Effort.Max);
		expect(payload.thinking).toMatchObject({ type: "adaptive" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("marks Fable 5.2 thinking as always on, across providers and dated ids, but not earlier Fable", () => {
		expect(isAnthropicThinkingAlwaysOn("claude-fable-5-2")).toBe(true);
		expect(isAnthropicThinkingAlwaysOn("claude-fable-5-2-20261109")).toBe(true);
		expect(isAnthropicThinkingAlwaysOn("us.anthropic.claude-fable-5-2")).toBe(true);
		expect(isAnthropicThinkingAlwaysOn("claude-fable-5-1")).toBe(false);
		expect(isAnthropicThinkingAlwaysOn("claude-opus-4-7")).toBe(false);
	});
});
