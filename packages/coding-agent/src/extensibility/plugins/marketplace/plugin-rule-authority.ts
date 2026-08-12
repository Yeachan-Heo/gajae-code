/**
 * Hash-bound marketplace rule authority.
 *
 * Plugin rule discovery never treats a repo-editable installPath as a root.
 * Authority is granted only when:
 *   1. the registry entry's installPath equals the manager-owned cache identity
 *      `<cacheDir>/<marketplace>___<plugin>___<version>`
 *   2. the cache root is a real directory (no symlink/junction)
 *   3. the recorded tree digest matches the live tree
 *   4. an explicit trustGrant is present
 */
import * as crypto from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@gajae-code/utils";
import { getCachedPluginPath } from "./cache";
import type { InstalledPluginEntry } from "./types";
import { parsePluginId } from "./types";

export const PLUGIN_RULE_TRUST_GRANT = "gjc-marketplace-rule-authority.v1" as const;
export const PLUGIN_TREE_DIGEST_VERSION = 1 as const;

export interface PluginTreeDigest {
	version: typeof PLUGIN_TREE_DIGEST_VERSION;
	algorithm: "sha256";
	hex: string;
}

export interface TrustedPluginRuleRoot {
	id: string;
	marketplace: string;
	plugin: string;
	version: string;
	path: string;
	scope: "user" | "project";
	treeDigest: PluginTreeDigest;
}

export function computePluginTreeDigest(
	files: ReadonlyArray<{ relativePath: string; bytes: Uint8Array }>,
): PluginTreeDigest {
	const hasher = crypto.createHash("sha256");
	const sorted = [...files].sort((a, b) =>
		a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
	);
	for (const file of sorted) {
		hasher.update(file.relativePath.replaceAll("\\", "/"));
		hasher.update("\0");
		hasher.update(Buffer.from(file.bytes));
		hasher.update("\0");
	}
	return { version: PLUGIN_TREE_DIGEST_VERSION, algorithm: "sha256", hex: hasher.digest("hex") };
}

export async function hashPluginTree(root: string): Promise<PluginTreeDigest> {
	const files: Array<{ relativePath: string; bytes: Uint8Array }> = [];
	await walkRegularFiles(root, root, files);
	return computePluginTreeDigest(files);
}

async function walkRegularFiles(
	root: string,
	dir: string,
	out: Array<{ relativePath: string; bytes: Uint8Array }>,
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	for (const entry of entries) {
		const abs = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			await walkRegularFiles(root, abs, out);
			continue;
		}
		if (!entry.isFile()) continue;
		out.push({
			relativePath: path.relative(root, abs),
			bytes: new Uint8Array(await fs.readFile(abs)),
		});
	}
}

export async function resolveTrustedPluginRuleRoot(
	pluginId: string,
	entry: InstalledPluginEntry,
	cacheDir: string,
): Promise<{ root?: TrustedPluginRuleRoot; warning?: string }> {
	const parsed = parsePluginId(pluginId);
	if (!parsed) {
		return { warning: `Invalid plugin ID format (missing @marketplace): ${pluginId}` };
	}
	if (entry.enabled === false) {
		return {};
	}
	if (entry.trustGrant !== PLUGIN_RULE_TRUST_GRANT) {
		return { warning: `Plugin ${pluginId} has no explicit marketplace rule trust grant` };
	}
	if (
		!entry.treeDigest ||
		entry.treeDigest.version !== PLUGIN_TREE_DIGEST_VERSION ||
		entry.treeDigest.algorithm !== "sha256"
	) {
		return { warning: `Plugin ${pluginId} is missing a recorded tree digest` };
	}

	let cachePath: string;
	try {
		cachePath = getCachedPluginPath(cacheDir, parsed.marketplace, parsed.name, entry.version);
	} catch {
		return { warning: `Plugin ${pluginId} has an invalid manager cache identity` };
	}
	if (path.resolve(entry.installPath) !== path.resolve(cachePath)) {
		return { warning: `Plugin ${pluginId} installPath is not the manager-owned cache identity` };
	}

	try {
		const stat = await fs.lstat(cachePath);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			return { warning: `Plugin ${pluginId} cache path is not a real directory` };
		}
	} catch (error) {
		if (isEnoent(error)) {
			return { warning: `Plugin ${pluginId} cache path is missing` };
		}
		throw error;
	}

	const liveDigest = await hashPluginTree(cachePath);
	if (liveDigest.hex !== entry.treeDigest.hex) {
		return { warning: `Plugin ${pluginId} tree digest does not match the recorded grant` };
	}

	logger.debug("Trusted plugin rule root admitted", { pluginId, cachePath, digest: liveDigest.hex });
	return {
		root: {
			id: pluginId,
			marketplace: parsed.marketplace,
			plugin: parsed.name,
			version: entry.version || "unknown",
			path: cachePath,
			scope: entry.scope || "user",
			treeDigest: liveDigest,
		},
	};
}
