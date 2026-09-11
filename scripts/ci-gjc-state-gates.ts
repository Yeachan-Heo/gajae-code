#!/usr/bin/env bun
import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { expandWithDependents, getWorkspacePackages, isDocOrChangelogPath, isFullWorkspacePath, isRustPath, type WorkspacePackage } from "./ci-dev-affected";

const repoRoot = path.join(import.meta.dir, "..");
const runtimeMarkdownPrefixes = [
	"packages/coding-agent/src/",
	"packages/agent/src/",
	"packages/ai/src/",
] as const;

// Used by both the lightweight relevance job and local/sharded gate execution.
export function relevantStateGatePaths(files: readonly string[] | null, packages: readonly WorkspacePackage[]): string[] {
	if (files === null) throw new Error("gjc-state-gates: changed paths are unresolved");
	const names = new Set(packages.map(pkg => pkg.name));
	if (!packages.some(pkg => pkg.dir === "packages/coding-agent") || names.size !== packages.length) {
		throw new Error("gjc-state-gates: coding-agent workspace graph is unresolved");
	}
	for (const pkg of packages) {
		for (const scope of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
			for (const [name, version] of Object.entries(pkg.manifest[scope] ?? {})) {
				if (version.startsWith("workspace:") && !names.has(name)) {
					throw new Error(`gjc-state-gates: unresolved workspace dependency ${name}`);
				}
			}
		}
	}
	return files.filter(file => {
		if (!file || path.posix.isAbsolute(file) || file.split("/").includes("..")) {
			throw new Error("gjc-state-gates: invalid changed path");
		}
		// Markdown under runtime package source is bundled input, not documentation-only.
		if (isDocOrChangelogPath(file) && !runtimeMarkdownPrefixes.some(prefix => file.startsWith(prefix))) return false;
		if (isFullWorkspacePath(file) || isRustPath(file)) return true;
		const touched = packages.filter(pkg => file === pkg.dir || file.startsWith(`${pkg.dir}/`));
		// Unknown paths include lockfiles, CI harnesses and deleted packages. They
		// cannot establish irrelevance; only known unrelated packages may skip.
		if (touched.length === 0) return true;
		return expandWithDependents(touched, packages).some(pkg => pkg.dir === "packages/coding-agent");
	});
}

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
	// NOTE: state-writer-drift.test.ts imports recordSkillActivation (hooks),
	// which loads the @gajae-code/natives addon transitively, so it runs in the
	// heavier "Affected path validation" job, not this native-free gate.
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
	// NOTE: workflow-mutation-guard, gjc-skill-state-hooks, and skill-active-state
	// load the @gajae-code/natives addon transitively via the tool/hook runtime, so they
	// run in the heavier "Affected path validation" job rather than this native-free gate.
	],
};

const groupNames = Object.keys(boundedGateGroups);

export async function changedFiles(cwd = repoRoot, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	const base = env.GITHUB_BASE_SHA || (env.GITHUB_EVENT_NAME !== "pull_request" ? env.GITHUB_EVENT_BEFORE : undefined);
	if (!base || /^0+$/.test(base)) {
		throw new Error("gjc-state-gates: no comparable base SHA found");
	}
	// Reject refs/options: CI must compare the immutable event base to the exact head.
	if (!/^[a-f0-9]{40}$/i.test(base)) throw new Error("gjc-state-gates: invalid base SHA");
	const present = await $`git cat-file -e ${`${base}^{commit}`}`.cwd(cwd).quiet().nothrow();
	if (present.exitCode !== 0) await $`git fetch --no-tags --depth=1 origin ${base}`.cwd(cwd).quiet();
	// Disable rename detection so moving a relevant source into an unrelated
	// package still includes its removed path. NUL delimiters preserve filenames.
	const result = await $`git diff --no-renames --name-only -z ${base} HEAD`.cwd(cwd).quiet();
	return result.stdout.toString().split("\0").filter(Boolean);
}

async function main(): Promise<void> {
	if (process.argv.includes("--groups-json")) {
		console.log(JSON.stringify(groupNames.map(group => ({ group }))));
		return;
	}
	const groupArg = process.argv.find(arg => arg.startsWith("--group="));
	const selectedGroup = groupArg?.slice("--group=".length) || "all";
	if (selectedGroup !== "all" && !boundedGateGroups[selectedGroup]) {
		throw new Error(`gjc-state-gates: unknown group '${selectedGroup}'. Known groups: ${groupNames.join(", ")}`);
	}
	const files = await changedFiles();
	const relevantFiles = relevantStateGatePaths(files, await getWorkspacePackages());
	if (process.argv.includes("--emit-relevance")) {
		const output = process.env.GITHUB_OUTPUT;
		if (!output) throw new Error("gjc-state-gates: GITHUB_OUTPUT is required");
		await fs.appendFile(output, `relevant=${relevantFiles.length > 0}\n`);
		console.log(`gjc-state-gates: inspected ${files.length} changed path(s); relevant=${relevantFiles.length > 0}`);
		return;
	}
	if (relevantFiles.length === 0) {
		console.log("gjc-state-gates: no relevant paths changed; gate commands skipped.");
		return;
	}
	// Keep state-runtime tests hermetic without mutating importing test processes.
	delete process.env.GJC_SESSION_ID;
	delete process.env.GJC_STATE_SESSION_ID;
	console.log(`gjc-state-gates: relevant paths changed; running group ${selectedGroup}.`);
	const commands = selectedGroup === "all" ? groupNames.flatMap(group => boundedGateGroups[group]) : boundedGateGroups[selectedGroup];
	for (const command of commands) {
		console.log(`gjc-state-gates: running ${command.join(" ")}`);
		await $`${command}`.cwd(repoRoot);
	}
	console.log(`gjc-state-gates: group ${selectedGroup} passed.`);
}

if (import.meta.main) await main();
