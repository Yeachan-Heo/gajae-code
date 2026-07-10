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
	baselineSessionDefaultModel?: string;
	persistableBaselineThinkingLevel?: ThinkingLevel;
	baselineModelRoles: Record<string, string>;
	baselineAgentModelOverrides: Record<string, string>;
	persistableBaselineModelRoles: Record<string, string>;
	persistableBaselineAgentModelOverrides: Record<string, string>;
	appliedModelRoles: Record<string, string>;
	appliedAgentModelOverrides: Record<string, string>;
	defaultSelector?: string;
	persistedModelProfile: string | undefined;
	persistedModelProfilePendingMutationId: number | undefined;
}

const activeModelProfileRuntimeStates = new WeakMap<object, ActiveModelProfileRuntimeState>();

function deriveProfileBaseline(
	baseline: Record<string, string>,
	current: Record<string, string>,
	applied: Record<string, string>,
): Record<string, string> {
	const next = { ...baseline };
	for (const key of new Set([...Object.keys(baseline), ...Object.keys(current), ...Object.keys(applied)])) {
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
		if (current[key] === value) {
			target[key] = value;
		}
	}
}

type ModelAssignmentPersistenceSettings = Pick<
	Settings,
	| "clearAgentModelOverride"
	| "clearModelRole"
	| "setAgentModelOverride"
	| "setAgentModelOverrideIfUnchanged"
	| "setModelRole"
	| "setModelRoleIfUnchanged"
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
	explicitModelRoles: ReadonlySet<string>,
	explicitAgentModelOverrides: ReadonlySet<string>,
): ModelAssignmentTouchedEntries {
	const touched: ModelAssignmentTouchedEntries = {
		modelRoles: [],
		agentModelOverrides: [],
	};
	for (const role of new Set([
		...Object.keys(previousModelRoles),
		...Object.keys(modelRoles),
		...explicitModelRoles,
	])) {
		const selector = modelRoles[role];
		const explicit = explicitModelRoles.has(role);
		if (previousModelRoles[role] === selector && !explicit) continue;
		if (explicit) {
			if (selector === undefined) {
				settings.clearModelRole(role);
			} else {
				settings.setModelRole(role, selector);
			}
		} else {
			settings.setModelRoleIfUnchanged(role, previousModelRoles[role], selector);
		}
		touched.modelRoles.push(role);
	}
	for (const agentName of new Set([
		...Object.keys(previousAgentModelOverrides),
		...Object.keys(agentModelOverrides),
		...explicitAgentModelOverrides,
	])) {
		const selector = agentModelOverrides[agentName];
		const explicit = explicitAgentModelOverrides.has(agentName);
		if (previousAgentModelOverrides[agentName] === selector && !explicit) continue;
		if (explicit) {
			if (selector === undefined) {
				settings.clearAgentModelOverride(agentName);
			} else {
				settings.setAgentModelOverride(agentName, selector);
			}
		} else {
			settings.setAgentModelOverrideIfUnchanged(agentName, previousAgentModelOverrides[agentName], selector);
		}
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
		| "flushOrThrow"
		| "flush"
		| "get"
		| "getGlobal"
		| "getRuntimeOverride"
		| "getWithoutProject"
		| "override"
		| "set"
		| "getPendingModelProfileDefaultMutationId"
		| "setModelProfileDefaultIfUnchanged"
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
		| "flush"
		| "flushOrThrow"
		| "get"
		| "getGlobal"
		| "getRuntimeOverride"
		| "override"
		| "set"
		| "getPendingModelProfileDefaultMutationId"
		| "setModelProfileDefaultIfUnchanged"
	> &
		ModelAssignmentPersistenceSettings;
	previousModel: Model<Api> | undefined;
	previousThinkingLevel: ThinkingLevel | undefined;
	previousAgentModelOverrides: Record<string, string>;
	previousModelRoles: Record<string, string>;
	previousRuntimeAgentModelOverrides: Record<string, string>;
	previousRuntimeModelRoles: Record<string, string>;
	baselineModel: Model<Api> | undefined;
	baselineThinkingLevel: ThinkingLevel | undefined;
	baselineAgentModelOverrides: Record<string, string>;
	baselineModelRoles: Record<string, string>;
	defaultModel: Model<Api> | undefined;
	defaultThinkingLevel: ThinkingLevel | undefined;
	persistedDefaultThinkingLevel: ThinkingLevel | undefined;
	baselineSessionDefaultModel: string | undefined;
	persistableBaselineThinkingLevel: ThinkingLevel | undefined;
	profileDefaultSelector: string | undefined;
	profileDefaultHasExplicitThinking: boolean;
	persistableBaselineAgentModelOverrides: Record<string, string>;
	persistableBaselineModelRoles: Record<string, string>;
	modelRoles: Record<string, string>;
	agentModelOverrides: Record<string, string>;
	previousPersistedModelProfile: string | undefined;
	previousPersistedModelProfilePendingMutationId: number | undefined;
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
		| "setModelProfileDefaultIfUnchanged"
		| "getPendingModelProfileDefaultMutationId"
		| "clearOverride"
		| "get"
		| "getGlobal"
		| "getRuntimeOverride"
		| "getWithoutProject"
		| "override"
	> &
		ModelAssignmentPersistenceSettings;
	role: GjcModelAssignmentTargetId;
	selector: string | undefined;
}

export interface MaterializeModelProfileAssignmentsOptions {
	session: Pick<
		ModelProfileActivationSession,
		"model" | "thinkingLevel" | "setActiveModelProfile" | "getActiveModelProfile" | "getSessionDefaultModelSelector"
	>;
	settings: Pick<
		Settings,
		| "setModelProfileDefaultIfUnchanged"
		| "getPendingModelProfileDefaultMutationId"
		| "clearOverride"
		| "get"
		| "getGlobal"
		| "getRuntimeOverride"
		| "getWithoutProject"
		| "override"
	> &
		ModelAssignmentPersistenceSettings;
	assignments:
		| ReadonlyMap<GjcModelAssignmentTargetId, string | undefined>
		| Partial<Record<GjcModelAssignmentTargetId, string | undefined>>;
}

function isReadonlyAssignmentMap(
	assignments:
		| ReadonlyMap<GjcModelAssignmentTargetId, string | undefined>
		| Partial<Record<GjcModelAssignmentTargetId, string | undefined>>,
): assignments is ReadonlyMap<GjcModelAssignmentTargetId, string | undefined> {
	return typeof (assignments as { entries?: unknown }).entries === "function";
}

function getMaterializedAssignments(
	assignments:
		| ReadonlyMap<GjcModelAssignmentTargetId, string | undefined>
		| Partial<Record<GjcModelAssignmentTargetId, string | undefined>>,
): Array<[GjcModelAssignmentTargetId, string | undefined]> {
	if (isReadonlyAssignmentMap(assignments)) return [...assignments.entries()];
	const assignmentRecord: Partial<Record<GjcModelAssignmentTargetId, string | undefined>> = assignments;
	return (Object.keys(assignmentRecord) as GjcModelAssignmentTargetId[]).map(role => [role, assignmentRecord[role]]);
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
	const previousPersistedModelProfile = runtimeState ? runtimeState.persistedModelProfile : activeProfile;
	const previousPersistedModelProfilePendingMutationId = runtimeState
		? runtimeState.persistedModelProfilePendingMutationId
		: options.settings.getPendingModelProfileDefaultMutationId();
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
	const currentRuntimeModelRoles = {
		...(options.settings.getRuntimeOverride("modelRoles") ?? {}),
	};
	const currentRuntimeAgentModelOverrides = {
		...(options.settings.getRuntimeOverride("task.agentModelOverrides") ?? {}),
	};
	const runtimeModelRoles = runtimeState
		? deriveProfileBaseline(runtimeState.baselineModelRoles, currentRuntimeModelRoles, runtimeState.appliedModelRoles)
		: currentRuntimeModelRoles;
	const runtimeAgentModelOverrides = runtimeState
		? deriveProfileBaseline(
				runtimeState.baselineAgentModelOverrides,
				currentRuntimeAgentModelOverrides,
				runtimeState.appliedAgentModelOverrides,
			)
		: currentRuntimeAgentModelOverrides;

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
	}

	const explicitModelRoles = new Set<string>();
	const explicitAgentModelOverrides = new Set<string>();
	for (const [role, selector] of materializedAssignments) {
		const target = GJC_MODEL_ASSIGNMENT_TARGETS[role];
		const persisted = target.settingsPath === "modelRoles" ? persistedModelRoles : persistedAgentModelOverrides;
		const runtime = target.settingsPath === "modelRoles" ? runtimeModelRoles : runtimeAgentModelOverrides;
		if (target.settingsPath === "modelRoles") {
			explicitModelRoles.add(role);
		} else {
			explicitAgentModelOverrides.add(role);
		}
		if (selector === undefined) {
			delete persisted[role];
			delete runtime[role];
		} else {
			persisted[role] = selector;
			runtime[role] = selector;
		}
	}

	options.session.setActiveModelProfile?.(undefined);
	const touched = persistModelAssignmentEntries(
		options.settings,
		persistedModelRoles,
		persistedAgentModelOverrides,
		previousPersistedModelRoles,
		previousPersistedAgentModelOverrides,
		explicitModelRoles,
		explicitAgentModelOverrides,
	);
	for (const role of touched.modelRoles) {
		if (!explicitModelRoles.has(role)) delete runtimeModelRoles[role];
	}
	for (const agentName of touched.agentModelOverrides) {
		if (!explicitAgentModelOverrides.has(agentName)) delete runtimeAgentModelOverrides[agentName];
	}
	options.settings.setModelProfileDefaultIfUnchanged(
		previousPersistedModelProfile,
		undefined,
		previousPersistedModelProfilePendingMutationId,
	);
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

export interface ProjectModelProfileShadow {
	profileName: string;
	targetIds: GjcModelAssignmentTargetId[];
}

export function resolveProjectModelProfileShadow(
	settings: Pick<Settings, "getProject">,
	modelRegistry: Pick<ModelRegistry, "getModelProfile" | "getModelProfiles">,
): ProjectModelProfileShadow | undefined {
	const configuredName = settings.getProject("modelProfile.default");
	if (!configuredName) return undefined;
	const profiles = modelRegistry.getModelProfiles();
	const profileName = resolveModelProfileName(configuredName, profiles);
	const profile = profiles.get(profileName) ?? modelRegistry.getModelProfile(profileName);
	if (!profile) return undefined;
	const targetIds = Object.keys(profile.modelMapping).filter((targetId): targetId is GjcModelAssignmentTargetId =>
		Object.hasOwn(GJC_MODEL_ASSIGNMENT_TARGETS, targetId),
	);
	return { profileName, targetIds };
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
	const previousPersistedModelProfile = options.settings.getGlobal("modelProfile.default");
	const previousPersistedModelProfilePendingMutationId = options.settings.getPendingModelProfileDefaultMutationId();
	const previousRuntimeState = previousActiveModelProfile
		? activeModelProfileRuntimeStates.get(options.session)
		: undefined;
	const previousModelRoles = { ...options.settings.get("modelRoles") };
	const previousAgentModelOverrides = {
		...options.settings.get("task.agentModelOverrides"),
	};
	const previousRuntimeModelRoles = { ...(options.settings.getRuntimeOverride("modelRoles") ?? {}) };
	const previousRuntimeAgentModelOverrides = {
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
				previousRuntimeModelRoles,
				previousRuntimeState.appliedModelRoles,
			)
		: previousRuntimeModelRoles;
	const baselineAgentModelOverrides = previousRuntimeState
		? deriveProfileBaseline(
				previousRuntimeState.baselineAgentModelOverrides,
				previousRuntimeAgentModelOverrides,
				previousRuntimeState.appliedAgentModelOverrides,
			)
		: previousRuntimeAgentModelOverrides;
	const baselineModel = previousRuntimeState?.baselineModel ?? options.session.model;
	const baselineThinkingLevel = previousRuntimeState?.baselineThinkingLevel ?? options.session.thinkingLevel;
	const baselineSessionDefaultModel =
		previousRuntimeState?.baselineSessionDefaultModel ?? options.session.getSessionDefaultModelSelector?.();
	const persistableBaselineThinkingLevel =
		previousRuntimeState?.persistableBaselineThinkingLevel ??
		options.settings.getWithoutProject("defaultThinkingLevel");
	const profileInheritsDefaultThinking =
		resolvedDefault !== undefined &&
		(!resolvedDefault.explicitThinkingLevel || resolvedDefault.thinkingLevel === ThinkingLevel.Inherit);
	const resolvedDefaultThinkingLevel = profileInheritsDefaultThinking
		? options.settings.get("defaultThinkingLevel")
		: resolvedDefault?.thinkingLevel;
	const persistedDefaultThinkingLevel = resolvedDefault
		? profileInheritsDefaultThinking
			? persistableBaselineThinkingLevel
			: resolvedDefault.thinkingLevel
		: previousRuntimeState
			? persistableBaselineThinkingLevel
			: undefined;
	const profileDefaultSelector = resolvedDefault?.model
		? formatModelSelectorValue(
				`${resolvedDefault.model.provider}/${resolvedDefault.model.id}`,
				resolvedDefault.thinkingLevel,
			)
		: undefined;
	const profileDefaultHasExplicitThinking =
		resolvedDefault?.explicitThinkingLevel === true &&
		resolvedDefault.thinkingLevel !== undefined &&
		resolvedDefault.thinkingLevel !== ThinkingLevel.Inherit;

	return {
		profileName,
		session: options.session as PreparedModelProfileActivation["session"],
		settings: options.settings as PreparedModelProfileActivation["settings"],
		previousModel: options.session.model,
		previousThinkingLevel: options.session.thinkingLevel,
		previousAgentModelOverrides,
		previousModelRoles,
		previousRuntimeAgentModelOverrides,
		previousRuntimeModelRoles,
		baselineModel,
		baselineThinkingLevel,
		baselineAgentModelOverrides,
		baselineModelRoles,
		defaultModel: resolvedDefault?.model ?? (previousRuntimeState ? baselineModel : undefined),
		defaultThinkingLevel: resolvedDefaultThinkingLevel ?? (previousRuntimeState ? baselineThinkingLevel : undefined),
		persistedDefaultThinkingLevel,
		baselineSessionDefaultModel,
		persistableBaselineThinkingLevel,
		profileDefaultSelector,
		profileDefaultHasExplicitThinking,
		persistableBaselineAgentModelOverrides,
		persistableBaselineModelRoles,
		modelRoles,
		agentModelOverrides,
		previousPersistedModelProfile,
		previousPersistedModelProfilePendingMutationId,
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
	const previousAgentModelOverrides = prepared.previousRuntimeAgentModelOverrides;
	const previousModelRoles = prepared.previousRuntimeModelRoles;
	const previousActiveModelProfile = prepared.previousActiveModelProfile;
	const previousSessionDefaultModel = prepared.previousSessionDefaultModel;
	let modelTransitionStarted = false;
	let persistenceStarted = false;
	const effectiveDefaultThinkingLevel = options.thinkingLevelOverride ?? prepared.defaultThinkingLevel;
	const persistedDefaultThinkingLevel = options.thinkingLevelOverride ?? prepared.persistedDefaultThinkingLevel;
	const materializedDefaultSelector = prepared.profileDefaultSelector
		? options.thinkingLevelOverride !== undefined &&
			prepared.profileDefaultHasExplicitThinking &&
			prepared.defaultModel
			? formatModelSelectorValue(
					`${prepared.defaultModel.provider}/${prepared.defaultModel.id}`,
					effectiveDefaultThinkingLevel,
				)
			: prepared.profileDefaultSelector
		: (prepared.persistableBaselineModelRoles.default ?? prepared.baselineSessionDefaultModel);

	try {
		if (prepared.defaultModel) {
			modelTransitionStarted = true;
			await prepared.session.setModelTemporary(prepared.defaultModel, effectiveDefaultThinkingLevel, {
				persistAsSessionDefault: prepared.profileDefaultSelector !== undefined,
			});
			if (!prepared.profileDefaultSelector && prepared.baselineSessionDefaultModel) {
				prepared.session.recordResumeDefaultModel?.(prepared.baselineSessionDefaultModel);
			}
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
			persistenceStarted = true;
			if (
				prepared.defaultModel &&
				persistedDefaultThinkingLevel !== undefined &&
				persistedDefaultThinkingLevel !== ThinkingLevel.Inherit
			) {
				prepared.settings.set("defaultThinkingLevel", persistedDefaultThinkingLevel);
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
			baselineSessionDefaultModel: prepared.baselineSessionDefaultModel,
			persistedModelProfile: options.persistDefault ? prepared.profileName : prepared.previousPersistedModelProfile,
			persistedModelProfilePendingMutationId: options.persistDefault
				? undefined
				: prepared.previousPersistedModelProfilePendingMutationId,
			persistableBaselineThinkingLevel: prepared.persistableBaselineThinkingLevel,
			baselineModelRoles: { ...prepared.baselineModelRoles },
			baselineAgentModelOverrides: { ...prepared.baselineAgentModelOverrides },
			persistableBaselineModelRoles: { ...prepared.persistableBaselineModelRoles },
			persistableBaselineAgentModelOverrides: {
				...prepared.persistableBaselineAgentModelOverrides,
			},
			appliedModelRoles: { ...prepared.modelRoles },
			appliedAgentModelOverrides: { ...prepared.agentModelOverrides },
			defaultSelector: materializedDefaultSelector,
		});
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		const rollbackModelRoles = persistenceStarted ? prepared.baselineModelRoles : previousModelRoles;
		const rollbackAgentModelOverrides = persistenceStarted
			? prepared.baselineAgentModelOverrides
			: previousAgentModelOverrides;
		const rollbackModel = persistenceStarted ? prepared.baselineModel : previousModel;
		const rollbackThinkingLevel = persistenceStarted ? prepared.baselineThinkingLevel : previousThinkingLevel;
		try {
			prepared.settings.override("modelRoles", rollbackModelRoles);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		try {
			prepared.settings.override("task.agentModelOverrides", rollbackAgentModelOverrides);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		try {
			if (persistenceStarted) {
				prepared.session.setActiveModelProfile?.(undefined);
				clearActiveModelProfileRuntimeState(prepared.session);
			} else {
				prepared.session.setActiveModelProfile?.(previousActiveModelProfile);
			}
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		if (modelTransitionStarted) {
			// Ambiguous persistence detaches to the pre-profile baseline; failures
			// before persistence restore the immediately previous live model.
			if (rollbackModel) {
				try {
					await prepared.session.setModelTemporary(rollbackModel, rollbackThinkingLevel);
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			// Re-assert the resume default matching the runtime state restored above.
			const restoreDefaultSelector =
				(persistenceStarted ? prepared.baselineSessionDefaultModel : previousSessionDefaultModel) ??
				(rollbackModel ? `${rollbackModel.provider}/${rollbackModel.id}` : undefined);
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
	materializedProfileName: string;
	modelRoles: Record<string, string>;
	agentModelOverrides: Record<string, string>;
	previousPersistedModelRoles: Record<string, string>;
	previousPersistedAgentModelOverrides: Record<string, string>;
	previousPersistedDefaultProfile: string | undefined;
	previousRuntimeModelRoles: Record<string, string>;
	previousRuntimeAgentModelOverrides: Record<string, string>;
	previousRuntimeDefaultProfile: string | undefined;
	previousActiveModelProfile: string | undefined;
}

type ModelProfileDeletionSettings = Pick<
	Settings,
	| "clearOverride"
	| "flushOrThrow"
	| "getGlobal"
	| "getRuntimeOverride"
	| "override"
	| "setModelProfileDefaultIfUnchanged"
> &
	ModelAssignmentPersistenceSettings;

function restoreModelProfileDeletionRuntime(
	settings: Pick<Settings, "clearOverride" | "override">,
	snapshot: MaterializeModelProfileForDeletionResult,
): void {
	settings.override("modelRoles", snapshot.previousRuntimeModelRoles);
	settings.override("task.agentModelOverrides", snapshot.previousRuntimeAgentModelOverrides);
	if (snapshot.previousRuntimeDefaultProfile === undefined) {
		settings.clearOverride("modelProfile.default");
	} else {
		settings.override("modelProfile.default", snapshot.previousRuntimeDefaultProfile);
	}
}

function stageModelProfileDeletionRollback(
	settings: ModelProfileDeletionSettings,
	snapshot: MaterializeModelProfileForDeletionResult,
): void {
	const inheritedEntries = new Set<string>();
	persistModelAssignmentEntries(
		settings,
		snapshot.previousPersistedModelRoles,
		snapshot.previousPersistedAgentModelOverrides,
		snapshot.modelRoles,
		snapshot.agentModelOverrides,
		inheritedEntries,
		inheritedEntries,
	);
	if (snapshot.previousPersistedDefaultProfile === snapshot.materializedProfileName) {
		settings.setModelProfileDefaultIfUnchanged(undefined, snapshot.previousPersistedDefaultProfile);
	}
}

export async function materializeModelProfileForDeletion(
	options: PrepareModelProfileActivationOptions & {
		settings: ModelProfileDeletionSettings;
	},
): Promise<MaterializeModelProfileForDeletionResult> {
	const prepared = await prepareModelProfileActivation(options);
	const previousPersistedModelRoles = {
		...(prepared.settings.getGlobal("modelRoles") ?? {}),
	};
	const previousPersistedAgentModelOverrides = {
		...(prepared.settings.getGlobal("task.agentModelOverrides") ?? {}),
	};
	const previousPersistedDefaultProfile = prepared.settings.getGlobal("modelProfile.default");
	const previousRuntimeDefaultProfile = prepared.settings.getRuntimeOverride("modelProfile.default");
	const nextModelRoles = {
		...prepared.persistableBaselineModelRoles,
		...(prepared.defaultModel
			? {
					default: formatModelSelectorValue(
						`${prepared.defaultModel.provider}/${prepared.defaultModel.id}`,
						prepared.defaultThinkingLevel,
					),
				}
			: {}),
		...prepared.modelRoles,
	};
	const nextAgentModelOverrides = {
		...prepared.persistableBaselineAgentModelOverrides,
		...prepared.agentModelOverrides,
	};
	const snapshot: MaterializeModelProfileForDeletionResult = {
		materializedProfileName: prepared.profileName,
		modelRoles: nextModelRoles,
		agentModelOverrides: nextAgentModelOverrides,
		previousPersistedModelRoles,
		previousPersistedAgentModelOverrides,
		previousPersistedDefaultProfile,
		previousRuntimeModelRoles: prepared.previousRuntimeModelRoles,
		previousRuntimeAgentModelOverrides: prepared.previousRuntimeAgentModelOverrides,
		previousRuntimeDefaultProfile,
		previousActiveModelProfile: prepared.previousActiveModelProfile,
	};
	const inheritedEntries = new Set<string>();

	try {
		const touched = persistModelAssignmentEntries(
			prepared.settings,
			nextModelRoles,
			nextAgentModelOverrides,
			previousPersistedModelRoles,
			previousPersistedAgentModelOverrides,
			inheritedEntries,
			inheritedEntries,
		);
		if (previousPersistedDefaultProfile === prepared.profileName) {
			prepared.settings.setModelProfileDefaultIfUnchanged(previousPersistedDefaultProfile, undefined);
		}
		const nextRuntimeModelRoles = { ...prepared.previousRuntimeModelRoles };
		const profileOwnedModelRoles = new Set([
			...touched.modelRoles,
			...Object.keys(prepared.modelRoles),
			...(prepared.profileDefaultSelector ? ["default"] : []),
		]);
		for (const role of profileOwnedModelRoles) delete nextRuntimeModelRoles[role];
		const nextRuntimeAgentModelOverrides = { ...prepared.previousRuntimeAgentModelOverrides };
		const profileOwnedAgentOverrides = new Set([
			...touched.agentModelOverrides,
			...Object.keys(prepared.agentModelOverrides),
		]);
		for (const agentName of profileOwnedAgentOverrides) delete nextRuntimeAgentModelOverrides[agentName];
		prepared.settings.clearOverride("modelProfile.default");
		prepared.settings.override("modelRoles", nextRuntimeModelRoles);
		prepared.settings.override("task.agentModelOverrides", nextRuntimeAgentModelOverrides);
		prepared.session.setActiveModelProfile?.(undefined);
		await prepared.settings.flushOrThrow();
	} catch (error) {
		stageModelProfileDeletionRollback(prepared.settings, snapshot);
		restoreModelProfileDeletionRuntime(prepared.settings, snapshot);
		prepared.session.setActiveModelProfile?.(prepared.previousActiveModelProfile);
		throw error;
	}

	return snapshot;
}

export async function restoreMaterializedModelProfileForDeletion(options: {
	settings: ModelProfileDeletionSettings;
	session: Pick<ModelProfileActivationSession, "setActiveModelProfile">;
	snapshot: MaterializeModelProfileForDeletionResult;
}): Promise<void> {
	stageModelProfileDeletionRollback(options.settings, options.snapshot);
	restoreModelProfileDeletionRuntime(options.settings, options.snapshot);
	options.session.setActiveModelProfile?.(options.snapshot.previousActiveModelProfile);
	await options.settings.flushOrThrow();
}

export async function activateModelProfile(
	options: PrepareModelProfileActivationOptions,
	applyOptions: ApplyModelProfileActivationOptions = {},
): Promise<void> {
	const prepared = await prepareModelProfileActivation(options);
	await applyPreparedModelProfileActivation(prepared, applyOptions);
}
