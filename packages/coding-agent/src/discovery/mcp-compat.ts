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
	/** List of env-var names, or `{ name }` entries. Not a value table. */
	env_vars?: unknown;
	url?: string;
	http_headers?: Record<string, string>;
	/** Header name to env-var name. Not a header value. */
	env_http_headers?: unknown;
	/** Env-var name whose value is the bearer token. Not the token. */
	bearer_token_env_var?: unknown;
	cwd?: string;
	startup_timeout_sec?: number;
	tool_timeout_sec?: number;
}

/** POSIX env-var name. Rejects values that are not names so they are not stored. */
function isEnvVarName(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** `${NAME}` keeps the indirection. Callers must not read the process environment. */
function envVarReference(name: string): string {
	return `\${${name}}`;
}

function codexEnvVarEntry(entry: unknown): { name: string; source: string | undefined } | undefined {
	if (typeof entry === "string") return isEnvVarName(entry) ? { name: entry, source: undefined } : undefined;
	if (isRecord(entry) && typeof entry.name === "string" && isEnvVarName(entry.name)) {
		return { name: entry.name, source: typeof entry.source === "string" ? entry.source : undefined };
	}
	return undefined;
}

/** Codex remote-executor sources have no local GJC equivalent. */
function isUnsupportedEnvSource(source: string | undefined): boolean {
	return source !== undefined && source !== "local";
}

/**
 * Extract normalized MCP servers from a Codex `config.toml` `[mcp_servers.*]`
 * section. Codex's config does not carry an `enabled` concept; imported servers
 * default to autoload (startup) behavior after import. Bounded to the supplied
 * content: no filesystem scanning, no user-home reads.
 *
 * `env_vars`, `env_http_headers`, and `bearer_token_env_var` name variables.
 * The process environment is not read. A local name is stored as `${NAME}`
 * only when the destination keeps operator config. A project destination omits
 * the reference: project mcp.json is expanded on a later run, and a name such
 * as `CI_JOB_JWT_V2` is not treated as sensitive, so persisting it would
 * forward a host value. The source level is metadata and does not decide this.
 * A static `env` or `http_headers` value is copied. An entry whose source is
 * not `local` is skipped.
 */
function extractCodexMcpServers(
	toml: Record<string, unknown>,
	warnings: string[],
	sourcePath: string,
	omitEnvReferences: boolean,
): Record<string, Partial<MCPServer>> {
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
		if (serverConfig.env_vars !== undefined && !Array.isArray(serverConfig.env_vars)) {
			warnings.push(
				`skipped env_vars for "${name}" in ${sourcePath} because it is not a list of environment variable names`,
			);
		} else if (Array.isArray(serverConfig.env_vars)) {
			for (const entry of serverConfig.env_vars) {
				const parsed = codexEnvVarEntry(entry);
				if (!parsed) {
					warnings.push(
						`skipped env_vars entry for "${name}" in ${sourcePath} because it is not an environment variable name`,
					);
					continue;
				}
				if (isUnsupportedEnvSource(parsed.source)) {
					warnings.push(
						`skipped env_vars entry ${parsed.name} for "${name}" in ${sourcePath} because source "${parsed.source}" is not executed locally`,
					);
					continue;
				}
				if (Object.hasOwn(env, parsed.name)) {
					warnings.push(
						`kept static env ${parsed.name} for "${name}" in ${sourcePath} and did not read the environment`,
					);
					continue;
				}
				if (omitEnvReferences) {
					warnings.push(
						`skipped project-scope environment reference ${parsed.name} for "${name}" in ${sourcePath} so a later load cannot expand a host value`,
					);
					continue;
				}
				env[parsed.name] = envVarReference(parsed.name);
			}
		}
		if (Object.keys(env).length > 0) server.env = env;

		const headers: Record<string, string> = {
			...(isStringRecord(serverConfig.http_headers) ? serverConfig.http_headers : {}),
		};
		if (serverConfig.env_http_headers !== undefined && !isRecord(serverConfig.env_http_headers)) {
			warnings.push(
				`skipped env_http_headers for "${name}" in ${sourcePath} because it is not a table of environment variable names`,
			);
		} else if (isRecord(serverConfig.env_http_headers)) {
			for (const [headerName, envVarName] of Object.entries(serverConfig.env_http_headers)) {
				if (typeof envVarName !== "string" || !isEnvVarName(envVarName)) {
					warnings.push(
						`skipped env_http_headers entry for "${name}" in ${sourcePath} because its value is not an environment variable name`,
					);
					continue;
				}
				if (Object.hasOwn(headers, headerName)) {
					warnings.push(
						`kept static header ${headerName} for "${name}" in ${sourcePath} and did not read ${envVarName}`,
					);
					continue;
				}
				if (omitEnvReferences) {
					warnings.push(
						`skipped project-scope environment reference ${envVarName} for "${name}" in ${sourcePath} so a later load cannot expand a host value`,
					);
					continue;
				}
				headers[headerName] = envVarReference(envVarName);
			}
		}
		if (serverConfig.bearer_token_env_var !== undefined) {
			const bearerName = serverConfig.bearer_token_env_var;
			if (typeof bearerName !== "string" || !isEnvVarName(bearerName)) {
				warnings.push(
					`skipped bearer_token_env_var for "${name}" in ${sourcePath} because it is not an environment variable name`,
				);
			} else if (Object.hasOwn(headers, "Authorization")) {
				warnings.push(
					`kept static Authorization for "${name}" in ${sourcePath} and did not read bearer_token_env_var ${bearerName}`,
				);
			} else if (omitEnvReferences) {
				warnings.push(
					`skipped project-scope environment reference ${bearerName} for "${name}" in ${sourcePath} so a later load cannot expand a host value`,
				);
			} else {
				headers.Authorization = `Bearer ${envVarReference(bearerName)}`;
			}
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
	options?: { omitEnvReferences?: boolean },
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
	const omitEnvReferences = options?.omitEnvReferences ?? level === "project";
	const servers = extractCodexMcpServers(parsed, warnings, sourcePath, omitEnvReferences);
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
