import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { SubagentTool, type ToolSession } from "../../src/tools";

function createSession(agentId = "0-Main"): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => agentId,
	} as ToolSession;
}

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({
		onJobComplete: async () => {},
		retentionMs: 10_000,
	});
	AsyncJobManager.setInstance(manager);
	return manager;
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("SubagentTool", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
	});

	it("lists only visible task jobs with subagent metadata", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession("0-Main"));
		manager.register(
			"task",
			"visible subagent",
			async () => {
				await Bun.sleep(50);
				return "visible done";
			},
			{
				id: "job-visible",
				ownerId: "0-Main",
				metadata: {
					subagent: {
						id: "0-Visible",
						agent: "executor",
						agentSource: "bundled",
						description: "visible task",
						assignment: "Do visible work.",
					},
				},
			},
		);
		manager.register("task", "hidden subagent", async () => "hidden done", {
			id: "job-hidden",
			ownerId: "1-Other",
			metadata: {
				subagent: {
					id: "1-Hidden",
					agent: "executor",
					agentSource: "bundled",
				},
			},
		});
		manager.register("bash", "generic job", async () => "generic done", { id: "job-bash", ownerId: "0-Main" });

		const result = await tool.execute("subagent-list", { action: "list" });

		expect(result.details?.subagents.map(subagent => subagent.id)).toEqual(["0-Visible"]);
		expect(getText(result)).toContain("0-Visible");
		expect(getText(result)).not.toContain("job-bash");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("await retrieves completed subagent results and acknowledges delivery", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const jobId = manager.register("task", "finished subagent", async () => "subagent result", {
			id: "job-done",
			ownerId: "0-Main",
			metadata: {
				subagent: {
					id: "0-Done",
					agent: "executor",
					agentSource: "project",
					description: "done task",
					assignment: "Return a result.",
				},
			},
		});
		await manager.getJob(jobId)?.promise;

		const result = await tool.execute("subagent-await", { action: "await", ids: ["0-Done"], timeout_ms: 100 });

		expect(result.details?.subagents[0]?.status).toBe("completed");
		expect(result.details?.subagents[0]?.resultText).toContain("subagent result");
		expect(getText(result)).toContain("subagent result");
		expect(manager.hasPendingDeliveries()).toBe(false);
		await manager.dispose({ timeoutMs: 100 });
	});

	it("await timeout is non-terminal and guides continued observation instead of shutdown", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		manager.register(
			"task",
			"slow subagent",
			async () => {
				await Bun.sleep(60);
				return "slow result";
			},
			{
				id: "job-slow",
				ownerId: "0-Main",
				metadata: {
					subagent: {
						id: "0-Slow",
						agent: "executor",
						agentSource: "bundled",
						description: "slow task",
						assignment: "Keep working slowly.",
					},
				},
			},
		);

		const result = await tool.execute("subagent-await-timeout", {
			action: "await",
			ids: ["0-Slow"],
			timeout_ms: 1,
		});
		const guidance = result.details?.subagents[0]?.guidance ?? "";

		expect(result.details?.subagents[0]?.status).toBe("running");
		expect(guidance).toContain("Still running");
		expect(guidance).toContain("not a failure");
		expect(guidance).toContain("never cancel just because an await timed out");
		expect(guidance).toContain("cancel only if the subagent has actually failed");
		expect(guidance).not.toContain("steer");
		expect(guidance).not.toContain("shutdown");

		await Bun.sleep(80);
		const completed = await tool.execute("subagent-await-completed", {
			action: "await",
			ids: ["0-Slow"],
			timeout_ms: 100,
		});

		expect(completed.details?.subagents[0]?.status).toBe("completed");
		expect(completed.details?.subagents[0]?.resultText).toContain("slow result");
		expect(manager.getJob("job-slow")?.status).toBe("completed");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("cancel stops a selected known-bad running subagent by subagent id", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		manager.register(
			"task",
			"known-bad cancel subagent",
			async ({ signal }) => {
				while (!signal.aborted) await Bun.sleep(5);
				throw new Error("cancelled");
			},
			{
				id: "job-cancel",
				ownerId: "0-Main",
				metadata: {
					subagent: {
						id: "0-Cancel",
						agent: "executor",
						agentSource: "bundled",
					},
				},
			},
		);

		const result = await tool.execute("subagent-cancel", { action: "cancel", ids: ["0-Cancel"] });

		expect(result.details?.subagents[0]?.status).toBe("cancelled");
		expect(manager.getJob("job-cancel")?.status).toBe("cancelled");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("pause requests a running registered subagent and returns a running snapshot", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		let pauseRequested = false;
		manager.registerSubagentRecord({
			subagentId: "0-Pause",
			ownerId: "0-Main",
			currentJobId: null,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/0-Pause.jsonl",
			resumable: true,
		});
		manager.registerLiveHandle("0-Pause", {
			requestPause() {
				pauseRequested = true;
			},
			async injectMessage() {},
		});

		const result = await tool.execute("subagent-pause", { action: "pause", ids: ["0-Pause"] });

		expect(pauseRequested).toBe(true);
		expect(result.details?.subagents[0]?.status).toBe("running");
		expect(getText(result)).toContain("0-Pause");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("resume starts a paused subagent through the manager runner", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		manager.setResumeRunner(subagentId =>
			manager.register("task", subagentId, async () => "resumed", {
				id: "job-resumed",
				ownerId: "0-Main",
				metadata: { subagent: { id: subagentId, agent: "executor", agentSource: "bundled" } },
			}),
		);
		manager.registerSubagentRecord({
			subagentId: "0-Resume",
			ownerId: "0-Main",
			currentJobId: "job-paused",
			historicalJobIds: [],
			status: "paused",
			sessionFile: "/tmp/0-Resume.jsonl",
			resumable: true,
		});

		const result = await tool.execute("subagent-resume", { action: "resume", ids: ["0-Resume"] });

		expect(result.details?.subagents[0]?.status).toBe("running");
		expect(result.details?.subagents[0]?.jobId).toBe("job-resumed");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("steer running injects a message and optionally requests pause", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		let injected: string | undefined;
		let pauseRequested = false;
		manager.registerSubagentRecord({
			subagentId: "0-Steer",
			ownerId: "0-Main",
			currentJobId: null,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/0-Steer.jsonl",
			resumable: true,
		});
		manager.registerLiveHandle("0-Steer", {
			requestPause() {
				pauseRequested = true;
			},
			async injectMessage(content) {
				injected = content;
			},
		});

		const result = await tool.execute("subagent-steer", {
			action: "steer",
			ids: ["0-Steer"],
			message: "tighten scope",
			pause: true,
		});

		expect(injected).toBe("tighten scope");
		expect(pauseRequested).toBe(true);
		expect(result.details?.subagents[0]?.status).toBe("running");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("steer non-active auto-resumes with message and ignores pause flag", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		let resumedMessage: string | undefined;
		manager.setResumeRunner((subagentId, message) => {
			resumedMessage = message;
			return manager.register("task", subagentId, async () => "resumed", {
				id: "job-auto-resumed",
				ownerId: "0-Main",
				metadata: { subagent: { id: subagentId, agent: "executor", agentSource: "bundled" } },
			});
		});
		manager.registerSubagentRecord({
			subagentId: "0-Auto",
			ownerId: "0-Main",
			currentJobId: "job-completed",
			historicalJobIds: [],
			status: "completed",
			sessionFile: "/tmp/0-Auto.jsonl",
			resumable: true,
		});

		const result = await tool.execute("subagent-steer-auto", {
			action: "steer",
			ids: ["0-Auto"],
			message: "follow up",
			pause: true,
		});

		expect(resumedMessage).toBe("follow up");
		expect(result.details?.subagents[0]?.status).toBe("running");
		expect(result.details?.subagents[0]?.jobId).toBe("job-auto-resumed");
		await manager.dispose({ timeoutMs: 100 });
	});
	it("list and inspect default terminal subagents return receipt previews without bulk output and no unverified ref", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const leak = "LEAK_SENTINEL_DO_NOT_DIGEST";
		const bulk = `${"a".repeat(300)}${leak}${"b".repeat(64 * 1024)}`;
		const jobId = manager.register("task", "leaky subagent", async () => bulk, {
			id: "0-Leaky",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-Leaky", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "0-Leaky",
			ownerId: "0-Main",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/0-Leaky.jsonl",
			resumable: true,
		});
		await manager.getJob(jobId)?.promise;

		const listed = await tool.execute("subagent-list-leak", { action: "list" });
		const inspected = await tool.execute("subagent-inspect-leak", { action: "inspect", ids: ["0-Leaky"] });

		for (const result of [listed, inspected]) {
			const snapshot = result.details?.subagents[0];
			expect(snapshot?.resultPreview?.length ?? 0).toBeLessThanOrEqual(281);
			expect(snapshot?.resultText).toBe(snapshot?.resultPreview);
			expect(snapshot?.outputRef).toBeUndefined();
			expect(snapshot?.truncated).toBe(true);
			expect(getText(result)).not.toContain(leak);
			expect(getText(result).length).toBeLessThan(2_000);
		}
		await manager.dispose({ timeoutMs: 100 });
	});

	it("supports preview and explicit full verbosity bounds without unverified refs", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const bulk = "x".repeat(5_000);
		const jobId = manager.register("task", "verbose subagent", async () => bulk, {
			id: "0-Verbose",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-Verbose", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "0-Verbose",
			ownerId: "0-Main",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/0-Verbose.jsonl",
			resumable: true,
		});
		await manager.getJob(jobId)?.promise;

		const preview = await tool.execute("subagent-preview", {
			action: "inspect",
			ids: ["0-Verbose"],
			verbosity: "preview",
		});
		expect(preview.details?.subagents[0]?.resultPreview?.length ?? 0).toBeLessThanOrEqual(2_001);
		expect(preview.details?.subagents[0]?.truncated).toBe(true);

		await expect(tool.execute("subagent-full-bare", { action: "inspect", verbosity: "full" })).rejects.toThrow(
			"requires explicit `ids`",
		);
		await expect(
			tool.execute("subagent-full-list", { action: "list", ids: ["0-Verbose"], verbosity: "full" }),
		).rejects.toThrow("cannot be used with `list`");

		const full = await tool.execute("subagent-full", {
			action: "inspect",
			ids: ["0-Verbose"],
			verbosity: "full",
		});
		expect(full.details?.subagents[0]?.resultPreview?.length).toBe(5_000);
		expect(full.details?.subagents[0]?.outputRef).toBeUndefined();
		await manager.dispose({ timeoutMs: 100 });
	});

	it("await default returns bounded preview with output ref instead of full retained text", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const leak = "LEAK_SENTINEL_DO_NOT_DIGEST";
		const bulk = `${"a".repeat(300)}${leak}${"b".repeat(64 * 1024)}`;
		const jobId = manager.register("task", "await leaky subagent", async () => bulk, {
			id: "0-AwaitLeaky",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-AwaitLeaky", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "0-AwaitLeaky",
			ownerId: "0-Main",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/0-AwaitLeaky.jsonl",
			resumable: true,
		});

		const result = await tool.execute("subagent-await-leak", {
			action: "await",
			ids: ["0-AwaitLeaky"],
			timeout_ms: 100,
		});

		const snapshot = result.details?.subagents[0];
		expect(snapshot?.resultPreview?.length ?? 0).toBeLessThanOrEqual(281);
		expect(snapshot?.outputRef).toBeUndefined();
		expect(snapshot?.truncated).toBe(true);
		expect(getText(result)).not.toContain(leak);
		await manager.dispose({ timeoutMs: 100 });
	});

	it("includes output ref only when an agent output sidecar exists in the subagent artifact dir", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-output-ref-"));
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const jobId = manager.register("task", "artifact-backed subagent", async () => "artifact backed result", {
			id: "0-ArtifactBacked",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-ArtifactBacked", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "0-ArtifactBacked",
			ownerId: "0-Main",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: path.join(artifactsDir, "0-ArtifactBacked.jsonl"),
			resumable: true,
		});
		await manager.getJob(jobId)?.promise;
		await Bun.write(path.join(artifactsDir, "0-ArtifactBacked.md"), "artifact backed result");
		await Bun.write(path.join(artifactsDir, "0-ArtifactBacked.md.meta.json"), "{}");

		const result = await tool.execute("subagent-artifact-backed", {
			action: "inspect",
			ids: ["0-ArtifactBacked"],
		});

		expect(result.details?.subagents[0]?.outputRef).toBe("agent://0-ArtifactBacked");
		expect(getText(result)).toContain("Output: agent://0-ArtifactBacked");
		await manager.dispose({ timeoutMs: 100 });
		await fs.rm(artifactsDir, { recursive: true, force: true });
	});
});
