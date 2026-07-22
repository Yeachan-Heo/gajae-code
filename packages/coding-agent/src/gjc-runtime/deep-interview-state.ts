import { createHash } from "node:crypto";
import {
	clampReportedAmbiguity,
	computeAmbiguityFloor,
	type DeepInterviewAmbiguityMilestone,
	deriveAmbiguityMilestone,
	scoreToUnits,
	weightedAmbiguityUnits,
} from "./deep-interview-ambiguity";

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
	/**
	 * Resolution pointer for a disputed fact: the id of the fact that replaced it
	 * after the user confirmed a pivot. A disputed fact without `superseded_by`
	 * keeps the deterministic ambiguity floor elevated; setting it releases the
	 * pressure while preserving the contradicted fact for audit.
	 */
	superseded_by?: string;
}

export interface DeepInterviewTriggerMetadata {
	kind: DeepInterviewTriggerKind;
	name: string;
	status: DeepInterviewTriggerStatus;
	component: string;
	dimension: string;
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
	/** Effective ambiguity after the deterministic floor clamp (`max(reported, floor)`). */
	ambiguity?: number;
	/** Original LLM-reported ambiguity, preserved for audit when the floor clamped it. */
	reported_ambiguity?: number;
	/** Deterministic floor in effect when this round was scored, when it clamped. */
	ambiguity_floor?: number;
	triggers?: DeepInterviewTriggerMetadata[];
	round_result_digest?: string;
}

export interface DeepInterviewStateEnvelope {
	threshold?: number;
	threshold_units?: number;
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
	return createHash("sha256")
		.update(JSON.stringify({ selected: selectedOptions ?? [], custom: customInput ?? null }))
		.digest("hex");
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
	"ambiguity_floor",
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
	"threshold_units",
	"threshold_source",
] as const;

/**
 * Envelope-reserved keys that are never legitimate interview `state` fields.
 *
 * A malformed write that wraps a whole envelope under `state`
 * (`gjc state deep-interview write --input '{"state": <envelope>}'`) leaks these
 * into the nested state. Because normalization otherwise preserves unknown
 * nested fields, they would accrete a recursive `state.state` chain (plus stale
 * `receipt`/`skill`/`version`/... duplicates) that no later merge or write ever
 * removes, permanently corrupting the shape. They are stripped from `state` on
 * normalize so the canonical envelope self-heals on the next write.
 */
const ENVELOPE_RESERVED_STATE_KEYS = [
	"state",
	"receipt",
	"skill",
	"version",
	"updated_at",
	"active",
	"current_phase",
	"state_revision",
	"session_id",
] as const;

/**
 * Canonicalize a deep-interview envelope: interview data nested under `state`,
 * legacy flattened fields hoisted in losslessly, transcript duplicates removed
 * from the top level, and `rounds`/`established_facts` guaranteed to be arrays.
 *
 * Idempotent: a canonical envelope is returned unchanged in shape. Preserves all
 * unknown envelope and nested fields except the envelope-reserved keys that leak
 * into `state` (see `ENVELOPE_RESERVED_STATE_KEYS`), which are stripped so a
 * malformed envelope-in-state write cannot permanently nest state. Never mutates
 * the input.
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
	for (const field of ENVELOPE_RESERVED_STATE_KEYS) {
		if (field in inner) delete inner[field];
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
	const normalizedExisting = normalizeDeepInterviewEnvelope(existing);
	const existingState = isPlainObject(normalizedExisting.state) ? normalizedExisting.state : {};
	const incomingState = isPlainObject(normalizedIncoming.state) ? { ...normalizedIncoming.state } : {};
	if (existingState.intent_contract !== undefined) {
		assertDeepInterviewIntentManifest(existingState.intent_contract);
		if (Object.hasOwn(incomingState, "intent_contract")) {
			if (incomingState.intent_contract === null) throw new Error("locked intent contract cannot be deleted");
			assertDeepInterviewIntentManifest(incomingState.intent_contract);
			if (
				incomingState.intent_contract.digest !== existingState.intent_contract.digest ||
				incomingState.intent_contract.confirmation_answer_hash !==
					existingState.intent_contract.confirmation_answer_hash
			)
				throw new Error("locked intent contract cannot be replaced");
		} else {
			incomingState.intent_contract = existingState.intent_contract;
		}
	}
	if (existingState.intent_contract_required === true) incomingState.intent_contract_required = true;
	if (options.replace) {
		normalizedIncoming.state = incomingState;
		return normalizedIncoming;
	}

	const merged: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(normalizedExisting)) {
		if (key !== "state") merged[key] = value;
	}
	for (const [key, value] of Object.entries(normalizedIncoming)) {
		if (key === "state") continue;
		if (value === null) delete merged[key];
		else merged[key] = value;
	}

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

export const DEEP_INTERVIEW_INTENT_CATEGORIES = ["artifact", "surface", "integration", "constraint"] as const;
export type DeepInterviewIntentCategory = (typeof DEEP_INTERVIEW_INTENT_CATEGORIES)[number];

const INTENT_ID_RE = /^(artifact|surface|integration|constraint):[a-z0-9][a-z0-9._/-]{0,127}$/;
const ANSWER_HASH_RE = /^[a-f0-9]{64}$/;
const INTENT_RATIONALE_REF_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_INTENT_ITEMS = 64;
const MAX_INTENT_STATEMENT_LENGTH = 1_000;
const MAX_INTENT_RATIONALE_LENGTH = 500;
const MAX_INTENT_EVIDENCE_LENGTH = 80;

// =============================================================================
// Input validation: free-text field allowlist + size limits (ouroboros parity)
// =============================================================================

/**
 * User-input fields that legitimately carry prose (goals, prompts, descriptions,
 * answers). Shell metacharacters (`;`, `|`, `&`, backticks, `$()`) are valid prose
 * here and must NOT be rejected as structural injection. Structural fields (ids,
 * categories, hashes) stay strictly validated by their own guards.
 */
export const DEEP_INTERVIEW_FREETEXT_FIELDS: ReadonlySet<string> = new Set([
	"initial_context",
	"initial_idea",
	"initial_context_summary",
	"user_response",
	"answer",
	"goal",
	"objective",
	"prompt",
	"description",
	"statement",
	"restated_goal",
	"evidence",
	"excerpt",
]);

/** DoS-prevention character-count caps, matching ask-schema string-length semantics. */
export const MAX_INITIAL_CONTEXT_LENGTH = 50_000;
export const MAX_USER_RESPONSE_LENGTH = 10_000;
/** Maximum serialized JavaScript-string length for one LLM-produced structured response. */
export const MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH = 100_000;

/** Count Unicode code points without allocating an intermediate character array. */
export function deepInterviewCharacterCount(value: string): number {
	let count = 0;
	for (const _character of value) count++;
	return count;
}

export function isDeepInterviewFreeTextField(name: string): boolean {
	return DEEP_INTERVIEW_FREETEXT_FIELDS.has(name);
}

/**
 * Assert that one structured deep-interview response is JSON-serializable and
 * bounded by JavaScript string length. This deliberately does not measure or
 * cap accumulated persisted interview state.
 */
export function assertDeepInterviewStructuredResponseWithinLimit(value: unknown): void {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
			if (
				typeof nestedValue === "bigint" ||
				typeof nestedValue === "function" ||
				typeof nestedValue === "symbol" ||
				(typeof nestedValue === "number" && !Number.isFinite(nestedValue))
			)
				throw new Error("invalid structured deep-interview response");
			return nestedValue;
		});
	} catch {
		throw new Error("invalid structured deep-interview response");
	}
	if (typeof serialized !== "string") throw new Error("invalid structured deep-interview response");
	if (deepInterviewCharacterCount(serialized) > MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH)
		throw new Error(
			`structured deep-interview response exceeds max length ${MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH}`,
		);
}

/**
 * Assert a free-text input is within its size cap. Never inspects content for shell
 * metacharacters — free-text fields accept prose verbatim; this only bounds length.
 */
export function assertDeepInterviewInputWithinLimit(value: string, max: number, fieldName = "input"): void {
	if (typeof value !== "string") throw new Error(`${fieldName} must be a string`);
	if (deepInterviewCharacterCount(value) > max) throw new Error(`${fieldName} exceeds max length ${max}`);
}

/** Validate user-supplied deep-interview prose before an envelope is persisted. */
export function assertDeepInterviewEnvelopeInputLimits(envelope: Record<string, unknown>): void {
	const state =
		typeof envelope.state === "object" && envelope.state !== null && !Array.isArray(envelope.state)
			? (envelope.state as Record<string, unknown>)
			: {};
	for (const field of ["initial_idea", "initial_context", "initial_context_summary"] as const) {
		const nestedValue = state[field];
		if (nestedValue !== undefined)
			assertDeepInterviewInputWithinLimit(nestedValue as string, MAX_INITIAL_CONTEXT_LENGTH, `state.${field}`);
		const topLevelValue = envelope[field];
		if (topLevelValue !== undefined)
			assertDeepInterviewInputWithinLimit(topLevelValue as string, MAX_INITIAL_CONTEXT_LENGTH, field);
	}
	for (const field of ["user_response", "answer"] as const) {
		const nestedValue = state[field];
		if (nestedValue !== undefined)
			assertDeepInterviewInputWithinLimit(nestedValue as string, MAX_USER_RESPONSE_LENGTH, `state.${field}`);
		const topLevelValue = envelope[field];
		if (topLevelValue !== undefined)
			assertDeepInterviewInputWithinLimit(topLevelValue as string, MAX_USER_RESPONSE_LENGTH, field);
	}
	if (!Array.isArray(state.rounds)) return;
	for (const [index, round] of state.rounds.entries()) {
		if (typeof round !== "object" || round === null || Array.isArray(round)) continue;
		const record = round as Record<string, unknown>;
		for (const field of ["custom_input", "customInput", "user_response", "answer"] as const) {
			const value = record[field];
			// A structured scorer may use an unrelated object-valued `answer`; only prose
			// values in a legacy answer slot are user input subject to this cap.
			if (value === undefined || (field === "answer" && typeof value !== "string")) continue;
			assertDeepInterviewInputWithinLimit(
				value as string,
				MAX_USER_RESPONSE_LENGTH,
				`state.rounds[${index}].${field}`,
			);
		}
	}
}

export interface DeepInterviewIntentItem {
	id: string;
	category: DeepInterviewIntentCategory;
	statement: string;
}

export interface DeepInterviewIntentManifest {
	version: 1;
	items: DeepInterviewIntentItem[];
	digest: string;
	confirmation_round: 0;
	confirmation_answer_hash: string;
	confirmation_evidence: string;
}

export interface DeepInterviewIntentSubstitution {
	removed_id: string;
	replacement_ids: string[];
	rationale: string;
}

export interface DeepInterviewIntentReview {
	version: 1;
	status: "not_required" | "pending" | "approved";
	locked_digest: string;
	observed_digest: string;
	removed_locked_ids: string[];
	supporting_substitutions: DeepInterviewIntentSubstitution[];
	approval_round?: number;
	answer_hash?: string;
	user_answer_evidence?: string;
}

export function isCanonicalDeepInterviewAnswerHash(value: unknown): value is string {
	return typeof value === "string" && ANSWER_HASH_RE.test(value);
}

function isEvidenceReference(value: unknown, answerHashValue: string): value is string {
	return (
		typeof value === "string" &&
		deepInterviewCharacterCount(value) <= MAX_INTENT_EVIDENCE_LENGTH &&
		value === `answer_hash:${answerHashValue}`
	);
}

function assertIntentItem(value: unknown): asserts value is DeepInterviewIntentItem {
	if (!isPlainObject(value) || Object.keys(value).length !== 3) throw new Error("invalid intent item");
	const { id, category, statement } = value;
	if (typeof id !== "string" || !INTENT_ID_RE.test(id)) throw new Error("invalid intent id");
	if (
		!DEEP_INTERVIEW_INTENT_CATEGORIES.includes(category as DeepInterviewIntentCategory) ||
		!id.startsWith(`${category}:`)
	)
		throw new Error("invalid intent category");
	if (
		typeof statement !== "string" ||
		!statement.trim() ||
		deepInterviewCharacterCount(statement) > MAX_INTENT_STATEMENT_LENGTH
	)
		throw new Error(`intent item ${id} requires a bounded statement`);
}

function canonicalIntentItems(items: readonly DeepInterviewIntentItem[]): DeepInterviewIntentItem[] {
	return [...items]
		.map(item => ({ id: item.id.trim(), category: item.category, statement: item.statement.trim() }))
		.sort((left, right) => left.id.localeCompare(right.id));
}

export function deepInterviewIntentManifestDigest(items: readonly DeepInterviewIntentItem[]): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalIntentItems(items)))
		.digest("hex");
}

export function deepInterviewObservedIntentDigest(ids: readonly string[]): string {
	return createHash("sha256")
		.update(JSON.stringify([...new Set(ids)].sort()))
		.digest("hex");
}

export function createDeepInterviewIntentManifest(
	items: readonly DeepInterviewIntentItem[],
	confirmation: { round: 0; answer_hash: string },
): DeepInterviewIntentManifest {
	if (!Array.isArray(items) || items.length === 0 || items.length > MAX_INTENT_ITEMS)
		throw new Error("intent manifest requires bounded items");
	if (confirmation.round !== 0 || !isCanonicalDeepInterviewAnswerHash(confirmation.answer_hash))
		throw new Error("intent confirmation requires Round 0 canonical answer hash");
	const canonical = canonicalIntentItems(items);
	const ids = new Set<string>();
	for (const item of canonical) {
		assertIntentItem(item);
		if (ids.has(item.id)) throw new Error(`duplicate intent id: ${item.id}`);
		ids.add(item.id);
	}
	return {
		version: 1,
		items: canonical,
		digest: deepInterviewIntentManifestDigest(canonical),
		confirmation_round: 0,
		confirmation_answer_hash: confirmation.answer_hash,
		confirmation_evidence: `answer_hash:${confirmation.answer_hash}`,
	};
}

export function assertDeepInterviewIntentManifest(value: unknown): asserts value is DeepInterviewIntentManifest {
	if (!isPlainObject(value) || Object.keys(value).length !== 6 || value.version !== 1 || !Array.isArray(value.items))
		throw new Error("invalid intent contract");
	const manifest = createDeepInterviewIntentManifest(value.items as DeepInterviewIntentItem[], {
		round: value.confirmation_round as 0,
		answer_hash: value.confirmation_answer_hash as string,
	});
	if (
		value.digest !== manifest.digest ||
		value.confirmation_round !== 0 ||
		!isEvidenceReference(value.confirmation_evidence, manifest.confirmation_answer_hash)
	)
		throw new Error("intent contract integrity mismatch");
}

export function reviewDeepInterviewIntent(
	locked: DeepInterviewIntentManifest,
	observedItems: readonly DeepInterviewIntentItem[],
	input: Omit<DeepInterviewIntentReview, "version" | "locked_digest" | "observed_digest" | "removed_locked_ids">,
): DeepInterviewIntentReview {
	assertDeepInterviewIntentManifest(locked);
	const observed = createDeepInterviewIntentManifest(observedItems, {
		round: 0,
		answer_hash: locked.confirmation_answer_hash,
	});
	const observedIds = new Set(observed.items.map(item => item.id));
	const removed = locked.items
		.map(item => item.id)
		.filter(id => !observedIds.has(id))
		.sort();
	const substitutions = input.supporting_substitutions;
	if (!Array.isArray(substitutions)) throw new Error("invalid intent substitutions");
	const substitutionIds = new Set(substitutions.map(item => item.removed_id));
	if (substitutionIds.size !== substitutions.length) throw new Error("duplicate intent substitution");
	for (const substitution of substitutions) {
		if (!isPlainObject(substitution) || !removed.includes(substitution.removed_id))
			throw new Error("substitution does not bind removed intent");
		if (
			!Array.isArray(substitution.replacement_ids) ||
			substitution.replacement_ids.length === 0 ||
			substitution.replacement_ids.some(id => typeof id !== "string" || !observedIds.has(id)) ||
			typeof substitution.rationale !== "string" ||
			!substitution.rationale.trim() ||
			deepInterviewCharacterCount(substitution.rationale) > MAX_INTENT_RATIONALE_LENGTH
		)
			throw new Error("invalid intent substitution");
	}
	const redactedSubstitutions = substitutions.map(substitution => ({
		removed_id: substitution.removed_id,
		replacement_ids: [...new Set(substitution.replacement_ids)].sort(),
		rationale: `sha256:${createHash("sha256").update(substitution.rationale.trim()).digest("hex")}`,
	}));
	if (input.status !== "not_required" && input.status !== "pending" && input.status !== "approved")
		throw new Error("invalid intent review status");
	if (input.status === "not_required") {
		if (
			removed.length > 0 ||
			substitutions.length > 0 ||
			input.approval_round !== undefined ||
			input.answer_hash !== undefined ||
			input.user_answer_evidence !== undefined
		)
			throw new Error("not_required intent review cannot carry reduction evidence");
	}
	if (
		input.status === "pending" &&
		(input.approval_round !== undefined ||
			input.answer_hash !== undefined ||
			input.user_answer_evidence !== undefined)
	)
		throw new Error("pending intent review cannot carry approval evidence");
	if (input.status === "approved") {
		if (removed.some(id => !substitutionIds.has(id)))
			throw new Error("approved intent reduction requires every substitution");
		if (
			typeof input.approval_round !== "number" ||
			!Number.isFinite(input.approval_round) ||
			!Number.isInteger(input.approval_round) ||
			input.approval_round <= 0 ||
			!isCanonicalDeepInterviewAnswerHash(input.answer_hash) ||
			!isEvidenceReference(input.user_answer_evidence, input.answer_hash)
		)
			throw new Error("approved intent reduction requires durable redacted answer evidence");
	}
	return {
		...input,
		supporting_substitutions: redactedSubstitutions,
		version: 1,
		locked_digest: locked.digest,
		observed_digest: deepInterviewObservedIntentDigest([...observedIds]),
		removed_locked_ids: removed,
	};
}

export function assertDeepInterviewIntentReview(
	value: unknown,
	locked: DeepInterviewIntentManifest,
	observedIds: readonly string[],
	recordedAnswers: readonly { round: unknown; answer_hash: unknown }[],
): asserts value is DeepInterviewIntentReview {
	assertDeepInterviewIntentManifest(locked);
	if (!isPlainObject(value)) throw new Error("missing or invalid intent review");
	const allowedKeys = new Set([
		"version",
		"status",
		"locked_digest",
		"observed_digest",
		"removed_locked_ids",
		"supporting_substitutions",
		"approval_round",
		"answer_hash",
		"user_answer_evidence",
	]);
	if (Object.keys(value).some(key => !allowedKeys.has(key)) || value.version !== 1)
		throw new Error("invalid intent review");
	if (
		value.locked_digest !== locked.digest ||
		value.observed_digest !== deepInterviewObservedIntentDigest(observedIds)
	)
		throw new Error("stale intent review");
	const observed = new Set(observedIds);
	const removed = locked.items
		.map(item => item.id)
		.filter(id => !observed.has(id))
		.sort();
	if (
		!Array.isArray(value.removed_locked_ids) ||
		JSON.stringify([...value.removed_locked_ids].sort()) !== JSON.stringify(removed)
	)
		throw new Error("intent review removed IDs mismatch");
	if (!Array.isArray(value.supporting_substitutions)) throw new Error("invalid intent substitutions");
	const substitutions = value.supporting_substitutions;
	const substitutionIds = new Set<string>();
	for (const substitution of substitutions) {
		if (!isPlainObject(substitution) || Object.keys(substitution).length !== 3)
			throw new Error("invalid intent substitution");
		const { removed_id, replacement_ids, rationale } = substitution;
		if (
			typeof removed_id !== "string" ||
			!removed.includes(removed_id) ||
			substitutionIds.has(removed_id) ||
			!Array.isArray(replacement_ids) ||
			replacement_ids.length === 0 ||
			replacement_ids.some(id => typeof id !== "string" || !INTENT_ID_RE.test(id) || !observed.has(id)) ||
			typeof rationale !== "string" ||
			!INTENT_RATIONALE_REF_RE.test(rationale)
		)
			throw new Error("invalid intent substitution");
		substitutionIds.add(removed_id);
	}
	if (value.status === "not_required") {
		if (
			removed.length > 0 ||
			substitutions.length > 0 ||
			value.approval_round !== undefined ||
			value.answer_hash !== undefined ||
			value.user_answer_evidence !== undefined
		)
			throw new Error("not_required intent review cannot carry reduction evidence");
		return;
	}
	if (value.status !== "approved") {
		if (value.status === "pending") throw new Error("intent reduction is pending or unapproved");
		throw new Error("invalid intent review status");
	}
	if (removed.some(id => !substitutionIds.has(id)))
		throw new Error("approved intent reduction requires every substitution");
	if (
		typeof value.approval_round !== "number" ||
		!Number.isFinite(value.approval_round) ||
		!Number.isInteger(value.approval_round) ||
		value.approval_round <= 0 ||
		!isCanonicalDeepInterviewAnswerHash(value.answer_hash) ||
		!isEvidenceReference(value.user_answer_evidence, value.answer_hash) ||
		!recordedAnswers.some(answer => answer.round === value.approval_round && answer.answer_hash === value.answer_hash)
	)
		throw new Error("intent review approval evidence is invalid");
}
export type DeepInterviewDimension = "goal" | "constraints" | "criteria" | "context";
export type DeepInterviewResolution =
	| "auto_research_accepted"
	| "auto_answer"
	| "direct"
	| "refined"
	| "cited_confirmation";

export interface DeepInterviewFactOperation {
	op: "add" | "dispute" | "supersede";
	id: string;
	statement?: string;
	component?: string;
	dimension?: DeepInterviewDimension;
	evidence?: string;
	target_id?: string;
}

export interface DeepInterviewOntologyEntity {
	id: string;
	name: string;
	type: string;
	fields: string[];
}

export interface DeepInterviewOntologyRelationship {
	id: string;
	from_entity_id: string;
	to_entity_id: string;
	type: string;
}

export interface DeepInterviewOntologyReasoning {
	statement: string;
	evidence?: string;
}

export interface DeepInterviewOntologyInput {
	entities: DeepInterviewOntologyEntity[];
	relationships: DeepInterviewOntologyRelationship[];
	reasoning: DeepInterviewOntologyReasoning[];
}

export interface DeepInterviewComponentUpdate {
	component_id: string;
	scores: Record<DeepInterviewDimension, number>;
}

/**
 * Optional legacy assertions accepted only when they agree with the native
 * target. The persisted target is always derived from component scores.
 */
export interface DeepInterviewTargetingInput {
	target_component_id?: string;
	target_dimension?: DeepInterviewDimension;
	weakest_component_id?: string;
	weakest_dimension?: DeepInterviewDimension;
	last_targeted_component_id?: string | null;
}

export interface DeepInterviewRoundBookkeeping {
	resolution: DeepInterviewResolution;
	round_ids?: string[];
	counter_deltas?: Record<string, number>;
}

/**
 * Closed evidence submitted for one scoring transaction. All convergence values
 * (ambiguity, floor, milestone, ontology counts, rotation, and streak) are
 * native-derived and intentionally cannot be supplied here.
 */
export interface DeepInterviewRoundResultV1 {
	global_scores: Record<DeepInterviewDimension, number>;
	component_updates?: DeepInterviewComponentUpdate[];
	targeting?: DeepInterviewTargetingInput;
	triggers?: DeepInterviewTriggerMetadata[];
	fact_ops?: DeepInterviewFactOperation[];
	ontology?: DeepInterviewOntologyInput | DeepInterviewOntologyEntity[];
	bookkeeping?: DeepInterviewRoundBookkeeping;
	/** Compatibility adapter for recorder callers; never persisted as the v1 wire shape. */
	component_scores?: Record<string, Record<DeepInterviewDimension, number>>;
	auto_answered?: boolean;
}

/**
 * Version 1 native projection returned by `apply-round-result` as
 * `native_projection`. This is the complete renderable convergence surface;
 * callers must not derive or supplement it from candidate scorer input.
 */
export interface DeepInterviewRoundResultProjection {
	score_units: Partial<Record<DeepInterviewDimension, number>>;
	weighted_ambiguity: number;
	weighted_ambiguity_units: number;
	floor: number;
	floor_units: number;
	floor_cause: ReturnType<typeof computeAmbiguityFloor>;
	effective_ambiguity: number;
	effective_ambiguity_units: number;
	prior_effective_ambiguity: number | null;
	direction: "increased" | "decreased" | "unchanged" | "initial";
	ambiguity_milestone: DeepInterviewAmbiguityMilestone;
	topology: unknown;
	topology_counts: { active: number; deferred: number; total: number };
	ontology: unknown;
	ontology_counts: { stable: number; changed: number; new: number; basis: string };
	targeting: {
		target_component_id: string | null;
		target_dimension: DeepInterviewDimension | null;
		last_targeted_component_id: string | null;
	};
	transition: {
		round_key: string;
		lifecycle: "scored";
		auto_answer_streak: number;
	};
}

export type DeepInterviewApplyRoundResult =
	| { kind: "noop"; envelope: DeepInterviewStateEnvelope; projection?: DeepInterviewRoundResultProjection }
	| { kind: "write"; envelope: DeepInterviewStateEnvelope; projection: DeepInterviewRoundResultProjection };

function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (!isPlainObject(value)) {
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new TypeError("canonical JSON rejects non-finite numbers");
		}
		if (value === undefined) throw new TypeError("canonical JSON rejects undefined");
		return value;
	}
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) output[key] = canonicalJsonValue(value[key]);
	return output;
}

/** Strict UTF-8 JSON serialization used by v1 replay digests. */
export function canonicalDeepInterviewJson(value: unknown): string {
	return JSON.stringify(canonicalJsonValue(value));
}

export function deepInterviewRoundResultDigest(input: {
	round: number;
	question_id: string;
	round_id?: string | null;
	result: unknown;
}): string {
	return createHash("sha256")
		.update(
			canonicalDeepInterviewJson({
				v: 1,
				round: input.round,
				question_id: input.question_id,
				round_id: input.round_id ?? null,
				result: input.result,
			}),
		)
		.digest("hex");
}

/** Complete persisted answer identity; omitted optional values normalize to null. */
export function deepInterviewAnswerIdentityEqual(
	a: Pick<
		DeepInterviewRoundRecord,
		| "round"
		| "round_key"
		| "round_id"
		| "question_id"
		| "component"
		| "dimension"
		| "question_text"
		| "question_hash"
		| "selected_options"
		| "custom_input"
	>,
	b: Pick<
		DeepInterviewRoundRecord,
		| "round"
		| "round_key"
		| "round_id"
		| "question_id"
		| "component"
		| "dimension"
		| "question_text"
		| "question_hash"
		| "selected_options"
		| "custom_input"
	>,
): boolean {
	return (
		canonicalDeepInterviewJson({
			round: a.round,
			round_key: a.round_key,
			round_id: a.round_id ?? null,
			question_id: a.question_id ?? null,
			component: a.component ?? null,
			dimension: a.dimension ?? null,
			question_text: a.question_text ?? null,
			question_hash: a.question_hash,
			selected_options: a.selected_options ?? [],
			custom_input: a.custom_input ?? null,
		}) ===
		canonicalDeepInterviewJson({
			round: b.round,
			round_key: b.round_key,
			round_id: b.round_id ?? null,
			question_id: b.question_id ?? null,
			component: b.component ?? null,
			dimension: b.dimension ?? null,
			question_text: b.question_text ?? null,
			question_hash: b.question_hash,
			selected_options: b.selected_options ?? [],
			custom_input: b.custom_input ?? null,
		})
	);
}

/** Apply one closed v1 scoring round. The input contains evidence only; all convergence state is derived here. */
export function applyDeepInterviewRoundResultV1(
	envelopeValue: unknown,
	roundKey: string,
	result: DeepInterviewRoundResultV1,
	now: string,
): DeepInterviewApplyRoundResult {
	const envelope = normalizeDeepInterviewEnvelope(envelopeValue);
	const state = { ...(envelope.state ?? {}) };
	const rounds = asRecordArray(state.rounds) as unknown as DeepInterviewRoundRecord[];
	const index = rounds.findIndex(round => round.round_key === roundKey);
	if (index < 0) throw new Error("DI_ROUND_NOT_FOUND");
	const shell = rounds[index];
	if (shell.lifecycle !== "answered" && shell.lifecycle !== "pending_scoring" && shell.lifecycle !== "scored")
		throw new Error("DI_STATE_SCHEMA_INVALID");
	if (typeof shell.question_id !== "string" || shell.question_id === "") throw new Error("DI_STATE_SCHEMA_INVALID");
	const digest = deepInterviewRoundResultDigest({
		round: shell.round,
		question_id: shell.question_id,
		round_id: shell.round_id ?? null,
		result,
	});
	if (shell.lifecycle === "scored") {
		if (shell.round_result_digest !== digest) throw new Error("DI_ROUND_RESULT_CONFLICT");
		return { kind: "noop", envelope };
	}

	const type = state.type;
	if (type !== "greenfield" && type !== "brownfield") throw new Error("DI_STATE_SCHEMA_INVALID");
	const dimensions: DeepInterviewDimension[] =
		type === "brownfield" ? ["goal", "constraints", "criteria", "context"] : ["goal", "constraints", "criteria"];
	const componentScores =
		result.component_scores ??
		Object.fromEntries((result.component_updates ?? []).map(update => [update.component_id, update.scores]));
	const finiteScore = (value: unknown): value is number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
	if (!dimensions.every(dimension => finiteScore(result.global_scores[dimension])))
		throw new Error("DI_STATE_SCHEMA_INVALID");
	if (
		rounds.some(
			round =>
				round.lifecycle !== "scored" &&
				(round.round < shell.round || (round.round === shell.round && round.round_key < shell.round_key)),
		)
	)
		throw new Error("DI_STATE_SCHEMA_INVALID");

	const topology = isPlainObject(state.topology) ? state.topology : undefined;
	const activeComponents =
		topology && Array.isArray(topology.components)
			? topology.components.filter(
					component => isPlainObject(component) && component.active !== false && component.status !== "deferred",
				)
			: [];
	if (activeComponents.length > 0) {
		for (const component of activeComponents) {
			const id = component.id;
			if (
				typeof id !== "string" ||
				!isPlainObject(componentScores[id]) ||
				!dimensions.every(d => finiteScore(componentScores[id][d]))
			)
				throw new Error("DI_STATE_SCHEMA_INVALID");
		}
		for (const dimension of dimensions) {
			const weakest = Math.min(
				...activeComponents.map(component => componentScores[String(component.id)][dimension]),
			);
			if (result.global_scores[dimension] !== weakest) throw new Error("DI_STATE_SCHEMA_INVALID");
		}
	}
	const facts = asRecordArray(state.established_facts);
	for (const operation of result.fact_ops ?? []) {
		if (!operation || typeof operation.id !== "string" || operation.id === "")
			throw new Error("DI_STATE_SCHEMA_INVALID");
		const factIndex = facts.findIndex(fact => fact.id === operation.id);
		if (operation.op === "add") {
			if (!operation.statement || factIndex >= 0) throw new Error("DI_STATE_SCHEMA_INVALID");
			facts.push({
				id: operation.id,
				statement: operation.statement,
				round: shell.round,
				component: operation.component,
				dimension: operation.dimension,
				evidence: operation.evidence,
				disputed: false,
			});
		} else if (operation.op === "dispute") {
			if (factIndex < 0) throw new Error("DI_STATE_SCHEMA_INVALID");
			facts[factIndex] = { ...facts[factIndex], disputed: true };
		} else {
			if (factIndex < 0 || !operation.target_id || !facts.some(fact => fact.id === operation.target_id))
				throw new Error("DI_STATE_SCHEMA_INVALID");
			facts[factIndex] = { ...facts[factIndex], disputed: true, superseded_by: operation.target_id };
		}
	}
	for (const trigger of result.triggers ?? []) {
		if (
			!trigger ||
			!["A", "B", "C", "D"].includes(trigger.kind) ||
			!["active", "disputed", "unresolved"].includes(trigger.status) ||
			typeof trigger.name !== "string" ||
			trigger.name === "" ||
			typeof trigger.component !== "string" ||
			trigger.component === "" ||
			!dimensions.includes(trigger.dimension as DeepInterviewDimension)
		)
			throw new Error("DI_STATE_SCHEMA_INVALID");
		if ((trigger.status === "disputed" || trigger.status === "unresolved") && !trigger.rationale)
			throw new Error("DI_STATE_SCHEMA_INVALID");
		if (trigger.contradictedFactId && !facts.some(fact => fact.id === trigger.contradictedFactId))
			throw new Error("DI_STATE_SCHEMA_INVALID");
		if (
			topology &&
			Array.isArray(topology.components) &&
			topology.components.length > 0 &&
			!topology.components.some(component => isPlainObject(component) && component.id === trigger.component)
		)
			throw new Error("DI_STATE_SCHEMA_INVALID");
	}
	const priorSnapshot = Array.isArray(state.ontology_snapshots) ? state.ontology_snapshots.at(-1) : undefined;
	const priorEntities =
		isPlainObject(priorSnapshot) && Array.isArray(priorSnapshot.entities)
			? priorSnapshot.entities.filter(isPlainObject)
			: [];
	const ontologyInput = result.ontology;
	const entities = (Array.isArray(ontologyInput) ? ontologyInput : (ontologyInput?.entities ?? [])).map(entity => ({
		...entity,
		relationships: Array.isArray(ontologyInput)
			? []
			: (ontologyInput?.relationships ?? [])
					.filter(
						relationship => relationship.from_entity_id === entity.id || relationship.to_entity_id === entity.id,
					)
					.map(relationship => relationship.id),
	}));
	if (
		!entities.every(
			entity =>
				entity &&
				typeof entity.id === "string" &&
				typeof entity.name === "string" &&
				entity.name !== "" &&
				typeof entity.type === "string" &&
				Array.isArray(entity.fields) &&
				Array.isArray(entity.relationships),
		)
	)
		throw new Error("DI_STATE_SCHEMA_INVALID");
	if (isPlainObject(priorSnapshot)) {
		const priorSnapshotRound = priorSnapshot.round;
		if (
			typeof priorSnapshotRound !== "number" ||
			!Number.isSafeInteger(priorSnapshotRound) ||
			priorSnapshotRound >= shell.round
		)
			throw new Error("DI_STATE_SCHEMA_INVALID");
	}
	const basis = entities.length === 0 ? "no_entities" : priorSnapshot === undefined ? "first_round" : "compared";
	const unmatchedPrior = new Set(priorEntities.map((_, index) => index));
	const stableMatches = new Set<number>();
	const changedMatches = new Set<number>();
	if (basis === "compared") {
		for (let current = 0; current < entities.length; current += 1) {
			const prior = priorEntities.findIndex(
				(entity, index) =>
					unmatchedPrior.has(index) &&
					entity.name === entities[current].name &&
					entity.type === entities[current].type,
			);
			if (prior >= 0) {
				unmatchedPrior.delete(prior);
				stableMatches.add(current);
			}
		}
		const candidates: { prior: number; current: number }[] = [];
		for (let current = 0; current < entities.length; current += 1) {
			if (stableMatches.has(current)) continue;
			const fields = new Set(entities[current].fields);
			for (const prior of unmatchedPrior) {
				if (priorEntities[prior].type !== entities[current].type) continue;
				const priorFields = new Set(priorEntities[prior].fields as unknown[]);
				const overlap = [...fields].filter(field => priorFields.has(field)).length;
				if (overlap * 2 > Math.max(fields.size, priorFields.size)) candidates.push({ prior, current });
			}
		}
		candidates.sort(
			(a, b) =>
				String(priorEntities[a.prior].id).localeCompare(String(priorEntities[b.prior].id)) ||
				String(entities[a.current].id).localeCompare(String(entities[b.current].id)),
		);
		const matchedCurrent = new Set<number>();
		for (const candidate of candidates) {
			if (unmatchedPrior.has(candidate.prior) && !matchedCurrent.has(candidate.current)) {
				unmatchedPrior.delete(candidate.prior);
				matchedCurrent.add(candidate.current);
				changedMatches.add(candidate.current);
			}
		}
	}
	const stable = stableMatches.size;
	const changed = changedMatches.size;
	const fresh = entities.length - stable - changed;
	const stabilityRatio =
		basis === "compared" ? Math.floor(((stable + changed) * 10_000) / entities.length + 0.5) / 10_000 : null;
	const ontologySnapshots = [
		...(Array.isArray(state.ontology_snapshots) ? state.ontology_snapshots : []),
		{
			round: shell.round,
			captured_at: now,
			entities,
			basis,
			stable_entities: stable,
			new_entities: fresh,
			changed_entities: changed,
			stability_ratio: stabilityRatio,
		},
	];

	const nextTopology =
		topology && Array.isArray(topology.components)
			? {
					...topology,
					components: topology.components.map(component => {
						if (!isPlainObject(component) || typeof component.id !== "string") return component;
						const scores = componentScores[component.id];
						return scores ? { ...component, clarity_scores: { ...scores } } : component;
					}),
				}
			: state.topology;
	const activeIds = activeComponents.map(component => String(component.id));
	const componentWeakness = (id: string) => Math.min(...dimensions.map(dimension => componentScores[id][dimension]));
	const weakestValue = activeIds.length === 0 ? undefined : Math.min(...activeIds.map(componentWeakness));
	const tiedWeakest = activeIds.filter(id => componentWeakness(id) === weakestValue);
	const previousTarget =
		isPlainObject(topology) && typeof topology.last_targeted_component_id === "string"
			? topology.last_targeted_component_id
			: null;
	const rotatedCandidates =
		tiedWeakest.length > 1 && previousTarget !== null
			? [...tiedWeakest].sort(
					(a, b) =>
						((activeIds.indexOf(a) - activeIds.indexOf(previousTarget) + activeIds.length) % activeIds.length) -
						((activeIds.indexOf(b) - activeIds.indexOf(previousTarget) + activeIds.length) % activeIds.length),
				)
			: tiedWeakest;
	const targetComponent = rotatedCandidates[0] ?? null;
	const targetDimension =
		targetComponent === null
			? null
			: dimensions.reduce((weakest, dimension) =>
					componentScores[targetComponent][dimension] < componentScores[targetComponent][weakest]
						? dimension
						: weakest,
				);
	if (
		result.targeting &&
		((result.targeting.target_component_id !== undefined &&
			result.targeting.target_component_id !== targetComponent) ||
			(result.targeting.weakest_component_id !== undefined &&
				result.targeting.weakest_component_id !== targetComponent) ||
			(result.targeting.target_dimension !== undefined && result.targeting.target_dimension !== targetDimension) ||
			(result.targeting.weakest_dimension !== undefined && result.targeting.weakest_dimension !== targetDimension))
	)
		throw new Error("DI_STATE_SCHEMA_INVALID");
	const weightedUnits = weightedAmbiguityUnits(result.global_scores, type);
	const weightedAmbiguity = weightedUnits / 10_000;
	const resolution = result.bookkeeping?.resolution ?? (result.auto_answered ? "auto_answer" : "direct");
	const priorStreak = typeof state.auto_answer_streak === "number" ? state.auto_answer_streak : 0;
	const autoAnswerStreak =
		resolution === "auto_answer" || resolution === "auto_research_accepted" ? priorStreak + 1 : 0;
	const requestedRoundIds = result.bookkeeping?.round_ids ?? [roundKey];
	const durableRoundReferences = new Set(
		rounds.flatMap(round =>
			typeof round.round_id === "string" && round.round_id !== ""
				? [round.round_key, round.round_id]
				: [round.round_key],
		),
	);
	if (
		new Set(requestedRoundIds).size !== requestedRoundIds.length ||
		!requestedRoundIds.every(id => typeof id === "string" && durableRoundReferences.has(id))
	)
		throw new Error("DI_STATE_SCHEMA_INVALID");
	const appendRoundIds = (field: string): string[] => [
		...(Array.isArray(state[field]) ? state[field].filter((id): id is string => typeof id === "string") : []),
		...requestedRoundIds.filter(id => !(Array.isArray(state[field]) ? state[field] : []).includes(id)),
	];
	const counters = { ...(isPlainObject(state.counters) ? state.counters : {}) };
	for (const [key, delta] of Object.entries(result.bookkeeping?.counter_deltas ?? {})) {
		if (
			!Number.isSafeInteger(delta) ||
			(typeof counters[key] !== "undefined" && !Number.isSafeInteger(counters[key]))
		)
			throw new Error("DI_STATE_SCHEMA_INVALID");
		counters[key] = (typeof counters[key] === "number" ? counters[key] : 0) + delta;
	}
	const nextState: Record<string, unknown> = {
		...state,
		topology:
			isPlainObject(nextTopology) && targetComponent !== null
				? { ...nextTopology, last_targeted_component_id: targetComponent }
				: nextTopology,
		established_facts: facts,
		ontology_snapshots: ontologySnapshots,
		auto_answer_streak: autoAnswerStreak,
		counters,
		auto_answered_rounds:
			resolution === "auto_answer" ? appendRoundIds("auto_answered_rounds") : state.auto_answered_rounds,
		auto_research_accepted_rounds:
			resolution === "auto_research_accepted"
				? appendRoundIds("auto_research_accepted_rounds")
				: state.auto_research_accepted_rounds,
		refined_rounds: resolution === "refined" ? appendRoundIds("refined_rounds") : state.refined_rounds,
	};
	const floorBreakdown = computeAmbiguityFloor({
		...nextState,
		rounds: [...rounds, { ...shell, lifecycle: "scored" }],
	});
	const floor = floorBreakdown.floor;
	const effectiveAmbiguity = clampReportedAmbiguity(weightedAmbiguity, floor).effective;
	const threshold = state.threshold ?? envelope.threshold;
	if (!finiteScore(threshold)) throw new Error("DI_STATE_SCHEMA_INVALID");
	const thresholdUnits = state.threshold_units ?? envelope.threshold_units ?? scoreToUnits(threshold);
	if (
		typeof thresholdUnits !== "number" ||
		!Number.isSafeInteger(thresholdUnits) ||
		thresholdUnits < 1 ||
		thresholdUnits > 10_000 ||
		scoreToUnits(threshold) !== thresholdUnits
	)
		throw new Error("DI_STATE_SCHEMA_INVALID");
	const milestone = deriveAmbiguityMilestone(scoreToUnits(effectiveAmbiguity), thresholdUnits);
	nextState.threshold_units = thresholdUnits;
	const priorScoredRounds = rounds
		.filter(
			round =>
				round.lifecycle === "scored" &&
				(round.round < shell.round || (round.round === shell.round && round.round_key < shell.round_key)),
		)
		.sort((a, b) => b.round - a.round || b.round_key.localeCompare(a.round_key));
	const priorRound = priorScoredRounds[0];
	const priorEffectiveAmbiguity = typeof priorRound?.ambiguity === "number" ? priorRound.ambiguity : null;
	for (const trigger of result.triggers ?? []) {
		if (trigger.status !== "active") continue;
		const topologyComponents: unknown[] =
			isPlainObject(topology) && Array.isArray(topology.components) ? topology.components : [];
		const hasTopologyComponents = topologyComponents.length > 0;
		const priorComponent = topologyComponents.find(
			component => isPlainObject(component) && component.id === trigger.component,
		);
		const priorScores = isPlainObject(priorComponent) ? priorComponent.clarity_scores : undefined;
		const priorDimension = hasTopologyComponents
			? isPlainObject(priorScores)
				? priorScores[trigger.dimension]
				: undefined
			: priorRound?.scores?.[trigger.dimension];
		const candidateDimension = hasTopologyComponents
			? componentScores[trigger.component]?.[trigger.dimension as DeepInterviewDimension]
			: result.global_scores[trigger.dimension as DeepInterviewDimension];
		if (
			!priorRound ||
			!finiteScore(priorDimension) ||
			!finiteScore(candidateDimension) ||
			!finiteScore(priorRound.ambiguity) ||
			candidateDimension > priorDimension ||
			effectiveAmbiguity <= priorRound.ambiguity
		)
			throw new Error("DI_STATE_SCHEMA_INVALID");
	}
	rounds[index] = {
		...shell,
		lifecycle: "scored",
		scored_at: now,
		scores: result.global_scores,
		ambiguity: effectiveAmbiguity,
		reported_ambiguity: weightedAmbiguity,
		ambiguity_floor: floor,
		triggers: result.triggers ?? [],
		round_result_digest: digest,
	};
	nextState.rounds = rounds;
	nextState.current_ambiguity = effectiveAmbiguity;
	nextState.weighted_ambiguity = weightedAmbiguity;
	nextState.effective_ambiguity = effectiveAmbiguity;
	nextState.floor = floor;
	nextState.ambiguity_milestone = milestone;
	return {
		kind: "write",
		envelope: { ...envelope, state: nextState },
		projection: {
			score_units: Object.fromEntries(
				dimensions.map(dimension => [dimension, scoreToUnits(result.global_scores[dimension])]),
			) as Partial<Record<DeepInterviewDimension, number>>,
			weighted_ambiguity: weightedAmbiguity,
			weighted_ambiguity_units: weightedUnits,
			floor,
			floor_units: scoreToUnits(floor),
			floor_cause: floorBreakdown,
			effective_ambiguity: effectiveAmbiguity,
			effective_ambiguity_units: scoreToUnits(effectiveAmbiguity),
			prior_effective_ambiguity: priorEffectiveAmbiguity,
			direction:
				priorEffectiveAmbiguity === null
					? "initial"
					: effectiveAmbiguity > priorEffectiveAmbiguity
						? "increased"
						: effectiveAmbiguity < priorEffectiveAmbiguity
							? "decreased"
							: "unchanged",
			ambiguity_milestone: milestone,
			topology: nextState.topology,
			topology_counts: {
				active: activeComponents.length,
				deferred: Array.isArray(topology?.components)
					? topology.components.filter(component => isPlainObject(component) && component.status === "deferred")
							.length
					: 0,
				total: Array.isArray(topology?.components) ? topology.components.length : 0,
			},
			ontology: ontologySnapshots.at(-1),
			ontology_counts: { stable, changed, new: fresh, basis },
			targeting: {
				target_component_id: targetComponent,
				target_dimension: targetDimension,
				last_targeted_component_id: targetComponent,
			},
			transition: { round_key: roundKey, lifecycle: "scored", auto_answer_streak: autoAnswerStreak },
		},
	};
}
export function validateDeepInterviewV1Envelope(value: Record<string, unknown>): void {
	const invalid = (): never => {
		throw new Error("DI_STATE_SCHEMA_INVALID");
	};
	const validDate = (candidate: unknown): candidate is string =>
		typeof candidate === "string" && Number.isFinite(Date.parse(candidate));
	const validScore = (candidate: unknown): candidate is number => {
		if (typeof candidate !== "number") return false;
		try {
			scoreToUnits(candidate);
			return true;
		} catch {
			return false;
		}
	};
	const stateValue = value.state;
	if (value.skill !== "deep-interview" || value.schema_version !== 1 || !isPlainObject(stateValue)) return invalid();
	const state = stateValue as Record<string, unknown>;
	const type = state.type;
	if (type !== "greenfield" && type !== "brownfield") return invalid();
	const dimensions: DeepInterviewDimension[] =
		type === "brownfield" ? ["goal", "constraints", "criteria", "context"] : ["goal", "constraints", "criteria"];
	const isDimension = (candidate: unknown): candidate is DeepInterviewDimension =>
		typeof candidate === "string" && dimensions.includes(candidate as DeepInterviewDimension);
	const roundsValue = state.rounds;
	const factsValue = state.established_facts;
	const threshold = state.threshold ?? value.threshold;
	const thresholdUnits = state.threshold_units;
	if (
		!validScore(threshold) ||
		typeof thresholdUnits !== "number" ||
		!Number.isSafeInteger(thresholdUnits) ||
		thresholdUnits < 1 ||
		thresholdUnits > 10_000 ||
		scoreToUnits(threshold) !== thresholdUnits ||
		!Array.isArray(roundsValue) ||
		!Array.isArray(factsValue)
	)
		return invalid();
	const rounds = roundsValue as unknown[];
	const facts = factsValue as unknown[];

	const topology = state.topology;
	const componentIds = new Set<string>();
	let hasTopologyComponents = false;
	if (topology !== undefined) {
		if (!isPlainObject(topology) || !Array.isArray(topology.components) || typeof topology.status !== "string")
			return invalid();
		const topologyRecord = topology as Record<string, unknown>;
		const components = topologyRecord.components as unknown[];
		for (const component of components) {
			if (!isPlainObject(component)) return invalid();
			const componentRecord = component as Record<string, unknown>;
			const componentIdValue = componentRecord.id;
			if (typeof componentIdValue !== "string" || componentIdValue === "" || componentIds.has(componentIdValue))
				return invalid();
			const componentId = componentIdValue;
			componentIds.add(componentId);
			if (componentRecord.active !== undefined && typeof componentRecord.active !== "boolean") return invalid();
			if (componentRecord.clarity_scores !== undefined) {
				const clarityScoresValue = componentRecord.clarity_scores;
				if (!isPlainObject(clarityScoresValue)) return invalid();
				const clarityScores = clarityScoresValue as Record<string, unknown>;
				for (const dimension of dimensions) {
					const score = clarityScores[dimension];
					if (score !== undefined && score !== null && !validScore(score)) return invalid();
				}
			}
		}
		hasTopologyComponents = componentIds.size > 0;
	}

	const factIds = new Set<string>();
	for (const fact of facts) {
		if (!isPlainObject(fact)) return invalid();
		const factRecord = fact as Record<string, unknown>;
		const factIdValue = factRecord.id;
		const factRoundValue = factRecord.round;
		if (
			typeof factIdValue !== "string" ||
			factIdValue === "" ||
			factIds.has(factIdValue) ||
			typeof factRecord.statement !== "string" ||
			factRecord.statement === "" ||
			typeof factRoundValue !== "number" ||
			!Number.isSafeInteger(factRoundValue) ||
			factRoundValue < 1 ||
			typeof factRecord.disputed !== "boolean"
		)
			return invalid();
		const factId = factIdValue;
		factIds.add(factId);
		if (
			factRecord.component !== undefined &&
			(typeof factRecord.component !== "string" ||
				factRecord.component === "" ||
				(hasTopologyComponents && !componentIds.has(factRecord.component)))
		)
			return invalid();
		if (factRecord.dimension !== undefined && !isDimension(factRecord.dimension)) return invalid();
	}
	for (const fact of facts) {
		if (!isPlainObject(fact)) return invalid();
		const factRecord = fact as Record<string, unknown>;
		if (
			factRecord.superseded_by !== undefined &&
			(factRecord.disputed !== true || !factIds.has(String(factRecord.superseded_by)))
		)
			return invalid();
	}

	if (state.ontology_snapshots !== undefined) {
		const ontologySnapshotsValue = state.ontology_snapshots;
		if (!Array.isArray(ontologySnapshotsValue)) return invalid();
		const ontologySnapshots = ontologySnapshotsValue as unknown[];
		let priorRound = 0;
		for (const snapshot of ontologySnapshots) {
			if (!isPlainObject(snapshot)) return invalid();
			const snapshotRecord = snapshot as Record<string, unknown>;
			const snapshotRound = snapshotRecord.round;
			const stableEntities = snapshotRecord.stable_entities;
			const newEntities = snapshotRecord.new_entities;
			const changedEntities = snapshotRecord.changed_entities;
			const stabilityRatio = snapshotRecord.stability_ratio;
			if (
				typeof snapshotRound !== "number" ||
				!Number.isSafeInteger(snapshotRound) ||
				snapshotRound <= priorRound ||
				!validDate(snapshotRecord.captured_at) ||
				!Array.isArray(snapshotRecord.entities) ||
				!["no_entities", "first_round", "compared"].includes(String(snapshotRecord.basis)) ||
				typeof stableEntities !== "number" ||
				!Number.isSafeInteger(stableEntities) ||
				typeof newEntities !== "number" ||
				!Number.isSafeInteger(newEntities) ||
				typeof changedEntities !== "number" ||
				!Number.isSafeInteger(changedEntities) ||
				(stabilityRatio !== null && !validScore(stabilityRatio))
			)
				return invalid();
			const entities = snapshotRecord.entities as unknown[];
			if (
				stableEntities < 0 ||
				newEntities < 0 ||
				changedEntities < 0 ||
				stableEntities + newEntities + changedEntities !== entities.length ||
				((snapshotRecord.basis === "no_entities" || snapshotRecord.basis === "first_round") &&
					stabilityRatio !== null) ||
				(snapshotRecord.basis === "compared" && stabilityRatio === null)
			)
				return invalid();
			priorRound = snapshotRound;
			for (const entity of entities) {
				if (!isPlainObject(entity)) return invalid();
				const entityRecord = entity as Record<string, unknown>;
				if (
					typeof entityRecord.id !== "string" ||
					typeof entityRecord.name !== "string" ||
					entityRecord.name === "" ||
					typeof entityRecord.type !== "string" ||
					!Array.isArray(entityRecord.fields) ||
					!entityRecord.fields.every((field: unknown) => typeof field === "string") ||
					!Array.isArray(entityRecord.relationships) ||
					!entityRecord.relationships.every((relationship: unknown) => typeof relationship === "string")
				)
					return invalid();
			}
		}
	}
	if (state.auto_answered_rounds !== undefined) {
		const autoAnsweredRoundsValue = state.auto_answered_rounds;
		if (!Array.isArray(autoAnsweredRoundsValue)) return invalid();
		const autoAnsweredRounds = autoAnsweredRoundsValue as unknown[];
		if (!autoAnsweredRounds.every((key: unknown) => typeof key === "string")) return invalid();
	}
	for (const key of ["current_ambiguity", "weighted_ambiguity", "effective_ambiguity", "floor"] as const) {
		if (state[key] !== undefined && !validScore(state[key])) return invalid();
	}

	for (const round of rounds) {
		if (!isPlainObject(round)) return invalid();
		const roundRecord = round as Record<string, unknown>;
		const roundNumberValue = roundRecord.round;
		const isRoundZeroIntentShell =
			roundNumberValue === 0 && roundRecord.lifecycle === "answered" && roundRecord.scores === undefined;
		if (
			typeof roundRecord.round_key !== "string" ||
			roundRecord.round_key === "" ||
			typeof roundNumberValue !== "number" ||
			!Number.isSafeInteger(roundNumberValue) ||
			roundNumberValue < 0 ||
			(roundNumberValue === 0 && !isRoundZeroIntentShell) ||
			typeof roundRecord.question_id !== "string" ||
			roundRecord.question_id === "" ||
			typeof roundRecord.question_text !== "string" ||
			typeof roundRecord.question_hash !== "string" ||
			roundRecord.question_hash === "" ||
			typeof roundRecord.answer_hash !== "string" ||
			roundRecord.answer_hash === "" ||
			!validDate(roundRecord.answered_at) ||
			!["answered", "pending_scoring", "scored"].includes(String(roundRecord.lifecycle))
		)
			return invalid();
		if (
			roundRecord.component !== undefined &&
			(typeof roundRecord.component !== "string" ||
				roundRecord.component === "" ||
				(hasTopologyComponents && !componentIds.has(roundRecord.component)))
		)
			return invalid();
		if (
			roundRecord.dimension !== undefined &&
			!isDimension(roundRecord.dimension) &&
			!(isRoundZeroIntentShell && roundRecord.dimension === "topology")
		)
			return invalid();
		if (roundRecord.lifecycle !== "scored") continue;
		const scoresValue = roundRecord.scores;
		const triggersValue = roundRecord.triggers;
		if (
			!validDate(roundRecord.scored_at) ||
			!isPlainObject(scoresValue) ||
			!validScore(roundRecord.ambiguity) ||
			!validScore(roundRecord.reported_ambiguity) ||
			!validScore(roundRecord.ambiguity_floor) ||
			typeof roundRecord.round_result_digest !== "string" ||
			!/^[0-9a-f]{64}$/.test(roundRecord.round_result_digest) ||
			!Array.isArray(triggersValue)
		)
			return invalid();
		const scores = scoresValue as Record<string, unknown>;
		if (!dimensions.every(dimension => validScore(scores[dimension]))) return invalid();
		const triggers = triggersValue as unknown[];
		for (const trigger of triggers) {
			if (!isPlainObject(trigger)) return invalid();
			const triggerRecord = trigger as Record<string, unknown>;
			if (
				!["A", "B", "C", "D"].includes(String(triggerRecord.kind)) ||
				!["active", "disputed", "unresolved"].includes(String(triggerRecord.status)) ||
				typeof triggerRecord.name !== "string" ||
				typeof triggerRecord.component !== "string" ||
				triggerRecord.component === "" ||
				(hasTopologyComponents && !componentIds.has(triggerRecord.component)) ||
				!isDimension(triggerRecord.dimension) ||
				(triggerRecord.contradictedFactId !== undefined && !factIds.has(String(triggerRecord.contradictedFactId)))
			)
				return invalid();
			if (
				(triggerRecord.status === "disputed" || triggerRecord.status === "unresolved") &&
				typeof triggerRecord.rationale !== "string"
			)
				return invalid();
		}
		void scores;
	}
}
