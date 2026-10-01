import { describe, expect, it } from "bun:test";
import { convertOpenAICodexResponsesTools } from "../src/providers/openai-codex-responses";
import { convertTools } from "../src/providers/openai-responses";
import type { Tool } from "../src/types";
import { normalizeSchemaForMCP } from "../src/utils/schema";
import { validateToolArguments } from "../src/utils/validation";
import { createBaseModel } from "./openai-tool-choice-test-helpers";

// Linear's tools/list schema has no required array: each parent selector and
// statusUpdateType is optional. The server checks their combinations at runtime.
const linearSchema = {
	type: "object",
	properties: {
		limit: { type: "number", default: 50, maximum: 250 },
		cursor: { type: "string" },
		orderBy: { type: "string", default: "updatedAt", enum: ["createdAt", "updatedAt"] },
		issueId: { type: "string" },
		projectId: { type: "string" },
		initiativeId: { type: "string" },
		documentId: { type: "string" },
		milestoneId: { type: "string" },
		statusUpdateId: { type: "string" },
		statusUpdateType: { type: "string", enum: ["project", "initiative"] },
	},
	additionalProperties: false,
};

function linearTool(strict?: boolean): Tool {
	return {
		name: "mcp__linear_list_comments",
		description: "List comments on exactly one parent; statusUpdateType is only valid with statusUpdateId.",
		parameters: normalizeSchemaForMCP(linearSchema) as Tool["parameters"],
		...(strict === undefined ? {} : { strict }),
	};
}

interface FunctionPayload {
	type: "function";
	strict?: boolean | null;
	parameters?: Record<string, unknown> | null;
}

const converters: Array<{ name: string; convert: (tool: Tool, strictMode: boolean) => FunctionPayload }> = [
	{
		name: "OpenAI Responses",
		convert(tool, strictMode) {
			const [payload] = convertTools([tool], strictMode, createBaseModel("openai-responses"));
			if (payload?.type !== "function") throw new Error("Expected a function tool");
			return payload;
		},
	},
	{
		name: "Codex Responses",
		convert(tool) {
			const [payload] = convertOpenAICodexResponsesTools([tool], createBaseModel("openai-codex-responses"));
			if (payload?.type !== "function") throw new Error("Expected a function tool");
			return payload;
		},
	},
];

for (const { name, convert } of converters) {
	describe(`${name} optional MCP tool fields`, () => {
		it("explicitly disables implicit strict normalization for unadapted tools", () => {
			const tool = linearTool();
			const payload = convert(tool, false);

			expect(payload.strict).toBe(false);
			expect(payload.parameters?.required).toBeUndefined();
			expect(JSON.stringify(payload.parameters?.properties)).toBe(JSON.stringify(linearSchema.properties));
			expect(
				validateToolArguments(tool, {
					type: "toolCall",
					id: "issue-comments",
					name: tool.name,
					arguments: { issueId: "LIN-123" },
				}),
			).toEqual({ issueId: "LIN-123" });
		});

		it("honors a per-tool strict opt-out without making parent selectors required", () => {
			const payload = convert(linearTool(false), true);

			expect(payload.strict).toBe(false);
			expect(payload.parameters?.required).toBeUndefined();
			expect(JSON.stringify(payload.parameters?.properties)).toBe(JSON.stringify(linearSchema.properties));
		});

		it("explicitly disables strict mode when an open map cannot be strictified", () => {
			const schema = {
				type: "object",
				properties: { headers: { type: "object", additionalProperties: { type: "string" } } },
			};
			const payload = convert(
				{ name: "request", description: "Send headers", strict: true, parameters: schema },
				true,
			);

			expect(payload.strict).toBe(false);
			expect(payload.parameters).toMatchObject(schema);
		});

		it("keeps adapted strict tools nullable and strips omitted selectors before execution", () => {
			const tool = linearTool(true);
			const payload = convert(tool, true);
			const properties = payload.parameters?.properties as Record<string, unknown>;

			expect(payload.strict).toBe(true);
			expect(payload.parameters?.required).toEqual(Object.keys(linearSchema.properties));
			expect(properties.statusUpdateType).toEqual({
				anyOf: [{ type: "string", enum: ["project", "initiative"] }, { type: "null" }],
			});
			const args: Record<string, string | null> = Object.fromEntries(
				Object.keys(linearSchema.properties).map(key => [key, null]),
			);
			args.issueId = "LIN-123";
			expect(
				validateToolArguments(tool, { type: "toolCall", id: "issue-comments", name: tool.name, arguments: args }),
			).toEqual({ issueId: "LIN-123" });
			expect(JSON.stringify(tool.parameters)).toBe(JSON.stringify(linearSchema));
		});
	});
}
