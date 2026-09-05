import { describe, expect, it } from "bun:test";
import {
	finalizeSubprocessOutput,
	SUBAGENT_WARNING_MISSING_YIELD,
	SUBAGENT_WARNING_NULL_YIELD,
	SUBAGENT_WARNING_PLACEHOLDER_YIELD,
} from "../../src/task/executor";

describe("subagent warning injection", () => {
	const placeholderPlanText =
		"See message body — complete plan returned inline per caller instruction (leader persists).";

	it("injects null-data warning when yield is success without data", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "partial output",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success" }],
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe(`${SUBAGENT_WARNING_NULL_YIELD}\n\npartial output`);
		expect(result.hasYield).toBe(true);
	});

	it("injects missing-submit warning when subagent exits cleanly without yield", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { properties: { ok: { type: "boolean" } } },
		});

		expect(result.rawOutput).toBe(SUBAGENT_WARNING_MISSING_YIELD);
		expect(result.hasYield).toBe(false);
	});

	it("does not inject missing-submit warning when fallback completion is recoverable", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: '{"data":{"ok":true}}',
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe('{\n  "ok": true\n}');
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
	});

	it("recovers strict JTD fallback data without synthesizing findings", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: '{"data":{"accepted":true}}',
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { properties: { accepted: { type: "boolean" } } },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.rawOutput)).toEqual({ accepted: true });
	});

	it("prefixes missing-submit warning on stop outputs", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "agent stopped after writing analysis",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe(`${SUBAGENT_WARNING_MISSING_YIELD}\n\nagent stopped after writing analysis`);
	});

	it("does not inject missing-submit warning when execution exits non-zero", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 1,
			stderr: "subagent terminated",
			doneAborted: true,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe("");
		expect(result.stderr).toBe("subagent terminated");
		expect(result.exitCode).toBe(1);
	});

	it("normalizes explicit aborted yield into aborted payload", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "partial output",
			exitCode: 1,
			stderr: "old error",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "aborted", error: "blocked by permissions" }],
			outputSchema: undefined,
		});

		expect(result.abortedViaYield).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("blocked by permissions");
		expect(result.rawOutput).toContain('"aborted": true');
		expect(result.rawOutput).toContain('"blocked by permissions"');
	});

	it("accepts successful yield data without warning", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "should be replaced",
			exitCode: 1,
			stderr: "should clear",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { ok: true } }],
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe('{\n  "ok": true\n}');
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
	});

	it("preserves a public review payload but not success after a terminal stream failure", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "private reasoning must not be promoted",
			exitCode: 1,
			stderr: "OpenAI completions stream stalled while waiting for the next event",
			terminalFailure: true,
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { overall_correctness: "incorrect", summary: "Public review" } }],
			outputSchema: undefined,
		});

		expect(JSON.parse(result.rawOutput)).toEqual({ overall_correctness: "incorrect", summary: "Public review" });
		expect(result.rawOutput).not.toContain("private reasoning");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("OpenAI completions stream stalled while waiting for the next event");
	});

	it("validates strict reviewer output without synthesizing findings", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "ignored",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [
				{
					status: "success",
					data: {
						overall_correctness: "incorrect",
						explanation: "Found one bug",
						confidence: 0.9,
					},
				},
			],
			outputSchema: {
				properties: {
					overall_correctness: { enum: ["correct", "incorrect"] },
					explanation: { type: "string" },
					confidence: { type: "float64" },
				},
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.rawOutput)).toEqual({
			overall_correctness: "incorrect",
			explanation: "Found one bug",
			confidence: 0.9,
		});
	});

	it("rejects yield data missing required structured fields", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "ignored",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: {} }],
			outputSchema: {
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("schema_violation");
		expect(result.stderr).toContain("ok");
		expect(result.rawOutput).toContain('"error": "schema_violation"');
	});

	it("rejects placeholder yield data that points at omitted message body", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "should be replaced",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [
				{
					status: "success",
					data: {
						plan_markdown: placeholderPlanText,
					},
				},
			],
			outputSchema: undefined,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(SUBAGENT_WARNING_PLACEHOLDER_YIELD);
		expect(result.stderr).toContain("$.plan_markdown");
		expect(result.rawOutput).toContain('"error": "schema_violation"');
		expect(result.rawOutput).toContain("Return the real payload");
	});

	it("does not reject ordinary result text that mentions inline returns", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "should be replaced",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [
				{
					status: "success",
					data: {
						summary: "The image is returned inline by the read tool.",
					},
				},
			],
			outputSchema: undefined,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.rawOutput).toBe('{\n  "summary": "The image is returned inline by the read tool."\n}');
	});

	it("rejects fallback completion data that points at omitted message body", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: JSON.stringify({
				data: {
					planMarkdown: placeholderPlanText,
				},
			}),
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: undefined,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(SUBAGENT_WARNING_PLACEHOLDER_YIELD);
		expect(result.stderr).toContain("$.planMarkdown");
		expect(result.rawOutput).toContain('"error": "schema_violation"');
	});

	it("does not inject missing-submit warning when no schema and raw text exists", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "plain text notes",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe("plain text notes");
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
		expect(result.exitCode).toBe(0);
	});

	describe("rejected payload persistence", () => {
		function rejectedEnvelope(result: { rawOutput: string }) {
			return JSON.parse(result.rawOutput) as { error: string; data: unknown };
		}

		it.each([499, 500, 501])("round-trips a rejected payload serialized to %i UTF-16 code units", length => {
			const data = "x".repeat(length - 2);
			expect(JSON.stringify(data)).toHaveLength(length);

			const result = finalizeSubprocessOutput({
				rawOutput: "ignored",
				exitCode: 0,
				stderr: "",
				doneAborted: false,
				signalAborted: false,
				yieldItems: [{ status: "success", data }],
				outputSchema: { type: "object" },
			});

			expect(rejectedEnvelope(result).data).toEqual(data);
		});

		it("preserves unicode and escaped content beyond the former preview boundary", () => {
			const data = {
				findings: [
					{
						message: `${"a".repeat(497)}😀"\\\n한국어`,
						tail: "REJECTED-PAYLOAD-TAIL-SENTINEL",
					},
				],
			};
			const result = finalizeSubprocessOutput({
				rawOutput: "ignored",
				exitCode: 0,
				stderr: "",
				doneAborted: false,
				signalAborted: false,
				yieldItems: [{ status: "success", data }],
				outputSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] },
			});

			expect(rejectedEnvelope(result).data).toEqual(data);
			expect(result.rawOutput).toContain("REJECTED-PAYLOAD-TAIL-SENTINEL");
		});

		it("keeps rejected caller data complete without injecting wrapper findings into fallback output", () => {
			const data = {
				findings: Array.from({ length: 20 }, (_, index) => ({
					title: `finding ${index}`,
					body: `${"detail ".repeat(40)}${index === 19 ? "LONG-FINDINGS-TAIL-SENTINEL" : ""}`,
					priority: 1,
					confidence: 1,
					file_path: "src/example.ts",
					line_start: 1,
					line_end: 1,
				})),
				tail: "LONG-FINDINGS-TAIL-SENTINEL",
			};
			const invalidSchema = {
				type: "object",
				properties: { accepted: { type: "boolean" } },
				required: ["accepted"],
			};
			const explicit = finalizeSubprocessOutput({
				rawOutput: "ignored",
				exitCode: 0,
				stderr: "",
				doneAborted: false,
				signalAborted: false,
				yieldItems: [{ status: "success", data }],
				outputSchema: invalidSchema,
			});
			const fallback = finalizeSubprocessOutput({
				rawOutput: JSON.stringify({ data: { accepted: true } }),
				exitCode: 0,
				stderr: "",
				doneAborted: false,
				signalAborted: false,
				yieldItems: undefined,
				outputSchema: { ...invalidSchema, additionalProperties: false },
			});
			const placeholder = finalizeSubprocessOutput({
				rawOutput: "ignored",
				exitCode: 0,
				stderr: "",
				doneAborted: false,
				signalAborted: false,
				yieldItems: [{ status: "success", data: { ...data, plan_markdown: placeholderPlanText } }],
				outputSchema: undefined,
			});

			for (const result of [explicit, placeholder]) {
				expect(result.exitCode).toBe(1);
				expect(result.rawOutput).toContain("LONG-FINDINGS-TAIL-SENTINEL");
			}
			expect(rejectedEnvelope(explicit).data).toEqual(data);
			expect(rejectedEnvelope(placeholder).data).toEqual({ ...data, plan_markdown: placeholderPlanText });
			expect(fallback.exitCode).toBe(0);
			expect(JSON.parse(fallback.rawOutput)).toEqual({ accepted: true });
			expect(fallback.rawOutput).not.toContain("LONG-FINDINGS-TAIL-SENTINEL");
		});

		it("preserves rejected data when a nonempty output schema itself is malformed", () => {
			const data = { tail: "INVALID-SCHEMA-TAIL-SENTINEL", details: "x".repeat(600) };
			const result = finalizeSubprocessOutput({
				rawOutput: "ignored",
				exitCode: 0,
				stderr: "",
				doneAborted: false,
				signalAborted: false,
				yieldItems: [{ status: "success", data }],
				outputSchema: "{",
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("invalid output schema");
			expect(rejectedEnvelope(result).data).toEqual(data);
		});
	});
});
