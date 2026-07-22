import { syncSkillActiveState } from "../skill-state/active-state";
import { deriveDeepInterviewHud } from "../skill-state/workflow-hud";
import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-contract";
import {
	clampReportedAmbiguity,
	computeAmbiguityFloor,
	disputeFactsFromRetractedRound,
} from "./deep-interview-ambiguity";
import {
	answerHash,
	assertDeepInterviewInputWithinLimit,
	assertDeepInterviewIntentManifest,
	assertDeepInterviewStructuredResponseWithinLimit,
	createDeepInterviewIntentManifest,
	type DeepInterviewEstablishedFact,
	type DeepInterviewIntentItem,
	type DeepInterviewIntentSubstitution,
	type DeepInterviewRoundRecord,
	type DeepInterviewStateEnvelope,
	type DeepInterviewTriggerMetadata,
	deriveRoundKey,
	MAX_USER_RESPONSE_LENGTH,
	normalizeDeepInterviewEnvelope,
	questionHash,
	reviewDeepInterviewIntent,
} from "./deep-interview-state";
import { writeSessionActivityMarker } from "./session-resolution";
import { readExistingStateForMutation, writeGuardedWorkflowEnvelopeAtomic } from "./state-writer";

export * from "./deep-interview-ambiguity";
export * from "./deep-interview-state";

/**
 * Runtime-owned deep-interview round recorder (conflict-aware scoring support).
 *
 * Ownership boundary (per the approved consensus plan): this module owns durable
 * round-record semantics — stable identity, append-or-merge, lifecycle, compact
 * reads, replay detection, and the pure scored-transition validator. Callers such
 * as the `ask` tool only resolve an answer and invoke these helpers; they never
 * compute state paths, merge records, or write `.gjc` files directly. All writes
 * go through the sanctioned state-writer (`writeWorkflowEnvelopeAtomic`).
 */

// =============================================================================
// Domain types
// =============================================================================

export interface DeepInterviewAnswerInput {
	interviewId?: string;
	round: number;
	round_id?: string;
	questionId?: string;
	questionText: string;
	component?: string;
	dimension?: string;
	ambiguity?: number;
	selectedOptions?: string[];
	customInput?: string;
	intent_contract?: { items: DeepInterviewIntentItem[]; confirmation_options: string[] };
	intent_review?: {
		observed_items: DeepInterviewIntentItem[];
		supporting_substitutions: DeepInterviewIntentSubstitution[];
		approval_options: string[];
	};
}

export interface DeepInterviewScoringInput {
	interviewId?: string;
	round: number;
	round_id?: string;
	questionId?: string;
	scores: Record<string, number>;
	ambiguity: number;
	triggers?: DeepInterviewTriggerMetadata[];
}

export type AppendOrMergeAction = "created" | "noop" | "replaced";

export interface AppendOrMergeResult {
	rounds: DeepInterviewRoundRecord[];
	action: AppendOrMergeAction;
	record: DeepInterviewRoundRecord;
}

export interface DeepInterviewCompactState {
	threshold?: number;
	threshold_source?: string;
	current_ambiguity?: number;
	topology_summary?: { active: number; deferred: number; components: string[] };
	established_facts: DeepInterviewEstablishedFact[];
	unresolved_triggers: DeepInterviewTriggerMetadata[];
	recent_scored_rounds: DeepInterviewRoundRecord[];
	pending_shells: DeepInterviewRoundRecord[];
}

export interface TransitionValidationResult {
	ok: boolean;
	violations: string[];
}

// =============================================================================
// Pure helpers: records
// =============================================================================

export function buildAnswerShell(
	input: DeepInterviewAnswerInput,
	now: string = new Date().toISOString(),
): DeepInterviewRoundRecord {
	return {
		round_key: deriveRoundKey(input.interviewId, input),
		round_id: input.round_id,
		round: input.round,
		question_id: input.questionId,
		question_text: input.questionText,
		question_hash: questionHash(input.questionText),
		answer_hash: answerHash(input.selectedOptions, input.customInput),
		selected_options: input.selectedOptions,
		custom_input: input.customInput,
		component: input.component,
		dimension: input.dimension,
		ambiguity_at_ask: input.ambiguity,
		lifecycle: "answered",
		answered_at: now,
	};
}

/**
 * Append-or-merge by `round_key`. Exactly one record per key:
 * - no existing record -> append (`created`);
 * - identical question_hash + answer_hash -> deterministic no-op (`noop`);
 * - same key, different hashes -> deterministic replacement of the prior shell
 *   (`replaced`); the prior answer for that key is superseded and lifecycle resets.
 */
export function appendOrMergeRound(
	rounds: readonly DeepInterviewRoundRecord[],
	shell: DeepInterviewRoundRecord,
): AppendOrMergeResult {
	const next = [...rounds];
	const index = next.findIndex(r => r.round_key === shell.round_key);
	if (index < 0) {
		next.push(shell);
		return { rounds: next, action: "created", record: shell };
	}
	const existing = next[index];
	if (existing.question_hash === shell.question_hash && existing.answer_hash === shell.answer_hash) {
		return { rounds: next, action: "noop", record: existing };
	}
	next[index] = shell;
	return { rounds: next, action: "replaced", record: shell };
}

/**
 * Merge scoring output into the existing record for the derived key, transitioning
 * it to `scored`. Never appends a second record for the same key; if no shell exists
 * yet (scoring without a prior ask), a scored record is created so data is not lost.
 */
export function enrichRoundWithScoring(
	rounds: readonly DeepInterviewRoundRecord[],
	input: DeepInterviewScoringInput,
	now: string = new Date().toISOString(),
): { rounds: DeepInterviewRoundRecord[]; record: DeepInterviewRoundRecord } {
	const roundKey = deriveRoundKey(input.interviewId, input);
	const next = [...rounds];
	const index = next.findIndex(r => r.round_key === roundKey);
	if (index < 0) {
		const created: DeepInterviewRoundRecord = {
			round_key: roundKey,
			round_id: input.round_id,
			round: input.round,
			question_id: input.questionId,
			question_hash: "",
			answer_hash: "",
			lifecycle: "scored",
			answered_at: now,
			scored_at: now,
			scores: input.scores,
			ambiguity: input.ambiguity,
			triggers: input.triggers,
		};
		next.push(created);
		return { rounds: next, record: created };
	}
	const merged: DeepInterviewRoundRecord = {
		...next[index],
		lifecycle: "scored",
		scored_at: now,
		scores: input.scores,
		ambiguity: input.ambiguity,
		triggers: input.triggers,
	};
	next[index] = merged;
	return { rounds: next, record: merged };
}

// =============================================================================
// Pure helper: scored-transition validator
// =============================================================================

/**
 * Bidirectional invariant: if `next` carries an `active` trigger, the affected
 * dimension must not improve and overall ambiguity must rise vs the prior scored
 * round. `disputed`/`unresolved` triggers are exempt but must carry a rationale.
 */
export function validateDeepInterviewScoredTransition(
	prior: DeepInterviewRoundRecord | undefined,
	next: DeepInterviewRoundRecord,
): TransitionValidationResult {
	const violations: string[] = [];
	const triggers = next.triggers ?? [];
	for (const trigger of triggers) {
		if (trigger.status === "disputed" || trigger.status === "unresolved") {
			if (!trigger.rationale || trigger.rationale.trim() === "") {
				violations.push(`trigger ${trigger.kind} is ${trigger.status} but has no rationale`);
			}
			continue;
		}
		// status === "active": enforce the invariant only when a prior scored round exists.
		if (!prior) continue;
		// Ambiguity must be present on both sides and must rise; missing metrics cannot prove a rise.
		if (typeof prior.ambiguity !== "number" || typeof next.ambiguity !== "number") {
			violations.push(`active trigger ${trigger.kind} is missing ambiguity metrics to prove a rise`);
		} else if (!(next.ambiguity > prior.ambiguity)) {
			violations.push(
				`active trigger ${trigger.kind} did not raise ambiguity (${prior.ambiguity} -> ${next.ambiguity})`,
			);
		}
		// Affected dimension must not improve. Prefer record scores, fall back to the trigger's
		// own prior/new dimension scores; absent metrics cannot prove non-improvement.
		const priorDim = prior.scores?.[trigger.dimension] ?? trigger.priorDimensionScore;
		const nextDim = next.scores?.[trigger.dimension] ?? trigger.newDimensionScore;
		if (typeof priorDim !== "number" || typeof nextDim !== "number") {
			violations.push(
				`active trigger ${trigger.kind} is missing dimension "${trigger.dimension}" scores to prove non-improvement`,
			);
		} else if (nextDim > priorDim) {
			violations.push(
				`active trigger ${trigger.kind} on dimension "${trigger.dimension}" improved clarity ${priorDim} -> ${nextDim}`,
			);
		}
	}
	return { ok: violations.length === 0, violations };
}

// =============================================================================
// Pure helper: state-shape migration + compact projection
// =============================================================================

/** Back-compat wrapper: normalize a deep-interview envelope to its canonical nested shape. */
export function ensureDeepInterviewStateShape(value: unknown): DeepInterviewStateEnvelope {
	return normalizeDeepInterviewEnvelope(value);
}

function readRounds(envelope: DeepInterviewStateEnvelope): DeepInterviewRoundRecord[] {
	const inner = (envelope.state ?? {}) as Record<string, unknown>;
	return Array.isArray(inner.rounds) ? (inner.rounds as DeepInterviewRoundRecord[]) : [];
}

export function projectCompactState(value: unknown, options: { lastN?: number } = {}): DeepInterviewCompactState {
	const lastN = options.lastN ?? 3;
	const envelope = ensureDeepInterviewStateShape(value);
	const inner = (envelope.state ?? {}) as Record<string, unknown>;
	const rounds = readRounds(envelope);
	const scored = rounds.filter(r => r.lifecycle === "scored");
	const pending = rounds.filter(r => r.lifecycle !== "scored");
	const latestScored = scored.length > 0 ? scored[scored.length - 1] : undefined;
	const established = Array.isArray(inner.established_facts)
		? (inner.established_facts as DeepInterviewEstablishedFact[])
		: [];
	const unresolved: DeepInterviewTriggerMetadata[] = [];
	for (const round of scored) {
		for (const trigger of round.triggers ?? []) {
			if (trigger.status === "unresolved" || trigger.status === "disputed") unresolved.push(trigger);
		}
	}
	const topology = inner.topology as { components?: Array<{ status?: string; name?: string }> } | undefined;
	let topologySummary: DeepInterviewCompactState["topology_summary"];
	if (topology && Array.isArray(topology.components)) {
		const active = topology.components.filter(c => c.status !== "deferred");
		topologySummary = {
			active: active.length,
			deferred: topology.components.length - active.length,
			components: topology.components.map(c => c.name ?? "").filter(Boolean),
		};
	}
	return {
		threshold: typeof envelope.threshold === "number" ? envelope.threshold : (inner.threshold as number | undefined),
		threshold_source:
			typeof envelope.threshold_source === "string"
				? envelope.threshold_source
				: (inner.threshold_source as string | undefined),
		current_ambiguity:
			typeof latestScored?.ambiguity === "number"
				? latestScored.ambiguity
				: (inner.current_ambiguity as number | undefined),
		topology_summary: topologySummary,
		established_facts: established,
		unresolved_triggers: unresolved,
		recent_scored_rounds: scored.slice(-lastN),
		pending_shells: pending,
	};
}

// =============================================================================
// Persistence wrappers (state-writer backed; runtime-owned)
// =============================================================================

async function readEnvelope(statePath: string): Promise<DeepInterviewStateEnvelope> {
	const read = await readExistingStateForMutation(statePath);
	if (read.kind === "valid") return ensureDeepInterviewStateShape(read.value);
	if (read.kind === "corrupt") {
		// Fail closed: never silently overwrite a corrupt/tampered state file. Callers
		// (e.g. the ask tool) catch this and warn without mutating, preserving the file
		// for recovery. Only a genuinely absent file is defaulted below.
		throw new Error(
			`deep-interview state at ${statePath} is corrupt or tampered (${read.error}); refusing to overwrite`,
		);
	}
	// Absent: start from a defaulted shape.
	return ensureDeepInterviewStateShape(undefined);
}

function existingStateRevision(value: unknown): number | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const revision = (value as Record<string, unknown>).state_revision;
	return typeof revision === "number" && Number.isFinite(revision) ? revision : 0;
}

function interviewIdOf(envelope: DeepInterviewStateEnvelope): string | undefined {
	const inner = (envelope.state ?? {}) as Record<string, unknown>;
	return typeof inner.interview_id === "string" ? inner.interview_id : undefined;
}

async function persistEnvelope(
	cwd: string,
	statePath: string,
	envelope: DeepInterviewStateEnvelope,
	sessionId: string | undefined,
	command: string,
): Promise<void> {
	if (!sessionId) throw new Error("deep-interview recorder requires a session id");
	const now = new Date().toISOString();
	const payload: Record<string, unknown> = { ...normalizeDeepInterviewEnvelope(envelope), updated_at: now };
	// Guarantee RequiredOnWriteEnvelopeSchema fields for the fresh/absent fallback;
	// existing real state already carries these and is preserved by the spread above.
	payload.skill ??= "deep-interview";
	payload.version ??= WORKFLOW_STATE_VERSION;
	payload.active ??= true;
	payload.current_phase ??= "interviewing";
	const expectedRevision = existingStateRevision(envelope);
	const writeResult = await writeGuardedWorkflowEnvelopeAtomic(statePath, payload, {
		cwd,
		policy: "source",
		expectedRevision,
		receipt: { cwd, skill: "deep-interview", owner: "gjc-runtime", command, sessionId, nowIso: now },
		audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "deep-interview", sessionId },
	});
	// Reflect the freshly written revision back onto the in-memory envelope so a
	// follow-up HUD sync derives its `sourceRevision` from the persisted revision
	// (not the stale pre-write value), otherwise the active-state writer treats the
	// newer HUD as stale and skips it (e.g. dropping the ambiguity chip after scoring).
	if (writeResult.written && typeof expectedRevision === "number") {
		(envelope as Record<string, unknown>).state_revision = expectedRevision + 1;
	}
	await writeSessionActivityMarker(cwd, sessionId, { writer: "deep-interview-recorder", path: statePath });
}

/**
 * Best-effort active-state/HUD cache refresh for the deep-interview rail, derived
 * from the complete normalized mode-state envelope. HUD is a cache; a failure here
 * must never change durable record semantics.
 */
async function syncRecorderHud(
	cwd: string,
	envelope: DeepInterviewStateEnvelope,
	sessionId: string | undefined,
): Promise<void> {
	const phase = typeof envelope.current_phase === "string" ? envelope.current_phase : "interviewing";
	await syncSkillActiveState({
		cwd,
		skill: "deep-interview",
		active: phase !== "complete",
		phase,
		sessionId,
		source: "gjc-runtime-deep-interview-recorder",
		hud: deriveDeepInterviewHud(normalizeDeepInterviewEnvelope(envelope) as Record<string, unknown>, { phase }),
		sourceRevision: (existingStateRevision(envelope) ?? 0) + 1,
	});
}

/**
 * Repair the cached HUD after a no-op append. A no-op writes no mode-state, so the
 * HUD is derived from a fresh read of the current persisted state (never from the
 * pre-noop in-memory envelope) to avoid overwriting newer active-state with stale values.
 */
async function repairRecorderHudFromPersisted(
	cwd: string,
	statePath: string,
	sessionId: string | undefined,
): Promise<void> {
	try {
		await syncDeepInterviewRecorderHud(cwd, statePath, sessionId);
	} catch {
		// HUD sync is best-effort cache maintenance and must not change record semantics.
	}
}

/** Refresh the best-effort HUD cache from persisted deep-interview state. */
export async function syncDeepInterviewRecorderHud(
	cwd: string,
	statePath: string,
	sessionId: string | undefined,
): Promise<void> {
	const read = await readExistingStateForMutation(statePath);
	if (read.kind !== "valid") return;
	await syncRecorderHud(cwd, normalizeDeepInterviewEnvelope(read.value), sessionId);
}

/**
 * Record an `answered` shell for one round (append-or-merge by durable key).
 *
 * Retraction dynamics: replacing an already-`scored` answer is a mechanical
 * contradiction signal (the user pivoted). The facts that round established are
 * marked disputed, which raises the deterministic ambiguity floor immediately —
 * without waiting for the LLM scorer to self-report a trigger.
 */
export async function appendOrMergeDeepInterviewRound(
	cwd: string,
	statePath: string,
	input: DeepInterviewAnswerInput,
	options: { sessionId?: string } = {},
): Promise<{ action: AppendOrMergeAction; record: DeepInterviewRoundRecord; disputedFactIds?: string[] }> {
	assertDeepInterviewStructuredResponseWithinLimit(input);
	if (input.customInput !== undefined)
		assertDeepInterviewInputWithinLimit(input.customInput, MAX_USER_RESPONSE_LENGTH, "user_response");
	const envelope = await readEnvelope(statePath);
	const interviewId = input.interviewId ?? interviewIdOf(envelope);
	const shell = buildAnswerShell({
		...input,
		interviewId,
		customInput: input.intent_contract || input.intent_review ? undefined : input.customInput,
	});
	const rounds = readRounds(envelope);
	const priorRecord = rounds.find(r => r.round_key === shell.round_key);
	const result = appendOrMergeRound(rounds, shell);
	const inner = envelope.state as Record<string, unknown>;
	let intentStateChanged = false;
	if (input.intent_contract) {
		if (input.round !== 0 || input.component !== "review-topology" || input.dimension !== "topology")
			throw new Error("intent contract requires Round 0 topology metadata");
		const confirmed =
			input.selectedOptions?.length === 1 &&
			input.intent_contract.confirmation_options.includes(input.selectedOptions[0]);
		if (confirmed) {
			const contract = createDeepInterviewIntentManifest(input.intent_contract.items, {
				round: 0,
				answer_hash: shell.answer_hash,
			});
			const existingContract = inner.intent_contract;
			if (existingContract !== undefined) {
				assertDeepInterviewIntentManifest(existingContract);
				if (
					existingContract.digest !== contract.digest ||
					existingContract.confirmation_answer_hash !== contract.confirmation_answer_hash
				)
					throw new Error("locked intent contract cannot be replaced");
			} else {
				inner.intent_contract = contract;
				intentStateChanged = true;
			}
		}
	}
	if (input.intent_review) {
		if (input.round <= 0) throw new Error("intent review requires a post-Round-0 answer");
		const locked = inner.intent_contract;
		assertDeepInterviewIntentManifest(locked);
		const approved =
			input.selectedOptions?.length === 1 && input.intent_review.approval_options.includes(input.selectedOptions[0]);
		inner.intent_review = reviewDeepInterviewIntent(locked, input.intent_review.observed_items, {
			status: approved ? "approved" : "pending",
			supporting_substitutions: input.intent_review.supporting_substitutions,
			...(approved
				? {
						approval_round: input.round,
						answer_hash: shell.answer_hash,
						user_answer_evidence: `answer_hash:${shell.answer_hash}`,
					}
				: {}),
		});
		intentStateChanged = true;
	}
	if (result.action === "noop" && !intentStateChanged) {
		await repairRecorderHudFromPersisted(cwd, statePath, options.sessionId);
		return { action: result.action, record: result.record };
	}
	inner.rounds = result.rounds;
	let disputedFactIds: string[] | undefined;
	if (result.action === "replaced" && priorRecord?.lifecycle === "scored") {
		const facts = Array.isArray(inner.established_facts) ? inner.established_facts : [];
		const disputed = disputeFactsFromRetractedRound(facts, shell.round);
		if (disputed.disputedIds.length > 0) {
			inner.established_facts = disputed.facts;
			disputedFactIds = disputed.disputedIds;
			// Surface the rise right away: the retraction changed the evidence, so the
			// gating score must reflect the new floor before the next scoring pass.
			const breakdown = computeAmbiguityFloor(inner);
			inner.ambiguity_floor = breakdown;
			if (typeof inner.current_ambiguity === "number") {
				inner.current_ambiguity = clampReportedAmbiguity(inner.current_ambiguity, breakdown.floor).effective;
			}
		}
	}
	await persistEnvelope(cwd, statePath, envelope, options.sessionId, "gjc deep-interview record-answer");
	try {
		await syncRecorderHud(cwd, envelope, options.sessionId);
	} catch {
		// HUD sync is best-effort cache maintenance and must not change record semantics.
	}
	return { action: result.action, record: result.record, disputedFactIds };
}

/**
 * The chronological scored predecessor of the round currently being scored: the
 * scored round with the greatest `round` strictly less than `currentRound`, with
 * the same durable key excluded. Selecting by `round` (not array position) ensures
 * an out-of-order re-score of an earlier round compares against its true prior, never
 * a later ("future") scored round that happens to sit later in the array.
 *
 * Fail-safe: if `currentRound` is not a finite number, or a candidate's `round` is
 * not finite, that comparison is treated as non-matching, so no prior is selected
 * rather than risking a spurious comparison against an unrelated round.
 */
function latestPriorScoredRound(
	rounds: readonly DeepInterviewRoundRecord[],
	currentKey: string,
	currentRound: number,
): DeepInterviewRoundRecord | undefined {
	if (!Number.isFinite(currentRound)) return undefined;
	let prior: DeepInterviewRoundRecord | undefined;
	for (const candidate of rounds) {
		if (candidate.lifecycle !== "scored") continue;
		if (candidate.round_key === currentKey) continue;
		if (!Number.isFinite(candidate.round)) continue;
		if (!(candidate.round < currentRound)) continue;
		if (prior === undefined || candidate.round > prior.round) prior = candidate;
	}
	return prior;
}

/** Merge scoring output into the same round record, transitioning to `scored`. */
export async function enrichDeepInterviewRoundScoring(
	cwd: string,
	statePath: string,
	input: DeepInterviewScoringInput,
	options: { sessionId?: string } = {},
): Promise<{ record: DeepInterviewRoundRecord }> {
	assertDeepInterviewStructuredResponseWithinLimit(input);
	const envelope = await readEnvelope(statePath);
	const interviewId = input.interviewId ?? interviewIdOf(envelope);
	const rounds = readRounds(envelope);
	const { rounds: enrichedRounds, record: reportedRecord } = enrichRoundWithScoring(rounds, {
		...input,
		interviewId,
	});
	// Deterministic floor (Ouroboros principle): the LLM-reported ambiguity is only a
	// lower-bound input. Evidence persisted in state — unresolved disputed facts,
	// unscored active components, auto-answer dilution — sets a code-computed floor
	// the reported score can never fall under, so a pivot mechanically raises the
	// gating score even when the scorer omits triggers.
	const inner = envelope.state as Record<string, unknown>;
	const breakdown = computeAmbiguityFloor({ ...inner, rounds: enrichedRounds });
	const clampResult = clampReportedAmbiguity(input.ambiguity, breakdown.floor);
	let record = reportedRecord;
	let nextRounds = enrichedRounds;
	if (clampResult.clamped) {
		record = {
			...reportedRecord,
			ambiguity: clampResult.effective,
			reported_ambiguity: input.ambiguity,
			ambiguity_floor: breakdown.floor,
		};
		nextRounds = enrichedRounds.map(item => (item.round_key === record.round_key ? record : item));
	}
	// Fail closed: a scored transition that violates the bidirectional invariant
	// (an active trigger that improves the affected dimension or fails to raise
	// overall ambiguity, or a disputed/unresolved trigger lacking a rationale) must
	// never be persisted — storing it lets the interview falsely converge. Validate
	// the effective (floor-clamped) record against the most recent prior scored round.
	const prior = latestPriorScoredRound(rounds, record.round_key, record.round);
	const validation = validateDeepInterviewScoredTransition(prior, record);
	if (!validation.ok) {
		throw new Error(
			`deep-interview scored transition for round ${record.round} is invalid and was refused: ${validation.violations.join("; ")}`,
		);
	}
	inner.rounds = nextRounds;
	inner.current_ambiguity = clampResult.effective;
	inner.ambiguity_floor = breakdown;
	await persistEnvelope(cwd, statePath, envelope, options.sessionId, "gjc deep-interview score-round");
	await syncRecorderHud(cwd, envelope, options.sessionId);
	return { record };
}

/** Compact projection so callers read a slice instead of the full transcript. */
export async function readDeepInterviewStateCompact(
	statePath: string,
	options: { lastN?: number } = {},
): Promise<DeepInterviewCompactState> {
	const read = await readExistingStateForMutation(statePath);
	const value = read.kind === "valid" ? read.value : undefined;
	return projectCompactState(value, options);
}
