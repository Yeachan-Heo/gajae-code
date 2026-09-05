import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	isNativeSkillEnabled,
	listConventionSkillImportSources,
	listNativeSkillsForManagement,
	SkillFrontmatterError,
	SkillNameProtectedError,
	setNativeSkillEnabled,
	writeNativeSkill,
} from "../src/extensibility/skill-management";

async function makeSkill(root: string, name: string, description: string): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "SKILL.md");
	await fs.writeFile(
		filePath,
		["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`].join("\n"),
	);
	return filePath;
}

async function withTempDirs(run: (cwd: string, home: string) => Promise<void>): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-mgmt-project-"));
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-mgmt-home-"));
	try {
		await run(cwd, home);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
		await fs.rm(home, { recursive: true, force: true });
	}
}

describe("skill-management", () => {
	describe("listNativeSkillsForManagement", () => {
		it("lists project and user native skills with provenance and enablement state", async () => {
			await withTempDirs(async (cwd, home) => {
				await makeSkill(path.join(cwd, ".gjc", "skills"), "project-helper", "Project helper");
				await makeSkill(path.join(home, ".gjc", "agent", "skills"), "user-helper", "User helper");
				await makeSkill(path.join(cwd, ".gjc", "skills"), "ralplan", "Bundled impostor");
				await makeSkill(path.join(cwd, ".gjc", "skills"), "ignored-helper", "Ignored helper");
				await makeSkill(path.join(cwd, ".gjc", "skills"), "disabled-helper", "Disabled helper");

				const records = await listNativeSkillsForManagement({
					cwd,
					home,
					policy: { ignoredSkills: ["ignored-*"], disabledExtensions: ["skill:disabled-helper"] },
				});
				const byName = new Map(records.map(record => [record.name, record]));

				expect(byName.get("project-helper")).toMatchObject({
					scope: "project",
					source: "project .gjc/skills",
					enabled: true,
				});
				const userRecord = byName.get("user-helper");
				expect(userRecord?.scope).toBe("user");
				expect(userRecord?.source).toContain(path.join(".gjc", "agent", "skills"));
				expect(userRecord?.enabled).toBe(true);
				expect(byName.get("ralplan")).toMatchObject({ enabled: false, disabledReason: "protected" });
				expect(byName.get("ignored-helper")).toMatchObject({ enabled: false, disabledReason: "ignored" });
				expect(byName.get("disabled-helper")).toMatchObject({
					enabled: false,
					disabledReason: "disabled-extension",
				});
			});
		});

		it("resolves name collisions deterministically: the project copy wins over user", async () => {
			await withTempDirs(async (cwd, home) => {
				await makeSkill(path.join(home, ".gjc", "agent", "skills"), "shared", "User copy");
				await makeSkill(path.join(cwd, ".gjc", "skills"), "shared", "Project copy");

				const records = await listNativeSkillsForManagement({ cwd, home });
				const shared = records.filter(record => record.name === "shared");
				expect(shared).toHaveLength(1);
				expect(shared[0]?.scope).toBe("project");
				expect(shared[0]?.description).toBe("Project copy");
			});
		});

		it("does not scan an untrusted scope at all", async () => {
			await withTempDirs(async (cwd, home) => {
				await makeSkill(path.join(cwd, ".gjc", "skills"), "project-helper", "Project helper");
				await makeSkill(path.join(home, ".gjc", "agent", "skills"), "user-helper", "User helper");

				const records = await listNativeSkillsForManagement({
					cwd,
					home,
					policy: { trustProjectSkills: false },
				});
				expect(records.map(record => record.name)).toEqual(["user-helper"]);
			});
		});
	});

	describe("writeNativeSkill", () => {
		const validContent = ["---", "name: my-skill", "description: A managed skill", "---", "", "# my-skill"].join(
			"\n",
		);

		it("writes project skills into the repo-root .gjc/skills directory", async () => {
			await withTempDirs(async (cwd, home) => {
				await fs.mkdir(path.join(cwd, ".git"));
				const nested = path.join(cwd, "pkg");
				await fs.mkdir(nested);

				const receipt = await writeNativeSkill({
					cwd: nested,
					home,
					scope: "project",
					name: "my-skill",
					content: validContent,
				});
				expect(receipt.path).toBe(path.join(cwd, ".gjc", "skills", "my-skill", "SKILL.md"));
				const written = await fs.readFile(receipt.path, "utf8");
				expect(written).toContain("description: A managed skill");
			});
		});

		it("writes user skills into the canonical agent skills root", async () => {
			await withTempDirs(async (cwd, home) => {
				const receipt = await writeNativeSkill({
					cwd,
					home,
					scope: "user",
					name: "my-skill",
					content: validContent,
				});
				expect(receipt.path).toBe(path.join(home, ".gjc", "agent", "skills", "my-skill", "SKILL.md"));
			});
		});

		it("keeps an explicit agent profile isolated for listing and writes", async () => {
			await withTempDirs(async (cwd, home) => {
				const profileDir = path.join(home, "profiles", "review");
				await makeSkill(path.join(home, ".gjc", "agent", "skills"), "default-only", "Default profile skill");
				await makeSkill(path.join(profileDir, "skills"), "profile-only", "Review profile skill");

				const records = await listNativeSkillsForManagement({
					cwd,
					home,
					agentDir: profileDir,
					profileAuthority: "custom",
				});
				expect(records.map(record => record.name)).toEqual(["profile-only"]);

				const receipt = await writeNativeSkill({
					cwd,
					home,
					agentDir: profileDir,
					scope: "user",
					name: "written-profile",
					content: validContent.replace("name: my-skill", "name: written-profile"),
				});
				expect(receipt.path).toBe(path.join(profileDir, "skills", "written-profile", "SKILL.md"));
			});
		});

		it("rejects bundled workflow skill names", async () => {
			await withTempDirs(async (cwd, home) => {
				for (const name of ["ultragoal", "Ultragoal"]) {
					const protectedContent = ["---", `name: ${name}`, "description: Impostor", "---", "", "# x"].join("\n");
					await expect(
						writeNativeSkill({ cwd, home, scope: "project", name, content: protectedContent }),
					).rejects.toBeInstanceOf(SkillNameProtectedError);
				}
			});
		});

		it("rejects path traversal names and symlinked destinations", async () => {
			await withTempDirs(async (cwd, home) => {
				const traversalContent = validContent.replace("name: my-skill", "name: ../outside");
				await expect(
					writeNativeSkill({ cwd, home, scope: "user", name: "outside", content: traversalContent }),
				).rejects.toBeInstanceOf(SkillFrontmatterError);

				const skillsDir = path.join(home, ".gjc", "agent", "skills");
				const outsideDir = path.join(home, "outside");
				await fs.mkdir(skillsDir, { recursive: true });
				await fs.mkdir(outsideDir);
				await fs.symlink(outsideDir, path.join(skillsDir, "my-skill"), "dir");
				await expect(
					writeNativeSkill({ cwd, home, scope: "user", name: "my-skill", content: validContent }),
				).rejects.toBeInstanceOf(SkillFrontmatterError);
				await expect(fs.stat(path.join(outsideDir, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
			});
		});

		it("rejects content without frontmatter or without a description", async () => {
			await withTempDirs(async (cwd, home) => {
				await expect(
					writeNativeSkill({ cwd, home, scope: "project", name: "plain", content: "# no frontmatter\n" }),
				).rejects.toBeInstanceOf(SkillFrontmatterError);
				await expect(
					writeNativeSkill({
						cwd,
						home,
						scope: "project",
						name: "nodesc",
						content: "---\nname: nodesc\n---\n\n# x\n",
					}),
				).rejects.toBeInstanceOf(SkillFrontmatterError);
			});
		});
	});

	describe("setNativeSkillEnabled / isNativeSkillEnabled", () => {
		it("toggles the skill:<name> disabledExtensions entry", () => {
			expect(setNativeSkillEnabled("my-skill", false, [])).toEqual(["skill:my-skill"]);
			expect(setNativeSkillEnabled("my-skill", true, ["skill:my-skill", "skill:other"])).toEqual(["skill:other"]);
		});

		it("never disables bundled workflow skills", () => {
			expect(setNativeSkillEnabled("ralplan", false, [])).toEqual([]);
			expect(setNativeSkillEnabled("Ralplan", false, [])).toEqual([]);
			expect(isNativeSkillEnabled("ralplan", { disabledExtensions: ["skill:ralplan"] })).toBe(true);
			expect(isNativeSkillEnabled("Ralplan", { disabledExtensions: ["skill:Ralplan"] })).toBe(true);
		});

		it("reflects ignore/include policy", () => {
			expect(isNativeSkillEnabled("x", { ignoredSkills: ["x"] })).toBe(false);
			expect(isNativeSkillEnabled("x", { includeSkills: ["y"] })).toBe(false);
			expect(isNativeSkillEnabled("x", { includeSkills: ["x"] })).toBe(true);
		});
	});

	describe("listConventionSkillImportSources", () => {
		it("enumerates Claude Code and Codex skills with host and scope provenance", async () => {
			await withTempDirs(async (cwd, home) => {
				await makeSkill(path.join(cwd, ".claude", "skills"), "claude-project", "Claude project");
				await makeSkill(path.join(cwd, ".codex", "skills"), "codex-project", "Codex project");
				await makeSkill(path.join(home, ".claude", "skills"), "claude-user", "Claude user");
				await makeSkill(path.join(home, ".codex", "skills"), "codex-user", "Codex user");

				const sources = await listConventionSkillImportSources({ cwd, home });
				const byKey = new Map(sources.map(source => [`${source.host}:${source.scope}:${source.name}`, source]));
				expect(byKey.get("claude:project:claude-project")?.path).toContain(path.join(".claude", "skills"));
				expect(byKey.get("codex:project:codex-project")?.path).toContain(path.join(".codex", "skills"));
				expect(byKey.get("claude:user:claude-user")?.path).toContain(path.join(".claude", "skills"));
				expect(byKey.get("codex:user:codex-user")?.path).toContain(path.join(".codex", "skills"));
			});
		});

		it("honors the host filter", async () => {
			await withTempDirs(async (cwd, home) => {
				await makeSkill(path.join(cwd, ".claude", "skills"), "claude-project", "Claude project");
				await makeSkill(path.join(cwd, ".codex", "skills"), "codex-project", "Codex project");

				const sources = await listConventionSkillImportSources({ cwd, home, host: "claude" });
				expect(sources.map(source => source.name)).toEqual(["claude-project"]);
			});
		});
	});
});
