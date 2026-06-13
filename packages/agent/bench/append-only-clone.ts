/**
 * Benchmark: clone-heavy append-only snapshot export/import cycles.
 *
 * Run: bun packages/agent/bench/append-only-clone.ts
 */
import { benchRunMetadata, type BenchRunMetadata } from "./_meta";
import { AppendOnlyContextManager, StablePrefix } from "@gajae-code/agent-core/append-only-context";
import type { AgentContext } from "@gajae-code/agent-core/types";
import type { Message, Tool } from "@gajae-code/ai";

const WARMUP_ITERATIONS = 10;
const MEASURE_ITERATIONS = 80;
const MESSAGE_COUNT = 1_000;
const PACKAGE_NAME = "@gajae-code/agent-core";

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
	metadata: BenchRunMetadata;
	fixtures: BenchSample[];
};

class PrototypePayload {
	own = "prototype-own";
	missing: string | undefined = undefined;
}

function createTools(): Tool[] {
	return Array.from({ length: 12 }, (_, index) => ({
		name: `clone_tool_${index}`,
		description: `Clone-heavy benchmark tool ${index}`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				limit: { type: "number" },
				flags: { type: "array", items: { type: "string" } },
				omitted: undefined,
			},
			required: ["path"],
		},
	})) as Tool[];
}

function makeText(seed: number, words: number): string {
	const parts: string[] = [];
	for (let i = 0; i < words; i++) parts.push(`word${(seed + i) % 131}`);
	return parts.join(" ");
}

function createMessages(): Message[] {
	const messages: Message[] = [];
	for (let i = 0; i < MESSAGE_COUNT; i++) {
		if (i % 3 === 0) {
			messages.push({
				role: "user",
				content: [{ type: "text", text: `Request ${i}: ${makeText(i, 20)}` }, undefined, , new Date("2026-06-12T08:12:00.000Z")],
				providerPayload: { nested: new PrototypePayload(), missing: undefined },
			} as unknown as Message);
		} else if (i % 3 === 1) {
			messages.push({
				role: "assistant",
				content: [
					{ type: "text", text: `Answer ${i}: ${makeText(i * 3, 26)}` },
					{
						type: "toolCall",
						id: `tool-call-${i}`,
						name: `clone_tool_${i % 12}`,
						arguments: { path: `packages/agent/src/file-${i % 17}.ts`, limit: i % 7, sparse: ["x", , undefined] },
					},
				],
				api: "mock",
				model: "mock-model",
			} as unknown as Message);
		} else {
			messages.push({
				role: "toolResult",
				toolCallId: `tool-call-${i - 1}`,
				toolName: `clone_tool_${(i - 1) % 12}`,
				content: [{ type: "text", text: `Result ${i}: ${makeText(i * 7, 32)}` }],
			} as Message);
		}
	}
	return messages;
}

function createContext(messages: Message[]): AgentContext {
	return {
		systemPrompt: ["Benchmark clone-heavy append-only context.", "Preserve exact provider-visible JSON bytes."],
		messages: messages as AgentContext["messages"],
		tools: createTools() as AgentContext["tools"],
	};
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function summarize(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	return { medianMs: percentile(sorted, 50), p95Ms: percentile(sorted, 95), p99Ms: percentile(sorted, 99) };
}

function forceGc() {
	Bun.gc(true);
}

function runOnce(messages: Message[]): number {
	const context = createContext(messages);
	const prefix = new StablePrefix();
	prefix.build(context, { intentTracing: true });
	const snapshot = prefix.exportSnapshot();
	if (!snapshot) throw new Error("Expected snapshot");

	const manager = AppendOnlyContextManager.forkFromSeed({ prefixSnapshot: snapshot, messages, options: { intentTracing: true } });
	const built = manager.build(context, { intentTracing: true });
	const exported = manager.prefix.exportSnapshot();
	if (!exported) throw new Error("Expected exported snapshot");
	const imported = AppendOnlyContextManager.forkFromSeed({ prefixSnapshot: exported, messages: built.messages, options: { intentTracing: true } });
	return imported.build(context, { intentTracing: true }).messages.length + exported.tools.length;
}

function benchFixture(): BenchSample {
	const messages = createMessages();
	for (let i = 0; i < WARMUP_ITERATIONS; i++) runOnce(messages);
	forceGc();
	const before = process.memoryUsage();
	const samples: number[] = [];
	let guard = 0;
	for (let i = 0; i < MEASURE_ITERATIONS; i++) {
		const start = performance.now();
		guard += runOnce(messages);
		samples.push(performance.now() - start);
	}
	if (guard === 0) throw new Error("Benchmark guard prevented optimization");
	forceGc();
	const after = process.memoryUsage();
	return {
		fixture: "1000-message-snapshot-export-import",
		fixtureDimensions: { messageCount: MESSAGE_COUNT, toolCount: 12, cycles: 2, intentTracing: true },
		warmupIterations: WARMUP_ITERATIONS,
		measureIterations: MEASURE_ITERATIONS,
		samples,
		...summarize(samples),
		rssBeforeBytes: before.rss,
		rssAfterBytes: after.rss,
		heapBeforeBytes: before.heapUsed,
		heapAfterBytes: after.heapUsed,
		notes: ["Constructs 1000 messages, exports/imports prefix snapshots, and seeds/imports append-only logs."],
	};
}

console.error("append-only-clone: 1000-message-snapshot-export-import");
const sample = benchFixture();
console.error(`  median=${sample.medianMs.toFixed(3)}ms p95=${sample.p95Ms.toFixed(3)}ms p99=${sample.p99Ms.toFixed(3)}ms`);

const output: BenchOutput = {
	schemaVersion: 1,
	command: "bun packages/agent/bench/append-only-clone.ts",
	package: PACKAGE_NAME,
	bench: "append-only-clone",
	fixture: sample.fixture,
	fixtureDimensions: sample.fixtureDimensions,
	warmupIterations: sample.warmupIterations,
	measureIterations: sample.measureIterations,
	samples: sample.samples,
	medianMs: sample.medianMs,
	p95Ms: sample.p95Ms,
	p99Ms: sample.p99Ms,
	rssBeforeBytes: sample.rssBeforeBytes,
	rssAfterBytes: sample.rssAfterBytes,
	heapBeforeBytes: sample.heapBeforeBytes,
	heapAfterBytes: sample.heapAfterBytes,
	notes: sample.notes,
	metadata: await benchRunMetadata(),
	fixtures: [sample],
};

console.log(JSON.stringify(output));
