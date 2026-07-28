import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWsAuth, parseWsAuthFlags } from "../../transport/auth";

const tmp = join(tmpdir(), `gjc-ws-auth-${Date.now()}`);
mkdirSync(tmp, { recursive: true });
const validSecret = "0123456789abcdef0123456789abcdef";

function b64url(input: string | Buffer): string {
	return Buffer.from(input).toString("base64url");
}

function makeJwt(secret: string, payload: Record<string, unknown>): string {
	const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payloadB64 = b64url(JSON.stringify(payload));
	const sig = createHmac("sha256", secret).update(`${header}.${payloadB64}`).digest("base64url");
	return `${header}.${payloadB64}.${sig}`;
}

function makeJwtWithRawPayload(secret: string, payloadJson: string): string {
	const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payloadB64 = b64url(payloadJson);
	const sig = createHmac("sha256", secret).update(`${header}.${payloadB64}`).digest("base64url");
	return `${header}.${payloadB64}.${sig}`;
}

test("parseWsAuthFlags: capability-token with --ws-token-file", () => {
	const tokenPath = join(tmp, "parse-token");
	writeFileSync(tokenPath, "capability-token");
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-file": tokenPath });
	expect(cfg.mode).toBe("capability-token");
	expect(cfg.tokenFile).toBe(tokenPath);
	expect(cfg.expectedToken).toBe("capability-token");
	expect(cfg.tokenSha256).toBe(undefined);
});

test("parseWsAuthFlags: capability-token requires a 64-character hexadecimal SHA-256", () => {
	const hash = "A".repeat(64);
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-sha256": hash });
	expect(cfg.tokenSha256).toBe(hash.toLowerCase());
	expect(() => parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-sha256": "abc123" })).toThrow(
		/exactly 64 hexadecimal characters/,
	);
});

test("parseWsAuthFlags: token-file and token-sha256 are mutually exclusive", () => {
	expect(() =>
		parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-file": "/t", "ws-token-sha256": "abc" }),
	).toThrow(/mutually exclusive/);
});

test("parseWsAuthFlags: capability-token requires one of file/sha256", () => {
	expect(() => parseWsAuthFlags({ "ws-auth": "capability-token" })).toThrow(/exactly one/);
});

test("parseWsAuthFlags: signed-bearer-token requires --ws-shared-secret-file", () => {
	expect(() => parseWsAuthFlags({ "ws-auth": "signed-bearer-token" })).toThrow(/shared-secret-file/);
	const secretPath = join(tmp, "parse-secret");
	writeFileSync(secretPath, validSecret);
	const cfg = parseWsAuthFlags({
		"ws-auth": "signed-bearer-token",
		"ws-shared-secret-file": secretPath,
		"ws-issuer": "me",
		"ws-audience": "you",
		"ws-max-clock-skew-seconds": "30",
	});
	expect(cfg.sharedSecretFile).toBe(secretPath);
	expect(cfg.sharedSecret).toBe(validSecret);
	expect(cfg.issuer).toBe("me");
	expect(cfg.audience).toBe("you");
	expect(cfg.maxClockSkewSeconds).toBe(30);
});

test("parseWsAuthFlags: invalid mode throws", () => {
	expect(() => parseWsAuthFlags({ "ws-auth": "bogus" })).toThrow();
	expect(() => parseWsAuthFlags({})).toThrow();
});

test("checkWsAuth: missing Authorization header -> 401", () => {
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-sha256": "a".repeat(64) });
	const result = checkWsAuth(cfg, {});
	expect(result.ok).toBe(false);
	expect(result.statusCode).toBe(401);
	expect(result.wwwAuthenticate).toBe("Bearer");
});

test("checkWsAuth: capability-token via file match succeeds", () => {
	const tokenPath = join(tmp, "token-file");
	const token = "my-secret-token";
	writeFileSync(tokenPath, token);
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-file": tokenPath });
	const result = checkWsAuth(cfg, { authorization: `Bearer ${token}` });
	expect(result.ok).toBe(true);
});

test("checkWsAuth: capability-token via sha256 match succeeds", () => {
	const token = "another-token";
	const hash = createHash("sha256").update(token).digest("hex");
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-sha256": hash });
	const result = checkWsAuth(cfg, { authorization: token });
	expect(result.ok).toBe(true);
});

test("checkWsAuth: wrong token fails with 401", () => {
	const tokenPath = join(tmp, "token-file-2");
	writeFileSync(tokenPath, "correct-token");
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-file": tokenPath });
	const result = checkWsAuth(cfg, { authorization: "Bearer wrong-token" });
	expect(result.ok).toBe(false);
	expect(result.statusCode).toBe(401);
});

test("checkWsAuth: signed-bearer-token with valid JWT succeeds", () => {
	const secretPath = join(tmp, "secret");
	const secret = validSecret;
	writeFileSync(secretPath, secret);
	const cfg = parseWsAuthFlags({
		"ws-auth": "signed-bearer-token",
		"ws-shared-secret-file": secretPath,
		"ws-issuer": "test-iss",
		"ws-audience": "test-aud",
	});
	const jwt = makeJwt(secret, { iss: "test-iss", aud: "test-aud", exp: Math.floor(Date.now() / 1000) + 3600 });
	const result = checkWsAuth(cfg, { authorization: `Bearer ${jwt}` });
	expect(result.ok).toBe(true);
});

test("checkWsAuth: signed-bearer-token with wrong issuer fails", () => {
	const secretPath = join(tmp, "secret-2");
	const secret = validSecret;
	writeFileSync(secretPath, secret);
	const cfg = parseWsAuthFlags({
		"ws-auth": "signed-bearer-token",
		"ws-shared-secret-file": secretPath,
		"ws-issuer": "expected-iss",
	});
	const jwt = makeJwt(secret, { iss: "wrong-iss", exp: Math.floor(Date.now() / 1000) + 3600 });
	const result = checkWsAuth(cfg, { authorization: `Bearer ${jwt}` });
	expect(result.ok).toBe(false);
	expect(result.statusCode).toBe(401);
});

test("checkWsAuth: signed-bearer-token with expired token fails", () => {
	const secretPath = join(tmp, "secret-3");
	const secret = validSecret;
	writeFileSync(secretPath, secret);
	const cfg = parseWsAuthFlags({ "ws-auth": "signed-bearer-token", "ws-shared-secret-file": secretPath });
	const jwt = makeJwt(secret, { exp: Math.floor(Date.now() / 1000) - 3600 });
	const result = checkWsAuth(cfg, { authorization: `Bearer ${jwt}` });
	expect(result.ok).toBe(false);
	expect(result.statusCode).toBe(401);
});

test("checkWsAuth: token accepted from Authorization header only, never from query param", () => {
	const tokenPath = join(tmp, "token-file-3");
	const token = "header-only-token";
	writeFileSync(tokenPath, token);
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-file": tokenPath });
	// No Authorization header at all -> 401 even if the token is somehow known.
	expect(checkWsAuth(cfg, {}).ok).toBe(false);
});

test("checkWsAuth: signed-bearer-token with a malformed token fails", () => {
	const secretPath = join(tmp, "secret-malformed");
	writeFileSync(secretPath, validSecret);
	const cfg = parseWsAuthFlags({ "ws-auth": "signed-bearer-token", "ws-shared-secret-file": secretPath });
	const result = checkWsAuth(cfg, { authorization: "Bearer not.a.jwt" });
	expect(result.ok).toBe(false);
	expect(result.statusCode).toBe(401);
});
test("parseWsAuthFlags: rejects empty, whitespace-only, missing, and short shared-secret files", () => {
	for (const [name, contents, expected] of [
		["empty-secret", "", /must not be empty/],
		["whitespace-secret", " \n\t", /must not be empty/],
		["short-secret", "short-secret", /at least 32 UTF-8 bytes/],
	] as const) {
		const secretPath = join(tmp, name);
		writeFileSync(secretPath, contents);
		expect(() => parseWsAuthFlags({ "ws-auth": "signed-bearer-token", "ws-shared-secret-file": secretPath })).toThrow(
			expected,
		);
	}
	expect(() =>
		parseWsAuthFlags({ "ws-auth": "signed-bearer-token", "ws-shared-secret-file": join(tmp, "missing-secret") }),
	).toThrow(/cannot read --ws-shared-secret-file file/);
	const unreadableSecretPath = join(tmp, "unreadable-secret");
	mkdirSync(unreadableSecretPath, { recursive: true });
	expect(() =>
		parseWsAuthFlags({ "ws-auth": "signed-bearer-token", "ws-shared-secret-file": unreadableSecretPath }),
	).toThrow(/cannot read --ws-shared-secret-file file/);
});

test("parseWsAuthFlags: rejects an empty capability-token file", () => {
	const tokenPath = join(tmp, "empty-token");
	writeFileSync(tokenPath, " \n\t");
	expect(() => parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-file": tokenPath })).toThrow(
		/must not be empty/,
	);
});

test("checkWsAuth: uppercase token SHA-256 matches after startup canonicalization", () => {
	const token = "another-token";
	const hash = createHash("sha256").update(token).digest("hex").toUpperCase();
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-sha256": hash });
	expect(checkWsAuth(cfg, { authorization: `Bearer ${token}` }).ok).toBe(true);
});

test("checkWsAuth: uses the capability token resolved at startup", () => {
	const tokenPath = join(tmp, "resolved-token");
	writeFileSync(tokenPath, "token-at-startup");
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-file": tokenPath });
	writeFileSync(tokenPath, "changed-after-startup");
	expect(checkWsAuth(cfg, { authorization: "Bearer token-at-startup" }).ok).toBe(true);
});

test("parseWsAuthFlags: signed-bearer-token rejects an invalid clock skew", () => {
	expect(() =>
		parseWsAuthFlags({
			"ws-auth": "signed-bearer-token",
			"ws-shared-secret-file": "/tmp/secret",
			"ws-max-clock-skew-seconds": "-1",
		}),
	).toThrow(/non-negative integer/);
});

test("checkWsAuth: signed-bearer-token rejects non-finite and wrong-type exp claims", () => {
	const secretPath = join(tmp, "secret-invalid-exp-claims");
	writeFileSync(secretPath, validSecret);
	const cfg = parseWsAuthFlags({ "ws-auth": "signed-bearer-token", "ws-shared-secret-file": secretPath });
	for (const payloadJson of [
		"{}",
		'{"exp":1e309}',
		'{"exp":1e1000000}',
		'{"exp":"9999999999"}',
		'{"exp":[]}',
		'{"exp":{}}',
		'{"exp":NaN}',
	]) {
		const result = checkWsAuth(cfg, { authorization: `Bearer ${makeJwtWithRawPayload(validSecret, payloadJson)}` });
		expect(result).toMatchObject({ ok: false, statusCode: 401 });
	}
});

test("checkWsAuth: signed-bearer-token rejects non-finite and wrong-type nbf claims", () => {
	const secretPath = join(tmp, "secret-invalid-nbf-claims");
	writeFileSync(secretPath, validSecret);
	const cfg = parseWsAuthFlags({ "ws-auth": "signed-bearer-token", "ws-shared-secret-file": secretPath });
	const exp = Math.floor(Date.now() / 1000) + 3600;
	for (const nbf of ["1e309", "-1e309", "1e1000000", '"9999999999"', "[]", "{}", "NaN"]) {
		const result = checkWsAuth(cfg, {
			authorization: `Bearer ${makeJwtWithRawPayload(validSecret, `{"exp":${exp},"nbf":${nbf}}`)}`,
		});
		expect(result).toMatchObject({ ok: false, statusCode: 401 });
	}
});
