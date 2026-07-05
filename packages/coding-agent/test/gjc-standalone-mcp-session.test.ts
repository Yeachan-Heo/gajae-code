import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { CustomTool } from "@gajae-code/coding-agent/extensibility/custom-tools/types";
import { MCPManager } from "../src/runtime-mcp";
import type { MCPLoadResult } from "../src/runtime-mcp/manager";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as z from "zod/v4";

const tempDirs: string[] = [];

function createStandaloneTool(name = "mcp__standalone_lookup"): CustomTool {
	return {
		name,
		label: "standalone/lookup",
		description: "Standalone MCP fixture tool",
		mcpServerName: "standalone",
		mcpToolName: "lookup",
		parameters: z.object({ query: z.string() }),
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	} as CustomTool;
}

function connectedResult(tool = createStandaloneTool()): MCPLoadResult {
	return {
		tools: [tool],
		errors: new Map(),
		connectedServers: ["standalone"],
		exaApiKeys: [],
	};
}

function makeTempDir(prefix: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(cwd);
	return cwd;
}

function createSettings(globalStandalone = false): Settings {
	const settings = Settings.isolated();
	if (globalStandalone) settings.set("mcp.enableStandalone", true);
	return settings;
}

function createProjectScopedOnlySettings(): Settings {
	return Settings.isolated({
		"mcp.enableStandalone": true,
		"mcp.enableProjectConfig": true,
	});
}

function baseOptions(cwd: string, settings: Settings) {
	return {
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	};
}

beforeEach(() => {
	MCPManager.resetForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
	MCPManager.resetForTests();
	for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("standalone MCP session bootstrap", () => {
	test("default-off is a pure no-op", async () => {
		const cwd = makeTempDir("gjc-standalone-mcp-off-");
		const discover = vi.spyOn(MCPManager.prototype, "discoverAndConnect");

		const { session, mcpManager } = await createAgentSession(baseOptions(cwd, createSettings()));
		try {
			expect(mcpManager).toBeUndefined();
			expect(session.getAllToolNames()).not.toContain("mcp__standalone_lookup");
			expect(discover).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
		}
	});

	test("project-scoped flags cannot enable standalone MCP", async () => {
		const cwd = makeTempDir("gjc-standalone-mcp-project-");
		const discover = vi.spyOn(MCPManager.prototype, "discoverAndConnect");
		const settings = createProjectScopedOnlySettings();
		expect(settings.get("mcp.enableStandalone")).toBe(true);
		expect(settings.getGlobal("mcp.enableStandalone")).toBeUndefined();

		const { session, mcpManager } = await createAgentSession(baseOptions(cwd, settings));
		try {
			expect(mcpManager).toBeUndefined();
			expect(session.getAllToolNames()).not.toContain("mcp__standalone_lookup");
			expect(discover).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
		}
	});

	test("user-global opt-in wires standalone tools and disposes owned manager", async () => {
		const cwd = makeTempDir("gjc-standalone-mcp-on-");
		const discover = vi.spyOn(MCPManager.prototype, "discoverAndConnect").mockResolvedValue(connectedResult());
		const disconnectAll = vi.spyOn(MCPManager.prototype, "disconnectAll").mockResolvedValue();

		const { session, mcpManager } = await createAgentSession(baseOptions(cwd, createSettings(true)));
		try {
			expect(discover).toHaveBeenCalledWith(
				expect.objectContaining({
					providers: ["native", "mcp-json"],
					enableProjectConfig: false,
					autoloadOnly: true,
					maxServers: 8,
					maxConcurrentConnects: 4,
					forceNoInheritEnvForStdio: true,
				}),
			);
			expect(mcpManager).toBeDefined();
			expect(MCPManager.instance()).toBe(mcpManager);
			expect(session.getAllToolNames()).toContain("mcp__standalone_lookup");
		} finally {
			await session.dispose();
		}
		expect(disconnectAll).toHaveBeenCalled();
		expect(MCPManager.instance()).toBeUndefined();
	});

	test("subagent sessions do not spawn standalone MCP", async () => {
		const cwd = makeTempDir("gjc-standalone-mcp-sub-");
		const discover = vi.spyOn(MCPManager.prototype, "discoverAndConnect").mockResolvedValue(connectedResult());

		const { session, mcpManager } = await createAgentSession({
			...baseOptions(cwd, createSettings(true)),
			parentTaskPrefix: "0-Sub",
		});
		try {
			expect(mcpManager).toBeUndefined();
			expect(discover).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
		}
	});

	test("caller-supplied manager is installed but remains unowned", async () => {
		const cwd = makeTempDir("gjc-standalone-mcp-caller-");
		const callerManager = new MCPManager(cwd);
		const discover = vi.spyOn(callerManager, "discoverAndConnect").mockResolvedValue(connectedResult());
		const disconnectAll = vi.spyOn(callerManager, "disconnectAll").mockResolvedValue();

		const { session, mcpManager } = await createAgentSession({
			...baseOptions(cwd, createSettings(true)),
			mcpManager: callerManager,
		});
		try {
			expect(discover).toHaveBeenCalled();
			expect(mcpManager).toBe(callerManager);
			expect(MCPManager.instance()).toBe(callerManager);
			expect(session.getAllToolNames()).toContain("mcp__standalone_lookup");
		} finally {
			await session.dispose();
		}
		expect(MCPManager.instance()).toBeUndefined();
		expect(disconnectAll).not.toHaveBeenCalled();
	});

	test("reused manager rollback disconnects only newly connected servers", async () => {
		const cwd = makeTempDir("gjc-standalone-mcp-rollback-");
		const callerManager = new MCPManager(cwd);
		vi.spyOn(callerManager, "discoverAndConnect").mockRejectedValue(new Error("partial connect"));
		vi.spyOn(callerManager, "getConnectedServers")
			.mockReturnValueOnce(["preexisting"])
			.mockReturnValueOnce(["preexisting", "newly_connected"]);
		const disconnectServer = vi.spyOn(callerManager, "disconnectServer").mockResolvedValue();
		const disconnectAll = vi.spyOn(callerManager, "disconnectAll").mockResolvedValue();

		const { session, mcpManager } = await createAgentSession({
			...baseOptions(cwd, createSettings(true)),
			mcpManager: callerManager,
		});
		try {
			expect(mcpManager).toBe(callerManager);
			expect(disconnectServer).toHaveBeenCalledTimes(1);
			expect(disconnectServer).toHaveBeenCalledWith("newly_connected");
			expect(disconnectAll).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
		}
	});
});
