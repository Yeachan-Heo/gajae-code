/**
 * GitHub release lookup and checksum helpers for binary install/update.
 * End-user updates resolve versions from GitHub, not the npm registry.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { UpdateChannel } from "../config/update-channel";

export const RELEASE_REPO = "Yeachan-Heo/gajae-code";
export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_WEB_ORIGIN = "https://github.com";
export const GITHUB_RELEASE_DOWNLOAD_ORIGIN = `${GITHUB_WEB_ORIGIN}/${RELEASE_REPO}/releases/download`;
export const BINARY_SHA256_ASSET = "gajae-release-binaries.sha256";
export const BINARY_MANIFEST_ASSET = "gajae-release-binaries-v1.json";

const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;
const NIGHTLY_VERSION_RE = /^\d+\.\d+\.\d+-nightly\.[0-9]+\.[0-9]+\.g[0-9a-f]+$/;
const TAG_RE = /^v[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface GithubReleaseInfo {
	tag: string;
	version: string;
	channel: UpdateChannel;
	htmlUrl?: string;
	warnings: string[];
}

export type GithubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GithubReleaseLookupOptions {
	channel?: UpdateChannel;
	fetchImpl?: GithubFetch;
	lookupEnv?: (name: string) => string | undefined;
	apiOrigin?: string;
	webOrigin?: string;
	timeoutMs?: number;
	useAmbientToken?: boolean;
}

/** A GitHub REST response that failed, carrying the status the caller must branch on. */
export class GithubApiStatusError extends Error {
	constructor(
		readonly url: string,
		readonly status: number,
	) {
		super(`${url} responded ${status}`);
		this.name = "GithubApiStatusError";
	}

	/** 403/429 is how api.github.com reports an exhausted unauthenticated budget. */
	get isRateLimited(): boolean {
		return this.status === 403 || this.status === 429;
	}
}

const TOKEN_HINT =
	"Set GITHUB_TOKEN or GH_TOKEN to raise the api.github.com rate limit (60 requests/hour per IP when unauthenticated).";

interface GithubReleaseJson {
	tag_name?: unknown;
	draft?: unknown;
	prerelease?: unknown;
	html_url?: unknown;
}

export function isSafeReleaseTag(tag: string): boolean {
	return TAG_RE.test(tag) && !tag.includes("..") && !tag.includes("/");
}

export function versionFromTag(tag: string): string {
	return tag.startsWith("v") ? tag.slice(1) : tag;
}

export function githubReleaseHeaders(token: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "gjc-update",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

function readToken(lookupEnv?: (name: string) => string | undefined): string | undefined {
	const env = lookupEnv ?? ((name: string) => process.env[name]);
	const token = env("GITHUB_TOKEN") || env("GH_TOKEN");
	return token && token.length > 0 ? token : undefined;
}

async function readGithubJson(url: string, options: GithubReleaseLookupOptions): Promise<unknown> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 20_000;
	const token = options.useAmbientToken ? readToken(options.lookupEnv) : undefined;
	const response = await fetchImpl(url, {
		headers: githubReleaseHeaders(token),
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "follow",
	});
	if (!response.ok) {
		throw new GithubApiStatusError(url, response.status);
	}
	return await response.json();
}

function parseRelease(value: unknown, expectedChannel: UpdateChannel): GithubReleaseInfo {
	if (typeof value !== "object" || value === null) {
		throw new Error("GitHub release payload was not an object");
	}
	const record = value as GithubReleaseJson;
	if (record.draft === true) throw new Error("Refusing a draft GitHub release");
	const tag = typeof record.tag_name === "string" ? record.tag_name : "";
	if (!isSafeReleaseTag(tag)) throw new Error(`Refusing unsafe GitHub release tag: ${tag || "<empty>"}`);
	const version = versionFromTag(tag);
	if (expectedChannel === "nightly") {
		if (record.prerelease !== true || !NIGHTLY_VERSION_RE.test(version)) {
			throw new Error(`GitHub release ${tag} is not a nightly prerelease`);
		}
	} else if (record.prerelease === true || !STABLE_VERSION_RE.test(version)) {
		throw new Error(`GitHub release ${tag} is not a stable vX.Y.Z release`);
	}
	return {
		tag,
		version,
		channel: expectedChannel,
		htmlUrl: typeof record.html_url === "string" ? record.html_url : undefined,
		warnings: [],
	};
}

/**
 * Resolve the stable tag through the `github.com` web route, which 302s from
 * `/releases/latest` to `/releases/tag/<tag>`. That origin serves the binary
 * downloads too and is not bound by the api.github.com rate limit, so it keeps
 * `gjc update` working on a shared IP whose unauthenticated budget is spent.
 */
export async function resolveStableReleaseTagFromWeb(options: GithubReleaseLookupOptions = {}): Promise<string> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const webOrigin = options.webOrigin ?? GITHUB_WEB_ORIGIN;
	const url = `${webOrigin}/${RELEASE_REPO}/releases/latest`;
	const response = await fetchImpl(url, {
		method: "HEAD",
		headers: { "User-Agent": "gjc-update" },
		signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
		redirect: "manual",
	});
	// `redirect: "manual"` keeps the 302 and its Location; a runtime that follows
	// it anyway still exposes the resolved tag URL through `response.url`.
	const location = response.headers.get("location") ?? (response.redirected ? response.url : undefined);
	if (!location) {
		throw new Error(`${url} responded ${response.status} without a release redirect`);
	}
	const target = new URL(location, url);
	// The redirect decides which tag gets installed, so it must stay on the
	// release origin and repository it was issued for; an off-origin Location
	// would let a hijacked hop name any tag and choose the downloaded binary.
	const expectedPrefix = `/${RELEASE_REPO}/releases/tag/`;
	if (target.origin !== new URL(webOrigin).origin || !target.pathname.startsWith(expectedPrefix)) {
		throw new Error(`Refusing a GitHub release redirect outside ${webOrigin}${expectedPrefix}: ${target.href}`);
	}
	const tag = decodeURIComponent(target.pathname.slice(expectedPrefix.length));
	if (!isSafeReleaseTag(tag)) throw new Error(`Refusing unsafe GitHub release tag: ${tag || "<empty>"}`);
	if (!STABLE_VERSION_RE.test(versionFromTag(tag))) {
		throw new Error(`GitHub release ${tag} is not a stable vX.Y.Z release`);
	}
	return tag;
}

export async function fetchGithubChannelRelease(options: GithubReleaseLookupOptions = {}): Promise<GithubReleaseInfo> {
	const channel = options.channel ?? "stable";
	const apiOrigin = options.apiOrigin ?? GITHUB_API_ORIGIN;
	if (channel === "nightly") {
		const url = `${apiOrigin}/repos/${RELEASE_REPO}/releases?per_page=40`;
		// Nightly has no unauthenticated web listing to fall back to, so a spent
		// budget can only be answered with the token hint.
		const payload = await readGithubJson(url, options).catch((error: unknown) => {
			if (error instanceof GithubApiStatusError && error.isRateLimited) {
				throw new Error(`${error.message}. ${TOKEN_HINT}`);
			}
			throw error;
		});
		if (!Array.isArray(payload)) {
			throw new Error(`${url} did not return a release list`);
		}
		for (const entry of payload) {
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as GithubReleaseJson;
			if (record.draft === true || record.prerelease !== true) continue;
			const tag = typeof record.tag_name === "string" ? record.tag_name : "";
			if (!isSafeReleaseTag(tag)) continue;
			const version = versionFromTag(tag);
			if (!NIGHTLY_VERSION_RE.test(version)) continue;
			return {
				tag,
				version,
				channel,
				htmlUrl: typeof record.html_url === "string" ? record.html_url : undefined,
				warnings: [],
			};
		}
		throw new Error(
			"The nightly channel has no published GitHub prerelease yet; it is populated by the scheduled nightly workflow.",
		);
	}
	const url = `${apiOrigin}/repos/${RELEASE_REPO}/releases/latest`;
	try {
		return parseRelease(await readGithubJson(url, options), "stable");
	} catch (error) {
		if (!(error instanceof GithubApiStatusError) || !error.isRateLimited) throw error;
		try {
			const tag = await resolveStableReleaseTagFromWeb(options);
			return {
				tag,
				version: versionFromTag(tag),
				channel: "stable",
				htmlUrl: `${options.webOrigin ?? GITHUB_WEB_ORIGIN}/${RELEASE_REPO}/releases/tag/${tag}`,
				warnings: [`${error.message}; resolved the latest stable tag through github.com instead. ${TOKEN_HINT}`],
			};
		} catch (fallbackError) {
			const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
			throw new Error(`${error.message}, and the github.com fallback failed: ${detail}. ${TOKEN_HINT}`);
		}
	}
}

export function parseChecksumForAsset(text: string, assetName: string): string | undefined {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^([a-fA-F0-9]{64}) [ *](.+)$/);
		if (!match) continue;
		const name = path.posix.basename(match[2]!.replace(/^\.\//, ""));
		if (name === assetName) return match[1]!.toLowerCase();
	}
	return undefined;
}

export function parseManifestChecksum(payload: unknown, assetName: string): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const binaries = (payload as { binaries?: unknown }).binaries;
	if (!Array.isArray(binaries)) return undefined;
	for (const entry of binaries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as { name?: unknown; sha256?: unknown };
		if (record.name === assetName && typeof record.sha256 === "string" && SHA256_RE.test(record.sha256)) {
			return record.sha256;
		}
	}
	return undefined;
}

export function sha256Buffer(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
	const bytes = await fs.promises.readFile(filePath);
	return sha256Buffer(bytes);
}

export async function fetchOptionalText(
	url: string,
	options: { fetchImpl?: GithubFetch; lookupEnv?: (name: string) => string | undefined; timeoutMs?: number } = {},
): Promise<string | undefined> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(url, {
		headers: githubReleaseHeaders(undefined),
		signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
		redirect: "follow",
	});
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`${url} responded ${response.status}`);
	return await response.text();
}

export async function verifyDownloadedBinaryChecksum(options: {
	tag: string;
	assetName: string;
	filePath: string;
	fetchImpl?: GithubFetch;
	lookupEnv?: (name: string) => string | undefined;
	downloadOrigin?: string;
}): Promise<"verified"> {
	const origin = options.downloadOrigin ?? GITHUB_RELEASE_DOWNLOAD_ORIGIN;
	const sumsUrl = `${origin}/${options.tag}/${BINARY_SHA256_ASSET}`;
	const manifestUrl = `${origin}/${options.tag}/${BINARY_MANIFEST_ASSET}`;
	const actual = await sha256File(options.filePath);
	const sums = await fetchOptionalText(sumsUrl, options);
	if (sums !== undefined) {
		const expected = parseChecksumForAsset(sums, options.assetName);
		if (!expected || expected !== actual) {
			throw new Error(
				`Checksum mismatch for ${options.assetName}: expected ${expected ?? "<missing>"}, got ${actual}`,
			);
		}
		return "verified";
	}
	const manifestText = await fetchOptionalText(manifestUrl, options);
	if (manifestText !== undefined) {
		let payload: unknown;
		try {
			payload = JSON.parse(manifestText);
		} catch {
			throw new Error(`Release checksum manifest ${BINARY_MANIFEST_ASSET} was not valid JSON`);
		}
		const expected = parseManifestChecksum(payload, options.assetName);
		if (!expected || expected !== actual) {
			throw new Error(
				`Checksum mismatch for ${options.assetName}: expected ${expected ?? "<missing>"}, got ${actual}`,
			);
		}
		return "verified";
	}
	throw new Error(`Release ${options.tag} has no checksum assets; refusing to install an unsigned binary`);
}
