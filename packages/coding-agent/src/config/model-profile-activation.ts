import type { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import type { AgentSession } from "../session/agent-session";
import {
	aggregateModelProfileRequiredProviders,
	formatAvailableProfileNames,
	resolveProfileBindings,
} from "./model-profiles";
import { type GjcModelAssignmentTargetId, isAuthenticated, type ModelRegistry } from "./model-registry";
import { resolveModelRoleValue } from "./model-resolver";
import type { Settings } from "./settings";

export interface PrepareModelProfileActivationOptions {
	session: Pick<AgentSession, "model" | "thinkingLevel" | "sessionId">;
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
	session: Pick<AgentSession, "model" | "thinkingLevel" | "sessionId" | "setModelTemporary">;
	settings: Pick<Settings, "get" | "override" | "set" | "flush">;
	previousModel: Model<Api> | undefined;
	previousThinkingLevel: ThinkingLevel | undefined;
	previousAgentModelOverrides: Record<string, string>;
	defaultModel: Model<Api> | undefined;
	defaultThinkingLevel: ThinkingLevel | undefined;
	agentModelOverrides: Record<string, string>;
}

export function formatModelProfileCredentialError(profileName: string, providers: readonly string[]): string {
	return `Model profile "${profileName}" requires credentials for: ${providers.join(", ")}. Run /login and configure the missing provider(s), then retry.`;
}

export async function prepareModelProfileActivation(
	options: PrepareModelProfileActivationOptions,
): Promise<PreparedModelProfileActivation> {
	const profile = options.modelRegistry.getModelProfile(options.profileName);
	if (!profile) {
		const available = formatAvailableProfileNames(options.modelRegistry.getModelProfiles());
		throw new Error(`Unknown model profile "${options.profileName}". Available profiles: ${available}`);
	}

	const missingProviders: string[] = [];
	for (const provider of aggregateModelProfileRequiredProviders(profile.requiredProviders, profile)) {
		const apiKey = await options.modelRegistry.getApiKeyForProvider(provider, options.session.sessionId);
		if (!isAuthenticated(apiKey)) {
			missingProviders.push(provider);
		}
	}
	if (missingProviders.length > 0) {
		throw new Error(formatModelProfileCredentialError(options.profileName, missingProviders));
	}

	const availableModels = options.modelRegistry.getAll();
	const bindings = resolveProfileBindings(profile);
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
		agentModelOverrides[role] = selector;
	}

	return {
		profileName: options.profileName,
		session: options.session as PreparedModelProfileActivation["session"],
		settings: options.settings as PreparedModelProfileActivation["settings"],
		previousModel: options.session.model,
		previousThinkingLevel: options.session.thinkingLevel,
		previousAgentModelOverrides: { ...options.settings.get("task.agentModelOverrides") },
		defaultModel: resolvedDefault?.model,
		defaultThinkingLevel: resolvedDefault?.thinkingLevel,
		agentModelOverrides,
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
	} catch (error) {
		if (defaultChanged) {
			prepared.settings.set("modelProfile.default", previousPersistedDefault);
		}
		if (overridesChanged) {
			prepared.settings.override("task.agentModelOverrides", previousAgentModelOverrides);
		}
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
