import { expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "@gajae-code/agent-core/types";
import type { AssistantMessage, Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { createAssistantMessage, createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

it("provides a non-optional cancellation-aware maintenance lifecycle without a run signal", async () => {
	const model = createMockModel();
	const responses: AssistantMessage[] = [
		createAssistantMessage([{ type: "toolCall", id: "call-1", name: "echo", arguments: {} }], "toolUse"),
		createAssistantMessage([{ type: "text", text: "complete" }]),
	];
	const streamFn: StreamFn = () => {
		const response = responses.shift();
		if (!response) throw new Error("Unexpected model request");
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
				message: response,
			});
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
	const context: AgentContext = { systemPrompt: ["You are helpful."], messages: [], tools: [tool] };
	let maintenanceCalls = 0;
	const config: AgentLoopConfig = {
		model: model.model,
		convertToLlm: identityConverter,
		maintainContext: async (_context, lifecycle) => {
			maintenanceCalls += 1;
			expect(lifecycle.signal).toBeInstanceOf(AbortSignal);
			expect(lifecycle.signal.aborted).toBe(false);
			await expect(lifecycle.awaitEventDrain(new AbortController().signal)).resolves.toBeUndefined();
			return "not-needed" as const;
		},
	};

	const stream = agentLoop([createUserMessage("run tool")], context, config, undefined, streamFn);
	for await (const _event of stream) {
		// Drain the real consumer path that awaitEventDrain synchronizes with.
	}

	await expect(stream.result()).resolves.toBeDefined();
	expect(maintenanceCalls).toBe(1);
	expect(responses).toEqual([]);
});

it("ends as aborted when cancellation lands while maintenance resolves", async () => {
	const model = createMockModel();
	const maintenanceEntered = Promise.withResolvers<void>();
	const maintenanceGate = Promise.withResolvers<void>();
	const controller = new AbortController();
	let streamCalls = 0;
	const streamFn: StreamFn = () => {
		streamCalls += 1;
		if (streamCalls > 1) throw new Error("Maintenance cancellation must prevent a second model request");
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
	const context: AgentContext = { systemPrompt: ["You are helpful."], messages: [], tools: [tool] };
	const events: Array<{ type: string; maintenanceOutcome?: string }> = [];
	const config: AgentLoopConfig = {
		model: model.model,
		convertToLlm: identityConverter,
		maintainContext: async () => {
			maintenanceEntered.resolve();
			await maintenanceGate.promise;
			return "not-needed" as const;
		},
	};

	const stream = agentLoop([createUserMessage("run tool")], context, config, controller.signal, streamFn);
	const drain = (async () => {
		for await (const event of stream) events.push(event);
	})();
	await maintenanceEntered.promise;
	controller.abort();
	maintenanceGate.resolve();
	await drain;
	await expect(stream.result()).resolves.toBeDefined();

	expect(streamCalls).toBe(1);
	expect(events.filter(event => event.type === "agent_end" && event.maintenanceOutcome === "aborted")).toHaveLength(1);
});
