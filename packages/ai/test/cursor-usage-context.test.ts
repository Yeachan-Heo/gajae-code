import { describe, expect, it } from "bun:test";

import {
	buildCursorUsageToolsKeyForTest,
	buildCursorWireToolIdentitiesForTest,
	hashCursorConversationValueForTest,
} from "../src/providers/cursor";
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
	it("hashes projected schemas containing bigint values deterministically", () => {
		const tool = {
			name: "ast_grep",
			description: "Search code with AST patterns",
			parameters: {
				type: "object",
				properties: { fileIdentity: { type: "integer", default: 16_777_234n } },
			},
		} as unknown as Tool;

		expect(() => buildCursorUsageToolsKeyForTest([tool])).not.toThrow();
		expect(buildCursorUsageToolsKeyForTest([tool])).toBe(buildCursorUsageToolsKeyForTest([tool]));
	});

	it("preserves a legal $typeName property in advertised tool schemas", () => {
		const tool = {
			name: "schema_probe",
			description: "Accept a schema field named $typeName",
			parameters: {
				type: "object",
				properties: { $typeName: { type: "string" } },
				required: ["$typeName"],
			},
		} as unknown as Tool;

		const [identity] = buildCursorWireToolIdentitiesForTest([tool]);
		expect(identity?.inputSchema).toEqual({
			type: "object",
			properties: { $typeName: { type: "string" } },
			required: ["$typeName"],
		});
	});

	it("preserves advertised schemas beyond the native payload node budget", () => {
		const properties = Object.fromEntries(
			Array.from({ length: 10_050 }, (_, index) => [`field${index}`, { type: "string" }]),
		);
		const tool = {
			name: "large_schema_probe",
			description: "Advertise a large schema without truncation",
			parameters: { type: "object", properties },
		} as unknown as Tool;

		const [identity] = buildCursorWireToolIdentitiesForTest([tool]);
		const advertisedProperties = (identity?.inputSchema as { properties?: Record<string, unknown> }).properties;
		expect(Object.keys(advertisedProperties ?? {})).toHaveLength(Object.keys(properties).length);
		expect(advertisedProperties?.field10049).toEqual({ type: "string" });
	});

	it("keeps distinct conversation values distinct after the native payload budget", () => {
		const prefix = Array.from({ length: 10_001 }, (_, index) => index);

		expect(hashCursorConversationValueForTest([...prefix, "first"])).not.toBe(
			hashCursorConversationValueForTest([...prefix, "second"]),
		);
	});

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
