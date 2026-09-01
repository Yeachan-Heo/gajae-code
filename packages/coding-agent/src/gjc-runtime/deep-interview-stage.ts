import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { syncSkillActiveState } from "../skill-state/active-state";
import { deriveDeepInterviewHud } from "../skill-state/workflow-hud";
import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-contract";
import { applyAmbiguityFloorToEnvelope } from "./deep-interview-ambiguity";
import {
	assertDeepInterviewEnvelopeInputLimits,
	assertDeepInterviewIntentManifest,
	assertDeepInterviewStructuredResponseWithinLimit,
	ENVELOPE_RESERVED_STATE_KEYS,
	mergeDeepInterviewEnvelope,
	normalizeDeepInterviewEnvelope,
} from "./deep-interview-state";
import { sessionStateDir } from "./session-layout";
import { resolveGjcSessionForWrite, SessionResolutionError, writeSessionActivityMarker } from "./session-resolution";
import { runNativeStateCommand } from "./state-runtime";
import {
	persistedStateRevision,
	readExistingStateForMutation,
	StateWriteConflictError,
	withWorkflowStateLock,
	workflowEnvelopeContentSha256,
	writeGuardedWorkflowEnvelopeAtomic,
	writeJsonAtomic,
} from "./state-writer";
import { CommandError, flagValue, hasFlag, isPlainObject } from "./workflow-cli-common";

/**
 * Staged JSON transitions for deep-interview state (`gjc deep-interview stage|check|apply|discard`).
 *
 * Design contract (post-#3040 revert; deliberately NOT the typed-flag surface):
 * - The payload is one JSON document supplied whole (`--input '<json>'` or `@file`),
 *   merged into current state through the same lossless envelope merge every other
 *   sanctioned deep-interview writer uses. There is no per-field flag grammar.
 * - Exactly one pending draft exists per session at a fixed session-scoped path,
 *   so no `--draft-id` is needed; the session resolves from `GJC_SESSION_ID` (or
 *   payload `session_id`), so no identity flags are needed.
 * - The draft records the `state_revision` it was staged against; `apply` enforces
 *   that runtime-side (CAS). A stale draft is auto-invalidated with typed recovery
 *   guidance — the agent never does revision arithmetic.
 * - `check` dry-runs the identical merge `apply` performs. Validation is core-schema
 *   only (envelope shape, bounded input sizes, locked intent-contract immutability);
 *   free-form interview fields pass through untouched.
 */

import * as path from "node:path";

export const DEEP_INTERVIEW_STAGE_TRANSITIONS = [
	"initialize-context",
	"record-round",
	"update-facts",
	"merge-state",
] as const;
export type DeepInterviewStageTransition = (typeof DEEP_INTERVIEW_STAGE_TRANSITIONS)[number];

const DRAFT_VERSION = 1;
const DRAFT_FILE = "deep-interview-draft.json";

export type DeepInterviewStageErrorCode =
	| "DI_STAGE_USAGE"
	| "DI_STAGE_INPUT_INVALID"
	| "DI_STAGE_SESSION_REQUIRED"
	| "DI_STAGE_DRAFT_EXISTS"
	| "DI_STAGE_NO_DRAFT"
	| "DI_STAGE_DRAFT_CORRUPT"
	| "DI_STAGE_STATE_MISSING"
	| "DI_STAGE_STATE_CORRUPT"
	| "DI_STAGE_REVISION_CONFLICT"
	| "DI_STAGE_MERGE_REJECTED";

export class DeepInterviewStageError extends CommandError {
	constructor(
		readonly code: DeepInterviewStageErrorCode,
		message: string,
		readonly recovery?: string,
	) {
		super(2, message);
		this.name = "DeepInterviewStageError";
	}
}

export interface DeepInterviewStageDraft {
	version: typeof DRAFT_VERSION;
	draft_id: string;
	session_id: string;
	transition: DeepInterviewStageTransition;
	/** State revision the draft was staged against; `apply` CAS-checks this. */
	staged_against_revision: number;
	/**
	 * Canonical content SHA-256 of the state the draft was staged against. Revision
	 * alone cannot catch sanctioned writers that do not bump `state_revision`
	 * (seed/spec-persistence), so `apply` requires BOTH to match.
	 */
	staged_against_sha256: string;
	payload: Record<string, unknown>;
	created_at: string;
}

export interface DeepInterviewStageCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

export function deepInterviewDraftPath(cwd: string, sessionId: string): string {
	return path.join(sessionStateDir(cwd, sessionId), DRAFT_FILE);
}

function statePathFor(cwd: string, sessionId: string): string {
	return path.join(sessionStateDir(cwd, sessionId), "deep-interview-state.json");
}

// -----------------------------------------------------------------------------
// Input parsing
// -----------------------------------------------------------------------------

/** Bytes cap for `@file` payloads — conservative for the 100k-char structured-response limit. */
const MAX_INPUT_FILE_BYTES = 1_000_000;

async function parseJsonInput(rawInput: string, cwd: string): Promise<Record<string, unknown>> {
	let text = rawInput;
	if (rawInput.startsWith("@")) {
		const filePath = path.resolve(cwd, rawInput.slice(1));
		try {
			const stat = await fs.stat(filePath);
			if (!stat.isFile()) {
				throw new DeepInterviewStageError(
					"DI_STAGE_INPUT_INVALID",
					`--input file is not a regular file: ${filePath}`,
				);
			}
			if (stat.size > MAX_INPUT_FILE_BYTES) {
				throw new DeepInterviewStageError(
					"DI_STAGE_INPUT_INVALID",
					`--input file exceeds ${MAX_INPUT_FILE_BYTES} bytes (${stat.size}); staged payloads are bounded`,
				);
			}
			text = await fs.readFile(filePath, "utf-8");
		} catch (error) {
			if (error instanceof DeepInterviewStageError) throw error;
			throw new DeepInterviewStageError(
				"DI_STAGE_INPUT_INVALID",
				`failed to read --input file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new DeepInterviewStageError(
			"DI_STAGE_INPUT_INVALID",
			`--input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isPlainObject(parsed)) {
		throw new DeepInterviewStageError("DI_STAGE_INPUT_INVALID", "--input must be a JSON object");
	}
	return parsed;
}

/**
 * Envelope lifecycle fields the runtime owns exclusively. A staged payload may
 * carry interview data only; phase transitions go through their dedicated verbs
 * (`--write`, `gjc state handoff/clear`), never through a staged patch.
 */
const RUNTIME_OWNED_ENVELOPE_KEYS = [
	"current_phase",
	"active",
	"skill",
	"version",
	"state_revision",
	"source_state_revision",
	"receipt",
	"updated_at",
	"last_applied_draft_id",
] as const;

/**
 * Nested `state.*` keys owned by the Round-0 ask recorder. A staged/write
 * payload can never set them: a fabricated contract (missing digest/
 * confirmation binding) would poison state so every later merge fails
 * `invalid intent contract`, bricking the interview until a destructive
 * `clear --force`. The recorder is the only writer that can lock intent.
 */
const RECORDER_OWNED_STATE_KEYS = ["intent_contract", "intent_review"] as const;

/**
 * Remove sanitizer-owned keys from a staged payload and classify the
 * normalization-owned ones; returns every ignored key name.
 *
 * Nested `state.*` occurrences of envelope-reserved keys are named but not
 * removed here: `normalizeDeepInterviewEnvelope` is still the only remover, so
 * the payload handed to validation stays byte-identical to what the caller sent.
 * Naming them routes an already-certain discard through the existing
 * `ignored_runtime_owned_keys` channel, which previously reported nothing for
 * the nested form -- `{"state":{"current_phase":"cancelled"}}` returned an
 * unqualified `ok:true` for an instruction that never took effect, while the
 * same key at the top level was reported.
 */
function sanitizeStagedPayload(payload: Record<string, unknown>): {
	payload: Record<string, unknown>;
	ignoredKeys: string[];
} {
	const next = { ...payload };
	const ignoredKeys: string[] = [];
	for (const key of RUNTIME_OWNED_ENVELOPE_KEYS) {
		if (key in next) {
			delete next[key];
			ignoredKeys.push(key);
		}
	}
	if (isPlainObject(next.state)) {
		const state = { ...(next.state as Record<string, unknown>) };
		for (const key of RECORDER_OWNED_STATE_KEYS) {
			if (key in state) {
				delete state[key];
				ignoredKeys.push(`state.${key}`);
			}
		}
		// Report only -- do not delete. Removing these here would strip content
		// before `assertDeepInterviewStructuredResponseWithinLimit`, so an oversized
		// discarded value would stop failing `DI_STAGE_INPUT_INVALID`.
		for (const key of ENVELOPE_RESERVED_STATE_KEYS) {
			if (key in state) ignoredKeys.push(`state.${key}`);
		}
		next.state = state;
	}
	return { payload: next, ignoredKeys };
}

/**
 * Self-heal a poisoned merge base: a persisted `state.intent_contract` that
 * fails canonical validation can only come from a pre-guard poisoned write
 * (the recorder always persists valid manifests). Left in place it makes
 * every merge throw, bricking the interview. Drop it (and any equally
 * unverifiable intent_review) from the base and report the repair.
 */
function healPoisonedIntentContract(base: Record<string, unknown>): {
	base: Record<string, unknown>;
	healed: boolean;
} {
	if (!isPlainObject(base.state)) return { base, healed: false };
	const state = base.state as Record<string, unknown>;
	if (state.intent_contract === undefined) return { base, healed: false };
	try {
		assertDeepInterviewIntentManifest(state.intent_contract);
		return { base, healed: false };
	} catch {
		const healedState = { ...state };
		delete healedState.intent_contract;
		delete healedState.intent_review;
		return { base: { ...base, state: healedState }, healed: true };
	}
}

function parseTransition(raw: string | undefined): DeepInterviewStageTransition {
	if (!raw || !(DEEP_INTERVIEW_STAGE_TRANSITIONS as readonly string[]).includes(raw)) {
		throw new DeepInterviewStageError(
			"DI_STAGE_USAGE",
			`--for must be one of: ${DEEP_INTERVIEW_STAGE_TRANSITIONS.join(", ")}`,
		);
	}
	return raw as DeepInterviewStageTransition;
}

// -----------------------------------------------------------------------------
// Core-schema validation (flexible by design: bounds + envelope shape only)
// -----------------------------------------------------------------------------

/**
 * Validate only what the write gate and durability contract require:
 * JSON-serializable, bounded total size, bounded free-text prose fields, and no
 * attempt to smuggle envelope-reserved keys as interview state. Free-form fields
 * (rounds, facts, notes, anything unknown) pass through — flexibility is the
 * contract; the merge preserves them verbatim.
 */
function assertCorePayloadSchema(payload: Record<string, unknown>): void {
	try {
		assertDeepInterviewStructuredResponseWithinLimit(payload);
		assertDeepInterviewEnvelopeInputLimits(normalizeDeepInterviewEnvelope(payload) as Record<string, unknown>);
	} catch (error) {
		throw new DeepInterviewStageError(
			"DI_STAGE_INPUT_INVALID",
			error instanceof Error ? error.message : String(error),
		);
	}
}

// -----------------------------------------------------------------------------
// Draft persistence
// -----------------------------------------------------------------------------

type DraftReadResult =
	| { kind: "absent" }
	| { kind: "corrupt"; error: string }
	| { kind: "valid"; draft: DeepInterviewStageDraft };

async function readDraft(cwd: string, sessionId: string): Promise<DraftReadResult> {
	const draftPath = deepInterviewDraftPath(cwd, sessionId);
	let raw: string;
	try {
		raw = await fs.readFile(draftPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		return { kind: "corrupt", error: error instanceof Error ? error.message : String(error) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { kind: "corrupt", error: error instanceof Error ? error.message : String(error) };
	}
	if (
		!isPlainObject(parsed) ||
		parsed.version !== DRAFT_VERSION ||
		typeof parsed.draft_id !== "string" ||
		typeof parsed.session_id !== "string" ||
		typeof parsed.transition !== "string" ||
		!(DEEP_INTERVIEW_STAGE_TRANSITIONS as readonly string[]).includes(parsed.transition) ||
		typeof parsed.staged_against_revision !== "number" ||
		typeof parsed.staged_against_sha256 !== "string" ||
		!isPlainObject(parsed.payload)
	) {
		return { kind: "corrupt", error: "draft file does not match the staged-draft shape" };
	}
	return { kind: "valid", draft: parsed as unknown as DeepInterviewStageDraft };
}

/**
 * Remove the session draft only when it still holds `draftId`. Prevents a stale
 * handle (e.g. a concurrent apply/discard that already consumed the draft and a
 * new one was staged) from deleting a draft it never read.
 */
async function removeDraftIfMatches(cwd: string, sessionId: string, draftId?: string): Promise<boolean> {
	if (draftId !== undefined) {
		const current = await readDraft(cwd, sessionId);
		if (current.kind === "valid" && current.draft.draft_id !== draftId) return false;
		if (current.kind === "absent") return false;
	}
	try {
		await fs.rm(deepInterviewDraftPath(cwd, sessionId));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

// -----------------------------------------------------------------------------
// State reading + merge preview
// -----------------------------------------------------------------------------

interface CurrentState {
	value: Record<string, unknown>;
	revision: number;
	sha256: string;
	exists: boolean;
}

async function readCurrentState(cwd: string, sessionId: string): Promise<CurrentState> {
	const read = await readExistingStateForMutation(statePathFor(cwd, sessionId));
	if (read.kind === "corrupt") {
		throw new DeepInterviewStageError(
			"DI_STAGE_STATE_CORRUPT",
			`deep-interview state is corrupt or tampered: ${read.error}`,
			'repair or clear it with `gjc state clear --force --mode deep-interview`, then re-seed with `gjc deep-interview "<idea>"`',
		);
	}
	if (read.kind === "absent")
		return { value: {}, revision: 0, sha256: workflowEnvelopeContentSha256({}), exists: false };
	return {
		value: read.value,
		revision: persistedStateRevision(read.value),
		sha256: workflowEnvelopeContentSha256(read.value),
		exists: true,
	};
}

/** Both anchors must hold: revision (fast path) AND content sha (writers that skip revision stamping). */
function draftIsStale(draft: DeepInterviewStageDraft, current: CurrentState): boolean {
	return draft.staged_against_revision !== current.revision || draft.staged_against_sha256 !== current.sha256;
}

/**
 * Lossless keyed merge for `state.established_facts` under the staged surface.
 * The generic envelope merge replaces the whole facts array; the staged contract
 * is delta-only, so a one-fact patch must never erase prior confirmed/disputed
 * facts (they carry the deterministic-floor evidence). Facts with an `id` merge
 * field-wise by id; facts without an id are appended with exact-duplicate dedup.
 * Staged deltas can never hard-delete a fact — dispute/supersede instead.
 */
function mergeEstablishedFacts(existing: readonly unknown[], incoming: readonly unknown[]): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];
	const indexById = new Map<string, number>();
	const add = (value: unknown): void => {
		if (!isPlainObject(value)) return;
		const id = typeof value.id === "string" && value.id.trim() !== "" ? value.id : undefined;
		if (id !== undefined) {
			const existingIndex = indexById.get(id);
			if (existingIndex === undefined) {
				indexById.set(id, result.length);
				result.push({ ...value });
			} else {
				result[existingIndex] = { ...result[existingIndex], ...value };
			}
			return;
		}
		if (result.some(item => JSON.stringify(item) === JSON.stringify(value))) return;
		result.push({ ...value });
	};
	for (const fact of existing) add(fact);
	for (const fact of incoming) add(fact);
	return result;
}

/**
 * The single merge both `check` and `apply` execute. `check` reports its result;
 * `apply` persists it. Divergence between the two is structurally impossible.
 *
 * Ambiguity is runtime-owned: after the merge, `current_ambiguity` is derived
 * from the latest scored round, and the deterministic floor is recomputed and
 * clamped via `applyAmbiguityFloorToEnvelope` — an agent-supplied
 * `current_ambiguity` or under-reported round score is advisory input only and
 * can never under-report below what persisted evidence supports.
 */
function computeMergedEnvelope(
	current: Record<string, unknown>,
	draft: DeepInterviewStageDraft,
	nowIso: string,
): Record<string, unknown> {
	// A poisoned (unverifiable) intent contract in the persisted base would make
	// every merge throw forever; heal it instead of bricking the interview.
	const { base: healedCurrent, healed } = healPoisonedIntentContract(current);
	let merged: Record<string, unknown>;
	try {
		merged = mergeDeepInterviewEnvelope(healedCurrent, draft.payload) as Record<string, unknown>;
	} catch (error) {
		throw new DeepInterviewStageError(
			"DI_STAGE_MERGE_REJECTED",
			`staged payload violates a core invariant: ${error instanceof Error ? error.message : String(error)}`,
			"fix the payload and re-stage (`gjc deep-interview discard` then `stage`)",
		);
	}
	if (healed) merged.intent_contract_healed_at = nowIso;
	merged.skill = "deep-interview";
	merged.active = true;
	merged.updated_at = nowIso;
	merged.version = WORKFLOW_STATE_VERSION;
	if (typeof merged.current_phase !== "string" || !merged.current_phase) merged.current_phase = "interviewing";
	merged.session_id = draft.session_id;
	// Staged facts are deltas: re-merge against the prior facts losslessly so a
	// one-fact patch cannot erase confirmed/disputed history (#3387 finding 2).
	const mergedState = isPlainObject(merged.state) ? (merged.state as Record<string, unknown>) : undefined;
	const priorState = isPlainObject(current.state) ? (current.state as Record<string, unknown>) : undefined;
	if (priorState?.crystal === undefined && mergedState?.crystal !== undefined)
		throw new DeepInterviewStageError(
			"DI_STAGE_MERGE_REJECTED",
			"staged apply cannot introduce canonical Crystal state",
		);
	if (priorState?.crystal !== undefined) {
		if (!mergedState || JSON.stringify(mergedState.crystal) !== JSON.stringify(priorState.crystal))
			throw new DeepInterviewStageError(
				"DI_STAGE_MERGE_REJECTED",
				"canonical crystallized state cannot be replaced or deleted through staged apply",
			);
		if (mergedState.execution_approval !== priorState.execution_approval)
			throw new DeepInterviewStageError(
				"DI_STAGE_MERGE_REJECTED",
				"crystallized execution approval is immutable through staged apply",
			);
		for (const field of ["spec_path", "spec_sha256", "spec_slug", "spec_stage"] as const)
			if (merged[field] !== current[field])
				throw new DeepInterviewStageError(
					"DI_STAGE_MERGE_REJECTED",
					`crystallized ${field} is immutable through staged apply`,
				);
	}
	if (mergedState?.crystal && isPlainObject(mergedState.crystal) && mergedState.crystal.lifecycle !== "ready")
		merged.current_phase = "interviewing";
	if (mergedState && priorState && Array.isArray(priorState.established_facts)) {
		mergedState.established_facts = mergeEstablishedFacts(
			priorState.established_facts,
			Array.isArray(mergedState.established_facts) ? mergedState.established_facts : [],
		);
	}
	merged = deriveRuntimeAmbiguity(merged, current);
	try {
		assertDeepInterviewEnvelopeInputLimits(merged);
	} catch (error) {
		throw new DeepInterviewStageError(
			"DI_STAGE_MERGE_REJECTED",
			`merged state violates a bounded-input invariant: ${error instanceof Error ? error.message : String(error)}`,
			"fix the payload and re-stage (`gjc deep-interview discard` then `stage`)",
		);
	}
	return merged;
}

/**
 * Derive `state.current_ambiguity` — the CLI, not the agent, owns the effective
 * ambiguity. A staged `state.current_ambiguity` is never trusted directly:
 * - with a valid latest scored round (finite numeric `round` AND finite
 *   `ambiguity`), the value derives from that round;
 * - with no valid scored evidence, the PRIOR persisted value is retained (a
 *   fresh interview keeps its seeded 1.0 — a staged 0.01 cannot survive);
 * then the deterministic floor is recomputed and clamped.
 */
function deriveRuntimeAmbiguity(
	merged: Record<string, unknown>,
	previousState: Record<string, unknown>,
): Record<string, unknown> {
	const state = isPlainObject(merged.state) ? (merged.state as Record<string, unknown>) : undefined;
	if (state) {
		const rounds = Array.isArray(state.rounds) ? state.rounds.filter(isPlainObject) : [];
		let latestScored: Record<string, unknown> | undefined;
		for (const round of rounds) {
			if (round.lifecycle !== "scored") continue;
			if (typeof round.ambiguity !== "number" || !Number.isFinite(round.ambiguity)) continue;
			if (typeof round.round !== "number" || !Number.isFinite(round.round)) continue;
			if (!latestScored || round.round >= (latestScored.round as number)) latestScored = round;
		}
		if (latestScored) {
			state.current_ambiguity = latestScored.ambiguity;
		} else {
			// No valid scored evidence in the merged state: the staged value is
			// discarded and the prior runtime-owned value (seed default 1.0) holds.
			const prior = isPlainObject(previousState.state)
				? (previousState.state as Record<string, unknown>).current_ambiguity
				: undefined;
			if (typeof prior === "number" && Number.isFinite(prior)) state.current_ambiguity = prior;
			else delete state.current_ambiguity;
		}
	}
	return applyAmbiguityFloorToEnvelope(merged).envelope as Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Verbs
// -----------------------------------------------------------------------------

/**
 * One explicit session boundary for every staged verb: `--session-id` flag,
 * payload `session_id` (stage only), or `GJC_SESSION_ID`. Mutating verbs never
 * fall back to latest-session auto-detect.
 */
function resolveStageSession(args: readonly string[], cwd: string, payloadSessionId?: unknown): string {
	const session = resolveGjcSessionForWrite(cwd, {
		flagValue: flagValue(args, "--session-id"),
		payloadSessionId,
		envSessionId: process.env.GJC_SESSION_ID,
	});
	return session.gjcSessionId;
}

async function handleStage(args: readonly string[], cwd: string): Promise<Record<string, unknown>> {
	const rawInput = flagValue(args, "--input");
	if (rawInput === undefined || rawInput === "") {
		throw new DeepInterviewStageError("DI_STAGE_USAGE", "--input '<json>' (or @file) is required for stage");
	}
	const rawPayload = await parseJsonInput(rawInput, cwd);
	const transition = parseTransition(flagValue(args, "--for"));
	const sessionId = resolveStageSession(args, cwd, rawPayload.session_id);
	const { payload, ignoredKeys } = sanitizeStagedPayload(rawPayload);
	assertCorePayloadSchema(payload);

	const statePath = statePathFor(cwd, sessionId);
	return withWorkflowStateLock(
		statePath,
		async () => {
			const existingDraft = await readDraft(cwd, sessionId);
			if (existingDraft.kind === "valid") {
				throw new DeepInterviewStageError(
					"DI_STAGE_DRAFT_EXISTS",
					`a staged draft already exists (draft_id=${existingDraft.draft.draft_id}, transition=${existingDraft.draft.transition}, created_at=${existingDraft.draft.created_at})`,
					"apply it (`gjc deep-interview apply`) or discard it (`gjc deep-interview discard`) before staging again",
				);
			}
			// A corrupt draft never blocks staging: it cannot be applied anyway, so
			// staging over it is the self-healing path.
			const current = await readCurrentState(cwd, sessionId);
			if (!current.exists && transition !== "initialize-context") {
				throw new DeepInterviewStageError(
					"DI_STAGE_STATE_MISSING",
					`no deep-interview state exists for session ${sessionId}; only --for initialize-context may stage against absent state`,
					'seed the interview first with `gjc deep-interview "<idea>"` or stage --for initialize-context',
				);
			}
			const nowIso = new Date().toISOString();
			const draft: DeepInterviewStageDraft = {
				version: DRAFT_VERSION,
				draft_id: randomUUID(),
				session_id: sessionId,
				transition,
				staged_against_revision: current.revision,
				staged_against_sha256: current.sha256,
				payload,
				created_at: nowIso,
			};
			// Fail-closed preview at stage time: reject payloads that could never apply.
			computeMergedEnvelope(current.value, draft, nowIso);
			await writeJsonAtomic(deepInterviewDraftPath(cwd, sessionId), draft, {
				cwd,
				audit: {
					category: "state",
					verb: "stage-draft",
					owner: "gjc-runtime",
					skill: "deep-interview",
					sessionId,
				},
			});
			await writeSessionActivityMarker(cwd, sessionId, { writer: "deep-interview-stage" });
			return {
				ok: true,
				verb: "stage",
				draft_id: draft.draft_id,
				transition,
				session_id: sessionId,
				staged_against_revision: draft.staged_against_revision,
				draft_path: deepInterviewDraftPath(cwd, sessionId),
				...(ignoredKeys.length > 0 ? { ignored_runtime_owned_keys: ignoredKeys } : {}),
			};
		},
		{ cwd },
	);
}

function requireDraftRead(read: DraftReadResult, sessionId: string): DeepInterviewStageDraft {
	if (read.kind === "absent") {
		throw new DeepInterviewStageError(
			"DI_STAGE_NO_DRAFT",
			`no staged draft exists for session ${sessionId}`,
			"stage one first: `gjc deep-interview stage --for <transition> --input '<json>'`",
		);
	}
	if (read.kind === "corrupt") {
		throw new DeepInterviewStageError(
			"DI_STAGE_DRAFT_CORRUPT",
			`the staged draft is unreadable: ${read.error}`,
			"discard it (`gjc deep-interview discard`) and re-stage",
		);
	}
	return read.draft;
}

async function handleCheck(args: readonly string[], cwd: string): Promise<Record<string, unknown>> {
	const sessionId = resolveStageSession(args, cwd);
	const draft = requireDraftRead(await readDraft(cwd, sessionId), sessionId);
	const current = await readCurrentState(cwd, sessionId);
	const summaryBase = {
		verb: "check",
		draft_id: draft.draft_id,
		transition: draft.transition,
		session_id: sessionId,
		staged_against_revision: draft.staged_against_revision,
		current_revision: current.revision,
	};
	if (draftIsStale(draft, current)) {
		return {
			...summaryBase,
			ok: false,
			code: "DI_STAGE_REVISION_CONFLICT",
			recovery: "state moved since staging; discard and re-stage against current state",
		};
	}
	const merged = computeMergedEnvelope(current.value, draft, new Date().toISOString());
	const state = isPlainObject(merged.state) ? merged.state : {};
	return {
		...summaryBase,
		ok: true,
		would_apply: true,
		result_phase: merged.current_phase,
		result_round_count: Array.isArray(state.rounds) ? state.rounds.length : 0,
		result_fact_count: Array.isArray(state.established_facts) ? state.established_facts.length : 0,
		...(typeof state.current_ambiguity === "number" ? { result_ambiguity: state.current_ambiguity } : {}),
	};
}

async function handleApply(args: readonly string[], cwd: string): Promise<Record<string, unknown>> {
	const sessionId = resolveStageSession(args, cwd);
	const statePath = statePathFor(cwd, sessionId);
	return withWorkflowStateLock(
		statePath,
		async () => {
			// Re-read the draft INSIDE the lock so a concurrent discard/stage cannot
			// hand us a draft that no longer exists or was replaced.
			const draft = requireDraftRead(await readDraft(cwd, sessionId), sessionId);
			const current = await readCurrentState(cwd, sessionId);
			// Replay safety: a prior apply that committed but crashed before draft
			// removal leaves `last_applied_draft_id` in state. Recognize the commit,
			// finish the cleanup, and settle as an idempotent no-op.
			if (current.value.last_applied_draft_id === draft.draft_id) {
				await removeDraftIfMatches(cwd, sessionId, draft.draft_id);
				return {
					ok: true,
					verb: "apply",
					draft_id: draft.draft_id,
					transition: draft.transition,
					session_id: sessionId,
					applied_revision: current.revision,
					state_path: statePath,
					already_applied: true,
				};
			}
			if (draftIsStale(draft, current)) {
				// CAS conflict: the draft can never legally apply, so auto-invalidate it.
				await removeDraftIfMatches(cwd, sessionId, draft.draft_id);
				throw new DeepInterviewStageError(
					"DI_STAGE_REVISION_CONFLICT",
					`state moved since staging (revision ${draft.staged_against_revision} -> ${current.revision} or content changed); the draft was invalidated`,
					"re-stage against current state: `gjc deep-interview stage --for <transition> --input '<json>'`",
				);
			}
			const nowIso = new Date().toISOString();
			const merged = computeMergedEnvelope(current.value, draft, nowIso);
			merged.last_applied_draft_id = draft.draft_id;
			let appliedRevision: number;
			try {
				const written = await writeGuardedWorkflowEnvelopeAtomic(statePath, merged, {
					cwd,
					policy: "source",
					expectedRevision: current.revision,
					lockHeld: true,
					receipt: {
						cwd,
						skill: "deep-interview",
						owner: "gjc-runtime",
						command: `gjc deep-interview apply (${draft.transition})`,
						sessionId,
						nowIso,
						mutationId: draft.draft_id,
					},
					audit: {
						category: "state",
						verb: "apply-staged-transition",
						owner: "gjc-runtime",
						skill: "deep-interview",
						sessionId,
						mutationId: draft.draft_id,
					},
				});
				appliedRevision = written.revision;
			} catch (error) {
				if (error instanceof StateWriteConflictError) {
					await removeDraftIfMatches(cwd, sessionId, draft.draft_id);
					throw new DeepInterviewStageError(
						"DI_STAGE_REVISION_CONFLICT",
						`state revision moved since staging; the draft was invalidated (${error.message})`,
						"re-stage against current state: `gjc deep-interview stage --for <transition> --input '<json>'`",
					);
				}
				throw error;
			}
			// Post-commit cleanup is best-effort: the commit already happened, and a
			// replay recognizes it via last_applied_draft_id instead of failing.
			try {
				await removeDraftIfMatches(cwd, sessionId, draft.draft_id);
				await writeSessionActivityMarker(cwd, sessionId, { writer: "deep-interview-stage", path: statePath });
			} catch {
				// Swallow: state is committed; the next apply/discard settles the draft.
			}
			await syncStageHud(cwd, sessionId, merged);
			const appliedState = isPlainObject(merged.state) ? (merged.state as Record<string, unknown>) : {};
			return {
				ok: true,
				verb: "apply",
				draft_id: draft.draft_id,
				transition: draft.transition,
				session_id: sessionId,
				applied_revision: appliedRevision,
				state_path: statePath,
				...(typeof appliedState.current_ambiguity === "number"
					? { current_ambiguity: appliedState.current_ambiguity }
					: {}),
				content_sha256: createHash("sha256").update(JSON.stringify(merged)).digest("hex").slice(0, 32),
			};
		},
		{ cwd },
	);
}

async function handleDiscard(args: readonly string[], cwd: string): Promise<Record<string, unknown>> {
	const sessionId = resolveStageSession(args, cwd);
	const statePath = statePathFor(cwd, sessionId);
	// Same lock as stage/apply: a discard racing an in-flight apply must not
	// delete the draft mid-consumption or return a torn read.
	return withWorkflowStateLock(
		statePath,
		async () => {
			const read = await readDraft(cwd, sessionId);
			const removed = await removeDraftIfMatches(
				cwd,
				sessionId,
				read.kind === "valid" ? read.draft.draft_id : undefined,
			);
			return {
				ok: true,
				verb: "discard",
				session_id: sessionId,
				removed,
				...(read.kind === "valid" ? { draft_id: read.draft.draft_id, transition: read.draft.transition } : {}),
			};
		},
		{ cwd },
	);
}

// -----------------------------------------------------------------------------
// Direct verbs: read / write / clear / handoff
// -----------------------------------------------------------------------------

async function handleRead(args: readonly string[], cwd: string): Promise<Record<string, unknown>> {
	const sessionId = resolveStageSession(args, cwd);
	const current = await readCurrentState(cwd, sessionId);
	if (!current.exists) {
		return {
			ok: true,
			verb: "read",
			session_id: sessionId,
			exists: false,
			state_path: statePathFor(cwd, sessionId),
		};
	}
	const draftRead = await readDraft(cwd, sessionId);
	return {
		ok: true,
		verb: "read",
		session_id: sessionId,
		exists: true,
		state_path: statePathFor(cwd, sessionId),
		revision: current.revision,
		content_sha256: current.sha256,
		envelope: current.value,
		...(draftRead.kind === "valid"
			? {
					pending_draft: {
						draft_id: draftRead.draft.draft_id,
						transition: draftRead.draft.transition,
						created_at: draftRead.draft.created_at,
					},
				}
			: {}),
	};
}

/**
 * Direct write: an immediate stage+apply of one sanitized JSON payload —
 * incremental merge by default, whole-state replacement with `--reset` (the
 * locked intent contract survives a reset through the merge's immutability
 * guard). Uses the same lock, sanitizer, merge, ambiguity derivation, and
 * guarded revision-stamping writer as the staged path, so `write` cannot
 * express anything `stage`+`apply` could not.
 */
async function handleWrite(args: readonly string[], cwd: string): Promise<Record<string, unknown>> {
	const rawInput = flagValue(args, "--input");
	if (rawInput === undefined || rawInput === "") {
		throw new DeepInterviewStageError("DI_STAGE_USAGE", "--input '<json>' (or @file) is required for write");
	}
	const rawPayload = await parseJsonInput(rawInput, cwd);
	const sessionId = resolveStageSession(args, cwd, rawPayload.session_id);
	const reset = hasFlag(args, "--reset");
	const { payload, ignoredKeys } = sanitizeStagedPayload(rawPayload);
	assertCorePayloadSchema(payload);

	const statePath = statePathFor(cwd, sessionId);
	return withWorkflowStateLock(
		statePath,
		async () => {
			const pendingDraft = await readDraft(cwd, sessionId);
			if (pendingDraft.kind === "valid") {
				throw new DeepInterviewStageError(
					"DI_STAGE_DRAFT_EXISTS",
					`a staged draft is pending (draft_id=${pendingDraft.draft.draft_id}); direct write would race it`,
					"apply it (`gjc deep-interview apply`) or discard it (`gjc deep-interview discard`) first",
				);
			}
			const current = await readCurrentState(cwd, sessionId);
			const nowIso = new Date().toISOString();
			const syntheticDraft: DeepInterviewStageDraft = {
				version: DRAFT_VERSION,
				draft_id: randomUUID(),
				session_id: sessionId,
				transition: "merge-state",
				staged_against_revision: current.revision,
				staged_against_sha256: current.sha256,
				payload,
				created_at: nowIso,
			};
			// --reset replaces free-form interview state but retains every runtime-owned
			// Crystal/approval/spec field so computeMergedEnvelope can enforce its
			// immutability guard against the real canonical base.
			const base = reset
				? (() => {
						const baseEnvelope: Record<string, unknown> = {};
						for (const field of [
							"skill",
							"version",
							"active",
							"current_phase",
							"session_id",
							"spec_slug",
							"spec_path",
							"spec_stage",
							"spec_sha256",
							"spec_persisted_at",
						] as const)
							if (current.value[field] !== undefined) baseEnvelope[field] = current.value[field];
						const priorState = isPlainObject(current.value.state)
							? (current.value.state as Record<string, unknown>)
							: {};
						const retainedState: Record<string, unknown> = {};
						for (const field of [
							"crystal",
							"execution_approval",
							"intent_contract",
							"intent_contract_required",
						] as const)
							if (priorState[field] !== undefined) retainedState[field] = priorState[field];
						if (Object.keys(retainedState).length > 0) baseEnvelope.state = retainedState;
						return baseEnvelope;
					})()
				: current.value;
			const merged = computeMergedEnvelope(base as Record<string, unknown>, syntheticDraft, nowIso);
			merged.last_applied_draft_id = syntheticDraft.draft_id;
			const written = await writeGuardedWorkflowEnvelopeAtomic(statePath, merged, {
				cwd,
				policy: "source",
				expectedRevision: current.revision,
				lockHeld: true,
				receipt: {
					cwd,
					skill: "deep-interview",
					owner: "gjc-runtime",
					command: `gjc deep-interview write${reset ? " --reset" : ""}`,
					sessionId,
					nowIso,
					mutationId: syntheticDraft.draft_id,
				},
				audit: {
					category: "state",
					verb: reset ? "write-reset" : "write-incremental",
					owner: "gjc-runtime",
					skill: "deep-interview",
					sessionId,
					mutationId: syntheticDraft.draft_id,
				},
			});
			await writeSessionActivityMarker(cwd, sessionId, { writer: "deep-interview-stage", path: statePath });
			await syncStageHud(cwd, sessionId, merged);
			const writtenState = isPlainObject(merged.state) ? (merged.state as Record<string, unknown>) : {};
			return {
				ok: true,
				verb: "write",
				mode: reset ? "reset" : "incremental",
				session_id: sessionId,
				applied_revision: written.revision,
				state_path: statePath,
				...(typeof writtenState.current_ambiguity === "number"
					? { current_ambiguity: writtenState.current_ambiguity }
					: {}),
				...(ignoredKeys.length > 0 ? { ignored_runtime_owned_keys: ignoredKeys } : {}),
			};
		},
		{ cwd },
	);
}

/**
 * Publish a committed envelope to the active-state/HUD mirror. Best-effort:
 * the durable commit already happened; a projection failure must never fail
 * the command (matches syncDeepInterviewHud in deep-interview-runtime.ts).
 */
async function syncStageHud(cwd: string, sessionId: string, envelope: Record<string, unknown>): Promise<void> {
	try {
		const phase = typeof envelope.current_phase === "string" ? envelope.current_phase : "interviewing";
		await syncSkillActiveState({
			cwd,
			skill: "deep-interview",
			active: phase !== "complete",
			phase,
			sessionId,
			source: "gjc-deep-interview-native",
			hud: deriveDeepInterviewHud(envelope, { phase }),
		});
	} catch {
		// HUD sync is best-effort and must not change command semantics.
	}
}

/** Thin lifecycle passthroughs: same runtime plumbing, gjc deep-interview surface. */
async function handleLifecyclePassthrough(
	verb: "clear" | "handoff",
	args: readonly string[],
	cwd: string,
): Promise<DeepInterviewStageCommandResult> {
	const forwarded =
		verb === "clear"
			? ["clear", "--mode", "deep-interview", ...args]
			: ["handoff", "--mode", "deep-interview", ...args];
	return runNativeStateCommand([...forwarded], cwd);
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

export const DEEP_INTERVIEW_STAGE_VERBS = [
	"stage",
	"check",
	"apply",
	"discard",
	"read",
	"write",
	"clear",
	"handoff",
] as const;
export type DeepInterviewStageVerb = (typeof DEEP_INTERVIEW_STAGE_VERBS)[number];

export function isDeepInterviewStageVerb(value: string | undefined): value is DeepInterviewStageVerb {
	return value !== undefined && (DEEP_INTERVIEW_STAGE_VERBS as readonly string[]).includes(value);
}

export async function runDeepInterviewStageCommand(
	verb: DeepInterviewStageVerb,
	args: readonly string[],
	cwd = process.cwd(),
): Promise<DeepInterviewStageCommandResult> {
	const json = hasFlag(args, "--json");
	try {
		let summary: Record<string, unknown>;
		switch (verb) {
			case "stage":
				summary = await handleStage(args, cwd);
				break;
			case "check":
				summary = await handleCheck(args, cwd);
				break;
			case "apply":
				summary = await handleApply(args, cwd);
				break;
			case "discard":
				summary = await handleDiscard(args, cwd);
				break;
			case "read":
				summary = await handleRead(args, cwd);
				break;
			case "write":
				summary = await handleWrite(args, cwd);
				break;
			case "clear":
			case "handoff":
				return await handleLifecyclePassthrough(verb, args, cwd);
		}
		const status = summary.ok === false ? 3 : 0;
		const stdout = json
			? `${JSON.stringify(summary)}\n`
			: `${Object.entries(summary)
					.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
					.join(" ")}\n`;
		return { status, stdout };
	} catch (error) {
		const staged =
			error instanceof DeepInterviewStageError
				? error
				: error instanceof SessionResolutionError
					? new DeepInterviewStageError(
							"DI_STAGE_SESSION_REQUIRED",
							error.message,
							"pass --session-id, set GJC_SESSION_ID, or include session_id in the staged payload, then retry",
						)
					: undefined;
		if (staged) {
			const body = json
				? `${JSON.stringify({ ok: false, code: staged.code, message: staged.message, ...(staged.recovery ? { recovery: staged.recovery } : {}) })}\n`
				: `${staged.code}: ${staged.message}${staged.recovery ? `\nrecovery: ${staged.recovery}` : ""}\n`;
			return { status: staged.exitStatus, stderr: body };
		}
		if (error instanceof CommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
