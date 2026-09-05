/**
 * Builtin Provider (.gjc)
 *
 * Primary provider for GJC native configs. Supports all capabilities.
 */
import * as path from "node:path";
import { logger, parseFrontmatter, tryParseJson } from "@gajae-code/utils";
import { YAML } from "bun";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type Extension, type ExtensionManifest, extensionCapability } from "../capability/extension";
import { type ExtensionModule, extensionModuleCapability } from "../capability/extension-module";
import { isSingleLinkRegularFileAt, type ReadScope, readDirEntries, readFile } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type Instruction, instructionCapability } from "../capability/instruction";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Prompt, promptCapability } from "../capability/prompt";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Settings, settingsCapability } from "../capability/settings";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type SystemPrompt, systemPromptCapability } from "../capability/system-prompt";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import { expandTilde } from "../tools/path-utils";
import {
	buildRuleFromMarkdown,
	canonicalizePathWithinHome,
	createSourceMeta,
	discoverExtensionModulePaths,
	expandEnvVarsDeep,
	getExtensionNameFromPath,
	getReadOptions,
	loadFilesFromDir,
	SOURCE_PATHS,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "native";
const DISPLAY_NAME = "GJC";
const DESCRIPTION = "Native GJC configuration from ~/.gjc and .gjc/";
const PRIORITY = 100;

const PATHS = SOURCE_PATHS.native;

/**
 * Absolute user-scope directories for native loaders. An explicit
 * `ctx.userAgentDir` — `loadCapability` always sets one, and
 * `loadCapabilityForHome` derives it from the supplied home or honors
 * `options.agentDir` — redirects every native user-scope read, so an explicit
 * agent directory is honored uniformly instead of only by the MCP loader.
 * Without one (ad-hoc scanning contexts), the historical
 * `<home>/<configDir>/agent` layout is used.
 */
function getUserScopeDirs(ctx: LoadContext): string[] {
	return [resolveUserAgentDir(ctx)];
}

/**
 * GJC's user-scope config directory.
 *
 * Home-relative `<home>/.gjc/agent` is only its default location: an agent
 * directory profile (`--agent-dir`, `GJC_CODING_AGENT_DIR`, `setAgentDir()`)
 * moves the whole user scope, and the writers (`getMCPConfigPath("user")` and
 * everything `gjc mcp add` reaches) already follow it. Resolving from the home
 * default instead would hide a profile's own registrations and load the default
 * profile's servers into it.
 */
function resolveUserAgentDir(ctx: LoadContext): string {
	return ctx.userAgentDir ?? path.join(ctx.home, PATHS.userAgent);
}

function readScopeForLevel(level: "user" | "project"): ReadScope {
	return level === "user" ? "native" : "project";
}

async function canonicalBuiltinPath(ctx: LoadContext, filePath: string, scope: ReadScope): Promise<string | null> {
	return (await canonicalizePathWithinHome(ctx, filePath, undefined, scope)) ?? null;
}

async function readBuiltinFile(ctx: LoadContext, filePath: string, scope: ReadScope): Promise<string | null> {
	const canonicalPath = await canonicalBuiltinPath(ctx, filePath, scope);
	if (!canonicalPath) return null;
	return readFile(canonicalPath, getReadOptions(ctx, scope));
}

function getProjectStopDirectory(ctx: LoadContext): string | undefined {
	if (ctx.repoRoot) return ctx.repoRoot;
	const homeRelative = path.relative(ctx.home, ctx.cwd);
	const cwdIsWithinHome =
		homeRelative === "" ||
		(homeRelative !== ".." && !homeRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(homeRelative));
	return ctx.isolatedHome || cwdIsWithinHome ? ctx.home : undefined;
}

function getProjectConfigDirs(): string[] {
	// Native project configuration is always rooted at `.gjc`. The configured
	// config-dir name redirects the user profile only; allowing it to rewrite a
	// project path would make explicit-home preflight and discovery disagree.
	return [".gjc"];
}

async function ifNonEmptyDir(ctx: LoadContext, scope: ReadScope, ...seg: string[]): Promise<string | null> {
	const dir = await canonicalBuiltinPath(ctx, path.join(...seg), scope);
	if (!dir) return null;
	const entries = await readDirEntries(dir, getReadOptions(ctx, scope));
	if (entries.length > 0) {
		return dir;
	}
	return null;
}

async function getConfigDirs(ctx: LoadContext): Promise<Array<{ dir: string; level: "user" | "project" }>> {
	const result: Array<{ dir: string; level: "user" | "project" }> = [];

	for (const projectConfigDir of getProjectConfigDirs()) {
		const projectDir = await ifNonEmptyDir(ctx, "project", ctx.cwd, projectConfigDir);
		if (projectDir) {
			result.push({ dir: projectDir, level: "project" });
		}
	}
	const userDir = await ifNonEmptyDir(ctx, "native", resolveUserAgentDir(ctx));
	if (userDir) {
		result.push({ dir: userDir, level: "user" });
	}

	return result;
}

function getAncestorDirs(cwd: string, stopAt?: string | null): Array<{ dir: string; depth: number }> {
	const ancestors: Array<{ dir: string; depth: number }> = [];
	const resolvedCwd = path.resolve(cwd);
	const resolvedStop = stopAt ? path.resolve(stopAt) : null;
	const stopIsAncestor =
		!resolvedStop ||
		resolvedStop === resolvedCwd ||
		(path.relative(resolvedStop, resolvedCwd) !== ".." &&
			!path.relative(resolvedStop, resolvedCwd).startsWith(`..${path.sep}`) &&
			!path.isAbsolute(path.relative(resolvedStop, resolvedCwd)));
	const effectiveStop = stopIsAncestor ? resolvedStop : resolvedCwd;
	let current = resolvedCwd;
	let depth = 0;
	while (true) {
		ancestors.push({ dir: current, depth });
		if (effectiveStop && current === effectiveStop) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
		depth++;
	}
	return ancestors;
}

async function findNearestProjectConfigDir(ctx: LoadContext): Promise<{ dir: string; depth: number } | null> {
	for (const ancestor of getAncestorDirs(ctx.cwd, getProjectStopDirectory(ctx))) {
		for (const projectConfigDir of getProjectConfigDirs()) {
			const configDir = await ifNonEmptyDir(ctx, "project", ancestor.dir, projectConfigDir);
			if (configDir) return { dir: configDir, depth: ancestor.depth };
		}
	}
	return null;
}

// MCP
async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const parseMcpServers = (content: string, path: string, level: "user" | "project"): MCPServer[] => {
		const result: MCPServer[] = [];
		const data = tryParseJson<{ mcpServers?: Record<string, unknown> }>(content);
		if (!data?.mcpServers) return result;

		const expanded = expandEnvVarsDeep(data.mcpServers);
		for (const [serverName, config] of Object.entries(expanded)) {
			const serverConfig = config as Record<string, unknown>;

			// Validate enabled: coerce string "true"/"false", warn on other types
			let enabled: boolean | undefined;
			if (serverConfig.enabled === undefined || serverConfig.enabled === null) {
				enabled = undefined;
			} else if (typeof serverConfig.enabled === "boolean") {
				enabled = serverConfig.enabled;
			} else if (typeof serverConfig.enabled === "string") {
				const lower = serverConfig.enabled.toLowerCase();
				if (lower === "false" || lower === "0") enabled = false;
				else if (lower === "true" || lower === "1") enabled = true;
				else {
					logger.warn(`MCP server "${serverName}": invalid enabled value "${serverConfig.enabled}", ignoring`);
					enabled = undefined;
				}
			} else {
				logger.warn(`MCP server "${serverName}": invalid enabled type ${typeof serverConfig.enabled}, ignoring`);
				enabled = undefined;
			}

			// Validate timeout: coerce numeric strings, warn on invalid
			let timeout: number | undefined;
			if (serverConfig.timeout === undefined || serverConfig.timeout === null) {
				timeout = undefined;
			} else if (typeof serverConfig.timeout === "number") {
				if (Number.isFinite(serverConfig.timeout) && serverConfig.timeout > 0) {
					timeout = serverConfig.timeout;
				} else {
					logger.warn(`MCP server "${serverName}": invalid timeout ${serverConfig.timeout}, ignoring`);
					timeout = undefined;
				}
			} else if (typeof serverConfig.timeout === "string") {
				const parsed = Number(serverConfig.timeout);
				if (Number.isFinite(parsed) && parsed > 0) {
					timeout = parsed;
				} else {
					logger.warn(`MCP server "${serverName}": invalid timeout "${serverConfig.timeout}", ignoring`);
					timeout = undefined;
				}
			} else {
				logger.warn(`MCP server "${serverName}": invalid timeout type ${typeof serverConfig.timeout}, ignoring`);
				timeout = undefined;
			}

			// Validate autoload: boolean only, warn on other types
			let autoload: boolean | undefined;
			if (serverConfig.autoload === undefined || serverConfig.autoload === null) {
				autoload = undefined;
			} else if (typeof serverConfig.autoload === "boolean") {
				autoload = serverConfig.autoload;
			} else {
				logger.warn(`MCP server "${serverName}": invalid autoload type ${typeof serverConfig.autoload}, ignoring`);
				autoload = undefined;
			}

			// Validate noInheritEnv: boolean only, warn on other types
			let noInheritEnv: boolean | undefined;
			if (serverConfig.noInheritEnv === undefined || serverConfig.noInheritEnv === null) {
				noInheritEnv = undefined;
			} else if (typeof serverConfig.noInheritEnv === "boolean") {
				noInheritEnv = serverConfig.noInheritEnv;
			} else {
				logger.warn(
					`MCP server "${serverName}": invalid noInheritEnv type ${typeof serverConfig.noInheritEnv}, ignoring`,
				);
				noInheritEnv = undefined;
			}

			result.push({
				name: serverName,
				enabled,
				autoload,
				timeout,
				command: serverConfig.command as string | undefined,
				args: serverConfig.args as string[] | undefined,
				env: serverConfig.env as Record<string, string> | undefined,
				noInheritEnv,
				cwd: serverConfig.cwd as string | undefined,
				url: serverConfig.url as string | undefined,
				headers: serverConfig.headers as Record<string, string> | undefined,
				auth: serverConfig.auth as
					| {
							type: "oauth" | "apikey";
							credentialId?: string;
							tokenUrl?: string;
							clientId?: string;
							clientSecret?: string;
					  }
					| undefined,
				oauth: serverConfig.oauth as
					| {
							clientId?: string;
							clientSecret?: string;
							redirectUri?: string;
							callbackPort?: number;
							callbackPath?: string;
					  }
					| undefined,
				transport: serverConfig.type as "stdio" | "sse" | "http" | undefined,
				_source: createSourceMeta(PROVIDER_ID, path, level),
			});
		}
		return result;
	};

	const userAgentDir = resolveUserAgentDir(ctx);
	const paths = [
		...getProjectConfigDirs().flatMap(projectConfigDir => [
			{ path: path.join(ctx.cwd, projectConfigDir, "mcp.json"), level: "project" as const },
			{ path: path.join(ctx.cwd, projectConfigDir, ".mcp.json"), level: "project" as const },
		]),
		{ path: path.join(userAgentDir, "mcp.json"), level: "user" as const },
		{ path: path.join(userAgentDir, ".mcp.json"), level: "user" as const },
	];

	const contents = await Promise.allSettled(
		paths.map(async p => {
			const scope = readScopeForLevel(p.level);
			const canonicalPath = await canonicalBuiltinPath(ctx, p.path, scope);
			if (!canonicalPath) return null;
			const content = await readBuiltinFile(ctx, canonicalPath, scope);
			return content ? { path: canonicalPath, content, level: p.level } : null;
		}),
	);

	for (const result of contents) {
		if (result.status === "fulfilled" && result.value) {
			const { path, content, level } = result.value;
			items.push(...parseMcpServers(content, path, level));
		}
	}

	return { items, warnings };
}

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadMCPServers,
});

// System Prompt (SYSTEM.md)
async function loadSystemPrompt(ctx: LoadContext): Promise<LoadResult<SystemPrompt>> {
	const items: SystemPrompt[] = [];

	for (const userScopeDir of getUserScopeDirs(ctx)) {
		const userPath = await canonicalBuiltinPath(ctx, path.join(userScopeDir, "SYSTEM.md"), "native");
		if (!userPath) continue;
		const userContent = await readBuiltinFile(ctx, userPath, "native");
		if (userContent) {
			items.push({
				path: userPath,
				content: userContent,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
			});
		}
	}

	const nearestProjectConfigDir = await findNearestProjectConfigDir(ctx);
	if (nearestProjectConfigDir) {
		const projectPath = await canonicalBuiltinPath(
			ctx,
			path.join(nearestProjectConfigDir.dir, "SYSTEM.md"),
			"project",
		);
		if (!projectPath) return { items, warnings: [] };
		const projectContent = await readBuiltinFile(ctx, projectPath, "project");
		if (projectContent) {
			items.push({
				path: projectPath,
				content: projectContent,
				level: "project",
				_source: createSourceMeta(PROVIDER_ID, projectPath, "project"),
			});
		}
	}

	return { items, warnings: [] };
}

registerProvider<SystemPrompt>(systemPromptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Custom system prompt from SYSTEM.md",
	priority: PRIORITY,
	load: loadSystemPrompt,
});

// Skills
async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	// Walk up from cwd finding .gjc/skills/ in ancestors (closest first)
	const ancestors = getAncestorDirs(ctx.cwd, getProjectStopDirectory(ctx)).filter(
		({ dir }) => path.resolve(dir) !== path.resolve(ctx.home),
	);
	const projectScans = ancestors.flatMap(({ dir }) =>
		getProjectConfigDirs().map(projectConfigDir =>
			scanSkillsFromDir(ctx, {
				dir: path.join(dir, projectConfigDir, "skills"),
				providerId: PROVIDER_ID,
				level: "project",
				scope: "project",
				requireDescription: true,
			}),
		),
	);

	// User-level scan from the active agent-directory profile.
	const userAgentDir = resolveUserAgentDir(ctx);
	const defaultAgentDir = path.join(ctx.home, PATHS.userAgent);
	const userSkillDirs = [
		...new Set([
			path.join(userAgentDir, "skills"),
			...(path.resolve(userAgentDir) === path.resolve(defaultAgentDir)
				? [path.join(ctx.home, PATHS.userBase, "skills"), path.join(ctx.home, ".gjc", "skills")]
				: []),
		]),
	];
	const userScans = userSkillDirs.map(dir =>
		scanSkillsFromDir(ctx, {
			dir,
			providerId: PROVIDER_ID,
			level: "user",
			scope: "native",
			requireDescription: true,
		}),
	);

	const results = await Promise.all([...projectScans, ...userScans]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSkills,
});

// Slash Commands
async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const items: SlashCommand[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of await getConfigDirs(ctx)) {
		const commandsDir = path.join(dir, "commands");
		const result = await loadFilesFromDir<SlashCommand>(ctx, commandsDir, PROVIDER_ID, level, {
			extensions: ["md"],
			scope: readScopeForLevel(level),
			transform: (name, content, path, source) => ({
				name: name.replace(/\.md$/, ""),
				path,
				content,
				level,
				_source: source,
			}),
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSlashCommands,
});

// Rules
async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of await getConfigDirs(ctx)) {
		const rulesDir = path.join(dir, "rules");
		const result = await loadFilesFromDir<Rule>(ctx, rulesDir, PROVIDER_ID, level, {
			extensions: ["md", "mdc"],
			scope: readScopeForLevel(level),
			transform: (name, content, path, source) =>
				buildRuleFromMarkdown(name, content, path, source, { stripNamePattern: /\.(md|mdc)$/ }),
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// Top-level RULES.md is a sticky always-apply rule. The context-file
	// discovery contract treats it as the file "re-injected near the current
	// turn so they keep hold across long conversations".
	// User scope:    ~/.gjc/agent/RULES.md
	// Project scope: nearest .gjc/RULES.md walking up from cwd to repoRoot
	const userRulesFile = path.join(resolveUserAgentDir(ctx), "RULES.md");
	const userRule = await loadStickyRulesFile(ctx, userRulesFile, "user");
	if (userRule) items.push(userRule);
	const nearestProjectConfigDir = await findNearestProjectConfigDir(ctx);
	if (nearestProjectConfigDir) {
		const projectRulesFile = path.join(nearestProjectConfigDir.dir, "RULES.md");
		const projectRule = await loadStickyRulesFile(ctx, projectRulesFile, "project");
		if (projectRule) items.push(projectRule);
	}

	return { items, warnings };
}

/**
 * Read a top-level `RULES.md` and synthesize an always-apply rule.
 * Returns null when the file is absent or empty so callers can short-circuit.
 */
async function loadStickyRulesFile(
	ctx: LoadContext,
	filePath: string,
	level: "user" | "project",
): Promise<Rule | null> {
	const scope = readScopeForLevel(level);
	const canonicalPath = await canonicalBuiltinPath(ctx, filePath, scope);
	if (!canonicalPath) return null;
	const content = await readBuiltinFile(ctx, canonicalPath, scope);
	if (!content) return null;
	const source = createSourceMeta(PROVIDER_ID, canonicalPath, level);
	const rule = buildRuleFromMarkdown("RULES.md", content, canonicalPath, source, { ruleName: "RULES" });
	// Force alwaysApply regardless of frontmatter — the whole point of RULES.md
	// is to be reattached every turn.
	return { ...rule, alwaysApply: true };
}

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadRules,
});

// Prompts
async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const items: Prompt[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of await getConfigDirs(ctx)) {
		const promptsDir = path.join(dir, "prompts");
		const result = await loadFilesFromDir<Prompt>(ctx, promptsDir, PROVIDER_ID, level, {
			extensions: ["md"],
			scope: readScopeForLevel(level),
			transform: (name, content, path, source) => ({
				name: name.replace(/\.md$/, ""),
				path,
				content,
				_source: source,
			}),
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadPrompts,
});

// Extension Modules
async function loadExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const items: ExtensionModule[] = [];
	const warnings: string[] = [];

	const resolveExtensionPath = async (rawPath: string, scope: ReadScope): Promise<string | undefined> => {
		const expanded = expandTilde(rawPath, ctx.home);
		const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(ctx.cwd, expanded);
		return await canonicalizePathWithinHome(ctx, resolved, undefined, scope);
	};

	const createExtensionModule = (extPath: string, level: "user" | "project"): ExtensionModule => ({
		name: getExtensionNameFromPath(extPath),
		path: extPath,
		level,
		_source: createSourceMeta(PROVIDER_ID, extPath, level),
	});

	const configDirs = await getConfigDirs(ctx);

	const [discoveredResults, settingsResults] = await Promise.all([
		Promise.all(
			configDirs.map(({ dir, level }) =>
				discoverExtensionModulePaths(ctx, path.join(dir, "extensions"), {
					scope: readScopeForLevel(level),
				}),
			),
		),
		Promise.all(
			configDirs.map(({ dir, level }) =>
				readBuiltinFile(ctx, path.join(dir, "settings.json"), readScopeForLevel(level)),
			),
		),
	]);

	for (let i = 0; i < configDirs.length; i++) {
		const { level } = configDirs[i];
		for (const extPath of discoveredResults[i]) {
			items.push(createExtensionModule(extPath, level));
		}
	}

	const settingsExtensions: Array<{
		resolvedPath: string;
		settingsPath: string;
		level: "user" | "project";
	}> = [];

	for (let i = 0; i < configDirs.length; i++) {
		const { dir, level } = configDirs[i];
		const settingsContent = settingsResults[i];
		if (!settingsContent) continue;

		const settingsPath = path.join(dir, "settings.json");
		const settingsData = tryParseJson<{ extensions?: unknown }>(settingsContent);
		const extensions = settingsData?.extensions;
		if (!Array.isArray(extensions)) continue;

		for (const entry of extensions) {
			if (typeof entry !== "string") {
				warnings.push(`Invalid extension path in ${settingsPath}: ${String(entry)}`);
				continue;
			}
			const resolvedPath = await resolveExtensionPath(entry, readScopeForLevel(level));
			if (!resolvedPath) {
				warnings.push(`Extension path escapes isolated home in ${settingsPath}: ${entry}`);
				continue;
			}
			settingsExtensions.push({
				resolvedPath,
				settingsPath,
				level,
			});
		}
	}

	const [entriesResults, fileContents] = await Promise.all([
		Promise.all(
			settingsExtensions.map(({ resolvedPath, level }) =>
				readDirEntries(resolvedPath, getReadOptions(ctx, readScopeForLevel(level))),
			),
		),
		Promise.all(
			settingsExtensions.map(({ resolvedPath, level }) =>
				readBuiltinFile(ctx, resolvedPath, readScopeForLevel(level)),
			),
		),
	]);

	const dirDiscoveryPromises: Array<{
		promise: Promise<string[]>;
		level: "user" | "project";
	}> = [];

	for (let i = 0; i < settingsExtensions.length; i++) {
		const { resolvedPath, level } = settingsExtensions[i];
		const entries = entriesResults[i];
		const content = fileContents[i];

		if (entries.length > 0) {
			dirDiscoveryPromises.push({
				promise: discoverExtensionModulePaths(ctx, resolvedPath, {
					scope: readScopeForLevel(level),
				}),
				level,
			});
		} else if (content !== null) {
			items.push(createExtensionModule(resolvedPath, level));
		} else {
			warnings.push(`Extension path not found: ${resolvedPath}`);
		}
	}

	const dirDiscoveryResults = await Promise.all(dirDiscoveryPromises.map(d => d.promise));
	for (let i = 0; i < dirDiscoveryPromises.length; i++) {
		const { level } = dirDiscoveryPromises[i];
		for (const extPath of dirDiscoveryResults[i]) {
			items.push(createExtensionModule(extPath, level));
		}
	}

	return { items, warnings };
}

registerProvider<ExtensionModule>(extensionModuleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadExtensionModules,
});

// Extensions
async function loadExtensions(ctx: LoadContext): Promise<LoadResult<Extension>> {
	const items: Extension[] = [];
	const warnings: string[] = [];

	const configDirs = await getConfigDirs(ctx);
	const entriesResults = await Promise.all(
		configDirs.map(({ dir, level }) =>
			readDirEntries(path.join(dir, "extensions"), getReadOptions(ctx, readScopeForLevel(level))),
		),
	);

	const manifestCandidates: Array<{
		extDir: string;
		manifestPath: string;
		entryName: string;
		level: "user" | "project";
	}> = [];

	for (let i = 0; i < configDirs.length; i++) {
		const { dir, level } = configDirs[i];
		const entries = entriesResults[i];
		const extensionsDir = path.join(dir, "extensions");

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (!entry.isDirectory()) continue;

			const scope = readScopeForLevel(level);
			const extDir = await canonicalBuiltinPath(ctx, path.join(extensionsDir, entry.name), scope);
			if (!extDir) continue;
			const manifestPath = await canonicalBuiltinPath(ctx, path.join(extDir, "gemini-extension.json"), scope);
			if (!manifestPath) continue;
			manifestCandidates.push({
				extDir,
				manifestPath,
				entryName: entry.name,
				level,
			});
		}
	}

	const manifestContents = await Promise.all(
		manifestCandidates.map(({ manifestPath, level }) => readBuiltinFile(ctx, manifestPath, readScopeForLevel(level))),
	);

	for (let i = 0; i < manifestCandidates.length; i++) {
		const content = manifestContents[i];
		if (!content) continue;

		const { extDir, manifestPath, entryName, level } = manifestCandidates[i];
		const manifest = tryParseJson<ExtensionManifest>(content);
		if (!manifest) {
			warnings.push(`Failed to parse ${manifestPath}`);
			continue;
		}

		items.push({
			name: manifest.name || entryName,
			path: extDir,
			manifest,
			level,
			_source: createSourceMeta(PROVIDER_ID, manifestPath, level),
		});
	}

	return { items, warnings };
}

registerProvider<Extension>(extensionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadExtensions,
});

// Instructions
async function loadInstructions(ctx: LoadContext): Promise<LoadResult<Instruction>> {
	const items: Instruction[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of await getConfigDirs(ctx)) {
		const instructionsDir = path.join(dir, "instructions");
		const result = await loadFilesFromDir<Instruction>(ctx, instructionsDir, PROVIDER_ID, level, {
			extensions: ["md"],
			scope: readScopeForLevel(level),
			transform: (name, content, path, source) => {
				const { frontmatter, body } = parseFrontmatter(content, { source: path });
				return {
					name: name.replace(/\.instructions\.md$/, "").replace(/\.md$/, ""),
					path,
					content: body,
					applyTo: frontmatter.applyTo as string | undefined,
					_source: source,
				};
			},
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

registerProvider<Instruction>(instructionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadInstructions,
});

// Hooks
async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const items: Hook[] = [];

	const configDirs = await getConfigDirs(ctx);
	const hookTypes = ["pre", "post"] as const;

	const typeDirRequests: Array<{
		typeDir: string;
		hookType: (typeof hookTypes)[number];
		level: "user" | "project";
	}> = [];

	for (const { dir, level } of configDirs) {
		for (const hookType of hookTypes) {
			const scope = readScopeForLevel(level);
			const typeDir = await canonicalBuiltinPath(ctx, path.join(dir, "hooks", hookType), scope);
			if (!typeDir) continue;
			typeDirRequests.push({
				typeDir,
				hookType,
				level,
			});
		}
	}

	const typeEntriesResults = await Promise.all(
		typeDirRequests.map(({ typeDir, level }) =>
			readDirEntries(typeDir, getReadOptions(ctx, readScopeForLevel(level))),
		),
	);

	for (let i = 0; i < typeDirRequests.length; i++) {
		const { typeDir, hookType, level } = typeDirRequests[i];
		const typeEntries = typeEntriesResults[i];

		for (const entry of typeEntries) {
			if (entry.name.startsWith(".")) continue;
			if (!entry.isFile()) continue;

			const hookPath = await canonicalBuiltinPath(ctx, path.join(typeDir, entry.name), readScopeForLevel(level));
			if (!hookPath) continue;
			if (ctx.isolatedHome && !(await isSingleLinkRegularFileAt(hookPath))) continue;
			const baseName = entry.name.includes(".") ? entry.name.slice(0, entry.name.lastIndexOf(".")) : entry.name;
			const tool = baseName === "*" ? "*" : baseName;

			items.push({
				name: entry.name,
				path: hookPath,
				type: hookType,
				tool,
				level,
				_source: createSourceMeta(PROVIDER_ID, hookPath, level),
			});
		}
	}

	return { items, warnings: [] };
}

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadHooks,
});

// Custom Tools
async function loadTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const items: CustomTool[] = [];
	const warnings: string[] = [];

	const configDirs = await getConfigDirs(ctx);
	const toolsDirs = await Promise.all(
		configDirs.map(({ dir, level }) => canonicalBuiltinPath(ctx, path.join(dir, "tools"), readScopeForLevel(level))),
	);
	const entriesResults = await Promise.all(
		toolsDirs.map((toolsDir, i) =>
			toolsDir
				? readDirEntries(toolsDir, getReadOptions(ctx, readScopeForLevel(configDirs[i].level)))
				: Promise.resolve([]),
		),
	);

	const fileLoadPromises: Array<Promise<{ items: CustomTool[]; warnings?: string[] }>> = [];
	const subDirCandidates: Array<{
		indexPath: string;
		entryName: string;
		level: "user" | "project";
	}> = [];

	for (let i = 0; i < configDirs.length; i++) {
		const { level } = configDirs[i];
		const toolEntries = entriesResults[i];
		const toolsDir = toolsDirs[i];
		if (toolEntries.length === 0 || !toolsDir) continue;

		fileLoadPromises.push(
			loadFilesFromDir<CustomTool>(ctx, toolsDir, PROVIDER_ID, level, {
				extensions: ["json", "md", "ts", "js", "sh", "bash", "py"],
				scope: readScopeForLevel(level),
				transform: (name, content, path, source) => {
					if (name.endsWith(".json")) {
						const data = tryParseJson<{ name?: string; description?: string }>(content);
						const toolName = data?.name || name.replace(/\.json$/, "");
						const description =
							typeof data?.description === "string" && data.description.trim()
								? data.description
								: `${toolName} custom tool`;
						return {
							name: toolName,
							path,
							description,
							level,
							_source: source,
						};
					}
					if (name.endsWith(".md")) {
						const { frontmatter } = parseFrontmatter(content, { source: path });
						const toolName = (frontmatter.name as string) || name.replace(/\.md$/, "");
						const description =
							typeof frontmatter.description === "string" && frontmatter.description.trim()
								? String(frontmatter.description)
								: `${toolName} custom tool`;
						return {
							name: toolName,
							path,
							description,
							level,
							_source: source,
						};
					}
					// Executable tool files (.ts, .js, .sh, .bash, .py)
					const toolName = name.replace(/\.(ts|js|sh|bash|py)$/, "");
					return {
						name: toolName,
						path,
						description: `${toolName} custom tool`,
						level,
						_source: source,
					};
				},
			}),
		);

		for (const entry of toolEntries) {
			if (entry.name.startsWith(".")) continue;
			if (!entry.isDirectory()) continue;

			const indexPath = await canonicalBuiltinPath(
				ctx,
				path.join(toolsDir, entry.name, "index.ts"),
				readScopeForLevel(level),
			);
			if (!indexPath) continue;
			subDirCandidates.push({
				indexPath,
				entryName: entry.name,
				level,
			});
		}
	}

	const [fileResults, indexContents] = await Promise.all([
		Promise.all(fileLoadPromises),
		Promise.all(
			subDirCandidates.map(({ indexPath, level }) => readBuiltinFile(ctx, indexPath, readScopeForLevel(level))),
		),
	]);

	for (const result of fileResults) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	for (let i = 0; i < subDirCandidates.length; i++) {
		const indexContent = indexContents[i];
		if (indexContent !== null) {
			const { indexPath, entryName, level } = subDirCandidates[i];
			items.push({
				name: entryName,
				path: indexPath,
				description: `${entryName} custom tool`,
				level,
				_source: createSourceMeta(PROVIDER_ID, indexPath, level),
			});
		}
	}

	return { items, warnings };
}

registerProvider<CustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadTools,
});

// Settings
async function loadSettings(ctx: LoadContext): Promise<LoadResult<Settings>> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	const parseYamlSettings = (content: string, filePath: string): Record<string, unknown> | null => {
		try {
			const data = YAML.parse(content);
			if (!data || typeof data !== "object" || Array.isArray(data)) return {};
			return data as Record<string, unknown>;
		} catch {
			warnings.push(`Failed to parse ${filePath}`);
			return null;
		}
	};

	for (const { dir, level } of await getConfigDirs(ctx)) {
		const scope = readScopeForLevel(level);
		const settingsPath = await canonicalBuiltinPath(ctx, path.join(dir, "settings.json"), scope);
		const settingsContent = settingsPath ? await readBuiltinFile(ctx, settingsPath, scope) : null;
		if (settingsContent && settingsPath) {
			const data = tryParseJson<Record<string, unknown>>(settingsContent);
			if (data) {
				items.push({
					path: settingsPath,
					data,
					level,
					_source: createSourceMeta(PROVIDER_ID, settingsPath, level),
				});
			} else {
				warnings.push(`Failed to parse ${settingsPath}`);
			}
		}

		const configPath = await canonicalBuiltinPath(ctx, path.join(dir, "config.yml"), scope);
		if (!configPath) continue;
		const configContent = await readBuiltinFile(ctx, configPath, scope);
		if (!configContent) continue;

		const data = parseYamlSettings(configContent, configPath);
		if (!data) continue;

		items.push({
			path: configPath,
			data,
			level,
			_source: createSourceMeta(PROVIDER_ID, configPath, level),
		});
	}

	return { items, warnings };
}

registerProvider<Settings>(settingsCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSettings,
});

// Context Files (AGENTS.md)
async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	const userPath = await canonicalBuiltinPath(ctx, path.join(getUserScopeDirs(ctx)[0]!, "AGENTS.md"), "native");
	const userContent = userPath ? await readBuiltinFile(ctx, userPath, "native") : null;
	if (userContent && userPath) {
		items.push({
			path: userPath,
			content: userContent,
			level: "user",
			_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
		});
	}

	const nearestProjectConfigDir = await findNearestProjectConfigDir(ctx);
	if (nearestProjectConfigDir) {
		const projectPath = await canonicalBuiltinPath(
			ctx,
			path.join(nearestProjectConfigDir.dir, "AGENTS.md"),
			"project",
		);
		const projectContent = projectPath ? await readBuiltinFile(ctx, projectPath, "project") : null;
		if (projectContent && projectPath) {
			items.push({
				path: projectPath,
				content: projectContent,
				level: "project",
				depth: nearestProjectConfigDir.depth,
				_source: createSourceMeta(PROVIDER_ID, projectPath, "project"),
			});
			return { items, warnings };
		}
	}
	return { items, warnings };
}

registerProvider<ContextFile>(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load AGENTS.md from .gjc/ directories",
	priority: PRIORITY,
	load: loadContextFiles,
});
