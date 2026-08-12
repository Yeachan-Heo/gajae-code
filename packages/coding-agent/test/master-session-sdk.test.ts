import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createUnavailableMemoryContract,
	DeterministicMemoryContract,
	MemoryConflictError,
	MemoryUnavailableError,
} from "../src/master/memory-contract";
import {
	MAX_MASTER_FRAME_BYTES,
	type MasterEventFrame,
	masterClientFrameSchema,
	masterEventFrameSchema,
	parseMasterClientFrame,
	parseMasterJsonFrame,
	providerEffectLeaseValidator,
	providerHealthValidator,
	queueStateSummarySchemaV1,
	serializeMasterFrame,
} from "../src/master/sdk-contract";
import {
	MASTER_SDK_DISCOVERY_DIRECTORY_MODE,
	MASTER_SDK_DISCOVERY_FILE_MODE,
	readMasterSdkDiscovery,
} from "../src/master/sdk-discovery";
import { connectMasterSdkClient, MasterSdkTransport } from "../src/master/sdk-transport";

const TS = "2026-08-10T00:00:00.000Z";
const QUEUE = {
	queueRevision: 0,
	pendingCount: 0,
	activeWorkerCount: 0,
	maxConcurrentWorkers: 3,
	capacityState: "within_limit" as const,
	userDispatchStreak: 0,
};
const TASK = {
	taskId: "task-1",
	enqueueSeq: 1,
	priority: "user" as const,
	source: "user" as const,
	state: "queued" as const,
	attempt: 1,
	summary: "one task",
	createdAt: TS,
	updatedAt: TS,
	workerSessionId: null,
};
const PROVIDERS = {
	configuredProviders: ["telegram"] as const,
	activeProviders: ["telegram"] as const,
	degradedProviders: [] as const,
	operational: true,
};

function event(
	type:
		| "queue_updated"
		| "ownership_updated"
		| "decision_logged"
		| "memory_activity"
		| "master_status"
		| "channel_updated",
	payload: unknown,
	seq = 1,
): unknown {
	return { protocolVersion: 1, seq, eventId: `event-${seq}`, masterName: "alpha", occurredAt: TS, type, payload };
}

function queueEvent(): unknown {
	return event("queue_updated", { action: "enqueued", cause: "user_ingress", task: TASK, queue: QUEUE });
}

function ownershipEvent(): unknown {
	return event("ownership_updated", {
		action: "owner_assigned",
		cause: "worker_created",
		workerSessionId: "worker-1",
		previousOwner: null,
		nextOwner: { kind: "master", masterName: "alpha" },
	});
}

function decisionEvent(): unknown {
	return event("decision_logged", {
		decisionId: "decision-1",
		trigger: { kind: "task_dispatch", taskId: "task-1" },
		outcome: "assigned",
		reason: "assigned to a worker",
		doctrine: { revision: "rev-1", sha256: "a".repeat(64) },
		memory: { availability: "unavailable", activityIds: [] },
	});
}

function memoryEvent(): unknown {
	return event("memory_activity", {
		activity: {
			activityId: "activity-1",
			operation: "read",
			scope: "global",
			masterName: "alpha",
			summary: "memory read",
			occurredAt: TS,
		},
	});
}

function statusEvent(): unknown {
	return event("master_status", {
		transition: "state_changed",
		previousStatus: "starting",
		status: "idle",
		reason: "boot",
		providers: PROVIDERS,
	});
}

function channelEvent(): unknown {
	return event("channel_updated", {
		transition: "provider_degraded",
		provider: "telegram",
		bindingId: "binding-1",
		state: "active",
		deliveryHealth: "degraded",
		activeProviderCount: 1,
		degradedProviderCount: 1,
		pendingPresentationCount: 1,
		reason: "presentation_pending",
	});
}

describe("master SDK v1 contract", () => {
	it("parses all correlated event branches and rejects cross-pairs", () => {
		const valid = [queueEvent(), ownershipEvent(), decisionEvent(), memoryEvent(), statusEvent(), channelEvent()];
		for (const frame of valid) expect(masterEventFrameSchema.safeParse(frame).success).toBe(true);
		const pairs = [
			"queue_updated",
			"ownership_updated",
			"decision_logged",
			"memory_activity",
			"master_status",
			"channel_updated",
		] as const;
		for (const type of pairs) {
			for (const payload of valid) {
				const candidate = { ...(payload as Record<string, unknown>), type };
				const expected = (payload as { type: string }).type === type;
				expect(masterEventFrameSchema.safeParse(candidate).success).toBe(expected);
			}
		}
	}, 30_000);

	it("enforces UTF-8, ASCII, numeric, queue, provider, and retry bounds", () => {
		expect(queueStateSummarySchemaV1.safeParse(QUEUE).success).toBe(true);
		expect(queueStateSummarySchemaV1.safeParse({ ...QUEUE, maxConcurrentWorkers: 0 }).success).toBe(false);
		expect(
			queueStateSummarySchemaV1.safeParse({ ...QUEUE, activeWorkerCount: 4, capacityState: "within_limit" }).success,
		).toBe(false);
		expect(
			queueStateSummarySchemaV1.safeParse({
				...QUEUE,
				activeWorkerCount: 4,
				capacityState: "draining_over_capacity",
			}).success,
		).toBe(true);
		expect(providerHealthValidator.safeParse(PROVIDERS).success).toBe(true);
		expect(providerHealthValidator.safeParse({ ...PROVIDERS, activeProviders: ["discord"] }).success).toBe(false);
		expect(masterClientFrameSchema.safeParse({ type: "ping", requestId: "r1", nonce: "n1" }).success).toBe(true);
		expect(masterClientFrameSchema.safeParse({ type: "ping", requestId: "", nonce: "n1" }).success).toBe(false);
		expect(
			masterClientFrameSchema.safeParse({
				type: "get_queue_page",
				requestId: "r1",
				masterName: "alpha",
				cursor: null,
				limit: 1,
			}).success,
		).toBe(true);
		expect(
			masterClientFrameSchema.safeParse({
				type: "get_queue_page",
				requestId: "r1",
				masterName: "alpha",
				cursor: null,
				limit: 51,
			}).success,
		).toBe(false);
		expect(
			masterClientFrameSchema.safeParse({
				type: "master_user_message",
				requestId: "r1",
				idempotencyKey: "k1",
				masterName: "alpha",
				text: "é".repeat(16_384),
				urgency: "user",
				workdir: null,
				ingress: { kind: "local", actorId: "actor-1", sourceId: "source-1" },
			}).success,
		).toBe(false);
	}, 30_000);

	it("enforces effect lease correlation shapes and strict unknown fields", () => {
		const lease = {
			effectId: "effect-1",
			intentId: "intent-1",
			leaseId: "lease-1",
			masterName: "alpha",
			provider: "telegram",
			fence: 0,
			nonce: "nonce-1",
			expiresAt: TS,
			kind: "present_event",
			eventId: "event-1",
			bindingId: "binding-1",
			content: { text: "hello", workerSessionId: null, taskId: null, decisionId: null, memoryActivityId: null },
		};
		expect(providerEffectLeaseValidator.safeParse(lease).success).toBe(true);
		expect(providerEffectLeaseValidator.safeParse({ ...lease, unexpected: true }).success).toBe(false);
		expect(
			providerEffectLeaseValidator.safeParse({
				effectId: lease.effectId,
				intentId: lease.intentId,
				leaseId: lease.leaseId,
				masterName: lease.masterName,
				provider: lease.provider,
				fence: lease.fence,
				nonce: lease.nonce,
				expiresAt: lease.expiresAt,
				kind: "provision_channel",
				operation: "create",
				channelName: "Master · alpha",
				previousRemoteChannelId: null,
			}).success,
		).toBe(true);
	}, 30_000);

	it("enforces the pre-parse frame byte ceiling", () => {
		const frame = { type: "ping", requestId: "r1", nonce: "n1" } as const;
		expect(parseMasterClientFrame(frame)).toEqual(frame);
		const oversized = `{"type":"ping","requestId":"r1","nonce":"${"x".repeat(MAX_MASTER_FRAME_BYTES)}"}`;
		expect(() => parseMasterJsonFrame(oversized, "client")).toThrow();
		expect(serializeMasterFrame(frame, "client")).toContain("ping");
	}, 30_000);
});

describe("MemoryContract", () => {
	it("provides deterministic read/write activity and idempotence", async () => {
		const memory = new DeterministicMemoryContract({ clock: () => new Date(0), idFactory: () => "entry-1" });
		const activities: string[] = [];
		const unsubscribe = memory.subscribe(activity => activities.push(activity.operation));
		const receipt = await memory.write({
			scope: "global",
			content: "lesson",
			tags: ["task"],
			source: { masterName: "alpha", taskId: "task-1" },
			idempotencyKey: "write-1",
		});
		expect(
			await memory.write({
				scope: "global",
				content: "lesson",
				tags: ["task"],
				source: { masterName: "alpha", taskId: "task-1" },
				idempotencyKey: "write-1",
			}),
		).toEqual(receipt);
		expect(
			(
				await memory.read({
					scope: "global",
					query: "less",
					limit: 1,
					context: { masterName: "alpha", taskId: "task-1" },
				})
			).entries[0]?.id,
		).toBe("entry-1");
		expect(activities).toEqual(["write", "read"]);
		unsubscribe();
		await expect(
			memory.write({
				scope: "global",
				content: "different",
				tags: [],
				source: { masterName: "alpha" },
				idempotencyKey: "write-1",
			}),
		).rejects.toBeInstanceOf(MemoryConflictError);
	}, 30_000);

	it("makes unavailable memory explicit and nonblocking to callers", async () => {
		const memory = createUnavailableMemoryContract();
		await expect(
			memory.read({ scope: "global", query: "x", limit: 1, context: { masterName: "alpha" } }),
		).rejects.toBeInstanceOf(MemoryUnavailableError);
		await expect(
			memory.write({
				scope: "global",
				content: "x",
				tags: [],
				source: { masterName: "alpha" },
				idempotencyKey: "k",
			}),
		).rejects.toBeInstanceOf(MemoryUnavailableError);
	}, 30_000);
});

describe("master SDK discovery and transport lifecycle", () => {
	it("publishes private discovery and removes it after socket shutdown", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".master-sdk-test-"));
		const transport = new MasterSdkTransport({ masterRootDir: root, token: "test-token", port: 0 });
		try {
			const discovery = await transport.start();
			const record = await readMasterSdkDiscovery({ masterRootDir: root });
			expect(record).toEqual(discovery);
			const directoryMode =
				(await fs.stat(path.dirname(record ? path.join(root, "sdk", "master-daemon.json") : root))).mode & 0o777;
			expect(directoryMode).toBe(MASTER_SDK_DISCOVERY_DIRECTORY_MODE);
			const fileMode = (await fs.stat(path.join(root, "sdk", "master-daemon.json"))).mode & 0o777;
			expect(fileMode).toBe(MASTER_SDK_DISCOVERY_FILE_MODE);
			const client = await connectMasterSdkClient({ url: discovery.url, token: discovery.token });
			expect((await client.ping("ping-1", "nonce-1")).type).toBe("pong");
			await client.close();
		} finally {
			await transport.stop();
			expect(await readMasterSdkDiscovery({ masterRootDir: root })).toBeNull();
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("publishes snapshot/replay events and page responses with correlated ids", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".master-sdk-test-"));
		const transport = new MasterSdkTransport({
			masterRootDir: root,
			token: "test-token",
			port: 0,
			maxRetainedEvents: 8,
			getSnapshot: () => [],
			getQueuePage: frame => ({
				masterName: frame.masterName,
				snapshotCutSeq: 1,
				queueRevision: 0,
				items: [],
				nextCursor: null,
			}),
		});
		try {
			const discovery = await transport.start();
			transport.publishEvent(queueEvent() as MasterEventFrame);
			const client = await connectMasterSdkClient({ url: discovery.url, token: discovery.token });
			const ready = await client.subscribe("subscribe-1");
			expect(ready.type).toBe("subscription_ready");
			const page = await client.getQueuePage("page-1", "alpha", null, 1);
			expect(page.type).toBe("queue_page");
			await client.close();
		} finally {
			await transport.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
