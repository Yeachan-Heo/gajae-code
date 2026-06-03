import { describe, expect, it } from "bun:test";
import { agentLoop, agentLoopContinue, INTENT_FIELD } from "@gajae-code/agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolContext,
	ToolCallContext,
} from "@gajae-code/agent-core/types";
import type { AssistantMessage, Message, ToolResultMessage } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import * as z from "zod/v4";
import { createAssistantMessage, createUserMessage } from "./helpers";

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("agentLoop with AgentMessage", () => {
	it("should emit events with AgentMessage types", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};

		const mock = createMockModel({ responses: [{ content: ["Hi there!"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, mock.stream);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should have user message and assistant message
		expect(messages.length).toBe(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");

		// Verify event sequence
		const eventTypes = events.map(e => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("turn_start");
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes).toContain("agent_end");
	});

	it("emits an aborted assistant message when cancellation happens before provider events", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const mock = createMockModel();
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const controller = new AbortController();
		// The mock provider would reject without a configured response; we want the
		// agent's abort path to kick in before any event is emitted. Use a raw stream
		// that never emits anything.
		const streamFn = () => new AssistantMessageEventStream();

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("Hello")], context, config, controller.signal, streamFn);
		queueMicrotask(() => controller.abort());

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		const finalMessage = messages[messages.length - 1];
		expect(finalMessage.role).toBe("assistant");
		if (finalMessage.role !== "assistant") throw new Error("Expected assistant message");
		expect(finalMessage.stopReason).toBe("aborted");
		expect(finalMessage.errorMessage).toBe("Request was aborted");
		expect(events.map(event => event.type)).toContain("agent_end");
	});

	it("should handle custom message types via convertToLlm", async () => {
		// Create a custom message type
		interface CustomNotification {
			role: "notification";
			text: string;
			timestamp: number;
		}

		const notification: CustomNotification = {
			role: "notification",
			text: "This is a notification",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [notification as unknown as AgentMessage], // Custom message in context
			tools: [],
		};

		let convertedMessages: Message[] = [];
		const mock = createMockModel({ responses: [{ content: ["Response"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => {
				// Filter out notifications, convert rest
				convertedMessages = messages
					.filter(m => (m as { role: string }).role !== "notification")
					.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
				return convertedMessages;
			},
		};

		const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		// The notification should have been filtered out in convertToLlm
		expect(convertedMessages.length).toBe(1); // Only user message
		expect(convertedMessages[0].role).toBe("user");
	});

	it("should apply transformContext before convertToLlm", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [
				createUserMessage("old message 1"),
				createAssistantMessage([{ type: "text", text: "old response 1" }]),
				createUserMessage("old message 2"),
				createAssistantMessage([{ type: "text", text: "old response 2" }]),
			],
			tools: [],
		};

		let transformedMessages: AgentMessage[] = [];
		let convertedMessages: Message[] = [];

		const mock = createMockModel({ responses: [{ content: ["Response"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			transformContext: async messages => {
				// Keep only last 2 messages (prune old ones)
				transformedMessages = messages.slice(-2);
				return transformedMessages;
			},
			convertToLlm: messages => {
				convertedMessages = messages.filter(
					m => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				) as Message[];
				return convertedMessages;
			},
		};

		const stream = agentLoop([createUserMessage("new message")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		// transformContext should have been called first, keeping only last 2
		expect(transformedMessages.length).toBe(2);
		// Then convertToLlm receives the pruned messages
		expect(convertedMessages.length).toBe(2);
	});

	it("provides tool call batch context", async () => {
		const toolSchema = z.object({ value: z.string() });
		const contexts: ToolCallContext[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const toolCall = (ctx as { toolCall?: ToolCallContext })?.toolCall;
				if (toolCall) {
					contexts.push(toolCall);
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "world" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolContext: toolCall => ({ toolCall }) as AgentToolContext,
		};

		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		expect(contexts).toHaveLength(2);
		expect(contexts[0]?.batchId).toBe(contexts[1]?.batchId);
		expect(contexts[0]?.total).toBe(2);
		expect(contexts[0]?.toolCalls).toEqual([
			{ id: "tool-1", name: "echo" },
			{ id: "tool-2", name: "echo" },
		]);
		expect(contexts[0]?.index).toBe(0);
		expect(contexts[1]?.index).toBe(1);
	});

	it("pauses at the safe boundary after a tool call without aborting the tool", async () => {
		const toolSchema = z.object({ value: z.string() });
		let abortSeen = false;
		let toolCompleted = false;
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params, signal) {
				abortSeen = signal?.aborted ?? false;
				toolCompleted = true;
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		let pauseChecks = 0;
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["should not be requested after pause"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			shouldPause: () => {
				pauseChecks += 1;
				return toolCompleted;
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const event of stream) events.push(event);

		const agentEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "agent_end" }> => event.type === "agent_end",
		);
		expect(toolCompleted).toBe(true);
		expect(abortSeen).toBe(false);
		expect(pauseChecks).toBeGreaterThan(0);
		expect(agentEnd?.stopReason).toBe("paused");
	});

	it("processes queued steering before honoring a pause request", async () => {
		const toolSchema = z.object({ value: z.string() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		let steeringDelivered = false;
		let pauseRequested = false;
		let steeringPolls = 0;
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["ack steer"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			shouldPause: () => pauseRequested,
			getSteeringMessages: async () => {
				steeringPolls += 1;
				if (steeringPolls === 1 || pauseRequested || steeringDelivered) return [];
				steeringDelivered = true;
				pauseRequested = true;
				return [createUserMessage("steer before pause")];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const event of stream) events.push(event);

		const agentEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "agent_end" }> => event.type === "agent_end",
		);
		const messages = await stream.result();
		expect(messages.some(message => message.role === "user" && message.content === "steer before pause")).toBe(true);
		expect(
			messages.some(
				message =>
					message.role === "assistant" &&
					message.content[0]?.type === "text" &&
					message.content[0].text === "ack steer",
			),
		).toBe(true);
		expect(agentEnd?.stopReason).toBe("paused");
	});

	it("should handle tool calls and results", async () => {
		const toolSchema = z.object({ value: z.string() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);

		for await (const event of stream) {
			events.push(event);
		}

		// Tool should have been executed
		expect(executed).toEqual(["hello"]);

		// Should have tool execution events
		const toolStart = events.find(e => e.type === "tool_execution_start");
		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolStart).toBeDefined();
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBeFalsy();
		}
	});

	it("injects and strips intent when intent tracing is enabled", async () => {
		const toolSchema = z.object({ value: z.string() });
		const executedParams: Record<string, unknown>[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executedParams.push(params as Record<string, unknown>);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tool-1",
							name: "echo",
							arguments: { value: "hello", [INTENT_FIELD]: "Read one file" },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			intentTracing: true,
		};

		const stream = agentLoop([createUserMessage("run")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		const messages = await stream.result();
		const assistantWithToolCall = messages.find(
			message => message.role === "assistant" && message.content.some(content => content.type === "toolCall"),
		) as AssistantMessage | undefined;
		const tracedToolCall = assistantWithToolCall?.content.find(content => content.type === "toolCall");

		const firstRequestToolSchema = mock.calls[0]?.context.tools?.[0]?.parameters as
			| { properties?: Record<string, unknown>; required?: string[] }
			| undefined;
		expect(firstRequestToolSchema?.properties).toMatchObject({
			value: { type: "string" },
			[INTENT_FIELD]: { type: "string" },
		});
		expect(firstRequestToolSchema?.required).toEqual(expect.arrayContaining([INTENT_FIELD]));
		expect(executedParams).toEqual([{ value: "hello" }]);
		expect(tracedToolCall?.type).toBe("toolCall");
		if (tracedToolCall?.type === "toolCall") {
			expect(tracedToolCall.intent).toBe("Read one file");
		}
	});

	it("runs shared tools in parallel and emits completion-ordered results", async () => {
		const toolSchema = z.object({ value: z.string() });
		const startTimes: Record<string, number> = {};
		const finishTimes: Record<string, number> = {};
		const { promise: slowContinue, resolve: slowResolve } = Promise.withResolvers<void>();
		const { promise: slowStarted, resolve: slowStartedResolve } = Promise.withResolvers<void>();
		const { promise: fastFinished, resolve: fastFinishedResolve } = Promise.withResolvers<void>();

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				if (params.value === "slow") {
					startTimes.slow = Bun.nanoseconds();
					slowStartedResolve();
					await slowContinue;
					finishTimes.slow = Bun.nanoseconds();
				} else {
					await slowStarted;
					startTimes.fast = Bun.nanoseconds();
					finishTimes.fast = Bun.nanoseconds();
					fastFinishedResolve();
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "slow" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "fast" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		const streamTask = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
		})();

		await fastFinished;
		slowResolve();
		await streamTask;

		expect(startTimes.fast).toBeDefined();
		expect(startTimes.slow).toBeDefined();
		expect(finishTimes.fast).toBeDefined();
		expect(finishTimes.slow).toBeDefined();
		expect(startTimes.fast).toBeLessThan(finishTimes.slow);
		expect(finishTimes.fast).toBeLessThan(finishTimes.slow);

		const toolResultStarts = events.filter(
			(e): e is Extract<AgentEvent, { type: "message_start" }> =>
				e.type === "message_start" && e.message.role === "toolResult",
		);
		expect(toolResultStarts).toHaveLength(2);
		expect((toolResultStarts[0].message as ToolResultMessage).toolCallId).toBe("tool-2");
		expect((toolResultStarts[1].message as ToolResultMessage).toolCallId).toBe("tool-1");

		const turnEndEvent = events.find((e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end");
		expect(turnEndEvent).toBeDefined();
		if (!turnEndEvent) return;
		expect(turnEndEvent.toolResults.map(result => result.toolCallId)).toEqual(["tool-2", "tool-1"]);
	});

	it("emits an explicit warning toolResult when assistant aborts after issuing tool calls", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};

		const abortController = new AbortController();
		const mock = createMockModel();
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		// Custom stream: emit a partial start with a tool call, abort, then push done.
		// The mock provider doesn't model "abort between start and done"; do it inline.
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "yield", arguments: { data: { ok: true } } }],
					"toolUse",
				);
				stream.push({ type: "start", partial });
				setTimeout(() => {
					abortController.abort();
					stream.push({ type: "done", reason: "toolUse", message: partial });
				}, 0);
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, abortController.signal, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const toolResultEvent = events.find(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "toolResult",
		);
		expect(toolResultEvent).toBeDefined();
		if (toolResultEvent?.message.role !== "toolResult") return;
		expect(toolResultEvent.message.isError).toBe(true);
		expect(toolResultEvent.message.toolCallId).toBe("tool-1");
		expect(toolResultEvent.message.content[0]?.type).toBe("text");
		if (toolResultEvent.message.content[0]?.type === "text") {
			const text = toolResultEvent.message.content[0].text;
			expect(text).toContain("Tool execution was aborted");
			expect(text).not.toContain("Tool execution was aborted.:");
		}
	});

	it("should skip remaining tool calls when steering is queued", async () => {
		const toolSchema = z.object({ value: z.string() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const queuedUserMessage = createUserMessage("interrupt");
		let queuedDelivered = false;

		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["done"] },
			],
		});

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			getSteeringMessages: async () => {
				// Return steering message after tool execution has started
				if (executed.length >= 1 && !queuedDelivered) {
					queuedDelivered = true;
					return [queuedUserMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		// Only the first tool should execute; the second is skipped after steering is queued.
		expect(executed).toEqual(["first"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[1].isError).toBe(true);
		if (toolEnds[1].result.content[0]?.type === "text") {
			expect(toolEnds[1].result.content[0].text).toContain("Skipped due to queued user message");
		}

		// Queued message should appear in events after the tool results and before the next model call.
		const eventSequence = events.flatMap(event => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(eventSequence).toContain("interrupt");
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));

		// Interrupt message should be in context when second LLM call is made
		const sawInterruptInContext = mock.calls[1]?.context.messages.some(
			m => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
		);
		expect(sawInterruptInContext).toBe(true);
	});
});

it("refreshes tools and system prompt between same-turn model calls", async () => {
	const toolSchema = z.object({ value: z.string() });
	let activeSystemPrompt = "prompt-one";
	let activeTools: Array<AgentTool<typeof toolSchema, { value: string }>> = [];
	const betaTool: AgentTool<typeof toolSchema, { value: string }> = {
		name: "beta",
		label: "Beta",
		description: "Beta tool",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `beta:${params.value}` }],
				details: { value: params.value },
			};
		},
	};
	const alphaTool: AgentTool<typeof toolSchema, { value: string }> = {
		name: "alpha",
		label: "Alpha",
		description: "Alpha tool",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			activeSystemPrompt = "prompt-two";
			activeTools = [alphaTool, betaTool];
			return {
				content: [{ type: "text", text: `alpha:${params.value}` }],
				details: { value: params.value },
			};
		},
	};
	activeTools = [alphaTool];

	const context: AgentContext = {
		systemPrompt: [activeSystemPrompt],
		messages: [],
		tools: activeTools,
	};
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
			{ content: ["done"] },
		],
	});
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		syncContextBeforeModelCall: async currentContext => {
			currentContext.systemPrompt = [activeSystemPrompt];
			currentContext.tools = activeTools;
		},
	};

	const stream = agentLoop([createUserMessage("refresh tools")], context, config, undefined, mock.stream);
	for await (const _ of stream) {
		// drain
	}

	expect(mock.calls).toHaveLength(2);
	expect(mock.calls[0]?.context.systemPrompt).toEqual(["prompt-one"]);
	expect(mock.calls[0]?.context.tools?.map(tool => tool.name)).toEqual(["alpha"]);
	expect(mock.calls[1]?.context.systemPrompt).toEqual(["prompt-two"]);
	expect(mock.calls[1]?.context.tools?.map(tool => tool.name)).toEqual(["alpha", "beta"]);
});

describe("agentLoopContinue with AgentMessage", () => {
	it("should throw when context has no messages", () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};

		const mock = createMockModel();
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		expect(() => agentLoopContinue(context, config)).toThrow("Cannot continue: no messages in context");
	});

	it("should continue from existing context without emitting user message events", async () => {
		const userMessage = createUserMessage("Hello");

		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [userMessage],
			tools: [],
		};

		const mock = createMockModel({ responses: [{ content: ["Response"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, config, undefined, mock.stream);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should only return the new assistant message (not the existing user message)
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");

		// Should NOT have user message events (that's the key difference from agentLoop)
		const messageEndEvents = events.filter(e => e.type === "message_end");
		expect(messageEndEvents.length).toBe(1);
		const firstEnd = messageEndEvents[0];
		if (firstEnd?.type !== "message_end") throw new Error("Expected message_end");
		expect(firstEnd.message.role).toBe("assistant");
	});

	it("should allow custom message types as last message (caller responsibility)", async () => {
		// Custom message that will be converted to user message by convertToLlm
		interface HookMessage {
			role: "hookMessage";
			text: string;
			timestamp: number;
		}

		const hookMessage: HookMessage = {
			role: "hookMessage",
			text: "Hook content",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [hookMessage as unknown as AgentMessage],
			tools: [],
		};

		const mock = createMockModel({ responses: [{ content: ["Response to hook"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => {
				// Convert hookMessage to user message
				return messages
					.map(m => {
						const candidate = m as unknown as Partial<HookMessage>;
						if (candidate.role === "hookMessage") {
							return {
								role: "user" as const,
								content: candidate.text ?? "",
								timestamp: candidate.timestamp ?? Date.now(),
							};
						}
						return m;
					})
					.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
			},
		};

		// Should not throw - the hookMessage will be converted to user message
		const stream = agentLoopContinue(context, config, undefined, mock.stream);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");
	});

	it("blocks tool execution when beforeToolCall returns block", async () => {
		const toolSchema = z.object({ value: z.string() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			beforeToolCall: async () => ({ block: true, reason: "policy: blocked" }),
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		expect(executed).toEqual([]);
		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(true);
			expect(JSON.stringify(toolEnd.result)).toContain("policy: blocked");
		}
	});

	it("passes beforeToolCall args mutations into tool.execute without revalidation", async () => {
		const toolSchema = z.object({ value: z.string() });
		const executed: Array<string | number> = [];
		const tool: AgentTool<typeof toolSchema, { value: string | number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value as string | number);
				return {
					content: [{ type: "text", text: `echoed: ${String(params.value)}` }],
					details: { value: params.value as string | number },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			beforeToolCall: async ({ args }) => {
				(args as { value: string | number }).value = 123;
				return undefined;
			},
		};

		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		expect(executed).toEqual([123]);
	});

	it("afterToolCall overrides content and isError on the emitted tool result", async () => {
		const toolSchema = z.object({ value: z.string() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `original: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const seen: Array<{ args: unknown; isError: boolean }> = [];
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			afterToolCall: async ({ args, isError }) => {
				seen.push({ args, isError });
				return {
					content: [{ type: "text", text: "rewritten" }],
					isError: true,
				};
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		expect(seen).toEqual([{ args: { value: "hello" }, isError: false }]);

		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(true);
			expect(toolEnd.result.content).toEqual([{ type: "text", text: "rewritten" }]);
			// details preserved when override omits the field
			expect(toolEnd.result.details).toEqual({ value: "hello" });
		}

		const toolResultMessage = events
			.filter(e => e.type === "message_start")
			.map(e => (e.type === "message_start" ? e.message : undefined))
			.find((m): m is AgentMessage => m !== undefined && m.role === "toolResult");
		expect(toolResultMessage).toBeDefined();
		if (toolResultMessage && toolResultMessage.role === "toolResult") {
			expect(toolResultMessage.isError).toBe(true);
			expect(toolResultMessage.content).toEqual([{ type: "text", text: "rewritten" }]);
		}
	});

	it("surfaces afterToolCall errors as a tool error result", async () => {
		const toolSchema = z.object({ value: z.string() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `ok: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			afterToolCall: async () => {
				throw new Error("hook exploded");
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			events.push(event);
		}

		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(true);
			expect(JSON.stringify(toolEnd.result)).toContain("hook exploded");
		}
	});
	it("runs onBeforeYield before polling follow-up messages", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const queuedFollowUps: AgentMessage[] = [];
		let hookCalls = 0;
		const mock = createMockModel({
			responses: [{ content: ["first"] }, { content: ["second"] }],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onBeforeYield: () => {
				hookCalls++;
				if (hookCalls === 1) {
					queuedFollowUps.push(createUserMessage("follow-up"));
				}
			},
			getFollowUpMessages: async () => queuedFollowUps.splice(0),
		};

		const stream = agentLoop([createUserMessage("initial")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		const messages = await stream.result();
		expect(hookCalls).toBe(2);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(messages[2]).toMatchObject({ role: "user", content: "follow-up" });
	});
});
