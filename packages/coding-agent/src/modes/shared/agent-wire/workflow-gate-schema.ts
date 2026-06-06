/**
 * Workflow gate answer-schema wrapper (#315).
 *
 * Validates gate answers against the JSON Schema advertised with each
 * `workflow_gate` event. The dialect is a documented, constrained subset of
 * JSON Schema 2020-12. Schemas are checked for shape (supported keywords, size,
 * depth) at gate-construction time so the server never advertises a schema it
 * cannot validate; compiled validators are cached by canonical schema hash.
 *
 * The validation internals are intentionally isolated behind {@link compileGateSchema}
 * and {@link validateGateAnswer} so a full JSON Schema engine (e.g. Ajv) can be
 * swapped in later without changing callers.
 */
import { createHash } from "node:crypto";
import type { RpcJsonSchema, RpcWorkflowGateValidationError } from "../../rpc/rpc-types";

/** Keywords this wrapper understands. Any other keyword is rejected. */
const SUPPORTED_KEYWORDS = new Set<keyof RpcJsonSchema>([
	"type",
	"enum",
	"const",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"title",
	"description",
	"oneOf",
	"anyOf",
]);

const SUPPORTED_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

export const GATE_SCHEMA_LIMITS = {
	maxSchemaBytes: 64 * 1024,
	maxDepth: 16,
	maxProperties: 256,
	maxEnumValues: 512,
	maxAnswerBytes: 256 * 1024,
} as const;

/** Thrown at gate construction when a schema is unsupported or too large. */
export class WorkflowGateSchemaError extends Error {
	readonly code = "invalid_workflow_gate_schema";
	constructor(message: string) {
		super(message);
		this.name = "WorkflowGateSchemaError";
	}
}

/** Canonical (stable-key-ordered) JSON serialization used for hashing. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const entries = keys.map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
	return `{${entries.join(",")}}`;
}

export function schemaHash(schema: RpcJsonSchema): string {
	return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

function answerHashOf(answer: unknown): string {
	return createHash("sha256").update(canonicalJson(answer)).digest("hex");
}

/** Validate the schema *shape*. Throws WorkflowGateSchemaError on any problem. */
export function assertSupportedGateSchema(schema: RpcJsonSchema): void {
	const serialized = canonicalJson(schema);
	if (Buffer.byteLength(serialized, "utf8") > GATE_SCHEMA_LIMITS.maxSchemaBytes) {
		throw new WorkflowGateSchemaError(`schema exceeds ${GATE_SCHEMA_LIMITS.maxSchemaBytes} bytes`);
	}
	walkSchema(schema, 0, "#");
}

function walkSchema(schema: RpcJsonSchema, depth: number, path: string): void {
	if (depth > GATE_SCHEMA_LIMITS.maxDepth) {
		throw new WorkflowGateSchemaError(`schema nesting exceeds depth ${GATE_SCHEMA_LIMITS.maxDepth} at ${path}`);
	}
	if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
		throw new WorkflowGateSchemaError(`schema node at ${path} must be an object`);
	}
	for (const key of Object.keys(schema)) {
		if (!SUPPORTED_KEYWORDS.has(key as keyof RpcJsonSchema)) {
			throw new WorkflowGateSchemaError(`unsupported keyword "${key}" at ${path}`);
		}
	}
	if (schema.type !== undefined && !SUPPORTED_TYPES.has(schema.type)) {
		throw new WorkflowGateSchemaError(`unsupported type "${schema.type}" at ${path}`);
	}
	if (schema.enum !== undefined) {
		if (!Array.isArray(schema.enum)) throw new WorkflowGateSchemaError(`enum at ${path} must be an array`);
		if (schema.enum.length > GATE_SCHEMA_LIMITS.maxEnumValues) {
			throw new WorkflowGateSchemaError(`enum at ${path} exceeds ${GATE_SCHEMA_LIMITS.maxEnumValues} values`);
		}
	}
	for (const meta of ["title", "description"] as const) {
		if (schema[meta] !== undefined && typeof schema[meta] !== "string") {
			throw new WorkflowGateSchemaError(`${meta} at ${path} must be a string`);
		}
	}
	for (const limit of ["minLength", "maxLength"] as const) {
		const v = schema[limit];
		if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 0)) {
			throw new WorkflowGateSchemaError(`${limit} at ${path} must be a non-negative integer`);
		}
	}
	for (const limit of ["minimum", "maximum"] as const) {
		const v = schema[limit];
		if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
			throw new WorkflowGateSchemaError(`${limit} at ${path} must be a finite number`);
		}
	}
	if (
		schema.required !== undefined &&
		!(Array.isArray(schema.required) && schema.required.every(r => typeof r === "string"))
	) {
		throw new WorkflowGateSchemaError(`required at ${path} must be an array of strings`);
	}
	if (schema.properties !== undefined) {
		if (typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties)) {
			throw new WorkflowGateSchemaError(`properties at ${path} must be an object`);
		}
		const propKeys = Object.keys(schema.properties);
		if (propKeys.length > GATE_SCHEMA_LIMITS.maxProperties) {
			throw new WorkflowGateSchemaError(`properties at ${path} exceed ${GATE_SCHEMA_LIMITS.maxProperties}`);
		}
		for (const k of propKeys) walkSchema(schema.properties[k] as RpcJsonSchema, depth + 1, `${path}/properties/${k}`);
	}
	if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
		if (
			typeof schema.additionalProperties !== "object" ||
			schema.additionalProperties === null ||
			Array.isArray(schema.additionalProperties)
		) {
			throw new WorkflowGateSchemaError(`additionalProperties at ${path} must be a boolean or schema object`);
		}
		walkSchema(schema.additionalProperties, depth + 1, `${path}/additionalProperties`);
	}
	if (schema.items !== undefined) walkSchema(schema.items, depth + 1, `${path}/items`);
	for (const combiner of ["oneOf", "anyOf"] as const) {
		const branches = schema[combiner];
		if (branches !== undefined) {
			if (!Array.isArray(branches)) throw new WorkflowGateSchemaError(`${combiner} at ${path} must be an array`);
			for (let i = 0; i < branches.length; i++)
				walkSchema(branches[i] as RpcJsonSchema, depth + 1, `${path}/${combiner}/${i}`);
		}
	}
}

type SchemaError = { path: string; keyword: string; message: string; expected?: unknown };

/** A compiled, cached validator for one schema. */
export interface CompiledGateSchema {
	readonly schema: RpcJsonSchema;
	readonly hash: string;
	validate(answer: unknown): SchemaError[];
}

const compileCache = new Map<string, CompiledGateSchema>();

/** Compile (and cache) a validator for a schema. Asserts shape on first compile. */
export function compileGateSchema(schema: RpcJsonSchema): CompiledGateSchema {
	const hash = schemaHash(schema);
	const cached = compileCache.get(hash);
	if (cached) return cached;
	assertSupportedGateSchema(schema);
	const compiled: CompiledGateSchema = {
		schema,
		hash,
		validate: answer => {
			const errors: SchemaError[] = [];
			const serialized = canonicalJson(answer);
			if (Buffer.byteLength(serialized, "utf8") > GATE_SCHEMA_LIMITS.maxAnswerBytes) {
				errors.push({ path: "#", keyword: "maxAnswerBytes", message: "answer too large" });
				return errors;
			}
			validateValue(schema, answer, "#", errors);
			return errors;
		},
	};
	compileCache.set(hash, compiled);
	return compiled;
}

function typeMatches(type: NonNullable<RpcJsonSchema["type"]>, value: unknown): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		case "null":
			return value === null;
	}
}

function validateValue(schema: RpcJsonSchema, value: unknown, path: string, errors: SchemaError[]): void {
	if (schema.type !== undefined && !typeMatches(schema.type, value)) {
		errors.push({ path, keyword: "type", message: `expected ${schema.type}`, expected: schema.type });
		return;
	}
	if (schema.const !== undefined && canonicalJson(value) !== canonicalJson(schema.const)) {
		errors.push({ path, keyword: "const", message: "value does not equal const", expected: schema.const });
	}
	if (schema.enum !== undefined) {
		const ok = schema.enum.some(e => canonicalJson(e) === canonicalJson(value));
		if (!ok) errors.push({ path, keyword: "enum", message: "value not in enum", expected: schema.enum });
	}
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			errors.push({
				path,
				keyword: "minLength",
				message: `shorter than ${schema.minLength}`,
				expected: schema.minLength,
			});
		}
		if (schema.maxLength !== undefined && value.length > schema.maxLength) {
			errors.push({
				path,
				keyword: "maxLength",
				message: `longer than ${schema.maxLength}`,
				expected: schema.maxLength,
			});
		}
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) {
			errors.push({ path, keyword: "minimum", message: `less than ${schema.minimum}`, expected: schema.minimum });
		}
		if (schema.maximum !== undefined && value > schema.maximum) {
			errors.push({ path, keyword: "maximum", message: `greater than ${schema.maximum}`, expected: schema.maximum });
		}
	}
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		for (const req of schema.required ?? []) {
			if (!(req in obj))
				errors.push({ path: `${path}/${req}`, keyword: "required", message: "missing required property" });
		}
		const props = schema.properties ?? {};
		for (const [k, v] of Object.entries(obj)) {
			if (props[k]) {
				validateValue(props[k], v, `${path}/${k}`, errors);
			} else if (schema.additionalProperties === false) {
				errors.push({ path: `${path}/${k}`, keyword: "additionalProperties", message: "unexpected property" });
			} else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
				validateValue(schema.additionalProperties, v, `${path}/${k}`, errors);
			}
		}
	}
	if (Array.isArray(value) && schema.items) {
		for (let i = 0; i < value.length; i++)
			validateValue(schema.items as RpcJsonSchema, value[i], `${path}/${i}`, errors);
	}
	for (const combiner of ["oneOf", "anyOf"] as const) {
		const branches = schema[combiner];
		if (!branches) continue;
		const matchCount = branches.filter(b => {
			const sub: SchemaError[] = [];
			validateValue(b, value, path, sub);
			return sub.length === 0;
		}).length;
		const ok = combiner === "oneOf" ? matchCount === 1 : matchCount >= 1;
		if (!ok) errors.push({ path, keyword: combiner, message: `value did not satisfy ${combiner}` });
	}
}

/**
 * Validate an answer against a compiled gate schema. Returns `null` on success
 * or a typed {@link RpcWorkflowGateValidationError} on mismatch.
 */
export function validateGateAnswer(
	compiled: CompiledGateSchema,
	gateId: string,
	answer: unknown,
): RpcWorkflowGateValidationError | null {
	const errors = compiled.validate(answer);
	if (errors.length === 0) return null;
	return { code: "invalid_workflow_gate_answer", gate_id: gateId, schema_hash: compiled.hash, errors };
}

export { answerHashOf };
