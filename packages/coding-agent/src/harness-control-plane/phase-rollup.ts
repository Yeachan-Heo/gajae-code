/**
 * Phase-boundary receipt rollup builder (receipt-of-receipts).
 *
 * At a harness lifecycle boundary, N child task receipts can be superseded by a
 * single `phase-rollup` receipt that preserves per-child pointers (id, status,
 * outputRef, sha256) plus aggregate ROI totals. The rollup is hash-sealed via
 * the standard receipt envelope and validated fail-closed like every other
 * family (see `validatePhaseRollup` in receipts.ts). Pure builder — no runtime
 * injection behavior is changed here.
 */
import type { TaskResultReceipt } from "../task/receipt";
import {
	type BuildReceiptInput,
	buildReceipt,
	canonicalJson,
	type PhaseRollupChildPointer,
	type PhaseRollupEvidence,
	type ReceiptEnvelope,
	sha256Hex,
} from "./receipts";

function childPointer(receipt: TaskResultReceipt): PhaseRollupChildPointer {
	return {
		id: receipt.id,
		status: receipt.status,
		outputUri: receipt.outputRef?.uri ?? null,
		outputSha256: receipt.outputRef?.sha256 ?? null,
		// Normalize through JSON first: in-memory task receipts carry optional
		// fields with value `undefined`, which canonicalJson would hash as
		// `null` while persisted/parsed receipts omit those keys entirely.
		// JSON round-tripping drops undefined-valued keys so the hash is
		// identical for in-memory and rehydrated copies of the same receipt.
		receiptSha256: sha256Hex(canonicalJson(JSON.parse(JSON.stringify(receipt)))),
	};
}

export interface BuildPhaseRollupInput {
	receiptId: string;
	sessionId: string;
	source: string;
	subject: BuildReceiptInput<PhaseRollupEvidence>["subject"];
	phase: string;
	children: readonly TaskResultReceipt[];
	/** Supply for deterministic output; defaults to now. */
	createdAt?: string;
}

export function buildPhaseRollupReceipt(input: BuildPhaseRollupInput): ReceiptEnvelope<PhaseRollupEvidence> {
	const totalCostTotal = input.children.reduce((total, child) => total + (child.roi?.costTotal ?? 0), 0);
	const totalClonedTokens = input.children.reduce((total, child) => total + (child.roi?.clonedTokens ?? 0), 0);
	const evidence: PhaseRollupEvidence = {
		phase: input.phase,
		children: input.children.map(childPointer),
		aggregate: {
			childCount: input.children.length,
			completed: input.children.filter(child => child.status === "completed").length,
			failed: input.children.filter(child => child.status === "failed" || child.status === "merge_failed").length,
			totalTokens: input.children.reduce((total, child) => total + (child.roi?.tokens ?? child.tokens), 0),
			totalCostTotal: totalCostTotal > 0 ? totalCostTotal : null,
			totalClonedTokens: totalClonedTokens > 0 ? totalClonedTokens : null,
			lowRoiChildIds: input.children.filter(child => child.roi?.lowRoi).map(child => child.id),
		},
	};
	return buildReceipt({
		receiptId: input.receiptId,
		sessionId: input.sessionId,
		family: "phase-rollup",
		source: input.source,
		subject: input.subject,
		evidence,
		createdAt: input.createdAt,
	});
}
