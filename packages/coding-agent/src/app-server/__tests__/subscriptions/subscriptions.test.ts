import { expect, test } from "bun:test";
import { ConnectionRegistry, ThreadSubscriptionIndex } from "../../subscriptions";

test("subscribe: adds a connection to a thread", () => {
	const idx = new ThreadSubscriptionIndex();
	idx.subscribe("conn-a", "thread-1");
	expect(idx.isSubscribed("conn-a", "thread-1")).toBe(true);
	expect(idx.getSubscribers("thread-1").size).toBe(1);
});

test("subscribe: idempotent (duplicate does not create a second entry)", () => {
	const idx = new ThreadSubscriptionIndex();
	idx.subscribe("conn-a", "thread-1");
	idx.subscribe("conn-a", "thread-1");
	expect(idx.getSubscribers("thread-1").size).toBe(1);
});

test("subscribe: multiple connections can subscribe to the same thread", () => {
	const idx = new ThreadSubscriptionIndex();
	idx.subscribe("conn-a", "thread-1");
	idx.subscribe("conn-b", "thread-1");
	expect(idx.getSubscribers("thread-1").size).toBe(2);
});

test("unsubscribe: removes a connection from a thread", () => {
	const idx = new ThreadSubscriptionIndex();
	idx.subscribe("conn-a", "thread-1");
	expect(idx.unsubscribe("conn-a", "thread-1")).toBe(true);
	expect(idx.isSubscribed("conn-a", "thread-1")).toBe(false);
	expect(idx.getSubscribers("thread-1").size).toBe(0);
});

test("unsubscribe: cleans up the reverse index entry for the connection", () => {
	const idx = new ThreadSubscriptionIndex();
	idx.subscribe("conn-a", "thread-1");
	idx.unsubscribe("conn-a", "thread-1");
	// After unsubscribing from the only thread, the reverse index entry should be gone.
	expect(idx.getSubscriptions("conn-a").size).toBe(0);
});

test("unsubscribe: returns false for a non-existent subscription", () => {
	const idx = new ThreadSubscriptionIndex();
	expect(idx.unsubscribe("conn-a", "thread-1")).toBe(false);
});

test("handleDisconnect: cleans up all subscriptions for a connection", () => {
	const idx = new ThreadSubscriptionIndex();
	idx.subscribe("conn-a", "thread-1");
	idx.subscribe("conn-a", "thread-2");
	idx.subscribe("conn-b", "thread-1");
	const removed = idx.handleDisconnect("conn-a");
	expect(removed).toHaveLength(2);
	expect(idx.isSubscribed("conn-a", "thread-1")).toBe(false);
	expect(idx.isSubscribed("conn-b", "thread-1")).toBe(true);
});

test("handleDisconnect: empty threads cleaned from the subscription map", () => {
	const idx = new ThreadSubscriptionIndex();
	idx.subscribe("conn-a", "thread-1");
	idx.handleDisconnect("conn-a");
	expect(idx.subscribedThreads).toBe(0);
});

test("getSubscriptions: returns all threads for a connection", () => {
	const idx = new ThreadSubscriptionIndex();
	idx.subscribe("conn-a", "t1");
	idx.subscribe("conn-a", "t2");
	idx.subscribe("conn-b", "t3");
	expect(idx.getSubscriptions("conn-a").size).toBe(2);
	expect(idx.getSubscriptions("conn-b").size).toBe(1);
});

test("ConnectionRegistry: register, unregister, optsOutOf", () => {
	const reg = new ConnectionRegistry();
	const optOuts = new Set(["item/agentMessage/delta"]);
	reg.register("conn-a", optOuts);
	expect(reg.isActive("conn-a")).toBe(true);
	expect(reg.optsOutOf("conn-a", "item/agentMessage/delta")).toBe(true);
	expect(reg.optsOutOf("conn-a", "turn/completed")).toBe(false);
	reg.unregister("conn-a");
	expect(reg.isActive("conn-a")).toBe(false);
});
