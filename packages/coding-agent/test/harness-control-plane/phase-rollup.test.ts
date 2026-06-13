import { describe, expect, it } from "bun:test";
import { buildPhaseRollupReceipt } from "../../src/harness-control-plane/phase-rollup";
import {
	buildReceipt,
	type PhaseRollupEvidence,
	type ReceiptSubject,
	sha256Hex,
	validateReceipt,
} from "../../src/harness-control-plane/receipts";
import type { TaskResultReceipt } from "../../src/task/receipt";
import { assertNoRawTaskFields } from "../../src/task/receipt";

const subject: ReceiptSubject = { workspace: "/ws", branch: "feat/x", head: "abc", commit: "abc" };

function childReceipt(over: Partial<TaskResultReceipt> = {}): TaskResultReceipt {
	return {
		index: 0,
		id: "0-Child",
		agent: "executor",
		agentSource: "bundled" as TaskResultReceipt["agentSource"],
		task: "do thing",
		status: "completed",
		exitCode: 0,
		truncated: false,
		durationMs: 1000,
		tokens: 5000,
		preview: "Task completed; output stored in agent://0-Child (10 lines, 100 bytes).",
		previewTruncated: false,
		outputRef: { uri: "agent://0-Child", sizeBytes: 100, lineCount: 10, sha256: sha256Hex("output") },
		roi: {
			tokens: 5000,
			costTotal: 0.01,
			producedChanges: true,
			materialContribution: true,
			lowRoi: false,
		},
		...over,
	};
}

function rollup(children: TaskResultReceipt[], over: Partial<Parameters<typeof buildPhaseRollupReceipt>[0]> = {}) {
	return buildPhaseRollupReceipt({
		receiptId: "pr-1",
		sessionId: "s",
		source: "test",
		subject,
		phase: "implementation",
		children,
		createdAt: "2026-01-01T00:00:00.000Z",
		...over,
	});
}

describe("phase-rollup: builder", () => {
	it("builds a valid hash-sealed rollup from child receipts", () => {
		const r = rollup([childReceipt(), childReceipt({ id: "1-Child", index: 1, status: "failed", exitCode: 1 })]);
		const outcome = validateReceipt(r);
		expect(outcome.valid).toBe(true);
		expect(r.family).toBe("phase-rollup");
		expect(r.evidence.aggregate.childCount).toBe(2);
		expect(r.evidence.aggregate.completed).toBe(1);
		expect(r.evidence.aggregate.failed).toBe(1);
		expect(r.evidence.aggregate.totalTokens).toBe(10_000);
		expect(r.evidence.children[0]?.outputUri).toBe("agent://0-Child");
		expect(r.evidence.children[0]?.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is deterministic: same input yields the same sha256", () => {
		const children = [childReceipt(), childReceipt({ id: "1-Child", index: 1 })];
		expect(rollup(children).sha256).toBe(rollup(children).sha256);
	});

	it("hashes children identically whether optional fields are undefined or absent (JSON round-trip)", () => {
		const inMemory = childReceipt({ assignment: undefined, description: undefined });
		const rehydrated = JSON.parse(JSON.stringify(inMemory)) as typeof inMemory;
		const a = rollup([inMemory]).evidence.children[0]?.receiptSha256;
		const b = rollup([rehydrated]).evidence.children[0]?.receiptSha256;
		expect(a).toBe(b);
	});

	it("aggregates ROI: lowRoi ids, cost, cloned tokens; nulls when absent", () => {
		const low = childReceipt({
			id: "2-Low",
			roi: { tokens: 100, producedChanges: false, materialContribution: false, lowRoi: true },
		});
		const r = rollup([childReceipt(), low]);
		expect(r.evidence.aggregate.lowRoiChildIds).toEqual(["2-Low"]);
		expect(r.evidence.aggregate.totalCostTotal).toBeCloseTo(0.01);
		expect(r.evidence.aggregate.totalClonedTokens).toBeNull();
	});

	it("merge_failed counts as failed in the aggregate", () => {
		const r = rollup([childReceipt({ status: "merge_failed" })]);
		expect(r.evidence.aggregate.failed).toBe(1);
	});

	it("passes the raw-task leak firewall", () => {
		const r = rollup([childReceipt()]);
		expect(() => assertNoRawTaskFields(r, "phase-rollup")).not.toThrow();
	});
});

describe("phase-rollup: fail-closed validation", () => {
	function rawRollup(evidence: PhaseRollupEvidence) {
		return buildReceipt<PhaseRollupEvidence>({
			receiptId: "pr-x",
			sessionId: "s",
			family: "phase-rollup",
			source: "test",
			subject,
			evidence,
		});
	}

	it("rejects empty children", () => {
		const r = rawRollup({
			phase: "implementation",
			children: [],
			aggregate: {
				childCount: 0,
				completed: 0,
				failed: 0,
				totalTokens: 0,
				totalCostTotal: null,
				totalClonedTokens: null,
				lowRoiChildIds: [],
			},
		});
		const outcome = validateReceipt(r);
		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("phase-rollup-empty-children");
	});

	it("rejects missing phase", () => {
		const r = rawRollup({
			phase: "",
			children: [],
			aggregate: {
				childCount: 0,
				completed: 0,
				failed: 0,
				totalTokens: 0,
				totalCostTotal: null,
				totalClonedTokens: null,
				lowRoiChildIds: [],
			},
		});
		expect(validateReceipt(r).reasons).toContain("phase-rollup-missing-phase");
	});

	it("rejects malformed child pointers (missing id, bad hashes)", () => {
		const good = rollup([childReceipt()]).evidence.children[0]!;
		const r = rawRollup({
			phase: "implementation",
			children: [
				{ ...good, id: "" },
				{ ...good, id: "bad-hash", receiptSha256: "not-a-hash" },
				{ ...good, id: "bad-output", outputSha256: "xyz" },
			],
			aggregate: {
				childCount: 3,
				completed: 3,
				failed: 0,
				totalTokens: 0,
				totalCostTotal: null,
				totalClonedTokens: null,
				lowRoiChildIds: [],
			},
		});
		const outcome = validateReceipt(r);
		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("phase-rollup-child-missing-id");
		expect(outcome.reasons).toContain("phase-rollup-child-bad-receipt-hash:bad-hash");
		expect(outcome.reasons).toContain("phase-rollup-child-bad-output-hash:bad-output");
	});

	it("rejects aggregate child-count mismatch", () => {
		const good = rollup([childReceipt()]).evidence.children[0]!;
		const r = rawRollup({
			phase: "implementation",
			children: [good],
			aggregate: {
				childCount: 5,
				completed: 1,
				failed: 0,
				totalTokens: 0,
				totalCostTotal: null,
				totalClonedTokens: null,
				lowRoiChildIds: [],
			},
		});
		expect(validateReceipt(r).reasons).toContain("phase-rollup-child-count-mismatch");
	});

	it("fails closed on post-hash tampering", () => {
		const r = rollup([childReceipt()]);
		r.evidence.aggregate.failed = 99;
		const outcome = validateReceipt(r);
		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("hash-mismatch");
	});
});
