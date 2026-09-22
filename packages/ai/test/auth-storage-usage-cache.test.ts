/**
 * Tests for the new usage-cache contracts introduced after the broker
 * migration surfaced Anthropic per-IP rate limits:
 *
 *   1. Per-credential cache stores the last successful report; failures
 *      DON'T overwrite a stale-but-good entry with null.
 *   2. With a stale-but-good entry, a failure serves the previous value
 *      (cached for a short cool-down) instead of dropping the credential
 *      from the report.
 *   3. Without a previous value, a failure returns null and DOES NOT cache —
 *      the next poll retries on the next request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "../src/auth-storage";
import type { UsageProvider, UsageReport } from "../src/usage";
import * as claudeUsage from "../src/usage/claude";

function anthropicReports(reports: UsageReport[] | null): UsageReport[] {
	return (reports ?? []).filter(r => r.provider === "anthropic");
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}

	throw new Error("Timed out waiting for condition");
}

/**
 * Force every cache entry to look stale to AuthStorage WITHOUT dropping the
 * value. The cache layer is two-tier: the store-level `expiresAtSec` controls
 * whether `getCache` returns anything at all, and the JSON payload's own
 * `expiresAt` is what AuthStorage compares against `Date.now()` to decide if
 * the entry is fresh. Mutating only the inner expiresAt simulates time
 * passing while keeping the last-good value reachable for the failure path.
 */
function expireCachePayloads(store: ObservableStore): void {
	for (const [key, entry] of store.cache) {
		try {
			const parsed = JSON.parse(entry.value);
			parsed.expiresAt = 1; // positive but already in the past (epoch ms)
			store.cache.set(key, { value: JSON.stringify(parsed), expiresAtSec: entry.expiresAtSec });
		} catch {
			// Non-JSON entries — leave alone.
		}
	}
}

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, CacheEntry>;
	leaseCalls: number[];
}

/**
 * Minimal in-memory `AuthCredentialStore` exposing the cache so we can
 * assert what AuthStorage writes to it during usage fetches.
 */
function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, CacheEntry>();
	const leaseCalls: number[] = [];
	let leaseOwner: string | undefined;
	return {
		cache,
		leaseCalls,
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			return rows;
		},
		upsertAuthCredentialForProvider() {
			return rows;
		},
		upsertAuthCredentialForProviderIfAbsent() {
			return { inserted: false, reason: "skipped-existing", provider: "anthropic", entries: rows };
		},
		deleteAuthCredentialsForProvider() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		tryAcquireUsageFetchLease(_key, owner, _nowMs, leaseMs) {
			leaseCalls.push(leaseMs);
			if (leaseOwner !== undefined) return false;
			leaseOwner = owner;
			return true;
		},
		releaseUsageFetchLease() {
			leaseOwner = undefined;
		},
		allocateMonotonicSequence() {
			return 1;
		},
		cleanExpiredCache() {},
	};
}

function oauthRow(id: number, email: string): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
		email,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

function makeReport(account: string): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "anthropic:5h",
				label: "5 Hour",
				scope: { provider: "anthropic", windowId: "5h" },
				window: { id: "5h", label: "5 Hour" },
				amount: { used: 42, limit: 100, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { email: account, accountId: `account-${account}` },
	};
}

describe("AuthStorage usage cache: last-good failure fallback", () => {
	let store: ObservableStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = makeStore([oauthRow(1, "a@example.com")]);
		// Restrict the resolver to anthropic. Without this, AuthStorage enumerates
		// every default provider and — for any provider whose `supports()` accepts
		// the matching `*_API_KEY` env var present on the test host — fans out a
		// real network fetch per poll. 3 polls × N real fetches blows past the 5s
		// test budget intermittently.
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("caches a successful report and replays it on a second poll", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return goldReport;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		const second = anthropicReports(await storage.fetchUsageReports());
		expect(second).toHaveLength(1);
		// Cache hit — provider was NOT called a second time.
		expect(calls).toBe(1);
	});

	it("cancels one aggregate caller without stopping its shared local usage fetch", async () => {
		const gate = Promise.withResolvers<UsageReport | null>();
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return gate.promise;
		});

		const controller = new AbortController();
		const cancelled = storage.fetchUsageReports({ signal: controller.signal });
		const cancelledOutcome = cancelled.then(
			() => "resolved" as const,
			() => "rejected" as const,
		);
		let peer: Promise<UsageReport[] | null> | undefined;
		try {
			await waitFor(() => calls === 1);
			peer = storage.fetchUsageReports();

			controller.abort();
			const outcome = await Promise.race([cancelledOutcome, Bun.sleep(100).then(() => "pending" as const)]);
			gate.resolve(goldReport);
			const peerReports = anthropicReports(await peer);

			expect(outcome).toBe("rejected");
			expect(peerReports).toHaveLength(1);
			expect(calls).toBe(1);
		} finally {
			controller.abort();
			gate.resolve(goldReport);
			await Promise.allSettled(peer ? [cancelled, peer] : [cancelled]);
		}
	});

	it("does not let an old scoped usage flight delete its replacement", async () => {
		storage.close();
		const rows = [oauthRow(1, "a@example.com")];
		store = makeStore(rows);
		const firstGate = Promise.withResolvers<UsageReport[] | null>();
		const secondGate = Promise.withResolvers<UsageReport[] | null>();
		let calls = 0;
		storage = new AuthStorage(store, {
			fetchUsageReports: async () => {
				calls += 1;
				return calls === 1 ? firstGate.promise : secondGate.promise;
			},
		});
		await storage.reload();
		store.removeAuthCredentialsHard = (_provider, targets) => {
			const ids = targets.map(target => target.id);
			for (let index = rows.length - 1; index >= 0; index -= 1) {
				if (ids.includes(rows[index]!.id)) rows.splice(index, 1);
			}
			return { kind: "removed", ids };
		};

		const first = storage.fetchUsageReports();
		await waitFor(() => calls === 1);
		const removal = storage.removeAuthCredentialsHard("anthropic", [
			{ id: 1, provider: "anthropic", expectedRevision: 1 },
		]);
		expect(removal.kind).toBe("removed");

		const second = storage.fetchUsageReports();
		await waitFor(() => calls === 2);
		const third = storage.fetchUsageReports();
		await Bun.sleep(0);
		expect(calls).toBe(2);

		firstGate.resolve([]);
		await first;
		secondGate.resolve([]);
		await Promise.all([second, third]);
		storage.close();
	});

	it("suppresses provider and account details for secret-safe callers", async () => {
		storage.close();
		const debug = vi.fn();
		const warn = vi.fn();
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			usageLogger: { debug, warn },
		});
		await storage.reload();
		const secret = "credential-sentinel@example.invalid";
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async (_params, context) => {
			expect(context.logger).toBeUndefined();
			return makeReport(secret);
		});

		const reports = await storage.fetchUsageReports({
			baseUrlResolver: () => `https://${secret}`,
			logDetails: false,
		});

		expect(anthropicReports(reports)).toHaveLength(1);
		expect(debug).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it("redacts identity and endpoint details from default usage diagnostics", async () => {
		storage.close();
		const debug = vi.fn();
		const warn = vi.fn();
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			usageLogger: { debug, warn },
		});
		await storage.reload();
		const secret = "credential-sentinel@example.invalid";
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(makeReport(secret));

		await storage.fetchUsageReports({ baseUrlResolver: () => `https://${secret}/v1` });

		const diagnostics = JSON.stringify(debug.mock.calls);
		expect(diagnostics).not.toContain(secret);
		expect(diagnostics).toContain('"credentials":1');
	});

	it("does NOT cache a failure when no previous good value exists — retries next poll", async () => {
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(0);
		expect(calls).toBe(1);

		const second = anthropicReports(await storage.fetchUsageReports());
		// No previous value → no cache write → retry on next poll.
		expect(calls).toBe(2);
		expect(second).toHaveLength(0);
	});

	it("serves last-good value through a failure cycle", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			if (calls === 1) return goldReport;
			return null;
		});

		// First poll: real fetch → cached.
		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		// Force every cached entry to expire so the next poll refetches.
		// Bun's `bun:test` doesn't ship setSystemTime, so we manipulate the
		// observable store cache directly — equivalent to advancing time past
		// the success TTL.
		expireCachePayloads(store);

		// Second poll: cache expired → refetch → provider returns null →
		// AuthStorage falls back to last-good and the report stays populated.
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(2);
		expect(second).toHaveLength(1);
		// The fallback value must be the SAME report (not a synthetic empty one).
		expect(second?.[0]?.limits[0]?.amount.used).toBe(42);
	});

	it("re-attempts the failing credential after the cool-down expires", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			// Succeed on attempt 1, fail on 2, succeed on 3.
			if (calls === 2) return null;
			return goldReport;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		// Expire success cache → poll 2 fetches and 429s → cool-down written.
		expireCachePayloads(store);
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(second).toHaveLength(1); // last-good fallback
		expect(calls).toBe(2);

		// Expire the cool-down → poll 3 refetches → success.
		expireCachePayloads(store);
		const third = anthropicReports(await storage.fetchUsageReports());
		expect(third).toHaveLength(1);
		expect(calls).toBe(3);
	});
});

describe("AuthStorage usage cache: jitter", () => {
	it("writes per-credential cache TTLs with ±25% jitter so refreshes decorrelate", async () => {
		const store = makeStore([oauthRow(1, "a@example.com"), oauthRow(2, "b@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		try {
			const goldA = makeReport("a@example.com");
			const goldB = makeReport("b@example.com");
			vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
				return params.credential.email === "a@example.com" ? goldA : goldB;
			});

			await storage.fetchUsageReports();

			// The store-level TTL is bumped to the 24h durable-retention floor so
			// `getStale` can recover last-good values; the freshness TTL we actually
			// jitter lives in the JSON payload. Read that, not the store TTL.
			const freshExpiries: number[] = [];
			for (const [key, entry] of store.cache) {
				if (!key.includes("usage_cache:report:")) continue;
				if (entry.value.length === 0) continue;
				const parsed = JSON.parse(entry.value);
				if (typeof parsed?.expiresAt === "number") freshExpiries.push(parsed.expiresAt);
			}
			expect(freshExpiries.length).toBeGreaterThanOrEqual(2);
			const now = Date.now();
			for (const expiry of freshExpiries) {
				const delta = expiry - now;
				expect(delta).toBeGreaterThan(3.5 * 60_000);
				expect(delta).toBeLessThan(6.5 * 60_000);
			}
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});

describe("AuthStorage usage cache: cross-process coordination", () => {
	it("sizes the aggregate lease from the configured request timeout", async () => {
		const store = makeStore([oauthRow(1, "a@example.com")]);
		const storage = new AuthStorage(store, {
			usageRequestTimeoutMs: 60_000,
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(makeReport("a@example.com"));
		try {
			await storage.fetchUsageReports();
			expect(store.leaseCalls[0]).toBeGreaterThanOrEqual(65_000);
		} finally {
			fetchSpy.mockRestore();
			storage.close();
		}
	});

	it("does not publish an aggregate result after credential mutation", async () => {
		const rows = [oauthRow(1, "a@example.com")];
		const store = makeStore(rows);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		const gate = Promise.withResolvers<UsageReport | null>();
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(() => gate.promise);
		try {
			const poll = storage.fetchUsageReports();
			await waitFor(() => fetchSpy.mock.calls.length === 1);

			rows[0] = oauthRow(2, "b@example.com");
			await storage.reload();
			gate.resolve(makeReport("a@example.com"));
			await poll;

			const aggregateKeys = [...store.cache.keys()].filter(key => key.includes("reports:"));
			expect(aggregateKeys).toHaveLength(0);
		} finally {
			gate.resolve(null);
			fetchSpy.mockRestore();
			storage.close();
		}
	});

	it("coalesces concurrent aggregate polls across SQLite-backed processes", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "pi-ai-usage-coordination-"));
		const dbPath = path.join(root, "agent.db");
		const firstStore = await SqliteAuthCredentialStore.open(dbPath);
		firstStore.saveOAuth("anthropic", {
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 3_600_000,
			accountId: "account-a",
			email: "a@example.com",
		});
		const secondStore = await SqliteAuthCredentialStore.open(dbPath);
		const first = new AuthStorage(firstStore, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		const second = new AuthStorage(secondStore, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await Promise.all([first.reload(), second.reload()]);

		const gate = Promise.withResolvers<UsageReport | null>();
		let calls = 0;
		const report = makeReport("a@example.com");
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return gate.promise;
		});
		let firstPoll: Promise<UsageReport[] | null> | undefined;
		let secondPoll: Promise<UsageReport[] | null> | undefined;
		try {
			firstPoll = first.fetchUsageReports();
			await waitFor(() => calls === 1);
			secondPoll = second.fetchUsageReports();
			await Bun.sleep(50);
			expect(calls).toBe(1);

			gate.resolve(report);
			expect((await firstPoll)?.map(item => item.provider)).toEqual(["anthropic"]);
			expect((await secondPoll)?.map(item => item.provider)).toEqual(["anthropic"]);
		} finally {
			gate.resolve(report);
			await Promise.allSettled([firstPoll ?? Promise.resolve(), secondPoll ?? Promise.resolve()]);
			fetchSpy.mockRestore();
			first.close();
			second.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("caches an empty aggregate completion for concurrent processes", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "pi-ai-usage-empty-coordination-"));
		const dbPath = path.join(root, "agent.db");
		const firstStore = await SqliteAuthCredentialStore.open(dbPath);
		firstStore.saveOAuth("anthropic", {
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 3_600_000,
			accountId: "account-a",
			email: "a@example.com",
		});
		const secondStore = await SqliteAuthCredentialStore.open(dbPath);
		const first = new AuthStorage(firstStore, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		const second = new AuthStorage(secondStore, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await Promise.all([first.reload(), second.reload()]);

		const gate = Promise.withResolvers<UsageReport | null>();
		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return gate.promise;
		});
		let firstPoll: Promise<UsageReport[] | null> | undefined;
		let secondPoll: Promise<UsageReport[] | null> | undefined;
		try {
			firstPoll = first.fetchUsageReports();
			await waitFor(() => calls === 1);
			secondPoll = second.fetchUsageReports();
			await Bun.sleep(50);
			expect(calls).toBe(1);

			gate.resolve(null);
			expect(await firstPoll).toEqual([]);
			expect(await secondPoll).toEqual([]);
			expect(await second.fetchUsageReports()).toEqual([]);
			expect(calls).toBe(2);
		} finally {
			gate.resolve(null);
			await Promise.allSettled([firstPoll ?? Promise.resolve(), secondPoll ?? Promise.resolve()]);
			fetchSpy.mockRestore();
			first.close();
			second.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("AuthStorage usage cache: API-key credential display", () => {
	const zaiProbe: UsageProvider = {
		id: "zai",
		fetchUsage: async () => null,
	};

	function apiKeyRow(id: number): StoredAuthCredential {
		return {
			id,
			provider: "zai",
			credential: { type: "api_key", key: `sk-test-zai-${id}` },
			disabledCause: null,
		};
	}

	function zaiReport(): UsageReport {
		return {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai-request-quota",
					label: "ZAI Request Quota",
					scope: { provider: "zai" },
					window: { id: "month", label: "Monthly" },
					amount: { used: 60, limit: 3000, unit: "requests" },
				},
			],
		};
	}

	it("surfaces the report cached by checkCredentials for API-key rows", async () => {
		const store = makeStore([apiKeyRow(1)]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "zai" ? zaiProbe : undefined),
		});
		await storage.reload();
		try {
			// Cache-only lookup before any probe: nothing to display yet.
			expect(storage.getCachedUsageReport("zai", 1)).toBeUndefined();

			vi.spyOn(zaiProbe, "fetchUsage").mockImplementation(async () => zaiReport());

			const results = await storage.checkCredentials({ provider: "zai" });
			expect(results[0]?.ok).toBe(true);

			const cached = storage.getCachedUsageReport("zai", 1);
			expect(cached?.freshness).toBe("fresh");
			expect(cached?.report.limits[0]?.label).toBe("ZAI Request Quota");
			expect(cached?.report.limits[0]?.amount.used).toBe(60);
			// The display observation must never leak credential bytes.
			expect(JSON.stringify(cached)).not.toContain("sk-test-zai-1");
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});

	it("stays undefined when the probe returns no data or the row id is unknown", async () => {
		const store = makeStore([apiKeyRow(1)]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "zai" ? zaiProbe : undefined),
		});
		await storage.reload();
		try {
			const results = await storage.checkCredentials({ provider: "zai" });
			expect(results[0]?.ok).not.toBe(true);
			expect(storage.getCachedUsageReport("zai", 1)).toBeUndefined();
			expect(storage.getCachedUsageReport("zai", 999)).toBeUndefined();
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});
