/**
 * Source resolver for marketplace plugin entries.
 *
 * Resolves plugin sources to absolute local directory paths:
 *   - Relative string "./plugins/foo" → path within marketplace clone
 *   - { source: "url", url: "https://...git" } → git clone
 *   - { source: "github", repo: "owner/repo" } → git clone from GitHub
 *   - { source: "git-subdir", url: "...", path: "sub/dir" } → git clone + subdir
 *   - { source: "npm", ... } → not yet supported
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isEnoent, pathIsWithin } from "@gajae-code/utils";
import * as git from "../../../utils/git";

import type { MarketplaceCatalogMetadata, MarketplacePluginEntry, PluginSource } from "./types";

export interface ResolveContext {
	/** Absolute path to the cloned/local marketplace directory. Required for relative sources. */
	marketplaceClonePath?: string;
	/** Catalog metadata — used for `pluginRoot` prepend. */
	catalogMetadata?: MarketplaceCatalogMetadata;
	/** Scratch directory for sources that require cloning or extraction. */
	tmpDir: string;
}

export function sourcePin(source: PluginSource): { ref?: string; sha?: string; immutable: boolean } {
	if (typeof source === "string") return { immutable: false };
	if (source.source === "npm") return { immutable: false };
	return {
		ref: source.ref,
		sha: source.sha,
		immutable: typeof source.sha === "string" && /^[a-f0-9]{40}$/i.test(source.sha),
	};
}

export function assertPinnedSource(source: PluginSource): void {
	const pin = sourcePin(source);
	if (!pin.immutable) throw new Error("marketplace restore requires an immutable source SHA");
}

/**
 * Independently verify that a resolved git checkout's HEAD matches the pinned
 * SHA the plan/token claims to restore. `git.clone` already checks out the
 * exact SHA, but this re-derives the fact from the checkout itself (a fresh
 * `rev-parse HEAD` in the resolved directory) rather than trusting whatever
 * the resolver returned, so a resolver bug or a swapped working tree cannot
 * silently mismatch source and to-be-published bytes.
 */
export async function verifyResolvedProvenance(resolvedDir: string, expectedSha: string): Promise<boolean> {
	const actual = await git.head.sha(resolvedDir).catch(() => null);
	return typeof actual === "string" && actual.toLowerCase() === expectedSha.toLowerCase();
}

/**
 * Resolve a plugin source to an absolute local directory path.
 *
 * The resolved path is verified to exist on disk.
 */
export async function resolvePluginSource(
	entry: MarketplacePluginEntry,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	const { source } = entry;

	if (typeof source === "string") {
		return resolveRelativeSource(source, context);
	}

	return resolveObjectSource(source, context);
}

// ── Relative string source ("./plugins/foo") ────────────────────────

async function resolveRelativeSource(
	source: string,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	if (!source.startsWith("./")) {
		throw new Error(`Relative plugin source paths must start with "./" — got: "${source}"`);
	}

	if (!context.marketplaceClonePath) {
		throw new Error(`Cannot resolve relative source "${source}": marketplaceClonePath is required`);
	}

	// If pluginRoot is set, prepend it to the path segment after "./"
	const pluginRoot = context.catalogMetadata?.pluginRoot;
	const relativePath = pluginRoot ? `./${path.join(pluginRoot, source.slice(2))}` : source;

	// Resolve against marketplace root (not the .Anthropic model-plugin/ catalog subdirectory)
	const resolved = path.resolve(context.marketplaceClonePath, relativePath);
	const outsideRoot = `Plugin source "${source}" resolves outside marketplace root ("${context.marketplaceClonePath}")`;

	if (!pathIsWithin(context.marketplaceClonePath, resolved)) throw new Error(outsideRoot);
	await assertCanonicalContainment(context.marketplaceClonePath, resolved, outsideRoot);

	await verifyDirExists(resolved, `Plugin source directory does not exist: "${resolved}"`);
	return { dir: resolved };
}

// ── Object source variants ──────────────────────────────────────────

async function resolveObjectSource(
	source: Exclude<PluginSource, string>,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	switch (source.source) {
		case "url": {
			// { source: "url", url: "https://github.com/owner/repo.git" }
			// Despite the name, this is typically a git clone URL
			const targetDir = path.join(context.tmpDir, `plugin-${crypto.randomUUID()}`);
			await git.clone(assertCloneUrl(source.url), targetDir, { ref: source.ref, sha: source.sha });
			return { dir: targetDir, tempCloneRoot: targetDir };
		}

		case "github": {
			// { source: "github", repo: "owner/repo" }
			const url = `https://github.com/${assertRepoSlug(source.repo)}.git`;
			const targetDir = path.join(context.tmpDir, `plugin-${crypto.randomUUID()}`);
			await git.clone(url, targetDir, { ref: source.ref, sha: source.sha });
			return { dir: targetDir, tempCloneRoot: targetDir };
		}

		case "git-subdir": {
			// { source: "git-subdir", url: "owner/repo" | "https://...", path: "plugins/foo" }
			const url =
				source.url.includes("://") || source.url.startsWith("git@")
					? assertCloneUrl(source.url)
					: `https://github.com/${assertRepoSlug(source.url)}.git`;
			assertSubdirPath(source.path);
			const cloneDir = path.join(context.tmpDir, `plugin-repo-${crypto.randomUUID()}`);
			await git.clone(url, cloneDir, { ref: source.ref, sha: source.sha });

			const subdirPath = path.resolve(cloneDir, source.path);
			const escapes = `git-subdir path "${source.path}" escapes the cloned repository`;
			if (!pathIsWithin(cloneDir, subdirPath)) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw new Error(escapes);
			}
			try {
				await assertCanonicalContainment(cloneDir, subdirPath, escapes);
				await verifyDirExists(subdirPath, `git-subdir path "${source.path}" does not exist in cloned repository`);
			} catch (err) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw err;
			}
			return { dir: subdirPath, tempCloneRoot: cloneDir };
		}

		case "npm":
			throw new Error("npm plugin sources are not yet supported. Use git-based sources instead.");

		default:
			throw new Error(`Unknown plugin source type: "${(source as { source: string }).source}"`);
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Network transports a plugin source may be fetched over. */
const CLONE_URL_SCHEME = /^(?:https|http|git|ssh|file):\/\//;
/** scp-like `user@host:path`, which git accepts without a scheme. */
const SCP_LIKE_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/;
/** `git-remote-<helper>` dispatch (`ext::sh -c ...`), i.e. arbitrary command execution. */
const REMOTE_HELPER_URL = /^[A-Za-z0-9][A-Za-z0-9+.-]*::/;
/** `owner/repo` as GitHub itself accepts it; no options, no path traversal, no separators. */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A catalog is untrusted input, and its URL goes straight to `git clone`.
 *
 * Two shapes are dangerous on their own: a value starting with `-`, which git
 * reads as an option (`--upload-pack=<cmd>` is command execution), and a
 * remote-helper URL such as `ext::sh -c ...`, which git dispatches to
 * `git-remote-ext` and which executes its argument by design. `git.clone` also
 * passes `--` before the URL, but that only closes the first hole and only for
 * callers that go through it, so both are refused here where the failure can
 * name the offending catalog entry.
 *
 * Local absolute paths stay allowed: a privately hosted marketplace pointing at
 * an on-disk repository is a supported layout.
 */
function assertCloneUrl(url: string): string {
	const supported =
		!url.startsWith("-") &&
		!REMOTE_HELPER_URL.test(url) &&
		(CLONE_URL_SCHEME.test(url) || SCP_LIKE_URL.test(url) || path.isAbsolute(url));
	if (!supported)
		throw new Error(
			`Plugin source URL must be an https/http/git/ssh/file URL, a user@host:path remote, or an absolute local path — got: "${url}"`,
		);
	return url;
}

function assertRepoSlug(repo: string): string {
	if (!REPO_SLUG.test(repo)) throw new Error(`Plugin source repository must be "owner/repo" — got: "${repo}"`);
	return repo;
}

/** The subdir is joined into a clone path, so it must be a plain relative path. */
function assertSubdirPath(subdir: string): string {
	if (subdir.startsWith("-") || path.isAbsolute(subdir) || path.win32.isAbsolute(subdir))
		throw new Error(`git-subdir path must be a relative path — got: "${subdir}"`);
	return subdir;
}

/**
 * Decide containment on canonical paths, and fail closed when they cannot be
 * derived.
 *
 * A catalog is untrusted input and controls the tree it ships, so the plugin
 * directory it names can be a symlink pointing out of the marketplace root.
 * `pathIsWithin` does resolve symlinks, but it silently degrades to a lexical
 * comparison whenever `realpath` fails — a dangling or looping link therefore
 * passes the containment gate and is only rejected later (or not at all) by the
 * existence probe, which follows symlinks itself. Here both sides must
 * canonicalize successfully. A candidate that exists as a directory entry but
 * cannot be canonicalized (dangling or looping link) is classified as an
 * untrusted source; a path that is simply absent is left to the existence probe
 * so a missing plugin still reports as missing.
 */
async function assertCanonicalContainment(root: string, candidate: string, errorMessage: string): Promise<void> {
	const canonicalRoot = await fs.realpath(root).catch(() => undefined);
	if (canonicalRoot === undefined) throw new Error(errorMessage);
	const canonicalCandidate = await fs.realpath(candidate).catch(() => undefined);
	if (canonicalCandidate === undefined) {
		const entryExists = await fs
			.lstat(candidate)
			.then(() => true)
			.catch(() => false);
		if (entryExists) throw new Error(errorMessage);
		return;
	}
	if (!pathIsWithin(canonicalRoot, canonicalCandidate)) throw new Error(errorMessage);
}

async function verifyDirExists(dirPath: string, errorMessage: string): Promise<void> {
	try {
		const stat = await fs.stat(dirPath);
		if (!stat.isDirectory()) {
			throw new Error(errorMessage);
		}
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(errorMessage);
		}
		throw err;
	}
}
