import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as util from "node:util";
import type { Model } from "@gajae-code/ai";
import { invalidate } from "../capability";
import { applyAtomicYamlPatchesWithCurrent, type AtomicYamlPatch } from "../config/atomic-yaml-patch";
import { validateModelProfileName } from "../config/model-profile-contract";
import { ModelProfileApplyCommittedError, readDurableModelProfileOwnership } from "../config/model-profile-ownership";
import { createRegistrySelectorIndex, type ModelRegistry, registrySelectorResolvesToModel } from "../config/model-registry";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "../config/model-selector-value";
import type { Settings, SettingsAtomicPatch, SettingsPathResolution } from "../config/settings";
import { getUi, SETTINGS_SCHEMA, type SettingPath, type SettingValue, validateSettingPatch } from "../config/settings-schema";
import type { AgentSession, SessionAgentModelRole } from "../session/agent-session";
import { DefaultModelSelectionRecoveryError, type DefaultModelSelectionRecovery } from "../session/default-model-selection";
import type { SessionManager } from "../session/session-manager";
import { isSecretConfigKey } from "./protocol/adapter-validation";
import { getSettingsCatalog, type SettingCatalogItem } from "./settings-catalog";

export const SDK_PREFERENCE_QUERY_OPERATIONS = ["model.roles.get"] as const;
export const SDK_PREFERENCE_CONTROL_OPERATIONS = [
	"model.role.set",
	"model.select",
	"model.profile.select",
	"config.write",
] as const;
export const SDK_PREFERENCE_OPERATIONS = [
	...SDK_PREFERENCE_QUERY_OPERATIONS,
	...SDK_PREFERENCE_CONTROL_OPERATIONS,
] as const;
export type SdkPreferenceOperation = (typeof SDK_PREFERENCE_OPERATIONS)[number];
export type SdkPreferenceControlOperation = (typeof SDK_PREFERENCE_CONTROL_OPERATIONS)[number];
export type SdkPreferenceQueryOperation = (typeof SDK_PREFERENCE_QUERY_OPERATIONS)[number];
export type SdkPreferenceSelectionScope = "session" | "global";
export type SdkPreferenceConfigScope = SdkPreferenceSelectionScope | "project";

export function isSdkPreferenceOperation(operation: string): operation is SdkPreferenceOperation {
	return SDK_PREFERENCE_OPERATIONS.some(candidate => candidate === operation);
}

export function isSdkPreferenceControlOperation(operation: string): operation is SdkPreferenceControlOperation {
	return SDK_PREFERENCE_CONTROL_OPERATIONS.some(candidate => candidate === operation);
}

export function isSdkPreferenceQueryOperation(operation: string): operation is SdkPreferenceQueryOperation {
	return SDK_PREFERENCE_QUERY_OPERATIONS.some(candidate => candidate === operation);
}

export interface SdkRoleModelPreference {
	role: SessionAgentModelRole;
	/** The effective configured selector, including the session-owned role layer. */
	configured: ModelSelectorValue | null;
	effective: { provider: string; modelId: string; name: string; thinkingLevel: string | null } | null;
	source: "session" | "profile" | "runtime" | "global" | "default";
	configurationResolution: SettingsPathResolution;
	canClear: boolean;
}
export interface SdkRoleModelPreferences {
	roles: SdkRoleModelPreference[];
}
export interface SdkSetRoleModelInput {
	role: SessionAgentModelRole;
	/** Exact provider/model identity, or null to resume current inheritance. */
	modelId: string | null;
}
export interface SdkSelectModelInput {
	provider: string;
	modelId: string;
	scope: SdkPreferenceSelectionScope;
}
export interface SdkSelectProfileInput {
	name: string;
	scope: SdkPreferenceSelectionScope;
}
export interface SdkWriteConfigInput {
	scope: SdkPreferenceConfigScope;
	patch: Record<string, unknown>;
}

export interface SdkPreferenceOutcome {
	scope: SdkPreferenceConfigScope;
	/** Includes canonical profile-ownership commits caused by a session model pick. */
	durability: "session" | "persisted" | "unknown";
	applied: boolean;
	/** Settings publication is not a claim that every engine consumer has reloaded. */
	application: "session" | "settings" | "next-session" | "committed-unapplied" | "recovery-required";
	committedVersion?: number;
	recovery?: DefaultModelSelectionRecovery;
	failure?: { code: "preference_failed"; message: string };
}
export interface SdkSetRoleModelResult extends SdkPreferenceOutcome, SdkRoleModelPreferences {
	role: SessionAgentModelRole;
}
export interface SdkSelectModelResult extends SdkPreferenceOutcome {
	provider: string;
	modelId: string;
}
export interface SdkSelectProfileResult extends SdkPreferenceOutcome {
	profileId: string;
}
export interface SdkWriteConfigResult extends SdkPreferenceOutcome {
	paths: SettingPath[];
	/** Empty if the requesting identity retired after durable commitment. No raw values are returned. */
	settings: SettingCatalogItem[];
}
export type SdkPreferenceResult =
	| SdkRoleModelPreferences
	| SdkSetRoleModelResult
	| SdkSelectModelResult
	| SdkSelectProfileResult
	| SdkWriteConfigResult;

export class SdkPreferenceError extends Error {
	constructor(
		readonly code:
			| "invalid_input"
			| "secret_field_forbidden"
			| "stale_preferences"
			| "preference_busy"
			| "persistence_unavailable"
			| "preference_failed",
		message: string,
	) {
		super(message);
		this.name = "SdkPreferenceError";
	}
}

const ROLES: readonly SessionAgentModelRole[] = ["executor", "planner", "critic", "architect"];
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SECRET_VALUE = /(?:-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH)|\bBearer\s+\S+|\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}|https?:\/\/[^\s/]+:[^\s/]+@)/i;

function invalid(): never {
	throw new SdkPreferenceError("invalid_input", "Invalid preference control input.");
}

/** Snapshot only JSON data, rejecting accessors, prototypes, cycles and credentials before admission. */
function snapshot(value: unknown, depth = 0): unknown {
	if (depth > 16) return invalid();
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : invalid();
	if (typeof value === "string") {
		if (SECRET_VALUE.test(value))
			throw new SdkPreferenceError("secret_field_forbidden", "Secret values are not accepted by preference controls.");
		return value;
	}
	if (!value || typeof value !== "object") return invalid();
	if (Object.getOwnPropertySymbols(value).length > 0) return invalid();
	if (Array.isArray(value)) {
		if (value.length > 4096 || Object.keys(value).length !== value.length) return invalid();
		return Array.from({ length: value.length }, (_, index) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor || !("value" in descriptor)) return invalid();
			return snapshot(descriptor.value, depth + 1);
		});
	}
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid();
	const result: Record<string, unknown> = {};
	const keys = Object.getOwnPropertyNames(value);
	if (keys.length > 4096) return invalid();
	for (const key of keys) {
		if (key.split(".").some(part => UNSAFE_KEYS.has(part))) return invalid();
		if (isSecretConfigKey(key))
			throw new SdkPreferenceError("secret_field_forbidden", "Secret fields are not accepted by preference controls.");
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
		result[key] = snapshot(descriptor.value, depth + 1);
	}
	return result;
}

function record(value: unknown): Record<string, unknown> {
	const result = snapshot(value);
	if (!result || typeof result !== "object" || Array.isArray(result)) return invalid();
	return result as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) invalid();
}

function selectionScope(scope: unknown): SdkPreferenceSelectionScope {
	return scope === "session" || scope === "global" ? scope : invalid();
}

function identity(value: unknown): string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : invalid();
}

/** SDK-owned behavior. Construct only with the trusted live AgentSession, never caller ownership claims. */
export class SdkPreferenceControls {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #registry: ModelRegistry;
	readonly #manager: SessionManager;
	readonly #sessionId: string;
	readonly #sessionFile: string | undefined;
	readonly #cwd: string;
	readonly #managerId: string;
	readonly #identityGeneration: number;
	readonly #lifecycleGeneration: number;
	readonly #cleanups: Array<() => void> = [];
	#disposed = false;
	#inFlight = false;

	constructor(session: AgentSession) {
		this.#session = session;
		this.#settings = session.settings;
		this.#registry = session.modelRegistry;
		this.#manager = session.sessionManager;
		this.#sessionId = session.sessionId;
		this.#sessionFile = session.sessionFile;
		this.#cwd = session.sessionManager.getCwd();
		this.#managerId = session.sessionManager.getSessionId();
		this.#identityGeneration = session.sessionManager.getSessionIdentityGeneration();
		this.#lifecycleGeneration = session.sessionLifecycle.generation;
		const observe = (): void => {
			if (!this.#sameIdentity()) this.dispose();
		};
		this.#cleanups.push(session.subscribeSessionIdentityChanges(observe));
		this.#cleanups.push(session.registerToolSessionTransitionCleanup(observe));
		this.#cleanups.push(session.registerToolSessionCleanup(observe));
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const cleanup of this.#cleanups.splice(0)) cleanup();
	}

	#sameIdentity(): boolean {
		const session = this.#session;
		const lifecycle = session.sessionLifecycle;
		return !this.#disposed && !lifecycle.disposed && lifecycle.generation === this.#lifecycleGeneration &&
			session.settings === this.#settings && session.modelRegistry === this.#registry &&
			session.sessionManager === this.#manager && session.sessionId === this.#sessionId &&
			session.sessionFile === this.#sessionFile && this.#manager.getCwd() === this.#cwd &&
			this.#manager.getSessionId() === this.#managerId &&
			this.#manager.getSessionIdentityGeneration() === this.#identityGeneration;
	}

	#assertIdentity(): void {
		if (!this.#sameIdentity()) {
			this.dispose();
			throw new SdkPreferenceError("stale_preferences", "The preference session identity has retired.");
		}
		if (this.#session.sessionLifecycle.transitioning)
			throw new SdkPreferenceError("preference_busy", "Preferences are unavailable during a session transition.");
	}

	#assertRevision(revision: number): void {
		this.#assertIdentity();
		if (this.#session.getUserModelSelectionRevision() !== revision)
			throw new SdkPreferenceError("preference_busy", "A newer model selection superseded the request.");
	}

	#requirePersistence(): void {
		if (!this.#settings.canPersistDurableConfig() || !this.#settings.canWriteDurableConfig())
			throw new SdkPreferenceError("persistence_unavailable", "Durable preference storage is unavailable.");
	}

	async #mutate<T>(body: () => Promise<T>): Promise<T> {
		this.#assertIdentity();
		if (this.#inFlight) throw new SdkPreferenceError("preference_busy", "A preference operation is already in progress.");
		this.#inFlight = true;
		try {
			return await body();
		} catch (error) {
			if (error instanceof SdkPreferenceError) throw error;
			// Persistence/auth/provider errors can contain paths, endpoints and credentials.
			throw new SdkPreferenceError("preference_failed", "The preference operation could not be completed.");
		} finally {
			this.#inFlight = false;
		}
	}

	readRoles(): SdkRoleModelPreferences {
		this.#assertIdentity();
		const overrides = this.#session.getAgentModelOverrides();
		const installed = this.#session.getProfileInstalledOverrideState();
		const resolution = this.#settings.getResolutionSnapshot()["task.agentModelOverrides"];
		return {
			roles: ROLES.map(role => {
				const owned = this.#session.hasSessionAgentModelOverride(role);
				const runtime = this.#settings.getOverride("task.agentModelOverrides")?.[role] !== undefined;
				const configured = overrides[role];
				const resolved = this.#session.resolveRoleModelWithThinking(role);
				return {
					role,
					configured: configured === undefined ? null : structuredClone(configured),
					effective: resolved.model ? {
						provider: resolved.model.provider, modelId: resolved.model.id, name: resolved.model.name,
						thinkingLevel: resolved.thinkingLevel ?? null,
					} : null,
					source: owned ? "session" : runtime ? installed.agentModelOverrides.has(role) && !installed.manualAgentModelOverrides.has(role) ? "profile" : "runtime" :
						this.#settings.getGlobal("task.agentModelOverrides")?.[role] !== undefined ? "global" : "default",
					configurationResolution: structuredClone(resolution),
					canClear: owned,
				};
			}),
		};
	}

	async #availableModel(provider: string, modelId: string, revision: number): Promise<Model> {
		const available = await this.#session.getAvailableModels();
		this.#assertRevision(revision);
		const model = available.find(candidate => candidate.provider === provider && candidate.id === modelId);
		if (!model) return invalid();
		return model;
	}

	async setRole(input: SdkSetRoleModelInput): Promise<SdkSetRoleModelResult> {
		const value = record(input);
		exactKeys(value, ["role", "modelId"]);
		if (!ROLES.some(role => role === value.role) || (value.modelId !== null && typeof value.modelId !== "string")) invalid();
		const role = value.role as SessionAgentModelRole;
		const modelId = value.modelId;
		return this.#mutate(async () => {
			const revision = this.#session.getUserModelSelectionRevision();
			let model: Model | null = null;
			if (modelId !== null) {
				const qualified = identity(modelId);
				const separator = qualified.indexOf("/");
				if (separator < 1 || separator === qualified.length - 1) invalid();
				model = await this.#availableModel(qualified.slice(0, separator), qualified.slice(separator + 1), revision);
			}
			// This canonical method owns its own admission; never nest it in another lease.
			await this.#session.setSessionAgentModelSelection(role, model);
			this.#assertIdentity();
			return { role, scope: "session", durability: "session", applied: true, application: "session", ...this.readRoles() };
		});
	}

	async selectModel(input: SdkSelectModelInput): Promise<SdkSelectModelResult> {
		const value = record(input);
		exactKeys(value, ["provider", "modelId", "scope"]);
		const provider = identity(value.provider);
		const modelId = identity(value.modelId);
		const scope = selectionScope(value.scope);
		return this.#mutate(async () => {
			if (scope === "global") this.#requirePersistence();
			const revision = this.#session.getUserModelSelectionRevision();
			const before = readDurableModelProfileOwnership(this.#settings);
			const model = await this.#availableModel(provider, modelId, revision);
			try {
				if (scope === "global") {
					await this.#session.setDefaultModelSelection(model, undefined, { onBeforeMutation: () => this.#assertIdentity() });
				} else {
					await this.#session.withSdkControlMutation(async () => {
						this.#assertRevision(revision);
						await this.#session.setModelTemporary(model, undefined, {
							persistAsSessionDefault: true,
							cause: "user-selection",
							shouldMutate: () => {
								this.#assertRevision(revision);
								return true;
							},
						});
					});
				}
			} catch (error) {
				const committed = this.#selectionFailure(error, scope);
				if (committed) return { provider, modelId, ...committed };
				throw error;
			}
			const after = readDurableModelProfileOwnership(this.#settings);
			const persisted = scope === "global" || (this.#settings.canPersistDurableConfig() && after.version !== before.version);
			const applied = this.#sameIdentity() && this.#session.model?.provider === provider && this.#session.model.id === modelId;
			return {
				provider, modelId, scope, durability: persisted ? "persisted" : "session", applied,
				application: applied ? "session" : "committed-unapplied",
				...(after.version !== before.version ? { committedVersion: after.version } : {}),
			};
		});
	}

	#selectionFailure(error: unknown, scope: SdkPreferenceSelectionScope): SdkPreferenceOutcome | undefined {
		if (error instanceof ModelProfileApplyCommittedError) return {
			scope, durability: this.#settings.canPersistDurableConfig() ? "persisted" : "session", applied: false,
			application: "committed-unapplied", committedVersion: error.committedVersion,
		};
		if (error instanceof DefaultModelSelectionRecoveryError) return {
			scope, durability: "unknown", applied: false, application: "recovery-required", recovery: structuredClone(error.recovery),
		};
		return undefined;
	}

	async selectProfile(input: SdkSelectProfileInput): Promise<SdkSelectProfileResult> {
		const value = record(input);
		exactKeys(value, ["name", "scope"]);
		const name = identity(value.name);
		const scope = selectionScope(value.scope);
		return this.#mutate(async () => {
			if (scope === "global") this.#requirePersistence();
			let canonical: string;
			try {
				canonical = validateModelProfileName(name, this.#registry.getModelProfiles(), this.#registry.getError());
			} catch {
				return invalid();
			}
			const revision = this.#session.getUserModelSelectionRevision();
			const profile = this.#registry.getModelProfiles().get(canonical);
			const index = createRegistrySelectorIndex(this.#registry.getAll());
			const missing = Object.values(profile?.modelMapping ?? {}).some(selectors =>
				normalizeModelSelectorValue(selectors).some(selector =>
					selector.includes("/") && !registrySelectorResolvesToModel(selector, index),
				),
			);
			if (missing) {
				await this.#registry.refresh("online", this.#session.credentialSessionId);
				this.#assertRevision(revision);
			}
			try {
				// The native transaction reserves intent synchronously and owns credentials, CAS and lifecycle fencing.
				const result = await this.#session.setDefaultModelProfileForControl(canonical, {
					persistDefault: scope === "global", onBeforeActivation: () => this.#assertIdentity(),
				});
				const applied = this.#sameIdentity() && this.#session.getActiveModelProfile() === result.id;
				return { profileId: result.id, scope, durability: scope === "global" ? "persisted" : "session", applied,
					application: applied ? "session" : "committed-unapplied" };
			} catch (error) {
				const committed = this.#selectionFailure(error, scope);
				if (committed) return { profileId: canonical, ...committed };
				throw error;
			}
		});
	}

	async patchConfig(input: SdkWriteConfigInput): Promise<SdkWriteConfigResult> {
		const value = record(input);
		exactKeys(value, ["scope", "patch"]);
		const scope = value.scope === "project" ? "project" : selectionScope(value.scope);
		const patch = record(value.patch);
		const paths = Object.keys(patch) as SettingPath[];
		if (paths.length === 0 || validateSettingPatch(patch).length > 0) invalid();
		const resolutions = this.#settings.getResolutionSnapshot();
		for (const settingPath of paths) {
			// Selector/profile edits must go through their canonical ownership transactions, never generic config.
			if (!Object.hasOwn(SETTINGS_SCHEMA, settingPath) || settingPath === "modelRoles" ||
				settingPath === "task.agentModelOverrides" || settingPath.startsWith("modelProfile.") ||
				settingPath.startsWith("notifications.") || getUi(settingPath)?.editing === "notification-atomic") invalid();
			const layer = scope === "session" ? "runtime" : scope;
			if (!resolutions[settingPath].allowedLayers.includes(layer)) invalid();
		}
		return this.#mutate(async () => {
			if (scope !== "session") this.#requirePersistence();
			return this.#session.withSdkControlMutation(async () => {
				this.#assertIdentity();
				const patches: SettingsAtomicPatch[] = paths.map(settingPath => ({ path: settingPath, op: "set", value: patch[settingPath] }));
				if (scope === "project") {
					const projectPath = await this.#projectConfigPath();
					try {
						const receipt = await applyAtomicYamlPatchesWithCurrent(projectPath, () => {
							this.#assertIdentity();
							return patches satisfies readonly AtomicYamlPatch[];
						});
						receipt.discard();
					} catch (error) {
						if (error instanceof SdkPreferenceError) throw error;
						// A rejected writer may have renamed before a later durability/publication failure.
						return this.#writeFailure(scope, paths);
					}
					invalidate(projectPath);
					invalidate(path.dirname(projectPath));
					return { scope, durability: "persisted", applied: false, application: "next-session", paths, settings: this.#catalog(paths) };
				}
				if (scope === "global") {
					try {
						const receipt = await this.#settings.commitAtomicBatchWithCurrent(() => {
							this.#assertIdentity();
							return patches;
						});
						receipt.discard();
					} catch (error) {
						if (error instanceof SdkPreferenceError) throw error;
						return this.#writeFailure(scope, paths);
					}
				} else {
					let started = false;
					try {
						for (const settingPath of paths) {
							this.#assertIdentity();
							started = true;
							this.#settings.override(settingPath, patch[settingPath] as SettingValue<SettingPath>);
						}
					} catch (error) {
						if (!started) throw error;
						return this.#writeFailure(scope, paths);
					}
				}
				const applied = this.#sameIdentity() && paths.every(settingPath => util.isDeepStrictEqual(
					scope === "global" ? this.#settings.getGlobal(settingPath) : this.#settings.getOverride(settingPath), patch[settingPath],
				));
				return { scope, durability: scope === "global" ? "persisted" : "session", applied,
					application: applied ? "settings" : "committed-unapplied", paths, settings: this.#catalog(paths) };
			});
		});
	}

	#writeFailure(scope: SdkPreferenceConfigScope, paths: SettingPath[]): SdkWriteConfigResult {
		return {
			scope, durability: scope === "session" ? "session" : "unknown", applied: false,
			application: "recovery-required", paths, settings: this.#catalog(paths),
			failure: { code: "preference_failed", message: "The preference write outcome could not be confirmed." },
		};
	}

	#catalog(paths: readonly SettingPath[]): SettingCatalogItem[] {
		return this.#sameIdentity() ? getSettingsCatalog(this.#settings).items.filter(item => paths.includes(item.path)) : [];
	}

	async #projectConfigPath(): Promise<string> {
		const directory = path.join(this.#cwd, ".gjc");
		await fs.mkdir(directory, { recursive: true });
		// Project scope must not escape through a directory/file symlink into user configuration.
		if ((await fs.lstat(directory)).isSymbolicLink()) invalid();
		const configPath = path.join(directory, "config.yml");
		try {
			if ((await fs.lstat(configPath)).isSymbolicLink()) invalid();
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		const globalPath = this.#settings.getGlobalConfigPath();
		if (globalPath && path.join(await fs.realpath(directory), "config.yml") ===
			path.join(await fs.realpath(path.dirname(globalPath)), path.basename(globalPath))) invalid();
		this.#assertIdentity();
		return configPath;
	}

	/** Closed dispatch seam for ctx.sdkControl; unknown operations/fields never pass through. */
	async handle(operation: SdkPreferenceOperation, input: Record<string, unknown>): Promise<SdkPreferenceResult> {
		switch (operation) {
			case "model.roles.get":
				exactKeys(record(input), []);
				return this.readRoles();
			case "model.role.set": return this.setRole(input as unknown as SdkSetRoleModelInput);
			case "model.select": return this.selectModel(input as unknown as SdkSelectModelInput);
			case "model.profile.select": return this.selectProfile(input as unknown as SdkSelectProfileInput);
			case "config.write": return this.patchConfig(input as unknown as SdkWriteConfigInput);
			default: return invalid();
		}
	}
}

export function createSdkPreferenceControls(session: AgentSession): SdkPreferenceControls {
	return new SdkPreferenceControls(session);
}
