#!/usr/bin/env bun
/**
 * Conservative changed-path relevance gate for expensive CI jobs.
 *
 * Emits `relevant=true|false` to $GITHUB_OUTPUT. `relevant=false` is only
 * produced when the run is a pull_request with a known base SHA and EVERY
 * changed path is provably irrelevant (markdown, docs/, .gjc/). Any other
 * event, missing data, or error fails open to `relevant=true` so validation
 * is never weakened by ambiguity.
 */

import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

interface Decision {
	relevant: boolean;
	reason: string;
}

function isProvablyIrrelevant(changedPath: string): boolean {
	return changedPath.endsWith(".md") || changedPath.startsWith("docs/") || changedPath.startsWith(".gjc/");
}

async function changedFiles(baseSha: string): Promise<string[]> {
	await $`git fetch --no-tags --depth=1 origin ${baseSha}`.cwd(repoRoot).quiet().nothrow();
	const result = await $`git diff --name-only ${baseSha} HEAD`.cwd(repoRoot).quiet();
	return result.stdout.toString().split("\n").filter(Boolean);
}

async function decide(): Promise<Decision> {
	const eventName = process.env.GITHUB_EVENT_NAME ?? "";
	if (eventName !== "pull_request") {
		return { relevant: true, reason: `event '${eventName || "unknown"}' is not pull_request; running everything` };
	}

	const baseSha = process.env.GITHUB_BASE_SHA;
	if (!baseSha) {
		return { relevant: true, reason: "GITHUB_BASE_SHA missing; running everything" };
	}

	const files = await changedFiles(baseSha);
	if (files.length === 0) {
		return { relevant: true, reason: "empty diff against base; running everything" };
	}

	const relevantFiles = files.filter(file => !isProvablyIrrelevant(file));
	if (relevantFiles.length > 0) {
		return { relevant: true, reason: `relevant path changed: ${relevantFiles[0]}` };
	}

	return {
		relevant: false,
		reason: `all ${files.length} changed path(s) are provably irrelevant (*.md, docs/, .gjc/)`,
	};
}

let decision: Decision;
try {
	decision = await decide();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	decision = { relevant: true, reason: `relevance check failed (${message}); running everything` };
}

console.log(`ci-job-relevance: relevant=${decision.relevant} (${decision.reason})`);

if (process.env.GITHUB_OUTPUT) {
	await fs.appendFile(process.env.GITHUB_OUTPUT, `relevant=${decision.relevant}\n`);
}
