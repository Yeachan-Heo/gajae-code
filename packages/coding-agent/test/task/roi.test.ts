import { describe, expect, it } from "bun:test";
import { buildTaskReceipt, buildTaskRoi, buildTaskRoiSummary, findRawTaskLeakKeys } from "../../src/task/receipt";
import type { SingleResult } from "../../src/task/types";

const CANONICAL_USAGE = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
};

function makeRaw(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "0-Test",
		agent: "executor",
		agentSource: "bundled",
		task: "do work",
		assignment: "assignment",
		description: "description",
		exitCode: 0,
		output: "useful output",
		stderr: "",
		truncated: false,
		durationMs: 10,
		tokens: 20,
		...overrides,
	};
}

describe("task ROI", () => {
	it("marks output plus changes as material contribution", () => {
		const roi = buildTaskRoi(
			makeRaw({
				patchPath: "/tmp/0-Test.patch",
				outputMeta: { lineCount: 1, charCount: 13, byteSize: 13 },
				usage: CANONICAL_USAGE,
			}),
		);

		expect(roi).toMatchObject({
			tokens: 20,
			costTotal: 0.1,
			outputBytes: 13,
			outputLines: 1,
			producedChanges: true,
			materialContribution: true,
			lowRoi: false,
		});
	});

	it("marks a completed token-spending child with zero output and no changes as low ROI", () => {
		const roi = buildTaskRoi(
			makeRaw({
				output: "",
				stderr: "",
				outputMeta: { lineCount: 0, charCount: 0, byteSize: 0 },
				tokens: 5,
			}),
		);

		expect(roi.producedChanges).toBe(false);
		expect(roi.materialContribution).toBe(false);
		expect(roi.lowRoi).toBe(true);
	});

	it("treats failed terminal children that spent tokens and produced nothing as low ROI", () => {
		const roi = buildTaskRoi(
			makeRaw({
				exitCode: 1,
				output: "",
				stderr: "",
				outputMeta: { lineCount: 0, charCount: 0, byteSize: 0 },
				tokens: 7,
			}),
		);

		expect(roi.materialContribution).toBe(false);
		expect(roi.lowRoi).toBe(true);
	});

	it("includes cloned tokens from fork context", () => {
		const roi = buildTaskRoi(makeRaw({ forkContext: { mode: "bounded", clonedTokens: 42 } }));

		expect(roi.clonedTokens).toBe(42);
	});

	it("keeps receipt ROI numeric/boolean and raw-leak safe", () => {
		const receipt = buildTaskReceipt(
			makeRaw({
				forkContext: { mode: "bounded", clonedTokens: 42 },
				outputMeta: { lineCount: 1, charCount: 13, byteSize: 13 },
				usage: CANONICAL_USAGE,
			}),
		);

		expect(receipt.roi).toEqual({
			tokens: 20,
			clonedTokens: 42,
			costTotal: 0.1,
			outputBytes: 13,
			outputLines: 1,
			producedChanges: false,
			materialContribution: true,
			lowRoi: false,
		});
		expect(findRawTaskLeakKeys(receipt)).toEqual([]);
	});

	it("aggregates low ROI child ids", () => {
		const productive = buildTaskReceipt(makeRaw({ id: "0-Productive" }));
		const low = buildTaskReceipt(
			makeRaw({
				id: "1-Low",
				output: "",
				stderr: "",
				outputMeta: { lineCount: 0, charCount: 0, byteSize: 0 },
				tokens: 5,
				forkContext: { mode: "receipt", clonedTokens: 3 },
			}),
		);

		expect(buildTaskRoiSummary([productive, low])).toEqual({
			childCount: 2,
			totalTokens: 25,
			totalClonedTokens: 3,
			lowRoiChildIds: ["1-Low"],
		});
	});
});
