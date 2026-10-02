import { describe, expect, it } from "bun:test";
import { Agent, type AgentEvent } from "@gajae-code/agent-core";
import type { ToolResultMessage } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { isProviderResolvedToolCall } from "@gajae-code/ai/utils/block-symbols";
import * as z from "zod/v4";
import {
	completed,
	cursorMessages,
	cursorModel,
	mcpCall,
	mcpExec,
	started,
	text,
	turnEnded,
} from "../../ai/test/helpers/cursor-inline";

describe("Cursor inline calls through Agent", () => {
	for (const aborted of [false, true]) {
		it(`settles without local replay or placeholder results (aborted=${aborted})`, async () => {
			let requests = 0;
			let localExecutions = 0;
			let inlineExecutions = 0;
			const events: AgentEvent[] = [];
			const controller = new AbortController();
			const agent = new Agent({
				initialState: {
					model: cursorModel,
					systemPrompt: [],
					tools: [
						{
							name: "eval",
							label: "Eval",
							description: "Eval",
							parameters: z.object({ code: z.string() }),
							execute: async () => {
								localExecutions++;
								return { content: [] };
							},
						},
					],
				},
				cursorExecHandlers: {
					mcp: async call => {
						inlineExecutions++;
						if (aborted) controller.abort();
						const result: ToolResultMessage = {
							role: "toolResult",
							toolCallId: call.toolCallId,
							toolName: call.toolName,
							content: [{ type: "text", text: "inline completed" }],
							isError: false,
							timestamp: 1,
						};
						return result;
					},
				},
				streamFn: (_model, _context, options) => {
					requests++;
					if (requests > 1) return cursorMessages([text("unexpected continuation"), turnEnded]).stream;
					return cursorMessages(
						[text("Running. "), started(mcpCall), mcpExec, completed(mcpCall), text("LONG_TOOL_DONE"), turnEnded],
						{
							...options,
							execHandlers: options?.cursorExecHandlers,
							onToolResult: options?.cursorOnToolResult,
							signal: controller.signal,
						},
					).stream;
				},
			});
			agent.subscribe(event => events.push(event));
			await agent.prompt("Run eval once");
			expect(requests).toBe(1);
			expect(inlineExecutions).toBe(1);
			expect(localExecutions).toBe(0);
			expect(events.filter(event => event.type === "turn_start")).toHaveLength(1);
			const results = agent.state.messages.filter(message => message.role === "toolResult");
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ toolName: "eval", isError: false });
			const calls = agent.state.messages.flatMap(message =>
				message.role === "assistant" ? message.content.filter(block => block.type === "toolCall") : [],
			);
			expect(calls).toHaveLength(1);
			expect(isProviderResolvedToolCall(calls[0])).toBe(true);
			if (!aborted) {
				expect(agent.state.messages.map(message => message.role)).toEqual([
					"user",
					"assistant",
					"toolResult",
					"assistant",
				]);
			} else {
				expect(
					results.some(result =>
						result.content.some(block => block.type === "text" && block.text.includes("aborted")),
					),
				).toBe(false);
			}
		});
	}
	it("still executes a genuine non-Cursor local tool cycle with stopReason stop", async () => {
		let executions = 0;
		let requests = 0;
		const mock = createMockModel({
			responses: [
				{
					stopReason: "stop",
					content: [{ type: "toolCall", id: "local-1", name: "eval", arguments: { code: "once" } }],
				},
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: [],
				tools: [
					{
						name: "eval",
						label: "Eval",
						description: "Eval",
						parameters: z.object({ code: z.string() }),
						execute: async () => {
							executions++;
							return { content: [] };
						},
					},
				],
			},
			streamFn: (model, context, options) => {
				requests++;
				return mock.stream(model, context, options);
			},
		});
		await agent.prompt("Run eval once");
		expect(executions).toBe(1);
		expect(requests).toBe(2);
		expect(agent.state.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
	});
});
