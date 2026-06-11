import { describe, expect, it } from "bun:test";
import { buildPhaseRollupReceipt } from "../../src/harness-control-plane/phase-rollup";
import {
	buildReceipt,
	type PhaseRollupEvidence,
	type ReceiptEnvelope,
	type ReceiptSubject,
	sha256Hex,
	validateReceipt,
} from "../../src/harness-control-plane/receipts";
import type { TaskResultReceipt } from "../../src/task/receipt";

const subject: ReceiptSubject = { workspace: "/ws", branch: "feat/x", head: "abc", commit: "abc" };
const createdAt = "2026-01-01T00:00:00.000Z";

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

function rollup(children: TaskResultReceipt[]) {
	return buildPhaseRollupReceipt({
		receiptId: "pr-1",
		sessionId: "s",
		source: "test",
		subject,
		phase: "implementation",
		children,
		createdAt,
	});
}

function rawRollup(evidence: PhaseRollupEvidence): ReceiptEnvelope<PhaseRollupEvidence> {
	return buildReceipt<PhaseRollupEvidence>({
		receiptId: "pr-x",
		sessionId: "s",
		family: "phase-rollup",
		source: "test",
		subject,
		evidence,
		createdAt,
	});
}

describe("phase-rollup red-team", () => {
	it("hashes unicode and huge child strings deterministically", () => {
		const hugeUnicode = `${"雪🙂".repeat(10_000)}\nterminal transcript with combining marks e\u0301`;
		const child = childReceipt({
			id: "unicode-Child",
			task: hugeUnicode,
			preview: hugeUnicode,
			outputRef: {
				uri: "agent://unicode-Child",
				sizeBytes: Buffer.byteLength(hugeUnicode, "utf8"),
				lineCount: 2,
				sha256: sha256Hex(hugeUnicode),
			},
		});

		const first = rollup([child]);
		const second = rollup([child]);

		expect(first.sha256).toBe(second.sha256);
		expect(first.evidence.children[0]?.receiptSha256).toBe(second.evidence.children[0]?.receiptSha256);
		expect(validateReceipt(first).valid).toBe(true);
	});

	it("rejects duplicate child ids (ambiguous identity in a receipt-of-receipts)", () => {
		const duplicateA = childReceipt({ id: "dup", index: 0 });
		const duplicateB = childReceipt({ id: "dup", index: 1, tokens: 7000, roi: undefined });
		const r = rollup([duplicateA, duplicateB]);
		const outcome = validateReceipt(r);

		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("phase-rollup-duplicate-child-id:dup");
	});

	it("does not let extra unknown evidence fields bypass hash checking after tamper", () => {
		const r = rollup([childReceipt()]) as ReceiptEnvelope<PhaseRollupEvidence & { extra?: Record<string, unknown> }>;
		r.evidence.extra = { attacker: "field", nested: { ok: true } };

		const outcome = validateReceipt(r);
		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("hash-mismatch");
	});

	it("fails closed when family is phase-rollup but evidence has a different family shape", () => {
		const wrongShape = buildReceipt({
			receiptId: "wrong-shape",
			sessionId: "s",
			family: "phase-rollup",
			source: "test",
			subject,
			evidence: {
				command: "bun test",
				exactCommand: "bun test",
				cwd: "/ws",
				exitStatus: 0,
				pass: true,
				commitUnderTest: null,
			},
			createdAt,
		});

		const outcome = validateReceipt(wrongShape);
		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("phase-rollup-missing-phase");
	});

	it("rejects uppercase outputSha256 hex", () => {
		const good = rollup([childReceipt()]).evidence.children[0]!;
		const r = rawRollup({
			phase: "implementation",
			children: [{ ...good, id: "upper", outputSha256: sha256Hex("output").toUpperCase() }],
			aggregate: {
				childCount: 1,
				completed: 1,
				failed: 0,
				totalTokens: 5000,
				totalCostTotal: null,
				totalClonedTokens: null,
				lowRoiChildIds: [],
			},
		});

		const outcome = validateReceipt(r);
		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("phase-rollup-child-bad-output-hash:upper");
	});

	it("rejects lying aggregate: completed+failed counts must match child statuses", () => {
		const good = rollup([childReceipt()]).evidence.children[0]!;
		const r = rawRollup({
			phase: "implementation",
			children: [good],
			aggregate: {
				childCount: 1,
				completed: 1,
				failed: 1,
				totalTokens: 5000,
				totalCostTotal: null,
				totalClonedTokens: null,
				lowRoiChildIds: [],
			},
		});
		const outcome = validateReceipt(r);

		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("phase-rollup-aggregate-failed-mismatch");
	});
	it("rejects a one-sided outputUri without its content hash (unverifiable pointer)", () => {
		const good = rollup([childReceipt()]).evidence.children[0]!;
		const r = rawRollup({
			phase: "implementation",
			children: [{ ...good, id: "uri-only", outputUri: "agent://uri-only", outputSha256: null }],
			aggregate: {
				childCount: 1,
				completed: 1,
				failed: 0,
				totalTokens: 5000,
				totalCostTotal: 0.01,
				totalClonedTokens: null,
				lowRoiChildIds: [],
			},
		});
		const outcome = validateReceipt(r);
		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("phase-rollup-child-orphan-output-uri:uri-only");
	});

	it("rejects a one-sided outputSha256 without its anchoring uri (unanchored hash)", () => {
		const good = rollup([childReceipt()]).evidence.children[0]!;
		const r = rawRollup({
			phase: "implementation",
			children: [{ ...good, id: "hash-only", outputUri: null, outputSha256: sha256Hex("output") }],
			aggregate: {
				childCount: 1,
				completed: 1,
				failed: 0,
				totalTokens: 5000,
				totalCostTotal: 0.01,
				totalClonedTokens: null,
				lowRoiChildIds: [],
			},
		});
		const outcome = validateReceipt(r);
		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("phase-rollup-child-orphan-output-hash:hash-only");
	});

	it("rejects a self-reported totalTokens that does not match summed child evidence", () => {
		const good = rollup([childReceipt()]).evidence.children[0]!;
		const r = rawRollup({
			phase: "implementation",
			children: [good],
			aggregate: {
				childCount: 1,
				completed: 1,
				failed: 0,
				totalTokens: 9999,
				totalCostTotal: 0.01,
				totalClonedTokens: null,
				lowRoiChildIds: [],
			},
		});
		const outcome = validateReceipt(r);
		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("phase-rollup-aggregate-tokens-mismatch");
	});

	it("rejects a self-reported totalCostTotal that does not reconcile with child cost", () => {
		const good = rollup([childReceipt()]).evidence.children[0]!;
		const r = rawRollup({
			phase: "implementation",
			children: [good],
			aggregate: {
				childCount: 1,
				completed: 1,
				failed: 0,
				totalTokens: 5000,
				totalCostTotal: 0.02,
				totalClonedTokens: null,
				lowRoiChildIds: [],
			},
		});
		const outcome = validateReceipt(r);
		expect(outcome.valid).toBe(false);
		expect(outcome.reasons).toContain("phase-rollup-aggregate-cost-mismatch");
	});

	it("builds a valid rollup for all-zero reported cost/cloned children (builder and validator agree)", () => {
		const zeroChild = childReceipt({
			id: "zero-roi",
			roi: {
				tokens: 5000,
				costTotal: 0,
				clonedTokens: 0,
				producedChanges: true,
				materialContribution: true,
				lowRoi: false,
			},
		});
		const r = rollup([zeroChild]);
		expect(r.evidence.aggregate.totalCostTotal).toBe(0);
		expect(r.evidence.aggregate.totalClonedTokens).toBe(0);
		expect(validateReceipt(r).valid).toBe(true);
	});
});
