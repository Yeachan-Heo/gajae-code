import { describe, expect, it } from "bun:test";
import {
	assertSafeBridgeBind,
	extractBearerToken,
	isBridgeTokenAuthorized,
	isLoopbackHost,
} from "../../src/modes/bridge/auth";

describe("bridge auth helpers", () => {
	it("extracts bearer tokens case-insensitively", () => {
		expect(extractBearerToken("Bearer abc123")).toBe("abc123");
		expect(extractBearerToken("bearer token-with-spaces ")).toBe("token-with-spaces");
		expect(extractBearerToken("Basic nope")).toBeUndefined();
		expect(extractBearerToken(undefined)).toBeUndefined();
	});

	it("authorizes only the configured bearer token", () => {
		expect(isBridgeTokenAuthorized("Bearer secret", { token: "secret" })).toBe(true);
		expect(isBridgeTokenAuthorized("Bearer wrong", { token: "secret" })).toBe(false);
		expect(isBridgeTokenAuthorized("Bearer secret-extra", { token: "secret" })).toBe(false);
		expect(isBridgeTokenAuthorized("Bearer sec", { token: "secret" })).toBe(false);
		expect(isBridgeTokenAuthorized(null, { token: "secret" })).toBe(false);
	});

	it("recognizes loopback hosts", () => {
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isLoopbackHost("example.com")).toBe(false);
	});

	it("requires TLS for every bridge bind", () => {
		expect(() => assertSafeBridgeBind({ hostname: "localhost", port: 4545, tlsConfigured: true })).not.toThrow();
		expect(() => assertSafeBridgeBind({ hostname: "0.0.0.0", port: 4545, tlsConfigured: true })).not.toThrow();
		expect(() => assertSafeBridgeBind({ hostname: "localhost", port: 4545, tlsConfigured: false })).toThrow(
			/without TLS/,
		);
		expect(() => assertSafeBridgeBind({ hostname: "0.0.0.0", port: 4545, tlsConfigured: false })).toThrow(
			/without TLS/,
		);
	});
});
