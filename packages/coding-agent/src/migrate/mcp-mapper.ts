/**
 * Map raw source MCP server entries onto GJC `MCPServerConfig`.
 *
 * Implements the source-schema compatibility matrix from the consensus plan:
 * preserved (P), transformed (T), omitted-with-warning (OW), skipped (S,
 * `skipped_unmappable`), and failed (F, `failed_invalid_source`). Secret-indirection
 * fields are always omitted-with-warning; their values are never read or emitted.
 */
import type { MCPServerConfig } from "../runtime-mcp/types";
import type { MigrateSource } from "./types";

export type McpMapOutcome =
	| { ok: true; config: MCPServerConfig; warnings: string[] }
	| { ok: false; status: "skipped_unmappable" | "failed_invalid_source"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined | "invalid" {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every(v => typeof v === "string")) return "invalid";
	return value as string[];
}

function asStringRecord(value: unknown): Record<string, string> | undefined | "invalid" {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !Object.values(value).every(v => typeof v === "string")) return "invalid";
	return value as Record<string, string>;
}

/** Secret-indirection fields per source: always omitted-with-warning, never read. */
const SECRET_INDIRECTION_FIELDS: Record<MigrateSource, string[]> = {
	"claude-code": [],
	codex: ["env_vars", "env_http_headers", "bearer_token_env_var"],
	opencode: [],
};

/** Fields recognized for a source (handled or intentionally omitted). Anything else is omitted-with-warning. */
const RECOGNIZED_FIELDS: Record<MigrateSource, ReadonlySet<string>> = {
	"claude-code": new Set(["type", "command", "args", "env", "url", "headers", "enabled", "timeout", "cwd", "protocol"]),
	codex: new Set([
		"type",
		"command",
		"args",
		"env",
		"url",
		"http_headers",
		"cwd",
		"enabled",
		"timeout",
		"tool_timeout_sec",
		"protocol",
		// omitted-with-warning fields are still "recognized" (handled below):
		"env_vars",
		"env_http_headers",
		"bearer_token_env_var",
		"startup_timeout_sec",
		"enabled_tools",
		"disabled_tools",
	]),
	opencode: new Set(["type", "command", "args", "env", "url", "headers", "enabled", "timeout", "cwd", "protocol"]),
};

/** Fields with no GJC equivalent: omitted-with-warning (named explicitly so the warning is precise). */
const OMITTED_FIELDS: Record<MigrateSource, string[]> = {
	"claude-code": [],
	codex: ["startup_timeout_sec", "enabled_tools", "disabled_tools"],
	opencode: [],
};

export function mapMcpEntry(source: MigrateSource, name: string, raw: unknown): McpMapOutcome {
	if (!isRecord(raw)) {
		return { ok: false, status: "failed_invalid_source", reason: `server "${name}" is not an object` };
	}

	const warnings: string[] = [];
	for (const field of SECRET_INDIRECTION_FIELDS[source]) {
		if (field in raw) warnings.push(`omitted secret-indirection field "${field}" for "${name}" (value not read)`);
	}
	for (const field of OMITTED_FIELDS[source]) {
		if (field in raw) warnings.push(`omitted unsupported field "${field}" for "${name}"`);
	}
	// Unknown/unrecognized fields: omit-with-warning (never copy their values).
	for (const field of Object.keys(raw)) {
		if (!RECOGNIZED_FIELDS[source].has(field)) {
			warnings.push(`omitted unknown field "${field}" for "${name}"`);
		}
	}

	const rawType = typeof raw.type === "string" ? raw.type : undefined;
	const command = typeof raw.command === "string" ? raw.command : undefined;
	const url = typeof raw.url === "string" ? raw.url : undefined;

	const base: { enabled?: boolean; timeout?: number } = {};
	// Preserve only a representable protocol preference (http/sse only); anything
	// else falls back to the safe-negotiation default (`auto`) with a warning.
	let protocol: "auto" | "2026-07-28" | "legacy" | undefined;
	if (raw.protocol !== undefined) {
		if (raw.protocol === "auto" || raw.protocol === "2026-07-28" || raw.protocol === "legacy") {
			protocol = raw.protocol;
		} else {
			warnings.push(`omitted unsupported protocol value for "${name}" (defaulting to safe negotiation)`);
		}
	}
	if (typeof raw.enabled === "boolean") base.enabled = raw.enabled;
	if (typeof raw.timeout === "number") base.timeout = raw.timeout;
	// Codex tool_timeout_sec -> timeout (ms).
	if (source === "codex" && typeof raw.tool_timeout_sec === "number") {
		base.timeout = raw.tool_timeout_sec * 1000;
	}

	const wantsStdio =
		source === "opencode" ? rawType === "local" || (!rawType && !!command) : !!command || rawType === "stdio";
	const wantsHttp =
		source === "opencode"
			? rawType === "remote" || rawType === "sse"
			: rawType === "http" || rawType === "sse" || (!command && !!url);

	if (wantsStdio) {
		if (!command) {
			return {
				ok: false,
				status: "skipped_unmappable",
				reason: `server "${name}" has no command for stdio transport`,
			};
		}
		const args = asStringArray(raw.args);
		if (args === "invalid") {
			return { ok: false, status: "failed_invalid_source", reason: `server "${name}" has invalid "args"` };
		}
		const env = asStringRecord(raw.env);
		if (env === "invalid") {
			return { ok: false, status: "failed_invalid_source", reason: `server "${name}" has invalid "env"` };
		}
		const config: MCPServerConfig = { type: "stdio", command, ...base };
		if (args) config.args = args;
		if (env) config.env = env;
		if (typeof raw.cwd === "string") config.cwd = raw.cwd;
		return { ok: true, config, warnings };
	}

	if (wantsHttp) {
		if (!url) {
			return {
				ok: false,
				status: "skipped_unmappable",
				reason: `server "${name}" has no url for http/sse transport`,
			};
		}
		const headerSource = source === "codex" ? raw.http_headers : raw.headers;
		const headers = asStringRecord(headerSource);
		if (headers === "invalid") {
			return { ok: false, status: "failed_invalid_source", reason: `server "${name}" has invalid headers` };
		}
		const type = rawType === "sse" ? "sse" : "http";
		const config = { type, url, ...base } as MCPServerConfig;
		if (headers) (config as { headers?: Record<string, string> }).headers = headers;
		if (protocol) (config as { protocol?: "auto" | "2026-07-28" | "legacy" }).protocol = protocol;
		return { ok: true, config, warnings };
	}

	return { ok: false, status: "skipped_unmappable", reason: `server "${name}" has neither a usable command nor url` };
}
