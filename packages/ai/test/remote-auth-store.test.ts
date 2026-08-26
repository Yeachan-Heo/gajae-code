import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	AuthStorage,
	REMOTE_REFRESH_SENTINEL,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
	SqliteAuthCredentialStore,
	startAuthBroker,
} from "../src";
import * as oauthUtils from "../src/utils/oauth";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

describe("RemoteAuthCredentialStore + AuthStorage integration", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "remote-bearer";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		serverStore.saveOAuth("anthropic", {
			access: "server-access-1",
			refresh: "server-refresh-1",
			expires: Date.now() - 60_000, // expired so refresh is forced
			accountId: "account-1",
			email: "a@example.com",
		});
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await handle?.close();
		serverStorage?.close();
		serverStore?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("client-side AuthStorage refreshes via broker override, never via local OAuth path", async () => {
		// Real refresh executed by the broker server; mock surfaces the rotated tokens.
		const rotated = {
			access: "server-access-rotated",
			refresh: "server-refresh-rotated",
			expires: Date.now() + 120_000,
			accountId: "account-1",
			email: "a@example.com",
		};
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(rotated);

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialSnapshot = initialResult.snapshot;
		expect(initialSnapshot.credentials).toHaveLength(1);

		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot,
		});

		let overrideCalls = 0;
		const clientStorage = new AuthStorage(remoteStore, {
			refreshOAuthCredential: async (_provider, credentialId, _credential) => {
				overrideCalls += 1;
				const { entry } = await brokerClient.refreshCredential(credentialId);
				if (entry.credential.type !== "oauth") throw new Error("unexpected");
				return {
					access: entry.credential.access,
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: entry.credential.expires,
					accountId: entry.credential.accountId,
					email: entry.credential.email,
				};
			},
		});
		await clientStorage.reload();

		const apiKey = await clientStorage.getApiKey("anthropic");
		expect(apiKey).toBe("server-access-rotated");
		expect(overrideCalls).toBe(1);
		expect(remoteStore.snapshot.credentials[0]?.credential).toMatchObject({
			access: "server-access-rotated",
			refresh: REMOTE_REFRESH_SENTINEL,
		});
		// The local oauth refresh helper was used exactly once — by the broker server.
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		clientStorage.close();
	});
	test("suspect credential refresh updates the client snapshot from the broker response", async () => {
		const rotated = {
			access: "server-access-after-401",
			refresh: "server-refresh-after-401",
			expires: Date.now() + 120_000,
			accountId: "account-1",
			email: "a@example.com",
		};
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(rotated);

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialEntry = initialResult.snapshot.credentials[0];
		if (!initialEntry) throw new Error("expected credential");

		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});

		await remoteStore.markCredentialSuspect(initialEntry.id);
		const rows = remoteStore.listAuthCredentials("anthropic");

		expect(rows).toHaveLength(1);
		expect(rows[0]?.credential.type).toBe("oauth");
		if (rows[0]?.credential.type === "oauth") {
			expect(rows[0].credential.access).toBe("server-access-after-401");
			expect(rows[0].credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		remoteStore.close();
	});

	test("suspect API-key credentials refresh the snapshot without OAuth refresh", async () => {
		serverStore!.saveApiKey("kagi", "api-key-before-401");
		await serverStorage!.reload();
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialEntry = initialResult.snapshot.credentials.find(entry => entry.provider === "kagi");
		if (initialEntry?.credential.type !== "api_key") throw new Error("expected API-key credential");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
		});

		serverStorage!.disableCredentialById(initialEntry.id, "replaced after 401");
		serverStore!.saveApiKey("kagi", "api-key-after-401");
		await serverStorage!.reload();
		const refreshSpy = vi.spyOn(brokerClient, "refreshCredential");
		await remoteStore.markCredentialSuspect(initialEntry.id);

		expect(refreshSpy).not.toHaveBeenCalled();
		expect(remoteStore.listAuthCredentials("kagi")).toEqual([
			expect.objectContaining({
				provider: "kagi",
				credential: { type: "api_key", key: "api-key-after-401" },
			}),
		]);
		remoteStore.close();
	});

	test("orders remote snapshot invalidation behind provider admission tickets", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
		});
		const nextSnapshot: SnapshotResponse = {
			...initialResult.snapshot,
			generation: initialResult.snapshot.generation + 1,
			generatedAt: Date.now(),
			serverNowMs: Date.now(),
			credentials: [],
		};
		vi.spyOn(brokerClient, "fetchSnapshot").mockResolvedValue({
			status: 200,
			snapshot: nextSnapshot,
			generation: nextSnapshot.generation,
		});

		const ticket = await remoteStore.acquireCredentialDispatchTicket("anthropic");
		let refreshSettled = false;
		const refresh = remoteStore.refreshSnapshot().then(() => {
			refreshSettled = true;
		});
		await Bun.sleep(0);
		expect(refreshSettled).toBe(false);
		expect(remoteStore.snapshot.credentials).toHaveLength(1);

		ticket.release();
		await refresh;
		expect(remoteStore.snapshot.credentials).toHaveLength(0);
		remoteStore.close();
	});

	test("aborted dispatch ticket waiters release their queue slot", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
		});
		const first = await remoteStore.acquireCredentialDispatchTicket("anthropic");
		const controller = new AbortController();
		const second = remoteStore.acquireCredentialDispatchTicket("anthropic", controller.signal);
		controller.abort();
		await expect(second).rejects.toThrow(/aborted/);

		first.release();
		const third = await remoteStore.acquireCredentialDispatchTicket("anthropic");
		third.release();
		remoteStore.close();
	});

	test("RemoteAuthCredentialStore rejects writes from the client", () => {
		const remoteStore = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle!.url, token }),
		});
		expect(() => remoteStore.replaceAuthCredentialsForProvider("anthropic", [])).toThrow(/read-only/);
		expect(() => remoteStore.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "x" })).toThrow(
			/read-only/,
		);
		expect(() => remoteStore.deleteAuthCredentialsForProvider("anthropic", "x")).toThrow(/read-only/);
		expect(() =>
			remoteStore.upsertAuthCredentialForProviderIfAbsent("anthropic", { type: "api_key", key: "x" }),
		).toThrow(/read-only/);
		remoteStore.close();
	});

	test("accepts a lower generation from a restarted broker epoch", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialSnapshot: SnapshotResponse = {
			generation: 99,
			generatedAt: Date.now() - 1_000,
			serverNowMs: Date.now() - 1_000,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
			credentials: [
				{
					id: 999,
					provider: "anthropic",
					credential: {
						type: "oauth",
						access: "stale-access",
						refresh: REMOTE_REFRESH_SENTINEL,
						expires: Date.now() + 60_000,
					},
					identityKey: "stale@example.com",
					rotatesInMs: null,
				},
			],
		};
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot,
			streamSnapshots: false,
		});
		await remoteStore.refreshSnapshot();
		expect(remoteStore.snapshot.generation).toBeLessThan(99);
		expect(remoteStore.snapshot.credentials[0]?.credential).toMatchObject({ access: "server-access-1" });
		remoteStore.close();
	});

	test("rejects delayed data from a retired broker epoch even with a newer timestamp", async () => {
		let nextSnapshot: SnapshotResponse = {
			generation: 1,
			epoch: "200-new-epoch",
			generatedAt: 100,
			serverNowMs: 100,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
			credentials: [],
		};
		const fetchImpl = async (): Promise<Response> => {
			await Bun.sleep(1);
			return new Response(JSON.stringify(nextSnapshot), {
				status: 200,
				headers: { "Content-Type": "application/json", ETag: `"${nextSnapshot.generation}"` },
			});
		};
		const client = new AuthBrokerClient({
			url: "http://broker.test",
			token: "token",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			maxRetries: 0,
		});
		const remoteStore = new RemoteAuthCredentialStore({
			client,
			streamSnapshots: false,
			initialSnapshot: {
				...nextSnapshot,
				generation: 99,
				epoch: "100-old-epoch",
				serverNowMs: 200,
			},
		});
		await remoteStore.refreshSnapshot();
		nextSnapshot = { ...nextSnapshot, generation: 100, epoch: "100-old-epoch", serverNowMs: 300 };
		await expect(remoteStore.refreshSnapshot()).rejects.toThrow("snapshot authority was rejected");
		expect(remoteStore.snapshot.epoch).toBe("200-new-epoch");
		expect(remoteStore.snapshot.generation).toBe(1);
		remoteStore.close();
	});

	test("rejects unseen opaque broker epochs without authoritative ordering", async () => {
		let nextSnapshot: SnapshotResponse = {
			generation: 1,
			epoch: "opaque-current",
			generatedAt: 100,
			serverNowMs: 100,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
			credentials: [],
		};
		const client = new AuthBrokerClient({
			url: "http://broker.test",
			token: "token",
			fetchImpl: (async () =>
				new Response(JSON.stringify(nextSnapshot), {
					status: 200,
					headers: { "Content-Type": "application/json", ETag: `"${nextSnapshot.generation}"` },
				})) as unknown as typeof fetch,
			maxRetries: 0,
		});
		const remoteStore = new RemoteAuthCredentialStore({
			client,
			streamSnapshots: false,
			initialSnapshot: nextSnapshot,
		});
		nextSnapshot = { ...nextSnapshot, epoch: "opaque-delayed", generation: 2, serverNowMs: 200 };
		await expect(remoteStore.refreshSnapshot()).rejects.toThrow("snapshot authority was rejected");
		expect(remoteStore.snapshot.epoch).toBe("opaque-current");
		remoteStore.close();
	});

	test("does not fail a refresh when an older same-epoch GET is superseded", async () => {
		const initialSnapshot: SnapshotResponse = {
			generation: 1,
			epoch: "100-current-epoch",
			generatedAt: 100,
			serverNowMs: 100,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
			credentials: [],
		};
		let nextSnapshot: SnapshotResponse = { ...initialSnapshot, generation: 2, serverNowMs: 200 };
		const client = new AuthBrokerClient({
			url: "http://broker.test",
			token: "token",
			fetchImpl: (async () => {
				await Bun.sleep(1);
				return new Response(JSON.stringify(nextSnapshot), {
					status: 200,
					headers: {
						"Content-Type": "application/json",
						ETag: `"${nextSnapshot.epoch}:${nextSnapshot.generation}"`,
					},
				});
			}) as unknown as typeof fetch,
			maxRetries: 0,
		});
		const remoteStore = new RemoteAuthCredentialStore({ client, initialSnapshot, streamSnapshots: false });

		await remoteStore.refreshSnapshot();
		expect(remoteStore.snapshot.generation).toBe(2);
		nextSnapshot = { ...initialSnapshot, generatedAt: 150, serverNowMs: 150 };
		await expect(remoteStore.refreshSnapshot()).resolves.toBe(remoteStore.snapshot);
		expect(remoteStore.snapshot.generation).toBe(2);
		remoteStore.close();
	});

	test("rethrows caller cancellation from scoped usage lookup", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
			streamSnapshots: false,
		});
		const usage = Promise.withResolvers<{ generatedAt: number; reports: [] }>();
		vi.spyOn(brokerClient, "fetchUsage").mockImplementation(async () => usage.promise as never);
		const controller = new AbortController();
		const request = remoteStore.getUsageReport(
			"anthropic",
			{
				type: "oauth",
				access: "access",
				refresh: REMOTE_REFRESH_SENTINEL,
				expires: Date.now() + 60_000,
			},
			controller.signal,
		);
		controller.abort();
		await expect(request).rejects.toThrow(/aborted/);
		usage.resolve({ generatedAt: Date.now(), reports: [] });
		remoteStore.close();
	});

	test("getUsageReport coalesces parallel callers and matches by identity", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});

		const reportForA = {
			provider: "anthropic" as const,
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "a@example.com" },
		};
		const reportForB = {
			provider: "anthropic" as const,
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "b@example.com" },
		};
		const fetchSpy = vi.spyOn(brokerClient, "fetchUsage").mockImplementation(async (_signal, provider) => ({
			generatedAt: Date.now(),
			reports: provider === "anthropic" ? [reportForA, reportForB] : [],
		}));

		const credA = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: Date.now() + 60_000,
			email: "a@example.com",
		};
		const credB = { ...credA, email: "b@example.com" };

		const [resA, resB] = await Promise.all([
			remoteStore.getUsageReport("anthropic", credA),
			remoteStore.getUsageReport("anthropic", credB),
		]);
		// Parallel callers share a single broker round-trip.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(resA?.metadata?.email).toBe("a@example.com");
		expect(resB?.metadata?.email).toBe("b@example.com");

		// Cached on the second call — still one fetch total.
		const cached = await remoteStore.getUsageReport("anthropic", credA);
		expect(cached?.metadata?.email).toBe("a@example.com");
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Unknown provider is independently scoped and receives an empty response.
		const miss = await remoteStore.getUsageReport("openai-codex", credA);
		expect(miss).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(2);

		remoteStore.close();
	});

	test("client AuthStorage.set forwards api_key login to the broker (replace semantics)", async () => {
		// Pre-existing api_key for the same provider on the server side — a fresh
		// login should disable it and replace it with the new key.
		serverStore!.saveApiKey("kagi", "old-key");
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		await clientStorage.set("kagi", { type: "api_key", key: "new-key" });

		// Server is the source of truth — only the new key should be active.
		const activeOnServer = serverStore!.listAuthCredentials("kagi");
		expect(activeOnServer).toHaveLength(1);
		expect(activeOnServer[0].credential).toEqual({ type: "api_key", key: "new-key" });

		// Client reflects the new key through the broker's `POST /v1/credential`
		// response without waiting for the long-poll snapshot tick.
		expect(clientStorage.get("kagi")).toEqual({ type: "api_key", key: "new-key" });
		clientStorage.close();
	});

	test("client AuthStorage.importCredentialIfAbsent uses broker if-absent endpoint", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		const skipped = await clientStorage.importCredentialIfAbsent("anthropic", {
			type: "oauth",
			access: "client-access-skipped",
			refresh: "client-refresh-skipped",
			expires: Date.now() + 60_000,
			email: "skipped@example.com",
		});
		expect(skipped.inserted).toBe(false);
		expect(["skipped-existing", "skipped-existing-env"]).toContain(skipped.reason);
		expect(serverStore!.listAuthCredentials("anthropic")).toHaveLength(1);

		const inserted = await clientStorage.importCredentialIfAbsent("kagi", { type: "api_key", key: "new-key" });
		expect(inserted.inserted).toBe(true);
		expect(inserted.reason).toBe("inserted");
		expect(inserted.entries).toHaveLength(1);
		expect(serverStore!.listAuthCredentials("kagi")).toHaveLength(1);
		expect(clientStorage.get("kagi")).toEqual({ type: "api_key", key: "new-key" });
		clientStorage.close();
	});

	test("client AuthStorage.remove rejects broker-owned provider deletion", async () => {
		serverStore!.saveApiKey("kagi", "k1");
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		await expect(clientStorage.remove("kagi")).resolves.toBeUndefined();
		expect(remoteStore.listAuthCredentials("kagi")).toHaveLength(0);
		expect(serverStore!.listAuthCredentials("kagi")).toHaveLength(0);
		expect(clientStorage.get("kagi")).toBeUndefined();
		clientStorage.close();
	});
});
