import { logger } from "@gajae-code/utils";
import type { Settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { collectEnvSecrets } from "../secrets";
import type { AgentSession } from "../session/agent-session";
import type { AgentStorage } from "../session/agent-storage";
import type { AuthStorage } from "../session/auth-storage";
import { discoverAndLoadMCPTools, type MCPToolsLoadOptions, type MCPToolsLoadResult } from "./loader";
import { MCPManager } from "./manager";
import { buildMCPPromptCommands, wireRuntimeMCPManager } from "./manager-wiring";
import type { MCPServerConfig } from "./types";

export interface StartupMCPDiscovery {
	manager: MCPManager;
	tools: CustomTool<any, any>[];
	connectedServers: string[];
	errors: Array<{ path: string; error: string }>;
	cleanup?: () => void;
}

export interface PrepareStartupMCPDiscoveryOptions {
	cwd: string;
	enabled: boolean;
	enableProjectConfig?: boolean;
	filterExa?: boolean;
	filterBrowser?: boolean;
	cacheStorage?: AgentStorage | null;
	authStorage?: AuthStorage;
	discover?: (cwd: string, options: MCPToolsLoadOptions) => Promise<MCPToolsLoadResult>;
	warn?: (message: string, details: Record<string, unknown>) => void;
}

export interface AdoptStartupMCPDiscoveryOptions {
	session: Pick<AgentSession, "refreshMCPTools" | "setMCPPromptCommands" | "yieldQueue"> &
		Partial<Pick<AgentSession, "dispose">>;
	startup: StartupMCPDiscovery;
	settings: Settings;
}

/** Cap the logged error so an untrusted/large server response body is never dumped raw. */
const MAX_REDACTED_ERROR_LENGTH = 500;

/** Minimum length for a config/env value to be treated as a redactable secret (avoids nuking short non-secret substrings). */
const MIN_REDACTABLE_SECRET_LENGTH = 4;

/**
 * Defense-in-depth denylist for credential shapes that can appear in a server- or
 * transport-controlled failure message. Structural config/env value redaction is the
 * primary control (see {@link collectMCPServerSecrets} + {@link collectEnvSecrets}); this
 * backstops forms whose exact value we do not already know.
 */
const SECRET_VALUE_PATTERN =
	/(?:authorization[=:]\s*(?:Bearer|Basic)?\s*[^\s,}]+|Bearer\s+\S+|Basic\s+\S+|["']?(?:password|passwd|pwd|client[_-]?secret|access[_-]?key|[a-z0-9_]*secret[a-z0-9_]*|token|api[_-]?key|apikey)["']?\s*[=:]\s*["']?[^"'\s,}]+["']?|--(?:token|api-key|api_key|password|secret|client-secret)[=\s]+\S+|sk-[A-Za-z0-9_-]{8,}|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gi;

/** Strip `user:pass@` userinfo from any URL in the text, unconditionally. */
const URL_USERINFO_PATTERN = /\/\/[^/\s@]+:[^/\s@]+@/g;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collect the secret values from a server's own config (the richest, most reliable source):
 * URL userinfo, header values, env values, and OAuth/auth client secrets.
 */
export function collectMCPServerSecrets(config: MCPServerConfig | undefined): string[] {
	if (!config) return [];
	const c = config as {
		url?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
		oauth?: { clientSecret?: string };
		auth?: { clientSecret?: string };
	};
	const values: string[] = [];
	if (c.url) {
		try {
			const u = new URL(c.url);
			if (u.password) values.push(u.password, decodeURIComponent(u.password));
			if (u.username) values.push(u.username, decodeURIComponent(u.username));
		} catch {
			// Non-parseable URL: the unconditional userinfo strip still applies.
		}
	}
	for (const v of Object.values(c.headers ?? {})) if (v) values.push(v);
	for (const v of Object.values(c.env ?? {})) if (v) values.push(v);
	if (c.oauth?.clientSecret) values.push(c.oauth.clientSecret);
	if (c.auth?.clientSecret) values.push(c.auth.clientSecret);
	return [...new Set(values)].filter(v => v.length >= MIN_REDACTABLE_SECRET_LENGTH);
}

/**
 * Redact a runtime MCP startup failure message before logging. Primary control is structural:
 * exact secret values from the server config + process env (`secrets`) are removed; URL userinfo
 * is always stripped; a denylist backstops common credential shapes; and the output is
 * length-capped so an untrusted response body is never dumped raw.
 */
export function redactMCPStartupError(error: string, secrets: readonly string[] = []): string {
	let out = error.replace(URL_USERINFO_PATTERN, "//[REDACTED]@");
	const ordered = [...new Set(secrets)]
		.filter(s => s.length >= MIN_REDACTABLE_SECRET_LENGTH)
		.sort((a, b) => b.length - a.length);
	for (const secret of ordered) {
		out = out.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
	}
	out = out.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
	if (out.length > MAX_REDACTED_ERROR_LENGTH) {
		out = `${out.slice(0, MAX_REDACTED_ERROR_LENGTH)}…[truncated]`;
	}
	return out;
}

export async function prepareStartupMCPDiscovery(
	options: PrepareStartupMCPDiscoveryOptions,
): Promise<StartupMCPDiscovery | undefined> {
	if (!options.enabled) return undefined;

	const discover = options.discover ?? discoverAndLoadMCPTools;
	const result = await discover(options.cwd, {
		enableProjectConfig: options.enableProjectConfig,
		filterExa: options.filterExa,
		filterBrowser: options.filterBrowser,
		cacheStorage: options.cacheStorage,
		authStorage: options.authStorage,
	});

	const envSecrets = collectEnvSecrets().map(entry => entry.content);
	for (const error of result.errors) {
		const serverName = error.path.startsWith("mcp:") ? error.path.slice("mcp:".length) : error.path;
		const configSecrets = collectMCPServerSecrets(result.manager.getServerConfig(serverName));
		(options.warn ?? logger.warn)("Runtime MCP server failed during startup", {
			path: `mcp:${serverName}`,
			serverName,
			error: redactMCPStartupError(error.error, [...configSecrets, ...envSecrets]),
		});
	}

	return {
		manager: result.manager,
		tools: result.tools as unknown as CustomTool<any, any>[],
		connectedServers: result.connectedServers,
		errors: result.errors,
	};
}

export async function adoptStartupMCPDiscovery(options: AdoptStartupMCPDiscoveryOptions): Promise<void> {
	const { session, settings, startup } = options;
	await session.refreshMCPTools(startup.tools);
	session.setMCPPromptCommands(buildMCPPromptCommands(startup.manager));

	startup.cleanup = wireRuntimeMCPManager({ manager: startup.manager, session, settings });
	if (session.dispose) {
		const originalDispose = session.dispose.bind(session);
		session.dispose = async () => {
			startup.cleanup?.();
			await originalDispose();
		};
	}
}

export async function cleanupStartupMCPDiscovery(startup: StartupMCPDiscovery | undefined): Promise<void> {
	if (!startup) return;
	startup.cleanup?.();
	await startup.manager.disconnectAll();
	if (MCPManager.instance() === startup.manager) MCPManager.setInstance(undefined);
}
