/**
 * Public DTO contract for Q26 `turn.prompt_status` and the `clientRef`
 * correlation field on `turn.prompt`.
 *
 * Semantics:
 * - `turn.prompt` remains ordered and non-idempotent. An envelope
 *   `idempotencyKey` is ignored for replay/conflict purposes on ordered
 *   operations (no replay cache, no `idempotency_conflict`).
 * - `clientRef` is a caller-chosen correlation key (trimmed, non-empty,
 *   1..PROMPT_CLIENT_REF_MAX_LENGTH chars; one fresh value per logical prompt)
 *   mapped to the generated commandId/turnId at preflight acceptance so a
 *   caller can reconcile after a lost acknowledgement frame.
 * - The clientRef index is scoped to one live session runtime: identical refs
 *   may coexist in different sessions, lookups never cross sessions, a ref
 *   conflicts only while its record is retained (`client_ref_conflict`), and
 *   after terminal TTL/capacity eviction a ref may be admitted again with the
 *   prior outcome unknown — callers MUST NOT reuse a clientRef as a retry
 *   mechanism and MUST treat `unknown` as uncertainty, not proof of
 *   non-execution.
 * - The durability floor is the live session process: after restart or
 *   retained-record eviction, a lookup honestly reports `unknown`.
 * - Q26 tracks prompts accepted through the SDK control surface (which always
 *   carries a requesting connection); submissions without a delivery owner are
 *   outside the reconciliation contract and hold no reservation.
 */

export const PROMPT_CLIENT_REF_MAX_LENGTH = 128;

export interface TurnPromptImageInput {
	data: string;
	mimeType?: string;
}

/** Public input contract for ordered `turn.prompt`. */
export interface TurnPromptInput {
	text: string;
	images?: TurnPromptImageInput[];
	clientRef?: string;
}

/** Terminal outcome is preserved exactly; active records never age into terminal. */
export type PromptReconciliationStatus = "accepted" | "in_flight" | "terminal_ok" | "failed";

/** Exactly one selector per lookup. */
export type TurnPromptStatusSelector = { clientRef: string } | { commandId: string; turnId: string };

interface TurnPromptReconciliationIdentity {
	commandId: string;
	turnId: string;
	clientRef?: string;
	/** Epoch milliseconds of preflight acceptance. */
	acceptedAt: number;
}

export interface TurnPromptReconciliationAccepted extends TurnPromptReconciliationIdentity {
	status: "accepted";
}

export interface TurnPromptReconciliationInFlight extends TurnPromptReconciliationIdentity {
	status: "in_flight";
	/** Epoch milliseconds of the agent_start transition. */
	startedAt: number;
}

export interface TurnPromptReconciliationTerminalOk extends TurnPromptReconciliationIdentity {
	status: "terminal_ok";
	startedAt?: number;
	/** Epoch milliseconds of the terminal transition. */
	terminalAt: number;
}

export interface TurnPromptReconciliationFailed extends TurnPromptReconciliationIdentity {
	status: "failed";
	startedAt?: number;
	terminalAt: number;
	/** Bounded, sanitized failure detail (code safe-token ≤64, message ≤512). */
	error: { code: string; message: string };
}

export interface TurnPromptReconciliationUnknown {
	status: "unknown";
}

export type TurnPromptReconciliation =
	| TurnPromptReconciliationAccepted
	| TurnPromptReconciliationInFlight
	| TurnPromptReconciliationTerminalOk
	| TurnPromptReconciliationFailed
	| TurnPromptReconciliationUnknown;

/** Result of a successful `turn.prompt` preflight acknowledgement. */
export interface TurnPromptAcceptedResult {
	commandId: string;
	turnId: string;
	accepted: true;
	clientRef?: string;
}
