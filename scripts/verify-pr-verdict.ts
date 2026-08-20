#!/usr/bin/env bun

import * as path from "node:path";

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const VERDICT_PREFIX = "gajae.pr-review-verdict.v1";
const VERDICT_PATTERN = /^gajae\.pr-review-verdict\.v1 (merge-approved|merge-blocked|needs-human) sha256:([0-9a-f]{64}) reviewer:(architect|critic|human) reviewer-id:([^\s]+) evidence:(.+)$/u;
const SELF_REVIEW_PREFIX = "gajae.pr-self-review.v1";
const SELF_REVIEW_PATTERN = /^gajae\.pr-self-review\.v1 verdict:(merge-approved|merge-blocked) base:([0-9a-f]{40}) head:([0-9a-f]{40}) sha256:([0-9a-f]{64}) reviewer-id:([^\s]+) risk:(low-risk|regression-risk|high-risk) extra:(none|gpt-heavy|independent:[^\s]+) evidence:(.+)$/u;
const SELF_REVIEW_SIGNATURE_PATTERN = /^self-review-signature: sha256:([0-9a-f]{64})$/u;
const SELF_REVIEW_FOOTER = "Signed-off-by: gaebal-gajae (clawdbot) 🦞";

export type PrVerdict = "merge-approved" | "merge-blocked" | "needs-human";
export type ReviewerRole = "architect" | "critic" | "human";
export type SelfReviewRisk = "low-risk" | "regression-risk" | "high-risk";
export type SelfReviewExtra = { kind: "none" } | { kind: "gpt-heavy" } | { kind: "independent"; login: string };

export interface ParsedPrVerdict {
	verdict: PrVerdict;
	diffSha256: string;
	reviewerRole: ReviewerRole;
	reviewerId: string;
	evidence: string;
}

export interface ParsedSelfReview {
	verdict: "merge-approved" | "merge-blocked";
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
		: extraToken === "gpt-heavy"
			? { kind: "gpt-heavy" }
			: { kind: "independent", login: extraToken.slice("independent:".length) };
	return {
		selfReview: {
			verdict: match[1] as "merge-approved" | "merge-blocked",
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
 * Canonicalize a parsed self-review record into the exact signed payload: every bound
 * field in fixed order, then the evidence. The signature covers exactly these bytes,
 * so any field drift (stale head, forged verdict, edited evidence) breaks the signature.
 */
export function selfReviewSignedPayload(review: Omit<ParsedSelfReview, "signature">): string {
	const extraToken = review.extra.kind === "none"
		? "none"
		: review.extra.kind === "gpt-heavy"
			? "gpt-heavy"
			: `independent:${review.extra.login}`;
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
 * Risk-classified review policy (issue #4703 final owner decision).
 * An extra:independent:<login> token only satisfies the gate when the named reviewer is a
 * distinct maintainer with admin/maintain/write permission and an authenticated APPROVED
 * review on the exact head; the token shape alone never satisfies the policy.
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
			return review.extra.kind === "gpt-heavy" || (review.extra.kind === "independent" && independentApproved(review.extra));
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
		if (parsed.verdict.verdict === "merge-approved" && parsed.verdict.reviewerId.toLowerCase() === input.authorLogin.toLowerCase() && !selfReview.ok) {
			diagnostics.push(`merge-approved cannot be self-approved: reviewer-id ${parsed.verdict.reviewerId} matches PR author ${input.authorLogin}. Record a signed gajae.pr-self-review.v1 maintainer comment for the exact head, or obtain independent review.`);
		}
		// The self-review comment can only authorize the identity it validated: the PR-body
		// verdict must name exactly that reviewer (issue #4703 hardening).
		if (parsed.verdict.verdict === "merge-approved" && selfReview.ok && selfReview.reviewerId
			&& parsed.verdict.reviewerId.toLowerCase() !== selfReview.reviewerId.toLowerCase()) {
			diagnostics.push(`merge-approved reviewer-id ${parsed.verdict.reviewerId} does not match the validated self-review identity ${selfReview.reviewerId}; the self-review comment cannot authorize a different reviewer.`);
		}
		if (input.requireMergeApproved && parsed.verdict.verdict !== "merge-approved") {
			diagnostics.push(`Verdict ${parsed.verdict.verdict} intentionally blocks merge. Obtain independent review, update the exact-head verdict to merge-approved, and rerun this check.`);
		}
		if (input.requireMergeApproved && parsed.verdict.verdict === "merge-approved" && !selfReview.ok) {
			if (!input.authenticatedReviewerLogin || input.authenticatedReviewerLogin.toLowerCase() !== parsed.verdict.reviewerId.toLowerCase()) {
				diagnostics.push(`merge-approved reviewer-id ${parsed.verdict.reviewerId} is not backed by an authenticated approving GitHub review.`);
			}
			if (input.authenticatedReviewHeadSha !== input.headSha) {
				diagnostics.push(`Authenticated approval must target exact PR head ${input.headSha}, not ${input.authenticatedReviewHeadSha ?? "a missing commit"}.`);
			}
		}
	}
	diagnostics.push(...selfReview.diagnostics);
	return { ok: diagnostics.length === 0, verdict: parsed.verdict, diagnostics };
}

/**
 * Evaluate the trusted maintainer self-review comment (issue #4703).
 *
 * Returns ok=true only when a comment exists, is well-formed, carries a valid signature
 * over the exact bound fields, comes from an authorized maintainer identity, targets the
 * exact event base/head/digest, approves, and satisfies the risk-classified policy
 * (low-risk: signed self-review alone; regression-risk: additionally gpt-heavy validation
 * OR an assigned independent domain reviewer; high-risk: one assigned independent reviewer).
 * The PR body can never supply this record: evaluateSelfReviewComment reads only the
 * trusted comment data fetched from the GitHub API under workflow permissions.
 */
function evaluateSelfReviewComment(input: PrValidationInput): { ok: boolean; reviewerId?: string; diagnostics: string[] } {
	const comment = input.selfReviewComment;
	if (!comment) return { ok: false, diagnostics: [] };
	const diagnostics: string[] = [];
	const parsedComment = parseSelfReview(comment.body);
	if (!parsedComment.selfReview) return { ok: false, diagnostics: parsedComment.diagnostics };
	const review = parsedComment.selfReview;
	// Delegated maintainer identity (issue #4703): only the repository owner account may
	// use the self-review path; ordinary collaborators cannot self-approve.
	if (comment.authorAssociation !== "OWNER" || comment.login.toLowerCase() !== review.reviewerId.toLowerCase()) {
		diagnostics.push(`Self-review comment identity ${comment.login} (${comment.authorAssociation}) is not the repository owner matching reviewer-id ${review.reviewerId}.`);
	}
	if (review.verdict !== "merge-approved") {
		diagnostics.push(`Self-review verdict ${review.verdict} does not authorize merge.`);
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
	const expectedSignature = selfReviewSignature(selfReviewSignedPayload(review));
	if (review.signature !== expectedSignature) {
		diagnostics.push("Self-review signature does not match the signed payload; the record or evidence was altered.");
	}
	if (review.reviewerId.toLowerCase() !== input.authorLogin.toLowerCase()) {
		diagnostics.push(`Self-review reviewer-id ${review.reviewerId} must match the PR author ${input.authorLogin} for a maintainer self-review.`);
	}
	if (input.bodyRisk !== undefined && input.bodyRisk !== null && input.bodyRisk !== review.risk) {
		diagnostics.push(`Self-review risk ${review.risk} does not match the PR body risk classification ${input.bodyRisk}; the classifications must agree.`);
	}
	if (!selfReviewSatisfiesPolicy(review, input.independentReviewer ?? null)) {
		const required = review.risk === "regression-risk" ? "gpt-heavy validation or an authenticated exact-head approval from an assigned independent reviewer" : "an authenticated exact-head approval from an assigned independent reviewer";
		diagnostics.push(`Self-review risk ${review.risk} requires ${required} (extra:${review.extra.kind}); the risk-fix OR gate is not satisfied.`);
	}
	if (review.extra.kind === "independent" && review.extra.login.toLowerCase() === input.authorLogin.toLowerCase()) {
		diagnostics.push(`Self-review extra:independent:${review.extra.login} names the PR author; the independent reviewer must be a distinct maintainer.`);
	}
	return { ok: diagnostics.length === 0, reviewerId: review.reviewerId, diagnostics };
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
		base?: { ref?: string; sha?: string };
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

async function authenticatedApproval(event: PullRequestEvent, reviewerId: string, headSha: string): Promise<{ login?: string; headSha?: string }> {
	const repository = event.repository?.full_name;
	const number = event.pull_request?.number;
	const token = Bun.env.GITHUB_TOKEN;
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
 * issue_comment events carry no pull_request object; the PR is identified by the
 * comment's issue number when that issue is a pull request. Resolve the authoritative
 * PR data (body, author, immutable base, exact head) from the GitHub API using the
 * trusted workflow token so comment-triggered validations use the same immutable
 * event semantics as pull_request events. Non-PR comments resolve to no PR and fail.
 */
async function resolvePullRequestEvent(event: PullRequestEvent): Promise<PullRequestEvent> {
	if (event.pull_request) return event;
	const repository = event.repository?.full_name;
	const number = event.issue?.number;
	const token = Bun.env.GITHUB_TOKEN;
	if (!repository || !number || !token) return event;
	const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}`, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!response.ok) return event;
	const pr = await response.json() as {
		body?: string | null;
		user?: { login?: string };
		base?: { ref?: string; sha?: string };
		head?: { sha?: string };
	};
	return {
		...event,
		pull_request: {
			number,
			body: pr.body,
			user: pr.user,
			base: pr.base,
			head: pr.head,
		},
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
	const selfReviewComment = parsed.verdict?.verdict === "merge-approved"
		&& parsed.verdict.reviewerId.toLowerCase() === authorLogin.toLowerCase()
		? await fetchSelfReviewComment(event, authorLogin)
		: null;
	const bodyRisk = parseBodyRisk(body);
	const independentLogin = selfReviewComment ? independentReviewerLogin(selfReviewComment.body) : null;
	const independentReviewer = independentLogin && selfReviewComment?.login.toLowerCase() === authorLogin.toLowerCase()
		? await fetchIndependentReviewerEvidence(event, independentLogin, headSha)
		: null;
	return validatePrContract({
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
}

/**
 * Parse the risk classification declared in the PR body's Risk classification section.
 * The self-review comment must declare the same risk (issue #4703 hardening).
 */
export function parseBodyRisk(body: string): string | null {
	const selected = body
		.split(/\r?\n/u)
		.map(line => line.trim())
		.find(line => /^-\s*\[(x|X)\]\s*`(low-risk|regression-risk|high-risk)`/u.test(line));
	if (!selected) return null;
	const match = /`(low-risk|regression-risk|high-risk)`/u.exec(selected);
	return match?.[1] ?? null;
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

export async function main(argv: string[]): Promise<number> {
	const repoIndex = argv.indexOf("--repo");
	const trustedRootIndex = argv.indexOf("--trusted-root");
	const invocationCwdIndex = argv.indexOf("--invocation-cwd");
	const cwd = path.resolve(process.cwd(), repoIndex >= 0 && argv[repoIndex + 1] ? argv[repoIndex + 1]! : ".");
	const trustedRoot = path.resolve(process.cwd(), trustedRootIndex >= 0 && argv[trustedRootIndex + 1] ? argv[trustedRootIndex + 1]! : ".");
	const invocationCwd = path.resolve(process.cwd(), invocationCwdIndex >= 0 && argv[invocationCwdIndex + 1] ? argv[invocationCwdIndex + 1]! : cwd);
	const eventIndex = argv.indexOf("--event");
	const preflightIndex = argv.indexOf("--preflight-command");
	const signIndex = argv.indexOf("--self-review-sign");
	if (signIndex >= 0) {
		const args = argv.slice(signIndex + 1);
		if (args.length !== 7) {
			console.error("::error::--self-review-sign requires exactly 7 args: <base-sha> <head-sha> <diff-sha256> <reviewer-id> <risk> <extra> <evidence>");
			return 1;
		}
		const [baseSha, headSha, diffSha256, reviewerId, risk, extra, evidence] = args as [string, string, string, string, string, string, string];
		const parsedExtra: SelfReviewExtra = extra === "none" ? { kind: "none" } : extra === "gpt-heavy" ? { kind: "gpt-heavy" } : { kind: "independent", login: extra.slice("independent:".length) };
		const payload = selfReviewSignedPayload({ verdict: "merge-approved", baseSha, headSha, diffSha256, reviewerId, risk: risk as SelfReviewRisk, extra: parsedExtra, evidence });
		console.log(selfReviewSignature(payload));
		return 0;
	}
	const result = eventIndex >= 0 && argv[eventIndex + 1]
		? await validateEvent(path.resolve(process.cwd(), argv[eventIndex + 1]!), cwd, trustedRoot)
		: preflightIndex >= 0 && argv[preflightIndex + 1]
			? await validatePreflight(argv[preflightIndex + 1]!, cwd, trustedRoot, invocationCwd)
			: { ok: false, diagnostics: ["Usage: bun scripts/verify-pr-verdict.ts --event <github-event.json> | --preflight-command <command> | --self-review-sign <base> <head> <digest> <reviewer-id> <risk> <extra> <evidence>"] };
	for (const diagnostic of result.diagnostics) console.error(`::error::${diagnostic}`);
	if (result.ok && result.verdict) console.log(`PR contract valid: ${result.verdict.verdict} ${result.verdict.diffSha256}`);
	return result.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
