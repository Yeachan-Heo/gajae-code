import { expect, test } from "bun:test";
import {
	DuplicateServerRequestError,
	ServerRequestBroker,
	type ServerRequestSettlement,
} from "../../server-requests/broker";

const approved = { decision: "approved" };
const denied = { decision: { denied: { rejection: "not allowed" } } };

function approval(
	broker: ServerRequestBroker,
	id = "request-1",
	connections = new Set(["connection-a", "connection-b"]),
) {
	const handle = broker.create(id, "execCommandApproval", {}, "thread-1", connections);
	if (!handle) throw new Error("Expected an approval handle.");
	return handle;
}

async function settlementCount(promise: Promise<ServerRequestSettlement>): Promise<{
	readonly get: () => number;
}> {
	let count = 0;
	void promise.then(() => {
		count++;
	});
	await Promise.resolve();
	return { get: () => count };
}

test("create returns a request handle and an awaitable settlement", async () => {
	const broker = new ServerRequestBroker();
	const handle = approval(broker);
	expect(handle.request).toBe(handle);
	expect(handle.status).toBe("pending");
	expect(handle.eligibleConnections).toEqual(new Set(["connection-a", "connection-b"]));
	expect(broker.pendingCount).toBe(1);
	broker.resolve(handle.id, "connection-a", approved);
	expect(await handle.settled).toEqual({ kind: "resolved", connectionId: "connection-a", result: approved });
});

test("create returns undefined when no eligible connections", () => {
	const broker = new ServerRequestBroker();
	expect(broker.create("request-1", "execCommandApproval", {}, "thread-1", new Set())).toBeUndefined();
});

test("duplicate ids are rejected without replacing the first in-flight request", () => {
	const broker = new ServerRequestBroker();
	const first = approval(broker, "duplicate");
	expect(() => broker.create("duplicate", "applyPatchApproval", {}, "thread-2", new Set(["connection-c"]))).toThrow(
		DuplicateServerRequestError,
	);
	expect(broker.getPending("duplicate")).toBe(first);
	expect(first.method).toBe("execCommandApproval");
});

test("the first eligible valid response wins and later responders are fenced", async () => {
	const broker = new ServerRequestBroker();
	const handle = approval(broker);
	const count = await settlementCount(handle.settled);
	expect(broker.resolve(handle.id, "connection-a", approved)).toBe(true);
	expect(await handle.settled).toEqual({ kind: "resolved", connectionId: "connection-a", result: approved });
	expect(broker.resolve(handle.id, "connection-b", { decision: "approved_for_session" })).toBe(false);
	await Promise.resolve();
	expect(count.get()).toBe(1);
	expect(broker.pendingCount).toBe(0);
});

test("duplicate ids are rejected even when the replacement has no eligible connections", () => {
	const broker = new ServerRequestBroker();
	approval(broker, "duplicate-empty");
	expect(() => broker.create("duplicate-empty", "execCommandApproval", {}, "thread-2", new Set())).toThrow(
		DuplicateServerRequestError,
	);
});

test("a schema-invalid response does not settle, then a valid response settles", async () => {
	const warnings: string[] = [];
	const broker = new ServerRequestBroker({ logger: { warn: message => warnings.push(message) } });
	const handle = approval(broker, "invalid-then-valid", new Set(["connection-a", "connection-b"]));
	let settled = false;
	void handle.settled.then(() => {
		settled = true;
	});
	expect(broker.resolve(handle.id, "connection-a", { decision: "not-a-review-decision" })).toBe(false);
	await Promise.resolve();
	expect(settled).toBe(false);
	expect(broker.pendingCount).toBe(1);
	expect(broker.resolve(handle.id, "connection-b", approved)).toBe(true);
	expect((await handle.settled).kind).toBe("resolved");
	expect(warnings.some(message => message.includes("invalid"))).toBe(true);
});

test("denied decisions settle as denied rather than resolved", async () => {
	const broker = new ServerRequestBroker();
	const handle = approval(broker, "denied");
	expect(broker.resolve(handle.id, "connection-a", denied)).toBe(true);
	expect(await handle.settled).toEqual({ kind: "denied", connectionId: "connection-a", result: denied });
});

test("late replies after settlement are ignored and logged", async () => {
	const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const broker = new ServerRequestBroker({
		logger: { warn: (message, context) => warnings.push({ message, context }) },
	});
	const handle = approval(broker, "late");
	broker.resolve(handle.id, "connection-a", approved);
	await handle.settled;
	expect(broker.resolve(handle.id, "connection-b", approved)).toBe(false);
	expect(warnings.at(-1)?.message).toContain("late");
});

test("timeout settles on its own injected timer deadline", async () => {
	let now = 0;
	let timerCallback: (() => void) | undefined;
	let cleared = false;
	const broker = new ServerRequestBroker({
		requestTimeoutMs: 25,
		now: () => now,
		setTimeout: callback => {
			timerCallback = callback;
			return callback;
		},
		clearTimeout: () => {
			cleared = true;
		},
	});
	const handle = approval(broker, "timeout", new Set(["connection-a"]));
	now = 25;
	timerCallback?.();
	expect(await handle.settled).toEqual({ kind: "timedOut" });
	expect(cleared).toBe(true);
	expect(broker.pendingCount).toBe(0);
});

test("last eligible disconnect settles exactly once", async () => {
	const broker = new ServerRequestBroker();
	const handle = approval(broker, "disconnect", new Set(["connection-a"]));
	const count = await settlementCount(handle.settled);
	expect(broker.removeConnection(handle.id, "connection-a")).toBe("cancelled");
	expect(await handle.settled).toEqual({ kind: "cancelled", reason: "last eligible connection disconnected" });
	expect(broker.removeConnection(handle.id, "connection-a")).toBe("notFound");
	await Promise.resolve();
	expect(count.get()).toBe(1);
});

test("explicit cancel, thread eviction, and shutdown settle every waiter once", async () => {
	const broker = new ServerRequestBroker();
	const cancelHandle = approval(broker, "cancel", new Set(["connection-a"]));
	const evictedHandle = broker.create(
		"evicted",
		"execCommandApproval",
		{},
		"evicted-thread",
		new Set(["connection-a"]),
	);
	const shutdownHandle = broker.create(
		"shutdown",
		"execCommandApproval",
		{},
		"other-thread",
		new Set(["connection-a"]),
	);
	if (!evictedHandle || !shutdownHandle) throw new Error("Expected pending handles.");
	const cancelCount = await settlementCount(cancelHandle.settled);
	const evictedCount = await settlementCount(evictedHandle.settled);
	const shutdownCount = await settlementCount(shutdownHandle.settled);
	expect(broker.cancel(cancelHandle.id, "interrupt")).toBe(true);
	expect(broker.cancelAllForThread("evicted-thread")).toBe(1);
	expect(broker.shutdown()).toBe(1);
	expect(await cancelHandle.settled).toEqual({ kind: "cancelled", reason: "interrupt" });
	expect(await evictedHandle.settled).toEqual({ kind: "cancelled", reason: "thread evicted" });
	expect(await shutdownHandle.settled).toEqual({ kind: "cancelled", reason: "shutdown" });
	await Promise.resolve();
	expect(cancelCount.get()).toBe(1);
	expect(evictedCount.get()).toBe(1);
	expect(shutdownCount.get()).toBe(1);
});

test("cleanupExpired remains an explicit sweep and settles expired requests", async () => {
	let now = 0;
	const broker = new ServerRequestBroker({
		requestTimeoutMs: 10,
		now: () => now,
		setTimeout: () => "timer",
		clearTimeout: () => {},
	});
	const handle = approval(broker, "sweep", new Set(["connection-a"]));
	now = 10;
	expect(broker.cleanupExpired()).toBe(1);
	expect(await handle.settled).toEqual({ kind: "timedOut" });
	expect(broker.cleanupExpired()).toBe(0);
});

test("crossing settlement paths for one id still settles exactly once", async () => {
	// Each pair races two different terminal paths against the same request id. Only the first may
	// settle the waiter; every later path must be refused rather than double-resolving it.
	const cases: Array<{ readonly name: string; readonly run: (broker: ServerRequestBroker, id: string) => void }> = [
		{
			name: "cancel then resolve",
			run: (broker, id) => {
				expect(broker.cancel(id)).toBe(true);
				expect(broker.resolve(id, "connection-a", approved)).toBe(false);
			},
		},
		{
			name: "disconnect then cancel and resolve",
			run: (broker, id) => {
				broker.handleDisconnect("connection-a");
				broker.handleDisconnect("connection-b");
				expect(broker.cancel(id)).toBe(false);
				expect(broker.resolve(id, "connection-a", approved)).toBe(false);
			},
		},
		{
			name: "resolve then cancel and thread eviction",
			run: (broker, id) => {
				expect(broker.resolve(id, "connection-a", approved)).toBe(true);
				expect(broker.cancel(id)).toBe(false);
				expect(broker.cancelAllForThread("thread-1")).toBe(0);
			},
		},
		{
			name: "shutdown then cancel",
			run: (broker, id) => {
				expect(broker.shutdown()).toBe(1);
				expect(broker.cancel(id)).toBe(false);
			},
		},
	];

	for (const { name, run } of cases) {
		const broker = new ServerRequestBroker();
		const handle = approval(broker, `cross-${name.replace(/\s+/gu, "-")}`);
		const count = await settlementCount(handle.settled);
		run(broker, handle.id);
		await handle.settled;
		await Promise.resolve();
		expect(count.get(), name).toBe(1);
		expect(broker.pendingCount, name).toBe(0);
	}
});

test("a settled id is retained only briefly so late-reply detection cannot grow without bound", async () => {
	const broker = new ServerRequestBroker();
	for (let index = 0; index < 1100; index += 1) {
		const handle = approval(broker, `retained-${index}`, new Set(["connection-a"]));
		expect(broker.resolve(handle.id, "connection-a", approved)).toBe(true);
	}
	// The earliest ids have been evicted, so their ids may be reused rather than rejected forever.
	expect(() => approval(broker, "retained-0", new Set(["connection-a"]))).not.toThrow();
	// A recently settled id is still recognised, so a genuine late reply is still fenced.
	expect(() => approval(broker, "retained-1099", new Set(["connection-a"]))).toThrow(DuplicateServerRequestError);
});

test("a timeout a native timer could not honour is rejected at construction", () => {
	// Native timers clamp NaN/Infinity/values past 2^31-1 to about 1ms, silently converting a long
	// deadline into an immediate timeout. Reject rather than mis-schedule.
	for (const requestTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, 2 ** 53, 1e15, -1]) {
		expect(() => new ServerRequestBroker({ requestTimeoutMs }), String(requestTimeoutMs)).toThrow(
			/finite value between/u,
		);
	}
	// The largest value a native timer can actually honour is still accepted.
	expect(() => new ServerRequestBroker({ requestTimeoutMs: 2 ** 31 - 1 })).not.toThrow();
});

test("a throwing timer cleanup seam cannot leave a waiter unsettled", async () => {
	const broker = new ServerRequestBroker({
		setTimeout: () => "timer-handle",
		clearTimeout: () => {
			throw new Error("timer cleanup failed");
		},
	});
	const handle = approval(broker, "throwing-cleanup", new Set(["connection-a"]));
	const count = await settlementCount(handle.settled);

	expect(broker.cancel(handle.id)).toBe(true);
	await expect(handle.settled).resolves.toMatchObject({ kind: "cancelled" });
	expect(count.get()).toBe(1);
	expect(broker.pendingCount).toBe(0);
});
