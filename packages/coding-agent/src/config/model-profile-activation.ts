import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import type { AgentSession } from "../session/agent-session";
import { formatClampedModelSelector } from "../thinking";
import {
	aggregateModelProfileRequiredProviders,
	formatAvailableProfileNames,
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
	settings: Pick<Settings, "get">;
	profileName: string;
}

export interface PreparedModelProfileActivation {
	profileName: string;
	session: ModelProfileActivationSession & { setModelTemporary: AgentSession["setModelTemporary"] };
	settings: Pick<Settings, "get" | "override" | "set" | "flush">;
	previousModel: Model<Api> | undefined;
	previousThinkingLevel: ThinkingLevel | undefined;
	previousAgentModelOverrides: Record<string, string>;
	previousModelRoles: Record<string, string>;
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
	settings: Pick<Settings, "clearOverride" | "get" | "override" | "set">;
	role: GjcModelAssignmentTargetId;
	selector: string;
}

export function materializeActiveModelProfileAssignment(options: MaterializeModelProfileAssignmentOptions): boolean {
	const activeProfile = options.session.getActiveModelProfile?.() ?? options.settings.get("modelProfile.default");
	if (!activeProfile) return false;

	const nextModelRoles = { ...options.settings.get("modelRoles") };
	const nextAgentModelOverrides = { ...options.settings.get("task.agentModelOverrides") };
	const target = GJC_MODEL_ASSIGNMENT_TARGETS[options.role];

	if (options.role === "default") {
		nextModelRoles.default = options.selector;
	} else if (!nextModelRoles.default && options.session.model) {
		nextModelRoles.default = formatModelSelectorValue(
			`${options.session.model.provider}/${options.session.model.id}`,
			options.session.thinkingLevel,
		);
	}

	if (target.settingsPath === "modelRoles") {
		nextModelRoles[options.role] = options.selector;
	} else {
		nextAgentModelOverrides[options.role] = options.selector;
	}

	options.settings.set("modelRoles", nextModelRoles);
	options.settings.set("task.agentModelOverrides", nextAgentModelOverrides);
	options.settings.set("modelProfile.default", undefined);
	options.settings.clearOverride("modelProfile.default");
	options.settings.override("modelRoles", nextModelRoles);
	options.settings.override("task.agentModelOverrides", nextAgentModelOverrides);
	options.session.setActiveModelProfile?.(undefined);
	return true;
}

export function formatModelProfileCredentialError(profileName: string, providers: readonly string[]): string {
	return `Model profile "${profileName}" requires credentials for: ${providers.join(", ")}. Run /login and configure the missing provider(s), then retry.`;
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
		throw new Error(formatModelProfileCredentialError(options.profileName, strictMissing));
	}

	// Check alternative groups — at least one provider per group must be authenticated.
	for (const group of alternativeGroups) {
		const groupAuthenticated = group.some(p => authenticatedProviders.includes(p));
		if (!groupAuthenticated) {
			throw new Error(formatModelProfileCredentialError(options.profileName, [...group]));
		}
	}

	if (authenticatedProviders.length === 0) {
		throw new Error(formatModelProfileCredentialError(options.profileName, missingProviders));
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
		throw new Error(
			`Model profile "${options.profileName}" default selector did not resolve: ${bindings.defaultSelector}`,
		);
	}

	const modelRoles: Record<string, string> = {};
	for (const [role, selector] of Object.entries(bindings.modelRoles) as [GjcModelAssignmentTargetId, string][]) {
		const resolved = resolveModelRoleValue(selector, availableModels, {
			settings: options.settings as Settings,
			modelRegistry: options.modelRegistry,
		});
		if (!resolved.model) {
			throw new Error(`Model profile "${options.profileName}" ${role} selector did not resolve: ${selector}`);
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
			throw new Error(`Model profile "${options.profileName}" ${role} selector did not resolve: ${selector}`);
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
	options: { persistDefault?: boolean } = {},
): Promise<void> {
	const previousModel = prepared.previousModel;
	const previousThinkingLevel = prepared.previousThinkingLevel;
	const previousAgentModelOverrides = prepared.previousAgentModelOverrides;
	const previousModelRoles = prepared.previousModelRoles;
	const previousPersistedDefault = prepared.settings.get("modelProfile.default");
	const previousActiveModelProfile = prepared.previousActiveModelProfile;
	const previousSessionDefaultModel = prepared.previousSessionDefaultModel;
	let modelChanged = false;
	let overridesChanged = false;
	let defaultChanged = false;
	let modelRolesChanged = false;

	try {
		if (prepared.defaultModel) {
			await prepared.session.setModelTemporary(prepared.defaultModel, prepared.defaultThinkingLevel, {
				persistAsSessionDefault: true,
			});
			modelChanged = true;
		}
		if (Object.keys(prepared.modelRoles).length > 0) {
			prepared.settings.override("modelRoles", { ...previousModelRoles, ...prepared.modelRoles });
			modelRolesChanged = true;
		}
		if (Object.keys(prepared.agentModelOverrides).length > 0) {
			prepared.settings.override("task.agentModelOverrides", {
				...previousAgentModelOverrides,
				...prepared.agentModelOverrides,
			});
			overridesChanged = true;
		}
		if (options.persistDefault) {
			prepared.settings.set("modelRoles", {});
			prepared.settings.set("task.agentModelOverrides", {});
			prepared.settings.set("modelProfile.default", prepared.profileName);
			defaultChanged = true;
			await prepared.settings.flush();
		}
		prepared.session.setActiveModelProfile?.(prepared.profileName);
	} catch (error) {
		if (defaultChanged) {
			prepared.settings.set("modelProfile.default", previousPersistedDefault);
			prepared.settings.set("modelRoles", previousModelRoles);
			prepared.settings.set("task.agentModelOverrides", previousAgentModelOverrides);
		}
		if (modelRolesChanged) {
			prepared.settings.override("modelRoles", previousModelRoles);
		}
		if (overridesChanged) {
			prepared.settings.override("task.agentModelOverrides", previousAgentModelOverrides);
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

export async function activateModelProfile(
	options: PrepareModelProfileActivationOptions,
	applyOptions: { persistDefault?: boolean } = {},
): Promise<void> {
	const prepared = await prepareModelProfileActivation(options);
	await applyPreparedModelProfileActivation(prepared, applyOptions);
}
