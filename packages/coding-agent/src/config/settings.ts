/**
 * Settings singleton with sync get/set and background persistence.
 *
 * Usage:
 *   import { settings } from "./settings";
 *
 *   const enabled = settings.get("compaction.enabled");  // sync read
 *   settings.set("theme.dark", "red-claw");              // sync write, saves in background
 *
 * For tests, `Settings.isolated()` seeds explicit user/global settings:
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
import {
	type NotificationSettingsReader,
	type NotificationSettingsSnapshot,
	parseNotificationSettingsSnapshot,
} from "../sdk/bus/config";
import { AgentStorage } from "../session/agent-storage";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import {
	type AtomicYamlPatch,
	applyAtomicYamlPatches,
	applyAtomicYamlPatchesWithCurrent,
	atomicYamlPathHash,
	type CasReceipt,
	deleteByPath,
	reserveAtomicYamlUpdateSlot,
	setByPath,
} from "./atomic-yaml-patch";
import { isModelSelectorValue, type ModelSelectorValue, normalizeModelSelectorValue } from "./model-selector-value";

import {
	type BashInterceptorRule,
	CONFIG_SCHEMA_VERSION,
	type GroupPrefix,
	type GroupTypeMap,
	getDefault,
	reconcileSettingsSchema,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingsSchemaReport,
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
	readonly value: unknown | undefined;
	readonly generation: number;
	readonly revision: number;
	readonly modelRole?: string;
	readonly legacyFallbackMigration?: boolean;
};

type PendingSaveSlot = {
	captured: boolean;
	released: boolean;
	release: () => void;
	wait: Promise<void>;
};

type DurableBatchRevision = {
	patch: AtomicYamlPatch;
	previousRevision: number | undefined;
	revision: number;
};
type NotificationValidationState = {
	malformedConfigRoot: boolean;
	invalidNotificationConfiguration: boolean;
	generation: number;
};
type NotificationValidationRestoreGuard = {
	readonly state: NotificationValidationState;
	restoreGeneration: number | undefined;
};

export type SettingsAtomicPatch = { path: SettingPath; op: "set"; value: unknown } | { path: SettingPath; op: "unset" };
export type SettingsAtomicReceipt = CasReceipt;

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

function summarizeSettingsOptions(options: SettingsOptions | null): {
	optionKeys: string[];
	overrideKeys: string[];
} {
	if (!options) return { optionKeys: [], overrideKeys: [] };
	return {
		optionKeys: Object.keys(options).sort(),
		overrideKeys: Object.keys(options.overrides ?? {}).sort(),
	};
}

/** Additional layer setup for {@link Settings.isolated}. */
export interface IsolatedSettingsOptions {
	/** Initial runtime overrides. Notification paths are rejected. */
	overrides?: Partial<Record<SettingPath, unknown>>;
}

/** Raised when an ephemeral override attempts to change global-only notification settings. */
export class NotificationSettingsOverrideError extends Error {
	constructor(readonly path: SettingPath) {
		super(`Runtime overrides are not allowed for global notification setting ${path}.`);
		this.name = "NotificationSettingsOverrideError";
	}
}

const LOCAL_NOTIFICATION_SETTING_KEYS = new Set(["terminalBell", "bellOnComplete", "bellOnApproval", "bellOnAsk"]);
const LOCAL_NOTIFICATION_SETTING_PATHS = new Set(
	[...LOCAL_NOTIFICATION_SETTING_KEYS].map(key => `notifications.${key}`),
);

function isNotificationSettingsPath(path: string): boolean {
	return (
		(path === "notifications" || path.startsWith("notifications.")) && !LOCAL_NOTIFICATION_SETTING_PATHS.has(path)
	);
}

function isAtomicSettingsPath(path: string): boolean {
	return (
		Object.hasOwn(SETTINGS_SCHEMA, path) ||
		(path.startsWith("modelRoles.") && path.split(".").every(segment => segment.length > 0))
	);
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

function normalizeSessionDirectoryMigration(raw: RawSettings): void {
	const session = rawSettingsRecord(raw.session);
	if (!session) return;
	if (session.directoryMigration !== "copy-retain" && session.directoryMigration !== "disabled") {
		delete session.directoryMigration;
	}
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

export class Settings implements NotificationSettingsReader {
	#configPath: string | null;
	#cwd: string;
	#agentDir: string;
	#storage: AgentStorage | null = null;

	/** Global settings from config.yml */
	#global: RawSettings = {};
	/**
	 * Raw notification syntax retained across schema reconciliation so notification
	 * validation matches the lightweight config reader until each leaf is repaired.
	 */
	#rawNotificationConfig: RawSettings | undefined = {};
	/** Raw notification syntax from the last durable config read, before local replay. */
	#durableRawNotificationConfig: RawSettings | undefined = {};
	/** Project settings from .Anthropic model/settings.yml etc */
	#project: RawSettings = {};
	/** Runtime overrides (not persisted) */
	#overrides: RawSettings = {};
	/** Merged view (global + project + overrides) */
	#merged: RawSettings = {};

	/** Latest dirty patch for each path, owned by its generation. */
	#modified = new Map<string, SettingsPatch>();
	#nextGeneration = 0;
	#pathRevisions = new Map<string, number>();
	#nextRevision = 0;
	/** Pending debounced ordinary save; its queue slot is reserved immediately. */
	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;
	#pendingSaveSlot?: PendingSaveSlot;

	/** Legacy fallback migration warnings emitted once per settings instance. */
	#legacyFallbackMigrationWarnings = 0;
	#legacyFallbackMigrationGlobalFingerprint: string | undefined;
	#schemaReport: SettingsSchemaReport = { issues: [], valid: true };
	#schemaMigrationPending = false;
	/** A newer config schema must never be rewritten by legacy migrations. */
	#futureSchemaVersion = false;
	#hasMalformedConfigRoot = false;
	#hasInvalidNotificationConfiguration = false;
	#notificationValidationGeneration = 0;
	/** Notification subtree fingerprint from the last raw durable config read. */
	#durableNotificationFingerprint: string | undefined;

	/** Whether to persist changes */
	#persist: boolean;

	private constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		this.#configPath = options.inMemory ? null : path.join(this.#agentDir, "config.yml");
		this.#persist = !options.inMemory;

		if (options.overrides) {
			for (const [key, value] of Object.entries(options.overrides)) {
				if (isNotificationSettingsPath(key)) throw new NotificationSettingsOverrideError(key as SettingPath);
				setByPath(this.#overrides, key.split("."), structuredClone(value));
			}
		}
		normalizeSessionDirectoryMigration(this.#overrides);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Factory Methods
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initialize the global singleton.
	 * Call once at startup before accessing `settings`.
	 */
	static init(options: SettingsOptions = {}): Promise<Settings> {
		if (globalInstancePromise) {
			if (JSON.stringify(options) !== JSON.stringify(globalInitOptions)) {
				logger.warn("Settings.init called again with different options; reusing existing settings instance", {
					initialOptions: summarizeSettingsOptions(globalInitOptions),
					requestedOptions: summarizeSettingsOptions(options),
				});
			}
			return globalInstancePromise;
		}

		globalInitOptions = structuredClone(options);
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
	 * Load settings for an explicit workspace without changing the global singleton.
	 * Managed-session policy resolution must be bound to the workspace being opened.
	 */
	static loadForScope(options: { cwd: string; agentDir?: string }): Promise<Settings> {
		const instance = new Settings(options);
		return instance.#load();
	}

	/**
	 * Create an isolated instance for testing with explicit user/global settings.
	 * Does not affect the global singleton.
	 */
	static isolated(
		globalSettings: Partial<Record<SettingPath, unknown>> = {},
		options: IsolatedSettingsOptions = {},
	): Settings {
		const instance = new Settings({ inMemory: true, overrides: options.overrides });
		for (const [key, value] of Object.entries(globalSettings)) {
			setByPath(instance.#global, key.split("."), structuredClone(value));
		}
		normalizeSessionDirectoryMigration(instance.#global);

		instance.#rebuildMerged();
		instance.#captureRawNotificationConfig(instance.#global);
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

	/**
	 * Read the remote-notification settings from the user/global layer only.
	 * Schema defaults are applied per path; project settings and runtime overrides
	 * are deliberately excluded from this trust boundary.
	 */
	getNotificationSettingsSnapshot(): NotificationSettingsSnapshot {
		return parseNotificationSettingsSnapshot(
			this.#hasMalformedConfigRoot || this.#hasInvalidNotificationConfiguration ? null : this.#global,
		);
	}

	/** Check whether a setting is present in loaded settings/overrides rather than coming from schema defaults. */
	has(path: SettingPath): boolean {
		return getByPath(this.#merged, path.split(".")) !== undefined;
	}

	/** Diagnostics from schema reconciliation during the most recent load. */
	getSchemaReport(): SettingsSchemaReport {
		return structuredClone(this.#schemaReport);
	}

	/**
	 * Set a setting value (sync).
	 * Updates global settings and reserves its background persistence slot before
	 * returning, so later durable batches cannot overtake this mutation.
	 */
	set<P extends SettingPath>(path: P, value: SettingValue<P> | undefined): void {
		if (value === undefined) {
			this.unset(path);
			return;
		}
		this.#set(path, value, true);
	}

	#set<P extends SettingPath>(path: P, value: SettingValue<P>, _defaultModelRoleMayHaveChanged: boolean): void {
		const prev = this.get(path);
		const clonedValue = structuredClone(value);
		const patch: SettingsPatch = {
			path,
			value: clonedValue,
			generation: ++this.#nextGeneration,
			revision: ++this.#nextRevision,
		};
		setByPath(this.#global, path.split("."), structuredClone(clonedValue));
		this.#applyNotificationMutationToRaw(path, clonedValue);
		this.#pathRevisions.set(path, patch.revision);
		this.#modified.set(path, patch);

		this.#rebuildMerged();
		this.#revalidateNotificationSettingsAfterMutation([path]);
		this.#queueSave();

		const hook = SETTING_HOOKS[path];
		if (hook) hook(value, prev);
	}

	/**
	 * Delete a global setting (sync), rather than serializing an ambiguous YAML
	 * `undefined` value. Defaults/project settings become visible immediately.
	 */
	unset<P extends SettingPath>(path: P): void {
		const prev = this.get(path);
		const patch: SettingsPatch = {
			path,
			value: undefined,
			generation: ++this.#nextGeneration,
			revision: ++this.#nextRevision,
		};
		deleteByPath(this.#global, path.split("."));
		this.#applyNotificationMutationToRaw(path, undefined);
		this.#pathRevisions.set(path, patch.revision);
		this.#modified.set(path, patch);
		this.#rebuildMerged();
		this.#revalidateNotificationSettingsAfterMutation([path]);
		this.#queueSave();

		const hook = SETTING_HOOKS[path];
		if (hook) hook(this.get(path), prev);
	}

	/**
	 * Persist a tagged batch as one atomic YAML replacement. Unlike ordinary
	 * {@link set}, canonical state and hooks change only after the rename succeeds.
	 */
	async commitAtomicBatch(patches: readonly SettingsAtomicPatch[]): Promise<CasReceipt> {
		if (!this.#persist || !this.#configPath) {
			const notificationValidationGuard = this.#notificationValidationRestoreGuard();
			const changes = new Map<string, { before: unknown; beforeHash: string; afterHash: string }>();
			for (const patch of patches) {
				if (!isAtomicSettingsPath(patch.path)) {
					throw new Error(`Unknown setting path for atomic batch: ${patch.path}`);
				}
				if (patch.op === "set" && patch.value === undefined) {
					throw new TypeError(`Settings set patch for ${patch.path} cannot carry undefined; use unset instead.`);
				}
				if (!changes.has(patch.path)) {
					changes.set(patch.path, {
						before: structuredClone(getByPath(this.#global, patch.path.split("."))),
						beforeHash: atomicYamlPathHash(this.#global, patch.path),
						afterHash: "",
					});
				}
			}
			for (const patch of patches) {
				if (patch.op === "set") {
					setByPath(this.#global, patch.path.split("."), structuredClone(patch.value));
					this.#applyNotificationMutationToRaw(patch.path, patch.value);
				} else {
					deleteByPath(this.#global, patch.path.split("."));
					this.#applyNotificationMutationToRaw(patch.path, undefined);
				}
			}
			for (const [patchPath, change] of changes) {
				change.afterHash = atomicYamlPathHash(this.#global, patchPath);
			}
			this.#rebuildMerged();
			this.#revalidateNotificationSettingsAfterMutation(patches.map(patch => patch.path));
			this.#recordNotificationValidationBatchApply(
				notificationValidationGuard,
				patches.map(patch => patch.path),
			);
			let discarded = false;
			let receipt: CasReceipt;
			receipt = {
				revisions: [],
				discard: () => {
					discarded = true;
				},
				restore: async () => {
					if (discarded) return { status: "discarded" } as const;
					const conflicts = [...changes].flatMap(([patchPath, change]) =>
						atomicYamlPathHash(this.#global, patchPath) === change.afterHash ? [] : [patchPath],
					);
					if (conflicts.length > 0) return { status: "conflict", paths: conflicts } as const;
					const restoreNotificationValidationState = this.#canRestoreNotificationValidationState(
						notificationValidationGuard,
						changes.keys(),
					);
					for (const [patchPath, change] of changes) {
						if (change.beforeHash === atomicYamlPathHash({}, patchPath)) {
							deleteByPath(this.#global, patchPath.split("."));
							this.#applyNotificationMutationToRaw(patchPath, undefined);
						} else {
							setByPath(this.#global, patchPath.split("."), structuredClone(change.before));
							this.#applyNotificationMutationToRaw(patchPath, change.before);
						}
					}
					const modelRoles = rawSettingsRecord(this.#global.modelRoles);
					if (changes.has("modelRoles.default") && modelRoles && Object.keys(modelRoles).length === 0) {
						delete this.#global.modelRoles;
					}
					this.#rebuildMerged();
					this.#revalidateNotificationSettingsAfterMutation(changes.keys());
					if (restoreNotificationValidationState) {
						this.#restoreNotificationValidationState(notificationValidationGuard.state);
					}
					return { status: "restored", receipt } as const;
				},
			};
			return receipt;
		}

		const durablePatches: AtomicYamlPatch[] = patches.map(patch => {
			if (!isAtomicSettingsPath(patch.path)) {
				throw new Error(`Unknown setting path for atomic batch: ${patch.path}`);
			}
			if (patch.op === "unset") return { path: patch.path, op: "unset" };
			if (patch.value === undefined) {
				throw new TypeError(`Settings set patch for ${patch.path} cannot carry undefined; use unset instead.`);
			}
			return { path: patch.path, op: "set", value: structuredClone(patch.value) };
		});

		// A durable batch is a causal barrier: close the earlier ordinary debounce
		// inside its already-reserved slot before queueing this batch.
		this.#releasePendingSaveSlot();
		const notificationValidationGuard = this.#notificationValidationRestoreGuard();

		const revisions = durablePatches.map(patch => ({
			patch,
			revision: ++this.#nextRevision,
			previousRevision: this.#pathRevisions.get(patch.path),
		}));
		for (const entry of revisions) this.#pathRevisions.set(entry.patch.path, entry.revision);

		try {
			const receipt = await applyAtomicYamlPatches(this.#configPath, durablePatches, {
				validateRoot: (root, currentPatches) =>
					this.#rejectAtomicNotificationRepairForMalformedRoot(currentPatches, root),
				onRestored: restoredPatches =>
					this.#applyRestoredDurableBatch(revisions, restoredPatches, notificationValidationGuard),
			});
			const appliedNotificationMutation = this.#applyDurableBatch(revisions);
			this.#recordNotificationValidationBatchApply(notificationValidationGuard, appliedNotificationMutation);
			return receipt;
		} catch (error) {
			for (const entry of revisions) {
				if (this.#pathRevisions.get(entry.patch.path) === entry.revision) {
					if (entry.previousRevision === undefined) this.#pathRevisions.delete(entry.patch.path);
					else this.#pathRevisions.set(entry.patch.path, entry.previousRevision);
				}
			}
			if (this.#modified.size > 0 && !this.#pendingSaveSlot) this.#queueSave();
			throw error;
		}
	}

	/** Build a durable batch from the current on-disk YAML under the shared queue and file lock. */
	async commitAtomicBatchWithCurrent(
		buildPatches: (
			current: Readonly<RawSettings>,
		) => Promise<readonly SettingsAtomicPatch[]> | readonly SettingsAtomicPatch[],
	): Promise<CasReceipt> {
		if (!this.#persist || !this.#configPath) {
			const patches = await buildPatches(structuredClone(this.#global));
			return this.commitAtomicBatch(patches);
		}

		this.#releasePendingSaveSlot();
		let revisions: DurableBatchRevision[] = [];
		const notificationValidationGuard = this.#notificationValidationRestoreGuard();
		try {
			const receipt = await applyAtomicYamlPatchesWithCurrent(
				this.#configPath,
				async current => {
					const patches = await buildPatches(structuredClone(current));
					const durablePatches: AtomicYamlPatch[] = patches.map(patch => {
						if (!isAtomicSettingsPath(patch.path)) {
							throw new Error(`Unknown setting path for atomic batch: ${patch.path}`);
						}
						if (patch.op === "unset") return { path: patch.path, op: "unset" };
						if (patch.value === undefined) {
							throw new TypeError(
								`Settings set patch for ${patch.path} cannot carry undefined; use unset instead.`,
							);
						}
						return { path: patch.path, op: "set", value: structuredClone(patch.value) };
					});
					revisions = durablePatches.map(patch => ({
						patch,
						revision: ++this.#nextRevision,
						previousRevision: this.#pathRevisions.get(patch.path),
					}));
					for (const entry of revisions) this.#pathRevisions.set(entry.patch.path, entry.revision);
					return durablePatches;
				},
				{
					validateRoot: (root, currentPatches) =>
						this.#rejectAtomicNotificationRepairForMalformedRoot(currentPatches, root),
					onRestored: restoredPatches =>
						this.#applyRestoredDurableBatch(revisions, restoredPatches, notificationValidationGuard),
				},
			);
			const appliedNotificationMutation = this.#applyDurableBatch(revisions);
			this.#recordNotificationValidationBatchApply(notificationValidationGuard, appliedNotificationMutation);
			return receipt;
		} catch (error) {
			for (const entry of revisions) {
				if (this.#pathRevisions.get(entry.patch.path) === entry.revision) {
					if (entry.previousRevision === undefined) this.#pathRevisions.delete(entry.patch.path);
					else this.#pathRevisions.set(entry.patch.path, entry.previousRevision);
				}
			}
			if (this.#modified.size > 0 && !this.#pendingSaveSlot) this.#queueSave();
			throw error;
		}
	}

	/**
	 * Apply runtime overrides (not persisted).
	 */
	override<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		if (isNotificationSettingsPath(path)) throw new NotificationSettingsOverrideError(path);
		const clonedValue = structuredClone(value);
		setByPath(this.#overrides, path.split("."), clonedValue);
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

	/** Flush a reserved debounced save without allowing it to be overtaken. */
	async flush(): Promise<void> {
		this.#releasePendingSaveSlot();
		if (this.#modified.size > 0 && !this.#pendingSaveSlot) this.#queueSave();
		this.#releasePendingSaveSlot();
		const observedSave = this.#savePromise;
		try {
			await observedSave;
		} catch {
			// Historical flush() behavior logs background failures but does not reject.
		}
		// A failed predecessor may settle just before a new mutation observes its
		// still-reserved slot. Explicit flush owns one fresh attempt for remaining
		// dirty patches instead of leaving them stranded or retrying forever.
		if (this.#modified.size > 0 && this.#savePromise === observedSave) {
			if (!this.#pendingSaveSlot) this.#queueSave();
			this.#releasePendingSaveSlot();
			try {
				await this.#savePromise;
			} catch {
				// Keep dirty state for a later explicit flush or mutation.
			}
		}
		await this.#refreshDurableSettings();
	}

	/** Like {@link flush}, but reports a durable save failure to the caller. */
	async flushOrThrow(): Promise<void> {
		this.#releasePendingSaveSlot();
		if (this.#modified.size > 0 && !this.#pendingSaveSlot) this.#queueSave();
		this.#releasePendingSaveSlot();
		await this.#savePromise;
		await this.#refreshDurableSettings();
	}

	async cloneForCwd(cwd: string): Promise<Settings> {
		// A clone shares the same config queue. Settle an already-reserved local
		// debounce before the clone can enqueue a durable selector, preventing it
		// from waiting behind a slot only this instance can open.
		await this.flush();
		const cloned = new Settings({
			cwd,
			agentDir: this.#agentDir,
			inMemory: !this.#persist,
		});
		cloned.#storage = this.#storage;
		cloned.#futureSchemaVersion = this.#futureSchemaVersion;

		cloned.#global = structuredClone(this.#global);
		cloned.#rawNotificationConfig = structuredClone(this.#rawNotificationConfig);
		cloned.#durableRawNotificationConfig = structuredClone(this.#durableRawNotificationConfig);
		cloned.#durableNotificationFingerprint = this.#durableNotificationFingerprint;
		cloned.#project = this.#persist ? await cloned.#loadProjectSettings() : structuredClone(this.#project);
		cloned.#overrides = structuredClone(this.#overrides);
		await cloned.#normalizeAfterLoad();
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
	 * Set a model role (helper for modelRoles record).
	 */
	setModelRole(role: ModelRole | string, modelId: ModelSelectorValue): void {
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

	setGlobalModelRole(role: ModelRole | string, modelId: ModelSelectorValue | undefined): void {
		const revision = ++this.#nextRevision;
		const patch: SettingsPatch = {
			path: "modelRoles",
			value: modelId,
			generation: ++this.#nextGeneration,
			revision,
			modelRole: role,
		};
		setRawModelRole(this.#global, role, modelId);
		this.#pathRevisions.set("modelRoles", revision);
		this.#modified.set(settingsPatchKey(patch), patch);
		this.#rebuildMerged();
		this.#queueSave();
	}

	async setGlobalModelRoleAndFlush(
		role: ModelRole | string,
		modelId: ModelSelectorValue | undefined,
	): Promise<CasReceipt> {
		return this.commitAtomicBatchWithCurrent(current => {
			const roles = rawSettingsRecord(current.modelRoles) ?? {};
			const next = { ...roles };
			if (modelId === undefined) delete next[role];
			else next[role] = modelId;
			return [{ path: "modelRoles", op: "set", value: next }];
		});
	}

	async restoreGlobalDefaultModelRoleIfCurrent(commit: CasReceipt): Promise<boolean> {
		return (await commit.restore()).status === "restored";
	}

	#replaceGlobalWithDurable(current: RawSettings): void {
		this.#global = current;
		for (const patch of this.#pendingPatchesInGenerationOrder()) {
			applySettingsPatch(this.#global, { ...patch, value: structuredClone(patch.value) });
			this.#applyNotificationMutationToRaw(patch.path, patch.value);
		}
		this.#rebuildMerged();
		this.#recomputeNotificationValidationFromRaw();
	}
	/**
	 * Set an agent model override while keeping any live runtime override aligned.
	 *
	 * Runtime model profiles override `task.agentModelOverrides` for the current
	 * session. A user-selected role assignment must win immediately in that same
	 * session, but only the explicit agent change should be persisted.
	 */
	setAgentModelOverride(agentName: string, modelId: ModelSelectorValue): void {
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
			if (modelId) next[role] = Array.isArray(modelId) ? [...modelId] : modelId;
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

		try {
			if (this.#persist) {
				this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir));
				await this.#migrateFromLegacy();
				this.#global = await this.#loadYaml(this.#configPath!);
			}
			if (this.#schemaMigrationPending)
				this.#recordLegacyFallbackMigrationPatch("configSchemaVersion", CONFIG_SCHEMA_VERSION);

			this.#project = await projectPromise;

			await this.#normalizeAfterLoad();
			if (this.#schemaReport.issues.length > 0) {
				logger.warn("Settings: schema reconciliation found configuration issues", {
					issues: this.#schemaReport.issues.map(issue => `${issue.kind}:${issue.path}`),
				});
			}
			return this;
		} catch (error) {
			this.#storage?.close();
			throw error;
		}
	}

	async #loadYaml(filePath: string): Promise<RawSettings> {
		this.#hasMalformedConfigRoot = false;
		this.#hasInvalidNotificationConfiguration = false;
		this.#captureRawNotificationConfig({});
		try {
			const content = await Bun.file(filePath).text();
			const parsed = YAML.parse(content);
			if (parsed === undefined) return {};
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				this.#hasMalformedConfigRoot = true;
				this.#captureRawNotificationConfig(undefined);
				return {};
			}
			const parsedRaw = parsed as RawSettings;
			if (filePath === this.#configPath) this.#captureRawNotificationConfig(parsedRaw);
			if (filePath === this.#configPath) {
				try {
					parseNotificationSettingsSnapshot(parsedRaw);
				} catch (error) {
					if (!(error instanceof Error) || error.message !== "gjc_notify_daemon_invalid_configuration")
						throw error;
					this.#hasInvalidNotificationConfiguration = true;
				}
			}
			this.#futureSchemaVersion =
				filePath === this.#configPath &&
				typeof parsedRaw.configSchemaVersion === "number" &&
				parsedRaw.configSchemaVersion > CONFIG_SCHEMA_VERSION;

			const configSchemaVersion = parsedRaw.configSchemaVersion;
			if (
				filePath === this.#configPath &&
				(typeof configSchemaVersion !== "number" || configSchemaVersion < CONFIG_SCHEMA_VERSION)
			) {
				this.#schemaMigrationPending = true;
			}
			const migrated = this.#migrateRawSettings(parsedRaw);
			const reconciled = reconcileSettingsSchema(migrated);
			if (typeof configSchemaVersion === "number" && configSchemaVersion > CONFIG_SCHEMA_VERSION) {
				reconciled.report.issues.push({
					path: "configSchemaVersion",
					kind: "pending-migration",
					detail: `Configuration requires schema version ${configSchemaVersion}.`,
				});
			}
			this.#schemaReport = reconciled.report;
			return reconciled.settings;
		} catch (error) {
			if (isEnoent(error)) {
				this.#captureRawNotificationConfig({});
				return {};
			}
			throw error;
		}
	}

	async #loadProjectSettings(): Promise<RawSettings> {
		try {
			const result = await loadCapability(settingsCapability.id, { cwd: this.#cwd });
			let merged: RawSettings = {};
			for (const item of result.items as SettingsCapabilityItem[]) {
				if (item.level !== "project") continue;
				const { settings, rejectedNotifications } = this.#stripProjectNotificationSettings(
					item.data as RawSettings,
				);
				if (rejectedNotifications) {
					logger.warn("Settings: ignoring project notification settings", { path: item.path });
				}
				merged = this.#deepMerge(merged, settings);
			}
			return this.#migrateRawSettings(merged);
		} catch {
			return {};
		}
	}

	async #normalizeAfterLoad(): Promise<void> {
		this.#sanitizeModelSelectorRecords();
		this.#rebuildMerged();
		if (!this.#futureSchemaVersion) {
			this.#legacyFallbackMigrationGlobalFingerprint = YAML.stringify(this.#global, null, 2);
			this.#migrateRetryFallbackChains();
			if (
				!this.#modified.has("modelRoles") &&
				![...this.#modified.keys()].some(path => path.startsWith("retry.fallback"))
			) {
				this.#legacyFallbackMigrationGlobalFingerprint = undefined;
			}
		}
		await this.flush();
		this.#sanitizeModelSelectorRecords();
		this.#rebuildMerged();
		this.#fireAllHooks();
	}

	#sanitizeModelSelectorRecords(): void {
		for (const source of [this.#global, this.#project, this.#overrides]) {
			for (const pathSegments of [["modelRoles"], ["task", "agentModelOverrides"]]) {
				const raw = getByPath(source, pathSegments);
				if (raw === undefined) continue;
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					logger.warn("Settings: replaced malformed model selector record", { path: pathSegments.join(".") });
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
		if (
			Object.keys(retainedGlobalChains).length === 0 &&
			this.#global.retry !== undefined &&
			Object.keys(rawSettingsRecord(this.#global.retry) ?? {}).length === 0
		) {
			delete this.#global.retry;
			this.#recordLegacyFallbackMigrationPatch("retry", undefined);
		}
		this.#rebuildMerged();
	}

	#recordLegacyFallbackMigrationPatch(path: string, value: unknown): void {
		const existing = this.#modified.get(path);
		if (existing && !existing.legacyFallbackMigration) {
			this.#modified.set(path, { ...existing, value: structuredClone(value) });
			return;
		}
		const revision = ++this.#nextRevision;
		this.#pathRevisions.set(path, revision);
		this.#modified.set(path, {
			path,
			value: structuredClone(value),
			generation: ++this.#nextGeneration,
			revision,
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

		// 3. Write merged settings through the shared atomic YAML pipeline.
		if (migrated && Object.keys(settings).length > 0) {
			try {
				await applyAtomicYamlPatches(
					this.#configPath,
					Object.entries(settings).map(([settingPath, value]) => ({
						path: settingPath,
						op: "set" as const,
						value,
					})),
				);
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

	/** Apply registered schema migrations once, using configSchemaVersion as the durable marker. */
	#migrateRawSettings(raw: RawSettings): RawSettings {
		const configuredVersion = raw.configSchemaVersion;
		if (configuredVersion === CONFIG_SCHEMA_VERSION) return raw;
		if (typeof configuredVersion === "number" && configuredVersion > CONFIG_SCHEMA_VERSION) return raw;

		// Migration registry v0 -> v1.
		// queueMode -> steeringMode
		normalizeSessionDirectoryMigration(raw);
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}
		// ask.timeout: v0 stored milliseconds; v1 stores seconds.
		if (raw.ask && typeof (raw.ask as Record<string, unknown>).timeout === "number") {
			const oldValue = (raw.ask as Record<string, unknown>).timeout as number;
			if (oldValue > 1000) (raw.ask as Record<string, unknown>).timeout = Math.round(oldValue / 1000);
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

		raw.configSchemaVersion = CONFIG_SCHEMA_VERSION;

		return raw;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Saving
	// ─────────────────────────────────────────────────────────────────────────

	#queueSave(): void {
		if (!this.#persist || !this.#configPath) return;

		const currentSlot = this.#pendingSaveSlot;
		if (currentSlot && !currentSlot.captured && !currentSlot.released) {
			this.#armSaveTimer(currentSlot);
			return;
		}

		let release!: () => void;
		const slot: PendingSaveSlot = {
			captured: false,
			released: false,
			release: () => release(),
			wait: new Promise<void>(resolve => {
				release = resolve;
			}),
		};
		this.#pendingSaveSlot = slot;

		let captured: SettingsPatch[] = [];
		let durableBeforeWrite: RawSettings | undefined;
		const save = reserveAtomicYamlUpdateSlot(this.#configPath, async () => {
			await slot.wait;
			slot.captured = true;
			if (this.#pendingSaveSlot === slot) this.#pendingSaveSlot = undefined;
			captured = this.#pendingPatchesInGenerationOrder();
			return {
				apply: current => {
					this.#migrateRawSettings(current);
					const migrationFingerprint = this.#legacyFallbackMigrationGlobalFingerprint;
					this.#legacyFallbackMigrationGlobalFingerprint = undefined;
					if (migrationFingerprint !== undefined && YAML.stringify(current, null, 2) !== migrationFingerprint) {
						this.#global = structuredClone(current);
						this.#rebuildMerged();
						if (getByPath(current, ["retry", "fallbackChains"]) !== undefined) {
							this.#migrateRetryFallbackChains();
							captured = this.#pendingPatchesInGenerationOrder();
						} else {
							for (const patch of captured) {
								if (!patch.legacyFallbackMigration) continue;
								const key = settingsPatchKey(patch);
								if (this.#modified.get(key)?.generation === patch.generation) this.#modified.delete(key);
							}
							captured = captured.filter(patch => !patch.legacyFallbackMigration);
						}
					}
					this.#fenceNotificationValidationForExternalDurableDelta(current, captured);
					durableBeforeWrite = structuredClone(current);
					for (const patch of captured) applySettingsPatch(current, patch);
					return { shouldWrite: captured.length > 0 };
				},
				shouldWrite: result => result.shouldWrite,
				committed: current => {
					for (const patch of captured) {
						const key = settingsPatchKey(patch);
						if (this.#modified.get(key)?.generation === patch.generation) this.#modified.delete(key);
					}
					this.#global = current;
					this.#captureRawNotificationConfig(current);
					for (const patch of this.#pendingPatchesInGenerationOrder()) {
						applySettingsPatch(this.#global, { ...patch, value: structuredClone(patch.value) });
						this.#applyNotificationMutationToRaw(patch.path, patch.value);
					}
					this.#rebuildMerged();
					this.#recomputeNotificationValidationFromRaw();
				},
			};
		}).then(() => undefined);
		this.#savePromise = save;
		void save.catch(error => {
			logger.warn("Settings: background save failed", { error: String(error) });
			for (const patch of captured) {
				const key = settingsPatchKey(patch);
				if (this.#modified.get(key)?.generation === patch.generation) this.#modified.set(key, patch);
			}
			if (durableBeforeWrite) {
				this.#global = durableBeforeWrite;
				this.#captureRawNotificationConfig(durableBeforeWrite);
				for (const patch of this.#pendingPatchesInGenerationOrder()) {
					applySettingsPatch(this.#global, { ...patch, value: structuredClone(patch.value) });
					this.#applyNotificationMutationToRaw(patch.path, patch.value);
				}
				this.#rebuildMerged();
				this.#recomputeNotificationValidationFromRaw();
			}
		});
		this.#armSaveTimer(slot);
	}

	#armSaveTimer(slot: PendingSaveSlot): void {
		if (this.#saveTimer) clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			if (slot.released) return;
			slot.released = true;
			slot.release();
		}, 100);
	}

	#pendingPatchesInGenerationOrder(): SettingsPatch[] {
		return [...this.#modified.values()].sort((left, right) => left.generation - right.generation);
	}
	#releasePendingSaveSlot(): void {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		const slot = this.#pendingSaveSlot;
		if (!slot || slot.released) return;
		slot.released = true;
		slot.release();
	}

	#applyDurableBatch(revisions: readonly DurableBatchRevision[]): boolean {
		return this.#applyDurablePatches(
			revisions,
			revisions.map(entry => entry.patch),
			true,
		);
	}

	#applyRestoredDurableBatch(
		revisions: readonly DurableBatchRevision[],
		restoredPatches: readonly AtomicYamlPatch[],
		notificationValidationGuard: NotificationValidationRestoreGuard,
	): void {
		const restoreNotificationValidationState = this.#canRestoreNotificationValidationState(
			notificationValidationGuard,
			restoredPatches.map(patch => patch.path),
		);
		if (this.#applyDurablePatches(revisions, restoredPatches, false) && restoreNotificationValidationState) {
			this.#restoreNotificationValidationState(notificationValidationGuard.state);
		}
	}

	#applyDurablePatches(
		revisions: readonly DurableBatchRevision[],
		patches: readonly AtomicYamlPatch[],
		clearStagedMutations: boolean,
	): boolean {
		const revisionsByPath = new Map<string, DurableBatchRevision>();
		for (const entry of revisions) revisionsByPath.set(entry.patch.path, entry);
		const finalPatches = new Map<string, AtomicYamlPatch>();
		for (const patch of patches) finalPatches.set(patch.path, patch);
		const applicable = [...finalPatches.values()].filter(patch => {
			const revision = revisionsByPath.get(patch.path);
			return revision !== undefined && this.#pathRevisions.get(patch.path) === revision.revision;
		});
		if (applicable.length === 0) return false;

		const previous = new Map<string, unknown>();
		for (const patch of applicable) {
			const settingPath = patch.path;
			const revision = revisionsByPath.get(patch.path)!;
			previous.set(settingPath, getByPath(this.#global, settingPath.split(".")));
			if (patch.op === "set") {
				setByPath(this.#global, settingPath.split("."), structuredClone(patch.value));
				this.#applyNotificationMutationToRaw(settingPath, patch.value);
			} else {
				deleteByPath(this.#global, settingPath.split("."));
				this.#applyNotificationMutationToRaw(settingPath, undefined);
			}
			if (clearStagedMutations) {
				for (const [key, staged] of this.#modified) {
					if (staged.path === settingPath && staged.revision <= revision.revision) {
						this.#modified.delete(key);
					}
				}
			}
		}
		for (const patch of applicable) this.#applyDurableNotificationMutation(patch);
		const modelRoles = rawSettingsRecord(this.#global.modelRoles);
		if (
			applicable.some(patch => patch.path === "modelRoles.default" && patch.op === "unset") &&
			modelRoles &&
			Object.keys(modelRoles).length === 0
		) {
			delete this.#global.modelRoles;
		}
		this.#rebuildMerged();
		this.#revalidateNotificationSettingsAfterMutation(applicable.map(patch => patch.path));
		for (const patch of applicable) {
			const settingPath = patch.path as SettingPath;
			const hook = SETTING_HOOKS[settingPath];
			if (hook) hook(this.get(settingPath), previous.get(settingPath)!);
		}
		return applicable.some(patch => isNotificationSettingsPath(patch.path));
	}

	async #refreshDurableSettings(): Promise<void> {
		if (!this.#persist || !this.#configPath) return;
		const previousFingerprint = this.#durableNotificationFingerprint;
		const current = await this.#loadYaml(this.#configPath);
		if (previousFingerprint !== this.#durableNotificationFingerprint) this.#notificationValidationGeneration++;
		this.#replaceGlobalWithDurable(current);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	#notificationValidationRestoreGuard(): NotificationValidationRestoreGuard {
		return {
			state: this.#notificationValidationState(),
			restoreGeneration: undefined,
		};
	}
	#notificationValidationState(): NotificationValidationState {
		return {
			malformedConfigRoot: this.#hasMalformedConfigRoot,
			invalidNotificationConfiguration: this.#hasInvalidNotificationConfiguration,
			generation: this.#notificationValidationGeneration,
		};
	}
	#recordNotificationValidationBatchApply(
		guard: NotificationValidationRestoreGuard,
		pathsOrAppliedNotificationMutation: Iterable<string> | boolean,
	): void {
		const appliedNotificationMutation =
			typeof pathsOrAppliedNotificationMutation === "boolean"
				? pathsOrAppliedNotificationMutation
				: [...pathsOrAppliedNotificationMutation].some(isNotificationSettingsPath);
		if (appliedNotificationMutation && this.#notificationValidationGeneration === guard.state.generation + 1) {
			guard.restoreGeneration = this.#notificationValidationGeneration;
		}
	}
	#canRestoreNotificationValidationState(guard: NotificationValidationRestoreGuard, paths: Iterable<string>): boolean {
		return (
			[...paths].some(isNotificationSettingsPath) &&
			guard.restoreGeneration !== undefined &&
			this.#notificationValidationGeneration === guard.restoreGeneration
		);
	}
	#restoreNotificationValidationState(state: NotificationValidationState): void {
		this.#hasMalformedConfigRoot = state.malformedConfigRoot;
		this.#hasInvalidNotificationConfiguration = state.invalidNotificationConfiguration;
	}
	#rejectAtomicNotificationRepairForMalformedRoot(patches: readonly AtomicYamlPatch[], root: unknown): void {
		if (
			root !== undefined &&
			!rawSettingsRecord(root) &&
			patches.some(patch => isNotificationSettingsPath(patch.path))
		) {
			throw new Error("Cannot atomically repair notification settings while config.yml has a malformed root.");
		}
	}

	#captureRawNotificationConfig(raw: RawSettings | undefined): void {
		this.#rawNotificationConfig = raw === undefined ? undefined : structuredClone(raw);
		this.#durableRawNotificationConfig = raw === undefined ? undefined : structuredClone(raw);
		this.#durableNotificationFingerprint =
			raw === undefined ? "malformed-root" : YAML.stringify(getByPath(raw, ["notifications"]), null, 2);
	}
	#applyNotificationMutationToRaw(path: string, value: unknown | undefined): void {
		if (!isNotificationSettingsPath(path)) return;
		if (!this.#rawNotificationConfig) this.#rawNotificationConfig = {};
		if (value === undefined) deleteByPath(this.#rawNotificationConfig, path.split("."));
		else setByPath(this.#rawNotificationConfig, path.split("."), structuredClone(value));
	}
	#applyDurableNotificationMutation(patch: AtomicYamlPatch): void {
		if (!isNotificationSettingsPath(patch.path)) return;
		if (!this.#durableRawNotificationConfig) this.#durableRawNotificationConfig = {};
		if (patch.op === "unset") deleteByPath(this.#durableRawNotificationConfig, patch.path.split("."));
		else setByPath(this.#durableRawNotificationConfig, patch.path.split("."), structuredClone(patch.value));
		this.#durableNotificationFingerprint = YAML.stringify(
			getByPath(this.#durableRawNotificationConfig, ["notifications"]),
			null,
			2,
		);
	}
	#fenceNotificationValidationForExternalDurableDelta(current: RawSettings, captured: readonly SettingsPatch[]): void {
		const expected = structuredClone(this.#durableRawNotificationConfig);
		for (const patch of captured) {
			if (!isNotificationSettingsPath(patch.path)) continue;
			if (!expected) break;
			if (patch.value === undefined) deleteByPath(expected, patch.path.split("."));
			else setByPath(expected, patch.path.split("."), structuredClone(patch.value));
		}
		const expectedFingerprint =
			expected === undefined ? "malformed-root" : YAML.stringify(getByPath(expected, ["notifications"]), null, 2);
		const currentFingerprint = YAML.stringify(getByPath(current, ["notifications"]), null, 2);
		if (expectedFingerprint !== currentFingerprint) this.#notificationValidationGeneration++;
	}
	#recomputeNotificationValidationFromRaw(): void {
		if (this.#rawNotificationConfig === undefined) {
			this.#hasMalformedConfigRoot = true;
			this.#hasInvalidNotificationConfiguration = false;
			return;
		}
		try {
			parseNotificationSettingsSnapshot(this.#rawNotificationConfig);
			this.#hasMalformedConfigRoot = false;
			this.#hasInvalidNotificationConfiguration = false;
		} catch (error) {
			if (error instanceof Error && error.message === "gjc_notify_daemon_invalid_configuration") {
				this.#hasMalformedConfigRoot = false;
				this.#hasInvalidNotificationConfiguration = true;
				return;
			}
			throw error;
		}
	}
	#revalidateNotificationSettingsAfterMutation(paths: Iterable<string>): void {
		if (![...paths].some(isNotificationSettingsPath)) return;
		this.#notificationValidationGeneration++;
		try {
			parseNotificationSettingsSnapshot(this.#rawNotificationConfig);
			this.#hasMalformedConfigRoot = false;
			this.#hasInvalidNotificationConfiguration = false;
		} catch (error) {
			if (error instanceof Error && error.message === "gjc_notify_daemon_invalid_configuration") {
				this.#hasInvalidNotificationConfiguration = true;
				return;
			}
			throw error;
		}
	}
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

	#stripProjectNotificationSettings(settings: RawSettings): {
		settings: RawSettings;
		rejectedNotifications: boolean;
	} {
		let rejectedNotifications = false;
		const sanitized: RawSettings = {};
		for (const [key, value] of Object.entries(settings)) {
			if (key === "notifications" && value && typeof value === "object" && !Array.isArray(value)) {
				const localNotifications: Record<string, unknown> = {};
				for (const [notificationKey, notificationValue] of Object.entries(value)) {
					if (LOCAL_NOTIFICATION_SETTING_KEYS.has(notificationKey)) {
						localNotifications[notificationKey] = notificationValue;
					} else {
						rejectedNotifications = true;
					}
				}
				if (Object.keys(localNotifications).length > 0) sanitized[key] = localNotifications;
				continue;
			}
			if (isNotificationSettingsPath(key)) {
				rejectedNotifications = true;
				continue;
			}
			sanitized[key] = value;
		}
		return { settings: sanitized, rejectedNotifications };
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
let globalInitOptions: SettingsOptions | null = null;

export function isSettingsInitialized(): boolean {
	return globalInstance !== null;
}

/**
 * Reset the global singleton for testing.
 * @internal
 */
export function resetSettingsForTest(): void {
	globalInstance?.getStorage()?.close();
	globalInstance = null;
	globalInstancePromise = null;
	globalInitOptions = null;
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
