import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { JSON_SCHEMA_OUTPUTS, stableJson } from "./generate-json-schemas";

describe("generated JSON Schemas", () => {
	it("matches checked-in schema artifacts", async () => {
		for (const output of JSON_SCHEMA_OUTPUTS) {
			const target = path.join(import.meta.dir, "..", output.path);
			const existing = await Bun.file(target).text();
			expect(existing).toBe(stableJson(output.schema));
		}
	});

	it("emits web search fallback item enum and provider webSearch enum", () => {
		const configSchema = JSON_SCHEMA_OUTPUTS.find(output => output.path === "schemas/config.schema.json")?.schema as any;
		const fallbackItems = configSchema.properties.web_search.properties.fallback.items;
		expect(fallbackItems.enum).toContain("exa");
		expect(fallbackItems.enum).not.toContain("openai-compatible");

		const modelsSchema = JSON_SCHEMA_OUTPUTS.find(output => output.path === "schemas/models.schema.json")?.schema as any;
		const providerSchema = modelsSchema.properties.providers.additionalProperties;
		expect(providerSchema.properties.webSearch.enum).toEqual(["on", "off", "auto"]);
	});
});
