/**
 * GJC Marketplace Plugin Provider
 *
 * Loads plugin roots from GJC plugin registries and explicit plugin-dir roots.
 */
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import { rootContainsGjcManifest } from "../extensibility/gjc-plugins";
import {
	type ClaudePluginRoot,
	createSourceMeta,
	listClaudePluginRoots,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "./helpers";

import { substitutePluginRoot } from "./substitute-plugin-root";

const PROVIDER_ID = "claude-plugins";
const DISPLAY_NAME = "GJC Marketplace";
const PRIORITY = 70;

interface ClaudePluginManifest {
	skills?: string;
	"slash-commands"?: string;
	commands?: string;
}

interface ResolvedPluginDir {
	dir: string;
	warning?: string;
}

async function readPluginManifest(root: ClaudePluginRoot): Promise<ClaudePluginManifest | null> {
	const manifestPath = path.join(root.path, ".claude-plugin", "plugin.json");
	const raw = await readFile(manifestPath);
	if (raw === null) return null;

	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as ClaudePluginManifest;
	} catch {
		return null;
	}
}

function isWithinPluginRoot(rootPath: string, targetPath: string): boolean {
	const relative = path.relative(rootPath, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolvePluginDir(
	root: ClaudePluginRoot,
	manifestKeys: ReadonlyArray<keyof ClaudePluginManifest>,
	fallback: string,
): Promise<ResolvedPluginDir> {
	const manifest = await readPluginManifest(root);
	const fallbackDir = path.join(root.path, fallback);

	let configured: string | undefined;
	let matchedKey: keyof ClaudePluginManifest | undefined;
	for (const key of manifestKeys) {
		const val = manifest?.[key];
		if (typeof val === "string" && val.trim()) {
			configured = val.trim();
			matchedKey = key;
			break;
		}
	}

	if (configured === undefined) {
		return { dir: fallbackDir };
	}

	const resolved = path.resolve(root.path, configured);
	if (isWithinPluginRoot(root.path, resolved)) {
		return { dir: resolved };
	}

	return {
		dir: fallbackDir,
		warning: `[claude-plugins] Ignoring ${String(matchedKey)} path outside plugin root for ${root.id}: ${configured}`,
	};
}

async function listNonGjcPluginRoots(
	home: string,
	cwd: string,
): Promise<{ roots: ClaudePluginRoot[]; warnings: string[] }> {
	const { roots, warnings } = await listClaudePluginRoots(home, cwd);
	const filteredRoots: ClaudePluginRoot[] = [];
	const filteredWarnings = [...warnings];

	for (const root of roots) {
		if (await rootContainsGjcManifest(root.path)) {
			filteredWarnings.push(`[claude-plugins] Skipping gajae-code plugin root (binding-only): ${root.path}`);
			continue;
		}
		filteredRoots.push(root);
	}

	return { roots: filteredRoots, warnings: filteredWarnings };
}

// =============================================================================
// Skills
// =============================================================================

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const items: Skill[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listNonGjcPluginRoots(ctx.home, ctx.cwd);
	warnings.push(...rootWarnings);

	const results = await Promise.all(
		roots.map(async root => {
			const { dir: skillsDir, warning } = await resolvePluginDir(root, ["skills"], "skills");
			const result = await scanSkillsFromDir(ctx, {
				dir: skillsDir,
				providerId: PROVIDER_ID,
				level: root.scope,
			});
			return { root, result, warning };
		}),
	);

	for (const { root, result, warning } of results) {
		if (warning) warnings.push(warning);
		for (const skill of result.items) {
			if (root.plugin) skill.name = `${root.plugin}:${skill.name}`;
			items.push(skill);
		}
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// Slash Commands
// =============================================================================

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const items: SlashCommand[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listNonGjcPluginRoots(ctx.home, ctx.cwd);
	warnings.push(...rootWarnings);

	const results = await Promise.all(
		roots.map(async root => {
			const { dir: commandsDir, warning } = await resolvePluginDir(root, ["commands", "slash-commands"], "commands");
			const result = await loadFilesFromDir<SlashCommand>(ctx, commandsDir, PROVIDER_ID, root.scope, {
				extensions: ["md"],
				transform: (name, content, filePath, source) => {
					const cmdName = name.replace(/\.md$/, "");
					return {
						name: root.plugin ? `${root.plugin}:${cmdName}` : cmdName,
						path: filePath,
						content,
						level: root.scope,
						_source: source,
					};
				},
			});
			return { result, warning };
		}),
	);

	for (const { result, warning } of results) {
		if (warning) warnings.push(warning);
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// Hooks
// =============================================================================

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const items: Hook[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listNonGjcPluginRoots(ctx.home, ctx.cwd);
	warnings.push(...rootWarnings);

	const hookTypes = ["pre", "post"] as const;

	const loadTasks: { root: ClaudePluginRoot; hookType: "pre" | "post" }[] = [];
	for (const root of roots) {
		for (const hookType of hookTypes) {
			loadTasks.push({ root, hookType });
		}
	}

	const results = await Promise.all(
		loadTasks.map(async ({ root, hookType }) => {
			const hooksDir = path.join(root.path, "hooks", hookType);
			return loadFilesFromDir<Hook>(ctx, hooksDir, PROVIDER_ID, root.scope, {
				transform: (name, _content, filePath, source) => {
					const toolName = name.replace(/\.(sh|bash|zsh|fish)$/, "");
					return {
						name,
						path: filePath,
						type: hookType,
						tool: toolName,
						level: root.scope,
						_source: source,
					};
				},
			});
		}),
	);

	for (const result of results) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// Custom Tools
// =============================================================================

async function loadTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const items: CustomTool[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listNonGjcPluginRoots(ctx.home, ctx.cwd);
	warnings.push(...rootWarnings);

	const results = await Promise.all(
		roots.map(async root => {
			const toolsDir = path.join(root.path, "tools");
			return loadFilesFromDir<CustomTool>(ctx, toolsDir, PROVIDER_ID, root.scope, {
				transform: (name, _content, filePath, source) => {
					const toolName = name.replace(/\.(ts|js|sh|bash|py)$/, "");
					return {
						name: toolName,
						path: filePath,
						description: `${toolName} custom tool`,
						level: root.scope,
						_source: source,
					};
				},
			});
		}),
	);

	for (const result of results) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// MCP Servers
// =============================================================================

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listNonGjcPluginRoots(ctx.home, ctx.cwd);
	warnings.push(...rootWarnings);

	for (const root of roots) {
		const mcpPath = path.join(root.path, ".mcp.json");
		const raw = await readFile(mcpPath);
		if (raw === null) continue; // file absent — skip silently

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			warnings.push(`[claude-plugins] Invalid JSON in ${mcpPath}`);
			logger.warn(`[claude-plugins] Invalid JSON in ${mcpPath}`);
			continue;
		}

		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const obj = parsed as Record<string, unknown>;

		// Two shapes are supported:
		//   nested: { "mcpServers": { name: cfg, ... } }   (GJC/Anthropic Code project shape)
		//   flat:   { name: cfg, ... }                      (Anthropic model marketplace plugin shape)
		// If "mcpServers" is present and an object, treat it as the canonical map.
		// Otherwise, treat the whole object as the server map.
		let servers: Record<string, unknown>;
		if (
			obj.mcpServers !== undefined &&
			obj.mcpServers !== null &&
			typeof obj.mcpServers === "object" &&
			!Array.isArray(obj.mcpServers)
		) {
			servers = obj.mcpServers as Record<string, unknown>;
		} else if (!("mcpServers" in obj)) {
			servers = obj;
		} else {
			continue;
		}

		for (const [serverName, serverCfg] of Object.entries(servers)) {
			if (!serverCfg || typeof serverCfg !== "object" || Array.isArray(serverCfg)) continue;
			const raw = serverCfg as {
				enabled?: boolean;
				timeout?: number;
				command?: string;
				args?: string[];
				env?: Record<string, string>;
				cwd?: string;
				url?: string;
				headers?: Record<string, string>;
				auth?: MCPServer["auth"];
				oauth?: MCPServer["oauth"];
				type?: string;
			};
			// Require either command (stdio) or url (HTTP/SSE) — Anthropic model marketplace plugins
			// occasionally ship .mcp.json entries with neither, which would register a useless
			// server and surface as a connection error at runtime.
			if (typeof raw.command !== "string" && typeof raw.url !== "string") {
				warnings.push(`[claude-plugins] Skipping MCP server "${serverName}" in ${mcpPath}: missing command or url`);
				continue;
			}
			const namespacedName = root.plugin ? `${root.plugin}:${serverName}` : serverName;
			const server: MCPServer = {
				name: namespacedName,
				...(raw.enabled !== undefined && { enabled: raw.enabled }),
				...(raw.timeout !== undefined && { timeout: raw.timeout }),
				...(raw.command !== undefined && { command: substitutePluginRoot(raw.command, root.path) }),
				...(raw.args !== undefined && { args: substitutePluginRoot(raw.args, root.path) }),
				...(raw.env !== undefined && { env: substitutePluginRoot(raw.env, root.path) }),
				...(raw.cwd !== undefined && { cwd: substitutePluginRoot(raw.cwd, root.path) }),
				...(raw.url !== undefined && { url: raw.url }),
				...(raw.headers !== undefined && { headers: raw.headers }),
				...(raw.auth !== undefined && { auth: raw.auth }),
				...(raw.oauth !== undefined && { oauth: raw.oauth }),
				...(raw.type !== undefined && { transport: raw.type as MCPServer["transport"] }),
				_source: createSourceMeta(PROVIDER_ID, mcpPath, root.scope),
			};
			items.push(server);
		}
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from GJC marketplace plugins",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load slash commands from GJC marketplace plugins",
	priority: PRIORITY,
	load: loadSlashCommands,
});

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load hooks from GJC marketplace plugins",
	priority: PRIORITY,
	load: loadHooks,
});

registerProvider<CustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load custom tools from GJC marketplace plugins",
	priority: PRIORITY,
	load: loadTools,
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from marketplace plugin .mcp.json files",
	priority: PRIORITY,
	load: loadMCPServers,
});
