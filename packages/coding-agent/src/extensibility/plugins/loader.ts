/**
 * Plugin loader - discovers and loads manifest entry points from installed plugins.
 *
 * Reads enabled plugins from the runtime config and loads their
 * tools/hooks/extensions/commands based on manifest entries and enabled features.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { getConfigDirPaths } from "../../config";
import { installLegacyPiSpecifierShim } from "./legacy-pi-compat";
import { getProfilePluginsDir } from "./marketplace/registry";
import type { InstalledPlugin, PluginManifest, PluginRuntimeConfig, ProjectPluginOverrides } from "./types";

installLegacyPiSpecifierShim();

// =============================================================================
// Runtime Config Loading
// =============================================================================

/**
 * Load plugin runtime config from lock file.
 */
async function loadRuntimeConfig(
	agentDir?: string,
	profileAuthority: "default" | "custom" = agentDir ? "custom" : "default",
): Promise<PluginRuntimeConfig> {
	const lockPath = path.join(getProfilePluginsDir(agentDir, profileAuthority), "gjc-plugins.lock.json");
	try {
		return await Bun.file(lockPath).json();
	} catch (err) {
		if (isEnoent(err)) return { plugins: {}, settings: {} };
		throw err;
	}
}

/**
 * Load project-local plugin overrides (checks .gjc and .pi directories).
 */
async function loadProjectOverrides(cwd: string): Promise<ProjectPluginOverrides> {
	for (const overridesPath of getConfigDirPaths("plugin-overrides.json", { user: false, cwd })) {
		try {
			return await Bun.file(overridesPath).json();
		} catch (err) {
			if (isEnoent(err)) continue;
			// JSON parse error - continue to next path
		}
	}
	return {};
}
/**
 * Get list of enabled plugins with their resolved configurations.
 * Respects both global runtime config and project overrides.
 */
export async function getEnabledPlugins(
	cwd: string,
	agentDir?: string,
	profileAuthority: "default" | "custom" = agentDir ? "custom" : "default",
): Promise<InstalledPlugin[]> {
	const pluginsDir = getProfilePluginsDir(agentDir, profileAuthority);
	const pkgJsonPath = path.join(pluginsDir, "package.json");
	let pkg: { dependencies?: Record<string, string> };
	try {
		pkg = await Bun.file(pkgJsonPath).json();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const nodeModulesPath = path.join(pluginsDir, "node_modules");
	if (!fs.existsSync(nodeModulesPath)) {
		return [];
	}

	const deps = pkg.dependencies || {};
	const runtimeConfig = await loadRuntimeConfig(agentDir, profileAuthority);
	const projectOverrides = await loadProjectOverrides(cwd);
	const plugins: InstalledPlugin[] = [];
	for (const [name] of Object.entries(deps)) {
		const pluginPkgPath = path.join(nodeModulesPath, name, "package.json");
		let pluginPkg: { version: string; gjc?: PluginManifest; pi?: PluginManifest };
		try {
			pluginPkg = await Bun.file(pluginPkgPath).json();
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}

		const manifest: PluginManifest | undefined = pluginPkg.gjc || pluginPkg.pi;

		if (!manifest) {
			// Not an gjc plugin, skip
			continue;
		}

		manifest.version = pluginPkg.version;

		const runtimeState = runtimeConfig.plugins[name];

		// Check if disabled globally
		if (runtimeState && !runtimeState.enabled) {
			continue;
		}

		// Check if disabled in project
		if (projectOverrides.disabled?.includes(name)) {
			continue;
		}

		// Resolve enabled features (project overrides take precedence)
		const enabledFeatures = projectOverrides.features?.[name] ?? runtimeState?.enabledFeatures ?? null;
		plugins.push({
			name,
			version: pluginPkg.version,
			path: path.join(nodeModulesPath, name),
			manifest,
			enabledFeatures,
			enabled: true,
		});
	}

	return plugins;
}

// =============================================================================
// Path Resolution
// =============================================================================

const MANIFEST_ENTRY_INDEX_NAMES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

/**
 * Resolve a plugin manifest entry to a concrete loadable file path. Returns the
 * file path itself when the entry points at a file, the matching index file when
 * the entry points at a directory containing index.{ts,js,mjs,cjs}, and null
 * when no entry exists at the joined path.
 */
function resolveManifestEntryFile(joined: string): string | null {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(joined);
	} catch {
		return null;
	}
	if (stats.isDirectory()) {
		for (const name of MANIFEST_ENTRY_INDEX_NAMES) {
			const candidate = path.join(joined, name);
			if (fs.existsSync(candidate)) return candidate;
		}
		return null;
	}
	return joined;
}

/**
 * Generic path resolver for plugin manifest entries (tools, hooks, commands, extensions).
 * Handles both single-string and string[] base entries, plus feature-specific entries.
 */
function resolvePluginPaths(plugin: InstalledPlugin, key: "tools" | "hooks" | "commands" | "extensions"): string[] {
	const paths: string[] = [];
	const manifest = plugin.manifest;

	// Base entry (always included if exists)
	const base = manifest[key];
	if (base) {
		const entries = Array.isArray(base) ? base : [base];
		for (const entry of entries) {
			const resolved = resolveManifestEntryFile(path.join(plugin.path, entry));
			if (resolved) {
				paths.push(resolved);
			}
		}
	}

	// Feature-specific entries
	if (manifest.features && plugin.enabledFeatures) {
		const enabledSet = new Set(plugin.enabledFeatures);

		for (const [featName, feat] of Object.entries(manifest.features)) {
			if (!enabledSet.has(featName)) continue;

			if (feat[key]) {
				for (const entry of feat[key]) {
					const resolved = resolveManifestEntryFile(path.join(plugin.path, entry));
					if (resolved) {
						paths.push(resolved);
					}
				}
			}
		}
	} else if (manifest.features && plugin.enabledFeatures === null) {
		// null means use defaults - enable features with default: true
		for (const [_featName, feat] of Object.entries(manifest.features)) {
			if (!feat.default) continue;

			if (feat[key]) {
				for (const entry of feat[key]) {
					const resolved = resolveManifestEntryFile(path.join(plugin.path, entry));
					if (resolved) {
						paths.push(resolved);
					}
				}
			}
		}
	}

	return paths;
}

export function resolvePluginToolPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "tools");
}

export function resolvePluginHookPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "hooks");
}

export function resolvePluginCommandPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "commands");
}

export function resolvePluginExtensionPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "extensions");
}

// =============================================================================
// Aggregated Discovery
// =============================================================================

/**
 * Get all tool paths from all enabled plugins.
 */
export async function getAllPluginToolPaths(
	cwd: string,
	agentDir?: string,
	profileAuthority?: "default" | "custom",
): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd, agentDir, profileAuthority ?? (agentDir ? "custom" : "default"));
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginToolPaths(plugin));
	}

	return paths;
}

/**
 * Get all hook paths from all enabled plugins.
 */
export async function getAllPluginHookPaths(
	cwd: string,
	agentDir?: string,
	profileAuthority?: "default" | "custom",
): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd, agentDir, profileAuthority ?? (agentDir ? "custom" : "default"));
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginHookPaths(plugin));
	}

	return paths;
}

/**
 * Get all command paths from all enabled plugins.
 */
export async function getAllPluginCommandPaths(
	cwd: string,
	agentDir?: string,
	profileAuthority?: "default" | "custom",
): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd, agentDir, profileAuthority ?? (agentDir ? "custom" : "default"));
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginCommandPaths(plugin));
	}

	return paths;
}

/**
 * Get all extension module paths from all enabled plugins.
 */
export async function getAllPluginExtensionPaths(
	cwd: string,
	agentDir?: string,
	profileAuthority?: "default" | "custom",
): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd, agentDir, profileAuthority ?? (agentDir ? "custom" : "default"));
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginExtensionPaths(plugin));
	}

	return paths;
}

/**
 * Get plugin settings for use in tool/hook contexts.
 * Merges global settings with project overrides.
 */
export async function getPluginSettings(
	pluginName: string,
	cwd: string,
	agentDir?: string,
): Promise<Record<string, unknown>> {
	const runtimeConfig = await loadRuntimeConfig(agentDir);
	const projectOverrides = await loadProjectOverrides(cwd);

	const global = runtimeConfig.settings[pluginName] || {};
	const project = projectOverrides.settings?.[pluginName] || {};

	return { ...global, ...project };
}
