import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthBrokerClient,
	AuthBrokerError,
	type AuthBrokerServerHandle,
	AuthStorage,
	REMOTE_REFRESH_SENTINEL,
	RemoteAuthCredentialStore,
	SqliteAuthCredentialStore,
	startAuthBroker,
} from "../src";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, expires: number) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	if (!predicate()) throw new Error("waitUntil timeout");
}

describe("RemoteAuthCredentialStore SSE integration", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	const token = "remote-store-bearer";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-store-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveOAuth("anthropic", mintOAuthCredential("a", Date.now() + 60_000));
		storage = new AuthStorage(store);
		await storage.reload();
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		remote?.close();
		await handle?.close();
		storage?.close();
		store?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("consumes initial snapshot, upsert, and removal over SSE without manual refresh", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client });

		// 1. Initial snapshot frame populates the local store.
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const initialEntry = remote!.snapshot.credentials[0];
		expect(initialEntry.provider).toBe("anthropic");
		expect(initialEntry.credential.type).toBe("oauth");
		if (initialEntry.credential.type === "oauth") {
			expect(initialEntry.credential.access).toBe("access-a");
			expect(initialEntry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		const initialGeneration = remote!.snapshot.generation;

		// 2. Server-side upsert is delivered as an `entry` frame.
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await waitUntil(() => remote!.snapshot.credentials.length === 2);
		expect(remote!.snapshot.generation).toBeGreaterThan(initialGeneration);
		const accessTokens = remote!.snapshot.credentials
			.filter(entry => entry.credential.type === "oauth")
			.map(entry => (entry.credential.type === "oauth" ? entry.credential.access : ""))
			.sort();
		expect(accessTokens).toEqual(["access-a", "access-b"]);

		// 3. Server-side disable is delivered as a `removed` frame.
		const bId = remote!.snapshot.credentials.find(
			entry => entry.credential.type === "oauth" && entry.credential.access === "access-b",
		)?.id;
		expect(bId).toBeDefined();
		const disabled = storage!.disableCredentialById(bId!, "revoked by test");
		expect(disabled).toBe(true);
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		expect(remote!.snapshot.credentials[0].id).not.toBe(bId);
	});

	test("syncs metadata once and joins disabled rows without exposing payloads", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		await remote.refreshSnapshot();
		const activeId = remote.snapshot.credentials[0]!.id;
		storage!.upsertCredential("anthropic", mintOAuthCredential("disabled", Date.now() + 60_000));
		const disabledId = storage!
			.listCredentialInventory("anthropic")
			.find(row => row.identityLabel === "disabled@example.com")!.id;
		storage!.disableCredentialById(disabledId, "revoked in test");
		await remote.refreshSnapshot();
		const state = await remote.syncInventoryMetadata();
		expect(state.capability).toBe("supported");
		expect(state.generation).toBe(remote.snapshot.generation);
		expect(remote.listCredentialInventory("anthropic")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: activeId, disabled: false }),
				expect.objectContaining({ id: disabledId, disabled: true, disabledCause: "disabled via auth-broker" }),
			]),
		);
		for (const row of remote.listCredentialInventory()) expect(row).not.toHaveProperty("credential");
	});

	test("404 metadata is cached as unsupported and list is zero-network", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/v1/snapshot")) {
				return new Response(
					JSON.stringify({
						generation: 1,
						generatedAt: Date.now(),
						serverNowMs: Date.now(),
						refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
						credentials: [],
					}),
					{ status: 200, headers: { "content-type": "application/json", etag: '"1"' } },
				);
			}
			return new Response("not found", { status: 404 });
		});
		const fetchImpl = fetchMock as unknown as typeof fetch;
		const client = new AuthBrokerClient({ url: "http://broker.test", token, fetchImpl, maxRetries: 0 });
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		const state = await remote.syncInventoryMetadata();
		expect(state.capability).toBe("unsupported");
		const before = fetchMock.mock.calls.length;
		expect(remote.listCredentialInventory()).toEqual([]);
		expect(remote.getInventoryMetadataState().capability).toBe("unsupported");
		expect(fetchMock.mock.calls.length).toBe(before);
	});

	test("presentation usage peek is safe and zero-network", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		await remote.refreshSnapshot();
		const entry = remote.snapshot.credentials[0]!;
		expect(remote.peekCachedUsagePresentation(entry.provider as never, entry.id)).toBeUndefined();
	});

	test("refreshes the snapshot after a deleted-row refresh failure and preserves the broker error", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		await remote.refreshSnapshot();
		const staleEntry = remote.snapshot.credentials[0]!;
		expect(staleEntry.credential.type).toBe("oauth");
		if (staleEntry.credential.type !== "oauth") throw new Error("expected OAuth credential");
		const snapshotFetch = vi.spyOn(client, "fetchSnapshot");
		const directFetchesBeforeFailure = snapshotFetch.mock.calls.filter(([opts]) => opts?.waitMs === undefined).length;

		storage!.disableCredentialById(staleEntry.id, "deleted in test");
		storage!.upsertCredential("anthropic", mintOAuthCredential("replacement", Date.now() + 120_000));

		const refreshError = await remote.refreshOAuthCredential("anthropic", staleEntry.id, staleEntry.credential).then(
			() => undefined,
			error => error,
		);
		expect(refreshError).toBeInstanceOf(AuthBrokerError);
		expect((refreshError as AuthBrokerError).status).toBe(404);
		expect((refreshError as AuthBrokerError).body).toContain(`No credential with id=${staleEntry.id}`);
		const directFetchesAfterFailure = snapshotFetch.mock.calls.filter(([opts]) => opts?.waitMs === undefined).length;
		expect(directFetchesAfterFailure).toBeGreaterThan(directFetchesBeforeFailure);
		expect(remote.snapshot.credentials).toHaveLength(1);
		expect(remote.snapshot.credentials[0]!.id).not.toBe(staleEntry.id);
	});

	test("records aggregate usage only for the current snapshot generation", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		await remote.refreshSnapshot();
		const entry = remote.snapshot.credentials[0]!;
		const now = Date.now();
		vi.spyOn(client, "fetchUsage").mockResolvedValue({
			generatedAt: now,
			reports: [{ provider: entry.provider as never, fetchedAt: now, limits: [] }],
		});
		await remote.fetchUsageReports();
		expect(remote.peekCachedUsagePresentation(entry.provider as never, entry.id)).toEqual(
			expect.objectContaining({ credentialId: entry.id, inventoryGeneration: remote.snapshot.generation }),
		);
		storage!.disableCredentialById(entry.id, "removed in test");
		await remote.refreshSnapshot();
		expect(remote.peekCachedUsagePresentation(entry.provider as never, entry.id)).toBeUndefined();
	});

	test("does not let an obsolete scoped usage flight delete its replacement", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		await remote.refreshSnapshot();

		const first = Promise.withResolvers<{ generatedAt: number; reports: [] }>();
		const second = Promise.withResolvers<{ generatedAt: number; reports: [] }>();
		const fetchUsage = vi.spyOn(client, "fetchUsage").mockImplementation((_signal, provider) => {
			if (provider !== "anthropic") throw new Error("expected scoped usage fetch");
			return (fetchUsage.mock.calls.length === 1 ? first.promise : second.promise) as never;
		});

		const firstRequest = remote.fetchUsageReportsForProvider("anthropic" as never);
		expect(fetchUsage).toHaveBeenCalledTimes(1);
		// This is the same invalidation path used when a snapshot generation
		// changes. A second request must be allowed to install its own flight.
		remote.deleteCachePrefix("usage_cache:");
		const secondRequest = remote.fetchUsageReportsForProvider("anthropic" as never);
		expect(fetchUsage).toHaveBeenCalledTimes(2);

		first.resolve({ generatedAt: Date.now(), reports: [] });
		await firstRequest;
		// The first promise has settled, but the replacement remains coalesced.
		expect(fetchUsage).toHaveBeenCalledTimes(2);
		second.resolve({ generatedAt: Date.now(), reports: [] });
		await secondRequest;
		await remote.fetchUsageReportsForProvider("anthropic" as never);
		expect(fetchUsage).toHaveBeenCalledTimes(2);
	});

	test("hydrates metadata and durable health/usage presentations for one-shot consumers", async () => {
		const presentationPath = path.join(tempDir, "presentations.json");
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, presentationPath });
		await remote.waitForReady();
		const entry = remote.snapshot.credentials[0]!;
		const now = Date.now();
		remote.recordCredentialHealth(entry.provider as never, entry.id, {
			status: "failed",
			reason: "Bearer secret-token rejected",
			checkedAt: now,
			retainUntil: now + 60_000,
		});
		remote.recordCredentialUsage(entry.provider as never, entry.id, {
			provider: entry.provider as never,
			fetchedAt: now,
			limits: [],
		});
		await remote.flushPresentationPersistence();
		const snapshot = remote.snapshot;
		remote.close();
		remote = new RemoteAuthCredentialStore({
			client,
			streamSnapshots: false,
			initialSnapshot: snapshot,
			presentationPath,
		});
		await remote.waitForReady();
		expect(remote.peekCachedCredentialHealth(entry.provider as never, entry.id)).toMatchObject({
			status: "failed",
			reason: "Bearer [redacted] rejected",
		});
		expect(remote.peekCachedUsagePresentation(entry.provider as never, entry.id)).toEqual(
			expect.objectContaining({ credentialId: entry.id }),
		);
	});
});
