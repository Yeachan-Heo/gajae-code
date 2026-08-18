import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
	ApiKeyCredentialCheckResult,
	AuthStorage,
	CachedCredentialHealth,
	CachedUsageReport,
	CredentialHealthResult,
	CredentialInventoryRecord,
} from "@gajae-code/ai/core";
import {
	__setEnvApiKeyResolverForTests,
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

/** Synthetic credential constants. Never real credentials. */
const CODEX_ENV_KEY = "test-env-row-token";
const GROQ_ENV_KEY = "test-groq-row-token";

/**
 * Deterministic synthetic env-row coverage (reviews 4958546910, 4960174075,
 * 4961320650). The env-key resolver is injected through the account-inventory
 * test seam, so no test reads the inherited credential snapshot, agent/user
 * `.env` files, or shell startup files, and no test mutates process.env. The
 * production default remains the live getEnvApiKey; only these tests override
 * it, and afterEach restores it.
 */
const envKeys = new Map<string, string>([
	["openai-codex", CODEX_ENV_KEY],
	["groq", GROQ_ENV_KEY],
]);

beforeEach(() => {
	__setEnvApiKeyResolverForTests(provider => envKeys.get(provider));
});

afterEach(() => {
	__setEnvApiKeyResolverForTests(null);
});

/**
 * Assert that no row payload serializes the fixture's synthetic key. The
 * boolean comparison keeps the key out of failure output; both the raw and the
 * JSON-escaped representations are checked so quoting cannot evade it.
 */
function expectRowsRedactKey(snapshot: { rows: AccountInventoryRow[] }, key: string): void {
	const serialized = JSON.stringify(snapshot.rows);
	expect(serialized.includes(key)).toBe(false);
	expect(serialized.includes(JSON.stringify(key).slice(1, -1))).toBe(false);
}

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
		expectRowsRedactKey(snapshot, CODEX_ENV_KEY);
	});

	it("discovers an environment-only provider absent from stored inventory and the model registry", () => {
		const snapshot = buildAccountInventorySnapshot({
			authStorage: makeAuthStorage(),
			modelRegistry,
			nowMs: NOW,
		});
		const groq = snapshot.rows.find(row => row.source === "env" && row.provider === "groq");

		// "groq" is in neither the stored inventory nor modelRegistry.getAvailable,
		// so this row can only come from listProvidersWithEnvKey() + the env-key
		// resolver.
		expect(groq).toBeDefined();
		expect(groq?.credentialKind).toBe("api_key");
		expect(snapshot.rows.some(row => row.source === "stored" && row.provider === "groq")).toBe(false);
		expectRowsRedactKey(snapshot, GROQ_ENV_KEY);
	});

	it("probes the synthetic env row through checkApiKeyCredential and records the source health", async () => {
		const probed: Array<{ provider: string; keyMatches: boolean; baseUrl?: string }> = [];
		const recorded: Array<{ provider: string; source: string; health: CachedCredentialHealth }> = [];
		const authStorage = makeAuthStorage({
			getEffectiveCredentialType: () => "api_key",
			checkApiKeyCredential: async (
				provider: string,
				key: string,
				options,
			): Promise<ApiKeyCredentialCheckResult> => {
				probed.push({ provider, keyMatches: key === CODEX_ENV_KEY, baseUrl: options?.baseUrl });
				return { provider, type: "api_key", ok: true };
			},
			recordCredentialHealthForSource: (provider, source, health) => {
				recorded.push({ provider, source, health });
			},
		});

		const snapshot = await checkAccountInventory({ authStorage, modelRegistry, nowMs: NOW });
		const env = envRow(snapshot);
		const stored = storedRow(snapshot);

		// The injected resolver supplies exactly the synthetic fixture key; only a
		// non-secret boolean match is recorded, so no key material can appear in
		// matcher data or failure diagnostics, and a wrong-key or duplicate call
		// fails the count/match assertions.
		const codexProbes = probed.filter(entry => entry.provider === "openai-codex");
		expect(codexProbes.length).toBe(1);
		expect(codexProbes.every(entry => entry.keyMatches)).toBe(true);
		expect(codexProbes[0]?.baseUrl).toBe(BASE_URL);
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
		expectRowsRedactKey(snapshot, CODEX_ENV_KEY);
	});

	it("marks a failed API-key probe as failed health and records the sanitized reason", async () => {
		const recorded: Array<{ provider: string; source: string; health: CachedCredentialHealth }> = [];
		const authStorage = makeAuthStorage({
			getEffectiveCredentialType: () => "api_key",
			checkApiKeyCredential: async (provider: string): Promise<ApiKeyCredentialCheckResult> => ({
				provider,
				type: "api_key",
				ok: false,
				// Secret-like reason exercising asSafeLabel's credential scrubbing on
				// the row and the recorded source health; the raw value never appears.
				reason: "probe rejected api_key=sk-test-secret-value-123 (token=ghp_testtoken456)",
			}),
			recordCredentialHealthForSource: (provider, source, health) => {
				recorded.push({ provider, source, health });
			},
		});

		const snapshot = await checkAccountInventory({ authStorage, modelRegistry, nowMs: NOW });
		const env = envRow(snapshot);

		const sanitizedReason = "probe rejected api_key=[redacted] (token=[redacted]";
		expect(env?.health.status).toBe("failed");
		expect(env?.health.reason).toBe(sanitizedReason);
		expect(recorded.filter(entry => entry.provider === "openai-codex" && entry.source === "env")).toEqual([
			{
				provider: "openai-codex",
				source: "env",
				health: {
					status: "failed",
					reason: sanitizedReason,
					checkedAt: expect.any(Number),
					retainUntil: expect.any(Number),
				},
			},
		]);
		// The raw secret-like fragments never survive into row payloads.
		expect(JSON.stringify(snapshot.rows).includes("sk-test-secret-value-123")).toBe(false);
		expect(JSON.stringify(snapshot.rows).includes("ghp_testtoken456")).toBe(false);
	});

	it("marks an env row unverifiable when its key becomes unresolvable at check time", async () => {
		// The env row is built while the resolver resolves the fixture key, then the
		// resolver stops resolving it before the checker runs. This reaches the
		// production key-undefined fallback for an existing env row — the exact
		// branch a stale-credential regression would break — without deleting any
		// environment variable and without depending on host credential files.
		let resolveKey = true;
		__setEnvApiKeyResolverForTests(provider => (resolveKey ? envKeys.get(provider) : undefined));

		const probed: Array<{ provider: string; source: string }> = [];
		const recorded: Array<{ provider: string; source: string; health: CachedCredentialHealth }> = [];
		const authStorage = makeAuthStorage({
			getEffectiveCredentialType: () => "api_key",
			checkApiKeyCredential: async (provider: string, _key: string): Promise<ApiKeyCredentialCheckResult> => {
				// checkApiKeyCredential is only invoked from the synthetic-row loop;
				// every call in this fixture is an env-source call for this provider.
				probed.push({ provider, source: "env" });
				return { provider, type: "api_key", ok: null, reason: "stub" };
			},
			recordCredentialHealthForSource: (provider, source, health) => {
				recorded.push({ provider, source, health });
			},
		});

		const snapshotPromise = checkAccountInventory({ authStorage, modelRegistry, nowMs: NOW });
		// The checker resolves env keys synchronously inside its synthetic-row
		// loop after building the snapshot; flip before awaiting so the env row
		// exists but its key no longer resolves.
		resolveKey = false;
		const snapshot = await snapshotPromise;
		const env = envRow(snapshot);

		expect(env).toBeDefined();
		// No probe ran for the env row because its key could not be resolved.
		expect(probed.filter(entry => entry.provider === "openai-codex")).toEqual([]);
		expect(env?.health.status).toBe("unverifiable");
		expect(env?.health.reason).toBe("API-key source is unavailable");
		expect(recorded.filter(entry => entry.provider === "openai-codex" && entry.source === "env")).toEqual([
			{
				provider: "openai-codex",
				source: "env",
				health: {
					status: "unverifiable",
					reason: "API-key source is unavailable",
					checkedAt: expect.any(Number),
					retainUntil: expect.any(Number),
				},
			},
		]);
	});

	it("marks a synthetic runtime row unverifiable when its key source resolves nothing", async () => {
		// A runtime-source row exists purely through the hasRuntimeApiKey stub, so
		// this case never consults env resolution. peekApiKey returning undefined
		// drives the "API-key source is unavailable" fallback for the runtime row.
		const probed: Array<{ provider: string; source: string }> = [];
		const recorded: Array<{ provider: string; source: string; health: CachedCredentialHealth }> = [];
		const authStorage = makeAuthStorage({
			hasRuntimeApiKey: provider => provider === "openai-codex",
			getEffectiveCredentialType: () => "api_key",
			peekApiKey: async () => undefined,
			checkApiKeyCredential: async (provider: string): Promise<ApiKeyCredentialCheckResult> => {
				// checkApiKeyCredential is never reached for the runtime row here;
				// any call would be an env-row probe for this provider, which must
				// not happen while the env key resolves.
				probed.push({ provider, source: "env" });
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
		// The runtime row produced no probe (its peekApiKey resolved nothing); the
		// env row for this provider is the only other synthetic row and its probe
		// is permitted, so assert on the recorded source-health contract instead:
		// exactly one runtime record with the unavailable fallback.
		expect(
			probed.filter(entry => entry.provider === "openai-codex" && entry.source === "env").length,
		).toBeLessThanOrEqual(1);
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
