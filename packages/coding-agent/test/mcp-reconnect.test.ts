import { describe, expect, it } from "bun:test";
import type { MCPReconnect } from "../src/runtime-mcp/tool-bridge";
import { DeferredMCPTool, isRetriableConnectionError, MCPTool } from "../src/runtime-mcp/tool-bridge";
import type { MCPServerConnection, MCPToolCallResult, MCPTransport } from "../src/runtime-mcp/types";
import { ToolAbortError } from "../src/tools/tool-errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock transport where `request` is controlled by the caller. */
function mockTransport(requestFn: (...args: Parameters<MCPTransport["request"]>) => Promise<unknown>): MCPTransport {
	return {
		connected: true,
		request: requestFn as MCPTransport["request"],
		async notify() {},
		async close() {},
	};
}

const TOOL_DEF = { name: "do_stuff", inputSchema: { type: "object" as const } };

function toolCallResult(text: string, isError = false): MCPToolCallResult {
	return { content: [{ type: "text", text }], isError };
}

function makeConnection(transport: MCPTransport, name = "test-server"): MCPServerConnection {
	return {
		name,
		config: { type: "stdio" as const, command: "echo" },
		transport,
		serverInfo: { name: "test", version: "1.0" },
		capabilities: { tools: {} },
	};
}

// ---------------------------------------------------------------------------
// isRetriableConnectionError
// ---------------------------------------------------------------------------

describe("isRetriableConnectionError", () => {
	const retriable = [
		"ECONNREFUSED",
		"ECONNRESET",
		"EPIPE",
		"ENETUNREACH",
		"EHOSTUNREACH",
		"fetch failed",
		"Transport not connected",
		"network error",
		"HTTP 404: Not Found",
		"HTTP 502: Bad Gateway",
		"HTTP 503: Service Unavailable",
		"Transport closed",
	];

	for (const msg of retriable) {
		it(`matches: ${msg}`, () => {
			expect(isRetriableConnectionError(new Error(msg))).toBe(true);
		});
	}

	const nonRetriable = [
		"MCP error -32603: Server still initializing",
		"HTTP 401: Unauthorized",
		"HTTP 403: Forbidden",
		"HTTP 400: Bad Request",
		"Request timeout after 30000ms",
		"SSE response timeout after 30000ms",
		"Tool not found: do_stuff",
	];

	for (const msg of nonRetriable) {
		it(`does not match: ${msg}`, () => {
			expect(isRetriableConnectionError(new Error(msg))).toBe(false);
		});
	}

	it("returns false for non-Error values", () => {
		expect(isRetriableConnectionError("ECONNREFUSED")).toBe(false);
		expect(isRetriableConnectionError(null)).toBe(false);
		expect(isRetriableConnectionError(undefined)).toBe(false);
		expect(isRetriableConnectionError({ message: "ECONNREFUSED" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// MCPTool.execute retry behavior
// ---------------------------------------------------------------------------

describe("MCPTool.execute retry on connection error", () => {
	const noop = () => {};
	const noCtx = {} as Parameters<MCPTool["execute"]>[3];

	it("signals shared recovery without replaying a noReplay tool call after a retriable failure", async () => {
		let callCount = 0;
		let reconnectCount = 0;
		const connection = makeConnection(
			mockTransport(async () => {
				callCount += 1;
				throw new Error("ECONNRESET");
			}),
		);
		const tool = new MCPTool(
			connection,
			TOOL_DEF,
			async () => {
				reconnectCount += 1;
				return connection;
			},
			{ noReplay: true },
		);
		const result = await tool.execute("no-replay", {}, noop, noCtx);
		expect(callCount).toBe(1);
		expect(reconnectCount).toBe(1);
		expect(result.details?.isError).toBe(true);
	});

	it("retries once on retriable error when reconnect succeeds", async () => {
		let callCount = 0;
		const failTransport = mockTransport(async () => {
			callCount++;
			throw new Error("ECONNREFUSED");
		});
		const successTransport = mockTransport(async () => {
			callCount++;
			return toolCallResult("ok");
		});

		const oldConn = makeConnection(failTransport);
		const newConn = makeConnection(successTransport, "test-server-new");
		const reconnect: MCPReconnect = async () => newConn;

		const tool = new MCPTool(oldConn, TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(callCount).toBe(2); // 1 fail + 1 retry
		expect(result.details?.isError).toBeFalsy();
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("retries on transport closed and rebinding succeeds", async () => {
		let oldCalls = 0;
		let newCalls = 0;
		let reconnects = 0;
		const closedTransport = mockTransport(async () => {
			oldCalls++;
			throw new Error("Transport closed");
		});
		const reopenedTransport = mockTransport(async () => {
			newCalls++;
			return toolCallResult("ok");
		});

		const oldConn = makeConnection(closedTransport);
		const newConn = makeConnection(reopenedTransport, "test-server-transport-closed");
		const reconnect: MCPReconnect = async () => {
			reconnects++;
			return newConn;
		};

		const tool = new MCPTool(oldConn, TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(reconnects).toBe(1);
		expect(oldCalls).toBe(1);
		expect(newCalls).toBe(1);
		expect(result.details?.isError).toBeFalsy();
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("reuses refreshed connection on later call", async () => {
		let oldCalls = 0;
		let newCalls = 0;
		let reconnects = 0;
		const oldTransport = mockTransport(async () => {
			oldCalls++;
			throw new Error("ECONNREFUSED");
		});
		const newTransport = mockTransport(async () => {
			newCalls++;
			return toolCallResult("ok");
		});

		const oldConn = makeConnection(oldTransport);
		const newConn = makeConnection(newTransport, "test-server-rebound");
		const reconnect: MCPReconnect = async () => {
			reconnects++;
			return newConn;
		};

		const tool = new MCPTool(oldConn, TOOL_DEF, reconnect);
		const first = await tool.execute("call-1", {}, noop, noCtx);
		const second = await tool.execute("call-2", {}, noop, noCtx);

		expect(oldCalls).toBe(1);
		expect(newCalls).toBe(2);
		expect(reconnects).toBe(1);
		expect(first.details?.isError).toBeFalsy();
		expect(second.details?.isError).toBeFalsy();
		expect(first.content[0]).toEqual({ type: "text", text: "ok" });
		expect(second.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("returns error result when reconnect returns null", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNRESET");
		});
		const reconnect: MCPReconnect = async () => null;

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "MCP error: ECONNRESET" });
	});

	it("does not retry on non-retriable error", async () => {
		let reconnectCalled = false;
		const failTransport = mockTransport(async () => {
			throw new Error("MCP error -32603: Internal error");
		});
		const reconnect: MCPReconnect = async () => {
			reconnectCalled = true;
			return null;
		};

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(reconnectCalled).toBe(false);
		expect(result.details?.isError).toBe(true);
	});

	it("does not retry when no reconnect callback", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNREFUSED");
		});

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF); // no reconnect
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "MCP error: ECONNREFUSED" });
	});

	it("returns error from retry when retry also fails", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNREFUSED");
		});
		const retryFailTransport = mockTransport(async () => {
			throw new Error("HTTP 503: Service Unavailable");
		});
		const reconnect: MCPReconnect = async () => makeConnection(retryFailTransport);

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "MCP error: HTTP 503: Service Unavailable" });
	});

	it("preserves provider info from new connection on successful retry", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("fetch failed");
		});
		const successTransport = mockTransport(async () => toolCallResult("ok"));

		const oldConn = makeConnection(failTransport);
		oldConn._source = { provider: "old-provider", providerName: "Old", path: "/old", level: "user" };
		const newConn = makeConnection(successTransport);
		newConn._source = { provider: "new-provider", providerName: "New", path: "/new", level: "user" };

		const tool = new MCPTool(oldConn, TOOL_DEF, async () => newConn);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.provider).toBe("new-provider");
		expect(result.details?.providerName).toBe("New");
	});

	it("falls back to original provider when new connection has no source", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("fetch failed");
		});
		const successTransport = mockTransport(async () => toolCallResult("ok"));

		const oldConn = makeConnection(failTransport);
		oldConn._source = { provider: "orig", providerName: "Original", path: "/orig", level: "user" };
		const newConn = makeConnection(successTransport);
		// newConn has no _source

		const tool = new MCPTool(oldConn, TOOL_DEF, async () => newConn);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.provider).toBe("orig");
		expect(result.details?.providerName).toBe("Original");
	});
});

describe("reconnect abort propagation", () => {
	const noop = () => {};
	const noCtx = {} as Parameters<MCPTool["execute"]>[3];
	const noDeferredCtx = {} as Parameters<DeferredMCPTool["execute"]>[3];

	it("throws ToolAbortError when MCPTool reconnect is aborted", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNRESET");
		});
		const { promise } = Promise.withResolvers<MCPServerConnection | null>();
		const reconnect: MCPReconnect = async () => promise;

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const controller = new AbortController();
		const pending = tool.execute("call-1", {}, noop, noCtx, controller.signal);
		controller.abort();

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("throws ToolAbortError when DeferredMCPTool reconnect is aborted", async () => {
		const getConnection = async () => {
			throw new Error("MCP server not connected");
		};
		const { promise } = Promise.withResolvers<MCPServerConnection | null>();
		const reconnect: MCPReconnect = async () => promise;

		const tool = new DeferredMCPTool("test-server", TOOL_DEF, getConnection, undefined, reconnect);
		const controller = new AbortController();
		const pending = tool.execute("call-1", {}, noop, noDeferredCtx, controller.signal);
		controller.abort();

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});
});
