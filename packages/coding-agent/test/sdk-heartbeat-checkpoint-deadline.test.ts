import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as locks from "../src/config/file-lock";
import { Broker } from "../src/sdk/broker/broker";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SessionIndex } from "../src/sdk/broker/session-index";

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots) await fs.rm(root, { recursive: true, force: true });
	roots.length = 0;
});

async function liveIndex(): Promise<SessionIndex> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-checkpoint-deadline-"));
	roots.push(root);
	const index = await new SessionIndex(root).open();
	await index.append({
		type: "host_registered",
		sessionId: "live-host",
		locator: { cwd: root, worktreeRoot: null, stateRoot: root },
		endpointGeneration: 1,
		pid: process.pid,
	});
	return index;
}

test("10s then 10.5s holders share one checkpoint budget below the 20s startup fence", async () => {
	const index = await liveIndex();
	let elapsed = 0;
	const budgets: number[] = [];
	vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	const lock = locks.withFileLock;
	vi.spyOn(locks, "withFileLock").mockImplementation(async (file, fn, options) => {
		const budget = (options?.retries ?? 50) * (options?.retryDelayMs ?? 100);
		budgets.push(budget);
		// Model the reviewer's exact two legitimate transactions, without sleeps.
		elapsed += Math.min(budgets.length === 1 ? 10_000 : 10_500, budget);
		return await lock(file, fn, options);
	});
	expect(await index.checkpointLiveHeartbeats()).toBe(0);
	expect(budgets).toEqual([15_000, 5_000]);
	expect(elapsed).toBe(15_000);
	expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
});

test("startup cancellation reaches an active lock contender", async () => {
	const index = await liveIndex();
	const controller = new AbortController();
	const contended = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const lock = locks.withFileLock;
	let holder: Promise<void> | undefined;
	vi.spyOn(locks, "withFileLock").mockImplementation(async (file, fn, options) => {
		const acquired = Promise.withResolvers<void>();
		holder = lock(file, async () => {
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		return await lock(file, fn, { ...options, onContended: contended.resolve });
	});
	const checkpoint = index.checkpointLiveHeartbeats(Date.now(), controller.signal);
	try {
		await contended.promise;
		controller.abort();
		expect(await checkpoint).toBe(0);
		expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
	} finally {
		release.resolve();
		await holder;
	}
}, 2_000);

test("a pre-aborted checkpoint does not acquire or write", async () => {
	const index = await liveIndex();
	const controller = new AbortController();
	controller.abort();
	const lock = vi.spyOn(locks, "withFileLock");
	expect(await index.checkpointLiveHeartbeats(Date.now(), controller.signal)).toBe(0);
	expect(lock).not.toHaveBeenCalled();
});

test("a checkpoint throw releases ownership and permits the next pass", async () => {
	const index = await liveIndex();
	const lock = locks.withFileLock;
	const failure = new Error("checkpoint replay failed");
	const spy = vi.spyOn(locks, "withFileLock").mockImplementationOnce(async (file, _fn, options) => {
		return await lock(
			file,
			async () => {
				throw failure;
			},
			options,
		);
	});
	await expect(index.checkpointLiveHeartbeats()).rejects.toBe(failure);
	spy.mockRestore();
	expect(await index.checkpointLiveHeartbeats()).toBe(1);
});

test("teardown of the index directory is not undone by a checkpoint", async () => {
	const index = await liveIndex();
	const root = roots[0]!;
	await fs.rm(root, { recursive: true, force: true });
	const lock = vi.spyOn(locks, "withFileLock");
	expect(await index.checkpointLiveHeartbeats()).toBe(0);
	expect(lock).not.toHaveBeenCalled();
	expect(await fs.exists(root)).toBe(false);
});

test("a lock acquired after cancellation is released without a heartbeat", async () => {
	const index = await liveIndex();
	const controller = new AbortController();
	const lock = locks.withFileLock;
	let callbacks = 0;
	vi.spyOn(locks, "withFileLock").mockImplementation(async (file, fn, options) => {
		// Acquisition may have passed its last signal check before cancellation.
		return await lock(
			file,
			async () => {
				controller.abort();
				callbacks++;
				return await fn();
			},
			options,
		);
	});
	expect(await index.checkpointLiveHeartbeats(Date.now(), controller.signal)).toBe(0);
	// Drain the same index queue before checking the late callback's effects.
	await index.refresh();
	expect(callbacks).toBeGreaterThanOrEqual(1);
	expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
	expect(await fs.exists(path.join(roots[0]!, "sdk", "sessions", "index.jsonl.lock"))).toBe(false);
});

test("deadline expiry cancels the current wait without writing or retrying", async () => {
	const index = await liveIndex();
	let elapsed = 0;
	vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	const lock = locks.withFileLock;
	let acquisitions = 0;
	vi.spyOn(locks, "withFileLock").mockImplementation(async (file, fn, options) => {
		acquisitions++;
		elapsed = 15_000;
		return await lock(file, fn, options);
	});
	expect(await index.checkpointLiveHeartbeats()).toBe(0);
	expect(acquisitions).toBe(1);
	expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
});

test("the deadline timer cancels a contended acquisition before its holder releases", async () => {
	const index = await liveIndex();
	const contended = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const lock = locks.withFileLock;
	const schedule = globalThis.setTimeout;
	let expire: (() => void) | undefined;
	const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
		if (ms !== undefined && ms > 14_000 && ms <= 15_000) expire = () => callback(...args);
		return schedule(callback, ms, ...args);
	});
	let holder: Promise<void> | undefined;
	const spy = vi.spyOn(locks, "withFileLock").mockImplementation(async (file, fn, options) => {
		const acquired = Promise.withResolvers<void>();
		holder = lock(file, async () => {
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		return await lock(file, fn, { ...options, onContended: contended.resolve });
	});
	const checkpoint = index.checkpointLiveHeartbeats();
	try {
		await contended.promise;
		expect(expire).toBeDefined();
		expire!();
		expect(await checkpoint).toBe(0);
		expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
	} finally {
		release.resolve();
		await holder;
		spy.mockRestore();
		timer.mockRestore();
	}
}, 2_000);

test("cancellation while locally queued cannot perform a late checkpoint", async () => {
	const index = await liveIndex();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const lock = locks.withFileLock;
	const spy = vi.spyOn(locks, "withFileLock").mockImplementationOnce(async (file, fn, options) => {
		return await lock(
			file,
			async () => {
				entered.resolve();
				await release.promise;
				return await fn();
			},
			options,
		);
	});
	const previous = index.snapshot();
	await entered.promise;
	const controller = new AbortController();
	const checkpoint = index.checkpointLiveHeartbeats(Date.now(), controller.signal);
	try {
		controller.abort();
		expect(await checkpoint).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);
	} finally {
		release.resolve();
		await previous;
	}
	// Drain the original queue: cancellation cannot grant another writer early.
	await index.refresh();
	expect(spy).toHaveBeenCalledTimes(2);
	expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
}, 2_000);

test("Broker.start passes its shorter deadline and publishes after a skipped checkpoint", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-checkpoint-startup-"));
	roots.push(root);
	const deadline = performance.now() - 1;
	const broker = new Broker({ agentDir: root, startupCheckpointDeadline: deadline });
	const checkpoint = vi.spyOn(broker.index, "checkpointLiveHeartbeats");
	try {
		const discovery = await broker.start();
		expect(checkpoint).toHaveBeenCalledWith(expect.any(Number), undefined, deadline);
		expect(await readBrokerDiscovery(root)).toMatchObject({ ownerId: discovery.ownerId });
	} finally {
		await broker.stop();
	}
});
