import * as dns from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { FetchImpl, Provider } from "../types";

/**
 * Transport that reaches a loopback endpoint directly instead of through the
 * ambient `fetch` stack.
 *
 * Bun applies `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` to loopback requests,
 * caches that configuration per process, and offers no per-request bypass, so
 * no check of `process.env` at request time can prove where a loopback request
 * would go. Everything Rapid-MLX sends — `/models` probes, credentials, prompts,
 * tool output — must therefore leave through a socket this process opened
 * itself. The DNS lookup and the connected peer are pinned to loopback
 * addresses, TLS verification stays on, and redirects are never followed (the
 * caller sees the 3xx status).
 */

function parseIpv6Hextets(host: string): number[] | undefined {
	if (net.isIP(host) !== 6) return undefined;
	const doubleColon = host.indexOf("::");
	if (doubleColon !== host.lastIndexOf("::")) return undefined;
	const parseSide = (value: string): number[] | undefined => {
		if (!value) return [];
		const parts = value.split(":");
		if (parts.some(part => !/^[0-9a-f]{1,4}$/i.test(part))) return undefined;
		return parts.map(part => Number.parseInt(part, 16));
	};
	if (doubleColon < 0) {
		const hextets = parseSide(host);
		return hextets?.length === 8 ? hextets : undefined;
	}
	const left = parseSide(host.slice(0, doubleColon));
	const right = parseSide(host.slice(doubleColon + 2));
	if (!left || !right) return undefined;
	const missing = 8 - left.length - right.length;
	if (missing < 1) return undefined;
	return [...left, ...new Array<number>(missing).fill(0), ...right];
}

export function isLoopbackHost(hostname: string): boolean {
	// A fully qualified name may carry the root label (`localhost.`); the URL
	// parser preserves it, and it still resolves to loopback, so normalize it
	// before the literal checks instead of letting it fall through to the ambient
	// proxy-aware `fetch`.
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (host === "localhost") return true;
	if (net.isIP(host) === 4) return host.split(".", 1)[0] === "127";
	const hextets = parseIpv6Hextets(host);
	if (!hextets) return false;
	const isIpv6Loopback = hextets.slice(0, 7).every(part => part === 0) && hextets[7] === 1;
	const isIpv4MappedLoopback =
		hextets.slice(0, 5).every(part => part === 0) && hextets[5] === 0xffff && hextets[6]! >> 8 === 0x7f;
	return isIpv6Loopback || isIpv4MappedLoopback;
}

/** True only for an http(s) URL whose host is a loopback literal or `localhost`. */
export function isLoopbackEndpointUrl(url: URL): boolean {
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	return isLoopbackHost(url.hostname);
}

export interface LoopbackDirectFetchInit {
	method?: string;
	headers?: Record<string, string>;
	body?: Uint8Array;
	signal?: AbortSignal;
}

/** Sockets may report an IPv4-mapped IPv6 peer as `::ffff:127.0.0.1`; fold it back to IPv4. */
function normalizeSocketAddress(address: string): string {
	const normalized = address.toLowerCase();
	if (!normalized.startsWith("::ffff:")) return normalized;
	const tail = normalized.slice("::ffff:".length);
	return net.isIP(tail) === 4 ? tail : normalized;
}

async function resolveLoopbackAddresses(hostname: string, signal?: AbortSignal): Promise<string[]> {
	if (signal?.aborted) throw signal.reason;
	const lookup = dns.lookup(hostname, { all: true, verbatim: true });
	let records: Awaited<typeof lookup>;
	if (signal) {
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			records = await Promise.race([lookup, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
			// A losing lookup must not surface as an unhandled rejection.
			lookup.catch(() => undefined);
		}
	} else {
		records = await lookup;
	}
	const addresses = records
		.map(record => record.address)
		.filter(address => isLoopbackHost(normalizeSocketAddress(address)));
	if (addresses.length === 0) {
		throw new Error("Loopback host did not resolve to a loopback address");
	}
	return addresses;
}

function toResponseHeaders(headers: http.IncomingHttpHeaders): Headers {
	const result = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		result.set(name, Array.isArray(value) ? value.join(", ") : value);
	}
	return result;
}

/** Statuses whose `Response` may not carry a body. */
function isNullBodyStatus(status: number | undefined): boolean {
	return status === 204 || status === 205 || status === 304;
}

/**
 * Send one request to a loopback endpoint over a direct socket and stream the
 * response back.
 *
 * The response body is a live stream, so this serves both buffered `/models`
 * discovery and incremental SSE completions; callers bound or consume it
 * exactly as they would a `fetch` response.
 */
export async function fetchLoopbackDirect(url: URL, init: LoopbackDirectFetchInit = {}): Promise<Response> {
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (!isLoopbackHost(hostname)) {
		throw new Error("Loopback transport requires a loopback host");
	}
	const addresses = net.isIP(hostname) ? [hostname] : await resolveLoopbackAddresses(hostname, init.signal);
	const approved = addresses.map(address => ({ address, family: net.isIP(address) }));
	const lookup: net.LookupFunction = (requestedHostname, lookupOptions, callback) => {
		if (requestedHostname.replace(/^\[|\]$/g, "").toLowerCase() !== hostname.toLowerCase()) {
			callback(Object.assign(new Error("Unexpected loopback host"), { code: "ENOTFOUND" }), "", 0);
			return;
		}
		const requestedFamily =
			lookupOptions.family === "IPv4" ? 4 : lookupOptions.family === "IPv6" ? 6 : (lookupOptions.family ?? 0);
		const matching = approved.filter(record => requestedFamily === 0 || record.family === requestedFamily);
		if (matching.length === 0) {
			callback(Object.assign(new Error("No loopback address for host"), { code: "ENOTFOUND" }), "", 0);
			return;
		}
		if (lookupOptions.all) callback(null, matching);
		else callback(null, matching[0].address, matching[0].family);
	};
	const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
	const requestFn = url.protocol === "https:" ? https.request : http.request;
	const method = init.method ?? "GET";
	const headers: Record<string, string> = { ...init.headers };
	if (init.body && headers["content-length"] === undefined && headers["transfer-encoding"] === undefined) {
		headers["content-length"] = String(init.body.byteLength);
	}
	const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
		const request = requestFn(
			{
				protocol: url.protocol,
				hostname,
				port,
				path: `${url.pathname}${url.search}`,
				method,
				headers,
				agent: false,
				insecureHTTPParser: false,
				lookup,
				signal: init.signal,
				...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
			},
			resolve,
		);
		request.once("error", reject);
		request.end(init.body);
	});
	const peer = response.socket.remoteAddress;
	if (peer === undefined || !isLoopbackHost(normalizeSocketAddress(peer))) {
		response.destroy();
		throw new Error("Loopback peer was not a loopback address");
	}
	const status = response.statusCode ?? 502;
	if (isNullBodyStatus(status)) {
		response.resume();
		return new Response(null, {
			status,
			statusText: response.statusMessage,
			headers: toResponseHeaders(response.headers),
		});
	}
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const finish = (error?: unknown) => {
				if (closed) return;
				closed = true;
				try {
					if (error === undefined) controller.close();
					else controller.error(error);
				} catch {
					// The consumer already cancelled or errored the stream.
				}
			};
			response.on("data", (chunk: Buffer) => {
				if (closed) return;
				try {
					controller.enqueue(new Uint8Array(chunk));
				} catch (error) {
					finish(error);
					response.destroy();
					return;
				}
				if ((controller.desiredSize ?? 1) <= 0) response.pause();
			});
			response.once("end", () => finish());
			response.once("error", error => finish(error));
			response.once("aborted", () => finish(new Error("Loopback response aborted")));
		},
		pull() {
			response.resume();
		},
		cancel() {
			response.destroy();
		},
	});
	return new Response(body, {
		status,
		statusText: response.statusMessage,
		headers: toResponseHeaders(response.headers),
	});
}

async function toBodyBytes(body: NonNullable<RequestInit["body"]>): Promise<Uint8Array> {
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	return new Uint8Array(await new Response(body).arrayBuffer());
}

async function toLoopbackDirectInit(
	request: Request | undefined,
	init: RequestInit | undefined,
): Promise<LoopbackDirectFetchInit> {
	const headers = new Headers(request?.headers);
	for (const [name, value] of new Headers(init?.headers ?? undefined)) headers.set(name, value);
	const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
	let body: Uint8Array | undefined;
	if (init?.body !== undefined && init.body !== null) {
		body = await toBodyBytes(init.body);
	} else if (request && method !== "GET" && method !== "HEAD") {
		body = new Uint8Array(await request.arrayBuffer());
	}
	const signal = init?.signal ?? request?.signal ?? undefined;
	return {
		method,
		headers: Object.fromEntries(headers.entries()),
		...(body ? { body } : {}),
		...(signal ? { signal } : {}),
	};
}

/**
 * Fetch implementation that sends loopback destinations over the direct
 * transport and delegates every other destination to `baseFetch`.
 *
 * This factory decides by destination, so callers must already have selected it
 * for the right provider; see {@link resolveProviderFetch}.
 */
export function createLoopbackDirectFetch(baseFetch: FetchImpl): FetchImpl {
	const directFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : undefined;
		const url = new URL(request ? request.url : String(input));
		if (!isLoopbackEndpointUrl(url)) return baseFetch(input, init);
		return fetchLoopbackDirect(url, await toLoopbackDirectInit(request, init));
	}) as FetchImpl;
	if (baseFetch.preconnect) directFetch.preconnect = baseFetch.preconnect;
	return directFetch;
}

/**
 * Providers whose loopback endpoint contract requires the direct transport.
 *
 * Transport selection is provider identity, never the destination host. Bun
 * applies `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` to loopback requests, so a
 * host-based rule would silently override the proxy configuration that other
 * local runtimes document as their transport knob (vLLM, SGLang, Ollama, or any
 * custom OpenAI-compatible endpoint). Those providers keep the ambient
 * proxy-aware `fetch` and select `NO_PROXY` when they need a direct connection;
 * only Rapid-MLX promises a proxy-isolated loopback socket.
 */
const LOOPBACK_DIRECT_PROVIDERS: ReadonlySet<string> = new Set(["rapid-mlx"]);

export function usesLoopbackDirectTransport(provider: Provider): boolean {
	return LOOPBACK_DIRECT_PROVIDERS.has(provider);
}

/**
 * Resolve the transport an OpenAI-compatible client dials with. A caller-supplied
 * `fetch` always wins because it owns its transport and redirect policy;
 * otherwise Rapid-MLX dials loopback directly and every other provider keeps the
 * ambient proxy-aware `fetch`.
 */
export function resolveProviderFetch(provider: Provider, fetchOverride: FetchImpl | undefined): FetchImpl {
	if (fetchOverride) return fetchOverride;
	return usesLoopbackDirectTransport(provider) ? createLoopbackDirectFetch(fetch) : fetch;
}
