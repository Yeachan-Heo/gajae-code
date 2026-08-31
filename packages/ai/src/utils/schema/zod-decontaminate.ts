/**
 * Defensive rewrite for nodes that look like `JSON.stringify(zodSchemaInstance)`
 * output rather than JSON Schema. MCP servers using Zod 4 sometimes ship a
 * serialised schema instance directly as a tool's `inputSchema`, because the
 * fields Zod surfaces on its instances (`type`, `enum`, `options`, `def`) shadow
 * (and clash with) JSON Schema keywords. The resulting payload is neither valid
 * Zod nor valid JSON Schema 2020-12 and Anthropic's strict validator rejects
 * the whole tool list.
 *
 * Symptoms we've observed (gitnexus_impact.direction):
 *   {
 *     def:   { type: "enum", entries: { upstream: "upstream", ... } },
 *     type:  "enum",                       // <- invalid `type` value
 *     enum:  { upstream: "upstream", ... }, // <- `enum` MUST be an array
 *     options: ["upstream", "downstream"],
 *   }
 *
 * This module recognises the shape (`def.type === node.type` and `def.type` is
 * a known Zod kind) and rewrites it to clean JSON Schema where deterministic.
 * For Zod kinds we don't fully model, we strip the toxic siblings (`def`,
 * `options`, object-shaped `enum`) and drop an invalid `type` so the remainder
 * passes meta-schema validation as a permissive node.
 *
 * Pure / identity-preserving: returns the input reference when nothing changes.
 */

import { isJsonObject, type JsonObject } from "./types";

const VALID_JSON_SCHEMA_TYPES: Record<string, true> = {
	string: true,
	number: true,
	integer: true,
	boolean: true,
	object: true,
	array: true,
	null: true,
};

/**
 * Known Zod 4 schema kinds as surfaced on `_def.type` / `.type`. Matching this
 * set (rather than just "has `def`") is what keeps us from rewriting legitimate
 * JSON Schemas that happen to use `def` as a property name.
 */
const ZOD_KINDS: Record<string, true> = {
	string: true,
	number: true,
	int: true,
	boolean: true,
	bigint: true,
	null: true,
	undefined: true,
	void: true,
	any: true,
	unknown: true,
	never: true,
	date: true,
	symbol: true,
	nan: true,
	enum: true,
	literal: true,
	object: true,
	array: true,
	tuple: true,
	record: true,
	map: true,
	set: true,
	union: true,
	discriminatedUnion: true,
	intersection: true,
	lazy: true,
	promise: true,
	function: true,
	file: true,
	custom: true,
	template_literal: true,
	optional: true,
	nullable: true,
	default: true,
	prefault: true,
	catch: true,
	pipe: true,
	transform: true,
	brand: true,
	readonly: true,
	success: true,
	nonoptional: true,
};

const ZOD_SCALAR_TO_JSON_TYPE: Record<string, string> = {
	string: "string",
	number: "number",
	int: "integer",
	boolean: "boolean",
	null: "null",
	bigint: "string",
	date: "string",
	nan: "number",
};

const ZOD_NOISE_KEYS: Record<string, true> = {
	def: true,
	options: true,
	_zod: true,
	checks: true,
};

/**
 * JSON Schema keywords where `null` is a legal value (literal payload positions).
 * Anywhere else, a `null`-valued key is a meta-schema violation — Zod scalars
 * leak `format: null`, `minLength: null`, etc. that we have to scrub.
 */
const KEYS_THAT_ACCEPT_NULL: Record<string, true> = {
	default: true,
	const: true,
	examples: true,
};
const JSON_SCHEMA_LITERAL_PAYLOAD_KEYS = new Set(["default", "const", "enum", "examples"]);
const JSON_SCHEMA_MAP_KEYS = new Set([
	"properties",
	"patternProperties",
	"dependencies",
	"dependentSchemas",
	"$defs",
	"definitions",
]);

function setOwnKey(target: JsonObject, key: string, value: unknown): void {
	if (key === "__proto__") {
		Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
		return;
	}
	target[key] = value;
}

function isZodLeak(node: JsonObject): boolean {
	if (!Object.hasOwn(node, "def") || !Object.hasOwn(node, "type")) return false;
	const def = node.def;
	if (!isJsonObject(def)) return false;
	if (!Object.hasOwn(def, "type")) return false;
	const defType = def.type;
	if (typeof defType !== "string" || !Object.hasOwn(ZOD_KINDS, defType)) return false;
	// Both surface and inner `.type` must agree — Zod always mirrors `_def.type`
	// onto the instance, so this is a near-zero false-positive guard.
	return node.type === defType;
}

function ownValue(object: JsonObject, key: string): unknown {
	return Object.hasOwn(object, key) ? object[key] : undefined;
}

function inferTypeFromValues(values: readonly unknown[]): string {
	if (values.length === 0) return "string";
	const first = values[0];
	if (typeof first === "number") return Number.isInteger(first) ? "integer" : "number";
	if (typeof first === "boolean") return "boolean";
	if (first === null) return "null";
	return "string";
}

function unwrapInnerSchema(def: JsonObject): unknown {
	// Zod uses different fields depending on the wrapper:
	//   optional/nullable/readonly/brand/default → `innerType`
	//   pipe → `in` (or `out`)
	//   lazy → `getter` (a function — gone after JSON.stringify); fall back to {}
	for (const key of ["innerType", "in", "out", "schema", "element"]) {
		if (Object.hasOwn(def, key) && def[key] !== undefined) return def[key];
	}
	return {};
}

function copyWithoutNoise(node: JsonObject): JsonObject {
	const out: JsonObject = {};
	for (const key in node) {
		if (!Object.hasOwn(node, key)) continue;
		if (Object.hasOwn(ZOD_NOISE_KEYS, key)) continue;
		const value = node[key];
		if (value === null && !Object.hasOwn(KEYS_THAT_ACCEPT_NULL, key)) continue;
		setOwnKey(out, key, value);
	}
	return out;
}

function rewriteZodNode(node: JsonObject, seen: WeakSet<object>): unknown {
	const def = node.def as JsonObject;
	const kind = def.type as string;

	switch (kind) {
		case "enum": {
			// Prefer node.options (array form Zod exposes) → def.entries values →
			// object-shaped node.enum values. All three carry the same data.
			const optionsValue = Object.hasOwn(node, "options") ? node.options : undefined;
			const entriesValue = Object.hasOwn(def, "entries") ? def.entries : undefined;
			const enumValue = Object.hasOwn(node, "enum") ? node.enum : undefined;
			const optionsArray = Array.isArray(optionsValue) ? optionsValue : null;
			const entries = isJsonObject(entriesValue) ? Object.values(entriesValue) : null;
			const enumObj = isJsonObject(enumValue) ? Object.values(enumValue) : null;
			const values = optionsArray ?? entries ?? enumObj ?? [];
			return { type: inferTypeFromValues(values), enum: values };
		}

		case "literal": {
			const valuesValue = ownValue(def, "values");
			const values = Array.isArray(valuesValue) ? valuesValue : [];
			if (values.length === 1) {
				return { const: values[0] };
			}
			if (values.length > 1) {
				return { type: inferTypeFromValues(values), enum: values };
			}
			return {};
		}

		case "union":
		case "discriminatedUnion": {
			const defOptions = Object.hasOwn(def, "options") ? def.options : undefined;
			const nodeOptions = Object.hasOwn(node, "options") ? node.options : undefined;
			const arms = Array.isArray(defOptions) ? defOptions : Array.isArray(nodeOptions) ? nodeOptions : [];
			return { anyOf: arms.map(x => walk(x, seen)) };
		}

		case "intersection": {
			return {
				allOf: [walk(ownValue(def, "left"), seen), walk(ownValue(def, "right"), seen)],
			};
		}

		case "array": {
			return { type: "array", items: walk(ownValue(def, "element"), seen) };
		}

		case "set": {
			const element = ownValue(def, "valueType") ?? ownValue(def, "element");
			return { type: "array", uniqueItems: true, items: walk(element, seen) };
		}

		case "tuple": {
			const itemsValue = ownValue(def, "items");
			const items = Array.isArray(itemsValue) ? itemsValue : [];
			const out: JsonObject = { type: "array", prefixItems: items.map(x => walk(x, seen)) };
			const rest = ownValue(def, "rest");
			if (rest != null) out.items = walk(rest, seen);
			return out;
		}

		case "record":
		case "map": {
			return { type: "object", additionalProperties: walk(ownValue(def, "valueType"), seen) };
		}

		case "object": {
			const shapeValue = ownValue(def, "shape");
			const shape = isJsonObject(shapeValue) ? shapeValue : ({} as JsonObject);
			const properties: JsonObject = {};
			const required: string[] = [];
			for (const key in shape) {
				if (!Object.hasOwn(shape, key)) continue;
				const inner = walk(shape[key], seen);
				setOwnKey(properties, key, inner);
				if (!isOptionalEntry(shape[key])) required.push(key);
			}
			const out: JsonObject = { type: "object", properties };
			if (required.length > 0) out.required = required;
			return out;
		}

		case "nonoptional":
		case "optional":
		case "nullable":
		case "default":
		case "prefault":
		case "catch":
		case "readonly":
		case "brand":
		case "lazy":
		case "pipe":
		case "transform": {
			const inner = walk(unwrapInnerSchema(def), seen);
			if (kind === "nullable" && isJsonObject(inner)) {
				if (Object.hasOwn(inner, "type") && typeof inner.type === "string") {
					return { ...inner, type: [inner.type, "null"] };
				}
				if (Object.hasOwn(inner, "type") && Array.isArray(inner.type)) {
					return (inner.type as string[]).includes("null")
						? inner
						: { ...inner, type: [...(inner.type as string[]), "null"] };
				}
				// anyOf / allOf / $ref shapes — no scalar `type` field
				return { anyOf: [inner, { type: "null" }] };
			}
			return inner;
		}

		default: {
			// Best-effort: drop the noise, map the kind to a JSON Schema type if
			// we know one, otherwise drop `type` so the node validates as
			// permissive.
			const cleaned = copyWithoutNoise(node);
			const mapped = ZOD_SCALAR_TO_JSON_TYPE[kind];
			if (mapped) {
				cleaned.type = mapped;
			} else if (typeof cleaned.type === "string" && !Object.hasOwn(VALID_JSON_SCHEMA_TYPES, cleaned.type)) {
				delete cleaned.type;
			}
			// Object-shaped `enum` survives as a noise field — remove if present.
			if (cleaned.enum !== undefined && !Array.isArray(cleaned.enum)) {
				delete cleaned.enum;
			}
			return cleaned;
		}
	}
}

function isOptionalEntry(value: unknown): boolean {
	if (!isJsonObject(value)) return false;
	if (!isZodLeak(value)) return false;
	const def = value.def as JsonObject;
	const kind = Object.hasOwn(def, "type") ? def.type : undefined;
	return kind === "optional" || kind === "default" || kind === "prefault";
}

/**
 * Walks a JSON value and rewrites every Zod-instance-shaped node into clean
 * JSON Schema 2020-12. Identity-preserving when no rewrite fires. Tolerates
 * self-referential graphs — a revisited node returns as-is.
 */
export function decontaminateZodInstance(value: unknown): unknown {
	return walk(value, new WeakSet());
}

function walkSchemaMap(value: JsonObject, seen: WeakSet<object>): JsonObject {
	let changed = false;
	const out: JsonObject = {};
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const child = value[key];
		const rewritten = walk(child, seen);
		if (rewritten !== child) changed = true;
		setOwnKey(out, key, rewritten);
	}
	return changed ? out : value;
}

function walk(value: unknown, seen: WeakSet<object>, inSchemaMap = false): unknown {
	if (Array.isArray(value)) {
		if (seen.has(value)) return value;
		seen.add(value);
		let changed = false;
		const out = value.map(entry => {
			const rewritten = walk(entry, seen);
			if (rewritten !== entry) changed = true;
			return rewritten;
		});
		return changed ? out : value;
	}
	if (!isJsonObject(value)) return value;
	if (seen.has(value)) return value;
	seen.add(value);

	if (isZodLeak(value)) {
		// Rewrite the node itself, then recurse into the rewrite so any nested
		// Zod-instance children get cleaned in the same pass.
		const rewritten = rewriteZodNode(value, seen);
		return rewritten === value ? value : walk(rewritten, seen);
	}

	// Plain JSON Schema node: recurse into children, preserving identity when
	// nothing under us changed.
	let changed = false;
	const out: JsonObject = {};
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const child = value[key];
		if (!inSchemaMap && JSON_SCHEMA_LITERAL_PAYLOAD_KEYS.has(key)) {
			setOwnKey(out, key, child);
			continue;
		}
		const rewritten =
			!inSchemaMap && JSON_SCHEMA_MAP_KEYS.has(key) && isJsonObject(child)
				? walkSchemaMap(child, seen)
				: walk(child, seen);
		if (rewritten !== child) changed = true;
		setOwnKey(out, key, rewritten);
	}
	return changed ? out : value;
}
