import { describe, expect, test } from "bun:test";
import { generateToolCatalogData, ToolCatalogGenerationError } from "../../scripts/generate-tool-catalog";
import { TOOL_CATALOG } from "../../src/tools/tool-catalog.generated";

describe("generated tool catalog", () => {
	test("committed advertised metadata is reproducible from eager implementations", async () => {
		const regenerated = await generateToolCatalogData();
		expect(regenerated).toEqual(TOOL_CATALOG);
	});

	test("unavailable fallback rejects corrupted committed metadata and schema", async () => {
		const recipeEntry = TOOL_CATALOG.recipe;
		if (!recipeEntry) throw new Error("recipe catalog entry missing");
		const recipeParameters = recipeEntry.parameters;
		if (!recipeParameters || typeof recipeParameters !== "object") throw new Error("recipe schema metadata missing");
		const properties = (recipeParameters as Record<string, unknown>).properties;
		if (!properties || typeof properties !== "object") throw new Error("recipe properties metadata missing");
		const op = (properties as Record<string, unknown>).op;
		if (!op || typeof op !== "object") throw new Error("recipe op metadata missing");
		const metadataMutations: Array<[key: "label" | "summary" | "strict" | "description", value: unknown]> = [
			["label", "Corrupted label"],
			["summary", "Corrupted summary"],
			["strict", !recipeEntry.strict],
			["description", "Corrupted description"],
		];
		for (const [key, value] of metadataMutations) {
			const original = recipeEntry[key];
			(recipeEntry as unknown as Record<string, unknown>)[key] = value;
			try {
				await expect(generateToolCatalogData()).rejects.toBeInstanceOf(ToolCatalogGenerationError);
			} finally {
				(recipeEntry as unknown as Record<string, unknown>)[key] = original;
			}
		}
		const originalType = (op as Record<string, unknown>).type;
		(op as Record<string, unknown>).type = "number";
		try {
			await expect(generateToolCatalogData()).rejects.toBeInstanceOf(ToolCatalogGenerationError);
		} finally {
			(op as Record<string, unknown>).type = originalType;
		}
	});
	test("platform-excluded computer catalog remains reproducible under simulated Windows", async () => {
		const windowsCatalog = await generateToolCatalogData({ platform: "win32", arch: "x64" });
		expect(windowsCatalog.computer).toEqual(TOOL_CATALOG.computer);
	});
});
