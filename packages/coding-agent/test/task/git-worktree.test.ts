import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	parseLaunchWorktreeMode,
	planLaunchWorktree,
	prepareLaunchWorktree,
} from "@gajae-code/coding-agent/gjc-runtime/launch-worktree";
import { TaskTool } from "@gajae-code/coding-agent/task";
import * as discoveryModule from "@gajae-code/coding-agent/task/discovery";
import * as executorModule from "@gajae-code/coding-agent/task/executor";
import {
	acquireDurableWorktree,
	computeProducedChanges,
	refreshDurableWorktreeHead,
	releaseDurableWorktree,
	resolveWorktreeRequestMode,
} from "@gajae-code/coding-agent/task/git-worktree";
import * as receiptModule from "@gajae-code/coding-agent/task/receipt";
import type { SingleResult, TaskParams } from "@gajae-code/coding-agent/task/types";
import type { ToolSession } from "@gajae-code/coding-agent/tools";

const cleanupRoots: string[] = [];

function run(command: string, args: string[], cwd: string): string {
	const result = Bun.spawnSync([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return result.stdout.toString().trim();
	throw new Error(result.stderr.toString().trim() || `${command} ${args.join(" ")} failed`);
}

async function createRepo(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupRoots.push(root);
	run("git", ["init"], root);
	run("git", ["config", "user.email", "test@example.com"], root);
	run("git", ["config", "user.name", "Test User"], root);
	await Bun.write(path.join(root, "README.md"), "hello\n");
	run("git", ["add", "README.md"], root);
	run("git", ["commit", "-m", "init"], root);
	return root;
}

function bucketOf(repo: string): string {
	return path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
}

const TEST_AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
];

/**
 * Build a real {@link TaskTool} over `repo`, stubbing only the LLM boundary (`runSubprocess`).
 *
 * Everything under test — durable acquisition, cwd routing, result attachment, `producedChanges`,
 * and guard release — is the genuine production control flow in `src/task/index.ts`.
 */
async function createDurableWorktreeTool(
	repo: string,
	onSubprocess: (options: { worktree?: string }) => { exitCode: number },
): Promise<{
	tool: TaskTool;
	calls: Array<{ worktree?: string; cwd: string }>;
	settled: Promise<void>[];
	receipts: SingleResult[];
}> {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: TEST_AGENTS,
		projectAgentsDir: null,
	} as unknown as Awaited<ReturnType<typeof discoveryModule.discoverAgents>>);

	const calls: Array<{ worktree?: string; cwd: string }> = [];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation((async (options: {
		worktree?: string;
		cwd: string;
		id: string;
		index: number;
	}) => {
		calls.push({ worktree: options.worktree, cwd: options.cwd });
		const { exitCode } = onSubprocess(options);
		return {
			index: options.index,
			id: options.id,
			agent: "task",
			agentSource: "bundled",
			task: "t",
			assignment: "a",
			description: "d",
			exitCode,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 1,
		} satisfies Partial<SingleResult> as SingleResult;
	}) as unknown as typeof executorModule.runSubprocess);

	// Observe the public receipt factory without replacing it, so the SingleResult the durable lane
	// actually produced is inspectable. The async dispatch returns before the receipt exists, so this
	// is the only way to assert post-run result fields through real production control flow.
	const receipts: SingleResult[] = [];
	const realBuildTaskReceipt = receiptModule.buildTaskReceipt;
	vi.spyOn(receiptModule, "buildTaskReceipt").mockImplementation((raw: SingleResult) => {
		receipts.push(raw);
		return realBuildTaskReceipt(raw);
	});

	// Background execution is required for the task tool to dispatch at all, so run the registered job
	// inline. The durable lane inside `#executeSync` is still the genuine production control flow.
	const settled: Promise<void>[] = [];
	const manager = {
		register: (
			_type: "bash" | "task",
			label: string,
			run: (ctx: {
				jobId: string;
				signal: AbortSignal;
				reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
			}) => Promise<string>,
			options?: { id?: string },
		): string => {
			const jobId = options?.id ?? label;
			settled.push(
				run({ jobId, signal: new AbortController().signal, reportProgress: async () => {} }).then(
					() => undefined,
					() => undefined,
				),
			);
			return jobId;
		},
		recordSubagentProgress: () => {},
	};
	AsyncJobManager.setInstance(manager as unknown as AsyncJobManager);

	const session = {
		cwd: repo,
		hasUI: false,
		settings: Settings.isolated({ "task.isolation.mode": "none" }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
	return { tool: await TaskTool.create(session), calls, settled, receipts };
}

afterEach(async () => {
	// The harness installs a process-global fake manager; drop it so it cannot leak into later tests.
	AsyncJobManager.resetForTests();
	vi.restoreAllMocks();
	for (const root of cleanupRoots.splice(0)) {
		const bucket = bucketOf(root);
		const listed = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
			cwd: root,
			stdout: "pipe",
			stderr: "ignore",
		});
		for (const line of listed.stdout.toString().split("\n")) {
			if (!line.startsWith("worktree ")) continue;
			const worktreePath = line.slice("worktree ".length).trim();
			if (!worktreePath.startsWith(bucket)) continue;
			Bun.spawnSync(["git", "worktree", "remove", "--force", worktreePath], {
				cwd: root,
				stdout: "ignore",
				stderr: "ignore",
			});
		}
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(bucket, { recursive: true, force: true });
	}
});

describe("durable git-worktree isolation for the task tool", () => {
	it("maps requests onto the exact mode the CLI parser produces", () => {
		expect(resolveWorktreeRequestMode(true)).toEqual(parseLaunchWorktreeMode(["--worktree"]).mode);
		expect(resolveWorktreeRequestMode("feature/demo")).toEqual(
			parseLaunchWorktreeMode(["--worktree", "feature/demo"]).mode,
		);
		// A supplied name must never silently degrade to detached: that would hand back a different
		// worktree identity than the caller asked for.
		expect(() => resolveWorktreeRequestMode("   ")).toThrow(/worktree_invalid_name/);
		expect(() => resolveWorktreeRequestMode("")).toThrow(/worktree_invalid_name/);
		// Only `true` selects detached, and no task id ever leaks into a branch name.
		expect(resolveWorktreeRequestMode(true)).toEqual({ enabled: true, detached: true, name: null });
	});

	it("provisions a worktree identical to the CLI path and then reuses it", async () => {
		const repo = await createRepo("gjc-task-durable-create-");
		await fs.mkdir(path.join(repo, "node_modules"));

		const acquired = await acquireDurableWorktree(repo, true, "T1");
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;

		const cliPlan = planLaunchWorktree(repo, { enabled: true, detached: true, name: null });
		expect(cliPlan.enabled && cliPlan.worktreePath).toBe(acquired.worktreePath);
		expect(acquired.info.identity).toBe("detached");
		expect(acquired.info.branchName).toBeUndefined();
		expect(acquired.info.created).toBe(true);
		expect(acquired.info.reused).toBe(false);
		expect(acquired.info.baseRef).toBe(run("git", ["rev-parse", "HEAD"], repo));
		expect(run("git", ["rev-parse", "HEAD"], acquired.worktreePath)).toBe(acquired.info.baseRef);
		// Same git repository, not a copy.
		const commonDirOf = async (dir: string) =>
			await fs.realpath(path.resolve(dir, run("git", ["rev-parse", "--git-common-dir"], dir)));
		expect(await commonDirOf(acquired.worktreePath)).toBe(await commonDirOf(repo));
		expect((await fs.lstat(path.join(acquired.worktreePath, "node_modules"))).isSymbolicLink()).toBe(true);

		releaseDurableWorktree(acquired.worktreePath);

		const reacquired = await acquireDurableWorktree(repo, true, "T2");
		expect(reacquired.ok).toBe(true);
		if (!reacquired.ok) return;
		expect(reacquired.worktreePath).toBe(acquired.worktreePath);
		expect(reacquired.info.created).toBe(false);
		expect(reacquired.info.reused).toBe(true);
		releaseDurableWorktree(reacquired.worktreePath);
	});

	it("provisions a named worktree on a real branch identical to the CLI path", async () => {
		const repo = await createRepo("gjc-task-durable-named-");

		const acquired = await acquireDurableWorktree(repo, "feature/demo", "T1");
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;

		const cliPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" });
		expect(cliPlan.enabled && cliPlan.worktreePath).toBe(acquired.worktreePath);
		expect(acquired.info.identity).toBe("branch");
		expect(acquired.info.branchName).toBe("feature/demo");
		expect(run("git", ["branch", "--show-current"], acquired.worktreePath)).toBe("feature/demo");
		// A freshly created worktree sits exactly at the planned base.
		expect(acquired.info.headRef).toBe(acquired.info.baseRef);
		expect(acquired.info.headRef).toBe(run("git", ["rev-parse", "HEAD"], acquired.worktreePath));
		releaseDurableWorktree(acquired.worktreePath);
	});

	it("reports the worktree's own HEAD when a reused branch has advanced past the source base", async () => {
		const repo = await createRepo("gjc-task-durable-head-drift-");

		const first = await acquireDurableWorktree(repo, "feature/drift", "T1");
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		releaseDurableWorktree(first.worktreePath);

		// Advance the branch inside the worktree only; the source repo's HEAD does not move.
		await Bun.write(path.join(first.worktreePath, "drifted.txt"), "drifted\n");
		run("git", ["add", "drifted.txt"], first.worktreePath);
		run("git", ["commit", "-m", "advance branch inside worktree"], first.worktreePath);
		const driftedHead = run("git", ["rev-parse", "HEAD"], first.worktreePath);
		const sourceHead = run("git", ["rev-parse", "HEAD"], repo);
		expect(driftedHead).not.toBe(sourceHead);

		const second = await acquireDurableWorktree(repo, "feature/drift", "T2");
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.info.reused).toBe(true);
		// baseRef alone would describe the artifact incorrectly here; headRef is where it actually is.
		expect(second.info.baseRef).toBe(sourceHead);
		expect(second.info.headRef).toBe(driftedHead);
		expect(second.info.headRef).not.toBe(second.info.baseRef);
		releaseDurableWorktree(second.worktreePath);
	});

	it("rejects a dirty reused detached worktree when source HEAD advances", async () => {
		const repo = await createRepo("gjc-task-durable-dirty-detached-");

		const first = await acquireDurableWorktree(repo, true, "T1");
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await Bun.write(path.join(first.worktreePath, "dirty.txt"), "dirty\n");
		releaseDurableWorktree(first.worktreePath);

		await Bun.write(path.join(repo, "next.txt"), "next\n");
		run("git", ["add", "next.txt"], repo);
		run("git", ["commit", "-m", "advance"], repo);

		const second = await acquireDurableWorktree(repo, true, "T2");
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error.code).toBe("worktree_dirty");
		// The message must be actionable, not just a machine prefix.
		expect(second.error.message).toContain("Commit or stash");
	});

	it("reuses a dirty named worktree without rejecting it", async () => {
		const repo = await createRepo("gjc-task-durable-dirty-named-");

		const first = await acquireDurableWorktree(repo, "feature/demo", "T1");
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await Bun.write(path.join(first.worktreePath, "dirty.txt"), "dirty\n");
		releaseDurableWorktree(first.worktreePath);

		await Bun.write(path.join(repo, "next.txt"), "next\n");
		run("git", ["add", "next.txt"], repo);
		run("git", ["commit", "-m", "advance"], repo);

		const second = await acquireDurableWorktree(repo, "feature/demo", "T2");
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.info.reused).toBe(true);
		expect(second.info.dirty).toBe(true);
		releaseDurableWorktree(second.worktreePath);
	});

	it("surfaces a path conflict when the canonical path is an unrelated directory", async () => {
		const repo = await createRepo("gjc-task-durable-path-conflict-");
		const plan = planLaunchWorktree(repo, { enabled: true, detached: true, name: null });
		expect(plan.enabled).toBe(true);
		if (!plan.enabled) return;
		await fs.mkdir(plan.worktreePath, { recursive: true });
		await Bun.write(path.join(plan.worktreePath, "squatter.txt"), "not a worktree\n");

		const acquired = await acquireDurableWorktree(repo, true, "T1");
		expect(acquired.ok).toBe(false);
		if (acquired.ok) return;
		expect(acquired.error.code).toBe("worktree_path_conflict");
		expect(acquired.error.message).toContain("not a registered worktree");
	});

	it("surfaces the multi-line worktree_target_mismatch through the task-side API", async () => {
		const repo = await createRepo("gjc-task-durable-target-mismatch-");

		// Provision the deterministic detached worktree, then move it onto a branch behind our back so
		// the next bare request finds the canonical path registered for a different target.
		const first = await acquireDurableWorktree(repo, true, "T1");
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		releaseDurableWorktree(first.worktreePath);
		run("git", ["checkout", "-b", "other-agent-work"], first.worktreePath);

		const second = await acquireDurableWorktree(repo, true, "T2");
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error.code).toBe("worktree_target_mismatch");
		// The launch runtime's own multi-line remediation must survive intact and not be duplicated.
		expect(second.error.message.startsWith("worktree_target_mismatch:")).toBe(true);
		expect(second.error.message).toContain("other-agent-work");
		expect(second.error.message).toContain("Refusing to");
		expect(second.error.message.split("Refusing to").length - 1).toBe(1);

		// And the guard is not wedged by the typed failure.
		run("git", ["checkout", "--detach"], first.worktreePath);
		const third = await acquireDurableWorktree(repo, true, "T3");
		expect(third.ok).toBe(true);
		if (third.ok) releaseDurableWorktree(third.worktreePath);
	});

	it("releases the guard when baseline capture fails after provisioning", async () => {
		const repo = await createRepo("gjc-task-durable-baseline-failure-");

		// Genuinely force the failure: a post-checkout hook deletes the worktree the moment
		// `git worktree add` finishes, so `captureBaseline` runs against a missing directory and throws
		// from inside `acquireDurableWorktree`, after the guard has already been taken.
		const hooksDir = path.join(repo, ".git", "hooks");
		await fs.mkdir(hooksDir, { recursive: true });
		const hook = path.join(hooksDir, "post-checkout");
		const plan = planLaunchWorktree(repo, { enabled: true, detached: true, name: null });
		expect(plan.enabled).toBe(true);
		if (!plan.enabled) return;
		await Bun.write(hook, `#!/bin/sh\nrm -rf "${plan.worktreePath}"\n`);
		await fs.chmod(hook, 0o755);

		await expect(acquireDurableWorktree(repo, true, "T1")).rejects.toThrow();

		// Guard must not be wedged: with the hook gone, the same canonical path is acquirable again.
		await fs.rm(hook, { force: true });
		await fs.rm(plan.worktreePath, { recursive: true, force: true });
		Bun.spawnSync(["git", "worktree", "prune"], { cwd: repo, stdout: "ignore", stderr: "ignore" });

		const recovered = await acquireDurableWorktree(repo, true, "T2");
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) {
			expect(recovered.error.code).not.toBe("worktree_busy");
			return;
		}
		expect(recovered.worktreePath).toBe(plan.worktreePath);
		releaseDurableWorktree(recovered.worktreePath);
	});

	it("surfaces branch_in_use when the branch is checked out at another path", async () => {
		const repo = await createRepo("gjc-task-durable-branch-in-use-");
		const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-durable-elsewhere-"));
		cleanupRoots.push(elsewhere);
		const occupied = path.join(elsewhere, "occupied");
		run("git", ["worktree", "add", "-b", "feature/demo", occupied], repo);

		const acquired = await acquireDurableWorktree(repo, "feature/demo", "T1");
		expect(acquired.ok).toBe(false);
		if (acquired.ok) return;
		expect(acquired.error.code).toBe("branch_in_use");
		expect(acquired.error.message).toContain("git worktree remove");

		Bun.spawnSync(["git", "worktree", "remove", "--force", occupied], {
			cwd: repo,
			stdout: "ignore",
			stderr: "ignore",
		});
	});

	it("returns worktree_busy for a concurrent same-process request and recovers after release", async () => {
		const repo = await createRepo("gjc-task-durable-busy-");

		const held = await acquireDurableWorktree(repo, true, "T1");
		expect(held.ok).toBe(true);
		if (!held.ok) return;

		const contended = await acquireDurableWorktree(repo, true, "T2");
		expect(contended.ok).toBe(false);
		if (contended.ok) return;
		expect(contended.error.code).toBe("worktree_busy");
		expect(contended.error.message).toContain("T1");

		releaseDurableWorktree(held.worktreePath);

		const afterRelease = await acquireDurableWorktree(repo, true, "T3");
		expect(afterRelease.ok).toBe(true);
		if (!afterRelease.ok) return;
		expect(afterRelease.worktreePath).toBe(held.worktreePath);
		releaseDurableWorktree(afterRelease.worktreePath);
	});

	it("releases the guard when provisioning fails so a later request can succeed", async () => {
		const repo = await createRepo("gjc-task-durable-guard-release-");
		const plan = planLaunchWorktree(repo, { enabled: true, detached: true, name: null });
		expect(plan.enabled).toBe(true);
		if (!plan.enabled) return;

		// Force provisioning to fail by squatting the canonical path.
		await fs.mkdir(plan.worktreePath, { recursive: true });
		const failed = await acquireDurableWorktree(repo, true, "T1");
		expect(failed.ok).toBe(false);
		if (failed.ok) return;
		expect(failed.error.code).toBe("worktree_path_conflict");

		// The guard must not still be held: clearing the squatter lets the next request through.
		await fs.rm(plan.worktreePath, { recursive: true, force: true });
		const recovered = await acquireDurableWorktree(repo, true, "T2");
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) return;
		expect(recovered.info.created).toBe(true);
		releaseDurableWorktree(recovered.worktreePath);
	});

	it("routes the task lane's child session into the provisioned worktree", async () => {
		const repo = await createRepo("gjc-task-durable-lane-success-");
		const { tool, calls, settled } = await createDurableWorktreeTool(repo, () => ({ exitCode: 0 }));

		await tool.execute("tool-durable-success", {
			agent: "task",
			worktree: true,
			tasks: [{ id: "T1", description: "d", assignment: "a" }],
		} as unknown as TaskParams);
		await Promise.all(settled);

		// The child session runs in the provisioned worktree, and that worktree is exactly the one the
		// CLI would resolve for this repo.
		const cliPlan = planLaunchWorktree(repo, { enabled: true, detached: true, name: null });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.worktree).toBe(cliPlan.enabled ? cliPlan.worktreePath : undefined);
		expect(calls[0]?.cwd).toBe(repo);

		// The worktree is a real registered linked worktree and persists after the lane finishes.
		expect(await Bun.file(path.join(calls[0]!.worktree!, ".git")).exists()).toBe(true);
		expect(run("git", ["worktree", "list", "--porcelain"], repo)).toContain(calls[0]!.worktree!);

		// The guard was released, so the canonical path is immediately reusable.
		const reacquired = await acquireDurableWorktree(repo, true, "T2");
		expect(reacquired.ok).toBe(true);
		if (reacquired.ok) releaseDurableWorktree(reacquired.worktreePath);
	});

	it("leaves task-lane work in the worktree without reconciling it into the parent repo", async () => {
		const repo = await createRepo("gjc-task-durable-lane-changes-");
		const { tool, calls, settled } = await createDurableWorktreeTool(repo, options => {
			// Stand in for the subagent: write a file inside the provisioned worktree.
			Bun.spawnSync(["sh", "-c", `printf 'subagent work\n' > "${options.worktree}/out.txt"`]);
			return { exitCode: 0 };
		});

		await tool.execute("tool-durable-changes", {
			agent: "task",
			worktree: true,
			tasks: [{ id: "T1", description: "d", assignment: "a" }],
		} as unknown as TaskParams);
		await Promise.all(settled);

		// The work survives in the worktree, and nothing is merged, patched, or branched into the parent.
		expect(await Bun.file(path.join(calls[0]!.worktree!, "out.txt")).text()).toBe("subagent work\n");
		expect(run("git", ["status", "--porcelain"], repo)).toBe("");
		expect(run("git", ["branch", "--list", "gjc/task/*"], repo)).toBe("");
		// `producedChanges` itself is locked directly against this same delta capture in the
		// computeProducedChanges test above, and on the receipt surface in test/task/receipt.test.ts.
	});

	it("reports the final HEAD after the task lane's subprocess commits inside the worktree", async () => {
		const repo = await createRepo("gjc-task-durable-lane-final-head-");
		const { tool, calls, settled, receipts } = await createDurableWorktreeTool(repo, options => {
			// Stand in for a subagent that commits its work.
			const wt = options.worktree!;
			Bun.spawnSync(["sh", "-c", `printf 'committed work\n' > "${wt}/done.txt"`]);
			run("git", ["add", "done.txt"], wt);
			run("git", ["commit", "-m", "subagent commit"], wt);
			return { exitCode: 0 };
		});

		const sourceHead = run("git", ["rev-parse", "HEAD"], repo);
		await tool.execute("tool-durable-final-head", {
			agent: "task",
			worktree: true,
			tasks: [{ id: "T1", description: "d", assignment: "a" }],
		} as unknown as TaskParams);
		await Promise.all(settled);

		const worktreePath = calls[0]!.worktree!;
		const finalHead = run("git", ["rev-parse", "HEAD"], worktreePath);
		expect(finalHead).not.toBe(sourceHead);

		// The public result must describe where the worktree ended up, not where it was provisioned.
		const raw = receipts.find(r => r.worktree);
		expect(raw?.worktree?.headRef).toBe(finalHead);
		expect(raw?.worktree?.baseRef).toBe(sourceHead);
		expect(raw?.worktree?.headRef).not.toBe(raw?.worktree?.baseRef);
		expect(raw?.producedChanges).toBe(true);

		// And the same value survives onto the sanitized receipt the caller sees.
		const receipt = receiptModule.buildTaskReceipt(raw!);
		expect(receipt.worktree?.headRef).toBe(finalHead);
		expect(receipt.preview).toContain("git worktree");
	});

	it("refreshes a durable worktree's HEAD after a post-provisioning commit", async () => {
		const repo = await createRepo("gjc-task-durable-refresh-head-");

		const acquired = await acquireDurableWorktree(repo, true, "T1");
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;
		const provisionedHead = acquired.info.headRef;
		expect(provisionedHead).toBe(acquired.info.baseRef);

		await Bun.write(path.join(acquired.worktreePath, "later.txt"), "later\n");
		run("git", ["add", "later.txt"], acquired.worktreePath);
		run("git", ["commit", "-m", "commit after provisioning"], acquired.worktreePath);
		const movedHead = run("git", ["rev-parse", "HEAD"], acquired.worktreePath);
		expect(movedHead).not.toBe(provisionedHead);

		const refreshed = refreshDurableWorktreeHead(acquired.info);
		expect(refreshed.headRef).toBe(movedHead);
		expect(refreshed.baseRef).toBe(acquired.info.baseRef);
		// Everything else is carried through untouched.
		expect(refreshed.path).toBe(acquired.info.path);
		expect(refreshed.created).toBe(acquired.info.created);
		releaseDurableWorktree(acquired.worktreePath);
	});

	it("releases the guard when the task lane's subprocess throws after acquisition", async () => {
		const repo = await createRepo("gjc-task-durable-lane-throw-");
		const { tool, settled } = await createDurableWorktreeTool(repo, () => {
			throw new Error("subprocess exploded after acquisition");
		});

		await tool.execute("tool-durable-throw", {
			agent: "task",
			worktree: true,
			tasks: [{ id: "T1", description: "d", assignment: "a" }],
		} as unknown as TaskParams);
		await Promise.all(settled);

		// The canonical path must not be wedged as worktree_busy by the failure.
		const reacquired = await acquireDurableWorktree(repo, true, "T2");
		expect(reacquired.ok).toBe(true);
		if (!reacquired.ok) {
			expect(reacquired.error.code).not.toBe("worktree_busy");
			return;
		}
		releaseDurableWorktree(reacquired.worktreePath);
	});

	it("spawns no subagent when durable acquisition fails in the task lane", async () => {
		const repo = await createRepo("gjc-task-durable-lane-typed-error-");
		const plan = planLaunchWorktree(repo, { enabled: true, detached: true, name: null });
		expect(plan.enabled).toBe(true);
		if (!plan.enabled) return;
		// Squat the canonical path so provisioning fails with worktree_path_conflict.
		await fs.mkdir(plan.worktreePath, { recursive: true });

		const { tool, calls, settled } = await createDurableWorktreeTool(repo, () => ({ exitCode: 0 }));
		await tool.execute("tool-durable-typed-error", {
			agent: "task",
			worktree: true,
			tasks: [{ id: "T1", description: "d", assignment: "a" }],
		} as unknown as TaskParams);
		await Promise.all(settled);

		expect(calls).toHaveLength(0);
		// And the failure did not wedge the path: clearing the squatter lets the next request through.
		await fs.rm(plan.worktreePath, { recursive: true, force: true });
		const recovered = await acquireDurableWorktree(repo, true, "T2");
		expect(recovered.ok).toBe(true);
		if (recovered.ok) releaseDurableWorktree(recovered.worktreePath);
	});

	it("keeps the task lane's repository-binding assertion inside the guard's release scope", async () => {
		// Regression guard for a real leak: when the binding assertion sat between acquisition and the
		// try/finally, a rejection wedged the canonical path as worktree_busy until process restart.
		const source = await Bun.file(new URL("../../src/task/index.ts", import.meta.url)).text();
		const acquireAt = source.indexOf("const acquisition = await acquireDurableWorktree(");
		const tryAt = source.indexOf("try {", acquireAt);
		const assertAt = source.indexOf("await assertExecutionRootMatchesRepositoryBinding(executionRoot", acquireAt);
		const releaseAt = source.indexOf("releaseDurableWorktree(durable.worktreePath)", acquireAt);

		expect(acquireAt).toBeGreaterThan(-1);
		expect(tryAt).toBeGreaterThan(acquireAt);
		expect(assertAt).toBeGreaterThan(tryAt);
		expect(releaseAt).toBeGreaterThan(assertAt);
	});

	it("detects produced changes without applying or publishing a patch", async () => {
		const repo = await createRepo("gjc-task-durable-produced-changes-");

		const acquired = await acquireDurableWorktree(repo, true, "T1");
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;

		expect(await computeProducedChanges(acquired.worktreePath, acquired.baseline)).toBe(false);

		await Bun.write(path.join(acquired.worktreePath, "work.txt"), "subagent output\n");
		expect(await computeProducedChanges(acquired.worktreePath, acquired.baseline)).toBe(true);

		// The change stays in the worktree; the parent repo is untouched.
		expect(run("git", ["status", "--porcelain"], repo)).toBe("");
		expect(await Bun.file(path.join(acquired.worktreePath, "work.txt")).text()).toBe("subagent output\n");
		releaseDurableWorktree(acquired.worktreePath);
	});

	it("keeps the durable worktree on disk after release, like the CLI", async () => {
		const repo = await createRepo("gjc-task-durable-persistence-");

		const acquired = await acquireDurableWorktree(repo, true, "T1");
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;
		releaseDurableWorktree(acquired.worktreePath);

		expect(await Bun.file(path.join(acquired.worktreePath, ".git")).exists()).toBe(true);
		expect(run("git", ["worktree", "list", "--porcelain"], repo)).toContain(acquired.worktreePath);
		// And it is byte-identical to what the CLI would resolve for the same repo.
		const viaCli = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(path.resolve(viaCli.cwd)).toBe(acquired.worktreePath);
		expect(viaCli.worktree.enabled && viaCli.worktree.reused).toBe(true);
	});
});
