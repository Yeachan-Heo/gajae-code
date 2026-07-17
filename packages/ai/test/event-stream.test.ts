import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types";
import { AssistantMessageEventStream, EventStream } from "../src/utils/event-stream";

function createPartial(text = ""): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("AssistantMessageEventStream", () => {
	it("queues adjacent delta events immediately without throttling or merging", () => {
		const stream = new AssistantMessageEventStream();

		stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial: createPartial("a") });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial: createPartial("ab") });

		expect(stream.queue).toHaveLength(2);
		expect(stream.queue[0]).toMatchObject({ type: "text_delta", delta: "a" });
		expect(stream.queue[1]).toMatchObject({ type: "text_delta", delta: "b" });
	});

	it("fails consumers and result when a final event proxy throws during discriminant access", async () => {
		const stream = new AssistantMessageEventStream();
		const error = new Error("hostile event proxy");
		const hostile = new Proxy({} as object, {
			get() {
				throw error;
			},
		}) as AssistantMessageEvent;
		stream.push(hostile);
		await expect(stream.result()).rejects.toBe(error);
		const iterator = stream[Symbol.asyncIterator]();
		await expect(iterator.next()).rejects.toBe(error);
	});
});

describe("EventStream deque semantics", () => {
	const makeStream = () =>
		new EventStream<{ n: number; final?: boolean }, number>(
			e => e.final === true,
			e => e.n,
		);

	it("preserves FIFO across the compaction boundary (>1024 consumed, then more pushed)", async () => {
		const stream = makeStream();
		const total = 3000;
		for (let i = 0; i < 1500; i++) stream.push({ n: i });

		const seen: number[] = [];
		const iter = stream[Symbol.asyncIterator]();
		// Consume past the 1024 compaction threshold.
		for (let i = 0; i < 1300; i++) {
			const r = await iter.next();
			seen.push((r.value as { n: number }).n);
		}
		// Push more AFTER compaction has occurred.
		for (let i = 1500; i < total; i++) stream.push({ n: i });
		stream.push({ n: total, final: true });
		stream.end(total);

		let r = await iter.next();
		while (!r.done) {
			seen.push((r.value as { n: number }).n);
			r = await iter.next();
		}
		// Every event delivered exactly once, in order, no gaps or repeats.
		expect(seen.length).toBe(total + 1);
		for (let i = 0; i < seen.length; i++) expect(seen[i]).toBe(i);
		await expect(stream.result()).resolves.toBe(total);
	});

	it("public queue getter returns a defensive snapshot that cannot desync internal state", async () => {
		const stream = makeStream();
		for (let i = 0; i < 5; i++) stream.push({ n: i });

		const snapshot = stream.queue;
		expect(snapshot).toHaveLength(5);
		// Mutating the snapshot must not affect iteration order or content.
		snapshot.length = 0;

		const iter = stream[Symbol.asyncIterator]();
		for (let i = 0; i < 5; i++) {
			const r = await iter.next();
			expect((r.value as { n: number }).n).toBe(i);
		}
		// Consumed events disappear from subsequent snapshots (no tombstones).
		expect(stream.queue).toHaveLength(0);
	});

	it("fail() after queued events rejects waiters and async iterator after draining queue", async () => {
		const stream = makeStream();
		stream.push({ n: 0 });
		stream.push({ n: 1 });
		const err = new Error("boom");
		stream.fail(err);

		const seen: number[] = [];
		let thrown: unknown;
		try {
			for await (const e of stream) seen.push(e.n);
		} catch (e) {
			thrown = e;
		}
		expect(seen).toEqual([0, 1]); // queued events still delivered first
		expect(thrown).toBe(err);
		await expect(stream.result()).rejects.toBe(err);
	});

	it("waiting consumer receives push directly without touching the queue", async () => {
		const stream = makeStream();
		const iter = stream[Symbol.asyncIterator]();
		const pending = iter.next(); // park a waiter
		stream.push({ n: 42 });
		const r = await pending;
		expect((r.value as { n: number }).n).toBe(42);
		expect(stream.queue).toHaveLength(0);
	});
});
