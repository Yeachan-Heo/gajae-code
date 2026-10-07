import { type AddressResolver, guardedPublicFetch } from "../web/insane/url-guard";
import { cancelMCPStream } from "./content-limits";
import type { MCPHttpServerConfig, MCPSseServerConfig } from "./types";

const PLUGIN_MCP_PUBLIC_NETWORK_BOUNDARY: unique symbol = Symbol("plugin-mcp-public-network-boundary");
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const REQUEST_BODY_HEADERS = [
	"content-encoding",
	"content-language",
	"content-length",
	"content-location",
	"content-type",
] as const;

/** Mark an in-memory plugin-bundle remote MCP config for connection-bound public-network enforcement. */
export function bindPluginMcpToPublicNetwork<T extends MCPHttpServerConfig | MCPSseServerConfig>(config: T): T {
	return Object.assign(config, { [PLUGIN_MCP_PUBLIC_NETWORK_BOUNDARY]: true });
}

/** The marker is an internal symbol, so persisted user MCP configs cannot opt into or forge this path. */
export function usesPublicNetworkMcpFetch(config: MCPHttpServerConfig | MCPSseServerConfig): boolean {
	return ("publicNetwork" in config && config.publicNetwork === true) || isPluginMcpPublicNetworkBound(config);
}

export function isPluginMcpPublicNetworkBound(config: MCPHttpServerConfig | MCPSseServerConfig): boolean {
	return (
		(config as MCPHttpServerConfig & { [PLUGIN_MCP_PUBLIC_NETWORK_BOUNDARY]?: boolean })[
			PLUGIN_MCP_PUBLIC_NETWORK_BOUNDARY
		] === true
	);
}

function blocked(reason: string): Error {
	return new Error(`Plugin MCP network request blocked: ${reason}`);
}

function parseHttpsUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw blocked("invalid URL");
	}
	if (url.protocol !== "https:") throw blocked("HTTPS is required");
	return url;
}

function rewritesToGet(status: number, method: string): boolean {
	return (
		((status === 301 || status === 302) && method === "POST") ||
		(status === 303 && method !== "GET" && method !== "HEAD")
	);
}

/**
 * Fetch a plugin-bundle MCP request through a DNS-pinned public address. Every
 * redirect is handled manually and revalidated before the next connection.
 */
export async function fetchPluginMcpRequest(
	rawUrl: string,
	init: BunFetchRequestInit,
	options: { resolver?: AddressResolver; maxRedirects?: number } = {},
): Promise<Response> {
	let currentUrl = parseHttpsUrl(rawUrl);
	let currentInit: BunFetchRequestInit = { ...init };
	const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

	for (let redirectCount = 0; ; redirectCount++) {
		const dial = await guardedPublicFetch(currentUrl.toString(), currentInit, { resolver: options.resolver });
		if (!dial.ok) throw blocked(dial.reason);
		const { response, logicalUrl } = dial;
		if (!REDIRECT_STATUSES.has(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;
		if (redirectCount >= maxRedirects) {
			cancelMCPStream(response.body);
			throw blocked("redirect limit exceeded");
		}

		let nextUrl: URL;
		try {
			nextUrl = parseHttpsUrl(new URL(location, logicalUrl).toString());
		} catch (error) {
			cancelMCPStream(response.body);
			throw error;
		}
		if (logicalUrl.origin !== nextUrl.origin) {
			cancelMCPStream(response.body);
			throw blocked("cross-origin redirects are not allowed");
		}

		const headers = new Headers(currentInit.headers);
		const method = (currentInit.method ?? "GET").toUpperCase();
		if (rewritesToGet(response.status, method)) {
			for (const name of REQUEST_BODY_HEADERS) headers.delete(name);
			currentInit = { ...currentInit, method: "GET", headers, body: undefined };
		} else {
			currentInit = { ...currentInit, headers };
		}
		currentUrl = nextUrl;
		cancelMCPStream(response.body);
	}
}
