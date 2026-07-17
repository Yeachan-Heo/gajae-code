/**
 * MCP Configuration File Writer
 *
 * Utilities for reading/writing .gjc/mcp.json files at user or project level.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { invalidate as invalidateFsCache } from "../capability/fs";

import { validateServerConfig } from "./config";
import { MCP_CONFIG_SCHEMA_URL, type MCPConfigFile, type MCPServerConfig } from "./types";

function withSchema(config: MCPConfigFile): MCPConfigFile {
	return {
		$schema: config.$schema ?? MCP_CONFIG_SCHEMA_URL,
		...config,
	};
}

/**
 * Read an MCP config file.
 * Returns empty config if file doesn't exist.
 */
export async function readMCPConfigFile(filePath: string): Promise<MCPConfigFile> {
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as MCPConfigFile;
		return parsed;
	} catch (error) {
		if (isEnoent(error)) {
			// File doesn't exist, return empty config
			return { mcpServers: {} };
		}
		throw error;
	}
}

/**
 * Write an MCP config file atomically.
 * Creates parent directories if they don't exist.
 */
export async function writeMCPConfigFile(filePath: string, config: MCPConfigFile): Promise<void> {
	// Ensure parent directory exists
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	// Write to temp file first (atomic write)
	const tmpPath = `${filePath}.tmp`;
	const content = JSON.stringify(withSchema(config), null, 2);
	await fs.promises.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });

	// Rename to final path (atomic on most systems)
	await fs.promises.rename(tmpPath, filePath);
	// Invalidate the capability fs cache so subsequent reads see the new content
	invalidateFsCache(filePath);
}

/**
 * Validate server name.
 * @returns Error message if invalid, undefined if valid
 */
export function validateServerName(name: string): string | undefined {
	if (!name) {
		return "Server name cannot be empty";
	}
	if (name.length > 100) {
		return "Server name is too long (max 100 characters)";
	}
	// Check for invalid characters (only allow alphanumeric, dash, underscore, dot)
	if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
		return "Server name can only contain letters, numbers, dash, underscore, and dot";
	}
	return undefined;
}

/**
 * Add an MCP server to a config file.
 * Validates the config before writing.
 *
 * @throws Error if server name already exists or validation fails
 */
export async function addMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	// Validate server name
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// Validate the config
	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Invalid server config: ${errors.join("; ")}`);
	}

	// Read existing config
	const existing = await readMCPConfigFile(filePath);

	// Check for duplicate name
	if (existing.mcpServers?.[name]) {
		throw new Error(`Server "${name}" already exists in ${filePath}`);
	}

	// Add server
	const updated: MCPConfigFile = {
		...existing,
		mcpServers: {
			...existing.mcpServers,
			[name]: config,
		},
	};

	// Write back
	await writeMCPConfigFile(filePath, updated);
}

/**
 * Update an existing MCP server in a config file.
 * If the server doesn't exist, this will add it.
 *
 * @throws Error if validation fails
 */
export async function updateMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	// Validate server name
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// Validate the config
	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Invalid server config: ${errors.join("; ")}`);
	}

	// Read existing config
	const existing = await readMCPConfigFile(filePath);

	// Update server
	const updated: MCPConfigFile = {
		...existing,
		mcpServers: {
			...existing.mcpServers,
			[name]: config,
		},
	};

	// Write back
	await writeMCPConfigFile(filePath, updated);
}

/**
 * Result of an {@link upsertMCPServer} call.
 * - `added`: server did not exist and was written.
 * - `updated`: server existed and was overwritten because `force` was set.
 * - `skipped`: server existed and `force` was not set, so nothing was written.
 */
export type UpsertMCPServerResult =
	| { status: "added" }
	| { status: "updated" }
	| { status: "skipped"; reason: "exists" };

/**
 * Add an MCP server, or overwrite an existing one only when `force` is set.
 *
 * Collision-aware wrapper over {@link addMCPServer} / {@link updateMCPServer} used by
 * `gjc migrate`. Never connects to the server. Reuses the underlying writers so the
 * rest of the config file (including `disabledServers`) is preserved on update.
 *
 * @throws Error if the server name or config is invalid (validated before any write).
 */
export async function upsertMCPServer(
	filePath: string,
	name: string,
	config: MCPServerConfig,
	options: { force?: boolean } = {},
): Promise<UpsertMCPServerResult> {
	// Validate name up front so an invalid name fails regardless of collision state.
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	const existing = await getMCPServer(filePath, name);
	if (existing) {
		if (!options.force) {
			return { status: "skipped", reason: "exists" };
		}
		// updateMCPServer preserves the rest of MCPConfigFile, incl. disabledServers.
		await updateMCPServer(filePath, name, config);
		return { status: "updated" };
	}

	await addMCPServer(filePath, name, config);
	return { status: "added" };
}

/**
 * Remove an MCP server from a config file.
 *
 * @throws Error if server doesn't exist
 */
export async function removeMCPServer(filePath: string, name: string): Promise<void> {
	// Read existing config
	const existing = await readMCPConfigFile(filePath);

	// Check if server exists
	if (!existing.mcpServers?.[name]) {
		throw new Error(`Server "${name}" not found in ${filePath}`);
	}

	// Remove server
	const { [name]: _removed, ...remaining } = existing.mcpServers;
	const updated: MCPConfigFile = {
		...existing,
		mcpServers: remaining,
	};

	// Write back
	await writeMCPConfigFile(filePath, updated);
}

/**
 * Get a specific server config from a file.
 * Returns undefined if server doesn't exist.
 */
export async function getMCPServer(filePath: string, name: string): Promise<MCPServerConfig | undefined> {
	const config = await readMCPConfigFile(filePath);
	return config.mcpServers?.[name];
}

/**
 * List all server names in a config file.
 */
export async function listMCPServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Object.keys(config.mcpServers ?? {});
}

/**
 * Set a server's autoload flag for explicit runtime MCP consumers.
 *
 * Autoload defaults to true for consumers that honor it, so turning it on
 * removes the key to keep the config file free of redundant fields; turning it
 * off writes `autoload: false`.
 *
 * @throws Error if the server doesn't exist
 */
export async function setServerAutoload(filePath: string, name: string, autoload: boolean): Promise<void> {
	const existing = await readMCPConfigFile(filePath);
	const server = existing.mcpServers?.[name];
	if (!server) {
		throw new Error(`Server "${name}" not found in ${filePath}`);
	}

	const { autoload: _removed, ...rest } = server;
	const updatedServer = (autoload ? rest : { ...rest, autoload: false }) as MCPServerConfig;
	const updated: MCPConfigFile = {
		...existing,
		mcpServers: {
			...existing.mcpServers,
			[name]: updatedServer,
		},
	};

	await writeMCPConfigFile(filePath, updated);
}

/**
 * Read the disabled servers list from a config file.
 */
export async function readDisabledServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Array.isArray(config.disabledServers) ? config.disabledServers : [];
}

/**
 * Add or remove a server name from the disabled servers list.
 */
export async function setServerDisabled(filePath: string, name: string, disabled: boolean): Promise<void> {
	const config = await readMCPConfigFile(filePath);
	const current = new Set(config.disabledServers ?? []);

	if (disabled) {
		current.add(name);
	} else {
		current.delete(name);
	}

	const updated: MCPConfigFile = {
		...config,
		disabledServers: current.size > 0 ? Array.from(current).sort() : undefined,
	};

	if (!updated.disabledServers) {
		delete updated.disabledServers;
	}

	await writeMCPConfigFile(filePath, updated);
}
