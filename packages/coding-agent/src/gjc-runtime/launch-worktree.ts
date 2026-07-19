import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

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

interface GitWorktreeEntry {
	path: string;
	head: string;
	branchRef: string | null;
	detached: boolean;
}

const BRANCH_IN_USE_PATTERN = /already checked out|already used by worktree|is already checked out/i;

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return result.stdout.toString().trim();
	const stderr = result.stderr.toString().trim();
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

function pruneStaleWorktreePath(repoRoot: string): void {
	runGit(repoRoot, ["worktree", "prune"]);
}

function readWorktreeEntryFromPath(repoRoot: string, worktreePath: string): GitWorktreeEntry | null {
	if (!fs.existsSync(worktreePath)) return null;
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
	if (next === "--") return { name: null, nextIndex: index + 1 };
	if (next.startsWith("-")) return { name: null, nextIndex: index };
	return { name: next.trim() || null, nextIndex: index + 1 };
}

export function parseLaunchWorktreeMode(args: string[]): ParsedLaunchWorktreeMode {
	let mode: GjcLaunchWorktreeMode = { enabled: false };
	const remainingArgs: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
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
	const bucket = `${path.basename(repoRoot)}.gajae-code-worktrees`;
	const worktreeSlug = mode.detached ? resolveSourceBranchSlug(repoRoot, baseRef) : sanitizePathToken(mode.name);
	const worktreePath = path.join(path.dirname(repoRoot), bucket, worktreeSlug);
	return { enabled: true, repoRoot, worktreePath, detached: mode.detached, baseRef, branchName };
}

export function ensureLaunchWorktree(
	plan: GjcLaunchWorktreePlan | { enabled: false },
): GjcLaunchWorktreeResult | { enabled: false } {
	if (!plan.enabled) return { enabled: false };
	let allWorktrees = listWorktrees(plan.repoRoot);
	const staleAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
	if (staleAtPath && !fs.existsSync(staleAtPath.path)) {
		pruneStaleWorktreePath(plan.repoRoot);
		allWorktrees = listWorktrees(plan.repoRoot);
	}

	const existingAtPath =
		findWorktreeByPath(allWorktrees, plan.worktreePath) ??
		readWorktreeEntryFromPath(plan.repoRoot, plan.worktreePath);
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

	if (fs.existsSync(plan.worktreePath)) throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
	if (plan.branchName && hasBranchInUse(allWorktrees, plan.branchName, plan.worktreePath)) {
		throw new Error(`branch_in_use:${plan.branchName}`);
	}

	fs.mkdirSync(path.dirname(plan.worktreePath), { recursive: true });
	const branchAlreadyExisted = plan.branchName ? branchExists(plan.repoRoot, plan.branchName) : false;
	const args = ["worktree", "add"];
	if (plan.detached) args.push("--detach", plan.worktreePath, plan.baseRef);
	else if (branchAlreadyExisted) args.push(plan.worktreePath, plan.branchName ?? "");
	else args.push("-b", plan.branchName ?? "", plan.worktreePath, plan.baseRef);

	const result = Bun.spawnSync(["git", ...args], { cwd: plan.repoRoot, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		if (plan.branchName && BRANCH_IN_USE_PATTERN.test(stderr)) throw new Error(`branch_in_use:${plan.branchName}`);
		throw new Error(stderr || `worktree_add_failed:${args.join(" ")}`);
	}

	return {
		...plan,
		worktreePath: path.resolve(plan.worktreePath),
		created: true,
		reused: false,
		createdBranch: Boolean(plan.branchName && !branchAlreadyExisted),
	};
}

export function ensureReusableNodeModules(sourceRoot: string, worktreePath: string): "symlink" | "present" | "missing" {
	const target = path.join(worktreePath, "node_modules");
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
