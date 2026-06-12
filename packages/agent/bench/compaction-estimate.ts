import { performance } from "node:perf_hooks";
import * as os from "node:os";
import { estimateOpenAiCompactInputTokens, trimOpenAiCompactInput } from "../src/compaction/openai";
import { estimateEntriesTokens, findCutPoint } from "../src/compaction/compaction";
import type { SessionEntry } from "../src/compaction/entries";

const WARMUP_ITERATIONS = 20;
const MEASURE_ITERATIONS = 200;
const COLD_MEASURE_ITERATIONS = 40;
const TRIM_MEASURE_ITERATIONS = 20;
const ALLOCATION_SAMPLES = 20;
const ALLOCATION_PASSES_PER_SAMPLE = 25;

interface MetricSummary {
	minMs: number;
	medianMs: number;
	p95Ms: number;
	maxMs: number;
}

interface MetricOutput extends MetricSummary {
	samplesMs: number[];
	deltaPercent?: MetricSummary;
}

interface AllocationMetricOutput {
	samplesBytes: number[];
	allocatedBytesPerPass: number;
	deltaPercent?: number;
}

interface BenchOutput {
	schemaVersion: 1;
	package: "@gajae-code/agent";
	bench: "compaction-estimate";
	fixture: string;
	fixtureDimensions: { entries: number; openAiItems: number };
	warmupIterations: number;
	measureIterations: number;
	metadata: {
		gitSha: string;
		date: string;
		platform: NodeJS.Platform;
		arch: string;
		cpu: string;
		bunVersion: string;
		command: string;
	};
	metrics: Record<string, MetricOutput | AllocationMetricOutput>;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state += 0x6d2b79f5;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function text(rng: () => number, words: number): string {
	const vocab = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "gajae", "token", "context", "prune"];
	let out = "";
	for (let i = 0; i < words; i++) out += `${vocab[Math.floor(rng() * vocab.length)]} `;
	return out;
}

function buildEntries(count = 10_000): SessionEntry[] {
	const rng = mulberry32(0xc0ffee);
	const entries: SessionEntry[] = [];
	for (let i = 0; i < count; i++) {
		const mod = i % 5;
		if (mod === 0) {
			entries.push({ type: "message", id: `u-${i}`, timestamp: "2026-06-12T00:00:00.000Z", message: { role: "user", content: text(rng, 18) } });
		} else if (mod === 1) {
			entries.push({ type: "message", id: `a-${i}`, timestamp: "2026-06-12T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: text(rng, 24) }, { type: "toolCall", id: `tc-${i}`, name: rng() > 0.5 ? "bash" : "search", arguments: { path: `src/${i % 31}.ts`, query: text(rng, 3), limit: i % 7 } }] } });
		} else if (mod === 2) {
			entries.push({ type: "message", id: `tr-${i}`, timestamp: "2026-06-12T00:00:00.000Z", message: { role: "toolResult", toolName: rng() > 0.5 ? "bash" : "read", toolCallId: `tc-${i - 1}`, content: [{ type: "text", text: text(rng, 110) }] } });
		} else if (mod === 3) {
			entries.push({ type: "message", id: `b-${i}`, timestamp: "2026-06-12T00:00:00.000Z", message: { role: "bashExecution", command: `bun test case-${i}`, output: text(rng, 60) } });
		} else {
			entries.push({ type: "custom_message", id: `c-${i}`, timestamp: "2026-06-12T00:00:00.000Z", message: { role: "user", content: text(rng, 14), customType: "bench", display: false } });
		}
	}
	return entries;
}

function buildOpenAiItems(count = 5_000): Array<Record<string, unknown>> {
	const rng = mulberry32(0xabcd);
	const items: Array<Record<string, unknown>> = [];
	for (let i = 0; i < count; i++) items.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "input_text", text: text(rng, 28) }], meta: { index: i, ok: true, skip: undefined } });
	return items;
}

function buildOpenAiTrimItems(count = 5_000): Array<Record<string, unknown>> {
	const rng = mulberry32(0x71eed);
	const items: Array<Record<string, unknown>> = [];
	for (let i = 0; i < count; i++) {
		if (i === 0) items.push({ type: "message", role: "user", content: [{ type: "input_text", text: text(rng, 32) }] });
		else items.push({ type: "message", role: "developer", content: [{ type: "input_text", text: text(rng, 32) }], meta: { index: i } });
	}
	return items;
}

function cloneOpenAiTrimTemplate(template: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return structuredClone(template) as Array<Record<string, unknown>>;
}

function mutateOpenAiItemsForSizing(items: Array<Record<string, unknown>>, iteration: number): void {
	const item = items[iteration % items.length];
	if (!item) return;
	item.meta = { index: iteration, ok: true, skip: undefined };
}

function time(fn: () => void): number {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function summarize(values: number[]): MetricSummary {
	return { minMs: Math.min(...values), medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: Math.max(...values) };
}

function parseArgs(): { out?: string; baseline?: string } {
	const args = process.argv.slice(2);
	const parsed: { out?: string; baseline?: string } = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--out") parsed.out = args[++i];
		else if (args[i] === "--baseline") parsed.baseline = args[++i];
	}
	return parsed;
}

function gitSha(): string {
	return Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
}

async function readBaseline(path: string | undefined): Promise<BenchOutput | undefined> {
	if (!path) return undefined;
	return await Bun.file(path).json() as BenchOutput;
}

function deltaPercent(current: number, baseline: number): number {
	return baseline === 0 ? 0 : ((current - baseline) / baseline) * 100;
}

function metricOutput(samplesMs: number[], baseline?: MetricOutput): MetricOutput {
	const summary = summarize(samplesMs);
	const output: MetricOutput = { samplesMs, ...summary };
	if (baseline) {
		output.deltaPercent = {
			minMs: deltaPercent(summary.minMs, baseline.minMs),
			medianMs: deltaPercent(summary.medianMs, baseline.medianMs),
			p95Ms: deltaPercent(summary.p95Ms, baseline.p95Ms),
			maxMs: deltaPercent(summary.maxMs, baseline.maxMs),
		};
	}
	return output;
}

function allocationMetricOutput(samplesBytes: number[], baseline?: AllocationMetricOutput): AllocationMetricOutput {
	const allocatedBytesPerPass = samplesBytes.reduce((total, sample) => total + sample, 0) / samplesBytes.length;
	const output: AllocationMetricOutput = { samplesBytes, allocatedBytesPerPass };
	if (baseline) output.deltaPercent = deltaPercent(allocatedBytesPerPass, baseline.allocatedBytesPerPass);
	return output;
}

function sampleHeapAllocationBytes(fn: () => void): number {
	Bun.gc(true);
	const before = process.memoryUsage().heapUsed;
	for (let i = 0; i < ALLOCATION_PASSES_PER_SAMPLE; i++) fn();
	Bun.gc(true);
	const after = process.memoryUsage().heapUsed;
	return Math.max(0, after - before) / ALLOCATION_PASSES_PER_SAMPLE;
}

function metricBaseline(baseline: BenchOutput | undefined, name: string): MetricOutput | undefined {
	return baseline?.metrics[name] as MetricOutput | undefined;
}

function allocationMetricBaseline(baseline: BenchOutput | undefined, name: string): AllocationMetricOutput | undefined {
	return baseline?.metrics[name] as AllocationMetricOutput | undefined;
}

const { out, baseline: baselinePath } = parseArgs();
const baseline = await readBaseline(baselinePath);
const entries = buildEntries();
const openAiItems = buildOpenAiItems();
const openAiTrimTemplate = buildOpenAiTrimItems();
const samples = {
	coldEstimateEntriesTokensMs: [] as number[],
	repeatedEstimateEntriesTokensMs: [] as number[],
	findCutPointMs: [] as number[],
	openAiSizingMs: [] as number[],
	trimScenarioMs: [] as number[],
	openAiSizingAllocationBytes: [] as number[],
};

for (let i = 0; i < WARMUP_ITERATIONS; i++) {
	estimateEntriesTokens(entries, 0, entries.length);
	findCutPoint(entries, 0, entries.length, 25_000);
	estimateOpenAiCompactInputTokens(openAiItems, "bench instructions");
	trimOpenAiCompactInput(cloneOpenAiTrimTemplate(openAiTrimTemplate), 1_000, "bench instructions");
}

for (let i = 0; i < MEASURE_ITERATIONS; i++) {
	if (i < COLD_MEASURE_ITERATIONS) {
		// Cold measurements clone a 10k-entry fixture and intentionally use fewer samples;
		// the hot-path CPU gates below use the full 200 measured-iteration protocol.
		const coldEntries = structuredClone(entries) as SessionEntry[];
		samples.coldEstimateEntriesTokensMs.push(time(() => { estimateEntriesTokens(coldEntries, 0, coldEntries.length); }));
	}
	samples.repeatedEstimateEntriesTokensMs.push(time(() => { estimateEntriesTokens(entries, 0, entries.length); }));
	samples.findCutPointMs.push(time(() => { findCutPoint(entries, 0, entries.length, 25_000); }));
	mutateOpenAiItemsForSizing(openAiItems, i);
	samples.openAiSizingMs.push(time(() => { estimateOpenAiCompactInputTokens(openAiItems, "bench instructions"); }));
	if (i < TRIM_MEASURE_ITERATIONS) {
		const trimItems = cloneOpenAiTrimTemplate(openAiTrimTemplate);
		samples.trimScenarioMs.push(time(() => { trimOpenAiCompactInput(trimItems, 1_000, "bench instructions"); }));
	}
}

for (let i = 0; i < ALLOCATION_SAMPLES; i++) {
	mutateOpenAiItemsForSizing(openAiItems, i + MEASURE_ITERATIONS);
	samples.openAiSizingAllocationBytes.push(sampleHeapAllocationBytes(() => { estimateOpenAiCompactInputTokens(openAiItems, "bench instructions"); }));
}

const output: BenchOutput = {
	schemaVersion: 1,
	package: "@gajae-code/agent",
	bench: "compaction-estimate",
	fixture: "deterministic-10k-session-5k-openai-items",
	fixtureDimensions: { entries: entries.length, openAiItems: openAiItems.length },
	warmupIterations: WARMUP_ITERATIONS,
	measureIterations: MEASURE_ITERATIONS,
	metadata: {
		gitSha: gitSha(),
		date: new Date().toISOString(),
		platform: process.platform,
		arch: process.arch,
		cpu: os.cpus()[0]?.model ?? "unknown",
		bunVersion: Bun.version,
		command: process.argv.join(" "),
	},
	metrics: {
		coldEstimateEntriesTokens: metricOutput(samples.coldEstimateEntriesTokensMs, metricBaseline(baseline, "coldEstimateEntriesTokens")),
		repeatedEstimateEntriesTokens: metricOutput(samples.repeatedEstimateEntriesTokensMs, metricBaseline(baseline, "repeatedEstimateEntriesTokens")),
		findCutPoint: metricOutput(samples.findCutPointMs, metricBaseline(baseline, "findCutPoint")),
		openAiSizing: metricOutput(samples.openAiSizingMs, metricBaseline(baseline, "openAiSizing")),
		openAiSizingAllocation: allocationMetricOutput(samples.openAiSizingAllocationBytes, allocationMetricBaseline(baseline, "openAiSizingAllocation")),
		trimScenario: metricOutput(samples.trimScenarioMs, metricBaseline(baseline, "trimScenario")),
	},
};

if (out) await Bun.write(out, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output));
