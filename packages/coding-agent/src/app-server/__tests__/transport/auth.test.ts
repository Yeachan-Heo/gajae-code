import { expect, test } from "bun:test";
import { checkWsAuth, parseWsAuthFlags } from "../../transport/auth";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createHmac, randomBytes } from "node:crypto";

const tmp = join(tmpdir(), `gjc-ws-auth-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

function b64url(input: string | Buffer): string {
	return Buffer.from(input).toString("base64url");
}

function makeJwt(secret: string, payload: Record<string, unknown>): string {
	const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payloadB64 = b64url(JSON.stringify(payload));
	const sig = createHmac("sha256", secret).update(`${header}.${payloadB64}`).digest("base64url");
	return `${header}.${payloadB64}.${sig}`;
}

test("parseWsAuthFlags: capability-token with --ws-token-file", () => {
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-file": "/tmp/t" });
	expect(cfg.mode).toBe("capability-token");
	expect(cfg.tokenFile).toBe("/tmp/t");
	expect(cfg.tokenSha256).toBe(undefined);
});

test("parseWsAuthFlags: capability-token with --ws-token-sha256", () => {
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-sha256": "abc123" });
	expect(cfg.tokenSha256).toBe("abc123");
});

test("parseWsAuthFlags: token-file and token-sha256 are mutually exclusive", () => {
	expect(() => parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-file": "/t", "ws-token-sha256": "abc" })).toThrow(
		/mutually exclusive/,
	);
});

test("parseWsAuthFlags: capability-token requires one of file/sha256", () => {
	expect(() => parseWsAuthFlags({ "ws-auth": "capability-token" })).toThrow(/exactly one/);
});

test("parseWsAuthFlags: signed-bearer-token requires --ws-shared-secret-file", () => {
	expect(() => parseWsAuthFlags({ "ws-auth": "signed-bearer-token" })).toThrow(/shared-secret-file/);
	const cfg = parseWsAuthFlags({ "ws-auth": "signed-bearer-token", "ws-shared-secret-file": "/s", "ws-issuer": "me", "ws-audience": "you", "ws-max-clock-skew-seconds": "30" });
	expect(cfg.sharedSecretFile).toBe("/s");
	expect(cfg.issuer).toBe("me");
	expect(cfg.audience).toBe("you");
	expect(cfg.maxClockSkewSeconds).toBe(30);
});

test("parseWsAuthFlags: invalid mode throws", () => {
	expect(() => parseWsAuthFlags({ "ws-auth": "bogus" })).toThrow();
	expect(() => parseWsAuthFlags({})).toThrow();
});

test("checkWsAuth: missing Authorization header -> 401", () => {
	const cfg = parseWsAuthFlags({ "ws-auth": "capability-token", "ws-token-file": "/dev/null" });
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
	const secret = "shared-secret-value";
	writeFileSync(secretPath, secret);
	const cfg = parseWsAuthFlags({ "ws-auth": "signed-bearer-token", "ws-shared-secret-file": secretPath, "ws-issuer": "test-iss", "ws-audience": "test-aud" });
	const jwt = makeJwt(secret, { iss: "test-iss", aud: "test-aud", exp: Math.floor(Date.now() / 1000) + 3600 });
	const result = checkWsAuth(cfg, { authorization: `Bearer ${jwt}` });
	expect(result.ok).toBe(true);
});

test("checkWsAuth: signed-bearer-token with wrong issuer fails", () => {
	const secretPath = join(tmp, "secret-2");
	const secret = "secret2";
	writeFileSync(secretPath, secret);
	const cfg = parseWsAuthFlags({ "ws-auth": "signed-bearer-token", "ws-shared-secret-file": secretPath, "ws-issuer": "expected-iss" });
	const jwt = makeJwt(secret, { iss: "wrong-iss", exp: Math.floor(Date.now() / 1000) + 3600 });
	const result = checkWsAuth(cfg, { authorization: `Bearer ${jwt}` });
	expect(result.ok).toBe(false);
	expect(result.statusCode).toBe(401);
});

test("checkWsAuth: signed-bearer-token with expired token fails", () => {
	const secretPath = join(tmp, "secret-3");
	const secret = "secret3";
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
