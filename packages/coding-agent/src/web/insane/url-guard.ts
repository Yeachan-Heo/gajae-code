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

const defaultResolver: AddressResolver = async hostname => {
	const records = await dns.lookup(hostname, { all: true, verbatim: true });
	return records.map(record => record.address);
};

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "0.0.0.0", ""]);

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

function normalizeIPv4MappedIPv6(address: string): string {
	return address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
}

function isPrivateIPv6(address: string): boolean {
	const normalized = address.toLowerCase();
	const mapped = normalizeIPv4MappedIPv6(normalized);
	if (mapped !== normalized && net.isIP(mapped) === 4) return isPrivateIPv4(mapped);
	return (
		normalized === "::" || // unspecified
		normalized === "::1" || // loopback
		normalized.startsWith("fc") || // ULA fc00::/7
		normalized.startsWith("fd") || // ULA
		normalized.startsWith("fe8") || // link-local fe80::/10
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb") ||
		normalized.startsWith("ff") || // multicast ff00::/8
		normalized.startsWith("2001:db8") || // documentation
		normalized.startsWith("::ffff:") // any remaining IPv4-mapped form we could not classify
	);
}

/** True for any address that is not a routable public unicast address. */
export function isPrivateOrSpecialAddress(address: string): boolean {
	const normalized = normalizeIPv4MappedIPv6(address);
	const family = net.isIP(normalized);
	if (family === 4) return isPrivateIPv4(normalized);
	if (family === 6) return isPrivateIPv6(normalized);
	// Re-check the raw value in case it was an IPv4-mapped IPv6 literal.
	if (net.isIP(address) === 6) return isPrivateIPv6(address);
	return true; // not a recognizable IP -> treat as unsafe
}

/**
 * Validate that `rawUrl` is a public http/https target. Resolves DNS names and
 * rejects any that map to a private/special address. Never throws; returns a
 * discriminated result.
 */
export async function validatePublicHttpUrl(
	rawUrl: string,
	options: { resolver?: AddressResolver } = {},
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

	const literalFamily = net.isIP(url.hostname);
	if (literalFamily !== 0) {
		if (isPrivateOrSpecialAddress(url.hostname)) {
			return { ok: false, reason: "private, loopback, link-local, or reserved IP literal" };
		}
		return { ok: true, url, addresses: [url.hostname] };
	}

	let addresses: string[];
	try {
		addresses = await resolver(url.hostname);
	} catch {
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

export async function validatePublicHttpUrlForInsane(
	rawUrl: string,
	options: { resolver?: AddressResolver } = {},
): Promise<PublicUrlResult> {
	return validatePublicHttpUrl(rawUrl, options);
}
