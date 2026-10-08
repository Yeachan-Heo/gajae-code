import { describe, expect, it } from "bun:test";
import { closePartialSvg, hasSvgFence, prepareSvg, splitSvgFences } from "../src/chat/svg-source";

describe("splitSvgFences", () => {
	it("lifts top-level svg fences out of the prose around them", () => {
		const markdown = "Intro\n\n```svg\n<svg/>\n```\n\n~~~ SVG title\n<svg></svg>\n~~~\nOutro";
		expect(splitSvgFences(markdown)).toEqual([
			{ kind: "markdown", text: "Intro\n\n" },
			{ kind: "svg", source: "<svg/>\n", closed: true },
			{ kind: "svg", source: "<svg></svg>\n", closed: true },
			{ kind: "markdown", text: "Outro" },
		]);
		expect(hasSvgFence(markdown)).toBe(true);
	});

	it("leaves svg fences nested in another fence or indented as code as prose", () => {
		const nested = "````markdown\n```svg\n<svg/>\n```\n````";
		const indented = "    ```svg\n    <svg/>\n    ```";
		const uppercase = "```SVG\n<SVG/>\n```";
		expect(splitSvgFences(nested)).toEqual([{ kind: "markdown", text: nested }]);
		expect(hasSvgFence(nested)).toBe(false);
		expect(splitSvgFences(indented)).toEqual([{ kind: "markdown", text: indented }]);
		expect(hasSvgFence(indented)).toBe(false);
		expect(hasSvgFence(uppercase)).toBe(true);
		expect(splitSvgFences(uppercase)).toEqual([{ kind: "svg", source: "<SVG/>\n", closed: true }]);
		expect(hasSvgFence("```svgx\n```")).toBe(false);
	});

	it("keeps a fence that is still streaming open, and needs a long-enough closer", () => {
		expect(splitSvgFences("Look:\n````svg\n<svg>\n```\n<rect/>")).toEqual([
			{ kind: "markdown", text: "Look:\n" },
			{ kind: "svg", source: "<svg>\n```\n<rect/>", closed: false },
		]);
		expect(splitSvgFences("```svg")).toEqual([{ kind: "svg", source: "", closed: false }]);
	});
});

describe("closePartialSvg", () => {
	it("returns null until the root start tag is complete", () => {
		expect(closePartialSvg("")).toBeNull();
		expect(closePartialSvg('<?xml version="1.0"?>\n<svg viewBox="0 0')).toBeNull();
		expect(closePartialSvg("<!-- <svg> -->")).toBeNull();
	});

	it("passes a complete document through unchanged", () => {
		const svg = '<svg viewBox="0 0 10 10"><g><rect width="1"/></g></svg>\n';
		expect(closePartialSvg(svg)).toBe(svg);
	});

	it("cuts the construct being written and closes open elements innermost first", () => {
		expect(closePartialSvg('<svg><g><text x="1">Hel')).toBe('<svg><g><text x="1">Hel</text></g></svg>');
		// A `>` inside a quoted attribute value does not end the tag.
		expect(closePartialSvg('<svg><g><path d="M0 0" data-x="a>b')).toBe("<svg><g></g></svg>");
		expect(closePartialSvg("<svg><g></g><!-- note")).toBe("<svg><g></g></svg>");
		expect(closePartialSvg("<svg><style><![CDATA[ rect { fill")).toBe("<svg><style></style></svg>");
		expect(closePartialSvg("<svg><text>a &amp; b &am")).toBe("<svg><text>a &amp; b </text></svg>");
		expect(closePartialSvg("<svg><g><rect/></")).toBe("<svg><g><rect/></g></svg>");
	});
});

describe("prepareSvg", () => {
	const palette = { fg: "#eeeeee", accent: "#ff8800" };

	it("resolves theme tokens, falling back to the given default and then to fg", () => {
		const svg = prepareSvg(
			'<svg xmlns="http://www.w3.org/2000/svg" color="red" font-family="serif"><style>.a{fill:var(--gjc-accent)}</style>' +
				'<rect stroke="var( --gjc-accent , #000)" fill="var(--gjc-nope, rgb(1, 2, 3))"/><text fill="var(--gjc-missing)"/></svg>',
			palette,
		);
		expect(svg).toBe(
			'<svg xmlns="http://www.w3.org/2000/svg" color="red" font-family="serif"><style>.a{fill:#ff8800}</style>' +
				'<rect stroke="#ff8800" fill="rgb(1, 2, 3)"/><text fill="#eeeeee"/></svg>',
		);
	});

	it("resolves theme tokens nested in custom-property fallbacks", () => {
		const prepared = prepareSvg('<svg><rect fill="var(--missing, var(--gjc-accent))"/></svg>', palette);

		expect(prepared).toContain('fill="var(--missing, #ff8800)"');
	});

	it("gives a bare root the theme text color, a sans-serif font, and the namespaces the source needs", () => {
		expect(prepareSvg('<svg viewBox="0 0 1 1"><use xlink:href="#a"/></svg>', palette)).toBe(
			'<svg color="#eeeeee" font-family="sans-serif" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#a"/></svg>',
		);
	});

	it("scans the complete root tag when an attribute value contains a greater-than sign", () => {
		const svg = '<svg data-label="1 > 0" xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
		const prepared = prepareSvg(svg, palette);

		expect(prepared).toContain('data-label="1 > 0"');
		expect(prepared.match(/\sxmlns=/g)).toHaveLength(1);
	});

	it("does not treat attribute-value text as root attributes", () => {
		const svg = `<svg data-label=' xmlns="urn:wrong" color="red" >' xmlns="http://www.w3.org/2000/svg"><rect/></svg>`;
		expect(prepareSvg(svg, palette)).toBe(
			`<svg color="#eeeeee" font-family="sans-serif" data-label=' xmlns="urn:wrong" color="red" >' xmlns="http://www.w3.org/2000/svg"><rect/></svg>`,
		);
	});

	it("resolves CSS variables without rewriting SVG text, comments, or unrelated attributes", () => {
		const svg =
			'<svg><style>.a{fill:var(--gjc-accent);content:"var(--gjc-accent)";/*var(--gjc-accent)*/}</style>' +
			"<text>Use var(--gjc-accent) here</text><!-- var(--gjc-accent) -->" +
			'<rect fill="var(--gjc-accent)" style="stroke:var(--gjc-accent)" data-label="var(--gjc-accent)"/></svg>';
		const prepared = prepareSvg(svg, palette);

		expect(prepared).toContain('<style>.a{fill:#ff8800;content:"var(--gjc-accent)";/*var(--gjc-accent)*/}</style>');
		expect(prepared).toContain("<text>Use var(--gjc-accent) here</text>");
		expect(prepared).toContain("<!-- var(--gjc-accent) -->");
		expect(prepared).toContain('fill="#ff8800" style="stroke:#ff8800" data-label="var(--gjc-accent)"');
	});

	it("preserves author-defined variables without colliding with reserved theme tokens", () => {
		const svg =
			"<svg><style>:root{--shape:#f00}.special{--accent:#0f0;fill:var(--shape);stroke:var(--gjc-accent)}</style>" +
			'<rect class="special" style="--inline:#0f0;fill:var(--inline)"/><rect fill="var(--gjc-accent)"/></svg>';
		const prepared = prepareSvg(svg, palette);

		expect(prepared).toContain("--shape:#f00");
		expect(prepared).toContain("fill:var(--shape);stroke:#ff8800");
		expect(prepared).toContain('style="--inline:#0f0;fill:var(--inline)"');
		expect(prepared).toContain('<rect fill="#ff8800"/>');
	});

	it("does not treat a self-closing style element as the start of a stylesheet", () => {
		const prepared = prepareSvg(
			'<svg><style/><text>Use var(--gjc-accent)</text><rect fill="var(--gjc-accent)"/></svg>',
			palette,
		);

		expect(prepared).toContain("<text>Use var(--gjc-accent)</text>");
		expect(prepared).toContain('<rect fill="#ff8800"/>');
	});
});
