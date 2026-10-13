import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "@gajae-code/agent-core/types";
import type { AssistantMessage, Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** Drop the typed reason from a tool call: the shape an older producer reports. */
function stripTypedReason(block: AssistantMessage["content"][number]): AssistantMessage["content"][number] {
	if (block.type !== "toolCall") return block;
	const { incompleteArgumentsReason: _dropped, ...rest } = block;
	return rest;
}

function stripMessage(message: AssistantMessage): AssistantMessage {
	return { ...message, content: message.content.map(stripTypedReason) };
}

/**
 * Republish a provider stream with the typed reason stripped from every
 * tool-call surface, so the turn carries only `incompleteArguments` — the
 * backward-compatible shape the whose cause is genuinely unknown.
 */
function withoutTypedReason(streamFn: StreamFn): StreamFn {
	return (providerModel, context, options) => {
		const forwarded = new AssistantMessageEventStream();
		void (async () => {
			const source = await streamFn(providerModel, context, options);
			for await (const event of source) {
				forwarded.push(
					event.type === "done"
						? { ...event, message: stripMessage(event.message) }
						: event.type === "error"
							? { ...event, error: stripMessage(event.error) }
							: event.type === "toolcall_end"
								? { ...event, toolCall: stripTypedReason(event.toolCall) as typeof event.toolCall }
								: event,
				);
			}
		})();
		return forwarded;
	};
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

	async function runWithReason(
		reason: "truncated" | "malformed" | "conflicting" | "ambiguous" | undefined,
		stopReason: "length" | "toolUse" = "length",
	): Promise<string> {
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
							...(reason === undefined ? {} : { incompleteArgumentsReason: reason }),
						},
					],
					stopReason,
				},
				{ content: ["recovered"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, fallbackManaged: true };
		const streamFn = reason === undefined ? withoutTypedReason(mock.stream) : mock.stream;
		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("write the file")], context, config, undefined, streamFn);
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
		expect(text).toContain("output token limit");
		expect(text.toLowerCase()).toContain("re-issue");
	});

	it("uses the output-token-limit wording for a length-stopped turn with no typed reason", async () => {
		const text = await runWithReason(undefined, "length");
		expect(text).toContain("cut off");
		expect(text).toContain("output token limit");
		expect(text.toLowerCase()).toContain("re-issue");
	});

	it("does not blame the output token limit when the turn did not stop for length", async () => {
		// A producer that set only the boolean (no typed reason) leaves the cause
		// unknown. The turn stopped on `toolUse` with a small output budget, so
		// claiming the response hit its output token limit is a false diagnosis.
		const text = await runWithReason(undefined, "toolUse");
		expect(text).not.toContain("output token limit");
		expect(text).toContain("incomplete before its arguments finished streaming");
		expect(text.toLowerCase()).toContain("re-issue");
	});

	it("matches the adapter's malformed reason on a length-stopped turn", async () => {
		// The block is exactly what the anthropic adapter records after a partial
		// `edit` call: the terminal arguments did not decode, so the block's own
		// `malformed` reason is the cause — not a truncated stream.
		const text = await runWithReason("malformed", "length");
		expect(text).toContain("did not decode to a valid JSON object");
		expect(text).not.toContain("output token limit");
		expect(text).not.toContain("cut off");
		expect(text.toLowerCase()).toContain("re-issue");
	});

	it("matches the adapter's malformed reason when the turn stopped on toolUse", async () => {
		// Same block on a `toolUse` turn — the exact shape of the reported session.
		// The typed reason must still win: the request never hit an output limit.
		const text = await runWithReason("malformed", "toolUse");
		expect(text).toContain("did not decode to a valid JSON object");
		expect(text).not.toContain("output token limit");
		expect(text).not.toContain("cut off");
		expect(text.toLowerCase()).toContain("re-issue");
	});
});
