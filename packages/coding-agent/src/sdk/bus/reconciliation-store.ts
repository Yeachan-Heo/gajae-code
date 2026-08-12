/**
 * Session-scoped durable store for kind-aware invocation reconciliation (#3032/#3035).
 *
 * Path is always a private sibling of the transcript, never under artifactsDir:
 *   <dirname(sessionFile)>/.sdk-reconciliation/<safeSessionId>.json
 *
 * Safe session ids only: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
 * Atomic write: temp + fsync + rename + 0600. Corrupt → quarantine + empty.
 * Non-terminal records with a pending outcome finalize that exact claim on bootstrap.
 * Outcome-less skills retain the existing failed/process_restart settlement.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PromptReconciliationStatus, SdkPromptTerminalOutcome } from "../prompt-status";
import type { ReceiptState } from "../receipt-state";
import { TURN_RESULT_CONTENT_MAX_BYTES, type TurnResultContent } from "../turn-result";
import type { PromptCorrelation } from "./prompt-reconciliation";

export const RECONCILIATION_STORE_VERSION = 2;
export const RECONCILIATION_STORE_VERSION_V1 = 1;
export const RECONCILIATION_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const RECONCILIATION_DIR_NAME = ".sdk-reconciliation";
// Replay-authority hashes are canonical SHA-256 hex digests; anything else in a
// durable document can never match a real retry and would make the reserved key
// invisible (and reusable for an unrelated later abort), so reload rejects it.
const SHA256_RE = /^[0-9a-f]{64}$/;

export function resolveReconciliationSessionFile(
	sessionFile: string | undefined | null,
	stateRoot: string,
	sessionId: string,
): string {
	return sessionFile ?? path.join(stateRoot, `${sessionId}.jsonl`);
}

export type ReconciliationKind = "prompt" | "skill" | "terminal";

export interface DurableExecutionReconciliationRecord extends PromptCorrelation {
	kind: ReconciliationKind;
	clientRef?: string;
	status: PromptReconciliationStatus;
	error?: { code: string; message: string };
	acceptedAt: number;
	startedAt?: number;
	terminalAt?: number;
	outcome?: SdkPromptTerminalOutcome;
	receiptState?: Exclude<ReceiptState, "absent">;
	pendingOutcome?: SdkPromptTerminalOutcome;
	pendingReceiptState?: Extract<ReceiptState, "present" | "missing">;
	/** Skill-only safe token; never skill args bodies. */
	skillName?: string;
	content?: TurnResultContent;
}

/**
 * Durable terminal scope record (approved abort-SDK plan, v2 document).
 * Bounded origin/fence and owned-settlement fields only; no prompt text and no
 * suppressed/deferred receipts for left-running turn work.
 */
export interface DurableTerminalScopeRecord {
	selection: "turn" | "owned";
	/** SHA-256 of the bounded idempotency key; the raw key is never persisted. */
	idempotencyKeyHash?: string;
	/** SHA-256 of the canonicalized normalized input; raw input is never persisted. */
	idempotencyInputHash?: string;
	turnDisposition:
		| "pending"
		| "stopped"
		| "uncertain"
		| "no_effect"
		| "no_effect_reserved"
		| "no_effect_marker_failure";
	/** Whether the correlated agent_end event was published (AC 19). */
	terminalPublished?: boolean;
	ownedWorkDisposition: "not_requested" | "left_running" | "stopped" | "uncertain";
	automaticDeliveryDisposition: "enabled" | "none";
	resumeOnOwnedCompletion: boolean;
	turnContinuationFence: {
		state: "retained" | "released";
		abortedAttemptEpoch: number;
		blockedContinuationIds: string[];
		predecessorTombstones: string[];
		ownedCompletionPolicy: "enabled" | "disabled";
	};
	ownedDeliverySettlements?: Array<{
		keyHash: string;
		entryIdHash: string;
		status: "settled" | "absent" | "uncertain";
		observedAt: number;
	}>;
	responseState: "pending" | "sent" | "delivered" | "failed";
	responsePayloadHash: string;
	/** Hash of the replay-shaped public result a same-key retry delivers, when
	 *  it differs from the original response (the replay appends metadata). */
	replayPayloadHash?: string;
	acceptedAt: number;
	terminalAt?: number;
}

/** Compact evicted-key tombstone with enough disposition metadata to
 *  reconstruct the original terminal replay result (review thread P2). */
export interface EvictedTerminalKeyEntry {
	keyHash: string;
	inputHash: string;
	turnDisposition?: "stopped" | "uncertain" | "no_effect" | "no_effect_reserved" | "no_effect_marker_failure";
	ownedWorkDisposition?: "not_requested" | "left_running" | "stopped" | "uncertain";
	responseState?: "pending" | "sent" | "delivered" | "failed";
	responsePayloadHash?: string;
	replayPayloadHash?: string;
	terminalPublished?: boolean;
}
export interface DurableSteerReconciliationRecord {
	kind: "steer";
	clientRef: string;
	textDigest: string;
	createdAt: number;
	status: "dispatching" | "accepted" | "rejected" | "uncertain";
	settledAt?: number;
	error?: { code: string; message: string };
	commandId: string;
	turnId: string;
	acceptedAt: number;
	startedAt?: never;
	terminalAt?: never;
	outcome?: never;
	receiptState?: never;
	pendingOutcome?: never;
	pendingReceiptState?: never;
	skillName?: never;
}

export type DurableReconciliationRecord = DurableExecutionReconciliationRecord | DurableSteerReconciliationRecord;

export interface ReconciliationStoreDocument {
	version: typeof RECONCILIATION_STORE_VERSION;
	sessionId: string;
	records: DurableReconciliationRecord[];
	terminalScopes?: DurableTerminalScopeRecord[];
	/**
	 * Compact key tombstones for completed terminal rows evicted by the
	 * retention cap: the key hash is retained durably so a same-key retry
	 * after dispatch-cache expiry/restart still replays instead of aborting an
	 * unrelated later prompt (review thread P2).
	 */
	evictedTerminalKeys?: EvictedTerminalKeyEntry[];
}

export interface ReconciliationStoreFs {
	mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
	readFile(file: string, encoding: "utf8"): Promise<string>;
	writeFile(file: string, data: string, options: { mode: number }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	unlink(file: string): Promise<void>;
	open(
		file: string,
		flags: string,
	): Promise<{
		sync(): Promise<void>;
		close(): Promise<void>;
		writeFile(data: string, encoding: "utf8"): Promise<void>;
	}>;
}

const nodeFs: ReconciliationStoreFs = {
	mkdir: fs.mkdir,
	readFile: fs.readFile,
	writeFile: fs.writeFile,
	rename: (from, to) => fs.rename(from, to),
	unlink: fs.unlink,
	open: fs.open as ReconciliationStoreFs["open"],
};

export function isSafeReconciliationSessionId(sessionId: string): boolean {
	return RECONCILIATION_SESSION_ID_PATTERN.test(sessionId);
}

/** Derive private store path; throws if sessionId is unsafe (path escape). */
export function reconciliationStorePath(sessionFile: string, sessionId: string): string {
	if (!isSafeReconciliationSessionId(sessionId))
		throw Object.assign(new Error("Unsafe session id for reconciliation store path."), {
			code: "invalid_input",
		});
	return path.join(path.dirname(sessionFile), RECONCILIATION_DIR_NAME, `${sessionId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Record-level validation: JSON-valid but malformed entries must be quarantined too. */
function isValidRecord(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const { kind } = value;
	if (kind === "steer") {
		if (typeof value.clientRef !== "string" || !value.clientRef) return false;
		if (typeof value.textDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.textDigest)) return false;
		if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
		if (typeof value.commandId !== "string" || !value.commandId || typeof value.turnId !== "string" || !value.turnId)
			return false;
		if (typeof value.acceptedAt !== "number" || !Number.isFinite(value.acceptedAt)) return false;
		if (!["dispatching", "accepted", "rejected", "uncertain"].includes(value.status as string)) return false;
		const settled = value.status !== "dispatching";
		if (settled !== (typeof value.settledAt === "number" && Number.isFinite(value.settledAt))) return false;
		if ((value.status === "rejected" || value.status === "uncertain") !== (value.error !== undefined)) return false;
		if (
			value.error !== undefined &&
			(!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string")
		)
			return false;
		return value.receiptState === undefined && value.outcome === undefined;
	}
	if (kind !== "prompt" && kind !== "skill") return false;
	const {
		commandId,
		turnId,
		status,
		acceptedAt,
		terminalAt,
		outcome,
		pendingOutcome,
		receiptState,
		pendingReceiptState,
	} = value;
	if (typeof commandId !== "string" || !commandId || typeof turnId !== "string" || !turnId) return false;
	if (status !== "accepted" && status !== "in_flight" && status !== "terminal_ok" && status !== "failed") return false;
	if (typeof acceptedAt !== "number" || !Number.isFinite(acceptedAt)) return false;
	if (terminalAt !== undefined && (typeof terminalAt !== "number" || !Number.isFinite(terminalAt))) return false;
	if (receiptState !== undefined && !["present", "missing", "unknown"].includes(receiptState as string)) return false;
	if (pendingReceiptState !== undefined && pendingReceiptState !== "present" && pendingReceiptState !== "missing")
		return false;
	// Durable invariants: only prompts carry a pending receipt claim, a finalized
	// record has no pending claim left, and terminal/active status must agree with
	// `terminalAt`. Prompts and skills may both carry a pending outcome claim.
	if (pendingReceiptState !== undefined && kind !== "prompt") return false;
	if (pendingReceiptState !== undefined && pendingOutcome === undefined) return false;
	if (pendingOutcome !== undefined && terminalAt !== undefined) return false;
	const isTerminalStatus = status === "terminal_ok" || status === "failed";
	if (isTerminalStatus !== (terminalAt !== undefined)) return false;
	if (!isTerminalStatus && receiptState !== undefined) return false;
	if (isTerminalStatus && pendingReceiptState !== undefined) return false;
	if (outcome !== undefined && !isTerminalStatus) return false;
	if (
		outcome !== undefined &&
		((status === "terminal_ok" && (!isRecord(outcome) || outcome.kind !== "stopped")) ||
			(status === "failed" && (!isRecord(outcome) || outcome.kind !== "failed")))
	)
		return false;
	if (value.startedAt !== undefined && (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)))
		return false;
	if (value.clientRef !== undefined && typeof value.clientRef !== "string") return false;
	if (value.skillName !== undefined && typeof value.skillName !== "string") return false;
	if (value.content !== undefined) {
		if (
			!isRecord(value.content) ||
			value.content.version !== 1 ||
			value.content.type !== "text" ||
			typeof value.content.text !== "string" ||
			typeof value.content.byteLength !== "number" ||
			typeof value.content.truncated !== "boolean" ||
			new TextEncoder().encode(value.content.text).length !== value.content.byteLength ||
			value.content.byteLength > TURN_RESULT_CONTENT_MAX_BYTES
		)
			return false;
	}
	if (value.error !== undefined) {
		if (!isRecord(value.error)) return false;
		if (typeof value.error.code !== "string" || typeof value.error.message !== "string") return false;
	}
	return [outcome, pendingOutcome].every(candidate => {
		if (candidate === undefined) return true;
		if (!isRecord(candidate)) return false;
		if (candidate.kind === "stopped")
			return (
				["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(
					candidate.reason as string,
				) && ["agent", "client_cancel"].includes(candidate.provenance as string)
			);
		return (
			candidate.kind === "failed" &&
			["prompt_failed", "prompt_deadline_exceeded"].includes(candidate.code as string) &&
			typeof candidate.message === "string" &&
			["agent_failed", "deadline"].includes(candidate.provenance as string)
		);
	});
}
/** Terminal scope validation: bounded origin/fence/settlement fields only. */
function isValidTerminalScope(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const {
		selection,
		turnDisposition,
		ownedWorkDisposition,
		automaticDeliveryDisposition,
		resumeOnOwnedCompletion,
		turnContinuationFence,
		ownedDeliverySettlements,
		responseState,
		responsePayloadHash,
		replayPayloadHash,
		acceptedAt,
		terminalAt,
		idempotencyKeyHash,
		idempotencyInputHash,
		terminalPublished,
	} = value;
	if (selection !== "turn" && selection !== "owned") return false;
	if (
		turnDisposition !== "pending" &&
		turnDisposition !== "stopped" &&
		turnDisposition !== "uncertain" &&
		turnDisposition !== "no_effect" &&
		turnDisposition !== "no_effect_reserved" &&
		turnDisposition !== "no_effect_marker_failure"
	)
		return false;
	if (
		ownedWorkDisposition !== "not_requested" &&
		ownedWorkDisposition !== "left_running" &&
		ownedWorkDisposition !== "stopped" &&
		ownedWorkDisposition !== "uncertain"
	)
		return false;
	if (automaticDeliveryDisposition !== "enabled" && automaticDeliveryDisposition !== "none") return false;
	if (typeof resumeOnOwnedCompletion !== "boolean") return false;
	if (!isRecord(turnContinuationFence)) return false;
	const { state, abortedAttemptEpoch, blockedContinuationIds, predecessorTombstones, ownedCompletionPolicy } =
		turnContinuationFence;
	if (state !== "retained" && state !== "released") return false;
	if (typeof abortedAttemptEpoch !== "number" || !Number.isFinite(abortedAttemptEpoch)) return false;
	if (!Array.isArray(blockedContinuationIds) || !blockedContinuationIds.every(id => typeof id === "string"))
		return false;
	if (!Array.isArray(predecessorTombstones) || !predecessorTombstones.every(id => typeof id === "string"))
		return false;
	if (ownedCompletionPolicy !== "enabled" && ownedCompletionPolicy !== "disabled") return false;
	if (ownedDeliverySettlements !== undefined) {
		if (!Array.isArray(ownedDeliverySettlements) || ownedDeliverySettlements.length > 256) return false;
		for (const settlement of ownedDeliverySettlements) {
			if (!isRecord(settlement)) return false;
			if (typeof settlement.keyHash !== "string" || !settlement.keyHash) return false;
			if (typeof settlement.entryIdHash !== "string" || !settlement.entryIdHash) return false;
			if (settlement.status !== "settled" && settlement.status !== "absent" && settlement.status !== "uncertain")
				return false;
			if (typeof settlement.observedAt !== "number" || !Number.isFinite(settlement.observedAt)) return false;
		}
	}
	if (
		responseState !== "pending" &&
		responseState !== "sent" &&
		responseState !== "delivered" &&
		responseState !== "failed"
	)
		return false;
	if (typeof responsePayloadHash !== "string" || !responsePayloadHash) return false;
	if (replayPayloadHash !== undefined && (typeof replayPayloadHash !== "string" || !replayPayloadHash)) return false;
	if (typeof idempotencyKeyHash !== "string" || !SHA256_RE.test(idempotencyKeyHash)) return false;
	if (typeof idempotencyInputHash !== "string" || !SHA256_RE.test(idempotencyInputHash)) return false;
	if (terminalPublished !== undefined && typeof terminalPublished !== "boolean") return false;
	if (typeof acceptedAt !== "number" || !Number.isFinite(acceptedAt)) return false;
	if (terminalAt !== undefined && (typeof terminalAt !== "number" || !Number.isFinite(terminalAt))) return false;
	// An incomplete (pending) scope cannot already be terminal.
	if (turnDisposition === "pending" && terminalAt !== undefined) return false;
	return true;
}

/** Evicted tombstones are replay authority, so every optional replay field
 *  is validated before a durable document is trusted. */
function isValidEvictedTerminalKeyEntry(value: unknown): value is EvictedTerminalKeyEntry {
	if (!isRecord(value)) return false;
	if (typeof value.keyHash !== "string" || !SHA256_RE.test(value.keyHash)) return false;
	if (typeof value.inputHash !== "string" || !SHA256_RE.test(value.inputHash)) return false;
	if (
		value.turnDisposition !== undefined &&
		value.turnDisposition !== "stopped" &&
		value.turnDisposition !== "uncertain" &&
		value.turnDisposition !== "no_effect" &&
		value.turnDisposition !== "no_effect_reserved" &&
		value.turnDisposition !== "no_effect_marker_failure"
	)
		return false;
	if (
		value.ownedWorkDisposition !== undefined &&
		value.ownedWorkDisposition !== "not_requested" &&
		value.ownedWorkDisposition !== "left_running" &&
		value.ownedWorkDisposition !== "stopped" &&
		value.ownedWorkDisposition !== "uncertain"
	)
		return false;
	if (
		value.responseState !== undefined &&
		value.responseState !== "pending" &&
		value.responseState !== "sent" &&
		value.responseState !== "delivered" &&
		value.responseState !== "failed"
	)
		return false;
	if (
		value.responsePayloadHash !== undefined &&
		(typeof value.responsePayloadHash !== "string" || !value.responsePayloadHash)
	)
		return false;
	if (
		value.replayPayloadHash !== undefined &&
		(typeof value.replayPayloadHash !== "string" || !value.replayPayloadHash)
	)
		return false;
	if (value.terminalPublished !== undefined && typeof value.terminalPublished !== "boolean") return false;
	return true;
}

function parseDocument(raw: string, expectedSessionId: string): ReconciliationStoreDocument {
	const value = JSON.parse(raw) as unknown;
	if (
		!isRecord(value) ||
		(value.version !== RECONCILIATION_STORE_VERSION && value.version !== RECONCILIATION_STORE_VERSION_V1)
	)
		throw new Error("invalid reconciliation store version");
	if (value.sessionId !== expectedSessionId) throw new Error("session id mismatch");
	if (!Array.isArray(value.records)) throw new Error("invalid records");
	if (!value.records.every(isValidRecord)) throw new Error("invalid reconciliation record");
	// v1 documents migrate to v2 (records only; terminalScopes added later).
	if (value.version === RECONCILIATION_STORE_VERSION_V1)
		return {
			version: RECONCILIATION_STORE_VERSION,
			sessionId: expectedSessionId,
			records: value.records as DurableReconciliationRecord[],
		};
	const terminalScopes = value.terminalScopes;
	if (terminalScopes !== undefined) {
		if (!Array.isArray(terminalScopes)) throw new Error("invalid terminal scopes");
		if (!terminalScopes.every(isValidTerminalScope)) throw new Error("invalid terminal scope");
	}
	const evictedTerminalKeys = value.evictedTerminalKeys;
	if (
		evictedTerminalKeys !== undefined &&
		(!Array.isArray(evictedTerminalKeys) || !evictedTerminalKeys.every(isValidEvictedTerminalKeyEntry))
	) {
		throw new Error("invalid evicted terminal keys");
	}
	return {
		version: RECONCILIATION_STORE_VERSION,
		sessionId: expectedSessionId,
		records: value.records as DurableReconciliationRecord[],
		...(terminalScopes !== undefined ? { terminalScopes: terminalScopes as DurableTerminalScopeRecord[] } : {}),
		...(evictedTerminalKeys !== undefined
			? { evictedTerminalKeys: evictedTerminalKeys as EvictedTerminalKeyEntry[] }
			: {}),
	};
}

/**
 * Settle non-terminal durable records after process death.
 * Any record with a durable pending outcome preserves that exact terminal claim;
 * outcome-less skills retain the existing reconciliation-incomplete result.
 */
/**
 * Settle incomplete terminal scopes (turnDisposition "pending") to safe
 * uncertainty after process death. A terminal scope that never finalized its
 * semantic CAS replays as uncertainty, never as success.
 */
export function settleTerminalScopeRestart(
	scopes: DurableTerminalScopeRecord[],
	now: number,
): DurableTerminalScopeRecord[] {
	return scopes.map(scope => {
		// An abandoned no_effect_reserved reservation (the process exited or the
		// finalize failed after the reservation was written) becomes a completed
		// no_effect so normal retention can evict it: reserved rows are otherwise
		// permanently non-evictable and same-key replay never finalizes them,
		// so repeated crashes with unique idle-abort keys grow the reconciliation
		// document without bound (review thread P2).
		if (scope.turnDisposition === "no_effect_reserved") {
			// The reservation's only deliverable after restart is the
			// metadata-bearing no_active_turn replay; store the replay-shaped
			// payload hash so a written replay can advance the row instead of
			// staying durably pending (review thread P2). The stored
			// responsePayloadHash stays the ORIGINAL placeholder: the delivered
			// replay envelope embeds it, so the replay hash computed from that
			// envelope is the hash the delivery observer will actually compare —
			// replacing the field with the replay hash would make the delivered
			// envelope embed a DIFFERENT value and never advance the row
			// (review thread P2).
			const replayResult = {
				ok: true,
				selection: scope.selection,
				turn: "no_active_turn",
				terminal: "terminal_no_effect",
				replay: {
					responseState: "pending",
					responsePayloadHash: scope.responsePayloadHash,
					terminalPublished: scope.terminalPublished === true,
				},
			};
			const replayPayloadHash = createHash("sha256").update(JSON.stringify(replayResult)).digest("hex");
			return {
				...scope,
				turnDisposition: "no_effect" as const,
				replayPayloadHash,
				terminalAt: scope.terminalAt ?? now,
			};
		}
		if (scope.turnDisposition !== "pending" || scope.terminalAt !== undefined) return scope;
		// A restart-replay is the ONLY response a settled pending row can ever
		// deliver (the process died before the original response was written), so
		// the stored payload hash must describe the replay-shaped public result —
		// the replay appends metadata (reason + replay envelope) that the delivery
		// hash check would otherwise reject forever, leaving the row durably
		// pending (review thread P2).
		const replayResult = {
			ok: true,
			selection: scope.selection,
			turn: "uncertain",
			ownedWork: scope.selection === "turn" ? "left_running" : "uncertain",
			automaticDelivery: scope.selection === "turn" ? "enabled" : "none",
			resumeOnOwnedCompletion: scope.selection === "turn",
			reason: "replay_uncertain",
			replay: {
				responseState: "pending",
				responsePayloadHash: scope.responsePayloadHash,
				terminalPublished: scope.terminalPublished === true,
			},
		};
		const replayPayloadHash = createHash("sha256").update(JSON.stringify(replayResult)).digest("hex");
		return {
			...scope,
			turnDisposition: "uncertain",
			ownedWorkDisposition: scope.ownedWorkDisposition === "not_requested" ? "not_requested" : "uncertain",
			// responsePayloadHash stays the ORIGINAL hash: the delivered replay
			// envelope embeds it, so replayPayloadHash (computed from that
			// envelope) is the hash the delivery observer compares — replacing
			// the field with the replay hash would embed a different value and
			// keep the row durably pending (review thread P2).
			responsePayloadHash: scope.responsePayloadHash,
			replayPayloadHash,
			terminalAt: now,
		};
	});
}
export function settleProcessRestart(
	records: DurableReconciliationRecord[],
	now: number,
): DurableReconciliationRecord[] {
	return records.map(record => {
		if (record.kind === "steer") {
			if (record.status !== "dispatching") return record;
			return {
				...record,
				status: "uncertain",
				settledAt: now,
				error: { code: "process_restart_uncertain", message: "Steer delivery is uncertain after process restart." },
			};
		}
		if (record.terminalAt !== undefined) return record;
		if (record.pendingOutcome !== undefined || record.kind === "prompt") {
			const outcome: SdkPromptTerminalOutcome = record.pendingOutcome ?? {
				kind: "failed",
				code: "prompt_failed",
				message: "Prompt did not complete before process restart.",
				provenance: "agent_failed",
			};
			return {
				...record,
				status: outcome.kind === "stopped" ? "terminal_ok" : "failed",
				terminalAt: now,
				outcome,
				receiptState: record.pendingReceiptState ?? (outcome.kind === "stopped" ? "missing" : "unknown"),
				pendingOutcome: undefined,
				pendingReceiptState: undefined,
				...(outcome.kind === "failed" ? { error: { code: outcome.code, message: outcome.message } } : {}),
			};
		}
		return {
			...record,
			status: "failed",
			terminalAt: now,
			error: { code: "process_restart", message: "Reconciliation incomplete after process restart." },
			receiptState: "unknown",
		};
	});
}

export interface ReconciliationStore {
	readonly path: string | null;
	readonly sessionId: string;
	/** Serialize mutations; reload not required for single-process host (in-memory + write). */
	transact(mutator: (records: DurableReconciliationRecord[]) => DurableReconciliationRecord[]): Promise<void>;
	load(): Promise<DurableReconciliationRecord[]>;
	/** Snapshot currently held in memory after last load/transact. */
	snapshot(): DurableReconciliationRecord[];
	/** Terminal-scope mutations through the same serialized full-document owner. */
	transactTerminalScopes(
		mutator: (scopes: DurableTerminalScopeRecord[]) => DurableTerminalScopeRecord[],
	): Promise<void>;
	transactTerminalState(
		mutator: (state: { scopes: DurableTerminalScopeRecord[]; keys: EvictedTerminalKeyEntry[] }) => {
			scopes: DurableTerminalScopeRecord[];
			keys: EvictedTerminalKeyEntry[];
		},
	): Promise<void>;
	/** Wait until every previously admitted reconciliation transaction settles. */
	drain?(): Promise<void>;
	transactTerminalKeys(mutator: (keys: EvictedTerminalKeyEntry[]) => EvictedTerminalKeyEntry[]): Promise<void>;
	snapshotTerminalKeys(): EvictedTerminalKeyEntry[];
	loadTerminalScopes(): Promise<DurableTerminalScopeRecord[]>;
	/** Snapshot of terminal scopes currently held in memory. */
	snapshotTerminalScopes(): DurableTerminalScopeRecord[];
	delete(): Promise<void>;
}

export function createReconciliationStore(options: {
	sessionFile: string | null | undefined;
	sessionId: string;
	fs?: ReconciliationStoreFs;
	now?: () => number;
}): ReconciliationStore {
	const fileFs = options.fs ?? nodeFs;
	const now = options.now ?? Date.now;
	const sessionId = options.sessionId;
	const filePath =
		options.sessionFile && isSafeReconciliationSessionId(sessionId)
			? reconciliationStorePath(options.sessionFile, sessionId)
			: null;

	let memory: DurableReconciliationRecord[] = [];
	let terminalMemory: DurableTerminalScopeRecord[] = [];
	let terminalKeyMemory: EvictedTerminalKeyEntry[] = [];
	let chain: Promise<void> = Promise.resolve();

	const writeAtomic = async (document: ReconciliationStoreDocument): Promise<void> => {
		if (!filePath) return;
		const directory = path.dirname(filePath);
		await fileFs.mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
		try {
			await fileFs.writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 });
			try {
				const handle = await fileFs.open(temporary, "r+");
				try {
					await handle.sync();
				} finally {
					await handle.close();
				}
			} catch {
				// fsync optional on some fs seams
			}
			await fileFs.rename(temporary, filePath);
		} catch (error) {
			await fileFs.unlink(temporary).catch(() => {});
			throw Object.assign(error instanceof Error ? error : new Error("reconciliation persist failed"), {
				code: "reconciliation_persist_failed",
			});
		}
	};

	const load = async (): Promise<DurableReconciliationRecord[]> => {
		if (!filePath) {
			memory = [];
			terminalMemory = [];
			// No durable store means no evicted-key tombstones either: a store
			// instance that already loaded tombstones must not keep replaying or
			// conflicting on keys that no longer exist on disk (review thread P2).
			terminalKeyMemory = [];
			return memory;
		}
		let raw: string;
		try {
			raw = await fileFs.readFile(filePath, "utf8");
		} catch (error) {
			// Only a missing file is an empty store. Permission/IO failures must propagate
			// so the endpoint never becomes ready as if no prompt had been accepted.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			memory = [];
			terminalMemory = [];
			terminalKeyMemory = [];
			return memory;
		}
		let document: ReconciliationStoreDocument;
		try {
			document = parseDocument(raw, sessionId);
		} catch {
			// Corrupt → quarantine
			try {
				await fileFs.rename(filePath, `${filePath}.corrupt.${now()}`);
			} catch {
				// ignore
			}
			memory = [];
			terminalMemory = [];
			terminalKeyMemory = [];
			return memory;
		}
		const settled = settleProcessRestart(document.records, now());
		const settledTerminal = settleTerminalScopeRestart(document.terminalScopes ?? [], now());
		// Restart settlement must be durable before it is observable: a failed rewrite
		// propagates so the endpoint stays unready instead of serving empty state as if
		// no prompt had ever been accepted.
		const recordsChanged = settled.some((record, index) => record !== document.records[index]);
		const terminalChanged = settledTerminal.some((scope, index) => scope !== (document.terminalScopes ?? [])[index]);
		if (recordsChanged || terminalChanged)
			await writeAtomic({
				version: RECONCILIATION_STORE_VERSION,
				sessionId,
				records: settled,
				...(document.terminalScopes !== undefined || terminalChanged ? { terminalScopes: settledTerminal } : {}),
				...(document.evictedTerminalKeys !== undefined
					? { evictedTerminalKeys: document.evictedTerminalKeys }
					: {}),
			});
		memory = settled;
		terminalMemory = settledTerminal;
		terminalKeyMemory = document.evictedTerminalKeys ?? [];
		return memory;
	};

	const transact = async (
		mutator: (records: DurableReconciliationRecord[]) => DurableReconciliationRecord[],
	): Promise<void> => {
		const run = async () => {
			const next = mutator(memory.map(r => ({ ...r })));
			await writeAtomic({
				version: RECONCILIATION_STORE_VERSION,
				sessionId,
				records: next,
				...(terminalMemory.length > 0 ? { terminalScopes: terminalMemory } : {}),
				...(terminalKeyMemory.length > 0 ? { evictedTerminalKeys: terminalKeyMemory } : {}),
			});
			memory = next;
		};
		const pending = chain.then(run, run);
		chain = pending.then(
			() => undefined,
			() => undefined,
		);
		await pending;
	};

	const transactTerminalScopes = async (
		mutator: (scopes: DurableTerminalScopeRecord[]) => DurableTerminalScopeRecord[],
	): Promise<void> => {
		const run = async () => {
			const next = mutator(terminalMemory.map(s => ({ ...s })));
			await writeAtomic({
				version: RECONCILIATION_STORE_VERSION,
				sessionId,
				records: memory,
				...(next.length > 0 ? { terminalScopes: next } : {}),
				...(terminalKeyMemory.length > 0 ? { evictedTerminalKeys: terminalKeyMemory } : {}),
			});
			terminalMemory = next;
		};
		const pending = chain.then(run, run);
		chain = pending.then(
			() => undefined,
			() => undefined,
		);
		await pending;
	};

	const transactTerminalState = async (
		mutator: (state: { scopes: DurableTerminalScopeRecord[]; keys: EvictedTerminalKeyEntry[] }) => {
			scopes: DurableTerminalScopeRecord[];
			keys: EvictedTerminalKeyEntry[];
		},
	): Promise<void> => {
		const run = async () => {
			const next = mutator({
				scopes: terminalMemory.map(s => ({ ...s })),
				keys: terminalKeyMemory.map(k => ({ ...k })),
			});
			await writeAtomic({
				version: RECONCILIATION_STORE_VERSION,
				sessionId,
				records: memory,
				...(next.scopes.length > 0 ? { terminalScopes: next.scopes } : {}),
				...(next.keys.length > 0 ? { evictedTerminalKeys: next.keys } : {}),
			});
			terminalMemory = next.scopes;
			terminalKeyMemory = next.keys;
		};
		const pending = chain.then(run, run);
		chain = pending.then(
			() => undefined,
			() => undefined,
		);
		await pending;
	};

	const transactTerminalKeys = async (
		mutator: (keys: EvictedTerminalKeyEntry[]) => EvictedTerminalKeyEntry[],
	): Promise<void> => {
		const run = async () => {
			const next = mutator(terminalKeyMemory.map(k => ({ ...k })));
			await writeAtomic({
				version: RECONCILIATION_STORE_VERSION,
				sessionId,
				records: memory,
				...(terminalMemory.length > 0 ? { terminalScopes: terminalMemory } : {}),
				...(next.length > 0 ? { evictedTerminalKeys: next } : {}),
			});
			terminalKeyMemory = next;
		};
		const pending = chain.then(run, run);
		chain = pending.then(
			() => undefined,
			() => undefined,
		);
		await pending;
	};

	const deleteStore = async (): Promise<void> => {
		memory = [];
		terminalMemory = [];
		terminalKeyMemory = [];
		if (!filePath) return;
		await fileFs.unlink(filePath).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	};

	return {
		path: filePath,
		sessionId,
		transact,
		load,
		snapshot: () => memory.map(r => ({ ...r })),
		transactTerminalScopes,
		transactTerminalState,
		transactTerminalKeys,
		drain: async () => {
			while (true) {
				const observed = chain;
				await observed;
				// Fire-and-forget frame handlers can enqueue their first transaction in
				// a later microtask. Yield once and require the queue tail to remain
				// stable before reporting durable quiescence.
				await Bun.sleep(0);
				if (chain === observed) return;
			}
		},
		loadTerminalScopes: async () => {
			await load();
			return terminalMemory.map(s => ({ ...s }));
		},
		snapshotTerminalScopes: () => terminalMemory.map(s => ({ ...s })),
		snapshotTerminalKeys: () => terminalKeyMemory.map(k => ({ ...k })),
		delete: deleteStore,
	};
}
