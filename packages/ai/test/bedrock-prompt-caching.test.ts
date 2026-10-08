import { describe, expect, it } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import { isUnsupportedBedrockConverseModel } from "../src/bedrock-claude-cache-policy";
import { applyGeneratedModelPolicies } from "../src/model-thinking";
import { calculateCost, getBundledModel, getBundledModels } from "../src/models";
import { parseBedrockClaudeGeneration, streamBedrock, supportsPromptCaching } from "../src/providers/amazon-bedrock";
import { crc32 } from "../src/providers/aws-eventstream";
import { streamSimple } from "../src/stream";
import type { AssistantMessage, Context, Model, Usage } from "../src/types";
import { isProviderSafetyStopAuthenticated } from "../src/utils/provider-safety-stop";

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	const result = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(result.buffer);
	let offset = 0;
	view.setUint8(offset++, nameBytes.length);
	result.set(nameBytes, offset);
	offset += nameBytes.length;
	view.setUint8(offset++, 7);
	view.setUint16(offset, valueBytes.length, false);
	offset += 2;
	result.set(valueBytes, offset);
	return result;
}

function encodeBedrockEvent(eventType: string, payload: unknown): Uint8Array {
	const headers = [
		encodeStringHeader(":message-type", "event"),
		encodeStringHeader(":event-type", eventType),
		encodeStringHeader(":content-type", "application/json"),
	];
	const headerLength = headers.reduce((length, header) => length + header.length, 0);
	const headerBytes = new Uint8Array(headerLength);
	let headerOffset = 0;
	for (const header of headers) {
		headerBytes.set(header, headerOffset);
		headerOffset += header.length;
	}
	const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
	const totalLength = 12 + headerLength + payloadBytes.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headerBytes, 12);
	frame.set(payloadBytes, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

function bedrockEventStreamResponse(events: Array<{ type: string; payload: unknown }>): Response {
	const frames = events.map(event => encodeBedrockEvent(event.type, event.payload));
	const bodyLength = frames.reduce((length, frame) => length + frame.length, 0);
	const body = new Uint8Array(bodyLength);
	let offset = 0;
	for (const frame of frames) {
		body.set(frame, offset);
		offset += frame.length;
	}
	return new Response(body, {
		status: 200,
		headers: { "content-type": "application/vnd.amazon.eventstream" },
	});
}

function bedrockModel(id: string, cachePriced = false): Model<"bedrock-converse-stream"> {
	return {
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: cachePriced
			? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
			: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

describe("Bedrock Haiku 5.5 Converse availability", () => {
	it("excludes the Mantle-only bare ID but keeps Runtime inference profiles", () => {
		const base = { provider: "amazon-bedrock", api: "bedrock-converse-stream" };
		expect(isUnsupportedBedrockConverseModel({ ...base, id: "anthropic.claude-haiku-5-5" })).toBe(true);
		for (const id of [
			"us.anthropic.claude-haiku-5-5",
			"eu.anthropic.claude-haiku-5-5",
			"au.anthropic.claude-haiku-5-5",
			"jp.anthropic.claude-haiku-5-5",
			"global.anthropic.claude-haiku-5-5",
		]) {
			expect(isUnsupportedBedrockConverseModel({ ...base, id })).toBe(false);
		}
		expect(
			isUnsupportedBedrockConverseModel({
				provider: "amazon-bedrock",
				api: "anthropic-messages",
				id: "anthropic.claude-haiku-5-5",
			}),
		).toBe(false);
	});
});

describe("Bedrock prompt caching support", () => {
	it("uses one generation table for request caching and cache-pricing metadata", () => {
		const accepted = [
			"anthropic.claude-3-5-haiku-20241022-v1:0",
			"eu.anthropic.claude-3-7-sonnet-20250219-v1:0",
			"anthropic.claude-opus-4-20250514-v1:0",
			"global.anthropic.claude-sonnet-4-5-20250929-v1:0",
			"au.anthropic.claude-haiku-4-5-20251001-v1:0",
			"jp.anthropic.claude-sonnet-4-6",
			"apac.anthropic.claude-opus-5",
			"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1:0",
			"arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/anthropic.claude-opus-4-20250514-v1:0",
		];
		const rejected = [
			"anthropic.claude-3-opus-20240229-v1:0",
			"anthropic.claude-3-haiku-20240307-v1:0",
			"anthropic.claude-3-5-sonnet-20240620-v1:0",
			"anthropic.claude-3-7-haiku-20250219-v1:0",
			"anthropic.claude-opus-4-6--preview",
			"anthropic.claude-v2:0",
		];
		for (const [expected, ids] of [
			[true, accepted],
			[false, rejected],
		] as const) {
			for (const id of ids) {
				const models = [bedrockModel(id, true)];
				expect(supportsPromptCaching(models[0]!), id).toBe(expected);
				applyGeneratedModelPolicies(models);
				const model = models[0]!;
				expect(model.cost.cacheRead !== 0 || model.cost.cacheWrite !== 0, id).toBe(expected);
				const usage: Usage = {
					input: 0,
					output: 0,
					cacheRead: 1_000_000,
					cacheWrite: 1_000_000,
					totalTokens: 2_000_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				calculateCost(model, usage);
				expect(usage.cost.cacheRead !== 0 || usage.cost.cacheWrite !== 0, id).toBe(expected);
			}
		}
	});

	it("prices Bedrock Claude cache writes from the reported TTL breakdown", async () => {
		const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "us.anthropic.claude-haiku-5-5");
		const context: Context = {
			systemPrompt: ["Stable context."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		};
		const cacheWriteTokens = 1_000_001;
		const originalSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;
		const originalBearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
		process.env.AWS_BEDROCK_SKIP_AUTH = "1";
		delete process.env.AWS_BEARER_TOKEN_BEDROCK;

		try {
			const readCacheUsage = async (ttl: "5m" | "1h") => {
				using _fetchHook = hookFetch(async () =>
					bedrockEventStreamResponse([
						{ type: "messageStart", payload: { role: "assistant" } },
						{
							type: "metadata",
							payload: {
								usage: {
									inputTokens: 0,
									outputTokens: 0,
									cacheWriteInputTokens: cacheWriteTokens,
									totalTokens: cacheWriteTokens,
									cacheDetails: [{ ttl, inputTokens: cacheWriteTokens }],
								},
							},
						},
						{ type: "messageStop", payload: { stopReason: "end_turn" } },
					]),
				);
				return await streamBedrock(model, context, {
					region: "us-east-1",
					cacheRetention: ttl === "1h" ? "long" : "short",
				}).result();
			};

			const oneHour = await readCacheUsage("1h");
			expect(oneHour.usage.cttl).toEqual({ ephemeral1h: cacheWriteTokens });
			expect(oneHour.usage.cost.cacheWrite).toBeCloseTo(1.1000011, 10);

			const fiveMinute = await readCacheUsage("5m");
			expect(fiveMinute.usage.cttl).toEqual({ ephemeral5m: cacheWriteTokens });
			expect(fiveMinute.usage.cost.cacheWrite).toBeCloseTo(0.6875006875, 10);
		} finally {
			if (originalSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
			else process.env.AWS_BEDROCK_SKIP_AUTH = originalSkipAuth;
			if (originalBearerToken === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
			else process.env.AWS_BEARER_TOKEN_BEDROCK = originalBearerToken;
		}
	});

	it("keeps covering future generations without a source patch", () => {
		for (const id of [
			"us.anthropic.claude-opus-5-20300101-v1:0",
			"eu.anthropic.claude-fable-5-20300101-v1:0",
			"anthropic.claude-6-1-fable-20400101-v1:0",
		]) {
			expect(supportsPromptCaching(bedrockModel(id)), id).toBe(true);
		}
	});

	it("rejects non-Claude lookalikes and malformed model ids", () => {
		for (const id of [
			"amazon.claude-opus-5-20300101-v1:0",
			"notanthropic.claude-opus-5-20300101-v1:0",
			"anthropic.not-claude-opus-5-20300101-v1:0",
			"custom-anthropic.claude-opus-5-20300101-v1:0",
			"custom/us.anthropic.claude-opus-5-20300101-v1:0",
			"arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/us.anthropic.claude-opus-5",
			"arn:aws:bedrock:us-east-1:123456789012:prompt/us.anthropic.claude-opus-5",
			"anthropic.claude-opus-04-5-20300101-v1:0",
			"anthropic.claude-opus-4-05-20300101-v1:0",
			"anthropic.claude-opus-4-5--preview",
			"anthropic.claude-opus-4-5-preview_1",
			"anthropic.claude-6-1-20400101-v1:0",
			"ANTHROPIC.CLAUDE-OPUS-5",
		]) {
			expect(supportsPromptCaching(bedrockModel(id)), id).toBe(false);
		}
	});

	it("does not let stale pricing re-enable malformed Claude ids", () => {
		for (const id of [
			"anthropic.claude-opus-04-5-20300101-v1:0",
			"anthropic.claude-opus-4-05-20300101-v1:0",
			"anthropic.claude-opus-4-5--preview",
			"ANTHROPIC.CLAUDE-OPUS-5",
		]) {
			expect(supportsPromptCaching(bedrockModel(id, true)), id).toBe(false);
		}
	});

	it("trusts catalog cache pricing for non-Claude models and excludes the rest", () => {
		expect(supportsPromptCaching(bedrockModel("amazon.nova-pro-v1", true))).toBe(true);
		expect(supportsPromptCaching(bedrockModel("amazon.nova-pro-v1"))).toBe(false);
		expect(supportsPromptCaching(bedrockModel("mistral.mistral-large-2407-v1:0"))).toBe(false);
	});
});

// Pre-3.5 ids intentionally parse as undefined (no Bedrock cache points).
// Frozen history — a new id shape failing to parse is not in this table and
// must trip the sweep below.
const LEGACY_UNPARSABLE_BEDROCK_CLAUDE_IDS: Record<string, true> = {
	"anthropic.claude-3-haiku-20240307-v1:0": true,
	"anthropic.claude-3-opus-20240229-v1:0": true,
	"anthropic.claude-3-sonnet-20240229-v1:0": true,
	"eu.anthropic.claude-3-haiku-20240307-v1:0": true,
	"eu.anthropic.claude-3-opus-20240229-v1:0": true,
	"eu.anthropic.claude-3-sonnet-20240229-v1:0": true,
};

describe("bundled Bedrock catalog id-shape tripwire", () => {
	it("parses a generation out of every bundled Bedrock Claude id", () => {
		const unparsable = getBundledModels("amazon-bedrock")
			.filter(model => model.id.toLowerCase().includes("claude"))
			.filter(model => parseBedrockClaudeGeneration(model.id.toLowerCase()) === undefined)
			.filter(model => !(model.id in LEGACY_UNPARSABLE_BEDROCK_CLAUDE_IDS));
		expect(unparsable.map(model => model.id)).toEqual([]);
	});

	it("guards against the sweep going vacuous", () => {
		const claudeIds = getBundledModels("amazon-bedrock").filter(model => model.id.toLowerCase().includes("claude"));
		expect(claudeIds.length).toBeGreaterThan(0);
		expect(
			claudeIds.filter(model => parseBedrockClaudeGeneration(model.id.toLowerCase()) !== undefined).length,
		).toBeGreaterThan(0);
	});
});

async function runBedrockSafetyStop(
	stopReason: "content_filtered" | "guardrail_intervened",
	throughDispatcher: boolean,
): Promise<AssistantMessage> {
	const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "us.anthropic.claude-haiku-5-5");
	const context: Context = {
		systemPrompt: [],
		messages: [{ role: "user", content: "Please answer safely.", timestamp: Date.now() }],
	};
	const originalSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;
	const originalBearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
	process.env.AWS_BEDROCK_SKIP_AUTH = "1";
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;

	try {
		using _fetchHook = hookFetch(async () =>
			bedrockEventStreamResponse([
				{ type: "messageStart", payload: { role: "assistant" } },
				{
					type: "messageStop",
					payload: {
						stopReason,
						additionalModelResponseFields: { guardrailAction: "BLOCKED", category: "safety" },
					},
				},
			]),
		);
		return throughDispatcher
			? await streamSimple(model, context, {}).result()
			: await streamBedrock(model, context, {}).result();
	} finally {
		if (originalSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
		else process.env.AWS_BEDROCK_SKIP_AUTH = originalSkipAuth;
		if (originalBearerToken === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		else process.env.AWS_BEARER_TOKEN_BEDROCK = originalBearerToken;
	}
}

describe("Bedrock provider safety stops", () => {
	it("preserves and authenticates content_filtered refusals through trusted dispatch", async () => {
		const result = await runBedrockSafetyStop("content_filtered", true);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stopReason: content_filtered");
		expect(result.errorMessage).toContain('"guardrailAction":"BLOCKED"');
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(result.transportFailure).toBeUndefined();
		expect(isProviderSafetyStopAuthenticated(result)).toBe(true);
	});

	it("recognizes guardrail_intervened as a provider safety stop", async () => {
		const result = await runBedrockSafetyStop("guardrail_intervened", true);

		expect(result.errorMessage).toContain("stopReason: guardrail_intervened");
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(isProviderSafetyStopAuthenticated(result)).toBe(true);
	});

	it("does not authenticate a safety stop from direct provider calls", async () => {
		const result = await runBedrockSafetyStop("content_filtered", false);

		expect(result.errorKind).toBeUndefined();
		expect(isProviderSafetyStopAuthenticated(result)).toBe(false);
		expect(result.transportFailure).toMatchObject({
			kind: "transport",
			status: 500,
			providerCode: "untrusted_safety_stop",
		});
	});
});
