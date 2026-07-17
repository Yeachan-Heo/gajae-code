import { describe, expect, it } from "bun:test";
import { buildDiscoverableToolSearchIndex, searchDiscoverableTools } from "../../src/tool-discovery/tool-index";

describe("discoverable tool index", () => {
	it("searches persisted MCP descriptors through the unified index", () => {
		const index = buildDiscoverableToolSearchIndex([
			{
				name: "mcp__github_create_issue",
				label: "github/create_issue",
				summary: "Create a GitHub issue",
				description: "Create a GitHub issue",
				source: "mcp" as const,
				serverName: "github",
				mcpToolName: "create_issue",
				schemaKeys: ["title"],
			},
		]);
		expect(searchDiscoverableTools(index, "github issue", 5).map(result => result.tool.name)).toEqual([
			"mcp__github_create_issue",
		]);
	});
});
