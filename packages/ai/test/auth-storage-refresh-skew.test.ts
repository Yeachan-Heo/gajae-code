import { afterEach, beforeEach, describe, expect, it, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/utils/oauth";
import * as kimiOauth from "../src/utils/oauth/kimi";

// #957
describe("Kimi OAuth token lifetime and proactive credential refresh", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	const kimiHeadersStub = {
		"User-Agent": "KimiCLI/0.0.0",
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": "0.0.0",
		"X-Msh-Device-Name": "test",
		"X-Msh-Device-Model": "test",
		"X-Msh-Os-Version": "test",
		"X-Msh-Device-Id": "test",
	} as const;

	it("subtracts the 5-minute skew when parsing Kimi token expiry", async () => {
		// Kimi tokens claim a 60-minute lifetime via `expires_in`, but in
		// practice the server invalidates them roughly 5 minutes earlier than
		// that. parseTokenPayload subtracts OAUTH_EXPIRY_SKEW_MS (5 min) so we
		// schedule the refresh before the real server cutoff.
		const issuedAt = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(issuedAt);
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(kimiHeadersStub);

		global.fetch = (async (_input: string | URL, init?: RequestInit) => {
			const params = new URLSearchParams(String(init?.body));
			expect(params.get("grant_type")).toBe("refresh_token");
			expect(params.get("refresh_token")).toBe("refresh-0");
			return new Response(
				JSON.stringify({
					access_token: "access-1",
					refresh_token: "refresh-1",
					expires_in: 60 * 60,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const refreshed = await kimiOauth.refreshKimiToken("refresh-0");

		expect(refreshed.access).toBe("access-1");
		expect(refreshed.refresh).toBe("refresh-1");
		expect(refreshed.expires).toBe(issuedAt + 55 * 60 * 1000);
	});

	it("refreshes Kimi credentials through AuthStorage before the local expiry", async () => {
		// End-to-end: a kimi-code OAuth credential that is past the 60s
		// AuthStorage skew must be refreshed automatically via the registered
		// `kimi-code` provider when getApiKey() is called.
		const issuedAt = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(issuedAt + 54 * 60 * 1000);
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(kimiHeadersStub);

		let refreshCalls = 0;
		global.fetch = (async (_input: string | URL, init?: RequestInit) => {
			refreshCalls += 1;
			const params = new URLSearchParams(String(init?.body));
			expect(params.get("grant_type")).toBe("refresh_token");
			expect(params.get("refresh_token")).toBe("refresh-stored");
			return new Response(
				JSON.stringify({
					access_token: "access-refreshed",
					refresh_token: "refresh-refreshed",
					expires_in: 60 * 60,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-issue-957-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.set("kimi-code", [
				{
					type: "oauth",
					access: "access-stored",
					refresh: "refresh-stored",
					// Token is still nominally valid (4 min remaining), but
					// within the 60s AuthStorage skew the refresh should fire
					// proactively so we never hand out an expired bearer.
					expires: issuedAt + 55 * 60 * 1000,
				},
			]);

			const apiKey = await authStorage.getApiKey("kimi-code");
			expect(apiKey).toBe("access-refreshed");
			expect(refreshCalls).toBe(1);

			const stored = store.listAuthCredentials("kimi-code");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.access).toBe("access-refreshed");
				expect(stored[0].credential.refresh).toBe("refresh-refreshed");
			}
		} finally {
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("AuthStorage OAuth refresh skew", () => {
	let tempDir = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-refresh-skew-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		unregisterOAuthProviders("auth-storage-refresh-skew-test");
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("refreshes before strict expiry when the credential is inside the 60s skew", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		let refreshCalls = 0;
		const refreshedExpires = Date.now() + 60 * 60_000;
		registerOAuthProvider({
			id: "unit-oauth-skew",
			name: "Unit OAuth Skew",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return {
					...credentials,
					access: "access-after-skew-refresh",
					refresh: "refresh-after-skew-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-skew", [
			{
				type: "oauth",
				access: "access-before-skew-refresh",
				refresh: "refresh-before-skew-refresh",
				expires: Date.now() + 30_000,
			},
		]);

		expect(authStorage.getProviderOAuthRefreshGeneration("unit-oauth-skew")).toBe(0);
		const apiKey = await authStorage.getApiKey("unit-oauth-skew", "skew-session");

		expect(apiKey).toBe("access-after-skew-refresh");
		expect(refreshCalls).toBe(1);
		expect(authStorage.getProviderOAuthRefreshGeneration("unit-oauth-skew")).toBe(1);
		const stored = store.listAuthCredentials("unit-oauth-skew");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.access).toBe("access-after-skew-refresh");
			expect(stored[0].credential.refresh).toBe("refresh-after-skew-refresh");
		}
	});

	test("coalesces concurrent skew refreshes for the same credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		let refreshCalls = 0;

		registerOAuthProvider({
			id: "unit-oauth-skew-mutex",
			name: "Unit OAuth Skew Mutex",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-after-shared-skew-refresh",
					refresh: "refresh-after-shared-skew-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-skew-mutex", [
			{
				type: "oauth",
				access: "access-before-shared-skew-refresh",
				refresh: "refresh-before-shared-skew-refresh",
				expires: Date.now() + 30_000,
			},
		]);

		const first = authStorage.getApiKey("unit-oauth-skew-mutex", "same-session");
		const second = authStorage.getApiKey("unit-oauth-skew-mutex", "same-session");

		await refreshStarted.promise;
		allowRefresh.resolve();

		await expect(first).resolves.toBe("access-after-shared-skew-refresh");
		await expect(second).resolves.toBe("access-after-shared-skew-refresh");
		expect(refreshCalls).toBe(1);
	});
	test("coalesces concurrent command-backed credential resolution", async () => {
		if (!store) throw new Error("test setup failed");

		const resolution = Promise.withResolvers<string | undefined>();
		let resolverCalls = 0;
		const commandStorage = new AuthStorage(store, {
			configValueResolver: async config => {
				expect(config).toBe("!command-key");
				resolverCalls += 1;
				return resolution.promise;
			},
		});
		await commandStorage.set("xai", [{ type: "api_key", key: "!command-key" }]);

		const first = commandStorage.getApiKey("xai");
		const second = commandStorage.getApiKey("xai");
		expect(resolverCalls).toBe(1);

		resolution.resolve("resolved-command-key");

		await expect(first).resolves.toBe("resolved-command-key");
		await expect(second).resolves.toBe("resolved-command-key");
		expect(commandStorage.hasAuth("xai")).toBeTrue();
	});
	test("retires a command-key flight after credentials are replaced", async () => {
		if (!store) throw new Error("test setup failed");

		const firstResolution = Promise.withResolvers<string | undefined>();
		const secondResolution = Promise.withResolvers<string | undefined>();
		let resolverCalls = 0;
		const resolverScopes: string[] = [];
		const commandStorage = new AuthStorage(store, {
			configValueResolver: async (_config, cacheScope) => {
				resolverScopes.push(cacheScope ?? "");
				resolverCalls += 1;
				return resolverCalls === 1 ? firstResolution.promise : secondResolution.promise;
			},
		});
		await commandStorage.set("xai", [{ type: "api_key", key: "!command-key" }]);

		const first = commandStorage.getApiKey("xai");
		expect(resolverCalls).toBe(1);

		await commandStorage.set("xai", []);
		await commandStorage.set("xai", [{ type: "api_key", key: "!command-key" }]);
		const second = commandStorage.getApiKey("xai");
		expect(resolverCalls).toBe(2);
		expect(resolverScopes[1]).not.toBe(resolverScopes[0]);

		secondResolution.resolve("new-command-key");
		await expect(second).resolves.toBe("new-command-key");
		const currentEvidence = commandStorage.getProviderEvidenceGeneration("xai");

		firstResolution.resolve("old-command-key");
		// A retired configuration generation must neither return its key nor invalidate current evidence.
		await expect(first).resolves.toBeUndefined();
		expect(commandStorage.getProviderEvidenceGeneration("xai")).toBe(currentEvidence);
	});
	test("matches command credentials with their resolution scope", async () => {
		if (!store) throw new Error("test setup failed");

		const commandStorage = new AuthStorage(store, {
			configValueResolver: async (_config, cacheScope) => {
				if (cacheScope === undefined) return "wrong-unscoped-key";
				return "current-command-key";
			},
		});
		await commandStorage.set("xai", [{ type: "api_key", key: "!command-key" }]);

		await expect(commandStorage.getApiKey("xai")).resolves.toBe("current-command-key");
		await expect(commandStorage.invalidateCredentialMatching("xai", "current-command-key")).resolves.toBeTrue();
	});
	test("marks a rejected command-backed credential unusable", async () => {
		if (!store) throw new Error("test setup failed");

		let rejectResolution = false;
		const commandStorage = new AuthStorage(store, {
			configValueResolver: async () => {
				if (rejectResolution) throw new Error("command failed");
				return "resolved-command-key";
			},
		});
		await commandStorage.set("xai", [{ type: "api_key", key: "!command-key" }]);

		await expect(commandStorage.getApiKey("xai")).resolves.toBe("resolved-command-key");
		const resolvedEvidence = commandStorage.getProviderEvidenceGeneration("xai");
		rejectResolution = true;

		await expect(commandStorage.getApiKey("xai")).rejects.toThrow("command failed");
		expect(commandStorage.hasUsableAuth("xai")).toBeFalse();
		expect(commandStorage.getProviderEvidenceGeneration("xai")).not.toBe(resolvedEvidence);
	});
	test("excludes a transiently blocked OAuth credential from usable auth", async () => {
		if (!authStorage) throw new Error("test setup failed");

		registerOAuthProvider({
			id: "unit-oauth-transient",
			name: "Unit OAuth Transient",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken() {
				throw new Error("temporary token endpoint failure");
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		await authStorage.set("unit-oauth-transient", [
			{
				type: "oauth",
				access: "expiring-access",
				refresh: "refresh-access",
				expires: Date.now() + 30_000,
			},
		]);

		await expect(authStorage.getApiKey("unit-oauth-transient")).resolves.toBeUndefined();
		expect(authStorage.hasUsableAuth("unit-oauth-transient")).toBeFalse();
		expect(authStorage.getEffectiveCredentialType("unit-oauth-transient")).toBe("oauth");
	});
	test("does not fall through a blocked API-key selection to OAuth", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("unit-mixed-auth", [
			{ type: "api_key", key: "blocked-api-key" },
			{
				type: "oauth",
				access: "unblocked-oauth-access",
				refresh: "unblocked-oauth-refresh",
				expires: Date.now() + 60 * 60_000,
			},
		]);

		await expect(authStorage.getApiKey("unit-mixed-auth", "mixed-session")).resolves.toBe("blocked-api-key");
		await authStorage.markUsageLimitReached("unit-mixed-auth", "mixed-session");

		expect(authStorage.hasUsableAuth("unit-mixed-auth")).toBeFalse();
	});
	test("prefers a usable API key to an unresolved command key", async () => {
		if (!store) throw new Error("test setup failed");

		let commandCalls = 0;
		const commandStorage = new AuthStorage(store, {
			configValueResolver: async key => {
				if (key === "!empty-command-key") {
					commandCalls += 1;
					return undefined;
				}
				return key;
			},
		});
		await commandStorage.set("xai", [
			{ type: "api_key", key: "!empty-command-key" },
			{ type: "api_key", key: "working-api-key" },
		]);

		await expect(commandStorage.getApiKey("xai")).resolves.toBe("working-api-key");
		expect(commandCalls).toBe(0);
		expect(commandStorage.hasUsableAuth("xai")).toBeTrue();
	});

	test("keeps a session-selected OAuth credential ahead of stored API keys", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerOAuthProvider({
			id: "unit-session-oauth",
			name: "Unit Session OAuth",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		await authStorage.set("unit-session-oauth", [
			{ type: "api_key", key: "stored-api-key" },
			{
				type: "oauth",
				access: "session-oauth-access",
				refresh: "session-oauth-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "session@example.com",
			},
		]);
		authStorage.setRuntimeCredentialSelector("unit-session-oauth", {
			kind: "email",
			value: "session@example.com",
		});
		await expect(authStorage.getApiKey("unit-session-oauth", "sticky-session")).resolves.toBe("session-oauth-access");
		authStorage.removeRuntimeCredentialSelector("unit-session-oauth");

		expect(authStorage.getEffectiveCredentialType("unit-session-oauth", "sticky-session")).toBe("oauth");
		await expect(authStorage.getApiKey("unit-session-oauth", "sticky-session")).resolves.toBe("session-oauth-access");
	});

	test("fails effective provenance closed for a dangling selector even with an override", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("unit-dangling-selector", [
			{
				type: "oauth",
				access: "selected-access",
				refresh: "selected-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "selected@example.com",
			},
		]);
		authStorage.setRuntimeCredentialSelector("unit-dangling-selector", {
			kind: "email",
			value: "selected@example.com",
		});
		await authStorage.set("unit-dangling-selector", []);
		authStorage.setRuntimeApiKey("unit-dangling-selector", "runtime-override");

		expect(authStorage.getEffectiveCredentialType("unit-dangling-selector")).toBeUndefined();
		await expect(authStorage.getApiKey("unit-dangling-selector")).rejects.toThrow("cannot be used");
	});

	test("keeps blocked selected OAuth provenance aligned with its request fallback", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerOAuthProvider({
			id: "unit-blocked-selected-oauth",
			name: "Unit Blocked Selected OAuth",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		await authStorage.set("unit-blocked-selected-oauth", [
			{
				type: "oauth",
				access: "blocked-selected-access",
				refresh: "blocked-selected-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "blocked@example.com",
			},
		]);
		authStorage.setRuntimeCredentialSelector("unit-blocked-selected-oauth", {
			kind: "email",
			value: "blocked@example.com",
		});
		await expect(authStorage.getApiKey("unit-blocked-selected-oauth", "blocked-session")).resolves.toBe(
			"blocked-selected-access",
		);
		await authStorage.markUsageLimitReached("unit-blocked-selected-oauth", "blocked-session");

		expect(authStorage.getEffectiveCredentialType("unit-blocked-selected-oauth", "blocked-session")).toBe("oauth");
		await expect(authStorage.getApiKey("unit-blocked-selected-oauth", "blocked-session")).resolves.toBe(
			"blocked-selected-access",
		);
	});

	test("ranks refreshable expired OAuth ahead of a fallback key", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerOAuthProvider({
			id: "unit-expired-oauth",
			name: "Unit Expired OAuth",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: "refreshed-oauth-access",
					expires: Date.now() + 60 * 60_000,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		authStorage.setFallbackResolver(() => "fallback-key");
		await authStorage.set("unit-expired-oauth", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "expired-refresh",
				expires: Date.now() - 1,
			},
		]);

		expect(authStorage.getEffectiveCredentialType("unit-expired-oauth")).toBe("oauth");
		await expect(authStorage.getApiKey("unit-expired-oauth")).resolves.toBe("refreshed-oauth-access");
	});

	test("normalizes device aliases across overrides and effective provenance", async () => {
		if (!authStorage) throw new Error("test setup failed");
		authStorage.setRuntimeApiKey("openai-codex-device", "device-runtime-key");

		expect(authStorage.hasRuntimeApiKey("openai-codex")).toBeTrue();
		expect(authStorage.getEffectiveCredentialType("openai-codex-device")).toBe("api_key");
		await expect(authStorage.getApiKey("openai-codex-device")).resolves.toBe("device-runtime-key");
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "device-oauth-access",
				refresh: "device-oauth-refresh",
				expires: Date.now() + 60 * 60_000,
				accountId: "device-account",
			},
		]);
		await expect(authStorage.getOAuthAccess("openai-codex-device")).resolves.toBeUndefined();
		expect(authStorage.getOAuthAccountId("openai-codex-device")).toBeUndefined();
		authStorage.removeRuntimeApiKey("openai-codex");
		expect(authStorage.hasRuntimeApiKey("openai-codex-device")).toBeFalse();
		await authStorage.set("openai-codex", [{ type: "api_key", key: "stored-device-key" }]);
		await expect(authStorage.getApiKey("openai-codex-device", "device-session")).resolves.toBe("stored-device-key");
		expect(authStorage.getSessionCredentialType("openai-codex-device", "device-session")).toBe("api_key");
		expect(authStorage.getSessionCredentialRowId("openai-codex-device", "device-session")).toBeDefined();
		const markResult = await authStorage.markUsageLimitReached("openai-codex-device", "device-session");
		expect(markResult.state).toBe("marked");
		expect(markResult.credentialKind).toBe("api_key");
		expect(markResult.remainingCredentialIds).toEqual([]);
		expect(authStorage.getEffectiveCredentialType("openai-codex-device", "device-session")).toBe("api_key");
	});
});
