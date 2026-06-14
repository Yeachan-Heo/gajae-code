#!/usr/bin/env bun

import * as path from "node:path";
import { zodToWireSchema } from "../packages/ai/src/utils/schema/wire";
import { SETTINGS_SCHEMA } from "../packages/coding-agent/src/config/settings-schema";
import { ModelsConfigSchema } from "../packages/coding-agent/src/config/models-config-schema";

type JsonSchema = boolean | JsonSchemaObject;

type JsonSchemaObject = {
	[key: string]: unknown;
	$schema?: string;
	$id?: string;
	title?: string;
	description?: string;
	type?: string;
	properties?: Record<string, JsonSchema>;
	additionalProperties?: JsonSchema;
	items?: JsonSchema;
	enum?: readonly string[];
	default?: unknown;
};

type SettingsSchema = typeof SETTINGS_SCHEMA;
type SettingDefinition = SettingsSchema[keyof SettingsSchema];

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
export const JSON_SCHEMA_OUTPUTS = [
	{
		path: "schemas/config.schema.json",
		schema: createConfigJsonSchema(),
	},
	{
		path: "schemas/models.schema.json",
		schema: createModelsJsonSchema(),
	},
] as const;

function createConfigJsonSchema(): JsonSchemaObject {
	const root: JsonSchemaObject = {
		$schema: DRAFT_2020_12,
		$id: "https://gajae.ai/schemas/config.schema.json",
		title: "GJC config.yml",
		description: "User and project settings for GJC. Generated from packages/coding-agent/src/config/settings-schema.ts.",
		type: "object",
		properties: {},
		additionalProperties: false,
	};

	for (const [settingPath, definition] of Object.entries(SETTINGS_SCHEMA)) {
		addNestedProperty(root, settingPath.split("."), settingDefinitionToJsonSchema(settingPath, definition));
	}

	return root;
}

function createModelsJsonSchema(): JsonSchemaObject {
	return {
		$schema: DRAFT_2020_12,
		$id: "https://gajae.ai/schemas/models.schema.json",
		title: "GJC models.yml",
		description: "Custom provider and model configuration for GJC. Generated from packages/coding-agent/src/config/models-config-schema.ts.",
		...zodToWireSchema(ModelsConfigSchema),
	};
}

function addNestedProperty(root: JsonSchemaObject, segments: string[], schema: JsonSchema): void {
	let current = root;
	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index];
		const properties = ensureProperties(current);
		const existing = properties[segment];
		if (!isJsonSchemaObject(existing) || existing.type !== "object") {
			properties[segment] = {
				type: "object",
				properties: {},
				additionalProperties: false,
			};
		}
		current = properties[segment] as JsonSchemaObject;
	}

	ensureProperties(current)[segments[segments.length - 1]] = schema;
}

function ensureProperties(schema: JsonSchemaObject): Record<string, JsonSchema> {
	if (!schema.properties) schema.properties = {};
	return schema.properties;
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function settingDefinitionToJsonSchema(settingPath: string, definition: SettingDefinition): JsonSchemaObject {
	const schema = settingTypeToJsonSchema(definition);
	const description = settingDescription(definition);
	if (description) schema.description = description;
	if ("default" in definition && definition.default !== undefined) schema.default = definition.default;
	if (settingPath === "gjc.deepInterview.ambiguityThreshold") {
		schema.exclusiveMinimum = 0;
		schema.maximum = 1;
	}
	return schema;
}

function settingTypeToJsonSchema(definition: SettingDefinition): JsonSchemaObject {
	switch (definition.type) {
		case "boolean":
			return { type: "boolean" };
		case "string":
			return { type: "string" };
		case "number":
			return { type: "number" };
		case "enum":
			return { type: "string", enum: definition.values };
		case "array":
			return { type: "array", items: arrayItemsSchema(definition.default, definition.items) };
		case "record":
			return { type: "object", additionalProperties: true };
	}
}

function arrayItemsSchema(defaultValue: unknown, items?: { enum?: readonly string[] }): JsonSchema {
	if (items?.enum) return { type: "string", enum: items.enum };
	if (!Array.isArray(defaultValue) || defaultValue.length === 0) return true;
	if (defaultValue.every(value => typeof value === "string")) return { type: "string" };
	if (defaultValue.every(value => typeof value === "number")) return { type: "number" };
	if (defaultValue.every(value => typeof value === "boolean")) return { type: "boolean" };
	return true;
}

function settingDescription(definition: SettingDefinition): string | undefined {
	if ("ui" in definition && definition.ui && "description" in definition.ui) {
		const description = definition.ui.description;
		if (typeof description === "string") return description;
	}
	if ("description" in definition && typeof definition.description === "string") return definition.description;
	return undefined;
}

export function stableJson(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

async function main(): Promise<void> {
	const check = process.argv.includes("--check");
	const changed: string[] = [];

	for (const output of JSON_SCHEMA_OUTPUTS) {
		const target = path.join(import.meta.dir, "..", output.path);
		const content = stableJson(output.schema);
		if (check) {
			const existing = await Bun.file(target)
				.text()
				.catch(() => null);
			if (existing !== content) changed.push(output.path);
			continue;
		}
		await Bun.write(target, content);
		console.log(`Wrote ${output.path}`);
	}

	if (changed.length > 0) {
		console.error(`Generated JSON Schemas are out of date: ${changed.join(", ")}`);
		console.error("Run `bun run generate-schemas` and commit the updated files.");
		process.exit(1);
	}
}

if (import.meta.main) await main();
