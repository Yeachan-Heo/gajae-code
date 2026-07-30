import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@gajae-code/natives";
import { acquireDurableWorktree, releaseDurableWorktree } from "../../src/task/git-worktree";
import {
	captureBaseline,
	captureDeltaPatch,
	ensureIsolation,
	getGitNoIndexNullPath,
	mergeTaskBranches,
	parseIsolationMode,
} from "../../src/task/worktree";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return stdout.trim();
}

async function createGitRepo(): Promise<{ baseBranch: string; repo: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-worktree-"));
	tempDirs.push(repo);
	await runGit(repo, ["init"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "merged.txt"), "base version\n");
	await fs.writeFile(path.join(repo, "staged.txt"), "base staged\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return {
		baseBranch: await runGit(repo, ["branch", "--show-current"]),
		repo,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("worktree isolation helpers", () => {
	it("returns platform-specific null path for git --no-index diffs", () => {
		const expected = process.platform === "win32" ? "NUL" : "/dev/null";
		expect(getGitNoIndexNullPath()).toBe(expected);
	});

	it("maps every isolation mode to the native backend contract", () => {
		expect(parseIsolationMode("none")).toBeUndefined();
		expect(parseIsolationMode("auto")).toBeUndefined();
		expect(parseIsolationMode("apfs")).toBe(natives.IsoBackendKind.Apfs);
		expect(parseIsolationMode("btrfs")).toBe(natives.IsoBackendKind.Btrfs);
		expect(parseIsolationMode("zfs")).toBe(natives.IsoBackendKind.Zfs);
		expect(parseIsolationMode("reflink")).toBe(natives.IsoBackendKind.LinuxReflink);
		expect(parseIsolationMode("overlayfs")).toBe(natives.IsoBackendKind.Overlayfs);
		expect(parseIsolationMode("fuse-overlay")).toBe(natives.IsoBackendKind.Overlayfs);
		expect(parseIsolationMode("projfs")).toBe(natives.IsoBackendKind.Projfs);
		expect(parseIsolationMode("fuse-projfs")).toBe(natives.IsoBackendKind.Projfs);
		expect(parseIsolationMode("block-clone")).toBe(natives.IsoBackendKind.WindowsBlockClone);
		expect(parseIsolationMode("rcopy")).toBe(natives.IsoBackendKind.Rcopy);
		expect(parseIsolationMode("worktree")).toBe(natives.IsoBackendKind.Rcopy);
	});

	it("keeps the legacy `worktree` isolation mode on the disposable PAL/Rcopy path", () => {
		// The durable `task` `worktree` field is a separate concern: it must not steal or reinterpret
		// the legacy `task.isolation.mode="worktree"` alias, which stays PAL/Rcopy for existing installs.
		expect(parseIsolationMode("worktree")).toBe(natives.IsoBackendKind.Rcopy);
		expect(parseIsolationMode("worktree")).toBe(parseIsolationMode("rcopy"));
		// And `none` still means "no PAL isolation" rather than routing anywhere new.
		expect(parseIsolationMode("none")).toBeUndefined();
	});

	it("provisions durable worktrees independently of the PAL isolation mode", async () => {
		const { repo } = await createGitRepo();
		// `task.isolation.mode="none"` disables PAL isolation entirely; the durable worktree path must
		// still work, because it is the counterpart of `gjc --worktree`, not a PAL backend.
		expect(parseIsolationMode("none")).toBeUndefined();

		const acquired = await acquireDurableWorktree(repo, true, "LEGACY-1");
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;
		expect(acquired.info.created).toBe(true);
		const realRepo = await fs.realpath(repo);
		const bucket = path.join(path.dirname(realRepo), `${path.basename(realRepo)}.gajae-code-worktrees`);
		expect(acquired.worktreePath.startsWith(bucket)).toBe(true);
		releaseDurableWorktree(acquired.worktreePath);

		Bun.spawnSync(["git", "worktree", "remove", "--force", acquired.worktreePath], {
			cwd: repo,
			stdout: "ignore",
			stderr: "ignore",
		});
		await fs.rm(bucket, { recursive: true, force: true });
	});

	it("retries isoResolve candidates when a backend is path-unavailable", async () => {
		const { repo } = await createGitRepo();
		const unavailable = new Error("ISO_UNAVAILABLE: btrfs source is not a subvolume");
		const isoResolve = vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Btrfs,
			candidates: [natives.IsoBackendKind.Btrfs, natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		const isoStart = vi
			.spyOn(natives, "isoStart")
			.mockRejectedValueOnce(unavailable)
			.mockResolvedValueOnce(undefined);
		vi.spyOn(natives, "isoIsUnavailableError").mockImplementation(message => message.startsWith("ISO_UNAVAILABLE:"));

		const handle = await ensureIsolation(repo, "retry-path-unavailable");

		expect(isoResolve).toHaveBeenCalledWith(null);
		expect(isoStart.mock.calls.map(call => call[0])).toEqual([
			natives.IsoBackendKind.Btrfs,
			natives.IsoBackendKind.Rcopy,
		]);
		expect(handle.backend).toBe(natives.IsoBackendKind.Rcopy);
		expect(handle.fellBack).toBe(true);
		expect(handle.fallbackReason).toBe(unavailable.message);
	});

	it("does not pop an unrelated pre-existing stash when the working tree is clean", async () => {
		const { repo } = await createGitRepo();
		await fs.writeFile(path.join(repo, "preexisting.txt"), "user stash\n");
		await runGit(repo, ["stash", "push", "--include-untracked", "-m", "preexisting-user-stash"]);
		const before = await runGit(repo, ["stash", "list"]);

		const result = await mergeTaskBranches(repo, []);

		expect(result).toEqual({ failed: [], merged: [] });
		expect(await runGit(repo, ["stash", "list"])).toBe(before);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("");
	});

	it("restores staged changes with index preservation after merging task branches", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-staged";
		await runGit(repo, ["checkout", "-b", taskBranch]);
		await fs.writeFile(path.join(repo, "merged.txt"), "task branch change\n");
		await runGit(repo, ["add", "merged.txt"]);
		await runGit(repo, ["commit", "-m", "task-change"]);
		await runGit(repo, ["checkout", baseBranch]);
		await fs.writeFile(path.join(repo, "staged.txt"), "local staged change\n");
		await runGit(repo, ["add", "staged.txt"]);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("M  staged.txt");

		const result = await mergeTaskBranches(repo, [{ branchName: taskBranch, taskId: "task-1" }]);

		expect(result).toEqual({ failed: [], merged: [taskBranch] });
		expect(await fs.readFile(path.join(repo, "merged.txt"), "utf8")).toBe("task branch change\n");
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("M  staged.txt");
		expect(await runGit(repo, ["diff", "--cached", "--", "staged.txt"])).toContain("+local staged change");
		expect(await runGit(repo, ["stash", "list"])).toBe("");
	});

	it("subtracts baseline dirty state even when the task commits it", async () => {
		const { repo } = await createGitRepo();
		await fs.writeFile(path.join(repo, "merged.txt"), "baseline dirty change\n");
		await fs.writeFile(path.join(repo, "preexisting.txt"), "baseline untracked\n");
		const baseline = await captureBaseline(repo);

		await runGit(repo, ["add", "-A"]);
		await runGit(repo, ["commit", "-m", "baseline committed inside isolation"]);
		await fs.writeFile(path.join(repo, "task.txt"), "task output\n");
		await runGit(repo, ["add", "task.txt"]);
		await runGit(repo, ["commit", "-m", "task output"]);

		const delta = await captureDeltaPatch(repo, baseline);

		expect(delta.nestedPatches).toEqual([]);
		expect(delta.rootPatch).toContain("task.txt");
		expect(delta.rootPatch).toContain("+task output");
		expect(delta.rootPatch).not.toContain("baseline dirty change");
		expect(delta.rootPatch).not.toContain("preexisting.txt");
	});
});
