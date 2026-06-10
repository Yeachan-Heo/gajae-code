import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager, type SubagentRecord } from "../../src/async";
import { Settings } from "../../src/config/settings";
import type { AgentProgress } from "../../src/task/types";
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
	const manager = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000 });
	AsyncJobManager.setInstance(manager);
	return manager;
}

function makeProgress(overrides: Partial<AgentProgress> & Pick<AgentProgress, "id">): AgentProgress {
	return {
		index: 0,
		agent: "executor",
		agentSource: "bundled",
		status: "running",
		task: "assignment",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function runningRecord(subagentId: string, jobId: string): SubagentRecord {
	return {
		subagentId,
		ownerId: "0-Main",
		currentJobId: jobId,
		historicalJobIds: [],
		status: "running",
		sessionFile: null,
		resumable: false,
	};
}

describe("subagent await live progress", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
	});

	it("surfaces retained progress recorded before await (replay, no new event)", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const jobId = manager.register(
			"task",
			"live subagent",
			async () => {
				await Bun.sleep(150);
				return "done";
			},
			{
				id: "job-live",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-Live", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord(runningRecord("0-Live", jobId));
		// Record progress BEFORE await; no further progress event will fire.
		manager.recordSubagentProgress(
			"0-Live",
			makeProgress({ id: "0-Live", currentTool: "read", recentOutput: ["scanning files"] }),
		);

		const result = await tool.execute("await", { action: "await", ids: ["0-Live"], timeout_ms: 5 });
		const snap = result.details?.subagents.find(s => s.id === "0-Live");

		expect(snap?.status).toBe("running");
		expect(snap?.liveProgressAvailable).toBe(true);
		expect(snap?.progress?.currentTool).toBe("read");
		expect(snap?.progress?.recentOutput).toContain("scanning files");

		manager.cancelSubagent("0-Live", { ownerId: "0-Main" });
		await manager.dispose({ timeoutMs: 100 });
	});

	it("isolates live progress per subagent id", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const jobA = manager.register(
			"task",
			"a",
			async () => {
				await Bun.sleep(150);
				return "a";
			},
			{
				id: "job-a",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-A", agent: "executor", agentSource: "bundled" } },
			},
		);
		const jobB = manager.register(
			"task",
			"b",
			async () => {
				await Bun.sleep(150);
				return "b";
			},
			{
				id: "job-b",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-B", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord(runningRecord("0-A", jobA));
		manager.registerSubagentRecord(runningRecord("0-B", jobB));
		manager.recordSubagentProgress("0-A", makeProgress({ id: "0-A", currentTool: "read" }));
		manager.recordSubagentProgress("0-B", makeProgress({ id: "0-B", currentTool: "bash" }));

		const result = await tool.execute("await", { action: "await", ids: ["0-A", "0-B"], timeout_ms: 5 });
		const a = result.details?.subagents.find(s => s.id === "0-A");
		const b = result.details?.subagents.find(s => s.id === "0-B");

		expect(a?.progress?.currentTool).toBe("read");
		expect(b?.progress?.currentTool).toBe("bash");

		manager.cancelSubagent("0-A", { ownerId: "0-Main" });
		manager.cancelSubagent("0-B", { ownerId: "0-Main" });
		await manager.dispose({ timeoutMs: 100 });
	});

	it("degrades to no live producer when the record is not a live in-session subagent", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		// No registerSubagentRecord -> the tool synthesizes a backward-compat record.
		manager.register(
			"task",
			"synth subagent",
			async () => {
				await Bun.sleep(150);
				return "done";
			},
			{
				id: "job-synth",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-Synth", agent: "executor", agentSource: "bundled" } },
			},
		);

		const result = await tool.execute("await", { action: "await", ids: ["0-Synth"], timeout_ms: 5 });
		const snap = result.details?.subagents.find(s => s.id === "0-Synth");

		expect(snap?.status).toBe("running");
		expect(snap?.progress).toBeUndefined();
		expect(snap?.liveProgressAvailable).toBe(false);

		manager.cancel("job-synth", { ownerId: "0-Main" });
		await manager.dispose({ timeoutMs: 100 });
	});

	it("does not surface retained progress when no live producer exists (stale-progress degrade)", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		// Synthesized backward-compat record (no canonical SubagentRecord) => no live producer.
		manager.register(
			"task",
			"synth stale subagent",
			async () => {
				await Bun.sleep(150);
				return "done";
			},
			{
				id: "job-stale",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-Stale", agent: "executor", agentSource: "bundled" } },
			},
		);
		// Retained progress exists for the id, but there is no live producer for it.
		manager.recordSubagentProgress("0-Stale", makeProgress({ id: "0-Stale", currentTool: "should-not-render" }));

		const result = await tool.execute("await", { action: "await", ids: ["0-Stale"], timeout_ms: 5 });
		const snap = result.details?.subagents.find(s => s.id === "0-Stale");

		expect(snap?.liveProgressAvailable).toBe(false);
		expect(snap?.progress).toBeUndefined();

		manager.cancel("job-stale", { ownerId: "0-Main" });
		await manager.dispose({ timeoutMs: 100 });
	});
});

describe("AsyncJobManager subagent progress retention", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
	});

	it("hasLiveSubagent is true for a canonical running record and false for synthesized/absent ids", () => {
		const manager = createManager();
		const jobId = manager.register(
			"task",
			"live",
			async ({ signal }) => {
				while (!signal.aborted) await Bun.sleep(5);
				throw new Error("cancelled");
			},
			{
				id: "job-live",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-Live", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord(runningRecord("0-Live", jobId));

		expect(manager.hasLiveSubagent("0-Live")).toBe(true);
		expect(manager.hasLiveSubagent("0-Absent")).toBe(false);

		manager.cancelSubagent("0-Live", { ownerId: "0-Main" });
	});

	it("clears retained progress on terminal cleanup (cancel)", async () => {
		const manager = createManager();
		const jobId = manager.register(
			"task",
			"cleanup",
			async ({ signal }) => {
				while (!signal.aborted) await Bun.sleep(5);
				throw new Error("cancelled");
			},
			{
				id: "job-clean",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-Clean", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord(runningRecord("0-Clean", jobId));
		manager.recordSubagentProgress("0-Clean", makeProgress({ id: "0-Clean", currentTool: "read" }));
		expect(manager.getSubagentProgress("0-Clean")).toBeDefined();

		manager.cancelSubagent("0-Clean", { ownerId: "0-Main" });
		await manager.getJob(jobId)?.promise;

		expect(manager.getSubagentProgress("0-Clean")).toBeUndefined();
		await manager.dispose({ timeoutMs: 100 });
	});

	it("ignores progress for ids without a canonical subagent record (foreground task isolation)", () => {
		const manager = createManager();
		manager.recordSubagentProgress("0-Foreground", makeProgress({ id: "0-Foreground", currentTool: "read" }));
		expect(manager.getSubagentProgress("0-Foreground")).toBeUndefined();
	});

	it("clears retained progress at resume start so a resumed run shows no stale live status", () => {
		const manager = createManager();
		const firstJob = manager.register(
			"task",
			"resume-1",
			async () => {
				await Bun.sleep(200);
				return "one";
			},
			{
				id: "job-r1",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-Resume", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord({
			subagentId: "0-Resume",
			ownerId: "0-Main",
			currentJobId: firstJob,
			historicalJobIds: [],
			status: "paused",
			sessionFile: "/tmp/0-Resume.jsonl",
			resumable: true,
		});
		manager.recordSubagentProgress("0-Resume", makeProgress({ id: "0-Resume", currentTool: "old-tool" }));
		expect(manager.getSubagentProgress("0-Resume")).toBeDefined();

		manager.setResumeRunner(() =>
			manager.register(
				"task",
				"resume-2",
				async () => {
					await Bun.sleep(200);
					return "two";
				},
				{
					id: "job-r2",
					ownerId: "0-Main",
					metadata: { subagent: { id: "0-Resume", agent: "executor", agentSource: "bundled" } },
				},
			),
		);

		const result = manager.resumeSubagent("0-Resume", { ownerId: "0-Main" }, "go");
		expect(result.ok).toBe(true);
		// Retained progress from the previous run must be gone before the new run emits.
		expect(manager.getSubagentProgress("0-Resume")).toBeUndefined();
	});

	it("deep-clones retained progress so later mutation cannot corrupt it", () => {
		const manager = createManager();
		manager.registerSubagentRecord(runningRecord("0-Clone", "job-clone"));
		const live = makeProgress({ id: "0-Clone", recentOutput: ["one"] });
		manager.recordSubagentProgress("0-Clone", live);
		live.recentOutput.push("two");
		live.currentTool = "mutated";

		const retained = manager.getSubagentProgress("0-Clone");
		expect(retained?.recentOutput).toEqual(["one"]);
		expect(retained?.currentTool).toBeUndefined();
	});
});
