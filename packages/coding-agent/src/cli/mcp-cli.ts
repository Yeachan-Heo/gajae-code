/**
 * Direct MCP server registration CLI helpers.
 *
 * This surface only writes explicit user-provided server definitions to GJC's
 * own MCP config. It never imports or inherits live configs from other agents.
 */
import { getMCPConfigPath, getProjectDir } from "@gajae-code/utils";
import { getMCPServer, readMCPConfigFile, removeMCPServer, upsertMCPServer } from "../runtime-mcp/config-writer";
import { redactMCPEndpoint } from "../runtime-mcp/redaction";
import type { MCPConfigFile, MCPServerConfig } from "../runtime-mcp/types";

export type MCPAction = "add" | "list" | "remove";

export interface MCPCommandArgs {
	action: MCPAction;
	name?: string;
	commandArgs?: string[];
	flags: {
		project?: boolean;
		force?: boolean;
		json?: boolean;
		type?: "stdio" | "http" | "sse";
		command?: string;
		url?: string;
		arg?: string[];
		env?: string[];
		header?: string[];
		cwd?: string;
		timeout?: number;
	};
	cwd?: string;
}

export class MCPArgsError extends Error {}

interface ScopedPath {
	scope: "user" | "project";
	path: string;
}

interface RuntimeDisclosure {
	runtimeStatus: "storage-only";
	runtimeLoadedByStandalone: false;
	runtimeNote: string;
}

interface RedactedServerEntry {
	name: string;
	config: MCPServerConfig;
}

interface RuntimeRedactedServerEntry extends RedactedServerEntry, RuntimeDisclosure {}

const REDACTED = "<redacted>";
const SENSITIVE_KEY_PATTERN =
	/(?:token|secret|key|credential|password|passwd|pwd|authorization|auth|bearer|cookie|session)/i;
const STORAGE_ONLY_RUNTIME_DISCLOSURE: RuntimeDisclosure = {
	runtimeStatus: "storage-only",
	runtimeLoadedByStandalone: false,
	runtimeNote: "Stored MCP registrations are not loaded by normal standalone gjc sessions today.",
};

function resolvePath(args: MCPCommandArgs): ScopedPath {
	const scope = args.flags.project ? "project" : "user";
	return { scope, path: getMCPConfigPath(scope, args.cwd ?? getProjectDir()) };
}

function parsePairs(values: string[] | undefined, label: string): Record<string, string> | undefined {
	if (!values || values.length === 0) return undefined;
	const parsed: Record<string, string> = {};
	for (const value of values) {
		const index = value.indexOf("=");
		if (index <= 0) {
			throw new MCPArgsError(`Invalid ${label}. Use KEY=VALUE.`);
		}
		const key = value.slice(0, index).trim();
		if (!key) {
			throw new MCPArgsError(`Invalid ${label}. Key cannot be empty.`);
		}
		parsed[key] = value.slice(index + 1);
	}
	return parsed;
}

function buildServerConfig(args: MCPCommandArgs): MCPServerConfig {
	const type = args.flags.type ?? (args.flags.url ? "http" : "stdio");
	const timeout = args.flags.timeout;
	const shared = timeout === undefined ? {} : { timeout };

	if (type === "stdio") {
		const command = args.flags.command ?? args.commandArgs?.[0];
		if (!command) {
			throw new MCPArgsError("`gjc mcp add` requires --command <cmd> or a positional command for stdio servers.");
		}
		const config: MCPServerConfig = {
			...shared,
			type: "stdio",
			command,
		};
		const positionalArgs = args.flags.command ? [] : (args.commandArgs ?? []).slice(1);
		const serverArgs = [...positionalArgs, ...(args.flags.arg ?? [])];
		if (serverArgs.length > 0) config.args = serverArgs;
		const env = parsePairs(args.flags.env, "env");
		if (env) config.env = env;
		if (args.flags.cwd) config.cwd = args.flags.cwd;
		return config;
	}

	const url = args.flags.url ?? args.commandArgs?.[0];
	if (!url) {
		throw new MCPArgsError(`\`gjc mcp add --type ${type}\` requires --url <url> or a positional URL.`);
	}
	const headers = parsePairs(args.flags.header, "header");
	if (type === "http") {
		const config: MCPServerConfig = {
			...shared,
			type,
			url,
		};
		if (headers) config.headers = headers;
		return config;
	}
	const config: MCPServerConfig = {
		...shared,
		type,
		url,
	};
	if (headers) config.headers = headers;
	return config;
}

function redactRecord(
	record: Record<string, string> | undefined,
	redactAllValues: boolean,
): Record<string, string> | undefined {
	if (!record) return undefined;
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [
			key,
			redactAllValues || SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : value,
		]),
	);
}

function redactArgs(args: string[] | undefined): string[] | undefined {
	if (!args) return undefined;
	const redacted: string[] = [];
	let redactNext = false;
	for (const arg of args) {
		if (redactNext) {
			redacted.push(REDACTED);
			redactNext = false;
			continue;
		}
		const equalsIndex = arg.indexOf("=");
		if (equalsIndex > 0) {
			const key = arg.slice(0, equalsIndex);
			redacted.push(SENSITIVE_KEY_PATTERN.test(key) ? `${key}=${REDACTED}` : arg);
			continue;
		}
		if (arg.startsWith("-") && SENSITIVE_KEY_PATTERN.test(arg)) {
			redacted.push(arg);
			redactNext = true;
			continue;
		}
		redacted.push(SENSITIVE_KEY_PATTERN.test(arg) ? REDACTED : arg);
	}
	return redacted;
}

export function redactMCPServerConfig(config: MCPServerConfig): MCPServerConfig {
	const redacted = { ...config } as MCPServerConfig;
	if ("env" in redacted) {
		const env = redactRecord(redacted.env, true);
		if (env) redacted.env = env;
	}
	if ("headers" in redacted) {
		const headers = redactRecord(redacted.headers, true);
		if (headers) redacted.headers = headers;
	}
	if ("url" in redacted) {
		const url = redactMCPEndpoint(redacted.url);
		if (url) redacted.url = url;
	}
	if ("args" in redacted) {
		const args = redactArgs(redacted.args);
		if (args) redacted.args = args;
	}
	if (redacted.auth) {
		redacted.auth = {
			type: redacted.auth.type,
			credentialId: redacted.auth.credentialId ? REDACTED : undefined,
			tokenUrl: redactMCPEndpoint(redacted.auth.tokenUrl),
			clientId: redacted.auth.clientId ? REDACTED : undefined,
			clientSecret: redacted.auth.clientSecret ? REDACTED : undefined,
		};
	}
	if (redacted.oauth) {
		redacted.oauth = {
			clientId: redacted.oauth.clientId ? REDACTED : undefined,
			clientSecret: redacted.oauth.clientSecret ? REDACTED : undefined,
			redirectUri: redactMCPEndpoint(redacted.oauth.redirectUri),
			callbackPort: redacted.oauth.callbackPort,
			callbackPath: redacted.oauth.callbackPath,
		};
	}
	return redacted;
}

function withRuntimeDisclosure<T extends object>(value: T): T & RuntimeDisclosure {
	return { ...value, ...STORAGE_ONLY_RUNTIME_DISCLOSURE };
}

function collectEntries(config: MCPConfigFile): RuntimeRedactedServerEntry[] {
	return Object.entries(config.mcpServers ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, serverConfig]) => withRuntimeDisclosure({ name, config: redactMCPServerConfig(serverConfig) }));
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function renderServerLine(entry: RedactedServerEntry): string {
	const config = entry.config;
	if (config.type === "http" || config.type === "sse") {
		return `${entry.name}\t${config.type}\t${config.url}`;
	}
	const args = config.args && config.args.length > 0 ? ` ${config.args.join(" ")}` : "";
	return `${entry.name}\tstdio\t${config.command}${args}`;
}

function renderDetails(entry: RedactedServerEntry): string {
	return `${renderServerLine(entry)}\n${JSON.stringify(entry.config, null, 2)}`;
}

async function runAdd(args: MCPCommandArgs, scoped: ScopedPath): Promise<void> {
	if (!args.name) throw new MCPArgsError("`gjc mcp add` requires a server name.");
	const config = buildServerConfig(args);
	const result = await upsertMCPServer(scoped.path, args.name, config, { force: args.flags.force });
	const redacted = redactMCPServerConfig(config);
	if (args.flags.json) {
		writeJson(
			withRuntimeDisclosure({
				action: "add",
				status: result.status,
				name: args.name,
				scope: scoped.scope,
				path: scoped.path,
				config: redacted,
			}),
		);
		return;
	}
	if (result.status === "skipped") {
		process.stdout.write(
			`MCP server "${args.name}" already exists in ${scoped.scope} config. Pass --force to overwrite. ` +
				"Status: storage-only; normal standalone gjc sessions do not load stored MCP registrations today.\n",
		);
		return;
	}
	process.stdout.write(
		`MCP server "${args.name}" ${result.status} in ${scoped.scope} config: ${scoped.path}\nStatus: storage-only; normal standalone gjc sessions do not load stored MCP registrations today.\n`,
	);
}

async function runList(args: MCPCommandArgs, scoped: ScopedPath): Promise<void> {
	const config = await readMCPConfigFile(scoped.path);
	const entries = collectEntries(config);
	if (args.flags.json) {
		writeJson(withRuntimeDisclosure({ action: "list", scope: scoped.scope, path: scoped.path, servers: entries }));
		return;
	}
	if (entries.length === 0) {
		process.stdout.write(
			`No MCP servers registered in ${scoped.scope} config: ${scoped.path}\nStatus: storage-only; normal standalone gjc sessions do not load stored MCP registrations today.\n`,
		);
		return;
	}
	process.stdout.write(
		`MCP servers in ${scoped.scope} config: ${scoped.path}\nStatus: storage-only; normal standalone gjc sessions do not load stored MCP registrations today.\n`,
	);
	for (const entry of entries) {
		process.stdout.write(`${renderDetails(entry)}\n`);
	}
}

async function runRemove(args: MCPCommandArgs, scoped: ScopedPath): Promise<void> {
	if (!args.name) throw new MCPArgsError("`gjc mcp remove` requires a server name.");
	const existing = await getMCPServer(scoped.path, args.name);
	if (!existing) {
		throw new MCPArgsError(`MCP server "${args.name}" not found in ${scoped.scope} config.`);
	}
	await removeMCPServer(scoped.path, args.name);
	const entry = { name: args.name, config: redactMCPServerConfig(existing) };
	if (args.flags.json) {
		writeJson(
			withRuntimeDisclosure({
				action: "remove",
				status: "removed",
				name: args.name,
				scope: scoped.scope,
				path: scoped.path,
				removed: entry,
			}),
		);
		return;
	}
	process.stdout.write(
		`Removed MCP server "${args.name}" from ${scoped.scope} config: ${scoped.path}\nStatus: storage-only; normal standalone gjc sessions do not load stored MCP registrations today.\n`,
	);
	process.stdout.write(`${renderDetails(entry)}\n`);
}

export async function runMCPCommand(args: MCPCommandArgs): Promise<void> {
	const scoped = resolvePath(args);
	try {
		switch (args.action) {
			case "add":
				await runAdd(args, scoped);
				return;
			case "list":
				await runList(args, scoped);
				return;
			case "remove":
				await runRemove(args, scoped);
				return;
		}
	} catch (error) {
		if (error instanceof MCPArgsError) {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 2;
			return;
		}
		throw error;
	}
}
