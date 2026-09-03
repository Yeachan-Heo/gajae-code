import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "../src/capability/fs";
import { loadSkills } from "../src/extensibility/skills";
import { loadProjectContextFilesResult, loadSystemPromptFiles } from "../src/system-prompt";

const tempRoots: string[] = [];

afterEach(async () => {
	clearCache();
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("native prompt discovery agent directory", () => {
	test("uses the selected agent directory for SYSTEM.md and AGENTS.md", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-prompt-agent-cwd-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-prompt-agent-profile-"));
		tempRoots.push(cwd, agentDir);
		const systemPrompt = "profile system prompt";
		const context = "profile agent instructions";
		await fs.writeFile(path.join(agentDir, "SYSTEM.md"), systemPrompt);
		await fs.writeFile(path.join(agentDir, "AGENTS.md"), context);

		const [resolvedSystemPrompt, resolvedContext] = await Promise.all([
			loadSystemPromptFiles({ cwd, agentDir }),
			loadProjectContextFilesResult({ cwd, agentDir }),
		]);

		expect(resolvedSystemPrompt).toBe(systemPrompt);
		expect(resolvedContext.contextFiles).toEqual([{ path: path.join(agentDir, "AGENTS.md"), content: context }]);
	});

	test("keeps default-profile legacy skill roots with an XDG agent directory", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-agent-cwd-"));
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-agent-home-"));
		tempRoots.push(cwd, home);
		const xdgAgentDir = path.join(home, ".local", "share", "gjc", "agent");
		const legacySkillsDir = path.join(home, ".gjc", "skills");
		const writeSkill = async (root: string, name: string): Promise<void> => {
			const skillDir = path.join(root, name);
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				`---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
			);
		};
		await writeSkill(path.join(xdgAgentDir, "skills"), "xdg-skill");
		await writeSkill(legacySkillsDir, "legacy-skill");

		const result = await loadSkills({
			cwd,
			home,
			agentDir: xdgAgentDir,
			profileAuthority: "default",
			enabled: true,
			trustProjectSkills: true,
			trustUserSkills: true,
		});

		expect(result.skills.map(skill => skill.name)).toEqual(["legacy-skill", "xdg-skill"]);
	});
});
