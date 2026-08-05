import type { Skill as CapabilitySkill, SkillDescriptor as CapabilitySkillDescriptor } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	scanSkillsFromDir,
	SKILL_FRONTMATTER_SCAN_BYTES,
	SKILL_FRONTMATTER_SCAN_TOTAL_BYTES,
	type ScanSkillsFromDirOptions,
} from "../discovery/helpers";

export { SKILL_FRONTMATTER_SCAN_BYTES, SKILL_FRONTMATTER_SCAN_TOTAL_BYTES, scanSkillsFromDir } from "../discovery/helpers";
export type { ScanSkillsFromDirOptions } from "../discovery/helpers";
export type { SkillFrontmatter, SkillDescriptor } from "../capability/skill";

/** Convert a discovered skill into a metadata-only descriptor. */
export function asSkillDescriptor(skill: CapabilitySkill): CapabilitySkillDescriptor {
	const { content: _content, loadContent: _loadContent, ...metadata } = skill;
	return { metadata, loadContent: skill.loadContent ?? (() => Bun.file(skill.path).text()) };
}

/**
 * Discover skills without reading their Markdown bodies. The returned
 * descriptors carry only frontmatter metadata; `loadContent` is the explicit
 * opt-in boundary for body bytes.
 */
export async function scanSkillDescriptorsFromDir(
	ctx: LoadContext,
	options: ScanSkillsFromDirOptions,
): Promise<LoadResult<CapabilitySkillDescriptor>> {
	const result = await scanSkillsFromDir(ctx, options);
	return {
		items: result.items.map(asSkillDescriptor),
		warnings: result.warnings,
	};
}

export type SkillDescriptorMetadata = CapabilitySkillDescriptor["metadata"];
export type SkillMetadata = Omit<CapabilitySkill, "content" | "loadContent">;
