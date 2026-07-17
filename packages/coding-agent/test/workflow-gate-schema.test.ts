import { describe, expect, it } from "bun:test";
import {
	assertSupportedGateSchema,
	compileGateSchema,
	GATE_SCHEMA_LIMITS,
	schemaHash,
	validateGateAnswer,
	WorkflowGateSchemaError,
} from "../src/modes/shared/agent-wire/workflow-gate-schema";
import type { JsonSchema } from "../src/modes/shared/agent-wire/workflow-gate-types";

describe("workflow-gate-schema", () => {
	it("rejects unsupported keywords at construction", () => {
		const schema = { type: "string", format: "email" } as unknown as JsonSchema;
		expect(() => assertSupportedGateSchema(schema)).toThrow(WorkflowGateSchemaError);
	});

	it("rejects unsupported types and oversized schemas", () => {
		expect(() => assertSupportedGateSchema({ type: "tuple" } as unknown as JsonSchema)).toThrow(
			WorkflowGateSchemaError,
		);
		const huge: JsonSchema = {
			type: "string",
			enum: Array.from({ length: GATE_SCHEMA_LIMITS.maxEnumValues + 1 }, (_, i) => `v${i}`),
		};
		expect(() => assertSupportedGateSchema(huge)).toThrow(WorkflowGateSchemaError);
	});

	it("rejects malformed shapes of supported keywords at construction", () => {
		const cases: unknown[] = [
			{ type: "object", required: "name" }, // required not array
			{ type: "object", required: [1, 2] }, // required not string array
			{ type: "object", properties: [] }, // properties not object
			{ type: "object", additionalProperties: 1 }, // not boolean/object
			{ type: "string", minLength: -1 }, // negative
			{ type: "string", maxLength: 1.5 }, // non-integer
			{ type: "array", minItems: -1 }, // negative
			{ type: "array", maxItems: 1.5 }, // non-integer
			{ type: "array", uniqueItems: "yes" }, // non-boolean
			{ type: "number", minimum: Number.POSITIVE_INFINITY }, // non-finite
			{ type: "string", title: 5 }, // non-string meta
			{ type: "string", pattern: 5 }, // non-string pattern
			{ type: "string", pattern: "[" }, // invalid pattern
		];
		for (const c of cases) {
			expect(() => assertSupportedGateSchema(c as JsonSchema)).toThrow(WorkflowGateSchemaError);
		}
	});

	it("produces a stable schema hash regardless of key order", () => {
		const a: JsonSchema = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } };
		const b: JsonSchema = { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" };
		expect(schemaHash(a)).toBe(schemaHash(b));
	});

	it("validates enum answers and returns typed errors on mismatch", () => {
		const compiled = compileGateSchema({ type: "string", enum: ["approve", "reject"] });
		expect(validateGateAnswer(compiled, "g1", "approve")).toBeNull();
		const err = validateGateAnswer(compiled, "g1", "maybe");
		expect(err).not.toBeNull();
		expect(err?.code).toBe("invalid_workflow_gate_answer");
		expect(err?.gate_id).toBe("g1");
		expect(err?.errors[0]?.keyword).toBe("enum");
	});

	it("validates string patterns", () => {
		const compiled = compileGateSchema({ type: "string", pattern: "\\S" });
		expect(validateGateAnswer(compiled, "g-pattern", "has text")).toBeNull();
		expect(validateGateAnswer(compiled, "g-pattern", "   ")?.errors[0]?.keyword).toBe("pattern");
	});

	it("validates object required + additionalProperties:false", () => {
		const compiled = compileGateSchema({
			type: "object",
			properties: { name: { type: "string" }, age: { type: "integer", minimum: 0 } },
			required: ["name"],
			additionalProperties: false,
		});
		expect(validateGateAnswer(compiled, "g2", { name: "x", age: 3 })).toBeNull();
		expect(validateGateAnswer(compiled, "g2", { age: 3 })?.errors[0]?.keyword).toBe("required");
		expect(validateGateAnswer(compiled, "g2", { name: "x", extra: 1 })?.errors[0]?.keyword).toBe(
			"additionalProperties",
		);
		expect(validateGateAnswer(compiled, "g2", { name: "x", age: -1 })?.errors[0]?.keyword).toBe("minimum");
	});

	it("validates array minItems, maxItems, and uniqueItems", () => {
		const compiled = compileGateSchema({
			type: "array",
			items: { type: "string", enum: ["a", "b"] },
			minItems: 1,
			maxItems: 2,
			uniqueItems: true,
		});
		expect(validateGateAnswer(compiled, "g-array", ["a", "b"])).toBeNull();
		expect(validateGateAnswer(compiled, "g-array", [])?.errors[0]?.keyword).toBe("minItems");
		expect(validateGateAnswer(compiled, "g-array", ["a", "b", "a"])?.errors[0]?.keyword).toBe("maxItems");
		expect(validateGateAnswer(compiled, "g-array", ["a", "a"])?.errors[0]?.keyword).toBe("uniqueItems");
	});

	it("caches compiled schemas by hash", () => {
		const schema: JsonSchema = { type: "boolean" };
		expect(compileGateSchema(schema)).toBe(compileGateSchema(schema));
	});
});
