import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "../src/auth-storage";

const LEGACY_TIMESTAMP = 1_700_000_000;

function createCredential(args: { suffix: string; accountId: string; email: string }): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${args.suffix}`,
		refresh: `refresh-${args.suffix}`,
		expires: Date.now() + 60_000,
		accountId: args.accountId,
		email: args.email,
	};
}

function createCodexToken(args: { accountId: string; email: string }): string {
	const payload = {
		"https://api.openai.com/auth": { chatgpt_account_id: args.accountId },
		"https://api.openai.com/profile": { email: args.email },
	};
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.sig`;
}

function createJwtOnlyCredential(args: { suffix: string; accountId: string; email: string }): OAuthCredential {
	return {
		type: "oauth",
		access: createCodexToken({ accountId: args.accountId, email: args.email }),
		refresh: `refresh-${args.suffix}`,
		expires: Date.now() + 60_000,
		accountId: args.accountId,
	};
}

function countCredentialRows(dbPath: string, provider: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ?").get(provider) as
			| { count?: number }
			| undefined;
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

function readDisabledCauses(dbPath: string, provider: string): string[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.prepare(
				"SELECT disabled_cause FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
			)
			.all(provider) as Array<{ disabled_cause?: string | null }>;
		return rows.flatMap(row => (typeof row.disabled_cause === "string" ? [row.disabled_cause] : []));
	} finally {
		db.close();
	}
}

function readStoredIdentityRows(
	dbPath: string,
	provider: string,
): Array<{ identity_key: string | null; disabled_cause: string | null }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare("SELECT identity_key, disabled_cause FROM auth_credentials WHERE provider = ? ORDER BY id ASC")
			.all(provider) as Array<{ identity_key: string | null; disabled_cause: string | null }>;
	} finally {
		db.close();
	}
}

function readAuthSchemaVersion(dbPath: string): number | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT version FROM auth_schema_version WHERE id = 1").get() as
			| { version?: number }
			| undefined;
		return typeof row?.version === "number" ? row.version : null;
	} finally {
		db.close();
	}
}

function readTableSql(dbPath: string, tableName: string): string | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
			| { sql?: string | null }
			| undefined;
		return row?.sql ?? null;
	} finally {
		db.close();
	}
}

describe("AuthStorage openai-codex email dedupe", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-email-dedupe-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		dbPath = "";
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("keeps both openai-codex credentials when accountId matches but emails differ", async () => {
		if (!authStorage || !store || !dbPath) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			createCredential({ suffix: "first", accountId: "shared-team", email: "first.user@example.com" }),
			createCredential({ suffix: "second", accountId: "shared-team", email: "second.user@example.com" }),
		]);

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(2);
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
	});

	it("dedupes openai-codex credentials when email matches but accountId differs", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			createCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
			createCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		]);

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		const [remaining] = credentials;
		expect(remaining?.credential.type).toBe("oauth");
		if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
		expect(remaining.credential.accountId).toBe("account-b");
		expect(remaining.credential.email).toBe("shared.user@example.com");
	});

	it("dedupes openai-codex credentials when matching email exists only in JWT profile claim but accountId differs", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			createJwtOnlyCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
			createJwtOnlyCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		]);

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		const [remaining] = credentials;
		expect(remaining?.credential.type).toBe("oauth");
		if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
		expect(remaining.credential.accountId).toBe("account-b");
	});

	it("updates in-place when a codex credential with matching email replaces another account", async () => {
		if (!store || !dbPath) throw new Error("test setup failed");

		store.replaceAuthCredentialsForProvider("openai-codex", [
			createJwtOnlyCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
		]);
		store.replaceAuthCredentialsForProvider("openai-codex", [
			createJwtOnlyCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		]);

		// Same email identity key → existing row is updated, not disabled+reinserted
		expect(countCredentialRows(dbPath, "openai-codex")).toBe(1);
		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
	});

	it("updates in-place via AuthStorage.set when email matches across accounts", async () => {
		if (!authStorage || !store || !dbPath) throw new Error("test setup failed");

		await authStorage.set(
			"openai-codex",
			createCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
		);
		await authStorage.set(
			"openai-codex",
			createCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		);

		// Same email identity key → updated in-place, no disabled rows
		expect(countCredentialRows(dbPath, "openai-codex")).toBe(1);
		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		const [remaining] = credentials;
		expect(remaining?.credential.type).toBe("oauth");
		if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
		expect(remaining.credential.accountId).toBe("account-b");
		expect(remaining.credential.email).toBe("shared.user@example.com");
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
	});

	it("does not disable credentials for different accounts with different emails", async () => {
		if (!authStorage || !store || !dbPath) throw new Error("test setup failed");

		const credA = createCredential({ suffix: "first", accountId: "account-a", email: "user-a@example.com" });
		const credB = createCredential({ suffix: "second", accountId: "account-b", email: "user-b@example.com" });
		const credC = createCredential({ suffix: "third", accountId: "account-c", email: "user-c@example.com" });

		// Simulate login flow: each login merges existing + new
		await authStorage.set("openai-codex", credA);
		await authStorage.set("openai-codex", [credA, credB]);
		await authStorage.set("openai-codex", [credA, credB, credC]);

		// All three accounts should remain active — no credential was replaced
		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(3);
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
	});

	it("saveOAuth preserves unrelated codex accounts across reauth", async () => {
		if (!store || !dbPath) throw new Error("test setup failed");

		store.saveOAuth(
			"openai-codex",
			createCredential({ suffix: "first", accountId: "account-a", email: "user-a@example.com" }),
		);
		store.saveOAuth(
			"openai-codex",
			createCredential({ suffix: "second", accountId: "account-b", email: "user-b@example.com" }),
		);
		store.saveOAuth(
			"openai-codex",
			createCredential({ suffix: "third", accountId: "account-c", email: "user-c@example.com" }),
		);

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(3);
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
	});

	it("saveOAuth does not delete accounts missing from stale AuthStorage cache", async () => {
		if (!store || !dbPath) throw new Error("test setup failed");

		const staleStore = await SqliteAuthCredentialStore.open(dbPath);
		const freshStore = await SqliteAuthCredentialStore.open(dbPath);
		const staleAuthStorage = new AuthStorage(staleStore);
		try {
			staleStore.saveOAuth(
				"openai-codex",
				createCredential({ suffix: "first", accountId: "account-a", email: "user-a@example.com" }),
			);
			await staleAuthStorage.reload();

			// Another writer adds a second account after staleAuthStorage has already cached provider state.
			freshStore.saveOAuth(
				"openai-codex",
				createCredential({ suffix: "second", accountId: "account-b", email: "user-b@example.com" }),
			);

			// Reauth from the stale process should update only account A, not disable account B.
			staleStore.saveOAuth(
				"openai-codex",
				createCredential({ suffix: "reauth", accountId: "account-a", email: "user-a@example.com" }),
			);

			expect(staleStore.listAuthCredentials("openai-codex")).toHaveLength(2);
			expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
		} finally {
			staleStore.close();
			freshStore.close();
		}
	});

	it("prunes existing JWT-only codex duplicates on reload when email matches", async () => {
		if (!store) throw new Error("test setup failed");

		store.replaceAuthCredentialsForProvider("openai-codex", [
			createJwtOnlyCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
			createJwtOnlyCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		]);

		const reloaded = new AuthStorage(store);
		await reloaded.reload();

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		const [remaining] = credentials;
		expect(remaining?.credential.type).toBe("oauth");
		if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
		expect(remaining.credential.accountId).toBe("account-b");
	});

	it("dedupes openai-codex credentials after reload when email matches even if accountId differs", async () => {
		if (!store) throw new Error("test setup failed");

		store.replaceAuthCredentialsForProvider("openai-codex", [
			createCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
			createCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		]);

		const reloaded = new AuthStorage(store);
		await reloaded.reload();

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		const [remaining] = credentials;
		expect(remaining?.credential.type).toBe("oauth");
		if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
		expect(remaining.credential.accountId).toBe("account-b");
		expect(remaining.credential.email).toBe("shared.user@example.com");
	});

	describe("AuthStorage anthropic email identity", () => {
		it("keeps both anthropic credentials when accountId matches but emails differ", async () => {
			if (!authStorage || !store || !dbPath) throw new Error("test setup failed");

			await authStorage.set("anthropic", [
				createCredential({ suffix: "first", accountId: "shared-org", email: "first.user@example.com" }),
				createCredential({ suffix: "second", accountId: "shared-org", email: "second.user@example.com" }),
			]);

			const credentials = store.listAuthCredentials("anthropic");
			expect(credentials).toHaveLength(2);
			expect(readDisabledCauses(dbPath, "anthropic")).toEqual([]);
		});

		it("dedupes anthropic credentials when email matches but accountId differs", async () => {
			if (!authStorage || !store) throw new Error("test setup failed");

			await authStorage.set("anthropic", [
				createCredential({ suffix: "first", accountId: "org-a", email: "shared.user@example.com" }),
				createCredential({ suffix: "second", accountId: "org-b", email: "shared.user@example.com" }),
			]);

			const credentials = store.listAuthCredentials("anthropic");
			expect(credentials).toHaveLength(1);
			const [remaining] = credentials;
			expect(remaining?.credential.type).toBe("oauth");
			if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
			expect(remaining.credential.accountId).toBe("org-b");
			expect(remaining.credential.email).toBe("shared.user@example.com");
		});

		it("backfills anthropic identity_key from email when migrating v1 auth schema", async () => {
			if (!tempDir) throw new Error("test setup failed");

			const legacyDbPath = path.join(tempDir, "legacy-v1-anthropic-agent.db");
			const legacyDb = new Database(legacyDbPath);
			legacyDb.exec(`
				CREATE TABLE auth_schema_version (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					version INTEGER NOT NULL
				);
				INSERT INTO auth_schema_version(id, version) VALUES (1, 1);
				CREATE TABLE auth_credentials (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					credential_type TEXT NOT NULL,
					data TEXT NOT NULL,
					disabled_cause TEXT DEFAULT NULL,
					created_at INTEGER NOT NULL DEFAULT (unixepoch()),
					updated_at INTEGER NOT NULL DEFAULT (unixepoch())
				);
			`);
			legacyDb
				.prepare(
					"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					"anthropic",
					"oauth",
					JSON.stringify(
						createCredential({
							suffix: "legacy-v1-anthropic",
							accountId: "legacy-org",
							email: "legacy-anthropic@example.com",
						}),
					),
					null,
					LEGACY_TIMESTAMP,
					LEGACY_TIMESTAMP,
				);
			legacyDb.close();

			const migratedStore = await SqliteAuthCredentialStore.open(legacyDbPath);
			try {
				expect(readStoredIdentityRows(legacyDbPath, "anthropic")).toEqual([
					{ identity_key: "email:legacy-anthropic@example.com", disabled_cause: null },
				]);
			} finally {
				migratedStore.close();
			}
		});
	});
	it("stores the disable cause when a credential is soft-disabled", async () => {
		if (!store || !dbPath) throw new Error("test setup failed");

		store.replaceAuthCredentialsForProvider("openai-codex", [
			createCredential({ suffix: "only", accountId: "account-a", email: "only@example.com" }),
		]);

		const [credential] = store.listAuthCredentials("openai-codex");
		if (!credential) throw new Error("expected stored credential");

		const disabledCause = "oauth refresh failed: invalid_grant";
		store.deleteAuthCredential(credential.id, disabledCause);

		expect(store.listAuthCredentials("openai-codex")).toHaveLength(0);
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([disabledCause]);
	});

	it("creates fresh auth schema without unixepoch defaults", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const freshDbPath = path.join(tempDir, "fresh-schema-agent.db");
		const freshStore = await SqliteAuthCredentialStore.open(freshDbPath);
		try {
			expect(readAuthSchemaVersion(freshDbPath)).toBe(4);
			expect(readTableSql(freshDbPath, "auth_credentials")).not.toContain("unixepoch(");
			expect(readTableSql(freshDbPath, "auth_credentials")).toContain("strftime('%s','now')");
		} finally {
			freshStore.close();
		}
	});

	it("preserves newer auth schema versions instead of downgrading them", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const futureDbPath = path.join(tempDir, "future-schema-agent.db");
		const futureDb = new Database(futureDbPath);
		futureDb.exec(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 5);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		futureDb.close();

		const reopenedStore = await SqliteAuthCredentialStore.open(futureDbPath);
		try {
			expect(readAuthSchemaVersion(futureDbPath)).toBe(5);
		} finally {
			reopenedStore.close();
		}
	});

	it("migrates v3 auth schema away from unixepoch defaults", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const legacyDbPath = path.join(tempDir, "legacy-v3-agent.db");
		const legacyDb = new Database(legacyDbPath);
		legacyDb.exec(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 3);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.prepare(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"openai-codex",
				"oauth",
				JSON.stringify(
					createCredential({
						suffix: "legacy-v3",
						accountId: "legacy-v3-account",
						email: "legacy-v3@example.com",
					}),
				),
				null,
				"email:legacy-v3@example.com",
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(legacyDbPath);
		try {
			expect(readAuthSchemaVersion(legacyDbPath)).toBe(4);
			expect(readTableSql(legacyDbPath, "auth_credentials")).not.toContain("unixepoch(");
			expect(readTableSql(legacyDbPath, "auth_credentials")).toContain("strftime('%s','now')");
			expect(readStoredIdentityRows(legacyDbPath, "openai-codex")).toEqual([
				{ identity_key: "email:legacy-v3@example.com", disabled_cause: null },
			]);
		} finally {
			migratedStore.close();
		}
	});

	it("backfills identity_key when migrating v1 auth schema", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const legacyDbPath = path.join(tempDir, "legacy-v1-agent.db");
		const legacyDb = new Database(legacyDbPath);
		legacyDb.exec(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 1);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.prepare(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				"openai-codex",
				"oauth",
				JSON.stringify(
					createCredential({
						suffix: "legacy-v1",
						accountId: "legacy-v1-account",
						email: "legacy-v1@example.com",
					}),
				),
				null,
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(legacyDbPath);
		try {
			expect(readStoredIdentityRows(legacyDbPath, "openai-codex")).toEqual([
				{ identity_key: "email:legacy-v1@example.com", disabled_cause: null },
			]);
		} finally {
			migratedStore.close();
		}
	});

	it("backfills disabled cause and identity_key when migrating legacy disabled rows", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const legacyDbPath = path.join(tempDir, "legacy-agent.db");
		const legacyDb = new Database(legacyDbPath);
		legacyDb.exec(`
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.prepare(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				"openai-codex",
				"oauth",
				JSON.stringify(
					createCredential({ suffix: "legacy", accountId: "legacy-account", email: "legacy@example.com" }),
				),
				1,
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(legacyDbPath);
		try {
			expect(migratedStore.listAuthCredentials("openai-codex")).toHaveLength(0);
			expect(readStoredIdentityRows(legacyDbPath, "openai-codex")).toEqual([
				{ identity_key: "email:legacy@example.com", disabled_cause: "disabled" },
			]);
		} finally {
			migratedStore.close();
		}
	});
});
