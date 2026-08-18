import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
	ApiKeyCredentialCheckResult,
	AuthStorage,
	CachedCredentialHealth,
	CachedUsageReport,
	CredentialHealthResult,
	CredentialInventoryRecord,
} from "@gajae-code/ai/core";
import { getEnvApiKey } from "@gajae-code/ai/core";
import {
	type AccountInventoryRow,
	buildAccountInventorySnapshot,
	checkAccountInventory,
} from "../src/session/account-inventory";

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
		checkApiKeyCredential: async (provider: string): Promise<ApiKeyCredentialCheckResult> => ({
			provider,
			type: "api_key",
			ok: null,
			reason: "stub",
		}),
		...overrides,
	} as unknown as AuthStorage;
}

/** Address the stored credential by identity: synthetic env rows shift indexes. */
function storedRow(snapshot: { rows: AccountInventoryRow[] }): AccountInventoryRow | undefined {
	return snapshot.rows.find(row => row.source === "stored" && row.provider === "openai-codex");
}

function envRow(snapshot: { rows: AccountInventoryRow[] }): AccountInventoryRow | undefined {
	return snapshot.rows.find(row => row.source === "env" && row.provider === "openai-codex");
}

/**
 * Deterministic synthetic env-row coverage (review 4958546910). Export a
 * repository-recognized provider variable (OPENAI_CODEX_OAUTH_TOKEN maps to
 * "openai-codex" in packages/ai/src/stream.ts) so every test below sees the
 * synthetic env row regardless of the host machine's real credentials, and
 * restore the prior value so the fixture cannot leak into other tests. The
 * value is a synthetic constant, never a host credential.
 */
const ENV_ROW_PROVIDER_VAR = "OPENAI_CODEX_OAUTH_TOKEN";
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
	savedEnv.set(ENV_ROW_PROVIDER_VAR, process.env[ENV_ROW_PROVIDER_VAR]);
	process.env[ENV_ROW_PROVIDER_VAR] = "test-env-row-token";
});

afterEach(() => {
	const value = savedEnv.get(ENV_ROW_PROVIDER_VAR);
	if (value === undefined) delete process.env[ENV_ROW_PROVIDER_VAR];
	else process.env[ENV_ROW_PROVIDER_VAR] = value;
	savedEnv.clear();
});

const modelRegistry = {
	getAvailable: () => [{ provider: "openai-codex" }],
	getProviderBaseUrl: () => BASE_URL,
};

describe("account inventory usage", () => {
	it("uses the provider base URL to retrieve cached usage for a stored credential", () => {
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
		const stored = storedRow(snapshot);

		expect(receivedBaseUrl).toBe(BASE_URL);
		expect(stored?.usage?.report.limits[0]?.label).toBe("7 days");
	});

	it("attaches a fresh check report directly when the persistent cache cannot be read back", async () => {
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
		const stored = storedRow(snapshot);

		expect(stored?.health.status).toBe("ok");
		expect(stored?.capabilities.hasCachedUsage).toBe(true);
		expect(stored?.usage?.report.limits[0]?.amount.used).toBe(24);
	});

	it("adds a synthetic env row for a provider whose mapped environment variable resolves", () => {
		const snapshot = buildAccountInventorySnapshot({
			authStorage: makeAuthStorage(),
			modelRegistry,
			nowMs: NOW,
		});
		const stored = storedRow(snapshot);
		const env = envRow(snapshot);

		// The synthetic row is presented alongside the stored credential, not as a
		// replacement for it.
		expect(stored).toBeDefined();
		expect(env).toBeDefined();
		expect(env?.credentialKind).toBe("api_key");
		expect(env?.identityLabel).toBeNull();
		expect(env?.capabilities).toEqual({
			canCheck: true,
			canPin: false,
			canRemove: false,
			hasCachedUsage: false,
		});
		// getEffectiveCredentialType stubs "oauth", so the env row is available but
		// not selected.
		expect(env?.routing).toEqual({ active: false, selected: false, marker: "available" });
		// Snapshot rows carry no API-key bytes.
		expect(JSON.stringify(snapshot.rows)).not.toContain("test-env-row-token");
	});

	it("probes the synthetic env row through checkApiKeyCredential and records the source health", async () => {
		const probed: Array<{ provider: string; key: string; baseUrl?: string }> = [];
		const recorded: Array<{ provider: string; source: string; health: CachedCredentialHealth }> = [];
		const authStorage = makeAuthStorage({
			getEffectiveCredentialType: () => "api_key",
			checkApiKeyCredential: async (
				provider: string,
				key: string,
				options,
			): Promise<ApiKeyCredentialCheckResult> => {
				probed.push({ provider, key, baseUrl: options?.baseUrl });
				return { provider, type: "api_key", ok: true };
			},
			recordCredentialHealthForSource: (provider, source, health) => {
				recorded.push({ provider, source, health });
			},
		});

		const snapshot = await checkAccountInventory({ authStorage, modelRegistry, nowMs: NOW });
		const env = envRow(snapshot);
		const stored = storedRow(snapshot);

		// Other env-backed providers may resolve on the host machine; scope the
		// assertion to this fixture's provider. The expected key comes from the
		// same resolver the production path uses, so a host-exported value pinned
		// by the inherited-env snapshot stays consistent with what was probed.
		const expectedKey = getEnvApiKey("openai-codex");
		expect(expectedKey).toBeDefined();
		expect(probed.filter(entry => entry.provider === "openai-codex")).toEqual([
			{ provider: "openai-codex", key: expectedKey ?? "", baseUrl: BASE_URL },
		]);
		expect(recorded.filter(entry => entry.provider === "openai-codex" && entry.source === "env")).toEqual([
			{
				provider: "openai-codex",
				source: "env",
				health: {
					status: "ok",
					reason: null,
					checkedAt: expect.any(Number),
					retainUntil: expect.any(Number),
				},
			},
		]);
		expect(env?.health.status).toBe("ok");
		expect(env?.health.reason).toBeNull();
		// The stored credential keeps its own identity-based row.
		expect(stored).toBeDefined();
		// Row payloads never carry the key bytes.
		expect(JSON.stringify(snapshot.rows)).not.toContain("test-env-row-token");
	});

	it("marks an unavailable synthetic source unverifiable without probing it", async () => {
		// The env variable resolves (beforeEach set it), but the check-path key
		// resolution is exercised through getEnvApiKey, which reads the same
		// variable. Remove it for this test to force the unavailable path.
		delete process.env[ENV_ROW_PROVIDER_VAR];

		const probed: string[] = [];
		const recorded: Array<{ provider: string; source: string; health: CachedCredentialHealth }> = [];
		const authStorage = makeAuthStorage({
			getEffectiveCredentialType: () => "api_key",
			hasRuntimeApiKey: () => false,
			hasConfigApiKey: () => false,
			checkApiKeyCredential: async (provider: string): Promise<ApiKeyCredentialCheckResult> => {
				probed.push(provider);
				return { provider, type: "api_key", ok: null, reason: "stub" };
			},
			recordCredentialHealthForSource: (provider, source, health) => {
				recorded.push({ provider, source, health });
			},
		});

		// The provider stays in providerSet via the model registry, but the env
		// row must not appear because the mapped variable does not resolve.
		const snapshot = await checkAccountInventory({ authStorage, modelRegistry, nowMs: NOW });
		const env = envRow(snapshot);

		// buildAccountInventorySnapshot's addSyntheticRows skips the env row when
		// getEnvApiKey does not resolve, so no env row and no probe happen here.
		expect(env).toBeUndefined();
		// Other env-backed providers may resolve on the host; this fixture's
		// provider must contribute no env row and no probe.
		expect(probed.filter(provider => provider === "openai-codex")).toEqual([]);
		expect(recorded.filter(entry => entry.provider === "openai-codex")).toEqual([]);
		expect(storedRow(snapshot)).toBeDefined();
	});
});
