import { createHash, randomUUID } from "node:crypto";

/**
 * Kind-aware invocation reconciliation (prompt | skill) with optional durable store.
 * Preserves Q26 admit/first-terminal/capacity semantics; indexes and caps are per-kind.
 */

import { sanitizePromptFailure } from "../prompt-failure";
import type { PromptReconciliationStatus, SdkPromptTerminalOutcome, TurnPromptReconciliation } from "../prompt-status";
import type { ReceiptState } from "../receipt-state";
import { sanitizeTurnResultContent, type TurnResultContent, type TurnResultPage } from "../turn-result";
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
			| { type: "agent_start" | "agent_end"; content?: TurnResultContent }
			| { type: "agent_failed"; error: unknown; content?: TurnResultContent },
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
			| { type: "agent_start" | "agent_end"; content?: TurnResultContent }
			| { type: "agent_failed"; error: unknown; content?: TurnResultContent },
	) => {
		if (!correlation) return;
		await queueMutation(candidate => {
			const record = candidate.get(keyOf(kind, correlation));
			if (!record || record.kind === "steer") return { value: undefined, changed: false };
			if (record.terminalAt !== undefined) {
				// The terminal is claimed by one delivery path while the reason arrives on
				// another, so ordering is not the caller's to control. A late agent_failed
				// enriches the settled record instead of being dropped; it must not resurrect
				// it, so status, terminalAt, retention order, and the clientRef index stay
				// as-is (cleanupRecords is intentionally not re-run). First reason wins: a
				// late generic frame never overwrites a specific one. Persisted so the reason
				// survives reconnect/restart reconciliation.
				if (frame.type === "agent_failed") {
					const failure = sanitizePromptFailure(frame.error);
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
				if (frame.content) record.content = sanitizeTurnResultContent(frame.content.text);
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
			delete record.deadlineRecoveryPending;
			delete record.deadlineMaxAt;
			record.terminalAt = now();
			if (frame.content) record.content = sanitizeTurnResultContent(frame.content.text);
			if (pendingOutcome !== undefined) {
				const terminalOutcome =
					record.error !== undefined && pendingOutcome.kind !== "failed"
						? {
								kind: "failed" as const,
								code: "prompt_failed" as const,
								message: record.error.message,
								provenance: "agent_failed" as const,
							}
						: pendingOutcome;
				record.outcome = terminalOutcome;
				record.pendingOutcome = undefined;
				if (terminalOutcome.kind === "failed") {
					record.status = "failed";
					record.error = { code: terminalOutcome.code, message: terminalOutcome.message };
				} else {
					record.status = "terminal_ok";
				}
				record.receiptState = record.pendingReceiptState ?? "missing";
				record.pendingReceiptState = undefined;
			} else {
				record.status = record.error === undefined ? "terminal_ok" : "failed";
				record.receiptState = frame.content?.text?.trim() ? "present" : "missing";
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
			const record = candidate.get(keyOf(kind, correlation));
			if (!record || record.terminalAt !== undefined || record.kind !== kind)
				return { value: outcome, changed: false };
			if (record.pendingOutcome !== undefined) return { value: record.pendingOutcome, changed: false };
			record.pendingOutcome = outcome;
			record.pendingReceiptState = receiptState;
			return { value: outcome, changed: true };
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
		await queueMutation(candidate => {
			if (isCurrent !== undefined && !isCurrent()) return { value: undefined, changed: false };
			const record = candidate.get(keyOf(kind, correlation));
			if (!record || record.terminalAt !== undefined || record.kind !== kind)
				return { value: undefined, changed: false };
			const finalOutcome = outcome ?? record.pendingOutcome;
			record.terminalAt = now();
			if (finalOutcome?.kind === "failed") {
				record.status = "failed";
				record.error = recordError ?? { code: finalOutcome.code, message: finalOutcome.message };
			} else record.status = "terminal_ok";
			record.content = sanitizeTurnResultContent(content);
			record.outcome = finalOutcome;
			record.receiptState = record.pendingReceiptState ?? "unknown";
			record.pendingOutcome = undefined;
			record.pendingReceiptState = undefined;
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
		if (!record || record.kind === "steer") return { status: "unknown" };
		const identity = {
			// Durable terminal markers (kind "terminal") are not prompt/skill
			// invocation pages: never surface them under a prompt/skill kind.
			kind: record.kind === "terminal" ? undefined : record.kind,
			commandId: record.commandId,
			turnId: record.turnId,
			...(record.clientRef !== undefined ? { clientRef: record.clientRef } : {}),
			acceptedAt: record.acceptedAt,
		};
		if (record.status === "accepted") return { status: "accepted", ...identity };
		if (record.status === "in_flight") return { status: "in_flight", ...identity, startedAt: record.startedAt };
		const terminal = {
			...identity,
			...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
			terminalAt: record.terminalAt as number,
			...(record.content !== undefined ? { content: record.content } : {}),
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
			const candidate = new Map(
				loaded.map(record => {
					const hydrated =
						record.kind === "steer" && record.status === "accepted"
							? {
									...record,
									status: "uncertain" as const,
									settledAt: now(),
									error: {
										code: "process_restart_uncertain",
										message: "Steer delivery cannot be proven after process restart.",
									},
								}
							: { ...record };
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
			if (settledSteers)
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
