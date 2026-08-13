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

const askSchema = z.object({ question: z.string() });

// Decodes cleanly, but a mistyped nibble anywhere in it would be
// indistinguishable from the correct text.
const QUESTION = "마지막 병목";

function askTool(executed: Array<Record<string, unknown>>): AgentTool<typeof askSchema, Record<string, never>> {
	return {
		name: "ask",
		label: "Ask",
		description: "Ask the user a question",
		parameters: askSchema,
		async execute(_id, params) {
			executed.push(params as Record<string, unknown>);
			return { content: [{ type: "text", text: "answered" }], details: {} };
		},
	};
}

/** A turn whose raw arguments arrived spelled as `\uXXXX` instead of literal UTF-8. */
function escapedTurn(id: string) {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "ask",
				arguments: { question: QUESTION },
				escapedNonAsciiArguments: true,
			},
		],
	};
}

/** The same turn as the model would have produced it with literal UTF-8 on the wire. */
function literalTurn(id: string) {
	return { content: [{ type: "toolCall" as const, id, name: "ask", arguments: { question: QUESTION } }] };
}

describe("agentLoop: ASCII-escaped non-ASCII argument guard", () => {
	it("resamples the turn instead of executing or reporting escaped arguments", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({
			responses: [escapedTurn("tc-1"), literalTurn("tc-2"), { content: ["done"] }],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		// The resampled call ran; the defective one neither ran nor produced an error.
		expect(executed).toEqual([{ question: QUESTION }]);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBeFalsy();
		// The resample must not replay the escaped arguments back to the model as
		// its own prior output: the retried request carries no assistant turn.
		const resampleRequest = mock.model.calls[1];
		expect(resampleRequest).toBeDefined();
		expect(resampleRequest.context.messages.some(message => message.role === "assistant")).toBe(false);
	});

	it("rejects the call once the resample budget is spent", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({
			responses: [escapedTurn("tc-1"), escapedTurn("tc-2"), escapedTurn("tc-3"), { content: ["recovered"] }],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		expect(executed).toHaveLength(0);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].text).toContain("\\uXXXX");
		expect(toolResults[0].text).toContain("literal UTF-8");
		expect(toolResults[0].text.toLowerCase()).toContain("re-issue");
	});

	it("executes literal UTF-8 arguments untouched", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [askTool(executed)] };
		const mock = createMockModel({ responses: [literalTurn("tc-1"), { content: ["done"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("ask me")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}

		expect(executed).toEqual([{ question: QUESTION }]);
	});
});
