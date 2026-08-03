#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";

const expectedWorkflowSkills = ["deep-interview", "ralplan", "team", "ultragoal"];
const expectedRoleAgents = ["architect", "critic", "executor", "planner"];
const repoRoot = process.cwd();

function listSkillDirs(dir: string): string[] {
	const full = path.join(repoRoot, dir);
	if (!fs.existsSync(full)) return [];
	return fs
		.readdirSync(full, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && fs.existsSync(path.join(full, entry.name, "SKILL.md")))
		.map(entry => entry.name);
}

function listDefinitionFiles(dir: string, extensions: readonly string[]): string[] {
	const full = path.join(repoRoot, dir);
	if (!fs.existsSync(full)) return [];
	return fs
		.readdirSync(full, { withFileTypes: true })
		.filter(entry => entry.isFile() && extensions.some(extension => entry.name.endsWith(extension)))
		.map(entry => {
			const extension = extensions.find(candidate => entry.name.endsWith(candidate));
			return extension ? entry.name.slice(0, -extension.length) : entry.name;
		});
}

const visibleSkills = listSkillDirs(".gjc/skills").sort();
const visibleAgents = listDefinitionFiles(".gjc/agents", [".md", ".toml"]).sort();
const otherVisibleDefinitions = [
	...listDefinitionFiles(".gjc/commands", [".md"]),
	...listDefinitionFiles(".gjc/rules", [".md"]),
].sort();
const bundledSkills = listSkillDirs("packages/coding-agent/src/defaults/gjc/skills").sort();
const bundledRoleAgents = listDefinitionFiles("packages/coding-agent/src/prompts/agents", [".md"])
	.filter(name => expectedRoleAgents.includes(name))
	.sort();
const unexpectedVisible = [...visibleSkills, ...visibleAgents, ...otherVisibleDefinitions].sort();
const missingBundledSkills = expectedWorkflowSkills.filter(name => !bundledSkills.includes(name));
const missingRoleAgents = expectedRoleAgents.filter(name => !bundledRoleAgents.includes(name));
const ignoredDefinitions = getIgnoredDefinitionPaths([
	...expectedWorkflowSkills.map(name => `packages/coding-agent/src/defaults/gjc/skills/${name}/SKILL.md`),
	...expectedRoleAgents.map(name => `packages/coding-agent/src/prompts/agents/${name}.md`),
]);

if (
	unexpectedVisible.length > 0 ||
	missingBundledSkills.length > 0 ||
	missingRoleAgents.length > 0 ||
	ignoredDefinitions.length > 0 ||
	bundledSkills.length !== expectedWorkflowSkills.length ||
	bundledRoleAgents.length !== expectedRoleAgents.length
) {
	console.error("Default surface definitions mismatch");
	console.error(
		JSON.stringify(
			{
				expectedWorkflowSkills,
				expectedRoleAgents,
				visibleSkills,
				visibleAgents,
				otherVisibleDefinitions,
				bundledSkills,
				bundledRoleAgents,
				missingBundledSkills,
				missingRoleAgents,
				ignoredDefinitions,
				unexpectedVisible,
			},
			null,
			2,
		),
	);
	process.exit(1);
}

console.log(
	`Default surface OK: bundled workflow skills=${bundledSkills.join(", ")} bundled role agents=${bundledRoleAgents.join(", ")}`,
);

function getIgnoredDefinitionPaths(paths: string[]): string[] {
	const ignored: string[] = [];
	for (const filePath of paths) {
		const result = Bun.spawnSync(["git", "check-ignore", filePath], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode === 0) {
			ignored.push(filePath);
		}
	}
	return ignored;
}
