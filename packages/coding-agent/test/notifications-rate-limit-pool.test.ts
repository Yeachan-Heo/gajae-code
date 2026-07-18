import { describe, expect, test } from "bun:test";
import { type RateLimitItem, RateLimitPool } from "../src/sdk/bus/rate-limit-pool";

function item(
	sessionId: string,
	lane: RateLimitItem["lane"],
	payload: string,
	coalesceKey?: string,
): RateLimitItem<string> {
	return { sessionId, lane, payload, coalesceKey };
}

describe("RateLimitPool", () => {
	test("bursts up to capacity then throttles to the refill rate", () => {
		let now = 0;
		const pool = new RateLimitPool<string>({ capacity: 3, refillPerSec: 1, now: () => now });
		for (let i = 0; i < 6; i++) pool.submit(item("s1", "live", `e${i}`));

		// Burst: capacity (3) granted immediately.
		expect(pool.drain(0).map(i => i.payload)).toEqual(["e0", "e1", "e2"]);
		// No tokens yet.
		expect(pool.drain(0)).toEqual([]);
		// After 1s, exactly one token refills.
		expect(pool.drain(1000).map(i => i.payload)).toEqual(["e3"]);
		// After 2 more seconds, two more.
		now = 3000;
		expect(pool.drain().map(i => i.payload)).toEqual(["e4", "e5"]);
	});

	test("serves higher-priority lanes first", () => {
		const pool = new RateLimitPool<string>({ capacity: 10, refillPerSec: 1, now: () => 0 });
		pool.submit(item("s1", "idle", "idle"));
		pool.submit(item("s1", "live", "live"));
		pool.submit(item("s1", "ask", "ask"));
		pool.submit(item("s1", "finalized", "final"));
		expect(pool.drain(0).map(i => i.payload)).toEqual(["ask", "final", "live", "idle"]);
	});

	test("round-robins across sessions so one cannot starve another", () => {
		const pool = new RateLimitPool<string>({ capacity: 2, refillPerSec: 1, now: () => 0 });
		// s1 floods 4 live edits before s2 submits one.
		for (let i = 0; i < 4; i++) pool.submit(item("s1", "live", `s1-${i}`));
		pool.submit(item("s2", "live", "s2-0"));

		let now = 0;
		const order: string[] = [];
		for (let step = 0; step < 5; step++) {
			for (const granted of pool.drain(now)) order.push(granted.payload);
			now += 1000;
		}
		// s2's single edit must be served early (fairness), not after all s1 edits.
		const s2Index = order.indexOf("s2-0");
		expect(s2Index).toBeGreaterThanOrEqual(0);
		expect(s2Index).toBeLessThanOrEqual(1);
		expect(order).toHaveLength(5);
	});

	test("coalesces live edits sharing a key to the latest payload", () => {
		const pool = new RateLimitPool<string>({ capacity: 10, refillPerSec: 1, now: () => 0 });
		pool.submit(item("s1", "live", "v1", "msg-7"));
		pool.submit(item("s1", "live", "v2", "msg-7"));
		pool.submit(item("s1", "live", "v3", "msg-7"));
		expect(pool.pending).toBe(1);
		expect(pool.drain(0).map(i => i.payload)).toEqual(["v3"]);
	});
	test("reserves generated IDs across coalescing replacements", async () => {
		const pool = new RateLimitPool<string>({ capacity: 2, refillPerSec: 0, now: () => 0 });
		const first = pool.submit(item("s1", "live", "v1", "msg-7"));
		const replacement = pool.submit(item("s1", "live", "v2", "msg-7"));
		const next = pool.submit(item("s1", "live", "next"));

		expect([first.itemId, replacement.itemId, next.itemId]).toEqual(["rate-limit:0", "rate-limit:1", "rate-limit:2"]);
		await expect(first.settled).resolves.toBe("removed");

		const granted = pool.drain(0);
		expect(granted.map(job => job.itemId)).toEqual([replacement.itemId, next.itemId]);
		for (const job of granted) pool.settle(job.itemId!, "accepted");

		await expect(replacement.settled).resolves.toBe("accepted");
		await expect(next.settled).resolves.toBe("accepted");
	});

	test("coalescing is scoped per session and per key", () => {
		const pool = new RateLimitPool<string>({ capacity: 10, refillPerSec: 1, now: () => 0 });
		pool.submit(item("s1", "live", "a", "k"));
		pool.submit(item("s2", "live", "b", "k"));
		pool.submit(item("s1", "live", "c", "other"));
		expect(pool.pending).toBe(3);
	});

	test("expires elapsed items before granting without consuming their token", () => {
		const pool = new RateLimitPool<string>({ capacity: 1, refillPerSec: 0, now: () => 0 });
		pool.submit({ ...item("s1", "ask", "expired"), itemId: "receipt-expired", deadlineAt: 100 });
		pool.submit({ ...item("s2", "ask", "live"), itemId: "receipt-live", deadlineAt: 200 });

		const result = pool.drainWithExpired(100);
		expect(result.expired.map(i => i.payload)).toEqual(["expired"]);
		expect(result.granted.map(i => i.payload)).toEqual(["live"]);
		expect(pool.availableTokens(100)).toBe(0);
		expect(pool.drain(200)).toEqual([]);
	});

	test("removes exactly the identified queued item and returns its payload", () => {
		const pool = new RateLimitPool<string>({ capacity: 2, refillPerSec: 0, now: () => 0 });
		pool.submit({ ...item("s1", "ask", "first"), itemId: "receipt-1" });
		pool.submit({ ...item("s1", "ask", "second"), itemId: "receipt-2" });

		expect(pool.removeById("receipt-2")).toMatchObject({ itemId: "receipt-2", payload: "second" });
		expect(pool.removeById("receipt-2")).toBeUndefined();
		expect(pool.drain(0).map(i => i.payload)).toEqual(["first"]);
	});

	test("does not coalesce identified jobs", () => {
		const pool = new RateLimitPool<string>({ capacity: 2, refillPerSec: 0, now: () => 0 });
		pool.submit({ ...item("s1", "ask", "first", "same-key"), itemId: "receipt-1" });
		pool.submit({ ...item("s1", "ask", "second", "same-key"), itemId: "receipt-2" });

		expect(pool.pending).toBe(2);
		expect(pool.drain(0).map(i => i.payload)).toEqual(["first", "second"]);
	});

	test("removes matching queued items without consuming tokens", () => {
		const pool = new RateLimitPool<string>({ capacity: 1, refillPerSec: 0, now: () => 0 });
		pool.submit(item("s1", "finalized", "s1-final"));
		pool.submit(item("s1", "live", "s1-live"));
		pool.submit(item("s2", "live", "s2-live"));

		expect(pool.drain(0).map(i => i.payload)).toEqual(["s1-final"]);
		const removed = pool.removeWhere(i => i.sessionId === "s1");
		expect(removed.map(i => i.payload)).toEqual(["s1-live"]);
		expect(pool.pending).toBe(1);
		expect(pool.drain(60_000).map(i => i.payload)).toEqual([]);
	});
});
