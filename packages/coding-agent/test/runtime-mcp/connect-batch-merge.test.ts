import { describe, expect, test } from "bun:test";
import { MCPManager } from "../../src/runtime-mcp/manager";

function stdioServerScript(toolName: string): string {
	return `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: ${JSON.stringify(toolName)}, description: 'test tool', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
}

function stdioServerEntry(toolName: string): { command: string; args: string[]; timeout: number } {
	return { command: "node", args: ["-e", stdioServerScript(toolName)], timeout: 3_000 };
}

/**
 * connectServers batches share one manager: createAgentSession connects
 * user/project config servers first, then always-on plugin-bundle servers
 * into the same MCPManager. The published tool snapshot must merge across
 * batches instead of being replaced by the latest batch, or every refresh
 * path that consumes getTools() drops the earlier batch's tools.
 */
describe("MCPManager multi-batch tool snapshot", () => {
	test("a later connectServers batch retains tools from an earlier batch", async () => {
		const manager = new MCPManager(process.cwd());
		try {
			const first = await manager.connectServers({ alpha: stdioServerEntry("search") }, {});
			expect(first.connectedServers).toEqual(["alpha"]);
			expect(manager.getTools().map(t => t.name)).toEqual(["mcp__alpha_search"]);

			const second = await manager.connectServers({ beta: stdioServerEntry("lookup") }, {
				beta: { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" as const },
			} as never);
			expect(second.connectedServers).toEqual(["beta"]);
			// The return value stays batch-only (callers push only the new tools)...
			expect(second.tools.map(t => t.name)).toEqual(["mcp__beta_lookup"]);
			// ...but the canonical snapshot consumed by getTools()/refresh paths
			// must contain both batches.
			expect(manager.getTools().map(t => t.name)).toEqual(["mcp__alpha_search", "mcp__beta_lookup"]);
		} finally {
			await manager.disconnectAll();
		}
	});

	test("re-listing an already-connected server in a later batch keeps its tools", async () => {
		const manager = new MCPManager(process.cwd());
		try {
			await manager.connectServers({ alpha: stdioServerEntry("search") }, {});

			// alpha is already connected, so the second batch skips it; its tools
			// must survive the snapshot publish for the batch that connects beta.
			const result = await manager.connectServers(
				{ alpha: stdioServerEntry("search"), beta: stdioServerEntry("lookup") },
				{},
			);
			expect(result.connectedServers.sort()).toEqual(["alpha", "beta"]);
			expect(manager.getTools().map(t => t.name)).toEqual(["mcp__alpha_search", "mcp__beta_lookup"]);
		} finally {
			await manager.disconnectAll();
		}
	});

	test("disconnecting one server removes only its tools from the merged snapshot", async () => {
		const manager = new MCPManager(process.cwd());
		try {
			await manager.connectServers({ alpha: stdioServerEntry("search") }, {});
			await manager.connectServers({ beta: stdioServerEntry("lookup") }, {});

			await manager.disconnectServer("alpha");
			expect(manager.getTools().map(t => t.name)).toEqual(["mcp__beta_lookup"]);

			await manager.disconnectAll();
			expect(manager.getTools()).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	});

	test("a plugin-batch name collision cannot reclassify an already-connected server's source", async () => {
		const manager = new MCPManager(process.cwd());
		try {
			// User/project server connects first with user provenance.
			await manager.connectServers({ docs: stdioServerEntry("usersearch") }, {
				docs: { provider: "mcp-json", providerName: "MCP Config", level: "user" as const },
			} as never);
			expect(manager.getSource("docs")?.provider).toBe("mcp-json");
			expect(manager.getTools().find(t => t.mcpServerName === "docs")?.mcpDiscoveryScope).toBe("selectable");

			// A plugin bundle re-lists the same server name. The collision is
			// skipped, and the skip must be source-neutral: gjc-plugins provenance
			// makes tools always-on and instructions always prompt-eligible, so an
			// overwrite here would silently widen the user server's trust surface.
			await manager.connectServers({ docs: stdioServerEntry("lookup"), extra: stdioServerEntry("lookup") }, {
				docs: { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" as const },
				extra: { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" as const },
			} as never);

			// docs keeps its user provenance and its own tool; only extra is plugin-owned.
			expect(manager.getSource("docs")?.provider).toBe("mcp-json");
			expect(manager.getTools().map(t => t.name)).toEqual(["mcp__docs_usersearch", "mcp__extra_lookup"]);
			expect(manager.getTools().find(t => t.mcpServerName === "docs")?.mcpDiscoveryScope).toBe("selectable");
			expect(manager.getTools().find(t => t.mcpServerName === "extra")?.mcpDiscoveryScope).toBe("always-on");

			// Reconnect rebuilds docs' tools from the stored source; the user-owned
			// selectable classification must survive the rebuild.
			await manager.reconnectServer("docs");
			expect(manager.getSource("docs")?.provider).toBe("mcp-json");
			const docsTool = manager.getTools().find(t => t.mcpServerName === "docs");
			expect(docsTool?.name).toBe("mcp__docs_usersearch");
			expect(docsTool?.mcpDiscoveryScope).toBe("selectable");
		} finally {
			await manager.disconnectAll();
		}
	});
});
