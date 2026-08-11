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

describe("agentLoop: truncated tool-call guard", () => {
	it("rejects a tool call flagged incompleteArguments without executing it", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const toolSchema = z.object({ path: z.string(), content: z.string() });
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "write_file",
			label: "Write",
			description: "Write a file",
			parameters: toolSchema,
			async execute(_id, params) {
				executed.push(params as Record<string, unknown>);
				return { content: [{ type: "text", text: "wrote" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					// Provider flagged the arguments as truncated (hit max output tokens).
					content: [
						{
							type: "toolCall",
							id: "tc-1",
							name: "write_file",
							arguments: { path: "a.ts", content: "partial" }, // schema-valid repaired payload
							incompleteArguments: true,
						},
					],
					stopReason: "length",
				},
				{ content: ["recovered"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, fallbackManaged: true };

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("write the file")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		// The tool must never have run on the truncated input.
		expect(executed).toHaveLength(0);

		// Exactly one (error) tool result, with an actionable truncation message.
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].text).toContain("cut off");
		expect(toolResults[0].text.toLowerCase()).toContain("re-issue");
	});

	it("executes normally when incompleteArguments is not set", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const toolSchema = z.object({ path: z.string() });
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "read_file",
			label: "Read",
			description: "Read a file",
			parameters: toolSchema,
			async execute(_id, params) {
				executed.push(params as Record<string, unknown>);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tc-1", name: "read_file", arguments: { path: "a.ts" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("read it")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		expect(executed).toEqual([{ path: "a.ts" }]);
	});
});

describe("agentLoop: reason-specific incompleteArguments guidance", () => {
	function identityConverter(messages: AgentMessage[]): Message[] {
		return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
	}

	async function runWithReason(reason: "truncated" | "malformed" | "conflicting" | "ambiguous"): Promise<string> {
		const toolSchema = z.object({ path: z.string(), content: z.string() });
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "write_file",
			label: "Write",
			description: "Write a file",
			parameters: toolSchema,
			async execute() {
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
							id: "tc-1",
							name: "write_file",
							arguments: { path: "a.ts", content: "partial" },
							incompleteArguments: true,
							incompleteArgumentsReason: reason,
						},
					],
					stopReason: "length",
				},
				{ content: ["recovered"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, fallbackManaged: true };
		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("write the file")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
		return toolResults[0].text;
	}

	it("gives malformed-specific guidance (not truncation) for malformed terminal arguments", async () => {
		const text = await runWithReason("malformed");
		expect(text).toContain("did not decode to a valid JSON object");
		expect(text).not.toContain("cut off");
		expect(text.toLowerCase()).toContain("re-issue");
	});

	it("gives conflicting-specific guidance for streamed/terminal payload disagreement", async () => {
		const text = await runWithReason("conflicting");
		expect(text).toContain("disagree");
		expect(text).not.toContain("cut off");
		expect(text.toLowerCase()).toContain("re-issue");
	});

	it("gives ambiguous-identity guidance for duplicate call_id / id collision", async () => {
		const text = await runWithReason("ambiguous");
		expect(text).toContain("ambiguous");
		expect(text).toContain("call id");
		expect(text.toLowerCase()).toContain("re-issue");
	});

	it("still gives truncation guidance when reason is truncated", async () => {
		const text = await runWithReason("truncated");
		expect(text).toContain("cut off");
		expect(text.toLowerCase()).toContain("re-issue");
	});

	it("falls back to truncation guidance when reason is absent but boolean is set", async () => {
		const toolSchema = z.object({ path: z.string(), content: z.string() });
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "write_file",
			label: "Write",
			description: "Write a file",
			parameters: toolSchema,
			async execute() {
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
							id: "tc-1",
							name: "write_file",
							arguments: { path: "a.ts", content: "partial" },
							incompleteArguments: true,
							// No reason — backward-compatible callers.
						},
					],
					stopReason: "length",
				},
				{ content: ["recovered"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, fallbackManaged: true };
		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("write the file")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].text).toContain("cut off");
		expect(toolResults[0].text.toLowerCase()).toContain("re-issue");
	});
});
