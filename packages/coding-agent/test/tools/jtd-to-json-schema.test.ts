import { describe, expect, it } from "bun:test";
import { jtdToJsonSchema } from "@gajae-code/coding-agent/tools/jtd-to-json-schema";

describe("jtdToJsonSchema", () => {
	it("preserves own __proto__ keys in JSON Schema and JTD property maps", () => {
		for (const input of [
			'{"type":"object","properties":{"__proto__":{"type":"string"}}}',
			'{"properties":{"__proto__":{"type":"string"}}}',
			'{"optionalProperties":{"__proto__":{"type":"string"}}}',
		]) {
			const converted = jtdToJsonSchema(JSON.parse(input)) as { properties: Record<string, unknown> };
			expect(Object.hasOwn(converted.properties, "__proto__")).toBe(true);
			expect(Object.getOwnPropertyDescriptor(converted.properties, "__proto__")?.value).toEqual({ type: "string" });
		}
	});

	it("preserves a __proto__ JTD discriminator as an own property", () => {
		const input = JSON.parse(
			'{"discriminator":"__proto__","mapping":{"tag":{"properties":{"value":{"type":"string"}}}}}',
		);
		const converted = jtdToJsonSchema(input) as {
			oneOf: Array<{ properties: Record<string, unknown>; required: string[] }>;
		};
		expect(Object.hasOwn(converted.oneOf[0].properties, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(converted.oneOf[0].properties, "__proto__")?.value).toEqual({
			const: "tag",
		});
		expect(converted.oneOf[0].required).toContain("__proto__");
	});
	it("converts JTD elements and int32 primitives into JSON Schema", () => {
		const converted = jtdToJsonSchema({
			properties: {
				results: {
					elements: {
						properties: {
							issue: { type: "int32" },
						},
					},
				},
			},
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				results: {
					type: "array",
					items: {
						type: "object",
						properties: {
							issue: { type: "integer" },
						},
						required: ["issue"],
						additionalProperties: false,
					},
				},
			},
			required: ["results"],
			additionalProperties: false,
		});
	});

	it("normalizes nested JTD fragments inside JSON Schema nodes", () => {
		const converted = jtdToJsonSchema({
			type: "object",
			properties: {
				results: {
					type: "array",
					elements: {
						properties: {
							issue: { type: "int32" },
						},
					},
				},
			},
			required: ["results"],
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				results: {
					type: "array",
					items: {
						type: "object",
						properties: {
							issue: { type: "integer" },
						},
						required: ["issue"],
						additionalProperties: false,
					},
				},
			},
			required: ["results"],
		});
	});
	it("does not misinterpret user-named properties that collide with JTD keywords (#1345)", () => {
		// Mirrors the `files[]` shape declared by the built-in explore agent:
		// a JTD elements form whose item properties include one literally named `ref`.
		const converted = jtdToJsonSchema({
			properties: {
				files: {
					elements: {
						properties: {
							ref: { type: "string" },
							description: { type: "string" },
						},
					},
				},
			},
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				files: {
					type: "array",
					items: {
						type: "object",
						properties: {
							ref: { type: "string" },
							description: { type: "string" },
						},
						required: ["ref", "description"],
						additionalProperties: false,
					},
				},
			},
			required: ["files"],
			additionalProperties: false,
		});
	});
});
