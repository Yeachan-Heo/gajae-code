import { describe, expect, it } from "bun:test";
import { redactImageProviderText } from "../../src/tools/image-gen";

describe("redactImageProviderText", () => {
	it("redacts the active API key from error text", () => {
		const key = "sk-test-1234567890abcdef";
		const text = `Authorization failed for key ${key}`;
		const result = redactImageProviderText(text, key);
		expect(result).toBe("Authorization failed for key [redacted]");
	});

	it("redacts bearer tokens", () => {
		const text = "Error: bearer sk-abc1234567890qwerty failed";
		const result = redactImageProviderText(text);
		expect(result).toContain("[redacted]");
		expect(result).not.toContain("sk-abc1234567890qwerty");
	});

	it("redacts JWT tokens", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc1234567890_-";
		const text = `Token validation failed: ${jwt}`;
		const result = redactImageProviderText(text);
		expect(result).toContain("[redacted]");
		expect(result).not.toContain(jwt);
	});

	it("redacts key=value patterns", () => {
		const text = 'Config error: api_key="sk-abcdefghijklmnopqrstuvwxyz1234" invalid';
		const result = redactImageProviderText(text);
		expect(result).toContain("[redacted]");
		expect(result).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234");
	});

	it("redacts authorization header patterns", () => {
		const text = "Request failed: authorization: Bearer mysecret1234567890abcdef1234";
		const result = redactImageProviderText(text);
		expect(result).toContain("[redacted]");
		expect(result).not.toContain("mysecret1234567890abcdef1234");
	});

	it("redacts JSON credential fields without suppressing neighboring diagnostics", () => {
		const result = redactImageProviderText(
			'{"error":"bad request","x-api-key":"test-secret-1234567890","request_id":"req_123"}',
		);
		expect(result).toContain('"error":"bad request"');
		expect(result).toContain('"request_id":"req_123"');
		expect(result).toContain('"x-api-key":[redacted]');
		expect(result).not.toContain("test-secret-1234567890");
	});

	it("redacts exact active keys across multibyte chunk-like separators", () => {
		const key = "active-secret-1234567890";
		const result = redactImageProviderText(`provider said ${key.slice(0, 9)}\u200b${key.slice(9)} after ☃`, key);
		expect(result).toContain("after ☃");
		expect(result).not.toContain("active-secret");
	});

	it("truncates very long text", () => {
		const longText = "x".repeat(8192);
		const result = redactImageProviderText(longText);
		expect(result.length).toBeLessThanOrEqual(4096);
	});

	it("handles null/undefined input", () => {
		expect(redactImageProviderText(undefined)).toBe("");
		expect(redactImageProviderText(null)).toBe("");
	});

	it("handles non-string input by converting to string", () => {
		expect(redactImageProviderText(42)).toBe("42");
	});

	it("redacts separator-tolerant API keys", () => {
		const key = "sktest12345678abcd";
		const text = "Error with key sktest\n1234\r5678\tabcd";
		const result = redactImageProviderText(text, key);
		expect(result).not.toContain("sktest");
	});

	it("replaces control characters with spaces", () => {
		const text = "Error\x00\x01message";
		const result = redactImageProviderText(text);
		expect(result).toBe("Error  message");
	});
});
