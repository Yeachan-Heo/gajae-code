/**
 * Benchmark: intra-line word diff rendering and mental-model LCS rendering.
 *
 * Run: bun packages/coding-agent/bench/word-diff-lcs.ts --out /tmp/out.json [--baseline /tmp/baseline.json]
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { renderDiff } from "../src/modes/components/diff";
import { diffMentalModelContent } from "../src/hindsight/mental-models";
import { initTheme } from "../src/modes/theme/theme";

type FixtureKind = "identical" | "single-token" | "prefix-suffix" | "whitespace" | "tabs" | "unicode" | "long-line";

type BenchSample = {
	fixture: string;
	fixtureDimensions: Record<string, number | string | boolean>;
	warmupIterations: number;
	measureIterations: number;
	samples: number[];
	medianMs: number;
	p95Ms: number;
	heapBeforeBytes: number;
	heapAfterBytes: number;
	notes: string[];
	baselineMedianMs?: number;
	medianDeltaPct?: number;
	heapDeltaPct?: number;
};

type BenchOutput = {
	schemaVersion: 1;
	command: string;
	package: string;
	bench: string;
	fixture: string;
	fixtureDimensions: Record<string, number | string | boolean>;
	warmupIterations: null;
	measureIterations: null;
	samples: null;
	medianMs: null;
	p95Ms: null;
	heapBeforeBytes: number;
	heapAfterBytes: number;
	notes: string[];
	metadata: {
		gitSha: string | null;
		date: string;
		os: string;
		arch: string;
		cpu: string | null;
		bunVersion: string;
		nodeVersion: string | null;
	};
	fixtures: BenchSample[];
};

const WARMUP_ITERATIONS = 8;
const MEASURE_ITERATIONS = 30;
const WORD_PAIR_COUNT = 10_000;

function parseArgs(): { out?: string; baseline?: string } {
	const args = process.argv.slice(2);
	const parsed: { out?: string; baseline?: string } = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--out") parsed.out = args[++i];
		else if (arg === "--baseline") parsed.baseline = args[++i];
	}
	return parsed;
}

function metadata(): BenchOutput["metadata"] {
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

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function summarize(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	return { medianMs: percentile(sorted, 50), p95Ms: percentile(sorted, 95) };
}

function forceGc() {
	Bun.gc(true);
}

function makeWordPairs(kind: FixtureKind): Array<[string, string]> {
	return Array.from({ length: WORD_PAIR_COUNT }, (_, i): [string, string] => {
		switch (kind) {
			case "identical":
				return [`const value${i} = alpha${i % 17} + omega${i % 23};`, `const value${i} = alpha${i % 17} + omega${i % 23};`];
			case "single-token":
				return [`const value${i} = alpha${i % 17} + omega${i % 23};`, `const value${i} = delta${i % 19} + omega${i % 23};`];
			case "prefix-suffix":
				return [`return renderChunk${i}(previousState, options);`, `return renderChunk${i}(currentState, options);`];
			case "whitespace":
				return [`const value${i} = call(${i}, ${i + 1});`, `const  value${i} = call(${i},  ${i + 1});`];
			case "tabs":
				return [`\tif (value${i}) return oldName${i};`, `\tif (value${i}) return newName${i};`];
			case "unicode":
				return [`const label${i} = "cafe\u0301-${i}";`, `const label${i} = "café-${i}";`];
			case "long-line": {
				const prefix = `const payload${i} = "`;
				const suffix = `";`;
				return [`${prefix}${"a".repeat(1800)}old${i}${"z".repeat(1800)}${suffix}`, `${prefix}${"a".repeat(1800)}new${i}${"z".repeat(1800)}${suffix}`];
			}
		}
	});
}

function runWordFixture(kind: FixtureKind, pairs: Array<[string, string]>): number {
	let guard = 0;
	for (let i = 0; i < pairs.length; i++) {
		const [oldLine, newLine] = pairs[i]!;
		const rendered = renderDiff(`-1|${oldLine}\n+1|${newLine}`, { filePath: "fixture.ts" });
		guard += rendered.length;
	}
	return guard;
}

function makeAllowedFixture(size: number): [string, string] {
	const previous = Array.from({ length: size }, (_, i) => `line ${i}`).join("\n");
	const current = Array.from({ length: size }, (_, i) => (i % 10 === 0 ? `line ${i} edited` : `line ${i}`)).join("\n");
	return [previous, current];
}

function makeRepeatedFixture(size: number): [string, string] {
	const previous = Array.from({ length: size }, (_, i) => (i % 2 === 0 ? "repeat" : `left ${i}`)).join("\n");
	const current = Array.from({ length: size }, (_, i) => (i % 2 === 0 ? `right ${i}` : "repeat")).join("\n");
	return [previous, current];
}

function runLcsFixture(previous: string, current: string): number {
	return diffMentalModelContent(previous, current, 4_000).length;
}

function benchFixture(name: string, dimensions: Record<string, number | string | boolean>, runOnce: () => number, notes: string[], baseline?: BenchSample): BenchSample {
	for (let i = 0; i < WARMUP_ITERATIONS; i++) runOnce();
	forceGc();
	const before = process.memoryUsage();
	const samples: number[] = [];
	let guard = 0;
	for (let i = 0; i < MEASURE_ITERATIONS; i++) {
		const start = performance.now();
		guard += runOnce();
		samples.push(performance.now() - start);
	}
	if (guard === 0) throw new Error("Benchmark guard prevented optimization");
	forceGc();
	const after = process.memoryUsage();
	const summary = summarize(samples);
	const heapDelta = after.heapUsed - before.heapUsed;
	const baselineHeapDelta = baseline ? baseline.heapAfterBytes - baseline.heapBeforeBytes : undefined;
	return {
		fixture: name,
		fixtureDimensions: dimensions,
		warmupIterations: WARMUP_ITERATIONS,
		measureIterations: MEASURE_ITERATIONS,
		samples,
		...summary,
		heapBeforeBytes: before.heapUsed,
		heapAfterBytes: after.heapUsed,
		notes,
		baselineMedianMs: baseline?.medianMs,
		medianDeltaPct: baseline ? ((summary.medianMs - baseline.medianMs) / baseline.medianMs) * 100 : undefined,
		heapDeltaPct: baselineHeapDelta && baselineHeapDelta !== 0 ? ((heapDelta - baselineHeapDelta) / Math.abs(baselineHeapDelta)) * 100 : undefined,
	};
}

async function main() {
	Bun.env.COLORTERM = "truecolor";
	await initTheme();
	const args = parseArgs();
	const baselineOutput = args.baseline ? (JSON.parse(await Bun.file(args.baseline).text()) as BenchOutput) : undefined;
	const baselineByName = new Map((baselineOutput?.fixtures ?? []).map(sample => [sample.fixture, sample]));
	const fixtures: BenchSample[] = [];
	for (const kind of ["identical", "single-token", "prefix-suffix", "whitespace", "tabs", "unicode", "long-line"] as FixtureKind[]) {
		const pairs = makeWordPairs(kind);
		fixtures.push(benchFixture(`word-diff-${kind}`, { pairCount: pairs.length, kind }, () => runWordFixture(kind, pairs), ["Renders 10k changed-line pairs through renderDiff intra-line highlighting."], baselineByName.get(`word-diff-${kind}`)));
	}
	const [allowedPrev, allowedCurr] = makeAllowedFixture(1_000);
	fixtures.push(benchFixture("lcs-1000x1000-allowed", { previousLines: 1_000, currentLines: 1_000 }, () => runLcsFixture(allowedPrev, allowedCurr), ["Renders mental-model diff for 1000x1000 mostly aligned fixture."], baselineByName.get("lcs-1000x1000-allowed")));
	const [repeatedPrev, repeatedCurr] = makeRepeatedFixture(1_000);
	fixtures.push(benchFixture("lcs-1000x1000-repeated-line", { previousLines: 1_000, currentLines: 1_000 }, () => runLcsFixture(repeatedPrev, repeatedCurr), ["Pathological repeated-line fixture for Hunt-Szymanski match explosion guard."], baselineByName.get("lcs-1000x1000-repeated-line")));
	const output: BenchOutput = {
		schemaVersion: 1,
		command: "bun packages/coding-agent/bench/word-diff-lcs.ts --out <path> [--baseline <path>]",
		package: "@gajae-code/coding-agent",
		bench: "word-diff-lcs",
		fixture: "all",
		fixtureDimensions: { fixtureCount: fixtures.length },
		warmupIterations: null,
		measureIterations: null,
		samples: null,
		medianMs: null,
		p95Ms: null,
		heapBeforeBytes: fixtures[0]?.heapBeforeBytes ?? 0,
		heapAfterBytes: fixtures.at(-1)?.heapAfterBytes ?? 0,
		notes: ["Per-fixture rows contain authoritative samples and baseline deltas when --baseline is supplied."],
		metadata: metadata(),
		fixtures,
	};
	const json = JSON.stringify(output);
	if (args.out) await fs.writeFile(args.out, json);
	console.log(json);
}

await main();
