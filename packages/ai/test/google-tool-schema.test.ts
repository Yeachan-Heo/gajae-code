import { describe, expect, it } from "bun:test";
import { convertTools } from "@gajae-code/ai/providers/google-shared";
import type { Model, TJsonSchema, Tool } from "@gajae-code/ai/types";
import { normalizeSchemaForCCA, normalizeSchemaForGoogle } from "@gajae-code/ai/utils/schema";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createTools, type ToolSession } from "@gajae-code/coding-agent/tools";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectsIn(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap(objectsIn);
	if (!isObject(value)) return [];
	return [value, ...Object.values(value).flatMap(objectsIn)];
}

async function askTool() {
	const tool = (
		await createTools(
			{
				cwd: "/tmp/test",
				hasUI: true,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
			} satisfies ToolSession,
			["ask"],
		)
	).find(candidate => candidate.name === "ask");
	if (!tool) throw new Error("Expected AskTool to be registered");
	return tool;
}

function assertLooseAskSchema(parameters: unknown): void {
	const question = objectsIn(parameters).find(candidate => {
		const properties = candidate.properties;
		return (
			isObject(properties) &&
			["id", "question", "options", "deepInterview", "workflowGate"].every(name => Object.hasOwn(properties, name))
		);
	});
	if (!question) throw new Error("Google payload omitted AskTool question schema");
	expect(question.required).toEqual(["id", "question", "options"]);
}

function createModel(id: string): Model<"google-gemini-cli"> {
	return {
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

describe("Cloud Code Assist Claude tool schema conversion", () => {
	it("strips nullable keyword and collapses type arrays for CCA Claude", () => {
		const schema = {
			type: "object",
			properties: {
				value: {
					type: ["string", "null"],
					nullable: true,
				},
			},
		} as unknown;

		// normalizeTypeArrayToNullable converts type array to scalar + nullable,
		// then stripNullableKeyword removes the nullable marker.
		expect(normalizeSchemaForCCA(schema)).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
				},
			},
		});
	});

	it("strips propertyNames before sending legacy CCA parameters", () => {
		const schema = {
			type: "object",
			properties: {
				env: {
					type: "object",
					propertyNames: { type: "string", pattern: "^[A-Z_]+$" },
					additionalProperties: { type: "string" },
				},
			},
		} as unknown;

		expect(normalizeSchemaForCCA(schema)).toEqual({
			type: "object",
			properties: {
				env: {
					type: "object",
					properties: {},
				},
			},
		});
	});

	it("keeps the non-strict AskTool question metadata optional in Gemini declarations", async () => {
		const tool = await askTool();
		if (tool.strict !== false) throw new Error("Expected AskTool to opt out of strict schemas");
		const gemini = convertTools([tool], createModel("gemini-2.5-pro"))?.[0]?.functionDeclarations[0];
		if (!gemini) throw new Error("Google conversion omitted AskTool");

		assertLooseAskSchema(gemini.parametersJsonSchema);
	});

	it("fails closed to the documented empty schema when CCA cannot represent AskTool unions", async () => {
		const tool = await askTool();
		const claude = convertTools([tool], createModel("claude-sonnet-4-5"))?.[0]?.functionDeclarations[0];
		if (!claude) throw new Error("Cloud Code Assist conversion omitted AskTool");

		expect(claude.parameters).toEqual({ type: "object", properties: {} });
		expect(claude.parametersJsonSchema).toBeUndefined();
	});

	it("uses sanitized parameters for claude models with deterministic output", () => {
		const parameters = {
			type: "object",
			properties: {
				value: {
					type: ["string", "null"],
					nullable: true,
				},
			},
			required: ["value"],
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "test_tool", description: "Test tool", parameters }];
		const model = createModel("claude-sonnet-4-5");

		const first = convertTools(tools, model);
		const second = convertTools(tools, model);
		const declaration = first?.[0]?.functionDeclarations[0] as Record<string, unknown>;

		expect(first).toEqual(second);
		expect(declaration.parameters).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
				},
			},
			required: ["value"],
		});
		expect(declaration.parametersJsonSchema).toBeUndefined();
	});

	it("collapses mixed-type anyOf to first non-null type for claude parameters", () => {
		const parameters = {
			type: "object",
			properties: {
				lines: {
					anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }, { type: "null" }],
				},
			},
			required: ["lines"],
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "test_tool", description: "Test tool", parameters }];
		const claudeModel = createModel("claude-sonnet-4-5");
		const geminiModel = createModel("gemini-2.5-pro");

		const claudeFirst = convertTools(tools, claudeModel);
		const claudeSecond = convertTools(tools, claudeModel);
		const claudeDeclaration = claudeFirst?.[0]?.functionDeclarations[0] as Record<string, unknown>;
		const geminiDeclaration = convertTools(tools, geminiModel)?.[0]?.functionDeclarations[0] as Record<
			string,
			unknown
		>;

		expect(claudeFirst).toEqual(claudeSecond);
		// Lossy collapse: array|string|null narrows to array (first non-null type)
		expect(claudeDeclaration.parameters).toEqual({
			type: "object",
			properties: {
				lines: {
					type: "array",
					items: { type: "string" },
				},
			},
			required: ["lines"],
		});
		expect(JSON.stringify(claudeDeclaration.parameters)).not.toContain('"anyOf"');
		expect(JSON.stringify(claudeDeclaration.parameters)).not.toContain('"oneOf"');
		expect(claudeDeclaration.parametersJsonSchema).toBeUndefined();
		expect(
			(geminiDeclaration.parametersJsonSchema as { properties?: Record<string, unknown> })?.properties?.lines,
		).toEqual((parameters as { properties: { lines: unknown } }).properties.lines);
	});

	it("collapses mixed anyOf with shared metadata for edit-style lines fields", () => {
		const parameters = {
			type: "object",
			properties: {
				edits: {
					type: "array",
					items: {
						type: "object",
						properties: {
							lines: {
								anyOf: [
									{
										type: "array",
										description: "content (preferred format)",
										items: { type: "string" },
									},
									{ type: "string" },
									{ type: "null" },
								],
							},
						},
					},
				},
			},
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "edit", description: "Edit tool", parameters }];
		const model = createModel("claude-sonnet-4-5");

		const declaration = convertTools(tools, model)?.[0]?.functionDeclarations[0] as Record<string, unknown>;
		const linesSchema = ((
			(declaration.parameters as { properties?: Record<string, unknown> })?.properties?.edits as {
				items?: { properties?: Record<string, unknown> };
			}
		)?.items?.properties?.lines ?? null) as Record<string, unknown> | null;

		// Lossy collapse: array|string|null narrows to array (first non-null type)
		expect(linesSchema).toEqual({
			type: "array",
			description: "content (preferred format)",
			items: { type: "string" },
		});
		expect(JSON.stringify(declaration.parameters)).not.toContain('"anyOf"');
	});
	it("collapses mixed unions for todo_write-style nullable content fields", () => {
		const parameters = {
			type: "object",
			properties: {
				ops: {
					type: "array",
					items: {
						type: "object",
						properties: {
							content: {
								anyOf: [{ type: "string", description: "Updated task description" }, { type: "null" }],
							},
						},
					},
				},
			},
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "todo_write", description: "Todo tool", parameters }];
		const model = createModel("claude-sonnet-4-5");

		const declaration = convertTools(tools, model)?.[0]?.functionDeclarations[0] as Record<string, unknown>;
		const contentSchema = ((
			(declaration.parameters as { properties?: Record<string, unknown> })?.properties?.ops as {
				items?: { properties?: Record<string, unknown> };
			}
		)?.items?.properties?.content ?? null) as Record<string, unknown> | null;

		// string|null collapses cleanly to string (single non-null type)
		expect(contentSchema).toEqual({
			type: "string",
			description: "Updated task description",
		});
		expect(JSON.stringify(declaration.parameters)).not.toContain('"anyOf"');
	});
	it("preserves nullable unions as optional properties instead of full fallback", () => {
		const parameters = {
			type: "object",
			properties: {
				value: {
					anyOf: [{ enum: ["A", "B"] }, { type: "null" }],
				},
			},
			required: ["value"],
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "test_tool", description: "Test tool", parameters }];
		const claudeModel = createModel("claude-sonnet-4-5");
		const geminiModel = createModel("gemini-2.5-pro");

		const claudeDeclaration = convertTools(tools, claudeModel)?.[0]?.functionDeclarations[0] as Record<
			string,
			unknown
		>;
		const geminiDeclaration = convertTools(tools, geminiModel)?.[0]?.functionDeclarations[0] as Record<
			string,
			unknown
		>;

		expect(claudeDeclaration.parameters).toEqual({
			type: "object",
			properties: {
				value: { enum: ["A", "B"] },
			},
			required: [],
		});
		expect(JSON.stringify(claudeDeclaration.parameters)).not.toContain('"anyOf"');
		expect(
			(geminiDeclaration.parametersJsonSchema as { properties?: Record<string, unknown> })?.properties?.value,
		).toEqual((parameters as { properties: { value: unknown } }).properties.value);
	});

	it("falls back to minimal object schema when non-null unresolved unions remain for CCA Claude", () => {
		const parameters = {
			type: "object",
			properties: {
				value: {
					anyOf: [{ enum: ["A", "B"] }, { enum: ["C", "D"] }],
				},
			},
			required: ["value"],
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "test_tool", description: "Test tool", parameters }];
		const claudeModel = createModel("claude-sonnet-4-5");

		const claudeDeclaration = convertTools(tools, claudeModel)?.[0]?.functionDeclarations[0] as Record<
			string,
			unknown
		>;

		expect(claudeDeclaration.parameters).toEqual({
			type: "object",
			properties: {},
		});
	});

	it("falls back when CCA schema meta-validation catches malformed keywords", () => {
		const parameters = {
			type: "object",
			properties: {
				mode: { type: "string", enum: ["read", "read"] },
				tags: { type: "array", items: { type: "string" }, uniqueItems: "true" },
			},
			required: ["mode"],
		} as unknown;

		expect(normalizeSchemaForCCA(parameters)).toEqual({
			type: "object",
			properties: {},
		});
	});
	it("keeps google sanitizer behavior for non-claude schema path", () => {
		const schema = {
			type: "object",
			properties: {
				value: {
					type: ["string", "null"],
				},
			},
		} as unknown;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
					nullable: true,
				},
			},
		});
	});
});

/**
 * Tests ported from python-genai's `process_schema`/`handle_null_fields`
 * coverage in google/genai/tests/transformers/test_schema.py. The Python
 * suite is the canonical regression set for the rules our `normalizeSchemaForGoogle`
 * mirrors (snake_case field renames, null-field collapsing, const→enum,
 * propertyOrdering propagation, $ref cycle handling).
 */
describe("normalizeSchemaForGoogle parity with python-genai process_schema", () => {
	// Mirrors python-genai test_schema.py::test_schema_with_no_null_fields_is_unchanged
	it("leaves anyOf alone when no variant has type null", () => {
		const schema = {
			anyOf: [{ type: "integer" }, { type: "number" }],
			default: "null",
			title: "Total Area Sq Mi",
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			anyOf: [{ type: "integer" }, { type: "number" }],
			default: "null",
			title: "Total Area Sq Mi",
		});
	});

	// Mirrors python-genai test_schema.py::test_t_schema_for_null_fields
	it("collapses {type:'null'} variant in anyOf into nullable + sole remaining variant", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string" },
				population: {
					anyOf: [{ type: "integer" }, { type: "null" }],
					default: null,
					title: "Population",
				},
			},
			required: ["name"],
		} as const;

		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		const props = sanitized.properties as Record<string, Record<string, unknown>>;
		expect(props.population?.nullable).toBe(true);
		expect(props.population?.type).toBe("integer");
		expect(props.population?.anyOf).toBeUndefined();
	});

	// Mirrors python-genai test_schema.py::test_schema_with_any_of
	it("preserves multi-variant anyOf without any null variant", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string", title: "Name" },
				restaurants_per_capita: {
					any_of: [{ type: "integer" }, { type: "number" }],
					title: "Restaurants Per Capita",
				},
			},
			required: ["name", "restaurants_per_capita"],
		} as const;

		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		const props = sanitized.properties as Record<string, Record<string, unknown>>;
		// snake_case any_of must be rewritten to camelCase anyOf.
		expect(props.restaurants_per_capita?.anyOf).toEqual([{ type: "integer" }, { type: "number" }]);
		expect(props.restaurants_per_capita?.any_of).toBeUndefined();
	});

	// Mirrors python-genai test_schema.py::test_complex_dict_schema_with_anyof_is_unchanged
	it("leaves already-camelCased complex schemas unchanged apart from auto propertyOrdering", () => {
		const dictSchema = {
			type: "object",
			title: "Fruit Basket",
			description: "A structured representation of a fruit basket",
			required: ["fruit"],
			properties: {
				fruit: {
					type: "array",
					description: "An ordered list of the fruit in the basket",
					items: {
						description: "A piece of fruit",
						anyOf: [
							{
								title: "Apple",
								description: "Describes an apple",
								type: "object",
								properties: {
									type: { type: "string", description: "Always 'apple'" },
									color: { type: "string", description: "The color of the apple" },
								},
								propertyOrdering: ["type", "color"],
								required: ["type", "color"],
							},
							{
								title: "Orange",
								description: "Describes an orange",
								type: "object",
								properties: {
									type: { type: "string", description: "Always 'orange'" },
									size: { type: "string", description: "The size of the orange" },
								},
								propertyOrdering: ["type", "size"],
								required: ["type", "size"],
							},
						],
					},
				},
			},
		} as const;

		// fruit alone is the only top-level property; auto-ordering does not fire.
		expect(normalizeSchemaForGoogle(dictSchema)).toEqual(dictSchema);
	});

	// Mirrors python-genai test_schema.py::test_process_schema_converts_const_to_enum
	it("converts const to a singleton enum", () => {
		const sanitized = normalizeSchemaForGoogle({ type: "string", const: "FOO" });
		expect(sanitized).toEqual({ type: "string", enum: ["FOO"] });
	});

	// Mirrors python-genai test_schema.py::test_process_schema_forbids_non_string_const
	// We deviate intentionally: rather than raise on non-string const we accept
	// the value as a singleton enum. Google's Schema proto accepts numeric enums
	// and we prefer permissive normalization over surfacing a transformer-level error.
	it("accepts non-string const as a singleton enum (intentional deviation from upstream raise)", () => {
		const sanitized = normalizeSchemaForGoogle({ type: "integer", const: 123 }) as Record<string, unknown>;
		expect(sanitized.enum).toEqual([123]);
		expect(sanitized.type).toBe("integer");
	});

	// Mirrors python-genai test_schema.py::test_process_schema_order_properties_propagates_into_defs
	it("propagates auto propertyOrdering into inlined $defs targets", () => {
		const schema = {
			$ref: "#/$defs/Foo",
			$defs: {
				Foo: {
					type: "object",
					properties: {
						foo: { type: "string" },
						bar: { type: "string" },
					},
				},
			},
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				foo: { type: "string" },
				bar: { type: "string" },
			},
			propertyOrdering: ["foo", "bar"],
		});
	});

	// Mirrors python-genai test_schema.py::test_process_schema_order_properties_propagates_into_items
	it("propagates auto propertyOrdering into array items", () => {
		const schema = {
			type: "array",
			items: {
				type: "object",
				properties: {
					foo: { type: "string" },
					bar: { type: "string" },
				},
			},
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "array",
			items: {
				type: "object",
				properties: {
					foo: { type: "string" },
					bar: { type: "string" },
				},
				propertyOrdering: ["foo", "bar"],
			},
		});
	});

	// Mirrors python-genai test_schema.py::test_process_schema_order_properties_propagates_into_properties
	it("propagates auto propertyOrdering into nested properties", () => {
		const schema = {
			type: "object",
			properties: {
				xyz: {
					type: "object",
					properties: {
						foo: { type: "string" },
						bar: { type: "string" },
					},
				},
				abc: { type: "string" },
			},
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				xyz: {
					type: "object",
					properties: {
						foo: { type: "string" },
						bar: { type: "string" },
					},
					propertyOrdering: ["foo", "bar"],
				},
				abc: { type: "string" },
			},
			propertyOrdering: ["xyz", "abc"],
		});
	});

	// Mirrors python-genai test_schema.py::test_process_schema_order_properties_propagates_into_any_of
	it("propagates auto propertyOrdering into anyOf variants", () => {
		const schema = {
			anyOf: [
				{
					type: "object",
					properties: {
						foo: { type: "string" },
						bar: { type: "string" },
					},
				},
				{ type: "string" },
			],
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			anyOf: [
				{
					type: "object",
					properties: {
						foo: { type: "string" },
						bar: { type: "string" },
					},
					propertyOrdering: ["foo", "bar"],
				},
				{ type: "string" },
			],
		});
	});

	// Mirrors python-genai test_schema.py::test_process_schema_with_cycle
	it("breaks $ref cycles by emitting an empty schema at the recursion point", () => {
		const schema = {
			type: "object",
			properties: {
				recursive: { $ref: "#/$defs/RecursiveObject" },
			},
			$defs: {
				RecursiveObject: {
					type: "object",
					properties: {
						self: { $ref: "#/$defs/RecursiveObject" },
					},
				},
			},
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				recursive: {
					type: "object",
					properties: { self: {} },
				},
			},
		});
	});

	// Mirrors python-genai test_schema.py::test_t_schema_does_not_change_property_ordering_if_set
	it("does not overwrite an existing propertyOrdering", () => {
		const custom = ["code", "symbol", "name"];
		const schema = {
			type: "object",
			properties: {
				name: { type: "string" },
				code: { type: "string" },
				symbol: { type: "string" },
			},
			propertyOrdering: [...custom],
		} as const;

		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		expect(sanitized.propertyOrdering).toEqual(custom);
	});

	// Mirrors python-genai test_schema.py::test_t_schema_sets_property_ordering_for_json_schema
	it("populates propertyOrdering from properties insertion order when missing", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string" },
				population: { type: "integer" },
				capital: { type: "string" },
				continent: { type: "string" },
				gdp: { type: "integer" },
				official_language: { type: "string" },
				total_area_sq_mi: { type: "integer" },
			},
		} as const;

		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		expect(sanitized.propertyOrdering).toEqual([
			"name",
			"population",
			"capital",
			"continent",
			"gdp",
			"official_language",
			"total_area_sq_mi",
		]);
	});

	// Covers python-genai _transformers.py:745-752 snake_case → camelCase renames.
	it("normalizes snake_case schema field names to camelCase", () => {
		const schema = {
			type: "object",
			properties: {
				foo: { type: "string" },
				bar: { type: "string" },
			},
			property_ordering: ["bar", "foo"],
		} as const;

		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		expect(sanitized.propertyOrdering).toEqual(["bar", "foo"]);
		expect(sanitized.property_ordering).toBeUndefined();
	});

	// Covers python-genai _transformers.py:751 snake-wins-over-camel collision behavior.
	it("lets snake_case overwrite an existing camelCase entry on collision", () => {
		const schema = {
			anyOf: [{ type: "string" }],
			any_of: [{ type: "integer" }, { type: "number" }],
		} as const;

		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		expect(sanitized.anyOf).toEqual([{ type: "integer" }, { type: "number" }]);
		expect(sanitized.any_of).toBeUndefined();
	});

	// Covers python-genai _transformers.py:628-630 bare {type:'null'} flatten.
	it("rewrites a bare {type:'null'} schema as {nullable:true}", () => {
		expect(normalizeSchemaForGoogle({ type: "null" })).toEqual({ nullable: true });
	});

	// Covers python-genai _transformers.py:631-640 single-non-null anyOf flatten.
	it("flattens anyOf:[X, {type:'null'}] into X + nullable", () => {
		expect(
			normalizeSchemaForGoogle({
				anyOf: [{ type: "string", title: "Name" }, { type: "null" }],
			}),
		).toEqual({ type: "string", title: "Name", nullable: true });
	});
});
