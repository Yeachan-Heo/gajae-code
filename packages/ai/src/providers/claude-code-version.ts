/**
 * Claude Code client-version resolution for the `claude-cli` fingerprint.
 *
 * Anthropic gates newer models behind a minimum Claude Code version and answers
 * stale fingerprints with HTTP 400 (`claude_code_version_too_old`). A version
 * baked in at build time goes stale between releases, so the fingerprint is the
 * higher of the bundled floor and the latest published Claude Code release,
 * resolved in the background and cached on disk. Requests never wait on the
 * network: they sign with whatever is known at that instant.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getClaudeCodeVersionCachePath, isEnoent, logger } from "@gajae-code/utils";

/** Bundled floor; `scripts/check-spoofed-versions.ts --update` keeps it current. */
export const CLAUDE_CODE_BASELINE_VERSION = "2.1.284";

/** Pins the fingerprint and disables network resolution. */
export const CLAUDE_CODE_VERSION_ENV = "GJC_CLAUDE_CODE_VERSION";

/**
 * Anthropic's native-installer release channel. `stable` deliberately lags the
 * npm package during a staged rollout, so `latest` is the channel that matches
 * what a freshly updated Claude Code actually reports.
 */
export const CLAUDE_RELEASE_CHANNEL_URL =
	"https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest";
export const CLAUDE_NPM_DIST_TAG_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const EXACT_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const EMBEDDED_SEMVER_RE = /(\d+\.\d+\.\d+)/;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function compareClaudeCodeVersions(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function isExactSemver(value: unknown): value is string {
	return typeof value === "string" && EXACT_SEMVER_RE.test(value);
}

function highest(candidates: ReadonlyArray<string | null | undefined>): string | null {
	let best: string | null = null;
	for (const candidate of candidates) {
		if (!isExactSemver(candidate)) continue;
		if (best === null || compareClaudeCodeVersions(candidate, best) > 0) best = candidate;
	}
	return best;
}

async function fetchText(fetchImpl: FetchLike, url: string, userAgent: string): Promise<string | null> {
	try {
		const res = await fetchImpl(url, {
			headers: { "User-Agent": userAgent },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	}
}

async function fetchReleaseChannel(fetchImpl: FetchLike, userAgent: string): Promise<string | null> {
	const text = await fetchText(fetchImpl, CLAUDE_RELEASE_CHANNEL_URL, userAgent);
	return text === null ? null : (EMBEDDED_SEMVER_RE.exec(text.trim())?.[1] ?? null);
}

async function fetchNpmDistTag(fetchImpl: FetchLike, userAgent: string): Promise<string | null> {
	const text = await fetchText(fetchImpl, CLAUDE_NPM_DIST_TAG_URL, userAgent);
	if (text === null) return null;
	try {
		const data = JSON.parse(text) as { version?: unknown };
		return typeof data.version === "string" ? (EMBEDDED_SEMVER_RE.exec(data.version)?.[1] ?? null) : null;
	} catch {
		return null;
	}
}

/**
 * Latest published Claude Code version: the higher of the native-installer
 * `latest` channel and the npm dist-tag, so one lagging or unavailable source
 * cannot pin the fingerprint back. `null` when both sources fail.
 */
export async function fetchLatestClaudeCodeVersion(
	fetchImpl: FetchLike = fetch,
	userAgent = "gajae-code/claude-code-version",
): Promise<string | null> {
	return highest(
		await Promise.all([fetchReleaseChannel(fetchImpl, userAgent), fetchNpmDistTag(fetchImpl, userAgent)]),
	);
}

interface CachedClaudeCodeVersion {
	version: string;
	checkedAt: number;
}

export interface ClaudeCodeVersionResolverOptions {
	baseline: string;
	/** Exact pin; disables network resolution when set. */
	pinned?: string;
	/** `null` disables both disk caching and network resolution. */
	cachePath: string | null;
	fetch?: FetchLike;
	now?: () => number;
	refreshIntervalMs?: number;
}

export interface ClaudeCodeVersionResolver {
	/** Current fingerprint; schedules a background refresh when the cache is stale. */
	get(): string;
	/** Refresh now (deduplicated); resolves with the fingerprint afterwards. */
	refresh(): Promise<string>;
}

export function createClaudeCodeVersionResolver(options: ClaudeCodeVersionResolverOptions): ClaudeCodeVersionResolver {
	const { baseline, cachePath } = options;
	const fetchImpl = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
	const pinned = isExactSemver(options.pinned) ? options.pinned : undefined;

	let loaded = false;
	let resolved: string | undefined;
	let checkedAt = 0;
	let inflight: Promise<string> | undefined;

	const current = (): string => (resolved && compareClaudeCodeVersions(resolved, baseline) > 0 ? resolved : baseline);

	const loadCache = (): void => {
		if (loaded || cachePath === null) return;
		loaded = true;
		try {
			const data = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as Partial<CachedClaudeCodeVersion>;
			if (isExactSemver(data.version) && typeof data.checkedAt === "number" && Number.isFinite(data.checkedAt)) {
				resolved = data.version;
				checkedAt = data.checkedAt;
			}
		} catch (error) {
			if (!isEnoent(error)) logger.debug("Ignoring unreadable Claude Code version cache", { error: String(error) });
		}
	};

	const refresh = (): Promise<string> => {
		if (pinned || cachePath === null) return Promise.resolve(pinned ?? current());
		loadCache();
		inflight ??= (async () => {
			try {
				const latest = await fetchLatestClaudeCodeVersion(fetchImpl);
				// A failed lookup still counts as a check so an offline host does not
				// retry on every request; the next attempt waits a full interval.
				checkedAt = now();
				if (latest && (!resolved || compareClaudeCodeVersions(latest, resolved) > 0)) resolved = latest;
				if (resolved) {
					const record: CachedClaudeCodeVersion = { version: resolved, checkedAt };
					await Bun.write(cachePath, `${JSON.stringify(record)}\n`);
				}
			} catch (error) {
				logger.debug("Claude Code version refresh failed", { error: String(error) });
			} finally {
				inflight = undefined;
			}
			return current();
		})();
		return inflight;
	};

	return {
		get() {
			if (pinned) return pinned;
			if (cachePath === null) return baseline;
			loadCache();
			if (!inflight && now() - checkedAt >= refreshIntervalMs) void refresh();
			return current();
		},
		refresh,
	};
}

let defaultResolver: ClaudeCodeVersionResolver | undefined;

function getDefaultResolver(): ClaudeCodeVersionResolver {
	defaultResolver ??= createClaudeCodeVersionResolver({
		baseline: CLAUDE_CODE_BASELINE_VERSION,
		pinned: process.env[CLAUDE_CODE_VERSION_ENV]?.trim() || undefined,
		// Tests must stay hermetic and deterministic: no network, no user cache.
		cachePath: process.env.NODE_ENV === "test" ? null : path.resolve(getClaudeCodeVersionCachePath()),
	});
	return defaultResolver;
}

/** Claude Code version the `claude-cli` fingerprint and billing attribution sign with. */
export function getClaudeCodeVersion(): string {
	return getDefaultResolver().get();
}
