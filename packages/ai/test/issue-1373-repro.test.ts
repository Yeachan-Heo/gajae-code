import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effort } from "../src/model-thinking";
import { getBundledModel } from "../src/models";
import { streamBedrock } from "../src/providers/amazon-bedrock";
import { streamSimple } from "../src/stream";
import type { Context, Model, Tool } from "../src/types";

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

const testTool: Tool = {
	name: "lookup",
	description: "Look up a value.",
	parameters: { type: "object", properties: {}, additionalProperties: false },
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

interface ThinkingPayload {
	additionalModelRequestFields?: {
		thinking?: { type?: string; display?: string; budget_tokens?: number };
		output_config?: { effort?: string };
	};
	inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number };
	toolConfig?: { toolChoice?: Record<string, unknown> };
}

function captureBedrockPayload(
	model: Model<"bedrock-converse-stream">,
	options: Parameters<typeof streamBedrock>[2] = {},
	context: Context = baseContext,
): Promise<ThinkingPayload> {
	const { promise, resolve } = Promise.withResolvers<ThinkingPayload>();
	void streamBedrock(model, context, {
		signal: abortedSignal(),
		...options,
		onPayload: payload => {
			resolve(payload as ThinkingPayload);
			return undefined;
		},
	});
	return promise;
}

function captureSimpleBedrockPayload(model: Model<"bedrock-converse-stream">): Promise<ThinkingPayload> {
	const { promise, resolve } = Promise.withResolvers<ThinkingPayload>();
	void streamSimple(model, baseContext, {
		signal: abortedSignal(),
		onPayload: payload => {
			resolve(payload as ThinkingPayload);
			return undefined;
		},
	});
	return promise;
}

describe("issue #1373: Bedrock Claude thinkingDisplay", () => {
	it("uses adaptive Haiku 5.5 effort and omits unsupported sampling fields", async () => {
		const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "us.anthropic.claude-haiku-5-5");
		const payload = await captureBedrockPayload(model, {
			reasoning: Effort.XHigh,
			temperature: 0.2,
			topP: 0.3,
		});
		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
		expect(payload.inferenceConfig?.temperature).toBeUndefined();
		expect(payload.inferenceConfig?.topP).toBeUndefined();
		const serializedPayload = JSON.stringify(payload);
		expect(serializedPayload).not.toContain('"temperature"');
		expect(serializedPayload).not.toContain('"topP"');
	});

	it("keeps sampling fields for Bedrock models without those restrictions", async () => {
		const payload = await captureBedrockPayload(budgetModel("us.anthropic.claude-haiku-4-5-20251001-v1:0"), {
			temperature: 0.2,
			topP: 0.3,
		});
		expect(payload.inferenceConfig?.temperature).toBe(0.2);
		expect(payload.inferenceConfig?.topP).toBe(0.3);
	});

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

	it("explicitly disables adaptive thinking when requested for Haiku 5.5", async () => {
		const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "us.anthropic.claude-haiku-5-5");
		const payload = await captureBedrockPayload(model, {
			reasoning: Effort.Max,
			disableReasoning: true,
		});

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "disabled" });
		expect(payload.additionalModelRequestFields?.output_config).toBeUndefined();
	});

	it("disables default-on Haiku thinking when no reasoning effort is requested", async () => {
		const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "us.anthropic.claude-haiku-5-5");
		const payload = await captureSimpleBedrockPayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "disabled" });
		expect(payload.additionalModelRequestFields?.output_config).toBeUndefined();
	});

	it("leaves always-on Opus 5.5 at the provider default when effort is omitted", async () => {
		const payload = await captureSimpleBedrockPayload(adaptiveModel("us.anthropic.claude-opus-5-5"));

		expect(payload.additionalModelRequestFields).toBeUndefined();
	});

	it("preserves requested Haiku 5.5 adaptive thinking for forced tool choice", async () => {
		const bundledModel = getBundledModel<"bedrock-converse-stream">(
			"amazon-bedrock",
			"us.anthropic.claude-haiku-5-5",
		);
		const model = {
			...bundledModel,
			compat: { ...bundledModel.compat, supportsForcedToolChoice: true },
		};
		const payload = await captureBedrockPayload(
			model,
			{ toolChoice: "required", reasoning: Effort.High },
			{ ...baseContext, tools: [testTool] },
		);

		expect(payload.toolConfig?.toolChoice).toEqual({ any: {} });
		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
	});
});
