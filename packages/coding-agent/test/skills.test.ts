import { describe, expect, it, vi } from "bun:test";
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
	resolveSkillSlashCommands,
	type Skill,
} from "@gajae-code/coding-agent/extensibility/skills";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";

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

	it("matches canonical skill invocations case-insensitively", () => {
		expect(parseSkillInvocations("/Skill:alpha first /SKILL:beta second", skillsByCommandName)).toEqual([
			{ commandName: "Skill:alpha", args: "first", skill: alpha },
			{ commandName: "SKILL:beta", args: "second", skill: beta },
		]);
	});

	it("deduplicates case-only skill command names consistently", () => {
		const first = makeSkill("Foo");
		const second = makeSkill("foo");

		expect(resolveSkillSlashCommands([first, second], new Set())).toEqual([
			{ name: "skill:Foo", description: "Foo description", skill: first },
		]);
		expect(
			parseSkillInvocations(
				"/SKILL:foo",
				new Map([
					["skill:Foo", first],
					["skill:foo", second],
				]),
			),
		).toEqual([{ commandName: "SKILL:foo", args: "", skill: first }]);
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
			// The fixture root also contains skills with missing descriptions and
			// missing frontmatter; those must produce actionable diagnostics
			// instead of silent skips.
			expect(warnings.some(w => w.message.includes("missing a description"))).toBe(true);
			expect(warnings.some(w => w.message.includes("no parseable frontmatter"))).toBe(true);
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

		it("never loads Claude/Codex convention skills at runtime; they are import sources only", async () => {
			const tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-external-skills-home-"));
			const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-external-skills-project-"));
			const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);

			try {
				for (const root of [
					path.join(tempProjectDir, ".codex", "skills", "codex-project-skill"),
					path.join(tempProjectDir, ".claude", "skills", "claude-project-skill"),
					path.join(tempHomeDir, ".codex", "skills", "codex-user-skill"),
					path.join(tempHomeDir, ".claude", "skills", "claude-user-skill"),
					path.join(tempProjectDir, ".gjc", "skills", "native-project-skill"),
				]) {
					await fs.mkdir(root, { recursive: true });
					await fs.writeFile(
						path.join(root, "SKILL.md"),
						["---", `name: ${path.basename(root)}`, "description: External skill", "---", "", "# External"].join(
							"\n",
						),
					);
				}

				// Even with every legacy convention toggle enabled, `.claude` and
				// `.codex` layouts are explicit import sources into `.gjc`: they are
				// never loaded as session skills. Only the native location loads.
				const { skills } = await loadSkills({
					cwd: tempProjectDir,
					enableCodexUser: true,
					enableClaudeUser: true,
					enableClaudeProject: true,
				});

				expect(skills.map(skill => skill.name)).toEqual(["native-project-skill"]);
				expect(skills[0]?.source).toBe("native:project");
			} finally {
				homedirSpy.mockRestore();
				await safeRm(tempProjectDir, { recursive: true, force: true });
				await safeRm(tempHomeDir, { recursive: true, force: true });
			}
		});

		it("does not register Claude/Codex skill capability providers", async () => {
			const capability = getCapability<CapabilitySkill>(skillCapability.id);
			expect(capability).toBeDefined();
			const providers = capability?.providers ?? [];
			for (const id of ["claude", "codex"]) {
				expect(providers.some(provider => provider.id === id)).toBe(false);
			}
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
				await safeRm(tempDir, { recursive: true, force: true });
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
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tilde-home-"));
			const tempHomeSkillsDir = path.join(tempHome, "skills");
			const relativeToHome = path.relative(tempHome, tempHomeSkillsDir);
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
					home: tempHome,
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					customDirectories: [tildeDir],
				});
				const { skills: withoutTilde } = await loadSkills({
					home: tempHome,
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
				await safeRm(tempHome, { recursive: true, force: true });
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

		it("discovers native project and user skills with zero configuration", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-zero-config-skills-"));
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-zero-config-home-"));
			const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
			// The user skill scope is the agent directory (the trusted-home
			// snapshot ignores the os.homedir mock), so isolate exactly that.
			const originalAgentDir = getAgentDir();
			setAgentDir(path.join(tempHome, ".gjc", "agent"));
			try {
				for (const [root, name] of [
					[path.join(tempDir, ".gjc", "skills", "project-skill"), "project-skill"],
					[path.join(tempDir, ".claude", "skills", "claude-skill"), "claude-skill"],
					[path.join(tempDir, ".codex", "skills", "codex-skill"), "codex-skill"],
					[path.join(tempHome, ".gjc", "agent", "skills", "user-skill"), "user-skill"],
				]) {
					await fs.mkdir(root, { recursive: true });
					await fs.writeFile(
						path.join(root, "SKILL.md"),
						["---", `name: ${name}`, "description: Zero-config skill", "---", "", `# ${name}`].join("\n"),
					);
				}

				// No explicit settings at all: filesystem skill discovery is on by
				// default and every canonical native location is loaded. Claude/Codex
				// convention copies are import sources and never load directly.
				const { skills } = await loadSkills({ cwd: tempDir });
				expect(skills.map(skill => skill.name).sort()).toEqual(["project-skill", "user-skill"]);
			} finally {
				setAgentDir(originalAgentDir);
				homedirSpy.mockRestore();
				await safeRm(tempDir, { recursive: true, force: true });
				await safeRm(tempHome, { recursive: true, force: true });
			}
		});

		it("honors the injected home profile without reading the process profile", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-injected-home-skills-"));
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-injected-home-root-"));
			const originalAgentDir = getAgentDir();
			const decoyAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-injected-home-decoy-"));
			setAgentDir(decoyAgentDir);
			try {
				await fs.mkdir(path.join(tempHome, ".gjc", "agent", "skills", "injected-skill"), { recursive: true });
				await fs.writeFile(
					path.join(tempHome, ".gjc", "agent", "skills", "injected-skill", "SKILL.md"),
					["---", "name: injected-skill", "description: Injected home skill", "---", "", "# injected"].join("\n"),
				);
				await fs.mkdir(path.join(tempHome, ".gjc", "skills", "legacy-skill"), { recursive: true });
				await fs.writeFile(
					path.join(tempHome, ".gjc", "skills", "legacy-skill", "SKILL.md"),
					["---", "name: legacy-skill", "description: Injected legacy skill", "---", "", "# legacy"].join("\n"),
				);
				await fs.mkdir(path.join(decoyAgentDir, "skills", "decoy-skill"), { recursive: true });
				await fs.writeFile(
					path.join(decoyAgentDir, "skills", "decoy-skill", "SKILL.md"),
					["---", "name: decoy-skill", "description: Decoy skill", "---", "", "# decoy"].join("\n"),
				);

				const { skills } = await loadSkills({ cwd: tempDir, home: tempHome });
				expect(skills.map(skill => skill.name)).toContain("injected-skill");
				expect(skills.map(skill => skill.name)).toContain("legacy-skill");
				expect(skills.map(skill => skill.name)).not.toContain("decoy-skill");
			} finally {
				setAgentDir(originalAgentDir);
				await safeRm(tempDir, { recursive: true, force: true });
				await safeRm(tempHome, { recursive: true, force: true });
				await safeRm(decoyAgentDir, { recursive: true, force: true });
			}
		});

		it("project scope shadows user scope, and the nearest project ancestor wins", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-precedence-skills-"));
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-precedence-home-"));
			const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
			const originalAgentDir = getAgentDir();
			setAgentDir(path.join(tempHome, ".gjc", "agent"));
			try {
				// Mark the repo root so the ancestor walk covers the nested package.
				await fs.mkdir(path.join(tempDir, ".git"));
				const nested = path.join(tempDir, "packages", "nested");
				const write = async (root: string, name: string, body: string) => {
					await fs.mkdir(root, { recursive: true });
					await fs.writeFile(
						path.join(root, "SKILL.md"),
						["---", `name: ${name}`, "description: shared skill", "---", "", body].join("\n"),
					);
				};
				await write(path.join(tempHome, ".gjc", "agent", "skills", "shared"), "shared", "user body");
				await write(path.join(tempDir, ".gjc", "skills", "shared"), "shared", "root body");
				await write(path.join(nested, ".gjc", "skills", "shared"), "shared", "nested body");

				const { skills, warnings } = await loadSkills({ cwd: nested });
				const shared = skills.find(skill => skill.name === "shared");
				expect(shared).toBeDefined();
				expect(shared?.source).toBe("native:project");
				expect(shared?.filePath).toContain(path.join(nested, ".gjc", "skills", "shared"));
				// Shadowed duplicates are diagnosed, not silent: root project copy and
				// the user copy both collide with the nearest-ancestor winner.
				expect(warnings.filter(w => w.message.includes("name collision")).length).toBe(2);

				// Drop the nested copy: the repo-root project copy still beats user.
				await safeRm(path.join(nested, ".gjc"), { recursive: true, force: true });
				const { skills: next } = await loadSkills({ cwd: nested });
				expect(next.find(skill => skill.name === "shared")?.filePath).toContain(
					path.join(tempDir, ".gjc", "skills", "shared"),
				);

				// Drop all project copies: the user copy finally wins.
				await safeRm(path.join(tempDir, ".gjc"), { recursive: true, force: true });
				const { skills: userWins } = await loadSkills({ cwd: nested });
				expect(userWins.find(skill => skill.name === "shared")?.filePath).toContain(
					path.join(tempHome, ".gjc", "agent", "skills", "shared"),
				);
			} finally {
				setAgentDir(originalAgentDir);
				homedirSpy.mockRestore();
				await safeRm(tempDir, { recursive: true, force: true });
				await safeRm(tempHome, { recursive: true, force: true });
			}
		});

		it("keeps the legacy alias working and never lets disk skills replace bundled workflows", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-protected-skills-"));
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-protected-home-"));
			const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
			try {
				const root = path.join(tempDir, ".gjc", "skills", "ralplan");
				await fs.mkdir(root, { recursive: true });
				await fs.writeFile(
					path.join(root, "SKILL.md"),
					["---", "name: RalPlan", "description: On-disk impostor", "---", "", "# Impostor"].join("\n"),
				);

				// The disk copy is still scanned (installed defaults are a documented
				// surface), but the session merge in sdk/session.ts keeps the bundled
				// definition authoritative (covered by sdk-skills.test.ts) and the
				// project-scope copy is diagnosed as a protected-name collision.
				const { skills, warnings } = await loadSkills({ cwd: tempDir, home: tempHome });
				expect(skills.some(skill => skill.name === "RalPlan")).toBe(true);
				expect(warnings.some(w => w.message.includes("bundled GJC workflow skill"))).toBe(true);

				// The legacy alias still disables the scope explicitly.
				const legacyDisabled = await loadSkills({ cwd: tempDir, enablePiProject: false });
				expect(legacyDisabled.skills).toHaveLength(0);
			} finally {
				homedirSpy.mockRestore();
				await safeRm(tempDir, { recursive: true, force: true });
				await safeRm(tempHome, { recursive: true, force: true });
			}
		});

		it("trust flags disable their scope while the master switch disables everything", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-trust-skills-"));
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-trust-home-"));
			const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
			const originalAgentDir = getAgentDir();
			setAgentDir(path.join(tempHome, ".gjc", "agent"));
			try {
				const write = async (root: string, name: string) => {
					await fs.mkdir(root, { recursive: true });
					await fs.writeFile(
						path.join(root, "SKILL.md"),
						["---", `name: ${name}`, `description: ${name} body`, "---", "", `# ${name}`].join("\n"),
					);
				};
				await write(path.join(tempDir, ".gjc", "skills", "project-helper"), "project-helper");
				await write(path.join(tempHome, ".gjc", "agent", "skills", "user-helper"), "user-helper");

				const userOff = await loadSkills({ cwd: tempDir, trustUserSkills: false });
				expect(userOff.skills.map(s => s.name)).toEqual(["project-helper"]);

				const projectOff = await loadSkills({ cwd: tempDir, trustProjectSkills: false });
				expect(projectOff.skills.map(s => s.name)).toEqual(["user-helper"]);

				const allOff = await loadSkills({ cwd: tempDir, trustProjectSkills: false, trustUserSkills: false });
				expect(allOff.skills).toHaveLength(0);

				const masterOff = await loadSkills({ cwd: tempDir, enabled: false });
				expect(masterOff.skills).toHaveLength(0);
			} finally {
				setAgentDir(originalAgentDir);
				homedirSpy.mockRestore();
				await safeRm(tempDir, { recursive: true, force: true });
				await safeRm(tempHome, { recursive: true, force: true });
			}
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

		it("keeps project scope authoritative across case-variant names", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-case-precedence-skills-"));
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-case-precedence-home-"));
			try {
				await fs.mkdir(path.join(tempDir, ".git"));
				const projectDir = path.join(tempDir, ".gjc", "skills", "foo");
				const userDir = path.join(tempHome, ".gjc", "agent", "skills", "Foo");
				await fs.mkdir(projectDir, { recursive: true });
				await fs.mkdir(userDir, { recursive: true });
				const skillFile = (name: string, body: string) =>
					["---", `name: ${name}`, "description: case variant", "---", "", body].join("\n");
				await fs.writeFile(path.join(projectDir, "SKILL.md"), skillFile("foo", "project body"));
				await fs.writeFile(path.join(userDir, "SKILL.md"), skillFile("Foo", "user body"));

				const { skills, warnings } = await loadSkills({ cwd: tempDir, home: tempHome });
				const matches = skills.filter(skill => skill.name.toLowerCase() === "foo");
				expect(matches).toHaveLength(1);
				expect(matches[0]?.source).toBe("native:project");
				expect(matches[0]?.filePath).toBe(path.join(projectDir, "SKILL.md"));
				expect(warnings.some(w => w.message.includes('name collision: "Foo"'))).toBe(true);
			} finally {
				await safeRm(tempDir, { recursive: true, force: true });
				await safeRm(tempHome, { recursive: true, force: true });
			}
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
