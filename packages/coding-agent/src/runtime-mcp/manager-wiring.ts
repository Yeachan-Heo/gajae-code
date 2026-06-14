import { logger } from "@gajae-code/utils";
import type { Settings } from "../config/settings";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AgentSession } from "../session/agent-session";
import type { MCPManager } from "./manager";

type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

type RuntimeMCPSession = Pick<AgentSession, "refreshMCPTools" | "setMCPPromptCommands" | "yieldQueue">;

type RuntimeMCPSettings = Pick<Settings, "get">;

export interface RuntimeMCPManagerWiringOptions {
	manager: MCPManager;
	session: RuntimeMCPSession;
	settings: RuntimeMCPSettings;
	registerCleanup?: (name: string, cleanup: () => void) => void;
}

export function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]): Promise<string> {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") parts.push(item.text);
								else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}

export function wireRuntimeMCPManager(options: RuntimeMCPManagerWiringOptions): () => void {
	const { manager, session, settings } = options;
	let disposed = false;
	const notificationDebounceTimers = new Map<string, Timer>();
	const clearDebounceTimers = () => {
		disposed = true;
		for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
		notificationDebounceTimers.clear();
	};

	options.registerCleanup?.("mcp-notification-cleanup", clearDebounceTimers);

	manager.setOnToolsChanged((tools: CustomTool<any, any>[]) => {
		void session.refreshMCPTools(tools);
	});
	manager.setOnPromptsChanged((serverName: string) => {
		session.setMCPPromptCommands(buildMCPPromptCommands(manager));
		logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
	});
	manager.setOnResourcesChanged((serverName: string, uri: string) => {
		logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
		if (disposed || !settings.get("mcp.notifications")) return;
		const debounceMs = settings.get("mcp.notificationDebounceMs");
		const key = `${serverName}:${uri}`;
		const existing = notificationDebounceTimers.get(key);
		if (existing) clearTimeout(existing);
		notificationDebounceTimers.set(
			key,
			setTimeout(() => {
				notificationDebounceTimers.delete(key);
				if (disposed || !settings.get("mcp.notifications")) return;
				session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
			}, debounceMs),
		);
	});

	return clearDebounceTimers;
}
