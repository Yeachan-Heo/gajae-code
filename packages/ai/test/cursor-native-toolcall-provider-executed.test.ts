import { describe, expect, it } from "bun:test";
import { buildNativeToolCallBlock } from "../src/providers/cursor";

// Cursor executes its native tools during streaming over the exec channel
// (shellArgs -> CursorExecHandlers.shell -> local bash, readArgs -> read, ...).
// The rendered block exists only so the call is visible, so it must carry
// providerExecuted for the agent loop to skip local dispatch.
describe("cursor native tool calls are flagged as provider-executed", () => {
	it("flags a native shell call so the command is not run twice", () => {
		const block = buildNativeToolCallBlock(
			{
				shellToolCall: {
					$typeName: "agent.v1.ShellToolCall",
					args: { $typeName: "agent.v1.ShellToolCallArgs", command: "rm -rf build" },
				},
			},
			"call-1",
			0,
		);

		expect(block).toMatchObject({
			type: "toolCall",
			name: "bash",
			providerExecuted: "cursor-exec",
		});
		// The command must still be visible to the user.
		expect(block?.arguments).toMatchObject({ command: "rm -rf build" });
	});

	it("flags the protobuf oneof shape emitted by Cursor", () => {
		const block = buildNativeToolCallBlock(
			{
				tool: {
					case: "shellToolCall",
					value: { args: { command: "echo provider" } },
				},
			},
			"call-oneof",
			0,
		);

		expect(block).toMatchObject({ name: "bash", providerExecuted: "cursor-exec" });
		expect(block?.arguments).toEqual({ command: "echo provider" });
	});

	it("flags native kinds whose display label is not a registered tool", () => {
		for (const [payload, expectedName] of [
			[{ globToolCall: { $typeName: "agent.v1.GlobToolCall", args: { globPattern: "**/*.ts" } } }, "glob"],
			[{ grepToolCall: { $typeName: "agent.v1.GrepToolCall", args: { pattern: "TODO" } } }, "grep"],
			[{ lsToolCall: { $typeName: "agent.v1.LsToolCall", args: { path: "." } } }, "ls"],
			[{ readLintsToolCall: { $typeName: "agent.v1.ReadLintsToolCall", sizeBytes: 12n } }, "read_lints"],
		] as const) {
			const block = buildNativeToolCallBlock(payload as Record<string, unknown>, "call-x", 0);
			expect(block?.name).toBe(expectedName);
			// These are handled by Cursor's exec transport even when no local tool
			// with the display label is registered.
			expect(block?.providerExecuted).toBe("cursor-exec");
		}
	});

	it("does not attest unsupported native variants", () => {
		for (const payload of [
			{ taskToolCall: { args: { description: "delegate" } } },
			{ webSearchToolCall: { args: { searchTerm: "status" } } },
			{ createPlanToolCall: { args: { plan: "plan" } } },
			{ askQuestionToolCall: { args: { title: "question" } } },
			{ applyAgentDiffToolCall: { args: { agentId: "agent" } } },
		]) {
			const block = buildNativeToolCallBlock(payload, "call-unsupported", 0);
			expect(block?.providerExecuted).toBeUndefined();
		}
	});

	it("leaves mcp and todo_write calls to the normal dispatch path", () => {
		// MCP calls are the client's own advertised tools and todo_write has no
		// exec-channel handler, so both are executed by the agent loop as usual and
		// must not be built by (or flagged through) the native path.
		expect(
			buildNativeToolCallBlock({ mcpToolCall: { $typeName: "agent.v1.McpToolCall", args: {} } }, "call-2", 0),
		).toBeNull();
		expect(
			buildNativeToolCallBlock(
				{ updateTodosToolCall: { $typeName: "agent.v1.UpdateTodosToolCall", args: {} } },
				"call-3",
				0,
			),
		).toBeNull();
	});
});
