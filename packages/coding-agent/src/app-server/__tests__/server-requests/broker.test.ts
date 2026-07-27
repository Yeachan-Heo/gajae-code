import { expect, test } from "bun:test";
import { ServerRequestBroker } from "../../server-requests/broker";

test("create: creates a pending request with the eligible set", () => {
	const b = new ServerRequestBroker();
	const eligible = new Set(["conn-a", "conn-b"]);
	const req = b.create("req-1", "execCommandApproval", { command: "ls" }, "thread-1", eligible);
	expect(req).toBeDefined();
	expect(req!.status).toBe("pending");
	expect(req!.eligibleConnections.size).toBe(2);
	expect(b.pendingCount).toBe(1);
});

test("create: returns undefined when no eligible connections", () => {
	const b = new ServerRequestBroker();
	expect(b.create("req-1", "execCommandApproval", {}, "thread-1", new Set())).toBeUndefined();
});

test("resolve: first responder resolves the request", () => {
	const b = new ServerRequestBroker();
	const eligible = new Set(["conn-a", "conn-b"]);
	b.create("req-1", "execCommandApproval", {}, "thread-1", eligible);
	expect(b.resolve("req-1", "conn-a", { approved: true })).toBe(true);
	expect(b.pendingCount).toBe(0);
});

test("resolve: non-eligible connection cannot resolve", () => {
	const b = new ServerRequestBroker();
	b.create("req-1", "execCommandApproval", {}, "thread-1", new Set(["conn-a"]));
	expect(b.resolve("req-1", "conn-c", { approved: true })).toBe(false);
});

test("resolve: already-resolved request cannot be resolved again", () => {
	const b = new ServerRequestBroker();
	b.create("req-1", "execCommandApproval", {}, "thread-1", new Set(["conn-a", "conn-b"]));
	b.resolve("req-1", "conn-a", { approved: true });
	expect(b.resolve("req-1", "conn-b", { approved: false })).toBe(false);
});

test("removeConnection: removes a connection; returns 'updated' if others remain", () => {
	const b = new ServerRequestBroker();
	b.create("req-1", "execCommandApproval", {}, "thread-1", new Set(["conn-a", "conn-b"]));
	expect(b.removeConnection("req-1", "conn-a")).toBe("updated");
	expect(b.pendingCount).toBe(1);
});

test("removeConnection: returns 'cancelled' when last responder disconnects", () => {
	const b = new ServerRequestBroker();
	b.create("req-1", "execCommandApproval", {}, "thread-1", new Set(["conn-a"]));
	expect(b.removeConnection("req-1", "conn-a")).toBe("cancelled");
	expect(b.pendingCount).toBe(0);
});

test("cancel: cancels a pending request", () => {
	const b = new ServerRequestBroker();
	b.create("req-1", "execCommandApproval", {}, "thread-1", new Set(["conn-a"]));
	expect(b.cancel("req-1")).toBe(true);
	expect(b.pendingCount).toBe(0);
});

test("cancelAllForThread: cancels all pending requests for a thread (turn transition)", () => {
	const b = new ServerRequestBroker();
	b.create("r1", "execCommandApproval", {}, "thread-1", new Set(["conn-a"]));
	b.create("r2", "applyPatchApproval", {}, "thread-1", new Set(["conn-a"]));
	b.create("r3", "execCommandApproval", {}, "thread-2", new Set(["conn-b"]));
	expect(b.cancelAllForThread("thread-1")).toBe(2);
	expect(b.pendingCount).toBe(1);
});

test("getPendingForThread: returns pending requests for a thread", () => {
	const b = new ServerRequestBroker();
	b.create("r1", "execCommandApproval", {}, "thread-1", new Set(["conn-a"]));
	b.create("r2", "applyPatchApproval", {}, "thread-1", new Set(["conn-a"]));
	const pending = b.getPendingForThread("thread-1");
	expect(pending).toHaveLength(2);
});

test("cleanupExpired: cancels requests past their timeout", () => {
	const b = new ServerRequestBroker({ requestTimeoutMs: -1 }); // negative => always expired
	b.create("r1", "execCommandApproval", {}, "thread-1", new Set(["conn-a"]));
	// With timeout -1, the request is immediately expired.
	expect(b.cleanupExpired()).toBe(1);
	expect(b.pendingCount).toBe(0);
});

test("create: duplicate request ID overwrites the prior pending request", () => {
	const b = new ServerRequestBroker();
	b.create("r1", "execCommandApproval", {}, "thread-1", new Set(["conn-a"]));
	b.create("r1", "applyPatchApproval", {}, "thread-2", new Set(["conn-b"]));
	// The map now has one entry for r1, overwritten by the second create.
	expect(b.pendingCount).toBe(1);
	const pending = b.getPendingForThread("thread-2");
	expect(pending).toHaveLength(1);
});

test("removeConnection: removing a non-eligible connection is a no-op", () => {
	const b = new ServerRequestBroker();
	b.create("r1", "execCommandApproval", {}, "thread-1", new Set(["conn-a"]));
	// conn-b is not in the eligible set.
	expect(b.removeConnection("r1", "conn-b")).toBe("updated");
	expect(b.pendingCount).toBe(1);
	expect(b.getPendingForThread("thread-1")).toHaveLength(1);
});

test("removeConnection: non-existent request returns 'notFound'", () => {
	const b = new ServerRequestBroker();
	expect(b.removeConnection("nonexistent", "conn-a")).toBe("notFound");
});
