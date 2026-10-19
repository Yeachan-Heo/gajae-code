import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadSkills } from "@gajae-code/coding-agent/extensibility/skills";
import { YAML } from "bun";

const SKILL_NAME = "repo-owned-skill";

type ProjectSurface = "gjc-settings" | "gjc-config" | "cursor-settings";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

async function writeProjectSkills(
	project: string,
	surface: ProjectSurface,
	skills: Record<string, unknown>,
): Promise<void> {
	if (surface === "cursor-settings") {
		await Bun.write(path.join(project, ".cursor", "settings.json"), JSON.stringify({ skills }));
		return;
	}
	const file = surface === "gjc-settings" ? "settings.json" : "config.yml";
	const body = surface === "gjc-settings" ? JSON.stringify({ skills }) : YAML.stringify({ skills });
	await Bun.write(path.join(project, ".gjc", file), body);
}

async function loadProjectSkill(options: {
	globalSkills: Record<string, unknown>;
	surface?: ProjectSurface;
	projectSkills?: Record<string, unknown>;
}): Promise<{ settings: Settings; names: string[] }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-trust-"));
	roots.push(root);
	const project = path.join(root, "proj");
	const agent = path.join(root, "agent");
	const home = path.join(root, "home");
	await fs.mkdir(project, { recursive: true });
	await fs.mkdir(agent, { recursive: true });
	await fs.mkdir(home, { recursive: true });
	const skillDir = path.join(project, ".gjc", "skills", SKILL_NAME);
	await fs.mkdir(skillDir, { recursive: true });
	await Bun.write(
		path.join(skillDir, "SKILL.md"),
		["---", `name: ${SKILL_NAME}`, "description: repository skill", "---", "", "# body"].join("\n"),
	);
	await Bun.write(path.join(agent, "config.yml"), YAML.stringify({ skills: options.globalSkills }));
	if (options.surface && options.projectSkills) {
		await writeProjectSkills(project, options.surface, options.projectSkills);
	}
	const settings = await Settings.loadReadonly({ cwd: project, agentDir: agent });
	try {
		const loaded = await loadSkills({
			...settings.getGroup("skills"),
			cwd: project,
			home,
			agentDir: agent,
			disabledExtensions: settings.get("disabledExtensions"),
		});
		return { settings, names: loaded.skills.map(skill => skill.name) };
	} catch (error) {
		await settings.close();
		throw error;
	}
}

describe("project skill trust stays on the user config", () => {
	const surfaces: ProjectSurface[] = ["gjc-settings", "gjc-config", "cursor-settings"];

	for (const surface of surfaces) {
		it(`does not let ${surface} turn a user skills.trustProjectSkills false into true`, async () => {
			const { settings, names } = await loadProjectSkill({
				globalSkills: { enabled: true, trustProjectSkills: false },
				surface,
				projectSkills: { trustProjectSkills: true },
			});
			try {
				expect(settings.getGlobal("skills.trustProjectSkills")).toBe(false);
				expect(settings.get("skills.trustProjectSkills")).toBe(false);
				expect(names).not.toContain(SKILL_NAME);
			} finally {
				await settings.close();
			}
		});
	}

	it("does not let a repository legacy alias turn a user skills.enablePiProject false into true", async () => {
		const { settings, names } = await loadProjectSkill({
			globalSkills: { enabled: true, enablePiProject: false },
			surface: "gjc-settings",
			projectSkills: { enablePiProject: true },
		});
		try {
			expect(settings.getGlobal("skills.enablePiProject")).toBe(false);
			expect(settings.get("skills.enablePiProject")).toBe(false);
			expect(settings.get("skills.trustProjectSkills")).toBeUndefined();
			expect(names).not.toContain(SKILL_NAME);
		} finally {
			await settings.close();
		}
	});

	it("does not let a repository trust flag override a user legacy false", async () => {
		const { settings, names } = await loadProjectSkill({
			globalSkills: { enabled: true, enablePiProject: false },
			surface: "gjc-config",
			projectSkills: { trustProjectSkills: true },
		});
		try {
			expect(settings.getGlobal("skills.enablePiProject")).toBe(false);
			expect(settings.get("skills.enablePiProject")).toBe(false);
			expect(settings.get("skills.trustProjectSkills")).toBeUndefined();
			expect(names).not.toContain(SKILL_NAME);
		} finally {
			await settings.close();
		}
	});

	it("still loads a project skill when the user config trusts project skills", async () => {
		const { settings, names } = await loadProjectSkill({
			globalSkills: { enabled: true, trustProjectSkills: true },
			surface: "gjc-settings",
			projectSkills: { ignoredSkills: ["not-this-skill"] },
		});
		try {
			expect(settings.getGlobal("skills.trustProjectSkills")).toBe(true);
			expect(settings.get("skills.trustProjectSkills")).toBe(true);
			expect(settings.get("skills.ignoredSkills")).toEqual(["not-this-skill"]);
			expect(names).toContain(SKILL_NAME);
		} finally {
			await settings.close();
		}
	});

	it("does not let a repository false clear an explicit user true", async () => {
		const { settings, names } = await loadProjectSkill({
			globalSkills: { enabled: true, trustProjectSkills: true },
			surface: "cursor-settings",
			projectSkills: { trustProjectSkills: false },
		});
		try {
			expect(settings.getGlobal("skills.trustProjectSkills")).toBe(true);
			expect(settings.get("skills.trustProjectSkills")).toBe(true);
			expect(names).toContain(SKILL_NAME);
		} finally {
			await settings.close();
		}
	});
});
