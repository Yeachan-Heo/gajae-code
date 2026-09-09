/**
 * Plugin cache management.
 *
 * Cache layout: `<cacheDir>/<marketplace>___<pluginName>___<version>/`
 *
 * All three components are validated before any filesystem operation:
 *   - marketplace / pluginName: isValidNameSegment (lowercase alnum + hyphens, max 64)
 *   - version: isValidVersionForCache (alnum + ._+-, max 128)
 *
 * This ensures cache paths cannot be crafted to escape the cache directory.
 */

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { isValidNameSegment } from "./types";

// Reject anything that could be used for path traversal or shell injection in
// version strings. Only printable, unambiguous characters are allowed.
const VERSION_RE = /^[a-zA-Z0-9._+-]+$/;

/** Return true when `version` is safe for use as a cache path component. */
export function isValidVersionForCache(version: string): boolean {
	// prevent path-traversal sequences like ".." or "1..2"
	return version.length > 0 && version.length <= 128 && VERSION_RE.test(version) && !version.includes("..");
}

function validateCacheComponents(marketplace: string, pluginName: string, version: string): void {
	if (!isValidNameSegment(marketplace)) {
		throw new Error(`Invalid marketplace name for cache: "${marketplace}"`);
	}
	if (!isValidNameSegment(pluginName)) {
		throw new Error(`Invalid plugin name for cache: "${pluginName}"`);
	}
	if (!isValidVersionForCache(version)) {
		throw new Error(`Invalid version for cache: "${version}"`);
	}
}

/**
 * Return the absolute path for a cached plugin directory.
 * Throws if any component fails validation.
 */
export function getCachedPluginPath(
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): string {
	validateCacheComponents(marketplace, pluginName, version);
	return path.join(cacheDir, `${marketplace}___${pluginName}___${version}`);
}

/**
 * Copy `sourcePath` into the cache, returning the absolute cache path.
 *
 * Idempotent: if the target already exists it is removed before copying,
 * so a partial previous cache is never silently reused.
 */
export async function cachePlugin(
	sourcePath: string,
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): Promise<string> {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);

	// Ensure cache directory exists before writing into it
	await fs.mkdir(cacheDir, { recursive: true });

	// Copy to a staging directory first, then atomically rename into place.
	// This prevents destroying an active install if fs.cp fails mid-copy.
	const stagingPath = `${targetPath}.staging-${Date.now()}`;
	try {
		await fs.cp(sourcePath, stagingPath, { recursive: true });
		await fs.rm(targetPath, { recursive: true, force: true });
		await fs.rename(stagingPath, targetPath);
	} catch (err) {
		// Clean up staging dir on any failure; leave existing targetPath intact
		await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
		throw err;
	}

	return targetPath;
}

export async function stageCachedPlugin(sourcePath: string, stagingPath: string): Promise<string> {
	await fs.rm(stagingPath, { recursive: true, force: true });
	await fs.cp(sourcePath, stagingPath, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
	return stagingPath;
}

export async function digestCachedPlugin(targetPath: string): Promise<string | undefined> {
	const hash = createHash("sha256");
	const walk = async (root: string, rel = ""): Promise<void> => {
		const entries = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const childRel = rel ? path.join(rel, entry.name) : entry.name;
			const child = path.join(root, entry.name);
			const stat = await fs.lstat(child);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("unsafe cache artifact");
			// Reject a regular file with more than one hard link: its bytes could be
			// mutated through a second pathname we never inspected, so a digest taken
			// here would not be provably bound to the artifact this walk actually saw.
			// Directory entries never carry meaningful hard-link counts on POSIX
			// (nlink for a directory reflects '.'/subdir back-references), so this
			// check applies only to regular files.
			if (stat.isFile() && stat.nlink > 1) throw new Error("unsafe cache artifact: multiply-linked file");
			if (stat.isDirectory()) await walk(child, childRel);
			else {
				hash.update(childRel);
				hash.update("\0");
				hash.update(await fs.readFile(child));
				hash.update("\0");
			}
		}
	};
	try {
		await walk(targetPath);
		return hash.digest("hex");
	} catch (error) {
		hash.digest();
		if (isEnoent(error)) return undefined;
		return undefined;
	}
}

export async function inspectCachedPlugin(
	targetPath: string,
): Promise<{ status: "present" | "absent" | "unreadable"; digest?: string }> {
	try {
		const stat = await fs.lstat(targetPath);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: "unreadable" };
		const digest = await digestCachedPlugin(targetPath);
		return digest ? { status: "present", digest } : { status: "unreadable" };
	} catch (error) {
		return isEnoent(error) ? { status: "absent" } : { status: "unreadable" };
	}
}

/**
 * Synchronous check — true when the cache directory exists on disk.
 * Uses `existsSync` because callers may need to run this check inline without async.
 */
export function isCached(cacheDir: string, marketplace: string, pluginName: string, version: string): boolean {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);
	return nodeFs.existsSync(targetPath);
}

/** Remove a single cached plugin directory. No-op if it does not exist. */
export async function removeCachedPlugin(
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): Promise<void> {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);
	await fs.rm(targetPath, { recursive: true, force: true });
}

/**
 * Remove all cache entries whose full path is not in `installedPaths`.
 *
 * Returns the count of removed directories. If `cacheDir` does not exist,
 * returns `{ removed: 0 }` rather than throwing.
 */
export async function cleanOrphanedCache(cacheDir: string, installedPaths: Set<string>): Promise<{ removed: number }> {
	let entries: string[];
	try {
		entries = await fs.readdir(cacheDir);
	} catch (err) {
		if (isEnoent(err)) return { removed: 0 };
		throw err;
	}

	let removed = 0;
	for (const entry of entries) {
		const fullPath = path.join(cacheDir, entry);
		if (!installedPaths.has(fullPath)) {
			await fs.rm(fullPath, { recursive: true, force: true });
			removed++;
		}
	}

	return { removed };
}
