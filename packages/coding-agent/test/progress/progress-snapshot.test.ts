import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { UltragoalGoalStatus } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { buildSessionProjectProgress } from "@gajae-code/coding-agent/progress/collect-project-progress";
import {
	PROGRESS_SNAPSHOT_LIMITS,
	PROJECT_PROGRESS_SNAPSHOT_SCHEMA,
	type ProjectProgressSnapshot,
} from "@gajae-code/coding-agent/progress/progress-contract";
import { toProjectProgressSnapshot } from "@gajae-code/coding-agent/progress/progress-snapshot";
import { computeProjectProgress, type ProjectProgressInput } from "@gajae-code/coding-agent/progress/project-progress";
import { CursorRegistry } from "@gajae-code/coding-agent/sdk/host/query/cursor";
import { QueryHandlers, type SessionSurface } from "@gajae-code/coding-agent/sdk/host/query/handlers";
import { RevisionStore } from "@gajae-code/coding-agent/sdk/host/query/revision-store";
import { createSdkSurfacePolicy } from "@gajae-code/coding-agent/sdk/host/surface-policy";
import { findOperation } from "@gajae-code/coding-agent/sdk/protocol/operation-registry";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { renderProgressReportLines } from "@gajae-code/coding-agent/slash-commands/helpers/progress-report";
import { type TodoPhase, USER_TODO_EDIT_CUSTOM_TYPE } from "@gajae-code/coding-agent/tools/todo-write";
import { TempDir } from "@gajae-code/utils";

function input(overrides: Partial<ProjectProgressInput> = {}): ProjectProgressInput {
	return {
		todos: [],
		workflows: [],
		subagents: [],
		sessionStateRead: true,
		unreadable: [],
		recovered: [],
		discarded: [],
		unresolved: [],
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
		expect(snapshot.sources).toEqual({
			sessionStateRead: true,
			unreadable: [],
			recovered: [],
			discarded: [],
			unresolved: [],
		});
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
		const sessionManager = { getCwd: () => tempDir.path(), getSessionId: () => sessionId, getBranch: () => [] };
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

describe("session.progress on a resumed session reads durable todo history", () => {
	let tempDir: TempDir;
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];
	beforeEach(() => {
		tempDir = TempDir.createSync("@gjc-progress-resume-");
	});
	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		tempDir.removeSync();
	});

	const terminalOnly: TodoPhase[] = [
		{
			name: "Build",
			tasks: [
				{ content: "design schema", status: "completed" },
				{ content: "legacy importer", status: "abandoned" },
			],
		},
	];
	const mixed: TodoPhase[] = [
		...terminalOnly,
		{
			name: "Ship",
			tasks: [
				{ content: "wire query", status: "in_progress" },
				{ content: "write docs", status: "pending" },
			],
		},
	];

	/** Persist a successful `todo_write` call exactly as the tool records it on the branch. */
	function persistTodoWrite(manager: SessionManager, toolCallId: string, phases: TodoPhase[]): void {
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "todo_write", arguments: { ops: [] } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			stopReason: "toolUse",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "todo_write",
			content: [{ type: "text", text: "todos updated" }],
			details: { phases },
			isError: false,
			timestamp: Date.now(),
		});
	}

	/** Write a session to disk, close it, and resume it into a real `AgentSession`. */
	async function resume(record: (manager: SessionManager) => void): Promise<AgentSession> {
		const root = tempDir.path();
		const original = SessionManager.create(root, path.join(root, "sessions"));
		original.appendMessage({ role: "user", content: "plan the work", timestamp: Date.now() });
		record(original);
		await original.ensureOnDisk();
		await original.flush();
		const sessionFile = original.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		await original.close();

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found in registry");
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent: new Agent({ getApiKey: () => "test", initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager: await SessionManager.open(sessionFile),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessions.push(session);
		return session;
	}

	/** Q32 through the query dispatcher, bound the way `modes/runtime-init.ts` binds it. */
	async function queryProgress(session: AgentSession): Promise<ProjectProgressSnapshot> {
		const source = surface(async () =>
			toProjectProgressSnapshot(await buildSessionProjectProgress(session, session.sessionManager)),
		);
		const response = await dispatch(source, "session.progress");
		expect(response.ok).toBe(true);
		const [snapshot] = response.page?.items ?? [];
		return snapshot as ProjectProgressSnapshot;
	}

	it("counts completed and abandoned items alongside open ones", async () => {
		const session = await resume(manager => persistTodoWrite(manager, "todo-1", mixed));
		// Resume strips terminal items from the live list; progress must not inherit that.
		expect(session.getTodoPhases()).toEqual([mixed[1]]);

		const snapshot = await queryProgress(session);
		expect(snapshot.state).toBe("in-progress");
		expect(snapshot.completion).toMatchObject({ basis: "todos", done: 1, total: 3, percent: 33 });
		expect(snapshot.execution.todos).toEqual({
			counts: { total: 3, completed: 1, inProgress: 1, pending: 1, abandoned: 1 },
			items: [
				{ content: "design schema", status: "completed" },
				{ content: "legacy importer", status: "abandoned" },
				{ content: "wire query", status: "in_progress" },
				{ content: "write docs", status: "pending" },
			],
			omittedItems: 0,
		});
		expect(snapshot.activeWork.todo).toBe("wire query");
	});

	it("reports an all-terminal todo list as finished work, not as no tracked work", async () => {
		const session = await resume(manager => persistTodoWrite(manager, "todo-1", terminalOnly));
		expect(session.getTodoPhases()).toEqual([]);

		const snapshot = await queryProgress(session);
		expect(snapshot.state).toBe("complete");
		expect(snapshot.completion).toMatchObject({ basis: "todos", done: 1, total: 1, percent: 100, complete: true });
		expect(snapshot.execution.todos?.counts).toEqual({
			total: 1,
			completed: 1,
			inProgress: 0,
			pending: 0,
			abandoned: 1,
		});
	});

	it("treats a persisted empty list as authoritative over unpersisted live state", async () => {
		const session = await resume(manager => {
			persistTodoWrite(manager, "todo-1", mixed);
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
		});
		session.setTodoPhases([{ name: "Live", tasks: [{ content: "never persisted", status: "pending" }] }]);

		const snapshot = await queryProgress(session);
		expect(snapshot.state).toBe("no-tracked-work");
		expect(snapshot.completion).toMatchObject({ basis: "none", total: 0, percent: null });
		expect(snapshot.execution.todos).toBeNull();
		expect(snapshot.activeWork.todo).toBeNull();
	});

	it("falls back to live todo state only when no todo state was ever persisted", async () => {
		const session = await resume(() => {});
		session.setTodoPhases([{ name: "Live", tasks: [{ content: "live only", status: "in_progress" }] }]);

		const snapshot = await queryProgress(session);
		expect(snapshot.completion).toMatchObject({ basis: "todos", done: 0, total: 1 });
		expect(snapshot.execution.todos?.items).toEqual([{ content: "live only", status: "in_progress" }]);
		expect(snapshot.activeWork.todo).toBe("live only");
	});
});
