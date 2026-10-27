import { describe, expect, it } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	McpArgsSchema,
	ShellArgsSchema,
	ShellToolCallSchema,
	TodoItemSchema,
	ToolCallSchema,
	UpdateTodosArgsSchema,
	UpdateTodosToolCallSchema,
} from "../src/providers/cursor/gen/agent_pb";
import type { AssistantMessageEvent, ToolResultMessage } from "../src/types";
import { isProviderResolvedToolCall } from "../src/utils/block-symbols";
import {
	completed,
	cursorMessages,
	deltaMcp,
	mcpArgs,
	mcpCall,
	mcpExec,
	partialMcp,
	started,
	turnEnded,
} from "./helpers/cursor-inline";

describe("Cursor inline execution ownership", () => {
	for (const order of ["announcement-first", "exec-first"] as const) {
		for (const isError of [false, true]) {
			it(`keeps one canonical owned MCP block and result (${order}, error=${isError})`, async () => {
				const announcements = [
					started(mcpCall),
					deltaMcp,
					partialMcp,
					completed(mcpCall),
					started(mcpCall),
					completed(mcpCall),
				];
				const messages =
					order === "exec-first" ? [mcpExec, ...announcements, turnEnded] : [...announcements, mcpExec, turnEnded];
				const results: ToolResultMessage[] = [];
				const events: AssistantMessageEvent[] = [];
				let executions = 0;
				const { stream, execResults } = cursorMessages(messages, {
					execHandlers: {
						mcp: async call => {
							executions++;
							expect(call.toolName).toBe("eval");
							return {
								role: "toolResult",
								toolCallId: call.toolCallId,
								toolName: call.toolName,
								content: [],
								isError,
								timestamp: 1,
							};
						},
					},
					onToolResult: result => {
						results.push(result);
						return result;
					},
				});
				for await (const event of stream) events.push(event);
				const output = await stream.result();
				const calls = output.content.filter(block => block.type === "toolCall");
				expect(calls).toHaveLength(1);
				expect(calls[0]).toMatchObject({ id: "inline-1", name: "eval", arguments: { code: "time.sleep(2)" } });
				expect(isProviderResolvedToolCall(calls[0])).toBe(true);
				expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
				const ends = events.filter(event => event.type === "toolcall_end");
				expect(ends).toHaveLength(1);
				expect(ends[0].type === "toolcall_end" && isProviderResolvedToolCall(ends[0].toolCall)).toBe(true);
				expect(executions).toBe(1);
				expect(results).toHaveLength(1);
				expect(results[0].isError).toBe(isError);
				expect(execResults).toEqual([isError ? "error" : "success"]);
				expect(output.stopReason).toBe("stop");
			}, 10000);
		}
	}
	it("assigns a missing MCP call id once before inline dispatch", async () => {
		const args = create(McpArgsSchema, { ...mcpArgs, toolCallId: "" });
		const exec = create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, { id: 1, message: { case: "mcpArgs", value: args } }),
			},
		});
		let executedId = "";
		const results: ToolResultMessage[] = [];
		const { stream } = cursorMessages([exec, turnEnded], {
			execHandlers: {
				mcp: async call => {
					executedId = call.toolCallId;
					return {
						role: "toolResult",
						toolCallId: call.toolCallId,
						toolName: call.toolName,
						content: [],
						isError: false,
						timestamp: 1,
					};
				},
			},
			onToolResult: result => {
				results.push(result);
				return result;
			},
		});
		for await (const _event of stream) {
			// consume
		}
		const output = await stream.result();
		expect(executedId.length).toBeGreaterThan(0);
		const calls = output.content.filter(block => block.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0].id).toBe(executedId);
		expect(results).toHaveLength(1);
		expect(results[0].toolCallId).toBe(executedId);
		expect(isProviderResolvedToolCall(calls[0])).toBe(true);
	});
	for (const kind of ["todo", "native"] as const) {
		it(`marks and deduplicates ${kind} announcements through completion`, async () => {
			const call =
				kind === "todo"
					? create(ToolCallSchema, {
							tool: {
								case: "updateTodosToolCall",
								value: create(UpdateTodosToolCallSchema, {
									args: create(UpdateTodosArgsSchema, {
										todos: [create(TodoItemSchema, { id: "task-1", content: "Check", status: 2 })],
									}),
								}),
							},
						})
					: create(ToolCallSchema, {
							tool: {
								case: "shellToolCall",
								value: create(ShellToolCallSchema, { args: create(ShellArgsSchema, { command: "pwd" }) }),
							},
						});
			const messages = [started(call), started(call), completed(call), started(call), completed(call), turnEnded];
			const { stream } = cursorMessages(messages);
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			const output = await stream.result();
			const calls = output.content.filter(block => block.type === "toolCall");
			expect(calls).toHaveLength(1);
			expect(calls[0].name).toBe(kind === "todo" ? "todo_write" : "bash");
			expect(isProviderResolvedToolCall(calls[0])).toBe(true);
			if (kind === "todo") {
				expect(calls[0].arguments).toMatchObject({ todos: [{ id: "task-1", status: "in_progress" }] });
			}
			expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
			const end = events.find(event => event.type === "toolcall_end");
			expect(end?.type === "toolcall_end" && isProviderResolvedToolCall(end.toolCall)).toBe(true);
			expect(output.stopReason).toBe("stop");
		}, 10000);
	}
});
