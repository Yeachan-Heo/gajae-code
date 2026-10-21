import { afterEach, describe, expect, it } from "bun:test";
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
import { DEFAULT_MODEL_PER_PROVIDER } from "../src/provider-models/descriptors";
import { streamAnthropic } from "../src/providers/anthropic";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamSimple } from "../src/stream";
import type { Context, Model, SimpleStreamOptions } from "../src/types";

const providers = ["minimax", "minimax-cn", "minimax-code", "minimax-code-cn"] as const;
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

// #1203
describe("MiniMax Coding Plan CN thinking-tag stream parsing", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	function createSseResponse(events: unknown[]): Response {
		const payload = `${events
			.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
			.join("\n\n")}\n\n`;
		return new Response(payload, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	function createMockFetch(events: unknown[]): typeof fetch {
		async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
			return createSseResponse(events);
		}
		return Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
	}

	function baseContext(): Context {
		return {
			messages: [
				{
					role: "user",
					content: "hello",
					timestamp: Date.now(),
				},
			],
		};
	}

	function minimaxChunk(model: Model<"openai-completions">, content: string): unknown {
		return {
			id: "chatcmpl-minimax-cn",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta: { content, role: "assistant" } }],
		};
	}

	function stopChunk(model: Model<"openai-completions">): unknown {
		return {
			id: "chatcmpl-minimax-cn",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		};
	}

	it("parses minimax-code-cn <think> content into a thinking block", async () => {
		const model = getBundledModel("minimax-code-cn", "MiniMax-M2.5") as Model<"openai-completions">;
		global.fetch = createMockFetch([
			minimaxChunk(model, "<think>"),
			minimaxChunk(model, "hidden reasoning"),
			minimaxChunk(model, "</think>"),
			minimaxChunk(model, "visible answer"),
			stopChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "hidden reasoning", thinkingSignature: undefined },
			{ type: "text", text: "visible answer" },
		]);
	});
});

// #385, #3896
describe("MiniMax canonical model catalog", () => {
	const anthropicMinimaxProviders = ["minimax", "minimax-cn"] as const;

	it("bundles canonical MiniMax-M3 across first-class MiniMax providers", () => {
		for (const provider of providers) {
			const model = getBundledModel(provider, "MiniMax-M3");

			expect(model).toBeDefined();
			expect(model.id).toBe("MiniMax-M3");
			expect(model.provider).toBe(provider);
			expect(model.name).toBe("MiniMax-M3");
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(512_000);
			expect(model.input).toContain("text");
			expect(model.input).toContain("image");
		}
	});

	it("does not bundle stale lowercase minimax-m3 aliases next to MiniMax-M3", () => {
		for (const provider of providers) {
			expect(getBundledModel(provider, "minimax-m3")).toBeUndefined();
		}
	});

	it("uses canonical MiniMax-M3 as the default first-class MiniMax model", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER.minimax).toBe("MiniMax-M3");
		expect(DEFAULT_MODEL_PER_PROVIDER["minimax-code"]).toBe("MiniMax-M3");
		expect(DEFAULT_MODEL_PER_PROVIDER["minimax-code-cn"]).toBe("MiniMax-M3");
	});

	it("bundles the Anthropic Token Plan MiniMax-M3[1m] id on Anthropic routes with 1M context", () => {
		for (const provider of anthropicMinimaxProviders) {
			const model = getBundledModel(provider, "MiniMax-M3[1m]");

			expect(model).toBeDefined();
			expect(model.id).toBe("MiniMax-M3[1m]");
			expect(model.provider).toBe(provider);
			expect(model.api).toBe("anthropic-messages");
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(128_000);
		}
	});

	it("does not widen unrelated MiniMax catalog aliases", () => {
		// minimax-v3 was a stale/non-official first-class id and must stay gone.
		expect(getBundledModel("minimax-code", "minimax-v3")).toBeUndefined();
		// Unrelated catalog providers keep their own lowercase minimax-m3 contract.
		expect(getBundledModel("opencode-zen", "minimax-m3")?.contextWindow).toBe(512_000);
	});
});

// #955
describe("MiniMax coding-plan payload normalization", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	const context: Context = {
		systemPrompt: ["stable instructions", "cacheable policy"],
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	};

	function abortedSignal(): AbortSignal {
		const controller = new AbortController();
		controller.abort();
		return controller.signal;
	}

	async function capturePayload(model: Model<"openai-completions">): Promise<Record<string, unknown>> {
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			signal: abortedSignal(),
			reasoning: "high",
			onPayload: payload => resolve(payload as Record<string, unknown>),
		});
		return await promise;
	}

	it.each([
		["minimax-code", "MiniMax-M2.5"],
		["minimax-code-cn", "MiniMax-M2.5"],
	] as const)("omits unsupported thinking fields for %s/%s", async (provider, modelId) => {
		const model = getBundledModel(provider, modelId) as Model<"openai-completions">;
		const body = await capturePayload(model);

		expect(body.model).toBe(modelId);
		expect(body.messages).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
		expect(body.thinking).toBeUndefined();
		expect(body.reasoning).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});
});

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
