import { describe, expect, test, vi } from "bun:test";
import { OutputSink } from "../src/session/streaming-output";

interface FeedOptions {
	coalesceSanitize?: boolean;
	spillThreshold?: number;
	onRawChunk?: (chunk: string) => void;
}

async function feed(chunks: string[], options: FeedOptions): Promise<string> {
	const sink = new OutputSink(options);
	for (const chunk of chunks) sink.push(chunk);
	return (await sink.dump()).output;
}

describe("output sanitize coalescing (F21, default OFF)", () => {
	test("coalesced output is byte-identical to per-chunk output for clean text (incl. mid-stream flush)", async () => {
		// ~160 KB across 20k tiny chunks, crossing the 64 KB coalesce flush threshold several times.
		const chunks = Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`);
		const big = 16 * 1024 * 1024; // disable truncation so we compare full output
		const perChunk = await feed(chunks, { coalesceSanitize: false, spillThreshold: big });
		const coalesced = await feed(chunks, { coalesceSanitize: true, spillThreshold: big });
		expect(coalesced).toBe(perChunk);
	});

	test("coalescing batches live callbacks while preserving the concatenated sanitized stream", async () => {
		const chunks = Array.from({ length: 1000 }, () => "x");
		let perChunkCalls = 0;
		let perChunkRaw = "";
		await feed(chunks, {
			coalesceSanitize: false,
			onRawChunk: chunk => {
				perChunkCalls += 1;
				perChunkRaw += chunk;
			},
		});
		let coalescedCalls = 0;
		let coalescedRaw = "";
		await feed(chunks, {
			coalesceSanitize: true,
			onRawChunk: chunk => {
				coalescedCalls += 1;
				coalescedRaw += chunk;
			},
		});
		expect(coalescedRaw).toBe(perChunkRaw); // same total sanitized bytes delivered
		expect(perChunkCalls).toBe(1000);
		expect(coalescedCalls).toBeLessThan(perChunkCalls); // batched into far fewer callbacks
	});

	test("throttling preserves coalesced batch callbacks and flushes the final partial batch once", async () => {
		vi.useFakeTimers();
		try {
			const chunks: string[] = [];
			const rawChunks: string[] = [];
			const sink = new OutputSink({
				coalesceSanitize: true,
				chunkThrottleMs: 50,
				spillThreshold: 256 * 1024,
				onChunk: chunk => chunks.push(chunk),
				onRawChunk: chunk => rawChunks.push(chunk),
			});
			const first = "a".repeat(64 * 1024);
			const second = "b".repeat(64 * 1024);
			sink.push(first);
			sink.push(second.slice(0, 32 * 1024));
			expect(chunks).toEqual([first]);
			expect(rawChunks).toEqual([first]);
			sink.push(second.slice(32 * 1024));
			// A full coalescing batch also reaches the live buffer pressure limit.
			expect(chunks).toEqual([first, second]);
			sink.push("\x1b[31mtail\x1b[0m");
			vi.advanceTimersByTime(50);
			// Throttling must not force an early sanitize of the partial raw batch.
			expect(rawChunks).toEqual([first, second]);
			const summary = await sink.dump();
			expect(chunks).toEqual([first, second, "tail"]);
			expect(rawChunks).toEqual(chunks);
			expect(summary.output).toBe(`${first}${second}tail`);
			expect(vi.getTimerCount()).toBe(0);
			await sink.dump();
			vi.advanceTimersByTime(100);
			expect(chunks).toEqual([first, second, "tail"]);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	test("a coalesced callback failure still publishes accepted raw output before dump rejects", async () => {
		vi.useFakeTimers();
		try {
			const failure = new Error("coalesced live callback failed");
			const published: string[] = [];
			const sink = new OutputSink({
				coalesceSanitize: true,
				chunkThrottleMs: 50,
				spillThreshold: 2,
				onChunk: () => {
					throw failure;
				},
				artifactPublisher: async content => {
					published.push(content);
					return { status: "published", artifactId: "coalesced-failed-live" };
				},
			});
			sink.push("\x1b[31mred\x1b[0m");
			sink.push("tail");
			await expect(sink.dump()).rejects.toBe(failure);
			expect(published).toEqual(["\x1b[31mred\x1b[0mtail"]);
			expect(vi.getTimerCount()).toBe(0);
			await expect(sink.dump()).rejects.toBe(failure);
			expect(published).toHaveLength(1);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	test("default (flag unset) delivers one callback per chunk", async () => {
		let calls = 0;
		await feed(["a", "b", "c"], { onRawChunk: () => (calls += 1) });
		expect(calls).toBe(3);
	});
});
