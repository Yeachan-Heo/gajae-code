import { afterEach, describe, expect, it, vi } from "bun:test";
import type {
	AuthStorage,
	CachedUsageReport,
	CredentialHealthResult,
	CredentialInventoryRecord,
} from "@gajae-code/ai/core";
import * as aiCore from "@gajae-code/ai/core";
import { buildAccountInventorySnapshot, checkAccountInventory } from "../src/session/account-inventory";

const NOW = 1_700_000_000_000;
const BASE_URL = "https://chatgpt.com/backend-api";

const inventory: CredentialInventoryRecord[] = [
	{
		id: 1,
		provider: "openai-codex",
		credentialKind: "oauth",
		identityLabel: "user@example.com",
		disabled: false,
		disabledCause: null,
	},
];

function usageReport() {
	return {
		provider: "openai-codex",
		fetchedAt: NOW,
		limits: [
			{
				id: "openai-codex:secondary",
				label: "7 days",
				scope: { provider: "openai-codex", windowId: "7d" },
				window: { id: "7d", label: "7 days", resetsAt: NOW + 86_400_000 },
				amount: { used: 24, usedFraction: 0.24, remainingFraction: 0.76, unit: "percent" as const },
				status: "ok" as const,
			},
		],
	};
}

function makeAuthStorage(overrides: Partial<AuthStorage> = {}): AuthStorage {
	return {
		listCredentialInventory: () => inventory,
		listCredentialRemovalTargets: () => [],
		getCachedCredentialHealth: () => ({ status: "unknown", reason: null }),
		getCachedUsageReport: () => undefined,
		getSessionCredentialRowId: () => 1,
		hasRuntimeApiKey: () => false,
		hasConfigApiKey: () => false,
		getEffectiveCredentialType: () => "oauth",
		getGeneration: () => 1,
		checkCredentials: async () => [],
		// An exported provider key in the operator's shell makes the inventory add a
		// synthetic env row, which exercises these hooks. Stubbing them keeps the
		// test hermetic instead of passing only in a key-free environment.
		peekCachedCredentialHealthForSource: () => ({ status: "unknown", reason: null }),
		recordCredentialHealthForSource: () => undefined,
		peekApiKey: async () => undefined,
		checkApiKeyCredential: async () => ({ provider: "openai-codex", type: "api_key", ok: null }),
		...overrides,
	} as unknown as AuthStorage;
}

/** Synthetic credential constant. Never a real credential. */
const CODEX_ENV_KEY = "test-env-row-token";

/**
 * Make env-key resolution deterministic for one test: getEnvApiKey is spied at
 * the @gajae-code/ai/core boundary and restored after each test, so the suite
 * never reads the inherited credential snapshot, agent/user `.env` files, or
 * shell startup files — regardless of what the host machine carries — and never
 * mutates process.env.
 */
function stubEnvKey(provider: string, key: string | undefined): void {
	vi.spyOn(aiCore, "getEnvApiKey").mockImplementation(resolved => (resolved === provider ? key : undefined));
}

afterEach(() => {
	vi.restoreAllMocks();
});

const modelRegistry = {
	getAvailable: () => [{ provider: "openai-codex" }],
	getProviderBaseUrl: () => BASE_URL,
};

describe("account inventory usage", () => {
	it("uses the provider base URL to retrieve cached usage for a stored credential", () => {
		// A resolvable provider env key must not disturb the stored credential's
		// cached usage lookup even though it adds a synthetic row.
		stubEnvKey("openai-codex", CODEX_ENV_KEY);
		let receivedBaseUrl: string | undefined;
		const cached: CachedUsageReport = {
			report: usageReport(),
			fetchedAt: NOW,
			freshUntil: NOW + 60_000,
			retainUntil: NOW + 120_000,
			freshness: "fresh",
		};
		const authStorage = makeAuthStorage({
			getCachedUsageReport: (_provider, _credentialId, baseUrl) => {
				receivedBaseUrl = baseUrl;
				return cached;
			},
		});

		const snapshot = buildAccountInventorySnapshot({ authStorage, modelRegistry, nowMs: NOW });
		const stored = snapshot.rows.find(row => row.source === "stored" && row.provider === "openai-codex");

		expect(receivedBaseUrl).toBe(BASE_URL);
		expect(stored?.usage?.report.limits[0]?.label).toBe("7 days");
	});

	it("attaches a fresh check report directly when the persistent cache cannot be read back", async () => {
		stubEnvKey("openai-codex", CODEX_ENV_KEY);
		const result: CredentialHealthResult = {
			id: 1,
			provider: "openai-codex",
			type: "oauth",
			ok: true,
			report: usageReport(),
		};
		const authStorage = makeAuthStorage({
			checkCredentials: async () => [result],
			getCachedUsageReport: () => undefined,
		});

		const snapshot = await checkAccountInventory({ authStorage, modelRegistry, nowMs: NOW });
		const stored = snapshot.rows.find(row => row.source === "stored" && row.provider === "openai-codex");

		expect(stored?.health.status).toBe("ok");
		expect(stored?.capabilities.hasCachedUsage).toBe(true);
		expect(stored?.usage?.report.limits[0]?.amount.used).toBe(24);
	});

	it("keeps the suite green on a credential-free host by stubbing the synthetic env row", () => {
		// CI runners resolve no provider credentials, so the synthetic-row path
		// would otherwise never execute there. The spy guarantees the row exists
		// (and exercises the source-health hooks) on any host.
		stubEnvKey("openai-codex", CODEX_ENV_KEY);
		const snapshot = buildAccountInventorySnapshot({
			authStorage: makeAuthStorage(),
			modelRegistry,
			nowMs: NOW,
		});
		const env = snapshot.rows.find(row => row.source === "env" && row.provider === "openai-codex");

		expect(env).toBeDefined();
		// Row payloads never carry the key bytes.
		expect(JSON.stringify(snapshot.rows).includes(CODEX_ENV_KEY)).toBe(false);
	});
});
