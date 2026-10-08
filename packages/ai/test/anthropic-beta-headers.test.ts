import { describe, expect, it } from "bun:test";
import { buildAnthropicHeaders } from "@gajae-code/ai/providers/anthropic";

const featureBetas = ["context-management-2025-06-27", "prompt-caching-scope-2026-01-05"];
const oauthBetas = ["claude-code-20250219", "oauth-2025-04-20", ...featureBetas];

describe("Anthropic authentication-specific beta headers", () => {
	it("uses feature betas for API keys and preserves workspace routing", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api03-test",
			baseUrl: "https://api.anthropic.com",
			modelHeaders: {
				"anthropic-workspace-id": "workspace-test",
				"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
			},
		});

		expect(headers["Anthropic-Beta"].split(",")).toEqual(featureBetas);
		expect(headers["anthropic-workspace-id"]).toBe("workspace-test");
		expect(headers["X-Api-Key"]).toBe("sk-ant-api03-test");
		expect(headers.Authorization).toBeUndefined();
	});

	it("retains OAuth beta order and Bearer authentication", () => {
		const headers = buildAnthropicHeaders({ apiKey: "sk-ant-oat01-test" });

		expect(headers["Anthropic-Beta"].split(",")).toEqual(oauthBetas);
		expect(headers.Authorization).toBe("Bearer sk-ant-oat01-test");
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	it("honors explicit OAuth mode independently of the credential prefix", () => {
		const forcedApiKey = buildAnthropicHeaders({ apiKey: "sk-ant-oat01-test", isOAuth: false });
		const forcedOAuth = buildAnthropicHeaders({ apiKey: "proxy-token", isOAuth: true });

		expect(forcedApiKey["Anthropic-Beta"].split(",")).toEqual(featureBetas);
		expect(forcedApiKey["X-Api-Key"]).toBe("sk-ant-oat01-test");
		expect(forcedOAuth["Anthropic-Beta"].split(",")).toEqual(oauthBetas);
		expect(forcedOAuth.Authorization).toBe("Bearer proxy-token");
	});

	it("preserves explicitly requested extra betas and deduplicates them", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api03-test",
			extraBetas: [
				featureBetas[0],
				"fine-grained-tool-streaming-2025-05-14",
				"claude-code-20250219",
				"claude-code-20250219",
			],
		});

		expect(headers["Anthropic-Beta"].split(",")).toEqual([
			...featureBetas,
			"fine-grained-tool-streaming-2025-05-14",
			"claude-code-20250219",
		]);
	});

	it("uses API-key beta defaults for proxies and Cloudflare without changing authentication", () => {
		const proxy = buildAnthropicHeaders({ apiKey: "proxy-key", baseUrl: "https://proxy.example.com" });
		const cloudflare = buildAnthropicHeaders({ apiKey: "gateway-key", isCloudflareAiGateway: true });

		expect(proxy["Anthropic-Beta"].split(",")).toEqual(featureBetas);
		expect(proxy.Authorization).toBe("Bearer proxy-key");
		expect(proxy["X-Api-Key"]).toBeUndefined();
		expect(cloudflare["Anthropic-Beta"].split(",")).toEqual(featureBetas);
		expect(cloudflare["cf-aig-authorization"]).toBe("Bearer gateway-key");
	});
});
