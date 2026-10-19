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
});
