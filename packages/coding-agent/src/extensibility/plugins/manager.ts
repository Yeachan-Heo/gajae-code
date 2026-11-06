import type { Stats } from "node:fs";
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	getPluginsDir,
	getPluginsLinksRegistry,
	getPluginsLockfile,
	getPluginsNodeModules,
	getPluginsPackageJson,
	getProjectDir,
	getProjectPluginOverridesPath,
	isEnoent,
	logger,
} from "@gajae-code/utils";
import { withFileLock } from "../../config/file-lock";
import { extractPackageName, parsePluginSpec } from "./parser";
import { resolvePluginLinkPath } from "./plugin-link-path";
import type {
	DoctorCheck,
	DoctorOptions,
	InstalledPlugin,
	InstallOptions,
	PluginManifest,
	PluginRuntimeConfig,
	PluginSettingSchema,
	ProjectPluginOverrides,
} from "./types";

interface PluginLinkEntry {
	name: string;
	version: string;
	path: string;
}

interface PluginLinksRegistry {
	links: Record<string, PluginLinkEntry>;
}

// =============================================================================
// Validation
// =============================================================================

/** Valid npm package name pattern (scoped and unscoped, with optional version) */
const VALID_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-._^~>=<]+)?$/i;

/**
 * Validate package name to prevent command injection.
 */
function validatePackageName(name: string): void {
	// Remove version specifier for validation
	const baseName = extractPackageName(name);
	if (!VALID_PACKAGE_NAME.test(baseName)) {
		throw new Error(`Invalid package name: ${name}`);
	}
	// Extra safety: no shell metacharacters
	if (/[;&|`$(){}[\]<>\\]/.test(name)) {
		throw new Error(`Invalid characters in package name: ${name}`);
	}
}

// =============================================================================
// Atomic Write
// =============================================================================

/**
 * Open `<file>.tmp` with O_CREAT|O_EXCL. A directory stays put so the open
 * fails because that name already exists. Any other existing entry is unlinked
 * first: unlink does not follow a symlink, and a hard link loses only that
 * name. Exclusive create then refuses a link planted in that gap.
 */
async function openExclusiveRegistryTemp(tmpPath: string): Promise<FileHandle> {
	let existing: Stats | undefined;
	try {
		existing = await fsp.lstat(tmpPath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	if (existing && !existing.isDirectory()) {
		await fsp.unlink(tmpPath);
	}
	const handle = await fsp.open(tmpPath, "wx", 0o600);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.nlink > 1) {
			throw Object.assign(new Error(`registry temp at ${tmpPath} is not a new ordinary file`), {
				code: "unsafe_registry_link",
			});
		}
		return handle;
	} catch (err) {
		await handle.close();
		await fsp.unlink(tmpPath).catch(() => {});
		throw err;
	}
}

/**
 * Write JSON atomically with exclusive temp file, sync to disk, and rename.
 * If interrupted, the previous valid file is preserved.
 */
async function atomicWriteLinksRegistry(filePath: string, data: unknown): Promise<void> {
	const content = `${JSON.stringify(data, null, 2)}\n`;
	const tmpPath = `${filePath}.tmp`;
	// Bun.write creates missing parents. Exclusive open does not, so keep that.
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	const handle = await openExclusiveRegistryTemp(tmpPath);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} catch (err) {
		await fsp.unlink(tmpPath).catch(() => {});
		throw err;
	} finally {
		await handle.close();
	}

	try {
		await fsp.rename(tmpPath, filePath);
	} catch (err) {
		// Windows EPERM fallback: unlink target, then rename
		if ((err as NodeJS.ErrnoException).code === "EPERM") {
			try {
				await fsp.unlink(filePath);
			} catch {
				// Target may not exist — that's fine
			}
			await fsp.rename(tmpPath, filePath);
		} else {
			// Clean up tmp on unexpected errors
			try {
				await fsp.unlink(tmpPath);
			} catch {
				// Best effort
			}
			throw err;
		}
	}
}

// =============================================================================
// Plugin Manager
// =============================================================================

export type PluginEnablementState =
	| { status: "ok"; enabled: boolean; baseline: string }
	| { status: "not_installed" }
	| { status: "malformed" };

export class PluginManager {
	#runtimeConfig: PluginRuntimeConfig | null = null;
	#cwd: string;

	constructor(cwd: string = getProjectDir()) {
		this.#cwd = cwd;
	}

	/**
	 * Read-only durable-enablement snapshot for one npm plugin, scope-qualified.
	 * `"user"` reads the shared runtime lock file (~/.gjc/plugins/gjc-plugins.lock.json);
	 * `"project"` reads this project's `.gjc/plugin-overrides.json` disabled list.
	 * A malformed underlying file is reported distinctly from "not installed" —
	 * neither is silently treated as an empty/enabled state.
	 */
	async getEnablementState(name: string, scope: "user" | "project"): Promise<PluginEnablementState> {
		if (scope === "user") {
			let config: PluginRuntimeConfig;
			try {
				config = await this.#loadRuntimeConfigStrict();
			} catch {
				return { status: "malformed" };
			}
			const current = config.plugins[name];
			if (!current) return { status: "not_installed" };
			return { status: "ok", enabled: current.enabled !== false, baseline: JSON.stringify({ scope, current }) };
		}
		let overrides: ProjectPluginOverrides;
		try {
			overrides = await this.#loadProjectOverridesStrict();
		} catch {
			return { status: "malformed" };
		}
		// Project scope has no independent "installed" concept (it modifies the
		// same npm-managed package the user scope tracks); absence of a user
		// entry means there is nothing this project scope could be disabling.
		let config: PluginRuntimeConfig;
		try {
			config = await this.#loadRuntimeConfigStrict();
		} catch {
			return { status: "malformed" };
		}
		if (!config.plugins[name]) return { status: "not_installed" };
		const disabled = [...(overrides.disabled ?? [])].sort();
		return { status: "ok", enabled: !disabled.includes(name), baseline: JSON.stringify({ scope, disabled }) };
	}

	/**
	 * Durable enablement toggle used by doctor quarantine and the plugin CLI.
	 * No install/fetch/reinstall occurs — this only flips the durable enabled
	 * flag a future session-startup load (`getEnabledPlugins`) consults: the
	 * user-scope runtime lock file, or the project's disabled-list override.
	 * Serialized under the canonical native-identity-bound file lock shared
	 * with every other writer of the same file (bounded retry/timeout,
	 * owner-safe release — never an unbounded wait, never a blind `rm`).
	 * `expectedBaseline` is required: a caller with no prior
	 * {@link getEnablementState} read has no CAS authority to mutate.
	 */
	async setEnabled(
		name: string,
		enabled: boolean,
		scope: "user" | "project",
		expectedBaseline: string,
	): Promise<{ status: "updated" | "not_needed"; enabled: boolean; version?: string }> {
		if (scope === "project") return await this.#setProjectEnabled(name, enabled, expectedBaseline);
		const lockfilePath = getPluginsLockfile();
		return await withFileLock(lockfilePath, async () => {
			this.#runtimeConfig = null;
			let config: PluginRuntimeConfig;
			try {
				config = await this.#loadRuntimeConfigStrict();
			} catch (error) {
				throw Object.assign(new Error(`Plugin runtime config is malformed at ${lockfilePath}`), {
					code: "malformed_registry",
					cause: error,
				});
			}
			const current = config.plugins[name];
			if (!current) throw Object.assign(new Error(`Plugin "${name}" is not installed`), { code: "not_installed" });
			const baseline = JSON.stringify({ scope: "user" as const, current });
			if (baseline !== expectedBaseline)
				throw Object.assign(new Error("The installed plugin entry changed since it was reviewed"), {
					code: "stale_baseline",
				});
			if (current.enabled === enabled) return { status: "not_needed" as const, enabled, version: current.version };
			config.plugins[name] = { ...current, enabled };
			this.#runtimeConfig = config;
			await this.#saveRuntimeConfig();
			return { status: "updated" as const, enabled, version: current.version };
		});
	}

	/**
	 * Project-scoped disable: adds/removes `name` from the project's
	 * `.gjc/plugin-overrides.json` disabled list. Serialized under that exact
	 * file's canonical file lock so an ordinary override edit and this doctor
	 * toggle cannot race and clobber each other's sibling entries.
	 */
	async #setProjectEnabled(
		name: string,
		enabled: boolean,
		expectedBaseline: string,
	): Promise<{ status: "updated" | "not_needed"; enabled: boolean }> {
		const overridesPath = getProjectPluginOverridesPath(this.#cwd);
		return await withFileLock(overridesPath, async () => {
			let overrides: ProjectPluginOverrides;
			try {
				overrides = await this.#loadProjectOverridesStrict();
			} catch (error) {
				throw Object.assign(new Error(`Project plugin overrides are malformed at ${overridesPath}`), {
					code: "malformed_registry",
					cause: error,
				});
			}
			const disabled = [...(overrides.disabled ?? [])].sort();
			const baseline = JSON.stringify({ scope: "project" as const, disabled });
			if (baseline !== expectedBaseline)
				throw Object.assign(new Error("The project plugin overrides changed since they were reviewed"), {
					code: "stale_baseline",
				});
			const wasDisabled = disabled.includes(name);
			if (wasDisabled === !enabled) return { status: "not_needed" as const, enabled };
			const nextDisabled = enabled ? disabled.filter(n => n !== name) : [...new Set([...disabled, name])].sort();
			const next: ProjectPluginOverrides = { ...overrides, disabled: nextDisabled };
			await fs.promises.mkdir(path.dirname(overridesPath), { recursive: true });
			const tmpPath = `${overridesPath}.tmp-${process.pid}-${Date.now()}`;
			await fs.promises.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`);
			await fs.promises.rename(tmpPath, overridesPath);
			return { status: "updated" as const, enabled };
		});
	}

	// ==========================================================================
	// Runtime Config Management
	// ==========================================================================

	async #loadRuntimeConfig(): Promise<PluginRuntimeConfig> {
		try {
			return await this.#loadRuntimeConfigStrict();
		} catch (err) {
			logger.warn("Failed to load plugin runtime config", { path: getPluginsLockfile(), error: String(err) });
			return { plugins: {}, settings: {} };
		}
	}

	/**
	 * Strict variant: a missing lock file is legitimately empty (no plugins
	 * installed yet), but malformed JSON must never be silently coerced into
	 * an empty config — a mutating writer built on that would overwrite (and
	 * lose) an unreadable but non-empty runtime config.
	 */
	async #loadRuntimeConfigStrict(): Promise<PluginRuntimeConfig> {
		const lockPath = getPluginsLockfile();
		let text: string;
		try {
			text = await Bun.file(lockPath).text();
		} catch (err) {
			if (isEnoent(err)) return { plugins: {}, settings: {} };
			throw err;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw Object.assign(new Error(`Plugin runtime config is malformed at ${lockPath}`), {
				code: "malformed_registry",
				cause: error,
			});
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as PluginRuntimeConfig).plugins !== "object" ||
			(parsed as PluginRuntimeConfig).plugins === null
		) {
			throw Object.assign(new Error(`Plugin runtime config has an unsupported shape at ${lockPath}`), {
				code: "malformed_registry",
			});
		}
		const config = parsed as PluginRuntimeConfig;
		return { plugins: config.plugins ?? {}, settings: config.settings ?? {} };
	}

	async #ensureConfigLoaded(): Promise<PluginRuntimeConfig> {
		if (!this.#runtimeConfig) {
			this.#runtimeConfig = await this.#loadRuntimeConfig();
		}
		return this.#runtimeConfig;
	}

	async #saveRuntimeConfig(): Promise<void> {
		await this.#ensureConfigLoaded();
		await Bun.write(getPluginsLockfile(), JSON.stringify(this.#runtimeConfig, null, 2));
	}

	async #loadLinksRegistry(): Promise<PluginLinksRegistry> {
		const registryPath = getPluginsLinksRegistry();
		try {
			const parsed = await Bun.file(registryPath).json();
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				typeof (parsed as PluginLinksRegistry).links !== "object" ||
				(parsed as PluginLinksRegistry).links === null
			) {
				return { links: {} };
			}
			return parsed as PluginLinksRegistry;
		} catch (err) {
			if (isEnoent(err)) return { links: {} };
			throw err;
		}
	}

	async #saveLinksRegistry(registry: PluginLinksRegistry): Promise<void> {
		await atomicWriteLinksRegistry(getPluginsLinksRegistry(), registry);
	}

	async #loadProjectOverrides(): Promise<ProjectPluginOverrides> {
		try {
			return await this.#loadProjectOverridesStrict();
		} catch (err) {
			logger.warn("Failed to load project plugin overrides", {
				path: getProjectPluginOverridesPath(this.#cwd),
				error: String(err),
			});
			return {};
		}
	}

	/** Strict variant: missing is empty; malformed JSON/shape throws. */
	async #loadProjectOverridesStrict(): Promise<ProjectPluginOverrides> {
		const overridesPath = getProjectPluginOverridesPath(this.#cwd);
		let text: string;
		try {
			text = await Bun.file(overridesPath).text();
		} catch (err) {
			if (isEnoent(err)) return {};
			throw err;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw Object.assign(new Error(`Project plugin overrides are malformed at ${overridesPath}`), {
				code: "malformed_registry",
				cause: error,
			});
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw Object.assign(new Error(`Project plugin overrides have an unsupported shape at ${overridesPath}`), {
				code: "malformed_registry",
			});
		}
		return parsed as ProjectPluginOverrides;
	}

	// ==========================================================================
	// Directory Management
	// ==========================================================================

	async #ensurePluginsDir(): Promise<void> {
		await fs.promises.mkdir(getPluginsDir(), { recursive: true });
		await fs.promises.mkdir(getPluginsNodeModules(), { recursive: true });
	}

	async #ensurePackageJson(): Promise<void> {
		const pkgJsonPath = getPluginsPackageJson();
		try {
			await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (isEnoent(err)) {
				await Bun.write(
					pkgJsonPath,
					JSON.stringify(
						{
							name: "gjc-plugins",
							private: true,
							dependencies: {},
						},
						null,
						2,
					),
				);
				return;
			}
			throw err;
		}
	}

	// ==========================================================================
	// Install / Uninstall
	// ==========================================================================

	/**
	 * Install a plugin from npm with optional feature selection.
	 *
	 * @param specString - Package specifier with optional features: "pkg", "pkg[feat]", "pkg[*]", "pkg[]"
	 * @param options - Install options
	 * @returns Installed plugin metadata
	 */
	async install(specString: string, options: InstallOptions = {}): Promise<InstalledPlugin> {
		const spec = parsePluginSpec(specString);
		validatePackageName(spec.packageName);

		await this.#ensurePackageJson();

		if (options.dryRun) {
			return {
				name: spec.packageName,
				version: "0.0.0-dryrun",
				path: "",
				manifest: { version: "0.0.0-dryrun" },
				enabledFeatures: spec.features === "*" ? null : (spec.features as string[] | null),
				enabled: true,
			};
		}

		// Run npm install
		const proc = Bun.spawn(["bun", "install", spec.packageName], {
			cwd: getPluginsDir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`npm install failed: ${stderr}`);
		}

		// Resolve actual package name (strip version specifier)
		const actualName = extractPackageName(spec.packageName);
		const pkgPath = path.join(getPluginsNodeModules(), actualName, "package.json");

		let pkg: { name: string; version: string; gjc?: PluginManifest; pi?: PluginManifest };
		try {
			pkg = await Bun.file(pkgPath).json();
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(`Package installed but package.json not found at ${pkgPath}`);
			}
			throw err;
		}
		const manifest: PluginManifest = pkg.gjc || pkg.pi || { version: pkg.version };
		manifest.version = pkg.version;

		// Resolve enabled features
		let enabledFeatures: string[] | null = null;
		if (spec.features === "*") {
			// All features
			enabledFeatures = manifest.features ? Object.keys(manifest.features) : null;
		} else if (Array.isArray(spec.features)) {
			if (spec.features.length > 0) {
				// Validate requested features exist
				if (manifest.features) {
					for (const feat of spec.features) {
						if (!(feat in manifest.features)) {
							throw new Error(
								`Unknown feature "${feat}" in ${actualName}. Available: ${Object.keys(manifest.features).join(", ")}`,
							);
						}
					}
				}
				enabledFeatures = spec.features;
			} else {
				// Empty array = no optional features
				enabledFeatures = [];
			}
		}
		// null = use defaults

		// Update runtime config under lock to serialize with link() calls
		return await withFileLock(getPluginsLinksRegistry(), async () => {
			const config = await this.#ensureConfigLoaded();
			config.plugins[pkg.name] = {
				version: pkg.version,
				enabledFeatures,
				enabled: true,
			};
			await this.#saveRuntimeConfig();

			return {
				name: pkg.name,
				version: pkg.version,
				path: path.join(getPluginsNodeModules(), actualName),
				manifest,
				enabledFeatures,
				enabled: true,
			};
		});
	}

	/**
	 * Validate what {@link uninstall} would remove, without removing it.
	 *
	 * Strictly read-only: it applies the same name validation the real uninstall
	 * applies and returns before the plugin manifest is materialized, before
	 * `bun uninstall` runs, and before the runtime config is rewritten.
	 */
	async previewUninstall(name: string): Promise<void> {
		validatePackageName(name);
	}

	/**
	 * Uninstall a plugin.
	 * For npm packages in dependencies, runs bun uninstall.
	 * For linked-only plugins, skips bun uninstall and removes from registry/symlinks.
	 *
	 * Package directories in node_modules are left to Bun's management:
	 * - For npm packages, bun uninstall handles cleanup of all transitive dependencies.
	 * - For linked plugins, the source directory is external and should never be deleted.
	 */
	async uninstall(name: string): Promise<void> {
		validatePackageName(name);
		await this.#ensurePackageJson();

		const pkgJsonPath = getPluginsPackageJson();
		let pkg: { dependencies?: Record<string, string> };
		try {
			pkg = await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (!isEnoent(err)) throw err;
			pkg = {};
		}

		// Only run bun uninstall if the package is in package.json dependencies
		if (pkg.dependencies?.[name]) {
			const proc = Bun.spawn(["bun", "uninstall", name], {
				cwd: getPluginsDir(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});

			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				throw new Error(`bun uninstall failed for ${name}`);
			}
		}

		// Serialize link registry updates with link() via shared lock
		await withFileLock(getPluginsLinksRegistry(), async () => {
			// Remove from links registry if it was a linked plugin
			const registry = await this.#loadLinksRegistry();
			const registeredEntry = registry.links[name];
			if (registeredEntry) {
				delete registry.links[name];
				await this.#saveLinksRegistry(registry);
			}

			// Remove symlink from node_modules if it exists.
			// If it's a real directory (retained by Bun because another plugin depends
			// on it), leave it to Bun to manage; don't try to unlink directories.
			const linkPath = resolvePluginLinkPath(getPluginsNodeModules(), name);
			try {
				const stats = await fsp.lstat(linkPath);
				if (stats.isSymbolicLink()) {
					// Only remove symlinks owned by the links registry that point at the source
					if (registeredEntry) {
						const targetPath = await fsp.readlink(linkPath);
						if (targetPath === registeredEntry.path) {
							await fsp.unlink(linkPath);
						}
					}
				}
				// If it's a directory, leave it; Bun will manage cleanup of retained transitive deps
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
		});

		// Remove from runtime config
		const config = await this.#ensureConfigLoaded();
		delete config.plugins[name];
		delete config.settings[name];
		await this.#saveRuntimeConfig();
	}

	/**
	 * List all installed plugins (from both package.json and links registry).
	 */
	async list(): Promise<InstalledPlugin[]> {
		const pkgJsonPath = getPluginsPackageJson();
		let pkg: { dependencies?: Record<string, string> };
		try {
			pkg = await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}

		const deps = pkg.dependencies || {};
		const linksRegistry = await this.#loadLinksRegistry();
		const allNames = new Set([...Object.keys(deps), ...Object.keys(linksRegistry.links)]);
		const projectOverrides = await this.#loadProjectOverrides();
		const config = await this.#ensureConfigLoaded();
		const plugins: InstalledPlugin[] = [];

		for (const name of allNames) {
			const nodeModulesPath = getPluginsNodeModules();
			const pluginPkgPath = path.join(nodeModulesPath, name, "package.json");
			let pluginPkg: { version: string; gjc?: PluginManifest; pi?: PluginManifest };
			try {
				pluginPkg = await Bun.file(pluginPkgPath).json();
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			const manifest: PluginManifest = pluginPkg.gjc || pluginPkg.pi || { version: pluginPkg.version };
			manifest.version = pluginPkg.version;

			const runtimeState = config.plugins[name] || {
				version: pluginPkg.version,
				enabledFeatures: null,
				enabled: true,
			};

			// Apply project overrides
			const isDisabledInProject = projectOverrides.disabled?.includes(name) ?? false;
			const projectFeatures = projectOverrides.features?.[name];

			plugins.push({
				name,
				version: pluginPkg.version,
				path: path.join(nodeModulesPath, name),
				manifest,
				enabledFeatures: projectFeatures ?? runtimeState.enabledFeatures,
				enabled: runtimeState.enabled && !isDisabledInProject,
			});
		}

		return plugins;
	}

	/**
	 * Link a local plugin for development.
	 * Records the link in a gjc-owned registry (separate from package.json dependencies)
	 * and creates a symlink in node_modules. Later `bun install` calls won't replace the link.
	 * Serialized under the plugins lock to prevent concurrent update races with install().
	 */
	async link(localPath: string): Promise<InstalledPlugin> {
		const absolutePath = path.resolve(this.#cwd, localPath);

		const pkgFilePath = path.join(absolutePath, "package.json");
		let pkg: { name?: string; version: string; gjc?: PluginManifest; pi?: PluginManifest };
		try {
			pkg = await Bun.file(pkgFilePath).json();
		} catch (err) {
			if (isEnoent(err)) throw new Error(`package.json not found at ${absolutePath}`);
			throw err;
		}
		if (!pkg.name) {
			throw new Error("package.json must have a name field");
		}
		const packageName: string = pkg.name;

		await this.#ensurePluginsDir();
		await this.#ensurePackageJson();

		const linkPath = resolvePluginLinkPath(getPluginsNodeModules(), packageName);

		// Serialize link registration with install() via shared lock
		return await withFileLock(getPluginsLinksRegistry(), async () => {
			// Handle scoped packages
			if (packageName.startsWith("@")) {
				const scopeDir = path.dirname(linkPath);
				await fs.promises.mkdir(scopeDir, { recursive: true });
			}

			// Remove existing
			try {
				const stats = await fs.promises.lstat(linkPath);
				if (stats.isSymbolicLink() || stats.isDirectory()) {
					await fs.promises.unlink(linkPath);
				}
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}

			// Create symlink (keep it in node_modules, not in package.json dependencies)
			await fs.promises.symlink(absolutePath, linkPath);

			const manifest: PluginManifest = pkg.gjc || pkg.pi || { version: pkg.version };
			manifest.version = pkg.version;

			// Register link in gjc-owned registry (not in package.json dependencies)
			const registry = await this.#loadLinksRegistry();
			registry.links[packageName] = {
				name: packageName,
				version: pkg.version,
				path: absolutePath,
			};
			await this.#saveLinksRegistry(registry);

			// Add to runtime config
			const config = await this.#ensureConfigLoaded();
			config.plugins[packageName] = {
				version: pkg.version,
				enabledFeatures: null,
				enabled: true,
			};
			await this.#saveRuntimeConfig();

			return {
				name: packageName,
				version: pkg.version,
				path: absolutePath,
				manifest,
				enabledFeatures: null,
				enabled: true,
			};
		});
	}

	// ==========================================================================
	// Features
	// ==========================================================================

	/**
	 * Get enabled features for a plugin.
	 */
	async getEnabledFeatures(name: string): Promise<string[] | null> {
		const config = await this.#ensureConfigLoaded();
		return config.plugins[name]?.enabledFeatures ?? null;
	}

	/**
	 * Set enabled features for a plugin.
	 */
	async setEnabledFeatures(name: string, features: string[] | null): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.plugins[name]) {
			throw new Error(`Plugin ${name} not found in runtime config`);
		}

		// Validate features if setting specific ones
		if (features && features.length > 0) {
			const plugins = await this.list();
			const plugin = plugins.find(p => p.name === name);
			if (plugin?.manifest.features) {
				for (const feat of features) {
					if (!(feat in plugin.manifest.features)) {
						throw new Error(
							`Unknown feature "${feat}" in ${name}. Available: ${Object.keys(plugin.manifest.features).join(", ")}`,
						);
					}
				}
			}
		}

		config.plugins[name].enabledFeatures = features;
		await this.#saveRuntimeConfig();
	}

	// ==========================================================================
	// Settings
	// ==========================================================================

	/**
	 * Get all settings for a plugin.
	 */
	async getPluginSettings(name: string): Promise<Record<string, unknown>> {
		const config = await this.#ensureConfigLoaded();
		const global = config.settings[name] || {};
		const projectOverrides = await this.#loadProjectOverrides();
		const project = projectOverrides.settings?.[name] || {};

		// Project settings override global
		return { ...global, ...project };
	}

	/**
	 * Set a plugin setting value.
	 */
	async setPluginSetting(name: string, key: string, value: unknown): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.settings[name]) {
			config.settings[name] = {};
		}
		config.settings[name][key] = value;
		await this.#saveRuntimeConfig();
	}

	/**
	 * Delete a plugin setting.
	 */
	async deletePluginSetting(name: string, key: string): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (config.settings[name]) {
			delete config.settings[name][key];
			await this.#saveRuntimeConfig();
		}
	}

	// ==========================================================================
	// Doctor
	// ==========================================================================

	/**
	 * Run health checks on the plugin system.
	 */
	async doctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
		const checks: DoctorCheck[] = [];

		// Check 1: Plugins directory exists
		const pluginsDir = getPluginsDir();
		const pluginsDirExists = fs.existsSync(pluginsDir);
		checks.push({
			name: "plugins_directory",
			status: pluginsDirExists ? "ok" : "warning",
			message: pluginsDirExists ? `Found at ${pluginsDir}` : "Not created yet",
		});

		// Check 2: package.json exists
		const pkgJsonPath = getPluginsPackageJson();
		let pkg: { dependencies?: Record<string, string> };
		let hasPkgJson = true;
		try {
			pkg = await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (isEnoent(err)) {
				hasPkgJson = false;
				pkg = {};
			} else {
				throw err;
			}
		}
		checks.push({
			name: "package_manifest",
			status: hasPkgJson ? "ok" : "warning",
			message: hasPkgJson ? "Found" : "Not created yet",
		});

		// Check 3: node_modules exists
		const nodeModulesPath = getPluginsNodeModules();
		const hasNodeModules = fs.existsSync(nodeModulesPath);
		checks.push({
			name: "node_modules",
			status: hasNodeModules ? "ok" : hasPkgJson ? "error" : "warning",
			message: hasNodeModules ? "Found" : "Missing (run npm install in plugins dir)",
		});

		if (!hasPkgJson) {
			return checks;
		}
		const deps = pkg.dependencies || {};
		const linksRegistry = await this.#loadLinksRegistry();
		// Combine both npm dependencies and linked plugins for installed check
		const allInstalled: Record<string, true> = {};
		for (const name of Object.keys(deps)) {
			allInstalled[name] = true;
		}
		for (const name of Object.keys(linksRegistry.links)) {
			allInstalled[name] = true;
		}
		const config = await this.#ensureConfigLoaded();

		for (const [name] of Object.entries(allInstalled)) {
			const pluginPath = path.join(nodeModulesPath, name);
			const pluginPkgPath = path.join(pluginPath, "package.json");

			let pluginPkg: { version: string; description?: string; gjc?: PluginManifest; pi?: PluginManifest };
			try {
				pluginPkg = await Bun.file(pluginPkgPath).json();
			} catch (err) {
				if (isEnoent(err)) {
					if (!fs.existsSync(pluginPath)) {
						let fixed = false;
						if (options.fix) {
							if (linksRegistry.links[name]) {
								fixed = await this.#fixMissingLinkedPlugin(name, linksRegistry.links[name]);
							} else {
								fixed = await this.#fixMissingPlugin();
							}
						}
						checks.push({
							name: `plugin:${name}`,
							status: "error",
							message: "Missing from node_modules",
							fixed,
						});
					} else {
						checks.push({
							name: `plugin:${name}`,
							status: "error",
							message: "Missing package.json",
						});
					}
					continue;
				}
				throw err;
			}
			const hasManifest = !!(pluginPkg.gjc || pluginPkg.pi);
			const manifest: PluginManifest | undefined = pluginPkg.gjc || pluginPkg.pi;

			checks.push({
				name: `plugin:${name}`,
				status: hasManifest ? "ok" : "warning",
				message: hasManifest
					? `v${pluginPkg.version}${pluginPkg.description ? ` - ${pluginPkg.description}` : ""}`
					: `v${pluginPkg.version} - No gjc/pi manifest (not an gjc plugin)`,
			});

			// Check tools path exists if specified
			if (manifest?.tools) {
				const toolsPath = path.join(pluginPath, manifest.tools);
				if (!fs.existsSync(toolsPath)) {
					checks.push({
						name: `plugin:${name}:tools`,
						status: "error",
						message: `Tools entry "${manifest.tools}" not found`,
					});
				}
			}

			// Check hooks path exists if specified
			if (manifest?.hooks) {
				const hooksPath = path.join(pluginPath, manifest.hooks);
				if (!fs.existsSync(hooksPath)) {
					checks.push({
						name: `plugin:${name}:hooks`,
						status: "error",
						message: `Hooks entry "${manifest.hooks}" not found`,
					});
				}
			}

			// Check extension entry paths exist if specified
			if (manifest?.extensions) {
				for (const extensionPath of manifest.extensions) {
					const resolvedExtensionPath = path.join(pluginPath, extensionPath);
					if (!fs.existsSync(resolvedExtensionPath)) {
						checks.push({
							name: `plugin:${name}:extension:${extensionPath}`,
							status: "error",
							message: `Extension entry "${extensionPath}" not found`,
						});
					}
				}
			}

			// Check enabled features exist in manifest
			const runtimeState = config.plugins[name];
			if (runtimeState?.enabledFeatures && manifest?.features) {
				for (const feat of runtimeState.enabledFeatures) {
					if (!(feat in manifest.features)) {
						const fixed = options.fix ? await this.#removeInvalidFeature(name, feat) : false;
						checks.push({
							name: `plugin:${name}:feature:${feat}`,
							status: "warning",
							message: `Enabled feature "${feat}" not in manifest`,
							fixed,
						});
					}
				}
			}
		}

		// Check for orphaned runtime config entries
		for (const name of Object.keys(config.plugins)) {
			if (!(name in allInstalled)) {
				const fixed = options.fix ? await this.#removeOrphanedConfig(name) : false;
				checks.push({
					name: `orphan:${name}`,
					status: "warning",
					message: "Plugin in config but not installed",
					fixed,
				});
			}
		}

		return checks;
	}

	async #fixMissingPlugin(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["bun", "install"], {
				cwd: getPluginsDir(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			return (await proc.exited) === 0;
		} catch {
			return false;
		}
	}

	async #fixMissingLinkedPlugin(name: string, entry: PluginLinkEntry): Promise<boolean> {
		try {
			// Check if the registered source path still exists
			try {
				await fsp.stat(entry.path);
			} catch (err) {
				if (isEnoent(err)) {
					// Source path is gone; the link is broken
					return false;
				}
				throw err;
			}

			const nodeModulesPath = getPluginsNodeModules();
			const linkPath = resolvePluginLinkPath(nodeModulesPath, name);

			// Ensure parent directory exists for both scoped and unscoped packages
			const linkParentDir = path.dirname(linkPath);
			await fsp.mkdir(linkParentDir, { recursive: true });

			// Remove existing symlink/directory if present
			try {
				const stats = await fsp.lstat(linkPath);
				if (stats.isSymbolicLink() || stats.isDirectory()) {
					await fsp.unlink(linkPath);
				}
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}

			// Recreate the symlink
			await fsp.symlink(entry.path, linkPath);

			return true;
		} catch {
			return false;
		}
	}

	async #removeInvalidFeature(name: string, feat: string): Promise<boolean> {
		const config = await this.#ensureConfigLoaded();
		const state = config.plugins[name];
		if (state?.enabledFeatures) {
			state.enabledFeatures = state.enabledFeatures.filter(f => f !== feat);
			await this.#saveRuntimeConfig();
			return true;
		}
		return false;
	}

	async #removeOrphanedConfig(name: string): Promise<boolean> {
		const config = await this.#ensureConfigLoaded();
		delete config.plugins[name];
		delete config.settings[name];
		await this.#saveRuntimeConfig();
		return true;
	}
}

// =============================================================================
// Setting Validation
// =============================================================================

export interface ValidationResult {
	valid: boolean;
	error?: string;
}

/**
 * Validate a setting value against its schema.
 */
export function validateSetting(value: unknown, schema: PluginSettingSchema): ValidationResult {
	switch (schema.type) {
		case "string":
			if (typeof value !== "string") {
				return { valid: false, error: "Expected string" };
			}
			break;

		case "number":
			if (typeof value !== "number" || Number.isNaN(value)) {
				return { valid: false, error: "Expected number" };
			}
			if (schema.min !== undefined && value < schema.min) {
				return { valid: false, error: `Must be >= ${schema.min}` };
			}
			if (schema.max !== undefined && value > schema.max) {
				return { valid: false, error: `Must be <= ${schema.max}` };
			}
			break;

		case "boolean":
			if (typeof value !== "boolean") {
				return { valid: false, error: "Expected boolean" };
			}
			break;

		case "enum":
			if (!schema.values.includes(String(value))) {
				return { valid: false, error: `Must be one of: ${schema.values.join(", ")}` };
			}
			break;
	}

	return { valid: true };
}

/**
 * Parse a string value according to a setting schema's type.
 */
export function parseSettingValue(valueStr: string, schema: PluginSettingSchema): unknown {
	switch (schema.type) {
		case "number":
			return Number(valueStr);

		case "boolean":
			return valueStr === "true" || valueStr === "yes" || valueStr === "1";
		default:
			return valueStr;
	}
}
