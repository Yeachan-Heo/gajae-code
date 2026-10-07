import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as lockModule from "../src/config/file-lock";
import { Broker } from "../src/sdk/broker/broker";
import { brokerDiscoveryPath, readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SessionIndex } from "../src/sdk/broker/session-index";

describe("broker startup heartbeat budget", () => {
	it("does not publish while the checkpoint transaction is still holding the index lock", async () => {
		const dir = await fs.mkdtemp(path.join("/private/tmp", "gjc-startup-heartbeat-settlement-"));
		const index = await new SessionIndex(dir).open();
		await index.append({
			type: "host_registered",
			sessionId: "settlement-host",
			locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
			endpointGeneration: 1,
			pid: process.pid,
		});
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const realWithFileLock = lockModule.withFileLock;
		const locking = vi.spyOn(lockModule, "withFileLock").mockImplementation(async (file, callback, options) => {
			if (file !== log || !options?.signal) return await realWithFileLock(file, callback, options);
			try {
				return await realWithFileLock(
					file,
					async () => {
						entered.resolve();
						await release.promise;
						return await callback();
					},
					options,
				);
			} finally {
				settled.resolve();
			}
		});
		let ready = false;
		const broker = new Broker({
			agentDir: dir,
			port: 0,
			startupCheckpointDeadline: performance.now() + 50,
			onStartupReady: () => {
				ready = true;
			},
		});
		const startup = broker.start();
		try {
			await entered.promise;
			await Bun.sleep(100);
			expect(ready).toBe(false);
			expect(await readBrokerDiscovery(dir)).toBeNull();
			release.resolve();
			await startup;
			expect(ready).toBe(true);
			expect((await readBrokerDiscovery(dir))?.ownerId).toBe(broker.discovery?.ownerId);
			await settled.promise;
		} finally {
			release.resolve();
			await settled.promise;
			await broker.stop();
			locking.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it.each([
		20_000, 11_200,
	])("publishes before its %i-ms fence despite repeated checkpoint contention", async startupDeadline => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-startup-heartbeat-budget-"));
		const index = await new SessionIndex(dir).open();
		await index.append({
			type: "host_registered",
			sessionId: "startup-host",
			locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
			endpointGeneration: 1,
			pid: process.pid,
		});
		const log = path.join(dir, "sdk", "sessions", "index.jsonl");
		let elapsed = 0;
		let acquisitions = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const realWithFileLock = lockModule.withFileLock;
		const locking = vi.spyOn(lockModule, "withFileLock").mockImplementation(async (file, callback, options) => {
			if (file !== log || !options?.signal) return await realWithFileLock(file, callback, options);
			const holderMs = [10_000, 10_500][acquisitions++] ?? 0;
			const waitBudgetMs = (options.retries ?? 600) * (options.retryDelayMs ?? 100);
			if (holderMs >= waitBudgetMs) {
				elapsed += waitBudgetMs;
				throw new lockModule.FileLockAcquireError(file, `${file}.lock`, options.retries ?? 600, "live owner");
			}
			return await realWithFileLock(
				file,
				async () => {
					elapsed += holderMs;
					return await callback();
				},
				options,
			);
		});
		let ready = false;
		const broker = new Broker({
			agentDir: dir,
			port: 0,
			startupCheckpointDeadline: startupDeadline - 1_000,
			onStartupReady: () => {
				ready = true;
			},
		});
		try {
			const discovery = await broker.start();
			expect(ready).toBe(true);
			expect(elapsed).toBeLessThan(startupDeadline);
			expect(acquisitions).toBe(2);
			expect(discovery.port).toBeGreaterThan(0);
			expect((await readBrokerDiscovery(dir))?.ownerId).toBe(discovery.ownerId);
			expect(broker.index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
		} finally {
			await broker.stop();
			locking.mockRestore();
			clock.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("tears down its transport and discovery after cancellation before retained publication", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-startup-heartbeat-cancel-"));
		const controller = new AbortController();
		const broker = new Broker({
			agentDir: dir,
			port: 0,
			startupAbortSignal: controller.signal,
			startupAfterDiscoveryWriteTestHook: async () => {
				controller.abort();
			},
		});
		const successor = new Broker({ agentDir: dir, port: 0 });
		try {
			await expect(broker.start()).rejects.toThrow("interrupted before retained publication");
			expect(broker.discovery).toBeNull();
			expect(await fs.exists(brokerDiscoveryPath(dir))).toBe(false);
			const discovery = await successor.start();
			expect((await readBrokerDiscovery(dir))?.ownerId).toBe(discovery.ownerId);
		} finally {
			await successor.stop();
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
