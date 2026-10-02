/**
 * GLM ZCode OAuth flow (UNOFFICIAL, opt-in).
 *
 * Replicates how the ZCode desktop app turns a Z.AI login into usable GLM model
 * access. This is NOT an official Z.AI OAuth client: it reuses ZCode's authorize
 * page, broker, and a custom-protocol redirect. It may break at any time and may
 * violate ZCode/Z.AI Terms of Service. Endpoints/client id are overridable via
 * `ZCODE_OAUTH_*` environment variables.
 *
 * Verified end-to-end against the ZCode host bundle (`resolveZaiApiKey` /
 * `resolveBizApiKey`) and live traffic:
 *   1. Authorize: GET {authorize}?redirect_uri=zcode://oauth/callback&response_type=code&client_id=...&state=...
 *      (custom-protocol redirect → a CLI cannot catch it, so the user pastes the code/redirect URL)
 *   2. Broker:    POST {broker} { provider:"zai", code, redirect_uri, state }
 *                  → { data: { token: <ZCode JWT>, zai: { access_token: <upstream Z.AI token> } } }
 *   3. Business:  POST {z/login} { token: <upstream Z.AI token> } → { data: { access_token: <business token> } }
 *   4. Provision: with the business token, GET getCustomerInfo → default org/project,
 *      GET/POST .../api_keys (find/create a key named "zcode-api-key"),
 *      GET .../api_keys/copy/{id} → secretKey ⇒ a real Z.AI API key "{id}.{secret}".
 *
 * Credential mapping:
 *   - `access`  = the provisioned **Z.AI API key** ("{id}.{secret}"). Model requests go to
 *                 `https://api.z.ai/api/anthropic/v1/messages` with `Authorization: Bearer <key>`
 *                 (exactly like a dashboard key) — NO zcode.z.ai gateway, NO captcha.
 *   - `refresh` = the upstream Z.AI OAuth access token (used to re-provision the key).
 * The API key is long-lived, so `expires` is set far in the future.
 *
 * This provider must NEVER force `isOAuth=true`: the key is a plain Z.AI API key, and
 * api.z.ai is not api.anthropic.com, so the Anthropic path already emits a plain bearer.
 */
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions, parseCallbackInput } from "./callback-server";
import type { OAuthController, OAuthCredentials } from "./types";

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
export const GLM_ZCODE_REFRESH_SKEW_MS = 2 * 60 * 1000;
/** Provisioned API keys are long-lived; pin expiry far out so AuthStorage never force-refreshes. */
const GLM_ZCODE_API_KEY_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
/** Name ZCode gives the API key it auto-provisions (host bundle constant `FI`). */
const GLM_ZCODE_API_KEY_NAME = "zcode-api-key";

/** Default endpoints / client id. Override via the matching `ZCODE_OAUTH_*` env vars. */
export const GLM_ZCODE_OAUTH_AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
export const GLM_ZCODE_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
export const GLM_ZCODE_OAUTH_REDIRECT_URI = "zcode://oauth/callback";
export const GLM_ZCODE_OAUTH_BROKER_TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
export const GLM_ZCODE_ZAI_LOGIN_URL = "https://api.z.ai/api/auth/z/login";
export const GLM_ZCODE_USERINFO_URL = "https://chat.z.ai/api/oauth/userinfo";
/** Z.AI business API base (customer/org/project/api-key management). */
export const GLM_ZCODE_ZAI_API_BASE = "https://api.z.ai";
/** Model API base — the provisioned key is used here, exactly like a dashboard key. */
export const GLM_ZCODE_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";

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
function resolveZaiApiBase(): string {
	return envOr("ZCODE_OAUTH_ZAI_API_BASE", GLM_ZCODE_ZAI_API_BASE).replace(/\/+$/, "");
}

/** Configured whenever a client id is available; the real ZCode client id ships as default. */
export function isGlmZcodeOAuthConfigured(): boolean {
	return resolveClientId().length > 0;
}

/** Mask token-like substrings so broker/upstream/business tokens never leak into errors. */
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
	return parsed.toString().replace(/\/+$/, "");
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
	bearer?: string,
): Promise<unknown> {
	const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
	if (bearer) headers.Authorization = `Bearer ${bearer}`;
	const response = await fetchImpl(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`GLM ZCode ${label} request failed: ${response.status} ${redactSecrets(await response.text())}`);
	}
	return response.json();
}

async function getJson(
	fetchImpl: FetchImpl,
	url: string,
	bearer: string,
	label: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const response = await fetchImpl(url, {
		headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
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

function parseBrokerResponse(payload: unknown): { upstreamZaiAccess: string; zcodeToken: string } {
	const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
	const zcodeToken = data && typeof data.token === "string" ? data.token : undefined;
	const zai = data && isRecord(data.zai) ? data.zai : undefined;
	const upstreamZaiAccess = zai && typeof zai.access_token === "string" ? zai.access_token : undefined;
	if (!zcodeToken || !upstreamZaiAccess) {
		throw new Error("GLM ZCode broker response missing data.token or data.zai.access_token");
	}
	return { upstreamZaiAccess, zcodeToken };
}

async function resolveBusinessToken(
	fetchImpl: FetchImpl,
	upstreamZaiAccess: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const zaiLoginUrl = validateHttpsEndpoint(resolveZaiLoginUrl(), "z/login");
	const payload = await postJson(fetchImpl, `${zaiLoginUrl}`, { token: upstreamZaiAccess }, "z/login", signal);
	const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
	const access = data && typeof data.access_token === "string" ? data.access_token : undefined;
	if (!access) throw new Error("GLM ZCode z/login response missing data.access_token");
	return access;
}

interface OrgProject {
	organizationId: string;
	projectId: string;
	email?: string;
	accountId?: string;
}

function pickDefaultOrgProject(customerInfo: unknown): OrgProject {
	const data = isRecord(customerInfo) && isRecord(customerInfo.data) ? customerInfo.data : customerInfo;
	const root = isRecord(data) ? data : {};
	const orgs = Array.isArray(root.organizations) ? root.organizations : [];
	const org = (orgs.find(o => isRecord(o) && o.isDefault) ?? orgs[0]) as Record<string, unknown> | undefined;
	const organizationId = org && typeof org.organizationId === "string" ? org.organizationId : undefined;
	const projects = org && Array.isArray(org.projects) ? org.projects : [];
	const proj = (projects.find(p => isRecord(p) && p.isDefault) ?? projects[0]) as Record<string, unknown> | undefined;
	const projectId = proj && typeof proj.projectId === "string" ? proj.projectId : undefined;
	if (!organizationId || !projectId) {
		throw new Error("GLM ZCode getCustomerInfo response missing default organization/project");
	}
	const email = typeof root.email === "string" && root.email.length > 0 ? root.email.toLowerCase() : undefined;
	const accountId = typeof root.id === "string" ? root.id : typeof root.id === "number" ? String(root.id) : undefined;
	return { organizationId, projectId, email, accountId };
}

/**
 * Provision (or reuse) a Z.AI API key named "zcode-api-key" using the business token,
 * mirroring ZCode's `resolveBizApiKey`. Returns "{apiKeyId}.{secretKey}".
 */
async function provisionZaiApiKey(
	fetchImpl: FetchImpl,
	businessToken: string,
	signal: AbortSignal | undefined,
): Promise<{ apiKey: string; identity: Identity }> {
	const apiBase = resolveZaiApiBase();
	const customerInfo = await getJson(
		fetchImpl,
		`${apiBase}/api/biz/customer/getCustomerInfo`,
		businessToken,
		"getCustomerInfo",
		signal,
	);
	const { organizationId, projectId, email, accountId } = pickDefaultOrgProject(customerInfo);
	const keysUrl = `${apiBase}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;

	const listPayload = await getJson(fetchImpl, keysUrl, businessToken, "api_keys.list", signal);
	const listData = isRecord(listPayload) && Array.isArray(listPayload.data) ? listPayload.data : [];
	let entry = listData.find(k => isRecord(k) && k.name === GLM_ZCODE_API_KEY_NAME) as
		| Record<string, unknown>
		| undefined;

	if (!entry) {
		const created = await postJson(
			fetchImpl,
			keysUrl,
			{ name: GLM_ZCODE_API_KEY_NAME },
			"api_keys.create",
			signal,
			businessToken,
		);
		entry = (isRecord(created) && isRecord(created.data) ? created.data : created) as Record<string, unknown>;
	}

	const apiKeyId =
		typeof entry.apiKey === "string" ? entry.apiKey.trim() : typeof entry.id === "string" ? entry.id : "";
	if (!apiKeyId) throw new Error("GLM ZCode api_keys response missing apiKey id");

	const copyPayload = await getJson(
		fetchImpl,
		`${keysUrl}/copy/${encodeURIComponent(apiKeyId)}`,
		businessToken,
		"api_keys.copy",
		signal,
	);
	const copyData = isRecord(copyPayload) && isRecord(copyPayload.data) ? copyPayload.data : copyPayload;
	const secretKey = isRecord(copyData) && typeof copyData.secretKey === "string" ? copyData.secretKey.trim() : "";
	if (!secretKey) throw new Error("GLM ZCode api_keys copy response missing secretKey");

	return { apiKey: `${apiKeyId}.${secretKey}`, identity: { email, accountId } };
}

async function resolveIdentity(
	fetchImpl: FetchImpl,
	upstreamZaiAccess: string,
	fallback: Identity,
	jwtCandidates: readonly string[],
	signal: AbortSignal | undefined,
): Promise<Identity> {
	if (fallback.email || fallback.accountId) return fallback;
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
				(typeof data.id === "string" && data.id) || (typeof data.sub === "string" && data.sub) || undefined;
			if (email || accountId) return { email, accountId: accountId || undefined };
		}
	} catch {
		// fall through
	}
	for (const token of jwtCandidates) {
		const p = decodeJwtPayload(token);
		const accountId = p && typeof p.sub === "string" ? p.sub : undefined;
		const email = p && typeof p.email === "string" ? p.email.toLowerCase() : undefined;
		if (accountId || email) return { accountId, email };
	}
	return {};
}

function credentialsFromApiKey(apiKey: string, upstreamZaiAccess: string, identity: Identity): OAuthCredentials {
	return {
		access: apiKey,
		refresh: upstreamZaiAccess,
		expires: Date.now() + GLM_ZCODE_API_KEY_TTL_MS,
		email: identity.email,
		accountId: identity.accountId,
	};
}

async function provisionFromUpstream(
	fetchImpl: FetchImpl,
	upstreamZaiAccess: string,
	zcodeTokenForIdentity: string | undefined,
	signal: AbortSignal | undefined,
): Promise<OAuthCredentials> {
	const businessToken = await resolveBusinessToken(fetchImpl, upstreamZaiAccess, signal);
	const { apiKey, identity: keyIdentity } = await provisionZaiApiKey(fetchImpl, businessToken, signal);
	const identity = await resolveIdentity(
		fetchImpl,
		upstreamZaiAccess,
		keyIdentity,
		[zcodeTokenForIdentity ?? "", businessToken].filter(Boolean),
		signal,
	);
	return credentialsFromApiKey(apiKey, upstreamZaiAccess, identity);
}

async function exchangeGlmZcodeCode(
	fetchImpl: FetchImpl,
	input: { code: string; state: string; redirectUri: string },
	signal: AbortSignal | undefined,
): Promise<OAuthCredentials> {
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
	const { upstreamZaiAccess, zcodeToken } = parseBrokerResponse(brokerPayload);
	return provisionFromUpstream(fetchImpl, upstreamZaiAccess, zcodeToken, signal);
}

export interface GlmZcodeOAuthFlowOptions {
	fetch?: FetchImpl;
}

export class GlmZcodeOAuthFlow extends OAuthCallbackFlow {
	#fetch: FetchImpl;

	constructor(ctrl: OAuthController, options: GlmZcodeOAuthFlowOptions = {}) {
		super(ctrl, {
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
				"Complete Z.AI login in your browser. This is an UNOFFICIAL ZCode-based login — use at your own risk; it may stop working or violate ZCode/Z.AI Terms of Service. If the ZCode desktop app is installed, cancel the browser's prompt to open it: the app exchanges the single-use code itself and the pasted code is then rejected (broker error 2007). After login the browser redirects to a zcode:// address, which never appears in the address bar — copy it from DevTools instead: open the browser DevTools Network tab (filter: zcode), select the zcode://oauth/callback?code=…&state=… request, and paste that full URL (or just the code) at the prompt.",
		};
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		return exchangeGlmZcodeCode(this.#fetch, { code, state, redirectUri }, this.ctrl.signal);
	}
}

/**
 * Manual-input prompt for the paste fallback. Repeats the redirect-URL shape and
 * the DevTools pointer so a re-prompt after a rejected paste stays self-contained.
 */
export const GLM_ZCODE_MANUAL_INPUT_PROMPT =
	"Paste the full zcode://oauth/callback?code=…&state=… URL (copy it from browser DevTools → Network tab; the address bar never shows it) or the authorization code:";

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
 * Re-provision the Z.AI API key from the stored upstream token. The key itself is
 * long-lived, so this is rarely needed; if the upstream token has expired it fails
 * loudly and the user must re-login.
 */
export async function refreshGlmZcodeToken(
	credentials: OAuthCredentials,
	options: AbortSignal | GlmZcodeRefreshOptions = {},
): Promise<OAuthCredentials> {
	const { signal, fetch: fetchImpl } =
		options instanceof AbortSignal ? { signal: options, fetch: undefined } : options;
	const upstream = credentials.refresh;
	if (!upstream) {
		throw new Error("glm-zcode credentials require re-login (`/login glm-zcode`); no stored upstream Z.AI token");
	}
	try {
		return await provisionFromUpstream(fetchImpl ?? globalThis.fetch, upstream, undefined, signal);
	} catch (error) {
		throw new Error(
			`glm-zcode credentials require re-login (\`/login glm-zcode\`); re-provisioning the Z.AI API key failed (${redactSecrets(String(error))})`,
		);
	}
}
