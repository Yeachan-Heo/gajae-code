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
import { safeRm } from "../../../scripts/safe-cleanup";
import { runMCPCommand } from "../src/cli/mcp-cli";
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
			settings: Settings.isolated({}),
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
		} finally {
			await session.dispose();
		}
	});

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
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
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
