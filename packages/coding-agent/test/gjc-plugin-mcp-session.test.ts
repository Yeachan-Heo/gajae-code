import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import { installGjcPluginBundle } from "../src/extensibility/gjc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const mcpBundle = path.join(fixturesRoot, "valid-mcp-bundle");
const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalAgentDir = process.env.GJC_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

// Hermetic isolation: enableMCP sessions discover user-level servers under
// `<home>/.gjc/agent/mcp.json`, so the developer's real config must never
// leak into these tests.
beforeEach(() => {
	const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mcp-session-home-"));
	tempDirs.push(isoHome);
	process.env.HOME = isoHome;
	vi.spyOn(os, "homedir").mockReturnValue(isoHome);
	setAgentDir(path.join(isoHome, "agent"));
});

afterEach(() => {
	vi.restoreAllMocks();
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.GJC_CODING_AGENT_DIR;
	}
	for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("always-on plugin-bundle MCP in a live session", () => {
	test("connects an installed bundle MCP server and surfaces its tools as always-on", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mcp-session-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(mcpBundle, { scope: "project", cwd });

		const { session, mcpManager } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			// MCP discovery stays off; plugin-bundle MCP is always-on regardless.
			enableMCP: false,
			enableLsp: false,
		});

		try {
			// The session must own a manager and have connected the bundled server.
			expect(mcpManager).toBeDefined();
			expect(mcpManager?.getConnectedServers()).toContain("domain_docs");

			// The bundled server advertises a "lookup" tool. It must be both
			// registered AND active (always-on), not gated behind MCP selection.
			const lookup = session.getAllToolNames().find(n => n.includes("lookup"));
			expect(lookup).toBeDefined();
			expect(session.getActiveToolNames()).toContain(lookup as string);
		} finally {
			await session.dispose();
		}

		// Disposing the session disconnects the owned manager (no leaked processes).
		expect(mcpManager?.getConnectedServers()).toEqual([]);
	}, 30_000);

	test("keeps plugin-bundle MCP tools always-on when MCP discovery is enabled", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mcp-session-discovery-"));

		tempDirs.push(cwd);
		await installGjcPluginBundle(mcpBundle, { scope: "project", cwd });

		const { session, mcpManager } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(mcpManager).toBeDefined();
			expect(mcpManager?.getConnectedServers()).toContain("domain_docs");

			const lookup = session.getAllToolNames().find(n => n.includes("lookup"));
			expect(lookup).toBeDefined();
			expect(session.getActiveToolNames()).toContain(lookup as string);
			expect(session.getDiscoverableMCPTools().map(tool => tool.name)).not.toContain(lookup as string);
			expect(session.getSelectedMCPToolNames()).not.toContain(lookup as string);
			expect(session.systemPrompt.join("\n")).not.toContain("### MCP tool discovery");
		} finally {
			await session.dispose();
		}

		expect(mcpManager?.getConnectedServers()).toEqual([]);
	}, 30_000);

	test("does not connect any MCP server when no plugin bundle is installed", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mcp-session-empty-"));
		tempDirs.push(cwd);

		const { session, mcpManager } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			// No bundle → no owned manager, no MCP tools (no behavior change).
			expect(mcpManager).toBeUndefined();
			expect(session.getAllToolNames().some(n => n.includes("lookup"))).toBe(false);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	test("subagent inherits the parent's always-on MCP tools and never tears down the parent manager", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mcp-session-sub-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(mcpBundle, { scope: "project", cwd });

		// Top-level session owns the manager and installs it as the global instance.
		const parent = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		const parentManager = parent.mcpManager;
		expect(parentManager?.getConnectedServers()).toContain("domain_docs");

		// Subagent (parentTaskPrefix set) must inherit the active MCP tools without
		// owning the manager.
		const child = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			parentTaskPrefix: "0-Sub",
		});

		try {
			const lookup = child.session.getAllToolNames().find(n => n.includes("lookup"));
			expect(lookup).toBeDefined();
			expect(child.session.getActiveToolNames()).toContain(lookup as string);
			// Subagent does not own a manager.
			expect(child.mcpManager).toBeUndefined();
		} finally {
			// Disposing the subagent must NOT disconnect the parent-owned manager.
			await child.session.dispose();
		}
		expect(parentManager?.getConnectedServers()).toContain("domain_docs");

		// Only disposing the owner tears the manager down.
		await parent.session.dispose();
		expect(parentManager?.getConnectedServers()).toEqual([]);
	}, 30_000);

	test("shared manager keeps user-config and plugin-bundle tools across refresh", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mcp-session-combined-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(mcpBundle, { scope: "project", cwd });

		// Autoload user/project-config server exposing a "usersearch" tool. It
		// connects into the same owned manager as the always-on plugin server.
		const userServerScript = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'userdocs', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'usersearch', description: 'user tool', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
		fs.writeFileSync(
			path.join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					userdocs: { command: "node", args: ["-e", userServerScript], timeout: 3_000 },
				},
			}),
		);

		const { session, mcpManager } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "mcp.enableProjectConfig": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: true,
			enableLsp: false,
		});

		try {
			expect(mcpManager?.getConnectedServers().sort()).toEqual(["domain_docs", "userdocs"]);

			// The manager's canonical snapshot must contain BOTH batches: the
			// user/project server connected first and the plugin bundle connected
			// second into the same manager. (Regression: the plugin batch used to
			// replace the snapshot wholesale and drop the user tools.)
			const managerServers = new Set(mcpManager?.getTools().map(t => t.mcpServerName));
			expect(managerServers).toEqual(new Set(["domain_docs", "userdocs"]));

			const userTool = session.getAllToolNames().find(n => n.includes("usersearch"));
			const pluginTool = session.getAllToolNames().find(n => n.includes("lookup"));
			expect(userTool).toBeDefined();
			expect(pluginTool).toBeDefined();

			// Every refresh path (tools/list_changed, reconnect, /mcp reload,
			// /mcp enable|disable) rebuilds the session registry from
			// manager.getTools(); both tool sets must survive it.
			await session.refreshMCPTools(mcpManager?.getTools() ?? []);
			expect(session.getAllToolNames()).toContain(userTool as string);
			expect(session.getAllToolNames()).toContain(pluginTool as string);
			// The plugin tool stays always-on after the refresh.
			expect(session.getActiveToolNames()).toContain(pluginTool as string);
		} finally {
			await session.dispose();
		}

		expect(mcpManager?.getConnectedServers()).toEqual([]);
	}, 30_000);

	test("a plugin-bundle name collision keeps the user server user-owned and selectable", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mcp-session-collision-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(mcpBundle, { scope: "project", cwd });

		// The user config claims the SAME server name as the installed bundle
		// ("domain_docs"). Per the sdk collision contract, the user server
		// connects first and the plugin server is skipped — and the skip must
		// not reclassify the user server as plugin-owned/always-on.
		const userServerScript = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'domain_docs', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'usersearch', description: 'user tool', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
		fs.writeFileSync(
			path.join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					domain_docs: { command: "node", args: ["-e", userServerScript], timeout: 3_000 },
				},
			}),
		);

		const { session, mcpManager } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "mcp.enableProjectConfig": true, "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: true,
			enableLsp: false,
		});

		try {
			// Only the user server is connected; the colliding plugin server is skipped.
			expect(mcpManager?.getConnectedServers()).toEqual(["domain_docs"]);
			// Source provenance stays user-owned — a gjc-plugins overwrite here
			// would make the user server's tools always-on and its instructions
			// always prompt-eligible.
			expect(mcpManager?.getSource("domain_docs")?.provider).not.toBe("gjc-plugins");
			const docsTool = mcpManager?.getTools().find(t => t.mcpServerName === "domain_docs");
			expect(docsTool?.name).toBe("mcp__domain_docs_usersearch");
			expect(docsTool?.mcpDiscoveryScope).toBe("selectable");
			// The skipped plugin server's tool never surfaces...
			expect(session.getAllToolNames().some(n => n.includes("lookup"))).toBe(false);
			// ...and in discovery mode the user tool stays discoverable-but-inactive.
			// (A gjc-plugins source overwrite would have made it always-on/active.)
			expect(session.getActiveToolNames()).not.toContain("mcp__domain_docs_usersearch");
			expect(session.getDiscoverableMCPTools().map(tool => tool.name)).toContain("mcp__domain_docs_usersearch");
		} finally {
			await session.dispose();
		}

		expect(mcpManager?.getConnectedServers()).toEqual([]);
	}, 30_000);
});
