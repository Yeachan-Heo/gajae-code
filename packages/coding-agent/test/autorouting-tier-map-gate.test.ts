import { describe, expect, it } from "bun:test";
import { checkAutoroutingTierMap, getAutoroutingTierMapGateReport } from "../scripts/check-autorouting-tier-map";

type Catalog = Record<string, Record<string, Record<string, unknown>>>;

async function committedCatalog(): Promise<Catalog> {
	return (await Bun.file(new URL("../../ai/src/models.json", import.meta.url)).json()) as Catalog;
}

describe("autorouting tier-map CI gate", () => {
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
});
