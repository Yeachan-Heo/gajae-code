import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
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

const READ_ONLY = /readonly database/i;

interface StoredRow {
	disabled_cause: string | null;
	revision: number;
}

/**
 * Real-store failures (issue #8091). The store owns its connection, so the
 * read-only cases switch that same connection to `PRAGMA query_only`, which
 * makes every write statement fail with SQLITE_READONLY exactly like a
 * read-only database file. The constructor always writes the schema version,
 * so a store cannot be opened on a `readonly: true` handle. The OAuth refresh
 * cases need refresh-lease writes to keep working, so they fail only the
 * disabling UPDATE with a trigger.
 */
describe("credential delete failures (#8091)", () => {
	let tempDir = "";
	let dbPath = "";
	let db: Database;
	let store: SqliteAuthCredentialStore;
	let events: CredentialDisabledEvent[];
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-auth-delete-failures-"));
		dbPath = path.join(tempDir, "agent.db");
		db = new Database(dbPath);
		store = new SqliteAuthCredentialStore(db);
		events = [];
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function makeReadOnly(): void {
		db.run("PRAGMA query_only = ON");
	}

	/** Fails every write that disables a row; other writes (refresh leases) still succeed. */
	function failDisables(): void {
		db.run(
			"CREATE TRIGGER fail_disable BEFORE UPDATE OF disabled_cause ON auth_credentials WHEN NEW.disabled_cause IS NOT NULL BEGIN SELECT RAISE(ABORT, 'disable rejected by test trigger'); END",
		);
	}

	function readRow(id: number): StoredRow {
		const reader = new Database(dbPath, { readonly: true });
		try {
			return reader
				.prepare("SELECT disabled_cause, revision FROM auth_credentials WHERE id = ?")
				.get(id) as StoredRow;
		} finally {
			reader.close();
		}
	}

	async function seedApiKey(provider = "openai"): Promise<number> {
		await authStorage.set(provider, { type: "api_key", key: `${provider}-key` });
		return store.listAuthCredentials(provider)[0]!.id;
	}

	describe("SqliteAuthCredentialStore", () => {
		test("deleteAuthCredential throws on a read-only database and keeps the row active", async () => {
			const id = await seedApiKey();
			makeReadOnly();

			expect(() => store.deleteAuthCredential(id, "deleted in test")).toThrow(READ_ONLY);
			expect(store.listAuthCredentials("openai").map(row => row.id)).toEqual([id]);
		});

		test("deleteAuthCredentialsForProvider throws on a read-only database and keeps the rows active", async () => {
			const id = await seedApiKey();
			makeReadOnly();

			expect(() => store.deleteAuthCredentialsForProvider("openai", "logged out")).toThrow(READ_ONLY);
			expect(store.listAuthCredentials("openai").map(row => row.id)).toEqual([id]);
		});

		test("tryDisableAuthCredentialIfMatches returns false for a lost CAS and throws for a database error", async () => {
			const id = await seedApiKey();
			const data = (db.prepare("SELECT data FROM auth_credentials WHERE id = ?").get(id) as { data: string }).data;

			expect(store.tryDisableAuthCredentialIfMatches(id, `${data} `, "lost cas")).toBe(false);
			makeReadOnly();
			expect(() => store.tryDisableAuthCredentialIfMatches(id, data, "db error")).toThrow(READ_ONLY);
			expect(readRow(id).disabled_cause).toBeNull();
		});

		test("tryDisableAuthCredentialIfRevision returns false for a lost CAS and throws for a database error", async () => {
			const id = await seedApiKey();
			const { revision } = readRow(id);

			expect(store.tryDisableAuthCredentialIfRevision(id, revision + 1, "lost cas")).toBe(false);
			makeReadOnly();
			expect(() => store.tryDisableAuthCredentialIfRevision(id, revision, "db error")).toThrow(READ_ONLY);
			expect(readRow(id).disabled_cause).toBeNull();
		});

		test("deleteAuthCredential leaves an already-disabled row unchanged", async () => {
			const id = await seedApiKey();
			store.deleteAuthCredential(id, "first cause");
			const disabled = readRow(id);

			store.deleteAuthCredential(id, "second cause");

			expect(readRow(id)).toEqual(disabled);
			expect(disabled.disabled_cause).toBe("first cause");
		});
	});

	describe("AuthStorage", () => {
		test("disableCredentialById throws and keeps the credential selectable when the write fails", async () => {
			const id = await seedApiKey();
			makeReadOnly();

			expect(() => authStorage.disableCredentialById(id, "removed by test")).toThrow(READ_ONLY);
			expect(authStorage.has("openai")).toBe(true);
			expect(events).toEqual([]);
			expect(readRow(id).disabled_cause).toBeNull();
		});

		test("remove rejects and keeps the provider's credentials when the write fails", async () => {
			const id = await seedApiKey();
			makeReadOnly();

			await expect(authStorage.remove("openai")).rejects.toThrow(READ_ONLY);
			expect(authStorage.has("openai")).toBe(true);
			expect(readRow(id).disabled_cause).toBeNull();
		});

		async function seedDuplicateOAuth(): Promise<void> {
			await authStorage.set("anthropic", {
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				email: "dup@example.com",
				accountId: "account-dup",
			});
			const originalId = store.listAuthCredentials("anthropic")[0]!.id;
			db.run(
				"INSERT INTO auth_credentials (provider, credential_type, data, identity_key, revision, created_at, updated_at) SELECT provider, credential_type, data, identity_key, revision, created_at, updated_at FROM auth_credentials WHERE id = ?",
				[originalId],
			);
			expect(store.listAuthCredentials("anthropic")).toHaveLength(2);
		}

		test("reload keeps a duplicate in memory when its delete fails", async () => {
			await seedDuplicateOAuth();
			makeReadOnly();

			await authStorage.reload();

			const cached = authStorage.getAll().anthropic;
			expect(Array.isArray(cached) ? cached.length : 1).toBe(2);
			expect(store.listAuthCredentials("anthropic")).toHaveLength(2);
		});

		test("reload with a remote store keeps duplicates without attempting the delete or warning", async () => {
			await seedDuplicateOAuth();
			// Mirror RemoteAuthCredentialStore: the synchronous delete always throws, and
			// mutations go through disableAuthCredentialRemote.
			const deleteAttempts: number[] = [];
			store.deleteAuthCredential = id => {
				deleteAttempts.push(id);
				throw new Error("Remote auth-broker credentials can only be disabled on the broker host");
			};
			const remoteLike: AuthCredentialStore = store;
			remoteLike.disableAuthCredentialRemote = async () => true;
			const warnSpy = vi.spyOn(logger, "warn");

			await authStorage.reload();

			const cached = authStorage.getAll().anthropic;
			expect(Array.isArray(cached) ? cached.length : 1).toBe(2);
			expect(deleteAttempts).toEqual([]);
			expect(warnSpy.mock.calls.map(call => call[0])).not.toContain(
				"Could not retire a deduplicated credential; keeping it",
			);
		});

		test("OAuth refresh failure rethrows the auth error when the CAS disable hits a database error", async () => {
			// Usage probes would hit the mocked network and wait on usage leases; this test
			// is about credential selection only.
			const storage = new AuthStorage(store, {
				usageProviderResolver: () => undefined,
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			await storage.set("anthropic", [
				{
					type: "oauth",
					access: "expired-access",
					refresh: "revoked-refresh",
					expires: Date.now() - 60_000,
					email: "revoked@example.com",
				},
				{
					type: "oauth",
					access: "healthy-access",
					refresh: "healthy-refresh",
					expires: Date.now() + 3_600_000,
					email: "healthy@example.com",
				},
			]);
			const revokedId = store
				.listAuthCredentials("anthropic")
				.find(row => row.credential.type === "oauth" && row.credential.refresh === "revoked-refresh")!.id;
			const authError = new Error('invalid_grant {"error":"invalid_grant"}');
			let revokedRefreshes = 0;
			const refreshRevoked = (refresh: string | undefined): void => {
				if (refresh !== "revoked-refresh") return;
				if (revokedRefreshes++ === 0) failDisables();
				throw authError;
			};
			vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
				refreshRevoked(credential.refresh);
				return credential;
			});
			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
				const credential = credentials[provider];
				if (!credential) return null;
				if (credential.expires <= Date.now()) refreshRevoked(credential.refresh);
				return { newCredentials: credential, apiKey: credential.access };
			});
			vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected OAuth network request"));

			await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
				await expect(
					storage.getApiKey("anthropic", "session-cas-db-error", {
						credentialSelector: { kind: "id", value: String(revokedId) },
					}),
				).rejects.toBe(authError);
				// The revoked credential is blocked in this process, so another session lands on
				// the healthy one instead of replaying the refresh that already failed definitively.
				for (const sessionId of ["session-other-1", "session-other-2", "session-other-3"]) {
					expect(await storage.getApiKey("anthropic", sessionId)).toBe("healthy-access");
				}
			});
			expect(revokedRefreshes).toBe(1);
			expect(events).toEqual([]);
			expect(store.listAuthCredentials("anthropic").map(row => row.id)).toContain(revokedId);
			expect(readRow(revokedId).disabled_cause).toBeNull();
		});

		test("OAuth refresh failure rethrows the auth error when the disable by id fails", async () => {
			await authStorage.set("anthropic", {
				type: "oauth",
				access: "expired-access",
				refresh: "revoked-refresh",
				expires: Date.now() - 60_000,
			});
			const id = store.listAuthCredentials("anthropic")[0]!.id;
			const authError = new Error('invalid_grant {"error":"invalid_grant"}');
			vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
				// A peer rewrites unrelated metadata (same refresh token), so the data CAS
				// matches no row and the refresh path falls back to disabling by id. The
				// trigger then fails that real write.
				const peer = new SqliteAuthCredentialStore(new Database(dbPath));
				try {
					peer.updateAuthCredential(id, {
						type: "oauth",
						access: "expired-access",
						refresh: "revoked-refresh",
						expires: Date.now() - 60_000,
						email: "peer-metadata@example.com",
					});
				} finally {
					peer.close();
				}
				failDisables();
				throw authError;
			});
			vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected OAuth network request"));

			await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
				await expect(authStorage.getApiKey("anthropic", "session-by-id-db-error")).rejects.toBe(authError);
			});
			expect(events).toEqual([]);
			expect(authStorage.has("anthropic")).toBe(true);
			expect(readRow(id).disabled_cause).toBeNull();
		});
	});
});
