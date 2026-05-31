import { describe, expect, it } from "bun:test";
import { Agent, type StreamFn } from "@gajae-code/agent-core";
import type { CursorExecHandlers, SimpleStreamOptions } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { createAssistantMessage } from "./helpers";

async function waitForStreaming(agent: Agent): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (agent.state.isStreaming) return;
		await Bun.sleep(5);
	}
	throw new Error("Agent did not enter streaming state");
}

async function waitForCapturedCursorHandlers(
	getHandlers: () => CursorExecHandlers | undefined,
): Promise<CursorExecHandlers> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const handlers = getHandlers();
		if (handlers) return handlers;
		await Bun.sleep(5);
	}
	throw new Error("Cursor handlers were not captured");
}

describe("Agent.forceAbort", () => {
	it("recovers busy state when stream creation never resolves", async () => {
		const model = createMockModel({ responses: [{ content: ["after hung create"] }] });
		let callCount = 0;
		const { promise: neverStream } = Promise.withResolvers<AssistantMessageEventStream>();
		const streamFn: StreamFn = (selectedModel, context, options) => {
			callCount += 1;
			if (callCount === 1) return neverStream;
			return model.stream(selectedModel, context, options);
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});

		void agent.prompt("hang before stream");
		await waitForStreaming(agent);

		expect(agent.forceAbort("test timeout")).toBe(true);
		await agent.waitForIdle();
		expect(agent.state.isStreaming).toBe(false);

		await expect(agent.prompt("next")).resolves.toBeUndefined();
		expect(model.calls).toHaveLength(1);
	});

	it("forces an ignored abort back to idle and accepts a following prompt", async () => {
		const model = createMockModel({ responses: [{ content: ["after force"] }] });
		const hangingStream = new AssistantMessageEventStream();
		let callCount = 0;
		const streamFn: StreamFn = (selectedModel, context, options) => {
			callCount += 1;
			if (callCount === 1) return hangingStream;
			return model.stream(selectedModel, context, options);
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});

		const firstPrompt = agent.prompt("hang");
		await waitForStreaming(agent);

		expect(agent.forceAbort("test timeout")).toBe(true);
		await agent.waitForIdle();
		expect(agent.state.isStreaming).toBe(false);

		await expect(firstPrompt).resolves.toBeUndefined();
		await expect(agent.prompt("next")).resolves.toBeUndefined();
		expect(agent.state.isStreaming).toBe(false);
		expect(model.calls).toHaveLength(1);
	});

	it("ignores stale events from the force-aborted run after a new prompt starts", async () => {
		const model = createMockModel();
		const firstStream = new AssistantMessageEventStream();
		const secondStream = new AssistantMessageEventStream();
		let callCount = 0;
		const streamFn: StreamFn = () => {
			callCount += 1;
			return callCount === 1 ? firstStream : secondStream;
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});

		const firstPrompt = agent.prompt("first");
		await waitForStreaming(agent);
		const firstRunExternalEmitter = agent.createExternalEventEmitterForCurrentRun();
		expect(agent.forceAbort("test timeout")).toBe(true);
		await expect(firstPrompt).resolves.toBeUndefined();

		const secondPrompt = agent.prompt("second");
		await waitForStreaming(agent);

		firstRunExternalEmitter?.({
			type: "message_end",
			message: createAssistantMessage([{ type: "text", text: "stale-external" }]),
		});
		firstStream.push({
			type: "done",
			reason: "stop",
			message: createAssistantMessage([{ type: "text", text: "stale" }]),
		});
		await Bun.sleep(10);
		expect(agent.state.isStreaming).toBe(true);

		secondStream.push({
			type: "done",
			reason: "stop",
			message: createAssistantMessage([{ type: "text", text: "fresh" }]),
		});
		await expect(secondPrompt).resolves.toBeUndefined();

		expect(agent.state.isStreaming).toBe(false);
		const assistantTexts = agent.state.messages
			.filter(message => message.role === "assistant")
			.flatMap(message => message.content)
			.filter(content => content.type === "text")
			.map(content => content.text);
		expect(assistantTexts).toEqual(["fresh"]);
	});

	it("ignores late Cursor exec calls captured by a force-aborted run", async () => {
		const model = createMockModel();
		const firstStream = new AssistantMessageEventStream();
		const secondStream = new AssistantMessageEventStream();
		let firstRunCursorHandlers: CursorExecHandlers | undefined;
		let callCount = 0;
		const streamFn: StreamFn = (_selectedModel, _context, options?: SimpleStreamOptions) => {
			callCount += 1;
			if (callCount === 1) {
				firstRunCursorHandlers = options?.cursorExecHandlers;
				return firstStream;
			}
			return secondStream;
		};
		const emittedToolCallIds: string[] = [];
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [], messages: [] },
			cursorExecHandlers: {
				read: async args => {
					agent.emitExternalEvent({
						type: "tool_execution_start",
						toolCallId: args.toolCallId,
						toolName: "read",
						args: { path: args.path },
					});
					return {
						role: "toolResult",
						toolCallId: args.toolCallId,
						toolName: "read",
						content: [{ type: "text", text: "stale read" }],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
			streamFn,
		});
		agent.subscribe(event => {
			if (event.type === "tool_execution_start") {
				emittedToolCallIds.push(event.toolCallId);
			}
		});

		const firstPrompt = agent.prompt("first");
		await waitForStreaming(agent);
		const staleCursorHandlers = await waitForCapturedCursorHandlers(() => firstRunCursorHandlers);
		expect(staleCursorHandlers.read).toBeDefined();
		expect(agent.forceAbort("test timeout")).toBe(true);
		await expect(firstPrompt).resolves.toBeUndefined();

		const secondPrompt = agent.prompt("second");
		await waitForStreaming(agent);
		const staleReadArgs = {
			$typeName: "agent.v1.ReadArgs",
			path: "stale.txt",
			toolCallId: "old-call",
		} as Parameters<NonNullable<CursorExecHandlers["read"]>>[0];
		await expect(staleCursorHandlers.read?.(staleReadArgs)).rejects.toThrow("inactive agent run");
		expect(emittedToolCallIds).toEqual([]);

		secondStream.push({
			type: "done",
			reason: "stop",
			message: createAssistantMessage([{ type: "text", text: "fresh" }]),
		});
		await expect(secondPrompt).resolves.toBeUndefined();
	});

	it("drops partial thinking and tool-use from replay history when a streamed turn is aborted", async () => {
		const model = createMockModel({ responses: [{ content: ["after abort"] }] });
		const firstStream = new AssistantMessageEventStream();
		let callCount = 0;
		const streamFn: StreamFn = (selectedModel, context, options) => {
			callCount += 1;
			if (callCount === 1) return firstStream;
			return model.stream(selectedModel, context, options);
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});

		const firstPrompt = agent.prompt("start risky turn");
		await waitForStreaming(agent);
		const partial = createAssistantMessage(
			[
				{ type: "thinking", thinking: "partial private reasoning", thinkingSignature: "partial_sig" },
				{ type: "toolCall", id: "toolu_partial", name: "read", arguments: { path: "README.md" } },
			],
			"toolUse",
		);
		firstStream.push({ type: "start", partial });
		firstStream.push({ type: "thinking_start", contentIndex: 0, partial });
		firstStream.push({
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: { type: "toolCall", id: "toolu_partial", name: "read", arguments: { path: "README.md" } },
			partial,
		});

		expect(agent.forceAbort("test timeout")).toBe(true);
		await expect(firstPrompt).resolves.toBeUndefined();

		await expect(agent.prompt("after abort")).resolves.toBeUndefined();

		const assistantMessages = agent.state.messages.filter(message => message.role === "assistant");
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0]?.content).toEqual([{ type: "text", text: "after abort" }]);
		expect(model.calls[0]?.context.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "after abort" }], timestamp: expect.any(Number) },
		]);
	});
});
