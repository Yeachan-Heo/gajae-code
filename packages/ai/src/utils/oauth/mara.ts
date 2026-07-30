/** Mara Cloud login flow (API key paste, validated via /v1/models). */
import { createApiKeyLogin } from "./api-key-login";

export const loginMara = createApiKeyLogin({
	providerLabel: "Mara Cloud",
	authUrl: "https://cloud.mara.com/apis",
	instructions: "Create or copy your Mara Cloud API key",
	promptMessage: "Paste your Mara Cloud API key",
	placeholder: "<your-mara-api-key>",
	validation: {
		kind: "models-endpoint",
		provider: "Mara Cloud",
		modelsUrl: "https://api.cloud.mara.com/v1/models",
	},
});
