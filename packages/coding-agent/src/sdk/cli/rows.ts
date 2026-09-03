/**
 * Versioned DTO rows for `gjc sdk session` semantic verbs (row DTO v2, DR-12).
 *
 * Every semantic verb renders its output through these rows so machine
 * consumers get one deterministic, versioned envelope per verb. Credentials
 * are never part of the row schema: broker `session.list` rows carry no
 * credentials, and pass-through host payloads are redacted recursively before
 * rendering.
 */

export const SESSION_ROWS_VERSION = 2;

export type SdkSessionActivityState = "active" | "idle";

export interface SdkSessionActivityV1 {
	state: SdkSessionActivityState;
	at: number;
}

export interface SdkSessionRowV1 {
	sessionId: string;
	locator: { cwd: string; worktreeRoot: string | null; stateRoot: string };
	endpointGeneration: number;
	/** Process-bound incarnation of the hosting process (C1); absent for legacy-provenance rows. */
	hostIncarnation?: string;
	pid: number;
	live: boolean;
	/** Tombstone flag (C4): deleted sessions are excluded from list/endpoint/resumable surfaces. */
	deleted: boolean;
	indexSeq: number;
	terminalUncertain?: boolean;
	lifecycleRequestId?: string;
	endpointMtimeMs?: number;
	/** Coalesced broker-owned heartbeat checkpoint (C2). */
	activity?: SdkSessionActivityV1;
	/** Wall-clock timestamp of the latest admitted heartbeat, when one exists. */
	lastHeartbeatAt?: number;
	/** "legacy" for v1/v2-era rows that predate process-incarnation identity. */
	identityProvenance?: "composite" | "legacy";
	/** True when the same sessionId maps to more than one stateRoot (cross-repo duplicate). */
	ambiguous?: boolean;
}

export interface SdkRingPositionV1 {
	revision: number;
	generation: number;
	seq: number;
}

export interface SdkCheckpointRecordV1 extends SdkRingPositionV1 {
	idle: boolean;
}

export interface SdkRetentionGapV1 {
	code: "retention_gap";
	missing?: { from: number; to: number };
	resync?: SdkRingPositionV1;
}

/** One tail item: a retained transcript entry or a live event-ring event. */
export interface SdkTailItemV1 {
	/** "transcript" for retained transcript entries, otherwise the event-ring kind. */
	kind: string;
	id?: string;
	/** Durable revision at emission; (revision,generation,seq) is unique per session. generation:seq alone is revision-local. */
	revision?: number;
	generation?: number;
	seq?: number;
	payload: unknown;
}

export interface SdkTailEnvelopeV1 {
	version: typeof SESSION_ROWS_VERSION;
	source: "session" | "offline";
	session: SdkSessionRowV1;
	checkpoint?: SdkCheckpointRecordV1;
	gap?: SdkRetentionGapV1;
	items: SdkTailItemV1[];
}

export function tailItemKey(item: SdkTailItemV1): string {
	// (generation, seq) restarts per revision; without the revision two turns'
	// first frames share "1:1" and the second is silently dropped (#5200).
	if (item.generation !== undefined && item.seq !== undefined) {
		if (item.revision === undefined || !Number.isSafeInteger(item.revision) || item.revision < 0)
			throw new Error("Cannot key a positioned tail item without its authoritative revision.");
		return `${item.kind}\u0000${item.revision}\u0000${item.generation}\u0000${item.seq}`;
	}
	if (item.id !== undefined) return `${item.kind}\u0000${item.id}`;
	return `${item.kind}\u0000${JSON.stringify(item.payload)}`;
}

/** Holds positioned live frames until the checkpoint can stamp their authoritative revision. */
export class TailRevisionBuffer {
	#pending: SdkTailItemV1[] = [];
	#resolved = false;

	push(item: SdkTailItemV1): SdkTailItemV1[] {
		if (item.revision !== undefined || item.generation === undefined || item.seq === undefined) return [item];
		if (!this.#resolved) {
			this.#pending.push(item);
			return [];
		}
		throw new Error("A positioned live tail item arrived without an authoritative revision after checkpoint.");
	}

	resolve(revision: number): SdkTailItemV1[] {
		if (!Number.isSafeInteger(revision) || revision < 0)
			throw new Error("Tail revision must be a non-negative integer.");
		this.#resolved = true;
		const pending = this.#pending;
		this.#pending = [];
		for (const item of pending) item.revision = revision;
		return pending;
	}
}

const SECRET_FIELD = /(?:secret|token|password|credential|authorization|api[_-]?key)/i;

/** Recursively removes secret-shaped fields (defense in depth for DTO output). */
export function stripSecretFields(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripSecretFields);
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		if (SECRET_FIELD.test(key)) continue;
		out[key] = stripSecretFields(nested);
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function locatorOf(row: Record<string, unknown>): { cwd: string; worktreeRoot: string | null; stateRoot: string } {
	const locator = isRecord(row.locator) ? row.locator : {};
	const cwd = optionalString(locator.cwd);
	const stateRoot = optionalString(locator.stateRoot);
	const worktreeRoot = locator.worktreeRoot;
	if (!cwd || !stateRoot || (worktreeRoot !== null && optionalString(worktreeRoot) === undefined)) {
		throw new Error("session row has an invalid locator v2");
	}
	return { cwd, worktreeRoot: worktreeRoot === null ? null : optionalString(worktreeRoot)!, stateRoot };
}

function activityOf(row: Record<string, unknown>): SdkSessionActivityV1 | undefined {
	if (!isRecord(row.activity)) return undefined;
	const state = row.activity.state;
	const at = row.activity.at;
	if ((state !== "active" && state !== "idle") || typeof at !== "number" || !Number.isFinite(at)) return undefined;
	return { state, at };
}

/**
 * Projects one broker `session.list` row into the credential-free v1 row DTO.
 * The row is a superset-tolerant projection: identity fields introduced by
 * later index versions (hostIncarnation, activity, deleted) pass through when
 * present and are omitted otherwise, so the same mapper serves both v2 and v3
 * index shapes.
 */
export function toSessionRowV1(value: unknown): SdkSessionRowV1 {
	if (!isRecord(value)) throw new Error("session row is not a record");
	const sessionId = optionalString(value.sessionId);
	if (!sessionId) throw new Error("session row is missing sessionId");
	const pid = typeof value.pid === "number" && Number.isSafeInteger(value.pid) ? value.pid : 0;
	const endpointGeneration =
		typeof value.endpointGeneration === "number" && Number.isSafeInteger(value.endpointGeneration)
			? value.endpointGeneration
			: 0;
	const indexSeq = typeof value.indexSeq === "number" && Number.isSafeInteger(value.indexSeq) ? value.indexSeq : 0;
	const row: SdkSessionRowV1 = {
		sessionId,
		locator: locatorOf(value),
		endpointGeneration,
		pid,
		live: value.live === true,
		deleted: value.deleted === true,
		indexSeq,
	};
	const hostIncarnation = optionalString(value.hostIncarnation);
	if (hostIncarnation !== undefined) row.hostIncarnation = hostIncarnation;
	if (value.terminalUncertain === true) row.terminalUncertain = true;
	const lifecycleRequestId = optionalString(value.lifecycleRequestId);
	if (lifecycleRequestId !== undefined) row.lifecycleRequestId = lifecycleRequestId;
	const endpointMtimeMs = optionalFiniteNumber(value.endpointMtimeMs);
	if (endpointMtimeMs !== undefined) row.endpointMtimeMs = endpointMtimeMs;
	const activity = activityOf(value);
	if (activity !== undefined) row.activity = activity;
	const lastHeartbeatAt = optionalFiniteNumber(value.lastHeartbeatAt);
	if (lastHeartbeatAt !== undefined) row.lastHeartbeatAt = lastHeartbeatAt;
	if (value.identityProvenance === "composite" || value.identityProvenance === "legacy")
		row.identityProvenance = value.identityProvenance;
	if (value.ambiguous === true) row.ambiguous = true;
	return row;
}

export function toCheckpointRecordV1(value: unknown): SdkCheckpointRecordV1 | undefined {
	if (!isRecord(value)) return undefined;
	const revision = value.revision;
	const generation = value.generation;
	const seq = value.seq;
	const idle = value.idle;
	if (
		typeof revision !== "number" ||
		!Number.isSafeInteger(revision) ||
		revision < 0 ||
		typeof generation !== "number" ||
		!Number.isSafeInteger(generation) ||
		generation < 0 ||
		typeof seq !== "number" ||
		!Number.isSafeInteger(seq) ||
		seq < 0 ||
		typeof idle !== "boolean"
	)
		return undefined;
	return { revision, generation, seq, idle };
}

export function toRetentionGapV1(value: unknown): SdkRetentionGapV1 | undefined {
	if (!isRecord(value) || value.code !== "retention_gap") return undefined;
	const gap: SdkRetentionGapV1 = { code: "retention_gap" };
	if (isRecord(value.missing)) {
		const from = value.missing.from;
		const to = value.missing.to;
		if (typeof from === "number" && Number.isSafeInteger(from) && typeof to === "number" && Number.isSafeInteger(to))
			gap.missing = { from, to };
	}
	if (isRecord(value.resync)) {
		const { revision, generation, seq } = value.resync;
		if (
			typeof revision === "number" &&
			Number.isSafeInteger(revision) &&
			revision >= 0 &&
			typeof generation === "number" &&
			Number.isSafeInteger(generation) &&
			generation >= 0 &&
			typeof seq === "number" &&
			Number.isSafeInteger(seq) &&
			seq >= 0
		)
			gap.resync = { revision, generation, seq };
	}
	return gap;
}

/** Projects a transcript entry or ring event into a tail item with dedupe keys. */
export function toTailItemV1(
	value: unknown,
	fallback: { kind: string; revision?: number; generation?: number; seq?: number },
): SdkTailItemV1 {
	if (!isRecord(value)) return { kind: fallback.kind, payload: stripSecretFields(value) };
	const kind = optionalString(value.kind) ?? fallback.kind;
	const id = optionalString(value.id);
	const payload = isRecord(value.payload) ? (value.payload as Record<string, unknown>) : value;
	const payloadId = optionalString(payload.id);
	const item: SdkTailItemV1 = {
		kind,
		...(payloadId !== undefined ? { id: payloadId } : id !== undefined ? { id } : {}),
		...(typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0
			? { revision: value.revision }
			: {}),
		...(typeof value.generation === "number" ? { generation: value.generation } : {}),
		...(typeof value.seq === "number" ? { seq: value.seq } : {}),
		payload: stripSecretFields(payload),
	};
	if (
		fallback.revision !== undefined &&
		Number.isSafeInteger(fallback.revision) &&
		fallback.revision >= 0 &&
		item.revision === undefined
	)
		item.revision = fallback.revision;
	if (fallback.generation !== undefined && item.generation === undefined) item.generation = fallback.generation;
	if (fallback.seq !== undefined && item.seq === undefined) item.seq = fallback.seq;
	return item;
}
