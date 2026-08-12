/** Synthetic login flow (API key paste against https://api.synthetic.new/openai/v1). */
import { createApiKeyLogin } from "./api-key-login";

export const loginSynthetic = createApiKeyLogin({
	providerLabel: "Synthetic",
	authUrl: "https://dev.synthetic.new/docs/api/overview",
	instructions: "Copy your API key from the Synthetic dashboard",
	promptMessage: "Paste your Synthetic API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "Synthetic",
		modelsUrl: "https://api.synthetic.new/openai/v1/models",
	},
});
