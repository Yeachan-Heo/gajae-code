/**
 * Convert JSON Type Definition (JTD) to JSON Schema.
 *
 * JTD (RFC 8927) is a simpler schema format. This converter allows users to
 * write schemas in JTD and have them converted to JSON Schema for model APIs.
 *
 * @see https://jsontypedef.com/
 * @see https://datatracker.ietf.org/doc/html/rfc8927
 */

import type { JTDPrimitive } from "./jtd-utils.js";
import {
	isJTDDiscriminator,
	isJTDElements,
	isJTDEnum,
	isJTDProperties,
	isJTDRef,
	isJTDType,
	isJTDValues,
} from "./jtd-utils.js";

const primitiveMap: Record<JTDPrimitive, string> = {
	boolean: "boolean",
	string: "string",
	timestamp: "string", // ISO 8601
	float32: "number",
	float64: "number",
	int8: "integer",
	uint8: "integer",
	int16: "integer",
	uint16: "integer",
	int32: "integer",
	uint32: "integer",
};

function convertSchema(schema: unknown): unknown {
	if (schema === null || typeof schema !== "object") {
		return {};
	}

	// Enum form: { enum: ["a", "b"] } → { enum: ["a", "b"] }
	if (isJTDEnum(schema)) {
		return { enum: schema.enum };
	}

	// Elements form: { elements: { type: "string" } } → { type: "array", items: ... }
	if (isJTDElements(schema)) {
		return {
			type: "array",
			items: convertSchema(schema.elements),
		};
	}

	// Type form: { type: "string" } → { type: "string" }
	if (isJTDType(schema)) {
		const jsonType = primitiveMap[schema.type as JTDPrimitive];
		if (!jsonType) {
			return { type: schema.type };
		}
		return { type: jsonType };
	}
	// Values form: { values: { type: "string" } } → { type: "object", additionalProperties: ... }
	if (isJTDValues(schema)) {
		return {
			type: "object",
			additionalProperties: convertSchema(schema.values),
		};
	}

	// Properties form: { properties: {...}, optionalProperties: {...} }
	if (isJTDProperties(schema)) {
		const properties: Record<string, unknown> = Object.create(null);
		const required: string[] = [];

		// Required properties
		if (schema.properties) {
			for (const [key, value] of Object.entries(schema.properties)) {
				properties[key] = convertSchema(value);
				required.push(key);
			}
		}

		// Optional properties
		if (schema.optionalProperties) {
			for (const [key, value] of Object.entries(schema.optionalProperties)) {
				properties[key] = convertSchema(value);
			}
		}

		const result: Record<string, unknown> = {
			type: "object",
			properties,
			additionalProperties: false,
		};

		if (required.length > 0) {
			result.required = required;
		}

		return result;
	}

	// Discriminator form: { discriminator: "type", mapping: { ... } }
	if (isJTDDiscriminator(schema)) {
		const oneOf: unknown[] = [];

		for (const [tag, props] of Object.entries(schema.mapping)) {
			const converted = convertSchema(props) as Record<string, unknown>;
			// Add the discriminator property
			const properties = Object.assign(Object.create(null), converted.properties || {}) as Record<string, unknown>;
			properties[schema.discriminator] = { const: tag };

			const required = ((converted.required as string[]) || []).slice();
			if (!required.includes(schema.discriminator)) {
				required.push(schema.discriminator);
			}

			oneOf.push({
				...converted,
				properties,
				required,
			});
		}

		return { oneOf };
	}

	// Ref form: { ref: "MyType" } → { $ref: "#/$defs/MyType" }
	if (isJTDRef(schema)) {
		return { $ref: `#/$defs/${schema.ref}` };
	}

	// Empty form: {} → {} (accepts anything)
	return {};
}

/**
 * Detect if a schema is JTD format (vs JSON Schema).
 *
 * JTD schemas use: type (primitives), properties, optionalProperties, elements, values, enum, discriminator, ref
 * JSON Schema uses: type: "object", type: "array", items, additionalProperties, etc.
 */
export function isJTDSchema(schema: unknown): boolean {
	if (schema === null || typeof schema !== "object") {
		return false;
	}

	const obj = schema as Record<string, unknown>;

	// JTD-specific keywords
	if ("elements" in obj) return true;
	if ("values" in obj) return true;
	if ("optionalProperties" in obj) return true;
	if ("discriminator" in obj) return true;
	if ("ref" in obj) return true;

	// JTD type primitives (JSON Schema doesn't have int32, float64, etc.)
	if ("type" in obj) {
		const jtdPrimitives = ["timestamp", "float32", "float64", "int8", "uint8", "int16", "uint16", "int32", "uint32"];
		if (jtdPrimitives.includes(obj.type as string)) {
			return true;
		}
	}

	// JTD properties form without type: "object" (JSON Schema requires it)
	if ("properties" in obj && !("type" in obj)) {
		return true;
	}

	return false;
}

function normalizeMixedSchemaNode(schema: unknown): unknown {
	if (schema === null || typeof schema !== "object") {
		return schema;
	}

	if (Array.isArray(schema)) {
		return schema.map(item => normalizeMixedSchemaNode(item));
	}

	if (isJTDSchema(schema)) {
		// `convertSchema` is itself fully recursive and emits pure JSON Schema, so
		// re-walking the result with `normalizeMixedSchemaNode` is unnecessary and
		// unsafe: it would treat user-named properties whose keys happen to be JTD
		// keywords (e.g. `ref`, `elements`) as nested JTD forms (#1345).
		return convertSchema(schema);
	}

	const normalized: Record<string, unknown> = Object.create(null);
	for (const [key, value] of Object.entries(schema)) {
		normalized[key] = normalizeMixedSchemaNode(value);
	}

	return normalized;
}
/**
 * Convert JTD schema to JSON Schema.
 * If already JSON Schema, returns as-is.
 */
export function jtdToJsonSchema(schema: unknown): unknown {
	return normalizeMixedSchemaNode(schema);
}

/**
 * Normalize a schema input that may be a JSON string, object, or null/undefined.
 * Returns { normalized } on success, or { error } if JSON parsing fails.
 */
export function normalizeSchema(schema: unknown): { normalized?: unknown; error?: string } {
	if (schema === undefined || schema === null) return {};
	if (typeof schema === "string") {
		try {
			return { normalized: JSON.parse(schema) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}
	return { normalized: schema };
}
