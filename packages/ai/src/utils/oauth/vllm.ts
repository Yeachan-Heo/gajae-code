/**
 * vLLM login flow.
 *
 * vLLM is commonly self-hosted with an OpenAI-compatible API at a local base URL.
 * Some deployments require a bearer token, others allow unauthenticated access.
 *
 * This flow stores an API-key-style credential used by `/login` and auth storage.
 */

import type { OAuthController, OAuthProvider } from "./types";

const PROVIDER_ID: OAuthProvider = "vllm";
const AUTH_URL = "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8000/v1";
/**
 * Login to vLLM.
 *
 * Opens vLLM OpenAI-compatible auth docs, prompts for a bearer token,
 * and returns a stored key value. Local no-auth servers need no login.
 */
export async function loginVllm(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error(`${PROVIDER_ID} login requires onPrompt callback`);
	}
	options.onAuth?.({
		url: AUTH_URL,
		instructions: `Paste the API key configured with vLLM's --api-key option. Local no-auth servers at ${DEFAULT_LOCAL_BASE_URL} are discovered automatically and do not need /login.`,
	});
	const apiKey = await options.onPrompt({
		message: "Paste your vLLM API key",
		placeholder: "vLLM API key",
		allowEmpty: false,
	});
	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}
	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("vLLM API key is required; local no-auth servers are discovered automatically");
	}
	return trimmed;
}
