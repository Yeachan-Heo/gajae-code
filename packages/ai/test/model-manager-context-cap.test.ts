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

describe("model manager Codex GPT-5.6 cap", () => {
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
		expect(result.models[0]?.contextWindow).toBe(272_000);
	});

	it("prefers a newly observed smaller live cap over stale larger cache metadata", async () => {
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
		expect(result.models[0]?.contextWindow).toBe(200_000);
	});
});
