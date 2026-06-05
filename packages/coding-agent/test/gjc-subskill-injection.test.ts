import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type LoadedSubskillActivation, loadGjcPlugin, toActiveSubskillEntry } from "../src/extensibility/gjc-plugins";
import { buildSkillPromptMessage } from "../src/extensibility/skills";
import { syncSkillActiveState } from "../src/skill-state/active-state";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const tempRoots: string[] = [];

const ralplanSkill = {
	name: "ralplan",
	filePath: "/bundled/ralplan/SKILL.md",
	content: "---\nname: ralplan\ndescription: planning\n---\nRalplan body",
};

async function tempProject(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-subskill-injection-"));
	tempRoots.push(cwd);
	await fs.mkdir(path.join(cwd, ".gjc", "gjc-plugins"), { recursive: true });
	await fs.cp(
		path.join(fixturesRoot, "valid-skill-plugin"),
		path.join(cwd, ".gjc", "gjc-plugins", "valid-skill-plugin"),
		{
			recursive: true,
		},
	);
	return cwd;
}

async function activationFromFixture(cwd: string): Promise<LoadedSubskillActivation> {
	const plugin = await loadGjcPlugin(path.join(cwd, ".gjc", "gjc-plugins", "valid-skill-plugin"));
	const binding = plugin.bindings[0];
	return {
		plugin: binding.plugin,
		subskillName: binding.subskillName,
		parent: binding.parent,
		bindsTo: binding.bindsTo,
		phase: binding.phase,
		activationArg: binding.activationArg,
		filePath: binding.filePath,
		toolPaths: binding.toolPaths,
	};
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("GJC sub-skill prompt injection", () => {
	test("buildSkillPromptMessage appends matching active sub-skill block for the current phase", async () => {
		const cwd = await tempProject();
		const activation = await activationFromFixture(cwd);

		const built = await buildSkillPromptMessage(ralplanSkill, "requirements", {
			cwd,
			currentPhase: "planner",
			subskillActivation: activation,
		});

		expect(built.message).toContain("User: requirements");
		expect(built.message).toContain(
			'<gjc-subskill plugin="valid-skill-plugin" name="design" parent="ralplan" phase="planner" arg="design">',
		);
		expect(built.message).toContain(
			"Use domain-specific design constraints before drafting the ralplan planner artifact.",
		);
		expect(built.message.indexOf("Skill: /bundled/ralplan/SKILL.md")).toBeLessThan(
			built.message.indexOf("<gjc-subskill"),
		);
		expect(built.details.subskillActivation).toEqual(activation);
	});

	test("non-plugin skill message is byte-identical with no context and empty context", async () => {
		const noContext = await buildSkillPromptMessage(ralplanSkill, "same args");
		const withEmptyContext = await buildSkillPromptMessage(ralplanSkill, "same args", {});
		expect(withEmptyContext.message).toBe(noContext.message);
		expect(withEmptyContext.details).toEqual(noContext.details);
	});

	test("phase mismatch does not append a persisted active sub-skill block", async () => {
		const cwd = await tempProject();
		const activation = await activationFromFixture(cwd);
		await syncSkillActiveState({
			cwd,
			skill: "ralplan",
			active: true,
			phase: "architect",
			active_subskills: [toActiveSubskillEntry(activation)],
		});

		const built = await buildSkillPromptMessage(ralplanSkill, "", { cwd, currentPhase: "architect" });
		expect(built.message).not.toContain("<gjc-subskill");
		expect(built.details.subskillActivation).toBeUndefined();
	});
});
