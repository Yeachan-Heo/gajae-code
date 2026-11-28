/**
 * Whether a model profile can be selected right now, decided once for every surface that lists
 * profiles: the managed `models.profiles.list` / `models.list` queries and the in-process
 * `SdkPreferenceControls.readProfiles()` read. A profile is available only when its providers
 * are authenticated (directly, through an alternative, or through a configured proxy) and its
 * mapped models resolve the way activation would resolve them.
 */
import type { Api, Model } from "@gajae-code/ai/core";
import {
	getProxyRoutableProviders,
	inspectProxyProviderId,
	isModelProfileProxyConfigured,
	requiresQualifiedModelProfileRoleResolution,
	resolveProxyMode,
	rewriteSelectorForProxy,
	tryResolveProxyProviderId,
} from "./model-profile-activation";
import { isModelProfileProviderAvailable } from "./model-profile-contract";
import {
	deriveModelProfileMappedProviders,
	type ModelProfileDefinition,
	resolveProfileBindings,
} from "./model-profiles";
import { isAuthenticated, kNoAuth, type ModelRegistry } from "./model-registry";
import { resolveModelChainWithAuth, splitSelectorThinkingSuffix } from "./model-resolver";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "./model-selector-value";
import type { Settings } from "./settings";

export interface ModelProfileAvailabilityContext {
	registry: ModelRegistry;
	/** Settings that name the proxy provider and proxy mode. */
	settings: Pick<Settings, "get"> | undefined;
	/** Settings whose model-usage preferences apply to chain resolution. */
	resolutionSettings: Settings | undefined;
	/** The session whose credentials decide authentication. */
	credentialSessionId: string;
	/**
	 * How a provider's credential is looked up. Without it, availability resolves the credential
	 * through `registry.getApiKeyForProvider`, as the managed profile list does: that may refresh
	 * OAuth tokens and records the session's credential choice. Pass
	 * `createPassiveModelProfileCredentials` for a read that must leave credential state alone.
	 */
	credentials?: ModelProfileCredentialLookup;
}

/** A provider's key, `kNoAuth` for a provider that needs none, or undefined when it has no credential. */
export type ModelProfileCredentialLookup = (
	provider: string,
	sessionId: string | undefined,
	baseUrl?: string,
) => Promise<string | undefined>;

/**
 * Stands in for a credential that exists and is usable but was not resolved. Availability only
 * tests it; it is never sent to a provider.
 */
const PASSIVE_CREDENTIAL_PRESENT = "passive-credential-present";

/**
 * A lookup that asks only whether a usable credential exists (`hasUsableAuthForProvider`, or a
 * provider that needs none). It resolves no key, refreshes no OAuth token, ranks no accounts and
 * records no session credential choice, so reading availability never changes which credential a
 * later request uses. An expired OAuth login whose refresh would fail still counts as present.
 */
export function createPassiveModelProfileCredentials(registry: ModelRegistry): ModelProfileCredentialLookup {
	return async (provider, sessionId) => {
		if (registry.isCredentiallessProvider(provider)) return kNoAuth;
		return registry.hasUsableAuthForProvider(provider, sessionId) ? PASSIVE_CREDENTIAL_PRESENT : undefined;
	};
}

function credentialLookup(context: ModelProfileAvailabilityContext): ModelProfileCredentialLookup {
	return (
		context.credentials ??
		((provider, sessionId, baseUrl) => context.registry.getApiKeyForProvider(provider, sessionId, baseUrl))
	);
}

export interface ModelProfileAvailability {
	available: boolean;
	/** The model the profile's default mapping resolves to, when it has one. */
	defaultModel?: Model<Api>;
}

export async function resolveModelProfileAvailability(
	context: ModelProfileAvailabilityContext,
	profile: ModelProfileDefinition,
	authenticatedProviders: ReadonlySet<string>,
): Promise<ModelProfileAvailability> {
	if (profile.source !== "user" && inspectProxyProviderId(context.settings).status === "invalid")
		return { available: false };
	const proxyProvider = profile.source === "user" ? undefined : tryResolveProxyProviderId(context.settings);
	const proxyAuthenticated = proxyProvider !== undefined && authenticatedProviders.has(proxyProvider);
	const profileAuthenticated = new Set(authenticatedProviders);
	if (proxyAuthenticated) {
		for (const provider of getProxyRoutableProviders(profile)) profileAuthenticated.add(provider);
	}
	const rewriteSelectorProvider = (selector: string): string => {
		const slash = selector.indexOf("/");
		if (slash < 0) return selector;
		const provider = selector.slice(0, slash);
		if (profileAuthenticated.has(provider)) return selector;
		const group = (profile.alternativeProviderGroups ?? []).find(candidates => candidates.includes(provider));
		if (!group) return selector;
		const replacement = group.find(candidate => profileAuthenticated.has(candidate));
		return replacement ? replacement + selector.slice(slash) : selector;
	};
	try {
		const proxyMode = profile.source === "user" ? "fallback" : resolveProxyMode(context.settings);
		if (proxyProvider !== undefined) {
			const configuredProviders = context.registry.getConfiguredProviderIds?.();
			const credentialless =
				proxyProvider === "opencodex" &&
				!configuredProviders?.includes(proxyProvider) &&
				(await credentialLookup(context)(proxyProvider, context.credentialSessionId)) === kNoAuth;
			if (!isModelProfileProxyConfigured(proxyProvider, configuredProviders, credentialless))
				return { available: false };
		}
		if (profile.source !== "user" && proxyMode === "always") {
			if (proxyProvider === undefined || !proxyAuthenticated) return { available: false };
		}
		const bindings = resolveProfileBindings(profile);
		const assignments: Array<{ value: ModelSelectorValue; isDefault: boolean }> = [];
		if (bindings.defaultSelector !== undefined) {
			assignments.push({ value: bindings.defaultSelector, isDefault: true });
		}
		for (const value of Object.values(bindings.modelRoles)) assignments.push({ value, isDefault: false });
		for (const value of Object.values(bindings.agentModelOverrides)) assignments.push({ value, isDefault: false });
		const availableModels = context.registry.getAvailable(context.credentialSessionId);
		const resolutionRegistry = {
			...context.registry,
			getAvailable: () => availableModels,
			getApiKey: (model: Model<Api>, sessionId?: string) =>
				credentialLookup(context)(model.provider, sessionId, model.baseUrl),
			resolveCanonicalModel: context.registry.resolveCanonicalModel?.bind(context.registry),
			getCanonicalVariants: context.registry.getCanonicalVariants?.bind(context.registry),
			getCanonicalId: context.registry.getCanonicalId?.bind(context.registry),
			resolveModelByLookupAlias: context.registry.resolveModelByLookupAlias?.bind(context.registry),
			lookupAliasExists: context.registry.lookupAliasExists?.bind(context.registry),
			clearCanonicalVariant: context.registry.clearCanonicalVariant?.bind(context.registry),
			isSelectorCircuitOpen: (selector: string, probeOwner?: string) =>
				context.registry.isSelectorCircuitOpen?.call(context.registry, selector, probeOwner) ?? false,
		};
		let defaultModel: Model<Api> | undefined;
		for (const assignment of assignments) {
			let selectors = normalizeModelSelectorValue(assignment.value).map(rewriteSelectorProvider);
			if (proxyProvider !== undefined && proxyAuthenticated && profile.source !== "user") {
				selectors = selectors.map(selector =>
					rewriteSelectorForProxy(
						selector,
						proxyProvider,
						proxyMode,
						availableModels,
						new Set(authenticatedProviders),
						getProxyRoutableProviders(profile),
					),
				);
			}
			const hasBareSelector = selectors.some(selector => {
				const suffix = splitSelectorThinkingSuffix(selector);
				const identity = suffix.thinkingLevel ? suffix.selector : selector;
				return !identity.includes("/");
			});
			if (!assignment.isDefault && !requiresQualifiedModelProfileRoleResolution(profile) && !hasBareSelector)
				continue;
			const resolution = await resolveModelChainWithAuth(
				selectors,
				resolutionRegistry,
				context.resolutionSettings,
				context.credentialSessionId,
				{
					managedFallback: true,
					aliasIntent: "preset-equivalent",
					canonicalSessionId: null,
					credentialSessionId: context.credentialSessionId,
				},
			);
			if (!resolution.model) return { available: false };
			if (assignment.isDefault) defaultModel = resolution.model;
		}
		return { available: true, defaultModel };
	} catch {
		return { available: false };
	}
}

export async function collectModelProfileAuthentication(
	context: ModelProfileAvailabilityContext,
	profiles: ReadonlyMap<string, ModelProfileDefinition>,
): Promise<Set<string>> {
	const providers = new Set<string>();
	for (const profile of profiles.values()) {
		for (const provider of profile.requiredProviders) providers.add(provider);
		for (const group of profile.alternativeProviderGroups ?? []) {
			for (const provider of group) providers.add(provider);
		}
		for (const provider of deriveModelProfileMappedProviders(profile)) providers.add(provider);
	}
	const authenticated = new Set<string>();
	await Promise.all(
		[...providers].map(async provider => {
			try {
				const apiKey = await credentialLookup(context)(provider, context.credentialSessionId);
				if (apiKey === kNoAuth || isAuthenticated(apiKey)) authenticated.add(provider);
			} catch {
				// A provider whose credential state cannot be read is not currently configurable.
			}
		}),
	);
	const proxyProviders = new Set<string>();
	for (const profile of profiles.values()) {
		if (profile.source === "user") continue;
		const proxyProvider = tryResolveProxyProviderId(context.settings);
		if (proxyProvider !== undefined) proxyProviders.add(proxyProvider);
	}
	for (const proxyProvider of proxyProviders) {
		try {
			const apiKey = await credentialLookup(context)(proxyProvider, context.credentialSessionId);
			if (apiKey === kNoAuth || isAuthenticated(apiKey)) authenticated.add(proxyProvider);
		} catch {
			// Passive availability must degrade to unavailable when proxy credential
			// refresh/storage fails; explicit activation retains its diagnostics.
		}
	}
	return authenticated;
}

/** The availability a profile catalog reports: provider requirements met and mappings resolvable. */
export async function isModelProfileSelectable(
	context: ModelProfileAvailabilityContext,
	profile: ModelProfileDefinition,
	authenticatedProviders: ReadonlySet<string>,
): Promise<boolean> {
	const profileAuthenticated = new Set(authenticatedProviders);
	const proxyProvider = profile.source === "user" ? undefined : tryResolveProxyProviderId(context.settings);
	if (proxyProvider !== undefined && profileAuthenticated.has(proxyProvider))
		for (const provider of getProxyRoutableProviders(profile)) profileAuthenticated.add(provider);
	return (
		isModelProfileProviderAvailable(profile, profileAuthenticated) &&
		(await resolveModelProfileAvailability(context, profile, authenticatedProviders)).available
	);
}
