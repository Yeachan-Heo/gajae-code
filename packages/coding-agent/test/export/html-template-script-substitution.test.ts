import { describe, expect, it } from "bun:test";
import { TEMPLATE } from "../../src/export/html/template.generated";

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

	interface MarkdownRenderer {
		html(token: { raw?: string; text?: string }): string;
		code(token: { text: string; lang?: string }): string;
		codespan(token: { text: string }): string;
	}

	interface MarkedStub {
		use(config: { renderer: MarkdownRenderer }): void;
		parse(text: string): string;
	}

	interface HighlightStub {
		getLanguage(): boolean;
		highlightAuto(tokenText: string): { value: string };
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

	function buildMarkdownRenderer(): (text: string) => string {
		const script = extractScript();
		const block = extractMarkdownInitializationScript(script);
		let renderer: MarkdownRenderer | undefined;
		const marked: MarkedStub = {
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
		const factory = new Function(
			"marked",
			"hljs",
			"document",
			`function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }\n${block}; return safeMarkedParse;`,
		) as (marked: MarkedStub, hljs: HighlightStub, document: typeof documentStub) => (text: string) => string;
		return factory(marked, hljs, documentStub);
	}

	function createEscapingElementFromText(text: string): { readonly innerHTML: string } {
		const element = createEscapingElement();
		element.textContent = text;
		return element;
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
});
