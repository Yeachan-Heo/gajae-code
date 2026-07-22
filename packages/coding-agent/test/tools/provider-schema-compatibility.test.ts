import { describe, expect, it } from "bun:test";
import {
	adaptSchemaForStrict,
	normalizeSchemaForCCA,
	normalizeSchemaForGoogle,
	type SchemaCompatibilityProvider,
	type SchemaCompatibilityResult,
	toolWireSchema,
	validateSchemaCompatibility,
	validateStrictSchemaEnforcement,
} from "@gajae-code/ai/utils/schema";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@gajae-code/coding-agent/tools";

interface ToolSchemaEntry {
	name: string;
	schema: Record<string, unknown>;
}

function createTestSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function asSchemaObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

async function collectToolSchemas(): Promise<ToolSchemaEntry[]> {
	const session = createTestSession();
	const byToolName = new Map<string, Record<string, unknown>>();

	for (const tool of await createTools(session)) {
		const schema = toolWireSchema(tool);
		if (!asSchemaObject(schema)) {
			continue;
		}
		byToolName.set(tool.name, schema);
	}

	for (const [name, factory] of Object.entries(HIDDEN_TOOLS)) {
		const tool = await factory(session);
		if (!tool) {
			continue;
		}
		const schema = toolWireSchema(tool);
		if (!asSchemaObject(schema)) {
			continue;
		}
		byToolName.set(name, schema);
	}

	return [...byToolName.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, schema]) => ({ name, schema }));
}

function formatCompatibilityIssues(
	toolName: string,
	provider: SchemaCompatibilityProvider,
	result: SchemaCompatibilityResult,
): string {
	if (result.compatible) {
		return "";
	}
	const details = result.violations
		.map(violation => `  - ${violation.rule} at ${violation.path}: ${violation.message}`)
		.join("\n");
	return `${toolName} (${provider}):\n${details}`;
}

describe("builtin tool schemas provider compatibility", () => {
	it("keeps ask, task, and todo_write strict-compatible for OpenAI-style providers", async () => {
		const toolSchemas = await collectToolSchemas();
		for (const toolName of ["ask", "task", "todo_write"]) {
			const entry = toolSchemas.find(tool => tool.name === toolName);
			expect(entry).toBeDefined();
			if (!entry) {
				continue;
			}
			const strictResult = adaptSchemaForStrict(entry.schema, true);
			expect(strictResult.strict).toBe(true);
		}
	});

	it("keeps all builtin and hidden tool schemas valid after provider enforcement", async () => {
		const toolSchemas = await collectToolSchemas();
		const failures: string[] = [];

		for (const { name, schema } of toolSchemas) {
			const strictResult = adaptSchemaForStrict(schema, true);
			const strictCompatibility = validateStrictSchemaEnforcement(schema, strictResult);
			if (!strictCompatibility.compatible) {
				failures.push(formatCompatibilityIssues(name, "openai-strict", strictCompatibility));
			}

			try {
				const googleSchema = normalizeSchemaForGoogle(schema);
				const googleCompatibility = validateSchemaCompatibility(googleSchema, "google");
				if (!googleCompatibility.compatible) {
					failures.push(formatCompatibilityIssues(name, "google", googleCompatibility));
				}
			} catch (error) {
				failures.push(`${name} (google): normalizeSchemaForGoogle threw: ${String(error)}`);
			}

			const cloudCodeAssistSchema = normalizeSchemaForCCA(schema);
			const cloudCodeAssistCompatibility = validateSchemaCompatibility(
				cloudCodeAssistSchema,
				"cloud-code-assist-claude",
			);
			if (!cloudCodeAssistCompatibility.compatible) {
				failures.push(formatCompatibilityIssues(name, "cloud-code-assist-claude", cloudCodeAssistCompatibility));
			}
		}

		if (failures.length > 0) {
			throw new Error(`Provider compatibility failures:\n\n${failures.join("\n\n")}`);
		}

		expect(failures).toEqual([]);
	});
});
