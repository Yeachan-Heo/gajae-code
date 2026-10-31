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

	test("streaming ignores the idle signal provider and failed idle lookup retains entries", async () => {
		let failSignal = true;
		let lookups = 0;
		const streaming: string[] = [];
		const idle: string[] = [];
		const controller = new AbortController();
		const queue = new YieldQueue({
			isStreaming: () => true,
			injectStreaming: message => {
				streaming.push(messageText(message));
			},
			injectIdle: async (messages, signal) => {
				if (signal !== controller.signal) throw new Error("Wrong idle signal");
				idle.push(...messages.map(messageText));
			},
			scheduleIdleFlush: () => {
				throw new Error("Unexpected idle scheduling");
			},
			getIdleFlushSignal: () => {
				lookups++;
				if (failSignal) throw new Error("Idle signal unavailable");
				return controller.signal;
			},
		});
		queue.register<Entry>("items", { build: entries => userMessage(entries.map(entry => entry.id).join(",")) });
		queue.enqueue("items", { id: "streaming" });
		await queue.flush("streaming");
		expect(lookups).toBe(0);
		expect(streaming).toEqual(["streaming"]);
		queue.enqueue("items", { id: "idle" });
		await queue.flush("idle");
		expect(lookups).toBe(1);
		expect(queue.has("items")).toBe(true);
		expect(idle).toEqual([]);
		failSignal = false;
		await queue.flush("idle");
		expect(lookups).toBe(2);
		expect(queue.has()).toBe(false);
		expect(idle).toEqual(["idle"]);
	});

	test("retains entries on admission failure and holds the recovered lease through delivery", async () => {
		let ready = false;
		let leased = false;
		let builds = 0;
		const enteredAdmission = Promise.withResolvers<void>();
		const drain = Promise.withResolvers<void>();
		const enteredDelivery = Promise.withResolvers<void>();
		const finishDelivery = Promise.withResolvers<void>();
		const scheduled: Array<(signal?: AbortSignal) => Promise<void>> = [];
		const batches: string[][] = [];
		const ownership: boolean[] = [];
		const signals: Array<AbortSignal | undefined> = [];
		const controller = new AbortController();
		const queue = new YieldQueue({
			isStreaming: () => false,
			injectStreaming: () => {
				throw new Error("Unexpected streaming delivery");
			},
			withIdleAdmission: async (body, signal) => {
				signals.push(signal);
				if (!ready) throw new Error("Delegation not ready");
				leased = true;
				enteredAdmission.resolve();
				try {
					await drain.promise;
					await body();
				} finally {
					leased = false;
				}
			},
			injectIdle: async messages => {
				ownership.push(leased);
				batches.push(messages.map(messageText));
				enteredDelivery.resolve();
				await finishDelivery.promise;
				ownership.push(leased);
			},
			scheduleIdleFlush: run => {
				scheduled.push(run);
			},
		});
		queue.register<Entry>("items", {
			build: entries => {
				builds++;
				return userMessage(entries.map(entry => entry.id).join(","));
			},
		});
		queue.enqueue("items", { id: "original" });
		await scheduled.shift()!(controller.signal);
		expect(queue.has("items")).toBe(true);
		expect(builds).toBe(0);
		expect(batches).toEqual([]);
		expect(scheduled).toHaveLength(0);
		ready = true;
		queue.rearmIdle();
		const delivery = scheduled.shift()!(controller.signal);
		try {
			await enteredAdmission.promise;
			expect(queue.has("items")).toBe(true);
			expect(builds).toBe(0);
			queue.enqueue("items", { id: "later" });
			drain.resolve();
			await enteredDelivery.promise;
			expect(queue.has()).toBe(false);
			expect(builds).toBe(1);
			expect(batches).toEqual([["original,later"]]);
			expect(leased).toBe(true);
		} finally {
			drain.resolve();
			finishDelivery.resolve();
			await delivery;
		}
		expect(ownership).toEqual([true, true]);
		expect(signals).toEqual([controller.signal, controller.signal]);
		expect(leased).toBe(false);
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
