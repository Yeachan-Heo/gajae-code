import { describe, expect, test, vi } from "bun:test";
import * as mcpClient from "../../src/runtime-mcp/client";
import { MCPManager, withinDeclaredConnectionWindow } from "../../src/runtime-mcp/manager";
import type { MCPServerConnection } from "../../src/runtime-mcp/types";

// `gjc mcp add --timeout` writes a per-server `timeout`, and `connectToServer`
// honors it. Startup used to discard it anyway: one batch-wide timer decided
// every server's fate, so a server that declared 90s and a server that declared
// nothing were both killed at the same millisecond once the short ceiling
// elapsed. The wait staying short is correct — killing the connection was not.

const STARTUP_CEILING_MS = 1_750;

/** stdio MCP server that stalls `initialize` and then serves one tool. */
function delayedStdioServer(toolName: string, initializeDelayMs: number): string {
	return `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'delayed', version: '1' } } }) + '\\n');
    }, ${initializeDelayMs});
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: '${toolName}', inputSchema: { type: 'object' } }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

describe("MCP startup and the declared connection window", () => {
	test("reads the declared window per server rather than as one batch budget", () => {
		expect(withinDeclaredConnectionWindow({ command: "declared", timeout: 90_000 }, STARTUP_CEILING_MS)).toBe(true);
		expect(withinDeclaredConnectionWindow({ command: "declared", timeout: 90_000 }, 90_000)).toBe(false);
		// No declared window, or a meaningless one, is not an open window.
		expect(withinDeclaredConnectionWindow({ command: "undeclared" }, 0)).toBe(false);
		expect(withinDeclaredConnectionWindow({ command: "zero", timeout: 0 }, 0)).toBe(false);
		expect(withinDeclaredConnectionWindow({ command: "nan", timeout: Number.NaN }, 0)).toBe(false);
	});

	test("keeps a server inside its declared window connecting and fails only the one without a window", async () => {
		const manager = new MCPManager(process.cwd());
		try {
			const startedAt = Date.now();
			const result = await manager.connectServers(
				{
					declared: {
						command: process.execPath,
						args: ["-e", delayedStdioServer("ping", 2_400)],
						timeout: 10_000,
					},
					undeclared: {
						command: process.execPath,
						args: ["-e", delayedStdioServer("ping", 2_400)],
					},
				},
				{},
			);
			const elapsedMs = Date.now() - startedAt;

			// Session start is still bounded by the short ceiling: a declared
			// timeout buys the server time, never the user's startup latency.
			expect(elapsedMs).toBeLessThan(2_400);
			expect(result.connectedServers).toEqual([]);
			expect(result.tools).toEqual([]);

			// One batch-wide verdict is gone: the two servers are judged against
			// their own windows, so they no longer fail together.
			expect(result.errors.get("undeclared")).toContain("timed out");
			expect(result.errors.has("declared")).toBe(false);
			expect(manager.getConnectionStatus("undeclared")).toBe("disconnected");
			expect(manager.getConnectionStatus("declared")).toBe("connecting");

			// The surviving connection completes on its own and publishes tools.
			await waitFor(() => manager.getConnectedServers().includes("declared"));
			await waitFor(() => manager.getTools().some(tool => tool.name === "mcp__declared_ping"));
			expect(manager.getConnectedServers()).toEqual(["declared"]);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	// A real stdio fixture cannot reach this branch: `connectToServer` enforces the
	// declared timeout itself, so the task rejects before the startup race sees it
	// still pending. Holding the connect open past its declared window is the only
	// way to assert the manager's own elapsed-window teardown and its abort mapping.
	test("tears down a task still pending after its declared window elapsed", async () => {
		let capturedSignal: AbortSignal | undefined;
		const connect = vi
			.spyOn(mcpClient, "connectToServer")
			.mockImplementation((_name, _config, options?: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal;
				return new Promise<MCPServerConnection>(() => {});
			});
		// The startup wait outlives the declared window: budget is declared + grace,
		// so by the deadline the 300ms window is spent while the task is still pending.
		const manager = new MCPManager(process.cwd(), null, { maxStartupTimeoutMs: 800 });
		try {
			const result = await manager.connectServers({ spent: { type: "stdio", command: "spent", timeout: 300 } }, {});

			expect(result.connectedServers).toEqual([]);
			expect(result.errors.get("spent")).toBe("MCP server connection timed out during startup: spent");
			expect(manager.getConnectionStatus("spent")).toBe("disconnected");
			expect(capturedSignal?.aborted).toBe(true);
		} finally {
			connect.mockRestore();
			await manager.disconnectAll();
		}
	});

	test("reports a server whose own declared timeout rejects it before the startup wait ends", async () => {
		const manager = new MCPManager(process.cwd());
		try {
			const result = await manager.connectServers(
				{
					brief: {
						command: process.execPath,
						args: ["-e", delayedStdioServer("ping", 5_000)],
						// `connectToServer` enforces this window itself and rejects at 900ms,
						// well inside the 1400ms startup wait.
						timeout: 900,
					},
				},
				{},
			);

			expect(result.connectedServers).toEqual([]);
			expect(result.errors.get("brief")).toContain("timed out");
			expect(manager.getConnectionStatus("brief")).toBe("disconnected");
		} finally {
			await manager.disconnectAll();
		}
	});
});
