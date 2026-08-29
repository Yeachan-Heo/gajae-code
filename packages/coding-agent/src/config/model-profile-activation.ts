import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai/core";
import { logger } from "@gajae-code/utils";
import type { AgentSession, DefaultFallbackRuntimeState } from "../session/agent-session";
import { clampExplicitThinkingLevelForModel, formatClampedModelSelector } from "../thinking";
import { validateModelProfileName } from "./model-profile-contract";
import {
	aggregateModelProfileRequiredProviders,
	deriveModelProfileMappedProviders,
	formatModelProfileDisplayLabel,
	type ModelProfileDefinition,
	PROXY_ROUTABLE_PROVIDER_IDS,
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
	formatModelString,
	parseModelString,
	resolveModelChainWithAuth,
	resolveModelRoleValue,
	splitSelectorThinkingSuffix,
} from "./model-resolver";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "./model-selector-value";
import type { Settings } from "./settings";

type ModelProfileActivationSession = Pick<
	AgentSession,
	"model" | "thinkingLevel" | "sessionId" | "getConfiguredModelChain" | "setConfiguredModelChain"
> & {
	credentialSessionId?: string;
	setModelTemporary?: AgentSession["setModelTemporary"];
	setActiveModelProfile?: (name: string | undefined) => void;
	getActiveModelProfile?: () => string | undefined;
	/** Record which runtime override keys this activation installed (session-scoped). */
	noteProfileInstalledOverrides?: (
		modelRoles: readonly string[],
		agentModelOverrides: readonly string[],
		preProfileModel: Model<Api> | undefined,
	) => void;
	/** Drop the recorded profile-installed override keys (e.g. after materialization). */
	clearProfileInstalledOverrides?: () => void;
	/** Current profile-installed override keys, for deriving the activation base. */
	getProfileInstalledOverrideKeys?: () => { modelRoles: readonly string[]; agentModelOverrides: readonly string[] };
	/** Re-apply vendor-separated delegation (task tool + prompt) after the role layer changed. */
	syncEagerDelegation?: () => Promise<void>;
	getSessionDefaultModelSelector?: () => string | undefined;
	recordResumeDefaultModel?: (selector: string | undefined) => void;
	seedDefaultFallbackResolution?: (activeIndex: number, skips: Array<{ selector: string; reason: string }>) => void;
	getDefaultFallbackRuntimeState?: () => DefaultFallbackRuntimeState;
	restoreDefaultFallbackRuntimeState?: (state: DefaultFallbackRuntimeState) => void;
	restoreModelSelectionForRollback?: AgentSession["restoreModelSelectionForRollback"];
	modelRegistry?: Pick<
		ModelRegistry,
		| "getSessionCanonicalVariant"
		| "restoreSessionCanonicalVariant"
		| "clearCanonicalVariant"
		| "getAvailable"
		| "lookupAliasExists"
		| "resolveModelByLookupAlias"
		| "authStorage"
		| "isCredentiallessProvider"
	>;
	getConfiguredModelChainState?: (role: string) => ConfiguredModelChainState | undefined;
};

type ConfiguredModelChainState = {
	entries: readonly string[];
	origin: string;
	identity?: string;
	explicitHead: boolean;
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
	> &
		Partial<
			Pick<
				ModelRegistry,
				| "getAvailable"
				| "getAvailableForProfileActivation"
				| "resolveModelByLookupAlias"
				| "lookupAliasExists"
				| "clearCanonicalVariant"
				| "seedCanonicalVariant"
				| "getSessionCanonicalVariant"
				| "restoreSessionCanonicalVariant"
				| "getConfiguredProviderIds"
			>
		> & {
			getError?: ModelRegistry["getError"];
		};
	settings: Pick<Settings, "get" | "getGlobal" | "getOverride">;
	profileName: string;
}
export interface ApplyModelProfileActivationOptions {
	persistDefault?: boolean;
	thinkingLevelOverride?: ThinkingLevel;
	/** Reject a stale prepared activation before each host-state mutation. */
	assertCanCommit?: () => void;
}
export interface PreparedModelProfileActivation {
	profileName: string;
	session: ModelProfileActivationSession & { setModelTemporary: AgentSession["setModelTemporary"] };
	settings: Pick<
		Settings,
		"clearOverride" | "get" | "getGlobal" | "getOverride" | "override" | "set" | "unset" | "flush" | "flushOrThrow"
	>;
	previousModel: Model<Api> | undefined;
	previousThinkingLevel: ThinkingLevel | undefined;
	previousAgentModelOverrides: Record<string, ModelSelectorValue>;
	previousModelRoles: Record<string, ModelSelectorValue>;
	previousPersistedModelRoles: Record<string, ModelSelectorValue> | undefined;
	previousPersistedAgentModelOverrides: Record<string, ModelSelectorValue> | undefined;
	previousModelRolesOverride: Record<string, ModelSelectorValue> | undefined;
	previousAgentModelOverridesOverride: Record<string, ModelSelectorValue> | undefined;
	previousDefaultProfileOverride: string | undefined;
	previousPersistedDefaultProfile: string | undefined;
	previousPersistedDefaultThinkingLevel: Exclude<ThinkingLevel, "inherit"> | undefined;
	previousDefaultThinkingLevelOverride: ThinkingLevel | undefined;
	baseAgentModelOverrides: Record<string, ModelSelectorValue>;
	baseModelRoles: Record<string, ModelSelectorValue>;
	previousDefaultChain: readonly string[] | undefined;
	previousDefaultChainState: ConfiguredModelChainState | undefined;
	previousDefaultFallbackRuntimeState: DefaultFallbackRuntimeState | undefined;
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
	/**
	 * Exact concrete sticky selector ("provider/id") snapshotted from the
	 * registry BEFORE the session sticky canonical variant is invalidated during
	 * prepare. Captured verbatim — never re-derived from the live model — so a
	 * transient live-model switch cannot corrupt the restored sticky. Rollback
	 * restores this exact selector when present; otherwise the sticky is cleared
	 * so a stale provider cannot silently resurrect.
	 */
	previousCanonicalVariant: string | undefined;
	/** Registry used to resolve and restore the session sticky canonical variant. */
	modelRegistry: PrepareModelProfileActivationOptions["modelRegistry"];
}
export interface MaterializeModelProfileAssignmentOptions {
	session: Pick<
		ModelProfileActivationSession,
		| "model"
		| "thinkingLevel"
		| "sessionId"
		| "credentialSessionId"
		| "getConfiguredModelChain"
		| "getConfiguredModelChainState"
		| "setConfiguredModelChain"
		| "setActiveModelProfile"
		| "getActiveModelProfile"
		| "getDefaultFallbackRuntimeState"
		| "restoreDefaultFallbackRuntimeState"
		| "modelRegistry"
		| "clearProfileInstalledOverrides"
	>;
	settings: Pick<Settings, "clearOverride" | "get" | "getGlobal" | "getOverride" | "override" | "set" | "unset">;
	role: GjcModelAssignmentTargetId;
	selector: string;
}

export interface MaterializeModelProfileAssignmentsOptions {
	session: Pick<
		ModelProfileActivationSession,
		| "model"
		| "thinkingLevel"
		| "sessionId"
		| "credentialSessionId"
		| "getConfiguredModelChain"
		| "getConfiguredModelChainState"
		| "setConfiguredModelChain"
		| "setActiveModelProfile"
		| "getActiveModelProfile"
		| "getDefaultFallbackRuntimeState"
		| "restoreDefaultFallbackRuntimeState"
		| "modelRegistry"
		| "clearProfileInstalledOverrides"
	>;
	settings: Pick<Settings, "clearOverride" | "get" | "getGlobal" | "getOverride" | "override" | "set" | "unset">;
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
	if (!session.model) return undefined;
	return formatModelSelectorValue(`${session.model.provider}/${session.model.id}`, session.thinkingLevel);
}

function concretizeMaterializedAssignmentValues(
	options: MaterializeModelProfileAssignmentOptions | MaterializeModelProfileAssignmentsOptions,
	assignments: Record<string, ModelSelectorValue>,
): Record<string, ModelSelectorValue> {
	const modelRegistry = options.session.modelRegistry;
	const sessionId = (options.session as { sessionId?: string }).sessionId;
	const credentialSessionId = options.session.credentialSessionId ?? sessionId;
	if (!modelRegistry || !sessionId) return assignments;
	const availableModels = modelRegistry.getAvailable();
	const authenticatedModels = availableModels.filter(model => {
		const isCredentiallessProvider = modelRegistry.isCredentiallessProvider?.bind(modelRegistry);
		const hasUsableAuth = modelRegistry.authStorage?.hasUsableAuth?.bind(modelRegistry.authStorage);
		if (!isCredentiallessProvider || !hasUsableAuth) return true;
		return isCredentiallessProvider(model.provider) || hasUsableAuth(model.provider);
	});
	return Object.fromEntries(
		Object.entries(assignments).map(([role, selectorValue]) => {
			const concrete = normalizeModelSelectorValue(selectorValue)
				.map(selector => {
					if (splitSelectorThinkingSuffix(selector).selector.includes("/")) return selector;
					const resolved = resolveModelRoleValue(selector, authenticatedModels, {
						settings: options.settings as Settings,
						modelRegistry,
						sessionId,
						credentialSessionId,
						aliasIntent: "preset-equivalent",
					});
					if (!resolved.model) return undefined;
					const concreteSelector = `${resolved.model.provider}/${resolved.model.id}`;
					return resolved.explicitThinkingLevel && resolved.thinkingLevel
						? formatModelSelectorValue(concreteSelector, resolved.thinkingLevel)
						: concreteSelector;
				})
				.filter((selector): selector is string => selector !== undefined);
			if (concrete.length === 0) {
				throw new Error(
					`Active model profile assignment ${role} could not be concretized: ${normalizeModelSelectorValue(selectorValue).join(", ")}`,
				);
			}
			return [role, concrete.length === 1 && typeof selectorValue === "string" ? concrete[0] : concrete];
		}),
	);
}

function commitMaterializedProfileAssignments(
	options: MaterializeModelProfileAssignmentOptions | MaterializeModelProfileAssignmentsOptions,
	modelRoles: Record<string, ModelSelectorValue>,
	agentModelOverrides: Record<string, ModelSelectorValue>,
): boolean {
	const previousPersistedModelRoles = options.settings.getGlobal("modelRoles");
	const previousPersistedAgentModelOverrides = options.settings.getGlobal("task.agentModelOverrides");
	const previousPersistedDefaultProfile = options.settings.getGlobal("modelProfile.default");
	const previousModelRolesOverride = options.settings.getOverride("modelRoles");
	const previousAgentModelOverridesOverride = options.settings.getOverride("task.agentModelOverrides");
	const previousDefaultProfileOverride = options.settings.getOverride("modelProfile.default");
	const previousActiveProfile = options.session.getActiveModelProfile?.();
	const previousChain = options.session.getConfiguredModelChainState?.("default");
	const previousFallbackRuntimeState = options.session.getDefaultFallbackRuntimeState?.();
	const previousCanonicalVariant = options.session.modelRegistry?.getSessionCanonicalVariant?.(
		(options.session as { sessionId?: string }).sessionId ?? "",
	);
	try {
		const nextModelRoles = concretizeMaterializedAssignmentValues(options, modelRoles);
		const nextAgentModelOverrides = concretizeMaterializedAssignmentValues(options, agentModelOverrides);
		options.settings.set("modelRoles", nextModelRoles);
		options.settings.set("task.agentModelOverrides", nextAgentModelOverrides);
		options.settings.unset("modelProfile.default");
		options.settings.clearOverride("modelProfile.default");
		options.settings.override("modelRoles", nextModelRoles);
		options.settings.override("task.agentModelOverrides", nextAgentModelOverrides);
		options.session.setConfiguredModelChain(
			"default",
			normalizeModelSelectorValue(nextModelRoles.default),
			"modelRoles",
			undefined,
			true,
		);
		options.session.setActiveModelProfile?.(undefined);
		return true;
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		const restore = (action: () => void): void => {
			try {
				action();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		};
		restore(() =>
			options.session.setConfiguredModelChain(
				"default",
				previousChain?.entries ?? [],
				previousChain?.origin ?? "rollback",
				previousChain?.identity,
				previousChain?.explicitHead ?? true,
			),
		);
		if (previousFallbackRuntimeState) {
			restore(() => options.session.restoreDefaultFallbackRuntimeState?.(previousFallbackRuntimeState));
		}
		if (options.session.modelRegistry) {
			restore(() => {
				const sessionId = (options.session as { sessionId?: string }).sessionId;
				if (!sessionId) return;
				if (previousCanonicalVariant) {
					options.session.modelRegistry?.restoreSessionCanonicalVariant?.(sessionId, previousCanonicalVariant);
				} else {
					options.session.modelRegistry?.clearCanonicalVariant?.(sessionId);
				}
			});
		}
		restore(() =>
			previousPersistedModelRoles === undefined
				? options.settings.unset("modelRoles")
				: options.settings.set("modelRoles", previousPersistedModelRoles),
		);
		restore(() =>
			previousPersistedAgentModelOverrides === undefined
				? options.settings.unset("task.agentModelOverrides")
				: options.settings.set("task.agentModelOverrides", previousPersistedAgentModelOverrides),
		);
		restore(() =>
			previousPersistedDefaultProfile === undefined
				? options.settings.unset("modelProfile.default")
				: options.settings.set("modelProfile.default", previousPersistedDefaultProfile),
		);
		restore(() =>
			previousModelRolesOverride === undefined
				? options.settings.clearOverride("modelRoles")
				: options.settings.override("modelRoles", previousModelRolesOverride),
		);
		restore(() =>
			previousAgentModelOverridesOverride === undefined
				? options.settings.clearOverride("task.agentModelOverrides")
				: options.settings.override("task.agentModelOverrides", previousAgentModelOverridesOverride),
		);
		restore(() =>
			previousDefaultProfileOverride === undefined
				? options.settings.clearOverride("modelProfile.default")
				: options.settings.override("modelProfile.default", previousDefaultProfileOverride),
		);
		restore(() => options.session.setActiveModelProfile?.(previousActiveProfile));
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[error, ...rollbackErrors],
				"Failed to materialize model profile and fully restore prior state",
			);
		}
		throw error;
	}
}

export function materializeActiveModelProfileAssignment(options: MaterializeModelProfileAssignmentOptions): boolean {
	const activeProfile = options.session.getActiveModelProfile?.() ?? options.settings.get("modelProfile.default");
	if (!activeProfile) return false;

	const nextModelRoles = { ...options.settings.get("modelRoles") };
	const nextAgentModelOverrides = { ...options.settings.get("task.agentModelOverrides") };
	const target = GJC_MODEL_ASSIGNMENT_TARGETS[options.role];

	if (options.role === "default") {
		nextModelRoles.default = options.selector;
	} else if (!nextModelRoles.default) {
		const defaultChain = materializeConfiguredDefaultChain(options.session);
		if (defaultChain) nextModelRoles.default = defaultChain;
	}

	if (target.settingsPath === "modelRoles") {
		nextModelRoles[options.role] = options.selector;
	} else {
		nextAgentModelOverrides[options.role] = options.selector;
	}

	const committed = commitMaterializedProfileAssignments(options, nextModelRoles, nextAgentModelOverrides);
	if (committed) options.session.clearProfileInstalledOverrides?.();
	return committed;
}

export function materializeActiveModelProfileAssignments(options: MaterializeModelProfileAssignmentsOptions): boolean {
	const activeProfile = options.session.getActiveModelProfile?.() ?? options.settings.get("modelProfile.default");
	if (!activeProfile) return false;

	const materializedAssignments = getMaterializedAssignments(options.assignments);
	if (materializedAssignments.length === 0) return true;

	const nextModelRoles = { ...options.settings.get("modelRoles") };
	const nextAgentModelOverrides = { ...options.settings.get("task.agentModelOverrides") };
	const includesDefault = materializedAssignments.some(([role]) => role === "default");

	if (!includesDefault && !nextModelRoles.default) {
		const defaultChain = materializeConfiguredDefaultChain(options.session);
		if (defaultChain) nextModelRoles.default = defaultChain;
	}

	for (const [role, selector] of materializedAssignments) {
		const target = GJC_MODEL_ASSIGNMENT_TARGETS[role];
		if (target.settingsPath === "modelRoles") {
			nextModelRoles[role] = selector;
		} else {
			nextAgentModelOverrides[role] = selector;
		}
	}

	const committed = commitMaterializedProfileAssignments(options, nextModelRoles, nextAgentModelOverrides);
	if (committed) options.session.clearProfileInstalledOverrides?.();
	return committed;
}

export class ModelProfileCredentialError extends Error {
	readonly code = "authentication_failed";
	readonly profileLabel: string;
	readonly providers: readonly string[];
	readonly role: string | undefined;

	constructor(profileLabel: string, providers: readonly string[], role?: string) {
		super(formatModelProfileCredentialError(profileLabel, providers));
		this.name = "ModelProfileCredentialError";
		this.profileLabel = profileLabel;
		this.providers = [...providers];
		this.role = role;
	}
}

export function formatModelProfileCredentialError(profileLabel: string, providers: readonly string[]): string {
	return `Model profile "${profileLabel}" requires credentials for: ${providers.join(", ")}. Run /login and configure the missing provider(s), then retry.`;
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

function rewriteSelectorValueProvider(
	selectorValue: ModelSelectorValue,
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
): ModelSelectorValue {
	const selectors = normalizeModelSelectorValue(selectorValue).map(selector =>
		rewriteSelectorProvider(selector, authenticatedProviders, alternativeGroups),
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
): {
	defaultSelector?: ModelSelectorValue;
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
} {
	return {
		defaultSelector: bindings.defaultSelector
			? rewriteSelectorValueProvider(bindings.defaultSelector, authenticatedProviders, alternativeGroups)
			: undefined,
		modelRoles: Object.fromEntries(
			Object.entries(bindings.modelRoles).map(([role, selector]) => [
				role,
				rewriteSelectorValueProvider(selector, authenticatedProviders, alternativeGroups),
			]),
		),
		agentModelOverrides: Object.fromEntries(
			Object.entries(bindings.agentModelOverrides).map(([role, selector]) => [
				role,
				rewriteSelectorValueProvider(selector, authenticatedProviders, alternativeGroups),
			]),
		),
	};
}
/**
 * Resolve the explicitly configured OpenAI-compatible proxy provider id for a
 * preset. Returns undefined when unset or empty. Passwords/labels are never
 * treated as proxy ids here; only lowercase provider ids from settings.
 */
export function resolveProxyProviderId(settings: Pick<Settings, "get"> | undefined): string | undefined {
	const config = inspectProxyProviderId(settings);
	if (config.status === "unset") return undefined;
	if (config.status === "invalid") {
		throw new Error(
			`modelProfile.proxyProvider must be a lowercase provider id (got "${config.value}"). Configure an OpenAI-compatible proxy with \`gjc setup provider\`, then set its id here.`,
		);
	}
	return config.id;
}

export type ProxyProviderConfig =
	| { status: "unset" }
	| { status: "configured"; id: string }
	| { status: "invalid"; value: string };

export function inspectProxyProviderId(settings: Pick<Settings, "get"> | undefined): ProxyProviderConfig {
	if (!settings) return { status: "unset" };
	const value = settings.get("modelProfile.proxyProvider");
	if (typeof value !== "string" || value.trim() === "") return { status: "unset" };
	const id = value.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9._-]*$/.test(id) ? { status: "configured", id } : { status: "invalid", value: value.trim() };
}

/** Passive surfaces fail closed on malformed settings instead of throwing. */
export function tryResolveProxyProviderId(settings: Pick<Settings, "get"> | undefined): string | undefined {
	const config = inspectProxyProviderId(settings);
	return config.status === "configured" ? config.id : undefined;
}

export type ModelProfileProxyMode = "fallback" | "always";

export function resolveProxyMode(settings: Pick<Settings, "get"> | undefined): ModelProfileProxyMode {
	if (!settings) return "fallback";
	const value = settings.get("modelProfile.proxyMode");
	if (value === undefined || value === "fallback" || value === "always") return value ?? "fallback";
	throw new Error(`modelProfile.proxyMode must be "fallback" or "always" (got "${String(value)}")`);
}

/**
 * Rewrite a qualified provider selector so its model is served through the
 * configured proxy. The proxy catalog uses sub-provider-prefixed model ids
 * (e.g. `xiaomi/mimo-v2.5-pro` under `litellm`). Exact provider-prefixed
 * matches win; a unique final-segment match is accepted for gateways that do
 * not retain the upstream provider prefix. Missing or ambiguous matches fail
 * closed rather than leaving an unauthenticated role selector behind.
 */
export function getProxyRoutableProviders(profile: ModelProfileDefinition): ReadonlySet<string> {
	if (profile.source === "user") return new Set();
	return profile.source === "registry"
		? new Set([
				...PROXY_ROUTABLE_PROVIDER_IDS,
				...profile.requiredProviders,
				...deriveModelProfileMappedProviders(profile),
			])
		: PROXY_ROUTABLE_PROVIDER_IDS;
}

/**
 * Profile sources whose non-default qualified role bindings are part of the
 * activation contract. Proxy rewrites run before role resolution, so a
 * rewritten selector satisfies this prerequisite when its concrete proxy
 * model is present in the effective catalog. Embedded built-ins intentionally
 * retain their legacy tolerance for stale qualified role tails.
 */
export function requiresQualifiedModelProfileRoleResolution(profile: Pick<ModelProfileDefinition, "source">): boolean {
	return profile.source === "user" || profile.source === "registry";
}

export function rewriteSelectorForProxy(
	selector: string,
	proxyProvider: string,
	proxyMode: ModelProfileProxyMode,
	allModels: Model<Api>[],
	directlyAuthenticated: ReadonlySet<string>,
	routableProviders: ReadonlySet<string>,
): string {
	const suffix = splitSelectorThinkingSuffix(selector);
	const baseSelector = suffix.selector;
	const slash = baseSelector.indexOf("/");
	const proxyModels = allModels.filter(model => model.provider === proxyProvider);
	if (slash < 0) {
		if (proxyMode === "fallback") return selector;
		const exactMatches = proxyModels.filter(model => model.id === baseSelector);
		const finalSegmentMatches = proxyModels.filter(model => model.id.split("/").at(-1) === baseSelector);
		const matches = exactMatches.length > 0 ? exactMatches : finalSegmentMatches;
		if (matches.length !== 1) {
			throw new Error(
				`Configured proxy "${proxyProvider}" does not expose an unambiguous model for "${baseSelector}"`,
			);
		}
		const rewritten = `${proxyProvider}/${matches[0]!.id}`;
		return suffix.thinkingLevel ? formatModelSelectorValue(rewritten, suffix.thinkingLevel) : rewritten;
	}
	const directProvider = baseSelector.substring(0, slash);
	if (proxyMode === "fallback" && directlyAuthenticated.has(directProvider)) return selector;
	if (!routableProviders.has(directProvider)) return selector;
	if (proxyProvider === directProvider) {
		throw new Error(`Configured proxy "${proxyProvider}" cannot route its own direct selector "${baseSelector}"`);
	}
	const directModelId = baseSelector.substring(slash + 1);
	const exactMatches = proxyModels.filter(model => model.id === `${directProvider}/${directModelId}`);
	const flatMatches = proxyModels.filter(model => model.id === directModelId);
	const matches = exactMatches.length > 0 ? exactMatches : flatMatches;
	if (matches.length === 0) {
		throw new Error(`Configured proxy "${proxyProvider}" does not expose a model for "${baseSelector}"`);
	}
	if (matches.length > 1) {
		throw new Error(`Configured proxy "${proxyProvider}" has ambiguous models for "${baseSelector}"`);
	}
	const rewritten = `${proxyProvider}/${matches[0]!.id}`;
	return suffix.thinkingLevel ? formatModelSelectorValue(rewritten, suffix.thinkingLevel) : rewritten;
}

function rewriteSelectorValueForProxy(
	selectorValue: ModelSelectorValue,
	proxyProvider: string,
	proxyMode: "fallback" | "always",
	allModels: Model<Api>[],
	directlyAuthenticated: ReadonlySet<string>,
	routableProviders: ReadonlySet<string>,
): ModelSelectorValue {
	const selectors = normalizeModelSelectorValue(selectorValue).map(selector =>
		rewriteSelectorForProxy(selector, proxyProvider, proxyMode, allModels, directlyAuthenticated, routableProviders),
	);
	return selectors.length === 1 && typeof selectorValue === "string" ? selectors[0] : selectors;
}

function rewriteBindingsForProxy(
	bindings: {
		defaultSelector?: ModelSelectorValue;
		modelRoles: Record<string, ModelSelectorValue>;
		agentModelOverrides: Record<string, ModelSelectorValue>;
	},
	proxyProvider: string,
	proxyMode: "fallback" | "always",
	allModels: Model<Api>[],
	directlyAuthenticated: ReadonlySet<string>,
	routableProviders: ReadonlySet<string>,
): {
	defaultSelector?: ModelSelectorValue;
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
} {
	return {
		defaultSelector: bindings.defaultSelector
			? rewriteSelectorValueForProxy(
					bindings.defaultSelector,
					proxyProvider,
					proxyMode,
					allModels,
					directlyAuthenticated,
					routableProviders,
				)
			: undefined,
		modelRoles: Object.fromEntries(
			Object.entries(bindings.modelRoles).map(([role, selector]) => [
				role,
				rewriteSelectorValueForProxy(
					selector,
					proxyProvider,
					proxyMode,
					allModels,
					directlyAuthenticated,
					routableProviders,
				),
			]),
		),
		agentModelOverrides: Object.fromEntries(
			Object.entries(bindings.agentModelOverrides).map(([role, selector]) => [
				role,
				rewriteSelectorValueForProxy(
					selector,
					proxyProvider,
					proxyMode,
					allModels,
					directlyAuthenticated,
					routableProviders,
				),
			]),
		),
	};
}

function formatMaterializedSelector(selector: string, model: Model<Api>): string {
	const suffix = splitSelectorThinkingSuffix(selector);
	if (!suffix.selector.includes("/") && suffix.thinkingLevel && model.thinking) {
		const clamped = clampExplicitThinkingLevelForModel(model, suffix.thinkingLevel);
		return clamped && clamped !== ThinkingLevel.Inherit
			? formatModelSelectorValue(suffix.selector, clamped)
			: suffix.selector;
	}
	const clampedSelector = formatClampedModelSelector(selector, model);
	const explicitThinkingLevel = parseModelString(selector)?.thinkingLevel;
	if (!explicitThinkingLevel || parseModelString(clampedSelector)?.thinkingLevel) return clampedSelector;
	return formatModelSelectorValue(clampedSelector, explicitThinkingLevel);
}
function getBareSelectorCredentialProviders(selector: string, modelRegistry: ModelRegistry): string[] {
	const suffix = splitSelectorThinkingSuffix(selector);
	const alias = (suffix.thinkingLevel ? suffix.selector : selector).trim().toLowerCase();
	const providers = modelRegistry
		.getAll()
		.filter(model => {
			const modelId = model.id.trim().toLowerCase();
			return modelId === alias || modelId.slice(modelId.lastIndexOf("/") + 1) === alias;
		})
		.map(model => model.provider);
	return [...new Set(providers)];
}

async function resolveAndClampSelectorValue(
	selectorValue: ModelSelectorValue,
	availableModels: Model<Api>[],
	options: {
		settings: Settings;
		modelRegistry: ModelRegistry;
		sessionId: string;
		credentialSessionId: string;
		aliasIntent: "preset-equivalent";
		requireQualifiedResolution?: boolean;
	},
	profileLabel: string,
	role: string,
): Promise<ModelSelectorValue> {
	const selectors = normalizeModelSelectorValue(selectorValue);
	const clamped: string[] = [];
	const unresolvedKnownBareProviders = new Set<string>();
	const unresolvedQualifiedSelectors: string[] = [];
	let everySelectorIsKnownBare = selectors.length > 1;
	let resolvedAny = false;
	for (const selector of selectors) {
		const bareAlias = !splitSelectorThinkingSuffix(selector).selector.includes("/");
		let resolved = resolveModelRoleValue(selector, availableModels, options);
		if (bareAlias) {
			const authenticated = await resolveModelChainWithAuth(
				[selector],
				{
					getAvailable: () => availableModels,
					getApiKey: model =>
						options.modelRegistry.getApiKeyForProvider(
							model.provider,
							options.credentialSessionId,
							model.baseUrl,
						),
					resolveCanonicalModel: options.modelRegistry.resolveCanonicalModel.bind(options.modelRegistry),
					resolveModelByLookupAlias: options.modelRegistry.resolveModelByLookupAlias?.bind(options.modelRegistry),
					lookupAliasExists: options.modelRegistry.lookupAliasExists?.bind(options.modelRegistry),
					clearCanonicalVariant: options.modelRegistry.clearCanonicalVariant?.bind(options.modelRegistry),
				},
				options.settings,
				options.credentialSessionId,
				{
					managedFallback: true,
					aliasIntent: options.aliasIntent,
					canonicalSessionId: options.sessionId,
					credentialSessionId: options.credentialSessionId,
				},
			);
			resolved = {
				model: authenticated.model,
				thinkingLevel: authenticated.thinkingLevel,
				explicitThinkingLevel: authenticated.explicitThinkingLevel,
				warning: undefined,
			};
		}
		if (!resolved.model) {
			if (bareAlias) {
				const providers = getBareSelectorCredentialProviders(selector, options.modelRegistry);
				const selectorSuffix = splitSelectorThinkingSuffix(selector);
				const bareSelector = selectorSuffix.thinkingLevel ? selectorSuffix.selector : selector;
				const aliasKnown =
					options.modelRegistry.lookupAliasExists?.(bareSelector.toLowerCase()) ?? providers.length > 0;
				if (selectors.length === 1) {
					if (!aliasKnown) {
						throw new Error(
							`Model profile "${profileLabel}" ${role} selector "${bareSelector}" does not match any catalog model`,
						);
					}
					throw new ModelProfileCredentialError(
						profileLabel,
						providers.length > 0 ? providers : [bareSelector],
						role,
					);
				}
				if (aliasKnown) {
					for (const provider of providers.length > 0 ? providers : [bareSelector]) {
						unresolvedKnownBareProviders.add(provider);
					}
				} else {
					everySelectorIsKnownBare = false;
				}
			} else {
				unresolvedQualifiedSelectors.push(selector);
				everySelectorIsKnownBare = false;
			}
			clamped.push(selector);
			continue;
		}
		resolvedAny = true;
		clamped.push(formatMaterializedSelector(selector, resolved.model));
	}
	if (!resolvedAny && everySelectorIsKnownBare && unresolvedKnownBareProviders.size > 0) {
		throw new ModelProfileCredentialError(profileLabel, [...unresolvedKnownBareProviders].sort(), role);
	}
	if (options.requireQualifiedResolution && !resolvedAny && unresolvedQualifiedSelectors.length > 0) {
		throw new Error(
			`Model profile "${profileLabel}" ${role} selectors do not match any catalog model: ${unresolvedQualifiedSelectors.join(", ")}`,
		);
	}
	return clamped.length === 1 && typeof selectorValue === "string" ? clamped[0] : clamped;
}

async function concretizeProfileSelectorValue(
	selectorValue: ModelSelectorValue,
	prepared: PreparedModelProfileActivation,
): Promise<ModelSelectorValue> {
	const candidates = prepared.modelRegistry.getAvailable?.() ?? prepared.modelRegistry.getAll();
	const credentialSessionId = prepared.session.credentialSessionId ?? prepared.session.sessionId;
	const concrete = await Promise.all(
		normalizeModelSelectorValue(selectorValue).map(async selector => {
			const bareAlias = !splitSelectorThinkingSuffix(selector).selector.includes("/");
			const resolved = bareAlias
				? await resolveModelChainWithAuth(
						[selector],
						{
							getAvailable: () => candidates,
							getApiKey: model =>
								prepared.modelRegistry.getApiKeyForProvider(model.provider, credentialSessionId, model.baseUrl),
							resolveCanonicalModel: prepared.modelRegistry.resolveCanonicalModel.bind(prepared.modelRegistry),
							resolveModelByLookupAlias: prepared.modelRegistry.resolveModelByLookupAlias?.bind(
								prepared.modelRegistry,
							),
							lookupAliasExists: prepared.modelRegistry.lookupAliasExists?.bind(prepared.modelRegistry),
							clearCanonicalVariant: prepared.modelRegistry.clearCanonicalVariant?.bind(prepared.modelRegistry),
						},
						prepared.settings as Settings,
						credentialSessionId,
						{
							managedFallback: true,
							aliasIntent: "preset-equivalent",
							canonicalSessionId: prepared.session.sessionId,
							credentialSessionId,
						},
					)
				: resolveModelRoleValue(selector, candidates, {
						settings: prepared.settings as Settings,
						modelRegistry: prepared.modelRegistry,
						sessionId: prepared.session.sessionId,
						credentialSessionId,
						aliasIntent: "preset-equivalent",
					});
			if (!resolved.model) {
				if (bareAlias) return undefined;
				return selector;
			}
			const concreteSelector = `${resolved.model.provider}/${resolved.model.id}`;
			return resolved.explicitThinkingLevel && resolved.thinkingLevel
				? formatModelSelectorValue(concreteSelector, resolved.thinkingLevel)
				: concreteSelector;
		}),
	);
	const resolvedConcrete = concrete.filter((selector): selector is string => selector !== undefined);
	if (resolvedConcrete.length === 0) {
		throw new Error(
			`Model profile deletion could not concretize authenticated selector: ${normalizeModelSelectorValue(selectorValue)[0]}`,
		);
	}
	return resolvedConcrete.length === 1 && typeof selectorValue === "string" ? resolvedConcrete[0]! : resolvedConcrete;
}

/**
 * Restore the session's canonical sticky variant after a failed activation.
 * The exact pre-clear sticky selector (snapshotted verbatim, never re-derived
 * from the live model) is restored when present; otherwise any stale sticky
 * variant is cleared so a previous provider cannot silently resurrect.
 */
function restoreCanonicalVariant(
	modelRegistry: PrepareModelProfileActivationOptions["modelRegistry"],
	sessionId: string,
	previousCanonicalVariant: string | undefined,
): void {
	if (previousCanonicalVariant !== undefined) {
		const restored = modelRegistry.restoreSessionCanonicalVariant?.(sessionId, previousCanonicalVariant) === true;
		if (!restored) modelRegistry.clearCanonicalVariant?.(sessionId);
	} else {
		modelRegistry.clearCanonicalVariant?.(sessionId);
	}
}
export async function prepareModelProfileActivation(
	options: PrepareModelProfileActivationOptions,
): Promise<PreparedModelProfileActivation> {
	const profiles = options.modelRegistry.getModelProfiles();
	const profileName = validateModelProfileName(options.profileName, profiles, options.modelRegistry.getError?.());
	const profile = profiles.get(profileName) ?? options.modelRegistry.getModelProfile(profileName)!;
	const profileLabel = formatModelProfileDisplayLabel(profile);

	const previousModel = options.session.model;
	// Snapshot the exact pre-clear sticky selector (verbatim, not re-derived from
	// the live model) so a failed prepare/apply/materialize rollback restores the
	// genuinely-sticky provider even when the live model is a transient switch.
	const credentialSessionId = options.session.credentialSessionId ?? options.session.sessionId;
	const previousCanonicalVariant = options.modelRegistry.getSessionCanonicalVariant?.(options.session.sessionId);

	// Explicit profile activation/reselection invalidates the session's sticky
	// canonical variant BEFORE the new profile's aliases resolve, so the old
	// provider's sticky variant cannot win the new profile's resolution.
	options.modelRegistry.clearCanonicalVariant?.(options.session.sessionId);

	try {
		const requiredProviders = aggregateModelProfileRequiredProviders(profile.requiredProviders, profile);
		const alternativeGroups = profile.alternativeProviderGroups ?? [];
		const alternativeSet = new Set(alternativeGroups.flat());
		const requiredProviderSet = new Set(requiredProviders);
		const authenticationProbeProviders = new Set<string>([
			...requiredProviders,
			...alternativeSet,
			...deriveModelProfileMappedProviders(profile),
		]);

		const missingProviders: string[] = [];
		const authenticatedProviders: string[] = [];
		for (const provider of authenticationProbeProviders) {
			let apiKey: string | undefined;
			try {
				apiKey = await options.modelRegistry.getApiKeyForProvider(provider, credentialSessionId);
			} catch (error) {
				if (requiredProviderSet.has(provider) && !alternativeSet.has(provider)) throw error;
				continue;
			}
			if (apiKey !== kNoAuth && !isAuthenticated(apiKey)) {
				if (requiredProviderSet.has(provider)) missingProviders.push(provider);
			} else {
				authenticatedProviders.push(provider);
			}
		}

		// Required providers are the only activation prerequisites. Mapped fallback
		// providers are resolution-time candidates and intentionally do not gate here.
		// A proxy-routable strict provider is satisfied through the configured
		// OpenAI-compatible proxy when that proxy is itself authenticated; otherwise
		// we fail closed pointing at the proxy (or the provider when none is set).
		const proxyProvider = profile.source !== "user" ? resolveProxyProviderId(options.settings) : undefined;
		const proxyMode = profile.source !== "user" ? resolveProxyMode(options.settings) : "fallback";
		const proxyRoutableProviders =
			profile.source === "user"
				? new Set<string>()
				: profile.source === "registry"
					? new Set([
							...PROXY_ROUTABLE_PROVIDER_IDS,
							...profile.requiredProviders,
							...deriveModelProfileMappedProviders(profile),
						])
					: PROXY_ROUTABLE_PROVIDER_IDS;
		if (proxyMode === "always" && proxyProvider === undefined) {
			throw new Error('modelProfile.proxyMode "always" requires modelProfile.proxyProvider');
		}
		if (proxyProvider !== undefined) {
			const configuredProxyProviders = options.modelRegistry.getConfiguredProviderIds?.();
			if (!configuredProxyProviders?.includes(proxyProvider)) {
				throw new Error(
					`modelProfile.proxyProvider "${proxyProvider}" is not configured. Configure it with \`gjc setup provider\` before activating a preset.`,
				);
			}
		}
		const proxyApiKey =
			proxyProvider === undefined
				? undefined
				: await options.modelRegistry.getApiKeyForProvider(proxyProvider, credentialSessionId);
		const proxyAuthenticated =
			proxyProvider !== undefined &&
			proxyApiKey !== undefined &&
			(proxyApiKey === kNoAuth || isAuthenticated(proxyApiKey));
		if (proxyMode === "always" && !proxyAuthenticated) {
			throw new ModelProfileCredentialError(profileLabel, [proxyProvider!]);
		}

		const strictMissing = missingProviders.filter(
			provider => !proxyRoutableProviders.has(provider) && !alternativeSet.has(provider),
		);
		if (strictMissing.length > 0) {
			throw new ModelProfileCredentialError(profileLabel, strictMissing);
		}
		const strictRoutableMissing = missingProviders.filter(
			provider => proxyRoutableProviders.has(provider) && !alternativeSet.has(provider),
		);
		if (strictRoutableMissing.length > 0 && (proxyProvider === undefined || !proxyAuthenticated)) {
			throw new ModelProfileCredentialError(
				profileLabel,
				proxyProvider === undefined ? strictRoutableMissing : [proxyProvider],
			);
		}
		for (const group of alternativeGroups) {
			const groupAuthenticated = group.some(provider => authenticatedProviders.includes(provider));
			if (groupAuthenticated) continue;
			const allRoutable = group.every(provider => proxyRoutableProviders.has(provider));
			if (allRoutable && proxyAuthenticated) continue;
			throw new ModelProfileCredentialError(
				profileLabel,
				allRoutable && proxyProvider !== undefined ? [proxyProvider] : [...group],
			);
		}

		const availableModels =
			options.modelRegistry.getAvailableForProfileActivation?.() ??
			options.modelRegistry.getAvailable?.() ??
			options.modelRegistry.getAll();
		const roleCatalogModels = options.modelRegistry.getAll();
		let bindings = resolveProfileBindings(profile);
		if (alternativeGroups.length > 0) {
			bindings = rewriteBindingsProviders(bindings, new Set(authenticatedProviders), alternativeGroups);
		}
		// Built-in preset selectors are routed through a configured authenticated
		// proxy according to the selected mode. This session-scoped rewrite is never
		// persisted to models.yml.
		if (proxyProvider !== undefined && proxyAuthenticated && profile.source !== "user") {
			bindings = rewriteBindingsForProxy(
				bindings,
				proxyProvider,
				proxyMode,
				availableModels,
				new Set(authenticatedProviders),
				proxyRoutableProviders,
			);
		}
		const defaultSelectors = bindings.defaultSelector ? normalizeModelSelectorValue(bindings.defaultSelector) : [];
		const defaultChain =
			defaultSelectors.length > 0
				? normalizeModelSelectorValue(
						await resolveAndClampSelectorValue(
							bindings.defaultSelector!,
							availableModels,
							{
								settings: options.settings as Settings,
								modelRegistry: options.modelRegistry as ModelRegistry,
								sessionId: options.session.sessionId,
								credentialSessionId,
								aliasIntent: "preset-equivalent",
							},
							profileLabel,
							"default",
						),
					)
				: [];
		const defaultResolution = await resolveModelChainWithAuth(
			defaultChain,
			{
				getAvailable: () => availableModels,
				getApiKey: (model, sessionId) =>
					options.modelRegistry.getApiKeyForProvider(model.provider, sessionId, model.baseUrl),
				resolveCanonicalModel: options.modelRegistry.resolveCanonicalModel?.bind(options.modelRegistry),
				getCanonicalVariants: options.modelRegistry.getCanonicalVariants?.bind(options.modelRegistry),
				getCanonicalId: options.modelRegistry.getCanonicalId?.bind(options.modelRegistry),
				resolveModelByLookupAlias: options.modelRegistry.resolveModelByLookupAlias?.bind(options.modelRegistry),
				lookupAliasExists: options.modelRegistry.lookupAliasExists?.bind(options.modelRegistry),
				clearCanonicalVariant: options.modelRegistry.clearCanonicalVariant?.bind(options.modelRegistry),
			} as ModelRegistry,
			options.settings as Settings,
			credentialSessionId,
			{
				managedFallback: true,
				aliasIntent: "preset-equivalent",
				canonicalSessionId: options.session.sessionId,
				credentialSessionId,
			},
		);
		const defaultModel = defaultResolution.model;
		const defaultThinkingLevel = defaultResolution.thinkingLevel;
		const defaultActiveIndex = defaultModel ? defaultResolution.activeIndex : undefined;
		const defaultResolutionSkips = defaultResolution.skips;
		if (bindings.defaultSelector && !defaultModel) {
			const configuredDefaults = normalizeModelSelectorValue(bindings.defaultSelector);
			if (configuredDefaults.length === 1) {
				throw new Error(
					`Model profile "${profileLabel}" default selector did not resolve: ${configuredDefaults[0]}`,
				);
			}
			throw new Error(`Model profile "${profileLabel}" default selectors did not resolve to an authenticated model`);
		}

		const modelRoles: Record<string, ModelSelectorValue> = {};
		for (const [role, selectorValue] of Object.entries(bindings.modelRoles) as [
			GjcModelAssignmentTargetId,
			ModelSelectorValue,
		][]) {
			modelRoles[role] = await resolveAndClampSelectorValue(
				selectorValue,
				roleCatalogModels,
				{
					settings: options.settings as Settings,
					modelRegistry: options.modelRegistry as ModelRegistry,
					sessionId: options.session.sessionId,
					credentialSessionId,
					aliasIntent: "preset-equivalent",
					requireQualifiedResolution: requiresQualifiedModelProfileRoleResolution(profile),
				},
				profileLabel,
				role,
			);
		}

		const agentModelOverrides: Record<string, ModelSelectorValue> = {};
		for (const [role, selectorValue] of Object.entries(bindings.agentModelOverrides) as [
			GjcModelAssignmentTargetId,
			ModelSelectorValue,
		][]) {
			agentModelOverrides[role] = await resolveAndClampSelectorValue(
				selectorValue,
				roleCatalogModels,
				{
					settings: options.settings as Settings,
					modelRegistry: options.modelRegistry as ModelRegistry,
					sessionId: options.session.sessionId,
					credentialSessionId,
					aliasIntent: "preset-equivalent",
					requireQualifiedResolution: requiresQualifiedModelProfileRoleResolution(profile),
				},
				profileLabel,
				role,
			);
		}

		return {
			profileName,
			session: options.session as PreparedModelProfileActivation["session"],
			settings: options.settings as PreparedModelProfileActivation["settings"],
			modelRegistry: options.modelRegistry,
			previousModel,
			previousCanonicalVariant,
			previousThinkingLevel: options.session.thinkingLevel,
			previousAgentModelOverrides: { ...options.settings.get("task.agentModelOverrides") },
			previousModelRoles: { ...options.settings.get("modelRoles") },
			baseAgentModelOverrides: Object.fromEntries(
				Object.entries(options.settings.get("task.agentModelOverrides") ?? {}).filter(
					([key]) =>
						!(options.session.getProfileInstalledOverrideKeys?.().agentModelOverrides ?? []).includes(key),
				),
			),
			baseModelRoles: Object.fromEntries(
				Object.entries(options.settings.get("modelRoles") ?? {}).filter(
					([key]) => !(options.session.getProfileInstalledOverrideKeys?.().modelRoles ?? []).includes(key),
				),
			),
			previousPersistedModelRoles: options.settings.getGlobal("modelRoles"),
			previousPersistedAgentModelOverrides: options.settings.getGlobal("task.agentModelOverrides"),
			previousModelRolesOverride: options.settings.getOverride("modelRoles"),
			previousAgentModelOverridesOverride: options.settings.getOverride("task.agentModelOverrides"),
			previousDefaultProfileOverride: options.settings.getOverride("modelProfile.default"),
			previousPersistedDefaultProfile: options.settings.getGlobal("modelProfile.default"),
			previousPersistedDefaultThinkingLevel: options.settings.getGlobal("defaultThinkingLevel") as
				| Exclude<ThinkingLevel, "inherit">
				| undefined,
			previousDefaultThinkingLevelOverride: options.settings.getOverride("defaultThinkingLevel"),
			previousDefaultChain: options.session.getConfiguredModelChain("default"),
			previousDefaultChainState: options.session.getConfiguredModelChainState?.("default"),

			defaultModel,
			defaultThinkingLevel,
			defaultActiveIndex,
			defaultResolutionSkips,
			defaultChain,
			modelRoles,
			agentModelOverrides,
			previousActiveModelProfile: options.session.getActiveModelProfile?.(),
			previousSessionDefaultModel: options.session.getSessionDefaultModelSelector?.(),
			previousDefaultFallbackRuntimeState: options.session.getDefaultFallbackRuntimeState?.(),
		};
	} catch (error) {
		restoreCanonicalVariant(options.modelRegistry, options.session.sessionId, previousCanonicalVariant);
		throw error;
	}
}

export async function applyPreparedModelProfileActivation(
	prepared: PreparedModelProfileActivation,
	options: ApplyModelProfileActivationOptions = {},
): Promise<void> {
	let modelMutationStarted = false;
	let overridesChanged = false;
	let modelRolesChanged = false;
	let persistentMutationStarted = false;
	let defaultChainChanged = false;
	let resumeDefaultChanged = false;

	try {
		const ownedDefaultChain =
			prepared.defaultChain.length > 0
				? prepared.defaultChain
				: (prepared.previousDefaultChain ??
					(prepared.previousModel ? [formatModelString(prepared.previousModel)] : []));
		if (ownedDefaultChain.length > 0) {
			options.assertCanCommit?.();
			defaultChainChanged = true;
			prepared.session.setConfiguredModelChain(
				"default",
				ownedDefaultChain,
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
		}
		if (prepared.defaultModel) {
			options.assertCanCommit?.();
			modelMutationStarted = true;
			await prepared.session.setModelTemporary(
				prepared.defaultModel,
				options.thinkingLevelOverride ?? prepared.defaultThinkingLevel,
				{ cause: "profile-activation" },
			);
		}
		options.assertCanCommit?.();
		// Always reinstall the model role layer from the durable base plus the
		// new profile's roles so omitted roles from the previous profile are dropped.
		prepared.settings.override("modelRoles", {
			...prepared.baseModelRoles,
			...prepared.modelRoles,
		});
		modelRolesChanged = true;
		// Always reinstall the agent role layer from the durable base plus the
		// new profile's roles: a default-only or role-free successor must drop
		// the previous profile's role-agent mappings rather than inheriting them.
		prepared.settings.override("task.agentModelOverrides", {
			...prepared.baseAgentModelOverrides,
			...prepared.agentModelOverrides,
		});
		overridesChanged = true;
		if (options.persistDefault) {
			options.assertCanCommit?.();
			persistentMutationStarted = true;
			prepared.settings.set("modelRoles", {});
			prepared.settings.set("task.agentModelOverrides", {});
			if (prepared.defaultThinkingLevel !== undefined && prepared.defaultThinkingLevel !== ThinkingLevel.Inherit) {
				prepared.settings.set("defaultThinkingLevel", prepared.defaultThinkingLevel);
			}
			prepared.settings.set("modelProfile.default", prepared.profileName);
			await prepared.settings.flushOrThrow();
		}
		options.assertCanCommit?.();
		prepared.session.setActiveModelProfile?.(prepared.profileName);
		if (prepared.defaultModel) {
			options.assertCanCommit?.();
			prepared.modelRegistry.seedCanonicalVariant?.(prepared.session.sessionId, prepared.defaultModel);
			resumeDefaultChanged = true;
			prepared.session.recordResumeDefaultModel?.(`${prepared.defaultModel.provider}/${prepared.defaultModel.id}`);
		}
		options.assertCanCommit?.();
		prepared.session.noteProfileInstalledOverrides?.(
			Object.keys(prepared.modelRoles),
			Object.keys(prepared.agentModelOverrides),
			prepared.previousModel,
		);
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		const restore = (action: () => void): void => {
			try {
				action();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		};
		if (persistentMutationStarted) {
			restore(() =>
				prepared.previousPersistedDefaultProfile === undefined
					? prepared.settings.unset("modelProfile.default")
					: prepared.settings.set("modelProfile.default", prepared.previousPersistedDefaultProfile),
			);
			restore(() =>
				prepared.previousPersistedModelRoles === undefined
					? prepared.settings.unset("modelRoles")
					: prepared.settings.set("modelRoles", prepared.previousPersistedModelRoles),
			);
			restore(() =>
				prepared.previousPersistedAgentModelOverrides === undefined
					? prepared.settings.unset("task.agentModelOverrides")
					: prepared.settings.set("task.agentModelOverrides", prepared.previousPersistedAgentModelOverrides),
			);
			restore(() =>
				prepared.previousPersistedDefaultThinkingLevel === undefined
					? prepared.settings.unset("defaultThinkingLevel")
					: prepared.settings.set("defaultThinkingLevel", prepared.previousPersistedDefaultThinkingLevel),
			);
		}
		if (modelRolesChanged) {
			restore(() =>
				prepared.previousModelRolesOverride === undefined
					? prepared.settings.clearOverride("modelRoles")
					: prepared.settings.override("modelRoles", prepared.previousModelRolesOverride),
			);
		}
		if (overridesChanged) {
			restore(() =>
				prepared.previousAgentModelOverridesOverride === undefined
					? prepared.settings.clearOverride("task.agentModelOverrides")
					: prepared.settings.override("task.agentModelOverrides", prepared.previousAgentModelOverridesOverride),
			);
		}
		if (modelMutationStarted) {
			try {
				if (prepared.session.restoreModelSelectionForRollback) {
					await prepared.session.restoreModelSelectionForRollback(
						prepared.previousModel,
						prepared.previousThinkingLevel,
					);
				} else if (prepared.previousModel) {
					await prepared.session.setModelTemporary(prepared.previousModel, prepared.previousThinkingLevel, {
						cause: "rollback",
					});
				} else {
					throw new Error("Model-less profile activation rollback is unavailable");
				}
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		if (resumeDefaultChanged) {
			restore(() => prepared.session.recordResumeDefaultModel?.(prepared.previousSessionDefaultModel));
		}
		if (defaultChainChanged) {
			const previousChain = prepared.previousDefaultChainState;
			restore(() =>
				prepared.session.setConfiguredModelChain(
					"default",
					previousChain?.entries ??
						prepared.previousDefaultChain ??
						(prepared.previousModel ? [`${prepared.previousModel.provider}/${prepared.previousModel.id}`] : []),
					previousChain?.origin ?? "rollback",
					previousChain?.identity,
					previousChain?.explicitHead ?? true,
				),
			);
		}
		if (prepared.previousDefaultFallbackRuntimeState) {
			restore(() =>
				prepared.session.restoreDefaultFallbackRuntimeState?.(prepared.previousDefaultFallbackRuntimeState!),
			);
		}
		restore(() => prepared.session.setActiveModelProfile?.(prepared.previousActiveModelProfile));
		restore(() =>
			restoreCanonicalVariant(prepared.modelRegistry, prepared.session.sessionId, prepared.previousCanonicalVariant),
		);
		if (persistentMutationStarted) {
			try {
				await prepared.settings.flushOrThrow();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[error, ...rollbackErrors],
				"Model profile activation failed and rollback was incomplete",
			);
		}
		throw error;
	}
	// The installed role layer decides whether this profile is vendor-separated,
	// so delegation must be re-applied to the live session rather than only to
	// sessions started after activation. Activation itself already succeeded; a
	// failed refresh must not roll it back.
	try {
		await prepared.session.syncEagerDelegation?.();
	} catch (error) {
		logger.warn("Failed to sync eager delegation after model profile activation", {
			profile: prepared.profileName,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export interface MaterializeModelProfileForDeletionResult {
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
	previousModelRoles: Record<string, ModelSelectorValue>;
	previousAgentModelOverrides: Record<string, ModelSelectorValue>;
	previousPersistedModelRoles: Record<string, ModelSelectorValue> | undefined;
	previousPersistedAgentModelOverrides: Record<string, ModelSelectorValue> | undefined;
	previousModelRolesOverride: Record<string, ModelSelectorValue> | undefined;
	previousAgentModelOverridesOverride: Record<string, ModelSelectorValue> | undefined;
	previousDefaultProfileOverride: string | undefined;
	previousDefaultProfile: string | undefined;
	previousPersistedDefaultProfile: string | undefined;
	previousActiveModelProfile: string | undefined;
	previousDefaultChainState: ConfiguredModelChainState | undefined;
	previousDefaultFallbackRuntimeState: DefaultFallbackRuntimeState | undefined;
	/**
	 * Restores the session sticky canonical variant that was snapshotted before
	 * materialization cleared it. Internal closure capturing the registry,
	 * session, and exact pre-clear selector — avoids threading a registry
	 * through the restore options. Optional so callers that never materialized
	 * (or use a registry without sticky support) can still restore settings.
	 */
	restoreSessionCanonicalVariant?: () => void;
}

export async function materializeModelProfileForDeletion(
	options: PrepareModelProfileActivationOptions & {
		settings: Pick<Settings, "clearOverride" | "flushOrThrow" | "get" | "getGlobal" | "override" | "set" | "unset">;
	},
): Promise<MaterializeModelProfileForDeletionResult> {
	const prepared = await prepareModelProfileActivation(options);
	const previousDefaultProfile = prepared.settings.get("modelProfile.default");
	const previousPersistedDefaultProfile = prepared.settings.getGlobal("modelProfile.default");
	const concretizeForDeletion = async (selector: ModelSelectorValue): Promise<ModelSelectorValue> => {
		try {
			return await concretizeProfileSelectorValue(selector, prepared);
		} catch (error) {
			restoreCanonicalVariant(prepared.modelRegistry, prepared.session.sessionId, prepared.previousCanonicalVariant);
			throw error;
		}
	};
	const concreteDefaultChain =
		prepared.defaultChain.length > 0
			? normalizeModelSelectorValue(await concretizeForDeletion(prepared.defaultChain))
			: [];
	const concreteModelRoles: Record<string, ModelSelectorValue> = {};
	for (const [role, selector] of Object.entries(prepared.modelRoles)) {
		concreteModelRoles[role] = await concretizeForDeletion(selector);
	}
	const concreteAgentModelOverrides: Record<string, ModelSelectorValue> = {};
	for (const [role, selector] of Object.entries(prepared.agentModelOverrides)) {
		concreteAgentModelOverrides[role] = await concretizeForDeletion(selector);
	}
	const nextModelRoles = {
		...prepared.previousModelRoles,
		...(concreteDefaultChain.length > 0
			? {
					default: concreteDefaultChain.length === 1 ? concreteDefaultChain[0] : [...concreteDefaultChain],
				}
			: {}),
		...concreteModelRoles,
	};
	const nextAgentModelOverrides = {
		...prepared.previousAgentModelOverrides,
		...concreteAgentModelOverrides,
	};
	let defaultChainChanged = false;

	try {
		prepared.settings.set("modelRoles", nextModelRoles);
		prepared.settings.set("task.agentModelOverrides", nextAgentModelOverrides);
		prepared.settings.unset("modelProfile.default");
		prepared.settings.clearOverride("modelProfile.default");
		prepared.settings.override("modelRoles", nextModelRoles);
		prepared.settings.override("task.agentModelOverrides", nextAgentModelOverrides);
		prepared.session.setActiveModelProfile?.(undefined);
		if (prepared.defaultChain.length > 0) {
			defaultChainChanged = true;
			prepared.session.setConfiguredModelChain(
				"default",
				concreteDefaultChain,
				"profile-deletion-materialized",
				undefined,
				true,
			);
		}
		await prepared.settings.flushOrThrow();
		prepared.session.clearProfileInstalledOverrides?.();
	} catch (error) {
		const previousChain = prepared.previousDefaultChainState;
		const rollbackErrors: unknown[] = [];
		const restore = (action: () => void): void => {
			try {
				action();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		};
		restore(() =>
			restoreCanonicalVariant(prepared.modelRegistry, prepared.session.sessionId, prepared.previousCanonicalVariant),
		);
		if (defaultChainChanged) {
			restore(() =>
				prepared.session.setConfiguredModelChain(
					"default",
					previousChain?.entries ?? prepared.previousDefaultChain ?? [],
					previousChain?.origin ?? "rollback",
					previousChain?.identity,
					previousChain?.explicitHead ?? true,
				),
			);
		}
		if (prepared.previousDefaultFallbackRuntimeState) {
			restore(() =>
				prepared.session.restoreDefaultFallbackRuntimeState?.(prepared.previousDefaultFallbackRuntimeState!),
			);
		}
		restore(() =>
			prepared.previousPersistedModelRoles === undefined
				? prepared.settings.unset("modelRoles")
				: prepared.settings.set("modelRoles", prepared.previousPersistedModelRoles),
		);
		restore(() =>
			prepared.previousPersistedAgentModelOverrides === undefined
				? prepared.settings.unset("task.agentModelOverrides")
				: prepared.settings.set("task.agentModelOverrides", prepared.previousPersistedAgentModelOverrides),
		);
		restore(() => prepared.settings.set("modelProfile.default", previousPersistedDefaultProfile));
		restore(() =>
			prepared.previousModelRolesOverride === undefined
				? prepared.settings.clearOverride("modelRoles")
				: prepared.settings.override("modelRoles", prepared.previousModelRolesOverride),
		);
		restore(() =>
			prepared.previousAgentModelOverridesOverride === undefined
				? prepared.settings.clearOverride("task.agentModelOverrides")
				: prepared.settings.override("task.agentModelOverrides", prepared.previousAgentModelOverridesOverride),
		);
		restore(() =>
			prepared.previousDefaultProfileOverride === undefined
				? prepared.settings.clearOverride("modelProfile.default")
				: prepared.settings.override("modelProfile.default", prepared.previousDefaultProfileOverride),
		);
		restore(() => prepared.session.setActiveModelProfile?.(prepared.previousActiveModelProfile));
		try {
			await prepared.settings.flushOrThrow();
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[error, ...rollbackErrors],
				"Profile deletion materialization failed and rollback was incomplete",
			);
		}
		throw error;
	}

	return {
		modelRoles: nextModelRoles,
		agentModelOverrides: nextAgentModelOverrides,
		previousModelRoles: prepared.previousModelRoles,
		previousAgentModelOverrides: prepared.previousAgentModelOverrides,
		previousPersistedModelRoles: prepared.previousPersistedModelRoles,
		previousPersistedAgentModelOverrides: prepared.previousPersistedAgentModelOverrides,
		previousModelRolesOverride: prepared.previousModelRolesOverride,
		previousAgentModelOverridesOverride: prepared.previousAgentModelOverridesOverride,
		previousDefaultProfileOverride: prepared.previousDefaultProfileOverride,
		previousDefaultProfile,
		previousPersistedDefaultProfile,
		previousActiveModelProfile: prepared.previousActiveModelProfile,
		previousDefaultChainState: prepared.previousDefaultChainState,
		previousDefaultFallbackRuntimeState: prepared.previousDefaultFallbackRuntimeState,
		restoreSessionCanonicalVariant: () =>
			restoreCanonicalVariant(prepared.modelRegistry, prepared.session.sessionId, prepared.previousCanonicalVariant),
	};
}

export async function restoreMaterializedModelProfileForDeletion(options: {
	settings: Pick<Settings, "clearOverride" | "flushOrThrow" | "override" | "set" | "unset">;
	session: Pick<
		ModelProfileActivationSession,
		"setActiveModelProfile" | "setConfiguredModelChain" | "restoreDefaultFallbackRuntimeState"
	>;
	snapshot: MaterializeModelProfileForDeletionResult;
}): Promise<void> {
	const restoreErrors: unknown[] = [];
	const restore = (action: () => void): void => {
		try {
			action();
		} catch (error) {
			restoreErrors.push(error);
		}
	};
	restore(() => options.snapshot.restoreSessionCanonicalVariant?.());
	const previousChain = options.snapshot.previousDefaultChainState;
	restore(() =>
		options.session.setConfiguredModelChain(
			"default",
			previousChain?.entries ?? [],
			previousChain?.origin ?? "rollback",
			previousChain?.identity,
			previousChain?.explicitHead ?? true,
		),
	);
	if (options.snapshot.previousDefaultFallbackRuntimeState) {
		restore(() =>
			options.session.restoreDefaultFallbackRuntimeState?.(options.snapshot.previousDefaultFallbackRuntimeState!),
		);
	}
	restore(() =>
		options.snapshot.previousPersistedModelRoles === undefined
			? options.settings.unset("modelRoles")
			: options.settings.set("modelRoles", options.snapshot.previousPersistedModelRoles),
	);
	restore(() =>
		options.snapshot.previousPersistedAgentModelOverrides === undefined
			? options.settings.unset("task.agentModelOverrides")
			: options.settings.set("task.agentModelOverrides", options.snapshot.previousPersistedAgentModelOverrides),
	);
	restore(() => options.settings.set("modelProfile.default", options.snapshot.previousPersistedDefaultProfile));
	restore(() =>
		options.snapshot.previousModelRolesOverride === undefined
			? options.settings.clearOverride("modelRoles")
			: options.settings.override("modelRoles", options.snapshot.previousModelRolesOverride),
	);
	restore(() =>
		options.snapshot.previousAgentModelOverridesOverride === undefined
			? options.settings.clearOverride("task.agentModelOverrides")
			: options.settings.override("task.agentModelOverrides", options.snapshot.previousAgentModelOverridesOverride),
	);
	restore(() =>
		options.snapshot.previousDefaultProfileOverride === undefined
			? options.settings.clearOverride("modelProfile.default")
			: options.settings.override("modelProfile.default", options.snapshot.previousDefaultProfileOverride),
	);
	restore(() => options.session.setActiveModelProfile?.(options.snapshot.previousActiveModelProfile));
	try {
		await options.settings.flushOrThrow();
	} catch (error) {
		restoreErrors.push(error);
	}
	if (restoreErrors.length > 0) {
		throw new AggregateError(restoreErrors, "Failed to fully restore materialized model profile deletion state");
	}
}

export async function activateModelProfile(
	options: PrepareModelProfileActivationOptions,
	applyOptions: ApplyModelProfileActivationOptions = {},
): Promise<void> {
	const prepared = await prepareModelProfileActivation(options);
	await applyPreparedModelProfileActivation(prepared, applyOptions);
}
