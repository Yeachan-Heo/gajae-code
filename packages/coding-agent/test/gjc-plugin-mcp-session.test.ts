import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { installGjcPluginBundle } from "../src/extensibility/gjc-plugins";

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
});
