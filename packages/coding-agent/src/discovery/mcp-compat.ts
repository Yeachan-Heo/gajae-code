/**
 * Bounded Claude Code / Codex MCP import-source adapters.
 *
 * These functions normalize foreign MCP formats to GJC's internal MCP contract
 * (`MCPServer`). They are EXPLICIT import sources: a caller (for example the
 * `/extensions` import transaction) reads a Claude `.mcp.json` or Codex
 * `config.toml` file and writes the normalized definitions into GJC's native
 * `.gjc` config. They are never registered as runtime discovery providers, so
 * foreign files are never implicit competing runtime authorities, and user-home
 * (`~/.claude`, `~/.codex`) configuration is never scanned.
 */
import { tryParseJson } from "@gajae-code/utils";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadResult, SourceMeta } from "../capability/types";
import { createSourceMeta, expandEnvVarsDeep } from "./helpers";

const PROVIDER_IDS = {
	claude: "claude",
	codex: "codex",
} as const;

const PROTOTYPE_SENSITIVE_SERVER_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every(item => typeof item === "string");
}

/** Result of normalizing a foreign MCP config into the internal contract. */
export interface MCPCompatNormalizeResult extends LoadResult<MCPServer> {
	/** Normalization diagnostics (always present, possibly empty). */
	warnings: string[];
	/** Path the definitions were normalized from (for provenance). */
	sourcePath: string;
}

function compatSource(providerId: string, sourcePath: string, level: "project" | "user"): SourceMeta {
	return createSourceMeta(providerId, sourcePath, level);
}

/**
 * Normalize a Claude Code `.mcp.json` file body into the internal MCP contract.
 *
 * The Claude project format uses the same `{ "mcpServers": { name: {...} } }`
 * JSON shape as GJC's config; `enabled`/`autoload` are preserved so a caller
 * can decide startup behavior after import. Bounded to the supplied content:
 * no filesystem scanning, no user-home reads.
 */
export function normalizeClaudeMcpJson(
	content: string,
	sourcePath: string,
	level: "project" | "user" = "project",
): MCPCompatNormalizeResult {
	const items: MCPServer[] = [];
	const warnings: string[] = [];
	const json = tryParseJson<Record<string, unknown>>(content);
	const mcpServers = json?.mcpServers;
	if (!json || !isRecord(mcpServers)) {
		warnings.push(`Failed to parse MCP servers in ${sourcePath}`);
		return { items, warnings, sourcePath };
	}

	// Check prototype-sensitive names on the RAW record first: env expansion
	// rebuilds the object via plain assignment, which silently drops a
	// `__proto__` own-property into the result's prototype — the check must
	// run before that transformation or it would never fire.
	const unsafeNames = Object.keys(mcpServers).filter(name => PROTOTYPE_SENSITIVE_SERVER_NAMES.has(name));
	for (const name of unsafeNames) {
		warnings.push(`Skipped unsafe MCP server name in ${sourcePath}: ${name}`);
	}
	const expanded = expandEnvVarsDeep(mcpServers);
	for (const [name, config] of Object.entries(expanded)) {
		if (PROTOTYPE_SENSITIVE_SERVER_NAMES.has(name)) {
			continue;
		}
		const serverConfig = isRecord(config) ? config : {};
		const server: MCPServer = {
			name,
			enabled: typeof serverConfig.enabled === "boolean" ? serverConfig.enabled : undefined,
			autoload: typeof serverConfig.autoload === "boolean" ? serverConfig.autoload : undefined,
			sharing:
				serverConfig.sharing === "per-session" || serverConfig.sharing === "shared"
					? serverConfig.sharing
					: undefined,
			timeout: typeof serverConfig.timeout === "number" ? serverConfig.timeout : undefined,
			command: typeof serverConfig.command === "string" ? serverConfig.command : undefined,
			args: Array.isArray(serverConfig.args)
				? serverConfig.args.filter((arg): arg is string => typeof arg === "string")
				: undefined,
			env: isStringRecord(serverConfig.env) ? serverConfig.env : undefined,
			noInheritEnv: typeof serverConfig.noInheritEnv === "boolean" ? serverConfig.noInheritEnv : undefined,
			cwd: typeof serverConfig.cwd === "string" ? serverConfig.cwd : undefined,
			url: typeof serverConfig.url === "string" ? serverConfig.url : undefined,
			headers: isStringRecord(serverConfig.headers) ? serverConfig.headers : undefined,
			transport:
				serverConfig.type === "http" || serverConfig.type === "sse" || serverConfig.type === "stdio"
					? serverConfig.type
					: undefined,
			_source: compatSource(PROVIDER_IDS.claude, sourcePath, level),
		};
		items.push(server);
	}
	return { items, warnings, sourcePath };
}

interface CodexMcpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	env_vars?: string[];
	url?: string;
	http_headers?: Record<string, string>;
	env_http_headers?: Record<string, string>;
	bearer_token_env_var?: string;
	cwd?: string;
	startup_timeout_sec?: number;
	tool_timeout_sec?: number;
}

/**
 * Extract normalized MCP servers from a Codex `config.toml` `[mcp_servers.*]`
 * section. Codex's config does not carry an `enabled` concept; imported servers
 * default to autoload (startup) behavior after import. Bounded to the supplied
 * content: no filesystem scanning, no user-home reads.
 */
function extractCodexMcpServers(toml: Record<string, unknown>): Record<string, Partial<MCPServer>> {
	if (!toml.mcp_servers || !isRecord(toml.mcp_servers)) return {};

	const codexServers = toml.mcp_servers as Record<string, CodexMcpServerConfig>;
	const result: Record<string, Partial<MCPServer>> = {};
	for (const [name, config] of Object.entries(codexServers)) {
		// `result[name] = ...` below is a plain assignment: a prototype-sensitive
		// name would mutate the result's prototype instead of becoming an item.
		if (PROTOTYPE_SENSITIVE_SERVER_NAMES.has(name)) continue;
		const serverConfig = isRecord(config) ? config : {};
		const server: Partial<MCPServer> = {
			command: typeof serverConfig.command === "string" ? serverConfig.command : undefined,
			args: Array.isArray(serverConfig.args)
				? serverConfig.args.filter((arg): arg is string => typeof arg === "string")
				: undefined,
			url: typeof serverConfig.url === "string" ? serverConfig.url : undefined,
			cwd: typeof serverConfig.cwd === "string" ? serverConfig.cwd : undefined,
		};

		const env: Record<string, string> = { ...(isStringRecord(serverConfig.env) ? serverConfig.env : {}) };
		if (Array.isArray(serverConfig.env_vars)) {
			for (const varName of serverConfig.env_vars) {
				if (typeof varName !== "string") continue;
				const value = Bun.env[varName];
				if (value !== undefined) env[varName] = value;
			}
		}
		if (Object.keys(env).length > 0) server.env = env;

		const headers: Record<string, string> = {
			...(isStringRecord(serverConfig.http_headers) ? serverConfig.http_headers : {}),
		};
		if (isRecord(serverConfig.env_http_headers)) {
			for (const [headerName, envVarName] of Object.entries(serverConfig.env_http_headers)) {
				if (typeof envVarName !== "string") continue;
				const value = Bun.env[envVarName];
				if (value !== undefined) headers[headerName] = value;
			}
		}
		if (typeof serverConfig.bearer_token_env_var === "string") {
			const token = Bun.env[serverConfig.bearer_token_env_var];
			if (token) headers.Authorization = `Bearer ${token}`;
		}
		if (Object.keys(headers).length > 0) server.headers = headers;

		if (server.url) {
			server.transport = "http";
		} else if (server.command) {
			server.transport = "stdio";
		}
		if (typeof serverConfig.tool_timeout_sec === "number" && serverConfig.tool_timeout_sec > 0) {
			server.timeout = serverConfig.tool_timeout_sec * 1000;
		}
		result[name] = server;
	}
	return result;
}

/**
 * Normalize a Codex `config.toml` file body into the internal MCP contract.
 * Only the `[mcp_servers.*]` sections are read; everything else is ignored.
 */
export function normalizeCodexMcpToml(
	content: string,
	sourcePath: string,
	level: "project" | "user" = "project",
): MCPCompatNormalizeResult {
	const items: MCPServer[] = [];
	const warnings: string[] = [];
	let parsed: Record<string, unknown>;
	try {
		parsed = Bun.TOML.parse(content) as Record<string, unknown>;
	} catch {
		warnings.push(`Failed to parse TOML in ${sourcePath}`);
		return { items, warnings, sourcePath };
	}

	// Mirror the Claude path: warn on prototype-sensitive names dropped by the
	// extractor's plain-assignment result construction.
	if (isRecord(parsed.mcp_servers)) {
		for (const name of Object.keys(parsed.mcp_servers)) {
			if (PROTOTYPE_SENSITIVE_SERVER_NAMES.has(name)) {
				warnings.push(`Skipped unsafe MCP server name in ${sourcePath}: ${name}`);
			}
		}
	}
	const servers = extractCodexMcpServers(parsed);
	for (const [name, config] of Object.entries(servers)) {
		items.push({
			name,
			...config,
			_source: compatSource(PROVIDER_IDS.codex, sourcePath, level),
		} as MCPServer);
	}
	return { items, warnings, sourcePath };
}

/**
 * Validate a normalized server against the internal MCP contract. Returns an
 * error message, or undefined when the definition is importable. Callers use
 * this to fail closed before writing a malformed/untrusted definition into
 * `.gjc` (mcpCapability.validate is reused so import and runtime share one rule).
 */
export function validateMCPCompatServer(server: MCPServer): string | undefined {
	return mcpCapability.validate?.(server);
}
