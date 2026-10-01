/**
 * HTTP/2 fetch installation and management.
 *
 * Activates HTTP/2 for all fetch() calls (provider streams, OAuth, model
 * discovery, web tools). Bun's HTTP/2 client is gated on a startup flag we
 * can't toggle from JS, so we patch globalThis.fetch to pass
 * `protocol: "http2"` per request, with transparent HTTP/1.1 fallback on
 * `HTTP2Unsupported`.
 */

const originalFetch = globalThis.fetch;

/** Install HTTP/2 fetch wrapper with automatic fallback to HTTP/1.1. */
export function installH2Fetch(): void {
	const h2Fetch = async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
		const options = typeof init === "object" && init !== null ? { ...init } : {};

		// First attempt: HTTP/2
		try {
			return await originalFetch(input, { ...options, protocol: "http2" } as RequestInit);
		} catch (error) {
			// Check if this is an HTTP2Unsupported error and retry with HTTP/1.1
			if (error instanceof Error && error.message.includes("HTTP2Unsupported")) {
				return await originalFetch(input, options as RequestInit);
			}
			throw error;
		}
	};

	// Copy preconnect and other properties from original fetch
	Object.defineProperty(h2Fetch, "preconnect", {
		value: (originalFetch as any).preconnect,
		writable: false,
		enumerable: false,
		configurable: false,
	});

	globalThis.fetch = h2Fetch as typeof fetch;
}
