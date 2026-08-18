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

function runtimeRow(snapshot: { rows: AccountInventoryRow[] }): AccountInventoryRow | undefined {
	return snapshot.rows.find(row => row.source === "runtime" && row.provider === "openai-codex");
}

/**
 * Assert that no row payload serializes the provider's resolved credential
 * value. The key is whatever the production resolver returns — fixture token or
 * a host-exported value pinned by the inherited-env snapshot — and the boolean
 * comparison keeps the key itself out of failure output.
 */
function expectRowsRedactKey(snapshot: { rows: AccountInventoryRow[] }, provider: string): void {
	const key = getEnvApiKey(provider);
	if (key === undefined) return;
	expect(JSON.stringify(snapshot.rows).includes(key)).toBe(false);
}

/**
 * Deterministic synthetic env-row coverage (reviews 4958546910, 4960174075).
 * Export repository-recognized provider variables — OPENAI_CODEX_OAUTH_TOKEN
 * maps to "openai-codex" and GROQ_API_KEY to "groq" in
 * packages/ai/src/stream.ts — around each test with save/restore so the
 * synthetic rows are built deterministically on credential-free CI runners.
 * Values are synthetic constants, never host credentials, and cleanup restores
 * the prior value (or deletes it) so the fixture cannot leak into other tests.
 * Cases that must NOT depend on env resolution use runtime-source stubs
 * instead, because getEnvApiKey also reads agent/user .env and shell-rc files
 * that a host machine may carry.
 */
const ENV_FIXTURES = {
	OPENAI_CODEX_OAUTH_TOKEN: "test-env-row-token",
	GROQ_API_KEY: "test-groq-row-token",
} as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
	for (const [name, value] of Object.entries(ENV_FIXTURES)) {
		savedEnv.set(name, process.env[name]);
		process.env[name] = value;
	}
});

afterEach(() => {
	for (const name of Object.keys(ENV_FIXTURES)) {
		const value = savedEnv.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
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
		expectRowsRedactKey(snapshot, "openai-codex");
	});

	it("discovers an environment-only provider absent from stored inventory and the model registry", () => {
		const snapshot = buildAccountInventorySnapshot({
			authStorage: makeAuthStorage(),
			modelRegistry,
			nowMs: NOW,
		});
		const groq = snapshot.rows.find(row => row.source === "env" && row.provider === "groq");

		// "groq" is in neither the stored inventory nor modelRegistry.getAvailable,
		// so this row can only come from listProvidersWithEnvKey() + getEnvApiKey.
		expect(groq).toBeDefined();
		expect(groq?.credentialKind).toBe("api_key");
		expect(snapshot.rows.some(row => row.source === "stored" && row.provider === "groq")).toBe(false);
		expectRowsRedactKey(snapshot, "groq");
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
		expect(probed.filter(entry => entry.provider === "openai-codex" && entry.key === expectedKey)).toEqual([
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
		expectRowsRedactKey(snapshot, "openai-codex");
	});

	it("marks a failed API-key probe as failed health and records the sanitized reason", async () => {
		const recorded: Array<{ provider: string; source: string; health: CachedCredentialHealth }> = [];
		const authStorage = makeAuthStorage({
			getEffectiveCredentialType: () => "api_key",
			checkApiKeyCredential: async (provider: string): Promise<ApiKeyCredentialCheckResult> => ({
				provider,
				type: "api_key",
				ok: false,
				reason: "stubbed probe failure",
			}),
			recordCredentialHealthForSource: (provider, source, health) => {
				recorded.push({ provider, source, health });
			},
		});

		const snapshot = await checkAccountInventory({ authStorage, modelRegistry, nowMs: NOW });
		const env = envRow(snapshot);

		expect(env?.health.status).toBe("failed");
		expect(env?.health.reason).toBe("stubbed probe failure");
		expect(recorded.filter(entry => entry.provider === "openai-codex" && entry.source === "env")).toEqual([
			{
				provider: "openai-codex",
				source: "env",
				health: {
					status: "failed",
					reason: "stubbed probe failure",
					checkedAt: expect.any(Number),
					retainUntil: expect.any(Number),
				},
			},
		]);
	});

	it("marks a synthetic runtime row unverifiable when its key source resolves nothing", async () => {
		// A runtime-source row exists purely through the hasRuntimeApiKey stub, so
		// this case never consults env files or shell-rc sources that a host
		// machine may carry. peekApiKey returning undefined drives the
		// "API-key source is unavailable" fallback in checkAccountInventory.
		// The env fixture value is dropped first so the runtime row is the only
		// synthetic row for this provider; a file-backed host value would keep an
		// env row too, which does not affect the runtime-row assertions below.
		delete process.env.OPENAI_CODEX_OAUTH_TOKEN;
		const probed: string[] = [];
		const recorded: Array<{ provider: string; source: string; health: CachedCredentialHealth }> = [];
		const authStorage = makeAuthStorage({
			hasRuntimeApiKey: provider => provider === "openai-codex",
			getEffectiveCredentialType: () => "api_key",
			peekApiKey: async () => undefined,
			checkApiKeyCredential: async (provider: string): Promise<ApiKeyCredentialCheckResult> => {
				probed.push(provider);
				return { provider, type: "api_key", ok: null, reason: "stub" };
			},
			recordCredentialHealthForSource: (provider, source, health) => {
				recorded.push({ provider, source, health });
			},
		});

		const snapshot = await checkAccountInventory({ authStorage, modelRegistry, nowMs: NOW });
		const runtime = runtimeRow(snapshot);

		expect(runtime).toBeDefined();
		expect(runtime?.routing).toEqual({ active: false, selected: true, marker: "selected" });
		// No key could be resolved for the runtime source, so no probe ran for it
		// and the unavailable fallback applied. Other env-backed providers may
		// resolve on the host; scope to this fixture's provider.
		expect(probed.filter(provider => provider === "openai-codex")).toEqual([]);
		expect(runtime?.health.status).toBe("unverifiable");
		expect(runtime?.health.reason).toBe("API-key source is unavailable");
		expect(recorded.filter(entry => entry.provider === "openai-codex" && entry.source === "runtime")).toEqual([
			{
				provider: "openai-codex",
				source: "runtime",
				health: {
					status: "unverifiable",
					reason: "API-key source is unavailable",
					checkedAt: expect.any(Number),
					retainUntil: expect.any(Number),
				},
			},
		]);
	});
});
