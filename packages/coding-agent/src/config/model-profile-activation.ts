import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import type { AgentSession } from "../session/agent-session";
import { formatClampedModelSelector } from "../thinking";
import {
	aggregateModelProfileRequiredProviders,
	formatAvailableProfileNames,
	resolveProfileBindings,
} from "./model-profiles";
import { type GjcModelAssignmentTargetId, isAuthenticated, type ModelRegistry } from "./model-registry";
import { resolveModelRoleValue } from "./model-resolver";
import type { Settings } from "./settings";

const LEGACY_MODEL_PROFILE_ALIASES: ReadonlyMap<string, string> = new Map([["codex-standard", "codex-medium"]]);

type ModelProfileActivationSession = Pick<AgentSession, "model" | "thinkingLevel" | "sessionId"> & {
	setModelTemporary?: AgentSession["setModelTemporary"];
	setActiveModelProfile?: (name: string | undefined) => void;
	getActiveModelProfile?: () => string | undefined;
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
	defaultModel: Model<Api> | undefined;
	defaultThinkingLevel: ThinkingLevel | undefined;
	agentModelOverrides: Record<string, string>;
	previousActiveModelProfile: string | undefined;
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
	bindings: { defaultSelector?: string; agentModelOverrides: Record<string, string> },
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
): { defaultSelector?: string; agentModelOverrides: Record<string, string> } {
	return {
		defaultSelector: bindings.defaultSelector
			? rewriteSelectorProvider(bindings.defaultSelector, authenticatedProviders, alternativeGroups)
			: undefined,
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
		defaultModel: resolvedDefault?.model,
		defaultThinkingLevel: resolvedDefault?.thinkingLevel,
		agentModelOverrides,
		previousActiveModelProfile: options.session.getActiveModelProfile?.(),
	};
}

export async function applyPreparedModelProfileActivation(
	prepared: PreparedModelProfileActivation,
	options: { persistDefault?: boolean } = {},
): Promise<void> {
	const previousModel = prepared.previousModel;
	const previousThinkingLevel = prepared.previousThinkingLevel;
	const previousAgentModelOverrides = prepared.previousAgentModelOverrides;
	const previousPersistedDefault = prepared.settings.get("modelProfile.default");
	const previousActiveModelProfile = prepared.previousActiveModelProfile;
	let modelChanged = false;
	let overridesChanged = false;
	let defaultChanged = false;

	try {
		if (prepared.defaultModel) {
			await prepared.session.setModelTemporary(prepared.defaultModel, prepared.defaultThinkingLevel);
			modelChanged = true;
		}
		if (Object.keys(prepared.agentModelOverrides).length > 0) {
			prepared.settings.override("task.agentModelOverrides", {
				...prepared.settings.get("task.agentModelOverrides"),
				...prepared.agentModelOverrides,
			});
			overridesChanged = true;
		}
		if (options.persistDefault) {
			prepared.settings.set("modelProfile.default", prepared.profileName);
			defaultChanged = true;
			await prepared.settings.flush();
		}
		prepared.session.setActiveModelProfile?.(prepared.profileName);
	} catch (error) {
		if (defaultChanged) {
			prepared.settings.set("modelProfile.default", previousPersistedDefault);
		}
		if (overridesChanged) {
			prepared.settings.override("task.agentModelOverrides", previousAgentModelOverrides);
		}
		prepared.session.setActiveModelProfile?.(previousActiveModelProfile);
		if (modelChanged && previousModel) {
			await prepared.session.setModelTemporary(previousModel, previousThinkingLevel);
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
