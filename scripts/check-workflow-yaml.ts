#!/usr/bin/env bun
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const workflowDir = path.join(repoRoot, ".github", "workflows");
const entries = await fs.readdir(workflowDir, { withFileTypes: true });
const workflowFiles = entries
	.filter(entry => entry.isFile() && /\.ya?ml$/i.test(entry.name))
	.map(entry => path.join(workflowDir, entry.name))
	.sort();

for (const workflowFile of workflowFiles) {
	const relativePath = path.relative(repoRoot, workflowFile);
	const result = await $`bunx --bun --package yaml@2 yaml valid < ${workflowFile}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		console.error(`Failed to parse ${relativePath}:`);
		console.error(result.stderr.toString().trim() || result.stdout.toString().trim());
		process.exit(result.exitCode || 1);
	}
	console.log(`parsed ${relativePath}`);
}
