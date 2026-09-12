/**
 * Registry read/write operations for the marketplace plugin system.
 *
 * Two registries:
 *   - marketplaces.json under getConfigRootDir() — which catalogs the user has added
 *   - installed_plugins.json under getPluginsDir() — which plugins are installed
 *
 * Read/write functions accept explicit file paths so callers control the
 * location. Path helpers compute the default paths from the dir singleton.
 *
 * Both use atomic write (tmp + rename). On Windows, rename over existing file
 * can fail with EPERM — fallback: unlink target then rename.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getConfigRootDir, getPluginsDir, isEnoent, logger, tryParseJson } from "@gajae-code/utils";

import { withFileLock } from "../../../config/file-lock";

import type {
	InstalledPluginEntry,
	InstalledPluginsRegistry,
	MarketplaceRegistryEntry,
	MarketplacesRegistry,
} from "./types";

// ── Path helpers ─────────────────────────────────────────────────────

export function getMarketplacesRegistryPath(): string {
	return path.join(getConfigRootDir(), "marketplaces.json");
}

export function getInstalledPluginsRegistryPath(): string {
	return path.join(getPluginsDir(), "installed_plugins.json");
}

export function getMarketplacesCacheDir(): string {
	return path.join(getPluginsDir(), "cache", "marketplaces");
}

export function getPluginsCacheDir(): string {
	return path.join(getPluginsDir(), "cache", "plugins");
}

// ── Atomic write ─────────────────────────────────────────────────────

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const content = `${JSON.stringify(data, null, 2)}\n`;
	const tmpPath = `${filePath}.tmp`;

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

/**
 * Refuse a registry file that is not an ordinary, singly-linked regular file:
 * a symlink could redirect the write elsewhere, and a hard link (nlink > 1)
 * means the mutation would silently also change another path. Absence is not
 * a refusal — that is the normal "nothing installed yet" state.
 */
async function assertOrdinaryRegistryFile(filePath: string): Promise<void> {
	let stat: import("node:fs").Stats;
	try {
		stat = await fs.lstat(filePath);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
		throw Object.assign(new Error(`Installed plugins registry at ${filePath} is not a safe ordinary file`), {
			code: "unsafe_registry_link",
		});
	}
}

/**
 * Strict read for mutation/CAS callers: a missing file is legitimately empty,
 * but malformed JSON or an unexpected shape must never be silently treated as
 * an empty registry — that would let a mutating writer overwrite (and lose)
 * an unreadable but non-empty registry. Use {@link readInstalledPluginsRegistry}
 * for lenient, display-only reads.
 */
async function readInstalledPluginsRegistryStrict(filePath: string): Promise<InstalledPluginsRegistry> {
	await assertOrdinaryRegistryFile(filePath);
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch (err) {
		if (isEnoent(err)) return emptyInstalledPluginsRegistry();
		throw err;
	}
	const data = tryParseJson<InstalledPluginsRegistry>(text);
	if (
		!data ||
		typeof data !== "object" ||
		typeof data.version !== "number" ||
		!data.plugins ||
		typeof data.plugins !== "object" ||
		Array.isArray(data.plugins)
	) {
		throw Object.assign(new Error(`Installed plugins registry is malformed at ${filePath}`), {
			code: "malformed_registry",
		});
	}
	return { ...data, version: 2 };
}

/** dev/ino/mtime/size identity of a file plus its parent directory, for exact CAS. */
async function fileParentIdentity(filePath: string): Promise<Record<string, string> | null> {
	try {
		const stat = await fs.lstat(filePath, { bigint: true });
		const parent = await fs.lstat(path.dirname(filePath), { bigint: true });
		return {
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			mtimeNs: stat.mtimeNs.toString(),
			size: stat.size.toString(),
			parentDev: parent.dev.toString(),
			parentIno: parent.ino.toString(),
		};
	} catch {
		return null;
	}
}

function entryBaseline(identity: Record<string, string> | null, entry: InstalledPluginEntry): string {
	return JSON.stringify({ identity, entry });
}

export type InstalledPluginEnablementState =
	| { status: "ok"; enabled: boolean; baseline: string }
	| { status: "not_installed" }
	| { status: "malformed" }
	| { status: "unsafe_link" };

/**
 * Pure read-only snapshot of one (id, scope) entry's durable enablement plus
 * an exact file+parent CAS baseline. Never touches the cached artifact at
 * `installPath` — presence/absence of that artifact is a D6 concern, not D7's.
 * A symlinked or hard-linked registry file is refused distinctly from an
 * absent ("not_installed"-eligible) or malformed one.
 */
export async function getInstalledPluginEnablementState(
	filePath: string,
	id: string,
	scope: "user" | "project",
): Promise<InstalledPluginEnablementState> {
	let reg: InstalledPluginsRegistry;
	try {
		reg = await readInstalledPluginsRegistryStrict(filePath);
	} catch (error) {
		if (error instanceof Error && (error as { code?: string }).code === "unsafe_registry_link")
			return { status: "unsafe_link" };
		return { status: "malformed" };
	}
	const entry = reg.plugins[id]?.find(e => e.scope === scope);
	if (!entry) return { status: "not_installed" };
	const identity = await fileParentIdentity(filePath);
	return { status: "ok", enabled: entry.enabled !== false, baseline: entryBaseline(identity, entry) };
}

/**
 * Update durable marketplace enablement without touching cached artifacts.
 * Serialized under the canonical native-identity-bound file lock ordinary
 * marketplace writers use (bounded retries, no blind directory removal).
 * `expectedBaseline` is required: a caller with no prior read has no CAS
 * authority and must call {@link getInstalledPluginEnablementState} first.
 */
export async function setInstalledPluginEnabled(
	filePath: string,
	id: string,
	scope: "user" | "project",
	enabled: boolean,
	expectedBaseline: string,
): Promise<"updated" | "not_needed"> {
	return await withFileLock(filePath, async () => {
		let reg: InstalledPluginsRegistry;
		try {
			reg = await readInstalledPluginsRegistryStrict(filePath);
		} catch (error) {
			if (error instanceof Error && (error as { code?: string }).code === "unsafe_registry_link") throw error;
			throw Object.assign(new Error(`Installed plugins registry is malformed at ${filePath}`), {
				code: "malformed_registry",
				cause: error,
			});
		}
		const entries = reg.plugins[id];
		const index = entries?.findIndex(entry => entry.scope === scope) ?? -1;
		if (!entries || index < 0)
			throw Object.assign(new Error(`Plugin "${id}" is not installed in ${scope} scope`), { code: "not_installed" });
		const current = entries[index] as InstalledPluginEntry;
		const identity = await fileParentIdentity(filePath);
		const baseline = entryBaseline(identity, current);
		if (baseline !== expectedBaseline)
			throw Object.assign(new Error("The installed plugin entry changed since it was reviewed"), {
				code: "stale_baseline",
			});
		if ((current.enabled ?? true) === enabled) return "not_needed";
		const nextEntries = [...entries];
		nextEntries[index] = { ...current, enabled };
		await writeInstalledPluginsRegistry(filePath, { ...reg, plugins: { ...reg.plugins, [id]: nextEntries } });
		return "updated";
	});
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
