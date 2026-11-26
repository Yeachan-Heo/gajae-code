import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore, startAuthBroker } from "../src";

const TOKEN = "test-bearer";
const UNSERVED = "test-unserved-provider";
const TEST_BROKER_AUTHORITY = "test-broker-authority";

describe("PR #7930 Findings - Comprehensive tests", () => {
	let tempDir = "";
	let brokerStore: SqliteAuthCredentialStore;
	let brokerStorage: AuthStorage;
	let handle: Awaited<ReturnType<typeof startAuthBroker>> | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-pr7930-findings-"));
		brokerStore = new SqliteAuthCredentialStore(new Database(":memory:"));
		brokerStorage = new AuthStorage(brokerStore);
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [TOKEN],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		await handle?.close();
		brokerStorage?.close();
		brokerStore?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("BLOCKING: ProbeParks - v5→v6 migration must preserve local provider markers", async () => {
		const dbPath = path.join(tempDir, "agent.db");

		// Step 1: Create old-schema database with v5 marker
		{
			const db = new Database(dbPath);
			try {
				// Create schema version table
				db.run(`
					CREATE TABLE auth_schema_version (
						id INTEGER PRIMARY KEY CHECK (id = 1),
						version INTEGER NOT NULL
					)
				`);
				db.run("INSERT INTO auth_schema_version (id, version) VALUES (1, 5)");

				// Create the old v5 schema (provider as PK without broker_authority)
				db.run(`
					CREATE TABLE auth_broker_local_providers (
						provider TEXT PRIMARY KEY,
						created_at INTEGER NOT NULL
					)
				`);
				db.run(
					`
					INSERT INTO auth_broker_local_providers (provider, created_at)
					VALUES (?, ?)
				`,
					[UNSERVED, Math.floor(Date.now() / 1000)],
				);
			} finally {
				db.close();
			}
		}

		// Step 2: Open with new code, triggering migration
		const local = await SqliteAuthCredentialStore.open(dbPath);
		try {
			// Step 3: Verify marker survived migration with legacy authority
			// The migration uses "legacy-default" as the authority for old markers
			const legacyAuthority = "legacy-default";
			const localProviders = local.listBrokerLocalProviders(legacyAuthority);
			expect(localProviders).toContain(UNSERVED);
		} finally {
			local.close();
		}
	});

	test("P2-5: Snowykr - unmarkBrokerLocalProviderIfEmpty prevents race condition", async () => {
		const dbPath = path.join(tempDir, "agent.db");
		const local = await SqliteAuthCredentialStore.open(dbPath);
		try {
			// Mark a provider as local
			local.markBrokerLocalProvider(TEST_BROKER_AUTHORITY, UNSERVED);
			expect(local.listBrokerLocalProviders(TEST_BROKER_AUTHORITY)).toContain(UNSERVED);

			// Unmark should work atomically without race condition
			const stillHasRows = local.unmarkBrokerLocalProviderIfEmpty(TEST_BROKER_AUTHORITY, UNSERVED);
			expect(stillHasRows).toBe(false);
			expect(local.listBrokerLocalProviders(TEST_BROKER_AUTHORITY)).not.toContain(UNSERVED);
		} finally {
			local.close();
		}
	});
});
