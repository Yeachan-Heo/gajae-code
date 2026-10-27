/**
 * Internal URL parser that handles colons in the host segment.
 *
 * Standard `new URL()` interprets colons as port separators, which breaks
 * namespaced internal URLs like `skill://plugin:name`. This parser extracts
 * components via regex first, then falls back to a minimal URL-like object
 * when `new URL()` fails.
 *
 * All code that parses internal URLs (router, protocol handlers, tools)
 * MUST use this function instead of calling `new URL()` directly.
 */
import type { InternalUrl } from "./types";

const SCHEME_HOST_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const PATHNAME_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i;
// Schemes whose canonical spelling omits the authority slashes. `embedded:` is
// the identifier tools print for bundled (non-filesystem) resources, so both
// `embedded:gjc/...` and `embedded://gjc/...` must route to the same handler.
const SLASHLESS_SCHEMES = new Set(["embedded"]);
const SLASHLESS_SCHEME_RE = /^([a-z][a-z0-9+.-]*):(?!\/\/)(.*)$/is;

/**
 * Canonicalize an internal URL so slashless schemes carry an authority.
 *
 * Every entry point that inspects or routes an internal URL (router,
 * read/write tools, selector splitting) MUST normalize first, so handlers only
 * ever see the `scheme://authority/path` form.
 */
export function normalizeInternalUrlInput(input: string): string {
	const match = input.match(SLASHLESS_SCHEME_RE);
	if (!match) return input;
	if (!SLASHLESS_SCHEMES.has(match[1].toLowerCase())) return input;
	return `${match[1].toLowerCase()}://${match[2]}`;
}

/**
 * Parse an internal URL into an InternalUrl.
 *
 * Handles URLs where `new URL()` would fail (e.g., `skill://plugin:name`
 * where the colon is not a port separator).
 */
export function parseInternalUrl(rawInput: string): InternalUrl {
	const input = normalizeInternalUrlInput(rawInput);
	const hostMatch = input.match(SCHEME_HOST_RE);
	const pathMatch = input.match(PATHNAME_RE);

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		// URL parse failed — build a minimal URL-like object from regex matches.
		if (!hostMatch) {
			throw new Error(`Invalid URL: ${input}`);
		}
		// Extract search and hash from the raw input before constructing the object.
		const hashIdx = input.indexOf("#");
		const hash = hashIdx !== -1 ? input.slice(hashIdx) : "";
		const withoutHash = hashIdx !== -1 ? input.slice(0, hashIdx) : input;
		const queryIdx = withoutHash.indexOf("?");
		const search = queryIdx !== -1 ? withoutHash.slice(queryIdx) : "";
		const queryString = search.slice(1); // strip leading ?

		// Strip search/hash from pathname captured by regex.
		let rawPathname = pathMatch?.[1] ?? "";
		if (queryIdx !== -1 && rawPathname.includes("?")) {
			rawPathname = rawPathname.slice(0, rawPathname.indexOf("?"));
		}

		parsed = {
			protocol: `${hostMatch[1]}:`,
			hostname: hostMatch[2] ?? "",
			host: hostMatch[2] ?? "",
			pathname: rawPathname,
			href: input,
			search,
			hash,
			searchParams: new URLSearchParams(queryString),
		} as unknown as URL;
	}

	let rawHost = hostMatch ? hostMatch[2] : parsed.hostname;
	try {
		rawHost = decodeURIComponent(rawHost);
	} catch {
		// Leave rawHost as-is if decoding fails.
	}

	const result = parsed as InternalUrl;
	result.rawHost = rawHost;
	result.rawPathname = pathMatch?.[1] ?? parsed.pathname;
	return result;
}
