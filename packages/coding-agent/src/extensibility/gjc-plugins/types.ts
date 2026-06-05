import type { CanonicalGjcWorkflowSkill } from "../../skill-state/active-state";
import { CANONICAL_GJC_WORKFLOW_SKILLS } from "../../skill-state/active-state";

export const GJC_PLUGIN_MANIFEST_FILENAME = "gajae-plugin.json";
export const GJC_PLUGIN_KIND = "gajae-code-plugin";

export const GJC_SUBSKILL_PARENT_SKILLS = CANONICAL_GJC_WORKFLOW_SKILLS;
export type GjcSubskillParentSkill = CanonicalGjcWorkflowSkill;

export const GJC_SUBSKILL_PARENT_AGENTS = ["executor", "architect", "planner", "critic"] as const;
export type GjcSubskillParentAgent = (typeof GJC_SUBSKILL_PARENT_AGENTS)[number];

export type GjcSubskillParent = GjcSubskillParentSkill | GjcSubskillParentAgent;

export const GJC_AGENT_SUBSKILL_PHASES: Record<GjcSubskillParentAgent, string[]> = {
	executor: ["prompt"],
	architect: ["prompt"],
	planner: ["prompt"],
	critic: ["prompt"],
};

export interface GjcPluginManifest {
	name: string;
	version: string;
	kind: "gajae-code-plugin";
	subskills: string[];
	tools: string[];
}

export interface SubskillFrontmatter {
	name: string;
	binds_to: string;
	phase: string;
	activation_arg: string;
	description: string;
}

export interface LoadedSubskillBinding {
	plugin: string;
	subskillName: string;
	parent: string;
	bindsTo: string;
	phase: string;
	activationArg: string;
	description: string;
	filePath: string;
	body: string;
	toolPaths: string[];
}

export interface LoadedSubskillActivation {
	activationArg: string;
	plugin: string;
	subskillName: string;
	parent: string;
	bindsTo: string;
	phase: string;
	filePath: string;
	toolPaths: string[];
}

export interface PhaseScopedToolBinding {
	plugin: string;
	parent: string;
	phase: string;
	toolPath: string;
}

export interface LoadedGjcPlugin {
	name: string;
	version: string;
	root: string;
	manifestPath: string;
	bindings: LoadedSubskillBinding[];
	toolBindings: PhaseScopedToolBinding[];
}

export type GjcPluginLoadErrorCode =
	| "forbidden_surface"
	| "invalid_manifest"
	| "invalid_frontmatter"
	| "invalid_parent"
	| "invalid_phase"
	| "duplicate_arg"
	| "duplicate_parent_phase"
	| "missing_file"
	| "invalid_kind";

export class GjcPluginLoadError extends Error {
	readonly code: GjcPluginLoadErrorCode;

	constructor(code: GjcPluginLoadErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "GjcPluginLoadError";
		this.code = code;
	}
}
