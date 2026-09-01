/**
 * Registry read/write operations for the marketplace plugin system.
 *
 * Two registries:
 *   - marketplaces.json under getConfigRootDir() — which catalogs the user has added
 *   - installed_plugins.json under getPluginsDir() — which plugins are installed
 *
 * Read/write functions accept explicit file paths so callers control the
 * location. Path helpers accept the owning profile authority. The default
 * profile uses the resolver's XDG-aware roots; custom profiles write beside
 * their supplied agent directory. Authority is never inferred from a mutable
 * config root.
 *
 * Both use atomic write (tmp + rename). On Windows, rename over existing file
 * can fail with EPERM — fallback: unlink target then rename.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
	getAgentDir,
	getAgentProfileAuthority,
	getConfigRootDir,
	getDefaultPluginsDir,
	isEnoent,
	logger,
	tryParseJson,
} from "@gajae-code/utils";

import type {
	InstalledPluginEntry,
	InstalledPluginsRegistry,
	MarketplaceRegistryEntry,
	MarketplacesRegistry,
} from "./types";

// ── Path helpers ─────────────────────────────────────────────────────

export type ProfileAuthority = "default" | "custom";

function resolveProfileAuthority(
	agentDir: string | undefined,
	profileAuthority: ProfileAuthority | undefined,
): ProfileAuthority {
	// An explicit agent directory is caller-owned and therefore custom unless
	// the caller supplies the resolver's default authority explicitly. With no
	// directory, use the resolver's sticky process profile authority.
	return profileAuthority ?? (agentDir ? "custom" : getAgentProfileAuthority());
}

function resolveProfileAgentDir(agentDir: string | undefined): string {
	return agentDir ?? getAgentDir();
}

export function getProfilePluginsDir(agentDir?: string, profileAuthority?: ProfileAuthority): string {
	const authority = resolveProfileAuthority(agentDir, profileAuthority);
	if (authority === "custom") return path.join(resolveProfileAgentDir(agentDir), "plugins");
	return getDefaultPluginsDir();
}

export function getMarketplacesRegistryPath(agentDir?: string, profileAuthority?: ProfileAuthority): string {
	const authority = resolveProfileAuthority(agentDir, profileAuthority);
	if (authority === "custom") return path.join(resolveProfileAgentDir(agentDir), "marketplaces.json");
	return path.join(getConfigRootDir(), "marketplaces.json");
}

export function getInstalledPluginsRegistryPath(agentDir?: string, profileAuthority?: ProfileAuthority): string {
	return path.join(getProfilePluginsDir(agentDir, profileAuthority), "installed_plugins.json");
}

export function getMarketplacesCacheDir(agentDir?: string, profileAuthority?: ProfileAuthority): string {
	return path.join(getProfilePluginsDir(agentDir, profileAuthority), "cache", "marketplaces");
}

export function getPluginsCacheDir(agentDir?: string, profileAuthority?: ProfileAuthority): string {
	return path.join(getProfilePluginsDir(agentDir, profileAuthority), "cache", "plugins");
}

// ── Atomic write ─────────────────────────────────────────────────────

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const content = `${JSON.stringify(data, null, 2)}\n`;
	const tmpPath = `${filePath}.tmp`;

	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(tmpPath, content);

	try {
		await fs.rename(tmpPath, filePath);
	} catch (err) {
		// Windows EPERM fallback: unlink target, then rename
		if ((err as NodeJS.ErrnoException).code === "EPERM") {
			try {
				await fs.unlink(filePath);
			} catch {
				// Target may not exist — that's fine
			}
			await fs.rename(tmpPath, filePath);
		} else {
			// Clean up tmp on unexpected errors
			try {
				await fs.unlink(tmpPath);
			} catch {
				// Best effort
			}
			throw err;
		}
	}
}

// ── Marketplaces registry ────────────────────────────────────────────

function emptyMarketplacesRegistry(): MarketplacesRegistry {
	return { version: 1, marketplaces: [] };
}

export async function readMarketplacesRegistry(filePath: string): Promise<MarketplacesRegistry> {
	try {
		const content = await Bun.file(filePath).text();
		const data = tryParseJson<MarketplacesRegistry>(content);
		if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.marketplaces)) {
			logger.warn("Invalid marketplaces registry, returning empty", { path: filePath });
			return emptyMarketplacesRegistry();
		}
		return data;
	} catch (err) {
		if (isEnoent(err)) return emptyMarketplacesRegistry();
		throw err;
	}
}

export async function writeMarketplacesRegistry(filePath: string, reg: MarketplacesRegistry): Promise<void> {
	await atomicWriteJson(filePath, reg);
}

// ── Installed plugins registry ───────────────────────────────────────

function emptyInstalledPluginsRegistry(): InstalledPluginsRegistry {
	return { version: 2, plugins: {} };
}

export async function readInstalledPluginsRegistry(filePath: string): Promise<InstalledPluginsRegistry> {
	try {
		const content = await Bun.file(filePath).text();
		const data = tryParseJson<InstalledPluginsRegistry>(content);
		if (
			!data ||
			typeof data !== "object" ||
			typeof data.version !== "number" ||
			!data.plugins ||
			typeof data.plugins !== "object" ||
			Array.isArray(data.plugins)
		) {
			logger.warn("Invalid installed plugins registry, returning empty", { path: filePath });
			return emptyInstalledPluginsRegistry();
		}
		// Accept any numeric version — forward compatible reads
		return { ...data, version: 2 };
	} catch (err) {
		if (isEnoent(err)) return emptyInstalledPluginsRegistry();
		throw err;
	}
}

export async function writeInstalledPluginsRegistry(filePath: string, reg: InstalledPluginsRegistry): Promise<void> {
	await atomicWriteJson(filePath, reg);
}

// ── Marketplace CRUD ─────────────────────────────────────────────────
// Pure functions that transform registry state. Caller is responsible for
// reading, mutating, and writing back.

export function addMarketplaceEntry(reg: MarketplacesRegistry, entry: MarketplaceRegistryEntry): MarketplacesRegistry {
	if (reg.marketplaces.some(m => m.name === entry.name)) {
		throw new Error(`Marketplace "${entry.name}" already exists`);
	}
	return { ...reg, marketplaces: [...reg.marketplaces, entry] };
}

export function removeMarketplaceEntry(reg: MarketplacesRegistry, name: string): MarketplacesRegistry {
	const filtered = reg.marketplaces.filter(m => m.name !== name);
	if (filtered.length === reg.marketplaces.length) {
		throw new Error(`Marketplace "${name}" not found`);
	}
	return { ...reg, marketplaces: filtered };
}

export function getMarketplaceEntry(reg: MarketplacesRegistry, name: string): MarketplaceRegistryEntry | undefined {
	return reg.marketplaces.find(m => m.name === name);
}

// ── Installed plugin CRUD ────────────────────────────────────────────

export function addInstalledPlugin(
	reg: InstalledPluginsRegistry,
	id: string,
	entry: InstalledPluginEntry,
): InstalledPluginsRegistry {
	const existing = reg.plugins[id] ?? [];
	return {
		...reg,
		plugins: { ...reg.plugins, [id]: [...existing, entry] },
	};
}

export function removeInstalledPlugin(reg: InstalledPluginsRegistry, id: string): InstalledPluginsRegistry {
	if (!(id in reg.plugins)) {
		throw new Error(`Plugin "${id}" not found in registry`);
	}
	const { [id]: _, ...rest } = reg.plugins;
	return { ...reg, plugins: rest };
}

export function getInstalledPlugin(reg: InstalledPluginsRegistry, id: string): InstalledPluginEntry[] | undefined {
	return reg.plugins[id];
}

/**
 * Collect all installPath values referenced by any of the provided registries.
 * Use this before deleting a cached plugin directory to verify it is not still
 * referenced by another scope's registry.
 */
export function collectReferencedPaths(...registries: InstalledPluginsRegistry[]): Set<string> {
	return new Set(
		registries.flatMap(r =>
			Object.values(r.plugins)
				.flat()
				.map(e => e.installPath),
		),
	);
}
