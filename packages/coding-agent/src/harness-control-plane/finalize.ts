/**
 * Evidence-gated finalizer (M8).
 *
 * `completed: true` ONLY when: every required validation receipt is valid for the commit
 * under test, the final commit exists on the branch, a PR/issue artifact exists, and the
 * completion receipt validates with no blockers. Never "the agent said done".
 *
 * External effects (running validation commands, git, gh) are injected via {@link FinalizeChecks}
 * so the gate predicate is unit-testable; {@link defaultFinalizeChecks} provides the real
 * implementation exercised by the M10 e2e suite.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	buildReceipt,
	type CompletionEvidence,
	type ReceiptEnvelope,
	type ReceiptSubject,
	type ReviewFailureEvidence,
	type ReviewVerdictEvidence,
	type ValidationEvidence,
	validateReceipt,
} from "./receipts";
import { readReceiptIndex, writeReceiptImmutable } from "./storage";
import { isReviewVerdict, type ReviewVerdict } from "./types";

export interface ValidationCommandSpec {
	name: string;
	command: string;
}

export interface ValidationRun {
	exactCommand: string;
	cwd: string;
	exitStatus: number;
	pass: boolean;
}

export interface FinalizeChecks {
	runValidation(spec: ValidationCommandSpec): Promise<ValidationRun>;
	resolveCommit(): Promise<string | null>;
	commitOnBranch(commit: string, branch: string): Promise<boolean>;
	prOrIssue(): Promise<{ prUrl: string | null; issueArtifact: string | null }>;
}

export interface FinalizeOptions {
	root: string;
	sessionId: string;
	workspace: string;
	branch: string;
	requireTests?: boolean;
	requireCommit?: boolean;
	requirePr?: boolean;
	/** Review-only sessions produce a terminal verdict instead of implementation validation. */
	reviewOnly?: boolean;
	/** Operator/loop-supplied terminal review verdict (closed vocabulary). */
	verdict?: string | null;
	/** Bounded PR/issue reference for the review target (e.g. "PR-414"). Never resolved from the live repo. */
	prTarget?: string | null;
	validationCommands?: ValidationCommandSpec[];
	checks: FinalizeChecks;
	clock?: () => number;
}

export interface FinalizeResult {
	completed: boolean;
	receiptPath: string | null;
	validation: { name: string; valid: boolean; exitStatus: number }[];
	commitHash: string | null;
	prUrl: string | null;
	verdict?: ReviewVerdict | null;
	issueArtifact: string | null;
	blockers: string[];
}

function receiptId(prefix: string): string {
	return `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

export async function runFinalize(opts: FinalizeOptions): Promise<FinalizeResult> {
	if (opts.reviewOnly) return runReviewFinalize(opts);

	const now = () => new Date(opts.clock ? opts.clock() : Date.now()).toISOString();
	const blockers: string[] = [];
	const validation: FinalizeResult["validation"] = [];
	const validationReceiptIds: string[] = [];

	const commit = await opts.checks.resolveCommit();
	const subject: ReceiptSubject = { workspace: opts.workspace, branch: opts.branch, head: commit, commit };

	// 1. Validation receipts.
	for (const spec of opts.validationCommands ?? []) {
		const run = await opts.checks.runValidation(spec);
		const evidence: ValidationEvidence = {
			command: spec.name,
			exactCommand: run.exactCommand,
			cwd: run.cwd,
			exitStatus: run.exitStatus,
			pass: run.pass,
			commitUnderTest: commit,
		};
		const receipt = buildReceipt<ValidationEvidence>({
			receiptId: receiptId("val"),
			sessionId: opts.sessionId,
			family: "validation",
			source: "finalizer",
			subject,
			evidence,
			createdAt: now(),
			valid: run.pass,
		});
		await writeReceiptImmutable(opts.root, opts.sessionId, "validation", receipt.receiptId, receipt);
		const outcome = validateReceipt(receipt);
		validation.push({ name: spec.name, valid: outcome.valid, exitStatus: run.exitStatus });
		validationReceiptIds.push(receipt.receiptId);
		if (opts.requireTests && !outcome.valid) blockers.push(`validation-failed:${spec.name}`);
	}
	if (opts.requireTests && (opts.validationCommands?.length ?? 0) === 0) {
		blockers.push("validation-required-but-none-run");
	}

	// 2. Commit on branch.
	if (opts.requireCommit) {
		if (!commit) blockers.push("missing-commit");
		else if (!(await opts.checks.commitOnBranch(commit, opts.branch))) blockers.push("commit-not-on-branch");
	}

	// 3. PR / issue artifact.
	const artifact = await opts.checks.prOrIssue();
	if (opts.requirePr && !artifact.prUrl && !artifact.issueArtifact) blockers.push("missing-pr-or-issue");

	// B4: cross-validate the persisted validation receipts (validity + commit freshness) before completion.
	if (blockers.length === 0) {
		const persisted = await readReceiptIndex(opts.root, opts.sessionId, "validation");
		for (const id of validationReceiptIds) {
			const entry = persisted.find(e => e.receiptId === id);
			if (!entry) {
				blockers.push(`missing-validation-receipt:${id}`);
				continue;
			}
			const receipt = JSON.parse(await readFile(entry.path, "utf8")) as ReceiptEnvelope<ValidationEvidence>;
			if (!validateReceipt(receipt).valid) blockers.push(`validation-receipt-invalid:${id}`);
			else if (commit && receipt.evidence.commitUnderTest !== commit) blockers.push(`validation-stale-commit:${id}`);
		}
	}

	if (blockers.length > 0) {
		return {
			completed: false,
			receiptPath: null,
			validation,
			commitHash: commit,
			prUrl: artifact.prUrl,
			issueArtifact: artifact.issueArtifact,
			blockers,
		};
	}

	// 4. Completion receipt + predicate.
	const completion: CompletionEvidence = {
		finalCommit: commit ?? "",
		branch: opts.branch,
		prUrl: artifact.prUrl,
		issueArtifact: artifact.issueArtifact,
		requiredValidationReceiptIds: validationReceiptIds,
		finalLifecycle: "completed",
		finalizedAt: now(),
		blockers: [],
	};
	const receipt = buildReceipt<CompletionEvidence>({
		receiptId: receiptId("done"),
		sessionId: opts.sessionId,
		family: "completion",
		source: "finalizer",
		subject,
		evidence: completion,
		createdAt: now(),
	});
	const outcome = validateReceipt(receipt);
	const entry = await writeReceiptImmutable(opts.root, opts.sessionId, "completion", receipt.receiptId, receipt);
	return {
		completed: outcome.valid,
		receiptPath: entry.path,
		validation,
		commitHash: commit,
		prUrl: artifact.prUrl,
		issueArtifact: artifact.issueArtifact,
		blockers: outcome.valid ? [] : outcome.reasons,
	};
}

/**
 * Review-only finalizer: produces a terminal verdict receipt (no implementation validation,
 * no commit/PR resolution) when a valid, autonomous verdict is supplied; otherwise writes a
 * durable, bounded `review-failure` receipt suitable for fallback routing.
 *
 * It never *resolves* PR/commit metadata from the live repo; the only PR reference attached is
 * the session's own declared review target (`prTarget`), so a review session cannot report an
 * unrelated PR resolved from the current checkout.
 *
 * `OWNER_CONFIRMATION_REQUIRED` is a valid verdict but is NOT an autonomous success: it is
 * recorded durably yet returns `completed: false` with an `owner-confirmation-required` blocker
 * so downstream routing escalates to a human instead of treating it as merge-ready.
 */
async function runReviewFinalize(opts: FinalizeOptions): Promise<FinalizeResult> {
	const now = () => new Date(opts.clock ? opts.clock() : Date.now()).toISOString();
	const prTarget = opts.prTarget ?? null;
	const subject: ReceiptSubject = { workspace: opts.workspace, branch: opts.branch, head: null, commit: null };
	const baseResult: Omit<FinalizeResult, "completed" | "receiptPath" | "verdict" | "blockers"> = {
		validation: [],
		commitHash: null,
		prUrl: null,
		issueArtifact: null,
	};

	if (!isReviewVerdict(opts.verdict)) {
		const reason = opts.verdict == null ? "review-verdict-missing" : "review-verdict-invalid";
		const failure: ReviewFailureEvidence = { reason, prTarget, failedAt: now(), fallback: "operator-or-omx-review" };
		const receipt = buildReceipt<ReviewFailureEvidence>({
			receiptId: receiptId("revfail"),
			sessionId: opts.sessionId,
			family: "review-failure",
			source: "finalizer",
			subject,
			evidence: failure,
			createdAt: now(),
		});
		const outcome = validateReceipt(receipt);
		const entry = await writeReceiptImmutable(
			opts.root,
			opts.sessionId,
			"review-failure",
			receipt.receiptId,
			receipt,
		);
		const blockers = outcome.valid ? [reason] : [reason, ...outcome.reasons];
		return { ...baseResult, completed: false, receiptPath: entry.path, verdict: null, blockers };
	}

	const verdict = opts.verdict as ReviewVerdict;
	const evidence: ReviewVerdictEvidence = {
		verdict,
		prTarget,
		finalizedAt: now(),
		summaryRef: typeof opts.prTarget === "string" ? `verdict:${verdict}@${opts.prTarget}` : `verdict:${verdict}`,
	};
	const receipt = buildReceipt<ReviewVerdictEvidence>({
		receiptId: receiptId("verdict"),
		sessionId: opts.sessionId,
		family: "review-verdict",
		source: "finalizer",
		subject,
		evidence,
		createdAt: now(),
	});
	const outcome = validateReceipt(receipt);
	const entry = await writeReceiptImmutable(opts.root, opts.sessionId, "review-verdict", receipt.receiptId, receipt);
	// A confirmation-required verdict is recorded but never an autonomous success.
	const humanActionRequired = verdict === "OWNER_CONFIRMATION_REQUIRED";
	const completed = outcome.valid && !humanActionRequired;
	const blockers = !outcome.valid ? outcome.reasons : humanActionRequired ? ["owner-confirmation-required"] : [];
	return { ...baseResult, completed, receiptPath: entry.path, verdict, blockers };
}
function git(workspace: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd: workspace,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

/** Real checks: git for commit/branch, gh for PR, Bun.spawn for validation commands. */
export function defaultFinalizeChecks(workspace: string): FinalizeChecks {
	return {
		async runValidation(spec) {
			const proc = Bun.spawnSync(["bash", "-lc", spec.command], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
			const exitStatus = proc.exitCode ?? 1;
			return { exactCommand: spec.command, cwd: workspace, exitStatus, pass: exitStatus === 0 };
		},
		async resolveCommit() {
			return git(workspace, ["rev-parse", "HEAD"]);
		},
		async commitOnBranch(commit, branch) {
			const merged = git(workspace, ["branch", "--contains", commit, "--format=%(refname:short)"]);
			if (!merged) return false;
			return merged.split("\n").some(b => b.trim() === branch);
		},
		async prOrIssue() {
			try {
				const out = execFileSync("gh", ["pr", "view", "--json", "url", "-q", ".url"], {
					cwd: workspace,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
				return { prUrl: out || null, issueArtifact: null };
			} catch {
				return { prUrl: null, issueArtifact: null };
			}
		},
	};
}
