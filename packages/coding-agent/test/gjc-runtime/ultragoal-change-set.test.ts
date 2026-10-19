import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__setRepositoryStateWitnessTestHookForTests,
	computeCheckpointChangeSet,
	computeUltragoalReviewSourceHash,
	GIT_EMPTY_TREE_SHA,
	mergeChangeSetPaths,
	parseGitNameStatus,
	parseGitUntrackedPaths,
	resolveGitBase,
	spawnText,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-change-set";

async function fixtureGit(root: string, ...args: string[]): Promise<string> {
	const result = await spawnText(
		["git", "-c", "user.name=GJC Test", "-c", "user.email=test@example.invalid", ...args],
		{ cwd: root },
	);
	if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

async function commitFixtureFile(root: string, name: string): Promise<string> {
	await Bun.write(path.join(root, name), `${name}\n`);
	await fixtureGit(root, "add", name);
	await fixtureGit(root, "commit", "-m", name);
	return fixtureGit(root, "rev-parse", "HEAD");
}

async function withIntegrationFixture(run: (root: string, baseline: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-integration-base-"));
	try {
		await fixtureGit(root, "init", "--initial-branch=develop");
		const baseline = await commitFixtureFile(root, "baseline.txt");
		await run(root, baseline);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function expectIntegrationBase(root: string, ref: string, base: string): Promise<void> {
	expect(await fixtureGit(root, "rev-parse", "HEAD")).not.toBe(base);
	expect(await resolveGitBase(root)).toBe(ref);
	expect(await fixtureGit(root, "merge-base", "HEAD", ref)).toBe(base);
	expect(await fixtureGit(root, "diff", "--name-only", `${ref}...HEAD`)).toBe("feature.txt");
}

describe("ultragoal Git integration base resolution", () => {
	it.each([
		"develop",
		"dev",
		"main",
		"master",
	])("excludes checked-out local %s and captures committed changes beyond a distinct ancestor", async branch => {
		await withIntegrationFixture(async (root, baseline) => {
			await fixtureGit(root, "branch", "-m", branch);
			const integration = branch === "main" ? "dev" : "main";
			await fixtureGit(root, "branch", integration);
			await commitFixtureFile(root, "feature.txt");
			await expectIntegrationBase(root, integration, baseline);

			const changeSet = await computeCheckpointChangeSet(root);
			expect(changeSet?.baseRef).toBe(integration);
			expect(changeSet?.mergeBase).toBe(baseline);
			expect(changeSet?.paths).toEqual([
				{ path: "feature.txt", oldPath: undefined, status: "added", category: "other" },
			]);
			expect(changeSet?.captureIncomplete).toBe(false);
			expect(changeSet?.rawDiff).toContain("+feature.txt");
			expect(computeUltragoalReviewSourceHash(changeSet)).toMatch(/^sha256:[0-9a-f]{64}$/);
		});
	});

	it("falls back to the checked-out branch when it is the only integration ref", async () => {
		await withIntegrationFixture(async (root, baseline) => {
			await Bun.write(path.join(root, "feature.txt"), "feature.txt\n");
			expect(await resolveGitBase(root)).toBe("develop");
			const changeSet = await computeCheckpointChangeSet(root);
			expect(changeSet?.baseRef).toBe("develop");
			// On-trunk work has no committed range beyond the base: the change set is
			// exactly the working-tree diff.
			expect(changeSet?.mergeBase).toBe(baseline);
			expect(changeSet?.paths).toEqual([{ path: "feature.txt", status: "added", category: "other" }]);
			expect(changeSet?.captureIncomplete).toBe(false);
			expect(computeUltragoalReviewSourceHash(changeSet)).toMatch(/^sha256:[0-9a-f]{64}$/);
		});
	});

	it("retains distinct origin/develop when local develop is checked out", async () => {
		await withIntegrationFixture(async (root, baseline) => {
			await fixtureGit(root, "update-ref", "refs/remotes/origin/develop", baseline);
			await commitFixtureFile(root, "feature.txt");
			await expectIntegrationBase(root, "origin/develop", baseline);
		});
	});

	it("retains a distinct local integration ref at HEAD", async () => {
		await withIntegrationFixture(async root => {
			await commitFixtureFile(root, "feature.txt");
			await fixtureGit(root, "branch", "dev");
			expect(await resolveGitBase(root)).toBe("dev");
		});
	});

	it("preserves explicit overrides naming the checked-out branch", async () => {
		await withIntegrationFixture(async root => {
			await commitFixtureFile(root, "feature.txt");
			expect(await resolveGitBase(root, "develop")).toBe("develop");
			expect(await resolveGitBase(root, "refs/heads/develop")).toBe("refs/heads/develop");
		});
	});

	it("retains local integration candidates with detached HEAD", async () => {
		await withIntegrationFixture(async (root, baseline) => {
			await fixtureGit(root, "checkout", "--detach");
			await commitFixtureFile(root, "feature.txt");
			await expectIntegrationBase(root, "develop", baseline);
		});
	});

	it("resolves local develop-only history and authenticates the checkpoint source hash", async () => {
		await withIntegrationFixture(async (root, baseline) => {
			await fixtureGit(root, "checkout", "-b", "feature");
			await commitFixtureFile(root, "feature.txt");
			await expectIntegrationBase(root, "develop", baseline);

			const changeSet = await computeCheckpointChangeSet(root);
			expect(changeSet?.baseRef).toBe("develop");
			expect(changeSet?.mergeBase).toBe(baseline);
			expect(changeSet?.paths).toEqual([
				{ path: "feature.txt", oldPath: undefined, status: "added", category: "other" },
			]);
			expect(changeSet?.captureIncomplete).toBe(false);
			expect(changeSet?.rawDiff).toContain("+feature.txt");
			expect(computeUltragoalReviewSourceHash(changeSet)).toMatch(/^sha256:[0-9a-f]{64}$/);
		});
	});

	it("resolves remote-only origin/develop history without a local develop branch", async () => {
		await withIntegrationFixture(async (root, baseline) => {
			await fixtureGit(root, "update-ref", "refs/remotes/origin/develop", baseline);
			await fixtureGit(root, "checkout", "-b", "feature");
			await fixtureGit(root, "branch", "-D", "develop");
			await commitFixtureFile(root, "feature.txt");
			await expectIntegrationBase(root, "origin/develop", baseline);
		});
	});

	it("selects develop when its merge-base is nearer than main and dev", async () => {
		await withIntegrationFixture(async root => {
			await fixtureGit(root, "branch", "main");
			await fixtureGit(root, "branch", "dev");
			const base = await commitFixtureFile(root, "integration.txt");
			await fixtureGit(root, "checkout", "-b", "feature");
			await commitFixtureFile(root, "feature.txt");
			await expectIntegrationBase(root, "develop", base);
		});
	});

	it("selects dev when its merge-base is nearer than develop", async () => {
		await withIntegrationFixture(async root => {
			await fixtureGit(root, "branch", "main");
			await fixtureGit(root, "checkout", "-b", "dev");
			const base = await commitFixtureFile(root, "integration.txt");
			await fixtureGit(root, "checkout", "-b", "feature");
			await commitFixtureFile(root, "feature.txt");
			await expectIntegrationBase(root, "dev", base);
		});
	});

	it("preserves origin/dev precedence when existing candidates have equal merge-bases", async () => {
		await withIntegrationFixture(async (root, baseline) => {
			for (const ref of ["dev", "main", "master"]) await fixtureGit(root, "branch", ref);
			for (const ref of ["dev", "main", "master"]) {
				await fixtureGit(root, "update-ref", `refs/remotes/origin/${ref}`, baseline);
			}
			await fixtureGit(root, "checkout", "-b", "feature");
			await fixtureGit(root, "branch", "-D", "develop");
			await commitFixtureFile(root, "feature.txt");
			await expectIntegrationBase(root, "origin/dev", baseline);
		});
	});

	it("refuses default resolution on an unknown integration branch with valid HEAD", async () => {
		await withIntegrationFixture(async (root, baseline) => {
			await fixtureGit(root, "branch", "-m", "integration");
			await fixtureGit(root, "checkout", "-b", "feature");
			const head = await commitFixtureFile(root, "feature.txt");
			expect(head).not.toBe(baseline);
			expect(await fixtureGit(root, "rev-parse", "--verify", "HEAD")).toBe(head);
			await expect(resolveGitBase(root)).rejects.toThrow("unable to resolve an authoritative integration base");
		});
	});

	it("refuses an explicit nonexistent branch instead of falling back to an integration candidate", async () => {
		await withIntegrationFixture(async root => {
			await fixtureGit(root, "branch", "dev");
			await fixtureGit(root, "checkout", "-b", "feature");
			await commitFixtureFile(root, "feature.txt");
			await expect(resolveGitBase(root, "missing-integration")).rejects.toThrow(
				"unable to resolve an authoritative integration base",
			);
		});
	});
});

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

	it("uses the empty tree as the authoritative base for an unborn repository", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-unborn-change-set-"));
		try {
			expect(await Bun.spawn(["git", "init"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
			await Bun.write(path.join(root, "feature.ts"), "export const unborn = true;\n");
			const changeSet = await computeCheckpointChangeSet(root);
			expect(changeSet?.baseRef).toBe(GIT_EMPTY_TREE_SHA);
			expect(changeSet?.mergeBase).toBeUndefined();
			expect(changeSet?.paths).toContainEqual({ path: "feature.ts", status: "added", category: "other" });
			expect(changeSet?.untrackedContentHash).toMatch(/^sha256:/);
			expect(changeSet?.captureIncomplete ?? true).toBe(false);
			expect(computeUltragoalReviewSourceHash(changeSet)).toMatch(/^sha256:/);
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
