/**
 * Skills Capability
 *
 * Skills provide specialized knowledge or workflows that extend agent capabilities.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Parsed frontmatter from a skill file.
 */
export interface SkillFrontmatter {
	name?: string;
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	/**
	 * When `true`, the skill is loaded and accessible via `skill://<name>` (and
	 * `/skill:<name>` slash commands), but is omitted from the rendered system
	 * prompt's skill listing. Use for skills the user opts into explicitly
	 * rather than ones the model should auto-discover.
	 */
	hide?: boolean;
	[key: string]: unknown;
}

/**
 * Metadata-only skill handle. Callers must opt in to reading the body through
 * `loadContent`; discovery never loads the body while building this metadata.
 */
export interface SkillDescriptor {
	readonly metadata: Omit<Skill, "content" | "loadContent">;
	readonly loadContent: () => Promise<string>;
}

/**
 * A skill that provides specialized knowledge or workflows.
 */
export interface Skill {
	/** Skill name (unique key, derived from filename or frontmatter) */
	name: string;
	/** Absolute path to skill file */
	path: string;
	/** Skill content (markdown) */
	/** Lazily load the markdown body when the caller needs prompt content. */
	loadContent?: () => Promise<string>;
	content?: string;
	/** Parsed frontmatter */
	frontmatter?: SkillFrontmatter;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const skillCapability = defineCapability<Skill>({
	id: "skills",
	displayName: "Skills",
	description: "Specialized knowledge and workflow files that extend agent capabilities",
	key: skill => skill.name,
	toExtensionId: skill => `skill:${skill.name}`,
	validate: skill => {
		if (!skill.name) return "Missing skill name";
		if (!skill.path) return "Missing skill path";
		return undefined;
	},
});
