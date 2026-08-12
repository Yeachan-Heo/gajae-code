/**
 * Claude Code project/global skill layout adapter (import source).
 *
 * The `.claude/skills` layout is an explicit import source into the canonical
 * `.gjc` skill locations — it is never loaded as an ordinary runtime authority.
 * These helpers enumerate the layout for import/inspection consumers (#4291
 * import UI, #4288 provenance diagnostics) and are deliberately NOT registered
 * as capability providers: activating Claude's other surfaces (MCP servers,
 * hooks, commands, tools, prompts, settings) is owned by sibling issues.
 *
 * User-home `~/.claude/skills` is enumerated as an explicit import candidate
 * only; it is never loaded into sessions without an explicit import action.
 */
import * as path from "node:path";
import { hasFsCode } from "@gajae-code/utils";
import type { Skill } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta, scanSkillsFromDir } from "./helpers";

export const CLAUDE_PROVIDER_ID = "claude";
export const CLAUDE_DISPLAY_NAME = "Claude Code";
export const CLAUDE_CONFIG_DIR = ".claude";

function isMissingDirectoryError(error: unknown): boolean {
	return hasFsCode(error, "ENOENT") || hasFsCode(error, "ENOTDIR");
}

/**
 * Enumerate `.claude/skills` from every ancestor of `cwd` up to the repo root
 * (closest first) — the Claude Code project convention.
 */
export async function scanClaudeProjectSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const projectScans: Promise<LoadResult<Skill>>[] = [];
	let current = ctx.cwd;
	while (true) {
		projectScans.push(
			scanSkillsFromDir(ctx, {
				dir: path.join(current, CLAUDE_CONFIG_DIR, "skills"),
				providerId: CLAUDE_PROVIDER_ID,
				level: "project",
				requireDescription: true,
			}),
		);
		if (current === (ctx.repoRoot ?? ctx.home)) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const results = await Promise.allSettled(projectScans);
	const items: Skill[] = [];
	const warnings: string[] = [];
	for (const result of results) {
		if (result.status === "fulfilled") {
			items.push(...result.value.items);
			warnings.push(...(result.value.warnings ?? []));
		} else if (!isMissingDirectoryError(result.reason)) {
			warnings.push(`Failed to scan Claude project skills: ${String(result.reason)}`);
		}
	}
	return { items, warnings };
}

/**
 * Enumerate the user-global `~/.claude/skills` layout. This is an explicit
 * import candidate only; GJC never loads it without an explicit import action.
 */
export async function scanClaudeUserSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	return await scanSkillsFromDir(ctx, {
		dir: path.join(ctx.home, CLAUDE_CONFIG_DIR, "skills"),
		providerId: CLAUDE_PROVIDER_ID,
		level: "user",
		requireDescription: true,
	});
}

export function claudeSkillSourceMeta(filePath: string, level: "user" | "project") {
	return createSourceMeta(CLAUDE_PROVIDER_ID, filePath, level);
}
