import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamBedrock } from "../src/providers/amazon-bedrock";
import type { Model } from "../src/types";

async function captureInferenceConfig(model: Model<"bedrock-converse-stream">): Promise<Record<string, unknown>> {
	let payload: { inferenceConfig?: Record<string, unknown> } | undefined;
	const stream = streamBedrock(
		model,
		{ messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
		{
			region: "us-east-1",
			cacheRetention: "none",
			maxTokens: 64,
			temperature: 0.5,
			topP: 0.9,
			onPayload: body => {
				payload = body as typeof payload;
				// Capture the provider request before credential lookup or network I/O.
				throw new Error("Payload captured for test");
			},
		},
	);
	await stream.result();
	if (!payload?.inferenceConfig) throw new Error("Bedrock did not produce an inferenceConfig");
	return payload.inferenceConfig;
}

describe("Bedrock Converse sampling parameters", () => {
	it.each([
		"anthropic.claude-fable-5-2",
		"us.anthropic.claude-fable-5-2",
		"global.anthropic.claude-fable-5-1",
		"us.anthropic.claude-haiku-5-5",
	])("omits temperature and topP for %s", async modelId => {
		const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", modelId as never);
		if (!model) throw new Error(`Expected bundled Bedrock ${modelId} model`);
		const config = await captureInferenceConfig(model);
		expect(config).toEqual({ maxTokens: 64 });
	});

	it("forwards temperature and topP for models without the restriction", async () => {
		const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "us.amazon.nova-lite-v1:0");
		const config = await captureInferenceConfig(model);
		expect(config).toEqual({ maxTokens: 64, temperature: 0.5, topP: 0.9 });
	});
});
