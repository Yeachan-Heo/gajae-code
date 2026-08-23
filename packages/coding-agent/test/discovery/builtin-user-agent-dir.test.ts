import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import type { ContextFile } from "../../src/capability/context-file";
import { contextFileCapability } from "../../src/capability/context-file";
import type { Rule } from "../../src/capability/rule";
import { ruleCapability } from "../../src/capability/rule";
import type { Settings } from "../../src/capability/settings";
import { settingsCapability } from "../../src/capability/settings";
import type { Skill } from "../../src/capability/skill";
import { skillCapability } from "../../src/capability/skill";
import { slashCommandCapability } from "../../src/capability/slash-command";
import type { SystemPrompt } from "../../src/capability/system-prompt";
import { systemPromptCapability } from "../../src/capability/system-prompt";
import type { CapabilityResult } from "../../src/capability/types";
import { loadCapability } from "../../src/discovery";
import { writeNativeSkill } from "../../src/extensibility/skill-management";

import "../../src/discovery";

const originalAgentDir = getAgentDir();
const originalGjcAgentDir = process.env.GJC_CODING_AGENT_DIR;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;

let root = "";
let cwd = "";
let home = "";
let agentDir = "";

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

async function loadNative<T>(capabilityId: string): Promise<CapabilityResult<T>> {
	return await loadCapability<T>(capabilityId, { cwd, providers: ["native"] });
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-agent-dir-"));
	cwd = path.join(root, "project");
	home = path.join(root, "home");
	agentDir = path.join(root, "profile");
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	process.env.GJC_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODING_AGENT_DIR;
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (originalGjcAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = originalGjcAgentDir;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	await fs.rm(root, { recursive: true, force: true });
});

describe("native user scope under GJC_CODING_AGENT_DIR", () => {
	it("loads config, SYSTEM.md, skills, RULES.md, and AGENTS.md from the resolved profile", async () => {
		// A decoy in the default home-relative location proves the provider does
		// not silently fall back to the operator's default profile.
		await writeFile(path.join(home, ".gjc", "agent", "SYSTEM.md"), "wrong system prompt\n");
		await writeFile(path.join(agentDir, "SYSTEM.md"), "profile system prompt\n");
		await writeFile(path.join(agentDir, "RULES.md"), "profile sticky rule\n");
		await writeFile(path.join(agentDir, "AGENTS.md"), "profile context instructions\n");
		await writeFile(path.join(agentDir, "config.yml"), "skills:\n  enabled: true\n");
		await writeNativeSkill({
			cwd,
			agentDir,
			scope: "user",
			name: "profile-skill",
			content: "---\nname: profile-skill\ndescription: Profile skill\n---\n\nprofile body\n",
		});

		const [settings, system, skills, rules, context] = await Promise.all([
			loadNative<Settings>(settingsCapability.id),
			loadNative<SystemPrompt>(systemPromptCapability.id),
			loadNative<Skill>(skillCapability.id),
			loadNative<Rule>(ruleCapability.id),
			loadNative<ContextFile>(contextFileCapability.id),
		]);

		expect(
			settings.items.some(item => item.level === "user" && item.path === path.join(agentDir, "config.yml")),
		).toBe(true);
		expect(system.items.map(item => item.path)).toEqual([path.join(agentDir, "SYSTEM.md")]);
		expect(skills.items.map(item => item.name)).toContain("profile-skill");
		expect(skills.items.find(item => item.name === "profile-skill")?._source.path).toBe(
			path.join(agentDir, "skills", "profile-skill", "SKILL.md"),
		);
		expect(rules.items.find(item => item.name === "RULES")?.path).toBe(path.join(agentDir, "RULES.md"));
		expect(context.items.map(item => item.path)).toEqual([path.join(agentDir, "AGENTS.md")]);
	});

	it("keeps a valid profile config visible when project config is malformed", async () => {
		await writeFile(path.join(cwd, ".gjc", "config.yml"), "skills: [\n");
		await writeFile(path.join(agentDir, "config.yml"), "skills:\n  enabled: true\n");

		const result = await loadNative<Settings>(settingsCapability.id);
		expect(result.items.some(item => item.level === "user" && item.path === path.join(agentDir, "config.yml"))).toBe(
			true,
		);
		expect(result.warnings.some(warning => warning.includes(path.join(cwd, ".gjc", "config.yml")))).toBe(true);
	});

	it("keeps explicit profile config, AGENTS, and shared config-dir consumers off decoy roots", async () => {
		const decoyAgentDir = path.join(root, "global-decoy-agent");
		await writeFile(path.join(decoyAgentDir, "config.yml"), "skills:\n  enabled: false\n");
		await writeFile(path.join(decoyAgentDir, "AGENTS.md"), "decoy agents\n");
		await writeFile(path.join(decoyAgentDir, "commands", "decoy.md"), "decoy command\n");
		await writeFile(path.join(agentDir, "config.yml"), "skills:\n  enabled: true\n");
		await writeFile(path.join(agentDir, "AGENTS.md"), "profile agents\n");
		await writeFile(path.join(agentDir, "commands", "profile.md"), "profile command\n");

		setAgentDir(decoyAgentDir);
		const loadExplicit = async <T>(capabilityId: string) =>
			await loadCapability<T>(capabilityId, { cwd, agentDir, providers: ["native"] });
		const [settings, context, commands] = await Promise.all([
			loadExplicit<Settings>(settingsCapability.id),
			loadExplicit<ContextFile>(contextFileCapability.id),
			loadExplicit<{ name: string; content: string }>(slashCommandCapability.id),
		]);

		expect(
			settings.items.some(item => item.level === "user" && item.path === path.join(agentDir, "config.yml")),
		).toBe(true);
		expect(context.items.map(item => item.content)).toEqual(["profile agents\n"]);
		expect(commands.items.map(item => item.name)).toEqual(["profile"]);
	});
});
