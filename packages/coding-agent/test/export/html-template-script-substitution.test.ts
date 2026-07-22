import { describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import type { MarkedExtension } from "marked";
import { Marked } from "marked";
import { TEMPLATE } from "../../src/export/html/template.generated";

interface DataImage {
	mimeType?: unknown;
	data?: unknown;
}

interface EntryRenderer {
	renderDataImage(image: DataImage, className: string): string;
	renderEntry(entry: unknown): string;
}

// Regression: `String.prototype.replace(string, string)` treats `$'`, `$&`,
// `$$`, `$n`, etc. as substitution patterns. The inlined `<script>` body now
// contains JS regex literals like `'\\s*Cell\\b\\s*(.*)$'` whose trailing `$'`
// would be expanded to "the text after `<template-js/>`" (i.e. `</body></html>`)
// if the replacement is a plain string instead of a function. That spliced the
// closing HTML tags into the middle of a regex string and produced
// `Uncaught SyntaxError: Invalid or unexpected token` at runtime.
// The fix is to pass the replacement as a function in
// scripts/generate-template.ts (and the mirror in template.macro.ts).
describe("HTML export template script inlining", () => {
	function extractScript(): string {
		const match = TEMPLATE.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
		if (!match) throw new Error("inlined <script> block not found in TEMPLATE");
		return match[1];
	}

	function extractMarkdownInitializationScript(script: string): string {
		const start = script.indexOf("// Escape raw HTML tags");
		const end = script.indexOf("// Search input", start);
		if (start === -1 || end === -1) throw new Error("markdown initialization block not found in TEMPLATE");
		return script.slice(start, end);
	}

	function sourceBetween(source: string, startMarker: string, endMarker: string): string {
		const start = source.indexOf(startMarker);
		const end = source.indexOf(endMarker, start);
		if (start === -1 || end === -1) {
			throw new Error(`generated template block not found: ${startMarker} -> ${endMarker}`);
		}
		return source.slice(start, end);
	}

	function extractSharedHtmlHelpers(script: string): string {
		return sourceBetween(script, "function escapeHtml(text)", "/**\n       * Truncate string");
	}

	interface MarkdownRendererThis {
		parser: { parseInline(tokens: unknown[]): string };
	}

	interface MarkdownRenderer {
		html(token: { raw?: string; text?: string }): string;
		code(token: { text: string; lang?: string }): string;
		codespan(token: { text: string }): string;
		link(this: MarkdownRendererThis, token: { href?: string; title?: string | null; tokens?: unknown[] }): string;
		image(token: { href?: string; title?: string | null; text?: string; tokens?: unknown[] }): string;
	}

	interface MarkedStub {
		use(config: { renderer: MarkdownRenderer; breaks?: boolean; gfm?: boolean }): void;
		parse(text: string): string | Promise<string>;
	}

	interface HighlightStub {
		getLanguage(): boolean;
		highlightAuto(tokenText: string): { value: string };
	}

	function createRealMarkedStub(): MarkedStub {
		const marked = new Marked<string, string>();
		return {
			use(config) {
				marked.use(config as MarkedExtension<string, string>);
			},
			parse(text) {
				return marked.parse(text, { async: false });
			},
		};
	}

	function createEscapingElement(): { textContent: string; readonly innerHTML: string } {
		let text = "";
		return {
			get textContent() {
				return text;
			},
			set textContent(value: string) {
				text = String(value);
			},
			get innerHTML() {
				return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
			},
		};
	}

	function buildMarkdownRenderer(markedOverride?: MarkedStub): (text: string) => string {
		const script = extractScript();
		const block = extractMarkdownInitializationScript(script);
		const helpers = extractSharedHtmlHelpers(script);
		let renderer: MarkdownRenderer | undefined;
		const marked: MarkedStub = markedOverride ?? {
			use(config) {
				renderer = config.renderer;
			},
			parse(text) {
				if (!renderer) throw new Error("marked renderer was not configured");
				return [
					`<p>hello ${renderer.html({ raw: text, text })}</p>`,
					renderer.codespan({ text: "x < y" }),
					renderer.code({ text: "<img src=x onerror=alert(1)>", lang: "html" }),
				].join("\n");
			},
		};
		const hljs: HighlightStub = {
			getLanguage() {
				return false;
			},
			highlightAuto(tokenText: string) {
				return { value: createEscapingElementFromText(tokenText).innerHTML };
			},
		};
		const documentStub = {
			createElement() {
				return createEscapingElement();
			},
		};
		const factory = new Function("marked", "hljs", "document", `${helpers}\n${block}; return safeMarkedParse;`) as (
			marked: MarkedStub,
			hljs: HighlightStub,
			document: typeof documentStub,
		) => (text: string) => string;
		return (text: string) => String(factory(marked, hljs, documentStub)(text));
	}

	function renderWithConfiguredRenderer(render: (renderer: MarkdownRenderer) => string): string {
		let renderer: MarkdownRenderer | undefined;
		const marked: MarkedStub = {
			use(config) {
				renderer = config.renderer;
			},
			parse() {
				if (!renderer) throw new Error("marked renderer was not configured");
				return render(renderer);
			},
		};
		return buildMarkdownRenderer(marked)("");
	}

	function createEscapingElementFromText(text: string): { readonly innerHTML: string } {
		const element = createEscapingElement();
		element.textContent = text;
		return element;
	}

	function evaluateGenerated<T>(source: string, returnExpression: string, bindings: Record<string, unknown>): T {
		const script = extractScript();
		const helpers = extractSharedHtmlHelpers(script);
		const document = parseHTML("<html><body></body></html>").document;
		const factory = new Function(
			"document",
			...Object.keys(bindings),
			`${helpers}\n${source}\nreturn ${returnExpression};`,
		) as (...args: unknown[]) => T;
		return factory(document, ...Object.values(bindings));
	}

	function buildEntryRenderer(): EntryRenderer {
		const script = extractScript();
		return evaluateGenerated<EntryRenderer>(
			sourceBetween(script, "function renderCopyLinkButton(entryId)", "// HEADER / STATS"),
			"{ renderDataImage, renderEntry }",
			{
				formatTimestamp: () => "",
				safeMarkedParse: (text: string) => text,
				renderToolCall: () => "",
				formatExpandableOutput: () => "",
			},
		);
	}

	function parseFragment(html: string) {
		return parseHTML(`<html><body>${html}</body></html>`).document;
	}

	it("preserves the literal `$'` regex anchor inside the inlined script", () => {
		const script = extractScript();
		// The eval-cell parser must still contain the raw `(.*)$'` and `End\\b.*$'`
		// regex sources — these are exactly the substrings that trigger the bug
		// when the replacement is treated as a substitution template.
		expect(script).toContain("\\\\s*Cell\\\\b\\\\s*(.*)$', 'i'");
		expect(script).toContain("\\\\s*End\\\\b.*$', 'i'");
	});

	it("does not splice closing HTML tags into the inlined script", () => {
		const script = extractScript();
		expect(script).not.toMatch(/<\/body>/i);
		expect(script).not.toMatch(/<\/html>/i);
	});

	it("produces a syntactically valid inlined script", () => {
		const script = extractScript();
		// `new Function(body)` parses without executing. Throws SyntaxError on
		// the spliced-tag corruption the substitution-pattern bug produces.
		expect(() => new Function(script)).not.toThrow();
	});

	it("escapes raw markdown HTML without breaking code rendering", () => {
		const renderMarkdown = buildMarkdownRenderer();
		const html = renderMarkdown('<img src=x onerror="alert(1)">');

		expect(html).not.toContain('<img src=x onerror="alert(1)">');
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(html).toContain("<code>x &lt; y</code>");
		expect(html).toContain('<pre><code class="hljs">&lt;img src=x onerror=alert(1)&gt;</code></pre>');
	});

	it("neutralizes markdown links with unsafe URL schemes", () => {
		const renderMarkdown = buildMarkdownRenderer(createRealMarkedStub());
		const html = renderMarkdown("[x](javascript:alert(1))");

		expect(html).not.toContain("href=");
		expect(html).not.toContain('href="javascript:alert(1)"');
		expect(html).toContain("javascript:alert(1)");
	});

	it("neutralizes markdown images with unsafe URL schemes", () => {
		const renderMarkdown = buildMarkdownRenderer(createRealMarkedStub());
		const html = renderMarkdown("![x](javascript:alert(1))");

		expect(html).not.toContain("<img");
		expect(html).not.toContain("src=");
		expect(html).not.toContain('src="javascript:alert(1)"');
		expect(html).toContain("![x](javascript:alert(1))");
	});

	it("neutralizes markdown links with slash-backslash network-path variants", () => {
		const unsafeHrefs = [
			String.raw`/\evil.com/a`,
			String.raw`\/evil.com/a`,
			String.raw`/\/evil.com/a`,
			"//evil.com/a",
		];

		for (const href of unsafeHrefs) {
			const html = renderWithConfiguredRenderer(renderer =>
				renderer.link.call({ parser: { parseInline: () => "x" } }, { href, tokens: [] }),
			);
			expect(html).not.toContain("href=");
			expect(html).toContain("evil.com/a");
		}
	});

	it("neutralizes markdown images with slash-backslash network-path variants", () => {
		const unsafeHrefs = [
			String.raw`/\evil.com/pixel`,
			String.raw`\/evil.com/pixel`,
			String.raw`/\/evil.com/pixel`,
			"//evil.com/pixel",
		];

		for (const href of unsafeHrefs) {
			const html = renderWithConfiguredRenderer(renderer => renderer.image({ href, text: "x" }));
			expect(html).not.toContain("<img");
			expect(html).not.toContain("src=");
			expect(html).toContain("evil.com/pixel");
		}
	});

	it("preserves local relative markdown links and images", () => {
		const renderMarkdown = buildMarkdownRenderer(createRealMarkedStub());
		const html = renderMarkdown("[doc](./docs/readme.md) ![alt](/assets/pixel.png)");

		expect(html).toContain('<a href="./docs/readme.md">doc</a>');
		expect(html).toContain('<img src="/assets/pixel.png" alt="alt">');
	});

	it("preserves safe markdown links", () => {
		const renderMarkdown = buildMarkdownRenderer(createRealMarkedStub());
		const html = renderMarkdown("[x](https://example.com/path?q=1#ok)");

		expect(html).toContain('<a href="https://example.com/path?q=1#ok">x</a>');
	});

	it("keeps session IDs and raster image data inside their attributes", () => {
		const renderer = buildEntryRenderer();
		const craftedId = '메시지-😀"><img id="id-injection" onerror="alert(1)">';
		const html = renderer.renderEntry({
			type: "message",
			id: craftedId,
			timestamp: 0,
			message: {
				role: "user",
				content: [
					{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
					{ type: "image", mimeType: "image/jpeg", data: "/9j/2Q==" },
					{ type: "image", mimeType: "image/gif", data: "R0lGODlh" },
					{ type: "image", mimeType: "image/webp", data: "UklGRg==" },
					{ type: "image", mimeType: 'image/png" onerror="alert(1)', data: "iVBORw0KGgo=" },
					{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz48L3N2Zz4=" },
					{ type: "image", mimeType: "image/png", data: 'AAAA" onerror="alert(1)' },
					{ type: "image", mimeType: "image/png", data: "AB==" },
				],
			},
		});
		const document = parseFragment(html);

		expect(document.querySelector("#id-injection")).toBeNull();
		expect(document.querySelector("[onerror]")).toBeNull();
		expect(document.querySelector(".user-message")?.getAttribute("id")).toBe(`entry-${craftedId}`);
		expect(document.querySelector(".copy-link-btn")?.getAttribute("data-entry-id")).toBe(craftedId);
		expect(document.querySelectorAll("img.message-image")).toHaveLength(4);
		const renderedImages = Array.from(document.querySelectorAll("img.message-image")) as Element[];
		expect(renderedImages.map(image => image.getAttribute("src"))).toEqual([
			"data:image/png;base64,iVBORw0KGgo=",
			"data:image/jpeg;base64,/9j/2Q==",
			"data:image/gif;base64,R0lGODlh",
			"data:image/webp;base64,UklGRg==",
		]);
	});

	it("uses the same validated image renderer for tool and message images", () => {
		const script = extractScript();
		const renderer = buildEntryRenderer();
		const validToolImage = parseFragment(
			renderer.renderDataImage({ mimeType: "image/jpeg", data: "/9j/2Q==" }, "tool-image"),
		);

		expect(validToolImage.querySelector("img.tool-image")?.getAttribute("src")).toBe(
			"data:image/jpeg;base64,/9j/2Q==",
		);
		expect(renderer.renderDataImage({ mimeType: "image/svg+xml", data: "PHN2Zz48L3N2Zz4=" }, "tool-image")).toBe("");
		expect(script).toContain("images.map(img => renderDataImage(img, 'tool-image')).join('')");
		expect(script).toContain("html += renderDataImage(img, 'message-image')");
	});

	it("text-escapes provider, model, and broad tree fallbacks", () => {
		const crafted = 'value</span><img id="text-injection" onerror="alert(1)">';
		const script = extractScript();
		const renderHeader = evaluateGenerated<() => string>(
			`${sourceBetween(script, "function formatTokens(count)", "function replaceTabs(text)")}\n${sourceBetween(script, "function computeStats(entryList)", "// NAVIGATION")}`,
			"renderHeader",
			{
				entries: [
					{
						type: "message",
						message: { role: "assistant", provider: crafted, model: crafted, content: [] },
					},
				],
				header: { id: crafted, timestamp: 0 },
				systemPrompt: "",
				tools: [],
			},
		);
		const renderTree = evaluateGenerated<(entry: unknown) => string>(
			sourceBetween(script, "function truncate(s, maxLen = 100)", "// TREE RENDERING"),
			"getTreeNodeDisplayHtml",
			{ extractContent: () => "", toolCallMap: new Map(), formatToolCall: () => "" },
		);
		const html = [
			renderHeader(),
			renderTree({ type: "message", message: { role: "toolResult", toolName: crafted } }),
			renderTree({ type: "message", message: { role: crafted } }),
			renderTree({ type: "thinking_level_change", thinkingLevel: crafted }),
			renderTree({ type: crafted }),
		].join("\n");
		const document = parseFragment(html);

		expect(document.querySelector("#text-injection")).toBeNull();
		expect(document.querySelector("[onerror]")).toBeNull();
		expect(document.querySelector("h1")?.textContent).toContain(crafted);
		expect(document.body.textContent).toContain(`${crafted}/${crafted}`);
	});
});
