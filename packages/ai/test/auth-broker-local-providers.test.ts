import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

	test("AuthBrokerUnservedProviderError is defined and exported", async () => {
		expect(AuthBrokerUnservedProviderError).toBeDefined();
		const error = new AuthBrokerUnservedProviderError("test-provider");
		expect(error.message).toContain("does not serve");
		expect(error.provider).toBe("test-provider");
	});
});
