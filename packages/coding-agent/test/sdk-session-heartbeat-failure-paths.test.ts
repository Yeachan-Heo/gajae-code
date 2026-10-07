import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as lockModule from "../src/config/file-lock";
import { SessionIndex } from "../src/sdk/broker/session-index";

async function bounded<T>(promise: Promise<T>): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error("checkpoint event did not settle")), 5_000);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function fixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-heartbeat-failure-"));
	const index = await new SessionIndex(dir).open();
	await index.append({
		type: "host_registered",
		sessionId: "deadline-host",
		locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
		endpointGeneration: 1,
		pid: process.pid,
	});
	return { dir, index, log: path.join(dir, "sdk", "sessions", "index.jsonl") };
}

describe("SDK heartbeat checkpoint failure paths (#6459)", () => {
	it("does not acquire a lock for an already cancelled or exhausted pass", async () => {
		const { dir, index } = await fixture();
		const controller = new AbortController();
		controller.abort();
		const locking = vi.spyOn(lockModule, "withFileLock");
		try {
			expect(await index.checkpointLiveHeartbeats(Date.now(), controller.signal)).toBe(0);
			expect(await index.checkpointLiveHeartbeats(Date.now(), undefined, performance.now() - 1)).toBe(0);
			expect(locking).not.toHaveBeenCalled();
			expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
		} finally {
			locking.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("propagates a transaction throw, releases its lock, and permits the next pass", async () => {
		const { dir, index, log } = await fixture();
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		const failure = new Error("checkpoint transaction failed");
		const realWithFileLock = lockModule.withFileLock;
		const locking = vi.spyOn(lockModule, "withFileLock").mockImplementationOnce(
			async (file, _callback, options) =>
				await realWithFileLock(
					file,
					async () => {
						throw failure;
					},
					options,
				),
		);
		try {
			await expect(index.checkpointLiveHeartbeats()).rejects.toBe(failure);
			expect(await fs.exists(`${log}.lock`)).toBe(false);
			expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
			locking.mockRestore();
			expect(await index.checkpointLiveHeartbeats()).toBe(1);
		} finally {
			locking.mockRestore();
			clock.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("cancels real lock contention without stealing the holder or waiting for its release", async () => {
		const { dir, index, log } = await fixture();
		const release = await lockModule.acquireFileLock(log);
		const contended = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const controller = new AbortController();
		const realWithFileLock = lockModule.withFileLock;
		const locking = vi.spyOn(lockModule, "withFileLock").mockImplementation(async (file, callback, options) => {
			try {
				return await realWithFileLock(file, callback, { ...options, onContended: () => contended.resolve() });
			} finally {
				settled.resolve();
			}
		});
		try {
			const checkpoint = index.checkpointLiveHeartbeats(Date.now(), controller.signal);
			await bounded(contended.promise);
			controller.abort(new Error("startup cancelled"));
			expect(await bounded(checkpoint)).toBe(0);
			expect(await fs.exists(`${log}.lock`)).toBe(true);
			await bounded(settled.promise);
			expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
		} finally {
			controller.abort();
			await release();
			locking.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it.each(["cancel", "timeout"] as const)("%s fences queued work and late acquisition callbacks", async mode => {
		const { dir, index, log } = await fixture();
		let elapsed = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		let expire: (() => void) | undefined;
		const realSetTimeout = globalThis.setTimeout;
		const captureTimeout: typeof setTimeout = Object.assign((...args: Parameters<typeof setTimeout>) => {
			if (args[1] === 15_000 && expire === undefined) expire = () => args[0]();
			return realSetTimeout(...args);
		}, realSetTimeout);
		const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(captureTimeout);
		const entered = Promise.withResolvers<void>();
		const grant = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const first = new AbortController();
		const second = new AbortController();
		const realWithFileLock = lockModule.withFileLock;
		const locking = vi.spyOn(lockModule, "withFileLock").mockImplementationOnce(async (file, callback, options) => {
			entered.resolve();
			await grant.promise;
			try {
				// Model a late acknowledgement: the real lock body runs even though
				// acquisition could not observe abort. Its callback must be fenced.
				return await realWithFileLock(file, callback, { ...options, signal: undefined });
			} finally {
				settled.resolve();
			}
		});
		try {
			const pending = index.checkpointLiveHeartbeats(Date.now(), first.signal);
			await bounded(entered.promise);
			const queued = index.checkpointLiveHeartbeats(Date.now(), second.signal);
			second.abort();
			if (mode === "cancel") first.abort();
			else {
				expect(expire).toBeDefined();
				elapsed = 15_000;
				expire?.();
			}
			grant.resolve();
			expect(await bounded(pending)).toBe(0);
			expect(await bounded(queued)).toBe(0);
			await bounded(settled.promise);
			expect(await fs.exists(`${log}.lock`)).toBe(false);
			expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
			expect(await index.checkpointLiveHeartbeats()).toBe(1);
			expect(locking).toHaveBeenCalledTimes(2);
		} finally {
			first.abort();
			second.abort();
			grant.resolve();
			locking.mockRestore();
			timers.mockRestore();
			clock.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not resurrect a state root removed during teardown", async () => {
		const { dir, index } = await fixture();
		await fs.rm(dir, { recursive: true, force: true });
		const locking = vi.spyOn(lockModule, "withFileLock");
		try {
			expect(await index.checkpointLiveHeartbeats()).toBe(0);
			expect(locking).not.toHaveBeenCalled();
			expect(await fs.exists(dir)).toBe(false);
		} finally {
			locking.mockRestore();
		}
	});

	it("discards replay that acknowledges after startup cancellation", async () => {
		const { dir, index, log } = await fixture();
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		const controller = new AbortController();
		const settled = Promise.withResolvers<void>();
		const realReadFile = fs.readFile;
		let replayRead = false;
		const reading = vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
			const result = await realReadFile(...args);
			if (String(args[0]) === log) {
				replayRead = true;
				controller.abort();
			}
			return result;
		}) as typeof fs.readFile);
		const realWithFileLock = lockModule.withFileLock;
		const locking = vi.spyOn(lockModule, "withFileLock").mockImplementation(async (file, callback, options) => {
			try {
				return await realWithFileLock(file, callback, options);
			} finally {
				settled.resolve();
			}
		});
		try {
			expect(await bounded(index.checkpointLiveHeartbeats(Date.now(), controller.signal))).toBe(0);
			await bounded(settled.promise);
			expect(replayRead).toBe(true);
			expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
			expect(await fs.exists(`${log}.lock`)).toBe(false);
		} finally {
			reading.mockRestore();
			locking.mockRestore();
			clock.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves retained removal-transition errors even at the deadline", async () => {
		const { dir, index, log } = await fixture();
		let elapsed = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const failure = new lockModule.FileLockAcquireError(
			log,
			`${log}.lock`,
			1,
			"retained transition",
			"orphan_transition",
			`${log}.lock.removing`,
		);
		const locking = vi.spyOn(lockModule, "withFileLock").mockImplementationOnce(async () => {
			elapsed = 15_000;
			throw failure;
		});
		try {
			await expect(index.checkpointLiveHeartbeats()).rejects.toBe(failure);
			expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
		} finally {
			locking.mockRestore();
			clock.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
