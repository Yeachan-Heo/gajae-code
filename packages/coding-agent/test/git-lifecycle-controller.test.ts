import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeLaneRecord } from "@gajae-code/coding-agent/gjc-runtime/git-lifecycle";
import {
	type CommandRunner,
	type GithubAdapter,
	GitLifecycleController,
	type ManagedLaneRecord,
} from "@gajae-code/coding-agent/gjc-runtime/git-lifecycle-controller";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function disposable(): Promise<{ cwd: string; runner: CommandRunner }> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lane-"));
	directories.push(cwd);
	await fs.mkdir(path.join(cwd, ".git"));
	return {
		cwd,
		runner: async argv =>
			argv.slice(1).join(" ") === "rev-parse --git-common-dir"
				? { exitCode: 0, stdout: ".git\n", stderr: "" }
				: { exitCode: 0, stdout: "", stderr: "" },
	};
}

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

describe("git lifecycle controller", () => {
	it("persists only supported policy modes with a default retention in the disposable common git dir", async () => {
		const { cwd, runner } = await disposable();
		const controller = new GitLifecycleController({ cwd, runner });
		const policy = await controller.configure({
			mode: "pr-only",
			remote: "origin",
			base: "main",
			worktreeRoot: "D:/worktrees",
			allowedAutoMergeTypes: ["fix"],
			requiredGates: [],
			forbiddenPathPatterns: [],
		});
		expect(policy.retentionHours).toBe(24);
		expect(await fs.stat(path.join(cwd, ".git", "gjc", "lifecycle", "v1", "policy.json"))).toBeDefined();
	});
	it("rejects a worktree root nested within the repository checkout", async () => {
		const { cwd, runner: baseRunner } = await disposable();
		const runner: CommandRunner = async argv => {
			const command = argv.slice(1).join(" ");
			if (command === "rev-parse --show-toplevel") return { exitCode: 0, stdout: `${cwd}\n`, stderr: "" };
			if (command === "worktree list --porcelain")
				return { exitCode: 0, stdout: `worktree ${cwd}\nHEAD head\nbranch refs/heads/main\n`, stderr: "" };
			return baseRunner(argv, cwd);
		};
		const controller = new GitLifecycleController({ cwd, runner });
		await expect(
			controller.configure({
				mode: "pr-only",
				remote: "origin",
				base: "main",
				worktreeRoot: path.join(cwd, "nested"),
				allowedAutoMergeTypes: [],
				requiredGates: [],
				forbiddenPathPatterns: [],
			}),
		).rejects.toThrow("external to every repository worktree");
	});
	it("rejects policy modes outside the two supported choices", async () => {
		const { cwd, runner } = await disposable();
		const controller = new GitLifecycleController({ cwd, runner });
		expect(
			controller.configure({
				mode: "auto" as "pr-only",
				remote: "origin",
				base: "main",
				worktreeRoot: "D:/worktrees",
				allowedAutoMergeTypes: [],
				requiredGates: [],
				forbiddenPathPatterns: [],
			}),
		).rejects.toThrow("policy mode");
	});
	it("rejects empty required checks for local controlled merge", async () => {
		const { cwd, runner } = await disposable();
		const controller = new GitLifecycleController({ cwd, runner });
		expect(
			controller.configure({
				mode: "local-controlled-merge",
				remote: "origin",
				base: "main",
				worktreeRoot: "D:/worktrees",
				allowedAutoMergeTypes: ["fix"],
				requiredGates: [],
				forbiddenPathPatterns: [],
			}),
		).rejects.toThrow("requires at least one required gate");
	});
	it("keeps a blocked planned record when worktree creation fails", async () => {
		const { cwd } = await disposable();
		const runner: CommandRunner = async argv => {
			const command = argv.slice(1).join(" ");
			const stdout: Record<string, string> = {
				"rev-parse --git-common-dir": ".git\n",
				"rev-parse origin/main": "base\n",
				"branch --format=%(refname:short)": "",
				"worktree list --porcelain": "",
				"rev-parse --show-toplevel": cwd,
				"config --get remote.origin.url": "origin-url\n",
			};
			if (command.startsWith("worktree add ")) return { exitCode: 1, stdout: "", stderr: "simulated add failure" };
			return { exitCode: 0, stdout: stdout[command] ?? "", stderr: "" };
		};
		const controller = new GitLifecycleController({ cwd, runner });
		await controller.configure({
			mode: "pr-only",
			remote: "origin",
			base: "main",
			worktreeRoot: path.dirname(cwd),
			allowedAutoMergeTypes: [],
			requiredGates: [],
			forbiddenPathPatterns: [],
		});
		expect(
			controller.start({
				laneId: "lane-1",
				type: "fix",
				scope: "scope",
				purpose: "purpose",
				agent: "gjc",
				sessionId: "session",
			}),
		).rejects.toThrow("simulated add failure");
		expect(await controller.status("lane-1")).toMatchObject({
			record: { state: "blocked", branch: "fix/scope-purpose--gjc-lane-1" },
		});
	});
	it("creates and pushes an isolated typed lane without mutating the source checkout", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lane-e2e-"));
		directories.push(root);
		const remote = path.join(root, "origin.git");
		const source = path.join(root, "source");
		await fs.mkdir(source);
		git(root, ["init", "--bare", remote]);
		git(source, ["init", "-b", "main"]);
		git(source, ["config", "user.email", "gjc@example.test"]);
		git(source, ["config", "user.name", "GJC Test"]);
		await fs.writeFile(path.join(source, "README.md"), "# test\n");
		git(source, ["add", "README.md"]);
		git(source, ["commit", "-m", "initial"]);
		git(source, ["remote", "add", "origin", remote]);
		git(source, ["push", "-u", "origin", "main"]);

		let lane: ManagedLaneRecord | undefined;
		const github: GithubAdapter = {
			findPullRequest: async () => undefined,
			createPullRequest: async (head, base) => {
				if (!lane) throw new Error("lane missing");
				const headRefOid = git(lane.worktreePath, ["rev-parse", "HEAD"]);
				return {
					number: 1,
					state: "OPEN",
					isDraft: false,
					isCrossRepository: false,
					headRefName: head,
					headRefOid,
					baseRefName: base,
					baseRefOid: git(source, ["rev-parse", "origin/main"]),
					mergeable: "MERGEABLE",
				};
			},
			getPullRequest: async () => undefined,
			squashMergePullRequest: async (_number, input) => ({
				method: "SQUASH",
				matchHeadCommit: input.matchHeadCommit,
				expectedBaseCommit: input.expectedBaseCommit,
			}),
		};
		const controller = new GitLifecycleController({ cwd: source, github });
		await controller.configure({
			mode: "pr-only",
			remote: "origin",
			base: "main",
			worktreeRoot: path.join(root, "worktrees"),
			allowedAutoMergeTypes: [],
			requiredGates: [],
			forbiddenPathPatterns: [],
		});
		lane = await controller.start({
			laneId: "e2e-1",
			type: "dev",
			scope: "git",
			purpose: "isolation",
			agent: "gjc",
			sessionId: "session",
		});
		await fs.writeFile(path.join(lane.worktreePath, "feature.txt"), "feature\n");
		git(lane.worktreePath, ["add", "feature.txt"]);
		git(lane.worktreePath, ["commit", "-m", "feat: isolated"]);
		const opened = await controller.pr(lane.laneId);

		expect(opened).toMatchObject({ state: "pr_open", branch: "dev/git-isolation--gjc-e2e-1", prNumber: 1 });
		if (!opened.headSha) throw new Error("opened lane is missing its head SHA");
		expect(git(source, ["status", "--porcelain"])).toBe("");
		expect(git(remote, ["rev-parse", "refs/heads/dev/git-isolation--gjc-e2e-1"])).toBe(opened.headSha);
	});
	it("cleans a squash-merged lane through exact local and remote ref deletion", async () => {
		const { cwd } = await disposable();
		const worktree = path.join(cwd, "lane");
		await fs.mkdir(worktree);
		const worktreeGitDir = path.join(cwd, ".git", "worktrees", "lane");
		await fs.mkdir(worktreeGitDir, { recursive: true });
		await fs.writeFile(path.join(worktreeGitDir, "gjc-lane-owner"), "owner-token");
		const commands: string[] = [];
		let remotePresent = true;
		const runner: CommandRunner = async (argv, commandCwd) => {
			const command = argv.slice(1).join(" ");
			commands.push(command);
			if (command === "rev-parse --git-common-dir")
				return { exitCode: 0, stdout: commandCwd === cwd ? ".git\n" : `${path.join(cwd, ".git")}\n`, stderr: "" };
			if (command === "rev-parse --show-toplevel") return { exitCode: 0, stdout: `${worktree}\n`, stderr: "" };
			if (command === "rev-parse --git-dir") return { exitCode: 0, stdout: `${worktreeGitDir}\n`, stderr: "" };
			if (command === "branch --show-current")
				return { exitCode: 0, stdout: "fix/scope-purpose--gjc-lane-1\n", stderr: "" };
			if (command === "status --porcelain --untracked-files=all") return { exitCode: 0, stdout: "", stderr: "" };
			if (
				command === "rev-parse HEAD" ||
				command === "rev-parse fix/scope-purpose--gjc-lane-1" ||
				command === "rev-parse --verify refs/heads/fix/scope-purpose--gjc-lane-1" ||
				command === "rev-parse refs/heads/fix/scope-purpose--gjc-lane-1"
			)
				return { exitCode: 0, stdout: "head\n", stderr: "" };
			if (command === "rev-parse origin/main") return { exitCode: 0, stdout: "target\n", stderr: "" };
			if (command.startsWith("ls-remote "))
				return {
					exitCode: 0,
					stdout: remotePresent ? "head\trefs/heads/fix/scope-purpose--gjc-lane-1\n" : "",
					stderr: "",
				};
			if (command.startsWith("push --force-with-lease=refs/heads/")) {
				remotePresent = false;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const github: GithubAdapter = {
			findPullRequest: async () => undefined,
			createPullRequest: async () => {
				throw new Error("unused");
			},
			squashMergePullRequest: async (_number, input) => ({
				method: "SQUASH",
				matchHeadCommit: input.matchHeadCommit,
				expectedBaseCommit: input.expectedBaseCommit,
			}),
			getPullRequest: async () => ({
				number: 1,
				state: "MERGED",
				isDraft: false,
				isCrossRepository: false,
				headRefName: "fix/scope-purpose--gjc-lane-1",
				headRefOid: "head",
				baseRefName: "main",
				baseRefOid: "base",
				mergeable: "MERGEABLE",
				mergedAt: "2020-01-01T00:00:00.000Z",
				mergeCommit: "squash",
			}),
		};
		const controller = new GitLifecycleController({
			cwd,
			runner,
			github,
			now: () => new Date("2026-01-01T00:00:00.000Z"),
		});
		await controller.configure({
			mode: "pr-only",
			remote: "origin",
			base: "main",
			worktreeRoot: path.dirname(cwd),
			allowedAutoMergeTypes: [],
			requiredGates: [],
			forbiddenPathPatterns: [],
			retentionHours: 0,
		});
		const record: ManagedLaneRecord = {
			version: 1,
			laneId: "lane-1",
			state: "retention",
			createdAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-01T00:00:00.000Z",
			repositoryId: "repo",
			realm: "windows",
			branch: "fix/scope-purpose--gjc-lane-1",
			worktreeToken: "FIX)scope-purpose__gjc-lane-1",
			worktreePath: worktree,
			agent: "gjc",
			sessionId: "session",
			remote: "origin",
			base: "main",
			headSha: "head",
			prNumber: 1,
			mergeCommit: "squash",
			mergedHeadSha: "head",
			mergedBaseSha: "base",
			gitCommonDir: path.join(cwd, ".git"),
			worktreeGitDir,
			worktreeOwnershipToken: "owner-token",
		};
		await writeLaneRecord(path.join(cwd, ".git"), record);
		expect(await controller.gc("lane-1")).toMatchObject({ state: "cleaned", remoteBranchDeleted: true });
		expect(commands).toContain("update-ref -d refs/heads/fix/scope-purpose--gjc-lane-1 head");
		expect(commands).toContain(
			"push --force-with-lease=refs/heads/fix/scope-purpose--gjc-lane-1:head origin :refs/heads/fix/scope-purpose--gjc-lane-1",
		);
	});
	it("rejects PR mutation while a lane lease is active", async () => {
		const { cwd, runner } = await disposable();
		const controller = new GitLifecycleController({
			cwd,
			runner,
			now: () => new Date("2026-01-01T00:00:00.000Z"),
		});
		await controller.configure({
			mode: "pr-only",
			remote: "origin",
			base: "main",
			worktreeRoot: "D:/worktrees",
			allowedAutoMergeTypes: [],
			requiredGates: [],
			forbiddenPathPatterns: [],
		});
		const leasedRecord: ManagedLaneRecord = {
			version: 1,
			laneId: "leased-lane",
			state: "active",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			repositoryId: "repo",
			realm: "windows",
			branch: "dev/scope-purpose--gjc-leased-lane",
			worktreeToken: "DEV)scope-purpose__gjc-leased-lane",
			worktreePath: path.join(cwd, "lane"),
			agent: "gjc",
			sessionId: "session",
			remote: "origin",
			base: "main",
			leaseOwner: "team:active",
			leaseExpiresAt: "2026-01-01T00:01:00.000Z",
			leaseUpdatedAt: "2025-12-31T23:59:00.000Z",
		};
		await writeLaneRecord(path.join(cwd, ".git"), leasedRecord);

		await expect(controller.pr("leased-lane")).rejects.toThrow("active lease");
	});
	it("rejects policy remote or base drift for an existing lane", async () => {
		const { cwd, runner } = await disposable();
		const controller = new GitLifecycleController({ cwd, runner });
		await controller.configure({
			mode: "pr-only",
			remote: "origin",
			base: "main",
			worktreeRoot: "D:/worktrees",
			allowedAutoMergeTypes: [],
			requiredGates: [],
			forbiddenPathPatterns: [],
		});
		const driftedRecord: ManagedLaneRecord = {
			version: 1,
			laneId: "bound-lane",
			state: "active",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			repositoryId: "repo",
			realm: "windows",
			branch: "dev/scope-purpose--gjc-bound-lane",
			worktreeToken: "DEV)scope-purpose__gjc-bound-lane",
			worktreePath: path.join(cwd, "lane"),
			agent: "gjc",
			sessionId: "session",
			remote: "upstream",
			base: "dev",
		};
		await writeLaneRecord(path.join(cwd, ".git"), driftedRecord);

		await expect(controller.pr("bound-lane")).rejects.toThrow("immutable lane binding");
	});
});
