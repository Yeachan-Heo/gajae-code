import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { readSseEvents, readSseJson } from "../src/stream";

const encoder = new TextEncoder();
function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

describe("SSE CR line endings", () => {
	it("parses lone-CR fields and event boundaries", async () => {
		const payload = encoder.encode('event: message\rdata: {"text":"ok"}\r\r');
		expect(await Array.fromAsync(readSseEvents(stream([payload])))).toEqual([
			{ event: "message", data: '{"text":"ok"}', raw: ["event: message", 'data: {"text":"ok"}'] },
		]);
		expect(await Array.fromAsync(readSseJson(stream([payload])))).toEqual([{ text: "ok" }]);
	});

	it("dispatches at a CR boundary without waiting for another chunk or EOF", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const source = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const events = readSseEvents(source);
		try {
			controller.enqueue(encoder.encode("data: ready\r\r"));
			const next = events.next();
			const result = await Promise.race([next, Bun.sleep(100).then(() => "pending" as const)]);
			expect(result).not.toBe("pending");
			if (result !== "pending") expect(result.value?.data).toBe("ready");
		} finally {
			controller.close();
			await events.return(undefined);
		}
	});

	it("handles every split of CRLF without dispatching an extra blank line", async () => {
		const payload = encoder.encode("event: ping\r\ndata: one\r\ndata: two\r\n\r\ndata: next\r\n\r\n");
		for (let split = 0; split <= payload.length; split++) {
			const events = await Array.fromAsync(
				readSseEvents(stream([payload.subarray(0, split), payload.subarray(split)])),
			);
			expect(events.map(event => [event.event, event.data])).toEqual([
				["ping", "one\ntwo"],
				[null, "next"],
			]);
		}
	});

	it("resets budgets between CR events and rejects an oversized unterminated line", async () => {
		const payload = encoder.encode("data: a\r\rdata: b\r\r");
		await expect(
			Array.fromAsync(readSseEvents(stream([payload]), undefined, { maxEventBytes: 9 })),
		).resolves.toHaveLength(2);
		await expect(
			Array.fromAsync(readSseEvents(stream([encoder.encode("data: too long")]), undefined, { maxEventBytes: 5 })),
		).rejects.toThrow("SSE event exceeds size limit");
		await expect(
			Array.fromAsync(readSseEvents(stream([payload]), undefined, { maxTotalBytes: payload.length - 1 })),
		).rejects.toThrow("SSE stream exceeds size limit");
	});

	it("preserves raw-byte event budgets for split CRLF boundaries", async () => {
		const payload = encoder.encode("data: 한\r\n\r\n");
		const chunks = Array.from(payload, byte => Uint8Array.of(byte));
		await expect(
			Array.fromAsync(readSseEvents(stream(chunks), undefined, { maxEventBytes: payload.length })),
		).resolves.toHaveLength(1);
		await expect(
			Array.fromAsync(readSseEvents(stream(chunks), undefined, { maxEventBytes: payload.length - 1 })),
		).rejects.toThrow("SSE event exceeds size limit");
	});

	it("property: mixed LF/CR/CRLF framing is chunk-independent, seed 5112027", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.constantFrom("\n", "\r", "\r\n"), { minLength: 8, maxLength: 8 }),
				fc.integer({ min: 1, max: 9 }),
				async (endings, chunkSize) => {
					const lines = [": keepalive", "", "event: ping", "data: 한", "data: two", "", "data: next", ""];
					// Adjacent CR+LF is one terminator, so blank lines use the same
					// terminator as the preceding line to avoid an ambiguous oracle.
					for (const index of [1, 5, 7]) endings[index] = endings[index - 1];
					const payload = encoder.encode(lines.map((line, i) => line + endings[i]).join(""));
					const chunks = [];
					for (let i = 0; i < payload.length; i += chunkSize) chunks.push(payload.subarray(i, i + chunkSize));
					expect(await Array.fromAsync(readSseEvents(stream(chunks)))).toEqual([
						{ event: "ping", data: "한\ntwo", raw: ["event: ping", "data: 한", "data: two"] },
						{ event: null, data: "next", raw: ["data: next"] },
					]);
				},
			),
			{ seed: 5112027, numRuns: 60 },
		);
	});
});

describe("SSE event byte budget delivery order", () => {
	it("never delivers an event that exceeds maxEventBytes, even when the CR of CRLF dispatched first", async () => {
		const payload = encoder.encode("data: 한\r\n\r\n"); // 13 bytes; event through dispatching CR = 12
		// Split so the CR dispatches before the LF arrives (the open-stream case).
		for (const chunks of [
			[payload],
			[payload.subarray(0, 12), payload.subarray(12)],
			[encoder.encode("data: 한\r"), encoder.encode("\n\r"), encoder.encode("\n")],
		]) {
			const delivered: unknown[] = [];
			let error: unknown = null;
			try {
				for await (const event of readSseEvents(stream(chunks), undefined, { maxEventBytes: 12 })) {
					delivered.push(event);
				}
			} catch (err) {
				error = err;
			}
			expect(delivered).toHaveLength(0); // over-budget event must not reach the consumer
			expect((error as Error)?.message).toBe("SSE event exceeds size limit");
		}
	});

	it("accepts lone-CR events at their exact raw-byte budget", async () => {
		const payload = encoder.encode("data: a\r\rdata: b\r\r"); // each event = 9 raw bytes
		const events = await Array.fromAsync(readSseEvents(stream([payload]), undefined, { maxEventBytes: 9 }));
		expect(events.map(event => event.data)).toEqual(["a", "b"]);
	});
});

describe("SSE exact-limit CR streaming", () => {
	it("holds only the ambiguous exact limit, then releases on a non-LF byte", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const source = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const events = readSseEvents(source, undefined, { maxEventBytes: 9 });
		try {
			controller.enqueue(encoder.encode("data: a\r\r"));
			const next = events.next();
			expect(await Promise.race([next, Bun.sleep(20).then(() => "pending")])).toBe("pending");
			// A partial next line is enough to disambiguate, no delimiter needed.
			controller.enqueue(encoder.encode("d"));
			const result = await Promise.race([next, Bun.sleep(100).then(() => "pending" as const)]);
			expect(result).not.toBe("pending");
			if (result !== "pending") expect(result.value?.data).toBe("a");
		} finally {
			controller.close();
			await events.return(undefined);
		}
	});
	it("dispatches immediately with one spare byte of budget", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const source = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const events = readSseEvents(source, undefined, { maxEventBytes: 10 });
		try {
			controller.enqueue(encoder.encode("data: a\r\r"));
			const result = await Promise.race([events.next(), Bun.sleep(100).then(() => "pending" as const)]);
			expect(result).not.toBe("pending");
			if (result !== "pending") expect(result.value?.data).toBe("a");
		} finally {
			controller.close();
			await events.return(undefined);
		}
	});
	it("releases the exact-limit CR event at EOF and discards it on abort", async () => {
		const payload = encoder.encode("data: a\r\r");
		expect(
			(await Array.fromAsync(readSseEvents(stream([payload]), undefined, { maxEventBytes: 9 }))).map(e => e.data),
		).toEqual(["a"]);
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const source = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const abort = new AbortController();
		const events = readSseEvents(source, abort.signal, { maxEventBytes: 9 });
		controller.enqueue(payload);
		const next = events.next();
		expect(await Promise.race([next, Bun.sleep(20).then(() => "pending")])).toBe("pending");
		abort.abort();
		expect(await next).toEqual({ value: undefined, done: true });
	});
});
