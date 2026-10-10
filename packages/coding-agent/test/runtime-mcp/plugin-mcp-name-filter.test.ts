import { describe, expect, test } from "bun:test";
import {
	omitPluginMcpNameShadows,
	retainPluginMcpMandatoryNames,
	survivingPluginMcpToolNames,
} from "../../src/runtime-mcp/plugin-mcp-name-filter";

function tool(name: string, server: string, plugin: boolean) {
	return { name, mcpServerName: server, gjcPluginBundle: plugin, description: `${server}:${name}` };
}

describe("omitPluginMcpNameShadows", () => {
	test("withholds every tool from a plugin server that shares a normalized name", () => {
		const visible = omitPluginMcpNameShadows([
			tool("mcp__my_server_search", "my-server", false),
			tool("mcp__my_server_search", "my", true),
			tool("mcp__my_server_other", "my", true),
		]);
		expect(visible.map(item => item.mcpServerName)).toEqual(["my-server"]);
	});

	test("keeps a plugin server whose names are unique", () => {
		const visible = omitPluginMcpNameShadows([
			tool("mcp__my_server_search", "my-server", false),
			tool("mcp__other_lookup", "my", true),
		]);
		expect(visible.map(item => item.description)).toEqual([
			"my-server:mcp__my_server_search",
			"my:mcp__other_lookup",
		]);
	});

	test("does not change a collision between non-plugin servers", () => {
		const input = [tool("mcp__my_search", "my3", false), tool("mcp__my_search", "my", false)];
		expect(omitPluginMcpNameShadows(input)).toEqual(input);
	});

	test("mandatory names come from surviving plugin tools", () => {
		const tools = [
			tool("mcp__my_server_search", "my-server", false),
			tool("mcp__my_server_search", "my", true),
			tool("mcp__my_other", "my", true),
			tool("mcp__safe_lookup", "safe", true),
		];
		expect(survivingPluginMcpToolNames(tools)).toEqual(["mcp__safe_lookup"]);
		expect(
			retainPluginMcpMandatoryNames(tools, [
				"mcp__my_server_search",
				"mcp__my_other",
				"mcp__safe_lookup",
				"mcp__kept_elsewhere",
			]),
		).toEqual(["mcp__my_other", "mcp__safe_lookup", "mcp__kept_elsewhere"]);
		expect(retainPluginMcpMandatoryNames([tool("mcp__docs_search", "docs", false)], ["mcp__docs_search"])).toEqual([
			"mcp__docs_search",
		]);
	});
});
