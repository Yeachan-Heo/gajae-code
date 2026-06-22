/**
 * GLM ZCode OAuth flow (UNOFFICIAL, opt-in).
 *
 * Replicates the reverse-engineered ZCode desktop-app login to Z.AI/GLM. This
 * is NOT an official Z.AI OAuth client: it reuses ZCode's authorize page,
 * broker, and a custom-protocol redirect. It may break at any time and may
 * violate ZCode/Z.AI Terms of Service. Endpoints and the client id are
 * overridable via `ZCODE_OAUTH_*` environment variables.
 *
 * Triple-hop token exchange:
 *   1. Authorize:  GET  {authorize}?redirect_uri=zcode://oauth/callback&response_type=code&client_id=...&state=...
 *                  (custom-protocol redirect → a CLI cannot catch it, so the user pastes the code/redirect URL)
 *   2. Broker:     POST {broker}        { provider: "zai", code, redirect_uri, state }
 *                       → { data: { token: <zcode JWT>, zai: { access_token: <upstream Z.AI token> } } }
 *   3. Business:   POST {zai z/login}   { token: <upstream Z.AI token> }
 *                       → { data: { access_token: <business token>, expires_in } }
 *
 * Credential mapping:
 *   - `access`  = business token (sent to GLM /v1/messages as `Authorization: Bearer`)
 *   - `refresh` = the plain upstream Z.AI access token (re-run z/login to re-mint `access`)
 * The ZCode JWT is used only transiently for identity decode at login; it is never stored.
 *
 * The business token reaches the Anthropic-messages request as a plain bearer
 * automatically (the GLM base URL is not api.anthropic.com). This provider must
 * NEVER force `isOAuth=true`, which would route GLM into the Claude-Code OAuth
 * header branch (claude-cli UA, `claude_` tool prefixes, Claude system prompt).
 */
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions, parseCallbackInput } from "./callback-server";
import type { OAuthController, OAuthCredentials } from "./types";

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
export const GLM_ZCODE_REFRESH_SKEW_MS = 2 * 60 * 1000;

/** Default endpoints / client id. Override via the matching `ZCODE_OAUTH_*` env vars. */
export const GLM_ZCODE_OAUTH_AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
export const GLM_ZCODE_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
export const GLM_ZCODE_OAUTH_REDIRECT_URI = "zcode://oauth/callback";
export const GLM_ZCODE_OAUTH_BROKER_TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
export const GLM_ZCODE_ZAI_LOGIN_URL = "https://api.z.ai/api/auth/z/login";
export const GLM_ZCODE_USERINFO_URL = "https://chat.z.ai/api/oauth/userinfo";

type FetchImpl = typeof globalThis.fetch;

function envOr(name: string, fallback: string): string {
	const value = process.env[name];
	return value && value.trim().length > 0 ? value.trim() : fallback;
}

function resolveAuthorizeUrl(): string {
	return envOr("ZCODE_OAUTH_AUTHORIZE_URL", GLM_ZCODE_OAUTH_AUTHORIZE_URL);
}
function resolveClientId(): string {
	return envOr("ZCODE_OAUTH_CLIENT_ID", GLM_ZCODE_OAUTH_CLIENT_ID);
}
function resolveRedirectUri(): string {
	return envOr("ZCODE_OAUTH_REDIRECT_URI", GLM_ZCODE_OAUTH_REDIRECT_URI);
}
function resolveBrokerTokenUrl(): string {
	return envOr("ZCODE_OAUTH_BROKER_TOKEN_URL", GLM_ZCODE_OAUTH_BROKER_TOKEN_URL);
}
function resolveZaiLoginUrl(): string {
	return envOr("ZCODE_OAUTH_ZAI_LOGIN_URL", GLM_ZCODE_ZAI_LOGIN_URL);
}
function resolveUserinfoUrl(): string {
	return envOr("ZCODE_OAUTH_USERINFO_URL", GLM_ZCODE_USERINFO_URL);
}

/**
 * The provider is configured whenever a client id is available. The real ZCode
 * client id ships as the default, so this is true unless explicitly cleared.
 */
export function isGlmZcodeOAuthConfigured(): boolean {
	return resolveClientId().length > 0;
}

/** Mask token-like substrings so broker/upstream/business tokens never leak into errors or logs. */
function redactSecrets(text: string): string {
	return text
		.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
		.replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
}

function validateHttpsEndpoint(rawUrl: string, label: string): string {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`GLM ZCode ${label} endpoint is not a valid URL`);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(`GLM ZCode ${label} endpoint must use https`);
	}
	return parsed.toString();
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function postJson(
	fetchImpl: FetchImpl,
	url: string,
	body: Record<string, unknown>,
	label: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`GLM ZCode ${label} request failed: ${response.status} ${redactSecrets(await response.text())}`);
	}
	return response.json();
}

interface JwtPayload {
	sub?: unknown;
	email?: unknown;
	account_id?: unknown;
	uid?: unknown;
	[key: string]: unknown;
}

function decodeJwtPayload(token: string): JwtPayload | undefined {
	const parts = token.split(".");
	const payload = parts[1];
	if (parts.length !== 3 || !payload) return undefined;
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtPayload;
	} catch {
		return undefined;
	}
}

interface Identity {
	email?: string;
	accountId?: string;
}

function identityFromJwts(tokens: readonly string[]): Identity {
	for (const token of tokens) {
		const payload = decodeJwtPayload(token);
		if (!payload) continue;
		const accountId =
			(typeof payload.sub === "string" && payload.sub) ||
			(typeof payload.account_id === "string" && payload.account_id) ||
			(typeof payload.uid === "string" && payload.uid) ||
			undefined;
		const email =
			typeof payload.email === "string" && payload.email.length > 0 ? payload.email.toLowerCase() : undefined;
		if (accountId || email) {
			return { accountId: accountId || undefined, email };
		}
	}
	return {};
}

async function resolveIdentity(
	fetchImpl: FetchImpl,
	upstreamZaiAccess: string,
	jwtCandidates: readonly string[],
	signal: AbortSignal | undefined,
): Promise<Identity> {
	// Best-effort userinfo; never fail login if identity lookup fails.
	try {
		const userinfoUrl = validateHttpsEndpoint(resolveUserinfoUrl(), "userinfo");
		const response = await fetchImpl(userinfoUrl, {
			headers: { Accept: "application/json", Authorization: `Bearer ${upstreamZaiAccess}` },
			signal: requestSignal(signal),
		});
		if (response.ok) {
			const payload = (await response.json()) as unknown;
			const data = isRecord(payload) && isRecord(payload.data) ? payload.data : isRecord(payload) ? payload : {};
			const email = typeof data.email === "string" && data.email.length > 0 ? data.email.toLowerCase() : undefined;
			const accountId =
				(typeof data.id === "string" && data.id) ||
				(typeof data.account_id === "string" && data.account_id) ||
				(typeof data.sub === "string" && data.sub) ||
				undefined;
			if (email || accountId) {
				return { email, accountId: accountId || undefined };
			}
		}
	} catch {
		// fall through to JWT decode
	}
	return identityFromJwts(jwtCandidates);
}

function parseBrokerResponse(payload: unknown): { zcodeToken: string; upstreamZaiAccess: string } {
	const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
	const zcodeToken = data && typeof data.token === "string" ? data.token : undefined;
	const zai = data && isRecord(data.zai) ? data.zai : undefined;
	const upstreamZaiAccess = zai && typeof zai.access_token === "string" ? zai.access_token : undefined;
	if (!zcodeToken || !upstreamZaiAccess) {
		throw new Error("GLM ZCode broker response missing data.token or data.zai.access_token");
	}
	return { zcodeToken, upstreamZaiAccess };
}

interface BusinessToken {
	access: string;
	expiresIn: number;
}

async function resolveBusinessToken(
	fetchImpl: FetchImpl,
	upstreamZaiAccess: string,
	signal: AbortSignal | undefined,
): Promise<BusinessToken> {
	const zaiLoginUrl = validateHttpsEndpoint(resolveZaiLoginUrl(), "z/login");
	const payload = await postJson(fetchImpl, zaiLoginUrl, { token: upstreamZaiAccess }, "z/login", signal);
	const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
	const access = data && typeof data.access_token === "string" ? data.access_token : undefined;
	if (!access) {
		throw new Error("GLM ZCode z/login response missing data.access_token");
	}
	const expiresIn =
		data && typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : 3600;
	return { access, expiresIn };
}

function credentialsFromBusiness(
	business: BusinessToken,
	upstreamZaiAccess: string,
	identity: Identity,
): OAuthCredentials {
	return {
		refresh: upstreamZaiAccess,
		access: business.access,
		expires: Date.now() + business.expiresIn * 1000 - GLM_ZCODE_REFRESH_SKEW_MS,
		email: identity.email,
		accountId: identity.accountId,
	};
}

async function exchangeGlmZcodeCode(
	fetchImpl: FetchImpl,
	input: { code: string; state: string; redirectUri: string },
	signal: AbortSignal | undefined,
): Promise<OAuthCredentials> {
	// Defensive: a pasted value may still be a full redirect URL or `code#state`.
	const parsed = parseCallbackInput(input.code);
	const code = parsed.code ?? input.code;
	const brokerUrl = validateHttpsEndpoint(resolveBrokerTokenUrl(), "broker");
	const brokerPayload = await postJson(
		fetchImpl,
		brokerUrl,
		{ provider: "zai", code, redirect_uri: input.redirectUri, state: input.state },
		"broker",
		signal,
	);
	const { zcodeToken, upstreamZaiAccess } = parseBrokerResponse(brokerPayload);
	const business = await resolveBusinessToken(fetchImpl, upstreamZaiAccess, signal);
	const identity = await resolveIdentity(
		fetchImpl,
		upstreamZaiAccess,
		[zcodeToken, upstreamZaiAccess, business.access],
		signal,
	);
	return credentialsFromBusiness(business, upstreamZaiAccess, identity);
}

export interface GlmZcodeOAuthFlowOptions {
	fetch?: FetchImpl;
}

export class GlmZcodeOAuthFlow extends OAuthCallbackFlow {
	#fetch: FetchImpl;

	constructor(ctrl: OAuthController, options: GlmZcodeOAuthFlowOptions = {}) {
		super(ctrl, {
			// Port 0 → a free random local port. The custom-protocol redirect
			// never reaches it; login completes via manual code/redirect paste.
			preferredPort: 0,
			callbackPath: "/callback",
			callbackHostname: "127.0.0.1",
			callbackBindHostname: "127.0.0.1",
			redirectUri: resolveRedirectUri(),
		} satisfies OAuthCallbackFlowOptions);
		this.#fetch = options.fetch ?? ctrl.fetch ?? globalThis.fetch;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const authorizeUrl = validateHttpsEndpoint(resolveAuthorizeUrl(), "authorize");
		const params = new URLSearchParams({
			redirect_uri: redirectUri,
			response_type: "code",
			client_id: resolveClientId(),
			state,
		});
		return {
			url: `${authorizeUrl}?${params.toString()}`,
			instructions:
				"Complete Z.AI login in your browser. This is an UNOFFICIAL ZCode-based login — use at your own risk; it may stop working or violate ZCode/Z.AI Terms of Service. Because this CLI cannot receive the zcode:// redirect, paste the final redirect URL or authorization code when prompted.",
		};
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		return exchangeGlmZcodeCode(this.#fetch, { code, state, redirectUri }, this.ctrl.signal);
	}
}

export async function loginGlmZcode(
	ctrl: OAuthController,
	options?: GlmZcodeOAuthFlowOptions,
): Promise<OAuthCredentials> {
	return new GlmZcodeOAuthFlow(ctrl, options).login();
}

export interface GlmZcodeRefreshOptions {
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

/**
 * Re-mint the GLM business token. ZCode exposes no documented refresh endpoint,
 * so this re-runs z/login with the stored upstream Z.AI token. If that fails the
 * caller must re-login; expired credentials are never returned as valid.
 */
export async function refreshGlmZcodeToken(
	credentials: OAuthCredentials,
	options: AbortSignal | GlmZcodeRefreshOptions = {},
): Promise<OAuthCredentials> {
	const { signal, fetch: fetchImpl } =
		options instanceof AbortSignal ? { signal: options, fetch: undefined } : options;
	const upstreamZaiAccess = credentials.refresh;
	if (!upstreamZaiAccess) {
		throw new Error(
			"glm-zcode credentials require re-login; no stored upstream Z.AI token and no documented refresh endpoint",
		);
	}
	const resolvedFetch = fetchImpl ?? globalThis.fetch;
	let business: BusinessToken;
	try {
		business = await resolveBusinessToken(resolvedFetch, upstreamZaiAccess, signal);
	} catch (error) {
		throw new Error(
			`glm-zcode credentials require re-login; re-minting via z/login failed (${redactSecrets(String(error))})`,
		);
	}
	return credentialsFromBusiness(business, upstreamZaiAccess, {
		email: credentials.email,
		accountId: credentials.accountId,
	});
}
