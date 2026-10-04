import { describe, expect, it } from "bun:test";
import { parseJsonl, readJsonlStream } from "../bench/multisession/jsonl";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
	const values: unknown[] = [];
	for await (const value of readJsonlStream(stream, "test stream")) values.push(value);
	return values;
}

describe("bench strict JSONL", () => {
	it("parses complete documents, with or without a trailing newline and blank lines", () => {
		expect(parseJsonl('{"a":1}\n\n{"b":2}\n', "doc")).toEqual([{ a: 1 }, { b: 2 }]);
		expect(parseJsonl('{"a":1}\n{"b":2}', "doc")).toEqual([{ a: 1 }, { b: 2 }]);
		expect(parseJsonl("", "doc")).toEqual([]);
	});

	it("rejects a malformed line instead of returning the values before it", () => {
		expect(() => parseJsonl('{"a":1}\nnot json\n{"c":3}\n', "events.jsonl")).toThrow("events.jsonl");
	});

	it("rejects a truncated last record", () => {
		expect(() => parseJsonl('{"a":1}\n{"b":', "requests.jsonl")).toThrow("truncated JSONL record");
	});

	it("reassembles records split across stream chunks, including multi-byte characters", async () => {
		const record = '{"text":"가재"}\n';
		const bytes = new TextEncoder().encode(`{"a":1}\n${record}`);
		const encoder = new TextEncoder();
		// Split after the first byte of "가" (a three-byte UTF-8 sequence).
		const split = bytes.indexOf(new TextEncoder().encode("가")[0]!) + 1;
		expect(bytes[split]! & 0xc0).toBe(0x80); // the next chunk starts on a continuation byte
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, split));
				controller.enqueue(bytes.subarray(split));
				controller.enqueue(encoder.encode('{"b"'));
				controller.enqueue(encoder.encode(":2}\n"));
				controller.close();
			},
		});
		expect(await collect(stream)).toEqual([{ a: 1 }, { text: "가재" }, { b: 2 }]);
	});

	it("rejects a stream that ends mid-record or carries a malformed record", async () => {
		await expect(collect(streamOf(['{"a":1}\n', '{"b":']))).rejects.toThrow("truncated JSONL record");
		await expect(collect(streamOf(['{"a":1}\n', "garbage\n"]))).rejects.toThrow("test stream");
	});
});
