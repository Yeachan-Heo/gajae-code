import { describe, expect, it } from "bun:test";
import { renderSkillHudBar } from "../src/modes/components/skill-hud/render";
import { STATUS_LINE_PRESETS } from "../src/modes/components/status-line/presets";

function visibleWidth(text: string): number {
	return Bun.stripANSI(text).length;
}

describe("skill HUD bar renderer", () => {
	it("omits the bar when no active skills exist", () => {
		expect(renderSkillHudBar([], 80)).toBeNull();
	});

	it("renders active skill and phase compactly", () => {
		const rendered = Bun.stripANSI(renderSkillHudBar([{ skill: "deep-interview", phase: "intent-first" }], 80) ?? "");
		expect(rendered).toContain("hud");
		expect(rendered).toContain("deep-interview:intent-first");
	});

	it("sanitizes dynamic text and truncates to width", () => {
		const rendered = renderSkillHudBar(
			[{ skill: "team\n\u001b[31mred", phase: "running\twith-a-very-long-phase-name" }],
			30,
		);
		expect(rendered).not.toBeNull();
		expect(Bun.stripANSI(rendered ?? "")).not.toContain("\n");
		expect(Bun.stripANSI(rendered ?? "")).not.toContain("\t");
		expect(visibleWidth(rendered ?? "")).toBeLessThanOrEqual(30);
	});

	it("is included as a native status-line rail without changing preset segments", () => {
		expect(STATUS_LINE_PRESETS.default.leftSegments).toEqual(["model", "mode", "git", "pr", "path"]);
		const rendered = Bun.stripANSI(renderSkillHudBar([{ skill: "team", phase: "running" }], 100) ?? "");
		expect(rendered).toContain("hud team:running");
	});

	it("omits inactive entries so statusLine.showSkillHud can gate the rail", () => {
		expect(renderSkillHudBar([{ skill: "team", phase: "running", active: false }], 100)).toBeNull();
	});
	it("renders normalized HUD chips in priority order with stale warning", () => {
		const rendered = Bun.stripANSI(
			renderSkillHudBar(
				[
					{
						skill: "ralplan",
						phase: "planning",
						stale: true,
						hud: {
							version: 1,
							summary: "consensus",
							chips: [
								{ label: "verdict", value: "ITERATE", priority: 40, severity: "warning" },
								{ label: "stage", value: "critic", priority: 10 },
							],
						},
					},
				],
				120,
			) ?? "",
		);
		expect(rendered).toContain("ralplan:planning consensus warn:stale stage=critic warn:verdict=ITERATE");
	});

	it("sanitizes HUD chips and keeps constrained rendering within width", () => {
		const rendered = renderSkillHudBar(
			[
				{
					skill: "team",
					phase: "running",
					hud: {
						version: 1,
						summary: "workers\nok",
						chips: [{ label: "latest\t", value: "a-very-long-message-with-\u001b[31mansi" }],
					},
				},
			],
			35,
		);
		expect(rendered).not.toBeNull();
		expect(Bun.stripANSI(rendered ?? "")).not.toContain("\n");
		expect(Bun.stripANSI(rendered ?? "")).not.toContain("\t");
		expect(visibleWidth(rendered ?? "")).toBeLessThanOrEqual(35);
	});
});
