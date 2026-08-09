import { isProcessIncarnation } from "../broker/process-incarnation";

export const ELEVATION_RECEIPT_VERSION = 1;

/**
 * Identity of the broker tenure that claims a grant and dispatches it.
 *
 * `ownerId` is the broker instance owner id and `epoch` increments per broker
 * start, so a restart (even of the same object) yields a new tenure. `pid` and
 * `incarnation` are retained for truthful tri-state liveness replay.
 */
export interface ElevationClaimIdentity {
	ownerId: string;
	epoch: number;
	pid: number;
	incarnation: string;
}

export type ElevationReceiptState = "claimed" | "dispatched" | "uncertain";

/**
 * Durable dispatch outcome. `unknown` is the crash truth: the grant was
 * consumed by a claim but the dispatch outcome is not knowable, so retry
 * requires a new grant.
 */
export type ElevationDispatchOutcome =
	| { status: "ok"; dispatchedAt: number }
	| { status: "failed"; code: string; message: string; dispatchedAt: number }
	| { status: "unknown"; message: string; dispatchedAt: number };

/**
 * Owner/epoch-bound dispatch receipt.
 *
 * State machine: `claimed` (grant spent, dispatch in flight, bound to the
 * claiming broker tenure) -> `dispatched` (terminal, outcome recorded) or
 * `uncertain` (terminal truth: the claim's outcome is unknowable after its
 * broker tenure died). Replay never fabricates an outcome: a receipt left in
 * `claimed` by a dead tenure is truthfully terminalized to `uncertain`.
 */
export interface ElevationDispatchReceipt {
	version: typeof ELEVATION_RECEIPT_VERSION;
	elevationRequestId: string;
	issueIndex: number;
	state: ElevationReceiptState;
	claim: ElevationClaimIdentity & { claimedAt: number };
	dispatch?: { ownerId: string; epoch: number; dispatchedAt: number };
	outcome?: ElevationDispatchOutcome;
	ts: number;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isElevationRequestId(value: unknown): value is string {
	return typeof value === "string" && UUID_V4.test(value);
}

export function isElevationClaimIdentity(value: unknown): value is ElevationClaimIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const identity = value as { ownerId?: unknown; epoch?: unknown; pid?: unknown; incarnation?: unknown };
	return (
		typeof identity.ownerId === "string" &&
		identity.ownerId.length > 0 &&
		Number.isSafeInteger(identity.epoch) &&
		(identity.epoch as number) > 0 &&
		Number.isSafeInteger(identity.pid) &&
		(identity.pid as number) > 0 &&
		isProcessIncarnation(identity.incarnation)
	);
}

export function isElevationDispatchOutcome(value: unknown): value is ElevationDispatchOutcome {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const outcome = value as { status?: unknown; code?: unknown; message?: unknown; dispatchedAt?: unknown };
	if (!Number.isSafeInteger(outcome.dispatchedAt) || (outcome.dispatchedAt as number) <= 0) return false;
	if (outcome.status === "ok") return true;
	if (outcome.status === "unknown") return typeof outcome.message === "string";
	if (outcome.status === "failed")
		return typeof outcome.code === "string" && outcome.code.length > 0 && typeof outcome.message === "string";
	return false;
}

export function isElevationDispatchReceipt(value: unknown): value is ElevationDispatchReceipt {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const receipt = value as Partial<ElevationDispatchReceipt>;
	if (
		receipt.version !== ELEVATION_RECEIPT_VERSION ||
		!isElevationRequestId(receipt.elevationRequestId) ||
		!Number.isSafeInteger(receipt.issueIndex) ||
		(receipt.issueIndex as number) <= 0 ||
		(receipt.state !== "claimed" && receipt.state !== "dispatched" && receipt.state !== "uncertain") ||
		!isElevationClaimIdentity(receipt.claim) ||
		!Number.isSafeInteger(receipt.claim.claimedAt) ||
		(receipt.claim.claimedAt as number) <= 0 ||
		!Number.isSafeInteger(receipt.ts) ||
		(receipt.ts as number) <= 0
	)
		return false;
	if (receipt.state === "claimed") return receipt.dispatch === undefined && receipt.outcome === undefined;
	if (receipt.state === "uncertain") {
		const outcome = receipt.outcome;
		return receipt.dispatch === undefined && isElevationDispatchOutcome(outcome) && outcome.status === "unknown";
	}
	const dispatch = receipt.dispatch;
	if (dispatch === undefined) return false;
	return (
		typeof dispatch.ownerId === "string" &&
		dispatch.ownerId.length > 0 &&
		Number.isSafeInteger(dispatch.epoch) &&
		dispatch.epoch > 0 &&
		Number.isSafeInteger(dispatch.dispatchedAt) &&
		dispatch.dispatchedAt > 0 &&
		isElevationDispatchOutcome(receipt.outcome) &&
		receipt.outcome.status !== "unknown"
	);
}

export function claimReceipt(
	requestId: string,
	issueIndex: number,
	claim: ElevationClaimIdentity,
	claimedAt: number,
): ElevationDispatchReceipt {
	return {
		version: ELEVATION_RECEIPT_VERSION,
		elevationRequestId: requestId,
		issueIndex,
		state: "claimed",
		claim: { ...claim, claimedAt },
		ts: claimedAt,
	};
}

export function dispatchReceipt(
	receipt: ElevationDispatchReceipt,
	dispatch: { ownerId: string; epoch: number; dispatchedAt: number },
	outcome: ElevationDispatchOutcome,
): ElevationDispatchReceipt {
	return {
		...receipt,
		state: "dispatched",
		dispatch,
		outcome,
		ts: dispatch.dispatchedAt,
	};
}

export function uncertainReceipt(receipt: ElevationDispatchReceipt, at: number): ElevationDispatchReceipt {
	return {
		...receipt,
		state: "uncertain",
		outcome: {
			status: "unknown",
			message: "Claiming broker tenure ended before dispatch outcome was recorded",
			dispatchedAt: at,
		},
		ts: at,
	};
}

export function receiptClaimMatches(receipt: ElevationDispatchReceipt, identity: ElevationClaimIdentity): boolean {
	return receipt.claim.ownerId === identity.ownerId && receipt.claim.epoch === identity.epoch;
}

/**
 * Who may answer an elevation gate.
 *
 * Internal operator-only: the answer boundary is the broker's internal
 * operator attestation (`local_operator`), reached only through broker-owned
 * surfaces. There is no public `elevation.answer` operation and no
 * requester-correlation check: the answerer is structurally an operator
 * attestation, so requester self-approval is impossible by construction.
 */
export type ElevationAnswerAuthority = { source: "local_operator"; attestedBy: string };

/** Structural guard for the internal operator attestation. */
export function isElevationAnswerAuthority(value: unknown): value is ElevationAnswerAuthority {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const authority = value as { source?: unknown; attestedBy?: unknown };
	return (
		authority.source === "local_operator" &&
		typeof authority.attestedBy === "string" &&
		authority.attestedBy.length > 0
	);
}
