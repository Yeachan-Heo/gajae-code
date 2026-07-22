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
	/** Effective ambiguity after the deterministic floor clamp (`max(reported, floor)`). */
	ambiguity?: number;
	/** Original LLM-reported ambiguity, preserved for audit when the floor clamped it. */
	reported_ambiguity?: number;
	/** Deterministic floor in effect when this round was scored, when it clamped. */
	ambiguity_floor?: number;
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
