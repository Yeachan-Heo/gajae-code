import { describe, expect, it } from "bun:test";
import { DEFAULT_COMPOSER_PLACEHOLDER } from "../src/modes/interactive-mode";

describe("composer placeholder", () => {
	it("advertises history search shortcut", () => {
		expect(DEFAULT_COMPOSER_PLACEHOLDER).toContain("Ctrl+R: Search history");
	});
});
