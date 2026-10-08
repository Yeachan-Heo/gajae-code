import { describe, expect, it } from "bun:test";
import { closePartialSvg, hasSvgFence, prepareSvg, splitSvgFences } from "../src/chat/svg-source";

describe("hasSvgFence", () => {
	it("detects SVG fences", () => {
		expect(hasSvgFence("```svg\n<svg/>\n```")).toBe(true);
		expect(hasSvgFence("~~~svg\n<svg/>\n~~~")).toBe(true);
		expect(hasSvgFence("```\ncode\n```")).toBe(false);
		expect(hasSvgFence("text without fence")).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(hasSvgFence("```SVG\n<svg/>\n```")).toBe(true);
		expect(hasSvgFence("```Svg\n<svg/>\n```")).toBe(true);
	});
});

describe("splitSvgFences", () => {
	it("splits prose and SVG fence", () => {
		const markdown = "Text before\n```svg\n<svg/>\n```\nText after";
		const segments = splitSvgFences(markdown);
		expect(segments).toEqual([
			{ kind: "markdown", text: "Text before\n" },
			{ kind: "svg", source: "<svg/>\n", closed: true },
			{ kind: "markdown", text: "Text after" },
		]);
	});

	it("handles unclosed SVG fence at end", () => {
		const markdown = "Text\n```svg\n<svg";
		const segments = splitSvgFences(markdown);
		expect(segments).toEqual([
			{ kind: "markdown", text: "Text\n" },
			{ kind: "svg", source: "<svg", closed: false },
		]);
	});

	it("drops blank prose runs", () => {
		const markdown = "```svg\n<svg/>\n```\n\n```svg\n<circle/>\n```";
		const segments = splitSvgFences(markdown);
		expect(segments).toEqual([
			{ kind: "svg", source: "<svg/>\n", closed: true },
			{ kind: "svg", source: "<circle/>\n", closed: true },
		]);
	});

	it("only lifts top-level fences", () => {
		const markdown = "- ```svg\n  <svg/>\n  ```";
		const segments = splitSvgFences(markdown);
		// Indented fence should stay as prose
		expect(segments[0]?.kind).toBe("markdown");
	});
});

describe("closePartialSvg", () => {
	it("closes open elements", () => {
		expect(closePartialSvg("<svg><rect>")).toEqual("<svg><rect></rect></svg>");
		expect(closePartialSvg("<svg><g><circle>")).toEqual("<svg><g><circle></circle></g></svg>");
	});

	it("handles complete documents", () => {
		const complete = "<svg><rect></rect></svg>";
		expect(closePartialSvg(complete)).toEqual(complete);
	});

	it("returns null before root SVG tag", () => {
		expect(closePartialSvg("<rect")).toBeNull();
		expect(closePartialSvg("")).toBeNull();
	});

	it("handles self-closing tags", () => {
		expect(closePartialSvg("<svg><rect /></svg>")).toEqual("<svg><rect /></svg>");
	});

	it("handles comments", () => {
		expect(closePartialSvg("<svg><!-- comment --><rect>")).toEqual("<svg><!-- comment --><rect></rect></svg>");
	});

	it("handles CDATA sections", () => {
		expect(closePartialSvg("<svg><![CDATA[text]]>")).toEqual("<svg><![CDATA[text]]></svg>");
	});

	it("handles processing instructions", () => {
		expect(closePartialSvg("<svg><?xml version?>")).toEqual("<svg><?xml version?></svg>");
	});

	it("truncates trailing entity references", () => {
		expect(closePartialSvg("<svg>text &amp")).toEqual("<svg>text </svg>");
		expect(closePartialSvg("<svg>text &amp;")).toEqual("<svg>text &amp;</svg>");
	});

	it("handles namespace-prefixed SVG", () => {
		expect(closePartialSvg("<ns:svg><rect>")).toEqual("<ns:svg><rect></rect></ns:svg>");
	});
});

describe("prepareSvg", () => {
	it("resolves CSS custom properties", () => {
		const svg = "<svg color='var(--fg)'/>";
		const palette = { fg: "#ffffff" };
		const prepared = prepareSvg(svg, palette);
		expect(prepared).toContain("color='#ffffff'");
	});

	it("uses fallback for unknown variables", () => {
		const svg = "<svg color='var(--unknown, #333333)'/>";
		const palette = { fg: "#ffffff" };
		const prepared = prepareSvg(svg, palette);
		expect(prepared).toContain("color='#333333'");
	});

	it("uses fg palette when no fallback", () => {
		const svg = "<svg color='var(--unknown)'/>";
		const palette = { fg: "#ffffff" };
		const prepared = prepareSvg(svg, palette);
		expect(prepared).toContain("color='#ffffff'");
	});

	it("adds missing color attribute", () => {
		const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
		const palette = { fg: "#ffffff" };
		const prepared = prepareSvg(svg, palette);
		expect(prepared).toContain('color="#ffffff"');
	});

	it("adds missing xmlns", () => {
		const svg = "<svg/>";
		const palette = { fg: "#ffffff" };
		const prepared = prepareSvg(svg, palette);
		expect(prepared).toContain('xmlns="http://www.w3.org/2000/svg"');
	});

	it("adds font-family", () => {
		const svg = "<svg/>";
		const palette = { fg: "#ffffff" };
		const prepared = prepareSvg(svg, palette);
		expect(prepared).toContain('font-family="sans-serif"');
	});

	it("adds xlink namespace when used", () => {
		const svg = "<svg xlink:href='#'/>"; // Using xlink namespace
		const palette = { fg: "#ffffff" };
		const prepared = prepareSvg(svg, palette);
		expect(prepared).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
	});

	it("does not duplicate existing attributes", () => {
		const svg = "<svg color='red' xmlns='http://www.w3.org/2000/svg'/>";
		const palette = { fg: "#ffffff" };
		const prepared = prepareSvg(svg, palette);
		// Should keep the original color, not add another one
		expect(prepared).toContain("color='red'");
	});

	it("handles complex fallback expressions", () => {
		const svg = "<svg color='var(--unknown, rgb(100, 150, 200))'/>";
		const palette = { fg: "#ffffff" };
		const prepared = prepareSvg(svg, palette);
		expect(prepared).toContain("color='rgb(100, 150, 200)'");
	});
});
