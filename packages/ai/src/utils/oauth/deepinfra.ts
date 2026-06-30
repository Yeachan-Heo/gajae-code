/** DeepInfra login flow (API key paste against https://api.deepinfra.com/v1/openai). */
import { createApiKeyLogin } from "./api-key-login";

export const loginDeepInfra = createApiKeyLogin({
	providerLabel: "DeepInfra",
	authUrl: "https://deepinfra.com/dash/api_keys",
	instructions: "Create or copy your DeepInfra API key from the DeepInfra dashboard",
	promptMessage: "Paste your DeepInfra API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "DeepInfra",
		modelsUrl: "https://api.deepinfra.com/v1/openai/models",
	},
});
