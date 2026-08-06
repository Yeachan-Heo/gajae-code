// app-server HTTP health probes for WebSocket/Unix listeners.
//
// Per the codex protocol:
//   GET /readyz  -> 200 OK once the listener is accepting new connections.
//   GET /healthz -> 200 OK when no Origin header is present.
//   Any request carrying an Origin header -> 403 Forbidden (CSRF protection layer).
//
// These are only served on ws:// and unix:// listeners; stdio has no HTTP layer.

export type HttpRequest = {
	readonly method: string;
	readonly path: string;
	readonly headers: Record<string, string | string[] | undefined>;
};

export type HttpResponse = {
	readonly status: number;
	readonly body: string;
	readonly headers?: Record<string, string>;
};

/** Returns true if the request carries an Origin header (even empty). Per spec, ANY
 * request carrying an Origin header is rejected with 403 (CSRF layer). */
function hasOrigin(req: HttpRequest): boolean {
	const origin = req.headers.origin ?? req.headers.Origin;
	// The header's PRESENCE (even if empty) is what triggers 403.
	return origin !== undefined;
}

/**
 * Handle a health-probe HTTP request. Returns null if the request is not a probe
 * (the caller should continue with the WebSocket upgrade path).
 */
export function handleHealthProbe(req: HttpRequest): HttpResponse | null {
	// Any request with an Origin header gets 403 (CSRF layer).
	if (hasOrigin(req)) {
		return { status: 403, body: "Forbidden" };
	}
	if (req.method === "GET" && req.path === "/readyz") {
		return { status: 200, body: "OK" };
	}
	if (req.method === "GET" && req.path === "/healthz") {
		return { status: 200, body: "OK" };
	}
	return null;
}
