import { describe, expect, it } from "bun:test";
import { grokCliUsageProvider, parseGrokCliBillingUsage } from "../src/usage/grok-cli";

describe("Grok CLI usage provider", () => {
	it("parses billing payload", () => {
		expect(
			parseGrokCliBillingUsage({
				config: {
					monthlyLimit: { val: 10_000 },
					used: { val: 500 },
					billingPeriodEnd: "2026-07-01T00:00:00.000Z",
				},
			}),
		).toEqual({ monthlyLimit: 10_000, used: 500, billingPeriodEnd: "2026-07-01T00:00:00.000Z" });
	});

	it("maps billing to status-line-compatible 7d usage", async () => {
		const report = await grokCliUsageProvider.fetchUsage(
			{
				provider: "grok-build",
				credential: { type: "oauth", accessToken: "token", expiresAt: Date.now() + 60_000 },
				baseUrl: "https://cli-chat-proxy.grok.com/v1/",
			},
			{
				fetch: (async (url, init) => {
					expect(String(url)).toBe("https://cli-chat-proxy.grok.com/v1/billing");
					expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer token");
					return Response.json({
						config: {
							monthlyLimit: { val: 10_000 },
							used: { val: 2_500 },
							billingPeriodEnd: "2026-07-01T00:00:00.000Z",
						},
					});
				}) as typeof fetch,
			},
		);
		expect(report?.provider).toBe("grok-build");
		expect(report?.limits[0]?.scope.windowId).toBe("7d");
		expect(report?.limits[0]?.amount.used).toBe(25);
		expect(report?.limits[0]?.amount.usedFraction).toBe(0.25);
	});
});
