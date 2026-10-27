import { describe, expect, it } from "bun:test";
import { checkAutoroutingTierMap, getAutoroutingTierMapGateReport } from "../scripts/check-autorouting-tier-map";

type Catalog = Record<string, Record<string, Record<string, unknown>>>;

async function committedCatalog(): Promise<Catalog> {
	return (await Bun.file(new URL("../../ai/src/models.json", import.meta.url)).json()) as Catalog;
}

describe("autorouting tier-map CI gate", () => {
	it("accounts for the Gemini 4 Argon and India Bedrock catalog additions", async () => {
		const result = checkAutoroutingTierMap(await committedCatalog());
		const issueKeys = [
			"amazon-bedrock/in.anthropic.claude-haiku-4-5-20251001-v1:0",
			"amazon-bedrock/in.anthropic.claude-opus-5",
			"amazon-bedrock/in.anthropic.claude-sonnet-5",
			"github-copilot/gemini-4-argon",
			"google/gemini-4-argon",
			"kilo/google/gemini-4-argon",
			"opencode-zen/gemini-4-argon",
			"openrouter/google/gemini-4-argon",
			"openrouter/google/gemini-4-argon:batch",
			"vercel-ai-gateway/google/gemini-4-argon",
		];

		expect(result.ok).toBe(true);
		expect(result.report.unlabeledKeys).toEqual([]);
		expect(issueKeys.filter(key => !result.report.skippedKeys.includes(key))).toEqual([]);
	});

	it("passes against the committed catalog and landed baseline", async () => {
		const result = checkAutoroutingTierMap(await committedCatalog());
		expect(result.ok).toBe(true);
		expect(result.report.unlabeledKeys).toEqual([]);
		expect(result.report.baselineSkipCount).toBeGreaterThan(0);
	});

	it("reports a synthetic new unlabeled key exactly", async () => {
		const catalog = await committedCatalog();
		catalog["new-provider"] = {
			"new-model": {
				provider: "new-provider",
				id: "new-model",
				reasoning: false,
				input: ["text"],
			},
		};
		const result = checkAutoroutingTierMap(catalog);
		expect(result.ok).toBe(false);
		expect(result.report.unlabeledKeys).toEqual(["new-provider/new-model"]);
	});

	it("accepts an in-scope key when it is explicitly skip-listed", () => {
		const catalog = {
			qianfan: {
				"deepseek-v3.2": {
					provider: "qianfan",
					id: "deepseek-v3.2",
					reasoning: false,
					input: ["text"],
				},
			},
		};
		const result = getAutoroutingTierMapGateReport(catalog);
		expect(result.unlabeledKeys).toEqual([]);
		expect(result.skippedKeys).toEqual(["qianfan/deepseek-v3.2"]);
	});

	it("keeps text-capable multimodal models in scope and excludes image-only models", () => {
		const catalog = {
			vision: {
				"text-image": { provider: "vision", id: "text-image", output: ["text", "image"] },
				"image-only": { provider: "vision", id: "image-only", output: ["image"] },
			},
		};
		const result = getAutoroutingTierMapGateReport(catalog);
		expect(result.inScopeKeys).toEqual(["vision/text-image"]);
		expect(result.unlabeledKeys).toEqual(["vision/text-image"]);
	});

	it("rejects a skip entry with an empty rationale", () => {
		const catalog = {
			qianfan: { "deepseek-v3.2": { provider: "qianfan", id: "deepseek-v3.2", reasoning: false, input: ["text"] } },
		};
		const result = checkAutoroutingTierMap(catalog, {}, { "qianfan/deepseek-v3.2": { rationale: "   " } });
		expect(result.ok).toBe(false);
		expect(result.report.invalidSkipKeys).toEqual(["qianfan/deepseek-v3.2"]);
	});

	it("rejects a skip entry whose key violates the selector grammar", () => {
		const catalog = {
			qianfan: { "deepseek-v3.2": { provider: "qianfan", id: "deepseek-v3.2", reasoning: false, input: ["text"] } },
		};
		const result = checkAutoroutingTierMap(catalog, {}, { "qianfan/glob*": { rationale: "rationale" } });
		expect(result.ok).toBe(false);
		expect(result.report.invalidSkipKeys).toEqual(["qianfan/glob*"]);
	});

	it("rejects a skip entry whose key no longer exists in the catalog", () => {
		const catalog = {
			qianfan: { "deepseek-v3.2": { provider: "qianfan", id: "deepseek-v3.2", reasoning: false, input: ["text"] } },
		};
		const result = checkAutoroutingTierMap(catalog, {}, { "qianfan/removed-key": { rationale: "rationale" } });
		expect(result.ok).toBe(false);
		expect(result.report.staleSkipKeys).toEqual(["qianfan/removed-key"]);
	});

	it("rejects a key that is both labeled and skipped", () => {
		const catalog = {
			qianfan: { "deepseek-v3.2": { provider: "qianfan", id: "deepseek-v3.2", reasoning: false, input: ["text"] } },
		};
		const result = checkAutoroutingTierMap(
			catalog,
			{ "qianfan/deepseek-v3.2": [{ tier: "fast", rank: 1 }] },
			{ "qianfan/deepseek-v3.2": { rationale: "rationale" } },
		);
		expect(result.ok).toBe(false);
	});
});
