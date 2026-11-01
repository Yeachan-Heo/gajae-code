/**
 * Conventional MCP autoload: ordinary top-level standalone sessions consume
 * `gjc mcp add` registrations (issue #4284).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDbPath, getAgentDir, logger, setAgentDir } from "@gajae-code/utils";
import { z } from "zod/v4";
import { safeRm } from "../../../scripts/safe-cleanup";
import { runMCPCommand } from "../src/cli/mcp-cli";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { installGjcBundle } from "../src/extensibility/gjc-plugins";
import {
	DeferredMCPTool,
	loadAllMCPConfigs,
	type MCPLoadResult,
	MCPManager,
	MCPTool,
	MCPToolCache,
} from "../src/runtime-mcp";
import * as mcpClient from "../src/runtime-mcp/client";
import { AgentStorage } from "../src/session/agent-storage";
import { isMCPBridgeTool } from "../src/tool-discovery/tool-index";

const DEMO_MCP_SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'hello', description: 'Demo tool', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;

const MULTI_TOOL_DEMO_MCP_SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'hello', description: 'Demo hello tool', inputSchema: { type: 'object', properties: {} } },
      { name: 'goodbye', description: 'Demo goodbye tool', inputSchema: { type: 'object', properties: {} } }
    ] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;

const DELAYED_MCP_SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'slow-demo', version: '1' } } }) + '\\n');
    }, 4200);
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'late_hello', description: 'Late demo tool', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;

const LATE_DEFAULT_MCP_SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'slow-default', version: '1' } } }) + '\\n');
    }, 8000);
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'late_default', description: 'Late default demo tool', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;

const originalAgentDir = getAgentDir();

describe("conventional MCP autoload in standalone sessions", () => {
	let projectDir: string;
	let agentDir: string;
	let tempHome: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		MCPManager.resetForTests();
		projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-autoload-project-"));
		tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-autoload-home-"));
		// The MCP user scope is the agent directory, so `setAgentDir` is what keeps
		// this test off the developer's real ~/.gjc MCP configuration.
		agentDir = path.join(tempHome, ".gjc", "agent");
		await fs.promises.mkdir(agentDir, { recursive: true });
		setAgentDir(agentDir);
		// Home-relative surfaces (skills and other convention scans) resolve from
		// the mocked home.
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		await safeRm(projectDir, { recursive: true, force: true });
		await safeRm(agentDir, { recursive: true, force: true });
		await safeRm(tempHome, { recursive: true, force: true });
	});

	function isolatedSessionOptions() {
		return {
			cwd: projectDir,
			agentDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			// Project stdio autoload requires an explicit user opt-in.
			settings: Settings.isolated({ "mcp.enableProjectConfig": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			toolNames: ["read"],
		};
	}

	it("exposes tools from `gjc mcp add --project` registrations at ordinary session startup", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await runMCPCommand({
			action: "add",
			name: "demo",
			commandArgs: [process.execPath, "-e", DEMO_MCP_SERVER_SCRIPT],
			flags: { project: true, timeout: 5_000 },
			cwd: projectDir,
		});
		expect(stdout.mock.calls.map(call => String(call[0])).join("")).toContain(
			"Runtime: Loaded by ordinary standalone gjc sessions at startup.",
		);
		expect(await fs.promises.readFile(path.join(projectDir, ".gjc", "mcp.json"), "utf8")).toContain('"demo": {');

		const { session, mcpManager } = await createAgentSession(isolatedSessionOptions());
		try {
			expect(mcpManager).toBeDefined();
			expect(mcpManager?.getConnectedServers()).toContain("demo");
			expect(session.getAllToolNames()).toContain("mcp__demo_hello");
			// Ordinary sessions expose autoloaded MCP tools as active tools.
			expect(session.getActiveToolNames()).toContain("mcp__demo_hello");
		} finally {
			await session.dispose();
		}
	}, 30_000);

	async function addDemoServer(): Promise<void> {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await runMCPCommand({
			action: "add",
			name: "demo",
			commandArgs: [process.execPath, "-e", DEMO_MCP_SERVER_SCRIPT],
			flags: { project: true, timeout: 5_000 },
			cwd: projectDir,
		});
	}

	it("keeps autoloaded MCP tools discoverable but inactive when mcp.discoveryDeferAutoload is set", async () => {
		await addDemoServer();
		const { session } = await createAgentSession({
			...isolatedSessionOptions(),
			toolNames: undefined,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDeferAutoload": true,
				"mcp.enableProjectConfig": true,
			}),
		});
		try {
			expect(session.getAllToolNames()).toContain("mcp__demo_hello");
			expect(session.getActiveToolNames()).not.toContain("mcp__demo_hello");
			await session.activateDiscoveredTools(["mcp__demo_hello"]);
			expect(session.getActiveToolNames()).toContain("mcp__demo_hello");
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("keeps automatic discovery-default selection non-persisting across catalog refreshes", async () => {
		await addDemoServer();
		let publishToolsChanged: Parameters<MCPManager["setOnToolsChanged"]>[0] | undefined;
		const originalSetOnToolsChanged = MCPManager.prototype.setOnToolsChanged;
		vi.spyOn(MCPManager.prototype, "setOnToolsChanged").mockImplementation(function (this: MCPManager, handler) {
			publishToolsChanged = handler;
			return originalSetOnToolsChanged.call(this, handler);
		});

		const { session, mcpManager } = await createAgentSession({
			...isolatedSessionOptions(),
			toolNames: undefined,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDeferAutoload": true,
				"mcp.discoveryDefaultServers": ["demo"],
				"mcp.enableProjectConfig": true,
			}),
		});
		try {
			if (!mcpManager) throw new Error("Expected the session-owned MCP manager");
			const initialToolName = "mcp__demo_hello";
			const [lateDefaultTool] = MCPTool.fromTools(
				{ name: "demo" } as unknown as Parameters<typeof MCPTool.fromTools>[0],
				[
					{
						name: "late_default",
						description: "Late default tool",
						inputSchema: { type: "object", properties: {} },
					},
				],
			);
			if (!lateDefaultTool) throw new Error("Default MCP regression tool was not created");
			if (!publishToolsChanged) throw new Error("Expected the MCP catalog callback");
			expect(session.getActiveToolNames()).toContain(initialToolName);
			expect(session.hasMCPToolSelectionAuthority()).toBe(false);

			publishToolsChanged([]);
			const removalDeadline = Date.now() + 5_000;
			while (session.getAllToolNames().includes(initialToolName)) {
				if (Date.now() > removalDeadline) throw new Error(`MCP catalog tool was not removed: ${initialToolName}`);
				await Bun.sleep(20);
			}
			expect(session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
			expect(session.hasMCPToolSelectionAuthority()).toBe(false);

			const pendingAuthority = vi.spyOn(session, "hasMCPToolSelectionAuthority").mockReturnValue(true);
			const committedAuthority = vi.spyOn(session, "hasCommittedMCPToolSelectionAuthority").mockReturnValue(false);
			publishToolsChanged([lateDefaultTool]);
			const activationDeadline = Date.now() + 5_000;
			while (!session.getActiveToolNames().includes(lateDefaultTool.name)) {
				if (Date.now() > activationDeadline)
					throw new Error(`Discovery-default MCP tool was not activated: ${lateDefaultTool.name}`);
				await Bun.sleep(20);
			}
			expect(committedAuthority).toHaveBeenCalled();
			pendingAuthority.mockRestore();
			committedAuthority.mockRestore();
			expect(session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
			expect(session.hasMCPToolSelectionAuthority()).toBe(false);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("re-evaluates discovery defaults after a catalog callback resumes from /new", async () => {
		await addDemoServer();
		const [defaultTool] = MCPTool.fromTools({ name: "demo" } as unknown as Parameters<typeof MCPTool.fromTools>[0], [
			{
				name: "late_default",
				description: "Late default tool",
				inputSchema: { type: "object", properties: {} },
			},
		]);
		if (!defaultTool) throw new Error("Default MCP regression tool was not created");
		vi.spyOn(MCPManager.prototype, "discoverAndConnect").mockResolvedValue({
			tools: [],
			errors: new Map(),
			connectedServers: ["demo"],
			exaApiKeys: [],
		});
		let publishToolsChanged: Parameters<MCPManager["setOnToolsChanged"]>[0] | undefined;
		const originalSetOnToolsChanged = MCPManager.prototype.setOnToolsChanged;
		vi.spyOn(MCPManager.prototype, "setOnToolsChanged").mockImplementation(function (this: MCPManager, handler) {
			publishToolsChanged = handler;
			return originalSetOnToolsChanged.call(this, handler);
		});
		const beforeSwitchStarted = Promise.withResolvers<void>();
		const releaseSwitchHook = Promise.withResolvers<void>();
		const replacementStarted = Promise.withResolvers<void>();
		let session: AgentSession | undefined;
		const originalReplaceNamedCustomTools = AgentSession.prototype.replaceNamedCustomTools;
		vi.spyOn(AgentSession.prototype, "replaceNamedCustomTools").mockImplementation(async function (
			this: AgentSession,
			previousNames,
			nextTools,
			options,
		) {
			if (this === session && nextTools.some(tool => tool.name === defaultTool.name)) {
				replacementStarted.resolve();
			}
			await originalReplaceNamedCustomTools.call(this, previousNames, nextTools, options);
		});

		const created = await createAgentSession({
			...isolatedSessionOptions(),
			toolNames: undefined,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDeferAutoload": true,
				"mcp.discoveryDefaultServers": ["demo"],
				"mcp.enableProjectConfig": true,
			}),
			extensions: [
				api => {
					api.on("session_before_switch", async () => {
						beforeSwitchStarted.resolve();
						await releaseSwitchHook.promise;
					});
				},
			],
		});
		session = created.session;
		try {
			if (!created.mcpManager) throw new Error("Expected the session-owned MCP manager");
			if (!publishToolsChanged) throw new Error("Expected the MCP catalog callback");
			expect(session.getAllToolNames()).not.toContain(defaultTool.name);
			await session.setActiveToolsByName(["read"], { persistMCPSelection: false });
			expect(session.hasMCPToolSelectionAuthority()).toBe(true);

			const transition = session.newSession();
			await beforeSwitchStarted.promise;
			publishToolsChanged([defaultTool]);
			await Promise.race([
				replacementStarted.promise,
				Bun.sleep(5_000).then(() => {
					throw new Error("Catalog replacement did not start during the session transition");
				}),
			]);
			releaseSwitchHook.resolve();
			expect(await transition).toBe(true);

			const activationDeadline = Date.now() + 5_000;
			while (!session.getActiveToolNames().includes(defaultTool.name)) {
				if (Date.now() > activationDeadline)
					throw new Error(`Discovery-default MCP tool was not activated: ${defaultTool.name}`);
				await Bun.sleep(20);
			}
			expect(session.hasMCPToolSelectionAuthority()).toBe(false);
		} finally {
			releaseSwitchHook.resolve();
			await session.dispose();
		}
	}, 30_000);

	it("keeps deferred-startup autoload tools inactive unless their server is a discovery default", async () => {
		await addDemoServer();
		for (const [defaults, expectActive] of [
			[[], false],
			[["demo"], true],
		] as const) {
			MCPManager.resetForTests();
			const { session, startDeferredMcpConfig } = await createAgentSession({
				...isolatedSessionOptions(),
				toolNames: undefined,
				settings: Settings.isolated({
					"mcp.discoveryMode": true,
					"mcp.discoveryDeferAutoload": true,
					"mcp.discoveryDefaultServers": [...defaults],
					"mcp.enableProjectConfig": true,
				}),
				deferMcpConfigStartup: true,
			});
			try {
				await expect(startDeferredMcpConfig!()).resolves.toEqual({ loadedToolCount: 1, hasErrors: false });
				expect(session.getAllToolNames()).toContain("mcp__demo_hello");
				expect(session.getActiveToolNames().includes("mcp__demo_hello")).toBe(expectActive);
			} finally {
				await session.dispose();
			}
		}
	}, 45_000);

	it("preserves an explicit empty MCP selection during deferred startup", async () => {
		await addDemoServer();
		const { session, startDeferredMcpConfig } = await createAgentSession({
			...isolatedSessionOptions(),
			toolNames: [],
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDeferAutoload": true,
				"mcp.discoveryDefaultServers": ["demo"],
				"mcp.enableProjectConfig": true,
			}),
			deferMcpConfigStartup: true,
		});
		try {
			await expect(startDeferredMcpConfig!()).resolves.toEqual({ loadedToolCount: 1, hasErrors: false });
			expect(session.getAllToolNames()).toContain("mcp__demo_hello");
			expect(session.getActiveToolNames()).not.toContain("mcp__demo_hello");
			expect(session.getSelectedMCPToolNames()).not.toContain("mcp__demo_hello");
		} finally {
			await session.dispose();
		}
	}, 45_000);

	it("preserves an explicit deferred MCP subset when its default server connects", async () => {
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					demo: {
						type: "stdio",
						command: process.execPath,
						args: ["-e", MULTI_TOOL_DEMO_MCP_SERVER_SCRIPT],
						timeout: 5_000,
					},
				},
			}),
		);
		const { session, startDeferredMcpConfig } = await createAgentSession({
			...isolatedSessionOptions(),
			toolNames: ["mcp__demo_hello"],
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDeferAutoload": true,
				"mcp.discoveryDefaultServers": ["demo"],
				"mcp.enableProjectConfig": true,
			}),
			deferMcpConfigStartup: true,
		});
		try {
			await expect(startDeferredMcpConfig!()).resolves.toEqual({ loadedToolCount: 2, hasErrors: false });
			expect(session.getAllToolNames()).toContain("mcp__demo_hello");
			expect(session.getAllToolNames()).toContain("mcp__demo_goodbye");
			expect(session.getActiveToolNames()).toContain("mcp__demo_hello");
			expect(session.getActiveToolNames()).not.toContain("mcp__demo_goodbye");
			expect(session.getSelectedMCPToolNames()).toEqual(["mcp__demo_hello"]);
			expect(session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(true);
		} finally {
			await session.dispose();
		}
	}, 45_000);

	it("activates late defaults for inherited sessions unless tools were explicitly deselected", async () => {
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		const fastDefaultServerConfig = {
			type: "stdio",
			command: process.execPath,
			args: ["-e", DEMO_MCP_SERVER_SCRIPT],
			timeout: 15_000,
		};
		await fs.promises.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"fast-default": fastDefaultServerConfig,
					"slow-default": {
						type: "stdio",
						command: process.execPath,
						args: ["-e", LATE_DEFAULT_MCP_SERVER_SCRIPT],
						timeout: 15_000,
					},
				},
			}),
		);

		const lateToolName = "mcp__slow_default_late_default";
		const inheritedToolChangeHandlers: Parameters<MCPManager["subscribeToToolsChanged"]>[0][] = [];
		const originalSubscribeToToolsChanged = MCPManager.prototype.subscribeToToolsChanged;
		vi.spyOn(MCPManager.prototype, "subscribeToToolsChanged").mockImplementation(function (
			this: MCPManager,
			handler,
		) {
			inheritedToolChangeHandlers.push(handler);
			return originalSubscribeToToolsChanged.call(this, handler);
		});
		const { session, mcpManager, startDeferredMcpConfig } = await createAgentSession({
			...isolatedSessionOptions(),
			toolNames: undefined,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDeferAutoload": true,
				"mcp.discoveryDefaultServers": ["fast-default", "slow-default"],
				"mcp.enableProjectConfig": true,
			}),
			deferMcpConfigStartup: true,
		});
		let inheritedSession: AgentSession | undefined;
		let explicitlyDeselectedSession: AgentSession | undefined;
		try {
			await expect(startDeferredMcpConfig!()).resolves.toEqual({ loadedToolCount: 1, hasErrors: false });
			if (!mcpManager) throw new Error("Expected the deferred session-owned manager");
			expect(mcpManager?.getConnectionStatus("slow-default")).toBe("connecting");
			expect(session.getAllToolNames()).toContain("mcp__fast_default_hello");
			expect(session.getActiveToolNames()).toContain("mcp__fast_default_hello");
			expect(session.getAllToolNames()).not.toContain(lateToolName);
			expect(session.getActiveToolNames()).not.toContain(lateToolName);
			const inheritedSettings = () =>
				Settings.isolated({
					"mcp.discoveryMode": true,
					"mcp.discoveryDeferAutoload": true,
					"mcp.discoveryDefaultServers": ["fast-default", "slow-default"],
					"mcp.enableProjectConfig": true,
				});
			inheritedSession = (
				await createAgentSession({
					...isolatedSessionOptions(),
					toolNames: ["read", "todo_write"],
					settings: inheritedSettings(),
					inheritedMcpManager: mcpManager,
					parentTaskPrefix: "0-Inherited",
				})
			).session;
			expect(inheritedSession.getActiveToolNames()).toContain("todo_write");
			await inheritedSession.setActiveToolsByName(
				inheritedSession.getActiveToolNames().filter(name => name !== "todo_write"),
				{ explicit: false, persistMCPSelection: false },
			);
			expect(inheritedSession.getActiveToolNames()).not.toContain("todo_write");
			expect(inheritedSession.hasMCPToolSelectionAuthority()).toBe(false);
			explicitlyDeselectedSession = (
				await createAgentSession({
					...isolatedSessionOptions(),
					toolNames: undefined,
					settings: inheritedSettings(),
					inheritedMcpManager: mcpManager,
					parentTaskPrefix: "1-Deselected",
				})
			).session;
			expect(inheritedSession.getActiveToolNames()).toContain("mcp__fast_default_hello");
			expect(explicitlyDeselectedSession.getActiveToolNames()).toContain("mcp__fast_default_hello");
			await explicitlyDeselectedSession.setActiveToolsByName(["read"]);
			expect(explicitlyDeselectedSession.getActiveToolNames()).not.toContain("mcp__fast_default_hello");

			const pendingAuthority = vi.spyOn(inheritedSession, "hasMCPToolSelectionAuthority").mockReturnValue(true);
			if (inheritedToolChangeHandlers.length === 0) {
				throw new Error("Expected an inherited MCP catalog callback");
			}
			for (const handler of inheritedToolChangeHandlers) handler(mcpManager.getTools());
			const activationDeadline = Date.now() + 15_000;
			while (
				!session.getActiveToolNames().includes(lateToolName) ||
				!inheritedSession.getAllToolNames().includes(lateToolName) ||
				!inheritedSession.getActiveToolNames().includes(lateToolName) ||
				!explicitlyDeselectedSession.getAllToolNames().includes(lateToolName)
			) {
				if (Date.now() > activationDeadline) {
					throw new Error(`Discovery-default MCP tool was not published and activated: ${lateToolName}`);
				}
				await Bun.sleep(20);
			}
			pendingAuthority.mockRestore();
			expect(session.getAllToolNames()).toContain(lateToolName);
			expect(session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
			expect(inheritedSession.getActiveToolNames()).toContain(lateToolName);
			expect(inheritedSession.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
			expect(explicitlyDeselectedSession.getActiveToolNames()).not.toContain("mcp__fast_default_hello");
			expect(explicitlyDeselectedSession.getActiveToolNames()).not.toContain(lateToolName);
			expect(explicitlyDeselectedSession.getSelectedMCPToolNames()).toEqual([]);
		} finally {
			await explicitlyDeselectedSession?.dispose();
			await inheritedSession?.dispose();
			await session.dispose();
		}
	}, 30_000);

	it("reevaluates discovery-default authority after starting a new session", async () => {
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"slow-default": {
						type: "stdio",
						command: process.execPath,
						args: ["-e", LATE_DEFAULT_MCP_SERVER_SCRIPT],
						timeout: 15_000,
					},
				},
			}),
		);
		const sessionManager = SessionManager.inMemory(projectDir);
		sessionManager.appendMCPToolSelection([]);
		const lateToolName = "mcp__slow_default_late_default";
		const { session, mcpManager, startDeferredMcpConfig } = await createAgentSession({
			...isolatedSessionOptions(),
			sessionManager,
			toolNames: undefined,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDeferAutoload": true,
				"mcp.discoveryDefaultServers": ["slow-default"],
				"mcp.enableProjectConfig": true,
			}),
			deferMcpConfigStartup: true,
		});
		try {
			await expect(startDeferredMcpConfig!()).resolves.toEqual({ loadedToolCount: 0, hasErrors: false });
			expect(session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(true);
			expect(mcpManager?.getConnectionStatus("slow-default")).toBe("connecting");
			await expect(session.newSession()).resolves.toBe(true);
			expect(session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);

			const activationDeadline = Date.now() + 15_000;
			while (!session.getActiveToolNames().includes(lateToolName)) {
				if (Date.now() > activationDeadline) {
					throw new Error(`New session did not apply its configured MCP default: ${lateToolName}`);
				}
				await Bun.sleep(20);
			}
			expect(session.getAllToolNames()).toContain(lateToolName);
			expect(session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
		} finally {
			await session.dispose();
		}
	}, 45_000);

	it("loads persisted cached conventional tools through the session-owned manager", async () => {
		await runMCPCommand({
			action: "add",
			name: "slow-demo",
			commandArgs: [process.execPath, "-e", DELAYED_MCP_SERVER_SCRIPT],
			flags: { project: true, timeout: 1_000 },
			cwd: projectDir,
		});

		const configPath = path.join(projectDir, ".gjc", "mcp.json");
		const configDocument = JSON.parse(await fs.promises.readFile(configPath, "utf8")) as {
			mcpServers: Record<string, Record<string, unknown>>;
		};
		delete configDocument.mcpServers["slow-demo"]?.timeout;
		await fs.promises.writeFile(configPath, JSON.stringify(configDocument, null, 2));
		const connectSpy = vi.spyOn(mcpClient, "connectToServer").mockImplementation(() => new Promise<never>(() => {}));

		const sessionAgentDir = path.join(tempHome, ".gjc", "session-profile");
		await fs.promises.mkdir(sessionAgentDir, { recursive: true });
		const options = { ...isolatedSessionOptions(), agentDir: sessionAgentDir };
		const loaded = await loadAllMCPConfigs(projectDir, {
			agentDir: sessionAgentDir,
			enableProjectConfig: true,
			autoloadOnly: true,
			nativeOnly: true,
			settings: options.settings,
		});
		const config = loaded.configs["slow-demo"];
		if (!config) throw new Error("slow-demo config was not loaded");

		const storage = await AgentStorage.open(getAgentDbPath(sessionAgentDir), { isolated: true });
		try {
			await new MCPToolCache(storage).set("slow-demo", config, [
				{ name: "cached_hello", inputSchema: { type: "object", properties: {} } },
			]);

			const { session, mcpManager } = await createAgentSession(options);
			try {
				expect(connectSpy).toHaveBeenCalledTimes(1);
				expect(mcpManager).toBeDefined();
				const cachedTool = mcpManager?.getTools().find(tool => tool.name === "mcp__slow_demo_cached_hello");
				expect(cachedTool).toBeInstanceOf(DeferredMCPTool);
				expect(session.getAllToolNames()).toContain("mcp__slow_demo_cached_hello");
				expect(session.getActiveToolNames()).toContain("mcp__slow_demo_cached_hello");
			} finally {
				await session.dispose();
			}
		} finally {
			storage.close();
		}
	}, 30_000);

	it("uses the session cache when rebuilding conventional MCP authority after a cwd move", async () => {
		const sourceCwd = path.join(projectDir, "move-source");
		const targetCwd = path.join(sourceCwd, "move-target");
		await fs.promises.mkdir(sourceCwd, { recursive: true });
		await fs.promises.mkdir(path.join(targetCwd, ".gjc"), { recursive: true });
		await fs.promises.writeFile(
			path.join(targetCwd, ".gjc", "mcp.json"),
			JSON.stringify({ mcpServers: { "slow-target": { type: "http", url: "http://127.0.0.1:1" } } }),
		);

		const sessionManager = SessionManager.create(sourceCwd, SessionManager.managedDestination(sourceCwd, projectDir));
		const options = { ...isolatedSessionOptions(), cwd: sourceCwd, sessionManager, toolNames: ["move_session"] };
		const loaded = await loadAllMCPConfigs(targetCwd, {
			agentDir,
			enableProjectConfig: true,
			autoloadOnly: true,
			nativeOnly: true,
			settings: options.settings,
		});
		const config = loaded.configs["slow-target"];
		if (!config) throw new Error("slow-target config was not loaded");
		const storage = await AgentStorage.open(getAgentDbPath(agentDir));
		const connectSpy = vi.spyOn(mcpClient, "connectToServer").mockImplementation(() => new Promise<never>(() => {}));
		try {
			await new MCPToolCache(storage).set("slow-target", config, [
				{ name: "cached_hello", inputSchema: { type: "object", properties: {} } },
			]);
			const { session } = await createAgentSession(options);
			try {
				await session.getToolByName("move_session")!.execute("move-with-cache", { path: "move-target" });
				expect(connectSpy).toHaveBeenCalledTimes(1);
				const cachedTool = session.getToolByName("mcp__slow_target_cached_hello");
				expect(cachedTool).toBeDefined();
				expect(session.getAllToolNames()).toContain("mcp__slow_target_cached_hello");
			} finally {
				await session.dispose();
			}
		} finally {
			storage.close();
		}
	}, 30_000);

	it("keeps conventional autoload tools deferred when rebuilding MCP authority after a cwd move", async () => {
		const sourceCwd = path.join(projectDir, "move-source");
		const targetCwd = path.join(sourceCwd, "move-target");
		await fs.promises.mkdir(path.join(targetCwd, ".gjc"), { recursive: true });
		const serverConfig = {
			type: "stdio",
			command: process.execPath,
			args: ["-e", DEMO_MCP_SERVER_SCRIPT],
			timeout: 5_000,
		};
		await fs.promises.writeFile(
			path.join(targetCwd, ".gjc", "mcp.json"),
			JSON.stringify({ mcpServers: { autoload: serverConfig, default: serverConfig } }),
		);

		const originalProcessCwd = process.cwd();
		const sessionManager = SessionManager.create(sourceCwd, SessionManager.managedDestination(sourceCwd, projectDir));
		const { session } = await createAgentSession({
			...isolatedSessionOptions(),
			cwd: sourceCwd,
			sessionManager,
			toolNames: ["move_session"],
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDeferAutoload": true,
				"mcp.discoveryDefaultServers": ["default"],
				"mcp.enableProjectConfig": true,
			}),
		});
		try {
			await session.getToolByName("move_session")!.execute("move-with-deferred-autoload", { path: "move-target" });
			expect(session.getAllToolNames()).toContain("mcp__autoload_hello");
			expect(session.getAllToolNames()).toContain("mcp__default_hello");
			expect(session.getActiveToolNames()).toContain("mcp__default_hello");
			expect(session.getActiveToolNames()).not.toContain("mcp__autoload_hello");
		} finally {
			await session.dispose();
			process.chdir(originalProcessCwd);
		}
	}, 30_000);

	it("reselects the current conventional catalog on /new after a cwd move", async () => {
		const sourceCwd = path.join(projectDir, "move-source");
		const targetCwd = path.join(sourceCwd, "move-target");
		await fs.promises.mkdir(path.join(targetCwd, ".gjc"), { recursive: true });
		const serverConfig = {
			type: "stdio",
			command: process.execPath,
			args: ["-e", DEMO_MCP_SERVER_SCRIPT],
			timeout: 5_000,
		};
		await fs.promises.writeFile(
			path.join(targetCwd, ".gjc", "mcp.json"),
			JSON.stringify({ mcpServers: { autoload: serverConfig } }),
		);

		const originalProcessCwd = process.cwd();
		const sessionManager = SessionManager.create(sourceCwd, SessionManager.managedDestination(sourceCwd, projectDir));
		const { session } = await createAgentSession({
			...isolatedSessionOptions(),
			cwd: sourceCwd,
			sessionManager,
			toolNames: ["move_session"],
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDeferAutoload": false,
				"mcp.enableProjectConfig": true,
			}),
		});
		try {
			await session.getToolByName("move_session")!.execute("move-with-autoload", { path: "move-target" });
			expect(session.getActiveToolNames()).toContain("mcp__autoload_hello");

			await expect(session.newSession()).resolves.toBe(true);

			expect(session.getAllToolNames()).toContain("mcp__autoload_hello");
			expect(session.getActiveToolNames()).toContain("mcp__autoload_hello");
			expect(session.buildDisplaySessionContext().hasPersistedMCPToolSelection).toBe(false);
		} finally {
			await session.dispose();
			process.chdir(originalProcessCwd);
		}
	}, 30_000);

	const demoMcpConfig = JSON.stringify({
		mcpServers: {
			autoload: { type: "stdio", command: process.execPath, args: ["-e", DEMO_MCP_SERVER_SCRIPT], timeout: 5_000 },
		},
	});

	/** Install a project plugin in `cwd` whose tool is named like the demo server's MCP tool. */
	async function installMcpNamedPluginTool(cwd: string): Promise<void> {
		const bundle = path.join(tempHome, "name-plugin");
		await fs.promises.mkdir(path.join(bundle, "tools"), { recursive: true });
		await fs.promises.writeFile(
			path.join(bundle, "gajae-plugin.json"),
			JSON.stringify({
				kind: "gajae-code-plugin",
				name: "name-plugin",
				version: "1.0.0",
				tools: [{ name: "mcp__autoload_hello", path: "tools/hello.ts", description: "Plugin hello" }],
			}),
		);
		await fs.promises.writeFile(
			path.join(bundle, "tools", "hello.ts"),
			`export default function hello(pi: any) {
	return {
		name: "mcp__autoload_hello",
		label: "Plugin hello",
		description: "Plugin hello",
		parameters: pi.typebox.Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "plugin-hello" }] };
		},
	};
}
`,
		);
		expect((await installGjcBundle({ cwd }, "project", bundle)).ok).toBe(true);
	}

	it("lets a target MCP tool replace a same-named tool of the cwd it leaves", async () => {
		const sourceCwd = path.join(projectDir, "move-source");
		const targetCwd = path.join(sourceCwd, "move-target");
		await fs.promises.mkdir(path.join(targetCwd, ".gjc"), { recursive: true });
		await fs.promises.writeFile(path.join(targetCwd, ".gjc", "mcp.json"), demoMcpConfig);
		// The source cwd's project plugin owns a tool under the name the target MCP server publishes.
		await installMcpNamedPluginTool(sourceCwd);

		const originalProcessCwd = process.cwd();
		const sessionManager = SessionManager.create(sourceCwd, SessionManager.managedDestination(sourceCwd, projectDir));
		const { session } = await createAgentSession({
			...isolatedSessionOptions(),
			cwd: sourceCwd,
			sessionManager,
			toolNames: ["move_session"],
			settings: Settings.isolated({ "mcp.discoveryDeferAutoload": false, "mcp.enableProjectConfig": true }),
		});
		try {
			const before = session.getToolByName("mcp__autoload_hello");
			expect(before && isMCPBridgeTool(before)).toBe(false);
			const warn = vi.spyOn(logger, "warn");

			await session.getToolByName("move_session")!.execute("move-over-plugin-name", { path: "move-target" });

			// The retiring plugin tool never holds the name, not even until the old tools are removed.
			expect(warn.mock.calls.map(call => call[0])).not.toContain(
				"Skipping MCP tool whose name is already registered by another tool",
			);

			const after = session.getToolByName("mcp__autoload_hello");
			expect(after && isMCPBridgeTool(after)).toBe(true);
			expect(session.getActiveToolNames()).toContain("mcp__autoload_hello");
		} finally {
			await session.dispose();
			process.chdir(originalProcessCwd);
		}
	}, 30_000);

	it("removes a plugin tool of the cwd it leaves when the target has no tool of that name", async () => {
		const sourceCwd = path.join(projectDir, "move-source");
		const targetCwd = path.join(sourceCwd, "move-target");
		await fs.promises.mkdir(path.join(targetCwd, ".gjc"), { recursive: true });
		await installMcpNamedPluginTool(sourceCwd);

		const originalProcessCwd = process.cwd();
		const sessionManager = SessionManager.create(sourceCwd, SessionManager.managedDestination(sourceCwd, projectDir));
		const { session } = await createAgentSession({
			...isolatedSessionOptions(),
			cwd: sourceCwd,
			sessionManager,
			toolNames: ["move_session"],
			settings: Settings.isolated({ "mcp.discoveryDeferAutoload": false, "mcp.enableProjectConfig": true }),
		});
		try {
			expect(session.getToolByName("mcp__autoload_hello")).toBeDefined();

			await session.getToolByName("move_session")!.execute("move-off-plugin", { path: "move-target" });

			expect(session.getToolByName("mcp__autoload_hello")).toBeUndefined();
		} finally {
			await session.dispose();
			process.chdir(originalProcessCwd);
		}
	}, 30_000);

	it("keeps an SDK custom tool that shares a name with the source and target MCP catalogs", async () => {
		const sourceCwd = path.join(projectDir, "move-source");
		const targetCwd = path.join(sourceCwd, "move-target");
		await fs.promises.mkdir(path.join(sourceCwd, ".gjc"), { recursive: true });
		await fs.promises.mkdir(path.join(targetCwd, ".gjc"), { recursive: true });
		await fs.promises.writeFile(path.join(sourceCwd, ".gjc", "mcp.json"), demoMcpConfig);
		await fs.promises.writeFile(path.join(targetCwd, ".gjc", "mcp.json"), demoMcpConfig);
		const sdkTool = {
			name: "mcp__autoload_hello",
			label: "SDK hello",
			description: "SDK hello",
			parameters: z.object({}),
			async execute() {
				return { content: [{ type: "text", text: "LIVE_SDK_TOOL" }] };
			},
		} as CustomTool;

		const originalProcessCwd = process.cwd();
		const sessionManager = SessionManager.create(sourceCwd, SessionManager.managedDestination(sourceCwd, projectDir));
		const { session } = await createAgentSession({
			...isolatedSessionOptions(),
			cwd: sourceCwd,
			sessionManager,
			toolNames: ["move_session"],
			customTools: [sdkTool],
			settings: Settings.isolated({ "mcp.discoveryDeferAutoload": false, "mcp.enableProjectConfig": true }),
		});
		try {
			const before = session.getToolByName("mcp__autoload_hello");
			expect(before && isMCPBridgeTool(before)).toBe(false);
			expect(JSON.stringify((await before!.execute("sdk-before", {} as never)).content)).toContain("LIVE_SDK_TOOL");
			expect(session.getActiveToolNames()).toContain("mcp__autoload_hello");

			await session.getToolByName("move_session")!.execute("move-past-sdk-tool", { path: "move-target" });

			const after = session.getToolByName("mcp__autoload_hello");
			expect(after).toBe(before);
			expect(session.getActiveToolNames()).toContain("mcp__autoload_hello");
			expect(JSON.stringify((await after!.execute("sdk-after", {} as never)).content)).toContain("LIVE_SDK_TOOL");
		} finally {
			await session.dispose();
			process.chdir(originalProcessCwd);
		}
	}, 30_000);

	for (const owner of ["SDK custom tool", "extension tool"] as const) {
		it(`keeps an ${owner} when the target cwd's plugin claims its name`, async () => {
			const sourceCwd = path.join(projectDir, "move-source");
			const targetCwd = path.join(sourceCwd, "move-target");
			await fs.promises.mkdir(path.join(sourceCwd, ".gjc"), { recursive: true });
			await fs.promises.mkdir(path.join(targetCwd, ".gjc"), { recursive: true });
			// The source MCP catalog advertises the live tool's name, so the name is cwd-captured.
			await fs.promises.writeFile(path.join(sourceCwd, ".gjc", "mcp.json"), demoMcpConfig);
			await installMcpNamedPluginTool(targetCwd);
			const liveTool = {
				name: "mcp__autoload_hello",
				label: "Live hello",
				description: "Live hello",
				parameters: z.object({}),
				async execute() {
					return { content: [{ type: "text" as const, text: "LIVE_OWNER_TOOL" }] };
				},
			};

			const originalProcessCwd = process.cwd();
			const sessionManager = SessionManager.create(
				sourceCwd,
				SessionManager.managedDestination(sourceCwd, projectDir),
			);
			// Deferred startup publishes the source MCP catalog after the live tool is registered.
			const { session, startDeferredMcpConfig } = await createAgentSession({
				...isolatedSessionOptions(),
				cwd: sourceCwd,
				sessionManager,
				toolNames: ["move_session"],
				deferMcpConfigStartup: true,
				...(owner === "SDK custom tool"
					? { customTools: [liveTool as CustomTool] }
					: { extensions: [api => api.registerTool(liveTool)] }),
				settings: Settings.isolated({ "mcp.discoveryDeferAutoload": false, "mcp.enableProjectConfig": true }),
			});
			try {
				await startDeferredMcpConfig!();
				const before = session.getToolByName("mcp__autoload_hello");
				expect(before && isMCPBridgeTool(before)).toBe(false);
				expect(session.getActiveToolNames()).toContain("mcp__autoload_hello");

				await session.getToolByName("move_session")!.execute("move-onto-plugin", { path: "move-target" });

				const after = session.getToolByName("mcp__autoload_hello");
				expect(after).toBe(before);
				expect(session.getActiveToolNames()).toContain("mcp__autoload_hello");
				const result = await after!.execute("call-live-owner", {} as never);
				expect(JSON.stringify(result.content)).toContain("LIVE_OWNER_TOOL");
			} finally {
				await session.dispose();
				process.chdir(originalProcessCwd);
			}
		}, 30_000);
	}

	it("keeps a same-named plugin tool that the target cwd also provides", async () => {
		const sourceCwd = path.join(projectDir, "move-source");
		const targetCwd = path.join(sourceCwd, "move-target");
		await fs.promises.mkdir(path.join(targetCwd, ".gjc"), { recursive: true });
		await fs.promises.writeFile(path.join(targetCwd, ".gjc", "mcp.json"), demoMcpConfig);
		await installMcpNamedPluginTool(sourceCwd);
		await installMcpNamedPluginTool(targetCwd);

		const originalProcessCwd = process.cwd();
		const sessionManager = SessionManager.create(sourceCwd, SessionManager.managedDestination(sourceCwd, projectDir));
		const { session } = await createAgentSession({
			...isolatedSessionOptions(),
			cwd: sourceCwd,
			sessionManager,
			toolNames: ["move_session"],
			settings: Settings.isolated({ "mcp.discoveryDeferAutoload": false, "mcp.enableProjectConfig": true }),
		});
		try {
			await session.getToolByName("move_session")!.execute("move-onto-plugin-name", { path: "move-target" });

			const after = session.getToolByName("mcp__autoload_hello");
			expect(after && isMCPBridgeTool(after)).toBe(false);
			const result = await after!.execute("call-kept-plugin", {} as never);
			expect(JSON.stringify(result.content)).toContain("plugin-hello");
		} finally {
			await session.dispose();
			process.chdir(originalProcessCwd);
		}
	}, 30_000);

	it("never activates an inactive non-MCP tool through a mandatory MCP name", async () => {
		const name = "mcp__domain_docs_lookup";
		const extensionTool = {
			name,
			label: "Extension lookup",
			description: "Extension lookup",
			parameters: z.object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "EXTENSION_LOOKUP" }] };
			},
		};
		// A plugin-bundle MCP tool that advertises the same name and is mandatory.
		const pluginMcpTool = {
			...extensionTool,
			label: "Plugin MCP lookup",
			mcpServerName: "domain_docs",
			mcpToolName: "lookup",
			gjcPluginBundle: true,
		} as CustomTool;
		const { session } = await createAgentSession({
			...isolatedSessionOptions(),
			extensions: [api => api.registerTool(extensionTool)],
		});
		try {
			const owner = session.getToolByName(name);
			expect(owner && isMCPBridgeTool(owner)).toBe(false);
			await session.setActiveToolsByName(session.getActiveToolNames().filter(active => active !== name));
			expect(session.getActiveToolNames()).not.toContain(name);

			await session.refreshMCPTools([pluginMcpTool], { mandatoryMCPToolNames: [name] });
			expect(session.getToolByName(name)).toBe(owner);
			expect(session.getActiveToolNames()).not.toContain(name);

			await session.replaceNamedCustomTools([], [pluginMcpTool], { mandatoryMCPToolNames: [name] });
			expect(session.getToolByName(name)).toBe(owner);
			expect(session.getActiveToolNames()).not.toContain(name);
		} finally {
			await session.dispose();
		}
	});

	it("retains a declared-timeout MCP manager and publishes tools after background connection", async () => {
		await runMCPCommand({
			action: "add",
			name: "slow-demo",
			commandArgs: [process.execPath, "-e", DELAYED_MCP_SERVER_SCRIPT],
			flags: { project: true, timeout: 5_000 },
			cwd: projectDir,
		});

		const published = Promise.withResolvers<void>();
		const originalReplace = AgentSession.prototype.replaceNamedCustomTools;
		vi.spyOn(AgentSession.prototype, "replaceNamedCustomTools").mockImplementation(async function (
			this: AgentSession,
			previousNames,
			nextTools,
		) {
			await originalReplace.call(this, previousNames, nextTools);
			if (nextTools.some(tool => tool.name === "mcp__slow_demo_late_hello")) published.resolve();
		});

		const startedAt = Date.now();
		const { session, mcpManager } = await createAgentSession(isolatedSessionOptions());
		try {
			// Startup ceiling for a declared 5s timeout is max(250, 5000+500) = 5.5s.
			// Wall-clock assertions are load-sensitive (CI shards / shared hosts), so
			// the hard contract lives in the status assertions below; this bound only
			// guards the gross "blocked until connected" failure mode (>= 5.5s).
			expect(Date.now() - startedAt).toBeLessThan(5_500);
			expect(mcpManager).toBeDefined();
			const startupStatus = mcpManager?.getConnectionStatus("slow-demo");
			if (!startupStatus) throw new Error("slow-demo status was not published");
			expect(["connecting", "connected"]).toContain(startupStatus);
			// This integration case deliberately crosses the real MCP startup ceiling;
			// await the publication callback rather than sleeping for a guessed duration.
			await published.promise;
			expect(mcpManager?.getConnectedServers()).toContain("slow-demo");
			expect(session.getAllToolNames()).toContain("mcp__slow_demo_late_hello");
			expect(session.getActiveToolNames()).toContain("mcp__slow_demo_late_hello");
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("re-seals a mixed plugin + conventional manager once the late conventional server settles", async () => {
		await runMCPCommand({
			action: "add",
			name: "slow-demo",
			commandArgs: [process.execPath, "-e", DELAYED_MCP_SERVER_SCRIPT],
			flags: { project: true, timeout: 5_000 },
			cwd: projectDir,
		});

		const { session, mcpManager } = await createAgentSession(isolatedSessionOptions());
		try {
			expect(mcpManager).toBeDefined();
			// Publication may still be connecting or may have completed before this
			// observer runs on a loaded host; both states preserve the reseal contract.
			const startupStatus = mcpManager?.getConnectionStatus("slow-demo");
			if (!startupStatus) throw new Error("slow-demo status was not published");
			expect(["connecting", "connected"]).toContain(startupStatus);
			// Drain publication via the session registry rather than a fixed sleep.
			const deadline = Date.now() + 30_000;
			while (!session.getAllToolNames().includes("mcp__slow_demo_late_hello")) {
				if (Date.now() > deadline) throw new Error("late conventional tool was never published");
				await Bun.sleep(100);
			}
			expect(mcpManager?.getConnectedServers()).toContain("slow-demo");
		} finally {
			await session.dispose();
		}
	}, 45_000);

	it("defers conventional autoload connection until the deferred startup handle runs", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await runMCPCommand({
			action: "add",
			name: "demo",
			commandArgs: [process.execPath, "-e", DEMO_MCP_SERVER_SCRIPT],
			flags: { project: true, timeout: 5_000 },
			cwd: projectDir,
		});
		stdout.mockRestore();

		const { session, mcpManager, startDeferredMcpConfig } = await createAgentSession({
			...isolatedSessionOptions(),
			deferMcpConfigStartup: true,
		});
		try {
			// The manager publishes immediately (empty) so /mcp can see it; the
			// connection itself happens in the deferred starter.
			expect(mcpManager).toBeDefined();
			expect(mcpManager?.getConnectedServers() ?? []).toEqual([]);
			expect(startDeferredMcpConfig).toBeDefined();
			expect(session.getAllToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);

			const startup = startDeferredMcpConfig!();
			await expect(startup).resolves.toEqual({ loadedToolCount: 1, hasErrors: false });
			expect(session.getAllToolNames()).toContain("mcp__demo_hello");
			expect(session.getActiveToolNames()).toContain("mcp__demo_hello");
			expect(mcpManager?.getConnectedServers()).toContain("demo");
			expect(startDeferredMcpConfig!()).toBe(startup);
		} finally {
			await session.dispose();
		}
	}, 45_000);

	it("reconciles the current conventional catalog after deferred registration yields", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await runMCPCommand({
			action: "add",
			name: "demo",
			commandArgs: [process.execPath, "-e", DEMO_MCP_SERVER_SCRIPT],
			flags: { project: true, timeout: 5_000 },
			cwd: projectDir,
		});
		stdout.mockRestore();

		const [startupTool] = MCPTool.fromTools({ name: "demo" } as unknown as Parameters<typeof MCPTool.fromTools>[0], [
			{ name: "hello", inputSchema: { type: "object", properties: {} } },
		]);
		const [lateTool] = MCPTool.fromTools({ name: "demo" } as unknown as Parameters<typeof MCPTool.fromTools>[0], [
			{ name: "late_lookup", inputSchema: { type: "object", properties: {} } },
		]);
		if (!startupTool || !lateTool) throw new Error("MCP regression tools were not created");
		vi.spyOn(MCPManager.prototype, "connectServers").mockResolvedValue({
			tools: [startupTool],
			errors: new Map(),
			connectedServers: ["demo"],
			exaApiKeys: [],
		});

		const { session, mcpManager, startDeferredMcpConfig } = await createAgentSession({
			...isolatedSessionOptions(),
			toolNames: ["mcp__demo_late_lookup"],
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDeferAutoload": true,
				"mcp.discoveryDefaultServers": [],
				"mcp.enableProjectConfig": true,
			}),
			deferMcpConfigStartup: true,
		});
		try {
			if (!mcpManager) throw new Error("Expected the deferred session-owned manager");
			if (!startDeferredMcpConfig) throw new Error("Expected a deferred startup handle");
			let lateCatalogPublished = false;
			vi.spyOn(mcpManager, "getToolCatalogSnapshot").mockImplementation(() => ({
				tools: lateCatalogPublished ? [startupTool, lateTool] : [startupTool],
				publication: "published",
				generation: lateCatalogPublished ? 2 : 1,
			}));
			const originalRefreshMCPTools = AgentSession.prototype.refreshMCPTools;
			vi.spyOn(AgentSession.prototype, "refreshMCPTools").mockImplementation(async function (
				this: AgentSession,
				tools,
				options,
			) {
				await originalRefreshMCPTools.call(this, tools, options);
				if (this === session) lateCatalogPublished = true;
			});
			const lateToolReconciled = Promise.withResolvers<void>();
			const originalReplaceNamedCustomTools = AgentSession.prototype.replaceNamedCustomTools;
			vi.spyOn(AgentSession.prototype, "replaceNamedCustomTools").mockImplementation(async function (
				this: AgentSession,
				previousNames,
				nextTools,
				options,
			) {
				await originalReplaceNamedCustomTools.call(this, previousNames, nextTools, options);
				if (this === session && nextTools.some(tool => tool.name === lateTool.name)) {
					lateToolReconciled.resolve();
				}
			});

			await expect(startDeferredMcpConfig()).resolves.toEqual({ loadedToolCount: 1, hasErrors: false });
			await lateToolReconciled.promise;
			expect(session.getAllToolNames()).toContain(lateTool.name);
			expect(session.getActiveToolNames()).toContain(lateTool.name);
			expect(session.getSelectedMCPToolNames()).toEqual([lateTool.name]);
			expect(session.buildDisplaySessionContext().selectedMCPToolNames).toEqual([lateTool.name]);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("holds the first prompt until deferred conventional startup completes", async () => {
		// The gated prompt passes model-credential preflight once the barrier
		// releases; mirror the sdk deferred-MCP harness's throwaway key.
		authStorage.setRuntimeApiKey("openai", "test-key");
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					demo: {
						type: "stdio",
						command: process.execPath,
						args: ["-e", DEMO_MCP_SERVER_SCRIPT],
						timeout: 5_000,
					},
				},
			}),
		);
		const connect = Promise.withResolvers<MCPLoadResult>();
		vi.spyOn(MCPManager.prototype, "connectServers").mockImplementation(async () => await connect.promise);

		const { session, mcpManager, startDeferredMcpConfig } = await createAgentSession({
			...isolatedSessionOptions(),
			deferMcpConfigStartup: true,
		});
		try {
			expect(mcpManager).toBeDefined();
			const agentPrompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
			const prompt = session.prompt("wait for deferred conventional MCP");
			await Bun.sleep(0);
			expect(agentPrompt).not.toHaveBeenCalled();

			connect.resolve({
				tools: [],
				errors: new Map(),
				connectedServers: ["demo"],
				exaApiKeys: [],
			});
			// Zero delivered tools reports hasErrors under the same convention the
			// deferred exact-config handle uses; the barrier still releases.
			await expect(startDeferredMcpConfig!()).resolves.toEqual({ loadedToolCount: 0, hasErrors: true });
			await prompt;
			expect(agentPrompt).toHaveBeenCalledTimes(1);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("preserves persisted conventional MCP selections while the deferred catalog is pending", async () => {
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					demo: {
						type: "stdio",
						command: process.execPath,
						args: ["-e", DEMO_MCP_SERVER_SCRIPT],
						timeout: 5_000,
					},
				},
			}),
		);

		// Seed a session whose persisted MCP discovery selection names the conventional
		// tool, then resume it under deferral, where the registry is empty until the
		// starter connects. Pruning at construction would silently drop the selection
		// and the resumed catalog could never restore it.
		const seededManager = SessionManager.create(projectDir, projectDir);
		seededManager.appendMCPToolSelection(["mcp__demo_hello"]);
		const { session, startDeferredMcpConfig } = await createAgentSession({
			...isolatedSessionOptions(),
			sessionManager: seededManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true, "mcp.enableProjectConfig": true }),
			deferMcpConfigStartup: true,
		});
		try {
			expect(session.sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__demo_hello"]);
			await expect(startDeferredMcpConfig!()).resolves.toEqual({ loadedToolCount: 1, hasErrors: false });
			expect(session.getSelectedMCPToolNames()).toEqual(["mcp__demo_hello"]);
			expect(session.getActiveToolNames()).toContain("mcp__demo_hello");
		} finally {
			await session.dispose();
		}
	}, 45_000);

	it("releases the first-prompt barrier when deferred conventional startup fails", async () => {
		authStorage.setRuntimeApiKey("openai", "test-key");
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					demo: {
						type: "stdio",
						command: process.execPath,
						args: ["-e", DEMO_MCP_SERVER_SCRIPT],
						timeout: 5_000,
					},
				},
			}),
		);
		vi.spyOn(MCPManager.prototype, "connectServers").mockRejectedValue(new Error("connect failed"));
		vi.spyOn(MCPManager.prototype, "disconnectAll").mockResolvedValue();

		const { session, startDeferredMcpConfig } = await createAgentSession({
			...isolatedSessionOptions(),
			deferMcpConfigStartup: true,
		});
		try {
			// The connect failure is still reported through the returned handle...
			await expect(startDeferredMcpConfig!()).rejects.toThrow("MCP tools could not be loaded.");
			// ...but the startup turn barrier must release, or every later prompt would
			// await a permanently rejected barrier and the session would be unusable.
			const agentPrompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
			await session.prompt("prompt after failed deferred conventional startup");
			expect(agentPrompt).toHaveBeenCalledTimes(1);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("retains the manager that owns cached tools after startup timeout", async () => {
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({ mcpServers: { cached: { type: "stdio", command: process.execPath } } }),
		);
		const [cachedTool] = DeferredMCPTool.fromTools(
			"cached",
			[{ name: "hello", inputSchema: { type: "object", properties: {} } }],
			async () => {
				throw new Error("cached server is disconnected");
			},
		);
		if (!cachedTool) throw new Error("cached MCP tool was not created");
		vi.spyOn(MCPManager.prototype, "connectServers").mockResolvedValue({
			tools: [cachedTool],
			errors: new Map([["cached", "MCP server connection timed out during startup: cached"]]),
			connectedServers: [],
			exaApiKeys: [],
		});
		vi.spyOn(MCPManager.prototype, "getTools").mockReturnValue([cachedTool]);
		const disconnectAll = vi.spyOn(MCPManager.prototype, "disconnectAll").mockResolvedValue();

		const { session, mcpManager } = await createAgentSession(isolatedSessionOptions());
		try {
			expect(mcpManager).toBeDefined();
			expect(session.getAllToolNames()).toContain("mcp__cached_hello");
			expect(session.getActiveToolNames()).toContain("mcp__cached_hello");
			expect(disconnectAll).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("does not warn again for an MCP startup timeout already returned as an error", async () => {
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					stuck: { type: "stdio", command: process.execPath },
				},
			}),
		);
		vi.spyOn(MCPManager.prototype, "connectServers").mockResolvedValue({
			tools: [],
			errors: new Map([["stuck", "MCP server connection timed out during startup: stuck"]]),
			connectedServers: [],
			exaApiKeys: [],
		});
		vi.spyOn(MCPManager.prototype, "disconnectAll").mockResolvedValue();
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const { session } = await createAgentSession(isolatedSessionOptions());
		try {
			expect(warnSpy.mock.calls.some(([message]) => String(message).includes("GJC plugin MCP connect failed"))).toBe(
				false,
			);
		} finally {
			await session.dispose();
			warnSpy.mockRestore();
		}
	}, 30_000);

	it("keeps remote MCP error details out of conventional startup logs", async () => {
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					upstream: { type: "stdio", command: process.execPath },
				},
			}),
		);
		const remoteSecret = "remote-secret-502-response";
		const remoteError = `HTTP 502: upstream response contains ${remoteSecret}`;
		const startupResult: MCPLoadResult = {
			tools: [],
			errors: new Map([["upstream", remoteError]]),
			connectedServers: [],
			exaApiKeys: [],
		};
		vi.spyOn(MCPManager.prototype, "connectServers").mockResolvedValue(startupResult);
		vi.spyOn(MCPManager.prototype, "disconnectAll").mockResolvedValue();
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const { session } = await createAgentSession(isolatedSessionOptions());
		try {
			const startupWarning = warnSpy.mock.calls.find(([message]) =>
				String(message).includes("MCP server connection failed"),
			);
			if (!startupWarning) throw new Error("conventional MCP startup warning was not logged");
			expect(startupWarning[1]).toMatchObject({ path: "mcp:upstream", error: "transport-error" });
			expect(JSON.stringify(startupWarning)).not.toContain(remoteSecret);
			// The session logger does not rewrite the manager result's details.
			expect(startupResult.errors.get("upstream")).toBe(remoteError);
		} finally {
			await session.dispose();
			warnSpy.mockRestore();
		}
	}, 30_000);

	it("opts out with enableMcpAutoload: false (CLI --no-mcp) without loading conventional registrations", async () => {
		await runMCPCommand({
			action: "add",
			name: "demo",
			commandArgs: [process.execPath, "-e", DEMO_MCP_SERVER_SCRIPT],
			flags: { project: true, timeout: 5_000 },
			cwd: projectDir,
		});

		const { session, mcpManager } = await createAgentSession({
			...isolatedSessionOptions(),
			enableMcpAutoload: false,
		});
		try {
			expect(mcpManager).toBeUndefined();
			expect(session.getAllToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("does not load a disabled or autoload:false registration at startup", async () => {
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					disabled: {
						type: "stdio",
						command: process.execPath,
						args: ["-e", DEMO_MCP_SERVER_SCRIPT],
						enabled: false,
						timeout: 5_000,
					},
					lazy: {
						type: "stdio",
						command: process.execPath,
						args: ["-e", DEMO_MCP_SERVER_SCRIPT],
						autoload: false,
						timeout: 5_000,
					},
					denied: {
						type: "stdio",
						command: process.execPath,
						args: ["-e", DEMO_MCP_SERVER_SCRIPT],
						timeout: 5_000,
					},
				},
				disabledServers: ["denied"],
			}),
		);

		const { session, mcpManager } = await createAgentSession(isolatedSessionOptions());
		try {
			expect(mcpManager).toBeUndefined();
			expect(session.getAllToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("subagents inherit the autoloaded MCP tools without duplicating server processes or owning cleanup", async () => {
		await runMCPCommand({
			action: "add",
			name: "demo",
			commandArgs: [process.execPath, "-e", DEMO_MCP_SERVER_SCRIPT],
			flags: { project: true, timeout: 5_000 },
			cwd: projectDir,
		});

		const parent = await createAgentSession(isolatedSessionOptions());
		const parentManager = parent.mcpManager;
		expect(parentManager?.getConnectedServers()).toContain("demo");

		// Subagent (parentTaskPrefix set) inherits the parent's scope-held facade:
		// no new manager, no duplicate processes, no disposal ownership.
		const child = await createAgentSession({
			...isolatedSessionOptions(),
			inheritedMcpManager: parentManager,
			parentTaskPrefix: "0-Sub",
		});
		try {
			expect(child.mcpManager).toBeUndefined();
			expect(child.session.getAllToolNames()).toContain("mcp__demo_hello");
			expect(child.session.getActiveToolNames()).toContain("mcp__demo_hello");
		} finally {
			// Disposing the subagent must NOT disconnect the parent-owned manager.
			await child.session.dispose();
		}
		expect(parentManager?.getConnectedServers()).toContain("demo");

		// Only disposing the owner tears the manager down.
		await parent.session.dispose();
		expect(parentManager?.getConnectedServers()).toEqual([]);
	}, 30_000);
});
