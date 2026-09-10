import { describe, expect, it } from "bun:test";

import { buildCursorUsageToolsKeyForTest } from "../src/providers/cursor";
import type { Tool } from "../src/types";

class SessionBackedTool implements Tool {
	readonly name = "ast_grep";
	readonly description = "Search code with AST patterns";
	readonly parameters = {
		type: "object" as const,
		properties: {
			pattern: { type: "string" },
		},
		required: ["pattern"],
	};

	constructor(
		readonly session: {
			fileIdentity: { dev: bigint; ino: bigint; mtimeNs: bigint };
		},
	) {}
}

describe("Cursor usage-context tool identity", () => {
	it("hashes the wire tool definition without traversing session-backed runtime state", () => {
		const sessionBackedTool = new SessionBackedTool({
			fileIdentity: {
				dev: 1n,
				ino: 2n,
				mtimeNs: 3n,
			},
		});
		const equivalentWireTool: Tool = {
			name: sessionBackedTool.name,
			description: sessionBackedTool.description,
			parameters: sessionBackedTool.parameters,
		};

		expect(buildCursorUsageToolsKeyForTest([sessionBackedTool])).toBe(
			buildCursorUsageToolsKeyForTest([equivalentWireTool]),
		);
	});

	it("changes when an advertised wire definition changes", () => {
		const baseTool: Tool = {
			name: "ast_grep",
			description: "Search code with AST patterns",
			parameters: { type: "object", properties: { pattern: { type: "string" } } },
		};
		const baseKey = buildCursorUsageToolsKeyForTest([baseTool]);

		expect(buildCursorUsageToolsKeyForTest([{ ...baseTool, name: "irc" }])).not.toBe(baseKey);
		expect(buildCursorUsageToolsKeyForTest([{ ...baseTool, description: "Different description" }])).not.toBe(
			baseKey,
		);
		expect(
			buildCursorUsageToolsKeyForTest([
				{ ...baseTool, parameters: { type: "object", properties: { pattern: { type: "number" } } } },
			]),
		).not.toBe(baseKey);
	});

	it("ignores native tools that are not advertised through the MCP wire context", () => {
		const astGrepTool: Tool = {
			name: "ast_grep",
			description: "Search code with AST patterns",
			parameters: { type: "object", properties: { pattern: { type: "string" } } },
		};
		const nativeReadTool: Tool = {
			name: "read",
			description: "Read files",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		};

		expect(buildCursorUsageToolsKeyForTest([astGrepTool, nativeReadTool])).toBe(
			buildCursorUsageToolsKeyForTest([astGrepTool]),
		);
	});
});
