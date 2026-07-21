import { describe, expect, test } from "bun:test";
import { renderSessionWorkflowStatusLines } from "../src/sdk/bus";

describe("Telegram session workflow status", () => {
	test("renders low-noise Ralplan approval state", () => {
		expect(
			renderSessionWorkflowStatusLines([
				{
					skill: "ralplan",
					phase: "final",
					hud: {
						version: 1,
						chips: [
							{ label: "pending", value: "approval", priority: 5 },
							{ label: "stage", value: "final", priority: 10 },
							{ label: "verdict", value: "APPROVE", priority: 40 },
						],
					},
				},
			]),
		).toEqual(["Ralplan", "• stage: final", "• status: awaiting approval", "• verdict: approve"]);
	});

	test("renders and bounds Ultragoal status without terminal chip syntax", () => {
		const lines = renderSessionWorkflowStatusLines([
			{
				skill: "ultragoal",
				phase: "executing",
				hud: {
					version: 1,
					chips: [
						{ label: "blocked", value: "1", priority: 5 },
						{ label: "goals", value: "2/5", priority: 10 },
						{ label: "current", value: `g3:${"x".repeat(500)}`, priority: 20 },
						{ label: "status", value: "active", priority: 30 },
					],
				},
			},
		]);
		expect(lines).toHaveLength(5);
		expect(lines[0]).toBe("Ultragoal");
		expect(lines[1]).toBe("• status: active");
		expect(lines[2]).toBe("• goals: 2/5 complete");
		expect(lines[3]).toStartWith("• current: g3 — ");
		expect(lines[3]?.length).toBeLessThanOrEqual(254);
		expect(lines[4]).toBe("• blocked: 1");
	});

	test("collapses the planning pipeline and sanitizes control text", () => {
		const lines = renderSessionWorkflowStatusLines([
			{ skill: "ralplan", phase: "final", active: true, updated_at: "2026-01-01T00:00:00.000Z" },
			{
				skill: "ultragoal",
				phase: "executing\n\u001b[31m",
				active: true,
				updated_at: "2026-01-01T00:05:00.000Z",
			},
		]);
		expect(lines.join("\n")).toContain("Ultragoal");
		expect(lines.join("\n")).not.toContain("Ralplan");
		expect(lines.join("\n")).not.toMatch(/[\u001b\r\t]/);
	});
});
