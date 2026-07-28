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
	#requestGates: Array<Promise<void>> = [];

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
	enqueueRequestGate(gate: Promise<void>): void {
		this.#requestGates.push(gate);
	}

	async request(frame: SdkFrame): Promise<SdkFrame> {
		this.requests.push({ ...frame });
		const connectionId = this.connectionId;
		const gate = this.#requestGates.shift();
		if (gate) await gate;
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
			const connectionId = typeof frame.connectionId === "string" ? frame.connectionId : this.connectionId;
			if (frame.type === "provider_heartbeat") {
				this.#runtime.heartbeat(connectionId, String(frame.leaseId));
			} else if (frame.type === "lease_release") {
				this.#runtime.release(connectionId, String(frame.leaseId));
			} else if (frame.type === "reverse_response") {
				this.#runtime.respond(
					connectionId,
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
		now: () => clock.now,
	});
	return { clock, runtime, client, controller };
}

const flush = async (): Promise<void> => {
	for (let index = 0; index < 8; index++) await Promise.resolve();
};

function requestFrame(
	id: string,
	connectionId: string,
	leaseId: string,
	payload: unknown,
	capability = "permission",
): SdkFrame {
	return {
		type: "reverse_request",
		id,
		connectionId,
		capability,
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

test("replay protection is bounded: an evicted id is re-executable after 1024 completions", async () => {
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
		const leaseId = controller.getLeaseId("permission")!;
		client.receive(requestFrame("replayed", "child-a", leaseId, { phase: "first" }));
		await flush();
		expect(handled).toBe(1);
		client.receive(requestFrame("replayed", "child-a", leaseId, { phase: "replay" }));
		await flush();
		expect(handled).toBe(1);

		for (let index = 0; index < 1_100; index++)
			client.receive(requestFrame(`bounded-${index}`, "child-a", leaseId, { phase: "many" }));
		await flush();
		const afterMany = handled;
		expect(controller.completedReverseRequestCount).toBe(1_024);
		client.receive(requestFrame("bounded-1099", "child-a", leaseId, { phase: "recent-replay" }));
		await flush();
		expect(handled).toBe(afterMany);
		// The oldest entry is evicted once the bounded ledger fills, proving it cannot grow without limit.
		client.receive(requestFrame("bounded-0", "child-a", leaseId, { phase: "evicted" }));
		await flush();
		expect(handled).toBe(afterMany + 1);
		expect(controller.completedReverseRequestCount).toBe(1_024);
	} finally {
		await controller.close();
	}
});

test("does not send a response after lease expiry, while a live lease still responds", async () => {
	let resolveExpired!: (value: unknown) => void;
	const expiredResult = new Promise(resolve => {
		resolveExpired = resolve;
	});
	const provider: ReverseLeaseProvider = {
		capability: "permission",
		definitions: [{ name: "approve" }],
		handle: async (_method, payload) => {
			if (record(payload)?.phase === "expired") return await expiredResult;
			return { approved: true };
		},
	};
	const { clock, controller, client, runtime } = fixture(provider, { heartbeatMs: 1_000_000 });
	try {
		await controller.start();
		const expiredLeaseId = controller.getLeaseId("permission")!;
		client.receive(requestFrame("expired-response", "child-a", expiredLeaseId, { phase: "expired" }));
		await flush();
		clock.advanceBy(LEASE_TTL_MS + 1);
		resolveExpired({ approved: false });
		await flush();
		expect(
			client.sent.filter(frame => frame.type === "reverse_response" && frame.id === "expired-response"),
		).toHaveLength(0);

		client.reconnect("child-b");
		await flush();
		const liveLeaseId = controller.getLeaseId("permission")!;
		const live = runtime.request("permission", "approve", { phase: "live" });
		await expect(live).resolves.toEqual({ approved: true });
		expect(client.sent).toContainEqual(
			expect.objectContaining({ type: "reverse_response", leaseId: liveLeaseId, ok: true }),
		);
	} finally {
		await controller.close();
		runtime.dispose();
	}
});

test("refuses a stale expected lease registration from a superseded connection", async () => {
	let releaseRegistration!: () => void;
	const registrationGate = new Promise<void>(resolve => {
		releaseRegistration = resolve;
	});
	const provider: ReverseLeaseProvider = { capability: "permission", definitions: [{ name: "approve" }] };
	const { controller, client, runtime } = fixture(provider, { heartbeatMs: 1_000_000 });
	try {
		await controller.start();
		const leaseId = controller.getLeaseId("permission")!;
		runtime.disconnect("child-a");
		client.enqueueRequestGate(registrationGate);
		client.reconnect("child-b");
		await flush();
		client.reconnect("child-c");
		releaseRegistration();
		await flush();
		expect(runtime.getLease("permission")?.connectionId).toBe("child-c");
		expect(client.sent).toContainEqual(
			expect.objectContaining({ type: "lease_release", connectionId: "child-b", leaseId }),
		);
	} finally {
		await controller.close();
		runtime.dispose();
	}
});

test("close fences in-flight reclaim and an immediate start-close race", async () => {
	let releaseRegistration!: () => void;
	const registrationGate = new Promise<void>(resolve => {
		releaseRegistration = resolve;
	});
	const provider: ReverseLeaseProvider = { capability: "permission", definitions: [{ name: "approve" }] };
	const first = fixture(provider, { heartbeatMs: 1_000_000 });
	try {
		await first.controller.start();
		first.runtime.disconnect("child-a");
		first.client.enqueueRequestGate(registrationGate);
		first.client.reconnect("child-b");
		await flush();
		const closing = first.controller.close();
		releaseRegistration();
		await closing;
		await flush();
		expect(first.runtime.getLease("permission")).toBeUndefined();
		expect(first.client.closed).toBe(true);
	} finally {
		first.runtime.dispose();
	}

	const second = fixture(provider, { heartbeatMs: 1_000_000 });
	try {
		const starting = second.controller.start();
		await second.controller.close();
		await expect(starting).rejects.toMatchObject({ code: "controller_closed" });
		expect(second.runtime.getLease("permission")).toBeUndefined();
	} finally {
		second.runtime.dispose();
	}
});

test("does not route a capability-A provider request sent for capability B", async () => {
	let handled = 0;
	const provider: ReverseLeaseProvider = {
		capability: "capability-a",
		definitions: [{ name: "approve" }],
		handle: async () => {
			handled += 1;
			return { approved: true };
		},
	};
	const { controller, client } = fixture(provider, { heartbeatMs: 1_000_000 });
	try {
		await controller.start();
		const leaseId = controller.getLeaseId("capability-a")!;
		client.receive(
			requestFrame("capability-mismatch", "child-a", leaseId, { phase: "wrong-capability" }, "capability-b"),
		);
		await flush();
		expect(handled).toBe(0);
		expect(client.sent.filter(frame => frame.id === "capability-mismatch")).toHaveLength(0);
	} finally {
		await controller.close();
	}
});
