import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, closeModelCache, type Model, readModelCache, writeModelCache } from "@gajae-code/ai";
import { ModelDiscoveryManager } from "../src/config/model-discovery-manager";

function model(id: string): Model<Api> {
	return {
		provider: "test",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://test.example.com/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 1,
		maxTokens: 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

const unauthenticatedCallbacks = {
	requiresAuth: () => true,
	peekApiKey: async () => undefined,
	isAuthenticated: () => false,
	fetchModels: async () => [model("unexpected")],
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("ModelDiscoveryManager", () => {
	test("snapshots provider inputs and clears state on reset", () => {
		const manager = new ModelDiscoveryManager<{ provider: string; headers: Record<string, string> }>();
		const provider = { provider: "openai", headers: { authorization: "original" } };
		manager.setProviders([provider]);
		provider.headers.authorization = "caller mutation";
		const snapshot = manager.providers[0]!;
		snapshot.headers.authorization = "reader mutation";

		expect(manager.providers).toEqual([{ provider: "openai", headers: { authorization: "original" } }]);
		manager.reset();
		expect(manager.providers).toEqual([]);
	});

	test("shapes unauthenticated, cached, live, and error discovery results", async () => {
		const cacheDbPath = `${Bun.env.TMPDIR ?? "/tmp"}/model-discovery-manager-${crypto.randomUUID()}.db`;
		const provider = { provider: "test" };
		writeModelCache("test", Date.now(), [model("cached")], true, "", cacheDbPath);

		const unauthenticated = new ModelDiscoveryManager<typeof provider>();
		unauthenticated.setProviders([provider]);
		const unauthenticatedResult = await unauthenticated.discover(provider, "online", {
			...unauthenticatedCallbacks,
			cacheDbPath,
		});
		expect(unauthenticatedResult).toMatchObject({
			current: true,
			models: [expect.objectContaining({ id: "cached" })],
			state: { status: "unauthenticated", stale: true, models: ["cached"] },
		});

		const live = new ModelDiscoveryManager<typeof provider>();
		live.setProviders([provider]);
		const liveResult = await live.discover(provider, "online", {
			cacheDbPath,
			requiresAuth: () => false,
			peekApiKey: async () => undefined,
			isAuthenticated: () => true,
			fetchModels: async () => [model("live")],
		});
		expect(liveResult).toMatchObject({ current: true, state: { status: "ok", models: ["live"] } });

		const failed = new ModelDiscoveryManager<typeof provider>();
		failed.setProviders([provider]);
		const failedResult = await failed.discover(provider, "online", {
			cacheDbPath,
			requiresAuth: () => false,
			peekApiKey: async () => undefined,
			isAuthenticated: () => true,
			fetchModels: async () => {
				throw new Error("connection refused");
			},
		});
		expect(failedResult).toMatchObject({
			current: true,
			state: { status: "cached", stale: true, error: "connection refused", models: ["live"] },
			warning: "connection refused",
		});
	});

	test("rejects stale same-provider results without blocking independent providers", async () => {
		const manager = new ModelDiscoveryManager<{ provider: string }>();
		const openai = { provider: "openai" };
		const anthropic = { provider: "anthropic" };
		manager.setProviders([openai, anthropic]);
		let finishFirst!: (models: Model<Api>[]) => void;
		const callbacks = (fetchModels: () => Promise<Model<Api>[]>) => ({
			requiresAuth: () => false,
			peekApiKey: async () => undefined,
			isAuthenticated: () => true,
			fetchModels,
		});
		const first = manager.discover(
			openai,
			"online",
			callbacks(() => new Promise(resolve => (finishFirst = resolve))),
		);
		const newest = manager.discover(
			openai,
			"online",
			callbacks(async () => [model("newest")]),
		);
		const other = manager.discover(
			anthropic,
			"online",
			callbacks(async () => [model("other")]),
		);

		expect((await newest).current).toBe(true);
		expect((await other).current).toBe(true);
		finishFirst([model("stale")]);
		const stale = await first;
		expect(stale).toMatchObject({ current: false, models: [] });
		expect(manager.getState("openai")).toMatchObject({ status: "ok", models: ["newest"] });
	});

	test("keeps newer same-provider discoveries authoritative in the cache", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "model-discovery-race-"));
		const cacheDbPath = join(cacheDir, "models.db");
		const provider = { provider: "test" };
		const manager = new ModelDiscoveryManager<typeof provider>();
		manager.setProviders([provider]);
		const callbacks = (fetchModels: () => Promise<Model<Api>[]>) => ({
			requiresAuth: () => false,
			peekApiKey: async () => undefined,
			isAuthenticated: () => true,
			fetchModels,
			cacheDbPath,
		});

		try {
			const staleSuccessFetch = deferred<Model<Api>[]>();
			const staleSuccess = manager.discover(
				provider,
				"online",
				callbacks(() => staleSuccessFetch.promise),
			);
			const newest = await manager.discover(
				provider,
				"online",
				callbacks(async () => [model("newest")]),
			);
			expect(newest.current).toBe(true);
			staleSuccessFetch.resolve([model("stale-success")]);
			expect((await staleSuccess).current).toBe(false);

			const staleFailureFetch = deferred<Model<Api>[]>();
			const staleFailure = manager.discover(
				provider,
				"online",
				callbacks(() => staleFailureFetch.promise),
			);
			const newestAfterFailure = await manager.discover(
				provider,
				"online",
				callbacks(async () => [model("newest-after-failure")]),
			);
			expect(newestAfterFailure.current).toBe(true);
			staleFailureFetch.reject(new Error("stale failure"));
			expect((await staleFailure).current).toBe(false);

			const cache = readModelCache<Api>(provider.provider, 24 * 60 * 60 * 1000, Date.now, cacheDbPath);
			expect(cache).toMatchObject({
				authoritative: true,
				models: [expect.objectContaining({ id: "newest-after-failure" })],
			});
			expect(cache?.models.map(entry => entry.id)).not.toContain("stale-success");

			const offlineSuccessor = new ModelDiscoveryManager<typeof provider>();
			offlineSuccessor.setProviders([provider]);
			const offline = await offlineSuccessor.discover(
				provider,
				"offline",
				callbacks(async () => [model("unexpected")]),
			);
			expect(offline).toMatchObject({
				current: true,
				models: [expect.objectContaining({ id: "newest-after-failure" })],
				state: { status: "cached", models: ["newest-after-failure"] },
			});
		} finally {
			closeModelCache(cacheDbPath);
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});
});
