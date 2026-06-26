import { lookup } from "node:dns/promises";
import * as path from "node:path";
import { pathIsWithin } from "@gajae-code/utils";
import { GjcPluginLoadError, type GjcPluginMcpManifestEntry } from "./types";

/**
 * Shared MCP security policy applied at BOTH install validation and runtime
 * connect for third-party plugin-bundle MCP servers. Defaults are deny-first:
 * HTTPS only, no private/loopback/link-local/metadata endpoints, stdio confined
 * to the plugin root.
 */

const ALLOWED_HTTP_SCHEMES = new Set(["https:"]);
const ALLOWED_STDIO_LAUNCHERS = new Set(["node", "bun"]);

function fail(message: string): never {
	throw new GjcPluginLoadError("security_policy", message);
}

function ipv4ToOctets(host: string): number[] | null {
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const octets = m.slice(1, 5).map(Number);
	if (octets.some(o => o < 0 || o > 255)) return null;
	return octets;
}

export function isDeniedIpv4(host: string): boolean {
	const o = ipv4ToOctets(host);
	if (!o) return false;
	const [a, b] = o;
	if (a === 127) return true; // loopback 127.0.0.0/8
	if (a === 10) return true; // private 10.0.0.0/8
	if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
	if (a === 192 && b === 168) return true; // private 192.168.0.0/16
	if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (incl 169.254.169.254 metadata)
	if (a === 0) return true; // 0.0.0.0/8 unspecified/this-network
	if (a >= 224) return true; // multicast/reserved 224.0.0.0/4 and 240.0.0.0/4
	return false;
}

/** Expand an IPv6 literal (with optional zone id) to 8 hextets, or null. */
function expandIpv6(host: string): number[] | null {
	let h = host.toLowerCase().replace(/^\[|\]$/g, "");
	const zone = h.indexOf("%");
	if (zone >= 0) h = h.slice(0, zone); // strip zone id (e.g. %eth0 / %25eth0)
	if (!h.includes(":")) return null;
	// Handle embedded dotted IPv4 tail by converting it to two hextets.
	const dotted = h.match(/(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	if (dotted) {
		const octs = ipv4ToOctets(dotted[2] ?? "");
		if (!octs) return null;
		const hi = ((octs[0] << 8) | octs[1]).toString(16);
		const lo = ((octs[2] << 8) | octs[3]).toString(16);
		h = `${dotted[1]}${hi}:${lo}`;
	}
	const parts = h.split("::");
	if (parts.length > 2) return null;
	const head = parts[0] ? parts[0].split(":") : [];
	const tail = parts.length === 2 ? (parts[1] ? parts[1].split(":") : []) : null;
	let groups: string[];
	if (tail === null) {
		groups = head;
	} else {
		const fill = 8 - head.length - tail.length;
		if (fill < 0) return null;
		groups = [...head, ...Array(fill).fill("0"), ...tail];
	}
	if (groups.length !== 8) return null;
	const out: number[] = [];
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
		out.push(Number.parseInt(g, 16));
	}
	return out;
}

export function isDeniedIpv6(host: string): boolean {
	const g = expandIpv6(host);
	if (!g) return false;
	const isZero = (n: number, count: number): boolean => g.slice(0, count).every(x => x === n);
	if (g.every(x => x === 0)) return true; // :: unspecified
	if (isZero(0, 7) && g[7] === 1) return true; // ::1 loopback
	if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
	if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	// IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d -> check embedded v4.
	const mappedFfff = isZero(0, 5) && g[5] === 0xffff;
	const compat = isZero(0, 6) && !(g[6] === 0 && g[7] === 0);
	if (mappedFfff || compat) {
		const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
		if (isDeniedIpv4(v4)) return true;
	}
	return false;
}

function isDeniedHostLiteral(host: string): boolean {
	// Strip trailing dots (FQDN root) so localhost. / foo.localhost. are caught.
	const lowered = host.toLowerCase().replace(/\.+$/, "");
	if (lowered === "localhost" || lowered.endsWith(".localhost")) return true;
	return isDeniedIpv4(lowered) || isDeniedIpv6(host);
}

/**
 * Synchronous URL policy (scheme, credentials, host literal ranges). Used for
 * the primary endpoint and any redirect/token/discovery URL.
 */
export function assertUrlAllowed(rawUrl: string, label = "MCP url"): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return fail(`${label} is not a valid URL: ${rawUrl}`);
	}
	if (!ALLOWED_HTTP_SCHEMES.has(url.protocol)) {
		fail(`${label} scheme not allowed (https only for third-party bundles): ${url.protocol}`);
	}
	if (url.username || url.password) {
		fail(`${label} must not embed credentials`);
	}
	if (!url.hostname) {
		fail(`${label} has no host`);
	}
	if (isDeniedHostLiteral(url.hostname)) {
		fail(`${label} resolves to a denied private/loopback/link-local/metadata host: ${url.hostname}`);
	}
	return url;
}

/** Reject headers with control characters / CRLF injection. */
export function assertHeadersAllowed(headers: Record<string, string> | undefined): void {
	if (!headers) return;
	for (const [key, value] of Object.entries(headers)) {
		if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(value)) {
			fail(`MCP header contains control characters: ${key}`);
		}
	}
}

/**
 * Runtime DNS check: resolve the host and ensure no resolved address falls in a
 * denied range (covers DNS rebinding when re-run before each connect).
 */
export async function assertDnsResolvesPublic(hostname: string, label = "MCP host"): Promise<void> {
	let addrs: { address: string; family: number }[];
	try {
		addrs = await lookup(hostname, { all: true });
	} catch {
		fail(`${label} DNS resolution failed for ${hostname}`);
	}
	for (const { address, family } of addrs) {
		const denied = family === 6 ? isDeniedIpv6(address) : isDeniedIpv4(address);
		if (denied) fail(`${label} resolves to a denied address: ${hostname} -> ${address}`);
	}
}

export interface StdioPolicyContext {
	pluginRoot: string;
}

// Node/Bun flags that can execute or load code outside the bundled script.
const DANGEROUS_LAUNCHER_FLAGS = [
	"-e",
	"--eval",
	"-p",
	"--print",
	"-r",
	"--require",
	"--import",
	"--loader",
	"--experimental-loader",
	"--input-type",
];

/** stdio launcher/path confinement policy. */
export function assertStdioAllowed(entry: GjcPluginMcpManifestEntry, ctx: StdioPolicyContext): void {
	const command = entry.command ?? "";
	if (!command) fail(`MCP "${entry.name}": stdio requires a command`);
	const root = path.resolve(ctx.pluginRoot);
	const base = path.basename(command);
	const isBareLauncher = !command.includes("/") && ALLOWED_STDIO_LAUNCHERS.has(base);
	const isRootConfinedExecutable = command.includes("/") && pathIsWithin(root, path.resolve(root, command));
	// Absolute or relative paths must stay inside the plugin root; bare launchers
	// must be in the allowlist. An absolute /bin/node is rejected (outside root).
	if (!isBareLauncher && !isRootConfinedExecutable) {
		fail(`MCP "${entry.name}": stdio command not allowed: ${command}`);
	}
	const usesNodeLauncher = isBareLauncher || ALLOWED_STDIO_LAUNCHERS.has(base);
	const args = entry.args ?? [];
	// Reject code-eval/loader flags for node/bun launchers.
	if (usesNodeLauncher) {
		for (const arg of args) {
			const flag = arg.split("=")[0];
			if (DANGEROUS_LAUNCHER_FLAGS.includes(flag)) {
				fail(`MCP "${entry.name}": stdio launcher flag not allowed: ${arg}`);
			}
		}
		// Require a root-confined script as the first non-flag argument.
		const firstScript = args.find(a => !a.startsWith("-"));
		if (!firstScript) {
			fail(`MCP "${entry.name}": node/bun stdio launcher requires a bundled script argument`);
		}
		if (!pathIsWithin(root, path.resolve(root, firstScript))) {
			fail(`MCP "${entry.name}": stdio script escapes plugin root: ${firstScript}`);
		}
	}
	// cwd must resolve within the plugin root.
	const cwd = entry.cwd ? path.resolve(root, entry.cwd) : root;
	if (!pathIsWithin(root, cwd) && cwd !== root) {
		fail(`MCP "${entry.name}": stdio cwd escapes plugin root: ${entry.cwd}`);
	}
	// File-like args must resolve within the plugin root; reject env-expansion.
	for (const arg of args) {
		if (/\$\{?[A-Za-z_]/.test(arg) || arg.includes("`") || arg.includes("$(")) {
			fail(`MCP "${entry.name}": stdio arg expansion not allowed: ${arg}`);
		}
		if (arg.startsWith("-")) continue;
		if (!arg.startsWith(".") && !arg.includes("/")) continue;
		const resolvedArg = path.resolve(root, arg);
		if (!pathIsWithin(root, resolvedArg)) {
			fail(`MCP "${entry.name}": stdio arg escapes plugin root: ${arg}`);
		}
	}
}

/**
 * Install-time MCP policy (no network required). Validates scheme/host literals
 * and stdio confinement. Runtime connect additionally calls
 * assertDnsResolvesPublic and re-validates redirect/token URLs.
 */
export function assertMcpInstallPolicy(entry: GjcPluginMcpManifestEntry, ctx: StdioPolicyContext): void {
	if (entry.transport === "stdio") {
		assertStdioAllowed(entry, ctx);
		return;
	}
	if (!entry.url) fail(`MCP "${entry.name}": ${entry.transport} requires a url`);
	assertUrlAllowed(entry.url, `MCP "${entry.name}" url`);
	assertHeadersAllowed(entry.headers);
}
