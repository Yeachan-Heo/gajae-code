import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getConfigAgentDirName, getProjectDir } from "@gajae-code/utils";
import { expandTilde } from "./tools/path-utils";

export * from "./config/config-file";

const USER_CONFIG_PRIORITY = [{ dir: CONFIG_DIR_NAME, globalAgentDir: getConfigAgentDirName }, { dir: ".gemini" }];

const PROJECT_CONFIG_PRIORITY = [{ dir: CONFIG_DIR_NAME }, { dir: ".gemini" }];

// =============================================================================
// Package Directory (for optional external docs/examples)
// =============================================================================

/**
 * Get the base directory for resolving optional package assets (docs, examples).
 * Walk up from import.meta.dir until we find package.json, or fall back to cwd.
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.GJC_PACKAGE_DIR ?? process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return expandTilde(envDir);
	}

	let dir = import.meta.dir;
	while (dir !== path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	// Fallback to project dir (docs/examples won't be found, but that's fine)
	return getProjectDir();
}

/** Get path to CHANGELOG.md (optional, may not exist in binary) */
export function getChangelogPath(): string {
	return path.resolve(path.join(getPackageDir(), "CHANGELOG.md"));
}

// =============================================================================
// Multi-Config Directory Helpers
// =============================================================================

/**
 * Config directory bases in priority order (highest first).
 * User-level: ~/.gjc/agent, ~/.gemini
 * Project-level: .gjc, .gemini
 */
const USER_CONFIG_BASES = USER_CONFIG_PRIORITY.map(({ dir, globalAgentDir }) => ({
	base: () => path.join(os.homedir(), globalAgentDir ? globalAgentDir() : dir),
	name: dir,
}));

const PROJECT_CONFIG_BASES = PROJECT_CONFIG_PRIORITY.map(({ dir }) => ({
	base: dir,
	name: dir,
}));

export interface ConfigDirEntry {
	path: string;
	source: string; // e.g. ".gjc"
	level: "user" | "project";
}

export interface GetConfigDirsOptions {
	/** Include user-level directories (~/.gjc/agent/...). Default: true */
	user?: boolean;
	/** Include project-level directories (.gjc/...). Default: true */
	project?: boolean;
	/** Current working directory for project paths. Default: getProjectDir() */
	cwd?: string;
	/** Only return directories that exist. Default: false */
	existingOnly?: boolean;
}

/**
 * Get all config directories for a subpath, ordered by priority (highest first).
 *
 * @param subpath - Subpath within config dirs (e.g., "commands", "hooks", "agents")
 * @param options - Options for filtering
 * @returns Array of directory entries, highest priority first
 *
 * @example
 * // Get all command directories
 * getConfigDirs("commands")
 * // → [{ path: "~/.gjc/agent/commands", source: ".gjc", level: "user" }, ...]
 *
 * @example
 * // Get only existing project skill directories
 * getConfigDirs("skills", { user: false, existingOnly: true })
 */
export function getConfigDirs(subpath: string, options: GetConfigDirsOptions = {}): ConfigDirEntry[] {
	const { user = true, project = true, cwd = getProjectDir(), existingOnly = false } = options;
	const results: ConfigDirEntry[] = [];

	// User-level directories (highest priority)
	if (user) {
		for (const { base, name } of USER_CONFIG_BASES) {
			const resolvedPath = path.resolve(base(), subpath);
			if (!existingOnly || fs.existsSync(resolvedPath)) {
				results.push({ path: resolvedPath, source: name, level: "user" });
			}
		}
	}

	// Project-level directories
	if (project) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			const resolvedPath = path.resolve(cwd, base, subpath);
			if (!existingOnly || fs.existsSync(resolvedPath)) {
				results.push({ path: resolvedPath, source: name, level: "project" });
			}
		}
	}

	return results;
}

/**
 * Get all config directory paths for a subpath (convenience wrapper).
 * Returns just the paths, highest priority first.
 */
export function getConfigDirPaths(subpath: string, options: GetConfigDirsOptions = {}): string[] {
	return getConfigDirs(subpath, options).map(e => e.path);
}

export interface ConfigFileResult<T> {
	path: string;
	source: string;
	level: "user" | "project";
	content: T;
}

/**
 * Find the first existing config file (for non-JSON files like SYSTEM.md).
 * Returns just the path, or undefined if not found.
 */
export function findConfigFile(subpath: string, options: GetConfigDirsOptions = {}): string | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base } of dirs) {
		const filePath = path.join(base, subpath);
		if (fs.existsSync(filePath)) {
			return filePath;
		}
	}

	return undefined;
}

/**
 * Find the first existing config file with metadata.
 */
export function findConfigFileWithMeta(
	subpath: string,
	options: GetConfigDirsOptions = {},
): Omit<ConfigFileResult<never>, "content"> | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base, source, level } of dirs) {
		const filePath = path.join(base, subpath);
		if (fs.existsSync(filePath)) {
			return { path: filePath, source, level };
		}
	}

	return undefined;
}

// =============================================================================
// Walk-Up Config Discovery (for monorepo scenarios)
// =============================================================================

/**
 * Find all nearest config directories by walking up from cwd.
 * Returns one entry per config base (.gjc, .Anthropic model) - the nearest one found.
 * Results are in priority order (highest first).
 */
export function findAllNearestProjectConfigDirs(subpath: string, cwd: string = getProjectDir()): ConfigDirEntry[] {
	const results: ConfigDirEntry[] = [];
	const foundBases = new Set<string>();

	let currentDir = cwd;

	while (foundBases.size < PROJECT_CONFIG_BASES.length) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			if (foundBases.has(name)) continue;

			const candidate = path.join(currentDir, base, subpath);
			try {
				if (fs.statSync(candidate).isDirectory()) {
					results.push({ path: candidate, source: name, level: "project" });
					foundBases.add(name);
				}
			} catch {}
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	// Sort by priority order
	const order = PROJECT_CONFIG_BASES.map(b => b.name);
	results.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));

	return results;
}
