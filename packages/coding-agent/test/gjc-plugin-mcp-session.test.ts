import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { installGjcPluginBundle } from "../src/extensibility/gjc-plugins";
import { buildPluginMcpConfigs } from "../src/extensibility/gjc-plugins/runtime-adapters";
import { MCPManager } from "../src/runtime-mcp";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const mcpBundle = path.join(fixturesRoot, "valid-mcp-bundle");
const tempDirs: string[] = [];

afterEach(() => {
	for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("always-on plugin-bundle MCP in a live session", () => {
	test("connects an installed bundle MCP server and surfaces its tools as always-on", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mcp-session-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(mcpBundle, { scope: "project", cwd });

		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMCPToolSelection(["mcp__domain_docs_lookup"]);
		const sessionSettings = Settings.isolated();
		sessionSettings.set("tools.discoveryMode", "all");
		const { session, mcpManager } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager,
			settings: sessionSettings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			// Generic discovery is fully enabled; plugin-bundle MCP remains mandatory rather than selectable.
			enableMCP: false,
			enableLsp: false,
		});

		try {
			// The session must own a manager and have connected the bundled server.
			expect(mcpManager).toBeDefined();
			expect(mcpManager?.getConnectedServers()).toContain("domain_docs");
			expect(mcpManager?.isConnectionSetSealed()).toBe(true);

			// The bundled server advertises a "lookup" tool. Its canonical name must
			// be registered AND active (always-on), not gated behind MCP selection.
			const lookup = "mcp__domain_docs_lookup";
			expect(session.getAllToolNames()).toContain(lookup);
			expect(session.getActiveToolNames()).toContain(lookup);
			expect(session.getSelectedMCPToolNames()).not.toContain(lookup);
			expect(sessionManager.buildSessionContext()).toMatchObject({
				hasPersistedMCPToolSelection: true,
				selectedMCPToolNames: [],
			});
			await session.setActiveToolsByName([]);
			expect(session.getActiveToolNames()).toContain(lookup);
			expect(session.getSelectedMCPToolNames()).not.toContain(lookup);
			expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([]);

			// Starting a fresh session recomputes MCP selection; plugin-bundle tools
			// remain always-on rather than falling back behind discovery selection.
			expect(await session.newSession()).toBe(true);
			expect(session.getActiveToolNames()).toContain(lookup);
			expect(session.getSelectedMCPToolNames()).not.toContain(lookup);
			await expect(mcpManager?.disconnectServer("domain_docs")).rejects.toThrow("connection set is sealed");
		} finally {
			await session.dispose();
		}

		// Disposing the session disconnects the owned manager (no leaked processes).
		expect(mcpManager?.getConnectedServers()).toEqual([]);
	}, 30_000);

	test("keeps always-on plugin MCP tools active across newSession and switchSession resume", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mcp-session-resume-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(mcpBundle, { scope: "project", cwd });

		// File-backed manager so switchSession can resume a real session file. Generic
		// discovery is fully enabled to prove the plugin tool is mandatory, not selectable.
		const sessionManager = SessionManager.create(cwd, cwd);
		const sessionSettings = Settings.isolated();
		sessionSettings.set("tools.discoveryMode", "all");
		const { session, mcpManager } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager,
			settings: sessionSettings,
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

		const lookup = "mcp__domain_docs_lookup";
		try {
			expect(mcpManager?.getConnectedServers()).toContain("domain_docs");
			expect(session.getActiveToolNames()).toContain(lookup);
			expect(session.getSelectedMCPToolNames()).not.toContain(lookup);

			const originalSessionFile = session.sessionFile;
			expect(originalSessionFile).toBeDefined();

			// /new: a fresh session recomputes selection but keeps the plugin tool always-on.
			expect(await session.newSession()).toBe(true);
			expect(session.sessionFile).not.toBe(originalSessionFile);
			expect(session.getActiveToolNames()).toContain(lookup);
			expect(session.getSelectedMCPToolNames()).not.toContain(lookup);

			// Resume: switchSession restores MCP selections; the always-on plugin tool
			// must survive #restoreMCPSelectionsForSessionContext, not be gated behind
			// the (empty) restored MCP selection.
			expect(await session.switchSession(originalSessionFile as string)).toBe(true);
			expect(session.getActiveToolNames()).toContain(lookup);
			expect(session.getSelectedMCPToolNames()).not.toContain(lookup);

			// The owned manager is not re-spawned or torn down by session lifecycle ops.
			expect(mcpManager?.getConnectedServers()).toContain("domain_docs");
		} finally {
			await session.dispose();
		}

		// Only disposing the owner tears the manager down (no leaked processes).
		expect(mcpManager?.getConnectedServers()).toEqual([]);
	}, 30_000);

	test("filters an explicitly requested mandatory plugin tool from persisted selection authority", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mcp-session-explicit-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(mcpBundle, { scope: "project", cwd });
		const sessionManager = SessionManager.inMemory(cwd);
		const sessionSettings = Settings.isolated();
		sessionSettings.set("tools.discoveryMode", "all");
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager,
			settings: sessionSettings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			toolNames: ["mcp__domain_docs_lookup"],
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
			expect(session.getActiveToolNames()).toContain("mcp__domain_docs_lookup");
			expect(session.getSelectedMCPToolNames()).not.toContain("mcp__domain_docs_lookup");
			expect(sessionManager.buildSessionContext()).toMatchObject({
				hasPersistedMCPToolSelection: false,
				selectedMCPToolNames: [],
			});
		} finally {
			await session.dispose();
		}
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
			const lookup = "mcp__domain_docs_lookup";
			expect(child.session.getAllToolNames()).toContain(lookup);
			expect(child.session.getActiveToolNames()).toContain(lookup);
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

	test.each([
		"gjc-plugins",
		"custom",
	])("does not inherit caller-owned MCP tools with %s source metadata as mandatory", async provider => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mcp-session-forged-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(mcpBundle, { scope: "project", cwd });
		const { configs } = await buildPluginMcpConfigs({ cwd });
		const callerManager = new MCPManager(cwd);
		const sources = {
			domain_docs: { provider, providerName: "Caller-owned manager", level: "project" as const },
		};
		const connected = await callerManager.connectServers(configs, sources as never);
		expect(connected.errors.size).toBe(0);
		expect(callerManager.getTools().map(tool => tool.name)).toContain("mcp__domain_docs_lookup");

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
			parentTaskPrefix: "0-Forged",
			mcpManager: callerManager,
		});
		try {
			expect(child.session.getAllToolNames()).toContain("mcp__domain_docs_lookup");
			expect(child.session.getActiveToolNames()).not.toContain("mcp__domain_docs_lookup");
			expect(callerManager.isConnectionSetSealed()).toBe(false);
			await child.session.setActiveToolsByName(["mcp__domain_docs_lookup"]);
			expect(child.session.getActiveToolNames()).toContain("mcp__domain_docs_lookup");
			await child.session.setActiveToolsByName([]);
			expect(child.session.getActiveToolNames()).not.toContain("mcp__domain_docs_lookup");
			expect(child.mcpManager).toBe(callerManager);
		} finally {
			await child.session.dispose();
		}
		expect(callerManager.getConnectedServers()).toContain("domain_docs");
		await callerManager.disconnectAll();
		expect(callerManager.getConnectedServers()).toEqual([]);
	}, 30_000);
});
