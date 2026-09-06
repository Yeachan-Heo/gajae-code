import type { CanonicalGjcWorkflowSkill } from "../../skill-state/active-state";
import { CANONICAL_GJC_WORKFLOW_SKILLS } from "../../skill-state/active-state";
import type { FunctionHookCapability } from "../extensions/function-hooks";

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
	/** Optional JSON Schema declaration for registry-v2 metadata. */
	schema?: unknown;
	/** Aliases accepted when migrating older manifests. */
	inputSchema?: unknown;
	input_schema?: unknown;
	parameters?: unknown;
	/** Optional sidecar JSON Schema file, resolved within the plugin root. */
	schemaPath?: string;
	schema_path?: string;
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
	/** Requested capability families; the runtime never grants more than declared. */
	capabilities?: FunctionHookCapability[];
	networkDestinations?: string[];
	filesystemRoots?: string[];
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

export interface NormalizedSubskillToolSurface {
	extensionId: string;
	relativePath: string;
	implementationHash: string;
}

export interface LoadedSubskillToolReference {
	extensionId: string;
	relativePath: string;
	expectedDigest: string;
}

export interface LoadedSubskillActivation {
	activationArg: string;
	plugin: string;
	subskillName: string;
	parent: string;
	bindsTo: string;
	phase: string;
	/** Registry identity for v2-only activation. */
	scope?: GjcPluginScope;
	extensionId?: string;
	expectedDigest?: string;
	filePath: string;
	toolPaths: string[];
	toolRefs?: LoadedSubskillToolReference[];
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
	| "invalid_schema"
	| "missing_surface"
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
	| "quarantined_surface"
	| "migration_required";

export class GjcPluginLoadError extends Error {
	readonly code: GjcPluginLoadErrorCode;

	constructor(code: GjcPluginLoadErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "GjcPluginLoadError";
		this.code = code;
	}
}

/** Typed refusal raised when an implementation changed after v2 metadata was recorded. */
export class PluginImplementationHashMismatchError extends GjcPluginLoadError {
	readonly expected: string;
	readonly actual: string;
	readonly path: string;

	constructor(path: string, expected: string, actual: string) {
		super("hash_mismatch", `GJC plugin implementation hash mismatch for ${path}`);
		this.name = "PluginImplementationHashMismatchError";
		this.path = path;
		this.expected = expected;
		this.actual = actual;
	}
}

/** Typed refusal for a registry entry that could not be migrated to v2 metadata. */
export class PluginMigrationRequiredError extends GjcPluginLoadError {
	constructor(plugin: string, surface: string, cause: string) {
		super("migration_required", `GJC plugin "${plugin}" surface "${surface}" requires migration: ${cause}`);
		this.name = "PluginMigrationRequiredError";
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
	toolRefs?: NormalizedSubskillToolSurface[];
}

export interface NormalizedToolSurface {
	extensionId: string;
	name: string;
	relativePath: string;
	sha256: string;
	description?: string;
	/** v2 metadata fields; optional only for in-memory legacy fixtures. */
	schema?: JsonSchema202012;
	schemaHash?: string;
	implementationHash?: string;
	presentationHash?: string;
	metadataVersion?: 2;
}

/** JSON Schema 2020-12 documents are kept as JSON values so migration never needs an implementation import. */
export type JsonSchema202012 = boolean | Record<string, unknown>;

/**
 * Registry-v2 tool metadata. The implementation and presentation hashes are
 * content digests, not executable metadata. `schema` is canonicalized before
 * `schemaHash` is computed.
 */
export interface NormalizedToolSurfaceV2 extends NormalizedToolSurface {
	schema: JsonSchema202012;
	schemaHash: string;
	implementationHash: string;
	presentationHash?: string;
	metadataVersion: 2;
}

export interface GjcPluginMigrationFailure {
	code: GjcPluginLoadErrorCode;
	surface: string;
	cause: string;
}

export interface GjcPluginMigrationState {
	status: "migrated" | "failed";
	metadataVersion: 2;
	migratedAt?: string;
	failure?: GjcPluginMigrationFailure;
}

export interface NormalizedHookSurface {
	extensionId: string;
	name: string;
	event: string;
	target?: string;
	phase?: "before" | "after";
	relativePath: string;
	sha256: string;
	implementationHash?: string;
	capabilities?: FunctionHookCapability[];
	networkDestinations?: string[];
	filesystemRoots?: string[];
	capabilityHash?: string;
	functionHook?: boolean;
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
	/** v2 metadata status; absent is accepted for in-memory legacy test fixtures. */
	migration?: GjcPluginMigrationState;
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

/** Canonical GJC bundle identity: kind is fixed, target is (scope, name). */
export const GJC_BUNDLE_KIND = "gjc-bundle";

export interface GjcBundleIdentity {
	kind: typeof GJC_BUNDLE_KIND;
	scope: GjcPluginScope;
	name: string;
}

/** Source descriptor exposed to CLI/Settings: never carries raw locator secrets. */
export interface GjcBundleSafeSource {
	kind: GjcPluginSourceKind;
	/** Redacted display locator (host + path only; no userinfo/query/fragment). */
	display: string;
	/** Conservative safe git ref, omitted when the stored value is unsafe. */
	ref?: string;
	/** Hex-only revision identifier, omitted when the stored value is unsafe. */
	sha?: string;
	resolvedAt: string;
	/** True when this source kind supports re-resolution during update. */
	updatable: boolean;
	/** Present only when updatable is false. */
	unsupportedReason?: string;
}

export interface GjcBundleSurfaceSummary {
	extensionId: string;
	kind: "tool" | "hook" | "mcp" | "system-appendix" | "agent-appendix" | "subskill";
	name: string;
	/** Persisted user intent (registry disabledSurfaceIds). */
	enabled: boolean;
	/** Deterministic quarantine derived from persisted registry state only. */
	quarantined: boolean;
	quarantineCode?: GjcPluginLoadErrorCode;
}

/** Installed-bundle DTO shared by CLI and Settings. Contains no raw locators. */
export interface GjcBundleSummary {
	identity: GjcBundleIdentity;
	version: string;
	description?: string;
	enabled: boolean;
	source: GjcBundleSafeSource;
	installedAt: string;
	updatedAt: string;
	manifestHash: string;
	/** Deterministic fingerprint of the exact installed target. */
	targetFingerprint: string;
	surfaces: GjcBundleSurfaceSummary[];
	/** True when any deterministic quarantine blocks enablement. */
	quarantined: boolean;
}

/**
 * Host-derived token binding an update preview to the exact candidate, the
 * exact installed baseline, and the deterministic decision context. Apply is a
 * compare-and-swap against all three fingerprints.
 */
export interface GjcReviewedUpdateToken {
	identity: GjcBundleIdentity;
	candidateFingerprint: string;
	baselineFingerprint: string;
	decisionContextFingerprint: string;
	reviewedAt: string;
}

export type GjcLifecycleErrorCode =
	| "already_installed_use_upgrade"
	| "not_installed"
	| "registry_unreadable"
	| "identity_mismatch"
	| "stale_candidate"
	| "stale_baseline"
	| "stale_decision_context"
	| "source_unsupported"
	| "source_unavailable"
	| "quarantined"
	| "surface_unknown"
	| "invalid_target";

export interface GjcLifecycleError {
	code: GjcLifecycleErrorCode;
	/** Sanitized operator-facing message; never contains raw locators or causes. */
	message: string;
	/** Safe scoped recovery hint (e.g. the exact command to run instead). */
	recovery?: string;
}

export type GjcLifecycleResult<T> = { ok: true; value: T } | { ok: false; error: GjcLifecycleError };

export interface GjcUpdatePreview {
	identity: GjcBundleIdentity;
	current: GjcBundleSummary;
	candidateVersion: string;
	candidateManifestHash: string;
	/** Surface IDs added, removed, or retained by this candidate. */
	addedSurfaceIds: string[];
	removedSurfaceIds: string[];
	retainedSurfaceIds: string[];
	changed: boolean;
	token: GjcReviewedUpdateToken;
}

export type GjcUpdateApplyStatus = "updated" | "unchanged";

export interface GjcUpdateApplyResult {
	status: GjcUpdateApplyStatus;
	summary: GjcBundleSummary;
	/** Number of filesystem remnants that could not be removed after a successful swap. */
	remnantCount: number;
}

export interface GjcInstallResult {
	status: "installed";
	summary: GjcBundleSummary;
}

/** A resolved uninstall that was deliberately not performed. */
export interface GjcUninstallPreview {
	status: "would-uninstall";
	identity: GjcBundleIdentity;
	summary: GjcBundleSummary;
}

export interface GjcToggleResult {
	summary: GjcBundleSummary;
	/** False when the requested state already matched (no persisted mutation). */
	mutated: boolean;
}

/**
 * Scope-qualified runtime evidence emitted by producers. Producers never
 * publish; the session coordinator accumulates one complete generation.
 */
export interface GjcRuntimeFinding {
	identity: GjcBundleIdentity;
	surfaceId: string;
	code: GjcPluginLoadErrorCode;
	message: string;
	decision?: "loaded" | "quarantined" | "blocked" | "error";
	event?: string;
	phase?: "before" | "after";
	requestedCapabilities?: readonly FunctionHookCapability[];
	effectiveCapabilities?: readonly FunctionHookCapability[];
	capabilityHash?: string;
	provenance?: {
		source: "builtin" | "user" | "project" | "extension" | "plugin-bundle";
		scope?: "user" | "project" | "native";
		plugin?: string;
		path?: string;
		extensionId?: string;
	};
	audit?: Record<string, unknown>;
	generation?: number;
}

export interface GjcRuntimeSnapshot {
	/** Monotonic activation generation this snapshot describes. */
	generation: number;
	findings: GjcRuntimeFinding[];
}

export type GjcRuntimeSnapshotState = { status: "unavailable" } | { status: "current"; snapshot: GjcRuntimeSnapshot };
