import { describe, expect, it } from "bun:test";
import { parseChunkUsage } from "@gajae-code/ai/providers/openai-completions";
import { processResponsesStream } from "@gajae-code/ai/providers/openai-responses-shared";
import { applyServiceTierCostMultiplier, getOpenAIServedTierMultiplier } from "@gajae-code/ai/service-tier-pricing";
import type { AssistantMessage, Model, Usage } from "@gajae-code/ai/types";
import type { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

/** Usage priced at $5/$25 per MTok for 1M in / 1M out. */
function standardPricedUsage(): Usage {
	return {
		input: 1_000_000,
		output: 1_000_000,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2_000_000,
		cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0, total: 30 },
	};
}

function responsesOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function responseModel(): Model<"openai-responses"> {
	return {
		id: "test-model",
		name: "test-model",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
}

async function* responseCompletionWithTier(servedTier: string): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		response: {
			id: "resp_service_tier",
			status: "completed",
			service_tier: servedTier,
			usage: {
				input_tokens: 1_000_000,
				output_tokens: 1_000_000,
				total_tokens: 2_000_000,
			},
		},
	} as unknown as ResponseStreamEvent;
}

function responseEventSink(): AssistantMessageEventStream {
	return { push: () => {}, end: () => {} } as never;
}

describe("applyServiceTierCostMultiplier", () => {
	it("scales every cost component and keeps total as their sum", () => {
		const usage: Usage = {
			input: 1_000_000,
			output: 1_000_000,
			cacheRead: 1_000_000,
			cacheWrite: 1_000_000,
			totalTokens: 4_000_000,
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, total: 36.75 },
		};
		applyServiceTierCostMultiplier(usage, 2);
		expect(usage.cost.input).toBe(10);
		expect(usage.cost.output).toBe(50);
		expect(usage.cost.cacheRead).toBe(1);
		expect(usage.cost.cacheWrite).toBe(12.5);
		expect(usage.cost.total).toBe(
			usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite,
		);
	});

	it("leaves cost untouched at multiplier 1", () => {
		const usage = standardPricedUsage();
		applyServiceTierCostMultiplier(usage, 1);
		expect(usage.cost).toEqual({ input: 5, output: 25, cacheRead: 0, cacheWrite: 0, total: 30 });
	});

	it("applies a discount multiplier below 1", () => {
		const usage = standardPricedUsage();
		applyServiceTierCostMultiplier(usage, 0.5);
		expect(usage.cost.total).toBe(15);
	});
});

describe("getOpenAIServedTierMultiplier", () => {
	it("prices flex at Batch API rates (half of standard)", () => {
		expect(getOpenAIServedTierMultiplier("gpt-5.6", "flex")).toBe(0.5);
	});

	it("prices priority and its `fast` alias at the premium", () => {
		// OpenAI renamed Priority processing to Fast mode; both spellings are
		// valid on the wire and must price identically.
		expect(getOpenAIServedTierMultiplier("gpt-5.6", "priority")).toBe(2);
		expect(getOpenAIServedTierMultiplier("gpt-5.6", "fast")).toBe(2);
	});

	it("keeps the steeper gpt-5.5 priority premium", () => {
		expect(getOpenAIServedTierMultiplier("gpt-5.5", "priority")).toBe(2.5);
	});

	it("prices a ramp-rate downgrade at standard rates", () => {
		// A Fast request downgraded by the ramp rate limit is served and billed
		// at standard rates, and reports `service_tier: "default"`. Pricing it
		// off request intent would overcharge.
		expect(getOpenAIServedTierMultiplier("gpt-5.6", "default")).toBe(1);
	});

	it("falls back to standard rates when no served tier is reported", () => {
		expect(getOpenAIServedTierMultiplier("gpt-5.6", undefined)).toBe(1);
		expect(getOpenAIServedTierMultiplier("gpt-5.6", null)).toBe(1);
		expect(getOpenAIServedTierMultiplier("gpt-5.6", "scale")).toBe(1);
		expect(getOpenAIServedTierMultiplier("gpt-5.6", "auto")).toBe(1);
	});
});

/**
 * End-to-end through the real usage parser that the completions stream calls on
 * every chunk carrying usage. Needs no credentials and no tier entitlement: the
 * chunk simply reports the `service_tier` an entitled account would receive.
 */
describe("parseChunkUsage applies the served tier", () => {
	/** $10/$30 per MTok, so 1M in / 1M out is exactly $40 at standard rates. */
	function model(id: string): Model<"openai-completions"> {
		return {
			id,
			name: id,
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		};
	}

	const RAW_USAGE = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };

	// `gpt-5.6*` ids are intercepted by the long-context table in `model-pricing.ts`,
	// which would override the fixture's own catalog cost. A neutral id keeps the
	// arithmetic anchored to the rates declared above.
	const PLAIN = "test-model";

	it("bills a served priority response at the premium", () => {
		const usage = parseChunkUsage(RAW_USAGE, model(PLAIN), undefined, "priority");
		expect(usage.cost.total).toBe(80);
	});

	it("bills a served flex response at Batch rates", () => {
		const usage = parseChunkUsage(RAW_USAGE, model(PLAIN), undefined, "flex");
		expect(usage.cost.total).toBe(20);
	});

	it("bills a ramp-rate downgrade at standard rates", () => {
		const usage = parseChunkUsage(RAW_USAGE, model(PLAIN), undefined, "default");
		expect(usage.cost.total).toBe(40);
	});

	it("bills at standard rates when the chunk reports no tier", () => {
		const usage = parseChunkUsage(RAW_USAGE, model(PLAIN), undefined, undefined);
		expect(usage.cost.total).toBe(40);
	});

	it("keeps the steeper gpt-5.5 premium end to end", () => {
		const usage = parseChunkUsage(RAW_USAGE, model("gpt-5.5"), undefined, "priority");
		expect(usage.cost.total).toBe(100);
	});
});

describe("processResponsesStream applies the served tier", () => {
	it("prices a served priority response at the premium", async () => {
		const output = responsesOutput();
		const completed = await processResponsesStream(
			responseCompletionWithTier("priority"),
			output,
			responseEventSink(),
			responseModel(),
		);
		expect(completed).toBe(true);
		expect(output.usage.cost.total).toBe(80);
	});

	it("prices a served flex response at Batch rates", async () => {
		const output = responsesOutput();
		await processResponsesStream(responseCompletionWithTier("flex"), output, responseEventSink(), responseModel());
		expect(output.usage.cost.total).toBe(20);
	});

	it("keeps a served default response at standard rates", async () => {
		const output = responsesOutput();
		await processResponsesStream(responseCompletionWithTier("default"), output, responseEventSink(), responseModel());
		expect(output.usage.cost.total).toBe(40);
	});
});
