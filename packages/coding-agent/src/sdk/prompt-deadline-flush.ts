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
 * git. Every git call that accepts a signal gets one, so a blocking lock or a
 * hanging plumbing command is killed rather than waited on.
 *
 * ── Isolated index, plumbing commit, compare-and-swap ref move (#5623 round 4)
 *
 * The autosave never opens the user's real `.git/index` for writing and never
 * runs a repository hook:
 *
 *   1. everything is staged into a throwaway index inside the worktree's own git
 *      dir (`GIT_INDEX_FILE`), seeded from the HEAD captured before staging;
 *   2. the commit is built with plumbing — `write-tree` then `commit-tree` — so
 *      `pre-commit`/`commit-msg` cannot execute during teardown;
 *   3. the ref moves with a compare-and-swap against that captured HEAD, so the
 *      one mutation that can outlive teardown is conditional: an abandoned flush
 *      that wakes up late finds HEAD moved and does nothing. `withRepoLock`
 *      awaits its predecessor BEFORE honouring the signal, so this really does
 *      happen — the abort alone cannot prevent it;
 *   4. the real index is adopted only after that swap succeeds, so a successful
 *      autosave leaves `git status` clean instead of a phantom reverse diff.
 *
 * Every failing and aborted path therefore just unlinks the temp index. There is
 * no rollback left to get wrong, and index-only state the user set — intent-to-add,
 * skip-worktree/assume-unchanged, sparse-index, index extensions — survives byte
 * for byte because the file was never written.
 *
 * ── Ownership
 *
 * Staging the whole dirty worktree (`git add -A`, untracked files included) is
 * the point: the work being saved is whatever the agent touched, and narrowing
 * it would strand exactly the files this exists for. What makes that safe is
 * WHERE it runs. `sdk.flushWorktreeOnDeadline` still defaults to on, but the
 * implicit default applies only in a LINKED worktree (`gitDir !== commonDir`) —
 * what agent/paseo sessions run in, and the #5583 field report. In the user's
 * primary checkout an autosave needs an explicit opt-in.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
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

export interface PromptDeadlineFlushOptions {
	/**
	 * Whether the caller resolved `sdk.flushWorktreeOnDeadline` to `true` from a
	 * value the user actually wrote, rather than from the schema default. Only an
	 * explicit opt-in may autosave outside a linked worktree.
	 */
	readonly explicitOptIn?: boolean;
	/**
	 * Whether the deadline attempt still owns the prompt. The callback is checked
	 * immediately before the ref move and again before the real index is adopted,
	 * so progress that renews the lease can abandon the prepared WIP safely.
	 */
	readonly isCurrent?: () => boolean;
	readonly signal?: AbortSignal;
}

function wipCommitMessage(branch: string | undefined): string {
	return `wip(${branch ?? "detached"}): autosave on prompt deadline\n`;
}

/** Porcelain v1 XY codes for a path with unresolved merge stages. */
const UNMERGED_STATUS_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const AUTOSAVE_PATHS = [":(top)**", ":(top,exclude).gjc/agents/**", ":(top,exclude).gjc/skills/**"] as const;

type IndexSnapshot = Uint8Array | undefined;

async function snapshotIndex(indexPath: string): Promise<IndexSnapshot> {
	try {
		return await fsp.readFile(indexPath);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function sameBytes(left: IndexSnapshot, right: IndexSnapshot): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
	return true;
}

function sameHeadIdentity(
	current: git.GitHeadState | null,
	captured: git.GitHeadState,
	expectedCommit: string | null,
): boolean {
	if (!current) return false;
	if (
		path.resolve(current.repoRoot) !== path.resolve(captured.repoRoot) ||
		path.resolve(current.gitDir) !== path.resolve(captured.gitDir) ||
		path.resolve(current.commonDir) !== path.resolve(captured.commonDir) ||
		current.kind !== captured.kind ||
		current.commit !== expectedCommit
	)
		return false;
	if (current.kind === "ref" && captured.kind === "ref")
		return current.ref === captured.ref && current.headContent === captured.headContent;
	return true;
}

/**
 * Whether the repository is mid-conflict. Staging into an isolated index seeded
 * from HEAD would happily commit the conflict markers and then adopt a resolved
 * index over the user's unresolved one, so a conflicted repo is left alone.
 */
function hasUnmergedPaths(statusText: string): boolean {
	return statusText.split("\n").some(line => UNMERGED_STATUS_CODES.has(line.slice(0, 2)));
}

/**
 * A session owns its checkout when it runs in a linked worktree: those are
 * created per agent/task and have their own git dir pointing back at the shared
 * common dir. A primary checkout is the user's, and `git add -A` there would
 * commit whatever they happen to have open alongside the agent.
 */
function isLinkedWorktree(repository: git.GitRepository): boolean {
	return path.resolve(repository.gitDir) !== path.resolve(repository.commonDir);
}

/**
 * Commit any uncommitted work in the worktree owning `cwd`.
 *
 * Returns `undefined` — without moving any ref — when `cwd` is not inside a git
 * worktree, when the tree is already clean, when the session does not own the
 * checkout, or when git fails or is aborted. Only the session's own worktree is
 * touched; nothing is ever pushed.
 *
 * The abort signal is composed with an internal `DEADLINE_FLUSH_TIMEOUT_MS`
 * bound, so a caller that passes nothing still cannot hang here.
 */
export async function flushWorktreeOnPromptDeadline(
	cwd: string,
	options?: AbortSignal | PromptDeadlineFlushOptions,
): Promise<PromptDeadlineFlushResult | undefined> {
	const {
		explicitOptIn = false,
		isCurrent,
		signal,
	} = options instanceof AbortSignal ? { signal: options } : (options ?? {});
	const timeout = AbortSignal.timeout(DEADLINE_FLUSH_TIMEOUT_MS);
	const bound = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
	try {
		// One resolution for the root, the git dir (where the temp index lives) and
		// the common dir (the ownership signal). A repository we cannot resolve is
		// one we cannot place a temp index in, so it is left alone.
		const repository = await git.repo.resolve(cwd);
		if (!repository) return undefined;
		const worktreeRoot = repository.repoRoot;
		if (!explicitOptIn && !isLinkedWorktree(repository)) {
			logger.debug(
				`sdk: prompt deadline worktree autosave skipped; ${worktreeRoot} is a primary checkout the session does ` +
					`not own. Set sdk.flushWorktreeOnDeadline to true to autosave here anyway.`,
			);
			return undefined;
		}
		const statusText = await git.status(worktreeRoot, { porcelainV1: true, signal: bound });
		const summary = git.status.parse(statusText);
		if (summary.staged + summary.unstaged + summary.untracked === 0) return undefined;
		if (hasUnmergedPaths(statusText)) {
			logger.warn(
				`sdk: prompt deadline worktree autosave skipped; ${worktreeRoot} has an unmerged index and autosaving ` +
					`would commit conflict markers over it.`,
			);
			return undefined;
		}
		// `head.resolve` reads .git files directly and takes no signal.
		const headState = await git.head.resolve(worktreeRoot);
		if (!headState) return undefined;
		const branch = headState?.kind === "ref" ? (headState.branchName ?? undefined) : undefined;
		// Captured HERE, before the repo lock rather than inside it, because this is
		// the value the adoption below is conditional on: an autosave may only land
		// on the HEAD the deadline saw. `withRepoLock` awaits its predecessor before
		// honouring the signal, so the wait between this line and the swap is
		// genuinely unbounded, and anything that moved HEAD in between wins.
		const headSha = await git.head.sha(worktreeRoot, bound);
		const indexPath = path.join(repository.gitDir, "index");
		const indexSnapshot = await snapshotIndex(indexPath);
		// The ref adoption targets. On a detached HEAD that is HEAD itself;
		// otherwise the branch ref, so the swap cannot be confused by a checkout.
		const refName = headState?.kind === "ref" ? headState.ref : "HEAD";
		// Serialize against other in-process git writers on this repo; the lock is
		// keyed by primary repo root, so sibling worktrees share one queue.
		const commit = await git.withRepoLock(
			worktreeRoot,
			() =>
				autosave(
					repository,
					{ headState, headSha, indexPath, indexSnapshot, message: wipCommitMessage(branch), refName },
					bound,
					isCurrent,
				),
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

/**
 * Build and adopt the WIP commit. Runs under the repo write lock; returns the
 * abbreviated SHA, or `undefined` when the swap was refused because HEAD moved.
 */
async function autosave(
	repository: git.GitRepository,
	target: {
		headSha: string | null;
		headState: git.GitHeadState;
		indexPath: string;
		indexSnapshot: IndexSnapshot;
		message: string;
		refName: string;
	},
	bound: AbortSignal,
	isCurrent?: () => boolean,
): Promise<string | undefined> {
	const worktreeRoot = repository.repoRoot;
	const { headSha, headState, indexPath, indexSnapshot, message, refName } = target;
	// Inside the git dir, never the worktree (where it would show up as untracked
	// and be staged by our own `add -A`) and never /tmp (a different filesystem
	// breaks git's rename-into-place).
	const indexFile = path.join(repository.gitDir, `gjc-deadline-index-${crypto.randomUUID()}`);
	const env = { GIT_INDEX_FILE: indexFile };
	try {
		// Checkout and staging/index mutations are outside the in-process repo lock.
		// Revalidate both the worktree identity and the real index before copying the
		// live tree into the isolated index; otherwise a concurrent checkout can put
		// the new branch's files on the captured branch.
		if (
			isCurrent?.() === false ||
			!sameHeadIdentity(await git.head.resolve(worktreeRoot), headState, headSha) ||
			!sameBytes(await snapshotIndex(indexPath), indexSnapshot)
		)
			return undefined;
		// A missing index file is an empty index, which is already correct for an
		// unborn HEAD; otherwise seed from the commit the swap is conditional on.
		if (headSha) await git.readTree(worktreeRoot, headSha, { env, signal: bound });
		// `read-tree` above only touched the scratch index, but it still yielded to
		// checkout/index writers. Recheck immediately before staging live files.
		if (
			isCurrent?.() === false ||
			!sameHeadIdentity(await git.head.resolve(worktreeRoot), headState, headSha) ||
			!sameBytes(await snapshotIndex(indexPath), indexSnapshot)
		)
			return undefined;
		await git.stage.files(worktreeRoot, AUTOSAVE_PATHS, { env, signal: bound });
		const tree = await git.writeTree(worktreeRoot, { env, signal: bound });
		// `git status` counts paths git will not necessarily commit (a dirty
		// submodule at the same SHA, for one). Without this an autosave could land
		// an empty WIP commit, which `git commit` used to refuse for us.
		if (headSha && tree === (await git.ref.resolve(worktreeRoot, `${headSha}^{tree}`, bound))) return undefined;
		const created = await git.commitTree(worktreeRoot, tree, message, {
			parents: headSha ? [headSha] : [],
			signal: bound,
		});
		// A progress renewal or checkout can happen while the plumbing objects are
		// being prepared. Check again immediately before the irreversible ref CAS.
		if (
			isCurrent?.() === false ||
			!sameHeadIdentity(await git.head.resolve(worktreeRoot), headState, headSha) ||
			!sameBytes(await snapshotIndex(indexPath), indexSnapshot)
		)
			return undefined;
		try {
			await git.ref.update(worktreeRoot, refName, created, headSha ?? "", { reason: message, signal: bound });
		} catch (error) {
			// The expected-old-value check failed (or the ref is locked): someone
			// moved HEAD while this flush was queued or abandoned. Their commit wins;
			// we never retry and never force.
			logger.warn(
				`sdk: prompt deadline worktree autosave abandoned; ${refName} in ${worktreeRoot} moved after the ` +
					`autosave was prepared, so nothing was adopted: ${String(error)}`,
			);
			return undefined;
		}
		// Only now is it safe to touch the real index: it matches the commit that
		// is genuinely HEAD, so `git status` reads clean. This is index-only — the
		// user's files are not rewritten.
		if (
			isCurrent?.() === false ||
			!sameHeadIdentity(await git.head.resolve(worktreeRoot), headState, created) ||
			!sameBytes(await snapshotIndex(indexPath), indexSnapshot)
		)
			return created.slice(0, 7);
		try {
			await git.readTree(worktreeRoot, created, { signal: bound });
		} catch (error) {
			logger.warn(
				`sdk: prompt deadline worktree autosave committed ${created} but could not adopt it into the index in ` +
					`${worktreeRoot}; recover with \`git reset\`: ${String(error)}`,
			);
		}
		return created.slice(0, 7);
	} finally {
		// The real index was never written, so unlinking the scratch one is the
		// whole cleanup. `.lock` is git's in-progress sibling, stranded only if a
		// plumbing command was killed mid-write.
		await Promise.all([indexFile, `${indexFile}.lock`].map(file => fsp.rm(file, { force: true }).catch(() => {})));
	}
}
