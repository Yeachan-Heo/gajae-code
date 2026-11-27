import { sanitizePromptFailure } from "./prompt-failure";
import type { TurnResultPage } from "./turn-result";

type AdmissionKind = "prompt" | "skill";
type Correlation = { commandId: string; turnId: string };
type Selector = { commandId?: string; turnId?: string; clientRef?: string };
type Admission = { kind: AdmissionKind; clientRef: string; correlation: Correlation };
type RejectedAdmission = Admission & { rejectedAt: number; error: { code: string; message: string } };

/** Rejections retained per host; enough for every reservation the active capacity allows. */
const REJECTED_ADMISSION_CAPACITY = 256;

const REJECTED_ADMISSION_MESSAGE =
	"The submission was rejected before it was accepted. It never ran and was not recorded in the transcript; " +
	"submit it again.";

/**
 * Makes a client-referenced submission observable between admission and acceptance.
 *
 * A host acknowledges `turn.prompt` only after AgentSession preflight succeeds,
 * and preflight can include a pre-prompt compaction that runs for minutes. A
 * client whose acknowledgement budget expires meanwhile has nothing but its own
 * `clientRef` to reconcile with. Without this ledger `turn.result` answered
 * `unknown` for the whole preflight, so a client could not tell an in-progress
 * submission from a lost one (#7867). The ledger reports `admitted` (with the
 * generated correlation) while preflight runs. Pre-acceptance rejections are not
 * recorded; the clientRef is released so the client can retry (#7872).
 */
export class PreflightAdmissionLedger {
	readonly #pending = new Map<string, Admission>();
	readonly #rejected = new Map<string, RejectedAdmission>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Records the correlation the host generated for an admitted, not yet accepted submission. */
	admitted(kind: AdmissionKind, clientRef: string | undefined, correlation: Correlation): void {
		if (clientRef === undefined) return;
		const key = admissionKey(kind, clientRef);
		this.#rejected.delete(key);
		this.#pending.set(key, { kind, clientRef, correlation: { ...correlation } });
	}

	/** Ends preflight observation. Accepted submissions are reported by the durable record. */
	accepted(kind: AdmissionKind, clientRef: string | undefined): void {
		if (clientRef !== undefined) this.#pending.delete(admissionKey(kind, clientRef));
	}

	/**
	 * Records or discards a pre-acceptance rejection based on error semantics.
	 *
	 * Pre-acceptance validation errors (like model_not_selected) are released from
	 * pending without recording. These "refusals" never entered meaningful preflight
	 * and should allow the same clientRef to be re-submitted immediately.
	 *
	 * Other preflight errors are recorded as definite rejections so clients can
	 * learn that the submission never ran (even if acknowledgement was lost).
	 */
	rejected(kind: AdmissionKind, clientRef: string | undefined, cause: unknown): void {
		if (clientRef === undefined) return;
		const key = admissionKey(kind, clientRef);
		const admission = this.#pending.get(key);
		if (!admission) return;
		this.#pending.delete(key);

		// Pre-acceptance validation refusals (model_not_selected, etc.) are not
		// recorded, allowing clientRef reuse. Other preflight failures are recorded
		// to satisfy clients who lost their acknowledgement.
		const sanitized = sanitizePromptFailure(cause);
		if (sanitized.code === "model_not_selected") return;

		this.#rejected.set(key, {
			...admission,
			rejectedAt: this.#now(),
			error: { code: sanitized.code, message: REJECTED_ADMISSION_MESSAGE },
		});
		while (this.#rejected.size > REJECTED_ADMISSION_CAPACITY)
			this.#rejected.delete(this.#rejected.keys().next().value!);
	}

	/** The `turn.result` page for a submission without a durable record, if this ledger knows it. */
	lookup(kind: AdmissionKind, selector: Selector): TurnResultPage | undefined {
		const pending = this.#find(this.#pending, kind, selector);
		if (pending)
			return {
				status: "admitted",
				kind,
				clientRef: pending.clientRef,
				...pending.correlation,
				receiptState: "absent",
			};
		const rejected = this.#find(this.#rejected, kind, selector);
		if (!rejected) return undefined;
		return {
			status: "failed",
			kind,
			clientRef: rejected.clientRef,
			...rejected.correlation,
			terminalAt: rejected.rejectedAt,
			receiptState: "missing",
			error: { ...rejected.error },
		};
	}

	#find<T extends Admission>(entries: Map<string, T>, kind: AdmissionKind, selector: Selector): T | undefined {
		if (selector.clientRef !== undefined) return entries.get(admissionKey(kind, selector.clientRef));
		if (selector.commandId === undefined || selector.turnId === undefined) return undefined;
		for (const entry of entries.values())
			if (
				entry.kind === kind &&
				entry.correlation.commandId === selector.commandId &&
				entry.correlation.turnId === selector.turnId
			)
				return entry;
		return undefined;
	}
}

function admissionKey(kind: AdmissionKind, clientRef: string): string {
	return `${kind}\0${clientRef}`;
}
