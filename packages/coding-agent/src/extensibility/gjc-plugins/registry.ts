import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gjcPluginProjectRoot, gjcPluginUserRoot } from "./paths";
import { GjcPluginLoadError, type GjcPluginRegistry, type GjcPluginRegistryEntry, type GjcPluginScope } from "./types";

const REGISTRY_FILENAME = "registry.json";
const LOCK_FILENAME = "registry.lock";
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

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

export async function readRegistry(scope: GjcPluginScope, cwd: string): Promise<GjcPluginRegistry> {
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
	registry.plugins = sortRegistryEntries(registry.plugins ?? []);
	return registry;
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
export async function writeRegistryUnlocked(registry: GjcPluginRegistry, cwd: string): Promise<void> {
	const registryPath = registryPathForScope(registry.scope, cwd);
	await fs.mkdir(path.dirname(registryPath), { recursive: true });
	const sorted: GjcPluginRegistry = { ...registry, plugins: sortRegistryEntries(registry.plugins) };
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
export async function writeRegistry(registry: GjcPluginRegistry, cwd: string): Promise<void> {
	await withRegistryLock(registry.scope, cwd, () => writeRegistryUnlocked(registry, cwd));
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
		const current = await readRegistry(scope, cwd);
		const nextEntries = mutator([...current.plugins]);
		const next: GjcPluginRegistry = { version: 1, scope, plugins: sortRegistryEntries(nextEntries) };
		await writeRegistryUnlocked(next, cwd);
		return next;
	});
}

/**
 * Effective registry for a cwd: user + project entries in deterministic order.
 */
export async function loadEffectiveGjcPluginRegistry(cwd: string): Promise<GjcPluginRegistryEntry[]> {
	const [user, project] = await Promise.all([readRegistry("user", cwd), readRegistry("project", cwd)]);
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
