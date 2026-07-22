import { describe, expect, it } from "bun:test";
import { estimateTextTokensHeuristic } from "@gajae-code/agent-core/compaction";
import { toolWireSchema } from "@gajae-code/ai/utils/schema/wire";
import { estimateToolSchemaTokens } from "@gajae-code/coding-agent/session/context-estimation";
import * as z from "zod/v4";

const zodTool = {
	name: "select_target",
	description: "Select a target using one of several strict selector shapes.",
	parameters: z.object({
		selector: z.union([
			z
				.object({
					kind: z.literal("path"),
					path: z.string().regex(/^[\w.-]+$/),
					directory: z.string().regex(/^[\w.-]+$/),
					filename: z.string().regex(/^[\w.-]+$/),
				})
				.strict()
				.superRefine((value, context) => {
					if (!value.path.startsWith("/")) context.addIssue({ code: "custom", message: "path must be absolute" });
				}),
			z
				.object({
					kind: z.literal("symbol"),
					symbol: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/),
					module: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/),
					exportName: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.symbol === value.module)
						context.addIssue({ code: "custom", message: "symbol must differ from module" });
				}),
			z
				.object({
					kind: z.literal("range"),
					start: z.string().regex(/^\d+$/),
					end: z.string().regex(/^\d+$/),
					line: z.string().regex(/^\d+$/),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.start === value.end) context.addIssue({ code: "custom", message: "range must span lines" });
				}),
		]),
	}),
};

Object.defineProperty(zodTool.parameters, "_zodRawSerializationBloat", {
	enumerable: true,
	value: Array.from({ length: 20 }, (_, index) =>
		z
			.object({
				index: z.literal(index),
				value: z.string().regex(/^[A-Za-z0-9_-]+$/),
			})
			.strict(),
	),
});

describe("estimateToolSchemaTokens", () => {
	it("estimates Zod tools from their provider-visible wire schema", () => {
		const estimated = estimateToolSchemaTokens([zodTool]);
		const wireEstimate = estimateTextTokensHeuristic([
			zodTool.name,
			zodTool.description,
			JSON.stringify(toolWireSchema(zodTool)),
		]);
		const rawEstimate = estimateTextTokensHeuristic([JSON.stringify(zodTool.parameters)]);

		expect(estimated).toBe(wireEstimate);
		expect(estimated * 4).toBeLessThan(rawEstimate);
	});

	it("continues to estimate plain JSON Schema tools", () => {
		const tool = {
			name: "plain",
			description: "A plain JSON Schema tool.",
			parameters: { type: "object", properties: { x: { type: "string" } } },
		};

		expect(estimateToolSchemaTokens([tool])).toBe(
			estimateTextTokensHeuristic([tool.name, tool.description, JSON.stringify(toolWireSchema(tool))]),
		);
	});

	it("ignores tools whose parameters cannot be read", () => {
		const tool = {
			name: "poisoned",
			description: "A tool with inaccessible parameters.",
			get parameters(): never {
				throw new Error("poisoned parameters");
			},
		};

		expect(() => estimateToolSchemaTokens([tool])).not.toThrow();
	});
});
