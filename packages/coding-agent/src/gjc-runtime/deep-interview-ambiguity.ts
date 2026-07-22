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

/** A disputed fact contributes pressure until it is resolved or superseded. */
function isUnresolvedDisputedFact(value: unknown): boolean {
	if (!isPlainObject(value)) return false;
	const fact = value as Partial<DeepInterviewEstablishedFact> & { status?: unknown };
	if (fact.disputed !== true && fact.status !== "disputed") return false;
	return typeof fact.superseded_by !== "string" || fact.superseded_by.trim() === "";
}

/**
 * An active component is unscored while any core clarity dimension lacks a finite
 * numeric score. Deferred and inactive components are outside ambiguity math.
 */
function countUnscoredActiveComponents(topology: unknown): number {
	if (!isPlainObject(topology) || topology.status !== "confirmed") return 0;
	let unscored = 0;
	for (const component of asArray(topology.components)) {
		if (!isPlainObject(component) || component.status === "deferred" || component.active === false) continue;
		const scores = isPlainObject(component.scores)
			? component.scores
			: isPlainObject(component.clarity_scores)
				? component.clarity_scores
				: {};
		if (
			CORE_CLARITY_DIMENSIONS.some(dimension => {
				const score = scores[dimension];
				return typeof score !== "number" || !Number.isFinite(score);
			})
		) {
			unscored += 1;
		}
	}
	return unscored;
}

/** Compute the deterministic floor from integer units of persisted evidence. */
export function computeAmbiguityFloor(inner: unknown): AmbiguityFloorBreakdown {
	const state = isPlainObject(inner) ? inner : {};
	const disputedFactCount = asArray(state.established_facts).filter(isUnresolvedDisputedFact).length;
	const unscoredActiveComponentCount = countUnscoredActiveComponents(state.topology);
	const scored = asArray(state.rounds).filter(round => isPlainObject(round) && round.lifecycle === "scored").length;
	const autoAnswered = new Set(asArray(state.auto_answered_rounds).map(value => JSON.stringify(value))).size;
	const ratioUnits = scored === 0 ? 0 : Math.min(10_000, Math.floor((autoAnswered * 10_000) / scored));
	const floorUnits = Math.min(
		10_000,
		disputedFactCount * 1_000 + unscoredActiveComponentCount * 500 + Math.floor(ratioUnits / 20),
	);
	return {
		floor: floorUnits / 10_000,
		disputed_fact_count: disputedFactCount,
		unscored_active_component_count: unscoredActiveComponentCount,
		auto_answer_ratio: ratioUnits / 10_000,
	};
}

/** Clamp an LLM-reported ambiguity to the deterministic floor: `max(reported, floor)`. */
export function clampReportedAmbiguity(reported: number, floor: number): AmbiguityClampResult {
	const bounded = Math.min(1, Math.max(0, reported));
	if (floor > bounded) return { effective: Math.min(1, floor), clamped: true };
	return { effective: bounded, clamped: false };
}

/**
 * Legacy pure utility for migrations and explicit repair flows. The recorder does
 * not dispute facts when an answer is retracted: scored evidence is immutable.
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
export type DeepInterviewAmbiguityMilestone = "initial" | "progress" | "refined" | "ready";

export function deriveAmbiguityMilestone(
	effectiveUnits: number,
	thresholdUnits: number,
): DeepInterviewAmbiguityMilestone {
	if (!Number.isSafeInteger(effectiveUnits) || effectiveUnits < 0 || effectiveUnits > 10_000) {
		throw new RangeError("effective ambiguity units must be an integer from 0 to 10000");
	}
	if (!Number.isSafeInteger(thresholdUnits) || thresholdUnits < 1 || thresholdUnits > 10_000) {
		throw new RangeError("threshold units must be an integer from 1 to 10000");
	}
	if (effectiveUnits <= thresholdUnits) return "ready";
	if (effectiveUnits > 6_000) return "initial";
	if (effectiveUnits > 3_000) return "progress";
	return "refined";
}

export function scoreToUnits(score: number): number {
	if (!Number.isFinite(score) || score < 0 || score > 1) throw new RangeError("score must be finite in [0, 1]");
	const units = score * 10_000;
	if (!Number.isSafeInteger(units)) throw new RangeError("score must be expressed in integral 1e-4 units");
	return units;
}

export function weightedAmbiguityUnits(
	scores: { goal: number; constraints: number; criteria: number; context?: number },
	type: "greenfield" | "brownfield",
): number {
	const goal = scoreToUnits(scores.goal);
	const constraints = scoreToUnits(scores.constraints);
	const criteria = scoreToUnits(scores.criteria);
	const numerator =
		type === "brownfield"
			? 35 * goal + 25 * constraints + 25 * criteria + 15 * scoreToUnits(scores.context ?? Number.NaN)
			: 40 * goal + 30 * constraints + 30 * criteria;
	return 10_000 - Math.floor(numerator / 100 + 0.5);
}
