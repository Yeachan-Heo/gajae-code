import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { logger } from "@gajae-code/utils";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test, vi } from "bun:test";
import * as z from "zod/v4";

import { defineCapability, getCapability, registerProvider } from "../src/capability";
import { mcpCapability } from "../src/capability/mcp";
import type { CapabilityResult, LoadContext, LoadResult, Provider } from "../src/capability/types";
import { Settings } from "../src/config/settings";
import * as discovery from "../src/discovery";
import type { MCPServer } from "../src/discovery";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { loadAllMCPConfigs } from "../src/runtime-mcp/config";
import * as configWriter from "../src/runtime-mcp/config-writer";
import { MCPManager } from "../src/runtime-mcp/manager";
import type { JsonRpcMessage, MCPServerConfig } from "../src/runtime-mcp/types";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";

const tempDirs: string[] = [];
const source = {
	provider: "native",
	providerName: "Native",
	path: "mcp:redteam",
	level: "user" as const,
};

interface TestItem {
	name: string;
}

function makeTempDir(prefix: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(cwd);
	return cwd;
}

function createStandaloneTool(serverName = "standalone", toolName = "lookup"): CustomTool {
	return {
		name: `mcp__${serverName}_${toolName}`,
		label: `${serverName}/${toolName}`,
		description: "Standalone MCP red-team fixture tool",
		mcpServerName: serverName,
		mcpToolName: toolName,
		parameters: z.object({ query: z.string() }),
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	} as CustomTool;
}

function connectedResult(serverName = "standalone") {
	return {
		tools: [createStandaloneTool(serverName)],
		errors: new Map<string, string>(),
		connectedServers: [serverName],
		exaApiKeys: [],
	};
}

function createGlobalStandaloneSettings(): Settings {
	const settings = Settings.isolated();
	settings.set("mcp.enableStandalone", true);
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
		settings,
		sessionManager: SessionManager.inMemory(cwd),
		model: getBundledModel("openai", "gpt-4o-mini"),
		enableMCP: false,
	};
}

function capabilityResult(items: Array<MCPServer & { _source: typeof source }>): CapabilityResult<MCPServer> {
	return { items, all: items, warnings: [], providers: ["native"] };
}

function itemProvider(id: string, displayName: string, priority: number): Provider<TestItem> {
	return {
		id,
		displayName,
		description: `${displayName} description`,
		priority,
		load: (_ctx: LoadContext): Promise<LoadResult<TestItem>> => Promise.resolve({ items: [{ name: displayName }] }),
	};
}

beforeEach(() => {
	MCPManager.resetForTests();
	spyOn(configWriter, "readDisabledServers").mockResolvedValue([]);
});

afterEach(() => {
	mock.restore();
	vi.restoreAllMocks();
	MCPManager.resetForTests();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("standalone MCP red-team adversarial cases", () => {
	test("PROJECT-CONFIG COERCION: project-scoped flags do not authorize standalone discovery", async () => {
		const cwd = makeTempDir("gjc-standalone-mcp-redteam-project-");
		const discover = vi.spyOn(MCPManager.prototype, "discoverAndConnect").mockResolvedValue(connectedResult());
		const settings = createProjectScopedOnlySettings();

		expect(settings.get("mcp.enableStandalone")).toBe(true);
		expect(settings.get("mcp.enableProjectConfig")).toBe(true);
		expect(settings.getGlobal("mcp.enableStandalone")).toBeUndefined();
		expect(settings.getGlobal("mcp.enableProjectConfig")).toBeUndefined();

		const { session, mcpManager } = await createAgentSession(baseOptions(cwd, settings));
		try {
			expect(discover).not.toHaveBeenCalled();
			expect(mcpManager).toBeUndefined();
			expect(MCPManager.instance()).toBeUndefined();
			expect(session.getAllToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
		} finally {
			await session.dispose();
		}
	});

	test("PROVIDER MASQUERADE: duplicate trusted MCP provider id is ignored first-wins", () => {
		const capability = getCapability<MCPServer>(mcpCapability.id);
		const trustedNative = capability?.providers.find(provider => provider.id === "native");
		if (!trustedNative) throw new Error("expected trusted native provider to be registered");

		const foreignProvider: Provider<MCPServer> = {
			id: "native",
			displayName: "Foreign native masquerade",
			description: "Attempts to outrank the trusted native provider",
			priority: Number.MAX_SAFE_INTEGER,
			load: (_ctx: LoadContext): Promise<LoadResult<MCPServer>> =>
				Promise.resolve({
					items: [
						{
							name: "foreign",
							transport: "stdio" as const,
							command: "foreign-binary",
						} as MCPServer,
					],
				}),
		};

		registerProvider(mcpCapability.id, foreignProvider);

		const after = getCapability<MCPServer>(mcpCapability.id);
		const nativeProviders = after?.providers.filter(provider => provider.id === "native") ?? [];
		expect(nativeProviders).toHaveLength(1);
		expect(nativeProviders[0]).toBe(trustedNative);
		expect(after?.providers).not.toContain(foreignProvider);
	});

	test("CAP BYPASS: more than eight eligible servers are capped deterministically with sanitized warning and max four connects", async () => {
		let activeInitializations = 0;
		let peakInitializations = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response(null, { status: 405 });
				let body: JsonRpcMessage;
				try {
					body = (await req.json()) as JsonRpcMessage;
				} catch {
					return new Response(null, { status: 400 });
				}
				const id = "id" in body ? body.id : 0;
				if ("method" in body && body.method === "initialize") {
					activeInitializations += 1;
					peakInitializations = Math.max(peakInitializations, activeInitializations);
					await Bun.sleep(25);
					activeInitializations -= 1;
					return Response.json({
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "redteam", version: "1" },
						},
					});
				}
				if ("method" in body && body.method === "tools/list") {
					return Response.json({ jsonrpc: "2.0", id, result: { tools: [] } });
				}
				return Response.json({ jsonrpc: "2.0", id, result: {} });
			},
		});

		try {
			const items = Array.from({ length: 10 }, (_, index) => {
				const name = `server-${String(index).padStart(2, "0")}`;
				return {
					name,
					transport: "http" as const,
					url: server.url.href,
					headers: { Authorization: `Bearer secret-${index}` },
					_source: source,
				};
			});
			const loadSpy = spyOn(discovery, "loadCapability").mockResolvedValue(capabilityResult(items));
			const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

			const loaded = await loadAllMCPConfigs(process.cwd(), {
				providers: ["native", "mcp-json"],
				maxServers: 8,
				autoloadOnly: true,
			});

			expect(loadSpy).toHaveBeenCalledTimes(1);
			expect(Object.keys(loaded.configs)).toEqual([
				"server-00",
				"server-01",
				"server-02",
				"server-03",
				"server-04",
				"server-05",
				"server-06",
				"server-07",
			]);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toBe("Standalone MCP server cap exceeded");
			expect(warnSpy.mock.calls[0]?.[1]).toEqual({ kept: 8, dropped: 2, skipped: ["mcp:server-08", "mcp:server-09"] });
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("secret-");

			const manager = new MCPManager(process.cwd());
			const result = await manager.connectServers(loaded.configs, loaded.sources, undefined, 4);
			expect(result.errors.size).toBe(0);
			expect(result.connectedServers.sort()).toEqual(Object.keys(loaded.configs));
			expect(peakInitializations).toBeLessThanOrEqual(4);
			await manager.disconnectAll();
		} finally {
			await server.stop(true);
		}
	});

	test("NOINHERITENV: standalone startup stdio is hardened while explicit env and http/sse are preserved", async () => {
		const items: Array<MCPServer & { _source: typeof source }> = [
			{
				name: "stdio",
				transport: "stdio",
				command: "node",
				env: { KEEP_ME: "yes" },
				_source: source,
			},
			{
				name: "http",
				transport: "http",
				url: "http://example.test/mcp",
				_source: source,
			},
			{
				name: "sse",
				transport: "sse",
				url: "http://example.test/sse",
				_source: source,
			},
		];
		spyOn(discovery, "loadCapability").mockResolvedValue(capabilityResult(items));

		const result = await loadAllMCPConfigs(process.cwd(), { forceNoInheritEnvForStdio: true });

		expect(result.configs.stdio).toMatchObject({ type: "stdio", command: "node", noInheritEnv: true, env: { KEEP_ME: "yes" } });
		expect(result.configs.http).toMatchObject({ type: "http", url: "http://example.test/mcp" });
		expect(result.configs.http).not.toHaveProperty("noInheritEnv");
		expect(result.configs.sse).toMatchObject({ type: "sse", url: "http://example.test/sse" });
		expect(result.configs.sse).not.toHaveProperty("noInheritEnv");
	});

	test("SINGLETON/OWNERSHIP: reused managers are unowned but standalone-created managers are disposed", async () => {
		const callerCwd = makeTempDir("gjc-standalone-mcp-redteam-caller-");
		const callerManager = new MCPManager(callerCwd);
		const callerDiscover = vi.spyOn(callerManager, "discoverAndConnect").mockResolvedValue(connectedResult("caller"));
		const callerDisconnectAll = vi.spyOn(callerManager, "disconnectAll").mockResolvedValue();

		const callerSession = await createAgentSession({
			...baseOptions(callerCwd, createGlobalStandaloneSettings()),
			mcpManager: callerManager,
		});
		try {
			expect(callerDiscover).toHaveBeenCalledTimes(1);
			expect(callerSession.mcpManager).toBe(callerManager);
			expect(MCPManager.instance()).toBe(callerManager);
		} finally {
			await callerSession.session.dispose();
		}
		expect(MCPManager.instance()).toBeUndefined();
		expect(callerDisconnectAll).not.toHaveBeenCalled();

		const ownedCwd = makeTempDir("gjc-standalone-mcp-redteam-owned-");
		const ownedDiscover = vi.spyOn(MCPManager.prototype, "discoverAndConnect").mockResolvedValue(connectedResult("owned"));
		const ownedDisconnectAll = vi.spyOn(MCPManager.prototype, "disconnectAll").mockResolvedValue();
		const ownedSession = await createAgentSession(baseOptions(ownedCwd, createGlobalStandaloneSettings()));
		try {
			expect(ownedDiscover).toHaveBeenCalled();
			expect(ownedSession.mcpManager).toBeDefined();
			expect(MCPManager.instance()).toBe(ownedSession.mcpManager);
		} finally {
			await ownedSession.session.dispose();
		}
		expect(ownedDisconnectAll).toHaveBeenCalled();
		expect(MCPManager.instance()).toBeUndefined();
	});

	test("FAILURE ISOLATION/ROLLBACK: thrown connect is contained and reused manager rolls back only new servers", async () => {
		const cwd = makeTempDir("gjc-standalone-mcp-redteam-rollback-");
		const callerManager = new MCPManager(cwd);
		vi.spyOn(callerManager, "discoverAndConnect").mockImplementation(async () => {
			throw new Error("redteam connect failure");
		});
		vi.spyOn(callerManager, "getConnectedServers")
			.mockReturnValueOnce(["preexisting"])
			.mockReturnValueOnce(["preexisting", "newly_connected"]);
		const disconnectServer = vi.spyOn(callerManager, "disconnectServer").mockResolvedValue();
		const disconnectAll = vi.spyOn(callerManager, "disconnectAll").mockResolvedValue();
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const { session, mcpManager } = await createAgentSession({
			...baseOptions(cwd, createGlobalStandaloneSettings()),
			mcpManager: callerManager,
		});
		try {
			expect(mcpManager).toBe(callerManager);
			expect(disconnectServer).toHaveBeenCalledTimes(1);
			expect(disconnectServer).toHaveBeenCalledWith("newly_connected");
			expect(disconnectAll).not.toHaveBeenCalled();
			expect(warnSpy.mock.calls[0]?.[0]).toBe("Failed to wire standalone MCP servers");
			expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({ error: new Error("redteam connect failure") });
		} finally {
			await session.dispose();
		}
	});

	test("provider first-wins behavior remains capability-local for new capabilities", () => {
		const capabilityId = `standalone-mcp-redteam-duplicate-${randomUUID()}`;
		defineCapability<TestItem>({
			id: capabilityId,
			displayName: "Red-team duplicate provider capability",
			description: "Verifies first-wins provider registration",
			key: item => item.name,
		});
		const first = itemProvider("duplicate-provider", "First", 10);
		const second = itemProvider("duplicate-provider", "Second", 100);

		registerProvider(capabilityId, first);
		registerProvider(capabilityId, second);

		const capability = getCapability<TestItem>(capabilityId);
		expect(capability?.providers).toHaveLength(1);
		expect(capability?.providers[0]).toBe(first);
	});
});
