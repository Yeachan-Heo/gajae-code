import { registerTrustedModelCloneInternal } from "../adapter-internals/provider-safety-stop";
import type { Api, Model } from "../types";

/**
 * Create a trusted clone of a model with its baseUrl stripped of userinfo, query, and hash.
 * If the original is in the trusted catalog, builds a fresh clone with the same identity
 * (but stripped baseUrl) and registers it as trusted.
 * Otherwise returns the original unchanged.
 *
 * This is the preferred public interface for creating trusted model clones.
 */
export function createTrustedStrippedModelClone(model: Model<Api>): Model<Api> {
	// First, build the stripped clone
	const stripped = model.baseUrl
		? (() => {
				try {
					const parsed = new URL(model.baseUrl);
					parsed.username = "";
					parsed.password = "";
					parsed.search = "";
					parsed.hash = "";
					return { ...model, baseUrl: parsed.toString().replace(/\/$/, "") };
				} catch {
					// URL parsing failed; return a clone without baseUrl
					const { baseUrl: _baseUrl, ...withoutBaseUrl } = model;
					return withoutBaseUrl as Model<Api>;
				}
			})()
		: model;

	// Now register the stripped model if the original is trusted
	const registered = registerTrustedModelCloneInternal(model, stripped);
	return registered ? (registered as Model<Api>) : stripped;
}

/**
 * Register a finalized clone as trusted when the original model is trusted.
 * Validates the clone's identity fields in a single read, then builds a fresh object
 * from the original's trusted identity and merges it with the clone's other fields.
 * The final object is registered as trusted.
 *
 * Returns a new object with the trusted identity fields if the original is trusted,
 * or undefined if the original is not trusted. The caller must use the returned object
 * instead of the clone parameter.
 */
export function registerFinalizedModelClone(original: Model<Api>, clone?: Model<Api>): Model<Api> | undefined {
	const registered = registerTrustedModelCloneInternal(original, clone);
	return registered ? (registered as Model<Api>) : undefined;
}
