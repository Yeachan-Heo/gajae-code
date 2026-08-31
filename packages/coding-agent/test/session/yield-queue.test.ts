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
	let transitionFenced = false;
	let holdIdle = false;
	const streamingMessages: AgentMessage[] = [];
	const idleBatches: AgentMessage[][] = [];
	const scheduledFlushes: Array<{ run: () => Promise<void>; onSkip: () => void }> = [];
	const queue = new YieldQueue({
		isStreaming: () => streaming,
		isTransitionFenced: () => transitionFenced,
		injectStreaming: message => {
			streamingMessages.push(message);
		},
		injectIdle: async messages => {
			if (holdIdle) {
				transitionFenced = true;
				queue.deferIdle(messages);
				return;
			}
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
		setTransitionFenced: (value: boolean) => {
			transitionFenced = value;
		},
		setHoldIdle: (value: boolean) => {
			holdIdle = value;
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

	test("deferred mixed deliveries retain kind provenance across destructive clear", async () => {
		const harness = createHarness(false);
		harness.queue.register<Entry>("async-result", {
			build: entries => userMessage(`async:${entries.map(entry => entry.id).join(",")}`),
		});
		harness.queue.register<Entry>("mcp-notification", {
			build: entries => userMessage(`mcp:${entries.map(entry => entry.id).join(",")}`),
		});

		harness.queue.enqueue("async-result", { id: "job" });
		harness.queue.enqueue("mcp-notification", { id: "resource" });
		harness.setHoldIdle(true);
		await harness.scheduledFlushes[0]!.run();

		expect(harness.idleBatches).toHaveLength(0);
		expect(harness.queue.has("async-result")).toBe(true);
		expect(harness.queue.has("mcp-notification")).toBe(true);

		harness.queue.clearKind("async-result");
		expect(harness.queue.has("async-result")).toBe(false);
		expect(harness.queue.has("mcp-notification")).toBe(true);

		harness.setHoldIdle(false);
		harness.setTransitionFenced(false);
		harness.queue.rearmIdle();
		await harness.scheduledFlushes.at(-1)!.run();

		expect(harness.queue.has()).toBe(false);
		expect(harness.idleBatches.map(batch => batch.map(messageText))).toEqual([["mcp:resource"]]);
	});

	test("deferred raw entries are stale-filtered again when rearmed", async () => {
		const harness = createHarness(false);
		let stale = false;
		let staleChecks = 0;
		harness.queue.register<Entry>("items", {
			isStale: () => {
				staleChecks++;
				return stale;
			},
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		harness.queue.enqueue("items", { id: "held" });
		harness.setHoldIdle(true);
		await harness.scheduledFlushes[0]!.run();
		expect(staleChecks).toBe(1);
		expect(harness.queue.has("items")).toBe(true);

		stale = true;
		harness.setHoldIdle(false);
		harness.setTransitionFenced(false);
		harness.queue.rearmIdle();
		await harness.scheduledFlushes.at(-1)!.run();

		expect(staleChecks).toBe(2);
		expect(harness.queue.has()).toBe(false);
		expect(harness.idleBatches).toHaveLength(0);
	});
});
