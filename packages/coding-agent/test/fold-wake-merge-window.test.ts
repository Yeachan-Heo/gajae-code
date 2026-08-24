import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { FOLD_WAKE_MERGE_WINDOW_MS } from "@gajae-code/coding-agent/session/fold-coordinator";
import { YieldQueue } from "@gajae-code/coding-agent/session/yield-queue";

interface Harness {
	queue: YieldQueue;
	streaming: boolean;
	idleInjections: AgentMessage[][];
	scheduled: Array<() => Promise<void>>;
	runScheduled: () => Promise<void>;
}

function harness(): Harness {
	const state = {
		streaming: false,
		idleInjections: [] as AgentMessage[][],
		scheduled: [] as Array<() => Promise<void>>,
	};
	const queue = new YieldQueue({
		isStreaming: () => state.streaming,
		injectStreaming: () => {},
		injectIdle: async messages => {
			state.idleInjections.push(messages);
		},
		scheduleIdleFlush: run => {
			state.scheduled.push(run);
		},
	});
	queue.register<{ text: string }>("async-result", {
		build: survivors =>
			survivors.length === 0
				? null
				: ({
						role: "user",
						content: survivors.map(entry => entry.text).join("|"),
						timestamp: 0,
					} as unknown as AgentMessage),
	});
	return {
		queue,
		get streaming() {
			return state.streaming;
		},
		set streaming(value: boolean) {
			state.streaming = value;
		},
		idleInjections: state.idleInjections,
		scheduled: state.scheduled,
		runScheduled: async () => {
			const pending = state.scheduled.splice(0, state.scheduled.length);
			for (const run of pending) await run();
		},
	} as Harness;
}

describe("fold wake merge window", () => {
	test("uses one fixed internal merge window in the approved range", () => {
		// A per-user setting would let wake behavior differ between sessions; the
		// contract is a single fixed window.
		expect(FOLD_WAKE_MERGE_WINDOW_MS).toBeGreaterThanOrEqual(500);
		expect(FOLD_WAKE_MERGE_WINDOW_MS).toBeLessThanOrEqual(2000);
	});

	test("coalesces completions arriving in the same window into one wake", async () => {
		const h = harness();
		h.queue.enqueue("async-result", { text: "first" });
		h.queue.enqueue("async-result", { text: "second" });

		// Both landed before the window elapsed, so only one flush was scheduled.
		expect(h.scheduled).toHaveLength(1);
		await h.runScheduled();

		expect(h.idleInjections).toHaveLength(1);
		expect(h.idleInjections[0]).toHaveLength(1);
		expect(String((h.idleInjections[0]?.[0] as { content: string }).content)).toBe("first|second");
	});

	// The scheduled flush returns early when it fires mid-stream and clears its
	// pending flag WITHOUT rescheduling, which used to strand the merged batch
	// until some unrelated enqueue happened by. Returning to idle must rearm it.
	test("rearms a batch whose flush fired while streaming instead of stranding it", async () => {
		const h = harness();
		h.queue.enqueue("async-result", { text: "stranded" });
		expect(h.scheduled).toHaveLength(1);

		// The window elapses while an unrelated turn is streaming.
		h.streaming = true;
		await h.runScheduled();
		expect(h.idleInjections).toHaveLength(0);

		// Returning to idle is when it becomes deliverable again.
		h.streaming = false;
		h.queue.rearmIdle();
		expect(h.scheduled).toHaveLength(1);
		await h.runScheduled();

		expect(h.idleInjections).toHaveLength(1);
		expect(String((h.idleInjections[0]?.[0] as { content: string }).content)).toBe("stranded");
	});

	test("rearmIdle is a no-op when nothing is queued or while streaming", async () => {
		const h = harness();
		h.queue.rearmIdle();
		expect(h.scheduled).toHaveLength(0);

		h.queue.enqueue("async-result", { text: "queued" });
		await h.runScheduled();
		expect(h.idleInjections).toHaveLength(1);

		// Drained: a later rearm must not schedule an empty flush.
		h.queue.rearmIdle();
		expect(h.scheduled).toHaveLength(0);

		h.queue.enqueue("async-result", { text: "while streaming" });
		h.scheduled.splice(0, h.scheduled.length);
		h.streaming = true;
		h.queue.rearmIdle();
		expect(h.scheduled).toHaveLength(0);
	});
});
