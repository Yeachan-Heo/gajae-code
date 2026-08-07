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

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import {
	getAgentDbPath,
	getAgentDir,
	getConfigRootDir,
	getCustomThemesDir,
	getProjectDir,
	isEnoent,
	logger,
	setDefaultTabWidth,
} from "@gajae-code/utils";
// Subpath import keeps Settings native-free for the W5b S1/idle module-trace
// gate: the package barrel's procmgr namespace pulls @gajae-code/natives.
import { getShellConfig as resolveShellConfig } from "@gajae-code/utils/shell-config";
import { YAML } from "bun";
import { type Settings as SettingsCapabilityItem, settingsCapability } from "../capability/settings";
import type { ModelRole } from "../config/model-registry";
import { loadCapability } from "../discovery";
import { extractWorkflowSetting, type WorkflowSettingKey } from "../gjc-runtime/workflow-settings";
import { isLightTheme, setAutoThemeMapping, setColorBlindMode, setSymbolPreset } from "../modes/theme/theme";
import {
	type NotificationSettingsReader,
	type NotificationSettingsSnapshot,
	parseNotificationSettingsSnapshot,
} from "../sdk/bus/config";
import { AgentStorage } from "../session/agent-storage";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import {
	type AtomicYamlConfigTransaction,
	AtomicYamlConflictError,
	type AtomicYamlPatch,
	applyAtomicYamlPatches,
	applyAtomicYamlPatchesWithCurrent,
	atomicYamlPathHash,
	type CasReceipt,
	deleteByPath,
	enqueueAtomicYamlOperation,
	reserveAtomicYamlUpdateSlot,
	setByPath,
	withAtomicYamlConfigTransaction,
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

const CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS: readonly WorkflowSettingKey[] = [
	"gjc.deepInterview.ambiguityThreshold",
	"gjc.ralplan.autoHandoff",
	"gjc.ralplan.maxIterations",
	"gjc.ralplan.maxReviewPassesPerLane",
	"gjc.ultragoal.nudgeBudget",
];

const WORKFLOW_MIGRATION_MARKER_VERSION = 1;

type WorkflowMigrationMarker = {
	version: 1;
	status: "pending" | "complete";
	sourcePath: string;
	backupPath: string;
	targetPath: string;
	/** Canonical (realpath) agent dir at migration time; a symlink repointed
	 * afterwards must not be treated as the same migration target. */
	canonicalTargetDir?: string;
	/** `dev:ino` of the target config.yml at migration time; detects a
	 * same-pathname profile REPLACEMENT (deleted + recreated), which realpath
	 * alone cannot. */
	canonicalTargetIdentity?: string;
	/** `dev:ino` of the config.yml FILE that received the migration write; a
	 * later atomic editor save or file replacement yields a new inode that must
	 * not be published as migration-owned. */
	targetFileIdentity?: string;
	sourceSha256: string;
	migratedKeys: WorkflowSettingKey[];
	startedAt: string;
	/** The prior source hash (the migration-write ownership basis) when the
	 * reconcile rewrites the marker as pending; the resume accepts a backup
	 * matching either the new hash (after refresh) or this prior hash. */
	priorSourceSha256?: string;
	/** Per-key sha256 of the values written by an interrupted reconcile; the
	 * resume recognizes a target matching a recorded repair value as the
	 * reconcile's own write even after a further source edit. */
	repairValueHashes?: Record<string, string>;
	/** True once the reconcile's target repairs were actually applied (the
	 * pending marker is rewritten after the CAS-protected apply succeeds);
	 * only then are repairValueHashes treated as committed-write evidence. */
	repairsApplied?: boolean;
	/** Per-key sha256 of the target values BEFORE the interrupted reconcile's
	 * repairs; the resume recognizes a repair value as committed when the
	 * target CHANGED from this recorded state (even if the post-apply marker
	 * rewrite was not reached). */
	preRepairTargetHashes?: Record<string, string>;
	completedAt?: string;
};

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
	invalidNotificationGlobal: boolean;
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
	#changeListeners = new Set<(path: SettingPath) => void>();
	#pendingSaveSlot?: PendingSaveSlot;

	/** Legacy fallback migration warnings emitted once per settings instance. */
	#legacyFallbackMigrationWarnings = 0;
	#legacyFallbackMigrationGlobalFingerprint: string | undefined;
	#schemaReport: SettingsSchemaReport = { issues: [], valid: true };
	#schemaMigrationPending = false;
	/** A newer config schema must never be rewritten by legacy migrations. */
	#futureSchemaVersion = false;
	#hasMalformedConfigRoot = false;
	/** YAML syntax was unrecoverable, so the loaded defaults are read-only until config.yml is repaired. */
	#hasRecoveredConfigSyntax = false;
	#hasInvalidNotificationGlobal = false;
	#notificationValidationGeneration = 0;
	/** Notification subtree fingerprint from the last raw durable config read. */
	#durableNotificationFingerprint: string | undefined;

	/** Whether to persist changes */
	#persist: boolean;

	private constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		this.#configPath = options.inMemory ? null : path.resolve(this.#agentDir, "config.yml");
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
			this.#hasMalformedConfigRoot || this.#hasInvalidNotificationGlobal ? null : this.#rawNotificationConfig,
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

	onChanged(listener: (path: SettingPath) => void): () => void {
		this.#changeListeners.add(listener);
		return () => this.#changeListeners.delete(listener);
	}

	/** Whether durable settings mutations are permitted for the loaded configuration. */
	canWriteDurableConfig(): boolean {
		return !this.#persist || !this.#hasRecoveredConfigSyntax;
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
		this.#assertDurableConfigWritable();
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
		for (const listener of this.#changeListeners) listener(path);
	}

	/**
	 * Delete a global setting (sync), rather than serializing an ambiguous YAML
	 * `undefined` value. Defaults/project settings become visible immediately.
	 */
	unset<P extends SettingPath>(path: P): void {
		this.#assertDurableConfigWritable();
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
		for (const listener of this.#changeListeners) listener(path);
	}

	/**
	 * Persist a tagged batch as one atomic YAML replacement. Unlike ordinary
	 * {@link set}, canonical state and hooks change only after the rename succeeds.
	 */
	async commitAtomicBatch(patches: readonly SettingsAtomicPatch[]): Promise<CasReceipt> {
		this.#assertDurableConfigWritable();
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

		const commit = applyAtomicYamlPatches(this.#configPath, durablePatches, {
			validateRoot: (root, currentPatches) =>
				this.#rejectAtomicNotificationRepairForMalformedRoot(currentPatches, root),
			onRestored: restoredPatches =>
				this.#applyRestoredDurableBatch(revisions, restoredPatches, notificationValidationGuard),
		});
		const failureRefresh = this.#reserveAtomicFailureRefresh(commit);
		try {
			const receipt = await commit;
			await failureRefresh;
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
			await failureRefresh;
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
		this.#assertDurableConfigWritable();
		if (!this.#persist || !this.#configPath) {
			const patches = await buildPatches(structuredClone(this.#global));
			return this.commitAtomicBatch(patches);
		}

		this.#releasePendingSaveSlot();
		let revisions: DurableBatchRevision[] = [];
		const notificationValidationGuard = this.#notificationValidationRestoreGuard();
		const commit = applyAtomicYamlPatchesWithCurrent(
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
		const failureRefresh = this.#reserveAtomicFailureRefresh(commit);
		try {
			const receipt = await commit;
			await failureRefresh;
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
			await failureRefresh;
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
		if (this.#modified.size > 0 && !this.#pendingSaveSlot) {
			this.#queueSave();
			this.#releasePendingSaveSlot();
			try {
				await this.#savePromise;
			} catch {
				// Keep dirty state for a later explicit flush or mutation.
			}
		}
	}

	/** Like {@link flush}, but reports a durable save failure to the caller. */
	async flushOrThrow(): Promise<void> {
		this.#releasePendingSaveSlot();
		if (this.#modified.size > 0 && !this.#pendingSaveSlot) this.#queueSave();
		this.#releasePendingSaveSlot();
		let saveError: unknown;
		try {
			await this.#savePromise;
		} catch (error) {
			saveError = error;
		}
		await this.#refreshDurableSettings();
		if (this.#modified.size > 0 && !this.#pendingSaveSlot) {
			this.#queueSave();
			this.#releasePendingSaveSlot();
			await this.#savePromise;
			return;
		}
		if (saveError !== undefined) throw saveError;
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
		cloned.#schemaReport = structuredClone(this.#schemaReport);
		cloned.#schemaMigrationPending = this.#schemaMigrationPending;
		cloned.#futureSchemaVersion = this.#futureSchemaVersion;
		cloned.#hasMalformedConfigRoot = this.#hasMalformedConfigRoot;
		cloned.#hasRecoveredConfigSyntax = this.#hasRecoveredConfigSyntax;
		cloned.#hasInvalidNotificationGlobal = this.#hasInvalidNotificationGlobal;
		cloned.#notificationValidationGeneration = this.#notificationValidationGeneration;
		cloned.#global = structuredClone(this.#global);
		cloned.#rawNotificationConfig = structuredClone(this.#rawNotificationConfig);
		cloned.#durableRawNotificationConfig = structuredClone(this.#durableRawNotificationConfig);
		cloned.#durableNotificationFingerprint = this.#durableNotificationFingerprint;
		cloned.#project = this.#persist ? await cloned.#loadProjectSettings() : structuredClone(this.#project);
		cloned.#overrides = structuredClone(this.#overrides);
		if (cloned.#hasRecoveredConfigSyntax) {
			cloned.#sanitizeModelSelectorRecords();
			cloned.#rebuildMerged();
		} else await cloned.#normalizeAfterLoad();
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
		return resolveShellConfig(shell);
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
		this.#assertDurableConfigWritable();
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
		const previous = new Map<SettingPath, unknown>();
		for (const settingPath of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			previous.set(settingPath, structuredClone(this.get(settingPath)));
		}
		this.#global = current;
		for (const patch of this.#pendingPatchesInGenerationOrder()) {
			applySettingsPatch(this.#global, { ...patch, value: structuredClone(patch.value) });
			if (this.#rawNotificationConfig !== undefined) {
				this.#applyNotificationMutationToRaw(patch.path, patch.value);
			}
		}
		this.#rebuildMerged();
		this.#recomputeNotificationValidationFromRaw();
		for (const settingPath of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			const previousValue = previous.get(settingPath);
			const nextValue = this.get(settingPath);
			if (util.isDeepStrictEqual(previousValue, nextValue)) continue;
			const hook = SETTING_HOOKS[settingPath];
			if (hook) hook(nextValue, previousValue);
			for (const listener of this.#changeListeners) listener(settingPath);
		}
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
				await this.#migrateAgentDirAndDatabaseLegacy();
				await this.#migrateConfigRootWorkflowSettings();
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

	#resetYamlLoadState(): void {
		this.#hasMalformedConfigRoot = false;
		this.#hasRecoveredConfigSyntax = false;
		this.#hasInvalidNotificationGlobal = false;
		this.#schemaReport = { issues: [], valid: true };
		this.#schemaMigrationPending = false;
		this.#futureSchemaVersion = false;
		this.#captureRawNotificationConfig({});
	}

	async #loadYaml(filePath: string): Promise<RawSettings> {
		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch (error) {
			if (isEnoent(error)) {
				this.#resetYamlLoadState();
				return {};
			}
			throw error;
		}
		this.#resetYamlLoadState();
		if (content.trim() === "") return {};
		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch {
			this.#hasRecoveredConfigSyntax = true;
			this.#hasMalformedConfigRoot = true;
			this.#schemaReport = {
				valid: false,
				issues: [
					{
						path: "config.yml",
						kind: "invalid",
						detail: "Configuration YAML syntax is invalid; repair config.yml before changing settings.",
					},
				],
			};
			this.#captureRawNotificationConfig(undefined);
			return {};
		}
		if (parsed === undefined) return {};
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			this.#hasMalformedConfigRoot = true;
			this.#schemaReport = {
				valid: false,
				issues: [
					{
						path: "config.yml",
						kind: "invalid",
						detail: "Configuration root must be a YAML mapping.",
					},
				],
			};
			this.#captureRawNotificationConfig(undefined);
			return {};
		}
		const parsedRaw = parsed as RawSettings;
		if (filePath === this.#configPath) this.#captureRawNotificationConfig(parsedRaw);
		if (filePath === this.#configPath) {
			try {
				parseNotificationSettingsSnapshot(parsedRaw);
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "gjc_notify_daemon_invalid_configuration") throw error;
				this.#hasInvalidNotificationGlobal = true;
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

	async #migrateAgentDirAndDatabaseLegacy(): Promise<void> {
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

	/**
	 * One-time migration of the machine-global config-root `settings.json`
	 * (`<configRoot>/settings.json`, normally `~/.gjc/settings.json`) workflow
	 * keys into the default global agent `config.yml`. Runs only for the default
	 * global agent scope, inside one critical section on the target config lock,
	 * and migrates only the five workflow keys that the workflow runtimes read.
	 *
	 * The legacy config-root file is an orphan path: only the workflow runtimes
	 * ever read it, and the earlier Settings migrations never covered it. Keeping
	 * it read-only forever would leave two settings surfaces in conflict, so a
	 * valid source is consumed exactly once (absent-only patches, no-clobber
	 * `.bak`, durable sidecar marker) after which the runtimes' legacy fallback
	 * still works for a user-recreated file.
	 */
	async #migrateConfigRootWorkflowSettings(): Promise<void> {
		if (!this.#configPath) return;
		// Strengthened pairing gate: only the default global agent scope may
		// consume the machine-global source. A custom/temporary agentDir
		// (`Settings.loadForScope` for SDK or tests) must never touch it.
		if (!this.#isDefaultGlobalAgentScope()) return;

		const source = path.resolve(getConfigRootDir(), "settings.json");
		const backup = `${source}.bak`;
		const markerPath = `${source}.migrated`;
		const target = path.resolve(this.#configPath);
		// If the config root is literally the agent dir, the agent-dir migration
		// already owns this physical source; never double-rename it.
		if (source === path.resolve(path.join(this.#agentDir, "settings.json"))) return;

		// Short-circuit before touching the target config.yml: with no source,
		// backup, or marker there is nothing to migrate, and entering the
		// transaction would parse the target (aborting settings load on a
		// malformed config.yml even when no migration is needed).
		const preSourceExists = await this.#pathExists(source);
		const preBackupExists = await this.#pathExists(backup);
		const preMarkerExists = await this.#pathExists(markerPath);
		if (!preSourceExists && !preBackupExists && !preMarkerExists) return;
		// Tracks whether THIS run durably wrote the pending marker and whether its
		// target patch committed. A CAS rejection with a pending marker written by
		// this run but no committed target write must clear the marker (its
		// migratedKeys claim ownership of never-applied patches); a prior run's
		// marker is retained as the only evidence its values are migration-written.
		let pendingMarkerWritten = false;
		let targetPatchCommitted = false;
		// A `.bak` created by ANOTHER process after the initial backupExists check
		// must never be removed by this migration: abort paths may delete a backup
		// only when this run created it (after a successful no-replace move).
		let backupCreatedByThisRun = false;
		try {
			await withAtomicYamlConfigTransaction(target, async tx => {
				// A config.yml written by a NEWER schema version is intentionally
				// read-only across Settings; the migration runs before #loadYaml
				// sets #futureSchemaVersion, so it must check the target schema
				// itself and never patch it or consume the legacy source.
				const targetSchemaVersion = (tx.root as Record<string, unknown> | null | undefined)?.configSchemaVersion;
				if (typeof targetSchemaVersion === "number" && targetSchemaVersion > CONFIG_SCHEMA_VERSION) {
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration skipped: ${target} is a future config schema (configSchemaVersion ${targetSchemaVersion} > ${CONFIG_SCHEMA_VERSION})`,
					);
					return;
				}
				const markerFileExists = await this.#pathExists(markerPath);
				let marker = await this.#readWorkflowMigrationMarker(markerPath);
				// A structurally valid marker that points at different source/backup/
				// target paths (e.g. the config root moved) must never suppress or
				// shortcut the migration; treat it as invalid.
				if (marker && !this.#workflowMigrationMarkerPathsMatch(marker, source, backup, target)) {
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration marker at ${markerPath} does not match the current source/backup/target paths; treating it as invalid`,
					);
					marker = null;
				}
				// The marker records the identity of the directory that received (or
				// would receive) the migration write. If that directory was
				// deleted/recreated or a symlink was repointed, recovery must not
				// apply the marker's ownership claims to the replacement profile -
				// for a PENDING marker (claims never completed) and for a COMPLETE
				// marker (deletion recovery or reconcile would otherwise overwrite
				// or unset a genuine value in the new profile).
				if (marker?.status === "pending") {
					const pendingMarkerIdentity = marker.canonicalTargetIdentity;
					if (
						typeof pendingMarkerIdentity !== "string" ||
						pendingMarkerIdentity.length === 0 ||
						(await this.#statIdentity(path.dirname(target))) !== pendingMarkerIdentity
					) {
						this.#warnLegacyFallbackMigration(
							`Settings: config-root workflow migration pending marker at ${markerPath} lacks or mismatches the target directory identity; treating it as invalid so recovery never applies its claims to the current profile`,
						);
						marker = null;
					}
				} else if (marker?.status === "complete") {
					const completeMarkerIdentity = marker.canonicalTargetIdentity;
					if (
						typeof completeMarkerIdentity !== "string" ||
						completeMarkerIdentity.length === 0 ||
						(await this.#statIdentity(path.dirname(target))) !== completeMarkerIdentity
					) {
						this.#warnLegacyFallbackMigration(
							`Settings: config-root workflow migration complete marker at ${markerPath} lacks or mismatches the target directory identity; treating it as invalid so recovery never applies its claims to the current profile`,
						);
						marker = null;
					}
				}
				if (marker?.status === "complete") {
					// The migration is complete only while the source still matches
					// the marker hash. If the user edited/recreated the legacy
					// source, the stale migration-owned target values must be
					// reconciled with the current source (the resolver already
					// reactivates the legacy layer on the hash mismatch, but the
					// higher-precedence agent-config value would keep shadowing it).
					let currentCompleteSourceHash: string | null = null;
					try {
						currentCompleteSourceHash = await this.#sha256File(source);
					} catch (error) {
						if (!isEnoent(error)) {
							// A transient read failure (permissions/I-O) is NOT a
							// deletion: leave everything unchanged so no
							// configuration or recovery data is lost.
							this.#warnLegacyFallbackMigration(
								`Settings: could not re-read ${source} after migration; leaving source/backup/marker untouched`,
							);
							return;
						}
						// ENOENT = deleted after completion: honor the deletion by
						// reverting ONLY the marker-owned target values that still
						// match the migration's write (the backup copy); a newer
						// `gjc config set` override is never reverted.
						let deletionBackupDoc: Record<string, unknown> | null = null;
						try {
							// Read the backup ONCE: verify its hash and parse the
							// SAME bytes (a second read could observe a different
							// revision). A complete marker has no priorSourceSha256,
							// so the two-hash check below equals the old
							// sourceSha256-only basis.
							const deletionBackupRead = await this.#readBackupBytes(backup);
							const deletionBackupHash = createHash("sha256")
								.update(Buffer.from(deletionBackupRead.bytes))
								.digest("hex");
							if (
								deletionBackupHash !== marker.sourceSha256 &&
								deletionBackupHash !== marker.priorSourceSha256
							) {
								this.#warnLegacyFallbackMigration(
									`Settings: the migration backup ${backup} no longer matches the marker hash; leaving source/backup/marker untouched`,
								);
								return;
							}
							deletionBackupDoc = JSON.parse(deletionBackupRead.text) as Record<string, unknown>;
						} catch {
							this.#warnLegacyFallbackMigration(
								`Settings: could not read the migration backup ${backup} for deletion recovery; leaving source/backup/marker untouched`,
							);
							return;
						}
						const unsets: AtomicYamlPatch[] = [];
						const flatKeys: string[] = [];
						for (const key of marker.migratedKeys) {
							const targetValue = extractWorkflowSetting(tx.root, key, { flat: false });
							const migratedValue = extractWorkflowSetting(deletionBackupDoc, key);
							if (
								targetValue.present &&
								migratedValue.present &&
								this.#coerceWorkflowScalar(key, migratedValue.value) === targetValue.value
							) {
								unsets.push({ path: key, op: "unset" });
								if (Object.hasOwn(tx.root as Record<string, unknown>, key)) flatKeys.push(key);
							}
						}
						await tx.applyPatchesAndRemoveTopLevelKeys(unsets, flatKeys);
						await fs.promises.rm(backup, { force: true }).catch(() => undefined);
						await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
						this.#warnLegacyFallbackMigration(
							`Settings: config-root workflow settings deleted after migration (${source}); stale marker-owned target values reverted, user overrides kept, backup removed, marker cleared`,
						);
						return;
					}
					if (currentCompleteSourceHash === marker.sourceSha256) return;
					await this.#reconcileMigratedSource({
						tx,
						marker,
						source,
						backup,
						markerPath,
						target,
						currentSourceHash: currentCompleteSourceHash,
					});
					return;
				}

				const sourceExists = await this.#pathExists(source);
				const backupExists = await this.#pathExists(backup);

				// Valid pending marker: crash-recovery proof only.
				if (marker?.status === "pending") {
					if (backupExists && !sourceExists) {
						// The copy path NEVER removes the source, so its absence
						// here is an external DELETION: honor it by reverting the
						// marker-owned target values, removing the backup, and
						// clearing the marker - instead of finalizing and silently
						// restoring the deleted overrides.
						const backupHash = await this.#sha256File(backup);
						if (backupHash !== marker.sourceSha256 && backupHash !== marker.priorSourceSha256) {
							this.#warnLegacyFallbackMigration(
								`Settings: config-root workflow migration pending marker cannot be verified (${backup}); leaving for diagnosis/retry`,
							);
							return;
						}
						// A deletion during a reconcile transition (the backup still
						// matches priorSourceSha256) must revert EVERY marker-owned
						// target - the marker claims them as its repairs. In the
						// fresh case (backup matches the marker hash) revert only
						// the values still matching the migration write, preserving
						// a newer `gjc config set` override.
						// A deletion during a reconcile transition accepts the
						// prior-hash backup, but only targets matching a verifiable
						// migration write (the backup) are reverted: a target the
						// user replaced after the transition cannot be verified
						// (the repaired values' source is gone) and is preserved.
						let deletionBackupDoc: Record<string, unknown> | null = null;
						try {
							const deletionBackupRead = await this.#readBackupBytes(backup);
							const deletionBackupHash = createHash("sha256")
								.update(Buffer.from(deletionBackupRead.bytes))
								.digest("hex");
							if (
								deletionBackupHash !== marker.sourceSha256 &&
								deletionBackupHash !== marker.priorSourceSha256
							) {
								this.#warnLegacyFallbackMigration(
									`Settings: the migration backup ${backup} no longer matches the marker hash; leaving source/backup/marker untouched`,
								);
								return;
							}
							deletionBackupDoc = JSON.parse(deletionBackupRead.text) as Record<string, unknown>;
						} catch {
							this.#warnLegacyFallbackMigration(
								`Settings: could not read the migration backup ${backup} for deletion recovery; leaving source/backup/marker untouched`,
							);
							return;
						}
						const markerOwnedUnsets: AtomicYamlPatch[] = [];
						const markerFlatKeys: string[] = [];
						for (const key of marker.migratedKeys) {
							const targetValue = extractWorkflowSetting(tx.root, key, { flat: false });
							if (!targetValue.present) continue;
							const migratedValue = extractWorkflowSetting(deletionBackupDoc, key);
							if (
								(migratedValue.present &&
									this.#coerceWorkflowScalar(key, migratedValue.value) === targetValue.value) ||
								// A reconcile that COMMITTED its repairs left the recorded
								// repair values in the target: the deletion must revert
								// them too (they are migration writes, not user
								// overrides). The repair is committed only when the
								// post-apply flag is set (a mere change from the
								// pre-repair state could be a coincidental user
								// value).
								(marker.repairValueHashes?.[key] !== undefined &&
									createHash("sha256").update(JSON.stringify(targetValue.value)).digest("hex") ===
										marker.repairValueHashes[key] &&
									marker.repairsApplied === true)
							) {
								markerOwnedUnsets.push({ path: key, op: "unset" });
								if (Object.hasOwn(tx.root as Record<string, unknown>, key)) markerFlatKeys.push(key);
							}
						}
						await tx.applyPatchesAndRemoveTopLevelKeys(markerOwnedUnsets, markerFlatKeys);
						await fs.promises.rm(backup, { force: true }).catch(() => undefined);
						await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
						this.#warnLegacyFallbackMigration(
							`Settings: config-root workflow migration cleared: ${source} was deleted during pending recovery; marker-owned target values reverted, backup removed`,
						);
						return;
					}
					if (sourceExists && backupExists) {
						const sourceStat = await fs.promises.stat(source).catch((error: unknown) => {
							// Only ENOENT means absence; a transient permission/I-O
							// failure must not be misread as a source edit (which
							// would revert marker-owned values and remove recovery
							// artifacts).
							if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
							throw error;
						});
						const sourceHash = sourceStat ? await this.#sha256File(source) : "";
						// Read the backup ONCE: the hash below and the edited-source
						// parse use the SAME bytes (a second read could observe a
						// different revision).
						const pendingBackupRead = await this.#readBackupBytes(backup);
						const backupHash = createHash("sha256").update(Buffer.from(pendingBackupRead.bytes)).digest("hex");
						if (
							(sourceHash === marker.sourceSha256 && backupHash !== marker.sourceSha256) ||
							// The source was edited AGAIN during the transition: the
							// backup still matches priorSourceSha256, which is
							// evidence the reconcile is in progress - resume it
							// against the CURRENT source.
							(marker.priorSourceSha256 !== undefined && backupHash === marker.priorSourceSha256)
						) {
							// The reconcile recorded the CURRENT source hash in a
							// PENDING marker: it was interrupted between the pending
							// write and the COMPLETE marker (a crash or a backup
							// failure). Resume it to completion.
							await this.#reconcileMigratedSource({
								tx,
								marker,
								source,
								backup,
								markerPath,
								target,
								currentSourceHash: sourceHash,
							});
							return;
						}
						if (sourceHash === marker.sourceSha256 && backupHash === marker.sourceSha256) {
							// Interrupted no-replace move with the target already patched:
							// the duplicate source is kept ACTIVE - a path-based unlink
							// after the identity check could delete a rename-replaced
							// file - and the resolver deactivates the migrated legacy
							// layer while the source still matches the marker hash
							// (reactivating it on later edits/recreates). Complete only
							// when the target actually contains the migrated keys.
							if (this.#workflowMigrationTargetSatisfies(tx.root, marker)) {
								const targetIdentity = await this.#workflowMigrationTargetIdentity(target);
								if (targetIdentity === null) {
									this.#warnLegacyFallbackMigration(
										`Settings: config-root workflow migration cannot publish completion because the target directory identity is unavailable; leaving source, backup, and marker pending`,
									);
								} else if (
									typeof marker.targetFileIdentity === "string" &&
									(await this.#targetFileIdentity(target)) !== marker.targetFileIdentity
								) {
									// The marker recorded the FILE that received the migration
									// write; a replaced file is a genuine override, not a
									// migration write - never complete behind it.
									this.#warnLegacyFallbackMigration(
										`Settings: config-root workflow migration target file ${target} was replaced after the migration write; leaving source, backup, and marker pending`,
									);
								} else {
									await this.#writeWorkflowMigrationMarkerAtomic(markerPath, {
										...marker,
										status: "complete",
										priorSourceSha256: undefined,
										repairValueHashes: undefined,
										repairsApplied: undefined,
										preRepairTargetHashes: undefined,
										...targetIdentity,
										completedAt: new Date().toISOString(),
									});
								}
							} else {
								this.#warnLegacyFallbackMigration(
									`Settings: config-root workflow migration pending marker has matching source/backup but the target lacks the migrated keys; leaving source and backup untouched`,
								);
							}
						} else {
							if (backupHash === marker.sourceSha256 && sourceHash !== marker.sourceSha256) {
								// The user EDITED the still-active source after the
								// crash: revert ONLY the marker-owned target values
								// that still match the migration's write (the backup
								// copy); a newer `gjc config set` override is
								// preserved. Remove the backup and the pending marker
								// so the next load re-runs fresh against the edited
								// source.
								let editBackupDoc: Record<string, unknown> | null = null;
								try {
									// Parse the bytes already read and verified above
									// (the branch requires backupHash ===
									// marker.sourceSha256, a subset of the check here).
									editBackupDoc = JSON.parse(pendingBackupRead.text) as Record<string, unknown>;
								} catch {
									this.#warnLegacyFallbackMigration(
										`Settings: could not read the migration backup ${backup} for edited-source recovery; leaving source/backup/marker untouched`,
									);
									return;
								}
								const markerOwnedUnsets: AtomicYamlPatch[] = [];
								const markerFlatKeys: string[] = [];
								for (const key of marker.migratedKeys) {
									const targetValue = extractWorkflowSetting(tx.root, key, { flat: false });
									const migratedValue = extractWorkflowSetting(editBackupDoc, key);
									if (
										targetValue.present &&
										migratedValue.present &&
										this.#coerceWorkflowScalar(key, migratedValue.value) === targetValue.value
									) {
										markerOwnedUnsets.push({ path: key, op: "unset" });
										if (Object.hasOwn(tx.root as Record<string, unknown>, key)) markerFlatKeys.push(key);
									}
								}
								await tx.applyPatchesAndRemoveTopLevelKeys(markerOwnedUnsets, markerFlatKeys);
								await fs.promises.rm(backup, { force: true }).catch(() => undefined);
								await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
								this.#warnLegacyFallbackMigration(
									`Settings: config-root workflow migration pending marker source edited after a crash; stale marker-owned target values reverted, user overrides kept, backup removed, marker cleared`,
								);
							} else {
								this.#warnLegacyFallbackMigration(
									`Settings: config-root workflow migration pending marker has both source and backup with mismatched hashes; leaving untouched`,
								);
							}
						}
						return;
					}
					if (!sourceExists && !backupExists) {
						this.#warnLegacyFallbackMigration(
							`Settings: config-root workflow migration pending marker without source or backup; leaving for diagnosis`,
						);
						return;
					}
					// pending | yes | no — fall through and re-run the idempotent fresh
					// transaction (absent-only patches make re-application harmless).
				} else if (sourceExists && backupExists) {
					// Absent/invalid marker with a pre-existing backup is ambiguous;
					// never consume or overwrite either file.
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration found pre-existing ${backup} without a valid marker; leaving source and backup untouched`,
					);
					return;
				} else if (!sourceExists && backupExists) {
					// Orphan backup: values may already be in the target; keep both
					// recoverable and never infer completion from the backup alone.
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration found orphan backup ${backup} without a marker; leaving it untouched`,
					);
					return;
				} else if (!sourceExists && !backupExists) {
					return;
				}

				// Fresh transaction (or pending | yes | no re-run): source exists,
				// backup absent. All steps run under the target config lock.
				let sourceRaw: string;
				try {
					sourceRaw = await Bun.file(source).text();
				} catch {
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration could not read ${source}; leaving untouched`,
					);
					return;
				}
				const sourceSha256 = createHash("sha256").update(sourceRaw).digest("hex");
				let sourceDoc: unknown;
				try {
					sourceDoc = JSON.parse(sourceRaw);
				} catch {
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration found malformed JSON in ${source}; leaving source/backup/marker unchanged`,
					);
					return;
				}
				// A `null` document root is malformed per the strict resolver (exit
				// 2); the migration must not consume it (empty keys + .bak +
				// complete marker would silently default). Leave the source active
				// so the strict failure stays loud.
				if (
					sourceDoc === null ||
					sourceDoc === undefined ||
					typeof sourceDoc !== "object" ||
					Array.isArray(sourceDoc)
				) {
					// A `null`/non-object root is malformed per the strict resolver
					// (exit 2); the migration must not consume it (empty keys +
					// .bak + complete marker would silently default). Under a
					// changed-pending recovery (crash after the patch, before the
					// backup), clear the stale marker-owned target patches so the
					// malformed source is visible to strict ralplan instead of
					// being shadowed by the old agent value.
					// Only clear patches when a backup verifies they are still the
					// migration write; without one the target values may be newer
					// overrides and must be preserved.
					if (marker?.status === "pending" && backupExists) {
						// A malformed source cannot establish ownership of the target
						// values. Verify and parse the backup bytes that the marker records
						// before clearing anything; a post-crash user override must survive.
						let staleBackupDoc: Record<string, unknown>;
						try {
							const staleBackupRead = await this.#readBackupBytes(backup);
							const staleBackupHash = createHash("sha256")
								.update(Buffer.from(staleBackupRead.bytes))
								.digest("hex");
							if (staleBackupHash !== marker.sourceSha256 && staleBackupHash !== marker.priorSourceSha256) {
								this.#warnLegacyFallbackMigration(
									`Settings: the migration backup ${backup} no longer matches the marker hash; leaving source/backup/marker untouched`,
								);
								return;
							}
							const parsedBackup = JSON.parse(staleBackupRead.text) as unknown;
							if (!parsedBackup || typeof parsedBackup !== "object" || Array.isArray(parsedBackup)) {
								this.#warnLegacyFallbackMigration(
									`Settings: the migration backup ${backup} has a non-mapping root; leaving source/backup/marker untouched`,
								);
								return;
							}
							staleBackupDoc = parsedBackup as Record<string, unknown>;
						} catch {
							this.#warnLegacyFallbackMigration(
								`Settings: could not read the migration backup ${backup} for malformed-source recovery; leaving source/backup/marker untouched`,
							);
							return;
						}
						const staleUnsets: AtomicYamlPatch[] = [];
						const staleFlatKeys: string[] = [];
						for (const key of marker.migratedKeys) {
							const targetValue = extractWorkflowSetting(tx.current, key, { flat: false });
							if (!targetValue.present) continue;
							const backupValue = extractWorkflowSetting(staleBackupDoc, key);
							const targetHash = createHash("sha256").update(JSON.stringify(targetValue.value)).digest("hex");
							const migrationOwned =
								(backupValue.present &&
									this.#coerceWorkflowScalar(key, backupValue.value) === targetValue.value) ||
								(marker.repairsApplied === true &&
									marker.repairValueHashes?.[key] !== undefined &&
									targetHash === marker.repairValueHashes[key]);
							if (!migrationOwned) continue;
							staleUnsets.push({ path: key, op: "unset" });
							if (Object.hasOwn(tx.current as Record<string, unknown>, key)) staleFlatKeys.push(key);
						}
						await tx.applyPatchesAndRemoveTopLevelKeys(staleUnsets, staleFlatKeys);
					}
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration found a malformed root in ${source}; leaving source/backup/marker unchanged`,
					);
					return;
				}
				// A `null`/`~` YAML root is treated by #loadYaml as a malformed
				// config (settings stay read-only until repaired), so the migration
				// must treat it like the other non-object roots: abort without
				// writing or consuming the legacy source.
				if (tx.root !== undefined && (tx.root === null || typeof tx.root !== "object" || Array.isArray(tx.root))) {
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration target ${target} has a non-object or null YAML root; not migrating`,
					);
					return;
				}
				const targetDoc = tx.root === undefined ? {} : (tx.root as Record<string, unknown>);
				const migratedKeys: WorkflowSettingKey[] = [];
				const patches: AtomicYamlPatch[] = [];
				const flatKeysToRemove: string[] = [];
				// A pending marker means a crashed run may have left a STALE patch
				// in the target; if the source changed since that marker, the stale
				// target value must not suppress the key (it would shadow the edit
				// and move it to .bak). Reapply the current source value over it.
				const stalePendingOverride = marker?.status === "pending" && sourceSha256 !== marker.sourceSha256;
				for (const key of CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS) {
					// Only keys the crashed run actually recorded are migration-owned
					// in the changed-pending window: they may be reapplied, unset, or
					// overridden by the current source, but a key the marker did NOT
					// record was skipped because config.yml already held a valid
					// higher-precedence user value, which must never be clobbered.
					const staleMarkerKey = stalePendingOverride && marker?.migratedKeys.includes(key);
					const extracted = extractWorkflowSetting(sourceDoc, key);
					if (extracted.malformedParent) {
						// A non-mapping workflow parent in the source (e.g.
						// `{"gjc":{"ralplan":"broken"}}`) is malformed legacy JSON
						// that strict ralplan must fail on (exit 2); completing the
						// migration would deactivate the source and silently use
						// defaults. Under a changed-pending recovery (crash after
						// the patch), first clear the stale marker-owned target
						// patches so the malformed source is visible to strict
						// ralplan instead of being shadowed by the old agent value.
						// Clear ONLY targets that match a verifiable migration write:
						// the backup (the migration's copy) or a committed repair
						// hash (repairsApplied). A target the user replaced after
						// the crash is a genuine override and must not be cleared
						// merely because the source is now malformed.
						if (marker?.status === "pending") {
							// Hash-verify the backup against the marker BEFORE trusting its
							// contents: an edited/corrupted backup is not evidence of what
							// the migration wrote, and a coincidentally matching override
							// must never be classified as migration-owned.
							let staleBackupDoc: Record<string, unknown> | null = null;
							if (backupExists) {
								try {
									const staleRead = await this.#readBackupBytes(backup);
									const staleHash = createHash("sha256").update(Buffer.from(staleRead.bytes)).digest("hex");
									if (staleHash === marker.sourceSha256 || staleHash === marker.priorSourceSha256) {
										staleBackupDoc = JSON.parse(staleRead.text) as Record<string, unknown>;
									}
								} catch {
									// Unreadable or hash-mismatched backup: cannot verify
									// ownership; leave recovery state untouched.
								}
							}
							const staleUnsets: AtomicYamlPatch[] = [];
							const staleFlatKeys: string[] = [];
							for (const ownedKey of marker.migratedKeys) {
								const ownedValue = extractWorkflowSetting(tx.current, ownedKey, { flat: false });
								if (!ownedValue.present) continue;
								const ownedBackupValue = staleBackupDoc
									? extractWorkflowSetting(staleBackupDoc, ownedKey)
									: { present: false, value: undefined };
								const ownedHash = createHash("sha256").update(JSON.stringify(ownedValue.value)).digest("hex");
								const verifiable =
									(ownedBackupValue.present &&
										this.#coerceWorkflowScalar(ownedKey, ownedBackupValue.value) === ownedValue.value) ||
									(marker.repairsApplied === true &&
										marker.repairValueHashes?.[ownedKey] !== undefined &&
										ownedHash === marker.repairValueHashes[ownedKey]);
								if (verifiable) {
									staleUnsets.push({ path: ownedKey, op: "unset" });
									if (Object.hasOwn(tx.current as Record<string, unknown>, ownedKey)) {
										staleFlatKeys.push(ownedKey);
									}
								}
							}
							await tx.applyPatchesAndRemoveTopLevelKeys(staleUnsets, staleFlatKeys);
						}
						this.#warnLegacyFallbackMigration(
							`Settings: config-root workflow migration aborted: ${source} has a non-mapping parent for ${key}; leaving source/backup/marker unchanged`,
						);
						return;
					}
					if (!extracted.present) {
						// A key the user REMOVED from the source (after a crash that
						// had already patched config.yml) should drop its stale
						// target value, so the deletion is honored. But ownership is
						// verifiable only against the migration's backup copy: in
						// the pending no-backup recovery the target value may be a
						// NEWER `gjc config set` override, so never unset it
						// blindly - leave it and warn.
						if (staleMarkerKey && extractWorkflowSetting(targetDoc, key, { flat: false }).present) {
							if (backupExists) {
								// Only unset a target that STILL matches the migration's
								// write (the hash-verified backup copy or committed repair
								// evidence): a target the user edited after the crash is a
								// genuine override and must not be removed merely because
								// the backup exists.
								const removedKeyTarget = extractWorkflowSetting(targetDoc, key, { flat: false });
								let removedKeyBackupDoc: Record<string, unknown> | null = null;
								try {
									const removedKeyRead = await this.#readBackupBytes(backup);
									const removedKeyHash = createHash("sha256")
										.update(Buffer.from(removedKeyRead.bytes))
										.digest("hex");
									if (
										removedKeyHash === marker?.sourceSha256 ||
										removedKeyHash === marker?.priorSourceSha256
									) {
										removedKeyBackupDoc = JSON.parse(removedKeyRead.text) as Record<string, unknown>;
									}
								} catch {
									// Unreadable or hash-mismatched backup: cannot verify
									// ownership; keep the target value.
								}
								const removedKeyBackupValue = removedKeyBackupDoc
									? extractWorkflowSetting(removedKeyBackupDoc, key)
									: { present: false, value: undefined };
								const removedKeyTargetHash = createHash("sha256")
									.update(JSON.stringify(removedKeyTarget.value))
									.digest("hex");
								const removedKeyVerifiable =
									(removedKeyBackupValue.present &&
										this.#coerceWorkflowScalar(key, removedKeyBackupValue.value) ===
											removedKeyTarget.value) ||
									(marker?.repairsApplied === true &&
										marker?.repairValueHashes?.[key] !== undefined &&
										removedKeyTargetHash === marker?.repairValueHashes[key]);
								if (removedKeyVerifiable) {
									patches.push({ path: key, op: "unset" });
									if (Object.hasOwn(targetDoc, key)) flatKeysToRemove.push(key);
								}
							} else {
								// Ownership is unverifiable: abort the recovery (the
								// source stays active) instead of completing with the
								// key omitted from migratedKeys, which would
								// deactivate the edited source and leave the stale
								// target effective permanently.
								this.#warnLegacyFallbackMigration(
									`Settings: config-root workflow migration aborted: ${key} removed from ${source} but its target value cannot be verified as the migration write (no backup); keeping the source active`,
								);
								return;
							}
						}
						continue;
					}
					// A *valid* present target value for this key wins: the legacy
					// config-root value (valid or not) is never observed by the
					// resolver, so skip this key entirely instead of aborting the
					// whole migration over a stale overridden value (unless the
					// target itself holds a stale patch for a marker-recorded key -
					// see above).
					const targetValue = extractWorkflowSetting(targetDoc, key, { flat: false });
					if (targetValue.malformedParent) {
						// A non-object intermediate in config.yml (e.g.
						// `gjc: { ralplan: "repair-me" }`) is malformed user data
						// that #loadYaml would report for repair; writing the
						// migrated value would silently replace it. Abort and leave
						// everything untouched.
						this.#warnLegacyFallbackMigration(
							`Settings: config-root workflow migration aborted: ${target} has a non-mapping parent for ${key}; leaving source/backup/marker untouched`,
						);
						return;
					}
					if (targetValue.present && this.#workflowKeyValueIsValid(key, targetValue.value)) {
						// A *valid* present target value wins unless the key is a
						// stale marker-owned key under a changed-pending recovery
						// (staleMarkerKey), where the current source value must be
						// reapplied over the stale patch below.
						if (!staleMarkerKey) {
							// Retry (unchanged source) or a genuine user value:
							// still schedule the flat-form cleanup for marker-owned
							// keys so a dotted top-level key left by a crash between
							// applyPatches and removeTopLevelKeys does not keep
							// config.yml rejected by the generated schema - and keep
							// the key in the rebuilt migratedKeys so ownership
							// survives the marker rewrite.
							if (marker?.migratedKeys.includes(key)) {
								// Retain ownership scope across the pre-backup crash window
								// (the target patch committed but the backup move did not):
								// the retry's own move creates the durable backup, and every
								// later unset verifies the target value against that backup,
								// so an editor's DIFFERENT value is never reclaimed.
								if (Object.hasOwn(targetDoc, key)) flatKeysToRemove.push(key);
								if (!migratedKeys.includes(key)) migratedKeys.push(key);
							}
							continue;
						}
					}
					// Validate the legacy value BEFORE migrating it. An invalid
					// tolerant value (e.g. `"gjc.ultragoal.nudgeBudget": "bad"`)
					// must not be copied into the durable config.yml, where
					// Settings.load()/config doctor would report it on every
					// startup (previously the tolerant runtime simply ignored it
					// in settings.json and fell back to the default).
					if (!this.#workflowKeyValueIsValid(key, extracted.value)) {
						if (
							staleMarkerKey &&
							backupExists &&
							extractWorkflowSetting(targetDoc, key, { flat: false }).present
						) {
							// Changed-pending recovery: unset the stale crashed patch
							// for a marker-recorded key so the current source value
							// (valid or invalid, tolerant or strict) is honored -
							// never leave a stale target value shadowing it.
							patches.push({ path: key, op: "unset" });
							if (Object.hasOwn(targetDoc, key)) flatKeysToRemove.push(key);
						}
						// Strict ralplan keys must keep the legacy source active only
						// when the invalid value would actually be the winning layer:
						// consuming it would silently fall back to defaults instead of
						// failing loudly (the strict resolver throws exit 2 on the
						// invalid value). Tolerant keys are simply skipped.
						if (key.startsWith("gjc.ralplan.")) {
							// If the unset above was queued, apply it so the invalid
							// legacy source is visible (exit 2) instead of being
							// shadowed by the stale valid target value.
							if (
								staleMarkerKey &&
								backupExists &&
								extractWorkflowSetting(targetDoc, key, { flat: false }).present
							) {
								patches.push({ path: key, op: "unset" });
								if (Object.hasOwn(targetDoc, key)) flatKeysToRemove.push(key);
							}
							// Apply ALL queued repairs (earlier keys' unsets and this
							// key's unset) before aborting, so no stale target value
							// for any marker-recorded key survives in config.yml.
							// Only under a changed-pending recovery: in a FRESH
							// migration the queued patches are plain SETs for valid
							// keys, and applying them on an abort would write
							// un-marker'd partial artifacts that the target-wins
							// rule would freeze.
							if (stalePendingOverride) {
								// Apply only MARKER-OWNED repairs: fresh SETs for
								// unrecorded keys must not be committed on an abort
								// (the marker does not own them; committing would
								// shadow later source edits forever via the
								// valid-target guard).
								const repairPatches = patches.filter(patch =>
									marker?.migratedKeys.includes(patch.path as WorkflowSettingKey),
								);
								const repairFlatKeys = flatKeysToRemove.filter(key =>
									marker?.migratedKeys.includes(key as WorkflowSettingKey),
								);
								// One atomic write for the repairs + flat cleanup.
								if (repairPatches.length > 0 || repairFlatKeys.length > 0) {
									await tx.applyPatchesAndRemoveTopLevelKeys(repairPatches, repairFlatKeys);
								}
							}
							this.#warnLegacyFallbackMigration(
								`Settings: config-root workflow migration aborted: invalid strict ralplan value for ${key} in ${source}; keeping the legacy source active so gjc ralplan still fails loudly`,
							);
							return;
						}
						continue;
					}
					// The changed-pending REAPPLY overwrites a present target value;
					// without a backup the migration write is unverifiable and the
					// target may be an editor's newer value. Abort the recovery
					// (keeping the source active) instead of completing with the
					// key omitted from migratedKeys, which would deactivate the
					// edited source and leave the stale target effective forever.
					if (stalePendingOverride && marker?.migratedKeys.includes(key) && targetValue.present && !backupExists) {
						this.#warnLegacyFallbackMigration(
							`Settings: config-root workflow migration aborted: ${key} reapplied by the source but its target value cannot be verified as the migration write (no backup); keeping the source active`,
						);
						return;
					}
					migratedKeys.push(key);
					// Persist the COERCED value (quoted numeric string -> number), not
					// the raw string: a schema-backed config.yml must hold values the
					// generated JSON schema accepts and Settings does not need to
					// re-coerce on every load.
					patches.push({ path: key, op: "set", value: this.#coerceWorkflowScalar(key, extracted.value) });
					// Flat keys are checked before nested ones by
					// extractWorkflowSetting, so an invalid flat key (e.g.
					// `"gjc.ralplan.maxIterations": bad`) would keep masking the
					// migrated nested value after the legacy source is moved to .bak.
					// Remove the flat form verbatim (the patch grammar cannot address
					// dotted top-level key names).
					if (Object.hasOwn(targetDoc, key)) flatKeysToRemove.push(key);
				}

				// An invalid/untrusted marker must never suppress migration. Preserve
				// its bytes by a no-clobber quarantine; abort if quarantine is
				// impossible. (A malformed marker parses to null, so the file's
				// existence is the signal, not a non-null marker object.)
				if (markerFileExists && marker === null) {
					const corruptPath = `${markerPath}.corrupt`;
					if (!(await this.#moveLegacySourceNoReplace(markerPath, corruptPath))) {
						this.#warnLegacyFallbackMigration(
							`Settings: config-root workflow migration could not quarantine invalid marker ${markerPath}; leaving unchanged`,
						);
						return;
					}
				}

				const startedAt =
					marker?.status === "pending" && typeof marker.startedAt === "string"
						? marker.startedAt
						: new Date().toISOString();
				// The pending marker is the ownership record if this run crashes
				// after the target patch; bind it to the directory that will
				// receive the write so a later replacement profile can never
				// inherit its ownership claims.
				const pendingTargetIdentity = await this.#workflowMigrationTargetIdentity(target);
				if (pendingTargetIdentity === null) {
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration cannot verify target directory ${path.dirname(target)} before the pending write; leaving source and marker untouched`,
					);
					return;
				}
				await this.#writeWorkflowMigrationMarkerAtomic(markerPath, {
					version: WORKFLOW_MIGRATION_MARKER_VERSION,
					status: "pending",
					sourcePath: source,
					backupPath: backup,
					targetPath: target,
					...pendingTargetIdentity,
					sourceSha256,
					migratedKeys,
					startedAt,
				});
				pendingMarkerWritten = true;

				// The legacy source may have been edited since `sourceSha256` was
				// computed and the patches built. Re-hash BEFORE writing anything so
				// a stale patch never lands in the higher-precedence config.yml,
				// and snapshot the target so a late mismatch can revert it.
				if ((await this.#sha256File(source)) !== sourceSha256) {
					// Nothing was patched by THIS run: the pending marker's
					// migratedKeys would falsely claim ownership of these patches
					// on the next changed-pending recovery (staleMarkerKey),
					// letting it overwrite a valid user target override. Remove it
					// so the next load starts fresh - but ONLY when no marker
					// existed before this run: a PRIOR run that already patched
					// config.yml left that marker as the only evidence its target
					// values are migration-written, so it must be retained.
					if (!marker) {
						await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
					}
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration aborted: ${source} changed during migration; marker ${marker ? "retained" : "cleared"}, source left active for the next load`,
					);
					return;
				}
				const targetIdentityBeforePatch = await this.#workflowMigrationTargetIdentity(target);
				if (targetIdentityBeforePatch === null) {
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration cannot verify target directory ${path.dirname(target)} before patch; leaving source and marker pending`,
					);
					return;
				}
				const prePatchTargetSnapshot = structuredClone(tx.current);
				// Apply the nested patches AND the flat-form cleanup in a single
				// atomic write: two separate writes would let an external editor's
				// config.yml change (which does not participate in the file lock)
				// land between them and be overwritten.
				await tx.applyPatchesAndRemoveTopLevelKeys(patches, flatKeysToRemove);
				targetPatchCommitted = true;
				// Capture the identity of the config.yml FILE this write produced.
				// An external editor atomically replacing the file after this point
				// yields a NEW inode; completion must reject that replacement instead
				// of publishing ownership for a value the migration never wrote.
				const targetFileIdentityAfterPatch = await this.#targetFileIdentity(target);
				if (targetFileIdentityAfterPatch === null) {
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration could not verify the patched target file ${target}; leaving source, backup, and marker pending`,
					);
					return;
				}

				// Re-hash immediately before the no-replace move; on mismatch, revert
				// the target to its pre-patch state so the next load re-runs against
				// the current file instead of resolving a stale agent-config value.
				let preMoveSourceHash: string | null = null;
				try {
					preMoveSourceHash = await this.#sha256File(source);
				} catch {
					// The source was deleted after the patch: revert the target and
					// clear the now-obsolete marker so the deletion is honored (the
					// later post-copy deletion path does the same).
					await tx.replaceCurrent(prePatchTargetSnapshot);
					if (backupCreatedByThisRun) await fs.promises.rm(backup, { force: true }).catch(() => undefined);
					await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration aborted: ${source} was deleted during migration; target reverted, ${backupCreatedByThisRun ? "backup removed" : "external backup preserved"}, marker cleared`,
					);
					return;
				}
				if (preMoveSourceHash !== sourceSha256) {
					await tx.replaceCurrent(prePatchTargetSnapshot);
					if (backupCreatedByThisRun) await fs.promises.rm(backup, { force: true }).catch(() => undefined);
					await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration aborted: ${source} changed during migration; target reverted, ${backupCreatedByThisRun ? "backup removed" : "external backup preserved"}, marker cleared`,
					);
					return;
				}
				if (!(await this.#moveLegacySourceNoReplace(source, backup, sourceSha256))) {
					// The target was already patched; revert it so the higher
					// precedence config.yml does not shadow the still-active source
					// (a `.bak` that appeared in the window would otherwise leave
					// the pending yes/yes recovery row warning on mismatch forever).
					await tx.replaceCurrent(prePatchTargetSnapshot);
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration could not move ${source} to ${backup} without overwrite; target reverted, pending marker retained for retry`,
					);
					return;
				}
				backupCreatedByThisRun = true;

				// The source may have been edited in the narrow window after the
				// pre-move check but before/during the move; verify the bytes we
				// actually moved. The source is kept ACTIVE on every path, so on
				// mismatch the edit is already live: revert the target and remove
				// the now-superseded backup so the next load sees pending + source
				// + no backup and re-runs the fresh transaction against the edited
				// file (never completing behind a stale hash).
				if ((await this.#sha256File(backup)) !== sourceSha256) {
					await tx.replaceCurrent(prePatchTargetSnapshot);
					if (backupCreatedByThisRun) await fs.promises.rm(backup, { force: true }).catch(() => undefined);
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration aborted: ${source} changed during migration; target reverted, backup removed, source left active for the next load`,
					);
					return;
				}
				// On the copy fallback (filesystems without hard links) the source
				// is deliberately kept ACTIVE, so a same-key edit after the copy is
				// shadowed by the higher-precedence patched config.yml; verify the
				// source (absent = externally deleted) and revert on
				// mismatch, removing the now-superseded backup so the next load
				// sees pending + source + no backup and re-runs the fresh
				// transaction against the edited file.
				let sourceHashAfterMove: string | null = null;
				try {
					sourceHashAfterMove = await this.#sha256File(source);
				} catch (error) {
					// The source is kept ACTIVE on every path, so ENOENT can only be
					// a concurrent DELETION of the legacy file: honor it by undoing
					// the patch and backup and clearing the pending marker (there is
					// nothing left to migrate), instead of completing behind the old
					// values and silently undoing the deletion.
					if (isEnoent(error)) {
						await tx.replaceCurrent(prePatchTargetSnapshot);
						if (backupCreatedByThisRun) await fs.promises.rm(backup, { force: true }).catch(() => undefined);
						await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
						this.#warnLegacyFallbackMigration(
							`Settings: config-root workflow migration aborted: ${source} was deleted during migration; target reverted, backup removed, marker cleared`,
						);
						return;
					}
					// Non-ENOENT read failure: fail closed (revert + retain
					// pending) rather than completing behind a possibly-edited
					// source.
					await tx.replaceCurrent(prePatchTargetSnapshot);
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration aborted: could not re-read ${source} after the move; target reverted, pending marker retained`,
					);
					return;
				}
				if (sourceHashAfterMove !== null && sourceHashAfterMove !== sourceSha256) {
					await tx.replaceCurrent(prePatchTargetSnapshot);
					if (backupCreatedByThisRun) await fs.promises.rm(backup, { force: true }).catch(() => undefined);
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration aborted: ${source} edited after the copy; target reverted, backup removed, source left active for the next load`,
					);
					return;
				}

				const targetIdentity = await this.#workflowMigrationTargetIdentity(target, targetIdentityBeforePatch);
				if (targetIdentity === null) {
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration target directory changed after patch; leaving source, backup, and marker pending`,
					);
					return;
				}
				if ((await this.#targetFileIdentity(target)) !== targetFileIdentityAfterPatch) {
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration target file ${target} was replaced after the patch; leaving source, backup, and marker pending`,
					);
					return;
				}
				await this.#writeWorkflowMigrationMarkerAtomic(markerPath, {
					version: WORKFLOW_MIGRATION_MARKER_VERSION,
					status: "complete",
					sourcePath: source,
					backupPath: backup,
					targetPath: target,
					...targetIdentity,
					targetFileIdentity: targetFileIdentityAfterPatch,
					sourceSha256,
					migratedKeys,
					startedAt,
					completedAt: new Date().toISOString(),
				});
				logger.debug("Settings: migrated config-root workflow settings to config.yml", {
					source,
					target,
					migratedKeys,
				});
			});
		} catch (error) {
			// A CAS rejection means an external editor changed config.yml before
			// any patch of this run applied: a pending marker's migratedKeys
			// would falsely claim ownership of never-applied patches, so clear it
			// A CAS rejection means an external editor changed config.yml before a
			// write of THIS run applied. The pending marker is RETAINED: in a
			// changed-pending recovery the prior run already patched config.yml
			// and the marker is the only evidence that the existing target value
			// is migration-written - clearing it would let the stale value pass
			// the valid-target guard and complete with the key omitted. (A
			// retained marker whose claims were never applied is handled safely
			// by the unverifiable-ownership abort, which keeps the source active.)
			if (error instanceof AtomicYamlConflictError) {
				// A fresh migration wrote its pending marker but an external editor
				// changed config.yml before the target patch: nothing was applied,
				// so the marker's migratedKeys must not claim ownership of
				// never-applied writes (a retry would otherwise record the editor's
				// matching value as migration-owned). Clear it; a PRIOR run's marker
				// (preMarkerExists) or a committed target write stays as ownership
				// evidence for the changed-pending recovery.
				if (pendingMarkerWritten && !targetPatchCommitted && !preMarkerExists) {
					await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration aborted: ${target} changed externally before the target write; unapplied pending marker cleared`,
					);
				} else {
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration aborted: ${target} changed externally during migration; pending marker retained`,
					);
				}
				return;
			}
			// A malformed target config.yml must not abort settings load: warn and
			// leave source/backup/marker untouched so #loadYaml's recoverable
			// malformed-config diagnostics still run after the migration returns.
			this.#warnLegacyFallbackMigration(
				`Settings: config-root workflow migration could not run against ${target}: ${error instanceof Error ? error.message : String(error)}; leaving source/backup/marker untouched`,
			);
		}
	}

	async #reconcileMigratedSource(params: {
		tx: AtomicYamlConfigTransaction;
		marker: WorkflowMigrationMarker;
		source: string;
		backup: string;
		markerPath: string;
		target: string;
		currentSourceHash: string;
	}): Promise<void> {
		let { tx, marker, source, backup, markerPath, target, currentSourceHash } = params;
		// The source changed after completion: validate its root before
		// reconciling - a malformed root (null/array) must not be
		// accepted as a settings mapping (strict ralplan fails on it).
		let currentSourceText: string;
		try {
			currentSourceText = await Bun.file(source).text();
			// Bind the marker hash to the bytes ACTUALLY read (the editor
			// may have saved between the earlier #sha256File and this
			// read): the backup and marker must describe the same text.
			currentSourceHash = createHash("sha256").update(currentSourceText).digest("hex");
		} catch (error) {
			// Only a DELETED source (ENOENT) is left untouched; a transient
			// EACCES/EIO read failure propagates so the recovery never
			// misreads the source state.
			if (!isEnoent(error)) throw error;
			this.#warnLegacyFallbackMigration(
				`Settings: could not read ${source} for re-migration; leaving source/backup/marker untouched`,
			);
			return;
		}
		let currentSourceDoc: Record<string, unknown>;
		try {
			const parsed = JSON.parse(currentSourceText) as unknown;
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				this.#warnLegacyFallbackMigration(
					`Settings: ${source} changed after migration to a non-mapping root; leaving source/backup/marker untouched (strict ralplan fails on it)`,
				);
				return;
			}
			currentSourceDoc = parsed as Record<string, unknown>;
		} catch {
			this.#warnLegacyFallbackMigration(
				`Settings: could not parse ${source} for re-migration; leaving source/backup/marker untouched`,
			);
			return;
		}
		let backupDoc: Record<string, unknown> | null = null;
		try {
			// The backup must hash to the marker's sourceSha256 (the OLD
			// ownership basis after refresh) OR to the marker's priorSourceSha256
			// (the migration-write basis when the reconcile is resumed before its
			// backup refresh). Accepting an arbitrary refreshed backup would let
			// an interrupted refresh reclassify a user's target override as
			// migration-owned; only these two recorded hashes are accepted.
			const reconcileBackupRaw = await Bun.file(backup).arrayBuffer();
			const reconcileBackupHash = createHash("sha256").update(Buffer.from(reconcileBackupRaw)).digest("hex");
			if (reconcileBackupHash !== marker.sourceSha256 && reconcileBackupHash !== marker.priorSourceSha256) {
				this.#warnLegacyFallbackMigration(
					`Settings: the migration backup ${backup} no longer matches the marker hash; leaving source/backup/marker untouched`,
				);
				return;
			}
			// Parse the SAME bytes that were verified (a second read could observe
			// a different revision).
			backupDoc = JSON.parse(Buffer.from(reconcileBackupRaw).toString("utf8")) as Record<string, unknown>;
		} catch {
			// No usable backup: cannot verify what the migration wrote;
			// leave everything unchanged.
			this.#warnLegacyFallbackMigration(
				`Settings: could not read the migration backup ${backup}; leaving source/backup/marker untouched`,
			);
			return;
		}
		// Reconcile EVERY supported workflow key: marker-recorded keys
		// (only when the target still matches the migration's write) and
		// keys newly added to the source after completion (copied when
		// the target has no value for them).
		const repairPatches: AtomicYamlPatch[] = [];
		const newlyPropagatedKeys: WorkflowSettingKey[] = [];
		// Marker-owned keys whose target STILL matches the old migration
		// write (the backup): a target the user changed after migration
		// loses migration ownership.
		const retainedOwnedKeys: WorkflowSettingKey[] = [];
		const repairFlatKeys: string[] = [];
		for (const key of CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS) {
			const sourceValue = extractWorkflowSetting(currentSourceDoc, key);
			if (sourceValue.malformedParent) {
				// A non-mapping workflow parent (e.g. `gjc.ralplan:
				// "broken"`) hides EVERY sibling under it, so strict
				// ralplan must fail on the malformed explicit source.
				// Clear ALL marker-owned targets under the malformed
				// parent prefix that still match the migration's write,
				// and DROP the accumulated repairs (they were never
				// committed, so committing them here would leave
				// ownership evidence inconsistent).
				const malformedPrefix = key.split(".").slice(0, -1).join(".");
				const malformedUnsets: AtomicYamlPatch[] = [];
				const malformedFlatKeys: string[] = [];
				for (const ownedKey of marker.migratedKeys) {
					if (!ownedKey.startsWith(`${malformedPrefix}.`) && ownedKey !== malformedPrefix) continue;
					const staleTarget = extractWorkflowSetting(tx.root, ownedKey, { flat: false });
					const backupVal = extractWorkflowSetting(backupDoc, ownedKey);
					if (
						staleTarget.present &&
						backupVal.present &&
						this.#coerceWorkflowScalar(ownedKey, backupVal.value) === staleTarget.value
					) {
						malformedUnsets.push({ path: ownedKey, op: "unset" });
						if (Object.hasOwn(tx.root as Record<string, unknown>, ownedKey)) {
							malformedFlatKeys.push(ownedKey);
						}
					}
				}
				if (malformedUnsets.length > 0 || malformedFlatKeys.length > 0) {
					await tx.applyPatchesAndRemoveTopLevelKeys(malformedUnsets, malformedFlatKeys);
				}
				this.#warnLegacyFallbackMigration(
					`Settings: ${source} has a non-mapping parent for ${key} after migration; stale marker-owned values cleared, source/backup/marker left active (strict ralplan fails on it)`,
				);
				return;
			}
			const markerRecorded = marker.migratedKeys.includes(key);
			const targetValue = extractWorkflowSetting(tx.root, key, { flat: false });
			const migratedValue = markerRecorded
				? extractWorkflowSetting(backupDoc, key)
				: { present: false, value: undefined };
			const targetIsMigrationWrite =
				markerRecorded &&
				targetValue.present &&
				// The reconcile's own write is proven by the recorded repair value
				// (repairValueHashes) or the migration-write backup - NOT by
				// equality with the CURRENT source, which a later source edit or a
				// coincidental user value could match.
				((migratedValue.present && this.#coerceWorkflowScalar(key, migratedValue.value) === targetValue.value) ||
					// A target matching a value an interrupted reconcile recorded
					// (repairValueHashes) is its own write ONLY when the post-apply
					// flag is set: a target that merely CHANGED from the pre-repair
					// state could be a coincidental user value (an external
					// `gjc config set` before the repair's CAS), so the change
					// alone does not prove the reconcile wrote it.
					(marker.repairValueHashes?.[key] !== undefined &&
						createHash("sha256").update(JSON.stringify(targetValue.value)).digest("hex") ===
							marker.repairValueHashes[key] &&
						marker.repairsApplied === true));
			if (targetIsMigrationWrite) retainedOwnedKeys.push(key);
			if (sourceValue.present) {
				// Never copy an invalid edited value into config.yml. For
				// a STRICT ralplan key, also clear the stale
				// migration-write target so the invalid source is visible
				// to strict ralplan (exit 2) instead of being shadowed;
				// tolerant keys keep the migration-write (the tolerant
				// runtime ignores the invalid value and falls back).
				if (!this.#workflowKeyValueIsValid(key, sourceValue.value)) {
					if (key.startsWith("gjc.ralplan.") && targetIsMigrationWrite) {
						const clearKeys = Object.hasOwn(tx.root as Record<string, unknown>, key) ? [key] : [];
						await tx.applyPatchesAndRemoveTopLevelKeys([{ path: key, op: "unset" }], clearKeys);
					}
					this.#warnLegacyFallbackMigration(
						`Settings: ${source} has an invalid value for ${key} after migration; leaving source/backup/marker untouched (strict ralplan fails on it)`,
					);
					return;
				}
				// Copy when the target still holds the migration write, or
				// when the key was never migrated / is absent from the
				// target. A target value that merely EQUALS the source is
				// not reclaimed as migration-owned (it may be a user
				// override that happens to match).
				if (targetIsMigrationWrite || !targetValue.present) {
					// A stale migration-write (reapply the current source
					// value), a NEWLY ADDED key with no target value, or a
					// deleted-and-readded key (target absent again) all
					// copy the current source value. A marker-recorded key
					// copied back into an absent target REMAINS owned.
					if (markerRecorded) retainedOwnedKeys.push(key);
					repairPatches.push({
						path: key,
						op: "set",
						value: this.#coerceWorkflowScalar(key, sourceValue.value),
					});
					if (Object.hasOwn(tx.root as Record<string, unknown>, key)) repairFlatKeys.push(key);
					if (!markerRecorded) newlyPropagatedKeys.push(key);
				}
				// else: the user edited the target; keep it.
			} else if (targetIsMigrationWrite && targetValue.present) {
				// The user removed the key from the source AND the
				// target still holds the migration's value: honor the
				// deletion.
				repairPatches.push({ path: key, op: "unset" });
				if (Object.hasOwn(tx.root as Record<string, unknown>, key)) repairFlatKeys.push(key);
			}
		}
		// Record the reconcile in a PENDING marker FIRST (new hash + keys +
		// the written repair values): a crash or backup failure between here
		// and the COMPLETE marker leaves a pending state that the next load
		// resumes, so ownership of the reconcile-copied keys survives partial
		// writes - and the resume can recognize a target matching a recorded
		// repair value even after a further source edit.
		const repairValueHashes: Record<string, string> = {};
		for (const patch of repairPatches) {
			if (patch.op === "set") {
				repairValueHashes[patch.path] = createHash("sha256").update(JSON.stringify(patch.value)).digest("hex");
			}
		}
		// The prior basis must be the DURABLE backup hash (a resumed pass's
		// marker.sourceSha256 may describe a source the backup never saw).
		// The target BEFORE the repairs is the durable basis for recognizing a
		// committed repair when the post-apply marker rewrite is not reached.
		// Record pre-repair evidence for EVERY repair patch: newly propagated
		// and re-added keys are absent before the apply, so they get an explicit
		// absent sentinel - any present target then proves the repair committed.
		const preRepairTargetHashes: Record<string, string> = {};
		for (const patch of repairPatches) {
			if (patch.op !== "set") continue;
			const preRepairValue = extractWorkflowSetting(tx.current, patch.path as WorkflowSettingKey, { flat: false });
			preRepairTargetHashes[patch.path] = preRepairValue.present
				? createHash("sha256").update(JSON.stringify(preRepairValue.value)).digest("hex")
				: "absent";
		}
		const durableBackupHash = await this.#sha256File(backup);
		// Pre-apply state: repair hashes describe the PROPOSED write but are not
		// ownership evidence yet. A crash here must leave a matching external
		// user value as a genuine override, not claim that this reconcile wrote it.
		// The marker is rewritten with repairsApplied only after the target CAS
		// write succeeds.
		const pendingRepairMarker: WorkflowMigrationMarker = {
			...marker,
			status: "pending",
			priorSourceSha256: durableBackupHash,
			preRepairTargetHashes,
			repairValueHashes,
			repairsApplied: false,
			sourceSha256: currentSourceHash,
			migratedKeys: [...new Set([...retainedOwnedKeys, ...newlyPropagatedKeys])],
			// The repairs REWRITE config.yml (a new inode), so the pre-reconcile
			// complete marker's targetFileIdentity is stale from this point on.
			// Clear it: a crash-and-resume must not compare the repaired file
			// against the pre-reconcile inode (which would deadlock the migration
			// in a permanent pending state). The completion below captures a
			// FRESH file identity after the repairs.
			targetFileIdentity: undefined,
		};
		await this.#writeWorkflowMigrationMarkerAtomic(markerPath, pendingRepairMarker);
		// Capture the target identity BEFORE applying the repairs: the completion
		// marker below must describe the directory that actually received the
		// reconcile write, never a repointed successor (the native CAS protects
		// only the write itself).
		const reconcileTargetIdentityBeforeRepair = await this.#workflowMigrationTargetIdentity(target);
		if (reconcileTargetIdentityBeforeRepair === null) {
			this.#warnLegacyFallbackMigration(
				`Settings: config-root workflow migration cannot verify target directory ${path.dirname(target)} before reconcile repairs; leaving source/backup/marker pending`,
			);
			return;
		}
		// Snapshot the target before the repairs so they can be rolled
		// back if the source changes again before publication.
		const preRepairTargetSnapshot = structuredClone(tx.current);
		if (repairPatches.length > 0 || repairFlatKeys.length > 0) {
			try {
				await tx.applyPatchesAndRemoveTopLevelKeys(repairPatches, repairFlatKeys);
			} catch (error) {
				// The apply was rejected (CAS): proposed repair hashes remain
				// non-owning, so a coincidental user value is never reclaimed.
				throw error;
			}
			// Publish ownership only after the durable target apply. A crash
			// before this rewrite leaves repairsApplied false, deliberately
			// favoring a genuine user override over unproven migration ownership.
			await this.#writeWorkflowMigrationMarkerAtomic(markerPath, {
				...pendingRepairMarker,
				repairsApplied: true,
			});
		}
		// Bind completion to the target FILE this run's repairs produced: the
		// repair apply rewrites config.yml (a new inode), so capture the identity
		// AFTER it; an editor atomically saving the file later yields yet another
		// inode that must not be published as migration-owned.
		const reconcileTargetFileIdentityAfterRepair = await this.#targetFileIdentity(target);
		if (reconcileTargetFileIdentityAfterRepair === null) {
			this.#warnLegacyFallbackMigration(
				`Settings: config-root workflow migration cannot verify target file ${target} after reconcile repairs; leaving source/backup/marker pending`,
			);
			return;
		}
		// The editor may have saved again during the reconcile: only
		// publish when the source still holds the exact bytes we
		// reconciled and hashed.
		let finalSourceText: string;
		try {
			finalSourceText = await Bun.file(source).text();
		} catch {
			// Roll back the just-applied repairs so the target does not
			// hold an intermediate value classified as a user override.
			await tx.replaceCurrent(preRepairTargetSnapshot);
			// The repairs were rolled back: clear the recorded repair evidence so
			// a later load does not treat the (now reverted) target values as
			// committed writes.
			await this.#writeWorkflowMigrationMarkerAtomic(markerPath, {
				...marker,
				status: "pending",
				priorSourceSha256: durableBackupHash,
				repairValueHashes: undefined,
				repairsApplied: undefined,
				preRepairTargetHashes: undefined,
				sourceSha256: currentSourceHash,
				migratedKeys: [...new Set([...retainedOwnedKeys, ...newlyPropagatedKeys])],
			});
			this.#warnLegacyFallbackMigration(
				`Settings: could not re-read ${source} before publishing the reconciliation; target repairs rolled back, leaving source/backup/marker untouched`,
			);
			return;
		}
		if (finalSourceText !== currentSourceText) {
			// Roll back the just-applied repairs: the next load must
			// re-reconcile against the NEW source without the target
			// holding an intermediate value classified as a user
			// override.
			await tx.replaceCurrent(preRepairTargetSnapshot);
			// Clear the recorded repair evidence (the repairs were rolled back).
			await this.#writeWorkflowMigrationMarkerAtomic(markerPath, {
				...marker,
				status: "pending",
				priorSourceSha256: durableBackupHash,
				repairValueHashes: undefined,
				repairsApplied: undefined,
				preRepairTargetHashes: undefined,
				sourceSha256: currentSourceHash,
				migratedKeys: [...new Set([...retainedOwnedKeys, ...newlyPropagatedKeys])],
			});
			this.#warnLegacyFallbackMigration(
				`Settings: ${source} changed again during reconciliation; target repairs rolled back (the next load re-reconciles)`,
			);
			return;
		}
		// REFRESH the backup to the current source (the new
		// migration-write basis), then publish the COMPLETE marker only
		// after both durable writes succeed - a crash or CAS rejection
		// before that leaves the OLD complete marker, so the next load
		// re-enters the reconcile (source hash mismatch) instead of
		// deactivating the legacy layer over an un-reconciled target.
		// Replace the backup atomically (write a temp, then rename): an
		// in-place Bun.write could truncate it on a crash, leaving the
		// old marker with an unverifiable backup.
		const backupDir = path.dirname(backup);
		const backupTemp = path.join(backupDir, `.${path.basename(backup)}.${process.pid}.${randomUUID()}.tmp`);
		try {
			// Owner-only (0o600): the refreshed backup holds the FULL legacy
			// settings document, and a 022 umask would otherwise give the renamed
			// .bak world-readable permissions even when the source was 0600.
			const backupTempHandle = await fs.promises.open(backupTemp, "w", 0o600);
			try {
				await backupTempHandle.writeFile(currentSourceText, "utf8");
				// Durable before the rename: a host crash or power loss after the
				// complete marker must not leave a marker pointing at a missing or
				// stale backup.
				await backupTempHandle.sync();
			} finally {
				await backupTempHandle.close();
			}
			await fs.promises.rename(backupTemp, backup);
		} finally {
			await fs.promises.rm(backupTemp, { force: true }).catch(() => undefined);
		}
		const targetIdentity = await this.#workflowMigrationTargetIdentity(target, reconcileTargetIdentityBeforeRepair);
		if (targetIdentity === null) {
			this.#warnLegacyFallbackMigration(
				`Settings: config-root workflow migration target directory changed during reconciliation; leaving source, backup, and marker pending`,
			);
			return;
		}
		if ((await this.#targetFileIdentity(target)) !== reconcileTargetFileIdentityAfterRepair) {
			this.#warnLegacyFallbackMigration(
				`Settings: config-root workflow migration target file ${target} was replaced during reconciliation; leaving source, backup, and marker pending`,
			);
			return;
		}
		await this.#writeWorkflowMigrationMarkerAtomic(markerPath, {
			...marker,
			// The resume enters with a pending marker; the repairs and backup
			// refresh succeeded, so publish COMPLETE.
			status: "complete",
			priorSourceSha256: undefined,
			repairValueHashes: undefined,
			repairsApplied: undefined,
			preRepairTargetHashes: undefined,
			...targetIdentity,
			targetFileIdentity: reconcileTargetFileIdentityAfterRepair,
			sourceSha256: currentSourceHash,
			migratedKeys: [...new Set([...retainedOwnedKeys, ...newlyPropagatedKeys])],
			completedAt: new Date().toISOString(),
		});
		this.#warnLegacyFallbackMigration(
			`Settings: config-root workflow settings changed after migration (${source}); reconciled the current values`,
		);
		return;
	}

	/** Read a backup once and return both its bytes and text so the caller can
	 * verify the hash and parse the SAME bytes (a second read could observe a
	 * different revision). */
	async #readBackupBytes(backup: string): Promise<{ bytes: ArrayBuffer; text: string }> {
		const bytes = await Bun.file(backup).arrayBuffer();
		return { bytes, text: Buffer.from(bytes).toString("utf8") };
	}

	async #statIdentity(filePath: string): Promise<string | undefined> {
		const st = await fs.promises.stat(filePath).catch(() => null);
		return st ? `${st.dev}:${st.ino}` : undefined;
	}

	async #targetFileIdentity(target: string): Promise<string | null> {
		const identity = await this.#statIdentity(target);
		return identity ?? null;
	}

	async #workflowMigrationTargetIdentity(
		target: string,
		expected?: { canonicalTargetDir: string; canonicalTargetIdentity: string },
	): Promise<{ canonicalTargetDir: string; canonicalTargetIdentity: string } | null> {
		const targetDir = path.dirname(target);
		const canonicalTargetDir = await fs.promises.realpath(targetDir).catch(() => null);
		if (canonicalTargetDir === null) return null;
		const canonicalTargetIdentity = await this.#statIdentity(targetDir);
		if (canonicalTargetIdentity === undefined) return null;
		if (
			expected &&
			(canonicalTargetDir !== expected.canonicalTargetDir ||
				canonicalTargetIdentity !== expected.canonicalTargetIdentity)
		) {
			return null;
		}
		return { canonicalTargetDir, canonicalTargetIdentity };
	}

	#isDefaultGlobalAgentScope(): boolean {
		return (
			path.resolve(this.#agentDir) === path.resolve(getAgentDir()) &&
			path.resolve(getAgentDir()) === path.resolve(path.join(getConfigRootDir(), "agent"))
		);
	}

	#workflowMigrationTargetSatisfies(root: unknown, marker: WorkflowMigrationMarker): boolean {
		if (root === undefined || root === null) return marker.migratedKeys.length === 0;
		if (typeof root !== "object" || Array.isArray(root)) return false;
		const doc = root as Record<string, unknown>;
		return marker.migratedKeys.every(key => extractWorkflowSetting(doc, key, { flat: false }).present);
	}
	#workflowKeyValueIsValid(key: WorkflowSettingKey, value: unknown): boolean {
		const def = SETTINGS_SCHEMA[key] as
			| { type?: string; validate?: (value: number) => boolean; values?: readonly unknown[] }
			| undefined;
		if (!def) return true;
		let candidate: unknown = value;
		candidate = this.#coerceWorkflowScalar(key, candidate);
		switch (def.type) {
			case "enum":
				return def.values !== undefined && def.values.includes(candidate);
			case "number":
				return def.validate !== undefined
					? def.validate(candidate as number)
					: typeof candidate === "number" && Number.isFinite(candidate);
			case "boolean":
				return typeof candidate === "boolean";
			case "string":
				return typeof candidate === "string";
			default:
				return true;
		}
	}
	#workflowMigrationMarkerPathsMatch(
		marker: WorkflowMigrationMarker,
		source: string,
		backup: string,
		target: string,
	): boolean {
		return (
			path.resolve(marker.sourcePath) === path.resolve(source) &&
			path.resolve(marker.backupPath) === path.resolve(backup) &&
			path.resolve(marker.targetPath) === path.resolve(target)
		);
	}
	/**
	 * Mirror the resolver/Settings scalar coercion for a workflow key: a quoted
	 * numeric string for a number setting (e.g. `maxIterations: "9"`) becomes
	 * the number 9. Used both for validity checks and for what the migration
	 * persists into config.yml.
	 */
	#coerceWorkflowScalar(key: WorkflowSettingKey, value: unknown): unknown {
		const def = SETTINGS_SCHEMA[key] as { type?: string } | undefined;
		if (
			def?.type === "number" &&
			typeof value === "string" &&
			value.trim() !== "" &&
			Number.isFinite(Number(value))
		) {
			return Number(value);
		}
		return value;
	}

	async #readWorkflowMigrationMarker(markerPath: string): Promise<WorkflowMigrationMarker | null> {
		let raw: string;
		try {
			raw = await Bun.file(markerPath).text();
		} catch (error) {
			// Only ENOENT means no marker; a transient EACCES/EIO read failure
			// must propagate so a valid pending marker is never quarantined as
			// corrupt and its ownership evidence lost.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			if (parsed.version !== WORKFLOW_MIGRATION_MARKER_VERSION) return null;
			if (parsed.status !== "pending" && parsed.status !== "complete") return null;
			if (
				typeof parsed.sourcePath !== "string" ||
				typeof parsed.backupPath !== "string" ||
				typeof parsed.targetPath !== "string" ||
				typeof parsed.sourceSha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(parsed.sourceSha256) ||
				typeof parsed.startedAt !== "string" ||
				Number.isNaN(Date.parse(parsed.startedAt)) ||
				!Array.isArray(parsed.migratedKeys) ||
				!parsed.migratedKeys.every(
					key =>
						typeof key === "string" && (CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS as readonly string[]).includes(key),
				)
			) {
				return null;
			}
			if (
				parsed.status === "complete" &&
				(typeof parsed.completedAt !== "string" || Number.isNaN(Date.parse(parsed.completedAt)))
			) {
				return null;
			}
			return parsed as WorkflowMigrationMarker;
		} catch {
			return null;
		}
	}

	async #writeWorkflowMigrationMarkerAtomic(markerPath: string, marker: WorkflowMigrationMarker): Promise<void> {
		if (marker.status === "complete") {
			if (typeof marker.canonicalTargetIdentity !== "string" || marker.canonicalTargetIdentity.length === 0) {
				throw new Error("Cannot publish a complete workflow migration marker without target directory identity.");
			}
			const currentTargetIdentity = await this.#statIdentity(path.dirname(marker.targetPath));
			if (currentTargetIdentity !== marker.canonicalTargetIdentity) {
				throw new Error("Cannot publish a complete workflow migration marker without a matching target directory.");
			}
		}
		const serialized = JSON.stringify(marker, null, 2);
		const directory = path.dirname(markerPath);
		const tempPath = path.join(directory, `.${path.basename(markerPath)}.${process.pid}.${randomUUID()}.tmp`);
		try {
			await Bun.write(tempPath, serialized);
			// Durable before publication: fsync the marker file so a crash
			// cannot leave a rename that survives while the marker content is
			// lost.
			const tempHandle = await fs.promises.open(tempPath, "r");
			try {
				await tempHandle.sync();
			} finally {
				await tempHandle.close();
			}
			await fs.promises.rename(tempPath, markerPath);
			// Durable publication: sync the parent directory so the rename (the
			// marker's directory entry) survives a host crash even when the
			// temp file content was already durable.
			// Best-effort (like the atomic-YAML writer): some platforms (Windows,
			// filesystems that reject opening/syncing directories) throw here -
			// the marker rename is already durable; a directory-sync failure
			// must not abort the migration.
			try {
				const dirHandle = await fs.promises.open(directory, "r");
				try {
					await dirHandle.sync();
				} finally {
					await dirHandle.close();
				}
			} catch {
				// Unsupported directory sync: ignore.
			}
		} finally {
			await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
		}
	}

	async #moveLegacySourceNoReplace(
		source: string,
		destination: string,
		expectedSourceSha256?: string,
	): Promise<boolean> {
		try {
			await fs.promises.lstat(destination);
			return false; // Never overwrite an existing destination.
		} catch (error) {
			if (!isEnoent(error)) return false;
		}
		if (expectedSourceSha256 !== undefined) {
			// USER-DATA move: use an INDEPENDENT copy (never a hard link - a kept
			// source and a hard-linked backup share an inode, so a later in-place
			// edit or truncation of the still-active legacy file would mutate the
			// backup and the marker hash would no longer preserve the migrated
			// bytes) and keep the source ACTIVE (never unlink; a path-based unlink
			// after a non-atomic identity check could delete a rename-replaced
			// file). The caller re-verifies the source before the complete marker.
			try {
				await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
			} catch {
				return false;
			}
			// Durable before the complete marker: sync the copied backup (a power
			// loss must not leave a surviving marker + target with a missing or
			// empty backup).
			const userCopyHandle = await fs.promises.open(destination, "r");
			try {
				await userCopyHandle.sync();
			} finally {
				await userCopyHandle.close();
			}
			let copiedSourceHash: string | null = null;
			try {
				copiedSourceHash = await this.#sha256File(source);
			} catch {
				// The source was deleted right after the copy: remove the copy and
				// report failure so the caller reverts the target (the caller's
				// later guarded recheck would otherwise be bypassed by the throw).
				await fs.promises.rm(destination, { force: true });
				return false;
			}
			if (copiedSourceHash !== expectedSourceSha256) {
				await fs.promises.rm(destination, { force: true });
				return false;
			}
			return true;
		}
		// Internal artifacts (marker quarantine): capture the inode, hard-link
		// (copy fallback), and remove the source name only while it is still the
		// inode we verified.
		let sourceIno: number | undefined;
		try {
			sourceIno = (await fs.promises.stat(source)).ino;
		} catch {
			return false;
		}
		try {
			// Atomic same-directory no-clobber move via hard link + unlink.
			await fs.promises.link(source, destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			// Filesystems without hard links: a no-clobber copy. COPYFILE_EXCL
			// fails with EEXIST if the destination appears, so it can never
			// replace an existing `.bak`/quarantine - unlike a raw rename, which
			// would overwrite a destination created after the lstat above.
			try {
				await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
			} catch {
				return false;
			}
			// Durable before the complete marker: sync the copied backup file (a
			// power loss must not leave a surviving marker + target with a
			// missing or empty backup).
			const copyHandle = await fs.promises.open(destination, "r");
			try {
				await copyHandle.sync();
			} finally {
				await copyHandle.close();
			}
		}
		if (!(await this.#legacySourceStillVerified(source, sourceIno))) {
			await fs.promises.rm(destination, { force: true });
			return false;
		}
		try {
			await fs.promises.rm(source, { force: true });
		} catch {
			return false;
		}
		return true;
	}
	/**
	 * True only if `path` still refers to the same inode that was verified
	 * earlier and (when an expected hash is given) still holds the verified
	 * bytes. Used immediately before any unlink of a legacy source so a
	 * concurrent rename-style save or in-place edit is never consumed.
	 */
	async #legacySourceStillVerified(
		path: string,
		expectedIno: number,
		expectedSourceSha256?: string,
	): Promise<boolean> {
		const stat = await fs.promises.stat(path).catch(() => null);
		if (!stat || stat.ino !== expectedIno) return false;
		if (expectedSourceSha256 !== undefined && (await this.#sha256File(path)) !== expectedSourceSha256) return false;
		return true;
	}

	async #pathExists(target: string): Promise<boolean> {
		try {
			await fs.promises.lstat(target);
			return true;
		} catch (error) {
			// Only ENOENT means absence; a transient EACCES/EIO failure must
			// propagate so recovery never mistakes it for a deletion/removal.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	async #sha256File(target: string): Promise<string> {
		const raw = await Bun.file(target).arrayBuffer();
		return createHash("sha256").update(Buffer.from(raw)).digest("hex");
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
		if (!this.#persist || !this.#configPath || this.#hasRecoveredConfigSyntax) return;

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
		})
			.then(() => undefined)
			.catch(async error => {
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
				try {
					await this.#refreshDurableSettings();
				} catch (refreshError) {
					logger.warn("Settings: refresh after background save failure failed", { error: String(refreshError) });
				}
				throw error;
			});
		this.#savePromise = save;
		void save.catch(() => {});
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

	#reserveAtomicFailureRefresh(commit: Promise<unknown>): Promise<void> {
		if (!this.#persist || !this.#configPath) return Promise.resolve();
		return enqueueAtomicYamlOperation(this.#configPath, async canonicalPath => {
			try {
				await commit;
				return;
			} catch {
				// The original commit error remains authoritative. Recovery failures
				// are diagnostic only and must not replace it.
			}
			try {
				await this.#refreshDurableSettingsUnderQueue(canonicalPath);
			} catch (refreshError) {
				logger.warn("Settings: refresh after atomic batch failure failed", { error: String(refreshError) });
			}
		});
	}
	async #refreshDurableSettingsUnderQueue(canonicalPath: string): Promise<void> {
		const previousFingerprint = this.#durableNotificationFingerprint;
		const current = await this.#loadYaml(canonicalPath);
		if (previousFingerprint !== this.#durableNotificationFingerprint) this.#notificationValidationGeneration++;
		this.#replaceGlobalWithDurable(current);
	}
	async #refreshDurableSettings(): Promise<void> {
		if (!this.#persist || !this.#configPath) return;
		await enqueueAtomicYamlOperation(this.#configPath, canonicalPath =>
			this.#refreshDurableSettingsUnderQueue(canonicalPath),
		);
	}
	#assertDurableConfigWritable(): void {
		if (this.canWriteDurableConfig()) return;
		throw new Error(
			"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
		);
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
			invalidNotificationGlobal: this.#hasInvalidNotificationGlobal,
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
		this.#hasInvalidNotificationGlobal = state.invalidNotificationGlobal;
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
			this.#hasInvalidNotificationGlobal = false;
			return;
		}
		try {
			parseNotificationSettingsSnapshot(this.#rawNotificationConfig);
			this.#hasMalformedConfigRoot = false;
			this.#hasInvalidNotificationGlobal = false;
		} catch (error) {
			if (error instanceof Error && error.message === "gjc_notify_daemon_invalid_configuration") {
				this.#hasMalformedConfigRoot = false;
				this.#hasInvalidNotificationGlobal = true;
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
			this.#hasInvalidNotificationGlobal = false;
		} catch (error) {
			if (error instanceof Error && error.message === "gjc_notify_daemon_invalid_configuration") {
				this.#hasInvalidNotificationGlobal = true;
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

type SettingHook = (value: unknown, prev: unknown) => void;

const SETTING_HOOKS: Partial<Record<SettingPath, SettingHook>> = {
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
