import { createHash, randomUUID } from "node:crypto";

/**
 * Kind-aware invocation reconciliation (prompt | skill) with optional durable store.
 * Preserves Q26 admit/first-terminal/capacity semantics; indexes and caps are per-kind.
 */

import {
	failedPromptOutcome,
	type PromptFailureEvidence,
	rephaseFailedOutcome,
	sanitizePromptFailure,
} from "../prompt-failure";
import type {
	PromptReconciliationStatus,
	SdkPromptFailureCode,
	SdkPromptStopReason,
	SdkPromptTerminalOutcome,
	TurnPromptReconciliation,
} from "../prompt-status";
import { type ReceiptState, reduceReceiptState } from "../receipt-state";
import {
	reduceTurnResultContent,
	reportableTurnResultContent,
	sanitizeTurnResultContent,
	type TurnResultContent,
	type TurnResultPage,
} from "../turn-result";
import {
	PROMPT_RECONCILIATION_ACTIVE_CAPACITY,
	PROMPT_RECONCILIATION_TERMINAL_CAPACITY,
	type PromptCorrelation,
} from "./prompt-reconciliation";
import type {
	DurableReconciliationRecord,
	DurableSteerReconciliationRecord,
	ReconciliationKind,
	ReconciliationStore,
} from "./reconciliation-store";

const EMPTY_PROMPT_FAILURE = { code: "prompt_failed", message: "Prompt submission failed." } as const;
const PRESERVED_PROVIDER_FAILURE_CODES = new Set([
	"provider_down",
	"provider_unavailable",
	"provider_rejected",
	"upstream_stream_interrupted",
	"argument_validation",
	"execution",
	"upstream_error",
	"transport_reset",
]);
const isPreservedProviderFailure = (code: string | undefined): boolean =>
	code !== undefined && (PRESERVED_PROVIDER_FAILURE_CODES.has(code) || code.startsWith("provider_http_"));
const STOP_REASONS: readonly SdkPromptStopReason[] = [
	"end_turn",
	"max_tokens",
	"max_turn_requests",
	"refusal",
	"cancelled",
];
const FAILURE_CODES: readonly SdkPromptFailureCode[] = ["prompt_failed", "prompt_deadline_exceeded"];

const normalizeTerminalOutcome = (
	outcome: unknown,
	evidence: PromptFailureEvidence = {},
): SdkPromptTerminalOutcome | undefined => {
	if (outcome === null || typeof outcome !== "object") return undefined;
	const candidate = outcome as Record<string, unknown>;
	if (
		candidate.kind === "stopped" &&
		STOP_REASONS.includes(candidate.reason as SdkPromptStopReason) &&
		["agent", "client_cancel"].includes(candidate.provenance as string)
	)
		return {
			kind: "stopped",
			reason: candidate.reason as SdkPromptStopReason,
			provenance: candidate.provenance as "agent" | "client_cancel",
		};
	if (
		candidate.kind === "failed" &&
		FAILURE_CODES.includes(candidate.code as SdkPromptFailureCode) &&
		typeof candidate.message === "string" &&
		["agent_failed", "deadline"].includes(candidate.provenance as string)
	) {
		return failedPromptOutcome({
			code: candidate.code as SdkPromptFailureCode,
			provenance: candidate.provenance as "agent_failed" | "deadline",
			...(typeof candidate.providerCode === "string" ? { providerCode: candidate.providerCode } : {}),
			evidence,
		});
	}
	return undefined;
};

const failedOutcomeForError = (
	error: { code: string; message: string },
	evidence: PromptFailureEvidence = {},
	providerCodeOverride?: string,
): SdkPromptTerminalOutcome =>
	failedPromptOutcome({
		code: "prompt_failed",
		provenance: "agent_failed",
		...(providerCodeOverride !== undefined
			? { providerCode: providerCodeOverride }
			: error.code !== "prompt_failed"
				? { providerCode: error.code }
				: {}),
		evidence,
	});

/** Start/activity evidence for phase derivation from a reconciliation record. */
const failureEvidence = (record: { startedAt?: number }, hasActivity?: boolean): PromptFailureEvidence => ({
	...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
	...(hasActivity === true ? { hasActivity: true } : {}),
});

const isDeadlineOutcome = (outcome: SdkPromptTerminalOutcome | undefined): boolean =>
	outcome?.kind === "failed" && outcome.provenance === "deadline";

const isProviderFailureOutcome = (outcome: SdkPromptTerminalOutcome | undefined): boolean =>
	outcome?.kind === "failed" && outcome.provenance === "agent_failed";

export type { ReconciliationKind };

export interface KindCorrelation extends PromptCorrelation {
	kind: ReconciliationKind;
	content?: TurnResultContent;
}

export interface SteerReconciliationResult {
	commandId: string;
	turnId: string;
	clientRef: string;
	status: "accepted" | "rejected" | "uncertain";
	acceptedAt: number;
	terminalAt?: number;
	error?: { code: string; message: string };
}

export interface KindAwareReconciliation {
	admit(kind: ReconciliationKind, clientRef?: string): void;
	releaseAdmission(kind: ReconciliationKind, clientRef?: string): void;
	noteAccepted(
		kind: ReconciliationKind,
		correlation: PromptCorrelation,
		clientRef?: string,
		extra?: { skillName?: string },
	): Promise<void>;
	noteTransition(
		kind: ReconciliationKind,
		correlation: PromptCorrelation | undefined,
		frame:
			| {
					type: "agent_start" | "agent_end";
					content?: TurnResultContent;
					hasActivity?: boolean;
					outcome?: SdkPromptTerminalOutcome;
			  }
			| { type: "agent_failed"; error: unknown; content?: TurnResultContent; hasActivity?: boolean },
	): Promise<void>;
	claimPendingOutcome(
		kind: ReconciliationKind,
		correlation: PromptCorrelation,
		outcome: SdkPromptTerminalOutcome,
		receiptState?: Extract<ReceiptState, "present" | "missing">,
	): Promise<SdkPromptTerminalOutcome>;
	finalizeOutcome(
		kind: ReconciliationKind,
		correlation: PromptCorrelation,
		outcome?: SdkPromptTerminalOutcome,
		recordError?: { code: string; message: string },
		content?: unknown,
	): Promise<void>;
	finalizeOutcome(
		kind: ReconciliationKind,
		correlation: PromptCorrelation,
		outcome?: SdkPromptTerminalOutcome,
		isCurrent?: () => boolean,
		recordError?: { code: string; message: string },
		content?: unknown,
	): Promise<void>;
	/** Replace an exhausted deadline failure with an active, non-definite record. */
	markUncertain(
		kind: ReconciliationKind,
		correlation: PromptCorrelation,
		isCurrent?: () => boolean,
		deadlineMaxAt?: number,
	): Promise<void>;
	peekPendingOutcome(kind: ReconciliationKind, correlation: PromptCorrelation): SdkPromptTerminalOutcome | undefined;
	lookup(
		kind: ReconciliationKind,
		selector: { commandId?: string; turnId?: string; clientRef?: string },
	): TurnPromptReconciliation;
	lookupResult(
		kind: ReconciliationKind,
		selector: { commandId?: string; turnId?: string; clientRef?: string },
	): TurnResultPage;
	reserveSteer(clientRef: string, text: string): Promise<{ replay: boolean; result: SteerReconciliationResult }>;
	settleSteer(
		clientRef: string,
		status: "accepted" | "rejected" | "uncertain",
		error?: unknown,
	): Promise<SteerReconciliationResult>;
	lookupSteer(
		selector: string | { commandId?: string; turnId?: string; clientRef?: string },
	): SteerReconciliationResult | { clientRef?: string; status: "unknown" };
	cleanup(): void;
	activeCount(kind: ReconciliationKind): number;
	/** Hydrate from durable store (call once at session host start). */
	hydrateFromStore(): Promise<void>;
	/** Await quiescence of every admitted mutation and the durable store (#4743). */
	drain(): Promise<void>;
}

export function createKindAwareReconciliation(
	options: {
		now?: () => number;
		store?: ReconciliationStore | null;
		ownedKinds?: readonly DurableReconciliationRecord["kind"][];
	} = {},
): KindAwareReconciliation {
	const now = options.now ?? Date.now;
	const store = options.store ?? null;
	const ownedKinds = new Set<DurableReconciliationRecord["kind"]>(options.ownedKinds ?? ["prompt", "skill", "steer"]);
	let records = new Map<string, DurableReconciliationRecord>();
	let clientRefIndex = new Map<string, string>();
	const reservedClientRefs = new Map<ReconciliationKind, Set<string>>();
	const reservations: Array<{ kind: ReconciliationKind; clientRef?: string }> = [];
	let mutationChain: Promise<void> = Promise.resolve();

	const keyOf = (kind: ReconciliationKind, correlation: PromptCorrelation) =>
		`${kind}:${correlation.commandId}:${correlation.turnId}`;
	const refKey = (kind: ReconciliationKind, clientRef: string) => `${kind}\0${clientRef}`;
	const steerKey = (clientRef: string) => `steer:${clientRef}`;
	const steerResult = (record: DurableSteerReconciliationRecord): SteerReconciliationResult => ({
		commandId: record.commandId,
		turnId: record.turnId,
		clientRef: record.clientRef,
		status: record.status === "dispatching" ? "uncertain" : record.status,
		acceptedAt: record.acceptedAt,
		...(record.status !== "dispatching" && record.status !== "accepted" ? { terminalAt: record.settledAt } : {}),
		...(record.error
			? { error: record.error }
			: record.status === "dispatching"
				? { error: { code: "delivery_uncertain", message: "Steer delivery is still dispatching or uncertain." } }
				: {}),
	});

	const indexRecords = (source: Map<string, DurableReconciliationRecord>) => {
		const index = new Map<string, string>();
		for (const [key, record] of source)
			if (record.kind !== "steer" && record.clientRef !== undefined)
				index.set(refKey(record.kind, record.clientRef), key);
		return index;
	};

	const cleanupRecords = (source: Map<string, DurableReconciliationRecord>) => {
		for (const kind of ["prompt", "skill"] as const) {
			const terminalEntries = [...source.entries()].filter(
				([, record]) => record.kind === kind && record.terminalAt !== undefined,
			);
			if (terminalEntries.length <= PROMPT_RECONCILIATION_TERMINAL_CAPACITY) continue;
			terminalEntries.sort(
				(a, b) =>
					((a[1].kind === "steer" ? a[1].settledAt : a[1].terminalAt) as number) -
					((b[1].kind === "steer" ? b[1].settledAt : b[1].terminalAt) as number),
			);
			for (const [key] of terminalEntries.slice(0, terminalEntries.length - PROMPT_RECONCILIATION_TERMINAL_CAPACITY))
				source.delete(key);
		}
		const settledSteers: Array<[string, DurableSteerReconciliationRecord]> = [];
		for (const [key, record] of source)
			if (record.kind === "steer" && record.settledAt !== undefined) settledSteers.push([key, record]);
		if (settledSteers.length > PROMPT_RECONCILIATION_TERMINAL_CAPACITY) {
			settledSteers.sort((a, b) => (a[1].settledAt as number) - (b[1].settledAt as number));
			for (const [key] of settledSteers.slice(0, settledSteers.length - PROMPT_RECONCILIATION_TERMINAL_CAPACITY))
				source.delete(key);
		}
	};

	const queueMutation = async <T>(
		mutate: (candidate: Map<string, DurableReconciliationRecord>) => { value: T; changed: boolean },
	): Promise<T> => {
		const run = async () => {
			const candidate = new Map([...records].map(([key, record]) => [key, { ...record }]));
			const result = mutate(candidate);
			if (!result.changed) return result.value;
			const candidateIndex = indexRecords(candidate);
			if (store)
				await store.transact(current => [
					...current.filter(record => !ownedKinds.has(record.kind)),
					...[...candidate.values()].filter(record => ownedKinds.has(record.kind)).map(record => ({ ...record })),
				]);
			records = candidate;
			clientRefIndex = candidateIndex;
			return result.value;
		};
		const pending = mutationChain.then(run, run);
		mutationChain = pending.then(
			() => undefined,
			() => undefined,
		);
		return await pending;
	};

	const reserveSteer = async (clientRef: string, text: string) => {
		const textDigest = createHash("sha256").update(text).digest("hex");
		return await queueMutation(candidate => {
			cleanupRecords(candidate);
			const existing = candidate.get(steerKey(clientRef));
			if (existing?.kind === "steer") {
				if (existing.textDigest !== textDigest)
					throw Object.assign(new Error("clientRef is already bound to different steer text."), {
						code: "client_ref_conflict",
					});
				return { value: { replay: true, result: steerResult(existing) }, changed: false };
			}
			const correlation = { commandId: randomUUID(), turnId: randomUUID() };
			const record: DurableSteerReconciliationRecord = {
				kind: "steer",
				...correlation,
				clientRef,
				textDigest,
				createdAt: now(),
				acceptedAt: now(),
				status: "dispatching",
			};
			candidate.set(steerKey(clientRef), record);
			return { value: { replay: false, result: steerResult(record) }, changed: true };
		});
	};

	const settleSteer = async (clientRef: string, status: "accepted" | "rejected" | "uncertain", error?: unknown) =>
		await queueMutation(candidate => {
			const record = candidate.get(steerKey(clientRef));
			if (record?.kind !== "steer")
				throw Object.assign(new Error("Unknown steer clientRef."), { code: "unknown_client_ref" });
			if (record.status !== "dispatching") return { value: steerResult(record), changed: false };
			record.status = status;
			record.settledAt = now();
			if (status !== "accepted") record.error = sanitizePromptFailure(error);
			cleanupRecords(candidate);
			return { value: steerResult(record), changed: true };
		});

	const lookupSteer = (selector: string | { commandId?: string; turnId?: string; clientRef?: string }) => {
		const record =
			typeof selector === "string"
				? records.get(steerKey(selector))
				: selector.clientRef !== undefined
					? records.get(steerKey(selector.clientRef))
					: selector.commandId !== undefined && selector.turnId !== undefined
						? [...records.values()].find(
								candidate =>
									candidate.kind === "steer" &&
									candidate.commandId === selector.commandId &&
									candidate.turnId === selector.turnId,
							)
						: undefined;
		return record?.kind === "steer"
			? steerResult(record)
			: typeof selector === "string"
				? { clientRef: selector, status: "unknown" as const }
				: { status: "unknown" as const };
	};

	const reservedFor = (kind: ReconciliationKind) => {
		let set = reservedClientRefs.get(kind);
		if (!set) {
			set = new Set();
			reservedClientRefs.set(kind, set);
		}
		return set;
	};

	const cleanup = () => {
		cleanupRecords(records);
		clientRefIndex = indexRecords(records);
	};

	const activeCount = (kind: ReconciliationKind) => {
		let count = 0;
		for (const record of records.values())
			if (record.kind !== "steer" && record.kind === kind && record.terminalAt === undefined) count++;
		return count;
	};

	const reservationCount = (kind: ReconciliationKind) => reservations.filter(record => record.kind === kind).length;

	const consumeReservation = (kind: ReconciliationKind, clientRef?: string) => {
		const index = reservations.findIndex(record => record.kind === kind && record.clientRef === clientRef);
		if (index === -1) return;
		reservations.splice(index, 1);
		if (
			clientRef !== undefined &&
			!reservations.some(record => record.kind === kind && record.clientRef === clientRef)
		)
			reservedFor(kind).delete(clientRef);
	};

	const admit = (kind: ReconciliationKind, clientRef?: string) => {
		cleanup();
		const reserved = reservedFor(kind);
		if (clientRef !== undefined && (clientRefIndex.has(refKey(kind, clientRef)) || reserved.has(clientRef)))
			throw Object.assign(
				new Error("A submission with this clientRef is already retained; never reuse a clientRef for retry."),
				{ code: "client_ref_conflict" },
			);
		if (activeCount(kind) + reservationCount(kind) >= PROMPT_RECONCILIATION_ACTIVE_CAPACITY)
			throw Object.assign(new Error("Too many active submissions; reconcile or await terminal state."), {
				code: "reconciliation_capacity",
			});
		reservations.push({ kind, clientRef });
		if (clientRef !== undefined) reserved.add(clientRef);
	};

	const releaseAdmission = (kind: ReconciliationKind, clientRef?: string) => {
		consumeReservation(kind, clientRef);
	};

	const noteAccepted = async (
		kind: ReconciliationKind,
		correlation: PromptCorrelation,
		clientRef?: string,
		extra?: { skillName?: string },
	) => {
		await queueMutation(candidate => {
			cleanupRecords(candidate);
			candidate.set(keyOf(kind, correlation), {
				kind,
				commandId: correlation.commandId,
				turnId: correlation.turnId,
				...(clientRef !== undefined ? { clientRef } : {}),
				status: "accepted",
				acceptedAt: now(),
				...(extra?.skillName ? { skillName: extra.skillName } : {}),
			});
			return { value: undefined, changed: true };
		});
		consumeReservation(kind, clientRef);
	};

	const noteTransition = async (
		kind: ReconciliationKind,
		correlation: PromptCorrelation | undefined,
		frame:
			| {
					type: "agent_start" | "agent_end";
					content?: TurnResultContent;
					hasActivity?: boolean;
					outcome?: SdkPromptTerminalOutcome;
			  }
			| { type: "agent_failed"; error: unknown; content?: TurnResultContent; hasActivity?: boolean },
	) => {
		if (!correlation) return;
		await queueMutation(candidate => {
			const record = candidate.get(keyOf(kind, correlation));
			if (!record || record.kind === "steer") return { value: undefined, changed: false };
			if (record.terminalAt !== undefined) {
				if (frame.type === "agent_end") {
					const content = reduceTurnResultContent(record.content, frame.content);
					const receiptState = reduceReceiptState(
						record.receiptState,
						reportableTurnResultContent(content) ? "present" : undefined,
					);
					const incomingOutcome = normalizeTerminalOutcome(
						frame.outcome,
						failureEvidence(record, frame.hasActivity),
					);
					const providerErrorRecord = record.error;
					const providerError =
						providerErrorRecord !== undefined && providerErrorRecord.code !== "prompt_deadline_exceeded";
					const providerOutcome =
						incomingOutcome?.kind === "failed" && incomingOutcome.provenance === "agent_failed"
							? incomingOutcome
							: undefined;
					let outcome = record.outcome;
					let error = record.error;
					if (isDeadlineOutcome(record.outcome)) {
						if (providerOutcome !== undefined) {
							// A real provider terminal failure is stronger evidence than the
							// synthetic deadline claim. Retain the provider's outcome and
							// diagnostic rather than surfacing a contradictory deadline.
							outcome = providerOutcome;
							error = providerError
								? providerErrorRecord
								: { code: providerOutcome.code, message: providerOutcome.message };
						} else if (providerError) {
							outcome = failedOutcomeForError(providerErrorRecord, failureEvidence(record, frame.hasActivity));
							error = providerErrorRecord;
						} else if (
							incomingOutcome?.kind === "stopped" ||
							kind !== "prompt" ||
							frame.hasActivity === true ||
							reportableTurnResultContent(content)
						) {
							// A completed lifecycle event also supersedes a synthetic deadline.
							outcome = incomingOutcome?.kind === "stopped" ? incomingOutcome : undefined;
							error = undefined;
						}
					} else if (outcome === undefined) {
						if (providerOutcome !== undefined) {
							outcome = providerOutcome;
							error = providerError
								? providerErrorRecord
								: { code: providerOutcome.code, message: providerOutcome.message };
						} else if (record.status === "failed" && providerError) {
							outcome = failedOutcomeForError(providerErrorRecord, failureEvidence(record, frame.hasActivity));
							error = providerErrorRecord;
						} else if (
							record.status === "terminal_ok" &&
							incomingOutcome?.kind === "stopped" &&
							error === undefined
						) {
							outcome = incomingOutcome;
						}
					}
					const status =
						outcome?.kind === "failed"
							? "failed"
							: outcome?.kind === "stopped" || (isDeadlineOutcome(record.outcome) && error === undefined)
								? "terminal_ok"
								: record.status;
					if (
						content === record.content &&
						receiptState === record.receiptState &&
						outcome === record.outcome &&
						error === record.error &&
						status === record.status
					)
						return { value: undefined, changed: false };
					record.content = content;
					record.receiptState = receiptState;
					record.status = status;
					if (outcome === undefined) delete record.outcome;
					else record.outcome = outcome;
					if (error === undefined) delete record.error;
					else record.error = error;
					return { value: undefined, changed: true };
				}
				// The terminal is claimed by one delivery path while the reason arrives on
				// another, so ordering is not the caller's to control. A late agent_failed
				// enriches the settled record instead of being dropped; it must not resurrect
				// it, so status, terminalAt, retention order, and the clientRef index stay
				// as-is (cleanupRecords is intentionally not re-run). First reason wins: a
				// late generic frame never overwrites a specific one. Persisted so the reason
				// survives reconnect/restart reconciliation.
				if (frame.type === "agent_failed") {
					const failure = sanitizePromptFailure(frame.error);
					if (record.error?.code === "prompt_deadline_exceeded") {
						record.error = failure;
						record.outcome = failedOutcomeForError(failure, failureEvidence(record, frame.hasActivity));
						record.status = "failed";
						return { value: undefined, changed: true };
					}
					if (
						record.error !== undefined &&
						!(record.error.code === "agent_failed" && failure.code !== "agent_failed")
					)
						return { value: undefined, changed: false };
					record.error = sanitizePromptFailure(frame.error);
					return { value: undefined, changed: true };
				}
				return { value: undefined, changed: false };
			}
			if (frame.type === "agent_start") {
				if (record.status !== "accepted") return { value: undefined, changed: false };
				delete record.deadlineRecoveryPending;
				delete record.deadlineMaxAt;
				record.status = "in_flight";
				record.startedAt = now();
				record.content = reduceTurnResultContent(record.content, frame.content);
				return { value: undefined, changed: true };
			}
			if (frame.type === "agent_failed") {
				// agent_failed is additive diagnostics; agent_end remains the sole
				// terminal lifecycle boundary for the correlated invocation.
				const failure = sanitizePromptFailure(frame.error);
				if (record.error === undefined || (record.error.code === "agent_failed" && failure.code !== "agent_failed"))
					record.error = failure;
				delete record.deadlineRecoveryPending;
				delete record.deadlineMaxAt;
				return { value: undefined, changed: true };
			}
			const pendingOutcome = record.pendingOutcome;
			const frameOutcome = normalizeTerminalOutcome(
				frame.type === "agent_end" ? frame.outcome : undefined,
				failureEvidence(record, frame.hasActivity),
			);
			delete record.deadlineRecoveryPending;
			delete record.deadlineMaxAt;
			record.terminalAt = now();
			record.content = reduceTurnResultContent(record.content, frame.content);
			if (pendingOutcome !== undefined) {
				const providerErrorRecord = record.error;
				const providerError =
					providerErrorRecord !== undefined && providerErrorRecord.code !== "prompt_deadline_exceeded";
				const preserveProviderError =
					providerError || isDeadlineOutcome(pendingOutcome) || isProviderFailureOutcome(frameOutcome);
				let terminalOutcome: SdkPromptTerminalOutcome = pendingOutcome;
				if (frameOutcome?.kind === "failed" && frameOutcome.provenance === "agent_failed")
					terminalOutcome = frameOutcome;
				else if (providerError && (pendingOutcome.kind !== "failed" || isDeadlineOutcome(pendingOutcome)))
					terminalOutcome = failedOutcomeForError(providerErrorRecord, failureEvidence(record, frame.hasActivity));
				else if (isDeadlineOutcome(pendingOutcome) && frameOutcome?.kind === "stopped")
					terminalOutcome = frameOutcome;
				record.outcome = terminalOutcome;
				delete record.pendingOutcome;
				if (terminalOutcome.kind === "failed") {
					record.status = "failed";
					if (!providerError || !preserveProviderError)
						record.error = { code: terminalOutcome.code, message: terminalOutcome.message };
				} else {
					record.status = "terminal_ok";
					delete record.error;
				}
				record.receiptState = reduceReceiptState(
					record.receiptState,
					reportableTurnResultContent(record.content) ? "present" : (record.pendingReceiptState ?? "missing"),
				);
				delete record.pendingReceiptState;
			} else {
				const providerErrorRecord = record.error;
				const providerError =
					providerErrorRecord !== undefined && providerErrorRecord.code !== "prompt_deadline_exceeded";
				const terminalOutcome = isProviderFailureOutcome(frameOutcome)
					? frameOutcome
					: providerError &&
							(frameOutcome === undefined || isDeadlineOutcome(frameOutcome) || frameOutcome.kind === "stopped")
						? failedOutcomeForError(providerErrorRecord, failureEvidence(record, frame.hasActivity))
						: frameOutcome;
				if (terminalOutcome !== undefined) {
					record.outcome = terminalOutcome;
					if (terminalOutcome.kind === "failed") {
						record.status = "failed";
						if (!providerError) record.error = { code: terminalOutcome.code, message: terminalOutcome.message };
					} else {
						record.status = "terminal_ok";
						delete record.error;
					}
				} else if (
					kind === "prompt" &&
					record.error === undefined &&
					frame.type === "agent_end" &&
					!frame.content?.text.trim() &&
					!frame.hasActivity
				) {
					record.status = "failed";
					record.error = EMPTY_PROMPT_FAILURE;
					record.outcome = failedOutcomeForError(EMPTY_PROMPT_FAILURE, failureEvidence(record, frame.hasActivity));
				} else if (record.error !== undefined) {
					record.status = "failed";
					record.outcome = failedOutcomeForError(record.error, failureEvidence(record, frame.hasActivity));
				} else record.status = "terminal_ok";
				record.receiptState = reduceReceiptState(
					record.receiptState,
					reportableTurnResultContent(record.content) ? "present" : "missing",
				);
			}
			cleanupRecords(candidate);
			return { value: undefined, changed: true };
		});
	};

	const claimPendingOutcome = async (
		kind: ReconciliationKind,
		correlation: PromptCorrelation,
		outcome: SdkPromptTerminalOutcome,
		receiptState?: Extract<ReceiptState, "present" | "missing">,
	): Promise<SdkPromptTerminalOutcome> =>
		await queueMutation(candidate => {
			const normalized = normalizeTerminalOutcome(outcome) ?? outcome;
			const record = candidate.get(keyOf(kind, correlation));
			if (!record || record.terminalAt !== undefined || record.kind !== kind)
				return { value: normalized, changed: false };
			if (record.pendingOutcome !== undefined) return { value: record.pendingOutcome, changed: false };
			const decorated = rephaseFailedOutcome(normalized, failureEvidence(record));
			record.pendingOutcome = decorated;
			record.pendingReceiptState = receiptState;
			return { value: decorated, changed: true };
		});

	const finalizeOutcome = async (
		kind: ReconciliationKind,
		correlation: PromptCorrelation,
		outcome?: SdkPromptTerminalOutcome,
		arg4?: (() => boolean) | { code: string; message: string },
		arg5?: { code: string; message: string } | unknown,
		arg6?: unknown,
	) => {
		const isCurrent = typeof arg4 === "function" ? arg4 : typeof arg6 === "function" ? arg6 : undefined;
		const recordError =
			typeof arg4 === "object" && arg4 !== null && "code" in arg4
				? arg4
				: typeof arg5 === "object" && arg5 !== null && "code" in arg5
					? (arg5 as { code: string; message: string })
					: undefined;
		const content =
			typeof arg4 === "function" ? arg6 : typeof arg5 === "object" && arg5 !== null && "code" in arg5 ? arg6 : arg5;
		const sanitizedContent = sanitizeTurnResultContent(content);
		await queueMutation(candidate => {
			if (isCurrent !== undefined && !isCurrent()) return { value: undefined, changed: false };
			const record = candidate.get(keyOf(kind, correlation));
			if (!record || record.terminalAt !== undefined || record.kind !== kind)
				return { value: undefined, changed: false };
			const requestedOutcome = normalizeTerminalOutcome(outcome, failureEvidence(record)) ?? record.pendingOutcome;
			const providerErrorRecord = record.error;
			const providerError =
				providerErrorRecord !== undefined && providerErrorRecord.code !== "prompt_deadline_exceeded";
			const requestedProviderCode = requestedOutcome?.kind === "failed" ? requestedOutcome.providerCode : undefined;
			const finalOutcome = providerError
				? failedOutcomeForError(providerErrorRecord, failureEvidence(record), requestedProviderCode)
				: requestedOutcome?.kind === "stopped"
					? requestedOutcome
					: providerError &&
							(requestedOutcome === undefined ||
								(requestedOutcome.kind === "failed" && isDeadlineOutcome(requestedOutcome)))
						? failedOutcomeForError(providerErrorRecord, failureEvidence(record), requestedProviderCode)
						: requestedOutcome;
			record.terminalAt = now();
			if (finalOutcome?.kind === "failed") {
				record.status = "failed";
				if (recordError !== undefined && !(providerError && recordError.code === "prompt_deadline_exceeded"))
					record.error = { code: recordError.code, message: finalOutcome.message };
				else if (providerError && providerErrorRecord !== undefined)
					record.error = { code: providerErrorRecord.code, message: finalOutcome.message };
				else record.error = { code: finalOutcome.code, message: finalOutcome.message };
			} else if (
				kind === "prompt" &&
				((finalOutcome === undefined && !sanitizedContent?.text.trim()) ||
					(finalOutcome?.kind !== "stopped" && content !== undefined && !sanitizedContent?.text.trim()))
			) {
				record.status = "failed";
				record.error = EMPTY_PROMPT_FAILURE;
				record.outcome = failedOutcomeForError(EMPTY_PROMPT_FAILURE, failureEvidence(record));
			} else if (finalOutcome?.kind === "stopped") {
				// A stopped terminal is authoritative only when no provider failure
				// was recorded before finalization.
				record.status = "terminal_ok";
				delete record.error;
			} else record.status = "terminal_ok";
			record.content = reduceTurnResultContent(record.content, sanitizedContent);
			if (record.status !== "failed" || record.outcome === undefined) record.outcome = finalOutcome;
			record.receiptState = reduceReceiptState(
				record.receiptState,
				reportableTurnResultContent(record.content) ? "present" : (record.pendingReceiptState ?? "unknown"),
			);
			delete record.pendingOutcome;
			delete record.pendingReceiptState;
			cleanupRecords(candidate);
			return { value: undefined, changed: true };
		});
	};

	const markUncertain = async (
		kind: ReconciliationKind,
		correlation: PromptCorrelation,
		isCurrent?: () => boolean,
		deadlineMaxAt?: number,
	) => {
		await queueMutation(candidate => {
			if (isCurrent !== undefined && !isCurrent()) return { value: undefined, changed: false };
			const record = candidate.get(keyOf(kind, correlation));
			if (!record || record.kind !== kind) return { value: undefined, changed: false };
			const wasDeadlineFailure = record.status === "failed" && record.error?.code === "prompt_deadline_exceeded";
			if (!wasDeadlineFailure && record.terminalAt !== undefined) return { value: undefined, changed: false };
			record.status = record.startedAt === undefined ? "accepted" : "in_flight";
			delete record.terminalAt;
			delete record.outcome;
			delete record.pendingOutcome;
			delete record.pendingReceiptState;
			delete record.receiptState;
			if (record.error?.code === "prompt_deadline_exceeded" || !isPreservedProviderFailure(record.error?.code))
				delete record.error;
			record.deadlineRecoveryPending = true;
			if (deadlineMaxAt !== undefined) record.deadlineMaxAt = deadlineMaxAt;
			return { value: undefined, changed: true };
		});
	};

	const peekPendingOutcome = (kind: ReconciliationKind, correlation: PromptCorrelation) =>
		records.get(keyOf(kind, correlation))?.pendingOutcome;

	const lookup = (
		kind: ReconciliationKind,
		selector: { commandId?: string; turnId?: string; clientRef?: string },
	): TurnPromptReconciliation => {
		cleanup();
		const key =
			selector.clientRef !== undefined
				? clientRefIndex.get(refKey(kind, selector.clientRef))
				: selector.commandId !== undefined && selector.turnId !== undefined
					? keyOf(kind, { commandId: selector.commandId, turnId: selector.turnId })
					: undefined;
		const record = key === undefined ? undefined : records.get(key);
		if (!record) return { status: "unknown", receiptState: "unknown" };
		if (record.kind === "steer") return { status: "unknown", receiptState: "unknown" };
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
			...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
		};
		if (record.status === "terminal_ok")
			return {
				status: "terminal_ok",
				...terminal,
				...(record.error !== undefined ? { error: record.error } : {}),
			};
		return { status: "failed", ...terminal, error: record.error ?? sanitizePromptFailure(undefined) };
	};

	const lookupResult = (
		kind: ReconciliationKind,
		selector: { commandId?: string; turnId?: string; clientRef?: string },
	): TurnResultPage => {
		cleanup();
		const key =
			selector.clientRef !== undefined
				? clientRefIndex.get(refKey(kind, selector.clientRef))
				: selector.commandId !== undefined && selector.turnId !== undefined
					? keyOf(kind, { commandId: selector.commandId, turnId: selector.turnId })
					: undefined;
		const record = key === undefined ? undefined : records.get(key);
		if (!record || record.kind === "steer") return { status: "unknown", receiptState: "unknown" };
		const identity = {
			// Durable terminal markers (kind "terminal") are not prompt/skill
			// invocation pages: never surface them under a prompt/skill kind.
			kind: record.kind === "terminal" ? undefined : record.kind,
			commandId: record.commandId,
			turnId: record.turnId,
			...(record.clientRef !== undefined ? { clientRef: record.clientRef } : {}),
			acceptedAt: record.acceptedAt,
		};
		if (record.status === "accepted") return { status: "accepted", receiptState: "absent", ...identity };
		if (record.status === "in_flight")
			return { status: "in_flight", receiptState: "absent", ...identity, startedAt: record.startedAt };
		const terminal = {
			...identity,
			...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
			terminalAt: record.terminalAt as number,
			receiptState: record.receiptState ?? "unknown",
			...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
			...(reportableTurnResultContent(record.content) ? { content: record.content } : {}),
		};
		if (record.status === "terminal_ok")
			return {
				status: "terminal_ok",
				...terminal,
				...(record.error !== undefined ? { error: record.error } : {}),
			};
		return { status: "failed", ...terminal, error: record.error ?? sanitizePromptFailure(undefined) };
	};
	const hydrateFromStore = async () => {
		if (!store) return;
		const run = async () => {
			const loaded = (await store.load()).filter(record => ownedKinds.has(record.kind));
			let sanitizedDurableRecord = false;
			const candidate = new Map(
				loaded.map(record => {
					const safeOutcome = (
						outcome: SdkPromptTerminalOutcome | undefined,
					): SdkPromptTerminalOutcome | undefined => {
						if (outcome?.kind !== "failed") return outcome;
						const rephased = rephaseFailedOutcome(
							outcome,
							record.startedAt !== undefined ? { startedAt: record.startedAt } : {},
						);
						// Legacy durable rows carry a generic message and no phase/category;
						// rewriting them to the current contract is a durable-state sanitization.
						if (
							rephased.kind === "failed" &&
							(outcome.phase !== rephased.phase ||
								outcome.category !== rephased.category ||
								outcome.message !== rephased.message)
						)
							sanitizedDurableRecord = true;
						return rephased;
					};
					let hydrated: DurableReconciliationRecord;
					if (record.kind === "steer") {
						const safeError = record.error === undefined ? undefined : sanitizePromptFailure(record.error);
						if (
							record.error !== undefined &&
							(safeError?.code !== record.error.code || safeError.message !== record.error.message)
						)
							sanitizedDurableRecord = true;
						hydrated =
							record.status === "accepted"
								? {
										...record,
										status: "uncertain",
										settledAt: now(),
										error: {
											code: "process_restart_uncertain",
											message: "Steer delivery cannot be proven after process restart.",
										},
									}
								: { ...record, ...(safeError === undefined ? {} : { error: safeError }) };
					} else {
						hydrated = {
							...record,
							...(record.error === undefined ? {} : { error: sanitizePromptFailure(record.error) }),
							outcome: safeOutcome(record.outcome),
							pendingOutcome: safeOutcome(record.pendingOutcome),
						};
					}
					return [
						record.kind === "steer" ? steerKey(record.clientRef) : keyOf(record.kind, record),
						hydrated,
					] as const;
				}),
			);
			const candidateIndex = indexRecords(candidate);
			// Persist only when hydration settled accepted steers to uncertain: an
			// unconditional transact emits a rename on every startup even for empty
			// stores, which a test pause hook or slow fs can intercept before any
			// prompt/skill admission — stalling reconciliationReady so a concurrent
			// abort misses the not-yet-registered pending preflight entry (#4522).
			const settledSteers = loaded.some(record => record.kind === "steer" && record.status === "accepted");
			if (settledSteers || sanitizedDurableRecord)
				await store.transact(current => [
					...current.filter(record => !ownedKinds.has(record.kind)),
					...[...candidate.values()].filter(record => ownedKinds.has(record.kind)).map(record => ({ ...record })),
				]);
			records = candidate;
			clientRefIndex = candidateIndex;
		};
		const pending = mutationChain.then(run, run);
		mutationChain = pending.then(
			() => undefined,
			() => undefined,
		);
		await pending;
	};
	const drain = async (): Promise<void> => {
		while (true) {
			const observed = mutationChain;
			await observed;
			// A noteTransition/noteAccepted admitted in a later microtask must still
			// be joined before teardown reports durable quiescence (#4743).
			await Bun.sleep(0);
			if (mutationChain === observed) {
				await store?.drain?.();
				return;
			}
		}
	};

	return {
		admit,
		releaseAdmission,
		noteAccepted,
		noteTransition,
		claimPendingOutcome,
		finalizeOutcome,
		markUncertain,
		peekPendingOutcome,
		lookup,
		lookupResult,
		cleanup,
		activeCount,
		hydrateFromStore,
		reserveSteer,
		settleSteer,
		lookupSteer,
		drain,
	};
}

export type { PromptReconciliationStatus };
