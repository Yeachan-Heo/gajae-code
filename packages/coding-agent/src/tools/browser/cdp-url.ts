const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Require an http(s) CDP URL whose host is loopback. */
export function assertLoopbackCdpUrl(cdpUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(cdpUrl);
	} catch {
		throw new Error(`Refusing non-loopback CDP endpoint: ${cdpUrl}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Refusing non-loopback CDP endpoint: ${cdpUrl}`);
	}
	if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
		throw new Error(`Refusing non-loopback CDP endpoint: ${cdpUrl}`);
	}
	return cdpUrl;
}
