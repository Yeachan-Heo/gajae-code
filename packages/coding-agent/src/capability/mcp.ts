/**
 * MCP (Model Context Protocol) Servers Capability
 *
 * Canonical shape for MCP server configurations, regardless of source format.
 * All providers translate their native format to this shape.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Canonical MCP server configuration.
 */
export interface MCPServer {
	/** Server name (unique key) */
	name: string;
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
	/** Whether explicit runtime MCP consumers should connect automatically (default: true) */
	autoload?: boolean;
	/** Connection timeout in milliseconds */
	timeout?: number;
	/** Command to run (for stdio transport) */
	command?: string;
	/** Command arguments */
	args?: string[];
	/** Environment variables */
	env?: Record<string, string>;
	/** Whether explicit stdio runtime consumers should avoid inheriting host environment */
	noInheritEnv?: boolean;
	/** Working directory for stdio transport */
	cwd?: string;
	/** URL (for HTTP/SSE transport) */
	url?: string;
	/** HTTP headers (for HTTP transport) */
	headers?: Record<string, string>;
	/** Authentication configuration */
	auth?: {
		type: "oauth" | "apikey";
		credentialId?: string;
		tokenUrl?: string;
		clientId?: string;
		clientSecret?: string;
	};
	/** OAuth configuration (clientId, clientSecret, redirectUri, callbackPort, callbackPath) for servers requiring explicit client credentials */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
	};
	/** Transport type */
	transport?: "stdio" | "sse" | "http";
	/** Source metadata (added by loader) */
	_source: SourceMeta;
}

export const mcpCapability = defineCapability<MCPServer>({
	id: "mcps",
	displayName: "MCP Servers",
	description: "Model Context Protocol server configurations for external tool integrations",
	key: server => server.name,
	toExtensionId: server => `mcp:${server.name}`,
	validate: server => {
		if (!server.name) return "Missing server name";
		if (!server.command && !server.url) return "Must have command or url";

		// Validate transport-endpoint pairing
		if (server.transport === "stdio" && !server.command) {
			return "stdio transport requires command field";
		}
		if ((server.transport === "http" || server.transport === "sse") && !server.url) {
			return "http/sse transport requires url field";
		}

		return undefined;
	},
});
