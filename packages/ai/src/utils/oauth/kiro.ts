/**
 * Kiro OAuth flows — reverse-engineered from Kiro CLI 2.14.2.
 *
 * Two distinct flows, both usable without the Kiro IDE/CLI apps installed:
 *
 * - Builder ID: the standard AWS SSO-OIDC device authorization grant
 *   (RegisterClient → StartDeviceAuthorization → polled CreateToken) against
 *   `oidc.us-east-1.amazonaws.com`. The dynamically-registered client
 *   (clientId/clientSecret) must outlive the access token so refresh works, so
 *   it is persisted in the agent DB under the `kiro_kv` table (schema owned by
 *   `auth-storage.ts` `#initializeSchema`), keyed the same way Kiro CLI names
 *   its `kirocli:odic:device-registration` entry.
 *
 *   At-rest protection is **not** OS-keychain equivalent: Kiro CLI stores that
 *   entry in the platform keychain, whereas this row is plaintext JSON in
 *   SQLite. That matches how `auth-storage.ts` `serializeCredential` already
 *   persists every OAuth credential (plaintext `JSON.stringify`) in the same
 *   database file — there is no encryption layer in this store to route into —
 *   so the client secret inherits exactly the `auth_credentials` protection
 *   level and no more. It carries a ~90-day lifetime.
 * - Google / GitHub: Kiro's own desktop auth service device flow
 *   (`/oauth/device/authorization` → polled `/oauth/device/poll` →
 *   `/refreshToken`) against `prod.us-east-1.auth.desktop.kiro.dev`. The poll
 *   response carries the account's CodeWhisperer `profileArn` directly.
 *
 * Tokens from either flow are reusable by any client that presents them as a
 * Bearer token with the resolved profile ARN, so credentials produced here are
 * interchangeable with `kiro-cli login`.
 */

import { Database } from "bun:sqlite";
import { scheduler } from "node:timers/promises";
import { getAgentDbPath } from "@gajae-code/utils";
import { KIRO_BUILDER_ID_PROFILE_ARN } from "../../providers/kiro";
import { redactedHttpErrorSummary } from "../http-error-redaction";
import type { KiroLoginMethod, OAuthCredentials } from "./types";

const OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
const REGISTER_URL = `${OIDC_ENDPOINT}/client/register`;
const DEVICE_AUTH_URL = `${OIDC_ENDPOINT}/device_authorization`;
const TOKEN_URL = `${OIDC_ENDPOINT}/token`;

/** Builder ID start URL. */
const START_URL = "https://view.awsapps.com/start";
const CLIENT_NAME = "Kiro CLI";
const SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"] as const;

const REGISTRATION_KEY = "kirocli:odic:device-registration";
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_TOKEN_GRANT = "refresh_token";
const KIRO_SOCIAL_REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const KIRO_SOCIAL_DEVICE_AUTH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/authorization";
const KIRO_SOCIAL_DEVICE_POLL_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/poll";
/** Client id Kiro CLI presents to the desktop auth service. */
const KIRO_SOCIAL_CLIENT_ID = "kiro-cli";
/** `loginProvider` values the desktop auth service accepts. */
const KIRO_SOCIAL_LOGIN_PROVIDERS = { google: "Google", github: "Github" } as const;

function kiroPlatform(): string {
	switch (process.platform) {
		case "darwin":
			return "macos";
		case "win32":
			return "windows";
		default:
			return process.platform;
	}
}

const KIRO_OIDC_UA = `aws-sdk-rust/1.3.15 os/${kiroPlatform()} lang/rust/1.92.0`;
const KIRO_OIDC_X_AMZ_UA = `aws-sdk-rust/1.3.15 ua/2.1 api/ssooidc/1.100.0 os/${kiroPlatform()} lang/rust/1.92.0 m/E,N app/AmazonQ-For-CLI`;
const KIRO_KIROCLI_UA = "KiroCLI/2.14.2 md/appVersion-2.14.2 app/AmazonQ-For-CLI";

/** SSO-OIDC request headers shared across RegisterClient / DeviceAuth / Token. */
function oidcHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"User-Agent": KIRO_OIDC_UA,
		"x-amz-user-agent": KIRO_OIDC_X_AMZ_UA,
		accept: "*/*",
		"accept-encoding": "gzip",
		"amz-sdk-request": "attempt=1; max=3",
		"amz-sdk-invocation-id": crypto.randomUUID(),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Device registration store (clientId/clientSecret outlive the access token)
// ─────────────────────────────────────────────────────────────────────────────

export interface KiroDeviceRegistration {
	clientId: string;
	clientSecret: string;
	clientIdIssuedAt: number;
	clientSecretExpiresAt: number;
}

/**
 * Read the persisted device registration. A missing database, table, or row is
 * an expected cold-start state; all other storage and validation failures fail
 * closed.
 */
async function readRegistration(): Promise<KiroDeviceRegistration | undefined> {
	const dbPath = getAgentDbPath();
	if (!(await Bun.file(dbPath).exists())) return undefined;

	let db: Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch {
		throw new Error("Kiro device registration store could not be opened");
	}
	try {
		const table = db
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'kiro_kv'")
			.get() as { present?: number } | undefined;
		if (table?.present !== 1) return undefined;

		const row = db.prepare("SELECT value FROM kiro_kv WHERE key = ?").get(REGISTRATION_KEY) as
			| { value?: string }
			| null
			| undefined;
		if (row == null) return undefined;
		if (typeof row.value !== "string") throw new Error("Kiro device registration is invalid");

		let parsed: Partial<KiroDeviceRegistration>;
		try {
			parsed = JSON.parse(row.value) as Partial<KiroDeviceRegistration>;
		} catch {
			throw new Error("Kiro device registration is invalid");
		}
		if (parsed === null || typeof parsed !== "object") throw new Error("Kiro device registration is invalid");
		if (
			typeof parsed.clientId !== "string" ||
			parsed.clientId.length === 0 ||
			typeof parsed.clientSecret !== "string" ||
			parsed.clientSecret.length === 0 ||
			typeof parsed.clientSecretExpiresAt !== "number" ||
			!Number.isFinite(parsed.clientSecretExpiresAt)
		) {
			throw new Error("Kiro device registration is invalid");
		}
		return {
			clientId: parsed.clientId,
			clientSecret: parsed.clientSecret,
			clientIdIssuedAt: typeof parsed.clientIdIssuedAt === "number" ? parsed.clientIdIssuedAt : 0,
			clientSecretExpiresAt: parsed.clientSecretExpiresAt,
		};
	} catch (error) {
		if (error instanceof Error && error.message === "Kiro device registration is invalid") throw error;
		throw new Error("Kiro device registration could not be read");
	} finally {
		db.close();
	}
}

function writeRegistration(registration: KiroDeviceRegistration): void {
	const db = new Database(getAgentDbPath());
	try {
		db.run("PRAGMA busy_timeout=5000");
		// `auth-storage.ts` #initializeSchema owns this table, but that store may
		// not have been opened in this process yet, so keep the idempotent create.
		db.run("CREATE TABLE IF NOT EXISTS kiro_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		db.prepare("INSERT OR REPLACE INTO kiro_kv (key, value) VALUES (?, ?)").run(
			REGISTRATION_KEY,
			JSON.stringify(registration),
		);
	} finally {
		db.close();
	}
}

function isRegistrationValid(registration: KiroDeviceRegistration | undefined): registration is KiroDeviceRegistration {
	// clientSecretExpiresAt is epoch seconds (AWS SSO-OIDC shape).
	return (
		registration !== undefined &&
		registration.clientId.length > 0 &&
		registration.clientSecret.length > 0 &&
		Date.now() < registration.clientSecretExpiresAt * 1000
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire types
// ─────────────────────────────────────────────────────────────────────────────

interface RegisterClientResponse {
	clientId?: unknown;
	clientSecret?: unknown;
	clientIdIssuedAt?: unknown;
	clientSecretExpiresAt?: unknown;
}

interface DeviceAuthorizationResponse {
	deviceCode?: unknown;
	userCode?: unknown;
	verificationUri?: unknown;
	verificationUriComplete?: unknown;
	interval?: unknown;
	expiresIn?: unknown;
}

interface TokenResponse {
	accessToken?: unknown;
	refreshToken?: unknown;
	tokenType?: unknown;
	expiresIn?: unknown;
	error?: unknown;
	error_description?: unknown;
	interval?: unknown;
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function assertString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Kiro token response missing ${field}`);
	}
	return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSO-OIDC operations
// ─────────────────────────────────────────────────────────────────────────────

async function registerClient(signal?: AbortSignal): Promise<KiroDeviceRegistration> {
	const response = await fetch(REGISTER_URL, {
		method: "POST",
		headers: oidcHeaders(),
		body: JSON.stringify({ clientName: CLIENT_NAME, clientType: "public", scopes: [...SCOPES] }),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`Kiro RegisterClient failed: ${redactedHttpErrorSummary(response)}`);
	}
	const payload = (await response.json()) as RegisterClientResponse;
	const clientId = assertString(payload.clientId, "clientId");
	const clientSecret = assertString(payload.clientSecret, "clientSecret");
	const clientIdIssuedAt = typeof payload.clientIdIssuedAt === "number" ? payload.clientIdIssuedAt : 0;
	const clientSecretExpiresAt = typeof payload.clientSecretExpiresAt === "number" ? payload.clientSecretExpiresAt : 0;
	if (clientSecretExpiresAt === 0) {
		throw new Error("Kiro RegisterClient response missing clientSecretExpiresAt");
	}
	const registration: KiroDeviceRegistration = { clientId, clientSecret, clientIdIssuedAt, clientSecretExpiresAt };
	writeRegistration(registration);
	return registration;
}

async function startDeviceAuthorization(
	registration: KiroDeviceRegistration,
	signal?: AbortSignal,
): Promise<DeviceAuthorizationResponse> {
	const response = await fetch(DEVICE_AUTH_URL, {
		method: "POST",
		headers: oidcHeaders(),
		body: JSON.stringify({
			clientId: registration.clientId,
			clientSecret: registration.clientSecret,
			startUrl: START_URL,
		}),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`Kiro StartDeviceAuthorization failed: ${redactedHttpErrorSummary(response)}`);
	}
	return (await response.json()) as DeviceAuthorizationResponse;
}

async function postToken(
	registration: KiroDeviceRegistration,
	body: Record<string, string>,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: oidcHeaders(),
		body: JSON.stringify({ clientId: registration.clientId, clientSecret: registration.clientSecret, ...body }),
		signal: requestSignal(signal),
	});
	// Token endpoint returns 200 with an `error` body for pending/slow_down.
	return (await response.json()) as TokenResponse;
}

async function pollForToken(
	registration: KiroDeviceRegistration,
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled");

		const remainingMs = deadline - Date.now();
		const waitMs = Math.min(intervalMs, remainingMs);
		try {
			await scheduler.wait(waitMs, { signal });
		} catch {
			throw new Error("Login cancelled");
		}

		const token = await postToken(registration, { grantType: DEVICE_CODE_GRANT, deviceCode }, signal);

		if (typeof token.accessToken === "string") {
			const expiresInToken = typeof token.expiresIn === "number" ? token.expiresIn : 28800;
			return {
				access: assertString(token.accessToken, "accessToken"),
				refresh: assertString(token.refreshToken, "refreshToken"),
				expires: Date.now() + expiresInToken * 1000 - OAUTH_EXPIRY_SKEW_MS,
			};
		}

		const error = typeof token.error === "string" ? token.error : "";
		if (error === "authorization_pending") continue;
		if (error === "slow_down") {
			intervalMs += 5000;
			continue;
		}
		const description = typeof token.error_description === "string" ? token.error_description : "";
		throw new Error(`Kiro device flow failed: ${error}${description ? `: ${description}` : ""}`);
	}

	throw new Error("Kiro device flow timed out");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface KiroLoginOptions {
	onAuth: (url: string, instructions?: string) => void;
	onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
	method?: KiroLoginMethod;
}

/**
 * Login with Kiro.
 *
 * Google/GitHub use Kiro's own desktop auth service device flow; Builder ID
 * uses the AWS SSO-OIDC device authorization grant. Neither path requires the
 * Kiro IDE or CLI to be installed.
 */
export async function loginKiro(options: KiroLoginOptions): Promise<OAuthCredentials> {
	const method: KiroLoginMethod = options.method ?? "builder-id";
	if (method === "google" || method === "github") {
		return loginKiroSocial(method, options);
	}
	options.onProgress?.(`Registering Kiro client (${method})…`);
	let registration = await readRegistration();
	if (!isRegistrationValid(registration)) {
		registration = await registerClient(options.signal);
	}

	options.onProgress?.("Requesting device authorization…");
	const device = await startDeviceAuthorization(registration, options.signal);
	const deviceCode = assertString(device.deviceCode, "deviceCode");
	const userCode = assertString(device.userCode, "userCode");
	const verificationUriComplete = assertString(
		device.verificationUriComplete ?? device.verificationUri,
		"verificationUri",
	);
	const interval = typeof device.interval === "number" ? device.interval : 1;
	const expiresIn = typeof device.expiresIn === "number" ? device.expiresIn : 600;

	options.onAuth(verificationUriComplete, `Enter code: ${userCode}`);

	const credentials = await pollForToken(registration, deviceCode, interval, expiresIn, options.signal);
	options.onProgress?.("Logged in to Kiro.");

	// Builder ID uses Kiro CLI's shared CodeWhisperer profile. Builder ID tokens
	// cannot call ListAvailableProfiles, so persist the authoritative routing
	// value at login instead of attempting discovery on first use.
	return {
		...credentials,
		kiroMethod: method,
		kiroProfileArn: KIRO_BUILDER_ID_PROFILE_ARN,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Kiro desktop auth service (Google / GitHub) device flow
// ─────────────────────────────────────────────────────────────────────────────

interface KiroSocialDeviceAuthResponse {
	deviceCode?: unknown;
	userCode?: unknown;
	verificationUri?: unknown;
	verificationUriComplete?: unknown;
	intervalInMilliseconds?: unknown;
	expiresInMilliseconds?: unknown;
}

interface KiroSocialPollResponse {
	status?: unknown;
	accessToken?: unknown;
	refreshToken?: unknown;
	profileArn?: unknown;
	identityProvider?: unknown;
}

/** Headers the Kiro CLI sends to the desktop auth service. */
function kiroSocialHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"User-Agent": KIRO_KIROCLI_UA,
		"accept-encoding": "gzip",
	};
}

async function startKiroSocialDeviceAuthorization(
	method: "google" | "github",
	signal?: AbortSignal,
): Promise<KiroSocialDeviceAuthResponse> {
	const response = await fetch(KIRO_SOCIAL_DEVICE_AUTH_URL, {
		method: "POST",
		headers: kiroSocialHeaders(),
		body: JSON.stringify({
			clientId: KIRO_SOCIAL_CLIENT_ID,
			loginProvider: KIRO_SOCIAL_LOGIN_PROVIDERS[method],
		}),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`Kiro social device authorization failed: ${redactedHttpErrorSummary(response)}`);
	}
	return (await response.json()) as KiroSocialDeviceAuthResponse;
}

async function pollKiroSocialDevice(deviceCode: string, signal?: AbortSignal): Promise<KiroSocialPollResponse> {
	const response = await fetch(KIRO_SOCIAL_DEVICE_POLL_URL, {
		method: "POST",
		headers: kiroSocialHeaders(),
		body: JSON.stringify({ clientId: KIRO_SOCIAL_CLIENT_ID, deviceCode }),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`Kiro social device poll failed: ${redactedHttpErrorSummary(response)}`);
	}
	return (await response.json()) as KiroSocialPollResponse;
}

/**
 * Google/GitHub login via Kiro's own desktop auth service device flow. Requires
 * no Kiro IDE/CLI installation: the poll response carries the access token,
 * rotating refresh token, and the account's CodeWhisperer profile ARN.
 */
async function loginKiroSocial(method: "google" | "github", options: KiroLoginOptions): Promise<OAuthCredentials> {
	options.onProgress?.(`Requesting Kiro device authorization (${method})…`);
	const device = await startKiroSocialDeviceAuthorization(method, options.signal);
	const deviceCode = assertString(device.deviceCode, "deviceCode");
	const userCode = assertString(device.userCode, "userCode");
	const verificationUri = assertString(device.verificationUriComplete ?? device.verificationUri, "verificationUri");
	const intervalMs =
		typeof device.intervalInMilliseconds === "number" ? Math.max(1000, device.intervalInMilliseconds) : 5000;
	const expiresInMs = typeof device.expiresInMilliseconds === "number" ? device.expiresInMilliseconds : 300_000;
	const deadline = Date.now() + expiresInMs;

	options.onAuth(verificationUri, `Enter code: ${userCode}`);

	while (Date.now() < deadline) {
		if (options.signal?.aborted) throw new Error("Login cancelled");
		try {
			await scheduler.wait(Math.min(intervalMs, deadline - Date.now()), { signal: options.signal });
		} catch {
			throw new Error("Login cancelled");
		}

		const poll = await pollKiroSocialDevice(deviceCode, options.signal);
		const status = typeof poll.status === "string" ? poll.status : "";
		if (typeof poll.accessToken === "string" && poll.accessToken) {
			options.onProgress?.("Logged in to Kiro.");
			const profileArn = assertString(poll.profileArn, "profileArn");
			return {
				access: poll.accessToken,
				refresh: assertString(poll.refreshToken, "refreshToken"),
				// The poll response carries no TTL; the social refresh endpoint
				// reports 8h, so mirror that and let refresh correct it.
				expires: Date.now() + 28800 * 1000 - OAUTH_EXPIRY_SKEW_MS,
				kiroMethod: method,
				kiroProfileArn: profileArn,
			};
		}
		if (status === "authorization_pending") continue;
		throw new Error(`Kiro social login failed: ${status || "unknown status"}`);
	}

	throw new Error("Kiro social device flow timed out");
}

interface SocialRefreshResponse {
	accessToken?: unknown;
	refreshToken?: unknown;
	expiresIn?: unknown;
	profileArn?: unknown;
}

/**
 * Refresh a Kiro social (Google/GitHub) access token via the Kiro desktop
 * auth service.  Reverse-engineered from kiro-cli-chat 2.14.2.
 */
export async function refreshKiroSocialToken(
	credentials: OAuthCredentials,
	method: KiroLoginMethod,
): Promise<OAuthCredentials> {
	if (method !== "google" && method !== "github") {
		throw new Error(`refreshKiroSocialToken: invalid method ${method}`);
	}
	const response = await fetch(KIRO_SOCIAL_REFRESH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": KIRO_KIROCLI_UA,
			"accept-encoding": "gzip",
		},
		body: JSON.stringify({ refreshToken: credentials.refresh }),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Kiro social token refresh failed: ${redactedHttpErrorSummary(response)}`);
	const payload = (await response.json()) as SocialRefreshResponse;
	const access = assertString(payload.accessToken, "accessToken");
	const refresh = typeof payload.refreshToken === "string" ? payload.refreshToken : credentials.refresh;
	const refreshedProfileArn =
		typeof payload.profileArn === "string" && payload.profileArn ? payload.profileArn : undefined;
	if (credentials.kiroProfileArn && refreshedProfileArn && credentials.kiroProfileArn !== refreshedProfileArn) {
		throw new Error("Kiro social token refresh failed: profile ARN changed");
	}
	const profileArn = refreshedProfileArn ?? credentials.kiroProfileArn;
	const expiresInSec = typeof payload.expiresIn === "number" && payload.expiresIn > 0 ? payload.expiresIn : 28800;
	const expires = Date.now() + expiresInSec * 1000 - OAUTH_EXPIRY_SKEW_MS;
	return {
		...credentials,
		access,
		refresh,
		expires,
		kiroMethod: method,
		...(profileArn ? { kiroProfileArn: profileArn } : {}),
	};
}

/**
 * Refresh a Kiro (Builder ID) access token using the persisted client
 * registration. Requires that the registered client secret has not expired
 * (~90-day lifetime); otherwise the user must re-run `/login kiro`.
 */
export async function refreshKiroToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const registration = await readRegistration();
	if (!isRegistrationValid(registration)) {
		throw new Error("Kiro client registration is missing or expired — run /login kiro again.");
	}
	const token = await postToken(registration, {
		grantType: REFRESH_TOKEN_GRANT,
		refreshToken: credentials.refresh,
	});
	if (typeof token.accessToken !== "string") {
		const error = typeof token.error === "string" ? token.error : "unknown";
		const description = typeof token.error_description === "string" ? token.error_description : "";
		throw new Error(`Kiro token refresh failed: ${error}${description ? `: ${description}` : ""}`);
	}
	const expiresInToken = typeof token.expiresIn === "number" ? token.expiresIn : 28800;
	// Preserve Kiro routing metadata from the incoming credential and backfill
	// the Builder ID profile for credentials created before it was persisted.
	return {
		...credentials,
		access: assertString(token.accessToken, "accessToken"),
		refresh: assertString(token.refreshToken ?? credentials.refresh, "refreshToken"),
		expires: Date.now() + expiresInToken * 1000 - OAUTH_EXPIRY_SKEW_MS,
		kiroMethod: credentials.kiroMethod ?? "builder-id",
		kiroProfileArn: credentials.kiroProfileArn ?? KIRO_BUILDER_ID_PROFILE_ARN,
	};
}
