import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	readActiveSubskillsForParent,
	resolveSubskillActivationForSkillInvocation,
	toActiveSubskillEntry,
} from "../src/extensibility/gjc-plugins";
import { syncSkillActiveState } from "../src/skill-state/active-state";

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
	});
});
