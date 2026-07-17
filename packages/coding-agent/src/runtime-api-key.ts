export interface RuntimeApiKeyTarget {
	setRuntimeApiKey(provider: string, apiKey: string): void;
}

export interface RuntimeApiKeyModel {
	provider: string;
}

export function applyCliRuntimeApiKeyOverride(
	target: RuntimeApiKeyTarget,
	apiKey: string | undefined,
	model: RuntimeApiKeyModel | undefined,
): void {
	if (!apiKey || !model) return;
	target.setRuntimeApiKey(model.provider, apiKey);
}
