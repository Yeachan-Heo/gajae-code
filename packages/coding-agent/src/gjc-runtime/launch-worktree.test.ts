import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EvacuationHandle, GjcLaunchWorktreePlan } from "./launch-worktree";
import {
	acquireTargetLock,
	commitPreWorktreeRestore,
	ensureLaunchWorktree,
	evacuatePreWorktreeTarget,
	isReplaceableWorktreeTarget,
	restorePreWorktreeGjc,
} from "./launch-worktree";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
}

function initRepo(prefix: string): string {
	const repo = makeTempDir(prefix);
	git(repo, ["init", "-q"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test"]);
	fs.writeFileSync(path.join(repo, "README.md"), "seed");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "init"]);
	return repo;
}

function countRegisteredWorktrees(repo: string): number {
	const raw = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: repo }).stdout.toString();
	return raw.split(/\r?\n/).filter(line => line.startsWith("worktree ")).length;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("isReplaceableWorktreeTarget", () => {
	test("accepts a real directory holding only .gjc", () => {
		const root = makeTempDir("gjc-replaceable-");
		const target = path.join(root, "wt");
		fs.mkdirSync(path.join(target, ".gjc"), { recursive: true });
		expect(isReplaceableWorktreeTarget(target)).toBe(true);
	});

	test("rejects other content", () => {
		const root = makeTempDir("gjc-replaceable-");
		const target = path.join(root, "wt");
		fs.mkdirSync(target, { recursive: true });
		fs.writeFileSync(path.join(target, "file.txt"), "x");
		expect(isReplaceableWorktreeTarget(target)).toBe(false);
	});

	test("rejects a symlinked target even when the resolved dir holds only .gjc", () => {
		const root = makeTempDir("gjc-replaceable-");
		const real = path.join(root, "real");
		fs.mkdirSync(path.join(real, ".gjc"), { recursive: true });
		const link = path.join(root, "link");
		fs.symlinkSync(real, link, "dir");
		expect(isReplaceableWorktreeTarget(link)).toBe(false);
	});
});

describe("evacuatePreWorktreeTarget", () => {
	test("rejects a symlinked .gjc before evacuation", () => {
		const root = makeTempDir("gjc-evacuate-");
		const target = path.join(root, "wt");
		fs.mkdirSync(target, { recursive: true });
		const outside = path.join(root, "outside");
		fs.mkdirSync(outside, { recursive: true });
		fs.symlinkSync(outside, path.join(target, ".gjc"), "dir");

		expect(() => evacuatePreWorktreeTarget(target)).toThrow(/worktree_path_conflict/);
		// The symlink target must be left untouched — evacuation must not follow it.
		expect(fs.existsSync(outside)).toBe(true);
		expect(fs.existsSync(path.join(root, ".gjc-pre-wt-wt"))).toBe(false);
	});
});

describe("restorePreWorktreeGjc", () => {
	test("rejects a symlinked overlay destination", () => {
		const root = makeTempDir("gjc-restore-");
		const worktree = path.join(root, "wt");
		fs.mkdirSync(worktree, { recursive: true });
		const outside = path.join(root, "outside");
		fs.mkdirSync(outside, { recursive: true });
		// A tracked `.gjc` symlink that `git worktree add` would have checked out.
		fs.symlinkSync(outside, path.join(worktree, ".gjc"), "dir");

		const stash = path.join(root, ".gjc-pre-wt-wt");
		fs.mkdirSync(stash, { recursive: true });
		fs.writeFileSync(path.join(stash, "seed.txt"), "seed");

		expect(() => restorePreWorktreeGjc(stash, worktree)).toThrow(/worktree_path_conflict/);
		// The overlay must not have leaked into the symlink target.
		expect(fs.existsSync(path.join(outside, "seed.txt"))).toBe(false);
	});
});

describe("commitPreWorktreeRestore", () => {
	test("rolls back the created worktree, preserves the stash, and refuses to report success", () => {
		const repo = initRepo("gjc-tx-repo-");
		const bucket = makeTempDir("gjc-tx-bucket-");
		const worktreePath = path.join(bucket, "wt");
		git(repo, ["worktree", "add", "-q", "--detach", worktreePath, "HEAD"]);
		expect(fs.existsSync(path.join(worktreePath, ".git"))).toBe(true);
		expect(countRegisteredWorktrees(repo)).toBe(2);

		// A stash that the (failing) restore left behind for recovery.
		const stashPath = path.join(bucket, ".gjc-pre-wt-wt");
		fs.mkdirSync(stashPath, { recursive: true });
		fs.writeFileSync(path.join(stashPath, "launcher.txt"), "config");

		const plan: GjcLaunchWorktreePlan = {
			enabled: true,
			repoRoot: repo,
			worktreePath,
			detached: true,
			baseRef: "HEAD",
			branchName: null,
		};
		const handle: EvacuationHandle = {
			restore: () => {
				throw new Error("overlay exploded");
			},
			stashPath,
		};

		let message = "";
		try {
			commitPreWorktreeRestore(handle, plan);
			throw new Error("expected commitPreWorktreeRestore to throw");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/worktree_gjc_restore_failed/);
		// Stash location is surfaced for manual recovery.
		expect(message).toContain(stashPath);

		// The worktree was rolled back: its directory is gone and Git no longer registers it.
		expect(fs.existsSync(worktreePath)).toBe(false);
		expect(countRegisteredWorktrees(repo)).toBe(1);
		// The stash survives so the pre-seeded launcher config can be recovered.
		expect(fs.existsSync(path.join(stashPath, "launcher.txt"))).toBe(true);

		// A subsequent retry starts from a clean slate.
		git(repo, ["worktree", "add", "-q", "--detach", worktreePath, "HEAD"]);
		expect(fs.existsSync(path.join(worktreePath, ".git"))).toBe(true);
	});

	test("removes the stash and reports success when restore completes", () => {
		const repo = initRepo("gjc-tx-repo-");
		const bucket = makeTempDir("gjc-tx-bucket-");
		const worktreePath = path.join(bucket, "wt");
		git(repo, ["worktree", "add", "-q", "--detach", worktreePath, "HEAD"]);

		const stashPath = path.join(bucket, ".gjc-pre-wt-wt");
		fs.mkdirSync(stashPath, { recursive: true });
		fs.writeFileSync(path.join(stashPath, "launcher.txt"), "config");

		const plan: GjcLaunchWorktreePlan = {
			enabled: true,
			repoRoot: repo,
			worktreePath,
			detached: true,
			baseRef: "HEAD",
			branchName: null,
		};
		const handle: EvacuationHandle = {
			restore: () => restorePreWorktreeGjc(stashPath, worktreePath),
			stashPath,
		};

		expect(() => commitPreWorktreeRestore(handle, plan)).not.toThrow();
		// Overlay landed inside the worktree and the stash was consumed.
		expect(fs.existsSync(path.join(worktreePath, ".gjc", "launcher.txt"))).toBe(true);
		expect(fs.existsSync(stashPath)).toBe(false);
		expect(countRegisteredWorktrees(repo)).toBe(2);
	});
});

describe("acquireTargetLock", () => {
	test("a second concurrent acquire fails while the first holds the lock", () => {
		const bucket = makeTempDir("gjc-lock-");
		const worktreePath = path.join(bucket, "wt");
		fs.mkdirSync(path.join(worktreePath, ".gjc"), { recursive: true });

		const release = acquireTargetLock(worktreePath);
		expect(() => acquireTargetLock(worktreePath)).toThrow(/worktree_target_locked/);
		// The contended target is left intact — the loser touched nothing.
		expect(fs.readdirSync(worktreePath)).toEqual([".gjc"]);

		release();
		// After release the lockfile is gone and the lock is reusable.
		expect(fs.existsSync(path.join(bucket, ".gjc-lock-wt"))).toBe(false);
		acquireTargetLock(worktreePath)();
	});

	test("release is idempotent", () => {
		const bucket = makeTempDir("gjc-lock-");
		const worktreePath = path.join(bucket, "wt");
		fs.mkdirSync(worktreePath, { recursive: true });
		const release = acquireTargetLock(worktreePath);
		release();
		expect(() => release()).not.toThrow();
	});

	test("ensureLaunchWorktree refuses a target already locked by another launcher", () => {
		const repo = initRepo("gjc-lock-repo-");
		const bucket = makeTempDir("gjc-lock-bucket-");
		const worktreePath = path.join(bucket, "wt");
		const plan: GjcLaunchWorktreePlan = {
			enabled: true,
			repoRoot: repo,
			worktreePath,
			detached: true,
			baseRef: "HEAD",
			branchName: null,
		};

		const release = acquireTargetLock(worktreePath);
		try {
			expect(() => ensureLaunchWorktree(plan)).toThrow(/worktree_target_locked/);
			// The losing launcher never created the worktree.
			expect(fs.existsSync(worktreePath)).toBe(false);
			expect(countRegisteredWorktrees(repo)).toBe(1);
		} finally {
			release();
		}

		// Once the lock is released the same launch succeeds cleanly.
		const result = ensureLaunchWorktree(plan);
		expect(result.enabled).toBe(true);
		expect(fs.existsSync(path.join(worktreePath, ".git"))).toBe(true);
	});
});
