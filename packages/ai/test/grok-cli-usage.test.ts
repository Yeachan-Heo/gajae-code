import { describe, expect, it } from "bun:test";
import {
	grokCliRankingStrategy,
	grokCliUsageProvider,
	parseGrokCliBillingUsage,
	parseGrokCliWeeklyBillingUsage,
} from "../src/usage/grok-cli";

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

	it("parses a weekly credits payload and defaults an omitted fresh-period percentage to zero", () => {
		expect(
			parseGrokCliWeeklyBillingUsage({
				config: {
					currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
					billingPeriodEnd: "2026-08-18T13:31:00.000Z",
				},
			}),
		).toEqual({ creditUsagePercent: 0, billingPeriodEnd: "2026-08-18T13:31:00.000Z" });
		expect(
			parseGrokCliWeeklyBillingUsage({
				config: {
					currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
					creditUsagePercent: 6,
					billingPeriodEnd: "2026-08-18T13:31:00.000Z",
				},
			}),
		).toBeUndefined();
	});

	it("uses the weekly credits quota when monthly credits report a zero limit", async () => {
		const controller = new AbortController();
		const requests: string[] = [];
		const report = await grokCliUsageProvider.fetchUsage(
			{
				provider: "grok-build",
				credential: { type: "oauth", accessToken: "token", expiresAt: Date.now() + 60_000 },
				baseUrl: "https://cli-chat-proxy.grok.com/v1/",
				signal: controller.signal,
			},
			{
				fetch: (async (url, init) => {
					requests.push(String(url));
					expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer token");
					expect(init?.signal).toBe(controller.signal);
					if (String(url).endsWith("/billing")) {
						return Response.json({
							config: {
								monthlyLimit: { val: 0 },
								used: { val: 108 },
								billingPeriodEnd: "2026-09-01T00:00:00.000Z",
							},
						});
					}
					return Response.json({
						config: {
							currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
							creditUsagePercent: 6,
							billingPeriodEnd: "2026-08-18T13:31:00.000Z",
						},
					});
				}) as typeof fetch,
			},
		);

		expect(requests).toEqual([
			"https://cli-chat-proxy.grok.com/v1/billing",
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
		]);
		expect(report?.limits).toHaveLength(1);
		expect(report?.limits[0]).toMatchObject({
			id: "grok-build:weekly",
			label: "SuperGrok weekly credits",
			amount: {
				used: 6,
				limit: 100,
				remaining: 94,
				usedFraction: 0.06,
				remainingFraction: 0.94,
			},
			window: {
				id: "weekly",
				label: "Weekly",
				resetsAt: Date.parse("2026-08-18T13:31:00.000Z"),
			},
		});
		expect(report?.limits[0]?.notes).not.toContain("108/0 credits used");
	});

	it("keeps monthly and weekly windows in a hybrid report and ranks the weekly reset", async () => {
		const report = await grokCliUsageProvider.fetchUsage(
			{
				provider: "grok-build",
				credential: { type: "oauth", accessToken: "token", expiresAt: Date.now() + 60_000 },
			},
			{
				fetch: (async url => {
					return Response.json(
						String(url).endsWith("?format=credits")
							? {
									config: {
										currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
										creditUsagePercent: 70,
										billingPeriodEnd: "2026-08-18T13:31:00.000Z",
									},
								}
							: {
									config: {
										monthlyLimit: { val: 10_000 },
										used: { val: 2_500 },
										billingPeriodEnd: "2026-09-01T00:00:00.000Z",
									},
								},
					);
				}) as typeof fetch,
			},
		);

		expect(report?.limits.map(limit => limit.id)).toEqual(["grok-build:7d", "grok-build:weekly"]);
		const ranked = report ? grokCliRankingStrategy.findWindowLimits(report) : undefined;
		expect(ranked?.primary).toBeUndefined();
		expect(ranked?.secondary?.id).toBe("grok-build:weekly");
		expect(ranked?.secondary?.window?.resetsAt).toBe(Date.parse("2026-08-18T13:31:00.000Z"));
	});

	it("preserves an explicit zero weekly percentage", () => {
		expect(
			parseGrokCliWeeklyBillingUsage({
				config: {
					currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
					creditUsagePercent: 0,
					billingPeriodEnd: "2026-08-18T13:31:00.000Z",
				},
			}),
		).toEqual({ creditUsagePercent: 0, billingPeriodEnd: "2026-08-18T13:31:00.000Z" });
	});

	it("maps monthly billing to status-line-compatible usage when weekly data is unavailable", async () => {
		const report = await grokCliUsageProvider.fetchUsage(
			{
				provider: "grok-build",
				credential: { type: "oauth", accessToken: "token", expiresAt: Date.now() + 60_000 },
				baseUrl: "https://cli-chat-proxy.grok.com/v1/",
			},
			{
				fetch: (async (url, init) => {
					if (String(url).endsWith("?format=credits")) {
						return new Response(null, { status: 404 });
					}
					expect(String(url)).toBe("https://cli-chat-proxy.grok.com/v1/billing");
					expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer token");
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

	it("does not return an inaccurate zero-limit report when weekly data is malformed", async () => {
		const report = await grokCliUsageProvider.fetchUsage(
			{
				provider: "grok-build",
				credential: { type: "oauth", accessToken: "token", expiresAt: Date.now() + 60_000 },
			},
			{
				fetch: (async url => {
					if (String(url).endsWith("?format=credits")) {
						return Response.json({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } });
					}
					return Response.json({
						config: {
							monthlyLimit: { val: 0 },
							used: { val: 108 },
							billingPeriodEnd: "2026-09-01T00:00:00.000Z",
						},
					});
				}) as typeof fetch,
			},
		);
		expect(report).toBeNull();
	});

	it("falls back to a valid monthly report when the weekly payload is malformed", async () => {
		const report = await grokCliUsageProvider.fetchUsage(
			{
				provider: "grok-build",
				credential: { type: "oauth", accessToken: "token", expiresAt: Date.now() + 60_000 },
			},
			{
				fetch: (async url => {
					if (String(url).endsWith("?format=credits")) {
						return Response.json({
							config: {
								currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
								creditUsagePercent: "bad",
								billingPeriodEnd: "not-a-date",
							},
						});
					}
					return Response.json({
						config: {
							monthlyLimit: { val: 10_000 },
							used: { val: 1_000 },
							billingPeriodEnd: "2026-09-01T00:00:00.000Z",
						},
					});
				}) as typeof fetch,
			},
		);

		expect(report?.limits.map(limit => limit.id)).toEqual(["grok-build:7d"]);
	});

	it("propagates caller aborts from the weekly request", async () => {
		const controller = new AbortController();
		const abortError = new DOMException("cancelled", "AbortError");
		const reportPromise = grokCliUsageProvider.fetchUsage(
			{
				provider: "grok-build",
				credential: { type: "oauth", accessToken: "token", expiresAt: Date.now() + 60_000 },
				signal: controller.signal,
			},
			{
				fetch: (async url => {
					if (!String(url).endsWith("?format=credits")) {
						return Response.json({
							config: {
								monthlyLimit: { val: 0 },
								used: { val: 1_000 },
								billingPeriodEnd: "2026-09-01T00:00:00.000Z",
							},
						});
					}
					controller.abort();
					throw abortError;
				}) as typeof fetch,
			},
		);

		await expect(reportPromise).rejects.toBe(abortError);
	});

	it("preserves a valid monthly report when the optional weekly request is aborted", async () => {
		const controller = new AbortController();
		const report = await grokCliUsageProvider.fetchUsage(
			{
				provider: "grok-build",
				credential: { type: "oauth", accessToken: "token", expiresAt: Date.now() + 60_000 },
				signal: controller.signal,
			},
			{
				fetch: (async url => {
					if (!String(url).endsWith("?format=credits")) {
						return Response.json({
							config: {
								monthlyLimit: { val: 10_000 },
								used: { val: 1_000 },
								billingPeriodEnd: "2026-09-01T00:00:00.000Z",
							},
						});
					}
					controller.abort();
					throw new DOMException("timed out", "AbortError");
				}) as typeof fetch,
			},
		);

		expect(report?.limits.map(limit => limit.id)).toEqual(["grok-build:7d"]);
		expect(report?.limits[0]?.amount.usedFraction).toBe(0.1);
	});

	it("does not send OAuth credentials to unsafe billing host overrides", async () => {
		let warned = false;
		await grokCliUsageProvider.fetchUsage(
			{
				provider: "grok-build",
				credential: { type: "oauth", accessToken: "token", expiresAt: Date.now() + 60_000 },
				baseUrl: "https://evil.example/v1",
			},
			{
				fetch: (async url => {
					if (String(url).endsWith("?format=credits")) {
						return new Response(null, { status: 404 });
					}
					expect(String(url)).toBe("https://cli-chat-proxy.grok.com/v1/billing");
					return Response.json({
						config: {
							monthlyLimit: { val: 10_000 },
							used: { val: 1 },
							billingPeriodEnd: "2026-07-01T00:00:00.000Z",
						},
					});
				}) as typeof fetch,
				logger: {
					debug() {},
					warn(message) {
						warned = message.includes("unsafe base URL");
					},
				},
			},
		);
		expect(warned).toBe(true);
	});
});
