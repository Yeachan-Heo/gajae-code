import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { AssistantMessage, Message, TextContent, ToolCall, ToolResultMessage, Usage } from "@gajae-code/ai";
import { SessionManager } from "../src/session/session-manager";

const PACKAGE_NAME = "@gajae-code/coding-agent";
const BENCH_NAME = "session-get-entries";
const WARMUP_ITERATIONS = 20;
const MEASURE_ITERATIONS = 200;
const ENTRY_COUNT = 10_000;
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

type LatencySummary = {
	unit: "ms";
	samples: number[];
	min: number;
	median: number;
	p95: number;
	max: number;
};

type BenchOutput = {
	schemaVersion: number;
	package: string;
	bench: string;
	fixture: string;
	fixtureDimensions: {
		entries: number;
		persisted: boolean;
		shapeMix: string[];
	};
	warmupIterations: number;
	measureIterations: number;
	metadata: BenchRunMetadata;
	metrics: {
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

function smallText(index: number): string {
	const random = mulberry32(0xface + index);
	const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
	return Array.from({ length: 12 }, () => words[Math.floor(random() * words.length)] ?? "alpha").join(" ");
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
		id: `bench-tool-${index}`,
		name: "bench_tool",
		args: { index, file: `src/file-${index % 100}.ts` },
	};
}

function assistantMessage(index: number): AssistantMessage {
	const content = index % 4 === 1
		? [textContent(`assistant response ${index}`), toolCall(index)]
		: [textContent(`assistant response ${index}`)];
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "bench-model",
		usage: usage(),
		stopReason: index % 4 === 1 ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function toolResultMessage(index: number): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId: `bench-tool-${index - 1}`,
		toolName: "bench_tool",
		content: [textContent(`tool result ${index}: ${smallText(index)}`)],
		details: { exitCode: 0, rows: index % 17 },
		isError: false,
		timestamp: Date.now(),
	};
}

function appendFixtureMessage(manager: SessionManager, index: number): void {
	const role = index % 4;
	if (role === 0) {
		manager.appendMessage({ role: "user", content: `user message ${index}: ${smallText(index)}`, timestamp: Date.now() });
	} else if (role === 1 || role === 3) {
		manager.appendMessage(assistantMessage(index));
	} else {
		manager.appendMessage(toolResultMessage(index) as Message);
	}
}

async function createFixture(): Promise<SessionManager> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-get-entries-"));
	const sessionDir = path.join(root, "sessions");
	const manager = SessionManager.create(root, sessionDir);
	for (let i = 0; i < ENTRY_COUNT; i++) {
		appendFixtureMessage(manager, i);
	}
	return SessionManager.open(manager.getSessionFile());
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[index] ?? 0;
}

function summarizeLatency(samples: number[]): LatencySummary {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		unit: "ms",
		samples,
		min: sorted[0] ?? 0,
		median: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: sorted.at(-1) ?? 0,
	};
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
		command: "bun packages/coding-agent/bench/session-get-entries.bench.ts",
	};
}

async function runBenchmark(): Promise<BenchOutput> {
	const manager = await createFixture();
	let guard = 0;
	for (let i = 0; i < WARMUP_ITERATIONS; i++) {
		guard += manager.getEntries().length;
		guard += manager.buildSessionContext().messages.length;
	}
	const getEntriesSamples: number[] = [];
	const buildSessionContextSamples: number[] = [];
	for (let i = 0; i < MEASURE_ITERATIONS; i++) {
		const entriesLatency = measureLatency(() => manager.getEntries().length);
		getEntriesSamples.push(entriesLatency.ms);
		guard += entriesLatency.guard;
		const contextLatency = measureLatency(() => manager.buildSessionContext().messages.length);
		buildSessionContextSamples.push(contextLatency.ms);
		guard += contextLatency.guard;
	}
	if (guard === 0) throw new Error("Benchmark guard prevented work from being observed");
	return {
		schemaVersion: SCHEMA_VERSION,
		package: PACKAGE_NAME,
		bench: BENCH_NAME,
		fixture: "persisted-10k-small-mixed-entries",
		fixtureDimensions: {
			entries: ENTRY_COUNT,
			persisted: true,
			shapeMix: ["user", "assistant", "toolResult"],
		},
		warmupIterations: WARMUP_ITERATIONS,
		measureIterations: MEASURE_ITERATIONS,
		metadata: benchMetadata(),
		metrics: {
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
		["getEntriesMs.median", output.metrics.getEntriesMs.median, baseline.metrics.getEntriesMs.median],
		["getEntriesMs.p95", output.metrics.getEntriesMs.p95, baseline.metrics.getEntriesMs.p95],
		["buildSessionContextMs.median", output.metrics.buildSessionContextMs.median, baseline.metrics.buildSessionContextMs.median],
		["buildSessionContextMs.p95", output.metrics.buildSessionContextMs.p95, baseline.metrics.buildSessionContextMs.p95],
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
