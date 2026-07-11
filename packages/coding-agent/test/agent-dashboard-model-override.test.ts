import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { materializeActiveModelProfileAssignments } from "@gajae-code/coding-agent/config/model-profile-activation";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentDashboard } from "@gajae-code/coding-agent/modes/components/agent-dashboard";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { Snowflake } from "@gajae-code/utils";

let testTheme = await getThemeByName("red-claw");
const testDirs: string[] = [];

function typeText(dashboard: AgentDashboard, text: string): void {
	for (const char of text) dashboard.handleInput(char);
}

describe("AgentDashboard model overrides", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		if (!testTheme) throw new Error("Failed to load test theme");
		setThemeInstance(testTheme);
	});

	afterEach(() => {
		for (const dir of testDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	test("edits and clears one agent without dropping runtime resets or durable siblings", async () => {
		const cwd = path.join(os.tmpdir(), `agent-dashboard-model-${Snowflake.next()}`);
		testDirs.push(cwd);
		fs.mkdirSync(cwd, { recursive: true });

		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", {
			executor: "durable/executor",
			planner: "durable/planner",
		});
		settings.override("task.agentModelOverrides", null as never);

		const dashboard = await AgentDashboard.create(cwd, settings, 24);
		typeText(dashboard, "executor");
		dashboard.handleInput("\n");
		const selected = "provider/selected:high";
		typeText(dashboard, selected);
		dashboard.handleInput("\n");

		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: selected });
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
			executor: selected,
			planner: "durable/planner",
		});

		dashboard.handleInput("\n");
		for (let i = 0; i < selected.length; i++) dashboard.handleInput("\x7f");
		dashboard.handleInput("\n");

		expect(settings.get("task.agentModelOverrides")).toEqual({});
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
			planner: "durable/planner",
		});

		settings.clearOverride("task.agentModelOverrides");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			planner: "durable/planner",
		});
	});
	test("materializes an active profile before saving a dashboard override", async () => {
		const cwd = path.join(os.tmpdir(), `agent-dashboard-profile-${Snowflake.next()}`);
		testDirs.push(cwd);
		fs.mkdirSync(cwd, { recursive: true });

		const settings = Settings.isolated();
		settings.set("modelProfile.default", "profile-a");
		settings.set("task.agentModelOverrides", { planner: "durable/planner" });
		settings.override("task.agentModelOverrides", {
			executor: "profile/executor",
			architect: "profile/architect",
		});
		let activeProfile: string | undefined = "profile-a";
		const session = {
			model: undefined,
			thinkingLevel: undefined,
			getActiveModelProfile: () => activeProfile,
			setActiveModelProfile: (profile: string | undefined) => {
				activeProfile = profile;
			},
		};

		const dashboard = await AgentDashboard.create(cwd, settings, 24, {
			persistModelOverride: (agentName, value) => {
				const materialized = materializeActiveModelProfileAssignments({
					session,
					settings,
					assignments: value ? new Map([[agentName, value]]) : new Map(),
				});
				if (!materialized && value) settings.setAgentModelOverride(agentName, value);
				else if (!value) settings.clearAgentModelOverride(agentName);
			},
		});
		typeText(dashboard, "executor");
		dashboard.handleInput("\n");
		for (let i = 0; i < "profile/executor".length; i++) dashboard.handleInput("\x7f");
		const selected = "provider/dashboard-selected:high";
		typeText(dashboard, selected);
		dashboard.handleInput("\n");

		expect(activeProfile).toBeUndefined();
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
			planner: "durable/planner",
			executor: selected,
			architect: "profile/architect",
		});
	});
	test("materializes an active profile before clearing a dashboard override", async () => {
		const cwd = path.join(os.tmpdir(), `agent-dashboard-profile-clear-${Snowflake.next()}`);
		testDirs.push(cwd);
		fs.mkdirSync(cwd, { recursive: true });

		const settings = Settings.isolated();
		settings.set("modelProfile.default", "profile-a");
		settings.set("task.agentModelOverrides", { planner: "durable/planner" });
		settings.override("task.agentModelOverrides", {
			executor: "profile/executor",
			architect: "profile/architect",
		});
		let activeProfile: string | undefined = "profile-a";
		const session = {
			model: undefined,
			thinkingLevel: undefined,
			getActiveModelProfile: () => activeProfile,
			setActiveModelProfile: (profile: string | undefined) => {
				activeProfile = profile;
			},
		};
		const dashboard = await AgentDashboard.create(cwd, settings, 24, {
			persistModelOverride: (agentName, value) => {
				const materialized = materializeActiveModelProfileAssignments({
					session,
					settings,
					assignments: value ? new Map([[agentName, value]]) : new Map(),
				});
				if (!materialized && value) settings.setAgentModelOverride(agentName, value);
				else if (!value) settings.clearAgentModelOverride(agentName);
			},
		});

		typeText(dashboard, "executor");
		dashboard.handleInput("\n");
		for (let i = 0; i < "profile/executor".length; i++) dashboard.handleInput("\x7f");
		dashboard.handleInput("\n");

		expect(activeProfile).toBeUndefined();
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
			planner: "durable/planner",
			architect: "profile/architect",
		});
		expect(settings.get("task.agentModelOverrides")).toEqual({
			planner: "durable/planner",
			architect: "profile/architect",
		});
	});
});
