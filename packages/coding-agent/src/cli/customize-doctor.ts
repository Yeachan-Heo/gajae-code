/**
 * `gjc customize doctor` — provenance-aware customization inspection.
 *
 * Answers, for one project: what did GJC discover, which source convention won,
 * what is disabled/shadowed/rejected/quarantined, and why is a tool, skill,
 * hook, extension, command, MCP server, or plugin bundle absent.
 *
 * The command is read-only and reuses the canonical discovery registry
 * (`loadCapability`) and the exact session-startup consumers (`loadSkills`,
 * `loadSlashCommands`, `loadAllMCPConfigs`, plugin-bundle registry). It never
 * re-implements discovery, never executes hooks, never connects MCP servers,
 * and never prints credentials, endpoint tokens, auth headers, env values, or
 * raw config dumps.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getMCPConfigPath,
	getPluginsLockfile,
	getPluginsNodeModules,
	getPluginsPackageJson,
	getProjectDir,
} from "@gajae-code/utils";
import { type ExtensionModule, extensionModuleCapability } from "../capability/extension-module";
import { findRepoRoot } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { Capability, LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { Settings, type Settings as SettingsInstance } from "../config/settings";
import { resolveSkillScopeTrust } from "../config/skill-settings-defaults";
import { getEmbeddedDefaultGjcSkills } from "../defaults/gjc-defaults";
import { initializeWithSettings, loadCapability } from "../discovery";
import { inspectClaudeConvention } from "../discovery/claude";
import { inspectCodexConvention } from "../discovery/codex";
import { scanSkillsFromDir } from "../discovery/helpers";
import { summarizeGjcPluginObservability } from "../extensibility/gjc-plugins/observability";
import { loadEffectiveGjcPluginRegistry } from "../extensibility/gjc-plugins/registry";
import { getEnabledPlugins } from "../extensibility/plugins/loader";
import { loadSkills } from "../extensibility/skills";
import { loadSlashCommands } from "../extensibility/slash-commands";
import { loadAllMCPConfigs } from "../runtime-mcp/config";
import { readDisabledServers } from "../runtime-mcp/config-writer";
import { canonicalizeMCPEndpoint } from "../runtime-mcp/pool-key";
import { redactMCPEndpoint } from "../runtime-mcp/redaction";
import { CANONICAL_GJC_WORKFLOW_SKILLS } from "../skill-state/canonical-skills";
import { expandTilde } from "../tools/path-utils";

// =============================================================================
// Public types (stable JSON contract)
// =============================================================================

export type CustomizeSurfaceKind = "mcp" | "skill" | "hook" | "tool" | "extension" | "command" | "plugin-bundle";

/**
 * Provenance class of a discovered item — the reusable read model for the
 * `/extensions` surface (#4291) and CI/setup tooling.
 *
 * - `canonical`: project/global `.gjc` entries and GJC bundled defaults — the
 *   primary load path and the persisted authority for sessions.
 * - `convention`: items from registered non-native conventions that are part of
 *   the discovery load path (claude-plugins, claude/codex hooks, agents,
 *   cursor, gemini, opencode, windsurf, cline, github, mcp-json, ssh).
 * - `import-candidate`: Claude Code / Codex project (+ global) files on
 *   surfaces GJC deliberately never loads. Reported for provenance only; never
 *   active runtime authority. Candidates for a future import flow (#4291).
 * - `imported`: items carrying explicit import provenance (reserved; no import
 *   command exists yet, so nothing emits this today).
 * - `plugin`: plugin bundles (npm plugin packages + GJC plugin bundles).
 */
export type CustomizeSourceClass = "canonical" | "convention" | "import-candidate" | "imported" | "plugin";

export type CustomizeItemStatus =
	| "loaded"
	| "disabled"
	| "shadowed"
	| "rejected"
	| "quarantined"
	| "stored-only"
	| "ignored";

/**
 * Bounded, documented reason codes. One reason per item; distinct examples
 * (malformed, disabled, shadowed, quarantined, policy-blocked) are always
 * distinguishable by `reason` alone.
 */
export type CustomizeReasonCode =
	| "loaded"
	| "managed"
	| "storage-only"
	| "disabled-extension"
	| "disabled-provider"
	| "disabled-server"
	| "disabled-bundle"
	| "shadowed-by-precedence"
	| "invalid-config"
	| "load-error"
	| "quarantined"
	| "policy-blocked"
	| "source-ignored";

export interface CustomizePrecedenceEntry {
	provider: string;
	displayName: string;
	priority: number;
	enabled: boolean;
}

export interface McpSafeSummary {
	transport?: "stdio" | "http" | "sse";
	/** Executable path for stdio servers (safe: no credential values). */
	command?: string;
	/** Arguments with secret-looking values replaced by "<redacted>". */
	args?: string[];
	/** Endpoint with userinfo/path/query redacted via redactMCPEndpoint. */
	url?: string;
	/** Environment variable names only — values are never emitted. */
	envKeys?: string[];
	hasHeaders: boolean;
	hasAuth: boolean;
	hasOauth: boolean;
	enabled?: boolean;
	autoload?: boolean;
	/** True when session startup would include this server in its connect set. */
	connectable: boolean;
}

export interface CustomizeDoctorItem {
	name: string;
	kind: CustomizeSurfaceKind;
	/** Provenance class (see CustomizeSourceClass). */
	sourceClass: CustomizeSourceClass;
	convention: string;
	provider: string;
	providerName: string;
	scope: "user" | "project" | "native";
	path: string;
	status: CustomizeItemStatus;
	reason: CustomizeReasonCode;
	detail: string;
	remediation: string[];
	trust: string;
	restartRequired: boolean;
	precedence: {
		priority: number;
		shadowedBy?: { provider: string; scope: string };
	};
	/** Present only for MCP servers. */
	mcp?: McpSafeSummary;
	/** Present only for quarantined plugin-bundle surfaces. */
	quarantineCode?: string;
}

export interface CustomizeDoctorSurface {
	kind: CustomizeSurfaceKind;
	displayName: string;
	description: string;
	precedence: CustomizePrecedenceEntry[];
	items: CustomizeDoctorItem[];
	/** Skill-surface policy notes (why discovery is off or scoped). */
	skillScopeNotes?: string[];
	/** Surface-level warnings (for example a failed startup projection). */
	warnings?: string[];
}

export interface CustomizeDoctorReport {
	schemaVersion: 1;
	command: "customize doctor";
	cwd: string;
	generatedAt: string;
	policy: {
		skillsEnabled: boolean;
		skillScopeNotes: string[];
		disabledProviders: string[];
		mcpNote: string;
		/** Conventions present on disk but deliberately not in the load path. */
		conventionsNotLoaded: string[];
		/** User-home convention directories present (global import candidates). */
		globalImportCandidateDirs: string[];
		/** Stable descriptor table for the sourceClass taxonomy (CI contract). */
		sourceClasses: Array<{ sourceClass: CustomizeSourceClass; description: string }>;
	};
	surfaces: CustomizeDoctorSurface[];
	summary: Record<string, number>;
	warnings: string[];
}

export interface CustomizeDoctorCommandOptions {
	json: boolean;
	cwd?: string;
}

// =============================================================================
// Constants
// =============================================================================

const REDACTED = "<redacted>";

const BUILT_IN_SKILL_NAMES = new Set<string>(CANONICAL_GJC_WORKFLOW_SKILLS);

const SENSITIVE_KEY_PATTERN =
	/(?:token|secret|key|credential|password|passwd|pwd|authorization|auth|bearer|cookie|session|apikey)/i;

const SURFACE_ORDER: CustomizeSurfaceKind[] = ["mcp", "skill", "hook", "tool", "extension", "command", "plugin-bundle"];

const SURFACE_DISPLAY: Record<CustomizeSurfaceKind, string> = {
	mcp: "MCP Servers",
	skill: "Skills",
	hook: "Hooks",
	tool: "Custom Tools",
	extension: "Extension Modules",
	command: "Slash Commands",
	"plugin-bundle": "Plugin Bundles",
};

const SURFACE_DESCRIPTION: Record<CustomizeSurfaceKind, string> = {
	mcp: "Model Context Protocol server configurations discovered from GJC and other registered conventions",
	skill: "Skill definitions discovered from GJC and other registered conventions",
	hook: "Hook files discovered from GJC and other registered conventions",
	tool: "Custom tool modules discovered from GJC and other registered conventions",
	extension: "Extension modules discovered from GJC and other registered conventions",
	command: "Slash command templates discovered from GJC and other registered conventions",
	"plugin-bundle": "Installed GJC plugin bundles and npm plugin packages",
};

/**
 * Stable descriptor table for the sourceClass taxonomy. Serves as the read
 * model contract for `/extensions` (#4291): consumers can rely on the class
 * names and descriptions without parsing item internals.
 */
const SOURCE_CLASS_DESCRIPTIONS: Array<{ sourceClass: CustomizeSourceClass; description: string }> = [
	{
		sourceClass: "canonical",
		description:
			"Project/global .gjc entries and GJC bundled defaults — the primary, authoritative load path for sessions.",
	},
	{
		sourceClass: "convention",
		description:
			"Items from other registered conventions (claude-plugins, claude/codex hooks, agents, cursor, gemini, opencode, windsurf, cline, github, mcp-json, ssh) that are part of the discovery load path.",
	},
	{
		sourceClass: "import-candidate",
		description:
			"Claude Code / Codex project (and global) files on surfaces GJC deliberately never loads. Reported for provenance as import candidates; never active runtime authority.",
	},
	{
		sourceClass: "imported",
		description:
			"Items carrying explicit import provenance from another host. Reserved: no import command exists today, so nothing emits this class yet.",
	},
	{
		sourceClass: "plugin",
		description: "Plugin bundles (npm plugin packages and GJC plugin bundles) contributed by the plugin runtime.",
	},
];

const TRUST_BY_KIND: Record<CustomizeSurfaceKind, string> = {
	mcp: "MCP servers run arbitrary local commands and may reach the network and filesystem. Only connect servers you trust.",
	skill: "Skills are markdown prompts; they do not execute code by themselves.",
	hook: "Hook files execute arbitrary code when a session runs them.",
	tool: "Custom tool modules execute arbitrary code.",
	extension: "Extension modules execute arbitrary code.",
	command: "Slash commands expand to prompt text; they do not execute code.",
	"plugin-bundle":
		"Plugin bundles execute code and may add tools, hooks, MCP servers, and appendices. Only install bundles you trust.",
};

/** Whether a restart/new session is required for changes to take effect. */
function restartRequiredFor(kind: CustomizeSurfaceKind): boolean {
	// MCP servers are connectable on demand inside a running session
	// (`/mcp connect`); every other surface is fixed at session startup.
	return kind !== "mcp";
}

function sourceClassFor(provider: string): CustomizeSourceClass {
	switch (provider) {
		case "native":
		case "bundled":
			return "canonical";
		case "plugin":
		case "gjc-bundle":
			return "plugin";
		// "claude"/"codex" items arriving through the registry (hooks) are load-path
		// participants, so they classify as "convention"; the import-candidate class
		// is only assigned by the direct foreign-convention inspection below.
		default:
			return "convention";
	}
}

function conventionForProvider(provider: string): string {
	switch (provider) {
		case "native":
		case "bundled":
			return "gjc";
		case "claude":
			return "claude-project";
		case "claude-plugins":
			return "claude-plugin";
		case "codex":
			return "codex-project";
		case "cursor":
			return "cursor-project";
		case "gemini":
			return "gemini-project";
		case "opencode":
			return "opencode-project";
		case "windsurf":
			return "windsurf-project";
		case "cline":
			return "cline-project";
		case "agents":
			return "agents-md";
		case "mcp-json":
			return "mcp-json";
		case "github":
			return "github";
		case "ssh":
			return "ssh-config";
		case "plugin":
			return "plugin";
		case "custom":
			return "explicit-config";
		default:
			return provider;
	}
}

function scopeOf(meta: SourceMeta): "user" | "project" | "native" {
	return meta.level;
}

// =============================================================================
// Discovery helper (canonical `loadCapability` projection, no re-implementation)
// =============================================================================

interface DiscoveredEntry<T> {
	item: T;
	name: string;
	path: string;
	provider: string;
	providerName: string;
	scope: "user" | "project" | "native";
	priority: number;
	shadowed: boolean;
	shadowedBy?: { provider: string; scope: string };
	invalidReason?: string;
	/** Canonical dashboard id (`capability.toExtensionId`), when defined. */
	extensionId?: string;
}

interface DiscoveredSet<T> {
	entries: DiscoveredEntry<T>[];
	precedence: CustomizePrecedenceEntry[];
}

async function discoverCapability<T extends { _source: SourceMeta }>(
	capability: Capability<T>,
	cwd: string,
	activeSettings: SettingsInstance,
	options: {
		nameOf: (item: T) => string;
		pathOf: (item: T) => string;
		extensionIdOf?: (item: T) => string | undefined;
	},
): Promise<DiscoveredSet<T>> {
	const disabledProviders = new Set(activeSettings.get("disabledProviders"));
	const result = await loadCapability<T>(capability.id, {
		cwd,
		agentDir: activeSettings.getAgentDir(),
		settings: activeSettings,
		includeDisabled: true,
		includeInvalid: true,
		includeDisabledProviders: true,
	});

	// First item per dedup key wins (highest priority provider first in `all`).
	const winners = new Map<string, { provider: string; scope: "user" | "project" | "native" }>();
	const entries: DiscoveredEntry<T>[] = [];
	for (const item of result.all) {
		const key = capability.key(item);
		const scope = scopeOf(item._source);
		let shadowed = (item as { _shadowed?: boolean })._shadowed === true;
		let shadowedBy: { provider: string; scope: string } | undefined;
		if (key !== undefined) {
			const winner = winners.get(key);
			if (winner) {
				shadowed = true;
				shadowedBy = winner;
			} else if (!disabledProviders.has(item._source.provider)) {
				// Only enabled providers can own a dedup key; a disabled
				// higher-priority provider must never shadow an enabled
				// lower-priority source (includeDisabledProviders reports it
				// as a listed item without giving it effective precedence).
				winners.set(key, { provider: item._source.provider, scope });
			}
		}
		entries.push({
			item,
			name: options.nameOf(item),
			path: options.pathOf(item),
			provider: item._source.provider,
			providerName: item._source.providerName,
			scope,
			priority: capability.providers.find(p => p.id === item._source.provider)?.priority ?? 0,
			shadowed,
			shadowedBy,
			invalidReason: capability.validate?.(item),
			extensionId: options.extensionIdOf?.(item),
		});
	}

	entries.sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider));

	const precedence: CustomizePrecedenceEntry[] = capability.providers.map(p => ({
		provider: p.id,
		displayName: p.displayName,
		priority: p.priority,
		enabled: !disabledProviders.has(p.id),
	}));

	return { entries, precedence };
}

function disabledExtensionIds(activeSettings: SettingsInstance): Set<string> {
	return new Set(activeSettings.get("disabledExtensions"));
}

// =============================================================================
// MCP safe summary / redaction
// =============================================================================

function redactArgs(args: string[] | undefined): string[] | undefined {
	if (!args || args.length === 0) return undefined;
	const redacted: string[] = [];
	let redactNext = false;
	for (const arg of args) {
		if (redactNext) {
			redacted.push(REDACTED);
			redactNext = false;
			continue;
		}
		const equalsIndex = arg.indexOf("=");
		if (equalsIndex > 0) {
			const key = arg.slice(0, equalsIndex);
			redacted.push(SENSITIVE_KEY_PATTERN.test(key) ? `${key}=${REDACTED}` : arg);
			continue;
		}
		if (arg.startsWith("-") && SENSITIVE_KEY_PATTERN.test(arg)) {
			redacted.push(arg);
			redactNext = true;
			continue;
		}
		redacted.push(SENSITIVE_KEY_PATTERN.test(arg) ? REDACTED : arg);
	}
	return redacted;
}

function safeMcpSummary(server: MCPServer, connectable: boolean): McpSafeSummary {
	const envKeys = server.env ? Object.keys(server.env).sort() : undefined;
	return {
		transport: server.transport ?? (server.command ? "stdio" : server.url ? "http" : undefined),
		command: server.command,
		args: redactArgs(server.args),
		// The canonical redactor runs values through the URL API, which
		// percent-encodes the "<redacted>" placeholder; decode it for display.
		url: redactMCPEndpoint(server.url)?.replaceAll("%3Credacted%3E", REDACTED),
		envKeys,
		hasHeaders: server.headers !== undefined && Object.keys(server.headers).length > 0,
		hasAuth: server.auth !== undefined,
		hasOauth: server.oauth !== undefined,
		enabled: server.enabled,
		autoload: server.autoload,
		connectable,
	};
}

// =============================================================================
// Item builders
// =============================================================================

function baseItem<T extends { _source: SourceMeta }>(
	kind: CustomizeSurfaceKind,
	entry: DiscoveredEntry<T>,
): Omit<CustomizeDoctorItem, "status" | "reason" | "detail" | "remediation"> {
	return {
		name: entry.name,
		kind,
		sourceClass: sourceClassFor(entry.provider),
		convention: conventionForProvider(entry.provider),
		provider: entry.provider,
		providerName: entry.providerName,
		scope: entry.scope,
		path: entry.path,
		trust: TRUST_BY_KIND[kind],
		restartRequired: restartRequiredFor(kind),
		precedence: {
			priority: entry.priority,
			shadowedBy: entry.shadowedBy,
		},
	};
}

function finalizeItem(
	base: Omit<CustomizeDoctorItem, "status" | "reason" | "detail" | "remediation">,
	status: CustomizeItemStatus,
	reason: CustomizeReasonCode,
	detail: string,
	remediation: string[],
	extra?: Partial<CustomizeDoctorItem>,
): CustomizeDoctorItem {
	return { ...base, status, reason, detail, remediation, ...extra };
}

// =============================================================================
// Surface collectors
// =============================================================================

async function collectMcps(cwd: string, activeSettings: SettingsInstance): Promise<CustomizeDoctorSurface> {
	const { entries, precedence } = await discoverCapability(mcpCapability, cwd, activeSettings, {
		nameOf: server => server.name,
		pathOf: server => server._source.path,
		extensionIdOf: server => mcpCapability.toExtensionId?.(server),
	});
	const disabledServers = new Set(await readDisabledServers(getMCPConfigPath("user", cwd)));
	const disabledExts = disabledExtensionIds(activeSettings);
	const disabledProviders = new Set(activeSettings.get("disabledProviders"));
	// The startup projection: `loadAllMCPConfigs` is what a session uses when
	// connecting MCP servers (`/mcp connect` or `--mcp-config`). A single
	// policy-violating endpoint (for example userinfo in a URL) fails the whole
	// projection closed at startup, so catch it and report instead of losing
	// the surface.
	let connectableNames = new Set<string>();
	const surfaceWarnings: string[] = [];
	try {
		connectableNames = new Set(
			Object.keys(
				(await loadAllMCPConfigs(cwd, { settings: activeSettings, agentDir: activeSettings.getAgentDir() }))
					.configs,
			),
		);
	} catch (error) {
		surfaceWarnings.push(
			`Startup MCP projection failed closed: ${error instanceof Error ? error.message : String(error)}. Sessions cannot connect any discovered server until this is fixed.`,
		);
	}

	const items: CustomizeDoctorItem[] = entries.map(entry => {
		const server = entry.item as MCPServer;
		const base = baseItem("mcp", entry);
		if (entry.invalidReason) {
			return finalizeItem(
				base,
				"rejected",
				"invalid-config",
				`Invalid MCP server definition: ${entry.invalidReason}.`,
				[`Fix ${entry.path}`],
			);
		}
		if (entry.extensionId !== undefined && disabledExts.has(entry.extensionId)) {
			return finalizeItem(
				base,
				"disabled",
				"disabled-extension",
				`MCP server "${entry.name}" is disabled via the disabledExtensions setting.`,
				["gjc config set disabledExtensions '[]'", "or re-enable it in the extension dashboard"],
			);
		}
		if (disabledProviders.has(entry.provider)) {
			return finalizeItem(
				base,
				"disabled",
				"disabled-provider",
				`Provider "${entry.providerName}" is disabled via the disabledProviders setting, so startup ignores this config source.`,
				["gjc config set disabledProviders '[]'"],
			);
		}
		if (entry.shadowed && entry.shadowedBy) {
			return finalizeItem(
				base,
				"shadowed",
				"shadowed-by-precedence",
				`"${entry.name}" from ${entry.providerName} (priority ${entry.priority}) loses to the same name from ${entry.shadowedBy.provider} (higher priority).`,
				[
					`Disable the winning source to let this one load: gjc config set disabledProviders '["${entry.shadowedBy.provider}"]'`,
					`or rename "${entry.name}" in ${entry.path}`,
				],
			);
		}
		// Startup endpoint policy: conversion canonicalizes http/sse endpoints
		// before the enabled filter, so a violating endpoint (userinfo, relative
		// URL) rejects the server even when it is disabled. Reuse the canonical
		// validator rather than duplicating the policy.
		if (server.url !== undefined) {
			try {
				canonicalizeMCPEndpoint(server.url);
			} catch (error) {
				return finalizeItem(
					base,
					"rejected",
					"policy-blocked",
					`MCP endpoint rejected by startup policy: ${error instanceof Error ? error.message : String(error)}.`,
					[`Fix the endpoint in ${entry.path} (no userinfo; absolute http(s) URL)`],
					{ mcp: safeMcpSummary(server, false) },
				);
			}
		}
		if (server.enabled === false || disabledServers.has(entry.name)) {
			return finalizeItem(
				base,
				"disabled",
				"disabled-server",
				`MCP server "${entry.name}" is disabled (enabled: false or listed in disabledServers).`,
				[`Set enabled: true or remove "${entry.name}" from disabledServers in ${entry.path}`],
			);
		}
		const connectable = connectableNames.has(entry.name);
		return finalizeItem(
			base,
			"stored-only",
			"storage-only",
			"Discovered but never auto-connected by standalone sessions. Connect it explicitly when you need it.",
			["Run /mcp connect inside a session", `gjc --mcp-config ${entry.path} to load one exact config file`],
			{ mcp: safeMcpSummary(server, connectable) },
		);
	});

	return {
		kind: "mcp",
		displayName: SURFACE_DISPLAY.mcp,
		description: SURFACE_DESCRIPTION.mcp,
		precedence,
		items,
		warnings: surfaceWarnings.length > 0 ? surfaceWarnings : undefined,
	};
}

async function collectSkills(cwd: string, activeSettings: SettingsInstance): Promise<CustomizeDoctorSurface> {
	const { entries, precedence } = await discoverCapability(skillCapability, cwd, activeSettings, {
		nameOf: skill => skill.name,
		pathOf: skill => skill.path,
		extensionIdOf: skill => skillCapability.toExtensionId?.(skill),
	});
	const skillsEnabled = activeSettings.get("skills.enabled") === true;
	const disabledExts = disabledExtensionIds(activeSettings);
	const disabledProviders = new Set(activeSettings.get("disabledProviders"));
	const ignoredPatterns = activeSettings.get("skills.ignoredSkills") ?? [];
	const includePatterns = activeSettings.get("skills.includeSkills") ?? [];

	// Exact session-startup consumer (sdk/session.ts): loadSkills only runs when
	// skills.enabled is true, and only GJC (native) skills survive its filters.
	const loadedNames = new Set<string>();
	if (skillsEnabled) {
		const result = await loadSkills({
			...activeSettings.getGroup("skills"),
			cwd,
			disabledExtensions: activeSettings.get("disabledExtensions"),
		});
		for (const skill of result.skills) loadedNames.add(skill.name);
	}

	const skillScopeNotes: string[] = [];
	if (!skillsEnabled) {
		skillScopeNotes.push(
			"skills.enabled is false: sessions load only the four bundled workflow skills. Enable discovery with `gjc config set skills.enabled true`.",
		);
	}
	if (skillsEnabled && !resolveSkillScopeTrust(activeSettings.getGroup("skills"), "project")) {
		skillScopeNotes.push(
			"Project skills are not trusted (skills.trustProjectSkills is false, or legacy skills.enablePiProject is false): project .gjc/skills are not loaded even with skills.enabled true.",
		);
	}
	if (skillsEnabled && !resolveSkillScopeTrust(activeSettings.getGroup("skills"), "user")) {
		skillScopeNotes.push(
			"User skills are not trusted (skills.trustUserSkills is false, or legacy skills.enablePiUser is false): user-level skills are not loaded even with skills.enabled true.",
		);
	}

	const items: CustomizeDoctorItem[] = entries.map(entry => {
		const base = baseItem("skill", entry);
		if (entry.invalidReason) {
			return finalizeItem(base, "rejected", "invalid-config", `Invalid skill: ${entry.invalidReason}.`, [
				`Fix ${entry.path}`,
			]);
		}
		if (!skillsEnabled) {
			return finalizeItem(
				base,
				"disabled",
				"policy-blocked",
				"Skill discovery is disabled (skills.enabled is false), so this skill is not loaded by sessions.",
				["gjc config set skills.enabled true"],
			);
		}
		if (entry.extensionId !== undefined && disabledExts.has(entry.extensionId)) {
			return finalizeItem(
				base,
				"disabled",
				"disabled-extension",
				`Skill "${entry.name}" is disabled via the disabledExtensions setting.`,
				["gjc config set disabledExtensions '[]'", "or re-enable it in the extension dashboard"],
			);
		}
		if (disabledProviders.has(entry.provider)) {
			return finalizeItem(
				base,
				"disabled",
				"disabled-provider",
				`Provider "${entry.providerName}" is disabled via the disabledProviders setting, so startup ignores this config source.`,
				["gjc config set disabledProviders '[]'"],
			);
		}
		if (entry.shadowed && entry.shadowedBy) {
			return finalizeItem(
				base,
				"shadowed",
				"shadowed-by-precedence",
				`"${entry.name}" from ${entry.providerName} (priority ${entry.priority}) loses to the same name from ${entry.shadowedBy.provider} (higher priority).`,
				[
					`Disable the winning source to let this one load: gjc config set disabledProviders '["${entry.shadowedBy.provider}"]'`,
					`or rename "${entry.name}" in ${entry.path}`,
				],
			);
		}
		if (entry.provider !== "native") {
			return finalizeItem(
				base,
				"ignored",
				"source-ignored",
				"GJC loads skills only from .gjc (native) locations. Skills discovered from other agent conventions are deliberately not loaded at session startup.",
				[`Move the skill under .gjc/skills/<name>/SKILL.md to make it loadable`],
			);
		}
		if (BUILT_IN_SKILL_NAMES.has(entry.name)) {
			return finalizeItem(
				base,
				"shadowed",
				"shadowed-by-precedence",
				`"${entry.name}" is a bundled GJC workflow skill; the bundled definition takes precedence in sessions and this discovered copy is never used (sdk/session.ts withEmbeddedDefaultGjcSkills).`,
				[`Rename ${entry.path} to make it loadable`],
				{ precedence: { priority: entry.priority, shadowedBy: { provider: "bundled", scope: "native" } } },
			);
		}
		if (loadedNames.has(entry.name)) {
			return finalizeItem(base, "loaded", "loaded", "Loaded by session startup.", []);
		}
		if (ignoredPatterns.length > 0 || includePatterns.length > 0) {
			return finalizeItem(
				base,
				"disabled",
				"policy-blocked",
				"Discovered but not present in the session skill list; check skills.ignoredSkills and skills.includeSkills patterns.",
				["gjc config reset skills.ignoredSkills", "gjc config reset skills.includeSkills"],
			);
		}
		return finalizeItem(
			base,
			"stored-only",
			"policy-blocked",
			"Discovered but not present in the session skill list (name collision, untrusted scope, or include/ignore pattern).",
			["Check skills.ignoredSkills, skills.includeSkills, skills.trustUserSkills, and skills.trustProjectSkills"],
		);
	});

	// Explicit-config skills (skills.customDirectories). Session startup scans
	// these outside the capability registry via loadSkills (providerId "custom");
	// mirror that scan with the same helper and options so the report cannot
	// drift from startup.
	const customDirs = activeSettings.get("skills.customDirectories") ?? [];
	for (const dir of [...customDirs].sort()) {
		const scan = await scanSkillsFromDir(
			{ cwd, home: os.homedir(), repoRoot: null },
			{ dir: expandTilde(dir), providerId: "custom", level: "user", requireDescription: true },
		);
		for (const skill of scan.items) {
			const base: Omit<CustomizeDoctorItem, "status" | "reason" | "detail" | "remediation"> = {
				name: skill.name,
				kind: "skill",
				sourceClass: "canonical",
				convention: "explicit-config",
				provider: "custom",
				providerName: "Custom",
				scope: "user",
				path: skill.path,
				trust: TRUST_BY_KIND.skill,
				restartRequired: restartRequiredFor("skill"),
				precedence: { priority: 0 },
			};
			if (!skillsEnabled) {
				items.push(
					finalizeItem(
						base,
						"disabled",
						"policy-blocked",
						"Skill discovery is disabled (skills.enabled is false), so this skill is not loaded by sessions.",
						["gjc config set skills.enabled true"],
					),
				);
				continue;
			}
			if (disabledExts.has(`skill:${skill.name}`)) {
				items.push(
					finalizeItem(
						base,
						"disabled",
						"disabled-extension",
						`Skill "${skill.name}" is disabled via the disabledExtensions setting.`,
						["gjc config set disabledExtensions '[]'", "or re-enable it in the extension dashboard"],
					),
				);
				continue;
			}
			if (BUILT_IN_SKILL_NAMES.has(skill.name)) {
				items.push(
					finalizeItem(
						base,
						"shadowed",
						"shadowed-by-precedence",
						`"${skill.name}" is a bundled GJC workflow skill; the bundled definition takes precedence in sessions and this custom-directory copy is never used (sdk/session.ts withEmbeddedDefaultGjcSkills).`,
						[`Rename ${skill.path} to make it loadable`],
						{ precedence: { priority: 0, shadowedBy: { provider: "bundled", scope: "native" } } },
					),
				);
				continue;
			}
			// Check for an already-loaded effective winner (native/convention
			// skill of the same name) BEFORE the loadedNames shortcut: when
			// loadSkills also scans customDirectories, a custom copy can appear
			// in loadedNames even though it loses the name collision to an
			// earlier-priority source. The collision must report shadowed-by-
			// precedence, not a second "loaded" item.
			const collisionWinner = items.find(i => i.name === skill.name && i.status === "loaded");
			if (collisionWinner) {
				items.push(
					finalizeItem(
						base,
						"shadowed",
						"shadowed-by-precedence",
						`Custom-directory skill "${skill.name}" loses the name collision to the already-loaded ${collisionWinner.convention}/${collisionWinner.scope} skill of the same name.`,
						[`Rename ${skill.path} to make it loadable`],
						{
							precedence: {
								priority: 0,
								shadowedBy: { provider: collisionWinner.provider, scope: collisionWinner.scope },
							},
						},
					),
				);
				continue;
			}
			if (loadedNames.has(skill.name)) {
				items.push(
					finalizeItem(base, "loaded", "loaded", "Loaded by session startup from skills.customDirectories.", []),
				);
				continue;
			}
			items.push(
				finalizeItem(
					base,
					"stored-only",
					"policy-blocked",
					"Discovered in skills.customDirectories but not present in the session skill list (include/ignore pattern or a name collision with another custom directory).",
					["Check skills.ignoredSkills and skills.includeSkills"],
				),
			);
		}
	}

	// Bundled GJC workflow skills are a product invariant: sessions always
	// include them, and the bundled definition always wins over any discovered
	// same-name filesystem skill (sdk/session.ts withEmbeddedDefaultGjcSkills,
	// extensibility/skills.ts collision warning). Discovered same-name copies
	// are marked shadowed by the bundled entry above.
	for (const embedded of getEmbeddedDefaultGjcSkills()) {
		const base: Omit<CustomizeDoctorItem, "status" | "reason" | "detail" | "remediation"> = {
			name: embedded.name,
			kind: "skill",
			sourceClass: "canonical",
			convention: "gjc",
			provider: "bundled",
			providerName: "GJC Bundled",
			scope: "native",
			path: embedded.filePath,
			trust: TRUST_BY_KIND.skill,
			restartRequired: restartRequiredFor("skill"),
			precedence: { priority: 0 },
		};
		items.push(
			finalizeItem(
				base,
				"loaded",
				"loaded",
				"Bundled GJC workflow skill — always available to sessions (product invariant), even when skills.enabled is false, and always takes precedence over any discovered same-name filesystem skill.",
				[],
			),
		);
	}

	return {
		kind: "skill",
		displayName: SURFACE_DISPLAY.skill,
		description: SURFACE_DESCRIPTION.skill,
		precedence,
		items,
		skillScopeNotes,
	};
}

async function collectHooks(cwd: string, activeSettings: SettingsInstance): Promise<CustomizeDoctorSurface> {
	return collectNotExecutedAtStartup("hook", hookCapability, cwd, activeSettings, {
		nameOf: hook => hook.name,
		pathOf: hook => hook.path,
		notExecutedDetail:
			"Discovered and shown in the extension dashboard, but standalone sessions do not execute hook files. Runtime hooks come from validated GJC plugin bundles.",
		notExecutedRemediation: ["See `gjc plugin list` for plugin bundles that contribute runtime hooks"],
	});
}

async function collectTools(cwd: string, activeSettings: SettingsInstance): Promise<CustomizeDoctorSurface> {
	return collectNotExecutedAtStartup("tool", toolCapability, cwd, activeSettings, {
		nameOf: tool => tool.name,
		pathOf: tool => tool.path,
		notExecutedDetail:
			"Discovered and shown in the extension dashboard, but standalone sessions do not execute custom tool modules. Runtime custom tools come from validated GJC plugin bundles and MCP servers.",
		notExecutedRemediation: ["See `gjc plugin list` for plugin bundles that contribute runtime tools"],
	});
}

async function collectExtensions(cwd: string, activeSettings: SettingsInstance): Promise<CustomizeDoctorSurface> {
	return collectNotExecutedAtStartup("extension", extensionModuleCapability, cwd, activeSettings, {
		nameOf: ext => ext.name,
		pathOf: ext => ext.path,
		notExecutedDetail:
			"Discovered and shown in the extension dashboard, but session startup does not load filesystem extension modules. Runtime extensions come from validated GJC plugin bundles.",
		notExecutedRemediation: ["See `gjc plugin list` for plugin bundles that contribute extensions"],
	});
}

interface NotExecutedOptions<T extends { _source: SourceMeta }> {
	nameOf: (item: T) => string;
	pathOf: (item: T) => string;
	notExecutedDetail: string;
	notExecutedRemediation: string[];
}

async function collectNotExecutedAtStartup<T extends { _source: SourceMeta }>(
	kind: "hook" | "tool" | "extension",
	capability: Capability<T>,
	cwd: string,
	activeSettings: SettingsInstance,
	options: NotExecutedOptions<T>,
): Promise<CustomizeDoctorSurface> {
	const { entries, precedence } = await discoverCapability(capability, cwd, activeSettings, {
		nameOf: options.nameOf,
		pathOf: options.pathOf,
		extensionIdOf: item => capability.toExtensionId?.(item),
	});
	const disabledExts = disabledExtensionIds(activeSettings);
	const disabledProviders = new Set(activeSettings.get("disabledProviders"));

	const items: CustomizeDoctorItem[] = entries.map(entry => {
		const base = baseItem(kind, entry);
		if (entry.invalidReason) {
			return finalizeItem(
				base,
				"rejected",
				"invalid-config",
				`Invalid ${kind} definition: ${entry.invalidReason}.`,
				[`Fix ${entry.path}`],
			);
		}
		if (entry.extensionId !== undefined && disabledExts.has(entry.extensionId)) {
			return finalizeItem(
				base,
				"disabled",
				"disabled-extension",
				`"${entry.name}" is disabled via the disabledExtensions setting (${entry.extensionId}).`,
				["gjc config set disabledExtensions '[]'", "or re-enable it in the extension dashboard"],
			);
		}
		if (disabledProviders.has(entry.provider)) {
			return finalizeItem(
				base,
				"disabled",
				"disabled-provider",
				`Provider "${entry.providerName}" is disabled via the disabledProviders setting, so startup ignores this config source.`,
				["gjc config set disabledProviders '[]'"],
			);
		}
		if (entry.shadowed && entry.shadowedBy) {
			return finalizeItem(
				base,
				"shadowed",
				"shadowed-by-precedence",
				`"${entry.name}" from ${entry.providerName} (priority ${entry.priority}) loses to the same name from ${entry.shadowedBy.provider} (higher priority).`,
				[
					`Disable the winning source to let this one load: gjc config set disabledProviders '["${entry.shadowedBy.provider}"]'`,
					`or rename "${entry.name}" in ${entry.path}`,
				],
			);
		}
		return finalizeItem(base, "stored-only", "managed", options.notExecutedDetail, options.notExecutedRemediation);
	});

	return { kind, displayName: SURFACE_DISPLAY[kind], description: SURFACE_DESCRIPTION[kind], precedence, items };
}

async function collectCommands(cwd: string, activeSettings: SettingsInstance): Promise<CustomizeDoctorSurface> {
	const { entries, precedence } = await discoverCapability(slashCommandCapability, cwd, activeSettings, {
		nameOf: cmd => cmd.name,
		pathOf: cmd => cmd.path,
		extensionIdOf: cmd => slashCommandCapability.toExtensionId?.(cmd),
	});
	const disabledExts = disabledExtensionIds(activeSettings);
	const disabledProviders = new Set(activeSettings.get("disabledProviders"));
	// Exact session-startup consumer (interactive/print modes).
	const loadedNames = new Set(
		(await loadSlashCommands({ cwd, agentDir: activeSettings.getAgentDir() })).map(cmd => cmd.name),
	);

	const items: CustomizeDoctorItem[] = entries.map(entry => {
		const base = baseItem("command", entry);
		if (entry.invalidReason) {
			return finalizeItem(base, "rejected", "invalid-config", `Invalid slash command: ${entry.invalidReason}.`, [
				`Fix ${entry.path}`,
			]);
		}
		if (entry.extensionId !== undefined && disabledExts.has(entry.extensionId)) {
			return finalizeItem(
				base,
				"disabled",
				"disabled-extension",
				`Slash command "${entry.name}" is disabled via the disabledExtensions setting.`,
				["gjc config set disabledExtensions '[]'", "or re-enable it in the extension dashboard"],
			);
		}
		if (disabledProviders.has(entry.provider)) {
			return finalizeItem(
				base,
				"disabled",
				"disabled-provider",
				`Provider "${entry.providerName}" is disabled via the disabledProviders setting, so startup ignores this config source.`,
				["gjc config set disabledProviders '[]'"],
			);
		}
		if (entry.shadowed && entry.shadowedBy) {
			return finalizeItem(
				base,
				"shadowed",
				"shadowed-by-precedence",
				`"${entry.name}" from ${entry.providerName} (priority ${entry.priority}) loses to the same name from ${entry.shadowedBy.provider} (higher priority).`,
				[
					`Disable the winning source to let this one load: gjc config set disabledProviders '["${entry.shadowedBy.provider}"]'`,
					`or rename "${entry.name}" in ${entry.path}`,
				],
			);
		}
		if (loadedNames.has(entry.name)) {
			return finalizeItem(base, "loaded", "loaded", "Loaded at session startup as a slash command.", []);
		}
		return finalizeItem(
			base,
			"stored-only",
			"managed",
			"Discovered but not present in the session slash-command list.",
			["Check disabledExtensions and provider enablement"],
		);
	});

	return {
		kind: "command",
		displayName: SURFACE_DISPLAY.command,
		description: SURFACE_DESCRIPTION.command,
		precedence,
		items,
	};
}

async function collectPluginBundles(cwd: string, agentDir: string): Promise<CustomizeDoctorSurface> {
	// npm plugin packages (convention "plugin") — the startup consumer is
	// getEnabledPlugins(cwd); the lockfile provides the disabled set.
	const enabledNames = new Set((await getEnabledPlugins(cwd)).map(p => p.name));
	const lockNames = new Map<string, { enabled?: boolean }>();
	const pkgPath = getPluginsPackageJson();
	let depNames: string[] = [];
	try {
		const pkg = (await Bun.file(pkgPath).json()) as { dependencies?: Record<string, string> };
		depNames = Object.keys(pkg.dependencies ?? {}).sort();
	} catch {
		// No plugin package.json — no npm plugins installed.
	}
	try {
		const lock = (await Bun.file(getPluginsLockfile()).json()) as { plugins?: Record<string, { enabled?: boolean }> };
		for (const [name, state] of Object.entries(lock.plugins ?? {})) lockNames.set(name, state);
	} catch {
		// No lockfile — no disabled npm plugins to report.
	}

	const npmItems: CustomizeDoctorItem[] = [];
	for (const name of depNames) {
		const enabled = enabledNames.has(name);
		const disabledByConfig = lockNames.get(name)?.enabled === false || !enabled;
		const base: Omit<CustomizeDoctorItem, "status" | "reason" | "detail" | "remediation"> = {
			name,
			kind: "plugin-bundle",
			sourceClass: "plugin",
			convention: "plugin",
			provider: "plugin",
			providerName: "Plugin",
			scope: "user",
			path: path.join(getPluginsNodeModules(), name),
			trust: TRUST_BY_KIND["plugin-bundle"],
			restartRequired: true,
			precedence: { priority: 0 },
		};
		if (enabled) {
			npmItems.push(
				finalizeItem(
					base,
					"loaded",
					"loaded",
					"Enabled npm plugin package; its tools/hooks/commands/extensions load at session startup.",
					[],
				),
			);
		} else if (disabledByConfig) {
			npmItems.push(
				finalizeItem(
					base,
					"disabled",
					"disabled-bundle",
					"Installed npm plugin package that is disabled in plugin runtime config or project overrides.",
					["gjc plugin enable <name>", "or remove it from plugin-overrides.json disabled list"],
				),
			);
		}
	}

	// GJC plugin bundles (convention "gjc-bundle") — canonical registry +
	// observability; never raw locators or config values.
	// Read-only: migrate:false keeps the doctor from persisting registry
	// migrations/legacy discovery (startup activation owns those writes).
	const bundleEntries = await loadEffectiveGjcPluginRegistry(cwd, { migrate: false, agentDir });
	const observability = await summarizeGjcPluginObservability(cwd, { migrate: false, agentDir });
	const items: CustomizeDoctorItem[] = [...npmItems];
	for (const entry of bundleEntries) {
		const base: Omit<CustomizeDoctorItem, "status" | "reason" | "detail" | "remediation"> = {
			name: entry.name,
			kind: "plugin-bundle",
			sourceClass: "plugin",
			convention: "gjc-bundle",
			provider: "gjc-bundle",
			providerName: "GJC Bundle",
			scope: entry.scope,
			path: entry.pluginRoot,
			trust: TRUST_BY_KIND["plugin-bundle"],
			restartRequired: true,
			precedence: { priority: 0 },
		};
		if (!entry.enabled) {
			items.push(
				finalizeItem(
					base,
					"disabled",
					"disabled-bundle",
					`GJC plugin bundle "${entry.name}" is disabled in the plugin registry.`,
					[`gjc plugin enable ${entry.name} --${entry.scope}`],
				),
			);
			continue;
		}
		const surfaces = observability.surfaces.filter(s => s.plugin === entry.name && s.scope === entry.scope);
		const quarantined = surfaces.filter(s => s.status === "quarantined");
		if (quarantined.length > 0) {
			const codes = Array.from(new Set(quarantined.map(s => s.quarantineCode ?? "unknown"))).join(", ");
			items.push(
				finalizeItem(
					base,
					"quarantined",
					"quarantined",
					`${quarantined.length} surface(s) of bundle "${entry.name}" are quarantined (${codes}); quarantined surfaces are not activated.`,
					[
						`Reinstall the bundle: gjc plugin uninstall ${entry.name} --${entry.scope} && gjc plugin install <source> --${entry.scope}`,
						"Quarantine is triggered by file-hash drift or session collisions; verify the installed files",
					],
					{ quarantineCode: quarantined[0]?.quarantineCode },
				),
			);
			continue;
		}
		const disabledSurfaceIds = entry.disabledSurfaceIds;
		const surfaceDetail =
			disabledSurfaceIds.length > 0
				? ` ${disabledSurfaceIds.length} surface(s) disabled: ${disabledSurfaceIds.join(", ")}.`
				: "";
		items.push(
			finalizeItem(
				base,
				"loaded",
				"loaded",
				`Enabled GJC plugin bundle with ${surfaces.length} surface(s).${surfaceDetail}`,
				disabledSurfaceIds.length > 0 ? ["gjc plugin enable <name> --surface <id> to re-enable a surface"] : [],
			),
		);
	}

	items.sort((a, b) => a.name.localeCompare(b.name));
	return {
		kind: "plugin-bundle",
		displayName: SURFACE_DISPLAY["plugin-bundle"],
		description: SURFACE_DESCRIPTION["plugin-bundle"],
		precedence: [],
		items,
	};
}

// =============================================================================
// Foreign conventions (Claude project / Codex project)
//
// Claude Code / Codex project hooks are discovered by the registered
// claude-hooks/codex-hooks providers (see discovery/index.ts) and appear in the
// Hooks surface above; sessions surface them in the extension dashboard but do
// not execute hook files. Every OTHER `.claude`/`.codex` surface (MCP, skills,
// tools, extensions, commands, prompts, settings) is deliberately not part of
// the load path: the doctor reports those files by invoking the canonical
// provider load functions directly (without registering the providers) and
// marks every such item as `ignored`.
// =============================================================================

interface ForeignConventionDescriptor {
	convention: string;
	provider: string;
	providerName: string;
	dirName: string;
	inspect(ctx: LoadContext): Promise<{
		mcps: LoadResult<MCPServer>;
		skills: LoadResult<Skill>;
		hooks: LoadResult<Hook>;
		tools: LoadResult<CustomTool>;
		extensions: LoadResult<ExtensionModule>;
		commands: LoadResult<SlashCommand>;
	}>;
}

const FOREIGN_CONVENTIONS: ForeignConventionDescriptor[] = [
	{
		convention: "claude-project",
		provider: "claude",
		providerName: "Claude Code",
		dirName: ".claude",
		inspect: inspectClaudeConvention,
	},
	{
		convention: "codex-project",
		provider: "codex",
		providerName: "OpenAI Codex",
		dirName: ".codex",
		inspect: inspectCodexConvention,
	},
];

interface ForeignConventionCollection {
	/** Foreign items appended to the matching surface kind. */
	itemsByKind: Map<CustomizeSurfaceKind, CustomizeDoctorItem[]>;
	/** Policy note about conventions that are not part of the load path. */
	policyNote: string;
}

function foreignMcpItem(
	desc: ForeignConventionDescriptor,
	server: MCPServer,
	shadowedBy: { provider: string; scope: string } | undefined,
): CustomizeDoctorItem {
	const base: Omit<CustomizeDoctorItem, "status" | "reason" | "detail" | "remediation"> = {
		name: server.name,
		kind: "mcp",
		sourceClass: "import-candidate",
		convention: desc.convention,
		provider: desc.provider,
		providerName: desc.providerName,
		scope: "project",
		path: server._source.path,
		trust: TRUST_BY_KIND.mcp,
		restartRequired: false,
		precedence: { priority: 0, shadowedBy },
	};
	return {
		...base,
		status: "ignored",
		reason: "source-ignored",
		detail: `${desc.providerName} project convention (${desc.dirName}/) is not part of the GJC load path; sessions never discover this MCP server.`,
		remediation: [
			`Move the server definition to .gjc/mcp.json to make it discoverable`,
			"or connect it explicitly via /mcp connect with an exact config file",
		],
		mcp: safeMcpSummary(server, false),
	};
}

function foreignItem(
	kind: CustomizeSurfaceKind,
	desc: ForeignConventionDescriptor,
	name: string,
	filePath: string,
	shadowedBy: { provider: string; scope: string } | undefined,
): CustomizeDoctorItem {
	return {
		name,
		kind,
		sourceClass: "import-candidate",
		convention: desc.convention,
		provider: desc.provider,
		providerName: desc.providerName,
		scope: "project",
		path: filePath,
		status: "ignored",
		reason: "source-ignored",
		detail: `${desc.providerName} project convention (${desc.dirName}/) is not part of the GJC load path; sessions never discover this file.`,
		remediation: [`Move it to the equivalent .gjc location`, "or install it via a plugin (see `gjc plugin list`)"],
		trust: TRUST_BY_KIND[kind],
		restartRequired: restartRequiredFor(kind),
		precedence: { priority: 0, shadowedBy },
	};
}

async function collectForeignConventions(cwd: string): Promise<ForeignConventionCollection> {
	const ctx: LoadContext = { cwd, home: os.homedir(), repoRoot: await findRepoRoot(cwd) };
	const itemsByKind: Map<CustomizeSurfaceKind, CustomizeDoctorItem[]> = new Map();
	const policyNote = `${FOREIGN_CONVENTIONS.map(d => d.dirName).join(" and ")} project hooks are discovered by GJC (see the Hooks surface); all other ${FOREIGN_CONVENTIONS.map(d => d.providerName).join(" / ")} project config surfaces (MCP servers, skills, tools, extensions, commands, prompts, settings) are not part of the GJC load path. Those files are reported below as import candidates for provenance but are never discovered by sessions.`;

	for (const desc of FOREIGN_CONVENTIONS) {
		const inspection = await desc.inspect(ctx);
		for (const server of inspection.mcps.items) {
			pushForeign(itemsByKind, "mcp", foreignMcpItem(desc, server, undefined));
		}
		for (const skill of inspection.skills.items) {
			pushForeign(itemsByKind, "skill", foreignItem("skill", desc, skill.name, skill.path, undefined));
		}
		// Hooks are intentionally skipped here: the registered claude-hooks and
		// codex-hooks providers already surface .claude/.codex hooks in the Hooks
		// surface, so reporting them again as ignored import candidates would
		// double-count and contradict the load path.
		for (const tool of inspection.tools.items) {
			pushForeign(itemsByKind, "tool", foreignItem("tool", desc, tool.name, tool.path, undefined));
		}
		for (const ext of inspection.extensions.items) {
			pushForeign(itemsByKind, "extension", foreignItem("extension", desc, ext.name, ext.path, undefined));
		}
		for (const cmd of inspection.commands.items) {
			pushForeign(itemsByKind, "command", foreignItem("command", desc, cmd.name, cmd.path, undefined));
		}
	}
	return { itemsByKind, policyNote };
}

function pushForeign(
	itemsByKind: Map<CustomizeSurfaceKind, CustomizeDoctorItem[]>,
	kind: CustomizeSurfaceKind,
	item: CustomizeDoctorItem,
): void {
	const items = itemsByKind.get(kind) ?? [];
	items.push(item);
	itemsByKind.set(kind, items);
}

/**
 * Attach provenance details to foreign items: when a registered source already
 * provides the same name, report it as the effective winner.
 */
function annotateForeignShadowing(
	foreign: ForeignConventionCollection,
	registeredByKind: Map<CustomizeSurfaceKind, CustomizeDoctorItem[]>,
): void {
	for (const [kind, foreignItems] of foreign.itemsByKind) {
		const registered = registeredByKind.get(kind) ?? [];
		for (const item of foreignItems) {
			const winner = registered.find(r => r.name === item.name);
			if (winner) {
				item.precedence.shadowedBy = { provider: winner.provider, scope: winner.scope };
				item.detail += ` A ${winner.convention}/${winner.scope} item with the same name is the effective one (${winner.providerName}).`;
			}
		}
	}
}

// =============================================================================
// Orchestration
// =============================================================================

/**
 * Build the full doctor report for a project directory.
 *
 * @param cwd Project directory; defaults to getProjectDir().
 * @param activeSettings Session-equivalent settings; when omitted,
 *   Settings.loadReadonly is called for the given cwd (CLI path). The
 *   read-only load never opens the DB, runs migrations, or writes files.
 *   Tests pass an in-memory instance.
 */
export async function runCustomizeDoctor(
	cwd?: string,
	activeSettings?: SettingsInstance,
): Promise<CustomizeDoctorReport> {
	const projectDir = cwd ?? getProjectDir();
	const settings = activeSettings ?? (await Settings.loadReadonly({ cwd: projectDir }));
	// Mirror session startup: the capability system and the downstream startup
	// consumers (loadAllMCPConfigs, loadSlashCommands) resolve provider policy
	// from the initialized session settings, so the doctor must initialize with
	// the same settings even when a caller supplied them.
	initializeWithSettings(settings);

	const warnings: string[] = [];
	const surfaces: CustomizeDoctorSurface[] = [];

	async function collect(kind: CustomizeSurfaceKind, fn: () => Promise<CustomizeDoctorSurface>): Promise<void> {
		try {
			surfaces.push(await fn());
		} catch (error) {
			warnings.push(`[${kind}] Failed to inspect: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	await collect("mcp", () => collectMcps(projectDir, settings));
	await collect("skill", () => collectSkills(projectDir, settings));
	await collect("hook", () => collectHooks(projectDir, settings));
	await collect("tool", () => collectTools(projectDir, settings));
	await collect("extension", () => collectExtensions(projectDir, settings));
	await collect("command", () => collectCommands(projectDir, settings));
	await collect("plugin-bundle", () => collectPluginBundles(projectDir, settings.getAgentDir()));

	// Foreign conventions (Claude Code / Codex project dirs) are never part of
	// the load path; report them as import candidates for provenance.
	let foreignPolicyNote = "";
	try {
		const foreign = await collectForeignConventions(projectDir);
		foreignPolicyNote = foreign.policyNote;
		const byKind = new Map<CustomizeSurfaceKind, CustomizeDoctorItem[]>();
		for (const surface of surfaces) byKind.set(surface.kind, surface.items);
		annotateForeignShadowing(foreign, byKind);
		for (const [kind, items] of foreign.itemsByKind) {
			const surface = surfaces.find(s => s.kind === kind);
			if (surface) {
				surface.items.push(...items);
			} else {
				warnings.push(`[${kind}] foreign convention items found but the surface failed to inspect`);
			}
		}
	} catch (error) {
		warnings.push(
			`[foreign-conventions] Failed to inspect: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Deterministic surface order; deterministic item order inside each surface.
	surfaces.sort((a, b) => SURFACE_ORDER.indexOf(a.kind) - SURFACE_ORDER.indexOf(b.kind));
	for (const surface of surfaces)
		surface.items.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

	const summary: Record<string, number> = {};
	for (const surface of surfaces) {
		for (const item of surface.items) {
			summary[item.status] = (summary[item.status] ?? 0) + 1;
		}
	}

	const skillScopeNotes = surfaces.find(s => s.kind === "skill")?.skillScopeNotes ?? [];
	const globalImportCandidateDirs = await findGlobalImportCandidateDirs();

	return {
		schemaVersion: 1,
		command: "customize doctor",
		cwd: projectDir,
		generatedAt: new Date().toISOString(),
		policy: {
			skillsEnabled: settings.get("skills.enabled") === true,
			skillScopeNotes,
			disabledProviders: settings.get("disabledProviders"),
			mcpNote:
				"Standalone sessions never auto-connect MCP servers. Discovered servers are connectable on demand via /mcp connect, or with gjc --mcp-config <path>.",
			conventionsNotLoaded: foreignPolicyNote ? [foreignPolicyNote] : [],
			globalImportCandidateDirs,
			sourceClasses: SOURCE_CLASS_DESCRIPTIONS,
		},
		surfaces,
		summary,
		warnings,
	};
}

/**
 * User-home convention directories that exist (global import candidates).
 * GJC never loads these; they are reported so the read model can distinguish
 * project and global Claude/Codex candidate locations.
 */
async function findGlobalImportCandidateDirs(): Promise<string[]> {
	const home = os.homedir();
	const candidates: string[] = [];
	for (const dirName of [".claude", ".codex"]) {
		const dirPath = path.join(home, dirName);
		try {
			const stat = await fs.stat(dirPath);
			if (stat.isDirectory()) candidates.push(dirPath);
		} catch {
			// Missing or unreadable — not a candidate.
		}
	}
	return candidates.sort();
}

// =============================================================================
// Output rendering
// =============================================================================

function formatShadowedBy(item: CustomizeDoctorItem): string {
	if (!item.precedence.shadowedBy) return "";
	const { provider, scope } = item.precedence.shadowedBy;
	return ` (shadowed by ${provider}/${scope})`;
}

function formatMcpSummary(item: CustomizeDoctorItem): string {
	const mcp = item.mcp;
	if (!mcp) return "";
	const parts: string[] = [`transport: ${mcp.transport ?? "unknown"}`];
	if (mcp.command) parts.push(`command: ${mcp.command}`);
	if (mcp.args && mcp.args.length > 0) parts.push(`args: ${mcp.args.join(" ")}`);
	if (mcp.url) parts.push(`url: ${mcp.url}`);
	if (mcp.envKeys && mcp.envKeys.length > 0) parts.push(`env: ${mcp.envKeys.join(",")}`);
	if (mcp.hasHeaders) parts.push("headers: present (values redacted)");
	if (mcp.hasAuth) parts.push("auth: present (values redacted)");
	if (mcp.hasOauth) parts.push("oauth: present (values redacted)");
	if (mcp.connectable) parts.push("connectable: yes");
	return `\n      ${parts.join("\n      ")}`;
}

export function renderCustomizeDoctorText(report: CustomizeDoctorReport): string {
	const lines: string[] = [];
	lines.push(`${report.command} — provenance and status for discovered customizations`);
	lines.push(`cwd: ${report.cwd}`);
	lines.push("");

	const policyHints: string[] = [];
	for (const note of report.policy.skillScopeNotes) policyHints.push(note);
	if (report.policy.disabledProviders.length > 0) {
		policyHints.push(
			`Disabled providers: ${report.policy.disabledProviders.join(", ")} — their config sources are ignored at startup. Fix: gjc config set disabledProviders '[]'`,
		);
	}
	for (const note of report.policy.conventionsNotLoaded) policyHints.push(note);
	if (report.policy.globalImportCandidateDirs.length > 0) {
		policyHints.push(
			`Global import candidate dirs present in home: ${report.policy.globalImportCandidateDirs.join(", ")} — never loaded by GJC sessions.`,
		);
	}
	policyHints.push(report.policy.mcpNote);
	if (policyHints.length > 0) {
		lines.push("Policy");
		for (const hint of policyHints) lines.push(`  - ${hint}`);
		lines.push("");
	}

	for (const surface of report.surfaces) {
		lines.push(`${surface.displayName} (${surface.kind}) — ${surface.items.length} discovered`);
		for (const warning of surface.warnings ?? []) lines.push(`  warning: ${warning}`);
		for (const p of surface.precedence) {
			lines.push(
				`  precedence: ${p.displayName} (${p.provider}) priority ${p.priority} ${p.enabled ? "enabled" : "disabled"}`,
			);
		}
		if (surface.items.length === 0) {
			lines.push("  (none discovered)");
			lines.push("");
			continue;
		}
		for (const item of surface.items) {
			lines.push(
				`  ${item.name}  [${item.status}]  ${item.convention}/${item.scope}  (${item.sourceClass})${formatShadowedBy(item)}`,
			);
			lines.push(`    reason: ${item.reason} — ${item.detail}`);
			lines.push(`    source: ${item.path}`);
			if (item.quarantineCode) lines.push(`    quarantine code: ${item.quarantineCode}`);
			for (const fix of item.remediation) lines.push(`    fix: ${fix}`);
			lines.push(`    trust: ${item.trust}`);
			lines.push(`    restart required: ${item.restartRequired ? "yes (new session)" : "no"}`);
			if (item.mcp) lines.push(formatMcpSummary(item));
		}
		lines.push("");
	}

	const summaryLine = Object.entries(report.summary)
		.map(([status, count]) => `${status}: ${count}`)
		.join(", ");
	lines.push(`Summary — ${summaryLine || "nothing discovered"}`);
	if (report.warnings.length > 0) {
		lines.push("");
		lines.push("Warnings");
		for (const warning of report.warnings) lines.push(`  - ${warning}`);
	}
	return `${lines.join("\n")}\n`;
}

export function renderCustomizeDoctorJson(report: CustomizeDoctorReport): string {
	return `${JSON.stringify(report, null, 2)}\n`;
}

/** CLI entry: run the doctor and write text or JSON to stdout. */
export async function runCustomizeDoctorCommand(options: CustomizeDoctorCommandOptions): Promise<void> {
	const report = await runCustomizeDoctor(options.cwd);
	process.stdout.write(options.json ? renderCustomizeDoctorJson(report) : renderCustomizeDoctorText(report));
}
