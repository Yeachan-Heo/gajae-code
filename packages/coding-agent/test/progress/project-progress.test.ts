import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { activeEntryPath, activeSnapshotPath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import type { UltragoalGoalStatus } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { acpProgressReportText } from "@gajae-code/coding-agent/modes/acp/acp-agent";
import {
	buildSessionProjectProgress,
	collectProjectProgressInput,
} from "@gajae-code/coding-agent/progress/collect-project-progress";
import { toProjectProgressSnapshot } from "@gajae-code/coding-agent/progress/progress-snapshot";
import {
	computeProjectProgress,
	displayPercent,
	type ProjectProgressInput,
} from "@gajae-code/coding-agent/progress/project-progress";
import {
	readVisibleSkillActiveState,
	readVisibleSkillActiveStateWithStatus,
} from "@gajae-code/coding-agent/skill-state/active-state";
import { executeAcpBuiltinSlashCommand } from "@gajae-code/coding-agent/slash-commands/acp-builtins";
import { renderProgressReportLines } from "@gajae-code/coding-agent/slash-commands/helpers/progress-report";
import type { SlashCommandRuntime } from "@gajae-code/coding-agent/slash-commands/types";
import { TempDir } from "@gajae-code/utils";

const SESSION_ID = "sess-progress";

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

describe("displayPercent", () => {
	it("never reports 100 while a unit is open nor 0 once a unit is done", () => {
		expect(displayPercent(199, 200)).toBe(99);
		expect(displayPercent(1, 200)).toBe(1);
		expect(displayPercent(200, 200)).toBe(100);
		expect(displayPercent(0, 3)).toBe(0);
		expect(displayPercent(3, 5)).toBe(60);
		expect(displayPercent(0, 0)).toBeUndefined();
	});
});

describe("computeProjectProgress", () => {
	it("measures ultragoal stories, excludes superseded ones, and surfaces blockers and receipts", () => {
		const report = computeProjectProgress(
			input({
				ultragoal: {
					objective: "Ship it",
					stories: [
						story("G1", "complete", true),
						story("G2", "complete"),
						story("G3", "active"),
						story("G4", "review_blocked"),
						story("G5", "superseded"),
					],
				},
				todos: [{ content: "write tests", status: "in_progress" }],
			}),
		);
		expect(report.completion).toEqual({ basis: "ultragoal-stories", done: 2, total: 4, percent: 50 });
		expect(report.headline).toBe("blocked");
		expect(report.stories?.current).toEqual({ id: "G3", title: "Story G3" });
		expect(report.verification).toEqual({ storyReceipts: { complete: 2, withReceipt: 1 }, reviewVerdicts: [] });
		expect(renderProgressReportLines(report).join("\n")).toContain(
			"1 of 2 complete stories carry a recorded quality-gate receipt",
		);
		expect(report.signals.map(signal => [signal.kind, signal.source, signal.ref])).toEqual([
			["blocker", "ultragoal", "G4"],
			["note", "todos", undefined],
		]);
		expect(report.signals[0]?.text).toContain("G4 is review blocked");
	});

	it("falls back to todos and excludes abandoned items", () => {
		const report = computeProjectProgress(
			input({
				todos: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "in_progress" },
					{ content: "c", status: "abandoned" },
				],
			}),
		);
		expect(report.completion).toEqual({ basis: "todos", done: 1, total: 2, percent: 50 });
		expect(report.todos?.current).toBe("b");
		expect(report.headline).toBe("in-progress");
	});

	it("reports an unknown indicator instead of guessing when nothing is countable", () => {
		const report = computeProjectProgress(
			input({ goal: { objective: "Refactor auth", status: "active", timeUsedSeconds: 3600 } }),
		);
		expect(report.completion.percent).toBeUndefined();
		expect(report.completion.basis).toBe("none");
		expect(report.headline).toBe("in-progress");
		const text = renderProgressReportLines(report).join("\n");
		expect(text).toContain("unknown");
		expect(text).not.toMatch(/\d+%/);
	});

	it("does not claim completion while the goal is open or subagents are running, queued, or paused", () => {
		const todos = [{ content: "a", status: "completed" as const }];
		const goalOpen = computeProjectProgress(
			input({ todos, goal: { objective: "x", status: "active", timeUsedSeconds: 0 } }),
		);
		expect(goalOpen.completion.percent).toBe(100);
		expect(goalOpen.headline).toBe("awaiting-completion");
		expect(goalOpen.signals.some(signal => signal.text.includes("not marked complete"))).toBe(true);

		const agentsRunning = computeProjectProgress(input({ todos, subagents: ["running", "completed"] }));
		expect(agentsRunning.headline).toBe("awaiting-completion");
		expect(agentsRunning.agents).toMatchObject({ total: 2, running: 1, completed: 1 });

		const goalComplete = { objective: "x", status: "complete" as const, timeUsedSeconds: 0 };
		for (const status of ["queued", "paused"] as const) {
			const deferred = computeProjectProgress(
				input({ todos, goal: goalComplete, subagents: [status, "completed"] }),
			);
			expect(deferred.headline).toBe("awaiting-completion");
			expect(deferred.agents).toMatchObject({ total: 2, running: 0, waiting: 1, completed: 1 });
			const snapshot = toProjectProgressSnapshot(deferred);
			expect(snapshot.completion).toMatchObject({ allUnitsDone: true, complete: false });
			expect(snapshot.attention).toContainEqual({
				kind: "pending",
				source: "subagents",
				ref: null,
				text: "1 subagent still running, queued, or paused; their work counts only once it is recorded in the plan or todos.",
			});
		}

		expect(computeProjectProgress(input({ todos })).headline).toBe("complete");
	});

	it("treats a completed goal without finer state as complete and a dropped goal as dropped", () => {
		const complete = computeProjectProgress(
			input({ goal: { objective: "x", status: "complete", timeUsedSeconds: 0 } }),
		);
		expect(complete.completion).toEqual({ basis: "goal-status", done: 1, total: 1, percent: 100 });
		expect(complete.headline).toBe("complete");
		const dropped = computeProjectProgress(
			input({ goal: { objective: "x", status: "dropped", timeUsedSeconds: 0 } }),
		);
		expect(dropped.headline).toBe("dropped");
	});

	it("maps workflow HUD severities to signals and verdict chips to verification", () => {
		const report = computeProjectProgress(
			input({
				workflows: [
					{
						skill: "ralplan",
						phase: "critic",
						chips: [
							{ label: "pending", value: "approval", severity: "warning" },
							{ label: "verdict", value: "APPROVE", severity: "success" },
						],
					},
				],
			}),
		);
		expect(report.headline).toBe("in-progress");
		expect(report.signals).toEqual([
			{ kind: "pending", source: "workflow", ref: "ralplan", text: "ralplan: pending approval" },
		]);
		expect(report.verification).toEqual({ reviewVerdicts: [{ skill: "ralplan", verdict: "APPROVE" }] });
	});

	it("reports a blocked ultragoal story once even though the ultragoal HUD also flags it", () => {
		const report = computeProjectProgress(
			input({
				ultragoal: { objective: "x", stories: [story("G001", "active"), story("G002", "blocked")] },
				workflows: [
					{
						skill: "ultragoal",
						phase: "active",
						chips: [
							{ label: "blocked", value: "1", severity: "blocked" },
							{ label: "goals", value: "0/2" },
						],
					},
				],
			}),
		);
		expect(report.headline).toBe("blocked");
		expect(report.signals).toEqual([
			{ kind: "blocker", source: "ultragoal", ref: "G002", text: "Story G002 is blocked: Story G002" },
		]);
	});

	it("never points at blocked, review-blocked, or failed stories as the next story", () => {
		const nextOf = (...statuses: UltragoalGoalStatus[]) =>
			computeProjectProgress(
				input({
					ultragoal: { objective: "x", stories: statuses.map((status, index) => story(`G${index + 1}`, status)) },
				}),
			);
		// The reviewer's case: no active story, plan ordered [blocked, pending].
		const blockedFirst = nextOf("blocked", "pending");
		expect(blockedFirst.stories?.current).toEqual({ id: "G2", title: "Story G2" });
		expect(toProjectProgressSnapshot(blockedFirst).activeWork.story).toEqual({ id: "G2", title: "Story G2" });
		expect(renderProgressReportLines(blockedFirst).join("\n")).toContain("next: G2 Story G2");
		// The blocker is still reported; it just is not the next schedulable story.
		expect(blockedFirst.signals[0]).toMatchObject({ kind: "blocker", ref: "G1" });

		expect(nextOf("review_blocked", "failed", "pending").stories?.current?.id).toBe("G3");
		expect(nextOf("pending", "active").stories?.current?.id).toBe("G2");

		// Failed stories are retried only on an explicit `--retry-failed`, which a read-only view never requests.
		const nothingSchedulable = nextOf("complete", "blocked", "review_blocked", "failed", "superseded");
		expect(nothingSchedulable.stories?.current).toBeUndefined();
		expect(toProjectProgressSnapshot(nothingSchedulable).activeWork.story).toBeNull();
		expect(renderProgressReportLines(nothingSchedulable).join("\n")).not.toContain("next:");
		expect(nothingSchedulable.headline).toBe("blocked");
	});

	it("sanitizes untrusted durable text to single display lines", () => {
		const report = computeProjectProgress(
			input({ goal: { objective: "line one\nline two\t\u001b[31mred", status: "active", timeUsedSeconds: 90 } }),
		);
		const goalLine = renderProgressReportLines(report).find(line => line.startsWith("Goal"));
		expect(goalLine).toBe("Goal          active · 1m · line one line two red");
	});
});

describe("collectProjectProgressInput", () => {
	let tempDir: TempDir;
	beforeEach(() => {
		tempDir = TempDir.createSync("@gjc-progress-");
	});
	afterEach(() => {
		tempDir.removeSync();
	});

	const goalsPath = () => path.join(tempDir.path(), ".gjc", `_session-${SESSION_ID}`, "ultragoal", "goals.json");
	const view = (sessionId: string | undefined = SESSION_ID) => ({
		cwd: tempDir.path(),
		sessionId,
		goal: undefined,
		todoPhases: [{ name: "P1", tasks: [{ content: "t", status: "pending" as const }] }],
		subagents: ["failed" as const],
	});

	it("reads ultragoal stories and verification receipts from the session plan", async () => {
		await Bun.write(
			goalsPath(),
			JSON.stringify({
				version: 1,
				brief: "b",
				gjcObjective: "Ship",
				goals: [
					{ id: "G1", title: "One", status: "complete", completionVerification: { receiptId: "r1" } },
					{ id: "G2", title: "Two", status: "pending" },
				],
			}),
		);
		const collected = await collectProjectProgressInput(view());
		expect(collected.ultragoal?.stories).toEqual([
			{ id: "G1", title: "One", status: "complete", hasVerificationReceipt: true },
			{ id: "G2", title: "Two", status: "pending", hasVerificationReceipt: false },
		]);
		expect(collected.todos).toEqual([{ content: "t", status: "pending" }]);
		expect(collected.subagents).toEqual(["failed"]);
		expect(collected.unreadable).toEqual([]);
		expect(collected.sessionStateRead).toBe(true);
	});

	it("reports a corrupt plan as unreadable instead of failing or guessing", async () => {
		await Bun.write(goalsPath(), "{not json");
		const collected = await collectProjectProgressInput(view());
		expect(collected.ultragoal).toBeUndefined();
		expect(collected.unreadable).toEqual(["ultragoal-plan"]);
		const report = computeProjectProgress(collected);
		expect(report.completion.basis).toBe("todos");
		expect(report.signals.some(signal => signal.text.startsWith("Ultragoal plan could not be read"))).toBe(true);
	});

	const snapshotPath = () => activeSnapshotPath(tempDir.path(), SESSION_ID);
	const ralplanEntry = { skill: "ralplan", phase: "critic", active: true, session_id: SESSION_ID };

	it("reports a corrupt legacy root-only workflow record as unreadable, not as no active workflows", async () => {
		// Legacy root-only record (no per-skill active/<skill>.json entry), truncated on disk.
		await Bun.write(snapshotPath(), '{"active": true, "skill": "ralplan", "phase": "crit');
		// The tolerant HUD/guard reader keeps its semantics: unreadable reads as nothing active.
		expect(await readVisibleSkillActiveState(tempDir.path(), SESSION_ID)).toBeNull();
		expect(await readVisibleSkillActiveStateWithStatus(tempDir.path(), SESSION_ID)).toEqual({
			status: "failed",
			state: null,
		});

		const collected = await collectProjectProgressInput(view());
		expect(collected.workflows).toEqual([]);
		expect(collected.unreadable).toEqual(["workflow-state"]);
		expect(collected.recovered).toEqual([]);
		const snapshot = toProjectProgressSnapshot(computeProjectProgress(collected));
		expect(snapshot.sources).toEqual({
			sessionStateRead: true,
			unreadable: ["workflow-state"],
			recovered: [],
			discarded: [],
			unresolved: [],
		});
		expect(snapshot.attention).toContainEqual({
			kind: "note",
			source: "state",
			ref: "workflow-state",
			text: "Workflow state could not be read and is excluded from the estimate.",
		});
		const human = renderProgressReportLines(computeProjectProgress(collected)).join("\n");
		expect(human).toContain("unknown: workflow state could not be read");
		expect(human).not.toContain("none active");
	});

	it("reports a non-object or I/O-failing workflow snapshot as unreadable", async () => {
		await Bun.write(snapshotPath(), "42");
		expect((await collectProjectProgressInput(view())).unreadable).toEqual(["workflow-state"]);
		await fs.rm(snapshotPath());
		await fs.mkdir(snapshotPath(), { recursive: true }); // EISDIR on read
		expect((await collectProjectProgressInput(view())).unreadable).toEqual(["workflow-state"]);
	});

	it("recovers workflows from authoritative per-skill entries when the snapshot is unreadable", async () => {
		await Bun.write(snapshotPath(), "{not json");
		await Bun.write(activeEntryPath(tempDir.path(), SESSION_ID, "ralplan"), JSON.stringify(ralplanEntry));
		const read = await readVisibleSkillActiveStateWithStatus(tempDir.path(), SESSION_ID);
		expect(read.status).toBe("recovered");
		expect(read.state?.active_skills?.map(entry => [entry.skill, entry.phase])).toEqual([["ralplan", "critic"]]);

		const collected = await collectProjectProgressInput(view());
		expect(collected.workflows.map(workflow => [workflow.skill, workflow.phase])).toEqual([["ralplan", "critic"]]);
		expect(collected.unreadable).toEqual([]);
		expect(collected.recovered).toEqual(["workflow-state"]);
		const snapshot = toProjectProgressSnapshot(computeProjectProgress(collected));
		expect(snapshot.sources).toEqual({
			sessionStateRead: true,
			unreadable: [],
			recovered: ["workflow-state"],
			discarded: [],
			unresolved: [],
		});
		expect(snapshot.attention).toContainEqual(
			expect.objectContaining({ kind: "note", source: "state", ref: "workflow-state" }),
		);
	});

	it("distinguishes absent workflow state from a successful read", async () => {
		expect(await readVisibleSkillActiveStateWithStatus(tempDir.path(), SESSION_ID)).toEqual({
			status: "absent",
			state: null,
		});
		const absent = await collectProjectProgressInput(view());
		expect([absent.workflows, absent.unreadable, absent.recovered]).toEqual([[], [], []]);

		await Bun.write(snapshotPath(), JSON.stringify({ version: 1, active: true, skill: "ralplan", phase: "critic" }));
		expect((await readVisibleSkillActiveStateWithStatus(tempDir.path(), SESSION_ID)).status).toBe("read");
		const legacy = await collectProjectProgressInput(view());
		expect(legacy.workflows.map(workflow => workflow.skill)).toEqual(["ralplan"]);
		expect([legacy.unreadable, legacy.recovered]).toEqual([[], []]);
	});

	it("renders the same plain text through the text-mode dispatcher as production ACP", async () => {
		await Bun.write(
			goalsPath(),
			JSON.stringify({
				version: 1,
				brief: "b",
				gjcObjective: "Ship",
				goals: [
					{ id: "G1", title: "One", status: "complete" },
					{ id: "G2", title: "Two", status: "active" },
				],
			}),
		);
		const output: string[] = [];
		const runtime = {
			session: {
				getGoalModeState: () => undefined,
				getTodoPhases: () => [],
				getSubagentLifecycleStatuses: () => [],
			},
			sessionManager: { getCwd: () => tempDir.path(), getSessionId: () => SESSION_ID, getBranch: () => [] },
			output: (text: string) => {
				output.push(text);
			},
		} as unknown as SlashCommandRuntime;

		await expect(executeAcpBuiltinSlashCommand("/progress", runtime)).resolves.toEqual({ consumed: true });
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("~50%  1 of 2 ultragoal stories complete");
		expect(output[0]).not.toContain("\u001b[");
		const snapshot = toProjectProgressSnapshot(
			await buildSessionProjectProgress(runtime.session, runtime.sessionManager),
		);
		expect(acpProgressReportText({ page: { items: [snapshot], complete: true } })).toBe(output[0]);
	});

	it("reads no workflow state without a session id", async () => {
		await Bun.write(goalsPath(), "{not json");
		const collected = await collectProjectProgressInput({ ...view(), sessionId: undefined });
		expect(collected.ultragoal).toBeUndefined();
		expect(collected.workflows).toEqual([]);
		expect(collected.unreadable).toEqual([]);
		expect(collected.sessionStateRead).toBe(false);
	});
});
