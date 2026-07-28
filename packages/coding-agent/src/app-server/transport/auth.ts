// app-server WebSocket authentication: exact mirror of the pinned upstream
// AppServerWebsocketAuthArgs at codex commit 81da9deb.
//
// Flags (golden-tested against the vendored behavior.json cli.AppServerWebsocketAuthArgs):
//   --ws-auth capability-token|signed-bearer-token  (mode selector; required on non-loopback)
//   --ws-token-file <PATH>                          (capability-token: non-empty trimmed file contents are the expected token)
//   --ws-token-sha256 <HEX>                         (capability-token: exactly 64 hexadecimal characters; expected SHA-256 of presented token)
//                                                   (--ws-token-file and --ws-token-sha256 are MUTUALLY EXCLUSIVE)
//   --ws-shared-secret-file <PATH>                  (signed-bearer-token: file-only signing secret, at least 32 UTF-8 bytes after trimming)
//   --ws-issuer <STRING>                            (signed-bearer-token: expected JWT iss claim)
//   --ws-audience <STRING>                          (signed-bearer-token: expected JWT aud claim)
//   --ws-max-clock-skew-seconds <NUMBER>            (signed-bearer-token: exp/nbf tolerance)
//
// The token is accepted ONLY from the Authorization header during the HTTP upgrade, before
// server.upgrade(...). No ?token= query parameter. Missing/invalid -> HTTP 401 pre-handshake.

export type WsAuthMode = "capability-token" | "signed-bearer-token";

export interface WsAuthConfig {
	mode: WsAuthMode;
	/** capability-token: source path supplied through --ws-token-file. */
	tokenFile?: string;
	/** capability-token: expected token resolved from --ws-token-file before binding. */
	expectedToken?: string;
	/** capability-token: expected SHA-256 hex of the presented token (--ws-token-sha256). */
	tokenSha256?: string;
	/** signed-bearer-token: source path supplied through --ws-shared-secret-file. */
	sharedSecretFile?: string;
	/** signed-bearer-token: signing secret resolved before binding. */
	sharedSecret?: string;
	/** signed-bearer-token: expected issuer (iss). */
	issuer?: string;
	/** signed-bearer-token: expected audience (aud). */
	audience?: string;
	/** signed-bearer-token: max clock skew in seconds for exp/nbf. */
	maxClockSkewSeconds?: number;
}

export interface WsAuthCheckResult {
	readonly ok: boolean;
	readonly statusCode: number;
	readonly statusMessage: string;
	readonly wwwAuthenticate?: string;
}

/** Opaque constant-time comparison for two equal-length strings. */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function sha256Hex(input: string): string {
	const { createHash } = require("node:crypto");
	return createHash("sha256").update(input).digest("hex");
}

const MIN_SHARED_SECRET_BYTES = 32;

function readRequiredCredential(path: string, flag: string, minimumBytes = 1): string {
	let value: string;
	try {
		const { readFileSync } = require("node:fs");
		value = readFileSync(path, "utf-8").trim();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`cannot read ${flag} file '${path}': ${reason}`);
	}
	if (!value) throw new Error(`${flag} file '${path}' must not be empty or whitespace-only`);
	if (Buffer.byteLength(value, "utf-8") < minimumBytes) {
		throw new Error(`${flag} file '${path}' must contain at least ${minimumBytes} UTF-8 bytes`);
	}
	return value;
}

/**
 * Validate the CLI flags into a config object, or throw with a validation error message.
 * Enforces: mode required for non-loopback; token-file XOR token-sha256 for capability-token;
 * shared-secret-file required for signed-bearer-token.
 */
export function parseWsAuthFlags(flags: Record<string, string | undefined>): WsAuthConfig {
	const mode = flags["ws-auth"] as WsAuthMode | undefined;
	if (mode !== "capability-token" && mode !== "signed-bearer-token") {
		throw new Error("--ws-auth must be 'capability-token' or 'signed-bearer-token'");
	}
	const tokenFile = flags["ws-token-file"];
	const tokenSha256 = flags["ws-token-sha256"];
	const sharedSecretFile = flags["ws-shared-secret-file"];

	if (mode === "capability-token") {
		// Mutually exclusive: exactly one of file or sha256.
		if (tokenFile && tokenSha256) {
			throw new Error("--ws-token-file and --ws-token-sha256 are mutually exclusive");
		}
		if (!tokenFile && !tokenSha256) {
			throw new Error("capability-token requires exactly one of --ws-token-file or --ws-token-sha256");
		}
		if (tokenSha256 && !/^[0-9a-f]{64}$/i.test(tokenSha256)) {
			throw new Error("--ws-token-sha256 must be exactly 64 hexadecimal characters");
		}
		return {
			mode,
			tokenFile,
			expectedToken: tokenFile ? readRequiredCredential(tokenFile, "--ws-token-file") : undefined,
			tokenSha256: tokenSha256?.toLowerCase(),
		};
	}

	// signed-bearer-token
	if (!sharedSecretFile) {
		throw new Error("signed-bearer-token requires --ws-shared-secret-file");
	}
	const maxClockSkewSeconds = flags["ws-max-clock-skew-seconds"]
		? Number(flags["ws-max-clock-skew-seconds"])
		: undefined;
	if (maxClockSkewSeconds !== undefined && (!Number.isInteger(maxClockSkewSeconds) || maxClockSkewSeconds < 0)) {
		throw new Error("--ws-max-clock-skew-seconds must be a non-negative integer");
	}
	return {
		mode,
		sharedSecretFile,
		sharedSecret: readRequiredCredential(sharedSecretFile, "--ws-shared-secret-file", MIN_SHARED_SECRET_BYTES),
		issuer: flags["ws-issuer"],
		audience: flags["ws-audience"],
		maxClockSkewSeconds,
	};
}

/**
 * Check an incoming HTTP upgrade request against the auth config.
 * Extracts the token from the Authorization header only (no query param).
 * Returns a 401 result on failure, or { ok: true } on success.
 */
export function checkWsAuth(
	config: WsAuthConfig,
	headers: Record<string, string | string[] | undefined>,
): WsAuthCheckResult {
	// Token is accepted ONLY from the Authorization header.
	const authHeader = getHeader(headers, "authorization");
	if (!authHeader) {
		return { ok: false, statusCode: 401, statusMessage: "Missing Authorization header", wwwAuthenticate: "Bearer" };
	}
	// Strip "Bearer " prefix if present.
	const presentedToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
	if (!presentedToken) {
		return { ok: false, statusCode: 401, statusMessage: "Empty token", wwwAuthenticate: "Bearer" };
	}

	if (config.mode === "capability-token") {
		return checkCapabilityToken(config, presentedToken);
	}
	return checkSignedBearerToken(config, presentedToken);
}

function checkCapabilityToken(config: WsAuthConfig, presentedToken: string): WsAuthCheckResult {
	if (config.expectedToken !== undefined) {
		if (constantTimeEqual(presentedToken, config.expectedToken))
			return { ok: true, statusCode: 200, statusMessage: "OK" };
	} else if (config.tokenSha256) {
		const hash = sha256Hex(presentedToken);
		if (constantTimeEqual(hash, config.tokenSha256)) {
			return { ok: true, statusCode: 200, statusMessage: "OK" };
		}
	}
	return { ok: false, statusCode: 401, statusMessage: "Invalid token", wwwAuthenticate: "Bearer" };
}

function checkSignedBearerToken(config: WsAuthConfig, presentedToken: string): WsAuthCheckResult {
	// Minimal JWT verification: header.payload.signature with HMAC-SHA256.
	const secret = config.sharedSecret;
	if (!secret) return { ok: false, statusCode: 401, statusMessage: "Invalid server authentication configuration" };
	const parts = presentedToken.split(".");
	if (parts.length !== 3) {
		return { ok: false, statusCode: 401, statusMessage: "Malformed token", wwwAuthenticate: "Bearer" };
	}
	const [headerB64, payloadB64, signatureB64] = parts;
	let header: Record<string, unknown>;
	try {
		header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf-8")) as Record<string, unknown>;
		if (!header || typeof header !== "object" || Array.isArray(header) || header.alg !== "HS256") {
			throw new Error("unsupported JWT algorithm");
		}
	} catch {
		return { ok: false, statusCode: 401, statusMessage: "Malformed token", wwwAuthenticate: "Bearer" };
	}
	const signedData = `${headerB64}.${payloadB64}`;
	const expectedSig = require("node:crypto").createHmac("sha256", secret).update(signedData).digest("base64url");
	if (!constantTimeEqual(signatureB64, expectedSig)) {
		return { ok: false, statusCode: 401, statusMessage: "Invalid signature", wwwAuthenticate: "Bearer" };
	}
	// Decode payload. Malformed base64 or non-JSON payload returns 401, not an exception.
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as Record<string, unknown>;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("not an object");
	} catch {
		return { ok: false, statusCode: 401, statusMessage: "Malformed token payload", wwwAuthenticate: "Bearer" };
	}
	const now = Math.floor(Date.now() / 1000);
	const skew = config.maxClockSkewSeconds ?? 0;
	// exp/nbf checks. `exp` is REQUIRED and must be FINITE: a missing exp, or a non-finite
	// one such as `1e309` (which JSON.parse yields as Infinity), would never expire.
	const exp = typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : undefined;
	if (exp === undefined) {
		return { ok: false, statusCode: 401, statusMessage: "Token missing exp", wwwAuthenticate: "Bearer" };
	}
	if (now > exp + skew) {
		return { ok: false, statusCode: 401, statusMessage: "Token expired", wwwAuthenticate: "Bearer" };
	}
	if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf))) {
		return { ok: false, statusCode: 401, statusMessage: "Token has invalid nbf", wwwAuthenticate: "Bearer" };
	}
	const nbf = payload.nbf;
	if (nbf !== undefined && now + skew < nbf) {
		return { ok: false, statusCode: 401, statusMessage: "Token not yet valid", wwwAuthenticate: "Bearer" };
	}
	// iss/aud checks.
	if (config.issuer && payload.iss !== config.issuer) {
		return { ok: false, statusCode: 401, statusMessage: "Invalid issuer", wwwAuthenticate: "Bearer" };
	}
	if (config.audience && payload.aud !== config.audience) {
		return { ok: false, statusCode: 401, statusMessage: "Invalid audience", wwwAuthenticate: "Bearer" };
	}
	return { ok: true, statusCode: 200, statusMessage: "OK" };
}

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
	const value = headers[name] ?? headers[name.toLowerCase()];
	return Array.isArray(value) ? value[0] : value;
}
