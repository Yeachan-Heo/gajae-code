import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { getSessionSlashCommands } from "@gajae-code/coding-agent/extensibility/extensions/get-commands-handler";
import {
	discoverRuntimeSkills,
	findRuntimeSkillByName,
} from "@gajae-code/coding-agent/extensibility/runtime-skill-discovery";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { buildSystemPrompt } from "@gajae-code/coding-agent/system-prompt";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { SkillTool } from "@gajae-code/coding-agent/tools/skill";
import { SkillDiscoveryTool } from "@gajae-code/coding-agent/tools/skill-discovery";
import { safeRm } from "../../../../scripts/safe-cleanup";

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
	const testHome = process.env.HOME?.startsWith(os.tmpdir())
		? process.env.HOME
		: path.join(os.tmpdir(), "gjc-skill-discovery-empty-home");
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionHome: () => testHome,
		getSessionAgentDir: () => path.join(testHome, ".gjc", "agent"),
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
	it("prefers the trusted session home over the deprecated compatibility field", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-skills-"));
		const trustedHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-trusted-skill-home-"));
		const staleHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-stale-skill-home-"));
		try {
			await makeSkill(path.join(trustedHome, ".custom-skills"), "trusted-home", "Trusted skill");
			await makeSkill(path.join(staleHome, ".custom-skills"), "stale-home", "Stale skill");
			const tool = new SkillDiscoveryTool(
				createSession(cwd, {
					home: staleHome,
					getSessionHome: () => trustedHome,
					getSessionAgentDir: () => path.join(trustedHome, ".gjc", "agent"),
					settings: runtimeSkillSettings({ "skills.customDirectories": ["~/.custom-skills"] }),
				}),
			);

			const result = await tool.execute("call", {});
			expect(result.details?.candidates.map(candidate => candidate.name)).toContain("trusted-home");
			expect(result.details?.candidates.map(candidate => candidate.name)).not.toContain("stale-home");
		} finally {
			await safeRm(cwd, { recursive: true, force: true });
			await safeRm(trustedHome, { recursive: true, force: true });
			await safeRm(staleHome, { recursive: true, force: true });
		}
	});

	it("does not treat the deprecated home field as discovery authority without an accessor", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-skills-"));
		const staleHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-stale-skill-home-"));
		try {
			await makeSkill(path.join(staleHome, ".custom-skills"), "stale-home", "Stale skill");
			const result = await new SkillDiscoveryTool(
				createSession(cwd, {
					home: staleHome,
					getSessionHome: undefined,
					getSessionAgentDir: () => path.join(staleHome, ".gjc", "agent"),
					settings: runtimeSkillSettings({ "skills.customDirectories": ["~/.custom-skills"] }),
				}),
			).execute("call", {});

			expect(result.details?.candidates.map(candidate => candidate.name)).not.toContain("stale-home");
		} finally {
			await safeRm(cwd, { recursive: true, force: true });
			await safeRm(staleHome, { recursive: true, force: true });
		}
	});

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

	it("preserves exact skill-name tokens without broadening unnamed partial matches", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-exact-name-skill-"));
		await makeSkill(path.join(cwd, ".gjc", "skills"), "aws", "Cloud operations router");
		await makeSkill(path.join(cwd, ".gjc", "skills"), "harbor", "Container registry router");
		const tool = new SkillDiscoveryTool(createSession(cwd, { settings: runtimeSkillSettings() }));

		const exact = await tool.execute("call", { query: "aws" });
		expect(exact.details?.candidates.map(candidate => candidate.name)).toEqual(["aws"]);

		const exactWithExtraTerms = await tool.execute("call", { query: "AWS ec2 cloudwatch production health" });
		expect(exactWithExtraTerms.details?.candidates.map(candidate => candidate.name)).toEqual(["aws"]);

		const existingAllTermMatch = await tool.execute("call", { query: "cloud operations" });
		expect(existingAllTermMatch.details?.candidates.map(candidate => candidate.name)).toEqual(["aws"]);

		const partialWithoutExactName = await tool.execute("call", { query: "cloud production health" });
		expect(partialWithoutExactName.details?.candidates).toEqual([]);

		const unrelated = await tool.execute("call", { query: "database latency" });
		expect(unrelated.details?.candidates).toEqual([]);
	});

	it("discovers user runtime skills from ~/.gjc/skills", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-skills-cwd-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-skills-home-"));
		const originalHome = process.env.HOME;
		process.env.HOME = home;
		try {
			await makeSkill(path.join(home, ".gjc", "skills"), "user-helper", "User helper skill");
			const settings = runtimeSkillSettings();

			const tool = new SkillDiscoveryTool(
				createSession(cwd, { settings, getSessionAgentDir: () => path.join(home, ".gjc", "agent") }),
			);
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

	it("derives the default agent directory from an injected home", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-injected-home-cwd-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-injected-home-"));
		try {
			const skillPath = await makeSkill(
				path.join(home, ".gjc", "agent", "skills"),
				"injected-home",
				"Injected home skill",
			);
			const policy = runtimeSkillSettings().getGroup("skills");
			const discovered = await discoverRuntimeSkills({ cwd, home, policy });
			const found = await findRuntimeSkillByName(cwd, "injected-home", policy, home);

			expect(discovered.candidates.map(candidate => candidate.name)).toContain("injected-home");
			expect(found?.filePath).toBe(skillPath);
		} finally {
			await safeRm(cwd, { recursive: true, force: true });
			await safeRm(home, { recursive: true, force: true });
		}
	});

	it("keeps concurrent injected profiles isolated when agentDir is omitted", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-concurrent-profile-cwd-"));
		const homeA = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-concurrent-profile-a-"));
		const homeB = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-concurrent-profile-b-"));
		try {
			await makeSkill(path.join(homeA, ".gjc", "agent", "skills"), "profile-a", "Profile A skill");
			await makeSkill(path.join(homeB, ".gjc", "agent", "skills"), "profile-b", "Profile B skill");
			const policy = runtimeSkillSettings().getGroup("skills");
			const [resultA, resultB] = await Promise.all([
				discoverRuntimeSkills({ cwd, home: homeA, policy }),
				discoverRuntimeSkills({ cwd, home: homeB, policy }),
			]);

			expect(resultA.candidates.map(candidate => candidate.name)).toEqual(["profile-a"]);
			expect(resultB.candidates.map(candidate => candidate.name)).toEqual(["profile-b"]);
		} finally {
			await safeRm(cwd, { recursive: true, force: true });
			await safeRm(homeA, { recursive: true, force: true });
			await safeRm(homeB, { recursive: true, force: true });
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
			const userDiscovery = await new SkillDiscoveryTool(
				createSession(cwd, {
					settings: userEnabled,
					getSessionAgentDir: () => path.join(home, ".gjc", "agent"),
				}),
			).execute("call", { source: "user" });
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
		expect(userScope.details?.notice).toContain("`skills.trustUserSkills` is false");

		// A disabled scope is mentioned even under source "all" when nothing was found.
		const projectOff = runtimeSkillSettings({ "skills.enablePiProject": false });
		const allScope = await new SkillDiscoveryTool(createSession(cwd, { settings: projectOff })).execute("call", {
			query: "no-such-skill-anywhere",
		});
		expect(allScope.details?.candidates).toEqual([]);
		expect(allScope.details?.notice).toContain("`skills.trustProjectSkills` is false");

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

			const result = await new SkillDiscoveryTool(
				createSession(cwd, {
					settings: runtimeSkillSettings(),
					getSessionAgentDir: () => path.join(home, "absolute-looking-gjc", "agent"),
				}),
			).execute("call", {
				source: "user",
			});
			expect(result.details?.candidates).toEqual([
				expect.objectContaining({
					name: "historical",
					description: "Historical legacy user skill",
					source: "user",
				}),
				expect.objectContaining({ name: "shared", description: "Canonical user skill", source: "user" }),
			]);

			const allSources = await new SkillDiscoveryTool(
				createSession(cwd, {
					settings: runtimeSkillSettings(),
					getSessionAgentDir: () => path.join(home, "absolute-looking-gjc", "agent"),
				}),
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
			await safeRm(cwd, { recursive: true, force: true });
			await safeRm(home, { recursive: true, force: true });
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
			let result = await new SkillDiscoveryTool(
				createSession(cwd, {
					settings: runtimeSkillSettings(),
					getSessionAgentDir: () => path.join(home, ".gjc", "agent"),
				}),
			).execute("call", {
				source: "user",
			});
			expect(result.details?.candidates).toEqual([
				expect.objectContaining({ name: "default-canonical", description: "Default canonical user skill" }),
			]);

			process.env.PI_CONFIG_DIR = ".pi-config";
			await makeSkill(path.join(home, ".pi-config", "agent", "skills"), "pi-canonical", "PI canonical user skill");
			result = await new SkillDiscoveryTool(
				createSession(cwd, {
					settings: runtimeSkillSettings(),
					getSessionAgentDir: () => path.join(home, ".pi-config", "agent"),
				}),
			).execute("call", {
				source: "user",
			});
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
			await safeRm(cwd, { recursive: true, force: true });
			await safeRm(home, { recursive: true, force: true });
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
			await safeRm(cwd, { recursive: true, force: true });
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
				createSession(cwd, {
					settings: runtimeSkillSettings({ "skills.enablePiProject": false }),
					getSessionAgentDir: () => path.join(home, ".gjc", "agent"),
				}),
			).execute("call", { query: "lower-only" });
			expect(userOnly.details?.candidates).toEqual([
				expect.objectContaining({ name: "alpha", path: userAlphaPath, source: "user" }),
			]);

			const dedupBeforeQuery = await new SkillDiscoveryTool(
				createSession(cwd, {
					settings: runtimeSkillSettings(),
					getSessionAgentDir: () => path.join(home, ".gjc", "agent"),
				}),
			).execute("call", { query: "lower-only" });
			expect(dedupBeforeQuery.details?.candidates).toEqual([]);

			const result = await new SkillDiscoveryTool(
				createSession(cwd, {
					settings: runtimeSkillSettings(),
					getSessionAgentDir: () => path.join(home, ".gjc", "agent"),
				}),
			).execute("call", { query: "sort", limit: 1 });
			expect(result.details?.candidates).toEqual([
				expect.objectContaining({ name: "alpha", description: "Sort alpha", path: alphaPath, source: "project" }),
			]);
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			await safeRm(cwd, { recursive: true, force: true });
			await safeRm(home, { recursive: true, force: true });
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

	it("advertises project .claude/skills and .codex/skills as import candidates with zero configuration", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-convention-skills-"));
		await makeSkill(path.join(cwd, ".claude", "skills"), "claude-helper", "Claude convention helper");
		await makeSkill(path.join(cwd, ".codex", "skills"), "codex-helper", "Codex convention helper");

		// No skills.* settings at all: convention skills are discoverable in a
		// normal session as import candidates — never as invokable candidates —
		// and each diagnostic names the copy command that enables the skill.
		const zeroConfig = Settings.isolated({ "skill.enabled": true });
		const result = await new SkillDiscoveryTool(createSession(cwd, { settings: zeroConfig })).execute("call", {});
		expect(result.details?.candidates).toEqual([]);
		const diagnostics = result.details?.diagnostics ?? [];
		expect(diagnostics.some(message => message.includes('"claude-helper"') && message.includes(".claude"))).toBe(
			true,
		);
		expect(diagnostics.some(message => message.includes('"codex-helper"') && message.includes(".codex"))).toBe(true);
		const importDiagnostics = diagnostics.filter(message =>
			message.includes("import sources are not loaded directly"),
		);
		expect(importDiagnostics.some(message => message.includes('"claude-helper"'))).toBe(true);
		expect(importDiagnostics.some(message => message.includes('"codex-helper"'))).toBe(true);
		expect(importDiagnostics.every(message => message.includes(".gjc/skills/"))).toBe(true);
	});

	it("applies runtime precedence: project .gjc beats user, convention copies stay import candidates", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-convention-precedence-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-convention-precedence-home-"));
		const originalHome = process.env.HOME;
		process.env.HOME = home;
		try {
			await makeSkill(path.join(home, ".gjc", "skills"), "shared", "User copy");
			await makeSkill(path.join(cwd, ".codex", "skills"), "shared", "Codex copy");
			await makeSkill(path.join(cwd, ".claude", "skills"), "shared", "Claude copy");
			const nativePath = await makeSkill(path.join(cwd, ".gjc", "skills"), "shared", "Native copy");

			const result = await new SkillDiscoveryTool(createSession(cwd, { settings: runtimeSkillSettings() })).execute(
				"call",
				{ query: "shared" },
			);
			expect(result.details?.candidates).toEqual([
				expect.objectContaining({
					name: "shared",
					description: "Native copy",
					path: nativePath,
					source: "project",
				}),
			]);
			// The shadowed user copy is diagnosed as shadowed; the convention copies
			// are neither candidates nor shadowing noise once the name resolved.
			expect(result.details?.diagnostics?.some(message => message.includes("higher-precedence"))).toBe(true);
			expect(result.details?.diagnostics?.some(message => message.includes("import sources"))).toBe(false);

			// Drop the native copy: the user-scope copy wins at runtime while the
			// convention copies remain import candidates with enablement guidance.
			await safeRm(path.join(cwd, ".gjc"), { recursive: true, force: true });
			const userWins = await new SkillDiscoveryTool(
				createSession(cwd, { settings: runtimeSkillSettings() }),
			).execute("call", { query: "shared" });
			expect(userWins.details?.candidates[0]?.path).toContain(path.join(".gjc", "skills", "shared"));
			expect(userWins.details?.candidates[0]?.source).toBe("user");
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
		}
	});

	it("diagnoses protected-name collisions, ignored, disabled, and include-filtered skills", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-discovery-diagnostics-"));
		await makeSkill(path.join(cwd, ".gjc", "skills"), "ralplan", "On-disk built-in impostor");
		await makeSkill(path.join(cwd, ".gjc", "skills"), "ignored-one", "Ignored helper");
		await makeSkill(path.join(cwd, ".gjc", "skills"), "disabled-one", "Disabled helper");
		await makeSkill(path.join(cwd, ".gjc", "skills"), "excluded-one", "Include-filtered helper");
		await makeSkill(path.join(cwd, ".gjc", "skills"), "visible-one", "Visible helper");

		const settings = runtimeSkillSettings({
			"skills.ignoredSkills": ["ignored-*"],
			"skills.includeSkills": ["visible-*"],
			disabledExtensions: ["skill:disabled-one"],
		});
		const result = await new SkillDiscoveryTool(createSession(cwd, { settings })).execute("call", {});
		expect(result.details?.candidates.map(candidate => candidate.name)).toEqual(["visible-one"]);
		const diagnostics = result.details?.diagnostics ?? [];
		expect(diagnostics.some(message => message.includes("bundled GJC workflow skill"))).toBe(true);
		expect(diagnostics.some(message => message.includes("skills.ignoredSkills"))).toBe(true);
		expect(diagnostics.some(message => message.includes("disabledExtensions"))).toBe(true);
		expect(diagnostics.some(message => message.includes("skills.includeSkills"))).toBe(true);
	});

	it("diagnoses invalid frontmatter and missing descriptions", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-invalid-skill-diagnostics-"));
		const noFrontmatterDir = path.join(cwd, ".gjc", "skills", "no-frontmatter");
		await fs.mkdir(noFrontmatterDir, { recursive: true });
		await fs.writeFile(path.join(noFrontmatterDir, "SKILL.md"), "# No Frontmatter\n\nPlain markdown body.\n", "utf8");
		const noDescriptionDir = path.join(cwd, ".gjc", "skills", "no-description");
		await fs.mkdir(noDescriptionDir, { recursive: true });
		await fs.writeFile(
			path.join(noDescriptionDir, "SKILL.md"),
			"---\nname: no-description\n---\n\n# No Description\n",
			"utf8",
		);

		const result = await new SkillDiscoveryTool(createSession(cwd, { settings: runtimeSkillSettings() })).execute(
			"call",
			{},
		);
		expect(result.details?.candidates).toEqual([]);
		const diagnostics = result.details?.diagnostics ?? [];
		expect(diagnostics.some(message => message.includes("no parseable frontmatter"))).toBe(true);
		expect(diagnostics.some(message => message.includes("missing a description"))).toBe(true);
	});
	// skills.customDirectories feeds the session skill list through loadSkills. When
	// discovery skipped it, a configured skill was invocable by exact name and absent
	// from every search, so it could only be used by someone who already knew it existed.
	it("discovers skills from skills.customDirectories", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-customdir-cwd-"));
		const custom = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-customdir-root-"));
		await makeSkill(custom, "vendor-helper", "Vendor helper skill for invoicing");
		const settings = runtimeSkillSettings({ "skills.customDirectories": [custom] });

		const tool = new SkillDiscoveryTool(createSession(cwd, { settings }));
		const result = await tool.execute("call", { query: "invoicing" });

		expect(result.details?.candidates).toEqual([
			expect.objectContaining({
				name: "vendor-helper",
				source: "user",
				path: path.join(custom, "vendor-helper", "SKILL.md"),
			}),
		]);
	});

	it("resolves a skills.customDirectories skill by name", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-customdir-byname-cwd-"));
		const custom = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-customdir-byname-root-"));
		await makeSkill(custom, "vendor-runbook", "Vendor runbook skill", "Runbook body.");
		const settings = runtimeSkillSettings({ "skills.customDirectories": [custom] });

		const sent: Array<{ content: string }> = [];
		const tool = new SkillTool(
			createSession(cwd, {
				skills: [],
				settings,
				sendCustomMessage: async message => {
					sent.push({ content: String(message.content) });
				},
			}),
		);
		await tool.execute("call", { name: "vendor-runbook" });

		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain("Runbook body.");
	});

	// Naming a directory is explicit consent, so custom directories stay visible when
	// ambient user-scope discovery is switched off. loadSkills applies the same rule.
	it("keeps custom directories visible when user scope trust is disabled", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-customdir-untrusted-cwd-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-customdir-untrusted-home-"));
		const custom = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-customdir-untrusted-root-"));
		const originalHome = process.env.HOME;
		process.env.HOME = home;
		try {
			await makeSkill(path.join(home, ".gjc", "skills"), "ambient-helper", "Ambient user skill");
			await makeSkill(custom, "declared-helper", "Declared custom skill");
			const settings = runtimeSkillSettings({
				"skills.trustUserSkills": false,
				"skills.customDirectories": [custom],
			});

			const result = await new SkillDiscoveryTool(createSession(cwd, { settings })).execute("call", {});
			const names = (result.details?.candidates ?? []).map(candidate => candidate.name);

			expect(names).toContain("declared-helper");
			expect(names).not.toContain("ambient-helper");
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
		}
	});

	it("stops scanning custom directories when skills.enabled is false", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-customdir-off-cwd-"));
		const custom = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-customdir-off-root-"));
		await makeSkill(custom, "disabled-helper", "Disabled custom skill");
		const settings = runtimeSkillSettings({
			"skills.enabled": false,
			"skills.customDirectories": [custom],
		});

		const result = await new SkillDiscoveryTool(createSession(cwd, { settings })).execute("call", {});

		expect(result.details?.candidates).toEqual([]);
	});
});
