import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	__markdownPerfCounters,
	__setMarkdownNowForTest,
	clearRenderCache,
	getMarkdownCacheStats,
	Markdown,
} from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

function renderPlain(markdown: Markdown, width = 80): string {
	return Bun.stripANSI(markdown.render(width).join("\n"));
}

function freshRender(text: string, width = 80): string {
	clearRenderCache();
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

describe("Markdown streaming cache ownership", () => {
	it("does not attach a rejected key or rendered output to reentrant replacement text", () => {
		const hashSpy = vi.spyOn(Bun, "hash").mockReturnValue(1n);
		const original = "x".repeat(120000);
		const replacement = `<!--${"y".repeat(119993)}-->`;
		let replace = true;
		const markdown = new Markdown(original, 0, 0, {
			...defaultMarkdownTheme,
			heading(text) {
				if (replace) {
					replace = false;
					markdown.setText(replacement);
				}
				return defaultMarkdownTheme.heading(text);
			},
		});
		try {
			markdown.render(80);
			expect(renderPlain(markdown, 80).trim()).toBe("");
			expect(getMarkdownCacheStats().parse.count).toBe(1);
		} finally {
			markdown.dispose();
			hashSpy.mockRestore();
		}
	});

	it("admits completed parsing and releases local tokens when styling ends streaming", () => {
		let finish = true;
		const markdown = new Markdown("`abc`", 0, 0, {
			...defaultMarkdownTheme,
			code(text) {
				if (finish) {
					finish = false;
					markdown.setStreaming(false);
				}
				return defaultMarkdownTheme.code(text);
			},
		});
		try {
			markdown.setStreaming(true);
			expect(renderPlain(markdown, 80).trim()).toBe("abc");
			expect(getMarkdownCacheStats().parse.count).toBe(1);
			clearRenderCache();
			expect(renderPlain(markdown, 79).trim()).toBe("abc");
			expect(__markdownPerfCounters.lexerInvocations).toBe(2);
		} finally {
			markdown.dispose();
		}
	});

	let now = 1_000_000;
	beforeEach(() => {
		now = 1_000_000;
		clearRenderCache();
		__markdownPerfCounters.reset();
		__setMarkdownNowForTest(() => now);
	});
	afterEach(() => {
		__setMarkdownNowForTest(undefined);
		vi.useRealTimers();
		vi.restoreAllMocks();
		clearRenderCache();
	});

	for (const cadence of [16, 64]) {
		it(`keeps 128 streaming prefixes local at ${cadence}ms and publishes only final content`, () => {
			const md = new Markdown("", 0, 0, defaultMarkdownTheme);
			md.setStreaming(true);
			let text = "";
			for (let i = 0; i < 128; i++) {
				now += cadence;
				text += `streamed ASCII word ${i} `;
				md.setText(text);
				md.render(80);
				for (const stats of Object.values(getMarkdownCacheStats())) {
					expect(stats.count).toBe(0);
					expect(stats.accountedSize).toBe(0);
				}
			}
			md.setStreaming(false);
			const output = md.renderWithViewportAnchorSource(80, { id: "message" });
			expect(getMarkdownCacheStats().parse.count).toBe(1);
			expect(getMarkdownCacheStats().render.count).toBe(1);
			const calls = __markdownPerfCounters.lexerInvocations;
			expect(
				new Markdown(text, 0, 0, defaultMarkdownTheme).renderWithViewportAnchorSource(80, { id: "message" }),
			).toEqual(output);
			expect(__markdownPerfCounters.lexerInvocations).toBe(calls);
			clearRenderCache();
			const oracle = new Markdown(text, 0, 0, defaultMarkdownTheme).renderWithViewportAnchorSource(80, {
				id: "message",
			});
			expect(__markdownPerfCounters.lexerInvocations).toBe(calls + 1);
			expect(output).toEqual(oracle);
			md.dispose();
		});
	}

	it("reuses current local tokens across reflow, anchors and same-text completion", () => {
		const md = new Markdown("# current\n\nhello **world**", 0, 0, defaultMarkdownTheme);
		md.setStreaming(true);
		md.render(80);
		md.render(40);
		md.invalidate();
		md.renderWithViewportAnchorSource(40, { id: "x" });
		expect(__markdownPerfCounters.lexerInvocations).toBe(1);
		md.setStreaming(false);
		expect(getMarkdownCacheStats().parse.count).toBe(0);
		md.render(40);
		expect(__markdownPerfCounters.lexerInvocations).toBe(1);
		expect(getMarkdownCacheStats().parse.count).toBe(1);
		// Completed instances must not hide global eviction with a retained local parse.
		clearRenderCache();
		md.invalidate();
		md.render(40);
		expect(__markdownPerfCounters.lexerInvocations).toBe(2);
	});

	it("preserves completed entries during streaming, reuse and disposal", () => {
		const text = "completed **document**";
		new Markdown(text, 0, 0, defaultMarkdownTheme).render(80);
		const before = getMarkdownCacheStats();
		const md = new Markdown(text, 0, 0, defaultMarkdownTheme);
		md.setStreaming(true);
		md.render(80);
		expect(__markdownPerfCounters.lexerInvocations).toBe(1);
		md.setText("unrelated partial");
		md.render(60);
		md.dispose();
		expect(getMarkdownCacheStats()).toEqual(before);
		md.invalidate();
		md.render(60);
		expect(__markdownPerfCounters.lexerInvocations).toBe(3);
	});

	it("never publishes old text when completion assigns new text", () => {
		const md = new Markdown("old prefix", 0, 0, defaultMarkdownTheme);
		md.setStreaming(true);
		md.render(80);
		md.setText("new final", { streaming: false });
		expect(getMarkdownCacheStats().parse.count).toBe(0);
		expect(renderPlain(md)).toContain("new final");
		expect(__markdownPerfCounters.lexerInvocations).toBe(2);
		new Markdown("old prefix", 0, 0, defaultMarkdownTheme).render(80);
		expect(__markdownPerfCounters.lexerInvocations).toBe(3);
	});

	it("releases oversized completed tokens rather than retaining hidden reflow reuse", () => {
		const md = new Markdown("x".repeat(120_000), 0, 0, defaultMarkdownTheme);
		md.setStreaming(true);
		md.render(100);
		md.render(99);
		expect(__markdownPerfCounters.lexerInvocations).toBe(1);
		md.setStreaming(false);
		md.render(99);
		expect(__markdownPerfCounters.lexerInvocations).toBe(1);
		expect(getMarkdownCacheStats().parse.count).toBe(0);
		md.render(98);
		expect(__markdownPerfCounters.lexerInvocations).toBe(2);
		md.dispose();
	});

	it("releases local tokens on whitespace completion and completed L2 hits", () => {
		for (const final of ["   ", "already cached"]) {
			clearRenderCache();
			new Markdown(final, 0, 0, defaultMarkdownTheme).render(80);
			const md = new Markdown("partial", 0, 0, defaultMarkdownTheme);
			md.setStreaming(true);
			md.render(80);
			md.setText(final, { streaming: false });
			md.render(80);
			const calls = __markdownPerfCounters.lexerInvocations;
			md.setText("partial", { streaming: true });
			md.invalidate();
			md.render(80);
			expect(__markdownPerfCounters.lexerInvocations).toBe(calls + 1);
			md.dispose();
		}
	});

	it("keeps throttle boundaries and parses the latest suffix at the deadline", () => {
		const md = new Markdown("first", 0, 0, defaultMarkdownTheme);
		md.setStreaming(true);
		const initial = md.render(80);
		for (const offset of [0, 16, 63]) {
			now = 1_000_000 + offset;
			md.setText(`suffix ${offset}`);
			expect(md.render(80)).toEqual(initial);
		}
		now = 1_000_064;
		expect(renderPlain(md)).toContain("suffix 63");
		expect(__markdownPerfCounters.lexerInvocations).toBe(2);
		now++;
		md.setText("unparsed final", { streaming: false });
		expect(renderPlain(md)).toContain("unparsed final");
		expect(__markdownPerfCounters.lexerInvocations).toBe(3);
	});

	it("delivers the owner timer at the original deadline despite more updates", () => {
		vi.useFakeTimers();
		const md = new Markdown("initial", 0, 0, defaultMarkdownTheme);
		const delivered: string[] = [];
		md.setOnStaleThrottle(() => delivered.push(renderPlain(md)));
		md.setStreaming(true);
		const advance = (ms: number) => {
			now += ms;
			vi.advanceTimersByTime(ms);
		};
		try {
			md.render(80);
			advance(16);
			md.setText("middle");
			md.render(80); // Arms one timer for the remaining 48ms.
			advance(47);
			md.setText("latest suffix");
			md.render(80); // Must not move the already armed deadline.
			expect(delivered).toEqual([]);
			advance(1);
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toContain("latest suffix");
			expect(__markdownPerfCounters.lexerInvocations).toBe(2);
			advance(65);
			expect(delivered).toHaveLength(1);
		} finally {
			md.dispose();
		}
	});

	for (const boundary of ["complete", "dispose"] as const) {
		it(`cancels an armed owner timer on ${boundary}`, () => {
			vi.useFakeTimers();
			const md = new Markdown("initial", 0, 0, defaultMarkdownTheme);
			const callback = vi.fn();
			md.setOnStaleThrottle(callback);
			md.setStreaming(true);
			try {
				md.render(80);
				now += 16;
				vi.advanceTimersByTime(16);
				md.setText("pending suffix");
				md.render(80);
				if (boundary === "complete") {
					md.setText("authoritative final", { streaming: false });
					expect(renderPlain(md)).toContain("authoritative final");
				} else md.dispose();
				now += 1000;
				vi.advanceTimersByTime(1000);
				expect(callback).not.toHaveBeenCalled();
			} finally {
				md.dispose();
			}
		});
	}

	it("rejects colliding global parse hits independently of render-cache hits", () => {
		vi.spyOn(Bun, "hash").mockReturnValue(1n);
		new Markdown("alpha", 0, 0, defaultMarkdownTheme).render(80);
		const md = new Markdown("bravo", 0, 0, defaultMarkdownTheme);
		md.setStreaming(true);
		expect(renderPlain(md, 40)).toContain("bravo");
		expect(__markdownPerfCounters.lexerInvocations).toBe(2);
		md.setText("alpha");
		md.render(30);
		expect(__markdownPerfCounters.lexerInvocations).toBe(2);
		md.setText("bravo", { streaming: false });
		expect(renderPlain(md, 40)).toContain("bravo");
		expect(__markdownPerfCounters.lexerInvocations).toBe(3);
	});

	it("matches cold styled lines and anchors for retroactive and Unicode syntax", () => {
		const cases = [
			'A [late][ref] link\n\n[ref]: https://example.com "title"\n',
			"heading\n===\n\n> quote\nlazy continuation\n",
			"1. item\n   - nested **한글 😀**\n\n\ttext\n",
			"| A | B |\n|---|---|\n| 漢字 | 😀 |\n",
			"```ts\nconst x = 1;\n",
			"```ts\nconst x = 1;\n```\n",
		];
		for (const text of cases) {
			clearRenderCache();
			const md = new Markdown("", 0, 0, defaultMarkdownTheme);
			md.setStreaming(true);
			for (let end = 1; end <= text.length; end += 3) {
				now += 64;
				md.setText(text.slice(0, end));
				md.render(32);
			}
			md.setText(text, { streaming: false });
			const actual = md.renderWithViewportAnchorSource(32, { id: "x" });
			clearRenderCache();
			const calls = __markdownPerfCounters.lexerInvocations;
			const expected = new Markdown(text, 0, 0, defaultMarkdownTheme).renderWithViewportAnchorSource(32, {
				id: "x",
			});
			expect(__markdownPerfCounters.lexerInvocations).toBe(calls + 1);
			expect(actual).toEqual(expected);
			md.dispose();
		}
	});
});
