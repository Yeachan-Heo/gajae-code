/**
 * Public HTTP(S) URL guard for user-supplied web fetch targets.
 *
 * Network-capable URL readers MUST run this guard before the first request and
 * before following any redirect target. It is fail-closed: anything it cannot
 * prove is a public, non-credentialed http/https target is rejected.
 *
 * The vendored insane-search engine performs its own redirects outside the
 * TypeScript fetch path, so its fallback remains opt-in and is guarded before
 * any dependency probe or engine subprocess is spawned.
 */
import * as dns from "node:dns/promises";
import * as net from "node:net";

export interface PublicUrlAccepted {
	ok: true;
	url: URL;
	addresses: string[];
}

export interface PublicUrlRejected {
	ok: false;
	reason: string;
}

export type PublicUrlResult = PublicUrlAccepted | PublicUrlRejected;

/** Resolver seam so tests can inject DNS results without real lookups. */
export type AddressResolver = (hostname: string) => Promise<string[]>;

type ProxyEnvironment = Record<string, string | undefined>;

export type GuardedPublicFetchResult =
	| { ok: true; response: Response; logicalUrl: URL; wireUrl: URL }
	| { ok: false; reason: string; logicalUrl: string };

const defaultResolver: AddressResolver = async hostname => {
	const records = await dns.lookup(hostname, { all: true, verbatim: true });
	return records.map(record => record.address);
};

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "0.0.0.0", ""]);
const PROXY_ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;

export function hasConfiguredProxy(env: ProxyEnvironment): boolean {
	return PROXY_ENV_KEYS.some(key => Boolean(env[key]));
}

async function resolveWithSignal(resolver: AddressResolver, hostname: string, signal?: AbortSignal): Promise<string[]> {
	if (!signal) return resolver(hostname);
	if (signal.aborted) throw signal.reason;
	const { promise, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([resolver(hostname), promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function isBlockedHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return (
		BLOCKED_HOSTNAMES.has(normalized) ||
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized.endsWith(".internal") ||
		normalized.endsWith(".home.arpa")
	);
}

function isPrivateIPv4(address: string): boolean {
	const parts = address.split(".").map(part => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b] = parts;
	return (
		a === 0 || // unspecified / "this network"
		a === 10 || // RFC1918
		a === 127 || // loopback
		(a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
		(a === 169 && b === 254) || // link-local
		(a === 172 && b >= 16 && b <= 31) || // RFC1918
		(a === 192 && b === 0) || // 192.0.0/24 & 192.0.2/24 (documentation/reserved)
		(a === 192 && b === 168) || // RFC1918
		(a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
		(a === 198 && b === 51) || // 198.51.100/24 documentation
		(a === 203 && b === 0) || // 203.0.113/24 documentation
		a >= 224 // multicast (224/4) + reserved (240/4) + broadcast
	);
}

function parseIPv6Bytes(address: string): Uint8Array | undefined {
	let normalized = address.toLowerCase();
	const ipv4Tail = normalized.slice(normalized.lastIndexOf(":") + 1);
	if (ipv4Tail.includes(".")) {
		const parts = ipv4Tail.split(".").map(part => Number.parseInt(part, 10));
		if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return;
		normalized = `${normalized.slice(0, normalized.lastIndexOf(":") + 1)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
	}

	const halves = normalized.split("::");
	if (halves.length > 2) return;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const omitted = 8 - left.length - right.length;
	if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return;
	const words = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
	if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) return;

	const bytes = new Uint8Array(16);
	for (let index = 0; index < words.length; index++) {
		const word = Number.parseInt(words[index], 16);
		bytes[index * 2] = word >> 8;
		bytes[index * 2 + 1] = word & 0xff;
	}
	return bytes;
}

interface IPv6Cidr {
	network: Uint8Array;
	prefixLength: number;
}

function ipv6Cidr(network: string, prefixLength: number): IPv6Cidr {
	const bytes = parseIPv6Bytes(network);
	if (!bytes) throw new Error(`Invalid static IPv6 CIDR: ${network}/${prefixLength}`);
	return { network: bytes, prefixLength };
}

function matchesIPv6Cidr(address: Uint8Array, cidr: IPv6Cidr): boolean {
	const wholeBytes = Math.floor(cidr.prefixLength / 8);
	for (let index = 0; index < wholeBytes; index++) {
		if (address[index] !== cidr.network[index]) return false;
	}
	const remainingBits = cidr.prefixLength % 8;
	if (remainingBits === 0) return true;
	const mask = (0xff << (8 - remainingBits)) & 0xff;
	return (address[wholeBytes] & mask) === (cidr.network[wholeBytes] & mask);
}

const IPV6_GLOBAL_UNICAST = ipv6Cidr("2000::", 3);
const BLOCKED_GLOBAL_IPV6_RANGES = [
	ipv6Cidr("2001::", 23), // IETF protocol assignments
	ipv6Cidr("2001:db8::", 32), // documentation
	ipv6Cidr("2002::", 16), // 6to4
	ipv6Cidr("2620:4f:8000::", 48), // AS112 service
	ipv6Cidr("3ffe::", 16), // returned 6bone range
	ipv6Cidr("3fff::", 20), // documentation
] as const;

function isPrivateIPv6(address: string): boolean {
	const bytes = parseIPv6Bytes(address);
	if (!bytes) return true;
	const isIPv4Mapped = bytes.subarray(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
	if (isIPv4Mapped) return isPrivateIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
	return (
		!matchesIPv6Cidr(bytes, IPV6_GLOBAL_UNICAST) ||
		BLOCKED_GLOBAL_IPV6_RANGES.some(cidr => matchesIPv6Cidr(bytes, cidr))
	);
}

/** True for any address that is not a routable public unicast address. */
export function isPrivateOrSpecialAddress(address: string): boolean {
	const family = net.isIP(address);
	if (family === 4) return isPrivateIPv4(address);
	if (family === 6) return isPrivateIPv6(address);
	return true; // not a recognizable IP -> treat as unsafe
}

/**
 * Validate that `rawUrl` is a public http/https target. Resolves DNS names and
 * rejects any that map to a private/special address. Never throws; returns a
 * discriminated result.
 */
export async function validatePublicHttpUrl(
	rawUrl: string,
	options: { resolver?: AddressResolver; signal?: AbortSignal } = {},
): Promise<PublicUrlResult> {
	const resolver = options.resolver ?? defaultResolver;

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, reason: "invalid URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, reason: `unsupported scheme ${url.protocol}` };
	}
	if (url.username || url.password) {
		return { ok: false, reason: "URL credentials are not allowed" };
	}
	if (isBlockedHostname(url.hostname)) {
		return { ok: false, reason: "localhost or internal host" };
	}

	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const literalFamily = net.isIP(hostname);
	if (literalFamily !== 0) {
		if (isPrivateOrSpecialAddress(hostname)) {
			return { ok: false, reason: "private, loopback, link-local, or reserved IP literal" };
		}
		return { ok: true, url, addresses: [hostname] };
	}

	let addresses: string[];
	try {
		addresses = await resolveWithSignal(resolver, hostname, options.signal);
	} catch {
		if (options.signal?.aborted) return { ok: false, reason: "host resolution aborted" };
		return { ok: false, reason: "host could not be resolved" };
	}
	if (addresses.length === 0) {
		return { ok: false, reason: "host resolved to no addresses" };
	}
	if (addresses.some(isPrivateOrSpecialAddress)) {
		return { ok: false, reason: "host resolves to a private or reserved address" };
	}
	return { ok: true, url, addresses };
}

export async function guardedPublicFetch(
	rawUrl: string,
	init: BunFetchRequestInit = {},
	options: { resolver?: AddressResolver } = {},
): Promise<GuardedPublicFetchResult> {
	if (Object.hasOwn(init, "proxy") || Object.hasOwn(init, "unix") || hasConfiguredProxy(process.env)) {
		return { ok: false, reason: "proxy or Unix-socket routing is not allowed", logicalUrl: rawUrl };
	}

	const signal = init.signal ?? undefined;
	const guard = await validatePublicHttpUrl(rawUrl, { resolver: options.resolver, signal });
	if (signal?.aborted) throw signal.reason;
	if (!guard.ok) return { ok: false, reason: guard.reason, logicalUrl: rawUrl };

	const logicalUrl = guard.url;
	const headers = new Headers(init.headers);
	headers.delete("host");
	headers.set("Host", logicalUrl.host);
	const hostname = logicalUrl.hostname.replace(/^\[|\]$/g, "");
	const tls =
		logicalUrl.protocol === "https:"
			? { rejectUnauthorized: true, ...(net.isIP(hostname) === 0 ? { serverName: hostname } : {}) }
			: undefined;
	let lastError: unknown;
	for (const address of guard.addresses) {
		if (hasConfiguredProxy(process.env)) {
			return { ok: false, reason: "proxy routing appeared during resolution", logicalUrl: rawUrl };
		}
		const wireUrl = new URL(logicalUrl);
		wireUrl.hostname = net.isIP(address) === 6 ? `[${address}]` : address;
		try {
			const response = await fetch(wireUrl, { ...init, headers, redirect: "manual", keepalive: false, tls });
			return { ok: true, response, logicalUrl, wireUrl };
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			lastError = error;
		}
	}
	throw lastError;
}

export async function validatePublicHttpUrlForInsane(
	rawUrl: string,
	options: { resolver?: AddressResolver } = {},
): Promise<PublicUrlResult> {
	return validatePublicHttpUrl(rawUrl, options);
}
