import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	injectAlibabaTokenPlanModels,
	injectImageGenerationModels,
	mergePreviousModelFallbacks,
	writeModelCatalogArtifacts,
} from "../scripts/generate-models";
import type { Model } from "../src/types";

const TEST_MODEL: Model = {
	id: "fixture-model",
	name: "Fixture Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
	contextWindow: 8192,
	maxTokens: 2048,
};

describe("writeModelCatalogArtifacts", () => {
	it("derives deterministic shards from the full catalog and removes stale shards", async () => {
		const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-model-shards-"));
		try {
			const catalog = { openai: { [TEST_MODEL.id]: TEST_MODEL } };
			await writeModelCatalogArtifacts(catalog, outputDirectory);
			const generatedPath = path.join(outputDirectory, "model-shards.generated.ts");
			const shardPath = path.join(outputDirectory, "model-shards/openai.json");
			const firstGenerated = await Bun.file(generatedPath).text();
			const firstShard = await Bun.file(shardPath).text();

			await Bun.write(path.join(outputDirectory, "model-shards/stale.json"), "{}\n");
			await writeModelCatalogArtifacts(catalog, outputDirectory);

			expect(await Bun.file(path.join(outputDirectory, "models.json")).json()).toEqual(catalog);
			expect(await Bun.file(shardPath).json()).toEqual(catalog.openai);
			expect(await Bun.file(generatedPath).text()).toBe(firstGenerated);
			expect(await Bun.file(shardPath).text()).toBe(firstShard);
			expect(await Bun.file(path.join(outputDirectory, "model-shards/stale.json")).exists()).toBe(false);
			expect(firstGenerated).toContain('import shard0 from "./model-shards/openai.json" with { type: "file" };');
		} finally {
			await fs.rm(outputDirectory, { recursive: true, force: true });
		}
	});

	it("rejects provider names that cannot be safe deterministic shard names", async () => {
		const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-model-shards-"));
		try {
			await expect(
				writeModelCatalogArtifacts({ "../escape": { [TEST_MODEL.id]: TEST_MODEL } }, outputDirectory),
			).rejects.toThrow("invalid provider name");
		} finally {
			await fs.rm(outputDirectory, { recursive: true, force: true });
		}
	});
});

describe("mergePreviousModelFallbacks", () => {
	it("retains seed-only models when discovery is offline without replacing fetched models", () => {
		const fetched = { ...TEST_MODEL, id: "fetched", name: "Fetched" };
		const staleFetchedSeed = { ...fetched, name: "Seed Copy" };
		const seedOnly = { ...TEST_MODEL, id: "seed-only", name: "Seed Only" };

		const merged = mergePreviousModelFallbacks(
			[fetched],
			{ openai: { fetched: staleFetchedSeed, "seed-only": seedOnly } },
			new Set(),
		);

		expect(merged).toEqual([fetched, { ...seedOnly, baseUrl: "" }]);
	});
});
describe("injectImageGenerationModels", () => {
	it("adds typed image-output models once for OpenAI and Codex", () => {
		const models: Model[] = [];

		injectImageGenerationModels(models);
		injectImageGenerationModels(models);

		expect(models).toEqual([
			expect.objectContaining({
				id: "gpt-image-2",
				api: "openai-responses",
				provider: "openai",
				input: ["text"],
				output: ["text", "image"],
			}),
			expect.objectContaining({
				id: "gpt-image-2",
				api: "openai-codex-responses",
				provider: "openai-codex",
				input: ["text"],
				output: ["text", "image"],
			}),
		]);
	});
});

describe("injectAlibabaTokenPlanModels", () => {
	it("adds the DeepSeek V4 Flash 0731 and Qwen 3.8 Max fallbacks exactly once", () => {
		const models: Model[] = [];

		injectAlibabaTokenPlanModels(models);
		models[0]!.name = "raw discovery name";
		models[0]!.reasoning = false;
		models[1]!.name = "raw discovery name";
		models[1]!.reasoning = false;
		injectAlibabaTokenPlanModels(models);

		expect(models).toEqual([
			expect.objectContaining({
				id: "deepseek-v4-flash-0731",
				name: "DeepSeek V4 Flash 0731",
				api: "openai-completions",
				provider: "alibaba-token-plan",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 384_000,
			}),
			expect.objectContaining({
				id: "qwen3.8-max",
				name: "Qwen3.8 Max",
				api: "openai-responses",
				provider: "alibaba-token-plan",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 65_536,
			}),
		]);
	});

	it("removes every legacy Qwen 3.8 Max alias before restoring the canonical model", () => {
		const legacy = (): Model<"openai-responses"> => ({
			id: "qwen-3.8-max",
			name: "Legacy Qwen",
			api: "openai-responses",
			provider: "alibaba-token-plan",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		});
		const models: Model[] = [legacy(), legacy(), { ...legacy(), id: "qwen3.8-max" }];

		injectAlibabaTokenPlanModels(models);

		expect(models.filter(model => model.provider === "alibaba-token-plan" && model.id === "qwen-3.8-max")).toEqual(
			[],
		);
		expect(
			models.filter(model => model.provider === "alibaba-token-plan" && model.id === "qwen3.8-max"),
		).toHaveLength(1);
	});
});
