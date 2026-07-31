import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/utils/oauth";

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
		await expect(first).resolves.toBe("old-command-key");
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
});
