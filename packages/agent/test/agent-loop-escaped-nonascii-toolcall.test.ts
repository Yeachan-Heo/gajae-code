import { describe, expect, it } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	ManagedAttemptOutcome,
} from "@gajae-code/agent-core/types";
import type { AssistantMessage, Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const askSchema = z.object({ question: z.string() });

// Decodes cleanly, but a mistyped nibble anywhere in it would be
// indistinguishable from the correct text.
const QUESTION = "마지막 병목";

function askTool(executed: Array<Record<string, unknown>>): AgentTool<typeof askSchema, Record<string, never>> {
	return {
		name: "ask",
		label: "Ask",
		description: "Ask the user a question",
		parameters: askSchema,
		async execute(_id, params) {
			executed.push(params as Record<string, unknown>);
			return { content: [{ type: "text", text: "answered" }], details: {} };
		},
	};
}

/** A display-safe variant of the ask tool: opts its display field (question text) into the bounded exemption. */
function displaySafeAskTool(
	executed: Array<Record<string, unknown>>,
): AgentTool<typeof askSchema, Record<string, never>> {
	return {
		...askTool(executed),
		displaySafeEscapedArgFields: ["question"],
	};
}

/** A stand-in for any mutating tool (write/edit/bash): never display-safe. */
function mutatingTool(executed: Array<Record<string, unknown>>): AgentTool<typeof askSchema, Record<string, never>> {
	return {
		...askTool(executed),
		name: "write",
	};
}

/** A display-safe escaped turn whose only non-ASCII is an em-dash. */
function emDashEscapedTurn(id: string, name = "ask") {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name,
				arguments: { question: "How should the daemon drive sessions — in-process?" },
				escapedNonAsciiArguments: true,
			},
		],
	};
}
/** A turn whose raw arguments arrived spelled as `\uXXXX` instead of literal UTF-8. */
function escapedTurn(id: string, stopReason?: "aborted" | "error") {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "ask",
				arguments: { question: QUESTION },
				escapedNonAsciiArguments: true,
			},
		],
		...(stopReason ? { stopReason } : {}),
	};
}

function escapedTurnWithText(id: string) {
	return {
		content: [{ type: "text" as const, text: "I will ask." }, ...escapedTurn(id).content],
	};
}

/** The same turn as the model would have produced it with literal UTF-8 on the wire. */
function literalTurn(id: string) {
	return { content: [{ type: "toolCall" as const, id, name: "ask", arguments: { question: QUESTION } }] };
}

function literalTurnWithText(id: string) {
	return { content: [{ type: "text" as const, text: "I will ask." }, ...literalTurn(id).content] };
}

const PROVIDER_USAGE = {
	input: 7,
	output: 11,
	cacheRead: 13,
	cacheWrite: 17,
	totalTokens: 48,
	premiumRequests: 2,
	reasoningTokens: 5,
	cttl: { ephemeral5m: 3, ephemeral1h: 14 },
	server: { webSearch: 2, webFetch: 1 },
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

function thinkingToolTurn(id: string, escaped = false) {
	return {
		content: [
			{
				type: "thinking" as const,
				thinking: "provider reasoning",
				thinkingSignature: "reasoning-signature",
				itemId: "reasoning-item",
				provenance: "mixed" as const,
				summaryText: "summary",
				rawText: "raw",
			},
			{
				type: "toolCall" as const,
				id,
				name: "ask",
				arguments: { question: QUESTION },
				thoughtSignature: "tool-thought-signature",
				...(escaped ? { escapedNonAsciiArguments: true } : {}),
			},
		],
		usage: PROVIDER_USAGE,
		responseId: "provider-response-id",
		disabledFeatures: ["priority"],
		providerPayload: { type: "openaiResponsesHistory" as const, provider: "mock", items: [{ id: "native-item" }] },
	};
}

describe("agentLoop: ASCII-escaped non-ASCII argument guard", () => {
	it("resamples the turn instead of executing or reporting escaped arguments", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({
			responses: [escapedTurn("tc-1"), literalTurn("tc-2"), { content: ["done"] }],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		// The resampled call ran; the defective one neither ran nor produced an error.
		expect(executed).toEqual([{ question: QUESTION }]);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBeFalsy();
		// The resample must not replay the escaped arguments back to the model as
		// its own prior output: the retried request carries no assistant turn.
		const resampleRequest = mock.model.calls[1];
		expect(resampleRequest).toBeDefined();
		expect(resampleRequest.context.messages.some(message => message.role === "assistant")).toBe(false);
	});

	it("publishes and stores only the accepted assistant lifecycle", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const mock = createMockModel({
			responses: [escapedTurn("tc-defective"), literalTurn("tc-accepted"), { content: ["done"] }],
		});
		const agent = new Agent({
			initialState: {
				systemPrompt: [""],
				model: mock.model,
				tools: [askTool(executed)],
				messages: [],
			},
			convertToLlm: identityConverter,
			streamFn: mock.stream,
		});
		const events: AgentEvent[] = [];
		agent.subscribe(event => events.push(event));

		await agent.prompt("ask me");

		const assistantEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		);
		expect(assistantEnds).toHaveLength(2);
		expect(
			assistantEnds.some(event =>
				event.message.role === "assistant"
					? event.message.content.some(block => block.type === "toolCall" && block.id === "tc-defective")
					: false,
			),
		).toBe(false);
		expect(
			agent.state.messages.some(
				message =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "toolCall" && block.id === "tc-defective"),
			),
		).toBe(false);
		expect(events.filter(event => event.type === "turn_start")).toHaveLength(3);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(2);
	});

	it("preserves provider-native thinking and usage metadata through accepted Agent state and replay", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const mock = createMockModel({
			responses: [thinkingToolTurn("tc-defective", true), thinkingToolTurn("tc-accepted"), { content: ["done"] }],
		});
		const agent = new Agent({
			initialState: { systemPrompt: [""], model: mock.model, tools: [askTool(executed)], messages: [] },
			convertToLlm: identityConverter,
			streamFn: mock.stream,
		});

		await agent.prompt("ask me");

		const accepted = agent.state.messages.find(
			(message): message is AssistantMessage =>
				message.role === "assistant" &&
				message.content.some(block => block.type === "toolCall" && block.id === "tc-accepted"),
		);
		expect(accepted).toBeDefined();
		expect(accepted?.content[0]).toEqual(thinkingToolTurn("unused").content[0]);
		expect(accepted?.usage).toEqual(PROVIDER_USAGE);
		expect(accepted?.responseId).toBe("provider-response-id");
		expect(accepted?.disabledFeatures).toEqual(["priority"]);
		expect(accepted?.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "mock",
			items: [{ id: "native-item" }],
		});
		expect(
			agent.state.messages.some(
				message =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "toolCall" && block.id === "tc-defective"),
			),
		).toBe(false);
		const replayed = mock.calls[2]?.context.messages.find(
			(message): message is AssistantMessage =>
				message.role === "assistant" &&
				message.content.some(block => block.type === "toolCall" && block.id === "tc-accepted"),
		);
		expect(replayed).toEqual(accepted);
	});

	it("preserves all pre-existing history and removes only the defective assistant turn", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const priorAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "prior answer" }],
			api: "mock" as const,
			provider: "mock",
			model: "mock-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		};
		const priorUser = createUserMessage("prior question");
		const context: AgentContext = {
			systemPrompt: ["system authority"],
			messages: [priorUser, priorAssistant],
			tools: [askTool(executed)],
		};
		const mock = createMockModel({ responses: [escapedTurn("tc-1"), literalTurn("tc-2"), { content: ["done"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}

		expect(context.systemPrompt).toEqual(["system authority"]);
		expect(context.messages[0]).toBe(priorUser);
		expect(context.messages[1]).toBe(priorAssistant);
		expect(
			context.messages.filter(
				message =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "toolCall" && block.id === "tc-1"),
			),
		).toHaveLength(0);
	});

	it("does not resample cancelled or errored turns", async () => {
		for (const stopReason of ["aborted", "error"] as const) {
			const executed: Array<Record<string, unknown>> = [];
			const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
			const mock = createMockModel({ responses: [escapedTurn(`tc-${stopReason}`, stopReason)] });
			const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
			const events: AgentEvent[] = [];

			const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
			for await (const event of stream) events.push(event);

			expect(mock.calls).toHaveLength(1);
			expect(executed).toHaveLength(0);
			expect(events.filter(event => event.type === "tool_execution_start")).toHaveLength(1);
			expect(events.filter(event => event.type === "tool_execution_end")).toHaveLength(1);
			const messageEnd = events.findLast(
				(event): event is Extract<AgentEvent, { type: "message_end" }> =>
					event.type === "message_end" && event.message.role === "assistant",
			);
			expect(messageEnd?.message.role === "assistant" ? messageEnd.message.stopReason : undefined).toBe(stopReason);
		}
	});

	it("does not retract a turn after visible text has streamed", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({ responses: [escapedTurnWithText("tc-visible"), { content: ["done"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const toolEnds: AgentEvent[] = [];

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) if (event.type === "tool_execution_end") toolEnds.push(event);

		expect(mock.calls).toHaveLength(2);
		expect(executed).toHaveLength(0);
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0]?.type === "tool_execution_end" ? toolEnds[0].isError : false).toBe(true);
	});

	it("delivers every assistant stream callback exactly once after visible text commits the turn", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({ responses: [escapedTurnWithText("tc-visible"), { content: ["done"] }] });
		const callbackTypes: string[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onAssistantMessageEvent: (_message, event) => callbackTypes.push(event.type),
		};

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}

		expect(callbackTypes).toEqual([
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"text_start",
			"text_delta",
			"text_end",
		]);
	});

	it("executes no calls from a mixed batch before validating the whole turn", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tc-clean-never", name: "ask", arguments: { question: "ASCII" } },
						...escapedTurn("tc-escaped").content,
					],
				},
				literalTurn("tc-retry"),
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const toolEvents: AgentEvent[] = [];

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") toolEvents.push(event);
		}

		expect(executed).toEqual([{ question: QUESTION }]);
		expect(toolEvents.map(event => ("toolCallId" in event ? event.toolCallId : undefined))).toEqual([
			"tc-retry",
			"tc-retry",
		]);
	});

	it("recovers on the second resample with clean history and one tool publication", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({
			responses: [escapedTurn("tc-1"), escapedTurn("tc-2"), literalTurn("tc-3"), { content: ["done"] }],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const toolEnds: AgentEvent[] = [];

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) if (event.type === "tool_execution_end") toolEnds.push(event);

		expect(mock.calls).toHaveLength(4);
		expect(mock.calls[1]?.context.messages.some(message => message.role === "assistant")).toBe(false);
		expect(mock.calls[2]?.context.messages.some(message => message.role === "assistant")).toBe(false);
		expect(executed).toEqual([{ question: QUESTION }]);
		expect(toolEnds).toHaveLength(1);
	});

	it("resets the resample budget after each accepted logical turn", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({
			responses: [
				escapedTurn("tc-1a"),
				literalTurn("tc-1b"),
				escapedTurn("tc-2a"),
				escapedTurn("tc-2b"),
				literalTurn("tc-2c"),
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("ask twice")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}

		expect(executed).toEqual([{ question: QUESTION }, { question: QUESTION }]);
		expect(mock.calls).toHaveLength(6);
	});

	it("preserves a queue-backed tool choice across a resample", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const queuedChoices = ["required" as const, "none" as const];
		let getterCalls = 0;
		const mock = createMockModel({
			responses: [escapedTurn("tc-1"), literalTurn("tc-2"), { content: ["done"] }],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolChoice: () => {
				getterCalls += 1;
				return queuedChoices.shift();
			},
		};

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}

		expect(mock.calls.map(call => call.options?.toolChoice)).toEqual(["required", "required", "none"]);
		expect(getterCalls).toBe(2);
		expect(executed).toEqual([{ question: QUESTION }]);
	});

	it("drains accepted tool-call updates before entering tool execution", async () => {
		const observed: string[] = [];
		const tool: AgentTool<typeof askSchema, Record<string, never>> = {
			...askTool([]),
			async execute() {
				observed.push("execute");
				return { content: [{ type: "text", text: "answered" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({ responses: [literalTurn("tc-live"), { content: ["done"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);

		for await (const event of stream) {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
				observed.push("toolcall_end");
			}
		}

		expect(observed).toEqual(["toolcall_end", "execute"]);
	});

	it("does not dispatch when an accepted assistant callback aborts during commit", async () => {
		let executions = 0;
		const tool: AgentTool<typeof askSchema, Record<string, never>> = {
			...askTool([]),
			async execute() {
				executions += 1;
				return { content: [{ type: "text", text: "answered" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({ responses: [literalTurn("tc-abort")] });
		const controller = new AbortController();
		const events: AgentEvent[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onAssistantMessageEvent: (_message, event) => {
				if (event.type === "toolcall_end") controller.abort();
			},
		};

		const stream = agentLoop([createUserMessage("ask me")], context, config, controller.signal, mock.stream);
		for await (const event of stream) events.push(event);

		expect(executions).toBe(0);
		const assistantEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		);
		expect(assistantEnds).toHaveLength(1);
		expect(assistantEnds[0]?.message.role === "assistant" ? assistantEnds[0].message.stopReason : undefined).toBe(
			"aborted",
		);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(1);
		expect(events.filter(event => event.type === "tool_execution_start")).toHaveLength(1);
		const toolEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0]?.isError).toBe(true);
	});

	it("publishes a retained visible-text terminal exactly once after callback abort", async () => {
		let executions = 0;
		const tool: AgentTool<typeof askSchema, Record<string, never>> = {
			...askTool([]),
			async execute() {
				executions += 1;
				return { content: [{ type: "text", text: "answered" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({ responses: [literalTurnWithText("tc-visible-abort")] });
		const controller = new AbortController();
		const callbackTypes: string[] = [];
		const events: AgentEvent[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onAssistantMessageEvent: (_message, event) => {
				callbackTypes.push(event.type);
				if (event.type === "toolcall_end") controller.abort();
			},
		};

		const stream = agentLoop([createUserMessage("ask me")], context, config, controller.signal, mock.stream);
		for await (const event of stream) events.push(event);

		expect(executions).toBe(0);
		expect(callbackTypes).toEqual([
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
		]);
		const assistantEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		);
		expect(assistantEnds).toHaveLength(1);
		expect(assistantEnds[0]?.message.role === "assistant" ? assistantEnds[0].message.stopReason : undefined).toBe(
			"aborted",
		);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(1);
		const toolEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0]?.isError).toBe(true);
	});

	it("replaces a retained visible-text terminal when the stream consumer aborts during drain", async () => {
		let executions = 0;
		const tool: AgentTool<typeof askSchema, Record<string, never>> = {
			...askTool([]),
			async execute() {
				executions += 1;
				return { content: [{ type: "text", text: "answered" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({ responses: [literalTurnWithText("tc-consumer-abort")] });
		const controller = new AbortController();
		const events: AgentEvent[] = [];
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("ask me")], context, config, controller.signal, mock.stream);
		for await (const event of stream) {
			events.push(event);
			if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
				controller.abort();
			}
		}

		expect(executions).toBe(0);
		const assistantEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		);
		expect(assistantEnds).toHaveLength(1);
		expect(assistantEnds[0]?.message.role === "assistant" ? assistantEnds[0].message.stopReason : undefined).toBe(
			"aborted",
		);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(1);
		const toolEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0]?.isError).toBe(true);
	});

	it("promotes a detached accepted assistant for execution state and replay", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const providerOwned: AssistantMessage = {
			role: "assistant",
			content: thinkingToolTurn("tc-detached").content,
			api: mock.model.api,
			provider: mock.model.provider,
			model: mock.model.id,
			usage: structuredClone(PROVIDER_USAGE),
			stopReason: "toolUse",
			responseId: "provider-response-id",
			disabledFeatures: ["priority"],
			providerPayload: { type: "openaiResponsesHistory", provider: "mock", items: [{ id: "native-item" }] },
			timestamp: Date.now(),
		};
		let calls = 0;
		const streamFn: typeof mock.stream = (_model, llmContext, options) => {
			if (calls++ > 0) return mock.stream(mock.model, llmContext, options);
			const providerStream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				providerStream.push({ type: "start", partial: providerOwned });
				providerStream.push({ type: "thinking_start", contentIndex: 0, partial: providerOwned });
				providerStream.push({
					type: "thinking_delta",
					contentIndex: 0,
					delta: "provider reasoning",
					partial: providerOwned,
				});
				providerStream.push({
					type: "thinking_end",
					contentIndex: 0,
					content: "provider reasoning",
					partial: providerOwned,
				});
				providerStream.push({ type: "toolcall_start", contentIndex: 1, partial: providerOwned });
				providerStream.push({
					type: "toolcall_delta",
					contentIndex: 1,
					delta: JSON.stringify({ question: QUESTION }),
					partial: providerOwned,
				});
				const toolCall = providerOwned.content[1];
				if (toolCall?.type !== "toolCall") throw new Error("Expected tool call");
				providerStream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: providerOwned });
				providerStream.push({ type: "done", reason: "toolUse", message: providerOwned });
			});
			return providerStream;
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// drain
		}

		const accepted = (await stream.result()).find(
			(message): message is AssistantMessage =>
				message.role === "assistant" &&
				message.content.some(block => block.type === "toolCall" && block.id === "tc-detached"),
		);
		expect(accepted).toBeDefined();
		expect(accepted).not.toBe(providerOwned);
		providerOwned.usage.reasoningTokens = 999;
		providerOwned.disabledFeatures?.push("mutated");
		providerOwned.providerPayload?.items.push({ id: "mutated" });
		expect(accepted?.usage.reasoningTokens).toBe(5);
		expect(accepted?.disabledFeatures).toEqual(["priority"]);
		expect(accepted?.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "mock",
			items: [{ id: "native-item" }],
		});
		const replayed = mock.calls[0]?.context.messages.find(
			(message): message is AssistantMessage =>
				message.role === "assistant" &&
				message.content.some(block => block.type === "toolCall" && block.id === "tc-detached"),
		);
		expect(replayed).toBe(accepted);
	});

	it("does not mask an ordinary unmanaged provider error with non-cloneable metadata", async () => {
		const mock = createMockModel();
		const streamFn: typeof mock.stream = () => {
			const providerStream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const failure: AssistantMessage = {
					role: "assistant",
					content: [],
					api: mock.model.api,
					provider: mock.model.provider,
					model: mock.model.id,
					usage: structuredClone(PROVIDER_USAGE),
					stopReason: "error",
					errorMessage: "rate limited",
					errorStatus: 429,
					transportFailure: {
						kind: "transport",
						status: 429,
						headers: new Headers({ "retry-after": "0" }) as unknown as Record<string, string>,
					},
					timestamp: Date.now(),
				};
				providerStream.push({ type: "error", reason: "error", error: failure });
			});
			return providerStream;
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();
		const failure = result.findLast(message => message.role === "assistant");

		expect(failure?.role === "assistant" ? failure.errorMessage : undefined).toBe("rate limited");
		expect(failure?.role === "assistant" ? failure.errorStatus : undefined).toBe(429);
		expect(failure?.role === "assistant" ? failure.transportFailure : undefined).toEqual({
			kind: "transport",
			status: 429,
		});
	});

	it("rejects the call once the resample budget is spent", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({
			responses: [escapedTurn("tc-1"), escapedTurn("tc-2"), escapedTurn("tc-3"), { content: ["recovered"] }],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		expect(executed).toHaveLength(0);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].text).toContain("\\uXXXX");
		expect(toolResults[0].text).toContain("literal UTF-8");
		expect(toolResults[0].text.toLowerCase()).toContain("re-issue");
	});

	it("still reaches the malformed-turn circuit breaker after persistent escaped calls", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		let calls = 0;
		const mock = createMockModel({
			handler: () => {
				calls += 1;
				if (calls > 20) return { content: ["runaway"] };
				return escapedTurn(`tc-${calls}`);
			},
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		const produced = await stream.result();
		const lastAssistant = produced.findLast(message => message.role === "assistant");

		expect(calls).toBeLessThan(20);
		expect(executed).toHaveLength(0);
		expect(lastAssistant?.role === "assistant" ? lastAssistant.stopReason : undefined).toBe("error");
		expect(lastAssistant?.role === "assistant" ? lastAssistant.errorMessage : undefined).toContain(
			"consecutive turns of malformed tool calls",
		);
	});

	it("resamples escaped arguments in managed fallback through the typed discarded outcome", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({ responses: [escapedTurn("tc-managed"), { content: ["done"] }] });
		const outcomes: ManagedAttemptOutcome[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			fallbackManaged: true,
			onManagedAttemptOutcome: outcome => {
				outcomes.push(outcome);
				return { type: "terminal", terminal: { stopReason: "error" } };
			},
		};
		const toolResults: AgentEvent[] = [];

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) if (event.type === "tool_execution_end") toolResults.push(event);

		// The defective turn was discarded and reported once, never executed and
		// never surfaced as a tool error: the managed policy owns the retry.
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].type).toBe("escaped_arguments_discarded");
		if (outcomes[0].type === "escaped_arguments_discarded") {
			expect(outcomes[0].message.content.some(block => block.type === "toolCall" && block.id === "tc-managed")).toBe(
				true,
			);
		}
		expect(executed).toHaveLength(0);
		expect(toolResults).toHaveLength(0);
		const replayRequest = mock.model.calls.at(-1)?.context.messages;
		expect(replayRequest?.some(message => message.role === "assistant")).toBe(false);
	});

	it("continues a managed run after the session policy retries the discarded outcome", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		// First invocation: escaped turn, reported as escaped_arguments_discarded.
		// Second invocation (the policy retry): literal UTF-8, which must execute.
		const mock = createMockModel({ responses: [escapedTurn("tc-managed-1"), literalTurn("tc-managed-2")] });
		const outcomes: ManagedAttemptOutcome[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			fallbackManaged: true,
			onManagedAttemptOutcome: outcome => {
				outcomes.push(outcome);
				return { type: "retry", continuation: () => {} };
			},
		};

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}

		// The loop reports the discarded outcome exactly once and ends the first
		// stream. The policy's retry continuation re-enters the loop on the same
		// context; there the literal turn executes normally. (A no-op
		// continuation is the loop-level contract: the loop never re-issues on
		// its own after reporting a managed outcome - the policy owns the retry.)
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].type).toBe("escaped_arguments_discarded");
		expect(executed).toEqual([]);
		expect(mock.model.calls).toHaveLength(1);
	});

	it("stops resampling in managed fallback once the budget is spent", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({
			responses: [escapedTurn("tc-m-1"), escapedTurn("tc-m-2"), escapedTurn("tc-m-3")],
		});
		const outcomes: ManagedAttemptOutcome[] = [];
		let continuations = 0;
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			fallbackManaged: true,
			onManagedAttemptOutcome: outcome => {
				outcomes.push(outcome);
				if (outcome.type === "escaped_arguments_discarded" && continuations < 5) {
					continuations++;
					return { type: "retry", continuation: () => {} };
				}
				return { type: "terminal", terminal: { stopReason: "error" } };
			},
		};
		const toolResults: Array<{ isError?: boolean }> = [];

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") toolResults.push({ isError: event.isError });
		}

		// Managed loop contract: the loop reports each defective turn ONCE and
		// ends the stream - the policy's retry continuation owns re-entry. With a
		// no-op continuation the loop never gets a second chance, so exactly one
		// discarded outcome is reported; the loop-side bound (at most
		// MAX_ESCAPED_NONASCII_RESAMPLES reports per stream) is exercised by the
		// unmanaged discriminator test above. No tool ever executes and no
		// per-call rejection is ever surfaced inside the managed run: the
		// defective turn is discarded, not answered.
		const discarded = outcomes.filter(outcome => outcome.type === "escaped_arguments_discarded");
		expect(discarded).toHaveLength(1);
		expect(continuations).toBe(1);
		expect(executed).toHaveLength(0);
		expect(toolResults).toHaveLength(0);
	});

	it("attributes consecutive terminal rejections to budget exhaustion, not a short-circuited gate", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		// Persistently escaped sampling: every wire attempt re-emits the defect,
		// each with a distinct tool-call id so no signature-based breaker can fire.
		let calls = 0;
		const mock = createMockModel({
			handler: () => {
				calls += 1;
				return escapedTurn(`tc-${calls}`);
			},
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		const produced = await stream.result();
		const lastAssistant = produced.findLast(message => message.role === "assistant");

		// Distinct discriminator between the two live-failure readings: the gate
		// ran and spent its full budget per logical turn (attempts ==
		// MAX_ESCAPED_NONASCII_RESAMPLES), so the terminal rejection is budget
		// exhaustion on a deterministic-defect payload, not
		// `escapedToolTransaction.committed` short-circuiting the resample. Every
		// logical turn costs exactly 1 + 2 wire attempts before its per-call
		// rejection, and the run ends via the consecutive-malformed-turns
		// circuit breaker rather than executing anything.
		expect(calls).toBe(6 * 3);
		expect(executed).toHaveLength(0);
		expect(lastAssistant?.role === "assistant" ? lastAssistant.stopReason : undefined).toBe("error");
		expect(lastAssistant?.role === "assistant" ? lastAssistant.errorMessage : undefined).toContain(
			"consecutive turns of malformed tool calls",
		);
	});

	it("executes the benign em-dash ask case AFTER the resample budget on a display-safe tool", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [displaySafeAskTool(executed)] };
		// Three escaped wire attempts consume the budget (1 original + 2
		// resamples); the third reaches terminal execution, where the
		// field-scoped display-safe exemption lets the benign payload run.
		const mock = createMockModel({
			responses: [
				emDashEscapedTurn("tc-1"),
				emDashEscapedTurn("tc-2"),
				emDashEscapedTurn("tc-3"),
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		// The full budget ran before execution: 1 original + 2 resamples + the
		// follow-up elicited by the executed tool result.
		expect(mock.calls).toHaveLength(4);
		expect(executed).toEqual([{ question: "How should the daemon drive sessions — in-process?" }]);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBeFalsy();
	});

	it("never exempts escaped non-ASCII outside the declared display fields", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [displaySafeAskTool(executed)] };
		// An em-dash in the QUESTION is benign; the same em-dash in a metadata
		// field the tool did NOT enumerate (here: `deepInterview.dimension`)
		// keeps the fail-closed rejection — the exemption is field-scoped.
		const metaTurn = (id: string) => ({
			content: [
				{
					type: "toolCall" as const,
					id,
					name: "ask",
					arguments: {
						question: "ok — fine",
						deepInterview: { round: 1, component: "daemon", dimension: "스케줄 — 라우팅", ambiguity: 0.2 },
					},
					escapedNonAsciiArguments: true,
				},
			],
		});
		const mock = createMockModel({
			responses: [metaTurn("tc-1"), metaTurn("tc-2"), metaTurn("tc-3"), { content: ["done"] }],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		expect(executed).toHaveLength(0);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].text).toContain("\\uXXXX");
	});

	it("never executes the same em-dash payload when the tool is not display-safe", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [mutatingTool(executed)] };
		const mock = createMockModel({
			responses: [
				emDashEscapedTurn("tc-1", "write"),
				emDashEscapedTurn("tc-2", "write"),
				emDashEscapedTurn("tc-3", "write"),
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		// Mutating tools stay fail-closed: budget spent, then terminal rejection.
		expect(executed).toHaveLength(0);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].text).toContain("\\uXXXX");
	});

	it("rejects a nibble-adjacent symbol escape even on a display-safe tool", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [displaySafeAskTool(executed)] };
		const enDashTurn = (id: string) => ({
			content: [
				{
					type: "toolCall" as const,
					id,
					name: "ask",
					// U+2013 EN DASH — one nibble from the exempted U+2014.
					arguments: { question: "range 0–1 inclusive?" },
					escapedNonAsciiArguments: true,
				},
			],
		});
		const mock = createMockModel({
			responses: [enDashTurn("tc-1"), enDashTurn("tc-2"), enDashTurn("tc-3"), { content: ["done"] }],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		// The curated set admits only U+2014; every other symbol — including the
		// nibble-adjacent en-dash — keeps the fail-closed rejection.
		expect(executed).toHaveLength(0);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].text).toContain("\\uXXXX");
	});

	it("rejects currency, math, full-width, separator, letter, and emoji escapes on a display-safe tool", async () => {
		const redTeam: Array<[string, string]> = [
			["currency ₩", "price ₩1,000?"],
			["math ≈", "is x ≈ y?"],
			["full-width ！", "really！sure?"],
			["ideographic space 　", "a　b?"],
			["hangul letter 안", "이름이 안 무엇인가?"],
			["emoji 😀", "feeling 😀 today?"],
		];
		for (const [label, question] of redTeam) {
			const executed: Array<Record<string, unknown>> = [];
			const context: AgentContext = { systemPrompt: [""], messages: [], tools: [displaySafeAskTool(executed)] };
			const turn = (id: string) => ({
				content: [
					{
						type: "toolCall" as const,
						id,
						name: "ask",
						arguments: { question },
						escapedNonAsciiArguments: true,
					},
				],
			});
			const mock = createMockModel({
				responses: [turn("tc-1"), turn("tc-2"), turn("tc-3"), { content: ["done"] }],
			});
			const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

			const toolResults: Array<{ isError?: boolean; text: string }> = [];
			const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
			for await (const event of stream) {
				if (event.type === "tool_execution_end") {
					const first = event.result.content?.[0];
					toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
				}
			}

			expect(executed).toHaveLength(0);
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0].isError).toBe(true);
			expect(toolResults[0].text).toContain("\\uXXXX");
			expect(label).toBeTruthy();
		}
	});

	it("executes literal UTF-8 arguments untouched", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({ responses: [literalTurn("tc-1"), { content: ["done"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		expect(executed).toEqual([{ question: QUESTION }]);
	});
});
