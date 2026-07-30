/**
 * Durable git-worktree isolation for the `task` tool.
 *
 * This is the in-session counterpart to launching `gjc --worktree`: it provisions a real linked
 * git worktree through the same canonical entry point the CLI uses, so path/slug/bucket
 * resolution, reuse/dirty semantics, branch handling, and `node_modules` reuse are identical.
 *
 * Deliberately separate from `task/worktree.ts`, which owns the *disposable* PAL isolation
 * lifecycle. A durable worktree is the task's result artifact, not a teardown target: nothing
 * here removes directories, prunes worktrees, or calls `cleanupIsolation`.
 */

import type { GjcLaunchWorktreeMode, GjcLaunchWorktreeResult } from "../gjc-runtime/launch-worktree";
import { planLaunchWorktree, provisionGitWorktree } from "../gjc-runtime/launch-worktree";
import type { WorktreeBaseline } from "./worktree";
import { captureBaseline, captureDeltaPatch } from "./worktree";

/** Typed failure codes a durable-worktree request can surface to the caller. */
export type DurableWorktreeErrorCode =
	| "worktree_dirty"
	| "worktree_path_conflict"
	| "worktree_target_mismatch"
	| "branch_in_use"
	| "worktree_busy";

export interface DurableWorktreeError {
	code: DurableWorktreeErrorCode;
	message: string;
}

/** Receipt-safe description of the provisioned worktree. */
export interface DurableWorktreeInfo {
	path: string;
	identity: "detached" | "branch";
	branchName?: string;
	/** Source repository HEAD the worktree was planned against. */
	baseRef: string;
	/**
	 * The worktree's own checked-out HEAD.
	 *
	 * For a reused named branch this can differ from {@link DurableWorktreeInfo.baseRef} — the branch
	 * may already have advanced past the source repository's HEAD — so reporting `baseRef` alone would
	 * describe the artifact incorrectly.
	 */
	headRef?: string;
	created: boolean;
	reused: boolean;
	dirty?: boolean;
}

export type DurableWorktreeAcquisition =
	| { ok: true; worktreePath: string; info: DurableWorktreeInfo; baseline: WorktreeBaseline }
	| { ok: false; error: DurableWorktreeError };

/**
 * Canonical paths currently held by a running durable-worktree task in *this* process.
 *
 * Scope is deliberately process-local. Cross-process behaviour intentionally matches
 * `gjc --worktree` itself, which takes no lock: a matching worktree is reused, and genuine
 * conflicts fail closed through the typed guards below. Adding inter-process ownership the CLI
 * never had would make this path less `gjc --worktree`-identical, not more.
 */
const heldWorktreePaths = new Map<string, string>();

const ERROR_CODES: readonly DurableWorktreeErrorCode[] = [
	"worktree_dirty",
	"worktree_path_conflict",
	"worktree_target_mismatch",
	"branch_in_use",
];

/**
 * Map a `worktree: true | "<name>"` request onto the exact mode the CLI parser would produce.
 *
 * Only `true` selects detached mode. A supplied name is never silently downgraded to detached,
 * because that would hand back a different worktree identity than the caller asked for; blank
 * names are rejected upstream by the schema and by `validateDurableWorktreeRequest`.
 */
export function resolveWorktreeRequestMode(requested: true | string): GjcLaunchWorktreeMode {
	if (requested === true) return { enabled: true, detached: true, name: null };
	const name = requested.trim();
	if (!name) throw new Error("worktree_invalid_name: a worktree branch name cannot be blank");
	return { enabled: true, detached: false, name };
}

/** Concrete remediation per typed code, so the caller can act without reading the source. */
function remediationFor(code: DurableWorktreeErrorCode, message: string): string {
	switch (code) {
		case "worktree_dirty":
			return "The reused worktree has uncommitted changes and its base moved, so it cannot be fast-forwarded safely. Commit or stash the work in that worktree, or request a different `worktree` name.";
		case "worktree_path_conflict":
			return "Something already occupies the canonical worktree path but is not a registered worktree. Inspect it, move or delete it once you are sure it holds no work, then retry — or request a different `worktree` name.";
		case "branch_in_use":
			return "That branch is already checked out in another worktree. Finish or remove that worktree with `git worktree remove <path>`, or request a different `worktree` name.";
		default:
			// `worktree_target_mismatch` already ships a multi-line remediation from the launch runtime.
			return message.includes("\n")
				? ""
				: "Inspect the reported path and retry, or request a different `worktree` name.";
	}
}

function toDurableWorktreeError(err: unknown): DurableWorktreeError | null {
	const message = err instanceof Error ? err.message : String(err);
	const code = ERROR_CODES.find(candidate => message.startsWith(`${candidate}:`));
	if (!code) return null;
	const remediation = remediationFor(code, message);
	return { code, message: remediation ? `${message}\n${remediation}` : message };
}

/** Read the worktree's own HEAD; absent rather than wrong if it cannot be resolved. */
function readWorktreeHead(worktreePath: string): string | undefined {
	const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
		cwd: worktreePath,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return undefined;
	return result.stdout.toString().trim() || undefined;
}

function toDurableWorktreeInfo(result: GjcLaunchWorktreeResult): DurableWorktreeInfo {
	const headRef = readWorktreeHead(result.worktreePath);
	return {
		path: result.worktreePath,
		identity: result.detached ? "detached" : "branch",
		...(result.branchName ? { branchName: result.branchName } : {}),
		baseRef: result.baseRef,
		...(headRef ? { headRef } : {}),
		created: result.created,
		reused: result.reused,
		...(result.dirty ? { dirty: true } : {}),
	};
}

/**
 * Provision (or reuse) the durable worktree for a request and capture its pre-run baseline.
 *
 * On success the canonical path is held for the caller until {@link releaseDurableWorktree}.
 * Every failure path releases the hold before returning or rethrowing, so a provisioning or
 * baseline-capture error can never wedge the path for the rest of the process.
 */
export async function acquireDurableWorktree(
	repoRoot: string,
	requested: true | string,
	taskId: string,
): Promise<DurableWorktreeAcquisition> {
	const mode = resolveWorktreeRequestMode(requested);

	let worktreePath: string;
	try {
		const plan = planLaunchWorktree(repoRoot, mode);
		if (!plan.enabled) throw new Error("planLaunchWorktree returned a disabled plan for an enabled request");
		worktreePath = plan.worktreePath;
	} catch (err) {
		const typed = toDurableWorktreeError(err);
		if (typed) return { ok: false, error: typed };
		throw err;
	}

	const holder = heldWorktreePaths.get(worktreePath);
	if (holder !== undefined) {
		return {
			ok: false,
			error: {
				code: "worktree_busy",
				message: `worktree_busy:${worktreePath}\nAnother task in this session (${holder}) is already using this worktree. Wait for it to finish or request a different --worktree name.`,
			},
		};
	}
	heldWorktreePaths.set(worktreePath, taskId);

	try {
		const provisioned = provisionGitWorktree(repoRoot, mode);
		if (!provisioned.worktree.enabled) {
			throw new Error("provisionGitWorktree returned a disabled worktree for an enabled request");
		}
		const info = toDurableWorktreeInfo(provisioned.worktree);
		const baseline = await captureBaseline(info.path);
		// The resolved path is authoritative; re-key the hold if `ensureLaunchWorktree` normalised it.
		if (info.path !== worktreePath) {
			heldWorktreePaths.delete(worktreePath);
			heldWorktreePaths.set(info.path, taskId);
		}
		return { ok: true, worktreePath: info.path, info, baseline };
	} catch (err) {
		heldWorktreePaths.delete(worktreePath);
		const typed = toDurableWorktreeError(err);
		if (typed) return { ok: false, error: typed };
		throw err;
	}
}

/**
 * Release the process-local hold on a durable worktree.
 *
 * Guard bookkeeping only: the worktree itself is the task's durable result and is never removed,
 * pruned, or reset here — exactly as `gjc --worktree` leaves it.
 */
export function releaseDurableWorktree(worktreePath: string): void {
	heldWorktreePaths.delete(worktreePath);
}

/**
 * Re-read the worktree's HEAD after the subagent has finished.
 *
 * Provisioning-time HEAD describes where the worktree *started*. A subagent that commits inside it
 * moves HEAD, so the durable artifact must be reported at the ref it actually ended on — otherwise
 * the result points at a commit the work is no longer at.
 */
export function refreshDurableWorktreeHead(info: DurableWorktreeInfo): DurableWorktreeInfo {
	const headRef = readWorktreeHead(info.path);
	return headRef ? { ...info, headRef } : info;
}

/**
 * Whether the subagent left any change in the durable worktree.
 *
 * Reuses the same delta capture the PAL path uses (committed, staged, unstaged, untracked, and
 * nested-repo changes), but only to answer yes/no: the patch text is discarded, never applied and
 * never published, because the worktree itself is the deliverable.
 */
export async function computeProducedChanges(worktreePath: string, baseline: WorktreeBaseline): Promise<boolean> {
	const delta = await captureDeltaPatch(worktreePath, baseline);
	return delta.rootPatch.trim().length > 0 || delta.nestedPatches.some(patch => patch.patch.trim().length > 0);
}
