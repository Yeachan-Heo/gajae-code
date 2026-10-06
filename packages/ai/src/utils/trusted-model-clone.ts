import { registerTrustedModelCloneInternal } from "../adapter-internals/provider-safety-stop";
import type { Api, Model } from "../types";

/**
 * Create a trusted clone of a model with its baseUrl stripped of userinfo, query, and hash.
 * Internally registers the clone as trusted if the original is in the trusted catalog.
 * Returns the original model if baseUrl stripping is not needed or fails.
 *
 * This is the preferred public interface for creating trusted model clones.
 * Mutations to the returned clone's api, provider, id, or baseUrl will cause it to become untrusted.
 */
export function createTrustedStrippedModelClone(model: Model<Api>): Model<Api> {
	if (!model.baseUrl) return model;
	try {
		const parsed = new URL(model.baseUrl);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		const clone = { ...model, baseUrl: parsed.toString().replace(/\/$/, "") };
		registerTrustedModelCloneInternal(model, clone);
		return clone;
	} catch {
		// URL parsing failed; return a clone without baseUrl
		const { baseUrl: _baseUrl, ...withoutBaseUrl } = model;
		const clone = withoutBaseUrl as Model<Api>;
		registerTrustedModelCloneInternal(model, clone);
		return clone;
	}
}

/**
 * Register a finalized clone as trusted when the original model is trusted.
 * The clone's api, provider, and id must match the original exactly.
 * This should be called when a model is cloned during finalization (e.g., through merges or context cap processing).
 * If the original is not trusted, this has no effect.
 */
export function registerFinalizedModelClone(original: Model<Api>, clone: Model<Api>): void {
	registerTrustedModelCloneInternal(original, clone);
}
