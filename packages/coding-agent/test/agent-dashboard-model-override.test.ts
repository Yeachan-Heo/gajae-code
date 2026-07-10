import { beforeAll, describe, expect, test } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentDashboard } from "@gajae-code/coding-agent/modes/components/agent-dashboard";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Failed to load test theme");
	setThemeInstance(theme);
});

function replaceEditorValue(dashboard: AgentDashboard, value: string): void {
	dashboard.handleInput("\n");
	for (let index = 0; index < 80; index++) dashboard.handleInput("\x7f");
	if (value) dashboard.handleInput(value);
	dashboard.handleInput("\n");
}

describe("AgentDashboard model overrides", () => {
	test("edits and clears one live override without persisting profile siblings", async () => {
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", {
			architect: "persisted/architect:low",
			critic: "persisted/critic:high",
		});
		settings.override("task.agentModelOverrides", {
			architect: "profile/architect:medium",
			executor: "profile/executor:low",
		});
		const dashboard = await AgentDashboard.create(process.cwd(), settings, 30);

		replaceEditorValue(dashboard, "user/architect:xhigh");

		expect(settings.get("task.agentModelOverrides")).toEqual({
			architect: "user/architect:xhigh",
			critic: "persisted/critic:high",
			executor: "profile/executor:low",
		});
		settings.clearOverride("task.agentModelOverrides");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			architect: "user/architect:xhigh",
			critic: "persisted/critic:high",
		});

		settings.override("task.agentModelOverrides", {
			architect: "profile/architect:medium",
			executor: "profile/executor:low",
		});
		replaceEditorValue(dashboard, "");

		expect(settings.get("task.agentModelOverrides")).toEqual({
			critic: "persisted/critic:high",
			executor: "profile/executor:low",
		});
		settings.clearOverride("task.agentModelOverrides");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			critic: "persisted/critic:high",
		});
	});
});
