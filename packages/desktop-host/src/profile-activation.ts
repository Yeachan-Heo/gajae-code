import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import type { Settings } from "@gajae-code/coding-agent/config/settings";

/**
 * A session's model registry is warmed offline for speed, and an offline refresh keeps only
 * the static catalog. Providers that advertise part of their list dynamically therefore leave
 * those models missing, so a profile whose selectors name one cannot be clamped: the app
 * reported "selector did not resolve" or "executors do not match any catalog model" for a
 * profile that is perfectly valid.
 *
 * Activation is a single attempt, so the catalog is completed first: when a qualified selector
 * of the profile has no matching model, fetch the catalog once and then activate. A profile
 * that is genuinely broken still fails, with its own error, after the fetch.
 */
export function profileSelectorsMissingFromCatalog(registry: ModelRegistry, profileName: string | undefined): string[] {
	const profile = profileName ? registry.getModelProfiles()?.get(profileName) : undefined;
	if (!profile) return [];
	const catalog = new Set(registry.getAll().map(model => `${model.provider}/${model.id}`));
	const missing: string[] = [];
	for (const selector of Object.values(profile.modelMapping)) {
		for (const value of Array.isArray(selector) ? selector : [selector]) {
			if (!value.includes("/")) continue;
			// A qualified selector may carry a reasoning suffix; the catalog matches its model.
			const trimmed = value.replace(/:(minimal|low|medium|high|xhigh|max)$/i, "");
			if (!catalog.has(trimmed)) missing.push(value);
		}
	}
	return missing;
}

/**
 * The selectors a session construction will clamp: the default profile's mapping plus every
 * persisted role binding. Resuming a session applies them inside construction, so they must be
 * resolvable before the session is built -- not only afterwards.
 */
function settingsSelectorsMissingFromCatalog(registry: ModelRegistry, settings: Pick<Settings, "get">): string[] {
	const missing = profileSelectorsMissingFromCatalog(registry, settings.get("modelProfile.default"));
	const catalog = new Set(registry.getAll().map(model => `${model.provider}/${model.id}`));
	const sources: unknown[] = [settings.get("modelRoles"), settings.get("task.agentModelOverrides")];
	for (const source of sources) {
		if (!source || typeof source !== "object") continue;
		for (const selector of Object.values(source)) {
			for (const value of Array.isArray(selector) ? selector : [selector]) {
				if (typeof value !== "string" || !value.includes("/")) continue;
				const trimmed = value.replace(/:(minimal|low|medium|high|xhigh|max)$/i, "");
				if (!catalog.has(trimmed)) missing.push(value);
			}
		}
	}
	return missing;
}

/**
 * Fetch the catalog once when a session construction would clamp a selector the offline catalog
 * does not carry. Without this a resumed session fails to open at all: the failure surfaces from
 * `createAgentSession`, before any post-creation activation can repair the catalog.
 */
export async function ensureCatalogForSettings(
	registry: ModelRegistry,
	settings: Pick<Settings, "get">,
	refresh: () => Promise<void> = async () => {
		await registry.refresh("online");
	},
): Promise<boolean> {
	if (settingsSelectorsMissingFromCatalog(registry, settings).length === 0) return false;
	try {
		await refresh();
	} catch {
		// Session construction reports the real cause; a failed fetch is not one.
	}
	return true;
}

/** Fetch the catalog once when the active profile cannot be clamped against it. */
export async function ensureCatalogForProfile(
	registry: ModelRegistry,
	profileName: string | undefined,
	// A forced fetch, not `online-if-uncached`: the cached row can look fresh for a different
	// discovery context and then skip the network, which is exactly the state that left the
	// selector unresolved. This path only runs when a selector is actually missing.
	refresh: () => Promise<void> = async () => {
		await registry.refresh("online");
	},
): Promise<boolean> {
	if (!profileName || profileSelectorsMissingFromCatalog(registry, profileName).length === 0) return false;
	try {
		await refresh();
	} catch {
		// The activation that follows reports the real cause; a failed fetch is not one.
	}
	return true;
}
