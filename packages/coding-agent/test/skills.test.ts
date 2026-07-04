import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Skill as CapabilitySkill, skillCapability } from "@gajae-code/coding-agent/capability/skill";
import { getCapability } from "@gajae-code/coding-agent/discovery";
import {
	buildSkillPromptMessage,
	loadSkills,
	loadSkillsFromDir,
	parseSkillInvocations,
	type Skill,
} from "@gajae-code/coding-agent/extensibility/skills";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures/skills");
const collisionFixturesDir = path.resolve(import.meta.dirname, "fixtures/skills-collision");

const longSkillName = "this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard";
const expectedFixtureSkillOrder: string[] = [
	"bad--name",
	"different-name",
	"Invalid_Name",
	longSkillName,
	"unknown-field",
	"valid-skill",
];

function makeSkill(name: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		source: "test",
	};
}

describe("parseSkillInvocations", () => {
	const alpha = makeSkill("alpha");
	const beta = makeSkill("beta");
	const skillsByCommandName = new Map([
		["skill:alpha", alpha],
		["skill:beta", beta],
		["alpha", alpha],
	]);

	it("splits chained canonical skill invocations without treating args as commands", () => {
		expect(parseSkillInvocations("/skill:alpha first /skill:beta second /not-a-skill", skillsByCommandName)).toEqual([
			{ commandName: "skill:alpha", args: "first", skill: alpha },
			{ commandName: "skill:beta", args: "second /not-a-skill", skill: beta },
		]);
	});

	it("preserves multi-line and long arguments in invocation payloads", () => {
		const args = [
			"to re-architect our problem banks into source-based architecture, and",
			"make sure gaebal-gajae skill-invocation modal does not truncate skill args,",
			`${"even though we need few lines to use. ".repeat(20)}END`,
		].join("\n");

		expect(parseSkillInvocations(`/skill:alpha ${args}`, skillsByCommandName)).toEqual([
			{ commandName: "skill:alpha", args, skill: alpha },
		]);
	});

	it("extracts canonical skill invocations from inline prompt text", () => {
		expect(parseSkillInvocations("normal text /skill:alpha later", skillsByCommandName)).toEqual([
			{ commandName: "skill:alpha", args: "normal text later", skill: alpha },
		]);
		expect(parseSkillInvocations("use /skill:alpha and /skill:beta for this", skillsByCommandName)).toEqual([
			{ commandName: "skill:alpha", args: "use and for this", skill: alpha },
			{ commandName: "skill:beta", args: "use and for this", skill: beta },
		]);
	});

	it("does not treat aliases or unknown leading skill commands as invocations", () => {
		expect(parseSkillInvocations("/alpha autocomplete alias is not invocation", skillsByCommandName)).toEqual([]);
		expect(parseSkillInvocations("/skill:unknown /skill:alpha later", skillsByCommandName)).toEqual([]);
	});
});

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		const loadFixtureRoot = () => loadSkillsFromDir({ dir: fixturesDir, source: "test" });

		it("should load a valid skill from a skills root", async () => {
			const { skills, warnings } = await loadFixtureRoot();
			const validSkill = skills.find(skill => skill.name === "valid-skill");

			expect(validSkill).toBeDefined();
			expect(validSkill?.description).toBe("A valid skill for testing purposes.");
			expect(validSkill?.source).toBe("test");
			expect(warnings).toHaveLength(0);
		});

		it("should load skill when name doesn't match parent directory", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "different-name")).toBe(true);
		});

		it("should load skill with invalid name characters", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "Invalid_Name")).toBe(true);
		});

		it("should load skill when name exceeds 64 characters", async () => {
			const { skills } = await loadFixtureRoot();

			expect(
				skills.some(
					skill =>
						skill.name ===
						"this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard",
				),
			).toBe(true);
		});

		it("should skip skill when description is missing", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "missing-description")).toBe(false);
		});

		it("should load skill with unknown frontmatter fields", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "unknown-field")).toBe(true);
		});

		it("should not load nested skills recursively", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "child-skill")).toBe(false);
		});

		it("should skip files without frontmatter description", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "no-frontmatter")).toBe(false);
		});

		it("should load skill with consecutive hyphens in name", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "bad--name")).toBe(true);
		});

		it("should load all directly nested skills from fixture directory", async () => {
			const { skills } = await loadFixtureRoot();
			const names = skills.map(skill => skill.name);

			expect(names).toEqual(
				expect.arrayContaining([
					"valid-skill",
					"different-name",
					"Invalid_Name",
					"this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard",
					"unknown-field",
					"bad--name",
				]),
			);
			expect(names).not.toContain("child-skill");
			expect(skills).toHaveLength(6);
		});

		it("should return skills sorted by name (case-insensitive)", async () => {
			const { skills } = await loadFixtureRoot();
			const names = skills.map(skill => skill.name);

			expect(names).toEqual(expectedFixtureSkillOrder);
		});

		it("should return empty for non-existent directory", async () => {
			const { skills, warnings } = await loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});
			expect(skills).toHaveLength(0);
			expect(warnings).toHaveLength(0);
		});

		it("should return empty when scanning a single skill directory directly", async () => {
			const { skills } = await loadSkillsFromDir({
				dir: path.join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
		});
	});

	describe("loadSkills with options", () => {
		it("should load from customDirectories only when built-ins disabled", async () => {
			const { skills } = await loadSkills({
				enableCodexUser: false,
				enableClaudeUser: false,
				enableClaudeProject: false,
				enablePiUser: false,
				enablePiProject: false,
				customDirectories: [fixturesDir],
			});
			expect(skills.length).toBeGreaterThan(0);
			// Custom directory skills have source "custom:user"
			expect(skills.every(s => s.source.startsWith("custom"))).toBe(true);
		});

		it("should return customDirectory skills sorted by name (case-insensitive)", async () => {
			const { skills } = await loadSkills({
				enableCodexUser: false,
				enableClaudeUser: false,
				enableClaudeProject: false,
				enablePiUser: false,
				enablePiProject: false,
				customDirectories: [fixturesDir],
			});

			expect(skills.map(s => s.name)).toEqual(expectedFixtureSkillOrder);
		});

		it("should ignore Codex and Claude skills even when their source toggles are enabled", async () => {
			const tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-external-skills-home-"));
			const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-external-skills-project-"));

			try {
				for (const root of [
					path.join(tempHomeDir, ".codex", "skills", "codex-user-skill"),
					path.join(tempProjectDir, ".codex", "skills", "codex-project-skill"),
					path.join(tempHomeDir, ".claude", "skills", "claude-user-skill"),
					path.join(tempProjectDir, ".claude", "skills", "claude-project-skill"),
				]) {
					await fs.mkdir(root, { recursive: true });
					await fs.writeFile(
						path.join(root, "SKILL.md"),
						["---", `name: ${path.basename(root)}`, "description: External skill", "---", "", "# External"].join(
							"\n",
						),
					);
				}

				const { skills } = await loadSkills({
					cwd: tempProjectDir,
					enableCodexUser: true,
					enableClaudeUser: true,
					enableClaudeProject: true,
					enablePiUser: false,
					enablePiProject: false,
				});

				expect(skills).toEqual([]);
			} finally {
				await fs.rm(tempProjectDir, { recursive: true, force: true });
				await fs.rm(tempHomeDir, { recursive: true, force: true });
			}
		});

		it("does not register the Claude skill provider by default", async () => {
			const capability = getCapability<CapabilitySkill>(skillCapability.id);
			expect(capability).toBeDefined();
			expect(capability?.providers.some(provider => provider.id === "claude")).toBe(false);
		});

		it("should filter out ignoredSkills", async () => {
			const { skills } = await loadSkills({
				enableCodexUser: false,
				enableClaudeUser: false,
				enableClaudeProject: false,
				enablePiUser: false,
				enablePiProject: false,
				customDirectories: [fixturesDir],
				ignoredSkills: ["valid-skill"],
			});
			expect(skills.some(s => s.name === "valid-skill")).toBe(false);
		});

		it("should support glob patterns in ignoredSkills", async () => {
			const { skills } = await loadSkills({
				enableCodexUser: false,
				enableClaudeUser: false,
				enableClaudeProject: false,
				enablePiUser: false,
				enablePiProject: false,
				customDirectories: [fixturesDir],
				ignoredSkills: ["valid-*"],
			});
			expect(skills.every(s => !s.name.startsWith("valid-"))).toBe(true);
		});

		it("should skip skills disabled via frontmatter", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-disabled-skill-"));
			const skillDir = path.join(tempDir, "disabled-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				`---
name: disabled-skill
description: Should not be discovered.
enabled: false
---

# Disabled Skill
`,
			);

			try {
				const { skills } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					customDirectories: [tempDir],
				});
				expect(skills.some(s => s.name === "disabled-skill")).toBe(false);
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("should have ignoredSkills take precedence over includeSkills", async () => {
			const { skills } = await loadSkills({
				enableCodexUser: false,
				enableClaudeUser: false,
				enableClaudeProject: false,
				enablePiUser: false,
				enablePiProject: false,
				customDirectories: [fixturesDir],
				includeSkills: ["valid-*"],
				ignoredSkills: ["valid-skill"],
			});
			// valid-skill should be excluded even though it matches includeSkills
			expect(skills.every(s => s.name !== "valid-skill")).toBe(true);
		});

		it("should expand ~ in customDirectories", async () => {
			const tempHomeSkillsDir = await fs.mkdtemp(path.join(os.homedir(), ".pi-skills-test-"));
			const relativeToHome = path.relative(os.homedir(), tempHomeSkillsDir);
			const tildeDir = `~/${relativeToHome.split(path.sep).join("/")}`;
			const skillDir = path.join(tempHomeSkillsDir, "tilde-skill");
			const skillPath = path.join(skillDir, "SKILL.md");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				skillPath,
				`---
name: tilde-skill
description: Skill loaded from a tilde-expanded custom directory.
---

# Tilde Skill
`,
			);

			try {
				const { skills: withTilde } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					customDirectories: [tildeDir],
				});
				const { skills: withoutTilde } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					customDirectories: [tempHomeSkillsDir],
				});
				expect(withTilde.length).toBe(withoutTilde.length);
				expect(withTilde.some(skill => skill.name === "tilde-skill")).toBe(true);
			} finally {
				await fs.rm(tempHomeSkillsDir, { recursive: true, force: true });
			}
		});

		it("should return empty when all sources disabled and no custom dirs", async () => {
			const { skills } = await loadSkills({
				enableCodexUser: false,
				enableClaudeUser: false,
				enableClaudeProject: false,
				enablePiUser: false,
				enablePiProject: false,
			});
			expect(skills).toHaveLength(0);
		});

		it("should filter skills with includeSkills glob patterns", async () => {
			// Load all skills from fixtures
			const { skills: allSkills } = await loadSkills({
				enableCodexUser: false,
				enableClaudeUser: false,
				enableClaudeProject: false,
				enablePiUser: false,
				enablePiProject: false,
				customDirectories: [fixturesDir],
			});
			expect(allSkills.length).toBeGreaterThan(0);

			// Filter to only include "valid-skill"
			const { skills: filtered } = await loadSkills({
				enableCodexUser: false,
				enableClaudeUser: false,
				enableClaudeProject: false,
				enablePiUser: false,
				enablePiProject: false,
				customDirectories: [fixturesDir],
				includeSkills: ["valid-skill"],
			});
			expect(filtered).toHaveLength(1);
			expect(filtered[0].name).toBe("valid-skill");
		});

		it("should support glob patterns in includeSkills", async () => {
			const { skills } = await loadSkills({
				enableCodexUser: false,
				enableClaudeUser: false,
				enableClaudeProject: false,
				enablePiUser: false,
				enablePiProject: false,
				customDirectories: [fixturesDir],
				includeSkills: ["valid-*"],
			});
			expect(skills.length).toBeGreaterThan(0);
			expect(skills.every(s => s.name.startsWith("valid-"))).toBe(true);
		});

		it("should return all skills when includeSkills is empty", async () => {
			const { skills: withEmpty } = await loadSkills({
				enableCodexUser: false,
				enableClaudeUser: false,
				enableClaudeProject: false,
				enablePiUser: false,
				enablePiProject: false,
				customDirectories: [fixturesDir],
				includeSkills: [],
			});
			const { skills: withoutOption } = await loadSkills({
				enableCodexUser: false,
				enableClaudeUser: false,
				enableClaudeProject: false,
				enablePiUser: false,
				enablePiProject: false,
				customDirectories: [fixturesDir],
			});
			expect(withEmpty.length).toBe(withoutOption.length);
		});
	});

	describe("collision handling", () => {
		it("should detect name collisions and keep first skill", async () => {
			// Load from first directory
			const first = await loadSkillsFromDir({
				dir: path.join(collisionFixturesDir, "first"),
				source: "first",
			});

			const second = await loadSkillsFromDir({
				dir: path.join(collisionFixturesDir, "second"),
				source: "second",
			});

			// Both directories should have loaded one skill each
			expect(first.skills).toHaveLength(1);
			expect(second.skills).toHaveLength(1);

			// Both have the same name "calendar"
			expect(first.skills[0].name).toBe("calendar");
			expect(second.skills[0].name).toBe("calendar");

			// Simulate the collision behavior from loadSkills()
			const skillMap = new Map<string, Skill>();
			const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

			for (const skill of first.skills) {
				skillMap.set(skill.name, skill);
			}

			for (const skill of second.skills) {
				const existing = skillMap.get(skill.name);
				if (existing) {
					collisionWarnings.push({
						skillPath: skill.filePath,
						message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
					});
				} else {
					skillMap.set(skill.name, skill);
				}
			}

			expect(skillMap.size).toBe(1);
			expect(skillMap.get("calendar")?.source).toBe("first");
			expect(collisionWarnings).toHaveLength(1);
			expect(collisionWarnings[0].message).toContain("name collision");
		});
	});

	describe("buildSkillPromptMessage", () => {
		it("preserves multi-line and long args in the actual prompt payload and details", async () => {
			const args = [
				"to re-architect our problem banks into source-based architecture, and",
				"make sure gaebal-gajae skill-invocation modal does not truncate skill args,",
				`${"even though we need few lines to use. ".repeat(20)}END`,
			].join("\n");
			const skill = {
				...makeSkill("alpha"),
				content: "---\nname: alpha\ndescription: Alpha\n---\n\n# Alpha\nDo work.",
			};

			const built = await buildSkillPromptMessage(skill, args);

			expect(built.details.args).toBe(args);
			expect(built.message).toContain(`User: ${args}`);
			expect(built.message).toContain("END");
		});
	});
});
