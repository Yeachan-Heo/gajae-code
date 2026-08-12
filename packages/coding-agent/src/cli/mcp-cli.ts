/**
 * Direct MCP server registration CLI helpers.
 *
 * This surface only writes explicit user-provided server definitions to GJC's
 * own native MCP config (project `./.gjc/mcp.json` or user `~/.gjc/agent/mcp.json`)
 * through the canonical scope-aware reader/writer. It never imports or inherits
 * live configs from other agents. Registrations written here are consumed by
 * ordinary standalone sessions at startup (conventional autoload) unless
 * disabled or opted out via `--no-mcp`.
 */
import { getProjectDir } from "@gajae-code/utils";
import { redactMCPEndpoint } from "../runtime-mcp/redaction";
import {
	getScopeMCPServer,
	type MCPConfigScope,
	readScopeDisabledServers,
	readScopeMCPConfig,
	removeScopeMCPServer,
	resolveScopeMCPConfigPath,
	upsertScopeMCPServer,
} from "../runtime-mcp/scope-config";
import type { MCPServerConfig } from "../runtime-mcp/types";

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
		sharing?: "per-session" | "shared";
	};
	cwd?: string;
}

export class MCPArgsError extends Error {}

interface ScopedPath {
	scope: MCPConfigScope;
	path: string;
}

/** Runtime status of a stored registration for conventional autoload. */
type AutoloadStatus = "autoload" | "autoload-off" | "disabled";

interface RedactedServerEntry {
	name: string;
	config: MCPServerConfig;
}

interface RuntimeServerEntry extends RedactedServerEntry {
	scope: "user" | "project";
	path: string;
	/** Whether ordinary standalone sessions load this registration at startup. */
	runtimeStatus: AutoloadStatus;
	/** Human-readable explanation of the runtime status. */
	runtimeNote: string;
}

const REDACTED = "<redacted>";
const SENSITIVE_KEY_PATTERN =
	/(?:token|secret|key|credential|password|passwd|pwd|authorization|auth|bearer|cookie|session)/i;

/**
 * Compute the conventional-autoload status of a stored server.
 *
 * - `autoload-off`: the server opted out of startup connection via `autoload: false`.
 * - `disabled`: the server is disabled via `enabled: false` or the `disabledServers` list.
 * - `autoload`: connected by ordinary standalone sessions at startup.
 */
export function computeAutoloadStatus(
	name: string,
	config: MCPServerConfig,
	disabledServers: ReadonlySet<string>,
): AutoloadStatus {
	if (config.enabled === false || disabledServers.has(name)) return "disabled";
	if (config.autoload === false) return "autoload-off";
	return "autoload";
}

function autoloadStatusNote(status: AutoloadStatus): string {
	switch (status) {
		case "autoload":
			return "Loaded by ordinary standalone gjc sessions at startup.";
		case "autoload-off":
			return "Configured but not auto-loaded at startup (autoload: false); connect on demand via /mcp.";
		case "disabled":
			return "Disabled; not loaded by sessions. Re-enable to autoload.";
	}
}

function resolvePath(args: MCPCommandArgs): ScopedPath {
	const scope: MCPConfigScope = args.flags.project ? "project" : "user";
	return { scope, path: resolveScopeMCPConfigPath(scope, args.cwd ?? getProjectDir()) };
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
	const shared = {
		...(timeout === undefined ? {} : { timeout }),
		sharing: args.flags.sharing ?? "per-session",
	} as const;

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

function withRuntimeDisclosure<T extends object>(
	value: T,
	status: AutoloadStatus,
): T & { runtimeStatus: AutoloadStatus; runtimeNote: string } {
	return { ...value, runtimeStatus: status, runtimeNote: autoloadStatusNote(status) };
}

async function collectEntries(scoped: ScopedPath, cwd?: string): Promise<RuntimeServerEntry[]> {
	const [config, disabled] = await Promise.all([
		readScopeMCPConfig(scoped.scope, cwd),
		readScopeDisabledServers(scoped.scope, cwd),
	]);
	const disabledSet = new Set(disabled);
	return Object.entries(config.config.mcpServers ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, serverConfig]) => {
			const runtimeStatus = computeAutoloadStatus(name, serverConfig, disabledSet);
			return {
				name,
				scope: scoped.scope,
				path: scoped.path,
				runtimeStatus,
				runtimeNote: autoloadStatusNote(runtimeStatus),
				config: redactMCPServerConfig(serverConfig),
			};
		});
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
	const { result, config: storedConfig } = await upsertScopeMCPServer(
		scoped.scope,
		args.name,
		config,
		{
			force: args.flags.force,
		},
		args.cwd,
	);
	const redacted = redactMCPServerConfig(config);
	const disabled = new Set(storedConfig.disabledServers ?? (await readScopeDisabledServers(scoped.scope, args.cwd)));
	const runtimeStatus = computeAutoloadStatus(args.name, config, disabled);
	if (args.flags.json) {
		writeJson(
			withRuntimeDisclosure(
				{
					action: "add",
					status: result.status,
					name: args.name,
					scope: scoped.scope,
					path: scoped.path,
					config: redacted,
				},
				runtimeStatus,
			),
		);
		return;
	}
	if (result.status === "skipped") {
		process.stdout.write(
			`MCP server "${args.name}" already exists in ${scoped.scope} config. Pass --force to overwrite. ` +
				`Runtime: ${autoloadStatusNote(runtimeStatus)}\n`,
		);
		return;
	}
	process.stdout.write(
		`MCP server "${args.name}" ${result.status} in ${scoped.scope} config: ${scoped.path}\n` +
			`Runtime: ${autoloadStatusNote(runtimeStatus)}\n`,
	);
}

async function runList(args: MCPCommandArgs, scoped: ScopedPath): Promise<void> {
	const entries = await collectEntries(scoped, args.cwd);
	if (args.flags.json) {
		writeJson({
			action: "list",
			scope: scoped.scope,
			path: scoped.path,
			servers: entries,
		});
		return;
	}
	if (entries.length === 0) {
		process.stdout.write(`No MCP servers registered in ${scoped.scope} config: ${scoped.path}\n`);
		return;
	}
	process.stdout.write(`MCP servers in ${scoped.scope} config: ${scoped.path}\n`);
	for (const entry of entries) {
		process.stdout.write(`${renderDetails(entry)}\n`);
		process.stdout.write(`Runtime: ${entry.runtimeNote}\n`);
	}
}

async function runRemove(args: MCPCommandArgs, scoped: ScopedPath): Promise<void> {
	if (!args.name) throw new MCPArgsError("`gjc mcp remove` requires a server name.");
	const existing = await getScopeMCPServer(scoped.scope, args.name, args.cwd);
	if (!existing.config) {
		throw new MCPArgsError(`MCP server "${args.name}" not found in ${scoped.scope} config.`);
	}
	await removeScopeMCPServer(scoped.scope, args.name, args.cwd);
	const entry = { name: args.name, config: redactMCPServerConfig(existing.config) };
	if (args.flags.json) {
		writeJson({
			action: "remove",
			status: "removed",
			name: args.name,
			scope: scoped.scope,
			path: scoped.path,
			removed: entry,
		});
		return;
	}
	process.stdout.write(`Removed MCP server "${args.name}" from ${scoped.scope} config: ${scoped.path}\n`);
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
