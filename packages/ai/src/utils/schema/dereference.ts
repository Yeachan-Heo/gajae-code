/**
 * Inline `$ref` / `$defs` in a JSON Schema so every consumer sees
 * the full definition without needing a resolver.
 *
 * Handles:
 * - Local `$ref` pointers (`#/$defs/Foo`, `#/definitions/Foo`)
 * - Nested `$defs` / `definitions` blocks
 * - Circular references (breaks the cycle by emitting `{}`)
 *
 * After dereferencing, `$defs` and `definitions` are stripped from the root.
 */
import { isJsonObject, type JsonObject } from "./types";

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

type DereferenceState = {
	unresolvedRef: boolean;
};

/** Resolve any local JSON Pointer, including escaped names and boolean schemas. */
function resolveLocalRef(ref: string, root: JsonObject): unknown | undefined {
	if (!ref.startsWith("#")) return undefined;
	let pointer: string;
	try {
		pointer = decodeURIComponent(ref.slice(1));
	} catch {
		return undefined;
	}
	if (pointer === "") return root;
	if (!pointer.startsWith("/")) return undefined;

	let current: unknown = root;
	for (const encodedSegment of pointer.slice(1).split("/")) {
		const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
		if (Array.isArray(current)) {
			if (!/^(0|[1-9]\d*)$/.test(segment) || !Object.hasOwn(current, segment)) return undefined;
			current = current[Number(segment)];
		} else if (isJsonObject(current)) {
			if (!Object.hasOwn(current, segment)) return undefined;
			current = current[segment];
		} else {
			return undefined;
		}
	}
	return current;
}

/** Find definition maps anywhere in a schema graph, excluding literal instance data. */
function hasDefinitionMapDeep(value: unknown, seen: Set<object>, inSchemaMap = false): boolean {
	if (Array.isArray(value)) {
		if (seen.has(value)) return false;
		seen.add(value);
		return value.some(entry => hasDefinitionMapDeep(entry, seen, false));
	}
	if (!isJsonObject(value) || seen.has(value)) return false;
	seen.add(value);
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		if (!inSchemaMap && (key === "$defs" || key === "definitions")) return true;
		if (!inSchemaMap && JSON_SCHEMA_LITERAL_PAYLOAD_KEYS.has(key)) continue;
		const childInSchemaMap = !inSchemaMap && JSON_SCHEMA_MAP_KEYS.has(key);
		if (hasDefinitionMapDeep(value[key], seen, childInSchemaMap)) return true;
	}
	return false;
}

function dereferenceSchemaMap(
	schemaMap: JsonObject,
	root: JsonObject,
	visitingRefs: Set<string>,
	visitingNodes: Set<object>,
	state: DereferenceState,
): JsonObject {
	const result: JsonObject = {};
	for (const key in schemaMap) {
		if (!Object.hasOwn(schemaMap, key)) continue;
		setOwnKey(result, key, dereferenceNode(schemaMap[key], root, visitingRefs, visitingNodes, state));
	}
	return result;
}

/**
 * Recursively dereference a JSON Schema node, inlining all local `$ref` pointers.
 * Object and array path tracking preserves the existing `{}` cycle boundary.
 */
function dereferenceNode(
	node: unknown,
	root: JsonObject,
	visitingRefs: Set<string>,
	visitingNodes: Set<object>,
	state: DereferenceState,
	inSchemaMap = false,
): unknown {
	if (!node || typeof node !== "object") return node;
	if (visitingNodes.has(node)) return {};
	visitingNodes.add(node);

	if (Array.isArray(node)) {
		const result = node.map(item => dereferenceNode(item, root, visitingRefs, visitingNodes, state));
		visitingNodes.delete(node);
		return result;
	}

	const schemaNode = node as JsonObject;
	const ref = Object.hasOwn(schemaNode, "$ref") ? schemaNode.$ref : undefined;
	if (typeof ref === "string") {
		if (visitingRefs.has(ref)) {
			visitingNodes.delete(node);
			return {};
		}
		const resolved = resolveLocalRef(ref, root);
		if (resolved !== undefined) {
			visitingRefs.add(ref);
			const inlined = dereferenceNode(resolved, root, visitingRefs, visitingNodes, state);
			visitingRefs.delete(ref);

			// Merge sibling keywords (e.g. description, default) from the
			// referencing node. In draft 2020-12 these are valid alongside `$ref`.
			let hasSiblings = false;
			for (const key in schemaNode) {
				if (Object.hasOwn(schemaNode, key) && key !== "$ref") {
					hasSiblings = true;
					break;
				}
			}
			if (inlined === false) {
				visitingNodes.delete(node);
				return false;
			}
			if (!hasSiblings || (!isJsonObject(inlined) && inlined !== true)) {
				visitingNodes.delete(node);
				return inlined;
			}
			const merged: JsonObject = {};
			if (isJsonObject(inlined)) {
				for (const key in inlined) {
					if (Object.hasOwn(inlined, key)) setOwnKey(merged, key, inlined[key]);
				}
			}
			for (const key in schemaNode) {
				if (!Object.hasOwn(schemaNode, key) || key === "$ref") continue;
				const siblingValue = schemaNode[key];
				const sibling =
					!inSchemaMap && JSON_SCHEMA_LITERAL_PAYLOAD_KEYS.has(key)
						? schemaNode[key]
						: !inSchemaMap && JSON_SCHEMA_MAP_KEYS.has(key) && isJsonObject(siblingValue)
							? dereferenceSchemaMap(siblingValue, root, visitingRefs, visitingNodes, state)
							: dereferenceNode(siblingValue, root, visitingRefs, visitingNodes, state);
				setOwnKey(merged, key, sibling);
			}
			if (!state.unresolvedRef) {
				delete merged.$defs;
				delete merged.definitions;
			}
			visitingNodes.delete(node);
			return merged;
		}
		state.unresolvedRef = true;
	}

	const result: JsonObject = {};
	for (const key in schemaNode) {
		if (!Object.hasOwn(schemaNode, key)) continue;
		const value = schemaNode[key];
		// Literal instance data is not schema-shaped, even when it contains an
		// object that happens to use schema-looking keys or a local `$ref`.
		if (!inSchemaMap && JSON_SCHEMA_LITERAL_PAYLOAD_KEYS.has(key)) {
			setOwnKey(result, key, value);
			continue;
		}
		if (!inSchemaMap && JSON_SCHEMA_MAP_KEYS.has(key) && isJsonObject(value)) {
			setOwnKey(result, key, dereferenceSchemaMap(value, root, visitingRefs, visitingNodes, state));
			continue;
		}
		setOwnKey(result, key, dereferenceNode(value, root, visitingRefs, visitingNodes, state));
	}
	if (!state.unresolvedRef) {
		delete result.$defs;
		delete result.definitions;
	}
	visitingNodes.delete(node);
	return result;
}

/**
 * Dereference all local `$ref` pointers in a JSON Schema, inlining definitions
 * from `$defs` / `definitions`. The `$defs` block is stripped from the output.
 *
 * Non-local refs (e.g. `http://...`) are left untouched.
 * Circular references are broken with `{}`.
 *
 * @returns A new schema object with all local refs inlined, or the input unchanged
 *          if it's not an object or has no `$defs`/`definitions`.
 */
export function dereferenceJsonSchema(schema: unknown): unknown {
	if (!isJsonObject(schema)) return schema;

	// Fast path: nothing to dereference anywhere in the schema graph
	if (!hasDefinitionMapDeep(schema, new Set())) return schema;

	return dereferenceNode(schema, schema, new Set(), new Set(), { unresolvedRef: false });
}
