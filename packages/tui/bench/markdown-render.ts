import { mkdir } from "node:fs/promises";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { Markdown } from "../src/components/markdown";
import { defaultMarkdownTheme } from "../test/test-themes";

const WARMUP_RENDERS = 25;
const MEASURED_RENDERS = 200;
const WIDTHS = [80, 120, 160] as const;

const paragraph =
	"Markdown rendering should preserve inline **bold**, _italic_, `code`, ~~deleted~~ text, links like https://example.test/path, and enough words to exercise wrapping without visual drift.";

function documentChunk(index: number): string {
	return [
		`## Section ${index}`,
		paragraph,
		"",
		"- first bullet with enough text to wrap at narrow widths",
		"- second bullet with **formatting** and `inline code`",
		"  - nested bullet that should keep indentation stable",
		"",
		"| Column | Detail |",
		"| --- | --- |",
		`| ${index} | table cell with a longish value and **markdown** content |`,
		"",
		"> quoted text with _emphasis_ and a nested line that wraps across terminal widths.",
		"",
		"```ts",
		`export function sample${index}(value: string): string {`,
		"\treturn value.trim().toUpperCase();",
		"}",
		"```",
		"",
		"```mermaid-ish",
		"graph TD",
		`  A${index}-->B${index}`,
		"```",
		"",
	].join("\n");
}

function makeMessages(count: number): string[] {
	return Array.from({ length: count }, (_, i) => documentChunk(i % 10));
}

function makeLargeDocument(): string {
	let text = "";
	let i = 0;
	while (text.length < 100 * 1024) {
		text += documentChunk(i++);
	}
	return text;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) return sorted[lo];
	const frac = rank - lo;
	return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function stats(durations: number[]) {
	const sorted = [...durations].sort((a, b) => a - b);
	return {
		medianMs: percentile(sorted, 50),
		p95Ms: percentile(sorted, 95),
		p99Ms: percentile(sorted, 99),
		maxMs: sorted[sorted.length - 1] ?? 0,
	};
}

async function metadata() {
	const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	return {
		gitSha: git.status === 0 ? git.stdout.trim() : null,
		date: new Date().toISOString(),
		os: os.platform(),
		arch: os.arch(),
		cpu: os.cpus()[0]?.model ?? null,
		bunVersion: Bun.version,
		nodeVersion: process.versions.node ?? null,
	};
}

function forceGc(): void {
	Bun.gc(true);
}

function renderAll(messages: string[], width: number): number {
	let renderedLineCount = 0;
	for (const message of messages) {
		renderedLineCount += new Markdown(message, 0, 0, defaultMarkdownTheme).render(width).length;
	}
	return renderedLineCount;
}

function measureFixture(messages: string[], width: number) {
	let renderedLineCount = 0;
	for (let i = 0; i < WARMUP_RENDERS; i++) {
		renderedLineCount = renderAll(messages, width);
	}
	const durations: number[] = [];
	for (let i = 0; i < MEASURED_RENDERS; i++) {
		const start = performance.now();
		renderedLineCount = renderAll(messages, width);
		durations.push(performance.now() - start);
	}
	return { ...stats(durations), renderedLineCount };
}

function measureDistinctCache(width: number) {
	forceGc();
	const beforeBytes = process.memoryUsage().heapUsed;
	let renderedLineCount = 0;
	for (let i = 0; i < 1000; i++) {
		const message = `${documentChunk(i)}\nunique tail ${i} ${"x".repeat(i % 97)}`;
		renderedLineCount += new Markdown(message, 0, 0, defaultMarkdownTheme).render(width).length;
	}
	forceGc();
	const afterBytes = process.memoryUsage().heapUsed;
	return {
		width,
		distinctMessages: 1000,
		renderedLineCount,
		beforeBytes,
		afterBytes,
		deltaBytes: afterBytes - beforeBytes,
	};
}

async function main(): Promise<void> {
	const outputArg = process.argv.find(arg => arg.startsWith("--output="));
	const outputPath = outputArg?.slice("--output=".length) ?? "/tmp/ug-evidence/g003/markdown-render.json";
	await mkdir(outputPath.slice(0, outputPath.lastIndexOf("/")), { recursive: true });

	const fixtures = {
		messages100: makeMessages(100),
		messages1000: makeMessages(1000),
		document100kb: [makeLargeDocument()],
	};

	const results: Record<string, Record<string, ReturnType<typeof measureFixture>>> = {};
	for (const [fixtureName, messages] of Object.entries(fixtures)) {
		results[fixtureName] = {};
		for (const width of WIDTHS) {
			results[fixtureName][String(width)] = measureFixture(messages, width);
		}
	}

	const result = {
		_meta: await metadata(),
		fixture: {
			widths: WIDTHS,
			warmupRenders: WARMUP_RENDERS,
			measuredRenders: MEASURED_RENDERS,
			messageFixtures: Object.fromEntries(Object.entries(fixtures).map(([name, messages]) => [name, messages.length])),
			document100kbBytes: fixtures.document100kb[0].length,
		},
		results,
		cacheMemory: measureDistinctCache(120),
	};
	await Bun.write(outputPath, `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify(result, null, 2));
}

await main();
