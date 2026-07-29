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
	it("renders a normal ralplan automatic handoff target", () => {
		const handoff = buildRalplanHudSummary({
			autoHandoff: {
				configuredTarget: "ultragoal",
				effectiveTarget: "ultragoal",
				degradationReason: null,
			},
		}).chips?.find(chip => chip.label === "handoff");

		expect(handoff).toEqual({
			label: "handoff",
			value: "ultragoal→ultragoal",
			priority: 45,
		});
	});

	it("renders a degraded ralplan automatic handoff target as a warning", () => {
		const handoff = buildRalplanHudSummary({
			autoHandoff: {
				configuredTarget: "team",
				effectiveTarget: "off",
				degradationReason: "team_unavailable:no_tmux_leader",
			},
		}).chips?.find(chip => chip.label === "handoff");

		expect(handoff).toEqual({
			label: "handoff",
			value: "team→off:team_unavailable:no_tmux_leader",
			priority: 45,
			severity: "warning",
		});
	});

	it("makes PLANNING-STUCK dominate a ralplan automatic handoff severity", () => {
		const handoff = buildRalplanHudSummary({
			planningStuck: true,
			autoHandoff: {
				configuredTarget: "ultragoal",
				effectiveTarget: "off",
				degradationReason: "planning_stuck",
			},
		}).chips?.find(chip => chip.label === "handoff");

		expect(handoff).toEqual({
			label: "handoff",
			value: "ultragoal→off:planning_stuck",
			priority: 45,
			severity: "blocked",
		});
	});

	it("renders ralplan iteration-from-index and stage presence chips", () => {
		const hud = buildRalplanHudSummary({
			stage: "architect",
			iteration: 2,
			iterationFromIndex: 1,
			stages: "P·A·C",
			pendingApproval: false,
		});
		expect(hud.chips?.find(chip => chip.label === "iter")?.value).toBe("1");
		expect(hud.chips?.find(chip => chip.label === "stages")?.value).toBe("P·A·C");
	});

	it("renders ralplan review-pass chips between stages and verdict without exceeding the final HUD shape", () => {
		const hud = buildRalplanHudSummary({
			stage: "critic",
			iterationFromIndex: 1,
			stages: "P·A·C",
			architectPasses: 1,
			criticPasses: 2,
			reviewPassBudget: 3,
			verdict: "ITERATE",
		});
		expect(hud.chips?.map(chip => `${chip.label}:${chip.value}:${chip.priority}`)).toEqual([
			"stage:critic:10",
			"iter:1:30",
			"stages:P·A·C:35",
			"arch:1/3:36",
			"crit:2/3:38",
			"verdict:ITERATE:40",
		]);

		const finalHud = buildRalplanHudSummary({
			stage: "final",
			iterationFromIndex: 1,
			stages: "P·A·C·F",
			architectPasses: 1,
			criticPasses: 1,
			reviewPassBudget: 1,
			verdict: "OKAY",
			pendingApproval: true,
		});
		expect(finalHud.chips?.map(chip => chip.label)).toEqual(["pending", "stage", "iter", "stages", "verdict"]);
	});

	it("keeps a zero-pass ralplan HUD byte-identical to the pre-counter shape", () => {
		const baseline = {
			stage: "planner",
			iterationFromIndex: 1,
			stages: "P",
			updatedAt: "2026-07-28T00:00:00.000Z",
		};
		expect(
			buildRalplanHudSummary({
				...baseline,
				architectPasses: 0,
				criticPasses: 0,
				reviewPassBudget: 1,
			}),
		).toEqual(buildRalplanHudSummary(baseline));
	});

	it("renders OKAY and REJECT with their closed-vocabulary severities", () => {
		const okay = buildRalplanHudSummary({ stage: "critic", verdict: "OKAY" });
		const reject = buildRalplanHudSummary({ stage: "critic", verdict: "REJECT" });
		const clear = buildRalplanHudSummary({ stage: "architect", verdict: "CLEAR" });
		const block = buildRalplanHudSummary({ stage: "architect", verdict: "BLOCK" });
		expect(okay.chips?.find(chip => chip.label === "verdict")?.severity).toBe("success");
		expect(reject.chips?.find(chip => chip.label === "verdict")?.severity).toBe("blocked");
		expect(clear.chips?.find(chip => chip.label === "verdict")?.severity).toBe("success");
		expect(block.chips?.find(chip => chip.label === "verdict")?.severity).toBe("blocked");
	});

	it("renders ultragoal latest ledger event as a main chip", () => {
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
		expect(hud.chips?.find(chip => chip.label === "ledger")?.value).toBe("goal_checkpointed:G001");
		expect(hud.details).toBeUndefined();
		expect(hud.chips?.[0]?.severity).toBe("blocked");
	});

	it("omits the ultragoal ledger chip when no event is present", () => {
		const hud = buildUltragoalHudSummary({
			status: "active",
			counts: { complete: 0 },
			goals: [{ id: "G001", title: "Build HUD", status: "active" }],
		});
		expect(hud.chips?.some(chip => chip.label === "ledger")).toBe(false);
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
