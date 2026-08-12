/**
 * OpenAI Codex project/global skill layout adapter (import source).
 *
 * The `.codex/skills` layout is an explicit import source into the canonical
 * `.gjc` skill locations — it is never loaded as an ordinary runtime authority.
 * These helpers enumerate the layout for import/inspection consumers (#4291
 * import UI, #4288 provenance diagnostics) and are deliberately NOT registered
 * as capability providers: activating Codex's other surfaces (MCP servers,
 * hooks, commands, tools, prompts, settings) is owned by sibling issues.
 *
 * User-home `~/.codex/skills` is enumerated as an explicit import candidate
 * only; it is never loaded into sessions without an explicit import action.
 */
import * as path from "node:path";
import type { Skill } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta, scanSkillsFromDir } from "./helpers";

export const CODEX_PROVIDER_ID = "codex";
export const CODEX_DISPLAY_NAME = "OpenAI Codex";
export const CODEX_CONFIG_DIR = ".codex";

/**
 * Enumerate the project-local `.codex/skills` layout (cwd only), mirroring the
 * OpenAI Codex project convention.
 */
export async function scanCodexProjectSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	return await scanSkillsFromDir(ctx, {
		dir: path.join(ctx.cwd, CODEX_CONFIG_DIR, "skills"),
		providerId: CODEX_PROVIDER_ID,
		level: "project",
		requireDescription: true,
	});
}

/**
 * Enumerate the user-global `~/.codex/skills` layout. This is an explicit
 * import candidate only; GJC never loads it without an explicit import action.
 */
export async function scanCodexUserSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	return await scanSkillsFromDir(ctx, {
		dir: path.join(ctx.home, CODEX_CONFIG_DIR, "skills"),
		providerId: CODEX_PROVIDER_ID,
		level: "user",
		requireDescription: true,
	});
}

export function codexSkillSourceMeta(filePath: string, level: "user" | "project") {
	return createSourceMeta(CODEX_PROVIDER_ID, filePath, level);
}
