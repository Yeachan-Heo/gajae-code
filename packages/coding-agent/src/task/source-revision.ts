/**
 * Source-snapshot fencing for review-capable task results (#3469).
 *
 * Detached review subagents must be bound to the worktree identity they
 * inspected. When the parent advances HEAD or dirties the tree after spawn,
 * late deliveries are marked stale so completion gates can reject them.
 */
import { createHash } from "node:crypto";
import * as git from "../utils/git";

/** Fixed hash used when there is no git worktree (or capture failed closed). */
export const EMPTY_WORKTREE_DIFF_SHA256 = createHash("sha256").update("").digest("hex");

export type TaskSourceRevision = {
	/** `git rev-parse HEAD`, or null outside a git checkout. */
	head: string | null;
	/** Cheap fingerprint of dirty worktree content relative to HEAD. */
	worktreeDiffSha256: string;
	/** ISO-8601 capture timestamp. */
	capturedAt: string;
};

export type TaskSourceStatus = "current" | "stale";

export const STALE_SOURCE_GUIDANCE =
	"Worktree changed since this review started; rerun on the current snapshot. Stale results are advisory only and must not satisfy completion gates.";

/**
 * True for agents whose results may be treated as review evidence by
 * orchestrators. Ordinary `executor` implementation tasks omit fencing.
 */
export function isReviewCapableAgent(name: string, _agentSource?: string): boolean {
	const n = name.toLowerCase().trim();
	if (n === "architect" || n === "critic" || n === "planner") return true;
	return n.includes("review") || n.includes("qa");
}

function sha256Hex(material: string): string {
	return createHash("sha256").update(material).digest("hex");
}

/**
 * Build a cheap, content-sensitive fingerprint of the worktree vs HEAD.
 *
 * Material:
 * - `git diff HEAD` (staged + unstaged content vs HEAD)
 * - `git status --porcelain=v1` (tracked dirty names + untracked names)
 *
 * HEAD itself is stored separately so a clean checkout still detects commits.
 */
async function hashWorktreeDiff(cwd: string): Promise<string> {
	const [diffText, statusText] = await Promise.all([
		git.diff(cwd, { base: "HEAD", allowFailure: true }),
		git.status(cwd, { porcelainV1: true }).catch(() => ""),
	]);
	return sha256Hex(`diff:\n${diffText}\nstatus:\n${statusText}`);
}

/** Capture the source identity the subagent is about to inspect. */
export async function captureTaskSourceRevision(cwd: string): Promise<TaskSourceRevision> {
	const capturedAt = new Date().toISOString();
	const repository = await git.repo.resolve(cwd);
	if (!repository) {
		return {
			head: null,
			worktreeDiffSha256: EMPTY_WORKTREE_DIFF_SHA256,
			capturedAt,
		};
	}

	const head = await git.head.sha(cwd);
	let worktreeDiffSha256 = EMPTY_WORKTREE_DIFF_SHA256;
	try {
		worktreeDiffSha256 = await hashWorktreeDiff(cwd);
	} catch {
		// Fail closed to empty hash rather than aborting spawn; equality still works.
		worktreeDiffSha256 = EMPTY_WORKTREE_DIFF_SHA256;
	}

	return {
		head,
		worktreeDiffSha256,
		capturedAt,
	};
}

/** Structural equality of two captured revisions (ignores capturedAt). */
export function sourceRevisionsEqual(a: TaskSourceRevision, b: TaskSourceRevision): boolean {
	return a.head === b.head && a.worktreeDiffSha256 === b.worktreeDiffSha256;
}

/**
 * Recompute the live worktree fingerprint and compare against the reviewed
 * snapshot. Returns `"stale"` when HEAD or dirty content diverged.
 */
export async function classifyTaskSourceFreshness(
	cwd: string,
	reviewed: TaskSourceRevision,
): Promise<TaskSourceStatus> {
	const current = await captureTaskSourceRevision(cwd);
	return sourceRevisionsEqual(reviewed, current) ? "current" : "stale";
}

/**
 * Attach reviewed snapshot + live freshness fields for a completed result.
 * Returns an empty object when no reviewed revision was captured (non-review agents).
 */
export async function resolveSourceFreshnessFields(
	cwd: string,
	reviewed: TaskSourceRevision | undefined,
): Promise<{
	sourceRevision?: TaskSourceRevision;
	sourceStatus?: TaskSourceStatus;
	sourceGuidance?: string;
}> {
	if (!reviewed) return {};
	const sourceStatus = await classifyTaskSourceFreshness(cwd, reviewed);
	return {
		sourceRevision: reviewed,
		sourceStatus,
		...(sourceStatus === "stale" ? { sourceGuidance: STALE_SOURCE_GUIDANCE } : {}),
	};
}
