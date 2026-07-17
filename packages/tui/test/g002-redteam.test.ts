import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
	__markdownPerfCounters,
	__setMarkdownNowForTest,
	clearRenderCache,
	Markdown,
} from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

const artifactCases: Array<Record<string, unknown>> = [];
const blockers: string[] = [];
let now = 1_000_000;

function advance(ms: number): void {
	now += ms;
}

function plain(lines: string[]): string {
	return Bun.stripANSI(lines.join("\n"));
}

function renderPlain(markdown: Markdown, width = 80): string {
	return plain(markdown.render(width));
}

function freshRender(text: string, width = 80): string {
	return renderPlain(new Markdown(text, 0, 0, defaultMarkdownTheme), width);
}

function record(name: string, status: "pass" | "fail" | "finding", details: Record<string, unknown> = {}): void {
	artifactCases.push({ name, status, ...details });
}

afterAll(async () => {
	__setMarkdownNowForTest(undefined);
	if (!process.env.G002_QA_ARTIFACT) return;
	await Bun.write(
		process.env.G002_QA_ARTIFACT,
		JSON.stringify(
			{
				schemaVersion: 1,
				kind: "algorithm-boundary-report",
				cases: artifactCases,
				summary: {
					status: artifactCases.some(c => c.status === "fail") ? "fail" : "pass_with_findings",
					caseCount: artifactCases.length,
					findings: artifactCases.filter(c => c.status === "finding").map(c => c.name),
					blockers,
				},
			},
			null,
			2,
		),
	);
});

describe("G002 markdown streaming throttle red-team", () => {
	beforeEach(() => {
		clearRenderCache();
		__markdownPerfCounters.reset();
		now = 1_000_000;
		__setMarkdownNowForTest(() => now);
	});

	it("THROTTLE-BYPASS: spaced deltas parse each render; rapid deltas are bounded", () => {
		const spaced = new Markdown("", 0, 0, defaultMarkdownTheme);
		spaced.setStreaming(true);
		let text = "";
		for (let i = 0; i < 8; i++) {
			text += `paragraph ${i} with [link](https://example.com/${i})\n\n`;
			spaced.setText(text);
			advance(70);
			spaced.render(100);
		}
		expect(__markdownPerfCounters.lexerInvocations).toBe(8);
		expect(renderPlain(spaced, 100)).toBe(freshRender(text, 100));

		clearRenderCache();
		__markdownPerfCounters.reset();
		const rapid = new Markdown("", 0, 0, defaultMarkdownTheme);
		rapid.setStreaming(true);
		text = "";
		for (let i = 0; i < 80; i++) {
			text += `token-${i} `;
			rapid.setText(text);
			rapid.render(100);
			advance(1);
		}
		expect(__markdownPerfCounters.lexerInvocations).toBeLessThanOrEqual(3);
		record("THROTTLE-BYPASS", "pass", { spacedLexes: 8, rapidLexes: __markdownPerfCounters.lexerInvocations });
	});

	it("STUCK-STALE: stale streaming output arms exactly one self-scheduled follow-up render", async () => {
		const markdown = new Markdown("alpha", 0, 0, defaultMarkdownTheme);
		let renderRequests = 0;
		markdown.setOnStaleThrottle(() => {
			renderRequests += 1;
		});
		markdown.setStreaming(true);
		const first = renderPlain(markdown, 80);
		markdown.setText("alpha\n\n## beta");
		const stale = renderPlain(markdown, 80);
		renderPlain(markdown, 80);
		renderPlain(markdown, 80);
		expect(stale).toBe(first);
		await Bun.sleep(80);
		expect(renderRequests).toBe(1);
		advance(70);
		const refreshed = renderPlain(markdown, 80);
		expect(refreshed).toBe(freshRender("alpha\n\n## beta", 80));
		expect(refreshed).not.toBe(stale);
		record("STUCK-STALE", "pass", { laterRenderRefreshes: true, selfScheduledRenderRequests: renderRequests });
	});

	it("CACHE-POISON and WIDTH-CHANGE: stale streaming frames do not enter shared cache and widths remain isolated", () => {
		const text1 = "a very long paragraph that wraps differently between narrow and wide terminal widths ".repeat(4);
		const streaming = new Markdown("short", 0, 0, defaultMarkdownTheme);
		streaming.setStreaming(true);
		streaming.render(24);
		streaming.setText(text1);
		const staleW1 = renderPlain(streaming, 24);
		const freshSame = renderPlain(new Markdown(text1, 0, 0, defaultMarkdownTheme), 24);
		expect(freshSame).toBe(freshRender(text1, 24));
		expect(freshSame).not.toBe(staleW1);

		clearRenderCache();
		__markdownPerfCounters.reset();
		const width = new Markdown("wide words wide words", 0, 0, defaultMarkdownTheme);
		width.setStreaming(true);
		const w1 = renderPlain(width, 20);
		width.setText(text1);
		const w2 = renderPlain(width, 60);
		expect(w2).toBe(freshRender(text1, 60));
		expect(w2).not.toBe(w1);
		record("CACHE-POISON", "pass", { freshInstanceMatchedFullParse: true });
		record("WIDTH-CHANGE", "pass", {
			widthChangeForcedParse: true,
			lexerInvocations: __markdownPerfCounters.lexerInvocations,
		});
	});

	it("RETROACTIVE: final streaming output is byte-equal to fresh full parse across late constructs", () => {
		const cases = [
			{ name: "late-ref", chunks: ["A [late][ref]", "\n\n[ref]: https://example.com\n"] },
			{ name: "late-setext", chunks: ["late heading", "\n===\n"] },
			{ name: "lazy-list", chunks: ["1. first", "\n   lazy continuation\n"] },
			{ name: "late-table", chunks: ["| a | b |", "\n| - | - |\n| 1 | 2 |\n"] },
			{ name: "fence-closed-late", chunks: ["```ts\nconst x = 1;", "\n```\n"] },
			{ name: "fence-never-closed-abort", chunks: ["```ts\nconst x = 1;\n"] },
		];
		for (const c of cases) {
			clearRenderCache();
			const markdown = new Markdown("", 0, 0, defaultMarkdownTheme);
			markdown.setStreaming(true);
			let text = "";
			for (const chunk of c.chunks) {
				text += chunk;
				markdown.setText(text);
				markdown.render(100);
			}
			markdown.setStreaming(false);
			expect(renderPlain(markdown, 100)).toBe(freshRender(text, 100));
			record(`RETROACTIVE:${c.name}`, "pass", { bytesEqualFresh: true });
		}
	});

	it("EMPTY/EDGE: empty, whitespace, and 1MB single-delta streams do not crash", () => {
		for (const text of ["", " \n\t  "]) {
			const markdown = new Markdown("", 0, 0, defaultMarkdownTheme);
			markdown.setStreaming(true);
			markdown.setText(text);
			expect(renderPlain(markdown, 80)).toBe("");
			markdown.setStreaming(false);
			expect(renderPlain(markdown, 80)).toBe("");
		}
		const huge = `# huge\n\n${"x".repeat(1024 * 1024)}`;
		const markdown = new Markdown("", 0, 0, defaultMarkdownTheme);
		markdown.setStreaming(true);
		markdown.setText(huge);
		const output = renderPlain(markdown, 120);
		expect(output.length).toBeGreaterThan(0);
		markdown.setStreaming(false);
		expect(renderPlain(markdown, 120)).toBe(freshRender(huge, 120));
		record("EMPTY/EDGE", "pass", { emptyOk: true, whitespaceOk: true, hugeBytes: huge.length });
	});
});
