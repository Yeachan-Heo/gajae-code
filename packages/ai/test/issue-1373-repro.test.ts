import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effort } from "../src/model-thinking";
import { getBundledModel } from "../src/models";
import { streamBedrock } from "../src/providers/amazon-bedrock";
import { streamSimple } from "../src/stream";
import type { Context, Model, SimpleStreamOptions } from "../src/types";

const originalSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;

beforeAll(() => {
	process.env.AWS_BEDROCK_SKIP_AUTH = "1";
});

afterAll(() => {
	if (originalSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
	else process.env.AWS_BEDROCK_SKIP_AUTH = originalSkipAuth;
});

function adaptiveModel(id: string): Model<"bedrock-converse-stream"> {
	return {
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinking: { mode: "anthropic-adaptive", minLevel: Effort.Minimal, maxLevel: Effort.XHigh },
	};
}

function budgetModel(id: string): Model<"bedrock-converse-stream"> {
	return {
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		thinking: { mode: "budget", minLevel: Effort.Minimal, maxLevel: Effort.High },
	};
}

const baseContext: Context = {
	systemPrompt: ["You are concise."],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

interface ThinkingPayload {
	inferenceConfig?: { maxTokens?: number };
	additionalModelRequestFields?: {
		thinking?: { type?: string; display?: string; budget_tokens?: number };
		output_config?: { effort?: string };
	};
}

function bundledHaiku55BedrockModel(): Model<"bedrock-converse-stream"> {
	const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "us.anthropic.claude-haiku-5-5");
	if (!model) throw new Error("Expected bundled Bedrock Haiku 5.5 model");
	return model;
}

function captureBedrockPayload(
	model: Model<"bedrock-converse-stream">,
	options: Parameters<typeof streamBedrock>[2] = {},
): Promise<ThinkingPayload> {
	const { promise, resolve } = Promise.withResolvers<ThinkingPayload>();
	void streamBedrock(model, baseContext, {
		signal: abortedSignal(),
		...options,
		onPayload: payload => {
			resolve(payload as ThinkingPayload);
			return undefined;
		},
	});
	return promise;
}

function captureSimpleBedrockPayload(
	model: Model<"bedrock-converse-stream">,
	options: SimpleStreamOptions = {},
): Promise<ThinkingPayload> {
	const { promise, resolve } = Promise.withResolvers<ThinkingPayload>();
	void streamSimple(model, baseContext, {
		...options,
		signal: abortedSignal(),
		onPayload: payload => {
			resolve(payload as ThinkingPayload);
			return undefined;
		},
	});
	return promise;
}

describe("issue #1373: Bedrock Claude thinkingDisplay", () => {
	it("defaults adaptive thinking to display=summarized on Opus 4.7+", async () => {
		const payload = await captureBedrockPayload(adaptiveModel("anthropic.claude-opus-4-7"), {
			reasoning: Effort.High,
		});
		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "adaptive",
			display: "summarized",
		});
	});

	it("defaults adaptive thinking to display=summarized on Fable 5", async () => {
		const payload = await captureBedrockPayload(adaptiveModel("us.anthropic.claude-fable-5"), {
			reasoning: Effort.High,
		});
		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "adaptive",
			display: "summarized",
		});
	});

	it("respects explicit thinkingDisplay='omitted' on Opus 4.7+", async () => {
		const payload = await captureBedrockPayload(adaptiveModel("eu.anthropic.claude-opus-4-7"), {
			reasoning: Effort.High,
			thinkingDisplay: "omitted",
		});
		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "adaptive",
			display: "omitted",
		});
	});

	it("omits display on adaptive Opus 4.6 (older models reject the field)", async () => {
		const payload = await captureBedrockPayload(adaptiveModel("global.anthropic.claude-opus-4-6-v1"), {
			reasoning: Effort.High,
		});
		const thinking = payload.additionalModelRequestFields?.thinking;
		expect(thinking?.type).toBe("adaptive");
		expect(thinking?.display).toBeUndefined();
	});

	it("sends display=summarized by default on budget-based thinking models", async () => {
		const payload = await captureBedrockPayload(budgetModel("us.anthropic.claude-haiku-4-5-20251001-v1:0"), {
			reasoning: Effort.High,
		});
		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "enabled",
			display: "summarized",
		});
		expect(typeof payload.additionalModelRequestFields?.thinking?.budget_tokens).toBe("number");
	});

	it("sends adaptive Haiku 5.5 xhigh and max effort through Bedrock Converse", async () => {
		const model = bundledHaiku55BedrockModel();
		expect(model.thinking?.mode).toBe("anthropic-adaptive");
		for (const effort of [Effort.XHigh, Effort.Max]) {
			const payload = await captureBedrockPayload(model, { reasoning: effort });
			expect(payload.additionalModelRequestFields).toEqual({
				thinking: { type: "adaptive", display: "summarized" },
				output_config: { effort },
			});
		}
	});

	it("disables Haiku 5.5 thinking through Bedrock Converse when Off is selected", async () => {
		const payload = await captureBedrockPayload(bundledHaiku55BedrockModel());

		expect(payload.additionalModelRequestFields).toEqual({ thinking: { type: "disabled" } });
	});

	it("lets explicit Bedrock Haiku 5.5 Off override a selected effort", async () => {
		const payload = await captureSimpleBedrockPayload(bundledHaiku55BedrockModel(), {
			reasoning: Effort.High,
			disableReasoning: true,
		});

		expect(payload.additionalModelRequestFields).toEqual({ thinking: { type: "disabled" } });
	});

	it("keeps the selected effort on forced-tool Haiku 5.5 Bedrock requests with thinking disabled", async () => {
		for (const [reasoning, expected] of [
			[Effort.Medium, "medium"],
			[Effort.High, "high"],
			[Effort.XHigh, "high"],
			[Effort.Max, "high"],
		] as const) {
			const { promise, resolve } = Promise.withResolvers<ThinkingPayload>();
			void streamBedrock(
				bundledHaiku55BedrockModel(),
				{
					...baseContext,
					tools: [
						{ name: "resolve", description: "Resolve", parameters: { type: "object", properties: {} } as never },
					],
				},
				{
					signal: abortedSignal(),
					reasoning,
					toolChoice: { type: "tool", name: "resolve" },
					onPayload: payload => {
						resolve(payload as ThinkingPayload);
						return undefined;
					},
				},
			);
			const payload = await promise;
			expect(payload.additionalModelRequestFields).toEqual({
				thinking: { type: "disabled" },
				output_config: { effort: expected },
			});
		}
	});

	it("keeps Haiku 5.5 thinking disabled when a forced tool choice is sent", async () => {
		const { promise, resolve } = Promise.withResolvers<ThinkingPayload & { toolConfig?: { toolChoice?: unknown } }>();
		void streamBedrock(
			bundledHaiku55BedrockModel(),
			{
				...baseContext,
				tools: [
					{ name: "resolve", description: "Resolve", parameters: { type: "object", properties: {} } as never },
				],
			},
			{
				signal: abortedSignal(),
				toolChoice: { type: "tool", name: "resolve" },
				onPayload: payload => {
					resolve(payload as ThinkingPayload & { toolConfig?: { toolChoice?: unknown } });
					return undefined;
				},
			},
		);
		const payload = await promise;

		expect(payload.toolConfig?.toolChoice).toEqual({ tool: { name: "resolve" } });
		expect(payload.additionalModelRequestFields).toEqual({ thinking: { type: "disabled" } });
	});

	it("preserves the requested output cap when budget-mode Bedrock reasoning is disabled", async () => {
		const payload = await captureSimpleBedrockPayload(budgetModel("us.anthropic.claude-haiku-4-5-20251001-v1:0"), {
			reasoning: Effort.High,
			disableReasoning: true,
			maxTokens: 1024,
		});

		expect(payload.inferenceConfig?.maxTokens).toBe(1024);
		expect(payload.additionalModelRequestFields).toBeUndefined();
	});
});
