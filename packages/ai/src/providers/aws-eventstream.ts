/**
 * `application/vnd.amazon.eventstream` decoder.
 *
 * Wire format (all integers big-endian):
 *
 *   [total length     u32]
 *   [headers length   u32]
 *   [prelude CRC32    u32]   <- CRC over the first 8 bytes
 *   [headers          headers_length]
 *   [payload          total_length - headers_length - 16]
 *   [message CRC32    u32]   <- CRC over the entire message minus the trailing 4 bytes
 *
 * Headers: a sequence of `[name_len u8][name utf8][value_type u8][value …]`.
 * We only need the typed values Bedrock emits (boolean true/false, byte, short,
 * integer, long, byte-array, string, timestamp, uuid). All are surfaced as
 * strings for ease of consumption — Bedrock only sets string-valued headers in
 * practice (`:event-type`, `:message-type`, `:content-type`, `:exception-type`).
 */

const PRELUDE_LEN = 8;
const PRELUDE_CRC_LEN = 4;
const MESSAGE_CRC_LEN = 4;
const HEADER_BLOCK_OFFSET = PRELUDE_LEN + PRELUDE_CRC_LEN;
const MIN_MESSAGE_LEN = HEADER_BLOCK_OFFSET + MESSAGE_CRC_LEN;
// AWS EventStream permits 24 MiB payloads and 128 KiB headers. These
// protocol-compatible bounds prevent an unfinished hostile frame from retaining
// unbounded memory, while rejecting only nonstandard larger messages.
const MAX_PAYLOAD_LEN = 24 * 1024 * 1024;
const MAX_HEADERS_LEN = 128 * 1024;
const MAX_MESSAGE_LEN = MAX_PAYLOAD_LEN + MAX_HEADERS_LEN + MIN_MESSAGE_LEN;
const MAX_VARIABLE_HEADER_VALUE_LEN = 32_767;

function validateFrameLengths(total: number, headersLen?: number): void {
	if (total < MIN_MESSAGE_LEN) throw new Error(`eventstream: total length ${total} below minimum`);
	if (total > MAX_MESSAGE_LEN)
		throw new Error(`eventstream: total length ${total} exceeds maximum ${MAX_MESSAGE_LEN}`);
	if (headersLen === undefined) return;
	if (headersLen > MAX_HEADERS_LEN)
		throw new Error(`eventstream: header length ${headersLen} exceeds maximum ${MAX_HEADERS_LEN}`);
	const payloadLen = total - headersLen - MIN_MESSAGE_LEN;
	if (payloadLen < 0)
		throw new Error(`eventstream: header length ${headersLen} exceeds frame body ${total - MIN_MESSAGE_LEN}`);
	if (payloadLen > MAX_PAYLOAD_LEN)
		throw new Error(`eventstream: payload length ${payloadLen} exceeds maximum ${MAX_PAYLOAD_LEN}`);
}

export interface EventStreamMessage {
	/** Lower-cased copy is *not* applied — Bedrock uses casing like `:event-type` verbatim. */
	headers: Record<string, string>;
	payload: Uint8Array;
}

/** CRC32 (IEEE / zlib polynomial 0xEDB88320), matches `@aws-crypto/crc32`. */
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[i] = c >>> 0;
	}
	return t;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
	let c = (seed ^ 0xffffffff) >>> 0;
	for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
	return (c ^ 0xffffffff) >>> 0;
}

/**
 * Decode a single, fully buffered eventstream message. Throws if the framing is
 * malformed or either CRC mismatches. Used by both `decodeEventStream` (the
 * streaming entry point) and the unit tests, which exercise it with hand-built
 * frames.
 */
export function decodeMessage(frame: Uint8Array): EventStreamMessage {
	if (frame.length < MIN_MESSAGE_LEN) throw new Error("eventstream: frame too short");
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const total = view.getUint32(0, false);
	const headersLen = view.getUint32(4, false);
	validateFrameLengths(total, headersLen);
	if (total !== frame.length) throw new Error(`eventstream: framed length ${total} != buffer ${frame.length}`);
	const preludeCrc = view.getUint32(8, false);
	const computedPreludeCrc = crc32(frame.subarray(0, PRELUDE_LEN));
	if (computedPreludeCrc !== preludeCrc) throw new Error("eventstream: prelude CRC mismatch");
	const msgCrc = view.getUint32(total - MESSAGE_CRC_LEN, false);
	const computedMsgCrc = crc32(frame.subarray(0, total - MESSAGE_CRC_LEN));
	if (computedMsgCrc !== msgCrc) throw new Error("eventstream: message CRC mismatch");

	const headersBytes = frame.subarray(HEADER_BLOCK_OFFSET, HEADER_BLOCK_OFFSET + headersLen);
	const payload = frame.subarray(HEADER_BLOCK_OFFSET + headersLen, total - MESSAGE_CRC_LEN);
	return { headers: parseHeaders(headersBytes), payload };
}

function parseHeaders(buf: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let p = 0;

	const take = (length: number, description: string): Uint8Array => {
		if (length > buf.length - p) throw new Error(`eventstream: truncated ${description}`);
		const value = buf.subarray(p, p + length);
		p += length;
		return value;
	};
	const readInteger = (length: number, description: string): DataView => {
		const bytes = take(length, description);
		return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	};
	const decodeUtf8 = (bytes: Uint8Array, description: string): string => {
		try {
			return decoder.decode(bytes);
		} catch {
			throw new Error(`eventstream: invalid UTF-8 ${description}`);
		}
	};
	const readVariableLength = (description: string): number => {
		const length = readInteger(2, `${description} length`).getUint16(0, false);
		if (length < 1 || length > MAX_VARIABLE_HEADER_VALUE_LEN)
			throw new Error(`eventstream: ${description} length ${length} outside 1..${MAX_VARIABLE_HEADER_VALUE_LEN}`);
		return length;
	};
	const setHeader = (name: string, value: string): void => {
		Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
	};

	while (p < buf.length) {
		const nameLen = view.getUint8(p);
		p += 1;
		if (nameLen === 0) throw new Error("eventstream: empty header name");
		const name = decodeUtf8(take(nameLen, "header name"), "header name");
		if (Object.hasOwn(out, name)) throw new Error(`eventstream: duplicate header "${name}"`);
		if (p >= buf.length) throw new Error("eventstream: truncated header value type");
		const type = view.getUint8(p);
		p += 1;
		switch (type) {
			case 0: // bool true
				setHeader(name, "true");
				break;
			case 1: // bool false
				setHeader(name, "false");
				break;
			case 2: // byte
				setHeader(name, String(readInteger(1, "byte header value").getInt8(0)));
				break;
			case 3: // short
				setHeader(name, String(readInteger(2, "short header value").getInt16(0, false)));
				break;
			case 4: // integer
				setHeader(name, String(readInteger(4, "integer header value").getInt32(0, false)));
				break;
			case 5: // long — surface as decimal string to avoid precision loss
				setHeader(name, bigIntFromBytes(take(8, "long header value")).toString());
				break;
			case 6: {
				// byte array — base64 for safe transport
				const len = readVariableLength("byte array header value");
				setHeader(name, Buffer.from(take(len, "byte array header value")).toString("base64"));
				break;
			}
			case 7: {
				// string
				const len = readVariableLength("string header value");
				setHeader(name, decodeUtf8(take(len, "string header value"), "string header value"));
				break;
			}
			case 8: // timestamp (ms since epoch as i64)
				setHeader(name, new Date(Number(bigIntFromBytes(take(8, "timestamp header value")))).toISOString());
				break;
			case 9: {
				// uuid
				const u = take(16, "uuid header value");
				const hex: string[] = [];
				for (let i = 0; i < 16; i++) hex.push(u[i].toString(16).padStart(2, "0"));
				setHeader(
					name,
					`${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`,
				);
				break;
			}
			default:
				throw new Error(`eventstream: unknown header value type ${type}`);
		}
	}
	return out;
}

function bigIntFromBytes(b: Uint8Array): bigint {
	let v = 0n;
	for (let i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]);
	// sign-extend (two's complement)
	if (b.length === 8 && b[0] & 0x80) v -= 1n << 64n;
	return v;
}

/**
 * Async generator that consumes a `ReadableStream<Uint8Array>` (e.g. a fetch
 * response body) and yields fully-framed messages. Handles arbitrary chunk
 * boundaries: messages may span multiple chunks, and a single chunk may carry
 * many messages.
 */
export async function* decodeEventStream(source: ReadableStream<Uint8Array>): AsyncGenerator<EventStreamMessage> {
	const reader = source.getReader();
	// Keep source chunks until a whole frame is available. This avoids repeated
	// whole-buffer copies under one-byte fragmentation; only split frames copy once.
	const chunks: Uint8Array[] = [];
	let chunkStart = 0;
	let bufferedLength = 0;

	const byteAt = (offset: number): number => {
		for (let i = chunkStart; i < chunks.length; i++) {
			const chunk = chunks[i];
			if (offset < chunk.length) return chunk[offset];
			offset -= chunk.length;
		}
		throw new Error("eventstream: internal buffer underflow");
	};
	const readUint32 = (offset: number): number =>
		(byteAt(offset) * 0x1000000 + (byteAt(offset + 1) << 16) + (byteAt(offset + 2) << 8) + byteAt(offset + 3)) >>> 0;
	const prefix = (length: number): Uint8Array => {
		const first = chunks[chunkStart];
		if (first.length >= length) return first.subarray(0, length);
		const result = new Uint8Array(length);
		let offset = 0;
		for (let i = chunkStart; i < chunks.length; i++) {
			const chunk = chunks[i];
			const copied = Math.min(chunk.length, length - offset);
			result.set(chunk.subarray(0, copied), offset);
			offset += copied;
			if (offset === length) return result;
		}
		throw new Error("eventstream: internal buffer underflow");
	};
	const consume = (length: number): void => {
		bufferedLength -= length;
		while (length > 0) {
			const chunk = chunks[chunkStart];
			if (length < chunk.length) {
				chunks[chunkStart] = chunk.subarray(length);
				if (chunkStart > 1024 && chunkStart * 2 > chunks.length) {
					chunks.splice(0, chunkStart);
					chunkStart = 0;
				}
				return;
			}
			length -= chunk.length;
			chunkStart += 1;
		}
		if (chunkStart > 1024 && chunkStart * 2 > chunks.length) {
			chunks.splice(0, chunkStart);
			chunkStart = 0;
		}
	};

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (value && value.length > 0) {
				chunks.push(value);
				bufferedLength += value.length;
			}

			while (bufferedLength >= 4) {
				const total = readUint32(0);
				validateFrameLengths(total);
				if (bufferedLength < HEADER_BLOCK_OFFSET) break;

				const headersLen = readUint32(4);
				validateFrameLengths(total, headersLen);
				const prelude = prefix(HEADER_BLOCK_OFFSET);
				const preludeCrc = new DataView(prelude.buffer, prelude.byteOffset, prelude.byteLength).getUint32(
					PRELUDE_LEN,
					false,
				);
				if (crc32(prelude.subarray(0, PRELUDE_LEN)) !== preludeCrc)
					throw new Error("eventstream: prelude CRC mismatch");

				if (bufferedLength < total) break;
				const frame = prefix(total);
				const message = decodeMessage(frame);
				consume(total);
				yield message;
			}
			if (done) break;
		}
		if (bufferedLength > 0) throw new Error("eventstream: truncated message at end of stream");
	} catch (error) {
		try {
			await reader.cancel(error);
		} catch {
			// Preserve the framing error if cancellation itself fails.
		}
		throw error;
	} finally {
		reader.releaseLock();
	}
}
