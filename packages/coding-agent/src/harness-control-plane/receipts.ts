/**
 * Harness receipt schemas + validators (M7).
 *
 * Receipts are NEW schemas that FOLLOW the .gjc/state + ultragoal-ledger patterns
 * (atomic, append-indexed, immutable) — not drop-in reuse. Every receipt carries a
 * canonical-JSON sha256 over its content (excluding the hash field) plus referenced
 * artifact hashes; validators recompute and FAIL CLOSED on tamper/mismatch.
 *
 * Families:
 *   - vanish            captures dirty/unknown delta before any restart/fallback (data-loss gate)
 *   - prompt-acceptance proves single-flight acceptance (idle pre-state -> ack -> next agent_start)
 *   - validation        records a verification command result for a specific commit
 *   - completion        the finalize gate: receipt-valid + commit + PR/issue + validations
 */
import { createHash } from "node:crypto";
import {
	type GitDelta,
	isReviewVerdict,
	type ReceiptFamily,
	type RecoveryClassification,
	type ReviewVerdict,
} from "./types";

export interface ReceiptSubject {
	workspace: string;
	branch: string | null;
	head: string | null;
	commit: string | null;
}

export interface ReceiptEnvelope<E = Record<string, unknown>> {
	receiptId: string;
	schemaVersion: number;
	sessionId: string;
	family: ReceiptFamily;
	valid: boolean;
	createdAt: string;
	source: string;
	subject: ReceiptSubject;
	evidence: E;
	/** Hashes of out-of-line artifacts (diff patches, validation logs) folded into the receipt hash. */
	artifactHashes: Record<string, string>;
	sha256: string;
}

export const RECEIPT_SCHEMA_VERSION = 1 as const;

/** Deterministic stringify with sorted keys (stable hash basis). */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

/** Hash basis = canonical JSON of the receipt without `sha256`. */
function hashBasis(receipt: Omit<ReceiptEnvelope<unknown>, "sha256">): string {
	return canonicalJson(receipt);
}

export interface BuildReceiptInput<E> {
	receiptId: string;
	sessionId: string;
	family: ReceiptFamily;
	source: string;
	subject: ReceiptSubject;
	evidence: E;
	artifactHashes?: Record<string, string>;
	createdAt?: string;
	valid?: boolean;
}

export function buildReceipt<E>(input: BuildReceiptInput<E>): ReceiptEnvelope<E> {
	const base: Omit<ReceiptEnvelope<E>, "sha256"> = {
		receiptId: input.receiptId,
		schemaVersion: RECEIPT_SCHEMA_VERSION,
		sessionId: input.sessionId,
		family: input.family,
		valid: input.valid ?? true,
		createdAt: input.createdAt ?? new Date().toISOString(),
		source: input.source,
		subject: input.subject,
		evidence: input.evidence,
		artifactHashes: input.artifactHashes ?? {},
	};
	return { ...base, sha256: sha256Hex(hashBasis(base)) };
}

export interface ValidationOutcome {
	valid: boolean;
	reasons: string[];
}

/** Reusable non-empty string guard for structural envelope checks. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * Validate the structural envelope fields independently of the hash. A receipt
 * can be hash-self-consistent while carrying empty/missing identity fields (an
 * attacker controls the bytes the hash is computed over), so these checks must
 * run BEFORE any lifecycle transition is allowed. Fail-closed.
 */
function validateStructure(receipt: ReceiptEnvelope<unknown>): string[] {
	const reasons: string[] = [];
	if (!isNonEmptyString(receipt.receiptId)) reasons.push("envelope-missing-receiptId");
	if (!isNonEmptyString(receipt.sessionId)) reasons.push("envelope-missing-sessionId");
	if (!isNonEmptyString(receipt.source)) reasons.push("envelope-missing-source");
	if (!isNonEmptyString(receipt.createdAt)) reasons.push("envelope-missing-createdAt");
	// Family vocabulary itself is enforced by `validateFamily`; here we only
	// require a non-empty family token so the envelope is well-formed.
	if (!isNonEmptyString(receipt.family)) reasons.push("envelope-missing-family");
	if (typeof receipt.valid !== "boolean") reasons.push("envelope-bad-valid");
	if (typeof receipt.sha256 !== "string") reasons.push("envelope-missing-sha256");
	const subject = receipt.subject as ReceiptSubject | undefined;
	if (!subject || typeof subject !== "object" || Array.isArray(subject) || !isNonEmptyString(subject.workspace)) {
		reasons.push("envelope-bad-subject");
	}
	if (receipt.evidence === null || typeof receipt.evidence !== "object" || Array.isArray(receipt.evidence)) {
		reasons.push("envelope-bad-evidence");
	}
	if (!receipt.artifactHashes || typeof receipt.artifactHashes !== "object" || Array.isArray(receipt.artifactHashes)) {
		reasons.push("envelope-bad-artifactHashes");
	}
	return reasons;
}

/** Recompute the hash and run structural family checks. Fail-closed. */
export function validateReceipt(receipt: ReceiptEnvelope<unknown>): ValidationOutcome {
	// Fail closed on malformed/non-object envelopes (null, undefined, arrays,
	// primitives) instead of throwing while destructuring below.
	if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
		return { valid: false, reasons: ["malformed-envelope"] };
	}
	const reasons: string[] = [];
	reasons.push(...validateStructure(receipt));
	const { sha256, ...rest } = receipt;
	if (sha256Hex(hashBasis(rest)) !== sha256) reasons.push("hash-mismatch");
	if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) reasons.push("schema-version-mismatch");
	const familyReasons = validateFamily(receipt);
	reasons.push(...familyReasons);
	return { valid: reasons.length === 0, reasons };
}

// ---- Family evidence shapes ---------------------------------------------------

export interface VanishEvidence {
	classification: RecoveryClassification;
	gitDelta: GitDelta;
	gitStatusPorcelain: string;
	untrackedManifest: { path: string; size: number; sha256: string }[];
	preservation: "snapshot" | "stash" | "block";
	stashRef: string | null;
	snapshotComplete: boolean;
	forbiddenActions: string[];
}

export interface PromptAcceptanceEvidence {
	promptSha256: string;
	preSubmitState: { isStreaming: boolean; steeringQueueDepth: number; followupQueueDepth: number };
	preSubmitCursor: number;
	agentStartCursor: number;
	acceptedAt: string;
	singleFlight: true;
}

export interface ValidationEvidence {
	command: string;
	exactCommand: string;
	cwd: string;
	exitStatus: number;
	pass: boolean;
	commitUnderTest: string | null;
}

export interface CompletionEvidence {
	finalCommit: string;
	branch: string;
	prUrl: string | null;
	issueArtifact: string | null;
	requiredValidationReceiptIds: string[];
	finalLifecycle: string;
	finalizedAt: string;
	blockers: string[];
}

export interface ReviewVerdictEvidence {
	verdict: ReviewVerdict;
	prTarget: string | null;
	finalizedAt: string;
	/** Bounded summary code/reference for the verdict; never raw assistant text. */
	summaryRef: string | null;
	/** Where the verdict came from: explicit operator input or extracted from final assistant text. */
	verdictSource?: "input" | "assistant";
	/** sha256 of the assistant text the verdict was extracted from, when sourced from the agent. */
	assistantDigest?: string | null;
}

export interface ReviewFailureEvidence {
	/** Machine-actionable reason the review produced no terminal verdict. */
	reason: string;
	prTarget: string | null;
	failedAt: string;
	/** Routing hint for the operator/fallback path. */
	fallback: string;
	/** sha256 of the assistant text examined for a verdict, when one was available. */
	assistantDigest?: string | null;
	/** Bounded, whitespace-collapsed assistant summary (never an unbounded transcript dump). */
	assistantSummary?: string | null;
}

function validateFamily(receipt: ReceiptEnvelope<unknown>): string[] {
	switch (receipt.family) {
		case "vanish":
			return validateVanish(receipt.evidence as VanishEvidence);
		case "prompt-acceptance":
			return validatePromptAcceptance(receipt.evidence as PromptAcceptanceEvidence);
		case "validation":
			return validateValidation(receipt.evidence as ValidationEvidence);
		case "completion":
			return validateCompletion(receipt.evidence as CompletionEvidence);
		case "review-verdict":
			return validateReviewVerdict(receipt.evidence as ReviewVerdictEvidence);
		case "review-failure":
			return validateReviewFailure(receipt.evidence as ReviewFailureEvidence);
		case "phase-rollup":
			return validatePhaseRollup(receipt.evidence as PhaseRollupEvidence);
		default:
			return [`unknown-family:${receipt.family}`];
	}
}

// ---- Phase rollup (receipt-of-receipts) ----------------------------------------

/** Pointer back to one superseded child task receipt. */
export interface PhaseRollupChildPointer {
	id: string;
	status: "completed" | "failed" | "aborted" | "merge_failed" | "paused";
	/** Artifact URI holding the child's full output, when available. */
	outputUri: string | null;
	/** Content hash of the child's output artifact, when available. */
	outputSha256: string | null;
	/** Hash of the child receipt itself (canonical JSON), for staleness checks. */
	receiptSha256: string;
	/**
	 * Per-child ROI accounting carried into the rollup so the aggregate totals
	 * below are recomputable/verifiable from child evidence (not self-reported).
	 * `tokens` is the child's effective token count; cost/cloned are null when
	 * the child reported no such accounting.
	 */
	tokens: number;
	costTotal: number | null;
	clonedTokens: number | null;
	lowRoi: boolean;
}

export interface PhaseRollupEvidence {
	/** Harness lifecycle boundary this rollup was emitted at. */
	phase: string;
	children: PhaseRollupChildPointer[];
	aggregate: {
		childCount: number;
		completed: number;
		failed: number;
		totalTokens: number;
		totalCostTotal: number | null;
		totalClonedTokens: number | null;
		lowRoiChildIds: string[];
	};
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

const PHASE_ROLLUP_CHILD_STATUSES = new Set(["completed", "failed", "aborted", "merge_failed", "paused"]);

/** Reconcile two recomputed-vs-reported numeric totals (null == "not reported"). */
function numbersReconcile(actual: number | null, expected: number | null): boolean {
	if (actual === null || expected === null) return actual === expected;
	return Math.abs(actual - expected) <= 1e-9;
}

/** True when two id lists describe the same set (order-independent). */
function sameIdSet(actual: readonly string[], expected: readonly string[]): boolean {
	if (actual.length !== expected.length) return false;
	const expectedSet = new Set(expected);
	for (const id of actual) {
		if (!expectedSet.has(id)) return false;
	}
	return new Set(actual).size === expectedSet.size;
}

export function validatePhaseRollup(e: PhaseRollupEvidence): string[] {
	const reasons: string[] = [];
	if (!e || typeof e.phase !== "string" || e.phase.length === 0) return ["phase-rollup-missing-phase"];
	if (!Array.isArray(e.children) || e.children.length === 0) {
		reasons.push("phase-rollup-empty-children");
		return reasons;
	}
	const seenIds = new Set<string>();
	let completedFromChildren = 0;
	let failedFromChildren = 0;
	let tokensFromChildren = 0;
	let costFromChildren = 0;
	let clonedFromChildren = 0;
	let anyCost = false;
	let anyCloned = false;
	const lowRoiFromChildren: string[] = [];
	for (const child of e.children) {
		if (!child || typeof child.id !== "string" || child.id.length === 0) {
			reasons.push("phase-rollup-child-missing-id");
			continue;
		}
		if (seenIds.has(child.id)) reasons.push(`phase-rollup-duplicate-child-id:${child.id}`);
		seenIds.add(child.id);
		if (!PHASE_ROLLUP_CHILD_STATUSES.has(child.status)) {
			reasons.push(`phase-rollup-child-bad-status:${child.id}`);
		}
		if (child.status === "completed") completedFromChildren++;
		if (child.status === "failed" || child.status === "merge_failed") failedFromChildren++;
		if (typeof child.receiptSha256 !== "string" || !SHA256_HEX.test(child.receiptSha256)) {
			reasons.push(`phase-rollup-child-bad-receipt-hash:${child.id}`);
		}
		if (child.outputUri !== null && (typeof child.outputUri !== "string" || child.outputUri.length === 0)) {
			reasons.push(`phase-rollup-child-bad-output-uri:${child.id}`);
		}
		if (child.outputSha256 !== null && !SHA256_HEX.test(child.outputSha256)) {
			reasons.push(`phase-rollup-child-bad-output-hash:${child.id}`);
		}
		// Receipt-of-receipts integrity requires BOTH an output URI and its
		// content hash. Reject either one-sided pairing fail-closed: a hash
		// without a URI is unanchored, and a URI without a hash is unverifiable.
		if (child.outputSha256 !== null && child.outputUri === null) {
			reasons.push(`phase-rollup-child-orphan-output-hash:${child.id}`);
		}
		if (child.outputUri !== null && child.outputSha256 === null) {
			reasons.push(`phase-rollup-child-orphan-output-uri:${child.id}`);
		}
		// Per-child ROI accounting must be well-formed before it can be summed
		// for the recomputed aggregate reconciliation below.
		if (typeof child.tokens !== "number" || !Number.isFinite(child.tokens) || child.tokens < 0) {
			reasons.push(`phase-rollup-child-bad-tokens:${child.id}`);
		} else {
			tokensFromChildren += child.tokens;
		}
		if (child.costTotal !== null) {
			if (typeof child.costTotal !== "number" || !Number.isFinite(child.costTotal) || child.costTotal < 0) {
				reasons.push(`phase-rollup-child-bad-cost:${child.id}`);
			} else {
				anyCost = true;
				costFromChildren += child.costTotal;
			}
		}
		if (child.clonedTokens !== null) {
			if (typeof child.clonedTokens !== "number" || !Number.isFinite(child.clonedTokens) || child.clonedTokens < 0) {
				reasons.push(`phase-rollup-child-bad-cloned-tokens:${child.id}`);
			} else {
				anyCloned = true;
				clonedFromChildren += child.clonedTokens;
			}
		}
		if (typeof child.lowRoi !== "boolean") {
			reasons.push(`phase-rollup-child-bad-low-roi:${child.id}`);
		} else if (child.lowRoi) {
			lowRoiFromChildren.push(child.id);
		}
	}
	const aggregate = e.aggregate;
	if (!aggregate || typeof aggregate.childCount !== "number") {
		reasons.push("phase-rollup-missing-aggregate");
		return reasons;
	}
	if (aggregate.childCount !== e.children.length) reasons.push("phase-rollup-child-count-mismatch");
	if (aggregate.completed !== completedFromChildren) reasons.push("phase-rollup-aggregate-completed-mismatch");
	if (aggregate.failed !== failedFromChildren) reasons.push("phase-rollup-aggregate-failed-mismatch");
	for (const field of ["totalTokens", "completed", "failed"] as const) {
		const value = aggregate[field];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			reasons.push(`phase-rollup-aggregate-bad-${field}`);
		}
	}
	for (const field of ["totalCostTotal", "totalClonedTokens"] as const) {
		const value = aggregate[field];
		if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
			reasons.push(`phase-rollup-aggregate-bad-${field}`);
		}
	}
	// Recompute the ROI aggregates from child evidence and fail closed on any
	// self-reported total that does not reconcile. `null` is the canonical
	// "no child reported this metric" value, mirroring the builder.
	if (aggregate.totalTokens !== tokensFromChildren) {
		reasons.push("phase-rollup-aggregate-tokens-mismatch");
	}
	if (!numbersReconcile(aggregate.totalCostTotal, anyCost ? costFromChildren : null)) {
		reasons.push("phase-rollup-aggregate-cost-mismatch");
	}
	if (!numbersReconcile(aggregate.totalClonedTokens, anyCloned ? clonedFromChildren : null)) {
		reasons.push("phase-rollup-aggregate-cloned-tokens-mismatch");
	}
	if (!Array.isArray(aggregate.lowRoiChildIds)) {
		reasons.push("phase-rollup-aggregate-bad-lowRoiChildIds");
	} else if (!sameIdSet(aggregate.lowRoiChildIds, lowRoiFromChildren)) {
		reasons.push("phase-rollup-aggregate-low-roi-mismatch");
	}
	return reasons;
}

function validateVanish(e: VanishEvidence): string[] {
	const reasons: string[] = [];
	if (!e || typeof e.gitDelta !== "string") return ["vanish-missing-evidence"];
	const protectedDelta = e.gitDelta === "dirty" || e.gitDelta === "unknown";
	if (protectedDelta) {
		// Hard data-loss invariant: a dirty/unknown delta must be preserved (never blocked-away),
		// and the destructive actions must be explicitly forbidden.
		if (e.preservation === "block") reasons.push("vanish-dirty-must-preserve-not-block");
		for (const action of ["restart-clean", "delete", "reset"]) {
			if (!Array.isArray(e.forbiddenActions) || !e.forbiddenActions.includes(action)) {
				reasons.push(`vanish-must-forbid-${action}`);
			}
		}
	}
	if (e.preservation === "snapshot" && !e.snapshotComplete) reasons.push("vanish-snapshot-incomplete");
	if (e.preservation === "stash" && !e.stashRef) reasons.push("vanish-stash-missing-ref");
	return reasons;
}

function validatePromptAcceptance(e: PromptAcceptanceEvidence): string[] {
	const reasons: string[] = [];
	if (!e) return ["acceptance-missing-evidence"];
	if (e.singleFlight !== true) reasons.push("acceptance-not-single-flight");
	if (e.preSubmitState?.isStreaming) reasons.push("acceptance-pre-state-streaming");
	if ((e.preSubmitState?.steeringQueueDepth ?? 1) !== 0) reasons.push("acceptance-steering-queue-nonempty");
	if ((e.preSubmitState?.followupQueueDepth ?? 1) !== 0) reasons.push("acceptance-followup-queue-nonempty");
	if (!(e.agentStartCursor > e.preSubmitCursor)) reasons.push("acceptance-agent-start-not-after-cursor");
	return reasons;
}

function validateValidation(e: ValidationEvidence): string[] {
	if (!e || typeof e.exactCommand !== "string") return ["validation-missing-evidence"];
	return e.pass ? [] : ["validation-failed"];
}

function validateCompletion(e: CompletionEvidence): string[] {
	const reasons: string[] = [];
	if (!e) return ["completion-missing-evidence"];
	if (!e.finalCommit) reasons.push("completion-missing-commit");
	if (!e.prUrl && !e.issueArtifact) reasons.push("completion-missing-pr-or-issue");
	if (!Array.isArray(e.requiredValidationReceiptIds) || e.requiredValidationReceiptIds.length === 0) {
		reasons.push("completion-missing-validation-receipts");
	}
	if (Array.isArray(e.blockers) && e.blockers.length > 0) reasons.push("completion-has-blockers");
	// NOTE: evidence.finalLifecycle vs the lifecycle target is reconciled
	// fail-closed at the ingest layer (`evidenceContradiction` ->
	// `evidence-lifecycle-mismatch`), where the actual transition is gated.
	return reasons;
}

function validateReviewVerdict(e: ReviewVerdictEvidence): string[] {
	if (!e) return ["review-verdict-missing-evidence"];
	if (!isReviewVerdict(e.verdict)) return ["review-verdict-not-in-vocabulary"];
	return [];
}

function validateReviewFailure(e: ReviewFailureEvidence): string[] {
	if (!e || typeof e.reason !== "string" || e.reason.length === 0) return ["review-failure-missing-reason"];
	return [];
}

/** Classifications that MUST have a valid `vanish` receipt before the action proceeds. */
export function requiresVanishBeforeAction(classification: RecoveryClassification): boolean {
	return (
		classification === "restart-clean" ||
		classification === "restart-preserve-delta" ||
		classification === "fallback-codex-exec"
	);
}
