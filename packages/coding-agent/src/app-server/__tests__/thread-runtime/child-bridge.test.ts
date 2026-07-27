import { expect, test } from "bun:test";
import { ThreadRuntimeManager, type EndpointAuthority } from "../../thread-runtime/thread-runtime-manager";
import { loadThread, wireCloseCallback, type ChildBridgeOptions } from "../../thread-runtime/child-bridge";

const authority = (gen: number): EndpointAuthority => ({
	endpointGeneration: gen,
	endpointIncarnation: "b".repeat(64),
	endpointMtimeMs: Date.now(),
	pid: 54321,
});

test("loadThread: acquires token, spawns child, registers thread, releases token", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4, spawnSemaphore: 1 });
	const opts: ChildBridgeOptions = {
		manager,
		spawn: async (_id, _ownership) => authority(1),
	};
	await loadThread(opts, "t1", "spawned", "conn-a");
	expect(manager.get("t1")).toBeDefined();
	expect(manager.get("t1")?.authority?.endpointGeneration).toBe(1);
});

test("loadThread: spawn failure releases the token without registering", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4, spawnSemaphore: 1 });
	const opts: ChildBridgeOptions = {
		manager,
		spawn: async () => { throw new Error("spawn failed"); },
	};
	await expect(loadThread(opts, "t1", "spawned")).rejects.toThrow("spawn failed");
	expect(manager.get("t1")).toBeUndefined();
	// Token was released, so a new load succeeds.
	const opts2: ChildBridgeOptions = { manager, spawn: async () => authority(2) };
	await loadThread(opts2, "t2", "spawned");
	expect(manager.get("t2")).toBeDefined();
});

test("loadThread: spawn semaphore bounds concurrent loads", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 10, spawnSemaphore: 1 });
	let resolveSpawn: () => void = () => {};
	const opts: ChildBridgeOptions = {
		manager,
		spawn: () => new Promise<EndpointAuthority>(resolve => { resolveSpawn = () => resolve(authority(1)); }),
	};
	// Start first load — it blocks in spawn (never resolves until we call resolveSpawn).
	const first = loadThread(opts, "t1", "spawned");
	await new Promise(r => setTimeout(r, 10));
	// Second load must fail because the semaphore token is held by the first.
	await expect(loadThread(opts, "t2", "spawned")).rejects.toThrow(/semaphore exhausted/);
	// Resolve the first spawn.
	resolveSpawn();
	await first;
	expect(manager.get("t1")).toBeDefined();
});

test("wireCloseCallback: eviction triggers the close function with captured authority", async () => {
	const closed: Array<{ id: string; auth?: EndpointAuthority }> = [];
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 1, idleTtlMs: 0 });
	const opts: ChildBridgeOptions = {
		manager,
		spawn: async (_id, _ownership) => authority(42),
		close: async (id, _ownership, auth) => { closed.push({ id, auth }); },
	};
	wireCloseCallback(opts);
	await loadThread(opts, "t1", "spawned");
	// Evict via capacity pressure (idleTtlMs=0, so t1 is immediately evictable).
	await loadThread(opts, "t2", "spawned");
	expect(closed.some(c => c.id === "t1" && c.auth?.endpointGeneration === 42)).toBe(true);
});

test("loadThread: attached ownership (resume) registers without a spawned child", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	const opts: ChildBridgeOptions = {
		manager,
		spawn: async () => undefined, // attached: no real child spawn, no authority
	};
	await loadThread(opts, "t1", "attached");
	expect(manager.get("t1")?.ownership).toBe("attached");
	expect(manager.get("t1")?.authority).toBeUndefined();
});
