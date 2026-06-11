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
	const ref = receipt.outputRef;
	// Receipt-of-receipts integrity requires BOTH a pointer URI and its content
	// hash. A URI without a verifiable hash cannot be integrity-checked, so we
	// drop the (one-sided) pointer entirely rather than emit an unverifiable ref
	// that the fail-closed validator would reject.
	const hasVerifiableRef = Boolean(ref?.uri) && Boolean(ref?.sha256);
	return {
		id: receipt.id,
		status: receipt.status,
		outputUri: hasVerifiableRef ? (ref?.uri ?? null) : null,
		outputSha256: hasVerifiableRef ? (ref?.sha256 ?? null) : null,
		// Normalize through JSON first: in-memory task receipts carry optional
		// fields with value `undefined`, which canonicalJson would hash as
		// `null` while persisted/parsed receipts omit those keys entirely.
		// JSON round-tripping drops undefined-valued keys so the hash is
		// identical for in-memory and rehydrated copies of the same receipt.
		receiptSha256: sha256Hex(canonicalJson(JSON.parse(JSON.stringify(receipt)))),
		// Per-child ROI accounting so the rollup aggregate is recomputable from
		// child evidence (see validatePhaseRollup). `tokens` falls back to the
		// receipt's raw token count when no ROI proxy is present.
		tokens: receipt.roi?.tokens ?? receipt.tokens,
		costTotal: receipt.roi?.costTotal ?? null,
		clonedTokens: receipt.roi?.clonedTokens ?? null,
		lowRoi: receipt.roi?.lowRoi ?? false,
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
	// `null` means "no child reported this metric" — the canonical value the
	// fail-closed validator reconciles against. Decide presence from whether a
	// child carried the field at all (not from a >0 sum), so a legitimate
	// all-zero total reconciles instead of collapsing to null and mismatching.
	const anyCost = input.children.some(child => (child.roi?.costTotal ?? null) !== null);
	const anyCloned = input.children.some(child => (child.roi?.clonedTokens ?? null) !== null);
	const totalCostTotal = anyCost
		? input.children.reduce((total, child) => total + (child.roi?.costTotal ?? 0), 0)
		: null;
	const totalClonedTokens = anyCloned
		? input.children.reduce((total, child) => total + (child.roi?.clonedTokens ?? 0), 0)
		: null;
	const evidence: PhaseRollupEvidence = {
		phase: input.phase,
		children: input.children.map(childPointer),
		aggregate: {
			childCount: input.children.length,
			completed: input.children.filter(child => child.status === "completed").length,
			failed: input.children.filter(child => child.status === "failed" || child.status === "merge_failed").length,
			totalTokens: input.children.reduce((total, child) => total + (child.roi?.tokens ?? child.tokens), 0),
			totalCostTotal,
			totalClonedTokens,
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
