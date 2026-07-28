import type { ModelManagerOptions } from "../model-manager";
import { KIRO_RUNTIME_URL, parseKiroAccessContext } from "../providers/kiro";
import type { Model } from "../types";
import { fetchKiroModels } from "../utils/discovery/kiro";

/** Kiro is text-only; placeholder limits and token costs match discovery fallbacks. */
const KIRO_STATIC_FIELDS = Object.freeze({
	api: "kiro-streaming" as const,
	provider: "kiro" as const,
	baseUrl: KIRO_RUNTIME_URL,
	reasoning: true,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});

const KIRO_STATIC_IDS = ["claude-opus-5", "claude-sonnet-5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;

export const KIRO_STATIC_SEED: readonly Model<"kiro-streaming">[] = KIRO_STATIC_IDS.map(id => ({
	id,
	name: id,
	...KIRO_STATIC_FIELDS,
}));

export function kiroModelManagerOptions(config: { apiKey?: string }): ModelManagerOptions<"kiro-streaming"> {
	const access = config.apiKey ? parseKiroAccessContext(config.apiKey) : undefined;
	return {
		providerId: "kiro",
		staticModels: [...KIRO_STATIC_SEED],
		// A credential-supplied ARN is server-confirmed and authoritative.
		...(access
			? {
					fetchDynamicModels: () =>
						fetchKiroModels({
							accessToken: access.token,
							profileArn: access.profileArn,
						}),
				}
			: undefined),
	};
}
