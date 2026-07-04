import {
	type DeepInterviewEstablishedFact,
	type DeepInterviewRoundRecord,
	type DeepInterviewStateEnvelope,
	normalizeDeepInterviewEnvelope,
} from "./deep-interview-state";

/**
 * Deterministic ambiguity floor for deep-interview.
 *
 * The interview's ambiguity score is reported by an LLM scorer, which anchors on
 * prior scores and under-reports rises when the user pivots or contradicts earlier
 * answers. Following the Ouroboros `max(llm_score, deterministic_floor(ledger))`
 * principle, this pure leaf module computes a code-level lower bound from evidence
 * already persisted in deep-interview state, so the reported score can never fall
 * below what code can objectively measure:
 *
 * - `0.10` per established fact marked disputed with no `superseded_by` resolution
 *   (contradiction pressure — a pivot keeps ambiguity elevated until resolved);
 * - `0.05` per active topology component whose goal/constraints/criteria clarity
 *   is still unscored (gap pressure — a sibling component cannot hide);
 * - `0.05 × (auto-answered rounds / scored rounds)` (assumption dilution).
 *
 * Like `deep-interview-state`, this module MUST stay pure and dependency-free
 * (no filesystem, no state-writer, no CLI runtime) so every writer can apply it.
 */

// =============================================================================
// Weights (mirrors the Ouroboros deterministic_floor coefficients)
// =============================================================================

const DISPUTED_FACT_WEIGHT = 0.1;
const UNSCORED_COMPONENT_WEIGHT = 0.05;
const AUTO_ANSWER_DILUTION_WEIGHT = 0.05;

const CORE_CLARITY_DIMENSIONS = ["goal", "constraints", "criteria"] as const;

export interface AmbiguityFloorBreakdown {
	floor: number;
	disputed_fact_count: number;
	unscored_active_component_count: number;
	auto_answer_ratio: number;
}

export interface AmbiguityClampResult {
	effective: number;
	clamped: boolean;
}

// =============================================================================
// Pure helpers
// =============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

/** A disputed fact contributes pressure until it is resolved via `superseded_by` or re-confirmation. */
function isUnresolvedDisputedFact(value: unknown): boolean {
	if (!isPlainObject(value)) return false;
	const fact = value as Partial<DeepInterviewEstablishedFact>;
	if (fact.disputed !== true) return false;
	return typeof fact.superseded_by !== "string" || fact.superseded_by.trim() === "";
}

/**
 * An active component is unscored while any core clarity dimension lacks a finite
 * numeric score. Deferred components are excluded (they are outside ambiguity math),
 * and the gate only arms once the topology was explicitly confirmed in Round 0.
 */
function countUnscoredActiveComponents(topology: unknown): number {
	if (!isPlainObject(topology) || topology.status !== "confirmed") return 0;
	let unscored = 0;
	for (const component of asArray(topology.components)) {
		if (!isPlainObject(component) || component.status === "deferred") continue;
		const clarity = isPlainObject(component.clarity_scores) ? component.clarity_scores : {};
		const incomplete = CORE_CLARITY_DIMENSIONS.some(dimension => {
			const score = clarity[dimension];
			return typeof score !== "number" || !Number.isFinite(score);
		});
		if (incomplete) unscored += 1;
	}
	return unscored;
}

function autoAnswerRatio(inner: Record<string, unknown>): number {
	const autoAnswered = asArray(inner.auto_answered_rounds).length;
	if (autoAnswered === 0) return 0;
	const scored = asArray(inner.rounds).filter(round => isPlainObject(round) && round.lifecycle === "scored").length;
	return Math.min(1, autoAnswered / Math.max(scored, 1));
}

// =============================================================================
// Floor computation + clamping
// =============================================================================

/** Compute the deterministic floor from the inner deep-interview `state` object. */
export function computeAmbiguityFloor(inner: unknown): AmbiguityFloorBreakdown {
	const state = isPlainObject(inner) ? inner : {};
	const disputedFactCount = asArray(state.established_facts).filter(isUnresolvedDisputedFact).length;
	const unscoredActiveComponentCount = countUnscoredActiveComponents(state.topology);
	const ratio = autoAnswerRatio(state);
	const floor =
		DISPUTED_FACT_WEIGHT * disputedFactCount +
		UNSCORED_COMPONENT_WEIGHT * unscoredActiveComponentCount +
		AUTO_ANSWER_DILUTION_WEIGHT * ratio;
	return {
		floor: round2(Math.min(1, Math.max(0, floor))),
		disputed_fact_count: disputedFactCount,
		unscored_active_component_count: unscoredActiveComponentCount,
		auto_answer_ratio: round2(ratio),
	};
}

/** Clamp an LLM-reported ambiguity to the deterministic floor: `max(reported, floor)`. */
export function clampReportedAmbiguity(reported: number, floor: number): AmbiguityClampResult {
	const bounded = Math.min(1, Math.max(0, reported));
	if (floor > bounded) return { effective: Math.min(1, floor), clamped: true };
	return { effective: bounded, clamped: false };
}

/**
 * Mark every established fact recorded in `retractedRound` as disputed. This is the
 * mechanical contradiction signal for answer retraction: when the user replaces an
 * already-scored answer (A -> B pivot), the facts that answer established can no
 * longer be trusted, so they raise the floor until re-confirmed or superseded.
 * Returns new arrays/objects; never mutates the input.
 */
export function disputeFactsFromRetractedRound(
	facts: readonly unknown[],
	retractedRound: number,
): { facts: Record<string, unknown>[]; disputedIds: string[] } {
	const disputedIds: string[] = [];
	const next = facts.filter(isPlainObject).map(fact => {
		const record = fact as Record<string, unknown>;
		if (record.round !== retractedRound || record.disputed === true) return { ...record };
		if (typeof record.superseded_by === "string" && record.superseded_by.trim() !== "") return { ...record };
		if (typeof record.id === "string") disputedIds.push(record.id);
		return { ...record, disputed: true };
	});
	return { facts: next, disputedIds };
}

export interface AppliedAmbiguityFloor {
	envelope: DeepInterviewStateEnvelope;
	breakdown: AmbiguityFloorBreakdown;
	clamped: boolean;
}

/**
 * Enforce the floor invariant on a full deep-interview envelope: recompute the floor
 * from persisted evidence, clamp `state.current_ambiguity`, and clamp the latest
 * scored round (preserving the original value as `reported_ambiguity` for audit).
 * Historical rounds are never rewritten. Idempotent and non-mutating; every writer
 * (state CLI write/reconcile, recorder) applies this immediately before persisting.
 */
export function applyAmbiguityFloorToEnvelope(value: unknown): AppliedAmbiguityFloor {
	const envelope = normalizeDeepInterviewEnvelope(value);
	const inner = { ...(envelope.state as Record<string, unknown>) };
	const breakdown = computeAmbiguityFloor(inner);
	let clamped = false;

	const rounds = asArray(inner.rounds).filter(isPlainObject) as unknown as DeepInterviewRoundRecord[];
	let latestScoredIndex = -1;
	for (let index = 0; index < rounds.length; index += 1) {
		const candidate = rounds[index];
		if (candidate.lifecycle !== "scored" || !Number.isFinite(candidate.round)) continue;
		if (latestScoredIndex < 0 || candidate.round >= rounds[latestScoredIndex].round) latestScoredIndex = index;
	}
	if (latestScoredIndex >= 0) {
		const latest = rounds[latestScoredIndex];
		if (typeof latest.ambiguity === "number") {
			const clampedRound = clampReportedAmbiguity(latest.ambiguity, breakdown.floor);
			if (clampedRound.clamped) {
				const nextRounds = [...rounds];
				nextRounds[latestScoredIndex] = {
					...latest,
					reported_ambiguity: latest.reported_ambiguity ?? latest.ambiguity,
					ambiguity: clampedRound.effective,
					ambiguity_floor: breakdown.floor,
				};
				inner.rounds = nextRounds;
				clamped = true;
			}
		}
	}

	if (typeof inner.current_ambiguity === "number") {
		const clampedCurrent = clampReportedAmbiguity(inner.current_ambiguity, breakdown.floor);
		if (clampedCurrent.clamped) {
			inner.current_ambiguity = clampedCurrent.effective;
			clamped = true;
		}
	}

	inner.ambiguity_floor = breakdown;
	return { envelope: { ...envelope, state: inner }, breakdown, clamped };
}
