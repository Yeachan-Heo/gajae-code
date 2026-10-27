import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@gajae-code/natives";
import * as utils from "@gajae-code/utils";
import { hashPath } from "@gajae-code/utils";
import {
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	ensureIsolation,
	getGitNoIndexNullPath,
	getRepoRoot,
	mergeTaskBranches,
	parseIsolationMode,
	serializeRecoveryPatchBundle,
	verifyNestedPatchesApplied,
	verifyRootPatchesApplied,
} from "../../src/task/worktree";
import * as gitUtils from "../../src/utils/git";

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

	it("retries isoResolve candidates when a backend is path-unavailable", async () => {
		const { repo } = await createGitRepo();
		const wt = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-iso-wt-"));
		tempDirs.push(wt);
		vi.spyOn(utils, "getWorktreesDir").mockReturnValue(wt);
		vi.spyOn(utils, "getWorktreeDir").mockImplementation(segment => path.join(wt, segment));
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

	it("keeps another session's live isolation tree when the same task id is reused", async () => {
		const { repo } = await createGitRepo();
		const repoRoot = await getRepoRoot(repo);
		const id = "0-T1";
		const wt = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-iso-wt-"));
		tempDirs.push(wt);
		vi.spyOn(utils, "getWorktreesDir").mockReturnValue(wt);
		vi.spyOn(utils, "getWorktreeDir").mockImplementation(segment => path.join(wt, segment));
		const canonical = path.join(wt, `${id}-${hashPath(repoRoot)}`);
		const planted = path.join(canonical, "merged", "in-flight-work.ts");
		const created = new Set<string>([canonical]);
		await fs.mkdir(path.dirname(planted), { recursive: true });
		await fs.writeFile(planted, "session A in-flight work\n");
		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		vi.spyOn(natives, "isoIsUnavailableError").mockReturnValue(false);
		const isoStop = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);
		vi.spyOn(natives, "isoStart").mockImplementation(async (_kind, _lower, merged) => {
			const mergedDir = String(merged);
			await fs.mkdir(mergedDir, { recursive: true });
			await fs.writeFile(path.join(mergedDir, "in-flight-work.ts"), "live\n");
		});

		try {
			const handleA = await ensureIsolation(repo, id);
			const handleB = await ensureIsolation(repo, id);
			created.add(path.dirname(handleA.mergedDir));
			created.add(path.dirname(handleB.mergedDir));

			expect(await fs.readFile(planted, "utf8")).toBe("session A in-flight work\n");
			expect(await fs.readFile(path.join(handleA.mergedDir, "in-flight-work.ts"), "utf8")).toBe("live\n");
			expect(await fs.readFile(path.join(handleB.mergedDir, "in-flight-work.ts"), "utf8")).toBe("live\n");
			expect(path.dirname(handleA.mergedDir)).not.toBe(canonical);
			expect(path.dirname(handleB.mergedDir)).not.toBe(canonical);
			expect(handleA.mergedDir).not.toBe(handleB.mergedDir);

			await cleanupIsolation(handleB);
			expect(isoStop).toHaveBeenCalledWith(natives.IsoBackendKind.Rcopy, handleB.mergedDir);
			expect(await fs.readFile(planted, "utf8")).toBe("session A in-flight work\n");
			expect(await fs.readFile(path.join(handleA.mergedDir, "in-flight-work.ts"), "utf8")).toBe("live\n");
			await expect(fs.stat(handleB.mergedDir)).rejects.toMatchObject({ code: "ENOENT" });

			await cleanupIsolation(handleA);
			expect(await fs.readFile(planted, "utf8")).toBe("session A in-flight work\n");
			await expect(fs.stat(handleA.mergedDir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await Promise.all([...created].map(dir => fs.rm(dir, { recursive: true, force: true })));
		}
	});

	it.skipIf(process.platform === "win32")(
		"does not stop or remove an isolation tree that is already a symlink (win32 symlink creation is privileged)",
		async () => {
			const { repo } = await createGitRepo();
			const wt = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-iso-wt-"));
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-iso-outside-"));
			tempDirs.push(wt, outside);
			vi.spyOn(utils, "getWorktreesDir").mockReturnValue(wt);
			vi.spyOn(utils, "getWorktreeDir").mockImplementation(segment => path.join(wt, segment));
			vi.spyOn(natives, "isoResolve").mockReturnValue({
				kind: natives.IsoBackendKind.Rcopy,
				candidates: [natives.IsoBackendKind.Rcopy],
				fellBack: false,
				reason: undefined,
			});
			vi.spyOn(natives, "isoIsUnavailableError").mockReturnValue(false);
			const isoStop = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);
			vi.spyOn(natives, "isoStart").mockImplementation(async (_kind, _lower, merged) => {
				await fs.mkdir(String(merged), { recursive: true });
			});

			const parentHandle = await ensureIsolation(repo, "0-T1");
			const parentBase = path.dirname(parentHandle.mergedDir);
			const outsideMerged = path.join(outside, "merged");
			await fs.mkdir(outsideMerged, { recursive: true });
			await fs.writeFile(path.join(outsideMerged, "secret.txt"), "keep\n");
			await fs.rm(parentBase, { recursive: true, force: true });
			await fs.symlink(outside, parentBase);
			await expect(cleanupIsolation(parentHandle)).rejects.toThrow(/symlinked isolation directory/);
			expect(isoStop).not.toHaveBeenCalled();
			expect(await fs.readFile(path.join(outsideMerged, "secret.txt"), "utf8")).toBe("keep\n");

			const mergedHandle = await ensureIsolation(repo, "0-T2");
			const mergedTarget = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-iso-merged-"));
			tempDirs.push(mergedTarget);
			await fs.writeFile(path.join(mergedTarget, "secret.txt"), "keep\n");
			await fs.rm(mergedHandle.mergedDir, { recursive: true, force: true });
			await fs.symlink(mergedTarget, mergedHandle.mergedDir);
			await expect(cleanupIsolation(mergedHandle)).rejects.toThrow(/symlinked isolation merged directory/);
			expect(isoStop).not.toHaveBeenCalled();
			expect(await fs.readFile(path.join(mergedTarget, "secret.txt"), "utf8")).toBe("keep\n");
			expect((await fs.lstat(path.dirname(mergedHandle.mergedDir))).isSymbolicLink()).toBe(false);
		},
	);

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

	it("verifies the owner worktree exactly matches captured patches", async () => {
		const { repo } = await createGitRepo();
		const baseline = await captureBaseline(repo);
		await fs.writeFile(path.join(repo, "merged.txt"), "child version\n");
		const delta = await captureDeltaPatch(repo, baseline);
		expect(await verifyRootPatchesApplied(repo, baseline, [delta.rootPatch])).toBe(true);

		await fs.writeFile(path.join(repo, "merged.txt"), "owner conflict\n");
		expect(await verifyRootPatchesApplied(repo, baseline, [delta.rootPatch])).toBe(false);
	});

	it("serializes nested-only changes into a durable recovery bundle", () => {
		const bundle = serializeRecoveryPatchBundle({
			rootPatch: "",
			nestedPatches: [{ relativePath: "vendor/nested", patch: "nested patch bytes" }],
		});
		const parsed = JSON.parse(bundle) as {
			version: number;
			rootPatch: string;
			nestedPatches: Array<{ relativePath: string; patch: string }>;
		};
		expect(parsed).toEqual({
			version: 1,
			rootPatch: "",
			nestedPatches: [{ relativePath: "vendor/nested", patch: "nested patch bytes" }],
		});
	});

	it("fails closed when a captured nested repository is unavailable", async () => {
		const { repo } = await createGitRepo();
		await expect(
			applyNestedPatches(repo, [{ relativePath: "missing-nested", patch: "nested patch bytes" }]),
		).rejects.toThrow("Nested repository is unavailable: missing-nested");
	});

	it("fails closed when a baseline nested repository disappears before capture", async () => {
		const { repo } = await createGitRepo();
		const nested = path.join(repo, "nested");
		await fs.mkdir(nested, { recursive: true });
		await runGit(nested, ["init"]);
		await runGit(nested, ["config", "user.email", "nested@example.com"]);
		await runGit(nested, ["config", "user.name", "Nested"]);
		await fs.writeFile(path.join(nested, "nested.txt"), "nested base\n");
		await runGit(nested, ["add", "nested.txt"]);
		await runGit(nested, ["commit", "-m", "nested base"]);
		const baseline = await captureBaseline(repo);
		expect(baseline.nested.some(entry => entry.relativePath === "nested")).toBe(true);

		await fs.writeFile(path.join(repo, "merged.txt"), "root change survives partial capture\n");
		await fs.rm(path.join(nested, ".git"), { recursive: true, force: true });
		const delta = await captureDeltaPatch(repo, baseline);
		expect(delta.rootPatch).toContain("root change survives partial capture");
		expect(delta.captureErrors?.[0]).toBe("Nested repository capture failed (nested): ENOENT");
		const bundle = JSON.parse(serializeRecoveryPatchBundle(delta)) as { captureErrors?: string[] };
		expect(bundle.captureErrors).toEqual(delta.captureErrors);
		expect(JSON.stringify(bundle)).not.toContain(repo);
	});

	it("applies nested task patches without committing pre-existing owner state", async () => {
		const { repo } = await createGitRepo();
		const nested = path.join(repo, "nested-owner-state");
		await fs.mkdir(nested, { recursive: true });
		await runGit(nested, ["init"]);
		await runGit(nested, ["config", "user.email", "nested@example.com"]);
		await runGit(nested, ["config", "user.name", "Nested"]);
		for (const file of ["task.txt", "staged.txt", "unstaged.txt"]) {
			await fs.writeFile(path.join(nested, file), `${file} base\n`);
		}
		await runGit(nested, ["add", "."]);
		await runGit(nested, ["commit", "-m", "nested base"]);

		await fs.writeFile(path.join(nested, "staged.txt"), "owner staged\n");
		await runGit(nested, ["add", "staged.txt"]);
		await fs.writeFile(path.join(nested, "unstaged.txt"), "owner unstaged\n");
		await fs.writeFile(path.join(nested, "untracked.txt"), "owner untracked\n");
		const baseline = await captureBaseline(repo);
		await fs.writeFile(path.join(nested, "task.txt"), "task change\n");
		const taskPatch = `${await runGit(nested, ["diff", "--binary", "--", "task.txt"])}\n`;
		await runGit(nested, ["checkout", "--", "task.txt"]);
		const headBefore = await runGit(nested, ["rev-parse", "HEAD"]);

		await applyNestedPatches(repo, [{ relativePath: "nested-owner-state", patch: taskPatch }]);
		expect(
			await verifyNestedPatchesApplied(repo, baseline, [{ relativePath: "nested-owner-state", patch: taskPatch }]),
		).toBe(true);

		expect(await runGit(nested, ["rev-parse", "HEAD"])).toBe(headBefore);
		const status = await runGit(nested, ["status", "--porcelain=v1"]);
		expect(status).toContain("M  staged.txt");
		expect(status).toContain(" M task.txt");
		expect(status).toContain(" M unstaged.txt");
		expect(status).toContain("?? untracked.txt");
	});

	it("rolls back earlier nested repositories when a later apply fails", async () => {
		const { repo } = await createGitRepo();
		const nestedDirs = [path.join(repo, "nested-a"), path.join(repo, "nested-b")];
		const patches: Array<{ relativePath: string; patch: string }> = [];
		for (const [index, nested] of nestedDirs.entries()) {
			await fs.mkdir(nested, { recursive: true });
			await runGit(nested, ["init"]);
			await runGit(nested, ["config", "user.email", "nested@example.com"]);
			await runGit(nested, ["config", "user.name", "Nested"]);
			await fs.writeFile(path.join(nested, "value.txt"), `base-${index}\n`);
			await runGit(nested, ["add", "value.txt"]);
			await runGit(nested, ["commit", "-m", "base"]);
			await fs.writeFile(path.join(nested, "value.txt"), `task-${index}\n`);
			patches.push({
				relativePath: path.basename(nested),
				patch: `${await runGit(nested, ["diff", "--binary", "--", "value.txt"])}\n`,
			});
			await runGit(nested, ["checkout", "--", "value.txt"]);
		}
		const realApply = gitUtils.patch.applyText.bind(gitUtils.patch);
		vi.spyOn(gitUtils.patch, "applyText").mockImplementation(async (cwd, patch, options = {}) => {
			if (!options.reverse && cwd === nestedDirs[1]) throw new Error("simulated later apply failure");
			await realApply(cwd, patch, options);
		});

		await expect(applyNestedPatches(repo, patches)).rejects.toThrow("earlier nested patches were rolled back");
		expect(await fs.readFile(path.join(nestedDirs[0]!, "value.txt"), "utf8")).toBe("base-0\n");
		expect(await fs.readFile(path.join(nestedDirs[1]!, "value.txt"), "utf8")).toBe("base-1\n");
	});
});
