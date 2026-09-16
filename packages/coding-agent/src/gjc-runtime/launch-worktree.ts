import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shortenPath } from "../tools/render-utils";

export type GjcLaunchWorktreeMode =
	| { enabled: false }
	| { enabled: true; detached: true; name: null }
	| { enabled: true; detached: false; name: string };

export interface ParsedLaunchWorktreeMode {
	mode: GjcLaunchWorktreeMode;
	remainingArgs: string[];
}

export interface GjcLaunchWorktreePlan {
	enabled: true;
	repoRoot: string;
	worktreePath: string;
	detached: boolean;
	baseRef: string;
	branchName: string | null;
}

export interface GjcLaunchWorktreeResult extends GjcLaunchWorktreePlan {
	created: boolean;
	reused: boolean;
	createdBranch: boolean;
	dirty?: boolean;
}
export interface LaunchWorktreeAbortOptions {
	signal?: AbortSignal;
	deadlineAt?: number;
	now?: () => number;
}

export class WorktreePreparationTimeoutError extends Error {
	readonly code = "worktree_preparation_timeout";
	constructor(message = "Worktree preparation exceeded its deadline before the session host was spawned.") {
		super(message);
		this.name = "WorktreePreparationTimeoutError";
	}
}

export class DependencyPreparationTimeoutError extends Error {
	readonly code = "dependency_preparation_timeout";
	constructor(message = "Dependency preparation exceeded its deadline before the session host was spawned.") {
		super(message);
		this.name = "DependencyPreparationTimeoutError";
	}
}

interface GitWorktreeEntry {
	path: string;
	head: string;
	branchRef: string | null;
	detached: boolean;
}

const BRANCH_IN_USE_PATTERN = /already checked out|already used by worktree|is already checked out/i;

function throwIfAborted(options: LaunchWorktreeAbortOptions | undefined, timeout: Error): void {
	if (options?.signal?.aborted) throw timeout;
	if (options?.deadlineAt !== undefined && (options.now ?? Date.now)() >= options.deadlineAt) throw timeout;
}

function sanitizeWorktreeDiagnostic(value: string): string {
	return value
		.replace(/([?&](?:token|secret|password|key|api[_-]?key)=[^\s&]*)/giu, "[redacted-query]")
		.replace(
			/(^|[^\p{L}\p{N}_-])[\p{L}\p{N}_-]*(?:token|secret|password|api[_-]?key|key|credential|auth)\s*[=:]\s*[^\s,;]+/giu,
			"$1[redacted-secret]",
		)
		.replace(/\b(?:https?|wss?):\/\/[^\s]+/giu, "[redacted-url]")
		.slice(0, 512);
}

async function spawnProcessGroup(
	command: string[],
	cwd: string,
	options: LaunchWorktreeAbortOptions | undefined,
	timeout: Error,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	throwIfAborted(options, timeout);
	const [file, ...args] = command;
	if (!file) throw timeout;
	const proc = Bun.spawn([file, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		// Windows has no POSIX process-group kill: parent-only proc.kill() is the
		// documented seam. Leftover classify still runs after wait on both OS.
		detached: process.platform !== "win32",
		...(process.platform === "win32" ? { windowsHide: true } : {}),
	});
	const killGroup = (): void => {
		try {
			if (process.platform === "win32") proc.kill();
			else if (proc.pid) process.kill(-proc.pid, "SIGKILL");
			else proc.kill();
		} catch {
			try {
				proc.kill();
			} catch {
				// already gone
			}
		}
	};
	const onAbort = (): void => {
		killGroup();
	};
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	if (options?.deadlineAt !== undefined) {
		const remaining = options.deadlineAt - (options.now ?? Date.now)();
		if (remaining <= 0) {
			killGroup();
			options?.signal?.removeEventListener("abort", onAbort);
			await proc.exited.catch(() => undefined);
			throw timeout;
		}
		deadlineTimer = setTimeout(() => {
			killGroup();
		}, remaining);
	}
	try {
		const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
			new Response(proc.stdout).arrayBuffer(),
			new Response(proc.stderr).arrayBuffer(),
			proc.exited,
		]);
		throwIfAborted(options, timeout);
		return {
			stdout: new TextDecoder().decode(stdoutBytes),
			stderr: new TextDecoder().decode(stderrBytes),
			exitCode: exitCode ?? 1,
		};
	} finally {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		options?.signal?.removeEventListener("abort", onAbort);
	}
}

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return result.stdout.toString().trim();
	const stderr = sanitizeWorktreeDiagnostic(result.stderr.toString().trim());
	throw new Error(stderr || `git ${args.join(" ")} failed`);
}

function tryRunGit(cwd: string, args: string[]): string | null {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function sanitizePathToken(value: string): string {
	const readable = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const prefix = readable || "default";
	const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
	return `${prefix}-${digest}`;
}

/**
 * Environment override for the directory that holds a repository's launch worktrees.
 *
 * The bucket is otherwise derived entirely from the repository path, so a machine that
 * already keeps worktrees somewhere else — a dedicated volume, or a pre-existing
 * `<repo>.worktrees` convention — has no way to say so and accumulates a second bucket
 * beside the first.
 */
const WORKTREE_BUCKET_ENV = "GJC_WORKTREE_DIR";
/**
 * Expands to the repository directory name.
 *
 * A single exported value therefore stays repo-scoped across every checkout, which is
 * what keeps two repositories that share a branch name from resolving to one worktree.
 */
const REPO_NAME_PLACEHOLDER = "{repo}";
const DEFAULT_WORKTREE_BUCKET = `${REPO_NAME_PLACEHOLDER}/.worktrees`;

function expandHomePrefix(value: string, home: string, pathApi: typeof path.posix): string {
	if (value === "~") return home;
	return value.startsWith(`~${pathApi.sep}`) || value.startsWith("~/") ? pathApi.join(home, value.slice(2)) : value;
}

/**
 * Pure core of {@link resolveWorktreeBucket}, exported for tests.
 *
 * Injecting the home directory and path implementation lets tests exercise
 * Windows drive/UNC/separator semantics (`path.win32`) on any host.
 */
export function resolveWorktreeBucketForPath(
	repoRoot: string,
	envValue: string | undefined,
	home: string,
	pathApi: typeof path.posix,
): string {
	const configured = envValue?.trim();
	const template = expandHomePrefix(configured || DEFAULT_WORKTREE_BUCKET, home, pathApi);
	return pathApi.resolve(
		pathApi.dirname(repoRoot),
		template.replaceAll(REPO_NAME_PLACEHOLDER, pathApi.basename(repoRoot)),
	);
}

/**
 * Directory that holds this repository's launch worktrees.
 *
 * A relative override resolves against the repository's parent directory. The default
 * `{repo}/.worktrees` template places managed worktrees inside the repository, while
 * `{repo}.worktrees` adopts an existing sibling bucket. An absolute override is used verbatim.
 */
function resolveWorktreeBucket(repoRoot: string): string {
	return resolveWorktreeBucketForPath(repoRoot, process.env[WORKTREE_BUCKET_ENV], os.homedir(), path);
}

function ensureRepositoryBucketIgnored(repoRoot: string, bucketPath: string): void {
	const relativeBucket = path.relative(repoRoot, bucketPath);
	if (relativeBucket.startsWith(`..${path.sep}`) || relativeBucket === ".." || path.isAbsolute(relativeBucket)) return;
	const ignoreProbe = path.join(relativeBucket, ".gjc-worktree-probe");
	for (const candidate of [relativeBucket, ignoreProbe]) {
		const result = Bun.spawnSync(["git", "check-ignore", "--quiet", "--", candidate], {
			cwd: repoRoot,
			stdout: "ignore",
			stderr: "pipe",
		});
		if (result.exitCode === 0) return;
	}
	throw new Error(
		[
			"worktree_bucket_not_ignored",
			"The GJC launch worktree bucket is inside the repository but is not ignored by Git.",
			`Path: ${formatBucketPath(bucketPath)}`,
			`Safe remediation: add /${relativeBucket.replaceAll(path.sep, "/")} to ${path.join(repoRoot, ".gitignore")}, then relaunch.`,
		].join("\n"),
	);
}

function resolveSourceBranchSlug(repoRoot: string, baseRef: string): string {
	const branch = tryRunGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (branch) return sanitizePathToken(branch);
	return `head-${baseRef.slice(0, 12)}`;
}

function branchExists(repoRoot: string, branchName: string): boolean {
	const result = Bun.spawnSync(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
		cwd: repoRoot,
		stdout: "ignore",
		stderr: "ignore",
	});
	return result.exitCode === 0;
}

function validateBranchName(repoRoot: string, branchName: string): void {
	const result = Bun.spawnSync(["git", "check-ref-format", "--branch", branchName], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode === 0) return;
	const stderr = result.stderr.toString().trim();
	throw new Error(stderr || `invalid_worktree_branch:${branchName}`);
}

function listWorktrees(repoRoot: string): GitWorktreeEntry[] {
	const raw = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	if (!raw) return [];
	return raw
		.split(/\n\n+/)
		.map(chunk => chunk.trim())
		.filter(Boolean)
		.flatMap(chunk => {
			const lines = chunk
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean);
			const worktreeLine = lines.find(line => line.startsWith("worktree "));
			const headLine = lines.find(line => line.startsWith("HEAD "));
			const branchLine = lines.find(line => line.startsWith("branch "));
			if (!worktreeLine || !headLine) return [];
			return [
				{
					path: path.resolve(worktreeLine.slice("worktree ".length)),
					head: headLine.slice("HEAD ".length).trim(),
					branchRef: branchLine ? branchLine.slice("branch ".length).trim() : null,
					detached: lines.includes("detached") || !branchLine,
				},
			];
		});
}

function findWorktreeByPath(entries: GitWorktreeEntry[], worktreePath: string): GitWorktreeEntry | null {
	const resolved = path.resolve(worktreePath);
	return entries.find(entry => path.resolve(entry.path) === resolved) ?? null;
}

function describeWorktreeEntry(entry: GitWorktreeEntry): string {
	return entry.detached ? `detached HEAD ${entry.head}` : (entry.branchRef ?? `HEAD ${entry.head}`);
}

function formatWorktreeTargetMismatch(plan: GjcLaunchWorktreePlan, existing: GitWorktreeEntry): string {
	const expected = plan.detached ? `detached HEAD ${plan.baseRef}` : `branch refs/heads/${plan.branchName ?? ""}`;
	return [
		`worktree_target_mismatch:${plan.worktreePath}`,
		`GJC launch worktree target is already registered for ${describeWorktreeEntry(existing)}, but this launch expects ${expected}.`,
		`Path: ${plan.worktreePath}`,
		"Refusing to delete or reuse the conflicting worktree automatically. Safe remediation: inspect the path, commit/stash any work, then remove or prune the stale worktree with git worktree remove <path> when it is no longer needed, or choose a different --worktree name.",
	].join("\n");
}

function hasBranchInUse(entries: GitWorktreeEntry[], branchName: string, worktreePath: string): boolean {
	const expectedRef = `refs/heads/${branchName}`;
	const resolvedPath = path.resolve(worktreePath);
	return entries.some(entry => entry.branchRef === expectedRef && path.resolve(entry.path) !== resolvedPath);
}

function fileSystemErrorCode(error: unknown): string | null {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: null;
}

function formatBucketPath(bucketPath: string): string {
	return JSON.stringify(shortenPath(bucketPath));
}

function brokenBucketSymlinkError(bucketPath: string): Error {
	return new Error(
		[
			"worktree_bucket_broken_symlink",
			"The GJC launch worktree bucket is a symbolic link whose target cannot be resolved; it may be unmounted or offloaded cold storage.",
			`Path: ${formatBucketPath(bucketPath)}`,
			"Safe remediation: restore or remount the link target, or inspect and remove the dangling link with platform-appropriate filesystem tools, then relaunch. GJC did not delete or replace the entry.",
		].join("\n"),
	);
}

function bucketNotDirectoryError(bucketPath: string, symlinkTarget = false): Error {
	return new Error(
		[
			"worktree_bucket_not_directory",
			symlinkTarget
				? "The GJC launch worktree bucket is a symbolic link whose target is not a directory."
				: "The GJC launch worktree bucket path exists but is not a directory.",
			`Path: ${formatBucketPath(bucketPath)}`,
			"Safe remediation: inspect the obstructing entry and move or remove it with platform-appropriate filesystem tools, then relaunch. GJC did not delete or replace the entry.",
		].join("\n"),
	);
}

function inspectBucketDir(bucketPath: string): "missing" | "usable" {
	let entry: fs.Stats;
	try {
		entry = fs.lstatSync(bucketPath);
	} catch (error) {
		if (fileSystemErrorCode(error) === "ENOENT") return "missing";
		throw new Error(
			[
				"worktree_bucket_inspection_failed",
				`GJC could not inspect the launch worktree bucket${fileSystemErrorCode(error) ? ` (${fileSystemErrorCode(error)})` : ""}.`,
				`Path: ${formatBucketPath(bucketPath)}`,
				"Safe remediation: verify that the bucket parent is accessible, then relaunch. GJC did not modify the entry.",
			].join("\n"),
		);
	}
	if (entry.isDirectory()) return "usable";
	if (!entry.isSymbolicLink()) throw bucketNotDirectoryError(bucketPath);

	let target: fs.Stats;
	try {
		target = fs.statSync(bucketPath);
	} catch (error) {
		const code = fileSystemErrorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") throw brokenBucketSymlinkError(bucketPath);
		throw new Error(
			[
				"worktree_bucket_target_inspection_failed",
				`GJC could not inspect the launch worktree bucket link target${code ? ` (${code})` : ""}.`,
				`Path: ${formatBucketPath(bucketPath)}`,
				"Safe remediation: verify that the link target is accessible, then relaunch. GJC did not modify the link.",
			].join("\n"),
		);
	}
	if (target.isDirectory()) return "usable";
	throw bucketNotDirectoryError(bucketPath, true);
}

function ensureBucketDirUsable(bucketPath: string): void {
	inspectBucketDir(bucketPath);
	try {
		fs.mkdirSync(bucketPath, { recursive: true });
	} catch (error) {
		// The entry can change between lstat/stat and mkdir. Re-inspect so a
		// racing broken link or non-directory is still reported actionably.
		inspectBucketDir(bucketPath);
		const code = fileSystemErrorCode(error);
		throw new Error(
			[
				"worktree_bucket_create_failed",
				`GJC could not create or reuse the launch worktree bucket${code ? ` (${code})` : ""}.`,
				`Path: ${formatBucketPath(bucketPath)}`,
				"Safe remediation: verify parent permissions and bucket accessibility, then relaunch. GJC did not delete or replace any entry.",
			].join("\n"),
		);
	}
	if (inspectBucketDir(bucketPath) === "missing") {
		throw new Error(
			[
				"worktree_bucket_changed_during_preflight",
				"The GJC launch worktree bucket disappeared while launch was preparing it.",
				`Path: ${formatBucketPath(bucketPath)}`,
				"Safe remediation: stabilize the bucket mount or parent directory, then relaunch. GJC did not delete or replace any entry.",
			].join("\n"),
		);
	}
}

function pruneStaleWorktreePath(repoRoot: string): void {
	runGit(repoRoot, ["worktree", "prune"]);
}

function readWorktreeEntryFromPath(repoRoot: string, worktreePath: string): GitWorktreeEntry | null {
	if (!fs.existsSync(worktreePath)) return null;
	if (!fs.existsSync(path.join(worktreePath, ".git"))) return null;
	const repoCommonDir = tryRunGit(repoRoot, ["rev-parse", "--git-common-dir"]);
	const worktreeCommonDir = tryRunGit(worktreePath, ["rev-parse", "--git-common-dir"]);
	if (!repoCommonDir || !worktreeCommonDir) return null;
	if (path.resolve(repoRoot, repoCommonDir) !== path.resolve(worktreePath, worktreeCommonDir)) return null;
	const head = tryRunGit(worktreePath, ["rev-parse", "HEAD"]);
	if (!head) return null;
	const branchRef = tryRunGit(worktreePath, ["symbolic-ref", "-q", "HEAD"]);
	return { path: path.resolve(worktreePath), head, branchRef, detached: !branchRef };
}

function resolveCanonicalRepoRoot(cwd: string): string {
	const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	const commonDir = tryRunGit(repoRoot, ["rev-parse", "--git-common-dir"]);
	if (!commonDir) return repoRoot;
	const resolvedCommonDir = path.resolve(repoRoot, commonDir);
	if (path.basename(resolvedCommonDir) !== ".git") return repoRoot;
	const ownerRoot = path.dirname(resolvedCommonDir);
	if (tryRunGit(ownerRoot, ["rev-parse", "--is-inside-work-tree"]) !== "true") return repoRoot;
	return ownerRoot;
}

function isWorktreeDirty(worktreePath: string): boolean {
	return runGit(worktreePath, ["status", "--porcelain"]).length > 0;
}

function resolveOptionalWorktreeName(args: string[], index: number): { name: string | null; nextIndex: number } {
	const next = args[index + 1];
	if (!next) return { name: null, nextIndex: index };
	if (next === "--") return { name: null, nextIndex: index };
	if (next.startsWith("-")) return { name: null, nextIndex: index };
	return { name: next.trim() || null, nextIndex: index + 1 };
}

export function parseLaunchWorktreeMode(args: string[]): ParsedLaunchWorktreeMode {
	let mode: GjcLaunchWorktreeMode = { enabled: false };
	const remainingArgs: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			remainingArgs.push(...args.slice(index));
			break;
		}
		if (arg === "--worktree" || arg === "-w") {
			const parsed = resolveOptionalWorktreeName(args, index);
			mode = parsed.name
				? { enabled: true, detached: false, name: parsed.name }
				: { enabled: true, detached: true, name: null };
			index = parsed.nextIndex;
			continue;
		}
		if (arg.startsWith("--worktree=")) {
			const name = arg.slice("--worktree=".length).trim();
			mode = name ? { enabled: true, detached: false, name } : { enabled: true, detached: true, name: null };
			continue;
		}
		if (arg.startsWith("-w=") || (arg.startsWith("-w") && arg.length > 2)) {
			const name = arg.startsWith("-w=") ? arg.slice("-w=".length).trim() : arg.slice(2).trim();
			mode = name ? { enabled: true, detached: false, name } : { enabled: true, detached: true, name: null };
			continue;
		}
		remainingArgs.push(arg);
	}

	return { mode, remainingArgs };
}

export function planLaunchWorktree(
	cwd: string,
	mode: GjcLaunchWorktreeMode,
): GjcLaunchWorktreePlan | { enabled: false } {
	if (!mode.enabled) return { enabled: false };
	const repoRoot = resolveCanonicalRepoRoot(cwd);
	const baseRef = runGit(repoRoot, ["rev-parse", "HEAD"]);
	const branchName = mode.detached ? null : mode.name;
	if (branchName) validateBranchName(repoRoot, branchName);
	const worktreeSlug = mode.detached ? resolveSourceBranchSlug(repoRoot, baseRef) : sanitizePathToken(mode.name);
	const worktreePath = path.join(resolveWorktreeBucket(repoRoot), worktreeSlug);
	if (path.resolve(worktreePath) === path.resolve(repoRoot)) throw new Error(`worktree_path_conflict:${worktreePath}`);
	return { enabled: true, repoRoot, worktreePath, detached: mode.detached, baseRef, branchName };
}

/**
 * Config subdirectory a launcher (e.g. paseo, #5570) may seed into the worktree target
 * before handing the path to gjc. `git worktree add` refuses any non-empty target, so
 * this artifact is evacuated and restored around the add rather than treated as a conflict.
 */
const PRE_WORKTREE_GJC_DIR = ".gjc";

/**
 * Assert that `target` resolves to a location contained within `parent`.
 *
 * Both paths are resolved through {@link fs.realpathSync} so a symlink anywhere along the
 * chain cannot smuggle a write outside the worktree bucket. Throws `worktree_path_conflict`
 * when the resolved target escapes the resolved parent.
 */
function assertRealpathContained(target: string, parent: string): void {
	const realParent = fs.realpathSync(parent);
	const realTarget = fs.realpathSync(target);
	if (realTarget === realParent || realTarget.startsWith(realParent + path.sep)) return;
	throw new Error(`worktree_path_conflict:${target}`);
}

/**
 * Whether an existing worktree target can be materialized in place. An empty directory,
 * or one holding nothing but a pre-seeded {@link PRE_WORKTREE_GJC_DIR}, is safe to replace;
 * anything else is a genuine `worktree_path_conflict`. A missing path is trivially usable.
 *
 * A symlinked target is never replaceable: evacuation and overlay writes would follow the
 * link out of the worktree bucket, so it is reported as a conflict instead.
 */
export function isReplaceableWorktreeTarget(worktreePath: string): boolean {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(worktreePath);
	} catch (error) {
		if (fileSystemErrorCode(error) === "ENOENT") return true;
		throw error;
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
	const entries = fs.readdirSync(worktreePath);
	return entries.every(entry => entry === PRE_WORKTREE_GJC_DIR);
}

/**
 * Restore a stashed pre-seeded `.gjc/` into `worktreePath`.
 *
 * `git worktree add` materializes any tracked `.gjc/**` content (e.g. `.gjc/qa/**`) into the
 * fresh worktree before this runs, so a bare rename would collide with EEXIST. When the target
 * already exists, the stashed launcher config is overlaid onto it — stash entries win on name
 * collision, tracked-only entries survive — and the stash is removed. When it does not exist
 * (the untracked case, or a rolled-back add that never checked out), the stash is renamed in.
 */
export function restorePreWorktreeGjc(gjcStash: string, worktreePath: string): void {
	fs.mkdirSync(worktreePath, { recursive: true });
	const target = path.join(worktreePath, PRE_WORKTREE_GJC_DIR);
	let targetStat: fs.Stats | null;
	try {
		targetStat = fs.lstatSync(target);
	} catch (error) {
		if (fileSystemErrorCode(error) === "ENOENT") targetStat = null;
		else throw error;
	}
	if (targetStat) {
		// `git worktree add` may have checked out a tracked `.gjc` symlink pointing outside the
		// worktree; a recursive cpSync into it would redirect the overlay off-tree. Reject it and
		// require the resolved destination to stay inside the worktree.
		if (targetStat.isSymbolicLink()) throw new Error(`worktree_path_conflict:${target}`);
		assertRealpathContained(target, worktreePath);
		fs.cpSync(gjcStash, target, { recursive: true, force: true });
		fs.rmSync(gjcStash, { recursive: true, force: true });
		return;
	}
	fs.renameSync(gjcStash, target);
}

/**
 * Handle returned by {@link evacuatePreWorktreeTarget}: a hook that restores the pre-seeded
 * `.gjc/` into the freshly created worktree, plus the sibling stash path it was moved to
 * (`null` when there was nothing to preserve). The stash path lets a failed restore report
 * where the pre-seeded config can be recovered by hand.
 */
export interface EvacuationHandle {
	restore: () => void;
	stashPath: string | null;
}

/**
 * Clear a {@link isReplaceableWorktreeTarget replaceable} target so `git worktree add` can
 * create it, moving any pre-seeded `.gjc/` to a sibling stash. Returns a hook that restores
 * `.gjc/` into the freshly created worktree; a no-op when there was nothing to preserve.
 */
export function evacuatePreWorktreeTarget(worktreePath: string): EvacuationHandle {
	if (!fs.existsSync(worktreePath)) return { restore: () => {}, stashPath: null };
	const gjcSource = path.join(worktreePath, PRE_WORKTREE_GJC_DIR);
	let gjcStat: fs.Stats | null;
	try {
		gjcStat = fs.lstatSync(gjcSource);
	} catch (error) {
		if (fileSystemErrorCode(error) === "ENOENT") gjcStat = null;
		else throw error;
	}
	if (!gjcStat) {
		fs.rmdirSync(worktreePath);
		return { restore: () => {}, stashPath: null };
	}
	// A symlinked `.gjc` would let the rename below (and the later overlay) escape the worktree
	// bucket. Refuse it as a path conflict rather than following the link off-tree.
	if (gjcStat.isSymbolicLink()) throw new Error(`worktree_path_conflict:${gjcSource}`);
	assertRealpathContained(gjcSource, worktreePath);
	const gjcStash = path.join(path.dirname(worktreePath), `.gjc-pre-wt-${path.basename(worktreePath)}`);
	// A lingering stash means a prior evacuation was interrupted before its restore ran, or the
	// path holds unrelated user data. Either way it is not ours to destroy: fail closed so the
	// operator can inspect and remove it, rather than overwriting it before the worktree add.
	if (fs.existsSync(gjcStash)) {
		throw new Error(`stash path already occupied: ${gjcStash} — remove it manually before retrying`);
	}
	fs.renameSync(gjcSource, gjcStash);
	fs.rmdirSync(worktreePath);
	return { restore: () => restorePreWorktreeGjc(gjcStash, worktreePath), stashPath: gjcStash };
}

/** Best-effort restore that never masks the failure that triggered it. */
function tryRestore(restore: () => void): void {
	try {
		restore();
	} catch {
		// The original worktree-add failure is the actionable one; leave restore best-effort.
	}
}

/** Best-effort removal of a worktree GJC just created, used when a later step must roll it back. */
function rollbackCreatedWorktree(plan: GjcLaunchWorktreePlan): void {
	try {
		runGit(plan.repoRoot, ["worktree", "remove", "--force", plan.worktreePath]);
	} catch {
		try {
			runGit(plan.repoRoot, ["worktree", "prune"]);
		} catch {
			// Best-effort rollback; the restore failure below is the actionable error.
		}
	}
}

/**
 * Finalize the pre-seeded `.gjc/` overlay after a successful `git worktree add`, transactionally.
 *
 * `git worktree add` has already registered and materialized the worktree by the time this runs,
 * so a restore/overlay failure cannot simply propagate: the half-prepared worktree would be
 * reused verbatim on the next launch (never restored, stash stranded). On failure this rolls the
 * newly created worktree back so a retry starts clean, preserves the stash for manual recovery,
 * and throws — success is never reported when restoration did not complete.
 */
export function commitPreWorktreeRestore(handle: EvacuationHandle, plan: GjcLaunchWorktreePlan): void {
	try {
		handle.restore();
	} catch (error) {
		rollbackCreatedWorktree(plan);
		const detail = error instanceof Error ? error.message : String(error);
		const recovery = handle.stashPath
			? `The stashed launcher .gjc was preserved at ${handle.stashPath} for manual recovery.`
			: "No launcher .gjc stash was created.";
		throw new Error(
			[
				`worktree_gjc_restore_failed:${plan.worktreePath}`,
				`GJC created the worktree but could not restore the pre-seeded .gjc overlay: ${detail}`,
				recovery,
				"The newly created worktree was rolled back; resolve the obstruction and relaunch.",
			].join("\n"),
		);
	}
}

/**
 * Acquire a per-target filesystem lock so the replaceability check, evacuation, `git worktree
 * add`, and restore run as one critical section. Without it a second launcher racing on the same
 * target could add files between the scan and the evacuation, or move `.gjc` first and strand the
 * partially modified target. The lock is an atomic `O_EXCL` lockfile beside the target (inside the
 * git-ignored bucket); a concurrent holder fails fast with `worktree_target_locked`.
 */
export function acquireTargetLock(worktreePath: string): () => void {
	const lockPath = path.join(path.dirname(worktreePath), `.gjc-lock-${path.basename(worktreePath)}`);
	try {
		fs.closeSync(fs.openSync(lockPath, "wx"));
	} catch (error) {
		if (fileSystemErrorCode(error) === "EEXIST") {
			throw new Error(
				`worktree_target_locked:${worktreePath} — another launch is preparing this worktree (lock: ${lockPath})`,
			);
		}
		throw error;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			fs.rmSync(lockPath, { force: true });
		} catch {
			// Best-effort release; a stranded lockfile is surfaced as worktree_target_locked next time.
		}
	};
}

function buildWorktreeAddArgs(plan: GjcLaunchWorktreePlan, branchAlreadyExisted: boolean): string[] {
	const args = ["worktree", "add"];
	if (plan.detached) args.push("--detach", plan.worktreePath, plan.baseRef);
	else if (branchAlreadyExisted) args.push(plan.worktreePath, plan.branchName ?? "");
	else args.push("-b", plan.branchName ?? "", plan.worktreePath, plan.baseRef);
	return args;
}

function classifyWorktreeAddFailure(plan: GjcLaunchWorktreePlan, args: string[], stderr: string): Error {
	if (plan.branchName && BRANCH_IN_USE_PATTERN.test(stderr)) return new Error(`branch_in_use:${plan.branchName}`);
	return new Error(stderr || `worktree_add_failed:${args.join(" ")}`);
}

export function ensureLaunchWorktree(
	plan: GjcLaunchWorktreePlan | { enabled: false },
	options?: LaunchWorktreeAbortOptions,
): GjcLaunchWorktreeResult | { enabled: false } {
	if (options?.signal || options?.deadlineAt !== undefined) {
		throw new Error("ensureLaunchWorktree is synchronous; use ensureLaunchWorktreeCancellable for abortable prep.");
	}
	return ensureLaunchWorktreeSync(plan);
}

function ensureLaunchWorktreeSync(
	plan: GjcLaunchWorktreePlan | { enabled: false },
): GjcLaunchWorktreeResult | { enabled: false } {
	if (!plan.enabled) return { enabled: false };
	const bucketPath = path.dirname(plan.worktreePath);
	inspectBucketDir(bucketPath);
	ensureRepositoryBucketIgnored(plan.repoRoot, bucketPath);
	let allWorktrees = listWorktrees(plan.repoRoot);
	const staleAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
	if (staleAtPath && !fs.existsSync(staleAtPath.path)) {
		pruneStaleWorktreePath(plan.repoRoot);
		allWorktrees = listWorktrees(plan.repoRoot);
	}

	const listedAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
	const existingAtPath = readWorktreeEntryFromPath(plan.repoRoot, plan.worktreePath);
	if (listedAtPath && !existingAtPath) {
		if (fs.existsSync(plan.worktreePath)) throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
		throw new Error(
			[
				"worktree_path_unavailable",
				"The requested launch worktree is still registered by Git but its directory is unavailable or locked.",
				`Path: ${formatBucketPath(plan.worktreePath)}`,
				"Safe remediation: inspect the worktree lock and remove or repair it with git worktree remove/prune when it is no longer needed, then relaunch. GJC did not delete or replace the entry.",
			].join("\n"),
		);
	}
	const expectedBranchRef = plan.branchName ? `refs/heads/${plan.branchName}` : null;

	if (existingAtPath) {
		let dirty = isWorktreeDirty(plan.worktreePath);
		if (plan.detached) {
			if (!existingAtPath.detached) {
				throw new Error(formatWorktreeTargetMismatch(plan, existingAtPath));
			}
			if (existingAtPath.head !== plan.baseRef) {
				if (dirty) throw new Error(`worktree_dirty:${plan.worktreePath}`);
				runGit(plan.worktreePath, ["checkout", "--detach", plan.baseRef]);
				dirty = false;
			}
		} else if (existingAtPath.branchRef !== expectedBranchRef) {
			throw new Error(formatWorktreeTargetMismatch(plan, existingAtPath));
		}
		return {
			...plan,
			worktreePath: path.resolve(plan.worktreePath),
			created: false,
			reused: true,
			createdBranch: false,
			...(dirty ? { dirty: true } : {}),
		};
	}

	if (!isReplaceableWorktreeTarget(plan.worktreePath)) throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
	if (plan.branchName && hasBranchInUse(allWorktrees, plan.branchName, plan.worktreePath)) {
		throw new Error(`branch_in_use:${plan.branchName}`);
	}

	ensureBucketDirUsable(path.dirname(plan.worktreePath));
	const releaseLock = acquireTargetLock(plan.worktreePath);
	try {
		// Re-check under the lock: a concurrent launcher may have populated the target between the
		// scan above and now. From here the check, evacuation, add, and restore are serialized.
		if (!isReplaceableWorktreeTarget(plan.worktreePath)) {
			throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
		}
		const branchAlreadyExisted = plan.branchName ? branchExists(plan.repoRoot, plan.branchName) : false;
		const args = buildWorktreeAddArgs(plan, branchAlreadyExisted);
		const evacuation = evacuatePreWorktreeTarget(plan.worktreePath);
		try {
			const result = Bun.spawnSync(["git", ...args], { cwd: plan.repoRoot, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) {
				throw classifyWorktreeAddFailure(plan, args, sanitizeWorktreeDiagnostic(result.stderr.toString().trim()));
			}
		} catch (error) {
			tryRestore(evacuation.restore);
			throw error;
		}
		commitPreWorktreeRestore(evacuation, plan);

		return {
			...plan,
			worktreePath: path.resolve(plan.worktreePath),
			created: true,
			reused: false,
			createdBranch: Boolean(plan.branchName && !branchAlreadyExisted),
		};
	} finally {
		releaseLock();
	}
}

export async function ensureLaunchWorktreeCancellable(
	plan: GjcLaunchWorktreePlan | { enabled: false },
	options: LaunchWorktreeAbortOptions = {},
): Promise<GjcLaunchWorktreeResult | { enabled: false }> {
	if (!plan.enabled) return { enabled: false };
	const timeout = new WorktreePreparationTimeoutError();
	throwIfAborted(options, timeout);
	const bucketPath = path.dirname(plan.worktreePath);
	inspectBucketDir(bucketPath);
	ensureRepositoryBucketIgnored(plan.repoRoot, bucketPath);
	let allWorktrees = listWorktrees(plan.repoRoot);
	const staleAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
	if (staleAtPath && !fs.existsSync(staleAtPath.path)) {
		pruneStaleWorktreePath(plan.repoRoot);
		allWorktrees = listWorktrees(plan.repoRoot);
	}
	throwIfAborted(options, timeout);

	const listedAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
	const existingAtPath = readWorktreeEntryFromPath(plan.repoRoot, plan.worktreePath);
	if (listedAtPath && !existingAtPath) {
		if (fs.existsSync(plan.worktreePath)) throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
		throw new Error(
			[
				"worktree_path_unavailable",
				"The requested launch worktree is still registered by Git but its directory is unavailable or locked.",
				`Path: ${formatBucketPath(plan.worktreePath)}`,
				"Safe remediation: inspect the worktree lock and remove or repair it with git worktree remove/prune when it is no longer needed, then relaunch. GJC did not delete or replace the entry.",
			].join("\n"),
		);
	}
	const expectedBranchRef = plan.branchName ? `refs/heads/${plan.branchName}` : null;

	if (existingAtPath) {
		let dirty = isWorktreeDirty(plan.worktreePath);
		if (plan.detached) {
			if (!existingAtPath.detached) {
				throw new Error(formatWorktreeTargetMismatch(plan, existingAtPath));
			}
			if (existingAtPath.head !== plan.baseRef) {
				if (dirty) throw new Error(`worktree_dirty:${plan.worktreePath}`);
				runGit(plan.worktreePath, ["checkout", "--detach", plan.baseRef]);
				dirty = false;
			}
		} else if (existingAtPath.branchRef !== expectedBranchRef) {
			throw new Error(formatWorktreeTargetMismatch(plan, existingAtPath));
		}
		return {
			...plan,
			worktreePath: path.resolve(plan.worktreePath),
			created: false,
			reused: true,
			createdBranch: false,
			...(dirty ? { dirty: true } : {}),
		};
	}

	if (!isReplaceableWorktreeTarget(plan.worktreePath)) throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
	if (plan.branchName && hasBranchInUse(allWorktrees, plan.branchName, plan.worktreePath)) {
		throw new Error(`branch_in_use:${plan.branchName}`);
	}

	ensureBucketDirUsable(path.dirname(plan.worktreePath));
	throwIfAborted(options, timeout);
	const releaseLock = acquireTargetLock(plan.worktreePath);
	try {
		// Re-check under the lock: a concurrent launcher may have populated the target between the
		// scan above and now. From here the check, evacuation, add, and restore are serialized.
		if (!isReplaceableWorktreeTarget(plan.worktreePath)) {
			throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
		}
		const branchAlreadyExisted = plan.branchName ? branchExists(plan.repoRoot, plan.branchName) : false;
		const args = buildWorktreeAddArgs(plan, branchAlreadyExisted);
		const evacuation = evacuatePreWorktreeTarget(plan.worktreePath);
		try {
			const result = await spawnProcessGroup(["git", ...args], plan.repoRoot, options, timeout);
			if (result.exitCode !== 0) {
				throw classifyWorktreeAddFailure(plan, args, sanitizeWorktreeDiagnostic(result.stderr.trim()));
			}
		} catch (error) {
			tryRestore(evacuation.restore);
			throw error;
		}
		commitPreWorktreeRestore(evacuation, plan);

		return {
			...plan,
			worktreePath: path.resolve(plan.worktreePath),
			created: true,
			reused: false,
			createdBranch: Boolean(plan.branchName && !branchAlreadyExisted),
		};
	} finally {
		releaseLock();
	}
}

interface WorkspacePackageManifest {
	packageManager?: unknown;
	workspaces?: unknown;
}

type WorkspacePackageManager = "bun" | "npm" | "pnpm";

interface ResolvedWorkspacePackageManager {
	name: WorkspacePackageManager;
	version: string | null;
}

function readWorkspacePackageManifest(worktreePath: string): WorkspacePackageManifest | null {
	const manifestPath = path.join(worktreePath, "package.json");
	try {
		return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as WorkspacePackageManifest;
	} catch (error) {
		if (fileSystemErrorCode(error) === "ENOENT") return null;
		throw error;
	}
}

function isWorkspaceRoot(worktreePath: string, manifest: WorkspacePackageManifest | null): boolean {
	return manifest?.workspaces !== undefined || fs.existsSync(path.join(worktreePath, "pnpm-workspace.yaml"));
}

function declaredPackageManager(
	manifest: WorkspacePackageManifest | null,
): { name: string; version: string | null } | null {
	if (typeof manifest?.packageManager !== "string") return null;
	const separator = manifest.packageManager.indexOf("@");
	const name = (separator < 0 ? manifest.packageManager : manifest.packageManager.slice(0, separator)).trim();
	if (!name) return null;
	const version = separator < 0 ? null : manifest.packageManager.slice(separator + 1).trim() || null;
	return { name, version };
}

function resolveWorkspacePackageManager(
	worktreePath: string,
	manifest: WorkspacePackageManifest | null,
): ResolvedWorkspacePackageManager {
	const declared = declaredPackageManager(manifest);
	if (declared !== null) {
		if (declared.name === "bun" || declared.name === "npm" || declared.name === "pnpm") {
			return { name: declared.name, version: declared.version };
		}
		throw new Error(`worktree_dependency_manager_unsupported:${declared.name}`);
	}

	const lockfileManagers: WorkspacePackageManager[] = [];
	if (fs.existsSync(path.join(worktreePath, "bun.lock")) || fs.existsSync(path.join(worktreePath, "bun.lockb"))) {
		lockfileManagers.push("bun");
	}
	if (fs.existsSync(path.join(worktreePath, "pnpm-lock.yaml"))) lockfileManagers.push("pnpm");
	if (
		fs.existsSync(path.join(worktreePath, "package-lock.json")) ||
		fs.existsSync(path.join(worktreePath, "npm-shrinkwrap.json"))
	) {
		lockfileManagers.push("npm");
	}
	if (lockfileManagers.length === 1) return { name: lockfileManagers[0] as WorkspacePackageManager, version: null };
	if (lockfileManagers.length === 0) throw new Error("worktree_dependency_lockfile_missing");
	throw new Error(`worktree_dependency_manager_ambiguous:${lockfileManagers.join(",")}`);
}

function removeLegacySourceNodeModulesLink(sourceRoot: string, worktreePath: string): void {
	const target = path.join(worktreePath, "node_modules");
	let targetStat: fs.Stats;
	try {
		targetStat = fs.lstatSync(target);
	} catch (error) {
		if (fileSystemErrorCode(error) === "ENOENT") return;
		throw error;
	}
	if (!targetStat.isSymbolicLink()) return;

	const sourceModules = path.join(sourceRoot, "node_modules");
	const linkTarget = path.resolve(path.dirname(target), fs.readlinkSync(target));
	let linksToSource = linkTarget === path.resolve(sourceModules);
	try {
		linksToSource = linksToSource || fs.realpathSync(target) === fs.realpathSync(sourceModules);
	} catch (error) {
		if (fileSystemErrorCode(error) !== "ENOENT") throw error;
	}
	if (!linksToSource) throw new Error(`worktree_node_modules_not_local:${target}`);
	fs.unlinkSync(target);
}

function workspaceInstallCommand(manager: ResolvedWorkspacePackageManager): string[] {
	const args = manager.name === "npm" ? ["ci"] : ["install", "--frozen-lockfile"];
	if (manager.name === "bun" || Bun.which(manager.name) !== null) return [manager.name, ...args];
	if (manager.version === null) throw new Error(`worktree_dependency_manager_unavailable:${manager.name}`);
	return ["bun", "x", `${manager.name}@${manager.version}`, ...args];
}

function installWorkspaceDependencies(
	sourceRoot: string,
	worktreePath: string,
	manifest: WorkspacePackageManifest | null,
): void {
	removeLegacySourceNodeModulesLink(sourceRoot, worktreePath);
	const manager = resolveWorkspacePackageManager(worktreePath, manifest);
	const command = workspaceInstallCommand(manager);
	let result: Bun.ReadableSyncSubprocess;
	try {
		result = Bun.spawnSync(command, {
			cwd: worktreePath,
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		throw new Error(
			`worktree_dependency_install_failed:${manager.name}:${sanitizeWorktreeDiagnostic(String(error))}`,
		);
	}
	if (result.exitCode !== 0) {
		throw new Error(
			`worktree_dependency_install_failed:${manager.name}:${sanitizeWorktreeDiagnostic(result.stderr.toString().trim())}`,
		);
	}
	let installed: fs.Stats;
	try {
		installed = fs.lstatSync(path.join(worktreePath, "node_modules"));
	} catch (error) {
		if (fileSystemErrorCode(error) === "ENOENT") return;
		throw error;
	}
	if (!installed.isDirectory() || installed.isSymbolicLink()) throw new Error("worktree_dependency_install_not_local");
}

async function installWorkspaceDependenciesCancellable(
	sourceRoot: string,
	worktreePath: string,
	manifest: WorkspacePackageManifest | null,
	options: LaunchWorktreeAbortOptions = {},
): Promise<void> {
	const timeout = new DependencyPreparationTimeoutError();
	throwIfAborted(options, timeout);
	removeLegacySourceNodeModulesLink(sourceRoot, worktreePath);
	const manager = resolveWorkspacePackageManager(worktreePath, manifest);
	const command = workspaceInstallCommand(manager);
	let result: { stdout: string; stderr: string; exitCode: number };
	try {
		result = await spawnProcessGroup(command, worktreePath, options, timeout);
	} catch (error) {
		if (error instanceof DependencyPreparationTimeoutError) throw error;
		throw new Error(
			`worktree_dependency_install_failed:${manager.name}:${sanitizeWorktreeDiagnostic(String(error))}`,
		);
	}
	if (result.exitCode !== 0) {
		throw new Error(
			`worktree_dependency_install_failed:${manager.name}:${sanitizeWorktreeDiagnostic(result.stderr.trim())}`,
		);
	}
	let installed: fs.Stats;
	try {
		installed = fs.lstatSync(path.join(worktreePath, "node_modules"));
	} catch (error) {
		if (fileSystemErrorCode(error) === "ENOENT") return;
		throw error;
	}
	if (!installed.isDirectory() || installed.isSymbolicLink()) throw new Error("worktree_dependency_install_not_local");
}

/** Workspace worktrees must own their complete lockfile-resolved dependency graph (#4620). */
export function ensureReusableNodeModules(sourceRoot: string, worktreePath: string): "symlink" | "present" | "missing" {
	const target = path.join(worktreePath, "node_modules");
	const manifest = readWorkspacePackageManifest(worktreePath);
	if (isWorkspaceRoot(worktreePath, manifest)) {
		installWorkspaceDependencies(sourceRoot, worktreePath, manifest);
		return "present";
	}
	if (fs.existsSync(target)) return "present";
	const source = path.join(sourceRoot, "node_modules");
	if (!fs.existsSync(source)) return "missing";
	fs.symlinkSync(source, target, "junction");
	return "symlink";
}

export async function ensureReusableNodeModulesCancellable(
	sourceRoot: string,
	worktreePath: string,
	options: LaunchWorktreeAbortOptions = {},
): Promise<"symlink" | "present" | "missing"> {
	const timeout = new DependencyPreparationTimeoutError();
	throwIfAborted(options, timeout);
	const target = path.join(worktreePath, "node_modules");
	const manifest = readWorkspacePackageManifest(worktreePath);
	if (isWorkspaceRoot(worktreePath, manifest)) {
		await installWorkspaceDependenciesCancellable(sourceRoot, worktreePath, manifest, options);
		return "present";
	}
	if (fs.existsSync(target)) return "present";
	const source = path.join(sourceRoot, "node_modules");
	if (!fs.existsSync(source)) return "missing";
	fs.symlinkSync(source, target, "junction");
	return "symlink";
}

/** Result of {@link prepareLaunchWorktree}: the effective working directory, remaining args, and resolved worktree plan. */
export interface PreparedLaunchWorktree {
	cwd: string;
	args: string[];
	worktree: GjcLaunchWorktreeResult | { enabled: false };
}

export function prepareLaunchWorktree(cwd: string, args: string[]): PreparedLaunchWorktree {
	const parsed = parseLaunchWorktreeMode(args);
	const planned = planLaunchWorktree(cwd, parsed.mode);
	const ensured = ensureLaunchWorktree(planned);
	if (!ensured.enabled) return { cwd, args: parsed.remainingArgs, worktree: ensured };
	ensureReusableNodeModules(ensured.repoRoot, ensured.worktreePath);
	return { cwd: ensured.worktreePath, args: parsed.remainingArgs, worktree: ensured };
}
export function removeOwnedLaunchWorktree(
	plan: GjcLaunchWorktreePlan,
	receipt: { created: boolean; reused: boolean; createdBranch: boolean },
): void {
	if (!receipt.created || receipt.reused) return;
	try {
		runGit(plan.repoRoot, ["worktree", "remove", "--force", plan.worktreePath]);
	} catch {
		try {
			runGit(plan.repoRoot, ["worktree", "prune"]);
		} catch {
			// Proof stays on the ledger; leftover classify is best-effort after abort.
		}
	}
	if (receipt.createdBranch && plan.branchName) {
		try {
			runGit(plan.repoRoot, ["branch", "-D", plan.branchName]);
		} catch {
			// Owned-branch delete is best-effort; collisions keep the pre-existing branch.
		}
	}
}
