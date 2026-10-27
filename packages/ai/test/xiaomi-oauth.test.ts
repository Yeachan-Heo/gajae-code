import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import { xiaomiModelManagerOptions } from "../src/provider-models/openai-compat";
import { loginXiaomi } from "../src/utils/oauth/xiaomi";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("xiaomi oauth validation", () => {
	it("uses a fresh AbortSignal per endpoint so SGP timeout doesn't abort AMS fallback", async () => {
		const capturedSignals: (AbortSignal | undefined)[] = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			capturedSignals.push(init?.signal ?? undefined);
			if (capturedSignals.length === 1) {
				// Simulate SGP timing out: throw an AbortError as AbortSignal.timeout would.
				throw new DOMException("The operation was aborted due to timeout.", "AbortError");
			}
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		await loginXiaomi({
			onPrompt: async () => "tp-test-key",
			onAuth: () => {},
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(capturedSignals[0]).toBeInstanceOf(AbortSignal);
		expect(capturedSignals[1]).toBeInstanceOf(AbortSignal);
		// Two distinct signals — proves a fresh timeout was created for AMS.
		expect(capturedSignals[0]).not.toBe(capturedSignals[1]);
		// And the AMS signal is not aborted (would be if the timeout signal were shared).
		expect(capturedSignals[1]?.aborted).toBe(false);
	});
});

// #772: Token Plan keys use regional endpoints for login and model discovery.
describe("xiaomi token-plan key routing", () => {
	const TOKEN_PLAN_SGP_HOST = "token-plan-sgp.xiaomimimo.com";
	const TOKEN_PLAN_AMS_HOST = "token-plan-ams.xiaomimimo.com";
	const TOKEN_PLAN_CN_HOST = "token-plan-cn.xiaomimimo.com";
	const STANDARD_HOST = "api.xiaomimimo.com";

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
