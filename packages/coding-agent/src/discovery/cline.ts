/**
 * Cline Provider
 *
 * Loads rules from .clinerules (can be single file or directory with *.md files).
 * Project-only (no user-level config).
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type ReadFileOptions, readDirEntries, readFile } from "../capability/fs";
import type { Rule } from "../capability/rule";
import { ruleCapability } from "../capability/rule";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	buildRuleFromMarkdown,
	canonicalizePathWithinHome,
	createSourceMeta,
	getReadOptions,
	loadFilesFromDir,
} from "./helpers";

const PROVIDER_ID = "cline";
const DISPLAY_NAME = "Cline";
const PRIORITY = 40;

async function findClinerules(
	startDir: string,
	stopAt: string,
	readOptions?: ReadFileOptions,
): Promise<{ path: string; isDir: boolean } | null> {
	let current = path.resolve(startDir);
	const resolvedStop = path.resolve(stopAt);
	const relativeStop = path.relative(resolvedStop, current);
	const effectiveStop =
		relativeStop === "" ||
		(relativeStop !== ".." && !relativeStop.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeStop))
			? resolvedStop
			: current;

	while (true) {
		const entries = await readDirEntries(current, readOptions);
		const entry = entries.find(e => e.name === ".clinerules");
		if (entry) {
			return {
				path: path.resolve(current, ".clinerules"),
				isDir: entry.isDirectory(),
			};
		}
		const parent = path.dirname(current);
		if (current === effectiveStop || parent === current) return null;
		current = parent;
	}
}

/**
 * Load rules from .clinerules
 */
async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	// Project-level only (Cline uses root-level .clinerules)
	const homeRelative = path.relative(ctx.home, ctx.cwd);
	const cwdIsWithinHome =
		homeRelative === "" ||
		(homeRelative !== ".." && !homeRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(homeRelative));
	const stopDirectory = ctx.repoRoot ?? (ctx.isolatedHome || cwdIsWithinHome ? ctx.home : ctx.cwd);
	const readOptions = getReadOptions(ctx, "project");
	const found = await findClinerules(ctx.cwd, stopDirectory, readOptions);
	if (!found) {
		return { items, warnings };
	}

	// Check if .clinerules is a directory or file
	if (found.isDir) {
		// Directory format: load all *.md files
		const result = await loadFilesFromDir(ctx, found.path, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: (name, content, path, source) =>
				buildRuleFromMarkdown(name, content, path, source, { stripNamePattern: /\.md$/ }),
		});

		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	} else {
		// Single file format
		const filePath = await canonicalizePathWithinHome(ctx, found.path, undefined, "project");
		if (!filePath) {
			warnings.push(`Refusing to read .clinerules outside the supplied home at ${found.path}`);
			return { items, warnings };
		}
		const content = await readFile(filePath, readOptions);
		if (content === null) {
			warnings.push(`Failed to read .clinerules at ${filePath}`);
			return { items, warnings };
		}

		const source = createSourceMeta(PROVIDER_ID, filePath, "project");
		items.push(buildRuleFromMarkdown("clinerules.md", content, filePath, source, { ruleName: "clinerules" }));
	}

	return { items, warnings };
}

// Register provider
registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load rules from .clinerules (single file or directory)",
	priority: PRIORITY,
	load: loadRules,
});
