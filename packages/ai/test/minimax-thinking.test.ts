import { describe, expect, it } from "bun:test";
import {
	applyGeneratedModelPolicies,
	clampThinkingLevelForModel,
	Effort,
	enrichModelThinking,
	getMiniMaxThinkingMode,
	getSupportedEfforts,
	modelSupportsReasoningControl,
	refreshModelThinking,
} from "../src/model-thinking";
import { getBundledModel, getBundledModels } from "../src/models";
import { streamAnthropic } from "../src/providers/anthropic";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamSimple } from "../src/stream";
import type { Context, Model, SimpleStreamOptions } from "../src/types";

const providers = ["minimax", "minimax-cn", "minimax-code", "minimax-code-cn"] as const;
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

async function capturePayload(model: Model, options: SimpleStreamOptions): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const result = await streamSimple(model, context, {
		...options,
		apiKey: "test-key",
		signal: AbortSignal.abort(),
		onPayload: value => {
			payload = value as Record<string, unknown>;
			throw new Error("MiniMax payload captured");
		},
	}).result();
	expect(result.stopReason).toBe("aborted");
	if (!payload) throw new Error(`Missing payload: ${result.errorMessage}`);
	return payload;
}

describe("MiniMax native thinking capabilities", () => {
	for (const provider of providers) {
		it(`${provider}: exposes only the M3 enabled state and survives metadata refresh`, () => {
			const model = getBundledModel(provider, "MiniMax-M3");
			const stale = {
				...model,
				thinking: { mode: "budget" as const, minLevel: Effort.Low, maxLevel: Effort.XHigh },
			};
			const generated = [stale];
			applyGeneratedModelPolicies(generated);
			for (const candidate of [model, enrichModelThinking(stale), refreshModelThinking(stale), ...generated]) {
				expect(getMiniMaxThinkingMode(candidate)).toBe("toggle");
				expect(modelSupportsReasoningControl(candidate)).toBe(true);
				expect(getSupportedEfforts(candidate)).toEqual([Effort.High]);
				expect(clampThinkingLevelForModel(candidate, Effort.Low)).toBe(Effort.High);
				expect(clampThinkingLevelForModel(candidate, Effort.XHigh)).toBe(Effort.High);
			}
		});

		it(`${provider}: M2.x keeps reasoning without exposing fake controls`, () => {
			const models = getBundledModels(provider).filter(model => model.id.startsWith("MiniMax-M2"));
			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect(model.reasoning).toBe(true);
				expect(getMiniMaxThinkingMode(model)).toBe("always-on");
				expect(modelSupportsReasoningControl(model)).toBe(false);
				expect(getSupportedEfforts(model)).toEqual([]);
				expect(model.thinking).toBeUndefined();
			}
		});

		it(`${provider}: sends adaptive/disabled without effort, budgets or max-token inflation`, async () => {
			const model = getBundledModel(provider, "MiniMax-M3");
			for (const [options, type] of [
				[{}, "disabled"],
				[{ reasoning: Effort.High }, "adaptive"],
				[{ disableReasoning: true }, "disabled"],
				[{ reasoning: Effort.High, disableReasoning: true }, "disabled"],
			] as const) {
				const payload = await capturePayload(model, { ...options, maxTokens: 1024 });
				expect(payload.thinking).toEqual({ type });
				expect(payload.reasoning_effort).toBeUndefined();
				expect(payload.output_config).toBeUndefined();
				expect(payload.max_tokens ?? payload.max_completion_tokens).toBe(1024);
			}
		});

		it(`${provider}: does not send ineffective M2.x thinking controls`, async () => {
			const payload = await capturePayload(getBundledModel(provider, "MiniMax-M2.7"), {
				disableReasoning: true,
				maxTokens: 1024,
			});
			expect(payload.thinking).toBeUndefined();
			expect(payload.reasoning_effort).toBeUndefined();
			expect(payload.output_config).toBeUndefined();
			expect(payload.max_tokens ?? payload.max_completion_tokens).toBe(1024);
		});
	}

	it("does not grant MiniMax controls to custom proxies or unknown models", () => {
		const model = getBundledModel("minimax-code", "MiniMax-M3");
		for (const candidate of [
			{ ...model, provider: "custom-proxy", baseUrl: "https://proxy.invalid/v1" },
			{ ...model, id: "MiniMax-M30" },
		]) {
			expect(getMiniMaxThinkingMode(candidate)).toBeUndefined();
			expect(modelSupportsReasoningControl(candidate)).toBe(false);
		}
	});

	it("preserves omitted native API switches instead of inventing effort settings", async () => {
		for (const provider of providers) {
			let payload: Record<string, unknown> | undefined;
			const options = {
				apiKey: "test-key",
				signal: AbortSignal.abort(),
				onPayload: (value: unknown) => {
					payload = value as Record<string, unknown>;
					throw new Error("MiniMax payload captured");
				},
			};
			const stream =
				provider === "minimax" || provider === "minimax-cn"
					? streamAnthropic(getBundledModel<"anthropic-messages">(provider, "MiniMax-M3"), context, options)
					: streamOpenAICompletions(
							getBundledModel<"openai-completions">(provider, "MiniMax-M3"),
							context,
							options,
						);
			await stream.result();
			expect(payload).toBeDefined();
			expect(payload?.thinking).toBeUndefined();
			expect(payload?.reasoning_effort).toBeUndefined();
		}
	});
});
