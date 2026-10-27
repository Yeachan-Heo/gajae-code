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
		const list = "- example\n  ```svg\n  <svg/>\n  ```";
		const uppercase = "```SVG\n<SVG/>\n```";
		expect(splitSvgFences(nested)).toEqual([{ kind: "markdown", text: nested }]);
		expect(hasSvgFence(nested)).toBe(false);
		expect(splitSvgFences(indented)).toEqual([{ kind: "markdown", text: indented }]);
		expect(hasSvgFence(indented)).toBe(false);
		expect(splitSvgFences(list)).toEqual([{ kind: "markdown", text: list }]);
		expect(hasSvgFence(list)).toBe(false);
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
		expect(closePartialSvg('<svg><rect width="1" />')).toBe('<svg><rect width="1" /></svg>');
		expect(closePartialSvg("<svg><g></g><!-- note")).toBe("<svg><g></g></svg>");
		expect(closePartialSvg("<svg><style><![CDATA[ rect { fill")).toBe("<svg><style></style></svg>");
		expect(closePartialSvg("<svg><text>a &amp; b &am")).toBe("<svg><text>a &amp; b </text></svg>");
		expect(closePartialSvg("<svg><g><rect/></")).toBe("<svg><g><rect/></g></svg>");
	});

	it("returns null for partial source that exceeds the UTF-8 byte limit", () => {
		const source = `<svg>${"π".repeat(512 * 1024)}`;
		expect(closePartialSvg(source)).toBeNull();
	});

	it("returns null before repairing partial sources beyond element, depth, or attribute limits", () => {
		expect(closePartialSvg(`<svg>${"<rect/>".repeat(20_000)}`)).toBeNull();
		expect(closePartialSvg(`<svg>${"<g>".repeat(256)}`)).toBeNull();

		const attributes = Array.from({ length: 65 }, (_, index) => `data-${index}="x"`).join(" ");
		expect(closePartialSvg(`<svg ${attributes}>`)).toBeNull();
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

	it("resolves theme tokens through nested custom-property fallback chains", () => {
		const prepared = prepareSvg(
			'<svg><rect fill="var(--missing, var(--gjc-accent))"/>' +
				'<rect stroke="var(--gjc-missing, var(--gjc-also-missing, var(--gjc-primary, red)))"/></svg>',
			{ ...palette, primary: "#f00" },
		);

		expect(prepared).toContain('fill="var(--missing, #ff8800)"');
		expect(prepared).toContain('stroke="#f00"');

		let deepFallback = "var(--gjc-accent)";
		for (let index = 19; index >= 0; index--) deepFallback = `var(--gjc-missing-${index}, ${deepFallback})`;
		expect(prepareSvg(`<svg><rect fill="${deepFallback}"/></svg>`, palette)).toContain('<rect fill="#ff8800"/>');
	});

	it("gives a bare root the theme text color, a sans-serif font, and the namespaces the source needs", () => {
		expect(prepareSvg('<svg viewBox="0 0 1 1"><use xlink:href="#a"/></svg>', palette)).toBe(
			'<svg color="#eeeeee" font-family="sans-serif" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#a"/></svg>',
		);
	});

	it("resolves a root currentColor declaration against the theme foreground", () => {
		const svg = '<svg color=" currentColor " xmlns="http://www.w3.org/2000/svg"><rect stroke="currentColor"/></svg>';
		expect(prepareSvg(svg, palette)).toBe(
			'<svg font-family="sans-serif" color="#eeeeee" xmlns="http://www.w3.org/2000/svg"><rect stroke="currentColor"/></svg>',
		);
	});

	it("discovers Unicode-qualified roots and resolves child presentation attributes", () => {
		const prepared = prepareSvg(
			'<π:svg xmlns:π="http://www.w3.org/2000/svg"><π:path fill="var(--gjc-accent)"/></π:svg>',
			palette,
		);

		expect(prepared).toContain('<π:svg color="#eeeeee" font-family="sans-serif" xmlns="http://www.w3.org/2000/svg"');
		expect(prepared).toContain('<π:path fill="#ff8800"/>');
	});

	it("does not treat uppercase XML attributes as lowercase SVG presentation attributes", () => {
		const prepared = prepareSvg('<svg COLOR="red"><rect COLOR="var(--gjc-accent)"/></svg>', palette);

		expect(prepared).toContain(
			'<svg color="#eeeeee" font-family="sans-serif" xmlns="http://www.w3.org/2000/svg" COLOR="red">',
		);
		expect(prepared).toContain('<rect COLOR="var(--gjc-accent)"/>');
	});

	it("resolves root inline color currentColor while preserving other declarations", () => {
		const prepared = prepareSvg(
			'<svg style="color: currentColor; fill: var(--gjc-accent)"><rect color="currentColor" fill="currentColor"/></svg>',
			palette,
		);

		expect(prepared).toContain('style="color: #eeeeee; fill: #ff8800"');
		expect(prepared).toContain('<rect color="currentColor" fill="currentColor"/>');
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

	it("matches the closing tag for namespace-qualified stylesheets", () => {
		const prepared = prepareSvg(
			'<svg><x:style xmlns:x="http://www.w3.org/2000/svg">.a{fill:var(--gjc-accent)}</x:style>' +
				'<text>Use var(--gjc-accent)</text><rect fill="var(--gjc-accent)"/></svg>',
			palette,
		);

		expect(prepared).toContain(".a{fill:#ff8800}");
		expect(prepared).toContain("<text>Use var(--gjc-accent)</text>");
		expect(prepared).toContain('<rect fill="#ff8800"/>');
	});

	it("skips closing-tag text inside a style CDATA section", () => {
		const prepared = prepareSvg(
			"<svg><style><![CDATA[/* </style> */ .a{fill:var(--gjc-accent)}]]></style>" +
				'<rect fill="var(--gjc-accent)"/></svg>',
			palette,
		);

		expect(prepared).toContain(".a{fill:#ff8800}");
		expect(prepared).toContain('<rect fill="#ff8800"/>');
	});

	describe("bounds SVG preprocessing", () => {
		it("rejects DTD and entity declarations before they can expand into markup", () => {
			const svg =
				"<!DOCTYPE svg [<!ENTITY hidden \"<image href='data:image/png;base64,AA=='/>\">]>" + "<svg>&hidden;</svg>";
			expect(() => prepareSvg(svg, palette)).toThrow(/DTD and entity declarations/);
		});

		it("rejects oversized sources and elements with excessive attributes", () => {
			expect(() => prepareSvg(`<svg>${"x".repeat(1024 * 1024)}</svg>`, palette)).toThrow(/byte limit/);

			const attributes = Array.from({ length: 65 }, (_, index) => `data-${index}="x"`).join(" ");
			expect(() => prepareSvg(`<svg ${attributes}/>`, palette)).toThrow(/more than 64 attributes/);
			expect(() => prepareSvg(`<svg>${"<rect/>".repeat(20_000)}</svg>`, palette)).toThrow(/element limit/);
			expect(() => prepareSvg(`<svg>${"<g>".repeat(256)}<rect/>${"</g>".repeat(256)}</svg>`, palette)).toThrow(
				/nesting limit/,
			);
		});

		it("rejects deeply nested CSS variable fallbacks before repeated rescans", () => {
			let fallback = "var(--gjc-accent)";
			for (let index = 0; index < 40; index++) fallback = `var(--missing-${index}, ${fallback})`;

			expect(() => prepareSvg(`<svg><rect fill="${fallback}"/></svg>`, palette)).toThrow(/nesting exceeds/);
		});
	});

	describe("rejects embedded raster images (structural, bypass-proof)", () => {
		it("rejects <image> elements with data-URI href attributes", () => {
			const svg = '<svg><image href="data:image/png;base64,iVBORw0KGg" width="1" height="1"/></svg>';
			expect(() => prepareSvg(svg, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
		});

		it("rejects <image> elements with whitespace around the equals sign in attributes", () => {
			const svg = '<svg><image href = "data:image/png;base64,iVBORw0KGg" width="1" height="1"/></svg>';
			expect(() => prepareSvg(svg, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
		});

		it("rejects <image> elements with xlink:href attribute", () => {
			const svg =
				'<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:image/jpeg;base64,abc123" width="1" height="1"/></svg>';
			expect(() => prepareSvg(svg, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
		});

		it("rejects <image> elements with single-quoted attributes", () => {
			const svg = "<svg><image href='data:image/gif;base64,R0lGOD' width='1' height='1'/></svg>";
			expect(() => prepareSvg(svg, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
		});

		it("rejects <image> elements with mixed quote styles", () => {
			const svg = "<svg><image href=\"data:image/webp;base64,UklGR\" width='1' height='1'/></svg>";
			expect(() => prepareSvg(svg, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
		});

		it("rejects <image> elements regardless of tag name case", () => {
			const svg = '<svg><IMAGE href="data:image/png;base64,iVBORw0KGg" width="1" height="1"/></svg>';
			expect(() => prepareSvg(svg, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
		});

		it("rejects <image> elements with namespace prefixes", () => {
			const svg =
				'<svg xmlns:x="http://www.w3.org/2000/svg"><x:image href="data:image/png;base64,iVBORw0KGg" width="1" height="1"/></svg>';
			expect(() => prepareSvg(svg, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
		});

		it("rejects image elements with Unicode namespace prefixes", () => {
			const image =
				'<svg xmlns="http://www.w3.org/2000/svg" xmlns:π="http://www.w3.org/2000/svg"><π:image href="data:image/png;base64,iVBORw0KGg" width="1" height="1"/></svg>';
			const filterImage =
				'<svg xmlns="http://www.w3.org/2000/svg" xmlns:π="http://www.w3.org/2000/svg"><filter><π:feImage href="data:image/png;base64,iVBORw0KGg"/></filter></svg>';
			expect(() => prepareSvg(image, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
			expect(() => prepareSvg(filterImage, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
		});

		it("rejects <feImage> elements (filter primitive)", () => {
			const svg =
				'<svg><defs><filter><feImage href="data:image/png;base64,iVBORw0KGg" x="0" y="0"/></filter></defs></svg>';
			expect(() => prepareSvg(svg, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
		});

		it("rejects <feImage> elements regardless of case", () => {
			const svg =
				'<svg><defs><filter><FEIMAGE href="data:image/png;base64,iVBORw0KGg" x="0" y="0"/></filter></defs></svg>';
			expect(() => prepareSvg(svg, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
		});

		it("rejects <image> elements with spaces in tag name and attributes", () => {
			const svg = '<svg><  image  href = "data:image/png;base64,test"  width  =  "1"  /></svg>';
			expect(() => prepareSvg(svg, palette)).toThrow(/SVG contains.*<image>.*<feImage>/i);
		});

		it("allows <rect>, <g>, and other non-image elements", () => {
			const svg = '<svg><rect width="10" height="10" fill="red"/><g><circle r="5"/></g></svg>';
			expect(() => prepareSvg(svg, palette)).not.toThrow();
		});

		it("allows SVGs with only text and shapes when data: appears in text content", () => {
			const svg =
				'<svg><text>Use data:image/png; base64 here but not in a tag</text><rect width="10" height="10"/></svg>';
			expect(() => prepareSvg(svg, palette)).not.toThrow();
		});
	});
});
