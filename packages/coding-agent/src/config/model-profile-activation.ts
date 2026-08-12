import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import type { AgentSession } from "../session/agent-session";
import { formatClampedModelSelector } from "../thinking";
import { validateModelProfileName } from "./model-profile-contract";
import {
	formatModelProfileDisplayLabel,
	type ModelProfileProviderReadiness,
	resolveModelProfileProviderReadiness,
	resolveProfileBindings,
} from "./model-profiles";

export { resolveModelProfileName } from "./model-profile-contract";

import {
	GJC_MODEL_ASSIGNMENT_TARGETS,
	type GjcModelAssignmentTargetId,
	isAuthenticated,
	kNoAuth,
	type ModelRegistry,
} from "./model-registry";
import {
	formatModelSelectorValue,
	type ModelLookupRegistry,
	type ModelResolutionSettings,
	parseModelString,
	resolveModelChainWithAuth,
	resolveModelRoleValue,
} from "./model-resolver";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "./model-selector-value";
import type { Settings } from "./settings";

type ModelProfileActivationSession = Pick<
	AgentSession,
	"model" | "thinkingLevel" | "sessionId" | "getConfiguredModelChain" | "setConfiguredModelChain"
> & {
	setModelTemporary?: AgentSession["setModelTemporary"];
	setActiveModelProfile?: (name: string | undefined) => void;
	getActiveModelProfile?: () => string | undefined;
	getSessionDefaultModelSelector?: () => string | undefined;
	recordResumeDefaultModel?: (selector: string) => void;
	seedDefaultFallbackResolution?: (activeIndex: number, skips: Array<{ selector: string; reason: string }>) => void;
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
	> & { getError?: ModelRegistry["getError"] };
	settings: Pick<Settings, "get" | "getModelRole" | "getStorage">;
	profileName: string;
}
export interface ApplyModelProfileActivationOptions {
	persistDefault?: boolean;
	thinkingLevelOverride?: ThinkingLevel;
}
export interface PreparedAlternativeProviderSelection {
	readonly providerIds: readonly string[];
	readonly selectedProviderId: string | null;
}

export interface PreparedModelProfileActivation {
	profileName: string;
	/** Provider credentials observed during this preparation, in lookup order. */
	readonly authenticatedProviderIds: readonly string[];
	/** Exact alternative-group order and first authenticated candidate used for rewrites. */
	readonly alternativeProviderSelections: readonly PreparedAlternativeProviderSelection[];
	session: ModelProfileActivationSession & { setModelTemporary: AgentSession["setModelTemporary"] };
	settings: Pick<Settings, "clearOverride" | "get" | "getGlobal" | "override" | "set" | "unset" | "flushOrThrow">;
	previousModel: Model<Api> | undefined;
	previousThinkingLevel: ThinkingLevel | undefined;
	previousAgentModelOverrides: Record<string, ModelSelectorValue>;
	previousModelRoles: Record<string, ModelSelectorValue>;
	previousDefaultChain: readonly string[] | undefined;
	defaultModel: Model<Api> | undefined;
	defaultThinkingLevel: ThinkingLevel | undefined;
	/** Full configured default fallback chain with resolvable entries clamped. */
	defaultChain: readonly string[];
	/** Index of the authenticated default-chain entry selected for activation. */
	defaultActiveIndex: number | undefined;
	/** Resolution-time skips that occurred before selecting the default entry. */
	defaultResolutionSkips: Array<{ selector: string; reason: string }>;
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
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
		| "model"
		| "thinkingLevel"
		| "getConfiguredModelChain"
		| "setConfiguredModelChain"
		| "setActiveModelProfile"
		| "getActiveModelProfile"
	>;
	settings: Pick<Settings, "clearOverride" | "get" | "override" | "set" | "unset">;
	role: GjcModelAssignmentTargetId;
	selector: string;
}

export interface MaterializeModelProfileAssignmentsOptions {
	session: Pick<
		ModelProfileActivationSession,
		| "model"
		| "thinkingLevel"
		| "getConfiguredModelChain"
		| "setConfiguredModelChain"
		| "setActiveModelProfile"
		| "getActiveModelProfile"
	>;
	settings: Pick<Settings, "clearOverride" | "get" | "override" | "set" | "unset">;
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

function materializeConfiguredDefaultChain(
	session: Pick<ModelProfileActivationSession, "model" | "thinkingLevel" | "getConfiguredModelChain">,
): ModelSelectorValue | undefined {
	const configuredChain = session.getConfiguredModelChain("default") ?? [];
	if (!session.model) {
		return configuredChain.length === 0
			? undefined
			: configuredChain.length === 1
				? configuredChain[0]
				: [...configuredChain];
	}

	const activeSelector = formatModelSelectorValue(
		`${session.model.provider}/${session.model.id}`,
		session.thinkingLevel,
	);
	const exactIndex = configuredChain.indexOf(activeSelector);
	const activeIndex =
		exactIndex !== -1
			? exactIndex
			: configuredChain.findIndex(entry => {
					const parsed = parseModelString(entry);
					return parsed?.provider === session.model?.provider && parsed?.id === session.model?.id;
				});
	const effectiveChain =
		activeIndex === -1 ? [activeSelector] : [activeSelector, ...configuredChain.slice(activeIndex + 1)];
	return effectiveChain.length === 1 ? effectiveChain[0] : effectiveChain;
}

export function materializeActiveModelProfileAssignment(options: MaterializeModelProfileAssignmentOptions): boolean {
	return materializeActiveModelProfileAssignments({
		...options,
		assignments: new Map<GjcModelAssignmentTargetId, string>([[options.role, options.selector]]),
	});
}

export function materializeActiveModelProfileAssignments(options: MaterializeModelProfileAssignmentsOptions): boolean {
	const activeProfile = options.session.getActiveModelProfile?.() ?? options.settings.get("modelProfile.default");
	if (!activeProfile) return false;

	const materializedAssignments = getMaterializedAssignments(options.assignments);
	if (materializedAssignments.length === 0) return true;

	const nextModelRoles = { ...options.settings.get("modelRoles") };
	const nextAgentModelOverrides = { ...options.settings.get("task.agentModelOverrides") };
	const includesDefault = materializedAssignments.some(([role]) => role === "default");
	let materializedDefaultChain: ModelSelectorValue | undefined;
	let defaultChainChanged = false;
	const previousDefaultChain = options.session.getConfiguredModelChain("default");

	if (!includesDefault && !nextModelRoles.default) {
		materializedDefaultChain = materializeConfiguredDefaultChain(options.session);
		if (materializedDefaultChain) nextModelRoles.default = materializedDefaultChain;
	}

	for (const [role, selector] of materializedAssignments) {
		const target = GJC_MODEL_ASSIGNMENT_TARGETS[role];
		if (target.settingsPath === "modelRoles") {
			nextModelRoles[role] = selector;
		} else {
			nextAgentModelOverrides[role] = selector;
		}
	}

	try {
		options.settings.set("modelRoles", nextModelRoles);
		options.settings.set("task.agentModelOverrides", nextAgentModelOverrides);
		options.settings.unset("modelProfile.default");
		options.settings.clearOverride("modelProfile.default");
		options.settings.override("modelRoles", nextModelRoles);
		options.settings.override("task.agentModelOverrides", nextAgentModelOverrides);
		if (materializedDefaultChain) {
			defaultChainChanged = true;
			options.session.setConfiguredModelChain(
				"default",
				normalizeModelSelectorValue(materializedDefaultChain),
				"profile-materialization",
				activeProfile,
				true,
			);
		}
		options.session.setActiveModelProfile?.(undefined);
		return true;
	} catch (error) {
		if (defaultChainChanged) {
			try {
				options.session.setConfiguredModelChain(
					"default",
					previousDefaultChain ?? [],
					"rollback",
					activeProfile,
					true,
				);
			} catch (restoreError) {
				throw new Error(
					`Model profile materialization failed: ${error instanceof Error ? error.message : String(error)}; rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
				);
			}
		}
		throw error;
	}
}

export class ModelProfileCredentialError extends Error {
	readonly code = "authentication_failed";
	readonly profileLabel: string;
	readonly providers: readonly string[];
	readonly missingStrictProviders: readonly string[];
	readonly unsatisfiedAlternativeGroups: readonly (readonly string[])[];
	readonly presentation: ModelProfileProviderReadiness["presentation"];

	constructor(profileLabel: string, readiness: ModelProfileProviderReadiness) {
		const providers = [...readiness.missingStrictProviders, ...readiness.unsatisfiedAlternativeGroups.flat()];
		const presentationProviders = [
			...readiness.presentation.strictMissingProviders,
			...readiness.presentation.unsatisfiedAlternativeGroups.flat(),
		];
		super(
			formatModelProfileCredentialError(
				profileLabel,
				presentationProviders,
				readiness.presentation.unsatisfiedAlternativeGroups,
			),
		);
		this.name = "ModelProfileCredentialError";
		this.profileLabel = profileLabel;
		this.providers = [...providers];
		this.missingStrictProviders = [...readiness.missingStrictProviders];
		this.unsatisfiedAlternativeGroups = readiness.unsatisfiedAlternativeGroups.map(group => [...group]);
		this.presentation = {
			strictMissingProviders: [...readiness.presentation.strictMissingProviders],
			unsatisfiedAlternativeGroups: readiness.presentation.unsatisfiedAlternativeGroups.map(group => [...group]),
		};
	}
}

export function formatModelProfileCredentialError(
	profileLabel: string,
	providers: readonly string[],
	alternativeGroups: readonly (readonly string[])[] = [],
): string {
	if (alternativeGroups.length === 0) {
		return `Model profile "${profileLabel}" requires credentials for: ${providers.join(", ")}. Run /login and configure the missing provider(s), then retry.`;
	}
	const alternativeProviders = new Set(alternativeGroups.flat());
	const strictProviders = providers.filter(provider => !alternativeProviders.has(provider));
	const parts: string[] = [];
	if (strictProviders.length > 0) parts.push(`credentials for: ${strictProviders.join(", ")}`);
	for (const group of alternativeGroups) {
		parts.push(`one of: ${group.join(", ")}`);
	}
	return `Model profile "${profileLabel}" requires ${parts.join("; ")}. Run /login and configure the missing provider(s), then retry.`;
}

function normalizeAlternativeProviderGroups(groups: readonly (readonly string[])[]): readonly (readonly string[])[] {
	const normalizedGroups: string[][] = [];
	const seenGroups = new Set<string>();
	for (const group of groups) {
		const normalizedGroup = [...new Set(group)];
		const groupKey = normalizedGroup.join("\u0000");
		if (seenGroups.has(groupKey)) continue;
		seenGroups.add(groupKey);
		normalizedGroups.push(normalizedGroup);
	}
	return normalizedGroups;
}

function selectAlternativeProviders(
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
): readonly PreparedAlternativeProviderSelection[] {
	return alternativeGroups.map(group =>
		Object.freeze({
			providerIds: Object.freeze([...group]),
			selectedProviderId: group.find(candidate => authenticatedProviders.has(candidate)) ?? null,
		}),
	);
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
	alternativeSelections: readonly PreparedAlternativeProviderSelection[],
): string {
	const slash = selector.indexOf("/");
	if (slash < 0) return selector;

	const provider = selector.substring(0, slash);
	if (authenticatedProviders.has(provider)) return selector;

	const groupIndex = alternativeGroups.findIndex(candidates => candidates.includes(provider));
	if (groupIndex < 0) return selector;

	const replacement = alternativeSelections[groupIndex]?.selectedProviderId;
	if (!replacement) return selector;

	return replacement + selector.substring(slash);
}

function rewriteSelectorValueProvider(
	selectorValue: ModelSelectorValue,
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
	alternativeSelections: readonly PreparedAlternativeProviderSelection[],
): ModelSelectorValue {
	const selectors = normalizeModelSelectorValue(selectorValue).map(selector =>
		rewriteSelectorProvider(selector, authenticatedProviders, alternativeGroups, alternativeSelections),
	);
	return selectors.length === 1 && typeof selectorValue === "string" ? selectors[0] : selectors;
}

function rewriteBindingsProviders(
	bindings: {
		defaultSelector?: ModelSelectorValue;
		modelRoles: Record<string, ModelSelectorValue>;
		agentModelOverrides: Record<string, ModelSelectorValue>;
	},
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
	alternativeSelections: readonly PreparedAlternativeProviderSelection[],
): {
	defaultSelector?: ModelSelectorValue;
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
} {
	return {
		defaultSelector: bindings.defaultSelector
			? rewriteSelectorValueProvider(
					bindings.defaultSelector,
					authenticatedProviders,
					alternativeGroups,
					alternativeSelections,
				)
			: undefined,
		modelRoles: Object.fromEntries(
			Object.entries(bindings.modelRoles).map(([role, selector]) => [
				role,
				rewriteSelectorValueProvider(selector, authenticatedProviders, alternativeGroups, alternativeSelections),
			]),
		),
		agentModelOverrides: Object.fromEntries(
			Object.entries(bindings.agentModelOverrides).map(([role, selector]) => [
				role,
				rewriteSelectorValueProvider(selector, authenticatedProviders, alternativeGroups, alternativeSelections),
			]),
		),
	};
}

function formatMaterializedSelector(selector: string, model: Model<Api>): string {
	const clampedSelector = formatClampedModelSelector(selector, model);
	const explicitThinkingLevel = parseModelString(selector)?.thinkingLevel;
	if (!explicitThinkingLevel || parseModelString(clampedSelector)?.thinkingLevel) return clampedSelector;
	return formatModelSelectorValue(clampedSelector, explicitThinkingLevel);
}

function resolveAndClampSelectorValue(
	selectorValue: ModelSelectorValue,
	availableModels: Model<Api>[],
	options: { settings: ModelResolutionSettings; modelRegistry: ModelLookupRegistry },
	profileLabel: string,
	role: string,
): ModelSelectorValue {
	const selectors = normalizeModelSelectorValue(selectorValue);
	const clamped: string[] = [];
	let resolvedAny = false;
	for (const selector of selectors) {
		const resolved = resolveModelRoleValue(selector, availableModels, options);
		if (resolved.model) {
			clamped.push(formatMaterializedSelector(selector, resolved.model));
			resolvedAny = true;
		} else {
			clamped.push(selector);
		}
	}
	if (!resolvedAny && role === "default") {
		throw new Error(`Model profile "${profileLabel}" ${role} selector did not resolve: ${selectors[0]}`);
	}
	return clamped.length === 1 && typeof selectorValue === "string" ? clamped[0] : clamped;
}

export async function prepareModelProfileActivation(
	options: PrepareModelProfileActivationOptions,
): Promise<PreparedModelProfileActivation> {
	const profiles = options.modelRegistry.getModelProfiles();
	const profileName = validateModelProfileName(options.profileName, profiles, options.modelRegistry.getError?.());
	const profile = profiles.get(profileName) ?? options.modelRegistry.getModelProfile(profileName)!;
	const profileLabel = formatModelProfileDisplayLabel(profile);

	const requiredProviders = [...new Set(profile.requiredProviders)];
	const alternativeGroups = normalizeAlternativeProviderGroups(profile.alternativeProviderGroups ?? []);
	const providersToCheck = [...new Set([...requiredProviders, ...alternativeGroups.flat()])];
	const missingProviders: string[] = [];
	const authenticatedProviders = new Set<string>();
	for (const provider of providersToCheck) {
		const apiKey = await options.modelRegistry.getApiKeyForProvider(provider, options.session.sessionId);
		if (apiKey !== kNoAuth && !isAuthenticated(apiKey)) {
			missingProviders.push(provider);
		} else {
			authenticatedProviders.add(provider);
		}
	}
	const authenticatedProviderIds = Object.freeze([...authenticatedProviders]);
	const alternativeProviderSelections = Object.freeze(
		selectAlternativeProviders(authenticatedProviders, alternativeGroups),
	);

	const readiness = resolveModelProfileProviderReadiness(
		{ requiredProviders, alternativeProviderGroups: alternativeGroups },
		authenticatedProviders,
	);
	if (!readiness.usable) {
		throw new ModelProfileCredentialError(profileLabel, readiness);
	}

	const availableModels = options.modelRegistry.getAll();
	const modelLookupRegistry: ModelLookupRegistry = {
		getAvailable: () => availableModels,
		resolveCanonicalModel: (canonicalId, resolveOptions) =>
			options.modelRegistry.resolveCanonicalModel(canonicalId, resolveOptions),
		getCanonicalVariants: (canonicalId, queryOptions) =>
			options.modelRegistry.getCanonicalVariants(canonicalId, queryOptions),
		getCanonicalId: model => options.modelRegistry.getCanonicalId(model),
	};
	const modelRegistryWithAuth: ModelLookupRegistry & Pick<ModelRegistry, "getApiKey"> = {
		...modelLookupRegistry,
		getApiKey: (model, sessionId) =>
			options.modelRegistry.getApiKeyForProvider(model.provider, sessionId, model.baseUrl),
	};
	let bindings = resolveProfileBindings(profile);
	const alternativeSet = new Set(alternativeGroups.flat());
	if (missingProviders.some(provider => alternativeSet.has(provider))) {
		bindings = rewriteBindingsProviders(
			bindings,
			authenticatedProviders,
			alternativeGroups,
			alternativeProviderSelections,
		);
	}
	const defaultSelectors = bindings.defaultSelector ? normalizeModelSelectorValue(bindings.defaultSelector) : [];
	const defaultChain =
		defaultSelectors.length > 0
			? normalizeModelSelectorValue(
					resolveAndClampSelectorValue(
						bindings.defaultSelector!,
						availableModels,
						{ settings: options.settings, modelRegistry: modelLookupRegistry },
						profileLabel,
						"default",
					),
				)
			: [];
	const defaultResolution = await resolveModelChainWithAuth(
		defaultChain,
		modelRegistryWithAuth,
		options.settings,
		options.session.sessionId,
		{ managedFallback: true },
	);
	const defaultModel = defaultResolution.model;
	const defaultThinkingLevel = defaultResolution.thinkingLevel;
	const defaultActiveIndex = defaultModel ? defaultResolution.activeIndex : undefined;
	const defaultResolutionSkips = defaultResolution.skips;
	if (bindings.defaultSelector && !defaultModel) {
		throw new Error(`Model profile "${profileLabel}" default selectors did not resolve to an authenticated model`);
	}

	const modelRoles: Record<string, ModelSelectorValue> = {};
	for (const [role, selectorValue] of Object.entries(bindings.modelRoles) as [
		GjcModelAssignmentTargetId,
		ModelSelectorValue,
	][]) {
		modelRoles[role] = resolveAndClampSelectorValue(
			selectorValue,
			availableModels,
			{ settings: options.settings, modelRegistry: modelLookupRegistry },
			profileLabel,
			role,
		);
	}

	const agentModelOverrides: Record<string, ModelSelectorValue> = {};
	for (const [role, selectorValue] of Object.entries(bindings.agentModelOverrides) as [
		GjcModelAssignmentTargetId,
		ModelSelectorValue,
	][]) {
		agentModelOverrides[role] = resolveAndClampSelectorValue(
			selectorValue,
			availableModels,
			{ settings: options.settings, modelRegistry: modelLookupRegistry },
			profileLabel,
			role,
		);
	}

	const previousDefaultChain = options.session.getConfiguredModelChain("default");
	return {
		profileName,
		authenticatedProviderIds,
		alternativeProviderSelections,
		session: options.session as PreparedModelProfileActivation["session"],
		settings: options.settings as PreparedModelProfileActivation["settings"],
		previousModel: options.session.model,
		previousThinkingLevel: options.session.thinkingLevel,
		previousAgentModelOverrides: { ...options.settings.get("task.agentModelOverrides") },
		previousModelRoles: { ...options.settings.get("modelRoles") },
		previousDefaultChain: previousDefaultChain ? [...previousDefaultChain] : undefined,

		defaultModel,
		defaultThinkingLevel,
		defaultActiveIndex,
		defaultResolutionSkips,
		defaultChain,
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
	const previousAgentModelOverrides = prepared.previousAgentModelOverrides;
	const previousModelRoles = prepared.previousModelRoles;
	const previousPersistedDefault = prepared.settings.get("modelProfile.default");
	const previousDefaultThinkingLevel = prepared.settings.get("defaultThinkingLevel");
	const previousActiveModelProfile = prepared.previousActiveModelProfile;
	const previousSessionDefaultModel = prepared.previousSessionDefaultModel;
	let modelChanged = false;
	let overridesChanged = false;
	let defaultChanged = false;
	let modelRolesChanged = false;
	let defaultThinkingChanged = false;
	let defaultChainChanged = false;

	try {
		if (prepared.defaultChain.length > 0) {
			prepared.session.setConfiguredModelChain(
				"default",
				prepared.defaultChain,
				"profile-activation",
				prepared.profileName,
				true,
			);
			if (prepared.defaultActiveIndex !== undefined) {
				prepared.session.seedDefaultFallbackResolution?.(
					prepared.defaultActiveIndex,
					prepared.defaultResolutionSkips,
				);
			}

			defaultChainChanged = true;
		}
		if (prepared.defaultModel) {
			await prepared.session.setModelTemporary(
				prepared.defaultModel,
				options.thinkingLevelOverride ?? prepared.defaultThinkingLevel,
				{
					persistAsSessionDefault: true,
					cause: "profile-activation",
				},
			);
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
			if (prepared.defaultThinkingLevel !== undefined && prepared.defaultThinkingLevel !== ThinkingLevel.Inherit) {
				prepared.settings.set("defaultThinkingLevel", prepared.defaultThinkingLevel);
				defaultThinkingChanged = true;
			}
			prepared.settings.set("modelProfile.default", prepared.profileName);
			defaultChanged = true;
			await prepared.settings.flushOrThrow();
		}
		prepared.session.setActiveModelProfile?.(prepared.profileName);
	} catch (error) {
		let rollbackFlushError: unknown;
		if (defaultChanged) {
			prepared.settings.set("modelProfile.default", previousPersistedDefault);
			prepared.settings.set("modelRoles", previousModelRoles);
			prepared.settings.set("task.agentModelOverrides", previousAgentModelOverrides);
			if (defaultThinkingChanged) {
				prepared.settings.set("defaultThinkingLevel", previousDefaultThinkingLevel);
			}
			try {
				await prepared.settings.flushOrThrow();
			} catch (restoreError) {
				rollbackFlushError = restoreError;
			}
		}
		if (modelRolesChanged) {
			prepared.settings.override("modelRoles", previousModelRoles);
		}
		if (overridesChanged) {
			prepared.settings.override("task.agentModelOverrides", previousAgentModelOverrides);
		}
		if (defaultChainChanged) {
			prepared.session.setConfiguredModelChain(
				"default",
				prepared.previousDefaultChain ?? [],
				"rollback",
				prepared.previousActiveModelProfile,
				true,
			);
		}
		prepared.session.setActiveModelProfile?.(previousActiveModelProfile);
		if (modelChanged) {
			// Runtime rolls back to the pre-activation live model. That model may
			// itself be a transient retry/fallback/context-promotion/plan switch,
			// so it is recorded as role:"temporary" (NOT the resume default) to
			// preserve the issue #849 protection.
			if (previousModel) {
				await prepared.session.setModelTemporary(previousModel, previousThinkingLevel, { cause: "rollback" });
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
		if (rollbackFlushError) {
			throw new Error(
				`Model profile activation failed: ${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackFlushError instanceof Error ? rollbackFlushError.message : String(rollbackFlushError)}`,
			);
		}
		throw error;
	}
}

export interface MaterializeModelProfileForDeletionResult {
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
	previousModelRoles: Record<string, ModelSelectorValue>;
	previousAgentModelOverrides: Record<string, ModelSelectorValue>;
	previousDefaultProfile: string | undefined;
	previousPersistedDefaultProfile: string | undefined;
	previousActiveModelProfile: string | undefined;
	previousDefaultChain: readonly string[] | undefined;
}

export async function materializeModelProfileForDeletion(
	options: PrepareModelProfileActivationOptions & {
		settings: Pick<Settings, "clearOverride" | "flushOrThrow" | "get" | "getGlobal" | "override" | "set" | "unset">;
	},
): Promise<MaterializeModelProfileForDeletionResult> {
	const prepared = await prepareModelProfileActivation(options);
	const previousDefaultProfile = prepared.settings.get("modelProfile.default");
	const previousPersistedDefaultProfile = prepared.settings.getGlobal("modelProfile.default");
	const previousDefaultChain = prepared.previousDefaultChain;
	const nextModelRoles = {
		...prepared.previousModelRoles,
		...(prepared.defaultChain.length > 0
			? {
					default: prepared.defaultChain.length === 1 ? prepared.defaultChain[0] : [...prepared.defaultChain],
				}
			: {}),
		...prepared.modelRoles,
	};
	const nextAgentModelOverrides = {
		...prepared.previousAgentModelOverrides,
		...prepared.agentModelOverrides,
	};

	try {
		prepared.settings.set("modelRoles", nextModelRoles);
		prepared.settings.set("task.agentModelOverrides", nextAgentModelOverrides);
		prepared.settings.unset("modelProfile.default");
		prepared.settings.clearOverride("modelProfile.default");
		prepared.settings.override("modelRoles", nextModelRoles);
		prepared.settings.override("task.agentModelOverrides", nextAgentModelOverrides);
		if (prepared.defaultChain.length > 0) {
			prepared.session.setConfiguredModelChain(
				"default",
				prepared.defaultChain,
				"profile-materialization",
				prepared.profileName,
				true,
			);
		}
		prepared.session.setActiveModelProfile?.(undefined);
		await prepared.settings.flushOrThrow();
	} catch (error) {
		let rollbackError: unknown;
		try {
			prepared.settings.set("modelRoles", prepared.previousModelRoles);
			prepared.settings.set("task.agentModelOverrides", prepared.previousAgentModelOverrides);
			prepared.settings.set("modelProfile.default", previousPersistedDefaultProfile);
			prepared.settings.override("modelRoles", prepared.previousModelRoles);
			prepared.settings.override("task.agentModelOverrides", prepared.previousAgentModelOverrides);
			prepared.settings.override("modelProfile.default", previousDefaultProfile);
			prepared.session.setConfiguredModelChain(
				"default",
				previousDefaultChain ?? [],
				"rollback",
				prepared.previousActiveModelProfile,
				true,
			);
			prepared.session.setActiveModelProfile?.(prepared.previousActiveModelProfile);
			await prepared.settings.flushOrThrow();
		} catch (restoreError) {
			rollbackError = restoreError;
		}
		if (rollbackError) {
			throw new Error(
				`Model profile deletion failed: ${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
			);
		}
		throw error;
	}

	return {
		modelRoles: nextModelRoles,
		agentModelOverrides: nextAgentModelOverrides,
		previousModelRoles: prepared.previousModelRoles,
		previousAgentModelOverrides: prepared.previousAgentModelOverrides,
		previousDefaultProfile,
		previousPersistedDefaultProfile,
		previousActiveModelProfile: prepared.previousActiveModelProfile,
		previousDefaultChain,
	};
}

export async function restoreMaterializedModelProfileForDeletion(options: {
	settings: Pick<Settings, "flushOrThrow" | "override" | "set">;
	session: Pick<ModelProfileActivationSession, "setActiveModelProfile" | "setConfiguredModelChain">;
	snapshot: MaterializeModelProfileForDeletionResult;
}): Promise<void> {
	options.settings.set("modelRoles", options.snapshot.previousModelRoles);
	options.settings.set("task.agentModelOverrides", options.snapshot.previousAgentModelOverrides);
	options.settings.set("modelProfile.default", options.snapshot.previousPersistedDefaultProfile);
	options.settings.override("modelRoles", options.snapshot.previousModelRoles);
	options.settings.override("task.agentModelOverrides", options.snapshot.previousAgentModelOverrides);
	options.settings.override("modelProfile.default", options.snapshot.previousDefaultProfile);
	options.session.setConfiguredModelChain(
		"default",
		options.snapshot.previousDefaultChain ?? [],
		"rollback",
		options.snapshot.previousActiveModelProfile,
		true,
	);
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
