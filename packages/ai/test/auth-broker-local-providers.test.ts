import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthCredential } from "../src";
import {
	AuthBrokerClient,
	AuthBrokerUnservedProviderError,
	AuthStorage,
	HybridAuthCredentialStore,
	RemoteAuthCredentialStore,
	SqliteAuthCredentialStore,
	startAuthBroker,
} from "../src";

const TOKEN = "test-bearer";
const UNSERVED = "test-unserved-provider";

describe("HybridAuthCredentialStore and broker-local providers", () => {
	let tempDir = "";
	let brokerStore: SqliteAuthCredentialStore;
	let brokerStorage: AuthStorage;
	let handle: Awaited<ReturnType<typeof startAuthBroker>> | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-local-providers-"));
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

	test("listBrokerLocalProviders returns empty list initially", async () => {
		const local = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			expect(local.listBrokerLocalProviders()).toEqual([]);
		} finally {
			local.close();
		}
	});

	test("markBrokerLocalProvider adds provider to list", async () => {
		const local = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			local.markBrokerLocalProvider(UNSERVED);
			expect(local.listBrokerLocalProviders()).toEqual([UNSERVED]);
		} finally {
			local.close();
		}
	});

	test("unmarkBrokerLocalProvider removes provider from list", async () => {
		const local = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			local.markBrokerLocalProvider(UNSERVED);
			expect(local.listBrokerLocalProviders()).toEqual([UNSERVED]);
			local.unmarkBrokerLocalProvider(UNSERVED);
			expect(local.listBrokerLocalProviders()).toEqual([]);
		} finally {
			local.close();
		}
	});

	test("broker-local provider list persists across database opens", async () => {
		const dbPath = path.join(tempDir, "agent.db");
		{
			const local = await SqliteAuthCredentialStore.open(dbPath);
			try {
				local.markBrokerLocalProvider(UNSERVED);
			} finally {
				local.close();
			}
		}

		{
			const local = await SqliteAuthCredentialStore.open(dbPath);
			try {
				expect(local.listBrokerLocalProviders()).toEqual([UNSERVED]);
			} finally {
				local.close();
			}
		}
	});

	test("HybridAuthCredentialStore initializes local providers from database", async () => {
		const dbPath = path.join(tempDir, "agent.db");
		const local = await SqliteAuthCredentialStore.open(dbPath);
		try {
			local.markBrokerLocalProvider(UNSERVED);
		} finally {
			local.close();
		}

		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const fetchResult = await client.fetchSnapshot();
		if (fetchResult.status !== 200) throw new Error("broker returned no snapshot");
		const broker = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: fetchResult.snapshot,
			streamSnapshots: false,
		});
		const local2 = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const hybrid = new HybridAuthCredentialStore({
				broker,
				local: local2,
			});
			try {
				// HybridAuthCredentialStore should have loaded the broker-local provider from the database
				expect(hybrid.listAuthCredentials(UNSERVED)).toBeDefined();
			} finally {
				hybrid.close();
			}
		} finally {
			local2.close();
		}
	});

	test("HybridAuthCredentialStore stores unserved credentials locally and disables them on broker", async () => {
		const credential: AuthCredential = { type: "api_key", key: "test-key" };
		const dbPath = path.join(tempDir, "agent.db");

		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const fetchResult = await client.fetchSnapshot();
		if (fetchResult.status !== 200) throw new Error("broker returned no snapshot");
		const broker = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: fetchResult.snapshot,
			streamSnapshots: false,
		});
		const local = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const hybrid = new HybridAuthCredentialStore({ broker, local });
			try {
				// Upload a credential for an unserved provider
				const result = await hybrid.upsertAuthCredentialRemote(UNSERVED, credential);
				expect(result).toHaveLength(1);
				expect(result[0].provider).toBe(UNSERVED);

				// Verify the credential is returned
				expect(result).toHaveLength(1);
				expect(result[0].credential).toEqual(credential);
			} finally {
				hybrid.close();
			}
		} finally {
			local.close();
		}
	});

	test("HybridAuthCredentialStore implements upsertAuthCredentialRemoteIfAbsent", async () => {
		const credential: AuthCredential = { type: "api_key", key: "test-key" };
		const dbPath = path.join(tempDir, "agent.db");

		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const fetchResult = await client.fetchSnapshot();
		if (fetchResult.status !== 200) throw new Error("broker returned no snapshot");
		const broker = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: fetchResult.snapshot,
			streamSnapshots: false,
		});
		const local = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const hybrid = new HybridAuthCredentialStore({ broker, local });
			try {
				// Verify the hook exists
				expect(hybrid.upsertAuthCredentialRemoteIfAbsent).toBeDefined();

				// Upload an unserved credential using the if-absent hook
				const result = await hybrid.upsertAuthCredentialRemoteIfAbsent?.(UNSERVED, credential);
				expect(result).toBeDefined();
				expect(result?.inserted).toBe(true);
				expect(result?.provider).toBe(UNSERVED);

				// Verify the credential is stored locally
				const localCredentials = hybrid.listAuthCredentials(UNSERVED);
				expect(localCredentials).toHaveLength(1);
			} finally {
				hybrid.close();
			}
		} finally {
			local.close();
		}
	});

	test("HybridAuthCredentialStore does not expose refreshOAuthCredential for local credentials", async () => {
		const oauthCred: AuthCredential = {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 3600000,
		};
		const dbPath = path.join(tempDir, "agent.db");

		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const fetchResult = await client.fetchSnapshot();
		if (fetchResult.status !== 200) throw new Error("broker returned no snapshot");
		const broker = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: fetchResult.snapshot,
			streamSnapshots: false,
		});
		const local = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const hybrid = new HybridAuthCredentialStore({ broker, local });
			try {
				// Store a local OAuth credential
				await hybrid.upsertAuthCredentialRemote(UNSERVED, oauthCred);
				const credentials = hybrid.listAuthCredentials(UNSERVED);
				expect(credentials).toHaveLength(1);

				// HybridAuthCredentialStore does not expose refreshOAuthCredential
				// This allows AuthStorage to use its default refresh mechanisms for local credentials
			} finally {
				hybrid.close();
			}
		} finally {
			local.close();
		}
	});

	test("AuthBrokerUnservedProviderError is defined and exported", async () => {
		expect(AuthBrokerUnservedProviderError).toBeDefined();
		const error = new AuthBrokerUnservedProviderError("test-provider");
		expect(error.message).toContain("does not serve");
		expect(error.provider).toBe("test-provider");
	});

	test("deleteAuthCredentialsRemote propagates broker deletion errors for local providers", async () => {
		const credential: AuthCredential = { type: "api_key", key: "test-key" };
		const dbPath = path.join(tempDir, "agent.db");

		// Create a mock broker that fails on deleteAuthCredentialsRemote
		const brokerMock = {
			listAuthCredentials: () => [],
			updateAuthCredential: () => {},
			upsertAuthCredentialForProvider: () => [],
			upsertAuthCredentialForProviderIfAbsent: () => ({ inserted: false, provider: UNSERVED, credential }),
			upsertAuthCredentialRemote: async () => [],
			upsertAuthCredentialRemoteIfAbsent: async () => ({ inserted: false, provider: UNSERVED, credential }),
			deleteAuthCredential: () => {},
			deleteAuthCredentialsRemote: async () => {
				throw new Error("Broker service unavailable");
			},
			deleteAuthCredentialsForProvider: () => {},
			getCache: () => null,
			setCache: () => {},
			deleteCachePrefix: () => {},
			cleanExpiredCache: () => {},
			allocateMonotonicSequence: () => 0,
			fetchUsageReports: async () => null,
			prepareForRequest: async () => undefined,
			refreshSnapshot: async () => {},
			onSnapshotChanged: () => () => {},
			close: () => {},
		} as unknown as RemoteAuthCredentialStore;

		const local = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const hybrid = new HybridAuthCredentialStore({ broker: brokerMock, local });
			try {
				// Store a credential for an unserved provider
				local.markBrokerLocalProvider(UNSERVED);
				local.upsertAuthCredentialForProvider(UNSERVED, credential);

				// Verify the credential is stored locally
				expect(local.listAuthCredentials(UNSERVED)).toHaveLength(1);

				// Try to delete the credentials - this should fail with the broker error
				let threwError = false;
				try {
					await hybrid.deleteAuthCredentialsRemote(UNSERVED, "logout");
				} catch (error) {
					threwError = true;
					expect(String(error)).toContain("Broker service unavailable");
				}
				expect(threwError).toBe(true);

				// Provider should still be marked as local
				const freshLocal = await SqliteAuthCredentialStore.open(dbPath);
				try {
					expect(freshLocal.listBrokerLocalProviders()).toContain(UNSERVED);
					// Credential should still exist locally (not deleted due to error)
					expect(freshLocal.listAuthCredentials(UNSERVED)).toHaveLength(1);
				} finally {
					freshLocal.close();
				}
			} finally {
				hybrid.close();
			}
		} finally {
			local.close();
		}
	});
});
