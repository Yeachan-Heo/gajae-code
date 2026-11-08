/**
 * Antigravity `fetchAvailableModels` returns one entry per model (including
 * editor-only tab/chat models), while models of one family share a single
 * quota. `/usage` must show each pool once; credential rotation still needs the
 * per-model limits.
 */

import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { collapseUsageLimitsForDisplay } from "../src/usage";
import {
	ANTIGRAVITY_FIVE_HOUR_WINDOW_MS,
	ANTIGRAVITY_WEEKLY_WINDOW_MS,
	antigravityRankingStrategy,
	antigravityUsageProvider,
} from "../src/usage/google-antigravity";

const CLAUDE_POOL = { remainingFraction: 0.4184348, resetTime: "2026-10-28T04:53:18Z" };
const GEMINI_POOL = { remainingFraction: 0.9990867, resetTime: "2026-10-25T19:05:36Z" };

function makePayload() {
	return {
		models: {
			"claude-opus-5-5-high": { displayName: "Claude Opus 5.5 (High)", quotaInfo: CLAUDE_POOL },
			"claude-sonnet-5-5-low": { displayName: "Claude Sonnet 5.5 (Low)", quotaInfo: CLAUDE_POOL },
			"gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", quotaInfo: CLAUDE_POOL },
			"gemini-3-flash": { displayName: "Gemini 3 Flash", quotaInfo: GEMINI_POOL },
			"gemini-3.5-flash-lite": {
				displayName: "Gemini 3.5 Flash Lite",
				quotaInfo: { ...GEMINI_POOL, remainingFraction: 0.5 },
			},
			"gemini-2.5-pro": { displayName: "Gemini 2.5 Pro", quotaInfo: GEMINI_POOL },
			"gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image", quotaInfo: GEMINI_POOL },
			"gemini-4-argon-high": {
				displayName: "Gemini 4 Argon (High)",
				quotaInfo: { resetTime: "2026-10-31T04:06:51Z" },
			},
			chat_20706: { isInternal: true, quotaInfo: { remainingFraction: 1 } },
			chat_23310: { quotaInfo: { remainingFraction: 1 } },
			tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
		},
	};
}

async function fetchReport(payload: unknown = makePayload()) {
	const report = await antigravityUsageProvider.fetchUsage(
		{
			provider: "google-antigravity",
			credential: {
				type: "oauth",
				accessToken: "token",
				projectId: "proj-1",
				accountId: "acct-1",
				email: "me@example.com",
			},
		},
		{ fetch: (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch },
	);
	if (!report) throw new Error("expected report");
	return report;
}

describe("antigravity usage", () => {
	it("drops editor-only and internal models but keeps per-model limits for rotation", async () => {
		const report = await fetchReport();
		const modelIds = report.limits.map(limit => limit.scope.modelId).sort();
		expect(modelIds).toEqual([
			"claude-opus-5-5-high",
			"claude-sonnet-5-5-low",
			"gemini-2.5-pro",
			"gemini-3-flash",
			"gemini-3.1-flash-image",
			"gemini-3.5-flash-lite",
			"gemini-4-argon-high",
			"gpt-oss-120b-medium",
		]);
	});

	it("collapses shared pools to one display row each, keeping the most constrained member", async () => {
		const report = await fetchReport();
		const rows = collapseUsageLimitsForDisplay(report.limits);
		expect(rows.map(row => row.label).sort()).toEqual(["Claude / GPT-OSS", "Gemini", "Gemini Argon"]);
		expect(rows.find(row => row.label === "Gemini Argon")?.status).toBe("exhausted");
		const gemini = rows.find(row => row.label === "Gemini");
		expect(gemini?.amount.remainingFraction).toBe(0.5);
		const claude = rows.find(row => row.label === "Claude / GPT-OSS");
		expect(claude?.amount.remainingFraction).toBeCloseTo(0.4184348);
	});

	it("treats a quota with resetTime but no remainingFraction as exhausted (proto3 omits zero)", async () => {
		const report = await fetchReport({
			models: {
				"gemini-3-flash": { quotaInfo: { resetTime: "2026-10-31T00:30:21Z" } },
				"claude-opus-5-5-high": { quotaInfo: { remainingFraction: 1, resetTime: "2026-10-25T20:19:40Z" } },
			},
		});
		const gemini = report.limits.find(limit => limit.scope.modelId === "gemini-3-flash");
		expect(gemini?.amount.remainingFraction).toBe(0);
		expect(gemini?.status).toBe("exhausted");
		const claude = report.limits.find(limit => limit.scope.modelId === "claude-opus-5-5-high");
		expect(claude?.status).toBe("ok");
	});

	it("does not infer exhaustion from a malformed resetTime when remainingFraction is omitted", async () => {
		const report = await fetchReport({
			models: {
				"gemini-3-flash": { quotaInfo: { resetTime: "not-a-timestamp" } },
			},
		});
		const gemini = report.limits.find(limit => limit.scope.modelId === "gemini-3-flash");
		expect(gemini?.amount.remainingFraction).toBeUndefined();
		expect(gemini?.status).toBe("unknown");
	});

	it("classifies resets within 5 hours as 5h windows and longer resets as 7d weekly windows", async () => {
		const now = Date.now();
		const twoHoursIso = new Date(now + 2 * 60 * 60 * 1000).toISOString();
		const fiveHoursIso = new Date(now + 5 * 60 * 60 * 1000).toISOString();
		const twelveHoursIso = new Date(now + 12 * 60 * 60 * 1000).toISOString();
		const report = await fetchReport({
			models: {
				"gemini-4-argon-high": {
					displayName: "Gemini 4 Argon (High)",
					quotaInfo: { remainingFraction: 0.76, resetTime: twoHoursIso },
				},
				"gemini-3-flash": {
					displayName: "Gemini 3 Flash",
					quotaInfo: { remainingFraction: 1, resetTime: fiveHoursIso },
				},
				"claude-opus-5-5-high": {
					displayName: "Claude Opus 5.5 (High)",
					quotaInfo: { remainingFraction: 0.42, resetTime: twelveHoursIso },
				},
			},
		});

		const argon = report.limits.find(limit => limit.scope.modelId === "gemini-4-argon-high");
		expect(argon?.window?.id).toBe("5h");
		expect(argon?.window?.label).toBe("5 Hour");
		expect(argon?.window?.durationMs).toBe(ANTIGRAVITY_FIVE_HOUR_WINDOW_MS);
		expect(argon?.scope.windowId).toBe("5h");

		const flash = report.limits.find(limit => limit.scope.modelId === "gemini-3-flash");
		expect(flash?.window?.id).toBe("5h");
		expect(flash?.window?.durationMs).toBe(ANTIGRAVITY_FIVE_HOUR_WINDOW_MS);

		const claude = report.limits.find(limit => limit.scope.modelId === "claude-opus-5-5-high");
		expect(claude?.window?.id).toBe("7d");
		expect(claude?.window?.label).toBe("7 Day");
		expect(claude?.window?.durationMs).toBe(ANTIGRAVITY_WEEKLY_WINDOW_MS);
		expect(claude?.scope.windowId).toBe("7d");

		// Untouched 5h windows strip the sliding `now + 5h` horizon for ranking so
		// `earliest-reset` drains actively ticking windows first.
		const untouchedWindows = antigravityRankingStrategy.findWindowLimits({
			...report,
			limits: [flash!],
		});
		expect(untouchedWindows.primary?.window?.resetsAt).toBeUndefined();

		const activeWindows = antigravityRankingStrategy.findWindowLimits({
			...report,
			limits: [argon!],
		});
		expect(activeWindows.primary?.window?.resetsAt).toBe(Date.parse(twoHoursIso));
	});

	it("folds Argon into Gemini on Ultra accounts and keeps Gemini Argon separate on Pro accounts", async () => {
		const now = Date.now();
		const fiveHoursIso = new Date(now + 5 * 60 * 60 * 1000).toISOString();
		const twelveHoursIso = new Date(now + 12 * 60 * 60 * 1000).toISOString();
		const fiveDaysIso = new Date(now + 120 * 60 * 60 * 1000).toISOString();
		const threeDaysIso = new Date(now + 80 * 60 * 60 * 1000).toISOString();

		const fetchWithSummary = async (summaryGroups: unknown[]) => {
			const report = await antigravityUsageProvider.fetchUsage(
				{
					provider: "google-antigravity",
					credential: {
						type: "oauth",
						accessToken: "token",
						projectId: "proj-1",
						accountId: "acct-1",
						email: "me@example.com",
					},
				},
				{
					fetch: (async (url: string | URL | Request) => {
						if (String(url).endsWith("/v1internal:retrieveUserQuotaSummary")) {
							return new Response(JSON.stringify({ groups: summaryGroups }), { status: 200 });
						}
						return new Response(JSON.stringify(makePayload()), { status: 200 });
					}) as unknown as typeof fetch,
				},
			);
			if (!report) throw new Error("expected report");
			return collapseUsageLimitsForDisplay(report.limits);
		};

		// Ultra account: retrieveUserQuotaSummary has Gemini Models (5h + weekly) and Claude/GPT (5h + weekly), no Argon group.
		const ultraRows = await fetchWithSummary([
			{
				displayName: "Gemini Models",
				buckets: [
					{ bucketId: "gemini-weekly", window: "weekly", resetTime: fiveDaysIso, remainingFraction: 0.22 },
					{ bucketId: "gemini-5h", window: "5h", resetTime: fiveHoursIso, remainingFraction: 0.99 },
				],
			},
			{
				displayName: "Claude and GPT models",
				buckets: [
					{ bucketId: "3p-weekly", window: "weekly", resetTime: twelveHoursIso, remainingFraction: 0.42 },
					{ bucketId: "3p-5h", window: "5h", resetTime: fiveHoursIso, remainingFraction: 1 },
				],
			},
		]);
		expect(ultraRows.map(row => `${row.label}|${row.window?.id}`).sort()).toEqual([
			"Claude / GPT-OSS|5h",
			"Claude / GPT-OSS|7d",
			"Gemini|5h",
			"Gemini|7d",
		]);
		expect(
			ultraRows.find(row => row.label === "Gemini" && row.window?.id === "7d")?.amount.remainingFraction,
		).toBeCloseTo(0.22);

		// Pro account: retrieveUserQuotaSummary includes a separate Gemini 4 Argon weekly bucket.
		const proRows = await fetchWithSummary([
			{
				displayName: "Gemini Models",
				buckets: [
					{ bucketId: "gemini-weekly", window: "weekly", resetTime: fiveDaysIso, remainingFraction: 1 },
					{ bucketId: "gemini-5h", window: "5h", resetTime: fiveHoursIso, remainingFraction: 1 },
				],
			},
			{
				displayName: "Claude and GPT models",
				buckets: [
					{ bucketId: "3p-weekly", window: "weekly", resetTime: twelveHoursIso, remainingFraction: 0.42 },
					{ bucketId: "3p-5h", window: "5h", resetTime: fiveHoursIso, remainingFraction: 1 },
				],
			},
			{
				displayName: "Gemini 4 Argon",
				buckets: [
					{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", resetTime: threeDaysIso, remainingFraction: 0 },
				],
			},
		]);
		expect(proRows.map(row => `${row.label}|${row.window?.id}`).sort()).toEqual([
			"Claude / GPT-OSS|5h",
			"Claude / GPT-OSS|7d",
			"Gemini Argon|7d",
			"Gemini|5h",
			"Gemini|7d",
		]);
		expect(proRows.find(row => row.label === "Gemini Argon")?.status).toBe("exhausted");
	});

	it("collapses stale cached reports that still carry per-model labels", () => {
		const scope = (modelId: string) => ({ provider: "google-antigravity" as const, modelId, windowId: "default" });
		const window = { id: "default", label: "Default", resetsAt: 2_000_000_000_000 };
		const rows = collapseUsageLimitsForDisplay([
			{
				id: "a",
				label: "Claude Opus 5.5 (Low)",
				scope: scope("claude-opus-5-5-low"),
				window,
				amount: { unit: "percent", remainingFraction: 0.4 },
			},
			{
				id: "b",
				label: "GPT-OSS 120B (Medium)",
				scope: scope("gpt-oss-120b-medium"),
				window,
				amount: { unit: "percent", remainingFraction: 0.4 },
			},
			{ id: "c", label: "Gemini 3 Flash", scope: scope("gemini-3-flash"), window, amount: { unit: "percent" } },
			{
				id: "d",
				label: "tab_flash_lite_preview",
				scope: scope("tab_flash_lite_preview"),
				amount: { unit: "percent", remainingFraction: 1 },
			},
		]);
		expect(rows.map(row => row.label).sort()).toEqual(["Claude / GPT-OSS", "Gemini"]);
		expect(rows.find(row => row.label === "Gemini")?.status).toBe("exhausted");
	});

	it("exposes the credential email so /usage labels accounts by email", async () => {
		const report = await fetchReport();
		expect(report.metadata?.email).toBe("me@example.com");
	});
});

/**
 * Fixtures are the 2026-10-27T18:40Z production captures of four real accounts.
 * `retrieveUserQuotaSummary` is stored verbatim; `fetchAvailableModels` is
 * reduced to one representative model per quota pool plus one internal and one
 * editor-only model. Every model of a pool shared a single `quotaInfo`
 * signature in the raw capture, so the pool classification is unchanged.
 */
const CAPTURE_DIR = path.join(import.meta.dir, "fixtures", "antigravity-2026-10-27");
const CAPTURED_AT_MS = Date.parse("2026-10-27T18:40:00Z");

async function capturedReport(account: string, options: { summary: boolean }) {
	const models: unknown = await Bun.file(path.join(CAPTURE_DIR, `${account}-fetchAvailableModels.json`)).json();
	const summary: unknown = await Bun.file(path.join(CAPTURE_DIR, `${account}-retrieveUserQuotaSummary.json`)).json();
	const report = await antigravityUsageProvider.fetchUsage(
		{
			provider: "google-antigravity",
			credential: {
				type: "oauth",
				accessToken: "token",
				projectId: "proj-1",
				accountId: `acct-${account}`,
				email: `${account}@example.com`,
			},
		},
		{
			fetch: (async (url: string | URL | Request) => {
				if (String(url).endsWith("/v1internal:retrieveUserQuotaSummary")) {
					return options.summary
						? new Response(JSON.stringify(summary), { status: 200 })
						: new Response("{}", { status: 500 });
				}
				return new Response(JSON.stringify(models), { status: 200 });
			}) as unknown as typeof fetch,
		},
	);
	if (!report) throw new Error(`expected a report for ${account}`);
	return collapseUsageLimitsForDisplay(report.limits);
}

describe("antigravity captured account pools", () => {
	const ULTRA_ROWS = ["Claude / GPT-OSS|5h", "Claude / GPT-OSS|7d", "Gemini|5h", "Gemini|7d"];
	const PRO_ROWS = ["Claude / GPT-OSS|5h", "Claude / GPT-OSS|7d", "Gemini Argon|7d", "Gemini|5h", "Gemini|7d"];

	function rowKeys(rows: Awaited<ReturnType<typeof capturedReport>>): string[] {
		return rows.map(row => `${row.label}|${row.window?.id}`).sort();
	}

	it("renders two pools for Ultra accounts and three for the Pro account", async () => {
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(CAPTURED_AT_MS);
		try {
			const cases = [
				["byteworx70", ULTRA_ROWS, 2],
				["byteworx71", ULTRA_ROWS, 2],
				["kkookk112727", ULTRA_ROWS, 2],
				["skuk27", PRO_ROWS, 3],
			] as const;
			for (const [account, expectedRows, expectedPools] of cases) {
				expect(rowKeys(await capturedReport(account, { summary: true }))).toEqual([...expectedRows].sort());

				// Without the quota summary, `fetchAvailableModels` alone still
				// separates the same pools: the Argon bucket signature matches the
				// general Gemini models on Ultra and differs on Pro.
				const withoutSummary = await capturedReport(account, { summary: false });
				const pools = new Set(withoutSummary.map(row => row.label));
				expect(pools.size).toBe(expectedPools);
				expect(pools.has("Gemini Argon")).toBe(account === "skuk27");
			}
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("keeps the captured readings and the omitted-zero Argon exhaustion", async () => {
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(CAPTURED_AT_MS);
		try {
			const ultra = await capturedReport("byteworx71", { summary: true });
			expect(
				ultra.find(row => row.label === "Gemini" && row.window?.id === "7d")?.amount.remainingFraction,
			).toBeCloseTo(0.21197523);
			expect(
				ultra.find(row => row.label === "Claude / GPT-OSS" && row.window?.id === "7d")?.amount.remainingFraction,
			).toBeCloseTo(0.055549);

			const drained = await capturedReport("kkookk112727", { summary: true });
			const drainedGemini = drained.find(row => row.label === "Gemini" && row.window?.id === "7d");
			expect(drainedGemini?.amount.remainingFraction).toBe(0);
			expect(drainedGemini?.status).toBe("exhausted");

			const pro = await capturedReport("skuk27", { summary: true });
			const argon = pro.find(row => row.label === "Gemini Argon");
			// `gemini-argon-wtu-weekly` arrives with resetTime but no remainingFraction.
			expect(argon?.window?.id).toBe("7d");
			expect(argon?.amount.remainingFraction).toBe(0);
			expect(argon?.status).toBe("exhausted");
			expect(
				pro.find(row => row.label === "Gemini" && row.window?.id === "7d")?.amount.remainingFraction,
			).toBeCloseTo(0.99973905);
		} finally {
			nowSpy.mockRestore();
		}
	});
});
