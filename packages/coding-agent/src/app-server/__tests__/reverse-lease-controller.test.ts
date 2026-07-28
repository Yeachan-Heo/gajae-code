import { expect, test } from "bun:test";
import { ReverseLeaseRuntime } from "../../sdk/host";
import type { SdkFrame } from "../../sdk/host/types";
import {
	type ReverseLeaseClient,
	ReverseLeaseController,
	type ReverseLeaseProvider,
} from "../reverse-lease-controller";

const HEARTBEAT_MS = 5_000;
const LEASE_TTL_MS = 15_000;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

class FakeClock {
	now = 0;
	#nextId = 1;
	#tasks = new Map<number, { callback: () => void; due: number; interval: number }>();

	setInterval = (callback: () => void, milliseconds: number): number => {
		const id = this.#nextId++;
		this.#tasks.set(id, { callback, due: this.now + milliseconds, interval: milliseconds });
		return id;
	};

	clearInterval = (handle: unknown): void => {
		if (typeof handle === "number") this.#tasks.delete(handle);
	};

	advanceBy(milliseconds: number): void {
		this.advanceTo(this.now + milliseconds);
	}

	advanceTo(target: number): void {
		if (target < this.now) throw new Error("Fake clock cannot move backwards");
		for (;;) {
			const due = [...this.#tasks.entries()]
				.filter(([, task]) => task.due <= target)
				.sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
			if (!due) break;
			this.now = due[1].due;
			due[1].due += Math.max(1, due[1].interval);
			due[1].callback();
		}
		this.now = target;
	}
}

class FakeSdkClient implements ReverseLeaseClient {
	connectionId = "child-a";
	readonly requests: SdkFrame[] = [];
	readonly sent: SdkFrame[] = [];
	readonly sendErrors: unknown[] = [];
	closed = false;
	#runtime: ReverseLeaseRuntime;
	#frameHandlers = new Set<(frame: SdkFrame) => void>();
	#reconnectHandlers = new Set<() => void>();

	constructor(runtime: ReverseLeaseRuntime) {
		this.#runtime = runtime;
	}

	async connect(): Promise<void> {
		this.closed = false;
	}

	onFrame(handler: (frame: SdkFrame) => void): () => void {
		this.#frameHandlers.add(handler);
		return () => this.#frameHandlers.delete(handler);
	}

	onReconnect(handler: () => void): () => void {
		this.#reconnectHandlers.add(handler);
		return () => this.#reconnectHandlers.delete(handler);
	}

	async request(frame: SdkFrame): Promise<SdkFrame> {
		this.requests.push({ ...frame });
		const connectionId = this.connectionId;
		const lease = this.#runtime.registerProvider(
			connectionId,
			String(frame.capability),
			frame.definitions,
			typeof frame.expectedLeaseId === "string" ? frame.expectedLeaseId : undefined,
			typeof frame.idempotencyKey === "string" ? frame.idempotencyKey : undefined,
		);
		return {
			type: "register_provider_result",
			id: `register-${this.requests.length}`,
			leaseId: lease.leaseId,
			leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
		};
	}

	send(frame: SdkFrame): void {
		this.sent.push({ ...frame });
		try {
			if (frame.type === "provider_heartbeat") {
				this.#runtime.heartbeat(this.connectionId, String(frame.leaseId));
			} else if (frame.type === "lease_release") {
				this.#runtime.release(this.connectionId, String(frame.leaseId));
			} else if (frame.type === "reverse_response") {
				this.#runtime.respond(
					this.connectionId,
					String(frame.id),
					String(frame.leaseId),
					frame.ok === true ? frame.result : undefined,
					frame.ok === false && frame.error && typeof frame.error === "object"
						? (frame.error as { code: string; message: string })
						: undefined,
				);
			}
		} catch (error) {
			this.sendErrors.push(error);
		}
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	reconnect(connectionId: string): void {
		this.connectionId = connectionId;
		this.receive({ type: "hello", connectionId });
		for (const handler of this.#reconnectHandlers) handler();
	}

	receive(frame: SdkFrame): void {
		for (const handler of this.#frameHandlers) handler(frame);
	}
}

interface Fixture {
	clock: FakeClock;
	runtime: ReverseLeaseRuntime;
	client: FakeSdkClient;
	controller: ReverseLeaseController;
}

function fixture(provider: ReverseLeaseProvider, options: { heartbeatMs?: number } = {}): Fixture {
	const clock = new FakeClock();
	let client!: FakeSdkClient;
	const runtime = new ReverseLeaseRuntime({
		now: () => clock.now,
		leaseTtlMs: LEASE_TTL_MS,
		sendFrame: (_connectionId, frame) => client.receive(frame),
	});
	client = new FakeSdkClient(runtime);
	const controller = new ReverseLeaseController({
		client,
		providers: [provider],
		heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
	});
	return { clock, runtime, client, controller };
}

const flush = async (): Promise<void> => {
	for (let index = 0; index < 8; index++) await Promise.resolve();
};

function requestFrame(id: string, connectionId: string, leaseId: string, payload: unknown): SdkFrame {
	return {
		type: "reverse_request",
		id,
		connectionId,
		capability: "permission",
		leaseId,
		payload: { method: "approve", payload },
	};
}

test("registers one provider with a stable idempotency key", async () => {
	const provider: ReverseLeaseProvider = { capability: "permission", definitions: [{ name: "approve" }] };
	const { controller, client, runtime } = fixture(provider);
	try {
		await controller.start();
		expect(client.requests).toHaveLength(1);
		expect(client.requests[0]).toMatchObject({
			type: "register_provider",
			connectionId: "child-a",
			capability: "permission",
			definitions: [{ name: "approve" }],
			idempotencyKey: expect.any(String),
		});
		expect(controller.getLeaseId("permission")).toBe(runtime.getLease("permission")?.leaseId);
	} finally {
		await controller.close();
		runtime.dispose();
	}
});

test("heartbeats every 5s and keeps the 15s lease live under fake time", async () => {
	const provider: ReverseLeaseProvider = { capability: "permission", definitions: [{ name: "approve" }] };
	const { clock, controller, client, runtime } = fixture(provider);
	try {
		await controller.start();
		const initialLease = runtime.getLease("permission")!;
		clock.advanceBy(HEARTBEAT_MS - 1);
		await flush();
		expect(client.sent.filter(frame => frame.type === "provider_heartbeat")).toHaveLength(0);
		clock.advanceBy(1);
		await flush();
		expect(client.sent.filter(frame => frame.type === "provider_heartbeat")).toHaveLength(1);
		expect(runtime.getLease("permission")!.expiresAt).toBe(clock.now + LEASE_TTL_MS);
		clock.advanceBy(10_000);
		await flush();
		expect(client.sent.filter(frame => frame.type === "provider_heartbeat")).toHaveLength(3);
		expect(runtime.getInstalledDefinitions("permission")).toEqual([{ name: "approve" }]);
		expect(runtime.getLease("permission")!.expiresAt).toBe(clock.now + LEASE_TTL_MS);
		expect(runtime.getLease("permission")!.expiresAt).toBeGreaterThan(initialLease.expiresAt);
	} finally {
		await controller.close();
		runtime.dispose();
	}
});

test("reclaims on reconnect with expectedLeaseId and repeated idempotency", async () => {
	const provider: ReverseLeaseProvider = { capability: "permission", definitions: [{ name: "approve" }] };
	const { controller, client, runtime } = fixture(provider, { heartbeatMs: 1_000_000 });
	try {
		await controller.start();
		const first = client.requests[0];
		const firstLeaseId = controller.getLeaseId("permission")!;
		runtime.disconnect("child-a");
		client.reconnect("child-b");
		await flush();
		const reclaimed = client.requests[1];
		expect(reclaimed).toMatchObject({
			connectionId: "child-b",
			expectedLeaseId: firstLeaseId,
			idempotencyKey: first.idempotencyKey,
		});
		expect(controller.getLeaseId("permission")).toBe(firstLeaseId);
		client.reconnect("child-b");
		await flush();
		expect(client.requests[2]).toMatchObject({
			connectionId: "child-b",
			expectedLeaseId: firstLeaseId,
			idempotencyKey: first.idempotencyKey,
		});
		expect(controller.getLeaseId("permission")).toBe(firstLeaseId);
	} finally {
		await controller.close();
		runtime.dispose();
	}
});

test("does not settle a stale reverse response, while the current lease settles", async () => {
	let resolveOld!: (value: unknown) => void;
	const oldResult = new Promise(resolve => {
		resolveOld = resolve;
	});
	const provider: ReverseLeaseProvider = {
		capability: "permission",
		definitions: [{ name: "approve" }],
		handle: async (_method, payload) => {
			const phase = record(payload)?.phase;
			if (phase === "old") return await oldResult;
			return { approved: true };
		},
	};
	const { clock, controller, client, runtime } = fixture(provider, { heartbeatMs: 1_000_000 });
	try {
		await controller.start();
		const staleLeaseId = controller.getLeaseId("permission")!;
		client.receive(requestFrame("stale-request", "child-a", staleLeaseId, { phase: "old" }));
		await flush();
		runtime.disconnect("child-a");
		clock.advanceBy(LEASE_TTL_MS + 1);
		client.reconnect("child-b");
		await flush();
		const currentLeaseId = controller.getLeaseId("permission")!;
		expect(currentLeaseId).not.toBe(staleLeaseId);
		resolveOld({ approved: false });
		await flush();
		expect(
			client.sent.filter(frame => frame.type === "reverse_response" && frame.id === "stale-request"),
		).toHaveLength(0);
		expect(client.sendErrors).toHaveLength(0);

		const current = runtime.request("permission", "approve", { phase: "current" });
		await expect(current).resolves.toEqual({ approved: true });
		expect(client.sent).toContainEqual(
			expect.objectContaining({
				type: "reverse_response",
				leaseId: currentLeaseId,
				ok: true,
			}),
		);
	} finally {
		await controller.close();
		runtime.dispose();
	}
});

test("releases every active lease before closing the child client", async () => {
	const provider: ReverseLeaseProvider = { capability: "permission", definitions: [{ name: "approve" }] };
	const { controller, client, runtime } = fixture(provider);
	try {
		await controller.start();
		await controller.shutdown();
		expect(client.sent).toContainEqual(expect.objectContaining({ type: "lease_release", connectionId: "child-a" }));
		expect(runtime.getLease("permission")).toBeUndefined();
		expect(client.closed).toBe(true);
	} finally {
		runtime.dispose();
	}
});

test("an unheartbeated lease expires after 15s and is reclaimed with a new lease", async () => {
	const provider: ReverseLeaseProvider = { capability: "permission", definitions: [{ name: "approve" }] };
	const { clock, controller, client, runtime } = fixture(provider, { heartbeatMs: 1_000_000 });
	try {
		await controller.start();
		const expiredLeaseId = controller.getLeaseId("permission")!;
		runtime.disconnect("child-a");
		clock.advanceBy(LEASE_TTL_MS + 1);
		expect(runtime.getInstalledDefinitions("permission")).toBeUndefined();
		expect(runtime.getLease("permission")).toBeUndefined();
		client.reconnect("child-b");
		await flush();
		expect(controller.getLeaseId("permission")).toBeDefined();
		expect(controller.getLeaseId("permission")).not.toBe(expiredLeaseId);
		expect(runtime.getInstalledDefinitions("permission")).toEqual([{ name: "approve" }]);
	} finally {
		await controller.close();
		runtime.dispose();
	}
});

test("drops an inbound reverse request bearing a lease this controller does not own", async () => {
	// The post-handler fence stops a stale response from settling, but an inbound frame carrying
	// a foreign lease must never reach the provider handler at all: running it would let another
	// connection's lease drive our approval logic.
	let handled = 0;
	const provider: ReverseLeaseProvider = {
		capability: "permission",
		definitions: [{ name: "approve" }],
		handle: async () => {
			handled += 1;
			return { approved: true };
		},
	};
	const { controller, client } = fixture(provider, { heartbeatMs: 1_000_000 });
	try {
		await controller.start();
		const ownLeaseId = controller.getLeaseId("permission")!;

		client.receive(requestFrame("foreign-lease", "child-a", `${ownLeaseId}-not-ours`, { phase: "current" }));
		await flush();
		expect(handled).toBe(0);
		expect(client.sent.filter(frame => frame.id === "foreign-lease")).toHaveLength(0);

		// A frame on the owned lease still reaches the handler, proving this is not a blanket drop.
		client.receive(requestFrame("owned-lease", "child-a", ownLeaseId, { phase: "current" }));
		await flush();
		expect(handled).toBe(1);
	} finally {
		await controller.close();
	}
});
