import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, isRecord, logger, pathIsWithin } from "@gajae-code/utils";
import { YAML } from "bun";
import { getConfigDirPaths } from "../config";
import { type ClaudePluginRoot, getPreloadedPluginRoots } from "../discovery/helpers";
import { BiomeClient } from "./clients/biome-client";
import { SwiftLintClient } from "./clients/swiftlint-client";
import DEFAULTS from "./defaults.json" with { type: "json" };
import { isProjectControlledPath } from "./path-trust";
import type { ServerConfig } from "./types";

export interface LspConfig {
	servers: Record<string, ServerConfig>;
	/** Idle timeout in milliseconds. If set, LSP clients will be shutdown after this period of inactivity. Disabled by default. */
	idleTimeoutMs?: number;
}

// =============================================================================
// Default Server Configuration Loading
// =============================================================================

const PID_TOKEN = "$PID";

interface RawServerConfig extends Partial<ServerConfig> {
	extensionToLanguage?: unknown;
	initializationOptions?: unknown;
}

interface NormalizedConfig {
	servers: Record<string, RawServerConfig>;
	idleTimeoutMs?: number;
}

function parseConfigContent(content: string, filePath: string): unknown {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml") {
		return YAML.parse(content) as unknown;
	}
	return JSON.parse(content) as unknown;
}

function normalizeConfig(value: unknown): NormalizedConfig | null {
	if (!isRecord(value)) return null;

	const idleTimeoutMs = typeof value.idleTimeoutMs === "number" ? value.idleTimeoutMs : undefined;
	const rawServers = value.servers;

	if (isRecord(rawServers)) {
		return { servers: rawServers as Record<string, RawServerConfig>, idleTimeoutMs };
	}

	const servers = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "idleTimeoutMs")) as Record<
		string,
		RawServerConfig
	>;

	return { servers, idleTimeoutMs };
}

function normalizeStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return items.length > 0 ? items : null;
}
function normalizeExtensionToFileTypes(value: unknown): string[] | null {
	if (!isRecord(value)) return null;
	const extensions = Object.keys(value).filter(extension => extension.length > 0);
	return extensions.length > 0 ? extensions : null;
}

function sanitizeServerConfig(config: unknown, allowProcessOverrides: boolean): RawServerConfig | null {
	if (!isRecord(config)) return null;

	const sanitized: RawServerConfig = {};
	if (allowProcessOverrides && typeof config.command === "string" && config.command.length > 0) {
		sanitized.command = config.command;
	}
	if (allowProcessOverrides && Array.isArray(config.args)) {
		sanitized.args = config.args.filter((entry): entry is string => typeof entry === "string");
	}

	const fileTypes = normalizeStringArray(config.fileTypes);
	if (fileTypes) sanitized.fileTypes = fileTypes;
	if (isRecord(config.extensionToLanguage)) sanitized.extensionToLanguage = config.extensionToLanguage;

	const rootMarkers = normalizeStringArray(config.rootMarkers);
	if (rootMarkers) sanitized.rootMarkers = rootMarkers;
	if (allowProcessOverrides && isRecord(config.initOptions)) sanitized.initOptions = config.initOptions;
	if (allowProcessOverrides && isRecord(config.initializationOptions)) {
		sanitized.initializationOptions = config.initializationOptions;
	}
	if (allowProcessOverrides && isRecord(config.settings)) sanitized.settings = config.settings;
	if (typeof config.disabled === "boolean") sanitized.disabled = config.disabled;
	if (typeof config.warmupTimeoutMs === "number" && Number.isFinite(config.warmupTimeoutMs)) {
		sanitized.warmupTimeoutMs = config.warmupTimeoutMs;
	}
	if (isRecord(config.capabilities)) sanitized.capabilities = config.capabilities;
	const supersedes = normalizeStringArray(config.supersedes);
	if (supersedes) sanitized.supersedes = supersedes;
	if (typeof config.isLinter === "boolean") sanitized.isLinter = config.isLinter;

	return sanitized;
}

function normalizeServerConfig(name: string, config: RawServerConfig): ServerConfig | null {
	const command = typeof config.command === "string" && config.command.length > 0 ? config.command : null;
	const fileTypes =
		normalizeStringArray(config.fileTypes) ?? normalizeExtensionToFileTypes(config.extensionToLanguage);
	const rootMarkers = normalizeStringArray(config.rootMarkers) ?? (config.extensionToLanguage ? ["."] : null);

	if (!command || !fileTypes || !rootMarkers) {
		logger.warn("Ignoring invalid LSP server config (missing required fields).", { name });
		return null;
	}

	const args = Array.isArray(config.args)
		? config.args.filter((entry): entry is string => typeof entry === "string")
		: undefined;
	const initOptions = isRecord(config.initOptions)
		? config.initOptions
		: isRecord(config.initializationOptions)
			? config.initializationOptions
			: undefined;
	const supersedes = normalizeStringArray(config.supersedes);

	return {
		command,
		...(args ? { args } : {}),
		fileTypes,
		rootMarkers,
		...(initOptions ? { initOptions } : {}),
		...(isRecord(config.settings) ? { settings: config.settings } : {}),
		...(typeof config.disabled === "boolean" ? { disabled: config.disabled } : {}),
		...(typeof config.warmupTimeoutMs === "number" ? { warmupTimeoutMs: config.warmupTimeoutMs } : {}),
		...(isRecord(config.capabilities) ? { capabilities: config.capabilities } : {}),
		...(supersedes ? { supersedes } : {}),
		...(typeof config.isLinter === "boolean" ? { isLinter: config.isLinter } : {}),
	};
}

function readConfigFile(filePath: string): NormalizedConfig | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = parseConfigContent(content, filePath);
		return normalizeConfig(parsed);
	} catch {
		return null;
	}
}

function coerceServerConfigs(servers: Record<string, RawServerConfig>): Record<string, ServerConfig> {
	const result: Record<string, ServerConfig> = {};
	for (const [name, config] of Object.entries(servers)) {
		const sanitized = sanitizeServerConfig(config, true);
		const normalized = sanitized ? normalizeServerConfig(name, sanitized) : null;
		if (normalized) {
			result[name] = normalized;
		}
	}
	return result;
}

function mergeServers(
	base: Record<string, ServerConfig>,
	overrides: Record<string, RawServerConfig>,
	allowProcessOverrides: boolean,
): Record<string, ServerConfig> {
	const merged: Record<string, ServerConfig> = { ...base };
	for (const [name, config] of Object.entries(overrides)) {
		if (
			!allowProcessOverrides &&
			isRecord(config) &&
			("command" in config ||
				"args" in config ||
				"resolvedCommand" in config ||
				"createClient" in config ||
				"initOptions" in config ||
				"initializationOptions" in config ||
				"settings" in config)
		) {
			logger.warn("Ignoring project-controlled LSP process-affecting overrides.", { name });
		}
		const sanitized = sanitizeServerConfig(config, allowProcessOverrides);
		if (!sanitized) {
			logger.warn("Ignoring invalid LSP server config.", { name });
			continue;
		}
		if (merged[name]) {
			const candidate = { ...merged[name], ...sanitized };
			const normalized = normalizeServerConfig(name, candidate);
			if (normalized) {
				merged[name] = normalized;
			} else {
				logger.warn("Ignoring invalid LSP overrides (keeping previous config).", { name });
			}
		} else {
			const normalized = normalizeServerConfig(name, sanitized);
			if (normalized) {
				merged[name] = normalized;
			}
		}
	}
	return merged;
}

function applyServerPrecedence(servers: Record<string, ServerConfig>): Record<string, ServerConfig> {
	const suppressed = new Set<string>();
	for (const config of Object.values(servers)) {
		for (const serverName of config.supersedes ?? []) {
			suppressed.add(serverName);
		}
	}
	if (suppressed.size === 0) return servers;

	return Object.fromEntries(Object.entries(servers).filter(([name]) => !suppressed.has(name)));
}

function applyRuntimeDefaults(servers: Record<string, ServerConfig>): Record<string, ServerConfig> {
	const updated: Record<string, ServerConfig> = { ...servers };

	if (updated.biome) {
		updated.biome = { ...updated.biome, createClient: BiomeClient.create };
	}

	if (updated.swiftlint) {
		updated.swiftlint = { ...updated.swiftlint, createClient: SwiftLintClient.create };
	}

	if (updated.omnisharp?.args) {
		const args = updated.omnisharp.args.map(arg => (arg === PID_TOKEN ? String(process.pid) : arg));
		updated.omnisharp = { ...updated.omnisharp, args };
	}

	return updated;
}

// =============================================================================
// Configuration Loading
// =============================================================================

/**
 * Check if any root marker file exists in the directory
 */
export function hasRootMarkers(cwd: string, markers: string[]): boolean {
	let entries: string[] | null = null;
	for (const marker of markers) {
		// Handle glob-like patterns (e.g., "*.cabal"). Root markers live at the
		// project root, so a one-level readdir is sufficient — and avoids
		// Bun.Glob descending into node_modules for patterns like "**/*.cabal".
		if (marker.includes("*")) {
			if (entries === null) {
				try {
					entries = fs.readdirSync(cwd);
				} catch {
					entries = [];
					logger.warn("Failed to list directory for glob root marker.", { marker, cwd });
				}
			}
			const glob = new Bun.Glob(marker);
			for (const entry of entries) {
				if (glob.match(entry)) {
					return true;
				}
			}
			continue;
		}
		const filePath = path.join(cwd, marker);
		if (fs.existsSync(filePath)) {
			return true;
		}
	}
	return false;
}

// =============================================================================
// Local Binary Resolution
// =============================================================================

/**
 * Local bin directories to check before $PATH, ordered by priority.
 * Each entry maps a root marker to the bin directory to check.
 */
const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDir: string }> = [
	// Node.js - check node_modules/.bin/
	{ markers: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"], binDir: "node_modules/.bin" },
	// Python - check virtual environment bin directories
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDir: ".venv/bin" },
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDir: "venv/bin" },
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDir: ".env/bin" },
	// Ruby - check vendor bundle and binstubs
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "vendor/bundle/bin" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "bin" },
	// Go - check project-local bin
	{ markers: ["go.mod", "go.sum"], binDir: "bin" },
];

const WINDOWS_LOCAL_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat"] as const;

function resolveLocalCommand(basePath: string): string | null {
	if (fs.existsSync(basePath)) return basePath;
	if (process.platform !== "win32") return null;

	// Package managers write Windows launchers with executable suffixes in node_modules/.bin.
	for (const extension of WINDOWS_LOCAL_EXECUTABLE_EXTENSIONS) {
		const candidate = `${basePath}${extension}`;
		if (fs.existsSync(candidate)) return candidate;
	}

	return null;
}

/**
 * Resolve a command to an executable path.
 * Checks project-local bin directories first, then falls back to $PATH.
 *
 * @param command - The command name (e.g., "typescript-language-server")
 * @param cwd - Working directory to search from
 * @returns Absolute path to the executable, or null if not found
 */
export function resolveCommand(command: string, cwd: string): string | null {
	// Check local bin directories based on project markers
	for (const { markers, binDir } of LOCAL_BIN_PATHS) {
		if (hasRootMarkers(cwd, markers)) {
			const localPath = path.join(cwd, binDir, command);
			const resolvedLocalPath = resolveLocalCommand(localPath);
			if (resolvedLocalPath) {
				return resolvedLocalPath;
			}
		}
	}

	// Fall back to $PATH
	return $which(command);
}

/** Resolve an LSP executable without consulting project-controlled bin directories. */
function resolveTrustedLspCommand(command: string, cwd: string): string | null {
	if (!path.isAbsolute(command) && (command.includes("/") || command.includes("\\"))) return null;
	const discovered = path.isAbsolute(command) ? command : $which(command);
	if (!discovered) return null;
	if (isProjectControlledPath(discovered, cwd)) return null;
	const canonical = canonicalExistingPath(discovered);
	return canonical;
}

interface ConfigSource {
	allowProcessOverrides: boolean;
	read(): LoadedConfigSource | null;
}

interface LoadedConfigSource {
	config: NormalizedConfig;
	projectControlled: boolean;
}

function canonicalExistingPath(filePath: string): string | null {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return null;
	}
}

function readCanonicalConfigFile(filePath: string, cwd: string): LoadedConfigSource | null {
	const canonicalPath = canonicalExistingPath(filePath);
	if (!canonicalPath) return null;
	const config = readConfigFile(canonicalPath);
	return config ? { config, projectControlled: isProjectControlledPath(canonicalPath, cwd) } : null;
}

function fileConfigSource(filePath: string, cwd: string, allowProcessOverrides: boolean): ConfigSource {
	return {
		allowProcessOverrides,
		read: () => readCanonicalConfigFile(filePath, cwd),
	};
}

function readMarketplaceLspConfig(root: ClaudePluginRoot, cwd: string): LoadedConfigSource | null {
	const catalogPaths = [
		path.resolve(root.path, "..", "..", "marketplace.json"),
		path.resolve(root.path, "..", "..", ".claude-plugin", "marketplace.json"),
	];

	for (const catalogPath of catalogPaths) {
		try {
			const canonicalCatalogPath = canonicalExistingPath(catalogPath);
			if (!canonicalCatalogPath) continue;
			const catalog = JSON.parse(fs.readFileSync(canonicalCatalogPath, "utf-8")) as unknown;
			if (!isRecord(catalog) || !Array.isArray(catalog.plugins)) continue;
			const catalogIsProjectControlled = isProjectControlledPath(canonicalCatalogPath, cwd);

			for (const plugin of catalog.plugins) {
				if (!isRecord(plugin) || plugin.name !== root.plugin) continue;

				const lspServers = plugin.lspServers;
				if (typeof lspServers === "string") {
					const configPath = path.resolve(root.path, lspServers);
					if (!pathIsWithin(root.path, configPath)) return null;
					const canonicalRootPath = canonicalExistingPath(root.path);
					const canonicalConfigPath = canonicalExistingPath(configPath);
					if (
						!canonicalRootPath ||
						!canonicalConfigPath ||
						!pathIsWithin(canonicalRootPath, canonicalConfigPath)
					) {
						return null;
					}
					const config = readConfigFile(canonicalConfigPath);
					return config
						? {
								config,
								projectControlled:
									catalogIsProjectControlled || isProjectControlledPath(canonicalConfigPath, cwd),
							}
						: null;
				}
				if (isRecord(lspServers)) {
					const config = normalizeConfig({ servers: lspServers });
					return config ? { config, projectControlled: catalogIsProjectControlled } : null;
				}
				return null;
			}
		} catch {}
	}

	return null;
}

function marketplaceConfigSource(root: ClaudePluginRoot, cwd: string, allowProcessOverrides: boolean): ConfigSource {
	return {
		allowProcessOverrides,
		read: () => readMarketplaceLspConfig(root, cwd),
	};
}

function pluginCanOverrideProcess(root: ClaudePluginRoot, cwd: string): boolean {
	return root.scope !== "project" && !isProjectControlledPath(root.path, cwd);
}

/**
 * Configuration sources in priority order.
 * Supports both visible and hidden variants at each config location.
 */
function getConfigSources(cwd: string): ConfigSource[] {
	const filenames = ["lsp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml"];
	const sources: ConfigSource[] = [];

	// Project root files (highest priority)
	for (const filename of filenames) {
		sources.push(fileConfigSource(path.join(cwd, filename), cwd, false));
	}

	// Project config directories (.gjc/, .gemini/)
	const projectDirs = getConfigDirPaths("", { user: false, project: true, cwd });
	for (const dir of projectDirs) {
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(dir, filename), cwd, false));
		}
	}

	// User config directories (~/.gjc/agent/, ~/.gemini/)
	const userDirs = getConfigDirPaths("", { user: true, project: false });
	for (const dir of userDirs) {
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(dir, filename), cwd, true));
		}
	}

	// Plugin LSP configs
	const pluginRoots = getPreloadedPluginRoots();
	for (const root of pluginRoots) {
		const allowProcessOverrides = pluginCanOverrideProcess(root, cwd);
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(root.path, filename), cwd, allowProcessOverrides));
		}
		sources.push(marketplaceConfigSource(root, cwd, allowProcessOverrides));
	}

	// User home root files (lowest priority fallback)
	for (const filename of filenames) {
		sources.push(fileConfigSource(path.join(os.homedir(), filename), cwd, true));
	}

	return sources;
}

/**
 * Load LSP configuration.
 *
 * Priority (highest to lowest):
 * 1. Project root: lsp.json/.lsp.json/lsp.yml/.lsp.yml/lsp.yaml/.lsp.yaml
 * 2. Project config dirs: .gjc/lsp.*, .gemini/lsp.* (+ hidden variants)
 * 3. User config dirs: ~/.gjc/agent/lsp.*, ~/.gemini/lsp.* (+ hidden variants)
 * 4. User home root: ~/lsp.*, ~/.lsp.*
 * 5. Auto-detect from project markers + available binaries
 *
 * Config files are merged from lowest to highest priority; later files override earlier settings.
 *
 * Config file format (JSON or YAML):
 * ```json
 * {
 *   "servers": {
 *     "typescript-language-server": {
 *       "command": "typescript-language-server",
 *       "args": ["--stdio", "--log-level", "4"],
 *       "disabled": false
 *     },
 *     "my-custom-server": {
 *       "command": "/path/to/server",
 *       "args": ["--stdio"],
 *       "fileTypes": [".xyz"],
 *       "rootMarkers": [".xyz-project"]
 *     }
 *   }
 * }
 * ```
 */
export function loadConfig(cwd: string): LspConfig {
	let mergedServers = coerceServerConfigs(DEFAULTS);

	const configSources = getConfigSources(cwd).reverse();
	let hasOverrides = false;

	let idleTimeoutMs: number | undefined;
	for (const source of configSources) {
		const loaded = source.read();
		if (!loaded) continue;
		const parsed = loaded.config;
		const allowProcessOverrides = source.allowProcessOverrides && !loaded.projectControlled;
		const hasServerOverrides = Object.keys(parsed.servers).length > 0;
		if (hasServerOverrides) {
			hasOverrides = true;
			mergedServers = mergeServers(mergedServers, parsed.servers, allowProcessOverrides);
		}
		if (parsed.idleTimeoutMs !== undefined) {
			idleTimeoutMs = parsed.idleTimeoutMs;
		}
	}

	if (!hasOverrides) {
		// Auto-detect: find servers based on project markers AND available binaries
		const detected: Record<string, ServerConfig> = {};
		const defaultsWithRuntime = applyRuntimeDefaults(mergedServers);

		for (const [name, config] of Object.entries(defaultsWithRuntime)) {
			// Check if project has root markers for this language
			if (!hasRootMarkers(cwd, config.rootMarkers)) continue;

			// Check if the language server binary is available (local or $PATH)
			const resolved = resolveTrustedLspCommand(config.command, cwd);
			if (!resolved) continue;

			detected[name] = { ...config, resolvedCommand: resolved };
		}

		return { servers: applyServerPrecedence(detected), idleTimeoutMs };
	}
	// Merge overrides with defaults and filter to available servers
	const mergedWithRuntime = applyRuntimeDefaults(mergedServers);
	const available: Record<string, ServerConfig> = {};

	for (const [name, config] of Object.entries(mergedWithRuntime)) {
		if (config.disabled) continue;
		if (!hasRootMarkers(cwd, config.rootMarkers)) continue;
		const resolved = resolveTrustedLspCommand(config.command, cwd);
		if (!resolved) continue;
		available[name] = { ...config, resolvedCommand: resolved };
	}

	return { servers: applyServerPrecedence(available), idleTimeoutMs };
}

// =============================================================================
// Server Selection
// =============================================================================

/**
 * Find all servers that can handle a file based on extension.
 * Returns servers sorted with primary (non-linter) servers first.
 */
export function getServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	const ext = path.extname(filePath).toLowerCase();
	const fileName = path.basename(filePath).toLowerCase();
	const matches: Array<[string, ServerConfig]> = [];

	for (const [name, serverConfig] of Object.entries(config.servers)) {
		const supportsFile = serverConfig.fileTypes.some(fileType => {
			const normalized = fileType.toLowerCase();
			return normalized === ext || normalized === fileName;
		});

		if (supportsFile) {
			matches.push([name, serverConfig]);
		}
	}

	// Sort: primary servers (non-linters) first, then linters
	return matches.sort((a, b) => {
		const aIsLinter = a[1].isLinter ? 1 : 0;
		const bIsLinter = b[1].isLinter ? 1 : 0;
		return aIsLinter - bIsLinter;
	});
}

/**
 * Find the primary server for a file (prefers type-checkers over linters).
 * Used for operations like definition, hover, references that need type intelligence.
 */
export function getServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}

/**
 * Check if a server has a specific capability
 */
export function hasCapability(
	config: ServerConfig,
	capability: keyof NonNullable<ServerConfig["capabilities"]>,
): boolean {
	return config.capabilities?.[capability] === true;
}
