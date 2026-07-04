import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import { ToolExecutionComponent } from "@gajae-code/coding-agent/modes/components/tool-execution";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";

beforeAll(async () => {
	await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

describe("ToolExecutionComponent spacing", () => {
	it("adds a top breathing row inside goal result blocks", () => {
		const uiStub = { requestRender() {} } as unknown as TUI;
		const goalTool = { name: "goal", label: "Goal" } as unknown as AgentTool;
		const component = new ToolExecutionComponent("goal", { op: "complete" }, {}, goalTool, uiStub);

		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: 'Goal: "Red-team Gajae usability"\nStatus: complete\nTokens used: 326K',
					},
				],
				details: {
					op: "complete",
					goal: {
						objective: "Red-team Gajae usability",
						status: "complete",
						tokensUsed: 326000,
						timeUsedSeconds: 720,
					},
				},
			},
			false,
		);

		const lines = component.render(120).map(line => Bun.stripANSI(line));
		expect(lines[0]?.trim()).toBe("");
		expect(lines[1]?.trim()).toBe("");
		expect(lines[2]).toContain("Goal");
		expect(lines[3]).toContain('"Red-team Gajae usability"');
	});
});
