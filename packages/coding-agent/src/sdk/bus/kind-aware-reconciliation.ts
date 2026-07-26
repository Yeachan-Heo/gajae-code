/**
 * Kind-aware invocation reconciliation (prompt | skill) with optional durable store.
 * Preserves Q26 admit/first-terminal/capacity/TTL semantics; indexes and caps are per-kind.
 */
import {
	PROMPT_RECONCILIATION_ACTIVE_CAPACITY,
	PROMPT_RECONCILIATION_TERMINAL_CAPACITY,
	PROMPT_RECONCILIATION_TERMINAL_TTL_MS,
	type PromptCorrelation,
	type PromptReconciliationStatus,
	sanitizePromptFailure,
	type TurnPromptReconciliation,
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
	const records = new Map<string, DurableReconciliationRecord>();
	const clientRefIndex = new Map<string, string>(); // `${kind}\0${clientRef}` -> key
	const reservedClientRefs = new Map<ReconciliationKind, Set<string>>();
	const reservations: Array<{ kind: ReconciliationKind; clientRef?: string }> = [];

	const keyOf = (kind: ReconciliationKind, correlation: PromptCorrelation) =>
		`${kind}:${correlation.commandId}:${correlation.turnId}`;
	const refKey = (kind: ReconciliationKind, clientRef: string) => `${kind}\0${clientRef}`;

	const reservedFor = (kind: ReconciliationKind) => {
		let set = reservedClientRefs.get(kind);
		if (!set) {
			set = new Set();
			reservedClientRefs.set(kind, set);
		}
		return set;
	};

	const remove = (key: string) => {
		const record = records.get(key);
		if (!record) return;
		records.delete(key);
		if (record.clientRef !== undefined) {
			const rk = refKey(record.kind, record.clientRef);
			if (clientRefIndex.get(rk) === key) clientRefIndex.delete(rk);
		}
	};

	const cleanup = () => {
		const at = now();
		for (const [key, record] of records)
			if (record.terminalAt !== undefined && record.terminalAt + PROMPT_RECONCILIATION_TERMINAL_TTL_MS <= at)
				remove(key);
		for (const kind of ["prompt", "skill"] as const) {
			const terminalEntries = [...records.entries()].filter(
				([, record]) => record.kind === kind && record.terminalAt !== undefined,
			);
			if (terminalEntries.length <= PROMPT_RECONCILIATION_TERMINAL_CAPACITY) continue;
			terminalEntries.sort((a, b) => (a[1].terminalAt as number) - (b[1].terminalAt as number));
			for (const [key] of terminalEntries.slice(0, terminalEntries.length - PROMPT_RECONCILIATION_TERMINAL_CAPACITY))
				remove(key);
		}
	};

	const activeCount = (kind: ReconciliationKind) => {
		let count = 0;
		for (const record of records.values()) if (record.kind === kind && record.terminalAt === undefined) count++;
		return count;
	};

	const reservationCount = (kind: ReconciliationKind) => reservations.filter(r => r.kind === kind).length;

	const consumeReservation = (kind: ReconciliationKind, clientRef?: string) => {
		const index = reservations.findIndex(r => r.kind === kind && r.clientRef === clientRef);
		if (index === -1) return;
		reservations.splice(index, 1);
		if (clientRef !== undefined && !reservations.some(r => r.kind === kind && r.clientRef === clientRef))
			reservedFor(kind).delete(clientRef);
	};

	const persist = async () => {
		if (!store) return;
		await store.transact(() => [...records.values()].map(r => ({ ...r })));
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
		cleanup();
		consumeReservation(kind, clientRef);
		const at = now();
		const key = keyOf(kind, correlation);
		const record: DurableReconciliationRecord = {
			kind,
			commandId: correlation.commandId,
			turnId: correlation.turnId,
			...(clientRef !== undefined ? { clientRef } : {}),
			status: "accepted",
			acceptedAt: at,
			...(extra?.skillName ? { skillName: extra.skillName } : {}),
		};
		records.set(key, record);
		if (clientRef !== undefined) clientRefIndex.set(refKey(kind, clientRef), key);
		await persist();
	};

	const noteTransition = async (
		kind: ReconciliationKind,
		correlation: PromptCorrelation | undefined,
		frame: { type: "agent_start" | "agent_end" } | { type: "agent_failed"; error: unknown },
	) => {
		if (!correlation) return;
		const record = records.get(keyOf(kind, correlation));
		if (!record || record.terminalAt !== undefined) return;
		if (frame.type === "agent_start") {
			if (record.status === "accepted") {
				record.status = "in_flight";
				record.startedAt = now();
				await persist();
			}
			return;
		}
		record.terminalAt = now();
		if (frame.type === "agent_failed") {
			record.status = "failed";
			record.error = sanitizePromptFailure(frame.error);
		} else {
			record.status = "terminal_ok";
		}
		cleanup();
		await persist();
	};

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
		};
		if (record.status === "terminal_ok") return { status: "terminal_ok", ...terminal };
		return { status: "failed", ...terminal, error: record.error ?? sanitizePromptFailure(undefined) };
	};

	const hydrateFromStore = async () => {
		if (!store) return;
		const loaded = await store.load();
		records.clear();
		clientRefIndex.clear();
		for (const record of loaded) {
			const key = keyOf(record.kind, record);
			records.set(key, record);
			if (record.clientRef !== undefined) clientRefIndex.set(refKey(record.kind, record.clientRef), key);
		}
	};

	return {
		admit,
		releaseAdmission,
		noteAccepted,
		noteTransition,
		lookup,
		cleanup,
		activeCount,
		hydrateFromStore,
	};
}

export type { PromptReconciliationStatus };
