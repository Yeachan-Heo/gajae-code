import { expect, test } from "bun:test";
import { type EndpointAuthority, ThreadRuntimeManager } from "../../thread-runtime/thread-runtime-manager";

const authority = (gen: number): EndpointAuthority => ({
	endpointGeneration: gen,
	endpointIncarnation: "a".repeat(64),
	endpointMtimeMs: Date.now(),
	pid: 12345,
});

test("register: creates a spawned thread with captured authority and connectionId", () => {
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	const t = m.register("thread-1", "spawned", authority(1), "conn-a");
	expect(t.threadId).toBe("thread-1");
	expect(t.ownership).toBe("spawned");
	expect(t.authority?.endpointGeneration).toBe(1);
	expect(t.connectionId).toBe("conn-a");
	expect(m.loadedCount).toBe(1);
});

test("register: rejects duplicate threadId", () => {
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	m.register("t1", "spawned", authority(1));
	expect(() => m.register("t1", "spawned", authority(2))).toThrow(/already loaded/);
});

test("acquireSpawnToken: bounds concurrent async startup; a held token blocks a second", () => {
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 10, spawnSemaphore: 1 });
	// Acquire the only token — simulates an in-progress async child spawn.
	const token = m.acquireSpawnToken();
	expect(token).toBeDefined();
	// A second acquisition must fail (semaphore exhausted).
	expect(() => m.acquireSpawnToken()).toThrow(/semaphore exhausted/);
	// Releasing the token allows a new acquisition.
	token.release();
	const token2 = m.acquireSpawnToken();
	expect(token2).toBeDefined();
	token2.release();
});

test("acquireSpawnToken: double-release is a safe no-op", () => {
	const m = new ThreadRuntimeManager({ spawnSemaphore: 1 });
	const token = m.acquireSpawnToken();
	token.release();
	token.release(); // idempotent
	// Semaphore should be back to 0, so a new acquisition succeeds.
	expect(m.acquireSpawnToken()).toBeDefined();
});

test("register: capacity exhaustion throws conflict when no thread is evictable", () => {
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 2, idleTtlMs: 0 });
	m.register("t1", "spawned", authority(1));
	m.register("t2", "spawned", authority(2));
	m.setActiveTurn("t1", true);
	m.setActiveTurn("t2", true);
	expect(() => m.register("t3", "spawned", authority(3))).toThrow(/capacity exhausted/);
});

test("register: idle owned children past TTL are evicted before rejecting", () => {
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 1, idleTtlMs: 0 });
	m.register("t1", "spawned", authority(1));
	m.register("t2", "spawned", authority(2));
	expect(m.get("t1")).toBeUndefined();
	expect(m.get("t2")).toBeDefined();
});

test("register: active turns are never evicted", () => {
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 1, idleTtlMs: 0 });
	m.register("t1", "spawned", authority(1));
	m.setActiveTurn("t1", true);
	expect(() => m.register("t2", "spawned", authority(2))).toThrow(/capacity exhausted/);
	expect(m.get("t1")).toBeDefined();
});

test("register: pending approvals protect from eviction", () => {
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 1, idleTtlMs: 0 });
	m.register("t1", "spawned", authority(1));
	m.adjustPendingApprovals("t1", 1);
	expect(() => m.register("t2", "spawned", authority(2))).toThrow(/capacity exhausted/);
	m.adjustPendingApprovals("t1", -1);
	m.register("t2", "spawned", authority(2));
	expect(m.get("t1")).toBeUndefined();
});

test("register: per-connection pending-load limit", () => {
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 10, perConnectionPendingLimit: 2 });
	m.register("t1", "spawned", authority(1), "conn-a");
	m.register("t2", "spawned", authority(2), "conn-a");
	expect(() => m.register("t3", "spawned", authority(3), "conn-a")).toThrow(/connection/i);
	m.register("t4", "spawned", authority(4), "conn-b");
});

test("per-connection load is decremented on detach/terminate", () => {
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 10, perConnectionPendingLimit: 1 });
	m.register("t1", "attached", undefined, "conn-a");
	// Now conn-a is at its limit.
	expect(() => m.register("t2", "spawned", authority(2), "conn-a")).toThrow(/connection/i);
	// Detach t1 releases the count.
	m.detach("t1");
	// Now conn-a can load again.
	m.register("t3", "spawned", authority(3), "conn-a");
});

test("per-connection load is decremented on LRU eviction", () => {
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 1, perConnectionPendingLimit: 1, idleTtlMs: 0 });
	m.register("t1", "spawned", authority(1), "conn-a");
	// Evict t1 via capacity pressure.
	m.register("t2", "spawned", authority(2), "conn-a");
	expect(m.get("t1")).toBeUndefined();
	// conn-a's count was decremented, so t2 succeeded.
	expect(m.get("t2")).toBeDefined();
});

test("detach: only valid for attached ownership", () => {
	const m = new ThreadRuntimeManager();
	m.register("t1", "attached", undefined);
	expect(m.detach("t1")).toBe(true);
	expect(m.get("t1")).toBeUndefined();
});

test("detach: throws on spawned ownership (must use terminate)", () => {
	const m = new ThreadRuntimeManager();
	m.register("t1", "spawned", authority(1));
	expect(() => m.detach("t1")).toThrow(/Cannot detach spawned/);
});

test("terminate: only valid for spawned ownership; returns authority", () => {
	const m = new ThreadRuntimeManager();
	m.register("t1", "spawned", authority(7));
	const auth = m.terminate("t1");
	expect(auth?.endpointGeneration).toBe(7);
	expect(m.get("t1")).toBeUndefined();
});

test("terminate: throws on attached ownership (must use detach)", () => {
	const m = new ThreadRuntimeManager();
	m.register("t1", "attached", undefined);
	expect(() => m.terminate("t1")).toThrow(/Cannot terminate attached/);
});

test("closeOwned callback: invoked on LRU eviction and terminate with the captured authority", () => {
	const closed: Array<{ id: string; auth?: EndpointAuthority }> = [];
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 1, idleTtlMs: 0 });
	m.onCloseOwned((id, _ownership, auth) => {
		closed.push({ id, auth });
	});
	m.register("t1", "spawned", authority(1));
	// Evict t1 via capacity pressure.
	m.register("t2", "spawned", authority(2));
	expect(closed.some(c => c.id === "t1" && c.auth?.endpointGeneration === 1)).toBe(true);
	// Terminate t2.
	m.terminate("t2");
	expect(closed.some(c => c.id === "t2" && c.auth?.endpointGeneration === 2)).toBe(true);
});

test("shutdown: detaches attached and terminates spawned (callback fires for spawned only)", () => {
	const closed: string[] = [];
	const m = new ThreadRuntimeManager();
	m.onCloseOwned(id => {
		closed.push(id);
	});
	m.register("t1", "spawned", authority(1));
	m.register("t2", "attached", undefined);
	m.register("t3", "spawned", authority(3));
	const result = m.shutdown();
	expect(result.detached).toEqual(["t2"]);
	expect(result.terminated).toHaveLength(2);
	expect(closed).toEqual(expect.arrayContaining(["t1", "t3"]));
	expect(m.loadedCount).toBe(0);
});

test("shutdown: waits for async child closures and remains idempotent", async () => {
	const m = new ThreadRuntimeManager();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let closeCalls = 0;
	m.onCloseOwned(async () => {
		started.resolve();
		await release.promise;
		closeCalls += 1;
	});
	m.register("t1", "spawned", authority(1));
	m.shutdown();
	await started.promise;
	let settled = false;
	const waiting = m.waitForClosures().then(() => {
		settled = true;
	});
	await Bun.sleep(0);
	expect(settled).toBe(false);
	release.resolve();
	await waiting;
	m.shutdown();
	await m.waitForClosures();
	expect(closeCalls).toBe(1);
});
test("attached threads are never evicted by LRU (only owned)", () => {
	const m = new ThreadRuntimeManager({ maxLoadedThreads: 1, idleTtlMs: 0 });
	m.register("t1", "attached", undefined);
	expect(() => m.register("t2", "spawned", authority(2))).toThrow(/capacity exhausted/);
	expect(m.get("t1")).toBeDefined();
});
