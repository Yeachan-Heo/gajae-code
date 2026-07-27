// app-server WebSocket authentication: exact mirror of the pinned upstream
// AppServerWebsocketAuthArgs at codex commit 81da9deb.
//
// Flags (golden-tested against the vendored behavior.json cli.AppServerWebsocketAuthArgs):
//   --ws-auth capability-token|signed-bearer-token  (mode selector; required on non-loopback)
//   --ws-token-file <PATH>                          (capability-token: trimmed file contents are the expected token)
//   --ws-token-sha256 <HEX>                         (capability-token: expected SHA-256 of presented token)
//                                                   (--ws-token-file and --ws-token-sha256 are MUTUALLY EXCLUSIVE)
//   --ws-shared-secret-file <PATH>                  (signed-bearer-token: shared signing secret, file-only, never raw CLI)
//   --ws-issuer <STRING>                            (signed-bearer-token: expected JWT iss claim)
//   --ws-audience <STRING>                          (signed-bearer-token: expected JWT aud claim)
//   --ws-max-clock-skew-seconds <NUMBER>            (signed-bearer-token: exp/nbf tolerance)
//
// The token is accepted ONLY from the Authorization header during the HTTP upgrade, before
// server.upgrade(...). No ?token= query parameter. Missing/invalid -> HTTP 401 pre-handshake.

export type WsAuthMode = "capability-token" | "signed-bearer-token";

export interface WsAuthConfig {
	mode: WsAuthMode;
	/** capability-token: expected token read from --ws-token-file (trimmed). */
	tokenFile?: string;
	/** capability-token: expected SHA-256 hex of the presented token (--ws-token-sha256). */
	tokenSha256?: string;
	/** signed-bearer-token: shared secret read from --ws-shared-secret-file. */
	sharedSecretFile?: string;
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
	// Use the built-in SubtleCrypto for browser-like environments, or Node's createHash.
	// For bun: Bun.hash is not SHA-256; use node:crypto.
	const { createHash } = require("node:crypto");
	return createHash("sha256").update(input).digest("hex");
}

function readTrimmedFile(path: string): string {
	const { readFileSync } = require("node:fs");
	return readFileSync(path, "utf-8").trim();
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
		return { mode, tokenFile, tokenSha256 };
	}

	// signed-bearer-token
	if (!sharedSecretFile) {
		throw new Error("signed-bearer-token requires --ws-shared-secret-file");
	}
	return {
		mode,
		sharedSecretFile,
		issuer: flags["ws-issuer"],
		audience: flags["ws-audience"],
		maxClockSkewSeconds: flags["ws-max-clock-skew-seconds"] ? Number(flags["ws-max-clock-skew-seconds"]) : undefined,
	};
}

/**
 * Check an incoming HTTP upgrade request against the auth config.
 * Extracts the token from the Authorization header only (no query param).
 * Returns a 401 result on failure, or { ok: true } on success.
 */
export function checkWsAuth(config: WsAuthConfig, headers: Record<string, string | string[] | undefined>): WsAuthCheckResult {
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
	if (config.tokenFile) {
		const expected = readTrimmedFile(config.tokenFile);
		if (constantTimeEqual(presentedToken, expected)) return { ok: true, statusCode: 200, statusMessage: "OK" };
	} else if (config.tokenSha256) {
		const hash = sha256Hex(presentedToken);
		if (constantTimeEqual(hash.toLowerCase(), config.tokenSha256.toLowerCase())) {
			return { ok: true, statusCode: 200, statusMessage: "OK" };
		}
	}
	return { ok: false, statusCode: 401, statusMessage: "Invalid token", wwwAuthenticate: "Bearer" };
}

function checkSignedBearerToken(config: WsAuthConfig, presentedToken: string): WsAuthCheckResult {
	// Minimal JWT verification: header.payload.signature with HMAC-SHA256.
	// Read the shared secret from file (never raw CLI).
	const secret = readTrimmedFile(config.sharedSecretFile!);
	const parts = presentedToken.split(".");
	if (parts.length !== 3) {
		return { ok: false, statusCode: 401, statusMessage: "Malformed token", wwwAuthenticate: "Bearer" };
	}
	const [headerB64, payloadB64, signatureB64] = parts;
	// Verify signature.
	const signedData = `${headerB64}.${payloadB64}`;
	const expectedSig = require("node:crypto")
		.createHmac("sha256", secret)
		.update(signedData)
		.digest("base64url");
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
	// exp/nbf checks.
	const exp = typeof payload.exp === "number" ? payload.exp : undefined;
	if (exp !== undefined && now > exp + skew) {
		return { ok: false, statusCode: 401, statusMessage: "Token expired", wwwAuthenticate: "Bearer" };
	}
	const nbf = typeof payload.nbf === "number" ? payload.nbf : undefined;
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
