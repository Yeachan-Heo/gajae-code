import { legacyEraObservation } from "../src/runtime-mcp/protocol";
import type { MCPServerCapabilities, MCPServerConnection, MCPTransport } from "../src/runtime-mcp/types";

/**
 * How a real legacy (pre-2026-07-28) server answers a method it does not know —
 * including the modern `server/discover` probe: JSON-RPC method-not-found.
 * HTTP stubs for legacy servers use this so era negotiation falls back safely.
 */
export function legacyMcpMethodNotFound(id: string | number): Response {
	return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

export function createMockTransport(
	responses: Map<string, unknown[]>,
	onRequest?: (method: string, params: Record<string, unknown> | undefined) => void,
): MCPTransport {
	const callCounts = new Map<string, number>();
	return {
		connected: true,
		async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
			onRequest?.(method, params);
			const count = callCounts.get(method) ?? 0;
			callCounts.set(method, count + 1);
			const queue = responses.get(method);
			if (!queue || count >= queue.length) {
				throw new Error(`No mock response for ${method} call #${count}`);
			}
			return queue[count] as T;
		},
		async notify() {},
		async close() {},
	};
}

export function createMockConnection(
	capabilities: MCPServerCapabilities,
	transport: MCPTransport,
): MCPServerConnection {
	return {
		name: "test-server",
		config: { type: "stdio" as const, command: "echo" },
		transport,
		serverInfo: { name: "test", version: "1.0" },
		capabilities,
		// Mock connections model pre-v2 stdio servers: legacy era, forced by transport.
		protocol: legacyEraObservation({
			preference: "auto",
			effectiveVersion: "2025-03-26",
			negotiation: "legacy-forced",
			downgradeReason: "stdio-transport",
			serverInfo: { name: "test", version: "1.0" },
			capabilities: {
				tools: capabilities.tools !== undefined,
				resources: capabilities.resources !== undefined,
				prompts: capabilities.prompts !== undefined,
			},
		}),
	};
}
