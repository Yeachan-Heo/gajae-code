/** OpenGateway (by Sionic AI) login flow (API key paste, validated via /v1/models). */
import { createApiKeyLogin } from "./api-key-login";

export const loginOpenGateway = createApiKeyLogin({
	providerLabel: "OpenGateway by Sionic AI",
	authUrl: "https://opengateway.ai/dashboard",
	instructions: "Create or copy your OpenGateway API key",
	promptMessage: "Paste your OpenGateway API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "OpenGateway by Sionic AI",
		modelsUrl: "https://apis.opengateway.ai/v1/models",
	},
});
