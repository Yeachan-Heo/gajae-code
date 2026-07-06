import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir } from "@gajae-code/utils";
import { buildTrustGatedMCPDiscoverOptions } from "../../src/runtime-mcp/config";
import { MCPManager } from "../../src/runtime-mcp/manager";

const originalAgentDir = process.env.GJC_CODING_AGENT_DIR;
const originalHome = process.env.HOME;

let tmpDir = "";
let projectDir = "";

function stdioServerScript(): string {
	return `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
}

function stdioServerEntry(extra?: Record<string, unknown>): Record<string, unknown> {
	return { command: "node", args: ["-e", stdioServerScript()], timeout: 3_000, ...extra };
}

describe("MCP reload trust gates", () => {
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-reload-gates-"));
		projectDir = path.join(tmpDir, "project");
		const homeDir = path.join(tmpDir, "home");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(homeDir, { recursive: true });
		// Isolate user-level MCP discovery from the real machine: the builtin
		// provider reads `<home>/.gjc/agent/mcp.json` via os.homedir() and the
		// disabled-server list reads under the agent dir.
		process.env.HOME = homeDir;
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		setAgentDir(path.join(tmpDir, "agent"));

		// Project-root config with one autoload-eligible and one autoload-gated server.
		await Bun.write(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					eager: stdioServerEntry(),
					lazy: stdioServerEntry({ autoload: false }),
				},
			}),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			delete process.env.GJC_CODING_AGENT_DIR;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("shared gate builder pins the startup option shape", () => {
		expect(buildTrustGatedMCPDiscoverOptions({ enableProjectConfig: false, browserEnabled: undefined })).toEqual({
			enableProjectConfig: false,
			filterExa: true,
			filterBrowser: false,
			autoloadOnly: true,
		});
		expect(buildTrustGatedMCPDiscoverOptions({ enableProjectConfig: undefined, browserEnabled: true })).toEqual({
			enableProjectConfig: undefined,
			filterExa: true,
			filterBrowser: true,
			autoloadOnly: true,
		});
	});

	test("gated discovery never connects project servers while project config is disabled", async () => {
		const manager = new MCPManager(projectDir);
		try {
			const result = await manager.discoverAndConnect(
				buildTrustGatedMCPDiscoverOptions({ enableProjectConfig: false, browserEnabled: false }),
			);
			expect(result.connectedServers).toEqual([]);
			expect(manager.getConnectedServers()).toEqual([]);
			await expect(manager.waitForConnection("eager")).rejects.toThrow("MCP server not connected: eager");
			await expect(manager.waitForConnection("lazy")).rejects.toThrow("MCP server not connected: lazy");
		} finally {
			await manager.disconnectAll();
		}
	});

	test("reload flow (disconnectAll + gated rediscover) reconnects only autoload-eligible servers", async () => {
		const manager = new MCPManager(projectDir);
		const gates = buildTrustGatedMCPDiscoverOptions({ enableProjectConfig: true, browserEnabled: false });
		try {
			// Startup connect.
			await manager.discoverAndConnect(gates);
			await manager.waitForConnection("eager");
			expect(manager.getConnectedServers()).toEqual(["eager"]);

			// Mirror MCPCommandController#reloadMCP: full disconnect, then a
			// rediscover that must not widen the surface beyond startup.
			await manager.disconnectAll();
			expect(manager.getConnectedServers()).toEqual([]);
			await manager.discoverAndConnect(gates);
			await manager.waitForConnection("eager");
			expect(manager.getConnectedServers()).toEqual(["eager"]);
			await expect(manager.waitForConnection("lazy")).rejects.toThrow("MCP server not connected: lazy");
		} finally {
			await manager.disconnectAll();
		}
	});

	test("ungated discovery would connect the gated servers (control for the reload gate)", async () => {
		const manager = new MCPManager(projectDir);
		try {
			await manager.discoverAndConnect();
			await manager.waitForConnection("eager");
			await manager.waitForConnection("lazy");
			expect([...manager.getConnectedServers()].sort()).toEqual(["eager", "lazy"]);
		} finally {
			await manager.disconnectAll();
		}
	});
});
