import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const expectedWorkflowSkills = ["deep-interview", "ralplan", "team", "ultragoal"];

describe("GJC dogfood skill template", () => {
	it("documents local override installation without changing the default workflow surface", async () => {
		const template = await Bun.file(path.join(repoRoot, "docs", "gjc-dogfood-skill-template.md")).text();
		const defaultSkillsDir = path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills");
		const defaultSkillEntries = await Array.fromAsync(new Bun.Glob("*/SKILL.md").scan(defaultSkillsDir));
		const defaultSkillNames = defaultSkillEntries.map(entry => entry.split("/")[0]).sort();

		expect(defaultSkillNames).toEqual(expectedWorkflowSkills);
		expect(template).toContain("~/.gjc/skills/gjc-dogfood/SKILL.md");
		expect(template).toContain("<project>/.gjc/skills/gjc-dogfood/SKILL.md");
		expect(template).toContain("The live issue has no comment approving a fifth bundled default workflow skill");
		expect(template).toContain("Use when running or reviewing work through GJC sessions");
		expect(template).toContain("gjc --tmux --worktree <path>");
		expect(template).toContain("gajae-code-93-dogfood-skill");
		expect(template).toContain("Verify the prompt was accepted");
		expect(template).toContain("create or link the gajae-code issue");
	});
});
