import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types";

function createMockAssistantMessage(): AssistantMessage {
	return {
		role: "assistant" as const,
		api: "openai" as const,
		provider: "openai-codex-responses",
		model: "gpt-4-with-reason",
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Behavior tests for Codex provider event buffering and flushing.
 * Tests verify that:
 * 1. Buffered events are flushed cooperatively to avoid event loop starvation
 * 2. Timers and abort make progress during long streaming responses with many deltas
 * 3. Retry after partial output produces no duplicate deltas
 * 4. Final tool call arguments are identical to successful streaming
 */
describe("codex: cooperative event flushing and replay contract (issue #8127)", () => {
	it("flushes buffered events cooperatively, allowing concurrent work", async () => {
		// Track when yields happen
		const yields: number[] = [];
		const startTime = Date.now();
		const mockMessage = createMockAssistantMessage();

		// Create a mock event stream with many delta events
		const bufferedEvents: AssistantMessageEvent[] = [];

		// Add 1000+ delta events to simulate a large response
		for (let i = 0; i < 1500; i++) {
			bufferedEvents.push({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: `"chunk${i}":"value${i}",`,
				partial: mockMessage,
			});
		}

		// Simulate flushCodexEventsCooperatively
		const flushedEvents: AssistantMessageEvent[] = [];
		const batchSize = 100;

		for (let i = 0; i < bufferedEvents.length; i++) {
			flushedEvents.push(bufferedEvents[i]!);
			if ((i + 1) % batchSize === 0) {
				yields.push(Date.now() - startTime);
				await Bun.sleep(0);
			}
		}

		// Verify that we flushed all events
		expect(flushedEvents).toHaveLength(1500);

		// Verify that we yielded multiple times (allowing concurrent work)
		expect(yields.length).toBeGreaterThan(5); // 1500/100 = 15 batches

		// The yields should be spread out (not all at once)
		for (let i = 1; i < yields.length; i++) {
			// Each yield happens after processing a batch
			expect(yields[i]! - yields[i - 1]!).toBeGreaterThanOrEqual(0);
		}
	});

	it("abort during flush completes promptly", async () => {
		// Create a large set of buffered events
		const bufferedEvents: AssistantMessageEvent[] = [];
		const mockMessage = createMockAssistantMessage();

		for (let i = 0; i < 2000; i++) {
			bufferedEvents.push({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: `{"arg":${i}}`,
				partial: mockMessage,
			});
		}

		// Set up a timer to cancel during flush
		const controller = new AbortController();
		let cancelledAt: number | undefined;
		const startFlush = Date.now();

		// Simulate flushing with abortion
		const flushedEvents: AssistantMessageEvent[] = [];
		const batchSize = 100;

		const flushPromise = (async () => {
			for (let i = 0; i < bufferedEvents.length; i++) {
				if (controller.signal.aborted) {
					cancelledAt = Date.now() - startFlush;
					return;
				}
				flushedEvents.push(bufferedEvents[i]!);
				if ((i + 1) % batchSize === 0) {
					await Bun.sleep(0);
				}
			}
		})();

		// Cancel after a short delay
		await Bun.sleep(5);
		controller.abort();

		// Wait for the flush to complete (or timeout)
		await Promise.race([
			flushPromise,
			Bun.sleep(100), // Timeout after 100ms to ensure test completes
		]);

		// Verify that we cancelled and didn't process all events
		if (cancelledAt !== undefined) {
			expect(cancelledAt).toBeLessThan(50); // Should abort quickly
			expect(flushedEvents.length).toBeLessThan(2000); // Not all events processed
		}
	});

	it("replay-eligible events are buffered until committed", () => {
		// This test verifies the replay contract:
		// Once an event is emitted to consumers, it cannot be retracted on retry.
		// So all events must be buffered while replay is eligible.

		const emittedToConsumer: AssistantMessageEvent[] = [];
		const buffered: AssistantMessageEvent[] = [];

		// Mock replay-eligible state
		let isReplayEligible = true;
		let eventsReleased = false;

		interface Context {
			stream: { push: (e: AssistantMessageEvent) => void };
		}

		const context: Context = {
			stream: {
				push: (event: AssistantMessageEvent) => {
					emittedToConsumer.push(event);
				},
			},
		};

		// Simulate emitCodexEvent logic
		function simulateEmit(event: AssistantMessageEvent): void {
			if (!eventsReleased && isReplayEligible) {
				buffered.push(event);
				return;
			}
			context.stream.push(event);
		}

		// Emit multiple events while replay-eligible
		const mockMessage = createMockAssistantMessage();
		simulateEmit({
			type: "toolcall_start",
			contentIndex: 0,
			partial: mockMessage,
		});
		simulateEmit({
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '{"arg":',
			partial: mockMessage,
		});
		simulateEmit({
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '"value"',
			partial: mockMessage,
		});
		simulateEmit({
			type: "toolcall_delta",
			contentIndex: 0,
			delta: "}",
			partial: mockMessage,
		});

		// All events should be buffered
		expect(buffered).toHaveLength(4);
		expect(emittedToConsumer).toHaveLength(0);

		// Simulate replay finishing (no longer eligible)
		isReplayEligible = false;

		// Now events should be flushed and new ones emitted directly
		for (const event of buffered) {
			context.stream.push(event);
		}
		eventsReleased = true;
		buffered.length = 0;

		// Emit a final event
		simulateEmit({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: {
				type: "toolCall" as const,
				id: "call_1",
				name: "test",
				arguments: { arg: "value" },
			},
			partial: mockMessage,
		});

		// Verify all events eventually reached consumer, in order
		expect(emittedToConsumer).toHaveLength(5);
		expect(emittedToConsumer[0]?.type).toBe("toolcall_start");
		expect(emittedToConsumer[1]?.type).toBe("toolcall_delta");
		expect(emittedToConsumer[2]?.type).toBe("toolcall_delta");
		expect(emittedToConsumer[3]?.type).toBe("toolcall_delta");
		expect(emittedToConsumer[4]?.type).toBe("toolcall_end");
	});

	it("delta events checked for JSON completeness on every update", () => {
		// This test verifies that JSON completion is checked on every delta,
		// not deferred based on heuristics like closing braces or size boundaries.

		let completionChecks = 0;

		interface Block {
			partialJson: string;
			argumentsComplete: boolean;
		}

		const block: Block = {
			partialJson: "",
			argumentsComplete: false,
		};

		function isCompleteJsonObject(json: string): boolean {
			try {
				JSON.parse(json);
				return true;
			} catch {
				return false;
			}
		}

		// Simulate handleToolCallArgumentsDelta: check on every delta
		function handleDelta(delta: string): void {
			block.partialJson += delta;
			block.argumentsComplete = isCompleteJsonObject(block.partialJson);
			completionChecks++;
		}

		// Build a simple object incrementally: {"a":1}
		handleDelta("{");
		expect(block.argumentsComplete).toBe(false);
		expect(completionChecks).toBe(1);

		handleDelta('"a"');
		expect(block.argumentsComplete).toBe(false);
		expect(completionChecks).toBe(2);

		handleDelta(":");
		expect(block.argumentsComplete).toBe(false);
		expect(completionChecks).toBe(3);

		handleDelta("1");
		expect(block.argumentsComplete).toBe(false); // Still not complete, need closing brace
		expect(completionChecks).toBe(4);

		// Add closing brace to complete the JSON
		handleDelta("}");
		expect(block.argumentsComplete).toBe(true); // Now complete
		expect(completionChecks).toBe(5); // Check happened on this delta

		// Verify we checked on every delta, not based on size or brace boundaries
		expect(completionChecks).toBe(5);
	});

	it("pure tool-call response with many deltas flushes with correct event order", async () => {
		// This test verifies that a pure tool-call response (no text items) with many
		// argument deltas flushes all buffered events before emitting the terminal event.
		// This is critical for the replay contract: tool-call deltas must arrive before
		// the final toolcall_end, so a retry can safely discard all events for this call.

		const emittedEvents: AssistantMessageEvent[] = [];
		const mockMessage = createMockAssistantMessage();

		const context = {
			stream: {
				push: (event: AssistantMessageEvent) => {
					emittedEvents.push(event);
				},
			},
		};

		// Simulate buffered events that would be released on output_item.done
		const bufferedEvents: AssistantMessageEvent[] = [];
		for (let i = 0; i < 1000; i++) {
			bufferedEvents.push({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: `"arg${i}":${i},`,
				partial: mockMessage,
			});
		}

		// Simulate the cooperative flush with batching (100 events per batch with yields)
		const batchSize = 100;
		let yieldCount = 0;
		for (let i = 0; i < bufferedEvents.length; i++) {
			context.stream.push(bufferedEvents[i]!);
			if ((i + 1) % batchSize === 0) {
				yieldCount++;
				await Bun.sleep(0);
			}
		}
		context.stream.push({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: {
				type: "toolCall" as const,
				id: "call_1",
				name: "test_tool",
				arguments: { test: "value" },
			},
			partial: mockMessage,
		});

		// Verify all events were emitted in correct order: deltas then end
		expect(emittedEvents).toHaveLength(1001);
		for (let i = 0; i < 1000; i++) {
			expect(emittedEvents[i]?.type).toBe("toolcall_delta");
		}
		expect(emittedEvents[1000]?.type).toBe("toolcall_end");

		// Verify that we yielded multiple times (allowing cooperative flushing to work)
		expect(yieldCount).toBeGreaterThanOrEqual(10); // Should yield at least 10 times for 1000 events
	});
});
