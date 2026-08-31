import { describe, expect, it } from "bun:test";
import { buildRequest } from "@gajae-code/ai/providers/google-gemini-cli";
import { convertTools } from "@gajae-code/ai/providers/google-shared";
import type { Context, Model, TJsonSchema, Tool } from "@gajae-code/ai/types";
import {
	enforceStrictSchema,
	isValidJsonSchema,
	mergeCompatibleEnumSchemas,
	normalizeSchemaForCCA,
	normalizeSchemaForGoogle,
	normalizeSchemaForMCP,
	sanitizeSchemaForOpenAIResponses,
	sanitizeSchemaForStrictMode,
	schemaNeedsDraft202012Upgrade,
	stripResidualCombiners,
	tryEnforceStrictSchema,
	upgradeJsonSchemaTo202012,
} from "@gajae-code/ai/utils/schema";

function createGoogleCliModel(id: string): Model<"google-gemini-cli"> {
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

// ---------------------------------------------------------------------------
// mergeCompatibleEnumSchemas
// ---------------------------------------------------------------------------

describe("mergeCompatibleEnumSchemas", () => {
	it("deduplicates object-valued enum members by deep equality", () => {
		const existing = { type: "object", enum: [{ x: 1 }] };
		const incoming = { type: "object", enum: [{ x: 1 }] };

		expect(mergeCompatibleEnumSchemas(existing, incoming)).toEqual({
			type: "object",
			enum: [{ x: 1 }],
		});
	});

	it("deduplicates structurally equal nested enum values and appends novel ones", () => {
		const existing = {
			type: "object",
			enum: [{ kind: "A", payload: { level: 1 } }],
		};
		const incoming = {
			type: "object",
			enum: [
				{ kind: "A", payload: { level: 1 } },
				{ kind: "B", payload: { level: 2 } },
			],
		};

		const merged = mergeCompatibleEnumSchemas(existing, incoming);

		expect(merged).toEqual({
			type: "object",
			enum: [
				{ kind: "A", payload: { level: 1 } },
				{ kind: "B", payload: { level: 2 } },
			],
		});
	});
});

// ---------------------------------------------------------------------------
// sanitizeSchemaForStrictMode
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForStrictMode", () => {
	it("converts nullable keyword to explicit null union", () => {
		const sanitized = sanitizeSchemaForStrictMode({
			type: "string",
			nullable: true,
		});

		expect(sanitized).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
		});
	});

	it("hoists description to the wrapper when wrapping `nullable: true` as an anyOf", () => {
		// Sanitize-side nullable wrap mirrors the optional-property wrap shape
		// produced by `enforceStrictSchema`: description lives on the wrapper,
		// branches stay bare. Both top-level entry points share this contract
		// so downstream consumers don't have to special-case which path produced
		// the nullable union.
		const sanitized = sanitizeSchemaForStrictMode({
			type: "string",
			nullable: true,
			description: "label",
		});

		expect(sanitized).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
			description: "label",
		});
	});

	it("strips not branches", () => {
		const schema = {
			type: "object",
			not: {
				type: "object",
				properties: { token: { const: "secret" } },
				required: ["token"],
			},
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.not).toBeUndefined();
	});

	it("merges const into existing enum instead of overwriting", () => {
		const schema = {
			type: "string",
			enum: ["A", "B"],
			const: "C",
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.enum).toEqual(["A", "B", "C"]);
	});
});

// ---------------------------------------------------------------------------
// upgradeJsonSchemaTo202012
// ---------------------------------------------------------------------------

describe("upgradeJsonSchemaTo202012", () => {
	it("infers draft-07 tuple and dependency keywords without a $schema URI", () => {
		const schema = {
			type: "object",
			properties: {
				definitions: { type: "string" },
				tuple: {
					type: "array",
					items: [{ type: "string" }, { type: "integer" }],
					additionalItems: false,
				},
				gated: {
					type: "object",
					dependencies: {
						a: ["b"],
						c: { required: ["d"] },
					},
				},
			},
			definitions: {
				Ref: { type: "string" },
			},
		};

		expect(schemaNeedsDraft202012Upgrade(schema)).toBe(true);
		expect(upgradeJsonSchemaTo202012(schema)).toEqual({
			type: "object",
			properties: {
				definitions: { type: "string" },
				tuple: {
					type: "array",
					prefixItems: [{ type: "string" }, { type: "integer" }],
					items: false,
				},
				gated: {
					type: "object",
					dependentRequired: { a: ["b"] },
					dependentSchemas: { c: { required: ["d"] } },
				},
			},
			$defs: {
				Ref: { type: "string" },
			},
		});
	});

	it("returns unchanged schemas by identity when no draft upgrade is needed", () => {
		const schema = { type: "object", properties: { name: { type: "string" } } };

		expect(schemaNeedsDraft202012Upgrade(schema)).toBe(false);
		expect(upgradeJsonSchemaTo202012(schema)).toBe(schema);
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForGoogle
// ---------------------------------------------------------------------------

describe("normalizeSchemaForGoogle", () => {
	it("sets object type when converting an object const to an enum entry", () => {
		const sanitized = normalizeSchemaForGoogle({
			const: { a: 1 },
		});

		expect(sanitized).toEqual({
			type: "object",
			properties: {},
			enum: [{ a: 1 }],
		});
	});

	it("deduplicates a deep-equal object const against an existing enum entry", () => {
		const sanitized = normalizeSchemaForGoogle({
			type: "object",
			enum: [{ a: 1 }],
			const: { a: 1 },
		});

		expect(sanitized).toEqual({
			type: "object",
			properties: {},
			enum: [{ a: 1 }],
		});
	});

	it("does not stamp a wrong scalar type when const variants span multiple primitive types", () => {
		const sanitized = normalizeSchemaForGoogle({
			anyOf: [
				{ const: "A", type: "string" },
				{ const: 1, type: "number" },
				{ const: true, type: "boolean" },
			],
		}) as Record<string, unknown>;

		expect(sanitized.enum).toEqual(["A", 1, true]);
		expect(sanitized.type).toBeUndefined();
	});

	it("collapses inferred null type to nullable when const is null", () => {
		// After python-genai parity (handle_null_fields), bare `type: 'null'` is
		// folded into `nullable: true` so the schema is OpenAPI-compatible.
		const sanitized = normalizeSchemaForGoogle({ const: null }) as Record<string, unknown>;

		expect(sanitized.type).toBeUndefined();
		expect(sanitized.nullable).toBe(true);
		expect(sanitized.enum).toEqual([null]);
	});

	it("preserves a property schema literally named additionalProperties inside properties", () => {
		const sanitized = normalizeSchemaForGoogle({
			type: "object",
			properties: {
				additionalProperties: false,
				name: { type: "string" },
			},
		}) as Record<string, unknown>;

		const properties = sanitized.properties as Record<string, unknown>;
		expect(Object.hasOwn(properties, "additionalProperties")).toBe(true);
		expect(properties.additionalProperties).toBe(false);
	});

	it("preserves boolean schemas for a single property literally named additionalProperties", () => {
		const schema = {
			type: "object",
			properties: {
				additionalProperties: false,
			},
			required: ["additionalProperties"],
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual(schema);
	});

	it("inlines local $ref / $defs entries for Google compatibility", () => {
		// Mirrors python-genai/_transformers.py:754-774 ($defs inlining via
		// `process_schema`) and tests/transformers/test_schema.py::
		// test_process_schema_order_properties_propagates_into_defs.
		const schema = {
			type: "object",
			properties: {
				user: { $ref: "#/$defs/User" },
			},
			required: ["user"],
			$defs: {
				User: {
					type: "object",
					properties: {
						id: { type: "string" },
					},
					required: ["id"],
				},
			},
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				user: {
					type: "object",
					properties: {
						id: { type: "string" },
					},
					required: ["id"],
				},
			},
			required: ["user"],
		});
	});

	it("lifts stripped validation keywords into description", () => {
		const normalized = normalizeSchemaForGoogle({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			maxLength: 8,
			description: "ID",
		}) as Record<string, unknown>;

		expect(normalized.pattern).toBeUndefined();
		expect(normalized.minLength).toBeUndefined();
		expect(normalized.maxLength).toBeUndefined();
		expect(normalized.description).toBe('ID\n\n{pattern: "^\\\\d+$", minLength: 1, maxLength: 8}');
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForMCP
// ---------------------------------------------------------------------------

describe("normalizeSchemaForMCP", () => {
	it("keeps validation keywords without mutating description", () => {
		const normalized = normalizeSchemaForMCP({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			description: "ID",
		}) as Record<string, unknown>;

		expect(normalized).toEqual({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			description: "ID",
		});
	});

	it("makes implicit propertyless MCP argument maps explicitly open without loosening declared objects", () => {
		const schema = {
			type: "object",
			properties: {
				action: { type: "string" },
				args: { type: "object", description: "Dispatcher arguments" },
				explicitlyClosed: { type: "object", additionalProperties: false },
				declared: { type: "object", properties: { path: { type: "string" } } },
				literalCarrier: { type: "string", default: { type: "object" } },
			},
		};
		const before = structuredClone(schema);

		expect(normalizeSchemaForMCP(schema)).toEqual({
			type: "object",
			properties: {
				action: { type: "string" },
				args: { type: "object", description: "Dispatcher arguments", additionalProperties: true },
				explicitlyClosed: { type: "object", additionalProperties: false },
				declared: { type: "object", properties: { path: { type: "string" } } },
				literalCarrier: { type: "string", default: { type: "object" } },
			},
		});
		expect(schema).toEqual(before);
	});

	// Regression: issue #1101. Some MCP servers ship `JSON.stringify(zodSchema)`
	// directly as a tool's `inputSchema`. Zod 4 surfaces `.type`, `.enum`,
	// `.options`, and `.def` on every schema instance — those keys collide with
	// JSON Schema keywords, producing payloads that fail Anthropic's strict
	// JSON Schema 2020-12 validator (`"type":"enum"`, `"enum":{...}` as object).
	// `normalizeSchemaForMCP` must rewrite the offending nodes into clean JSON
	// Schema so the tool list still ships.
	it("rewrites a Zod-enum instance leaked as inputSchema", () => {
		const leaked = {
			def: { type: "enum", entries: { upstream: "upstream", downstream: "downstream" } },
			type: "enum",
			enum: { upstream: "upstream", downstream: "downstream" },
			options: ["upstream", "downstream"],
		};
		expect(normalizeSchemaForMCP(leaked)).toEqual({
			type: "string",
			enum: ["upstream", "downstream"],
		});
	});

	it("rewrites a numeric Zod-enum (integer values keep integer type)", () => {
		const leaked = {
			def: { type: "enum", entries: { ONE: 1, TWO: 2 } },
			type: "enum",
			enum: { ONE: 1, TWO: 2 },
			options: [1, 2],
		};
		expect(normalizeSchemaForMCP(leaked)).toEqual({
			type: "integer",
			enum: [1, 2],
		});
	});

	it("rewrites a Zod-literal instance to a single-element enum", () => {
		const leaked = {
			def: { type: "literal", values: ["only"] },
			type: "literal",
			values: ["only"],
		};
		// Decontamination emits `{const:"only"}`; downstream normalizer collapses
		// it to the equivalent enum form. End-to-end contract is what callers see.
		expect(normalizeSchemaForMCP(leaked)).toEqual({ type: "string", enum: ["only"] });
	});

	it("rewrites a Zod-union of literals (downstream collapses anyOf-of-consts to enum)", () => {
		const leaked = {
			def: {
				type: "union",
				options: [
					{ def: { type: "literal", values: ["on"] }, type: "literal", values: ["on"] },
					{ def: { type: "literal", values: ["off"] }, type: "literal", values: ["off"] },
				],
			},
			type: "union",
		};
		expect(normalizeSchemaForMCP(leaked)).toEqual({
			type: "string",
			enum: ["on", "off"],
		});
	});

	it("strips null-valued JSON Schema keywords that Zod scalars leak (format: null, minLength: null)", () => {
		const leaked = {
			def: { type: "string", checks: [] },
			type: "string",
			format: null,
			minLength: null,
			maxLength: null,
		};
		expect(normalizeSchemaForMCP(leaked)).toEqual({ type: "string" });
	});

	it("drops invalid `type` for unmodelled Zod kinds so the residue stays valid", () => {
		const leaked = {
			def: { type: "any" },
			type: "any",
			description: "anything",
		};
		expect(normalizeSchemaForMCP(leaked)).toEqual({ description: "anything" });
	});

	it("leaves a genuine JSON Schema that happens to have a `def` property alone", () => {
		// `def` is not a JSON Schema keyword but it's also not reserved. The
		// detoxifier must only fire when `def.type` is a known Zod kind AND
		// `node.type === def.type`, otherwise it would corrupt real schemas.
		const schema = {
			type: "object",
			properties: { def: { type: "string" } },
			required: ["def"],
		};
		expect(normalizeSchemaForMCP(schema)).toEqual(schema);
	});

	// A tool schema arriving over the MCP wire is `JSON.parse`d, so `__proto__` is
	// an ordinary own data property. Copying it with `out[key] = value` would hit
	// `Object.prototype`'s `__proto__` setter and silently drop the property name.
	it("preserves parsed `__proto__`, `constructor`, and `prototype` property names as own data", () => {
		const parsed = JSON.parse(
			'{"type":"object","properties":{"__proto__":{"type":"object","description":"open map"},"constructor":{"type":"string"},"prototype":{"type":"string"}},"required":["__proto__"]}',
		);
		const normalized = normalizeSchemaForMCP(parsed) as Record<string, Record<string, unknown>>;

		expect(Object.keys(normalized.properties)).toEqual(["__proto__", "constructor", "prototype"]);
		expect(Object.getOwnPropertyDescriptor(normalized.properties, "__proto__")?.value).toEqual({
			type: "object",
			description: "open map",
			additionalProperties: true,
		});
		expect(Object.getPrototypeOf(normalized.properties)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).description).toBeUndefined();
	});

	// `default`, `const`, `enum`, and `examples` carry instance data, not
	// subschemas. The generic pre-walk used to recurse into them and rewrite user
	// payloads as schemas; every value below changes visibly if that regresses.
	it("copies literal payloads verbatim instead of normalizing them as schemas", () => {
		const schema = {
			type: "string",
			$defs: { RootDefinition: { type: "number" } },
			default: {
				type: "object",
				nullable: true,
				format: null,
				$ref: "#/$defs/Literal",
				$defs: { Literal: { type: "string" } },
				nestedZodLookingData: {
					def: { type: "enum", entries: { literal: "literal" } },
					type: "enum",
					enum: { literal: "literal" },
					options: ["literal"],
				},
			},
			examples: [{ anyOf: [{ const: "a" }, { const: "b" }] }],
		};
		const before = structuredClone(schema);

		expect(normalizeSchemaForMCP(schema)).toEqual({
			type: "string",
			default: {
				type: "object",
				nullable: true,
				format: null,
				$ref: "#/$defs/Literal",
				$defs: { Literal: { type: "string" } },
				nestedZodLookingData: {
					def: { type: "enum", entries: { literal: "literal" } },
					type: "enum",
					enum: { literal: "literal" },
					options: ["literal"],
				},
			},
			examples: [{ anyOf: [{ const: "a" }, { const: "b" }] }],
		});
		expect(schema).toEqual(before);
	});

	it("does not alias literal payloads back to the caller's input", () => {
		const defaultValue = { nested: { keep: true } };
		const schema = { type: "object", properties: {}, default: defaultValue };
		const normalized = normalizeSchemaForMCP(schema) as { default: typeof defaultValue };

		expect(normalized.default).toEqual(defaultValue);
		expect(normalized.default).not.toBe(defaultValue);
		expect(normalized.default.nested).not.toBe(defaultValue.nested);
	});

	it("treats every properties key as data, including schema-key names and prototype keys", () => {
		const parsed = JSON.parse(
			'{"type":"object","properties":{"type":{"type":"object"},"default":{"type":"object"},"const":{"type":"object"},"enum":{"type":"object"},"examples":{"type":"object"},"__proto__":{"type":"object"},"constructor":{"type":"object"},"prototype":{"type":"object"}},"required":["type","default","const","enum","examples","__proto__","constructor","prototype"]}',
		) as Record<string, unknown>;

		const normalized = normalizeSchemaForMCP(parsed) as Record<string, unknown>;
		const properties = normalized.properties as Record<string, unknown>;
		const propertyNames = ["type", "default", "const", "enum", "examples", "__proto__", "constructor", "prototype"];

		expect(Object.keys(properties)).toEqual(propertyNames);
		for (const propertyName of propertyNames) {
			expect(properties[propertyName]).toEqual({ type: "object", additionalProperties: true });
		}
		expect(Object.getOwnPropertyDescriptor(properties, "__proto__")?.value).toEqual({
			type: "object",
			additionalProperties: true,
		});
		expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).additionalProperties).toBeUndefined();
		expect(isValidJsonSchema(normalized)).toBe(true);
	});

	it("keeps a root prototype-colliding extension out of draft dispatch and Object.prototype", () => {
		const parsed = JSON.parse(
			'{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","__proto__":{"marker":"data"}}',
		) as Record<string, unknown>;

		const normalized = normalizeSchemaForMCP(parsed) as Record<string, unknown>;

		expect(Object.hasOwn(normalized, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(normalized, "__proto__")?.value).toEqual({ marker: "data" });
		expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).marker).toBeUndefined();
		expect(isValidJsonSchema(normalized)).toBe(true);
	});

	it("keeps null-prototype and defineProperty-created maps safe during MCP copying", () => {
		const properties = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(properties, "__proto__", {
			value: Object.assign(Object.create(null), { type: "object" }),
			configurable: true,
			enumerable: true,
			writable: true,
		});
		Object.defineProperty(properties, "constructor", {
			value: { type: "string" },
			configurable: true,
			enumerable: true,
			writable: true,
		});
		const schema = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(schema, "type", { value: "object", configurable: true, enumerable: true, writable: true });
		Object.defineProperty(schema, "properties", {
			value: properties,
			configurable: true,
			enumerable: true,
			writable: true,
		});

		const normalized = normalizeSchemaForMCP(schema) as Record<string, unknown>;
		const normalizedProperties = normalized.properties as Record<string, unknown>;

		expect(Object.hasOwn(normalizedProperties, "__proto__")).toBe(true);
		expect(Object.hasOwn(normalizedProperties, "constructor")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(normalizedProperties, "__proto__")?.value).toEqual({
			type: "object",
			additionalProperties: true,
		});
		expect(Object.getOwnPropertyDescriptor(normalizedProperties, "__proto__")?.enumerable).toBe(true);
		expect(Object.getPrototypeOf(normalizedProperties)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).additionalProperties).toBeUndefined();
		expect(isValidJsonSchema(normalized)).toBe(true);
	});

	it("preserves dangerous keys when draft upgrade and definition dereferencing allocate copies", () => {
		const parsed = JSON.parse(
			'{"$schema":"http://json-schema.org/draft-07/schema#","nullable":true,"type":"object","properties":{"__proto__":{"type":"object"},"constructor":{"type":"object"},"prototype":{"type":"object"}},"items":[{"type":"object"}],"$defs":{"Definition":{"type":"object"}}}',
		) as Record<string, unknown>;

		const normalized = normalizeSchemaForMCP(parsed) as Record<string, unknown>;
		const properties = normalized.properties as Record<string, unknown>;

		expect(Object.keys(properties)).toEqual(["__proto__", "constructor", "prototype"]);
		expect(Object.hasOwn(properties, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(properties, "__proto__")?.value).toEqual({
			type: "object",
			additionalProperties: true,
		});
		expect(normalized.prefixItems).toEqual([{ type: "object", additionalProperties: true }]);
		expect(normalized.$defs).toBeUndefined();
		expect(isValidJsonSchema(normalized)).toBe(true);
		expect(({} as Record<string, unknown>).additionalProperties).toBeUndefined();
	});

	it("preserves dangerous keys while cleaning serialized Zod object schemas", () => {
		const leaked = JSON.parse(
			'{"type":"object","def":{"type":"object","shape":{"__proto__":{"type":"object"},"constructor":{"type":"string"},"prototype":{"type":"string"}}}}',
		) as Record<string, unknown>;

		const normalized = normalizeSchemaForMCP(leaked) as Record<string, unknown>;
		const properties = normalized.properties as Record<string, unknown>;

		expect(Object.keys(properties)).toEqual(["__proto__", "constructor", "prototype"]);
		expect(Object.getOwnPropertyDescriptor(properties, "__proto__")?.value).toEqual({
			type: "object",
			additionalProperties: true,
		});
		expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
		expect(isValidJsonSchema(normalized)).toBe(true);
		expect(({} as Record<string, unknown>).additionalProperties).toBeUndefined();
	});

	it("does not resolve an inherited prototype value for an unresolved local ref", () => {
		const schema = {
			$defs: { Safe: { type: "string" } },
			$ref: "#/$defs/__proto__",
		};

		const normalized = normalizeSchemaForMCP(schema) as Record<string, unknown>;

		expect(normalized).toEqual({ $defs: { Safe: { type: "string" } }, $ref: "#/$defs/__proto__" });
		expect(isValidJsonSchema(normalized)).toBe(true);
	});

	it("dereferences refs in schema arrays, nested definitions, escaped names, and boolean definitions", () => {
		const schema = {
			type: "object",
			properties: {
				nested: {
					$defs: { Inner: { type: "string" } },
					$ref: "#/properties/nested/$defs/Inner",
				},
			},
			$defs: {
				"Array/Definition": { type: "object" },
				BooleanDefinition: false,
				Base: { type: "string" },
				Sibling: { type: "number" },
			},
			anyOf: [{ $ref: "#/$defs/Array~1Definition" }, { $ref: "#/$defs/BooleanDefinition" }],
			additionalProperties: {
				$ref: "#/$defs/Base",
				anyOf: [{ $ref: "#/$defs/Sibling" }],
				default: { $ref: "#/$defs/BooleanDefinition" },
			},
		};

		const normalized = normalizeSchemaForMCP(schema) as Record<string, unknown>;
		const properties = normalized.properties as Record<string, unknown>;
		const alternatives = normalized.anyOf as Array<Record<string, unknown> | boolean>;
		const additionalProperties = normalized.additionalProperties as Record<string, unknown>;

		expect(properties.nested).toEqual({ type: "string" });
		expect(alternatives).toEqual([{ type: "object", additionalProperties: true }, false]);
		expect(additionalProperties).toEqual({
			type: "string",
			anyOf: [{ type: "number" }],
			default: { $ref: "#/$defs/BooleanDefinition" },
		});
		expect(normalized.$defs).toBeUndefined();
		expect(isValidJsonSchema(normalized)).toBe(true);
	});

	it("keeps reserved words as schema-map names through dereference and Zod cleanup", () => {
		const schema = {
			type: "object",
			properties: {
				default: { $ref: "#/$defs/Value" },
				const: {
					type: "enum",
					def: { type: "enum", entries: { enabled: "enabled" } },
					enum: { enabled: "enabled" },
				},
			},
			$defs: { Value: { type: "string" } },
		};

		const normalized = normalizeSchemaForMCP(schema) as Record<string, unknown>;
		const properties = normalized.properties as Record<string, unknown>;

		expect(properties.default).toEqual({ type: "string" });
		expect(properties.const).toEqual({ type: "string", enum: ["enabled"] });
		expect(normalized.$defs).toBeUndefined();
		expect(isValidJsonSchema(normalized)).toBe(true);
	});

	it("applies sibling constraints when a local ref resolves to the boolean true schema", () => {
		const schema = {
			type: "object",
			properties: {
				value: { $ref: "#/$defs/Any", type: "string" },
			},
			$defs: { Any: true },
		};

		const normalized = normalizeSchemaForMCP(schema) as Record<string, unknown>;
		const properties = normalized.properties as Record<string, unknown>;

		expect(properties.value).toEqual({ type: "string" });
		expect(normalized.$defs).toBeUndefined();
		expect(isValidJsonSchema(normalized)).toBe(true);
	});

	it("terminates direct object cycles encountered while dereferencing definitions", () => {
		const schema: Record<string, unknown> = {
			$defs: { Node: { type: "object" } },
			type: "object",
			properties: {},
		};
		(schema.properties as Record<string, unknown>).self = schema;

		const normalized = normalizeSchemaForMCP(schema) as Record<string, unknown>;
		const properties = normalized.properties as Record<string, unknown>;

		expect(properties.self).toEqual({});
		expect(normalized.$defs).toBeUndefined();
		expect(isValidJsonSchema(normalized)).toBe(true);
	});

	it("recurses nested additionalProperties, unions, arrays, and referenced definitions", () => {
		const schema = {
			type: "object",
			properties: {
				map: { type: "object", additionalProperties: { type: "object" } },
				union: { anyOf: [{ type: "object" }, { type: "string" }] },
				list: {
					type: "array",
					items: { type: "object" },
					prefixItems: [{ type: "object" }],
					contains: { type: "object" },
				},
				fromDefs: { $ref: "#/$defs/Definition" },
			},
			$defs: {
				Definition: {
					type: "object",
					properties: { nested: { type: "object" } },
				},
			},
		};

		const normalized = normalizeSchemaForMCP(schema) as Record<string, unknown>;
		const properties = normalized.properties as Record<string, Record<string, unknown>>;
		const map = properties.map.additionalProperties as Record<string, unknown>;
		const union = properties.union.anyOf as Array<Record<string, unknown>>;
		const list = properties.list;
		const definition = properties.fromDefs;

		expect(map).toEqual({ type: "object", additionalProperties: true });
		expect(union[0]).toEqual({ type: "object", additionalProperties: true });
		expect(union[1]).toEqual({ type: "string" });
		expect(list.items).toEqual({ type: "object", additionalProperties: true });
		expect(list.prefixItems).toEqual([{ type: "object", additionalProperties: true }]);
		expect(list.contains).toEqual({ type: "object", additionalProperties: true });
		expect(definition).toEqual({
			type: "object",
			properties: { nested: { type: "object", additionalProperties: true } },
		});
		expect(normalized.$defs).toBeUndefined();
		expect(isValidJsonSchema(normalized)).toBe(true);
		expect(normalizeSchemaForMCP(normalized)).toEqual(normalized);
	});

	it("terminates cyclic schemas with the existing empty-schema cycle boundary", () => {
		const schema: Record<string, unknown> = { type: "object", properties: {} };
		(schema.properties as Record<string, unknown>).self = schema;

		const normalized = normalizeSchemaForMCP(schema) as Record<string, unknown>;
		const properties = normalized.properties as Record<string, unknown>;

		expect(properties.self).toEqual({});
		expect(normalizeSchemaForMCP(normalized)).toEqual(normalized);
	});

	it("does not turn malformed MCP schemas into valid JSON Schema", () => {
		const malformed = {
			type: "not-a-json-schema-type",
			properties: [],
		};

		expect(isValidJsonSchema(malformed)).toBe(false);
		expect(isValidJsonSchema(normalizeSchemaForMCP(malformed))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// sanitizeSchemaForOpenAIResponses
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForOpenAIResponses", () => {
	it("adds empty properties to object schemas without rewriting literal payloads", () => {
		const literal = { type: "object", oneOf: [{ const: "literal" }] };
		const schema = {
			type: "object",
			properties: {
				nested: { type: "object" },
				union: {
					oneOf: [{ type: "object" }],
				},
			},
			oneOf: [{ type: "object" }],
			enum: [literal],
			const: literal,
			default: literal,
			examples: [literal],
		};

		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			properties: {
				nested: { type: "object", properties: {} },
				union: {
					anyOf: [{ type: "object", properties: {} }],
				},
			},
			enum: [literal],
			const: literal,
			default: literal,
			examples: [literal],
			anyOf: [{ type: "object", properties: {} }],
		});
	});

	it("adds empty properties under draft-07 dependencies and draft 2019-09 contentSchema", () => {
		const schema = {
			type: "object",
			properties: {
				body: {
					type: "string",
					contentSchema: { type: "object" },
				},
			},
			dependencies: {
				body: { type: "object" },
				other: ["body"],
			},
		};

		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			properties: {
				body: {
					type: "string",
					contentSchema: { type: "object", properties: {} },
				},
			},
			dependencies: {
				body: { type: "object", properties: {} },
				other: ["body"],
			},
		});
	});

	it("adds empty properties when `type` is a draft 2020-12 array including object", () => {
		expect(sanitizeSchemaForOpenAIResponses({ type: ["object", "null"] })).toEqual({
			type: ["object", "null"],
			properties: {},
		});
	});

	it("preserves non-array oneOf payloads verbatim instead of dropping them", () => {
		const malformed = { type: "object", oneOf: { type: "object" } } as unknown as Record<string, unknown>;

		expect(sanitizeSchemaForOpenAIResponses(malformed)).toEqual({
			type: "object",
			oneOf: { type: "object" },
			properties: {},
		});
	});

	it("does not recurse infinitely on self-referential object schemas", () => {
		const circular: Record<string, unknown> = { type: "object", properties: {} };
		(circular.properties as Record<string, unknown>).self = circular;

		const sanitized = sanitizeSchemaForOpenAIResponses(circular);
		const properties = (sanitized as { properties: Record<string, unknown> }).properties;
		expect(properties.self).toBe(sanitized as unknown as object);
		expect((sanitized as { type: unknown }).type).toBe("object");
	});
});

// ---------------------------------------------------------------------------
// sanitizeSchemaForOpenAIResponses — empty-schema normalization (issue #1179)
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForOpenAIResponses — empty-schema normalization", () => {
	it("normalizes {} (empty schema = z.unknown()) to `true` in additionalProperties (issue #1179)", () => {
		// z.record(z.string(), z.unknown()) produces additionalProperties: {}
		const schema = { type: "object", additionalProperties: {} };
		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			additionalProperties: true,
			properties: {},
		});
	});

	it("normalizes {} in items to `true` (z.array(z.unknown()))", () => {
		const schema = { type: "array", items: {} };
		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({ type: "array", items: true });
	});

	it("normalizes {} in nested property schemas (z.unknown() as a property value)", () => {
		const schema = {
			type: "object",
			properties: { meta: {} },
			required: ["meta"],
		};
		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			properties: { meta: true },
			required: ["meta"],
		});
	});

	it("normalizes {} in anyOf branches", () => {
		const schema = { anyOf: [{}, { type: "string" }] };
		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({ anyOf: [true, { type: "string" }] });
	});

	it("does not normalize non-empty schemas or boolean schemas", () => {
		const schema = {
			type: "object",
			additionalProperties: { type: "string" },
			unevaluatedProperties: false,
		};
		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			properties: {},
			additionalProperties: { type: "string" },
			unevaluatedProperties: false,
		});
	});
});
// ---------------------------------------------------------------------------
// enforceStrictSchema and tryEnforceStrictSchema
// ---------------------------------------------------------------------------

describe("enforceStrictSchema and tryEnforceStrictSchema", () => {
	it("keeps strict mode enabled for an enum-only root schema by inferring a concrete type", () => {
		const result = tryEnforceStrictSchema({
			enum: ["draft", "published"],
		});

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "string",
			enum: ["draft", "published"],
		});
	});

	it("keeps strict mode enabled for a const-only root schema by inferring a concrete type", () => {
		const result = tryEnforceStrictSchema({ const: 7 });

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "number",
			enum: [7],
		});
	});

	it("infers array type when items is present without an explicit type", () => {
		const result = tryEnforceStrictSchema({
			items: { type: "string" },
		});

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "array",
			items: { type: "string" },
		});
	});

	it("recurses into $defs and definitions when enforcing strict rules", () => {
		const schema = {
			type: "object",
			properties: {
				payload: { $ref: "#/$defs/Payload" },
				legacy: { $ref: "#/definitions/Legacy" },
			},
			required: ["payload", "legacy"],
			$defs: {
				Payload: {
					type: "object",
					properties: { value: { type: "string" } },
					required: [],
				},
			},
			definitions: {
				Legacy: {
					type: "object",
					properties: { count: { type: "number" } },
					required: [],
				},
			},
		} as Record<string, unknown>;

		const strict = enforceStrictSchema(schema);
		const defs = strict.$defs as Record<string, Record<string, unknown>>;
		const definitions = strict.definitions as Record<string, Record<string, unknown>>;

		expect(defs.Payload.additionalProperties).toBe(false);
		expect(definitions.Legacy.additionalProperties).toBe(false);
		expect(defs.Payload.required).toEqual(["value"]);
		expect(definitions.Legacy.required).toEqual(["count"]);
	});

	it("enforces strict object constraints inside tuple items", () => {
		const schema = {
			type: "array",
			prefixItems: [
				{ type: "string" },
				{
					type: "object",
					properties: {
						id: { type: "string" },
						nickname: { type: "string" },
					},
					required: ["id"],
				},
			],
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);
		const tupleItems = result.schema.prefixItems as Array<Record<string, unknown>>;
		const tupleObjectItem = tupleItems[1] as Record<string, unknown>;
		const tupleProperties = tupleObjectItem.properties as Record<string, Record<string, unknown>>;

		expect(result.strict).toBe(true);
		expect(tupleObjectItem.additionalProperties).toBe(false);
		expect(tupleObjectItem.required).toEqual(["id", "nickname"]);
		expect(tupleProperties.nickname).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
	});
});

// ---------------------------------------------------------------------------
// stripResidualCombiners
// ---------------------------------------------------------------------------

describe("stripResidualCombiners", () => {
	it("collapses identical anyOf variants to the underlying type", () => {
		const stripped = stripResidualCombiners({
			anyOf: [
				{ type: "string", minLength: 1 },
				{ type: "string", minLength: 1 },
			],
			oneOf: [
				{ type: "string", pattern: "^a" },
				{ type: "string", pattern: "^a" },
			],
		}) as Record<string, unknown>;

		expect(stripped.type).toBe("string");
		expect(stripped.anyOf).toBeUndefined();
		expect(stripped.oneOf).toBeUndefined();
		expect(stripped.minLength).toBe(1);
		expect(stripped.pattern).toBe("^a");
	});

	it("strips residual combiners to a fixpoint at the same node", () => {
		const normalized = stripResidualCombiners({
			anyOf: [
				{ type: "string", description: "A" },
				{ type: "string", description: "B" },
			],
			oneOf: [{ type: "number" }, { type: "number" }],
		}) as Record<string, unknown>;

		expect(normalized.anyOf).toBeUndefined();
		expect(normalized.oneOf).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForCCA
// ---------------------------------------------------------------------------

describe("normalizeSchemaForCCA", () => {
	it("normalizes colliding property names as schema-map entries", () => {
		const normalized = normalizeSchemaForCCA({
			type: "object",
			properties: {
				default: { anyOf: [{ type: "string" }, { type: "null" }] },
			},
			required: ["default"],
		}) as Record<string, unknown>;
		const properties = normalized.properties as Record<string, unknown>;

		expect(properties.default).toEqual({ type: "string" });
		expect(normalized.required).toEqual(["default"]);
	});

	it("collapses same-type anyOf variants when mixed-type collapse bails out", () => {
		const prepared = normalizeSchemaForCCA({
			type: "object",
			properties: {
				value: {
					anyOf: [
						{ type: "string", description: "first" },
						{ type: "string", minLength: 2 },
					],
				},
			},
			required: ["value"],
		}) as {
			properties?: Record<string, Record<string, unknown>>;
		};

		const valueSchema = prepared.properties?.value;
		expect(valueSchema?.type).toBe("string");
		expect(valueSchema?.anyOf).toBeUndefined();
	});

	it("applies Google unsupported-key stripping before CCA-specific normalization", () => {
		const sanitized = normalizeSchemaForCCA({
			type: "object",
			additionalProperties: false,
			properties: {
				config: {
					type: "object",
					additionalProperties: false,
				},
				name: {
					type: "string",
					minLength: 2,
					pattern: "^[a-z]+$",
				},
			},
			required: ["config", "name"],
		});

		expect(sanitized).toEqual({
			type: "object",
			properties: {
				config: {
					type: "object",
					properties: {},
				},
				name: {
					type: "string",
					description: '{minLength: 2, pattern: "^[a-z]+$"}',
				},
			},
			required: ["config", "name"],
		});
	});

	it("lifts stripped validation keywords into description", () => {
		const normalized = normalizeSchemaForCCA({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			maxLength: 8,
			description: "ID",
		}) as Record<string, unknown>;

		expect(normalized.pattern).toBeUndefined();
		expect(normalized.minLength).toBeUndefined();
		expect(normalized.maxLength).toBeUndefined();
		expect(normalized.description).toBe('ID\n\n{pattern: "^\\\\d+$", minLength: 1, maxLength: 8}');
	});

	it("uses the same merged object output in shared and gemini-cli Antigravity paths", () => {
		const parameters = {
			anyOf: [
				{
					type: "object",
					properties: {
						shared: { type: "string" },
						a: { type: "string" },
					},
					required: ["shared"],
				},
				{
					type: "object",
					properties: {
						shared: { type: "string" },
						b: { type: "number" },
					},
					required: ["shared"],
				},
			],
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "merge_test", description: "Merge test", parameters }];

		const sharedTools = convertTools(tools, createGoogleCliModel("claude-sonnet-4-5"));
		const sharedDeclaration = sharedTools?.[0]?.functionDeclarations[0] as Record<string, unknown>;

		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
			tools,
		};
		const antigravityRequest = buildRequest(createGoogleCliModel("gemini-2.5-pro"), context, "project", {}, true);
		const antigravityDeclaration = antigravityRequest.request.tools?.[0]?.functionDeclarations[0] as Record<
			string,
			unknown
		>;

		const expected = {
			type: "object",
			properties: {
				shared: { type: "string" },
				a: { type: "string" },
				b: { type: "number" },
			},
			required: ["shared"],
		};
		expect(sharedDeclaration.parameters).toEqual(expected);
		expect(antigravityDeclaration.parameters).toEqual(expected);
		expect(antigravityDeclaration.parameters).toEqual(sharedDeclaration.parameters);
		expect(antigravityDeclaration.parametersJsonSchema).toBeUndefined();
	});

	it("does not retain stale required keys after an object-union anyOf merge", () => {
		const prepared = normalizeSchemaForCCA({
			required: ["a"],
			anyOf: [
				{
					type: "object",
					properties: { a: { type: "string" } },
					required: ["a"],
				},
				{
					type: "object",
					properties: { b: { type: "number" } },
					required: ["b"],
				},
			],
		}) as Record<string, unknown>;

		expect(prepared).toEqual({
			type: "object",
			properties: {
				a: { type: "string" },
				b: { type: "number" },
			},
		});
	});

	it("preserves required intersection when merging object anyOf variants with overlapping keys", () => {
		const schema = {
			type: "object",
			properties: {
				profile: {
					anyOf: [
						{
							type: "object",
							properties: {
								id: { type: "string" },
								name: { type: "string" },
							},
							required: ["id", "name"],
						},
						{
							type: "object",
							properties: {
								id: { type: "string" },
								age: { type: "number" },
							},
							required: ["id", "age"],
						},
					],
				},
			},
			required: ["profile"],
		} as const;

		const normalized = normalizeSchemaForCCA(schema) as {
			properties?: {
				profile?: {
					type?: string;
					properties?: Record<string, unknown>;
					required?: string[];
				};
			};
		};
		const profile = normalized.properties?.profile;

		expect(profile?.type).toBe("object");
		expect(Object.keys(profile?.properties ?? {}).sort()).toEqual(["age", "id", "name"]);
		expect(profile?.required).toEqual(["id"]);
	});

	it("does not recurse infinitely when preparing a schema with a circular object graph", () => {
		const circular: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		(circular.properties as Record<string, unknown>).self = circular;

		expect(() => normalizeSchemaForCCA(circular)).not.toThrow();
		expect(normalizeSchemaForCCA(circular)).toEqual({
			type: "object",
			properties: {
				self: {},
			},
		});
	});

	it("falls back to an empty object schema when the normalized schema is AJV-invalid", () => {
		const ajvInvalid = {
			type: "invalid-type-token",
		} as Record<string, unknown>;

		expect(normalizeSchemaForCCA(ajvInvalid)).toEqual({
			type: "object",
			properties: {},
		});
	});
});

// ---------------------------------------------------------------------------
// Circular schema safety (normalizeSchemaForGoogle + sanitizeSchemaForStrictMode)
// ---------------------------------------------------------------------------

describe("circular schema safety", () => {
	it("does not overflow the stack when either sanitizer encounters a self-referential object", () => {
		const circular: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		(circular.properties as Record<string, unknown>).self = circular;

		expect(() => normalizeSchemaForGoogle(circular)).not.toThrow();
		expect(() => sanitizeSchemaForStrictMode(circular)).not.toThrow();
	});
});
