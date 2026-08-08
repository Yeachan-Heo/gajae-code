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

	// Issue #3917, captured sessions 019fd580/019fd583/019fd595: the model called
	// `mcp__<server>__<instance>_search` while `search` was active, five times
	// across three sessions, and each bare not-found burned a whole turn.
	// The registry exposes the tool under both its bare name and the bridge form
	// the live session mints, so only the instance segment is stale: the call is a
	// rename, not a dead end, and is dispatched. Without that pair the split would
	// be a guess — `mcp__brave__web_search` looks exactly the same.
	it("dispatches a call carrying a stale MCP bridge namespace to the one tool it denotes", async () => {
		let searchRuns = 0;
		let readRuns = 0;
		const toolResults = await collectToolResults(
			[
				makeTool("search", {
					customWireName: "mcp__jzi2uzmxd57z__mr6er53iidr3_search",
					onExecute: () => searchRuns++,
				}),
				makeTool("read", { onExecute: () => readRuns++ }),
			],
			"mcp__jzi2uzmxd57z__wbg7pcrl46bd_search",
		);

		expect(searchRuns).toBe(1);
		expect(readRuns).toBe(0);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(false);
		expect(toolResults[0].text).toBe("executed");
	});

	// Bridges mint a fresh instance segment per session, so a name replayed from
	// earlier context differs from the live registry only in that segment.
	it("dispatches when only the bridge instance segment went stale", async () => {
		let runs = 0;
		const toolResults = await collectToolResults(
			[
				makeTool("mcp__jzi2uzmxd57z__gbbgnmhc3qkt_subagent", {
					customWireName: "subagent",
					onExecute: () => runs++,
				}),
			],
			"mcp__jzi2uzmxd57z__jgspauo3hmi5_subagent",
		);

		expect(runs).toBe(1);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(false);
		expect(toolResults[0].text).toBe("executed");
	});

	// The bridge-qualified form the registry knows may be the customWireName; the
	// dispatcher resolves through it exactly as it does through `name`.
	it("dispatches an alias reachable only through customWireName", async () => {
		let runs = 0;
		const toolResults = await collectToolResults(
			[makeTool("edit", { customWireName: "mcp__srv__abc_edit", onExecute: () => runs++ })],
			"mcp__srv__stale_edit",
		);

		expect(runs).toBe(1);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(false);
		expect(toolResults[0].text).toBe("executed");
	});

	// Two candidates stay a not-found error naming both: picking one would route
	// the model at a tool it did not ask for.
	it("keeps the not-found error and lists both names when two tools match", async () => {
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
		expect(toolResults[0].text).toContain("It is active as `mcp__srv__abc_search` or `mcp__srv__xyz_search`");
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

	// Emitting the bare `search_tool_bm25` literal here would name a second
	// non-callable tool, so the hint has to carry the bridged call name.
	it("points at the bridged discovery call name instead of the bare literal", async () => {
		const toolName = "remembered_discoverable_tool";
		const toolResults = await collectToolResults([makeTool("mcp__srv__abc_search_tool_bm25")], toolName);

		expect(toolResults).toHaveLength(1);
		expectBaseNotFound(toolResults[0], toolName);
		expect(toolResults[0].text).toContain("call `mcp__srv__abc_search_tool_bm25` to discover");
		expect(toolResults[0].text).not.toContain("call `search_tool_bm25` to discover");
	});

	it("prefers the unbridged discovery name when both are callable", async () => {
		const toolName = "remembered_discoverable_tool";
		const toolResults = await collectToolResults(
			[makeTool("mcp__srv__abc_search_tool_bm25"), makeTool("search_tool_bm25")],
			toolName,
		);

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].text).toContain(DISCOVERY_HINT);
	});
});
