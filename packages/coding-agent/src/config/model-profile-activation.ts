import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import type { AgentSession } from "../session/agent-session";
import { formatClampedModelSelector } from "../thinking";
import {
	aggregateModelProfileRequiredProviders,
	formatAvailableProfileNames,
	formatModelProfileDisplayLabel,
	resolveProfileBindings,
} from "./model-profiles";
import {
	GJC_MODEL_ASSIGNMENT_TARGETS,
	type GjcModelAssignmentTargetId,
	isAuthenticated,
	type ModelRegistry,
} from "./model-registry";
import { formatModelSelectorValue, resolveModelRoleValue } from "./model-resolver";
import type { Settings } from "./settings";

const LEGACY_MODEL_PROFILE_ALIASES: ReadonlyMap<string, string> = new Map([["codex-standard", "codex-medium"]]);

interface ActiveModelProfileRuntimeState {
	baselineModel?: Model<Api>;
	baselineThinkingLevel?: ThinkingLevel;
	baselineModelRoles: Record<string, string>;
	baselineAgentModelOverrides: Record<string, string>;
	persistableBaselineModelRoles: Record<string, string>;
	persistableBaselineAgentModelOverrides: Record<string, string>;
	appliedModelRoles: Record<string, string>;
	appliedAgentModelOverrides: Record<string, string>;
	defaultSelector?: string;
}

const activeModelProfileRuntimeStates = new WeakMap<object, ActiveModelProfileRuntimeState>();
const deletedModelProfileRuntimeStates = new WeakMap<object, ActiveModelProfileRuntimeState>();

function deriveProfileBaseline(
	baseline: Record<string, string>,
	current: Record<string, string>,
	applied: Record<string, string>,
): Record<string, string> {
	const next = { ...baseline };
	for (const key of new Set([...Object.keys(current), ...Object.keys(applied)])) {
		const currentValue = current[key];
		const appliedValue = applied[key];
		if (currentValue === undefined) {
			delete next[key];
		} else if (appliedValue === undefined || currentValue !== appliedValue) {
			next[key] = currentValue;
		}
	}
	return next;
}

function mergeAppliedProfileAssignments(
	target: Record<string, string>,
	current: Record<string, string>,
	applied: Record<string, string>,
): void {
	for (const [key, value] of Object.entries(applied)) {
		if (current[key] === undefined || current[key] === value) {
			target[key] = value;
		}
	}
}

type ModelAssignmentPersistenceSettings = Pick<
	Settings,
	"clearAgentModelOverride" | "clearModelRole" | "setAgentModelOverride" | "setModelRole"
>;

interface ModelAssignmentTouchedEntries {
	modelRoles: string[];
	agentModelOverrides: string[];
}

function persistModelAssignmentEntries(
	settings: ModelAssignmentPersistenceSettings,
	modelRoles: Record<string, string>,
	agentModelOverrides: Record<string, string>,
	previousModelRoles: Record<string, string>,
	previousAgentModelOverrides: Record<string, string>,
): ModelAssignmentTouchedEntries {
	const touched: ModelAssignmentTouchedEntries = {
		modelRoles: [],
		agentModelOverrides: [],
	};
	for (const [role, selector] of Object.entries(modelRoles)) {
		if (previousModelRoles[role] === selector) continue;
		settings.setModelRole(role, selector);
		touched.modelRoles.push(role);
	}
	for (const [agentName, selector] of Object.entries(agentModelOverrides)) {
		if (previousAgentModelOverrides[agentName] === selector) continue;
		settings.setAgentModelOverride(agentName, selector);
		touched.agentModelOverrides.push(agentName);
	}
	return touched;
}

function clearActiveModelProfileRuntimeState(session: object): void {
	activeModelProfileRuntimeStates.delete(session);
}

type ModelProfileActivationSession = Pick<AgentSession, "model" | "thinkingLevel" | "sessionId"> & {
	setModelTemporary?: AgentSession["setModelTemporary"];
	setActiveModelProfile?: (name: string | undefined) => void;
	getActiveModelProfile?: () => string | undefined;
	getSessionDefaultModelSelector?: () => string | undefined;
	recordResumeDefaultModel?: (selector: string) => void;
};

export interface PrepareModelProfileActivationOptions {
	session: ModelProfileActivationSession;
	modelRegistry: Pick<
		ModelRegistry,
		| "getModelProfile"
		| "getModelProfiles"
		| "getAvailableModelProfileNames"
		| "getApiKeyForProvider"
		| "getAll"
		| "resolveCanonicalModel"
		| "getCanonicalVariants"
		| "getCanonicalId"
	>;
	settings: Pick<
		Settings,
		| "clearGlobal"
		| "clearOverride"
		| "compareAndSwapGlobal"
		| "flushOrThrow"
		| "get"
		| "getGlobal"
		| "getRuntimeOverride"
		| "getWithoutProject"
		| "override"
		| "set"
	> &
		ModelAssignmentPersistenceSettings;
	profileName: string;
}
export interface ApplyModelProfileActivationOptions {
	persistDefault?: boolean;
	thinkingLevelOverride?: ThinkingLevel;
}
export interface PreparedModelProfileActivation {
	profileName: string;
	session: ModelProfileActivationSession & { setModelTemporary: AgentSession["setModelTemporary"] };
	settings: Pick<
		Settings,
		| "clearGlobal"
		| "clearOverride"
		| "compareAndSwapGlobal"
		| "flushOrThrow"
		| "get"
		| "getGlobal"
		| "getRuntimeOverride"
		| "override"
		| "set"
	> &
		ModelAssignmentPersistenceSettings;
	previousModel: Model<Api> | undefined;
	previousThinkingLevel: ThinkingLevel | undefined;
	previousAgentModelOverrides: Record<string, string>;
	previousModelRoles: Record<string, string>;
	baselineModel: Model<Api> | undefined;
	baselineThinkingLevel: ThinkingLevel | undefined;
	baselineAgentModelOverrides: Record<string, string>;
	baselineModelRoles: Record<string, string>;
	defaultModel: Model<Api> | undefined;
	defaultThinkingLevel: ThinkingLevel | undefined;
	profileDefaultSelector: string | undefined;
	persistableBaselineAgentModelOverrides: Record<string, string>;
	persistableBaselineModelRoles: Record<string, string>;
	modelRoles: Record<string, string>;
	agentModelOverrides: Record<string, string>;
	previousActiveModelProfile: string | undefined;
	/**
	 * The session resume default ("provider/id") captured BEFORE activation —
	 * the model resume would restore prior to this profile. Snapshotted
	 * separately from `previousModel` (the live runtime model, which may be a
	 * transient switch) so a failed-activation rollback restores the correct
	 * resume default without promoting a transient model to it.
	 */
	previousSessionDefaultModel: string | undefined;
}
export interface MaterializeModelProfileAssignmentOptions {
	session: Pick<
		ModelProfileActivationSession,
		"model" | "thinkingLevel" | "setActiveModelProfile" | "getActiveModelProfile" | "getSessionDefaultModelSelector"
	>;
	settings: Pick<
		Settings,
		"clearOverride" | "get" | "getGlobal" | "getRuntimeOverride" | "getWithoutProject" | "override" | "set"
	> &
		ModelAssignmentPersistenceSettings;
	role: GjcModelAssignmentTargetId;
	selector: string;
}

export interface MaterializeModelProfileAssignmentsOptions {
	session: Pick<
		ModelProfileActivationSession,
		"model" | "thinkingLevel" | "setActiveModelProfile" | "getActiveModelProfile" | "getSessionDefaultModelSelector"
	>;
	settings: Pick<
		Settings,
		"clearOverride" | "get" | "getGlobal" | "getRuntimeOverride" | "getWithoutProject" | "override" | "set"
	> &
		ModelAssignmentPersistenceSettings;
	assignments: ReadonlyMap<GjcModelAssignmentTargetId, string> | Partial<Record<GjcModelAssignmentTargetId, string>>;
}

function isReadonlyAssignmentMap(
	assignments: ReadonlyMap<GjcModelAssignmentTargetId, string> | Partial<Record<GjcModelAssignmentTargetId, string>>,
): assignments is ReadonlyMap<GjcModelAssignmentTargetId, string> {
	return typeof (assignments as { entries?: unknown }).entries === "function";
}

function getMaterializedAssignments(
	assignments: ReadonlyMap<GjcModelAssignmentTargetId, string> | Partial<Record<GjcModelAssignmentTargetId, string>>,
): Array<[GjcModelAssignmentTargetId, string]> {
	if (isReadonlyAssignmentMap(assignments)) return [...assignments.entries()];
	const assignmentRecord: Partial<Record<GjcModelAssignmentTargetId, string>> = assignments;
	const result: Array<[GjcModelAssignmentTargetId, string]> = [];
	for (const role of Object.keys(assignmentRecord) as GjcModelAssignmentTargetId[]) {
		const selector = assignmentRecord[role];
		if (selector !== undefined) result.push([role, selector]);
	}
	return result;
}

export function materializeActiveModelProfileAssignment(options: MaterializeModelProfileAssignmentOptions): boolean {
	return materializeActiveModelProfileAssignments({
		session: options.session,
		settings: options.settings,
		assignments: { [options.role]: options.selector },
	});
}

export function materializeActiveModelProfileAssignments(options: MaterializeModelProfileAssignmentsOptions): boolean {
	const activeProfile = options.session.getActiveModelProfile
		? options.session.getActiveModelProfile()
		: options.settings.get("modelProfile.default");
	if (!activeProfile) return false;

	const materializedAssignments = getMaterializedAssignments(options.assignments);
	if (materializedAssignments.length === 0) return true;
	const previousPersistedModelRoles = {
		...(options.settings.getGlobal("modelRoles") ?? {}),
	};
	const previousPersistedAgentModelOverrides = {
		...(options.settings.getGlobal("task.agentModelOverrides") ?? {}),
	};

	const runtimeState = activeModelProfileRuntimeStates.get(options.session);
	const currentPersistableModelRoles = {
		...options.settings.getWithoutProject("modelRoles"),
	};
	const currentPersistableAgentModelOverrides = {
		...options.settings.getWithoutProject("task.agentModelOverrides"),
	};
	const persistedModelRoles = runtimeState
		? deriveProfileBaseline(
				runtimeState.persistableBaselineModelRoles,
				currentPersistableModelRoles,
				runtimeState.appliedModelRoles,
			)
		: currentPersistableModelRoles;
	const persistedAgentModelOverrides = runtimeState
		? deriveProfileBaseline(
				runtimeState.persistableBaselineAgentModelOverrides,
				currentPersistableAgentModelOverrides,
				runtimeState.appliedAgentModelOverrides,
			)
		: currentPersistableAgentModelOverrides;
	const runtimeModelRoles = {
		...(options.settings.getRuntimeOverride("modelRoles") ?? {}),
	};
	const runtimeAgentModelOverrides = {
		...(options.settings.getRuntimeOverride("task.agentModelOverrides") ?? {}),
	};

	if (runtimeState) {
		mergeAppliedProfileAssignments(persistedModelRoles, currentPersistableModelRoles, runtimeState.appliedModelRoles);
		mergeAppliedProfileAssignments(
			persistedAgentModelOverrides,
			currentPersistableAgentModelOverrides,
			runtimeState.appliedAgentModelOverrides,
		);
	}
	const authoritativeDefaultSelector =
		runtimeState?.defaultSelector ??
		persistedModelRoles.default ??
		options.session.getSessionDefaultModelSelector?.();
	if (authoritativeDefaultSelector) {
		persistedModelRoles.default = authoritativeDefaultSelector;
		runtimeModelRoles.default = authoritativeDefaultSelector;
	}

	for (const [role, selector] of materializedAssignments) {
		const target = GJC_MODEL_ASSIGNMENT_TARGETS[role];
		if (target.settingsPath === "modelRoles") {
			persistedModelRoles[role] = selector;
			runtimeModelRoles[role] = selector;
		} else {
			persistedAgentModelOverrides[role] = selector;
			runtimeAgentModelOverrides[role] = selector;
		}
	}

	options.session.setActiveModelProfile?.(undefined);
	persistModelAssignmentEntries(
		options.settings,
		persistedModelRoles,
		persistedAgentModelOverrides,
		previousPersistedModelRoles,
		previousPersistedAgentModelOverrides,
	);
	options.settings.set("modelProfile.default", undefined);
	options.settings.clearOverride("modelProfile.default");
	options.settings.override("modelRoles", runtimeModelRoles);
	options.settings.override("task.agentModelOverrides", runtimeAgentModelOverrides);
	clearActiveModelProfileRuntimeState(options.session);
	return true;
}

export function formatModelProfileCredentialError(profileLabel: string, providers: readonly string[]): string {
	return `Model profile "${profileLabel}" requires credentials for: ${providers.join(", ")}. Run /login and configure the missing provider(s), then retry.`;
}

function resolveModelProfileName(profileName: string, profiles: ReadonlyMap<string, unknown>): string {
	// A retired-name alias is fallback-only: never shadow a profile that actually
	// exists under the requested name (e.g. a user-defined `codex-standard`).
	if (profiles.has(profileName)) return profileName;
	const replacement = LEGACY_MODEL_PROFILE_ALIASES.get(profileName);
	return replacement && profiles.has(replacement) ? replacement : profileName;
}

/**
 * Rewrite a selector only within the selector provider's own alternative group.
 * Strict providers are never rewritten, and authenticated alternative providers
 * keep their original selectors.
 */
function rewriteSelectorProvider(
	selector: string,
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
): string {
	const slash = selector.indexOf("/");
	if (slash < 0) return selector;

	const provider = selector.substring(0, slash);
	if (authenticatedProviders.has(provider)) return selector;

	const group = alternativeGroups.find(candidates => candidates.includes(provider));
	if (!group) return selector;

	const replacement = group.find(candidate => authenticatedProviders.has(candidate));
	if (!replacement) return selector;

	return replacement + selector.substring(slash);
}

function rewriteBindingsProviders(
	bindings: {
		defaultSelector?: string;
		modelRoles: Record<string, string>;
		agentModelOverrides: Record<string, string>;
	},
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
): { defaultSelector?: string; modelRoles: Record<string, string>; agentModelOverrides: Record<string, string> } {
	return {
		defaultSelector: bindings.defaultSelector
			? rewriteSelectorProvider(bindings.defaultSelector, authenticatedProviders, alternativeGroups)
			: undefined,
		modelRoles: Object.fromEntries(
			Object.entries(bindings.modelRoles).map(([role, sel]) => [
				role,
				rewriteSelectorProvider(sel, authenticatedProviders, alternativeGroups),
			]),
		),
		agentModelOverrides: Object.fromEntries(
			Object.entries(bindings.agentModelOverrides).map(([role, sel]) => [
				role,
				rewriteSelectorProvider(sel, authenticatedProviders, alternativeGroups),
			]),
		),
	};
}

export async function prepareModelProfileActivation(
	options: PrepareModelProfileActivationOptions,
): Promise<PreparedModelProfileActivation> {
	const profiles = options.modelRegistry.getModelProfiles();
	const profileName = resolveModelProfileName(options.profileName, profiles);
	const profile = profiles.get(profileName) ?? options.modelRegistry.getModelProfile(profileName);
	if (!profile) {
		const available = formatAvailableProfileNames(profiles);
		throw new Error(`Unknown model profile "${options.profileName}". Available profiles: ${available}`);
	}
	const profileLabel = formatModelProfileDisplayLabel(profile);

	const allProviders = aggregateModelProfileRequiredProviders(profile.requiredProviders, profile);
	const alternativeGroups = profile.alternativeProviderGroups ?? [];
	const alternativeSet = new Set(alternativeGroups.flat());

	const missingProviders: string[] = [];
	const authenticatedProviders: string[] = [];
	for (const provider of allProviders) {
		const apiKey = await options.modelRegistry.getApiKeyForProvider(provider, options.session.sessionId);
		if (!isAuthenticated(apiKey)) {
			missingProviders.push(provider);
		} else {
			authenticatedProviders.push(provider);
		}
	}

	// Check strict (non-alternative) providers — all must be authenticated.
	const strictMissing = missingProviders.filter(p => !alternativeSet.has(p));
	if (strictMissing.length > 0) {
		throw new Error(formatModelProfileCredentialError(profileLabel, strictMissing));
	}

	// Check alternative groups — at least one provider per group must be authenticated.
	for (const group of alternativeGroups) {
		const groupAuthenticated = group.some(p => authenticatedProviders.includes(p));
		if (!groupAuthenticated) {
			throw new Error(formatModelProfileCredentialError(profileLabel, [...group]));
		}
	}

	if (authenticatedProviders.length === 0) {
		throw new Error(formatModelProfileCredentialError(profileLabel, missingProviders));
	}

	const availableModels = options.modelRegistry.getAll();
	let bindings = resolveProfileBindings(profile);
	if (missingProviders.length > 0 && alternativeGroups.length > 0) {
		bindings = rewriteBindingsProviders(bindings, new Set(authenticatedProviders), alternativeGroups);
	}
	const resolvedDefault = bindings.defaultSelector
		? resolveModelRoleValue(bindings.defaultSelector, availableModels, {
				settings: options.settings as Settings,
				modelRegistry: options.modelRegistry,
			})
		: undefined;
	if (bindings.defaultSelector && !resolvedDefault?.model) {
		throw new Error(`Model profile "${profileLabel}" default selector did not resolve: ${bindings.defaultSelector}`);
	}

	const modelRoles: Record<string, string> = {};
	for (const [role, selector] of Object.entries(bindings.modelRoles) as [GjcModelAssignmentTargetId, string][]) {
		const resolved = resolveModelRoleValue(selector, availableModels, {
			settings: options.settings as Settings,
			modelRegistry: options.modelRegistry,
		});
		if (!resolved.model) {
			throw new Error(`Model profile "${profileLabel}" ${role} selector did not resolve: ${selector}`);
		}
		modelRoles[role] = formatClampedModelSelector(selector, resolved.model);
	}

	const agentModelOverrides: Record<string, string> = {};
	for (const [role, selector] of Object.entries(bindings.agentModelOverrides) as [
		GjcModelAssignmentTargetId,
		string,
	][]) {
		const resolved = resolveModelRoleValue(selector, availableModels, {
			settings: options.settings as Settings,
			modelRegistry: options.modelRegistry,
		});
		if (!resolved.model) {
			throw new Error(`Model profile "${profileLabel}" ${role} selector did not resolve: ${selector}`);
		}
		agentModelOverrides[role] = formatClampedModelSelector(selector, resolved.model);
	}

	const previousActiveModelProfile = options.session.getActiveModelProfile?.();
	const previousRuntimeState = previousActiveModelProfile
		? activeModelProfileRuntimeStates.get(options.session)
		: undefined;
	const previousModelRoles = { ...(options.settings.getRuntimeOverride("modelRoles") ?? {}) };
	const previousAgentModelOverrides = {
		...(options.settings.getRuntimeOverride("task.agentModelOverrides") ?? {}),
	};
	const currentPersistableModelRoles = {
		...options.settings.getWithoutProject("modelRoles"),
	};
	const currentPersistableAgentModelOverrides = {
		...options.settings.getWithoutProject("task.agentModelOverrides"),
	};
	const persistableBaselineModelRoles = previousRuntimeState
		? deriveProfileBaseline(
				previousRuntimeState.persistableBaselineModelRoles,
				currentPersistableModelRoles,
				previousRuntimeState.appliedModelRoles,
			)
		: currentPersistableModelRoles;
	const persistableBaselineAgentModelOverrides = previousRuntimeState
		? deriveProfileBaseline(
				previousRuntimeState.persistableBaselineAgentModelOverrides,
				currentPersistableAgentModelOverrides,
				previousRuntimeState.appliedAgentModelOverrides,
			)
		: currentPersistableAgentModelOverrides;
	const baselineModelRoles = previousRuntimeState
		? deriveProfileBaseline(
				previousRuntimeState.baselineModelRoles,
				previousModelRoles,
				previousRuntimeState.appliedModelRoles,
			)
		: previousModelRoles;
	const baselineAgentModelOverrides = previousRuntimeState
		? deriveProfileBaseline(
				previousRuntimeState.baselineAgentModelOverrides,
				previousAgentModelOverrides,
				previousRuntimeState.appliedAgentModelOverrides,
			)
		: previousAgentModelOverrides;
	const baselineModel = previousRuntimeState?.baselineModel ?? options.session.model;
	const baselineThinkingLevel = previousRuntimeState?.baselineThinkingLevel ?? options.session.thinkingLevel;
	const profileDefaultSelector = resolvedDefault?.model
		? formatModelSelectorValue(
				`${resolvedDefault.model.provider}/${resolvedDefault.model.id}`,
				resolvedDefault.thinkingLevel,
			)
		: undefined;

	return {
		profileName,
		session: options.session as PreparedModelProfileActivation["session"],
		settings: options.settings as PreparedModelProfileActivation["settings"],
		previousModel: options.session.model,
		previousThinkingLevel: options.session.thinkingLevel,
		previousAgentModelOverrides,
		previousModelRoles,
		baselineModel,
		baselineThinkingLevel,
		baselineAgentModelOverrides,
		baselineModelRoles,
		defaultModel: resolvedDefault?.model ?? (previousRuntimeState ? baselineModel : undefined),
		defaultThinkingLevel:
			resolvedDefault?.thinkingLevel ?? (previousRuntimeState ? baselineThinkingLevel : undefined),
		profileDefaultSelector,
		persistableBaselineAgentModelOverrides,
		persistableBaselineModelRoles,
		modelRoles,
		agentModelOverrides,
		previousActiveModelProfile,
		previousSessionDefaultModel: options.session.getSessionDefaultModelSelector?.(),
	};
}

export async function applyPreparedModelProfileActivation(
	prepared: PreparedModelProfileActivation,
	options: ApplyModelProfileActivationOptions = {},
): Promise<void> {
	const previousModel = prepared.previousModel;
	const previousThinkingLevel = prepared.previousThinkingLevel;
	const previousAgentModelOverrides = prepared.previousAgentModelOverrides;
	const previousModelRoles = prepared.previousModelRoles;
	const previousPersistedDefault = prepared.settings.getGlobal("modelProfile.default");
	const previousDefaultThinkingLevel = prepared.settings.getGlobal("defaultThinkingLevel");
	const previousPersistedDefaultPresent = previousPersistedDefault !== undefined;
	const previousDefaultThinkingLevelPresent = previousDefaultThinkingLevel !== undefined;
	const previousActiveModelProfile = prepared.previousActiveModelProfile;
	const previousSessionDefaultModel = prepared.previousSessionDefaultModel;
	let modelChanged = false;
	let defaultChanged = false;
	let defaultThinkingChanged = false;
	const effectiveDefaultThinkingLevel = options.thinkingLevelOverride ?? prepared.defaultThinkingLevel;

	try {
		if (prepared.defaultModel) {
			await prepared.session.setModelTemporary(prepared.defaultModel, effectiveDefaultThinkingLevel, {
				persistAsSessionDefault: true,
			});
			modelChanged = true;
		}
		if (prepared.previousActiveModelProfile || Object.keys(prepared.modelRoles).length > 0) {
			prepared.settings.override("modelRoles", {
				...prepared.baselineModelRoles,
				...prepared.modelRoles,
			});
		}
		if (prepared.previousActiveModelProfile || Object.keys(prepared.agentModelOverrides).length > 0) {
			prepared.settings.override("task.agentModelOverrides", {
				...prepared.baselineAgentModelOverrides,
				...prepared.agentModelOverrides,
			});
		}
		if (options.persistDefault) {
			defaultChanged = true;
			defaultThinkingChanged = prepared.defaultModel !== undefined;
			if (
				prepared.defaultModel &&
				effectiveDefaultThinkingLevel !== undefined &&
				effectiveDefaultThinkingLevel !== ThinkingLevel.Inherit
			) {
				prepared.settings.set("defaultThinkingLevel", effectiveDefaultThinkingLevel);
			} else if (prepared.defaultModel) {
				prepared.settings.clearGlobal("defaultThinkingLevel");
			}
			prepared.settings.set("modelProfile.default", prepared.profileName);
			await prepared.settings.flushOrThrow();
		}
		prepared.session.setActiveModelProfile?.(prepared.profileName);
		activeModelProfileRuntimeStates.set(prepared.session, {
			baselineModel: prepared.baselineModel,
			baselineThinkingLevel: prepared.baselineThinkingLevel,
			baselineModelRoles: { ...prepared.baselineModelRoles },
			baselineAgentModelOverrides: { ...prepared.baselineAgentModelOverrides },
			persistableBaselineModelRoles: { ...prepared.persistableBaselineModelRoles },
			persistableBaselineAgentModelOverrides: {
				...prepared.persistableBaselineAgentModelOverrides,
			},
			appliedModelRoles: { ...prepared.modelRoles },
			appliedAgentModelOverrides: { ...prepared.agentModelOverrides },
			defaultSelector: prepared.profileDefaultSelector,
		});
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		if (defaultChanged) {
			try {
				if (previousPersistedDefaultPresent) {
					prepared.settings.set("modelProfile.default", previousPersistedDefault);
				} else {
					prepared.settings.clearGlobal("modelProfile.default");
				}
				if (defaultThinkingChanged) {
					if (previousDefaultThinkingLevelPresent) {
						prepared.settings.set("defaultThinkingLevel", previousDefaultThinkingLevel);
					} else {
						prepared.settings.clearGlobal("defaultThinkingLevel");
					}
				}
				await prepared.settings.flushOrThrow();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		try {
			prepared.settings.override("modelRoles", previousModelRoles);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		try {
			prepared.settings.override("task.agentModelOverrides", previousAgentModelOverrides);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		try {
			prepared.session.setActiveModelProfile?.(previousActiveModelProfile);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		if (modelChanged) {
			// Runtime rolls back to the pre-activation live model. That model may
			// itself be a transient retry/fallback/context-promotion/plan switch,
			// so it is recorded as role:"temporary" (NOT the resume default).
			if (previousModel) {
				try {
					await prepared.session.setModelTemporary(previousModel, previousThinkingLevel);
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			// Re-assert the pre-activation resume default after the failed profile
			// activation appended its own role:"default" model change.
			const restoreDefaultSelector =
				previousSessionDefaultModel ??
				(previousModel ? `${previousModel.provider}/${previousModel.id}` : undefined);
			if (restoreDefaultSelector) {
				try {
					prepared.session.recordResumeDefaultModel?.(restoreDefaultSelector);
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
		}
		if (rollbackErrors.length > 0) {
			const activationMessage = error instanceof Error ? error.message : String(error);
			throw new AggregateError(
				[error, ...rollbackErrors],
				`Model profile activation failed (${activationMessage}) and rollback also failed`,
			);
		}
		throw error;
	}
}

export interface MaterializeModelProfileForDeletionResult {
	modelRoles: Record<string, string>;
	agentModelOverrides: Record<string, string>;
	previousModelRoles: Record<string, string>;
	previousAgentModelOverrides: Record<string, string>;
	previousPersistedModelRoles: Record<string, string>;
	previousPersistedAgentModelOverrides: Record<string, string>;
	touchedModelRoles: string[];
	touchedAgentModelOverrides: string[];
	previousDefaultProfile: string | undefined;
	previousPersistedDefaultProfile: string | undefined;
	previousActiveModelProfile: string | undefined;
}
type DeletionRollbackSettings = Pick<Settings, "clearOverride" | "compareAndSwapGlobal" | "override">;

async function restoreDeletionSettings(
	settings: DeletionRollbackSettings,
	snapshot: MaterializeModelProfileForDeletionResult,
): Promise<void> {
	const updates = [
		...snapshot.touchedModelRoles.map(role => ({
			path: `modelRoles.${role}`,
			expectedValue: snapshot.modelRoles[role],
			value: snapshot.previousPersistedModelRoles[role],
		})),
		...snapshot.touchedAgentModelOverrides.map(agentName => ({
			path: `task.agentModelOverrides.${agentName}`,
			expectedValue: snapshot.agentModelOverrides[agentName],
			value: snapshot.previousPersistedAgentModelOverrides[agentName],
		})),
		{
			path: "modelProfile.default",
			expectedValue: undefined,
			value: snapshot.previousPersistedDefaultProfile,
		},
	];
	const restoredPaths = await settings.compareAndSwapGlobal(updates);

	const restoredModelRoles = { ...snapshot.previousModelRoles };
	for (const role of snapshot.touchedModelRoles) {
		if (!restoredPaths.has(`modelRoles.${role}`)) {
			delete restoredModelRoles[role];
		}
	}
	const restoredAgentModelOverrides = { ...snapshot.previousAgentModelOverrides };
	for (const agentName of snapshot.touchedAgentModelOverrides) {
		if (!restoredPaths.has(`task.agentModelOverrides.${agentName}`)) {
			delete restoredAgentModelOverrides[agentName];
		}
	}

	settings.override("modelRoles", restoredModelRoles);
	settings.override("task.agentModelOverrides", restoredAgentModelOverrides);
	if (restoredPaths.has("modelProfile.default")) {
		settings.override("modelProfile.default", snapshot.previousDefaultProfile);
	} else {
		settings.clearOverride("modelProfile.default");
	}
}

export async function materializeModelProfileForDeletion(
	options: PrepareModelProfileActivationOptions & {
		settings: Pick<
			Settings,
			| "clearOverride"
			| "compareAndSwapGlobal"
			| "flushOrThrow"
			| "get"
			| "getGlobal"
			| "getRuntimeOverride"
			| "override"
			| "set"
		> &
			ModelAssignmentPersistenceSettings;
	},
): Promise<MaterializeModelProfileForDeletionResult> {
	const previousRuntimeState = activeModelProfileRuntimeStates.get(options.session);
	const prepared = await prepareModelProfileActivation(options);
	const previousDefaultProfile = prepared.settings.get("modelProfile.default");
	const previousPersistedDefaultProfile = prepared.settings.getGlobal("modelProfile.default");
	const previousPersistedModelRoles = { ...(prepared.settings.getGlobal("modelRoles") ?? {}) };
	const previousPersistedAgentModelOverrides = {
		...(prepared.settings.getGlobal("task.agentModelOverrides") ?? {}),
	};
	const nextModelRoles = {
		...prepared.persistableBaselineModelRoles,
		...(prepared.profileDefaultSelector ? { default: prepared.profileDefaultSelector } : {}),
		...prepared.modelRoles,
	};
	const nextAgentModelOverrides = {
		...prepared.persistableBaselineAgentModelOverrides,
		...prepared.agentModelOverrides,
	};
	const nextRuntimeModelRoles = {
		...prepared.previousModelRoles,
		...(prepared.profileDefaultSelector ? { default: prepared.profileDefaultSelector } : {}),
		...prepared.modelRoles,
	};
	const nextRuntimeAgentModelOverrides = {
		...prepared.previousAgentModelOverrides,
		...prepared.agentModelOverrides,
	};
	let touchedEntries: ModelAssignmentTouchedEntries = {
		modelRoles: [],
		agentModelOverrides: [],
	};

	try {
		touchedEntries = persistModelAssignmentEntries(
			prepared.settings,
			nextModelRoles,
			nextAgentModelOverrides,
			previousPersistedModelRoles,
			previousPersistedAgentModelOverrides,
		);
		prepared.settings.set("modelProfile.default", undefined);
		prepared.settings.clearOverride("modelProfile.default");
		prepared.settings.override("modelRoles", nextRuntimeModelRoles);
		prepared.settings.override("task.agentModelOverrides", nextRuntimeAgentModelOverrides);
		await prepared.settings.flushOrThrow();
		prepared.session.setActiveModelProfile?.(undefined);
		clearActiveModelProfileRuntimeState(prepared.session);
	} catch (error) {
		try {
			await restoreDeletionSettings(prepared.settings, {
				modelRoles: nextModelRoles,
				agentModelOverrides: nextAgentModelOverrides,
				previousModelRoles: prepared.previousModelRoles,
				previousAgentModelOverrides: prepared.previousAgentModelOverrides,
				previousPersistedModelRoles,
				previousPersistedAgentModelOverrides,
				touchedModelRoles: touchedEntries.modelRoles,
				touchedAgentModelOverrides: touchedEntries.agentModelOverrides,
				previousDefaultProfile,
				previousPersistedDefaultProfile,
				previousActiveModelProfile: prepared.previousActiveModelProfile,
			});
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				"Model profile deletion materialization and rollback both failed",
			);
		}
		throw error;
	}

	const result: MaterializeModelProfileForDeletionResult = {
		modelRoles: nextModelRoles,
		agentModelOverrides: nextAgentModelOverrides,
		previousModelRoles: prepared.previousModelRoles,
		previousAgentModelOverrides: prepared.previousAgentModelOverrides,
		previousPersistedModelRoles,
		previousPersistedAgentModelOverrides,
		touchedModelRoles: touchedEntries.modelRoles,
		touchedAgentModelOverrides: touchedEntries.agentModelOverrides,
		previousDefaultProfile,
		previousPersistedDefaultProfile,
		previousActiveModelProfile: prepared.previousActiveModelProfile,
	};
	if (previousRuntimeState) {
		deletedModelProfileRuntimeStates.set(result, previousRuntimeState);
	}
	return result;
}

export async function restoreMaterializedModelProfileForDeletion(options: {
	settings: DeletionRollbackSettings;
	session: Pick<ModelProfileActivationSession, "setActiveModelProfile">;
	snapshot: MaterializeModelProfileForDeletionResult;
}): Promise<void> {
	await restoreDeletionSettings(options.settings, options.snapshot);
	options.session.setActiveModelProfile?.(options.snapshot.previousActiveModelProfile);
	const previousRuntimeState = deletedModelProfileRuntimeStates.get(options.snapshot);
	if (previousRuntimeState) {
		activeModelProfileRuntimeStates.set(options.session, previousRuntimeState);
	}
}

export async function activateModelProfile(
	options: PrepareModelProfileActivationOptions,
	applyOptions: ApplyModelProfileActivationOptions = {},
): Promise<void> {
	const prepared = await prepareModelProfileActivation(options);
	await applyPreparedModelProfileActivation(prepared, applyOptions);
}
