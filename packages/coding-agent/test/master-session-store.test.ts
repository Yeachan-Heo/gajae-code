import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertAuthorityFingerprint,
	assertCanonicalCoordinatorWorkdir,
	freezeCoordinatorAuthority,
	verifyCoordinatorAuthority,
} from "../src/master/authority";
import { ClaimAuthorizationStore } from "../src/master/claim-authorizations";
import { type CoordinatorCallTarget, MasterCoordinatorGateway } from "../src/master/coordinator-gateway";
import { MasterDomainStore } from "../src/master/domain-store";
import { OwnershipLedger } from "../src/master/ownership";
import {
	assertCanonicalMasterName,
	getMasterPaths,
	getMasterRootDir,
	isCanonicalMasterName,
} from "../src/master/paths";
import { canAdmitWorker, selectNextTask, validateQueueSummary } from "../src/master/queue";
import type { TaskRecord } from "../src/master/types";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-master-store-"));
	roots.push(root);
	return path.join(root, "master");
}

async function makeStore(name = "alpha", maxConcurrentWorkers?: number): Promise<MasterDomainStore> {
	const masterRootDir = await makeRoot();
	return await MasterDomainStore.create({
		masterName: name,
		masterRootDir,
		maxConcurrentWorkers,
		defaultWorkdir: process.cwd(),
	});
}

afterEach(async () => {
	while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

describe("master durable paths and records", () => {
	test("uses canonical names and confines every path below the master root", async () => {
		expect(isCanonicalMasterName("alpha-1")).toBe(true);
		expect(isCanonicalMasterName("Alpha")).toBe(false);
		expect(isCanonicalMasterName("../escape")).toBe(false);
		expect(() => assertCanonicalMasterName("../escape")).toThrow();
		const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-config-root-"));
		roots.push(configRoot);
		const root = getMasterRootDir(configRoot);
		const paths = getMasterPaths("alpha", { configRootDir: configRoot });
		expect(paths.root).toBe(root);
		for (const [key, value] of Object.entries(paths)) {
			if (key === "masterName" || typeof value !== "string") continue;
			expect(
				path.resolve(value).startsWith(`${path.resolve(root)}${path.sep}`) ||
					path.resolve(value) === path.resolve(root),
			).toBe(true);
		}
	}, 30_000);

	test("writes private versioned records and fails closed on future data", async () => {
		const store = await makeStore();
		const record = await store.readRecord();
		expect(record.version).toBe(1);
		expect(record.maxConcurrentWorkers).toBe(3);
		const stat = await fs.stat(store.paths.recordPath);
		expect(stat.mode & 0o777).toBe(0o600);
		await fs.writeFile(store.paths.recordPath, JSON.stringify({ ...record, version: 2 }));
		await expect(
			MasterDomainStore.open({ masterName: "alpha", masterRootDir: store.masterRootDir }),
		).rejects.toThrow();
	}, 30_000);
});

describe("master queue and durable capacity", () => {
	test("orders urgent, user, autonomous tasks with persisted FIFO fairness", async () => {
		const store = await makeStore("fair", 1);
		const tasks: TaskRecord[] = [];
		for (let index = 0; index < 4; index += 1) {
			const receipt = await store.enqueueUser({
				idempotencyKey: `u-${index}`,
				priority: "user",
				summary: `user ${index}`,
			});
			const queue = await store.readQueue();
			tasks.push(queue.tasks.find(task => task.taskId === receipt.taskId)!);
		}
		await store.enqueueAutonomous({ idempotencyKey: "auto-1", summary: "autonomous" });
		const urgent = await store.enqueueUser({ idempotencyKey: "urgent", priority: "urgent_user", summary: "urgent" });
		const first = await store.admitNextTask();

		expect(first?.taskId).toBe(urgent.taskId);
		await store.releaseWorker({ leaseId: first!.leaseId });
		for (let index = 0; index < 3; index += 1) {
			const lease = await store.admitNextTask();

			expect(lease?.taskId).toBe(tasks[index]!.taskId);
			await store.releaseWorker({ leaseId: lease!.leaseId });
		}
		const fairLease = await store.admitNextTask();

		const queue = await store.readQueue();
		expect(queue.tasks.find(task => task.taskId === fairLease?.taskId)?.priority).toBe("autonomous");
		validateQueueSummary(await store.readQueueSummary());
	}, 30_000);

	test("keeps independent leases while draining 3 to 1 and recovers releases", async () => {
		const store = await makeStore("drain", 3);
		for (let index = 0; index < 4; index += 1)
			await store.enqueueUser({ idempotencyKey: `task-${index}`, priority: "user", summary: `task ${index}` });
		const leases = [
			await store.admitNextTask(),

			await store.admitNextTask(),

			await store.admitNextTask(),
		];
		expect(leases.every(lease => lease !== null)).toBe(true);
		const configured = await store.configureMaxConcurrentWorkers(1);
		expect(configured.capacityState).toBe("draining_over_capacity");
		const restarted = await MasterDomainStore.open({ masterName: "drain", masterRootDir: store.masterRootDir });
		expect((await restarted.readQueueSummary()).capacityState).toBe("draining_over_capacity");
		expect(await restarted.admitNextTask()).toBeNull();
		await restarted.releaseWorker({ leaseId: leases[0]!.leaseId });
		expect((await restarted.readQueueSummary()).activeWorkerCount).toBe(2);
		await restarted.releaseWorker({ leaseId: leases[1]!.leaseId });
		expect((await restarted.readQueueSummary()).activeWorkerCount).toBe(1);
		expect((await restarted.readQueueSummary()).capacityState).toBe("within_limit");
		expect(await restarted.admitNextTask()).toBeNull();
		await restarted.releaseWorker({ leaseId: leases[2]!.leaseId });
		const available = await restarted.admitNextTask();

		expect(available).not.toBeNull();
	}, 30_000);

	test("makes enqueue and terminal release idempotent and keeps contiguous events", async () => {
		const store = await makeStore("idempotent", 2);
		const first = await store.enqueueUser({ idempotencyKey: "same", priority: "user", summary: "same body" });
		const replay = await store.enqueueUser({ idempotencyKey: "same", priority: "user", summary: "same body" });
		expect(replay).toEqual({ ...first, idempotent: true });
		await expect(
			store.enqueueUser({ idempotencyKey: "same", priority: "user", summary: "different body" }),
		).rejects.toThrow();
		const lease = await store.admitNextTask();
		const released = await store.releaseWorker({ leaseId: lease!.leaseId });
		const replayedRelease = await store.releaseWorker({ leaseId: lease!.leaseId });
		expect(replayedRelease.alreadyReleased).toBe(true);
		expect(replayedRelease.leaseId).toBe(released.leaseId);
		const events = await store.readEvents();
		expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
		expect(await store.getEventSequence()).toBe(events.length);
	}, 30_000);
});

describe("intent-first independent worker lifecycle", () => {
	test("reserves independent capacity intents without inventing an owner or session", async () => {
		const store = await makeStore("intent", 2);
		await store.enqueueUser({ idempotencyKey: "intent-task-a", priority: "user", summary: "task a" });
		await store.enqueueUser({ idempotencyKey: "intent-task-b", priority: "user", summary: "task b" });
		const [first, second] = await Promise.all([
			store.admitNextTask({
				canonicalCwd: process.cwd(),
				createIdempotencyKey: "create-a",
				promptDigest: "a".repeat(64),
			}),
			store.admitNextTask({
				canonicalCwd: process.cwd(),
				createIdempotencyKey: "create-b",
				promptDigest: "b".repeat(64),
			}),
		]);
		expect(first?.intentId).not.toBe(second?.intentId);
		expect(first?.leaseId).not.toBe(second?.leaseId);
		expect(first?.workerSessionId).toBeNull();
		expect(second?.workerSessionId).toBeNull();
		expect((await store.readOwnership()).owners).toEqual({});
		expect((await store.readWorkerIntents()).map(intent => intent.createIdempotencyKey).sort()).toEqual([
			"create-a",
			"create-b",
		]);
	}, 30_000);

	test("reconciles actual Coordinator IDs, stable create retries, prompt ambiguity, and one-shot quarantine drain", async () => {
		const store = await makeStore("lifecycle");
		await store.enqueueUser({ idempotencyKey: "lifecycle-task", priority: "user", summary: "lifecycle task" });
		const lease = (await store.admitNextTask({
			createIdempotencyKey: "create-stable",
			promptDigest: "c".repeat(64),
		}))!;
		await store.reconcileCreate({ intentId: lease.intentId, outcome: "uncertain" });
		expect((await store.readWorkerIntent(lease.intentId))?.createIdempotencyKey).toBe("create-stable");
		const created = await store.reconcileCreate({ intentId: lease.intentId, sessionId: "coordinator-session-1" });
		expect(created.workerSessionId).toBe("coordinator-session-1");
		expect((await store.readOwnership()).owners["coordinator-session-1"]).toEqual({
			kind: "master",
			masterName: "lifecycle",
		});
		const quarantined = await store.observe({ workerSessionId: "coordinator-session-1", event: { action: "ask" } });
		expect(quarantined.disposition).toBe("quarantined");
		const pending = await store.markPromptPending({ intentId: lease.intentId });
		const ambiguous = await store.reconcilePrompt({
			intentId: lease.intentId,
			promptIdempotencyKey: pending.promptIdempotencyKey,
			proven: false,
		});
		expect(ambiguous.lifecycle).toBe("prompt_pending");
		expect((await store.markPromptPending({ intentId: lease.intentId })).promptIdempotencyKey).toBe(
			pending.promptIdempotencyKey,
		);
		const activated = await store.reconcilePrompt({
			intentId: lease.intentId,
			promptIdempotencyKey: pending.promptIdempotencyKey,
			proven: true,
		});
		expect(activated.lifecycle).toBe("active");
		expect(activated.drained).toHaveLength(1);
		expect(
			(
				await store.reconcilePrompt({
					intentId: lease.intentId,
					promptIdempotencyKey: pending.promptIdempotencyKey,
					proven: true,
				})
			).drained,
		).toHaveLength(0);
		expect(
			(await store.observe({ workerSessionId: "coordinator-session-1", event: { action: "idle" } })).disposition,
		).toBe("master");
	}, 30_000);

	test("recovers each worker independently, blocks authority mismatch, and preserves user ownership", async () => {
		const root = await makeRoot();
		const first = await MasterDomainStore.create({
			masterName: "authority",
			masterRootDir: root,
			defaultWorkdir: process.cwd(),
			authorityFingerprint: "1".repeat(64),
		});
		await first.enqueueUser({ idempotencyKey: "authority-task", priority: "user", summary: "authority task" });
		const lease = (await first.admitNextTask({
			createIdempotencyKey: "authority-create",
			promptDigest: "d".repeat(64),
		}))!;
		await first.reconcileCreate({ intentId: lease.intentId, workerSessionId: "authority-worker" });
		const restarted = await MasterDomainStore.open({
			masterName: "authority",
			masterRootDir: root,
			expectedAuthorityFingerprint: "1".repeat(64),
		});
		expect((await restarted.readWorkers()).workers[0]?.workerSessionId).toBe("authority-worker");
		await expect(
			MasterDomainStore.open({
				masterName: "authority",
				masterRootDir: root,
				expectedAuthorityFingerprint: "2".repeat(64),
			}),
		).rejects.toThrow(/authority/i);
		const user = await restarted.registerUserWorker("user-worker");
		expect(user.owner).toEqual({ kind: "user" });
		expect((await restarted.observe({ workerSessionId: "user-worker", event: { action: "ask" } })).disposition).toBe(
			"user",
		);
	}, 30_000);
});
describe("queue pure decisions", () => {
	test("requires strict below-limit admission and chooses urgent first", () => {
		expect(
			canAdmitWorker({
				queueRevision: 0,
				pendingCount: 0,
				activeWorkerCount: 0,
				maxConcurrentWorkers: 1,
				capacityState: "within_limit",
				userDispatchStreak: 0,
			}),
		).toBe(true);
		expect(
			canAdmitWorker({
				queueRevision: 0,
				pendingCount: 0,
				activeWorkerCount: 1,
				maxConcurrentWorkers: 1,
				capacityState: "within_limit",
				userDispatchStreak: 0,
			}),
		).toBe(false);
		const task = (priority: TaskRecord["priority"], enqueueSeq: number): TaskRecord => ({
			taskId: `task-${enqueueSeq}`,
			enqueueSeq,
			priority,
			source: priority === "autonomous" ? "master" : "user",
			state: "queued",
			attempt: 1,
			summary: priority,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			workerSessionId: null,
			idempotencyKey: `key-${enqueueSeq}`,
			bodyDigest: "0".repeat(64),
			leaseId: null,
			workdir: null,
		});
		expect(selectNextTask([task("user", 2), task("urgent_user", 3)], 0)?.priority).toBe("urgent_user");
	}, 30_000);
});

describe("master coordinator security boundaries", () => {
	test("freezes explicit authority and rejects missing, changed, outside, and symlink workdirs", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-root-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-outside-"));
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-state-"));
		roots.push(root, outside, stateRoot);
		const child = path.join(root, "child");
		await fs.mkdir(child);
		const linked = path.join(root, "linked");
		await fs.symlink(outside, linked, "dir");
		const env: NodeJS.ProcessEnv = {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
			GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
			GJC_COORDINATOR_MCP_PROFILE: "master",
			GJC_COORDINATOR_MCP_REPO: "repo",
		};
		const authority = await freezeCoordinatorAuthority(env);
		expect(authority.allowedRoots).toEqual([root]);
		expect(await assertCanonicalCoordinatorWorkdir(authority, child)).toBe(child);
		await expect(assertCanonicalCoordinatorWorkdir(authority, outside)).rejects.toThrow();
		await expect(assertCanonicalCoordinatorWorkdir(authority, linked)).rejects.toThrow();
		await expect(freezeCoordinatorAuthority({ ...env, GJC_COORDINATOR_MCP_WORKDIR_ROOTS: "" })).rejects.toThrow();
		await expect(freezeCoordinatorAuthority({ ...env, GJC_COORDINATOR_MCP_STATE_ROOT: "" })).rejects.toThrow();
		const changedStateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-state-changed-"));
		roots.push(changedStateRoot);
		expect(
			await verifyCoordinatorAuthority(authority, { ...env, GJC_COORDINATOR_MCP_STATE_ROOT: changedStateRoot }),
		).toBe(false);
		assertAuthorityFingerprint(authority, authority.fingerprint);
		expect(() => assertAuthorityFingerprint(authority, "forged")).toThrow();
	}, 30_000);

	test("gateway exposes only lifecycle calls, rejects authority input, and replays stable mutations", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-gateway-root-"));
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-gateway-state-"));
		roots.push(root, stateRoot);
		const env: NodeJS.ProcessEnv = {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
			GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
		};
		const authority = await freezeCoordinatorAuthority(env);
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const server: CoordinatorCallTarget = {
			callTool: async (name, args) => {
				calls.push({ name, args });
				return { ok: true, session_id: "worker-1" };
			},
		};
		const gateway = new MasterCoordinatorGateway(authority, server);
		await expect(gateway.callTool("gjc_coordinator_read_status", {})).rejects.toThrow();
		await expect(
			gateway.callTool("gjc_coordinator_start_session", {
				cwd: root,
				idempotency_key: "create-1",
				state_root: stateRoot,
			}),
		).rejects.toThrow();
		const first = await gateway.startSession({ cwd: root, idempotency_key: "create-1" });
		const replay = await gateway.startSession({ cwd: root, idempotency_key: "create-1" });
		expect(replay).toEqual(first);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual({ cwd: root, idempotency_key: "create-1", allow_mutation: true });
	}, 30_000);

	test("keeps one owner and fences pre-active worker events", () => {
		const ledger = new OwnershipLedger();
		const fence = ledger.beginWorker("worker-1", "alpha");
		expect(ledger.ownerCount("worker-1")).toBe(1);
		expect(ledger.recordWorkerEvent("worker-1", { action: "ask" }).disposition).toBe("quarantined");
		expect(ledger.activateWorker("worker-1")).toHaveLength(1);
		expect(ledger.recordWorkerEvent("worker-1", { action: "idle" }).disposition).toBe("master");
		expect(fence.drain()).toHaveLength(0);
		expect(() => ledger.assignOwner("worker-1", { kind: "user" })).toThrow();
		const userFence = ledger.registerUserWorker("worker-user");
		expect(ledger.recordWorkerEvent("worker-user", { action: "ask" }).disposition).toBe("user");
		expect(userFence.lifecycle).toBe("user_registered");
	}, 30_000);

	test("requires ingress authorization, one-time model consumption, and distinct authenticated approval", () => {
		let now = new Date("2026-08-10T00:00:00.000Z");
		const ledger = new OwnershipLedger();
		ledger.registerUserWorker("worker-claim");
		const store = new ClaimAuthorizationStore({ now: () => now, ownership: ledger, isBoundIngress: () => true });
		const requestIngress = {
			kind: "provider" as const,
			provider: "telegram" as const,
			channelId: "channel-1",
			messageId: "message-1",
			actorId: "actor-1",
		};
		const authorization = store.mint({
			workerSessionId: "worker-claim",
			requestedMasterName: "alpha",
			ingress: requestIngress,
		});
		const forged = { ...authorization, authorizationId: "forged" };
		expect(store.getAuthorization(forged.authorizationId)).toBeNull();
		expect(() =>
			store.consumeForModel({
				authorizationId: forged.authorizationId,
				workerSessionId: "worker-claim",
				requestedMasterName: "alpha",
			}),
		).toThrow();
		expect(() =>
			store.consumeForModel({
				authorizationId: authorization.authorizationId,
				workerSessionId: "other",
				requestedMasterName: "alpha",
			}),
		).toThrow();
		const claim = store.consumeForModel({
			authorizationId: authorization.authorizationId,
			workerSessionId: "worker-claim",
			requestedMasterName: "alpha",
		});
		expect(() =>
			store.consumeForModel({
				authorizationId: authorization.authorizationId,
				workerSessionId: "worker-claim",
				requestedMasterName: "alpha",
			}),
		).toThrow();
		const approvalIngress = { ...requestIngress, messageId: "message-2" };
		expect(() =>
			store.approveClaim({
				claimId: claim.claimId,
				ingress: approvalIngress,
				actorKind: "model",
				authenticated: true,
			}),
		).toThrow();
		expect(() =>
			store.approveClaim({
				claimId: claim.claimId,
				ingress: { ...approvalIngress, actorId: "other" },
				actorKind: "user",
				authenticated: true,
			}),
		).toThrow();
		const approved = store.approveClaim({
			claimId: claim.claimId,
			ingress: approvalIngress,
			actorKind: "user",
			authenticated: true,
			idempotencyKey: "approve-1",
		});
		expect(approved.status).toBe("approved");
		const replay = store.approveClaim({
			claimId: claim.claimId,
			ingress: approvalIngress,
			actorKind: "user",
			authenticated: true,
			idempotencyKey: "approve-1",
		});
		expect(replay.status).toBe("approved");
		const expired = store.mint({
			workerSessionId: "worker-claim",
			requestedMasterName: "alpha",
			ingress: { ...requestIngress, messageId: "message-3" },
			ttlMs: 1,
		});
		now = new Date("2026-08-10T00:00:01.000Z");
		expect(() =>
			store.consumeForModel({
				authorizationId: expired.authorizationId,
				workerSessionId: "worker-claim",
				requestedMasterName: "alpha",
			}),
		).toThrow();
	}, 30_000);
});

describe("explicit worker task admission", () => {
	test("admits exactly the requested task instead of the queue's own next selection", async () => {
		const store = await makeStore("requested", 3);
		const autonomous = await store.enqueueAutonomous({ idempotencyKey: "auto-req", summary: "autonomous work" });
		// Higher-priority work the queue would otherwise select first.
		const urgent = await store.enqueueUser({
			idempotencyKey: "urgent-req",
			priority: "urgent_user",
			summary: "urgent work",
		});
		expect(selectNextTask((await store.readQueue()).tasks, 0)?.taskId).toBe(urgent.taskId);

		const lease = await store.admitNextTask({
			taskId: autonomous.taskId,
			canonicalCwd: process.cwd(),
			createIdempotencyKey: "create-requested",
			promptDigest: "e".repeat(64),
		});

		expect(lease?.taskId).toBe(autonomous.taskId);
		const queue = await store.readQueue();
		expect(queue.tasks.find(task => task.taskId === urgent.taskId)?.state).toBe("queued");
	}, 30_000);

	test("replays the same lease for a retried explicit admission and rejects a switched task", async () => {
		const store = await makeStore("requested-replay", 3);
		const first = await store.enqueueUser({ idempotencyKey: "req-a", priority: "user", summary: "task a" });
		const second = await store.enqueueUser({ idempotencyKey: "req-b", priority: "user", summary: "task b" });
		const args = {
			canonicalCwd: process.cwd(),
			createIdempotencyKey: "create-replay",
			promptDigest: "f".repeat(64),
		};
		const lease = await store.admitNextTask({ ...args, taskId: second.taskId });
		expect(lease?.taskId).toBe(second.taskId);

		const replay = await store.admitNextTask({ ...args, taskId: second.taskId });
		expect(replay).toMatchObject({ leaseId: lease!.leaseId, taskId: second.taskId, idempotent: true });
		await expect(store.admitNextTask({ ...args, taskId: first.taskId })).rejects.toThrow();
	}, 30_000);

	test("refuses an unknown or already-leased task rather than silently picking another", async () => {
		const store = await makeStore("requested-invalid", 3);
		const task = await store.enqueueUser({ idempotencyKey: "req-only", priority: "user", summary: "only task" });
		await expect(
			store.admitNextTask({ taskId: "00000000-0000-4000-8000-000000000000", canonicalCwd: process.cwd() }),
		).rejects.toThrow();

		const lease = await store.admitNextTask({ taskId: task.taskId, canonicalCwd: process.cwd() });
		expect(lease?.taskId).toBe(task.taskId);
		// The task is no longer queued, so a second distinct admission must fail closed.
		await expect(
			store.admitNextTask({
				taskId: task.taskId,
				canonicalCwd: process.cwd(),
				createIdempotencyKey: "create-second",
			}),
		).rejects.toThrow();
	}, 30_000);
});
