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
import type { NotificationSettingsReader, NotificationSettingsSnapshot } from "../sdk/bus/config";
import { AgentStorage } from "../session/agent-storage";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import {
	type AtomicYamlPatch,
	applyAtomicYamlPatches,
	applyAtomicYamlPatchesWithCurrent,
	type CasReceipt,
	deleteByPath,
	reserveAtomicYamlUpdateSlot,
	setByPath,
} from "./atomic-yaml-patch";
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
	readonly value: unknown | undefined;
	readonly generation: number;
	readonly revision: number;
	readonly modelRole?: string;
	readonly modelRoleRevision?: number;
	readonly configVersion?: string;
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

export type SettingsAtomicPatch = { path: SettingPath; op: "set"; value: unknown } | { path: SettingPath; op: "unset" };
export type SettingsAtomicReceipt = CasReceipt;

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

export class Settings implements NotificationSettingsReader {
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
	#pathRevisions = new Map<string, number>();
	#nextRevision = 0;
	#defaultModelRoleOwnership: DefaultModelRoleOwnership = { generation: 0, defaultLineageKnown: true };
	/** Pending debounced ordinary save; its queue slot is reserved immediately. */
	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;
	#pendingSaveSlot?: PendingSaveSlot;
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
		const enabled = this.#getGlobalResolved("notifications.enabled");
		const botToken = this.#getGlobalResolved("notifications.telegram.botToken");
		const chatId = this.#getGlobalResolved("notifications.telegram.chatId");
		const activation = this.#getGlobalResolved("notifications.telegram.activation");
		const activationSnapshot =
			activation && Object.keys(activation).length > 0 ? structuredClone(activation) : undefined;
		const richEnabled = this.#getGlobalResolved("notifications.telegram.rich.enabled");
		const richDraftEnabled = this.#getGlobalResolved("notifications.telegram.richDraft.enabled");
		const nameTemplate = this.#getGlobalResolved("notifications.telegram.topics.nameTemplate");
		const discordBotToken = this.#getGlobalResolved("notifications.discord.botToken");
		const discordApplicationId = this.#getGlobalResolved("notifications.discord.applicationId");
		const discordGuildId = this.#getGlobalResolved("notifications.discord.guildId");
		const discordParentChannelId = this.#getGlobalResolved("notifications.discord.parentChannelId");
		const slackBotToken = this.#getGlobalResolved("notifications.slack.botToken");
		const slackAppToken = this.#getGlobalResolved("notifications.slack.appToken");
		const slackWorkspaceId = this.#getGlobalResolved("notifications.slack.workspaceId");
		const slackChannelId = this.#getGlobalResolved("notifications.slack.channelId");
		const slackAuthorizedUserId = this.#getGlobalResolved("notifications.slack.authorizedUserId");
		const redact = this.#getGlobalResolved("notifications.redact");
		const verbosity = this.#getGlobalResolved("notifications.verbosity");
		const sessionScope = this.#getGlobalResolved("notifications.sessionScope");
		const idleTimeoutMs = this.#getGlobalResolved("notifications.daemon.idleTimeoutMs");

		return {
			enabled: typeof enabled === "boolean" ? enabled : getDefault("notifications.enabled"),
			telegram: {
				botToken:
					typeof botToken === "string" && botToken.length > 0
						? botToken
						: getDefault("notifications.telegram.botToken"),
				chatId:
					typeof chatId === "string" && chatId.length > 0 ? chatId : getDefault("notifications.telegram.chatId"),
				...(activationSnapshot === undefined ? {} : { activation: activationSnapshot }),
				rich: {
					enabled:
						typeof richEnabled === "boolean" ? richEnabled : getDefault("notifications.telegram.rich.enabled"),
				},
				richDraft: {
					enabled:
						typeof richDraftEnabled === "boolean"
							? richDraftEnabled
							: getDefault("notifications.telegram.richDraft.enabled"),
				},
				topics: {
					nameTemplate:
						typeof nameTemplate === "string" && nameTemplate.length > 0
							? nameTemplate
							: getDefault("notifications.telegram.topics.nameTemplate"),
				},
			},
			discord: {
				botToken:
					typeof discordBotToken === "string" && discordBotToken.length > 0
						? discordBotToken
						: getDefault("notifications.discord.botToken"),
				applicationId:
					typeof discordApplicationId === "string" && discordApplicationId.length > 0
						? discordApplicationId
						: getDefault("notifications.discord.applicationId"),
				guildId:
					typeof discordGuildId === "string" && discordGuildId.length > 0
						? discordGuildId
						: getDefault("notifications.discord.guildId"),
				parentChannelId:
					typeof discordParentChannelId === "string" && discordParentChannelId.length > 0
						? discordParentChannelId
						: getDefault("notifications.discord.parentChannelId"),
			},
			slack: {
				botToken:
					typeof slackBotToken === "string" && slackBotToken.length > 0
						? slackBotToken
						: getDefault("notifications.slack.botToken"),
				appToken:
					typeof slackAppToken === "string" && slackAppToken.length > 0
						? slackAppToken
						: getDefault("notifications.slack.appToken"),
				workspaceId:
					typeof slackWorkspaceId === "string" && slackWorkspaceId.length > 0
						? slackWorkspaceId
						: getDefault("notifications.slack.workspaceId"),
				channelId:
					typeof slackChannelId === "string" && slackChannelId.length > 0
						? slackChannelId
						: getDefault("notifications.slack.channelId"),
				authorizedUserId:
					typeof slackAuthorizedUserId === "string" && slackAuthorizedUserId.length > 0
						? slackAuthorizedUserId
						: getDefault("notifications.slack.authorizedUserId"),
			},
			redact: typeof redact === "boolean" ? redact : getDefault("notifications.redact"),
			verbosity: verbosity === "verbose" || getDefault("notifications.verbosity") === "verbose" ? "verbose" : "lean",
			sessionScope:
				sessionScope === "primary" || getDefault("notifications.sessionScope") === "primary" ? "primary" : "all",
			idleTimeoutMs:
				typeof idleTimeoutMs === "number" && Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0
					? idleTimeoutMs
					: getDefault("notifications.daemon.idleTimeoutMs"),
		};
	}

	/** Check whether a setting is present in loaded settings/overrides rather than coming from schema defaults. */
	has(path: SettingPath): boolean {
		return getByPath(this.#merged, path.split(".")) !== undefined;
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

	#set<P extends SettingPath>(path: P, value: SettingValue<P>, defaultModelRoleMayHaveChanged: boolean): void {
		const prev = this.get(path);
		const clonedValue = structuredClone(value);
		let modelRoleRevision: number | undefined;
		if (path === "modelRoles" && defaultModelRoleMayHaveChanged) {
			this.#defaultModelRoleOwnership.generation += 1;
			modelRoleRevision = this.#defaultModelRoleOwnership.generation;
		}
		const patch: SettingsPatch = {
			path,
			value: clonedValue,
			generation: ++this.#nextGeneration,
			revision: ++this.#nextRevision,
			modelRoleRevision,
			configVersion: this.#defaultModelRoleOwnership.configVersion,
		};
		setByPath(this.#global, path.split("."), structuredClone(clonedValue));
		this.#pathRevisions.set(path, patch.revision);
		this.#modified.set(path, patch);

		this.#rebuildMerged();
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
		let modelRoleRevision: number | undefined;
		if (path === "modelRoles") {
			this.#defaultModelRoleOwnership.generation += 1;
			modelRoleRevision = this.#defaultModelRoleOwnership.generation;
		}
		const patch: SettingsPatch = {
			path,
			value: undefined,
			generation: ++this.#nextGeneration,
			revision: ++this.#nextRevision,
			modelRoleRevision,
			configVersion: this.#defaultModelRoleOwnership.configVersion,
		};
		deleteByPath(this.#global, path.split("."));
		this.#pathRevisions.set(path, patch.revision);
		this.#modified.set(path, patch);
		this.#rebuildMerged();
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
			for (const patch of patches) {
				if (!Object.hasOwn(SETTINGS_SCHEMA, patch.path)) {
					throw new Error(`Unknown setting path for atomic batch: ${patch.path}`);
				}
				if (patch.op === "set" && patch.value === undefined) {
					throw new TypeError(`Settings set patch for ${patch.path} cannot carry undefined; use unset instead.`);
				}
			}
			for (const patch of patches) {
				if (patch.op === "set") this.set(patch.path, patch.value as never);
				else this.unset(patch.path);
			}
			return {
				revisions: [],
				restore: async () => ({ status: "discarded" }),
				discard: () => {},
			};
		}

		const durablePatches: AtomicYamlPatch[] = patches.map(patch => {
			if (!Object.hasOwn(SETTINGS_SCHEMA, patch.path)) {
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

		const revisions = durablePatches.map(patch => ({
			patch,
			revision: ++this.#nextRevision,
			previousRevision: this.#pathRevisions.get(patch.path),
		}));
		for (const entry of revisions) this.#pathRevisions.set(entry.patch.path, entry.revision);

		try {
			const receipt = await applyAtomicYamlPatches(this.#configPath, durablePatches, {
				onRestored: restoredPatches => this.#applyRestoredDurableBatch(revisions, restoredPatches),
			});
			this.#applyDurableBatch(revisions);
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
		try {
			const receipt = await applyAtomicYamlPatchesWithCurrent(
				this.#configPath,
				async current => {
					const patches = await buildPatches(structuredClone(current));
					const durablePatches: AtomicYamlPatch[] = patches.map(patch => {
						if (!Object.hasOwn(SETTINGS_SCHEMA, patch.path)) {
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
					onRestored: restoredPatches => this.#applyRestoredDurableBatch(revisions, restoredPatches),
				},
			);
			this.#applyDurableBatch(revisions);
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
		cloned.#defaultModelRoleOwnership = this.#defaultModelRoleOwnership;

		cloned.#global = structuredClone(this.#global);
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
		let modelRoleRevision: number | undefined;
		if (role === "default") {
			this.#defaultModelRoleOwnership.generation += 1;
			modelRoleRevision = this.#defaultModelRoleOwnership.generation;
		}
		const revision = ++this.#nextRevision;
		const patch: SettingsPatch = {
			path: "modelRoles",
			value: modelId,
			generation: ++this.#nextGeneration,
			revision,
			modelRole: role,
			modelRoleRevision,
			configVersion: this.#defaultModelRoleOwnership.configVersion,
		};
		setRawModelRole(this.#global, role, modelId);
		this.#pathRevisions.set("modelRoles", revision);
		this.#modified.set(settingsPatchKey(patch), patch);
		this.#rebuildMerged();
		this.#queueSave();
	}

	setGlobalModelRoleAndFlush(
		role: ModelRole | string,
		modelId: ModelSelectorValue | undefined,
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
		modelId: ModelSelectorValue | undefined,
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
			const result = await reserveAtomicYamlUpdateSlot(this.#configPath, () => ({
				apply: current => {
					durableBeforeWrite = structuredClone(current);
					durableVersionBeforeWrite = readConfigVersion(this.#configPath!);
					const durablePreviousDefault = defaultModelRoleFrom(current);
					const durablePreviousModelRolesExisted = Object.hasOwn(current, "modelRoles");
					setRawModelRole(current, role, modelId);
					return {
						durablePreviousDefault,
						durablePreviousModelRolesExisted,
						committedDefault: defaultModelRoleFrom(current),
						committedConfigVersion: undefined as string | undefined,
						defaultRevision,
					};
				},
				committed: (current, result) => {
					const committedConfigVersion = readConfigVersion(this.#configPath!);
					this.#replaceGlobalWithDurable(
						current,
						committedConfigVersion,
						role === "default",
						durableVersionBeforeWrite,
					);
					result.committedConfigVersion = committedConfigVersion;
				},
			}));
			return {
				previousDefault: result.durablePreviousDefault,
				previousModelRolesExisted: result.durablePreviousModelRolesExisted,
				committedDefault: result.committedDefault,
				committedConfigVersion: result.committedConfigVersion,
				defaultRevision: result.defaultRevision,
			};
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

		const restored = await reserveAtomicYamlUpdateSlot(this.#configPath, () => ({
			apply: current => {
				if (this.#defaultModelRoleOwnership.generation !== commit.defaultRevision) return false;
				const currentConfigVersion = readConfigVersion(this.#configPath!);
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
				return { currentConfigVersion };
			},
			shouldWrite: result => result !== false,
			committed: (current, result) => {
				if (result === false) return;
				const restoredConfigVersion = readConfigVersion(this.#configPath!);
				this.#replaceGlobalWithDurable(current, restoredConfigVersion, true, result.currentConfigVersion);
				this.#defaultModelRoleOwnership.generation += 1;
			},
		}));
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
		this.#legacyFallbackMigrationGlobalFingerprint = YAML.stringify(this.#global, null, 2);
		this.#migrateRetryFallbackChains();
		if (
			!this.#modified.has("modelRoles") &&
			![...this.#modified.keys()].some(path => path.startsWith("retry.fallback"))
		) {
			this.#legacyFallbackMigrationGlobalFingerprint = undefined;
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

	/** Apply schema migrations to raw settings */
	#migrateRawSettings(raw: RawSettings): RawSettings {
		// queueMode -> steeringMode
		normalizeSessionDirectoryMigration(raw);
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
		let durableVersionBeforeWrite: string | undefined;
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
							this.#defaultModelRoleOwnership.configVersion = readConfigVersion(this.#configPath!);
							this.#defaultModelRoleOwnership.defaultLineageKnown = false;
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
					const currentConfigVersion = readConfigVersion(this.#configPath!);
					durableBeforeWrite = structuredClone(current);
					durableVersionBeforeWrite = currentConfigVersion;
					const externalLineageBreak = currentConfigVersion !== this.#defaultModelRoleOwnership.configVersion;
					const applicablePatches = captured.filter(
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
					return { appliesDefault, externalLineageBreak, shouldWrite: applicablePatches.length > 0 };
				},
				shouldWrite: result => result.shouldWrite,
				committed: (current, result) => {
					const savedConfigVersion = readConfigVersion(this.#configPath!);
					this.#defaultModelRoleOwnership.configVersion = savedConfigVersion;
					if (result.appliesDefault) {
						this.#defaultModelRoleOwnership.defaultConfigVersion = savedConfigVersion;
						this.#defaultModelRoleOwnership.defaultLineageKnown = true;
					} else if (result.externalLineageBreak) {
						this.#defaultModelRoleOwnership.defaultLineageKnown = false;
					}
					for (const patch of captured) {
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
					this.#rebuildMerged();
				},
			};
		}).then(() => undefined);
		this.#savePromise = save;
		void save.catch(error => {
			logger.warn("Settings: background save failed", { error: String(error) });
			let droppedStaleDefault = false;
			for (const patch of captured) {
				const key = settingsPatchKey(patch);
				const currentPatch = this.#modified.get(key);
				if (currentPatch?.generation !== patch.generation) continue;
				if (
					this.#isStaleDefaultModelRolePatch(patch, readConfigVersion(this.#configPath!)) &&
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
				this.#rebuildMerged();
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

	#applyDurableBatch(revisions: readonly DurableBatchRevision[]): void {
		this.#applyDurablePatches(
			revisions,
			revisions.map(entry => entry.patch),
			true,
		);
	}

	#applyRestoredDurableBatch(
		revisions: readonly DurableBatchRevision[],
		restoredPatches: readonly AtomicYamlPatch[],
	): void {
		this.#applyDurablePatches(revisions, restoredPatches, false);
	}

	#applyDurablePatches(
		revisions: readonly DurableBatchRevision[],
		patches: readonly AtomicYamlPatch[],
		clearStagedMutations: boolean,
	): void {
		const revisionsByPath = new Map<string, DurableBatchRevision>();
		for (const entry of revisions) revisionsByPath.set(entry.patch.path, entry);
		const finalPatches = new Map<string, AtomicYamlPatch>();
		for (const patch of patches) finalPatches.set(patch.path, patch);
		const applicable = [...finalPatches.values()].filter(patch => {
			const revision = revisionsByPath.get(patch.path);
			return revision !== undefined && this.#pathRevisions.get(patch.path) === revision.revision;
		});
		if (applicable.length === 0) return;

		const previous = new Map<SettingPath, SettingValue<SettingPath>>();
		for (const patch of applicable) {
			const settingPath = patch.path as SettingPath;
			const revision = revisionsByPath.get(patch.path)!;
			previous.set(settingPath, this.get(settingPath));
			if (patch.op === "set") {
				setByPath(this.#global, settingPath.split("."), structuredClone(patch.value));
			} else {
				deleteByPath(this.#global, settingPath.split("."));
			}
			if (clearStagedMutations) {
				for (const [key, staged] of this.#modified) {
					if (staged.path === settingPath && staged.revision <= revision.revision) {
						this.#modified.delete(key);
					}
				}
			}
		}
		this.#rebuildMerged();
		for (const patch of applicable) {
			const settingPath = patch.path as SettingPath;
			const hook = SETTING_HOOKS[settingPath];
			if (hook) hook(this.get(settingPath), previous.get(settingPath)!);
		}
	}

	async #refreshDurableSettings(): Promise<void> {
		if (!this.#persist || !this.#configPath) return;
		const current = await this.#loadYaml(this.#configPath);
		this.#replaceGlobalWithDurable(current, readConfigVersion(this.#configPath), false);
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

	#getGlobalResolved<P extends SettingPath>(path: P): SettingValue<P> {
		const value = getByPath(this.#global, path.split("."));
		return value === undefined ? getDefault(path) : (value as SettingValue<P>);
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
