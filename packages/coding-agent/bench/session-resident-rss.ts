import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import type { AssistantMessage, Message, TextContent, ToolCall, ToolResultMessage, Usage } from "@gajae-code/ai";
import { SessionManager } from "../src/session/session-manager";

const PACKAGE_NAME = "@gajae-code/coding-agent";
const BENCH_NAME = "session-resident-rss";
const WARMUP_SAMPLES = 5;
const MEASURE_SAMPLES = 20;
const TOOL_RESULT_COUNT = 100;
const TOOL_RESULT_BYTES = 512 * 1024;
const SCHEMA_VERSION = 1;

type BenchRunMetadata = {
	gitSha: string | null;
	date: string;
	platform: string;
	arch: string;
	cpu: string | null;
	bunVersion: string;
	command: string;
};

type Summary = {
	min: number;
	median: number;
	p95: number;
	max: number;
};

type LatencySummary = Summary & {
	unit: "ms";
	samples: number[];
};

type MemorySummary = Summary & {
	unit: "bytes";
	samples: number[];
};

type BenchOutput = {
	schemaVersion: number;
	package: string;
	bench: string;
	fixture: string;
	fixtureDimensions: {
		toolResultEntries: number;
		toolResultBytes: number;
		persisted: boolean;
	};
	warmupIterations: number;
	measureIterations: number;
	metadata: BenchRunMetadata;
	metrics: {
		retainedHeapBytes: MemorySummary;
		rssBytes: MemorySummary;
		fixtureRetainedHeapBytes: MemorySummary;
		getEntriesMs: LatencySummary;
		buildSessionContextMs: LatencySummary;
	};
	guard: {
		entryCount: number;
		contextMessageCount: number;
	};
};

type CliArgs = {
	outPath?: string;
	baselinePath?: string;
};

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out") {
			const value = argv[++i];
			if (!value) throw new Error("--out requires a path");
			args.outPath = value;
		} else if (arg === "--baseline") {
			const value = argv[++i];
			if (!value) throw new Error("--baseline requires a path");
			args.baselinePath = value;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function deterministicText(seed: number, bytes: number): string {
	const random = mulberry32(seed);
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let text = "";
	while (text.length < bytes) {
		let line = "";
		for (let i = 0; i < 96; i++) {
			line += alphabet[Math.floor(random() * alphabet.length)] ?? "x";
		}
		text += `${line}\n`;
	}
	return text.slice(0, bytes);
}

function usage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function textContent(text: string): TextContent {
	return { type: "text", text };
}

function toolCall(index: number): ToolCall {
	return {
		type: "toolCall",
		id: `tool-call-${index}`,
		name: "bench_tool",
		args: { index },
	};
}

function assistantMessage(index: number): AssistantMessage {
	return {
		role: "assistant",
		content: [textContent(`bench assistant ${index}`), toolCall(index)],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "bench-model",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResultMessage(index: number, content: string): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId: `tool-call-${index}`,
		toolName: "bench_tool",
		content: [textContent(content)],
		details: { index, bytes: content.length },
		isError: false,
		timestamp: Date.now(),
	};
}

async function createFixture(): Promise<SessionManager> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-rss-"));
	const sessionDir = path.join(root, "sessions");
	const manager = SessionManager.create(root, sessionDir);
	manager.appendMessage({ role: "user", content: "rss fixture", timestamp: Date.now() });
	for (let i = 0; i < TOOL_RESULT_COUNT; i++) {
		manager.appendMessage(assistantMessage(i));
		manager.appendMessage(toolResultMessage(i, deterministicText(0xc0ffee + i, TOOL_RESULT_BYTES)) as Message);
	}
	return SessionManager.open(manager.getSessionFile());
}


function forceGc(): void {
	Bun.gc(true);
}

async function settleAndForceGc(): Promise<void> {
	await Bun.sleep(0);
	forceGc();
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[index] ?? 0;
}

function summarize(samples: number[]): Summary {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		min: sorted[0] ?? 0,
		median: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: sorted.at(-1) ?? 0,
	};
}

function summarizeLatency(samples: number[]): LatencySummary {
	return { unit: "ms", samples, ...summarize(samples) };
}

function summarizeMemory(samples: number[]): MemorySummary {
	return { unit: "bytes", samples, ...summarize(samples) };
}

function measureLatency(fn: () => number): { ms: number; guard: number } {
	const start = performance.now();
	const guard = fn();
	return { ms: performance.now() - start, guard };
}

function benchMetadata(): BenchRunMetadata {
	const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	return {
		gitSha: git.status === 0 ? git.stdout.trim() : null,
		date: new Date().toISOString(),
		platform: os.platform(),
		arch: os.arch(),
		cpu: os.cpus()[0]?.model ?? null,
		bunVersion: Bun.version,
		command: "bun packages/coding-agent/bench/session-resident-rss.ts",
	};
}

async function runBenchmark(): Promise<BenchOutput> {
	await settleAndForceGc();
	const beforeFixtureHeapBytes = process.memoryUsage().heapUsed;
	const manager = await createFixture();
	let guard = 0;
	// Phase A: warmup — populate caches so phase B measures the warm path.
	for (let i = 0; i < WARMUP_SAMPLES; i++) {
		guard += manager.getEntries().length;
		guard += manager.buildSessionContext().messages.length;
	}
	// Phase B: warm latency — no forced GC between samples. "Warm" means
	// cache-resident; forcing GC here would measure cold rematerialization.
	const getEntriesSamples: number[] = [];
	const buildSessionContextSamples: number[] = [];
	const rssSamples: number[] = [];
	for (let i = 0; i < MEASURE_SAMPLES; i++) {
		const entriesLatency = measureLatency(() => manager.getEntries().length);
		getEntriesSamples.push(entriesLatency.ms);
		guard += entriesLatency.guard;
		const contextLatency = measureLatency(() => manager.buildSessionContext().messages.length);
		buildSessionContextSamples.push(contextLatency.ms);
		guard += contextLatency.guard;
		rssSamples.push(process.memoryUsage().rss);
	}
	// Phase C: retained heap — forced GC before each sample per the plan's GC
	// protocol. Measures what the manager pins under memory pressure; latency
	// is intentionally not measured in this phase. The await before forceGc()
	// ends the current job: per spec, WeakRef targets deref'd/created during a
	// job are kept alive until that job completes, so GC inside the same job
	// cannot collect weakly-held caches regardless of implementation.
	const heapSamples: number[] = [];
	for (let i = 0; i < MEASURE_SAMPLES; i++) {
		guard += manager.getEntries().length;
		await settleAndForceGc();
		await settleAndForceGc();
		heapSamples.push(process.memoryUsage().heapUsed);
	}
	if (guard === 0) throw new Error("Benchmark guard prevented work from being observed");
	return {
		schemaVersion: SCHEMA_VERSION,
		package: PACKAGE_NAME,
		bench: BENCH_NAME,
		fixture: "persisted-100-tool-results-512kib",
		fixtureDimensions: {
			toolResultEntries: TOOL_RESULT_COUNT,
			toolResultBytes: TOOL_RESULT_BYTES,
			persisted: true,
		},
		warmupIterations: WARMUP_SAMPLES,
		measureIterations: MEASURE_SAMPLES,
		metadata: benchMetadata(),
		metrics: {
			retainedHeapBytes: summarizeMemory(heapSamples),
			fixtureRetainedHeapBytes: summarizeMemory(heapSamples.map(sample => Math.max(0, sample - beforeFixtureHeapBytes))),
			rssBytes: summarizeMemory(rssSamples),
			getEntriesMs: summarizeLatency(getEntriesSamples),
			buildSessionContextMs: summarizeLatency(buildSessionContextSamples),
		},
		guard: {
			entryCount: manager.getEntries().length,
			contextMessageCount: manager.buildSessionContext().messages.length,
		},
	};
}

function deltaPercent(current: number, baseline: number): number | null {
	if (baseline === 0) return null;
	return ((current - baseline) / baseline) * 100;
}

async function printBaselineComparison(output: BenchOutput, baselinePath: string): Promise<void> {
	const baseline = (await Bun.file(baselinePath).json()) as BenchOutput;
	const rows = [
		["retainedHeapBytes.median", output.metrics.retainedHeapBytes.median, baseline.metrics.retainedHeapBytes.median],
		["fixtureRetainedHeapBytes.median", output.metrics.fixtureRetainedHeapBytes.median, baseline.metrics.fixtureRetainedHeapBytes?.median ?? NaN],
		["rssBytes.median", output.metrics.rssBytes.median, baseline.metrics.rssBytes.median],
		["getEntriesMs.median", output.metrics.getEntriesMs.median, baseline.metrics.getEntriesMs.median],
		["buildSessionContextMs.median", output.metrics.buildSessionContextMs.median, baseline.metrics.buildSessionContextMs.median],
	] as const;
	console.error("Baseline comparison:");
	for (const [name, current, previous] of rows) {
		const delta = deltaPercent(current, previous);
		console.error(`  ${name}: current=${current.toFixed(3)} baseline=${previous.toFixed(3)} delta=${delta === null ? "n/a" : `${delta.toFixed(2)}%`}`);
	}
}

const cliArgs = parseArgs(Bun.argv);
const output = await runBenchmark();
if (cliArgs.outPath) {
	await Bun.write(cliArgs.outPath, `${JSON.stringify(output, null, 2)}\n`);
}
if (cliArgs.baselinePath) {
	await printBaselineComparison(output, cliArgs.baselinePath);
}
console.log(JSON.stringify(output));
