import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	GjcPluginLoadError,
	readActiveSubskillsForParent,
	resolveSubskillActivationForSkillInvocation,
	toActiveSubskillEntry,
} from "../src/extensibility/gjc-plugins";
import { applyHandoffToActiveState, syncSkillActiveState } from "../src/skill-state/active-state";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const tempRoots: string[] = [];

async function tempProjectWithFixture(fixtureName: string): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-activation-"));
	tempRoots.push(cwd);
	await fs.mkdir(path.join(cwd, ".gjc", "gjc-plugins"), { recursive: true });
	await fs.cp(path.join(fixturesRoot, fixtureName), path.join(cwd, ".gjc", "gjc-plugins", fixtureName), {
		recursive: true,
	});
	return cwd;
}

async function tempProjectWithFixtures(fixtureNames: string[]): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plugin-activation-"));
	tempRoots.push(cwd);
	await fs.mkdir(path.join(cwd, ".gjc", "gjc-plugins"), { recursive: true });
	for (const fixtureName of fixtureNames) {
		await fs.cp(path.join(fixturesRoot, fixtureName), path.join(cwd, ".gjc", "gjc-plugins", fixtureName), {
			recursive: true,
		});
	}
	return cwd;
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("GJC sub-skill activation dispatch", () => {
	test("resolves --activation_arg for parent skill invocation and strips only the sub-skill flag", async () => {
		const cwd = await tempProjectWithFixture("valid-skill-plugin");

		const result = await resolveSubskillActivationForSkillInvocation({
			cwd,
			skillName: "ralplan",
			args: "--interactive --design requirements.md --json",
		});

		expect(result.cleanedArgs).toBe("--interactive requirements.md --json");
		expect(result.activation).toBeDefined();
		expect(result.activation).toMatchObject({
			plugin: "valid-skill-plugin",
			subskillName: "design",
			parent: "ralplan",
			phase: "planner",
			activationArg: "design",
		});
		expect(result.activeSubskillsToPersist).toHaveLength(1);
		expect(result.activeSubskillsToPersist[0]).toEqual(result.activation!);
		expect(result.activeSubskillsToPersist[0]!.toolPaths.length).toBeGreaterThan(0);
	});

	test("resolves a workflow flag to the whole same-plugin activation pack", async () => {
		const cwd = await tempProjectWithFixture("combined-pack");

		const result = await resolveSubskillActivationForSkillInvocation({ cwd, skillName: "ralplan", args: "--design" });

		expect(result.cleanedArgs).toBe("");
		expect(result.activation).toMatchObject({
			plugin: "combined-pack",
			subskillName: "ralplan-design",
			parent: "ralplan",
			bindsTo: "ralplan",
			phase: "planner",
			activationArg: "design",
		});
		expect(result.activeSubskillsToPersist).toHaveLength(2);
		expect(result.activeSubskillsToPersist).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ parent: "ralplan", bindsTo: "ralplan", phase: "planner" }),
				expect.objectContaining({ parent: "executor", bindsTo: "executor", phase: "prompt" }),
			]),
		);
	});

	test("persists a workflow activation pack so spawned agents can read agent-bound entries", async () => {
		const cwd = await tempProjectWithFixture("combined-pack");
		const result = await resolveSubskillActivationForSkillInvocation({ cwd, skillName: "ralplan", args: "--design" });
		expect(result.activation).toBeDefined();

		await syncSkillActiveState({
			cwd,
			skill: "ralplan",
			active: true,
			phase: result.activation!.phase,
			active_subskills: result.activeSubskillsToPersist.map(toActiveSubskillEntry),
		});

		const executorSubskills = await readActiveSubskillsForParent({ cwd, parent: "executor", phase: "prompt" });
		expect(executorSubskills).toHaveLength(1);
		expect(executorSubskills[0]).toMatchObject({
			plugin: "combined-pack",
			subskillName: "executor-design",
			parent: "executor",
			bindsTo: "executor",
			phase: "prompt",
			activationArg: "design",
		});
	});

	test("keeps agent-bound active sub-skills visible after workflow handoff", async () => {
		const cwd = await tempProjectWithFixture("combined-pack");
		const sessionId = "handoff-session";
		const result = await resolveSubskillActivationForSkillInvocation({ cwd, skillName: "ralplan", args: "--design" });
		expect(result.activation).toBeDefined();
		const activeSubskills = result.activeSubskillsToPersist.map(toActiveSubskillEntry);

		await syncSkillActiveState({
			cwd,
			sessionId,
			skill: "ralplan",
			active: true,
			phase: result.activation!.phase,
			active_subskills: activeSubskills,
		});

		await applyHandoffToActiveState({
			cwd,
			caller: {
				cwd,
				sessionId,
				skill: "ralplan",
				active: false,
				handoff_to: "team",
			},
			callee: {
				cwd,
				sessionId,
				skill: "team",
				active: true,
				handoff_from: "ralplan",
			},
		});

		const executorSubskills = await readActiveSubskillsForParent({
			cwd,
			sessionId,
			parent: "executor",
			phase: "prompt",
		});
		expect(executorSubskills).toHaveLength(1);
		expect(executorSubskills[0]).toMatchObject({
			plugin: "combined-pack",
			subskillName: "executor-design",
			parent: "executor",
			bindsTo: "executor",
			phase: "prompt",
			activationArg: "design",
		});
	});

	test("rejects duplicate activation args across plugin roots instead of choosing a winner", async () => {
		const cwd = await tempProjectWithFixtures(["valid-skill-plugin", "duplicate-arg"]);

		await expect(
			resolveSubskillActivationForSkillInvocation({ cwd, skillName: "ralplan", args: "--design" }),
		).rejects.toMatchObject({
			constructor: GjcPluginLoadError,
			code: "duplicate_arg",
		});
	});

	test("persists resolved active sub-skill through real active state writer helper", async () => {
		const cwd = await tempProjectWithFixture("valid-skill-plugin");
		const result = await resolveSubskillActivationForSkillInvocation({ cwd, skillName: "ralplan", args: "--design" });
		expect(result.activation).toBeDefined();

		await syncSkillActiveState({
			cwd,
			skill: "ralplan",
			active: true,
			phase: "planner",
			active_subskills: result.activeSubskillsToPersist.map(toActiveSubskillEntry),
		});

		const persisted = await readActiveSubskillsForParent({ cwd, parent: "ralplan", phase: "planner" });
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({
			plugin: "valid-skill-plugin",
			subskillName: "design",
			activationArg: "design",
		});

		await syncSkillActiveState({
			cwd,
			skill: "ralplan",
			active: true,
			phase: "planner",
		});

		const preserved = await readActiveSubskillsForParent({ cwd, parent: "ralplan", phase: "planner" });
		expect(preserved).toHaveLength(1);
		expect(preserved[0]).toMatchObject({
			plugin: "valid-skill-plugin",
			subskillName: "design",
			activationArg: "design",
		});

		await syncSkillActiveState({
			cwd,
			skill: "ralplan",
			active: true,
			phase: "planner",
			active_subskills: [],
		});

		const cleared = await readActiveSubskillsForParent({ cwd, parent: "ralplan", phase: "planner" });
		expect(cleared).toHaveLength(0);
	});
});
