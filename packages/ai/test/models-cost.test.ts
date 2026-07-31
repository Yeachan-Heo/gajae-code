import { describe, expect, it } from "bun:test";
import { calculateCost, getBundledModel } from "../src/models";
import modelsJson from "../src/models.json" with { type: "json" };
import { populateResponsesUsageFromResponse } from "../src/providers/openai-responses-shared";
import type { AssistantMessage, Model, Usage } from "../src/types";

describe("calculateCost", () => {
	it("keeps token-based calculation for GitHub Copilot models", () => {
		const model = {
			...getBundledModel("github-copilot", "gpt-4o"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 123,
				output: 456,
				cacheRead: 789,
				cacheWrite: 321,
				total: 1689,
			},
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("keeps token-based calculation for non-Copilot providers", () => {
		const model = {
			...getBundledModel("openai", "gpt-4o-mini"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("ignores non-canonical long-context pricing", () => {
		const model = {
			...getBundledModel("openai", "gpt-4o-mini"),
			cost: { input: 1000, output: 2000, cacheRead: 500, cacheWrite: 800 },
			longContextPricing: {
				threshold: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage);

		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("prices OpenAI Codex GPT models from the matching OpenAI catalog entry", () => {
		const openAIModel = getBundledModel("openai", "gpt-5.4");
		const codexModel = getBundledModel("openai-codex", "gpt-5.4");
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		expect(codexModel.cost).toEqual(openAIModel.cost);

		calculateCost(codexModel, usage);

		expect(usage.cost.total).toBeCloseTo(0.01005, 8);
	});

	it("bundles the current OpenAI Standard prices for the GPT-5.6 family", () => {
		const rawCatalog = modelsJson as Record<string, Record<string, Model>>;
		const expectedPricing = [
			{
				id: "gpt-5.6",
				short: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				long: { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
			},
			{
				id: "gpt-5.6-sol",
				short: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				long: { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
			},
			{
				id: "gpt-5.6-terra",
				short: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
				long: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
			},
			{
				id: "gpt-5.6-luna",
				short: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
				long: { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
			},
		] as const;

		for (const expected of expectedPricing) {
			const openAIModel = getBundledModel("openai", expected.id);

			expect(rawCatalog.openai?.[expected.id]?.cost).toEqual(expected.short);
			expect(rawCatalog.openai?.[expected.id]?.longContextPricing).toEqual({
				threshold: 272_000,
				cost: expected.long,
			});
			expect(openAIModel.cost).toEqual(expected.short);
			expect(openAIModel.longContextPricing).toEqual({
				threshold: 272_000,
				cost: expected.long,
			});
			if (expected.id !== "gpt-5.6") {
				const codexModel = getBundledModel("openai-codex", expected.id);
				expect(rawCatalog["openai-codex"]?.[expected.id]?.cost).toEqual(expected.short);
				expect(rawCatalog["openai-codex"]?.[expected.id]?.longContextPricing).toEqual({
					threshold: 272_000,
					cost: expected.long,
				});
				expect(codexModel.cost).toEqual(openAIModel.cost);
				expect(codexModel.longContextPricing).toEqual(openAIModel.longContextPricing);
			}
		}
	});

	it("keeps GPT-5.6 short-context pricing at exactly 272K input tokens", () => {
		const model = getBundledModel("openai", "gpt-5.6-terra");
		const usage: Usage = {
			input: 200_000,
			output: 1_000,
			cacheRead: 72_000,
			cacheWrite: 0,
			totalTokens: 273_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(0.4, 8);
		expect(usage.cost.output).toBeCloseTo(0.012, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.0144, 8);
		expect(usage.cost.total).toBeCloseTo(0.4264, 8);
	});

	it("prices the full GPT-5.6 request at long-context rates above 272K input tokens", () => {
		const model = getBundledModel("openai", "gpt-5.6-terra");
		const usage: Usage = {
			input: 200_000,
			output: 1_000,
			cacheRead: 72_000,
			cacheWrite: 1,
			totalTokens: 273_001,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(0.8, 8);
		expect(usage.cost.output).toBeCloseTo(0.018, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.0288, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.000005, 8);
		expect(usage.cost.total).toBeCloseTo(0.846805, 8);
	});

	it("attributes OpenAI Responses cache-write tokens to their billable bucket", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.6-terra",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};

		populateResponsesUsageFromResponse(output, {
			input_tokens: 272_001,
			output_tokens: 1_000,
			total_tokens: 273_001,
			input_tokens_details: { cached_tokens: 72_000, cache_write_tokens: 1 },
		});

		expect(output.usage.input).toBe(200_000);
		expect(output.usage.cacheRead).toBe(72_000);
		expect(output.usage.cacheWrite).toBe(1);

		populateResponsesUsageFromResponse(output, {
			input_tokens: 10,
			output_tokens: 0,
			total_tokens: 10,
			input_tokens_details: { cache_write_tokens: -1 },
		});
		expect(output.usage.input).toBe(10);
		expect(output.usage.cacheWrite).toBe(0);
	});
});
