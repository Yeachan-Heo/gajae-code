import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { UltragoalGoalStatus } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { collectProjectProgressInput } from "@gajae-code/coding-agent/progress/collect-project-progress";
import {
	computeProjectProgress,
	displayPercent,
	type ProjectProgressInput,
} from "@gajae-code/coding-agent/progress/project-progress";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@gajae-code/coding-agent/slash-commands/acp-builtins";
import { renderProgressReportLines } from "@gajae-code/coding-agent/slash-commands/helpers/progress-report";
import type { SlashCommandRuntime } from "@gajae-code/coding-agent/slash-commands/types";
import { TempDir } from "@gajae-code/utils";

const SESSION_ID = "sess-progress";

function input(overrides: Partial<ProjectProgressInput> = {}): ProjectProgressInput {
	return { todos: [], workflows: [], subagents: [], sessionStateRead: true, unreadable: [], ...overrides };
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

	it("does not claim completion while the goal is open or subagents are still running", () => {
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

	it("sanitizes untrusted durable text to single display lines", () => {
		const report = computeProjectProgress(
			input({ goal: { objective: "line one\nline two\t\u001b[31mred", status: "active", timeUsedSeconds: 90 } }),
		);
		const goalLine = renderProgressReportLines(report).find(line => line.startsWith("Goal"));
		expect(goalLine).toBe("Goal          active · 1m · line one line two   red");
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

	it("renders plain text through the text-mode builtin dispatcher", async () => {
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
			sessionManager: { getCwd: () => tempDir.path(), getSessionId: () => SESSION_ID },
			output: (text: string) => {
				output.push(text);
			},
		} as unknown as SlashCommandRuntime;

		expect(ACP_BUILTIN_SLASH_COMMANDS.some(command => command.name === "progress")).toBe(true);
		await expect(executeAcpBuiltinSlashCommand("/progress", runtime)).resolves.toEqual({ consumed: true });
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("~50%  1 of 2 ultragoal stories complete");
		expect(output[0]).not.toContain("\u001b[");
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
