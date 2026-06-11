import type { ReceiptEnvelope } from "./receipts";
import { validateReceipt } from "./receipts";
import { canTransition } from "./state-machine";
import type { HarnessLifecycle, ReceiptFamily, SessionState } from "./types";

export const RECEIPT_DIGEST_MAX_CHARS = 280;

export const RECEIPT_FAMILY_LIFECYCLE_TARGETS: Partial<Record<ReceiptFamily, HarnessLifecycle>> = {
	completion: "completed",
};

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
		const rejectedSummary = rejected.map(item => `${item.receipt.receiptId}(${item.reasons.join("|")})`).join(",");
		digest += `; rejected: ${rejectedSummary}`;
	}
	return digest.slice(0, RECEIPT_DIGEST_MAX_CHARS);
}
