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
 * Strictly best effort. Every failure is logged and swallowed: the prompt still
 * fails with `prompt_deadline_exceeded` and teardown still happens, because the
 * deadline outcome must never depend on git.
 */

import { logger } from "@gajae-code/utils";
import * as git from "../utils/git";

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
 * Commit any uncommitted work in the worktree owning `cwd`.
 *
 * Returns `undefined` — without running any mutating git command — when `cwd`
 * is not inside a git worktree, when the tree is already clean, or when git
 * fails. Only the session's own worktree is touched; nothing is ever pushed.
 */
export async function flushWorktreeOnPromptDeadline(cwd: string): Promise<PromptDeadlineFlushResult | undefined> {
	try {
		const worktreeRoot = await git.repo.root(cwd);
		if (!worktreeRoot) return undefined;
		const summary = await git.status.summary(worktreeRoot);
		if (!summary) return undefined;
		if (summary.staged + summary.unstaged + summary.untracked === 0) return undefined;
		const headState = await git.head.resolve(worktreeRoot);
		const branch = headState?.kind === "ref" ? (headState.branchName ?? undefined) : undefined;
		// Serialize against other in-process git writers on this repo; the lock is
		// keyed by primary repo root, so sibling worktrees share one queue.
		const commit = await git.withRepoLock(worktreeRoot, async () => {
			await git.stage.files(worktreeRoot);
			await git.commit(worktreeRoot, wipCommitMessage(branch));
			return git.head.short(worktreeRoot);
		});
		if (!commit) return undefined;
		logger.warn(
			`sdk: prompt deadline exceeded with a dirty worktree; autosaved the uncommitted work as ${commit}` +
				`${branch ? ` on ${branch}` : ""} in ${worktreeRoot}`,
		);
		return { commit, worktreeRoot, ...(branch === undefined ? {} : { branch }) };
	} catch (error) {
		logger.warn(
			`sdk: prompt deadline worktree autosave failed; uncommitted work was left in place: ${String(error)}`,
		);
		return undefined;
	}
}
