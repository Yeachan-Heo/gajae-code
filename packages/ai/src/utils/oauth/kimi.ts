/**
 * Kimi Code OAuth flow (device authorization grant)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { $pickCredentialEnv, getAgentDir, isEnoent } from "@gajae-code/utils";
import packageJson from "../../../package.json" with { type: "json" };
import type { OAuthController, OAuthCredentials } from "./types";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_ID_FILENAME = "kimi-device-id";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface DeviceAuthorizationResponse {
	user_code?: string;
	device_code?: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
	interval?: number;
}

/**
 * OAuth host for the device flow, from trusted environment sources only.
 *
 * This host receives the device-authorization request, the authorization-code
 * exchange, and the refresh call that carries the existing refresh token, so
 * whatever can set it can collect the user's Kimi credentials. `$env` merges the
 * caller's `cwd/.env`, so reading it there would let repository content redirect
 * the login flow. Resolve it the same way the credentials themselves are:
 * launching shell plus GJC/user-owned `.env` files, never the project `.env`.
 */
function resolveOAuthHost(): string {
	return $pickCredentialEnv("KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST") || DEFAULT_OAUTH_HOST;
}

/** Test seam: the OAuth host as resolved from trusted env. */
export function resolveKimiOAuthHostForTest(): string {
	return resolveOAuthHost();
}

function formatDeviceModel(system: string, release: string, arch: string): string {
	return [system, release, arch].filter(Boolean).join(" ").trim();
}

function getDeviceModel(): string {
	const platform = os.platform();
	const release = os.release();
	const arch = os.arch();
	if (platform === "darwin") return formatDeviceModel("macOS", release, arch);
	if (platform === "win32") return formatDeviceModel("Windows", release, arch);
	const label = platform === "linux" ? "Linux" : platform;
	return formatDeviceModel(label, release, arch);
}

let getDeviceId = (): string => {
	const deviceIdPath = path.join(getAgentDir(), DEVICE_ID_FILENAME);
	try {
		const existing = fs.readFileSync(deviceIdPath, "utf-8");
		const trimmed = existing.trim();
		if (trimmed) {
			getDeviceId = () => trimmed;
			return trimmed;
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const deviceId = crypto.randomUUID().replace(/-/g, "");
	fs.writeFileSync(deviceIdPath, `${deviceId}\n`, { mode: 0o600 });
	getDeviceId = () => deviceId;
	return deviceId;
};

export let getKimiCommonHeaders = () => {
	const headers = Object.freeze({
		"User-Agent": `KimiCLI/${packageJson.version}`,
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": packageJson.version,
		"X-Msh-Device-Name": os.hostname(),
		"X-Msh-Device-Model": getDeviceModel(),
		"X-Msh-Os-Version": os.version(),
		"X-Msh-Device-Id": getDeviceId(),
	});
	getKimiCommonHeaders = () => headers;
	return headers;
};

async function requestDeviceAuthorization(): Promise<{
	userCode: string;
	deviceCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresInMs: number;
	intervalMs: number;
}> {
	const response = await fetch(`${resolveOAuthHost()}/api/oauth/device_authorization`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getKimiCommonHeaders(),
		},
		body: new URLSearchParams({ client_id: CLIENT_ID }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Kimi device authorization failed: ${response.status} ${text}`);
	}

	const payload = (await response.json()) as DeviceAuthorizationResponse;
	const userCode = payload.user_code;
	const deviceCode = payload.device_code;
	const verificationUri = payload.verification_uri;
	const verificationUriComplete = payload.verification_uri_complete;

	if (!userCode || !deviceCode || !verificationUri) {
		throw new Error("Kimi device authorization response missing required fields");
	}

	const expiresInMs = typeof payload.expires_in === "number" ? payload.expires_in * 1000 : DEFAULT_DEVICE_FLOW_TTL_MS;
	const intervalMs =
		typeof payload.interval === "number" && payload.interval > 0 ? payload.interval * 1000 : DEFAULT_POLL_INTERVAL_MS;

	return {
		userCode,
		deviceCode,
		verificationUri,
		verificationUriComplete: verificationUriComplete || verificationUri,
		expiresInMs,
		intervalMs,
	};
}

function parseTokenPayload(payload: TokenResponse, refreshTokenFallback?: string): OAuthCredentials {
	if (!payload.access_token || typeof payload.expires_in !== "number") {
		throw new Error("Kimi token response missing required fields");
	}

	const refresh = payload.refresh_token ?? refreshTokenFallback;
	if (!refresh) {
		throw new Error("Kimi token response missing refresh token");
	}

	return {
		access: payload.access_token,
		refresh,
		expires: Date.now() + payload.expires_in * 1000 - OAUTH_EXPIRY_SKEW_MS,
	};
}

async function pollForToken(
	deviceCode: string,
	intervalMs: number,
	expiresInMs: number,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const deadline = Date.now() + expiresInMs;
	let waitMs = Math.max(1000, intervalMs);

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				...getKimiCommonHeaders(),
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		const payload = (await response.json()) as TokenResponse;
		if (response.ok && payload.access_token) {
			return parseTokenPayload(payload);
		}

		const error = payload.error;
		if (error === "authorization_pending") {
			await scheduler.wait(waitMs, { signal });
			continue;
		}

		if (error === "slow_down") {
			waitMs += 5000;
			const retryAfter = typeof payload.interval === "number" ? payload.interval * 1000 : undefined;
			if (retryAfter && retryAfter > waitMs) waitMs = retryAfter;
			await scheduler.wait(waitMs, { signal });
			continue;
		}

		if (error === "expired_token") {
			throw new Error("Kimi device authorization expired");
		}

		if (error === "access_denied") {
			throw new Error("Kimi device authorization denied");
		}

		const description = payload.error_description ? `: ${payload.error_description}` : "";
		throw new Error(`Kimi device flow failed: ${error ?? response.status}${description}`);
	}

	throw new Error("Kimi device flow timed out");
}

/**
 * Login with Kimi Code OAuth (device code flow).
 */
export async function loginKimi(options: OAuthController): Promise<OAuthCredentials> {
	const device = await requestDeviceAuthorization();
	options.onAuth?.({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});

	return pollForToken(device.deviceCode, device.intervalMs, device.expiresInMs, options.signal);
}

/**
 * Refresh Kimi OAuth token.
 */
export async function refreshKimiToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getKimiCommonHeaders(),
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => undefined)) as TokenResponse | undefined;
		const description = payload?.error_description ? `: ${payload.error_description}` : "";
		throw new Error(`Kimi token refresh failed: ${response.status}${description}`);
	}

	const payload = (await response.json()) as TokenResponse;
	return parseTokenPayload(payload, refreshToken);
}
