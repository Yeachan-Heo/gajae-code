import type { MCPServerConfig } from "./types";

export type AutoloadStatus = "autoload" | "autoload-off" | "disabled";

/** Ordinary standalone sessions stop blocking on MCP startup after this wait. */
export const DEFAULT_MCP_STARTUP_WAIT_MS = 250;

/** Pure startup policy shared by runtime-facing CLI inspection and doctor. */
export function computeAutoloadStatus(
	name: string,
	config: Pick<MCPServerConfig, "enabled" | "autoload">,
	disabledServers: ReadonlySet<string>,
): AutoloadStatus {
	if (config.enabled === false || disabledServers.has(name)) return "disabled";
	if (config.autoload === false) return "autoload-off";
	return "autoload";
}
