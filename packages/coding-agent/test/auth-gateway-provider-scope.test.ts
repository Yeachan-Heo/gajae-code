import { describe, expect, it } from "bun:test";
import type { AuthCredentialSnapshot } from "@gajae-code/ai/core";
import {
	assertEnabledProviderCredential,
	hasEnabledProviderCredential,
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

		expect(redacted).toBe("https://broker.example.test:8765/v1");
		expect(redacted).not.toContain("password");
		expect(redacted).not.toContain("secret");
	});
});
