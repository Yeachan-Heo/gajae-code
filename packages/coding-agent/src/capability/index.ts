/**
 * Capability Registry
 *
 * Central registry for capabilities and providers. Provides the main API for:
 * - Defining capabilities (what we're looking for)
 * - Registering providers (where to find it)
 * - Loading items for a capability across all providers
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getAgentDir,
	getConfigDirName,
	getPluginsDir,
	getProjectDir,
	getTrustedHomeDir,
	logger,
} from "@gajae-code/utils";

import type { Settings } from "../config/settings";
import { clearCache as clearFsCache, findRepoRoot, cacheStats as fsCacheStats, invalidate as invalidateFs } from "./fs";
import type {
	Capability,
	CapabilityInfo,
	CapabilityResult,
	LoadContext,
	LoadOptions,
	Provider,
	ProviderInfo,
	SourceMeta,
} from "./types";

// =============================================================================
// Registry State
// =============================================================================

/** Registry of all capabilities */
const capabilities = new Map<string, Capability<unknown>>();

/** Reverse index: provider ID -> capability IDs it's registered for */
const providerCapabilities = new Map<string, Set<string>>();

/** Provider display metadata (shared across capabilities) */
const providerMeta = new Map<string, { displayName: string; description: string }>();

/** Disabled providers (by ID) */
const disabledProviders = new Set<string>();

/** User/project roots used by providers that derive paths from LoadContext.home/cwd. */
const EXPLICIT_HOME_PROVIDER_ROOTS = [
	// `claude` and `codex` are import aliases for the registered hook providers.
	{ providerIds: ["claude", "claude-hooks"], user: null, project: ".claude" },
	{ providerIds: ["codex", "codex-hooks"], user: null, project: ".codex" },
	{ providerIds: ["gemini"], user: ".gemini", project: ".gemini" },
	{ providerIds: ["opencode"], user: path.join(".config", "opencode"), project: ".opencode" },
	{ providerIds: ["opencode"], user: null, project: "opencode.json" },
	{ providerIds: ["cursor"], user: ".cursor", project: ".cursor" },
	{ providerIds: ["windsurf"], user: path.join(".codeium", "windsurf"), project: ".windsurf" },
	{ providerIds: ["cline"], user: null, project: ".clinerules" },
	{ providerIds: ["github"], user: null, project: ".github" },
	{ providerIds: ["agents"], user: ".agent", project: ".agent" },
	{ providerIds: ["agents"], user: ".agents", project: ".agents" },
	{ providerIds: ["agents-md"], user: null, project: "AGENTS.md" },
	{ providerIds: ["mcp-json"], user: null, project: "mcp.json" },
	{ providerIds: ["mcp-json"], user: null, project: ".mcp.json" },
	{ providerIds: ["ssh-json"], user: null, project: "ssh.json" },
	{ providerIds: ["ssh-json"], user: null, project: ".ssh.json" },
] as const;

const ANCESTOR_SCOPED_PROJECT_PROVIDERS = new Set(["agents", "agents-md", "cline"]);

function isWithinOrEqual(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve a path through the real path of its deepest existing ancestor,
 * re-appending any not-yet-created suffix. Explicit-home discovery accepts
 * fresh project paths, but must not let a symlinked existing ancestor alias a
 * directory outside the supplied home.
 */
async function canonicalizeThroughExistingAncestor(target: string): Promise<string> {
	const resolved = path.resolve(target);
	const suffix: string[] = [];
	let current = resolved;

	while (true) {
		try {
			const real = await fs.realpath(current);
			return suffix.length > 0 ? path.join(real, ...suffix.reverse()) : real;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = path.dirname(current);
			if (parent === current) return resolved;
			suffix.push(path.basename(current));
			current = parent;
		}
	}
}

async function canonicalizeContainedPath(root: string, target: string, label: string): Promise<string> {
	const canonical = await canonicalizeThroughExistingAncestor(target);
	if (!isWithinOrEqual(root, canonical)) {
		throw new Error(
			`loadCapabilityForHome ${label} escapes the supplied home through a symlink: "${target}" resolves to "${canonical}" outside "${root}".`,
		);
	}
	return canonical;
}

/**
 * Validate every config root that explicit-home discovery can use before any
 * provider is invoked. A symlinked `.gjc`/`agent`/`plugins` directory would
 * otherwise make a path that is lexically inside the supplied home read an
 * unrelated profile.
 */
async function assertExplicitHomeRoots(
	canonicalHome: string,
	cwd: string,
	explicitAgentDir: boolean,
	providerIds: ReadonlySet<string>,
): Promise<void> {
	const userRoots = new Map<string, string>();
	const projectRoots = new Map<string, { label: string; walksAncestors: boolean }>();
	const addUserRoot = (root: string, label: string): void => {
		if (!userRoots.has(root)) userRoots.set(root, label);
	};
	const addProjectRoot = (root: string, label: string, walksAncestors = false): void => {
		if (!projectRoots.has(root)) projectRoots.set(root, { label, walksAncestors });
	};

	// Resolve aliases before selecting roots. For example, the registered
	// `claude-hooks` provider uses the `.claude` root shared by the `claude`
	// import convention, while only its project scope is actually loaded.
	for (const source of EXPLICIT_HOME_PROVIDER_ROOTS) {
		if (!source.providerIds.some(providerId => providerIds.has(providerId))) continue;
		const label = source.providerIds.join("/");
		if (source.user) addUserRoot(path.join(canonicalHome, source.user), `${label} user root`);
		if (source.project)
			addProjectRoot(
				source.project,
				`${label} project root`,
				source.providerIds.some(providerId => ANCESTOR_SCOPED_PROJECT_PROVIDERS.has(providerId)),
			);
	}

	// Native and SSH providers use the managed agent directory for user scope,
	// while native, SSH, and project-scoped SSH config also read the project
	// config root. An explicit agent directory is intentionally allowed outside
	// the supplied home and is validated separately by the caller.
	const usesNative = providerIds.has("native");
	const usesSsh = providerIds.has("ssh-json");
	if ((usesNative || usesSsh) && !explicitAgentDir)
		addUserRoot(path.join(canonicalHome, getConfigDirName(), "agent"), "user agent directory");
	if (usesNative || usesSsh) {
		// Native and SSH project discovery are fixed to `.gjc`; configured project
		// roots are validated only by adapters that actually consume them below.
		addProjectRoot(".gjc", "native/SSH project registry root");
	}

	// The marketplace provider derives its user registry from the XDG-aware
	// helper rather than a fixed `<home>/.gjc/plugins` path.
	if (providerIds.has("claude-plugins")) {
		addProjectRoot(path.join(getConfigDirName(), "plugins"), "project plugin registry root", true);
		addUserRoot(getPluginsDir(canonicalHome), "plugin registry root");
	}

	await Promise.all(
		[...userRoots.entries()].map(([root, label]) => canonicalizeContainedPath(canonicalHome, root, label)),
	);

	// Validate only the roots at the boundaries their providers actually inspect.
	// Cwd-only providers must not fail because an unrelated ancestor contains a
	// symlinked config file; ancestor-scoped providers retain the full walk.
	await Promise.all(
		[...projectRoots.entries()].map(async ([relativeRoot, { label, walksAncestors }]) => {
			let current = cwd;
			while (true) {
				await canonicalizeContainedPath(canonicalHome, path.join(current, relativeRoot), label);
				if (!walksAncestors || current === canonicalHome) break;
				const parent = path.dirname(current);
				if (parent === current) break;
				current = parent;
			}
		}),
	);
}

/** Settings manager for persistence (if set) */
let settings: Settings | null = null;
/** Session-local settings keyed by normalized working directory. */
const settingsByCwd = new Map<string, Settings>();

// =============================================================================
// Registration API
// =============================================================================

/**
 * Define a new capability.
 */
export function defineCapability<T>(def: Omit<Capability<T>, "providers">): Capability<T> {
	if (capabilities.has(def.id)) {
		throw new Error(`Capability "${def.id}" is already defined`);
	}
	const capability: Capability<T> = { ...def, providers: [] };
	capabilities.set(def.id, capability as Capability<unknown>);
	return capability;
}

/**
 * Register a provider for a capability.
 */
export function registerProvider<T>(capabilityId: string, provider: Provider<T>): void {
	const capability = capabilities.get(capabilityId);
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}". Define it first with defineCapability().`);
	}

	// Store provider metadata (for cross-capability display)
	if (!providerMeta.has(provider.id)) {
		providerMeta.set(provider.id, {
			displayName: provider.displayName,
			description: provider.description,
		});
	}

	// Track which capabilities this provider is registered for
	if (!providerCapabilities.has(provider.id)) {
		providerCapabilities.set(provider.id, new Set());
	}
	providerCapabilities.get(provider.id)!.add(capabilityId);

	// Insert in priority order (highest first)
	const providers = capability.providers as Provider<T>[];
	const idx = providers.findIndex(p => p.priority < provider.priority);
	if (idx === -1) {
		providers.push(provider);
	} else {
		providers.splice(idx, 0, provider);
	}
}

// =============================================================================
// Loading API
// =============================================================================

/**
 * Async loading logic shared by loadCapability().
 */
async function loadImpl<T>(
	capability: Capability<T>,
	providers: Provider<T>[],
	ctx: LoadContext,
	options: LoadOptions,
): Promise<CapabilityResult<T>> {
	const allItems: Array<T & { _source: SourceMeta; _shadowed?: boolean }> = [];
	const allWarnings: string[] = [];
	const contributingProviders: string[] = [];
	const disabledExtensionIds = options.includeDisabled
		? new Set<string>()
		: new Set<string>(
				options.disabledExtensions ??
					options.settings?.get("disabledExtensions") ??
					(options.isolatedHome ? undefined : settings?.get("disabledExtensions")) ??
					[],
			);

	const results = await Promise.all(
		providers.map(async provider => {
			try {
				const result = await logger.time(
					`capability:${capability.id}:${provider.id}`,
					provider.load.bind(provider),
					ctx,
				);
				return { provider, result };
			} catch (error) {
				logger.debug(`capability:${capability.id}:${provider.id}:error`);
				return { provider, error };
			}
		}),
	);

	for (const entry of results) {
		const { provider } = entry;
		if ("error" in entry) {
			allWarnings.push(`[${provider.displayName}] Failed to load: ${entry.error}`);
			continue;
		}

		const result = entry.result;
		if (!result) continue;

		if (result.warnings) {
			allWarnings.push(...result.warnings.map(w => `[${provider.displayName}] ${w}`));
		}

		let contributedItemCount = 0;
		for (const item of result.items) {
			const itemWithSource = item as T & { _source: SourceMeta };
			if (!itemWithSource._source) {
				allWarnings.push(`[${provider.displayName}] Item missing _source metadata, skipping`);
				continue;
			}

			const extensionId = capability.toExtensionId?.(itemWithSource);
			if (extensionId && disabledExtensionIds.has(extensionId)) {
				continue;
			}

			itemWithSource._source.providerName = provider.displayName;
			allItems.push(itemWithSource as T & { _source: SourceMeta; _shadowed?: boolean });
			contributedItemCount += 1;
		}

		if (contributedItemCount > 0) {
			contributingProviders.push(provider.id);
		}
	}

	// Deduplicate by key (first wins = highest priority)
	const seen = new Map<string, number>();
	const deduped: Array<T & { _source: SourceMeta }> = [];

	for (let i = 0; i < allItems.length; i++) {
		const item = allItems[i];
		const key = capability.key(item);

		if (key === undefined) {
			deduped.push(item);
		} else if (!seen.has(key)) {
			seen.set(key, i);
			deduped.push(item);
		} else {
			item._shadowed = true;
		}
	}

	// Validate items (only non-shadowed items)
	if (capability.validate && !options.includeInvalid) {
		for (let i = deduped.length - 1; i >= 0; i--) {
			const error = capability.validate(deduped[i]);
			if (error) {
				const source = deduped[i]._source;
				allWarnings.push(
					`[${source?.providerName ?? "unknown"}] Invalid item at ${source?.path ?? "unknown"}: ${error}`,
				);
				deduped.splice(i, 1);
			}
		}
	}

	return {
		items: deduped,
		all: allItems,
		warnings: allWarnings,
		providers: contributingProviders,
	};
}

/**
 * Filter providers based on options and disabled state.
 */
function filterProviders<T>(capability: Capability<T>, options: LoadOptions): Provider<T>[] {
	const activeSettings = options.isolatedHome
		? options.settings
		: (options.settings ?? settingsByCwd.get(path.normalize(options.cwd ?? getProjectDir())));
	const activeDisabledProviders = new Set(
		activeSettings?.get("disabledProviders") ?? (options.isolatedHome ? [] : disabledProviders),
	);
	let providers = (capability.providers as Provider<T>[]).filter(
		p => options.includeDisabledProviders === true || !activeDisabledProviders.has(p.id),
	);
	if (options.providers) {
		const allowed = new Set(options.providers);
		providers = providers.filter(p => allowed.has(p.id));
	}
	if (options.excludeProviders) {
		const excluded = new Set(options.excludeProviders);
		providers = providers.filter(p => !excluded.has(p.id));
	}

	return providers;
}

/**
 * Load a capability by ID.
 */
export async function loadCapability<T>(capabilityId: string, options: LoadOptions = {}): Promise<CapabilityResult<T>> {
	const capability = capabilities.get(capabilityId) as Capability<T> | undefined;
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}"`);
	}

	// `isolatedHome` is an internal option used only by loadCapabilityForHome.
	// Public ordinary loads must always apply the active process settings and
	// disabled-provider/extension policy, even if a caller supplies that field.
	const ordinaryOptions: LoadOptions = options.isolatedHome ? { ...options, isolatedHome: false } : options;
	const cwd = ordinaryOptions.cwd ?? getProjectDir();
	const home = getTrustedHomeDir();
	// The process agent directory (GJC_CODING_AGENT_DIR / PI_CODING_AGENT_DIR /
	// setAgentDir()) is the default user scope for EVERY native surface, so a
	// non-default profile is never split across two directories; an explicit
	// options.agentDir wins over it. loadCapabilityForHome instead derives the
	// scope from its supplied home (explicit-home contract).
	const userAgentDir = ordinaryOptions.agentDir ? path.resolve(ordinaryOptions.agentDir) : getAgentDir();
	const repoRoot = await findRepoRoot(cwd);
	const ctx: LoadContext = {
		cwd,
		home,
		userAgentDir,
		repoRoot,
		isolatedHome: false,
		settings: ordinaryOptions.settings,
	};
	const providers = filterProviders(capability, ordinaryOptions);

	return await loadImpl(capability, providers, ctx, ordinaryOptions);
}

/**
 * Load a capability against an explicitly supplied home directory.
 *
 * Cross-profile authority contract: when an explicit `home` is supplied, the
 * load must resolve every user-scope surface from that home and NEVER fall
 * back to the process-global `getAgentDir()`. The agent directory is derived
 * from the supplied home (`<home>/<configDir>/agent`) unless the caller
 * supplies an explicit `agentDir`; there is no implicit process-profile
 * fallback. Consumers that cannot derive a user scope must fail closed.
 */
export async function loadCapabilityForHome<T>(
	capabilityId: string,
	home: string,
	options: LoadOptions = {},
): Promise<CapabilityResult<T>> {
	const capability = capabilities.get(capabilityId) as Capability<T> | undefined;
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}"`);
	}

	const resolvedHome = path.resolve(home);
	if (!path.isAbsolute(home)) {
		throw new Error(
			`loadCapabilityForHome requires an absolute home directory; received "${home}". Refusing to fall back to the process profile.`,
		);
	}
	// Derive the user agent directory from the SUPPLIED home. An explicit
	// options.agentDir is honored; otherwise `<home>/<configDirName>/agent`.
	// getAgentDir() is deliberately not consulted: an explicit home must never
	// read another profile's SYSTEM/RULES/AGENTS, skills, commands, hooks,
	// settings, or executable descriptors.
	const canonicalHome = await canonicalizeThroughExistingAncestor(resolvedHome);
	const lexicalCwd = options.cwd === undefined ? canonicalHome : path.resolve(options.cwd);
	const cwd = await canonicalizeThroughExistingAncestor(lexicalCwd);
	const homeStats = await fs.stat(canonicalHome);
	const homeIdentity = { dev: homeStats.dev, ino: homeStats.ino };
	// Every explicit-home cwd must resolve inside the supplied physical home.
	// Allowing an outside cwd would let repository and plugin-registry discovery
	// walk unrelated ancestors before the isolated boundary can take effect.
	if (!isWithinOrEqual(canonicalHome, cwd)) {
		throw new Error(
			`loadCapabilityForHome cwd is outside the supplied home: "${lexicalCwd}" resolves to "${cwd}" outside "${canonicalHome}".`,
		);
	}

	const isolatedOptions: LoadOptions = { ...options, isolatedHome: true };
	const providers = filterProviders(capability, isolatedOptions);
	const effectiveProviderIds = new Set(providers.map(provider => provider.id));
	const usesAgentScope = effectiveProviderIds.has("native") || effectiveProviderIds.has("ssh-json");
	const userAgentDir = options.agentDir
		? await canonicalizeThroughExistingAncestor(path.resolve(options.agentDir))
		: usesAgentScope
			? await canonicalizeContainedPath(
					canonicalHome,
					path.join(canonicalHome, getConfigDirName(), "agent"),
					"user agent directory",
				)
			: path.join(canonicalHome, getConfigDirName(), "agent");
	const userAgentStats = await fs.stat(userAgentDir).catch(() => null);
	const userAgentIdentity = userAgentStats ? { dev: userAgentStats.dev, ino: userAgentStats.ino } : null;
	await assertExplicitHomeRoots(canonicalHome, cwd, Boolean(options.agentDir), effectiveProviderIds);
	const repoRootCandidate = await findRepoRoot(cwd, canonicalHome, {
		isolatedHome: true,
		homeIdentity,
		home: canonicalHome,
		bypassCache: true,
	});
	const canonicalRepoRoot = repoRootCandidate ? await canonicalizeThroughExistingAncestor(repoRootCandidate) : null;
	const repoRoot =
		canonicalRepoRoot && canonicalRepoRoot !== canonicalHome && isWithinOrEqual(canonicalHome, canonicalRepoRoot)
			? canonicalRepoRoot
			: null;
	const ctx: LoadContext = {
		cwd,
		home: canonicalHome,
		userAgentDir,
		userAgentIdentity,
		repoRoot,
		isolatedHome: true,
		homeIdentity,
		settings: isolatedOptions.settings,
	};

	return await loadImpl(capability, providers, ctx, isolatedOptions);
}

// =============================================================================
// Provider Enable/Disable API
// =============================================================================

/**
 * Initialize capability system with settings manager for persistence.
 * Call this once on startup to enable persistent provider state.
 */
export function initializeWithSettings(activeSettings: Settings): void {
	settingsByCwd.set(path.normalize(activeSettings.getCwd()), activeSettings);
	settings = activeSettings;
	const disabled = activeSettings.get("disabledProviders");
	disabledProviders.clear();
	for (const id of disabled) disabledProviders.add(id);
}

/** Remove a disposed session scope without disturbing a newer replacement. */
export function releaseSettingsScope(activeSettings: Settings): void {
	const cwd = path.normalize(activeSettings.getCwd());
	if (settingsByCwd.get(cwd) === activeSettings) settingsByCwd.delete(cwd);
}

function assertDisabledProvidersWritable(activeSettings: Settings): void {
	if (!activeSettings.canWriteDurableConfig()) {
		throw new Error(
			"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
		);
	}
}
/**
 * Persist current disabled providers to settings.
 */
function persistDisabledProviders(activeSettings: Settings, providers: ReadonlySet<string>): void {
	assertDisabledProvidersWritable(activeSettings);
	activeSettings.set("disabledProviders", Array.from(providers));
}

/** Disable a provider for the supplied session settings. */
export function disableProvider(
	providerId: string,
	activeSettings: Settings = settings ??
		(() => {
			throw new Error("Capability settings unavailable");
		})(),
): void {
	const providers = new Set(activeSettings.get("disabledProviders"));
	providers.add(providerId);
	persistDisabledProviders(activeSettings, providers);
}

/** Enable a provider for the supplied session settings. */
export function enableProvider(
	providerId: string,
	activeSettings: Settings = settings ??
		(() => {
			throw new Error("Capability settings unavailable");
		})(),
): void {
	const providers = new Set(activeSettings.get("disabledProviders"));
	providers.delete(providerId);
	persistDisabledProviders(activeSettings, providers);
}

/** Check whether a provider is enabled by the supplied session settings. */
export function isProviderEnabled(
	providerId: string,
	activeSettings: Settings | undefined = settings ?? undefined,
): boolean {
	return !new Set(activeSettings?.get("disabledProviders") ?? disabledProviders).has(providerId);
}

/** Get disabled providers from the supplied session settings. */
export function getDisabledProviders(activeSettings: Settings | undefined = settings ?? undefined): string[] {
	return [...(activeSettings?.get("disabledProviders") ?? disabledProviders)];
}

/** Replace disabled providers for the supplied session settings. */
export function setDisabledProviders(
	providerIds: string[],
	activeSettings: Settings = settings ??
		(() => {
			throw new Error("Capability settings unavailable");
		})(),
): void {
	persistDisabledProviders(activeSettings, new Set(providerIds));
}

// =============================================================================
// Introspection API
// =============================================================================

/**
 * Get a capability definition (for introspection).
 */
export function getCapability<T>(id: string): Capability<T> | undefined {
	return capabilities.get(id) as Capability<T> | undefined;
}

/**
 * List all registered capability IDs.
 */
export function listCapabilities(): string[] {
	return Array.from(capabilities.keys());
}

/**
 * Get capability info for UI display.
 */
export function getCapabilityInfo(capabilityId: string): CapabilityInfo | undefined {
	const capability = capabilities.get(capabilityId);
	if (!capability) return undefined;

	return {
		id: capability.id,
		displayName: capability.displayName,
		description: capability.description,
		providers: capability.providers.map(p => ({
			id: p.id,
			displayName: p.displayName,
			description: p.description,
			priority: p.priority,
			enabled: !disabledProviders.has(p.id),
		})),
	};
}

/**
 * Get all capabilities info for UI display.
 */
export function getAllCapabilitiesInfo(): CapabilityInfo[] {
	return listCapabilities().map(id => getCapabilityInfo(id)!);
}

/**
 * Get provider info for UI display.
 */
export function getProviderInfo(providerId: string): ProviderInfo | undefined {
	const meta = providerMeta.get(providerId);
	const caps = providerCapabilities.get(providerId);
	if (!meta || !caps) return undefined;

	// Find priority from first capability's provider list
	let priority = 0;
	for (const capId of caps) {
		const cap = capabilities.get(capId);
		const provider = cap?.providers.find(p => p.id === providerId);
		if (provider) {
			priority = provider.priority;
			break;
		}
	}

	return {
		id: providerId,
		displayName: meta.displayName,
		description: meta.description,
		priority,
		capabilities: Array.from(caps),
		enabled: !disabledProviders.has(providerId),
	};
}

/**
 * Get all providers info for UI display (deduplicated across capabilities).
 */
export function getAllProvidersInfo(): ProviderInfo[] {
	const providers: ProviderInfo[] = [];

	for (const providerId of providerMeta.keys()) {
		const info = getProviderInfo(providerId);
		if (info) {
			providers.push(info);
		}
	}

	// Sort by priority (highest first)
	providers.sort((a, b) => b.priority - a.priority);

	return providers;
}

// =============================================================================
// Cache Management
// =============================================================================

/**
 * Reset all caches. Call after chdir or filesystem changes.
 */
export function reset(): void {
	clearFsCache();
}

/**
 * Invalidate cache for a specific path.
 * @param filePath - Absolute or relative path to invalidate
 */
export function invalidate(filePath: string, cwd?: string): void {
	const resolved = cwd ? path.resolve(cwd, filePath) : filePath;
	invalidateFs(resolved);
}

/**
 * Get cache stats for diagnostics.
 */
export function cacheStats(): { content: number; dir: number } {
	return fsCacheStats();
}

// =============================================================================
// Re-exports
// =============================================================================

export type * from "./types";
