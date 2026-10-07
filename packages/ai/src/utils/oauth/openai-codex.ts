/**
 * OpenAI code provider (ChatGPT OAuth) flow — browser and device-code flows.
 */

import { OPENAI_HEADER_VALUES } from "../../providers/openai-codex/constants";
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_POLL_INTERVAL_MS = 5_000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
/** Upper bound on device-code polling to avoid infinite loops on server errors. */
const DEVICE_MAX_POLLS = 120;

type JwtPayload = {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
	};
	[JWT_PROFILE_CLAIM]?: {
		email?: string;
	};
	[key: string]: unknown;
};

export function decodeJwt<T = Record<string, unknown>>(token: string): T | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = Buffer.from(payload, "base64").toString("utf-8");
		return JSON.parse(decoded) as T;
	} catch {
		return null;
	}
}

function getTokenProfile(accessToken: string): { accountId?: string; email?: string } {
	const payload = decodeJwt<JwtPayload>(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	const email = payload?.[JWT_PROFILE_CLAIM]?.email?.trim().toLowerCase();
	return {
		accountId: typeof accountId === "string" && accountId.length > 0 ? accountId : undefined,
		email: typeof email === "string" && email.length > 0 ? email : undefined,
	};
}

interface PKCE {
	verifier: string;
	challenge: string;
}

class OpenAICodexOAuthFlow extends OAuthCallbackFlow {
	constructor(
		ctrl: OAuthController,
		private readonly pkce: PKCE,
		private readonly originator: string,
	) {
		super(ctrl, {
			preferredPort: CALLBACK_PORT,
			callbackPath: CALLBACK_PATH,
			// Enforce the fixed port: OpenAI only allows http://localhost:1455/auth/callback.
			// Without this, a busy port 1455 falls back to a random port, and the token
			// exchange would fail with 403 because the redirect_uri no longer matches the
			// registered allowlist entry.
			redirectUri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
		} satisfies OAuthCallbackFlowOptions);
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const searchParams = new URLSearchParams({
			response_type: "code",
			client_id: CLIENT_ID,
			redirect_uri: redirectUri,
			scope: SCOPE,
			code_challenge: this.pkce.challenge,
			code_challenge_method: "S256",
			state,
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
			originator: this.originator,
		});

		const url = `${AUTHORIZE_URL}?${searchParams.toString()}`;
		return { url, instructions: "A browser window should open. Complete login to finish." };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		return exchangeCodeForToken(code, this.pkce.verifier, redirectUri);
	}
}

async function exchangeCodeForToken(code: string, verifier: string, redirectUri: string): Promise<OAuthCredentials> {
	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!tokenResponse.ok) {
		let detail = `${tokenResponse.status}`;
		try {
			const body = (await tokenResponse.json()) as { error?: string; error_description?: string };
			if (body.error)
				detail = `${tokenResponse.status} ${body.error}${body.error_description ? `: ${body.error_description}` : ""}`;
		} catch {}
		throw new Error(`Token exchange failed: ${detail}`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!tokenData.access_token || !tokenData.refresh_token || typeof tokenData.expires_in !== "number") {
		throw new Error("Token response missing required fields");
	}

	const { accountId, email } = getTokenProfile(tokenData.access_token);
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}

	return {
		access: tokenData.access_token,
		refresh: tokenData.refresh_token,
		expires: Date.now() + tokenData.expires_in * 1000,
		accountId,
		email,
	};
}

/**
 * Login with OpenAI code provider OAuth
 */
export type OpenAICodexLoginOptions = OAuthController & {
	/** Optional originator value for OpenAI code provider OAuth. Default: codex_cli_rs. */
	originator?: string;
};

export async function loginOpenAICodex(options: OpenAICodexLoginOptions): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const originator = options.originator?.trim() || OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
	const flow = new OpenAICodexOAuthFlow(options, pkce, originator);

	return flow.login();
}

/**
 * Login with OpenAI code provider using the device-code (headless) flow.
 *
 * Avoids a local callback server entirely — useful when port 1455 is unavailable
 * or when the browser callback flow fails with 403 (e.g. network/proxy issues).
 */
export async function loginOpenAICodexDevice(ctrl: OAuthController): Promise<OAuthCredentials> {
	ctrl.onProgress?.("Initiating device authorization…");

	const initResponse = await fetch(DEVICE_USERCODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!initResponse.ok) {
		throw new Error(`Device authorization initiation failed: ${initResponse.status}`);
	}

	const initData = (await initResponse.json()) as {
		device_auth_id?: string;
		user_code?: string;
		interval?: string | number;
	};

	if (!initData.device_auth_id || !initData.user_code) {
		throw new Error("Device authorization response missing required fields");
	}

	const userCode = initData.user_code;
	const pollIntervalMs =
		(typeof initData.interval === "number"
			? initData.interval
			: parseInt(String(initData.interval ?? "5"), 10) || 5) *
			1000 +
		DEVICE_POLL_SAFETY_MARGIN_MS;

	ctrl.onAuth?.({
		url: DEVICE_AUTH_URL,
		instructions: `Enter code: ${userCode}`,
	});

	ctrl.onProgress?.(`Waiting for browser authorization (code: ${userCode})…`);

	for (let poll = 0; poll < DEVICE_MAX_POLLS; poll++) {
		await Bun.sleep(poll === 0 ? Math.min(pollIntervalMs, DEVICE_POLL_INTERVAL_MS) : pollIntervalMs);

		if (ctrl.signal?.aborted) {
			throw new Error("Device authorization cancelled");
		}

		const pollResponse = await fetch(DEVICE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				device_auth_id: initData.device_auth_id,
				user_code: userCode,
			}),
			signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
		});

		// 403/404 = authorization pending, keep polling
		if (pollResponse.status === 403 || pollResponse.status === 404) {
			continue;
		}

		if (!pollResponse.ok) {
			throw new Error(`Device token polling failed: ${pollResponse.status}`);
		}

		const pollData = (await pollResponse.json()) as {
			authorization_code?: string;
			code_verifier?: string;
		};

		if (!pollData.authorization_code || !pollData.code_verifier) {
			throw new Error("Device token response missing authorization_code or code_verifier");
		}

		ctrl.onProgress?.("Exchanging authorization code for tokens…");
		return exchangeCodeForToken(pollData.authorization_code, pollData.code_verifier, DEVICE_REDIRECT_URI);
	}

	throw new Error("Device authorization timed out — user did not complete login in time");
}

/**
 * Refresh OpenAI code provider OAuth token
 */
export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		let detail = `${response.status}`;
		try {
			const body = (await response.json()) as { error?: string; error_description?: string };
			if (body.error)
				detail = `${response.status} ${body.error}${body.error_description ? `: ${body.error_description}` : ""}`;
		} catch {}
		throw new Error(`OpenAI Codex token refresh failed: ${detail}`);
	}

	const tokenData = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!tokenData.access_token || !tokenData.refresh_token || typeof tokenData.expires_in !== "number") {
		throw new Error("Token response missing required fields");
	}

	const { accountId, email } = getTokenProfile(tokenData.access_token);

	return {
		access: tokenData.access_token,
		refresh: tokenData.refresh_token || refreshToken,
		expires: Date.now() + tokenData.expires_in * 1000,
		accountId: accountId ?? undefined,
		email,
	};
}
