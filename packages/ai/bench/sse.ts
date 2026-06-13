import { benchRunMetadata } from "./_meta";
import { readSseEvents, readSseJson } from "@gajae-code/utils/stream";

const WARMUP_ITERATIONS = 5;
const MEASURE_ITERATIONS = 30;
const BASE_FIXTURES = [10_000, 100_000] as const;
const LARGE_FIXTURES = [1_000_000] as const;
const CHUNK_SIZES = [1, 7, 64, 1024] as const;
const encoder = new TextEncoder();

interface BenchSample {
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

function synthesizeSse(eventCount: number): Uint8Array {
	let text = "";
	for (let i = 0; i < eventCount; i++) {
		if (i % 25 === 0) text += `: keepalive ${i}\n`;
		if (i % 10 === 0) text += "event: delta\n";
		const payload = { index: i, text: `payload-${i}` };
		if (i % 17 === 0) {
			text += `data: {\"index\":${i},\n`;
			text += `data: \"text\":\"payload-${i}\"}\n\n`;
		} else {
			text += `data: ${JSON.stringify(payload)}\n\n`;
		}
	}
	text += "event: malformed\n";
	text += "data: {not-json}\n\n";
	text += "event: partial\n";
	text += "data: {\"partial\":true}";
	return encoder.encode(text);
}

function streamFromBytes(bytes: Uint8Array, chunkSize: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (signal?.aborted) {
				controller.close();
				return;
			}
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			const end = Math.min(bytes.length, offset + chunkSize);
			controller.enqueue(bytes.subarray(offset, end));
			offset = end;
		},
	});
}

async function parseRaw(bytes: Uint8Array, chunkSize: number, abortAtHalf: boolean): Promise<number> {
	const controller = new AbortController();
	let count = 0;
	let bytesDelivered = 0;
	const abortAt = Math.floor(bytes.length / 2);
	try {
		for await (const event of readSseEvents(streamFromBytes(bytes, chunkSize, controller.signal), controller.signal)) {
			count++;
			if (event.data === "") throw new Error("Unexpected empty event");
			bytesDelivered += event.raw.reduce((sum, line) => sum + line.length + 1, 1);
			if (abortAtHalf && bytesDelivered >= abortAt) controller.abort();
		}
	} catch (err) {
		if (!controller.signal.aborted) throw err;
	}
	return count;
}

async function parseJsonUntilMalformed(bytes: Uint8Array, chunkSize: number): Promise<number> {
	let count = 0;
	try {
		for await (const _json of readSseJson<Record<string, unknown>>(streamFromBytes(bytes, chunkSize))) count++;
	} catch (err) {
		if (!(err instanceof SyntaxError)) throw err;
		return count;
	}
	throw new Error("Expected malformed JSON to throw");
}

async function runFixture(bytes: Uint8Array, eventCount: number, chunkSize: number): Promise<number> {
	const rawCount = await parseRaw(bytes, chunkSize, false);
	if (rawCount !== eventCount + 2) throw new Error(`Expected ${eventCount + 2} raw events, got ${rawCount}`);
	const jsonCount = await parseJsonUntilMalformed(bytes, chunkSize);
	if (jsonCount !== eventCount) throw new Error(`Expected ${eventCount} JSON events before malformed frame, got ${jsonCount}`);
	const abortedCount = await parseRaw(bytes, chunkSize, true);
	if (abortedCount <= 0 || abortedCount >= rawCount) throw new Error(`Abort did not stop at 50%: ${abortedCount}/${rawCount}`);
	return rawCount + jsonCount + abortedCount;
}

async function timeFixture(bytes: Uint8Array, eventCount: number, chunkSize: number): Promise<number> {
	const start = performance.now();
	await runFixture(bytes, eventCount, chunkSize);
	return performance.now() - start;
}

async function benchFixture(eventCount: number, chunkSize: number): Promise<BenchSample> {
	const bytes = synthesizeSse(eventCount);
	for (let i = 0; i < WARMUP_ITERATIONS; i++) await runFixture(bytes, eventCount, chunkSize);
	const probeMs = await timeFixture(bytes, eventCount, chunkSize);
	const measureIterations = Math.max(1, Math.min(MEASURE_ITERATIONS, Math.floor(30_000 / Math.max(probeMs, 1))));
	const notes = ["Each sample parses raw SSE, readSseJson through malformed JSON, and abort-at-50% raw SSE."];
	if (measureIterations !== MEASURE_ITERATIONS) {
		notes.push(`measureIterations scaled down from ${MEASURE_ITERATIONS} after ${probeMs.toFixed(2)}ms probe`);
	}
	const before = memory();
	const samples: number[] = [];
	for (let i = 0; i < measureIterations; i++) samples.push(await timeFixture(bytes, eventCount, chunkSize));
	const after = memory();
	const medianMs = percentile(samples, 50);
	console.error(`sse ${eventCount.toLocaleString()} events chunk=${chunkSize}: median ${medianMs.toFixed(3)}ms`);
	return {
		fixture: `${eventCount}-events-chunk-${chunkSize}`,
		fixtureDimensions: {
			events: eventCount,
			bytes: bytes.byteLength,
			chunkSizeBytes: chunkSize,
			keepaliveComments: Math.ceil(eventCount / 25),
			multilineDataFrames: Math.ceil(eventCount / 17),
			eventNameFrames: Math.ceil(eventCount / 10) + 2,
			partialTrailingFrames: 1,
			malformedJsonFrames: 1,
			abortAtPercent: 50,
		},
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

const includeLarge = process.argv.includes("--large");
const fixtures = includeLarge ? [...BASE_FIXTURES, ...LARGE_FIXTURES] : [...BASE_FIXTURES];
const results: BenchSample[] = [];
for (const eventCount of fixtures) {
	for (const chunkSize of CHUNK_SIZES) results.push(await benchFixture(eventCount, chunkSize));
}

const aggregateSamples = results.length === 1 ? (results[0]?.samples ?? []) : null;
const aggregateWarmupIterations = commonIterationCount(results, "warmupIterations");
const aggregateMeasureIterations = commonIterationCount(results, "measureIterations");
const aggregateIterationNotes = [
	aggregateWarmupIterations === null ? "warmupIterations is null because per-fixture rows used heterogeneous warmup counts; see results[].warmupIterations." : undefined,
	aggregateMeasureIterations === null ? "measureIterations is null because per-fixture rows used heterogeneous measure counts; see results[].measureIterations." : undefined,
	aggregateSamples === null ? "samples is null because top-level output aggregates multiple fixture/chunk rows; per-row results[].samples are authoritative." : undefined,
].filter((note): note is string => note !== undefined);
const rssBeforeBytes = results[0]?.rssBeforeBytes ?? 0;
const rssAfterBytes = results.at(-1)?.rssAfterBytes ?? 0;
const heapBeforeBytes = results[0]?.heapBeforeBytes ?? 0;
const heapAfterBytes = results.at(-1)?.heapAfterBytes ?? 0;

console.log(
	JSON.stringify(
		{
			schemaVersion: 1,
			command: includeLarge ? "bun packages/ai/bench/sse.ts --large" : "bun packages/ai/bench/sse.ts",
			package: "@gajae-code/ai",
			bench: "sse",
			fixture: includeLarge ? "10K-100K-1M-sse-byte-streams" : "10K-and-100K-sse-byte-streams",
			fixtureDimensions: { fixtures, chunkSizes: [...CHUNK_SIZES], largeEnabled: includeLarge },
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
			notes: ["1M fixture is available behind --large.", "samples are per fixture/chunk durations in milliseconds", ...aggregateIterationNotes],
			metadata: await benchRunMetadata(),
			results,
		},
		null,
		2,
	),
);
