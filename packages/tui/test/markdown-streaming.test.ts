import { beforeEach, describe, expect, it } from "bun:test";
import { __markdownPerfCounters, clearRenderCache, Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

function renderPlain(markdown: Markdown, width = 80): string {
	return Bun.stripANSI(markdown.render(width).join("\n"));
}

function freshRender(text: string, width = 80): string {
	return renderPlain(new Markdown(text, 0, 0, defaultMarkdownTheme), width);
}

describe("Markdown streaming throttle", () => {
	beforeEach(() => {
		clearRenderCache();
		__markdownPerfCounters.reset();
	});

	it("bounds lexer invocations during rapid streaming and finalizes to fresh full output", () => {
		const markdown = new Markdown("", 0, 0, defaultMarkdownTheme);
		markdown.setStreaming(true);

		let text = "";
		for (let i = 0; i < 80; i++) {
			text += `- streamed token ${i} with **bold** and [link](https://example.com/${i})\n`;
			markdown.setText(text);
			markdown.render(100);
		}

		expect(__markdownPerfCounters.lexerInvocations).toBeLessThan(10);

		markdown.setStreaming(false);
		const finalized = renderPlain(markdown, 100);
		expect(finalized).toBe(freshRender(text, 100));
	});

	it("preserves retroactive CommonMark constructs on final render", () => {
		const cases = [
			"A [late][ref] link\n\n[ref]: https://example.com\n",
			"late heading\n---\n",
			"> quoted\nlazy continuation\n",
			"1. item\n   lazy continuation\n",
			"```ts\nconst x = 1;\n",
		];

		for (const text of cases) {
			clearRenderCache();
			__markdownPerfCounters.reset();
			const markdown = new Markdown("", 0, 0, defaultMarkdownTheme);
			markdown.setStreaming(true);
			let partial = "";
			for (const chunk of text.match(/.{1,5}/gs) ?? []) {
				partial += chunk;
				markdown.setText(partial);
				markdown.render(100);
			}
			markdown.setStreaming(false);
			expect(renderPlain(markdown, 100)).toBe(freshRender(text, 100));
		}
	});

	it("forces an unthrottled parse after streaming is disabled", () => {
		const markdown = new Markdown("alpha", 0, 0, defaultMarkdownTheme);
		markdown.setStreaming(true);
		markdown.render(80);
		const afterInitial = __markdownPerfCounters.lexerInvocations;

		markdown.setText("alpha\n\nbeta");
		markdown.render(80);
		expect(__markdownPerfCounters.lexerInvocations).toBe(afterInitial);

		markdown.setStreaming(false);
		markdown.render(80);
		expect(__markdownPerfCounters.lexerInvocations).toBe(afterInitial + 1);
	});

	it("keeps non-streaming default behavior immediate", () => {
		const markdown = new Markdown("alpha", 0, 0, defaultMarkdownTheme);
		markdown.render(80);
		markdown.setText("alpha\n\nbeta");
		markdown.render(80);
		expect(__markdownPerfCounters.lexerInvocations).toBe(2);
	});
});
