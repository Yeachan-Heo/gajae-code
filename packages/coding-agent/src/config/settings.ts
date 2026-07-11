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
export interface RuntimeModelProfileDefaultState {
	suppressed: boolean;
	value: string | undefined;
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
function setOwnValue(target: RawSettings, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function assignStringRecord(target: Record<string, string>, source: Record<string, string>): void {
	for (const [key, value] of Object.entries(source)) setOwnValue(target, key, value);
}

function setByPath(obj: RawSettings, segments: string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!(segment in current) || typeof current[segment] !== "object" || current[segment] === null) {
			setOwnValue(current, segment, {});
		}
		current = current[segment] as RawSettings;
	}
	setOwnValue(current, segments[segments.length - 1], value);
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

function shallowStringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};

	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") setOwnValue(result, key, item);
	}
	return result;
}
function isRecordObject(value: unknown): value is RawSettings {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

type RuntimeModelRecordPath = "modelRoles" | "task.agentModelOverrides";

function isRuntimeModelRecordPath(path: SettingPath | string): path is RuntimeModelRecordPath {
	return path === "modelRoles" || path === "task.agentModelOverrides";
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
	/** Opaque runtime resets that must survive sanitized internal rewrites. */
	#runtimeModelWholeResets = new Set<RuntimeModelRecordPath>();
	#runtimeModelResetKeys = new Map<RuntimeModelRecordPath, Set<string>>();
	#runtimeModelWholeResetReleasedKeys = new Map<RuntimeModelRecordPath, Set<string>>();
	#runtimeModelProfileDefaultSuppressed = false;
	/** Merged view (global + project + overrides) */
	#merged: RawSettings = {};

	/** Paths modified during this session (for partial save) */
	#modified = new Set<string>();

	/** Pending save (debounced) */
	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;

	/** Whether to persist changes */
	#persist: boolean;

	private constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		this.#configPath = options.inMemory ? null : path.join(this.#agentDir, "config.yml");
		this.#persist = !options.inMemory;

		if (options.overrides) {
			for (const [key, value] of Object.entries(options.overrides)) {
				if (isRuntimeModelRecordPath(key)) {
					this.#storeRuntimeModelRecord(key, value);
				} else {
					setByPath(this.#overrides, key.split("."), value);
				}
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
			if (path === "modelRoles" || path === "task.agentModelOverrides") {
				return shallowStringRecord(value) as SettingValue<P>;
			}
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
		if (value === undefined) return undefined;
		if (path === "modelProfile.default") {
			return (typeof value === "string" ? value : undefined) as SettingValue<P> | undefined;
		}
		if (path === "modelRoles" || path === "task.agentModelOverrides") {
			return shallowStringRecord(value) as SettingValue<P>;
		}
		return value as SettingValue<P>;
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
		const prev = this.get(path);
		const segments = path.split(".");
		setByPath(this.#global, segments, value);
		this.#modified.add(path);
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
		if (isRuntimeModelRecordPath(path)) {
			this.#replaceRuntimeModelRecord(path, value);
			return;
		}
		if (path === "modelProfile.default") this.#runtimeModelProfileDefaultSuppressed = false;
		const segments = path.split(".");
		setByPath(this.#overrides, segments, value);
		this.#rebuildMerged();
	}

	/**
	 * Clear a runtime override.
	 */
	clearOverride(path: SettingPath): void {
		const clearedWholeReset = isRuntimeModelRecordPath(path) && this.#runtimeModelWholeResets.delete(path);
		const clearedResetKeys = isRuntimeModelRecordPath(path) && this.#runtimeModelResetKeys.delete(path);
		const clearedReleasedKeys =
			isRuntimeModelRecordPath(path) && this.#runtimeModelWholeResetReleasedKeys.delete(path);
		const clearedProfileSuppression = path === "modelProfile.default" && this.#runtimeModelProfileDefaultSuppressed;
		if (path === "modelProfile.default") this.#runtimeModelProfileDefaultSuppressed = false;
		const segments = path.split(".");
		let current = this.#overrides;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			if (!(segment in current)) {
				if (clearedWholeReset || clearedResetKeys || clearedReleasedKeys || clearedProfileSuppression) {
					this.#rebuildMerged();
				}
				return;
			}
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
		if (this.#savePromise) {
			await this.#savePromise;
		}
		if (this.#modified.size > 0) {
			await this.#saveNow();
		}
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
		if (this.#savePromise) {
			await this.#savePromise;
		}
		if (this.#modified.size > 0) {
			await this.#saveNow({ throwOnError: true });
		}
	}

	async cloneForCwd(cwd: string): Promise<Settings> {
		const cloned = new Settings({
			cwd,
			agentDir: this.#agentDir,
			inMemory: !this.#persist,
		});
		cloned.#storage = this.#storage;
		cloned.#global = structuredClone(this.#global);
		cloned.#project = this.#persist ? await cloned.#loadProjectSettings() : structuredClone(this.#project);
		cloned.#overrides = structuredClone(this.#overrides);
		cloned.#runtimeModelWholeResets = new Set(this.#runtimeModelWholeResets);
		cloned.#runtimeModelResetKeys = new Map(
			[...this.#runtimeModelResetKeys].map(([modelPath, keys]) => [modelPath, new Set(keys)]),
		);
		cloned.#runtimeModelWholeResetReleasedKeys = new Map(
			[...this.#runtimeModelWholeResetReleasedKeys].map(([modelPath, keys]) => [modelPath, new Set(keys)]),
		);
		cloned.#runtimeModelProfileDefaultSuppressed = this.#runtimeModelProfileDefaultSuppressed;
		cloned.#rebuildMerged();
		cloned.#fireAllHooks();
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
	 * Store a runtime model record without exposing malformed/reset leaves through
	 * public reads. Whole-record resets and reset-valued leaves live in separate
	 * metadata so sanitized binding/profile rewrites cannot erase them.
	 */
	#storeRuntimeModelRecord(path: RuntimeModelRecordPath, value: unknown): void {
		if (value === undefined) {
			setByPath(this.#overrides, path.split("."), undefined);
			return;
		}
		setByPath(this.#overrides, path.split("."), shallowStringRecord(value));

		if (!isRecordObject(value)) {
			this.#runtimeModelWholeResets.add(path);
			this.#runtimeModelResetKeys.delete(path);
			this.#runtimeModelWholeResetReleasedKeys.delete(path);
			return;
		}

		const resetKeys = new Set(this.#runtimeModelResetKeys.get(path));
		const releasedKeys = this.#runtimeModelWholeResetReleasedKeys.get(path);
		for (const [key, item] of Object.entries(value)) {
			if (typeof item !== "string" && item !== undefined) {
				resetKeys.add(key);
				releasedKeys?.delete(key);
			}
		}
		if (resetKeys.size > 0) {
			this.#runtimeModelResetKeys.set(path, resetKeys);
		} else {
			this.#runtimeModelResetKeys.delete(path);
		}
	}

	/**
	 * Replace visible runtime strings while preserving opaque reset state. This
	 * path is used by binding/profile refreshes that only see sanitized records.
	 */
	#replaceRuntimeModelRecord(path: RuntimeModelRecordPath, value: unknown): void {
		this.#storeRuntimeModelRecord(path, value);
		this.#rebuildMerged();
	}

	/** Apply one explicit user assignment over any reset for that leaf. */
	#overrideRuntimeModelRecord(path: RuntimeModelRecordPath, key: string, modelId: string): void {
		const next = shallowStringRecord(getByPath(this.#overrides, path.split(".")));
		setOwnValue(next, key, modelId);
		const resetKeys = this.#runtimeModelResetKeys.get(path);
		if (resetKeys) {
			resetKeys.delete(key);
			if (resetKeys.size === 0) this.#runtimeModelResetKeys.delete(path);
		}
		if (this.#runtimeModelWholeResets.has(path)) {
			const releasedKeys = this.#runtimeModelWholeResetReleasedKeys.get(path) ?? new Set<string>();
			releasedKeys.add(key);
			this.#runtimeModelWholeResetReleasedKeys.set(path, releasedKeys);
		}
		setByPath(this.#overrides, path.split("."), next);
		this.#rebuildMerged();
	}

	/** Persist one model role without changing runtime reset/override state. */
	persistModelRole(role: ModelRole | string, modelId: string): void {
		const current = shallowStringRecord(getByPath(this.#global, ["modelRoles"]));
		setOwnValue(current, role, modelId);
		this.set("modelRoles", current);
	}

	/** Persist one agent model without changing runtime reset/override state. */
	persistAgentModelOverride(agentName: string, modelId: string): void {
		const current = shallowStringRecord(getByPath(this.#global, ["task", "agentModelOverrides"]));
		setOwnValue(current, agentName, modelId);
		this.set("task.agentModelOverrides", current);
	}
	/** Replace the durable model-role record exactly, preserving prior absence. */
	replacePersistedModelRoles(value: Record<string, string> | undefined): void {
		setByPath(this.#global, ["modelRoles"], value);
		this.#modified.add("modelRoles");
		this.#rebuildMerged();
		this.#queueSave();
	}

	/** Replace the durable agent-model record exactly, preserving prior absence. */
	replacePersistedAgentModelOverrides(value: Record<string, string> | undefined): void {
		setByPath(this.#global, ["task", "agentModelOverrides"], value);
		this.#modified.add("task.agentModelOverrides");
		this.#rebuildMerged();
		this.#queueSave();
	}

	/**
	 * Set a model role while keeping a project/profile-shadowed live value aligned.
	 */
	setModelRole(role: ModelRole | string, modelId: string): void {
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		const updateRuntimeOverride =
			!!runtimeOverrides &&
			typeof runtimeOverrides === "object" &&
			!Array.isArray(runtimeOverrides) &&
			Object.hasOwn(runtimeOverrides, role);

		this.persistModelRole(role, modelId);

		if (updateRuntimeOverride || this.get("modelRoles")[role] !== modelId) {
			this.#overrideRuntimeModelRecord("modelRoles", role, modelId);
		}
	}
	/**
	 * Set an agent model override while keeping any live project/profile override aligned.
	 *
	 * Runtime model profiles and project settings can override
	 * `task.agentModelOverrides` for the current session. A user-selected role
	 * assignment must win immediately in that same session, but only the explicit
	 * agent change should be persisted.
	 */
	setAgentModelOverride(agentName: string, modelId: string): void {
		const runtimeOverrides = getByPath(this.#overrides, ["task", "agentModelOverrides"]);
		const updateRuntimeOverride =
			!!runtimeOverrides && typeof runtimeOverrides === "object" && !Array.isArray(runtimeOverrides);

		this.persistAgentModelOverride(agentName, modelId);

		if (updateRuntimeOverride || this.get("task.agentModelOverrides")[agentName] !== modelId) {
			this.#overrideRuntimeModelRecord("task.agentModelOverrides", agentName, modelId);
		}
	}

	/** Clear one persisted agent assignment and any matching live string override. */
	clearAgentModelOverride(agentName: string): void {
		const runtimeOverrides = getByPath(this.#overrides, ["task", "agentModelOverrides"]);
		const runtimeModelId =
			isRecordObject(runtimeOverrides) && typeof runtimeOverrides[agentName] === "string"
				? runtimeOverrides[agentName]
				: undefined;
		const current = shallowStringRecord(getByPath(this.#global, ["task", "agentModelOverrides"]));
		if (
			Object.hasOwn(current, agentName) &&
			(runtimeModelId === undefined || current[agentName] === runtimeModelId)
		) {
			delete current[agentName];
			this.set("task.agentModelOverrides", current);
		}

		if (runtimeModelId !== undefined) {
			const next = shallowStringRecord(runtimeOverrides);
			delete next[agentName];
			this.override("task.agentModelOverrides", next);
		}
	}

	/**
	 * Get a model role (helper for modelRoles record).
	 */
	getModelRole(role: ModelRole | string): string | undefined {
		const roles = this.get("modelRoles");
		return roles[role];
	}

	/**
	 * Get all model roles (helper for modelRoles record).
	 */
	getModelRoles(): ReadOnlyDict<string> {
		return { ...this.get("modelRoles") };
	}
	/** Get visible runtime-only role strings without lower-precedence layers. */
	getRuntimeModelRoles(): Record<string, string> {
		return shallowStringRecord(getByPath(this.#overrides, ["modelRoles"]));
	}

	/** Get visible runtime-only agent strings without lower-precedence layers. */
	getRuntimeAgentModelOverrides(): Record<string, string> {
		return shallowStringRecord(getByPath(this.#overrides, ["task", "agentModelOverrides"]));
	}
	getPersistedModelProfileDefaultState(): RuntimeModelProfileDefaultState {
		const value = getByPath(this.#global, ["modelProfile", "default"]);
		return {
			suppressed: value === null,
			value: typeof value === "string" ? value : undefined,
		};
	}

	persistModelProfileDefaultSuppression(): void {
		setByPath(this.#global, ["modelProfile", "default"], null);
		this.#modified.add("modelProfile.default");
		this.#rebuildMerged();
		this.#queueSave();
	}

	restorePersistedModelProfileDefault(state: RuntimeModelProfileDefaultState): void {
		setByPath(this.#global, ["modelProfile", "default"], state.suppressed ? null : state.value);
		this.#modified.add("modelProfile.default");
		this.#rebuildMerged();
		this.#queueSave();
	}

	getRuntimeModelProfileDefaultState(): RuntimeModelProfileDefaultState {
		const value = getByPath(this.#overrides, ["modelProfile", "default"]);
		return {
			suppressed: this.#runtimeModelProfileDefaultSuppressed,
			value: typeof value === "string" ? value : undefined,
		};
	}

	suppressModelProfileDefault(): void {
		this.clearOverride("modelProfile.default");
		this.#runtimeModelProfileDefaultSuppressed = true;
		this.#rebuildMerged();
	}

	restoreRuntimeModelProfileDefault(state: RuntimeModelProfileDefaultState): void {
		this.clearOverride("modelProfile.default");
		if (state.suppressed) {
			this.#runtimeModelProfileDefaultSuppressed = true;
			this.#rebuildMerged();
		} else if (state.value !== undefined) {
			this.override("modelProfile.default", state.value);
		}
	}

	/*
	 * Override model roles (helper for modelRoles record).
	 */
	overrideModelRoles(roles: ReadOnlyDict<string>): void {
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) this.#overrideRuntimeModelRecord("modelRoles", role, modelId);
		}
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
		}

		this.#project = await projectPromise;

		// Build merged view (global → project → overrides; project wins over global)
		this.#rebuildMerged();
		this.#fireAllHooks();
		return this;
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

		// Debounce: wait 100ms for more changes
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
		}
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			this.#saveNow().catch(err => {
				logger.warn("Settings: background save failed", { error: String(err) });
			});
		}, 100);
	}

	async #saveNow(options: { throwOnError?: boolean } = {}): Promise<void> {
		if (!this.#persist || !this.#configPath || this.#modified.size === 0) return;

		const configPath = this.#configPath;
		const modifiedPaths = [...this.#modified];
		this.#modified.clear();

		try {
			await withFileLock(configPath, async () => {
				// Re-read to preserve external changes
				const current = await this.#loadYaml(configPath);

				// Apply only our modified paths
				for (const modPath of modifiedPaths) {
					const segments = modPath.split(".");
					const value = getByPath(this.#global, segments);
					setByPath(current, segments, value);
				}

				// Update our global with any external changes we preserved
				this.#global = current;
				await Bun.write(configPath, YAML.stringify(this.#global, null, 2));
			});
		} catch (error) {
			logger.warn("Settings: save failed", { error: String(error) });
			// Re-add failed paths for retry
			for (const p of modifiedPaths) {
				this.#modified.add(p);
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
		const lower = this.#deepMerge(this.#deepMerge({}, this.#global), this.#project);
		this.#merged = this.#deepMerge(lower, this.#overrides);

		for (const modelPath of ["modelRoles", "task.agentModelOverrides"] as const) {
			const segments = modelPath.split(".");
			const lowerValue = getByPath(lower, segments);
			const runtimeValue = getByPath(this.#overrides, segments);
			const resetKeys = this.#runtimeModelResetKeys.get(modelPath);
			const hasRuntimeState =
				runtimeValue !== undefined || this.#runtimeModelWholeResets.has(modelPath) || resetKeys !== undefined;
			if (lowerValue === undefined && !hasRuntimeState) continue;

			const lowerRecord = shallowStringRecord(lowerValue);
			const effective: Record<string, string> = {};
			if (this.#runtimeModelWholeResets.has(modelPath)) {
				for (const key of this.#runtimeModelWholeResetReleasedKeys.get(modelPath) ?? []) {
					const value = lowerRecord[key];
					if (value !== undefined) setOwnValue(effective, key, value);
				}
			} else {
				assignStringRecord(effective, lowerRecord);
				if (resetKeys) {
					for (const key of resetKeys) delete effective[key];
				}
			}
			assignStringRecord(effective, shallowStringRecord(runtimeValue));
			setByPath(this.#merged, segments, effective);
		}
		const runtimeProfileDefault = getByPath(this.#overrides, ["modelProfile", "default"]);
		if (runtimeProfileDefault === undefined) {
			const globalProfileDefault = getByPath(this.#global, ["modelProfile", "default"]);
			if (globalProfileDefault === null) {
				setByPath(this.#merged, ["modelProfile", "default"], undefined);
			} else if (typeof globalProfileDefault === "string") {
				setByPath(this.#merged, ["modelProfile", "default"], globalProfileDefault);
			}
		}
		if (this.#runtimeModelProfileDefaultSuppressed) {
			setByPath(this.#merged, ["modelProfile", "default"], undefined);
		}
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
			if (override === undefined) continue;

			const baseValue = base[key];
			const mergedValue = isRecordObject(override)
				? this.#deepMerge(isRecordObject(baseValue) ? baseValue : {}, override)
				: override;
			setOwnValue(result, key, mergedValue);
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
