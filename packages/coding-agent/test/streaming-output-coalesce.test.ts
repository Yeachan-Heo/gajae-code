import { describe, expect, test } from "bun:test";
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

	test("default (flag unset) delivers one callback per chunk", async () => {
		let calls = 0;
		await feed(["a", "b", "c"], { onRawChunk: () => (calls += 1) });
		expect(calls).toBe(3);
	});
});
