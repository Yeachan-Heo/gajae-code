import { expect, test } from "bun:test";
import type { Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import * as z from "zod/v4";
import { agentLoop } from "../src/agent-loop";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool } from "../src/types";
import { createUserMessage } from "./helpers";

const toolSchema = z.object({ value: z.string() });

function createHarness(tool: AgentTool<typeof toolSchema, Record<string, never>>) {
	const model = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "tool-1", name: "mutate", arguments: { value: "x" } }] },
			{ content: ["done"] },
		],
	});
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [tool] };
	const convertToLlm = (messages: AgentMessage[]): Message[] =>
		messages.filter(
			(message): message is Message =>
				message.role === "user" || message.role === "assistant" || message.role === "toolResult",
		);
	return { model, context, convertToLlm };
}

test("a run aborted while beforeToolCall awaits never dispatches the tool", async () => {
	let executions = 0;
	const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
		name: "mutate",
		label: "Mutate",
		description: "Non-abortable mutation",
		parameters: toolSchema,
		nonAbortable: true,
		async execute() {
			executions++;
			return { content: [{ type: "text", text: "mutated" }] };
		},
	};
	const { model, context, convertToLlm } = createHarness(tool);
	const controller = new AbortController();
	const hookStarted = Promise.withResolvers<void>();
	const releaseHook = Promise.withResolvers<void>();
	const stream = agentLoop(
		[createUserMessage("go")],
		context,
		{
			model: model.model,
			convertToLlm,
			beforeToolCall: async () => {
				hookStarted.resolve();
				await releaseHook.promise;
				// The hook itself does not block: the loop must still refuse dispatch.
				return undefined;
			},
		},
		controller.signal,
		model.stream,
	);
	const events: AgentEvent[] = [];
	const draining = (async () => {
		for await (const event of stream) events.push(event);
	})();

	await hookStarted.promise;
	controller.abort();
	releaseHook.resolve();
	await draining;
	// Let the detached tool task settle after the abort sweep returned.
	await Bun.sleep(10);

	expect(executions).toBe(0);
	const results = events.filter(event => event.type === "message_end" && event.message.role === "toolResult");
	expect(results).toHaveLength(1);
});

test("a hook that settles without cancellation still dispatches the tool", async () => {
	let executions = 0;
	const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
		name: "mutate",
		label: "Mutate",
		description: "Non-abortable mutation",
		parameters: toolSchema,
		nonAbortable: true,
		async execute() {
			executions++;
			return { content: [{ type: "text", text: "mutated" }] };
		},
	};
	const { model, context, convertToLlm } = createHarness(tool);
	const stream = agentLoop(
		[createUserMessage("go")],
		context,
		{
			model: model.model,
			convertToLlm,
			beforeToolCall: async () => {
				await Bun.sleep(5);
				return undefined;
			},
		},
		new AbortController().signal,
		model.stream,
	);
	for await (const _event of stream) {
		// drain
	}
	expect(executions).toBe(1);
});
