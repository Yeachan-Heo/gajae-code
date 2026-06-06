import { describe, expect, it } from "bun:test";
import type { RpcJsonSchema } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	assertSupportedGateSchema,
	compileGateSchema,
	GATE_SCHEMA_LIMITS,
	schemaHash,
	validateGateAnswer,
	WorkflowGateSchemaError,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-schema";

describe("workflow-gate-schema", () => {
	it("rejects unsupported keywords at construction", () => {
		const schema = { type: "string", pattern: "^x" } as unknown as RpcJsonSchema;
		expect(() => assertSupportedGateSchema(schema)).toThrow(WorkflowGateSchemaError);
	});

	it("rejects unsupported types and oversized schemas", () => {
		expect(() => assertSupportedGateSchema({ type: "tuple" } as unknown as RpcJsonSchema)).toThrow(
			WorkflowGateSchemaError,
		);
		const huge: RpcJsonSchema = {
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
			{ type: "number", minimum: Number.POSITIVE_INFINITY }, // non-finite
			{ type: "string", title: 5 }, // non-string meta
		];
		for (const c of cases) {
			expect(() => assertSupportedGateSchema(c as RpcJsonSchema)).toThrow(WorkflowGateSchemaError);
		}
	});

	it("produces a stable schema hash regardless of key order", () => {
		const a: RpcJsonSchema = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } };
		const b: RpcJsonSchema = { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" };
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

	it("caches compiled schemas by hash", () => {
		const schema: RpcJsonSchema = { type: "boolean" };
		expect(compileGateSchema(schema)).toBe(compileGateSchema(schema));
	});
});
