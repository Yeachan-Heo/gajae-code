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
			// Just past freshness, still inside the 24h last-good retention window.
			parsed.expiresAt = Date.now() - 1;
			store.cache.set(key, { value: JSON.stringify(parsed), expiresAtSec: entry.expiresAtSec });
		} catch {
			// Non-JSON entries — leave alone.
		}
	}
}

/**
 * Simulate `ageMs` passing for every per-credential report: shift the report's
 * `fetchedAt` back and expire its freshness, and drop aggregate snapshots so
 * the next poll re-evaluates each credential.
 */
function ageStoredReports(store: ObservableStore, ageMs: number): void {
	for (const [key, entry] of store.cache) {
		if (key.includes("reports:")) {
			store.cache.delete(key);
			continue;
		}
		if (!key.includes("usage_cache:report:")) continue;
		const parsed = JSON.parse(entry.value);
		parsed.expiresAt = Date.now() - 1;
		if (parsed.value && typeof parsed.value.fetchedAt === "number") parsed.value.fetchedAt -= ageMs;
		store.cache.set(key, { value: JSON.stringify(parsed), expiresAtSec: entry.expiresAtSec });
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
	const leaseOwners = new Map<string, string>();
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
		tryAcquireUsageFetchLease(key, owner, _nowMs, leaseMs) {
			leaseCalls.push(leaseMs);
			if (leaseOwners.has(key)) return false;
			leaseOwners.set(key, owner);
			return true;
		},
		releaseUsageFetchLease(key, owner) {
			if (leaseOwners.get(key) === owner) leaseOwners.delete(key);
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

	it("cools down a failure with no previous good value, then retries after the cool-down", async () => {
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(0);
		expect(calls).toBe(1);

		// No previous value → the failure itself is cooled down (#5939), so an
		// immediate re-poll does not re-hit a rate-limited endpoint.
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(1);
		expect(second).toHaveLength(0);

		// Once the cool-down expires the next poll retries the provider.
		expireCachePayloads(store);
		const third = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(2);
		expect(third).toHaveLength(0);
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

	it("does not resurrect a last-good report older than the retention window on failure", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return calls === 1 ? goldReport : null;
		});

		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(1);

		// Age the stored report past the 24h last-good retention while leaving the
		// row readable (expired rows are not swept and now survive startup).
		ageStoredReports(store, 25 * 60 * 60_000);

		// The probe fails; the ancient report must not come back as a fallback.
		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(0);
		expect(calls).toBe(2);
	});

	it("repeated failures do not extend a last-good report past its retention", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return calls === 1 ? goldReport : null;
		});

		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(1);

		// 23h old: a failure still serves last-good, and rewrites the cool-down.
		ageStoredReports(store, 23 * 60 * 60_000);
		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(1);
		expect(calls).toBe(2);

		// Another 2h of failures: the rewrite must not have renewed its age.
		ageStoredReports(store, 2 * 60 * 60_000);
		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(0);
		expect(calls).toBe(3);
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
		const fetchSpy = vi
			.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage")
			.mockResolvedValue(makeReport("a@example.com"));
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
			// The failed probe is cooled down in the shared store (#5939): a later
			// poll from the peer process must not re-hit the provider.
			expect(await second.fetchUsageReports()).toEqual([]);
			expect(calls).toBe(1);
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

describe("AuthStorage usage cache: credential selection across processes (#5939)", () => {
	const anthropicOnly = (provider: string) => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined);

	async function openSharedDb(prefix: string): Promise<{ root: string; dbPath: string }> {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", prefix));
		const dbPath = path.join(root, "agent.db");
		const seed = await SqliteAuthCredentialStore.open(dbPath);
		for (const id of ["a", "b"]) {
			seed.saveOAuth("anthropic", {
				access: `access-${id}`,
				refresh: `refresh-${id}`,
				expires: Date.now() + 3_600_000,
				accountId: `account-${id}`,
				email: `${id}@example.com`,
			});
		}
		seed.close();
		return { root, dbPath };
	}

	async function openProcess(dbPath: string): Promise<AuthStorage> {
		// A fresh store + AuthStorage on the same agent.db models a new `gjc -p`.
		return AuthStorage.create(dbPath, { usageProviderResolver: anthropicOnly });
	}

	it("a new process reuses a peer's rate-limited probe instead of re-fetching usage", async () => {
		const { root, dbPath } = await openSharedDb("pi-ai-usage-5939-negative-");
		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null; // e.g. the endpoint answered 429 on every attempt
		});
		const first = await openProcess(dbPath);
		let second: AuthStorage | undefined;
		try {
			expect(await first.getApiKey("anthropic", "session-1")).toBeDefined();
			expect(calls).toBe(2); // one probe per credential for ranking

			// Selecting again in the same process must not re-probe either.
			expect(await first.getApiKey("anthropic", "session-2")).toBeDefined();
			expect(calls).toBe(2);

			second = await openProcess(dbPath);
			expect(await second.getApiKey("anthropic", "session-3")).toBeDefined();
			expect(calls).toBe(2);
		} finally {
			fetchSpy.mockRestore();
			first.close();
			second?.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("a new process reuses a peer's successful report for ranking", async () => {
		const { root, dbPath } = await openSharedDb("pi-ai-usage-5939-positive-");
		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			calls += 1;
			return makeReport(params.credential.email ?? "unknown");
		});
		const first = await openProcess(dbPath);
		let second: AuthStorage | undefined;
		try {
			await first.getApiKey("anthropic", "session-1");
			expect(calls).toBe(2);

			second = await openProcess(dbPath);
			await second.getApiKey("anthropic", "session-2");
			expect(calls).toBe(2);
		} finally {
			fetchSpy.mockRestore();
			first.close();
			second?.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("concurrent processes single-flight each credential's usage probe", async () => {
		const { root, dbPath } = await openSharedDb("pi-ai-usage-5939-concurrent-");
		const gate = Promise.withResolvers<UsageReport | null>();
		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return gate.promise;
		});
		const processes = await Promise.all([openProcess(dbPath), openProcess(dbPath), openProcess(dbPath)]);
		let selections: Promise<unknown>[] = [];
		try {
			selections = processes.map((storage, index) => storage.getApiKey("anthropic", `session-${index}`));
			await waitFor(() => calls === 2);
			await Bun.sleep(100);
			expect(calls).toBe(2);

			gate.resolve(null);
			for (const key of await Promise.all(selections)) expect(key).toBeDefined();
			expect(calls).toBe(2);
		} finally {
			gate.resolve(null);
			await Promise.allSettled(selections);
			fetchSpy.mockRestore();
			for (const storage of processes) storage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("cache-only probe mode ranks from a peer's cached reports without calling the provider", async () => {
		const { root, dbPath } = await openSharedDb("pi-ai-usage-5939-cache-only-");
		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			calls += 1;
			const report = makeReport(params.credential.email ?? "unknown");
			// Exhaust account a so ranking must prefer account b.
			if (params.credential.email === "a@example.com") report.limits[0]!.amount.used = 100;
			return report;
		});
		const printRun = await openProcess(dbPath);
		printRun.setUsageProbeMode("cache-only");
		let host: AuthStorage | undefined;
		try {
			// Cold cache: a print run selects a credential without any probe.
			expect(await printRun.getApiKey("anthropic", "print-1")).toMatch(/^access-/);
			expect(calls).toBe(0);

			// A long-lived host polls and caches reports in agent.db.
			host = await openProcess(dbPath);
			await host.fetchUsageReports();
			expect(calls).toBe(2);

			// A later print run ranks from those reports: exhausted a is skipped.
			const later = await openProcess(dbPath);
			later.setUsageProbeMode("cache-only");
			try {
				expect(await later.getApiKey("anthropic", "print-2")).toBe("access-b");
				expect(calls).toBe(2);
			} finally {
				later.close();
			}
		} finally {
			fetchSpy.mockRestore();
			printRun.close();
			host?.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("cache-only probe mode never calls a store's network usage hook (broker-backed runs)", async () => {
		let hookCalls = 0;
		const store: AuthCredentialStore = {
			...makeStore([oauthRow(1, "a@example.com"), oauthRow(2, "b@example.com")]),
			// RemoteAuthCredentialStore implements this by fetching the broker's /v1/usage.
			getUsageReport: async () => {
				hookCalls += 1;
				return makeReport("a@example.com");
			},
		};
		const storage = new AuthStorage(store, { usageProviderResolver: anthropicOnly });
		await storage.reload();
		try {
			storage.setUsageProbeMode("cache-only");
			expect(await storage.getApiKey("anthropic", "broker-print")).toMatch(/^oat-/);
			expect(hookCalls).toBe(0);

			// Network mode still routes ranking through the store hook.
			storage.setUsageProbeMode("network");
			await storage.getApiKey("anthropic", "broker-interactive");
			expect(hookCalls).toBeGreaterThan(0);
		} finally {
			storage.close();
		}
	});

	it("re-probes after a credential change instead of reusing the old report", async () => {
		const { root, dbPath } = await openSharedDb("pi-ai-usage-5939-invalidate-");
		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null;
		});
		const storage = await openProcess(dbPath);
		try {
			await storage.getApiKey("anthropic", "session-1");
			expect(calls).toBe(2);

			await storage.set("anthropic", [
				{
					type: "oauth",
					access: "access-c",
					refresh: "refresh-c",
					expires: Date.now() + 3_600_000,
					email: "c@example.com",
				},
				{
					type: "oauth",
					access: "access-d",
					refresh: "refresh-d",
					expires: Date.now() + 3_600_000,
					email: "d@example.com",
				},
			]);
			await storage.getApiKey("anthropic", "session-2");
			expect(calls).toBe(4);
		} finally {
			fetchSpy.mockRestore();
			storage.close();
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
