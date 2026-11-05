/** Max characters of a discovery URL the owner will parse. Real records are a loopback origin. */
const HARNESS_ENDPOINT_URL_MAX = 2048;

/**
 * True when `raw` is a loopback `ws:` or `wss:` URL with no userinfo, query, hash,
 * or extra path. Parsing follows the same URL rules the SDK client uses to dial,
 * including surrounding whitespace, a trailing DNS dot, and 127.0.0.0/8 hosts. An over-long string
 * is rejected before parsing.
 */
export function isHarnessLoopbackEndpointUrl(raw: string): boolean {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > HARNESS_ENDPOINT_URL_MAX) return false;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
	const host = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	const parts = host.split(".");
	const ipv4Loopback =
		parts.length === 4 &&
		parts.every(part => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255) &&
		Number(parts[0]) === 127;
	if (host !== "localhost" && host !== "::1" && !ipv4Loopback) return false;
	if (url.username !== "" || url.password !== "") return false;
	if (url.search !== "" || url.hash !== "") return false;
	// An empty "?" or "#" is absent from search and hash after parsing. The origin-only policy still rejects it.
	if (url.href.includes("?") || url.href.includes("#")) return false;
	if (url.pathname !== "/" && url.pathname !== "") return false;
	if (url.port !== "") {
		const port = Number(url.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
	}
	return true;
}
