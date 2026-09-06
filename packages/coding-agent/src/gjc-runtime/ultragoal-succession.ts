/**
 * Explicit, audited cross-repository Ultragoal succession (#5353).
 *
 * An approved Ultragoal can be created in repository A while the implementation
 * belongs in repository B. The repository-binding guard (#2901) correctly refuses
 * to execute A's plan from B, and editing `repositoryBinding` or copying the
 * runtime directory would defeat that boundary and launder verification
 * provenance. This module adds the explicit alternative: a *successor* run in B
 * that adopts selected unfinished goals from A, with immutable provenance and
 * exactly one execution owner.
 *
 * Three durable records, all written through the sanctioned `state-writer`
 * primitives (gate G1):
 *
 * - **offer** (`succession/offer-<operationId>.json`, source side) — provenance
 *   plus the complete carryover: the source brief verbatim, each selected goal's
 *   objective verbatim, and its unresolved obligations.
 * - **outgoing fence** (`succession/outgoing-fence.json`, source side) — the
 *   durable ownership fence. Source admission (`startNextUltragoalGoal`,
 *   `checkpointUltragoalGoal`) refuses to schedule or checkpoint a fenced goal,
 *   so ownership leaves the source at the moment of the offer rather than when
 *   the target happens to adopt. Between the two, nobody owns the goal — which is
 *   the point: there is never an interval in which both runs may resume it.
 * - **adoption** (`succession/adoption.json`, target side) — the target claim and
 *   the recorded operation a retry must reconcile against.
 *
 * Invariants worth stating explicitly, because they are what make this auditable
 * rather than a rebind:
 *
 * - The source's `brief.md`, `goals.json` and `ledger.jsonl` are never written.
 *   Not rewritten, and not appended to either: the offer deliberately records no
 *   ledger event, because the recorded source digests must stay verifiable at
 *   adoption time. `succession` is therefore excluded from `RECONCILE_COMMANDS`,
 *   whose failure path appends a `reconcile_failed` row.
 * - Adoption performs **no** write to the source repository at all. This is
 *   structural, not a convention: `resolveGjcTarget` confines every sanctioned
 *   write to `<cwd>/.gjc/**`, and adoption runs with `cwd` at the target.
 * - Integrity digests are evidence, never authorization. A valid digest set with
 *   no fence, no bounded authorization, or a target the offer does not name is
 *   rejected.
 * - Nothing that carries authority is inherited: statuses, completion receipts,
 *   quality gates, validation batches, steering, reviews, approvals and the
 *   activated `gjcObjective` all stay behind as provenance. The successor plan is
 *   fresh, pending, and bound to the target repository's own identity.
 *
 * Scope limits, stated so a reviewer does not have to infer them: adoption needs
 * filesystem read access to the source worktree (no remote or offline adoption);
 * one outgoing fence exists per source session, so a session hands off once;
 * adoption is pinned to the exact target worktree the offer named, because linked
 * worktrees keep separate `.gjc` state; and there is deliberately no `revoke`
 * verb. Taking ownership back is the highest-risk operation in this design and
 * belongs in its own reviewed change: any read-then-delete of the fence races a
 * concurrent adoption and can revive the source while the target is starting, so
 * an unadopted offer keeps its goals fenced until such a verb exists.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renderCliWriteReceipt } from "./cli-write-receipt";
import { DEFAULT_ULTRAGOAL_OBJECTIVE } from "./goal-mode-request";
import {
	assertPathUnderRepositoryBinding,
	captureRepositoryBinding,
	parseRepositoryBinding,
	publicRepositoryBinding,
	type RepositoryBinding,
	RepositoryBindingError,
	repositoryBindingsMatch,
} from "./repository-binding";
import { gjcRoot, sessionUltragoalDir } from "./session-layout";
import {
	resolveGjcSessionForRead,
	resolveGjcSessionForWrite,
	SessionResolutionError,
	writeSessionActivityMarker,
} from "./session-resolution";
import {
	AlreadyExistsError,
	appendJsonlIdempotent,
	beginWorkflowTransactionJournal,
	completeWorkflowTransactionJournal,
	createJsonNoClobber,
	writeJsonAtomic,
} from "./state-writer";
import {
	getUltragoalPaths,
	readUltragoalLedger,
	readUltragoalPlan,
	type UltragoalCommandResult,
	type UltragoalGjcGoalMode,
	type UltragoalGoal,
	type UltragoalGoalStatus,
	type UltragoalLedgerEvent,
	type UltragoalPlan,
	withUltragoalPlanOwnership,
	writePlan,
} from "./ultragoal-runtime";
import { isWorkflowPlaceholderText, WORKFLOW_PLACEHOLDER_CORRECTION } from "./workflow-placeholder";

export const ULTRAGOAL_SUCCESSION_OPERATION_SCHEMA = "gjc.ultragoal_succession_operation.v1" as const;
export const ULTRAGOAL_SUCCESSION_OFFER_SCHEMA = "gjc.ultragoal_succession_offer.v1" as const;
export const ULTRAGOAL_SUCCESSION_FENCE_SCHEMA = "gjc.ultragoal_succession_fence.v1" as const;
export const ULTRAGOAL_SUCCESSION_ADOPTION_SCHEMA = "gjc.ultragoal_succession_adoption.v1" as const;
export const ULTRAGOAL_SUCCESSION_CLAIM_SCHEMA = "gjc.ultragoal_succession_claim.v1" as const;

export const SUCCESSION_ADOPTED_EVENT = "succession_adopted" as const;

const SUCCESSION_DIR_NAME = "succession";
const SUCCESSION_FENCE_FILE = "outgoing-fence.json";
const SUCCESSION_ADOPTION_FILE = "adoption.json";

/**
 * Statuses a goal may be adopted from. `complete` and `superseded` are finished
 * work — adopting them would manufacture completion authority in the target.
 * `active` is live, and a live goal can never be handed off.
 */
const ADOPTABLE_SOURCE_STATUSES = new Set<UltragoalGoalStatus>(["pending", "failed", "blocked", "review_blocked"]);

const PROVENANCE_NOTICE =
	"Source statuses, completion receipts, quality gates, reviews and approvals recorded here are provenance only. " +
	"They are never target completion receipts and never authorize action in the target repository.";

export type UltragoalSuccessionErrorCode =
	| "source_plan_missing"
	| "source_not_quiescent"
	| "invalid_selection"
	| "unsafe_target"
	| "authorization_required"
	| "divergent_operation"
	| "goal_handed_off"
	| "adoption_unpublished"
	| "publication_conflict"
	| "published_plan_missing"
	| "fence_missing"
	| "fence_mismatch"
	| "source_changed"
	| "offer_untrusted"
	| "offer_path_escape"
	| "target_mismatch"
	| "target_occupied"
	| "duplicate_adoption";

export class UltragoalSuccessionError extends Error {
	readonly code: UltragoalSuccessionErrorCode;

	constructor(code: UltragoalSuccessionErrorCode, message: string) {
		super(message);
		this.name = "UltragoalSuccessionError";
		this.code = code;
	}
}

export interface UltragoalSuccessionArtifactDigests {
	briefSha256: string;
	goalsSha256: string;
	ledgerSha256: string;
}

export interface UltragoalSuccessionCarriedGoal {
	sourceGoalId: string;
	title: string;
	/** The source objective, verbatim. Never a summary. */
	objective: string;
	/** Historical provenance only; never a receipt. */
	sourceStatusAtOffer: UltragoalGoalStatus;
	unresolvedObligations: string[];
	/**
	 * Source dependency groups this goal belonged to, carried as an obligation
	 * with explicit id mapping. The group's *metadata* (batch hashes, receipts)
	 * is deliberately not carried — that would be inherited validation authority.
	 * What is carried is the requirement that these goals be validated together.
	 */
	dependencyGroups: UltragoalSuccessionDependencyGroup[];
}

export type UltragoalSuccessionDependencyGroupKind = "validation-batch" | "review-blocker";

export interface UltragoalSuccessionDependencyGroup {
	kind: UltragoalSuccessionDependencyGroupKind;
	groupId: string;
	memberSourceGoalIds: string[];
	/** For validation batches: the source goal that closed the batch. */
	finalSourceGoalId?: string;
}

/**
 * Per-selected-goal snapshot of exactly what was offered.
 *
 * Admission compares *this*, not whole-file equality. The fence deliberately
 * leaves unselected goals schedulable, so ordinary source progress moves
 * `goals.json`/`ledger.jsonl` bytes; requiring whole-file equality would
 * permanently strand the selected work through drift that never touched it
 * (issue #5353 review item 3). Whole-file digests remain recorded as provenance
 * and any observed drift is written into the adoption record.
 */
export interface UltragoalSuccessionSelectionSnapshot {
	/** The brief carries global constraints, so it must not change. */
	briefSha256: string;
	goals: Array<{ sourceGoalId: string; recordSha256: string; obligationsSha256: string }>;
	snapshotSha256: string;
}

export interface UltragoalSuccessionOffer {
	schema: typeof ULTRAGOAL_SUCCESSION_OFFER_SCHEMA;
	operationId: string;
	createdAt: string;
	source: {
		sessionId: string;
		repository: RepositoryBinding;
		/** Whole-file digests at offer time. Provenance; not the admission test. */
		artifacts: UltragoalSuccessionArtifactDigests;
		/** The authoritative admission test for "did the offered work change". */
		selectionSnapshot: UltragoalSuccessionSelectionSnapshot;
		gjcGoalMode: UltragoalGjcGoalMode;
	};
	target: { repository: RepositoryBinding };
	selection: { goalIds: string[] };
	carryover: {
		/** The source brief, verbatim. */
		brief: string;
		goals: UltragoalSuccessionCarriedGoal[];
	};
	authorization: { statement: string; authorizedBy: string };
	provenanceNotice: string;
}

export interface UltragoalSuccessionFence {
	schema: typeof ULTRAGOAL_SUCCESSION_FENCE_SCHEMA;
	operationId: string;
	createdAt: string;
	sourceSessionId: string;
	sourceRepository: RepositoryBinding;
	targetRepository: RepositoryBinding;
	selectedGoalIds: string[];
	sourceArtifacts: UltragoalSuccessionArtifactDigests;
	offerPath: string;
	offerSha256: string;
}

export interface UltragoalSuccessionGoalMapping {
	sourceGoalId: string;
	targetGoalId: string;
}

export interface UltragoalSuccessionAdoption {
	schema: typeof ULTRAGOAL_SUCCESSION_ADOPTION_SCHEMA;
	operationId: string;
	status: "pending" | "published";
	claimedAt: string;
	publishedAt?: string;
	targetSessionId: string;
	targetRepository: RepositoryBinding;
	source: {
		sessionId: string;
		repository: RepositoryBinding;
		artifacts: UltragoalSuccessionArtifactDigests;
		/** Whole-file digests observed at adoption; may differ from the offer. */
		artifactsAtAdoption: UltragoalSuccessionArtifactDigests;
		/** Whole-file drift on goals the offer did not select, recorded honestly. */
		unselectedDrift: string[];
		verifiedAt: string;
	};
	goalMap: UltragoalSuccessionGoalMapping[];
	/**
	 * Content digest of the plan this operation is entitled to publish, recorded
	 * before publication. A pending replay may only proceed when the target plan
	 * is absent or matches this exactly; anything else is someone else's work.
	 */
	expectedPlanDigest: string;
	/** Pinned so the published plan is a deterministic function of the claim. */
	plannedAt: string;
	offerPath: string;
	offerSha256: string;
	fencePath: string;
	claimPath: string;
	authorization: { statement: string; authorizedBy: string };
	provenanceNotice: string;
}

/**
 * Repository-wide adoption claim.
 *
 * The session-scoped adoption record cannot be the exclusion primitive: two
 * simultaneous sessions in one repository each create their own file and both
 * win. This claim is a single O_EXCL file per operation for the whole
 * repository, so exclusion is atomic rather than scan-then-write.
 */
export interface UltragoalSuccessionRepositoryClaim {
	schema: typeof ULTRAGOAL_SUCCESSION_CLAIM_SCHEMA;
	operationId: string;
	targetSessionId: string;
	targetWorktreeRoot: string;
	targetCommonDir: string | null;
	claimedAt: string;
}

// ---- paths -------------------------------------------------------------

export function ultragoalSuccessionDir(cwd: string, sessionId: string): string {
	return path.join(sessionUltragoalDir(cwd, sessionId), SUCCESSION_DIR_NAME);
}

export function ultragoalSuccessionFencePath(cwd: string, sessionId: string): string {
	return path.join(ultragoalSuccessionDir(cwd, sessionId), SUCCESSION_FENCE_FILE);
}

export function ultragoalSuccessionAdoptionPath(cwd: string, sessionId: string): string {
	return path.join(ultragoalSuccessionDir(cwd, sessionId), SUCCESSION_ADOPTION_FILE);
}

export function ultragoalSuccessionOfferPath(cwd: string, sessionId: string, operationId: string): string {
	return path.join(ultragoalSuccessionDir(cwd, sessionId), `offer-${operationId}.json`);
}

/**
 * Repository-wide (deliberately NOT session-scoped) adoption claim.
 *
 * Session directories cannot express "this repository has already adopted this
 * operation", so the exclusion primitive lives beside them under the shared
 * ultragoal root that `getUltragoalPaths` already uses for session-less state.
 */
export function ultragoalSuccessionClaimPath(cwd: string, operationId: string): string {
	return path.join(gjcRoot(cwd), "ultragoal", SUCCESSION_DIR_NAME, "claims", `${operationId}.json`);
}

// ---- small helpers -----------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => canonical(item));
	if (!isRecord(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		if (value[key] !== undefined) sorted[key] = canonical(value[key]);
	}
	return sorted;
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function readBytesOrNull(filePath: string): Promise<Uint8Array | null> {
	try {
		return await fs.readFile(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function readJsonOrNull(filePath: string): Promise<unknown | null> {
	const bytes = await readBytesOrNull(filePath);
	if (!bytes) return null;
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

/**
 * Authority-bearing repository identity, and nothing else.
 *
 * `captureRepositoryBinding` also records `head`, `branch` and `displayPath`,
 * which move as ordinary work happens. Including them in the operation
 * fingerprint would make an otherwise identical retry look divergent, so the
 * fingerprint uses exactly the fields `repositoryBindingsMatch` consults.
 */
function repositoryIdentity(binding: RepositoryBinding): Record<string, unknown> {
	return {
		worktreeRoot: path.resolve(binding.worktreeRoot),
		commonDir: binding.commonDir === null ? null : path.resolve(binding.commonDir),
		...(binding.relativeSubdir ? { relativeSubdir: binding.relativeSubdir } : {}),
	};
}

function successionOperationId(input: {
	sourceRepository: RepositoryBinding;
	sourceSessionId: string;
	selectionSnapshotSha256: string;
	targetRepository: RepositoryBinding;
	goalIds: readonly string[];
}): string {
	return sha256(
		JSON.stringify(
			canonical({
				schema: ULTRAGOAL_SUCCESSION_OPERATION_SCHEMA,
				source: {
					repository: repositoryIdentity(input.sourceRepository),
					sessionId: input.sourceSessionId,
					selectionSnapshot: input.selectionSnapshotSha256,
				},
				target: { repository: repositoryIdentity(input.targetRepository) },
				selection: { goalIds: [...input.goalIds].toSorted() },
			}),
		),
	);
}

async function readSourceArtifactDigests(
	cwd: string,
	sessionId: string,
): Promise<UltragoalSuccessionArtifactDigests | null> {
	const paths = getUltragoalPaths(cwd, sessionId);
	const [brief, goals, ledger] = await Promise.all([
		readBytesOrNull(paths.briefPath),
		readBytesOrNull(paths.goalsPath),
		readBytesOrNull(paths.ledgerPath),
	]);
	if (!brief || !goals || !ledger) return null;
	return { briefSha256: sha256(brief), goalsSha256: sha256(goals), ledgerSha256: sha256(ledger) };
}

// ---- fence read + source admission ------------------------------------

function parseFence(value: unknown): UltragoalSuccessionFence | null {
	if (!isRecord(value) || value.schema !== ULTRAGOAL_SUCCESSION_FENCE_SCHEMA) return null;
	const operationId = nonEmpty(value.operationId);
	const sourceSessionId = nonEmpty(value.sourceSessionId);
	const offerPath = nonEmpty(value.offerPath);
	const offerSha256 = nonEmpty(value.offerSha256);
	if (!operationId || !sourceSessionId || !offerPath || !offerSha256) return null;
	if (!Array.isArray(value.selectedGoalIds) || !value.selectedGoalIds.every(item => nonEmpty(item))) return null;
	if (!isRecord(value.sourceArtifacts)) return null;
	let sourceRepository: RepositoryBinding;
	let targetRepository: RepositoryBinding;
	try {
		sourceRepository = parseRepositoryBinding(value.sourceRepository);
		targetRepository = parseRepositoryBinding(value.targetRepository);
	} catch {
		return null;
	}
	return {
		schema: ULTRAGOAL_SUCCESSION_FENCE_SCHEMA,
		operationId,
		createdAt: nonEmpty(value.createdAt) ?? "",
		sourceSessionId,
		sourceRepository,
		targetRepository,
		selectedGoalIds: value.selectedGoalIds as string[],
		sourceArtifacts: {
			briefSha256: String(value.sourceArtifacts.briefSha256 ?? ""),
			goalsSha256: String(value.sourceArtifacts.goalsSha256 ?? ""),
			ledgerSha256: String(value.sourceArtifacts.ledgerSha256 ?? ""),
		},
		offerPath,
		offerSha256,
	};
}

/** Read the durable outgoing ownership fence for a source session, if any. */
export async function readUltragoalSuccessionFence(
	cwd: string,
	sessionId: string,
): Promise<UltragoalSuccessionFence | null> {
	return parseFence(await readJsonOrNull(ultragoalSuccessionFencePath(cwd, sessionId)));
}

/** Read the durable adoption claim for a target session, if any. */
export async function readUltragoalSuccessionAdoption(
	cwd: string,
	sessionId: string,
): Promise<UltragoalSuccessionAdoption | null> {
	const value = await readJsonOrNull(ultragoalSuccessionAdoptionPath(cwd, sessionId));
	if (!isRecord(value) || value.schema !== ULTRAGOAL_SUCCESSION_ADOPTION_SCHEMA) return null;
	return value as unknown as UltragoalSuccessionAdoption;
}

async function resolveSessionForFenceLookup(cwd: string, sessionId?: string | null): Promise<string | null> {
	const explicit = sessionId?.trim();
	if (explicit) return explicit;
	try {
		return (await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
	} catch (error) {
		// No resolvable session means no discoverable fence. The caller's own
		// session handling reports the resolution problem; this guard never
		// converts it into a different error.
		if (error instanceof SessionResolutionError) return null;
		throw error;
	}
}

/**
 * Source admission guard: a goal that has been handed off to a successor run is
 * no longer this run's to schedule or checkpoint.
 *
 * Goals outside the fenced selection stay fully schedulable — the fence defines
 * one owner per goal, not a freeze of the whole source run.
 */
export async function assertUltragoalGoalNotFenced(
	cwd: string,
	sessionId: string | null | undefined,
	goalId: string,
): Promise<void> {
	const resolved = await resolveSessionForFenceLookup(cwd, sessionId);
	if (!resolved) return;
	const fence = await readUltragoalSuccessionFence(cwd, resolved);
	if (!fence?.selectedGoalIds.includes(goalId)) return;
	throw new UltragoalSuccessionError(
		"goal_handed_off",
		`Goal ${goalId} was handed off to a successor run in ${fence.targetRepository.worktreeRoot} by succession ${fence.operationId}; ` +
			`this source run no longer owns it. The outgoing ownership fence is at ${ultragoalSuccessionFencePath(cwd, resolved)}. ` +
			"Run `gjc ultragoal succession status` for the recorded operation.",
	);
}

/**
 * Target admission guard: an adoption that has not finished publishing does not
 * yet own anything.
 *
 * Publication writes `goals.json` before it marks the claim published, so a
 * crash leaves a *visible plan with an unpublished claim*. A visible plan is not
 * admission evidence — the claim is. Without this, the target executes goals
 * whose adoption was never completed, and the run's own completion receipts
 * would rest on a transaction that never committed.
 *
 * Callers must invoke this before any mutation so a refusal leaves `goals.json`
 * and `ledger.jsonl` untouched.
 */
export async function assertUltragoalAdoptionPublished(
	cwd: string,
	sessionId: string | null | undefined,
): Promise<void> {
	const resolved = await resolveSessionForFenceLookup(cwd, sessionId);
	if (!resolved) return;
	const adoption = await readUltragoalSuccessionAdoption(cwd, resolved);
	if (!adoption || adoption.status === "published") return;
	throw new UltragoalSuccessionError(
		"adoption_unpublished",
		`This run was adopted from ${adoption.source.repository.worktreeRoot} by succession ${adoption.operationId}, but its ` +
			`adoption is still pending publication, so it does not yet own any goal. A visible goals.json is not admission ` +
			`evidence; the adoption record at ${ultragoalSuccessionAdoptionPath(cwd, resolved)} is. Re-run ` +
			"`gjc ultragoal succession adopt` with the same offer to reconcile the recorded operation.",
	);
}

// ---- offer -------------------------------------------------------------

export interface UltragoalSuccessionOfferInput {
	cwd: string;
	sessionId?: string | null;
	targetRepositoryPath: string;
	goalIds: readonly string[];
	authorization: string;
	authorizedBy: string;
}

export interface UltragoalSuccessionOfferResult {
	operationId: string;
	offerPath: string;
	fencePath: string;
	offer: UltragoalSuccessionOffer;
	/** True when an identical prior operation was reconciled instead of re-recorded. */
	reconciled: boolean;
}

function requireBoundedAuthorization(statement: string, authorizedBy: string): void {
	if (isWorkflowPlaceholderText(statement) || isWorkflowPlaceholderText(authorizedBy)) {
		throw new UltragoalSuccessionError(
			"authorization_required",
			`Cross-repository succession requires an explicit --authorize statement and --authorized-by identity; ${WORKFLOW_PLACEHOLDER_CORRECTION}.`,
		);
	}
}

function requireAdoptableSelection(plan: UltragoalPlan, goalIds: readonly string[]): UltragoalGoal[] {
	if (goalIds.length === 0) {
		throw new UltragoalSuccessionError(
			"invalid_selection",
			"Cross-repository succession requires at least one explicit --goal-id; there is no implicit or wildcard selection.",
		);
	}
	const seen = new Set<string>();
	const selected: UltragoalGoal[] = [];
	for (const goalId of goalIds) {
		const trimmed = goalId.trim();
		if (!trimmed) {
			throw new UltragoalSuccessionError("invalid_selection", "--goal-id must be a non-empty durable goal id");
		}
		if (seen.has(trimmed)) {
			throw new UltragoalSuccessionError("invalid_selection", `--goal-id ${trimmed} was selected more than once`);
		}
		seen.add(trimmed);
		const goal = plan.goals.find(item => item.id === trimmed);
		if (!goal) {
			throw new UltragoalSuccessionError(
				"invalid_selection",
				`No ultragoal goal found for ${trimmed} in the source plan.`,
			);
		}
		if (!ADOPTABLE_SOURCE_STATUSES.has(goal.status)) {
			throw new UltragoalSuccessionError(
				"invalid_selection",
				`Goal ${trimmed} has source status ${goal.status} and cannot be adopted; only unfinished goals ` +
					`(${[...ADOPTABLE_SOURCE_STATUSES].join(", ")}) may be handed to a successor run.`,
			);
		}
		selected.push(goal);
	}
	// Preserve durable plan order so the successor's goal order is deterministic
	// regardless of the order the operator typed the flags in.
	const ordered = plan.goals.filter(goal => seen.has(goal.id));
	requireCompleteDependencyGroups(plan, ordered, seen);
	return ordered;
}

/**
 * Refuse a selection that takes part of a group the source validated as a unit.
 *
 * Completion evidence is deliberately reset on adoption, but the *relationship*
 * that made these goals inseparable is a constraint, not evidence. Splitting a
 * validation batch, or separating a review blocker from the goal it blocks,
 * would silently drop an unresolved obligation (issue #5353 review item 4).
 */
function requireCompleteDependencyGroups(
	plan: UltragoalPlan,
	selected: readonly UltragoalGoal[],
	seen: ReadonlySet<string>,
): void {
	for (const goal of selected) {
		const batch = goal.validationBatch;
		if (batch) {
			const missing = batch.memberIds.filter(memberId => !seen.has(memberId));
			if (missing.length > 0) {
				throw new UltragoalSuccessionError(
					"invalid_selection",
					`Goal ${goal.id} belongs to validation batch ${batch.batchId}, whose members [${batch.memberIds.join(", ")}] ` +
						`were validated as one unit. The selection omits [${missing.join(", ")}], which would drop that obligation. ` +
						"Select the whole batch or none of it.",
				);
			}
		}
		const blockedGoalId =
			goal.steering && goal.steering.kind === "review_blocker" ? nonEmpty(goal.steering.blockedGoalId) : null;
		if (blockedGoalId && !seen.has(blockedGoalId)) {
			const blocked = plan.goals.find(item => item.id === blockedGoalId);
			// A blocker whose blocked goal is already terminal carries no live
			// obligation; only an unresolved pairing must travel together.
			if (blocked && !["complete", "superseded"].includes(blocked.status)) {
				throw new UltragoalSuccessionError(
					"invalid_selection",
					`Goal ${goal.id} is a review blocker for ${blockedGoalId}, which is still ${blocked.status} and is not selected. ` +
						"Select both so the unresolved blocker relationship travels with the work, or neither.",
				);
			}
		}
	}
}

/** Source dependency groups a selected goal carries into the successor run. */
function dependencyGroupsFor(goal: UltragoalGoal): UltragoalSuccessionDependencyGroup[] {
	const groups: UltragoalSuccessionDependencyGroup[] = [];
	if (goal.validationBatch) {
		groups.push({
			kind: "validation-batch",
			groupId: goal.validationBatch.batchId,
			memberSourceGoalIds: [...goal.validationBatch.memberIds],
			finalSourceGoalId: goal.validationBatch.finalGoalId,
		});
	}
	const blockedGoalId =
		goal.steering && goal.steering.kind === "review_blocker" ? nonEmpty(goal.steering.blockedGoalId) : null;
	if (blockedGoalId) {
		groups.push({
			kind: "review-blocker",
			groupId: `${goal.id}->${blockedGoalId}`,
			memberSourceGoalIds: [goal.id, blockedGoalId],
		});
	}
	return groups;
}

function requireQuiescentSource(plan: UltragoalPlan): void {
	const active = plan.goals.filter(goal => goal.status === "active");
	if (active.length === 0) return;
	throw new UltragoalSuccessionError(
		"source_not_quiescent",
		`The source run is still live: ${active.map(goal => goal.id).join(", ")} ${active.length === 1 ? "is" : "are"} active. ` +
			"Check the live goal to a durable non-active status before handing any goal to a successor run.",
	);
}

/**
 * Unresolved obligations for one goal, in durable order and deduplicated.
 *
 * These are copied so the successor inherits the *requirements* that were never
 * met, not a summary that quietly shrinks them.
 */
function unresolvedObligationsFor(goal: UltragoalGoal, ledger: readonly UltragoalLedgerEvent[]): string[] {
	const obligations: string[] = [];
	const push = (value: string): void => {
		const trimmed = value.trim();
		if (trimmed && !obligations.includes(trimmed)) obligations.push(trimmed);
	};
	const evidence = nonEmpty(goal.evidence);
	if (evidence) push(`[source status ${goal.status}] ${evidence}`);
	for (const event of ledger) {
		if (event.goalId !== goal.id) continue;
		if (event.event === "blocker_classified") {
			const classification = nonEmpty(event.classification) ?? "unclassified";
			const detail = nonEmpty(event.evidence);
			if (detail) push(`[blocker ${classification}] ${detail}`);
		}
		if (event.event === "critic_verdict" && Array.isArray(event.blockers)) {
			for (const blocker of event.blockers) {
				if (typeof blocker === "string") push(`[critic blocker] ${blocker}`);
			}
		}
	}
	return obligations;
}

/**
 * The authoritative "did the offered work change" test.
 *
 * Hashes exactly what was offered — the brief plus, per selected goal, the
 * durable record fields that become the successor's requirements and that
 * goal's unresolved obligations. Deliberately excludes everything else in
 * `goals.json` and `ledger.jsonl`: the fence leaves unselected goals
 * schedulable, so whole-file equality would strand the selected work the first
 * time the source made unrelated progress.
 */
function buildSelectionSnapshot(
	plan: UltragoalPlan,
	selected: readonly UltragoalGoal[],
	ledger: readonly UltragoalLedgerEvent[],
): UltragoalSuccessionSelectionSnapshot {
	const goals = selected.map(goal => ({
		sourceGoalId: goal.id,
		recordSha256: sha256(
			JSON.stringify(
				canonical({
					id: goal.id,
					title: goal.title,
					objective: goal.objective,
					status: goal.status,
					dependencyGroups: dependencyGroupsFor(goal),
				}),
			),
		),
		obligationsSha256: sha256(JSON.stringify(unresolvedObligationsFor(goal, ledger))),
	}));
	const briefSha256 = sha256(plan.brief);
	return {
		briefSha256,
		goals,
		snapshotSha256: sha256(JSON.stringify(canonical({ briefSha256, goals }))),
	};
}

async function resolveTargetRepositoryBinding(
	targetRepositoryPath: string,
	sourceBinding: RepositoryBinding,
): Promise<RepositoryBinding> {
	const raw = targetRepositoryPath.trim();
	if (!raw) {
		throw new UltragoalSuccessionError(
			"unsafe_target",
			"--target-repo is required and must be a real directory path",
		);
	}
	let resolved: string;
	try {
		resolved = await fs.realpath(path.resolve(raw));
	} catch {
		throw new UltragoalSuccessionError(
			"unsafe_target",
			`--target-repo does not resolve to an existing directory: ${raw}`,
		);
	}
	const stat = await fs.stat(resolved);
	if (!stat.isDirectory()) {
		throw new UltragoalSuccessionError("unsafe_target", `--target-repo is not a directory: ${raw}`);
	}
	const target = publicRepositoryBinding(await captureRepositoryBinding(resolved, { displayPath: resolved }));
	if (repositoryBindingsMatch(target, sourceBinding)) {
		throw new UltragoalSuccessionError(
			"unsafe_target",
			`--target-repo resolves to the source repository itself (${target.worktreeRoot}). ` +
				"Succession moves work across repositories; it is not a rebind of the original run.",
		);
	}
	return target;
}

/**
 * Record an explicit successor offer and fence the selected goals off from the
 * source run. Writes nothing to the source brief, goals or ledger.
 */
export async function offerUltragoalSuccession(
	input: UltragoalSuccessionOfferInput,
): Promise<UltragoalSuccessionOfferResult> {
	const sessionId =
		input.sessionId?.trim() ||
		resolveGjcSessionForWrite(input.cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;

	requireBoundedAuthorization(input.authorization, input.authorizedBy);

	// Deciding that a source run is quiescent, and fencing it, is one indivisible
	// step. Outside this exclusion an offer can read `pending` from a start that
	// has already passed its own fence check and is about to commit `active`, and
	// both runs then believe they own the goal (#5353).
	return withUltragoalPlanOwnership(input.cwd, sessionId, () => offerUnderSourceOwnership(input, sessionId));
}

async function offerUnderSourceOwnership(
	input: UltragoalSuccessionOfferInput,
	sessionId: string,
): Promise<UltragoalSuccessionOfferResult> {
	// Read under the exclusion: any in-flight start has committed by now, so this
	// snapshot is the run's settled state rather than a mid-write guess.
	const plan = await readUltragoalPlan(input.cwd, sessionId);
	if (!plan) {
		throw new UltragoalSuccessionError(
			"source_plan_missing",
			"No ultragoal plan found in this repository/session; there is nothing to hand to a successor run.",
		);
	}
	if (!plan.repositoryBinding) {
		throw new UltragoalSuccessionError(
			"source_plan_missing",
			"The source ultragoal plan has no repositoryBinding, so its repository identity cannot be recorded as provenance.",
		);
	}
	requireQuiescentSource(plan);
	const selected = requireAdoptableSelection(plan, input.goalIds);

	const sourceRepository = publicRepositoryBinding(plan.repositoryBinding);
	const targetRepository = await resolveTargetRepositoryBinding(input.targetRepositoryPath, sourceRepository);

	const sourceArtifacts = await readSourceArtifactDigests(input.cwd, sessionId);
	if (!sourceArtifacts) {
		throw new UltragoalSuccessionError(
			"source_plan_missing",
			"The source brief, goals and ledger must all exist before their digests can be recorded as provenance.",
		);
	}
	const ledger = await readUltragoalLedger(input.cwd, sessionId);
	const selectionSnapshot = buildSelectionSnapshot(plan, selected, ledger);

	// Keyed on the selection snapshot, not the whole-file digests: an identical
	// retry after unrelated source progress must reconcile, not look divergent.
	const operationId = successionOperationId({
		sourceRepository,
		sourceSessionId: sessionId,
		selectionSnapshotSha256: selectionSnapshot.snapshotSha256,
		targetRepository,
		goalIds: selected.map(goal => goal.id),
	});
	const fencePath = ultragoalSuccessionFencePath(input.cwd, sessionId);

	// A retry must reconcile the exact recorded operation or fail closed — never
	// blindly re-record a fence over a different one.
	const existingFence = await readUltragoalSuccessionFence(input.cwd, sessionId);
	if (existingFence) {
		if (existingFence.operationId !== operationId) {
			throw new UltragoalSuccessionError(
				"divergent_operation",
				`This session already fenced goals [${existingFence.selectedGoalIds.join(", ")}] for succession ` +
					`${existingFence.operationId} to ${existingFence.targetRepository.worktreeRoot}. The requested operation ` +
					`${operationId} differs, so it is refused rather than resumed. Inspect ${fencePath}.`,
			);
		}
		const recordedBytes = await readBytesOrNull(existingFence.offerPath);
		if (!recordedBytes || sha256(recordedBytes) !== existingFence.offerSha256) {
			throw new UltragoalSuccessionError(
				"fence_mismatch",
				`The recorded offer for succession ${operationId} is missing or no longer matches the digest in ${fencePath}.`,
			);
		}
		return {
			operationId,
			offerPath: existingFence.offerPath,
			fencePath,
			offer: JSON.parse(new TextDecoder().decode(recordedBytes)) as UltragoalSuccessionOffer,
			reconciled: true,
		};
	}

	const offer: UltragoalSuccessionOffer = {
		schema: ULTRAGOAL_SUCCESSION_OFFER_SCHEMA,
		operationId,
		createdAt: new Date().toISOString(),
		source: {
			sessionId,
			repository: sourceRepository,
			artifacts: sourceArtifacts,
			selectionSnapshot,
			gjcGoalMode: plan.gjcGoalMode,
		},
		target: { repository: targetRepository },
		selection: { goalIds: selected.map(goal => goal.id) },
		carryover: {
			brief: plan.brief,
			goals: selected.map(goal => ({
				sourceGoalId: goal.id,
				title: goal.title,
				objective: goal.objective,
				sourceStatusAtOffer: goal.status,
				unresolvedObligations: unresolvedObligationsFor(goal, ledger),
				dependencyGroups: dependencyGroupsFor(goal),
			})),
		},
		authorization: { statement: input.authorization.trim(), authorizedBy: input.authorizedBy.trim() },
		provenanceNotice: PROVENANCE_NOTICE,
	};

	const offerPath = ultragoalSuccessionOfferPath(input.cwd, sessionId, operationId);
	const auditContext = {
		cwd: input.cwd,
		audit: { category: "artifact" as const, verb: "write", owner: "gjc-runtime" as const, sessionId },
	};
	try {
		await createJsonNoClobber(offerPath, offer, auditContext);
	} catch (error) {
		// An offer file with this exact operation id already exists (a previous
		// attempt crashed between writing the offer and creating the fence). Reuse
		// its recorded bytes rather than overwriting evidence.
		if (!(error instanceof AlreadyExistsError)) throw error;
	}
	const offerBytes = await readBytesOrNull(offerPath);
	if (!offerBytes) {
		throw new UltragoalSuccessionError("offer_untrusted", `Failed to persist the succession offer at ${offerPath}.`);
	}

	const fence: UltragoalSuccessionFence = {
		schema: ULTRAGOAL_SUCCESSION_FENCE_SCHEMA,
		operationId,
		createdAt: new Date().toISOString(),
		sourceSessionId: sessionId,
		sourceRepository,
		targetRepository,
		selectedGoalIds: selected.map(goal => goal.id),
		sourceArtifacts,
		offerPath,
		offerSha256: sha256(offerBytes),
	};
	try {
		await createJsonNoClobber(fencePath, fence, {
			cwd: input.cwd,
			audit: { category: "state", verb: "write", owner: "gjc-runtime", sessionId },
		});
	} catch (error) {
		if (!(error instanceof AlreadyExistsError)) throw error;
		// Lost a race with a concurrent offer: re-read and apply the same
		// reconcile-or-fail-closed rule.
		const raced = await readUltragoalSuccessionFence(input.cwd, sessionId);
		if (!raced || raced.operationId !== operationId) {
			throw new UltragoalSuccessionError(
				"divergent_operation",
				`A concurrent succession offer fenced this session for a different operation; ${operationId} is refused.`,
			);
		}
	}

	// The activity marker lives outside brief/goals/ledger, so recording that this
	// session did something does not disturb the digests the offer just recorded.
	await writeSessionActivityMarker(input.cwd, sessionId, { writer: "ultragoal-succession", path: fencePath });

	return {
		operationId,
		offerPath,
		fencePath,
		offer: JSON.parse(new TextDecoder().decode(offerBytes)) as UltragoalSuccessionOffer,
		reconciled: false,
	};
}

// ---- adopt -------------------------------------------------------------

export interface UltragoalSuccessionAdoptInput {
	cwd: string;
	sessionId?: string | null;
	offerPath: string;
	gjcGoalMode?: UltragoalGjcGoalMode;
}

export interface UltragoalSuccessionAdoptResult {
	operationId: string;
	adoptionPath: string;
	plan: UltragoalPlan;
	goalMap: UltragoalSuccessionGoalMapping[];
	reconciled: boolean;
}

function parseOfferDocument(bytes: Uint8Array, offerPath: string): UltragoalSuccessionOffer {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new UltragoalSuccessionError("offer_untrusted", `Succession offer is not valid JSON: ${offerPath}`);
	}
	if (!isRecord(value) || value.schema !== ULTRAGOAL_SUCCESSION_OFFER_SCHEMA) {
		throw new UltragoalSuccessionError(
			"offer_untrusted",
			`Succession offer must declare schema ${ULTRAGOAL_SUCCESSION_OFFER_SCHEMA}: ${offerPath}`,
		);
	}
	const operationId = nonEmpty(value.operationId);
	const source = value.source;
	const target = value.target;
	const selection = value.selection;
	const carryover = value.carryover;
	const authorization = value.authorization;
	if (
		!operationId ||
		!isRecord(source) ||
		!isRecord(target) ||
		!isRecord(selection) ||
		!isRecord(carryover) ||
		!isRecord(authorization) ||
		!nonEmpty(source.sessionId) ||
		typeof carryover.brief !== "string" ||
		!Array.isArray(selection.goalIds) ||
		!Array.isArray(carryover.goals) ||
		!isRecord(source.artifacts)
	) {
		throw new UltragoalSuccessionError(
			"offer_untrusted",
			`Succession offer is structurally incomplete: ${offerPath}`,
		);
	}
	if (carryover.goals.length !== selection.goalIds.length || carryover.goals.length === 0) {
		throw new UltragoalSuccessionError(
			"offer_untrusted",
			`Succession offer carryover does not cover its own selection: ${offerPath}`,
		);
	}
	for (const goal of carryover.goals) {
		if (!isRecord(goal) || !nonEmpty(goal.sourceGoalId) || !nonEmpty(goal.title) || !nonEmpty(goal.objective)) {
			throw new UltragoalSuccessionError(
				"offer_untrusted",
				`Succession offer carries a goal without an id, title or objective: ${offerPath}`,
			);
		}
		if (!Array.isArray(goal.unresolvedObligations)) {
			throw new UltragoalSuccessionError(
				"offer_untrusted",
				`Succession offer carries a goal without an unresolvedObligations list: ${offerPath}`,
			);
		}
	}
	try {
		parseRepositoryBinding(source.repository);
		parseRepositoryBinding(target.repository);
	} catch {
		throw new UltragoalSuccessionError(
			"offer_untrusted",
			`Succession offer carries an invalid repository binding: ${offerPath}`,
		);
	}
	return value as unknown as UltragoalSuccessionOffer;
}

/**
 * Content identity of a successor plan, independent of the revision stamping
 * `writeGuardedJsonAtomic` applies. Used to prove that a plan already on disk is
 * this operation's own partial write rather than unrelated target work.
 */
function successorPlanContentDigest(plan: UltragoalPlan): string {
	const { state_revision: _revision, source_state_revision: _source, receipt: _receipt, ...content } = plan;
	return sha256(JSON.stringify(canonical(content)));
}

function composeSuccessorObjective(
	offer: UltragoalSuccessionOffer,
	carried: UltragoalSuccessionCarriedGoal,
	goalMap: readonly UltragoalSuccessionGoalMapping[],
): string {
	const lines = [
		carried.objective,
		"",
		`## Carried from ${offer.source.repository.worktreeRoot} session ${offer.source.sessionId} goal ${carried.sourceGoalId}`,
		`Succession ${offer.operationId}.`,
		`Source status at handoff: ${carried.sourceStatusAtOffer}. ${PROVENANCE_NOTICE}`,
	];
	if (carried.unresolvedObligations.length > 0) {
		lines.push("", "Unresolved obligations carried forward — these are requirements, not history:");
		for (const obligation of carried.unresolvedObligations) lines.push(`- ${obligation}`);
	}
	// The source's validation metadata is deliberately not inherited, but the
	// relationship that made these goals inseparable is a live constraint.
	for (const group of carried.dependencyGroups ?? []) {
		const mapped = group.memberSourceGoalIds
			.map(memberId => {
				const row = goalMap.find(item => item.sourceGoalId === memberId);
				return row ? `${memberId} -> ${row.targetGoalId}` : `${memberId} -> (not adopted)`;
			})
			.join(", ");
		lines.push(
			"",
			group.kind === "validation-batch"
				? `Validation group ${group.groupId} carried from the source: these goals were validated as one unit and must be ` +
						`re-validated together here. Members ${mapped}.` +
						(group.finalSourceGoalId ? ` The source closed the group on ${group.finalSourceGoalId}.` : "")
				: `Unresolved review-blocker relationship carried from the source: ${mapped}. Resolving one without the other ` +
						"leaves the original obligation open.",
			"The source's own batch metadata and receipts are not carried; this run must establish its own validation.",
		);
	}
	return lines.join("\n");
}

function composeSuccessorBrief(
	offer: UltragoalSuccessionOffer,
	goalMap: readonly UltragoalSuccessionGoalMapping[],
): string {
	return [
		`# Successor run adopted from ${offer.source.repository.worktreeRoot}`,
		"",
		`Succession: ${offer.operationId}`,
		`Source session: ${offer.source.sessionId}`,
		`Adopted goals: ${goalMap.map(row => `${row.sourceGoalId} -> ${row.targetGoalId}`).join(", ")}`,
		`Source digests: goals.json sha256:${offer.source.artifacts.goalsSha256}, ` +
			`ledger.jsonl sha256:${offer.source.artifacts.ledgerSha256}, brief.md sha256:${offer.source.artifacts.briefSha256}`,
		`Authorized by ${offer.authorization.authorizedBy}: ${offer.authorization.statement}`,
		"",
		PROVENANCE_NOTICE,
		"This run starts fresh validation under this repository's own binding.",
		"",
		`## Source brief (verbatim, sha256:${offer.source.artifacts.briefSha256})`,
		"",
		offer.carryover.brief,
	].join("\n");
}

/**
 * Adopt an explicit successor offer into this repository/session.
 *
 * Fails closed on a forged or stale offer, a changed source, a missing source
 * fence, an unnamed target, an occupied target, and any duplicate or divergent
 * adoption anywhere in this repository. A retry reconciles the exact recorded
 * operation or fails closed; it never resumes a different one.
 */
export async function adoptUltragoalSuccession(
	input: UltragoalSuccessionAdoptInput,
): Promise<UltragoalSuccessionAdoptResult> {
	const sessionId =
		input.sessionId?.trim() ||
		resolveGjcSessionForWrite(input.cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;

	const declaredPath = path.resolve(input.offerPath.trim());
	const initialBytes = await readBytesOrNull(declaredPath);
	if (!initialBytes) {
		throw new UltragoalSuccessionError("offer_untrusted", `No succession offer found at ${declaredPath}`);
	}
	const declaredOffer = parseOfferDocument(initialBytes, declaredPath);
	const sourceRepository = parseRepositoryBinding(declaredOffer.source.repository);

	// The offer must physically live inside the source worktree it claims. This
	// rejects a relocated copy and a symlink that escapes the bound root.
	let resolvedOfferPath: string;
	try {
		resolvedOfferPath = assertPathUnderRepositoryBinding(sourceRepository, declaredPath);
	} catch (error) {
		if (error instanceof RepositoryBindingError) {
			throw new UltragoalSuccessionError(
				"offer_path_escape",
				`The succession offer at ${declaredPath} resolves outside the source repository it names ` +
					`(${sourceRepository.worktreeRoot}): ${error.message}`,
			);
		}
		throw error;
	}
	const offerBytes = await readBytesOrNull(resolvedOfferPath);
	if (!offerBytes) {
		throw new UltragoalSuccessionError("offer_untrusted", `No succession offer found at ${resolvedOfferPath}`);
	}
	const offer = parseOfferDocument(offerBytes, resolvedOfferPath);
	const offerSha256 = sha256(offerBytes);

	// Structural seal: the recorded fingerprint must be derivable from the offer's
	// own declared identity, session, selection snapshot and selection.
	const recomputed = successionOperationId({
		sourceRepository,
		sourceSessionId: offer.source.sessionId,
		selectionSnapshotSha256: offer.source.selectionSnapshot.snapshotSha256,
		targetRepository: parseRepositoryBinding(offer.target.repository),
		goalIds: offer.selection.goalIds,
	});
	if (recomputed !== offer.operationId) {
		throw new UltragoalSuccessionError(
			"offer_untrusted",
			`Succession offer ${resolvedOfferPath} declares operation ${offer.operationId} but its own contents derive ${recomputed}.`,
		);
	}

	const fencePath = ultragoalSuccessionFencePath(sourceRepository.worktreeRoot, offer.source.sessionId);
	const fence = await readUltragoalSuccessionFence(sourceRepository.worktreeRoot, offer.source.sessionId);
	if (!fence) {
		throw new UltragoalSuccessionError(
			"fence_missing",
			`The source run has no outgoing ownership fence at ${fencePath}. An offer document alone never authorizes ` +
				"adoption: without the fence the source may still own the selected goals.",
		);
	}
	if (fence.operationId !== offer.operationId) {
		throw new UltragoalSuccessionError(
			"fence_mismatch",
			`The source fence records succession ${fence.operationId}, not ${offer.operationId}.`,
		);
	}
	// Byte seal. The fingerprint above covers identity and selection; this covers
	// every byte, including the carried objectives and obligations.
	if (fence.offerSha256 !== offerSha256) {
		throw new UltragoalSuccessionError(
			"offer_untrusted",
			`Succession offer bytes at ${resolvedOfferPath} do not match the digest recorded in the source fence ` +
				`(${fence.offerSha256}). The offer has been altered since it was recorded.`,
		);
	}

	// Integrity evidence, scoped to what was actually offered.
	//
	// Whole-file equality is deliberately NOT the admission test: the fence leaves
	// unselected goals schedulable, so ordinary source progress moves goals.json
	// and ledger.jsonl and would permanently strand the selected work (issue #5353
	// review item 3). The authoritative test is the selection snapshot — the brief
	// plus each selected goal's record and obligations.
	const currentDigests = await readSourceArtifactDigests(sourceRepository.worktreeRoot, offer.source.sessionId);
	const sourcePlanNow = await readUltragoalPlan(sourceRepository.worktreeRoot, offer.source.sessionId);
	if (!currentDigests || !sourcePlanNow) {
		throw new UltragoalSuccessionError(
			"source_changed",
			`The source brief, goals or ledger is no longer readable under ${sourceRepository.worktreeRoot}.`,
		);
	}
	const stillSelected = offer.selection.goalIds.map(goalId => sourcePlanNow.goals.find(item => item.id === goalId));
	if (stillSelected.some(goal => goal === undefined)) {
		throw new UltragoalSuccessionError(
			"source_changed",
			`The source plan no longer contains every offered goal [${offer.selection.goalIds.join(", ")}].`,
		);
	}
	const sourceLedgerNow = await readUltragoalLedger(sourceRepository.worktreeRoot, offer.source.sessionId);
	const snapshotNow = buildSelectionSnapshot(sourcePlanNow, stillSelected as UltragoalGoal[], sourceLedgerNow);
	if (snapshotNow.snapshotSha256 !== offer.source.selectionSnapshot.snapshotSha256) {
		throw new UltragoalSuccessionError(
			"source_changed",
			"The offered work itself changed after the succession offer was recorded (the source brief, or a selected " +
				"goal's record or unresolved obligations), so the carryover is no longer a truthful account of it. " +
				"Record a fresh offer from the current source state.",
		);
	}
	// Unselected-goal drift is legitimate and is recorded rather than rejected.
	const unselectedDrift: string[] = [];
	if (currentDigests.goalsSha256 !== offer.source.artifacts.goalsSha256) unselectedDrift.push("goals.json");
	if (currentDigests.ledgerSha256 !== offer.source.artifacts.ledgerSha256) unselectedDrift.push("ledger.jsonl");

	const targetActual = publicRepositoryBinding(await captureRepositoryBinding(input.cwd, { displayPath: input.cwd }));
	const targetDeclared = parseRepositoryBinding(offer.target.repository);
	if (!repositoryBindingsMatch(targetActual, targetDeclared)) {
		throw new UltragoalSuccessionError(
			"target_mismatch",
			`This repository (${targetActual.worktreeRoot}) is not the target the succession offer names ` +
				`(${targetDeclared.worktreeRoot}). Adopt from the named target repository.`,
		);
	}
	// Stricter than the binding match on purpose. `repositoryBindingsMatch` accepts
	// any linked worktree of the named repository, but each worktree carries its own
	// `.gjc`, so two admissible worktrees could each take a local claim for one
	// operation. Pinning the exact worktree the offer named keeps the claim below a
	// sound repository-wide exclusion. This narrows admission; it never widens it.
	if (path.resolve(targetActual.worktreeRoot) !== path.resolve(targetDeclared.worktreeRoot)) {
		throw new UltragoalSuccessionError(
			"target_mismatch",
			`This worktree (${targetActual.worktreeRoot}) shares a repository with the named target ` +
				`(${targetDeclared.worktreeRoot}) but is not that worktree. Linked worktrees keep separate .gjc state, so ` +
				"adoption is pinned to the exact worktree the offer named.",
		);
	}
	if (repositoryBindingsMatch(targetActual, sourceRepository)) {
		throw new UltragoalSuccessionError(
			"unsafe_target",
			"Refusing to adopt a succession offer into its own source repository.",
		);
	}

	// Everything from here on inspects and republishes this session's plan, so it
	// runs inside the same ownership exclusion the target's own admission uses.
	// Without it, two identical retries — or a retry racing a successful first
	// caller that has already started work — can interleave claim inspection with
	// publication and reset committed target progress (#5353).
	return withUltragoalPlanOwnership(input.cwd, sessionId, () =>
		publishAdoptionUnderTargetOwnership({
			input,
			sessionId,
			offer,
			offerSha256,
			resolvedOfferPath,
			fencePath,
			sourceRepository,
			targetActual,
			currentDigests,
			unselectedDrift,
		}),
	);
}

interface AdoptionPublicationContext {
	input: UltragoalSuccessionAdoptInput;
	sessionId: string;
	offer: UltragoalSuccessionOffer;
	offerSha256: string;
	resolvedOfferPath: string;
	fencePath: string;
	sourceRepository: RepositoryBinding;
	targetActual: RepositoryBinding;
	currentDigests: UltragoalSuccessionArtifactDigests;
	unselectedDrift: string[];
}

async function publishAdoptionUnderTargetOwnership(
	context: AdoptionPublicationContext,
): Promise<UltragoalSuccessionAdoptResult> {
	const {
		input,
		sessionId,
		offer,
		offerSha256,
		resolvedOfferPath,
		fencePath,
		sourceRepository,
		targetActual,
		currentDigests,
		unselectedDrift,
	} = context;
	const adoptionPath = ultragoalSuccessionAdoptionPath(input.cwd, sessionId);
	const claimPath = ultragoalSuccessionClaimPath(input.cwd, offer.operationId);
	const ownClaim = await readUltragoalSuccessionAdoption(input.cwd, sessionId);
	if (ownClaim && ownClaim.operationId !== offer.operationId) {
		throw new UltragoalSuccessionError(
			"duplicate_adoption",
			`This session already recorded succession ${ownClaim.operationId}; adopting ${offer.operationId} on top of it ` +
				`is refused rather than resumed. Inspect ${adoptionPath}.`,
		);
	}

	const goalMap: UltragoalSuccessionGoalMapping[] = offer.carryover.goals.map((carried, index) => ({
		sourceGoalId: carried.sourceGoalId,
		targetGoalId: `G${String(index + 1).padStart(3, "0")}`,
	}));

	// Repository-wide exclusion, atomic by O_EXCL rather than scan-then-write.
	// A per-session claim plus a directory scan is a TOCTOU: two simultaneous
	// sessions both scan empty and both create their own file, producing two
	// owners for one operation.
	const repositoryClaim: UltragoalSuccessionRepositoryClaim = {
		schema: ULTRAGOAL_SUCCESSION_CLAIM_SCHEMA,
		operationId: offer.operationId,
		targetSessionId: sessionId,
		targetWorktreeRoot: path.resolve(targetActual.worktreeRoot),
		targetCommonDir: targetActual.commonDir === null ? null : path.resolve(targetActual.commonDir),
		claimedAt: new Date().toISOString(),
	};
	try {
		await createJsonNoClobber(claimPath, repositoryClaim, {
			cwd: input.cwd,
			audit: { category: "state", verb: "write", owner: "gjc-runtime", sessionId },
		});
	} catch (error) {
		if (!(error instanceof AlreadyExistsError)) throw error;
		const held = await readJsonOrNull(claimPath);
		const heldSession =
			isRecord(held) && held.schema === ULTRAGOAL_SUCCESSION_CLAIM_SCHEMA ? nonEmpty(held.targetSessionId) : null;
		if (heldSession !== sessionId) {
			throw new UltragoalSuccessionError(
				"duplicate_adoption",
				`Succession ${offer.operationId} is already claimed in this repository by session ${heldSession ?? "(unreadable)"} ` +
					`(${claimPath}). One operation has exactly one execution owner.`,
			);
		}
	}

	const now = new Date().toISOString();
	// Pinned so the plan this operation may publish is a deterministic function of
	// the claim: a replay must be able to prove the bytes on disk are its own.
	const plannedAt = ownClaim?.plannedAt ?? now;
	const auditContext = {
		cwd: input.cwd,
		audit: { category: "state" as const, verb: "write", owner: "gjc-runtime" as const, sessionId },
	};
	const plan: UltragoalPlan = {
		version: 1,
		brief: composeSuccessorBrief(offer, goalMap),
		// Fresh target-side validation policy. The source's mode is provenance in
		// the offer; it never silently selects the successor's validation posture.
		gjcGoalMode: input.gjcGoalMode ?? "aggregate",
		gjcObjective: DEFAULT_ULTRAGOAL_OBJECTIVE,
		goals: offer.carryover.goals.map((carried, index) => ({
			id: goalMap[index]!.targetGoalId,
			title: carried.title,
			objective: composeSuccessorObjective(offer, carried, goalMap),
			status: "pending",
			createdAt: plannedAt,
			updatedAt: plannedAt,
		})),
		repositoryBinding: targetActual,
		createdAt: plannedAt,
		updatedAt: plannedAt,
	};
	const expectedPlanDigest = successorPlanContentDigest(plan);

	if (ownClaim?.status === "published") {
		const published = await readUltragoalPlan(input.cwd, sessionId);
		if (!published) {
			// Do not reconstruct. A published plan that has vanished may have been
			// cleared deliberately; silently recreating it would resurrect a run the
			// operator retired and could contradict receipts that referenced it.
			throw new UltragoalSuccessionError(
				"published_plan_missing",
				`Succession ${offer.operationId} is recorded as published for this session, but its plan at ` +
					`${getUltragoalPaths(input.cwd, sessionId).goalsPath} is gone. Refusing to reconstruct it: adopt into a ` +
					"fresh session, or restore the plan, so an intentionally cleared run is never resurrected.",
			);
		}
		return {
			operationId: offer.operationId,
			adoptionPath,
			plan: published,
			goalMap: ownClaim.goalMap,
			reconciled: true,
		};
	}

	// A matching pending operation id is NOT overwrite authority. Reconcile only
	// this operation's own partial bytes; anything else is someone's real work.
	const existingPlan = await readUltragoalPlan(input.cwd, sessionId);
	if (existingPlan) {
		if (!ownClaim) {
			throw new UltragoalSuccessionError(
				"target_occupied",
				`This repository/session already has an ultragoal plan at ${getUltragoalPaths(input.cwd, sessionId).goalsPath}. ` +
					"Adopt into a fresh session so the successor run cannot overwrite unrelated work.",
			);
		}
		if (successorPlanContentDigest(existingPlan) !== (ownClaim.expectedPlanDigest ?? expectedPlanDigest)) {
			throw new UltragoalSuccessionError(
				"publication_conflict",
				`Succession ${offer.operationId} has an unpublished claim for this session, but the plan at ` +
					`${getUltragoalPaths(input.cwd, sessionId).goalsPath} is not the plan this operation was going to write. ` +
					"Refusing to overwrite it: a matching operation id is not authority over unrelated target work.",
			);
		}
	}

	const claim: UltragoalSuccessionAdoption = {
		schema: ULTRAGOAL_SUCCESSION_ADOPTION_SCHEMA,
		operationId: offer.operationId,
		status: "pending",
		claimedAt: ownClaim?.claimedAt ?? now,
		targetSessionId: sessionId,
		targetRepository: targetActual,
		source: {
			sessionId: offer.source.sessionId,
			repository: sourceRepository,
			artifacts: offer.source.artifacts,
			artifactsAtAdoption: currentDigests,
			unselectedDrift,
			verifiedAt: now,
		},
		goalMap,
		expectedPlanDigest,
		plannedAt,
		offerPath: resolvedOfferPath,
		offerSha256,
		fencePath,
		claimPath,
		authorization: offer.authorization,
		provenanceNotice: PROVENANCE_NOTICE,
	};

	await beginWorkflowTransactionJournal({
		cwd: input.cwd,
		sessionId,
		mutationId: offer.operationId,
		callee: "ultragoal",
		paths: [adoptionPath, getUltragoalPaths(input.cwd, sessionId).goalsPath],
	});

	if (!ownClaim) {
		try {
			await createJsonNoClobber(adoptionPath, claim, auditContext);
		} catch (error) {
			if (!(error instanceof AlreadyExistsError)) throw error;
			const raced = await readUltragoalSuccessionAdoption(input.cwd, sessionId);
			if (!raced || raced.operationId !== offer.operationId) {
				throw new UltragoalSuccessionError(
					"duplicate_adoption",
					`A concurrent adoption claimed this session for a different operation; ${offer.operationId} is refused.`,
				);
			}
		}
	}

	await writePlan(input.cwd, plan, sessionId, { lockHeld: true });

	await appendJsonlIdempotent(
		getUltragoalPaths(input.cwd, sessionId).ledgerPath,
		{
			eventId: `succession-${offer.operationId}`,
			event: SUCCESSION_ADOPTED_EVENT,
			operationId: offer.operationId,
			sourceRepository: sourceRepository.worktreeRoot,
			sourceSessionId: offer.source.sessionId,
			sourceArtifacts: offer.source.artifacts,
			goalMap,
			authorizedBy: offer.authorization.authorizedBy,
			timestamp: now,
		},
		{
			cwd: input.cwd,
			audit: { category: "ledger", verb: "append", owner: "gjc-runtime", sessionId },
			key: entry =>
				isRecord(entry) && entry.event === SUCCESSION_ADOPTED_EVENT ? String(entry.operationId) : undefined,
		},
	);

	await writeJsonAtomic(
		adoptionPath,
		{ ...claim, status: "published", publishedAt: new Date().toISOString() },
		auditContext,
	);
	await completeWorkflowTransactionJournal(input.cwd, sessionId, offer.operationId);

	return { operationId: offer.operationId, adoptionPath, plan, goalMap, reconciled: Boolean(ownClaim) };
}

// ---- CLI ---------------------------------------------------------------

function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index < 0 ? undefined : args[index + 1];
}

function flagValues(args: readonly string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] !== flag) continue;
		const value = args[index + 1];
		if (value === undefined || value.startsWith("-")) continue;
		values.push(value);
		index += 1;
	}
	return values;
}

async function renderSuccessionStatus(cwd: string, json: boolean): Promise<UltragoalCommandResult> {
	const sessionId = (await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
	const [fence, adoption] = await Promise.all([
		readUltragoalSuccessionFence(cwd, sessionId),
		readUltragoalSuccessionAdoption(cwd, sessionId),
	]);
	const payload = {
		session_id: sessionId,
		fenced: fence !== null,
		operation_id: fence?.operationId ?? adoption?.operationId,
		selected_goal_ids: fence?.selectedGoalIds,
		target_repository: fence?.targetRepository.worktreeRoot,
		fence_path: fence ? ultragoalSuccessionFencePath(cwd, sessionId) : undefined,
		offer_path: fence?.offerPath,
		adopted: adoption !== null,
		adoption_status: adoption?.status,
		adoption_source_repository: adoption?.source.repository.worktreeRoot,
		adoption_goal_map: adoption?.goalMap,
	};
	if (json) return { status: 0, stdout: `${JSON.stringify(payload, null, 2)}\n` };
	const lines: string[] = [];
	lines.push(
		fence
			? `Outgoing fence: succession ${fence.operationId} handed [${fence.selectedGoalIds.join(", ")}] to ${fence.targetRepository.worktreeRoot}.`
			: "Outgoing fence: none. This session owns every goal in its plan.",
	);
	lines.push(
		adoption
			? `Adoption: ${adoption.status} succession ${adoption.operationId} from ${adoption.source.repository.worktreeRoot} session ${adoption.source.sessionId}.`
			: "Adoption: none. This session's plan was not adopted from another repository.",
	);
	return { status: 0, stdout: `${lines.join("\n")}\n` };
}

/**
 * `gjc ultragoal succession <offer|adopt|status>`.
 *
 * Kept out of `RECONCILE_COMMANDS` on purpose: the reconcile pass appends a
 * `reconcile_failed` ledger row on failure, which would move the very source
 * digests this feature records. The target's workflow state and HUD reconcile on
 * the next ordinary `gjc ultragoal status`.
 */
export async function runUltragoalSuccessionCommand(
	args: readonly string[],
	cwd: string,
): Promise<UltragoalCommandResult> {
	const positional = args.filter(arg => !arg.startsWith("-"));
	const subcommand = positional[1];
	const json = args.includes("--json");
	try {
		if (subcommand === "status") return await renderSuccessionStatus(cwd, json);
		if (subcommand === "offer") {
			const result = await offerUltragoalSuccession({
				cwd,
				targetRepositoryPath: flagValue(args, "--target-repo") ?? "",
				goalIds: flagValues(args, "--goal-id"),
				authorization: flagValue(args, "--authorize") ?? "",
				authorizedBy: flagValue(args, "--authorized-by") ?? "",
			});
			return {
				status: 0,
				stdout: json
					? renderCliWriteReceipt({
							ok: true,
							operation_id: result.operationId,
							offer_path: result.offerPath,
							fence_path: result.fencePath,
							selected_goal_ids: result.offer.selection.goalIds,
							target_repository: result.offer.target.repository.worktreeRoot,
							reconciled: result.reconciled,
						})
					: `${result.reconciled ? "Reconciled existing" : "Recorded"} succession ${result.operationId}: ` +
						`[${result.offer.selection.goalIds.join(", ")}] fenced for ${result.offer.target.repository.worktreeRoot}.\n` +
						`Offer: ${result.offerPath}\nFence: ${result.fencePath}\n`,
			};
		}
		if (subcommand === "adopt") {
			const mode = flagValue(args, "--gjc-goal-mode");
			const result = await adoptUltragoalSuccession({
				cwd,
				offerPath: flagValue(args, "--offer") ?? "",
				gjcGoalMode: mode === "per-story" || mode === "aggregate" ? mode : undefined,
			});
			return {
				status: 0,
				createdPlan: !result.reconciled,
				stdout: json
					? renderCliWriteReceipt({
							ok: true,
							operation_id: result.operationId,
							adoption_path: result.adoptionPath,
							goal_map: result.goalMap,
							goals_count: result.plan.goals.length,
							reconciled: result.reconciled,
						})
					: `${result.reconciled ? "Reconciled" : "Adopted"} succession ${result.operationId} with ` +
						`${result.plan.goals.length} goal${result.plan.goals.length === 1 ? "" : "s"}: ` +
						`${result.goalMap.map(row => `${row.sourceGoalId} -> ${row.targetGoalId}`).join(", ")}.\n` +
						`Adoption record: ${result.adoptionPath}\n`,
			};
		}
		return {
			status: 1,
			stderr: `Unknown gjc ultragoal succession subcommand: ${subcommand ?? "(missing)"}; supported: offer, adopt, status\n`,
		};
	} catch (error) {
		if (error instanceof UltragoalSuccessionError) {
			return { status: 1, stderr: `[${error.code}] ${error.message}\n` };
		}
		throw error;
	}
}
