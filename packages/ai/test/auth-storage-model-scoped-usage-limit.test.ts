import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "../src/usage";
import * as oauthUtils from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";

const HOUR_MS = 60 * 60 * 1000;

function createCredential(accountId: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
		email: `${accountId}@example.com`,
	};
}

describe("AuthStorage model-scoped usage limits", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-model-scoped-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-first") },
			{ type: "oauth", ...createCredential("acct-second") },
		]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	it("keeps a model-scoped limit out of another model's credential rotation", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const sessionId = "model-scope-session";
		const first = await authStorage.getOAuthAccess("anthropic", sessionId);
		const failedRowId = authStorage.getSessionCredentialRowId("anthropic", sessionId);
		expect(first).toBeDefined();
		expect(failedRowId).toBeTypeOf("number");

		const marked = await authStorage.markUsageLimitReached("anthropic", sessionId, {
			retryAfterMs: 60_000,
			modelId: "claude-sonnet-4-5",
		});
		expect(marked.state).toBe("marked");
		expect(marked.failedRowId).toBe(failedRowId!);
		expect(marked.remainingCredentialIds).not.toContain(failedRowId!);

		// Another model still gets the same credential: the limit was model-scoped.
		const otherModel = await authStorage.getOAuthAccess("anthropic", sessionId, { modelId: "claude-opus-4-1" });
		expect(otherModel?.accessToken).toBe(first?.accessToken);

		// The scoped model rotates away from the exhausted credential.
		const scopedModel = await authStorage.getOAuthAccess("anthropic", sessionId, {
			modelId: "claude-sonnet-4-5",
		});
		expect(scopedModel?.accessToken).toBeDefined();
		expect(scopedModel?.accessToken).not.toBe(first?.accessToken);
	}, 20_000);

	it("still blocks every model when the limit carries no model id", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const sessionId = "model-scope-wide-session";
		const first = await authStorage.getOAuthAccess("anthropic", sessionId);
		const failedRowId = authStorage.getSessionCredentialRowId("anthropic", sessionId)!;
		const marked = await authStorage.markUsageLimitReached("anthropic", sessionId, { retryAfterMs: 60_000 });
		expect(marked.state).toBe("marked");
		expect(marked.remainingCredentialIds).not.toContain(failedRowId);

		const otherModel = await authStorage.getOAuthAccess("anthropic", sessionId, { modelId: "claude-opus-4-1" });
		expect(otherModel?.accessToken).toBeDefined();
		expect(otherModel?.accessToken).not.toBe(first?.accessToken);
	}, 20_000);

	it("conservatively blocks callers without modelId when model-scoped limits exist", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const sessionId = "conservative-model-scope-session";
		const first = await authStorage.getOAuthAccess("anthropic", sessionId);
		const failedRowId = authStorage.getSessionCredentialRowId("anthropic", sessionId);
		expect(first).toBeDefined();
		expect(failedRowId).toBeTypeOf("number");

		// Mark the credential as exhausted for a specific model
		const marked = await authStorage.markUsageLimitReached("anthropic", sessionId, {
			retryAfterMs: 60_000,
			modelId: "claude-sonnet-4-5",
		});
		expect(marked.state).toBe("marked");

		// When calling getOAuthAccess WITHOUT a modelId, it should conservatively
		// block access (not return the same credential that's exhausted for Sonnet)
		const withoutModel = await authStorage.getOAuthAccess("anthropic", sessionId);
		expect(withoutModel?.accessToken).toBeDefined();
		expect(withoutModel?.accessToken).not.toBe(first?.accessToken);
	}, 20_000);

	it("threads model ID through markUsageLimitReached in credential rotation (P1 review)", async () => {
		if (!authStorage) throw new Error("test setup failed");
		vi.useFakeTimers();
		const sessionId = "p1-thread-modelid-session";

		try {
			// Get initial credential without model specificity (sticky to session)
			const accessPromise = authStorage.getOAuthAccess("anthropic", sessionId);
			// Skip past any usage fetch timeouts
			vi.advanceTimersByTime(11000);
			await Promise.resolve();
			const initialAccess = await accessPromise;
			expect(initialAccess).toBeDefined();
			const initialRowId = authStorage.getSessionCredentialRowId("anthropic", sessionId);
			const initialAccessToken = initialAccess?.accessToken;
			expect(initialAccessToken).toBeDefined();

			// Mark the credential as exhausted, passing modelId from agent-session
			// This tests that agent-session threads the failed model's ID through markUsageLimitReached
			const markPromise = authStorage.markUsageLimitReached("anthropic", sessionId, {
				retryAfterMs: 60_000,
				modelId: "claude-sonnet-4-5", // From the failed request's model
			});
			vi.advanceTimersByTime(11000);
			await Promise.resolve();
			const marked = await markPromise;
			expect(marked.state).toBe("marked");
			expect(marked.failedRowId).toBe(initialRowId);

			// Verify that marking with a modelId didn't block Opus from using the credential
			// (the block was scoped to Sonnet, so Opus should still have access to the original credential)
			const opusPromise = authStorage.getOAuthAccess("anthropic", sessionId, {
				modelId: "claude-opus-4-1",
			});
			vi.advanceTimersByTime(11000);
			await Promise.resolve();
			const opusAccess = await opusPromise;
			expect(opusAccess?.accessToken).toBe(initialAccessToken);
		} finally {
			vi.useRealTimers();
		}
	}, 20_000);

	it("treats a usage-report limit scoped to one model as that model's limit only", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const now = Date.now();
		const window = (id: string, label: string, durationMs: number) => ({
			id,
			label,
			durationMs,
			resetsAt: now + 60 * 60 * 1000,
		});
		const usedWindow = (used: number, durationMs: number, id: string, label: string): UsageLimit => ({
			id: `anthropic:${id}`,
			label,
			scope: { provider: "anthropic", accountId: "acct-first" },
			window: window(id, label, durationMs),
			amount: {
				unit: "percent",
				used: used * 100,
				limit: 100,
				remaining: (1 - used) * 100,
				usedFraction: used,
				remainingFraction: 1 - used,
			},
			status: used >= 1 ? "exhausted" : used >= 0.9 ? "warning" : "ok",
		});
		const scopedLimit: UsageLimit = {
			id: "anthropic:model:sonnet",
			label: "Sonnet only",
			scope: { provider: "anthropic", accountId: "acct-first", tier: "sonnet" },
			window: window("7d", "7 Day", 7 * 24 * 60 * 60 * 1000),
			amount: { unit: "percent", used: 100, limit: 100, remaining: 0, usedFraction: 1, remainingFraction: 0 },
			status: "exhausted",
		};
		const reports: Record<string, UsageReport> = {
			"acct-first": {
				provider: "anthropic",
				fetchedAt: now,
				limits: [
					scopedLimit,
					usedWindow(0.2, 5 * 60 * 60 * 1000, "5h", "5 Hour"),
					usedWindow(0.2, 7 * 24 * 60 * 60 * 1000, "7d", "7 Day"),
				],
			},
			"acct-second": {
				provider: "anthropic",
				fetchedAt: now,
				limits: [
					usedWindow(0.8, 5 * 60 * 60 * 1000, "5h", "5 Hour"),
					usedWindow(0.8, 7 * 24 * 60 * 60 * 1000, "7d", "7 Day"),
				],
			},
		};
		const usageProvider: UsageProvider = {
			id: "anthropic",
			async fetchUsage(params) {
				const accountId = params.credential.accountId;
				return accountId ? (reports[accountId] ?? null) : null;
			},
		};

		store?.close();
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "ranking.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
			credentialRankingMode: "balanced",
		});
		await authStorage.reload();
		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-first") },
			{ type: "oauth", ...createCredential("acct-second") },
		]);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials.anthropic as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
		});

		// The scoped limit constrains only Sonnet, so Opus still prefers the
		// less-drained account.
		const opus = await authStorage.getApiKey("anthropic", "scoped-model-session", {
			modelId: "claude-opus-4-1",
		});
		const sonnet = await authStorage.getApiKey("anthropic", "scoped-model-session-2", {
			modelId: "claude-sonnet-4-5",
		});
		expect(opus).toBe("api-acct-first");
		expect(sonnet).toBe("api-acct-second");
	}, 30_000);

	it("answers availability for the requested model when a backoff is scoped to another model", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const sessionId = "availability-model-scope-session";
		await authStorage.getOAuthAccess("anthropic", sessionId);
		const rowId = authStorage.getSessionCredentialRowId("anthropic", sessionId)!;
		const marked = await authStorage.markUsageLimitReached("anthropic", sessionId, {
			retryAfterMs: 60_000,
			modelId: "claude-sonnet-4-5",
		});
		expect(marked.state).toBe("marked");

		expect(authStorage.isCredentialAvailable("anthropic", rowId, "claude-opus-4-1")).toBe(true);
		expect(authStorage.isCredentialAvailable("anthropic", rowId, "claude-sonnet-4-5")).toBe(false);
		// Callers without model context stay conservative.
		expect(authStorage.isCredentialAvailable("anthropic", rowId)).toBe(false);
	}, 20_000);

	describe("usage reports with exhausted limits lacking a usable reset", () => {
		const exhausted = (id: string, scope: UsageLimit["scope"], resetsAt?: number): UsageLimit => ({
			id: `anthropic:${id}`,
			label: id,
			scope,
			window: { id, label: id, durationMs: 7 * 24 * HOUR_MS, ...(resetsAt === undefined ? {} : { resetsAt }) },
			amount: { unit: "percent", used: 100, limit: 100, remaining: 0, usedFraction: 1, remainingFraction: 0 },
			status: "exhausted",
		});
		const healthy = (accountId: string): UsageLimit => ({
			id: "anthropic:5h",
			label: "5 Hour",
			scope: { provider: "anthropic", accountId },
			window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + HOUR_MS },
			amount: { unit: "percent", used: 10, limit: 100, remaining: 90, usedFraction: 0.1, remainingFraction: 0.9 },
			status: "ok",
		});

		/** Rebuilds the storage with a usage provider whose acct-first report holds `firstLimits`. */
		async function useReports(firstLimits: UsageLimit[]): Promise<{ storage: AuthStorage; firstRowId: number }> {
			const reports: Record<string, UsageReport> = {
				"acct-first": { provider: "anthropic", fetchedAt: Date.now(), limits: firstLimits },
				"acct-second": { provider: "anthropic", fetchedAt: Date.now(), limits: [healthy("acct-second")] },
			};
			const usageProvider: UsageProvider = {
				id: "anthropic",
				async fetchUsage(params) {
					const accountId = params.credential.accountId;
					return accountId ? (reports[accountId] ?? null) : null;
				},
			};
			store?.close();
			store = await SqliteAuthCredentialStore.open(path.join(tempDir, "reset-less.db"));
			const storage = new AuthStorage(store, {
				usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
				credentialRankingMode: "balanced",
			});
			authStorage = storage;
			await storage.reload();
			await storage.set("anthropic", [
				{ type: "oauth", ...createCredential("acct-first") },
				{ type: "oauth", ...createCredential("acct-second") },
			]);
			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
				const credential = credentials.anthropic as OAuthCredentials | undefined;
				if (!credential?.accountId) return null;
				return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
			});
			const firstRowId = storage
				.listCredentialInventory("anthropic")
				.find(row => row.email === "acct-first@example.com")?.id;
			if (firstRowId === undefined) throw new Error("acct-first row missing");
			return { storage, firstRowId };
		}

		const sonnetOnlyResetLess = () => [
			exhausted("sonnet-7d", { provider: "anthropic", accountId: "acct-first", tier: "sonnet" }),
			healthy("acct-first"),
		];
		const wideResetLessPlusScoped = () => [
			exhausted("7d", { provider: "anthropic", accountId: "acct-first" }),
			exhausted(
				"sonnet-7d",
				{ provider: "anthropic", accountId: "acct-first", tier: "sonnet" },
				Date.now() + HOUR_MS,
			),
		];

		it("keeps a reset-less scoped limit on its model when a pinned credential is checked", async () => {
			const { storage, firstRowId } = await useReports(sonnetOnlyResetLess());
			await storage.getApiKey("anthropic", "pinned-scoped-session", {
				modelId: "claude-sonnet-4-5",
				credentialSelector: { kind: "id", value: String(firstRowId) },
			});
			expect(storage.isCredentialAvailable("anthropic", firstRowId, "claude-sonnet-4-5")).toBe(false);
			expect(storage.isCredentialAvailable("anthropic", firstRowId, "claude-opus-4-1")).toBe(true);
		}, 20_000);

		it("keeps a reset-less scoped limit on its model when ranking credentials", async () => {
			const { storage, firstRowId } = await useReports(sonnetOnlyResetLess());
			const sonnet = await storage.getApiKey("anthropic", "ranked-scoped-session", {
				modelId: "claude-sonnet-4-5",
			});
			expect(sonnet).toBe("api-acct-second");
			expect(storage.isCredentialAvailable("anthropic", firstRowId, "claude-sonnet-4-5")).toBe(false);
			expect(storage.isCredentialAvailable("anthropic", firstRowId, "claude-opus-4-1")).toBe(true);
		}, 20_000);

		it("keeps a reset-less wide limit credential-wide when a pinned credential is checked", async () => {
			const { storage, firstRowId } = await useReports(wideResetLessPlusScoped());
			await storage.getApiKey("anthropic", "pinned-wide-session", {
				modelId: "claude-sonnet-4-5",
				credentialSelector: { kind: "id", value: String(firstRowId) },
			});
			expect(storage.isCredentialAvailable("anthropic", firstRowId, "claude-opus-4-1")).toBe(false);
		}, 20_000);

		it("keeps a reset-less wide limit credential-wide when ranking credentials", async () => {
			const { storage, firstRowId } = await useReports(wideResetLessPlusScoped());
			console.error("PRE", storage.isCredentialAvailable("anthropic", firstRowId, "claude-opus-4-1"));
			await storage.getApiKey("anthropic", "ranked-wide-session", { modelId: "claude-sonnet-4-5" });
			expect(storage.isCredentialAvailable("anthropic", firstRowId, "claude-opus-4-1")).toBe(false);
		}, 20_000);

		it("keeps a reset-less wide limit credential-wide when a usage limit is reported", async () => {
			const { storage, firstRowId } = await useReports(wideResetLessPlusScoped());
			const marked = await storage.markUsageLimitReached("anthropic", undefined, {
				retryAfterMs: 60_000,
				rowId: firstRowId,
				modelId: "claude-sonnet-4-5",
			});
			expect(marked.state).toBe("marked");
			expect(storage.isCredentialAvailable("anthropic", firstRowId, "claude-opus-4-1")).toBe(false);
		}, 20_000);
	});
});
