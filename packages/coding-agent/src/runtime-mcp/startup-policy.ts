import type { MCPServerConfig } from "./types";

export type AutoloadStatus = "autoload" | "autoload-off" | "disabled";

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
