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
import { getCanonicalFileTarget, withFileLock } from "./file-lock";
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
export interface ConditionalDurableSettingUpdate {
	path: string;
	expectedRevision: string | undefined;
	expectedValue: string | undefined;
	value: string | undefined;
	requireCompleteMatch?: boolean;
}

interface DurableSettingRevisions {
	leaves: Record<string, string>;
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
		if (typeof item === "string") {
			result[key] = item;
		}
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

	/** Paths modified during this session, keyed by their per-mutation token. */
	#modified = new Map<string, string>();
	/** Durable revisions for individually persisted leaves. */
	#globalRevisions: DurableSettingRevisions = { leaves: {} };

	/** Pending save (debounced) */
	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;

	/** Whether to persist changes */
	#persist: boolean;

	private constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		try {
			this.#agentDir = fs.realpathSync.native(this.#agentDir);
		} catch {
			// A new agent directory has no canonical filesystem identity yet.
		}
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
	/** Get the transaction-owned or durable token for a global leaf. */
	getGlobalRevision(path: string): string | undefined {
		return this.#modified.get(path) ?? this.#globalRevisions.leaves[path];
	}

	/** Get a setting from project config only, excluding global and runtime layers. */
	getProject<P extends SettingPath>(path: P): SettingValue<P> | undefined {
		const value = getByPath(this.#project, path.split("."));
		return value === undefined ? undefined : (value as SettingValue<P>);
	}

	/**
	 * Get the user/global plus runtime value while excluding project settings.
	 * Profile materialization uses this to preserve explicit runtime choices
	 * without leaking project-scoped configuration into the user config.
	 */
	getWithoutProject<P extends SettingPath>(path: P): SettingValue<P> {
		const merged = this.#deepMerge(this.#deepMerge({}, this.#global), this.#overrides);
		const value = getByPath(merged, path.split("."));
		if (value !== undefined) {
			const pathScopedValue = resolvePathScopedStringArray(path, value, this.#cwd);
			return (pathScopedValue ?? value) as SettingValue<P>;
		}
		return getDefault(path);
	}

	/** Get the raw runtime override layer for a setting, without lower-precedence values. */
	getRuntimeOverride<P extends SettingPath>(path: P): SettingValue<P> | undefined {
		const value = getByPath(this.#overrides, path.split("."));
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
		const prev = this.get(path);
		const segments = path.split(".");
		setByPath(this.#global, segments, value);
		this.#markModified(path);
		this.#rebuildMerged();
		this.#queueSave();

		// Trigger hook if exists
		const hook = SETTING_HOOKS[path];
		if (hook) {
			hook(value, prev);
		}
	}

	/** Remove a user/global setting while preserving project and runtime layers. */
	clearGlobal(path: SettingPath): void {
		setByPath(this.#global, path.split("."), undefined);
		this.#markModified(path);
		this.#rebuildMerged();
		this.#queueSave();
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
	 * Conditionally update persisted leaves while holding the config file lock.
	 *
	 * A transaction owns the durable revision it materialized, rather than a
	 * value. This prevents profile → user → profile ABA writes from being
	 * mistaken for an untouched profile value.
	 */
	async compareAndSwapGlobal(updates: readonly ConditionalDurableSettingUpdate[]): Promise<ReadonlySet<string>> {
		const applied = new Set<string>();
		const appliedRevisions = new Map<string, string>();
		const pending = new Map(this.#modified);

		if (!this.#persist || !this.#configPath) {
			const eligible = new Set(
				updates
					.filter(update => {
						if (update.expectedRevision === undefined) return false;
						const pendingToken = pending.get(update.path);
						if (pendingToken && pendingToken !== update.expectedRevision) return false;
						return (
							this.getGlobalRevision(update.path) === update.expectedRevision &&
							getByPath(this.#global, update.path.split(".")) === update.expectedValue
						);
					})
					.map(update => update.path),
			);
			const completeMatch = eligible.size === updates.length;
			for (const update of updates) {
				if (!eligible.has(update.path) || (update.requireCompleteMatch && !completeMatch)) continue;
				const pendingToken = pending.get(update.path);
				setByPath(this.#global, update.path.split("."), update.value);
				this.#globalRevisions.leaves[update.path] = crypto.randomUUID();
				if (this.#modified.get(update.path) === pendingToken) this.#modified.delete(update.path);
				applied.add(update.path);
			}
			this.#rebuildMerged();
			return applied;
		}

		const configPath = this.#configPath;
		await withFileLock(configPath, async targetPath => {
			const current = await this.#loadYaml(targetPath);
			const revisions = await this.#loadRevisions(targetPath);
			const eligible = new Set(
				updates
					.filter(update => {
						if (update.expectedRevision === undefined) return false;
						const pendingToken = pending.get(update.path);
						if (pendingToken && pendingToken !== update.expectedRevision) return false;
						return (
							revisions.leaves[update.path] === update.expectedRevision &&
							getByPath(current, update.path.split(".")) === update.expectedValue
						);
					})
					.map(update => update.path),
			);
			const completeMatch = eligible.size === updates.length;
			for (const update of updates) {
				if (!eligible.has(update.path) || (update.requireCompleteMatch && !completeMatch)) continue;
				setByPath(current, update.path.split("."), update.value);
				const appliedRevision = crypto.randomUUID();
				revisions.leaves[update.path] = appliedRevision;
				appliedRevisions.set(update.path, appliedRevision);
				applied.add(update.path);
			}

			for (const [pendingPath, token] of pending) {
				if (updates.some(update => update.path === pendingPath && update.expectedRevision === token)) continue;
				setByPath(current, pendingPath.split("."), getByPath(this.#global, pendingPath.split(".")));
				revisions.leaves[pendingPath] = token;
			}

			if (applied.size > 0 || pending.size > 0) {
				await this.#writeRevisions(revisions, targetPath);
				this.#globalRevisions = revisions;
				await Bun.write(targetPath, YAML.stringify(current, null, 2));
			}
			for (const [pendingPath, token] of pending) {
				if (this.#modified.get(pendingPath) === token) this.#modified.delete(pendingPath);
			}

			for (;;) {
				const late = new Map(this.#modified);
				const superseded = new Set(
					[...applied].filter(appliedPath => {
						const token = late.get(appliedPath);
						const update = updates.find(candidate => candidate.path === appliedPath);
						return token !== undefined && token !== update?.expectedRevision;
					}),
				);
				let needsWrite = false;
				for (const appliedPath of superseded) {
					applied.delete(appliedPath);
					appliedRevisions.delete(appliedPath);
				}

				if (superseded.size > 0) {
					for (const update of updates) {
						if (!update.requireCompleteMatch || !applied.has(update.path)) continue;
						applied.delete(update.path);
						appliedRevisions.delete(update.path);
						if (late.has(update.path)) continue;
						setByPath(current, update.path.split("."), update.expectedValue);
						revisions.leaves[update.path] = crypto.randomUUID();
						needsWrite = true;
					}
				}

				for (const [pendingPath, token] of late) {
					setByPath(current, pendingPath.split("."), getByPath(this.#global, pendingPath.split(".")));
					revisions.leaves[pendingPath] = token;
					needsWrite = true;
				}
				if (!needsWrite) break;

				await this.#writeRevisions(revisions, targetPath);
				this.#globalRevisions = revisions;
				await Bun.write(targetPath, YAML.stringify(current, null, 2));
				for (const [pendingPath, token] of late) {
					if (this.#modified.get(pendingPath) === token) this.#modified.delete(pendingPath);
				}
			}

			for (const pendingPath of this.#modified.keys()) {
				setByPath(current, pendingPath.split("."), getByPath(this.#global, pendingPath.split(".")));
			}
			this.#global = current;
		});
		for (;;) {
			const superseded = [...applied].filter(appliedPath => {
				const update = updates.find(candidate => candidate.path === appliedPath);
				const pendingToken = this.#modified.get(appliedPath);
				const durableToken = this.#globalRevisions.leaves[appliedPath];
				return (
					(pendingToken !== undefined && pendingToken !== update?.expectedRevision) ||
					durableToken !== appliedRevisions.get(appliedPath)
				);
			});
			if (superseded.length === 0) break;
			for (const appliedPath of superseded) {
				applied.delete(appliedPath);
				appliedRevisions.delete(appliedPath);
			}

			const compensations = updates
				.filter(update => update.requireCompleteMatch && applied.has(update.path))
				.flatMap(update => {
					const expectedRevision = appliedRevisions.get(update.path);
					applied.delete(update.path);
					appliedRevisions.delete(update.path);
					return expectedRevision
						? [
								{
									path: update.path,
									expectedRevision,
									expectedValue: update.value,
									value: update.expectedValue,
								},
							]
						: [];
				});
			if (compensations.length > 0) {
				await this.compareAndSwapGlobal(compensations);
			}
		}
		this.#rebuildMerged();
		return applied;
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
			await this.#startSave();
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
			await this.#startSave({ throwOnError: true });
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
		cloned.#globalRevisions = structuredClone(this.#globalRevisions);
		cloned.#project = this.#persist ? await cloned.#loadProjectSettings() : structuredClone(this.#project);
		cloned.#overrides = structuredClone(this.#overrides);
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

	#setStringRecordEntry(
		path: "modelRoles" | "task.agentModelOverrides",
		key: string,
		value: string | undefined,
	): void {
		const segments = path.split(".");
		const next = shallowStringRecord(getByPath(this.#global, segments));
		if (value === undefined) {
			delete next[key];
		} else {
			next[key] = value;
		}
		setByPath(this.#global, segments, next);
		this.#markModified(key.includes(".") ? path : `${path}.${key}`);
		this.#rebuildMerged();
		this.#queueSave();
	}

	/**
	 * Persist one model role without replacing sibling roles written by another
	 * process, and keep a shadowing runtime/project value aligned for this session.
	 */
	setModelRole(role: ModelRole | string, modelId: string): void {
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		const runtimeRoleIsSet =
			!!runtimeOverrides &&
			typeof runtimeOverrides === "object" &&
			!Array.isArray(runtimeOverrides) &&
			Object.hasOwn(runtimeOverrides, role);

		this.#setStringRecordEntry("modelRoles", role, modelId);

		if (runtimeRoleIsSet || this.get("modelRoles")[role] !== modelId) {
			const base = shallowStringRecord(runtimeOverrides);
			this.override("modelRoles", { ...base, [role]: modelId });
		}
	}

	/**
	 * Set an agent model override while keeping any live runtime/project override aligned.
	 *
	 * Runtime model profiles and project settings can override
	 * `task.agentModelOverrides` for the current session. A user-selected role
	 * assignment must win immediately, but only that explicit agent change is
	 * persisted.
	 */
	setAgentModelOverride(agentName: string, modelId: string): void {
		const runtimeOverrides = getByPath(this.#overrides, ["task", "agentModelOverrides"]);
		const hasRuntimeOverrides =
			!!runtimeOverrides && typeof runtimeOverrides === "object" && !Array.isArray(runtimeOverrides);

		this.#setStringRecordEntry("task.agentModelOverrides", agentName, modelId);

		if (hasRuntimeOverrides || this.get("task.agentModelOverrides")[agentName] !== modelId) {
			const base = shallowStringRecord(runtimeOverrides);
			this.override("task.agentModelOverrides", {
				...base,
				[agentName]: modelId,
			});
		}
	}

	/** Clear one persisted and live model role without replacing siblings. */
	clearModelRole(role: ModelRole | string): void {
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		const hasRuntimeOverrides =
			!!runtimeOverrides && typeof runtimeOverrides === "object" && !Array.isArray(runtimeOverrides);

		this.#setStringRecordEntry("modelRoles", role, undefined);

		if (hasRuntimeOverrides) {
			const nextRuntimeOverrides = shallowStringRecord(runtimeOverrides);
			delete nextRuntimeOverrides[role];
			this.override("modelRoles", nextRuntimeOverrides);
		}
	}

	/** Clear one persisted and live agent model override without replacing siblings. */
	clearAgentModelOverride(agentName: string): void {
		const runtimeOverrides = getByPath(this.#overrides, ["task", "agentModelOverrides"]);
		const hasRuntimeOverrides =
			!!runtimeOverrides && typeof runtimeOverrides === "object" && !Array.isArray(runtimeOverrides);

		this.#setStringRecordEntry("task.agentModelOverrides", agentName, undefined);

		if (hasRuntimeOverrides) {
			const nextRuntimeOverrides = shallowStringRecord(runtimeOverrides);
			delete nextRuntimeOverrides[agentName];
			this.override("task.agentModelOverrides", nextRuntimeOverrides);
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

	/*
	 * Override model roles (helper for modelRoles record).
	 */
	overrideModelRoles(roles: ReadOnlyDict<string>): void {
		const next = shallowStringRecord(getByPath(this.#overrides, ["modelRoles"]));
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
			this.#globalRevisions = await this.#loadRevisions();
		}

		this.#project = await projectPromise;

		// Build merged view (global → project → overrides; project wins over global)
		this.#rebuildMerged();
		this.#fireAllHooks();
		return this;
	}

	async #loadRevisions(configPath?: string): Promise<DurableSettingRevisions> {
		const targetPath = configPath ?? (this.#configPath ? await getCanonicalFileTarget(this.#configPath) : undefined);
		if (!targetPath) return { leaves: {} };
		const revisionPath = `${targetPath}.revisions.yml`;
		try {
			const parsed = YAML.parse(await Bun.file(revisionPath).text());
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { leaves: {} };
			const raw = parsed as { leaves?: unknown };
			const leaves: Record<string, string> = {};
			if (raw.leaves && typeof raw.leaves === "object" && !Array.isArray(raw.leaves)) {
				for (const [leaf, token] of Object.entries(raw.leaves)) {
					if (typeof token === "string") leaves[leaf] = token;
				}
			}
			return { leaves };
		} catch (error) {
			if (isEnoent(error)) return { leaves: {} };
			logger.warn("Settings: failed to load revisions", { path: revisionPath, error: String(error) });
			return { leaves: {} };
		}
	}

	async #writeRevisions(revisions: DurableSettingRevisions, configPath?: string): Promise<void> {
		const targetPath = configPath ?? (this.#configPath ? await getCanonicalFileTarget(this.#configPath) : undefined);
		if (!targetPath) return;
		await Bun.write(`${targetPath}.revisions.yml`, YAML.stringify(revisions, null, 2));
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

	#startSave(options: { throwOnError?: boolean } = {}): Promise<void> {
		const previousSave = this.#savePromise;
		const savePromise = (async () => {
			if (previousSave) {
				try {
					await previousSave;
				} catch {
					// A failed durable flush must not prevent a later retry from
					// persisting the paths that #saveNow re-queued.
				}
			}
			await this.#saveNow(options);
		})();
		this.#savePromise = savePromise;
		void savePromise.then(
			() => {
				if (this.#savePromise === savePromise) this.#savePromise = undefined;
			},
			() => {
				if (this.#savePromise === savePromise) this.#savePromise = undefined;
			},
		);
		return savePromise;
	}

	#markModified(path: string): void {
		this.#modified.set(path, crypto.randomUUID());
	}
	#queueSave(): void {
		if (!this.#persist || !this.#configPath) return;

		// Debounce: wait 100ms for more changes
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
		}
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			const savePromise = this.#startSave();
			void savePromise.catch(err => {
				logger.warn("Settings: background save failed", { error: String(err) });
			});
		}, 100);
	}

	async #saveNow(options: { throwOnError?: boolean } = {}): Promise<void> {
		if (!this.#persist || !this.#configPath || this.#modified.size === 0) return;

		const configPath = this.#configPath;
		const modified = new Map(this.#modified);
		const modifiedValues = new Map(
			[...modified.keys()].map(modPath => {
				const segments = modPath.split(".");
				return [modPath, structuredClone(getByPath(this.#global, segments))] as const;
			}),
		);

		try {
			await withFileLock(configPath, async targetPath => {
				const current = await this.#loadYaml(targetPath);
				const revisions = await this.#loadRevisions(targetPath);

				for (const [modPath, token] of modified) {
					setByPath(current, modPath.split("."), modifiedValues.get(modPath));
					revisions.leaves[modPath] = token;
				}

				// Persist tokens before config values. A post-write failure can then
				// be safely rolled back using the transaction's exact token.
				await this.#writeRevisions(revisions, targetPath);
				this.#globalRevisions = revisions;
				await Bun.write(targetPath, YAML.stringify(current, null, 2));
				for (const [modPath, token] of modified) {
					if (this.#modified.get(modPath) === token) this.#modified.delete(modPath);
				}
				for (const modPath of this.#modified.keys()) {
					setByPath(current, modPath.split("."), getByPath(this.#global, modPath.split(".")));
				}
				this.#global = current;
			});
		} catch (error) {
			logger.warn("Settings: save failed", { error: String(error) });
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
