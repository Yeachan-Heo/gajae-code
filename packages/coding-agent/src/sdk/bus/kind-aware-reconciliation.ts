/**
 * Kind-aware invocation reconciliation (prompt | skill) with optional durable store.
 * Preserves Q26 admit/first-terminal/capacity/TTL semantics; indexes and caps are per-kind.
 */
import type { PromptReconciliationStatus, SdkPromptTerminalOutcome, TurnPromptReconciliation } from "../prompt-status";
import {
	PROMPT_RECONCILIATION_ACTIVE_CAPACITY,
	PROMPT_RECONCILIATION_TERMINAL_CAPACITY,
	PROMPT_RECONCILIATION_TERMINAL_TTL_MS,
	type PromptCorrelation,
	sanitizePromptFailure,
} from "./prompt-reconciliation";
import type { DurableReconciliationRecord, ReconciliationKind, ReconciliationStore } from "./reconciliation-store";

export type { ReconciliationKind };

export interface KindCorrelation extends PromptCorrelation {
	kind: ReconciliationKind;
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
		frame: { type: "agent_start" | "agent_end" } | { type: "agent_failed"; error: unknown },
	): Promise<void>;
	claimPendingOutcome(
		correlation: PromptCorrelation,
		outcome: SdkPromptTerminalOutcome,
	): Promise<SdkPromptTerminalOutcome>;
	finalizePromptOutcome(
		correlation: PromptCorrelation,
		outcome?: SdkPromptTerminalOutcome,
		recordError?: { code: string; message: string },
	): Promise<void>;
	peekPendingOutcome(correlation: PromptCorrelation): SdkPromptTerminalOutcome | undefined;
	lookup(
		kind: ReconciliationKind,
		selector: { commandId?: string; turnId?: string; clientRef?: string },
	): TurnPromptReconciliation;
	cleanup(): void;
	activeCount(kind: ReconciliationKind): number;
	/** Hydrate from durable store (call once at session host start). */
	hydrateFromStore(): Promise<void>;
}

export function createKindAwareReconciliation(
	options: { now?: () => number; store?: ReconciliationStore | null } = {},
): KindAwareReconciliation {
	const now = options.now ?? Date.now;
	const store = options.store ?? null;
	let records = new Map<string, DurableReconciliationRecord>();
	let clientRefIndex = new Map<string, string>();
	const reservedClientRefs = new Map<ReconciliationKind, Set<string>>();
	const reservations: Array<{ kind: ReconciliationKind; clientRef?: string }> = [];
	let mutationChain: Promise<void> = Promise.resolve();

	const keyOf = (kind: ReconciliationKind, correlation: PromptCorrelation) =>
		`${kind}:${correlation.commandId}:${correlation.turnId}`;
	const refKey = (kind: ReconciliationKind, clientRef: string) => `${kind}\0${clientRef}`;

	const indexRecords = (source: Map<string, DurableReconciliationRecord>) => {
		const index = new Map<string, string>();
		for (const [key, record] of source)
			if (record.clientRef !== undefined) index.set(refKey(record.kind, record.clientRef), key);
		return index;
	};

	const cleanupRecords = (source: Map<string, DurableReconciliationRecord>) => {
		const at = now();
		for (const [key, record] of source)
			if (record.terminalAt !== undefined && record.terminalAt + PROMPT_RECONCILIATION_TERMINAL_TTL_MS <= at)
				source.delete(key);
		for (const kind of ["prompt", "skill"] as const) {
			const terminalEntries = [...source.entries()].filter(
				([, record]) => record.kind === kind && record.terminalAt !== undefined,
			);
			if (terminalEntries.length <= PROMPT_RECONCILIATION_TERMINAL_CAPACITY) continue;
			terminalEntries.sort((a, b) => (a[1].terminalAt as number) - (b[1].terminalAt as number));
			for (const [key] of terminalEntries.slice(0, terminalEntries.length - PROMPT_RECONCILIATION_TERMINAL_CAPACITY))
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
			if (store) await store.transact(() => [...candidate.values()].map(record => ({ ...record })));
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
		for (const record of records.values()) if (record.kind === kind && record.terminalAt === undefined) count++;
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
		frame: { type: "agent_start" | "agent_end" } | { type: "agent_failed"; error: unknown },
	) => {
		if (!correlation) return;
		await queueMutation(candidate => {
			const record = candidate.get(keyOf(kind, correlation));
			if (!record || record.terminalAt !== undefined) return { value: undefined, changed: false };
			if (frame.type === "agent_start") {
				if (record.status !== "accepted") return { value: undefined, changed: false };
				record.status = "in_flight";
				record.startedAt = now();
				return { value: undefined, changed: true };
			}
			record.terminalAt = now();
			if (frame.type === "agent_failed") {
				record.status = "failed";
				record.error = sanitizePromptFailure(frame.error);
			} else record.status = "terminal_ok";
			cleanupRecords(candidate);
			return { value: undefined, changed: true };
		});
	};

	const claimPendingOutcome = async (
		correlation: PromptCorrelation,
		outcome: SdkPromptTerminalOutcome,
	): Promise<SdkPromptTerminalOutcome> =>
		await queueMutation(candidate => {
			const record = candidate.get(keyOf("prompt", correlation));
			if (!record || record.terminalAt !== undefined || record.kind !== "prompt")
				return { value: outcome, changed: false };
			if (record.pendingOutcome !== undefined) return { value: record.pendingOutcome, changed: false };
			record.pendingOutcome = outcome;
			return { value: outcome, changed: true };
		});

	const finalizePromptOutcome = async (
		correlation: PromptCorrelation,
		outcome?: SdkPromptTerminalOutcome,
		recordError?: { code: string; message: string },
	) => {
		await queueMutation(candidate => {
			const record = candidate.get(keyOf("prompt", correlation));
			if (!record || record.terminalAt !== undefined || record.kind !== "prompt")
				return { value: undefined, changed: false };
			const finalOutcome = outcome ?? record.pendingOutcome;
			record.terminalAt = now();
			if (finalOutcome?.kind === "failed") {
				record.status = "failed";
				record.error = recordError ?? { code: finalOutcome.code, message: finalOutcome.message };
			} else record.status = "terminal_ok";
			record.outcome = finalOutcome;
			record.pendingOutcome = undefined;
			cleanupRecords(candidate);
			return { value: undefined, changed: true };
		});
	};

	const peekPendingOutcome = (correlation: PromptCorrelation) =>
		records.get(keyOf("prompt", correlation))?.pendingOutcome;

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
		if (!record) return { status: "unknown" };
		const identity = {
			commandId: record.commandId,
			turnId: record.turnId,
			...(record.clientRef !== undefined ? { clientRef: record.clientRef } : {}),
			acceptedAt: record.acceptedAt,
		};
		if (record.status === "accepted") return { status: "accepted", ...identity };
		if (record.status === "in_flight")
			return { status: "in_flight", ...identity, startedAt: record.startedAt as number };
		const terminal = {
			...identity,
			...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
			terminalAt: record.terminalAt as number,
			...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
		};
		if (record.status === "terminal_ok") return { status: "terminal_ok", ...terminal };
		return { status: "failed", ...terminal, error: record.error ?? sanitizePromptFailure(undefined) };
	};

	const hydrateFromStore = async () => {
		if (!store) return;
		const run = async () => {
			const loaded = await store.load();
			const candidate = new Map(loaded.map(record => [keyOf(record.kind, record), { ...record }] as const));
			const candidateIndex = indexRecords(candidate);
			await store.transact(() => [...candidate.values()].map(record => ({ ...record })));
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

	return {
		admit,
		releaseAdmission,
		noteAccepted,
		noteTransition,
		claimPendingOutcome,
		finalizePromptOutcome,
		peekPendingOutcome,
		lookup,
		cleanup,
		activeCount,
		hydrateFromStore,
	};
}

export type { PromptReconciliationStatus };
