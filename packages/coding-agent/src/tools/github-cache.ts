/**
 * SQLite-backed cache for rendered `github` issue/PR view output, plus a
 * generic cache-aware wrapper that the tool ops and the `issue://`/`pr://`
 * protocol handlers share.
 *
 * Storage:
 *   One process-wide connection opens lazily on first hit and stays open. All
 *   helpers swallow open/IO failures and degrade to "no cache" so a corrupt or
 *   unreadable DB never blocks a `gh` call.
 *
 * TTL:
 *   Soft TTL → return cached row directly.
 *   Past soft TTL but within hard TTL → return cached row AND schedule a
 *     background refresh (errors logged, never thrown).
 *   Past hard TTL → treat as miss and fetch fresh.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGithubCacheDbPath, isCredentialKey, logger, redactCrashSecrets } from "@gajae-code/utils";
import type { Settings } from "../config/settings";
import { parsePrUnifiedDiff, scrubPrDiffText } from "./gh";

// ────────────────────────────────────────────────────────────────────────────
// Storage layer
// ────────────────────────────────────────────────────────────────────────────

export type CacheKind = "issue" | "pr" | "pr-diff";

const DEFAULT_CACHE_AUTH_KEY = "default";

export interface CachedView<T = unknown> {
	authKey: string;
	repo: string;
	kind: CacheKind;
	number: number;
	includeComments: boolean;
	fetchedAt: number;
	payload: T;
	rendered: string;
	sourceUrl: string | undefined;
}

interface Row {
	auth_key: string;
	repo: string;
	kind: CacheKind;
	number: number;
	include_comments: number;
	fetched_at: number;
	payload: string;
	rendered: string;
	source_url: string | null;
}

const DEFAULT_SOFT_TTL_SEC = 300; // 5 minutes
const DEFAULT_HARD_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

let cachedDb: Database | null = null;
let openAttempted = false;

function ensureParentDir(filePath: string): void {
	try {
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (err) {
		logger.debug("github cache: failed to create private parent dir", { err: String(err) });
	}
}

function chmodIfExists(filePath: string, mode: number): void {
	try {
		fs.chmodSync(filePath, mode);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.debug("github cache: chmod failed", { err: String(err), path: filePath });
		}
	}
}

function protectDbFiles(dbPath: string): void {
	chmodIfExists(dbPath, 0o600);
	chmodIfExists(`${dbPath}-wal`, 0o600);
	chmodIfExists(`${dbPath}-shm`, 0o600);
}

export function openDb(): Database | null {
	if (cachedDb) return cachedDb;
	if (openAttempted) return null;
	openAttempted = true;
	try {
		const dbPath = getGithubCacheDbPath();
		ensureParentDir(dbPath);
		const db = new Database(dbPath);
		db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			PRAGMA busy_timeout=5000;
		`);
		// Migrate any pre-existing table whose key/check constraint predates
		// the current schema. The cache is regenerable, so we drop rows rather
		// than running an in-place ALTER dance.
		const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
			?.user_version;
		if (userVersion !== undefined && userVersion < 4) {
			db.run("DROP TABLE IF EXISTS github_view_cache");
		}
		db.run(`
			CREATE TABLE IF NOT EXISTS github_view_cache (
				auth_key        TEXT    NOT NULL,
				repo             TEXT    NOT NULL,
				kind             TEXT    NOT NULL CHECK (kind IN ('issue','pr','pr-diff')),
				number           INTEGER NOT NULL,
				include_comments INTEGER NOT NULL,
				fetched_at       INTEGER NOT NULL,
				payload          TEXT    NOT NULL,
				rendered         TEXT    NOT NULL,
				source_url       TEXT,
				PRIMARY KEY (auth_key, repo, kind, number, include_comments)
			);
			CREATE INDEX IF NOT EXISTS idx_github_view_cache_fetched ON github_view_cache(fetched_at);
			PRAGMA user_version = 4;
		`);
		protectDbFiles(dbPath);
		cachedDb = db;
		// No eviction on open: the default `DEFAULT_HARD_TTL_SEC` is a coarse
		// backstop that runs before user settings load, so applying it here
		// would nuke rows still valid under a stricter-or-laxer configured
		// `github.cache.hardTtlSec`. The per-lookup `sweepIfDue()` in
		// `getOrFetchView()` enforces the *configured* retention instead.
		return db;
	} catch (err) {
		logger.warn("github cache: failed to open DB; cache disabled", { err: String(err) });
		return null;
	}
}

function evictExpired(db: Database, hardTtlMs: number): void {
	try {
		const cutoff = Date.now() - hardTtlMs;
		db.prepare("DELETE FROM github_view_cache WHERE fetched_at < ?").run(cutoff);
	} catch (err) {
		logger.debug("github cache: eviction failed", { err: String(err) });
	}
}

/**
 * Throttle for the per-lookup configured-TTL sweep. We don't want every
 * cached read to issue a DELETE; once per `SWEEP_INTERVAL_MS` is enough to
 * cap the on-disk exposure window at roughly `hardTtlMs + SWEEP_INTERVAL_MS`.
 */
const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;
const backgroundRefreshes = new Map<string, { generation: number; controller: AbortController }>();
let backgroundRefreshGeneration = 0;
const BACKGROUND_REFRESH_TIMEOUT_MS = 30_000;

function cacheIdentityKey(
	authKey: string,
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
): string {
	return JSON.stringify([authKey, normalizeRepo(repo), kind, number, includeComments]);
}

function retireBackgroundRefresh(key: string): void {
	const entry = backgroundRefreshes.get(key);
	if (!entry) return;
	entry.controller.abort();
	backgroundRefreshes.delete(key);
}

function sweepIfDue(hardTtlMs: number): void {
	const now = Date.now();
	if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
	const db = openDb();
	if (!db) return;
	lastSweepAt = now;
	evictExpired(db, hardTtlMs);
}

function getGhConfigDir(): string {
	const override = process.env.GH_CONFIG_DIR;
	if (override) return override;
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg) return path.join(xdg, "gh");
	return path.join(os.homedir(), ".config", "gh");
}

function hashCacheIdentity(parts: string[]): string {
	return Bun.hash(parts.map(part => `${part.length}:${part}`).join("|")).toString(36);
}

/**
 * Best-effort local fingerprint for the active GitHub CLI credentials.
 *
 * Cache hits must not cross account/token boundaries, but doing a `gh api user`
 * probe before every cached read would defeat the soft-TTL contract that cache
 * hits avoid a gh round-trip. Instead, key rows by credential material that the
 * GitHub CLI itself consumes: token environment variables and/or hosts.yml.
 * The DB stores only a hash, never the token or hosts.yml contents. If no
 * credential source is visible, callers should pass `null` to bypass caching.
 */
export function resolveGithubCacheAuthKey(host: string = process.env.GH_HOST || "github.com"): string | undefined {
	const parts: string[] = [`host:${host}`];
	let hasCredentialMaterial = false;
	for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
		const value = process.env[name];
		if (!value) continue;
		hasCredentialMaterial = true;
		parts.push(`${name}:${value}`);
	}
	try {
		const hostsPath = path.join(getGhConfigDir(), "hosts.yml");
		const hosts = fs.readFileSync(hostsPath, "utf8");
		hasCredentialMaterial = true;
		parts.push(`hosts:${hosts}`);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.debug("github cache: failed to read gh hosts config for cache identity", { err: String(err) });
		}
	}
	if (!hasCredentialMaterial) return undefined;
	return `${host}:${hashCacheIdentity(parts)}`;
}

function normalizeRepo(repo: string): string {
	return repo.toLowerCase();
}

export function getCached<T = unknown>(
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	authKey: string = DEFAULT_CACHE_AUTH_KEY,
): CachedView<T> | null {
	const db = openDb();
	if (!db) return null;
	try {
		const row = db
			.prepare(
				"SELECT auth_key, repo, kind, number, include_comments, fetched_at, payload, rendered, source_url FROM github_view_cache WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
			)
			.get(authKey, normalizeRepo(repo), kind, number, includeComments ? 1 : 0) as Row | undefined;
		if (!row) return null;
		let payload: T;
		try {
			payload = JSON.parse(row.payload) as T;
		} catch (err) {
			logger.debug("github cache: corrupt payload row, ignoring", { err: String(err), repo, kind, number });
			return null;
		}
		// Scrub on read too: rows written before the write-path scrub (or by an
		// older binary) are still on disk, and a hit renders them back to the
		// model. Reindexing uses the stored kind, so legacy diff offsets are
		// rebuilt against the scrubbed text instead of the original.
		const scrubbed = scrubStoredView(row.kind, payload, row.rendered, row.source_url ?? undefined);
		return {
			authKey: row.auth_key,
			repo: row.repo,
			kind: row.kind,
			number: row.number,
			includeComments: row.include_comments === 1,
			fetchedAt: row.fetched_at,
			payload: scrubbed.payload as T,
			rendered: scrubbed.rendered,
			sourceUrl: scrubbed.sourceUrl,
		};
	} catch (err) {
		logger.debug("github cache: read failed", { err: String(err) });
		return null;
	}
}

export interface PutCachedInput<T = unknown> {
	authKey?: string;
	repo: string;
	kind: CacheKind;
	number: number;
	includeComments: boolean;
	payload: T;
	rendered: string;
	sourceUrl?: string;
	fetchedAt?: number;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Assignment-style credentials, bounded to the value token. The shared crash
 * redactor deliberately redacts through end-of-line; on a cached issue body
 * that eats the rest of a Markdown table row or the command after a
 * `TOKEN=…` example. These spans are redacted here and masked while the crash
 * redactor runs, so it cannot consume the tail a second time.
 *
 * `authorization`/`bearer`/`cookies` are deliberately left to the shared
 * redactor: their grammars are not a single value token.
 */
const BOUNDED_CREDENTIAL_ASSIGNMENT =
	/(?<![A-Za-z0-9_-])((?:access|refresh|id|session|private)[._\t -]*token|api[._\t -]*key|apikey|client[._\t -]*secret|secret[._\t -]*key|private[._\t -]*key|pass(?:word|wd|phrase)|pwd|token|secrets?|credentials?)([._\t -]{0,2}["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'`|;&,<>]+))/gi;

const BOUNDED_CREDENTIAL_MASK = "\u0000gjc-credential-";

/**
 * Authorization headers are redacted through the scheme word and the value, but
 * not through the rest of the line, so a table cell or shell command after the
 * header survives. `cookies` stays with the shared redactor: cookie pairs are
 * not a single value token.
 */
const BOUNDED_AUTHORIZATION_HEADER =
	/(?<![A-Za-z0-9_-])((?:authorization|auth)(?:\s*["']?\s*[:=]\s*["']?))(Bearer|Basic|Token)(\s+)[^\s|]+/gi;

const BOUNDED_AUTHORIZATION_MASK = "\u0000gjc-auth-";

function maskBoundedAuthorizationHeaders(text: string): { text: string; restore: (scrubbed: string) => string } {
	const sanitized: string[] = [];
	const masked = text.replace(
		BOUNDED_AUTHORIZATION_HEADER,
		(_match: string, label: string, scheme: string, spacing: string) => {
			const sentinel = `${BOUNDED_AUTHORIZATION_MASK}${sanitized.length}\u0000`;
			sanitized.push(`${label}${scheme}${spacing}«redacted»`);
			return sentinel;
		},
	);
	if (sanitized.length === 0) return { text, restore: scrubbed => scrubbed };
	return {
		text: masked,
		restore: scrubbed =>
			scrubbed.replace(/\u0000gjc-auth-(\d+)\u0000/g, (_match, index: string) => sanitized[Number(index)] ?? ""),
	};
}

function maskBoundedCredentialAssignments(text: string): { text: string; restore: (scrubbed: string) => string } {
	const sanitized: string[] = [];
	const masked = text.replace(
		BOUNDED_CREDENTIAL_ASSIGNMENT,
		(
			_match: string,
			label: string,
			separator: string,
			doubleQuoted: string | undefined,
			singleQuoted: string | undefined,
		) => {
			const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
			const sentinel = `${BOUNDED_CREDENTIAL_MASK}${sanitized.length}\u0000`;
			sanitized.push(`${label}${separator}${quote}«redacted»${quote}`);
			return sentinel;
		},
	);
	if (sanitized.length === 0) return { text, restore: scrubbed => scrubbed };
	return {
		text: masked,
		restore: scrubbed =>
			scrubbed.replace(
				/\u0000gjc-credential-(\d+)\u0000/g,
				(_match, index: string) => sanitized[Number(index)] ?? "",
			),
	};
}

/**
 * Remove URL userinfo. Authentication is what makes a URL sensitive; the host,
 * path, query and surrounding markup stay readable. Handles `scheme://`,
 * JSON-escaped `scheme:\/\/`, and protocol-relative `//user:pass@host` forms.
 * Tabs inside the userinfo are matched too, because URL parsers drop them.
 */
function stripUrlUserinfo(text: string): string {
	const withoutAuthorityUserinfo = text.replace(
		/(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:(?:\/\/|\\\/\\\/))[^\r\n /?#@"'`<>]*@/gi,
		"$1",
	);
	return withoutAuthorityUserinfo.replace(/(^|[\s"'`([{<])(\/\/)[^\r\n /?#@"'`<>]*@/g, "$1$2");
}

/**
 * Vendor token shapes re-checked with only alphanumerics as the left boundary.
 * The crash redactor anchors on a word boundary, so a token glued to an
 * identifier (`build_ghp_…`) survives there; cached bodies are arbitrary user
 * text, so the cache cannot inherit that assumption.
 */
const CACHE_VENDOR_TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, "«redacted-github-token»"],
	[/(?<![A-Za-z0-9])gh[opsur]_[A-Za-z0-9]{16,}/g, "«redacted-github-token»"],
	[/(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "«redacted-api-key»"],
	[/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g, "«redacted-api-key»"],
	[/(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{8,}/g, "«redacted-slack-token»"],
	[/(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}/g, "«redacted-npm-token»"],
	[/(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g, "«redacted-gitlab-token»"],
	[/(?<![A-Za-z0-9])hf_[A-Za-z0-9]{20,}/g, "«redacted-api-key»"],
	[/(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}/g, "«redacted-aws-key»"],
];

function scrubCacheVendorTokens(text: string): string {
	let scrubbed = text;
	for (const [pattern, marker] of CACHE_VENDOR_TOKEN_PATTERNS) scrubbed = scrubbed.replace(pattern, marker);
	return scrubbed;
}

/**
 * Strip the local home directory from cached text. `/home/<user>/x`,
 * `/Users/<user>/x`, `/root/x` and `C:\Users\<user>\x` all become `~/x`: the
 * path stays useful but no longer names this machine's account. Relative forms
 * (`~/x`, `$HOME/x`) and non-home roots such as `/srv/app` are untouched, and
 * a URL's own path is never rewritten.
 */
function scrubHostPaths(text: string): string {
	const home = os.homedir();
	const homePattern =
		home.length > 1 ? new RegExp(`(?<![A-Za-z0-9._#-])${escapeRegExp(home)}(?![A-Za-z0-9._-])`, "g") : undefined;
	const scrubLocal = (chunk: string): string => {
		let scrubbed = homePattern ? chunk.replace(homePattern, "~") : chunk;
		scrubbed = scrubbed.replace(/(?<![A-Za-z0-9._#-])\/(?:home|Users)\/[^/\s"'`<>()[\]{},;|]+/g, "~");
		scrubbed = scrubbed.replace(/(?<![A-Za-z0-9._#-])\/root(?![A-Za-z0-9._-])/g, "~");
		return scrubbed.replace(/(?<![A-Za-z0-9._#-])[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`<>()[\]{},;|]+/gi, "~");
	};
	// A URL's path is content, not a local path, so only scrub outside URL spans.
	// `file:` URLs are local by definition and still get scrubbed.
	let out = "";
	let last = 0;
	for (const match of text.matchAll(/(?:[a-z][a-z0-9+.-]*:(?:\/\/|\\\/\\\/)|\/\/)[^\s"'`<>(){}]*/gi)) {
		const index = match.index ?? 0;
		const url = match[0];
		out += scrubLocal(text.slice(last, index));
		out += /^file:/i.test(url) ? scrubLocal(url) : url;
		last = index + url.length;
	}
	return out + scrubLocal(text.slice(last));
}

/** Text-level scrub for everything the view cache persists or serves back. */
function scrubCacheText(text: string): string {
	const authHeaders = maskBoundedAuthorizationHeaders(text);
	const assignments = maskBoundedCredentialAssignments(authHeaders.text);
	let scrubbed = stripUrlUserinfo(assignments.text);
	scrubbed = redactCrashSecrets(scrubbed);
	scrubbed = scrubCacheVendorTokens(scrubbed);
	scrubbed = scrubHostPaths(scrubbed);
	return authHeaders.restore(assignments.restore(scrubbed));
}

/** Scrub credential-shaped text and host paths inside a value before it is JSON-encoded or served back. */
function scrubPersistedValue(value: unknown): unknown {
	if (typeof value === "string") return scrubCacheText(value);
	if (typeof value !== "object" || value === null) return value;
	if (value instanceof Date) return value;
	if (Array.isArray(value)) return value.map(scrubPersistedValue);
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return value;
	// An opaque value under a credential-named field is credential material even
	// when it has no recognizable token shape.
	const out: Record<string, unknown> = {};
	const seenKeys = new Set<string>();
	for (const [key, child] of Object.entries(value)) {
		const baseKey = scrubCacheText(key);
		let outKey = baseKey;
		let disambiguator = 2;
		while (seenKeys.has(outKey)) outKey = `${baseKey}#${disambiguator++}`;
		seenKeys.add(outKey);
		const scrubbedChild =
			isCredentialKey(key) && child !== null && child !== undefined ? "«redacted»" : scrubPersistedValue(child);
		// `defineProperty` keeps an own `__proto__` key an ordinary entry instead of
		// assigning through the prototype setter.
		Object.defineProperty(out, outKey, {
			value: scrubbedChild,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return out;
}

interface ScrubbedView {
	payload: unknown;
	rendered: string;
	sourceUrl: string | undefined;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sanitize one stored representation. Runs on write and again on read, so a row
 * written before this scrub existed is never served verbatim.
 *
 * A `pr-diff` row needs more than a text pass: its index holds byte offsets
 * into the unified text, so a scrub (which changes byte lengths) requires
 * rebuilding the index from the scrubbed text. Git path tokens are escape-
 * decoded by the parser, and decoding can turn `\141ccess_token=…` into a
 * recognizable credential, so the encoded header tokens are rewritten from
 * their scrubbed decoded form before the index is rebuilt. The recursive value
 * scrub then covers decoded paths and every other string field.
 */
function scrubStoredView(
	kind: CacheKind,
	payload: unknown,
	rendered: string,
	sourceUrl: string | undefined,
): ScrubbedView {
	const scrubbedPayload = scrubPersistedValue(payload);
	const scrubbedSourceUrl = sourceUrl === undefined ? undefined : scrubCacheText(sourceUrl);
	const unified = isRecordValue(scrubbedPayload) ? scrubbedPayload.unified : undefined;
	if (kind !== "pr-diff" || typeof unified !== "string") {
		return { payload: scrubbedPayload, rendered: scrubCacheText(rendered), sourceUrl: scrubbedSourceUrl };
	}
	let scrubbedUnified = unified;
	let files: unknown = isRecordValue(scrubbedPayload) ? scrubbedPayload.files : undefined;
	// Path tokens are decoded, scrubbed and re-quoted before the text pass, so an
	// escape-encoded credential cannot survive and the text pass cannot chew
	// through diff framing. The index is then rebuilt from the exact text that is
	// persisted, keeping slice offsets valid after scrubbing changed lengths.
	scrubbedUnified = scrubPrDiffText(unified, scrubCacheText);
	const reparsed = parsePrUnifiedDiff(scrubbedUnified);
	files = scrubPersistedValue(reparsed.files);
	const base = isRecordValue(scrubbedPayload) ? scrubbedPayload : {};
	return {
		payload: { ...base, unified: scrubbedUnified, files },
		rendered: scrubbedUnified,
		sourceUrl: scrubbedSourceUrl,
	};
}

export function putCached<T = unknown>(input: PutCachedInput<T>): void {
	const db = openDb();
	if (!db) return;
	try {
		const fetchedAt = input.fetchedAt ?? Date.now();
		// Sanitize before JSON encoding. Encoding first glues a token to an
		// escaped newline and the scrubber misses it. The live fetch result is not
		// rewritten; a later hit reads this scrubbed row.
		const scrubbed = scrubStoredView(input.kind, input.payload, input.rendered, input.sourceUrl);
		const payloadJson = JSON.stringify(scrubbed.payload);
		db.prepare(
			"INSERT OR REPLACE INTO github_view_cache (auth_key, repo, kind, number, include_comments, fetched_at, payload, rendered, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			input.authKey ?? DEFAULT_CACHE_AUTH_KEY,
			normalizeRepo(input.repo),
			input.kind,
			input.number,
			input.includeComments ? 1 : 0,
			fetchedAt,
			payloadJson,
			scrubbed.rendered,
			scrubbed.sourceUrl ?? null,
		);
		protectDbFiles(getGithubCacheDbPath());
	} catch (err) {
		logger.debug("github cache: write failed", { err: String(err) });
	}
}

/** Drop a specific cache entry. */
export function invalidate(
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments?: boolean,
	authKey: string = DEFAULT_CACHE_AUTH_KEY,
): void {
	if (includeComments === undefined) {
		retireBackgroundRefresh(cacheIdentityKey(authKey, repo, kind, number, false));
		retireBackgroundRefresh(cacheIdentityKey(authKey, repo, kind, number, true));
	} else {
		retireBackgroundRefresh(cacheIdentityKey(authKey, repo, kind, number, includeComments));
	}
	const db = openDb();
	if (!db) return;
	try {
		if (includeComments === undefined) {
			db.prepare("DELETE FROM github_view_cache WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ?").run(
				authKey,
				normalizeRepo(repo),
				kind,
				number,
			);
		} else {
			db.prepare(
				"DELETE FROM github_view_cache WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
			).run(authKey, normalizeRepo(repo), kind, number, includeComments ? 1 : 0);
		}
	} catch (err) {
		logger.debug("github cache: invalidate failed", { err: String(err) });
	}
}

/** Drop every cached row. Test helper. */
export function clearAll(): void {
	const db = openDb();
	if (!db) return;
	try {
		db.prepare("DELETE FROM github_view_cache").run();
	} catch (err) {
		logger.debug("github cache: clear failed", { err: String(err) });
	}
}

/**
 * Test/maintenance helper. Closes and forgets the cached connection so the
 * next access reopens against (possibly) a different DB path.
 */
export function resetForTests(): void {
	if (cachedDb) {
		try {
			cachedDb.close();
		} catch {
			// Closing failures are non-fatal.
		}
	}
	cachedDb = null;
	openAttempted = false;
	lastSweepAt = 0;
	for (const { controller } of backgroundRefreshes.values()) controller.abort();
	backgroundRefreshes.clear();
	backgroundRefreshGeneration += 1;
}

// ────────────────────────────────────────────────────────────────────────────
// Cache-aware lookup wrapper
// ────────────────────────────────────────────────────────────────────────────

export interface FreshResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
}

export interface CacheLookupOptions<T> {
	repo: string;
	kind: CacheKind;
	number: number;
	includeComments: boolean;
	/**
	 * Auth/credential namespace for cache rows. Omit only in storage-layer
	 * tests; pass `null` when production code cannot determine an identity and
	 * must bypass persistent cache reads/writes.
	 */
	authKey?: string | null;
	fetchFresh: (signal?: AbortSignal) => Promise<FreshResult<T>>;
	settings?: Settings | undefined;
	now?: number;
	signal?: AbortSignal;
}

export type CacheStatus = "miss" | "fresh" | "stale" | "disabled";

export interface CacheLookupResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
	status: CacheStatus;
	fetchedAt: number;
}

function readNumberSetting(settings: Settings | undefined, key: string, fallback: number): number {
	if (!settings) return fallback;
	try {
		const value = (settings as unknown as { get(k: string): unknown }).get(key);
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	} catch {
		// Unknown setting paths fall through to default; settings may be a
		// stripped test stub that doesn't expose every key.
	}
	return fallback;
}

function readBooleanSetting(settings: Settings | undefined, key: string, fallback: boolean): boolean {
	if (!settings) return fallback;
	try {
		const value = (settings as unknown as { get(k: string): unknown }).get(key);
		if (typeof value === "boolean") return value;
	} catch {
		// Same fallback rationale as readNumberSetting.
	}
	return fallback;
}

export interface CacheTtl {
	softMs: number;
	hardMs: number;
	enabled: boolean;
}

export function resolveCacheTtl(settings?: Settings): CacheTtl {
	const softSec = readNumberSetting(settings, "github.cache.softTtlSec", DEFAULT_SOFT_TTL_SEC);
	const hardSec = readNumberSetting(settings, "github.cache.hardTtlSec", DEFAULT_HARD_TTL_SEC);
	const enabled = readBooleanSetting(settings, "github.cache.enabled", true);
	return {
		softMs: Math.max(0, softSec) * 1000,
		hardMs: Math.max(0, hardSec) * 1000,
		enabled,
	};
}

function storeResult<T>(
	authKey: string,
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	result: FreshResult<T>,
	fetchedAt: number,
): void {
	putCached<T>({
		authKey,
		repo,
		kind,
		number,
		includeComments,
		payload: result.payload,
		rendered: result.rendered,
		sourceUrl: result.sourceUrl,
		fetchedAt,
	});
}

function scheduleBackgroundRefresh<T>(
	authKey: string,
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	fetchFresh: (signal?: AbortSignal) => Promise<FreshResult<T>>,
): void {
	const key = cacheIdentityKey(authKey, repo, kind, number, includeComments);
	if (backgroundRefreshes.has(key)) return;
	const generation = backgroundRefreshGeneration;
	const controller = new AbortController();
	const entry = { generation, controller };
	backgroundRefreshes.set(key, entry);
	queueMicrotask(async () => {
		const timeoutHandle = setTimeout(() => {
			controller.abort(new Error("GitHub background refresh timed out"));
			if (backgroundRefreshes.get(key) === entry) backgroundRefreshes.delete(key);
			logger.debug("github cache: background refresh timed out", { repo, kind, number });
		}, BACKGROUND_REFRESH_TIMEOUT_MS);
		try {
			const fresh = await fetchFresh(controller.signal);
			if (
				!controller.signal.aborted &&
				backgroundRefreshes.get(key) === entry &&
				backgroundRefreshGeneration === generation
			) {
				storeResult(authKey, repo, kind, number, includeComments, fresh, Date.now());
			}
		} catch (err) {
			controller.abort();
			logger.debug("github cache: background refresh failed", {
				err: String(err),
				repo,
				kind,
				number,
			});
		} finally {
			clearTimeout(timeoutHandle);
			if (backgroundRefreshes.get(key) === entry) backgroundRefreshes.delete(key);
		}
	});
}

export async function getOrFetchView<T>(options: CacheLookupOptions<T>): Promise<CacheLookupResult<T>> {
	const ttl = resolveCacheTtl(options.settings);
	const now = options.now ?? Date.now();
	const authKey = options.authKey === undefined ? DEFAULT_CACHE_AUTH_KEY : options.authKey;

	if (!ttl.enabled || authKey === null) {
		const fresh = await options.fetchFresh(options.signal);
		return { ...fresh, status: "disabled", fetchedAt: now };
	}
	const cacheKey = cacheIdentityKey(authKey, options.repo, options.kind, options.number, options.includeComments);

	// Enforce the *configured* hard TTL against on-disk rows. This is what
	// makes `github.cache.hardTtlSec` a real retention cap rather than a soft
	// suggestion the next `openDb()` call eventually honors.
	sweepIfDue(ttl.hardMs);

	const cached: CachedView<T> | null = getCached<T>(
		options.repo,
		options.kind,
		options.number,
		options.includeComments,
		authKey,
	);

	if (cached) {
		const age = now - cached.fetchedAt;
		if (age > ttl.hardMs) {
			// Past hard TTL: drop the row eagerly so the on-disk exposure window
			// is bounded even if `fetchFresh()` then fails (network down, gh
			// auth lapse, etc.) and we never get to overwrite it.
			retireBackgroundRefresh(cacheKey);
			invalidate(options.repo, options.kind, options.number, options.includeComments, authKey);
		} else if (age <= ttl.softMs) {
			return {
				rendered: cached.rendered,
				sourceUrl: cached.sourceUrl,
				payload: cached.payload,
				status: "fresh",
				fetchedAt: cached.fetchedAt,
			};
		} else {
			scheduleBackgroundRefresh(
				authKey,
				options.repo,
				options.kind,
				options.number,
				options.includeComments,
				options.fetchFresh,
			);
			return {
				rendered: cached.rendered,
				sourceUrl: cached.sourceUrl,
				payload: cached.payload,
				status: "stale",
				fetchedAt: cached.fetchedAt,
			};
		}
	}

	const fresh = await options.fetchFresh(options.signal);
	const fetchedAt = Date.now();
	retireBackgroundRefresh(cacheKey);
	storeResult(authKey, options.repo, options.kind, options.number, options.includeComments, fresh, fetchedAt);
	return { ...fresh, status: "miss", fetchedAt };
}

/**
 * Human-friendly freshness note for protocol-handler `notes[]` rendering.
 */
export function formatFreshnessNote(status: CacheStatus, fetchedAtMs: number, now: number = Date.now()): string {
	if (status === "miss") return "Fetched live";
	if (status === "disabled") return "Cache disabled; fetched live";
	const ageSec = Math.max(0, Math.round((now - fetchedAtMs) / 1000));
	const human =
		ageSec < 60
			? `${ageSec}s ago`
			: ageSec < 3600
				? `${Math.round(ageSec / 60)}m ago`
				: `${Math.round(ageSec / 3600)}h ago`;
	if (status === "stale") return `Cached: ${human} (refreshing in background)`;
	return `Cached: ${human}`;
}
