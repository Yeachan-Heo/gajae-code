import { describe, expect, it } from "bun:test";
import { fetchCodexModels } from "../src/utils/discovery/codex";

function response(contextWindow: unknown): Response {
	return new Response(
		JSON.stringify({
			models: [
				{
					slug: "gpt-5.6-sol",
					display_name: "GPT-5.6 Sol",
					context_window: contextWindow,
					supported_in_api: true,
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function fetchResponse(contextWindow: unknown): typeof fetch {
	return (() => Promise.resolve(response(contextWindow))) as unknown as typeof fetch;
}

describe("Codex GPT-5.6 discovery context cap", () => {
	it("uses the conservative fallback for absent metadata", async () => {
		const result = await fetchCodexModels({
			accessToken: "test-token",
			clientVersion: "0.99.0",
			fetchFn: fetchResponse(undefined),
		});
		expect(result?.models[0]?.contextWindow).toBe(272_000);
	});

	it("caps larger live metadata but preserves a smaller live cap", async () => {
		for (const [observed, expected] of [
			[373_000, 272_000],
			[200_000, 200_000],
		] as const) {
			const result = await fetchCodexModels({
				accessToken: "test-token",
				clientVersion: "0.99.0",
				fetchFn: fetchResponse(observed),
			});
			expect(result?.models[0]?.contextWindow).toBe(expected);
		}
	});
});
