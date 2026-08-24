/**
 * Red-team adversarial coverage for conventional MCP autoload (PR #4335).
 *
 * These tests TRY TO BREAK the autoload contract rather than confirm the happy
 * path: malformed native configs, prototype-polluting server names, `--no-mcp`
 * interplay with plugin-bundle MCPs, disabledServers bypass via explicit
 * connect, sealed-manager re-discovery, and native file precedence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { safeRm } from "../../../../scripts/safe-cleanup";
import { runMCPCommand } from "../../src/cli/mcp-cli";
import { installGjcBundle } from "../../src/extensibility/gjc-plugins";
import { MCPManager } from "../../src/runtime-mcp";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";
import type { MCPStdioServerConfig } from "../../src/runtime-mcp/types";

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

function demoConfig(overrides: Partial<MCPStdioServerConfig> = {}): MCPStdioServerConfig {
	return {
		type: "stdio",
		command: process.execPath,
		args: ["-e", DEMO_MCP_SERVER_SCRIPT],
		timeout: 5_000,
		...overrides,
	};
}

const originalAgentDir = getAgentDir();

describe("red-team: conventional MCP autoload", () => {
	let projectDir: string;
	let agentDir: string;
	let tempHome: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		MCPManager.resetForTests();
		projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-redteam-project-"));
		tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-redteam-home-"));
		// The MCP user scope is the agent directory (that is where `gjc mcp add`
		// writes), so isolating it is exactly `setAgentDir`. Anchor it inside the
		// temp home so the layout matches a real profile and nothing here can reach
		// the developer's real `~/.gjc/agent/mcp.json`.
		agentDir = path.join(tempHome, ".gjc", "agent");
		await fs.promises.mkdir(agentDir, { recursive: true });
		setAgentDir(agentDir);
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

	async function writeProjectConfig(relPath: string, content: string | unknown): Promise<void> {
		const filePath = path.join(projectDir, relPath);
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await fs.promises.writeFile(filePath, typeof content === "string" ? content : JSON.stringify(content));
	}

	async function writeUserNativeConfig(content: unknown, filename = "mcp.json"): Promise<string> {
		const filePath = path.join(agentDir, filename);
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await fs.promises.writeFile(filePath, JSON.stringify(content));
		return filePath;
	}

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

	describe("malformed native config files", () => {
		// docs/standalone-mcp.md promises: "Malformed or unparseable definitions
		// are skipped fail-closed ... and the session continues with the remaining
		// valid servers." The implementation must honor per-file tolerance: a
		// malformed config in one scope must not abort discovery of valid servers
		// in the other scope.
		it("a malformed project config does NOT abort discovery of valid user-scope servers", async () => {
			await writeProjectConfig(".gjc/mcp.json", '{ "mcpServers": { "broken": {');
			await writeUserNativeConfig({
				mcpServers: { userSrv: demoConfig() },
			});

			const loaded = await loadAllMCPConfigs(projectDir, {
				filterExa: false,
				nativeOnly: true,
				autoloadOnly: true,
			});
			// The malformed project file yields no servers, but the valid user
			// server is still discovered.
			expect(Object.keys(loaded.configs)).toEqual(["userSrv"]);
		});

		it("a malformed project config at session startup still loads valid user-scope servers", async () => {
			await writeProjectConfig(".gjc/mcp.json", "not json at all {");
			await writeUserNativeConfig({
				mcpServers: { userSrv: demoConfig() },
			});

			const { session, mcpManager } = await createAgentSession(isolatedSessionOptions());
			try {
				// Per docs: the valid user-scope server loads despite the malformed
				// project file. The malformed file itself contributes nothing.
				expect(mcpManager).toBeDefined();
				expect(mcpManager?.getConnectedServers()).toContain("userSrv");
				expect(session.getAllToolNames().some(name => name.startsWith("mcp__usersrv_"))).toBe(true);
			} finally {
				await session.dispose();
			}
		}, 30_000);

		it("malformed JSON never yields a partially parsed server (fail-closed, nothing partial)", async () => {
			// A truncated entry must not let a valid-looking fragment load from
			// the same malformed file. The capability provider's tryParseJson
			// returns empty items for the malformed file.
			await writeProjectConfig(
				".gjc/mcp.json",
				'{"mcpServers": {"fragment": {"type": "stdio", "command": "/usr/bin/false",',
			);
			const loaded = await loadAllMCPConfigs(projectDir, {
				filterExa: false,
				nativeOnly: true,
				autoloadOnly: true,
			});
			expect(Object.keys(loaded.configs)).toEqual([]);
		});
	});

	describe("prototype-polluting server names", () => {
		it("__proto__/constructor/prototype names cannot pollute Object.prototype and do not crash discovery", async () => {
			// JSON.parse defines __proto__ as an OWN property, so this raw text
			// genuinely exercises the loader with a hostile key.
			await writeProjectConfig(
				".gjc/mcp.json",
				'{"mcpServers": {"__proto__": {"type": "stdio", "command": "evil-bin"}, "constructor": {"type": "stdio", "command": "ctor-bin"}, "prototype": {"type": "stdio", "command": "proto-bin"}, "ok": ' +
					JSON.stringify(demoConfig()) +
					"}}",
			);

			const loaded = await loadAllMCPConfigs(projectDir, {
				filterExa: false,
				nativeOnly: true,
				autoloadOnly: true,
			});
			// No global pollution: plain objects must not inherit config fields.
			expect(({} as Record<string, unknown>).command).toBeUndefined();
			expect(Object.hasOwn({}, "command")).toBe(false);
			expect(Object.hasOwn(Object.prototype, "command")).toBe(false);
			// __proto__ must never become a config entry (silently dropped by the
			// env-expansion rebuild; the import-source layer warns, the runtime
			// layer drops without warning).
			expect(Object.hasOwn(loaded.configs, "__proto__")).toBe(false);
			expect(Object.keys(loaded.configs).sort()).toEqual(["constructor", "ok", "prototype"]);
			expect(loaded.configs.ok).toMatchObject({ type: "stdio" });
			// No crash, no partial entry for the hostile keys.
			expect(loaded.configurationWarning).toBe(false);
		});

		it("session startup survives a __proto__-named server and never connects it", async () => {
			await writeProjectConfig(
				".gjc/mcp.json",
				'{"mcpServers": {"__proto__": {"type": "stdio", "command": "evil-bin"}, "good": ' +
					JSON.stringify(demoConfig()) +
					"}}",
			);

			const { session, mcpManager } = await createAgentSession(isolatedSessionOptions());
			try {
				expect(mcpManager).toBeDefined();
				expect(mcpManager?.getConnectedServers()).toEqual(["good"]);
				expect(session.getAllToolNames().filter(name => name.startsWith("mcp__"))).toEqual(["mcp__good_hello"]);
				expect(({} as Record<string, unknown>).command).toBeUndefined();
			} finally {
				await session.dispose();
			}
		}, 30_000);
	});

	describe("--no-mcp and plugin-bundle MCPs", () => {
		const fixturesRoot = path.join(import.meta.dir, "..", "fixtures", "gjc-plugins");
		const mcpBundle = path.join(fixturesRoot, "valid-mcp-bundle");

		it("--no-mcp (enableMcpAutoload: false) suppresses conventional registrations but keeps plugin-bundle MCPs", async () => {
			const r = await installGjcBundle({ cwd: projectDir }, "project", mcpBundle);
			expect(r.ok).toBe(true);
			// Conventional registration in the same project.
			await runMCPCommand({
				action: "add",
				name: "solo",
				commandArgs: [process.execPath, "-e", DEMO_MCP_SERVER_SCRIPT],
				flags: { project: true, timeout: 5_000 },
				cwd: projectDir,
			});

			const { session, mcpManager } = await createAgentSession({
				...isolatedSessionOptions(),
				enableMcpAutoload: false,
			});
			try {
				// Plugin-bundle server still connects: --no-mcp only gates the
				// conventional `.gjc` scopes.
				expect(mcpManager).toBeDefined();
				expect(mcpManager?.getConnectedServers()).toEqual(["domain_docs"]);
				expect(mcpManager?.getSource("domain_docs")?.provider).toBe("gjc-plugins");
				// The conventional registration is NOT connected.
				expect(mcpManager?.getConnectedServers()).not.toContain("solo");
				expect(session.getAllToolNames()).toContain("mcp__domain_docs_lookup");
				expect(session.getAllToolNames().filter(name => name.startsWith("mcp__solo"))).toEqual([]);
			} finally {
				await session.dispose();
			}
		}, 30_000);

		it("plugin-bundle MCPs override conventional entries on name collisions; both load otherwise", async () => {
			const r = await installGjcBundle({ cwd: projectDir }, "project", mcpBundle);
			expect(r.ok).toBe(true);
			// Conventional entry colliding with the plugin's domain_docs, plus a
			// non-colliding conventional entry.
			await runMCPCommand({
				action: "add",
				name: "domain_docs",
				commandArgs: [process.execPath, "-e", DEMO_MCP_SERVER_SCRIPT],
				flags: { project: true, timeout: 5_000 },
				cwd: projectDir,
			});
			await runMCPCommand({
				action: "add",
				name: "solo",
				commandArgs: [process.execPath, "-e", DEMO_MCP_SERVER_SCRIPT],
				flags: { project: true, timeout: 5_000 },
				cwd: projectDir,
			});

			// Mixed plugin/conventional sessions may publish a conventional server
			// after createAgentSession returns. Observe the manager's authoritative
			// seal transition instead of racing that late publication with a
			// synchronous assertion.
			const sealObserved = Promise.withResolvers<void>();
			const sealConnectionSet = MCPManager.prototype.sealConnectionSet;
			vi.spyOn(MCPManager.prototype, "sealConnectionSet").mockImplementation(function (this: MCPManager) {
				sealConnectionSet.call(this);
				sealObserved.resolve();
			});

			const { session, mcpManager } = await createAgentSession(isolatedSessionOptions());
			try {
				expect(mcpManager).toBeDefined();
				expect(mcpManager?.getConnectedServers().sort()).toEqual(["domain_docs", "solo"]);
				// The winning domain_docs connection is the plugin-bundle one
				// (adapter boundary: noInheritEnv true, cwd pinned to plugin root).
				expect(mcpManager?.getSource("domain_docs")?.provider).toBe("gjc-plugins");
				const connection = mcpManager?.getConnection("domain_docs");
				expect(connection?.config.type).toBe("stdio");
				if (connection?.config.type === "stdio") {
					expect(connection.config.noInheritEnv).toBe(true);
					expect(connection.config.cwd).toContain("valid-mcp-bundle");
				}
				// Both servers' tools are always-on.
				expect(session.getAllToolNames()).toContain("mcp__domain_docs_lookup");
				expect(session.getAllToolNames()).toContain("mcp__solo_hello");
				// Plugin presence seals the connection set (fixed session lifetime).
await sealObserved.promise;
				expect(mcpManager?.isConnectionSetSealed()).toBe(true);
			} finally {
				await session.dispose();
			}
		}, 30_000);
	});

	describe("disabledServers / enabled:false / autoload:false at the runtime boundary", () => {
		it("disabledServers is enforced at discovery even when the entry is otherwise valid", async () => {
			await writeProjectConfig(".gjc/mcp.json", {
				mcpServers: { denied: demoConfig() },
				disabledServers: ["denied"],
			});
			const loaded = await loadAllMCPConfigs(projectDir, {
				filterExa: false,
				nativeOnly: true,
				autoloadOnly: true,
			});
			expect(Object.keys(loaded.configs)).toEqual([]);
		});

		it("an explicit connect can still attach a disabledServers-denylisted server (interactive /mcp test path)", async () => {
			await writeProjectConfig(".gjc/mcp.json", {
				mcpServers: { denied: demoConfig() },
				disabledServers: ["denied"],
			});
			const loaded = await loadAllMCPConfigs(projectDir, {
				filterExa: false,
				nativeOnly: true,
				autoloadOnly: true,
			});
			expect(Object.keys(loaded.configs)).toEqual([]);

			// The denylist is a discovery-time gate: connectServers (the entry
			// point used by the interactive surface via /mcp test ->
			// #syncManagerConnection) attaches the server without consulting it.
			const manager = new MCPManager(projectDir, null);
			const source = { provider: "native", providerName: "GJC", level: "project" as const, path: "" };
			const result = await manager.connectServers(
				{ denied: loaded.configs.denied ?? demoConfig() },
				{ denied: source },
			);
			try {
				expect(result.connectedServers).toContain("denied");
				expect(manager.getConnectionStatus("denied")).toBe("connected");
			} finally {
				await manager.disconnectAll();
			}
		}, 30_000);

		it("an enabled:false server is likewise connectable at the manager level (the interactive surface blocks it via /mcp test's enabled check)", async () => {
			await writeProjectConfig(".gjc/mcp.json", {
				mcpServers: { off: demoConfig({ enabled: false }) },
			});
			const loaded = await loadAllMCPConfigs(projectDir, {
				filterExa: false,
				nativeOnly: true,
				autoloadOnly: true,
			});
			expect(Object.keys(loaded.configs)).toEqual([]);

			const manager = new MCPManager(projectDir, null);
			const source = { provider: "native", providerName: "GJC", level: "project" as const, path: "" };
			const result = await manager.connectServers({ off: demoConfig({ enabled: false }) }, { off: source });
			try {
				expect(result.connectedServers).toContain("off");
			} finally {
				await manager.disconnectAll();
			}
		}, 30_000);

		it("autoload:false servers stay connectable on demand while excluded from startup", async () => {
			await writeProjectConfig(".gjc/mcp.json", {
				mcpServers: { lazy: demoConfig({ autoload: false }) },
			});
			const loaded = await loadAllMCPConfigs(projectDir, {
				filterExa: false,
				nativeOnly: true,
				autoloadOnly: true,
			});
			expect(Object.keys(loaded.configs)).toEqual([]);

			const manager = new MCPManager(projectDir, null);
			const source = { provider: "native", providerName: "GJC", level: "project" as const, path: "" };
			const result = await manager.connectServers({ lazy: demoConfig({ autoload: false }) }, { lazy: source });
			try {
				expect(result.connectedServers).toContain("lazy");
			} finally {
				await manager.disconnectAll();
			}
		}, 30_000);
	});

	describe("sealed plugin sessions and re-discovery", () => {
		it("a session manager with plugin-bundle MCPs is sealed: re-discovery (the /mcp reload surface) is refused", async () => {
			const fixturesRoot = path.join(import.meta.dir, "..", "fixtures", "gjc-plugins");
			const r = await installGjcBundle({ cwd: projectDir }, "project", path.join(fixturesRoot, "valid-mcp-bundle"));
			expect(r.ok).toBe(true);

			const { session, mcpManager } = await createAgentSession(isolatedSessionOptions());
			try {
				expect(mcpManager?.isConnectionSetSealed()).toBe(true);
				// /mcp reload -> discoverAndConnect({ nativeOnly: true }) must not
				// silently re-run discovery on a sealed manager.
				await expect(mcpManager?.discoverAndConnect({ nativeOnly: true })).rejects.toThrow(
					"connection set is sealed",
				);
			} finally {
				await session.dispose();
			}
		}, 30_000);

		it("a conventional-only session manager stays mutable so /mcp reload can re-discover", async () => {
			await writeProjectConfig(".gjc/mcp.json", {
				mcpServers: { solo: demoConfig() },
			});
			const { session, mcpManager } = await createAgentSession(isolatedSessionOptions());
			try {
				expect(mcpManager?.isConnectionSetSealed()).toBe(false);
				const result = await mcpManager?.discoverAndConnect({ nativeOnly: true });
				expect(result?.connectedServers).toContain("solo");
			} finally {
				await session.dispose();
			}
		}, 30_000);
	});

	describe("native file precedence", () => {
		it(".gjc/mcp.json wins over .gjc/.mcp.json on a same-name collision", async () => {
			await writeProjectConfig(".gjc/mcp.json", {
				mcpServers: { dup: { type: "stdio", command: "from-mcp-json" } },
			});
			await writeProjectConfig(".gjc/.mcp.json", {
				mcpServers: { dup: { type: "stdio", command: "from-dot-mcp-json" } },
			});
			const loaded = await loadAllMCPConfigs(projectDir, {
				filterExa: false,
				nativeOnly: true,
				autoloadOnly: true,
			});
			expect(loaded.configs.dup).toMatchObject({ command: "from-mcp-json" });
		});

		it("user .gjc/agent/.mcp.json is read alongside user .gjc/agent/mcp.json", async () => {
			await writeUserNativeConfig({ mcpServers: { dotUser: demoConfig() } }, ".mcp.json");
			const loaded = await loadAllMCPConfigs(projectDir, {
				filterExa: false,
				nativeOnly: true,
				autoloadOnly: true,
			});
			expect(Object.keys(loaded.configs)).toEqual(["dotUser"]);
		});

		it("repeated loads are deterministic and do not leak proto-pollution across calls", async () => {
			await writeProjectConfig(
				".gjc/mcp.json",
				'{"mcpServers": {"__proto__": {"type": "stdio", "command": "evil-bin"}, "ok": ' +
					JSON.stringify(demoConfig()) +
					"}}",
			);
			const first = await loadAllMCPConfigs(projectDir, { filterExa: false, nativeOnly: true, autoloadOnly: true });
			const second = await loadAllMCPConfigs(projectDir, { filterExa: false, nativeOnly: true, autoloadOnly: true });
			expect(Object.keys(first.configs)).toEqual(["ok"]);
			expect(Object.keys(second.configs)).toEqual(["ok"]);
			expect(second.configs.ok).toMatchObject(first.configs.ok);
			expect(Object.hasOwn(Object.prototype, "command")).toBe(false);
		});
	});
});
