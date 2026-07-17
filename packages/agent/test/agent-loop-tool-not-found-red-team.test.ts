import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@gajae-code/agent-core/types";
import type { Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

type EmptySchema = z.ZodObject<Record<string, never>>;
type TestTool = AgentTool<EmptySchema, Record<string, never>>;

const DISCOVERY_HINT =
	"If you are unsure whether this tool exists or how to use it, call `search_tool_bm25` to discover and activate the matching tool, then retry.";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function makeTool(name: string, options: { customWireName?: string; onExecute?: () => void } = {}): TestTool {
	return {
		name,
		label: name,
		description: `The ${name} tool`,
		parameters: z.object({}),
		...(options.customWireName === undefined ? {} : { customWireName: options.customWireName }),
		async execute() {
			options.onExecute?.();
			return { content: [{ type: "text", text: "executed" }], details: {} };
		},
	};
}

async function collectToolResults(
	tools: TestTool[] | undefined,
	toolName: string,
): Promise<Array<{ isError?: boolean; text: string }>> {
	const context: AgentContext = { systemPrompt: [""], messages: [], tools };
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "tc-1", name: toolName, arguments: {} }] },
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

function expectBaseNotFound(result: { isError?: boolean; text: string }, toolName: string): void {
	expect(result.isError).toBe(true);
	expect(result.text).toContain(`Tool ${toolName} not found`);
}

describe("agentLoop: tool-not-found discovery hint red team", () => {
	it("adds the complete discovery hint only when search_tool_bm25 is active", async () => {
		const toolName = "remembered_discoverable_tool";
		const toolResults = await collectToolResults([makeTool("search_tool_bm25"), makeTool("read")], toolName);

		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
		expect(toolResults[0].text).toContain(DISCOVERY_HINT);
	});

	it("keeps inactive discovery errors clean and free of undefined", async () => {
		const toolName = "inactive_discoverable_tool";
		const toolResults = await collectToolResults([makeTool("read")], toolName);

		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
		expect(toolResults[0].text).not.toContain("search_tool_bm25");
		expect(toolResults[0].text).not.toContain("undefined");
	});

	it("treats a discovery tool reachable only via customWireName as active discovery", async () => {
		const toolName = "custom_wire_discovery_tool";
		const toolResults = await collectToolResults(
			[makeTool("internal_discovery", { customWireName: "search_tool_bm25" })],
			toolName,
		);

		// A tool callable as `search_tool_bm25` (via customWireName) means discovery
		// is reachable, so the hint must fire — mirroring the dispatcher, which
		// resolves calls by internal name OR customWireName.
		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
		expect(toolResults[0].text).toContain(DISCOVERY_HINT);
	});

	it("emits the base error with an empty active-tool array", async () => {
		const toolName = "empty_tools_tool";
		const toolResults = await collectToolResults([], toolName);

		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
		expect(toolResults[0].text).not.toContain("undefined");
		expect(toolResults[0].text).not.toContain("search_tool_bm25");
	});

	it("emits the base error when the active-tool set is undefined", async () => {
		const toolName = "no_active_tools_tool";
		const toolResults = await collectToolResults(undefined, toolName);

		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
		expect(toolResults[0].text).not.toContain("undefined");
		expect(toolResults[0].text).not.toContain("search_tool_bm25");
	});

	it("executes a tool matched solely by customWireName", async () => {
		let executionCount = 0;
		const toolResults = await collectToolResults(
			[makeTool("internal_edit", { customWireName: "apply_patch", onExecute: () => executionCount++ })],
			"apply_patch",
		);

		expect(executionCount).toBe(1);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(false);
		expect(toolResults[0].text).toBe("executed");
	});

	it("preserves the exact base not-found substring for downstream consumers", async () => {
		const toolName = "legacy_client_tool";
		const toolResults = await collectToolResults(undefined, toolName);

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].text).toContain(`Tool ${toolName} not found`);
	});
});
