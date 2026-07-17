// Retired from advertised catalogs because Cloud Code Assist rejects live calls
// with HTTP 400. The callable high-thinking path is gemini-3.1-pro-low:high.
export const RETIRED_MODEL_KEYS = ["google-antigravity/gemini-3.1-pro-high"] as const;

const RETIRED_MODEL_KEY_SET = new Set<string>(RETIRED_MODEL_KEYS);

export function isRetiredModelKey(provider: string, modelId: string): boolean {
	return RETIRED_MODEL_KEY_SET.has(`${provider}/${modelId}`);
}

export function isRetiredModel(model: { provider: string; id: string }): boolean {
	return isRetiredModelKey(model.provider, model.id);
}
