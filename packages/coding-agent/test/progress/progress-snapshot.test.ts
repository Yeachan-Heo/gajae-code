import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { UltragoalGoalStatus } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { buildSessionProjectProgress } from "@gajae-code/coding-agent/progress/collect-project-progress";
import {
	PROGRESS_SNAPSHOT_LIMITS,
	PROJECT_PROGRESS_SNAPSHOT_SCHEMA,
} from "@gajae-code/coding-agent/progress/progress-contract";
import { toProjectProgressSnapshot } from "@gajae-code/coding-agent/progress/progress-snapshot";
import { computeProjectProgress, type ProjectProgressInput } from "@gajae-code/coding-agent/progress/project-progress";
import { CursorRegistry } from "@gajae-code/coding-agent/sdk/host/query/cursor";
import { QueryHandlers, type SessionSurface } from "@gajae-code/coding-agent/sdk/host/query/handlers";
import { RevisionStore } from "@gajae-code/coding-agent/sdk/host/query/revision-store";
import { createSdkSurfacePolicy } from "@gajae-code/coding-agent/sdk/host/surface-policy";
import { findOperation } from "@gajae-code/coding-agent/sdk/protocol/operation-registry";
import { renderProgressReportLines } from "@gajae-code/coding-agent/slash-commands/helpers/progress-report";
import { TempDir } from "@gajae-code/utils";

function input(overrides: Partial<ProjectProgressInput> = {}): ProjectProgressInput {
	return {
		todos: [],
		workflows: [],
		subagents: [],
		sessionStateRead: true,
		unreadable: [],
		recovered: [],
		...overrides,
	};
}

function story(id: string, status: UltragoalGoalStatus, receipt = false) {
	return { id, title: `Story ${id}`, status, hasVerificationReceipt: receipt };
}

describe("toProjectProgressSnapshot", () => {
	it("re-shapes the same report the /progress view renders, field for field", () => {
		const report = computeProjectProgress(
			input({
				goal: { objective: "Ship progress", status: "active", timeUsedSeconds: 120 },
				ultragoal: {
					objective: "Ship",
					stories: [
						story("G1", "complete", true),
						story("G2", "complete"),
						story("G3", "active"),
						story("G4", "blocked"),
						story("G5", "superseded"),
					],
				},
				todos: [
					{ content: "wire query", status: "in_progress" },
					{ content: "docs", status: "pending" },
				],
				workflows: [
					{
						skill: "ralplan",
						phase: "final",
						chips: [{ label: "verdict", value: "APPROVE", severity: "success" }],
					},
				],
				subagents: ["running", "completed", "failed"],
			}),
		);
		const snapshot = toProjectProgressSnapshot(report);
		const human = renderProgressReportLines(report).join("\n");

		expect(snapshot.schema).toBe(PROJECT_PROGRESS_SNAPSHOT_SCHEMA);
		expect(snapshot.state).toBe(report.headline);
		expect(snapshot.state).toBe("blocked");
		expect(human).toContain("Blocked");
		expect(snapshot.completion).toEqual({
			basis: "ultragoal-stories",
			done: 2,
			total: 4,
			percent: 50,
			allUnitsDone: false,
			complete: false,
			explanation: report.basisExplanation,
		});
		expect(human).toContain("~50%  2 of 4 ultragoal stories complete");
		expect(snapshot.execution.ultragoal?.counts).toEqual({
			total: 4,
			complete: 2,
			active: 1,
			pending: 0,
			blocked: 1,
			superseded: 1,
		});
		expect(snapshot.execution.ultragoal?.stories.map(s => [s.id, s.status, s.verificationReceipt])).toEqual([
			["G1", "complete", true],
			["G2", "complete", false],
			["G3", "active", false],
			["G4", "blocked", false],
			["G5", "superseded", false],
		]);
		expect(snapshot.execution.todos?.counts).toEqual({
			total: 2,
			completed: 0,
			inProgress: 1,
			pending: 1,
			abandoned: 0,
		});
		expect(snapshot.activeWork.story).toEqual({ id: "G3", title: "Story G3" });
		expect(snapshot.activeWork.todo).toBe("wire query");
		expect(snapshot.activeWork.agents).toEqual({
			total: 3,
			running: 1,
			waiting: 0,
			completed: 1,
			failed: 1,
			cancelled: 0,
		});
		expect(snapshot.verification).toEqual({
			storyReceipts: { complete: 2, withReceipt: 1, withoutReceipt: 1 },
			reviewVerdicts: [{ skill: "ralplan", verdict: "APPROVE" }],
		});
		expect(snapshot.attention.map(item => [item.kind, item.source, item.ref])).toEqual(
			report.signals.map(signal => [signal.kind, signal.source, signal.ref ?? null]),
		);
		expect(snapshot.attention[0]).toEqual({
			kind: "blocker",
			source: "ultragoal",
			ref: "G4",
			text: "Story G4 is blocked: Story G4",
		});
		expect(snapshot.sources).toEqual({ sessionStateRead: true, unreadable: [], recovered: [] });
		// The snapshot is plain JSON: no undefined holes for wire clients.
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
	});

	it("reports null rather than a guessed percent when nothing is countable", () => {
		const snapshot = toProjectProgressSnapshot(
			computeProjectProgress(input({ sessionStateRead: false, unreadable: [] })),
		);
		expect(snapshot.state).toBe("no-tracked-work");
		expect(snapshot.completion).toMatchObject({ basis: "none", done: 0, total: 0, percent: null, complete: false });
		expect(snapshot.execution).toEqual({ goal: null, ultragoal: null, todos: null });
		expect(snapshot.verification).toEqual({ storyReceipts: null, reviewVerdicts: [] });
		expect(snapshot.activeWork).toMatchObject({ story: null, todo: null, workflows: [] });
		expect(snapshot.sources.sessionStateRead).toBe(false);
	});

	it("distinguishes all units done from complete while the goal is still open", () => {
		const snapshot = toProjectProgressSnapshot(
			computeProjectProgress(
				input({
					todos: [{ content: "a", status: "completed" }],
					goal: { objective: "x", status: "active", timeUsedSeconds: 0 },
				}),
			),
		);
		expect(snapshot.state).toBe("awaiting-completion");
		expect(snapshot.completion).toMatchObject({ percent: 100, allUnitsDone: true, complete: false });
		expect(snapshot.attention).toContainEqual(expect.objectContaining({ kind: "pending", source: "goal" }));
	});

	it("keys unreadable sources stably and excludes them from counts", () => {
		const snapshot = toProjectProgressSnapshot(
			computeProjectProgress(input({ unreadable: ["ultragoal-plan", "workflow-state"] })),
		);
		expect(snapshot.sources.unreadable).toEqual(["ultragoal-plan", "workflow-state"]);
		expect(snapshot.attention.map(item => [item.source, item.ref])).toEqual([
			["state", "ultragoal-plan"],
			["state", "workflow-state"],
		]);
		expect(snapshot.completion.basis).toBe("none");
	});

	it("reports workflows beyond the bound as omitted instead of silently truncating", () => {
		const workflows = (count: number) =>
			Array.from({ length: count }, (_, index) => ({ skill: `wf-${index}`, phase: `phase-${index}`, chips: [] }));
		const atLimit = toProjectProgressSnapshot(
			computeProjectProgress(input({ workflows: workflows(PROGRESS_SNAPSHOT_LIMITS.workflows) })),
		);
		expect(atLimit.activeWork.workflows).toHaveLength(PROGRESS_SNAPSHOT_LIMITS.workflows);
		expect(atLimit.activeWork.omittedWorkflows).toBe(0);

		const report = computeProjectProgress(input({ workflows: workflows(PROGRESS_SNAPSHOT_LIMITS.workflows + 1) }));
		const snapshot = toProjectProgressSnapshot(report);
		expect(snapshot.activeWork.workflows).toHaveLength(PROGRESS_SNAPSHOT_LIMITS.workflows);
		expect(snapshot.activeWork.workflows.at(-1)?.skill).toBe(`wf-${PROGRESS_SNAPSHOT_LIMITS.workflows - 1}`);
		expect(snapshot.activeWork.omittedWorkflows).toBe(1);
		const human = renderProgressReportLines(report).join("\n");
		expect(human).toContain(`wf-${PROGRESS_SNAPSHOT_LIMITS.workflows - 1}: phase-`);
		expect(human).not.toContain(`wf-${PROGRESS_SNAPSHOT_LIMITS.workflows}:`);
		expect(human).toContain("… 1 more active workflow not shown");
	});

	it("bounds list sizes with explicit omission counts and strips terminal control text", () => {
		const stories = Array.from({ length: PROGRESS_SNAPSHOT_LIMITS.stories + 7 }, (_, index) =>
			story(`G${index}`, "pending"),
		);
		const snapshot = toProjectProgressSnapshot(
			computeProjectProgress(
				input({
					goal: {
						objective: `evil\u001b[31m\nobjective\t${"x".repeat(1000)}`,
						status: "active",
						timeUsedSeconds: 0,
					},
					ultragoal: { objective: "x", stories },
				}),
			),
		);
		expect(snapshot.execution.ultragoal?.stories).toHaveLength(PROGRESS_SNAPSHOT_LIMITS.stories);
		expect(snapshot.execution.ultragoal?.omittedStories).toBe(7);
		expect(snapshot.execution.ultragoal?.counts.total).toBe(PROGRESS_SNAPSHOT_LIMITS.stories + 7);
		const objective = snapshot.execution.goal?.objective ?? "";
		expect(objective.startsWith("evil objective xxx")).toBe(true);
		expect(objective).toHaveLength(PROGRESS_SNAPSHOT_LIMITS.text);
		expect(objective).not.toMatch(/[\u0000-\u001f]/);
	});
});

function surface(getProjectProgress: SessionSurface["getProjectProgress"]): SessionSurface {
	return {
		getTranscriptEntries: () => [],
		getContextSnapshot: () => ({}),
		getGoalState: () => undefined,
		getTodoState: () => [],
		getDiff: () => [],
		getUsage: () => ({}),
		getModels: () => [],
		getSkillState: () => [],
		getGates: () => [],
		getConfigItems: () => [],
		getSessionMetadata: () => ({}),
		getStats: () => ({}),
		getBranchCandidates: () => [],
		getLastAssistant: () => undefined,
		getCapabilities: () => ({}),
		getAuthProviders: () => [],
		getTools: () => [],
		getQueueMessages: () => [],
		getExtensions: () => [],
		getJobs: () => [],
		...(getProjectProgress ? { getProjectProgress } : {}),
	};
}

function dispatch(source: SessionSurface, query: string, requestInput?: Record<string, unknown>) {
	const revisions = new RevisionStore("session");
	const handlers = new QueryHandlers(source, "session", revisions, new CursorRegistry("token", revisions));
	return handlers.dispatch({ query, connectionId: "connection", ...(requestInput ? { input: requestInput } : {}) });
}

describe("session.progress SDK query (Q32)", () => {
	let tempDir: TempDir;
	beforeEach(() => {
		tempDir = TempDir.createSync("@gjc-progress-sdk-");
	});
	afterEach(() => {
		tempDir.removeSync();
	});

	it("is a read-only, idempotent query exposed to ACP, MCP, and the daemon CLI", () => {
		const operation = findOperation("query", "session.progress");
		expect(operation).toMatchObject({ id: "Q32", kind: "query", idempotency: "idempotent" });
		expect(operation?.adapterDispositions).toMatchObject({
			acp: "generic_safe",
			mcp: "generic_safe",
			daemonCli: "generic_safe",
			telegram: "prohibited",
		});
	});

	it("is advertised only when the session binds a progress source", () => {
		const bound = createSdkSurfacePolicy({ bindings: ["getProjectProgress"], workflowGateAvailable: false });
		const unbound = createSdkSurfacePolicy({ bindings: [], workflowGateAvailable: false });
		expect(bound.installedQueries.has("session.progress")).toBe(true);
		expect(unbound.installedQueries.has("session.progress")).toBe(false);
	});

	it("returns the session snapshot from durable plan state by name and by id", async () => {
		const sessionId = "sess-sdk";
		await Bun.write(
			path.join(tempDir.path(), ".gjc", `_session-${sessionId}`, "ultragoal", "goals.json"),
			JSON.stringify({
				version: 1,
				brief: "b",
				gjcObjective: "Ship",
				goals: [
					{ id: "G1", title: "One", status: "complete", completionVerification: { receiptId: "r1" } },
					{ id: "G2", title: "Two", status: "active" },
				],
			}),
		);
		const session = {
			getGoalModeState: () => undefined,
			getTodoPhases: () => [],
			getSubagentLifecycleStatuses: () => [],
		};
		const sessionManager = { getCwd: () => tempDir.path(), getSessionId: () => sessionId };
		const source = surface(async () =>
			toProjectProgressSnapshot(await buildSessionProjectProgress(session, sessionManager)),
		);

		for (const query of ["session.progress", "Q32"]) {
			const response = await dispatch(source, query);
			expect(response.ok).toBe(true);
			expect(response.page?.complete).toBe(true);
			const [snapshot] = response.page?.items ?? [];
			expect(snapshot).toMatchObject({
				schema: PROJECT_PROGRESS_SNAPSHOT_SCHEMA,
				state: "in-progress",
				completion: { basis: "ultragoal-stories", done: 1, total: 2, percent: 50 },
				activeWork: { story: { id: "G2", title: "Two" } },
				verification: { storyReceipts: { complete: 1, withReceipt: 1, withoutReceipt: 0 } },
				sources: { sessionStateRead: true, unreadable: [] },
			});
		}
	});

	it("rejects input fields and reports unavailable when the session has no progress source", async () => {
		const withSource = surface(async () => toProjectProgressSnapshot(computeProjectProgress(input())));
		expect(await dispatch(withSource, "session.progress", { goalId: "G1" })).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		expect(await dispatch(surface(undefined), "session.progress")).toMatchObject({
			ok: false,
			error: { code: "unavailable" },
		});
	});
});
