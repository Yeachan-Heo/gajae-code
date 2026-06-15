import { syncSkillActiveState } from "../skill-state/active-state";
import { deriveDeepInterviewHud } from "../skill-state/workflow-hud";
import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-contract";
import {
	answerHash,
	type DeepInterviewEstablishedFact,
	type DeepInterviewRoundRecord,
	type DeepInterviewStateEnvelope,
	type DeepInterviewTriggerMetadata,
	deriveRoundKey,
	normalizeDeepInterviewEnvelope,
	questionHash,
} from "./deep-interview-state";
import { readExistingStateForMutation, writeWorkflowEnvelopeAtomic } from "./state-writer";

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
	const now = new Date().toISOString();
	const payload: Record<string, unknown> = { ...normalizeDeepInterviewEnvelope(envelope), updated_at: now };
	// Guarantee RequiredOnWriteEnvelopeSchema fields for the fresh/absent fallback;
	// existing real state already carries these and is preserved by the spread above.
	payload.skill ??= "deep-interview";
	payload.version ??= WORKFLOW_STATE_VERSION;
	payload.active ??= true;
	payload.current_phase ??= "interviewing";
	await writeWorkflowEnvelopeAtomic(statePath, payload, {
		cwd,
		receipt: { cwd, skill: "deep-interview", owner: "gjc-runtime", command, sessionId, nowIso: now },
		audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "deep-interview" },
	});
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
	try {
		const phase = typeof envelope.current_phase === "string" ? envelope.current_phase : "interviewing";
		await syncSkillActiveState({
			cwd,
			skill: "deep-interview",
			active: phase !== "complete",
			phase,
			sessionId,
			source: "gjc-runtime-deep-interview-recorder",
			hud: deriveDeepInterviewHud(envelope as Record<string, unknown>, { phase }),
		});
	} catch {
		// HUD sync is best-effort cache maintenance and must not change record semantics.
	}
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
	const read = await readExistingStateForMutation(statePath);
	if (read.kind !== "valid") return;
	await syncRecorderHud(cwd, normalizeDeepInterviewEnvelope(read.value), sessionId);
}

/** Record an `answered` shell for one round (append-or-merge by durable key). */
export async function appendOrMergeDeepInterviewRound(
	cwd: string,
	statePath: string,
	input: DeepInterviewAnswerInput,
	options: { sessionId?: string } = {},
): Promise<{ action: AppendOrMergeAction; record: DeepInterviewRoundRecord }> {
	const envelope = await readEnvelope(statePath);
	const interviewId = input.interviewId ?? interviewIdOf(envelope);
	const shell = buildAnswerShell({ ...input, interviewId });
	const rounds = readRounds(envelope);
	const result = appendOrMergeRound(rounds, shell);
	if (result.action === "noop") {
		await repairRecorderHudFromPersisted(cwd, statePath, options.sessionId);
		return { action: result.action, record: result.record };
	}
	(envelope.state as Record<string, unknown>).rounds = result.rounds;
	await persistEnvelope(cwd, statePath, envelope, options.sessionId, "gjc deep-interview record-answer");
	await syncRecorderHud(cwd, envelope, options.sessionId);
	return { action: result.action, record: result.record };
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
	const envelope = await readEnvelope(statePath);
	const interviewId = input.interviewId ?? interviewIdOf(envelope);
	const rounds = readRounds(envelope);
	const { rounds: nextRounds, record } = enrichRoundWithScoring(rounds, { ...input, interviewId });
	// Fail closed: a scored transition that violates the bidirectional invariant
	// (an active trigger that improves the affected dimension or fails to raise
	// overall ambiguity, or a disputed/unresolved trigger lacking a rationale) must
	// never be persisted — storing it lets the interview falsely converge. Validate
	// against the most recent prior scored round before writing any durable state.
	const prior = latestPriorScoredRound(rounds, record.round_key, record.round);
	const validation = validateDeepInterviewScoredTransition(prior, record);
	if (!validation.ok) {
		throw new Error(
			`deep-interview scored transition for round ${record.round} is invalid and was refused: ${validation.violations.join("; ")}`,
		);
	}
	(envelope.state as Record<string, unknown>).rounds = nextRounds;
	(envelope.state as Record<string, unknown>).current_ambiguity = input.ambiguity;
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
