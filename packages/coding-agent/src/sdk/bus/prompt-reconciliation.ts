/**
 * Bounded prompt reconciliation state for canonical Q26 `turn.result` with
 * `kind: "prompt"`, plus the legacy `turn.prompt_status` alias.
 *
 * Separate from the lifecycle delivery buffers (promptSubmissions /
 * promptTerminalTombstones), which exist to deliver frames and intentionally
 * forget outcomes. This record preserves accepted/in_flight/terminal_ok/failed
 * plus bounded sanitized failure metadata so a caller can reconcile a prior
 * `turn.prompt` after disconnect/reconnect.
 *
 * Semantics (public contract, mirrored in sdk/prompt-status.ts):
 * - Active records are NEVER converted to terminal by age or capacity.
 * - Terminal records are bounded to TERMINAL_CAPACITY and evicted
 *   oldest-terminal-first by terminalAt; only then
 *   does a lookup honestly report `unknown`.
 * - Process-local durability floor is the live session process: restart means `unknown`.
 *   Session-scoped durable retention (kind-aware store) is provided by reconciliation-store.ts (#3032).
 * - The clientRef index is session-runtime scoped; a ref conflicts only while
 *   retained and must never be reused as a retry mechanism.
 * - Terminal transitions settle once: first terminal outcome wins. A late
 *   `agent_failed` may still attach its sanitized reason to an already-terminal
 *   record that has none, but never changes status, terminalAt, or retention.
 */

import { PROMPT_FAILURE_CODE_MAX, sanitizePromptFailure } from "../prompt-failure";
import type { ReceiptState } from "../receipt-state";

export { PROMPT_FAILURE_CODE_MAX, sanitizePromptFailure };
export const PROMPT_RECONCILIATION_ACTIVE_CAPACITY = 128;
export const PROMPT_RECONCILIATION_TERMINAL_CAPACITY = 256;

export type PromptReconciliationStatus = "accepted" | "in_flight" | "terminal_ok" | "failed";

export interface PromptCorrelation {
	commandId: string;
	turnId: string;
}

export interface PromptReconciliationRecord extends PromptCorrelation {
	clientRef?: string;
	status: PromptReconciliationStatus;
	error?: { code: string; message: string };
	acceptedAt: number;
	startedAt?: number;
	terminalAt?: number;
	receiptState?: Exclude<ReceiptState, "absent">;
}

export type TurnPromptReconciliation =
	| {
			status: "accepted";
			receiptState: "absent";
			commandId: string;
			turnId: string;
			clientRef?: string;
			acceptedAt: number;
	  }
	| {
			status: "in_flight";
			receiptState: "absent";
			commandId: string;
			turnId: string;
			clientRef?: string;
			acceptedAt: number;
			startedAt: number;
	  }
	| {
			status: "terminal_ok";
			receiptState: Exclude<ReceiptState, "absent">;
			commandId: string;
			turnId: string;
			clientRef?: string;
			acceptedAt: number;
			startedAt?: number;
			terminalAt: number;
			/** Present when a late `agent_failed` supplied the only failure reason. */
			error?: { code: string; message: string };
	  }
	| {
			status: "failed";
			receiptState: Exclude<ReceiptState, "absent">;
			commandId: string;
			turnId: string;
			clientRef?: string;
			acceptedAt: number;
			startedAt?: number;
			terminalAt: number;
			error: { code: string; message: string };
	  }
	| { status: "unknown"; receiptState: "unknown" };

export interface PromptReconciliation {
	/** Fail-closed admission BEFORE any execution; holds an identity-bound reservation. */
	admit(clientRef?: string): void;
	/** Discard one admission reservation without creating a record (rejection/cancellation). */
	releaseAdmission(clientRef?: string): void;
	/** Transition a reservation into the accepted record at preflight acceptance. */
	noteAccepted(correlation: PromptCorrelation, clientRef?: string): void;
	/** Lifecycle transition; terminal outcomes settle exactly once. */
	noteTransition(
		correlation: PromptCorrelation | undefined,
		frame:
			| { type: "agent_start" }
			| { type: "agent_end"; finalText?: string }
			| { type: "agent_failed"; error: unknown; finalText?: string },
	): void;
	lookup(selector: { commandId?: string; turnId?: string; clientRef?: string }): TurnPromptReconciliation;
	cleanup(): void;
	activeCount(): number;
}

export function createPromptReconciliation(options: { now?: () => number } = {}): PromptReconciliation {
	const now = options.now ?? Date.now;
	const records = new Map<string, PromptReconciliationRecord>();
	const clientRefIndex = new Map<string, string>();
	const reservedClientRefs = new Set<string>();
	// One identity-bound entry per admission. Transitions consume exactly one
	// matching entry and stale/duplicate transitions are no-ops, so reservation
	// accounting is exactly-once even under repeated calls.
	const reservations: Array<string | undefined> = [];
	const keyOf = (correlation: PromptCorrelation) => `${correlation.commandId}:${correlation.turnId}`;

	const remove = (key: string) => {
		const record = records.get(key);
		if (!record) return;
		records.delete(key);
		if (record.clientRef !== undefined && clientRefIndex.get(record.clientRef) === key)
			clientRefIndex.delete(record.clientRef);
	};

	const cleanup = () => {
		const terminalEntries = [...records.entries()].filter(([, record]) => record.terminalAt !== undefined);
		if (terminalEntries.length <= PROMPT_RECONCILIATION_TERMINAL_CAPACITY) return;
		// Evict oldest-terminal-first by terminalAt, not acceptance/insertion
		// order; the stable sort keeps acceptance order for exact ties.
		terminalEntries.sort((a, b) => (a[1].terminalAt as number) - (b[1].terminalAt as number));
		for (const [key] of terminalEntries.slice(0, terminalEntries.length - PROMPT_RECONCILIATION_TERMINAL_CAPACITY))
			remove(key);
	};

	const activeCount = () => {
		let count = 0;
		for (const record of records.values()) if (record.terminalAt === undefined) count++;
		return count;
	};

	/** Consume one reservation matching clientRef; no-op when none is outstanding. */
	const consumeReservation = (clientRef?: string) => {
		const index = reservations.indexOf(clientRef);
		if (index === -1) return;
		reservations.splice(index, 1);
		if (clientRef !== undefined && !reservations.includes(clientRef)) reservedClientRefs.delete(clientRef);
	};

	const admit = (clientRef?: string) => {
		cleanup();
		if (clientRef !== undefined && (clientRefIndex.has(clientRef) || reservedClientRefs.has(clientRef)))
			throw Object.assign(
				new Error("A prompt with this clientRef is already retained; never reuse a clientRef for retry."),
				{ code: "client_ref_conflict" },
			);
		if (activeCount() + reservations.length >= PROMPT_RECONCILIATION_ACTIVE_CAPACITY)
			throw Object.assign(new Error("Too many active prompt submissions; reconcile or await terminal state."), {
				code: "reconciliation_capacity",
			});
		reservations.push(clientRef);
		if (clientRef !== undefined) reservedClientRefs.add(clientRef);
	};

	const releaseAdmission = (clientRef?: string) => {
		consumeReservation(clientRef);
	};

	const noteAccepted = (correlation: PromptCorrelation, clientRef?: string) => {
		cleanup();
		consumeReservation(clientRef);
		const at = now();
		const key = keyOf(correlation);
		records.set(key, {
			commandId: correlation.commandId,
			turnId: correlation.turnId,
			...(clientRef !== undefined ? { clientRef } : {}),
			status: "accepted",
			acceptedAt: at,
		});
		if (clientRef !== undefined) clientRefIndex.set(clientRef, key);
	};

	const noteTransition = (
		correlation: PromptCorrelation | undefined,
		frame:
			| { type: "agent_start" }
			| { type: "agent_end"; finalText?: string }
			| { type: "agent_failed"; error: unknown; finalText?: string },
	) => {
		if (!correlation) return;
		const record = records.get(keyOf(correlation));
		if (!record) return;
		if (record.terminalAt !== undefined) {
			// The terminal is claimed by one path while the reason arrives on another,
			// so ordering is not the caller's to control. A late agent_failed enriches
			// the settled record instead of being dropped; it must not resurrect it,
			// so status, terminalAt, retention order, and clientRefIndex stay as-is.
			// First reason wins: a late generic frame never overwrites a specific one.
			if (frame.type === "agent_failed") {
				const failure = sanitizePromptFailure(frame.error);
				if (record.error === undefined || (record.error.code === "agent_failed" && failure.code !== "agent_failed"))
					record.error = failure;
			}
			return;
		}
		if (frame.type === "agent_start") {
			if (record.status === "accepted") {
				record.status = "in_flight";
				record.startedAt = now();
			}
			return;
		}
		record.terminalAt = now();
		record.receiptState = frame.finalText?.trim() ? "present" : "missing";
		if (frame.type === "agent_failed") {
			record.status = "failed";
			record.error = sanitizePromptFailure(frame.error);
		} else {
			record.status = "terminal_ok";
		}
		// Enforce terminal retention immediately at settlement, not lazily.
		cleanup();
	};

	const lookup = (selector: { commandId?: string; turnId?: string; clientRef?: string }): TurnPromptReconciliation => {
		cleanup();
		const key =
			selector.clientRef !== undefined
				? clientRefIndex.get(selector.clientRef)
				: selector.commandId !== undefined && selector.turnId !== undefined
					? keyOf({ commandId: selector.commandId, turnId: selector.turnId })
					: undefined;
		const record = key === undefined ? undefined : records.get(key);
		if (!record) return { status: "unknown", receiptState: "unknown" };
		const identity = {
			commandId: record.commandId,
			turnId: record.turnId,
			...(record.clientRef !== undefined ? { clientRef: record.clientRef } : {}),
			acceptedAt: record.acceptedAt,
		};
		if (record.status === "accepted") return { status: "accepted", receiptState: "absent", ...identity };
		if (record.status === "in_flight")
			return { status: "in_flight", receiptState: "absent", ...identity, startedAt: record.startedAt as number };
		const terminal = {
			...identity,
			...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
			terminalAt: record.terminalAt as number,
			receiptState: record.receiptState ?? "unknown",
		};
		if (record.status === "terminal_ok")
			return {
				status: "terminal_ok",
				...terminal,
				...(record.error !== undefined ? { error: record.error } : {}),
			};
		return { status: "failed", ...terminal, error: record.error ?? sanitizePromptFailure(undefined) };
	};

	return { admit, releaseAdmission, noteAccepted, noteTransition, lookup, cleanup, activeCount };
}
