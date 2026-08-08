#!/usr/bin/env bun

/**
 * Remove build output from this checkout. Regenerating everything it deletes is a
 * documented `bun run` away, so it never touches sources, dependencies, `.gjc/`
 * runtime state, or `artifacts/` evidence.
 *
 * Usage:
 *   bun scripts/clean.ts              # dist/, binaries/, stray *.bun-build, coverage
 *   bun scripts/clean.ts --native     # also drop compiled native addons (.node)
 *   bun scripts/clean.ts --dry-run    # list what would be removed
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { absoluteTarget, type CleanOptions, resolveCleanTargets } from "./clean-core";

const repoRoot = path.join(import.meta.dir, "..");

export function parseArgs(argv: readonly string[]): CleanOptions & { dryRun: boolean } {
	let native = false;
	let dryRun = false;
	for (const arg of argv) {
		if (arg === "--native") {
			native = true;
			continue;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { native, dryRun };
}

if (import.meta.main) {
	const { dryRun, ...options } = parseArgs(process.argv.slice(2));
	const targets = await resolveCleanTargets(repoRoot, options);
	if (targets.length === 0) {
		console.log("clean: nothing to remove");
	}
	for (const target of targets) {
		if (dryRun) {
			console.log(`clean: would remove ${target}`);
			continue;
		}
		await fs.rm(absoluteTarget(repoRoot, target), { recursive: true, force: true });
		console.log(`clean: removed ${target}`);
	}
}
