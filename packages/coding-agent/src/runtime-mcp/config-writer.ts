/**
 * MCP Configuration File Writer
 *
 * Utilities for reading/writing .gjc/mcp.json files at user or project level.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { exactReplacePath, type NativeExactFileIdentity } from "@gajae-code/natives";
import { isEnoent } from "@gajae-code/utils";
import { invalidate as invalidateFsCache } from "../capability/fs";
import { withFileLock } from "../config/file-lock";

import { validateServerConfig } from "./config";
import { readMcpBooleanField, restoreMcpBooleanField, writeMcpBooleanField } from "./policy-json-edit";
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

export interface ExactMcpBooleanUpdate {
	readonly beforeRaw?: string;
	readonly beforeIdentity?: NativeExactFileIdentity;
	readonly beforeValue?: unknown;
	readonly afterValue: boolean;
}

interface McpFileSnapshot {
	readonly raw: string;
	readonly identity: NativeExactFileIdentity;
}
async function exactSnapshot(filePath: string): Promise<McpFileSnapshot | null> {
	let handle: fs.promises.FileHandle | undefined;
	try {
		// O_NONBLOCK prevents `open()` itself from blocking forever if the
		// lexical path was raced to a FIFO between an earlier lstat and this
		// open; the immediate fstat below still rejects any non-regular file.
		handle = await fs.promises.open(
			filePath,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		const stat = await handle.stat({ bigint: true });
		const parent = await fs.promises.lstat(path.dirname(filePath), { bigint: true });
		if (!stat.isFile() || stat.nlink !== 1n || parent.isSymbolicLink() || !parent.isDirectory())
			throw new Error("MCP config is not an owned regular file");
		const limit = 1024 * 1024;
		if (stat.size > BigInt(limit)) throw new Error("MCP config size limit");
		const bytes = new Uint8Array(limit + 1);
		let length = 0;
		while (length < bytes.length) {
			const next = await handle.read(bytes, length, bytes.length - length, length);
			if (next.bytesRead === 0) break;
			length += next.bytesRead;
		}
		if (length > limit) throw new Error("MCP config size limit");
		const after = await handle.stat({ bigint: true });
		const lexical = await fs.promises.lstat(filePath, { bigint: true });
		const parentAfter = await fs.promises.lstat(path.dirname(filePath), { bigint: true });
		if (
			after.dev !== stat.dev ||
			after.ino !== stat.ino ||
			after.mtimeNs !== stat.mtimeNs ||
			after.ctimeNs !== stat.ctimeNs ||
			after.size !== stat.size ||
			after.nlink !== 1n ||
			lexical.isSymbolicLink() ||
			lexical.dev !== after.dev ||
			lexical.ino !== after.ino ||
			lexical.mtimeNs !== after.mtimeNs ||
			lexical.ctimeNs !== after.ctimeNs ||
			parentAfter.isSymbolicLink() ||
			parentAfter.dev !== parent.dev ||
			parentAfter.ino !== parent.ino
		)
			throw new Error("MCP config identity changed while reading");
		const contents = bytes.subarray(0, length);
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			parentDev: parent.dev,
			parentIno: parent.ino,
			sha256: crypto.createHash("sha256").update(contents).digest("hex"),
		};
		return { raw: new TextDecoder("utf-8", { fatal: true }).decode(contents), identity };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		throw error;
	} finally {
		await handle?.close();
	}
}

async function exactIdentity(filePath: string): Promise<NativeExactFileIdentity | null> {
	return (await exactSnapshot(filePath))?.identity ?? null;
}

/** Exact-field JSON CAS used by doctor; server names are object keys and may contain dots. */
export async function updateMCPBooleanExact(
	filePath: string,
	name: string,
	field: "autoload" | "enabled",
	value: boolean,
	expected: { readonly raw: string; readonly identity: NativeExactFileIdentity },
): Promise<{ beforeValue: unknown; afterValue: boolean; changed: boolean; afterIdentity?: NativeExactFileIdentity }> {
	return await withFileLock(filePath, async () => {
		const snapshot = await exactSnapshot(filePath);
		const raw = snapshot?.raw;
		const identity = snapshot?.identity;
		if (
			!identity ||
			raw !== expected.raw ||
			identity.dev !== expected.identity.dev ||
			identity.ino !== expected.identity.ino ||
			identity.size !== expected.identity.size ||
			identity.mtimeNs !== expected.identity.mtimeNs ||
			identity.parentDev !== expected.identity.parentDev ||
			identity.parentIno !== expected.identity.parentIno ||
			identity.sha256 !== expected.identity.sha256
		)
			throw new Error("MCP config compare-and-swap conflict");
		const edit = writeMcpBooleanField(raw, name, field, value);
		if (edit.status === "not_found") throw new Error("MCP server not found");
		if (edit.status === "duplicate_key") throw new Error(`MCP config has a duplicate key at ${edit.path}`);
		if (edit.status === "malformed") throw new Error("MCP config is not valid JSON");
		const beforeValue = edit.beforeValue;
		if (beforeValue === value) return { beforeValue, afterValue: value, changed: false };
		const tmpPath = `${filePath}.doctor-${crypto.randomUUID()}.tmp`;
		const handle = await fs.promises.open(
			tmpPath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.writeFile(edit.text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		const source = await exactIdentity(tmpPath);
		if (!source) throw new Error("MCP config identity unavailable");
		const replaced = exactReplacePath(tmpPath, filePath, source, expected.identity);
		if (!replaced.ok) throw new Error(`MCP config replacement failed: ${replaced.code ?? "unknown"}`);
		const parentHandle = await fs.promises.open(path.dirname(filePath), "r");
		try {
			await parentHandle.sync();
		} finally {
			await parentHandle.close();
		}
		return {
			beforeValue,
			afterValue: value,
			changed: true,
			afterIdentity: (await exactIdentity(filePath)) ?? undefined,
		};
	});
}

export type RestoreMCPBooleanResult =
	| { readonly status: "restored" }
	| { readonly status: "conflict" }
	| { readonly status: "failed"; readonly reason: string };

/**
 * Roll back exactly one `mcpServers.<name>.<field>` token to its captured
 * `value` (which may be `undefined` to restore an originally-absent field, or
 * an originally-invalid non-boolean scalar). Binds to the PUBLISHED file's
 * dev/ino/parent identity captured right after the mutating replace — not the
 * pre-mutation identity — and to the field's known current (post-mutation)
 * value, so an unrelated in-place sibling edit made after publication is
 * preserved rather than reverted by a stale whole-file snapshot. A CAS
 * precondition mismatch (identity or field drifted) is a `conflict`; any
 * other unexpected error is reported as `failed` and must never be silently
 * folded into `conflict`, since only `conflict` means "an independent editor
 * already resolved this and no action is required".
 */
export async function restoreMCPBooleanExact(
	filePath: string,
	name: string,
	field: "autoload" | "enabled",
	originalRaw: string,
	expected: { readonly identity: NativeExactFileIdentity; readonly currentValue: boolean },
): Promise<RestoreMCPBooleanResult> {
	return await withFileLock(filePath, async () => {
		let current: McpFileSnapshot | null;
		try {
			current = await exactSnapshot(filePath);
		} catch {
			return { status: "failed", reason: "restore_snapshot_failed" };
		}
		if (
			!current ||
			current.identity.dev !== expected.identity.dev ||
			current.identity.ino !== expected.identity.ino ||
			current.identity.parentDev !== expected.identity.parentDev ||
			current.identity.parentIno !== expected.identity.parentIno
		)
			return { status: "conflict" };
		const read = readMcpBooleanField(current.raw, name, field);
		if (read.status === "duplicate_key") return { status: "failed", reason: `duplicate key at ${read.path}` };
		if (read.status === "malformed") return { status: "failed", reason: "MCP config is not valid JSON" };
		if (read.status === "not_found" || read.value !== expected.currentValue) return { status: "conflict" };
		const edit = restoreMcpBooleanField(current.raw, originalRaw, name, field);
		if (edit.status !== "ok") return { status: "failed", reason: edit.status };
		const tmpPath = `${filePath}.doctor-restore-${crypto.randomUUID()}.tmp`;
		const restoreHandle = await fs.promises.open(
			tmpPath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await restoreHandle.writeFile(edit.text, "utf8");
			await restoreHandle.sync();
		} finally {
			await restoreHandle.close();
		}
		const source = await exactIdentity(tmpPath);
		if (!source) return { status: "failed", reason: "restore identity unavailable" };
		const replaced = exactReplacePath(tmpPath, filePath, source, current.identity);
		if (!replaced.ok) return { status: "failed", reason: "restore_publication_unverified" };
		const verified = await exactSnapshot(filePath);
		if (!verified) return { status: "failed", reason: "post-restore verification unavailable" };
		if (
			verified.raw !== edit.text ||
			verified.identity.dev !== source.dev ||
			verified.identity.ino !== source.ino ||
			verified.identity.parentDev !== source.parentDev ||
			verified.identity.parentIno !== source.parentIno
		)
			return { status: "failed", reason: "post_restore_identity_mismatch" };
		const parentHandle = await fs.promises.open(path.dirname(filePath), "r");
		try {
			await parentHandle.sync();
		} finally {
			await parentHandle.close();
		}
		return { status: "restored" };
	});
}
