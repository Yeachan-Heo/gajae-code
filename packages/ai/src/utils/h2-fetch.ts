/**
 * Patch `globalThis.fetch` to advertise HTTP/2 in TLS ALPN, with transparent
 * HTTP/1.1 fallback when the server doesn't negotiate `h2`.
 *
 * Bun's HTTP/2 client is gated on `BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT`,
 * read by the native runtime before any JS executes; assigning to
 * `process.env` from inside JS is a no-op. Per-request `protocol: "http2"`
 * activates h2 over TLS ALPN and rejects with `error.code === "HTTP2Unsupported"`
 * if the server picks anything else, so we catch and retry without the hint.
 *
 * Some HTTPS endpoints (e.g. corporate API gateways behind reverse proxies)
 * advertise h2 via ALPN but then refuse or reset the connection at the HTTP/2
 * framing layer. Bun surfaces these as `ConnectionRefused`, `ConnectionReset`,
 * `ConnectionClosed`, or `HTTP2StreamReset` rather than `HTTP2Unsupported`.
 * `ConnectionRefused` is raised before the request is written, while
 * `HTTP2RefusedStream` is the explicit HTTP/2 promise that a stream was never
 * processed (including a stream above a graceful GOAWAY last-stream-id).
 * `ConnectionReset`, `ConnectionClosed`, and a generic `HTTP2StreamReset` do
 * not carry that promise: the peer may have consumed the body before the
 * connection failed. Retrying those codes would duplicate non-idempotent side
 * effects, so they preserve the original error instead of falling back.
 *
 * ALPN-refusing hosts (notably zcode.z.ai, the GLM ZCode OAuth broker) abort
 * the TLS handshake entirely when the client offers ALPN h2. Bun reports that
 * abort as `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` even though the host's
 * certificate chain verifies fine over h1 (issue #5178), so that code is a
 * fallback trigger too — never a reason to accept a bad certificate: the h1
 * attempt below performs full verification on its own.
 *
 * Bun negotiates h2 via ALPN over TLS only (no h2c), so plain `http://` URLs
 * skip the attempt entirely — avoids the throw/retry round-trip for localhost.
 *
 * Idempotent.
 */

const installed: unique symbol = Symbol.for("gajae-code.h2fetch.installed");

interface PatchedFetch {
	[installed]?: true;
}

export function installH2Fetch(): void {
	const original = globalThis.fetch as typeof fetch & PatchedFetch;
	if (original[installed]) return;

	/** Error codes that indicate h2 negotiation/transport failure (not an application error). */
	const h2FallbackCodes: ReadonlySet<string> = new Set([
		"HTTP2Unsupported", // Server selected h1 in ALPN
		"ConnectionRefused", // Server refused the h2 connection
		"HTTP2RefusedStream", // REFUSED_STREAM / never-processed h2 stream
		// Bun's h2 client reports an ALPN-refusing host's TLS abort with this
		// code; the h1 fallback below re-verifies the certificate itself.
		"UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
	]);
	const wrapper = async function h2fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (!isHttps(input)) return original(input, init);
		try {
			return await original(input, { ...init, protocol: "http2" });
		} catch (err) {
			const code = (err as { code?: string }).code ?? "";
			if (!h2FallbackCodes.has(code)) throw err;
			if (code === "HTTP2RefusedStream" && !isReplayableRequest(input, init)) throw err;
			return original(input, init);
		}
	} as typeof fetch & PatchedFetch;

	// Preserve `fetch.preconnect` and any other statics SDK code might poke at.
	Object.assign(wrapper, original);
	wrapper[installed] = true;
	globalThis.fetch = wrapper;
}

function isHttps(input: string | URL | Request): boolean {
	if (typeof input === "string") return input.startsWith("https:");
	if (input instanceof URL) return input.protocol === "https:";
	return input.url.startsWith("https:");
}

/**
 * Whether the request body can be handed to fetch a second time. This is only
 * used after `HTTP2RefusedStream`, which proves that the peer did not consume
 * request bytes; a one-shot ReadableStream is still not reusable locally.
 */
function isReplayableRequest(input: string | URL | Request, init?: RequestInit): boolean {
	try {
		if (init?.body !== undefined) return isReplayableBody(init.body);
		if (typeof input === "string" || input instanceof URL) return true;
		// Request bodies are exposed as ReadableStreams. The same Request object
		// cannot be used for the second fetch once the first attempt touched it.
		return input.body === null;
	} catch {
		// Cross-realm or proxy Request objects may throw while exposing their
		// method/body. Do not retry when replayability cannot be established.
		return false;
	}
}

function isReplayableBody(body: BodyInit | null): boolean {
	if (body === null || typeof body === "string") return true;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
	if (typeof Blob !== "undefined" && body instanceof Blob) return true;
	if (typeof FormData !== "undefined" && body instanceof FormData) return true;
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
	return false;
}
