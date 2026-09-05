import { describe, expect, it } from "bun:test";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	getAgentTerminalOwnerContext,
	type StreamFn,
} from "@gajae-code/agent-core";
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
		const streamCreationStarted = Promise.withResolvers<void>();
		const streamFn: StreamFn = (selectedModel, context, options) => {
			callCount += 1;
			if (callCount === 1) {
				streamCreationStarted.resolve();
				return neverStream;
			}
			return model.stream(selectedModel, context, options);
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});

		const firstPrompt = agent.prompt("hang before stream");
		await waitForStreaming(agent);
		await streamCreationStarted.promise;

		expect(agent.forceAbort("test timeout")).toBe(true);
		await agent.waitForIdle();
		await expect(firstPrompt).resolves.toBeUndefined();
		expect(agent.state.isStreaming).toBe(false);

		await expect(agent.prompt("next")).resolves.toBeUndefined();
		expect(model.calls).toHaveLength(1);
	});

	it("terminalizes the logical owner when force-aborting a maintenance continuation", async () => {
		const model = createMockModel();
		const pendingContinuation = new AssistantMessageEventStream();
		let streamCalls = 0;
		const streamFn: StreamFn = () => {
			streamCalls += 1;
			if (streamCalls === 1) {
				const response = createAssistantMessage(
					[{ type: "toolCall", id: "call-1", name: "echo", arguments: {} }],
					"toolUse",
				);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "toolUse", message: response });
					stream.end(response);
				});
				return stream;
			}
			if (streamCalls === 2) return pendingContinuation;
			throw new Error("Unexpected provider request");
		};
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Returns a deterministic result.",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn,
		});
		const agentSessionClaimKey = {};
		agent.resourceLedger.bindAgentSessionClaimKey(agentSessionClaimKey);
		agent.setMaintainContext(async () => "pruned" as const);
		let logicalHandle: string | undefined;
		let logicalDomain = agent.resourceLedger.lookupDomain("missing");
		let forcedTerminal: Extract<AgentEvent, { type: "agent_end" }> | undefined;
		let forcedClaimOk: boolean | undefined;
		let forcedClaimReason: string | undefined;
		agent.subscribe(event => {
			if (event.type !== "agent_end") return;
			if (event.stopReason === "maintenance") {
				logicalHandle = agent.activeResourceRunId;
				logicalDomain = logicalHandle ? agent.resourceLedger.lookupDomain(logicalHandle) : undefined;
				return;
			}
			forcedTerminal = event;
			const owner = getAgentTerminalOwnerContext(event);
			if (owner) {
				const claim = agent.resourceLedger.claimProducer(owner.resourceRunId, owner.domain, agentSessionClaimKey);
				forcedClaimOk = claim.ok;
				if (claim.ok) claim.lease.closeDiscovery();
				else forcedClaimReason = claim.reason;
			}
		});

		await agent.prompt("run tool");
		expect(logicalHandle).toBeDefined();
		expect(logicalDomain).toBeDefined();

		const continuation = agent.continue({ maintenanceContinuation: true });
		await waitForStreaming(agent);
		expect(agent.activeResourceRunId).toBe(logicalHandle);
		expect(agent.forceAbort("maintenance timeout")).toBe(true);
		await continuation;

		expect(forcedTerminal?.stopReason).toBe("cancelled");
		const owner = forcedTerminal ? getAgentTerminalOwnerContext(forcedTerminal) : undefined;
		expect(owner?.resourceRunId).toBe(logicalHandle);
		expect(owner?.domain).toBe(logicalDomain);
		expect(forcedClaimOk).toBe(true);
		expect(forcedClaimReason).toBeUndefined();
	});

	it("reports in-run consumption when a queued follow-up continues as a maintenance continuation (#4668)", async () => {
		// A maintenance continuation resumes the EXISTING logical run and emits
		// no new agent_start. A follow-up batch consumed by that continuation is
		// in-run consumption, not an own-run promotion: reporting startsOwnRun
		// true makes the SDK wait for an agent_start that never arrives.
		const model = createMockModel({ responses: [{ content: ["continuation done"] }] });
		let streamCalls = 0;
		const streamFn: StreamFn = (selectedModel, context, options) => {
			streamCalls += 1;
			if (streamCalls === 1) {
				const response = createAssistantMessage(
					[{ type: "toolCall", id: "call-1", name: "echo", arguments: {} }],
					"toolUse",
				);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "toolUse", message: response });
					stream.end(response);
				});
				return stream;
			}
			return model.stream(selectedModel, context, options);
		};
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Returns a deterministic result.",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn,
		});
		agent.setMaintainContext(async () => "pruned" as const);
		let maintenanceEnded = false;
		agent.subscribe(event => {
			if (event.type === "agent_end" && event.stopReason === "maintenance") maintenanceEnded = true;
		});
		await agent.prompt("run tool");
		expect(maintenanceEnded).toBe(true);

		const promotions: boolean[] = [];
		agent.onFollowUpConsumed = (_messages, promotion = { startsOwnRun: false }) =>
			promotions.push(promotion.startsOwnRun);
		agent.followUp({
			role: "user",
			content: "queued follow-up",
			timestamp: Date.now(),
		} as unknown as AgentMessage);
		await agent.continueQueuedMessages({ maintenanceContinuation: true });
		expect(promotions).toEqual([false]);
	});

	it("forces an ignored abort back to idle and accepts a following prompt", async () => {
		const model = createMockModel({ responses: [{ content: ["after force"] }] });
		const hangingStream = new AssistantMessageEventStream();
		let callCount = 0;
		const firstStreamStarted = Promise.withResolvers<void>();
		const streamFn: StreamFn = (selectedModel, context, options) => {
			callCount += 1;
			if (callCount === 1) {
				firstStreamStarted.resolve();
				return hangingStream;
			}
			return model.stream(selectedModel, context, options);
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});

		const firstPrompt = agent.prompt("hang");
		await waitForStreaming(agent);
		await firstStreamStarted.promise;

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
		const firstStreamStarted = Promise.withResolvers<void>();
		const streamFn: StreamFn = () => {
			callCount += 1;
			if (callCount === 1) {
				firstStreamStarted.resolve();
				return firstStream;
			}
			return secondStream;
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});

		const firstPrompt = agent.prompt("first");
		await waitForStreaming(agent);
		await firstStreamStarted.promise;
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

	it("preserves Pi handlers and forwards abort signals to native Cursor handlers", async () => {
		const model = createMockModel();
		const stream = new AssistantMessageEventStream();
		let capturedHandlers: CursorExecHandlers | undefined;
		const nativeSignals: AbortSignal[] = [];
		const piSignals: AbortSignal[] = [];
		let nativeMarkerForwarded = false;
		const streamFn: StreamFn = (_selectedModel, _context, options?: SimpleStreamOptions) => {
			capturedHandlers = options?.cursorExecHandlers;
			return stream;
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [], messages: [] },
			cursorExecHandlers: {
				write: async (args, signal, markNonAbortable) => {
					if (signal) nativeSignals.push(signal);
					if (markNonAbortable) nativeMarkerForwarded = true;
					return {
						role: "toolResult",
						toolCallId: args.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
				piWrite: async call => {
					if (call.signal) piSignals.push(call.signal);
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: "write",
						content: [],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
			streamFn,
		});

		const prompt = agent.prompt("run");
		await waitForStreaming(agent);
		const handlers = await waitForCapturedCursorHandlers(() => capturedHandlers);
		const controller = new AbortController();
		await handlers.write?.(
			{ $typeName: "agent.v1.WriteArgs", path: "state.txt", fileText: "state", toolCallId: "native" } as Parameters<
				NonNullable<CursorExecHandlers["write"]>
			>[0],
			controller.signal,
			() => {},
		);
		await handlers.piWrite?.({ args: {} as never, toolCallId: "pi", signal: controller.signal });

		expect(nativeSignals).toEqual([controller.signal]);
		expect(piSignals).toEqual([controller.signal]);
		// The Agent run guard must forward the third markNonAbortable argument
		// so the native write path can activate the settlement fence.
		expect(nativeMarkerForwarded).toBe(true);

		stream.push({ type: "done", reason: "stop", message: createAssistantMessage([{ type: "text", text: "done" }]) });
		await expect(prompt).resolves.toBeUndefined();
	});

	it("drops partial thinking and tool-use from replay history when a streamed turn is aborted", async () => {
		const model = createMockModel({ responses: [{ content: ["after abort"] }] });
		const firstStream = new AssistantMessageEventStream();
		let callCount = 0;
		const firstStreamStarted = Promise.withResolvers<void>();
		const streamFn: StreamFn = (selectedModel, context, options) => {
			callCount += 1;
			if (callCount === 1) {
				firstStreamStarted.resolve();
				return firstStream;
			}
			return model.stream(selectedModel, context, options);
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});

		const firstPrompt = agent.prompt("start risky turn");
		await waitForStreaming(agent);
		await firstStreamStarted.promise;
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

	it("seals the caller-owned run when maintenance aborts instead of leaving it unfenced", async () => {
		// The loop runs with `resourceSealOwner: "caller"`, so it deliberately leaves
		// sealing to Agent. Treating an aborted maintenance as an ordinary checkpoint
		// therefore left the run open forever and made every cancel report
		// `run_not_sealed` with nothing actually pending.
		const model = createMockModel();
		let streamCalls = 0;
		const streamFn: StreamFn = () => {
			streamCalls += 1;
			if (streamCalls > 1) throw new Error("Maintenance abort must not start a second request");
			const response = createAssistantMessage(
				[{ type: "toolCall", id: "call-1", name: "echo", arguments: {} }],
				"toolUse",
			);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "toolUse", message: response });
				stream.end(response);
			});
			return stream;
		};
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Returns a deterministic result.",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const agent = new Agent({
			initialState: { model: model.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn,
		});
		const maintenanceEntered = Promise.withResolvers<void>();
		const maintenanceGate = Promise.withResolvers<void>();
		agent.setMaintainContext(async () => {
			maintenanceEntered.resolve();
			await maintenanceGate.promise;
			return "not-needed" as const;
		});

		let handle: string | undefined;
		const terminals: Array<Extract<AgentEvent, { type: "agent_end" }>> = [];
		agent.subscribe(event => {
			if (event.type !== "agent_end") return;
			terminals.push(event);
			if (event.stopReason === "maintenance") handle ??= agent.activeResourceRunId;
		});

		const prompt = agent.prompt("run tool");
		await maintenanceEntered.promise;
		handle ??= agent.activeResourceRunId;
		agent.abort();
		maintenanceGate.resolve();
		await prompt;
		await agent.waitForIdle();

		expect(handle).toBeDefined();
		// The event keeps its maintenance shape so AgentSession can still report the
		// aborted maintenance settlement; only the sealing decision changed.
		expect(terminals).toMatchObject([{ stopReason: "maintenance", maintenanceOutcome: "aborted" }]);
		expect(await agent.resourceLedger.waitForSettlement(handle!, { graceMs: 100 })).toEqual({
			status: "settled",
		});
	});
});
