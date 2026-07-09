import { describe, expect, it } from "bun:test";
import { fetchAntigravityDiscoveryModels } from "../src/utils/discovery/antigravity";

describe("Antigravity model discovery", () => {
	it("filters the advertised but non-callable gemini-3.1-pro-high selector", async () => {
		const fetcher = (async () =>
			new Response(
				JSON.stringify({
					models: {
						"gemini-3.1-pro-high": {
							displayName: "Gemini 3.1 Pro (High)",
							supportsImages: true,
							supportsThinking: true,
							maxTokens: 1_048_576,
							maxOutputTokens: 65_535,
						},
						"gemini-3.1-pro-low": {
							displayName: "Gemini 3.1 Pro (Low)",
							supportsImages: true,
							supportsThinking: true,
							maxTokens: 1_048_576,
							maxOutputTokens: 65_535,
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: "https://antigravity.example.test",
			fetcher,
		});

		expect(models?.map(model => model.id)).toEqual(["gemini-3.1-pro-low"]);
	});
});
