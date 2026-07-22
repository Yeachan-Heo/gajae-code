import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { getSessionSlashCommands } from "@gajae-code/coding-agent/extensibility/extensions/get-commands-handler";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { buildSystemPrompt } from "@gajae-code/coding-agent/system-prompt";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { SkillTool } from "@gajae-code/coding-agent/tools/skill";
import { SkillDiscoveryTool } from "@gajae-code/coding-agent/tools/skill-discovery";

async function makeSkill(
	root: string,
	name: string,
	description: string,
	body = "Skill body",
	hide = false,
): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "SKILL.md");
	await fs.writeFile(
		filePath,
		`---
name: ${name}
description: ${description}
${hide ? "hide: true\n" : ""}

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
		await makeSkill(
			path.join(cwd, ".gjc", "skills"),
			"ralplan",
			"On-disk built-in impostor",
			"Should be suppressed.",
		);
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
		expect(result.details?.candidates.find(candidate => candidate.name === "ralplan")).toBeUndefined();

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
		expect(discovery.details?.notice).toContain("`skills.enabled` is false");

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

	it("explains empty results caused by disabled discovery scopes, and stays silent for genuine emptiness", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skills-notice-"));
		await makeSkill(path.join(cwd, ".gjc", "skills"), "project-helper", "Project helper skill");

		// Requested scope is fully disabled: empty result carries a scope notice.
		const userOff = runtimeSkillSettings({ "skills.enablePiUser": false });
		const userScope = await new SkillDiscoveryTool(createSession(cwd, { settings: userOff })).execute("call", {
			source: "user",
		});
		expect(userScope.details?.candidates).toEqual([]);
		expect(userScope.details?.notice).toContain("`skills.enablePiUser` is false");

		// A disabled scope is mentioned even under source "all" when nothing was found.
		const projectOff = runtimeSkillSettings({ "skills.enablePiProject": false });
		const allScope = await new SkillDiscoveryTool(createSession(cwd, { settings: projectOff })).execute("call", {
			query: "no-such-skill-anywhere",
		});
		expect(allScope.details?.candidates).toEqual([]);
		expect(allScope.details?.notice).toContain("`skills.enablePiProject` is false");

		// Fully enabled policy with a non-matching query: genuinely empty, no notice.
		const enabled = runtimeSkillSettings();
		const genuine = await new SkillDiscoveryTool(createSession(cwd, { settings: enabled })).execute("call", {
			query: "no-such-skill-anywhere",
		});
		expect(genuine.details?.candidates).toEqual([]);
		expect(genuine.details?.notice).toBeUndefined();

		// Found results never carry a notice.
		const found = await new SkillDiscoveryTool(createSession(cwd, { settings: enabled })).execute("call", {
			query: "project helper",
		});
		expect(found.details?.count).toBe(1);
		expect(found.details?.notice).toBeUndefined();
	});

	it("discovers canonical and legacy user roots in native precedence order", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-root-cwd-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-root-home-"));
		const originalHome = process.env.HOME;
		const originalGjcConfigDir = process.env.GJC_CONFIG_DIR;
		const originalPiConfigDir = process.env.PI_CONFIG_DIR;
		const originalCodingAgentDir = process.env.GJC_CODING_AGENT_DIR;
		const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
		const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

		try {
			process.env.HOME = home;
			process.env.GJC_CONFIG_DIR = "/absolute-looking-gjc";
			process.env.PI_CONFIG_DIR = ".decoy-pi";
			process.env.GJC_CODING_AGENT_DIR = path.join(home, ".decoy-agent");
			process.env.PI_CODING_AGENT_DIR = path.join(home, ".decoy-pi-agent");
			process.env.XDG_CONFIG_HOME = path.join(home, ".xdg-decoy");

			await makeSkill(
				path.join(home, "/absolute-looking-gjc", "agent", "skills"),
				"shared",
				"Canonical user skill",
				"Canonical body.",
			);
			await makeSkill(
				path.join(home, "/absolute-looking-gjc", "skills"),
				"shared",
				"Configured legacy user skill",
				"Legacy body.",
			);
			await makeSkill(path.join(home, ".gjc", "skills"), "historical", "Historical legacy user skill");
			await makeSkill(path.join(cwd, ".gjc", "skills"), "shared", "Project user skill", "Project body.");

			await makeSkill(path.join(home, ".decoy-agent", "skills"), "decoy", "Decoy user skill");
			await makeSkill(path.join(home, ".decoy-pi-agent", "skills"), "pi-decoy", "PI decoy user skill");
			await makeSkill(path.join(home, ".xdg-decoy", "gjc", "agent", "skills"), "xdg-decoy", "XDG decoy user skill");

			const result = await new SkillDiscoveryTool(createSession(cwd, { settings: runtimeSkillSettings() })).execute(
				"call",
				{
					source: "user",
				},
			);
			expect(result.details?.candidates).toEqual([
				expect.objectContaining({
					name: "historical",
					description: "Historical legacy user skill",
					source: "user",
				}),
				expect.objectContaining({ name: "shared", description: "Canonical user skill", source: "user" }),
			]);

			const allSources = await new SkillDiscoveryTool(
				createSession(cwd, { settings: runtimeSkillSettings() }),
			).execute("call", {});
			expect(allSources.details?.candidates).toEqual([
				expect.objectContaining({ name: "historical", source: "user" }),
				expect.objectContaining({ name: "shared", description: "Project user skill", source: "project" }),
			]);
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalGjcConfigDir === undefined) delete process.env.GJC_CONFIG_DIR;
			else process.env.GJC_CONFIG_DIR = originalGjcConfigDir;
			if (originalPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = originalPiConfigDir;
			if (originalCodingAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = originalCodingAgentDir;
			if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
			if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(home, { recursive: true, force: true });
		}
	});

	it("uses the default and PI_CONFIG_DIR canonical user roots", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-canonical-cwd-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-canonical-home-"));
		const originalHome = process.env.HOME;
		const originalGjcConfigDir = process.env.GJC_CONFIG_DIR;
		const originalPiConfigDir = process.env.PI_CONFIG_DIR;
		try {
			process.env.HOME = home;
			delete process.env.GJC_CONFIG_DIR;
			delete process.env.PI_CONFIG_DIR;
			await makeSkill(
				path.join(home, ".gjc", "agent", "skills"),
				"default-canonical",
				"Default canonical user skill",
			);
			await makeSkill(path.join(home, ".gjc", "skills"), "default-canonical", "Default legacy user skill");
			let result = await new SkillDiscoveryTool(createSession(cwd, { settings: runtimeSkillSettings() })).execute(
				"call",
				{
					source: "user",
				},
			);
			expect(result.details?.candidates).toEqual([
				expect.objectContaining({ name: "default-canonical", description: "Default canonical user skill" }),
			]);

			process.env.PI_CONFIG_DIR = ".pi-config";
			await makeSkill(path.join(home, ".pi-config", "agent", "skills"), "pi-canonical", "PI canonical user skill");
			result = await new SkillDiscoveryTool(createSession(cwd, { settings: runtimeSkillSettings() })).execute(
				"call",
				{
					source: "user",
				},
			);
			expect(result.details?.candidates.map(candidate => candidate.name)).toEqual([
				"default-canonical",
				"pi-canonical",
			]);
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalGjcConfigDir === undefined) delete process.env.GJC_CONFIG_DIR;
			else process.env.GJC_CONFIG_DIR = originalGjcConfigDir;
			if (originalPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = originalPiConfigDir;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(home, { recursive: true, force: true });
		}
	});

	it("keeps hidden runtime skills discoverable and exactly invocable", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hidden-runtime-skill-"));
		try {
			await makeSkill(
				path.join(cwd, ".gjc", "skills"),
				"hidden-helper",
				"Hidden helper skill",
				"Hidden body.",
				true,
			);
			const settings = runtimeSkillSettings();
			const discovery = await new SkillDiscoveryTool(createSession(cwd, { settings })).execute("call", {
				query: "hidden-helper",
			});
			expect(discovery.details?.candidates).toEqual([
				expect.objectContaining({ name: "hidden-helper", description: "Hidden helper skill", source: "project" }),
			]);

			const sent: Array<{ content: string; details?: unknown }> = [];
			await new SkillTool(
				createSession(cwd, {
					skills: [],
					settings,
					sendCustomMessage: async message => {
						sent.push({ content: String(message.content), details: message.details });
					},
				}),
			).execute("call", { name: "hidden-helper" });
			expect(sent[0]?.content).toContain("Hidden body.");
			const hiddenSkill: Skill = {
				name: "hidden-helper",
				description: "Hidden helper skill",
				filePath: path.join(cwd, ".gjc", "skills", "hidden-helper", "SKILL.md"),
				baseDir: path.join(cwd, ".gjc", "skills", "hidden-helper"),
				source: "runtime:project",
				hide: true,
			};
			expect(
				getSessionSlashCommands({
					customCommands: [],
					skills: [hiddenSkill],
					skillsSettings: runtimeSkillSettings().getGroup("skills"),
				}).map(command => command.name),
			).not.toContain("skill:hidden-helper");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("applies policy before realpath/name dedup, then query, sort, and limit", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-discovery-pipeline-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-discovery-pipeline-home-"));
		const originalHome = process.env.HOME;
		try {
			process.env.HOME = home;
			const skillsDir = path.join(cwd, ".gjc", "skills");
			const alphaPath = await makeSkill(skillsDir, "alpha", "Sort alpha", "Alpha body.");
			await fs.symlink(path.dirname(alphaPath), path.join(skillsDir, "zz-alias-alpha"), "dir");
			await makeSkill(skillsDir, "ralplan", "Sort built-in", "Suppressed body.");
			const userAlphaPath = await makeSkill(
				path.join(home, ".gjc", "skills"),
				"alpha",
				"Lower-only user alpha",
				"User body.",
			);
			await makeSkill(skillsDir, "zulu", "Sort zulu", "Zulu body.");

			const userOnly = await new SkillDiscoveryTool(
				createSession(cwd, { settings: runtimeSkillSettings({ "skills.enablePiProject": false }) }),
			).execute("call", { query: "lower-only" });
			expect(userOnly.details?.candidates).toEqual([
				expect.objectContaining({ name: "alpha", path: userAlphaPath, source: "user" }),
			]);

			const dedupBeforeQuery = await new SkillDiscoveryTool(
				createSession(cwd, { settings: runtimeSkillSettings() }),
			).execute("call", { query: "lower-only" });
			expect(dedupBeforeQuery.details?.candidates).toEqual([]);

			const result = await new SkillDiscoveryTool(createSession(cwd, { settings: runtimeSkillSettings() })).execute(
				"call",
				{ query: "sort", limit: 1 },
			);
			expect(result.details?.candidates).toEqual([
				expect.objectContaining({ name: "alpha", description: "Sort alpha", path: alphaPath, source: "project" }),
			]);
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(home, { recursive: true, force: true });
		}
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
