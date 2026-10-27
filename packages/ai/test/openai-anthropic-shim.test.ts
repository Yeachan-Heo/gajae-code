import { describe, expect, it } from "bun:test";
import { Effort } from "../src/model-thinking";
import { streamOpenAIAnthropicShim } from "../src/providers/openai-anthropic-shim";
import type { Api, Context, Model } from "../src/types";

const kimiK3: Model<"openai-completions"> = {
	id: "k3",
	name: "K3",
	api: "openai-completions",
	provider: "kimi-code",
	baseUrl: "https://api.kimi.com/coding/v1",
	reasoning: true,
	thinking: {
		mode: "effort",
		minLevel: Effort.Low,
		maxLevel: Effort.Max,
		levels: [Effort.Low, Effort.High, Effort.Max],
		defaultLevel: Effort.High,
	},
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 32_000,
	streamIdleTimeoutMs: 25,
};

const context: Context = {
	messages: [{ role: "user", content: "Ping", timestamp: 0 }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function isAnthropicMessagesModel(model: Model<Api> | undefined): model is Model<"anthropic-messages"> {
	return model?.api === "anthropic-messages";
}

describe("OpenAI-Anthropic compatibility shim", () => {
	it("preserves thinking metadata when routing Kimi through Anthropic Messages", async () => {
		const captured = Promise.withResolvers<Model<"anthropic-messages">>();
		const stream = streamOpenAIAnthropicShim(
			kimiK3,
			context,
			{
				format: "anthropic",
				apiKey: "test-key",
				reasoning: Effort.Max,
				signal: abortedSignal(),
				fetch: async () => {
					throw new Error("The shim regression test must not make a network request");
				},
				onPayload: (_payload, model) => {
					if (isAnthropicMessagesModel(model)) {
						captured.resolve(model);
					}
					return undefined;
				},
			},
			{
				anthropicBaseUrl: "https://api.kimi.com/coding",
				defaultFormat: "anthropic",
			},
		);

		const routed = await Promise.race([
			captured.promise,
			stream.result().then(result => {
				throw new Error(`Expected an Anthropic payload, received ${String(result)}`);
			}),
		]);

		expect(routed.thinking).toEqual(kimiK3.thinking);
		expect(routed.streamIdleTimeoutMs).toBe(25);
	});
});
