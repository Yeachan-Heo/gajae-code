import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bindPluginMcpToPublicNetwork } from "../../runtime-mcp/plugin-network-boundary";
import { loadCustomTools } from "../custom-tools/loader";
import type { CustomTool } from "../custom-tools/types";
import { bundleIdentity } from "./lifecycle-reconciliation";
import { verifyImplementationHash } from "./metadata";
import { isV2Tool } from "./migration";
import { type ProfileAuthority, resolveWithinRoot } from "./paths";
import { loadEffectiveGjcPluginRegistry, registryPathForScope } from "./registry";
import { type SessionQuarantine, type SessionValidationResult, validateSessionBundles } from "./session-validation";
import type { GjcPluginRegistryEntry, GjcPluginScope, JsonSchema202012, NormalizedToolSurfaceV2 } from "./types";

export interface AlwaysOnPluginTools {
	tools: CustomTool[];
	quarantine: SessionQuarantine[];
}

export interface GjcPluginToolDeclaration extends NormalizedToolSurfaceV2 {
	plugin: string;
	scope: GjcPluginScope;
}

function isWithin(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function resolveRuntimeFile(root: string, relativePath: string): Promise<string> {
	const lexical = resolveWithinRoot(root, relativePath);
	const [rootReal, fileReal] = await Promise.all([fs.realpath(root), fs.realpath(lexical)]);
	if (!isWithin(rootReal, fileReal))
		throw new Error(`GJC plugin implementation escapes its installed root: ${relativePath}`);
	return fileReal;
}
/**
 * Return v2 tool declarations without reading or importing implementation
 * modules. This is the schema-serving path used by discovery and diagnostics.
 */
export async function getGjcPluginToolDeclarations(
	cwd: string,
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): Promise<GjcPluginToolDeclaration[]> {
	const entries = await loadEffectiveGjcPluginRegistry(cwd, { agentDir, profileAuthority });
	const declarations: GjcPluginToolDeclaration[] = [];
	for (const entry of entries) {
		if (!entry.enabled || entry.migration?.status === "failed") continue;
		for (const surface of entry.surfaces.tools) {
			if (isV2Tool(surface))
				declarations.push({ ...surface, plugin: entry.name, scope: entry.scope } as GjcPluginToolDeclaration);
		}
	}
	return declarations;
}

/** Serve the canonical schemas keyed by their stable tool surface id. */
export async function serveGjcPluginSchemas(
	cwd: string,
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): Promise<Record<string, JsonSchema202012>> {
	const declarations = await getGjcPluginToolDeclarations(cwd, agentDir, profileAuthority);
	return Object.fromEntries(declarations.map(declaration => [declaration.extensionId, declaration.schema]));
}

interface FileSnapshot {
	path: string;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	ino: number;
}

interface ValidatedPluginRegistry {
	effective: GjcPluginRegistryEntry[];
	active: GjcPluginRegistryEntry[];
	quarantine: SessionQuarantine[];
	validation: SessionValidationResult;
	registryFiles: FileSnapshot[];
	pluginFiles: FileSnapshot[];
}

interface CachedValidatedPluginRegistry extends ValidatedPluginRegistry {
	registryKey: string;
	pluginKey: string;
}

const validatedRegistryCache = new Map<string, CachedValidatedPluginRegistry>();
const hashCache = new Map<string, string>();
// Bound the digest memo so long sessions with plugin churn cannot grow it
// unboundedly; entries are re-derivable from disk at the cost of one read.
const HASH_CACHE_MAX_ENTRIES = 512;
const registryScopes: GjcPluginScope[] = ["user", "project"];

async function snapshotExistingFile(filePath: string): Promise<FileSnapshot | null> {
	try {
		const stat = await fs.stat(filePath);
		return { path: filePath, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
}

function snapshotsKey(snapshots: readonly FileSnapshot[]): string {
	return snapshots.map(s => `${s.path}:${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}`).join("|");
}

async function snapshotRegistryFiles(
	cwd: string,
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): Promise<FileSnapshot[]> {
	const snapshots = await Promise.all(
		registryScopes.map(scope => snapshotExistingFile(registryPathForScope(scope, cwd, agentDir, profileAuthority))),
	);
	return snapshots.filter((s): s is FileSnapshot => s !== null);
}

async function snapshotPluginFiles(entries: readonly GjcPluginRegistryEntry[]): Promise<FileSnapshot[]> {
	const snapshots: FileSnapshot[] = [];
	for (const entry of entries) {
		if (!entry.enabled) continue;
		for (const file of entry.copiedFiles) {
			const abs = path.join(entry.pluginRoot, file.relativePath);
			const snapshot = await snapshotExistingFile(abs);
			if (!snapshot) {
				snapshots.push({ path: abs, mtimeMs: Number.NaN, ctimeMs: Number.NaN, size: Number.NaN, ino: Number.NaN });
			} else {
				snapshots.push(snapshot);
			}
		}
	}
	return snapshots;
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

async function hashFile(snapshot: FileSnapshot): Promise<string> {
	const key = `${snapshot.path}:${snapshot.mtimeMs}:${snapshot.ctimeMs}:${snapshot.size}:${snapshot.ino}`;
	const cached = hashCache.get(key);
	if (cached) return cached;
	const digest = sha256(await fs.readFile(snapshot.path));
	if (hashCache.size >= HASH_CACHE_MAX_ENTRIES) {
		// FIFO eviction is sufficient: the memo only avoids re-reads within a
		// session; correctness never depends on a hit.
		const oldest = hashCache.keys().next().value;
		if (oldest !== undefined) hashCache.delete(oldest);
	}
	hashCache.set(key, digest);
	return digest;
}

async function verifyEntryHashesCached(entry: GjcPluginRegistryEntry): Promise<SessionQuarantine | null> {
	for (const file of entry.copiedFiles) {
		let abs: string;
		try {
			abs = resolveWithinRoot(entry.pluginRoot, file.relativePath);
		} catch (error) {
			return {
				identity: bundleIdentity(entry.scope, entry.name),
				plugin: entry.name,
				surfaceId: `plugin:${entry.name}`,
				code: "runtime_mismatch",
				message: error instanceof Error ? error.message : String(error),
			};
		}
		const snapshot = await snapshotExistingFile(abs);
		if (!snapshot) {
			return {
				identity: bundleIdentity(entry.scope, entry.name),
				plugin: entry.name,
				surfaceId: `plugin:${entry.name}`,
				code: "runtime_mismatch",
				message: `Installed file missing: ${file.relativePath}`,
			};
		}
		if ((await hashFile(snapshot)) !== file.sha256) {
			return {
				identity: bundleIdentity(entry.scope, entry.name),
				plugin: entry.name,
				surfaceId: `plugin:${entry.name}`,
				code: "runtime_mismatch",
				message: `Installed file hash drift: ${file.relativePath}`,
			};
		}
	}
	return null;
}

async function loadValidatedPluginRegistry(
	cwd: string,
	agentDir?: string,
	profileAuthority?: ProfileAuthority,
): Promise<ValidatedPluginRegistry> {
	const cacheKey = JSON.stringify([cwd, agentDir ?? null, profileAuthority ?? null]);
	const registryFiles = await snapshotRegistryFiles(cwd, agentDir, profileAuthority);
	const registryKey = snapshotsKey(registryFiles);
	const cached = validatedRegistryCache.get(cacheKey);
	if (cached && cached.registryKey === registryKey) {
		const pluginFiles = await snapshotPluginFiles(cached.effective);
		const pluginKey = snapshotsKey(pluginFiles);
		if (cached.pluginKey === pluginKey) return cached;
	}

	const effective = await loadEffectiveGjcPluginRegistry(cwd, { agentDir, profileAuthority });
	const currentRegistryFiles = await snapshotRegistryFiles(cwd, agentDir, profileAuthority);
	const preQuarantine: SessionQuarantine[] = [];
	for (const entry of effective) {
		if (!entry.enabled) continue;
		const drift = await verifyEntryHashesCached(entry);
		if (drift) preQuarantine.push(drift);
	}
	const validation = validateSessionBundles(effective, {}, preQuarantine);
	const pluginFiles = await snapshotPluginFiles(effective);
	const next: CachedValidatedPluginRegistry = {
		effective,
		active: validation.active,
		quarantine: validation.quarantine,
		validation,
		registryFiles: currentRegistryFiles,
		pluginFiles,
		registryKey: snapshotsKey(currentRegistryFiles),
		pluginKey: snapshotsKey(pluginFiles),
	};
	validatedRegistryCache.set(cacheKey, next);
	return next;
}

/**
 * Load the always-on plugin tool surfaces for the effective registry at `cwd`.
 *
 * Safety properties:
 * - Hash drift quarantines the plugin (runtime_mismatch) before any import.
 * - Session-start collisions vs reserved/built-in names quarantine fail-closed.
 * - Manifest-declared tool names are authoritative: a factory that returns a
 *   different/extra/missing name is rejected with runtime_mismatch and skipped.
 * - Reserved tool names are never overwritten.
 *
 * Returns an empty result when no plugins are installed, so callers that always
 * call this in `createAgentSession` incur no behavior change without plugins.
 */
export async function loadAlwaysOnPluginTools(input: {
	cwd: string;
	reservedToolNames: string[];
	declarations?: readonly GjcPluginToolDeclaration[];
	agentDir?: string;
	profileAuthority?: ProfileAuthority;
	/** Test seam runs before the final per-import integrity guard. */
	beforeImport?: (resolvedPath: string) => Promise<void>;
}): Promise<AlwaysOnPluginTools> {
	const validated = await loadValidatedPluginRegistry(input.cwd, input.agentDir, input.profileAuthority);
	const { effective } = validated;
	if (effective.length === 0) return { tools: [], quarantine: [] };

	const reserved = new Set(input.reservedToolNames);
	const { active, quarantine } = validateSessionBundles(
		effective,
		{ toolNames: input.reservedToolNames },
		validated.quarantine,
	);

	// Map declared (path -> name) for every active always-on tool surface.
	const declaredMetadata = new Map(
		(input.declarations ?? []).map(surface => [`${surface.scope}:${surface.plugin}:${surface.extensionId}`, surface]),
	);
	const declared = new Map<
		string,
		{
			name: string;
			plugin: string;
			scope: GjcPluginScope;
			pluginRoot: string;
			relativePath: string;
			implementationHash?: string;
		}
	>();
	for (const entry of active) {
		const disabled = new Set(entry.disabledSurfaceIds);
		for (const t of entry.surfaces.tools) {
			if (disabled.has(t.extensionId)) continue;
			let implementationPath: string;
			try {
				implementationPath = await resolveRuntimeFile(entry.pluginRoot, t.relativePath);
			} catch (error) {
				quarantine.push({
					identity: bundleIdentity(entry.scope, entry.name),
					plugin: entry.name,
					surfaceId: t.extensionId,
					code: "runtime_mismatch",
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			const metadata = declaredMetadata.get(`${entry.scope}:${entry.name}:${t.extensionId}`);
			declared.set(implementationPath, {
				name: t.name,
				plugin: entry.name,
				scope: entry.scope,
				pluginRoot: entry.pluginRoot,
				relativePath: t.relativePath,
				implementationHash:
					metadata?.implementationHash ??
					("implementationHash" in t && typeof t.implementationHash === "string"
						? t.implementationHash
						: undefined),
			});
		}
	}
	if (declared.size === 0) return { tools: [], quarantine };

	// Declaration and activation are separate: all metadata is read first, then
	// each implementation is hash-checked immediately before the single import.
	for (const [declaredPath, info] of [...declared]) {
		if (!info.implementationHash) continue;
		try {
			await verifyImplementationHash(declaredPath, info.implementationHash);
		} catch (error) {
			quarantine.push({
				identity: bundleIdentity(info.scope, info.plugin),
				plugin: info.plugin,
				surfaceId: `tool:${info.name}`,
				code:
					error instanceof Error && "code" in error && (error as { code?: unknown }).code === "hash_mismatch"
						? "runtime_mismatch"
						: "runtime_mismatch",
				message: error instanceof Error ? error.message : String(error),
			});
			declared.delete(declaredPath);
		}
	}
	if (declared.size === 0) return { tools: [], quarantine };
	const loaded = await loadCustomTools(
		[...declared.keys()].map(p => ({ path: p })),
		input.cwd,
		input.reservedToolNames,
		undefined,
		async resolvedPath => {
			await input.beforeImport?.(resolvedPath);
			const info = declared.get(path.resolve(resolvedPath));
			if (!info?.implementationHash) throw new Error(`Unregistered or unhashed GJC tool import: ${resolvedPath}`);
			const finalPath = await resolveRuntimeFile(info.pluginRoot, info.relativePath);
			if (path.resolve(finalPath) !== path.resolve(resolvedPath))
				throw new Error(`GJC tool path drifted before import: ${info.relativePath}`);
			await verifyImplementationHash(finalPath, info.implementationHash);
		},
	);

	// Group loaded tools by their source path for exact-name verification.
	const byPath = new Map<string, string[]>();
	for (const lt of loaded.tools) {
		const key = path.resolve(lt.path);
		const list = byPath.get(key) ?? [];
		list.push(lt.tool.name);
		byPath.set(key, list);
	}

	const tools: CustomTool[] = [];
	const seenNames = new Set<string>(reserved);
	for (const [declaredPath, info] of declared) {
		const returned = byPath.get(path.resolve(declaredPath)) ?? [];
		// Manifest is authoritative: exactly the one declared name must come back.
		if (returned.length !== 1 || returned[0] !== info.name) {
			quarantine.push({
				identity: bundleIdentity(info.scope, info.plugin),
				plugin: info.plugin,
				surfaceId: `tool:${info.name}`,
				code: "runtime_mismatch",
				message: `Tool factory returned ${JSON.stringify(returned)}, expected exactly ["${info.name}"]`,
			});
			continue;
		}
		if (seenNames.has(info.name)) {
			// Defense in depth: never overwrite a reserved/earlier name.
			quarantine.push({
				identity: bundleIdentity(info.scope, info.plugin),
				plugin: info.plugin,
				surfaceId: `tool:${info.name}`,
				code: "session_collision",
				message: `Tool name "${info.name}" already present; refusing to overwrite`,
			});
			continue;
		}
		const match = loaded.tools.find(lt => path.resolve(lt.path) === path.resolve(declaredPath));
		if (match) {
			tools.push(match.tool);
			seenNames.add(info.name);
		}
	}
	return { tools, quarantine };
}

/**
 * Render the always-on system-appendix blocks for the effective registry at
 * `cwd`, applying hash-drift + collision quarantine first. Returns "" when no
 * plugins are installed/enabled. Safe to call unconditionally at session start.
 */
export async function renderAlwaysOnSystemAppendices(input: {
	cwd: string;
	agentDir?: string;
	profileAuthority?: ProfileAuthority;
}): Promise<string> {
	const { effective, active } = await loadValidatedPluginRegistry(input.cwd, input.agentDir, input.profileAuthority);
	if (effective.length === 0) return "";
	const { renderPluginAppendices } = await import("./prompt-appendix");
	return (await renderPluginAppendices(active)).system;
}

/**
 * Render the agent-appendix block and Tier-1 sub-skill advertisement for a role
 * agent at session/spawn time. Hash-drift + collision quarantine applied first.
 * Returns empty strings when nothing applies.
 */
export async function renderAgentPromptAdditions(input: {
	cwd: string;
	agentName: string;
	agentDir?: string;
	profileAuthority?: ProfileAuthority;
}): Promise<{ appendix: string; advertisement: string }> {
	const { effective, active } = await loadValidatedPluginRegistry(input.cwd, input.agentDir, input.profileAuthority);
	if (effective.length === 0) return { appendix: "", advertisement: "" };
	const { renderPluginAppendices } = await import("./prompt-appendix");
	const { buildAgentSubskillAdvertisement } = await import("./injection");
	const rendered = await renderPluginAppendices(active);
	return {
		appendix: rendered.byAgent.get(input.agentName as never) ?? "",
		advertisement: buildAgentSubskillAdvertisement(active, input.agentName),
	};
}

/**
 * Render the Tier-1 sub-skill advertisement for a workflow parent skill.
 * Returns "" when nothing applies. Quarantine applied first.
 */
export async function renderSkillAdvertisement(input: {
	cwd: string;
	skillName: string;
	phase?: string;
	agentDir?: string;
	profileAuthority?: ProfileAuthority;
}): Promise<string> {
	const { effective, active } = await loadValidatedPluginRegistry(input.cwd, input.agentDir, input.profileAuthority);
	if (effective.length === 0) return "";
	const { buildSubskillAdvertisement } = await import("./injection");
	return buildSubskillAdvertisement(active, input.skillName, input.phase);
}

/**
 * Convert active plugin-bundle MCP surfaces into runtime MCPServerConfig entries,
 * applying install + runtime MCP policy (URL scheme/private-range deny, DNS
 * re-resolution for http/sse, stdio root-confinement) before connection. Servers
 * failing policy are quarantined and excluded. Returns {} when none.
 */
export async function buildPluginMcpConfigs(input: {
	cwd: string;
	agentDir?: string;
	profileAuthority?: ProfileAuthority;
}): Promise<{
	configs: Record<string, any>;
	sources: Record<string, { provider: string; providerName: string; level: "user" | "project"; path: string }>;
	quarantine: SessionQuarantine[];
}> {
	const { effective, active, quarantine } = await loadValidatedPluginRegistry(
		input.cwd,
		input.agentDir,
		input.profileAuthority,
	);
	if (effective.length === 0) return { configs: {}, sources: {}, quarantine: [] };
	const { assertMcpInstallPolicy, assertDnsResolvesPublic, assertUrlAllowed } = await import("./mcp-policy");
	const nodePath = await import("node:path");

	// A manifest-controlled MCP name such as "constructor" or "toString" must
	// remain an ordinary own key rather than interacting with Object.prototype.
	const configs: Record<string, any> = Object.create(null) as Record<string, any>;
	const sources: Record<string, { provider: string; providerName: string; level: "user" | "project"; path: string }> =
		Object.create(null) as Record<
			string,
			{ provider: string; providerName: string; level: "user" | "project"; path: string }
		>;
	for (const entry of active) {
		const disabled = new Set(entry.disabledSurfaceIds);
		for (const m of entry.surfaces.mcps) {
			if (disabled.has(m.extensionId)) continue;
			const cfg = m.config;
			try {
				assertMcpInstallPolicy(cfg, { pluginRoot: entry.pluginRoot });
				if (cfg.transport === "stdio") {
					configs[m.name] = {
						type: "stdio",
						command: cfg.command,
						args: cfg.args,
						cwd: cfg.cwd ? nodePath.resolve(entry.pluginRoot, cfg.cwd) : entry.pluginRoot,
						timeout: 5_000,
						// Third-party plugin MCP processes must not inherit host secrets;
						// only a minimal OS allowlist (PATH/HOME/temp/locale) is provided.
						noInheritEnv: true,
					};
				} else {
					const url = assertUrlAllowed(cfg.url ?? "", `MCP "${m.name}" url`);
					await assertDnsResolvesPublic(url.hostname, `MCP "${m.name}" host`);
					// Headers are intentionally NOT forwarded: the generic MCP config
					// resolution path expands ${env:...}/shell templates, which would let
					// a third-party bundle exfiltrate host secrets. Plugin-bundle MCP
					// servers connect without bundle-declared headers.
					configs[m.name] = bindPluginMcpToPublicNetwork({ type: cfg.transport, url: url.toString() });
				}
				sources[m.name] = {
					provider: "gjc-plugins",
					providerName: "GJC plugin bundle",
					level: entry.scope === "user" ? "user" : "project",
					path: entry.manifestPath,
				};
			} catch (error) {
				quarantine.push({
					identity: bundleIdentity(entry.scope, entry.name),
					plugin: entry.name,
					surfaceId: m.extensionId,
					code: "security_policy",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return { configs, sources, quarantine };
}
