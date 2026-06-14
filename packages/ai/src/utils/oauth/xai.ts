/** xAI OAuth flow (Grok account login). */
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_CALLBACK_PORT = 56121;
const XAI_OAUTH_CALLBACK_PATH = "/callback";
const XAI_OAUTH_REFRESH_SKEW_MS = 2 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

interface XaiDiscovery {
	authorizationEndpoint: string;
	tokenEndpoint: string;
}

interface XaiDiscoveryPayload {
	authorization_endpoint?: unknown;
	token_endpoint?: unknown;
}

interface XaiTokenPayload {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	id_token?: unknown;
	token_type?: unknown;
}

export interface XaiOAuthFlowOptions {
	extraAuthorizeParams?: Readonly<Record<string, string>>;
}

export interface XaiOAuthRefreshOptions {
	signal?: AbortSignal;
	extraTokenParams?: Readonly<Record<string, string>>;
}

interface XaiJwtPayload {
	sub?: unknown;
	email?: unknown;
	[key: string]: unknown;
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function addNonOverridingParams(
	target: URLSearchParams | Record<string, string>,
	params: Readonly<Record<string, string>>,
): void {
	for (const [key, value] of Object.entries(params)) {
		if (key.length === 0 || value.length === 0) continue;
		if (target instanceof URLSearchParams) {
			if (!target.has(key)) target.set(key, value);
		} else if (!(key in target)) {
			target[key] = value;
		}
	}
}

function isAbortSignal(value: AbortSignal | XaiOAuthRefreshOptions | undefined): value is AbortSignal {
	return value instanceof AbortSignal;
}

function resolveRefreshOptions(options: AbortSignal | XaiOAuthRefreshOptions | undefined): XaiOAuthRefreshOptions {
	return isAbortSignal(options) ? { signal: options } : (options ?? {});
}

function validateXaiEndpoint(rawUrl: string): string {
	const parsed = new URL(rawUrl);
	const host = parsed.hostname.toLowerCase();
	if (parsed.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new Error(`xAI OAuth discovery returned an unexpected endpoint: ${rawUrl}`);
	}
	return parsed.toString();
}

export async function discoverXaiOAuthEndpoints(signal?: AbortSignal): Promise<XaiDiscovery> {
	const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
		headers: { Accept: "application/json" },
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`xAI OAuth discovery failed: ${response.status} ${await response.text()}`);
	}

	const payload = (await response.json()) as XaiDiscoveryPayload;
	if (typeof payload.authorization_endpoint !== "string" || typeof payload.token_endpoint !== "string") {
		throw new Error("xAI OAuth discovery response missing authorization/token endpoints");
	}

	return {
		authorizationEndpoint: validateXaiEndpoint(payload.authorization_endpoint),
		tokenEndpoint: validateXaiEndpoint(payload.token_endpoint),
	};
}

function decodeJwtPayload(token: string): XaiJwtPayload | undefined {
	const parts = token.split(".");
	const payload = parts[1];
	if (parts.length !== 3 || !payload) return undefined;
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as XaiJwtPayload;
	} catch {
		return undefined;
	}
}

function getTokenIdentity(accessToken: string, idToken: string | undefined): { accountId?: string; email?: string } {
	const payload = (idToken ? decodeJwtPayload(idToken) : undefined) ?? decodeJwtPayload(accessToken);
	const accountId = typeof payload?.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
	const email =
		typeof payload?.email === "string" && payload.email.length > 0 ? payload.email.toLowerCase() : undefined;
	return { accountId, email };
}

async function postXaiToken(
	tokenEndpoint: string,
	body: Record<string, string>,
	signal?: AbortSignal,
): Promise<XaiTokenPayload> {
	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(body).toString(),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`xAI token request failed: ${response.status} ${await response.text()}`);
	}
	return (await response.json()) as XaiTokenPayload;
}

function credentialsFromTokenPayload(payload: XaiTokenPayload, refreshFallback = ""): OAuthCredentials {
	if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
		throw new Error("xAI token response did not include an access token");
	}
	const refresh =
		typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
			? payload.refresh_token
			: refreshFallback;
	if (!refresh) {
		throw new Error("xAI token response did not include a refresh token");
	}
	const expiresIn =
		typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
	const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
	const { accountId, email } = getTokenIdentity(payload.access_token, idToken);
	return {
		refresh,
		access: payload.access_token,
		expires: Date.now() + expiresIn * 1000 - XAI_OAUTH_REFRESH_SKEW_MS,
		accountId,
		email,
	};
}

export class XaiOAuthFlow extends OAuthCallbackFlow {
	#verifier = "";
	#discovery: XaiDiscovery | undefined;
	#extraAuthorizeParams: Readonly<Record<string, string>>;

	constructor(ctrl: OAuthController, options: XaiOAuthFlowOptions = {}) {
		super(ctrl, {
			preferredPort: XAI_OAUTH_CALLBACK_PORT,
			callbackPath: XAI_OAUTH_CALLBACK_PATH,
			callbackHostname: "127.0.0.1",
			callbackBindHostname: "127.0.0.1",
			redirectUri: `http://127.0.0.1:${XAI_OAUTH_CALLBACK_PORT}${XAI_OAUTH_CALLBACK_PATH}`,
		} satisfies OAuthCallbackFlowOptions);
		this.#extraAuthorizeParams = options.extraAuthorizeParams ?? {};
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const pkce = await generatePKCE();
		this.#verifier = pkce.verifier;
		this.#discovery = await discoverXaiOAuthEndpoints(this.ctrl.signal);
		const params = new URLSearchParams({
			response_type: "code",
			client_id: XAI_OAUTH_CLIENT_ID,
			redirect_uri: redirectUri,
			scope: XAI_OAUTH_SCOPE,
			code_challenge: pkce.challenge,
			code_challenge_method: "S256",
			state,
			nonce: crypto.randomUUID(),
		});
		addNonOverridingParams(params, this.#extraAuthorizeParams);
		return {
			url: `${this.#discovery.authorizationEndpoint}?${params.toString()}`,
			instructions:
				"Complete xAI/Grok login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
		};
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		if (!this.#verifier) {
			throw new Error("xAI OAuth PKCE verifier was not initialized");
		}
		const discovery = this.#discovery ?? (await discoverXaiOAuthEndpoints(this.ctrl.signal));
		const tokenPayload = await postXaiToken(
			discovery.tokenEndpoint,
			{
				grant_type: "authorization_code",
				client_id: XAI_OAUTH_CLIENT_ID,
				code,
				redirect_uri: redirectUri,
				code_verifier: this.#verifier,
			},
			this.ctrl.signal,
		);
		return credentialsFromTokenPayload(tokenPayload);
	}
}

export async function loginXai(ctrl: OAuthController, options?: XaiOAuthFlowOptions): Promise<OAuthCredentials> {
	return new XaiOAuthFlow(ctrl, options).login();
}

export async function refreshXaiToken(
	refreshToken: string,
	options?: AbortSignal | XaiOAuthRefreshOptions,
): Promise<OAuthCredentials> {
	if (!refreshToken) {
		throw new Error("xAI credentials are expired and do not include a refresh token");
	}
	const { signal, extraTokenParams = {} } = resolveRefreshOptions(options);
	const discovery = await discoverXaiOAuthEndpoints(signal);
	const body = {
		grant_type: "refresh_token",
		client_id: XAI_OAUTH_CLIENT_ID,
		refresh_token: refreshToken,
	};
	addNonOverridingParams(body, extraTokenParams);
	const tokenPayload = await postXaiToken(discovery.tokenEndpoint, body, signal);
	return credentialsFromTokenPayload(tokenPayload, refreshToken);
}
