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
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { runMCPCommand } from "../src/cli/mcp-cli";
import { MCPManager } from "../src/runtime-mcp";

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
