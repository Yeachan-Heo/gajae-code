import type { CompletionEvidence, ReceiptEnvelope, ReviewVerdictEvidence } from "./receipts";
import { validateReceipt } from "./receipts";
import { canTransition } from "./state-machine";
import type { HarnessLifecycle, ReceiptFamily, SessionState } from "./types";

export const RECEIPT_DIGEST_MAX_CHARS = 280;

export const RECEIPT_FAMILY_LIFECYCLE_TARGETS: Partial<Record<ReceiptFamily, HarnessLifecycle>> = {
	completion: "completed",
	// Review-only sessions terminate on a valid review verdict rather than a
	// completion receipt; the finalizer treats valid verdicts as terminal.
	"review-verdict": "completed",
};

/**
 * Family-specific evidence consistency: the lifecycle target must agree with
 * what the evidence itself claims. Hash validity alone is not enough — a
 * semantically contradictory receipt must not drive the lifecycle.
 */
function evidenceContradiction(receipt: ReceiptEnvelope<unknown>, target: HarnessLifecycle): string | undefined {
	if (receipt.family === "completion") {
		const evidence = receipt.evidence as CompletionEvidence;
		if (evidence.finalLifecycle !== target) {
			return `evidence-lifecycle-mismatch:${evidence.finalLifecycle}`;
		}
	}
	if (receipt.family === "review-verdict") {
		const evidence = receipt.evidence as ReviewVerdictEvidence;
		// Owner confirmation is not a terminal success verdict.
		if (evidence.verdict === "OWNER_CONFIRMATION_REQUIRED") {
			return "review-verdict-not-terminal";
		}
	}
	return undefined;
}

export interface ReceiptIngestResult {
	accepted: ReceiptEnvelope<unknown>[];
	rejected: { receipt: ReceiptEnvelope<unknown>; reasons: string[] }[];
	transitions: { from: HarnessLifecycle; to: HarnessLifecycle; receiptId: string }[];
	finalLifecycle: HarnessLifecycle;
	digest: string;
}

export function ingestReceipts(
	state: SessionState,
	receipts: readonly ReceiptEnvelope<unknown>[],
): ReceiptIngestResult {
	let lifecycle = state.lifecycle;
	const accepted: ReceiptEnvelope<unknown>[] = [];
	const rejected: { receipt: ReceiptEnvelope<unknown>; reasons: string[] }[] = [];
	const transitions: { from: HarnessLifecycle; to: HarnessLifecycle; receiptId: string }[] = [];

	for (const receipt of receipts) {
		const validation = validateReceipt(receipt);
		if (!validation.valid) {
			rejected.push({ receipt, reasons: validation.reasons });
			continue;
		}

		// Fail closed on receipts the envelope itself marks invalid: the hash
		// can be self-consistent while the issuer recorded the receipt as not
		// proving its claim.
		if (receipt.valid !== true) {
			rejected.push({ receipt, reasons: ["receipt-marked-invalid"] });
			continue;
		}

		// Fail closed on cross-session receipts: a self-consistent receipt from
		// another session must never drive this session's lifecycle.
		if (receipt.sessionId !== state.sessionId) {
			rejected.push({ receipt, reasons: [`session-mismatch:${receipt.sessionId}`] });
			continue;
		}

		const target = RECEIPT_FAMILY_LIFECYCLE_TARGETS[receipt.family];
		if (target) {
			// Non-terminal review verdicts (OWNER_CONFIRMATION_REQUIRED) are
			// valid receipts but do not complete the session: accept, no move.
			if (receipt.family === "review-verdict" && evidenceContradiction(receipt, target) !== undefined) {
				accepted.push(receipt);
				continue;
			}
			// Other contradictions (e.g. completion evidence whose
			// finalLifecycle disagrees with the target) reject fail-closed.
			const contradiction = evidenceContradiction(receipt, target);
			if (contradiction !== undefined) {
				rejected.push({ receipt, reasons: [contradiction] });
				continue;
			}
			if (!canTransition(lifecycle, target)) {
				rejected.push({ receipt, reasons: [`illegal-transition:${lifecycle}->${target}`] });
				continue;
			}

			transitions.push({ from: lifecycle, to: target, receiptId: receipt.receiptId });
			lifecycle = target;
		}

		accepted.push(receipt);
	}

	return {
		accepted,
		rejected,
		transitions,
		finalLifecycle: lifecycle,
		digest: buildReceiptIngestDigest(receipts.length, accepted.length, rejected, state.lifecycle, lifecycle),
	};
}

function buildReceiptIngestDigest(
	total: number,
	acceptedCount: number,
	rejected: readonly { receipt: ReceiptEnvelope<unknown>; reasons: readonly string[] }[],
	initialLifecycle: HarnessLifecycle,
	finalLifecycle: HarnessLifecycle,
): string {
	let digest = `ingested ${total} receipts: ${acceptedCount} accepted, ${rejected.length} rejected; lifecycle ${initialLifecycle}->${finalLifecycle}`;
	if (rejected.length > 0) {
		const rejectedSummary = rejected
			.map(item => `${item.receipt?.receiptId ?? "<malformed>"}(${item.reasons.join("|")})`)
			.join(",");
		digest += `; rejected: ${rejectedSummary}`;
	}
	return digest.slice(0, RECEIPT_DIGEST_MAX_CHARS);
}
