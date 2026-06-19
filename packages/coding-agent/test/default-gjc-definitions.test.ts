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
	getEmbeddedDefaultGjcSkillFragments,
	getEmbeddedDefaultGjcSkills,
	installDefaultGjcDefinitions,
} from "@gajae-code/coding-agent/defaults/gjc-defaults";
import { loadSkills, resetActiveSkillsForTests, setActiveSkills } from "@gajae-code/coding-agent/extensibility/skills";
import { parseInternalUrl } from "@gajae-code/coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@gajae-code/coding-agent/internal-urls/skill-protocol";
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
	resetActiveSkillsForTests();
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("default GJC definitions", () => {
	it("bundles exactly the four default workflow skills plus deep-interview and ultragoal fragments as installable assets", () => {
		const definitions = getDefaultGjcDefinitions();
		const workflowDefinitions = definitions.filter(definition => definition.kind === "skill");
		const fragmentDefinitions = definitions.filter(definition => definition.kind === "skill-fragment");
		const skills = workflowDefinitions.map(definition => definition.name).sort();
		const expected = [...DEFAULT_GJC_DEFINITION_NAMES].sort();

		expect(skills).toEqual(expected);
		expect(workflowDefinitions).toHaveLength(4);
		expect(definitions).toHaveLength(8);
		expect(workflowDefinitions.every(definition => definition.relativePath.startsWith("skills/"))).toBe(true);
		expect(workflowDefinitions.every(definition => definition.content.includes(definition.name))).toBe(true);
		expect(fragmentDefinitions).toHaveLength(4);
		expect(fragmentDefinitions.map(definition => definition.parentSkillName).sort()).toEqual([
			"deep-interview",
			"deep-interview",
			"deep-interview",
			"ultragoal",
		]);
		expect(fragmentDefinitions.map(definition => definition.relativePath).sort()).toEqual([
			"skill-fragments/deep-interview/auto-answer-uncertain.md",
			"skill-fragments/deep-interview/auto-research-greenfield.md",
			"skill-fragments/deep-interview/lateral-review-panel.md",
			"skill-fragments/ultragoal/ai-slop-cleaner.md",
		]);
	});

	it("exposes deep-interview fragments only through the parent-scoped fragment accessor", () => {
		const fragments = getEmbeddedDefaultGjcSkillFragments("deep-interview");

		expect(
			getEmbeddedDefaultGjcSkills()
				.map(skill => skill.name)
				.sort(),
		).toEqual([...DEFAULT_GJC_DEFINITION_NAMES].sort());
		expect(fragments).toHaveLength(3);
		expect(fragments.map(fragment => fragment.kind)).toEqual(["skill-fragment", "skill-fragment", "skill-fragment"]);
		expect(fragments.map(fragment => fragment.relativePath).sort()).toEqual([
			"skill-fragments/deep-interview/auto-answer-uncertain.md",
			"skill-fragments/deep-interview/auto-research-greenfield.md",
			"skill-fragments/deep-interview/lateral-review-panel.md",
		]);
		expect(fragments.every(fragment => fragment.content.includes("read-only architect"))).toBe(true);
	});

	it("exposes the ultragoal ai-slop-cleaner fragment only through the parent-scoped fragment accessor", () => {
		const fragments = getEmbeddedDefaultGjcSkillFragments("ultragoal");

		expect(
			getEmbeddedDefaultGjcSkills()
				.map(skill => skill.name)
				.sort(),
		).toEqual([...DEFAULT_GJC_DEFINITION_NAMES].sort());
		expect(fragments).toHaveLength(1);
		expect(fragments.map(fragment => fragment.kind)).toEqual(["skill-fragment"]);
		expect(fragments.map(fragment => fragment.relativePath)).toEqual([
			"skill-fragments/ultragoal/ai-slop-cleaner.md",
		]);
		expect(fragments[0]!.content).toContain("AI SLOP CLEANUP REPORT");
		expect(fragments[0]!.content).toContain("read-only detector");
	});

	it("authors the ai-slop-cleaner fragment with the mandated report labels and full taxonomy", () => {
		const fragment = getEmbeddedDefaultGjcSkillFragments("ultragoal")[0]!;
		const content = fragment.content;

		for (const label of [
			"AI SLOP CLEANUP REPORT",
			"Scope:",
			"Mode: read-only detector/report; no edits performed",
			"Blocking Findings",
			"Advisory Findings",
			"Fallback Findings",
			"UI/Design Findings",
			"Missing Test Findings",
			"Recursion Guard",
			"Changed Files Reviewed",
			"Gate Result: PASS | BLOCKED",
		]) {
			expect(content).toContain(label);
		}
		for (const taxonomy of [
			"masking fallback slop",
			"grounded compatibility/fail-safe fallback",
			"Fallback-like code",
			"Duplication",
			"Dead code",
			"Needless abstraction",
			"Boundary violations",
			"UI/design slop",
			"Missing tests",
		]) {
			expect(content).toContain(taxonomy);
		}
	});

	it("wires the ai-slop-cleaner into the ultragoal completion gate before verification and red-team", () => {
		const ultragoal = getDefaultGjcDefinitions().find(
			definition => definition.kind === "skill" && definition.name === "ultragoal",
		);
		if (!ultragoal) throw new Error("missing bundled ultragoal skill");
		const content = ultragoal.content;

		const sectionStart = content.indexOf("## Mandatory completion cleanup and review gate");
		expect(sectionStart).toBeGreaterThanOrEqual(0);
		const afterStart = content.indexOf("\n## ", sectionStart + 1);
		const section = content.slice(sectionStart, afterStart === -1 ? undefined : afterStart);

		const cleanerStep = section.indexOf("2. Run the internal ai-slop-cleaner skill fragment");
		const verifyStep = section.indexOf("3. Rerun verification after the cleaner pass");
		const architectStep = section.indexOf("4. Delegate an `architect` review");
		const redTeamStep = section.indexOf("5. Delegate an `executor` QA/red-team lane");

		expect(cleanerStep).toBeGreaterThanOrEqual(0);
		expect(verifyStep).toBeGreaterThan(cleanerStep);
		expect(architectStep).toBeGreaterThan(verifyStep);
		expect(redTeamStep).toBeGreaterThan(architectStep);

		expect(section).toContain("reruns the cleaner until blocking findings are zero");
		expect(section).toContain("Advisory findings are included in the gate report only");
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
			expect(agent?.tools).toContain("bash");
			expect(agent?.tools).not.toContain("edit");
			expect(agent?.tools).not.toContain("write");
			expect(agent?.bashAllowedPrefixes).toEqual(["gjc ralplan --write", "gjc state"]);
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
			expect(skills.skills.some(skill => skill.name === "auto-research-greenfield")).toBe(false);
			expect(skills.skills.some(skill => skill.name === "auto-answer-uncertain")).toBe(false);
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
			expect(content).toContain('fresh `goal({"op":"get"})` snapshot');
			expect(content).toContain("Workers must not run `gjc ultragoal checkpoint`");
			expect(content).toContain("checkpoint authority stays with the leader");
			expect(content).toContain("Ultragoal does not auto-launch Team");
			expect(content).toContain("performs no hidden goal mutation");
		}
	});

	it("keeps bundled deep-interview skill on GJC-native workflow vocabulary", () => {
		const deepInterview = getDefaultGjcDefinitions().find(
			definition => definition.kind === "skill" && definition.name === "deep-interview",
		);
		expect(deepInterview).toBeDefined();
		const content = deepInterview?.content ?? "";

		for (const required of ["ask", ".gjc/state", "pending approval"]) {
			expect(content).toContain(required);
		}
		expect(content).toContain("/skill:ralplan");
		expect(content).toContain("/skill:team");
		expect(content).toContain("`gjc ralplan` is a native CLI");
		expect(content).toContain("Direct `.gjc/` file edits are forbidden");
		expect(content).toContain("do not edit `.gjc/state` directly without force override");
		expect(content).toContain("default `0.05`");
		expect(content).toContain("language.instruction");
		expect(content).toContain(
			"default to English unless `{{ARGUMENTS}}` makes another user/session language obvious",
		);
		expect(content).toContain('"language": "<existing language object from active state, if present>"');
		expect(content).toContain("progress reports, and spec prose");
		expect(content).toContain("translated/localized according to `language.instruction`");
		expect(content).not.toContain("default `0.2`");
		expect(content).not.toContain("20%");

		for (const forbidden of [
			"AskUserQuestion",
			"AskUserQuestionTool",
			"state_write",
			"state_read",
			"Skill(",
			"gajae-code:",
			"/gajae-code",
			"gjc deep-interview",
		]) {
			expect(content).not.toContain(forbidden);
		}
	});

	it("keeps bundled ralplan stage artifacts on CLI write path", () => {
		const ralplan = getDefaultGjcDefinitions().find(
			definition => definition.kind === "skill" && definition.name === "ralplan",
		);
		expect(ralplan).toBeDefined();
		const content = ralplan?.content ?? "";

		expect(content).toContain("gjc ralplan --write --stage <type> --stage_n <N> --artifact");
		expect(content).toContain("--stage planner");
		expect(content).toContain("--stage architect");
		expect(content).toContain("--stage critic");
		expect(content).toContain("do not directly edit `.gjc/plans`");
		expect(content).toContain(
			"Direct `write`, `edit`, or `ast_edit` calls against `.gjc/specs`, `.gjc/plans`, `.gjc/state`, or any other `.gjc/` path are forbidden",
		);
	});

	it("installs bundled workflow skill definitions without overwriting local edits unless forced", async () => {
		const targetRoot = await makeTempRoot();
		const initial = await installDefaultGjcDefinitions({ targetRoot });
		const deepInterviewSkillPath = path.join(targetRoot, "skills", "deep-interview", "SKILL.md");
		const installedDeepInterview = await Bun.file(deepInterviewSkillPath).text();

		expect(initial.written).toBe(8);
		expect(initial.total).toBe(8);
		expect(initial.skipped).toBe(0);
		expect(initial.files.filter(file => file.kind === "skill-fragment")).toHaveLength(4);

		const installedResearchFragment = await Bun.file(
			path.join(targetRoot, "skill-fragments", "deep-interview", "auto-research-greenfield.md"),
		).text();
		expect(installedResearchFragment).toContain("ranked candidate answers");
		await Bun.write(deepInterviewSkillPath, "local edit");
		const skipped = await installDefaultGjcDefinitions({ targetRoot });
		expect(skipped.written).toBe(0);
		expect(skipped.skipped).toBe(8);
		expect(await Bun.file(deepInterviewSkillPath).text()).toBe("local edit");

		const check = await installDefaultGjcDefinitions({ targetRoot, check: true });
		expect(check.different).toBe(1);
		expect(check.matching).toBe(7);

		const forced = await installDefaultGjcDefinitions({ targetRoot, force: true });
		expect(forced.written).toBe(8);
		expect(await Bun.file(deepInterviewSkillPath).text()).toBe(installedDeepInterview);
		expect(
			forced.files.some(file => file.kind === "skill-fragment" && file.parentSkillName === "deep-interview"),
		).toBe(true);
	});

	it("does not make installed fragments reachable as skill-relative internal URL assets", async () => {
		await withTempHome(async () => {
			const repoRoot = await makeTempRoot();
			await installDefaultGjcDefinitions({ targetRoot: path.join(repoRoot, ".gjc") });

			const skills = await loadSkills({
				cwd: repoRoot,
				enabled: true,
				enablePiProject: true,
				enablePiUser: false,
			});
			const deepInterview = skills.skills.find(
				skill => skill.name === "deep-interview" && skill.source === "native:project",
			);
			if (!deepInterview) throw new Error("missing installed deep-interview skill");

			setActiveSkills([deepInterview]);
			await expect(
				new SkillProtocolHandler().resolve(parseInternalUrl("skill://deep-interview/auto-research-greenfield.md")),
			).rejects.toThrow("File not found");
		});
	});

	it("does not make the ultragoal ai-slop-cleaner fragment reachable as a skill-relative internal URL asset", async () => {
		await withTempHome(async () => {
			const repoRoot = await makeTempRoot();
			await installDefaultGjcDefinitions({ targetRoot: path.join(repoRoot, ".gjc") });

			const skills = await loadSkills({
				cwd: repoRoot,
				enabled: true,
				enablePiProject: true,
				enablePiUser: false,
			});
			const ultragoal = skills.skills.find(skill => skill.name === "ultragoal" && skill.source === "native:project");
			if (!ultragoal) throw new Error("missing installed ultragoal skill");

			setActiveSkills([ultragoal]);
			await expect(
				new SkillProtocolHandler().resolve(parseInternalUrl("skill://ultragoal/ai-slop-cleaner.md")),
			).rejects.toThrow("File not found");
			await expect(new SkillProtocolHandler().resolve(parseInternalUrl("skill://ai-slop-cleaner"))).rejects.toThrow(
				"Unknown skill: ai-slop-cleaner",
			);
		});
	});
	it("prints skill inspection guidance for setup defaults without changing JSON output", async () => {
		const externalRoot = await makeTempRoot();
		const home = await makeTempRoot();
		const env = {
			...process.env,
			HOME: home,
			PI_NO_TITLE: "1",
			NO_COLOR: "1",
			FORCE_COLOR: undefined,
		};

		const installProc = Bun.spawn(
			[process.execPath, path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts"), "setup", "defaults"],
			{
				cwd: externalRoot,
				stdout: "pipe",
				stderr: "pipe",
				env,
			},
		);
		const installStdout = await new Response(installProc.stdout).text();
		const installStderr = await new Response(installProc.stderr).text();
		expect(await installProc.exited).toBe(0);
		expect(installStderr).toBe("");
		expect(installStdout).toContain("gjc skills list");
		expect(installStdout).toContain("gjc skills read ralplan");

		const skippedProc = Bun.spawn(
			[process.execPath, path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts"), "setup", "defaults"],
			{
				cwd: externalRoot,
				stdout: "pipe",
				stderr: "pipe",
				env,
			},
		);
		const skippedStdout = await new Response(skippedProc.stdout).text();
		const skippedStderr = await new Response(skippedProc.stderr).text();
		expect(await skippedProc.exited).toBe(0);
		expect(skippedStderr).toBe("");
		expect(skippedStdout).toContain("gjc skills list");
		expect(skippedStdout).toContain("gjc setup defaults --force");

		const jsonProc = Bun.spawn(
			[
				process.execPath,
				path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts"),
				"setup",
				"defaults",
				"--json",
			],
			{
				cwd: externalRoot,
				stdout: "pipe",
				stderr: "pipe",
				env,
			},
		);
		const jsonStdout = await new Response(jsonProc.stdout).text();
		const jsonStderr = await new Response(jsonProc.stderr).text();
		expect(await jsonProc.exited).toBe(0);
		expect(jsonStderr).toBe("");
		expect(jsonStdout).not.toContain("gjc skills list");
		expect(JSON.parse(jsonStdout) as { skipped: number }).toMatchObject({ skipped: 8 });
	});
});

describe("bundled skills CLI", () => {
	it("reads embedded workflow skills from outside the repository without .gjc files", async () => {
		const externalRoot = await makeTempRoot();
		const proc = Bun.spawn(
			[
				process.execPath,
				path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts"),
				"skills",
				"read",
				"ultragoal",
				"--json",
			],
			{
				cwd: externalRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME: await makeTempRoot(),
					PI_NO_TITLE: "1",
					NO_COLOR: "1",
					FORCE_COLOR: undefined,
				},
			},
		);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		const parsed = JSON.parse(stdout) as { name: string; path: string; source: string; content: string };
		expect(parsed.name).toBe("ultragoal");
		expect(parsed.path).toBe("embedded:gjc/skills/ultragoal/SKILL.md");
		expect(parsed.source).toBe("bundled:default");
		expect(parsed.content).toContain("# Ultragoal");
	});

	it("lists exactly the embedded default workflow skills", async () => {
		const externalRoot = await makeTempRoot();
		const proc = Bun.spawn(
			[
				process.execPath,
				path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts"),
				"skills",
				"list",
				"--json",
			],
			{
				cwd: externalRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME: await makeTempRoot(),
					PI_NO_TITLE: "1",
					NO_COLOR: "1",
					FORCE_COLOR: undefined,
				},
			},
		);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		const parsed = JSON.parse(stdout) as { skills: Array<{ name: string; path: string }> };
		expect(parsed.skills.map(skill => skill.name).sort()).toEqual([...DEFAULT_GJC_DEFINITION_NAMES].sort());
		expect(parsed.skills.every(skill => skill.path.startsWith("embedded:gjc/skills/"))).toBe(true);
		expect(parsed.skills.some(skill => skill.name === "auto-research-greenfield")).toBe(false);
		expect(parsed.skills.some(skill => skill.name === "auto-answer-uncertain")).toBe(false);
		expect(parsed.skills.some(skill => skill.name === "ai-slop-cleaner")).toBe(false);
	});

	it("does not expose embedded fragments through skills read", async () => {
		for (const fragmentName of ["auto-research-greenfield", "auto-answer-uncertain", "ai-slop-cleaner"]) {
			const externalRoot = await makeTempRoot();
			const proc = Bun.spawn(
				[
					process.execPath,
					path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts"),
					"skills",
					"read",
					fragmentName,
					"--json",
				],
				{
					cwd: externalRoot,
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...process.env,
						HOME: await makeTempRoot(),
						PI_NO_TITLE: "1",
						NO_COLOR: "1",
						FORCE_COLOR: undefined,
					},
				},
			);
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			expect(exitCode).not.toBe(0);
			expect(stdout).toBe("");
			expect(stderr).toContain("unknown embedded skill");
		}
	});
});
