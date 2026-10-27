import { afterEach, describe, expect, it } from "bun:test";
import { kiloModelManagerOptions } from "../src/provider-models/openai-compat";

const realFetch = globalThis.fetch;

// Shape captured from https://api.kilo.ai/api/gateway/models (OpenRouter catalog format):
// per-token USD string prices, nested limits/modalities, reasoning via supported_parameters.
const ARGON_ROW = {
	id: "google/gemini-4-argon",
	name: "Google: Gemini 4 Argon",
	context_length: 1_048_576,
	architecture: {
		modality: "text+image+file+audio+video->text",
		input_modalities: ["audio", "file", "image", "text", "video", "pdf"],
		output_modalities: ["text"],
	},
	pricing: {
		prompt: "0.000002000000",
		completion: "0.000010000000",
		input_cache_read: "0.000000100000",
		input_cache_write: "0.000000187500",
	},
	top_provider: { context_length: 1_048_576, max_completion_tokens: 65_536 },
	supported_parameters: ["max_tokens", "reasoning", "reasoning_effort", "tool_choice", "tools"],
};

const PLAIN_ROW = {
	id: "vendor/plain-text",
	name: "Plain",
	architecture: { input_modalities: ["text"] },
	pricing: { prompt: "-1", completion: "0" },
	top_provider: {},
	supported_parameters: ["tools"],
};

async function discover(rows: unknown[]) {
	globalThis.fetch = (async () => Response.json({ data: rows })) as unknown as typeof fetch;
	const models = await kiloModelManagerOptions({ apiKey: "test" }).fetchDynamicModels?.();
	if (!models) throw new Error("expected Kilo discovery to return models");
	return models;
}

describe("Kilo discovery mapping", () => {
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("reads nested limits, modalities, reasoning, and per-million pricing", async () => {
		const [argon] = await discover([ARGON_ROW]);
		expect(argon.id).toBe("google/gemini-4-argon");
		expect(argon.reasoning).toBe(true);
		expect(argon.input).toEqual(["text", "image"]);
		expect(argon.contextWindow).toBe(1_048_576);
		expect(argon.maxTokens).toBe(65_536);
		expect(argon.cost.input).toBeCloseTo(2, 10);
		expect(argon.cost.output).toBeCloseTo(10, 10);
		expect(argon.cost.cacheRead).toBeCloseTo(0.1, 10);
		expect(argon.cost.cacheWrite).toBeCloseTo(0.1875, 10);
	});

	it("falls back to defaults and clamps sentinel prices for sparse rows", async () => {
		const [plain] = await discover([PLAIN_ROW]);
		expect(plain.reasoning).toBe(false);
		expect(plain.input).toEqual(["text"]);
		expect(plain.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(plain.maxTokens).toBeGreaterThan(0);
	});
});
