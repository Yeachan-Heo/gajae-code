import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";
import type { Api, Model } from "../src/types";

function codexModel(contextWindow: number): Model<Api> {
	return {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 128_000,
	};
}
function codexTierModel(id: string, contextWindow: number): Model<Api> {
	return {
		...codexModel(contextWindow),
		id,
		name: id,
	};
}

describe("model manager context caps", () => {
	let cacheDir: string;
	let cacheDbPath: string;

	beforeEach(() => {
		cacheDir = mkdtempSync(join(tmpdir(), "issue-2240-"));
		cacheDbPath = join(cacheDir, "models.db");
	});

	afterEach(() => {
		rmSync(cacheDir, { recursive: true, force: true });
	});

	it("downgrades a stale oversized cache when refresh fails", async () => {
		const now = () => 1_800_000_000_000;
		writeModelCache("openai-codex", now(), [codexModel(373_000)], false, "empty", cacheDbPath);
		const result = await resolveProviderModels<Api>(
			{
				providerId: "openai-codex",
				staticModels: [],
				cacheDbPath,
				now,
				fetchDynamicModels: async () => null,
			},
			"online",
		);
		expect(result.models[0]?.contextWindow).toBe(372_000);
	});

	it("forces the 372K window over stale larger cache metadata and smaller live observations", async () => {
		const now = () => 1_800_000_000_000;
		writeModelCache("openai-codex", now(), [codexModel(373_000)], true, "empty", cacheDbPath);
		const result = await resolveProviderModels<Api>(
			{
				providerId: "openai-codex",
				staticModels: [],
				cacheDbPath,
				now,
				fetchDynamicModels: async () => [codexModel(200_000)],
			},
			"online",
		);
		expect(result.models[0]?.contextWindow).toBe(372_000);
	});
	it("forces the 372K window for every tier id through the manager pipeline", async () => {
		for (const id of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const) {
			const result = await resolveProviderModels<Api>(
				{
					providerId: "openai-codex",
					staticModels: [],
					cacheDbPath,
					fetchDynamicModels: async () => [codexTierModel(id, 272_000)],
				},
				"online",
			);
			expect(result.models[0]?.contextWindow).toBe(372_000);
		}
	});

	it("applies GPT-5.6 pricing to dynamically discovered models without a static entry", async () => {
		const result = await resolveProviderModels<Api>(
			{
				providerId: "openai-codex",
				staticModels: [],
				cacheDbPath,
				fetchDynamicModels: async () => [codexModel(272_000)],
			},
			"online",
		);

		expect(result.models[0]?.cost).toEqual({
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
		expect(result.models[0]?.longContextPricing).toEqual({
			threshold: 272_000,
			cost: { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
		});
	});

	it("does not trust long-context rates from dynamic discovery", async () => {
		const model = codexModel(272_000);
		model.id = "custom-model";
		model.longContextPricing = {
			threshold: 1,
			cost: { input: Infinity, output: 0, cacheRead: 0, cacheWrite: 0 },
		};

		const result = await resolveProviderModels<Api>(
			{
				providerId: "openai-codex",
				staticModels: [],
				cacheDbPath,
				fetchDynamicModels: async () => [model],
			},
			"online",
		);

		expect(result.models[0]?.longContextPricing).toBeUndefined();
	});

	// #489: preserve the GPT-5.5 regression alongside the owning context-cap cases.
	it("gpt-5.5 context cap is normalized without clobbering static overrides", async () => {
		const staticModels: Model<Api>[] = [
			{
				id: "gpt-5.5",
				name: "GPT-5.5",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_100_000,
				maxTokens: 128_000,
			},
			{
				id: "gpt-5.5-pro",
				name: "GPT-5.5 Pro",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_100_000,
				maxTokens: 128_000,
			},
			{
				id: "gpt-5.5-preview",
				name: "GPT-5.5 Preview",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_100_000,
				maxTokens: 128_000,
			},
			{
				id: "gpt-5.5-experimental",
				name: "GPT-5.5 Experimental",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_100_000,
				maxTokens: 128_000,
			},
			{
				id: "gpt-5.4",
				name: "GPT-5.4",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_100_000,
				maxTokens: 128_000,
			},
		];
		const discovered: Model<Api>[] = [
			{
				...staticModels[0],
				api: "openai-completions",
				baseUrl: "https://proxy.example.com/v1",
				contextWindow: 1_100_000,
			},
			{
				...staticModels[1],
				contextWindow: 1_100_000,
			},
		];

		const { models } = await resolveProviderModels<Api>(
			{
				providerId: "openai",
				staticModels,
				cacheDbPath,
				fetchDynamicModels: async () => discovered,
			},
			"online",
		);

		const gpt55 = models.find(m => m.id === "gpt-5.5");
		const pro = models.find(m => m.id === "gpt-5.5-pro");
		const preview = models.find(m => m.id === "gpt-5.5-preview");
		const unknownSuffix = models.find(m => m.id === "gpt-5.5-experimental");
		const other = models.find(m => m.id === "gpt-5.4");
		expect(gpt55?.contextWindow).toBe(1_000_000);
		expect(gpt55?.api).toBe("openai-responses");
		expect(gpt55?.baseUrl).toBe("https://api.openai.com/v1");
		expect(pro?.contextWindow).toBe(1_100_000);
		expect(preview?.contextWindow).toBe(1_100_000);
		expect(unknownSuffix?.contextWindow).toBe(1_100_000);
		expect(other?.contextWindow).toBe(1_100_000);
	});
});
