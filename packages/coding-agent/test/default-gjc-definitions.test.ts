import { afterEach, describe, expect, it, vi } from "bun:test";
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
import { prompt } from "@gajae-code/utils";

const tempRoots: string[] = [];
const roleAgentNames = ["architect", "critic", "executor", "planner"] as const;
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

function extractPromptSection(content: string, sectionName: string): string {
	const sectionMatch = content.match(new RegExp(`<${sectionName}>\\n([\\s\\S]*?)\\n</${sectionName}>`));
	const sectionContent = sectionMatch?.[1];
	if (sectionContent === undefined) throw new Error(`missing <${sectionName}> section`);
	return sectionContent;
}

async function makeTempRoot(): Promise<string> {
	// Keep project-discovery fixtures outside the real user HOME even when
	// TMPDIR points at ~/tmp; otherwise walk-up discovery can pick up
	// ~/.gjc/agents as a project config directory.
	const tempRoot = await fs.mkdtemp(path.join(path.sep, "tmp", "gjc-default-definitions-"));
	tempRoots.push(tempRoot);
	return tempRoot;
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
	const originalHome = process.env.HOME;
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-default-home-"));
	tempRoots.push(home);
	process.env.HOME = home;
	const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
	try {
		return await fn(home);
	} finally {
		homedirSpy.mockRestore();
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
		expect(definitions).toHaveLength(9);
		expect(workflowDefinitions.every(definition => definition.relativePath.startsWith("skills/"))).toBe(true);
		expect(workflowDefinitions.every(definition => definition.content.includes(definition.name))).toBe(true);
		expect(fragmentDefinitions).toHaveLength(5);
		expect(fragmentDefinitions.map(definition => definition.parentSkillName).sort()).toEqual([
			"deep-interview",
			"deep-interview",
			"deep-interview",
			"ultragoal",
			"ultragoal",
		]);
		expect(fragmentDefinitions.map(definition => definition.relativePath).sort()).toEqual([
			"skill-fragments/deep-interview/auto-answer-uncertain.md",
			"skill-fragments/deep-interview/auto-research-greenfield.md",
			"skill-fragments/deep-interview/lateral-review-panel.md",
			"skill-fragments/ultragoal/ai-slop-cleaner.md",
			"skill-fragments/ultragoal/pipeline-validation-contracts.md",
		]);
		const team = workflowDefinitions.find(definition => definition.name === "team");
		expect(team?.content).toContain("supported surfaces only");
		expect(team?.content).toContain("`planner` for broad context mapping/sequencing");
		expect(team?.content).toContain("`architect` for architecture or external-doc-risk assessment");
		expect(team?.content).not.toMatch(/auto-delegate `researcher`|`researcher` as an evidence lane/i);
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

	it("exposes the ultragoal fragments only through the parent-scoped fragment accessor", () => {
		const fragments = getEmbeddedDefaultGjcSkillFragments("ultragoal");

		expect(
			getEmbeddedDefaultGjcSkills()
				.map(skill => skill.name)
				.sort(),
		).toEqual([...DEFAULT_GJC_DEFINITION_NAMES].sort());
		expect(fragments).toHaveLength(2);
		expect(fragments.map(fragment => fragment.kind)).toEqual(["skill-fragment", "skill-fragment"]);
		expect(fragments.map(fragment => fragment.relativePath).sort()).toEqual([
			"skill-fragments/ultragoal/ai-slop-cleaner.md",
			"skill-fragments/ultragoal/pipeline-validation-contracts.md",
		]);
		const cleaner = fragments.find(fragment => fragment.relativePath.endsWith("ai-slop-cleaner.md"))!;
		expect(cleaner.content).toContain("AI SLOP CLEANUP REPORT");
		expect(cleaner.content).toContain("read-only detector");
		const contracts = fragments.find(fragment => fragment.relativePath.endsWith("pipeline-validation-contracts.md"))!;
		expect(contracts.content).toContain("never user-facing");
		expect(contracts.content).toContain("fails closed");
	});

	it("authors the ai-slop-cleaner fragment with the mandated report labels and full taxonomy", () => {
		const fragment = getEmbeddedDefaultGjcSkillFragments("ultragoal").find(candidate =>
			candidate.relativePath.endsWith("ai-slop-cleaner.md"),
		)!;
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

	it("exposes default and four GJC role agents as model assignment targets", () => {
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
	it("renders shared ralplan partials while keeping the default executor prompt unchanged", () => {
		const executor = getBundledAgent("executor");
		const planner = getBundledAgent("planner");
		const architect = getBundledAgent("architect");
		const critic = getBundledAgent("critic");

		expect(prompt.render(executor?.systemPrompt ?? "", { ultragoalRedTeam: false })).not.toContain(
			"<ultragoal_red_team_mode>",
		);
		for (const agent of [planner, architect, critic]) {
			expect(agent?.systemPrompt).toContain("GJC_RALPLAN_ARTIFACT");
			expect(agent?.systemPrompt).toContain(`--stage ${agent?.name}`);
			expect(agent?.systemPrompt).toContain("restricted `bash`");
		}
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

	it("keeps role-agent routing concise in the system prompt", async () => {
		const systemPrompt = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "prompts", "system", "system-prompt.md"),
		).text();
		const ultragoal = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills", "ultragoal", "SKILL.md"),
		).text();

		expect(systemPrompt).toContain("Delegate large implementation slices to `executor`");
		expect(systemPrompt).not.toContain("<role-agent-surface>");
		expect(ultragoal).toContain("Role agents return implementation/review evidence");
	});

	it("documents validation-batch granularity, contract, and intra-goal lane parallelism in the ultragoal prompt", async () => {
		const ultragoal = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills", "ultragoal", "SKILL.md"),
		).text();

		// A: create-goals granularity — merge validation-coupled stories, fan out executor slices.
		expect(ultragoal).toContain("validation-coupled");
		expect(ultragoal).toContain("Merge validation-coupled stories into one goal");
		expect(ultragoal).toContain("fan out executor slices");
		expect(ultragoal).toContain("the same feature stack");
		expect(ultragoal).toContain("the same red-team surface");
		expect(ultragoal).toContain("the same final review boundary");

		// B: validation-batch contract summary in the SKILL; full contract in the fragment.
		expect(ultragoal).toContain("## Validation batches (aggregate-only)");
		expect(ultragoal).toContain("--validation-batch-json");
		expect(ultragoal).toContain("aggregate-only");
		expect(ultragoal).toContain("fail-closed");
		expect(ultragoal).toContain("deferredToBatch");
		expect(ultragoal).toContain("validation-batch-deferred");
		expect(ultragoal).toContain("validationBatchClose");
		expect(ultragoal).toContain("mutually exclusive");
		expect(ultragoal).toContain("no batch/pipeline mixing");
		expect(ultragoal).toContain("out-of-order close is rejected");
		expect(ultragoal).toContain("append-only proof");
		expect(ultragoal).toContain("cumulative-since-base");
		expect(ultragoal).toContain("skill-fragments/ultragoal/pipeline-validation-contracts.md");

		const contracts = getEmbeddedDefaultGjcSkillFragments("ultragoal").find(fragment =>
			fragment.relativePath.endsWith("pipeline-validation-contracts.md"),
		)!;
		expect(contracts.content).toContain("deferredToBatch");
		expect(contracts.content).toContain("validation-batch-deferred");
		expect(contracts.content).toContain("validationBatchClose");
		expect(contracts.content).toContain("out-of-order close is rejected");
		expect(contracts.content).toContain("append-only proof");
		expect(contracts.content).toContain("Never stamp");
		expect(contracts.content).toContain("cumulative-since-base");
		expect(contracts.content).toContain("`cumulativeFromBase: true`");
		expect(contracts.content).toContain("`memberGoalId` is a label not a per-path attribution");
		expect(contracts.content).toContain("Batch invalidation is fail-closed");

		// B: receipts freshness for deferred members.
		expect(ultragoal).toContain(
			"Deferred per-goal receipts (validation-batch members) are incomplete until a matching fresh batch-close receipt exists",
		);

		// C: intra-goal validation-lane parallelism.
		expect(ultragoal).toContain("### Intra-goal validation-lane parallelism");
		expect(ultragoal).toContain("frozen post-cleaner change set");
		expect(ultragoal).toContain("architect review and the executor QA/red-team lane MAY run in parallel");
		expect(ultragoal).toContain("join before checkpoint");
		expect(ultragoal).toContain("Fall back to **sequential** lanes");
		expect(ultragoal).toContain("red-team lane depends on architect fixes");
	});

	it("routes simple clear implementation requests directly without contradictory workflow escalation", async () => {
		const systemPrompt = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "prompts", "system", "system-prompt.md"),
		).text();
		const routing = extractPromptSection(systemPrompt, "routing");
		const decomposition = extractPromptSection(systemPrompt, "decomposition");

		expect(routing).toContain("Clear, low-risk implementation requests use direct tools");
		expect(routing).toContain("Informational questions are answer-only/read-only");
		expect(routing).toContain("Vague requirements use `/skill:deep-interview`");
		expect(routing).toContain("`/skill:ralplan --deliberate`");
		expect(routing).toContain("`/skill:ultragoal`");
		expect(routing).toContain("`/skill:team`");
		expect(routing).toContain("Delegate large implementation slices to `executor`");
		expect(routing.split("\n").filter(line => line.startsWith("-"))).toHaveLength(6);
		expect(decomposition).toMatch(/skip it for one-step or obvious two-step fixes/i);
	});

	it("documents leader-owned Ultragoal checkpoints for Team bridge workers", async () => {
		const team = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills", "team", "SKILL.md"),
		).text();
		const ultragoal = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills", "ultragoal", "SKILL.md"),
		).text();

		expect(team).toContain("current-session active GJC goal snapshot");
		expect(ultragoal).toContain("current-session GJC goal snapshot");
		for (const content of [team, ultragoal]) {
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

		for (const required of ["ask", ".gjc/_session-{sessionid}/state", "pending approval"]) {
			expect(content).toContain(required);
		}
		expect(content).toContain("/skill:ralplan");
		expect(content).toContain("/skill:team");
		expect(content).toContain("`gjc ralplan` is a native CLI");
		expect(content).toContain("Direct `.gjc/` file edits are forbidden unless an explicit force override is active");
		expect(content).toContain("do not edit `.gjc/_session-{sessionid}/state` directly without force override");
		expect(content).toContain("gjc state clear --force --mode deep-interview");
		expect(content).toContain("default `0.05`");
		expect(content).toContain("language.instruction");
		expect(content).toContain(
			"default to English unless `{{ARGUMENTS}}` makes another user/session language obvious",
		);
		expect(content).toContain('"language": "<existing language object from active state, if present>"');
		expect(content).toContain("progress reports, and spec prose");
		expect(content).toContain("translated/localized according to `language.instruction`");
		expect(content).toContain("must not print `Question:`/`Options:` blocks as assistant prose");
		expect(content).toContain("call `ask` with the same question/options");
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
		expect(content).toContain("do not directly edit `.gjc/_session-{sessionid}/plans`");
		expect(content).toContain("gjc state clear --force --mode ralplan");
		expect(content).toContain('workflowGate: { stage: "ralplan", kind: "approval" }');
		expect(content).toContain("RPC/headless clients receive a `ralplan`/`approval` workflow gate");
		expect(content).toContain(
			"Direct `write`, `edit`, or `ast_edit` calls against `.gjc/_session-{sessionid}/specs`, `.gjc/_session-{sessionid}/plans`, `.gjc/_session-{sessionid}/state`, or any other `.gjc/` path are forbidden",
		);
	});

	it("installs bundled workflow skill definitions without overwriting local edits unless forced", async () => {
		const targetRoot = await makeTempRoot();
		const initial = await installDefaultGjcDefinitions({ targetRoot });
		const deepInterviewSkillPath = path.join(targetRoot, "skills", "deep-interview", "SKILL.md");
		const installedDeepInterview = await Bun.file(deepInterviewSkillPath).text();

		expect(initial.written).toBe(9);
		expect(initial.total).toBe(9);
		expect(initial.skipped).toBe(0);
		expect(initial.files.filter(file => file.kind === "skill-fragment")).toHaveLength(5);

		const installedResearchFragment = await Bun.file(
			path.join(targetRoot, "skill-fragments", "deep-interview", "auto-research-greenfield.md"),
		).text();
		expect(installedResearchFragment).toContain("ranked candidate answers");
		await Bun.write(deepInterviewSkillPath, "local edit");
		const skipped = await installDefaultGjcDefinitions({ targetRoot });
		expect(skipped.written).toBe(0);
		expect(skipped.skipped).toBe(9);
		expect(await Bun.file(deepInterviewSkillPath).text()).toBe("local edit");

		const check = await installDefaultGjcDefinitions({ targetRoot, check: true });
		expect(check.different).toBe(1);
		expect(check.matching).toBe(8);

		const forced = await installDefaultGjcDefinitions({ targetRoot, force: true });
		expect(forced.written).toBe(9);
		expect(await Bun.file(deepInterviewSkillPath).text()).toBe(installedDeepInterview);
		expect(
			forced.files.some(file => file.kind === "skill-fragment" && file.parentSkillName === "deep-interview"),
		).toBe(true);
	});

	it("refreshOnly rewrites stale local copies but never materializes missing ones", async () => {
		const targetRoot = await makeTempRoot();
		const deepInterviewSkillPath = path.join(targetRoot, "skills", "deep-interview", "SKILL.md");

		// No files on disk yet: refreshOnly must not create any (opt-in preserved).
		const untouched = await installDefaultGjcDefinitions({ targetRoot, refreshOnly: true });
		expect(untouched.written).toBe(0);
		expect(untouched.missing).toBe(9);
		expect(await Bun.file(deepInterviewSkillPath).exists()).toBe(false);

		// User opted in, then a local file went stale relative to the embedded default.
		const installed = await installDefaultGjcDefinitions({ targetRoot });
		const canonicalDeepInterview = await Bun.file(deepInterviewSkillPath).text();
		expect(installed.written).toBe(9);
		await Bun.write(deepInterviewSkillPath, "stale content");

		const refreshed = await installDefaultGjcDefinitions({ targetRoot, refreshOnly: true });
		expect(refreshed.written).toBe(1);
		expect(refreshed.matching).toBe(8);
		expect(refreshed.missing).toBe(0);
		expect(await Bun.file(deepInterviewSkillPath).text()).toBe(canonicalDeepInterview);

		// Second refresh is a no-op once everything matches.
		const stable = await installDefaultGjcDefinitions({ targetRoot, refreshOnly: true });
		expect(stable.written).toBe(0);
		expect(stable.matching).toBe(9);
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
		expect(JSON.parse(jsonStdout) as { skipped: number }).toMatchObject({ skipped: 9 });
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
