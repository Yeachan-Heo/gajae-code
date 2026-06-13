/**
 * Benchmark: append-only context construction, stable-prefix cache, and fingerprint paths.
 *
 * Run: bun packages/agent/bench/append-only-context.ts
 */
import { benchRunMetadata, type BenchRunMetadata } from "./_meta";
import { AppendOnlyContextManager, StablePrefix } from "@gajae-code/agent-core/append-only-context";
import type { AgentContext } from "@gajae-code/agent-core/types";
import type { Message, Tool } from "@gajae-code/ai";
import * as z from "zod/v4";

const WARMUP_ITERATIONS = 20;
const MEASURE_ITERATIONS = 200;
const PACKAGE_NAME = "@gajae-code/agent-core";

type Fixture = {
	name: string;
	messageCount: number;
	path: "full-construction" | "stable-prefix" | "fingerprint";
	notes: string[];
};

type BenchSample = {
	fixture: string;
	fixtureDimensions: Record<string, number | string | boolean>;
	warmupIterations: number;
	measureIterations: number;
	samples: number[];
	medianMs: number;
	p95Ms: number;
	p99Ms: number;
	rssBeforeBytes: number;
	rssAfterBytes: number;
	heapBeforeBytes: number;
	heapAfterBytes: number;
	notes: string[];
};

type BenchOutput = {
	schemaVersion: 1;
	command: string;
	package: string;
	bench: string;
	fixture: string;
	fixtureDimensions: Record<string, number | string | boolean>;
	warmupIterations: number | null;
	measureIterations: number | null;
	samples: number[] | null;
	medianMs: number | null;
	p95Ms: number | null;
	p99Ms: number | null;
	rssBeforeBytes: number;
	rssAfterBytes: number;
	heapBeforeBytes: number;
	heapAfterBytes: number;
	notes: string[];
	metadata: BenchRunMetadata;
	fixtures: BenchSample[];
};

function createTools(): Tool[] {
	const schema = z.object({ path: z.string(), limit: z.number().optional(), explain: z.boolean().optional() });
	return Array.from({ length: 8 }, (_, index) => ({
		name: `context_tool_${index}`,
		description: `Tool ${index} used to keep prefix schema realistic for append-only context benchmarks.`,
		parameters: schema,
	}));
}

function createContext(messages: Message[]): AgentContext {
	return {
		systemPrompt: [
			"You are a benchmark agent measuring append-only context behavior.",
			"Preserve stable provider-visible prefixes while messages grow turn by turn.",
		],
		messages: messages as AgentContext["messages"],
		tools: createTools() as AgentContext["tools"],
	};
}

function makeText(seed: number, words: number): string {
	const parts: string[] = [];
	for (let i = 0; i < words; i++) parts.push(`word${(seed + i) % 97}`);
	return parts.join(" ");
}

function createMessages(count: number): Message[] {
	const messages: Message[] = [];
	for (let i = 0; i < count; i++) {
		const kind = i % 3;
		if (kind === 0) {
			messages.push({ role: "user", content: [{ type: "text", text: `User request ${i}: ${makeText(i, 28)}` }] } as Message);
		} else if (kind === 1) {
			messages.push({
				role: "assistant",
				content: [
					{ type: "text", text: `Assistant answer ${i}: ${makeText(i * 3, 36)}` },
					{
						type: "toolCall",
						id: `tool-call-${i}`,
						name: `context_tool_${i % 8}`,
						arguments: { path: `packages/agent/src/file-${i % 13}.ts`, limit: (i % 5) + 1, explain: i % 2 === 0 },
					},
				],
				api: "mock",
				model: "mock-model",
				stopReason: "toolUse",
			} as Message);
		} else {
			messages.push({
				role: "toolResult",
				toolCallId: `tool-call-${i - 1}`,
				toolName: `context_tool_${(i - 1) % 8}`,
				content: [{ type: "text", text: `Tool result ${i}: ${makeText(i * 7, 44)}` }],
			} as Message);
		}
	}
	return messages;
}

function forceGc() {
	Bun.gc(true);
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[index];
}

function summarize(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	return { medianMs: percentile(sorted, 50), p95Ms: percentile(sorted, 95), p99Ms: percentile(sorted, 99) };
}

function commonIterationCount(samples: BenchSample[], key: "warmupIterations" | "measureIterations"): number | null {
	const counts = new Set(samples.map(sample => sample[key]));
	return counts.size === 1 ? samples[0]?.[key] ?? null : null;
}

function runFixtureOnce(fixture: Fixture, messages: Message[]): number {
	const context = createContext(messages);
	if (fixture.path === "full-construction") {
		const manager = new AppendOnlyContextManager();
		manager.syncMessages(messages);
		const built = manager.build(context, { intentTracing: false });
		return built.messages.length + (built.systemPrompt?.length ?? 0) + (built.tools?.length ?? 0);
	}

	if (fixture.path === "stable-prefix") {
		const manager = new AppendOnlyContextManager();
		manager.syncMessages(messages);
		manager.build(context, { intentTracing: false });
		const rebuilt = manager.build(context, { intentTracing: false });
		return rebuilt.messages.length + manager.prefix.version;
	}

	const prefix = new StablePrefix();
	prefix.build(context, { intentTracing: false });
	const snapshot = prefix.exportSnapshot();
	if (!snapshot) throw new Error("Expected stable prefix snapshot");
	const imported = new StablePrefix();
	imported.importSnapshot(snapshot, { intentTracing: false });
	return snapshot.fingerprint.length + imported.fingerprint.length;
}

function benchFixture(fixture: Fixture): BenchSample {
	const messages = createMessages(fixture.messageCount);
	for (let i = 0; i < WARMUP_ITERATIONS; i++) runFixtureOnce(fixture, messages);
	forceGc();
	const before = process.memoryUsage();
	const samples: number[] = [];
	let guard = 0;
	for (let i = 0; i < MEASURE_ITERATIONS; i++) {
		const start = performance.now();
		guard += runFixtureOnce(fixture, messages);
		samples.push(performance.now() - start);
	}
	if (guard === 0) throw new Error("Benchmark guard prevented optimization");
	forceGc();
	const after = process.memoryUsage();
	return {
		fixture: fixture.name,
		fixtureDimensions: {
			messageCount: fixture.messageCount,
			path: fixture.path,
			toolCount: 8,
			systemPromptCount: 2,
		},
		warmupIterations: WARMUP_ITERATIONS,
		measureIterations: MEASURE_ITERATIONS,
		samples,
		...summarize(samples),
		rssBeforeBytes: before.rss,
		rssAfterBytes: after.rss,
		heapBeforeBytes: before.heapUsed,
		heapAfterBytes: after.heapUsed,
		notes: fixture.notes,
	};
}

const fixtures: Fixture[] = [
	{
		name: "100-messages-full-construction",
		messageCount: 100,
		path: "full-construction",
		notes: ["Builds a fresh AppendOnlyContextManager, syncs mixed messages, and constructs full provider context."],
	},
	{
		name: "100-messages-stable-prefix",
		messageCount: 100,
		path: "stable-prefix",
		notes: ["Measures cached stable-prefix build path after an initial build."],
	},
	{
		name: "100-messages-fingerprint",
		messageCount: 100,
		path: "fingerprint",
		notes: ["Measures StablePrefix snapshot fingerprint export/import validation path."],
	},
	{
		name: "1000-messages-full-construction",
		messageCount: 1_000,
		path: "full-construction",
		notes: ["Builds a fresh AppendOnlyContextManager, syncs mixed messages, and constructs full provider context."],
	},
	{
		name: "1000-messages-stable-prefix",
		messageCount: 1_000,
		path: "stable-prefix",
		notes: ["Measures cached stable-prefix build path after an initial build."],
	},
	{
		name: "1000-messages-fingerprint",
		messageCount: 1_000,
		path: "fingerprint",
		notes: ["Measures StablePrefix snapshot fingerprint export/import validation path."],
	},
];

const samples: BenchSample[] = [];
for (const fixture of fixtures) {
	console.error(`append-only-context: ${fixture.name}`);
	const sample = benchFixture(fixture);
	samples.push(sample);
	console.error(`  median=${sample.medianMs.toFixed(3)}ms p95=${sample.p95Ms.toFixed(3)}ms p99=${sample.p99Ms.toFixed(3)}ms`);
}

const aggregateSamples = samples.length === 1 ? (samples[0]?.samples ?? []) : null;
const aggregate = aggregateSamples === null ? { medianMs: null, p95Ms: null, p99Ms: null } : summarize(aggregateSamples);
const aggregateWarmupIterations = commonIterationCount(samples, "warmupIterations");
const aggregateMeasureIterations = commonIterationCount(samples, "measureIterations");
const aggregateIterationNotes = [
	aggregateWarmupIterations === null ? "warmupIterations is null because per-fixture rows used heterogeneous warmup counts; see fixtures[].warmupIterations." : undefined,
	aggregateMeasureIterations === null ? "measureIterations is null because per-fixture rows used heterogeneous measure counts; see fixtures[].measureIterations." : undefined,
	aggregateSamples === null ? "samples is null because top-level output aggregates multiple fixture rows; per-row fixtures[].samples are authoritative." : undefined,
].filter((note): note is string => note !== undefined);
const output: BenchOutput = {
	schemaVersion: 1,
	command: "bun packages/agent/bench/append-only-context.ts",
	package: PACKAGE_NAME,
	bench: "append-only-context",
	fixture: "all",
	fixtureDimensions: { fixtureCount: samples.length },
	warmupIterations: aggregateWarmupIterations,
	measureIterations: aggregateMeasureIterations,
	samples: aggregateSamples,
	...aggregate,
	rssBeforeBytes: samples[0]?.rssBeforeBytes ?? 0,
	rssAfterBytes: samples.at(-1)?.rssAfterBytes ?? 0,
	heapBeforeBytes: samples[0]?.heapBeforeBytes ?? 0,
	heapAfterBytes: samples.at(-1)?.heapAfterBytes ?? 0,
	notes: ["Per-fixture machine-readable rows are in fixtures[].", "Human-readable progress is emitted on stderr; stdout ends with one JSON document.", ...aggregateIterationNotes],
	metadata: await benchRunMetadata(),
	fixtures: samples,
};

console.log(JSON.stringify(output));
