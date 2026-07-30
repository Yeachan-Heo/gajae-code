import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import * as repositoryBindingModule from "../../src/gjc-runtime/repository-binding";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "../../src/task/types";
import type { IsolationHandle, WorktreeBaseline } from "../../src/task/worktree";
import * as worktreeModule from "../../src/task/worktree";
import type { ToolSession } from "../../src/tools";
import * as git from "../../src/utils/git";

const AGENT: AgentDefinition = {
	name: "executor",
	description: "test executor",
	systemPrompt: "test",
	source: "bundled",
};

const BASELINE: WorktreeBaseline = {
	root: {
		repoRoot: "/repo",
		headCommit: "HEAD",
		staged: "",
		unstaged: "",
		untracked: [],
		untrackedPatch: "",
	},
	nested: [],
};

const ISOLATION: IsolationHandle = {
	mergedDir: "/tmp/isolated-persistence-test",
	backend: worktreeModule.parseIsolationMode("rcopy")!,
	fellBack: false,
	fallbackReason: null,
};

function makeResult(id: string, exitCode: number): SingleResult {
	return {
		index: 0,
		id,
		agent: "executor",
		agentSource: "bundled",
		task: "test assignment",
		assignment: "test assignment",
		description: id,
		exitCode,
		output: exitCode === 0 ? "done" : "failed",
		stderr: exitCode === 0 ? "" : "intentional failure",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		...(exitCode === 0 ? {} : { error: "intentional failure" }),
	};
}

function createSession(merge: "patch" | "branch" = "patch"): ToolSession {
	return {
		cwd: "/repo",
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": true,
			"task.isolation.mode": "auto",
			"task.isolation.merge": merge,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		modelRegistry: {
			authStorage: undefined,
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => null,
		} as unknown as ModelRegistry,
	} as unknown as ToolSession;
}

function mockIsolation(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
	vi.spyOn(worktreeModule, "getRepoRoot").mockResolvedValue("/repo");
	vi.spyOn(worktreeModule, "captureBaseline").mockResolvedValue(BASELINE);
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue(ISOLATION);
	vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
	vi.spyOn(repositoryBindingModule, "resolveTaskRepositoryBinding").mockResolvedValue({
		schema: "gjc.repository_binding.v1",
		worktreeRoot: "/repo",
		commonDir: null,
		displayPath: "/repo",
	});
	vi.spyOn(repositoryBindingModule, "assertExecutionRootMatchesRepositoryBinding").mockResolvedValue({
		schema: "gjc.repository_binding.v1",
		worktreeRoot: "/repo",
		commonDir: null,
		displayPath: "/repo",
	});
}

async function runTask(tool: TaskTool, tasks: TaskParams["tasks"]): Promise<string> {
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.setInstance(manager);
	const started = await tool.execute("tool-call", { agent: "executor", tasks, isolated: true });
	if (!started.details?.async?.jobId) throw new Error("Expected detached task job id");
	await manager.waitForAll();
	const resultText = tasks
		.map((item, index) => {
			const job = manager.getJob(`${index}-${item.id}`);
			return job?.resultText ?? job?.errorText ?? "";
		})
		.join("\n");
	await manager.dispose({ timeoutMs: 100 });
	return resultText;
}

function task(id: string): TaskParams["tasks"][number] {
	return { id, description: id, assignment: "Exercise persistence." };
}

describe("isolated task persistence recovery", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
		InternalUrlRouter.resetForTests();
		vi.restoreAllMocks();
	});

	it("keeps failed branch-mode edits as receipt-bound recovery artifacts", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("BranchFailure", 1));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "branch failure patch",
			nestedPatches: [],
		});
		const mergeBranches = vi.spyOn(worktreeModule, "mergeTaskBranches");

		const resultText = await runTask(await TaskTool.create(createSession("branch")), [task("BranchFailure")]);

		expect(mergeBranches).not.toHaveBeenCalled();
		expect(resultText).toContain("changes were not persisted to the owner worktree");
		expect(resultText).toContain("local://subagents/");
	});

	it("uses a fresh recovery URI for repeated executions of the same task id", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Repeated", 1));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "repeated recovery patch",
			nestedPatches: [],
		});
		const tool = await TaskTool.create(createSession("branch"));

		const first = await runTask(tool, [task("Repeated")]);
		const second = await runTask(tool, [task("Repeated")]);
		const firstUri = first.match(/local:\/\/subagents\/[^\s<]+\.patch/)?.[0];
		const secondUri = second.match(/local:\/\/subagents\/[^\s<]+\.patch/)?.[0];

		expect(firstUri).toBeTruthy();
		expect(secondUri).toBeTruthy();
		expect(secondUri).not.toBe(firstUri);
	});

	it("reports an exit-zero merge failure as a failed async batch", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("AsyncConflict", 0));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "conflicting patch",
			nestedPatches: [],
		});
		vi.spyOn(git.patch, "canApplyText").mockResolvedValue(false);
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		const states: string[] = [];
		const tool = await TaskTool.create(createSession());

		await tool.execute(
			"tool-call",
			{ agent: "executor", tasks: [task("AsyncConflict")], isolated: true },
			undefined,
			update => {
				if (update.details?.async?.state) states.push(update.details.async.state);
			},
		);
		await manager.waitForAll();
		const asyncJob = manager.getJob("0-AsyncConflict");
		expect(asyncJob?.status).toBe("failed");
		await manager.dispose({ timeoutMs: 100 });

		expect(states.at(-1)).toBe("failed");
	});

	it("emits a terminal failed batch when cancellation skips later schedules", async () => {
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("AsyncStarted", 0));
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		const controller = new AbortController();
		const originalRegister = manager.register.bind(manager);
		let firstRegistration = true;
		vi.spyOn(manager, "register").mockImplementation((...args) => {
			const jobId = originalRegister(...args);
			if (firstRegistration) {
				firstRegistration = false;
				controller.abort();
			}
			return jobId;
		});
		const states: string[] = [];
		const tool = await TaskTool.create(createSession());

		await tool.execute(
			"partial-schedule-cancel",
			{ agent: "executor", tasks: [task("AsyncStarted"), task("AsyncSkipped")] },
			controller.signal,
			update => {
				if (update.details?.async?.state) states.push(update.details.async.state);
			},
		);
		await manager.waitForAll();
		await manager.dispose({ timeoutMs: 100 });

		expect(states.at(-1)).toBe("failed");
	});

	it("does not label patch-capture failures as owner-applied no-change", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("CaptureFailure", 0));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockRejectedValue(new Error("nested capture unavailable"));

		const resultText = await runTask(await TaskTool.create(createSession()), [task("CaptureFailure")]);

		expect(resultText).toContain("merge failed");
		expect(resultText).not.toContain("no changes to persist");
		expect(resultText).not.toContain("changes persisted to the owner worktree");
	});

	it("applies only successful root patches and retains failed-task recovery", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess")
			.mockResolvedValueOnce(makeResult("Success", 0))
			.mockResolvedValueOnce(makeResult("Failure", 1));
		vi.spyOn(worktreeModule, "captureDeltaPatch")
			.mockResolvedValueOnce({ rootPatch: "successful patch", nestedPatches: [] })
			.mockResolvedValueOnce({ rootPatch: "failed patch", nestedPatches: [] });
		vi.spyOn(git.patch, "canApplyText").mockResolvedValue(true);
		const applyText = vi.spyOn(git.patch, "applyText").mockResolvedValue();
		vi.spyOn(worktreeModule, "verifyRootPatchesApplied").mockResolvedValue(true);

		const resultText = await runTask(await TaskTool.create(createSession()), [task("Success"), task("Failure")]);

		expect(applyText).toHaveBeenCalledTimes(1);
		expect(applyText.mock.calls[0]?.[1]).toContain("successful patch");
		expect(applyText.mock.calls[0]?.[1]).not.toContain("failed patch");
		expect(resultText).toContain("local://subagents/");
	});

	it("emits durable identity for nested-only edits", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("NestedOnly", 0));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "",
			nestedPatches: [{ relativePath: "vendor/nested", patch: "nested patch" }],
		});
		vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue();
		vi.spyOn(worktreeModule, "verifyNestedPatchesApplied").mockResolvedValue(true);

		const resultText = await runTask(await TaskTool.create(createSession()), [task("NestedOnly")]);

		expect(resultText).toContain("changes persisted to the owner worktree");
	});

	it("applies branch-mode nested-only edits before marking completion", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("BranchNested", 0));
		const nestedPatches = [{ relativePath: "vendor/nested", patch: "nested patch" }];
		vi.spyOn(worktreeModule, "commitToBranch").mockResolvedValue({ nestedPatches });
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches });
		const applyNested = vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue();
		vi.spyOn(worktreeModule, "verifyNestedPatchesApplied").mockResolvedValue(true);

		const resultText = await runTask(await TaskTool.create(createSession("branch")), [task("BranchNested")]);

		expect(applyNested).toHaveBeenCalledWith("/repo", nestedPatches);
		expect(resultText).toContain("changes persisted to the owner worktree");
		expect(resultText).not.toContain("merge failed");
	});

	it("downgrades branch results when merge setup throws before apply", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("BranchThrow", 0));
		const nestedPatches = [{ relativePath: "vendor/nested", patch: "nested recovery patch" }];
		vi.spyOn(worktreeModule, "commitToBranch").mockResolvedValue({
			branchName: "gjc/task/BranchThrow",
			nestedPatches,
		});
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "branch recovery patch",
			nestedPatches,
		});
		vi.spyOn(worktreeModule, "mergeTaskBranches").mockRejectedValue(new Error("stash setup failed"));
		const applyNested = vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue();

		const resultText = await runTask(await TaskTool.create(createSession("branch")), [task("BranchThrow")]);

		expect(applyNested).not.toHaveBeenCalled();
		expect(resultText).toContain("merge failed");
		expect(resultText).toContain("changes were not persisted to the owner worktree");
		expect(resultText).toContain("local://subagents/");
	});

	it("keeps stash-pop-conflicted merged branches recovery-only", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("StashConflict", 0));
		const branchName = "gjc/task/StashConflict";
		vi.spyOn(worktreeModule, "commitToBranch").mockResolvedValue({ branchName, nestedPatches: [] });
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "stash conflict recovery patch",
			nestedPatches: [],
		});
		vi.spyOn(worktreeModule, "mergeTaskBranches").mockResolvedValue({
			merged: [branchName],
			failed: [branchName],
			conflict: "stash pop: conflict with owner changes",
		});

		const resultText = await runTask(await TaskTool.create(createSession("branch")), [task("StashConflict")]);

		expect(resultText).toContain("merge failed");
		expect(resultText).toContain("changes were not persisted to the owner worktree");
		expect(resultText).toContain("local://subagents/");
	});

	it("downgrades root and nested recovery after a post-apply proof throws", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("ProofThrow", 0));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "root patch applied before proof",
			nestedPatches: [{ relativePath: "vendor/nested", patch: "nested patch" }],
		});
		vi.spyOn(git.patch, "canApplyText").mockResolvedValue(true);
		const applyText = vi.spyOn(git.patch, "applyText").mockResolvedValue();
		vi.spyOn(worktreeModule, "verifyRootPatchesApplied").mockRejectedValue(new Error("git inspection failed"));
		const applyNested = vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue();

		const resultText = await runTask(await TaskTool.create(createSession()), [task("ProofThrow")]);

		expect(applyText).toHaveBeenCalledTimes(1);
		expect(applyNested).not.toHaveBeenCalled();
		expect(resultText).toContain("merge failed");
		expect(resultText).toContain("changes were not persisted to the owner worktree");
		expect(resultText).toContain("local://subagents/");
	});

	it("preserves root recovery when nested capture is incomplete", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("PartialCapture", 0));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "root patch retained",
			nestedPatches: [],
			captureErrors: ["Nested repository is unavailable during delta capture: vendor/nested"],
		});
		const canApply = vi.spyOn(git.patch, "canApplyText");

		const resultText = await runTask(await TaskTool.create(createSession()), [task("PartialCapture")]);

		expect(canApply).not.toHaveBeenCalled();
		expect(resultText).toContain("merge failed");
		expect(resultText).toContain("local://subagents/");
		expect(resultText).not.toContain("no changes to persist");
	});

	it("keeps a legitimate isolated no-change task completed", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("NoChange", 0));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });

		const resultText = await runTask(await TaskTool.create(createSession()), [task("NoChange")]);

		expect(resultText).toContain("no changes to persist");
		expect(resultText).not.toContain("merge failed");
	});

	it("downgrades a root patch conflict to recovery", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("RootConflict", 0));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "conflicting root patch",
			nestedPatches: [],
		});
		vi.spyOn(git.patch, "canApplyText").mockResolvedValue(false);
		const applyText = vi.spyOn(git.patch, "applyText");

		const resultText = await runTask(await TaskTool.create(createSession()), [task("RootConflict")]);

		expect(applyText).not.toHaveBeenCalled();
		expect(resultText).toContain("merge failed");
		expect(resultText).toContain("local://subagents/");
	});

	it.each(["paused", "aborted"] as const)("preserves %s branch edits as recovery", async state => {
		mockIsolation();
		const raw = makeResult(`Branch-${state}`, 0);
		if (state === "paused") raw.paused = true;
		else {
			raw.aborted = true;
			raw.abortReason = "test abort";
		}
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(raw);
		const captureDelta = vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: `${state} branch patch`,
			nestedPatches: [],
		});
		const mergeBranches = vi.spyOn(worktreeModule, "mergeTaskBranches");

		const resultText = await runTask(await TaskTool.create(createSession("branch")), [task(`Branch-${state}`)]);

		expect(mergeBranches).not.toHaveBeenCalled();
		expect(captureDelta).toHaveBeenCalledTimes(1);
		if (state === "aborted") expect(resultText).toContain("local://subagents/");
	});

	it("downgrades completed tasks when nested patch application fails", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("NestedConflict", 0));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "",
			nestedPatches: [{ relativePath: "vendor/nested", patch: "nested patch" }],
		});
		vi.spyOn(worktreeModule, "applyNestedPatches").mockRejectedValue(new Error("nested conflict"));

		const resultText = await runTask(await TaskTool.create(createSession()), [task("NestedConflict")]);

		expect(resultText).toContain("merge failed");
		expect(resultText).toContain("changes were not persisted to the owner worktree");
		expect(resultText).toContain("local://subagents/");
	});

	it("downgrades nested changes when exact post-apply proof fails", async () => {
		mockIsolation();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("NestedProof", 0));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "",
			nestedPatches: [{ relativePath: "vendor/nested", patch: "nested patch" }],
		});
		vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue();
		vi.spyOn(worktreeModule, "verifyNestedPatchesApplied").mockResolvedValue(false);

		const resultText = await runTask(await TaskTool.create(createSession()), [task("NestedProof")]);

		expect(resultText).toContain("merge failed");
		expect(resultText).toContain("changes were not persisted to the owner worktree");
		expect(resultText).toContain("local://subagents/");
	});
});
