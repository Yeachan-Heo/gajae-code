import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@gajae-code/ai/core";
import {
	ModelProfileRegistryError,
	UnknownModelProfileError,
	validateModelProfileName,
} from "../config/model-profile-contract";
import type { ModelProfileDefinition } from "../config/model-profiles";
import { isAuthenticated, kNoAuth } from "../config/model-registry";

/**
 * Reserved logical provider namespace for the preset-as-model facade.
 *
 * `gajae-code/<profile>` is not a real API provider: rows under this namespace
 * exist only in the SDK Q10 projection and `model.set` selection routes to a
 * session-scoped model-profile activation transaction. The namespace is
 * reserved so a user-defined `models.yml` provider of the same name cannot
 * silently shadow the facade (see {@link syntheticNamespaceCollision}).
 */
export const SYNTHETIC_PROVIDER_ID = "gajae-code";

/**
 * Display metadata used for synthetic rows whose profile default model cannot
 * be resolved to a registered model. Mirrors the shared unknown-model
 * constants from `@gajae-code/ai`; the real model's window is authoritative.
 */
export const SYNTHETIC_UNKNOWN_CONTEXT_WINDOW = UNK_CONTEXT_WINDOW;
export const SYNTHETIC_UNKNOWN_MAX_TOKENS = UNK_MAX_TOKENS;

export function isSyntheticModelId(modelId: string): boolean {
	return modelId.startsWith(`${SYNTHETIC_PROVIDER_ID}/`);
}

export function buildSyntheticModelId(profileName: string): string {
	return `${SYNTHETIC_PROVIDER_ID}/${profileName}`;
}

/**
 * Parse a synthetic model id losslessly. Only the first namespace slash is
 * consumed; the full suffix (which may itself contain slashes or punctuation,
 * matching the configured-profile contract) is the profile id.
 */
export function parseSyntheticModelId(modelId: string): { profileName: string } | undefined {
	if (!isSyntheticModelId(modelId)) return undefined;
	const suffix = modelId.slice(SYNTHETIC_PROVIDER_ID.length + 1);
	return suffix.length > 0 ? { profileName: suffix } : undefined;
}

/** A bounded SDK `invalid_input`-coded error for the synthetic selection branch. */
export function syntheticModelInputError(message: string): Error {
	return Object.assign(new Error(message), { code: "invalid_input" });
}

export interface ResolvedSyntheticModelSelection {
	/** The raw profile suffix after the first namespace slash. */
	profileName: string;
	/** The canonical profile id (legacy aliases resolved, errors fail closed). */
	canonicalName: string;
}

/**
 * Canonicalize a synthetic model id against the merged profile registry.
 * Profile/registry failures are converted to the SDK's `invalid_input` code so
 * the ACP adapter's existing `invalid_input -> invalidParams` mapping applies.
 */
export function resolveSyntheticModelSelection(
	modelId: string,
	profiles: ReadonlyMap<string, ModelProfileDefinition>,
	registryError?: unknown,
): ResolvedSyntheticModelSelection {
	const parsed = parseSyntheticModelId(modelId);
	if (!parsed) throw syntheticModelInputError(`Model ${modelId} is not a valid synthetic profile selection.`);
	const { profileName } = parsed;
	if (registryError !== undefined)
		throw syntheticModelInputError("The model profile registry is unavailable; fix models.yml before retrying.");
	let canonicalName: string;
	try {
		canonicalName = validateModelProfileName(profileName, profiles, registryError);
	} catch (error) {
		if (error instanceof UnknownModelProfileError || error instanceof ModelProfileRegistryError)
			throw syntheticModelInputError(error.message);
		throw error;
	}
	return { profileName, canonicalName };
}

/**
 * True when a real registry entry shadows the reserved logical namespace.
 * Callers must omit synthetic rows (and reject synthetic selection) in that
 * case instead of silently shadowing or misrouting the user's provider.
 */
export function syntheticNamespaceCollision(
	models: readonly { provider: string }[],
	configuredProviderIds: readonly string[] = [],
): boolean {
	return (
		models.some(model => model.provider === SYNTHETIC_PROVIDER_ID) ||
		configuredProviderIds.includes(SYNTHETIC_PROVIDER_ID)
	);
}

/**
 * Resolve the set of providers with usable credentials across every profile's
 * strict requirements and alternative groups. This is the single availability
 * derivation shared by the Q10 synthetic facade and the Q27 profile catalog so
 * both surfaces agree; `kNoAuth` counts as available and per-provider lookup
 * failures simply exclude that provider.
 */
export async function collectAuthenticatedProfileProviders(
	profiles: ReadonlyMap<string, ModelProfileDefinition>,
	getApiKeyForProvider: (provider: string) => Promise<string | undefined>,
): Promise<ReadonlySet<string>> {
	const providers = new Set<string>();
	for (const profile of profiles.values()) {
		for (const provider of profile.requiredProviders) providers.add(provider);
		for (const group of profile.alternativeProviderGroups ?? []) {
			for (const provider of group) providers.add(provider);
		}
	}
	const authenticatedProviders = new Set<string>();
	await Promise.all(
		[...providers].map(async provider => {
			try {
				const credential = await getApiKeyForProvider(provider);
				if (credential === kNoAuth || isAuthenticated(credential)) authenticatedProviders.add(provider);
			} catch {
				// A provider whose credential state cannot be read is not currently configurable.
			}
		}),
	);
	return authenticatedProviders;
}
