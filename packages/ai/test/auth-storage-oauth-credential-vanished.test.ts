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

describe("AuthStorage OAuth credential vanished from the store", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let events: CredentialDisabledEvent[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-oauth-vanished-"));
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
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("adopts the re-login credential after a peer disabled the row", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Long-lived process loads one expired OAuth row into its snapshot.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "revoked-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const staleId = store.listAuthCredentials("anthropic")[0]!.id;

		// A peer process (or an earlier request in this one) soft-disabled the row
		// after `invalid_grant`, and the user re-logged in, which inserts a NEW row.
		store.deleteAuthCredential(staleId, "oauth refresh failed: invalid_grant");
		store.upsertAuthCredentialForProvider("anthropic", {
			type: "oauth",
			access: "relogin-access",
			refresh: "relogin-refresh",
			expires: Date.now() + 60 * 60_000,
		});

		// Only the revoked token is rejected upstream; the re-login token works.
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (!credential || credential.refresh === "revoked-refresh") {
				throw new Error('invalid_grant {"error":"invalid_grant"}');
			}
			return { newCredentials: credential, apiKey: credential.access };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-vanished");
			expect(apiKey).toBe("relogin-access");
		});
	});

	test("does not retry a vanished row forever inside one process", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "revoked-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const staleId = store.listAuthCredentials("anthropic")[0]!.id;
		store.deleteAuthCredential(staleId, "oauth refresh failed: invalid_grant");

		let refreshAttempts = 0;
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			refreshAttempts += 1;
			throw new Error('invalid_grant {"error":"invalid_grant"}');
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			refreshAttempts += 1;
			throw new Error('invalid_grant {"error":"invalid_grant"}');
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			for (let i = 0; i < 3; i += 1) {
				expect(await authStorage!.getApiKey("anthropic", "session-vanished")).toBeUndefined();
			}
		});

		// The row is gone from the store: there is nothing to dial upstream with,
		// and the stale snapshot entry must be dropped instead of replayed.
		expect(refreshAttempts).toBe(0);
		expect(authStorage.hasOAuth("anthropic")).toBe(false);
	});
});
