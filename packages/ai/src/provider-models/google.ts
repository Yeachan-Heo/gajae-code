import type { ModelManagerOptions } from "../model-manager";
import { fetchAntigravityDiscoveryModels, getDefaultAntigravityUserAgent } from "../utils/discovery/antigravity";
import { fetchGeminiModels } from "../utils/discovery/gemini";

export interface GoogleModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export interface GoogleVertexModelManagerConfig {
	apiKey?: string;
}

export interface GoogleAntigravityModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
	project?: string;
}

export interface GoogleGeminiCliModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
	project?: string;
}

const CLOUD_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

export function googleModelManagerOptions(
	config?: GoogleModelManagerConfig,
): ModelManagerOptions<"google-generative-ai"> {
	const apiKey = config?.apiKey;
	return {
		providerId: "google",
		...(apiKey ? { fetchDynamicModels: () => fetchGeminiModels({ apiKey, baseUrl: config?.baseUrl }) } : undefined),
	};
}

export function googleVertexModelManagerOptions(
	_config?: GoogleVertexModelManagerConfig,
): ModelManagerOptions<"google-vertex"> {
	// Vertex AI uses Application Default Credentials (ADC) for authentication,
	// which is handled at stream time rather than during model discovery.
	// Dynamic model discovery is not yet implemented for this provider.
	return {
		providerId: "google-vertex",
	};
}

export function googleAntigravityModelManagerOptions(
	config?: GoogleAntigravityModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken;
	const ua = getDefaultAntigravityUserAgent();
	return {
		providerId: "google-antigravity",
		discoveryUserAgent: ua,
		...(token
			? {
					fetchDynamicModels: () =>
						fetchAntigravityDiscoveryModels({
							token,
							endpoint: config?.endpoint,
							project: config?.project,
							userAgent: ua,
						}),
				}
			: undefined),
	};
}

export function googleGeminiCliModelManagerOptions(
	config?: GoogleGeminiCliModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken;
	const endpoint = config?.endpoint ?? CLOUD_CODE_ASSIST_ENDPOINT;
	const ua = getDefaultAntigravityUserAgent();
	return {
		providerId: "google-gemini-cli",
		discoveryUserAgent: ua,
		...(token
			? {
					fetchDynamicModels: async () => {
						const models = await fetchAntigravityDiscoveryModels({
							token,
							endpoint,
							project: config?.project,
							targetProvider: "google-gemini-cli",
							userAgent: ua,
						});
						if (models === null) {
							return null;
						}
						return models.map(m => ({
							...m,
							provider: "google-gemini-cli" as const,
							baseUrl: endpoint,
						}));
					},
				}
			: undefined),
	};
}
