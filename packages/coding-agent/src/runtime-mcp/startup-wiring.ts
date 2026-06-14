import { logger } from "@gajae-code/utils";
import type { Settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AgentSession } from "../session/agent-session";
import type { AgentStorage } from "../session/agent-storage";
import type { AuthStorage } from "../session/auth-storage";
import { discoverAndLoadMCPTools, type MCPToolsLoadOptions, type MCPToolsLoadResult } from "./loader";
import { MCPManager } from "./manager";
import { buildMCPPromptCommands, wireRuntimeMCPManager } from "./manager-wiring";

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

const SECRET_VALUE_PATTERN =
	/(?:authorization[=:]\s*(?:Bearer|Basic)?\s*[^\s,}]+|sk-[a-z0-9_-]+|Bearer\s+[^\s]+|Basic\s+[^\s]+|["']?(?:token|api[_-]?key|apiKey)["']?\s*[=:]\s*["']?[^"'\s,}]+["']?|--(?:token|api-key|api_key)\s+[^\s]+)/gi;

export function redactMCPStartupError(error: string): string {
	return error.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
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

	for (const error of result.errors) {
		const serverName = error.path.startsWith("mcp:") ? error.path.slice("mcp:".length) : error.path;
		(options.warn ?? logger.warn)("Runtime MCP server failed during startup", {
			path: `mcp:${serverName}`,
			serverName,
			error: redactMCPStartupError(error.error),
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
