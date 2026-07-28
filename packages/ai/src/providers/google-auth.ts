/**
 * Application Default Credentials (ADC) resolution for Vertex AI.
 *
 * Replaces `google-auth-library` with a direct WebCrypto + REST implementation.
 * Sources, in priority order:
 *   1. `GOOGLE_APPLICATION_CREDENTIALS` env → file with `type: "service_account"` (RS256 JWT exchange)
 *     or `type: "authorized_user"` (refresh-token exchange).
 *   2. `~/.config/gcloud/application_default_credentials.json` (user ADC, same authorized_user flow).
 *   3. GCE / Cloud Run metadata server (`metadata.google.internal`).
 *
 * Tokens are cached per source key and refreshed `GOOGLE_VERTEX_REFRESH_SKEW_MS` before expiry
 * (default 60s). Concurrent callers waiting on a refresh share the same in-flight promise.
 */

import { Buffer } from "node:buffer";
import * as os from "node:os";
import * as path from "node:path";
import { $credentialEnv, $envpos, isEnoent, logger } from "@gajae-code/utils";
import type { FetchImpl } from "../types";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

interface CachedToken {
	token: string;
	expiresAtMs: number;
}

interface ServiceAccountCredentials {
	type: "service_account";
	client_email: string;
	private_key: string;
	private_key_id?: string;
}

interface AuthorizedUserCredentials {
	type: "authorized_user";
	client_id: string;
	client_secret: string;
	refresh_token: string;
}

type AdcFileCredentials = ServiceAccountCredentials | AuthorizedUserCredentials;

interface TokenResponse {
	access_token: string;
	expires_in: number;
	token_type?: string;
}

const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();

function getRefreshSkewMs(): number {
	return $envpos("GOOGLE_VERTEX_REFRESH_SKEW_MS", 60_000);
}

function userAdcPath(): string {
	return path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
	try {
		return (await Bun.file(filePath).json()) as T;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

/** Test seam: the ADC credentials file path as resolved from trusted env. */
export function resolveAdcCredentialsPathForTest(): string | undefined {
	return $credentialEnv("GOOGLE_APPLICATION_CREDENTIALS");
}

async function loadAdcCredentials(): Promise<{ source: string; creds: AdcFileCredentials } | undefined> {
	// Trusted sources only: this path is read as service-account / authorized-user
	// credentials and exchanged for a Google access token, so whatever can set it
	// chooses the identity the agent authenticates as. `Bun.env` is `process.env`
	// and the env module merges the caller's `cwd/.env` into it, so reading it
	// there would let repository content point this at a key file it ships.
	// `stream.ts` already resolves the same variable through `$credentialEnv`.
	const gacPath = $credentialEnv("GOOGLE_APPLICATION_CREDENTIALS");
	if (gacPath) {
		const creds = await readJsonFile<AdcFileCredentials>(gacPath);
		if (!creds) {
			throw new Error(`GOOGLE_APPLICATION_CREDENTIALS points to a missing file: ${gacPath}`);
		}
		return { source: `gac:${gacPath}`, creds };
	}
	const userPath = userAdcPath();
	const creds = await readJsonFile<AdcFileCredentials>(userPath);
	if (creds) return { source: `user:${userPath}`, creds };
	return undefined;
}

function base64UrlEncode(bytes: Uint8Array | string): string {
	const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
	return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("base64url");
}

function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
	const body = pem
		.replace(/-----BEGIN [^-]+-----/g, "")
		.replace(/-----END [^-]+-----/g, "")
		.replace(/\s+/g, "");
	if (!body) throw new Error("Invalid PEM: empty body");
	return Uint8Array.fromBase64(body);
}

async function signJwtRs256(claims: Record<string, unknown>, privateKeyPem: string, keyId?: string): Promise<string> {
	const header: Record<string, unknown> = { alg: "RS256", typ: "JWT" };
	if (keyId) header.kid = keyId;
	const payload = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;

	const key = await globalThis.crypto.subtle.importKey(
		"pkcs8",
		pemToPkcs8(privateKeyPem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(
		await globalThis.crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(payload)),
	);
	return `${payload}.${base64UrlEncode(signature)}`;
}

async function exchangeJwtForToken(
	creds: ServiceAccountCredentials,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<TokenResponse> {
	const now = Math.floor(Date.now() / 1000);
	const assertion = await signJwtRs256(
		{
			iss: creds.client_email,
			scope: CLOUD_PLATFORM_SCOPE,
			aud: OAUTH_TOKEN_URL,
			exp: now + 3600,
			iat: now,
		},
		creds.private_key,
		creds.private_key_id,
	);
	const body = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion });
	return postForToken(OAUTH_TOKEN_URL, body, signal, fetchImpl);
}

async function exchangeRefreshToken(
	creds: AuthorizedUserCredentials,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<TokenResponse> {
	const body = new URLSearchParams({
		client_id: creds.client_id,
		client_secret: creds.client_secret,
		refresh_token: creds.refresh_token,
		grant_type: "refresh_token",
	});
	return postForToken(OAUTH_TOKEN_URL, body, signal, fetchImpl);
}

async function fetchMetadataToken(
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<TokenResponse | undefined> {
	const timeout = AbortSignal.timeout(2000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		const response = await fetchImpl(METADATA_TOKEN_URL, {
			method: "GET",
			headers: { "Metadata-Flavor": "Google" },
			signal: combined,
		});
		if (!response.ok) return undefined;
		return (await response.json()) as TokenResponse;
	} catch {
		return undefined;
	}
}

async function postForToken(
	url: string,
	body: URLSearchParams,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<TokenResponse> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
		signal,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`Google OAuth token exchange failed (${response.status}): ${detail}`);
	}
	return (await response.json()) as TokenResponse;
}

async function resolveAccessTokenUncached(
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<{ source: string; token: TokenResponse }> {
	const adc = await loadAdcCredentials();
	if (adc) {
		const token =
			adc.creds.type === "service_account"
				? await exchangeJwtForToken(adc.creds, signal, fetchImpl)
				: await exchangeRefreshToken(adc.creds, signal, fetchImpl);
		return { source: adc.source, token };
	}
	const metadata = await fetchMetadataToken(signal, fetchImpl);
	if (metadata) return { source: "metadata", token: metadata };
	throw new Error(
		"Vertex AI requires Application Default Credentials. Set GOOGLE_APPLICATION_CREDENTIALS, run `gcloud auth application-default login`, or run on a GCE/Cloud Run instance with a service account.",
	);
}

/**
 * Returns a Bearer access token suitable for the `Authorization` header on Vertex AI calls.
 * The token is cached in module scope and refreshed `GOOGLE_VERTEX_REFRESH_SKEW_MS` ms before it expires.
 */
export async function getVertexAccessToken(options?: { signal?: AbortSignal; fetch?: FetchImpl }): Promise<string> {
	const fetchImpl = options?.fetch ?? globalThis.fetch.bind(globalThis);
	const skew = getRefreshSkewMs();
	const now = Date.now();

	// Best-effort cache key probe: we don't know the source until we resolve, but cached entries
	// are keyed by their resolved source. Try every cached source first.
	for (const [source, cached] of tokenCache) {
		if (cached.expiresAtMs - skew > now) return cached.token;
		// expired entry — drop and re-resolve
		tokenCache.delete(source);
	}

	const cacheKey = "vertex-adc";
	const existing = inflight.get(cacheKey);
	if (existing) return existing;

	const promise = (async () => {
		try {
			const { source, token } = await resolveAccessTokenUncached(options?.signal, fetchImpl);
			const expiresAtMs = Date.now() + Math.max(0, token.expires_in * 1000);
			tokenCache.set(source, { token: token.access_token, expiresAtMs });
			logger.debug("vertex.adc acquired access token", { source, expiresInSec: token.expires_in });
			return token.access_token;
		} finally {
			inflight.delete(cacheKey);
		}
	})();
	inflight.set(cacheKey, promise);
	return promise;
}

/** Test seam: clears every cached token. */
export function __resetVertexTokenCache(): void {
	tokenCache.clear();
	inflight.clear();
}
