import type { AgentTool } from "@gajae-code/agent-core";
import { toolWireSchema } from "@gajae-code/ai/utils/schema/wire";

interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
}

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function tsType(schema: JsonSchema | undefined, depth: number): string {
	if (!schema || depth > 2) return "unknown";
	if (Array.isArray(schema.enum) && schema.enum.every(value => typeof value === "string")) {
		return schema.enum.map(value => JSON.stringify(value)).join(" | ");
	}
	const union = schema.anyOf ?? schema.oneOf;
	if (union?.length) return union.map(value => tsType(value, depth + 1)).join(" | ");
	switch (schema.type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "array": {
			const item = tsType(schema.items, depth + 1);
			return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
		}
		case "object": {
			if (!schema.properties) return "Record<string, unknown>";
			const required = new Set(schema.required ?? []);
			const entries = Object.entries(schema.properties).map(([key, value]) => {
				const printedKey = TS_IDENTIFIER.test(key) ? key : JSON.stringify(key);
				return `${printedKey}${required.has(key) ? "" : "?"}: ${tsType(value, depth + 1)}`;
			});
			return `{ ${entries.join("; ")} }`;
		}
		default:
			return "unknown";
	}
}

/** Compact TypeScript signatures for tools callable through eval's `tool.*` bridge. */
export function generateCodeModeDeclarations(tools: readonly AgentTool[]): string {
	return tools
		.map(tool => {
			const printedName = TS_IDENTIFIER.test(tool.name) ? tool.name : JSON.stringify(tool.name);
			const wire = toolWireSchema(tool as never) as JsonSchema;
			const args = wire.type === "object" && wire.properties ? tsType(wire, 0) : "unknown";
			return `  ${printedName}(args: ${args}): Promise<unknown>;`;
		})
		.join("\n");
}
