import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	exactUnlink,
	linkNoReplacePath,
	type NativeExactFileIdentity,
	type NativeNoReplaceResult,
	renameNoReplacePath,
} from "@gajae-code/natives";
import { compileGjcPluginBundle } from "./compiler";
import { migrateGjcPluginEntries } from "./migration";
import { gjcPluginProjectRoot, gjcPluginUserRoot } from "./paths";
import { GjcPluginLoadError, type GjcPluginRegistry, type GjcPluginRegistryEntry, type GjcPluginScope } from "./types";

const REGISTRY_FILENAME = "registry.json";
const LOCK_FILENAME = "registry.lock";
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

export const RegistryLockTestHooks: {
	beforeEviction?: (lockPath: string, raw: string) => void | Promise<void>;
	beforePublish?: (stagingPath: string, lockPath: string) => void | Promise<void>;
} = {};

export function registryRootForScope(scope: GjcPluginScope, cwd: string): string {
	return scope === "user" ? gjcPluginUserRoot() : gjcPluginProjectRoot(cwd);
}

export function registryPathForScope(scope: GjcPluginScope, cwd: string): string {
	return path.join(registryRootForScope(scope, cwd), REGISTRY_FILENAME);
}

function emptyRegistry(scope: GjcPluginScope): GjcPluginRegistry {
	return { version: 1, scope, plugins: [] };
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function registryRecord(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new GjcPluginLoadError("invalid_manifest", `Invalid GJC plugin registry field ${field}`);
	}
	return value as Record<string, unknown>;
}

function rejectRegistryKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) {
			throw new GjcPluginLoadError("invalid_manifest", `Unknown GJC plugin registry field ${field}.${key}`);
		}
	}
}

function validateRegistryEntryShape(value: unknown, field: string): void {
	const entry = registryRecord(value, field);
	rejectRegistryKeys(
		entry,
		[
			"name",
			"version",
			"scope",
			"enabled",
			"pluginRoot",
			"manifestPath",
			"manifestHash",
			"source",
			"installedAt",
			"updatedAt",
			"copiedFiles",
			"surfaces",
			"disabledSurfaceIds",
			"quarantine",
			"migration",
		],
		field,
	);
	const source = registryRecord(entry.source, `${field}.source`);
	rejectRegistryKeys(source, ["kind", "uri", "ref", "sha", "resolvedAt"], `${field}.source`);
	const surfaces = registryRecord(entry.surfaces, `${field}.surfaces`);
	rejectRegistryKeys(
		surfaces,
		["subskills", "tools", "hooks", "mcps", "systemAppendices", "agentAppendices"],
		`${field}.surfaces`,
	);
	const surfaceKeys: Record<string, readonly string[]> = {
		subskills: [
			"extensionId",
			"name",
			"description",
			"parent",
			"phase",
			"activationArg",
			"relativePath",
			"sha256",
			"toolRefs",
		],
		tools: [
			"extensionId",
			"name",
			"relativePath",
			"sha256",
			"description",
			"schema",
			"schemaHash",
			"implementationHash",
			"presentationHash",
			"metadataVersion",
		],
		hooks: [
			"extensionId",
			"name",
			"event",
			"target",
			"phase",
			"relativePath",
			"sha256",
			"implementationHash",
			"capabilities",
			"networkDestinations",
			"filesystemRoots",
			"capabilityHash",
			"functionHook",
		],
		mcps: ["extensionId", "name", "transport", "configHash", "config"],
		systemAppendices: ["extensionId", "name", "relativePath", "content", "contentHash", "bytes"],
		agentAppendices: ["extensionId", "name", "relativePath", "content", "contentHash", "bytes", "agent"],
	};
	for (const [surfaceName, allowed] of Object.entries(surfaceKeys)) {
		const items = surfaces[surfaceName];
		if (!Array.isArray(items))
			throw new GjcPluginLoadError("invalid_manifest", `Invalid ${field}.surfaces.${surfaceName}`);
		for (let index = 0; index < items.length; index += 1) {
			const item = registryRecord(items[index], `${field}.surfaces.${surfaceName}[${index}]`);
			rejectRegistryKeys(item, allowed, `${field}.surfaces.${surfaceName}[${index}]`);
		}
	}
	if (!Array.isArray(entry.copiedFiles) || !Array.isArray(entry.disabledSurfaceIds)) {
		throw new GjcPluginLoadError("invalid_manifest", `Invalid GJC plugin registry arrays at ${field}`);
	}
	if (entry.quarantine !== undefined && !Array.isArray(entry.quarantine)) {
		throw new GjcPluginLoadError("invalid_manifest", `Invalid ${field}.quarantine`);
	}
	if (entry.migration !== undefined) {
		const migration = registryRecord(entry.migration, `${field}.migration`);
		rejectRegistryKeys(migration, ["status", "metadataVersion", "migratedAt", "failure"], `${field}.migration`);
	}
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

async function readRegistryRaw(scope: GjcPluginScope, cwd: string): Promise<GjcPluginRegistry> {
	const registryPath = registryPathForScope(scope, cwd);
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
		registry.plugins.some((plugin, index) => {
			if (!plugin || typeof plugin !== "object") return true;
			validateRegistryEntryShape(plugin, `plugins[${index}]`);
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
): Promise<GjcPluginRegistryEntry[]> {
	const root = registryRootForScope(scope, cwd);
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
export async function readEffectiveRegistryUnpersisted(scope: GjcPluginScope, cwd: string): Promise<GjcPluginRegistry> {
	const registry = await readRegistryRaw(scope, cwd);
	const discovered = await discoverLegacyEntries(scope, cwd, registry.plugins);
	const migrated = await migrateGjcPluginEntries([...registry.plugins, ...discovered]);
	if (!migrated.changed && discovered.length === 0) return registry;
	return { ...registry, plugins: sortRegistryEntries(migrated.entries) };
}

export async function readRegistry(
	scope: GjcPluginScope,
	cwd: string,
	options: { migrate?: boolean } = {},
): Promise<GjcPluginRegistry> {
	const registry = await readRegistryRaw(scope, cwd);
	if (options.migrate === false) return registry;
	const discovered = await discoverLegacyEntries(scope, cwd, registry.plugins);
	const migrated = await migrateGjcPluginEntries([...registry.plugins, ...discovered]);
	if (!migrated.changed && discovered.length === 0) return registry;
	// Re-check under the lock before persisting. Migration and legacy-root
	// discovery are one transaction, never a normal runtime loader path.
	// Contention (a concurrent install elsewhere) must not fail startup reads:
	// the effective registry is already computed, so degrade to returning it
	// unpersisted and let a later uncontended session write the migrated
	// state. Mutating install paths keep their fail-loud install_conflict.
	try {
		return await withRegistryLock(scope, cwd, async () => {
			const latest = await readRegistryRaw(scope, cwd);
			const latestDiscovered = await discoverLegacyEntries(scope, cwd, latest.plugins);
			const latestMigrated = await migrateGjcPluginEntries([...latest.plugins, ...latestDiscovered]);
			if (latestMigrated.changed || latestDiscovered.length > 0) {
				const next: GjcPluginRegistry = { ...latest, plugins: sortRegistryEntries(latestMigrated.entries) };
				await writeRegistryUnlocked(next, cwd, scope);
				return next;
			}
			return latest;
		});
	} catch (error) {
		if (error instanceof GjcPluginLoadError && error.code === "install_conflict") {
			return { ...registry, plugins: sortRegistryEntries(migrated.entries) };
		}
		throw error;
	}
}

const LOCK_NONCE_PATTERN = /^[0-9a-f]{16}$/;

interface RegistryLockToken {
	pid: number;
	/** Host segment of a host-tagged token; null for legacy `pid-nonce` tokens. */
	host: string | null;
}

function parseRegistryLockToken(raw: string): RegistryLockToken | null {
	const parts = raw.trim().split("-");
	if (parts.length < 2) return null;
	const pid = Number(parts[0]);
	const nonce = parts[parts.length - 1];
	if (!Number.isInteger(pid) || pid <= 0 || !LOCK_NONCE_PATTERN.test(nonce)) return null;
	// Hostnames may contain '-', so everything between the first and last
	// segment is the host; a single middle segment that is empty (or absent)
	// means a legacy token.
	const host = parts.slice(1, -1).join("-");
	return { pid, host: host.length > 0 ? host : null };
}

/**
 * A holder is assumed alive unless provably dead: ourselves, a live PID
 * (EPERM counts — the process exists under another user), or a lock written
 * on another host (a project registry can live on shared storage, where a
 * local PID probe would be meaningless) all stay fail-closed.
 */
function registryLockHolderAlive(holder: RegistryLockToken): boolean {
	if (holder.pid === process.pid) return true;
	if (holder.host !== null && holder.host !== os.hostname()) return true;
	try {
		process.kill(holder.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

async function captureRegistryLockIdentity(lockPath: string): Promise<NativeExactFileIdentity | null> {
	try {
		const [bytes, stat, parent] = await Promise.all([
			fs.readFile(lockPath),
			fs.lstat(lockPath, { bigint: true }),
			fs.stat(path.dirname(lockPath), { bigint: true }),
		]);
		if (!stat.isFile()) return null;
		return {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			parentDev: parent.dev,
			parentIno: parent.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function evictRegistryLock(lockPath: string, raw: string): Promise<boolean> {
	const identity = await captureRegistryLockIdentity(lockPath);
	if (!identity) return false;
	const expectedHash = createHash("sha256").update(raw).digest("hex");
	if (identity.sha256 !== expectedHash) return false;
	await RegistryLockTestHooks.beforeEviction?.(lockPath, raw);
	const result = exactUnlink(lockPath, {
		...identity,
		quarantineName: `${LOCK_FILENAME}.evict-${process.pid}-${randomBytes(4).toString("hex")}`,
	});
	return result.ok || result.code === "cleanup_pending";
}

function publishRegistryLock(stagingPath: string, lockPath: string): NativeNoReplaceResult {
	let result = renameNoReplacePath(stagingPath, lockPath);
	if (
		!result.ok &&
		result.mutationState === "not_committed" &&
		(result.reason === "atomic_unavailable" || result.reason === "invalid_request")
	) {
		// linkat is the no-overwrite fallback on filesystems without a
		// no-replace rename. Both paths expose the complete token only after the
		// atomic claim, so a crash cannot publish an empty or partial lock.
		result = linkNoReplacePath(stagingPath, lockPath);
	}
	return result;
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	const token = `${process.pid}-${os.hostname()}-${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		const stagingPath = `${lockPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
		let publication: NativeNoReplaceResult | undefined;
		try {
			await fs.writeFile(stagingPath, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await RegistryLockTestHooks.beforePublish?.(stagingPath, lockPath);
			publication = publishRegistryLock(stagingPath, lockPath);
			if (publication.ok) {
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
			}
			if (publication.reason !== "destination_exists") {
				throw new Error(
					`Failed to publish GJC plugin registry lock at ${lockPath}: ${publication.code ?? publication.reason}`,
				);
			}
		} catch (error) {
			if (publication?.reason === "destination_exists") {
				// Continue into stale inspection below.
			} else if (
				publication === undefined &&
				["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "")
			) {
				// A read-only registry directory can still contain a lock left by a
				// dead writer. Inspect that lock and return the normal bounded
				// install_conflict rather than surfacing the staging-file permission
				// error immediately.
				const lockExists = await fs.stat(lockPath).then(
					() => true,
					(error: unknown) => !isEnoent(error),
				);
				if (!lockExists) throw error;
			} else throw error;
		} finally {
			if (publication?.mutationState !== "unknown") await fs.rm(stagingPath, { force: true }).catch(() => {});
		}

		// Stale recovery: a writer that died mid-transaction never releases
		// its lock, and without recovery that lock poisons every later
		// session until manual cleanup. Evict only a provably dead holder:
		// a host-tagged token on this host. Legacy `pid-nonce` tokens have no
		// trustworthy host identity, so they always fail closed: a local PID
		// probe cannot prove that a remote holder on shared storage is dead.
		// Live holders still fail closed below — they may legitimately outlive
		// our timeout.
		const raw = await fs.readFile(lockPath, "utf8").catch(() => null);
		const holder = raw === null ? null : parseRegistryLockToken(raw);
		if (raw !== null && holder !== null && holder.host !== null && !registryLockHolderAlive(holder)) {
			try {
				// exactUnlink verifies the observed inode, parent, size, mtime,
				// and bytes inside the removal primitive. A replacement published
				// after this read is therefore never consumed by stale recovery.
				await evictRegistryLock(lockPath, raw);
			} catch {
				// Raced with another evictor or a fresh holder, or the removal
				// itself failed (lockfile owned by another user, read-only mount,
				// EBUSY/EPERM on Windows). Fall through to the shared deadline
				// and backoff below either way: a removal that keeps failing must
				// end in the bounded install_conflict timeout, never an unbounded
				// spin.
			}
		}
		if (Date.now() > deadline) {
			throw new GjcPluginLoadError(
				"install_conflict",
				`Timed out acquiring GJC plugin registry lock at ${lockPath}; remove it manually if no install is running`,
			);
		}
		await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
	}
}

export async function withRegistryLock<T>(scope: GjcPluginScope, cwd: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = path.join(registryRootForScope(scope, cwd), LOCK_FILENAME);
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
): Promise<void> {
	if (registry.scope !== ownerScope)
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`GJC plugin registry scope mismatch: caller owns ${ownerScope}, registry declares ${registry.scope}`,
		);
	if (registry.plugins.some(entry => entry.scope !== ownerScope))
		throw new GjcPluginLoadError("invalid_manifest", `GJC plugin entry scope mismatch: caller owns ${ownerScope}`);
	const registryPath = registryPathForScope(ownerScope, cwd);
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
): Promise<void> {
	await withRegistryLock(ownerScope, cwd, () => writeRegistryUnlocked(registry, cwd, ownerScope));
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
): Promise<GjcPluginRegistry> {
	return await withRegistryLock(scope, cwd, async () => {
		const current = await readRegistry(scope, cwd, { migrate: false });
		const nextEntries = mutator([...current.plugins]);
		const next: GjcPluginRegistry = { version: 1, scope, plugins: sortRegistryEntries(nextEntries) };
		await writeRegistryUnlocked(next, cwd);
		return next;
	});
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
	options: { migrate?: boolean } = {},
): Promise<GjcPluginRegistryEntry[]> {
	const [user, project] = await Promise.all([
		readRegistry("user", cwd, options),
		readRegistry("project", cwd, options),
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
