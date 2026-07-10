import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	materializeActiveModelProfileAssignment,
	materializeActiveModelProfileAssignments,
} from "@gajae-code/coding-agent/config/model-profile-activation";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentDashboard } from "@gajae-code/coding-agent/modes/components/agent-dashboard";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { getProjectAgentDir } from "@gajae-code/utils";

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Failed to load test theme");
	setThemeInstance(theme);
});

async function replaceEditorValue(dashboard: AgentDashboard, value: string): Promise<void> {
	dashboard.handleInput("\n");
	for (let index = 0; index < 80; index++) dashboard.handleInput("\x7f");
	if (value) dashboard.handleInput(value);
	dashboard.handleInput("\n");
	for (let attempt = 0; attempt < 100; attempt++) {
		if (!dashboard.render(120).join("\n").includes("Model override:")) return;
		await Bun.sleep(5);
	}
	throw new Error("Dashboard model override did not settle");
}

function renderedText(dashboard: AgentDashboard): string {
	return dashboard
		.render(120)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
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

		await replaceEditorValue(dashboard, "user/architect:xhigh");

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
		await replaceEditorValue(dashboard, "");

		expect(settings.get("task.agentModelOverrides")).toEqual({
			critic: "persisted/critic:high",
			executor: "profile/executor:low",
		});
		settings.clearOverride("task.agentModelOverrides");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			critic: "persisted/critic:high",
		});
	});

	test("active-profile role edits detach the profile and survive clearing its runtime layer", async () => {
		const settings = Settings.isolated({
			"modelProfile.default": "profile-a",
		});
		settings.set("task.agentModelOverrides", { critic: "persisted/critic:high" });
		settings.override("task.agentModelOverrides", {
			architect: "profile/architect:medium",
			executor: "profile/executor:low",
		});
		let activeProfile: string | undefined = "profile-a";
		const session = {
			model: undefined,
			thinkingLevel: undefined,
			getActiveModelProfile: () => activeProfile,
			setActiveModelProfile: (name: string | undefined) => {
				activeProfile = name;
			},
			getSessionDefaultModelSelector: () => undefined,
		};
		const dashboard = await AgentDashboard.create(process.cwd(), settings, 30, {
			onModelOverrideChange: async (agentName, value) => {
				if (!value || agentName !== "architect") throw new Error("Unexpected dashboard edit");
				materializeActiveModelProfileAssignment({
					session,
					settings,
					role: "architect",
					selector: value,
				});
				await settings.flushOrThrow();
			},
		});

		await replaceEditorValue(dashboard, "user/architect:xhigh");

		expect(activeProfile).toBeUndefined();
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(settings.get("task.agentModelOverrides").architect).toBe("user/architect:xhigh");
		settings.clearOverride("task.agentModelOverrides");
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
			architect: "user/architect:xhigh",
			critic: "persisted/critic:high",
			executor: "profile/executor:low",
		});
	});
	test("clearing an active-profile role detaches the profile and materializes sibling roles", async () => {
		const settings = Settings.isolated({
			"modelProfile.default": "profile-a",
		});
		settings.set("task.agentModelOverrides", { critic: "persisted/critic:high" });
		settings.override("task.agentModelOverrides", {
			architect: "profile/architect:medium",
			executor: "profile/executor:low",
		});
		let activeProfile: string | undefined = "profile-a";
		const session = {
			model: undefined,
			thinkingLevel: undefined,
			getActiveModelProfile: () => activeProfile,
			setActiveModelProfile: (name: string | undefined) => {
				activeProfile = name;
			},
			getSessionDefaultModelSelector: () => undefined,
		};
		const dashboard = await AgentDashboard.create(process.cwd(), settings, 30, {
			projectModelProfileShadow: { profileName: "profile-a", targetIds: ["architect"] },
			onModelOverrideChange: async (agentName, value) => {
				if (agentName !== "architect" || value !== undefined) throw new Error("Unexpected dashboard edit");
				materializeActiveModelProfileAssignments({
					session,
					settings,
					assignments: { architect: undefined },
				});
				await settings.flushOrThrow();
			},
		});

		await replaceEditorValue(dashboard, "");

		expect(activeProfile).toBeUndefined();
		expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
			critic: "persisted/critic:high",
			executor: "profile/executor:low",
		});
		expect(settings.get("task.agentModelOverrides").architect).toBeUndefined();
		expect(renderedText(dashboard)).toContain("Override: (none)");
		const profileNotice = renderedText(dashboard);
		expect(profileNotice).toContain("project model profile profile-a");
		expect(profileNotice).toContain("resumes on restart");
	});
	test("does not report a partial project profile for an unbound role", async () => {
		const settings = Settings.isolated();
		const dashboard = await AgentDashboard.create(process.cwd(), settings, 30, {
			projectModelProfileShadow: { profileName: "profile-a", targetIds: ["executor"] },
		});

		await replaceEditorValue(dashboard, "user/architect:high");

		expect(renderedText(dashboard)).not.toContain("project model profile profile-a");
	});

	test("project-backed clears keep the effective value visible and avoid a false cleared state", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dashboard-project-"));
		const projectDir = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		try {
			await fs.mkdir(getProjectAgentDir(projectDir), { recursive: true });
			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "config.yml"),
				"task:\n  agentModelOverrides:\n    architect: project/architect:medium\n",
			);
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.setAgentModelOverride("architect", "user/architect:low");
			await settings.flushOrThrow();
			const dashboard = await AgentDashboard.create(projectDir, settings, 30);

			await replaceEditorValue(dashboard, "");

			expect(settings.getGlobal("task.agentModelOverrides")).toEqual({});
			expect(settings.get("task.agentModelOverrides").architect).toBe("project/architect:medium");
			const text = renderedText(dashboard);
			expect(text).toContain("project/architect:medium");
			expect(text).toContain(
				"Cleared user override for architect; effective override remains project/architect:medium",
			);
		} finally {
			resetSettingsForTest();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	test("user role overrides take effect live but project overrides resume after restart", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dashboard-project-restart-"));
		const projectDir = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		try {
			await fs.mkdir(getProjectAgentDir(projectDir), { recursive: true });
			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "config.yml"),
				"task:\n  agentModelOverrides:\n    architect: project/architect:medium\n",
			);
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const dashboard = await AgentDashboard.create(projectDir, settings, 30);

			await replaceEditorValue(dashboard, "user/architect:low");

			expect(settings.get("task.agentModelOverrides").architect).toBe("user/architect:low");
			const notice = renderedText(dashboard);
			expect(notice).toContain("Updated user override for architect to user/architect:low for this session");
			expect(notice).toContain("project override project/architect:medium");
			expect(notice).toContain("resumes on restart");

			resetSettingsForTest();
			const restarted = await Settings.init({ cwd: projectDir, agentDir });
			expect(restarted.get("task.agentModelOverrides").architect).toBe("project/architect:medium");
		} finally {
			resetSettingsForTest();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("shows the local effective override when flushOrThrow cannot confirm persistence", async () => {
		const settings = Settings.isolated();
		settings.flushOrThrow = async () => {
			throw new Error("disk unavailable");
		};
		const dashboard = await AgentDashboard.create(process.cwd(), settings, 30, {
			onModelOverrideChange: async (agentName, value) => {
				if (agentName !== "architect" || !value) throw new Error("Unexpected dashboard edit");
				settings.setAgentModelOverride(agentName, value);
				await settings.flushOrThrow();
			},
		});

		await replaceEditorValue(dashboard, "user/architect:xhigh");

		expect(settings.get("task.agentModelOverrides").architect).toBe("user/architect:xhigh");
		const notice = renderedText(dashboard);
		expect(notice).toContain("Model override for architect is user/architect:xhigh locally");
		expect(notice).toContain("persistence was not confirmed: disk unavailable");

		const reopened = await AgentDashboard.create(process.cwd(), settings, 30);
		const reopenedNotice = renderedText(reopened);
		expect(reopenedNotice).toContain("Override:");
		expect(reopenedNotice).toContain("user/architect:xhigh");
		expect(reopenedNotice).toContain("Persistence: unconfirmed");
		expect(reopenedNotice).toContain("Local override may not survive restart");

		const retry = Promise.withResolvers<void>();
		settings.flushOrThrow = () => retry.promise;
		const nonsettlingRetry = await Promise.race([
			AgentDashboard.create(process.cwd(), settings, 30),
			Bun.sleep(100).then(() => undefined),
		]);
		expect(nonsettlingRetry).toBeInstanceOf(AgentDashboard);
		expect(renderedText(nonsettlingRetry as AgentDashboard)).toContain("Persistence: unconfirmed");
		retry.resolve();
		await Bun.sleep(0);

		settings.flushOrThrow = async () => {};
		const confirmed = await AgentDashboard.create(process.cwd(), settings, 30);
		expect(renderedText(confirmed)).not.toContain("Persistence: unconfirmed");
	});

	test("keeps a pending save from accepting input or reopening an editor closed with escape", async () => {
		const settings = Settings.isolated();
		const save = Promise.withResolvers<void>();
		const values: string[] = [];
		const dashboard = await AgentDashboard.create(process.cwd(), settings, 30, {
			onModelOverrideChange: async (agentName, value) => {
				if (agentName !== "architect" || !value) throw new Error("Unexpected dashboard edit");
				values.push(value);
				await save.promise;
			},
		});
		let renderRequests = 0;
		dashboard.onRequestRender = () => {
			renderRequests += 1;
		};

		dashboard.handleInput("\n");
		dashboard.handleInput("user/architect:low");
		dashboard.handleInput("\n");
		dashboard.handleInput("ignored/architect:high");
		dashboard.handleInput("\x1b");
		expect(values).toEqual(["user/architect:low"]);
		expect(renderedText(dashboard)).not.toContain("Model override:");

		save.resolve();
		await Bun.sleep(0);

		const text = renderedText(dashboard);
		expect(text).not.toContain("Model override:");
		expect(text).toContain("Background model override save completed for architect");
		expect(renderRequests).toBeGreaterThan(0);
	});
});
