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

	it("redacts credential shapes that are shorter than the generic catch-all", () => {
		// All synthetic. The trailing catch-all only fires at 40+ characters, so
		// fixed-width credentials below it were never reached: AWS access-key ids
		// are 20 characters and a Google API key is exactly 39.
		const cases = {
			awsLongTerm: "AKIAIOSFODNN7EXAMPLE",
			awsTemporary: "ASIAIOSFODNN7EXAMPLE",
			awsBearer: "ABIAIOSFODNN7EXAMPLE",
			awsContext: "ACCAIOSFODNN7EXAMPLE",
			googleApiKey: `AIza${"S".repeat(35)}`,
		};
		for (const value of Object.values(cases)) {
			const result = redactImageProviderText(`provider returned ${value} in the body`);
			expect(result).not.toContain(value);
			expect(result).toContain("provider returned");
		}
	});

	it("redacts GitHub tokens, which separate with an underscore", () => {
		// The prefix rule lists `ghp`/`gho`/`github_pat` but requires a `-`
		// separator, so it never matched a real token. Anything under the 40-char
		// catch-all therefore survived.
		for (const token of [`ghp_${"a".repeat(20)}`, `gho_${"b".repeat(20)}`, `ghs_${"c".repeat(20)}`]) {
			const result = redactImageProviderText(`upload used ${token}`);
			expect(result).not.toContain(token);
			expect(result).toContain("upload used");
		}
	});

	it("redacts PEM key material and URL userinfo", () => {
		const pemBody = "MIIEowIBAAKCAQEAxGZ0000abcdefgHIJKLmnop";
		const pem = redactImageProviderText(
			`load failed -----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY----- here`,
		);
		expect(pem).not.toContain(pemBody);
		expect(pem).toContain("load failed");

		const url = redactImageProviderText("fetch https://deploy:s3cr3tvalue@assets.example.com/a.png failed");
		expect(url).not.toContain("s3cr3tvalue");
		// Scheme and host stay readable so the error still says which host failed.
		expect(url).toContain("assets.example.com");
	});
	it("redacts the vendor tokens the egress guard classifies as credential-like", () => {
		// `crash/upstream/envelope.ts` refuses to transmit these four shapes.
		// Assembled at runtime so no literal of this shape is committed.
		const cases = {
			npm: ["npm", "a".repeat(36)].join("_"),
			gitlab: ["glpat", "b".repeat(24)].join("-"),
			stripe: ["sk", "live", "c".repeat(24)].join("_"),
			huggingface: ["hf", "d".repeat(34)].join("_"),
		};
		for (const value of Object.values(cases)) {
			const out = redactImageProviderText(`observed ${value} in the log`);
			expect(out).not.toContain(value);
			expect(out).toContain("observed");
		}
	});

	it("keeps vendor prefix lookalikes that are too short to be tokens", () => {
		for (const benign of ["npm install express", "the hf_ prefix", "glpat-short"]) {
			expect(redactImageProviderText(benign)).toContain(benign.split(" ")[0]);
		}
	});
});
