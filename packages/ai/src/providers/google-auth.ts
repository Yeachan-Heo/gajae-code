/**
 * Application Default Credentials (ADC) resolution for Vertex AI.
 *
 * Replaces `google-auth-library` with a direct WebCrypto + REST implementation.
 * Sources, in priority order:
 *   1. `GOOGLE_APPLICATION_CREDENTIALS` env → file with `type: "service_account"` (RS256 JWT exchange),
 *     `type: "authorized_user"` (refresh-token exchange), or `type: "external_account"` (Workload Identity
 *     Federation: subject token from `credential_source` → STS token exchange → optional service-account
 *     impersonation).
 *   2. `~/.config/gcloud/application_default_credentials.json` (user ADC, same authorized_user flow).
 *   3. GCE / Cloud Run metadata server (`metadata.google.internal`).
 *
 * Tokens are cached per source key and refreshed `GOOGLE_VERTEX_REFRESH_SKEW_MS` before expiry
 * (default 60s). Concurrent callers waiting on a refresh share the same in-flight promise.
 */

import { Buffer } from "node:buffer";
import * as path from "node:path";
import { $credentialEnv, $envpos, getTrustedHomeDir, isEnoent, logger } from "@gajae-code/utils";
import type { FetchImpl } from "../types";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const STS_TOKEN_URL = "https://sts.googleapis.com/v1/token";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const SAML_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:saml2";
const DEFAULT_IMPERSONATION_LIFETIME_SEC = 3600;
const DEFAULT_EXECUTABLE_TIMEOUT_MS = 30_000;

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

/** `credential_source.format` for file/url sources: plain text (default) or a JSON field. */
interface SubjectTokenFormat {
	type?: "text" | "json";
	subject_token_field_name?: string;
}

interface FileCredentialSource {
	file: string;
	format?: SubjectTokenFormat;
}

interface UrlCredentialSource {
	url: string;
	headers?: Record<string, string>;
	format?: SubjectTokenFormat;
}

interface ExecutableCredentialSource {
	executable: {
		command: string;
		timeout_millis?: number;
		output_file?: string;
	};
}

type CredentialSource = FileCredentialSource | UrlCredentialSource | ExecutableCredentialSource;

/**
 * Workload Identity Federation configuration, as written by `gcloud iam workload-identity-pools
 * create-cred-config` and `google-github-actions/auth`.
 */
interface ExternalAccountCredentials {
	type: "external_account";
	audience: string;
	subject_token_type: string;
	token_url?: string;
	service_account_impersonation_url?: string;
	service_account_impersonation?: { token_lifetime_seconds?: number };
	credential_source: CredentialSource;
}

type AdcFileCredentials = ServiceAccountCredentials | AuthorizedUserCredentials | ExternalAccountCredentials;

/** Response of the executable credential source, per the external-account spec (version 1). */
interface ExecutableResponse {
	version: number;
	success: boolean;
	token_type?: string;
	id_token?: string;
	saml_response?: string;
	expiration_time?: number;
	code?: string;
	message?: string;
}

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
	return path.join(getTrustedHomeDir(), ".config", "gcloud", "application_default_credentials.json");
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

/** Pulls the subject token out of a file/url source body according to its declared format. */
function extractSubjectToken(raw: string, format: SubjectTokenFormat | undefined, origin: string): string {
	let token: unknown;
	if (format?.type === "json") {
		const field = format.subject_token_field_name;
		if (!field)
			throw new Error(`external_account credential_source ${origin}: json format requires subject_token_field_name`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(`external_account credential_source ${origin}: subject token is not valid JSON`);
		}
		token = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)[field] : undefined;
	} else {
		token = raw.trim();
	}
	if (typeof token !== "string" || token.length === 0) {
		throw new Error(`external_account credential_source ${origin}: subject token is empty`);
	}
	return token;
}

async function readSubjectTokenFromExecutable(
	creds: ExternalAccountCredentials,
	source: ExecutableCredentialSource,
): Promise<string> {
	// Same opt-in the official client libraries require: the credential file names a
	// command to run, so the operator must explicitly allow it.
	if ($credentialEnv("GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES") !== "1") {
		throw new Error(
			"external_account executable credential_source requires GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1",
		);
	}
	const { command, timeout_millis, output_file } = source.executable;
	const argv = command.trim().split(/\s+/);
	if (!argv[0]) throw new Error("external_account executable credential_source: command is empty");
	const env: Record<string, string | undefined> = {
		...process.env,
		GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE: creds.audience,
		GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE: creds.subject_token_type,
		GOOGLE_EXTERNAL_ACCOUNT_INTERACTIVE: "0",
	};
	const impersonated = creds.service_account_impersonation_url?.match(/serviceAccounts\/([^/:]+)/)?.[1];
	if (impersonated) env.GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL = impersonated;
	if (output_file) env.GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE = output_file;

	const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
	const timeout = setTimeout(() => proc.kill(), timeout_millis ?? DEFAULT_EXECUTABLE_TIMEOUT_MS);
	let stdout: string;
	try {
		stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`external_account executable credential_source exited with code ${exitCode}`);
		}
	} finally {
		clearTimeout(timeout);
	}
	// The spec allows the executable to write its response to output_file instead of stdout.
	const raw = stdout.trim() || (output_file ? await Bun.file(output_file).text() : "");
	let response: ExecutableResponse;
	try {
		response = JSON.parse(raw) as ExecutableResponse;
	} catch {
		throw new Error("external_account executable credential_source returned invalid JSON");
	}
	if (response.version !== 1) {
		throw new Error(`external_account executable response version ${response.version} is not supported`);
	}
	if (!response.success) {
		throw new Error(
			`external_account executable credential_source failed (${response.code ?? "unknown"}): ${response.message ?? ""}`,
		);
	}
	if (response.expiration_time !== undefined && response.expiration_time * 1000 <= Date.now()) {
		throw new Error("external_account executable credential_source returned an expired subject token");
	}
	const token =
		response.token_type === SAML_TOKEN_TYPE
			? response.saml_response
			: response.token_type === ID_TOKEN_TYPE || response.token_type === JWT_TOKEN_TYPE
				? response.id_token
				: undefined;
	if (!token) {
		throw new Error(
			`external_account executable credential_source returned unsupported token_type ${response.token_type}`,
		);
	}
	return token;
}

async function readSubjectToken(
	creds: ExternalAccountCredentials,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<string> {
	const source = creds.credential_source;
	if (!source || typeof source !== "object") {
		throw new Error("external_account credentials are missing credential_source");
	}
	if ("file" in source) {
		let raw: string;
		try {
			raw = await Bun.file(source.file).text();
		} catch (err) {
			if (isEnoent(err)) throw new Error(`external_account credential_source file is missing: ${source.file}`);
			throw err;
		}
		return extractSubjectToken(raw, source.format, `file ${source.file}`);
	}
	if ("url" in source) {
		const response = await fetchImpl(source.url, { method: "GET", headers: source.headers ?? {}, signal });
		if (!response.ok) {
			throw new Error(`external_account credential_source url returned ${response.status}`);
		}
		return extractSubjectToken(await response.text(), source.format, "url");
	}
	if ("executable" in source) return readSubjectTokenFromExecutable(creds, source);
	throw new Error(
		"external_account credential_source must be one of file, url, or executable (AWS environment_id sources are not supported)",
	);
}

/** STS token exchange (RFC 8693) of the federated subject token for a Google access token. */
async function exchangeSubjectToken(
	creds: ExternalAccountCredentials,
	subjectToken: string,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<TokenResponse> {
	const body = new URLSearchParams({
		grant_type: TOKEN_EXCHANGE_GRANT,
		audience: creds.audience,
		scope: CLOUD_PLATFORM_SCOPE,
		requested_token_type: ACCESS_TOKEN_TYPE,
		subject_token: subjectToken,
		subject_token_type: creds.subject_token_type,
	});
	return postForToken(creds.token_url ?? STS_TOKEN_URL, body, signal, fetchImpl);
}

/** IAM Credentials `generateAccessToken` with the federated token as bearer. */
async function impersonateServiceAccount(
	creds: ExternalAccountCredentials,
	url: string,
	federatedToken: string,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<TokenResponse> {
	const lifetime = creds.service_account_impersonation?.token_lifetime_seconds ?? DEFAULT_IMPERSONATION_LIFETIME_SEC;
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${federatedToken}` },
		body: JSON.stringify({ scope: [CLOUD_PLATFORM_SCOPE], lifetime: `${lifetime}s` }),
		signal,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`Google service account impersonation failed (${response.status}): ${detail}`);
	}
	const payload = (await response.json()) as { accessToken?: string; expireTime?: string };
	if (!payload.accessToken) throw new Error("Google service account impersonation returned no accessToken");
	const expiresAtMs = payload.expireTime ? Date.parse(payload.expireTime) : Number.NaN;
	const expiresIn = Number.isFinite(expiresAtMs)
		? Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000))
		: lifetime;
	return { access_token: payload.accessToken, expires_in: expiresIn };
}

async function exchangeExternalAccount(
	creds: ExternalAccountCredentials,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<TokenResponse> {
	if (!creds.audience || !creds.subject_token_type) {
		throw new Error("external_account credentials require audience and subject_token_type");
	}
	const subjectToken = await readSubjectToken(creds, signal, fetchImpl);
	const federated = await exchangeSubjectToken(creds, subjectToken, signal, fetchImpl);
	const impersonationUrl = creds.service_account_impersonation_url;
	if (!impersonationUrl) return federated;
	return impersonateServiceAccount(creds, impersonationUrl, federated.access_token, signal, fetchImpl);
}

async function exchangeAdcCredentials(
	creds: AdcFileCredentials,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<TokenResponse> {
	switch (creds.type) {
		case "service_account":
			return exchangeJwtForToken(creds, signal, fetchImpl);
		case "authorized_user":
			return exchangeRefreshToken(creds, signal, fetchImpl);
		case "external_account":
			return exchangeExternalAccount(creds, signal, fetchImpl);
		default:
			throw new Error(
				`Unsupported Google credential type ${JSON.stringify((creds as { type?: unknown }).type)}; expected service_account, authorized_user, or external_account`,
			);
	}
}

async function resolveAccessTokenUncached(
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<{ source: string; token: TokenResponse }> {
	const adc = await loadAdcCredentials();
	if (adc) {
		const token = await exchangeAdcCredentials(adc.creds, signal, fetchImpl);
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
