#!/usr/bin/env bun

import * as path from "node:path";

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
	/** Risk declaration from the PR body (must match the self-review comment; issue #4703). */
	bodyRisk?: string | null;
	/** Trusted GitHub evidence about the independent reviewer named by extra:independent:<login>. */
	independentReviewer?: IndependentReviewerEvidence | null;
}

export interface IndependentReviewerEvidence {
	permission: string;
	approvedHead: boolean;
	approvedLogin?: string;
}

export interface AuthenticatedSelfReviewComment {
	login: string;
	authorAssociation: string;
	body: string;
}

export interface PrValidationResult {
	ok: boolean;
	verdict?: ParsedPrVerdict;
	diagnostics: string[];
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
			if (!selfReview.ok) {
				diagnostics.push("merge-self-approved requires a valid gajae.pr-self-review.v1 risk record for the exact head (owner identity, low-risk classification, fresh base/head/digest).");
			} else if (selfReview.risk !== "low-risk" || selfReview.verdict !== "merge-self-approved") {
				diagnostics.push(`merge-self-approved requires the risk record to classify this change low-risk with verdict:merge-self-approved; record says risk:${selfReview.risk} verdict:${selfReview.verdict}. Higher risk classes must use independent review (merge-approved).`);
			}
		}
		if (input.requireMergeApproved && parsed.verdict.verdict !== "merge-approved" && parsed.verdict.verdict !== "merge-self-approved") {
			diagnostics.push(`Verdict ${parsed.verdict.verdict} intentionally blocks merge. Obtain independent review (merge-approved) or, for a low-risk owner change, the explicit merge-self-approved path.`);
		}
	}
	diagnostics.push(...selfReview.diagnostics);
	return { ok: diagnostics.length === 0, verdict: parsed.verdict, diagnostics };
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
 */
function evaluateSelfReviewComment(input: PrValidationInput): { ok: boolean; reviewerId?: string; risk?: SelfReviewRisk; verdict?: "merge-approved" | "merge-self-approved" | "merge-blocked"; diagnostics: string[] } {
	const comment = input.selfReviewComment;
	if (!comment) return { ok: false, diagnostics: [] };
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
	if (!selfReviewSatisfiesPolicy(review, input.independentReviewer ?? null)) {
		const required = "an authenticated exact-head approval from a distinct independent reviewer (extra:independent:<login>)";
		diagnostics.push(`Self-review risk ${review.risk} requires ${required} (extra:${review.extra.kind === "independent" ? `independent:${review.extra.login}` : review.extra.kind}); the risk-classified gate is not satisfied.`);
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
 * Any API failure fails closed (issue #4703).
 */
async function fetchSelfReviewComment(event: PullRequestEvent, authorLogin: string): Promise<AuthenticatedSelfReviewComment | null> {
	const repository = event.repository?.full_name;
	const number = event.pull_request?.number;
	const token = Bun.env.GITHUB_TOKEN;
	if (!repository || !number || !token || !authorLogin) return null;
	let newest: IssueComment | null = null;
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
			if (comment.user?.login?.toLowerCase() !== authorLogin.toLowerCase()) continue;
			if ((comment.body ?? "").split(/\r?\n/u).some(line => line.trim().startsWith(SELF_REVIEW_PREFIX))) newest = comment;
		}
		if (comments.length < 100) break;
	}
	return newest ? issueCommentToSelfReview(newest) : null;
}

function issueCommentToSelfReview(comment: IssueComment): AuthenticatedSelfReviewComment | null {
	const login = comment.user?.login;
	if (!login || typeof comment.body !== "string") return null;
	return { login, authorAssociation: comment.author_association ?? "NONE", body: comment.body };
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
	const reviewerReviews = reviews.filter(review =>
		review.user?.login?.toLowerCase() === reviewerId.toLowerCase()
		&& review.state !== "COMMENTED"
		&& review.commit_id === headSha,
	);
	const approval = reviewerReviews.at(-1);
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
	return approval ? { login: approval.user!.login, headSha: approval.commit_id } : {};
}

/**
 * Resolve trusted GitHub evidence for the independent reviewer named by a self-review
 * extra:independent:<login> token: collaborator permission plus an authenticated APPROVED
 * review on the exact PR head (issue #4703 hardening — the token shape alone never
 * satisfies the risk gate).
 */
async function fetchIndependentReviewerEvidence(event: PullRequestEvent, login: string, headSha: string): Promise<IndependentReviewerEvidence> {
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
	const approved = reviews.some(review =>
		review.user?.login?.toLowerCase() === login.toLowerCase()
		&& review.state === "APPROVED"
		&& review.commit_id === headSha,
	);
	const permissionResponse = await fetch(`https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`, { headers });
	if (!permissionResponse.ok) throw new Error(`Independent reviewer permission lookup failed: ${permissionResponse.status}; failing closed.`);
	const collaborator = await permissionResponse.json() as CollaboratorPermission;
	return { permission: collaborator.permission ?? "none", approvedHead: approved, approvedLogin: login };
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
	if (!pr) return { ok: false, diagnostics: ["GitHub event payload does not contain pull_request data."] };
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
		return { ok: false, diagnostics: [`Checked-out source must equal exact PR head ${headSha}.` ] };
	}
	const fetchBase = await git(["fetch", "--no-tags", trustedRoot, baseSha], cwd);
	if (fetchBase.exitCode !== 0) return { ok: false, diagnostics: [`Could not fetch immutable PR base ${baseSha}: ${fetchBase.stderr}`] };
	const ancestry = await git(["merge-base", "--is-ancestor", baseSha, headSha], cwd);
	const diff = await git(["diff", "--binary", "--full-index", "--no-ext-diff", `${baseSha}...${headSha}`], cwd);
	if (diff.exitCode !== 0) return { ok: false, diagnostics: [`Could not compute exact PR diff: ${diff.stderr}`] };
	const parsed = parsePrVerdict(body);
	const approval = parsed.verdict?.verdict === "merge-approved"
		? await authenticatedApproval(event, parsed.verdict.reviewerId, headSha)
		: {};
	// The self-review record is fetched whenever the verdict names the author (the
	// merge-self-approved solo path) or the body verdict is merge-approved with a
	// self-review record expected to carry the risk classification.
	const selfReviewComment = parsed.verdict && parsed.verdict.reviewerId.toLowerCase() === authorLogin.toLowerCase()
		? await fetchSelfReviewComment(event, authorLogin)
		: null;
	const bodyRiskParsed = parseBodyRisk(body);
	const bodyRisk = bodyRiskParsed.risk;
	const independentLogin = selfReviewComment ? independentReviewerLogin(selfReviewComment.body) : null;
	const independentReviewer = independentLogin && selfReviewComment?.login.toLowerCase() === authorLogin.toLowerCase()
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
		selfReviewComment,
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
	if (parsed === null) return { ok: true, diagnostics: [] };
	if (!parsed.bodyFile && parsed.body === undefined) return { ok: false, diagnostics: ["gh pr create must provide --body-file or --body so the PR verdict can be validated before submission."] };
	let body = parsed.body!;
	if (parsed.bodyFile) {
		const bodyPath = path.resolve(invocationCwd, parsed.bodyFile);
		try {
			body = await Bun.file(bodyPath).text();
		} catch (error) {
			return { ok: false, diagnostics: [`Could not read PR body file ${bodyPath}: ${error instanceof Error ? error.message : String(error)}`] };
		}
	}
	const baseRef = parsed.base ?? "dev";
	const refreshBase = await git(["fetch", "--no-tags", "origin", "dev"], cwd);
	if (refreshBase.exitCode !== 0) {
		return { ok: false, diagnostics: [`Could not refresh origin/dev before PR preflight: ${refreshBase.stderr}. Run git fetch origin dev and retry.`] };
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
	const child = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
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
	baseRefName: string;
	author: { login: string } | null;
	headRepositoryOwner: { login: string } | null;
}

interface LiveReview {
	author: { login: string } | null;
	state: string;
	commit: { oid: string } | null;
}

/**
 * Resolve the GitHub `owner/repo` actually receiving the push. A fork checkout's `origin`
 * is the fork while the open PR lives upstream, so the implicit `gh` context would query
 * the wrong repository (or none) and wave the push through.
 */
async function pushRemoteRepository(remote: string, cwd: string): Promise<string | null> {
	const url = await git(["remote", "get-url", remote], cwd);
	if (url.exitCode !== 0) return null;
	const text = new TextDecoder().decode(url.stdout).trim();
	const match = /(?:[:/])([^/:]+)\/([^/]+?)(?:\.git)?$/u.exec(text);
	return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The repository whose PRs govern a push to `pushRepo`. Pushing a fork branch opens the
 * PR upstream, so a fork resolves to its parent; a non-fork is its own authority.
 */
async function contractRepository(pushRepo: string, cwd: string): Promise<{ repo: string; forkOwner: string | null }> {
	const viewed = await gh(["repo", "view", pushRepo, "--json", "isFork,parent"], cwd);
	if (viewed.exitCode !== 0) return { repo: pushRepo, forkOwner: null };
	try {
		const info = JSON.parse(viewed.stdout) as { isFork?: boolean; parent?: { owner?: { login?: string }; name?: string } | null };
		const parentOwner = info.parent?.owner?.login;
		const parentName = info.parent?.name;
		if (!info.isFork || !parentOwner || !parentName) return { repo: pushRepo, forkOwner: null };
		return { repo: `${parentOwner}/${parentName}`, forkOwner: pushRepo.split("/")[0]! };
	} catch {
		return { repo: pushRepo, forkOwner: null };
	}
}

/**
 * Reproduce the Dev CI "PR contract bootstrap" judgement for the exact commit being
 * pushed. That job runs with NO requireMergeApproved escape hatch, so this gate must
 * mirror it exactly (requireMergeApproved: true): a stale verdict digest, an unrebased
 * base, a missing risk classification, AND a blocking verdict (needs-human,
 * merge-blocked) all fail here, because all of them turn the required check red.
 *
 * A preflight that disagrees with CI is worthless, so the authenticated exact-head
 * approval is resolved from the same GitHub review data the server reads; otherwise a
 * legitimately reviewed merge-approved PR would fail locally while passing in CI.
 *
 * A branch with no open PR has no contract to invalidate and passes.
 */
async function validatePushPreflight(branch: string, headSha: string, remote: string, cwd: string, trustedRoot: string): Promise<PrValidationResult> {
	if (!SHA40.test(headSha)) return { ok: false, diagnostics: [`Pushed commit ${headSha} is not a lowercase 40-hex commit.`] };
	const pushRepo = await pushRemoteRepository(remote, cwd);
	if (!pushRepo) return { ok: false, diagnostics: [`Could not resolve the GitHub repository behind push remote ${remote}; refusing to validate against an unknown repository.`] };
	// A fork push opens its PR upstream, so the contract lives in the parent repository.
	const { repo: baseRepo, forkOwner } = await contractRepository(pushRepo, cwd);
	// The head is qualified by the owner actually receiving the push, so a same-named
	// branch in another fork can never be mistaken for this PR.
	const headOwner = forkOwner ?? pushRepo.split("/")[0]!;
	const listed = await gh(["pr", "list", "--repo", baseRepo, "--head", branch, "--state", "open", "--json", "number,body,baseRefName,author,headRepositoryOwner"], cwd);
	if (listed.exitCode !== 0) {
		return { ok: false, diagnostics: [`Could not resolve the open PR for ${branch} in ${baseRepo}: ${listed.stderr || `gh exited ${listed.exitCode}`}. Authenticate with gh auth login, or set GJC_SKIP_PR_PREFLIGHT=1 to push without the contract check.`] };
	}
	let pulls: LivePullRequest[];
	try {
		pulls = JSON.parse(listed.stdout) as LivePullRequest[];
	} catch (error) {
		return { ok: false, diagnostics: [`Could not parse the gh pr list response for ${branch}: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const candidates = pulls.filter(candidate => candidate.headRepositoryOwner?.login?.toLowerCase() === headOwner.toLowerCase());
	if (candidates.length > 1) {
		return { ok: false, diagnostics: [`Branch ${branch} matches ${candidates.length} open PRs in ${baseRepo} from ${headOwner} (#${candidates.map(candidate => candidate.number).join(", #")}); cannot determine which contract governs this push.`] };
	}
	const pr = candidates[0];
	if (!pr) return { ok: true, diagnostics: [] };
	// gh pr list's JSON mapping omits headRefOid and review commit oids on older gh
	// releases (e.g. 2.4.x), which would fail closed on every push, so the head and
	// the review commits are resolved through the stable `gh api` surface instead.
	const currentHead = await gh(["api", `repos/${baseRepo}/pulls/${pr.number}`, "--jq", ".head.sha"], cwd);
	if (currentHead.exitCode !== 0) {
		return { ok: false, diagnostics: [`Could not resolve the current head of ${baseRepo}#${pr.number}: ${currentHead.stderr || `gh exited ${currentHead.exitCode}`}.`] };
	}
	const prHeadSha = currentHead.stdout.trim();
	if (!SHA40.test(prHeadSha)) return { ok: false, diagnostics: [`Current head of ${baseRepo}#${pr.number} (${prHeadSha}) is not a lowercase 40-hex commit.`] };
	// The base is the repository the PR was queried in -- for a fork push that is the
	// upstream, never the contributor's local origin/dev. The ref is the PR's own base
	// branch rather than an assumed "dev".
	const baseRemoteUrl = `https://github.com/${baseRepo}.git`;
	const refreshBase = await git(["fetch", "--no-tags", baseRemoteUrl, pr.baseRefName], cwd);
	if (refreshBase.exitCode !== 0) {
		return { ok: false, diagnostics: [`Could not fetch the PR base ${baseRepo}#${pr.baseRefName} before the push preflight: ${refreshBase.stderr}`] };
	}
	const base = await git(["rev-parse", "FETCH_HEAD"], cwd);
	const baseSha = new TextDecoder().decode(base.stdout).trim();
	if (!SHA40.test(baseSha)) return { ok: false, diagnostics: [`Could not resolve ${baseRepo}#${pr.baseRefName} to a commit: ${base.stderr}`] };
	const ancestry = await git(["merge-base", "--is-ancestor", baseSha, headSha], cwd);
	const diff = await git(["diff", "--binary", "--full-index", "--no-ext-diff", `${baseSha}...${headSha}`], cwd);
	if (diff.exitCode !== 0) return { ok: false, diagnostics: [`Could not compute the exact ${baseSha}...${headSha} diff: ${diff.stderr}`] };
	const body = pr.body ?? "";
	const bodyRiskParsed = parseBodyRisk(body);
	// Latest non-COMMENTED review per identity on the exact head, matching the server's
	// "effective review" semantics: a later CHANGES_REQUESTED supersedes an earlier APPROVED.
	const parsedVerdict = parsePrVerdict(body).verdict;
	// Review commit oids come from `gh api` because `gh pr list` omits them on older gh.
	let reviews: LiveReview[] = [];
	if (parsedVerdict?.verdict === "merge-approved") {
		const liveReviews = await gh(["api", `repos/${baseRepo}/pulls/${pr.number}/reviews`, "--jq", "[.[] | {author: {login: .user.login}, state, commit: {oid: .commit_id}}]"], cwd);
		if (liveReviews.exitCode !== 0) {
			return { ok: false, diagnostics: [`Could not fetch the reviews of ${baseRepo}#${pr.number} to verify the exact-head approval: ${liveReviews.stderr || `gh exited ${liveReviews.exitCode}`}.`] };
		}
		try {
			reviews = JSON.parse(liveReviews.stdout) as LiveReview[];
		} catch (error) {
			return { ok: false, diagnostics: [`Could not parse the review list of ${baseRepo}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`] };
		}
	}
	const approval = ((): { login?: string; headSha?: string } => {
		if (parsedVerdict?.verdict !== "merge-approved") return {};
		const effective = reviews
			.filter(review =>
				review.author?.login?.toLowerCase() === parsedVerdict.reviewerId.toLowerCase()
				&& review.state !== "COMMENTED"
				&& review.commit?.oid === headSha,
			)
			.at(-1);
		return effective?.state === "APPROVED" ? { login: effective.author?.login, headSha: effective.commit?.oid } : {};
	})();
	const result = validatePrContract({
		body,
		baseRef: pr.baseRefName,
		baseSha,
		headSha,
		// The push is what MAKES headSha the PR head, so prHeadSha is the pre-push
		// value and is expected to differ; it is reported, never used as the contract head.
		authorLogin: pr.author?.login ?? "",
		computedDiffSha256: canonicalDiffSha256(diff.stdout),
		baseIsAncestor: ancestry.exitCode === 0,
		fastGatePassed: await runFastGate(cwd, trustedRoot),
		bodyRisk: bodyRiskParsed.risk,
		authenticatedReviewerLogin: approval.login,
		authenticatedReviewHeadSha: approval.headSha,
		requireMergeApproved: true,
	});
	const diagnostics = [...bodyRiskParsed.diagnostics, ...result.diagnostics];
	if (diagnostics.length > 0) {
		diagnostics.push(`This is exactly what the Dev CI "PR contract bootstrap" job will report for ${baseRepo}#${pr.number} once ${headSha} lands (currently ${prHeadSha}); the exact ${baseSha}...${headSha} digest is ${canonicalDiffSha256(diff.stdout)}.`);
		diagnostics.push("Fix the PR body, or push anyway with GJC_SKIP_PR_PREFLIGHT=1 (or --no-verify) while the change is still awaiting review.");
	}
	return { ok: diagnostics.length === 0, verdict: result.verdict, diagnostics };
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
			? await validatePushPreflight(argv[pushIndex + 1]!, argv[pushIndex + 2]!, pushRemote, cwd, trustedRoot)
			: preflightIndex >= 0 && argv[preflightIndex + 1]
				? await validatePreflight(argv[preflightIndex + 1]!, cwd, trustedRoot, invocationCwd)
				: { ok: false, diagnostics: ["Usage: bun scripts/verify-pr-verdict.ts --event <github-event.json> | --preflight-command <command> | --push-preflight <branch> <head-sha> [--push-remote <remote>] | --self-review-sign <verdict> <base> <head> <digest> <reviewer-id> <risk> <extra> <evidence>"] };
	for (const diagnostic of result.diagnostics) console.error(`::error::${diagnostic}`);
	if (result.ok && result.verdict) console.log(`PR contract valid: ${result.verdict.verdict} ${result.verdict.diffSha256}`);
	return result.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
