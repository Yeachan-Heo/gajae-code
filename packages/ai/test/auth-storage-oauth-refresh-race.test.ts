import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialDisabledEvent,
	SqliteAuthCredentialStore,
} from "../src/auth-storage";
import * as oauthUtils from "../src/utils/oauth";
import { withEnv } from "./helpers";

const SUPPRESS_ANTHROPIC_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
} as const;

describe("AuthStorage OAuth refresh race", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let events: CredentialDisabledEvent[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-oauth-race-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		events = [];
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		oauthUtils.unregisterOAuthProviders("auth-storage-oauth-refresh-race-test");
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("does not disable a credential another process already rotated", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Seed the shared DB with one expired OAuth credential; this simulates the
		// state two cooperating gjc processes both load from the persisted row.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("anthropic");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;

		// Simulate the peer's successful refresh: another process called the real
		// `#replaceCredentialAt` path, which rotates the row in place via
		// updateAuthCredential. The in-memory snapshot we hold is now stale.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "fresh-access-from-peer",
			refresh: "fresh-refresh-from-peer",
			expires: Date.now() + 60 * 60_000,
		});

		// Mock mirrors Anthropic: only the stale refresh token is rejected, because
		// real rotation invalidates the previous refresh token on use.
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (credential?.refresh === "stale-refresh") {
				throw new Error(
					'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
				);
			}
			return { newCredentials: credential!, apiKey: credential!.access };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-race");

			// We should have picked up the rotated credential instead of disabling
			// the row that the peer just updated.
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);
			expect(authStorage!.list()).toContain("anthropic");

			// The row must still be active in storage; before the fix it would be
			// soft-deleted with disabled_cause set to the invalid_grant error.
			const stored = store!.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe(credentialId);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
			}
		});
	});

	test("does not disable when peer rotates between pre-check and CAS disable", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("anthropic");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;

		// Refresh genuinely fails — the pre-check that compares the persisted
		// refresh token to our snapshot will therefore see the SAME stale token
		// and fall through to the disable. We then race a peer rotation into the
		// window between the pre-check and the CAS, which the CAS must detect.
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (credential?.refresh === "stale-refresh") {
				throw new Error(
					'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
				);
			}
			return { newCredentials: credential!, apiKey: credential!.access };
		});

		const sharedStore = store;
		const originalTryDisable = sharedStore.tryDisableAuthCredentialIfMatches.bind(sharedStore);
		const tryDisableSpy = vi
			.spyOn(sharedStore, "tryDisableAuthCredentialIfMatches")
			.mockImplementation((id, expectedData, disabledCause) => {
				// Simulate the peer's successful rotation landing in the window
				// between the pre-check (which saw the stale token) and the CAS
				// disable. The CAS predicate `data = expectedData` must now miss.
				sharedStore.updateAuthCredential(id, {
					type: "oauth",
					access: "fresh-access-from-peer",
					refresh: "fresh-refresh-from-peer",
					expires: Date.now() + 60 * 60_000,
				});
				return originalTryDisable(id, expectedData, disabledCause);
			});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-cas-race");

			// CAS lost → reload → pick up the peer-rotated credential.
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);
			expect(tryDisableSpy).toHaveBeenCalled();

			// Row must still be active, with the peer's rotated tokens.
			const stored = sharedStore.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe(credentialId);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
				expect(stored[0].credential.access).toBe("fresh-access-from-peer");
			}
		});
	});

	test("still disables when the failure is real (no concurrent rotation)", async () => {
		if (!authStorage) throw new Error("test setup failed");

		// Single-process scenario: refresh genuinely fails and no peer updated the
		// row. The credential should still be soft-deleted.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error('invalid_grant {"error":"invalid_grant"}');
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-real-failure");

			expect(apiKey).toBeUndefined();
			expect(events).toHaveLength(1);
			expect(events[0]?.disabledCause).toContain("invalid_grant");
		});
	});
	test("persists every credential refreshed during candidate preflight", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const expires = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-preflight",
			name: "Unit OAuth Preflight",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: `${credentials.access}-rotated`,
					refresh: `${credentials.refresh}-rotated`,
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-preflight", [
			{ type: "oauth", access: "access-a", refresh: "refresh-a", expires },
			{ type: "oauth", access: "access-b", refresh: "refresh-b", expires },
		]);

		const apiKey = await authStorage.getApiKey("unit-oauth-preflight");
		expect(apiKey).toBe("access-a-rotated");

		const stored = store.listAuthCredentials("unit-oauth-preflight");
		expect(stored).toHaveLength(2);
		const oauth = stored.map(entry => entry.credential).filter(credential => credential.type === "oauth");
		expect(oauth.map(credential => credential.refresh).sort()).toEqual(["refresh-a-rotated", "refresh-b-rotated"]);
	});

	test("coalesces concurrent refreshes for the same credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const expires = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-mutex",
			name: "Unit OAuth Mutex",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-rotated",
					refresh: "refresh-rotated",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-mutex", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires },
		]);

		const first = authStorage.getApiKey("unit-oauth-mutex", "same-session");
		const second = authStorage.getApiKey("unit-oauth-mutex", "same-session");

		await refreshStarted.promise;
		allowRefresh.resolve();

		await expect(first).resolves.toBe("access-rotated");
		await expect(second).resolves.toBe("access-rotated");
		expect(refreshCalls).toBe(1);
	});
	test("invalidating a session-sticky OAuth credential rotates the retry to another active credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		let sessionId = "";
		for (let index = 0; index < 32; index++) {
			const candidate = `session-auth-retry-${index}`;
			if (Bun.hash.xxHash32(candidate) % 2 === 0) {
				sessionId = candidate;
				break;
			}
		}
		if (!sessionId) throw new Error("could not find test session id");

		await authStorage.set("unit-oauth-rotation", [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
			},
			{
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 60 * 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		const firstKey = await authStorage.getApiKey("unit-oauth-rotation", sessionId);
		expect(firstKey).toBe("access-a");

		const invalidated = await authStorage.invalidateCredentialMatching("unit-oauth-rotation", "access-a", {
			sessionId,
		});
		expect(invalidated).toBe(true);

		const retryKey = await authStorage.getApiKey("unit-oauth-rotation", sessionId);
		expect(retryKey).toBe("access-b");
	});

	test("adopts a peer-rotated credential without firing a doomed refresh", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const refreshedExpires = Date.now() + 60 * 60_000;
		let staleRefreshCalls = 0;
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-adopt",
			name: "Unit OAuth Adopt",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				if (credentials.refresh === "stale-refresh") {
					staleRefreshCalls += 1;
					throw new Error('invalid_grant {"error":"invalid_grant"}');
				}
				return { ...credentials, expires: refreshedExpires };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-adopt", [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials("unit-oauth-adopt")[0]!.id;

		// Peer rotated the row after we loaded our snapshot but before we needed a
		// refresh. The pre-refresh re-read must adopt the persisted rotation and
		// never burn the (already-invalidated) stale refresh token on the network.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "fresh-access-from-peer",
			refresh: "fresh-refresh-from-peer",
			expires: Date.now() + 60 * 60_000,
		});

		const apiKey = await authStorage.getApiKey("unit-oauth-adopt", "session-adopt");
		expect(apiKey).toBe("fresh-access-from-peer");
		expect(staleRefreshCalls).toBe(0);
		expect(events).toHaveLength(0);
	});

	test("recovers when the peer's rotation persists shortly after our refresh failure", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-late-peer",
			name: "Unit OAuth Late Peer",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				if (credentials.refresh === "stale-refresh") {
					throw new Error('invalid_grant {"error":"invalid_grant"}');
				}
				return { ...credentials, expires: Date.now() + 60 * 60_000 };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-late-peer", [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
		]);
		const sharedStore = store;
		const credentialId = sharedStore.listAuthCredentials("unit-oauth-late-peer")[0]!.id;

		// The peer that won the rotation persists its success ~100ms after our
		// refresh fails: its success write trails the token endpoint round-trip.
		// The delayed re-check must observe it instead of disabling the row.
		const peerPersist = setTimeout(() => {
			sharedStore.updateAuthCredential(credentialId, {
				type: "oauth",
				access: "fresh-access-from-peer",
				refresh: "fresh-refresh-from-peer",
				expires: Date.now() + 60 * 60_000,
			});
		}, 100);

		try {
			const apiKey = await authStorage.getApiKey("unit-oauth-late-peer", "session-late-peer");
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);

			const stored = sharedStore.listAuthCredentials("unit-oauth-late-peer");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
			}
		} finally {
			clearTimeout(peerPersist);
		}
	});

	test("winner's rotation revives a row a racing loser disabled mid-flight", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-revive",
			name: "Unit OAuth Revive",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-rotated",
					refresh: "refresh-rotated",
					expires: Date.now() + 60 * 60_000,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-revive", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials("unit-oauth-revive")[0]!.id;

		// We are the winner: the provider has already rotated the token (our
		// refresh call is in flight). A racing loser that still held the previous
		// token hits invalid_grant and CAS-disables the row before our success
		// write lands. Without revival the only-valid rotated token would be
		// trapped in a soft-deleted row and every process would be signed out.
		const pending = authStorage.getApiKey("unit-oauth-revive", "session-revive");
		await refreshStarted.promise;
		store.deleteAuthCredential(credentialId, "oauth refresh failed: invalid_grant (racing loser)");
		expect(store.listAuthCredentials("unit-oauth-revive")).toHaveLength(0);
		allowRefresh.resolve();

		const apiKey = await pending;
		expect(apiKey).toBe("access-rotated");

		const stored = store.listAuthCredentials("unit-oauth-revive");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.id).toBe(credentialId);
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.access).toBe("access-rotated");
			expect(stored[0].credential.refresh).toBe("refresh-rotated");
		}
	});

	test("winner's rotation does not revive a row the user deleted mid-flight", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-no-revive",
			name: "Unit OAuth No Revive",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-rotated",
					refresh: "refresh-rotated",
					expires: Date.now() + 60 * 60_000,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-no-revive", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials("unit-oauth-no-revive")[0]!.id;

		// Only refresh-failure disables are revived; an explicit user deletion
		// that lands while a refresh is in flight must stay deleted.
		const pending = authStorage.getApiKey("unit-oauth-no-revive", "session-no-revive");
		await refreshStarted.promise;
		store.deleteAuthCredential(credentialId, "deleted by user");
		allowRefresh.resolve();
		await pending;

		expect(store.listAuthCredentials("unit-oauth-no-revive")).toHaveLength(0);
	});
});
