import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { reconcileTrailingToolCalls } from "../src/sdk/session";

function assistantWithToolCall(id: string, name = "yield"): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "done" },
			{ type: "toolCall", id, name, arguments: { result: { data: {} } } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	} as AgentMessage;
}

function toolResult(id: string, name = "yield"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	} as AgentMessage;
}

const userMsg: AgentMessage = { role: "user", content: "hi", timestamp: 0 } as AgentMessage;

describe("reconcileTrailingToolCalls", () => {
	it("synthesizes a tool result for a trailing unpaired yield tool call", () => {
		// The subagent-yield-terminate path leaves the saved session ending on an
		// assistant `yield` toolCall with no toolResult; replaying it verbatim on
		// resume is an invalid provider request and the resumed turn fails at once.
		const messages = [userMsg, assistantWithToolCall("call-1")];
		const result = reconcileTrailingToolCalls(messages);

		expect(result).toHaveLength(3);
		const last = result[2];
		expect(last.role).toBe("toolResult");
		expect((last as { toolCallId: string }).toolCallId).toBe("call-1");
		// Original array is not mutated.
		expect(messages).toHaveLength(2);
	});

	it("is a no-op when the trailing tool call is already paired", () => {
		const messages = [userMsg, assistantWithToolCall("call-1"), toolResult("call-1")];
		expect(reconcileTrailingToolCalls(messages)).toBe(messages);
	});

	it("is a no-op for a text-only final assistant message", () => {
		const messages: AgentMessage[] = [
			userMsg,
			{
				role: "assistant",
				content: [{ type: "text", text: "final answer" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			} as AgentMessage,
		];
		expect(reconcileTrailingToolCalls(messages)).toBe(messages);
	});

	it("synthesizes only the missing results when the final message has multiple calls", () => {
		const messages: AgentMessage[] = [
			userMsg,
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-a", name: "read", arguments: {} },
					{ type: "toolCall", id: "call-b", name: "yield", arguments: {} },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			} as AgentMessage,
			toolResult("call-a", "read"),
		];
		const result = reconcileTrailingToolCalls(messages);
		expect(result).toHaveLength(4);
		expect((result[3] as { toolCallId: string }).toolCallId).toBe("call-b");
	});

	it("is a no-op for an empty transcript", () => {
		const messages: AgentMessage[] = [];
		expect(reconcileTrailingToolCalls(messages)).toBe(messages);
	});
});
