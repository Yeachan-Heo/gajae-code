import { describe, expect, it } from "bun:test";
import { finalizeSubprocessOutput } from "../../src/task/executor";
import { buildTaskReceipt } from "../../src/task/receipt";
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

	it("passes JTD validation against the reviewer agent's numeric priority schema (#1350)", () => {
		// Mirrors the bundled reviewer agent's output schema. Before the fix the
		// string priority from `report_finding` short-circuited every successful
		// review run with `findings.0.priority: expected number, received string`.
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
					},
				},
			],
			reportFindings: [toReviewFinding({ ...base, priority: "P2" })],
			outputSchema: reviewerSchema,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = JSON.parse(result.rawOutput) as {
			findings: Array<{ priority: number }>;
		};
		expect(parsed.findings[0].priority).toBe(2);
	});

	it("keeps reported findings in the receipt when a closed schema forbids their projection", () => {
		const completion = {
			receipt: "agent://0-Reviewer",
			verdict: "incorrect",
		};
		const reportFinding = { ...base, priority: "P2" as const };
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: completion }],
			reportFindings: [toReviewFinding(reportFinding)],
			outputSchema: {
				type: "object",
				properties: {
					receipt: { type: "string" },
					verdict: { type: "string" },
				},
				required: ["receipt", "verdict"],
				additionalProperties: false,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.rawOutput)).toEqual(completion);
		const receipt = buildTaskReceipt({
			index: 0,
			id: "0-Reviewer",
			agent: "reviewer",
			agentSource: "bundled",
			task: "Review the patch",
			exitCode: result.exitCode,
			output: result.rawOutput,
			stderr: result.stderr,
			truncated: false,
			durationMs: 1,
			tokens: 1,
			extractedToolData: {
				yield: [{ data: completion }],
				report_finding: [reportFinding],
			},
		});
		expect(receipt.review).toMatchObject({
			findingCount: 1,
			findings: [{ severity: "P2", summary: "[P0] Example finding" }],
		});
	});

	it("adds reported findings when no closed output schema constrains the completion", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { verdict: "incorrect" } }],
			reportFindings: [toReviewFinding({ ...base, priority: "P2" })],
			outputSchema: undefined,
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.rawOutput)).toMatchObject({ findings: [{ priority: 2 }] });
	});

	it("reports the original schema violation when neither projection is valid", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { verdict: "incorrect" } }],
			reportFindings: [toReviewFinding({ ...base, priority: "P2" })],
			outputSchema: {
				type: "object",
				properties: { receipt: { type: "string" }, verdict: { type: "string" } },
				required: ["receipt", "verdict"],
				additionalProperties: false,
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("missing required fields: receipt");
		expect(JSON.parse(result.rawOutput)).toMatchObject({ error: "schema_violation", missingRequired: ["receipt"] });
	});
});
