/**
 * Worktree durability for a prompt retired by its deadline (#5583).
 *
 * A raised `sdk.promptDeadlineMs` makes the crash rarer, never impossible: the
 * hard `sdk.promptMaxRuntimeMs` cap still fires on a long run, and the session
 * is then torn down with whatever the agent already edited still uncommitted.
 * Field reports lost ~25 minutes of finished work across 37 dirty files that
 * way. Persist that work as a WIP commit in the agent's own worktree before
 * teardown so the next run resumes from a commit instead of re-reasoning.
 *
 * Strictly best effort AND strictly bounded. Every failure — including an abort —
 * is logged and swallowed: the prompt still fails with `prompt_deadline_exceeded`
 * and teardown still happens, because the deadline outcome must never depend on
 * git. Every git call that accepts a signal gets one, so a blocking lock,
 * credential prompt, or hanging commit hook is killed rather than waited on.
 *
 * Policy note: this stages the whole dirty worktree (`git add -A`, untracked
 * files included) and runs the repository's normal commit hooks. Narrowing that
 * is deliberately out of scope here — see the #5623 review discussion.
 *
 * Index guarantee: an attempt that produces no commit leaves the index exactly
 * as it found it. Staging the whole worktree is a visible mutation, so the index
 * is snapshotted with `git write-tree` first and restored with `git read-tree`
 * when a failing commit hook or an abort lands between the staging and the
 * commit. An index that cannot be snapshotted is never staged at all.
 */

import { logger } from "@gajae-code/utils";
import * as git from "../utils/git";
import { DEADLINE_FLUSH_TIMEOUT_MS } from "./prompt-deadline-manager";

/**
 * Independent bound for the index restore. Deliberately NOT composed with the
 * flush's own signal: on the abort path that signal is already aborted, so a
 * restore issued under it could never run and the rollback would be vacuous on
 * exactly one of the two failure modes it exists for. Short, because it guards a
 * single local `git read-tree` after the deadline has already been decided.
 */
const INDEX_RESTORE_TIMEOUT_MS = 5_000;

export interface PromptDeadlineFlushResult {
	/** Branch the WIP commit landed on, or `undefined` on a detached HEAD. */
	branch?: string;
	/** Abbreviated SHA of the WIP commit. */
	commit: string;
	/** Worktree root the commit was made in. */
	worktreeRoot: string;
}

function wipCommitMessage(branch: string | undefined): string {
	return `wip(${branch ?? "detached"}): autosave on prompt deadline\n`;
}

/**
 * Roll the index back to `tree` after an autosave attempt that staged but never
 * committed. Best effort like everything else here; returns whether the index is
 * back to what the user had.
 */
async function restoreIndex(worktreeRoot: string, tree: string): Promise<boolean> {
	try {
		// Plain `read-tree` is index-only: the user's file edits stay untouched.
		await git.readTree(worktreeRoot, tree, { signal: AbortSignal.timeout(INDEX_RESTORE_TIMEOUT_MS) });
		return true;
	} catch (error) {
		logger.warn(
			`sdk: prompt deadline worktree autosave could not restore the index it staged in ${worktreeRoot}; ` +
				`recover it with \`git read-tree ${tree}\`: ${String(error)}`,
		);
		return false;
	}
}

/**
 * Commit any uncommitted work in the worktree owning `cwd`.
 *
 * Returns `undefined` — without running any mutating git command — when `cwd`
 * is not inside a git worktree, when the tree is already clean, or when git
 * fails or is aborted. Only the session's own worktree is touched; nothing is
 * ever pushed.
 *
 * `signal` is composed with an internal `DEADLINE_FLUSH_TIMEOUT_MS` bound, so a
 * caller that passes nothing still cannot hang here.
 */
export async function flushWorktreeOnPromptDeadline(
	cwd: string,
	signal?: AbortSignal,
): Promise<PromptDeadlineFlushResult | undefined> {
	const timeout = AbortSignal.timeout(DEADLINE_FLUSH_TIMEOUT_MS);
	const bound = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
	// Whether the user's index is as they left it. Only a failed rollback of a
	// staged-but-uncommitted attempt can falsify it.
	let indexRestored = true;
	try {
		const worktreeRoot = await git.repo.root(cwd, bound);
		if (!worktreeRoot) return undefined;
		const summary = await git.status.summary(worktreeRoot, bound);
		if (!summary) return undefined;
		if (summary.staged + summary.unstaged + summary.untracked === 0) return undefined;
		// `head.resolve` reads .git files directly and takes no signal.
		const headState = await git.head.resolve(worktreeRoot);
		const branch = headState?.kind === "ref" ? (headState.branchName ?? undefined) : undefined;
		// Serialize against other in-process git writers on this repo; the lock is
		// keyed by primary repo root, so sibling worktrees share one queue. Note
		// that `withRepoLock` awaits its predecessor BEFORE honouring the signal,
		// so a hung predecessor is bounded by the caller's race, not by `bound`.
		const commit = await git.withRepoLock(
			worktreeRoot,
			async () => {
				// Snapshot the index BEFORE mutating it. `git write-tree` refuses on an
				// unmerged index, and an autosave that cannot be rolled back must not
				// start: better no autosave than a silently restaged conflict.
				let snapshot: string;
				try {
					snapshot = await git.writeTree(worktreeRoot, { signal: bound });
				} catch (error) {
					logger.warn(
						`sdk: prompt deadline worktree autosave skipped; the index in ${worktreeRoot} could not be ` +
							`snapshotted so nothing was staged: ${String(error)}`,
					);
					return undefined;
				}
				// Set before staging, not after: a `git add -A` that fails partway has
				// still moved the index, so the rollback must cover that too.
				let stagedWithoutCommit = true;
				try {
					await git.stage.files(worktreeRoot, [], bound);
					await git.commit(worktreeRoot, wipCommitMessage(branch), { signal: bound });
					// The commit landed, so the index legitimately matches the new HEAD.
					// Restoring the snapshot now would leave a phantom "revert it all"
					// staged diff, so a failure of the sha read below must NOT roll back.
					stagedWithoutCommit = false;
					return await git.head.short(worktreeRoot, 7, bound);
				} finally {
					if (stagedWithoutCommit) indexRestored = await restoreIndex(worktreeRoot, snapshot);
				}
			},
			bound,
		);
		if (!commit) return undefined;
		logger.warn(
			`sdk: prompt deadline exceeded with a dirty worktree; autosaved the uncommitted work as ${commit}` +
				`${branch ? ` on ${branch}` : ""} in ${worktreeRoot}`,
		);
		return { commit, worktreeRoot, ...(branch === undefined ? {} : { branch }) };
	} catch (error) {
		logger.warn(
			indexRestored
				? `sdk: prompt deadline worktree autosave failed; uncommitted work was left in place: ${String(error)}`
				: `sdk: prompt deadline worktree autosave failed and its staged index could not be rolled back ` +
						`(see the restore warning above): ${String(error)}`,
		);
		return undefined;
	}
}
