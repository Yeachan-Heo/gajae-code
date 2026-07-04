import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "../src/auth-storage";
import type { UsageProvider, UsageReport } from "../src/usage";
import * as oauth from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";

// Routing-freshness / cache-poisoning regression suite.
//
// Guards the fix for the incident where a stale "exhausted" usage snapshot (from a
// persistently failing /usage probe) sidelined a genuinely healthy credential:
//   - stale usage must NOT block/deprioritize a credential in routing (freshness gate)
//   - an exhausted window whose reset is already in the past must NOT block (routing variant)
//   - a fresh exhausted window with a future reset STILL blocks (legit case preserved)
//   - past-reset exhausted windows must NOT influence ordering/reset priority
//   - stale Codex plan metadata must NOT promote/filter credentials for Spark routing
//   - a last-good snapshot older than the 24h retention is RETIRED, not re-served forever

const MIN = 60_000;
const HOUR = 60 * MIN;

type Scenario = "throw" | UsageReport;
let scenarios: Record<string, Scenario> = {};

function makeReport(
	accountId: string,
	opts: {
		fetchedAtMsAgo?: number;
		usedFraction?: number;
		exhausted?: boolean;
		resetsInMs?: number;
		planType?: string;
	},
): UsageReport {
	const now = Date.now();
	const usedFraction = opts.exhausted ? 1 : (opts.usedFraction ?? 0);
	return {
		provider: "openai-codex",
		fetchedAt: now - (opts.fetchedAtMsAgo ?? 0),
		limits: [
			{
				id: "openai-codex:primary",
				label: "Primary",
				scope: { provider: "openai-codex", accountId, windowId: "5h" },
				amount: { unit: "requests", used: Math.round(usedFraction * 100), limit: 100, usedFraction },
				status: opts.exhausted ? "exhausted" : "ok",
				...(opts.resetsInMs !== undefined
					? { window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR, resetsAt: now + opts.resetsInMs } }
					: {}),
			},
		],
		...(opts.planType !== undefined ? { metadata: { planType: opts.planType } } : {}),
	};
}

const usageProvider: UsageProvider = {
	id: "openai-codex",
	async fetchUsage(params) {
		const accountId = params.credential.accountId ?? "unknown";
		const scenario = scenarios[accountId];
		if (scenario === undefined) return null;
		if (scenario === "throw") throw new Error(`simulated probe failure for ${accountId}`);
		return scenario;
	},
};

describe("AuthStorage usage staleness / routing freshness", () => {
	let tempDir = "";
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-usage-staleness-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
		scenarios = {};
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"), {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});
		vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (_provider, credential) => credential);
		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["openai-codex"] as OAuthCredentials | undefined;
			if (!credential) return null;
			return { apiKey: `api-${credential.accountId ?? "unknown"}`, newCredentials: credential };
		});
	});

	afterEach(() => {
		setSystemTime();
		vi.restoreAllMocks();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
	});

	async function seedTwo(a: string, b: string): Promise<void> {
		await authStorage.set("openai-codex", [
			{ type: "oauth", access: `access-${a}`, refresh: `refresh-${a}`, expires: Date.now() + HOUR, accountId: a },
			{ type: "oauth", access: `access-${b}`, refresh: `refresh-${b}`, expires: Date.now() + HOUR, accountId: b },
		]);
	}

	async function useEarliestResetRanking(): Promise<void> {
		authStorage.close();
		authStorage = await AuthStorage.create(path.join(tempDir, "auth-earliest-reset.db"), {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
			credentialRankingMode: "earliest-reset",
		});
	}

	test("stale 'exhausted' snapshot does NOT block; the genuinely fresh-capped account is avoided instead", async () => {
		// The incident: acct-poison looks exhausted but the evidence is 20min old (a frozen
		// snapshot from a failing probe). acct-realcap is exhausted on a FRESH report with a
		// future reset. Only acct-realcap should be blocked; acct-poison must stay selectable.
		await seedTwo("poison", "realcap");
		scenarios.poison = makeReport("poison", { fetchedAtMsAgo: 20 * MIN, exhausted: true, resetsInMs: 2 * HOUR });
		scenarios.realcap = makeReport("realcap", { fetchedAtMsAgo: 0, exhausted: true, resetsInMs: 1 * HOUR });

		const key = await authStorage.getApiKey("openai-codex", "session-incident", { modelId: "gpt-5.5" });
		expect(key).toBe("api-poison");
	});

	test("fresh exhausted window with a PAST reset is not authoritative for routing (Change 3)", async () => {
		// acct-past is exhausted on a fresh report but its window already reset (resetsAt in
		// the past) — the exhaustion claim is stale, so it must not block. acct-future is a
		// live cap. Selection must land on acct-past.
		await seedTwo("past", "future");
		scenarios.past = makeReport("past", { fetchedAtMsAgo: 0, exhausted: true, resetsInMs: -1 * HOUR });
		scenarios.future = makeReport("future", { fetchedAtMsAgo: 0, exhausted: true, resetsInMs: 1 * HOUR });

		const key = await authStorage.getApiKey("openai-codex", "session-pastreset", { modelId: "gpt-5.5" });
		expect(key).toBe("api-past");
	});

	test("past-reset exhausted window does not win earliest-reset ordering", async () => {
		// The past-reset exhausted window is non-authoritative for all routing, not only
		// block detection. Under earliest-reset mode it must degrade to unknown instead of
		// winning just because its reset timestamp is already in the past.
		await useEarliestResetRanking();
		await seedTwo("pastbusy", "healthy");
		scenarios.pastbusy = makeReport("pastbusy", { fetchedAtMsAgo: 0, exhausted: true, resetsInMs: -1 * HOUR });
		scenarios.healthy = makeReport("healthy", { fetchedAtMsAgo: 0, usedFraction: 0.1 });

		const key = await authStorage.getApiKey("openai-codex", "session-pastreset-order", { modelId: "gpt-5.5" });
		expect(key).toBe("api-healthy");
	});

	test("fresh exhausted window with a FUTURE reset STILL blocks — legit cap preserved (regression)", async () => {
		// Guard against the fix over-opening: a genuinely fresh cap must still be avoided in
		// favour of the healthy account.
		await seedTwo("cap", "ok");
		scenarios.cap = makeReport("cap", { fetchedAtMsAgo: 0, exhausted: true, resetsInMs: 1 * HOUR });
		scenarios.ok = makeReport("ok", { fetchedAtMsAgo: 0, usedFraction: 0.1 });

		const key = await authStorage.getApiKey("openai-codex", "session-legit", { modelId: "gpt-5.5" });
		expect(key).toBe("api-ok");
	});

	test("stale high-usage report degrades to unknown for ordering, not treated as busy (Change 2)", async () => {
		// acct-stalebusy reads 95% used but the report is 20min old; acct-freshbusy reads a
		// real 60% used. Neither is exhausted, so neither is blocked. Stale usage must degrade
		// to the unknown-ordering default (~0.5) rather than its frozen 0.95, so it is NOT
		// deprioritized behind the genuinely-busier fresh account.
		await seedTwo("stalebusy", "freshbusy");
		scenarios.stalebusy = makeReport("stalebusy", { fetchedAtMsAgo: 20 * MIN, usedFraction: 0.95 });
		scenarios.freshbusy = makeReport("freshbusy", { fetchedAtMsAgo: 0, usedFraction: 0.6 });

		const key = await authStorage.getApiKey("openai-codex", "session-ordering", { modelId: "gpt-5.5" });
		expect(key).toBe("api-stalebusy");
	});

	test("stale Codex Pro metadata does not drive Spark routing priority or filtering", async () => {
		// Spark routing may display old plan metadata, but stale planType must not promote
		// or filter a credential. With no fresh Pro confirmation, the lower-usage fresh
		// unknown-plan report is attempted instead of the stale "pro" report.
		await seedTwo("stalepro", "freshunknown");
		scenarios.stalepro = makeReport("stalepro", {
			fetchedAtMsAgo: 20 * MIN,
			usedFraction: 0.95,
			planType: "pro",
		});
		scenarios.freshunknown = makeReport("freshunknown", {
			fetchedAtMsAgo: 0,
			usedFraction: 0.1,
		});

		const key = await authStorage.getApiKey("openai-codex", "session-stale-pro", { modelId: "gpt-5.5-spark" });
		expect(key).toBe("api-freshunknown");
	});

	test("last-good within the 24h retention is still served for display when the probe fails", async () => {
		const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
		setSystemTime(t0);
		await authStorage.set("openai-codex", [
			{ type: "oauth", access: "a", refresh: "r", expires: t0 + 1000 * HOUR, accountId: "acct" },
		]);
		scenarios.acct = makeReport("acct", { fetchedAtMsAgo: 0, usedFraction: 0.4 });

		const first = await authStorage.fetchUsageReports();
		expect(first?.some(r => r.limits[0]?.scope.accountId === "acct")).toBe(true);

		// Probe now fails; 23h later the last-good is stale-for-fresh but within retention.
		scenarios.acct = "throw";
		setSystemTime(t0 + 23 * HOUR);
		const served = await authStorage.fetchUsageReports();
		expect(served?.some(r => r.limits[0]?.scope.accountId === "acct")).toBe(true);
	});

	test("last-good older than the 24h retention is RETIRED, not resurrected (Change 1)", async () => {
		const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
		setSystemTime(t0);
		await authStorage.set("openai-codex", [
			{ type: "oauth", access: "a", refresh: "r", expires: t0 + 1000 * HOUR, accountId: "acct" },
		]);
		scenarios.acct = makeReport("acct", { fetchedAtMsAgo: 0, usedFraction: 0.4 });

		const first = await authStorage.fetchUsageReports();
		expect(first?.some(r => r.limits[0]?.scope.accountId === "acct")).toBe(true);

		// Probe fails for good; 25h later the last-good has aged past retention and must be
		// dropped rather than re-served (the resurrection loop the fix kills).
		scenarios.acct = "throw";
		setSystemTime(t0 + 25 * HOUR);
		const retired = await authStorage.fetchUsageReports();
		expect(retired?.some(r => r.limits[0]?.scope.accountId === "acct")).toBe(false);
	});
});
