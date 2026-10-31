import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "../src/usage";
import type { OAuthCredentials } from "../src/utils/oauth/types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function createLimit(id: "grok-build:7d" | "grok-build:weekly", usedFraction: number, resetInMs: number): UsageLimit {
	const weekly = id === "grok-build:weekly";
	return {
		id,
		label: weekly ? "SuperGrok weekly credits" : "SuperGrok monthly credits",
		scope: { provider: "grok-build", windowId: weekly ? "weekly" : "7d", shared: true },
		window: {
			id: weekly ? "weekly" : "7d",
			label: weekly ? "Weekly" : "Monthly credits",
			durationMs: (weekly ? 7 : 30) * DAY_MS,
			resetsAt: Date.now() + resetInMs,
		},
		amount: {
			unit: "percent",
			used: usedFraction * 100,
			limit: 100,
			remaining: (1 - usedFraction) * 100,
			usedFraction,
			remainingFraction: 1 - usedFraction,
		},
		status: usedFraction >= 0.95 ? "exhausted" : usedFraction >= 0.8 ? "warning" : "ok",
	};
}

function createHybridReport(
	accountId: string,
	monthlyUsed: number,
	weeklyUsed: number,
	weeklyResetInMs: number,
): UsageReport {
	return {
		provider: "grok-build",
		fetchedAt: Date.now(),
		limits: [
			createLimit("grok-build:7d", monthlyUsed, 20 * DAY_MS),
			createLimit("grok-build:weekly", weeklyUsed, weeklyResetInMs),
		],
		metadata: { accountId },
	};
}

function createCredential(accountId: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
	};
}

describe("AuthStorage Grok hybrid quota ranking", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	const usageByAccount = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "grok-build",
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			return accountId ? (usageByAccount.get(accountId) ?? null) : null;
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-grok-selection-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		usageByAccount.clear();
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("balanced mode ranks hybrid accounts by weekly quota instead of monthly quota", async () => {
		if (!store) throw new Error("test setup failed");
		usageByAccount.set("weekly-free", createHybridReport("weekly-free", 0.9, 0.1, 6 * DAY_MS));
		usageByAccount.set("monthly-free", createHybridReport("monthly-free", 0.1, 0.8, 6 * DAY_MS));
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "grok-build" ? usageProvider : undefined),
		});
		await storage.reload();
		await storage.set("grok-build", [
			{ type: "oauth", ...createCredential("monthly-free") },
			{ type: "oauth", ...createCredential("weekly-free") },
		]);

		expect(await storage.getApiKey("grok-build", "session-balanced")).toBe("access-weekly-free");
	});

	test("earliest-reset mode uses the weekly reset timestamp in a hybrid report", async () => {
		if (!store) throw new Error("test setup failed");
		usageByAccount.set("soon", createHybridReport("soon", 0.9, 0.6, HOUR_MS));
		usageByAccount.set("late", createHybridReport("late", 0.1, 0.2, 6 * DAY_MS));
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "grok-build" ? usageProvider : undefined),
			credentialRankingMode: "earliest-reset",
		});
		await storage.reload();
		await storage.set("grok-build", [
			{ type: "oauth", ...createCredential("late") },
			{ type: "oauth", ...createCredential("soon") },
		]);

		expect(await storage.getApiKey("grok-build", "session-earliest-reset")).toBe("access-soon");
	});
});
