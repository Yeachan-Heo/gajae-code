import { syncSkillActiveState } from "../skill-state/active-state";
import { deriveDeepInterviewHud } from "../skill-state/workflow-hud";
import {
	answerHash,
	applyDeepInterviewRoundResultV1,
	assertDeepInterviewInputWithinLimit,
	assertDeepInterviewIntentManifest,
	assertDeepInterviewStructuredResponseWithinLimit,
	createDeepInterviewIntentManifest,
	type DeepInterviewEstablishedFact,
	type DeepInterviewIntentItem,
	type DeepInterviewIntentSubstitution,
	type DeepInterviewRoundRecord,
	type DeepInterviewRoundResultV1,
	type DeepInterviewStateEnvelope,
	type DeepInterviewTriggerMetadata,
	deepInterviewAnswerIdentityEqual,
	deriveRoundKey,
	MAX_USER_RESPONSE_LENGTH,
	normalizeDeepInterviewEnvelope,
	questionHash,
	reviewDeepInterviewIntent,
} from "./deep-interview-state";
import { writeSessionActivityMarker } from "./session-resolution";
import { readExistingStateForMutation, transformGuardedWorkflowEnvelopeAtomic } from "./state-writer";

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
	/** Complete native round result for typed callers. */
	roundResult?: DeepInterviewRoundResultV1;
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
 * Append-or-merge by `round_key`. An answer is a no-op only when its complete
 * canonical shell identity matches; a scored record is immutable evidence and
 * cannot be replaced by a late answer.
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
	if (deepInterviewAnswerIdentityEqual(existing, shell) && existing.answer_hash === shell.answer_hash) {
		return { rounds: next, action: "noop", record: existing };
	}
	if (existing.lifecycle === "scored") throw new Error("DI_ANSWER_LIFECYCLE_CONFLICT");
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
		// The runtime derives both dimension values from scored records; callers cannot
		// provide parallel trigger metrics.
		const priorDim = prior.scores?.[trigger.dimension];
		const nextDim = next.scores?.[trigger.dimension];
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

interface RecorderMutationOptions {
	sessionId?: string;
	expectedRevision?: number;
}

async function readEnvelope(statePath: string): Promise<DeepInterviewStateEnvelope> {
	const read = await readExistingStateForMutation(statePath);
	if (read.kind === "valid") return ensureDeepInterviewStateShape(read.value);
	if (read.kind === "absent") throw new Error("DI_STATE_ABSENT");
	throw new Error(`deep-interview state at ${statePath} is corrupt or tampered (${read.error})`);
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
interface RecorderHudSyncSlot {
	latestCommittedRevision: number;
	tail: Promise<void>;
}

const recorderHudSyncSlots = new Map<string, RecorderHudSyncSlot>();

async function syncRecorderHud(
	cwd: string,
	envelope: Record<string, unknown>,
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
		hud: deriveDeepInterviewHud(envelope, { phase }),
		...(typeof envelope.state_revision === "number" ? { committedModeRevision: envelope.state_revision } : {}),
	});
}

async function syncRecorderHudAtCommittedRevision(
	cwd: string,
	envelope: Record<string, unknown>,
	sessionId: string,
	revision: number,
): Promise<void> {
	const key = `${cwd}\0${sessionId}`;
	const slot = recorderHudSyncSlots.get(key) ?? { latestCommittedRevision: -1, tail: Promise.resolve() };
	recorderHudSyncSlots.set(key, slot);
	const sync = slot.tail
		.catch(() => undefined)
		.then(async () => {
			if (revision <= slot.latestCommittedRevision) return;
			await syncRecorderHud(cwd, { ...envelope, state_revision: revision }, sessionId);
			slot.latestCommittedRevision = revision;
		});
	slot.tail = sync;
	await sync;
}
export interface DeepInterviewPostCommitWarning {
	code: "DI_POST_COMMIT_AUDIT_FAILED" | "DI_POST_COMMIT_ACTIVITY_FAILED" | "DI_POST_COMMIT_HUD_FAILED";
	message: string;
}

export async function runDeepInterviewPostCommitEffects(options: {
	cwd: string;
	statePath: string;
	sessionId: string;
	envelope: Record<string, unknown>;
	revision: number;
	writer: string;
	auditWarnings?: readonly { code: "DI_POST_COMMIT_AUDIT_FAILED"; message: string }[];
}): Promise<DeepInterviewPostCommitWarning[]> {
	const warnings: DeepInterviewPostCommitWarning[] = [...(options.auditWarnings ?? [])];
	try {
		await writeSessionActivityMarker(options.cwd, options.sessionId, {
			writer: options.writer,
			path: options.statePath,
		});
	} catch (error) {
		warnings.push({
			code: "DI_POST_COMMIT_ACTIVITY_FAILED",
			message: error instanceof Error ? error.message : String(error),
		});
	}
	try {
		await syncRecorderHudAtCommittedRevision(options.cwd, options.envelope, options.sessionId, options.revision);
	} catch (error) {
		warnings.push({
			code: "DI_POST_COMMIT_HUD_FAILED",
			message: error instanceof Error ? error.message : String(error),
		});
	}
	return warnings;
}

/** Refresh the best-effort HUD cache from persisted deep-interview state. */
export async function syncDeepInterviewRecorderHud(
	cwd: string,
	statePath: string,
	sessionId: string | undefined,
): Promise<void> {
	const read = await readExistingStateForMutation(statePath);
	if (read.kind !== "valid") return;
	const envelope = normalizeDeepInterviewEnvelope(read.value);
	const revision = existingStateRevision(read.value);
	if (revision === undefined || !sessionId) return;
	await syncRecorderHudAtCommittedRevision(cwd, envelope, sessionId, revision);
}

/**
 * Record an `answered` shell for one round (append-or-merge by durable key).
 *
 * Replacing an already-scored answer is rejected with
 * `DI_ANSWER_LIFECYCLE_CONFLICT`; scored evidence is immutable.
 */
export async function appendOrMergeDeepInterviewRound(
	cwd: string,
	statePath: string,
	input: DeepInterviewAnswerInput,
	options: RecorderMutationOptions = {},
): Promise<{
	action: AppendOrMergeAction;
	record: DeepInterviewRoundRecord;
	warnings: DeepInterviewPostCommitWarning[];
}> {
	assertDeepInterviewStructuredResponseWithinLimit(input);
	if (input.customInput !== undefined)
		assertDeepInterviewInputWithinLimit(input.customInput, MAX_USER_RESPONSE_LENGTH, "user_response");
	if (!options.sessionId) throw new Error("deep-interview recorder requires a session id");
	const initial = await readEnvelope(statePath);
	let result: AppendOrMergeResult | undefined;
	const now = new Date().toISOString();
	const committed = await transformGuardedWorkflowEnvelopeAtomic(statePath, {
		cwd,
		expectedRevision: options.expectedRevision ?? existingStateRevision(initial) ?? 0,
		receipt: {
			cwd,
			skill: "deep-interview",
			owner: "gjc-runtime",
			command: "gjc deep-interview record-answer",
			sessionId: options.sessionId,
			nowIso: now,
		},
		audit: {
			category: "state",
			verb: "write",
			owner: "gjc-runtime",
			skill: "deep-interview",
			sessionId: options.sessionId,
		},
		transform: current => {
			const envelope = ensureDeepInterviewStateShape(current);
			const shell = buildAnswerShell(
				{
					...input,
					interviewId: input.interviewId ?? interviewIdOf(envelope),
					customInput: input.intent_contract || input.intent_review ? undefined : input.customInput,
				},
				now,
			);
			result = appendOrMergeRound(readRounds(envelope), shell);
			const state = envelope.state as Record<string, unknown>;
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
					const existingContract = state.intent_contract;
					if (existingContract !== undefined) {
						assertDeepInterviewIntentManifest(existingContract);
						if (
							existingContract.digest !== contract.digest ||
							existingContract.confirmation_answer_hash !== contract.confirmation_answer_hash
						)
							throw new Error("locked intent contract cannot be replaced");
					} else {
						state.intent_contract = contract;
						intentStateChanged = true;
					}
				}
			}
			if (input.intent_review) {
				if (input.round <= 0) throw new Error("intent review requires a post-Round-0 answer");
				const locked = state.intent_contract;
				assertDeepInterviewIntentManifest(locked);
				const approved =
					input.selectedOptions?.length === 1 &&
					input.intent_review.approval_options.includes(input.selectedOptions[0]);
				state.intent_review = reviewDeepInterviewIntent(locked, input.intent_review.observed_items, {
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
			if (result.action === "noop" && !intentStateChanged) return { kind: "noop" as const };
			state.rounds = result.rounds;
			return { kind: "write" as const, value: { ...envelope, updated_at: now } as Record<string, unknown> };
		},
	});
	if (!result) throw new Error("DI_STATE_SCHEMA_INVALID");
	const warnings = committed.written
		? await runDeepInterviewPostCommitEffects({
				cwd,
				statePath,
				sessionId: options.sessionId,
				envelope: committed.stamped,
				revision: committed.revision,
				writer: "deep-interview-recorder",
				auditWarnings: committed.warnings,
			})
		: [];
	return { action: result.action, record: result.record, warnings };
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
function legacyScoringRoundResult(
	envelope: DeepInterviewStateEnvelope,
	input: DeepInterviewScoringInput,
): DeepInterviewRoundResultV1 {
	if (input.roundResult) return input.roundResult;
	const state = envelope.state as Record<string, unknown>;
	const type = state.type;
	const dimensions =
		type === "brownfield"
			? ["goal", "constraints", "criteria", "context"]
			: type === "greenfield"
				? ["goal", "constraints", "criteria"]
				: undefined;
	if (
		!dimensions?.every(
			dimension => typeof input.scores[dimension] === "number" && Number.isFinite(input.scores[dimension]),
		)
	) {
		throw new Error(
			"DI_LEGACY_SCORING_INPUT_INSUFFICIENT: provide roundResult with complete global and component scores",
		);
	}
	const topology = state.topology;
	const hasActiveComponents =
		!!topology &&
		typeof topology === "object" &&
		!Array.isArray(topology) &&
		(() => {
			const topologyRecord = topology as Record<string, unknown>;
			if (!Array.isArray(topologyRecord.components)) return false;
			const components = topologyRecord.components as unknown[];
			return components.some(
				(component: unknown) =>
					component &&
					typeof component === "object" &&
					!Array.isArray(component) &&
					(component as Record<string, unknown>).active !== false &&
					(component as Record<string, unknown>).status !== "deferred",
			);
		})();
	if (hasActiveComponents) {
		throw new Error(
			"DI_LEGACY_SCORING_INPUT_INSUFFICIENT: provide roundResult with complete global and component scores",
		);
	}
	return {
		global_scores: Object.fromEntries(
			dimensions.map(dimension => [dimension, input.scores[dimension]]),
		) as DeepInterviewRoundResultV1["global_scores"],
		component_scores: {},
		...(input.triggers === undefined ? {} : { triggers: input.triggers }),
	};
}

/** Merge scoring output into the same round record, transitioning to `scored`. */
export async function enrichDeepInterviewRoundScoring(
	cwd: string,
	statePath: string,
	input: DeepInterviewScoringInput,
	options: RecorderMutationOptions = {},
): Promise<{ record: DeepInterviewRoundRecord; warnings: DeepInterviewPostCommitWarning[] }> {
	assertDeepInterviewStructuredResponseWithinLimit(input);
	if (!options.sessionId) throw new Error("deep-interview recorder requires a session id");
	const initial = await readEnvelope(statePath);
	const now = new Date().toISOString();
	let record: DeepInterviewRoundRecord | undefined;
	const committed = await transformGuardedWorkflowEnvelopeAtomic(statePath, {
		cwd,
		expectedRevision: options.expectedRevision ?? existingStateRevision(initial) ?? 0,
		receipt: {
			cwd,
			skill: "deep-interview",
			owner: "gjc-runtime",
			command: "gjc deep-interview score-round",
			sessionId: options.sessionId,
			nowIso: now,
		},
		audit: {
			category: "state",
			verb: "write",
			owner: "gjc-runtime",
			skill: "deep-interview",
			sessionId: options.sessionId,
		},
		transform: current => {
			const envelope = ensureDeepInterviewStateShape(current);
			const interviewId = input.interviewId ?? interviewIdOf(envelope);
			const roundKey = deriveRoundKey(interviewId, input);
			const outcome = applyDeepInterviewRoundResultV1(
				envelope,
				roundKey,
				legacyScoringRoundResult(envelope, input),
				now,
			);
			const next = ensureDeepInterviewStateShape(outcome.envelope);
			record = readRounds(next).find(round => round.round_key === roundKey);
			if (!record) throw new Error("DI_STATE_SCHEMA_INVALID");
			if (outcome.kind === "noop") return { kind: "noop" as const };
			return {
				kind: "write" as const,
				value: { ...next, schema_version: 1, updated_at: now } as Record<string, unknown>,
			};
		},
	});
	if (!record) throw new Error("DI_STATE_SCHEMA_INVALID");
	const warnings = committed.written
		? await runDeepInterviewPostCommitEffects({
				cwd,
				statePath,
				sessionId: options.sessionId,
				envelope: committed.stamped,
				revision: committed.revision,
				writer: "deep-interview-recorder",
				auditWarnings: committed.warnings,
			})
		: [];
	return { record, warnings };
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
