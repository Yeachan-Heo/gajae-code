import { benchRunMetadata } from "./_meta";
import { EventStream } from "../src/utils/event-stream";

const WARMUP_ITERATIONS = 20;
const DEFAULT_MEASURE_ITERATIONS = 200;
const FIXTURES = [10_000, 100_000] as const;

type Scenario = "burst-producer-waiting-consumer" | "fail-before-consume" | "complete-before-consume";

interface BenchSample {
	fixture: string;
	scenario: Scenario;
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
}

function forceGc(): void {
	Bun.gc?.(true);
}

function memory() {
	forceGc();
	return process.memoryUsage();
}

function percentile(samples: number[], p: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[index] ?? 0;
}

function commonIterationCount(results: BenchSample[], key: "warmupIterations" | "measureIterations"): number | null {
	const counts = new Set(results.map(result => result[key]));
	return counts.size === 1 ? results[0]?.[key] ?? null : null;
}

async function consumeAll<T>(stream: EventStream<T, T>): Promise<number> {
	let count = 0;
	for await (const _event of stream) count++;
	return count;
}

async function runBurstProducerWaitingConsumer(eventCount: number): Promise<number> {
	const stream = new EventStream<number>(event => event === eventCount - 1, event => event);
	const consumer = consumeAll(stream);
	for (let i = 0; i < eventCount; i++) stream.push(i);
	const consumed = await consumer;
	if (consumed !== eventCount) throw new Error(`Expected ${eventCount} events, consumed ${consumed}`);
	return consumed;
}

async function runFailBeforeConsume(eventCount: number): Promise<number> {
	const stream = new EventStream<number>(event => event === eventCount, event => event);
	for (let i = 0; i < eventCount; i++) stream.push(i);
	const err = new Error("bench failure");
	stream.fail(err);
	let consumed = 0;
	try {
		for await (const _event of stream) consumed++;
	} catch (caught) {
		if (caught !== err) throw caught;
		return consumed;
	}
	throw new Error("Expected stream failure");
}

async function runCompleteBeforeConsume(eventCount: number): Promise<number> {
	const stream = new EventStream<number>(event => event === eventCount - 1, event => event);
	for (let i = 0; i < eventCount; i++) stream.push(i);
	const consumed = await consumeAll(stream);
	if (consumed !== eventCount) throw new Error(`Expected ${eventCount} events, consumed ${consumed}`);
	const result = await stream.result();
	if (result !== eventCount - 1) throw new Error(`Unexpected result ${result}`);
	return consumed;
}

async function runScenario(scenario: Scenario, eventCount: number): Promise<number> {
	if (scenario === "burst-producer-waiting-consumer") return runBurstProducerWaitingConsumer(eventCount);
	if (scenario === "fail-before-consume") return runFailBeforeConsume(eventCount);
	return runCompleteBeforeConsume(eventCount);
}

async function timeScenario(scenario: Scenario, eventCount: number): Promise<number> {
	const start = performance.now();
	await runScenario(scenario, eventCount);
	return performance.now() - start;
}

async function benchScenario(scenario: Scenario, eventCount: number): Promise<BenchSample> {
	for (let i = 0; i < WARMUP_ITERATIONS; i++) await runScenario(scenario, eventCount);

	const notes: string[] = [];
	let measureIterations = DEFAULT_MEASURE_ITERATIONS;
	if (eventCount >= 100_000) {
		const probeMs = await timeScenario(scenario, eventCount);
		if (probeMs > 2_000) {
			measureIterations = Math.max(10, Math.floor((2_000 / probeMs) * DEFAULT_MEASURE_ITERATIONS));
			notes.push(`measureIterations scaled down from ${DEFAULT_MEASURE_ITERATIONS} after ${probeMs.toFixed(2)}ms probe`);
		} else {
			notes.push(`100K probe ${probeMs.toFixed(2)}ms; measureIterations kept at ${DEFAULT_MEASURE_ITERATIONS}`);
		}
	}

	const before = memory();
	const samples: number[] = [];
	for (let i = 0; i < measureIterations; i++) samples.push(await timeScenario(scenario, eventCount));
	const after = memory();
	const medianMs = percentile(samples, 50);
	const eventsPerSecond = medianMs === 0 ? Number.POSITIVE_INFINITY : eventCount / (medianMs / 1_000);
	console.error(
		`event-stream ${scenario} ${eventCount.toLocaleString()} events: median ${medianMs.toFixed(3)}ms (${eventsPerSecond.toFixed(0)} events/sec)`,
	);

	return {
		fixture: `${eventCount}-events`,
		scenario,
		fixtureDimensions: { events: eventCount, eventsPerSecondMedian: Math.round(eventsPerSecond) },
		warmupIterations: WARMUP_ITERATIONS,
		measureIterations,
		samples,
		medianMs,
		p95Ms: percentile(samples, 95),
		p99Ms: percentile(samples, 99),
		rssBeforeBytes: before.rss,
		rssAfterBytes: after.rss,
		heapBeforeBytes: before.heapUsed,
		heapAfterBytes: after.heapUsed,
		notes,
	};
}

const scenarios: Scenario[] = ["burst-producer-waiting-consumer", "fail-before-consume", "complete-before-consume"];
const results: BenchSample[] = [];
for (const fixture of FIXTURES) {
	for (const scenario of scenarios) results.push(await benchScenario(scenario, fixture));
}

const aggregateSamples = results.length === 1 ? (results[0]?.samples ?? []) : null;
const aggregateWarmupIterations = commonIterationCount(results, "warmupIterations");
const aggregateMeasureIterations = commonIterationCount(results, "measureIterations");
const aggregateIterationNotes = [
	aggregateWarmupIterations === null ? "warmupIterations is null because per-scenario rows used heterogeneous warmup counts; see results[].warmupIterations." : undefined,
	aggregateMeasureIterations === null ? "measureIterations is null because per-scenario rows used heterogeneous measure counts; see results[].measureIterations." : undefined,
	aggregateSamples === null ? "samples is null because top-level output aggregates multiple scenario rows; per-row results[].samples are authoritative." : undefined,
].filter((note): note is string => note !== undefined);
const rssBeforeBytes = results[0]?.rssBeforeBytes ?? 0;
const rssAfterBytes = results.at(-1)?.rssAfterBytes ?? 0;
const heapBeforeBytes = results[0]?.heapBeforeBytes ?? 0;
const heapAfterBytes = results.at(-1)?.heapAfterBytes ?? 0;

console.log(
	JSON.stringify(
		{
			schemaVersion: 1,
			command: "bun packages/ai/bench/event-stream.ts",
			package: "@gajae-code/ai",
			bench: "event-stream",
			fixture: "10K-and-100K-event-stream-scenarios",
			fixtureDimensions: { fixtures: [...FIXTURES], scenarios },
			warmupIterations: aggregateWarmupIterations,
			measureIterations: aggregateMeasureIterations,
			samples: aggregateSamples,
			medianMs: aggregateSamples === null ? null : percentile(aggregateSamples, 50),
			p95Ms: aggregateSamples === null ? null : percentile(aggregateSamples, 95),
			p99Ms: aggregateSamples === null ? null : percentile(aggregateSamples, 99),
			rssBeforeBytes,
			rssAfterBytes,
			heapBeforeBytes,
			heapAfterBytes,
			notes: ["samples are per-scenario run durations in milliseconds", ...aggregateIterationNotes, ...results.flatMap(result => result.notes)],
			metadata: await benchRunMetadata(),
			results,
		},
		null,
		2,
	),
);
