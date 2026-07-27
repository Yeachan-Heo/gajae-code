// app-server framing: JSONL codec for the codex-compatible wire protocol.
//
// Wire contract (pinned upstream commit 81da9deb, vendored authority at
// protocol-source/vendor/app-server.behavior.json):
//   - the `"jsonrpc":"2.0"` header is OMITTED on the wire
//   - JSON-RPC `id` is `string | integer` (never null on a decoded message)
//   - malformed JSON is dropped + logged with NO wire response
//   - frame-cap / oversize behavior is transport-specific (see APP_SERVER_FRAME_BYTES)
//
// This module is the neutral line codec every transport mode shares. It does NOT
// own transport semantics (WebSocket close codes, HTTP 413, stdin/stdout handles) —
// each transport acceptor decides what to do with the {@link DecodeResult} it emits.

export type JsonRpcId = string | number;

/** A decoded inbound JSON-RPC message (request or notification), or a failure kind. */
export type DecodeResult =
	| { kind: "message"; id: JsonRpcId | undefined; raw: Record<string, unknown> }
	| { kind: "oversize" }
	| { kind: "malformed"; error: unknown };

/**
 * Maximum inbound frame size in bytes. The upstream bundle does not publish a single
 * transport-independent limit, so this is an explicit GJC operational default (tagged
 * GJC-only) with a `--max-frame-bytes` override surface. Per-transport rejection of an
 * oversize frame is NOT this module's concern — see {@link describeOversizeBehavior}.
 */
export const APP_SERVER_FRAME_BYTES_DEFAULT = 4 * 1024 * 1024;

export interface FrameCodecOptions {
	/** Override the default 4MiB cap. Accepts a `--max-frame-bytes` value. */
	maxFrameBytes?: number;
	/** Inject a logger (defaults to console.warn-equivalent no-op to keep the TUI clean). */
	log?: (message: string, extra?: Record<string, unknown>) => void;
}

/**
 * Decode one buffered line. Transport callers are responsible for splitting the byte
 * stream into newline-delimited frames; this function inspects a single line's bytes.
 *
 * Returns:
 *   - `message` when the line parses as a JSON object (the `jsonrpc` field, if present,
 *     is stripped per the wire contract — upstream omits it on the wire, and we tolerate
 *     a client that erroneously includes it).
 *   - `oversize` when the line exceeds the configured cap BEFORE a successful parse —
 *     callers MUST NOT attempt to echo an id from an oversize frame (it is undecoded).
 *   - `malformed` when the line is within the cap but is not valid JSON or not an object —
 *     callers MUST drop it silently and log; there is NO wire response (JSON-RPC cannot
 *     answer a notification, and upstream drops/logs malformed stdin rather than answering).
 */
export function decodeLine(line: Uint8Array, options: FrameCodecOptions = {}): DecodeResult {
	const cap = options.maxFrameBytes ?? APP_SERVER_FRAME_BYTES_DEFAULT;
	const byteLength = line.byteLength;
	if (byteLength > cap) return { kind: "oversize" };
	const text = new TextDecoder().decode(line);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { kind: "malformed", error };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { kind: "malformed", error: new Error("JSON-RPC frame must be a JSON object") };
	}
	const raw = parsed as Record<string, unknown>;
	// Tolerate (and strip) a client that includes the omitted header.
	if (Object.hasOwn(raw, "jsonrpc")) {
		delete raw.jsonrpc;
		// Re-detect: a frame that was ONLY `{"jsonrpc":"2.0"}` is not a valid message.
		if (Object.keys(raw).length === 0) {
			return { kind: "malformed", error: new Error("JSON-RPC frame carried only the omitted jsonrpc header") };
		}
	}
	const id = coerceId(raw.id);
	return { kind: "message", id, raw };
}

/** Coerce a decoded `id` to the wire-legal union, or `undefined` for notifications. */
function coerceId(value: unknown): JsonRpcId | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value)) return value;
	return undefined;
}

/**
 * Per-transport oversize-frame behavior (D1 / D2-F). Three distinct branches, never
 * conflated:
 *   - stdio: discard-to-newline, then emit a single GJC-only -32600 "Invalid Request"
 *     envelope with `id: null` (undecoded) and the `data` key OMITTED. This is a
 *     documented GJC-only policy; upstream drops oversize stdin without answering.
 *   - websocket: library payload limit, then close 1009 (RFC 6455).
 *   - unix: same as websocket (close 1009 over the upgraded connection).
 */
export type TransportKind = "stdio" | "websocket" | "unix";

export interface OversizeBehavior {
	readonly transport: TransportKind;
	/** stdio only: the serialized -32600 envelope to emit (id null, data omitted). */
	readonly gjcStdioEnvelope?: Uint8Array;
	/** websocket/unix only: the WebSocket close code (1009). */
	readonly closeCode?: number;
}

export function describeOversizeBehavior(transport: TransportKind): OversizeBehavior {
	if (transport === "stdio") {
		// GJC-only row: id is null because the frame was never decoded; data key omitted.
		const envelope = JSON.stringify({ id: null, error: { code: -32600, message: "Invalid Request" } });
		return { transport, gjcStdioEnvelope: new TextEncoder().encode(`${envelope}\n`) };
	}
	return { transport, closeCode: 1009 };
}

/** The stdio oversize envelope as a plain object (for assertions). */
export const GJC_STDIO_OVERSIZE_ENVELOPE = {
	id: null,
	error: { code: -32600, message: "Invalid Request" },
};

/**
 * Encode an outbound message, omitting the `jsonrpc` header and trailing newline.
 * Transport callers add framing (newline for stdio, text-frame for ws/unix).
 */
export function encodeMessage(message: Record<string, unknown>): Uint8Array {
	const out: Record<string, unknown> = { ...message };
	if (Object.hasOwn(out, "jsonrpc")) delete out.jsonrpc;
	return new TextEncoder().encode(JSON.stringify(out));
}
