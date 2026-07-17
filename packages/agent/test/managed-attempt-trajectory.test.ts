import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@gajae-code/agent-core/types";
import type { AssistantMessage, Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

describe("managed attempt trajectory", () => {
	it("preserves incomplete tool-call metadata without executing it", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const parameters = z.object({ path: z.string(), content: z.string() });
		const tool: AgentTool<typeof parameters, Record<string, never>> = {
			name: "write_file",
			label: "Write",
			description: "Write a file",
			parameters,
			async execute(_id, args) {
				executed.push(args as Record<string, unknown>);
				return { content: [{ type: "text", text: "wrote" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tc-incomplete",
							name: "write_file",
							arguments: { path: "a.ts" },
							incompleteArguments: true,
						},
					],
					stopReason: "length",
				},
				{ content: ["recovered"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, fallbackManaged: true };
		const assistantMessages: AssistantMessage[] = [];
		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("write the file")], context, config, undefined, mock.stream);

		for await (const event of stream) {
			if (event.type === "message_end" && event.message.role === "assistant") {
				assistantMessages.push(event.message);
			}
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		expect(assistantMessages[0]?.content).toContainEqual({
			type: "toolCall",
			id: "tc-incomplete",
			name: "write_file",
			arguments: { path: "a.ts" },
			incompleteArguments: true,
		});
		expect(executed).toHaveLength(0);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({ isError: true });
		expect(toolResults[0]?.text).toContain("cut off");
	});
});
