import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager, type SubagentRecord } from "../../src/async";
import { Settings } from "../../src/config/settings";
import type { AgentProgress } from "../../src/task/types";
import { SubagentTool, type ToolSession } from "../../src/tools";
import { type SubagentSnapshot, subagentAwaitRenderedStateSignature } from "../../src/tools/subagent";

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

function makeSnapshot(overrides: Partial<SubagentSnapshot> & Pick<SubagentSnapshot, "id">): SubagentSnapshot {
	return {
		jobId: overrides.id,
		status: "running",
		label: "subagent",
		agent: "executor",
		agentSource: "bundled",
		durationMs: 0,
		...overrides,
	};
}

describe("subagentAwaitRenderedStateSignature", () => {
	it("is value-based: equal values from independent clones produce identical signatures", () => {
		const a = makeSnapshot({
			id: "0-A",
			progress: makeProgress({ id: "0-A", currentTool: "read", recentOutput: ["x"] }),
		});
		const b = makeSnapshot({
			id: "0-A",
			// structuredClone yields a different object reference with equal values.
			progress: structuredClone(makeProgress({ id: "0-A", currentTool: "read", recentOutput: ["x"] })),
		});
		expect(subagentAwaitRenderedStateSignature([a])).toBe(subagentAwaitRenderedStateSignature([b]));
	});

	it("ignores time-derived churn (durationMs, current-tool elapsed, retry countdown)", () => {
		const early = makeSnapshot({
			id: "0-A",
			durationMs: 1_000,
			progress: makeProgress({
				id: "0-A",
				durationMs: 1_000,
				currentTool: "read",
				currentToolStartMs: 1_000,
				retryState: { attempt: 1, maxAttempts: 3, delayMs: 5_000, errorMessage: "429", startedAtMs: 1_000 },
			}),
		});
		const later = makeSnapshot({
			id: "0-A",
			durationMs: 999_999,
			progress: makeProgress({
				id: "0-A",
				durationMs: 999_999,
				currentTool: "read",
				currentToolStartMs: 2_000,
				retryState: { attempt: 1, maxAttempts: 3, delayMs: 5_000, errorMessage: "429", startedAtMs: 2_000 },
			}),
		});
		expect(subagentAwaitRenderedStateSignature([later])).toBe(subagentAwaitRenderedStateSignature([early]));
	});

	it("changes when any rendered field changes", () => {
		const baseProgress = makeProgress({
			id: "0-A",
			status: "running",
			currentTool: "read",
			recentOutput: ["x"],
			toolCount: 1,
			tokens: 10,
			cost: 0.1,
		});
		const base = makeSnapshot({ id: "0-A", status: "running", progress: baseProgress });
		const baseSig = subagentAwaitRenderedStateSignature([base]);

		const mutations: Array<(s: SubagentSnapshot) => SubagentSnapshot> = [
			s => ({ ...s, status: "completed" }),
			s => ({ ...s, guidance: "still running after the timeout" }),
			s => ({ ...s, errorText: "boom" }),
			s => ({ ...s, resultPreview: "ok" }),
			s => ({ ...s, outputRef: "agent://0-A" }),
			s => ({ ...s, truncated: true }),
			s => ({ ...s, liveProgressAvailable: false }),
			s => ({ ...s, effectiveModel: "model-2" }),
			s => ({ ...s, requestedModel: "model-1" }),
			s => ({ ...s, modelFellBack: true }),
			s => ({ ...s, description: "new description" }),
			s => ({ ...s, assignment: "new assignment" }),
			s => ({ ...s, progress: { ...baseProgress, currentTool: "bash" } }),
			s => ({ ...s, progress: { ...baseProgress, currentToolArgs: "ls -la" } }),
			s => ({ ...s, progress: { ...baseProgress, lastIntent: "thinking" } }),
			s => ({ ...s, progress: { ...baseProgress, recentOutput: ["y"] } }),
			s => ({ ...s, progress: { ...baseProgress, recentTools: [{ tool: "read", args: "f", endMs: 0 }] } }),
			s => ({ ...s, progress: { ...baseProgress, toolCount: 2 } }),
			s => ({ ...s, progress: { ...baseProgress, tokens: 20 } }),
			s => ({ ...s, progress: { ...baseProgress, contextTokens: 100 } }),
			s => ({ ...s, progress: { ...baseProgress, contextWindow: 200_000 } }),
			s => ({ ...s, progress: { ...baseProgress, cost: 0.2 } }),
			s => ({ ...s, progress: { ...baseProgress, status: "completed" } }),
			s => ({
				...s,
				progress: {
					...baseProgress,
					modelSubstitutionWarning: { requested: "a", effective: "b", reason: "auth_unavailable" },
				},
			}),
			s => ({
				...s,
				progress: {
					...baseProgress,
					retryState: { attempt: 1, maxAttempts: 3, delayMs: 1_000, errorMessage: "429", startedAtMs: 0 },
				},
			}),
			s => ({ ...s, progress: { ...baseProgress, retryFailure: { attempt: 3, errorMessage: "gave up" } } }),
			s => ({ ...s, progress: { ...baseProgress, extractedToolData: { task: [{ id: "n1", status: "running" }] } } }),
			s => ({
				...s,
				progress: {
					...baseProgress,
					inflightTaskDetails: { id: "t1" } as unknown as NonNullable<AgentProgress["inflightTaskDetails"]>,
				},
			}),
		];

		for (const mutate of mutations) {
			expect(subagentAwaitRenderedStateSignature([mutate(base)])).not.toBe(baseSig);
		}
	});

	it("recentOutput tail changes are reflected (producer never drops real output progress)", () => {
		const a = makeSnapshot({ id: "0-A", progress: makeProgress({ id: "0-A", recentOutput: ["a", "b"] }) });
		const b = makeSnapshot({ id: "0-A", progress: makeProgress({ id: "0-A", recentOutput: ["a", "b", "c"] }) });
		expect(subagentAwaitRenderedStateSignature([a])).not.toBe(subagentAwaitRenderedStateSignature([b]));
	});

	it("ignores nested task time churn but reflects nested status changes", () => {
		const makeInflight = (
			durationMs: number,
			nestedStatus: AgentProgress["status"],
		): NonNullable<AgentProgress["inflightTaskDetails"]> =>
			({
				projectAgentsDir: null,
				results: [],
				totalDurationMs: durationMs,
				progress: [makeProgress({ id: "child", status: nestedStatus, durationMs, currentToolStartMs: durationMs })],
			}) as unknown as NonNullable<AgentProgress["inflightTaskDetails"]>;

		const early = makeSnapshot({
			id: "0-A",
			progress: makeProgress({ id: "0-A", inflightTaskDetails: makeInflight(1_000, "running") }),
		});
		const later = makeSnapshot({
			id: "0-A",
			progress: makeProgress({ id: "0-A", inflightTaskDetails: makeInflight(999_999, "running") }),
		});
		const statusChanged = makeSnapshot({
			id: "0-A",
			progress: makeProgress({ id: "0-A", inflightTaskDetails: makeInflight(1_000, "completed") }),
		});

		// Nested task time churn (totalDurationMs + nested progress duration/elapsed) is ignored.
		expect(subagentAwaitRenderedStateSignature([later])).toBe(subagentAwaitRenderedStateSignature([early]));
		// A real nested status change still emits.
		expect(subagentAwaitRenderedStateSignature([statusChanged])).not.toBe(
			subagentAwaitRenderedStateSignature([early]),
		);
	});
});

describe("subagent await emit gating", () => {
	afterEach(() => {
		vi.useRealTimers();
		AsyncJobManager.resetForTests();
	});

	it("emits only the initial update for idle concurrent awaits, then exactly once per real change", async () => {
		vi.useFakeTimers();
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const ids = ["0-A", "0-B", "0-C"];
		const controls = ids.map(() => Promise.withResolvers<void>());
		ids.forEach((id, i) => {
			const jobId = manager.register(
				"task",
				id,
				async () => {
					await controls[i].promise;
					return "done";
				},
				{
					id: `job-${id}`,
					ownerId: "0-Main",
					metadata: { subagent: { id, agent: "executor", agentSource: "bundled" } },
				},
			);
			manager.registerSubagentRecord(runningRecord(id, jobId));
			manager.recordSubagentProgress(id, makeProgress({ id, currentTool: "read", recentOutput: ["scan"] }));
		});

		const ac = new AbortController();
		const spies = ids.map(() => vi.fn());
		const execs = ids.map((id, i) =>
			tool.execute(`await-${id}`, { action: "await", ids: [id], timeout_ms: 3_600_000 }, ac.signal, spies[i]),
		);

		// The initial partial emission runs synchronously when the await starts.
		await Promise.resolve();
		for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);

		// Idle: 5 interval ticks (2500ms) with unchanged progress must not emit.
		vi.advanceTimersByTime(2_500);
		for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);

		// A real progress change on 0-A emits exactly once; idle peers stay quiet.
		manager.recordSubagentProgress("0-A", makeProgress({ id: "0-A", currentTool: "bash", recentOutput: ["scan"] }));
		vi.advanceTimersByTime(500);
		expect(spies[0]).toHaveBeenCalledTimes(2);
		expect(spies[1]).toHaveBeenCalledTimes(1);
		expect(spies[2]).toHaveBeenCalledTimes(1);

		ac.abort();
		for (const control of controls) control.resolve();
		await Promise.all(execs);
		await manager.dispose({ timeoutMs: 100 });
	});
});
