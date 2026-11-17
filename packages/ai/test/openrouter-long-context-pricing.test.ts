import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "../src/model-manager";
import { calculateCost } from "../src/models";
import { openrouterModelManagerOptions } from "../src/provider-models/openai-compat";
import type { Model, Usage } from "../src/types";

// Shape of https://openrouter.ai/api/v1/models for openai/gpt-6-sol:batch.
const payload = {
	data: [
		{
			id: "openai/gpt-6-sol:batch",
			name: "OpenAI: GPT-6 Sol (batch)",
			context_length: 1_050_000,
			architecture: { modality: "text+image->text" },
			supported_parameters: ["tools", "tool_choice", "reasoning"],
			top_provider: { max_completion_tokens: 128_000 },
			pricing: {
				prompt: "0.000001",
				completion: "0.000005",
				input_cache_read: "0.0000001",
				input_cache_write: "0.00000125",
				overrides: [
					{
						min_prompt_tokens: 272_000,
						prompt: "0.000002",
						completion: "0.0000075",
						input_cache_read: "0.0000002",
						input_cache_write: "0.0000025",
					},
				],
			},
		},
		{
			id: "openai/gpt-4o-mini",
			name: "OpenAI: GPT-4o mini",
			context_length: 128_000,
			architecture: { modality: "text->text" },
			supported_parameters: ["tools", "tool_choice"],
			pricing: { prompt: "0.00000015", completion: "0.0000006" },
		},
	],
};

const originalFetch = global.fetch;
afterEach(() => {
	global.fetch = originalFetch;
});

function mockDiscovery(): void {
	global.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
}

function usage(input: number): Usage {
	return {
		input,
		output: 1_000,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 1_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function expectSolBatchPricing(model: Model | undefined): void {
	expect(model?.cost).toMatchObject({ input: 1, output: 5 });
	expect(model?.longContextPricing?.threshold).toBe(272_000);
	const atThreshold = usage(272_000);
	const above = usage(272_001);
	calculateCost(model!, atThreshold);
	calculateCost(model!, above);
	// 272K @ $1/M + 1K @ $5/M
	expect(atThreshold.cost.total).toBeCloseTo(0.277, 9);
	// 272,001 @ $2/M + 1K @ $7.5/M
	expect(above.cost.total).toBeCloseTo(0.551502, 9);
}

describe("OpenRouter long-context pricing", () => {
	test("maps pricing.overrides into the long-context tier and keeps the discovered base", async () => {
		mockDiscovery();
		const models = await openrouterModelManagerOptions({ apiKey: "sk-or-test" }).fetchDynamicModels?.();
		expectSolBatchPricing(models?.find(model => model.id === "openai/gpt-6-sol:batch"));
		expect(models?.find(model => model.id === "openai/gpt-4o-mini")?.longContextPricing).toBeUndefined();
	});

	test("the discovered tier survives model-list normalization", async () => {
		mockDiscovery();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-tier-"));
		try {
			const result = await resolveProviderModels(
				{
					...openrouterModelManagerOptions({ apiKey: "sk-or-test" }),
					cacheDbPath: path.join(directory, "models.db"),
				},
				"online",
			);
			expectSolBatchPricing(result.models.find(model => model.id === "openai/gpt-6-sol:batch"));
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
