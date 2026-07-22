import { describe, expect, it } from "bun:test";
import { sanitizeText } from "../src/sanitize-text";
import {
	parseJsonlLenient,
	readJsonl,
	readLines,
	readSseEvents,
	readSseJson,
	type ServerSentEvent,
} from "../src/stream";

const encoder = new TextEncoder();

async function runStringTransform(transform: TransformStream<string, string>, chunks: string[]): Promise<string[]> {
	const readable = new ReadableStream<string>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});

	const reader = readable.pipeThrough(transform).getReader();
	const output: string[] = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		output.push(value);
	}
	return output;
}

async function collectAsync<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const output: T[] = [];
	for await (const item of iter) output.push(item);
	return output;
}

describe("sanitizeText", () => {
	it("strips ANSI and normalizes CR", () => {
		const input = "\u001b[31mred\u001b[0m\r\n";
		expect(sanitizeText(input)).toBe("red\n");
	});
});

describe("readLines", () => {
	it("splits lines across chunks without newlines", async () => {
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("alpha\nbe"));
				controller.enqueue(encoder.encode("ta\ngam"));
				controller.enqueue(encoder.encode("ma"));
				controller.close();
			},
		});

		const output: string[] = [];
		const dec = new TextDecoder();
		for await (const line of readLines(readable)) {
			output.push(dec.decode(line));
		}

		expect(output).toEqual(["alpha", "beta", "gamma"]);
	});
});

describe("readJsonl", () => {
	it("parses JSONL across chunk boundaries", async () => {
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"a":1}\n{"b":'));
				controller.enqueue(encoder.encode('2}\n{"c":3}\n'));
				controller.close();
			},
		});

		const output = await collectAsync(readJsonl(readable));
		expect(output).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});

	it("parses trailing line without newline", async () => {
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"z":9}'));
				controller.close();
			},
		});

		const output = await collectAsync(readJsonl(readable));
		expect(output).toEqual([{ z: 9 }]);
	});
});

describe("createSanitizerStream", () => {
	it("sanitizes text chunks", async () => {
		const transform = new TransformStream<string, string>({
			transform(chunk, controller) {
				controller.enqueue(sanitizeText(chunk));
			},
		});
		const output = await runStringTransform(transform, ["\u001b[34mhi\u001b[0m\r\n"]);

		expect(output).toEqual(["hi\n"]);
	});
});

describe("parseJsonlLenient", () => {
	it("parses valid JSONL", () => {
		const result = parseJsonlLenient<{ a: number }>('{"a":1}\n{"a":2}\n{"a":3}\n');
		expect(result).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
	});

	it("skips malformed lines and continues", () => {
		const result = parseJsonlLenient<{ a: number }>('{"a":1}\n{bad json}\n{"a":3}\n');
		expect(result).toEqual([{ a: 1 }, { a: 3 }]);
	});

	it("returns empty array for empty input", () => {
		expect(parseJsonlLenient("")).toEqual([]);
	});

	it("handles input without trailing newline", () => {
		const result = parseJsonlLenient<{ x: number }>('{"x":42}');
		expect(result).toEqual([{ x: 42 }]);
	});
});

describe("readSseJson", () => {
	it("parses data lines and stops at [DONE]", async () => {
		const chunks = [
			encoder.encode('data: {"a":1}\n\n'),
			encoder.encode("event: ping\ndata: \n\n"),
			encoder.encode('data: {"b":2}\r\n\r\n'),
			encoder.encode("data: [DONE]\n\n"),
			encoder.encode('data: {"c":3}\n\n'),
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const output = await collectAsync(readSseJson(stream));
		expect(output).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("reports raw events to diagnostic observers without changing parsed output", async () => {
		const stream = bytesStreamFromChunks([
			encoder.encode('event: message\ndata: {"a":1}\n\n'),
			encoder.encode("event: done\ndata: [DONE]\n\n"),
		]);
		const observed: ServerSentEvent[] = [];

		const output = await collectAsync(readSseJson(stream, undefined, event => observed.push(event)));

		expect(output).toEqual([{ a: 1 }]);
		expect(observed.map(event => event.event)).toEqual(["message", "done"]);
		expect(observed[0].raw).toEqual(["event: message", 'data: {"a":1}']);
	});

	it("flushes a trailing event without the closing blank line", async () => {
		const chunks = [encoder.encode('data: {"c":3}')];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const output = await collectAsync(readSseJson(stream));
		expect(output).toEqual([{ c: 3 }]);
	});

	it("handles data lines split across chunks", async () => {
		const chunks = [encoder.encode('data: {"a"'), encoder.encode(":1}\n\n")];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const output = await collectAsync(readSseJson(stream));
		expect(output).toEqual([{ a: 1 }]);
	});
});

function bytesStreamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

describe("readSseEvents", () => {
	it("applies optional UTF-8 event and stream byte budgets without changing defaults", async () => {
		const payload = encoder.encode("data: \ud55c\n\n");
		await expect(
			collectAsync(readSseEvents(bytesStreamFromChunks([payload]), undefined, { maxEventBytes: payload.length })),
		).resolves.toHaveLength(1);
		await expect(
			collectAsync(
				readSseEvents(bytesStreamFromChunks([payload]), undefined, { maxEventBytes: payload.length - 1 }),
			),
		).rejects.toThrow("SSE event exceeds size limit");
		await expect(
			collectAsync(
				readSseEvents(bytesStreamFromChunks([payload]), undefined, { maxTotalBytes: payload.length - 1 }),
			),
		).rejects.toThrow("SSE stream exceeds size limit");
		await expect(collectAsync(readSseEvents(bytesStreamFromChunks([payload])))).resolves.toHaveLength(1);
	});

	it("rejects an oversized event before buffering split and multi-line data", async () => {
		const chunks = [encoder.encode("data: 12\ndata:"), encoder.encode(" 3456\n\n")];
		await expect(
			collectAsync(readSseEvents(bytesStreamFromChunks(chunks), undefined, { maxEventBytes: 20 })),
		).rejects.toThrow("SSE event exceeds size limit");
	});

	it("dispatches events on blank-line boundaries", async () => {
		const stream = bytesStreamFromChunks([
			encoder.encode('event: message_start\ndata: {"id":1}\n\n'),
			encoder.encode("event: message_stop\ndata: {}\n\n"),
		]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events.map(e => e.event)).toEqual(["message_start", "message_stop"]);
		expect(events.map(e => e.data)).toEqual(['{"id":1}', "{}"]);
	});

	it("joins multiple data: lines with newlines", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: chunk\ndata: line1\ndata: line2\ndata: line3\n\n")]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.event).toBe("chunk");
		expect(evt.data).toBe("line1\nline2\nline3");
	});

	it("skips comment lines but preserves them in raw", async () => {
		const stream = bytesStreamFromChunks([encoder.encode(": keep-alive\nevent: ping\ndata: ok\n\n")]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.event).toBe("ping");
		expect(evt.data).toBe("ok");
		expect(evt.raw).toEqual([": keep-alive", "event: ping", "data: ok"]);
	});

	it("does not carry pure comment keepalives into the next event raw lines", async () => {
		const stream = bytesStreamFromChunks([encoder.encode(": 1\r\n\r\n: 2\r\n\r\nevent: ping\r\ndata: ok\r\n\r\n")]);
		const [evt] = await collectAsync(readSseEvents(stream, undefined, { maxEventBytes: 25 }));
		expect(evt.raw).toEqual(["event: ping", "data: ok"]);
	});

	it("strips a single optional space after the field colon (and only one)", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event:  spaced\ndata:  body\n\n")]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.event).toBe(" spaced");
		expect(evt.data).toBe(" body");
	});

	it("handles CRLF line terminators", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n")]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events.map(e => `${e.event}=${e.data}`)).toEqual(["a=1", "b=2"]);
	});

	it("recovers when a chunk boundary splits inside a field name", async () => {
		const stream = bytesStreamFromChunks([
			encoder.encode("eve"),
			encoder.encode("nt: split\nda"),
			encoder.encode("ta: payload\n\n"),
		]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("split");
		expect(events[0].data).toBe("payload");
	});

	it("recovers when a chunk boundary splits inside a multi-byte UTF-8 sequence", async () => {
		// "héllo" → bytes for 'é' are 0xC3 0xA9; split between them.
		const full = encoder.encode("data: héllo\n\n");
		const split = full.indexOf(0xc3) + 1;
		const stream = bytesStreamFromChunks([full.subarray(0, split), full.subarray(split)]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.data).toBe("héllo");
	});

	it("flushes a pending event even without the trailing blank line", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: trailing\ndata: tail\n")]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events).toEqual([
			{ event: "trailing", data: "tail", raw: ["event: trailing", "data: tail"] },
		] satisfies ServerSentEvent[]);
	});

	it("treats a tail without any newline as a complete final line", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: x\ndata: y")]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("x");
		expect(events[0].data).toBe("y");
	});

	it("survives a one-byte-per-chunk drip feed without quadratic blowup", async () => {
		// The legacy decoder rebuilt the entire string buffer per line and was
		// O(n²) in this case. Should now complete in well under a second.
		const lines: string[] = [];
		for (let i = 0; i < 2000; i++) {
			lines.push(`event: e${i}`, `data: ${i}`, "");
		}
		const payload = encoder.encode(`${lines.join("\n")}\n`);
		const oneByteChunks = Array.from(payload, byte => Uint8Array.of(byte));
		const stream = bytesStreamFromChunks(oneByteChunks);
		const start = performance.now();
		const events = await collectAsync(readSseEvents(stream));
		const elapsed = performance.now() - start;
		expect(events).toHaveLength(2000);
		expect(events[1999].event).toBe("e1999");
		expect(events[1999].data).toBe("1999");
		// Generous bound: the previous quadratic implementation needed >5s here.
		expect(elapsed).toBeLessThan(2000);
	});
});
