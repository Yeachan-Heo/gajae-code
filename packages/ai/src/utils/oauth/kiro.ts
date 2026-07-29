/**
 * Kiro relay login flow (API key paste, validated via the relay's `/v1/models`).
 *
 * The credential is the key the self-hosted relay (`kiro-go`, `kiro2api`)
 * enforces, not the Kiro account token, so validation has to hit the relay the
 * user actually runs. Resolve the endpoint at login time from trusted env
 * (`KIRO_BASE_URL`) instead of a build-time constant.
 */
import { $credentialEnv } from "@gajae-code/utils";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthController } from "./types";

const KIRO_DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";

/** Relay models endpoint, from trusted env only. */
export function resolveKiroModelsUrl(baseUrl?: string): string {
	const configured = (baseUrl ?? $credentialEnv("KIRO_BASE_URL") ?? "").trim();
	const normalized = (configured || KIRO_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const withVersion = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
	return `${withVersion}/models`;
}

export const loginKiro = async (options: OAuthController): Promise<string> => {
	const modelsUrl = resolveKiroModelsUrl();
	return createApiKeyLogin({
		providerLabel: "Kiro",
		authUrl: "https://app.kiro.dev/settings/api-keys",
		instructions: `Paste the API key your Kiro relay enforces (validated against ${modelsUrl})`,
		promptMessage: "Paste your Kiro relay API key",
		placeholder: "ksk-... or the relay key",
		validation: {
			kind: "models-endpoint",
			provider: "Kiro",
			modelsUrl,
		},
	})(options);
};
