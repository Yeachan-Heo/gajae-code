/**
 * MCP JSON-RPC 2.0 over HTTPS.
 *
 * Lightweight utilities for calling MCP servers directly via HTTP
 * without maintaining persistent connections.
 */
// biome-ignore assist/source/organizeImports: Keep independent MCP security imports on separate merge anchors.
import { cancelMCPStream, MCP_HTTP_TIMEOUT_MS, MCP_MAX_CONTENT_BYTES, readMCPResponseText } from "./content-limits";
import { logger } from "@gajae-code/utils";

/** Parse SSE response format (lines starting with "data: ") */
export function parseSSE(text: string): unknown {
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.startsWith("data: ")) {
			const data = line.slice(6).trim();
			if (data === "[DONE]") continue;
			const result = JSON.parse(data) as unknown;
			if (result) return result;
		}
	}
	// Fallback: try parsing entire response as JSON
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function translateMCPTimeout<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	try {
		return await operation;
	} catch (error) {
		if (signal.aborted && error === signal.reason) throw new Error("MCP request timed out");
		throw error;
	}
}

/** JSON-RPC 2.0 response structure */
export interface JsonRpcResponse<T = unknown> {
	jsonrpc: "2.0";
	id: string | number;
	result?: T;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

/**
 * Call an MCP server with JSON-RPC 2.0 over HTTPS.
 *
 * @param url - Full MCP server URL (including any query parameters)
 * @param method - JSON-RPC method name (e.g., "tools/list", "tools/call")
 * @param params - Method parameters
 * @returns Parsed JSON-RPC response
 */
export async function callMCP<T = unknown>(
	url: string,
	method: string,
	params?: Record<string, unknown>,
): Promise<JsonRpcResponse<T>> {
	const body = {
		jsonrpc: "2.0",
		id: Math.random().toString(36).slice(2),
		method,
		params: params ?? {},
	};

	const signal = AbortSignal.timeout(MCP_HTTP_TIMEOUT_MS);
	const response = await translateMCPTimeout(
		fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify(body),
			signal,
		}),
		signal,
	);

	if (!response.ok) {
		cancelMCPStream(response.body);
		const errorMsg = `MCP request failed: ${response.status} ${response.statusText}`;
		logger.error(errorMsg, { url, method, params });
		throw new Error(errorMsg);
	}

	const text = await translateMCPTimeout(readMCPResponseText(response, MCP_MAX_CONTENT_BYTES, false, signal), signal);
	const result = parseSSE(text) as JsonRpcResponse<T> | null;

	if (!result) {
		logger.error("Failed to parse MCP response", { url, method, responseText: text.slice(0, 500) });
		throw new Error("Failed to parse MCP response");
	}

	return result;
}
