// Retired from advertised catalogs because the upstream rejects live calls.
// - Cloud Code Assist: keep the callable alternatives visible
//   (gemini-3.1-pro-low:high and gemini-3.7-flash-tiered).
// - Amazon Bedrock: Fable 5.1 has no EU Geo inference profile; EU callers use
//   global.anthropic.claude-fable-5-1. See hasBedrockEuInferenceProfile.
export const RETIRED_MODEL_KEYS = [
	"amazon-bedrock/eu.anthropic.claude-fable-5-1",
	"google-antigravity/gemini-3.1-pro-high",
	"google-antigravity/gemini-3.7-flash-high",
	"google-antigravity/gemini-3.7-flash-low",
	"google-antigravity/gemini-3.7-flash-medium",
] as const;

const RETIRED_MODEL_KEY_SET = new Set<string>(RETIRED_MODEL_KEYS);

export function isRetiredModelKey(provider: string, modelId: string): boolean {
	return RETIRED_MODEL_KEY_SET.has(`${provider}/${modelId}`);
}

export function isRetiredModel(model: { provider: string; id: string }): boolean {
	return isRetiredModelKey(model.provider, model.id);
}
