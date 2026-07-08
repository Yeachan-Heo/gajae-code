import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { buildSystemPrompt } from "@gajae-code/coding-agent/system-prompt";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { SkillTool } from "@gajae-code/coding-agent/tools/skill";
import { SkillDiscoveryTool } from "@gajae-code/coding-agent/tools/skill-discovery";

async function makeSkill(root: string, name: string, description: string, body = "Skill body"): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "SKILL.md");
	await fs.writeFile(
		filePath,
		`---
name: ${name}
description: ${description}
globs:
  - "**/*.ts"
---

# ${name}

${body}
`,
		"utf8",
	);
	return filePath;
}

function createSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "skill.enabled": true }),
		...overrides,
	};
}
function runtimeSkillSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"skill.enabled": true,
		"skills.enabled": true,
		"skills.enablePiProject": true,
		"skills.enablePiUser": true,
		...overrides,
	});
}

describe("SkillDiscoveryTool", () => {
	it("discovers project runtime skills from .gjc/skills", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-skills-"));
		await makeSkill(path.join(cwd, ".gjc", "skills"), "project-helper", "Project helper skill");
		const settings = runtimeSkillSettings();

		const tool = new SkillDiscoveryTool(createSession(cwd, { settings }));
		const result = await tool.execute("call", { query: "project helper" });
		const details = result.details;
		expect(details).toBeDefined();

		expect(details!.candidates).toEqual([
			expect.objectContaining({ name: "project-helper", description: "Project helper skill", source: "project" }),
		]);
		expect(details!.candidates[0]?.useWhen).toContain("**/*.ts");
	});

	it("discovers user runtime skills from ~/.gjc/skills", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-skills-cwd-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-skills-home-"));
		const originalHome = process.env.HOME;
		process.env.HOME = home;
		try {
			await makeSkill(path.join(home, ".gjc", "skills"), "user-helper", "User helper skill");
			const settings = runtimeSkillSettings();

			const tool = new SkillDiscoveryTool(createSession(cwd, { settings }));
			const result = await tool.execute("call", { source: "user" });
			const details = result.details;
			expect(details).toBeDefined();

			expect(details!.candidates.map(candidate => candidate.name)).toContain("user-helper");
			expect(details!.candidates.find(candidate => candidate.name === "user-helper")?.source).toBe("user");
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
		}
	});

	it("does not classify home .gjc skills as project skills while walking up", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-home-skill-boundary-"));
		const cwd = path.join(home, "work", "project", "nested");
		await fs.mkdir(cwd, { recursive: true });
		await makeSkill(path.join(home, ".gjc", "skills"), "home-helper", "Home helper skill", "Home body.");
		const originalHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const projectOnly = runtimeSkillSettings({ "skills.enablePiUser": false });
			const discovery = await new SkillDiscoveryTool(createSession(cwd, { settings: projectOnly })).execute("call", {
				source: "project",
			});
			expect(discovery.details?.candidates).toEqual([]);

			const sent: Array<{ content: string; details?: unknown }> = [];
			const tool = new SkillTool(
				createSession(cwd, {
					skills: [],
					settings: projectOnly,
					sendCustomMessage: async message => {
						sent.push({ content: String(message.content), details: message.details });
					},
				}),
			);
			await expect(tool.execute("call", { name: "home-helper" })).rejects.toThrow(/unknown skill/);
			expect(sent).toHaveLength(0);

			const userEnabled = runtimeSkillSettings({ "skills.enablePiProject": false });
			const userDiscovery = await new SkillDiscoveryTool(createSession(cwd, { settings: userEnabled })).execute(
				"call",
				{ source: "user" },
			);
			expect(userDiscovery.details?.candidates).toEqual([
				expect.objectContaining({ name: "home-helper", source: "user" }),
			]);
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
		}
	});

	it("does not return bundled built-in skills or grow the core prompt catalog", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-builtins-suppressed-"));
		await makeSkill(path.join(cwd, ".gjc", "skills"), "project-helper", "Project helper skill");
		const settings = runtimeSkillSettings();
		const builtInSkill: Skill = {
			name: "ralplan",
			description: "Built-in planning workflow",
			filePath: "embedded:gjc/skills/ralplan/SKILL.md",
			baseDir: "embedded:gjc/skills/ralplan",
			source: "embedded",
		};

		const tool = new SkillDiscoveryTool(createSession(cwd, { skills: [builtInSkill], settings }));
		const result = await tool.execute("call", {});
		const details = result.details;
		expect(details).toBeDefined();
		const names = details!.candidates.map(candidate => candidate.name);
		expect(names).toContain("project-helper");
		expect(names).not.toContain("ralplan");

		const prompt = await buildSystemPrompt({
			cwd,
			customPrompt: "base instructions",
			skills: [
				builtInSkill,
				{
					name: "project-helper",
					description: "Project helper skill",
					filePath: path.join(cwd, ".gjc", "skills", "project-helper", "SKILL.md"),
					baseDir: path.join(cwd, ".gjc", "skills", "project-helper"),
					source: "runtime:project",
				},
			],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		const joined = prompt.systemPrompt.join("\n");
		expect(joined).not.toContain("Project helper skill");
		expect(joined).not.toContain('<skill name="project-helper">');
	});

	it("loads selected discovered skill content through the skill invocation path", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-selected-skill-"));
		await makeSkill(path.join(cwd, ".gjc", "skills"), "project-helper", "Project helper skill", "Loaded narrowly.");
		const settings = runtimeSkillSettings();
		const sent: Array<{ content: string; details?: unknown }> = [];
		const tool = new SkillTool(
			createSession(cwd, {
				skills: [],
				settings,
				sendCustomMessage: async message => {
					sent.push({ content: String(message.content), details: message.details });
				},
			}),
		);

		await tool.execute("call", { name: "project-helper" });

		expect(sent).toHaveLength(1);
		expect(sent[0]?.content).toContain("Loaded narrowly.");
		expect(sent[0]?.details).toEqual(expect.objectContaining({ name: "project-helper" }));
	});

	it("does not discover or invoke runtime skills when skills.enabled is false", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skills-disabled-"));
		await makeSkill(path.join(cwd, ".gjc", "skills"), "project-helper", "Project helper skill", "Blocked body.");
		const settings = runtimeSkillSettings({ "skills.enabled": false });

		const discovery = await new SkillDiscoveryTool(createSession(cwd, { settings })).execute("call", {});
		expect(discovery.details?.candidates).toEqual([]);

		const sent: Array<{ content: string; details?: unknown }> = [];
		const tool = new SkillTool(
			createSession(cwd, {
				skills: [],
				settings,
				sendCustomMessage: async message => {
					sent.push({ content: String(message.content), details: message.details });
				},
			}),
		);
		await expect(tool.execute("call", { name: "project-helper" })).rejects.toThrow(/unknown skill/);
		expect(sent).toHaveLength(0);
	});

	it("applies source enable flags and skill filters to discovery and invocation", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skills-policy-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skills-policy-home-"));
		await makeSkill(path.join(cwd, ".gjc", "skills"), "project-helper", "Project helper skill", "Project body.");
		await makeSkill(path.join(home, ".gjc", "skills"), "user-helper", "User helper skill", "User body.");
		const originalHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const projectDisabled = runtimeSkillSettings({ "skills.enablePiProject": false });
			let result = await new SkillDiscoveryTool(createSession(cwd, { settings: projectDisabled })).execute(
				"call",
				{},
			);
			expect(result.details?.candidates.map(candidate => candidate.name)).toEqual(["user-helper"]);
			await expect(
				new SkillTool(
					createSession(cwd, { skills: [], settings: projectDisabled, sendCustomMessage: async () => {} }),
				).execute("call", { name: "project-helper" }),
			).rejects.toThrow(/unknown skill/);

			const userDisabled = runtimeSkillSettings({ "skills.enablePiUser": false });
			result = await new SkillDiscoveryTool(createSession(cwd, { settings: userDisabled })).execute("call", {});
			expect(result.details?.candidates.map(candidate => candidate.name)).toEqual(["project-helper"]);
			await expect(
				new SkillTool(
					createSession(cwd, { skills: [], settings: userDisabled, sendCustomMessage: async () => {} }),
				).execute("call", { name: "user-helper" }),
			).rejects.toThrow(/unknown skill/);

			for (const settings of [
				runtimeSkillSettings({ "skills.ignoredSkills": ["project-*"] }),
				runtimeSkillSettings({ "skills.includeSkills": ["user-*"] }),
				runtimeSkillSettings({ disabledExtensions: ["skill:project-helper"] }),
			]) {
				result = await new SkillDiscoveryTool(createSession(cwd, { settings })).execute("call", {
					source: "project",
				});
				expect(result.details?.candidates).toEqual([]);
				await expect(
					new SkillTool(createSession(cwd, { skills: [], settings, sendCustomMessage: async () => {} })).execute(
						"call",
						{ name: "project-helper" },
					),
				).rejects.toThrow(/unknown skill/);
			}
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
		}
	});
});
