import { describe, expect, it } from "bun:test";
import { type Tool, validateToolArguments } from "@gajae-code/ai";
import { webSearchSchema } from "../../src/web/search";

// Same name/parameters/strict as WebSearchTool, without constructing it (the
// constructor prewarms the provider chain).
const tool = { name: "web_search", description: "", parameters: webSearchSchema, strict: true } as unknown as Tool;

function validate(args: Record<string, unknown>) {
	return validateToolArguments(tool, { type: "toolCall", id: "call-1", name: "web_search", arguments: args });
}

describe("web_search result-count parameters", () => {
	for (const field of ["limit", "num_search_results"]) {
		for (const value of [0, -3, 2.5]) {
			it(`rejects ${field}: ${value}`, () => {
				expect(() => validate({ query: "q", [field]: value })).toThrow('Validation failed for tool "web_search"');
			});
		}

		it(`accepts a positive integer ${field}`, () => {
			expect(validate({ query: "q", [field]: 5 })).toMatchObject({ query: "q", [field]: 5 });
		});
	}

	it("still accepts calls without either count", () => {
		expect(validate({ query: "q" })).toMatchObject({ query: "q" });
	});
});
