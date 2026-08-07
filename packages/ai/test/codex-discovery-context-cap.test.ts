import { describe, expect, it } from "bun:test";
import { fetchCodexModels } from "../src/utils/discovery/codex";

function response(slug: string, contextWindow: unknown): Response {
	return new Response(
		JSON.stringify({
			models: [
				{
					slug,
					display_name: slug,
					context_window: contextWindow,
					supported_in_api: true,
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function fetchResponse(slug: string, contextWindow: unknown): typeof fetch {
	return (() => Promise.resolve(response(slug, contextWindow))) as unknown as typeof fetch;
}

async function discover(slug: string, contextWindow: unknown): Promise<number | undefined> {
	const result = await fetchCodexModels({
		accessToken: "test-token",
		clientVersion: "0.99.0",
		fetchFn: fetchResponse(slug, contextWindow),
	});
	return result?.models[0]?.contextWindow;
}

const GPT_5_6_TIER_IDS = ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
const NON_TIER_CODEX_IDS = ["gpt-5.5", "gpt-5.6-codex"] as const;

describe("Codex GPT-5.6 discovery context cap", () => {
	it("forces the 372K window for every GPT-5.6 tier id", async () => {
		for (const id of GPT_5_6_TIER_IDS) {
			expect(await discover(id, undefined)).toBe(372_000);
			expect(await discover(id, 373_000)).toBe(372_000);
			expect(await discover(id, 1_050_000)).toBe(372_000);
			// Even smaller live metadata is overridden — the tier is forced to 372K.
			expect(await discover(id, 200_000)).toBe(372_000);
			// Invalid metadata shapes (JSON-safe: null/zero/string) are forced too.
			expect(await discover(id, null)).toBe(372_000);
			expect(await discover(id, 0)).toBe(372_000);
			expect(await discover(id, "373000")).toBe(372_000);
		}
	});

	it("keeps the generic 272K fallback for non-5.6 Codex rows and passes live values through", async () => {
		for (const id of NON_TIER_CODEX_IDS) {
			// The 272K pin for these ids is applied by the generated-catalog policy
			// (model-thinking), so raw discovery must not advertise the 372K window.
			expect(await discover(id, undefined)).toBe(272_000);
			expect(await discover(id, 373_000)).toBe(373_000);
		}
	});
});
