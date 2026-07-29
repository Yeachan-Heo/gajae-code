import { describe, expect, it } from "bun:test";
import { finalizeSubprocessOutput } from "../../src/task/executor";
import { subprocessToolRegistry } from "../../src/task/subprocess-tool-registry";
import { parseReportFindingDetails, toReviewFinding } from "../../src/tools/review";

describe("report_finding subprocess extraction", () => {
	it("returns undefined for malformed finding details", () => {
		expect(parseReportFindingDetails({})).toBeUndefined();
		expect(
			parseReportFindingDetails({
				title: "[P1] Missing file path",
				body: "Body",
				priority: "P1",
				confidence: 0.8,
				line_start: 12,
				line_end: 12,
			}),
		).toBeUndefined();
	});

	it("ignores error events and extracts valid details", () => {
		const handler = subprocessToolRegistry.getHandler("report_finding");
		if (!handler?.extractData) {
			throw new Error("report_finding handler is not registered");
		}

		const validDetails = {
			title: "[P1] Example finding",
			body: "Details",
			priority: "P1" as const,
			confidence: 0.95,
			file_path: "/tmp/example.ts",
			line_start: 10,
			line_end: 12,
		};

		expect(
			handler.extractData({
				toolName: "report_finding",
				toolCallId: "call-1",
				result: {
					content: [{ type: "text", text: "Finding recorded" }],
					details: validDetails,
				},
				isError: false,
			}),
		).toEqual(validDetails);

		expect(
			handler.extractData({
				toolName: "report_finding",
				toolCallId: "call-2",
				result: {
					content: [{ type: "text", text: "Validation failed" }],
					details: {},
				},
				isError: true,
			}),
		).toBeUndefined();
	});
});

describe("toReviewFinding", () => {
	const base = {
		title: "[P0] Example finding",
		body: "Details",
		confidence: 0.95,
		file_path: "/tmp/example.ts",
		line_start: 10,
		line_end: 12,
	} as const;

	it("maps the priority string enum to its numeric ordinal", () => {
		expect(toReviewFinding({ ...base, priority: "P0" }).priority).toBe(0);
		expect(toReviewFinding({ ...base, priority: "P1" }).priority).toBe(1);
		expect(toReviewFinding({ ...base, priority: "P2" }).priority).toBe(2);
		expect(toReviewFinding({ ...base, priority: "P3" }).priority).toBe(3);
	});

	it("supports explicitly caller-owned numeric findings in a declared reviewer schema", () => {
		const reviewerSchema = {
			properties: {
				overall_correctness: { enum: ["correct", "incorrect"] },
				explanation: { type: "string" },
				confidence: { type: "number" },
			},
			optionalProperties: {
				findings: {
					elements: {
						properties: {
							title: { type: "string" },
							body: { type: "string" },
							priority: { type: "number" },
							confidence: { type: "number" },
							file_path: { type: "string" },
							line_start: { type: "number" },
							line_end: { type: "number" },
						},
					},
				},
			},
		};

		const result = finalizeSubprocessOutput({
			rawOutput: "",
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
						findings: [toReviewFinding({ ...base, priority: "P2" })],
					},
				},
			],
			outputSchema: reviewerSchema,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.rawOutput) as {
			findings: Array<{ priority: number }>;
		};
		expect(parsed.findings[0].priority).toBe(2);
	});
});
