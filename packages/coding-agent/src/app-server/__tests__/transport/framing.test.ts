import { expect, test } from "bun:test";
import {
	APP_SERVER_FRAME_BYTES_DEFAULT,
	GJC_STDIO_OVERSIZE_ENVELOPE,
	decodeLine,
	describeOversizeBehavior,
	encodeMessage,
} from "../../transport/framing";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

test("decodeLine: parses a well-formed request, stripping the omitted jsonrpc header", () => {
	const result = decodeLine(enc('{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}'));
	expect(result.kind).toBe("message");
	if (result.kind !== "message") throw new Error("unreachable");
	expect(result.id).toBe(7);
	expect(result.raw.method).toBe("initialize");
	expect("jsonrpc" in result.raw).toBe(false);
});

test("decodeLine: a notification has no id", () => {
	const result = decodeLine(enc('{"method":"initialized"}'));
	expect(result.kind).toBe("message");
	if (result.kind !== "message") throw new Error("unreachable");
	expect(result.id).toBe(undefined);
});

test("decodeLine: string and integer ids are coerced; null/float/non-finite ids become undefined", () => {
	expect((decodeLine(enc('{"id":"a","method":"m"}')) as { id: unknown }).id).toBe("a");
	expect((decodeLine(enc('{"id":42,"method":"m"}')) as { id: unknown }).id).toBe(42);
	// null, fractional, NaN -> treated as a notification (no id)
	expect((decodeLine(enc('{"id":null,"method":"m"}')) as { id: unknown }).id).toBe(undefined);
	expect((decodeLine(enc('{"id":1.5,"method":"m"}')) as { id: unknown }).id).toBe(undefined);
});

test("decodeLine: oversize frames are flagged BEFORE parsing, with no decoded id", () => {
	const huge = "x".repeat(APP_SERVER_FRAME_BYTES_DEFAULT + 1);
	const result = decodeLine(enc(huge));
	expect(result.kind).toBe("oversize");
	// An oversize result must never expose an id (the frame was never decoded).
	expect("id" in result).toBe(false);
});

test("decodeLine: malformed JSON within the cap is flagged malformed (no id, caller drops silently)", () => {
	const result = decodeLine(enc("{not json"));
	expect(result.kind).toBe("malformed");
	expect("id" in result).toBe(false);
});

test("decodeLine: a non-object JSON array is malformed", () => {
	expect(decodeLine(enc("[1,2,3]")).kind).toBe("malformed");
});

test("decodeLine: a frame carrying only the omitted jsonrpc header is malformed", () => {
	expect(decodeLine(enc('{"jsonrpc":"2.0"}')).kind).toBe("malformed");
});

test("describeOversizeBehavior: stdio emits the single GJC-only -32600 envelope with id null and data omitted", () => {
	const behavior = describeOversizeBehavior("stdio");
	expect(behavior.closeCode).toBe(undefined);
	expect(behavior.gjcStdioEnvelope).toBeDefined();
	const envelope = JSON.parse(new TextDecoder().decode(behavior.gjcStdioEnvelope!));
	expect(envelope).toEqual(GJC_STDIO_OVERSIZE_ENVELOPE);
	// id is null (undecoded); data key is ABSENT, never null.
	expect(envelope.id).toBe(null);
	expect("data" in envelope.error).toBe(false);
	expect(envelope.error.code).toBe(-32600);
});

test("describeOversizeBehavior: websocket and unix oversize both close 1009", () => {
	expect(describeOversizeBehavior("websocket").closeCode).toBe(1009);
	expect(describeOversizeBehavior("unix").closeCode).toBe(1009);
	expect(describeOversizeBehavior("websocket").gjcStdioEnvelope).toBe(undefined);
});

test("encodeMessage: omits the jsonrpc header", () => {
	const out = encodeMessage({ jsonrpc: "2.0", id: 1, result: {} });
	const parsed = dec(out) as Record<string, unknown>;
	expect(parsed.id).toBe(1);
	expect("jsonrpc" in parsed).toBe(false);
});
