/**
 * Settings singleton with sync get/set and background persistence.
 *
 * Usage:
 *   import { settings } from "./settings";
 *
 *   const enabled = settings.get("compaction.enabled");  // sync read
 *   settings.set("theme.dark", "red-claw");              // sync write, saves in background
 *
 * For tests:
 *   const isolated = Settings.isolated({ "compaction.enabled": false });
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAgentDbPath,
	getAgentDir,
	getCustomThemesDir,
	getProjectDir,
	isEnoent,
	logger,
	procmgr,
	setDefaultTabWidth,
} from "@gajae-code/utils";
import { YAML } from "bun";
import { type Settings as SettingsCapabilityItem, settingsCapability } from "../capability/settings";
import type { ModelRole } from "../config/model-registry";
import { loadCapability } from "../discovery";
import { isLightTheme, setAutoThemeMapping, setColorBlindMode, setSymbolPreset } from "../modes/theme/theme";
import { AgentStorage } from "../session/agent-storage";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import { withFileLock } from "./file-lock";
import { isModelSelectorValue, type ModelSelectorValue, normalizeModelSelectorValue } from "./model-selector-value";
import {
	type BashInterceptorRule,
	type GroupPrefix,
	type GroupTypeMap,
	getDefault,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingValue,
} from "./settings-schema";

// Re-export types that callers need
export type * from "./settings-schema";
export * from "./settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Raw settings object as stored in YAML */
export interface RawSettings {
	[key: string]: unknown;
}

type SettingsPatch = {
	readonly path: string;
	readonly value: unknown;
	readonly generation: number;
	readonly modelRole?: string;
	readonly modelRoleRevision?: number;
	readonly configVersion?: string;
	readonly legacyFallbackMigration?: boolean;
};

export interface GlobalDefaultModelRoleCommit {
	readonly previousDefault: ModelSelectorValue | undefined;
	readonly previousModelRolesExisted: boolean;
	readonly committedDefault: ModelSelectorValue | undefined;
	readonly committedConfigVersion?: string;
	readonly defaultRevision: number;
}

export interface SettingsOptions {
	/** Current working directory for project settings discovery */
	cwd?: string;
	/** Agent directory for config.yml storage */
	agentDir?: string;
	/** Don't persist to disk (for tests) */
	inMemory?: boolean;
	/** Initial overrides */
	overrides?: Partial<Record<SettingPath, unknown>>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Path Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get a nested value from an object by path segments.
 */
function getByPath(obj: RawSettings, segments: string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Set a nested value in an object by path segments.
 * Creates intermediate objects as needed.
 */
function setByPath(obj: RawSettings, segments: string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!(segment in current) || typeof current[segment] !== "object" || current[segment] === null) {
			current[segment] = {};
		}
		current = current[segment] as RawSettings;
	}
	current[segments[segments.length - 1]] = value;
}

/** Delete a nested value and prune now-empty objects. */
function deleteByPath(obj: RawSettings, segments: string[]): void {
	const parents: RawSettings[] = [];
	let current: RawSettings = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const next = current[segments[i]];
		if (!next || typeof next !== "object" || Array.isArray(next)) return;
		parents.push(current);
		current = next as RawSettings;
	}
	delete current[segments[segments.length - 1]];
	for (let i = parents.length - 1; i >= 0; i--) {
		const child = parents[i][segments[i]];
		if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) {
			delete parents[i][segments[i]];
		}
	}
}

function legacyFallbackChains(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function hasOwnModelRole(source: RawSettings, role: string): boolean {
	const roles = getByPath(source, ["modelRoles"]);
	return !!roles && typeof roles === "object" && !Array.isArray(roles) && Object.hasOwn(roles, role);
}

function selectorChain(value: unknown): string[] {
	if (typeof value === "string") return normalizeModelSelectorValue(value);
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return [];
	return normalizeModelSelectorValue(value);
}

const PATH_SCOPED_ARRAY_SETTINGS = new Set<SettingPath>(["enabledModels", "disabledProviders"]);
const LEGACY_THEME_NAME_REPLACEMENTS = {
	dark: "red-claw",
	light: "blue-crab",
} as const;

function isLegacyThemeName(name: string): name is keyof typeof LEGACY_THEME_NAME_REPLACEMENTS {
	return name === "dark" || name === "light";
}

type PathScopedStringArrayEntry = {
	path?: unknown;
	paths?: unknown;
	pathPrefix?: unknown;
	pathPrefixes?: unknown;
	values?: unknown;
	items?: unknown;
	models?: unknown;
	providers?: unknown;
};

function normalizePathPrefix(prefix: string): string {
	const expanded =
		prefix === "~" ? os.homedir() : prefix.startsWith("~/") ? path.join(os.homedir(), prefix.slice(2)) : prefix;
	return path.resolve(expanded);
}

function pathMatchesPrefix(cwd: string, prefix: string): boolean {
	const relative = path.relative(normalizePathPrefix(prefix), path.resolve(cwd));
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function stringArrayFromUnknown(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

function rawSettingsRecord(value: unknown): RawSettings | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as RawSettings;
}

function shallowModelSelectorRecord(value: unknown): Record<string, ModelSelectorValue> {
	const record = rawSettingsRecord(value);
	if (!record) return {};

	const result: Record<string, ModelSelectorValue> = {};
	for (const [key, item] of Object.entries(record)) {
		if (isModelSelectorValue(item)) result[key] = Array.isArray(item) ? [...item] : item;
	}
	return result;
}

function resolvePathScopedStringArray(settingPath: SettingPath, value: unknown, cwd: string): string[] | undefined {
	if (!PATH_SCOPED_ARRAY_SETTINGS.has(settingPath) || !Array.isArray(value)) return undefined;

	const resolved: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			resolved.push(entry);
			continue;
		}
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

		const scoped = entry as PathScopedStringArrayEntry;
		const prefixes = [
			...stringArrayFromUnknown(scoped.path),
			...stringArrayFromUnknown(scoped.paths),
			...stringArrayFromUnknown(scoped.pathPrefix),
			...stringArrayFromUnknown(scoped.pathPrefixes),
		];
		if (prefixes.length === 0 || !prefixes.some(prefix => pathMatchesPrefix(cwd, prefix))) continue;

		const values =
			settingPath === "enabledModels"
				? [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.models),
					]
				: [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.providers),
					];
		resolved.push(...values);
	}

	return resolved;
}
type DefaultModelRoleOwnership = {
	generation: number;
	configVersion?: string;
	defaultConfigVersion?: string;
	defaultLineageKnown: boolean;
};

function readConfigVersion(filePath: string): string | undefined {
	try {
		const stat = fs.statSync(filePath, { bigint: true });
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function defaultModelRoleFrom(raw: RawSettings): ModelSelectorValue | undefined {
	const value = rawSettingsRecord(raw.modelRoles)?.default;
	return isModelSelectorValue(value) ? (Array.isArray(value) ? [...value] : value) : undefined;
}

function setRawModelRole(
	raw: RawSettings,
	role: string,
	modelId: ModelSelectorValue | undefined,
	removeContainerWhenEmpty = false,
): void {
	const roles = { ...rawSettingsRecord(raw.modelRoles) };
	if (modelId === undefined) {
		delete roles[role];
		if (removeContainerWhenEmpty && Object.keys(roles).length === 0) {
			delete raw.modelRoles;
		} else {
			raw.modelRoles = roles;
		}
		return;
	}
	raw.modelRoles = { ...roles, [role]: modelId };
}

function updateModelRolesPatch(
	patch: SettingsPatch,
	role: string,
	modelId: ModelSelectorValue | undefined,
	removeContainerWhenEmpty = false,
): SettingsPatch {
	const raw: RawSettings = { modelRoles: structuredClone(patch.value) };
	setRawModelRole(raw, role, modelId, removeContainerWhenEmpty);
	return { ...patch, value: raw.modelRoles };
}

function settingsPatchKey(patch: SettingsPatch): string {
	return patch.modelRole ? `modelRoles.${patch.modelRole}` : patch.path;
}

function applySettingsPatch(raw: RawSettings, patch: SettingsPatch): void {
	if (patch.modelRole) {
		setRawModelRole(raw, patch.modelRole, patch.value as ModelSelectorValue | undefined);
		return;
	}
	if (patch.value === undefined) {
		deleteByPath(raw, patch.path.split("."));
		return;
	}
	setByPath(raw, patch.path.split("."), patch.value);
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings Class
// ═══════════════════════════════════════════════════════════════════════════

export class Settings {
	#configPath: string | null;
	#cwd: string;
	#agentDir: string;
	#storage: AgentStorage | null = null;

	/** Global settings from config.yml */
	#global: RawSettings = {};
	/** Project settings from .Anthropic model/settings.yml etc */
	#project: RawSettings = {};
	/** Runtime overrides (not persisted) */
	#overrides: RawSettings = {};
	/** Merged view (global + project + overrides) */
	#merged: RawSettings = {};

	/** Latest dirty patch for each path, owned by its generation. */
	#modified = new Map<string, SettingsPatch>();
	#nextGeneration = 0;
	#defaultModelRoleOwnership: DefaultModelRoleOwnership = { generation: 0, defaultLineageKnown: true };
	/** Pending save (debounced) */
	#saveTimer?: NodeJS.Timeout;
	#saveTail: Promise<void> = Promise.resolve();
	#globalModelRoleTail: Promise<void> = Promise.resolve();

	/** Legacy fallback migration warnings emitted once per settings instance. */
	#legacyFallbackMigrationWarnings = 0;
	#legacyFallbackMigrationGlobalFingerprint: string | undefined;

	/** Whether to persist changes */
	#persist: boolean;

	private constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		this.#configPath = options.inMemory ? null : path.join(this.#agentDir, "config.yml");
		this.#persist = !options.inMemory;

		if (options.overrides) {
			for (const [key, value] of Object.entries(options.overrides)) {
				setByPath(this.#overrides, key.split("."), value);
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Factory Methods
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initialize the global singleton.
	 * Call once at startup before accessing `settings`.
	 */
	static init(options: SettingsOptions = {}): Promise<Settings> {
		if (globalInstancePromise) return globalInstancePromise;

		const instance = new Settings(options);
		const promise = instance.#load();
		globalInstancePromise = promise;

		return promise.then(
			instance => {
				globalInstance = instance;
				globalInstancePromise = Promise.resolve(instance);
				return instance;
			},
			error => {
				globalInstance = null;
				throw error;
			},
		);
	}

	/**
	 * Create an isolated instance for testing.
	 * Does not affect the global singleton.
	 */
	static isolated(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.#rebuildMerged();
		return instance;
	}

	/**
	 * Get the global singleton.
	 * Throws if not initialized.
	 */
	static get instance(): Settings {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		return globalInstance;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Core API
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Get a setting value (sync).
	 * Returns the merged value from global + project + overrides, or the default.
	 */
	get<P extends SettingPath>(path: P): SettingValue<P> {
		const segments = path.split(".");
		const value = getByPath(this.#merged, segments);
		if (value !== undefined) {
			const pathScopedValue = resolvePathScopedStringArray(path, value, this.#cwd);
			return (pathScopedValue ?? value) as SettingValue<P>;
		}
		return getDefault(path);
	}

	/**
	 * Get a setting value from the user/global config only.
	 *
	 * Use for machine-local command hooks and other settings that must not be
	 * activated by project-scoped config files.
	 */
	getGlobal<P extends SettingPath>(path: P): SettingValue<P> | undefined {
		const value = getByPath(this.#global, path.split("."));
		return value === undefined ? undefined : (value as SettingValue<P>);
	}

	/** Check whether a setting is present in loaded settings/overrides rather than coming from schema defaults. */
	has(path: SettingPath): boolean {
		return getByPath(this.#merged, path.split(".")) !== undefined;
	}

	/**
	 * Set a setting value (sync).
	 * Updates global settings and queues a background save.
	 * Triggers hooks for settings that have side effects.
	 */
	set<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		this.#set(path, value, true);
	}

	#set<P extends SettingPath>(path: P, value: SettingValue<P>, defaultModelRoleMayHaveChanged: boolean): void {
		const prev = this.get(path);
		let modelRoleRevision: number | undefined;
		if (path === "modelRoles" && defaultModelRoleMayHaveChanged) {
			this.#defaultModelRoleOwnership.generation += 1;
			modelRoleRevision = this.#defaultModelRoleOwnership.generation;
		}
		const patch: SettingsPatch = {
			path,
			value: structuredClone(value),
			generation: ++this.#nextGeneration,
			modelRoleRevision,
			configVersion: this.#defaultModelRoleOwnership.configVersion,
		};
		setByPath(this.#global, path.split("."), structuredClone(patch.value));
		this.#modified.set(path, patch);

		this.#rebuildMerged();
		this.#queueSave();

		// Trigger hook if exists
		const hook = SETTING_HOOKS[path];
		if (hook) {
			hook(value, prev);
		}
	}

	/**
	 * Apply runtime overrides (not persisted).
	 */
	override<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const segments = path.split(".");
		setByPath(this.#overrides, segments, value);
		this.#rebuildMerged();
	}

	/**
	 * Clear a runtime override.
	 */
	clearOverride(path: SettingPath): void {
		const segments = path.split(".");
		let current = this.#overrides;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			if (!(segment in current)) return;
			current = current[segment] as RawSettings;
		}
		delete current[segments[segments.length - 1]];
		this.#rebuildMerged();
	}

	/**
	 * Flush any pending saves to disk.
	 * Call before exit to ensure all changes are persisted.
	 */
	async flush(): Promise<void> {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		const save = this.#modified.size > 0 ? this.#saveNow() : this.#saveTail;
		await save;
	}

	/**
	 * Like {@link flush}, but rejects if the durable save fails instead of
	 * swallowing the error. Use where the caller must confirm persistence before
	 * reporting success (e.g. the Telegram `/rich` toggle). In-memory instances
	 * ({@link isolated}) short-circuit in {@link #saveNow} and never throw.
	 */
	async flushOrThrow(): Promise<void> {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		const save = this.#modified.size > 0 ? this.#saveNow({ throwOnError: true }) : this.#saveTail;
		await save;
	}

	async cloneForCwd(cwd: string): Promise<Settings> {
		const cloned = new Settings({
			cwd,
			agentDir: this.#agentDir,
			inMemory: !this.#persist,
		});
		cloned.#storage = this.#storage;
		cloned.#defaultModelRoleOwnership = this.#defaultModelRoleOwnership;

		cloned.#global = structuredClone(this.#global);
		cloned.#project = this.#persist ? await cloned.#loadProjectSettings() : structuredClone(this.#project);
		cloned.#overrides = structuredClone(this.#overrides);
		await cloned.#normalizeAfterLoad();
		return cloned;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Accessors
	// ─────────────────────────────────────────────────────────────────────────

	getStorage(): AgentStorage | null {
		return this.#storage;
	}

	getCwd(): string {
		return this.#cwd;
	}

	getAgentDir(): string {
		return this.#agentDir;
	}

	getPlansDirectory(): string {
		return path.join(this.#agentDir, "plans");
	}

	/**
	 * Get shell configuration based on settings.
	 */
	getShellConfig() {
		const shell = this.get("shellPath");
		return procmgr.getShellConfig(shell);
	}

	/**
	 * Get all settings in a group with full type safety.
	 */
	getGroup<G extends GroupPrefix>(prefix: G): GroupTypeMap[G] {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			if (key.startsWith(`${prefix}.`)) {
				const suffix = key.slice(prefix.length + 1);
				result[suffix] = this.get(key);
			}
		}
		return result as unknown as GroupTypeMap[G];
	}

	/**
	 * Get the edit variant for a specific model.
	 * Returns "patch", "replace", "hashline", "vim", "apply_patch", or null (use global default).
	 */
	getEditVariantForModel(model: string | undefined): EditMode | null {
		if (!model) return null;
		const variants = (this.#merged.edit as { modelVariants?: Record<string, string> })?.modelVariants;
		if (!variants) return null;
		for (const pattern in variants) {
			if (model.includes(pattern)) {
				const value = normalizeEditMode(variants[pattern]);
				if (value) {
					return value;
				}
			}
		}
		return null;
	}

	/**
	 * Get bash interceptor rules (typed accessor for complex array config).
	 */
	getBashInterceptorRules(): BashInterceptorRule[] {
		return this.get("bashInterceptor.patterns");
	}

	/**
	 * Set a model role (helper for modelRoles record).
	 */
	setModelRole(role: ModelRole | string, modelId: string): void {
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		const updateRuntimeOverride =
			!!runtimeOverrides &&
			typeof runtimeOverrides === "object" &&
			!Array.isArray(runtimeOverrides) &&
			Object.hasOwn(runtimeOverrides, role);

		this.setGlobalModelRole(role, modelId);

		if (updateRuntimeOverride) {
			this.override("modelRoles", { ...shallowModelSelectorRecord(runtimeOverrides), [role]: modelId });
		}
	}

	setGlobalModelRole(role: ModelRole | string, modelId: string | undefined): void {
		let modelRoleRevision: number | undefined;
		if (role === "default") {
			this.#defaultModelRoleOwnership.generation += 1;
			modelRoleRevision = this.#defaultModelRoleOwnership.generation;
		}
		const patch: SettingsPatch = {
			path: "modelRoles",
			value: modelId,
			generation: ++this.#nextGeneration,
			modelRole: role,
			modelRoleRevision,
			configVersion: this.#defaultModelRoleOwnership.configVersion,
		};
		setRawModelRole(this.#global, role, modelId);
		this.#modified.set(settingsPatchKey(patch), patch);
		this.#rebuildMerged();
		this.#queueSave();
	}

	setGlobalModelRoleAndFlush(
		role: ModelRole | string,
		modelId: string | undefined,
	): Promise<GlobalDefaultModelRoleCommit> {
		const transaction = this.#globalModelRoleTail.then(() => this.#commitGlobalModelRoleAndFlush(role, modelId));
		this.#globalModelRoleTail = transaction.then(
			() => undefined,
			() => undefined,
		);
		return transaction;
	}

	restoreGlobalDefaultModelRoleIfCurrent(commit: GlobalDefaultModelRoleCommit): Promise<boolean> {
		const transaction = this.#globalModelRoleTail.then(() => this.#restoreGlobalDefaultModelRoleIfCurrent(commit));
		this.#globalModelRoleTail = transaction.then(
			() => undefined,
			() => undefined,
		);
		return transaction;
	}

	async #commitGlobalModelRoleAndFlush(
		role: ModelRole | string,
		modelId: string | undefined,
	): Promise<GlobalDefaultModelRoleCommit> {
		if (this.#persist) await this.flushOrThrow();
		const previousDefault = defaultModelRoleFrom(this.#global);
		const previousModelRolesExisted = Object.hasOwn(this.#global, "modelRoles");
		const previousDefaultRevision = this.#defaultModelRoleOwnership.generation;
		let defaultRevision = previousDefaultRevision;
		if (role === "default") {
			defaultRevision += 1;
			this.#defaultModelRoleOwnership.generation = defaultRevision;
		}
		this.#setGlobalModelRoleInMemory(role, modelId, false, true);

		if (!this.#persist || !this.#configPath) {
			return {
				previousDefault,
				previousModelRolesExisted,
				committedDefault: defaultModelRoleFrom(this.#global),
				defaultRevision,
				committedConfigVersion: undefined,
			};
		}

		let durableBeforeWrite: RawSettings | undefined;
		let durableVersionBeforeWrite: string | undefined;
		try {
			return await withFileLock(this.#configPath, async () => {
				const current = await this.#loadYaml(this.#configPath!);
				durableBeforeWrite = structuredClone(current);
				durableVersionBeforeWrite = readConfigVersion(this.#configPath!);
				const durablePreviousDefault = defaultModelRoleFrom(current);
				const durablePreviousModelRolesExisted = Object.hasOwn(current, "modelRoles");
				setRawModelRole(current, role, modelId);
				const committedDefault = defaultModelRoleFrom(current);
				await Bun.write(this.#configPath!, YAML.stringify(current, null, 2));
				const committedConfigVersion = readConfigVersion(this.#configPath!);
				this.#replaceGlobalWithDurable(
					current,
					committedConfigVersion,
					role === "default",
					durableVersionBeforeWrite,
				);
				return {
					previousDefault: durablePreviousDefault,
					previousModelRolesExisted: durablePreviousModelRolesExisted,
					committedDefault,
					committedConfigVersion,
					defaultRevision,
				};
			});
		} catch (error) {
			if (role === "default" && this.#defaultModelRoleOwnership.generation === defaultRevision) {
				if (durableBeforeWrite) {
					this.#replaceGlobalWithDurable(durableBeforeWrite, durableVersionBeforeWrite, false);
				} else {
					this.#setGlobalModelRoleInMemory("default", previousDefault, !previousModelRolesExisted, true);
				}
				this.#defaultModelRoleOwnership.generation = previousDefaultRevision;
			}
			throw error;
		}
	}

	async #restoreGlobalDefaultModelRoleIfCurrent(commit: GlobalDefaultModelRoleCommit): Promise<boolean> {
		if (this.#defaultModelRoleOwnership.generation !== commit.defaultRevision) return false;

		if (!this.#persist || !this.#configPath) {
			if (defaultModelRoleFrom(this.#global) !== commit.committedDefault) return false;
			this.#setGlobalModelRoleInMemory("default", commit.previousDefault, !commit.previousModelRolesExisted);
			this.#defaultModelRoleOwnership.generation += 1;
			return true;
		}

		const restored = await withFileLock(this.#configPath, async () => {
			if (this.#defaultModelRoleOwnership.generation !== commit.defaultRevision) return false;
			const currentConfigVersion = readConfigVersion(this.#configPath!);
			const current = await this.#loadYaml(this.#configPath!);
			if (defaultModelRoleFrom(current) !== commit.committedDefault) return false;
			if (
				commit.committedConfigVersion !== undefined &&
				currentConfigVersion !== commit.committedConfigVersion &&
				!(
					this.#defaultModelRoleOwnership.defaultConfigVersion === commit.committedConfigVersion &&
					this.#defaultModelRoleOwnership.defaultLineageKnown &&
					this.#defaultModelRoleOwnership.configVersion === currentConfigVersion
				)
			) {
				return false;
			}

			setRawModelRole(current, "default", commit.previousDefault, !commit.previousModelRolesExisted);
			await Bun.write(this.#configPath!, YAML.stringify(current, null, 2));
			const restoredConfigVersion = readConfigVersion(this.#configPath!);
			this.#replaceGlobalWithDurable(current, restoredConfigVersion, true, currentConfigVersion);
			this.#defaultModelRoleOwnership.generation += 1;
			return true;
		});
		if (!restored) return false;
		await this.flushOrThrow();
		return true;
	}

	#setGlobalModelRoleInMemory(
		role: string,
		modelId: ModelSelectorValue | undefined,
		removeContainerWhenEmpty: boolean,
		updatePendingPatch = false,
	): void {
		setRawModelRole(this.#global, role, modelId, removeContainerWhenEmpty);
		if (updatePendingPatch) {
			const rootPatch = this.#modified.get("modelRoles");
			if (rootPatch) {
				this.#modified.set("modelRoles", updateModelRolesPatch(rootPatch, role, modelId, removeContainerWhenEmpty));
			}
			const rolePatch = this.#modified.get(`modelRoles.${role}`);
			if (rolePatch) {
				this.#modified.set(`modelRoles.${role}`, { ...rolePatch, value: modelId });
			}
		}
		this.#rebuildMerged();
	}

	#replaceGlobalWithDurable(
		current: RawSettings,
		configVersion?: string,
		defaultChanged = false,
		predecessorConfigVersion = configVersion,
	): void {
		this.#global = current;
		for (const patch of this.#pendingPatchesInGenerationOrder()) {
			this.#applyPatchWithDefaultOwnership(this.#global, { ...patch, value: structuredClone(patch.value) });
		}
		const externalLineageBreak = predecessorConfigVersion !== this.#defaultModelRoleOwnership.configVersion;
		this.#defaultModelRoleOwnership.configVersion = configVersion;
		if (defaultChanged) {
			this.#defaultModelRoleOwnership.defaultConfigVersion = configVersion;
			this.#defaultModelRoleOwnership.defaultLineageKnown = true;
		} else if (externalLineageBreak) {
			this.#defaultModelRoleOwnership.defaultLineageKnown = false;
		}
		this.#rebuildMerged();
	}
	/**
	 * Set an agent model override while keeping any live runtime override aligned.
	 *
	 * Runtime model profiles override `task.agentModelOverrides` for the current
	 * session. A user-selected role assignment must win immediately in that same
	 * session, but only the explicit agent change should be persisted.
	 */
	setAgentModelOverride(agentName: string, modelId: string): void {
		const current = shallowModelSelectorRecord(getByPath(this.#global, ["task", "agentModelOverrides"]));
		const runtimeOverrides = getByPath(this.#overrides, ["task", "agentModelOverrides"]);
		const updateRuntimeOverride =
			!!runtimeOverrides && typeof runtimeOverrides === "object" && !Array.isArray(runtimeOverrides);

		this.set("task.agentModelOverrides", { ...current, [agentName]: modelId });

		if (updateRuntimeOverride) {
			this.override("task.agentModelOverrides", {
				...shallowModelSelectorRecord(runtimeOverrides),
				[agentName]: modelId,
			});
		}
	}

	/**
	 * Get a model role (helper for modelRoles record).
	 */
	getModelRole(role: ModelRole | string): ModelSelectorValue | undefined {
		const roles = this.get("modelRoles");
		return roles[role];
	}

	/**
	 * Get all model roles (helper for modelRoles record).
	 */
	getModelRoles(): Readonly<Record<string, ModelSelectorValue>> {
		return { ...this.get("modelRoles") };
	}

	/*
	 * Override model roles (helper for modelRoles record).
	 */
	overrideModelRoles(roles: Readonly<Record<string, ModelSelectorValue>>): void {
		const next = shallowModelSelectorRecord(getByPath(this.#overrides, ["modelRoles"]));
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) {
				next[role] = modelId;
			}
		}
		this.override("modelRoles", next);
	}

	/**
	 * Set disabled providers (for compatibility with discovery system).
	 */
	setDisabledProviders(ids: string[]): void {
		this.set("disabledProviders", ids);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Loading
	// ─────────────────────────────────────────────────────────────────────────

	async #load(): Promise<Settings> {
		// Project settings load (loadCapability scans cwd) is independent of the
		// persist chain (storage open → legacy migration → global config.yml read),
		// so kick it off first and await after the persist chain completes. The
		// persist steps remain sequential: migration may write config.yml, which
		// #loadYaml then reads; migration's db fallback needs #storage opened.
		const projectPromise = this.#loadProjectSettings();

		if (this.#persist) {
			this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir));
			await this.#migrateFromLegacy();
			this.#global = await this.#loadYaml(this.#configPath!);
			const configVersion = readConfigVersion(this.#configPath!);
			this.#defaultModelRoleOwnership.configVersion = configVersion;
			this.#defaultModelRoleOwnership.defaultConfigVersion = configVersion;
		}

		this.#project = await projectPromise;

		await this.#normalizeAfterLoad();
		return this;
	}

	async #normalizeAfterLoad(): Promise<void> {
		this.#sanitizeModelSelectorRecords();
		this.#rebuildMerged();
		this.#legacyFallbackMigrationGlobalFingerprint = YAML.stringify(this.#global, null, 2);
		this.#migrateRetryFallbackChains();
		// The migration recheck is only meaningful for migration-originated
		// writes; when migration touched nothing global, ordinary saves must
		// not run the conflict branch.
		if (!this.#modified.has("modelRoles") && ![...this.#modified.keys()].some(p => p.startsWith("retry.fallback"))) {
			this.#legacyFallbackMigrationGlobalFingerprint = undefined;
		}
		await this.flush();
		this.#fireAllHooks();
	}

	/**
	 * Drop malformed selector-record values (objects, empty arrays, blank
	 * members) from every source so runtime consumers see only values the
	 * published JSON schema accepts.
	 */
	#sanitizeModelSelectorRecords(): void {
		for (const source of [this.#global, this.#project, this.#overrides]) {
			for (const pathSegments of [["modelRoles"], ["task", "agentModelOverrides"]]) {
				const raw = getByPath(source, pathSegments);
				if (raw === undefined) continue;
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					logger.warn("Settings: replaced malformed model selector record", {
						path: pathSegments.join("."),
					});
					setByPath(source, pathSegments, {});
					continue;
				}
				const sanitized = shallowModelSelectorRecord(raw);
				if (Object.keys(sanitized).length !== Object.keys(raw).length) {
					logger.warn("Settings: dropped invalid model selector values", {
						path: pathSegments.join("."),
						dropped: Object.keys(raw).filter(key => !(key in sanitized)),
					});
				}
				setByPath(source, pathSegments, sanitized);
			}
		}
	}

	async #loadYaml(filePath: string): Promise<RawSettings> {
		try {
			const content = await Bun.file(filePath).text();
			const parsed = YAML.parse(content);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return {};
			}
			return this.#migrateRawSettings(parsed as RawSettings);
		} catch (error) {
			if (isEnoent(error)) return {};
			logger.warn("Settings: failed to load", { path: filePath, error: String(error) });
			return {};
		}
	}

	async #loadProjectSettings(): Promise<RawSettings> {
		try {
			const result = await loadCapability(settingsCapability.id, { cwd: this.#cwd });
			let merged: RawSettings = {};
			for (const item of result.items as SettingsCapabilityItem[]) {
				if (item.level === "project") {
					merged = this.#deepMerge(merged, item.data as RawSettings);
				}
			}
			return this.#migrateRawSettings(merged);
		} catch {
			return {};
		}
	}

	/** Convert retry.fallbackChains after global/project/override precedence is known. */
	#migrateRetryFallbackChains(): void {
		const globalChains = legacyFallbackChains(getByPath(this.#global, ["retry", "fallbackChains"]));
		const projectChains = legacyFallbackChains(getByPath(this.#project, ["retry", "fallbackChains"]));
		const overrideChains = legacyFallbackChains(getByPath(this.#overrides, ["retry", "fallbackChains"]));
		const roles = new Set([
			...Object.keys(globalChains),
			...Object.keys(projectChains),
			...Object.keys(overrideChains),
		]);
		const retainedGlobalChains: Record<string, unknown> = {};

		const effectiveRoles = shallowModelSelectorRecord(getByPath(this.#merged, ["modelRoles"]));
		for (const role of roles) {
			const source = Object.hasOwn(overrideChains, role)
				? "override"
				: Object.hasOwn(projectChains, role)
					? "project"
					: "global";
			const tailValue =
				source === "override"
					? overrideChains[role]
					: source === "project"
						? projectChains[role]
						: globalChains[role];
			const primary = selectorChain(effectiveRoles[role]);
			const tail = selectorChain(tailValue);
			const chain = [...new Set([...primary, ...tail])];

			if (primary.length === 0 || tail.length === 0) {
				this.#warnLegacyFallbackMigration(
					`retry.fallbackChains.${role} could not be migrated because it lacks a valid primary selector or tail.`,
				);
				continue;
			}

			const target =
				source === "override" || hasOwnModelRole(this.#overrides, role)
					? this.#overrides
					: source === "project" || hasOwnModelRole(this.#project, role)
						? this.#project
						: this.#global;
			const targetRoles = shallowModelSelectorRecord(getByPath(target, ["modelRoles"]));
			setByPath(target, ["modelRoles"], { ...targetRoles, [role]: chain });
			if (target === this.#global) {
				this.#recordLegacyFallbackMigrationPatch("modelRoles", getByPath(this.#global, ["modelRoles"]));
			}
			if (target !== this.#global && Object.hasOwn(globalChains, role))
				retainedGlobalChains[role] = globalChains[role];
			if (source === "project") {
				this.#warnLegacyFallbackMigration(
					`retry.fallbackChains.${role} is project-owned and was migrated in memory only.`,
				);
			}
		}

		for (const source of [this.#project, this.#overrides]) {
			deleteByPath(source, ["retry", "fallbackChains"]);
			deleteByPath(source, ["retry", "fallbackRevertPolicy"]);
		}

		if (Object.keys(retainedGlobalChains).length > 0) {
			setByPath(this.#global, ["retry", "fallbackChains"], retainedGlobalChains);
			this.#recordLegacyFallbackMigrationPatch("retry.fallbackChains", retainedGlobalChains);
		} else if (getByPath(this.#global, ["retry", "fallbackChains"]) !== undefined) {
			deleteByPath(this.#global, ["retry", "fallbackChains"]);
			this.#recordLegacyFallbackMigrationPatch("retry.fallbackChains", undefined);
		}
		if (
			Object.keys(retainedGlobalChains).length === 0 &&
			getByPath(this.#global, ["retry", "fallbackRevertPolicy"]) !== undefined
		) {
			deleteByPath(this.#global, ["retry", "fallbackRevertPolicy"]);
			this.#recordLegacyFallbackMigrationPatch("retry.fallbackRevertPolicy", undefined);
		}
		this.#rebuildMerged();
	}

	#recordLegacyFallbackMigrationPatch(path: string, value: unknown): void {
		const existing = this.#modified.get(path);
		if (existing && !existing.legacyFallbackMigration) {
			this.#modified.set(path, { ...existing, value: structuredClone(value) });
			return;
		}
		this.#modified.set(path, {
			path,
			value: structuredClone(value),
			generation: ++this.#nextGeneration,
			configVersion: this.#defaultModelRoleOwnership.configVersion,
			legacyFallbackMigration: true,
		});
	}

	#warnLegacyFallbackMigration(message: string): void {
		if (this.#legacyFallbackMigrationWarnings >= 10) return;
		this.#legacyFallbackMigrationWarnings++;
		logger.warn(`Settings: ${message}`);
	}

	async #migrateFromLegacy(): Promise<void> {
		if (!this.#configPath) return;

		// Check if config.yml already exists
		try {
			await Bun.file(this.#configPath).text();
			return; // Already exists, no migration needed
		} catch (err) {
			if (!isEnoent(err)) return;
		}

		let settings: RawSettings = {};
		let migrated = false;

		// 1. Migrate from settings.json
		const settingsJsonPath = path.join(this.#agentDir, "settings.json");
		try {
			const parsed = JSON.parse(await Bun.file(settingsJsonPath).text());
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(parsed));
				migrated = true;
				try {
					fs.renameSync(settingsJsonPath, `${settingsJsonPath}.bak`);
				} catch {}
			}
		} catch {}

		// 2. Migrate from agent.db
		try {
			const dbSettings = this.#storage?.getSettings();
			if (dbSettings) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(dbSettings as RawSettings));
				migrated = true;
			}
		} catch {}

		// 3. Write merged settings
		if (migrated && Object.keys(settings).length > 0) {
			try {
				await Bun.write(this.#configPath, YAML.stringify(settings, null, 2));
				logger.debug("Settings: migrated to config.yml", { path: this.#configPath });
			} catch {}
		}
	}

	#hasCustomThemeFile(name: string): boolean {
		try {
			return fs.existsSync(path.join(getCustomThemesDir(this.#agentDir), `${name}.json`));
		} catch {
			return false;
		}
	}

	#migrateLegacyBuiltInThemeName(name: string): string {
		if (isLegacyThemeName(name) && !this.#hasCustomThemeFile(name)) {
			return LEGACY_THEME_NAME_REPLACEMENTS[name];
		}
		return name;
	}

	#getThemeSlotForName(name: string): "dark" | "light" {
		return isLightTheme(name, this.#agentDir) ? "light" : "dark";
	}

	/** Apply schema migrations to raw settings */
	#migrateRawSettings(raw: RawSettings): RawSettings {
		// queueMode -> steeringMode
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}

		// ask.timeout: ms -> seconds (if value > 1000, it's old ms format)
		if (raw.ask && typeof (raw.ask as Record<string, unknown>).timeout === "number") {
			const oldValue = (raw.ask as Record<string, unknown>).timeout as number;
			if (oldValue > 1000) {
				(raw.ask as Record<string, unknown>).timeout = Math.round(oldValue / 1000);
			}
		}

		// Migrate old flat "theme" string to nested theme.dark/theme.light
		if (typeof raw.theme === "string") {
			const oldTheme = raw.theme;
			const migratedTheme = this.#migrateLegacyBuiltInThemeName(oldTheme);
			if (oldTheme === "dark" && migratedTheme === "red-claw") {
				raw.theme = { dark: migratedTheme };
			} else if (oldTheme === "light" && migratedTheme === "blue-crab") {
				raw.theme = { light: migratedTheme };
			} else {
				const slot = this.#getThemeSlotForName(migratedTheme);
				raw.theme = { [slot]: migratedTheme };
			}
		} else if (raw.theme && typeof raw.theme === "object" && !Array.isArray(raw.theme)) {
			const themeObj = raw.theme as Record<string, unknown>;
			if (typeof themeObj.dark === "string") {
				themeObj.dark = this.#migrateLegacyBuiltInThemeName(themeObj.dark);
			}
			if (typeof themeObj.light === "string") {
				themeObj.light = this.#migrateLegacyBuiltInThemeName(themeObj.light);
			}
		}

		// task.isolation.enabled (boolean) -> task.isolation.mode (enum)
		const taskObj = raw.task as Record<string, unknown> | undefined;
		const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;
		if (isolationObj && "enabled" in isolationObj) {
			if (typeof isolationObj.enabled === "boolean") {
				isolationObj.mode = isolationObj.enabled ? "auto" : "none";
			}
			delete isolationObj.enabled;
		}

		// task.isolation.mode: legacy values from before the pi-iso PAL refactor.
		// `worktree` was git worktree → now lives under `rcopy`. `fuse-overlay`
		// and `fuse-projfs` are now the platform-named `overlayfs` / `projfs`
		// kinds; the PAL falls back internally when the chosen one isn't
		// available, so we don't need the old TS-side platform guards.
		if (isolationObj && typeof isolationObj.mode === "string") {
			const legacy: Record<string, string> = {
				worktree: "rcopy",
				"fuse-overlay": "overlayfs",
				"fuse-projfs": "projfs",
			};
			const mapped = legacy[isolationObj.mode as string];
			if (mapped !== undefined) {
				isolationObj.mode = mapped;
			}
		}

		// edit.mode: removed "atom" variant is now "hashline"
		const editObj = raw.edit as Record<string, unknown> | undefined;
		if (editObj) {
			if (editObj.mode === "atom") {
				editObj.mode = "hashline";
			}
			const modelVariants = editObj.modelVariants as Record<string, unknown> | undefined;
			if (modelVariants && typeof modelVariants === "object" && !Array.isArray(modelVariants)) {
				for (const [pattern, variant] of Object.entries(modelVariants)) {
					if (variant === "atom") {
						modelVariants[pattern] = "hashline";
					}
				}
			}
		}
		if (raw["edit.mode"] === "atom") {
			raw["edit.mode"] = "hashline";
		}

		// statusLine: rename "plan_mode" segment to "mode"
		const statusLineObj = raw.statusLine as Record<string, unknown> | undefined;
		if (statusLineObj) {
			for (const key of ["leftSegments", "rightSegments"] as const) {
				const segments = statusLineObj[key];
				if (Array.isArray(segments)) {
					statusLineObj[key] = segments.map(seg => (seg === "plan_mode" ? "mode" : seg));
				}
			}
			const segmentOptions = statusLineObj.segmentOptions as Record<string, unknown> | undefined;
			if (segmentOptions && "plan_mode" in segmentOptions && !("mode" in segmentOptions)) {
				segmentOptions.mode = segmentOptions.plan_mode;
				delete segmentOptions.plan_mode;
			}
		}

		// Map legacy `memories.enabled` boolean to the explicit `memory.backend`
		// enum if the latter hasn't been set yet. Idempotent: subsequent
		// migrations are no-ops once memory.backend is materialised.
		const memoryBackendObj = raw.memory as Record<string, unknown> | undefined;
		const memoryBackendSet = memoryBackendObj && typeof memoryBackendObj.backend === "string";
		const memoriesObj = raw.memories as Record<string, unknown> | undefined;
		if (!memoryBackendSet && memoriesObj && typeof memoriesObj.enabled === "boolean") {
			const next = memoriesObj.enabled ? "local" : "off";
			const memoryRoot = (memoryBackendObj ?? {}) as Record<string, unknown>;
			memoryRoot.backend = next;
			raw.memory = memoryRoot;
		}

		// hindsight: dynamicBankId/agentName -> scoping enum + bankId
		// - dynamicBankId=true  → scoping="per-project" (closest semantic match;
		//   the legacy `agent::project::channel::user` tuple was per-project in
		//   practice — the channel/user env vars were rarely set).
		// - hindsight.agentName was only used as the agent slot in the legacy
		//   dynamic tuple; if the user customised it we surface it as the new
		//   bankId base when no explicit bankId is set.
		const hindsightObj = raw.hindsight as Record<string, unknown> | undefined;
		if (hindsightObj) {
			if ("dynamicBankId" in hindsightObj) {
				if (!("scoping" in hindsightObj) && hindsightObj.dynamicBankId === true) {
					hindsightObj.scoping = "per-project";
				}
				delete hindsightObj.dynamicBankId;
			}
			if ("agentName" in hindsightObj) {
				const agentName = hindsightObj.agentName;
				if (
					!("bankId" in hindsightObj) &&
					typeof agentName === "string" &&
					agentName.trim().length > 0 &&
					agentName !== "gjc"
				) {
					hindsightObj.bankId = agentName;
				}
				delete hindsightObj.agentName;
			}
		}

		return raw;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Saving
	// ─────────────────────────────────────────────────────────────────────────

	#queueSave(): void {
		if (!this.#persist || !this.#configPath) return;

		if (this.#saveTimer) clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			void this.#saveNow();
		}, 100);
	}

	#isStaleDefaultModelRolePatch(
		patch: SettingsPatch,
		currentConfigVersion = this.#defaultModelRoleOwnership.configVersion,
	): boolean {
		const changesDefault = patch.modelRole === "default" || (patch.path === "modelRoles" && !patch.modelRole);
		const generationChanged =
			patch.modelRoleRevision !== undefined &&
			patch.modelRoleRevision !== this.#defaultModelRoleOwnership.generation;
		const externalConfigChanged =
			patch.configVersion !== currentConfigVersion &&
			(this.#defaultModelRoleOwnership.configVersion !== currentConfigVersion ||
				!this.#defaultModelRoleOwnership.defaultLineageKnown);
		return changesDefault && (generationChanged || externalConfigChanged);
	}

	#pendingPatchesInGenerationOrder(): SettingsPatch[] {
		return [...this.#modified.values()].sort((left, right) => left.generation - right.generation);
	}

	#applyPatchWithDefaultOwnership(
		raw: RawSettings,
		patch: SettingsPatch,
		currentConfigVersion = this.#defaultModelRoleOwnership.configVersion,
	): boolean {
		if (!this.#isStaleDefaultModelRolePatch(patch, currentConfigVersion)) {
			applySettingsPatch(raw, patch);
			return true;
		}
		if (patch.modelRole === "default") return false;

		const durableDefault = defaultModelRoleFrom(raw);
		const roles = shallowModelSelectorRecord(patch.value);
		if (durableDefault === undefined) delete roles.default;
		else roles.default = durableDefault;
		setByPath(raw, ["modelRoles"], roles);
		return true;
	}

	async #saveNow(options: { throwOnError?: boolean } = {}): Promise<void> {
		if (!this.#persist || !this.#configPath || this.#modified.size === 0) return;

		const configPath = this.#configPath;
		let patches = this.#pendingPatchesInGenerationOrder();
		let durableBeforeWrite: RawSettings | undefined;
		let durableVersionBeforeWrite: string | undefined;

		const save = this.#saveTail.then(() =>
			withFileLock(configPath, async () => {
				const migrationFingerprint = this.#legacyFallbackMigrationGlobalFingerprint;
				this.#legacyFallbackMigrationGlobalFingerprint = undefined;
				const current = await this.#loadYaml(configPath);
				const currentConfigVersion = readConfigVersion(configPath);
				durableBeforeWrite = structuredClone(current);
				durableVersionBeforeWrite = currentConfigVersion;

				if (migrationFingerprint !== undefined && YAML.stringify(current, null, 2) !== migrationFingerprint) {
					this.#global = current;
					this.#rebuildMerged();
					if (getByPath(current, ["retry", "fallbackChains"]) !== undefined) {
						this.#defaultModelRoleOwnership.configVersion = currentConfigVersion;
						this.#defaultModelRoleOwnership.defaultLineageKnown = false;
						this.#migrateRetryFallbackChains();
						patches = this.#pendingPatchesInGenerationOrder();
					} else {
						for (const patch of patches) {
							if (!patch.legacyFallbackMigration) continue;
							const key = settingsPatchKey(patch);
							if (this.#modified.get(key)?.generation === patch.generation) this.#modified.delete(key);
						}
						patches = patches.filter(patch => !patch.legacyFallbackMigration);
					}
				}

				const externalLineageBreak = currentConfigVersion !== this.#defaultModelRoleOwnership.configVersion;
				const applicablePatches = patches.filter(
					patch =>
						!this.#isStaleDefaultModelRolePatch(patch, currentConfigVersion) || patch.modelRole !== "default",
				);
				const appliesDefault = applicablePatches.some(
					patch =>
						!this.#isStaleDefaultModelRolePatch(patch, currentConfigVersion) &&
						(patch.modelRole === "default" || (patch.path === "modelRoles" && !patch.modelRole)),
				);
				for (const patch of applicablePatches) {
					this.#applyPatchWithDefaultOwnership(current, patch, currentConfigVersion);
				}
				if (applicablePatches.length > 0) {
					await Bun.write(configPath, YAML.stringify(current, null, 2));
				}
				const savedConfigVersion = readConfigVersion(configPath);
				this.#defaultModelRoleOwnership.configVersion = savedConfigVersion;
				if (appliesDefault) {
					this.#defaultModelRoleOwnership.defaultConfigVersion = savedConfigVersion;
					this.#defaultModelRoleOwnership.defaultLineageKnown = true;
				} else if (externalLineageBreak) {
					this.#defaultModelRoleOwnership.defaultLineageKnown = false;
				}
				for (const patch of patches) {
					const key = settingsPatchKey(patch);
					if (this.#modified.get(key)?.generation === patch.generation) {
						this.#modified.delete(key);
					}
				}
				this.#global = current;
				for (const [key, patch] of [...this.#modified].sort(
					(left, right) => left[1].generation - right[1].generation,
				)) {
					if (this.#isStaleDefaultModelRolePatch(patch, savedConfigVersion) && patch.modelRole === "default") {
						this.#modified.delete(key);
						continue;
					}
					this.#applyPatchWithDefaultOwnership(
						this.#global,
						{ ...patch, value: structuredClone(patch.value) },
						savedConfigVersion,
					);
				}
			}),
		);
		this.#saveTail = save.then(
			() => undefined,
			() => undefined,
		);

		try {
			await save;
		} catch (error) {
			logger.warn("Settings: save failed", { error: String(error) });
			let droppedStaleDefault = false;
			for (const patch of patches) {
				const key = settingsPatchKey(patch);
				const currentPatch = this.#modified.get(key);
				if (currentPatch?.generation !== patch.generation) continue;
				if (
					this.#isStaleDefaultModelRolePatch(patch, readConfigVersion(configPath)) &&
					patch.modelRole === "default"
				) {
					this.#modified.delete(key);
					droppedStaleDefault = true;
				} else {
					this.#modified.set(key, patch);
				}
			}
			if (droppedStaleDefault && durableBeforeWrite) {
				setRawModelRole(
					this.#global,
					"default",
					defaultModelRoleFrom(durableBeforeWrite),
					!Object.hasOwn(durableBeforeWrite, "modelRoles"),
				);
				this.#defaultModelRoleOwnership.configVersion = durableVersionBeforeWrite;
				this.#defaultModelRoleOwnership.defaultLineageKnown = false;
			}
			if (options.throwOnError) {
				this.#rebuildMerged();
				throw error;
			}
		}

		this.#rebuildMerged();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	#rebuildMerged(): void {
		this.#merged = this.#deepMerge(this.#deepMerge({}, this.#global), this.#project);
		this.#merged = this.#deepMerge(this.#merged, this.#overrides);
	}

	#fireAllHooks(): void {
		for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
			const hook = SETTING_HOOKS[key];
			if (hook) {
				const value = this.get(key);
				hook(value, value);
			}
		}
	}

	#deepMerge(base: RawSettings, overrides: RawSettings): RawSettings {
		const result = { ...base };
		for (const key of Object.keys(overrides)) {
			const override = overrides[key];
			const baseVal = base[key];

			if (override === undefined) continue;

			if (
				typeof override === "object" &&
				override !== null &&
				!Array.isArray(override) &&
				typeof baseVal === "object" &&
				baseVal !== null &&
				!Array.isArray(baseVal)
			) {
				result[key] = this.#deepMerge(baseVal as RawSettings, override as RawSettings);
			} else {
				result[key] = override;
			}
		}
		return result;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Setting Hooks
// ═══════════════════════════════════════════════════════════════════════════

type SettingHook<P extends SettingPath> = (value: SettingValue<P>, prev: SettingValue<P>) => void;

const SETTING_HOOKS: Partial<Record<SettingPath, SettingHook<any>>> = {
	"theme.dark": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("dark", value);
		}
	},
	"theme.light": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("light", value);
		}
	},
	symbolPreset: value => {
		if (typeof value === "string" && (value === "unicode" || value === "nerd" || value === "ascii")) {
			setSymbolPreset(value).catch(err => {
				logger.warn("Settings: symbolPreset hook failed", { preset: value, error: String(err) });
			});
		}
	},
	colorBlindMode: value => {
		if (typeof value === "boolean") {
			setColorBlindMode(value).catch(err => {
				logger.warn("Settings: colorBlindMode hook failed", { enabled: value, error: String(err) });
			});
		}
	},
	"display.tabWidth": value => {
		if (typeof value === "number") {
			setDefaultTabWidth(value);
		}
	},
	"provider.appendOnlyContext": value => {
		if (typeof value === "string") {
			for (const cb of appendOnlyModeCallbacks) cb(value);
		}
	},
};
/** Callbacks invoked when `provider.appendOnlyContext` changes at runtime. */
const appendOnlyModeCallbacks = new Set<(value: string) => void>();

/**
 * Subscribe to append-only mode setting changes.
 * Returns an unsubscribe function. Multiple sessions (main + subagents)
 * can register independently without overwriting each other.
 */
export function onAppendOnlyModeChanged(cb: (value: string) => void): () => void {
	appendOnlyModeCallbacks.add(cb);
	return () => {
		appendOnlyModeCallbacks.delete(cb);
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Global Singleton
// ═══════════════════════════════════════════════════════════════════════════

let globalInstance: Settings | null = null;
let globalInstancePromise: Promise<Settings> | null = null;

export function isSettingsInitialized(): boolean {
	return globalInstance !== null;
}

/**
 * Reset the global singleton for testing.
 * @internal
 */
export function resetSettingsForTest(): void {
	globalInstance = null;
	globalInstancePromise = null;
}

/**
 * The global settings singleton.
 * Must call `Settings.init()` before using.
 */
export const settings = new Proxy({} as Settings, {
	get(_target, prop) {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		const value = (globalInstance as unknown as Record<string | symbol, unknown>)[prop];
		if (typeof value === "function") {
			return value.bind(globalInstance);
		}
		return value;
	},
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
