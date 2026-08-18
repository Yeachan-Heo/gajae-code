import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeRunModifiedPaths,
	discardAutoresearchRun,
	ensureAutoresearchBranch,
	getCurrentAutoresearchBranch,
	keepAutoresearchRun,
	slugifyGoal,
} from "../../src/autoresearch/git";
import * as git from "../../src/utils/git";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-autoresearch-git-"));
	tempRoots.push(dir);
	return dir;
}

function runGit(cwd: string, ...args: string[]): string {
	const result = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return result.trim();
}

function initRepo(): string {
	const dir = tempDir();
	runGit(dir, "init", "-b", "main");
	runGit(dir, "config", "user.email", "test@example.com");
	runGit(dir, "config", "user.name", "Autoresearch Test");
	fs.writeFileSync(path.join(dir, "baseline.txt"), "baseline\n", "utf8");
	runGit(dir, "add", "baseline.txt");
	runGit(dir, "commit", "-m", "baseline");
	return dir;
}

function currentBranch(dir: string): string {
	return runGit(dir, "branch", "--show-current");
}

function fileContent(dir: string, name: string): string {
	return fs.readFileSync(path.join(dir, name), "utf8");
}

describe("autoresearch branch isolation (git)", () => {
	it("creates and checks out an autoresearch/* branch from a slugified goal on a clean tree", async () => {
		const dir = initRepo();
		const result = await ensureAutoresearchBranch(dir, "Optimize the Tokenizer! hot path");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.created).toBe(true);
		expect(result.branchName).toMatch(/^autoresearch\/optimize-the-tokenizer-hot-path-\d{8}$/);
		expect(currentBranch(dir)).toBe(result.branchName ?? "");
		expect(result.warning).toBeUndefined();
	});

	it("slugifies the goal into a safe branch segment", () => {
		expect(slugifyGoal("Optimize the Tokenizer! hot path")).toBe("optimize-the-tokenizer-hot-path");
		expect(slugifyGoal("Über 速度 test")).toBe("ber-test");
		expect(slugifyGoal("!!!")).toBe("session");
	});

	it("returns a warning and stays on the current branch when the tree is dirty and not on an autoresearch branch", async () => {
		const dir = initRepo();
		fs.writeFileSync(path.join(dir, "baseline.txt"), "dirty edit\n", "utf8");
		const branchBefore = currentBranch(dir);

		const result = await ensureAutoresearchBranch(dir, "dirty start");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Degraded mode: no branch was created, a warning is surfaced, we continue.
		expect(result.created).toBe(false);
		expect(result.branchName).toBeNull();
		expect(result.warning).toContain("Worktree is dirty");
		expect(result.warning).toContain("keep");
		expect(result.warning).toContain("discard");
		expect(currentBranch(dir)).toBe(branchBefore);
	});

	it("returns the existing branch when already on an autoresearch branch (even dirty)", async () => {
		const dir = initRepo();
		const created = await ensureAutoresearchBranch(dir, "resume me");
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		fs.writeFileSync(path.join(dir, "wip.txt"), "wip\n", "utf8");

		const again = await ensureAutoresearchBranch(dir, "resume me");
		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.created).toBe(false);
		expect(again.branchName).toBe(created.branchName);
		expect(again.warning).toBeUndefined();
	});

	it("warns and continues when there is no git repository", async () => {
		const dir = tempDir();
		const result = await ensureAutoresearchBranch(dir, "no repo");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchName).toBeNull();
		expect(result.warning).toContain("Not in a git repository");
	});

	it("allocates a unique branch name when the dated branch already exists", async () => {
		const dir = initRepo();
		const first = await ensureAutoresearchBranch(dir, "unique name");
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		// Back to a clean main, then create again: the same date stamp forces a suffix.
		runGit(dir, "checkout", "main");
		const second = await ensureAutoresearchBranch(dir, "unique name");
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.branchName).toBe(`${first.branchName}-2`);
	});

	it("keep auto-commits on an autoresearch branch and skips auto-commit off-branch", async () => {
		const dir = initRepo();
		const branch = await ensureAutoresearchBranch(dir, "keep me");
		expect(branch.ok).toBe(true);
		if (!branch.ok) return;
		expect(branch.branchName).not.toBeNull();
		fs.writeFileSync(path.join(dir, "change.txt"), "v1\n", "utf8");

		const kept = await keepAutoresearchRun({
			cwd: dir,
			description: "first improvement",
			status: "keep",
			metric: 3.5,
			metrics: { peak_mem_mb: 12 },
			files: ["change.txt"],
			onAutoresearchBranch: true,
			primaryMetric: "latency_ms",
		});
		expect(kept.error).toBeUndefined();
		expect(kept.commitHash).toBeTruthy();
		const headSha = await git.head.sha(dir);
		expect(kept.commitHash).toBe(headSha);
		const message = runGit(dir, "log", "-1", "--format=%s");
		expect(message).toBe("first improvement");
		// The commit carries the metric payload for provenance.
		const body = runGit(dir, "log", "-1", "--format=%b");
		expect(body).toContain('"latency_ms":3.5');
		expect(body).toContain('"peak_mem_mb":12');

		// Off-branch (degraded): no commit is created, files stay in the worktree.
		runGit(dir, "checkout", "main");
		fs.writeFileSync(path.join(dir, "offbranch.txt"), "v1\n", "utf8");
		const skipped = await keepAutoresearchRun({
			cwd: dir,
			description: "off branch keep",
			status: "keep",
			metric: 1,
			metrics: {},
			files: ["offbranch.txt"],
			onAutoresearchBranch: false,
			primaryMetric: "latency_ms",
		});
		expect(skipped.error).toBeUndefined();
		expect(skipped.note).toContain("Auto-commit skipped");
		expect(skipped.commitHash).toBeNull();
		expect(fs.existsSync(path.join(dir, "offbranch.txt"))).toBe(true);
	});

	it("discard resets to HEAD on an autoresearch branch and reverts only run-modified paths off-branch", async () => {
		const dir = initRepo();
		const branch = await ensureAutoresearchBranch(dir, "discard me");
		expect(branch.ok).toBe(true);
		if (!branch.ok) return;

		// On-branch discard: iteration edits vanish, prior keep commit survives.
		fs.writeFileSync(path.join(dir, "kept.txt"), "kept\n", "utf8");
		await keepAutoresearchRun({
			cwd: dir,
			description: "keep prior",
			status: "keep",
			metric: 1,
			metrics: {},
			files: ["kept.txt"],
			onAutoresearchBranch: true,
			primaryMetric: "latency_ms",
		});
		fs.writeFileSync(path.join(dir, "kept.txt"), "iteration edit\n", "utf8");
		fs.writeFileSync(path.join(dir, "fresh.txt"), "fresh\n", "utf8");
		const discarded = await discardAutoresearchRun({
			cwd: dir,
			preRunDirtyPaths: [],
			onAutoresearchBranch: true,
		});
		expect(discarded.error).toBeUndefined();
		expect(discarded.note).toBe("worktree reset to HEAD");
		expect(fileContent(dir, "kept.txt")).toBe("kept\n");
		expect(fs.existsSync(path.join(dir, "fresh.txt"))).toBe(false);

		// Off-branch (degraded): only run-modified paths revert; pre-existing user dirt survives.
		runGit(dir, "checkout", "main");
		fs.writeFileSync(path.join(dir, "user-dirty.txt"), "user work\n", "utf8");
		const preRunDirty = ["user-dirty.txt"];
		fs.writeFileSync(path.join(dir, "user-dirty.txt"), "user work + run touch\n", "utf8");
		fs.writeFileSync(path.join(dir, "run-created.txt"), "run\n", "utf8");
		const degraded = await discardAutoresearchRun({
			cwd: dir,
			preRunDirtyPaths: preRunDirty,
			onAutoresearchBranch: false,
		});
		expect(degraded.error).toBeUndefined();
		expect(degraded.note).toContain("reverted");
		// The run-created file is gone; pre-existing user dirt is left exactly as the run left it.
		expect(fileContent(dir, "user-dirty.txt")).toBe("user work + run touch\n");
		expect(fs.existsSync(path.join(dir, "run-created.txt"))).toBe(false);
	});

	it("computeRunModifiedPaths isolates run changes from pre-existing dirt", async () => {
		const dir = initRepo();
		fs.writeFileSync(path.join(dir, "pre.txt"), "pre\n", "utf8");
		const statusBefore = runGit(dir, "status", "--porcelain=v1", "-z", "--untracked-files=all");
		const { tracked, untracked } = computeRunModifiedPaths(["pre.txt"], statusBefore, "");
		// pre.txt is pre-existing dirt: it must not appear as a run modification.
		expect(tracked).toEqual([]);
		expect(untracked).toEqual([]);

		fs.writeFileSync(path.join(dir, "run.txt"), "run\n", "utf8");
		const statusAfter = runGit(dir, "status", "--porcelain=v1", "-z", "--untracked-files=all");
		const after = computeRunModifiedPaths(["pre.txt"], statusAfter, "");
		expect(after.tracked).toEqual([]);
		expect(after.untracked).toEqual(["run.txt"]);
	});

	it("getCurrentAutoresearchBranch identifies only autoresearch/* branches", async () => {
		const dir = initRepo();
		expect(await getCurrentAutoresearchBranch(dir)).toBeNull();
		const created = await ensureAutoresearchBranch(dir, "identity");
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(await getCurrentAutoresearchBranch(dir)).toBe(created.branchName);
	});
});
