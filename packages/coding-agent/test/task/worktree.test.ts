import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@gajae-code/natives";
import { readLaneRecord, writeLaneRecord } from "../../src/gjc-runtime/git-lifecycle";
import {
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
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

async function registerManagedDestination(repo: string, baseBranch: string): Promise<string> {
	const commonValue = await runGit(repo, ["rev-parse", "--git-common-dir"]);
	const commonDir = path.resolve(repo, commonValue);
	const now = new Date().toISOString();
	await fs.mkdir(path.join(commonDir, "gjc", "lifecycle", "v1"), { recursive: true });
	await fs.writeFile(path.join(commonDir, "gjc", "lifecycle", "v1", "policy.json"), "{}\n");
	await writeLaneRecord(commonDir, {
		version: 1,
		laneId: "task-lane",
		state: "active",
		repositoryId: "test-repository",
		realm: process.platform === "win32" ? "windows" : "wsl",
		branch: baseBranch,
		worktreeToken: path.basename(repo),
		worktreePath: repo,
		agent: "gjc",
		sessionId: "test-session",
		gitCommonDir: commonDir,
		headSha: await runGit(repo, ["rev-parse", "HEAD"]),
		createdAt: now,
		updatedAt: now,
	});
	return commonDir;
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

	it("allocates unique owned isolation directories and cleans only the matching handle", async () => {
		const { repo } = await createGitRepo();
		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		vi.spyOn(natives, "isoStart").mockImplementation(async (_backend, _source, mergedDir) => {
			await fs.mkdir(mergedDir, { recursive: true });
		});
		vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);

		const first = await ensureIsolation(repo, "same-task");
		const second = await ensureIsolation(repo, "same-task");
		expect(first.baseDir).not.toBe(second.baseDir);

		await cleanupIsolation(first);
		expect(await fs.stat(second.mergedDir)).toBeDefined();
		await cleanupIsolation(second);
	});

	async function createTaskBranch(repo: string, baseBranch: string, branchName: string): Promise<void> {
		await runGit(repo, ["checkout", "-b", branchName]);
		await fs.writeFile(path.join(repo, "merged.txt"), "task branch change\n");
		await runGit(repo, ["add", "merged.txt"]);
		await runGit(repo, ["commit", "-m", "task change"]);
		await runGit(repo, ["checkout", baseBranch]);
	}

	async function captureDestination(
		repo: string,
		files: string[],
	): Promise<{
		cachedDiff: string;
		files: Uint8Array[];
		head: string;
		index: string;
		refs: string;
		stash: string;
		status: string;
		unstagedDiff: string;
	}> {
		return {
			cachedDiff: await runGit(repo, ["diff", "--cached", "--binary"]),
			files: await Promise.all(files.map(file => fs.readFile(path.join(repo, file)))),
			head: await runGit(repo, ["rev-parse", "HEAD"]),
			index: await runGit(repo, ["ls-files", "--stage"]),
			refs: await runGit(repo, ["show-ref", "--head"]),
			stash: await runGit(repo, ["stash", "list"]),
			status: await runGit(repo, ["status", "--porcelain=v1"]),
			unstagedDiff: await runGit(repo, ["diff", "--binary"]),
		};
	}

	async function expectDirtyDestinationRejected(repo: string, taskBranch: string, files: string[]): Promise<void> {
		const before = await captureDestination(repo, files);

		const result = await mergeTaskBranches(repo, [{ branchName: taskBranch, taskId: "task-1" }]);

		expect(result).toEqual({
			merged: [],
			failed: [taskBranch],
			conflict: "Destination working tree is dirty; refusing to cherry-pick task branches.",
		});
		expect(await captureDestination(repo, files)).toEqual(before);
	}

	it("keeps an unrelated pre-existing stash when the destination is clean", async () => {
		const { repo } = await createGitRepo();
		await fs.writeFile(path.join(repo, "preexisting.txt"), "user stash\n");
		await runGit(repo, ["stash", "push", "--include-untracked", "-m", "preexisting-user-stash"]);
		const before = await runGit(repo, ["stash", "list"]);

		const result = await mergeTaskBranches(repo, []);

		expect(result).toEqual({ failed: [], merged: [] });
		expect(await runGit(repo, ["stash", "list"])).toBe(before);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("");
	});

	it("fails closed without changing a staged destination", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-staged";
		await createTaskBranch(repo, baseBranch, taskBranch);
		await fs.writeFile(path.join(repo, "stash-seed.txt"), "user stash\n");
		await runGit(repo, ["stash", "push", "--include-untracked", "-m", "preexisting-user-stash"]);
		await fs.writeFile(path.join(repo, "staged.txt"), "local staged change\n");
		await runGit(repo, ["add", "staged.txt"]);

		await expectDirtyDestinationRejected(repo, taskBranch, ["staged.txt"]);
	});

	it("fails closed without changing an unstaged destination", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-unstaged";
		await createTaskBranch(repo, baseBranch, taskBranch);
		await fs.writeFile(path.join(repo, "stash-seed.txt"), "user stash\n");
		await runGit(repo, ["stash", "push", "--include-untracked", "-m", "preexisting-user-stash"]);
		await fs.writeFile(path.join(repo, "staged.txt"), "local unstaged change\n");

		await expectDirtyDestinationRejected(repo, taskBranch, ["staged.txt"]);
	});

	it("fails closed without changing an untracked destination", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-untracked";
		await createTaskBranch(repo, baseBranch, taskBranch);
		await fs.writeFile(path.join(repo, "stash-seed.txt"), "user stash\n");
		await runGit(repo, ["stash", "push", "--include-untracked", "-m", "preexisting-user-stash"]);
		await fs.writeFile(path.join(repo, "untracked.txt"), "local untracked change\n");

		await expectDirtyDestinationRejected(repo, taskBranch, ["untracked.txt"]);
	});

	it("cherry-picks a task branch onto a clean destination", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-clean";
		await createTaskBranch(repo, baseBranch, taskBranch);

		await registerManagedDestination(repo, baseBranch);
		const result = await mergeTaskBranches(repo, [{ branchName: taskBranch, taskId: "task-1" }]);

		expect(result).toEqual({ failed: [], merged: [taskBranch] });
		expect((await fs.readFile(path.join(repo, "merged.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe(
			"task branch change\n",
		);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("");
		const commonDir = path.resolve(repo, await runGit(repo, ["rev-parse", "--git-common-dir"]));
		expect((await readLaneRecord(commonDir, "task-lane"))?.headSha).toBe(await runGit(repo, ["rev-parse", "HEAD"]));
	});

	it("refuses to mutate a clean destination without managed lane ownership", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-unmanaged";
		await createTaskBranch(repo, baseBranch, taskBranch);
		const before = await captureDestination(repo, ["merged.txt"]);

		const result = await mergeTaskBranches(repo, [{ branchName: taskBranch, taskId: "task-1" }]);

		expect(result).toEqual({
			merged: [],
			failed: [taskBranch],
			conflict: "Managed feature lane ownership is required; refusing to mutate the destination checkout.",
		});
		expect(await captureDestination(repo, ["merged.txt"])).toEqual(before);
	});

	it("refuses task integration while the managed lane has an active lease", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-leased";
		await createTaskBranch(repo, baseBranch, taskBranch);
		const commonDir = await registerManagedDestination(repo, baseBranch);
		const lane = await readLaneRecord(commonDir, "task-lane");
		if (!lane) throw new Error("missing managed lane");
		await writeLaneRecord(commonDir, {
			...lane,
			leaseOwner: "team:other",
			leaseUpdatedAt: new Date().toISOString(),
			leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const before = await captureDestination(repo, ["merged.txt"]);

		const result = await mergeTaskBranches(repo, [{ branchName: taskBranch, taskId: "task-1" }]);

		expect(result).toEqual({
			merged: [],
			failed: [taskBranch],
			conflict: "Managed feature lane ownership is required; refusing to mutate the destination checkout.",
		});
		expect(await captureDestination(repo, ["merged.txt"])).toEqual(before);
	});

	it("aborts a clean-destination cherry-pick conflict and preserves the task branch", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-conflict";
		await createTaskBranch(repo, baseBranch, taskBranch);
		await fs.writeFile(path.join(repo, "merged.txt"), "destination change\n");
		await runGit(repo, ["add", "merged.txt"]);
		await runGit(repo, ["commit", "-m", "destination change"]);

		await registerManagedDestination(repo, baseBranch);
		const result = await mergeTaskBranches(repo, [{ branchName: taskBranch, taskId: "task-1" }]);

		expect(result.merged).toEqual([]);
		expect(result.failed).toEqual([taskBranch]);
		expect(result.conflict).toContain(taskBranch);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("");
		expect(await runGit(repo, ["rev-parse", taskBranch])).not.toBe("");
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
