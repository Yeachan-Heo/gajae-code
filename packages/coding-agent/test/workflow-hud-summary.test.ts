import { describe, expect, it } from "bun:test";
import {
	buildDeepInterviewHudSummary,
	buildRalplanHudSummary,
	buildTeamHudSummary,
	buildUltragoalHudSummary,
} from "../src/skill-state/workflow-hud";

describe("workflow HUD summary builders", () => {
	it("builds deep-interview progress chips", () => {
		const hud = buildDeepInterviewHudSummary({
			phase: "interviewing",
			ambiguity: 0.15,
			threshold: 0.2,
			roundCount: 7,
			targetComponent: "Team HUD",
			weakestDimension: "criteria",
		});
		expect(hud.chips?.map(chip => `${chip.label}:${chip.value}`)).toEqual([
			"phase:interviewing",
			"ambiguity:15%/20%",
			"round:7",
			"target:Team HUD",
			"weakest:criteria",
		]);
	});

	it("builds ralplan stage and verdict chips", () => {
		const hud = buildRalplanHudSummary({
			stage: "critic",
			waiting: "critic",
			iteration: 2,
			verdict: "ITERATE",
			latestSummary: "needs revision",
			pendingApproval: true,
		});
		expect(hud.summary).toBe("needs revision");
		expect(hud.chips?.find(chip => chip.label === "verdict")?.severity).toBe("warning");
		expect(hud.chips?.[0]).toEqual({ label: "pending", value: "approval", priority: 5, severity: "warning" });
	});

	it("keeps ultragoal latest ledger event in details only", () => {
		const hud = buildUltragoalHudSummary({
			status: "blocked",
			currentGoal: { id: "G001", title: "Build HUD", status: "blocked" },
			counts: { complete: 1, blocked: 1, review_blocked: 0, failed: 0 },
			goals: [
				{ id: "G001", title: "Build HUD", status: "blocked" },
				{ id: "G002", title: "Verify", status: "complete" },
			],
			latestLedgerEvent: { event: "goal_checkpointed", goalId: "G001" },
		});
		expect(hud.chips?.some(chip => chip.label === "ledger")).toBe(false);
		expect(hud.details?.[0]?.label).toBe("ledger");
		expect(hud.chips?.[0]?.severity).toBe("blocked");
	});

	it("prioritizes team blockers before progress and latest activity", () => {
		const hud = buildTeamHudSummary({
			phase: "running",
			task_total: 3,
			task_counts: { completed: 1, failed: 1, blocked: 0 },
			workers: [
				{ id: "worker-1", status: "busy" },
				{ id: "worker-2", status: "failed" },
			],
			latestEvent: { type: "message", message: "working" },
		});
		expect(hud.chips?.[0]).toEqual({ label: "blocked", value: "2", priority: 5, severity: "blocked" });
		expect(hud.chips?.map(chip => chip.label)).toEqual(["blocked", "phase", "workers", "tasks", "latest"]);
	});
});
