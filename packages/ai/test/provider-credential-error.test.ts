import { afterEach, describe, expect, it } from "bun:test";
import { formatMissingApiKeyError, formatProviderCredentialHint, streamSimple } from "@gajae-code/ai/stream";
import type { Context, Model } from "@gajae-code/ai/types";

const originalOpenCodeApiKey = Bun.env.OPENCODE_API_KEY;

afterEach(() => {
	if (originalOpenCodeApiKey === undefined) delete Bun.env.OPENCODE_API_KEY;
	else Bun.env.OPENCODE_API_KEY = originalOpenCodeApiKey;
});

describe("formatProviderCredentialHint", () => {
	it("explains OpenCode Go subscription auth and the headless signal (#755)", () => {
		const hint = formatProviderCredentialHint("opencode-go");
		expect(hint).toContain("OpenCode subscriptions authenticate with an API key");
		expect(hint).toContain("https://opencode.ai/auth");
		expect(hint).toContain("not a separate session/OAuth token");
		expect(hint).toContain("OPENCODE_API_KEY");
		expect(hint).toContain("~/.gjc/.env");
		expect(hint).toContain("project .env is intentionally ignored");
		expect(hint).toContain("once before headless/print mode to store the key interactively");
		expect(hint).not.toContain("non-interactively");
	});

	it("covers opencode-zen with the same shape", () => {
		const hint = formatProviderCredentialHint("opencode-zen");
		expect(hint).toContain("OPENCODE_API_KEY");
		expect(hint).toContain("gjc auth-broker login opencode-zen");
	});

	it("names the env var for a plain env-key provider without an OpenCode note or invalid login command", () => {
		const hint = formatProviderCredentialHint("groq");
		expect(hint).toContain("GROQ_API_KEY");
		expect(hint).toContain("project .env is intentionally ignored");
		expect(hint).not.toContain("OpenCode");
		// groq is not an auth-broker OAuth provider, so we must not suggest a login that would fail.
		expect(hint).not.toContain("gjc auth-broker login");
	});

	it("returns an empty hint for providers without a static env-var key", () => {
		// anthropic resolves via a function (OAuth/foundry), so there is no single env var to name.
		expect(formatProviderCredentialHint("anthropic")).toBe("");
		expect(formatProviderCredentialHint("totally-unknown-provider")).toBe("");
	});
});

describe("formatMissingApiKeyError", () => {
	it("prefixes the base error and appends OpenCode guidance", () => {
		const message = formatMissingApiKeyError("opencode-go");
		expect(message).toContain("No API key for provider: opencode-go.");
		expect(message).toContain("OPENCODE_API_KEY");
		expect(message).toContain("once before headless/print mode to store the key interactively");
	});

	it("falls back to the bare base error for providers with no hint", () => {
		expect(formatMissingApiKeyError("anthropic")).toBe("No API key for provider: anthropic.");
	});
});

describe("streamSimple missing credentials", () => {
	it("throws OpenCode Go headless guidance on the actual no-key path (#755)", () => {
		delete Bun.env.OPENCODE_API_KEY;
		const model: Model<"openai-completions"> = {
			api: "openai-completions",
			provider: "opencode-go",
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			baseUrl: "https://opencode.ai/zen/go/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 65_536,
		};
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};

		expect(() => streamSimple(model, context)).toThrow("OpenCode subscriptions authenticate with an API key");
		expect(() => streamSimple(model, context)).toThrow("OPENCODE_API_KEY");
		expect(() => streamSimple(model, context)).toThrow("not a separate session/OAuth token");
	});
});
