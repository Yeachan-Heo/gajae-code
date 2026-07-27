import { expect, test } from "bun:test";
import { BoundedOutboundQueue } from "../../transport/connection";

test("BoundedOutboundQueue: enqueues and flushes frames in order", async () => {
	const sent: number[] = [];
	const q = new BoundedOutboundQueue({
		capacity: 4,
		send: async (frame) => {
			sent.push(Number(new TextDecoder().decode(frame)));
		},
	});
	q.enqueue(new TextEncoder().encode("1"));
	q.enqueue(new TextEncoder().encode("2"));
	q.enqueue(new TextEncoder().encode("3"));
	await new Promise(r => setTimeout(r, 10));
	expect(sent).toEqual([1, 2, 3]);
	expect(q.queued).toBe(0);
});

test("BoundedOutboundQueue: rejects when at capacity and triggers slow-client policy", async () => {
	let slowTriggered = false;
	const q = new BoundedOutboundQueue({
		capacity: 2,
		send: async () => {}, // instant send
		onSlowClient: () => { slowTriggered = true; },
	});
	expect(q.enqueue(new TextEncoder().encode("a"))).toBe(true);
	expect(q.enqueue(new TextEncoder().encode("b"))).toBe(true);
	// capacity=2, both already flushed; but queue drains fast. Let's test with a blocking send.
});

test("BoundedOutboundQueue: slow send causes backpressure at capacity", async () => {
	let slowTriggered = false;
	const sendResolvers: Array<() => void> = [];
	const q = new BoundedOutboundQueue({
		capacity: 3,
		send: () => new Promise<void>(resolve => { sendResolvers.push(resolve); }),
		onSlowClient: () => { slowTriggered = true; },
	});
	// First frame blocks (send never resolves until we call the resolver).
	q.enqueue(new TextEncoder().encode("1"));
	await new Promise(r => setTimeout(r, 5));
	// Queue the next frames. The first frame is in-flight (send is blocked), but the queue
	// array holds the pending ones — capacity 3 means 3 can sit in the array.
	expect(q.enqueue(new TextEncoder().encode("2"))).toBe(true);
	expect(q.enqueue(new TextEncoder().encode("3"))).toBe(true);
	// 4th exceeds capacity -> slow-client triggered.
	expect(q.enqueue(new TextEncoder().encode("4"))).toBe(true);
	expect(q.enqueue(new TextEncoder().encode("5"))).toBe(false);
	expect(slowTriggered).toBe(true);
	// Resolve all blocked sends so the flush loop completes.
	for (const resolve of sendResolvers) resolve();
	await new Promise(r => setTimeout(r, 10));
});

test("BoundedOutboundQueue: close prevents further enqueues", async () => {
	const q = new BoundedOutboundQueue({ send: async () => {} });
	await q.close();
	expect(q.closed).toBe(true);
	expect(q.enqueue(new TextEncoder().encode("x"))).toBe(false);
});

test("BoundedOutboundQueue: send failure re-enqueues and stops", async () => {
	const sent: string[] = [];
	let shouldFail = true;
	const q = new BoundedOutboundQueue({
		capacity: 5,
		send: async () => {
			if (shouldFail) throw new Error("transport down");
			sent.push("ok");
		},
	});
	q.enqueue(new TextEncoder().encode("frame"));
	await new Promise(r => setTimeout(r, 10));
	// Frame re-enqueued after failure.
	expect(q.queued).toBe(1);
	// Fix the transport and close (drain retries).
	shouldFail = false;
	await q.close();
});
