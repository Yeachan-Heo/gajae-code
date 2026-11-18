import { describe, expect, test } from "bun:test";
import { crc32, decodeEventStream, decodeMessage } from "../src/providers/aws-eventstream";
import { encodeFrame, streamFrom } from "./helpers";

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
});
