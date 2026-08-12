/**
 * Autoresearch branch isolation (ported from the deleted extension's `git.ts`).
 *
 * Every mission is meant to run on a dedicated `autoresearch/*` branch created
 * from a slugified goal. On that branch `keep` auto-commits the iteration and
 * `discard` resets the worktree to HEAD; off-branch (no repo, or a dirty tree
 * that prevents branch creation) we degrade: `keep` skips auto-commits and
 * `discard` reverts only run-modified paths instead of resetting to baseline.
 *
 * Dirty-worktree behavior is faithful to the extension contract: when the tree
 * is dirty and we are NOT already on an autoresearch branch, we return a
 * warning and continue on the current branch rather than failing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as git from "../utils/git";
import { normalizePathSpec } from "./harness";

export const AUTORESEARCH_BRANCH_PREFIX = "autoresearch/";
const BRANCH_NAME_MAX_LENGTH = 48;

export interface EnsureAutoresearchBranchFailure {
	error: string;
	ok: false;
}

export interface EnsureAutoresearchBranchSuccess {
	branchName: string | null;
	created: boolean;
	ok: true;
	warning?: string;
}

export type EnsureAutoresearchBranchResult = EnsureAutoresearchBranchFailure | EnsureAutoresearchBranchSuccess;

export function getCurrentAutoresearchBranch(workDir: string): Promise<string | null> {
	return git.branch.current(workDir).then(currentBranch => {
		return currentBranch?.startsWith(AUTORESEARCH_BRANCH_PREFIX) ? currentBranch : null;
	});
}

/**
 * Ensure the working tree is on an `autoresearch/*` branch when possible.
 *
 * When the worktree is dirty and we are not already on an autoresearch branch,
 * this returns `{ ok: true, branchName: null, warning }` rather than failing:
 * the caller surfaces the warning and continues on the current branch — `keep`
 * will skip auto-commits and `discard` will revert only run-modified paths
 * instead of resetting to baseline.
 */
export async function ensureAutoresearchBranch(
	workDir: string,
	goal: string | null,
): Promise<EnsureAutoresearchBranchResult> {
	const repoRoot = await git.repo.root(workDir);
	if (!repoRoot) {
		return {
			ok: true,
			branchName: null,
			created: false,
			warning:
				"Not in a git repository — autoresearch will run without branch isolation, baseline reset, or auto-commits.",
		};
	}

	let dirtyPathsOutput: string;
	try {
		dirtyPathsOutput = await git.status(repoRoot, { porcelainV1: true, untrackedFiles: "all", z: true });
	} catch (err) {
		return {
			ok: false,
			error: `Unable to inspect git status before starting autoresearch: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const workDirPrefix = await readGitWorkDirPrefix(workDir);
	const dirtyPaths = collectRelativeDirtyPaths(dirtyPathsOutput, workDirPrefix);
	const currentBranch = await getCurrentAutoresearchBranch(workDir);
	if (currentBranch) {
		return { ok: true, branchName: currentBranch, created: false };
	}
	if (dirtyPaths.length > 0) {
		const preview = formatDirtyPaths(dirtyPaths);
		return {
			ok: true,
			branchName: null,
			created: false,
			warning:
				`Worktree is dirty (${preview}). Continuing autoresearch on the current branch without a dedicated ` +
				"`autoresearch/*` branch: `keep` will skip auto-commits and `discard` will revert only run-modified " +
				"files instead of resetting to baseline. Commit or stash these changes and re-run to get full branch " +
				"isolation.",
		};
	}

	const branchName = await allocateBranchName(workDir, goal);
	try {
		await git.branch.checkoutNew(workDir, branchName);
	} catch (err) {
		return {
			ok: false,
			error: `Failed to create autoresearch branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return { ok: true, branchName, created: true };
}

export function parseWorkDirDirtyPaths(statusOutput: string, workDirPrefix: string): string[] {
	const relativePaths: string[] = [];
	for (const dirtyPath of parseDirtyPaths(statusOutput)) {
		const relativePath = relativizeGitPathToWorkDir(dirtyPath, workDirPrefix);
		if (relativePath === null) continue;
		relativePaths.push(relativePath);
	}
	return relativePaths;
}

export function relativizeGitPathToWorkDir(repoRelativePath: string, workDirPrefix: string): string | null {
	const normalizedPath = normalizeStatusPath(repoRelativePath);
	const normalizedPrefix = normalizePathSpec(workDirPrefix);
	if (normalizedPrefix === "" || normalizedPrefix === ".") {
		return normalizedPath;
	}
	if (normalizedPath === normalizedPrefix) {
		return ".";
	}
	if (!normalizedPath.startsWith(`${normalizedPrefix}/`)) {
		return null;
	}
	return normalizePathSpec(normalizedPath.slice(normalizedPrefix.length + 1));
}

async function readGitWorkDirPrefix(workDir: string): Promise<string> {
	try {
		return await git.show.prefix(workDir);
	} catch {
		return "";
	}
}

export function parseDirtyPaths(statusOutput: string): string[] {
	if (statusOutput.includes("\0")) {
		return parseDirtyPathsNul(statusOutput);
	}
	return parseDirtyPathsLines(statusOutput);
}

function parseDirtyPathsNul(statusOutput: string): string[] {
	const unsafePaths = new Set<string>();
	let index = 0;
	while (index + 3 <= statusOutput.length) {
		const statusToken = statusOutput.slice(index, index + 3);
		index += 3;
		const pathEnd = statusOutput.indexOf("\0", index);
		if (pathEnd < 0) break;
		const firstPath = statusOutput.slice(index, pathEnd);
		index = pathEnd + 1;
		addDirtyPath(unsafePaths, firstPath);
		if (isRenameOrCopy(statusToken)) {
			const secondPathEnd = statusOutput.indexOf("\0", index);
			if (secondPathEnd < 0) break;
			const secondPath = statusOutput.slice(index, secondPathEnd);
			index = secondPathEnd + 1;
			addDirtyPath(unsafePaths, secondPath);
		}
	}
	return [...unsafePaths];
}

function parseDirtyPathsLines(statusOutput: string): string[] {
	const unsafePaths = new Set<string>();
	for (const line of statusOutput.split("\n")) {
		const trimmedLine = line.trimEnd();
		if (trimmedLine.length < 4) continue;
		const rawPath = trimmedLine.slice(3).trim();
		if (rawPath.length === 0) continue;
		const renameParts = rawPath.split(" -> ");
		for (const renamePart of renameParts) {
			addDirtyPath(unsafePaths, renamePart);
		}
	}
	return [...unsafePaths];
}

export function normalizeStatusPath(rawPath: string): string {
	let normalized = rawPath.trim();
	if (normalized.startsWith('"') && normalized.endsWith('"')) {
		normalized = normalized.slice(1, -1);
	}
	return normalizePathSpec(normalized);
}

async function allocateBranchName(workDir: string, goal: string | null): Promise<string> {
	const baseName = `${AUTORESEARCH_BRANCH_PREFIX}${slugifyGoal(goal)}-${currentDateStamp()}`;
	let candidate = baseName;
	let suffix = 2;
	while (await git.ref.exists(workDir, `refs/heads/${candidate}`)) {
		candidate = `${baseName}-${suffix}`;
		suffix += 1;
	}
	return candidate;
}

export function slugifyGoal(goal: string | null): string {
	const normalized = (goal ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const trimmed = normalized.slice(0, BRANCH_NAME_MAX_LENGTH).replace(/-+$/g, "");
	return trimmed || "session";
}

function currentDateStamp(): string {
	const now = new Date();
	const year = String(now.getFullYear());
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}${month}${day}`;
}

function addDirtyPath(paths: Set<string>, rawPath: string): void {
	const normalizedPath = normalizeStatusPath(rawPath);
	if (normalizedPath.length === 0) return;
	paths.add(normalizedPath);
}

function isRenameOrCopy(statusToken: string): boolean {
	const trimmed = statusToken.trim();
	return trimmed.startsWith("R") || trimmed.startsWith("C");
}

function collectRelativeDirtyPaths(statusOutput: string, workDirPrefix: string): string[] {
	const dirtyPaths: string[] = [];
	for (const dirtyPath of parseDirtyPaths(statusOutput)) {
		const relativePath = relativizeGitPathToWorkDir(dirtyPath, workDirPrefix);
		dirtyPaths.push(relativePath ?? normalizeStatusPath(dirtyPath));
	}
	return dirtyPaths;
}

function formatDirtyPaths(paths: string[]): string {
	const preview = paths.slice(0, 5).join(", ");
	return paths.length > 5 ? `${preview} (+${paths.length - 5} more)` : preview;
}

export interface DirtyPathEntry {
	path: string;
	untracked: boolean;
}

export function parseDirtyPathsWithStatus(statusOutput: string): DirtyPathEntry[] {
	if (statusOutput.includes("\0")) {
		return parseDirtyPathsNulWithStatus(statusOutput);
	}
	return parseDirtyPathsLinesWithStatus(statusOutput);
}

function parseDirtyPathsNulWithStatus(statusOutput: string): DirtyPathEntry[] {
	const seen = new Set<string>();
	const results: DirtyPathEntry[] = [];
	let index = 0;
	while (index + 3 <= statusOutput.length) {
		const statusToken = statusOutput.slice(index, index + 3);
		index += 3;
		const pathEnd = statusOutput.indexOf("\0", index);
		if (pathEnd < 0) break;
		const firstPath = statusOutput.slice(index, pathEnd);
		index = pathEnd + 1;
		const untracked = statusToken.trim().startsWith("??");
		addDirtyPathEntry(seen, results, firstPath, untracked);
		if (isRenameOrCopy(statusToken)) {
			const secondPathEnd = statusOutput.indexOf("\0", index);
			if (secondPathEnd < 0) break;
			const secondPath = statusOutput.slice(index, secondPathEnd);
			index = secondPathEnd + 1;
			addDirtyPathEntry(seen, results, secondPath, false);
		}
	}
	return results;
}

function parseDirtyPathsLinesWithStatus(statusOutput: string): DirtyPathEntry[] {
	const seen = new Set<string>();
	const results: DirtyPathEntry[] = [];
	for (const line of statusOutput.split("\n")) {
		const trimmedLine = line.trimEnd();
		if (trimmedLine.length < 4) continue;
		const statusToken = trimmedLine.slice(0, 3);
		const rawPath = trimmedLine.slice(3).trim();
		if (rawPath.length === 0) continue;
		const untracked = statusToken.trim().startsWith("??");
		const renameParts = rawPath.split(" -> ");
		for (const renamePart of renameParts) {
			addDirtyPathEntry(seen, results, renamePart, untracked);
		}
	}
	return results;
}

function addDirtyPathEntry(seen: Set<string>, results: DirtyPathEntry[], rawPath: string, untracked: boolean): void {
	const normalizedPath = normalizeStatusPath(rawPath);
	if (normalizedPath.length === 0 || seen.has(normalizedPath)) return;
	seen.add(normalizedPath);
	results.push({ path: normalizedPath, untracked });
}

export function parseWorkDirDirtyPathsWithStatus(statusOutput: string, workDirPrefix: string): DirtyPathEntry[] {
	const results: DirtyPathEntry[] = [];
	for (const entry of parseDirtyPathsWithStatus(statusOutput)) {
		const relativePath = relativizeGitPathToWorkDir(entry.path, workDirPrefix);
		if (relativePath === null) continue;
		results.push({ path: relativePath, untracked: entry.untracked });
	}
	return results;
}

export function computeRunModifiedPaths(
	preRunDirtyPaths: string[],
	currentStatusOutput: string,
	workDirPrefix: string,
): { tracked: string[]; untracked: string[] } {
	const preRunSet = new Set(preRunDirtyPaths);
	const tracked: string[] = [];
	const untracked: string[] = [];
	for (const entry of parseWorkDirDirtyPathsWithStatus(currentStatusOutput, workDirPrefix)) {
		if (preRunSet.has(entry.path)) continue;
		if (entry.untracked) {
			untracked.push(entry.path);
		} else {
			tracked.push(entry.path);
		}
	}
	return { tracked, untracked };
}

// ---------------------------------------------------------------------------
// keep / discard
// ---------------------------------------------------------------------------

export interface KeepAutoresearchRunInput {
	cwd: string;
	description: string;
	status: string;
	metric: number;
	metrics: { [key: string]: number };
	/** Paths modified by this run (workdir-relative). */
	files: string[];
	/** True when on a dedicated `autoresearch/*` branch. */
	onAutoresearchBranch: boolean;
	primaryMetric: string;
}

export interface KeepAutoresearchRunResult {
	/** Error text when the commit failed; `ok` is false. */
	error?: string;
	/** Human note for the caller (e.g. "nothing to commit", "committed", "skipped"). */
	note?: string;
	/** Commit SHA after the keep (null when nothing was committed). */
	commitHash?: string | null;
}

/**
 * Keep an iteration: commit the modified files on a dedicated autoresearch
 * branch. Off-branch (degraded mode) auto-commit is skipped and the files stay
 * in the worktree, matching the extension contract.
 */
export async function keepAutoresearchRun(input: KeepAutoresearchRunInput): Promise<KeepAutoresearchRunResult> {
	if (!input.onAutoresearchBranch) {
		return {
			note: "Auto-commit skipped: not on a dedicated autoresearch branch. Modified files remain in the worktree.",
			commitHash: null,
		};
	}
	if (input.files.length === 0) {
		return { note: "nothing to commit", commitHash: null };
	}
	try {
		await git.stage.files(input.cwd, input.files);
	} catch (err) {
		return { error: `git add failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!(await git.diff.has(input.cwd, { cached: true, files: input.files }))) {
		return { note: "nothing to commit", commitHash: null };
	}
	const payload: { [key: string]: string | number } = {
		status: input.status,
		[input.primaryMetric]: input.metric,
	};
	for (const [name, value] of Object.entries(input.metrics)) {
		payload[name] = value;
	}
	const commitMessage = `${input.description}\n\nResult: ${JSON.stringify(payload)}`;
	try {
		await git.commit(input.cwd, commitMessage, { files: input.files });
		const commitHash = await git.head.sha(input.cwd);
		return { note: `committed at ${(commitHash ?? "").slice(0, 12)}`, commitHash };
	} catch (err) {
		return { error: `git commit failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export interface DiscardAutoresearchRunInput {
	cwd: string;
	/** Paths that were already dirty before the run started (workdir-relative). */
	preRunDirtyPaths: string[];
	/** True when on a dedicated `autoresearch/*` branch. */
	onAutoresearchBranch: boolean;
}

export interface DiscardAutoresearchRunResult {
	error?: string;
	note?: string;
}

/**
 * Discard a failed/crashed iteration. On a dedicated autoresearch branch the
 * worktree resets to HEAD (never rewinding prior `keep` commits); off-branch
 * only run-modified paths are reverted so pre-existing user dirt survives.
 */
export async function discardAutoresearchRun(
	input: DiscardAutoresearchRunInput,
): Promise<DiscardAutoresearchRunResult> {
	if (input.onAutoresearchBranch) {
		try {
			await git.reset(input.cwd, { hard: true, target: "HEAD" });
			await git.clean(input.cwd);
			return { note: "worktree reset to HEAD" };
		} catch (err) {
			return { error: `git reset/clean failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	let statusText: string;
	try {
		statusText = await git.status(input.cwd, { porcelainV1: true, untrackedFiles: "all", z: true });
	} catch (err) {
		return { error: `git status failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	let workDirPrefix: string;
	try {
		workDirPrefix = await git.show.prefix(input.cwd);
	} catch {
		workDirPrefix = "";
	}
	const { tracked, untracked } = computeRunModifiedPaths(input.preRunDirtyPaths, statusText, workDirPrefix);
	const total = tracked.length + untracked.length;
	if (total === 0) return { note: "nothing to revert" };
	if (tracked.length > 0) {
		try {
			await git.restore(input.cwd, { files: tracked, source: "HEAD", staged: true, worktree: true });
		} catch (err) {
			return { error: `git restore failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	for (const filePath of untracked) {
		try {
			fs.rmSync(path.join(input.cwd, filePath), { force: true, recursive: true });
		} catch {
			// best effort
		}
	}
	return { note: `reverted ${total} file${total === 1 ? "" : "s"}` };
}
