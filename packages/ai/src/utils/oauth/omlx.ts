/**
 * oMLX login flow.
 *
 * oMLX provides a local OpenAI-compatible API on Apple Silicon.
 * It runs unauthenticated but can be configured to require a bearer token.
 *
 * This flow stores an API-key-style credential used by `/login` and auth storage.
 */

import type { OAuthController, OAuthProvider } from "./types";

const PROVIDER_ID: OAuthProvider = "omlx";
export const DEFAULT_LOCAL_TOKEN = "omlx-local";

/**
 * Login to oMLX.
 *
 * Prompts for an optional API key,
 * and returns a stored key value.
 */
export async function loginOmlx(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error(`${PROVIDER_ID} login requires onPrompt callback`);
	}

	const apiKey = await options.onPrompt({
		message: "Optional: Paste oMLX API key (to customize endpoint URL, set OMLX_BASE_URL env var)",
		placeholder: DEFAULT_LOCAL_TOKEN,
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	return trimmed || DEFAULT_LOCAL_TOKEN;
}
