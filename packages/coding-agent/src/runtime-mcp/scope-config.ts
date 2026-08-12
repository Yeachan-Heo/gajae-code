/**
 * Scope-aware MCP configuration access.
 *
 * Canonical read/write contract for GJC's native MCP config in both scopes —
 * project `<project>/.gjc/mcp.json` and global `~/.gjc/agent/mcp.json`.
 * These wrappers resolve the scope to its file path, reuse the atomic config
 * writer, and return provenance (scope + path) with every read so callers can
 * show source and status without re-deriving path rules. Secret values are
 * never printed by these APIs; the CLI applies its existing redaction layer on
 * top of returned configs.
 */
import { getMCPConfigPath, getProjectDir } from "@gajae-code/utils";
import {
	getMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	type UpsertMCPServerResult,
	upsertMCPServer,
} from "./config-writer";
import type { MCPConfigFile, MCPServerConfig } from "./types";

export type MCPConfigScope = "user" | "project";

/** Resolved scope + path + parsed config (provenance for diagnostics). */
export interface ScopeMCPConfigSnapshot {
	scope: MCPConfigScope;
	path: string;
	config: MCPConfigFile;
}

/** Resolve the canonical file path for a native MCP config scope. */
export function resolveScopeMCPConfigPath(scope: MCPConfigScope, cwd: string = getProjectDir()): string {
	return getMCPConfigPath(scope, cwd);
}

/** Read a native MCP config for a scope. Returns an empty config when absent. */
export async function readScopeMCPConfig(scope: MCPConfigScope, cwd?: string): Promise<ScopeMCPConfigSnapshot> {
	const path = resolveScopeMCPConfigPath(scope, cwd);
	return { scope, path, config: await readMCPConfigFile(path) };
}
/** Add a server, or overwrite an existing one only when `force` is set. */
export async function upsertScopeMCPServer(
	scope: MCPConfigScope,
	name: string,
	config: MCPServerConfig,
	options: { force?: boolean } = {},
	cwd?: string,
): Promise<ScopeMCPConfigSnapshot & { result: UpsertMCPServerResult }> {
	const path = resolveScopeMCPConfigPath(scope, cwd);
	const result = await upsertMCPServer(path, name, config, options);
	return { scope, path, config: await readMCPConfigFile(path), result };
}

/** Remove a server from a scope (throws when the name does not exist). */
export async function removeScopeMCPServer(
	scope: MCPConfigScope,
	name: string,
	cwd?: string,
): Promise<ScopeMCPConfigSnapshot> {
	const path = resolveScopeMCPConfigPath(scope, cwd);
	await removeMCPServer(path, name);
	return { scope, path, config: await readMCPConfigFile(path) };
}

/** Get a specific server config from a scope. */
export async function getScopeMCPServer(
	scope: MCPConfigScope,
	name: string,
	cwd?: string,
): Promise<{ scope: MCPConfigScope; path: string; config: MCPServerConfig | undefined }> {
	const path = resolveScopeMCPConfigPath(scope, cwd);
	return { scope, path, config: await getMCPServer(path, name) };
}
/** Read the disabled-servers denylist for a scope. */
export async function readScopeDisabledServers(scope: MCPConfigScope, cwd?: string): Promise<string[]> {
	return readDisabledServers(resolveScopeMCPConfigPath(scope, cwd));
}
