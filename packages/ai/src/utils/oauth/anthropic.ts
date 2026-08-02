/**
 * Anthropic OAuth flow (Anthropic model Pro/Max)
 */
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
/**
 * Redirect target for the paste-a-code login. Anthropic renders the
 * authorization code on this page instead of redirecting into this machine, so
 * a gjc running over SSH, in a container, or on a headless box can be paired
 * from a browser that has no route back to `localhost:54545`.
 *
 * Deliberately a hard-coded constant rather than an env/config override: this
 * is where the authorization code is delivered, so making it injectable would
 * turn any writable environment into an auth-code exfiltration channel.
 */
export const ANTHROPIC_MANUAL_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

async function postJson(url: string, body: Record<string, string | number>): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});

	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}
	return responseBody;
}

/**
 * Decoded shape of Anthropic's `/v1/oauth/token` response (both
 * `authorization_code` exchange and `refresh_token` refresh return the same
 * envelope). The `account` block is inlined alongside the tokens, so we can
 * surface `accountId` / `email` on {@link OAuthCredentials} without a separate
 * `/api/oauth/profile` round-trip.
 */
interface AnthropicTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	account?: { uuid?: string; email_address?: string };
}

function parseOAuthTokenResponse(responseBody: string, operation: string): AnthropicTokenResponse {
	try {
		return JSON.parse(responseBody) as AnthropicTokenResponse;
	} catch (error) {
		throw new Error(
			`Anthropic ${operation} returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}
}

/**
 * Lift the OAuth response's `account: { uuid, email_address }` block onto
 * {@link OAuthCredentials} so downstream identity propagation (e.g.
 * `metadata.user_id.account_uuid`, usage tracking) works without a separate
 * `/api/oauth/profile` round-trip. Returns `undefined` for either field when
 * the response omits it or carries a non-string / empty value.
 */
function extractAccountFromTokenResponse(data: AnthropicTokenResponse): {
	accountId?: string;
	email?: string;
} {
	const accountUuid = data.account?.uuid;
	const emailAddress = data.account?.email_address;
	return {
		accountId: typeof accountUuid === "string" && accountUuid.length > 0 ? accountUuid : undefined,
		email: typeof emailAddress === "string" && emailAddress.length > 0 ? emailAddress : undefined,
	};
}

export interface AnthropicOAuthFlowOptions {
	/**
	 * Pair by pasting the code Anthropic displays instead of waiting on a local
	 * `localhost:54545` callback. Use when the browser completing the login has
	 * no network route back to the machine running gjc.
	 */
	manualCode?: boolean;
}

export class AnthropicOAuthFlow extends OAuthCallbackFlow {
	#verifier: string = "";
	#challenge: string = "";
	readonly #manualCode: boolean;

	constructor(ctrl: OAuthController, options: AnthropicOAuthFlowOptions = {}) {
		const manualCode = options.manualCode === true;
		const flowOptions: OAuthCallbackFlowOptions = {
			preferredPort: CALLBACK_PORT,
			callbackPath: CALLBACK_PATH,
			redirectUri: manualCode ? ANTHROPIC_MANUAL_REDIRECT_URI : undefined,
			skipCallbackServer: manualCode,
		};
		super(ctrl, flowOptions);
		this.#manualCode = manualCode;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const pkce = await generatePKCE();
		this.#verifier = pkce.verifier;
		this.#challenge = pkce.challenge;

		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES,
			code_challenge: this.#challenge,
			code_challenge_method: "S256",
			state,
		});
		const url = `${AUTHORIZE_URL}?${authParams.toString()}`;

		return {
			url,
			instructions: this.#manualCode
				? "Complete login in your browser. Anthropic will show an authorization code — paste it here."
				: "Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted. To pair by code instead, cancel this login and run /login anthropic --manual.",
		};
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		let exchangeCode = code;
		let exchangeState = state;
		const codeFragmentIndex = code.indexOf("#");
		if (codeFragmentIndex >= 0) {
			exchangeCode = code.slice(0, codeFragmentIndex);
			const codeFragmentState = code.slice(codeFragmentIndex + 1);
			if (codeFragmentState.length > 0) {
				exchangeState = codeFragmentState;
			}
		}

		let responseBody: string;
		try {
			responseBody = await postJson(TOKEN_URL, {
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code: exchangeCode,
				state: exchangeState,
				redirect_uri: redirectUri,
				code_verifier: this.#verifier,
			});
		} catch (error) {
			throw new Error(
				`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
			);
		}

		const tokenData = parseOAuthTokenResponse(responseBody, "token exchange");
		const { accountId, email } = extractAccountFromTokenResponse(tokenData);

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			accountId,
			email,
		};
	}
}

/**
 * Login with Anthropic OAuth
 */
export async function loginAnthropic(
	ctrl: OAuthController,
	options: AnthropicOAuthFlowOptions = {},
): Promise<OAuthCredentials> {
	const flow = new AnthropicOAuthFlow(ctrl, options);
	return flow.login();
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		});
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	const data = parseOAuthTokenResponse(responseBody, "token refresh");
	const { accountId, email } = extractAccountFromTokenResponse(data);

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		accountId,
		email,
	};
}
