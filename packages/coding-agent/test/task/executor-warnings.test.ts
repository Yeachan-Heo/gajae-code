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
});
