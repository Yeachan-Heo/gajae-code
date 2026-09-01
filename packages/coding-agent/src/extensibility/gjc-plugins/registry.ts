import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileGjcPluginBundle } from "./compiler";
import { migrateGjcPluginEntries } from "./migration";
import { gjcPluginProjectRoot, gjcPluginUserRoot, type ProfileAuthority } from "./paths";
import { GjcPluginLoadError, type GjcPluginRegistry, type GjcPluginRegistryEntry, type GjcPluginScope } from "./types";

const REGISTRY_FILENAME = "registry.json";
const LOCK_FILENAME = "registry.lock";
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

export function registryRootForScope(
	scope: GjcPluginScope,
	cwd: string,
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): string {
	return scope === "user" ? gjcPluginUserRoot(agentDir, profileAuthority) : gjcPluginProjectRoot(cwd);
}

export function registryPathForScope(
	scope: GjcPluginScope,
	cwd: string,
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): string {
	return path.join(registryRootForScope(scope, cwd, agentDir, profileAuthority), REGISTRY_FILENAME);
}

function emptyRegistry(scope: GjcPluginScope): GjcPluginRegistry {
	return { version: 1, scope, plugins: [] };
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Deterministic ordering: scope (user before project) -> normalized name ->
 * resolved plugin root. Collisions are errors elsewhere; order only controls
 * stable hook/appendix sequencing.
 */
export function sortRegistryEntries(entries: GjcPluginRegistryEntry[]): GjcPluginRegistryEntry[] {
	const scopeRank = (scope: GjcPluginScope): number => (scope === "user" ? 0 : 1);
	return [...entries].sort((a, b) => {
		if (a.scope !== b.scope) return scopeRank(a.scope) - scopeRank(b.scope);
		if (a.name !== b.name) return a.name.localeCompare(b.name);
		return a.pluginRoot.localeCompare(b.pluginRoot);
	});
}

async function readRegistryRaw(
	scope: GjcPluginScope,
	cwd: string,
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): Promise<GjcPluginRegistry> {
	const registryPath = registryPathForScope(scope, cwd, agentDir, profileAuthority);
	let text: string;
	try {
		text = await fs.readFile(registryPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return emptyRegistry(scope);
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new GjcPluginLoadError("invalid_manifest", `Corrupt GJC plugin registry at ${registryPath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (typeof parsed !== "object" || parsed === null || (parsed as GjcPluginRegistry).version !== 1) {
		throw new GjcPluginLoadError("invalid_manifest", `Unsupported GJC plugin registry shape at ${registryPath}`);
	}
	const registry = parsed as GjcPluginRegistry;
	if (registry.scope !== scope)
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`GJC plugin registry scope mismatch at ${registryPath}: expected ${scope}`,
		);
	if (
		!Array.isArray(registry.plugins) ||
		registry.plugins.some(plugin => {
			if (!plugin || typeof plugin !== "object") return true;
			const entry = plugin as GjcPluginRegistryEntry;
			return (
				entry.scope !== scope ||
				!entry.surfaces ||
				!Array.isArray(entry.surfaces.tools) ||
				!Array.isArray(entry.surfaces.hooks)
			);
		})
	) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin registry entries or scope at ${registryPath}`,
		);
	}
	registry.plugins = sortRegistryEntries(registry.plugins);
	return registry;
}

async function discoverLegacyEntries(
	scope: GjcPluginScope,
	cwd: string,
	existing: readonly GjcPluginRegistryEntry[],
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): Promise<GjcPluginRegistryEntry[]> {
	const root = registryRootForScope(scope, cwd, agentDir, profileAuthority);
	let dirents: import("node:fs").Dirent[];
	try {
		dirents = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const known = new Set(existing.map(entry => path.resolve(entry.pluginRoot)));
	const discovered: GjcPluginRegistryEntry[] = [];
	for (const dirent of dirents) {
		if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
		const pluginRoot = path.join(root, dirent.name);
		if (known.has(path.resolve(pluginRoot))) continue;
		try {
			const bundle = await compileGjcPluginBundle(pluginRoot);
			const now = new Date().toISOString();
			discovered.push({
				name: bundle.name,
				version: bundle.version,
				scope,
				enabled: true,
				pluginRoot: path.resolve(pluginRoot),
				manifestPath: bundle.manifestPath,
				manifestHash: bundle.manifestHash,
				source: { kind: "path", uri: path.resolve(pluginRoot), resolvedAt: now },
				installedAt: now,
				updatedAt: now,
				copiedFiles: bundle.files,
				surfaces: bundle.surfaces,
				disabledSurfaceIds: [],
				migration: { status: "migrated", metadataVersion: 2, migratedAt: now },
			});
			known.add(path.resolve(pluginRoot));
		} catch (error) {
			let name = dirent.name;
			let version = "unknown";
			let failureSurface = `plugin:${name}`;
			try {
				const manifest = JSON.parse(
					await fs.readFile(path.join(pluginRoot, "gajae-plugin.json"), "utf8"),
				) as Record<string, unknown>;
				if (typeof manifest.name === "string" && manifest.name.trim()) name = manifest.name;
				if (typeof manifest.version === "string" && manifest.version.trim()) version = manifest.version;
				if (Array.isArray(manifest.tools)) {
					const firstTool = manifest.tools.find(item => item && typeof item === "object") as
						| Record<string, unknown>
						| undefined;
					if (typeof firstTool?.name === "string") failureSurface = `tool:${firstTool.name}`;
				}
			} catch {
				// Keep the directory name and sanitized failure below.
			}
			const now = new Date().toISOString();
			const code = error instanceof GjcPluginLoadError ? error.code : "missing_file";
			discovered.push({
				name,
				version,
				scope,
				enabled: true,
				pluginRoot: path.resolve(pluginRoot),
				manifestPath: path.join(pluginRoot, "gajae-plugin.json"),
				manifestHash: "",
				source: { kind: "path", uri: path.resolve(pluginRoot), resolvedAt: now },
				installedAt: now,
				updatedAt: now,
				copiedFiles: [],
				surfaces: { subskills: [], tools: [], hooks: [], mcps: [], systemAppendices: [], agentAppendices: [] },
				disabledSurfaceIds: [],
				migration: {
					status: "failed",
					metadataVersion: 2,
					failure: {
						code,
						surface: failureSurface,
						cause: error instanceof Error ? error.message : String(error),
					},
				},
			});
			known.add(path.resolve(pluginRoot));
		}
	}
	return discovered;
}

/**
 * The effective registry a migrating read would produce, computed entirely in
 * memory: raw entries plus legacy-root discovery plus entry migration, with no
 * lock taken and nothing persisted.
 *
 * This is what a preview must read. {@link readRegistry} persists the same
 * result under the scope lock, and taking that lock creates the scope root and
 * a lockfile — a filesystem mutation a preview must not make. Reading the raw
 * registry alone is not equivalent: it cannot see a legacy bundle that exists
 * on disk without a registry entry, so a preview built on it would disagree
 * with the uninstall it is previewing.
 */
export async function readEffectiveRegistryUnpersisted(
	scope: GjcPluginScope,
	cwd: string,
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): Promise<GjcPluginRegistry> {
	const registry = await readRegistryRaw(scope, cwd, agentDir, profileAuthority);
	const discovered = await discoverLegacyEntries(scope, cwd, registry.plugins, agentDir, profileAuthority);
	const migrated = await migrateGjcPluginEntries([...registry.plugins, ...discovered]);
	if (!migrated.changed && discovered.length === 0) return registry;
	return { ...registry, plugins: sortRegistryEntries(migrated.entries) };
}

export async function readRegistry(
	scope: GjcPluginScope,
	cwd: string,
	options: { migrate?: boolean; agentDir?: string; profileAuthority?: ProfileAuthority } = {},
): Promise<GjcPluginRegistry> {
	const agentDir = options.agentDir;
	const profileAuthority = options.profileAuthority;
	const registry = await readRegistryRaw(scope, cwd, agentDir, profileAuthority);
	if (options.migrate === false) return registry;
	const discovered = await discoverLegacyEntries(scope, cwd, registry.plugins, agentDir, profileAuthority);
	const migrated = await migrateGjcPluginEntries([...registry.plugins, ...discovered]);
	if (!migrated.changed && discovered.length === 0) return registry;
	// Re-check under the lock before persisting. Migration and legacy-root
	// discovery are one transaction, never a normal runtime loader path.
	return await withRegistryLock(
		scope,
		cwd,
		async () => {
			const latest = await readRegistryRaw(scope, cwd, agentDir, profileAuthority);
			const latestDiscovered = await discoverLegacyEntries(scope, cwd, latest.plugins, agentDir, profileAuthority);
			const latestMigrated = await migrateGjcPluginEntries([...latest.plugins, ...latestDiscovered]);
			if (latestMigrated.changed || latestDiscovered.length > 0) {
				const next: GjcPluginRegistry = { ...latest, plugins: sortRegistryEntries(latestMigrated.entries) };
				await writeRegistryUnlocked(next, cwd, scope, agentDir, profileAuthority);
				return next;
			}
			return latest;
		},
		agentDir,
		profileAuthority,
	);
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			const handle = await fs.open(lockPath, "wx");
			try {
				await handle.writeFile(token);
			} finally {
				await handle.close();
			}
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				// Owner-safe release: only remove the lock if it is still ours.
				try {
					const current = await fs.readFile(lockPath, "utf8");
					if (current === token) await fs.rm(lockPath, { force: true });
				} catch {
					// Lock already gone; nothing to release.
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			// Fail-closed: never auto-evict an existing lock (a live holder may run
			// longer than the timeout). Time out instead and leave the lock for
			// diagnostics/manual cleanup. A lease/heartbeat protocol can be added
			// later if automatic stale recovery becomes necessary.
			if (Date.now() > deadline) {
				throw new GjcPluginLoadError(
					"install_conflict",
					`Timed out acquiring GJC plugin registry lock at ${lockPath}; remove it manually if no install is running`,
				);
			}
			await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
}

export async function withRegistryLock<T>(
	scope: GjcPluginScope,
	cwd: string,
	fn: () => Promise<T>,
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): Promise<T> {
	const lockPath = path.join(registryRootForScope(scope, cwd, agentDir, profileAuthority), LOCK_FILENAME);
	const release = await acquireLock(lockPath);
	try {
		return await fn();
	} finally {
		await release();
	}
}

/**
 * Lock-free atomic write (temp+fsync+rename). Only call while already holding
 * the per-scope registry lock via withRegistryLock.
 */
export async function writeRegistryUnlocked(
	registry: GjcPluginRegistry,
	cwd: string,
	ownerScope: GjcPluginScope = registry.scope,
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): Promise<void> {
	if (registry.scope !== ownerScope)
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`GJC plugin registry scope mismatch: caller owns ${ownerScope}, registry declares ${registry.scope}`,
		);
	if (registry.plugins.some(entry => entry.scope !== ownerScope))
		throw new GjcPluginLoadError("invalid_manifest", `GJC plugin entry scope mismatch: caller owns ${ownerScope}`);
	const registryPath = registryPathForScope(ownerScope, cwd, agentDir, profileAuthority);
	await fs.mkdir(path.dirname(registryPath), { recursive: true });
	const sorted: GjcPluginRegistry = { ...registry, scope: ownerScope, plugins: sortRegistryEntries(registry.plugins) };
	const text = `${JSON.stringify(sorted, null, 2)}\n`;
	const tmpPath = `${registryPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	const handle = await fs.open(tmpPath, "w");
	try {
		await handle.writeFile(text);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(tmpPath, registryPath);
}

/**
 * Atomic registry write: write to a temp sibling, fsync, then rename. Guarded
 * by an interprocess lockfile so concurrent installs cannot clobber each other.
 */
export async function writeRegistry(
	registry: GjcPluginRegistry,
	cwd: string,
	ownerScope: GjcPluginScope = registry.scope,
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): Promise<void> {
	await withRegistryLock(
		ownerScope,
		cwd,
		() => writeRegistryUnlocked(registry, cwd, ownerScope, agentDir, profileAuthority),
		agentDir,
		profileAuthority,
	);
}

/**
 * Mutate a scope's registry as a single locked read-modify-write transaction so
 * concurrent installs cannot lose each other's updates. The mutator receives a
 * sorted copy and returns the next entry list.
 */
export async function updateRegistry(
	scope: GjcPluginScope,
	cwd: string,
	mutator: (entries: GjcPluginRegistryEntry[]) => GjcPluginRegistryEntry[],
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): Promise<GjcPluginRegistry> {
	return await withRegistryLock(
		scope,
		cwd,
		async () => {
			const current = await readRegistry(scope, cwd, { migrate: false, agentDir, profileAuthority });
			const nextEntries = mutator([...current.plugins]);
			const next: GjcPluginRegistry = { version: 1, scope, plugins: sortRegistryEntries(nextEntries) };
			await writeRegistryUnlocked(next, cwd, scope, agentDir, profileAuthority);
			return next;
		},
		agentDir,
		profileAuthority,
	);
}

/**
 * Effective registry for a cwd: user + project entries in deterministic order.
 *
 * Defaults to the startup semantics (legacy-entry discovery + migration, which
 * may persist the migrated registry). Read-only inspection surfaces (for
 * example `gjc customize doctor`) pass `{ migrate: false }` so reporting never
 * writes to the registry.
 */
export async function loadEffectiveGjcPluginRegistry(
	cwd: string,
	options: { migrate?: boolean; agentDir?: string; profileAuthority?: ProfileAuthority } = {},
): Promise<GjcPluginRegistryEntry[]> {
	const [user, project] = await Promise.all([
		readRegistry("user", cwd, options),
		readRegistry("project", cwd, {
			migrate: options.migrate,
			agentDir: options.agentDir,
			profileAuthority: options.profileAuthority,
		}),
	]);
	return sortRegistryEntries([...user.plugins, ...project.plugins]);
}

export function registryEntryFingerprint(entry: GjcPluginRegistryEntry): string {
	const canonical = JSON.stringify({
		name: entry.name,
		manifestHash: entry.manifestHash,
		files: entry.copiedFiles.map(f => [f.relativePath, f.sha256]).sort(),
	});
	return createHash("sha256").update(canonical).digest("hex");
}
