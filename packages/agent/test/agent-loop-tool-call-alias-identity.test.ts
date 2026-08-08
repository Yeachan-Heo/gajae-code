import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@gajae-code/agent-core/types";
import type { Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

type PatternSchema = z.ZodObject<{ pattern: z.ZodString }>;
type PatternTool = AgentTool<PatternSchema, Record<string, never>>;
type EmptySchema = z.ZodObject<Record<string, never>>;
type TestTool = AgentTool<EmptySchema, Record<string, never>>;

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
			return { content: [{ type: "text", text: `executed:${name}` }], details: {} };
		},
	};
}

/** Mirrors gjc's real `search`: a required `pattern`, no `query`. */
function makePatternTool(name: string): PatternTool {
	return {
		name,
		label: name,
		description: `The ${name} tool`,
		parameters: z.object({ pattern: z.string() }),
		async execute() {
			return { content: [{ type: "text", text: `executed:${name}` }], details: {} };
		},
	};
}

async function collectToolResults(
	tools: Array<TestTool | PatternTool>,
	toolName: string,
	args: Record<string, unknown> = {},
): Promise<Array<{ toolName: string; isError?: boolean; text: string }>> {
	const context: AgentContext = { systemPrompt: [""], messages: [], tools };
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "tc-1", name: toolName, arguments: args }] },
			{ content: ["recovered"] },
		],
	});
	const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
	const results: Array<{ toolName: string; isError?: boolean; text: string }> = [];
	for await (const event of agentLoop([createUserMessage("go")], context, config, undefined, mock.stream)) {
		if (event.type === "tool_execution_end") {
			const first = event.result.content?.[0];
			results.push({
				toolName: event.toolName,
				isError: event.isError,
				text: first?.type === "text" ? first.text : "",
			});
		}
	}
	return results;
}

// PR #4036 red team: the dispatcher used to split `mcp__<server>__<x>_<rest>` by
// regex and treat `<rest>` as the tool name. For a two-segment MCP name the
// second segment belongs to the *tool*, so unrelated tools became the single
// unambiguous candidate and were executed. Identity is now read off the registry:
// a tool must be reachable under both a bridge-qualified name and the base that
// name qualifies, and only the instance segment may differ.
describe("agentLoop: a stale tool call name dispatches only on a provable identity match", () => {
	it("does not run the local search for a two-segment web-search MCP call", async () => {
		let searchRuns = 0;
		const results = await collectToolResults(
			[makeTool("search", { onExecute: () => searchRuns++ }), makeTool("read")],
			"mcp__brave__web_search",
		);

		expect(searchRuns).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool mcp__brave__web_search not found");
	});

	it("does not run the local search for a two-segment semantic-search MCP call", async () => {
		let searchRuns = 0;
		const results = await collectToolResults(
			[makeTool("search", { onExecute: () => searchRuns++ }), makeTool("read"), makeTool("bash")],
			"mcp__jbcontext__code_search",
		);

		expect(searchRuns).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool mcp__jbcontext__code_search not found");
	});

	// Both names parse to the base `issue` on server `github` under the old
	// split, so the cross-server guard never fired: only a schema mismatch stood
	// between the model and a write it never asked for.
	it("does not dispatch close_issue to create_issue on the same server", async () => {
		let created = 0;
		const results = await collectToolResults(
			[makeTool("mcp__github__create_issue", { onExecute: () => created++ })],
			"mcp__github__close_issue",
		);

		expect(created).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool mcp__github__close_issue not found");
	});

	// One tool reachable under two names is one candidate. Counting the names
	// instead of the tools made a legitimate rename look ambiguous and refused it.
	it("counts a tool reachable under two names as one candidate", async () => {
		let runs = 0;
		const results = await collectToolResults(
			[makeTool("mcp__srv__abc_search", { customWireName: "search", onExecute: () => runs++ })],
			"mcp__srv__xyz_search",
		);

		expect(runs).toBe(1);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(false);
		expect(results[0].text).toBe("executed:mcp__srv__abc_search");
	});

	it("dispatches when only the bridge instance segment went stale", async () => {
		let runs = 0;
		const results = await collectToolResults(
			[makeTool("mcp__srv__NEW_tool", { customWireName: "tool", onExecute: () => runs++ })],
			"mcp__srv__OLD_tool",
		);

		expect(runs).toBe(1);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(false);
		expect(results[0].text).toBe("executed:mcp__srv__NEW_tool");
	});

	// Two distinct tools both reachable as `search` on `srv`: picking one would
	// route the model at a tool it did not name.
	it("refuses to guess between two genuinely distinct candidates", async () => {
		let runs = 0;
		const results = await collectToolResults(
			[
				makeTool("search", { customWireName: "mcp__srv__abc_search", onExecute: () => runs++ }),
				makeTool("mcp__srv__def_search", { customWireName: "search", onExecute: () => runs++ }),
			],
			"mcp__srv__zzz_search",
		);

		expect(runs).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool mcp__srv__zzz_search not found");
	});

	it("keeps the base not-found message when no active tool matches", async () => {
		const results = await collectToolResults([makeTool("read"), makeTool("bash")], "mcp__srv__abc_write");

		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toBe("Tool mcp__srv__abc_write not found");
	});

	it("does not cross servers even when the base name is proven", async () => {
		let runs = 0;
		const results = await collectToolResults(
			[makeTool("mcp__alpha__abc_search", { customWireName: "search", onExecute: () => runs++ })],
			"mcp__beta__xyz_search",
		);

		expect(runs).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool mcp__beta__xyz_search not found");
	});

	// What the model receives matters as much as what runs: a mis-dispatch turned
	// the actionable not-found + discovery hint into a validation error naming a
	// tool the model never called.
	it("returns the not-found error and the discovery hint, not a foreign validation error", async () => {
		const results = await collectToolResults(
			[makePatternTool("search"), makePatternTool("search_tool_bm25")],
			"mcp__brave__web_search",
			{ query: "bun test runner" },
		);

		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).not.toContain('Validation failed for tool "search"');
		expect(results[0].text).toContain("Tool mcp__brave__web_search not found");
		expect(results[0].text).toContain("search_tool_bm25");
	});
});
