/**
 * Tool-call argument validation pipeline.
 *
 * Tools may declare their parameters as either Zod schemas (canonical) or
 * plain JSON Schema (legacy / extensions). This module is the single
 * entrypoint the agent calls before dispatching a tool — it:
 *
 *   1. Builds (or fetches from cache) a `ValidationContext` for the tool —
 *      the Zod schema if available plus the equivalent wire JSON Schema, or
 *      just the JSON Schema for non-Zod tools.
 *   2. Normalizes LLM quirks (null / "null" → omit-or-default substitution)
 *      against the JSON Schema before validation.
 *   3. Validates with the Zod or JSON-Schema validator.
 *   4. On failure, walks the resulting issues and coerces JSON-stringified
 *      values (`"[1,2]"` → `[1,2]`), drops unrecognized keys, and retries up
 *      to `MAX_COERCION_PASSES` times.
 *   5. Throws a formatted error if reconciliation fails; otherwise returns
 *      the parsed arguments with original unknown root fields preserved (so
 *      hallucinated top-level keys still surface to the caller).
 *
 * The goal is to be conservative: every coercion is a structural rewrite that
 * keeps the schema in charge of acceptance — we never invent values, only
 * massage shapes the LLM almost got right.
 */
import { structuredCloneJSON } from "@gajae-code/utils";
import type { ZodType } from "zod/v4";
import type { $ZodIssue as ZodIssue } from "zod/v4/core";
import type { RawArgumentRejectionCode, Tool, ToolCall } from "../types";
import { upgradeJsonSchemaTo202012 } from "./schema/draft";
import {
	isJsonSchemaValueValid,
	type JsonSchemaValidationIssue,
	validateJsonSchemaValue,
} from "./schema/json-schema-validator";
import { isZodSchema, zodToWireSchema } from "./schema/wire";

// ============================================================================
// Type Coercion Utilities
// ============================================================================
//
// LLMs sometimes produce tool arguments where a value that should be a number,
// boolean, array, or object is instead passed as a JSON-encoded string. For
// example, an array parameter might arrive as `"[1, 2, 3]"` instead of `[1, 2, 3]`.
//
// Rather than rejecting these outright, we attempt automatic coercion:
//   1. Validate against the tool's schema (Zod, derived from TypeBox when the
//      tool was authored with TypeBox).
//   2. For each type error where the actual value is a string, we check if
//      parsing it as JSON yields a value matching the expected type.
//   3. If so, we replace the string with the parsed value and re-validate.
//
// This is intentionally conservative: we only parse strings that look like
// valid JSON literals (objects, arrays, booleans, null, numbers) and only
// accept the result if it matches the schema's expected type.
// ============================================================================

/** Regex matching valid JSON number literals (integers, decimals, scientific notation) */
const JSON_NUMBER_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Regex matching numeric strings (allows leading zeros) */
const NUMERIC_STRING_PATTERN = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Checks if a value matches any of the expected JSON Schema types.
 * Used to verify that a parsed JSON value is actually what the schema wants.
 */
function matchesExpectedType(value: unknown, expectedTypes: string[]): boolean {
	return expectedTypes.some(type => {
		switch (type) {
			case "string":
				return typeof value === "string";
			case "number":
				return typeof value === "number" && Number.isFinite(value);
			case "integer":
				return typeof value === "number" && Number.isInteger(value);
			case "boolean":
				return typeof value === "boolean";
			case "null":
				return value === null;
			case "array":
				return Array.isArray(value);
			case "object":
				return value !== null && typeof value === "object" && !Array.isArray(value);
			default:
				return false;
		}
	});
}

function tryParseNumberString(value: string, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (!expectedTypes.includes("number") && !expectedTypes.includes("integer")) {
		return { value, changed: false };
	}

	const trimmed = value.trim();
	if (!trimmed || !NUMERIC_STRING_PATTERN.test(trimmed)) {
		return { value, changed: false };
	}

	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) {
		return { value, changed: false };
	}

	if (!matchesExpectedType(parsed, expectedTypes)) {
		return { value, changed: false };
	}

	return { value: parsed, changed: true };
}

function tryParseLeadingJsonContainer(value: string): unknown | undefined {
	const firstChar = value[0];
	const closingChar = firstChar === "{" ? "}" : firstChar === "[" ? "]" : undefined;
	if (!closingChar) return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === firstChar) {
			depth += 1;
			continue;
		}

		if (char !== closingChar) continue;
		depth -= 1;
		if (depth !== 0) continue;

		const prefix = value.slice(0, index + 1);
		try {
			return JSON.parse(prefix) as unknown;
		} catch {
			// LLMs sometimes emit literal `\n` or `\t` between JSON tokens
			// (e.g. `[{...}\n]`). Convert these to real whitespace and retry.
			const cleaned = cleanLiteralEscapes(prefix);
			if (cleaned !== prefix) {
				try {
					return JSON.parse(cleaned) as unknown;
				} catch {}
			}
			// Try escaping raw control chars that appear inside string literals.
			const escapedControls = escapeRawControlsInJsonStrings(prefix);
			if (escapedControls !== prefix) {
				try {
					return JSON.parse(escapedControls) as unknown;
				} catch {}
			}
			// Also try single-char healing on the extracted prefix.
			return tryHealMalformedJson(prefix);
		}
	}

	return undefined;
}

/**
 * Replace literal `\n`, `\t`, `\r` sequences that appear OUTSIDE of JSON
 * strings with actual whitespace.  LLMs sometimes produce these when they
 * confuse the tool-call encoding with the content encoding.
 */
function cleanLiteralEscapes(value: string): string {
	let result = "";
	let inString = false;
	let i = 0;
	while (i < value.length) {
		const ch = value[i];
		if (inString) {
			if (ch === "\\" && i + 1 < value.length) {
				result += ch + value[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			result += ch;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			result += ch;
			i += 1;
			continue;
		}
		// Outside a string: replace literal \n, \t, \r with whitespace
		if (ch === "\\" && i + 1 < value.length) {
			const next = value[i + 1];
			if (next === "n" || next === "t" || next === "r") {
				result += " ";
				i += 2;
				continue;
			}
		}
		result += ch;
		i += 1;
	}
	return result;
}

/**
 * Escape raw control characters (0x00–0x1F) that appear *inside* JSON string
 * literals. LLMs sometimes emit literal newlines/tabs/etc. inside string
 * content instead of `\n` / `\t` escape sequences, which `JSON.parse` rejects
 * even though the surrounding structure is valid.
 *
 * This function only rewrites characters while inside a string; structural
 * whitespace outside of strings is preserved unchanged.
 */
function escapeRawControlsInJsonStrings(value: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	let changed = false;
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		if (inString) {
			if (escaped) {
				result += ch;
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				result += ch;
				escaped = true;
				continue;
			}
			if (ch === '"') {
				result += ch;
				inString = false;
				continue;
			}
			const code = ch.charCodeAt(0);
			if (code < 0x20) {
				changed = true;
				switch (ch) {
					case "\n":
						result += "\\n";
						break;
					case "\r":
						result += "\\r";
						break;
					case "\t":
						result += "\\t";
						break;
					case "\b":
						result += "\\b";
						break;
					case "\f":
						result += "\\f";
						break;
					default:
						result += `\\u${code.toString(16).padStart(4, "0")}`;
				}
				continue;
			}
			result += ch;
			continue;
		}
		if (ch === '"') {
			inString = true;
		}
		result += ch;
	}
	return changed ? result : value;
}

/** Maximum single-character edits to attempt when healing malformed JSON. */
const MAX_HEAL_DISTANCE = 3;
const BRACKET_CHARS = ["[", "]", "{", "}"] as const;

/**
 * Attempts to heal near-valid JSON by applying single-character edits near the
 * end of the string. LLMs (especially smaller ones) sometimes produce JSON with
 * a single misplaced, extra, or wrong bracket at the end — e.g. `"}]"` becomes
 * `"]}"` or gets an extra `}` appended. This function tries:
 *   1. Removing a single character from the last few positions
 *   2. Replacing a single character in the last few positions with each bracket type
 *
 * Returns the parsed value on success, undefined on failure.
 */
function tryHealMalformedJson(value: string): unknown | undefined {
	// Verify it actually fails to parse
	try {
		return JSON.parse(value) as unknown;
	} catch {}

	// Only attempt edits within the last few characters — the error is always
	// a bracket issue at the tail for the class of LLM mistakes this targets.
	const tailStart = Math.max(0, value.length - (MAX_HEAL_DISTANCE * 2 + 1));

	// Strategy 1: remove a single character from the tail
	for (let i = tailStart; i < value.length; i += 1) {
		const candidate = value.slice(0, i) + value.slice(i + 1);
		try {
			return JSON.parse(candidate) as unknown;
		} catch {}
	}

	// Strategy 2: replace a single character in the tail with each bracket type
	for (let i = tailStart; i < value.length; i += 1) {
		const original = value[i];
		for (const replacement of BRACKET_CHARS) {
			if (replacement === original) continue;
			const candidate = value.slice(0, i) + replacement + value.slice(i + 1);
			try {
				return JSON.parse(candidate) as unknown;
			} catch {}
		}
	}

	return undefined;
}

/**
 * Attempts to parse a string as JSON if it looks like a JSON literal and
 * the parsed result matches one of the expected types.
 *
 * Only attempts parsing for strings that syntactically look like JSON:
 *   - Objects: `{...}`
 *   - Arrays: `[...]`
 *   - Literals: `true`, `false`, `null`, or numeric strings
 *
 * Returns `{ changed: true }` only if parsing succeeded AND the result
 * matches an expected type. This prevents false positives like parsing
 * the string `"123"` when the schema actually wants a string.
 */
function tryParseJsonForTypes(value: string, expectedTypes: string[]): { value: unknown; changed: boolean } {
	const trimmed = value.trim();
	if (!trimmed) return { value, changed: false };

	const numberCoercion = tryParseNumberString(trimmed, expectedTypes);
	if (numberCoercion.changed) {
		return numberCoercion;
	}

	// Quick syntactic checks to avoid unnecessary parse attempts
	const looksJsonObject = trimmed.startsWith("{");
	const looksJsonArray = trimmed.startsWith("[");
	const looksJsonLiteral =
		trimmed === "true" || trimmed === "false" || trimmed === "null" || JSON_NUMBER_PATTERN.test(trimmed);

	if (!looksJsonObject && !looksJsonArray && !looksJsonLiteral) {
		return { value, changed: false };
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		// If the string was "null", we parsed it to actual null.
		// Accept this even if null isn't in expectedTypes — the LLM meant "no value".
		// normalizeOptionalNullsForSchema will strip it from optional fields, and
		// the validator will correctly error on required fields.
		if (parsed === null && trimmed === "null") {
			return { value: null, changed: true };
		}
		// For non-null values, only accept if the parsed type matches what the schema expects
		if (matchesExpectedType(parsed, expectedTypes)) {
			return { value: parsed, changed: true };
		}
	} catch {
		if (looksJsonObject || looksJsonArray) {
			// Try escaping raw control chars inside string literals (LLMs sometimes
			// emit literal newlines/tabs inside string content rather than `\n`/`\t`).
			const escapedControls = escapeRawControlsInJsonStrings(trimmed);
			if (escapedControls !== trimmed) {
				try {
					const parsed = JSON.parse(escapedControls) as unknown;
					if (matchesExpectedType(parsed, expectedTypes)) {
						return { value: parsed, changed: true };
					}
				} catch {}
			}
			// Try extracting a valid JSON prefix (handles trailing junk after balanced container)
			const leading = tryParseLeadingJsonContainer(trimmed);
			if (leading !== undefined && matchesExpectedType(leading, expectedTypes)) {
				return { value: leading, changed: true };
			}
			// Try healing single-character bracket errors near the end of the string
			const healed = tryHealMalformedJson(trimmed);
			if (healed !== undefined && matchesExpectedType(healed, expectedTypes)) {
				return { value: healed, changed: true };
			}
		}
		return { value, changed: false };
	}

	return { value, changed: false };
}

// ============================================================================
// JSON Pointer Utilities (RFC 6901)
// ============================================================================
//
// Internally we still address error locations using JSON Pointer syntax
// (e.g., `/foo/0/bar`).  These utilities let coercion read and write values at
// those paths regardless of whether the original error came from Zod or
// from JSON-Schema-shaped normalization.
// ============================================================================

/** Encode a structured Zod issue path as a JSON Pointer. */
function pathToPointer(path: ReadonlyArray<PropertyKey>): string {
	if (path.length === 0) return "";
	return `/${path.map(seg => String(seg).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

/**
 * Decodes a JSON Pointer string into path segments.
 * Handles RFC 6901 escape sequences: ~1 -> /, ~0 -> ~
 */
function decodeJsonPointer(pointer: string): string[] {
	if (!pointer) return [];
	return pointer
		.split("/")
		.slice(1) // Remove leading empty segment from initial "/"
		.map(segment => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Retrieves a value from a nested object/array structure using a JSON Pointer.
 * Returns undefined if the path doesn't exist or traversal fails.
 */
function getValueAtPointer(root: unknown, pointer: string): unknown {
	if (!pointer) return root;
	const segments = decodeJsonPointer(pointer);
	let current: unknown = root;

	for (const segment of segments) {
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index)) return undefined;
			current = current[index];
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}

	return current;
}

/**
 * Sets a value in a nested object/array structure using a JSON Pointer.
 * Mutates the structure in-place. Returns the root (possibly unchanged if
 * the path was invalid).
 */
function setValueAtPointer(root: unknown, pointer: string, value: unknown): unknown {
	if (!pointer) return value;
	const segments = decodeJsonPointer(pointer);
	let current: unknown = root;

	// Navigate to the parent of the target location
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index];
		if (current === null || current === undefined) return root;
		if (Array.isArray(current)) {
			const arrayIndex = Number(segment);
			if (!Number.isInteger(arrayIndex)) return root;
			current = current[arrayIndex];
			continue;
		}
		if (typeof current !== "object") return root;
		current = (current as Record<string, unknown>)[segment];
	}

	// Set the value at the final segment
	const lastSegment = segments[segments.length - 1];
	if (Array.isArray(current)) {
		const arrayIndex = Number(lastSegment);
		if (!Number.isInteger(arrayIndex)) return root;
		current[arrayIndex] = value;
		return root;
	}

	if (typeof current !== "object" || current === null) return root;
	(current as Record<string, unknown>)[lastSegment] = value;
	return root;
}

/**
 * Returns a new structure with the key at `pointer` removed. Only the
 * containers along the path are shallow-cloned (`O(depth)` allocations);
 * every sibling subtree is shared with the input. Returns the input
 * reference unchanged when the pointer is empty, the path is invalid, or
 * the final key is absent — so callers can detect a no-op via identity.
 */
function deleteValueAtPointer(root: unknown, pointer: string): unknown {
	if (!pointer) return root;
	const segments = decodeJsonPointer(pointer);
	if (segments.length === 0) return root;
	return deleteAtSegment(root, segments, 0);
}

function deleteAtSegment(node: unknown, segments: string[], depth: number): unknown {
	const segment = segments[depth];
	const isLeaf = depth === segments.length - 1;

	if (Array.isArray(node)) {
		const index = Number(segment);
		if (!Number.isInteger(index) || index < 0 || index >= node.length) return node;
		if (isLeaf) {
			const next = node.slice();
			next.splice(index, 1);
			return next;
		}
		const child = deleteAtSegment(node[index], segments, depth + 1);
		if (child === node[index]) return node;
		const next = node.slice();
		next[index] = child;
		return next;
	}

	if (typeof node !== "object" || node === null) return node;
	const obj = node as Record<string, unknown>;
	if (!Object.hasOwn(obj, segment)) return node;
	if (isLeaf) {
		const { [segment]: _omit, ...rest } = obj;
		return rest;
	}
	const child = deleteAtSegment(obj[segment], segments, depth + 1);
	if (child === obj[segment]) return node;
	return { ...obj, [segment]: child };
}

// ============================================================================
// JSON-Schema-driven normalization passes (LLM quirks).
// ============================================================================

/**
 * Test a JSON-Schema branch during nullable normalization. Kept deliberately
 * small and synchronous so validation does not need to compile legacy schemas
 * into another schema language.
 */
function branchMatchesSchema(branch: unknown, value: unknown): boolean {
	return isJsonSchemaValueValid(branch, value);
}

function normalizeOptionalNullsForSchema(
	schema: unknown,
	value: unknown,
	isRoot = true,
): { value: unknown; changed: boolean } {
	if (value === null || value === undefined) return { value, changed: false };
	if (schema === null || typeof schema !== "object") return { value, changed: false };

	const schemaObject = schema as Record<string, unknown>;

	const normalizeAnyOfLike = (keyword: "anyOf" | "oneOf"): { value: unknown; changed: boolean } => {
		const branches = schemaObject[keyword];
		if (!Array.isArray(branches)) return { value, changed: false };

		let changedCandidate: { value: unknown; changed: true } | null = null;

		for (const branch of branches) {
			const normalized = normalizeOptionalNullsForSchema(branch, value, isRoot);
			if (!normalized.changed) continue;

			if (branchMatchesSchema(branch, normalized.value)) {
				return normalized;
			}

			if (!changedCandidate) {
				changedCandidate = { value: normalized.value, changed: true };
			}
		}

		return changedCandidate ?? { value, changed: false };
	};

	const anyOfNormalization = normalizeAnyOfLike("anyOf");
	if (anyOfNormalization.changed) return anyOfNormalization;

	const oneOfNormalization = normalizeAnyOfLike("oneOf");
	if (oneOfNormalization.changed) return oneOfNormalization;

	if (Array.isArray(schemaObject.allOf)) {
		let changed = false;
		let nextValue: unknown = value;
		for (const branch of schemaObject.allOf) {
			const normalized = normalizeOptionalNullsForSchema(branch, nextValue, isRoot);
			if (!normalized.changed) continue;
			nextValue = normalized.value;
			changed = true;
		}
		if (changed) return { value: nextValue, changed: true };
	}

	if (Array.isArray(value)) {
		const itemSchema = schemaObject.items;
		if (itemSchema === null || typeof itemSchema !== "object" || Array.isArray(itemSchema)) {
			return { value, changed: false };
		}

		let changed = false;
		let nextValue = value;
		for (let i = 0; i < value.length; i += 1) {
			const normalized = normalizeOptionalNullsForSchema(itemSchema, value[i], false);
			if (!normalized.changed) continue;
			if (!changed) {
				nextValue = [...value];
				changed = true;
			}
			nextValue[i] = normalized.value;
		}
		return { value: changed ? nextValue : value, changed };
	}

	// Coerce string → number/integer when the schema branch declares those types.
	// This fixes anyOf:[{type:"number"},{type:"null"}] (i.e. Optional<number>) where
	// the validator reports an "anyOf" error rather than a "type" error.
	if ((schemaObject.type === "number" || schemaObject.type === "integer") && typeof value === "string") {
		return tryParseNumberString(value, [schemaObject.type as string]);
	}

	if (schemaObject.type !== "object") return { value, changed: false };
	if (typeof value !== "object" || value === null) return { value, changed: false };
	if (Array.isArray(value)) return { value, changed: false };
	if (schemaObject.properties === null || typeof schemaObject.properties !== "object") {
		return { value, changed: false };
	}

	const properties = schemaObject.properties as Record<string, unknown>;
	const required = new Set(Array.isArray(schemaObject.required) ? (schemaObject.required as string[]) : []);

	let changed = false;
	let nextValue = value as Record<string, unknown>;

	for (const [key, propertySchema] of Object.entries(properties)) {
		if (!(key in nextValue)) continue;
		const currentValue = nextValue[key];
		const isNullish = currentValue === null || currentValue === "null";

		// Strip null and the string "null" from optional fields.
		// The LLM sometimes outputs string "null" to mean "no value".
		if (isNullish && !required.has(key)) {
			if (!changed) {
				nextValue = { ...nextValue };
				changed = true;
			}
			delete nextValue[key];
			continue;
		}

		// Substitute the schema-supplied default when a required field arrives
		// as null/"null". LLMs commonly emit null for "I have nothing to say
		// here"; if the schema documents a default, honor it instead of
		// rejecting the whole call. The default is cloned so mutations on the
		// validated value never bleed back into the schema.
		if (isNullish && propertySchema && typeof propertySchema === "object") {
			const propertyObject = propertySchema as Record<string, unknown>;
			if ("default" in propertyObject) {
				if (!changed) {
					nextValue = { ...nextValue };
					changed = true;
				}
				nextValue[key] = structuredCloneJSON(propertyObject.default);
				continue;
			}
		}
		const normalized = normalizeOptionalNullsForSchema(propertySchema, currentValue, false);
		if (!normalized.changed) continue;

		if (!changed) {
			nextValue = { ...nextValue };
			changed = true;
		}
		nextValue[key] = normalized.value;
	}

	// Strip unknown keys with null/"null" values when the schema forbids extras.
	// LLMs sometimes hallucinate verbs alongside valid ones (e.g. `split: null`,
	// `original: null`). Rejecting the entire tool call wastes a turn; treating
	// these the same as null on known optional fields is a safer fallback. Keys
	// with non-null unknown values are left intact so genuine schema mistakes
	// still surface as validation errors.
	//
	// At the ROOT level we deliberately keep unknown null-valued keys intact:
	// Zod-emitted wire schemas always set `additionalProperties: false`, but the
	// post-validation `preserveUnknownRootFields` pass re-attaches root extras
	// so callers can observe (and reject) hallucinated fields. Stripping here
	// would erase the field before that snapshot, hiding the rejection signal.
	if (!isRoot && schemaObject.additionalProperties === false) {
		const knownKeys = new Set(Object.keys(properties));
		for (const key of Object.keys(nextValue)) {
			if (knownKeys.has(key)) continue;
			const v = nextValue[key];
			if (v !== null && v !== "null") continue;
			if (!changed) {
				nextValue = { ...nextValue };
				changed = true;
			}
			delete nextValue[key];
		}
	}

	return { value: changed ? nextValue : value, changed };
}

// ============================================================================
// Zod issue → coercion bridge
// ============================================================================

interface FlatIssue {
	keyword: "type" | "unrecognized" | "other";
	instancePath: string;
	expectedTypes: string[];
}

/**
 * Translate the Zod expected-type marker into the JSON-Schema type name our
 * coercion helpers already understand.
 */
function mapZodExpectedToJsonSchemaType(expected: unknown): string | null {
	if (typeof expected !== "string") return null;
	switch (expected) {
		case "string":
		case "number":
		case "boolean":
		case "array":
		case "object":
		case "null":
			return expected;
		case "record":
			return "object";
		case "int":
		case "bigint":
			return "integer";
		case "nan":
			return "number";
		default:
			return null;
	}
}

/**
 * Flatten Zod issues into a list of (path, expected-types) records suitable
 * for the coercion pass. Recurses through `invalid_union` so each inner
 * candidate produces independent coercion attempts.
 */
function flattenIssues(issues: ReadonlyArray<ZodIssue>): FlatIssue[] {
	const out: FlatIssue[] = [];
	const walk = (issue: ZodIssue, prefix: ReadonlyArray<PropertyKey>): void => {
		const fullPath = prefix.length === 0 ? issue.path : [...prefix, ...issue.path];
		if (issue.code === "invalid_type") {
			const mapped = mapZodExpectedToJsonSchemaType((issue as { expected?: unknown }).expected);
			if (mapped) {
				out.push({ keyword: "type", instancePath: pathToPointer(fullPath), expectedTypes: [mapped] });
				return;
			}
		}
		if (issue.code === "unrecognized_keys") {
			const keys = (issue as { keys?: ReadonlyArray<string> }).keys ?? [];
			for (const key of keys) {
				out.push({
					keyword: "unrecognized",
					instancePath: pathToPointer([...fullPath, key]),
					expectedTypes: [],
				});
			}
			return;
		}
		if (issue.code === "invalid_union") {
			const inner = (issue as unknown as { errors?: ReadonlyArray<ReadonlyArray<ZodIssue>> }).errors;
			if (inner) {
				for (const branch of inner) {
					for (const child of branch) {
						walk(child, fullPath);
					}
				}
			}
			return;
		}
		out.push({ keyword: "other", instancePath: pathToPointer(fullPath), expectedTypes: [] });
	};
	for (const issue of issues) walk(issue, []);
	return out;
}

/**
 * Repair issues raised by the validator before we surface them to the caller.
 *
 * Two kinds of repair are applied:
 *  - **type**: when a value is a JSON-encoded string and the schema wants
 *    something else, parse it and substitute the parsed value.
 *  - **unrecognized**: when a strict object received an extra key (Zod's
 *    `unrecognized_keys` or JSON Schema's `additionalProperties: false`),
 *    drop that key so re-validation succeeds. This effectively coerces every
 *    object schema to loose semantics recursively without rebuilding the
 *    underlying Zod tree.
 *
 * The function is safe and conservative:
 *   - Only processes "type" and "unrecognized" issues
 *   - Only attempts JSON coercion on string values
 *   - Only accepts parsed results that match the expected type
 *   - Clones the args object before mutation (copy-on-write)
 */
function coerceArgsFromIssues(args: unknown, issues: FlatIssue[]): { value: unknown; changed: boolean } {
	if (issues.length === 0) return { value: args, changed: false };

	let changed = false;
	// Tracks whether `nextArgs` is a fully owned deep copy (safe to mutate
	// leaves). The unrecognized-key path uses path-shallow immutable updates
	// and does NOT require ownership, so we only pay for the deep clone when
	// a type coercion actually needs to write into a leaf.
	let owned = false;
	let nextArgs: unknown = args;

	for (const issue of issues) {
		if (issue.keyword === "unrecognized") {
			const previous = nextArgs;
			nextArgs = deleteValueAtPointer(nextArgs, issue.instancePath);
			if (nextArgs !== previous) changed = true;
			continue;
		}
		if (issue.keyword !== "type") continue;
		if (issue.expectedTypes.length === 0) continue;

		const currentValue = getValueAtPointer(nextArgs, issue.instancePath);
		if (typeof currentValue !== "string") continue;

		const result = tryParseJsonForTypes(currentValue, issue.expectedTypes);
		if (!result.changed) continue;

		if (!owned) {
			nextArgs = structuredCloneJSON(nextArgs);
			owned = true;
			changed = true;
		}
		nextArgs = setValueAtPointer(nextArgs, issue.instancePath, result.value);
	}

	return { value: changed ? nextArgs : args, changed };
}

// ============================================================================
// Public API
// ============================================================================

type ValidationContext =
	| {
			kind: "zod";
			zod: ZodType;
			json: Record<string, unknown>;
	  }
	| {
			kind: "json";
			json: Record<string, unknown>;
	  };

/**
 * Cache the validation context derived from a tool's parameters schema.
 * Keyed by the parameters object identity, which is stable across tool
 * registrations.
 */
const kValidationContext = Symbol("ai.validationContext");
type ParamsWithValidationContext = object & { [kValidationContext]?: ValidationContext };
function getValidationContext(tool: Tool): ValidationContext {
	const params = tool.parameters as ParamsWithValidationContext;
	const existing = params[kValidationContext];
	if (existing) return existing;
	const ctx: ValidationContext = isZodSchema(params)
		? { kind: "zod", zod: params, json: zodToWireSchema(params) }
		: { kind: "json", json: upgradeJsonSchemaTo202012(params) as Record<string, unknown> };
	params[kValidationContext] = ctx;
	return ctx;
}

type ContextValidationResult =
	| { success: true; value: unknown }
	| { success: false; flatIssues: FlatIssue[]; messages: string[] };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preserveUnknownRootFields(input: unknown, parsed: unknown): unknown {
	if (!isPlainRecord(input) || !isPlainRecord(parsed)) return parsed;
	return { ...input, ...parsed };
}

function flattenJsonSchemaIssues(issues: ReadonlyArray<JsonSchemaValidationIssue>): FlatIssue[] {
	return issues.map(issue => {
		if (issue.keyword === "additionalProperties") {
			return {
				keyword: "unrecognized",
				instancePath: pathToPointer(issue.path),
				expectedTypes: [],
			};
		}
		return {
			keyword: issue.keyword === "type" ? "type" : "other",
			instancePath: pathToPointer(issue.path),
			expectedTypes: issue.expectedTypes ?? [],
		};
	});
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
	return path.length === 0 ? "root" : path.map(seg => String(seg)).join("/");
}

function validateContext(ctx: ValidationContext, value: unknown): ContextValidationResult {
	if (ctx.kind === "zod") {
		const result = ctx.zod.safeParse(value);
		if (result.success) {
			return { success: true, value: preserveUnknownRootFields(value, result.data) };
		}
		return {
			success: false,
			flatIssues: flattenIssues(result.error.issues),
			messages: result.error.issues.map(issue => `  - ${formatIssuePath(issue.path)}: ${issue.message}`),
		};
	}

	const result = validateJsonSchemaValue(ctx.json, value);
	if (result.success) return { success: true, value };
	return {
		success: false,
		flatIssues: flattenJsonSchemaIssues(result.issues),
		messages: result.issues.map(issue => `  - ${formatIssuePath(issue.path)}: ${issue.message}`),
	};
}

const MAX_COERCION_PASSES = 5;

/**
 * Finds a tool by name and validates the tool call arguments against its schema.
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): ToolCall["arguments"] {
	const tool = tools.find(t => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

const RAW_ARGUMENT_REJECTION_MESSAGES: Record<RawArgumentRejectionCode, string> = {
	"ask-intent-review-requires-positive-round":
		"deepInterview.intent_review is post-Round-0 only and requires a positive round",
	"ask-intent-contract-requires-non-empty-authority":
		"deepInterview.intent_contract requires non-empty items and confirmation_options",
	"ask-deep-interview-metadata-requires-deep-interview-gate":
		"deepInterview metadata cannot be combined with a non-deep-interview workflowGate",
};

/**
 * Validates tool call arguments against the tool's schema (Zod or plain JSON
 * Schema). Applies LLM-quirk coercions (numeric strings, JSON-string
 * containers, null-for-optional, null-for-default) before declaring failure.
 *
 * @throws Error with a formatted message when validation cannot be reconciled.
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): ToolCall["arguments"] {
	const originalArgs = toolCall.arguments;
	const rawValidation = tool.rawArgumentValidation?.(originalArgs);
	if (rawValidation?.outcome === "reject") {
		const base = `Validation failed for tool "${toolCall.name}": raw arguments rejected before coercion`;
		const code = rawValidation.code;
		const correction =
			typeof code === "string" && Object.hasOwn(RAW_ARGUMENT_REJECTION_MESSAGES, code)
				? RAW_ARGUMENT_REJECTION_MESSAGES[code as RawArgumentRejectionCode]
				: undefined;
		throw new Error(correction ? `${base}; ${correction}` : base);
	}
	const rawArgs = rawValidation?.outcome === "accept" ? rawValidation.arguments : originalArgs;
	const ctx = getValidationContext(tool);
	const { json } = ctx;

	// Always normalize first — strip null and string "null" from optional
	// fields and substitute defaults. Handles LLM outputting string "null"
	// to mean "no value" even when validation would otherwise pass.
	let normalizedArgs: unknown = rawArgs;
	let changed = false;
	const initialNormalization = normalizeOptionalNullsForSchema(json, normalizedArgs);
	if (initialNormalization.changed) {
		normalizedArgs = initialNormalization.value;
		changed = true;
	}

	let result = validateContext(ctx, normalizedArgs);
	if (result.success) return result.value as ToolCall["arguments"];

	for (let pass = 0; pass < MAX_COERCION_PASSES; pass += 1) {
		const coercion = coerceArgsFromIssues(normalizedArgs, result.flatIssues);
		if (!coercion.changed) break;

		normalizedArgs = coercion.value;
		changed = true;

		const nullNormalization = normalizeOptionalNullsForSchema(json, normalizedArgs);
		if (nullNormalization.changed) {
			normalizedArgs = nullNormalization.value;
		}

		result = validateContext(ctx, normalizedArgs);
		if (result.success) return result.value as ToolCall["arguments"];
	}

	// Format validation errors nicely. The header phrase is asserted by
	// existing tests; the detailed body is informational.
	const errors = result.messages.join("\n") || "Unknown validation error";

	const receivedArgs = changed
		? {
				original: originalArgs,
				normalized: normalizedArgs,
			}
		: originalArgs;

	const errorMessage = `Validation failed for tool "${
		toolCall.name
	}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(receivedArgs, null, 2)}`;

	throw new Error(errorMessage);
}
