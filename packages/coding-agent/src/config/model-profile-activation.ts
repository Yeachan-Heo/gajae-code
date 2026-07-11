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
import type { RuntimeModelProfileDefaultState, Settings } from "./settings";

const LEGACY_MODEL_PROFILE_ALIASES: ReadonlyMap<string, string> = new Map([["codex-standard", "codex-medium"]]);

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
		| "get"
		| "getGlobal"
		| "getRuntimeModelProfileDefaultState"
		| "getRuntimeModelRoles"
		| "getRuntimeAgentModelOverrides"
		| "getPersistedModelProfileDefaultState"
	>;
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
		| "clearOverride"
		| "flushOrThrow"
		| "get"
		| "getGlobal"
		| "getRuntimeAgentModelOverrides"
		| "getRuntimeModelRoles"
		| "override"
		| "set"
		| "persistAgentModelOverride"
		| "persistModelRole"
		| "replacePersistedAgentModelOverrides"
		| "replacePersistedModelRoles"
		| "persistModelProfileDefaultSuppression"
		| "restorePersistedModelProfileDefault"
		| "getPersistedModelProfileDefaultState"
		| "getRuntimeModelProfileDefaultState"
		| "restoreRuntimeModelProfileDefault"
		| "suppressModelProfileDefault"
	>;
	previousModel: Model<Api> | undefined;
	previousThinkingLevel: ThinkingLevel | undefined;
	previousAgentModelOverrides: Record<string, string>;
	previousModelRoles: Record<string, string>;
	previousPersistedAgentModelOverrides: Record<string, string> | undefined;
	previousPersistedModelRoles: Record<string, string> | undefined;
	previousRuntimeAgentModelOverrides: Record<string, string>;
	previousRuntimeModelRoles: Record<string, string>;
	previousRuntimeModelProfileDefault: RuntimeModelProfileDefaultState;
	previousPersistedModelProfileDefault: RuntimeModelProfileDefaultState;
	defaultModel: Model<Api> | undefined;
	defaultThinkingLevel: ThinkingLevel | undefined;
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
		"model" | "thinkingLevel" | "setActiveModelProfile" | "getActiveModelProfile"
	>;
	settings: Pick<
		Settings,
		| "clearOverride"
		| "get"
		| "getGlobal"
		| "getRuntimeAgentModelOverrides"
		| "getRuntimeModelRoles"
		| "override"
		| "set"
		| "persistAgentModelOverride"
		| "persistModelRole"
		| "setModelRole"
		| "setAgentModelOverride"
		| "suppressModelProfileDefault"
		| "persistModelProfileDefaultSuppression"
	>;
	role: GjcModelAssignmentTargetId;
	selector: string;
}

export interface MaterializeModelProfileAssignmentsOptions {
	session: Pick<
		ModelProfileActivationSession,
		"model" | "thinkingLevel" | "setActiveModelProfile" | "getActiveModelProfile"
	>;
	settings: Pick<
		Settings,
		| "clearOverride"
		| "get"
		| "getGlobal"
		| "getRuntimeAgentModelOverrides"
		| "getRuntimeModelRoles"
		| "override"
		| "set"
		| "persistAgentModelOverride"
		| "persistModelRole"
		| "setModelRole"
		| "setAgentModelOverride"
		| "suppressModelProfileDefault"
		| "persistModelProfileDefaultSuppression"
	>;
	assignments: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
}

function isReadonlyAssignmentMap(
	assignments: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): assignments is ReadonlyMap<string, string> {
	return typeof (assignments as { entries?: unknown }).entries === "function";
}

function getMaterializedAssignments(
	assignments: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): Array<[string, string]> {
	if (isReadonlyAssignmentMap(assignments)) return [...assignments.entries()];
	const result: Array<[string, string]> = [];
	for (const [role, selector] of Object.entries(assignments)) {
		if (selector !== undefined) result.push([role, selector]);
	}
	return result;
}

function assignmentSettingsPath(role: string): "modelRoles" | "task.agentModelOverrides" {
	return role === "default" ||
		GJC_MODEL_ASSIGNMENT_TARGETS[role as GjcModelAssignmentTargetId]?.settingsPath === "modelRoles"
		? "modelRoles"
		: "task.agentModelOverrides";
}
function setAssignment(record: Record<string, string>, key: string, selector: string): void {
	Object.defineProperty(record, key, {
		value: selector,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

export function materializeActiveModelProfileAssignment(options: MaterializeModelProfileAssignmentOptions): boolean {
	const activeProfile = options.session.getActiveModelProfile?.() ?? options.settings.get("modelProfile.default");
	if (!activeProfile) return false;

	const nextModelRoles = { ...options.settings.getRuntimeModelRoles() };
	const nextAgentModelOverrides = { ...options.settings.getRuntimeAgentModelOverrides() };
	const effectiveModelRoles = options.settings.get("modelRoles");
	const target = GJC_MODEL_ASSIGNMENT_TARGETS[options.role];

	if (options.role === "default") {
		nextModelRoles.default = options.selector;
	} else if (!effectiveModelRoles.default && !nextModelRoles.default && options.session.model) {
		nextModelRoles.default = formatModelSelectorValue(
			`${options.session.model.provider}/${options.session.model.id}`,
			options.session.thinkingLevel,
		);
	}

	if (target.settingsPath === "modelRoles") {
		setAssignment(nextModelRoles, options.role, options.selector);
	} else {
		setAssignment(nextAgentModelOverrides, options.role, options.selector);
	}

	for (const [role, selector] of Object.entries(nextModelRoles)) {
		options.settings.persistModelRole(role, selector);
	}
	for (const [agentName, selector] of Object.entries(nextAgentModelOverrides)) {
		options.settings.persistAgentModelOverride(agentName, selector);
	}
	options.settings.persistModelProfileDefaultSuppression();
	options.settings.suppressModelProfileDefault();
	options.settings.override("modelRoles", nextModelRoles);
	options.settings.override("task.agentModelOverrides", nextAgentModelOverrides);
	if (target.settingsPath === "modelRoles") {
		options.settings.setModelRole(options.role, options.selector);
	} else {
		options.settings.setAgentModelOverride(options.role, options.selector);
	}
	options.session.setActiveModelProfile?.(undefined);
	return true;
}

export function materializeActiveModelProfileAssignments(options: MaterializeModelProfileAssignmentsOptions): boolean {
	const activeProfile = options.session.getActiveModelProfile?.() ?? options.settings.get("modelProfile.default");
	if (!activeProfile) return false;

	const materializedAssignments = getMaterializedAssignments(options.assignments);

	const nextModelRoles = { ...options.settings.getRuntimeModelRoles() };
	const nextAgentModelOverrides = { ...options.settings.getRuntimeAgentModelOverrides() };
	const effectiveModelRoles = options.settings.get("modelRoles");
	const includesDefault = materializedAssignments.some(([role]) => role === "default");

	if (!includesDefault && !effectiveModelRoles.default && !nextModelRoles.default && options.session.model) {
		nextModelRoles.default = formatModelSelectorValue(
			`${options.session.model.provider}/${options.session.model.id}`,
			options.session.thinkingLevel,
		);
	}

	for (const [role, selector] of materializedAssignments) {
		if (assignmentSettingsPath(role) === "modelRoles") {
			setAssignment(nextModelRoles, role, selector);
		} else {
			setAssignment(nextAgentModelOverrides, role, selector);
		}
	}

	for (const [role, selector] of Object.entries(nextModelRoles)) {
		options.settings.persistModelRole(role, selector);
	}
	for (const [agentName, selector] of Object.entries(nextAgentModelOverrides)) {
		options.settings.persistAgentModelOverride(agentName, selector);
	}
	options.settings.persistModelProfileDefaultSuppression();
	options.settings.suppressModelProfileDefault();
	options.settings.override("modelRoles", nextModelRoles);
	options.settings.override("task.agentModelOverrides", nextAgentModelOverrides);
	for (const [role, selector] of materializedAssignments) {
		if (assignmentSettingsPath(role) === "modelRoles") {
			options.settings.setModelRole(role, selector);
		} else {
			options.settings.setAgentModelOverride(role, selector);
		}
	}
	options.session.setActiveModelProfile?.(undefined);
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

	return {
		profileName,
		session: options.session as PreparedModelProfileActivation["session"],
		settings: options.settings as PreparedModelProfileActivation["settings"],
		previousModel: options.session.model,
		previousThinkingLevel: options.session.thinkingLevel,
		previousAgentModelOverrides: { ...options.settings.get("task.agentModelOverrides") },
		previousModelRoles: { ...options.settings.get("modelRoles") },
		previousPersistedAgentModelOverrides:
			options.settings.getGlobal("task.agentModelOverrides") === undefined
				? undefined
				: { ...options.settings.getGlobal("task.agentModelOverrides") },
		previousPersistedModelRoles:
			options.settings.getGlobal("modelRoles") === undefined
				? undefined
				: { ...options.settings.getGlobal("modelRoles") },
		previousRuntimeAgentModelOverrides: { ...options.settings.getRuntimeAgentModelOverrides() },
		previousRuntimeModelRoles: { ...options.settings.getRuntimeModelRoles() },
		previousRuntimeModelProfileDefault: options.settings.getRuntimeModelProfileDefaultState(),
		previousPersistedModelProfileDefault: options.settings.getPersistedModelProfileDefaultState(),
		defaultModel: resolvedDefault?.model,
		defaultThinkingLevel: resolvedDefault?.thinkingLevel,
		modelRoles,
		agentModelOverrides,
		previousActiveModelProfile: options.session.getActiveModelProfile?.(),
		previousSessionDefaultModel: options.session.getSessionDefaultModelSelector?.(),
	};
}

export async function applyPreparedModelProfileActivation(
	prepared: PreparedModelProfileActivation,
	options: ApplyModelProfileActivationOptions = {},
): Promise<void> {
	const previousModel = prepared.previousModel;
	const previousThinkingLevel = prepared.previousThinkingLevel;
	const previousPersistedAgentModelOverrides = prepared.previousPersistedAgentModelOverrides;
	const previousPersistedModelRoles = prepared.previousPersistedModelRoles;
	const previousRuntimeAgentModelOverrides = prepared.previousRuntimeAgentModelOverrides;
	const previousRuntimeModelRoles = prepared.previousRuntimeModelRoles;
	const previousPersistedDefault = prepared.previousPersistedModelProfileDefault;
	const previousDefaultThinkingLevel = prepared.settings.getGlobal("defaultThinkingLevel");
	const previousActiveModelProfile = prepared.previousActiveModelProfile;
	const previousSessionDefaultModel = prepared.previousSessionDefaultModel;
	let modelChanged = false;
	let overridesChanged = false;
	let defaultChanged = false;
	let modelRolesChanged = false;
	let defaultThinkingChanged = false;

	try {
		if (prepared.defaultModel) {
			await prepared.session.setModelTemporary(
				prepared.defaultModel,
				options.thinkingLevelOverride ?? prepared.defaultThinkingLevel,
				{
					persistAsSessionDefault: true,
				},
			);
			modelChanged = true;
		}
		if (Object.keys(prepared.modelRoles).length > 0) {
			prepared.settings.override("modelRoles", { ...previousRuntimeModelRoles, ...prepared.modelRoles });
			modelRolesChanged = true;
		}
		if (Object.keys(prepared.agentModelOverrides).length > 0) {
			prepared.settings.override("task.agentModelOverrides", {
				...previousRuntimeAgentModelOverrides,
				...prepared.agentModelOverrides,
			});
			overridesChanged = true;
		}
		if (options.persistDefault) {
			prepared.settings.set("modelRoles", {});
			prepared.settings.set("task.agentModelOverrides", {});
			if (prepared.defaultThinkingLevel !== undefined && prepared.defaultThinkingLevel !== ThinkingLevel.Inherit) {
				prepared.settings.set("defaultThinkingLevel", prepared.defaultThinkingLevel);
				defaultThinkingChanged = true;
			}
			prepared.settings.clearOverride("modelProfile.default");
			prepared.settings.set("modelProfile.default", prepared.profileName);
			defaultChanged = true;
			await prepared.settings.flushOrThrow();
		}
		prepared.session.setActiveModelProfile?.(prepared.profileName);
	} catch (error) {
		if (defaultChanged) {
			prepared.settings.restorePersistedModelProfileDefault(previousPersistedDefault);
			prepared.settings.replacePersistedModelRoles(previousPersistedModelRoles);
			prepared.settings.replacePersistedAgentModelOverrides(previousPersistedAgentModelOverrides);
			prepared.settings.restoreRuntimeModelProfileDefault(prepared.previousRuntimeModelProfileDefault);
			if (defaultThinkingChanged) {
				prepared.settings.set("defaultThinkingLevel", previousDefaultThinkingLevel as never);
			}
		}
		if (modelRolesChanged) {
			prepared.settings.override("modelRoles", previousRuntimeModelRoles);
		}
		if (overridesChanged) {
			prepared.settings.override("task.agentModelOverrides", previousRuntimeAgentModelOverrides);
		}
		prepared.session.setActiveModelProfile?.(previousActiveModelProfile);
		if (modelChanged) {
			// Runtime rolls back to the pre-activation live model. That model may
			// itself be a transient retry/fallback/context-promotion/plan switch,
			// so it is recorded as role:"temporary" (NOT the resume default) to
			// preserve the issue #849 protection.
			if (previousModel) {
				await prepared.session.setModelTemporary(previousModel, previousThinkingLevel);
			}
			// The happy path already appended the profile main model as the resume
			// default (role:"default"). Re-assert the pre-activation resume default
			// so a failed activation does not poison future resume. Fall back to the
			// live model only when there was no explicit pre-activation default
			// (nothing to protect). Append-only — never touches the runtime model.
			const restoreDefaultSelector =
				previousSessionDefaultModel ??
				(previousModel ? `${previousModel.provider}/${previousModel.id}` : undefined);
			if (restoreDefaultSelector) {
				prepared.session.recordResumeDefaultModel?.(restoreDefaultSelector);
			}
		}
		throw error;
	}
}

export interface MaterializeModelProfileForDeletionResult {
	modelRoles: Record<string, string>;
	agentModelOverrides: Record<string, string>;
	previousModelRoles: Record<string, string>;
	previousAgentModelOverrides: Record<string, string>;
	previousPersistedModelRoles: Record<string, string> | undefined;
	previousPersistedAgentModelOverrides: Record<string, string> | undefined;
	previousRuntimeModelRoles: Record<string, string>;
	previousRuntimeAgentModelOverrides: Record<string, string>;
	previousDefaultProfile: string | undefined;
	previousPersistedDefaultProfile: string | undefined;
	previousRuntimeModelProfileDefault: RuntimeModelProfileDefaultState;
	previousPersistedModelProfileDefault: RuntimeModelProfileDefaultState;
	previousActiveModelProfile: string | undefined;
}

export async function materializeModelProfileForDeletion(
	options: PrepareModelProfileActivationOptions & {
		settings: Pick<
			Settings,
			| "clearOverride"
			| "flushOrThrow"
			| "get"
			| "getGlobal"
			| "getRuntimeAgentModelOverrides"
			| "getRuntimeModelRoles"
			| "override"
			| "set"
			| "persistAgentModelOverride"
			| "persistModelRole"
			| "replacePersistedAgentModelOverrides"
			| "replacePersistedModelRoles"
			| "getRuntimeModelProfileDefaultState"
			| "restoreRuntimeModelProfileDefault"
			| "suppressModelProfileDefault"
			| "getPersistedModelProfileDefaultState"
			| "persistModelProfileDefaultSuppression"
			| "restorePersistedModelProfileDefault"
		>;
	},
): Promise<MaterializeModelProfileForDeletionResult> {
	const prepared = await prepareModelProfileActivation(options);
	const previousDefaultProfile = prepared.settings.get("modelProfile.default");
	const previousPersistedDefaultProfile = prepared.settings.getGlobal("modelProfile.default");
	const previousRuntimeModelProfileDefault = prepared.settings.getRuntimeModelProfileDefaultState();
	const previousPersistedModelProfileDefault = prepared.settings.getPersistedModelProfileDefaultState();
	const nextRuntimeModelRoles = {
		...prepared.previousRuntimeModelRoles,
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
	const nextRuntimeAgentModelOverrides = {
		...prepared.previousRuntimeAgentModelOverrides,
		...prepared.agentModelOverrides,
	};
	const durableProfileModelRoles = {
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
	const durableProfileAgentModelOverrides = { ...prepared.agentModelOverrides };
	const nextModelRoles = {
		...(prepared.previousPersistedModelRoles ?? {}),
		...durableProfileModelRoles,
	};
	const nextAgentModelOverrides = {
		...(prepared.previousPersistedAgentModelOverrides ?? {}),
		...durableProfileAgentModelOverrides,
	};

	try {
		for (const [role, selector] of Object.entries(durableProfileModelRoles)) {
			prepared.settings.persistModelRole(role, selector);
		}
		for (const [agentName, selector] of Object.entries(durableProfileAgentModelOverrides)) {
			prepared.settings.persistAgentModelOverride(agentName, selector);
		}
		prepared.settings.persistModelProfileDefaultSuppression();
		prepared.settings.suppressModelProfileDefault();
		prepared.settings.override("modelRoles", nextRuntimeModelRoles);
		prepared.settings.override("task.agentModelOverrides", nextRuntimeAgentModelOverrides);
		prepared.session.setActiveModelProfile?.(undefined);
		await prepared.settings.flushOrThrow();
	} catch (error) {
		prepared.settings.replacePersistedModelRoles(prepared.previousPersistedModelRoles);
		prepared.settings.replacePersistedAgentModelOverrides(prepared.previousPersistedAgentModelOverrides);
		prepared.settings.restorePersistedModelProfileDefault(previousPersistedModelProfileDefault);
		prepared.settings.override("modelRoles", prepared.previousRuntimeModelRoles);
		prepared.settings.override("task.agentModelOverrides", prepared.previousRuntimeAgentModelOverrides);
		prepared.settings.restoreRuntimeModelProfileDefault(previousRuntimeModelProfileDefault);
		prepared.session.setActiveModelProfile?.(prepared.previousActiveModelProfile);
		throw error;
	}

	return {
		modelRoles: nextModelRoles,
		agentModelOverrides: nextAgentModelOverrides,
		previousModelRoles: prepared.previousModelRoles,
		previousAgentModelOverrides: prepared.previousAgentModelOverrides,
		previousPersistedModelRoles: prepared.previousPersistedModelRoles,
		previousPersistedAgentModelOverrides: prepared.previousPersistedAgentModelOverrides,
		previousRuntimeModelRoles: prepared.previousRuntimeModelRoles,
		previousRuntimeAgentModelOverrides: prepared.previousRuntimeAgentModelOverrides,
		previousDefaultProfile,
		previousPersistedDefaultProfile,
		previousRuntimeModelProfileDefault,
		previousPersistedModelProfileDefault,
		previousActiveModelProfile: prepared.previousActiveModelProfile,
	};
}

export async function restoreMaterializedModelProfileForDeletion(options: {
	settings: Pick<
		Settings,
		| "flushOrThrow"
		| "getGlobal"
		| "getRuntimeAgentModelOverrides"
		| "getRuntimeModelProfileDefaultState"
		| "getRuntimeModelRoles"
		| "override"
		| "replacePersistedAgentModelOverrides"
		| "replacePersistedModelRoles"
		| "restoreRuntimeModelProfileDefault"
		| "set"
		| "getPersistedModelProfileDefaultState"
		| "restorePersistedModelProfileDefault"
	>;
	session: Pick<ModelProfileActivationSession, "getActiveModelProfile" | "setActiveModelProfile">;
	snapshot: MaterializeModelProfileForDeletionResult;
}): Promise<void> {
	const currentPersistedModelRoles = options.settings.getGlobal("modelRoles");
	const currentPersistedAgentModelOverrides = options.settings.getGlobal("task.agentModelOverrides");
	const currentPersistedModelProfileDefault = options.settings.getPersistedModelProfileDefaultState();
	const currentRuntimeModelRoles = options.settings.getRuntimeModelRoles();
	const currentRuntimeAgentModelOverrides = options.settings.getRuntimeAgentModelOverrides();
	const currentRuntimeModelProfileDefault = options.settings.getRuntimeModelProfileDefaultState();
	const currentActiveModelProfile = options.session.getActiveModelProfile?.();

	try {
		options.settings.replacePersistedModelRoles(options.snapshot.previousPersistedModelRoles);
		options.settings.replacePersistedAgentModelOverrides(options.snapshot.previousPersistedAgentModelOverrides);
		options.settings.restorePersistedModelProfileDefault(options.snapshot.previousPersistedModelProfileDefault);
		options.settings.override("modelRoles", options.snapshot.previousRuntimeModelRoles);
		options.settings.override("task.agentModelOverrides", options.snapshot.previousRuntimeAgentModelOverrides);
		options.settings.restoreRuntimeModelProfileDefault(options.snapshot.previousRuntimeModelProfileDefault);
		await options.settings.flushOrThrow();
		options.session.setActiveModelProfile?.(options.snapshot.previousActiveModelProfile);
	} catch (error) {
		options.settings.replacePersistedModelRoles(currentPersistedModelRoles);
		options.settings.replacePersistedAgentModelOverrides(currentPersistedAgentModelOverrides);
		options.settings.restorePersistedModelProfileDefault(currentPersistedModelProfileDefault);
		options.settings.override("modelRoles", currentRuntimeModelRoles);
		options.settings.override("task.agentModelOverrides", currentRuntimeAgentModelOverrides);
		options.settings.restoreRuntimeModelProfileDefault(currentRuntimeModelProfileDefault);
		options.session.setActiveModelProfile?.(currentActiveModelProfile);
		throw error;
	}
}

export async function activateModelProfile(
	options: PrepareModelProfileActivationOptions,
	applyOptions: ApplyModelProfileActivationOptions = {},
): Promise<void> {
	const prepared = await prepareModelProfileActivation(options);
	await applyPreparedModelProfileActivation(prepared, applyOptions);
}
