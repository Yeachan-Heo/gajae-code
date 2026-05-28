import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	GJC_MODEL_ASSIGNMENT_TARGET_IDS,
	GJC_MODEL_ASSIGNMENT_TARGETS,
} from "@gajae-code/coding-agent/config/model-registry";
import {
	DEFAULT_GJC_DEFINITION_NAMES,
	getDefaultGjcDefinitions,
	installDefaultGjcDefinitions,
} from "@gajae-code/coding-agent/defaults/gjc-defaults";
import { loadSkills } from "@gajae-code/coding-agent/extensibility/skills";
import { getBundledAgent } from "@gajae-code/coding-agent/task/agents";
import { discoverAgents } from "@gajae-code/coding-agent/task/discovery";

const tempRoots: string[] = [];
const roleAgentNames = ["architect", "critic", "executor", "planner"] as const;
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

async function makeTempRoot(): Promise<string> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-default-definitions-"));
	tempRoots.push(tempRoot);
	return tempRoot;
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
	const originalHome = process.env.HOME;
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-default-home-"));
	tempRoots.push(home);
	process.env.HOME = home;
	try {
		return await fn(home);
	} finally {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
	}
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("default GJC definitions", () => {
	it("bundles exactly the four default workflow skills as installable source assets", () => {
		const definitions = getDefaultGjcDefinitions();
		const skills = definitions.map(definition => definition.name).sort();
		const expected = [...DEFAULT_GJC_DEFINITION_NAMES].sort();

		expect(definitions.every(definition => definition.kind === "skill")).toBe(true);
		expect(skills).toEqual(expected);
		expect(definitions).toHaveLength(4);
		expect(definitions.every(definition => definition.relativePath.startsWith("skills/"))).toBe(true);
		expect(definitions.every(definition => definition.content.includes(definition.name))).toBe(true);
	});

	it("keeps the four role agents bundled when project .gjc is absent", async () => {
		await withTempHome(async home => {
			const repoRoot = await makeTempRoot();
			const agents = await discoverAgents(repoRoot, home);
			const bundledRoleAgents = agents.agents
				.filter(
					agent =>
						agent.source === "bundled" && roleAgentNames.includes(agent.name as (typeof roleAgentNames)[number]),
				)
				.map(agent => agent.name)
				.sort();

			expect(bundledRoleAgents).toEqual([...roleAgentNames].sort());
			expect(agents.projectAgentsDir).toBeNull();
		});
	});

	it("exposes only default plus four GJC role agents as model assignment targets", () => {
		expect(GJC_MODEL_ASSIGNMENT_TARGET_IDS).toEqual(["default", "executor", "architect", "planner", "critic"]);
		expect(GJC_MODEL_ASSIGNMENT_TARGET_IDS.map(id => GJC_MODEL_ASSIGNMENT_TARGETS[id].tag)).toEqual([
			"DEFAULT",
			"EXECUTOR",
			"ARCHITECT",
			"PLANNER",
			"CRITIC",
		]);
	});

	it("enforces role-agent tool boundaries through parsed frontmatter", () => {
		const executor = getBundledAgent("executor");
		const architect = getBundledAgent("architect");
		const planner = getBundledAgent("planner");
		const critic = getBundledAgent("critic");

		expect(executor?.tools).toBeUndefined();
		for (const agent of [architect, planner, critic]) {
			expect(agent?.tools).toBeDefined();
			expect(agent?.tools).toContain("yield");
			expect(agent?.tools).not.toContain("edit");
			expect(agent?.tools).not.toContain("write");
			expect(agent?.tools).not.toContain("bash");
		}
		for (const agent of [executor, architect, planner, critic]) {
			expect(agent?.model).toBeUndefined();
		}
		expect(architect?.systemPrompt).toContain("Architectural Status");
		expect(architect?.systemPrompt).toContain("CRITICAL");
		expect(architect?.systemPrompt).toContain("REQUEST CHANGES");
		expect(planner?.systemPrompt).toContain("you do not implement");
		expect(critic?.systemPrompt).toContain("OKAY");
		expect(critic?.systemPrompt).toContain("REJECT");
	});

	it("makes installed project workflow skills discoverable without installing project agent stubs", async () => {
		await withTempHome(async home => {
			const repoRoot = await makeTempRoot();
			const projectGjcRoot = path.join(repoRoot, ".gjc");
			await installDefaultGjcDefinitions({ targetRoot: projectGjcRoot });

			const skills = await loadSkills({
				cwd: repoRoot,
				enabled: true,
				enablePiProject: true,
				enablePiUser: false,
			});
			const agents = await discoverAgents(repoRoot, home);
			const expected = [...DEFAULT_GJC_DEFINITION_NAMES].sort();

			expect(skills.skills.map(skill => skill.name).sort()).toEqual(expected);
			expect(
				agents.agents
					.filter(agent => agent.source === "project")
					.map(agent => agent.name)
					.sort(),
			).toEqual([]);
			expect(agents.projectAgentsDir).toBeNull();
		});
	});

	it("preserves project .gjc agent overrides at runtime", async () => {
		await withTempHome(async home => {
			const repoRoot = await makeTempRoot();
			const agentsDir = path.join(repoRoot, ".gjc", "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await Bun.write(
				path.join(agentsDir, "executor.md"),
				`---
name: executor
description: Project executor override.
---
Project executor override body.
`,
			);

			const agents = await discoverAgents(repoRoot, home);
			const executor = agents.agents.find(agent => agent.name === "executor");

			expect(executor?.source).toBe("project");
			expect(executor?.systemPrompt).toContain("Project executor override body");
			expect(agents.projectAgentsDir).toBe(agentsDir);
		});
	});

	it("documents role-agent delegation in system and ultragoal prompts", async () => {
		const systemPrompt = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "prompts", "system", "system-prompt.md"),
		).text();
		const ultragoal = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills", "ultragoal", "SKILL.md"),
		).text();

		for (const name of roleAgentNames) {
			expect(systemPrompt).toContain(name);
			expect(ultragoal).toContain(name);
		}
		expect(systemPrompt).toContain("delegate bounded slices to `executor`");
		expect(systemPrompt).toContain("committed repo-visible `.gjc` defaults are not the source of truth");
		expect(ultragoal).toContain("run `ralplan` first");
		expect(ultragoal).toContain("Role agents return implementation/review evidence");
		expect(ultragoal).toContain("await timeout only limits the leader's wait");
		expect(ultragoal).toContain("must not be used as a cancellation reason");
		expect(ultragoal).toContain("the subagent has actually failed");
		expect(ultragoal).toContain("gone off-track");
		expect(ultragoal).toContain("become unrecoverably wrong");
	});

	it("documents leader-owned Ultragoal checkpoints for Team bridge workers", async () => {
		const team = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills", "team", "SKILL.md"),
		).text();
		const ultragoal = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills", "ultragoal", "SKILL.md"),
		).text();

		for (const content of [team, ultragoal]) {
			expect(content).toContain("fresh `get_goal` snapshot");
			expect(content).toContain("Workers must not run `gjc ultragoal checkpoint`");
			expect(content).toContain("checkpoint authority stays with the leader");
			expect(content).toContain("Ultragoal does not auto-launch Team");
			expect(content).toContain("performs no hidden goal mutation");
		}
	});

	it("keeps bundled deep-interview skill on GJC-native workflow vocabulary", () => {
		const deepInterview = getDefaultGjcDefinitions().find(definition => definition.name === "deep-interview");
		expect(deepInterview).toBeDefined();
		const content = deepInterview?.content ?? "";

		for (const required of ["ask", ".gjc/state", "pending approval"]) {
			expect(content).toContain(required);
		}
		expect(content).toMatch(/\/skill:ralplan|gjc ralplan/);
		expect(content).toMatch(/\/skill:team|gjc team/);

		for (const forbidden of [
			"AskUserQuestion",
			"AskUserQuestionTool",
			"state_write",
			"state_read",
			"Skill(",
			"gajae-code:",
			"/gajae-code",
		]) {
			expect(content).not.toContain(forbidden);
		}
	});

	it("installs bundled workflow skill definitions without overwriting local edits unless forced", async () => {
		const targetRoot = await makeTempRoot();
		const initial = await installDefaultGjcDefinitions({ targetRoot });
		const deepInterviewSkillPath = path.join(targetRoot, "skills", "deep-interview", "SKILL.md");
		const installedDeepInterview = await Bun.file(deepInterviewSkillPath).text();

		expect(initial.written).toBe(4);
		expect(initial.skipped).toBe(0);

		await Bun.write(deepInterviewSkillPath, "local edit");
		const skipped = await installDefaultGjcDefinitions({ targetRoot });
		expect(skipped.written).toBe(0);
		expect(skipped.skipped).toBe(4);
		expect(await Bun.file(deepInterviewSkillPath).text()).toBe("local edit");

		const check = await installDefaultGjcDefinitions({ targetRoot, check: true });
		expect(check.different).toBe(1);
		expect(check.matching).toBe(3);

		const forced = await installDefaultGjcDefinitions({ targetRoot, force: true });
		expect(forced.written).toBe(4);
		expect(await Bun.file(deepInterviewSkillPath).text()).toBe(installedDeepInterview);
	});
});
