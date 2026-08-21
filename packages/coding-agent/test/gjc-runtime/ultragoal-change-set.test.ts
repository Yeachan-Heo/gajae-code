import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__setRepositoryStateWitnessTestHookForTests,
	computeCheckpointChangeSet,
	computeUltragoalReviewSourceHash,
	mergeChangeSetPaths,
	parseGitNameStatus,
	parseGitUntrackedPaths,
	spawnText,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-change-set";

describe("ultragoal change-set extraction", () => {
	it("keeps authoritative Git status when CI path metadata only knows the pathname", () => {
		expect(
			mergeChangeSetPaths([
				[{ path: "packages/utils/src/helper.ts", status: "modified" }],
				[{ path: "packages/utils/src/helper.ts", status: "unknown" }],
			]),
		).toEqual([{ path: "packages/utils/src/helper.ts", status: "modified" }]);
		expect(
			mergeChangeSetPaths([
				[{ path: "packages\\utils\\src\\helper.ts", status: "unknown" }],
				[{ path: "packages/utils/src/helper.ts", status: "modified" }],
			]),
		).toEqual([{ path: "packages/utils/src/helper.ts", status: "modified" }]);
	});

	it("ignores outer-workspace CI paths for an independent repo but binds canonical workspace evidence", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-ci-workspace-"));
		const root = await fs.mkdtemp(path.join(workspace, "nested-independent-"));
		const savedWorkspace = process.env.GITHUB_WORKSPACE;
		const savedChangedPaths = process.env.CI_DEV_CHANGED_PATHS;
		try {
			expect(await Bun.spawn(["git", "init"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
			await Bun.write(path.join(root, "tracked.txt"), "baseline\n");
			expect(
				await Bun.spawn(["git", "add", "tracked.txt"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
			).toBe(0);
			expect(
				await Bun.spawn(
					["git", "-c", "user.name=GJC Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"],
					{ cwd: root, stdout: "ignore", stderr: "ignore" },
				).exited,
			).toBe(0);
			expect(
				await Bun.spawn(["git", "branch", "dev"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
			).toBe(0);
			await Bun.write(path.join(root, "tracked.txt"), "changed\n");
			process.env.GITHUB_WORKSPACE = workspace;
			process.env.CI_DEV_CHANGED_PATHS = "outer-only.ts";
			const independent = await computeCheckpointChangeSet(root);
			expect(independent?.paths.map(row => row.path)).toEqual(["tracked.txt"]);
			expect(computeUltragoalReviewSourceHash(independent)).toMatch(/^sha256:[0-9a-f]{64}$/);

			process.env.GITHUB_WORKSPACE = root;
			const canonical = await computeCheckpointChangeSet(root);
			expect(canonical?.paths).toContainEqual({ path: "outer-only.ts", status: "unknown", category: "other" });
			expect(computeUltragoalReviewSourceHash(canonical)).toBeUndefined();
		} finally {
			if (savedWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
			else process.env.GITHUB_WORKSPACE = savedWorkspace;
			if (savedChangedPaths === undefined) delete process.env.CI_DEV_CHANGED_PATHS;
			else process.env.CI_DEV_CHANGED_PATHS = savedChangedPaths;
			await Promise.all([
				fs.rm(workspace, { recursive: true, force: true }),
				fs.rm(root, { recursive: true, force: true }),
			]);
		}
	});

	it("preserves rename paths and categories", () => {
		expect(parseGitNameStatus("R100\told.ts\tpackages/coding-agent/src/tools/computer.ts\n")).toEqual([
			{
				path: "packages/coding-agent/src/tools/computer.ts",
				oldPath: "old.ts",
				status: "renamed",
				category: "tool",
			},
		]);
	});

	it("preserves spaces and rename boundaries from NUL-delimited Git output", () => {
		expect(
			parseGitNameStatus(
				"M\0docs/file with spaces.md\0R100\0old dir/old name.ts\0packages/coding-agent/src/new name.ts\0",
			),
		).toEqual([
			{
				path: "docs/file with spaces.md",
				oldPath: undefined,
				status: "modified",
				category: "other",
			},
			{
				path: "packages/coding-agent/src/new name.ts",
				oldPath: "old dir/old name.ts",
				status: "renamed",
				category: "other",
			},
		]);
	});

	it("preserves spaces in legacy tab-delimited input", () => {
		expect(parseGitNameStatus("M\tdocs/file with spaces.md\n")).toEqual([
			{
				path: "docs/file with spaces.md",
				oldPath: undefined,
				status: "modified",
				category: "other",
			},
		]);
	});

	it("classifies NUL-delimited untracked paths as added without truncating spaces", () => {
		expect(parseGitUntrackedPaths("new dir/untracked file.ts\0")).toEqual([
			{
				path: "new dir/untracked file.ts",
				status: "added",
				category: "other",
			},
		]);
	});

	it("preserves leading, trailing, and embedded newline bytes in NUL-delimited paths", () => {
		const pathValue = " leading and trailing\nname.ts ";
		expect(parseGitUntrackedPaths(`${pathValue}\0`)).toEqual([
			{
				path: pathValue,
				status: "added",
				category: "other",
			},
		]);
	});

	it("keeps literal POSIX backslash pairs distinct from slash paths", () => {
		const backslashPath = "dir\\\\name.ts";
		expect(parseGitUntrackedPaths(`${backslashPath}\0dir/name.ts\0`).map(row => row.path)).toEqual([
			backslashPath,
			"dir/name.ts",
		]);
	});

	it("fails command capture closed when stdout is not valid UTF-8", async () => {
		const result = await spawnText([process.execPath, "-e", "process.stdout.write(Buffer.from([0xff]))"], {
			cwd: process.cwd(),
		});
		expect(result.ok).toBe(false);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("not valid UTF-8");
	});

	it("preserves a leading UTF-8 BOM as part of the first pathname", async () => {
		const result = await spawnText(
			[
				process.execPath,
				"-e",
				"process.stdout.write(Buffer.from([0xef,0xbb,0xbf,0x6e,0x61,0x6d,0x65,0x2e,0x74,0x73,0x00]))",
			],
			{ cwd: process.cwd() },
		);
		expect(result.ok).toBe(true);
		expect(parseGitUntrackedPaths(result.stdout)[0]?.path).toBe("\uFEFFname.ts");
	});

	it("includes untracked files in the computed cumulative change set", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-untracked-change-set-"));
		try {
			expect(await Bun.spawn(["git", "init"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
			await Bun.write(path.join(root, "tracked.txt"), "baseline\n");
			expect(
				await Bun.spawn(["git", "add", "tracked.txt"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
			).toBe(0);
			expect(
				await Bun.spawn(
					["git", "-c", "user.name=GJC Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"],
					{ cwd: root, stdout: "ignore", stderr: "ignore" },
				).exited,
			).toBe(0);
			expect(
				await Bun.spawn(["git", "branch", "dev"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
			).toBe(0);
			await Bun.write(path.join(root, "new file.ts"), "export const untracked = true;\n");
			const changeSet = await computeCheckpointChangeSet(root);
			expect(changeSet?.paths).toContainEqual({
				path: "new file.ts",
				status: "added",
				category: "other",
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("authenticates a committed file addition in the cumulative change set", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-tracked-addition-"));
		try {
			expect(await Bun.spawn(["git", "init"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
			await Bun.write(path.join(root, "README.md"), "baseline\n");
			expect(
				await Bun.spawn(["git", "add", "README.md"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
			).toBe(0);
			expect(
				await Bun.spawn(
					["git", "-c", "user.name=GJC Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"],
					{ cwd: root, stdout: "ignore", stderr: "ignore" },
				).exited,
			).toBe(0);
			expect(
				await Bun.spawn(["git", "branch", "dev"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
			).toBe(0);
			expect(
				await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: root, stdout: "ignore", stderr: "ignore" })
					.exited,
			).toBe(0);
			await Bun.write(path.join(root, "added.ts"), "export const added = true;\n");
			expect(
				await Bun.spawn(["git", "add", "added.ts"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
			).toBe(0);
			expect(
				await Bun.spawn(
					["git", "-c", "user.name=GJC Test", "-c", "user.email=test@example.invalid", "commit", "-m", "addition"],
					{ cwd: root, stdout: "ignore", stderr: "ignore" },
				).exited,
			).toBe(0);
			const changeSet = await computeCheckpointChangeSet(root);
			expect(changeSet?.paths).toContainEqual({ path: "added.ts", status: "added", category: "other" });
			expect(computeUltragoalReviewSourceHash(changeSet)).toMatch(/^sha256:[0-9a-f]{64}$/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed on a concurrent same-status content mutation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-witness-race-"));
		try {
			expect(await Bun.spawn(["git", "init"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
			await Bun.write(path.join(root, "tracked.txt"), "baseline\n");
			expect(
				await Bun.spawn(["git", "add", "tracked.txt"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
			).toBe(0);
			expect(
				await Bun.spawn(
					["git", "-c", "user.name=GJC Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"],
					{ cwd: root, stdout: "ignore", stderr: "ignore" },
				).exited,
			).toBe(0);
			expect(
				await Bun.spawn(["git", "branch", "dev"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
			).toBe(0);
			await Bun.write(path.join(root, "tracked.txt"), "reviewed\n");
			__setRepositoryStateWitnessTestHookForTests(async (_phase, cwd) => {
				await Bun.write(path.join(cwd, "tracked.txt"), "raced\n");
			});
			const changeSet = await computeCheckpointChangeSet(root);
			expect(changeSet?.captureIncomplete).toBe(true);
			expect(computeUltragoalReviewSourceHash(changeSet)).toBeUndefined();
		} finally {
			__setRepositoryStateWitnessTestHookForTests(undefined);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects trusted added paths without a verified untracked content hash", () => {
		expect(
			computeUltragoalReviewSourceHash({
				source: "checkpoint-git",
				paths: [{ path: "new.ts", status: "added" }],
				rawDiff: "diff --git a/new.ts b/new.ts\n",
				trusted: true,
			}),
		).toBeUndefined();
	});

	it("canonicalizes source-hash path ordering", () => {
		const base = {
			source: "review-worktree" as const,
			rawDiff: "diff --git a/a.ts b/a.ts\n",
			trusted: true as const,
		};
		const first = computeUltragoalReviewSourceHash({
			...base,
			paths: [
				{ path: "b.ts", status: "modified" },
				{ path: "a.ts", status: "modified" },
			],
		});
		const second = computeUltragoalReviewSourceHash({
			...base,
			paths: [
				{ path: "a.ts", status: "modified" },
				{ path: "b.ts", status: "modified" },
			],
		});
		expect(second).toBe(first);
	});
});
