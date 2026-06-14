import { createHash } from "node:crypto";

/**
 * Pure, dependency-free foundation for deep-interview state shape.
 *
 * Ownership boundary (per the approved consensus plan): this leaf module owns the
 * canonical persisted shape (interview data nested under `state`), durable round
 * identity/hashing, lossless legacy normalization, and the deep-interview-specific
 * envelope/round merge used by every writer (`deep-interview-recorder`,
 * `state-runtime` write/reconcile, seed, and handoff). It MUST NOT import the
 * active-state, state-writer, CLI runtime, or filesystem so it stays cycle-free and
 * trivially testable.
 */

// =============================================================================
// Domain types
// =============================================================================

export type DeepInterviewRoundLifecycle = "answered" | "pending_scoring" | "scored";

export type DeepInterviewTriggerKind = "A" | "B" | "C" | "D";

/** `active` triggers must satisfy the bidirectional invariant; disputed/unresolved are exempt with rationale. */
export type DeepInterviewTriggerStatus = "active" | "disputed" | "unresolved";

export interface DeepInterviewEstablishedFact {
	id: string;
	statement: string;
	round: number;
	component?: string;
	dimension?: string;
	evidence?: string;
	disputed: boolean;
}

export interface DeepInterviewTriggerMetadata {
	kind: DeepInterviewTriggerKind;
	name: string;
	status: DeepInterviewTriggerStatus;
	component: string;
	dimension: string;
	priorDimensionScore?: number;
	newDimensionScore?: number;
	priorAmbiguity?: number;
	newAmbiguity?: number;
	evidence?: string;
	contradictedFactId?: string;
	/** Required when status is `disputed` or `unresolved` to exempt the invariant. */
	rationale?: string;
}

export interface DeepInterviewRoundRecord {
	round_key: string;
	round_id?: string;
	round: number;
	question_id?: string;
	question_text?: string;
	question_hash: string;
	answer_hash: string;
	selected_options?: string[];
	custom_input?: string;
	component?: string;
	dimension?: string;
	ambiguity_at_ask?: number;
	lifecycle: DeepInterviewRoundLifecycle;
	answered_at: string;
	scored_at?: string;
	scores?: Record<string, number>;
	ambiguity?: number;
	triggers?: DeepInterviewTriggerMetadata[];
}

export interface DeepInterviewStateEnvelope {
	threshold?: number;
	threshold_source?: string;
	state?: Record<string, unknown>;
	[key: string]: unknown;
}

// =============================================================================
// Pure helpers: identity + hashing
// =============================================================================

export function hashContent(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function questionHash(questionText: string): string {
	return hashContent(questionText);
}

export function answerHash(selectedOptions: string[] | undefined, customInput: string | undefined): string {
	return hashContent(JSON.stringify({ selected: selectedOptions ?? [], custom: customInput ?? null }));
}

/**
 * Durable round identity. Prefer `interview_id + round_id`; fall back to
 * `interview_id + round + question.id` when no caller-supplied `round_id` exists.
 */
export function deriveRoundKey(
	interviewId: string | undefined,
	input: { round_id?: string; round: number; questionId?: string },
): string {
	const interview = interviewId && interviewId.trim() !== "" ? interviewId : "nointerview";
	if (input.round_id && input.round_id.trim() !== "") {
		return `${interview}::rid:${input.round_id}`;
	}
	return `${interview}::r:${input.round}::q:${input.questionId ?? "noqid"}`;
}

// =============================================================================
// Pure helpers: canonical shape normalization
// =============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Interview transcript/scoring fields that are canonical under `state`. When a
 * legacy flattened envelope carries them at the top level they are hoisted into
 * `state` and removed from the top level so exactly one canonical copy survives.
 */
const TRANSCRIPT_STATE_FIELDS = [
	"rounds",
	"established_facts",
	"current_ambiguity",
	"topology",
	"ontology_snapshots",
	"auto_researched_rounds",
	"auto_answered_rounds",
	"architect_failures",
] as const;

/**
 * Interview context fields that belong under `state` but are also legitimately
 * mirrored at the envelope level by the seed/spec writers (e.g. `threshold`,
 * `language`). They are hoisted into `state` when missing there but never stripped
 * from the top level, preserving existing dual-write behavior.
 */
const HOISTED_STATE_FIELDS = [
	"initial_idea",
	"initial_context_summary",
	"codebase_context",
	"challenge_modes_used",
	"interview_id",
	"type",
	"language",
	"threshold",
	"threshold_source",
] as const;

/**
 * Canonicalize a deep-interview envelope: interview data nested under `state`,
 * legacy flattened fields hoisted in losslessly, transcript duplicates removed
 * from the top level, and `rounds`/`established_facts` guaranteed to be arrays.
 *
 * Idempotent: a canonical envelope is returned unchanged in shape. Never deletes
 * unknown envelope or nested fields, and never mutates the input.
 */
export function normalizeDeepInterviewEnvelope(value: unknown): DeepInterviewStateEnvelope {
	const envelope: DeepInterviewStateEnvelope = isPlainObject(value) ? { ...value } : {};
	const inner: Record<string, unknown> = isPlainObject(envelope.state) ? { ...envelope.state } : {};

	for (const field of TRANSCRIPT_STATE_FIELDS) {
		if (inner[field] === undefined && envelope[field] !== undefined) inner[field] = envelope[field];
		if (field in envelope) delete envelope[field];
	}
	for (const field of HOISTED_STATE_FIELDS) {
		if (inner[field] === undefined && envelope[field] !== undefined) inner[field] = envelope[field];
	}

	if (!Array.isArray(inner.rounds)) inner.rounds = [];
	if (!Array.isArray(inner.established_facts)) inner.established_facts = [];
	envelope.state = inner;
	return envelope;
}

// =============================================================================
// Pure helpers: lossless round + envelope merge
// =============================================================================

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/** Durable merge key for a round, or `undefined` when the record is not addressable. */
function durableRoundKey(record: Record<string, unknown>): string | undefined {
	if (nonEmptyString(record.round_key)) return record.round_key;
	const hasId = nonEmptyString(record.round_id) || nonEmptyString(record.question_id);
	if (!hasId) return undefined;
	return deriveRoundKey(undefined, {
		round_id: nonEmptyString(record.round_id) ? record.round_id : undefined,
		round: typeof record.round === "number" ? record.round : 0,
		questionId: nonEmptyString(record.question_id) ? record.question_id : undefined,
	});
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every(key => deepEqual(a[key], b[key]));
	}
	return false;
}

/** Merge a later round record into an earlier one for the same durable key. */
function mergeRoundPair(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...existing };
	for (const [key, value] of Object.entries(incoming)) {
		if (value === undefined) continue;
		merged[key] = value;
	}
	// Never downgrade a scored lifecycle back to answered.
	if (existing.lifecycle === "scored" && incoming.lifecycle !== "scored") merged.lifecycle = "scored";
	// Preserve shell identity fields when the incoming (scoring) record blanked them.
	for (const field of ["question_hash", "answer_hash", "question_text"]) {
		if (!nonEmptyString(incoming[field]) && nonEmptyString(existing[field])) merged[field] = existing[field];
	}
	return merged;
}

/**
 * Lossless, idempotent merge of two round arrays.
 *
 * - Records sharing a durable key (`round_key`, or synthesized from
 *   `round_id`/`question_id`) merge into one, preferring scored over answered.
 * - Records without any durable identity are preserved verbatim; an exact
 *   duplicate is skipped so repeated writes stay idempotent, but distinct records
 *   are never collapsed.
 *
 * Deliberate refinement of the approved plan: rather than mutating opaque legacy
 * records with synthetic `legacy:<index>` keys, they are preserved verbatim with
 * exact-duplicate dedupe. This satisfies the plan's intent (lossless, idempotent,
 * never collapse distinct rounds) without rewriting user-supplied round objects,
 * and keeps free-form extension preservation intact. Recorder-produced records
 * always carry a `round_key`, so the synthetic path is unnecessary in practice.
 */
export function mergeDeepInterviewRounds(
	existing: readonly Record<string, unknown>[],
	incoming: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];
	const indexByKey = new Map<string, number>();

	const add = (record: Record<string, unknown>): void => {
		const key = durableRoundKey(record);
		if (key !== undefined) {
			const existingIndex = indexByKey.get(key);
			if (existingIndex === undefined) {
				const stored = nonEmptyString(record.round_key) ? { ...record } : { ...record, round_key: key };
				indexByKey.set(key, result.length);
				result.push(stored);
			} else {
				result[existingIndex] = mergeRoundPair(result[existingIndex], record);
			}
			return;
		}
		// Opaque/legacy record without durable identity: preserve verbatim, dedupe exact copies only.
		if (result.some(item => deepEqual(item, record))) return;
		result.push({ ...record });
	};

	for (const record of existing) if (isPlainObject(record)) add(record);
	for (const record of incoming) if (isPlainObject(record)) add(record);
	return result;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

/**
 * Deep-interview-specific envelope merge. Unlike the generic shallow null-delete
 * merge, this keeps interview data nested under `state`, never deletes `state`,
 * and merges `rounds` losslessly by durable key so a partial write (e.g. a
 * scoring update) cannot drop recorder-written transcript history.
 */
export function mergeDeepInterviewEnvelope(
	existing: unknown,
	incoming: unknown,
	options: { replace?: boolean } = {},
): DeepInterviewStateEnvelope {
	const incomingEnvelope = isPlainObject(incoming) ? incoming : {};
	const incomingNestedState = isPlainObject(incomingEnvelope.state) ? incomingEnvelope.state : {};
	const incomingHasEstablishedFacts =
		Object.hasOwn(incomingNestedState, "established_facts") || Object.hasOwn(incomingEnvelope, "established_facts");
	const normalizedIncoming = normalizeDeepInterviewEnvelope(incoming);
	if (options.replace) return normalizedIncoming;

	const normalizedExisting = normalizeDeepInterviewEnvelope(existing);
	const merged: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(normalizedExisting)) {
		if (key !== "state") merged[key] = value;
	}
	for (const [key, value] of Object.entries(normalizedIncoming)) {
		if (key === "state") continue;
		if (value === null) delete merged[key];
		else merged[key] = value;
	}

	const existingState = isPlainObject(normalizedExisting.state) ? normalizedExisting.state : {};
	const incomingState = isPlainObject(normalizedIncoming.state) ? normalizedIncoming.state : {};
	const mergedState: Record<string, unknown> = { ...existingState };
	for (const [key, value] of Object.entries(incomingState)) {
		if (key === "rounds") continue;
		if (key === "established_facts" && !incomingHasEstablishedFacts) continue;
		if (value === null) delete mergedState[key];
		else mergedState[key] = value;
	}
	mergedState.rounds = mergeDeepInterviewRounds(
		asRecordArray(existingState.rounds),
		asRecordArray(incomingState.rounds),
	);
	merged.state = mergedState;
	return merged as DeepInterviewStateEnvelope;
}
