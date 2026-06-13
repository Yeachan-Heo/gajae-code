/**
 * Benchmark: provider stream events -> agent events through the real agent loop.
 *
 * Run: bun packages/agent/bench/agent-loop-events.ts
 *
 * This bench uses the same test construction pattern as agent-loop.test.ts:
 * createMockModel() for the synthetic model plus a custom AssistantMessageEventStream
 * for cases the mock provider does not model directly (many partial tool-call deltas
 * and aborts between stream phases). No production exports or shims are required.
 */
import { benchRunMetadata, type BenchRunMetadata } from "./_meta";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@gajae-code/agent-core/types";
import type { AssistantMessage, Message, Model, SimpleStreamOptions } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import * as z from "zod/v4";

const WARMUP_ITERATIONS = 20;
const MEASURE_ITERATIONS = 100;
const LARGE_MEASURE_ITERATIONS = 30;
const PACKAGE_NAME = "@gajae-code/agent-core";

type Fixture = {
	name: string;
	textDeltas: number;
	toolCalls: number;
	toolDeltasPerCall: number;
	abortPhase?: "before-provider" | "after-start" | "after-text" | "during-toolcall";
	abortPhases?: Array<"before-provider" | "after-start" | "after-text" | "during-toolcall">;
	measureIterations?: number;
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

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

function createAssistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		stopReason,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: Date.now(),
	} satisfies AssistantMessage;
}

function createNoopTools(count: number): AgentTool[] {
	const parameters = z.object({ value: z.string() });
	return Array.from({ length: count }, (_, index) => ({
		name: `bench_tool_${index}`,
		label: `Bench tool ${index}`,
		description: "Synthetic benchmark tool.",
		parameters,
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: `ok:${(params as { value: string }).value}` }], details: { ok: true } };
		},
	}));
}

function createContext(toolCount: number): AgentContext {
	return {
		systemPrompt: ["You are a benchmark agent. Execute requested tool calls, then finish."],
		messages: [],
		tools: createNoopTools(toolCount),
	};
}

function createConfig(model: Model, eventCounter?: { providerEvents: number; agentEvents: number }): AgentLoopConfig {
	return {
		model,
		convertToLlm: identityConverter,
		onAssistantMessageEvent() {
			if (eventCounter) eventCounter.providerEvents++;
		},
	};
}

type AbortPhase = NonNullable<Fixture["abortPhase"]>;

function streamFixture(fixture: Fixture) {
	let call = 0;
	return (_model: Model, _context: unknown, options?: SimpleStreamOptions) => {
		const stream = new AssistantMessageEventStream();
		const callIndex = call++;
		queueMicrotask(() => {
			if (options?.signal?.aborted || fixture.abortPhase === "before-provider") {
				return;
			}

			if (callIndex > 0) {
				const done = createAssistantMessage([{ type: "text", text: "done" }], "stop");
				stream.push({ type: "start", partial: done });
				stream.push({ type: "text_start", contentIndex: 0, partial: done });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial: done });
				stream.push({ type: "text_end", contentIndex: 0, content: "done", partial: done });
				stream.push({ type: "done", reason: "stop", message: done });
				return;
			}

			const partial = createAssistantMessage([], fixture.toolCalls > 0 ? "toolUse" : "stop");
			stream.push({ type: "start", partial });
			if (fixture.abortPhase === "after-start") return;

			partial.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: 0, partial });
			for (let i = 0; i < fixture.textDeltas; i++) {
				const delta = `t${i % 10}`;
				(partial.content[0] as { text: string }).text += delta;
				stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
			}
			stream.push({ type: "text_end", contentIndex: 0, content: (partial.content[0] as { text: string }).text, partial });
			if (fixture.abortPhase === "after-text") return;

			for (let i = 0; i < fixture.toolCalls; i++) {
				const contentIndex = partial.content.length;
				const toolCall = { type: "toolCall" as const, id: `tool-${i}`, name: `bench_tool_${i}`, arguments: {} };
				partial.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex, partial });
				let json = "";
				const full = JSON.stringify({ value: `value-${i}` });
				const chunkSize = Math.max(1, Math.ceil(full.length / fixture.toolDeltasPerCall));
				for (let offset = 0; offset < full.length; offset += chunkSize) {
					const delta = full.slice(offset, offset + chunkSize);
					json += delta;
					try {
						toolCall.arguments = JSON.parse(json);
					} catch {
						// Partial JSON is expected while provider tool-call arguments stream.
					}
					stream.push({ type: "toolcall_delta", contentIndex, delta, partial });
					if (fixture.abortPhase === "during-toolcall" && i === Math.floor(fixture.toolCalls / 2)) return;
				}
				toolCall.arguments = JSON.parse(full);
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
			}

			stream.push({ type: "done", reason: fixture.toolCalls > 0 ? "toolUse" : "stop", message: partial });
		});
		return stream;
	};
}

async function runFixtureOnce(fixture: Fixture, model: Model): Promise<{ agentEvents: number; providerEvents: number }> {
	const phases = fixture.abortPhases ?? (fixture.abortPhase ? [fixture.abortPhase] : [undefined]);
	let totalAgentEvents = 0;
	let totalProviderEvents = 0;
	for (const phase of phases) {
		const counts = await runPhaseOnce(fixture, model, phase);
		totalAgentEvents += counts.agentEvents;
		totalProviderEvents += counts.providerEvents;
	}
	return { agentEvents: totalAgentEvents, providerEvents: totalProviderEvents };
}

async function runPhaseOnce(
	fixture: Fixture,
	model: Model,
	abortPhase: AbortPhase | undefined,
): Promise<{ agentEvents: number; providerEvents: number }> {
	const controller = new AbortController();
	const eventCounter = { providerEvents: 0, agentEvents: 0 };
	const config = createConfig(model, eventCounter);
	const context = createContext(fixture.toolCalls);
	const phaseFixture = { ...fixture, abortPhase, abortPhases: undefined };
	const stream = agentLoop(
		[createUserMessage(`run ${fixture.name}${abortPhase ? ` ${abortPhase}` : ""}`)],
		context,
		config,
		controller.signal,
		streamFixture(phaseFixture),
	);

	if (abortPhase === "before-provider") controller.abort();

	for await (const event of stream) {
		eventCounter.agentEvents++;
		if (event.type === "message_start" && abortPhase === "after-start") controller.abort();
		if (event.type === "message_update" && abortPhase === "after-text") {
			const update = (event as Extract<AgentEvent, { type: "message_update" }>).assistantMessageEvent;
			if (update.type === "text_end") controller.abort();
		}
		if (event.type === "message_update" && abortPhase === "during-toolcall") {
			const update = (event as Extract<AgentEvent, { type: "message_update" }>).assistantMessageEvent;
			if (update.type === "toolcall_delta") controller.abort();
		}
	}
	await stream.result();
	return eventCounter;
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

async function benchFixture(fixture: Fixture, model: Model): Promise<BenchSample> {
	const measureIterations = fixture.measureIterations ?? MEASURE_ITERATIONS;
	for (let i = 0; i < WARMUP_ITERATIONS; i++) await runFixtureOnce(fixture, model);
	forceGc();
	const before = process.memoryUsage();
	const samples: number[] = [];
	let lastCounts = { providerEvents: 0, agentEvents: 0 };
	for (let i = 0; i < measureIterations; i++) {
		const start = performance.now();
		lastCounts = await runFixtureOnce(fixture, model);
		samples.push(performance.now() - start);
	}
	forceGc();
	const after = process.memoryUsage();
	const summary = summarize(samples);
	return {
		fixture: fixture.name,
		fixtureDimensions: {
			textDeltas: fixture.textDeltas,
			toolCalls: fixture.toolCalls,
			toolDeltasPerCall: fixture.toolDeltasPerCall,
			abortPhase: fixture.abortPhases ? "multiple" : (fixture.abortPhase ?? "none"),
			abortPhaseCount: fixture.abortPhases?.length ?? (fixture.abortPhase ? 1 : 0),
			lastProviderEventsObservedByLoop: lastCounts.providerEvents,
			lastAgentEventsEmitted: lastCounts.agentEvents,
		},
		warmupIterations: WARMUP_ITERATIONS,
		measureIterations,
		samples,
		...summary,
		rssBeforeBytes: before.rss,
		rssAfterBytes: after.rss,
		heapBeforeBytes: before.heapUsed,
		heapAfterBytes: after.heapUsed,
		notes: fixture.notes,
	};
}

const fixtures: Fixture[] = [
	{
		name: "1k-text-deltas-100-toolcalls-partial",
		textDeltas: 1_000,
		toolCalls: 100,
		toolDeltasPerCall: 4,
		notes: ["Real agentLoop drains synthetic provider stream and executes 100 no-op tools before final assistant turn."],
	},
	{
		name: "10k-text-deltas-100-toolcalls-partial",
		textDeltas: 10_000,
		toolCalls: 100,
		toolDeltasPerCall: 4,
		measureIterations: LARGE_MEASURE_ITERATIONS,
		notes: ["Measure iterations scaled down from 100 to 30 for the 10K fixture to keep the benchmark practical."],
	},
	{
		name: "abort-at-multiple-phases",
		textDeltas: 400,
		toolCalls: 20,
		toolDeltasPerCall: 4,
		abortPhases: ["before-provider", "after-start", "after-text", "during-toolcall"],
		notes: ["Separate abort timing fixture runs four abort phases per sample: before provider events, after message_start, after text_end, and during partial tool-call streaming."],
	},
];

const mock = createMockModel();
const samples: BenchSample[] = [];
for (const fixture of fixtures) {
	console.error(`agent-loop-events: ${fixture.name}`);
	const sample = await benchFixture(fixture, mock.model);
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
const rssBeforeBytes = samples[0]?.rssBeforeBytes ?? 0;
const rssAfterBytes = samples.at(-1)?.rssAfterBytes ?? 0;
const heapBeforeBytes = samples[0]?.heapBeforeBytes ?? 0;
const heapAfterBytes = samples.at(-1)?.heapAfterBytes ?? 0;
const output: BenchOutput = {
	schemaVersion: 1,
	command: "bun packages/agent/bench/agent-loop-events.ts",
	package: PACKAGE_NAME,
	bench: "agent-loop-events",
	fixture: "all",
	fixtureDimensions: { fixtureCount: samples.length },
	warmupIterations: aggregateWarmupIterations,
	measureIterations: aggregateMeasureIterations,
	samples: aggregateSamples,
	...aggregate,
	rssBeforeBytes,
	rssAfterBytes,
	heapBeforeBytes,
	heapAfterBytes,
	notes: ["Per-fixture machine-readable rows are in fixtures[].", "Human-readable progress is emitted on stderr; stdout ends with one JSON document.", ...aggregateIterationNotes],
	metadata: await benchRunMetadata(),
	fixtures: samples,
};

console.log(JSON.stringify(output));
