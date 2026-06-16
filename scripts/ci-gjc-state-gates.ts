#!/usr/bin/env bun
import { $ } from "bun";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
// Local agent sessions may export a workflow session id, which would redirect
// state-runtime tests into session-scoped state paths. CI gates exercise the
// default native-free state files, so keep this script hermetic.
delete process.env.GJC_SESSION_ID;
delete process.env.GJC_STATE_SESSION_ID;

const relevantPathPrefixes = [
	"packages/coding-agent/",
	".github/workflows/dev-ci.yml",
	".github/workflows/ci.yml",
	"scripts/ci-gjc-state-gates.ts",
	"scripts/verify-gjc-state-writers.ts",
	"scripts/generate-gjc-workflow-manifest.ts",
	"scripts/verify-gjc-skill-docs.ts",
	"scripts/verify-g002-gates.ts",
	"package.json",
	"bun.lock",
	"tsconfig.json",
	"tsconfig.base.json",
	"tsconfig.tools.json",
];

const boundedGateGroups: Record<string, readonly (readonly string[])[]> = {
	static: [
	["bun", "scripts/verify-gjc-state-writers.ts", "--fail"],
	["bun", "scripts/generate-gjc-workflow-manifest.ts", "--check"],
	["bun", "scripts/verify-gjc-skill-docs.ts", "--fail"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-schema.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-migrations.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-schema-corpus.test.ts"],
	],
	runtime: [
	// NOTE: state-writer-drift.test.ts imports recordSkillActivation (hooks) and
	// persistGjcTeamModeStateSummary (team-runtime), which load the @gajae-code/natives
	// addon transitively, so it runs in the heavier "Affected path validation" job, not
	// this native-free gate.
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-runtime.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-handoff.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-receipts.test.ts"],
	],
	integrity: [
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-integrity.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-write-hardening.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-graph.test.ts"],
	],
	read: [
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-read-markdown.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-token-thrift.test.ts"],
	// Lane H read-only doctor: imports only the native-free state-runtime module.
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-doctor.test.ts"],
	// NOTE: deep-interview-mutation-guard, gjc-skill-state-hooks, and skill-active-state
	// load the @gajae-code/natives addon transitively via the tool/hook runtime, so they
	// run in the heavier "Affected path validation" job rather than this native-free gate.
	],
};

const groupNames = Object.keys(boundedGateGroups);

function printGroupsJson(): never {
	console.log(JSON.stringify(groupNames.map(group => ({ group }))));
	process.exit(0);
}

async function changedFiles(): Promise<string[]> {
	if (process.env.GITHUB_EVENT_NAME === "pull_request" && process.env.GITHUB_BASE_SHA) {
		await $`git fetch --no-tags --depth=1 origin ${process.env.GITHUB_BASE_SHA}`.cwd(repoRoot).nothrow();
		const result = await $`git diff --name-only ${process.env.GITHUB_BASE_SHA} HEAD`.cwd(repoRoot).quiet();
		return result.stdout.toString().split("\n").filter(Boolean);
	}

	if (process.env.GITHUB_EVENT_BEFORE && !/^0+$/.test(process.env.GITHUB_EVENT_BEFORE)) {
		await $`git fetch --no-tags --depth=1 origin ${process.env.GITHUB_EVENT_BEFORE}`.cwd(repoRoot).nothrow();
		const result = await $`git diff --name-only ${process.env.GITHUB_EVENT_BEFORE} HEAD`.cwd(repoRoot).quiet();
		return result.stdout.toString().split("\n").filter(Boolean);
	}

	console.log("gjc-state-gates: no comparable base SHA found; running bounded gates.");
	return ["packages/coding-agent/"];
}

function isRelevant(file: string): boolean {
	return relevantPathPrefixes.some(prefix => file === prefix || file.startsWith(prefix));
}

if (process.argv.includes("--groups-json")) {
	printGroupsJson();
}

const groupArg = process.argv.find(arg => arg.startsWith("--group="));
const selectedGroup = groupArg?.slice("--group=".length) || "all";
if (selectedGroup !== "all" && !boundedGateGroups[selectedGroup]) {
	console.error(`gjc-state-gates: unknown group '${selectedGroup}'. Known groups: ${groupNames.join(", ")}`);
	process.exit(2);
}

const files = await changedFiles();
const relevantFiles = files.filter(isRelevant);

if (relevantFiles.length === 0) {
	console.log("gjc-state-gates: no relevant paths changed; gate commands skipped.");
	console.log(`gjc-state-gates: inspected ${files.length} changed path(s).`);
	process.exit(0);
}

console.log(`gjc-state-gates: relevant paths changed; running group ${selectedGroup}.`);
for (const file of relevantFiles) {
	console.log(`gjc-state-gates: relevant ${file}`);
}

const commands = selectedGroup === "all" ? groupNames.flatMap(group => boundedGateGroups[group]) : boundedGateGroups[selectedGroup];
for (const command of commands) {
	console.log(`gjc-state-gates: running ${command.join(" ")}`);
	await $`${command}`.cwd(repoRoot);
}

console.log(`gjc-state-gates: group ${selectedGroup} passed.`);
