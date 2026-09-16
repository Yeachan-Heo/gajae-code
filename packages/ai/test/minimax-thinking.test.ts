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

		it(`${provider}: validates the normalized endpoint rather than the provider identity`, () => {
			const model = getBundledModel(provider, "MiniMax-M3");
			const endpoint = new URL(model.baseUrl);
			const nativePath = endpoint.pathname;
			for (const baseUrl of [
				`${model.baseUrl}/`,
				`https://${endpoint.hostname.toUpperCase()}:443${nativePath}/`,
				...(model.api === "anthropic-messages" ? [`${model.baseUrl}/v1/`] : []),
			]) {
				expect(getMiniMaxThinkingMode({ ...model, baseUrl })).toBe("toggle");
			}
			for (const baseUrl of [
				`https://proxy.invalid${nativePath}`,
				`https://${endpoint.hostname}.proxy.invalid${nativePath}`,
				`https://sub.${endpoint.hostname}${nativePath}`,
				`http://${endpoint.hostname}${nativePath}`,
				`https://${endpoint.hostname}:8443${nativePath}`,
				`https://user:password@${endpoint.hostname}${nativePath}`,
				`https://${endpoint.hostname}/custom-proxy`,
				`${model.baseUrl}?upstream=proxy`,
				`${model.baseUrl}#proxy`,
				"not-a-url",
				"",
			]) {
				for (const id of ["MiniMax-M3", "MiniMax-M3[1m]", "MiniMax-M2.7"]) {
					expect(getMiniMaxThinkingMode({ ...model, id, baseUrl })).toBeUndefined();
					expect(getMiniMaxThinkingMode({ ...model, id }, baseUrl)).toBeUndefined();
				}
				if (model.api === "openai-completions") {
					expect(modelSupportsReasoningControl({ ...model, baseUrl })).toBe(false);
					expect(modelSupportsReasoningControl(model, baseUrl)).toBe(false);
				}
			}
		});

		it(`${provider}: does not emit native thinking switches to a proxy retaining the built-in provider ID`, async () => {
			for (const enabled of [true, false]) {
				const model = { ...getBundledModel(provider, "MiniMax-M3"), baseUrl: "https://proxy.invalid/v1" };
				let payload: Record<string, unknown> | undefined;
				const options = {
					apiKey: "test-key",
					signal: AbortSignal.abort(),
					thinkingEnabled: enabled,
					reasoning: enabled ? Effort.High : undefined,
					disableReasoning: !enabled,
					onPayload: (value: unknown) => {
						payload = value as Record<string, unknown>;
						throw new Error("Proxy payload captured");
					},
				};
				const stream =
					model.api === "anthropic-messages"
						? streamAnthropic(model as Model<"anthropic-messages">, context, options)
						: streamOpenAICompletions(model as Model<"openai-completions">, context, options);
				await stream.result();
				expect(payload).toBeDefined();
				if (model.api === "anthropic-messages" && enabled) {
					// Preserve the pre-existing generic Anthropic budget behavior, not MiniMax adaptive.
					expect(payload?.thinking).toMatchObject({ type: "enabled", budget_tokens: 1024 });
				} else {
					expect(payload?.thinking).toBeUndefined();
				}
				expect(payload?.reasoning_effort).toBeUndefined();
			}
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
