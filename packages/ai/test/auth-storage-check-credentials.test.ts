/**
 * Tests for `AuthStorage.checkCredentials()` — the per-credential auth probe
 * that powers `gjc auth-gateway check`. Contract under test:
 *
 *   1. A working credential reports `ok: true` and surfaces the probe's
 *      `email`/`accountId` (so the user can identify the row).
 *   2. A throwing provider probe reports `ok: false` with the error message
 *      in `reason` (so a 401 from upstream propagates as the diagnosis).
 *   3. A null probe (provider deliberately declined) reports `ok: null` with
 *      a "no data" reason — distinct from a failure.
 *   4. Expired OAuth credentials get refreshed before the probe; a failing
 *      refresh short-circuits to `ok: false` with `oauth refresh failed: …`
 *      WITHOUT calling the usage provider (the access token can't be valid
 *      when refresh is broken).
 *   5. Providers with no registered `UsageProvider` report `ok: null` with
 *      "no usage probe configured" — the credential's status is unknown,
 *      not failed.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "../src/auth-storage";
import * as claudeUsage from "../src/usage/claude";

function oauthRow(id: number, email: string, opts?: { expired?: boolean }): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: opts?.expired ? Date.now() - 60_000 : Date.now() + 3_600_000,
		accountId: `account-${id}`,
		email,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

function makeStore(
	rows: StoredAuthCredential[],
	refresh?: AuthCredentialStore["refreshOAuthCredential"],
): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
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
		cleanExpiredCache() {},
		...(refresh ? { refreshOAuthCredential: refresh } : {}),
	};
}

describe("AuthStorage.checkCredentials", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports ok=true and surfaces probe identity for a healthy credential", async () => {
		const store = makeStore([oauthRow(1, "alice@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue({
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "alice@example.com", accountId: "account-1" },
		});

		try {
			const [result] = await storage.checkCredentials();
			expect(result).toMatchObject({
				id: 1,
				provider: "anthropic",
				type: "oauth",
				email: "alice@example.com",
				accountId: "account-1",
				ok: true,
			});
			expect(result.reason).toBeUndefined();
			expect(result.report).toBeDefined();
		} finally {
			storage.close();
		}
	});

	it("reports ok=false with the upstream error when the probe throws", async () => {
		const store = makeStore([oauthRow(7, "bob@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockRejectedValue(
			new Error("401 Invalid authentication credentials"),
		);

		try {
			const [result] = await storage.checkCredentials();
			expect(result.id).toBe(7);
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("401");
			expect(result.reason).toContain("Invalid authentication");
			// Identity from the stored credential still surfaces so the user
			// can locate the broken row.
			expect(result.email).toBe("bob@example.com");
			expect(result.accountId).toBe("account-7");
		} finally {
			storage.close();
		}
	});

	it("reports ok=null with a no-data reason when the probe returns null", async () => {
		const store = makeStore([oauthRow(2, "carol@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);

		try {
			const [result] = await storage.checkCredentials();
			expect(result.ok).toBeNull();
			expect(result.reason).toMatch(/no data/);
		} finally {
			storage.close();
		}
	});

	it("short-circuits to ok=false when OAuth refresh fails on an expired credential", async () => {
		const refreshSpy = vi
			.fn<NonNullable<AuthCredentialStore["refreshOAuthCredential"]>>()
			.mockRejectedValue(new Error("invalid_grant: refresh token revoked"));
		const store = makeStore([oauthRow(3, "dave@example.com", { expired: true })], refreshSpy);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		const probe = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage");

		try {
			const [result] = await storage.checkCredentials();
			expect(result.ok).toBe(false);
			expect(result.reason).toMatch(/oauth refresh failed/);
			expect(result.reason).toContain("invalid_grant");
			// Probe MUST NOT run when refresh is broken — the access token
			// can't be valid in that state and we'd be calling the upstream
			// with a stale credential for no reason.
			expect(probe).not.toHaveBeenCalled();
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		} finally {
			storage.close();
		}
	});

	it("reports ok=null when no usage probe is configured for the provider", async () => {
		const apiKeyRow: StoredAuthCredential = {
			id: 9,
			provider: "made-up-provider",
			credential: { type: "api_key", key: "secret-key" },
			disabledCause: null,
		};
		const store = makeStore([apiKeyRow]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
		});
		await storage.reload();

		try {
			const [result] = await storage.checkCredentials();
			expect(result).toMatchObject({
				id: 9,
				provider: "made-up-provider",
				type: "api_key",
				ok: null,
			});
			expect(result.reason).toMatch(/no usage probe configured/);
		} finally {
			storage.close();
		}
	});

	it("returns per-credential results preserving order and identity across a mixed batch", async () => {
		const store = makeStore([
			oauthRow(1, "alpha@example.com"),
			oauthRow(2, "beta@example.com"),
			oauthRow(3, "gamma@example.com"),
		]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const token = params.credential.accessToken;
			if (token === "oat-1") {
				return {
					provider: "anthropic",
					fetchedAt: Date.now(),
					limits: [],
					metadata: { email: "alpha@example.com", accountId: "account-1" },
				};
			}
			if (token === "oat-2") {
				throw new Error("401 Invalid authentication credentials");
			}
			return null;
		});

		try {
			const results = await storage.checkCredentials();
			expect(results.map(r => ({ id: r.id, ok: r.ok }))).toEqual([
				{ id: 1, ok: true },
				{ id: 2, ok: false },
				{ id: 3, ok: null },
			]);
			expect(results[1].reason).toContain("Invalid authentication");
			// Every row keeps its stored-credential identity even when the probe
			// failed (the second one) or returned no data (the third one).
			expect(results[1].email).toBe("beta@example.com");
			expect(results[2].email).toBe("gamma@example.com");
		} finally {
			storage.close();
		}
	});
});
