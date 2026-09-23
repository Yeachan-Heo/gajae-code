import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { JSON_SCHEMA_OUTPUTS, stableJson } from "./generate-json-schemas";
import { ProfileModelSelectorPattern } from "../packages/coding-agent/src/config/models-config-schema";
import { SETTINGS_SCHEMA } from "../packages/coding-agent/src/config/settings-schema";

function acceptsJsonSchemaFixture(schema: unknown, value: unknown): boolean {
	if (schema === true) return true;
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const definition = schema as {
		type?: string;
		properties?: Record<string, unknown>;
		additionalProperties?: boolean | unknown;
	};
	if (definition.type === "string") return typeof value === "string";
	if (definition.type === "boolean") return typeof value === "boolean";
	if (definition.type === "number") return typeof value === "number";
	if (definition.type !== "object" || !value || typeof value !== "object" || Array.isArray(value)) return false;
	for (const [key, nestedValue] of Object.entries(value)) {
		const nestedSchema = definition.properties?.[key];
		if (nestedSchema === undefined) {
			if (definition.additionalProperties === false) return false;
			if (definition.additionalProperties !== true && !acceptsJsonSchemaFixture(definition.additionalProperties, nestedValue)) return false;
		} else if (!acceptsJsonSchemaFixture(nestedSchema, nestedValue)) return false;
	}
	return true;
}

function configSchema(): unknown {
	return JSON_SCHEMA_OUTPUTS.find(output => output.path === "schemas/config.schema.json")?.schema;
}

describe("generated JSON Schemas", () => {
	it("matches checked-in schema artifacts", async () => {
		for (const output of JSON_SCHEMA_OUTPUTS) {
			const target = path.join(import.meta.dir, "..", output.path);
			const existing = await Bun.file(target).text();
			expect(existing).toBe(stableJson(output.schema));
		}
	});

	it("registers the ralplan per-lane review budget without loosening the object", () => {
		const setting = SETTINGS_SCHEMA["gjc.ralplan.maxReviewPassesPerLane"];
		expect(setting.default).toBe(1);
		expect(setting.validate?.(0)).toBe(false);
		expect(setting.validate?.(11)).toBe(false);
		expect(setting.validate?.(1.5)).toBe(false);

		const schema = configSchema() as any;
		const ralplan = schema.properties.gjc.properties.ralplan;
		expect(ralplan.properties.maxReviewPassesPerLane).toMatchObject({ type: "integer", default: 1, minimum: 1, maximum: 10 });
		expect(ralplan.additionalProperties).toBe(false);
	});

	it("exposes startup.skipLogoAnimation as a startup boolean on the interaction tab", () => {
		const setting = SETTINGS_SCHEMA["startup.skipLogoAnimation"];
		expect(setting.type).toBe("boolean");
		expect(setting.default).toBe(false);
		// Startup-sweep-only scope is carried by the label and placement: a generic
		// "Reduced Motion" name would imply pet and loader motion also honor it.
		expect(setting.ui?.tab).toBe("interaction");
		expect(setting.ui?.label).toBe("Skip Startup Logo Animation");

		const schema = configSchema() as {
			properties: { startup: { properties: Record<string, unknown> } };
		};
		expect(schema.properties.startup.properties.skipLogoAnimation).toMatchObject({
			type: "boolean",
			default: false,
		});
	});

	it("emits the master orphan grace safe-integer bounds", () => {
		const schema = configSchema() as {
			properties: {
				sdk: {
					properties: { masterOrphanGraceMs: { type: string; default: number; minimum: number; maximum: number } };
				};
			};
		};

		expect(schema.properties.sdk.properties.masterOrphanGraceMs).toMatchObject({
			type: "integer",
			default: 120_000,
			minimum: 60_000,
			maximum: 3_600_000,
		});
	});

	it("accepts documented Discord and Slack config while rejecting unknown chat properties", () => {
		const schema = configSchema();
		const completeConfig = {
			notifications: {
				enabled: true,
				discord: {
					enabled: true,
					botToken: "discord-bot-token",
					applicationId: "discord-application-id",
					guildId: "discord-guild-id",
					parentChannelId: "discord-parent-channel-id",
				},
				slack: {
					enabled: false,
					botToken: "slack-bot-token",
					appToken: "slack-app-token",
					workspaceId: "slack-workspace-id",
					channelId: "slack-channel-id",
				},
			},
		};

		expect(acceptsJsonSchemaFixture(schema, completeConfig)).toBe(true);
		const typedSchema = schema as {
			properties: { notifications: { properties: Record<string, { properties?: Record<string, unknown> }> } };
		};
		const notifications = typedSchema.properties.notifications.properties;
		expect(notifications.telegram?.properties?.enabled).toEqual({ type: "boolean" });
		expect(notifications.discord?.properties?.enabled).toEqual({ type: "boolean" });
		expect(notifications.slack?.properties?.enabled).toEqual({ type: "boolean" });
		expect(acceptsJsonSchemaFixture(schema, {
			...completeConfig,
			notifications: { ...completeConfig.notifications, discord: { ...completeConfig.notifications.discord, unknown: "value" } },
		})).toBe(false);
		expect(acceptsJsonSchemaFixture(schema, {
			...completeConfig,
			notifications: { ...completeConfig.notifications, slack: { ...completeConfig.notifications.slack, unknown: "value" } },
		})).toBe(false);
	});

	it("emits web search fallback item enum and provider webSearch enum", () => {
		const configSchema = JSON_SCHEMA_OUTPUTS.find(output => output.path === "schemas/config.schema.json")?.schema as any;
		const fallbackItems = configSchema.properties.web_search.properties.fallback.items;
		expect(fallbackItems.enum).toContain("exa");
		expect(fallbackItems.enum).not.toContain("openai-compatible");

		const modelsSchema = JSON_SCHEMA_OUTPUTS.find(output => output.path === "schemas/models.schema.json")?.schema as any;
		const providerSchema = modelsSchema.properties.providers.additionalProperties;
		expect(providerSchema.properties.webSearch.enum).toEqual(["on", "off", "auto"]);
	});

	it("emits model selector string-or-chain unions", () => {
		const modelsSchema = JSON_SCHEMA_OUTPUTS.find(output => output.path === "schemas/models.schema.json")?.schema as any;
		const bindingSelector = modelsSchema.properties.modelBindings.properties.modelRoles.additionalProperties;
		const presetSelector = modelsSchema.properties.profiles.additionalProperties.properties.model_mapping.additionalProperties;

		expect(bindingSelector.anyOf.map((branch: any) => branch.type)).toEqual(["string", "array"]);
		expect(bindingSelector.anyOf[1].minItems).toBe(1);
		for (const branch of presetSelector.anyOf) {
			const selector = branch.type === "array" ? branch.items : branch;
			expect(selector.pattern).toBe(new RegExp(ProfileModelSelectorPattern).source);
		}
	});

	it("emits constrained selector records for settings model assignments", () => {
		const configSchema = JSON_SCHEMA_OUTPUTS.find(output => output.path === "schemas/config.schema.json")?.schema as any;
		const selectors = [
			configSchema.properties.modelRoles.additionalProperties,
			configSchema.properties.task.properties.agentModelOverrides.additionalProperties,
		];

		for (const selector of selectors) {
			expect(selector).toEqual({
				anyOf: [
					{ type: "string", minLength: 1, pattern: "\\S" },
					{ type: "array", minItems: 1, items: { type: "string", minLength: 1, pattern: "\\S" } },
				],
			});
		}
	});

	it("bounds task decision timeout and exposes collection consent", () => {
		const configSchema = JSON_SCHEMA_OUTPUTS.find(output => output.path === "schemas/config.schema.json")?.schema as any;
		const decision = configSchema.properties.task.properties.decision.properties;
		expect(decision.timeoutMs).toMatchObject({ type: "integer", minimum: 1, maximum: 60000 });
		expect(decision.collection.enum).toEqual(["off", "metadata", "content"]);
	});
});
