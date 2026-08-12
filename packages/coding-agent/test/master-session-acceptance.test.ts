import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MasterCoordinatorGateway } from "../src/master/coordinator-gateway";
import { MasterDaemon } from "../src/master/daemon";
import { MasterDomainStore } from "../src/master/domain-store";
import { createDeterministicMemoryContract } from "../src/master/memory-contract";
import { MasterRuntime, type MasterRuntimeStore } from "../src/master/runtime";
import { MasterSdk } from "../src/master/sdk";
import { connectMasterSdkClient } from "../src/master/sdk-transport";
import type { MasterProvider } from "../src/master/types";
import { MasterWorkerObserver } from "../src/master/worker-observer";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-master-acceptance-"));
	roots.push(root);
	return root;
}

class FakeCoordinator {
	readonly starts: string[] = [];
	readonly prompts: string[] = [];
	#nextWorker = 1;

	async startSession(input: { idempotency_key: string }): Promise<Record<string, unknown>> {
		this.starts.push(input.idempotency_key);
		return { session_id: `worker-${this.#nextWorker++}` };
	}

	async sendPrompt(input: { session_id: string; idempotency_key: string }): Promise<Record<string, unknown>> {
		this.prompts.push(`${input.session_id}:${input.idempotency_key}`);
		return { turn_id: `turn-${this.prompts.length}`, delivered: true };
	}
}

function health(activeProviders: readonly MasterProvider[] = ["telegram"]): {
	configuredProviders: readonly MasterProvider[];
	activeProviders: readonly MasterProvider[];
	degradedProviders: readonly MasterProvider[];
	operational: boolean;
} {
	const degradedProviders = ["telegram", "discord"].filter(
		provider => !activeProviders.includes(provider as MasterProvider),
	) as MasterProvider[];
	return {
		configuredProviders: ["telegram", "discord"],
		activeProviders,
		degradedProviders,
		operational: activeProviders.length > 0,
	};
}

async function createStore(root: string, masterName: string): Promise<MasterDomainStore> {
	return await MasterDomainStore.create({
		masterName,
		masterRootDir: path.join(root, "master"),
		defaultWorkdir: root,
		maxConcurrentWorkers: 2,
		configuredProviders: ["telegram", "discord"],
	});
}

function userMessage(masterName: string, requestId: string, idempotencyKey: string, text: string) {
	return {
		type: "master_user_message" as const,
		requestId,
		idempotencyKey,
		masterName,
		text,
		urgency: "user" as const,
		workdir: null,
		ingress: { kind: "local" as const, actorId: "acceptance-user", sourceId: requestId },
	};
}

afterEach(async () => {
	while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

describe("managed master runtime acceptance", () => {
	test("restores isolated masters, schedules durable tasks, routes ownership, and recovers", async () => {
		const root = await tempRoot();
		const alpha = await createStore(root, "alpha");
		const beta = await createStore(root, "beta");
		const coordinator = new FakeCoordinator();
		let memoryWrites = 0;
		const memory = createDeterministicMemoryContract({ idFactory: () => `memory-${memoryWrites + 1}` });
		const originalWrite = memory.write.bind(memory);
		memory.write = async input => {
			memoryWrites += 1;
			return await originalWrite(input);
		};
		const promptCounts = new Map<string, number>();
		const factoryMasters: string[] = [];
		const sessionFactory = async (options: Record<string, unknown>) => {
			const masterName = String(options.masterName);
			factoryMasters.push(masterName);
			return {
				prompt: async () => {
					promptCounts.set(masterName, (promptCounts.get(masterName) ?? 0) + 1);
				},
				dispose: async () => {},
			};
		};
		const runtimeFactory = (masterName: string, store: MasterDomainStore | MasterRuntimeStore) => {
			if (!(store instanceof MasterDomainStore)) throw new Error("Acceptance runtime requires MasterDomainStore.");
			return new MasterRuntime({
				masterName,
				domainStore: store,
				coordinatorGateway: coordinator as unknown as MasterCoordinatorGateway,
				providerHealth: health(),
				memory,
				sessionFactory,
			});
		};
		const daemon = new MasterDaemon({
			stores: { alpha, beta },
			createRuntime: runtimeFactory,
			sdkOptions: { masterRootDir: path.join(root, "master"), publishDiscovery: false },
		});

		await daemon.start();
		expect((await daemon.status()).masterNames).toEqual(["alpha", "beta"]);
		expect(factoryMasters).toEqual([]);
		expect(coordinator.starts).toEqual([]);
		expect(coordinator.prompts).toEqual([]);
		expect(memoryWrites).toBe(0);
		expect((await daemon.getRuntime("alpha")!.statusSnapshot()).status).toBe("idle");

		const sdk = daemon.sdk;
		if (!sdk) throw new Error("Master SDK was not started.");
		const firstAck = await sdk.handleClientFrame(userMessage("alpha", "request-1", "task-key-1", "alpha task one"));
		expect(firstAck).toMatchObject({
			type: "ack",
			operation: "master_user_message",
			result: { kind: "task", state: "queued", enqueueSeq: 1 },
		});
		expect(coordinator.starts).toHaveLength(1);
		expect(coordinator.prompts).toHaveLength(1);
		expect(factoryMasters).toEqual(["alpha"]);
		expect((await beta.readQueue()).tasks).toHaveLength(0);

		const secondAck = await sdk.handleClientFrame(userMessage("alpha", "request-2", "task-key-2", "alpha task two"));
		expect(secondAck).toMatchObject({
			type: "ack",
			operation: "master_user_message",
			result: { kind: "task", state: "queued", enqueueSeq: 2 },
		});
		expect(coordinator.starts).toHaveLength(2);
		expect(coordinator.prompts).toHaveLength(2);
		expect((await alpha.readQueue()).activeWorkerCount).toBe(2);
		expect((await beta.readQueue()).activeWorkerCount).toBe(0);

		const alphaWorkers = await alpha.readWorkers();
		expect(alphaWorkers.workers.filter(worker => worker.workerSessionId !== null)).toHaveLength(2);
		for (const worker of alphaWorkers.workers) {
			if (!worker.workerSessionId) continue;
			const owner = await alpha.readOwnership();
			expect(owner.owners[worker.workerSessionId]).toEqual({ kind: "master", masterName: "alpha" });
		}

		await alpha.registerUserWorker("user-owned-worker");
		const userReceipt = await daemon
			.getRuntime("alpha")!
			.workerObserver.observe({ workerSessionId: "user-owned-worker", event: { kind: "idle" } });
		expect(userReceipt.disposition).toBe("user");
		expect(promptCounts.get("alpha")).toBeGreaterThanOrEqual(2);

		const client = await connectMasterSdkClient({ url: sdk.url, token: sdk.token });
		const replayed: number[] = [];
		const replayObserved = Promise.withResolvers<void>();
		const unsubscribe = client.onFrame(frame => {
			if ("seq" in frame && typeof frame.seq === "number") {
				replayed.push(frame.seq);
				replayObserved.resolve();
			}
		});
		const ready = await client.subscribe("replay-request", 0);
		expect(ready).toMatchObject({ type: "subscription_ready", requestId: "replay-request", mode: "replay" });
		await Promise.race([
			replayObserved.promise,
			Bun.sleep(1_000).then(() => {
				throw new Error("Timed out waiting for retained replay event.");
			}),
		]);
		expect(replayed.length).toBeGreaterThan(0);
		const page = await client.getQueuePage("page-request", "alpha", null, 1);
		expect(page).toMatchObject({
			type: "queue_page",
			requestId: "page-request",
			masterName: "alpha",
			queueRevision: expect.any(Number),
		});
		unsubscribe();
		await client.close();

		const tasks = (await alpha.readQueue()).tasks;
		const firstWorker = (await alpha.readWorkers()).workers.find(worker => worker.taskId === tasks[0]?.taskId);
		if (!firstWorker) throw new Error("Expected first worker lease.");
		await alpha.releaseWorker({ leaseId: firstWorker.leaseId, state: "completed" });
		await daemon.getRuntime("alpha")!.refreshFromStore();
		expect(memoryWrites).toBe(1);

		const stopped = await daemon.stop({ drain: true });
		expect(stopped.ok).toBe(true);
		expect((await daemon.status()).running).toBe(false);
		const restarted = new MasterDaemon({
			stores: { alpha, beta },
			createRuntime: runtimeFactory,
			sdkOptions: { masterRootDir: path.join(root, "master"), publishDiscovery: false },
		});
		await restarted.start();
		expect((await restarted.status()).masterNames).toEqual(["alpha", "beta"]);
		expect((await alpha.readWorkers()).workers.filter(worker => worker.workerSessionId !== null)).toHaveLength(2);
		expect(coordinator.starts).toHaveLength(2);
		await restarted.stop({ drain: true });
	}, 30_000);

	test("blocks turns with no active provider and never fabricates mutation acknowledgements", async () => {
		const root = await tempRoot();
		const store = await createStore(root, "blocked");
		let prompts = 0;
		const runtime = new MasterRuntime({
			masterName: "blocked",
			domainStore: store,
			providerHealth: health([]),
			sessionFactory: async () => ({
				prompt: async () => {
					prompts += 1;
				},
			}),
		});
		await runtime.start();
		await store.enqueueUser({
			idempotencyKey: "blocked-task",
			priority: "user",
			summary: "blocked task",
			workdir: null,
		});
		await runtime.refreshFromStore();
		expect(prompts).toBe(0);
		expect(runtime.statusValue).toBe("channel_blocked");

		const sdk = new MasterSdk({
			stores: { blocked: store },
			publishDiscovery: false,
			masterRootDir: path.join(root, "master"),
		});
		const response = await sdk.handleClientFrame(
			userMessage("missing", "missing-request", "missing-key", "must fail"),
		);
		expect(response).toMatchObject({ type: "error", requestId: "missing-request", code: "unknown_master" });
		expect((await store.readQueue()).tasks).toHaveLength(1);
	});
	test("bounds graceful stop when a master turn never settles", async () => {
		const root = await tempRoot();
		const store = await createStore(root, "hung");
		// A prompt that never resolves models a wedged model call or tool.
		const neverSettles = Promise.withResolvers<void>();
		const runtime = new MasterRuntime({
			masterName: "hung",
			domainStore: store,
			providerHealth: health(["telegram"]),
			sessionFactory: async () => ({ prompt: async () => await neverSettles.promise }),
		});
		await runtime.start();
		await store.enqueueUser({
			idempotencyKey: "hung-task",
			priority: "user",
			summary: "hung task",
			workdir: null,
		});
		// Drive a real trigger so the runtime enters a turn that can never complete.
		void runtime.refreshFromStore();
		await Bun.sleep(150);
		expect(runtime.statusValue).toBe("busy");

		const startedAt = Date.now();
		await runtime.stop({ drain: true, timeoutMs: 200 });
		const elapsed = Date.now() - startedAt;

		// Before the fix this awaited the same unsettled turn promise forever.
		expect(elapsed).toBeLessThan(5_000);
		// Let the abandoned turn unwind against a still-existing root before cleanup.
		neverSettles.resolve();
		await runtime.waitForIdle(2_000);
		await Bun.sleep(50);
	}, 20_000);
	test("observes the real Coordinator turn proven at dispatch, across a restart", async () => {
		const root = await tempRoot();
		const store = await createStore(root, "observed");
		const coordinator = new FakeCoordinator();
		const awaited: Array<Record<string, unknown>> = [];
		const gateway = {
			startSession: async (input: { cwd: string; idempotency_key: string }) => await coordinator.startSession(input),
			sendPrompt: async (input: { session_id: string; idempotency_key: string }) =>
				await coordinator.sendPrompt(input),
			awaitTurn: async (input: Record<string, unknown>) => {
				awaited.push(input);
				return { status: "completed", turn_id: input.turn_id, output: "done" };
			},
		} as unknown as MasterCoordinatorGateway;
		const runtime = new MasterRuntime({
			masterName: "observed",
			domainStore: store,
			coordinatorGateway: gateway,
			providerHealth: health(["telegram"]),
			sessionFactory: async () => ({ prompt: async () => undefined }),
		});
		await runtime.start();
		await store.enqueueUser({
			idempotencyKey: "observed-task",
			priority: "user",
			summary: "observed task",
			workdir: null,
		});
		await runtime.refreshFromStore();
		const worker = (await store.readWorkers()).workers.find(candidate => candidate.workerSessionId !== null);
		if (!worker?.workerSessionId) throw new Error("expected a dispatched worker");

		// The observer that dispatched the prompt must be the one the master tool uses.
		const receipt = await runtime.workerObserver.observeFromCoordinator({
			workerSessionId: worker.workerSessionId,
			action: "action_needed",
		});
		expect(receipt).toBeDefined();
		expect(awaited).toHaveLength(1);
		expect(awaited[0]).toMatchObject({ session_id: worker.workerSessionId, turn_id: "turn-1" });

		// The proven turn is durable, so a fresh observer (restart) still reads it.
		const reopened = await MasterDomainStore.open({
			masterName: "observed",
			masterRootDir: path.join(root, "master"),
			defaultWorkdir: root,
		});
		const restarted = new MasterWorkerObserver({
			masterName: "observed",
			domainStore: reopened,
			coordinatorGateway: gateway,
		});
		await restarted.observeFromCoordinator({ workerSessionId: worker.workerSessionId });
		expect(awaited).toHaveLength(2);
		expect(awaited[1]).toMatchObject({ session_id: worker.workerSessionId, turn_id: "turn-1" });
		await runtime.stop({ drain: true, timeoutMs: 500 });
	}, 30_000);
});
