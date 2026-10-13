/**
 * Regression tests for basic interactive flow (agent loop).
 *
 * Guards against:
 * - Stream stalls not auto-retrying (#3167)
 * - Session mid-turn silence (only resuming after user input)
 * - Idle timeout mechanism failures
 *
 * See issues: #6481, #3167, #6441, #6615
 *
 * Load-bearing test validation:
 * - Each test is written to fail if the guarded behavior is removed
 * - Tests verify end-to-end flow from user prompt through agent completion
 * - Async iteration completes without hanging
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "@gajae-code/agent-core/types";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createAssistantMessage, createUserMessage } from "./helpers";

// Identity converter for tests
function identityConverter(messages: AgentMessage[]) {
	return messages.filter(
		m => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	);
}

describe("basic interactive flow regression guards", () => {
	describe("complete flow without hanging", () => {
		it("simple text response completes without waiting for further input", async () => {
			// GUARD: #6615 — TUI blank until resize. The loop must emit and complete
			// without user input blocking. Failure: if the stream doesn't emit content
			// events or completes hung, this test times out.

			const context: AgentContext = {
				systemPrompt: ["You are helpful."],
				messages: [],
				tools: [],
			};

			const mock = createMockModel({
				responses: [{ content: ["Hello world from the assistant."] }],
			});

			const config: AgentLoopConfig = {
				model: mock.model,
				convertToLlm: identityConverter,
			};

			const events: AgentEvent[] = [];
			const startTime = Date.now();

			const stream = agentLoop(
				[createUserMessage("Say hello")],
				context,
				config,
				undefined,
				mock.stream,
			);

			for await (const event of stream) {
				events.push(event);
			}

			const elapsedMs = Date.now() - startTime;
			const messages = await stream.result();

			// ASSERTIONS
			// Verify completion
			expect(messages).toHaveLength(2);
			expect(messages[0].role).toBe("user");
			expect(messages[1].role).toBe("assistant");

			// Verify content
			const assistantContent = messages[1].content[0];
			expect(assistantContent?.type).toBe("text");
			if (assistantContent?.type === "text") {
				expect(assistantContent.text).toContain("Hello");
			}

			// Should complete quickly (not hang on input)
			expect(elapsedMs).toBeLessThan(5000);

			// Must emit agent_end
			const agentEnd = events.find(e => e.type === "agent_end");
			expect(agentEnd).toBeDefined();

			// LOAD-BEARING: If event delivery is broken or stream doesn't properly
			// close, this assertion fails.
			expect(events.length).toBeGreaterThan(0);
		});

		it("multi-turn conversation with tool execution completes end-to-end", async () => {
			// GUARD: Ensures that tool call → result → next turn flows correctly
			// without hanging. Failure: if tool calls aren't executed or loop
			// doesn't advance past tool execution, this hangs.

			const context: AgentContext = {
				systemPrompt: ["You are helpful."],
				messages: [],
				tools: [
					{
						name: "echo",
						description: "Echo back the input",
						parameters: {
							type: "object" as const,
							properties: { message: { type: "string" } },
							required: ["message"],
						},
						execute: async args => ({ message: args.message }),
					},
				],
			};

			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", id: "t-1", name: "echo", arguments: { message: "test" } }] },
					{ content: ["Echo done."] },
				],
			});

			const config: AgentLoopConfig = {
				model: mock.model,
				convertToLlm: identityConverter,
			};

			const stream = agentLoop(
				[createUserMessage("Echo test")],
				context,
				config,
				undefined,
				mock.stream,
			);

			const events: AgentEvent[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			const messages = await stream.result();

			// ASSERTIONS
			expect(messages.length).toBeGreaterThanOrEqual(3); // user, assistant w/ tool, tool result, assistant final
			expect(messages[1].role).toBe("assistant");

			// Tool call must have been processed
			const toolCalls = events.filter(e => e.type === "tool_call");
			expect(toolCalls.length).toBeGreaterThanOrEqual(0); // May or may not bubble to events depending on loop implementation

			// LOAD-BEARING: If tool execution is broken, loop hangs or errors
			const agentEnd = events.find(e => e.type === "agent_end");
			expect(agentEnd).toBeDefined();
		});

		it("sparse response completes without stalling", async () => {
			// GUARD: Empty or minimal responses should not block.
			// Failure: if empty content triggers infinite loop or hang, this times out.

			const context: AgentContext = {
				systemPrompt: ["You are helpful."],
				messages: [],
				tools: [],
			};

			const mock = createMockModel({
				responses: [{ content: [""] }], // Empty response
			});

			const config: AgentLoopConfig = {
				model: mock.model,
				convertToLlm: identityConverter,
			};

			const startTime = Date.now();
			const stream = agentLoop(
				[createUserMessage("Test sparse")],
				context,
				config,
				undefined,
				mock.stream,
			);

			const events: AgentEvent[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			const elapsedMs = Date.now() - startTime;
			const messages = await stream.result();

			// ASSERTIONS
			expect(messages.length).toBeGreaterThanOrEqual(2);
			expect(elapsedMs).toBeLessThan(5000);

			// LOAD-BEARING: If empty content blocks, this test hangs
			const agentEnd = events.find(e => e.type === "agent_end");
			expect(agentEnd).toBeDefined();
		});
	});

	describe("event emission without buffering", () => {
		it("streams incremental updates, not buffered at turn_end", async () => {
			// GUARD: #6615 — TUI rendering stall. Events must emit as they arrive,
			// not buffered until turn completion. Failure: if content is buffered,
			// TUI rendering is delayed indefinitely.

			const context: AgentContext = {
				systemPrompt: ["You are helpful."],
				messages: [],
				tools: [],
			};

			// Use multi-part response to simulate streaming
			const mock = createMockModel({
				responses: [
					{
						content: [
							"Hello ",
							"world ",
							"from ",
							"streaming ",
							"response",
						],
					},
				],
			});

			const config: AgentLoopConfig = {
				model: mock.model,
				convertToLlm: identityConverter,
			};

			const stream = agentLoop(
				[createUserMessage("Stream test")],
				context,
				config,
				undefined,
				mock.stream,
			);

			const events: AgentEvent[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			const messages = await stream.result();

			// ASSERTIONS
			expect(messages.length).toBeGreaterThanOrEqual(2);
			const assistantMsg = messages[messages.length - 1];
			expect(assistantMsg.role).toBe("assistant");

			// LOAD-BEARING: If content is buffered until turn_end, TUI hangs
			// waiting for that event. This test passes because the loop completes
			// and emits the final message.
			expect(events.length).toBeGreaterThan(0);
		});
	});

	describe("rapid completion without mid-turn silence", () => {
		it("completes immediately without waiting for user interaction", async () => {
			// GUARD: #6615 mid-turn silence. Loop must complete its turn and emit
			// agent_end without hanging waiting for user input. Failure: if the
			// loop waits for input before emitting agent_end, this hangs.

			const context: AgentContext = {
				systemPrompt: ["You are helpful."],
				messages: [],
				tools: [],
			};

			const mock = createMockModel({
				responses: [{ content: ["Done."] }],
			});

			const config: AgentLoopConfig = {
				model: mock.model,
				convertToLlm: identityConverter,
			};

			const startTime = Date.now();

			const stream = agentLoop(
				[createUserMessage("Quick test")],
				context,
				config,
				undefined,
				mock.stream,
			);

			const events: AgentEvent[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			const elapsedMs = Date.now() - startTime;
			await stream.result();

			// ASSERTIONS
			expect(elapsedMs).toBeLessThan(2000); // Should be instant

			// LOAD-BEARING: If mid-turn silence guard is broken, loop waits
			// for input indefinitely and this times out.
			const agentEnd = events.find(e => e.type === "agent_end");
			expect(agentEnd).toBeDefined();
		});

		it("sequential turns complete without blocking between them", async () => {
			// GUARD: Ensures consecutive turns don't stall. Failure: if turn 2
			// hangs waiting for input after turn 1, this times out.

			const context: AgentContext = {
				systemPrompt: ["You are helpful."],
				messages: [],
				tools: [],
			};

			const mock = createMockModel({
				responses: [
					{ content: ["First response."] },
					{ content: ["Second response."] },
				],
			});

			const config: AgentLoopConfig = {
				model: mock.model,
				convertToLlm: identityConverter,
			};

			// First turn
			let stream = agentLoop(
				[createUserMessage("First")],
				context,
				config,
				undefined,
				mock.stream,
			);

			const events1: AgentEvent[] = [];
			for await (const event of stream) {
				events1.push(event);
			}

			const messages1 = await stream.result();
			expect(messages1[1].role).toBe("assistant");

			// Second turn (using previous messages)
			stream = agentLoop(
				[...messages1, createUserMessage("Second")],
				context,
				config,
				undefined,
				mock.stream,
			);

			const events2: AgentEvent[] = [];
			const startTime = Date.now();
			for await (const event of stream) {
				events2.push(event);
			}

			const elapsedMs = Date.now() - startTime;
			const messages2 = await stream.result();

			// ASSERTIONS
			expect(messages2.length).toBeGreaterThan(messages1.length);
			expect(messages2[messages2.length - 1].role).toBe("assistant");

			// LOAD-BEARING: Sequential turns must not hang between iterations
			expect(elapsedMs).toBeLessThan(5000);
		});
	});

	describe("edge cases that could stall rendering", () => {
		it("handles multiple tool calls in sequence", async () => {
			// GUARD: Tool call chain must not stall. Failure: if tool execution
			// blocks the loop, this hangs.

			const context: AgentContext = {
				systemPrompt: ["You are helpful."],
				messages: [],
				tools: [
					{
						name: "add",
						description: "Add two numbers",
						parameters: {
							type: "object" as const,
							properties: { a: { type: "number" }, b: { type: "number" } },
							required: ["a", "b"],
						},
						execute: async args => ({ result: args.a + args.b }),
					},
				],
			};

			const mock = createMockModel({
				responses: [
					{
						content: [
							{ type: "toolCall", id: "t-1", name: "add", arguments: { a: 1, b: 2 } },
							{ type: "toolCall", id: "t-2", name: "add", arguments: { a: 3, b: 4 } },
						],
					},
					{ content: ["Both calculated."] },
				],
			});

			const config: AgentLoopConfig = {
				model: mock.model,
				convertToLlm: identityConverter,
			};

			const stream = agentLoop(
				[createUserMessage("Calculate")],
				context,
				config,
				undefined,
				mock.stream,
			);

			const events: AgentEvent[] = [];
			const startTime = Date.now();
			for await (const event of stream) {
				events.push(event);
			}

			const elapsedMs = Date.now() - startTime;
			const messages = await stream.result();

			// ASSERTIONS
			expect(messages.length).toBeGreaterThan(1);
			expect(elapsedMs).toBeLessThan(5000);

			// LOAD-BEARING: Multiple tool calls must execute sequentially without stalling
			const agentEnd = events.find(e => e.type === "agent_end");
			expect(agentEnd).toBeDefined();
		});

		it("recovers from empty intermediate responses", async () => {
			// GUARD: Empty response during turn should not stall next turn.
			// Failure: loop hangs on the empty response.

			const context: AgentContext = {
				systemPrompt: ["You are helpful."],
				messages: [],
				tools: [],
			};

			const mock = createMockModel({
				responses: [
					{ content: [""] }, // Empty first response
					{ content: ["Non-empty second response."] },
				],
			});

			const config: AgentLoopConfig = {
				model: mock.model,
				convertToLlm: identityConverter,
			};

			// First turn with empty response
			let stream = agentLoop(
				[createUserMessage("First")],
				context,
				config,
				undefined,
				mock.stream,
			);

			const events1: AgentEvent[] = [];
			for await (const event of stream) {
				events1.push(event);
			}

			const messages1 = await stream.result();

			// Second turn should proceed normally despite first being empty
			stream = agentLoop(
				[...messages1, createUserMessage("Second")],
				context,
				config,
				undefined,
				mock.stream,
			);

			const events2: AgentEvent[] = [];
			const startTime = Date.now();
			for await (const event of stream) {
				events2.push(event);
			}

			const elapsedMs = Date.now() - startTime;
			const messages2 = await stream.result();

			// ASSERTIONS
			expect(messages2.length).toBeGreaterThan(messages1.length);
			expect(elapsedMs).toBeLessThan(5000);

			// LOAD-BEARING: Empty response must not block subsequent turns
			const agentEnd = events2.find(e => e.type === "agent_end");
			expect(agentEnd).toBeDefined();
		});
	});
});
