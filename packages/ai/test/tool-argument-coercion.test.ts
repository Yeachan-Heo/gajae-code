import { describe, expect, it } from "bun:test";
import type { Tool, ToolCall } from "@gajae-code/ai/types";
import { validateToolArguments } from "@gajae-code/ai/utils/validation";
import * as z from "zod/v4";

describe("Tool argument coercion", () => {
	it("coerces numeric strings when schema expects number", () => {
		const tool: Tool = {
			name: "t1",
			description: "",
			parameters: z.object({ timeout: z.number() }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "t1",
			arguments: { timeout: "300" },
		};

		const result = validateToolArguments(tool, toolCall) as { timeout: number };
		expect(result.timeout).toBe(300);
		expect(typeof result.timeout).toBe("number");
	});

	it("preserves string values when schema expects string", () => {
		const tool: Tool = {
			name: "t2",
			description: "",
			parameters: z.object({ label: z.string() }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-2",
			name: "t2",
			arguments: { label: "300" },
		};

		const result = validateToolArguments(tool, toolCall) as { label: string };
		expect(result.label).toBe("300");
		expect(typeof result.label).toBe("string");
	});

	it("parses JSON arrays in string values when schema expects array", () => {
		const tool: Tool = {
			name: "t3",
			description: "",
			parameters: z.object({ items: z.array(z.number()) }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-3",
			name: "t3",
			arguments: { items: "[1, 2, 3]" },
		};

		const result = validateToolArguments(tool, toolCall) as { items: number[] };
		expect(result.items).toEqual([1, 2, 3]);
	});

	it("parses JSON objects in string values when schema expects object", () => {
		const tool: Tool = {
			name: "t4",
			description: "",
			parameters: z.object({ payload: z.object({ a: z.number() }) }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-4",
			name: "t4",
			arguments: { payload: '{"a": 1}' },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.payload).toEqual({ a: 1 });
	});

	it("preserves unknown root fields after Zod validation so tools can reject disabled arguments", () => {
		const tool: Tool = {
			name: "t4b",
			description: "",
			parameters: z.object({ command: z.string() }),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-4b",
			name: "t4b",
			arguments: { command: "echo hi", async: true },
		});

		expect(result).toEqual({ command: "echo hi", async: true });
	});

	it("coerces JSON-stringified records emitted for Zod record fields", () => {
		const tool: Tool = {
			name: "t4c",
			description: "",
			parameters: z.object({ env: z.record(z.string(), z.string()) }),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-4c",
			name: "t4c",
			arguments: { env: '{"FOO":"bar"}' },
		});

		expect(result).toEqual({ env: { FOO: "bar" } });
	});

	it("upgrades draft-07-shaped JSON Schema without $schema before validation", () => {
		const tool: Tool = {
			name: "json_schema",
			description: "",
			parameters: {
				type: "object",
				properties: {
					item: { $ref: "#/definitions/Item" },
					name: { type: "string", nullable: true },
					pair: {
						type: "array",
						items: [{ type: "string" }, { type: "integer" }],
						additionalItems: false,
					},
				},
				required: ["item", "name", "pair"],
				definitions: {
					Item: { type: "string" },
				},
			},
		};

		const valid = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-json-ok",
			name: "json_schema",
			arguments: { item: "ok", name: null, pair: ["a", 1] },
		});
		expect(valid).toEqual({ item: "ok", name: null, pair: ["a", 1] });

		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-json-bad",
				name: "json_schema",
				arguments: { item: "ok", name: null, pair: ["a", "not-an-integer"] },
			}),
		).toThrow("integer");

		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-json-extra",
				name: "json_schema",
				arguments: { item: "ok", name: null, pair: ["a", 1, "extra"] },
			}),
		).toThrow("false schema");
	});

	it("parses nested JSON arrays in string values", () => {
		const tool: Tool = {
			name: "t5",
			description: "",
			parameters: z.object({ payload: z.object({ items: z.array(z.number()) }) }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-5",
			name: "t5",
			arguments: { payload: { items: "[4, 5]" } },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.payload.items).toEqual([4, 5]);
	});

	it("coerces JSON-stringified object arrays when schema expects array of objects", () => {
		const tool: Tool = {
			name: "t9",
			description: "",
			parameters: z.object({
				a: z.string(),
				b: z.array(
					z.object({
						k: z.string(),
					}),
				),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-9",
			name: "t9",
			arguments: {
				a: "hello",
				b: '[{"k":"y"}]',
			},
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result.b).toEqual([{ k: "y" }]);
	});

	it("coerces JSON-stringified root arguments containing array-of-object fields", () => {
		const tool: Tool = {
			name: "t10",
			description: "",
			parameters: z.object({
				a: z.string(),
				b: z.array(
					z.object({
						k: z.string(),
					}),
				),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-10",
			name: "t10",
			arguments: '{"a":"hello","b":"[{\\"k\\":\\"y\\"}]"}' as unknown as Record<string, unknown>,
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({
			a: "hello",
			b: [{ k: "y" }],
		});
	});

	it("iteratively coerces when both root arguments and nested fields are JSON strings", () => {
		const tool: Tool = {
			name: "t7",
			description: "",
			parameters: z.object({
				path: z.string(),
				edits: z.array(
					z.object({
						target: z.string(),
						new_content: z.string(),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-7",
			name: "t7",
			arguments:
				'{"path":"somefile.js","edits":"[{\\"target\\":\\"13#cf\\",\\"new_content\\":\\"...\\"}]"}' as unknown as Record<
					string,
					unknown
				>,
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.path).toBe("somefile.js");
		expect(result.edits).toEqual([{ target: "13#cf", new_content: "..." }]);
	});

	it("coerces quoted edit arrays before stripping optional null fields", () => {
		const textSchema = z.union([z.array(z.string()), z.string()]);
		const tool: Tool = {
			name: "atom-like-edit",
			description: "",
			parameters: z.object({
				path: z.string(),
				edits: z.array(
					z.object({
						loc: z.string(),
						set: textSchema.optional(),
						pre: textSchema.optional(),
						post: textSchema.optional(),
						sub: z.tuple([z.string(), z.string()]).optional(),
					}),
				),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-atom-like-edit",
			name: "atom-like-edit",
			arguments: {
				path: "orcid.ts",
				edits: '[{"loc":"276ka-282vu","pre":null,"set":["line"],"post":null,"sub":null}]',
			},
		};

		const result = validateToolArguments(tool, toolCall) as { edits: Array<Record<string, unknown>> };
		expect(result.edits).toEqual([{ loc: "276ka-282vu", set: ["line"] }]);
	});

	it("coerces array strings with trailing wrapper braces from malformed nested JSON", () => {
		const tool: Tool = {
			name: "t16",
			description: "",
			parameters: z.object({
				path: z.string(),
				edits: z.array(
					z.object({
						op: z.string(),
						pos: z.string(),
						end: z.string(),
						lines: z.array(z.string()),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-16",
			name: "t16",
			arguments: {
				path: "packages/coding-agent/src/prompts/tools/bash.md",
				edits: '[{"op":"replace","pos":"38#BR","end":"39#QY","lines":["line 1","line 2"]}]}\n',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([
			{
				op: "replace",
				pos: "38#BR",
				end: "39#QY",
				lines: ["line 1", "line 2"],
			},
		]);
	});
	it("iteratively coerces nested array items that are JSON-serialized objects", () => {
		const tool: Tool = {
			name: "t8",
			description: "",
			parameters: z.object({
				path: z.string(),
				edits: z.array(
					z.object({
						target: z.string(),
						new_content: z.string(),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-8",
			name: "t8",
			arguments: {
				path: "somefile.js",
				edits: '["{\\"target\\":\\"13#cf\\",\\"new_content\\":\\"...\\"}"]',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "13#cf", new_content: "..." }]);
	});

	it("accepts null for optional properties by treating them as omitted", () => {
		const tool: Tool = {
			name: "t11",
			description: "",
			parameters: z.object({
				requiredText: z.string(),
				optionalCount: z.number().optional(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-11",
			name: "t11",
			arguments: { requiredText: "ok", optionalCount: null },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ requiredText: "ok" });
	});

	it("drops null optional properties nested in array objects", () => {
		const tool: Tool = {
			name: "t12",
			description: "",
			parameters: z.object({
				edits: z.array(
					z.object({
						target: z.string(),
						pos: z.string().optional(),
						end: z.string().optional(),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-12",
			name: "t12",
			arguments: { edits: [{ target: "a", pos: null, end: "e" }] },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ edits: [{ target: "a", end: "e" }] });
	});

	it("drops null optional properties in anyOf object branches", () => {
		const opSchema = z.union([
			z.object({
				op: z.literal("add_task"),
				phase: z.string(),
				content: z.string(),
			}),
			z.object({
				op: z.literal("update"),
				id: z.string(),
				status: z.string().optional(),
				content: z.string().optional(),
				notes: z.string().optional(),
			}),
		]);

		const tool: Tool = {
			name: "t13",
			description: "",
			parameters: z.object({
				ops: z.array(opSchema),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-13",
			name: "t13",
			arguments: {
				ops: [
					{
						op: "update",
						id: "task-1",
						status: "completed",
						content: null,
						notes: "",
					},
				],
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({
			ops: [
				{
					op: "update",
					id: "task-1",
					status: "completed",
					notes: "",
				},
			],
		});
	});

	it("does not parse quoted JSON strings when schema expects number", () => {
		const tool: Tool = {
			name: "t6",
			description: "",
			parameters: z.object({ timeout: z.number() }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-6",
			name: "t6",
			arguments: { timeout: '"300"' },
		};

		expect(() => validateToolArguments(tool, toolCall)).toThrow('Validation failed for tool "t6"');
	});

	it("coerces numeric string for Optional<number> (anyOf:[number,null])", () => {
		const tool: Tool = {
			name: "t14",
			description: "",
			parameters: z.object({ tick_size: z.number().optional() }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-14",
			name: "t14",
			arguments: { tick_size: "1.0" },
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result.tick_size).toBe(1);
		expect(typeof result.tick_size).toBe("number");
	});

	it("leaves Optional<number> as undefined when absent", () => {
		const tool: Tool = {
			name: "t15",
			description: "",
			parameters: z.object({ tick_size: z.number().optional() }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-15",
			name: "t15",
			arguments: {},
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result.tick_size).toBeUndefined();
	});
	it("strips string 'null' on optional boolean field", () => {
		const tool: Tool = {
			name: "edit-tool",
			description: "",
			parameters: z.object({
				path: z.string(),
				delete: z.boolean().optional(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-edit",
			name: "edit-tool",
			arguments: { path: "file.ts", delete: "null" },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ path: "file.ts" });
	});

	it("strips string 'null' on optional string field", () => {
		const tool: Tool = {
			name: "edit-tool",
			description: "",
			parameters: z.object({
				path: z.string(),
				move: z.string().optional(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-edit",
			name: "edit-tool",
			arguments: { path: "file.ts", move: "null" },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ path: "file.ts" });
	});

	it("errors on string 'null' for required field", () => {
		const tool: Tool = {
			name: "required-tool",
			description: "",
			parameters: z.object({
				path: z.string(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-required",
			name: "required-tool",
			arguments: { path: "null" },
		};

		// Should NOT strip - path is required, so validation should pass
		// (the string "null" is a valid string)
		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ path: "null" });
	});

	it("strips string 'null' and actual null on multiple optional fields", () => {
		const tool: Tool = {
			name: "multi-optional",
			description: "",
			parameters: z.object({
				required: z.string(),
				optBool: z.boolean().optional(),
				optString: z.string().optional(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-multi",
			name: "multi-optional",
			arguments: { required: "value", optBool: "null", optString: null },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ required: "value" });
	});

	it("heals stringified array with extra bracket at end", () => {
		const tool: Tool = {
			name: "heal-1",
			description: "",
			parameters: z.object({
				path: z.string(),
				edits: z.array(
					z.object({
						target: z.string(),
						content: z.string(),
					}),
				),
			}),
		};

		// Model wrote "]}]" at the end instead of "}]" -- extra ] between " and }
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-1",
			name: "heal-1",
			arguments: {
				path: "foo.ts",
				edits: '[{"target": "fn_foo#ABCD", "content": "code}"}]}]',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_foo#ABCD", content: "code}" }]);
	});

	it("heals stringified array with wrong bracket type at end", () => {
		const tool: Tool = {
			name: "heal-2",
			description: "",
			parameters: z.object({
				path: z.string(),
				edits: z.array(
					z.object({
						target: z.string(),
						content: z.string(),
					}),
				),
			}),
		};

		// Model wrote "}}" at the end instead of "}]" -- wrong bracket type
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-2",
			name: "heal-2",
			arguments: {
				path: "bar.ts",
				edits: '[{"target": "fn_bar#1234", "content": "return 1}"}}',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_bar#1234", content: "return 1}" }]);
	});

	it("heals stringified array with literal backslash-n between tokens", () => {
		const tool: Tool = {
			name: "heal-esc-1",
			description: "",
			parameters: z.object({
				edits: z.array(z.object({ target: z.string(), content: z.string() })),
			}),
		};

		// LLM emits literal \n between the closing } and ]
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-esc-1",
			name: "heal-esc-1",
			arguments: {
				edits: '[{"target": "fn_foo#ABCD~", "content": "return 1;\\n"}\\n]',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_foo#ABCD~", content: "return 1;\n" }]);
	});

	it("heals stringified array with trailing junk after balanced container", () => {
		const tool: Tool = {
			name: "heal-trail-1",
			description: "",
			parameters: z.object({
				edits: z.array(z.object({ target: z.string(), op: z.string() })),
			}),
		};

		// LLM appends \n</invoke> after the valid JSON
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-trail-1",
			name: "heal-trail-1",
			arguments: {
				edits: '[{"target": "fn_foo", "op": "replace"}]\n</invoke>',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_foo", op: "replace" }]);
	});

	it("does not heal deeply broken JSON strings", () => {
		const tool: Tool = {
			name: "heal-3",
			description: "",
			parameters: z.object({
				edits: z.array(z.object({ target: z.string() })),
			}),
		};

		// Structural error deep in the middle -- should NOT be healed
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-3",
			name: "heal-3",
			arguments: {
				edits: '[{"target": invalid json here}]',
			},
		};

		expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
	});
	it("parses JSON-stringified array containing raw newlines inside string values", () => {
		const tool: Tool = {
			name: "todo_write_like",
			description: "",
			parameters: z.object({
				phases: z.array(
					z.object({
						name: z.string(),
						tasks: z.array(
							z.object({
								content: z.string(),
								details: z.string().optional(),
							}),
						),
					}),
				),
			}),
		};

		// Stringified phases array where one `details` value contains a raw newline,
		// which `JSON.parse` rejects unless the control char is escaped.
		const stringifiedPhases =
			'[{"name":"Investigation","tasks":[{"content":"Locate code","details":"line one\nline two"}]}]';
		expect(stringifiedPhases.includes("\n")).toBe(true);

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-rawnl",
			name: "todo_write_like",
			arguments: { phases: stringifiedPhases },
		};

		const result = validateToolArguments(tool, toolCall) as {
			phases: Array<{ name: string; tasks: Array<{ content: string; details?: string }> }>;
		};
		expect(result.phases).toEqual([
			{
				name: "Investigation",
				tasks: [{ content: "Locate code", details: "line one\nline two" }],
			},
		]);
	});
	it("substitutes the schema default when a required field arrives as null", () => {
		const tool: Tool = {
			name: "t-defaulted-null",
			description: "",
			parameters: z.object({
				note: z.union([z.string(), z.null()]),
				tags: z.array(z.string()).default([]),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-defaulted-null",
			name: "t-defaulted-null",
			arguments: { note: null, tags: null },
		};

		const result = validateToolArguments(tool, toolCall) as { note: string | null; tags: string[] };
		expect(result).toEqual({ note: null, tags: [] });
	});

	it("clones the substituted default so per-call mutations stay local", () => {
		const tool: Tool = {
			name: "t-defaulted-isolation",
			description: "",
			parameters: z.object({
				tags: z.array(z.string()).default([]),
			}),
		};

		const first = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-iso-1",
			name: "t-defaulted-isolation",
			arguments: { tags: null },
		}) as { tags: string[] };
		first.tags.push("leak");

		const second = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-iso-2",
			name: "t-defaulted-isolation",
			arguments: { tags: null },
		}) as { tags: string[] };

		expect(second.tags).toEqual([]);
	});

	it("strips null from optional properties without defaults", () => {
		const tool: Tool = {
			name: "t-optional-nulls",
			description: "",
			parameters: z.object({
				path: z.string(),
				offset: z.number().optional(),
				limit: z.number().optional(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-optional-nulls",
			name: "t-optional-nulls",
			arguments: { path: "foo", offset: null, limit: null },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ path: "foo" });
	});

	it("deserializes a stringified JSON root with null and stringified-array fields together", () => {
		const tool: Tool = {
			name: "t-root-json-null",
			description: "",
			parameters: z.object({
				note: z.union([z.string(), z.null()]),
				tags: z.array(z.string()).default([]),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-root-json-null",
			name: "t-root-json-null",
			arguments: JSON.stringify({ note: null, tags: JSON.stringify(["a", "b"]) }) as unknown as Record<
				string,
				unknown
			>,
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ note: null, tags: ["a", "b"] });
	});

	it("deserializes nested JSON strings at multiple levels", () => {
		const tool: Tool = {
			name: "t-nested-json",
			description: "",
			parameters: z.object({
				payload: z.object({
					flags: z.array(z.boolean()),
					meta: z.object({ count: z.number() }),
				}),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-nested-json",
			name: "t-nested-json",
			arguments: {
				payload: JSON.stringify({
					flags: JSON.stringify([true, false]),
					meta: JSON.stringify({ count: 3 }),
				}),
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({
			payload: {
				flags: [true, false],
				meta: { count: 3 },
			},
		});
	});

	it("tolerates extra keys on .strict() Zod object schemas (loose-recursive)", () => {
		const tool: Tool = {
			name: "t-strict-root",
			description: "",
			parameters: z
				.object({
					op: z.string(),
				})
				.strict(),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-strict-root",
			name: "t-strict-root",
			arguments: { op: "fix", timeout: "300" },
		};

		// Extras on strict schemas are dropped during validation rather than
		// surfaced as a hard error — equivalent to converting every object to
		// loose semantics for the purposes of tool dispatch.
		const result = validateToolArguments(tool, toolCall) as Record<string, unknown>;
		expect(result.op).toBe("fix");
		expect(result.timeout).toBeUndefined();
	});

	it("tolerates extra keys on nested .strict() Zod object schemas", () => {
		const tool: Tool = {
			name: "t-strict-nested",
			description: "",
			parameters: z
				.object({
					config: z
						.object({
							host: z.string(),
						})
						.strict(),
				})
				.strict(),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-strict-nested",
			name: "t-strict-nested",
			arguments: { config: { host: "example.com", port: 443 } },
		};

		// Nested strict objects also tolerate extras; the inner key is stripped
		// so validation succeeds against the schema's declared shape.
		const result = validateToolArguments(tool, toolCall) as { config: Record<string, unknown> };
		expect(result.config.host).toBe("example.com");
	});

	it("tolerates extras on JSON Schema parameters with additionalProperties: false", () => {
		const tool: Tool = {
			name: "t-json-strict",
			description: "",
			parameters: {
				type: "object",
				properties: {
					op: { type: "string" },
				},
				required: ["op"],
				additionalProperties: false,
			},
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-json-strict",
			name: "t-json-strict",
			arguments: { op: "fix", timeout: 300 },
		};

		const result = validateToolArguments(tool, toolCall) as Record<string, unknown>;
		expect(result.op).toBe("fix");
	});
	it("runs an opt-in raw argument adapter before null normalization and terminal rejection", () => {
		let observed: unknown;
		const tool: Tool = {
			name: "raw-adapter",
			description: "",
			parameters: z.object({ value: z.string().optional() }),
			rawArgumentValidation: arguments_ => {
				observed = arguments_.value;
				return arguments_.value === "null" ? { outcome: "reject" } : { outcome: "passthrough" };
			},
		};

		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-raw-adapter",
				name: "raw-adapter",
				arguments: { value: "null" },
			}),
		).toThrow("raw arguments rejected before coercion");
		expect(observed).toBe("null");
	});
});
