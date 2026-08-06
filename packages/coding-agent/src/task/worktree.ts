import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type * as natives from "@gajae-code/natives";

import { getWorktreeDir, hashPath, logger, Snowflake } from "@gajae-code/utils";
import * as git from "../utils/git";

let nativeWorktreeBindings: typeof import("@gajae-code/natives") | undefined;

function nativeWorktree(): typeof import("@gajae-code/natives") {
	if (!nativeWorktreeBindings)
		nativeWorktreeBindings = require("@gajae-code/natives") as typeof import("@gajae-code/natives");
	return nativeWorktreeBindings;
}

type IsoBackendKind = natives.IsoBackendKind;

/** Baseline state for a single git repository. */
export interface RepoBaseline {
	repoRoot: string;
	headCommit: string;
	staged: string;
	unstaged: string;
	untracked: string[];
	untrackedPatch: string;
}

/** Baseline state for the project, including any nested git repos. */
export interface WorktreeBaseline {
	root: RepoBaseline;
	/** Nested git repos (path relative to root.repoRoot). */
	nested: Array<{ relativePath: string; baseline: RepoBaseline }>;
}

export async function getRepoRoot(cwd: string): Promise<string> {
	const repoRoot = await git.repo.root(cwd);
	if (!repoRoot) {
		throw new Error("Git repository not found for isolated task execution.");
	}

	return repoRoot;
}

const GIT_NO_INDEX_NULL_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

export function getGitNoIndexNullPath(): string {
	return GIT_NO_INDEX_NULL_PATH;
}

/** Find nested git repositories (non-submodule) under the given root. */
async function discoverNestedRepos(repoRoot: string): Promise<string[]> {
	// Get submodule paths so we can exclude them
	const submodulePaths = new Set(await git.ls.submodules(repoRoot));

	// Find all .git dirs/files that aren't the root or known submodules
	const result: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(repoRoot, full);
			// Check if this directory is itself a git repo
			const gitDir = path.join(full, ".git");
			let hasGit = false;
			try {
				await fs.access(gitDir);
				hasGit = true;
			} catch {}
			if (hasGit && !submodulePaths.has(rel)) {
				result.push(rel);
				// Don't recurse into nested repos — they manage their own tree
				continue;
			}
			await walk(full);
		}
	}
	await walk(repoRoot);
	return result;
}

async function captureUntrackedPatch(repoRoot: string, untracked: readonly string[]): Promise<string> {
	if (untracked.length === 0) return "";
	const nullPath = getGitNoIndexNullPath();
	const untrackedDiffs = await Promise.all(
		untracked.map(async entry => {
			const absolutePath = path.join(repoRoot, entry);
			const stat = await fs.lstat(absolutePath);
			if (stat.isFile()) {
				const handle = await fs.open(absolutePath, "r");
				await handle.close();
			}
			return await git.diff(repoRoot, {
				allowFailure: true,
				binary: true,
				noIndex: { left: nullPath, right: entry },
			});
		}),
	);
	return untrackedDiffs.filter(diff => diff.trim()).join("\n");
}

async function captureRepoBaseline(repoRoot: string): Promise<RepoBaseline> {
	const headCommit = (await git.head.sha(repoRoot)) ?? "";
	const staged = await git.diff(repoRoot, { binary: true, cached: true });
	const unstaged = await git.diff(repoRoot, { binary: true });
	const untracked = await git.ls.untracked(repoRoot);
	const untrackedPatch = await captureUntrackedPatch(repoRoot, untracked);
	return { repoRoot, headCommit, staged, unstaged, untracked, untrackedPatch };
}

async function writeSyntheticTree(repoDir: string, baseTreeish: string, patches: readonly string[]): Promise<string> {
	const tempIndex = path.join(os.tmpdir(), `gjc-task-index-${Snowflake.next()}`);
	try {
		await git.readTree(repoDir, baseTreeish, {
			env: { GIT_INDEX_FILE: tempIndex },
		});
		for (const patch of patches) {
			if (!patch.trim()) continue;
			await git.patch.applyText(repoDir, patch, {
				cached: true,
				env: { GIT_INDEX_FILE: tempIndex },
			});
		}
		return await git.writeTree(repoDir, {
			env: { GIT_INDEX_FILE: tempIndex },
		});
	} finally {
		await fs.rm(tempIndex, { force: true });
	}
}

export async function captureBaseline(repoRoot: string): Promise<WorktreeBaseline> {
	const [root, nestedPaths] = await Promise.all([captureRepoBaseline(repoRoot), discoverNestedRepos(repoRoot)]);
	const nested = await Promise.all(
		nestedPaths.map(async relativePath => ({
			relativePath,
			baseline: await captureRepoBaseline(path.join(repoRoot, relativePath)),
		})),
	);
	return { root, nested };
}

async function captureRepoCurrentTree(repoDir: string): Promise<string> {
	const currentHead = (await git.head.sha(repoDir)) ?? "";
	const currentStaged = await git.diff(repoDir, { binary: true, cached: true });
	const currentUnstaged = await git.diff(repoDir, { binary: true });
	const currentUntracked = await git.ls.untracked(repoDir);
	const currentUntrackedPatch = await captureUntrackedPatch(repoDir, currentUntracked);
	return await writeSyntheticTree(repoDir, currentHead, [currentStaged, currentUnstaged, currentUntrackedPatch]);
}

async function captureRepoDeltaPatch(repoDir: string, rb: RepoBaseline): Promise<string> {
	const baselineTree = await writeSyntheticTree(repoDir, rb.headCommit, [rb.staged, rb.unstaged, rb.untrackedPatch]);
	const currentTree = await captureRepoCurrentTree(repoDir);

	return git.diff.tree(repoDir, baselineTree, currentTree, {
		binary: true,
	});
}

/** Confirm that applying patches to the captured owner baseline exactly matches the current owner worktree. */
export async function verifyRootPatchesApplied(
	repoRoot: string,
	baseline: WorktreeBaseline,
	patches: readonly string[],
): Promise<boolean> {
	const baselineTree = await writeSyntheticTree(repoRoot, baseline.root.headCommit, [
		baseline.root.staged,
		baseline.root.unstaged,
		baseline.root.untrackedPatch,
	]);
	const expectedTree = await writeSyntheticTree(repoRoot, baselineTree, patches);
	const currentTree = await captureRepoCurrentTree(repoRoot);
	return expectedTree === currentTree;
}

export interface NestedRepoPatch {
	relativePath: string;
	patch: string;
}

export interface DeltaPatchResult {
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
	captureErrors?: string[];
}

export interface RecoveryPatchBundle {
	version: 1;
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
	captureErrors?: string[];
}

function captureErrorCode(error: unknown): string {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return typeof code === "string" && code.length > 0 ? code : "unknown_error";
}

export function serializeRecoveryPatchBundle(delta: DeltaPatchResult): string {
	if (delta.nestedPatches.length === 0 && !delta.captureErrors?.length) return delta.rootPatch;
	return `${JSON.stringify({
		version: 1,
		rootPatch: delta.rootPatch,
		nestedPatches: delta.nestedPatches,
		...(delta.captureErrors?.length ? { captureErrors: delta.captureErrors } : {}),
	} satisfies RecoveryPatchBundle)}\n`;
}

export async function verifyNestedPatchesApplied(
	repoRoot: string,
	baseline: WorktreeBaseline,
	patches: readonly NestedRepoPatch[],
): Promise<boolean> {
	const grouped = new Map<string, string[]>();
	for (const patch of patches) {
		const current = grouped.get(patch.relativePath) ?? [];
		current.push(patch.patch);
		grouped.set(patch.relativePath, current);
	}
	for (const [relativePath, repoPatches] of grouped) {
		const nestedBaseline = baseline.nested.find(entry => entry.relativePath === relativePath)?.baseline;
		if (!nestedBaseline) return false;
		const nestedDir = path.join(repoRoot, relativePath);
		const baselineTree = await writeSyntheticTree(nestedDir, nestedBaseline.headCommit, [
			nestedBaseline.staged,
			nestedBaseline.unstaged,
			nestedBaseline.untrackedPatch,
		]);
		const expectedTree = await writeSyntheticTree(nestedDir, baselineTree, repoPatches);
		if ((await captureRepoCurrentTree(nestedDir)) !== expectedTree) return false;
	}
	return true;
}

export async function captureDeltaPatch(isolationDir: string, baseline: WorktreeBaseline): Promise<DeltaPatchResult> {
	const rootPatch = await captureRepoDeltaPatch(isolationDir, baseline.root);
	const nestedPatches: NestedRepoPatch[] = [];
	const captureErrors: string[] = [];

	for (const { relativePath, baseline: nb } of baseline.nested) {
		const nestedDir = path.join(isolationDir, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
			const patch = await captureRepoDeltaPatch(nestedDir, nb);
			if (patch.trim()) nestedPatches.push({ relativePath, patch });
		} catch (error) {
			captureErrors.push(`Nested repository capture failed (${relativePath}): ${captureErrorCode(error)}`);
		}
	}

	return { rootPatch, nestedPatches, ...(captureErrors.length ? { captureErrors } : {}) };
}

/** Preflight every nested delta, then roll back earlier repositories if a later apply fails. */
export async function applyNestedPatches(repoRoot: string, patches: NestedRepoPatch[]): Promise<void> {
	const byRepo = new Map<string, NestedRepoPatch[]>();
	for (const patch of patches) {
		if (!patch.patch.trim()) continue;
		const group = byRepo.get(patch.relativePath) ?? [];
		group.push(patch);
		byRepo.set(patch.relativePath, group);
	}

	const prepared: Array<{ relativePath: string; nestedDir: string; combinedPatch: string }> = [];
	for (const [relativePath, repoPatches] of [...byRepo.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const nestedDir = path.join(repoRoot, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			throw new Error(`Nested repository is unavailable: ${relativePath}`);
		}
		const combinedPatch = git.patch.join(repoPatches.map(entry => entry.patch));
		if (!(await git.patch.canApplyText(nestedDir, combinedPatch))) {
			throw new Error(`Nested repository patch does not apply cleanly: ${relativePath}`);
		}
		prepared.push({ relativePath, nestedDir, combinedPatch });
	}

	const applied: typeof prepared = [];
	try {
		for (const entry of prepared) {
			await git.patch.applyText(entry.nestedDir, entry.combinedPatch);
			applied.push(entry);
		}
	} catch (error) {
		const rollbackFailures: string[] = [];
		for (const entry of applied.reverse()) {
			try {
				await git.patch.applyText(entry.nestedDir, entry.combinedPatch, { reverse: true });
			} catch {
				rollbackFailures.push(entry.relativePath);
			}
		}
		const message = error instanceof Error ? error.message : String(error);
		const rollback = rollbackFailures.length
			? `; rollback failed for: ${rollbackFailures.join(", ")}`
			: "; earlier nested patches were rolled back";
		throw new Error(`Nested repository patch application failed: ${message}${rollback}`);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified isolation lifecycle — picks the best backend via the PAL and
// returns the merged-view path together with the resolved kind.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * User-facing isolation mode names exposed by the `task.isolation.mode`
 * setting. Mapped to a backend-kind hint via {@link parseIsolationMode};
 * the PAL's `iso_resolve` then falls back through the kind order
 * whenever the hint isn't available on the current host.
 */
export type TaskIsolationMode =
	| "none"
	| "auto"
	| "apfs"
	| "btrfs"
	| "zfs"
	| "reflink"
	| "overlayfs"
	| "projfs"
	| "block-clone"
	| "rcopy"
	// Legacy values, accepted for back-compat with pre-PAL settings files.
	| "worktree"
	| "fuse-overlay"
	| "fuse-projfs";

/**
 * Translate a {@link TaskIsolationMode} string to an [`IsoBackendKind`]
 * the PAL can act on. `"none"` returns `null` (caller skips isolation
 * entirely); `"auto"` returns `undefined` (no hint — let the resolver
 * pick). Anything else returns the matching kind.
 */
export function parseIsolationMode(mode: TaskIsolationMode): IsoBackendKind | undefined {
	const { IsoBackendKind } = nativeWorktree();
	switch (mode) {
		case "none":
		case "auto":
			return undefined;
		case "apfs":
			return IsoBackendKind.Apfs;
		case "btrfs":
			return IsoBackendKind.Btrfs;
		case "zfs":
			return IsoBackendKind.Zfs;
		case "reflink":
			return IsoBackendKind.LinuxReflink;
		case "overlayfs":
		case "fuse-overlay":
			return IsoBackendKind.Overlayfs;
		case "projfs":
		case "fuse-projfs":
			return IsoBackendKind.Projfs;
		case "block-clone":
			return IsoBackendKind.WindowsBlockClone;
		case "rcopy":
		case "worktree":
			return IsoBackendKind.Rcopy;
	}
}

export interface IsolationHandle {
	/** Merged view materialised by the backend; pass this to the task. */
	mergedDir: string;
	/** Backend the PAL actually used. */
	backend: IsoBackendKind;
	/** True when the resolver downgraded from `preferred` to `backend`. */
	fellBack: boolean;
	/** Optional reason associated with `fellBack`. */
	fallbackReason: string | null;
}

/**
 * Materialise `merged` for a single task. `preferred` is a hint — when
 * its prerequisites are missing the PAL silently falls back, and the
 * caller learns about that through `IsolationHandle.fellBack` +
 * `fallbackReason`.
 */

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function ensureIsolation(
	baseCwd: string,
	id: string,
	preferred?: IsoBackendKind,
): Promise<IsolationHandle> {
	const repoRoot = await getRepoRoot(baseCwd);
	const baseDir = getWorktreeDir(`${id}-${hashPath(repoRoot)}`);
	const mergedDir = path.join(baseDir, "merged");
	const natives = nativeWorktree();

	const resolution = natives.isoResolve(preferred ?? null);
	const candidates = resolution.candidates.length > 0 ? resolution.candidates : [resolution.kind];
	let fallbackReason = resolution.reason ?? null;

	for (const candidate of candidates) {
		await fs.rm(baseDir, { recursive: true, force: true });
		try {
			await natives.isoStart(candidate, repoRoot, mergedDir);
			return {
				mergedDir,
				backend: candidate,
				fellBack: candidate !== resolution.kind || resolution.fellBack,
				fallbackReason,
			};
		} catch (err) {
			await fs.rm(baseDir, { recursive: true, force: true });
			const message = errorMessage(err);
			if (!natives.isoIsUnavailableError(message)) {
				throw err;
			}
			fallbackReason ??= message;
		}
	}

	throw new Error(fallbackReason ?? "No isolation backend is available.");
}

/** Tear down a handle returned by {@link ensureIsolation}. */
export async function cleanupIsolation(handle: IsolationHandle): Promise<void> {
	const natives = nativeWorktree();
	try {
		try {
			await natives.isoStop(handle.backend, handle.mergedDir);
		} catch (err) {
			logger.warn("isolation backend stop failed during cleanup", {
				backend: handle.backend,
				mergedDir: handle.mergedDir,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	} finally {
		// baseDir is the parent of the merged directory
		const baseDir = path.dirname(handle.mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Branch-mode isolation
// ═══════════════════════════════════════════════════════════════════════════

export interface CommitToBranchResult {
	branchName?: string;
	nestedPatches: NestedRepoPatch[];
}

/**
 * Commit task-only changes to a new branch.
 * Only root repo changes go on the branch. Nested repo patches are returned
 * separately since the parent git can't track files inside gitlinks.
 */
export async function commitToBranch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	taskId: string,
	description: string | undefined,
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<CommitToBranchResult | null> {
	const { rootPatch, nestedPatches } = await captureDeltaPatch(isolationDir, baseline);
	if (!rootPatch.trim() && nestedPatches.length === 0) return null;

	const repoRoot = baseline.root.repoRoot;
	const branchName = `gjc/task/${taskId}`;
	const fallbackMessage = description || taskId;

	// Only create a branch if the root repo has changes
	if (rootPatch.trim()) {
		await git.branch.create(repoRoot, branchName);
		const tmpDir = path.join(os.tmpdir(), `gjc-branch-${Snowflake.next()}`);
		try {
			await git.worktree.add(repoRoot, tmpDir, branchName);
			try {
				await git.patch.applyText(tmpDir, rootPatch);
			} catch (err) {
				if (err instanceof git.GitCommandError) {
					const stderr = err.result.stderr.slice(0, 2000);
					logger.error("commitToBranch: git apply failed", {
						taskId,
						exitCode: err.result.exitCode,
						stderr,
						patchSize: rootPatch.length,
						patchHead: rootPatch.slice(0, 500),
					});
					throw new Error(`git apply failed for task ${taskId}: ${stderr}`);
				}
				throw err;
			}
			await git.stage.files(tmpDir);
			const msg = (commitMessage && (await commitMessage(rootPatch))) || fallbackMessage;
			await git.commit(tmpDir, msg);
		} finally {
			await git.worktree.tryRemove(repoRoot, tmpDir);
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	}

	return { branchName: rootPatch.trim() ? branchName : undefined, nestedPatches };
}

export interface MergeBranchResult {
	merged: string[];
	failed: string[];
	conflict?: string;
}

/**
 * Cherry-pick task branch commits sequentially onto HEAD.
 * Each branch has a single commit that gets replayed cleanly.
 * Stops on first conflict and reports which branches succeeded.
 */
export async function mergeTaskBranches(
	repoRoot: string,
	branches: Array<{ branchName: string; taskId: string; description?: string }>,
): Promise<MergeBranchResult> {
	const merged: string[] = [];
	const failed: string[] = [];

	// Stash dirty working tree so cherry-pick can operate on a clean HEAD.
	// Without this, cherry-pick refuses to run when uncommitted changes exist.
	const didStash = await git.stash.push(repoRoot, "gjc-task-merge");

	let conflictResult: MergeBranchResult | undefined;

	try {
		for (const { branchName } of branches) {
			try {
				await git.cherryPick(repoRoot, branchName);
			} catch (err) {
				try {
					await git.cherryPick.abort(repoRoot);
				} catch {
					/* no state to abort */
				}
				const stderr =
					err instanceof git.GitCommandError
						? err.result.stderr.trim()
						: err instanceof Error
							? err.message
							: String(err);
				failed.push(branchName);
				conflictResult = {
					merged,
					failed: [...failed, ...branches.slice(merged.length + failed.length).map(b => b.branchName)],
					conflict: `${branchName}: ${stderr}`,
				};
				break;
			}

			merged.push(branchName);
		}
	} finally {
		if (didStash) {
			try {
				await git.stash.pop(repoRoot, { index: true });
			} catch {
				// Stash-pop conflicts mean the replayed changes clash with the user's
				// uncommitted edits. Treat this as a merge failure so the caller preserves
				// recovery branches instead of reporting success and deleting them.
				logger.warn("Failed to restore stashed changes after task merge; stash entry preserved");
				if (!conflictResult) {
					conflictResult = {
						merged,
						failed: merged,
						conflict:
							"stash pop: cherry-picked changes conflict with uncommitted edits. Run `git stash pop` and resolve manually.",
					};
				}
			}
		}
	}

	return conflictResult ?? { merged, failed };
}

/** Clean up temporary task branches. */
export async function cleanupTaskBranches(repoRoot: string, branches: string[]): Promise<void> {
	for (const branch of branches) {
		await git.branch.tryDelete(repoRoot, branch);
	}
}
