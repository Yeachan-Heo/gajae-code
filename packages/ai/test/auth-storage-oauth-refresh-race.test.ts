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

	test("disables instead of looping when the CAS misses an unrotated row", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Production shape (#3054-per-3.5h log flood): the row still holds the
		// revoked refresh token we just tried, but its serialized `data` no longer
		// byte-matches our snapshot because an unrelated writer touched identity
		// metadata. The data-equality CAS can therefore never match, and the old
		// reload-and-retry path replayed the same invalid_grant refresh on every
		// request forever without ever disabling the credential.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "revoked-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const credentialId = store.listAuthCredentials("anthropic")[0]!.id;

		let refreshCalls = 0;
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			refreshCalls += 1;
			throw new Error('invalid_grant {"error":"invalid_grant"}');
		});
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			refreshCalls += 1;
			throw new Error('invalid_grant {"error":"invalid_grant"}');
		});
		// Metadata-only drift: same refresh token, different serialized bytes.
		const sharedStore = store;
		vi.spyOn(sharedStore, "tryDisableAuthCredentialIfMatches").mockImplementation(() => false);

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-cas-unrotated");

			expect(apiKey).toBeUndefined();
			// The revoked credential must be disabled by id, not retried forever.
			expect(events).toHaveLength(1);
			expect(events[0]?.disabledCause).toContain("invalid_grant");
			expect(sharedStore.listAuthCredentials("anthropic")).toHaveLength(0);
			expect(credentialId).toBeGreaterThan(0);
			// Bounded work: no unbounded reload/refresh loop.
			expect(refreshCalls).toBeLessThanOrEqual(4);
		});
	});

	test("bounds reload retries when the failing row keeps vanishing", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// An account switcher replaces the provider's rows wholesale, so the id we
		// attempted no longer exists: the pre-check finds no row (no rotation
		// evidence) and the CAS can never match. Recovery must terminate.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "revoked-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		let refreshCalls = 0;
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			refreshCalls += 1;
			throw new Error('invalid_grant {"error":"invalid_grant"}');
		});
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			refreshCalls += 1;
			throw new Error('invalid_grant {"error":"invalid_grant"}');
		});
		const sharedStore = store;
		// Row lookups never surface the attempted id, and the CAS never matches.
		vi.spyOn(sharedStore, "tryDisableAuthCredentialIfMatches").mockImplementation(() => false);
		const originalList = sharedStore.listAuthCredentials.bind(sharedStore);
		vi.spyOn(sharedStore, "listAuthCredentials").mockImplementation((provider?: string) =>
			originalList(provider).map(row => ({ ...row, id: row.id + 1000 })),
		);

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-cas-vanished");

			expect(apiKey).toBeUndefined();
			// Terminates instead of recursing forever on the same revoked token.
			expect(refreshCalls).toBeLessThanOrEqual(12);
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

	test("recovers from a non-definitive invalid-grant failure when a peer rotated the token", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Kimi-style failure: refresh-token rotation by a peer leaves our snapshot
		// token rejected with a message that does NOT match the definitive-failure
		// regex (HTTP 400 "The provided authorization grant is invalid", not the
		// literal "invalid_grant"). Before the fix this was misclassified as
		// transient and the healthy credential was temp-blocked for 5 minutes on
		// every rotation race — with Kimi's ~12-minute access tokens and several
		// gjc processes sharing the store, users saw repeated "logged out" states.
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

		// Peer process rotated the row first.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "fresh-access-from-peer",
			refresh: "fresh-refresh-from-peer",
			expires: Date.now() + 60 * 60_000,
		});

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credentials) => {
			if (credentials.refresh === "stale-refresh") {
				throw new Error("Kimi token refresh failed: 400: The provided authorization grant is invalid");
			}
			return credentials;
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-kimi-race");

			// The peer-rotated credential must be picked up — not temp-blocked.
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);

			const stored = store!.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe(credentialId);
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
			}
		});
	});

	test("disables on a genuine Kimi-style invalid-grant failure with no peer rotation", async () => {
		if (!authStorage) throw new Error("test setup failed");

		// Same Kimi message shape, but no peer updated the row: the refresh token
		// is genuinely revoked, so the credential must be disabled (and the
		// onCredentialDisabled listener fired) instead of looping 5-minute
		// temp-blocks forever.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "revoked-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error("Kimi token refresh failed: 400: The provided authorization grant is invalid");
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-kimi-revoked");

			expect(apiKey).toBeUndefined();
			expect(events).toHaveLength(1);
			expect(events[0]?.disabledCause).toContain("authorization grant is invalid");
		});
	});
	test("never replays a stale refresh token upstream when a peer already rotated the row", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// The post-failure recovery paths above only reload AFTER the stale
		// token was already replayed at the provider's token endpoint. For
		// providers with refresh-token rotation + reuse detection (Anthropic),
		// that replay revokes the whole grant family and kills the peer's
		// still-valid tokens mid-request. The pre-refresh guard must therefore
		// adopt the persisted rotation WITHOUT any upstream refresh call.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const credentialId = store.listAuthCredentials("anthropic")[0]!.id;

		// Peer rotated the row and its access token is still fresh.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "fresh-access-from-peer",
			refresh: "fresh-refresh-from-peer",
			expires: Date.now() + 60 * 60_000,
		});

		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error("upstream token endpoint must not be hit with a stale refresh token");
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-no-replay");

			expect(apiKey).toBe("fresh-access-from-peer");
			// Zero upstream refresh calls: the guard adopted the persisted row.
			expect(refreshSpy).not.toHaveBeenCalled();
			expect(events).toHaveLength(0);
		});
	});

	test("refreshes with the persisted refresh token when both snapshot and row are expired", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const credentialId = store.listAuthCredentials("anthropic")[0]!.id;

		// Peer rotated the row, but the rotated access token has ALSO expired
		// (e.g. this process slept past the peer token's lifetime). A refresh is
		// genuinely needed — it must spend the NEWEST refresh token, never the
		// stale snapshot one.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "expired-access-from-peer",
			refresh: "fresh-refresh-from-peer",
			expires: Date.now() - 1_000,
		});

		const refreshedWith: string[] = [];
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credentials) => {
			refreshedWith.push(credentials.refresh);
			if (credentials.refresh !== "fresh-refresh-from-peer") {
				throw new Error(
					'invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
				);
			}
			return {
				...credentials,
				access: "rotated-access",
				refresh: "rotated-refresh",
				expires: Date.now() + 60 * 60_000,
			};
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-adopt-refresh");

			expect(apiKey).toBe("rotated-access");
			expect(refreshedWith).toEqual(["fresh-refresh-from-peer"]);
			expect(events).toHaveLength(0);

			// Rotation result persisted to the shared row.
			const stored = store!.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("rotated-refresh");
			}
		});
	});
	test("force refresh still dials upstream when a peer rotated the row fresh, spending the newest token", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Explicit force intent (broker POST /v1/credential/:id/refresh) must
		// never be satisfied by the guard's fresh-row adoption: the caller asked
		// for a NEW token. But the dial must spend the peer's rotated refresh
		// token, not the stale snapshot one.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() + 60 * 60_000,
			},
		]);
		const credentialId = store.listAuthCredentials("anthropic")[0]!.id;

		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "fresh-access-from-peer",
			refresh: "fresh-refresh-from-peer",
			expires: Date.now() + 60 * 60_000,
		});

		const refreshedWith: string[] = [];
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credentials) => {
			refreshedWith.push(credentials.refresh);
			return {
				...credentials,
				access: "force-rotated-access",
				refresh: "force-rotated-refresh",
				expires: Date.now() + 60 * 60_000,
			};
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const entry = await authStorage!.refreshCredentialById(credentialId);

			expect(refreshedWith).toEqual(["fresh-refresh-from-peer"]);
			expect(entry.credential.type).toBe("oauth");
			if (entry.credential.type === "oauth") {
				expect(entry.credential.access).toBe("force-rotated-access");
			}
			const stored = store!.listAuthCredentials("anthropic");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("force-rotated-refresh");
			}
		});
	});

	test("an ambiguous local refresh failure is not replayed within the same resolution", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// After a timeout/lost-response failure the provider may have already
		// consumed the rotating refresh token; dialing it again risks
		// reuse-detection revocation. The candidate preflight and the main
		// attempt both want a refresh — only ONE upstream dial may happen.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "ambiguous-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		let refreshCalls = 0;
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			refreshCalls += 1;
			throw new Error("fetch failed: network timeout while contacting token endpoint");
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error("fetch failed: network timeout while contacting token endpoint");
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-ambiguous");

			expect(apiKey).toBeUndefined();
			// Exactly one dial: the memoized failure covers every later attempt
			// with the same (credential, token) pair inside the guard window.
			expect(refreshCalls).toBe(1);
			// Transient failure: temp-blocked, never disabled.
			expect(events).toHaveLength(0);
			expect(store!.listAuthCredentials("anthropic")).toHaveLength(1);
		});
	});

	test("adopts a persisted MCP binding and refreshes only against its bound token endpoint", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const tokenRequests: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				tokenRequests.push(await request.text());
				return Response.json({
					access_token: "mcp-access",
					refresh_token: "mcp-refresh-2",
					expires_in: 3600,
				});
			},
		});
		try {
			const origin = `http://localhost:${server.port}`;

			// Stale snapshot without a binding; the persisted row acquired one.
			// The adopted refresh token must go to the bound endpoint, never to
			// the plain per-provider refresher.
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "stale-access",
					refresh: "stale-refresh",
					expires: Date.now() - 60_000,
				},
			]);
			const credentialId = store.listAuthCredentials("anthropic")[0]!.id;
			store.updateAuthCredential(credentialId, {
				type: "oauth",
				access: "expired-mcp-access",
				refresh: "mcp-refresh",
				expires: Date.now() - 1_000,
				mcpBinding: { resourceOrigin: origin, tokenEndpoint: `${origin}/token` },
			});

			const plainRefreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
				throw new Error("plain provider refresh must not be used for an MCP-bound credential");
			});
			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
				const credential = creds[provider];
				if (!credential) return null;
				return { newCredentials: credential, apiKey: credential.access };
			});

			await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
				const apiKey = await authStorage!.getApiKey("anthropic", "session-mcp-adopt");

				expect(apiKey).toBe("mcp-access");
				expect(plainRefreshSpy).not.toHaveBeenCalled();
				expect(tokenRequests).toHaveLength(1);
				expect(tokenRequests[0]).toContain("refresh_token=mcp-refresh");

				// The adopted binding must SURVIVE persistence: stripping it would
				// send the next (rotated) refresh token to the plain provider
				// endpoint instead of the bound one.
				const stored = store!.listAuthCredentials("anthropic");
				expect(stored).toHaveLength(1);
				if (stored[0]?.credential.type === "oauth") {
					expect(stored[0].credential.refresh).toBe("mcp-refresh-2");
					expect(stored[0].credential.mcpBinding?.tokenEndpoint).toBe(`${origin}/token`);
				}

				// Second, forced refresh: must dial the bound endpoint again with
				// the rotated token — proving both binding persistence and that a
				// local forced refresh of a bound row goes through the guard.
				await authStorage!.refreshCredentialById(credentialId);
				expect(plainRefreshSpy).not.toHaveBeenCalled();
				expect(tokenRequests).toHaveLength(2);
				expect(tokenRequests[1]).toContain("refresh_token=mcp-refresh-2");
			});
		} finally {
			server.stop(true);
		}
	});

	test("guard resolves the storage alias so openai-codex-device adopts a peer rotation", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// `openai-codex-device` reads canonical `openai-codex` rows in memory;
		// the pre-dial row read must canonicalize the same way or the guard
		// silently no-ops on the alias path.
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const credentialId = store.listAuthCredentials("openai-codex")[0]!.id;

		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "fresh-access-from-peer",
			refresh: "fresh-refresh-from-peer",
			expires: Date.now() + 60 * 60_000,
		});

		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error("upstream token endpoint must not be hit with a stale refresh token");
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[oauthUtils.resolveOAuthStorageProvider(provider)] ?? creds[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		const apiKey = await authStorage.getApiKey("openai-codex-device", "session-alias");

		expect(apiKey).toBe("fresh-access-from-peer");
		expect(refreshSpy).not.toHaveBeenCalled();
		expect(events).toHaveLength(0);
	});
	test("a forced refresh of a stale MCP-bound snapshot adopts the persisted rotation", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// The in-memory target is MCP-bound but STALE: a peer already rotated
		// the persisted row. A local forced refresh must go through the guard
		// and spend the peer's newest refresh token at the bound endpoint —
		// never replay the stale one.
		const tokenRequests: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				const body = await request.text();
				tokenRequests.push(body);
				if (body.includes("stale-mcp-refresh")) {
					return new Response("invalid_grant", { status: 400 });
				}
				return Response.json({
					access_token: "mcp-force-access",
					refresh_token: "mcp-force-refresh",
					expires_in: 3600,
				});
			},
		});
		try {
			const origin = `http://localhost:${server.port}`;
			const binding = { resourceOrigin: origin, tokenEndpoint: `${origin}/token` };

			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "stale-mcp-access",
					refresh: "stale-mcp-refresh",
					expires: Date.now() + 60 * 60_000,
					mcpBinding: binding,
				},
			]);
			const credentialId = store.listAuthCredentials("anthropic")[0]!.id;
			store.updateAuthCredential(credentialId, {
				type: "oauth",
				access: "peer-mcp-access",
				refresh: "peer-mcp-refresh",
				expires: Date.now() + 60 * 60_000,
				mcpBinding: binding,
			});

			await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
				const entry = await authStorage!.refreshCredentialById(credentialId);

				expect(tokenRequests).toHaveLength(1);
				expect(tokenRequests[0]).toContain("refresh_token=peer-mcp-refresh");
				if (entry.credential.type === "oauth") {
					expect(entry.credential.access).toBe("mcp-force-access");
				}
				const stored = store!.listAuthCredentials("anthropic");
				if (stored[0]?.credential.type === "oauth") {
					expect(stored[0].credential.refresh).toBe("mcp-force-refresh");
					expect(stored[0].credential.mcpBinding?.tokenEndpoint).toBe(`${origin}/token`);
				}
			});
		} finally {
			server.stop(true);
		}
	});

	test("an adopted token's definitive failure disables the row instead of looping, even for frozen errors", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Direct P1-b regression: snapshot token A is stale, the guard adopts
		// persisted token B, and B fails definitively. Recovery must compare the
		// row against B (the token actually sent) — comparing against A would
		// misread the adoption as a peer rotation and reload-retry forever. The
		// provider throws a FROZEN error: attempt provenance must not be
		// recorded by mutating the thrown object.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "token-a",
				expires: Date.now() - 60_000,
			},
		]);
		const credentialId = store.listAuthCredentials("anthropic")[0]!.id;
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "expired-access-b",
			refresh: "token-b",
			expires: Date.now() - 1_000,
		});

		const refreshedWith: string[] = [];
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credentials) => {
			refreshedWith.push(credentials.refresh);
			throw Object.freeze(new Error('invalid_grant {"error":"invalid_grant","error_description":"revoked"}'));
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw Object.freeze(new Error('invalid_grant {"error":"invalid_grant","error_description":"revoked"}'));
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-adopted-definitive");

			expect(apiKey).toBeUndefined();
			// Only token B was ever dialed, exactly once.
			expect(refreshedWith).toEqual(["token-b"]);
			// Disabled with the definitive cause — not spun through reload-retry.
			expect(events).toHaveLength(1);
			expect(events[0]?.disabledCause).toContain("invalid_grant");
			expect(store!.listAuthCredentials("anthropic")).toHaveLength(0);
		});
	});
	test("adopting a fresh unbound row REMOVES a stale snapshot's MCP binding", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Inverse of the binding-adoption case: the stale snapshot is bound but
		// the authoritative row dropped the binding (e.g. re-login through the
		// plain provider flow). The adopted authority must clobber the stale
		// binding — inheriting it would send the NEXT refresh token to the old
		// MCP endpoint.
		let mcpDials = 0;
		const server = Bun.serve({
			port: 0,
			fetch: async () => {
				mcpDials += 1;
				return new Response("gone", { status: 400 });
			},
		});
		try {
			const origin = `http://localhost:${server.port}`;
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "stale-bound-access",
					refresh: "stale-bound-refresh",
					expires: Date.now() - 60_000,
					mcpBinding: { resourceOrigin: origin, tokenEndpoint: `${origin}/token` },
				},
			]);
			const credentialId = store.listAuthCredentials("anthropic")[0]!.id;
			store.updateAuthCredential(credentialId, {
				type: "oauth",
				access: "fresh-unbound-access",
				refresh: "fresh-unbound-refresh",
				expires: Date.now() + 60 * 60_000,
			});

			const refreshedWith: string[] = [];
			vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credentials) => {
				refreshedWith.push(credentials.refresh);
				return {
					...credentials,
					access: "plain-rotated-access",
					refresh: "plain-rotated-refresh",
					expires: Date.now() + 60 * 60_000,
				};
			});
			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
				const credential = creds[provider];
				if (!credential) return null;
				return { newCredentials: credential, apiKey: credential.access };
			});

			await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
				const apiKey = await authStorage!.getApiKey("anthropic", "session-unbind");
				expect(apiKey).toBe("fresh-unbound-access");

				// The persisted row must have LOST the binding.
				const stored = store!.listAuthCredentials("anthropic");
				expect(stored).toHaveLength(1);
				if (stored[0]?.credential.type === "oauth") {
					expect(stored[0].credential.mcpBinding).toBeUndefined();
				}

				// A forced refresh now dials the plain provider path with the
				// adopted token — the old MCP endpoint is never contacted.
				await authStorage!.refreshCredentialById(credentialId);
				expect(refreshedWith).toEqual(["fresh-unbound-refresh"]);
				expect(mcpDials).toBe(0);
			});
		} finally {
			server.stop(true);
		}
	});

	test("an explicit force refresh bypasses the failure memo and dials again", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "memo-token",
				expires: Date.now() - 60_000,
			},
		]);
		const credentialId = store.listAuthCredentials("anthropic")[0]!.id;

		let refreshCalls = 0;
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credentials) => {
			refreshCalls += 1;
			if (refreshCalls === 1) {
				throw new Error("fetch failed: network timeout while contacting token endpoint");
			}
			return {
				...credentials,
				access: "recovered-access",
				refresh: "recovered-refresh",
				expires: Date.now() + 60 * 60_000,
			};
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			// Transient failure: memoized, temp-blocked, not disabled.
			const apiKey = await authStorage!.getApiKey("anthropic", "session-memo-force");
			expect(apiKey).toBeUndefined();
			expect(refreshCalls).toBe(1);

			// A deliberate force retry must reach the endpoint despite the memo.
			const entry = await authStorage!.refreshCredentialById(credentialId);
			expect(refreshCalls).toBe(2);
			if (entry.credential.type === "oauth") {
				expect(entry.credential.access).toBe("recovered-access");
			}
		});
	});

	test("keeps the selected OAuth row id stable when a live reload reorders rows", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const refreshStarted = Promise.withResolvers<void>();
		const releaseRefresh = Promise.withResolvers<void>();
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-reorder",
			name: "Unit OAuth Reorder",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				refreshStarted.resolve();
				await releaseRefresh.promise;
				return {
					...credentials,
					access: "reordered-rotated-access",
					refresh: "reordered-rotated-refresh",
					expires: Date.now() + 60 * 60_000,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-reorder", [
			{ type: "oauth", access: "selected-access", refresh: "selected-refresh", expires: Date.now() - 60_000 },
			{
				type: "oauth",
				access: "other-access",
				refresh: "other-refresh",
				expires: Date.now() + 60 * 60_000,
			},
		]);
		const rowsBefore = store.listAuthCredentials("unit-oauth-reorder");
		const selectedId = rowsBefore[0]?.id;
		const otherId = rowsBefore[1]?.id;
		if (selectedId === undefined || otherId === undefined) throw new Error("expected two OAuth rows");
		authStorage.setRuntimeCredentialSelector("unit-oauth-reorder", { kind: "id", value: String(selectedId) });

		const originalList = store.listAuthCredentials.bind(store);
		let reorder = false;
		vi.spyOn(store, "listAuthCredentials").mockImplementation((provider?: string) => {
			const rows = originalList(provider);
			return reorder ? [...rows].reverse() : rows;
		});

		const resolution = authStorage.getApiKey("unit-oauth-reorder", "session-reordered");
		await refreshStarted.promise;
		reorder = true;
		await authStorage.reload();
		releaseRefresh.resolve();

		expect(await resolution).toBe("reordered-rotated-access");
		const rowsAfter = store.listAuthCredentials("unit-oauth-reorder");
		expect(rowsAfter.map(row => row.id)).toEqual([otherId, selectedId]);
		expect(rowsAfter.find(row => row.id === selectedId)?.credential).toMatchObject({
			type: "oauth",
			access: "reordered-rotated-access",
			refresh: "reordered-rotated-refresh",
		});
		expect(rowsAfter.find(row => row.id === otherId)?.credential).toMatchObject({
			type: "oauth",
			access: "other-access",
			refresh: "other-refresh",
		});
	});

	test("leases one rotating token across SQLite connections and adopts the winner", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const peer = new AuthStorage(peerStore);
		try {
			await authStorage.set("anthropic", [
				{ type: "oauth", access: "expired-access", refresh: "shared-refresh", expires: Date.now() - 60_000 },
			]);
			await peer.reload();
			const firstDial = Promise.withResolvers<void>();
			const releaseFirstDial = Promise.withResolvers<void>();
			let dials = 0;
			vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
				dials += 1;
				expect(credential.refresh).toBe("shared-refresh");
				firstDial.resolve();
				await releaseFirstDial.promise;
				return {
					...credential,
					access: "winner-access",
					refresh: "winner-refresh",
					expires: Date.now() + 60 * 60_000,
				};
			});
			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
				const credential = credentials[provider]!;
				return { newCredentials: credential, apiKey: credential.access };
			});
			await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
				const winner = authStorage!.getApiKey("anthropic", "lease-winner");
				await firstDial.promise;
				const waiter = peer.getApiKey("anthropic", "lease-waiter");
				await Bun.sleep(100);
				expect(dials).toBe(1);
				releaseFirstDial.resolve();
				await expect(winner).resolves.toBe("winner-access");
				await expect(waiter).resolves.toBe("winner-access");
				expect(dials).toBe(1);
			});
		} finally {
			peerStore.close();
		}
	});
	test("expires abandoned leases, isolates credentials, and never lets force steal an active lease", async () => {
		if (!authStorage || !(store instanceof SqliteAuthCredentialStore)) throw new Error("test setup failed");
		await authStorage.set("anthropic", [
			{ type: "oauth", access: "a", refresh: "first-secret", expires: Date.now() - 60_000 },
			{ type: "oauth", access: "b", refresh: "second-secret", expires: Date.now() - 60_000 },
		]);
		const [first, second] = store.listAuthCredentials("anthropic");
		if (!first || !second) throw new Error("credentials missing");
		const now = Date.now();
		const firstClaim = store.claimOAuthRefreshLease(first.id, "first-secret", false, "owner-a", now, 50);
		expect(firstClaim.kind).toBe("claimed");
		const forcedPeerClaim = store.claimOAuthRefreshLease(first.id, "first-secret", true, "owner-b", now + 1, 50);
		expect(forcedPeerClaim.kind).toBe("busy");
		const secondClaim = store.claimOAuthRefreshLease(second.id, "second-secret", false, "owner-b", now + 1, 50);
		expect(secondClaim.kind).toBe("claimed");
		const recovered = store.claimOAuthRefreshLease(first.id, "first-secret", false, "owner-b", now + 51, 50);
		expect(recovered.kind).toBe("claimed");
		if (recovered.kind === "claimed") expect(recovered.lease.tokenFingerprint).not.toContain("first-secret");
	});
});
