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

import * as nodeCrypto from "node:crypto";
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
import { type EditMode, type EditVariantMatch, normalizeEditMode } from "../utils/edit-mode";
import {
	type AtomicYamlConfigTransaction,
	AtomicYamlConflictError,
	type AtomicYamlPatch,
	AtomicYamlRetargetError,
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
import {
	type AutoroutingEffective,
	validateAutoroutingEffective,
	validateAutoroutingLocal,
} from "./autorouting-contract";
import { isModelSelectorValue, type ModelSelectorValue, normalizeModelSelectorValue } from "./model-selector-value";

import {
	type BashInterceptorRule,
	CONFIG_SCHEMA_VERSION,
	type GroupPrefix,
	type GroupTypeMap,
	getDefault,
	normalizeConfigSchemaVersion,
	reconcileSettingsSchema,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingsSchemaIssue,
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

const UNSAFE_EDIT_VARIANT_PATTERNS = new Set(["__proto__", "constructor", "prototype"]);

const CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS: readonly WorkflowSettingKey[] = [
	"gjc.deepInterview.ambiguityThreshold",
	"gjc.ralplan.autoHandoff",
	"gjc.ralplan.maxIterations",
	"gjc.ralplan.maxReviewPassesPerLane",
	"gjc.ultragoal.nudgeBudget",
];

type StrictInvalidEvidenceEntry = { key: WorkflowSettingKey; value: unknown };

/** Pre-publication target state of a key the project migration will write. */
type ProjectTargetBeforeState = { present: boolean; value: unknown };

/**
 * Guaranteed-invalid placeholder values persisted into project `config.yml` as
 * fallback strict evidence when the retained `.gjc/settings.json` is malformed
 * or unreadable AND the strict-invalid evidence sidecar (`.gjc/state/`) cannot
 * be written. The strict resolver reads config.yml only, so each value keeps
 * the ralplan exit-2 error observable until the user repairs the source.
 */
const MALFORMED_SOURCE_STRICT_FALLBACK: readonly { key: WorkflowSettingKey; value: unknown }[] = [
	{ key: "gjc.ralplan.autoHandoff", value: "invalid-autoHandoff" },
	{ key: "gjc.ralplan.maxIterations", value: -1 },
	{ key: "gjc.ralplan.maxReviewPassesPerLane", value: -1 },
];

type StrictInvalidEvidence =
	| { version: 2; malformed: true; source: string }
	| { version: 2; malformed?: false; keys: readonly StrictInvalidEvidenceEntry[]; source: string };

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
/**
 * Test-only seams for the config-root workflow migration. Production code
 * never sets these; tests use them to interleave external filesystem changes
 * at exact points of the migration state machine (mirroring
 * `FileLockTestHooks` in file-lock.ts).
 */
export const SettingsMigrationTestHooks: {
	/** Fires after the no-replace backup copy is created and its identity
	 * (inode + sha256) has been captured, immediately before the source is
	 * re-hashed for the move verification. */
	afterBackupIdentityCaptured?: (backupPath: string) => void | Promise<void>;
	/** Fires after a quarantined backup is verified as this run's file,
	 * immediately before the quarantined entry is unlinked. */
	beforeQuarantineRemoval?: (backupPath: string) => void | Promise<void>;
	/** Fires immediately before the project migration's POST-publication marker
	 * re-read, after the migrated values already committed: test seams use it
	 * to make the marker unreadable so the rollback path is exercised. */
	beforeProjectMarkerMerge?: () => void | Promise<void>;
} = {};

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
	/**
	 * Read the canonical config.yml from disk but never persist: no DB open,
	 * no legacy/config-root/project migrations, no file writes, renames, locks,
	 * or mtime changes. Used by read-only inspection surfaces (`gjc customize
	 * doctor`). When true, inMemory must be false so config.yml is still read.
	 */
	readonly?: boolean;
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
 * Flatten an object to its leaf dotted paths (nested and dotted keys alike),
 * used to verify publication proof before retiring a legacy source.
 */
function flattenObjectPaths(node: unknown, prefix: string[] = []): string[] {
	if (node === null || typeof node !== "object" || Array.isArray(node)) {
		return [prefix.join(".")];
	}
	const paths: string[] = [];
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		paths.push(...flattenObjectPaths(value, [...prefix, key]));
	}
	return paths;
}

/**
 * Whether a dotted path has a value present in an object (used to verify
 * publication proof before retiring a legacy source).
 */
function hasPathValue(obj: Record<string, unknown>, dottedPath: string): boolean {
	let node: unknown = obj;
	for (const segment of dottedPath.split(".")) {
		if (node === null || typeof node !== "object" || !(segment in node)) {
			return false;
		}
		node = (node as Record<string, unknown>)[segment];
	}
	return true;
}

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
/** Operator-owned settings which must never be workspace-controlled or runtime-overridden. */
const GLOBAL_ONLY_SETTINGS = new Set<SettingPath>([
	"crashReport.upstream",
	"crashReport.upstreamDsn",
	"ui.language",
	"telemetry.enabled",
]);
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

const LEGACY_CUSTOM_IMAGE_PROVIDER_DIAGNOSTIC =
	"Legacy custom image settings cannot be migrated automatically. Move the endpoint and credential to models.yml, configure an image-capable OpenAI Responses model, and then set modelRoles.image. The legacy settings were retained unchanged.";

function hasLegacyCustomImageProvider(raw: RawSettings): boolean {
	return rawSettingsRecord(raw.providers)?.image === "custom";
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
	#isolatedStorage = false;

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
	/** Legacy custom-image migration error emitted once per settings instance. */
	#legacyCustomImageProviderDiagnosticLogged = false;

	#schemaReport: SettingsSchemaReport = { issues: [], valid: true };

	#autoroutingEffective: AutoroutingEffective = { active: false };
	#autoroutingLocalIssues: SettingsSchemaIssue[] = [];
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
	/** Read-only inspection mode: config.yml is read but never written/migrated. */
	#readonly: boolean;

	private constructor(options: SettingsOptions = {}, isolatedStorage = false) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		this.#configPath = options.inMemory ? null : path.resolve(this.#agentDir, "config.yml");
		this.#persist = !options.inMemory && !options.readonly;
		this.#readonly = options.readonly === true;
		this.#isolatedStorage = isolatedStorage;

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
		const instance = new Settings(options, true);
		return instance.#load();
	}
	/**
	 * Load settings for read-only inspection without any persistence side-effects:
	 * no DB open, no legacy/config-root/project migrations, no file writes,
	 * renames, locks, or mtime changes. Reads the canonical config.yml and
	 * discovers/merges project settings exactly like the durable path, but the
	 * result is a transient snapshot. Does not affect the global singleton.
	 *
	 * Used by `gjc customize doctor` to honor the read-only product contract.
	 */
	static loadReadonly(options: { cwd?: string; agentDir?: string }): Promise<Settings> {
		const instance = new Settings({ ...options, readonly: true });
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
		const issues = [
			...this.#schemaReport.issues.filter(
				issue =>
					!(
						(issue.kind === "invalid" || issue.kind === "unknown") &&
						(issue.path === "task.autorouting" || issue.path.startsWith("task.autorouting."))
					),
			),
			...this.#autoroutingLocalIssues,
			...(this.#autoroutingEffective.active || !this.#autoroutingEffective.issue
				? []
				: [
						{
							path: "task.autorouting",
							kind: "invalid" as const,
							detail: this.#autoroutingEffective.issue.detail,
						},
					]),
		];
		return {
			issues: structuredClone(issues),
			valid: !issues.some(issue => issue.kind === "invalid"),
		};
	}

	/** Effective merged autorouting state shared by settings diagnostics and routing policy. */
	getEffectiveAutorouting(): AutoroutingEffective {
		return structuredClone(this.#autoroutingEffective);
	}

	onChanged(listener: (path: SettingPath) => void): () => void {
		this.#changeListeners.add(listener);
		return () => this.#changeListeners.delete(listener);
	}

	/** Whether durable settings mutations are permitted for the loaded configuration. */
	canWriteDurableConfig(): boolean {
		return !this.#persist || !this.#hasRecoveredConfigSyntax;
	}

	/** Whether this instance can publish a mutation to a durable config file. */
	canPersistDurableConfig(): boolean {
		return this.#persist && !this.#hasRecoveredConfigSyntax;
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

	/** Read the exact runtime override without merged defaults. */
	getOverride<P extends SettingPath>(path: P): SettingValue<P> | undefined {
		const value = getByPath(this.#overrides, path.split("."));
		return value === undefined ? undefined : (value as SettingValue<P>);
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
		if (saveError instanceof AtomicYamlRetargetError) throw saveError;
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

		cloned.#autoroutingEffective = structuredClone(this.#autoroutingEffective);
		cloned.#autoroutingLocalIssues = structuredClone(this.#autoroutingLocalIssues);
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

	/** Flush and close storage owned by an isolated settings scope. */
	async close(): Promise<void> {
		if (!this.#isolatedStorage) return;
		try {
			await this.flushOrThrow();
		} finally {
			this.#storage?.close();
			this.#storage = null;
		}
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
				setByPath(result, suffix.split("."), this.get(key));
			}
		}
		return result as unknown as GroupTypeMap[G];
	}

	/**
	 * Get the edit variant for a specific model.
	 * Returns "patch", "replace", "hashline", "vim", "apply_patch", or null (use global default).
	 * Skips invalid values; prefer `matchEditVariantForModel` when invalid
	 * matches must fail closed instead of falling through.
	 */
	getEditVariantForModel(model: string | undefined): EditMode | null {
		if (!model) return null;
		const variants = this.#editModelVariants();
		if (!variants) return null;
		for (const [pattern, rawValue] of Object.entries(variants)) {
			if (UNSAFE_EDIT_VARIANT_PATTERNS.has(pattern)) continue;
			if (model.includes(pattern)) {
				const value = normalizeEditMode(rawValue);
				if (value) {
					return value;
				}
			}
		}
		return null;
	}

	/**
	 * First matching `edit.modelVariants` rule for a model, with its raw
	 * (unvalidated) value. The edit-mode resolver uses this discriminated
	 * result so a matched-but-invalid value fails closed with a diagnostic
	 * rather than silently resolving to another mode.
	 */
	matchEditVariantForModel(model: string | undefined): EditVariantMatch | null {
		if (!model) return null;
		const variants = this.#editModelVariants();
		if (!variants) return null;
		for (const [pattern, value] of Object.entries(variants)) {
			if (UNSAFE_EDIT_VARIANT_PATTERNS.has(pattern)) continue;
			if (model.includes(pattern)) {
				return { pattern, value: String(value) };
			}
		}
		return null;
	}

	#editModelVariants(): Record<string, string> | undefined {
		const variants = (this.#merged.edit as { modelVariants?: unknown })?.modelVariants;
		return typeof variants === "object" &&
			variants !== null &&
			!Array.isArray(variants) &&
			(Object.getPrototypeOf(variants) === Object.prototype || Object.getPrototypeOf(variants) === null)
			? (variants as Record<string, string>)
			: undefined;
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
		try {
			if (this.#persist) {
				// The legacy agent-dir/database settings merge into config.yml BEFORE
				// the workflow migrations create the file: #migrateAgentDirAndDatabaseLegacy
				// drains the database rows even when config.yml already exists, but a
				// first upgrade run must not let the config-root workflow migration
				// create the file while the database has not been opened yet. Open the
				// database best-effort, retrying immediately; if it is genuinely
				// unavailable, run the workflow migrations anyway so their overrides
				// are never lost, then re-open and drain afterwards.
				if (!this.#storage) {
					try {
						this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir), {
							isolated: this.#isolatedStorage,
						});
					} catch {
						try {
							this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir), {
								isolated: this.#isolatedStorage,
							});
						} catch {
							// Continue without the database; the final retry below
							// re-opens it for the rest of the load.
						}
					}
				}
				await this.#migrateAgentDirAndDatabaseLegacy();
				// The workflow settings migrations write config.yml directly and must
				// run BEFORE project discovery: project discovery strips the retired
				// workflow keys from the retained .gjc/settings.json, so on a first
				// load the migrated config.yml value must already exist when the
				// project layer is scanned - otherwise settings.get()/gjc config
				// get/list return the schema default for one cycle.
				await this.#migrateConfigRootWorkflowSettings();
				await this.#migrateProjectWorkflowSettings();
				if (!this.#storage) {
					// The database was unavailable during the merge: re-open it now
					// (an unavailable/corrupt database still fails the full load, as
					// before) and drain the legacy settings into the already-created
					// config.yml - the merge handles an existing file absent-only.
					this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir), {
						isolated: this.#isolatedStorage,
					});
					await this.#migrateAgentDirAndDatabaseLegacy();
				}
				this.#global = await this.#loadYaml(this.#configPath!);
			} else if (this.#readonly && this.#configPath) {
				// Read-only inspection path (e.g. `gjc customize doctor`): read
				// config.yml from disk without opening the DB, running legacy/
				// config-root/project migrations, or writing/renaming anything.
				// The effective configuration semantics are otherwise identical:
				// the same YAML parse, schema reconciliation, in-memory migration,
				// and project-layer discovery/merge are applied.
				this.#global = await this.#loadYaml(this.#configPath);
			}
			if (this.#schemaMigrationPending)
				this.#recordLegacyFallbackMigrationPatch("configSchemaVersion", CONFIG_SCHEMA_VERSION);

			this.#project = await this.#loadProjectSettings();

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
		if (filePath === this.#configPath && hasLegacyCustomImageProvider(parsedRaw)) {
			reconciled.report.issues.push({
				path: "providers.image",
				kind: "invalid",
				detail: LEGACY_CUSTOM_IMAGE_PROVIDER_DIAGNOSTIC,
			});
			reconciled.report.valid = false;
			if (!this.#legacyCustomImageProviderDiagnosticLogged) {
				this.#legacyCustomImageProviderDiagnosticLogged = true;
				logger.error("Settings: legacy custom image provider requires manual migration", {
					configPath: filePath,
					modelsPath: path.join(this.#agentDir, "models.yml"),
				});
			}
		}

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
			const result = await loadCapability(settingsCapability.id, { cwd: this.#cwd, settings: this });
			let merged: RawSettings = {};
			for (const item of result.items as SettingsCapabilityItem[]) {
				if (item.level !== "project") continue;
				// Retained project settings.json remains discoverable for non-workflow
				// settings, but workflow keys durably migrated to config.yml must not be
				// resurrected after `gjc config unset`. Unowned keys stay visible as the
				// resolver's fallback when migration could not publish ownership.
				const data = item.path.endsWith(`${path.sep}settings.json`)
					? await this.#stripRetiredWorkflowKeys(item.path, structuredClone(item.data as RawSettings))
					: (item.data as RawSettings);
				const { settings, rejectedNotifications, rejectedCredentialPins } =
					this.#stripProjectNotificationSettings(data);
				if (rejectedNotifications) {
					logger.warn("Settings: ignoring project notification settings", { path: item.path });
				}
				if (rejectedCredentialPins) {
					logger.warn("Settings: ignoring project auth.credentialPins; pins are global-only", { path: item.path });
				}
				merged = this.#deepMerge(merged, settings);
			}
			return this.#migrateRawSettings(merged);
		} catch (error) {
			// A malformed project file is tolerated (its layer is skipped), but a
			// marker-read failure (EACCES/EISDIR/transient I/O - an fs error with
			// a code, not a parse error) must PROPAGATE: silently returning {}
			// would drop the entire project layer, including valid config.yml
			// values, on a transient failure.
			if (
				error !== null &&
				typeof error === "object" &&
				"code" in error &&
				(error as { code?: unknown }).code !== "ENOENT"
			) {
				throw error;
			}
			return {};
		}
	}

	/**
	 * Remove workflow keys from retained project settings.json only when the
	 * migrated-keys marker durably records config.yml ownership. Unowned keys are
	 * normalized from legacy flat dotted form to the nested settings shape so the
	 * generic Settings view agrees with the workflow resolver's fallback.
	 */
	async #stripRetiredWorkflowKeys(sourcePath: string, settings: RawSettings): Promise<RawSettings> {
		const owned = await this.#readProjectMigratedKeys(sourcePath);
		for (const key of CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS) {
			if (owned.has(key)) {
				if (Object.hasOwn(settings, key)) delete settings[key];
				deleteByPath(settings, key.split("."));
				continue;
			}
			if (Object.hasOwn(settings, key)) {
				const value = settings[key];
				delete settings[key];
				setByPath(settings, key.split("."), value);
			}
		}
		return settings;
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

			const tiersPath = ["task", "autorouting", "tiers"];
			const tiers = getByPath(source, tiersPath);
			if (tiers === undefined) continue;
			if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) {
				logger.warn("Settings: retained malformed autorouting tier record for schema diagnostics", {
					path: tiersPath.join("."),
				});
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

	/**
	 * Collect ABSENT-ONLY leaf patches from a legacy settings object against the
	 * current config.yml root: a nested legacy value (e.g. `gjc.ultragoal.
	 * nudgeBudget`) must not be skipped wholesale just because a sibling `gjc`
	 * object already exists - each leaf is merged only when absent, so the
	 * existing values (including the workflow values a migration wrote) are
	 * never clobbered and every drained setting survives.
	 */
	/**
	 * Source-overwrite patches for the interrupted-retirement recovery: every
	 * leaf of the source's migrated values becomes a SET patch with the
	 * source's value. Path semantics mirror {@link #collectAbsentLegacyPatches}
	 * (top-level keys split on dots; keys inside records are literal segments
	 * and are never split), so a record with a literal dotted member such as
	 * `modelTags: { "custom.role": { name } }` survives recovery.
	 */
	#collectSourceOverwritePatches(value: RawSettings, prefix: string[] = []): AtomicYamlPatch[] {
		const patches: AtomicYamlPatch[] = [];
		for (const [key, entry] of Object.entries(value)) {
			const segments = prefix.length === 0 ? [...prefix, ...key.split(".")] : [...prefix, key];
			if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
				patches.push(...this.#collectSourceOverwritePatches(entry as RawSettings, segments));
			} else {
				// A literal dotted member (e.g. `custom.role` inside a record) is
				// not representable in the dotted patch path format: the atomic
				// pipeline would re-split it into nested segments and either garble
				// the target or fail the publication. Exclude such leaves so the
				// recovery completes without corrupting the target's literal
				// member; the remaining source paths are republished.
				if (segments.some(segment => segment.includes("."))) continue;
				patches.push({ path: segments.join("."), op: "set" as const, value: structuredClone(entry) });
			}
		}
		return patches;
	}

	#collectAbsentLegacyPatches(
		current: Readonly<Record<string, unknown>>,
		legacy: Readonly<Record<string, unknown>>,
		prefix: string[] = [],
	): AtomicYamlPatch[] {
		const patches: AtomicYamlPatch[] = [];
		// Keys encountered INSIDE a record value are literal member names, not
		// dotted paths. A member key containing a dot (e.g. `modelTags` ->
		// `{ "custom.role": ... }`) cannot be addressed by the dotted patch
		// grammar as a leaf, so such a record is merged as a WHOLE at its
		// (dot-free) enclosing path instead of leaf-by-leaf. Only the top-level
		// legacy keys are flat dotted paths (the database's row-key format), and
		// they are never literal keys.
		if (prefix.length > 0 && Object.keys(legacy).some(key => key.includes("."))) {
			const currentRecord = getByPath(current, prefix);
			// An OCCUPIED non-record enclosing path (scalar, array, or null)
			// must be left unchanged: emitting a whole-record merge would
			// replace the modern value (e.g. `modelTags: "custom"`) and then
			// clear the legacy rows, violating the absent-only migration
			// contract. Only absent or record-valued paths participate.
			if (
				currentRecord !== undefined &&
				(currentRecord === null || typeof currentRecord !== "object" || Array.isArray(currentRecord))
			) {
				return patches;
			}
			patches.push({
				path: prefix.join("."),
				op: "set" as const,
				value:
					currentRecord === undefined
						? legacy
						: this.#mergeAbsentRecords(currentRecord as Record<string, unknown>, legacy),
			});
			return patches;
		}
		for (const [key, value] of Object.entries(legacy)) {
			// Split flat dotted keys into path segments ONLY on the initial call so
			// the absent check uses the SAME nested interpretation the patch grammar
			// applies when writing: a legacy database row keyed `theme.dark` must
			// compare against the nested `theme.dark` value, not a literal top-level
			// "theme.dark" key (which would report absent and then overwrite the
			// modern value). Keys inside record values are literal segments and are
			// never split.
			const segments = prefix.length === 0 ? [...prefix, ...key.split(".")] : [...prefix, key];
			const currentValue = getByPath(current, segments);
			if (currentValue === undefined) {
				patches.push({ path: segments.join("."), op: "set" as const, value });
				continue;
			}
			if (
				currentValue !== null &&
				typeof currentValue === "object" &&
				!Array.isArray(currentValue) &&
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value)
			) {
				patches.push(...this.#collectAbsentLegacyPatches(current, value as Record<string, unknown>, segments));
			}
		}
		return patches;
	}

	/**
	 * Deep-merge a legacy record into the current record at the same path,
	 * adding ONLY absent leaves so existing values are never clobbered. Every
	 * member key is treated as a literal segment name at every level (no
	 * dotted-path interpretation), which is what preserves a key like
	 * `custom.role` inside a `modelTags` record during migration.
	 */
	#mergeAbsentRecords(
		current: Readonly<Record<string, unknown>>,
		legacy: Readonly<Record<string, unknown>>,
	): Record<string, unknown> {
		const merged: Record<string, unknown> = { ...current };
		for (const [key, value] of Object.entries(legacy)) {
			const existing = merged[key];
			if (existing === undefined) {
				merged[key] = value;
			} else if (
				existing !== null &&
				typeof existing === "object" &&
				!Array.isArray(existing) &&
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value)
			) {
				merged[key] = this.#mergeAbsentRecords(
					existing as Record<string, unknown>,
					value as Record<string, unknown>,
				);
			}
		}
		return merged;
	}

	async #migrateAgentDirAndDatabaseLegacy(): Promise<void> {
		if (!this.#configPath) return;

		let settings: RawSettings = {};
		let migrated = false;
		// The source-only migrated values (tracked for the interrupted-retirement
		// recovery: their CURRENT values must be REPUBLISHED, not absent-only, so
		// a concurrent edit after the interrupted run is never silently lost).
		let settingsJsonMigrated: RawSettings | null = null;

		// 1. Migrate from settings.json (one-time via the .bak rename; runs only
		// when config.yml is absent so it never overwrites a completed surface,
		// EXCEPT when a pending-retirement marker exists: a source edited after
		// an interrupted retirement must be RE-MIGRATED (absent-only) instead of
		// staying permanently ignored by the configExists guard).
		const configExists = await this.#pathExists(this.#configPath);
		const settingsJsonPath = path.join(this.#agentDir, "settings.json");
		const pendingRetirementPath = `${settingsJsonPath}.pending-retirement`;
		const settingsJsonRetirementMarkerExists = await this.#pathExists(pendingRetirementPath);
		let settingsJsonRetirementPending = false;
		let settingsJsonMarkerPersisted = false;
		let settingsJsonRaw: string | null = null;
		// Identity (inode) of the VALIDATED bytes, captured from the same
		// descriptor that read them: the retirement rename is bound to this
		// identity so a concurrent replacement is never moved to .bak.
		let settingsJsonIno: number | null = null;
		// The marker's ORIGINAL sha at method entry (captured BEFORE the
		// re-read rewrites it): the recovery's source-set patches must compare
		// the current source against the INTERRUPTED run's recorded revision,
		// not the just-rewritten marker.
		let settingsJsonMarkerShaAtEntry: string | null = null;
		if (settingsJsonRetirementMarkerExists) {
			settingsJsonMarkerShaAtEntry = await Bun.file(pendingRetirementPath)
				.text()
				.catch(() => null);
		}
		if (!configExists || settingsJsonRetirementMarkerExists) {
			try {
				// Read the bytes and capture the inode from the SAME descriptor:
				// the retirement rename is bound to the file whose bytes were
				// validated, so a concurrent replacement (even between the read and
				// a later stat) is never retired.
				const sourceHandle = await fs.promises.open(settingsJsonPath, "r");
				try {
					settingsJsonIno = (await sourceHandle.stat()).ino;
					settingsJsonRaw = await sourceHandle.readFile("utf8");
				} finally {
					await sourceHandle.close();
				}
				const parsed = JSON.parse(settingsJsonRaw);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					settingsJsonMigrated = this.#migrateRawSettings(parsed);
					settings = this.#deepMerge(settings, settingsJsonMigrated);
					migrated = true;
					// The .bak retirement is DEFERRED until the combined migration
					// commits: a later failure (e.g. a malformed agent.db row that
					// aborts the load) must leave the source discoverable for the
					// next load instead of stranding its only copy as a .bak.
					settingsJsonRetirementPending = true;
					// Persist the pending retirement BEFORE the publication: if the
					// process exits after the values commit but before the rename,
					// the next load recognizes the marker and completes the
					// retirement instead of stranding an active-looking legacy file
					// whose edits are silently ignored. The marker stores the
					// source's SHA-256 so a later edit is never retired. The payload
					// and parent directory are FSYNCED (like the YAML publication
					// it recovers) so a power loss cannot strand the source with a
					// lost marker while config.yml already exists. A replaced marker
					// (a previous interrupted run) is overwritten.
					try {
						const markerHandle = await fs.promises.open(pendingRetirementPath, "w", 0o600);
						try {
							await markerHandle.writeFile(
								nodeCrypto.createHash("sha256").update(settingsJsonRaw).digest("hex"),
							);
							await markerHandle.sync();
						} finally {
							await markerHandle.close();
						}
						await fs.promises
							.open(path.dirname(pendingRetirementPath), "r")
							.then(async dirHandle => {
								try {
									await dirHandle.sync();
								} finally {
									await dirHandle.close();
								}
							})
							.catch(() => undefined);
						settingsJsonMarkerPersisted = true;
					} catch {}
				}
			} catch {}
		}

		// 2. Migrate from agent.db (self-draining: the rows are cleared after the
		// merge, so a later load never re-imports them; runs even when config.yml
		// already exists so a database that became available after an earlier
		// failed open is still drained). A transient read failure (e.g.
		// SQLITE_BUSY escaping the busy timeout) is retried with backoff; on a
		// persistent failure the rows did NOT participate in the publication, so
		// the drain below is skipped and they stay for the next load - never
		// delete database-only rows that were not merged into config.yml.
		let dbReadSucceeded = false;
		try {
			let dbSettings: RawSettings | null = null;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					dbSettings = (this.#storage?.getSettings() as RawSettings | null) ?? null;
					break;
				} catch (error) {
					const isSqliteBusy =
						error && typeof error === "object" && (error as { code?: string }).code === "SQLITE_BUSY";
					if (!isSqliteBusy || attempt === 2) throw error;
					await Bun.sleep(100 * 2 ** attempt);
				}
			}
			if (dbSettings) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(dbSettings));
				migrated = true;
			}
			dbReadSucceeded = true;
		} catch (error) {
			// A malformed or persistently unreadable legacy database is a data
			// integrity problem: fail the load so it is actionable instead of
			// silently continuing without the previously effective rows. The
			// rows did NOT participate in any publication, so nothing is
			// drained and they stay in place for repair and the next load.
			this.#warnLegacyFallbackMigration(
				`Settings: legacy agent.db settings could not be read (${error instanceof Error ? error.message : String(error)}); failing the load so the database can be repaired`,
			);
			throw error;
		}

		// 3. Write merged settings through the shared atomic YAML pipeline. When
		// config.yml already exists (created by the config-root workflow migration,
		// or a drained-then-reopened database), merge ABSENT-ONLY so the existing
		// values - including the workflow values the config-root migration wrote -
		// are never clobbered.
		if (
			migrated &&
			(settingsJsonRetirementPending === false || settingsJsonMarkerPersisted) &&
			Object.keys(settings).length > 0
		) {
			// Publication is best-effort: a write failure (e.g. a CAS conflict with
			// an external config.yml edit) keeps the legacy rows for the next load
			// to retry and must never fail the settings load.
			let published = false;
			try {
				// Publish under the config's own transaction so the absent-only
				// merge runs against the CURRENT durable state and every write is
				// CAS-guarded: an external editor that replaced config.yml between
				// the read and the rename must not have its newer file (and any
				// unrelated settings it carries) silently overwritten. The same
				// absent-only collection handles both the present and the absent
				// target (an absent target starts from an empty current record).
				// Read-only targets are rejected BEFORE any merge, mirroring the
				// workflow migrations' guards: a scalar/array/null root is malformed
				// user data (patching would replace the whole document) and a FUTURE
				// configSchemaVersion is never modified - in both cases the legacy
				// rows stay for the next load instead of being drained.
				published = await withAtomicYamlConfigTransaction(this.#configPath, async tx => {
					const root = tx.root;
					if (root !== undefined && (root === null || typeof root !== "object" || Array.isArray(root))) {
						this.#warnLegacyFallbackMigration(
							`Settings: database workflow migration skipped: ${this.#configPath} has a non-object or null YAML root; leaving legacy rows for the next load`,
						);
						return false;
					}
					const schemaVersion = (root as Record<string, unknown> | null | undefined)?.configSchemaVersion;
					if (typeof schemaVersion === "number" && schemaVersion > CONFIG_SCHEMA_VERSION) {
						this.#warnLegacyFallbackMigration(
							`Settings: database workflow migration skipped: ${this.#configPath} is a future config schema (configSchemaVersion ${schemaVersion} > ${CONFIG_SCHEMA_VERSION}); leaving legacy rows for the next load`,
						);
						return false;
					}
					const patches = this.#collectAbsentLegacyPatches(tx.current, settings);
					// The interrupted-retirement recovery (a pending marker): the
					// source's CURRENT values are republished as SET patches (not
					// absent-only) so a concurrent edit after the interrupted run is
					// preserved instead of staying permanently ignored under the
					// target's older value.
					// The interrupted-retirement recovery (a pending marker): the
					// source's CURRENT values are republished as SET patches (not
					// absent-only) so a PROVEN post-marker source edit is preserved
					// instead of staying permanently ignored under the target's older
					// value. The source hash must DIFFER from the marker's recorded
					// hash: an unchanged source means the target holds the user's
					// current surface edits and must NOT be reverted by the stale
					// source values. Patch paths mirror #collectAbsentLegacyPatches
					// (top-level keys split on dots; keys inside records are literal
					// segments and are never split).
					const sourceSetPatches =
						settingsJsonRetirementMarkerExists && settingsJsonMigrated !== null
							? await (async (): Promise<AtomicYamlPatch[]> => {
									const currentSha =
										settingsJsonRaw !== null
											? nodeCrypto.createHash("sha256").update(settingsJsonRaw).digest("hex")
											: null;
									// A PROVEN post-marker source edit: the source hash
									// differs from the INTERRUPTED run's recorded revision
									// (the marker's entry-time sha). An unchanged source
									// means the target holds the user's current surface
									// edits and must NOT be reverted by the stale source
									// values.
									if (
										settingsJsonMarkerShaAtEntry === null ||
										currentSha === null ||
										currentSha === settingsJsonMarkerShaAtEntry
									) {
										return [];
									}
									return this.#collectSourceOverwritePatches(settingsJsonMigrated);
								})()
							: [];
					const allPatches = [...sourceSetPatches, ...patches];
					if (allPatches.length > 0) {
						await tx.applyPatches(allPatches);
					}
					return true;
				});
			} catch {}
			if (!published) return;
			if (!dbReadSucceeded) {
				// The database rows never participated in the publication (the read
				// failed): draining would delete rows that were not merged into
				// config.yml. Keep them for the next load, which retries the read.
				this.#warnLegacyFallbackMigration(
					`Settings: legacy database settings could not be read; keeping the rows for the next load`,
				);
				return;
			}
			// Clear the drained database rows so a later load never re-imports
			// them (the database has no other one-time guard). A persistent drain
			// failure PROPAGATES instead of being converted into a successful
			// migration: the stale rows stay eligible for the absent-only merge, so
			// a later `gjc config unset` of a migrated key would be resurrected on
			// the next load. The migration aborts (the settings load fails loudly)
			// and the next load retries the drain.
			await this.#storage?.clearSettings();
			logger.debug("Settings: migrated to config.yml", { path: this.#configPath });
		}
		// The combined migration committed (database validated and the merged
		// values published): retire the settings.json source now. Any earlier
		// failure path (malformed database row, unreadable marker, drain
		// failure) returns above with the source still in place for the next
		// load.
		if (settingsJsonRetirementPending || (await this.#pathExists(`${settingsJsonPath}.pending-retirement`))) {
			// Revalidate the source BEFORE retiring it: an edit or replacement
			// after the bytes were read but while this method awaited database
			// retries, the config transaction, or the drain must NOT be moved to
			// the inactive .bak - the user's newer settings would be stranded
			// while config.yml holds the earlier bytes. A changed source stays
			// active for the next load to re-read.
			const expectedSha =
				settingsJsonRaw !== null
					? nodeCrypto.createHash("sha256").update(settingsJsonRaw).digest("hex")
					: await Bun.file(`${settingsJsonPath}.pending-retirement`)
							.text()
							.catch(() => null);
			const currentRaw = await Bun.file(settingsJsonPath)
				.text()
				.catch(() => null);
			// PUBLICATION PROOF: the marker alone is not proof that the merged
			// values were ever written - the publication may have been skipped or
			// conflicted (e.g. another writer created a future-schema config.yml)
			// after the marker was persisted. Every workflow key present in the
			// source must exist in the target config.yml before the source is
			// retired.
			let publicationProof = false;
			if (currentRaw !== null) {
				try {
					const targetRaw = await Bun.file(this.#configPath)
						.text()
						.catch(() => "");
					const targetRoot = (YAML.parse(targetRaw) ?? {}) as Record<string, unknown> | null;
					// Verify EVERY migrated path, not just the workflow keys: the
					// agent-dir migration merges the entire #migrateRawSettings
					// result (non-workflow settings included) through
					// #collectAbsentLegacyPatches, so recovery must prove every
					// post-migration path (including renamed paths) exists in the
					// target before retiring the source. The merged `settings`
					// holds the same paths the publication wrote.
					const migratedPaths = flattenObjectPaths(settings);
					publicationProof =
						targetRoot !== null &&
						typeof targetRoot === "object" &&
						migratedPaths.length > 0 &&
						migratedPaths.every(path => hasPathValue(targetRoot, path));
				} catch {
					publicationProof = false;
				}
			}
			let retired = false;
			if (
				expectedSha !== null &&
				currentRaw !== null &&
				nodeCrypto.createHash("sha256").update(currentRaw).digest("hex") === expectedSha &&
				publicationProof
			) {
				// Identity-guard the rename: only move the exact inode whose bytes
				// were validated (captured from the same descriptor as the read). A
				// replacement at any point after the validated read must stay active
				// (its newer settings are re-migrated by the next load via the
				// marker gate).
				const currentIno = await fs.promises
					.lstat(settingsJsonPath)
					.then(stat => stat.ino)
					.catch(() => null);
				if (settingsJsonIno !== null && settingsJsonIno === currentIno) {
					try {
						fs.renameSync(settingsJsonPath, `${settingsJsonPath}.bak`);
						retired = true;
					} catch {}
				}
			}
			// The pending-retirement marker is consumed ONLY after a successful
			// retirement: a failed rename (Windows sharing violation, permissions)
			// must leave the marker so the next load retries instead of stranding
			// an active-looking legacy file with no retry prompt.
			if (retired) {
				try {
					await fs.promises.rm(`${settingsJsonPath}.pending-retirement`, { force: true });
				} catch {}
			}
		}
	}

	/**
	 * One-time migration of the machine-global config-root `settings.json`
	 * (`<configRoot>/settings.json`, normally `~/.gjc/settings.json`) workflow
	 * keys into the environment-selected global agent `config.yml` — the
	 * `GJC_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR` profile when set, else the
	 * default `<configRoot>/agent/config.yml`. Runs only for the global agent
	 * scope (an explicitly supplied temporary agentDir such as an SDK session
	 * must never consume the machine-global source), inside one critical
	 * section on the target config lock, and migrates only the five workflow
	 * keys that the workflow runtimes read.
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
		// Strengthened pairing gate: only the GLOBAL agent scope may consume the
		// machine-global source. That includes an environment-selected non-default
		// profile (GJC_CODING_AGENT_DIR / PI_CODING_AGENT_DIR); a custom/temporary
		// agentDir (`Settings.loadForScope` for SDK or tests) must never touch it.
		if (!this.#isGlobalAgentScope()) return;

		const source = path.resolve(getConfigRootDir(), "settings.json");
		const backup = `${source}.bak`;
		const markerPath = `${source}.migrated`;
		const target = path.resolve(this.#configPath);
		// If the config root is literally the agent dir, the agent-dir migration
		// already owns this physical source; never double-rename it. When that
		// migration has ALREADY run (the agent config.yml exists) it leaves the
		// orphan source's workflow keys unmigrated, so this migration must still
		// copy them (and retire the orphan).
		if (source === path.resolve(path.join(this.#agentDir, "settings.json"))) {
			if (!(await this.#pathExists(this.#configPath))) return;
			this.#warnLegacyFallbackMigration(
				`Settings: config-root workflow migration source ${source} is the agent-dir settings file with an existing agent config.yml; migrating the workflow keys and retiring the orphan source`,
			);
		}
		// When GJC runs from the config root itself (typically the user's home
		// with the default `.gjc`), the config-root source IS the project source
		// (`<cwd>/.gjc/settings.json`): consuming and retiring it would delete the
		// project's non-workflow settings from discovery (and could remove a
		// tracked dotfiles copy). Defer entirely to the project migration, which
		// keeps the source - but first reconcile the config-root sidecars against
		// the agent target, which the project migration never touches.
		if (await this.#configRootCollidesWithProjectSource(source)) {
			this.#warnLegacyFallbackMigration(
				`Settings: config-root workflow migration skipped: ${source} is also the project settings source; the project migration handles it and the file is preserved`,
			);
			await this.#reconcileConfigRootSidecars(source, target);
			return;
		}

		// Strict-invalid retention evidence is valid only while the source still
		// holds the exact invalid value that caused the abort. A repair, a
		// removal, or a completed migration must clear it so strict resolution
		// stops throwing; a still-invalid value is re-recorded below by the same
		// run's abort.
		await this.#reconcileConfigRootSidecars(source, target);

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
		// Identity of the backup this run created (captured right after the
		// no-replace move): abort paths remove the backup only through the
		// quarantine-based #removeIfStillOurs guard, never by pathname.
		let backupIno: number | null = null;
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
					// A future-schema target is read-only, but the retained legacy
					// source's strict errors must stay observable: the resolver reads
					// config.yml only, so record strict-invalid evidence when the
					// source holds invalid ralplan values or is malformed.
					await this.#retainStrictErrorsFromSource(source, `${source}.strict-invalid`);
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
					// The legacy source is RETIRED once the migration completes:
					// config.yml is the only settings surface and the resolver never
					// reads settings.json. A crash between the complete-marker
					// publication and the source quarantine leaves the legacy file
					// behind, where later user edits are silently ineffective and the
					// documented cleanup never completes; retire the surviving
					// revision idempotently here (only bytes matching the marker's
					// recorded hash, so a concurrent replacement is never deleted). A
					// POST-COMPLETION RECREATION is preserved: a user who unsets a
					// migrated key and restores settings.json from the .bak produces a
					// byte-identical file, so retire only while the target still
					// satisfies the completed marker's migrated keys.
					if (
						(await this.#pathExists(source)) &&
						(await this.#workflowMigrationTargetSatisfies(tx.root, marker))
					) {
						await this.#retireConfigRootSource(source, marker.sourceSha256);
					}
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
						// Identity of the verified backup revision (captured inside
						// the try): the removal below must quarantine and re-verify
						// before unlinking, because another process can replace the
						// backup while the recovery patches the target.
						let deletionBackupIno: number | null = null;
						// Verified revision hash (captured inside the try); used by
						// the guarded removal below.
						let deletionBackupHash: string | null = null;
						try {
							const deletionBackupRead = await this.#readBackupBytes(backup);
							deletionBackupHash = nodeCrypto
								.createHash("sha256")
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
							deletionBackupIno = (await fs.promises.stat(backup).catch(() => null))?.ino ?? null;
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
									nodeCrypto.createHash("sha256").update(JSON.stringify(targetValue.value)).digest("hex") ===
										marker.repairValueHashes[key] &&
									marker.repairsApplied === true)
							) {
								markerOwnedUnsets.push({ path: key, op: "unset" });
								if (Object.hasOwn(tx.root as Record<string, unknown>, key)) markerFlatKeys.push(key);
							}
						}
						await tx.applyPatchesAndRemoveTopLevelKeys(markerOwnedUnsets, markerFlatKeys);
						if (deletionBackupIno !== null && deletionBackupHash !== null) {
							await this.#removeIfStillOurs(backup, deletionBackupIno, deletionBackupHash);
						}
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
						const backupHash = nodeCrypto
							.createHash("sha256")
							.update(Buffer.from(pendingBackupRead.bytes))
							.digest("hex");
						// Capture the identity of the verified backup revision so the
						// recovery removal below can quarantine and re-verify before
						// unlinking (another process can replace the backup while
						// the target patches are applied).
						const pendingBackupIno = (await fs.promises.stat(backup).catch(() => null))?.ino ?? null;
						// (Reconciliation of an edited legacy source after completion is
						// obsolete: settings.json is retired, so a hash mismatch simply
						// falls through to the mismatch branch below.)
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
								if (pendingBackupIno !== null) {
									await this.#removeIfStillOurs(backup, pendingBackupIno, backupHash);
								}
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
				} catch (error) {
					// An EXISTING but unreadable source (EACCES, EIO) must keep the
					// strict error observable: record malformed evidence so the
					// direct command fails loudly instead of silently defaulting.
					if (!isEnoent(error)) {
						await this.#recordConfigRootMalformedEvidence(tx, source);
					}
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration could not read ${source}; leaving untouched`,
					);
					return;
				}
				const sourceSha256 = nodeCrypto.createHash("sha256").update(sourceRaw).digest("hex");
				let sourceDoc: unknown;
				try {
					sourceDoc = JSON.parse(sourceRaw);
				} catch {
					if (await this.#configRootSourceMatches(source, sourceSha256)) {
						await this.#recordConfigRootMalformedEvidence(tx, source);
					}
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
							const staleBackupHash = nodeCrypto
								.createHash("sha256")
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
							const targetHash = nodeCrypto
								.createHash("sha256")
								.update(JSON.stringify(targetValue.value))
								.digest("hex");
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
					if (await this.#configRootSourceMatches(source, sourceSha256)) {
						await this.#recordConfigRootMalformedEvidence(tx, source);
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
				// Every unresolved STRICT ralplan key is collected across the loop and
				// written to ONE evidence file after it, so a shared file records all
				// of them (the project migration does the same); a per-key write on
				// the first abort would leave later keys silently defaulting.
				const invalidStrictKeys: { key: WorkflowSettingKey; value: unknown }[] = [];
				for (const key of CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS) {
					// Only keys the crashed run actually recorded are migration-owned
					// in the changed-pending window: they may be reapplied, unset, or
					// overridden by the current source, but a key the marker did NOT
					// record was skipped because config.yml already held a valid
					// higher-precedence user value, which must never be clobbered.
					const staleMarkerKey = stalePendingOverride && marker?.migratedKeys.includes(key);
					const extracted = extractWorkflowSetting(sourceDoc, key);
					if (extracted.malformedParent) {
						if (!key.startsWith("gjc.ralplan.")) {
							// A malformed parent for a TOLERANT workflow key is ignored
							// like any other invalid tolerant value (the tolerant
							// runtime falls back); only strict ralplan keys must fail
							// loudly, so never write a global malformed marker for it.
							continue;
						}
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
									const staleHash = nodeCrypto
										.createHash("sha256")
										.update(Buffer.from(staleRead.bytes))
										.digest("hex");
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
								const ownedHash = nodeCrypto
									.createHash("sha256")
									.update(JSON.stringify(ownedValue.value))
									.digest("hex");
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
						if (await this.#configRootSourceMatches(source, sourceSha256)) {
							await this.#recordConfigRootMalformedEvidence(tx, source);
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
									const removedKeyHash = nodeCrypto
										.createHash("sha256")
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
								const removedKeyTargetHash = nodeCrypto
									.createHash("sha256")
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
							invalidStrictKeys.push({ key, value: extracted.value });
							this.#warnLegacyFallbackMigration(
								`Settings: config-root workflow migration aborted: invalid strict ralplan value for ${key} in ${source}; keeping the legacy source active so gjc ralplan still fails loudly`,
							);
							continue;
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

				// ALL unresolved strict keys were collected above; write ONE evidence
				// file recording every one of them, then abort so the legacy source
				// stays active and strict ralplan keeps failing loudly for each key.
				if (invalidStrictKeys.length > 0) {
					// Revalidate the source before retaining evidence: an editor may
					// repair or replace settings.json while the migration runs, and
					// stale evidence would make the direct command exit 2 for a
					// now-valid source.
					if (!(await this.#configRootSourceMatches(source, sourceSha256))) {
						this.#warnLegacyFallbackMigration(
							`Settings: config-root workflow migration aborted without evidence: ${source} changed while retaining strict errors`,
						);
						return;
					}
					const evidenceOk = await this.#writeStrictInvalidEvidence(
						`${source}.strict-invalid`,
						source,
						invalidStrictKeys,
					);
					if (!evidenceOk) {
						// Read-only fallback: persist the invalid values into the target
						// config.yml (the only surface the strict resolver reads) so the
						// exit-2 error stays observable when the evidence cannot be
						// written. Only ABSENT target keys get fallback values: a
						// present-but-invalid user-authored value already keeps exit-2
						// observable on its own, and overwriting it would destroy the
						// user's configuration when the fallback is later cleaned up or
						// rolled back.
						const fallbackEntries = invalidStrictKeys.filter(retained => {
							const targetValue = extractWorkflowSetting(tx.root, retained.key, { flat: false });
							return !targetValue.malformedParent && !targetValue.present;
						});
						if (fallbackEntries.length > 0) {
							// Publish the ownership marker BEFORE the values: a crash between
							// the two leaves the marker (and no values), never values without
							// a marker the next load could not identify or clean up. Without
							// the marker, skip the values - an untracked fallback would exit
							// 2 forever with no way to clear it.
							const fallbackMarkerOk = await this.#writeFallbackInvalidKeys(
								source,
								await this.#mergeFallbackInvalidKeys(
									source,
									fallbackEntries,
									this.#configRootFallbackInvalidMarkerPath(source),
								),
								this.#configRootFallbackInvalidMarkerPath(source),
							);
							if (fallbackMarkerOk) {
								this.#warnLegacyFallbackMigration(
									`Settings: config-root workflow migration persisted strict-invalid values into ${target} as fallback evidence`,
								);
								await tx.applyPatches(
									fallbackEntries.map(retained => ({
										path: retained.key,
										op: "set" as const,
										value: retained.value,
									})),
								);
							} else {
								this.#warnLegacyFallbackMigration(
									`Settings: config-root workflow migration could not track strict-invalid fallback values; skipping the fallback`,
								);
							}
						}
					}
					return;
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
					if (backupIno !== null) await this.#removeIfStillOurs(backup, backupIno, sourceSha256);
					await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
					this.#warnLegacyFallbackMigration(
						`Settings: config-root workflow migration aborted: ${source} was deleted during migration; target reverted, ${backupCreatedByThisRun ? "backup removed" : "external backup preserved"}, marker cleared`,
					);
					return;
				}
				if (preMoveSourceHash !== sourceSha256) {
					await tx.replaceCurrent(prePatchTargetSnapshot);
					if (backupIno !== null) await this.#removeIfStillOurs(backup, backupIno, sourceSha256);
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
				// Capture the backup's inode for the guarded removals below. The
				// copy is byte-identical to the verified source at this point
				// (the move re-hashed the source before completing), so the
				// expected sha is sourceSha256 and the inode identifies the file
				// this run created; a backup replaced or edited afterwards fails
				// the guard and is preserved.
				try {
					backupIno = (await fs.promises.stat(backup)).ino;
				} catch {
					// The backup vanished right after the move; nothing of ours
					// to remove on the abort paths.
					backupIno = null;
				}

				// The source may have been edited in the narrow window after the
				// pre-move check but before/during the move; verify the bytes we
				// actually moved. The source is kept ACTIVE on every path, so on
				// mismatch the edit is already live: revert the target and remove
				// the now-superseded backup so the next load sees pending + source
				// + no backup and re-runs the fresh transaction against the edited
				// file (never completing behind a stale hash).
				if ((await this.#sha256File(backup)) !== sourceSha256) {
					await tx.replaceCurrent(prePatchTargetSnapshot);
					if (backupIno !== null) await this.#removeIfStillOurs(backup, backupIno, sourceSha256);
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
						if (backupIno !== null) await this.#removeIfStillOurs(backup, backupIno, sourceSha256);
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
					if (backupIno !== null) await this.#removeIfStillOurs(backup, backupIno, sourceSha256);
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
				// The legacy source is RETIRED once the migration completes: the
				// resolver no longer reads settings.json (config.yml is the only
				// settings surface), so a surviving copy - the copy-fallback keeps
				// the source active - is removed here. The migration's own .bak
				// remains as the user-data backup. Strict-invalid evidence is cleared
				// too: the retained invalid state no longer exists, so strict
				// resolution must stop throwing.
				await this.#retireConfigRootSource(source, sourceSha256);
				await fs.promises.rm(`${source}.strict-invalid`, { force: true }).catch(() => undefined);
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

	/**
	 * One-time copy of the PROJECT `.gjc/settings.json` workflow keys into the
	 * project `.gjc/config.yml` (absent-only). The workflow resolver reads
	 * config.yml only, so a project that still stores its ralplan/
	 * deep-interview/ultragoal overrides in the legacy file would silently fall
	 * back to defaults after the config.yml-only switch without this copy.
	 *
	 * Unlike the config-root migration the source file is NOT retired here: the
	 * project settings.json remains a live discovery surface for its non-workflow
	 * settings, so the copy is idempotent (absent-only patches) rather than
	 * consume-once. A later edit of a workflow key in the legacy file is ignored
	 * once config.yml holds the migrated value, matching the "migrate once, then
	 * config.yml is the only workflow surface" contract.
	 *
	 * Runs inside Settings load so both the session path and the direct workflow
	 * commands (which trigger Settings via {@link ensureWorkflowSettingsMigrated})
	 * migrate before any resolver reads config.yml.
	 */
	async #migrateProjectWorkflowSettings(): Promise<void> {
		const projectDir = path.resolve(this.#cwd, ".gjc");
		const source = path.resolve(projectDir, "settings.json");
		const target = path.resolve(projectDir, "config.yml");

		// Strict-invalid retention evidence is valid only while the source still
		// holds the exact invalid value that produced it; a repair or a removal
		// must clear it so strict resolution stops throwing. Runs before the
		// source-existence short-circuit so a deleted source also clears it.
		const evidencePath = this.#projectStrictInvalidEvidencePath(source);
		const retainedEvidence = await this.#readStrictInvalidEvidence(evidencePath);
		if (retainedEvidence) {
			try {
				// Prune to the still-invalid keys: repairing ONE recorded key must
				// not drop the evidence for the remaining unresolved keys. Runs
				// under the target lock so a concurrent process's evidence
				// publication serializes with this prune.
				await withAtomicYamlConfigTransaction(target, async () => {
					await this.#pruneStrictInvalidEvidence(source, evidencePath, retainedEvidence);
				});
			} catch {
				// Transient source read failure: retain the evidence sidecar.
			}
		}

		// Fallback-invalid cleanup: config.yml values persisted as fallback
		// evidence are removed when the source no longer holds the invalid value
		// (key deleted or settings.json removed), so exit 2 does not persist.
		await this.#clearStaleFallbackInvalidKeys(source, target);

		if (!(await this.#pathExists(source))) return;

		let raw: string;
		try {
			raw = await Bun.file(source).text();
		} catch (error) {
			if (isEnoent(error)) return;
			// An EXISTING but unreadable source (EACCES, EIO) must keep the strict
			// error observable: record malformed evidence so the direct command
			// fails loudly instead of silently using config.yml/defaults.
			await this.#recordProjectMalformedEvidence(source, target);
			this.#warnLegacyFallbackMigration(
				`Settings: project workflow migration could not read ${source}; recorded malformed evidence`,
			);
			return;
		}
		let document: unknown;
		try {
			document = JSON.parse(raw);
		} catch {
			await this.#recordProjectMalformedEvidence(source, target);
			this.#warnLegacyFallbackMigration(
				`Settings: project workflow migration found malformed JSON in ${source}; leaving untouched`,
			);
			return;
		}
		if (!document || typeof document !== "object" || Array.isArray(document)) {
			await this.#recordProjectMalformedEvidence(source, target);
			this.#warnLegacyFallbackMigration(
				`Settings: project workflow migration found a malformed root in ${source}; leaving untouched`,
			);
			return;
		}

		const migratedKeys = await this.#readProjectMigratedKeys(source);
		const patches: AtomicYamlPatch[] = [];
		const invalidStrictKeys: { key: WorkflowSettingKey; value: unknown }[] = [];
		for (const key of CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS) {
			// A key already recorded as migrated is owned by config.yml: never
			// re-import it, even when the target key is absent (e.g. after
			// `gjc config unset`), so removing a migrated override sticks instead
			// of the stale legacy value being copied back on the next load.
			if (migratedKeys.has(key)) continue;
			const extracted = extractWorkflowSetting(document as Record<string, unknown>, key);
			if (extracted.malformedParent) {
				if (!key.startsWith("gjc.ralplan.")) continue;
				// A non-mapping workflow parent (e.g. `gjc.ralplan: "broken"`) is
				// malformed legacy JSON that strict ralplan must fail on (exit 2);
				// record malformed evidence so the strict resolver surfaces it
				// instead of silently defaulting, and abort the migration. A
				// malformed parent for a TOLERANT key is skipped like any other
				// invalid tolerant value - never a global strict marker.
				await this.#recordProjectMalformedEvidence(source, target);
				this.#warnLegacyFallbackMigration(
					`Settings: project workflow migration retained a malformed parent in ${source} for ${key}`,
				);
				return;
			}
			if (!extracted.present) continue;
			const value = this.#coerceWorkflowScalar(key, extracted.value);
			if (!this.#workflowKeyValueIsValid(key, value)) {
				if (key.startsWith("gjc.ralplan.")) {
					// Strict ralplan keys must fail loudly while the retained legacy
					// value is invalid (the resolver reads config.yml only): record
					// project-layer evidence instead of silently skipping, mirroring
					// the config-root strict path.
					invalidStrictKeys.push({ key, value: extracted.value });
					this.#warnLegacyFallbackMigration(
						`Settings: project workflow migration retained invalid strict value for ${key} in ${source}`,
					);
					continue;
				}
				this.#warnLegacyFallbackMigration(
					`Settings: project workflow migration skipped invalid value for ${key} in ${source}`,
				);
				continue;
			}
			patches.push({ path: key, op: "set", value });
		}
		if (patches.length === 0 && invalidStrictKeys.length === 0) return;

		// Keys this run records as migrated: present in the target (either
		// already there from an earlier run whose marker was lost, or copied by
		// this run's commit). Written to the marker only after a successful
		// publication - never on an abort or a rollback.
		let newlyOwned: WorkflowSettingKey[] = [];
		let rollbackRequired = false;
		let absent: AtomicYamlPatch[] = [];
		// Pre-publication target states, captured inside the transaction right
		// before the write and reused by the post-transaction recovery rollback.
		let beforeStates: Map<string, ProjectTargetBeforeState> = new Map();
		try {
			await withAtomicYamlConfigTransaction(target, async tx => {
				// A target that did not exist when this transaction read it was
				// CREATED by this run's publication. If the run must roll back, the
				// rollback leaves an empty config.yml behind, and the resolver treats
				// any existing non-future target as authoritative - which would
				// disable the retained settings.json fallback while the marker stays
				// unwritable. Track it so the rollback can remove the created file.
				const targetWasAbsent = tx.root === undefined;
				// A config.yml written by a NEWER schema version is intentionally
				// read-only across Settings; never patch it (mirrors the config-root
				// migration guard) so a future schema cannot inherit stale keys.
				const targetSchemaVersion = (tx.root as Record<string, unknown> | null | undefined)?.configSchemaVersion;
				if (typeof targetSchemaVersion === "number" && targetSchemaVersion > CONFIG_SCHEMA_VERSION) {
					this.#warnLegacyFallbackMigration(
						`Settings: project workflow migration skipped: ${target} is a future config schema (configSchemaVersion ${targetSchemaVersion} > ${CONFIG_SCHEMA_VERSION})`,
					);
					// A future-schema target is read-only, but the retained legacy
					// source's strict errors must stay observable: the resolver reads
					// config.yml only, so record strict-invalid evidence when the
					// source holds invalid ralplan values or is malformed.
					await this.#retainStrictErrorsFromSource(source, this.#projectStrictInvalidEvidencePath(source));
					return;
				}
				// A project config.yml whose root is a scalar/array/null is malformed
				// user data: patching would replace the whole document with the
				// migrated mapping. Abort, mirroring the config-root migration's
				// root-shape guard, instead of destroying the user's configuration.
				if (tx.root !== undefined && (tx.root === null || typeof tx.root !== "object" || Array.isArray(tx.root))) {
					this.#warnLegacyFallbackMigration(
						`Settings: project workflow migration target ${target} has a non-object or null YAML root; not migrating`,
					);
					return;
				}
				// A non-mapping parent in the project config.yml (e.g.
				// `gjc: "repair-me"` or `gjc: { ralplan: [] }`) is malformed user
				// data; patching would silently replace it. Abort the migration,
				// mirroring the config-root guard, instead of treating the malformed
				// parent as an absent key.
				for (const patch of patches) {
					if (extractWorkflowSetting(tx.root, patch.path as WorkflowSettingKey, { flat: false }).malformedParent) {
						this.#warnLegacyFallbackMigration(
							`Settings: project workflow migration aborted: ${target} has a non-mapping parent for ${patch.path}; leaving untouched`,
						);
						return;
					}
				}
				// Revalidate the source BEFORE any side effect (evidence write, target
				// patch): evidence must never be written from bytes the source no
				// longer holds - an invalid-only migration returns right after the
				// evidence write, so a stale evidence file would make the direct
				// command exit 2 even after the source was repaired.
				const sourceChanged = async (): Promise<boolean> => {
					const currentRaw = await Bun.file(source)
						.text()
						.catch((error: unknown) => {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
							throw error;
						});
					return currentRaw !== raw;
				};
				if (await sourceChanged()) {
					this.#warnLegacyFallbackMigration(
						`Settings: project workflow migration aborted: ${source} changed while migrating; leaving untouched`,
					);
					return;
				}
				// A retained invalid strict ralplan key fails loudly only when the
				// project config.yml has no valid override for it (a valid target
				// value wins at the project layer). Decide the COMPLETE unresolved
				// set first, then write ONE evidence file carrying every unresolved
				// key - a per-key write-then-delete would let a later key's cleanup
				// drop an earlier key's evidence.
				const shadowedInvalidKeys: WorkflowSettingKey[] = [];
				const unresolved = invalidStrictKeys.filter(retained => {
					const targetValue = extractWorkflowSetting(tx.root, retained.key, { flat: false });
					const shadowed =
						!targetValue.malformedParent &&
						targetValue.present &&
						this.#workflowKeyValueIsValid(retained.key, targetValue.value);
					// A strict key shadowed by a valid project target is TOLERATED
					// (no exit 2 while the target wins), but it must still be
					// recorded as owned: the retained legacy source keeps the file
					// for non-workflow settings, and without ownership a later
					// `gjc config unset` of the target value would resurrect the
					// invalid legacy value and exit 2 (mirroring the config-root
					// path, where the source is retired so the value is gone).
					if (shadowed) shadowedInvalidKeys.push(retained.key);
					return !shadowed;
				});
				if (unresolved.length === 0) {
					await fs.promises
						.rm(this.#projectStrictInvalidEvidencePath(source), { force: true })
						.catch(() => undefined);
				} else {
					const evidenceOk = await this.#writeStrictInvalidEvidence(
						this.#projectStrictInvalidEvidencePath(source),
						source,
						unresolved,
					);
					if (!evidenceOk) {
						// Read-only fallback: persist the invalid values into the target
						// config.yml (the only surface the strict resolver reads) so the
						// exit-2 error stays observable when the evidence cannot be
						// written. A later valid legacy value repairs them (the absent
						// filter below treats a present-but-invalid target as absent).
						// Only ABSENT target keys get fallback values: a
						// present-but-invalid user-authored value already keeps exit-2
						// observable on its own, and overwriting it would destroy the
						// user's configuration when the fallback is later cleaned up or
						// rolled back.
						const fallbackEntries = unresolved.filter(retained => {
							const targetValue = extractWorkflowSetting(tx.root, retained.key, { flat: false });
							return !targetValue.malformedParent && !targetValue.present;
						});
						if (fallbackEntries.length > 0) {
							// Publish the ownership marker BEFORE the values: a crash between
							// the two leaves the marker (and no values), never values without
							// a marker the next load could not identify or clean up. Without
							// the marker, skip the values - an untracked fallback would exit
							// 2 forever with no way to clear it.
							const fallbackMarkerOk = await this.#writeFallbackInvalidKeys(
								source,
								await this.#mergeFallbackInvalidKeys(source, fallbackEntries),
							);
							if (fallbackMarkerOk) {
								this.#warnLegacyFallbackMigration(
									`Settings: project workflow migration persisted strict-invalid values into ${target} as fallback evidence`,
								);
								await tx.applyPatches(
									fallbackEntries.map(retained => ({
										path: retained.key,
										op: "set" as const,
										value: retained.value,
									})),
								);
							} else {
								this.#warnLegacyFallbackMigration(
									`Settings: project workflow migration could not track strict-invalid fallback values; skipping the fallback`,
								);
							}
						}
					}
				}
				absent = patches.filter(patch => {
					const targetValue = extractWorkflowSetting(tx.root, patch.path as WorkflowSettingKey, { flat: false });
					if (targetValue.malformedParent) return false;
					if (!targetValue.present) return true;
					// A present but INVALID target value (e.g. a fallback-written strict
					// value or an editor's mistake) is repairable: a valid legacy value
					// must win, mirroring the config-root migration's target repair.
					return !this.#workflowKeyValueIsValid(patch.path as WorkflowSettingKey, targetValue.value);
				});
				if (absent.length === 0) {
					// Every valid source key is already present in config.yml (e.g.
					// from an earlier run whose marker was lost): they are owned by
					// config.yml, so record them AND publish the merged marker under
					// the lock before returning - an all-present first load must still
					// create ownership, or a later `gjc config unset` would re-import
					// the stale legacy value.
					newlyOwned = [...patches.map(patch => patch.path as WorkflowSettingKey), ...shadowedInvalidKeys];
					const allPresentMarkerOk = await this.#writeProjectMigratedKeys(
						source,
						await this.#mergeProjectMigratedKeys(source, newlyOwned),
					);
					if (!allPresentMarkerOk) {
						// Ownership could not be durably recorded: without the marker, a
						// later `gjc config unset` would be undone by the retained
						// source. Nothing was published this run (every key was already
						// present), so there is nothing to roll back; surface the
						// failure instead of reporting silent completion - the next
						// load retries the marker publication.
						this.#warnLegacyFallbackMigration(
							`Settings: project workflow migration could not record ownership for ${source}; the migrated-keys marker was not written - a later config removal may be re-imported`,
						);
					}
					return;
				}
				// Re-verify immediately before the publication (the primary gate):
				// the resolver reads config.yml only, so a value edited between the
				// initial read and this write would be committed from stale bytes
				// and then ignored forever (later loads skip keys already present).
				if (await sourceChanged()) {
					this.#warnLegacyFallbackMigration(
						`Settings: project workflow migration aborted: ${source} changed while migrating; leaving untouched`,
					);
					return;
				}
				// Capture each key's pre-publication target state so a rollback can
				// RESTORE repaired keys (present-but-invalid values the migration
				// overwrites with the valid legacy value) instead of unsetting them -
				// an unset would silently delete the user's pre-existing
				// configuration. Keys that were ABSENT before the write are still
				// rolled back by unsetting.
				beforeStates = new Map<string, ProjectTargetBeforeState>();
				for (const patch of absent) {
					const current = extractWorkflowSetting(tx.root, patch.path as WorkflowSettingKey, { flat: false });
					beforeStates.set(patch.path, {
						present: !current.malformedParent && current.present,
						value: current.value,
					});
				}
				const restorePublished = (patches: readonly AtomicYamlPatch[]): AtomicYamlPatch[] =>
					patches.map(patch => {
						const before = beforeStates.get(patch.path);
						return before?.present
							? { path: patch.path, op: "set" as const, value: before.value }
							: { path: patch.path, op: "unset" as const };
					});
				await tx.applyPatches(absent);
				// Close the residual publication window: if an editor replaced the
				// source DURING applyPatches (target CAS, temp write, native
				// publication), roll back the just-published keys so stale values
				// never survive in config.yml; the next load retries with the fresh
				// source. The evidence is cleared too (it was derived from the same
				// stale bytes).
				const rollbackMarkerlessPublication = async (
					reason: string,
					clearStrictEvidence: boolean,
				): Promise<void> => {
					this.#warnLegacyFallbackMigration(
						`Settings: project workflow migration rolled back ${absent.length} written key(s): ${reason}`,
					);
					try {
						await tx.applyPatches(restorePublished(absent));
					} catch {
						// The rollback's whole-file CAS conflicted with an external
						// config.yml edit; recover AFTER the transaction by reopening
						// the target and restoring only values that still match the
						// migration write. An external target edit means the file is no
						// longer ours to remove.
						rollbackRequired = true;
					}
					if (targetWasAbsent && !rollbackRequired) {
						await this.#removeProjectMigrationCreatedTarget(tx.configPath, source);
					}
					// The strict-invalid evidence is cleared ONLY when the SOURCE
					// changed (it was derived from the stale bytes): an ownership-
					// marker failure leaves the source unchanged, so its evidence
					// stays valid and must keep making the exit-2 observable.
					if (clearStrictEvidence) {
						await fs.promises
							.rm(this.#projectStrictInvalidEvidencePath(source), { force: true })
							.catch(() => undefined);
					}
				};
				if (await sourceChanged()) {
					await rollbackMarkerlessPublication(`${source} changed during publication`, true);
					// The source changed while publishing: the rolled-back keys must
					// NOT be recorded as owned, or the newer legacy values would be
					// skipped forever. Stop the transaction callback here; the
					// post-transaction CAS recovery still runs for a conflicted
					// in-transaction rollback.
					return;
				}
				// Record EVERY config-owned key: the valid source keys copied by
				// this run and the pre-existing present-valid keys whose marker was
				// lost, plus strict keys shadowed by a valid project target (their
				// slot is owned by config.yml), so a later unset of any of them is
				// not re-imported from the retained legacy source.
				newlyOwned = [...patches.map(patch => patch.path as WorkflowSettingKey), ...shadowedInvalidKeys];
				// Merge the per-key ownership marker under the config lock: a
				// concurrent migration of the same project may have published its own
				// marker between our initial read and this transaction, so re-read the
				// CURRENT marker and merge instead of last-writer-wins replacement.
				let mergedMarker: readonly WorkflowSettingKey[];
				try {
					await SettingsMigrationTestHooks.beforeProjectMarkerMerge?.();
					mergedMarker = await this.#mergeProjectMigratedKeys(source, newlyOwned);
				} catch (error) {
					// The marker became unreadable between the initial read and this
					// re-read (AFTER the values already committed): ownership cannot
					// be durably recorded, so roll back the just-published keys
					// exactly like a failed marker write - a removed key would
					// otherwise be re-imported once the marker becomes readable
					// again.
					await rollbackMarkerlessPublication(
						`the migrated-keys marker could not be re-read: ${error instanceof Error ? error.message : String(error)}`,
						false,
					);
					return;
				}
				const markerOk = await this.#writeProjectMigratedKeys(source, mergedMarker);
				if (!markerOk) {
					// Ownership could not be durably recorded: without the marker, a
					// later config.yml removal would be undone by the retained source.
					// Undo only the keys THIS RUN wrote - restored repaired keys keep
					// their pre-existing value, newly copied keys are unset (a
					// markerless publication is never complete).
					await rollbackMarkerlessPublication("the migrated-keys marker could not be written", false);
					return;
				}
			});
			// A CAS-conflicted in-transaction rollback left the published stale
			// values in place; recover by reopening the target and unsetting only
			// the migration-published values that still match.
			if (rollbackRequired) {
				await this.#rollbackProjectPublishedKeys(target, absent, source, beforeStates);
			}
			logger.debug("Settings: migrated project workflow settings into config.yml", { path: target });
		} catch (error) {
			// A malformed project config.yml must not abort settings load: the
			// resolver's own diagnostics still run afterwards, and the legacy
			// source stays untouched for the next load to retry.
			this.#warnLegacyFallbackMigration(
				`Settings: project workflow migration could not write ${target}: ${error instanceof Error ? error.message : String(error)}; leaving untouched`,
			);
		}
	}

	/**
	 * Remove a project config.yml that THIS migration run created and then
	 * rolled back. The rollback unsets the published keys but leaves an empty
	 * file behind; because the resolver treats any existing non-future target as
	 * authoritative, that empty file would disable the retained settings.json
	 * fallback. Removing it restores the incomplete-migration state so the next
	 * load (and every retry while the marker stays unwritable) keeps resolving
	 * through the fallback. Only ever called under the target's own file lock
	 * right after the rollback write, and the removal itself is identity-guarded
	 * (an external editor that does not participate in the lock can atomically
	 * replace the file, and that replacement must never be deleted).
	 */
	async #removeProjectMigrationCreatedTarget(canonicalTarget: string, source: string): Promise<void> {
		if (await this.#removeFileOnlyIfUnchanged(canonicalTarget)) {
			this.#warnLegacyFallbackMigration(
				`Settings: project workflow migration removed the config.yml it created during rollback so the retained ${source} fallback stays active`,
			);
			return;
		}
		this.#warnLegacyFallbackMigration(
			`Settings: project workflow migration could not remove the config.yml it created during rollback; a replaced or retained file is left in place`,
		);
	}

	/**
	 * Remove a file only when it is still the exact file observed here. An
	 * external process (an editor that ignores the config lock, or a concurrent
	 * loader publishing evidence) can atomically replace a path between this
	 * run's decision and a pathname removal, so the file is first renamed to a
	 * unique tombstone in the same directory (atomic), the moved file's inode
	 * identity is verified against the observation, and only a matching file is
	 * unlinked. A replaced file is renamed back to its path, never deleted.
	 * Returns true when the observed file is gone (removed or already absent),
	 * false when a replaced or immovable file was left in place.
	 */
	async #removeFileOnlyIfUnchanged(filePath: string): Promise<boolean> {
		let expected: { dev: bigint; ino: bigint };
		try {
			const stat = await fs.promises.stat(filePath, { bigint: true });
			expected = { dev: stat.dev, ino: stat.ino };
		} catch {
			return true; // already gone: nothing to remove
		}
		const tombstone = `${filePath}.gjc-remove-${nodeCrypto.randomUUID()}`;
		try {
			await fs.promises.rename(filePath, tombstone);
		} catch (error) {
			if (isEnoent(error)) return true;
			return false; // could not move: leave in place
		}
		let moved: { dev: bigint; ino: bigint } | null = null;
		try {
			const stat = await fs.promises.lstat(tombstone, { bigint: true });
			moved = { dev: stat.dev, ino: stat.ino };
		} catch {
			return true; // the moved file already disappeared
		}
		if (moved.dev !== expected.dev || moved.ino !== expected.ino) {
			// The rename moved a file an external process replaced after the
			// identity capture: restore it WITHOUT replacing a file published
			// while the path was absent (hard-link no-replace; EEXIST keeps the
			// newest file and retains the tombstone for recovery).
			try {
				await fs.promises.link(tombstone, filePath);
				await fs.promises.rm(tombstone, { force: true }).catch(() => undefined);
			} catch {
				// The path is occupied (EEXIST) or linking failed: keep the newest
				// file and retain the tombstone (recoverable).
			}
			return false;
		}
		await fs.promises.rm(tombstone, { force: true }).catch(() => undefined);
		return true;
	}

	/**
	 * Project strict-invalid evidence lives under the ignored runtime dir
	 * `.gjc/state/` so running GJC never dirties the user's git worktree; the
	 * config-root evidence stays next to its machine-global source (outside any
	 * repository).
	 */
	#projectStrictInvalidEvidencePath(source: string): string {
		return path.join(path.dirname(source), "state", "settings.json.strict-invalid");
	}

	/**
	 * Record malformed-source strict evidence for the project migration; when the
	 * evidence sidecar (`.gjc/state/`) cannot be written, fall back to persisting
	 * invalid placeholder values into the project config.yml so the ralplan exit-2
	 * error stays observable either way.
	 */
	async #recordProjectMalformedEvidence(source: string, target: string): Promise<void> {
		// Revalidate the source revision right before publishing: a repair or
		// replacement after the read/parse failure must not leave a stale global
		// malformed marker - the config-only resolver would exit 2 for an
		// already-valid source.
		if (!(await this.#sourceStillMalformed(source, null))) return;
		// When EVERY strict ralplan key is already owned by config.yml (recorded
		// in the migrated-keys marker), the retained source's corruption is
		// irrelevant: a deliberate `gjc config unset` of an owned key must keep
		// falling through to the lower layer/default instead of exiting 2 on a
		// stale global malformed marker. Partial ownership still publishes the
		// marker (the unowned strict keys' errors must stay observable).
		if (await this.#allProjectStrictKeysMigrated(source)) return;
		if (
			await this.#writeStrictInvalidEvidence(this.#projectStrictInvalidEvidencePath(source), source, [], {
				malformed: true,
			})
		) {
			return;
		}
		await this.#persistProjectMalformedStrictFallback(source, target);
	}

	/**
	 * True when every strict ralplan key the project source could contribute is
	 * already recorded in the project migrated-keys ownership marker.
	 */
	async #allProjectStrictKeysMigrated(source: string): Promise<boolean> {
		const owned = await this.#readProjectMigratedKeys(source);
		return CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS.filter(key => key.startsWith("gjc.ralplan.")).every(key =>
			owned.has(key),
		);
	}

	/**
	 * Revalidate that the retained project source is STILL malformed in the same
	 * sense the caller observed (unreadable, unparseable, non-object root, or a
	 * non-mapping strict workflow parent) before recording malformed evidence.
	 */
	/**
	 * True when the retained legacy source is still malformed in the strict
	 * sense: unreadable (non-ENOENT), unparseable, a non-object root, or a
	 * non-mapping strict workflow parent. Used to revalidate a source before
	 * publishing malformed evidence - a repair must not leave a stale marker,
	 * but a structurally malformed revision (e.g. `null`, `[]`, or a broken
	 * `gjc.ralplan` parent) parses as JSON and is NOT a repair.
	 *
	 * Pass `knownRaw` when the bytes were already read to skip the re-read.
	 */
	async #sourceStillMalformed(source: string, knownRaw: string | null): Promise<boolean> {
		let raw: string;
		if (knownRaw !== null) {
			raw = knownRaw;
		} else {
			try {
				raw = await Bun.file(source).text();
			} catch (error) {
				return !isEnoent(error); // removed: nothing to record
			}
		}
		let document: unknown;
		try {
			document = JSON.parse(raw);
		} catch {
			return true; // still unparseable
		}
		if (!document || typeof document !== "object" || Array.isArray(document)) return true;
		for (const key of CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS) {
			if (!key.startsWith("gjc.ralplan.")) continue;
			if (extractWorkflowSetting(document as Record<string, unknown>, key).malformedParent) return true;
		}
		return false; // parses to a valid object with well-formed parents
	}

	/**
	 * Fallback for a malformed or unreadable legacy project source whose strict
	 * evidence sidecar could not be written: persist guaranteed-invalid placeholder
	 * values for the strict ralplan keys into the project config.yml (the only
	 * surface the strict resolver reads) so `gjc ralplan` keeps exiting 2 while
	 * the source is malformed. The fallback is tracked by the fallback-invalid
	 * marker (writable next to the source even when `.gjc/state/` is not) and is
	 * removed once the source is repaired.
	 */
	async #persistProjectMalformedStrictFallback(source: string, target: string): Promise<void> {
		try {
			await withAtomicYamlConfigTransaction(target, async tx => {
				await this.#persistMalformedStrictFallbackInTx(tx, source);
			});
		} catch (error) {
			this.#warnLegacyFallbackMigration(
				`Settings: project workflow migration could not persist malformed-source strict fallback into ${target}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Record malformed-source strict evidence for the config-root migration and,
	 * when the evidence sidecar (`${source}.strict-invalid`) cannot be written,
	 * fall back to persisting invalid placeholders into the target agent config.yml
	 * inside the CURRENT transaction (the config-root malformed branches run under
	 * the target lock, so a nested transaction would deadlock the queue).
	 */
	async #recordConfigRootMalformedEvidence(tx: AtomicYamlConfigTransaction, source: string): Promise<void> {
		// Revalidate the source revision right before publishing: a repair or
		// replacement after the caller's read/hash check must not leave a stale
		// global malformed marker (or invalid fallback placeholders) - the
		// config-only resolver would exit 2 for an already-valid source.
		if (!(await this.#sourceStillMalformed(source, null))) return;
		if (await this.#writeStrictInvalidEvidence(`${source}.strict-invalid`, source, [], { malformed: true })) {
			return;
		}
		await this.#persistMalformedStrictFallbackInTx(tx, source, this.#configRootFallbackInvalidMarkerPath(source));
	}

	/**
	 * Persist guaranteed-invalid placeholder values for the strict ralplan keys
	 * into the target config.yml inside an already-held transaction. Mirrors the
	 * main migrations' target guards (never patch a future schema or a malformed
	 * root) and never overwrites a PRESENT target value: a valid value wins
	 * outright, and an invalid value already keeps the exit-2 error observable on
	 * its own - replacing it with a placeholder (and later unsetting it on marker
	 * failure or repair) would destroy the user's pre-existing configuration.
	 */
	async #persistMalformedStrictFallbackInTx(
		tx: AtomicYamlConfigTransaction,
		source: string,
		markerPath = `${source}.fallback-invalid`,
	): Promise<void> {
		const targetSchemaVersion = (tx.root as Record<string, unknown> | null | undefined)?.configSchemaVersion;
		if (typeof targetSchemaVersion === "number" && targetSchemaVersion > CONFIG_SCHEMA_VERSION) return;
		if (tx.root !== undefined && (tx.root === null || typeof tx.root !== "object" || Array.isArray(tx.root))) {
			return;
		}
		const placeholders: StrictInvalidEvidenceEntry[] = [];
		for (const { key, value } of MALFORMED_SOURCE_STRICT_FALLBACK) {
			const current = extractWorkflowSetting(tx.root, key, { flat: false });
			if (current.malformedParent) continue;
			if (current.present) continue;
			placeholders.push({ key, value });
		}
		if (placeholders.length === 0) return;
		// Publish the ownership marker BEFORE the values: a crash between the two
		// leaves the marker (and no values), never values without a marker the next
		// load could not identify or clean up. Without the marker, skip the values -
		// an untracked fallback would exit 2 forever with no way to clear it.
		const markerOk = await this.#writeFallbackInvalidKeys(
			source,
			await this.#mergeFallbackInvalidKeys(source, placeholders, markerPath),
			markerPath,
		);
		if (!markerOk) {
			this.#warnLegacyFallbackMigration(
				`Settings: workflow migration could not track malformed-source strict fallback values; skipping the fallback`,
			);
			return;
		}
		await tx.applyPatches(placeholders.map(entry => ({ path: entry.key, op: "set" as const, value: entry.value })));
	}

	/**
	 * Persist strict-invalid retention evidence: when a migration aborts on an
	 * invalid STRICT ralplan legacy value (or a malformed source) it keeps the
	 * source active so `gjc ralplan` can still fail loudly, but the resolver
	 * never reads the retained source. This evidence file is the durable record
	 * the resolver's strict path throws on, so the retained value is surfaced
	 * instead of silently falling back to defaults. The file carries the complete
	 * set of unresolved strict keys (or a malformed-source marker) so one file
	 * cannot shadow another key's evidence. Returns false when the evidence could
	 * not be written (callers must keep the strict error observable some other
	 * way, e.g. by persisting the invalid values into config.yml).
	 */
	async #writeStrictInvalidEvidence(
		evidencePath: string,
		source: string,
		entries: readonly StrictInvalidEvidenceEntry[],
		options: { malformed?: boolean } = {},
	): Promise<boolean> {
		const payload = options.malformed
			? JSON.stringify({ version: 2, malformed: true, source: path.resolve(source) }, null, 2)
			: JSON.stringify(
					{
						version: 2,
						keys: entries.map(entry => ({ key: entry.key, value: entry.value })),
						source: path.resolve(source),
					},
					null,
					2,
				);
		// Publish atomically (stage + sync + rename): a direct in-place write
		// could truncate the live evidence file before the replacement payload
		// is durable, and readRetainedStrictEvidence would then read malformed
		// JSON as no evidence - the still-invalid strict key would silently fall
		// through to defaults instead of preserving exit 2.
		const tempPath = `${evidencePath}.${nodeCrypto.randomUUID()}.tmp`;
		try {
			await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
			const tempHandle = await fs.promises.open(tempPath, "wx", 0o600);
			try {
				await tempHandle.writeFile(payload, "utf8");
				await tempHandle.sync();
			} finally {
				await tempHandle.close();
			}
			await fs.promises.rename(tempPath, evidencePath);
			// Durable publication: sync the parent directory so the rename survives
			// a host crash. Best-effort: platforms/filesystems that reject directory
			// sync are ignored.
			try {
				const dirHandle = await fs.promises.open(path.dirname(evidencePath), "r");
				try {
					await dirHandle.sync();
				} finally {
					await dirHandle.close();
				}
			} catch {
				// Unsupported directory sync: ignore.
			}
			return true;
		} catch (error) {
			await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
			this.#warnLegacyFallbackMigration(
				`Settings: workflow migration could not write strict-invalid evidence at ${evidencePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	/**
	 * Read strict-invalid retention evidence. Returns null when absent or
	 * structurally invalid; an evidence file with no recorded key for the
	 * relevant workflow key is treated as null so it never affects other keys.
	 */
	async #readStrictInvalidEvidence(evidencePath: string): Promise<StrictInvalidEvidence | null> {
		let raw: string;
		try {
			raw = await Bun.file(evidencePath).text();
		} catch {
			return null;
		}
		try {
			const parsed = JSON.parse(raw) as {
				version?: unknown;
				malformed?: unknown;
				key?: unknown;
				value?: unknown;
				keys?: unknown;
				source?: unknown;
			};
			const source = typeof parsed.source === "string" ? parsed.source : evidencePath;
			if (parsed.malformed === true) {
				return { version: 2, malformed: true, source };
			}
			if (parsed.version === 2 && Array.isArray(parsed.keys)) {
				const keys: StrictInvalidEvidenceEntry[] = [];
				for (const rawEntry of parsed.keys) {
					if (!rawEntry || typeof rawEntry !== "object") continue;
					const entry = rawEntry as { key?: unknown; value?: unknown };
					if (
						typeof entry.key === "string" &&
						(CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS as readonly string[]).includes(entry.key)
					) {
						keys.push({ key: entry.key as WorkflowSettingKey, value: entry.value });
					}
				}
				if (keys.length === 0) return null;
				return { version: 2, keys, source };
			}
			// v1 single-key compatibility.
			if (
				typeof parsed.key === "string" &&
				(CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS as readonly string[]).includes(parsed.key)
			) {
				return {
					version: 2,
					keys: [{ key: parsed.key as WorkflowSettingKey, value: parsed.value }],
					source,
				};
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Prune strict-invalid retention evidence to the keys that STILL hold in the
	 * source. A v2 file may record several unresolved ralplan keys; repairing ONE
	 * of them must not drop the evidence for the others (their exit-2 would
	 * silently vanish), so the file is rewritten with only the still-invalid
	 * entries and removed entirely only when none remain. Malformed-source
	 * evidence is all-or-nothing: any parseable source (a repair) clears it. A
	 * transient source read failure throws so callers retain the evidence.
	 */
	async #pruneStrictInvalidEvidence(
		source: string,
		evidencePath: string,
		evidence: StrictInvalidEvidence,
	): Promise<void> {
		let raw: string;
		try {
			raw = await Bun.file(source).text();
		} catch (error) {
			// Only a genuine removal (ENOENT) clears the evidence; a transient
			// read failure (EACCES, EIO) must NOT clear it, or the strict error
			// would silently vanish with neither source nor evidence to surface
			// it. Throw so callers retain the evidence.
			if (isEnoent(error)) {
				await fs.promises.rm(evidencePath, { force: true }).catch(() => undefined);
				return;
			}
			throw error;
		}
		if (evidence.malformed) {
			// The malformed marker holds while the source is still malformed; a
			// parseable source (a repair) clears it entirely.
			try {
				JSON.parse(raw);
			} catch {
				return;
			}
			await fs.promises.rm(evidencePath, { force: true }).catch(() => undefined);
			return;
		}
		let document: unknown;
		try {
			document = JSON.parse(raw);
		} catch {
			// The source became malformed: keep the recorded key evidence; the
			// same run's malformed branch re-records it as a malformed marker.
			return;
		}
		if (!document || typeof document !== "object" || Array.isArray(document)) {
			// Structurally invalid root: the recorded values cannot be verified;
			// keep the evidence (the source is still invalid per the resolver).
			return;
		}
		const stillHolding = evidence.keys.filter(entry => {
			const extracted = extractWorkflowSetting(document as Record<string, unknown>, entry.key);
			if (!extracted.present) return false;
			if (JSON.stringify(extracted.value) !== JSON.stringify(entry.value)) return false;
			return !this.#workflowKeyValueIsValid(entry.key, extracted.value);
		});
		const clearedKeys = new Set(evidence.keys.filter(entry => !stillHolding.includes(entry)).map(entry => entry.key));
		// Re-read the CURRENT sidecar right before writing and reconcile with a
		// concurrent publication: remove only the entries this run cleared, while
		// keeping every still-invalid key AND every concurrently-added key (a
		// stale A-only removal must never drop a newer sidecar that added B). The
		// callers additionally hold the target lock, so publications of the same
		// source serialize with this prune.
		const final = new Map<WorkflowSettingKey, unknown>();
		for (const entry of stillHolding) final.set(entry.key, entry.value);
		const current = await this.#readStrictInvalidEvidence(evidencePath);
		if (current?.malformed) {
			// A concurrent loader published a malformed-source marker (the source is
			// now malformed): retain it - it is the stronger evidence, and deleting
			// it here would let the resolver silently fall through to defaults. The
			// next load's prune clears it once the source is parseable again.
			return;
		}
		if (current) {
			for (const entry of current.keys) {
				if (!clearedKeys.has(entry.key)) final.set(entry.key, entry.value);
			}
		}
		if (final.size === 0) {
			// Delete only the exact evidence file this run reconciled: a concurrent
			// loader may publish a NEW malformed marker after the re-read above, and
			// a pathname rm would delete that marker (letting a strict resolver with
			// an existing keyless project config.yml fall through instead of exiting
			// 2). The rename + inode-verify removal deletes only the file observed
			// here; a concurrently-published marker is renamed back and survives.
			await this.#removeFileOnlyIfUnchanged(evidencePath);
			return;
		}
		const finalEntries = [...final].map(([key, value]) => ({ key, value }));
		if (
			finalEntries.length === evidence.keys.length &&
			finalEntries.every((entry, index) => entry.key === evidence.keys[index].key)
		) {
			return; // unchanged (a concurrent run already reconciled)
		}
		await this.#writeStrictInvalidEvidence(evidencePath, source, finalEntries);
	}

	/**
	 * Retain strict errors from a retained legacy source when the migration must
	 * not touch the target (future-schema guard): the resolver reads config.yml
	 * only, so an invalid strict ralplan value or a malformed source must be
	 * recorded as evidence to keep `gjc ralplan` exiting 2 instead of silently
	 * defaulting. Clears stale evidence when the source holds no strict failure.
	 */
	async #retainStrictErrorsFromSource(source: string, evidencePath: string): Promise<boolean> {
		const recordMalformed = async (): Promise<boolean> => {
			// Revalidate the source revision right before publishing: a repair or
			// replacement between the initial read/parse failure and this write
			// must not leave a stale malformed marker - the workflow command's
			// config-only resolver would otherwise exit 2 for an already-repaired
			// source, and a concurrent key-specific publication could be
			// overwritten by this global marker.
			let latest: string;
			try {
				latest = await Bun.file(source).text();
			} catch (error) {
				// Removed (ENOENT): nothing to record. Still unreadable: keep the
				// strict error observable via the malformed marker.
				if (isEnoent(error)) return true;
				const ok = await this.#writeStrictInvalidEvidence(evidencePath, source, [], { malformed: true });
				if (!ok) this.#warnEvidenceNotPreserved(source);
				return ok;
			}
			// Shape-check, not just parseability: a structurally malformed revision
			// (null/array root, non-mapping strict parent) parses as JSON but is
			// NOT a repair - only a valid object with well-formed parents is.
			if (!(await this.#sourceStillMalformed(source, latest))) {
				return true; // repaired since the initial failure: no malformed marker
			}
			// Still malformed: record it.
			const ok = await this.#writeStrictInvalidEvidence(evidencePath, source, [], { malformed: true });
			if (!ok) this.#warnEvidenceNotPreserved(source);
			return ok;
		};
		// Re-read and recompute up to twice: a repair or replacement during the
		// scan must not publish evidence computed from stale bytes.
		for (let attempt = 0; attempt < 2; attempt++) {
			let raw: string;
			try {
				raw = await Bun.file(source).text();
			} catch (error) {
				if (isEnoent(error)) return true;
				// An EXISTING but unreadable source (EACCES, EIO) is a
				// malformed-source strict failure.
				return await recordMalformed();
			}
			let document: unknown;
			try {
				document = JSON.parse(raw);
			} catch {
				return await recordMalformed();
			}
			if (!document || typeof document !== "object" || Array.isArray(document)) {
				return await recordMalformed();
			}
			const invalidStrict: StrictInvalidEvidenceEntry[] = [];
			for (const key of CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS) {
				if (!key.startsWith("gjc.ralplan.")) continue;
				const extracted = extractWorkflowSetting(document as Record<string, unknown>, key);
				if (extracted.malformedParent) {
					// A non-mapping parent for a strict key is a malformed-source
					// strict failure (exit 2).
					return await recordMalformed();
				}
				if (!extracted.present) continue;
				if (!this.#workflowKeyValueIsValid(key, this.#coerceWorkflowScalar(key, extracted.value))) {
					invalidStrict.push({ key, value: extracted.value });
				}
			}
			// Revalidate the source revision right before publishing key-specific
			// evidence: a repair or replacement during the scan must not leave
			// evidence that makes the resolver exit 2 for a now-valid source.
			const latestRaw = await Bun.file(source)
				.text()
				.catch(() => null);
			if (latestRaw === null) {
				// Source removed: clear any stale evidence.
				await fs.promises.rm(evidencePath, { force: true }).catch(() => undefined);
				return true;
			}
			if (latestRaw !== raw) continue; // changed while scanning: recompute
			if (invalidStrict.length === 0) {
				// The source holds no strict failure; clear any stale evidence.
				await fs.promises.rm(evidencePath, { force: true }).catch(() => undefined);
				return true;
			}
			const ok = await this.#writeStrictInvalidEvidence(evidencePath, source, invalidStrict);
			if (!ok) this.#warnEvidenceNotPreserved(source);
			return ok;
		}
		// The source kept changing across both reads; publish nothing rather than
		// stale evidence.
		return true;
	}

	/**
	 * The read-only future-schema target cannot receive fallback placeholders and
	 * the evidence sidecar is unwritable, so the strict error cannot be preserved
	 * on any durable surface; surface the failure instead of silently letting
	 * `gjc ralplan` fall through to defaults.
	 */
	#warnEvidenceNotPreserved(source: string): void {
		this.#warnLegacyFallbackMigration(
			`Settings: strict error could not be preserved for ${source} (evidence unwritable, target read-only); gjc ralplan will use defaults until the source is repaired or the evidence path is writable`,
		);
	}

	/**
	 * Read the project workflow migration's per-key completion marker. A key in
	 * this set is owned by config.yml and is never re-imported from the retained
	 * `.gjc/settings.json`, so removing a migrated override from config.yml
	 * sticks. The marker lives under the ignored runtime dir `.gjc/state/` so a
	 * successful migration never dirties the user's git worktree. A missing or
	 * malformed marker reads as empty (the migration simply re-copies absent-only
	 * values and rewrites the marker).
	 */
	async #readProjectMigratedKeys(source: string): Promise<Set<WorkflowSettingKey>> {
		const markerPath = path.join(path.dirname(source), "state", "settings.json.migrated-keys");
		let raw: string;
		try {
			raw = await Bun.file(markerPath).text();
		} catch (error) {
			// Only a MISSING marker reads as empty. A non-ENOENT read failure
			// (EACCES, transient I/O) must ABORT the migration: treating it as
			// empty would reimport a stale retained value and overwrite the
			// marker once the failure clears.
			if (isEnoent(error)) return new Set();
			throw error;
		}
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!Array.isArray(parsed)) return new Set();
			const keys = new Set<WorkflowSettingKey>();
			for (const entry of parsed) {
				if (
					typeof entry === "string" &&
					(CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS as readonly string[]).includes(entry)
				) {
					keys.add(entry as WorkflowSettingKey);
				}
			}
			return keys;
		} catch {
			return new Set();
		}
	}

	/**
	 * Atomically persist the project workflow migration's per-key completion
	 * marker under `.gjc/state/` (temp file + rename; the directory is created on
	 * demand).
	 */
	async #writeProjectMigratedKeys(source: string, keys: readonly WorkflowSettingKey[]): Promise<boolean> {
		const markerPath = path.join(path.dirname(source), "state", "settings.json.migrated-keys");
		// A UNIQUE staging path: two GJC processes may migrate the same project
		// concurrently, and a fixed .tmp name could be consumed by one writer's
		// rename, making the other fail its marker write and roll back a copy
		// whose ownership the winner recorded.
		const tempPath = `${markerPath}.${nodeCrypto.randomUUID()}.tmp`;
		try {
			await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
			// Fsync the staged payload BEFORE the rename: Bun.write alone would let a
			// host/power failure after publication leave an empty or malformed marker
			// whose directory entry survives the parent sync but whose content does
			// not, and #readProjectMigratedKeys would read no ownership - a later
			// unset of a migrated key would then re-import the stale legacy value.
			const tempHandle = await fs.promises.open(tempPath, "wx", 0o600);
			try {
				await tempHandle.writeFile(JSON.stringify(keys, null, 2), "utf8");
				await tempHandle.sync();
			} finally {
				await tempHandle.close();
			}
			await fs.promises.rename(tempPath, markerPath);
			// Durable publication: sync the marker's parent directory so the rename
			// (the ownership entry) survives a host crash even when the temp
			// content was already durable. Best-effort: platforms/filesystems that
			// reject directory sync are ignored.
			try {
				const dirHandle = await fs.promises.open(path.dirname(markerPath), "r");
				try {
					await dirHandle.sync();
				} finally {
					await dirHandle.close();
				}
			} catch {
				// Unsupported directory sync: ignore.
			}
			return true;
		} catch (error) {
			await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
			this.#warnLegacyFallbackMigration(
				`Settings: project workflow migration could not write the migrated-keys marker at ${markerPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	/**
	 * Second-chance rollback for the project migration: when the in-transaction
	 * rollback lost its whole-file CAS (an editor changed an unrelated config.yml
	 * field between the publication and the rollback), reopen the target and
	 * restore only the migration-published values that still match what the
	 * migration wrote - never an editor's newer value. Repaired keys get their
	 * pre-publication value back; keys that were absent before are unset. Also
	 * used when the migrated-key marker cannot be written, so a markerless
	 * publication is never considered complete.
	 */
	async #rollbackProjectPublishedKeys(
		target: string,
		published: readonly AtomicYamlPatch[],
		source: string,
		beforeStates: ReadonlyMap<string, ProjectTargetBeforeState>,
	): Promise<void> {
		try {
			await withAtomicYamlConfigTransaction(target, async tx => {
				const matching = published.filter(patch => {
					if (patch.op !== "set") return false;
					const current = extractWorkflowSetting(tx.root, patch.path as WorkflowSettingKey, { flat: false });
					return (
						!current.malformedParent &&
						current.present &&
						JSON.stringify(current.value) === JSON.stringify(patch.value)
					);
				});
				if (matching.length === 0) return;
				// Restore each key's pre-publication state instead of blanket-unsetting:
				// a repaired key (present-but-invalid before the migration) must keep
				// its original value rather than being deleted.
				await tx.applyPatches(
					matching.map(patch => {
						const before = beforeStates.get(patch.path);
						return before?.present
							? { path: patch.path, op: "set" as const, value: before.value }
							: { path: patch.path, op: "unset" as const };
					}),
				);
			});
			// Clear the strict-invalid evidence ONLY when it no longer reflects the
			// retained source: independently valid evidence (the source still holds
			// the recorded invalid values) must survive the rollback so exit 2 stays
			// observable - a marker-failure rollback does not change the source.
			const evidencePath = this.#projectStrictInvalidEvidencePath(source);
			const retainedEvidence = await this.#readStrictInvalidEvidence(evidencePath);
			if (retainedEvidence) {
				try {
					// Prune to the still-invalid keys: repairing ONE recorded key must
					// not drop the evidence for the remaining unresolved keys. Runs
					// under the target lock so a concurrent process's evidence
					// publication serializes with this prune.
					await withAtomicYamlConfigTransaction(target, async () => {
						await this.#pruneStrictInvalidEvidence(source, evidencePath, retainedEvidence);
					});
				} catch {
					// Transient source read failure: retain the evidence sidecar.
				}
			}
			this.#warnLegacyFallbackMigration(
				`Settings: project workflow migration recovered the rollback after a CAS conflict: restored migration-published keys whose values still matched`,
			);
		} catch (error) {
			this.#warnLegacyFallbackMigration(
				`Settings: project workflow migration could not recover the rollback for ${target}: ${error instanceof Error ? error.message : String(error)}; stale migration-published values may remain until the next repair`,
			);
		}
	}

	/**
	 * True when the config-root source still matches the bytes this migration
	 * read (the hash is computed from the initial read). Used to gate evidence
	 * retention: stale evidence written after an external repair/replacement
	 * would make the direct command exit 2 for a now-valid source.
	 */
	async #configRootSourceMatches(source: string, sourceSha256: string): Promise<boolean> {
		const current = await this.#sha256File(source).catch(() => null);
		return current === sourceSha256;
	}

	/**
	 * Config-root fallback-invalid marker path. The PROJECT marker stays next to
	 * the legacy source (`${source}.fallback-invalid`, covered by .gitignore);
	 * when the config-root source collides with a project source both migrations
	 * would otherwise share that marker while writing fallbacks to DIFFERENT
	 * targets, and one target's cleanup could delete the shared marker while the
	 * other target's fallback value is still active. The config-root marker uses
	 * a distinct name so ownership is per-target.
	 */
	#configRootFallbackInvalidMarkerPath(source: string): string {
		return `${source}.config-root.fallback-invalid`;
	}

	/**
	 * Read the fallback-invalid marker (keys persisted into config.yml as
	 * fallback evidence when the strict-evidence sidecar could not be written).
	 * The marker lives next to the legacy source so it stays writable in the
	 * exact scenario that produced it (.gjc/state/ is read-only or occupied).
	 */
	async #readFallbackInvalidKeys(
		source: string,
		markerPath = `${source}.fallback-invalid`,
	): Promise<StrictInvalidEvidenceEntry[]> {
		let raw: string;
		try {
			raw = await Bun.file(markerPath).text();
		} catch {
			return [];
		}
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!Array.isArray(parsed)) return [];
			const entries: StrictInvalidEvidenceEntry[] = [];
			for (const entry of parsed) {
				if (typeof entry === "string") {
					// v1 marker: key only (no recorded value) - never match an unset.
					if ((CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS as readonly string[]).includes(entry)) {
						entries.push({ key: entry as WorkflowSettingKey, value: undefined });
					}
				} else if (entry && typeof entry === "object") {
					const { key, value } = entry as { key?: unknown; value?: unknown };
					if (
						typeof key === "string" &&
						(CONFIG_ROOT_WORKFLOW_MIGRATION_KEYS as readonly string[]).includes(key)
					) {
						entries.push({ key: key as WorkflowSettingKey, value });
					}
				}
			}
			return entries;
		} catch {
			return [];
		}
	}

	/**
	 * Merge newly written fallback entries into the EXISTING fallback-invalid
	 * marker. An evidence-unwritable source that first falls back key A and a
	 * later load adds invalid key B (while A stays invalid) writes only B here -
	 * A is already present in config.yml and excluded by the absent-target
	 * filter. Replacing the marker with just B would lose A's tracking, so after
	 * the source is repaired the cleanup could never remove A's fallback value
	 * from config.yml (exit 2 persisting forever). New entries win over existing
	 * ones for the same key.
	 */
	async #mergeFallbackInvalidKeys(
		source: string,
		entries: readonly StrictInvalidEvidenceEntry[],
		markerPath = `${source}.fallback-invalid`,
	): Promise<StrictInvalidEvidenceEntry[]> {
		const merged = new Map<WorkflowSettingKey, unknown>();
		for (const entry of await this.#readFallbackInvalidKeys(source, markerPath)) {
			merged.set(entry.key, entry.value);
		}
		for (const entry of entries) {
			merged.set(entry.key, entry.value);
		}
		return [...merged].map(([key, value]) => ({ key, value }));
	}

	/** Atomically persist (or remove) the fallback-invalid marker. Returns false on failure. */
	async #writeFallbackInvalidKeys(
		source: string,
		entries: readonly StrictInvalidEvidenceEntry[],
		markerPath = `${source}.fallback-invalid`,
	): Promise<boolean> {
		const tempPath = `${markerPath}.${nodeCrypto.randomUUID()}.tmp`;
		try {
			if (entries.length === 0) {
				await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
				return true;
			}
			// Publish atomically (stage + sync + rename): a direct in-place write of
			// a merged marker could be truncated by a crash, leaving malformed JSON
			// that #readFallbackInvalidKeys treats as empty while the recorded
			// config.yml values stay active and become un-cleanable.
			const tempHandle = await fs.promises.open(tempPath, "wx", 0o600);
			try {
				await tempHandle.writeFile(
					JSON.stringify(
						entries.map(entry => ({ key: entry.key, value: entry.value })),
						null,
						2,
					),
					"utf8",
				);
				await tempHandle.sync();
			} finally {
				await tempHandle.close();
			}
			await fs.promises.rename(tempPath, markerPath);
			// Durable publication: sync the marker's parent directory so the rename
			// (the marker's directory entry) survives a host crash even when the
			// temp content was already durable - otherwise a power loss can preserve
			// the fallback value in config.yml while the ownership marker is lost,
			// and the value becomes un-cleanable. Best-effort (mirrors the atomic
			// marker writer): platforms/filesystems that reject directory sync are
			// ignored.
			try {
				const dirHandle = await fs.promises.open(path.dirname(markerPath), "r");
				try {
					await dirHandle.sync();
				} finally {
					await dirHandle.close();
				}
			} catch {
				// Unsupported directory sync: ignore.
			}
			return true;
		} catch (error) {
			await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
			this.#warnLegacyFallbackMigration(
				`Settings: workflow migration could not write the fallback-invalid marker at ${markerPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}
	/**
	 * Fallback-invalid cleanup: values persisted into config.yml as fallback
	 * evidence must be removed when the source no longer holds the invalid
	 * value (the key was deleted or settings.json was removed), so exit 2 does
	 * not persist after the user repairs the legacy source. A malformed source
	 * keeps the fallback (the config.yml value stays the error surface).
	 */
	async #clearStaleFallbackInvalidKeys(
		source: string,
		target: string,
		markerPath = `${source}.fallback-invalid`,
	): Promise<void> {
		const entries = await this.#readFallbackInvalidKeys(source, markerPath);
		if (entries.length === 0) return;

		const stillInvalid = new Set<WorkflowSettingKey>();
		let sourceText: string | null;
		try {
			sourceText = await Bun.file(source).text();
		} catch (error) {
			if (!isEnoent(error)) {
				// A transient read failure (permissions, I/O) must NOT be treated as
				// deletion: retain the fallback so the strict error stays observable.
				return;
			}
			// settings.json removed: nothing to keep the fallback alive.
			sourceText = null;
		}
		if (sourceText !== null) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(sourceText);
			} catch {
				// Still malformed: keep the fallback as the observable error.
				return;
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
			for (const entry of entries) {
				const extracted = extractWorkflowSetting(parsed as Record<string, unknown>, entry.key);
				if (extracted.present && !this.#workflowKeyValueIsValid(entry.key, extracted.value)) {
					stillInvalid.add(entry.key);
				}
			}
		}

		const toClear = entries.filter(entry => !stillInvalid.has(entry.key));
		if (toClear.length === 0) return;
		const toClearKeys = new Set(toClear.map(entry => entry.key));
		try {
			await withAtomicYamlConfigTransaction(target, async tx => {
				// A config.yml written by a NEWER schema version is read-only across
				// Settings; leave the target AND the fallback marker untouched, or
				// this cleanup (which runs before either migration's future-schema
				// guard) would rewrite configuration an older binary treats as
				// read-only.
				const targetSchemaVersion = (tx.root as Record<string, unknown> | null | undefined)?.configSchemaVersion;
				if (typeof targetSchemaVersion === "number" && targetSchemaVersion > CONFIG_SCHEMA_VERSION) {
					return;
				}
				// Unset only while the target still matches the migration's fallback
				// write: a user's newer hand-edited override (e.g. maxIterations: 9)
				// survives the cleanup.
				const unsets = toClear.filter(entry => {
					const current = extractWorkflowSetting(tx.root, entry.key, { flat: false });
					return (
						!current.malformedParent &&
						current.present &&
						JSON.stringify(current.value) === JSON.stringify(entry.value)
					);
				});
				if (unsets.length > 0) {
					await tx.applyPatches(unsets.map(entry => ({ path: entry.key, op: "unset" as const })));
				}
				// Reconcile the marker under the SAME lock the publication sites use:
				// another process may have merged a newly published fallback key
				// between this run's initial read and the transaction. Writing a
				// stale filtered snapshot here would drop that entry and leave its
				// config.yml value without ownership forever, so re-read the CURRENT
				// marker and remove only the keys THIS run cleared.
				await this.#writeFallbackInvalidKeys(
					source,
					(await this.#readFallbackInvalidKeys(source, markerPath)).filter(entry => !toClearKeys.has(entry.key)),
					markerPath,
				);
			});
		} catch (error) {
			this.#warnLegacyFallbackMigration(
				`Settings: workflow migration could not clear stale fallback-invalid values in ${target}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
	}

	/**
	 * Merge the per-key completion marker with the CURRENT on-disk marker (a
	 * concurrent migration may have published its own between our initial read
	 * and this transaction) and return the merged key list.
	 */
	async #mergeProjectMigratedKeys(
		source: string,
		newlyOwned: readonly WorkflowSettingKey[],
	): Promise<readonly WorkflowSettingKey[]> {
		if (newlyOwned.length === 0) return [];
		const currentMarker = await this.#readProjectMigratedKeys(source);
		return [...currentMarker, ...newlyOwned.filter(key => !currentMarker.has(key))];
	}

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

	#isGlobalAgentScope(): boolean {
		// The Settings instance is bound to the environment-selected global agent
		// profile (GJC_CODING_AGENT_DIR / PI_CODING_AGENT_DIR or the default
		// <configRoot>/agent). An EXPLICITLY supplied temporary agentDir (SDK
		// loadForScope, tests) differs from getAgentDir() and must never consume
		// the machine-global config-root source; an environment-selected
		// non-default profile is a legitimate global profile and must migrate
		// like the default one.
		return path.resolve(this.#agentDir) === path.resolve(getAgentDir());
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
				return def.values?.includes(candidate) ?? false;
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
		const tempPath = path.join(
			directory,
			`.${path.basename(markerPath)}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`,
		);
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

	/**
	 * True when the config-root source is the SAME physical file as the current
	 * project's `.gjc/settings.json` (GJC run from the config root itself, e.g.
	 * the user's home with the default `.gjc`): path identity first, then inode
	 * identity for symlink/hardlink aliases.
	 */
	async #configRootCollidesWithProjectSource(source: string): Promise<boolean> {
		const projectSource = path.resolve(this.#cwd, ".gjc", "settings.json");
		if (path.resolve(source) === projectSource) return true;
		const [sourceStat, projectStat] = await Promise.all([
			fs.promises.stat(source).catch(() => null),
			fs.promises.stat(projectSource).catch(() => null),
		]);
		return !!sourceStat && !!projectStat && sourceStat.dev === projectStat.dev && sourceStat.ino === projectStat.ino;
	}

	/**
	 * Reconcile the config-root sidecars (strict evidence prune + fallback-invalid
	 * cleanup) against the AGENT target. Shared by the normal migration start and
	 * the project-source collision deferral: in the collision, the config-root
	 * fallback values live in the agent config.yml and the strict evidence sits
	 * at the agent layer slot, so they must be reconciled here - the project
	 * migration only cleans against the project config.yml and project evidence,
	 * and would otherwise delete the shared fallback marker without removing the
	 * agent config.yml value, orphaning it (strict ralplan failing forever).
	 */
	async #reconcileConfigRootSidecars(source: string, target: string): Promise<void> {
		const evidencePath = `${source}.strict-invalid`;
		const retainedEvidence = await this.#readStrictInvalidEvidence(evidencePath);
		if (retainedEvidence) {
			try {
				// Prune to the still-invalid keys: repairing ONE recorded key must
				// not drop the evidence for the remaining unresolved keys. Runs
				// under the target lock so a concurrent process's evidence
				// publication serializes with this prune.
				await withAtomicYamlConfigTransaction(target, async () => {
					await this.#pruneStrictInvalidEvidence(source, evidencePath, retainedEvidence);
				});
			} catch {
				// Transient source read failure: retain the evidence sidecar.
			}
		}

		// Fallback-invalid cleanup: config.yml values persisted as fallback
		// evidence are removed when the source no longer holds the invalid value
		// (key deleted or settings.json removed), so exit 2 does not persist. The
		// config-root marker namespace is distinct from the project's so a
		// colliding project source never shares ownership state across targets.
		await this.#clearStaleFallbackInvalidKeys(source, target, this.#configRootFallbackInvalidMarkerPath(source));
	}

	/**
	 * Retire the config-root legacy source once migration is complete (shared by
	 * the completion path and the completed-marker crash recovery). Only the
	 * EXACT revision whose bytes match `expectedSourceSha256` is removed: the
	 * source is first RENAMED to a unique quarantine path (an atomic capture of
	 * whatever the path currently holds); the quarantine is unlinked only when
	 * its bytes still match. A quarantined concurrent replacement is restored to
	 * `source` (or left in quarantine if a new file already occupies the path) -
	 * never deleted by pathname.
	 */
	async #retireConfigRootSource(source: string, expectedSourceSha256: string): Promise<void> {
		const quarantinePath = `${source}.migrated-src-${nodeCrypto.randomUUID()}`;
		let quarantined = false;
		try {
			await fs.promises.rename(source, quarantinePath);
			quarantined = true;
		} catch {
			// Source already gone (or locked); nothing to retire.
		}
		if (!quarantined) return;
		const quarantinedHash = await this.#sha256File(quarantinePath).catch(() => null);
		if (quarantinedHash === expectedSourceSha256) {
			await fs.promises.rm(quarantinePath, { force: true }).catch(() => undefined);
			return;
		}
		// A concurrent replacement was quarantined; restore it WITHOUT replacement
		// semantics: hard-link back only when the original path is free (link
		// fails with EEXIST when an editor has since published a new file there),
		// and leave the quarantined object intact in that case - never overwrite
		// or delete the editor's latest revision.
		try {
			await fs.promises.link(quarantinePath, source);
			await fs.promises.rm(quarantinePath, { force: true }).catch(() => undefined);
		} catch {
			// `source` is occupied (EEXIST) or linking failed; keep the
			// quarantined object under its unique name.
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
			// Capture the identity of the copy we just made BEFORE any further
			// verification: an external replacement or in-place edit after this
			// point must never be removed by an abort path.
			let copiedDestIno: number | null = null;
			let copiedDestSha: string | null = null;
			try {
				copiedDestIno = (await fs.promises.stat(destination)).ino;
				copiedDestSha = await this.#sha256File(destination);
			} catch {
				// The copy vanished right after creation; nothing of ours remains.
				return false;
			}
			await SettingsMigrationTestHooks.afterBackupIdentityCaptured?.(destination);
			let copiedSourceHash: string | null = null;
			try {
				copiedSourceHash = await this.#sha256File(source);
			} catch {
				// The source was deleted right after the copy: remove the copy
				// ONLY while it is still the file we created (an external
				// replacement or edit at the backup pathname must be preserved)
				// and report failure so the caller reverts the target.
				await this.#removeIfStillOurs(destination, copiedDestIno, copiedDestSha);
				return false;
			}
			if (copiedSourceHash !== expectedSourceSha256) {
				await this.#removeIfStillOurs(destination, copiedDestIno, copiedDestSha);
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
		let destinationIno: number | null = null;
		try {
			destinationIno = (await fs.promises.stat(destination)).ino;
		} catch {
			return false;
		}
		if (!(await this.#legacySourceStillVerified(source, sourceIno))) {
			// Remove the destination ONLY while it is still the entry created
			// above; an external replacement at the quarantine pathname must be
			// preserved.
			await this.#removeIfStillOurs(destination, destinationIno);
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
	 * Remove `path` only while it is still the file this migration created:
	 * the observed inode must match and (when a hash is given) the bytes must
	 * too. A concurrent external process that replaced or edited the file at
	 * this pathname must never be deleted - the migration's no-clobber promise
	 * preserves externally created `.bak`/quarantine data, mirroring the
	 * identity guards already applied to config targets and strict-evidence
	 * files.
	 */
	async #removeIfStillOurs(path: string, expectedIno: number, expectedSha256?: string): Promise<boolean> {
		// Atomically QUARANTINE the entry (same-directory rename) before any
		// verification: the identity check and the unlink then operate on the
		// private quarantine name, so an external process that replaces the
		// file at the PUBLIC pathname after the check but before the removal
		// can no longer have its file deleted. Whatever the rename moved is
		// what gets verified; a mismatch is restored to the public pathname
		// (no-clobber) or retained under the quarantine name, never unlinked.
		const quarantine = `${path}.quarantine-${process.pid}-${nodeCrypto.randomUUID()}`;
		try {
			await fs.promises.rename(path, quarantine);
		} catch {
			// Nothing to remove (ENOENT) or the entry cannot be moved: removal
			// by pathname is never attempted - the quarantine is the only
			// removal basis.
			return false;
		}
		const stat = await fs.promises.stat(quarantine).catch(() => null);
		if (!stat || stat.ino !== expectedIno) {
			await this.#restoreQuarantined(quarantine, path);
			return false;
		}
		if (expectedSha256 !== undefined && (await this.#sha256File(quarantine)) !== expectedSha256) {
			await this.#restoreQuarantined(quarantine, path);
			return false;
		}
		await SettingsMigrationTestHooks.beforeQuarantineRemoval?.(path);
		await fs.promises.rm(quarantine, { force: true }).catch(() => undefined);
		return true;
	}

	/**
	 * Restore a quarantined entry to its original pathname without ever
	 * replacing a file another process published there meanwhile: the restore
	 * is no-clobber (hard link, then a copy fallback), and on any failure the
	 * quarantined entry is RETAINED (never deleted) so the data stays
	 * recoverable.
	 */
	async #restoreQuarantined(quarantine: string, original: string): Promise<void> {
		try {
			await fs.promises.link(quarantine, original);
			await fs.promises.rm(quarantine, { force: true }).catch(() => undefined);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				// The pathname was re-occupied while quarantined: keep the
				// quarantined entry (displaced, never deleted).
				return;
			}
		}
		try {
			// Filesystems without hard links: a no-clobber copy fallback.
			await fs.promises.copyFile(quarantine, original, fs.constants.COPYFILE_EXCL);
			await fs.promises.rm(quarantine, { force: true }).catch(() => undefined);
		} catch {
			// Occupied or uncopyable: retain the quarantined file so the data
			// stays recoverable.
		}
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
		return nodeCrypto.createHash("sha256").update(Buffer.from(raw)).digest("hex");
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
		const rawVersion = raw.configSchemaVersion;
		const configuredVersion = normalizeConfigSchemaVersion(rawVersion);
		if (rawVersion !== undefined && rawVersion !== configuredVersion) {
			logger.warn("Settings: config has a malformed configSchemaVersion; migrating from the normalized version", {
				configSchemaVersion: String(rawVersion),
				normalized: String(configuredVersion),
			});
		}
		if (configuredVersion === CONFIG_SCHEMA_VERSION) return raw;
		if (typeof configuredVersion === "number" && configuredVersion > CONFIG_SCHEMA_VERSION) return raw;

		// Ordered migration registry. Each step runs ONLY for files below its
		// target version: the v0 steps are not all idempotent (ask.timeout's
		// milliseconds-to-seconds conversion would re-divide a valid v1 value),
		// so a v1 file must skip straight to the v2 step.
		const fromVersion = typeof configuredVersion === "number" ? configuredVersion : 0;
		if (fromVersion < 1) this.#migrateRawSettingsV0ToV1(raw);
		// v1 -> v2: interruptMode -> toolInterruptPolicy.
		if (fromVersion < 2 && "interruptMode" in raw) {
			if (!("toolInterruptPolicy" in raw)) {
				const legacy = raw.interruptMode;
				if (legacy === "wait") raw.toolInterruptPolicy = "finish_tools";
				else if (legacy === "immediate") raw.toolInterruptPolicy = "abort_tools";
				// Any other value is malformed: drop it and let the schema default apply.
			}
			delete raw.interruptMode;
		}

		raw.configSchemaVersion = CONFIG_SCHEMA_VERSION;

		return raw;
	}

	/** v0 -> v1 transforms. Runs only for files that predate schema version 1. */
	#migrateRawSettingsV0ToV1(raw: RawSettings): void {
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

		// Migrate legacy providers.image* settings into modelRoles.image.
		// The image-generation model is now selected via the model-role system
		// (/model image <selector>) instead of a separate provider config dialog.
		const providersObj = rawSettingsRecord(raw.providers);
		if (providersObj && typeof providersObj.image === "string") {
			const imageProvider = providersObj.image;
			const imageModel = typeof providersObj.imageModel === "string" ? providersObj.imageModel : undefined;

			// A custom endpoint belongs in models.yml. Retain the complete legacy
			// configuration rather than creating an unresolvable image-custom selector.
			if (imageProvider !== "custom") {
				if (imageProvider !== "auto") {
					const roles = rawSettingsRecord(raw.modelRoles) ?? {};
					if (!roles.image) {
						roles.image = imageModel ? `${imageProvider}/${imageModel}` : imageProvider;
						raw.modelRoles = roles;
					}
				}

				delete providersObj.image;
				delete providersObj.imageModel;
				delete providersObj.imageCustomUrl;
				delete providersObj.imageCustomKey;
				delete providersObj.imageCustomKeyEnv;
			}
		}
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
	#recomputeAutoroutingDiagnostic(): void {
		this.#autoroutingLocalIssues = [this.#global, this.#project, this.#overrides].flatMap(source => {
			const fragment = getByPath(source, ["task", "autorouting"]);
			return validateAutoroutingLocal(fragment).map(localIssue => ({
				path: localIssue.path ? `task.autorouting.${localIssue.path}` : "task.autorouting",
				kind: "invalid" as const,
				detail: localIssue.detail,
			}));
		});
		this.#autoroutingEffective = validateAutoroutingEffective(getByPath(this.#merged, ["task", "autorouting"]));
	}

	#rebuildMerged(): void {
		const project = structuredClone(this.#project);
		const overrides = structuredClone(this.#overrides);
		for (const settingPath of GLOBAL_ONLY_SETTINGS) {
			const segments = settingPath.split(".");
			deleteByPath(project, segments);
			deleteByPath(overrides, segments);
		}
		this.#merged = this.#deepMerge(this.#deepMerge({}, this.#global), project);
		this.#merged = this.#deepMerge(this.#merged, overrides);
		this.#recomputeAutoroutingDiagnostic();
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
		rejectedCredentialPins: boolean;
	} {
		let rejectedNotifications = false;
		let rejectedCredentialPins = false;
		const sanitized: RawSettings = {};
		for (const [key, value] of Object.entries(settings)) {
			if (key === "auth" && value && typeof value === "object" && !Array.isArray(value)) {
				const authSettings = { ...(value as Record<string, unknown>) };
				if (Object.hasOwn(authSettings, "credentialPins")) {
					delete authSettings.credentialPins;
					rejectedCredentialPins = true;
				}
				if (Object.hasOwn(authSettings, "credentialPinStoreIdentity")) {
					delete authSettings.credentialPinStoreIdentity;
					rejectedCredentialPins = true;
				}
				if (Object.keys(authSettings).length > 0) sanitized[key] = authSettings;
				continue;
			}
			if (key === "auth.credentialPins" || key === "auth.credentialPinStoreIdentity") {
				rejectedCredentialPins = true;
				continue;
			}
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
		return { settings: sanitized, rejectedNotifications, rejectedCredentialPins };
	}

	#deepMerge(base: RawSettings, overrides: RawSettings): RawSettings {
		const result = { ...base };
		for (const key of Object.keys(overrides)) {
			const override = overrides[key];
			const baseVal = base[key];

			if (override === undefined) continue;

			const value =
				typeof override === "object" &&
				override !== null &&
				!Array.isArray(override) &&
				typeof baseVal === "object" &&
				baseVal !== null &&
				!Array.isArray(baseVal)
					? this.#deepMerge(baseVal as RawSettings, override as RawSettings)
					: override;
			Object.defineProperty(result, key, { configurable: true, enumerable: true, value, writable: true });
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
 * Ensure the one-time legacy workflow settings migrations have run for `cwd`
 * before a workflow runtime resolves settings. The direct CLI commands
 * (`gjc ralplan`, `gjc deep-interview`, `gjc ultragoal`) never initialize
 * Settings, so without this the project `.gjc/settings.json` and config-root
 * `settings.json` workflow keys would silently fall back to defaults after the
 * resolver stopped reading settings.json. No-op when the global Settings
 * singleton is already initialized (session path). Best-effort: a settings
 * load failure must not block the native command, whose resolver falls back to
 * defaults exactly as before.
 */
export async function ensureWorkflowSettingsMigrated(cwd: string): Promise<void> {
	if (isSettingsInitialized()) return;
	let loaded: Settings | undefined;
	try {
		loaded = await Settings.loadForScope({ cwd });
	} catch (error) {
		logger.warn("Settings: workflow migration trigger could not load settings", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (loaded) {
		try {
			await loaded.close();
		} catch (error) {
			logger.warn("Settings: workflow migration cleanup could not flush settings", {
				error: error instanceof Error ? error.message : String(error),
			});
			loaded.getStorage()?.close();
		}
	}
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
