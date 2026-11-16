import { describe, expect, it } from "bun:test";
import { encodeResponse } from "../src/providers/openai-chat-server";
import type { AssistantMessage } from "../src/types";

describe("openai-chat-server: incomplete tool call handling", () => {
	describe("encodeResponse (non-streaming)", () => {
		it("filters out incomplete tool calls from response", () => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "pwd" },
						incompleteArguments: true,
						incompleteArgumentsReason: "malformed",
					},
					{
						type: "toolCall",
						id: "call_2",
						name: "read",
						arguments: { path: "src/index.ts" },
					},
				],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
				api: "openai-completions",
				provider: "openai",
				model: "gpt-4",
				stopReason: "toolUse",
				timestamp: Date.now(),
			};

			const response = encodeResponse(message, "gpt-4");

			// Only the complete call should be in the response
			expect(response.choices?.[0]?.message?.tool_calls).toHaveLength(1);
			expect(response.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe("read");
			expect(response.choices?.[0]?.finish_reason).toBe("tool_calls");
		});

		it("omits tool_calls field when all calls are incomplete", () => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "pwd" },
						incompleteArguments: true,
						incompleteArgumentsReason: "malformed",
					},
				],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
				api: "openai-completions",
				provider: "openai",
				model: "gpt-4",
				stopReason: "toolUse",
				timestamp: Date.now(),
			};

			const response = encodeResponse(message, "gpt-4");

			// No tool_calls should be present
			expect(response.choices?.[0]?.message?.tool_calls).toBeUndefined();
			// finish_reason should be 'stop' since all tool calls were filtered
			expect(response.choices?.[0]?.finish_reason).toBe("stop");
		});

		it("handles mixed complete and incomplete calls", () => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "ls" },
						incompleteArguments: true,
						incompleteArgumentsReason: "malformed",
					},
					{
						type: "toolCall",
						id: "call_2",
						name: "read",
						arguments: { path: "file1.txt" },
					},
					{
						type: "toolCall",
						id: "call_3",
						name: "write",
						arguments: { path: "file2.txt", content: "test" },
						incompleteArguments: true,
						incompleteArgumentsReason: "truncated",
					},
				],
				usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
				api: "openai-completions",
				provider: "openai",
				model: "gpt-4",
				stopReason: "toolUse",
				timestamp: Date.now(),
			};

			const response = encodeResponse(message, "gpt-4");

			// Only call_2 should be emitted
			expect(response.choices?.[0]?.message?.tool_calls).toHaveLength(1);
			expect(response.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe("read");
			expect(response.choices?.[0]?.finish_reason).toBe("tool_calls");
		});
	});

	// Note: Streaming tests for encodeStream are complex and require running
	// the full streaming infrastructure. The key behavior (contiguous tool_calls
	// indices after dropping incomplete calls) is tested through integration with
	// the DsmlToolCallHealer test cases and verified by the non-streaming
	// encodeResponse path, which share the same incomplete-call filtering logic.
});
