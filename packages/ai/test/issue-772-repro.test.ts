import { describe, expect, it } from "bun:test";
import { hookFetch } from "@gajae-code/utils";

import { xiaomiModelManagerOptions } from "../src/provider-models/openai-compat";
import { loginXiaomi } from "../src/utils/oauth/xiaomi";

const TOKEN_PLAN_SGP_HOST = "token-plan-sgp.xiaomimimo.com";
const TOKEN_PLAN_AMS_HOST = "token-plan-ams.xiaomimimo.com";
const TOKEN_PLAN_CN_HOST = "token-plan-cn.xiaomimimo.com";
const STANDARD_HOST = "api.xiaomimimo.com";

describe("issue-772: Xiaomi MiMo token-plan (tp-) keys", () => {
	it("loginXiaomi validates tp- keys against the SGP token-plan host first", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			return new Response("{}", { status: 200 });
		});

		await loginXiaomi({
			onAuth: () => {},
			onPrompt: async () => "tp-test-key",
			onProgress: () => {},
		});

		expect(seen).toHaveLength(1);
		const url = seen[0]!;
		expect(url).toContain(TOKEN_PLAN_SGP_HOST);
		expect(url).toContain("/chat/completions");
	});

	it("xiaomiModelManagerOptions discovers models from the SGP token-plan host when given a tp- key", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const opts = xiaomiModelManagerOptions({ apiKey: "tp-test-key" });
		await opts.fetchDynamicModels?.();

		expect(seen.length).toBeGreaterThan(0);
		const url = seen[0]!;
		expect(url).toContain(TOKEN_PLAN_SGP_HOST);
		expect(url).toContain("/v1/models");
	});

	it("xiaomiModelManagerOptions fails fast on token-plan auth errors", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ error: "unauthorized" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		});

		const opts = xiaomiModelManagerOptions({ apiKey: "tp-test-key" });
		await expect(opts.fetchDynamicModels?.()).rejects.toThrow("Authentication failed");

		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain(TOKEN_PLAN_SGP_HOST);
	});

	for (const [providerId, expectedHost] of [
		["xiaomi-token-plan-ams", TOKEN_PLAN_AMS_HOST],
		["xiaomi-token-plan-cn", TOKEN_PLAN_CN_HOST],
	] as const) {
		it(`xiaomiModelManagerOptions infers ${providerId} host without explicit tokenPlanRegion`, async () => {
			const seen: string[] = [];
			using _hook = hookFetch(input => {
				seen.push(String(input));
				return new Response(JSON.stringify({ error: "unauthorized" }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			});

			const opts = xiaomiModelManagerOptions({ apiKey: "tp-test-key", providerId });
			await expect(opts.fetchDynamicModels?.()).rejects.toThrow("Authentication failed");

			expect(seen).toHaveLength(1);
			expect(seen[0]).toContain(expectedHost);
			expect(seen[0]).not.toContain(TOKEN_PLAN_SGP_HOST);
		});
	}

	it("xiaomiModelManagerOptions still uses the standard host for sk- keys", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const opts = xiaomiModelManagerOptions({ apiKey: "sk-test-key" });
		await opts.fetchDynamicModels?.();

		expect(seen.length).toBeGreaterThan(0);
		const url = seen[0]!;
		expect(url).toContain(STANDARD_HOST);
		expect(url).not.toContain(TOKEN_PLAN_SGP_HOST);
	});
});
