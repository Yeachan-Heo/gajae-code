import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialRankingMode,
	SqliteAuthCredentialStore,
} from "../src/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "../src/usage";
import * as oauthUtils from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

type WindowSpec = { usedFraction: number; resetInMs: number };

function createLimit(args: {
	id: "anthropic:5h" | "anthropic:7d";
	label: string;
	durationMs: number;
	spec: WindowSpec;
}): UsageLimit {
	const clamped = Math.min(Math.max(args.spec.usedFraction, 0), 1);
	const used = clamped * 100;
	return {
		id: args.id,
		label: args.label,
		scope: { provider: "anthropic", windowId: args.id, shared: false },
		window: {
			id: args.id,
			label: args.label,
			durationMs: args.durationMs,
			resetsAt: Date.now() + args.spec.resetInMs,
		},
		amount: {
			unit: "percent",
			used,
			limit: 100,
			remaining: 100 - used,
			usedFraction: clamped,
			remainingFraction: Math.max(0, 1 - clamped),
		},
		status: clamped >= 1 ? "exhausted" : clamped >= 0.9 ? "warning" : "ok",
	};
}

function createClaudeUsageReport(accountId: string, primary: WindowSpec, secondary: WindowSpec): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			createLimit({ id: "anthropic:5h", label: "5 Hour", durationMs: FIVE_HOUR_MS, spec: primary }),
			createLimit({ id: "anthropic:7d", label: "7 Day", durationMs: WEEK_MS, spec: secondary }),
		],
		metadata: { accountId },
	};
}

function createCredential(accountId: string, email: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
		email,
	};
}

describe("AuthStorage credentialRankingMode", () => {
	let tempDir = "";
	const stores: AuthCredentialStore[] = [];
	const usageByAccount = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "anthropic",
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		},
	};

	async function makeStorage(mode?: CredentialRankingMode): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, `agent-${stores.length}.db`));
		stores.push(store);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
			credentialRankingMode: mode,
		});
		await storage.reload();
		await storage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-soon", "soon@example.com") },
			{ type: "oauth", ...createCredential("acct-late", "late@example.com") },
		]);
		return storage;
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-ranking-mode-"));
		usageByAccount.clear();
		// acct-soon: 5h window resets in 10m (soonest), but drains its 7d window faster.
		usageByAccount.set(
			"acct-soon",
			createClaudeUsageReport(
				"acct-soon",
				{ usedFraction: 0.5, resetInMs: 10 * 60 * 1000 },
				{ usedFraction: 0.6, resetInMs: 5 * DAY_MS },
			),
		);
		// acct-late: 5h window resets in 4h (later), but is the least-drained account.
		usageByAccount.set(
			"acct-late",
			createClaudeUsageReport(
				"acct-late",
				{ usedFraction: 0.3, resetInMs: 4 * HOUR_MS },
				{ usedFraction: 0.3, resetInMs: 5 * DAY_MS },
			),
		);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials.anthropic as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const store of stores.splice(0)) store.close();
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("default (balanced) prefers the least-drained account", async () => {
		const storage = await makeStorage();
		const apiKey = await storage.getApiKey("anthropic", "session-balanced");
		expect(apiKey).toBe("api-acct-late");
	});

	test("balanced mode is explicit-equivalent to the default", async () => {
		const storage = await makeStorage("balanced");
		const apiKey = await storage.getApiKey("anthropic", "session-balanced-explicit");
		expect(apiKey).toBe("api-acct-late");
	});

	test("earliest-reset prefers the soonest-to-reset account (use-it-or-lose-it)", async () => {
		const storage = await makeStorage("earliest-reset");
		const apiKey = await storage.getApiKey("anthropic", "session-earliest-reset");
		expect(apiKey).toBe("api-acct-soon");
	});

	test("earliest-reset still skips an exhausted soon-to-reset account", async () => {
		// acct-soon's 5h window resets soonest but is fully exhausted → must fall to acct-late.
		usageByAccount.set(
			"acct-soon",
			createClaudeUsageReport(
				"acct-soon",
				{ usedFraction: 1, resetInMs: 10 * 60 * 1000 },
				{ usedFraction: 1, resetInMs: 10 * 60 * 1000 },
			),
		);
		const storage = await makeStorage("earliest-reset");
		const apiKey = await storage.getApiKey("anthropic", "session-earliest-reset-exhausted");
		expect(apiKey).toBe("api-acct-late");
	});
});
