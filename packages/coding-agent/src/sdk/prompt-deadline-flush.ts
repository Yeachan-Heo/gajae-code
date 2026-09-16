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
 */

import { logger } from "@gajae-code/utils";
import * as git from "../utils/git";
import { DEADLINE_FLUSH_TIMEOUT_MS } from "./prompt-deadline-manager";

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
				await git.stage.files(worktreeRoot, [], bound);
				await git.commit(worktreeRoot, wipCommitMessage(branch), { signal: bound });
				return git.head.short(worktreeRoot, 7, bound);
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
			`sdk: prompt deadline worktree autosave failed; uncommitted work was left in place: ${String(error)}`,
		);
		return undefined;
	}
}
