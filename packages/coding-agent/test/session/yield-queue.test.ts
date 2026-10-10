import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { YieldQueue } from "@gajae-code/coding-agent/session/yield-queue";

type Entry = {
	id: string;
	stale?: boolean;
};

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	const block = message.content[0];
	return block?.type === "text" ? block.text : "";
}

function createHarness(initialStreaming: boolean) {
	let streaming = initialStreaming;
	const streamingMessages: AgentMessage[] = [];
	const idleBatches: AgentMessage[][] = [];
	const scheduledFlushes: Array<{ run: () => Promise<void>; onSkip: () => void }> = [];
	const queue = new YieldQueue({
		isStreaming: () => streaming,
		injectStreaming: message => {
			streamingMessages.push(message);
		},
		injectIdle: async messages => {
			idleBatches.push(messages);
		},
		scheduleIdleFlush: (run, onSkip) => {
			scheduledFlushes.push({ run, onSkip });
		},
	});
	return {
		queue,
		streamingMessages,
		idleBatches,
		scheduledFlushes,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
	};
}

describe("YieldQueue", () => {
	test("enqueue while streaming defers until streaming flush", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "a" });

		expect(harness.scheduledFlushes).toHaveLength(0);
		expect(harness.streamingMessages).toHaveLength(0);
		expect(harness.queue.has("items")).toBe(true);

		await harness.queue.flush("streaming");

		expect(harness.queue.has()).toBe(false);
		expect(harness.streamingMessages.map(messageText)).toEqual(["a"]);
	});

	test("enqueue while idle schedules one debounced idle flush", async () => {
		const harness = createHarness(false);
		harness.queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "a" });
		harness.queue.enqueue("items", { id: "b" });

		expect(harness.scheduledFlushes).toHaveLength(1);
		expect(harness.idleBatches).toHaveLength(0);

		await harness.scheduledFlushes[0]!.run();

		expect(harness.idleBatches).toHaveLength(1);
		expect(harness.idleBatches[0]?.map(messageText)).toEqual(["a,b"]);
	});

	test("a skipped idle callback releases the debounce latch", () => {
		const harness = createHarness(false);
		harness.queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "a" });
		expect(harness.scheduledFlushes).toHaveLength(1);
		harness.scheduledFlushes[0]!.onSkip();
		harness.queue.enqueue("items", { id: "b" });

		expect(harness.scheduledFlushes).toHaveLength(2);
	});

	test("a stale skipped callback cannot clear newer flush ownership", async () => {
		const harness = createHarness(false);
		harness.queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "aborted" });
		expect(harness.scheduledFlushes).toHaveLength(1);
		harness.queue.clear();
		harness.queue.enqueue("items", { id: "fresh" });
		expect(harness.scheduledFlushes).toHaveLength(2);

		harness.scheduledFlushes[0]!.onSkip();
		harness.queue.enqueue("items", { id: "coalesced" });
		expect(harness.scheduledFlushes).toHaveLength(2);

		await harness.scheduledFlushes[1]!.run();
		expect(harness.idleBatches[0]?.map(messageText)).toEqual(["fresh,coalesced"]);
	});

	test("isStale drops stale entries and keeps survivors", async () => {
		const harness = createHarness(true);
		let survivorIds: string[] = [];
		harness.queue.register<Entry>("items", {
			isStale: entry => entry.stale === true,
			build: entries => {
				survivorIds = entries.map(entry => entry.id);
				return userMessage(survivorIds.join(","));
			},
		});

		harness.queue.enqueue("items", { id: "old", stale: true });
		harness.queue.enqueue("items", { id: "fresh" });
		await harness.queue.flush("streaming");

		expect(survivorIds).toEqual(["fresh"]);
		expect(harness.streamingMessages.map(messageText)).toEqual(["fresh"]);
	});

	test("build returning null does not inject", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("items", {
			build: () => null,
		});

		harness.queue.enqueue("items", { id: "a" });
		await harness.queue.flush("streaming");

		expect(harness.streamingMessages).toHaveLength(0);
		expect(harness.idleBatches).toHaveLength(0);
	});

	test("one kind failing in build does not abort other kinds", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("bad", {
			build: () => {
				throw new Error("boom");
			},
		});
		harness.queue.register<Entry>("good", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("bad", { id: "bad" });
		harness.queue.enqueue("good", { id: "good" });
		await harness.queue.flush("streaming");

		expect(harness.streamingMessages.map(messageText)).toEqual(["good"]);
	});

	test("requeues an idle delivery rejected by admission and releases its claim once after retry", async () => {
		let attempts = 0;
		let delivered = 0;
		const streaming = false;
		const scheduledFlushes: Array<{ run: () => Promise<void>; onSkip: () => void }> = [];
		const queue = new YieldQueue({
			isStreaming: () => streaming,
			injectStreaming: () => {},
			injectIdle: async () => {
				attempts += 1;
				if (attempts === 1) throw Object.assign(new Error("transition busy"), { code: "busy" });
				return "delivered" as const;
			},
			scheduleIdleFlush: (run, onSkip) => scheduledFlushes.push({ run, onSkip }),
		});
		queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
			onDelivered: () => {
				delivered += 1;
			},
		});

		queue.enqueue("items", { id: "race" });
		await scheduledFlushes[0]!.run();

		expect(queue.has("items")).toBe(true);
		expect(delivered).toBe(0);
		expect(scheduledFlushes).toHaveLength(2);

		await scheduledFlushes[1]!.run();
		expect(queue.has("items")).toBe(false);
		expect(attempts).toBe(2);
		expect(delivered).toBe(1);
	});

	test("clearKind drops queued identity-bound entries through the dispatcher cleanup", () => {
		const harness = createHarness(false);
		let dropped = 0;
		harness.queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
			onDrop: () => {
				dropped += 1;
			},
		});

		harness.queue.enqueue("items", { id: "predecessor" });
		harness.queue.clearKind("items");

		expect(harness.queue.has("items")).toBe(false);
		expect(dropped).toBe(1);
	});

	test("clear invalidates a drained idle batch instead of resurrecting it after a failed injection", async () => {
		const injectionStarted = Promise.withResolvers<void>();
		const releaseInjection = Promise.withResolvers<void>();
		let dropped = 0;
		const scheduledFlushes: Array<{ run: () => Promise<void>; onSkip: () => void }> = [];
		const queue = new YieldQueue({
			isStreaming: () => false,
			injectStreaming: () => {},
			injectIdle: async () => {
				injectionStarted.resolve();
				await releaseInjection.promise;
				throw Object.assign(new Error("transition busy"), { code: "busy" });
			},
			scheduleIdleFlush: (run, onSkip) => scheduledFlushes.push({ run, onSkip }),
		});
		queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
			onDrop: () => {
				dropped += 1;
			},
		});

		queue.enqueue("items", { id: "cleared" });
		const runningFlush = scheduledFlushes[0]!.run();
		await injectionStarted.promise;
		queue.clear();
		releaseInjection.resolve();
		await runningFlush;

		expect(queue.has("items")).toBe(false);
		expect(dropped).toBe(1);
	});

	test("flush preserves registration order across kinds", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("second", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		harness.queue.register<Entry>("first", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("first", { id: "first" });
		harness.queue.enqueue("second", { id: "second" });
		await harness.queue.flush("streaming");

		expect(harness.streamingMessages.map(messageText)).toEqual(["second", "first"]);
	});
});
