/**
 * Kiro (Amazon Q Developer / CodeWhisperer) OAuth flow via AWS SSO OIDC.
 *
 * Implements the device-code authorization flow and token refresh using the
 * published AWS SSO OIDC service model (botocore sso-oidc/2019-06-10).
 *
 * Clean-room: derived from the published Amazon SSO OIDC service model shapes
 * and AWS public documentation, not from any third-party reference.
 */
import { scheduler } from "node:timers/promises";
import type { OAuthCredentials } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Published SSO OIDC endpoints and constants
// ─────────────────────────────────────────────────────────────────────────────

/** Builder ID start URL for device authorization. */
const BUILDER_ID_START_URL = "https://view.awsapps.com/start";

/** Default AWS region for SSO OIDC. */
const DEFAULT_REGION = "us-east-1";

/** Client registration metadata for the Gajae Code application. */
const CLIENT_NAME = "gajae-code";
const CLIENT_TYPE = "public";

/**
 * Scopes requested for CodeWhisperer / Amazon Q access. These are the published
 * scopes from the AWS SSO OIDC model for the CodeWhisperer service.
 */
const CODEWHISPERER_SCOPES = [
	"codewhisperer:completions",
	"codewhisperer:analysis",
	"codewhisperer:conversations",
	"codewhisperer:transformations",
	"codewhisperer:taskassist",
	"sso:account:access",
];

// ─────────────────────────────────────────────────────────────────────────────
// Wire types (matching published SSO OIDC service model)
// ─────────────────────────────────────────────────────────────────────────────

interface RegisterClientResponse {
	clientId: string;
	clientSecret: string;
	clientIdIssuedAt: number;
	clientSecretExpiresAt: number;
	authorizationEndpoint?: string;
	tokenEndpoint?: string;
}

interface StartDeviceAuthorizationResponse {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	interval: number;
	expiresIn: number;
}

interface CreateTokenSuccess {
	accessToken: string;
	tokenType: string;
	expiresIn: number;
	refreshToken?: string;
}

interface CreateTokenError {
	error: string;
	error_description?: string;
	error_uri?: string;
}

interface CreateTokenResult {
	response: Response;
	status: number;
	data: CreateTokenSuccess | CreateTokenError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed SSO OIDC error names from the published service model
// ─────────────────────────────────────────────────────────────────────────────

const SSO_OIDC_FATAL_ERRORS = new Set([
	"access_denied_exception",
	"access_denied",
	"expired_token_exception",
	"expired_token",
	"internal_server_exception",
	"server_error",
	"invalid_client_exception",
	"invalid_client",
	"invalid_client_metadata_exception",
	"invalid_grant_exception",
	"invalid_grant",
	"invalid_redirect_uri_exception",
	"invalid_request_exception",
	"invalid_request",
	"invalid_request_region_exception",
	"invalid_scope_exception",
	"invalid_scope",
	"unauthorized_client_exception",
	"unauthorized_client",
	"unsupported_grant_type_exception",
	"unsupported_grant_type",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Registration cache (client registration is reusable until expiry)
// ─────────────────────────────────────────────────────────────────────────────

interface ClientRegistration {
	clientId: string;
	clientSecret: string;
	expiresAt: number; // epoch ms
}

let cachedRegistration: ClientRegistration | undefined;

/**
 * Register a public SSO OIDC client. Registration responses include an expiry
 * timestamp (`clientSecretExpiresAt`); we cache until then to avoid re-registering
 * on every login attempt.
 *
 * The SSO OIDC `RegisterClient` endpoint is public (no authentication required).
 */
export async function registerClient(
	region: string,
	startUrl: string,
	signal?: AbortSignal,
): Promise<ClientRegistration> {
	if (cachedRegistration && Date.now() < cachedRegistration.expiresAt - 60_000) {
		return cachedRegistration;
	}

	const url = ssoOidcEndpoint(region, "/client/register");
	const body = {
		clientName: CLIENT_NAME,
		clientType: CLIENT_TYPE,
		scopes: CODEWHISPERER_SCOPES,
		grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
		redirectUris: [],
		issuerUrl: startUrl,
	};

	const response = await fetchOidc(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});

	const data = (await response.json()) as RegisterClientResponse;
	if (!data.clientId || !data.clientSecret) {
		throw new Error("SSO OIDC RegisterClient: missing clientId or clientSecret");
	}

	cachedRegistration = {
		clientId: data.clientId,
		clientSecret: data.clientSecret,
		// `clientSecretExpiresAt` is epoch seconds in the published model
		expiresAt: data.clientSecretExpiresAt * 1000,
	};
	return cachedRegistration;
}

/** Drop cached client registration — used by tests. */
export function clearClientRegistrationCache(): void {
	cachedRegistration = undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Device authorization flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start device authorization. The SSO OIDC `StartDeviceAuthorization` endpoint
 * is public (requires registered clientId/clientSecret, not SigV4).
 */
export async function startDeviceAuthorization(
	region: string,
	startUrl: string,
	registration: ClientRegistration,
	signal?: AbortSignal,
): Promise<StartDeviceAuthorizationResponse> {
	const url = ssoOidcEndpoint(region, "/device_authorization");
	const body = {
		clientId: registration.clientId,
		clientSecret: registration.clientSecret,
		startUrl,
	};

	const response = await fetchOidc(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});

	const data = (await response.json()) as StartDeviceAuthorizationResponse;
	if (!data.deviceCode || !data.userCode || !data.verificationUri) {
		throw new Error("SSO OIDC StartDeviceAuthorization: missing required fields");
	}
	return data;
}

/**
 * Poll `CreateToken` until the user completes authorization or the device code
 * expires. Handles `authorization_pending` (continue polling) and `slow_down`
 * (increase interval) per the published SSO OIDC model.
 */
export async function pollForToken(
	region: string,
	registration: ClientRegistration,
	deviceCode: string,
	intervalSeconds: number,
	expiresInSeconds: number,
	signal?: AbortSignal,
): Promise<CreateTokenSuccess> {
	const url = ssoOidcEndpoint(region, "/token");
	const deadline = Date.now() + expiresInSeconds * 1000;
	let currentInterval = Math.max(intervalSeconds, 1) * 1000;

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled");

		const remainingMs = deadline - Date.now();
		const waitMs = Math.min(currentInterval, remainingMs);
		try {
			await scheduler.wait(waitMs, { signal });
		} catch {
			throw new Error("Login cancelled");
		}

		if (signal?.aborted) throw new Error("Login cancelled");

		const body = {
			clientId: registration.clientId,
			clientSecret: registration.clientSecret,
			grantType: "urn:ietf:params:oauth:grant-type:device_code",
			deviceCode,
		};

		const requestSignal = AbortSignal.any([
			...(signal ? [signal] : []),
			AbortSignal.timeout(Math.max(1, deadline - Date.now())),
		]);
		let result: CreateTokenResult;
		try {
			result = await createTokenOnce(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: requestSignal,
			});
		} catch (error) {
			if (signal?.aborted) throw new Error("Login cancelled");
			if (Date.now() >= deadline) break;
			throw error;
		}

		if (Date.now() >= deadline) break;
		const { status, data } = result;

		if ("accessToken" in data) {
			if (
				status < 200 ||
				status >= 300 ||
				"error" in data ||
				data.accessToken.length === 0 ||
				!Number.isFinite(data.expiresIn) ||
				data.expiresIn <= 0
			) {
				throw new Error("SSO OIDC CreateToken: invalid success response");
			}
			return data;
		}

		if ("error" in data) {
			if (status !== 400) throw new Error(oidcRequestFailure(url, result.response));
			const errorCode = data.error;
			if (errorCode === "authorization_pending") continue;
			if (errorCode === "slow_down") {
				currentInterval += 5_000;
				continue;
			}
			if (SSO_OIDC_FATAL_ERRORS.has(errorCode)) {
				throw new Error(`SSO OIDC token error: ${errorCode}`);
			}
			// Unknown error — fail closed
			throw new Error(`SSO OIDC unrecognized token error: ${errorCode}`);
		}

		throw new Error("SSO OIDC CreateToken: unrecognized response shape");
	}

	throw new Error("SSO OIDC device authorization timed out");
}

// ─────────────────────────────────────────────────────────────────────────────
// Token refresh
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refresh an expired access token using the stored refresh token via
 * `CreateToken` with `grantType: "refresh_token"`.
 *
 * Rotation is published behavior: the response includes a new `refreshToken`.
 * If the server does not return a new one, the old refresh token is retained.
 */
export async function refreshKiroToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const region = DEFAULT_REGION;

	// We need client registration to refresh. If we have a cached one, use it;
	// otherwise re-register.
	const registration = cachedRegistration ?? (await registerClient(region, BUILDER_ID_START_URL));

	const url = ssoOidcEndpoint(region, "/token");
	const body = {
		clientId: registration.clientId,
		clientSecret: registration.clientSecret,
		grantType: "refresh_token",
		refreshToken: credentials.refresh,
	};

	const response = await fetchOidc(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	const data = (await response.json()) as CreateTokenSuccess | CreateTokenError;

	if ("accessToken" in data && typeof data.accessToken === "string") {
		const expiresAt = Date.now() + data.expiresIn * 1000;
		return {
			access: data.accessToken,
			refresh: data.refreshToken ?? credentials.refresh,
			expires: expiresAt,
			enterpriseUrl: credentials.enterpriseUrl,
			projectId: credentials.projectId,
			email: credentials.email,
			accountId: credentials.accountId,
		};
	}

	if ("error" in data) {
		const errorCode = data.error;
		const desc = data.error_description ? `: ${data.error_description}` : "";
		if (errorCode === "invalid_grant_exception" || errorCode === "invalid_grant") {
			throw new Error(
				`Kiro refresh token is invalid or expired. Run 'gjc auth-broker login kiro' to re-authenticate. (${errorCode}${desc})`,
			);
		}
		if (errorCode === "expired_token_exception") {
			throw new Error(
				`Kiro client registration has expired. Run 'gjc auth-broker login kiro' to re-authenticate. (${errorCode}${desc})`,
			);
		}
		throw new Error(`Kiro token refresh failed: ${errorCode}${desc}`);
	}

	throw new Error("Kiro token refresh: unrecognized response");
}

// ─────────────────────────────────────────────────────────────────────────────
// Full login flow (device code)
// ─────────────────────────────────────────────────────────────────────────────

export interface KiroLoginOptions {
	onAuth: (url: string, instructions?: string) => void;
	onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
	/** Override for tests. */
	fetchImpl?: typeof globalThis.fetch;
}

export async function loginKiro(options: KiroLoginOptions): Promise<OAuthCredentials> {
	const region = DEFAULT_REGION;
	const startUrl = BUILDER_ID_START_URL;

	if (options.signal?.aborted) throw new Error("Login cancelled");

	options.onProgress?.("Registering client with AWS SSO OIDC...");
	const registration = await registerClient(region, startUrl, options.signal);

	if (options.signal?.aborted) throw new Error("Login cancelled");

	options.onProgress?.("Requesting device authorization...");
	const deviceAuth = await startDeviceAuthorization(region, startUrl, registration, options.signal);

	const verificationUrl = deviceAuth.verificationUriComplete ?? deviceAuth.verificationUri;
	options.onAuth(verificationUrl, `Enter code: ${deviceAuth.userCode}`);

	options.onProgress?.("Waiting for authorization...");
	const token = await pollForToken(
		region,
		registration,
		deviceAuth.deviceCode,
		deviceAuth.interval,
		deviceAuth.expiresIn,
		options.signal,
	);

	const expiresAt = Date.now() + token.expiresIn * 1000;
	return {
		access: token.accessToken,
		refresh: token.refreshToken ?? "",
		expires: expiresAt,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// SSO cache import (reuse existing ~/.aws/sso/cache/*.json pattern)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import { getTrustedHomeDir } from "@gajae-code/utils";

interface SsoCachedAccessToken {
	accessToken: string;
	expiresAt?: number;
	startUrl?: string;
	region?: string;
}

/**
 * Attempt to import a cached SSO access token from `~/.aws/sso/cache/`.
 * Returns the token if a valid (non-expired) one exists, otherwise undefined.
 *
 * This reuses the documented AWS CLI SSO cache location, not any third-party
 * credential store.
 */
export function importSsoCacheToken(): OAuthCredentials | undefined {
	const homeDir = getTrustedHomeDir();
	const cacheDir = path.join(homeDir, ".aws", "sso", "cache");

	let files: string[];
	try {
		files = fs.readdirSync(cacheDir).filter(f => f.endsWith(".json"));
	} catch {
		return undefined;
	}

	for (const file of files) {
		try {
			const raw = fs.readFileSync(path.join(cacheDir, file), "utf8");
			const cached = JSON.parse(raw) as SsoCachedAccessToken;
			if (!cached.accessToken) continue;
			if (cached.expiresAt && cached.expiresAt * 1000 < Date.now()) continue;
			return {
				access: cached.accessToken,
				refresh: "",
				expires: cached.expiresAt ? cached.expiresAt * 1000 : Date.now() + 3600_000,
			};
		} catch {}
	}
	return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ssoOidcEndpoint(region: string, pathSuffix: string): string {
	return `https://oidc.${region}.amazonaws.com${pathSuffix}`;
}

async function fetchOidc(url: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(oidcRequestFailure(url, response));
	}
	return response;
}

function oidcRequestFailure(url: string, response: Response): string {
	return `SSO OIDC request to ${url} failed: ${response.status} ${response.statusText}`;
}

/**
 * `CreateToken` reports the in-progress device-code states (`authorization_pending`,
 * `slow_down`) as HTTP 400 responses whose body carries the error code, so the poll
 * loop must read the payload instead of treating a non-2xx status as fatal.
 * Non-2xx responses without an `error` field still fail closed.
 */
async function createTokenOnce(url: string, init: RequestInit & { signal?: AbortSignal }): Promise<CreateTokenResult> {
	const response = await fetch(url, init);
	const rawBody = await response.text();
	let data: CreateTokenSuccess | CreateTokenError;
	try {
		data = JSON.parse(rawBody) as CreateTokenSuccess | CreateTokenError;
	} catch {
		throw new Error(oidcRequestFailure(url, response));
	}
	if (data === null || typeof data !== "object") {
		throw new Error(oidcRequestFailure(url, response));
	}
	if (!response.ok && !("error" in data)) {
		throw new Error(oidcRequestFailure(url, response));
	}
	if ("error" in data && typeof data.error !== "string") {
		throw new Error(oidcRequestFailure(url, response));
	}
	if ("accessToken" in data && typeof data.accessToken !== "string") {
		throw new Error(oidcRequestFailure(url, response));
	}
	return { response, status: response.status, data };
}
