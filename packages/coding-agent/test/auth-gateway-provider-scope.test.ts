import { describe, expect, it } from "bun:test";
import type { AuthCredentialSnapshot, CredentialHealthResult } from "@gajae-code/ai/core";
import {
	assertEnabledProviderCredential,
	filterCredentialCheckResults,
	hasEnabledProviderCredential,
	normalizeProviderScope,
	redactBrokerUrl,
} from "../src/cli/auth-gateway-cli";

function snapshotWithProvider(provider: string): AuthCredentialSnapshot {
	return {
		generation: 1,
		generatedAt: 0,
		credentials: [
			{
				id: 1,
				provider,
				credential: {
					type: "oauth",
					access: "access-token-is-not-output",
					refresh: "__remote__",
					expires: Date.now() + 60_000,
				},
				identityKey: "account@example.test",
			},
		],
	};
}

describe("auth-gateway broker provider scope", () => {
	it("requires an enabled credential for the selected provider", () => {
		const snapshot = snapshotWithProvider("openai-codex");

		expect(hasEnabledProviderCredential(snapshot, "openai-codex")).toBe(true);
		expect(hasEnabledProviderCredential(snapshot, "github-copilot")).toBe(false);
		expect(() => assertEnabledProviderCredential(snapshot, "github-copilot")).toThrow(
			/Auth gateway scope github-copilot has no enabled broker credential/,
		);
	});

	it("treats a disabled credential omitted from the active snapshot as unavailable", () => {
		const disabledSnapshot: AuthCredentialSnapshot = {
			generation: 2,
			generatedAt: 0,
			credentials: [],
		};

		expect(hasEnabledProviderCredential(disabledSnapshot, "openai-codex")).toBe(false);
		expect(() => assertEnabledProviderCredential(disabledSnapshot, "openai-codex")).toThrow(
			/Auth gateway scope openai-codex has no enabled broker credential/,
		);
	});

	it("redacts broker URL credentials and query secrets", () => {
		const redacted = redactBrokerUrl("https://user:password@broker.example.test:8765/v1?token=secret#fragment");

		expect(redacted).toBe("https://broker.example.test:8765");
		expect(redacted).not.toContain("password");
		expect(redacted).not.toContain("secret");
		expect(redactBrokerUrl("https://broker.example.test/capability-secret/v1")).toBe("https://broker.example.test");
	});

	it("rejects provider scopes that can inject terminal controls", () => {
		expect(normalizeProviderScope("openai-codex")).toBe("openai-codex");
		expect(normalizeProviderScope("openai\u001b]52;c\u0007")).toBeUndefined();
		expect(normalizeProviderScope(" openai-codex")).toBeUndefined();
	});

	it("filters cross-provider credential rows before JSON or text rendering", () => {
		const results: CredentialHealthResult[] = [
			{ id: 1, provider: "openai-codex", type: "oauth", ok: true },
			{ id: 2, provider: "github-copilot", type: "oauth", ok: false, reason: "foreign-secret" },
		];

		expect(filterCredentialCheckResults(results, "openai-codex")).toEqual([results[0]]);
		expect(filterCredentialCheckResults(results, undefined)).toEqual(results);
	});
});
