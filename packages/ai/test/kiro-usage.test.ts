import { describe, expect, test } from "bun:test";
import { KIRO_BUILDER_ID_PROFILE_ARN, KIRO_MANAGEMENT_URL, resetKiroProfileArnCache } from "../src/providers/kiro";
import type { UsageFetchContext, UsageFetchParams } from "../src/usage";
import { kiroUsageProvider } from "../src/usage/kiro";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/PROPLUS";

function usageParams(overrides?: Partial<UsageFetchParams["credential"]>): UsageFetchParams {
	return {
		provider: "kiro",
		credential: {
			type: "oauth",
			accessToken: "kiro-access-token",
			kiroProfileArn: PROFILE_ARN,
			...overrides,
		},
	};
}

function usageBreakdown(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		resourceType: "CREDIT",
		displayNamePlural: "Credits",
		unit: "INVOCATIONS",
		currentUsage: 40,
		usageLimit: 100,
		nextDateReset: 1_800_000_000,
		...overrides,
	};
}

describe("Kiro usage provider", () => {
	test("skips the probe entirely when the stored token is already expired", async () => {
		const targets: string[] = [];
		const ctx: UsageFetchContext = {
			fetch: async (input): Promise<Response> => {
				targets.push(String(input));
				return Response.json({});
			},
		};

		const report = await kiroUsageProvider.fetchUsage(usageParams({ expiresAt: Date.now() - 60_000 }), ctx);

		// AuthStorage owns refresh; an expired token here means the refresh slot may
		// hold the broker sentinel, so no request may be issued at all.
		expect(report).toBeNull();
		expect(targets).toEqual([]);
	});

	test("keeps account identity out of the reported raw payload", async () => {
		const ctx: UsageFetchContext = {
			fetch: async (): Promise<Response> =>
				Response.json({
					nextDateReset: 1_800_000_000,
					subscriptionInfo: { subscriptionTitle: "Kiro Pro+", type: "PAID" },
					overageConfiguration: { overageStatus: "ENABLED" },
					usageBreakdownList: [usageBreakdown()],
					userInfo: {
						email: "operator@example.com",
						accountId: "123456789012",
						displayName: "Operator",
					},
				}),
		};

		const report = await kiroUsageProvider.fetchUsage(usageParams({ expiresAt: Date.now() + 600_000 }), ctx);
		expect(report).not.toBeNull();

		const raw = report?.raw as Record<string, unknown>;
		expect(Object.keys(raw).sort()).toEqual([
			"nextDateReset",
			"overageConfiguration",
			"subscriptionInfo",
			"usageBreakdownList",
		]);
		expect("userInfo" in raw).toBe(false);
		expect(JSON.stringify(raw)).not.toContain("operator@example.com");
		expect(JSON.stringify(raw)).not.toContain("123456789012");
	});

	test("omits derived fractions when the reported limit is zero", async () => {
		const ctx: UsageFetchContext = {
			fetch: async (): Promise<Response> =>
				Response.json({
					usageBreakdownList: [usageBreakdown({ currentUsage: 0, usageLimit: 0 })],
				}),
		};

		const report = await kiroUsageProvider.fetchUsage(usageParams({ expiresAt: Date.now() + 600_000 }), ctx);
		const amount = report?.limits[0]?.amount;

		expect(amount?.used).toBe(0);
		expect(amount?.limit).toBe(0);
		// A zero limit cannot produce a meaningful ratio, so the derived fields stay
		// absent rather than dividing by zero.
		expect(amount?.remaining).toBeUndefined();
		expect(amount?.usedFraction).toBeUndefined();
		expect(amount?.remainingFraction).toBeUndefined();
		expect(report?.limits[0]?.status).toBe("unknown");
	});

	test("clamps overage past the allowance instead of reporting negative remaining", async () => {
		const ctx: UsageFetchContext = {
			fetch: async (): Promise<Response> =>
				Response.json({
					usageBreakdownList: [usageBreakdown({ currentUsage: 150, usageLimit: 100 })],
				}),
		};

		const report = await kiroUsageProvider.fetchUsage(usageParams({ expiresAt: Date.now() + 600_000 }), ctx);
		const amount = report?.limits[0]?.amount;

		expect(amount?.used).toBe(150);
		expect(amount?.remaining).toBe(0);
		expect(amount?.usedFraction).toBe(1);
		expect(amount?.remainingFraction).toBe(0);
		expect(report?.limits[0]?.status).toBe("exhausted");
	});

	test("prefers the precise usage variants over the truncated integers", async () => {
		const ctx: UsageFetchContext = {
			fetch: async (): Promise<Response> =>
				Response.json({
					usageBreakdownList: [
						usageBreakdown({
							currentUsage: 40,
							currentUsageWithPrecision: 40.75,
							usageLimit: 100,
							usageLimitWithPrecision: 100.5,
						}),
					],
				}),
		};

		const report = await kiroUsageProvider.fetchUsage(usageParams({ expiresAt: Date.now() + 600_000 }), ctx);
		const amount = report?.limits[0]?.amount;

		expect(amount?.used).toBe(40.75);
		expect(amount?.limit).toBe(100.5);
	});

	test("reuses the server-confirmed credential ARN without a ListAvailableProfiles round trip", async () => {
		resetKiroProfileArnCache();
		const amzTargets: string[] = [];
		const bodies: string[] = [];
		const ctx: UsageFetchContext = {
			fetch: async (input, init): Promise<Response> => {
				const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
				amzTargets.push(String(request.headers.get("x-amz-target")));
				bodies.push(await request.text());
				return Response.json({ usageBreakdownList: [usageBreakdown()] });
			},
		};

		const report = await kiroUsageProvider.fetchUsage(usageParams({ expiresAt: Date.now() + 600_000 }), ctx);
		expect(report).not.toBeNull();

		// The ARN invariant: a credential-supplied ARN is authoritative, so the
		// usage probe must not re-derive it. Filter on x-amz-target because
		// KIRO_MANAGEMENT_URL also serves ListAvailableProfiles and ListAvailableModels.
		expect(amzTargets.filter(target => target.endsWith("ListAvailableProfiles"))).toEqual([]);
		expect(amzTargets).toEqual(["AmazonCodeWhispererService.GetUsageLimits"]);
		expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ profileArn: PROFILE_ARN });
	});
	test("always sends usage requests to the Kiro management origin", async () => {
		const targets: string[] = [];
		const ctx: UsageFetchContext = {
			fetch: async (input): Promise<Response> => {
				targets.push(String(input));
				return Response.json({ usageBreakdownList: [usageBreakdown()] });
			},
		};

		await kiroUsageProvider.fetchUsage(
			{ ...usageParams({ expiresAt: Date.now() + 600_000 }), baseUrl: "https://attacker.example/steal" },
			ctx,
		);

		expect(targets).toEqual([KIRO_MANAGEMENT_URL]);
	});

	test("resolves the ARN exactly once when the credential slot is empty", async () => {
		resetKiroProfileArnCache();
		const amzTargets: string[] = [];
		const ctx: UsageFetchContext = {
			fetch: async (input, init): Promise<Response> => {
				const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
				const target = String(request.headers.get("x-amz-target"));
				amzTargets.push(target);
				if (target.endsWith("ListAvailableProfiles")) {
					return Response.json({ profiles: [{ arn: PROFILE_ARN }] });
				}
				return Response.json({ usageBreakdownList: [usageBreakdown()] });
			},
		};

		// Social credentials normally persist an ARN, but a missing legacy slot
		// still resolves once and then uses the per-token cache.
		const params = usageParams({
			expiresAt: Date.now() + 600_000,
			kiroMethod: "google",
			kiroProfileArn: undefined,
		});
		expect(await kiroUsageProvider.fetchUsage(params, ctx)).not.toBeNull();
		expect(amzTargets.filter(target => target.endsWith("ListAvailableProfiles"))).toHaveLength(1);

		// The resolution is memoized, so a second probe issues no further lookup.
		expect(await kiroUsageProvider.fetchUsage(params, ctx)).not.toBeNull();
		expect(amzTargets.filter(target => target.endsWith("ListAvailableProfiles"))).toHaveLength(1);
	});

	test("uses the shared Kiro CLI profile for Builder ID without listing profiles", async () => {
		const amzTargets: string[] = [];
		const bodies: string[] = [];
		const ctx: UsageFetchContext = {
			fetch: async (_input, init): Promise<Response> => {
				const request = new Request(KIRO_MANAGEMENT_URL, init);
				amzTargets.push(String(request.headers.get("x-amz-target")));
				bodies.push(await request.text());
				return Response.json({ usageBreakdownList: [usageBreakdown()] });
			},
		};

		const report = await kiroUsageProvider.fetchUsage(
			usageParams({
				expiresAt: Date.now() + 600_000,
				kiroMethod: "builder-id",
				kiroProfileArn: undefined,
			}),
			ctx,
		);

		expect(report?.limits).toHaveLength(1);
		expect(report?.metadata?.account).toBe("kiro builder-id");
		expect(amzTargets).toEqual(["AmazonCodeWhispererService.GetUsageLimits"]);
		expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ profileArn: KIRO_BUILDER_ID_PROFILE_ARN });
	});

	test("backfills the Builder ID profile for legacy method-less credentials", async () => {
		const bodies: string[] = [];
		const ctx: UsageFetchContext = {
			fetch: async (_input, init): Promise<Response> => {
				const request = new Request(KIRO_MANAGEMENT_URL, init);
				bodies.push(await request.text());
				return Response.json({ usageBreakdownList: [usageBreakdown()] });
			},
		};

		const report = await kiroUsageProvider.fetchUsage(
			usageParams({
				expiresAt: Date.now() + 600_000,
				kiroMethod: undefined,
				kiroProfileArn: undefined,
			}),
			ctx,
		);

		expect(report?.limits).toHaveLength(1);
		expect(report?.metadata?.account).toBe("kiro builder-id");
		expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ profileArn: KIRO_BUILDER_ID_PROFILE_ARN });
	});

	test("declines non-Kiro providers and api-key credentials", () => {
		expect(kiroUsageProvider.supports?.(usageParams())).toBe(true);
		expect(kiroUsageProvider.supports?.({ ...usageParams(), provider: "anthropic" })).toBe(false);
		expect(kiroUsageProvider.supports?.({ provider: "kiro", credential: { type: "api_key", apiKey: "k" } })).toBe(
			false,
		);
	});

	test("labels the account by login method so multi-account rows are distinguishable", async () => {
		const ctx: UsageFetchContext = {
			fetch: async (): Promise<Response> => Response.json({ usageBreakdownList: [usageBreakdown()] }),
		};

		const report = await kiroUsageProvider.fetchUsage(
			usageParams({ expiresAt: Date.now() + 600_000, kiroMethod: "github" }),
			ctx,
		);

		// Kiro credentials carry no email/accountId, so without this the renderer
		// falls back to "account 1" for every credential.
		expect(report?.metadata?.account).toBe("kiro github (PROPLUS)");
		expect(report?.limits[0]?.scope.accountId).toBe("kiro github (PROPLUS)");
	});

	test("falls back to the profile suffix when the login method is absent", async () => {
		const ctx: UsageFetchContext = {
			fetch: async (): Promise<Response> => Response.json({ usageBreakdownList: [usageBreakdown()] }),
		};

		const report = await kiroUsageProvider.fetchUsage(
			usageParams({ expiresAt: Date.now() + 600_000, kiroMethod: undefined }),
			ctx,
		);

		expect(report?.metadata?.account).toBe("kiro (PROPLUS)");
	});

	test("keeps a server-supplied accountId ahead of the derived label", async () => {
		const ctx: UsageFetchContext = {
			fetch: async (): Promise<Response> => Response.json({ usageBreakdownList: [usageBreakdown()] }),
		};

		const report = await kiroUsageProvider.fetchUsage(
			usageParams({ expiresAt: Date.now() + 600_000, kiroMethod: "google", accountId: "123456789012" }),
			ctx,
		);

		expect(report?.limits[0]?.scope.accountId).toBe("123456789012");
	});

	test("keeps Builder ID usage scopes distinct by stored credential id", async () => {
		const ctx: UsageFetchContext = {
			fetch: async (): Promise<Response> => Response.json({ usageBreakdownList: [usageBreakdown()] }),
		};
		const first = await kiroUsageProvider.fetchUsage(
			usageParams({ expiresAt: Date.now() + 600_000, kiroMethod: "builder-id", credentialId: 11 }),
			ctx,
		);
		const second = await kiroUsageProvider.fetchUsage(
			usageParams({ expiresAt: Date.now() + 600_000, kiroMethod: "builder-id", credentialId: 12 }),
			ctx,
		);
		expect(first?.limits[0]?.scope.accountId).toBe("credential:11");
		expect(second?.limits[0]?.scope.accountId).toBe("credential:12");
	});

	test("surfaces an unentitled account instead of erasing it from the usage view", async () => {
		const ctx: UsageFetchContext = {
			fetch: async (): Promise<Response> =>
				Response.json(
					{ __type: "com.amazon.kiro.controlplane#AccessDeniedException", message: "not authorized" },
					{ status: 400 },
				),
		};

		const report = await kiroUsageProvider.fetchUsage(
			usageParams({ expiresAt: Date.now() + 600_000, kiroMethod: "google" }),
			ctx,
		);

		// Returning null here would drop the account silently, which is how an
		// entitlement failure becomes invisible in `/usage`.
		expect(report).not.toBeNull();
		expect(report?.limits).toEqual([]);
		expect(report?.metadata?.account).toBe("kiro google (PROPLUS)");
		expect(report?.metadata?.unavailableReason).toBe("GetUsageLimits returned HTTP 400");
	});

	test("surfaces an empty breakdown list as a named, reasoned report", async () => {
		const ctx: UsageFetchContext = {
			fetch: async (): Promise<Response> =>
				Response.json({ subscriptionInfo: { subscriptionTitle: "KIRO PRO MAX" }, usageBreakdownList: [] }),
		};

		const report = await kiroUsageProvider.fetchUsage(
			usageParams({ expiresAt: Date.now() + 600_000, kiroMethod: "github" }),
			ctx,
		);

		expect(report?.limits).toEqual([]);
		expect(report?.metadata?.account).toBe("kiro github (PROPLUS)");
		expect(report?.metadata?.subscriptionTitle).toBe("KIRO PRO MAX");
		expect(report?.metadata?.unavailableReason).toBe("GetUsageLimits returned no usage breakdown");
	});

	test("reports the endpoint it actually queried in metadata", async () => {
		const ctx: UsageFetchContext = {
			fetch: async (): Promise<Response> => Response.json({ usageBreakdownList: [usageBreakdown()] }),
		};
		const report = await kiroUsageProvider.fetchUsage(usageParams({ expiresAt: Date.now() + 600_000 }), ctx);
		expect(report?.metadata?.endpoint).toBe(KIRO_MANAGEMENT_URL);
	});
});
