/**
 * Regression test for #1266:
 * `RULES.md` (singular, top-level) MUST be loaded as a sticky always-apply rule
 * from both `~/.gjc/agent/RULES.md` (user) and the nearest `.gjc/RULES.md`
 * (project, walked up from cwd to repoRoot).
 *
 * Calls the native provider's `load` directly to bypass `loadCapability`'s
 * hardcoded `os.homedir()` so the user scope can be staged inside a tempdir.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@gajae-code/coding-agent/capability";
import { clearCache } from "@gajae-code/coding-agent/capability/fs";
import { type Rule, ruleCapability } from "@gajae-code/coding-agent/capability/rule";
import type { LoadContext } from "@gajae-code/coding-agent/capability/types";
// Register all discovery providers as a side effect.
import "@gajae-code/coding-agent/discovery";

let tempDir: string;
let home: string;
let project: string;

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

async function loadNativeRules(ctx: LoadContext): Promise<Rule[]> {
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const native = cap.providers.find(p => p.id === "native");
	if (!native) throw new Error("native rules provider missing");
	const result = await (native.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
	return result.items;
}

beforeEach(() => {
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-rules-md-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
});

afterEach(() => {
	clearCache();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("user ~/.gjc/agent/RULES.md becomes an alwaysApply rule", async () => {
	writeFile(
		path.join(home, ".gjc", "agent", "RULES.md"),
		"**CRITICAL**: You _MUST_ use beads task tracker for any project\n",
	);

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	const userRule = rules.find(r => r._source.level === "user" && r.name === "RULES");
	expect(userRule).toBeDefined();
	expect(userRule?.alwaysApply).toBe(true);
	expect(userRule?.content).toContain("beads task tracker");
});

test("project .gjc/RULES.md becomes an alwaysApply rule", async () => {
	writeFile(path.join(project, ".gjc", "RULES.md"), "# Project rule\nAlways say hi.\n");

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	const projectRule = rules.find(r => r._source.level === "project" && r.name === "RULES");
	expect(projectRule).toBeDefined();
	expect(projectRule?.alwaysApply).toBe(true);
	expect(projectRule?.content).toContain("Always say hi.");
});

test("orders user RULES.md before project RULES.md so project authority wins", async () => {
	writeFile(path.join(home, ".gjc", "agent", "RULES.md"), "User rule.\n");
	writeFile(path.join(project, ".gjc", "RULES.md"), "Project rule.\n");

	const stickyRules = (await loadNativeRules({ cwd: project, home, repoRoot: project })).filter(
		rule => rule.name === "RULES",
	);

	expect(stickyRules.map(rule => rule._source.level)).toEqual(["user", "project"]);
	expect(stickyRules.map(rule => rule.content.trim())).toEqual(["User rule.", "Project rule."]);
});

test("project RULES.md is found walking up from a sub-package cwd", async () => {
	const subPkg = path.join(project, "packages", "app");
	fs.mkdirSync(subPkg, { recursive: true });
	writeFile(path.join(project, ".gjc", "RULES.md"), "# Repo-wide sticky rule\n");

	const rules = await loadNativeRules({ cwd: subPkg, home, repoRoot: project });

	const projectRule = rules.find(r => r._source.level === "project" && r.name === "RULES");
	expect(projectRule).toBeDefined();
	expect(projectRule?.alwaysApply).toBe(true);
	expect(projectRule?.path).toBe(path.join(project, ".gjc", "RULES.md"));
});

test("alwaysApply is forced even when frontmatter says false", async () => {
	writeFile(path.join(home, ".gjc", "agent", "RULES.md"), "---\nalwaysApply: false\n---\nStick around anyway.\n");

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	const userRule = rules.find(r => r._source.level === "user" && r.name === "RULES");
	expect(userRule?.alwaysApply).toBe(true);
	expect(userRule?.content).toContain("Stick around anyway.");
});

test("user RULES.md does not follow a symlink outside the selected agent directory", async () => {
	const outside = path.join(tempDir, "outside-RULES.md");
	writeFile(outside, "Outside rule.\n");
	fs.mkdirSync(path.join(home, ".gjc", "agent"), { recursive: true });
	fs.symlinkSync(outside, path.join(home, ".gjc", "agent", "RULES.md"), "file");

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	expect(rules.find(rule => rule._source.level === "user" && rule.name === "RULES")).toBeUndefined();
});

test("absent RULES.md does not produce a rule", async () => {
	// No RULES.md anywhere — only a sibling .gjc/rules/ to make sure the directory exists.
	writeFile(path.join(home, ".gjc", "agent", "rules", "other.md"), "# Unrelated rule\n");

	const rules = await loadNativeRules({ cwd: project, home, repoRoot: project });

	expect(rules.find(r => r.name === "RULES")).toBeUndefined();
});
