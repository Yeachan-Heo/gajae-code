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

import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
type SettingMutationGuard =
	| { kind: "unconditional" }
	| {
			kind: "if-unchanged";
			expectedValue: unknown;
			expectedGeneration: string;
			expectedRevision: number;
	  };

interface DurableSettingRevisionEntry {
	revision: number;
	ownerId: string;
	mutationId: number;
}

interface DurableSettingsRevisionState {
	version: 1;
	nextRevision: number;
	generation: string;
	entries: Record<string, DurableSettingRevisionEntry>;
}

interface LoadedSettingsRevisionState {
	state: DurableSettingsRevisionState;
	exists: boolean;
}

interface ConditionalMutationOutcome {
	expectedValue: unknown;
	desiredValue: unknown;
	applied: boolean;
	revision: number;
	generation: string;
}

interface PendingSettingMutation {
	id: number;
	desiredValue: unknown;
	guard: SettingMutationGuard;
	attempted: boolean;
	predecessorGeneration?: string;
	predecessorRevision?: number;
	predecessorValue?: unknown;
}

const SETTINGS_REVISION_STATE_VERSION = 1 as const;
const SETTINGS_REVISION_GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptySettingsRevisionState(): DurableSettingsRevisionState {
	return {
		version: SETTINGS_REVISION_STATE_VERSION,
		generation: crypto.randomUUID(),
		nextRevision: 1,
		entries: {},
	};
}

function isValidRevisionPath(modifiedPath: string): boolean {
	if (!modifiedPath.startsWith(RECORD_ENTRY_MUTATION_PREFIX)) {
		return (
			modifiedPath !== "modelRoles" &&
			modifiedPath !== "task.agentModelOverrides" &&
			Object.hasOwn(SETTINGS_SCHEMA, modifiedPath)
		);
	}
	try {
		const segments = decodeModifiedPath(modifiedPath);
		if (segments.length === 2 && segments[0] === "modelRoles" && isValidRecordEntryMutationKey(segments[1])) {
			return modifiedPath === encodeRecordEntryMutation("modelRoles", segments[1]);
		}
		if (
			segments.length === 3 &&
			segments[0] === "task" &&
			segments[1] === "agentModelOverrides" &&
			isValidRecordEntryMutationKey(segments[2])
		) {
			return modifiedPath === encodeRecordEntryMutation("task.agentModelOverrides", segments[2]);
		}
		return false;
	} catch {
		return false;
	}
}

function parseSettingsRevisionState(value: unknown): DurableSettingsRevisionState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid settings revision state");
	}
	const raw = value as Record<string, unknown>;
	if (
		raw.version !== SETTINGS_REVISION_STATE_VERSION ||
		typeof raw.generation !== "string" ||
		!SETTINGS_REVISION_GENERATION_PATTERN.test(raw.generation) ||
		!Number.isSafeInteger(raw.nextRevision) ||
		(raw.nextRevision as number) < 1
	) {
		throw new Error("Invalid settings revision state header");
	}
	if (!raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) {
		throw new Error("Invalid settings revision state entries");
	}

	const entries: Record<string, DurableSettingRevisionEntry> = {};
	let maxRevision = 0;
	for (const [modifiedPath, candidate] of Object.entries(raw.entries)) {
		if (!isValidRevisionPath(modifiedPath)) {
			throw new Error(`Invalid settings revision path: ${modifiedPath}`);
		}
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new Error(`Invalid settings revision entry: ${modifiedPath}`);
		}
		const entry = candidate as Record<string, unknown>;
		if (
			!Number.isSafeInteger(entry.revision) ||
			(entry.revision as number) < 1 ||
			typeof entry.ownerId !== "string" ||
			entry.ownerId.length === 0 ||
			!Number.isSafeInteger(entry.mutationId) ||
			(entry.mutationId as number) < 1
		) {
			throw new Error(`Invalid settings revision entry: ${modifiedPath}`);
		}
		const revision = entry.revision as number;
		entries[modifiedPath] = {
			revision,
			ownerId: entry.ownerId,
			mutationId: entry.mutationId as number,
		};
		maxRevision = Math.max(maxRevision, revision);
	}
	if ((raw.nextRevision as number) <= maxRevision) {
		throw new Error("Invalid settings revision ordering");
	}

	return {
		generation: raw.generation,
		version: SETTINGS_REVISION_STATE_VERSION,
		nextRevision: raw.nextRevision as number,
		entries,
	};
}

function mutationValuesMatch(mutation: PendingSettingMutation, currentValue: unknown): boolean {
	if (mutation.guard.kind === "unconditional") return true;
	return Object.is(currentValue, mutation.guard.expectedValue) || Object.is(currentValue, mutation.desiredValue);
}

function mutationRetryValuesMatch(mutation: PendingSettingMutation, currentValue: unknown): boolean {
	return (
		isDeepStrictEqual(currentValue, mutation.predecessorValue) ||
		isDeepStrictEqual(currentValue, mutation.desiredValue)
	);
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

export interface SettingsMutationCheckpoint {
	readonly ownerId: string;
	readonly id: number;
}

interface SettingsMutationSnapshot {
	global: RawSettings;
	overrides: RawSettings;
	modified: Map<string, PendingSettingMutation>;
	conditionalOutcomes: Map<string, ConditionalMutationOutcome>;
	release: () => void;
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
		if (!Object.hasOwn(current, segment)) {
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
		if (!Object.hasOwn(current, segment) || typeof current[segment] !== "object" || current[segment] === null) {
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

	const result: Record<string, string> = Object.create(null);
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") {
			result[key] = item;
		}
	}
	return result;
}

const FORBIDDEN_RECORD_ENTRY_MUTATION_KEYS = new Set(["prototype"]);

function isValidRecordEntryMutationKey(key: string): boolean {
	return key.length > 0 && !FORBIDDEN_RECORD_ENTRY_MUTATION_KEYS.has(key) && !Object.hasOwn(Object.prototype, key);
}

function assertValidRecordEntryMutationKey(key: string): void {
	if (key.length === 0) {
		throw new Error("Model assignment key cannot be empty");
	}
	if (!isValidRecordEntryMutationKey(key)) {
		throw new Error(`Model assignment key is not allowed: ${key}`);
	}
}

const RECORD_ENTRY_MUTATION_PREFIX = "\0record-entry:";

function encodeRecordEntryMutation(path: string, key: string): string {
	return RECORD_ENTRY_MUTATION_PREFIX + JSON.stringify([...path.split("."), key]);
}

function decodeModifiedPath(modifiedPath: string): string[] {
	if (!modifiedPath.startsWith(RECORD_ENTRY_MUTATION_PREFIX)) return modifiedPath.split(".");
	const parsed: unknown = JSON.parse(modifiedPath.slice(RECORD_ENTRY_MUTATION_PREFIX.length));
	if (!Array.isArray(parsed) || !parsed.every((segment): segment is string => typeof segment === "string")) {
		throw new Error("Invalid encoded settings record-entry mutation");
	}
	return parsed;
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
	#revisionPath: string | null;
	#ownerId = crypto.randomUUID();
	#revisionState = emptySettingsRevisionState();
	#conditionalOutcomes = new Map<string, ConditionalMutationOutcome>();

	/** Global settings from config.yml */
	#global: RawSettings = {};
	/** Project settings from .Anthropic model/settings.yml etc */
	#project: RawSettings = {};
	/** Runtime overrides (not persisted) */
	#overrides: RawSettings = {};
	/** Merged view (global + project + overrides) */
	#merged: RawSettings = {};

	/** Paths modified during this session (for partial save) */
	#modified = new Map<string, PendingSettingMutation>();
	#nextMutationId = 1;
	#nextMutationCheckpointId = 1;
	#mutationCheckpoints = new Map<number, SettingsMutationSnapshot>();
	#mutationCheckpointTail: Promise<void> = Promise.resolve();
	#mutationCheckpointContext = new AsyncLocalStorage<number>();
	#mutationCheckpointAcquisitions = 0;

	/** Pending save (debounced) */
	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;

	/** Whether to persist changes */
	#persist: boolean;

	private constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		let persistenceAgentDir = this.#agentDir;
		try {
			persistenceAgentDir = fs.realpathSync.native(this.#agentDir);
		} catch {
			try {
				persistenceAgentDir = path.join(
					fs.realpathSync.native(path.dirname(this.#agentDir)),
					path.basename(this.#agentDir),
				);
			} catch {}
		}
		this.#configPath = options.inMemory ? null : path.join(persistenceAgentDir, "config.yml");
		if (this.#configPath) {
			try {
				this.#configPath = fs.realpathSync.native(this.#configPath);
			} catch {}
		}
		this.#revisionPath = this.#configPath ? `${this.#configPath}.revisions.json` : null;
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
				globalInstancePromise = null;
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

	async createMutationCheckpoint(): Promise<SettingsMutationCheckpoint> {
		const predecessor = this.#mutationCheckpointTail;
		const { promise: completion, resolve: release } = Promise.withResolvers<void>();
		this.#mutationCheckpointTail = predecessor.then(
			() => completion,
			() => completion,
		);
		this.#mutationCheckpointAcquisitions++;
		let checkpointCreated = false;
		try {
			await predecessor.catch(() => {});
			await this.#flushPending({ throwOnError: true });

			const id = this.#nextMutationCheckpointId++;
			this.#mutationCheckpoints.set(id, {
				global: structuredClone(this.#global),
				overrides: structuredClone(this.#overrides),
				modified: structuredClone(this.#modified),
				conditionalOutcomes: structuredClone(this.#conditionalOutcomes),
				release,
			});
			checkpointCreated = true;
			return { ownerId: this.#ownerId, id };
		} catch (error) {
			release();
			throw error;
		} finally {
			this.#mutationCheckpointAcquisitions--;
			if (!checkpointCreated && this.#modified.size > 0) this.#queueSave();
		}
	}

	restoreMutationCheckpoint(checkpoint: SettingsMutationCheckpoint): void {
		if (checkpoint.ownerId !== this.#ownerId) {
			throw new Error("Settings mutation checkpoint belongs to another instance");
		}
		const snapshot = this.#mutationCheckpoints.get(checkpoint.id);
		if (!snapshot) throw new Error("Settings mutation checkpoint is no longer active");
		this.#mutationCheckpoints.delete(checkpoint.id);
		try {
			if (this.#saveTimer) {
				clearTimeout(this.#saveTimer);
				this.#saveTimer = undefined;
			}
			this.#global = structuredClone(snapshot.global);
			this.#overrides = structuredClone(snapshot.overrides);
			this.#modified = structuredClone(snapshot.modified);
			this.#conditionalOutcomes = structuredClone(snapshot.conditionalOutcomes);
			this.#rebuildMerged();
		} finally {
			snapshot.release();
		}
		if (this.#modified.size > 0) this.#queueSave();
	}

	releaseMutationCheckpoint(checkpoint: SettingsMutationCheckpoint): void {
		const snapshot = checkpoint.ownerId === this.#ownerId ? this.#mutationCheckpoints.get(checkpoint.id) : undefined;
		if (!snapshot) {
			throw new Error("Settings mutation checkpoint is no longer active");
		}
		this.#mutationCheckpoints.delete(checkpoint.id);
		snapshot.release();
		if (this.#modified.size > 0) this.#queueSave();
	}

	async flushMutationCheckpoint(checkpoint: SettingsMutationCheckpoint): Promise<void> {
		if (checkpoint.ownerId !== this.#ownerId || !this.#mutationCheckpoints.has(checkpoint.id)) {
			throw new Error("Settings mutation checkpoint is no longer active");
		}
		await this.#flushPending({ throwOnError: true });
	}

	runMutationCheckpoint<T>(checkpoint: SettingsMutationCheckpoint, operation: () => Promise<T>): Promise<T> {
		if (checkpoint.ownerId !== this.#ownerId || !this.#mutationCheckpoints.has(checkpoint.id)) {
			throw new Error("Settings mutation checkpoint is no longer active");
		}
		return this.#mutationCheckpointContext.run(checkpoint.id, operation);
	}
	/**
	 * Set a setting value (sync).
	 * Updates global settings and queues a background save.
	 * Triggers hooks for settings that have side effects.
	 */
	set<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const prev = this.get(path);
		const segments = path.split(".");
		this.#enqueueSettingValue(path, value);
		setByPath(this.#global, segments, value);
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
		this.#enqueueSettingValue(path, undefined);
		setByPath(this.#global, path.split("."), undefined);
		this.#rebuildMerged();
		this.#queueSave();
	}

	/**
	 * Persist or clear the default model profile only if another writer has not
	 * changed it since this Settings instance loaded it.
	 */
	getPendingModelProfileDefaultMutationId(): number | undefined {
		return this.#modified.get("modelProfile.default")?.id;
	}

	setModelProfileDefaultIfUnchanged(
		expectedProfileName: string | undefined,
		profileName: string | undefined,
		expectedPendingMutationId?: number,
	): void {
		const path = "modelProfile.default";
		if (!this.#enqueueModifiedIfUnchanged(path, expectedProfileName, profileName, expectedPendingMutationId)) return;
		setByPath(this.#global, path.split("."), profileName);
		this.#rebuildMerged();
		this.#queueSave();
	}

	/**
	 * Delete a custom model profile while holding the global settings lock.
	 *
	 * A fresh durable default check rejects a concurrent selection that commits
	 * before archival; selections that commit later remain resolvable through
	 * the registry's archived-profile fallback.
	 */
	async deleteModelProfileIfUnreferenced<T>(profileName: string, deleteProfile: () => Promise<T>): Promise<T> {
		await this.flushOrThrow();
		if (!this.#persist || !this.#configPath) {
			if (this.getGlobal("modelProfile.default") === profileName) {
				throw new Error(`Model profile became the default while deletion was in progress: ${profileName}`);
			}
			return deleteProfile();
		}
		return withFileLock(this.#configPath, async () => {
			const current = await this.#loadYaml(this.#configPath!);
			if (getByPath(current, ["modelProfile", "default"]) === profileName) {
				throw new Error(`Model profile became the default while deletion was in progress: ${profileName}`);
			}
			return deleteProfile();
		});
	}

	/**
	 * Apply runtime overrides (not persisted).
	 */
	override<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		this.#assertMutationCheckpointAccess();
		const segments = path.split(".");
		setByPath(this.#overrides, segments, value);
		this.#rebuildMerged();
	}

	/**
	 * Clear a runtime override.
	 */
	clearOverride(path: SettingPath): void {
		this.#assertMutationCheckpointAccess();
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
		if (this.#mutationCheckpointAcquisitions > 0 || this.#mutationCheckpoints.size > 0) {
			await this.#mutationCheckpointTail;
		}
		await this.#flushPending();
	}

	/**
	 * Like {@link flush}, but rejects if the durable save fails instead of
	 * swallowing the error. Use where the caller must confirm persistence before
	 * reporting success (e.g. the Telegram `/rich` toggle). In-memory instances
	 * ({@link isolated}) short-circuit in {@link #saveNow} and never throw.
	 */
	async flushOrThrow(): Promise<void> {
		if (this.#mutationCheckpointAcquisitions > 0 || this.#mutationCheckpoints.size > 0) {
			await this.#mutationCheckpointTail;
		}
		await this.#flushPending({ throwOnError: true });
	}

	async #flushPending(options: { throwOnError?: boolean } = {}): Promise<void> {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		if (this.#savePromise) {
			try {
				await this.#savePromise;
			} catch {
				// A previous caller owns the prior failure. Retry whatever remains
				// dirty and report only the attempt started below.
			}
		}
		if (this.#modified.size > 0) {
			await this.#startSave(options);
		}
	}

	async cloneForCwd(cwd: string): Promise<Settings> {
		const cloned = new Settings({
			cwd,
			agentDir: this.#agentDir,
			inMemory: !this.#persist,
		});
		cloned.#storage = this.#storage;
		if (this.#persist) {
			await withFileLock(cloned.#configPath!, async () => {
				const loadedRevisionState = await cloned.#loadRevisionState();
				cloned.#global = await cloned.#loadYaml(cloned.#configPath!);
				cloned.#revisionState = loadedRevisionState.state;
				if (!loadedRevisionState.exists) {
					await cloned.#writeRevisionState(cloned.#revisionState);
				}
			});
			cloned.#project = await cloned.#loadProjectSettings();
		} else {
			cloned.#global = structuredClone(this.#global);
			cloned.#revisionState = structuredClone(this.#revisionState);
			cloned.#project = structuredClone(this.#project);
		}
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

	#revisionFor(path: string): number {
		return this.#revisionState.entries[path]?.revision ?? 0;
	}

	#assertMutationCheckpointAccess(): void {
		if (this.#mutationCheckpoints.size === 0) return;
		const checkpointId = this.#mutationCheckpointContext.getStore();
		if (checkpointId !== undefined && this.#mutationCheckpoints.has(checkpointId)) return;
		throw new Error("Settings mutation blocked by an active transaction");
	}

	#enqueueModified(path: string, desiredValue: unknown): void {
		this.#assertMutationCheckpointAccess();
		this.#modified.delete(path);
		this.#modified.set(path, {
			id: this.#nextMutationId++,
			desiredValue: structuredClone(desiredValue),
			guard: { kind: "unconditional" },
			attempted: false,
			predecessorGeneration: undefined,
			predecessorRevision: undefined,
			predecessorValue: undefined,
		});
	}

	#enqueueSettingValue(path: SettingPath, desiredValue: unknown): void {
		if (path !== "modelRoles" && path !== "task.agentModelOverrides") {
			this.#enqueueModified(path, desiredValue);
			return;
		}
		const previous = shallowStringRecord(getByPath(this.#global, path.split(".")));
		const next = shallowStringRecord(desiredValue);
		const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
		for (const key of keys) {
			assertValidRecordEntryMutationKey(key);
		}
		for (const key of keys) {
			this.#enqueueModified(encodeRecordEntryMutation(path, key), next[key]);
		}
	}

	#enqueueModifiedIfUnchanged(
		path: string,
		expectedValue: unknown,
		desiredValue: unknown,
		expectedPendingMutationId?: number,
	): boolean {
		this.#assertMutationCheckpointAccess();
		const pending = this.#modified.get(path);
		let expectedRevision = this.#revisionFor(path);
		let expectedGeneration = this.#revisionState.generation;
		if (pending) {
			const replacesOwnedUnconditional =
				expectedPendingMutationId !== undefined &&
				pending.id === expectedPendingMutationId &&
				pending.guard.kind === "unconditional" &&
				Object.is(pending.desiredValue, expectedValue);
			const reversesPendingConditional =
				pending.guard.kind === "if-unchanged" &&
				Object.is(pending.guard.expectedValue, desiredValue) &&
				Object.is(pending.desiredValue, expectedValue);
			if (!replacesOwnedUnconditional && !reversesPendingConditional) return false;
		} else {
			const outcome = this.#conditionalOutcomes.get(path);
			const reversesCompletedConditional =
				outcome && Object.is(outcome.expectedValue, desiredValue) && Object.is(outcome.desiredValue, expectedValue);
			if (reversesCompletedConditional) {
				this.#conditionalOutcomes.delete(path);
				if (!outcome.applied) return false;
				expectedRevision = outcome.revision;
				expectedGeneration = outcome.generation;
			} else {
				this.#conditionalOutcomes.delete(path);
			}
		}
		const currentValue = getByPath(this.#global, decodeModifiedPath(path));
		if (!Object.is(currentValue, expectedValue) && !Object.is(currentValue, desiredValue)) return false;
		this.#modified.delete(path);
		this.#modified.set(path, {
			id: this.#nextMutationId++,
			desiredValue: structuredClone(desiredValue),
			guard: {
				kind: "if-unchanged",
				expectedValue: structuredClone(expectedValue),
				expectedGeneration,
				expectedRevision,
			},
			attempted: false,
			predecessorGeneration: undefined,
			predecessorRevision: undefined,
			predecessorValue: undefined,
		});
		return true;
	}

	#setStringRecordEntry(
		path: "modelRoles" | "task.agentModelOverrides",
		key: string,
		value: string | undefined,
		expectedValue?: { value: string | undefined },
	): boolean {
		assertValidRecordEntryMutationKey(key);
		const segments = path.split(".");
		const next = shallowStringRecord(getByPath(this.#global, segments));
		if (value === undefined) {
			delete next[key];
		} else {
			next[key] = value;
		}
		const modifiedPath = encodeRecordEntryMutation(path, key);
		if (expectedValue) {
			if (!this.#enqueueModifiedIfUnchanged(modifiedPath, expectedValue.value, value)) return false;
		} else {
			this.#enqueueModified(modifiedPath, value);
		}
		setByPath(this.#global, segments, next);
		this.#rebuildMerged();
		this.#queueSave();
		return true;
	}

	#setModelRoleEntry(
		role: ModelRole | string,
		modelId: string | undefined,
		expectedValue?: { value: string | undefined },
	): void {
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		const hasRuntimeOverrides =
			!!runtimeOverrides && typeof runtimeOverrides === "object" && !Array.isArray(runtimeOverrides);
		const runtimeRoleIsSet = hasRuntimeOverrides && Object.hasOwn(runtimeOverrides, role);

		if (!this.#setStringRecordEntry("modelRoles", role, modelId, expectedValue)) return;

		if (modelId === undefined) {
			if (hasRuntimeOverrides) {
				const nextRuntimeOverrides = shallowStringRecord(runtimeOverrides);
				delete nextRuntimeOverrides[role];
				this.override("modelRoles", nextRuntimeOverrides);
			}
		} else if (runtimeRoleIsSet || this.get("modelRoles")[role] !== modelId) {
			const base = shallowStringRecord(runtimeOverrides);
			this.override("modelRoles", { ...base, [role]: modelId });
		}
	}

	/**
	 * Persist one model role without replacing sibling roles written by another
	 * process, and keep a shadowing runtime/project value aligned for this session.
	 */
	setModelRole(role: ModelRole | string, modelId: string): void {
		this.#setModelRoleEntry(role, modelId);
	}

	/**
	 * Persist or clear one model role only if another writer has not changed that
	 * leaf since this Settings instance loaded it.
	 */
	setModelRoleIfUnchanged(
		role: ModelRole | string,
		expectedModelId: string | undefined,
		modelId: string | undefined,
	): void {
		this.#setModelRoleEntry(role, modelId, { value: expectedModelId });
	}

	#setAgentModelOverrideEntry(
		agentName: string,
		modelId: string | undefined,
		expectedValue?: { value: string | undefined },
	): void {
		const runtimeOverrides = getByPath(this.#overrides, ["task", "agentModelOverrides"]);
		const hasRuntimeOverrides =
			!!runtimeOverrides && typeof runtimeOverrides === "object" && !Array.isArray(runtimeOverrides);

		if (!this.#setStringRecordEntry("task.agentModelOverrides", agentName, modelId, expectedValue)) return;

		if (modelId === undefined) {
			if (hasRuntimeOverrides) {
				const nextRuntimeOverrides = shallowStringRecord(runtimeOverrides);
				delete nextRuntimeOverrides[agentName];
				this.override("task.agentModelOverrides", nextRuntimeOverrides);
			}
		} else if (hasRuntimeOverrides || this.get("task.agentModelOverrides")[agentName] !== modelId) {
			const base = shallowStringRecord(runtimeOverrides);
			this.override("task.agentModelOverrides", {
				...base,
				[agentName]: modelId,
			});
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
		this.#setAgentModelOverrideEntry(agentName, modelId);
	}

	/**
	 * Persist or clear one agent override only if another writer has not changed
	 * that leaf since this Settings instance loaded it.
	 */
	setAgentModelOverrideIfUnchanged(
		agentName: string,
		expectedModelId: string | undefined,
		modelId: string | undefined,
	): void {
		this.#setAgentModelOverrideEntry(agentName, modelId, { value: expectedModelId });
	}

	/** Clear one persisted and live model role without replacing siblings. */
	clearModelRole(role: ModelRole | string): void {
		this.#setModelRoleEntry(role, undefined);
	}

	/** Clear one persisted and live agent model override without replacing siblings. */
	clearAgentModelOverride(agentName: string): void {
		this.#setAgentModelOverrideEntry(agentName, undefined);
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
			await withFileLock(this.#configPath!, async () => {
				const loadedRevisionState = await this.#loadRevisionState();
				this.#global = await this.#loadYaml(this.#configPath!);
				this.#revisionState = loadedRevisionState.state;
				if (!loadedRevisionState.exists) {
					await this.#writeRevisionState(this.#revisionState);
				}
			});
		}

		this.#project = await projectPromise;

		// Build merged view (global → project → overrides; project wins over global)
		this.#rebuildMerged();
		this.#fireAllHooks();
		return this;
	}

	async #loadRevisionState(): Promise<LoadedSettingsRevisionState> {
		if (!this.#revisionPath) {
			return { state: emptySettingsRevisionState(), exists: false };
		}
		try {
			const content = await Bun.file(this.#revisionPath).text();
			return {
				state: parseSettingsRevisionState(JSON.parse(content)),
				exists: true,
			};
		} catch (error) {
			if (isEnoent(error)) {
				return { state: emptySettingsRevisionState(), exists: false };
			}
			logger.warn("Settings: failed to load revision state", {
				path: this.#revisionPath,
				error: String(error),
			});
			throw error;
		}
	}

	async #atomicWrite(filePath: string, content: string): Promise<void> {
		const tempPath = `${filePath}.${this.#ownerId}.tmp`;
		try {
			await Bun.write(tempPath, content);
			const fd = fs.openSync(tempPath, "r");
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(tempPath, filePath);
			if (process.platform !== "win32") {
				try {
					const directoryFd = fs.openSync(path.dirname(filePath), "r");
					try {
						fs.fsyncSync(directoryFd);
					} finally {
						fs.closeSync(directoryFd);
					}
				} catch (error) {
					// rename() is the commit point. Do not report an uncommitted
					// write after the target already contains the new bytes.
					logger.warn("Settings: parent directory fsync failed after commit", {
						path: filePath,
						error: String(error),
					});
				}
			}
		} finally {
			try {
				fs.rmSync(tempPath, { force: true });
			} catch {}
		}
	}

	async #writeRevisionState(state: DurableSettingsRevisionState): Promise<void> {
		if (!this.#revisionPath) return;
		await this.#atomicWrite(this.#revisionPath, JSON.stringify(state));
	}
	async #loadYaml(filePath: string): Promise<RawSettings> {
		try {
			const content = await Bun.file(filePath).text();
			const parsed = YAML.parse(content);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`Settings root must be an object: ${filePath}`);
			}
			return this.#migrateRawSettings(parsed as RawSettings);
		} catch (error) {
			if (isEnoent(error)) return {};
			logger.warn("Settings: failed to load", { path: filePath, error: String(error) });
			throw error;
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

	#queueSave(): void {
		if (!this.#persist || !this.#configPath) return;
		if (this.#mutationCheckpointAcquisitions > 0 || this.#mutationCheckpoints.size > 0) return;

		// Debounce: wait 100ms for more changes
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
		}
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			if (this.#mutationCheckpointAcquisitions > 0 || this.#mutationCheckpoints.size > 0) return;
			const savePromise = this.#startSave();
			void savePromise.catch(err => {
				logger.warn("Settings: background save failed", { error: String(err) });
			});
		}, 100);
	}

	async #saveNow(options: { throwOnError?: boolean } = {}): Promise<void> {
		if (!this.#persist || !this.#configPath || this.#modified.size === 0) return;

		const configPath = this.#configPath;
		const initialEntries = [...this.#modified].sort((left, right) => left[1].id - right[1].id);

		try {
			await withFileLock(configPath, async () => {
				const current = await this.#loadYaml(configPath);
				const loadedRevisionState = await this.#loadRevisionState();
				const revisionState = loadedRevisionState.state;
				if (!loadedRevisionState.exists) {
					await this.#writeRevisionState(revisionState);
				}
				this.#revisionState = structuredClone(revisionState);
				const loadedGeneration = revisionState.generation;
				const accepted: Array<{
					modifiedPath: string;
					mutation: PendingSettingMutation;
					revision: number;
					revisionChanged: boolean;
				}> = [];

				for (const [modifiedPath, mutation] of initialEntries) {
					const segments = decodeModifiedPath(modifiedPath);
					const currentValue = getByPath(current, segments);
					const currentRevision = revisionState.entries[modifiedPath]?.revision ?? 0;
					const currentOwner = revisionState.entries[modifiedPath];
					const sameMutation = currentOwner?.ownerId === this.#ownerId && currentOwner.mutationId === mutation.id;
					const capturesPredecessor = !mutation.attempted && mutation.predecessorGeneration === undefined;
					if (capturesPredecessor) {
						mutation.predecessorGeneration = loadedGeneration;
						mutation.predecessorRevision = currentRevision;
						mutation.predecessorValue = structuredClone(currentValue);
					}
					const predecessorMatches =
						mutation.predecessorGeneration === loadedGeneration &&
						mutation.predecessorRevision === currentRevision;
					const retryValueMatches = mutationRetryValuesMatch(mutation, currentValue);
					const sameMutationRetry = sameMutation && retryValueMatches;
					const generationMatches =
						mutation.guard.kind === "if-unchanged" && mutation.guard.expectedGeneration === loadedGeneration;
					const firstAttemptApplies =
						!mutation.attempted &&
						predecessorMatches &&
						(capturesPredecessor || retryValueMatches) &&
						(mutation.guard.kind === "unconditional" ||
							(mutationValuesMatch(mutation, currentValue) &&
								generationMatches &&
								currentRevision === mutation.guard.expectedRevision));
					const applies = sameMutationRetry || firstAttemptApplies;

					if (!applies) {
						if (this.#modified.get(modifiedPath)?.id === mutation.id) {
							this.#modified.delete(modifiedPath);
							if (mutation.guard.kind === "if-unchanged") {
								this.#conditionalOutcomes.set(modifiedPath, {
									expectedValue: mutation.guard.expectedValue,
									desiredValue: mutation.desiredValue,
									applied: false,
									revision: currentRevision,
									generation: loadedGeneration,
								});
							}
						}
						continue;
					}

					let revision = currentRevision;
					if (!sameMutation) {
						if (revisionState.nextRevision >= Number.MAX_SAFE_INTEGER) {
							throw new Error("Settings revision state exhausted");
						}
						revision = revisionState.nextRevision++;
						revisionState.entries[modifiedPath] = {
							revision,
							ownerId: this.#ownerId,
							mutationId: mutation.id,
						};
					}
					setByPath(current, segments, structuredClone(mutation.desiredValue));
					accepted.push({
						modifiedPath,
						mutation,
						revision,
						revisionChanged: !sameMutation,
					});
				}

				if (accepted.some(entry => entry.revisionChanged)) {
					await this.#writeRevisionState(revisionState);
					for (const entry of accepted) {
						if (entry.revisionChanged) entry.mutation.attempted = true;
					}
				}
				this.#revisionState = structuredClone(revisionState);

				if (accepted.length > 0) {
					await this.#atomicWrite(configPath, YAML.stringify(current, null, 2));
				}

				for (const { modifiedPath, mutation, revision } of accepted) {
					if (this.#modified.get(modifiedPath)?.id !== mutation.id) continue;
					this.#modified.delete(modifiedPath);
					if (mutation.guard.kind === "if-unchanged") {
						this.#conditionalOutcomes.set(modifiedPath, {
							expectedValue: mutation.guard.expectedValue,
							desiredValue: mutation.desiredValue,
							applied: true,
							revision,
							generation: revisionState.generation,
						});
					}
				}
				this.#global = current;
				for (const [modifiedPath, mutation] of this.#modified) {
					setByPath(this.#global, decodeModifiedPath(modifiedPath), structuredClone(mutation.desiredValue));
				}
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
