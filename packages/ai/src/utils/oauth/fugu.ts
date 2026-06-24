/** Sakana Fugu login flow (API key paste against https://api.sakana.ai/v1). */
import { createApiKeyLogin } from "./api-key-login";

export const loginFugu = createApiKeyLogin({
	providerLabel: "Sakana Fugu",
	authUrl: "https://fugu.sakana.ai/",
	instructions: "Create or copy your Sakana Fugu API key",
	promptMessage: "Paste your Sakana Fugu API key",
	placeholder: "fugu_...",
	validation: {
		kind: "models-endpoint",
		provider: "Sakana Fugu",
		modelsUrl: "https://api.sakana.ai/v1/models",
	},
});
