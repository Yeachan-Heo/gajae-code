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

export interface GjcPluginToolManifestEntry {
	name: string;
	path: string;
	description?: string;
	sha256?: string;
	/**
	 * "always-on" object entries are activated for the whole session; legacy
	 * string shorthand stays "subskill"-scoped and is only attached to subskill
	 * bindings (never registered as an always-on tool surface).
	 */
	surface: "subskill" | "always-on";
}

export interface GjcPluginHookManifestEntry {
	name: string;
	event: string;
	target?: string;
	phase?: "before" | "after";
	path: string;
	sha256?: string;
}

export type GjcPluginMcpTransport = "stdio" | "http" | "sse";

export interface GjcPluginMcpManifestEntry {
	name: string;
	transport: GjcPluginMcpTransport;
	command?: string;
	args?: string[];
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	sha256?: string;
}

export interface GjcPluginAppendixManifestEntry {
	name: string;
	path?: string;
	content?: string;
	sha256?: string;
}

export interface GjcPluginAgentAppendixManifestEntry extends GjcPluginAppendixManifestEntry {
	agent: GjcSubskillParentAgent;
}

export interface GjcPluginManifest {
	name: string;
	version: string;
	kind: "gajae-code-plugin";
	subskills: string[];
	tools: GjcPluginToolManifestEntry[];
	hooks: GjcPluginHookManifestEntry[];
	mcps: GjcPluginMcpManifestEntry[];
	systemAppendix: GjcPluginAppendixManifestEntry[];
	agentAppendix: GjcPluginAgentAppendixManifestEntry[];
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
	// Parse-time
	| "forbidden_surface"
	| "invalid_manifest"
	| "invalid_kind"
	| "unsupported_surface"
	// Compile-time
	| "invalid_frontmatter"
	| "invalid_parent"
	| "invalid_phase"
	| "missing_file"
	| "hash_mismatch"
	| "invalid_appendix"
	| "invalid_hook"
	| "invalid_mcp"
	// Install-time
	| "duplicate_arg"
	| "duplicate_parent_phase"
	| "duplicate_tool"
	| "duplicate_hook"
	| "duplicate_mcp"
	| "duplicate_appendix"
	| "security_policy"
	| "install_conflict"
	// Session-start / runtime
	| "session_collision"
	| "runtime_mismatch"
	| "quarantined_surface";

export class GjcPluginLoadError extends Error {
	readonly code: GjcPluginLoadErrorCode;

	constructor(code: GjcPluginLoadErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "GjcPluginLoadError";
		this.code = code;
	}
}

export type GjcPluginScope = "user" | "project";

export type GjcPluginSourceKind = "path" | "git" | "tarball";

export interface GjcPluginCopiedFile {
	relativePath: string;
	sha256: string;
	bytes: number;
}

export interface NormalizedSubskillSurface {
	extensionId: string;
	name: string;
	description: string;
	parent: string;
	phase: string;
	activationArg: string;
	relativePath: string;
	sha256: string;
}

export interface NormalizedToolSurface {
	extensionId: string;
	name: string;
	relativePath: string;
	sha256: string;
	description?: string;
}

export interface NormalizedHookSurface {
	extensionId: string;
	name: string;
	event: string;
	target?: string;
	phase?: "before" | "after";
	relativePath: string;
	sha256: string;
}

export interface NormalizedMcpSurface {
	extensionId: string;
	name: string;
	transport: GjcPluginMcpTransport;
	configHash: string;
	config: GjcPluginMcpManifestEntry;
}

export interface NormalizedAppendixSurface {
	extensionId: string;
	name: string;
	relativePath?: string;
	/** Inline appendix body (when the manifest used `content` instead of `path`). */
	content?: string;
	contentHash: string;
	bytes: number;
}

export interface NormalizedAgentAppendixSurface extends NormalizedAppendixSurface {
	agent: GjcSubskillParentAgent;
}

export interface NormalizedGjcPluginSurfaces {
	subskills: NormalizedSubskillSurface[];
	tools: NormalizedToolSurface[];
	hooks: NormalizedHookSurface[];
	mcps: NormalizedMcpSurface[];
	systemAppendices: NormalizedAppendixSurface[];
	agentAppendices: NormalizedAgentAppendixSurface[];
}

/**
 * Result of the pure compile step. Computed from manifest, frontmatter, and
 * declared files read as bytes only — never by importing plugin code.
 */
export interface NormalizedGjcPluginBundle {
	name: string;
	version: string;
	root: string;
	manifestPath: string;
	manifestHash: string;
	surfaces: NormalizedGjcPluginSurfaces;
	files: GjcPluginCopiedFile[];
}

export interface GjcPluginQuarantineEntry {
	surfaceId: string;
	code: GjcPluginLoadErrorCode;
	message: string;
	detectedAt: string;
}

export interface GjcPluginRegistrySource {
	kind: GjcPluginSourceKind;
	uri: string;
	ref?: string;
	sha?: string;
	resolvedAt: string;
}

export interface GjcPluginRegistryEntry {
	name: string;
	version: string;
	scope: GjcPluginScope;
	enabled: boolean;
	pluginRoot: string;
	manifestPath: string;
	manifestHash: string;
	source: GjcPluginRegistrySource;
	installedAt: string;
	updatedAt: string;
	copiedFiles: GjcPluginCopiedFile[];
	surfaces: NormalizedGjcPluginSurfaces;
	disabledSurfaceIds: string[];
	quarantine?: GjcPluginQuarantineEntry[];
}

export interface GjcPluginRegistry {
	version: 1;
	scope: GjcPluginScope;
	plugins: GjcPluginRegistryEntry[];
}

/**
 * Stable identifiers for plugin-contributed surfaces used by observability,
 * disabledSurfaceIds, and quarantine bookkeeping.
 */
export type GjcPluginSurfaceExtensionId = string;
