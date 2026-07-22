/**
 * Marketplace catalog fetcher.
 *
 * Classifies a source string, resolves it, and loads the catalog.
 */

import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@gajae-code/utils";
import * as git from "../../../utils/git";
import { isPrivateOrSpecialAddress, validatePublicHttpUrl } from "../../../web/insane/url-guard";

import type { MarketplaceCatalog, MarketplaceSourceType } from "./types";
import { isValidNameSegment } from "./types";

// ── Types ─────────────────────────────────────────────────────────────

export interface FetchResult {
	catalog: MarketplaceCatalog;
	/** For git sources: path to the cloned marketplace directory. */
	clonePath?: string;
}

// ── classifySource ────────────────────────────────────────────────────

/**
 * Detects Windows-style absolute paths cross-platform:
 *   C:\path, C:/path  → drive-letter + colon + separator
 *   \\server\share    → UNC path
 *
 * Needed because path.isAbsolute("C:\...") returns false on POSIX.
 */
const WIN_ABS_RE = /^[A-Za-z]:[/\\]|^\\\\/;

/**
 * GitHub owner/repo shorthand: lowercase alphanumeric + hyphens/dots, one slash.
 * Must NOT start with a protocol — that is ruled out by earlier checks.
 */
const GITHUB_SHORTHAND_RE = /^[a-z0-9-]+\/[a-z0-9._-]+$/i;

/**
 * Classify a marketplace source string into one of the four source types.
 *
 * Rules are ordered; the first match wins. Protocol/pattern checks (rules 1-3)
 * run before any path.isAbsolute() check so that SCP-style git@ URLs are
 * never misclassified as local paths on Windows.
 *
 * @throws if the source format is unrecognized.
 */
export function classifySource(source: string): MarketplaceSourceType {
	// Rule 1: HTTP(S) URLs — .json suffix → url, everything else → git
	if (source.startsWith("https://") || source.startsWith("http://")) {
		try {
			const { pathname } = new URL(source);
			return pathname.endsWith(".json") ? "url" : "git";
		} catch {
			// Malformed URL — treat as git
			return "git";
		}
	}

	// Rule 2: SCP-style SSH git URLs
	if (source.startsWith("git@") || source.startsWith("ssh://")) {
		return "git";
	}

	// Rule 3: GitHub owner/repo shorthand (no protocol, no leading slash)
	if (GITHUB_SHORTHAND_RE.test(source)) {
		return "github";
	}

	// Rule 4: Explicit relative or home-relative paths
	if (source.startsWith("./") || source.startsWith("~/")) {
		return "local";
	}

	// Rule 5: Absolute paths — POSIX via path.isAbsolute, Windows via regex
	if (path.isAbsolute(source) || WIN_ABS_RE.test(source)) {
		return "local";
	}

	throw new Error(`Unrecognized source format. Did you mean './${source}' (local) or 'owner/repo' (GitHub)?`);
}

// ── parseMarketplaceCatalog ───────────────────────────────────────────

function assertField(condition: boolean, field: string, filePath: string): void {
	if (!condition) {
		throw new Error(`Missing or invalid field "${field}" in catalog: ${filePath}`);
	}
}

/**
 * Parse and validate a marketplace.json catalog from raw JSON content.
 *
 * Required fields: name (valid name segment), owner.name, plugins array.
 * Each plugin entry requires name (string) and source (string or object
 * with a "source" field). Extra fields are preserved via spread.
 *
 * @throws on JSON parse failure or missing/invalid required fields.
 */
export function parseMarketplaceCatalog(content: string, filePath: string): MarketplaceCatalog {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch (err) {
		throw new Error(`Failed to parse marketplace catalog at ${filePath}: ${(err as Error).message}`);
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Marketplace catalog at ${filePath} must be a JSON object`);
	}

	const obj = raw as Record<string, unknown>;

	// name: required, must be a valid name segment
	assertField(typeof obj.name === "string" && isValidNameSegment(obj.name), "name", filePath);

	// owner: required object with name string
	assertField(typeof obj.owner === "object" && obj.owner !== null && !Array.isArray(obj.owner), "owner", filePath);
	const owner = obj.owner as Record<string, unknown>;
	assertField(typeof owner.name === "string", "owner.name", filePath);

	// plugins: required array
	assertField(Array.isArray(obj.plugins), "plugins", filePath);

	const plugins = obj.plugins as unknown[];
	const validPlugins: unknown[] = [];
	for (let i = 0; i < plugins.length; i++) {
		try {
			const entry = plugins[i];
			assertField(typeof entry === "object" && entry !== null && !Array.isArray(entry), `plugins[${i}]`, filePath);
			const p = entry as Record<string, unknown>;
			assertField(typeof p.name === "string" && isValidNameSegment(p.name), `plugins[${i}].name`, filePath);
			// source can be a string path or a typed object (github/url/git-subdir/npm)
			// all typed objects carry a "source" discriminant string field
			assertField(
				typeof p.source === "string" ||
					(typeof p.source === "object" &&
						p.source !== null &&
						!Array.isArray(p.source) &&
						typeof (p.source as Record<string, unknown>).source === "string"),
				`plugins[${i}].source`,
				filePath,
			);
			// String sources must be relative paths starting with "./"
			if (typeof p.source === "string") {
				assertField((p.source as string).startsWith("./"), `plugins[${i}].source (must start with "./")`, filePath);
			}
			// Validate required fields for typed source variants
			if (typeof p.source === "object" && p.source !== null) {
				const src = p.source as Record<string, unknown>;
				const variant = src.source as string;
				if (variant === "github") {
					assertField(typeof src.repo === "string" && src.repo.length > 0, `plugins[${i}].source.repo`, filePath);
				} else if (variant === "url" || variant === "git-subdir") {
					assertField(typeof src.url === "string" && src.url.length > 0, `plugins[${i}].source.url`, filePath);
					if (variant === "git-subdir") {
						assertField(
							typeof src.path === "string" && src.path.length > 0,
							`plugins[${i}].source.path`,
							filePath,
						);
					}
				} else if (variant === "npm") {
					assertField(
						typeof src.package === "string" && src.package.length > 0,
						`plugins[${i}].source.package`,
						filePath,
					);
				} else {
					assertField(false, `plugins[${i}].source.source (unknown variant: "${variant}")`, filePath);
				}
			}
			validPlugins.push(entry);
		} catch (err) {
			// Warn and skip invalid plugin entries instead of failing the entire catalog.
			// This lets the rest of the marketplace load even if one entry has a bad name/source.
			const name =
				typeof plugins[i] === "object" && plugins[i] !== null
					? ((plugins[i] as Record<string, unknown>).name ?? `[${i}]`)
					: `[${i}]`;
			logger.warn(`Skipping invalid plugin ${name}: ${(err as Error).message}`);
		}
	}
	// Replace the plugins array with only valid entries
	obj.plugins = validPlugins;

	// Extra fields are preserved — cast through unknown for type safety
	return obj as unknown as MarketplaceCatalog;
}

// ── fetchMarketplace ──────────────────────────────────────────────────

/** Relative path from a marketplace root to its catalog file. */
const CATALOG_RELATIVE_PATH = path.join(".claude-plugin", "marketplace.json");
const URL_FETCH_TIMEOUT_MS = 60_000;
const URL_FETCH_MAX_REDIRECTS = 5;
const URL_FETCH_MAX_HEADER_BYTES = 16 * 1024;
/** Direct JSON catalogs are metadata; 2 MiB leaves ample room without permitting unbounded buffering. */
const URL_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function withAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	const deferred = Promise.withResolvers<T>();
	const abort = () => deferred.reject(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	operation.then(deferred.resolve, deferred.reject).finally(() => signal.removeEventListener("abort", abort));
	return deferred.promise;
}

function normalizePeerAddress(address: string): string {
	const normalized = address.toLowerCase();
	return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}

function normalizeUrlHostname(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

async function validateCatalogUrl(rawUrl: string, signal: AbortSignal) {
	const url = new URL(rawUrl);
	const hostname = normalizeUrlHostname(url.hostname);
	// URL.hostname retains IPv6 brackets in Node/Bun, while net.isIP expects the bare literal.
	if (net.isIP(hostname) === 6) {
		if (url.protocol !== "http:" && url.protocol !== "https:")
			return { ok: false as const, reason: `unsupported scheme ${url.protocol}` };
		if (url.username || url.password) return { ok: false as const, reason: "URL credentials are not allowed" };
		if (isPrivateOrSpecialAddress(hostname))
			return { ok: false as const, reason: "private, loopback, link-local, or reserved IP literal" };
		return { ok: true as const, url, addresses: [hostname] };
	}
	return withAbortSignal(validatePublicHttpUrl(rawUrl), signal);
}

function openCatalogResponse(url: URL, addresses: string[], signal: AbortSignal): Promise<http.IncomingMessage> {
	const hostname = normalizeUrlHostname(url.hostname);
	const approved = addresses.map(address => ({ address, family: net.isIP(address) }));
	const approvedPeers = new Set(approved.map(record => normalizePeerAddress(record.address)));
	const lookup: net.LookupFunction = (requestedHostname, options, callback) => {
		const requestedFamily = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : (options.family ?? 0);
		const matching = approved.filter(record => requestedFamily === 0 || record.family === requestedFamily);
		if (normalizeUrlHostname(requestedHostname) !== hostname || matching.length === 0) {
			const error = Object.assign(new Error("No approved address for marketplace host"), { code: "ENOTFOUND" });
			callback(error, options.all ? [] : "", 0);
			return;
		}
		if (options.all) callback(null, matching);
		else callback(null, matching[0].address, matching[0].family);
	};
	const deferred = Promise.withResolvers<http.IncomingMessage>();
	const options: https.RequestOptions = {
		protocol: url.protocol,
		hostname,
		port: url.port || undefined,
		path: `${url.pathname}${url.search}`,
		method: "GET",
		headers: { Accept: "application/json", "Accept-Encoding": "identity", Connection: "close", Host: url.host },
		agent: false,
		insecureHTTPParser: false,
		lookup,
		maxHeaderSize: URL_FETCH_MAX_HEADER_BYTES,
		signal,
		...(url.protocol === "https:"
			? { rejectUnauthorized: true, servername: net.isIP(hostname) === 0 ? hostname : undefined }
			: {}),
	};
	const requestFn = url.protocol === "https:" ? https.request : http.request;
	const request = requestFn(options, response => {
		const peer = response.socket.remoteAddress;
		if (!peer || isPrivateOrSpecialAddress(peer) || !approvedPeers.has(normalizePeerAddress(peer))) {
			response.destroy();
			deferred.reject(
				new Error(`Refusing marketplace catalog response from unapproved connected peer ${peer ?? "unknown"}`),
			);
			return;
		}
		deferred.resolve(response);
	});
	request.once("error", deferred.reject);
	const abort = () => {
		request.destroy(signal.reason);
		deferred.reject(signal.reason);
	};
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	request.once("close", () => signal.removeEventListener("abort", abort));
	request.end();
	return deferred.promise;
}

async function readCatalogResponse(
	response: http.IncomingMessage,
	source: string,
	signal: AbortSignal,
): Promise<string> {
	const rawContentLengths: string[] = [];
	let hasTransferEncoding = false;
	for (let index = 0; index < response.rawHeaders.length; index += 2) {
		const name = response.rawHeaders[index]?.toLowerCase();
		if (name === "content-length") rawContentLengths.push(response.rawHeaders[index + 1] ?? "");
		if (name === "transfer-encoding") hasTransferEncoding = true;
	}
	if (rawContentLengths.length > 1 || (rawContentLengths.length > 0 && hasTransferEncoding)) {
		response.destroy();
		throw new Error(`Marketplace catalog from ${source} has ambiguous response framing`);
	}
	const contentLength = response.headers["content-length"];
	if (contentLength !== undefined) {
		const declaredBytes =
			typeof contentLength === "string" && /^\d+$/.test(contentLength) ? Number(contentLength) : NaN;
		if (!Number.isSafeInteger(declaredBytes)) {
			response.destroy();
			throw new Error(`Marketplace catalog from ${source} has an invalid Content-Length`);
		}
		if (declaredBytes > URL_FETCH_MAX_BYTES) {
			response.destroy();
			throw new Error(`Marketplace catalog from ${source} exceeds the maximum size of 2 MiB`);
		}
	}

	const abort = () => response.destroy(signal.reason);
	if (signal.aborted) {
		abort();
		throw signal.reason;
	}
	signal.addEventListener("abort", abort, { once: true });
	const chunks: Buffer[] = [];
	let receivedBytes = 0;
	try {
		for await (const chunk of response) {
			const bytes = Buffer.from(chunk);
			receivedBytes += bytes.byteLength;
			if (receivedBytes > URL_FETCH_MAX_BYTES) {
				response.destroy();
				throw new Error(`Marketplace catalog from ${source} exceeds the maximum size of 2 MiB`);
			}
			chunks.push(bytes);
		}
		return Buffer.concat(chunks, receivedBytes).toString("utf8");
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

async function fetchMarketplaceCatalogUrl(source: string): Promise<string> {
	const deadline = AbortSignal.timeout(URL_FETCH_TIMEOUT_MS);
	let currentUrl = source;
	try {
		for (let redirectCount = 0; ; redirectCount++) {
			const guard = await validateCatalogUrl(currentUrl, deadline);
			if (!guard.ok) {
				throw new Error(`Refusing marketplace catalog URL: target URL is not public HTTP(S): ${guard.reason}`);
			}
			const response = await openCatalogResponse(guard.url, guard.addresses, deadline);
			const status = response.statusCode ?? 0;
			if (REDIRECT_STATUSES.has(status)) {
				if (redirectCount >= URL_FETCH_MAX_REDIRECTS) {
					response.destroy();
					throw new Error(`Too many redirects fetching marketplace catalog from ${source}`);
				}
				const location = response.headers.location;
				response.destroy();
				if (!location)
					throw new Error(`Marketplace catalog redirect from ${currentUrl} is missing a Location header`);
				currentUrl = new URL(location, guard.url).toString();
				continue;
			}
			if (status < 200 || status >= 300) {
				response.destroy();
				throw new Error(
					`Failed to fetch marketplace catalog from ${currentUrl}: HTTP ${status} ${response.statusMessage ?? ""}`,
				);
			}
			return await readCatalogResponse(response, currentUrl, deadline);
		}
	} catch (err) {
		if (deadline.aborted) throw new Error(`Timed out fetching marketplace catalog from ${source}`);
		throw err;
	}
}

/**
 * Expand a `~/...` path to an absolute path using os.homedir().
 * Other paths are returned unchanged.
 */
function expandHome(p: string): string {
	if (p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

/**
 * Fetch a marketplace catalog from a source.
 *
 * Dispatches on the source type: local filesystem paths are read directly;
 * GitHub/git sources are cloned with `git`; URL sources are fetched over HTTP.
 *
 * @param source   Source identifier: path, GitHub shorthand, git URL, or HTTP URL.
 * @param cacheDir Cache directory root for non-local sources.
 */
export async function fetchMarketplace(source: string, cacheDir: string): Promise<FetchResult> {
	const type = classifySource(source);

	if (type === "local") {
		const resolved = path.resolve(expandHome(source));
		const catalogPath = path.join(resolved, CATALOG_RELATIVE_PATH);

		let content: string;
		try {
			content = await Bun.file(catalogPath).text();
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(
					`Marketplace catalog not found at "${catalogPath}". ` +
						`Ensure the directory exists and contains a .claude-plugin/marketplace.json file.`,
				);
			}
			throw err;
		}

		const catalog = parseMarketplaceCatalog(content, catalogPath);
		return { catalog };
	}

	if (type === "github") {
		const url = `https://github.com/${source}.git`;
		return cloneAndReadCatalog(url, cacheDir);
	}

	if (type === "git") {
		return cloneAndReadCatalog(source, cacheDir);
	}

	// type === "url"
	const text = await fetchMarketplaceCatalogUrl(source);
	const catalog = parseMarketplaceCatalog(text, source);

	const catalogDir = path.join(cacheDir, catalog.name);
	await Bun.write(path.join(catalogDir, "marketplace.json"), text);

	return { catalog };
}

// ── cloneAndReadCatalog ───────────────────────────────────────────────

/**
 * Clone a git repository and read its marketplace catalog.
 *
 * Clones to a temporary directory and reads the catalog. The caller is
 * responsible for promoting the clone to its final cache location via
 * `promoteCloneToCache` after any duplicate/drift checks pass.
 */
async function cloneAndReadCatalog(url: string, cacheDir: string): Promise<FetchResult> {
	const tmpDir = path.join(cacheDir, `.tmp-clone-${Date.now()}`);
	await fs.mkdir(cacheDir, { recursive: true });

	logger.debug(`[marketplace] cloning ${url} → ${tmpDir}`);
	await git.clone(url, tmpDir);

	const catalogPath = path.join(tmpDir, CATALOG_RELATIVE_PATH);
	let content: string;
	try {
		content = await Bun.file(catalogPath).text();
	} catch (err) {
		await fs.rm(tmpDir, { recursive: true, force: true });
		if (isEnoent(err)) {
			throw new Error(`Cloned repository has no marketplace catalog at ${CATALOG_RELATIVE_PATH}`);
		}
		throw err;
	}

	let catalog: MarketplaceCatalog;
	try {
		catalog = parseMarketplaceCatalog(content, catalogPath);
	} catch (err) {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		throw err;
	}

	return { catalog, clonePath: tmpDir };
}

/**
 * Promote a temporary clone directory to its final cache location.
 *
 * Callers should invoke this only after duplicate/drift checks pass.
 * Removes any existing directory at the target path before renaming.
 */
export async function promoteCloneToCache(tmpDir: string, cacheDir: string, name: string): Promise<string> {
	const finalDir = path.join(cacheDir, name);
	await fs.rm(finalDir, { recursive: true, force: true });
	await fs.rename(tmpDir, finalDir);
	return finalDir;
}
