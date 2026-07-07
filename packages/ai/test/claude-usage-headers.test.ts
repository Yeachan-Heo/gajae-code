import { describe, expect, it } from "bun:test";
import type { UsageFetchContext } from "../src/usage";
import { claudeUsageProvider } from "../src/usage/claude";

function getHeaderCaseInsensitive(
	headers: Headers | Record<string, string | ReadonlyArray<string>> | string[][] | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const target = name.toLowerCase();

	if (headers instanceof Headers) {
		for (const [key, value] of headers.entries()) {
			if (key.toLowerCase() === target) return value;
		}
		return undefined;
	}

	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key.toLowerCase() === target);
		return match?.[1];
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target) return String(value);
	}
	return undefined;
}

describe("claude usage request headers", () => {
	it("sends aligned anthropic fingerprint and bearer auth headers", async () => {
		const now = Date.now();
		const token = "oat-test-access-token";
		const calls: Array<{ input: string; init?: RequestInit }> = [];
		const fetchMock = (async (input: string | URL, init?: RequestInit) => {
			calls.push({ input: String(input), init });
			return new Response(
				JSON.stringify({
					five_hour: {
						utilization: 42,
						resets_at: new Date(now + 10 * 60 * 1000).toISOString(),
					},
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
						"anthropic-organization-id": "org_test",
					},
				},
			);
		}) as unknown as typeof fetch;

		const ctx: UsageFetchContext = {
			fetch: fetchMock,
		};

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: token,
					accountId: "org_test",
					email: "user@example.com",
					expiresAt: now + 60_000,
				},
			},
			ctx,
		);

		expect(report).not.toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://api.anthropic.com/api/oauth/usage");

		const headers = calls[0]?.init?.headers;
		expect(getHeaderCaseInsensitive(headers, "authorization")).toBe(`Bearer ${token}`);
		expect(getHeaderCaseInsensitive(headers, "user-agent")).toBe("claude-cli/2.1.63 (external, cli)");

		const beta = getHeaderCaseInsensitive(headers, "anthropic-beta");
		expect(beta).toBeDefined();
		const betaTokens = beta?.split(",").map(tokenValue => tokenValue.trim()) ?? [];
		expect(betaTokens).toContain("claude-code-20250219");
		expect(betaTokens).toContain("oauth-2025-04-20");
		expect(betaTokens).toContain("interleaved-thinking-2025-05-14");
		expect(betaTokens).toContain("context-management-2025-06-27");
		expect(betaTokens).toContain("prompt-caching-scope-2026-01-05");
	});

	it("does not invent reset timestamps when Claude omits them", async () => {
		const fetchMock = (async () => {
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 42 },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					expiresAt: Date.now() + 60_000,
				},
			},
			{ fetch: fetchMock },
		);

		expect(report?.limits[0]?.window?.resetsAt).toBeUndefined();
	});

	it("parses modern limits[] weekly_scoped entries as model-scoped 7d limits", async () => {
		const now = Date.now();
		const resetsAt = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
		const fetchMock = (async () => {
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 42 },
					limits: [
						{
							kind: "weekly_scoped",
							percent: 63,
							resets_at: resetsAt,
							scope: { model: { display_name: "Fable" } },
						},
						// Unknown kinds and malformed entries are ignored.
						{ kind: "monthly_total", percent: 10 },
						{ kind: "weekly_scoped" },
						"garbage",
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					expiresAt: Date.now() + 60_000,
				},
			},
			{ fetch: fetchMock },
		);

		const scoped = report?.limits.find(limit => limit.id === "anthropic:7d:fable");
		expect(scoped).toBeDefined();
		expect(scoped?.label).toBe("Claude 7 Day (Fable)");
		expect(scoped?.scope.tier).toBe("fable");
		expect(scoped?.amount.used).toBe(63);
		expect(scoped?.window?.resetsAt).toBe(Date.parse(resetsAt));
		expect(report?.limits.map(limit => limit.id)).toEqual(["anthropic:5h", "anthropic:7d:fable"]);
	});

	it("accepts a payload that only carries modern weekly_scoped limits", async () => {
		const fetchMock = (async () => {
			return new Response(
				JSON.stringify({
					limits: [{ kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "Fable" } } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					expiresAt: Date.now() + 60_000,
				},
			},
			{ fetch: fetchMock },
		);

		expect(report?.limits.map(limit => limit.id)).toEqual(["anthropic:7d:fable"]);
	});
});
