/**
 * MCP JSON Provider
 *
 * Discovers standalone mcp.json / .mcp.json files in the project root.
 * This is a fallback for projects that have a standalone mcp.json without any config directory.
 *
 * Priority: 5 (low, as this is a fallback after tool-specific providers)
 */
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { logger, tryParseJson } from "@gajae-code/utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { createSourceMeta, expandEnvVarsDeep } from "./helpers";

const PROVIDER_ID = "mcp-json";
const DISPLAY_NAME = "MCP Config";
const PROTOTYPE_SENSITIVE_SERVER_NAMES = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Raw MCP JSON format (matches Anthropic model Desktop's format).
 */
interface MCPConfigFile {
	mcpServers?: Record<
		string,
		{
			enabled?: boolean;
			autoload?: boolean;
			timeout?: number;
			command?: string;
			args?: string[];
			env?: Record<string, string>;
			noInheritEnv?: boolean;
			cwd?: string;
			url?: string;
			headers?: Record<string, string>;
			auth?: {
				type: "oauth" | "apikey";
				credentialId?: string;
				tokenUrl?: string;
				clientId?: string;
				clientSecret?: string;
			};
			type?: "stdio" | "sse" | "http";
			oauth?: {
				clientId?: string;
				clientSecret?: string;
				redirectUri?: string;
				callbackPort?: number;
				callbackPath?: string;
			};
		}
	>;
	disabledServers?: string[];
}
export interface MCPJsonLoadResult extends LoadResult<MCPServer> {
	disabledServers: string[];
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}
function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every(item => typeof item === "string");
}
function isOptionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
}
function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}
function isValidAuthConfig(value: unknown): boolean {
	return (
		isRecord(value) &&
		(value.type === "oauth" || value.type === "apikey") &&
		isOptionalString(value.credentialId) &&
		isOptionalString(value.tokenUrl) &&
		isOptionalString(value.clientId) &&
		isOptionalString(value.clientSecret)
	);
}
function isValidOAuthConfig(value: unknown): boolean {
	return (
		isRecord(value) &&
		isOptionalString(value.clientId) &&
		isOptionalString(value.clientSecret) &&
		isOptionalString(value.redirectUri) &&
		(value.callbackPort === undefined ||
			(typeof value.callbackPort === "number" &&
				Number.isInteger(value.callbackPort) &&
				value.callbackPort >= 1 &&
				value.callbackPort <= 65_535)) &&
		isOptionalString(value.callbackPath)
	);
}
function isValidExactServerConfig(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		isOptionalBoolean(value.enabled) &&
		isOptionalBoolean(value.autoload) &&
		isOptionalBoolean(value.noInheritEnv) &&
		(value.timeout === undefined ||
			(typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout > 0)) &&
		isOptionalString(value.command) &&
		(value.args === undefined || isStringArray(value.args)) &&
		(value.env === undefined || isStringRecord(value.env)) &&
		isOptionalString(value.cwd) &&
		isOptionalString(value.url) &&
		(value.headers === undefined || isStringRecord(value.headers)) &&
		(value.type === undefined || value.type === "stdio" || value.type === "sse" || value.type === "http") &&
		(value.auth === undefined || isValidAuthConfig(value.auth)) &&
		(value.oauth === undefined || isValidOAuthConfig(value.oauth))
	);
}
function validateExactMCPConfig(config: unknown): {
	config: MCPConfigFile | null;
	hasInvalidServer: boolean;
} {
	if (!isRecord(config)) return { config: null, hasInvalidServer: false };
	if (config.disabledServers !== undefined && !isStringArray(config.disabledServers)) {
		return { config: null, hasInvalidServer: false };
	}
	if (config.mcpServers === undefined) {
		return { config: config as MCPConfigFile, hasInvalidServer: false };
	}
	if (!isRecord(config.mcpServers)) return { config: null, hasInvalidServer: false };
	const validServers: Record<string, unknown> = Object.create(null);
	let hasInvalidServer = false;
	for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
		if (PROTOTYPE_SENSITIVE_SERVER_NAMES.has(name) || !isValidExactServerConfig(serverConfig)) {
			hasInvalidServer = true;
			continue;
		}
		validServers[name] = serverConfig;
	}
	return {
		config: { ...config, mcpServers: validServers } as MCPConfigFile,
		hasInvalidServer,
	};
}

/**
 * Transform raw MCP config to canonical MCPServer format.
 */
function transformMCPConfig(config: MCPConfigFile, source: SourceMeta, quiet = false): MCPServer[] {
	const servers: MCPServer[] = [];

	if (config.mcpServers) {
		for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
			// Runtime type validation for user-controlled JSON values
			let enabled: boolean | undefined;
			if (serverConfig.enabled !== undefined) {
				if (typeof serverConfig.enabled === "boolean") {
					enabled = serverConfig.enabled;
				} else if (!quiet) {
					logger.warn("MCP server has invalid 'enabled' value, ignoring", { name, value: serverConfig.enabled });
				}
			}

			let timeout: number | undefined;
			if (serverConfig.timeout !== undefined) {
				if (
					typeof serverConfig.timeout === "number" &&
					Number.isFinite(serverConfig.timeout) &&
					serverConfig.timeout > 0
				) {
					timeout = serverConfig.timeout;
				} else if (!quiet) {
					logger.warn("MCP server has invalid 'timeout' value, ignoring", { name, value: serverConfig.timeout });
				}
			}

			let autoload: boolean | undefined;
			if (serverConfig.autoload !== undefined) {
				if (typeof serverConfig.autoload === "boolean") {
					autoload = serverConfig.autoload;
				} else if (!quiet) {
					logger.warn("MCP server has invalid 'autoload' value, ignoring", { name, value: serverConfig.autoload });
				}
			}

			let noInheritEnv: boolean | undefined;
			if (serverConfig.noInheritEnv !== undefined) {
				if (typeof serverConfig.noInheritEnv === "boolean") {
					noInheritEnv = serverConfig.noInheritEnv;
				} else if (!quiet) {
					logger.warn("MCP server has invalid 'noInheritEnv' value, ignoring", {
						name,
						value: serverConfig.noInheritEnv,
					});
				}
			}

			const server: MCPServer = {
				name,
				enabled,
				autoload,
				timeout,
				command: serverConfig.command,
				args: serverConfig.args,
				env: serverConfig.env,
				noInheritEnv,
				cwd: serverConfig.cwd,
				url: serverConfig.url,
				headers: serverConfig.headers,
				auth: serverConfig.auth,
				oauth: serverConfig.oauth,
				transport: serverConfig.type,
				_source: source,
			};

			// Expand environment variables
			if (server.command) server.command = expandEnvVarsDeep(server.command);
			if (server.args) server.args = expandEnvVarsDeep(server.args);
			if (server.env) server.env = expandEnvVarsDeep(server.env);
			if (server.cwd) server.cwd = expandEnvVarsDeep(server.cwd);
			if (server.url) server.url = expandEnvVarsDeep(server.url);
			if (server.headers) server.headers = expandEnvVarsDeep(server.headers);
			if (server.auth) server.auth = expandEnvVarsDeep(server.auth);
			if (server.oauth) server.oauth = expandEnvVarsDeep(server.oauth);
			servers.push(server);
		}
	}

	return servers;
}

interface ExactMCPConfigFileState {
	dev: bigint;
	ino: bigint;
	mode: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

function exactMCPConfigFileState(stat: fs.BigIntStats): ExactMCPConfigFileState | null {
	if (stat.isSymbolicLink() || !stat.isFile()) return null;
	return {
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	};
}

async function exactMCPConfigPathState(filePath: string): Promise<ExactMCPConfigFileState | null> {
	if (!path.isAbsolute(filePath)) return null;

	const root = path.parse(filePath).root;
	const components = filePath
		.slice(root.length)
		.split(process.platform === "win32" ? /[\\/]+/ : path.sep)
		.filter(component => component.length > 0);
	if (
		root.length === 0 ||
		components.length === 0 ||
		components.some(component => component === "." || component === "..")
	) {
		return null;
	}

	let componentPath = root;
	const rootState = await fsPromises.lstat(componentPath, { bigint: true });
	if (rootState.isSymbolicLink() || !rootState.isDirectory()) return null;

	for (const [index, component] of components.entries()) {
		componentPath = path.join(componentPath, component);
		const componentState = await fsPromises.lstat(componentPath, { bigint: true });
		if (componentState.isSymbolicLink()) return null;

		if (index === components.length - 1) {
			return exactMCPConfigFileState(componentState);
		}
		if (!componentState.isDirectory()) return null;
	}

	return null;
}

function isSameExactMCPConfigFileState(expected: ExactMCPConfigFileState, actual: ExactMCPConfigFileState): boolean {
	return (
		expected.dev === actual.dev &&
		expected.ino === actual.ino &&
		expected.mode === actual.mode &&
		expected.size === actual.size &&
		expected.mtimeNs === actual.mtimeNs &&
		expected.ctimeNs === actual.ctimeNs
	);
}

// Windows does not support O_NOFOLLOW. The lstat/fstat checks below remain required there.
const EXACT_MCP_CONFIG_OPEN_FLAGS =
	fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0));

/**
 * Exact-file trust policy for quiet explicit MCP configs:
 * the supplied absolute path must contain only non-link components before and after reading;
 * the leaf must be a regular non-link file; one descriptor supplies all content; and
 * path/descriptor identity, mode, size, and modification metadata must remain unchanged throughout the read.
 */
async function readExactMCPConfigFile(filePath: string): Promise<string | null> {
	let handle: fsPromises.FileHandle | undefined;
	try {
		const initialPathState = await exactMCPConfigPathState(filePath);
		if (!initialPathState) return null;

		handle = await fsPromises.open(filePath, EXACT_MCP_CONFIG_OPEN_FLAGS);
		const openedFileState = exactMCPConfigFileState(await handle.stat({ bigint: true }));
		const beforeReadPathState = await exactMCPConfigPathState(filePath);
		if (
			!openedFileState ||
			!beforeReadPathState ||
			!isSameExactMCPConfigFileState(initialPathState, openedFileState) ||
			!isSameExactMCPConfigFileState(initialPathState, beforeReadPathState)
		) {
			return null;
		}

		const content = await handle.readFile({ encoding: "utf8" });
		const afterReadFileState = exactMCPConfigFileState(await handle.stat({ bigint: true }));
		const afterReadPathState = await exactMCPConfigPathState(filePath);
		if (
			!afterReadFileState ||
			!afterReadPathState ||
			!isSameExactMCPConfigFileState(initialPathState, afterReadFileState) ||
			!isSameExactMCPConfigFileState(initialPathState, afterReadPathState)
		) {
			return null;
		}
		return content;
	} catch {
		return null;
	} finally {
		if (handle) await handle.close().catch(() => undefined);
	}
}

/**
 * Load MCP servers from a JSON file.
 */
export async function loadMCPJsonFile(
	filePath: string,
	level: "user" | "project",
	options?: { quiet?: boolean; useCache?: boolean },
): Promise<MCPJsonLoadResult> {
	const warnings: string[] = [];
	const items: MCPServer[] = [];

	const content = options?.quiet
		? await readExactMCPConfigFile(filePath)
		: options?.useCache === false
			? await Bun.file(filePath)
					.text()
					.catch(() => null)
			: await readFile(filePath);
	if (content === null) {
		if (options?.quiet) warnings.push("MCP configuration unavailable");
		return { items, warnings, disabledServers: [] };
	}

	const config = tryParseJson<unknown>(content);
	if (!config) {
		warnings.push(options?.quiet ? "MCP configuration unavailable" : `Failed to parse JSON in ${filePath}`);
		return { items, warnings, disabledServers: [] };
	}
	let validConfig: MCPConfigFile;
	if (options?.quiet) {
		const validation = validateExactMCPConfig(config);
		if (!validation.config) {
			warnings.push("MCP configuration unavailable");
			return { items, warnings, disabledServers: [] };
		}
		if (validation.hasInvalidServer) warnings.push("MCP configuration unavailable");
		validConfig = validation.config;
	} else {
		validConfig = config as MCPConfigFile;
	}
	const source = createSourceMeta(PROVIDER_ID, filePath, level);
	items.push(...transformMCPConfig(validConfig, source, options?.quiet));

	return {
		items,
		warnings,
		disabledServers: isStringArray(validConfig.disabledServers) ? validConfig.disabledServers : [],
	};
}

/**
 * MCP JSON Provider loader.
 */
async function load(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const filenames = ["mcp.json", ".mcp.json"];
	const results = await Promise.all(
		filenames.map(filename => loadMCPJsonFile(path.join(ctx.cwd, filename), "project")),
	);

	const allItems = results.flatMap(r => r.items);
	const allWarnings = results.flatMap(r => r.warnings ?? []);

	return {
		items: allItems,
		warnings: allWarnings.length > 0 ? allWarnings : undefined,
	};
}

// Register provider
registerProvider(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from standalone mcp.json or .mcp.json in project root",
	priority: 5,
	load,
});
