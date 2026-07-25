export const ACP_MCP_REQUEST_TIMEOUT_MS = 30_000;
export const ACP_MCP_LIFECYCLE_TIMEOUT_MS = ACP_MCP_REQUEST_TIMEOUT_MS + 500;

export interface SessionLifecycleMcpStdioServer {
	type?: "stdio";
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
}

export interface SessionLifecycleMcpRemoteServer {
	type: "http" | "sse";
	name: string;
	url: string;
	headers?: Record<string, string>;
}

export type SessionLifecycleMcpServer = SessionLifecycleMcpStdioServer | SessionLifecycleMcpRemoteServer;
