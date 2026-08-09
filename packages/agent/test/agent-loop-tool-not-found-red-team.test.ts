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

function makeTool(
	name: string,
	options: {
		customWireName?: string;
		onExecute?: () => void;
	} = {},
): TestTool {
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

	// Issue #3917, captured sessions 019fd580/019fd583/019fd595: the model called
	// `mcp__<server>__<instance>_search` while `search` was active, five times
	// across three sessions, and each bare not-found burned a whole turn. A
	// registry that exposes the tool under both its bare name and a bridge form
	// still does not make the sent name readable: it splits into a rotated
	// instance plus `search` and into that server's own `wbg7pcrl46bd_search`
	// with equal force. The turn is recovered by the discovery hint, never by
	// executing a tool the model did not name.
	it("does not dispatch a call carrying a stale MCP bridge namespace", async () => {
		let searchRuns = 0;
		let readRuns = 0;
		const toolName = "mcp__jzi2uzmxd57z__wbg7pcrl46bd_search";
		const toolResults = await collectToolResults(
			[
				makeTool("search", {
					customWireName: "mcp__jzi2uzmxd57z__mr6er53iidr3_search",
					onExecute: () => searchRuns++,
				}),
				makeTool("read", { onExecute: () => readRuns++ }),
			],
			toolName,
		);

		expect(searchRuns).toBe(0);
		expect(readRuns).toBe(0);
		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
	});

	// Bridges mint a fresh instance segment per session, but a rotated segment and
	// the head of a two-segment tool name are the same string to the registry.
	it("does not dispatch when only the bridge instance segment differs", async () => {
		let runs = 0;
		const toolName = "mcp__jzi2uzmxd57z__jgspauo3hmi5_subagent";
		const toolResults = await collectToolResults(
			[
				makeTool("mcp__jzi2uzmxd57z__gbbgnmhc3qkt_subagent", {
					customWireName: "subagent",
					onExecute: () => runs++,
				}),
			],
			toolName,
		);

		expect(runs).toBe(0);
		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
	});

	// The bridge-qualified form the registry knows may be the customWireName. It
	// proves the live name either way, and never the one the model sent.
	it("does not dispatch a lookalike reachable only through customWireName", async () => {
		let runs = 0;
		const toolName = "mcp__srv__stale_edit";
		const toolResults = await collectToolResults(
			[makeTool("edit", { customWireName: "mcp__srv__abc_edit", onExecute: () => runs++ })],
			toolName,
		);

		expect(runs).toBe(0);
		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
	});

	// Two tools whose names differ only in the segment the call also differs in.
	// Naming either one asserts an identity the registry cannot prove, so the
	// error carries the requested name and nothing else.
	it("keeps the not-found error and names no alias when two tools match the shape", async () => {
		let runs = 0;
		const toolName = "mcp__srv__stale_search";
		const toolResults = await collectToolResults(
			[
				makeTool("mcp__srv__abc_search", { onExecute: () => runs++ }),
				makeTool("mcp__srv__xyz_search", { onExecute: () => runs++ }),
			],
			toolName,
		);

		expect(runs).toBe(0);
		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
		expect(toolResults[0].text).not.toContain("It is active as");
	});

	it("does not invent an alias when no active tool shares the base name", async () => {
		const toolName = "mcp__srv__abc_write";
		const toolResults = await collectToolResults([makeTool("read"), makeTool("search")], toolName);

		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
		expect(toolResults[0].text).not.toContain("It is active as");
	});

	// Two servers can expose the same tool name, and routing the model at the
	// wrong server's tool is worse than the dead end.
	it("does not cross servers when suggesting an alias", async () => {
		const toolName = "mcp__alpha__abc_search";
		const toolResults = await collectToolResults([makeTool("mcp__beta__abc_search")], toolName);

		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
		expect(toolResults[0].text).not.toContain("It is active as");
	});

	// A namespaced name that merely ends in the discovery name is not proof that
	// discovery is callable: the registry cannot tell a bridged `search_tool_bm25`
	// from the server's own `abc_search_tool_bm25`. No hint beats a hint that
	// names some other server's tool.
	it("does not name a namespaced lookalike as the discovery call name", async () => {
		const toolName = "remembered_discoverable_tool";
		const toolResults = await collectToolResults([makeTool("mcp__srv__abc_search_tool_bm25")], toolName);

		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
		expect(toolResults[0].text).toBe(`Tool ${toolName} not found`);
	});

	// `mcp__srv__danger_search_tool_bm25` is one string with two readings: a
	// bridged `search_tool_bm25`, or the server's own `danger_search_tool_bm25`.
	// The registry cannot tell them apart, so naming it as discovery would point
	// the model at a tool it never asked for.
	it("does not name a bridged lookalike as the discovery tool", async () => {
		const toolName = "missing_tool";
		const toolResults = await collectToolResults([makeTool("mcp__srv__danger_search_tool_bm25")], toolName);

		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
		expect(toolResults[0].text).toBe("Tool missing_tool not found");
	});

	it("hints discovery when the literal call name is callable next to a lookalike", async () => {
		const toolName = "remembered_discoverable_tool";
		const toolResults = await collectToolResults(
			[makeTool("mcp__srv__abc_search_tool_bm25"), makeTool("search_tool_bm25")],
			toolName,
		);

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].text).toContain(DISCOVERY_HINT);
	});
});
