import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@gajae-code/agent-core/types";
import type { Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function makeTool(name: string): AgentTool<z.ZodObject<Record<string, never>>, Record<string, never>> {
	return {
		name,
		label: name,
		description: `The ${name} tool`,
		parameters: z.object({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

async function collectToolResults(
	tools: AgentTool<z.ZodObject<Record<string, never>>, Record<string, never>>[],
): Promise<Array<{ isError?: boolean; text: string }>> {
	const context: AgentContext = { systemPrompt: [""], messages: [], tools };
	const mock = createMockModel({
		responses: [
			// The model "remembers" a discoverable tool and calls it by name even
			// though it is not in the active tool set.
			{ content: [{ type: "toolCall", id: "tc-1", name: "task", arguments: {} }] },
			{ content: ["recovered"] },
		],
	});
	const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

	const toolResults: Array<{ isError?: boolean; text: string }> = [];
	const stream = agentLoop([createUserMessage("do the thing")], context, config, undefined, mock.stream);
	for await (const event of stream) {
		if (event.type === "tool_execution_end") {
			const first = event.result.content?.[0];
			toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
		}
	}
	return toolResults;
}

describe("agentLoop: tool-not-found discovery hint", () => {
	it("appends a tool-discovery hint when search_tool_bm25 is in the active tools", async () => {
		const toolResults = await collectToolResults([makeTool("search_tool_bm25"), makeTool("read")]);

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
		// Base wording is preserved (now followed by a period) and the full
		// discover -> activate -> retry recovery sequence is spelled out.
		expect(toolResults[0].text).toContain("Tool task not found.");
		expect(toolResults[0].text).toContain("search_tool_bm25");
		expect(toolResults[0].text).toContain("discover");
		expect(toolResults[0].text).toContain("activate");
		expect(toolResults[0].text).toContain("retry");
	});

	it("does not append the hint when search_tool_bm25 is absent from the active tools", async () => {
		const toolResults = await collectToolResults([makeTool("read")]);

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
		// No discovery tool active: base wording stays byte-for-byte stable
		// (no trailing period, no hint, no `undefined` leak).
		expect(toolResults[0].text).toBe("Tool task not found");
	});
});
