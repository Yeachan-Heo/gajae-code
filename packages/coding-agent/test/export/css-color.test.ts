import { describe, expect, it } from "bun:test";
import { cssColorOrFallback } from "../../src/export/html/css-color";

describe("cssColorOrFallback", () => {
	it("keeps hex and rgb colors", () => {
		expect(cssColorOrFallback("#343541", "#000")).toBe("#343541");
		expect(cssColorOrFallback("rgb(1, 2, 3)", "#000")).toBe("rgb(1, 2, 3)");
	});

	it("drops a value that would break out of the style block", () => {
		expect(cssColorOrFallback("#fff}</style><script>alert(1)</script>", "#112233")).toBe("#112233");
	});
});
