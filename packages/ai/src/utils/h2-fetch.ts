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
 * `ConnectionClosed`, or `HTTP2StreamReset` rather than `HTTP2Unsupported`, so
 * we treat those codes as h2-fallback triggers as well. `ConnectionRefused` is
 * raised before the request is written, but a reset, a close, or a pre-response
 * RST_STREAM does not prove the peer never consumed the body — it may have
 * processed the request and died before answering. Replaying those three on h1
 * would duplicate the side effect, so `ConnectionReset`, `ConnectionClosed`,
 * and `HTTP2StreamReset` fall back only for requests that are provably
 * replay-safe (replay-safe method AND no body); anything else rethrows the
 * original error.
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
		"ConnectionReset", // Server reset during h2 handshake
		"ConnectionClosed", // Server closed before h2 response
		"HTTP2StreamReset", // Server sent RST_STREAM before any h2 response
		// Bun's h2 client reports an ALPN-refusing host's TLS abort with this
		// code; the h1 fallback below re-verifies the certificate itself.
		"UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
	]);
	/** Fallback codes that may fire *after* the peer consumed the body — replay only when safe. */
	const replayGatedCodes: ReadonlySet<string> = new Set(["ConnectionReset", "ConnectionClosed", "HTTP2StreamReset"]);
	const wrapper = async function h2fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (!isHttps(input)) return original(input, init);
		try {
			return await original(input, { ...init, protocol: "http2" });
		} catch (err) {
			const code = (err as { code?: string }).code ?? "";
			if (!h2FallbackCodes.has(code)) throw err;
			if (replayGatedCodes.has(code) && !isReplaySafeRequest(input, init)) throw err;
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
 * Whether replaying this request on a fresh connection is side-effect free:
 * a replay-safe method AND no body. A body is disqualifying even on such a
 * method, because the wrapper cannot prove the stream is still reusable after
 * the failed h2 attempt.
 */
function isReplaySafeRequest(input: string | URL | Request, init?: RequestInit): boolean {
	try {
		const inputIsUrl = typeof input === "object" && input instanceof URL;
		let inputMethod: string | undefined = "GET";
		if (typeof input === "object" && !inputIsUrl) {
			if (!("method" in input) || typeof input.method !== "string") return false;
			inputMethod = input.method;
		}
		const method = init?.method ?? inputMethod;
		if (typeof method !== "string") return false;
		const normalized = method.toUpperCase();
		if (normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS") return false;

		// A body on a Request input remains part of the effective request when
		// init.body is omitted. Treat every non-null body as non-replayable: the
		// wrapper cannot prove that it remains reusable after the failed h2 attempt.
		if (init?.body !== undefined && init.body !== null) return false;
		if (typeof input === "object" && !inputIsUrl) {
			if (!("body" in input) || input.body !== null) return false;
		}
		return true;
	} catch {
		// Cross-realm or proxy Request objects may throw while exposing their
		// method/body. Do not retry when replayability cannot be established.
		return false;
	}
}
