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
// unambiguous candidate and were executed. Reading the split off the registry
// instead does not rescue it: `mcp__<server>__<x>_<base>` denotes a stale bridge
// instance in front of `base` and that server's own `<x>_<base>` with equal
// force, and the registry only ever proves the name the tool is live under, never
// the one the model sent. An unresolvable call name is therefore echoed back
// untouched — no dispatch, and no guessed alias in the error, because reaching a
// tool the model never named costs more than the dead end it replaces.
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
		expect(results[0].text).not.toContain("It is active as");
	});

	// The registry proves what `search` is callable as *now*. It cannot prove what
	// the model meant by a name that differs from it: `mcp__brave__web_search` is
	// a stale instance in front of `search` and brave's own `web_search` with the
	// instance dropped, in the same breath. Guessing here executes a tool.
	it("does not dispatch a bridged tool when only the instance segment differs", async () => {
		let searchRuns = 0;
		const results = await collectToolResults(
			[makeTool("search", { customWireName: "mcp__brave__current_search", onExecute: () => searchRuns++ })],
			"mcp__brave__web_search",
		);

		expect(searchRuns).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool mcp__brave__web_search not found");
	});

	// A base name that contains the separator does not make the split provable
	// either: `stale_internal_edit` is as good a tool name as a stale instance
	// segment in front of `internal_edit`.
	it("does not dispatch onto a base name that contains underscores", async () => {
		let runs = 0;
		const results = await collectToolResults(
			[makeTool("internal_edit", { customWireName: "mcp__srv__abc_internal_edit", onExecute: () => runs++ })],
			"mcp__srv__stale_internal_edit",
		);

		expect(runs).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool mcp__srv__stale_internal_edit not found");
	});

	// A tool reachable under two names is still only one proven name per session,
	// and `xyz_search` reads as a tool name just as well as a rotated instance id.
	it("does not dispatch a tool reachable under both a bridge form and its base", async () => {
		let runs = 0;
		const results = await collectToolResults(
			[makeTool("mcp__srv__abc_search", { customWireName: "search", onExecute: () => runs++ })],
			"mcp__srv__xyz_search",
		);

		expect(runs).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool mcp__srv__xyz_search not found");
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

	// Both names parse to the base `issue` on server `github`, so any split-based
	// identity check reads them as the same tool. Suggesting `create_issue` for a
	// `close_issue` call points the model at a write it never asked for.
	it("neither dispatches nor suggests create_issue for a close_issue call", async () => {
		let created = 0;
		const results = await collectToolResults(
			[makeTool("mcp__github__create_issue", { onExecute: () => created++ })],
			"mcp__github__close_issue",
		);

		expect(created).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool mcp__github__close_issue not found");
		expect(results[0].text).not.toContain("It is active as `mcp__github__create_issue`");
	});

	// Issue #3917, captured sessions 019fd580/019fd583/019fd595: the model called
	// `mcp__<server>__<instance>_search` while `search` was active. The registry
	// holds a bare `search` and nothing that ties the foreign namespace to it, so
	// the recovery the model gets is tool discovery, not a guessed rename.
	it("answers a foreign bridge namespace with discovery rather than a rename", async () => {
		let searchRuns = 0;
		const results = await collectToolResults(
			[makeTool("search", { onExecute: () => searchRuns++ }), makeTool("search_tool_bm25")],
			"mcp__jzi2uzmxd57z__mr6er53iidr3_search",
		);

		expect(searchRuns).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool mcp__jzi2uzmxd57z__mr6er53iidr3_search not found");
		expect(results[0].text).not.toContain("It is active as");
		expect(results[0].text).toContain("search_tool_bm25");
	});

	it("keeps the base not-found message when no active tool matches", async () => {
		const results = await collectToolResults([makeTool("read"), makeTool("bash")], "mcp__srv__abc_write");

		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toBe("Tool mcp__srv__abc_write not found");
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
