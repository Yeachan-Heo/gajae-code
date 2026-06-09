import { describe, expect, it } from "bun:test";
import {
	type BrowserActionStep,
	compileActionSteps,
	validateActionStep,
	validateActionSteps,
} from "@gajae-code/coding-agent/tools/browser/actions";

describe("validateActionStep", () => {
	it("requires url for navigate", () => {
		expect(validateActionStep({ verb: "navigate" }, 0)).toContain("'url' is required");
		expect(validateActionStep({ verb: "navigate", url: "https://x" }, 0)).toBeUndefined();
	});

	it("requires id or selector for click", () => {
		expect(validateActionStep({ verb: "click" }, 0)).toContain("'id' or 'selector'");
		expect(validateActionStep({ verb: "click", id: 3 }, 0)).toBeUndefined();
		expect(validateActionStep({ verb: "click", selector: "button" }, 0)).toBeUndefined();
	});

	it("requires target and text for type", () => {
		expect(validateActionStep({ verb: "type", id: 1 }, 0)).toContain("'text' is required");
		expect(validateActionStep({ verb: "type", id: 1, text: "hi" }, 0)).toBeUndefined();
	});

	it("requires selector + values for select and key for press", () => {
		expect(validateActionStep({ verb: "select", selector: "select" }, 0)).toContain("'values' is required");
		expect(validateActionStep({ verb: "select", selector: "select", values: ["a"] }, 0)).toBeUndefined();
		expect(validateActionStep({ verb: "press" }, 0)).toContain("'key' is required");
	});

	it("accepts back/observe/extract/screenshot without extra fields", () => {
		for (const verb of ["back", "observe", "extract", "screenshot"] as const) {
			expect(validateActionStep({ verb }, 0)).toBeUndefined();
		}
	});

	it("rejects an unknown verb", () => {
		expect(validateActionStep({ verb: "teleport" as BrowserActionStep["verb"] }, 0)).toContain("unknown verb");
	});
});

describe("validateActionSteps", () => {
	it("rejects an empty list", () => {
		expect(() => validateActionSteps([])).toThrow(/non-empty/);
	});
	it("throws on the first invalid step", () => {
		expect(() => validateActionSteps([{ verb: "navigate", url: "https://x" }, { verb: "click" }])).toThrow(
			/actions\[1\]/,
		);
	});
});

describe("compileActionSteps", () => {
	const steps: BrowserActionStep[] = [
		{ verb: "navigate", url: "https://example.com", wait_until: "domcontentloaded" },
		{ verb: "click", id: 7 },
		{ verb: "type", selector: "input[name=q]", text: "hello" },
		{ verb: "extract", format: "markdown" },
	];

	it("embeds the steps as injection-safe parsed JSON", () => {
		const code = compileActionSteps(steps);
		const match = code.match(/JSON\.parse\((".*?")\)/s);
		expect(match).not.toBeNull();
		const literal = match![1]!;
		// The embedded literal is a JSON string of the steps array; decoding twice
		// must round-trip to the original steps (proves no code interpolation).
		const decoded = JSON.parse(JSON.parse(literal));
		expect(decoded).toEqual(steps);
	});

	it("wires each verb onto the expected tab/page helper", () => {
		const code = compileActionSteps([
			{ verb: "navigate", url: "https://x" },
			{ verb: "click", id: 1 },
			{ verb: "type", selector: "i", text: "t" },
			{ verb: "fill", selector: "i", value: "v" },
			{ verb: "select", selector: "s", values: ["a"] },
			{ verb: "press", key: "Enter" },
			{ verb: "scroll", dy: 100 },
			{ verb: "back" },
			{ verb: "wait", selector: "i" },
			{ verb: "observe" },
			{ verb: "extract" },
			{ verb: "screenshot" },
		]);
		expect(code).toContain("tab.goto(");
		expect(code).toContain("tab.id(s.id)");
		expect(code).toContain("tab.click(s.selector)");
		expect(code).toContain("tab.type(s.selector, s.text)");
		expect(code).toContain("tab.fill(s.selector, s.value)");
		expect(code).toContain("tab.select(s.selector,");
		expect(code).toContain("tab.press(s.key");
		expect(code).toContain("tab.scroll(s.dx || 0, s.dy || 0)");
		expect(code).toContain("page.goBack()");
		expect(code).toContain("tab.waitFor(s.selector)");
		expect(code).toContain("tab.observe(");
		expect(code).toContain("tab.extract(s.format");
		expect(code).toContain("tab.screenshot(");
		expect(code.trimStart().startsWith("const __steps")).toBe(true);
		expect(code.trimEnd().endsWith("return __results;")).toBe(true);
	});

	it("rejects invalid steps before compiling", () => {
		expect(() => compileActionSteps([{ verb: "type", id: 1 }])).toThrow(/'text' is required/);
	});

	it("produces a syntactically valid function body", () => {
		const code = compileActionSteps(steps);
		// Wrapping in an async function must parse without SyntaxError.
		expect(() => new Function("tab", "page", `return (async () => {${code}})()`)).not.toThrow();
	});
});
