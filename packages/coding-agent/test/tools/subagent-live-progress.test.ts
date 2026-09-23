import { afterEach, describe, expect, it, vi } from "bun:test";
import { GenAIAttr, resolveTelemetry, startChatSpan } from "@gajae-code/agent-core/telemetry";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AsyncJobManager, type SubagentRecord } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { mapAgentSessionEventToAcpSessionUpdates } from "../../src/modes/acp/acp-event-mapper";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme";
import type { AgentProgress } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { SubagentTool } from "../../src/tools/implementations";
import {
	type SubagentSnapshot,
	type SubagentToolDetails,
	subagentAwaitRenderedStateSignature,
} from "../../src/tools/subagent";
import { subagentToolRenderer } from "../../src/tools/subagent-render";

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
		expect(snap?.progress?.recentOutputSummary).toEqual({ lineCount: 1 });

		manager.cancelSubagent("0-Live", { ownerId: "0-Main" });
		await manager.dispose({ timeoutMs: 100 });
	});

	it("surfaces retained fast mode from the canonical subagent record", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const jobId = manager.register(
			"task",
			"fast subagent",
			async () => {
				await Bun.sleep(150);
				return "done";
			},
			{
				id: "job-fast",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-Fast", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord(runningRecord("0-Fast", jobId));
		manager.updateSubagentModel("0-Fast", { fastMode: true });

		const result = await tool.execute("inspect", { action: "inspect", ids: ["0-Fast"] });
		const snap = result.details?.subagents.find(s => s.id === "0-Fast");

		expect(snap?.fastMode).toBe(true);

		manager.cancelSubagent("0-Fast", { ownerId: "0-Main" });
		await manager.dispose({ timeoutMs: 100 });
	});

	it("retains fast mode across a live progress update", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const jobId = manager.register(
			"task",
			"fast subagent",
			async () => {
				await Bun.sleep(2000);
				return "done";
			},
			{
				id: "job-fast-live",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-FastLive", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord(runningRecord("0-FastLive", jobId));
		manager.updateSubagentModel("0-FastLive", { fastMode: true });

		const updates: SubagentSnapshot[] = [];
		const pending = tool.execute(
			"await",
			{ action: "await", ids: ["0-FastLive"], timeout_ms: 1500 },
			undefined,
			result => {
				const snap = result.details?.subagents.find(s => s.id === "0-FastLive");
				if (snap) updates.push(snap);
			},
		);

		// Mutate progress only AFTER the await is live, so the panel is forced to
		// rebuild the snapshot in flight. The record-derived fast flag must survive
		// that rebuild, or the ⚡ glyph vanishes the moment the subagent reports.
		await Bun.sleep(50);
		manager.recordSubagentProgress("0-FastLive", makeProgress({ id: "0-FastLive", currentTool: "read" }));
		await pending;

		const rebuilt = updates.filter(snap => snap.progress?.currentTool === "read");
		expect(rebuilt.length).toBeGreaterThan(0);
		expect(rebuilt.every(snap => snap.fastMode === true)).toBe(true);

		manager.cancelSubagent("0-FastLive", { ownerId: "0-Main" });
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
			progress: {
				id: "0-A",
				status: "running",
				currentTool: "read",
				recentOutputSummary: { lineCount: 1 },
			},
		});
		const b = makeSnapshot({
			id: "0-A",
			// structuredClone yields a different object reference with equal values.
			progress: structuredClone(a.progress),
		});
		expect(subagentAwaitRenderedStateSignature([a])).toBe(subagentAwaitRenderedStateSignature([b]));
	});

	it("ignores time-derived churn (durationMs, current-tool elapsed, retry countdown)", () => {
		const early = makeSnapshot({
			id: "0-A",
			durationMs: 1_000,
			progress: {
				id: "0-A",
				status: "running",
				currentTool: "read",
				retryState: {
					attempt: 1,
					maxAttempts: 3,
					kind: "provider_error",
					delayMs: 5_000,
					startedAtMs: 1_000,
				},
			},
		});
		const later = makeSnapshot({
			id: "0-A",
			durationMs: 999_999,
			progress: {
				id: "0-A",
				status: "running",
				currentTool: "read",
				retryState: {
					attempt: 1,
					maxAttempts: 3,
					kind: "provider_error",
					delayMs: 5_000,
					startedAtMs: 2_000,
				},
			},
		});
		expect(subagentAwaitRenderedStateSignature([later])).toBe(subagentAwaitRenderedStateSignature([early]));
	});

	it("changes when any rendered field changes", () => {
		const baseProgress = {
			id: "0-A",
			status: "running",
			currentTool: "read",
			recentOutputSummary: { lineCount: 1 },
			fastMode: false,
		} as const;
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
			s => ({ ...s, fastMode: true }),
			s => ({ ...s, description: "new description" }),
			s => ({ ...s, assignment: "new assignment" }),
			s => ({ ...s, progress: { ...baseProgress, currentTool: "bash" } }),
			s => ({ ...s, progress: { ...baseProgress, recentTool: "read", currentTool: undefined } }),
			s => ({ ...s, progress: { ...baseProgress, recentOutputSummary: { lineCount: 2 } } }),
			s => ({ ...s, progress: { ...baseProgress, fastMode: true } }),
			s => ({ ...s, progress: { ...baseProgress, toolCount: 4 } }),
			s => ({ ...s, progress: { ...baseProgress, contextTokens: 12_000 } }),
			s => ({ ...s, progress: { ...baseProgress, contextWindow: 200_000 } }),
			s => ({ ...s, progress: { ...baseProgress, lastActivityMs: 1_234 } }),
			s => ({ ...s, progress: { ...baseProgress, status: "completed" } }),
			s => ({
				...s,
				progress: {
					...baseProgress,
					retryState: {
						attempt: 1,
						maxAttempts: 3,
						kind: "provider_error",
						delayMs: 1_000,
						startedAtMs: 0,
					},
				},
			}),
			s => ({ ...s, progress: { ...baseProgress, retryFailure: { attempt: 3 } } }),
		];

		for (const mutate of mutations) {
			expect(subagentAwaitRenderedStateSignature([mutate(base)])).not.toBe(baseSig);
		}
	});

	it("recent-output summary count changes are reflected without exposing output", () => {
		const a = makeSnapshot({
			id: "0-A",
			progress: { id: "0-A", status: "running", recentOutputSummary: { lineCount: 2 } },
		});
		const b = makeSnapshot({
			id: "0-A",
			progress: { id: "0-A", status: "running", recentOutputSummary: { lineCount: 3 } },
		});
		expect(subagentAwaitRenderedStateSignature([a])).not.toBe(subagentAwaitRenderedStateSignature([b]));
	});

	it("does not include nested task payloads in the signature", () => {
		const safe = makeSnapshot({ id: "0-A", progress: { id: "0-A", status: "running", currentTool: "task" } });
		const withRawNested = makeSnapshot({
			id: "0-A",
			progress: { id: "0-A", status: "running", currentTool: "task" },
		});
		expect(subagentAwaitRenderedStateSignature([withRawNested])).toBe(subagentAwaitRenderedStateSignature([safe]));
	});

	it("coalesces child activity within one bucket but changes across buckets", () => {
		const at = (lastActivityMs: number) =>
			subagentAwaitRenderedStateSignature([
				makeSnapshot({ id: "0-A", progress: { id: "0-A", status: "running", lastActivityMs } }),
			]);
		// Streamed deltas inside one bucket must not re-emit.
		expect(at(10_000)).toBe(at(14_999));
		// Real later activity must.
		expect(at(15_000)).not.toBe(at(10_000));
	});

	it("changes when only approved fastMode flips", () => {
		const slow = makeSnapshot({ id: "0-A", progress: { id: "0-A", status: "running", fastMode: false } });
		const fast = makeSnapshot({ id: "0-A", progress: { id: "0-A", status: "running", fastMode: true } });
		expect(subagentAwaitRenderedStateSignature([fast])).not.toBe(subagentAwaitRenderedStateSignature([slow]));
		expect(subagentAwaitRenderedStateSignature([fast])).toBe(subagentAwaitRenderedStateSignature([fast]));
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

	it("emits exactly once when only approved fastMode flips, and not for an unchanged poll", async () => {
		vi.useFakeTimers();
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const control = Promise.withResolvers<void>();
		const jobId = manager.register(
			"task",
			"0-Nested",
			async () => {
				await control.promise;
				return "done";
			},
			{
				id: "job-0-Nested",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-Nested", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord(runningRecord("0-Nested", jobId));

		const nested = (fastMode: boolean) => makeProgress({ id: "0-Nested", currentTool: "read", fastMode });

		manager.recordSubagentProgress("0-Nested", nested(false));
		const ac = new AbortController();
		const spy = vi.fn();
		const exec = tool.execute(
			"await-0-Nested",
			{ action: "await", ids: ["0-Nested"], timeout_ms: 3_600_000 },
			ac.signal,
			spy,
		);
		await Promise.resolve();
		expect(spy).toHaveBeenCalledTimes(1);

		// Re-recording the identical approved progress is not a rendered-state change.
		manager.recordSubagentProgress("0-Nested", nested(false));
		vi.advanceTimersByTime(500);
		expect(spy).toHaveBeenCalledTimes(1);

		// Flipping only the approved fastMode changes what renders, so it must emit once.
		manager.recordSubagentProgress("0-Nested", nested(true));
		vi.advanceTimersByTime(500);
		expect(spy).toHaveBeenCalledTimes(2);
		const emitted = spy.mock.calls.at(-1)?.[0] as { details?: SubagentToolDetails } | undefined;
		expect(emitted?.details?.subagents?.[0]?.progress?.fastMode).toBe(true);

		// And the new value is then stable: another identical poll stays quiet.
		manager.recordSubagentProgress("0-Nested", nested(true));
		vi.advanceTimersByTime(500);
		expect(spy).toHaveBeenCalledTimes(2);

		ac.abort();
		control.resolve();
		await exec;
		await manager.dispose({ timeoutMs: 100 });
	});

	it("emits retry start and recovery but suppresses countdown-only churn", async () => {
		vi.useFakeTimers();
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const control = Promise.withResolvers<void>();
		const jobId = manager.register(
			"task",
			"retrying subagent",
			async () => {
				await control.promise;
				return "done";
			},
			{
				id: "job-retry",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-Retry", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord(runningRecord("0-Retry", jobId));
		const retry = (attempt: number, startedAtMs: number, lastProviderProgressAtMs?: number) =>
			makeProgress({
				id: "0-Retry",
				status: "running",
				retryState: {
					attempt,
					maxAttempts: 3,
					kind: "provider_error",
					provider: "anthropic",
					delayMs: 5_000,
					errorMessage: "provider unavailable",
					startedAtMs,
					...(lastProviderProgressAtMs === undefined ? {} : { lastProviderProgressAtMs }),
				},
			});

		manager.recordSubagentProgress("0-Retry", retry(1, 0));
		const ac = new AbortController();
		const spy = vi.fn();
		const pending = tool.execute(
			"await-retry",
			{ action: "await", ids: ["0-Retry"], timeout_ms: 3_600_000 },
			ac.signal,
			spy,
		);
		await Promise.resolve();
		expect(spy).toHaveBeenCalledTimes(1);

		// Only retry timing changed; the approved signature must stay stable.
		manager.recordSubagentProgress("0-Retry", retry(1, 1_000, 900));
		vi.advanceTimersByTime(500);
		expect(spy).toHaveBeenCalledTimes(1);

		// A new attempt is a real rendered-state transition.
		manager.recordSubagentProgress("0-Retry", retry(2, 1_000, 900));
		vi.advanceTimersByTime(500);
		expect(spy).toHaveBeenCalledTimes(2);

		// Recovery clears retry state and emits once.
		manager.recordSubagentProgress("0-Retry", makeProgress({ id: "0-Retry", currentTool: "read" }));
		vi.advanceTimersByTime(500);
		expect(spy).toHaveBeenCalledTimes(3);

		ac.abort();
		control.resolve();
		await pending;
		await manager.dispose({ timeoutMs: 100 });
	});
});

describe("subagent await progress visibility boundary", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
	});

	it("carries live progress in details for the renderer and never in model-visible content", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const jobId = manager.register(
			"task",
			"visibility subagent",
			async () => {
				await Bun.sleep(150);
				return "done";
			},
			{
				id: "job-vis",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-Vis", agent: "executor", agentSource: "bundled" } },
			},
		);
		manager.registerSubagentRecord(runningRecord("0-Vis", jobId));
		manager.recordSubagentProgress(
			"0-Vis",
			makeProgress({
				id: "0-Vis",
				currentTool: "read",
				recentOutput: ["secret-marker-text"],
				toolCount: 7,
				contextTokens: 42_000,
				contextWindow: 200_000,
				lastActivityMs: 1_700_000_000_000,
			}),
		);

		const result = await tool.execute("await", { action: "await", ids: ["0-Vis"], timeout_ms: 5 });

		const snap = result.details?.subagents.find(s => s.id === "0-Vis");
		expect(snap?.progress?.currentTool).toBe("read");
		expect(snap?.progress?.toolCount).toBe(7);
		expect(snap?.progress?.contextTokens).toBe(42_000);
		expect(snap?.progress?.contextWindow).toBe(200_000);
		expect(snap?.progress?.lastActivityMs).toBe(1_700_000_000_000);
		expect(snap?.progress?.recentOutputSummary).toEqual({ lineCount: 1 });

		const modelText = result.content.map(part => ("text" in part ? part.text : "")).join("\n");
		expect(modelText).not.toContain("secret-marker-text");
		expect(modelText).toContain("0-Vis");

		// Tool-result serialization is a public boundary: the approved DTO carries
		// only a count, never the raw marker or any other recent output text.
		const serializedToolResult = JSON.stringify({
			role: "toolResult",
			toolName: "subagent",
			content: result.content,
			details: result.details,
		});
		expect(serializedToolResult).not.toContain("secret-marker-text");

		const acpNotifications = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "call-vis",
				toolName: "subagent",
				result,
				isError: false,
			},
			"session-vis",
		);
		expect(JSON.stringify(acpNotifications)).not.toContain("secret-marker-text");

		const exporter = new InMemorySpanExporter();
		const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
		const telemetry = resolveTelemetry(
			{ tracer: tracerProvider.getTracer("subagent-live-progress-test"), captureMessageContent: true },
			"session-vis",
		);
		const mockModel = createMockModel({ id: "mock-model", provider: "mock-provider", responses: [] }).model;
		const telemetrySpan = startChatSpan(telemetry, mockModel, {
			stepNumber: 0,
			request: {
				messages: [
					{
						role: "toolResult",
						toolCallId: "call-vis",
						toolName: "subagent",
						content: result.content,
						details: result.details,
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
		});
		telemetrySpan?.end();
		await tracerProvider.forceFlush();
		const telemetryInput = exporter.getFinishedSpans()[0]?.attributes[GenAIAttr.InputMessages];
		expect(telemetryInput).toBeDefined();
		expect(String(telemetryInput)).not.toContain("secret-marker-text");
		await tracerProvider.shutdown();

		const theme = (await getThemeByName("red-claw"))!;
		setThemeInstance(theme);
		const rendered = Bun.stripANSI(
			subagentToolRenderer
				.renderResult(result, { expanded: true, isPartial: true, spinnerFrame: 0 }, theme)
				.render(160)
				.join("\n"),
		);
		expect(rendered).toContain("read");
		expect(rendered).toContain("recent output available (1 line)");
		expect(rendered).not.toContain("secret-marker-text");

		const staleResult = {
			...result,
			details: {
				...result.details,
				subagents: result.details!.subagents.map(snapshot => ({
					...snapshot,
					liveProgressAvailable: false,
				})),
			},
		};
		const staleRendered = Bun.stripANSI(
			subagentToolRenderer
				.renderResult(staleResult, { expanded: true, isPartial: true, spinnerFrame: 0 }, theme)
				.render(160)
				.join("\n"),
		);
		expect(staleRendered).not.toContain("recent output available");
		expect(staleRendered).not.toContain("read");

		manager.cancelSubagent("0-Vis", { ownerId: "0-Main" });
		await manager.dispose({ timeoutMs: 100 });
	});
});
