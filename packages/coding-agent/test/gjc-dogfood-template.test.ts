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
		// Install path must target the scanned user-level location, frontmatter-first.
		expect(template).toContain("mkdir -p ~/.gjc/agent/skills/gjc-dogfood");
		expect(template).toContain(
			"sed -n '/^---$/,$p' docs/gjc-dogfood-skill-template.md > ~/.gjc/agent/skills/gjc-dogfood/SKILL.md",
		);
		expect(template).toContain(
			"Install into the user-level scan location (`~/.gjc/agent/skills/`, not `~/.gjc/skills/`):",
		);
		expect(template).toContain("<project>/.gjc/skills/gjc-dogfood/SKILL.md");
		expect(template).toContain("The live issue has no comment approving a fifth bundled default workflow skill");
		expect(template).toContain("Use when running or reviewing work through GJC sessions");
		expect(template).toContain("gjc --tmux --worktree <branch-like-name>");
		expect(template).toContain("Do not pass filesystem paths to `--worktree`");
		expect(template).toContain("gajae-code-93-dogfood-skill");
		expect(template).toContain("Verify the prompt was accepted");
		expect(template).toContain("create or link the gajae-code issue");
	});

	it("keeps the installable body frontmatter-first so the skill scan accepts it", async () => {
		const template = await Bun.file(path.join(repoRoot, "docs", "gjc-dogfood-skill-template.md")).text();
		const lines = template.split("\n");
		const markerIndex = lines.indexOf("---");
		expect(markerIndex).toBeGreaterThan(0);
		// The extracted artifact starts at the marker; name/description must follow immediately.
		expect(lines[markerIndex + 1]).toBe("name: gjc-dogfood");
		expect(lines[markerIndex + 2]?.startsWith("description: ")).toBe(true);
		const closingIndex = lines.indexOf("---", markerIndex + 1);
		expect(closingIndex).toBeGreaterThan(markerIndex);
	});
});
