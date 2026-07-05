import { describe, expect, it } from "bun:test";
import { resolveAutocompleteSelectListLayout } from "../src/autocomplete-layout";

describe("resolveAutocompleteSelectListLayout", () => {
	it("uses the compact layout for slash-command autocomplete", () => {
		expect(resolveAutocompleteSelectListLayout("/he")).toEqual({
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 32,
		});
	});

	it("keeps the default wider layout for non-slash autocomplete", () => {
		expect(resolveAutocompleteSelectListLayout("he")).toBeUndefined();
	});
});
