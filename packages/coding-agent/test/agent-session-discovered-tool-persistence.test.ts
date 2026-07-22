import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import { buildSessionContext, SessionManager } from "../src/session/session-manager";
import { selectRestorableDiscoveredBuiltinToolNames } from "../src/tool-discovery/tool-index";

function builtin(name: string, loadMode: "discoverable" | "essential" | "none" = "discoverable"): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: name }] }),
		loadMode: loadMode === "none" ? undefined : loadMode,
	} as AgentTool;
}

describe("discovered built-in tool persistence", () => {
	it("round-trips selected built-ins independently from MCP selections and supports explicit clearing", () => {
		const session = SessionManager.inMemory();
		session.appendMCPToolSelection(["mcp__docs_search"]);
		session.appendDiscoveredBuiltinToolSelection(["search_tool_bm25"]);
		let context = session.buildSessionContext();
		expect(context.selectedMCPToolNames).toEqual(["mcp__docs_search"]);
		expect(context.selectedDiscoveredBuiltinToolNames).toEqual(["search_tool_bm25"]);
		expect(context.hasPersistedMCPToolSelection).toBe(true);
		expect(context.hasPersistedDiscoveredBuiltinToolSelection).toBe(true);

		session.appendDiscoveredBuiltinToolSelection([]);
		context = session.buildSessionContext();
		expect(context.selectedMCPToolNames).toEqual(["mcp__docs_search"]);
		expect(context.selectedDiscoveredBuiltinToolNames).toEqual([]);
	});

	it("keeps the prior built-in selection when a later legacy envelope omits the field", () => {
		const context = buildSessionContext([
			{
				type: "mcp_tool_selection",
				id: "legacy-selection",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				selectedToolNames: ["mcp__docs_search"],
				selectedDiscoveredBuiltinToolNames: ["search_tool_bm25"],
			},
			{
				type: "mcp_tool_selection",
				id: "mcp-selection",
				parentId: "legacy-selection",
				timestamp: new Date(1).toISOString(),
				selectedToolNames: ["mcp__other_search"],
			},
		]);
		expect(context.selectedMCPToolNames).toEqual(["mcp__other_search"]);
		expect(context.selectedDiscoveredBuiltinToolNames).toEqual(["search_tool_bm25"]);
	});

	it("preserves legacy entries without a built-in selection field", () => {
		const context = buildSessionContext([
			{
				type: "mcp_tool_selection",
				id: "selection",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				selectedToolNames: ["mcp__docs_search"],
			},
		]);
		expect(context.selectedMCPToolNames).toEqual(["mcp__docs_search"]);
		expect(context.selectedDiscoveredBuiltinToolNames).toBeUndefined();
	});

	it("restores only still-eligible discoverable built-ins", () => {
		const registry = new Map<string, AgentTool>([
			["search_tool_bm25", builtin("search_tool_bm25")],
			["goal", builtin("goal", "essential")],
			["hidden_tool", builtin("hidden_tool", "none")],
			["disallowed_tool", builtin("disallowed_tool")],
		]);
		expect(
			selectRestorableDiscoveredBuiltinToolNames(
				["search_tool_bm25", "goal", "hidden_tool", "disallowed_tool", "removed_tool", "search_tool_bm25"],
				registry,
				new Set(["search_tool_bm25", "goal", "hidden_tool"]),
			),
		).toEqual(["search_tool_bm25"]);
	});
});
