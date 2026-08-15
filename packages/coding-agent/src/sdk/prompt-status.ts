/**
 * Public prompt-result DTO contract for canonical Q26 `turn.result` with
 * `kind: "prompt"`, plus the legacy `turn.prompt_status` alias and the `clientRef`
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
 *   after terminal capacity eviction a ref may be admitted again with the
 *   prior outcome unknown — callers MUST NOT reuse a clientRef as a retry
 *   mechanism and MUST treat `unknown` as uncertainty, not proof of
 *   non-execution.
 * - Prompt records survive process restart: an active prompt is finalized from its
 *   durable pending outcome, or as `prompt_failed` when it has none. Only skill
 *   records settle as `process_restart`, and a lookup reports `unknown` only after
 *   retained-record capacity eviction.
 * - Q26 tracks prompts accepted through the SDK control surface (which always
 *   carries a requesting connection); submissions without a delivery owner are
 *   outside the reconciliation contract and hold no reservation.
 * - A terminal outcome settles once: the first terminal transition wins. A late
 *   `agent_failed` (arriving on a different delivery path than the one that
 *   claimed the terminal) may still attach its bounded, sanitized reason to an
 *   already-terminal record that has none, surfaced as `error` on `terminal_ok`.
 *   It never changes status, `terminalAt`, retention order, or the clientRef
 *   index, and the first recorded reason always wins over a later frame.
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

/**
 * Terminal outcome is preserved exactly; active records never age into terminal. A
 * prompt that is active at process restart is finalized from its durable pending
 * outcome (or `prompt_failed` when it has none), so it never reports as unknown.
 */
import type { ReceiptState } from "./receipt-state";

export type PromptReconciliationStatus = "accepted" | "in_flight" | "terminal_ok" | "failed";
export type SdkPromptStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
export type SdkPromptFailureCode = "prompt_failed" | "prompt_deadline_exceeded";
export type SdkPromptTerminalOutcome =
	| { kind: "stopped"; reason: SdkPromptStopReason; provenance: "agent" | "client_cancel" }
	| { kind: "failed"; code: SdkPromptFailureCode; message: string; provenance: "agent_failed" | "deadline" };

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
	receiptState: Extract<ReceiptState, "absent">;
}

export interface TurnPromptReconciliationInFlight extends TurnPromptReconciliationIdentity {
	status: "in_flight";
	receiptState: Extract<ReceiptState, "absent">;
	/** Epoch milliseconds of the agent_start transition. */
	startedAt: number;
}

export interface TurnPromptReconciliationTerminalOk extends TurnPromptReconciliationIdentity {
	status: "terminal_ok";
	receiptState: Exclude<ReceiptState, "absent">;
	startedAt?: number;
	/** Epoch milliseconds of the terminal transition. */
	terminalAt: number;
	outcome?: SdkPromptTerminalOutcome;
	/** Present when a late `agent_failed` supplied the only failure reason. */
	error?: { code: string; message: string };
}

export interface TurnPromptReconciliationFailed extends TurnPromptReconciliationIdentity {
	status: "failed";
	receiptState: Exclude<ReceiptState, "absent">;
	startedAt?: number;
	terminalAt: number;
	/** Bounded, sanitized failure detail (code safe-token ≤64, message ≤512). */
	error: { code: string; message: string };
	outcome?: SdkPromptTerminalOutcome;
}

export interface TurnPromptReconciliationUnknown {
	status: "unknown";
	receiptState: Extract<ReceiptState, "unknown">;
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
