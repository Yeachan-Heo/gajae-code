import { cancelMCPStream } from "./content-limits";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const REQUEST_BODY_HEADERS = [
	"content-encoding",
	"content-language",
	"content-length",
	"content-location",
	"content-type",
] as const;

function rewritesToGet(status: number, method: string): boolean {
	return (
		((status === 301 || status === 302) && method === "POST") ||
		(status === 303 && method !== "GET" && method !== "HEAD")
	);
}

/**
 * Follow same-origin MCP redirects only.
 *
 * A cross-origin 307/308 would carry custom credential headers, `Mcp-Session-Id`,
 * and the JSON-RPC body. The first request uses `rawUrl` unchanged so a caller
 * that cannot be parsed (diagnostic redaction) still reaches fetch, but with
 * `redirect: "manual"` so that hop is not followed either.
 */
export async function fetchMcpRespectingOrigin(rawUrl: string, init: BunFetchRequestInit): Promise<Response> {
	let currentUrl: URL;
	try {
		currentUrl = new URL(rawUrl);
	} catch {
		return fetch(rawUrl, { ...init, redirect: "manual" });
	}

	let requestTarget = rawUrl;
	let currentInit: BunFetchRequestInit = { ...init, redirect: "manual" };
	for (let redirectCount = 0; ; redirectCount++) {
		const response = await fetch(requestTarget, currentInit);
		if (!REDIRECT_STATUSES.has(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;
		if (redirectCount >= MAX_REDIRECTS) {
			cancelMCPStream(response.body);
			throw new Error("MCP redirect limit exceeded");
		}

		let nextUrl: URL;
		try {
			nextUrl = new URL(location, currentUrl);
		} catch (error) {
			cancelMCPStream(response.body);
			throw error;
		}
		if (nextUrl.origin !== currentUrl.origin) {
			cancelMCPStream(response.body);
			throw new Error("cross-origin redirects are not allowed");
		}

		const headers = new Headers(currentInit.headers);
		const method = (currentInit.method ?? "GET").toUpperCase();
		if (rewritesToGet(response.status, method)) {
			for (const name of REQUEST_BODY_HEADERS) headers.delete(name);
			currentInit = { ...currentInit, method: "GET", headers, body: undefined, redirect: "manual" };
		} else {
			currentInit = { ...currentInit, headers, redirect: "manual" };
		}
		currentUrl = nextUrl;
		requestTarget = nextUrl.toString();
		cancelMCPStream(response.body);
	}
}
