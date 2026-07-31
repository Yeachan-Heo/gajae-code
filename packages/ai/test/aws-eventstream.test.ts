import { describe, expect, test } from "bun:test";
import { crc32, decodeEventStream, decodeMessage } from "../src/providers/aws-eventstream";

const MAX_PAYLOAD_LEN = 24 * 1024 * 1024;
const MAX_HEADERS_LEN = 128 * 1024;
const MAX_MESSAGE_LEN = MAX_PAYLOAD_LEN + MAX_HEADERS_LEN + 16;

// ---- Frame builder (mirrors @smithy/eventstream-codec but in-process so the
// test owns the bytes). The decoder is the production code; we encode here for
// fixture generation only.

function encodeStringHeader(name: string, value: string): Uint8Array {
	return encodeStringHeaderBytes(name, new TextEncoder().encode(value));
}

function encodeStringHeaderBytes(name: string, valueBytes: Uint8Array): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	if (nameBytes.length > 255) throw new Error("name too long");
	const buf = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(buf.buffer);
	let p = 0;
	view.setUint8(p, nameBytes.length);
	p += 1;
	buf.set(nameBytes, p);
	p += nameBytes.length;
	view.setUint8(p, 7); // string type
	p += 1;
	view.setUint16(p, valueBytes.length, false);
	p += 2;
	buf.set(valueBytes, p);
	return buf;
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerChunks: Uint8Array[] = [];
	for (const name in headers) headerChunks.push(encodeStringHeader(name, headers[name]));
	return encodeFrameBytes(joinBytes(headerChunks), payload);
}

function encodeFrameBytes(headerBytes: Uint8Array, payload: Uint8Array): Uint8Array {
	const total = 4 + 4 + 4 + headerBytes.length + payload.length + 4;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headerBytes.length, false);
	view.setUint32(8, crc32(out.subarray(0, 8)), false);
	out.set(headerBytes, 12);
	out.set(payload, 12 + headerBytes.length);
	updateFrameCrcs(out);
	return out;
}

function joinBytes(chunks: Uint8Array[]): Uint8Array {
	const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function updateFrameCrcs(frame: Uint8Array): void {
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	view.setUint32(frame.length - 4, crc32(frame.subarray(0, frame.length - 4)), false);
}

function encodePrelude(total: number, headersLen: number): Uint8Array {
	const prelude = new Uint8Array(12);
	const view = new DataView(prelude.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headersLen, false);
	view.setUint32(8, crc32(prelude.subarray(0, 8)), false);
	return prelude;
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) controller.enqueue(chunks[i++]);
			else controller.close();
		},
	});
}

async function collect(
	stream: ReadableStream<Uint8Array>,
): Promise<Array<{ headers: Record<string, string>; text: string }>> {
	const out: Array<{ headers: Record<string, string>; text: string }> = [];
	for await (const msg of decodeEventStream(stream)) {
		out.push({ headers: msg.headers, text: new TextDecoder().decode(msg.payload) });
	}
	return out;
}

describe("aws-eventstream", () => {
	test("CRC32 matches known vectors", () => {
		// Standard CRC32 of "123456789" = 0xCBF43926 (zlib/IEEE).
		const bytes = new TextEncoder().encode("123456789");
		expect(crc32(bytes)).toBe(0xcbf43926);
		expect(crc32(new Uint8Array(0))).toBe(0);
	});

	test("decodes a single full-message frame", async () => {
		const payload = new TextEncoder().encode('{"messageStart":{"role":"assistant"}}');
		const frame = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageStart", ":content-type": "application/json" },
			payload,
		);
		const decoded = decodeMessage(frame);
		expect(decoded.headers[":event-type"]).toBe("messageStart");
		expect(new TextDecoder().decode(decoded.payload)).toBe('{"messageStart":{"role":"assistant"}}');

		const collected = await collect(streamFrom([frame]));
		expect(collected).toHaveLength(1);
		expect(collected[0].headers[":message-type"]).toBe("event");
	});

	test("stitches a frame split across two chunks", async () => {
		const payload = new TextEncoder().encode('{"contentBlockDelta":{"delta":{"text":"hi"}}}');
		const frame = encodeFrame({ ":message-type": "event", ":event-type": "contentBlockDelta" }, payload);
		const mid = Math.floor(frame.length / 2);
		const chunks = [frame.subarray(0, mid), frame.subarray(mid)];
		const collected = await collect(streamFrom(chunks.map(c => new Uint8Array(c))));
		expect(collected).toHaveLength(1);
		expect(collected[0].headers[":event-type"]).toBe("contentBlockDelta");
		expect(collected[0].text).toContain('"hi"');
	});

	test("decodes multiple messages packed into one chunk", async () => {
		const a = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageStart" },
			new TextEncoder().encode('{"role":"assistant"}'),
		);
		const b = encodeFrame(
			{ ":message-type": "event", ":event-type": "contentBlockDelta" },
			new TextEncoder().encode('{"x":1}'),
		);
		const c = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageStop" },
			new TextEncoder().encode('{"stopReason":"end_turn"}'),
		);
		const merged = new Uint8Array(a.length + b.length + c.length);
		merged.set(a, 0);
		merged.set(b, a.length);
		merged.set(c, a.length + b.length);

		const collected = await collect(streamFrom([merged]));
		expect(collected.map(x => x.headers[":event-type"])).toEqual([
			"messageStart",
			"contentBlockDelta",
			"messageStop",
		]);
	});

	test("surfaces exception event headers and payload", async () => {
		const payload = new TextEncoder().encode('{"message":"input too long"}');
		const frame = encodeFrame(
			{
				":message-type": "exception",
				":exception-type": "validationException",
				":content-type": "application/json",
			},
			payload,
		);
		const collected = await collect(streamFrom([frame]));
		expect(collected).toHaveLength(1);
		expect(collected[0].headers[":message-type"]).toBe("exception");
		expect(collected[0].headers[":exception-type"]).toBe("validationException");
		expect(collected[0].text).toContain("input too long");
	});

	test("throws on prelude CRC mismatch", () => {
		const frame = encodeFrame({ ":event-type": "x" }, new Uint8Array(0));
		frame[8] ^= 0xff; // flip a byte in the prelude CRC
		expect(() => decodeMessage(frame)).toThrow(/prelude CRC/);
	});

	test("throws on message CRC mismatch", () => {
		const frame = encodeFrame({ ":event-type": "x" }, new TextEncoder().encode("{}"));
		frame[frame.length - 1] ^= 0xff;
		expect(() => decodeMessage(frame)).toThrow(/message CRC/);
	});
	test("stitches one-byte fragmented frames", async () => {
		const frame = encodeFrame({ ":event-type": "contentBlockDelta" }, new TextEncoder().encode('{"text":"hi"}'));
		const collected = await collect(streamFrom(Array.from(frame, byte => Uint8Array.of(byte))));
		expect(collected).toHaveLength(1);
		expect(collected[0].headers[":event-type"]).toBe("contentBlockDelta");
		expect(collected[0].text).toBe('{"text":"hi"}');
	});

	test("rejects an oversized declared message length from the prelude", async () => {
		const prelude = encodePrelude(MAX_MESSAGE_LEN + 1, 0);
		await expect(collect(streamFrom([prelude]))).rejects.toThrow(
			`eventstream: total length ${MAX_MESSAGE_LEN + 1} exceeds maximum ${MAX_MESSAGE_LEN}`,
		);
	});
	test("rejects a frame whose declared payload exceeds the payload limit", async () => {
		const prelude = encodePrelude(MAX_MESSAGE_LEN, 0);
		await expect(collect(streamFrom([prelude]))).rejects.toThrow(
			`eventstream: payload length ${MAX_MESSAGE_LEN - 16} exceeds maximum ${MAX_PAYLOAD_LEN}`,
		);
	});
	test("accepts exact AWS EventStream payload and header limits", () => {
		const headers = joinBytes([
			encodeStringHeaderBytes("a", new Uint8Array(32_767)),
			encodeStringHeaderBytes("b", new Uint8Array(32_767)),
			encodeStringHeaderBytes("c", new Uint8Array(32_767)),
			encodeStringHeaderBytes("d", new Uint8Array(32_751)),
		]);
		expect(headers).toHaveLength(MAX_HEADERS_LEN);

		const decoded = decodeMessage(encodeFrameBytes(headers, new Uint8Array(MAX_PAYLOAD_LEN)));
		expect(decoded.headers.a).toHaveLength(32_767);
		expect(decoded.payload).toHaveLength(MAX_PAYLOAD_LEN);
	});

	test("rejects a malformed prelude before waiting for its declared frame body", async () => {
		const prelude = new Uint8Array(12);
		const view = new DataView(prelude.buffer);
		view.setUint32(0, 16, false);
		view.setUint32(4, 0, false);
		view.setUint32(8, crc32(prelude.subarray(0, 8)) ^ 0xffffffff, false);

		let cancelled = false;
		const source = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					controller.enqueue(prelude);
				},
				pull() {
					return new Promise<void>(() => {});
				},
				cancel() {
					cancelled = true;
				},
			},
			{ highWaterMark: 0 },
		);

		await expect(collect(source)).rejects.toThrow("eventstream: prelude CRC mismatch");
		expect(cancelled).toBe(true);
	});

	test("rejects an oversized declared header length from the prelude", async () => {
		const prelude = encodePrelude(MAX_MESSAGE_LEN, MAX_HEADERS_LEN + 1);
		await expect(collect(streamFrom([prelude]))).rejects.toThrow(
			"eventstream: header length 131073 exceeds maximum 131072",
		);
	});
	test("preserves prototype-sensitive header names as own data properties", () => {
		const headers = joinBytes([encodeStringHeader("__proto__", "safe"), encodeStringHeader("constructor", "plain")]);
		const decoded = decodeMessage(encodeFrameBytes(headers, new Uint8Array(0)));

		expect(Object.getPrototypeOf(decoded.headers)).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(decoded.headers, "__proto__")?.value).toBe("safe");
		expect(Object.getOwnPropertyDescriptor(decoded.headers, "constructor")?.value).toBe("plain");
	});

	test("rejects a header block that extends outside the frame", () => {
		const frame = encodeFrame({}, new Uint8Array(0));
		new DataView(frame.buffer).setUint32(4, 1, false);
		updateFrameCrcs(frame);
		expect(() => decodeMessage(frame)).toThrow("eventstream: header length 1 exceeds frame body 0");
	});

	test("rejects duplicate header names", () => {
		const headers = joinBytes([
			encodeStringHeader(":event-type", "first"),
			encodeStringHeader(":event-type", "second"),
		]);
		expect(() => decodeMessage(encodeFrameBytes(headers, new Uint8Array(0)))).toThrow(
			'eventstream: duplicate header ":event-type"',
		);
	});

	test("rejects truncated typed header values", () => {
		const truncatedStringHeader = Uint8Array.from([1, 120, 7, 0, 4, 120]);
		expect(() => decodeMessage(encodeFrameBytes(truncatedStringHeader, new Uint8Array(0)))).toThrow(
			"eventstream: truncated string header value",
		);
	});
	test("rejects out-of-range string and byte-array header lengths", () => {
		const emptyString = Uint8Array.from([1, 120, 7, 0, 0]);
		expect(() => decodeMessage(encodeFrameBytes(emptyString, new Uint8Array(0)))).toThrow(
			"eventstream: string header value length 0 outside 1..32767",
		);

		const oversizedString = encodeStringHeaderBytes("x", new Uint8Array(32_768));
		expect(() => decodeMessage(encodeFrameBytes(oversizedString, new Uint8Array(0)))).toThrow(
			"eventstream: string header value length 32768 outside 1..32767",
		);

		const emptyByteArray = Uint8Array.from([1, 120, 6, 0, 0]);
		expect(() => decodeMessage(encodeFrameBytes(emptyByteArray, new Uint8Array(0)))).toThrow(
			"eventstream: byte array header value length 0 outside 1..32767",
		);
	});

	test("rejects malformed UTF-8 header names and string values", () => {
		const invalidName = Uint8Array.from([1, 0x80, 0]);
		expect(() => decodeMessage(encodeFrameBytes(invalidName, new Uint8Array(0)))).toThrow(
			"eventstream: invalid UTF-8 header name",
		);

		const invalidString = Uint8Array.from([1, 120, 7, 0, 1, 0x80]);
		expect(() => decodeMessage(encodeFrameBytes(invalidString, new Uint8Array(0)))).toThrow(
			"eventstream: invalid UTF-8 string header value",
		);
	});

	test("rejects EOF in the middle of a frame", async () => {
		const frame = encodeFrame({ ":event-type": "x" }, new TextEncoder().encode("payload"));
		await expect(collect(streamFrom([frame.subarray(0, frame.length - 1)]))).rejects.toThrow(
			"eventstream: truncated message at end of stream",
		);
	});

	test("cancels the underlying source before releasing its reader lock on decoder error", async () => {
		const expectedMessage = `eventstream: total length ${MAX_MESSAGE_LEN + 1} exceeds maximum ${MAX_MESSAGE_LEN}`;
		let cancelReason: unknown;
		let lockedDuringCancellation = false;
		let source: ReadableStream<Uint8Array>;
		source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encodePrelude(MAX_MESSAGE_LEN + 1, 0));
			},
			cancel(reason) {
				cancelReason = reason;
				lockedDuringCancellation = source.locked;
			},
		});

		await expect(collect(source)).rejects.toThrow(expectedMessage);
		expect(cancelReason).toBeInstanceOf(Error);
		expect((cancelReason as Error).message).toBe(expectedMessage);
		expect(lockedDuringCancellation).toBe(true);
		expect(source.locked).toBe(false);
	});
});
