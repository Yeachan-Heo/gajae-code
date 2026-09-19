#!/usr/bin/env bun

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const VERDICT_PREFIX = "gajae.pr-review-verdict.v1";
const VERDICT_PATTERN = /^gajae\.pr-review-verdict\.v1 (merge-approved|merge-self-approved|merge-blocked|needs-human) sha256:([0-9a-f]{64}) reviewer:(architect|critic|human) reviewer-id:([^\s]+) evidence:(.+)$/u;
const SELF_REVIEW_PREFIX = "gajae.pr-self-review.v1";
const SELF_REVIEW_PATTERN = /^gajae\.pr-self-review\.v1 verdict:(merge-approved|merge-self-approved|merge-blocked) base:([0-9a-f]{40}) head:([0-9a-f]{40}) sha256:([0-9a-f]{64}) reviewer-id:([^\s]+) risk:(low-risk|regression-risk|high-risk) extra:(none|independent:[^\s]+) evidence:(.+)$/u;
const SELF_REVIEW_SIGNATURE_PATTERN = /^self-review-signature: sha256:([0-9a-f]{64})$/u;
const SELF_REVIEW_FOOTER = "Signed-off-by: gaebal-gajae (clawdbot) 🦞";

export type PrVerdict = "merge-approved" | "merge-self-approved" | "merge-blocked" | "needs-human";
export type ReviewerRole = "architect" | "critic" | "human";
export type SelfReviewRisk = "low-risk" | "regression-risk" | "high-risk";
export type SelfReviewExtra = { kind: "none" } | { kind: "independent"; login: string };

export interface ParsedPrVerdict {
	verdict: PrVerdict;
	diffSha256: string;
	reviewerRole: ReviewerRole;
	reviewerId: string;
	evidence: string;
}

export interface ParsedSelfReview {
	verdict: "merge-approved" | "merge-self-approved" | "merge-blocked";
	baseSha: string;
	headSha: string;
	diffSha256: string;
	reviewerId: string;
	risk: SelfReviewRisk;
	extra: SelfReviewExtra;
	evidence: string;
	signature: string;
}

export interface PrValidationInput {
	body: string;
	baseRef: string;
	baseSha: string;
	headSha: string;
	authorLogin: string;
	computedDiffSha256: string;
	baseIsAncestor: boolean;
	fastGatePassed: boolean;
	authenticatedReviewerLogin?: string;
	authenticatedReviewHeadSha?: string;
	requireMergeApproved?: boolean;
	/** Trusted GitHub issue-comment data backing a maintainer self-review. */
	selfReviewComment?: AuthenticatedSelfReviewComment | null;
	/**
	 * Why the trusted self-review comment could not be READ by the caller that tried to
	 * fetch it. Set only when the record is missing from the input because the fetch
	 * failed; a record that is absent from the PR itself is not an unread record.
	 */
	selfReviewUnavailable?: string | null;
	/** True when the caller actually read the PR's comment list for this exact head. */
	selfReviewFetched?: boolean;
	/**
	 * True when the caller could not read the independent-review evidence a risk-classified
	 * record names. The caller reports that unread evidence itself, so the record's policy
	 * line must not additionally present the same failure as an unsatisfied policy.
	 */
	independentReviewerUnavailable?: boolean;
	/** Risk declaration from the PR body (must match the self-review comment; issue #4703). */
	bodyRisk?: string | null;
	/** Trusted GitHub evidence about the independent reviewer named by extra:independent:<login>. */
	independentReviewer?: IndependentReviewerEvidence | null;
}

export interface IndependentReviewerEvidence {
	permission: string;
	approvedHead: boolean;
	approvedLogin?: string;
	/**
	 * Why a commit-id-bound APPROVED review was refused, when one exists.
	 *
	 * `rebound` means precedence is PROVEN: a readable head date and a readable earlier
	 * submission, i.e. GitHub re-pointed a stale review after a force-push. `unreadable`
	 * means the review is refused but that claim cannot be made — typically a head commit
	 * date that could not be read, which fails closed rather than admitting the approval.
	 * Absent means this login has no approval bound to the head at all (#5692 review).
	 */
	refusedApproval?: "rebound" | "unreadable";
}

/** A review normalized from either API shape so one rule can decide the effective one. */
interface EffectiveReview {
	login?: string;
	state?: string;
	oid?: string;
	/** ISO submission time. Absent means the caller could not read it; that fails closed. */
	submittedAt?: string;
}

/**
 * Whether a review's reported commit can be trusted as the head it actually reviewed.
 *
 * `review.commit_id` is NOT immutable: GitHub re-points it at the new branch tip when a PR
 * is force-pushed and stale-review dismissal does not fire. `dev` is unprotected, so the
 * branch almost every PR targets has no dismissal, and a rebase therefore turned every prior
 * approval into an apparent exact-head approval. Two live cases: an approval submitted
 * 4h24m before its attributed head existed, and another two days before (#5692).
 *
 * `headKnownAt` is the earliest time this head is PROVEN to have existed. A review submitted
 * before that cannot have reviewed it.
 *
 * It must come from a server-observed source. The head's committer date is NOT one: the
 * contributor sets it, so `GIT_COMMITTER_DATE` backdating would make a stale approval look
 * fresh — a fail-open in the guard that exists to fail closed (#5692 review). The caller
 * therefore derives it from the PR timeline's force-push events, whose `created_at` GitHub
 * writes and the contributor cannot.
 *
 * Both timestamps must be readable and parseable; an unknown time is never treated as fresh.
 *
 * A TIE is refused, not admitted. GitHub serializes both values at second granularity, so a
 * review submitted at `12:00:00.9` and a force-push recorded at `12:00:00.1` are
 * indistinguishable — the review predates the head it claims and would still be accepted by
 * a strict `<`. No legitimate review is submitted in the same second as the force-push that
 * created the head it reviews, since the reviewer has to fetch and read it first, so
 * rejecting ties costs nothing real (#5692 review).
 */
function reviewPrecedesHead(submittedAt: string | undefined, headKnownAt: string | undefined): boolean {
	if (submittedAt === undefined || headKnownAt === undefined) return true;
	const submitted = Date.parse(submittedAt);
	const known = Date.parse(headKnownAt);
	if (!Number.isFinite(submitted) || !Number.isFinite(known)) return true;
	return submitted <= known;
}

/**
 * Latest readable timestamp among a contributor-supplied floor and server-observed events.
 *
 * A force-push strictly postdates the head it created, so when both are present the later
 * value is the stronger proof.
 *
 * A server-observed entry that is PRESENT but unparseable returns `undefined`, refusing the
 * approval. Silently dropping it and falling back to the contributor's committer date would
 * reinstate the backdate hole: a force-push did happen, we simply could not read when, and
 * "could not read the authority" is not the same as "no authority exists". Only a genuinely
 * empty event list falls back, because no force-push means nothing re-bound `commit_id`
 * (#5692 review).
 */
function latestKnownHeadTime(
	committedAt: string | undefined,
	serverObserved: Array<string | undefined>,
): string | undefined {
	// An entry that is absent or blank is just as unreadable as one that will not parse:
	// the force-push happened, we simply cannot read when. Filtering those out first and
	// only then checking parseability silently discarded them and fell back to the
	// contributor's committer date — the same fail-open, reached through `created_at: null`
	// instead of a malformed string. Count before filtering (#5692 review).
	const present = serverObserved.map(value => value?.trim()).filter(value => value !== undefined && value.length > 0);
	if (present.length !== serverObserved.length) return undefined;
	if (present.some(value => !Number.isFinite(Date.parse(value as string)))) return undefined;
	// Server-observed evidence WINS OUTRIGHT; the committer date is not blended into it.
	//
	// Taking the latest of both let a contributor set `GIT_COMMITTER_DATE` into the future
	// and raise the floor above what GitHub actually observed, refusing every legitimate
	// approval on their own PR. Backdating was the original hole; forward-dating is the
	// same control used the other way. When a force-push is on record, the moment it
	// happened is when this head appeared, and the commit's self-reported date adds
	// nothing (#5692 review).
	if (present.length > 0) {
		return (present as string[]).reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest));
	}
	// No force-push on record, so nothing re-bound `commit_id` and the committer date is
	// an adequate floor.
	const committed = committedAt?.trim();
	if (committed === undefined || committed.length === 0 || !Number.isFinite(Date.parse(committed))) return undefined;
	return committed;
}

/**
 * The effective review for one identity on the exact head: the latest non-COMMENTED review,
 * so a later CHANGES_REQUESTED supersedes an earlier APPROVED. Single-sourced because three
 * callers (the event approval, the independent-reviewer evidence, and the push preflight)
 * must never disagree about which review counts — the divergence that produced issue #5483
 * and later the withdrawn-approval gap the QA lane found.
 *
 * `headKnownAt` also discards reviews that predate the head they claim, which is how a
 * force-push silently re-binds a stale approval onto new code (#5692).
 *
 * It is REQUIRED, and `undefined` rejects rather than admitting. An earlier version made
 * the precedence test conditional on having a head date, which meant a failed commit
 * lookup, an absent committer date, or an empty local `git show` skipped the check entirely
 * and admitted the approval — a fail-OPEN in the very guard that exists to fail closed.
 *
 * ORDER MATTERS. Selection happens first, freshness second. Filtering on freshness before
 * taking the last review let an unreadable later CHANGES_REQUESTED be dropped from the list,
 * promoting an earlier valid APPROVED back to "last word" and authorizing a merge the
 * reviewer had withdrawn. A withdrawal whose time cannot be read must refuse, never vanish
 * (#5692 review).
 */
/**
 * The identity's last word on the exact head, before any freshness judgement.
 *
 * Single-sourced because `effectiveExactHeadReview` and `refusedApprovalKind` must never
 * disagree about which review counts. They each had their own copy of this filter, and when
 * only one was reordered to select before judging freshness the two diverged — the same
 * class of split that produced #5483 (#5692 review).
 */
function lastExactHeadReview(
	reviews: EffectiveReview[],
	login: string,
	headSha: string,
): EffectiveReview | undefined {
	return reviews
		.filter(review =>
			review.login?.toLowerCase() === login.toLowerCase()
			&& review.state !== "COMMENTED"
			&& review.oid === headSha,
		)
		.at(-1);
}

function effectiveExactHeadReview(
	reviews: EffectiveReview[],
	login: string,
	headSha: string,
	headKnownAt: string | undefined,
): EffectiveReview | undefined {
	const lastOnHead = lastExactHeadReview(reviews, login, headSha);
	if (lastOnHead === undefined) return undefined;
	return reviewPrecedesHead(lastOnHead.submittedAt, headKnownAt) ? undefined : lastOnHead;
}

/**
 * Why this identity has no usable exact-head approval, when it has one bound by commit id.
 *
 * `rebound` is claimed ONLY when precedence is actually proven: a readable head date and a
 * readable earlier submission. When either date is unreadable the answer is `unreadable`,
 * not `rebound` — the review is still refused, but asserting it was re-bound would be a
 * claim the evidence does not support (#5692 review).
 */
type RefusedApprovalKind = "rebound" | "unreadable" | undefined;

function refusedApprovalKind(
	reviews: EffectiveReview[],
	login: string,
	headSha: string,
	headKnownAt: string | undefined,
): RefusedApprovalKind {
	// Shares `lastExactHeadReview` with `effectiveExactHeadReview` so the two can never
	// disagree about which review counts. Duplicating the selection here is exactly the
	// divergence that produced #5483, and it reappeared once already when only one of the
	// two was reordered to select before judging freshness (#5692 review).
	const lastOnHead = lastExactHeadReview(reviews, login, headSha);
	// A later CHANGES_REQUESTED is an ordinary withdrawal, not a freshness problem, and
	// must keep reporting as "no approval" rather than as a refusal.
	if (lastOnHead?.state !== "APPROVED") return undefined;
	const headMs = headKnownAt === undefined ? Number.NaN : Date.parse(headKnownAt);
	if (!Number.isFinite(headMs)) return "unreadable";
	const submitted = lastOnHead.submittedAt === undefined ? Number.NaN : Date.parse(lastOnHead.submittedAt);
	if (!Number.isFinite(submitted)) return "unreadable";
	return submitted <= headMs ? "rebound" : "unreadable";
}

/** Spreadable `refusedApproval` field, omitted entirely when there is nothing to report. */
function refusedApprovalField(
	reviews: EffectiveReview[],
	login: string,
	headSha: string,
	headCommittedAt: string | undefined,
): { refusedApproval?: "rebound" | "unreadable" } {
	const kind = refusedApprovalKind(reviews, login, headSha, headCommittedAt);
	return kind === undefined ? {} : { refusedApproval: kind };
}

export interface AuthenticatedSelfReviewComment {
	login: string;
	authorAssociation: string;
	body: string;
}

export interface PrValidationResult {
	/** CONTRACT validity only: shape, exact-head binding, digest freshness, forgery, fast gate. */
	ok: boolean;
	verdict?: ParsedPrVerdict;
	diagnostics: string[];
	/**
	 * Whether this exact head is authorized to merge. Separated from `ok` so "your PR is
	 * malformed" and "your PR is waiting for a reviewer" stop sharing one red check. The
	 * predicate itself is unchanged; only the channel it is reported on moved.
	 * A merge is never authorized while the contract itself is invalid.
	 */
	mergeAuthorized: boolean;
	/** Why the merge is not authorized yet. Never contract defects, never forgery claims. */
	authorizationDiagnostics: string[];
}

/**
 * A result decided without any authorization question: merge authorization mirrors the
 * contract verdict, exactly as every caller behaved before the gate was split out.
 */
function contractResult(ok: boolean, diagnostics: string[], verdict?: ParsedPrVerdict): PrValidationResult {
	return { ok, verdict, diagnostics, mergeAuthorized: ok, authorizationDiagnostics: [] };
}

export function parsePrVerdict(body: string): { verdict?: ParsedPrVerdict; diagnostics: string[] } {
	const candidates = body
		.split(/\r?\n/u)
		.map(line => line.trim())
		.filter(line => line.startsWith(VERDICT_PREFIX));
	if (candidates.length === 0) {
		return {
			diagnostics: [
				`PR body must contain exactly one ${VERDICT_PREFIX} line. Copy the current .github/PULL_REQUEST_TEMPLATE.md block and fill every field.`,
			],
		};
	}
	if (candidates.length !== 1) {
		return { diagnostics: [`PR body contains ${candidates.length} ${VERDICT_PREFIX} lines; keep exactly one current verdict.`] };
	}
	const match = VERDICT_PATTERN.exec(candidates[0]!);
	if (!match) {
		return {
			diagnostics: [
				`Malformed ${VERDICT_PREFIX} line. Expected: ${VERDICT_PREFIX} <merge-approved|merge-blocked|needs-human> sha256:<64 lowercase hex> reviewer:<architect|critic|human> reviewer-id:<identity> evidence:<non-empty evidence>.`,
			],
		};
	}
	return {
		verdict: {
			verdict: match[1] as PrVerdict,
			diffSha256: match[2]!,
			reviewerRole: match[3] as ReviewerRole,
			reviewerId: match[4]!,
			evidence: match[5]!.trim(),
		},
		diagnostics: [],
	};
}

/**
 * Parse a maintainer self-review block from trusted GitHub issue-comment data.
 *
 * The contract (issue #4703): an owner-authored maintainer PR may satisfy the exact-head
 * review requirement with a signed PR comment bound to the exact base SHA, head SHA,
 * canonical diff digest, reviewer identity, verdict, risk classification, and the
 * required supplementary review evidence for regression-risk and high-risk changes.
 * The comment must never be read from the PR body (forgery) and never from head code.
 */
export function parseSelfReview(body: string): { selfReview?: ParsedSelfReview; diagnostics: string[] } {
	const lines = body.split(/\r?\n/u).map(line => line.trim());
	const recordLines = lines.filter(line => line.startsWith(SELF_REVIEW_PREFIX));
	if (recordLines.length === 0) {
		return { diagnostics: [`${SELF_REVIEW_PREFIX} record line not found in comment.`] };
	}
	if (recordLines.length !== 1) {
		return { diagnostics: [`Comment contains ${recordLines.length} ${SELF_REVIEW_PREFIX} lines; keep exactly one.`] };
	}
	const match = SELF_REVIEW_PATTERN.exec(recordLines[0]!);
	if (!match) {
		return {
			diagnostics: [
				`Malformed ${SELF_REVIEW_PREFIX} line. Expected: ${SELF_REVIEW_PREFIX} verdict:<merge-approved|merge-blocked> base:<40-hex> head:<40-hex> sha256:<64-hex> reviewer-id:<identity> risk:<low-risk|regression-risk|high-risk> extra:<none|gpt-heavy|independent:login> evidence:<non-empty>.`,
			],
		};
	}
	const signatureLines = lines.filter(line => SELF_REVIEW_SIGNATURE_PATTERN.test(line));
	if (signatureLines.length !== 1) {
		return { diagnostics: [`Comment must contain exactly one self-review-signature line; found ${signatureLines.length}.`] };
	}
	const footerLines = lines.filter(line => line === SELF_REVIEW_FOOTER);
	if (footerLines.length !== 1) {
		return { diagnostics: [`Comment must contain exactly one ${SELF_REVIEW_FOOTER} line; found ${footerLines.length}.`] };
	}
	const extraToken = match[7]!;
	const extra: SelfReviewExtra = extraToken === "none"
		? { kind: "none" }
		: { kind: "independent", login: extraToken.slice("independent:".length) };
	return {
		selfReview: {
			verdict: match[1] as "merge-approved" | "merge-self-approved" | "merge-blocked",
			baseSha: match[2]!,
			headSha: match[3]!,
			diffSha256: match[4]!,
			reviewerId: match[5]!,
			risk: match[6] as SelfReviewRisk,
			extra,
			evidence: match[8]!.trim(),
			signature: signatureLines[0]!.slice("self-review-signature: sha256:".length),
		},
		diagnostics: [],
	};
}

/**
 * Canonicalize a parsed self-review record into the exact checksum payload: every bound
 * field in fixed order, then the evidence. This is an INTEGRITY digest, not
 * authentication: it proves the comment text matches what was posted for the bound
 * head, exactly like the diff digest. Authorization never rests on it (issue #4703
 * review: a self-issued hash cannot be an authorization control).
 */
export function selfReviewSignedPayload(review: Omit<ParsedSelfReview, "signature">): string {
	const extraToken = review.extra.kind === "none" ? "none" : `independent:${review.extra.login}`;
	return [
		`${SELF_REVIEW_PREFIX} verdict:${review.verdict}`,
		`base:${review.baseSha}`,
		`head:${review.headSha}`,
		`sha256:${review.diffSha256}`,
		`reviewer-id:${review.reviewerId}`,
		`risk:${review.risk}`,
		`extra:${extraToken}`,
		`evidence:${review.evidence}`,
	].join("\n");
}

const SELF_REVIEW_SIGNATURE_DOMAIN = "gajae.pr-self-review.v1.signature-domain";

export function selfReviewSignature(payload: string): string {
	return new Bun.CryptoHasher("sha256").update(SELF_REVIEW_SIGNATURE_DOMAIN).update(payload).digest("hex");
}

/**
 * Risk-classified review policy (issue #4703, post-review semantics).
 * `extra:independent:<login>` only satisfies the gate when the named reviewer is a
 * distinct maintainer with admin/maintain/write permission and an authenticated APPROVED
 * review on the exact head; the token shape alone never satisfies the policy.
 * `extra:gpt-heavy` was removed: an author-supplied token with no authenticated
 * run artifact behind it cannot substitute for review evidence (review finding 3).
 */
export function selfReviewSatisfiesPolicy(review: ParsedSelfReview, independentReviewer: IndependentReviewerEvidence | null = null): boolean {
	const independentApproved = (extra: { login: string }): boolean => {
		if (!independentReviewer) return false;
		if (independentReviewer.approvedLogin?.toLowerCase() !== extra.login.toLowerCase()) return false;
		if (!independentReviewer.approvedHead) return false;
		return new Set(["admin", "maintain", "write"]).has(independentReviewer.permission);
	};
	switch (review.risk) {
		case "low-risk":
			return review.extra.kind === "none";
		case "regression-risk":
			return review.extra.kind === "independent" && independentApproved(review.extra);
		case "high-risk":
			return review.extra.kind === "independent" && independentApproved(review.extra);
	}
}
export function validatePrContract(input: PrValidationInput): PrValidationResult {
	const parsed = parsePrVerdict(input.body);
	const diagnostics = [...parsed.diagnostics];
	// "Not approved yet" is a pending authorization, not a defect in the PR. It is the only
	// diagnostic reported here; every false claim (self-approval, an unbacked reviewer-id, a
	// stale digest) stays a CONTRACT defect.
	const authorizationDiagnostics: string[] = [];
	if (input.baseRef !== "dev") diagnostics.push(`PR base must be dev, not ${JSON.stringify(input.baseRef)}. Retarget the PR to dev.`);
	if (!SHA40.test(input.baseSha)) diagnostics.push("Immutable PR event base SHA must be a lowercase 40-hex commit.");
	if (!SHA40.test(input.headSha)) diagnostics.push("Exact PR head SHA must be a lowercase 40-hex commit.");
	if (!SHA256.test(input.computedDiffSha256)) diagnostics.push("Computed PR diff digest must be a lowercase SHA-256.");
	if (!input.baseIsAncestor) {
		diagnostics.push(`Exact PR head ${input.headSha} does not contain immutable event base ${input.baseSha}. Rebase onto current dev and regenerate the verdict.`);
	}
	if (!input.fastGatePassed) {
		diagnostics.push("Repository fast gate failed. Run: bun scripts/verify-gjc-state-writers.ts --fail");
	}
	const selfReview = evaluateSelfReviewComment(input);
	if (parsed.verdict) {
		if (parsed.verdict.diffSha256 !== input.computedDiffSha256) {
			diagnostics.push(
				`Verdict digest ${parsed.verdict.diffSha256} is stale; exact ${input.baseSha}...${input.headSha} diff digest is ${input.computedDiffSha256}. Regenerate the verdict after the final commit.`,
			);
		}
		// merge-approved is the reviewed path: it ALWAYS requires an authenticated
		// exact-head APPROVED review from a distinct identity. The author cannot
		// reach it through any comment of their own (universal invariant).
		if (parsed.verdict.verdict === "merge-approved" && parsed.verdict.reviewerId.toLowerCase() === input.authorLogin.toLowerCase()) {
			diagnostics.push(`merge-approved cannot be self-approved: reviewer-id ${parsed.verdict.reviewerId} matches PR author ${input.authorLogin}. A solo merge is only available as the explicitly named merge-self-approved verdict for a low-risk owner change.`);
		}
		if (input.requireMergeApproved && parsed.verdict.verdict === "merge-approved") {
			if (!input.authenticatedReviewerLogin || input.authenticatedReviewerLogin.toLowerCase() !== parsed.verdict.reviewerId.toLowerCase()) {
				diagnostics.push(`merge-approved reviewer-id ${parsed.verdict.reviewerId} is not backed by an authenticated approving GitHub review.`);
			}
			if (input.authenticatedReviewHeadSha !== input.headSha) {
				diagnostics.push(`Authenticated approval must target exact PR head ${input.headSha}, not ${input.authenticatedReviewHeadSha ?? "a missing commit"}.`);
			}
		}
		// merge-self-approved is the honest solo path: it exists only for the repository
		// owner, only for low-risk, and only backed by the risk record comment bound to
		// this exact head. The name itself records that no independent human reviewed.
		if (parsed.verdict.verdict === "merge-self-approved") {
			if (parsed.verdict.reviewerId.toLowerCase() !== input.authorLogin.toLowerCase()) {
				diagnostics.push(`merge-self-approved reviewer-id ${parsed.verdict.reviewerId} must name the PR author ${input.authorLogin}; this verdict is exclusively the owner's self-authorization.`);
			}
			if (!selfReview.ok && !input.selfReviewUnavailable) {
				diagnostics.push(input.selfReviewFetched && !input.selfReviewComment
					? `No gajae.pr-self-review.v1 risk record comment from ${input.authorLogin || "the PR author"} was found on this PR; the merge-self-approved solo path requires one bound to the exact head.`
					: "merge-self-approved requires a valid gajae.pr-self-review.v1 risk record for the exact head (owner identity, low-risk classification, fresh base/head/digest).");
			} else if (selfReview.ok && (selfReview.risk !== "low-risk" || selfReview.verdict !== "merge-self-approved")) {
				diagnostics.push(`merge-self-approved requires the risk record to classify this change low-risk with verdict:merge-self-approved; record says risk:${selfReview.risk} verdict:${selfReview.verdict}. Higher risk classes must use independent review (merge-approved).`);
			}
		}
		if (input.requireMergeApproved && parsed.verdict.verdict !== "merge-approved" && parsed.verdict.verdict !== "merge-self-approved") {
			authorizationDiagnostics.push(`Verdict ${parsed.verdict.verdict} intentionally blocks merge. Obtain independent review (merge-approved) or, for a low-risk owner change, the explicit merge-self-approved path.`);
		}
	}
	diagnostics.push(...selfReview.diagnostics);
	const ok = diagnostics.length === 0;
	// Invariant: a malformed contract can never report an authorized merge.
	return { ok, verdict: parsed.verdict, diagnostics, mergeAuthorized: ok && authorizationDiagnostics.length === 0, authorizationDiagnostics };
}

/**
 * Evaluate the trusted maintainer self-review record (issue #4703, post-review
 * semantics). The record is the RISK CLASSIFICATION for an owner-authored PR: it
 * binds the author's own classification of the change to the exact base/head/digest.
 * Its hash is integrity-only (tamper evidence), never authorization.
 *
 * Returns ok=true only when a comment exists, is well-formed, carries a matching
 * integrity digest, comes from the owner identity, targets the exact event
 * base/head/digest, and satisfies the risk-classified policy (low-risk: extra:none;
 * regression-risk and high-risk: an authenticated exact-head APPROVED review from a
 * distinct maintainer named by extra:independent:<login>).
 * The PR body can never supply this record: evaluateSelfReviewComment reads only the
 * trusted comment data fetched from the GitHub API under workflow permissions.
 *
 * A record that could not be READ is reported as unread (issue #5483): the caller that
 * attempted the fetch supplies `selfReviewUnavailable`, and that message replaces every
 * claim about the record's content instead of implying it was judged invalid.
 */
function evaluateSelfReviewComment(input: PrValidationInput): { ok: boolean; reviewerId?: string; risk?: SelfReviewRisk; verdict?: "merge-approved" | "merge-self-approved" | "merge-blocked"; diagnostics: string[] } {
	const comment = input.selfReviewComment;
	if (!comment) {
		return { ok: false, diagnostics: input.selfReviewUnavailable
			? [`The gajae.pr-self-review.v1 risk record for this PR could not be read: ${input.selfReviewUnavailable}. It was never evaluated, so it has NOT been judged invalid.`]
			: [] };
	}
	const diagnostics: string[] = [];
	const parsedComment = parseSelfReview(comment.body);
	if (!parsedComment.selfReview) return { ok: false, diagnostics: parsedComment.diagnostics };
	const review = parsedComment.selfReview;
	// Delegated maintainer identity (issue #4703): only the repository owner account may
	// post the risk record; ordinary collaborators cannot.
	if (comment.authorAssociation !== "OWNER" || comment.login.toLowerCase() !== review.reviewerId.toLowerCase()) {
		diagnostics.push(`Self-review comment identity ${comment.login} (${comment.authorAssociation}) is not the repository owner matching reviewer-id ${review.reviewerId}.`);
	}
	if (review.verdict === "merge-blocked") {
		diagnostics.push("Self-review verdict merge-blocked does not authorize any merge.");
	}
	if (review.baseSha !== input.baseSha) {
		diagnostics.push(`Self-review base ${review.baseSha} is stale; immutable event base is ${input.baseSha}.`);
	}
	if (review.headSha !== input.headSha) {
		diagnostics.push(`Self-review head ${review.headSha} is stale; exact PR head is ${input.headSha}.`);
	}
	if (review.diffSha256 !== input.computedDiffSha256) {
		diagnostics.push(`Self-review digest ${review.diffSha256} is stale; exact ${input.baseSha}...${input.headSha} diff digest is ${input.computedDiffSha256}.`);
	}
	const expectedDigest = selfReviewSignature(selfReviewSignedPayload(review));
	if (review.signature !== expectedDigest) {
		diagnostics.push("Self-review integrity digest does not match the record; the record or evidence was altered.");
	}
	if (review.reviewerId.toLowerCase() !== input.authorLogin.toLowerCase()) {
		diagnostics.push(`Self-review reviewer-id ${review.reviewerId} must match the PR author ${input.authorLogin} for a maintainer self-review.`);
	}
	if (input.bodyRisk !== undefined && input.bodyRisk !== null && input.bodyRisk !== review.risk) {
		diagnostics.push(`Self-review risk ${review.risk} does not match the PR body risk classification ${input.bodyRisk}; the classifications must agree.`);
	}
	if (!selfReviewSatisfiesPolicy(review, input.independentReviewer ?? null) && !input.independentReviewerUnavailable) {
		// Three distinct situations, three distinct remedies. "No approval" sends the author
		// looking for a reviewer; a re-bound approval means the named reviewer already read
		// DIFFERENT code and must re-review this head; unreadable evidence means the gate
		// refused without being able to prove either. Collapsing the first two is what let me
		// tell two PR authors their only remaining step was flipping a verdict verb (#5692).
		const named = review.extra.kind === "independent" ? review.extra.login : review.extra.kind;
		const refused = input.independentReviewer?.refusedApproval;
		if (refused === "rebound") {
			diagnostics.push(`Self-review risk ${review.risk} names extra:independent:${named}, whose APPROVED review reports this exact head but was submitted BEFORE that head commit existed. GitHub re-pointed a stale review after a force-push, so it is not an approval of this code; a review submitted after the current head is required.`);
		} else if (refused === "unreadable") {
			diagnostics.push(`Self-review risk ${review.risk} names extra:independent:${named}, who has an APPROVED review bound to this head, but its freshness could not be established: the head commit date or the review submission time was unreadable. The approval is refused rather than assumed valid; re-run once the head commit is readable, or obtain a review submitted after the current head.`);
		} else {
			const required = "an authenticated exact-head approval from a distinct independent reviewer (extra:independent:<login>)";
			diagnostics.push(`Self-review risk ${review.risk} requires ${required} (extra:${named}); the risk-classified gate is not satisfied.`);
		}
	}
	if (review.extra.kind === "independent" && review.extra.login.toLowerCase() === input.authorLogin.toLowerCase()) {
		diagnostics.push(`Self-review extra:independent:${review.extra.login} names the PR author; the independent reviewer must be a distinct maintainer.`);
	}
	return { ok: diagnostics.length === 0, reviewerId: review.reviewerId, risk: review.risk, verdict: review.verdict, diagnostics };
}

export function canonicalDiffSha256(diff: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(diff).digest("hex");
}

interface PullRequestEvent {
	repository?: { full_name?: string };
	pull_request?: {
		number?: number;
		body?: string | null;
		user?: { login?: string };
		base?: { ref?: string; sha?: string; repo?: { full_name?: string } };
		head?: { sha?: string };
	};
	/** issue_comment events carry the PR under issue.number instead of pull_request. */
	issue?: { number?: number };
}

interface PullRequestReview {
	state?: string;
	commit_id?: string;
	user?: { login?: string };
	/** Needed to detect a `commit_id` re-pointed onto a newer head by a force-push (#5692). */
	submitted_at?: string;
}

interface CollaboratorPermission {
	permission?: string;
}

interface IssueComment {
	user?: { login?: string };
	author_association?: string;
	body?: string;
}

/**
 * Fetch every issue comment on the PR through the trusted workflow token and return the
 * newest comment that carries a self-review record from the eligible identity (the PR
 * author — the only login the self-review path can authorize). Only GitHub API data is
 * trusted: the PR body and head-controlled code are never parsed as a self-review source.
 * All pages are scanned before selecting the newest candidate so an old stale record
 * can never shadow a newer one; comments from other identities are ignored entirely so
 * an outsider's malformed or stale record cannot poison an independently reviewed PR.
 * Any API failure fails closed (issue #4703). `read` is false only when the caller's
 * authority was insufficient to read the list at all, so a caller never reports an
 * unread list as a PR with no record (issue #5483 review).
 */
async function fetchSelfReviewComment(event: PullRequestEvent, authorLogin: string): Promise<{ comment: AuthenticatedSelfReviewComment | null; read: boolean }> {
	const repository = event.repository?.full_name;
	const number = event.pull_request?.number;
	const token = Bun.env.GITHUB_TOKEN;
	if (!repository || !number || !token || !authorLogin) return { comment: null, read: false };
	let newest: AuthenticatedSelfReviewComment | null = null;
	for (let page = 1; ; page++) {
		const response = await fetch(`https://api.github.com/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!response.ok) throw new Error(`Issue comments API failed: ${response.status}; failing closed instead of skipping the self-review gate.`);
		const comments = await response.json() as IssueComment[];
		for (const comment of comments) {
			const record = authorSelfReviewRecord(comment, authorLogin);
			if (record) newest = record;
		}
		if (comments.length < 100) break;
	}
	return { comment: newest, read: true };
}

function issueCommentToSelfReview(comment: IssueComment): AuthenticatedSelfReviewComment | null {
	if (!comment || typeof comment !== "object") return null;
	const login = comment.user?.login;
	if (!login || typeof comment.body !== "string") return null;
	return { login, authorAssociation: comment.author_association ?? "NONE", body: comment.body };
}

/**
 * Map an issue comment onto the trusted self-review record it carries, or null when the
 * comment is not the author's own gajae.pr-self-review.v1 record. The server event path and
 * the local push preflight share this one predicate, so the two gates can never disagree
 * about which comment counts — the divergence that caused issue #5483. A comment from
 * another identity is ignored entirely, so an outsider's malformed or stale record cannot
 * poison an independently reviewed PR.
 */
function authorSelfReviewRecord(comment: IssueComment, authorLogin: string): AuthenticatedSelfReviewComment | null {
	const record = issueCommentToSelfReview(comment);
	if (!record) return null;
	if (record.login.toLowerCase() !== authorLogin.toLowerCase()) return null;
	if (!record.body.split(/\r?\n/u).some(line => line.trim().startsWith(SELF_REVIEW_PREFIX))) return null;
	return record;
}

/**
 * Parse the line-delimited JSON that `gh api --jq` emits (one compact result per line).
 * Bun.JSONL.parse returns the values parsed before a corrupt record and silently drops a
 * truncated trailing record, so the chunk parser is used instead: an incomplete or
 * malformed read must fail closed rather than look like a shorter, valid list.
 */
function parseGhJsonl<T>(output: string): { ok: true; values: T[] } | { ok: false; error: string } {
	if (!output.trim()) return { ok: true, values: [] };
	const parsed = Bun.JSONL.parseChunk(output, 0, output.length);
	if (parsed.error) return { ok: false, error: `the JSONL response could not be parsed (${parsed.error})` };
	if (!parsed.done) return { ok: false, error: "the JSONL response ended mid-record" };
	return { ok: true, values: parsed.values as T[] };
}

/**
 * Resolve the newest author-authored gajae.pr-self-review.v1 record comment through the
 * locally authenticated `gh api` surface. The push gate runs on a developer machine, so it
 * cannot rely on a workflow GITHUB_TOKEN; `--paginate` walks every page in the same
 * oldest-first order as the server's fetchSelfReviewComment, and the newest candidate wins
 * so an older stale record can never shadow a newer one. A null comment with no error means
 * the record genuinely is not on the PR; an error means the comment list could not be READ
 * (non-zero gh exit, or a truncated/malformed response), which the caller reports as a
 * retrieval failure instead of blaming an unevaluated record (issue #5483).
 */
async function fetchPushPreflightSelfReview(repo: string, number: number, authorLogin: string, cwd: string): Promise<{ comment: AuthenticatedSelfReviewComment | null; error: string | null }> {
	// The jq filter keeps the raw API comment shape so the shared issueCommentToSelfReview
	// mapper stays the single definition of a trusted record.
	const listed = await gh(["api", "--paginate", `repos/${repo}/issues/${number}/comments`, "--jq", ".[] | {user: {login: .user.login}, author_association: .author_association, body: .body}"], cwd);
	if (listed.exitCode !== 0) return { comment: null, error: listed.stderr || `gh exited ${listed.exitCode}` };
	const parsed = parseGhJsonl<IssueComment>(listed.stdout);
	if (!parsed.ok) return { comment: null, error: parsed.error };
	let newest: AuthenticatedSelfReviewComment | null = null;
	for (const comment of parsed.values) {
		const record = authorSelfReviewRecord(comment, authorLogin);
		if (record) newest = record;
	}
	return { comment: newest, error: null };
}

/** A review as `gh api --jq '.[] | {author: {login: .user.login}, state, commit: {oid: .commit_id}, submittedAt: .submitted_at}'` emits it. */
interface LiveReview {
	author: { login: string } | null;
	state: string;
	commit: { oid: string } | null;
	/** Detects a `commit_id` re-pointed onto a newer head by a force-push (#5692). */
	submittedAt: string | null;
}

/**
 * Resolve the trusted evidence a risk-classified self-review record's
 * `extra:independent:<login>` names: an authenticated exact-head APPROVED review from that
 * login plus its repository permission, mirroring the server's
 * fetchIndependentReviewerEvidence so a legitimate risk-classified push is not rejected
 * locally for evidence the server would have supplied (issue #5483 review). Reviews are
 * paginated so an approval beyond the first page cannot be missed, and a read failure is
 * returned as an error so the caller can report it as unread instead of unauthorized.
 */
async function fetchPushPreflightIndependentReviewer(repo: string, number: number, login: string, headSha: string, cwd: string): Promise<{ evidence: IndependentReviewerEvidence | null; error: string | null }> {
	const listed = await gh(["api", "--paginate", `repos/${repo}/pulls/${number}/reviews`, "--jq", ".[] | {author: {login: .user.login}, state, commit: {oid: .commit_id}, submittedAt: .submitted_at}"], cwd);
	if (listed.exitCode !== 0) return { evidence: null, error: listed.stderr || `gh exited ${listed.exitCode}` };
	const parsed = parseGhJsonl<LiveReview>(listed.stdout);
	if (!parsed.ok) return { evidence: null, error: parsed.error };
	const normalized = parsed.values.map(review => ({
		login: review.author?.login,
		state: review.state,
		oid: review.commit?.oid,
		submittedAt: review.submittedAt ?? undefined,
	}));
	// The head's committer date is contributor-controlled (`GIT_COMMITTER_DATE`), so it is
	// a floor, not authority. The authority is the PR timeline's force-push events, whose
	// `created_at` GitHub writes (#5692 review).
	const headDate = await git(["show", "-s", "--format=%cI", headSha], cwd);
	const committedAt = headDate.exitCode === 0 ? Buffer.from(headDate.stdout).toString().trim() || undefined : undefined;
	const forcePushedAt = await gh(
		["api", "--paginate", `repos/${repo}/issues/${number}/timeline`, "--jq", '.[] | select(.event=="head_ref_force_pushed") | (.created_at // "unreadable")'],
		cwd,
	);
	if (forcePushedAt.exitCode !== 0)
		return { evidence: null, error: forcePushedAt.stderr || `gh exited ${forcePushedAt.exitCode}` };
	// The projection emits a literal "unreadable" for an event with no `created_at`, so a
	// present-but-unusable force-push cannot masquerade as an empty line (#5692 review).
	// Drop line-splitting artifacts only. A genuinely absent `created_at` already arrives
	// as the literal "unreadable" from the projection, so blank lines here are never
	// missing data and must not be mistaken for it.
	const headKnownAt = latestKnownHeadTime(
		committedAt,
		forcePushedAt.stdout.split("\n").filter(line => line.trim().length > 0),
	);
	const approvedHead = effectiveExactHeadReview(normalized, login, headSha, headKnownAt)?.state === "APPROVED";
	const permission = await gh(["api", `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, "--jq", ".permission"], cwd);
	if (permission.exitCode !== 0) return { evidence: null, error: permission.stderr || `gh exited ${permission.exitCode}` };
	return {
		evidence: {
			permission: permission.stdout.trim(),
			approvedHead,
			approvedLogin: login,
			...(approvedHead ? {} : refusedApprovalField(normalized, login, headSha, headKnownAt)),
		},
		error: null,
	};
}

export async function authenticatedApproval(event: PullRequestEvent, reviewerId: string, headSha: string, token = Bun.env.GITHUB_TOKEN): Promise<{ login?: string; headSha?: string }> {
	const repository = event.repository?.full_name;
	const number = event.pull_request?.number;
	if (!repository || !number || !token) return {};
	const reviews: PullRequestReview[] = [];
	for (let page = 1; ; page++) {
		const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}/reviews?per_page=100&page=${page}`, {
			headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!response.ok) return {};
		const pageReviews = await response.json() as PullRequestReview[];
		reviews.push(...pageReviews);
		if (pageReviews.length < 100) break;
	}
	// Normalize BEFORE the head-date call so a malformed review response still fails on the
	// reviews payload rather than spending an extra API request first.
	const normalized = reviews.map(review => ({
		login: review.user?.login,
		state: review.state,
		oid: review.commit_id,
		submittedAt: review.submitted_at,
	}));
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const headKnownAt = await fetchHeadKnownAt(repository, number, headSha, headers);
	const approval = effectiveExactHeadReview(normalized, reviewerId, headSha, headKnownAt);
	if (approval?.state !== "APPROVED") return {};
	const permissionResponse = await fetch(`https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(reviewerId)}/permission`, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!permissionResponse.ok) return {};
	const collaborator = await permissionResponse.json() as CollaboratorPermission;
	if (!new Set(["admin", "maintain", "write"]).has(collaborator.permission ?? "")) return {};
	return { login: approval.login, headSha: approval.oid };
}

/**
 * Resolve trusted GitHub evidence for the independent reviewer named by a self-review
 * extra:independent:<login> token: collaborator permission plus the EFFECTIVE review on the
 * exact PR head — the latest non-COMMENTED review from that login, so a later
 * CHANGES_REQUESTED supersedes an earlier APPROVED exactly as it does for a merge-approved
 * verdict (issue #4703 hardening, extended after the push preflight mirrored this lookup).
 */
/**
 * Earliest time the PR head is PROVEN to have existed, from server-observed data.
 *
 * The commit's committer date is contributor-controlled (`GIT_COMMITTER_DATE`), so on its
 * own it is not authority: backdating it would make a stale approval look fresh. GitHub
 * writes the PR timeline's `head_ref_force_pushed.created_at`, and a force-push is exactly
 * what re-points `commit_id` onto a new head, so the latest one is a trustworthy floor.
 *
 * Returns the later of the two, and `undefined` when neither can be read — which every
 * caller treats as "cannot prove freshness" and therefore refuses (#5692 review).
 */
async function fetchHeadKnownAt(
	repository: string,
	number: number,
	headSha: string,
	headers: Record<string, string>,
): Promise<string | undefined> {
	const commit = await fetch(`https://api.github.com/repos/${repository}/commits/${headSha}`, { headers });
	const committedAt = commit.ok
		? ((await commit.json()) as { commit?: { committer?: { date?: string } } }).commit?.committer?.date
		: undefined;
	// Paginate: timeline events are returned oldest-first, so reading only the first page
	// would miss the MOST RECENT force-push on a busy PR — exactly the one that re-bound
	// the review. A page that cannot be read refuses rather than truncating the evidence.
	const forcePushes: Array<string | undefined> = [];
	for (let page = 1; ; page++) {
		const timeline = await fetch(
			`https://api.github.com/repos/${repository}/issues/${number}/timeline?per_page=100&page=${page}`,
			{ headers },
		);
		if (!timeline.ok) return undefined;
		const events = (await timeline.json()) as Array<{ event?: string; created_at?: string }>;
		for (const entry of events) if (entry.event === "head_ref_force_pushed") forcePushes.push(entry.created_at);
		if (events.length < 100) break;
	}
	return latestKnownHeadTime(committedAt, forcePushes);
}

export async function fetchIndependentReviewerEvidence(event: PullRequestEvent, login: string, headSha: string): Promise<IndependentReviewerEvidence> {
	const repository = event.repository?.full_name;
	const number = event.pull_request?.number;
	const token = Bun.env.GITHUB_TOKEN;
	if (!repository || !number || !token) return { permission: "none", approvedHead: false };
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const reviews: PullRequestReview[] = [];
	for (let page = 1; ; page++) {
		const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}/reviews?per_page=100&page=${page}`, { headers });
		if (!response.ok) throw new Error(`Reviews API failed for the independent reviewer: ${response.status}; failing closed.`);
		const pageReviews = await response.json() as PullRequestReview[];
		reviews.push(...pageReviews);
		if (pageReviews.length < 100) break;
	}
	const normalized = reviews.map(review => ({
		login: review.user?.login,
		state: review.state,
		oid: review.commit_id,
		submittedAt: review.submitted_at,
	}));
	const headKnownAt = await fetchHeadKnownAt(repository, number, headSha, headers);
	const approved = effectiveExactHeadReview(normalized, login, headSha, headKnownAt)?.state === "APPROVED";
	const permissionResponse = await fetch(`https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`, { headers });
	if (!permissionResponse.ok) throw new Error(`Independent reviewer permission lookup failed: ${permissionResponse.status}; failing closed.`);
	const collaborator = await permissionResponse.json() as CollaboratorPermission;
	return {
		permission: collaborator.permission ?? "none",
		approvedHead: approved,
		approvedLogin: login,
		...(approved ? {} : refusedApprovalField(normalized, login, headSha, headKnownAt)),
	};
}

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: Uint8Array; stderr: string }> {
	const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).bytes(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { exitCode, stdout, stderr: stderr.trim() };
}

async function runFastGate(cwd: string, trustedRoot: string): Promise<boolean> {
	const configPath = path.join(Bun.env.RUNNER_TEMP ?? Bun.env.TMPDIR ?? "/tmp", "gjc-pr-contract-empty-bunfig.toml");
	await Bun.write(configPath, "# trusted empty Bun configuration\n");
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.BUN_OPTIONS;
	const child = Bun.spawn([
		process.execPath,
		"--no-env-file",
		`--config=${configPath}`,
		path.join(trustedRoot, "scripts", "verify-gjc-state-writers.ts"),
		"--fail",
		"--root",
		cwd,
	], { cwd: trustedRoot, env, stdout: "inherit", stderr: "inherit" });
	return (await child.exited) === 0;
}

async function runPushedTreeFastGate(cwd: string, trustedRoot: string, headSha: string): Promise<boolean> {
	const tree = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-pushed-tree-"));
	try {
		const listed = await git(["ls-tree", "-r", "-z", "--full-tree", headSha, "--", "packages/coding-agent/src"], cwd);
		if (listed.exitCode !== 0) return false;
		const files: { oid: string; name: string }[] = [];
		const treeRoot = path.resolve(tree);
		for (const entry of new TextDecoder("utf-8", { fatal: true }).decode(listed.stdout).split("\0").filter(Boolean)) {
			const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/u.exec(entry);
			if (!match) return false;
			// Unsupported source entries must not disappear from the scan or escape it.
			if (match[1] === "120000" || match[1] === "160000" || match[2] !== "blob") return false;
			const name = match[4]!;
			// Git stores slash-separated names, but a backslash becomes a path separator
			// on Windows. Reject it before host-native joining so a pushed Git name such
			// as `src/..\\escaped.ts` can never leave the staging root.
			if (name.includes("\\") || !name.startsWith("packages/coding-agent/src/") || name.split("/").some(part => !part || part === "." || part === "..")) return false;
			const target = path.resolve(tree, name);
			const relativeTarget = path.relative(treeRoot, target);
			if (!relativeTarget || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) return false;
			files.push({ oid: match[3]!, name });
		}
		await fs.mkdir(path.join(tree, "packages/coding-agent/src"), { recursive: true });
		// Raw blobs bypass export-ignore/export-subst, checkout filters and dirty files.
		const batch = Bun.spawn(["git", "cat-file", "--batch"], {
			cwd, stdin: new Blob([files.map(file => `${file.oid}\n`).join("")]), stdout: "pipe", stderr: "pipe",
		});
		const [bytes, , exitCode] = await Promise.all([new Response(batch.stdout).bytes(), new Response(batch.stderr).text(), batch.exited]);
		if (exitCode !== 0) return false;
		let offset = 0;
		for (const file of files) {
			const end = bytes.indexOf(10, offset);
			if (end < 0) return false;
			const header = new TextDecoder().decode(bytes.subarray(offset, end));
			const match = /^([0-9a-f]{40}) blob ([0-9]+)$/u.exec(header);
			if (!match || match[1] !== file.oid) return false;
			const size = Number(match[2]);
			offset = end + 1;
			if (!Number.isSafeInteger(size) || size > bytes.length - offset - 1 || bytes[offset + size] !== 10) return false;
			const target = path.join(tree, file.name);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, bytes.subarray(offset, offset + size), { flag: "wx" });
			offset += size + 1;
		}
		if (offset !== bytes.length) return false;
		return await runFastGate(tree, trustedRoot);
	} catch (error) {
		console.error(`Could not materialize pushed source tree: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	} finally {
		await fs.rm(tree, { recursive: true, force: true });
	}
}

/**
 * Comment events resolve their PR through the authenticated API as before.
 * Review events refresh only mutable body text: every captured authority binding
 * must still match. A rerun must never validate a different source or target.
 */
export async function resolvePullRequestEvent(
	event: PullRequestEvent,
	eventName = Bun.env.GITHUB_EVENT_NAME,
	token = Bun.env.GITHUB_TOKEN,
	request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<PullRequestEvent> {
	const refreshBody = eventName === "pull_request_review";
	if (event.pull_request && !refreshBody) return event;
	const captured = event.pull_request;
	const repository = event.repository?.full_name;
	const number = refreshBody ? captured?.number : event.issue?.number;
	if (refreshBody && (
		!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
		!Number.isSafeInteger(number) || !number || number < 1 || !token ||
		!captured?.user?.login || !captured.base?.ref ||
		captured.base.repo?.full_name !== repository ||
		!SHA40.test(captured.base.sha ?? "") || !SHA40.test(captured.head?.sha ?? "")
	)) throw new Error("Review event PR authority is incomplete; failing closed.");
	if (!repository || !number || !token) return event;
	const response = await request(`https://api.github.com/repos/${repository}/pulls/${number}`, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!response.ok) {
		if (refreshBody) throw new Error(`Review event PR refresh failed: ${response.status}; failing closed.`);
		return event;
	}
	const pr = await response.json() as NonNullable<PullRequestEvent["pull_request"]>;
	if (refreshBody) {
		if (!pr || typeof pr !== "object" || Array.isArray(pr) ||
			(pr.body !== null && typeof pr.body !== "string") ||
			pr.number !== number || pr.base?.repo?.full_name !== repository ||
			pr.user?.login !== captured!.user!.login ||
			pr.base?.ref !== captured!.base!.ref || pr.base?.sha !== captured!.base!.sha ||
			pr.head?.sha !== captured!.head!.sha
		) throw new Error("Review event PR authority drift or malformed live metadata; failing closed.");
		return { ...event, pull_request: { ...captured, body: pr.body } };
	}
	return {
		...event,
		pull_request: { number, body: pr.body, user: pr.user, base: pr.base, head: pr.head },
	};
}

async function validateEvent(eventPath: string, cwd: string, trustedRoot: string): Promise<PrValidationResult> {
	const rawEvent = (await Bun.file(eventPath).json()) as PullRequestEvent;
	const event = await resolvePullRequestEvent(rawEvent);
	const pr = event.pull_request;
	if (!pr) return contractResult(false, ["GitHub event payload does not contain pull_request data."]);
	const body = pr.body ?? "";
	const authorLogin = pr.user?.login ?? "";
	const baseRef = pr.base?.ref ?? "";
	const baseSha = pr.base?.sha ?? "";
	const headSha = pr.head?.sha ?? "";
	if (!SHA40.test(baseSha) || !SHA40.test(headSha)) {
		return validatePrContract({ body, authorLogin, baseRef, baseSha, headSha, computedDiffSha256: "", baseIsAncestor: false, fastGatePassed: false });
	}
	const checkedOut = await git(["rev-parse", "HEAD"], cwd);
	if (checkedOut.exitCode !== 0 || new TextDecoder().decode(checkedOut.stdout).trim() !== headSha) {
		return contractResult(false, [`Checked-out source must equal exact PR head ${headSha}.` ]);
	}
	const fetchBase = await git(["fetch", "--no-tags", trustedRoot, baseSha], cwd);
	if (fetchBase.exitCode !== 0) return contractResult(false, [`Could not fetch immutable PR base ${baseSha}: ${fetchBase.stderr}`]);
	const ancestry = await git(["merge-base", "--is-ancestor", baseSha, headSha], cwd);
	const diff = await git(["diff", "--binary", "--full-index", "--no-ext-diff", `${baseSha}...${headSha}`], cwd);
	if (diff.exitCode !== 0) return contractResult(false, [`Could not compute exact PR diff: ${diff.stderr}`]);
	const parsed = parsePrVerdict(body);
	const approval = parsed.verdict?.verdict === "merge-approved"
		? await authenticatedApproval(event, parsed.verdict.reviewerId, headSha)
		: {};
	// The self-review record is fetched whenever the verdict names the author (the
	// merge-self-approved solo path) or the body verdict is merge-approved with a
	// self-review record expected to carry the risk classification.
	const selfReviewNamedByAuthor = Boolean(parsed.verdict && parsed.verdict.reviewerId.toLowerCase() === authorLogin.toLowerCase());
	const fetchedSelfReview = selfReviewNamedByAuthor
		? await fetchSelfReviewComment(event, authorLogin)
		: { comment: null, read: false };
	const bodyRiskParsed = parseBodyRisk(body);
	const bodyRisk = bodyRiskParsed.risk;
	const independentLogin = fetchedSelfReview.comment ? independentReviewerLogin(fetchedSelfReview.comment.body) : null;
	const independentReviewer = independentLogin && fetchedSelfReview.comment?.login.toLowerCase() === authorLogin.toLowerCase()
		? await fetchIndependentReviewerEvidence(event, independentLogin, headSha)
		: null;
	const result = validatePrContract({
		body,
		baseRef,
		baseSha,
		headSha,
		authorLogin,
		computedDiffSha256: canonicalDiffSha256(diff.stdout),
		baseIsAncestor: ancestry.exitCode === 0,
		fastGatePassed: await runFastGate(cwd, trustedRoot),
		authenticatedReviewerLogin: approval.login,
		authenticatedReviewHeadSha: approval.headSha,
		requireMergeApproved: true,
		selfReviewComment: fetchedSelfReview.comment,
		selfReviewFetched: fetchedSelfReview.read,
		bodyRisk,
		independentReviewer,
	});
	return { ...result, diagnostics: [...bodyRiskParsed.diagnostics, ...result.diagnostics] };
}

/**
 * Parse the risk classification declared in the PR body's Risk classification section.
 * Exactly one class must be checked: zero or multiple checked boxes fail closed
 * (review finding 3 — a missing classification must not waive the stricter tiers),
 * and the self-review record must declare the same risk.
 */
export function parseBodyRisk(body: string): { risk: string | null; diagnostics: string[] } {
	const checked = body
		.split(/\r?\n/u)
		.map(line => line.trim())
		.filter(line => /^-\s*\[(x|X)\]\s*`(low-risk|regression-risk|high-risk)`/u.test(line));
	if (checked.length === 0) {
		return { risk: null, diagnostics: ["PR body must check exactly one risk classification (low-risk, regression-risk, or high-risk); found none."] };
	}
	if (checked.length > 1) {
		return { risk: null, diagnostics: [`PR body must check exactly one risk classification; found ${checked.length}.`] };
	}
	const match = /`(low-risk|regression-risk|high-risk)`/u.exec(checked[0]!);
	return { risk: match?.[1] ?? null, diagnostics: match ? [] : ["PR body risk classification line is malformed."] };
}

/** Extract the independent reviewer login from a self-review comment, if any. */
function independentReviewerLogin(commentBody: string): string | null {
	const parsedComment = parseSelfReview(commentBody);
	return parsedComment.selfReview?.extra.kind === "independent" ? parsedComment.selfReview.extra.login : null;
}

function shellWords(command: string): string[] | null {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (const char of command) {
		if (escaped) { word += char; escaped = false; continue; }
		if (char === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote) { if (char === quote) quote = null; else word += char; continue; }
		if (char === "'" || char === '"') { quote = char; continue; }
		if (/\s/u.test(char)) { if (word) { words.push(word); word = ""; } continue; }
		if (";&|`()<>".includes(char)) return null;
		word += char;
	}
	if (escaped || quote) return null;
	if (word) words.push(word);
	return words;
}

export function parseGhPrCreate(command: string): { bodyFile?: string; body?: string; base?: string } | null {
	const words = shellWords(command);
	if (!words) return /(?:^|\s)gh\s+pr\s+create(?:\s|$)/u.test(command) ? {} : null;
	const gh = words.findIndex((word, index) => word === "gh" && words[index + 1] === "pr" && words[index + 2] === "create");
	if (gh < 0) return null;
	const result: { bodyFile?: string; body?: string; base?: string } = {};
	for (let i = gh + 3; i < words.length; i++) {
		const word = words[i]!;
		const next = words[i + 1];
		if ((word === "--body-file" || word === "-F") && next) { result.bodyFile = next; i++; }
		else if (word.startsWith("--body-file=")) result.bodyFile = word.slice("--body-file=".length);
		else if ((word === "--body" || word === "-b") && next) { result.body = next; i++; }
		else if (word.startsWith("--body=")) result.body = word.slice("--body=".length);
		else if ((word === "--base" || word === "-B") && next) { result.base = next; i++; }
		else if (word.startsWith("--base=")) result.base = word.slice("--base=".length);
	}
	return result;
}

async function validatePreflight(command: string, cwd: string, trustedRoot: string, invocationCwd: string): Promise<PrValidationResult> {
	const parsed = parseGhPrCreate(command);
	if (parsed === null) return contractResult(true, []);
	if (!parsed.bodyFile && parsed.body === undefined) return contractResult(false, ["gh pr create must provide --body-file or --body so the PR verdict can be validated before submission."]);
	let body = parsed.body!;
	if (parsed.bodyFile) {
		const bodyPath = path.resolve(invocationCwd, parsed.bodyFile);
		try {
			body = await Bun.file(bodyPath).text();
		} catch (error) {
			return contractResult(false, [`Could not read PR body file ${bodyPath}: ${error instanceof Error ? error.message : String(error)}`]);
		}
	}
	const baseRef = parsed.base ?? "dev";
	const refreshBase = await git(["fetch", "--no-tags", "origin", "dev"], cwd);
	if (refreshBase.exitCode !== 0) {
		return contractResult(false, [`Could not refresh origin/dev before PR preflight: ${refreshBase.stderr}. Run git fetch origin dev and retry.`]);
	}
	const base = await git(["rev-parse", "origin/dev"], cwd);
	const head = await git(["rev-parse", "HEAD"], cwd);
	const baseSha = new TextDecoder().decode(base.stdout).trim();
	const headSha = new TextDecoder().decode(head.stdout).trim();
	const author = Bun.env.GITHUB_ACTOR ?? Bun.env.USER ?? "unknown";
	const ancestry = SHA40.test(baseSha) && SHA40.test(headSha) ? await git(["merge-base", "--is-ancestor", baseSha, headSha], cwd) : { exitCode: 1 };
	const diff = SHA40.test(baseSha) && SHA40.test(headSha) ? await git(["diff", "--binary", "--full-index", "--no-ext-diff", `${baseSha}...${headSha}`], cwd) : { exitCode: 1, stdout: new Uint8Array(), stderr: "invalid git revisions" };
	return validatePrContract({ body, baseRef, baseSha, headSha, authorLogin: author, computedDiffSha256: diff.exitCode === 0 ? canonicalDiffSha256(diff.stdout) : "", baseIsAncestor: ancestry.exitCode === 0, fastGatePassed: await runFastGate(cwd, trustedRoot), requireMergeApproved: false });
}

async function gh(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["gh", ...args], { cwd, env: { ...process.env, GH_HOST: "github.com" }, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr: stderr.trim() };
}

interface LivePullRequest {
	number: number;
	body: string | null;
	base: { ref: string };
	user: { login: string } | null;
	head: { ref: string; repo: { owner: { login: string } } | null };
}

/**
 * Resolve the GitHub `owner/repo` actually receiving the push. A fork checkout's `origin`
 * is the fork while the open PR lives upstream, so the implicit `gh` context would query
 * the wrong repository (or none) and wave the push through.
 */
async function pushRemoteRepository(remote: string, cwd: string, destination?: string): Promise<string | null> {
	let text = destination ?? remote;
	if (destination === undefined && !remote.includes(":")) {
		const url = await git(["remote", "get-url", "--push", "--all", remote], cwd);
		if (url.exitCode !== 0) return null;
		text = new TextDecoder().decode(url.stdout).trim();
	}
	// Only github.com is authenticated by the gh calls below. Unknown hosts, paths,
	// and multiple configured push destinations must never inherit that authority.
	const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(text);
	return match && match[2] !== "." && match[2] !== ".." ? `${match[1]}/${match[2]}` : null;
}

/**
 * The repository whose PRs govern a push to `pushRepo`. Pushing a fork branch opens the
 * PR upstream, so a fork resolves to its parent; a non-fork is its own authority.
 */
async function contractRepository(pushRepo: string, cwd: string): Promise<{ repo: string; forkOwner: string | null } | null> {
	const viewed = await gh(["repo", "view", pushRepo, "--json", "isFork,parent"], cwd);
	if (viewed.exitCode !== 0) return null;
	try {
		const info = JSON.parse(viewed.stdout) as { isFork?: boolean; parent?: { owner?: { login?: string }; name?: string } | null };
		if (info.isFork === false) return { repo: pushRepo, forkOwner: null };
		if (info.isFork !== true) return null;
		const parentOwner = info.parent?.owner?.login;
		const parentName = info.parent?.name;
		if (typeof parentOwner !== "string" || !/^[A-Za-z0-9-]+$/u.test(parentOwner)
			|| typeof parentName !== "string" || !/^[A-Za-z0-9_.-]+$/u.test(parentName)
			|| parentName === "." || parentName === "..") return null;
		return { repo: `${parentOwner}/${parentName}`, forkOwner: pushRepo.split("/")[0]! };
	} catch {
		return null;
	}
}

/** Validate local contract structure and exact pushed bytes, not merge authorization. */
async function validatePushPreflight(branch: string, headSha: string, remote: string, cwd: string, trustedRoot: string, destination?: string): Promise<PrValidationResult> {
	if (!SHA40.test(headSha)) return contractResult(false, [`Pushed commit ${headSha} is not a lowercase 40-hex commit.`]);
	const pushRepo = await pushRemoteRepository(remote, cwd, destination);
	if (!pushRepo) return contractResult(false, [`Could not resolve the GitHub repository behind push remote ${remote}; refusing to validate against an unknown repository.`]);
	// A fork push opens its PR upstream, so the contract lives in the parent repository.
	const authority = await contractRepository(pushRepo, cwd);
	if (!authority) return contractResult(false, [`Could not establish the PR contract repository for ${pushRepo}; repository fork metadata must identify an explicit non-fork or a valid parent.`]);
	const { repo: baseRepo, forkOwner } = authority;
	// The head is qualified by the owner actually receiving the push, so a same-named
	// branch in another fork can never be mistaken for this PR.
	const headOwner = forkOwner ?? pushRepo.split("/")[0]!;
	const candidates: LivePullRequest[] = [];
	// REST pagination is supported by older gh releases. Explicit pages avoid relying
	// on newer --slurp support or parsing concatenated JSON documents from --paginate.
	for (let page = 1; ; page++) {
		const endpoint = `repos/${baseRepo}/pulls?state=open&head=${encodeURIComponent(`${headOwner}:${branch}`)}&per_page=100&page=${page}`;
		const listed = await gh(["api", endpoint], cwd);
		if (listed.exitCode !== 0) return contractResult(false, [`Could not resolve the open PR for ${branch} in ${baseRepo}: ${listed.stderr || `gh exited ${listed.exitCode}`}.`]);
		let pulls: LivePullRequest[];
		try {
			const parsed: unknown = JSON.parse(listed.stdout);
			if (!Array.isArray(parsed) || parsed.some(pr => !pr || !Number.isInteger(pr.number)
				|| typeof pr.head?.ref !== "string" || typeof pr.head?.repo?.owner?.login !== "string"
				|| typeof pr.base?.ref !== "string" || (pr.body !== null && typeof pr.body !== "string")
				|| typeof pr.user?.login !== "string")) throw new Error("Malformed pull request metadata");
			pulls = parsed;
		} catch (error) {
			return contractResult(false, [`Could not parse the pull request response for ${branch}: ${error instanceof Error ? error.message : String(error)}`]);
		}
		candidates.push(...pulls.filter(pr => pr.head.ref === branch && pr.head.repo?.owner.login.toLowerCase() === headOwner.toLowerCase()));
		if (pulls.length < 100) break;
	}
	if (candidates.length > 1) {
		return contractResult(false, [`Branch ${branch} matches ${candidates.length} open PRs in ${baseRepo} from ${headOwner} (#${candidates.map(candidate => candidate.number).join(", #")}); cannot determine which contract governs this push.`]);
	}
	const pr = candidates[0];
	if (!pr) return contractResult(true, []);
	// The base is the repository the PR was queried in -- for a fork push that is the
	// upstream, never the contributor's local origin/dev. The ref is the PR's own base
	// branch rather than an assumed "dev".
	const baseRemoteUrl = `https://github.com/${baseRepo}.git`;
	const refreshBase = await git(["fetch", "--no-tags", baseRemoteUrl, pr.base.ref], cwd);
	if (refreshBase.exitCode !== 0) {
		return contractResult(false, [`Could not fetch the PR base ${baseRepo}#${pr.base.ref} before the push preflight: ${refreshBase.stderr}`]);
	}
	const base = await git(["rev-parse", "FETCH_HEAD"], cwd);
	const baseSha = new TextDecoder().decode(base.stdout).trim();
	if (!SHA40.test(baseSha)) return contractResult(false, [`Could not resolve ${baseRepo}#${pr.base.ref} to a commit: ${base.stderr}`]);
	const ancestry = await git(["merge-base", "--is-ancestor", baseSha, headSha], cwd);
	const diff = await git(["diff", "--binary", "--full-index", "--no-ext-diff", `${baseSha}...${headSha}`], cwd);
	if (diff.exitCode !== 0) return contractResult(false, [`Could not compute the exact ${baseSha}...${headSha} diff: ${diff.stderr}`]);
	const body = pr.body ?? "";
	const bodyRiskParsed = parseBodyRisk(body);
	const authorLogin = pr.user?.login ?? "";
	// The self-review record is the merge-self-approved authority and lives in a PR
	// comment, never in the body, so the local gate must fetch exactly the record the
	// server reads before it can judge the owner's solo path (issue #5483).
	const parsedVerdict = parsePrVerdict(body).verdict;
	// The record is fetched only where it can matter: the owner's solo path always needs it,
	// and a regression/high-risk body needs its risk classification and independent-review
	// evidence. A low-risk blocking verdict has nothing to judge, so a stale or unreadable
	// record comment must not reject a push the local contract otherwise allows.
	const selfReviewNamedByAuthor = Boolean(parsedVerdict && authorLogin && parsedVerdict.reviewerId.toLowerCase() === authorLogin.toLowerCase());
	const selfReviewNeeded = selfReviewNamedByAuthor
		&& (parsedVerdict?.verdict === "merge-self-approved" || (bodyRiskParsed.risk !== null && bodyRiskParsed.risk !== "low-risk"));
	const selfReview = selfReviewNeeded
		? await fetchPushPreflightSelfReview(baseRepo, pr.number, authorLogin, cwd)
		: { comment: null, error: null };
	// A risk-classified record names the maintainer whose exact-head approval the policy
	// verifies, so the local gate must resolve that evidence too; otherwise a legitimate
	// risk-classified push is rejected for evidence the server would have supplied.
	const independentLogin = selfReview.comment ? independentReviewerLogin(selfReview.comment.body) : null;
	const independent = independentLogin
		? await fetchPushPreflightIndependentReviewer(baseRepo, pr.number, independentLogin, headSha, cwd)
		: { evidence: null, error: null };
	const result = validatePrContract({
		body,
		baseRef: pr.base.ref,
		baseSha,
		headSha,
		authorLogin,
		selfReviewComment: selfReview.comment,
		selfReviewUnavailable: selfReview.error,
		selfReviewFetched: selfReviewNeeded && selfReview.error === null,
		independentReviewer: independent.evidence,
		independentReviewerUnavailable: independent.error !== null,
		computedDiffSha256: canonicalDiffSha256(diff.stdout),
		baseIsAncestor: ancestry.exitCode === 0,
		fastGatePassed: await runPushedTreeFastGate(cwd, trustedRoot, headSha),
		bodyRisk: bodyRiskParsed.risk,
		requireMergeApproved: false,
	});
	const diagnostics = [...bodyRiskParsed.diagnostics, ...result.diagnostics];
	if (independentLogin && independent.error) {
		diagnostics.push(`Could not read the independent-review evidence for ${independentLogin} on ${baseRepo}#${pr.number}: ${independent.error}. The evidence was never read, so the reviewer has NOT been judged unauthorized.`);
	}
	if (diagnostics.length > 0) {
		diagnostics.push(`Local push contract failed for ${baseRepo}#${pr.number}; the exact ${baseSha}...${headSha} digest is ${canonicalDiffSha256(diff.stdout)}. Merge authorization remains a separate server check.`);
		if (selfReview.error) {
			// A local retrieval failure does not predict the server check, which reads the
			// comments with its own token, so say so instead of implying the record is bad.
			diagnostics.push(`Re-run the push once \`gh api\` can read the ${SELF_REVIEW_PREFIX} record for ${baseRepo}#${pr.number}, or push with GJC_SKIP_PR_PREFLIGHT=1 (or --no-verify) while the change is still awaiting review.`);
		}
	}
	return contractResult(diagnostics.length === 0, diagnostics, result.verdict);
}

/**
 * Which verdict decides this invocation's exit code. `all` is the default every existing
 * caller keeps: one exit code covering the contract AND the merge authorization, exactly as
 * before the split. `contract` and `approval` each report one half under its own check name.
 */
export type GateMode = "all" | "contract" | "approval";

export const MERGE_AUTHORIZED_OUTPUT = "gjc-merge-authorized";

export function gateExitCode(gate: GateMode, result: Pick<PrValidationResult, "ok" | "mergeAuthorized">): number {
	switch (gate) {
		case "contract":
			return result.ok ? 0 : 1;
		case "approval":
			return result.mergeAuthorized ? 0 : 1;
		case "all":
			return result.ok && result.mergeAuthorized ? 0 : 1;
	}
}

export async function main(argv: string[]): Promise<number> {
	const repoIndex = argv.indexOf("--repo");
	const trustedRootIndex = argv.indexOf("--trusted-root");
	const invocationCwdIndex = argv.indexOf("--invocation-cwd");
	const cwd = path.resolve(process.cwd(), repoIndex >= 0 && argv[repoIndex + 1] ? argv[repoIndex + 1]! : ".");
	const trustedRoot = path.resolve(process.cwd(), trustedRootIndex >= 0 && argv[trustedRootIndex + 1] ? argv[trustedRootIndex + 1]! : ".");
	const invocationCwd = path.resolve(process.cwd(), invocationCwdIndex >= 0 && argv[invocationCwdIndex + 1] ? argv[invocationCwdIndex + 1]! : cwd);
	const eventIndex = argv.indexOf("--event");
	const preflightIndex = argv.indexOf("--preflight-command");
	const pushIndex = argv.indexOf("--push-preflight");
	const pushRemoteIndex = argv.indexOf("--push-remote");
	const pushRemote = pushRemoteIndex >= 0 && argv[pushRemoteIndex + 1] ? argv[pushRemoteIndex + 1]! : "origin";
	const pushUrlIndex = argv.indexOf("--push-url");
	const pushUrl = pushUrlIndex >= 0 ? argv[pushUrlIndex + 1] ?? "" : undefined;
	const gateIndex = argv.indexOf("--gate");
	const gate = (gateIndex >= 0 ? argv[gateIndex + 1] ?? "" : "all") as GateMode;
	if (gate !== "all" && gate !== "contract" && gate !== "approval") {
		console.error("::error::--gate must be contract or approval");
		return 1;
	}
	const signIndex = argv.indexOf("--self-review-sign");
	if (signIndex >= 0) {
		const args = argv.slice(signIndex + 1);
		if (args.length !== 8) {
			console.error("::error::--self-review-sign requires exactly 8 args: <verdict> <base-sha> <head-sha> <diff-sha256> <reviewer-id> <risk> <extra> <evidence>");
			return 1;
		}
		const [verdict, baseSha, headSha, diffSha256, reviewerId, risk, extra, evidence] = args as [string, string, string, string, string, string, string, string];
		if (verdict !== "merge-approved" && verdict !== "merge-self-approved" && verdict !== "merge-blocked") {
			console.error("::error::verdict must be merge-approved, merge-self-approved, or merge-blocked");
			return 1;
		}
		if (extra !== "none" && !extra.startsWith("independent:")) {
			console.error("::error::extra must be none or independent:<login>; gpt-heavy is no longer a policy-satisfying token");
			return 1;
		}
		const parsedExtra: SelfReviewExtra = extra === "none" ? { kind: "none" } : { kind: "independent", login: extra.slice("independent:".length) };
		const payload = selfReviewSignedPayload({ verdict, baseSha, headSha, diffSha256, reviewerId, risk: risk as SelfReviewRisk, extra: parsedExtra, evidence });
		console.log(selfReviewSignature(payload));
		return 0;
	}
	const result = eventIndex >= 0 && argv[eventIndex + 1]
		? await validateEvent(path.resolve(process.cwd(), argv[eventIndex + 1]!), cwd, trustedRoot)
		: pushIndex >= 0 && argv[pushIndex + 1] && argv[pushIndex + 2]
			? await validatePushPreflight(argv[pushIndex + 1]!, argv[pushIndex + 2]!, pushRemote, cwd, trustedRoot, pushUrl)
			: preflightIndex >= 0 && argv[preflightIndex + 1]
				? await validatePreflight(argv[preflightIndex + 1]!, cwd, trustedRoot, invocationCwd)
				: contractResult(false, ["Usage: bun scripts/verify-pr-verdict.ts --event <github-event.json> | --preflight-command <command> | --push-preflight <branch> <head-sha> [--push-remote <remote>] [--push-url <destination-url>] | --self-review-sign <verdict> <base> <head> <digest> <reviewer-id> <risk> <extra> <evidence>; add --gate <contract|approval> to report only one half of the verdict"]);
	for (const diagnostic of result.diagnostics) console.error(`::error::${diagnostic}`);
	for (const diagnostic of result.authorizationDiagnostics) {
		// Under --gate contract the pending approval is not this check's verdict, so it is
		// reported as a notice: the log still explains why the merge has not happened.
		if (gate === "contract") console.log(`::notice::${diagnostic}`);
		else console.error(`::error::${diagnostic}`);
	}
	// Machine-readable so a workflow can fan the two verdicts out into two check names.
	console.log(`${MERGE_AUTHORIZED_OUTPUT}=${result.mergeAuthorized}`);
	if (result.ok && result.verdict) console.log(`PR contract valid: ${result.verdict.verdict} ${result.verdict.diffSha256}`);
	return gateExitCode(gate, result);
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
