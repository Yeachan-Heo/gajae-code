import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDir, getProjectPluginOverridesPath, isEnoent, logger } from "@gajae-code/utils";
import { getProfilePluginsDir } from "./marketplace/registry";
import { extractPackageName, parsePluginSpec } from "./parser";
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
// Plugin Manager
// =============================================================================

export class PluginManager {
	#runtimeConfig: PluginRuntimeConfig | null = null;
	#cwd: string;
	#agentDir: string | undefined;

	constructor(cwd: string = getProjectDir(), agentDir?: string) {
		this.#cwd = cwd;
		this.#agentDir = agentDir;
	}

	#getPluginsDir(): string {
		return getProfilePluginsDir(this.#agentDir);
	}

	#getPluginsNodeModules(): string {
		return path.join(this.#getPluginsDir(), "node_modules");
	}

	#getPluginsPackageJson(): string {
		return path.join(this.#getPluginsDir(), "package.json");
	}

	#getPluginsLockfile(): string {
		return path.join(this.#getPluginsDir(), "gjc-plugins.lock.json");
	}

	// ==========================================================================
	// Runtime Config Management
	// ==========================================================================

	async #loadRuntimeConfig(): Promise<PluginRuntimeConfig> {
		const lockPath = this.#getPluginsLockfile();
		try {
			return await Bun.file(lockPath).json();
		} catch (err) {
			if (isEnoent(err)) return { plugins: {}, settings: {} };
			logger.warn("Failed to load plugin runtime config", { path: lockPath, error: String(err) });
			return { plugins: {}, settings: {} };
		}
	}

	async #ensureConfigLoaded(): Promise<PluginRuntimeConfig> {
		if (!this.#runtimeConfig) {
			this.#runtimeConfig = await this.#loadRuntimeConfig();
		}
		return this.#runtimeConfig;
	}

	async #saveRuntimeConfig(): Promise<void> {
		await this.#ensureConfigLoaded();
		await Bun.write(this.#getPluginsLockfile(), JSON.stringify(this.#runtimeConfig, null, 2));
	}

	async #loadProjectOverrides(): Promise<ProjectPluginOverrides> {
		const overridesPath = getProjectPluginOverridesPath(this.#cwd);
		try {
			return await Bun.file(overridesPath).json();
		} catch (err) {
			if (isEnoent(err)) return {};
			logger.warn("Failed to load project plugin overrides", { path: overridesPath, error: String(err) });
			return {};
		}
	}

	// ==========================================================================
	// Directory Management
	// ==========================================================================

	async #ensurePluginsDir(): Promise<void> {
		await fs.promises.mkdir(this.#getPluginsDir(), { recursive: true });
		await fs.promises.mkdir(this.#getPluginsNodeModules(), { recursive: true });
	}

	async #ensurePackageJson(): Promise<void> {
		const pkgJsonPath = this.#getPluginsPackageJson();
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
			cwd: this.#getPluginsDir(),
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
		const pkgPath = path.join(this.#getPluginsNodeModules(), actualName, "package.json");

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

		// Update runtime config
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
			path: path.join(this.#getPluginsNodeModules(), actualName),
			manifest,
			enabledFeatures,
			enabled: true,
		};
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
	 */
	async uninstall(name: string): Promise<void> {
		validatePackageName(name);
		await this.#ensurePackageJson();

		const proc = Bun.spawn(["bun", "uninstall", name], {
			cwd: this.#getPluginsDir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`npm uninstall failed for ${name}`);
		}

		// Remove from runtime config
		const config = await this.#ensureConfigLoaded();
		delete config.plugins[name];
		delete config.settings[name];
		await this.#saveRuntimeConfig();
	}

	/**
	 * List all installed plugins.
	 */
	async list(): Promise<InstalledPlugin[]> {
		const pkgJsonPath = this.#getPluginsPackageJson();
		let pkg: { dependencies?: Record<string, string> };
		try {
			pkg = await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}

		const deps = pkg.dependencies || {};
		const projectOverrides = await this.#loadProjectOverrides();
		const config = await this.#ensureConfigLoaded();
		const plugins: InstalledPlugin[] = [];

		for (const [name] of Object.entries(deps)) {
			const pluginPkgPath = path.join(this.#getPluginsNodeModules(), name, "package.json");
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
				path: path.join(this.#getPluginsNodeModules(), name),
				manifest,
				enabledFeatures: projectFeatures ?? runtimeState.enabledFeatures,
				enabled: runtimeState.enabled && !isDisabledInProject,
			});
		}

		return plugins;
	}

	/**
	 * Link a local plugin for development.
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

		await this.#ensurePluginsDir();

		const linkPath = path.join(this.#getPluginsNodeModules(), pkg.name);

		// Handle scoped packages
		if (pkg.name.startsWith("@")) {
			const scopeDir = path.join(this.#getPluginsNodeModules(), pkg.name.split("/")[0]);
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

		await fs.promises.symlink(absolutePath, linkPath);

		const manifest: PluginManifest = pkg.gjc || pkg.pi || { version: pkg.version };
		manifest.version = pkg.version;

		// Add to runtime config
		const config = await this.#ensureConfigLoaded();
		config.plugins[pkg.name] = {
			version: pkg.version,
			enabledFeatures: null,
			enabled: true,
		};
		await this.#saveRuntimeConfig();

		return {
			name: pkg.name,
			version: pkg.version,
			path: absolutePath,
			manifest,
			enabledFeatures: null,
			enabled: true,
		};
	}

	// ==========================================================================
	// Enable / Disable
	// ==========================================================================

	/**
	 * Enable or disable a plugin globally.
	 */
	async setEnabled(name: string, enabled: boolean): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.plugins[name]) {
			throw new Error(`Plugin ${name} not found in runtime config`);
		}
		config.plugins[name].enabled = enabled;
		await this.#saveRuntimeConfig();
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
		const pluginsDir = this.#getPluginsDir();
		const pluginsDirExists = fs.existsSync(pluginsDir);
		checks.push({
			name: "plugins_directory",
			status: pluginsDirExists ? "ok" : "warning",
			message: pluginsDirExists ? `Found at ${pluginsDir}` : "Not created yet",
		});

		// Check 2: package.json exists
		const pkgJsonPath = this.#getPluginsPackageJson();
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
		const nodeModulesPath = this.#getPluginsNodeModules();
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
		const config = await this.#ensureConfigLoaded();

		for (const [name] of Object.entries(deps)) {
			const pluginPath = path.join(nodeModulesPath, name);
			const pluginPkgPath = path.join(pluginPath, "package.json");

			let pluginPkg: { version: string; description?: string; gjc?: PluginManifest; pi?: PluginManifest };
			try {
				pluginPkg = await Bun.file(pluginPkgPath).json();
			} catch (err) {
				if (isEnoent(err)) {
					if (!fs.existsSync(pluginPath)) {
						const fixed = options.fix ? await this.#fixMissingPlugin() : false;
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
			if (!(name in deps)) {
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
				cwd: this.#getPluginsDir(),
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
