import { describe, expect, test, vi } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@gajae-code/utils";
import { loadMCPJsonFile } from "../../src/discovery/mcp-json";
import { createMCPManager, MCPManager } from "../../src/runtime-mcp/manager";
import type { JsonRpcMessage } from "../../src/runtime-mcp/types";

async function mkdtempExact(prefix: string): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readPidList(path: string): Promise<number[]> {
	const text = await Bun.file(path)
		.text()
		.catch(() => "");
	return text
		.split(/\n+/)
		.map(line => Number(line.trim()))
		.filter(pid => Number.isInteger(pid) && pid > 0);
}

function stdioServerScript(behavior: "failTools" | "okTools"): string {
	return `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    ${behavior === "failTools" ? "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom' } }) + '\\n');" : "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');"}
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
}

describe("MCP manager lifecycle cleanup", () => {
	test("initial listTools failure closes transport and does not register server", async () => {
		const manager = new MCPManager(process.cwd());
		const result = await manager.connectServers(
			{
				bad: { command: process.execPath, args: ["-e", stdioServerScript("failTools")], timeout: 1_000 },
			},
			{},
		);

		expect(result.connectedServers).toEqual([]);
		expect(result.errors.get("bad")).toContain("boom");
		expect(manager.getConnectedServers()).toEqual([]);
		await expect(manager.waitForConnection("bad")).rejects.toThrow("MCP server not connected: bad");
	});
	test("factory creates a tools-only exact-config manager and redacts real server errors", async () => {
		const sentinel = "EXACT_SERVER_SECRET";
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response(null, { status: 405 });
				const request = (await req.json()) as { id?: string | number; method?: string };
				const id = request.id ?? 0;
				if (request.method === "initialize") {
					return Response.json({
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "redacted", version: "1" },
						},
					});
				}
				if (request.method === "tools/list") {
					return Response.json({
						jsonrpc: "2.0",
						id,
						error: { code: -32000, message: `server rejected ${sentinel}` },
					});
				}
				return Response.json({ jsonrpc: "2.0", id, result: {} });
			},
		});
		const cwd = await mkdtempExact("gjc-mcp-factory-exact-");
		const configPath = join(cwd, "exact.json");
		let manager: MCPManager | undefined;
		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						redacted: { type: "http", url: server.url.href },
					},
				}),
			);
			const created = await createMCPManager(cwd, { configPath });
			manager = created.manager;

			expect(manager.isToolsOnly()).toBe(true);
			expect(created.result.connectedServers).toEqual([]);
			expect(created.result.tools).toEqual([]);
			expect(Array.from(created.result.errors)).toEqual([["redacted", "MCP server unavailable"]]);
			expect(Array.from(created.result.errors.values()).join("\n")).not.toContain(sentinel);
		} finally {
			if (manager) await manager.disconnectAll();
			await server.stop(true);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("redacts tools-only OAuth diagnostics", async () => {
		const accessToken = "EXACT_ACCESS_TOKEN";
		const refreshToken = "EXACT_REFRESH_TOKEN";
		const credentialId = "EXACT_CREDENTIAL_ID";
		const rawFailure = "EXACT_OAUTH_FAILURE";
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response(`${rawFailure}:${refreshToken}`, { status: 400 });
			},
		});
		const cwd = await mkdtempExact("gjc-mcp-oauth-redaction-");
		const configPath = join(cwd, "exact.json");
		const tokenUrl = `${server.url.href}?access_token=${refreshToken}`;
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const managers: MCPManager[] = [];
		try {
			const refreshManager = new MCPManager(cwd, null, { toolsOnly: true });
			managers.push(refreshManager);
			refreshManager.setAuthStorage({
				get: () => ({
					type: "oauth",
					access: accessToken,
					refresh: refreshToken,
					expires: Date.now() - 1,
				}),
				set: async () => {},
			} as never);
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						refresh: {
							type: "http",
							url: `${server.url.href}?connection_token=${accessToken}`,
							auth: { type: "oauth", credentialId, tokenUrl },
						},
					},
				}),
			);
			const refreshResult = await refreshManager.discoverAndConnect({ configPath });
			expect(refreshResult.errors.get("refresh")).toBe("MCP server unavailable");

			const resolutionManager = new MCPManager(cwd, null, { toolsOnly: true });
			managers.push(resolutionManager);
			resolutionManager.setAuthStorage({
				get: () => {
					throw new Error(`credential resolution failed: ${credentialId} ${tokenUrl}`);
				},
			} as never);
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						resolution: {
							type: "http",
							url: `${server.url.href}?connection_token=${accessToken}`,
							auth: { type: "oauth", credentialId, tokenUrl },
						},
					},
				}),
			);
			const resolutionResult = await resolutionManager.discoverAndConnect({ configPath });
			expect(resolutionResult.errors.get("resolution")).toBe("MCP server unavailable");

			expect(debugSpy).toHaveBeenCalledWith("MCP OAuth refresh failed");
			expect(debugSpy).toHaveBeenCalledWith("Failed to resolve OAuth credential");
			expect(warnSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();
			const diagnostics = JSON.stringify([debugSpy, warnSpy, errorSpy].flatMap(spy => spy.mock.calls));
			for (const secret of [accessToken, refreshToken, credentialId, rawFailure, tokenUrl, server.url.href]) {
				expect(diagnostics).not.toContain(secret);
			}
		} finally {
			for (const manager of managers) {
				await manager.disconnectAll();
			}
			await server.stop(true);
			await rm(cwd, { recursive: true, force: true });
			vi.restoreAllMocks();
		}
	});

	test("factory creates a normal manager without an exact config", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "gjc-mcp-factory-normal-"));
		let manager: MCPManager | undefined;
		try {
			const created = await createMCPManager(cwd);
			manager = created.manager;

			expect(manager.isToolsOnly()).toBe(false);
		} finally {
			if (manager) await manager.disconnectAll();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("loads only an explicit config with an immutable tools-only manager", async () => {
		let toolListCalls = 0;
		let toolCallCount = 0;
		let resourceListCalls = 0;
		let promptListCalls = 0;
		let initializeCapabilities: Record<string, unknown> | undefined;
		const requestMethods: string[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response(null, { status: 405 });
				const request = (await req.json()) as {
					id?: string | number;
					method?: string;
					params?: { capabilities?: Record<string, unknown> };
				};
				requestMethods.push(request.method ?? "");
				const id = request.id ?? 0;
				switch (request.method) {
					case "initialize":
						initializeCapabilities = request.params?.capabilities;
						return Response.json({
							jsonrpc: "2.0",
							id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {}, resources: {}, prompts: {} },
								serverInfo: { name: "exact", version: "1" },
								instructions: "do not expose",
							},
						});
					case "tools/list":
						toolListCalls++;
						return Response.json({
							jsonrpc: "2.0",
							id,
							result: { tools: [{ name: "exact-tool", inputSchema: { type: "object" } }] },
						});
					case "tools/call":
						toolCallCount++;
						return Response.json({
							jsonrpc: "2.0",
							id,
							result: { content: [{ type: "text", text: "exact-ok" }] },
						});
					case "resources/list":
					case "resources/templates/list":
						resourceListCalls++;
						return Response.json({ jsonrpc: "2.0", id, result: { resources: [] } });
					case "prompts/list":
						promptListCalls++;
						return Response.json({ jsonrpc: "2.0", id, result: { prompts: [] } });
					default:
						return Response.json({ jsonrpc: "2.0", id, result: {} });
				}
			},
		});
		const cwd = await mkdtempExact("gjc-mcp-exact-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		const normalManager = new MCPManager(cwd);
		let toolChanges = 0;

		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						exact: { type: "http", url: server.url.href, timeout: 1_000 },
						manual: { type: "http", url: server.url.href, timeout: 1_000, autoload: false },
						disabled: { type: "http", url: server.url.href, timeout: 1_000 },
						bad: { type: "stdio" },
					},
					disabledServers: ["disabled"],
				}),
			);
			await Bun.write(
				join(cwd, "mcp.json"),
				JSON.stringify({ mcpServers: { foreign: { type: "http", url: server.url.href, timeout: 1_000 } } }),
			);
			expect(manager.isToolsOnly()).toBe(true);
			expect(normalManager.isToolsOnly()).toBe(false);
			expect(
				(await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false })).disabledServers,
			).toEqual(["disabled"]);
			await expect(normalManager.discoverAndConnect({ configPath })).rejects.toThrow(
				"Explicit MCP config requires a tools-only MCP manager",
			);
			await expect(manager.discoverAndConnect()).rejects.toThrow(
				"Tools-only MCP manager requires an explicit config path",
			);

			manager.setOnToolsChanged(() => toolChanges++);
			const result = await manager.discoverAndConnect({ configPath });

			expect(result.connectedServers).toEqual(["exact"]);
			expect(result.tools.map(tool => tool.name)).toEqual(["mcp__exact_tool"]);
			const toolResult = await result.tools[0]!.execute("exact-call", {}, undefined, {} as never);
			expect(toolResult.content).toEqual([{ type: "text", text: "exact-ok" }]);
			expect(toolCallCount).toBe(1);
			expect(initializeCapabilities).toEqual({});
			expect(requestMethods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
			expect(result.errors.get("bad")).toBe("MCP server unavailable");
			expect(manager.getConnectionStatus("exact")).toBe("connected");
			expect(manager.getConnectedServers()).toEqual(["exact"]);
			await expect(manager.connectServers({ injected: { type: "http", url: server.url.href } }, {})).rejects.toThrow(
				"Tools-only MCP manager does not allow raw MCP access",
			);
			expect(() => manager.getConnection("exact")).toThrow("Tools-only MCP manager does not allow raw MCP access");
			await expect(manager.waitForConnection("exact")).rejects.toThrow(
				"Tools-only MCP manager does not allow raw MCP access",
			);
			await expect(manager.prepareConfig({ type: "http", url: server.url.href })).rejects.toThrow(
				"Tools-only MCP manager does not allow raw MCP access",
			);
			const repeated = await manager.discoverAndConnect({ configPath });
			expect(repeated.connectedServers).toEqual(["exact"]);
			expect(repeated.tools.map(tool => tool.name)).toEqual(["mcp__exact_tool"]);
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__exact_tool"]);
			expect(manager.getServerResources("exact")).toBeUndefined();
			expect(manager.getServerPrompts("exact")).toBeUndefined();
			expect(manager.getServerInstructions().size).toBe(0);
			expect(resourceListCalls).toBe(0);
			expect(promptListCalls).toBe(0);
			expect(toolChanges).toBe(0);

			await manager.refreshServerTools("exact");
			expect(toolListCalls).toBe(1);
			await expect(manager.reconnectServer("exact")).resolves.toBeNull();
		} finally {
			await manager.disconnectAll();
			await server.stop(true);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("validates exact quiet config shapes before connecting", async () => {
		const cwd = await mkdtempExact("gjc-mcp-malformed-exact-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		const validServer = { type: "http", url: "http://127.0.0.1:1" };
		const malformedCases = [
			{ name: "enabled", config: { mcpServers: { invalid: { ...validServer, enabled: "true" } } } },
			{ name: "autoload", config: { mcpServers: { invalid: { ...validServer, autoload: "false" } } } },
			{
				name: "noInheritEnv",
				config: { mcpServers: { invalid: { ...validServer, noInheritEnv: "false" } } },
			},
			{ name: "timeout", config: { mcpServers: { invalid: { ...validServer, timeout: 0 } } } },
			{ name: "args", config: { mcpServers: { invalid: { ...validServer, args: ["ok", 1] } } } },
			{ name: "env", config: { mcpServers: { invalid: { ...validServer, env: { TOKEN: 1 } } } } },
			{
				name: "headers",
				config: { mcpServers: { invalid: { ...validServer, headers: { Authorization: 1 } } } },
			},
			{ name: "transport type", config: { mcpServers: { invalid: { ...validServer, type: "websocket" } } } },
			{
				name: "auth",
				config: { mcpServers: { invalid: { ...validServer, auth: { type: "oauth", credentialId: 1 } } } },
			},
			{
				name: "OAuth callbackPort",
				config: { mcpServers: { invalid: { ...validServer, oauth: { callbackPort: 0 } } } },
			},
			{ name: "disabledServers", config: { disabledServers: [1] } },
		];
		try {
			for (const { name, config } of malformedCases) {
				await Bun.write(configPath, JSON.stringify(config));
				const loaded = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });
				expect(loaded.items, name).toEqual([]);
				expect(loaded.warnings, name).toEqual(["MCP configuration unavailable"]);
				const result = await manager.discoverAndConnect({ configPath });
				expect(result.connectedServers, name).toEqual([]);
				expect(result.tools, name).toEqual([]);
				expect(Array.from(result.errors), name).toEqual([["$config", "MCP configuration unavailable"]]);
			}

			await Bun.write(
				configPath,
				JSON.stringify({
					disabledServers: ["disabled"],
					mcpServers: {
						full: {
							enabled: true,
							autoload: true,
							noInheritEnv: false,
							timeout: 1_000,
							command: "node",
							args: ["server.js"],
							env: { TOKEN: "placeholder" },
							cwd,
							url: "http://127.0.0.1:1",
							headers: { Authorization: "Bearer placeholder" },
							type: "http",
							auth: {
								type: "oauth",
								credentialId: "credential",
								tokenUrl: "https://example.test/token",
								clientId: "client",
								clientSecret: "secret",
							},
							oauth: {
								clientId: "client",
								clientSecret: "secret",
								redirectUri: "http://127.0.0.1/callback",
								callbackPort: 4_321,
								callbackPath: "/callback",
							},
						},
					},
				}),
			);
			const loaded = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });
			expect(loaded.warnings).toEqual([]);
			expect(loaded.disabledServers).toEqual(["disabled"]);
			expect(loaded.items).toMatchObject([
				{
					name: "full",
					enabled: true,
					autoload: true,
					noInheritEnv: false,
					timeout: 1_000,
					command: "node",
					args: ["server.js"],
					env: { TOKEN: "placeholder" },
					cwd,
					url: "http://127.0.0.1:1",
					headers: { Authorization: "Bearer placeholder" },
					transport: "http",
					auth: { type: "oauth", credentialId: "credential" },
					oauth: { callbackPort: 4_321, callbackPath: "/callback" },
				},
			]);
		} finally {
			await manager.disconnectAll();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("returns one sanitized diagnostic for missing, invalid, and partially invalid exact configs", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response(null, { status: 405 });
				const request = (await req.json()) as { id?: string | number; method?: string };
				const id = request.id ?? 0;
				if (request.method === "initialize") {
					return Response.json({
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "partial", version: "1" },
						},
					});
				}
				if (request.method === "tools/list") {
					return Response.json({ jsonrpc: "2.0", id, result: { tools: [] } });
				}
				return Response.json({ jsonrpc: "2.0", id, result: {} });
			},
		});
		const cwd = await mkdtempExact("gjc-mcp-config-diagnostics-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		try {
			const missing = await manager.discoverAndConnect({ configPath });
			expect(Array.from(missing.errors)).toEqual([["$config", "MCP configuration unavailable"]]);

			await Bun.write(configPath, "{");
			const invalid = await manager.discoverAndConnect({ configPath });
			expect(Array.from(invalid.errors)).toEqual([["$config", "MCP configuration unavailable"]]);

			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						valid: { type: "http", url: server.url.href },
						invalid: { type: "http", url: server.url.href, enabled: "true" },
					},
				}),
			);
			const loaded = await loadMCPJsonFile(configPath, "project", { quiet: true, useCache: false });
			expect(loaded.items.map(serverConfig => serverConfig.name)).toEqual(["valid"]);
			expect(loaded.warnings).toEqual(["MCP configuration unavailable"]);
			const partial = await manager.discoverAndConnect({ configPath });
			expect(partial.connectedServers).toEqual(["valid"]);
			expect(Array.from(partial.errors)).toEqual([["$config", "MCP configuration unavailable"]]);
		} finally {
			await manager.disconnectAll();
			await server.stop(true);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("disconnect cancels an in-flight reconnect backoff", async () => {
		let failRequests = true;
		let requestCount = 0;
		let postDisconnectRequests = 0;
		let countAfterDisconnect = false;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				requestCount++;
				if (countAfterDisconnect) postDisconnectRequests++;
				if (failRequests) return new Response("down", { status: 503 });
				const body = (await req.json()) as JsonRpcMessage;
				const id = "id" in body ? body.id : 0;
				if ("method" in body && body.method === "initialize") {
					return Response.json({
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "http-test", version: "1" },
						},
					});
				}
				if ("method" in body && body.method === "tools/list") {
					return Response.json({ jsonrpc: "2.0", id, result: { tools: [] } });
				}
				return Response.json({ jsonrpc: "2.0", id: "id" in body ? body.id : 0, result: {} });
			},
		});
		try {
			const manager = new MCPManager(process.cwd());
			await manager.connectServers(
				{
					good: { type: "http", url: server.url.href, timeout: 500 },
				},
				{},
			);
			failRequests = true;
			postDisconnectRequests = 0;
			const reconnect = manager.reconnectServer("good");
			await waitFor(() => requestCount > 2);
			await manager.disconnectServer("good");
			countAfterDisconnect = true;
			failRequests = false;
			const afterDisconnect = postDisconnectRequests;
			await Bun.sleep(700);
			await expect(reconnect).resolves.toBeNull();
			expect(postDisconnectRequests).toBe(afterDisconnect);
			expect(manager.getConnectedServers()).toEqual([]);
		} finally {
			await server.stop(true);
		}
	});

	test("disconnect during in-flight reconnect prevents stale same-name re-add from registering", async () => {
		let initializeCount = 0;
		let releaseFirstInitialize: (() => void) | undefined;
		let deleteCount = 0;
		const firstInitialize = new Promise<void>(resolve => {
			releaseFirstInitialize = resolve;
		});
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "DELETE") {
					deleteCount++;
					return new Response(null, { status: 202 });
				}
				if (req.method === "GET") {
					return new Response(null, { status: 405 });
				}
				const body = (await req.json()) as JsonRpcMessage;
				const id = "id" in body ? body.id : 0;
				if ("method" in body && body.method === "initialize") {
					initializeCount++;
					if (initializeCount === 2) await firstInitialize;
					return Response.json(
						{
							jsonrpc: "2.0",
							id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "stale", version: "1" },
							},
						},
						{ headers: { "Mcp-Session-Id": `session-${initializeCount}` } },
					);
				}
				if ("method" in body && body.method === "tools/list") {
					return Response.json({ jsonrpc: "2.0", id, result: { tools: [] } });
				}
				return Response.json({ jsonrpc: "2.0", id, result: {} });
			},
		});
		try {
			const manager = new MCPManager(process.cwd());
			const config = { type: "http" as const, url: server.url.href, timeout: 500 };
			const initial = await manager.connectServers({ stale: config }, {});
			expect(initial.errors.size).toBe(0);
			expect(initial.connectedServers).toEqual(["stale"]);
			const reconnect = manager.reconnectServer("stale");
			await waitFor(() => initializeCount === 2);
			await manager.disconnectServer("stale");
			const result = await manager.connectServers({ stale: config }, {});
			expect(result.errors.size).toBe(0);
			expect(result.connectedServers).toEqual(["stale"]);
			expect(manager.getConnectedServers()).toEqual(["stale"]);
			releaseFirstInitialize?.();
			await expect(reconnect).resolves.toBeNull();
			expect(manager.getConnectedServers()).toEqual(["stale"]);
			await waitFor(() => deleteCount > 0);
		} finally {
			await server.stop(true);
		}
	});

	test("stale initial tools/list success does not overwrite fresh same-name tools", async () => {
		let releaseStaleTools: (() => void) | undefined;
		const staleToolsBlocked = new Promise<void>(resolve => {
			releaseStaleTools = resolve;
		});
		let initializeCount = 0;
		let toolsListCount = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "DELETE") return new Response(null, { status: 202 });
				if (req.method === "GET") return new Response(null, { status: 405 });
				const body = (await req.json()) as JsonRpcMessage;
				const id = "id" in body ? body.id : 0;
				if ("method" in body && body.method === "initialize") {
					initializeCount++;
					return Response.json(
						{
							jsonrpc: "2.0",
							id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "stale-success", version: String(initializeCount) },
							},
						},
						{ headers: { "Mcp-Session-Id": `session-${initializeCount}` } },
					);
				}
				if ("method" in body && body.method === "tools/list") {
					toolsListCount++;
					if (toolsListCount === 1) await staleToolsBlocked;
					const suffix = toolsListCount === 1 ? "stale" : "fresh";
					return Response.json({
						jsonrpc: "2.0",
						id,
						result: { tools: [{ name: suffix, inputSchema: { type: "object" } }] },
					});
				}
				return Response.json({ jsonrpc: "2.0", id, result: {} });
			},
		});
		try {
			const manager = new MCPManager(process.cwd());
			const config = { type: "http" as const, url: server.url.href, timeout: 1_000 };
			const firstConnect = manager.connectServers({ same: config }, {});
			await waitFor(() => toolsListCount === 1);
			await manager.disconnectServer("same");
			const fresh = await manager.connectServers({ same: config }, {});
			expect(fresh.errors.size).toBe(0);
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__same_fresh"]);
			releaseStaleTools?.();
			await expect(firstConnect).resolves.toMatchObject({ connectedServers: [] });
			await Bun.sleep(50);
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__same_fresh"]);
			expect(manager.getConnectedServers()).toEqual(["same"]);
		} finally {
			await server.stop(true);
		}
	});

	test("stale initial tools/list failure does not delete fresh same-name connection", async () => {
		let releaseStaleTools: (() => void) | undefined;
		const staleToolsBlocked = new Promise<void>(resolve => {
			releaseStaleTools = resolve;
		});
		let initializeCount = 0;
		let toolsListCount = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "DELETE") return new Response(null, { status: 202 });
				if (req.method === "GET") return new Response(null, { status: 405 });
				const body = (await req.json()) as JsonRpcMessage;
				const id = "id" in body ? body.id : 0;
				if ("method" in body && body.method === "initialize") {
					initializeCount++;
					return Response.json(
						{
							jsonrpc: "2.0",
							id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "stale-failure", version: String(initializeCount) },
							},
						},
						{ headers: { "Mcp-Session-Id": `session-${initializeCount}` } },
					);
				}
				if ("method" in body && body.method === "tools/list") {
					toolsListCount++;
					if (toolsListCount === 1) {
						await staleToolsBlocked;
						return Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: "stale boom" } });
					}
					return Response.json({
						jsonrpc: "2.0",
						id,
						result: { tools: [{ name: "fresh", inputSchema: { type: "object" } }] },
					});
				}
				return Response.json({ jsonrpc: "2.0", id, result: {} });
			},
		});
		try {
			const manager = new MCPManager(process.cwd());
			const config = { type: "http" as const, url: server.url.href, timeout: 1_000 };
			const firstConnect = manager.connectServers({ same: config }, {});
			await waitFor(() => toolsListCount === 1);
			await manager.disconnectServer("same");
			const fresh = await manager.connectServers({ same: config }, {});
			expect(fresh.errors.size).toBe(0);
			expect(manager.getConnectedServers()).toEqual(["same"]);
			releaseStaleTools?.();
			const stale = await firstConnect;
			expect(stale.errors.get("same")).toContain("stale boom");
			await Bun.sleep(50);
			expect(manager.getConnectedServers()).toEqual(["same"]);
			expect(manager.getConnectionStatus("same")).toBe("connected");
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__same_fresh"]);
		} finally {
			await server.stop(true);
		}
	});

	test("stale refresh tools/list success does not overwrite fresh same-name tools", async () => {
		let releaseStaleRefresh: (() => void) | undefined;
		const staleRefreshBlocked = new Promise<void>(resolve => {
			releaseStaleRefresh = resolve;
		});
		let initializeCount = 0;
		let toolsListCount = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "DELETE") return new Response(null, { status: 202 });
				if (req.method === "GET") return new Response(null, { status: 405 });
				const body = (await req.json()) as JsonRpcMessage;
				const id = "id" in body ? body.id : 0;
				if ("method" in body && body.method === "initialize") {
					initializeCount++;
					return Response.json(
						{
							jsonrpc: "2.0",
							id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "stale-refresh", version: String(initializeCount) },
							},
						},
						{ headers: { "Mcp-Session-Id": `session-${initializeCount}` } },
					);
				}
				if ("method" in body && body.method === "tools/list") {
					toolsListCount++;
					if (toolsListCount === 2) await staleRefreshBlocked;
					const suffix = toolsListCount === 2 ? "staleRefresh" : toolsListCount === 1 ? "freshOne" : "freshThree";
					return Response.json({
						jsonrpc: "2.0",
						id,
						result: { tools: [{ name: suffix, inputSchema: { type: "object" } }] },
					});
				}
				return Response.json({ jsonrpc: "2.0", id, result: {} });
			},
		});
		try {
			const manager = new MCPManager(process.cwd());
			const config = { type: "http" as const, url: server.url.href, timeout: 1_000 };
			const initial = await manager.connectServers({ same: config }, {});
			expect(initial.errors.size).toBe(0);
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__same_freshone"]);

			const refresh = manager.refreshServerTools("same");
			await waitFor(() => toolsListCount === 2);
			await manager.disconnectServer("same");
			const fresh = await manager.connectServers({ same: config }, {});
			expect(fresh.errors.size).toBe(0);
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__same_freshthree"]);

			releaseStaleRefresh?.();
			await refresh;
			await Bun.sleep(50);
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__same_freshthree"]);
			expect(manager.getConnectedServers()).toEqual(["same"]);
		} finally {
			await server.stop(true);
		}
	});

	test("stdio reconnect waits for old process tree to die before spawning replacement", async () => {
		const pidFile = `/tmp/gjc-mcp-manager-reconnect-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`;
		const childPidFile = `${pidFile}.child`;
		const startupOldAliveFile = `${pidFile}.old-alive`;
		const serverScript = `
const fs = require("fs");
const cp = require("child_process");
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === "EPERM"; }
}
const priorChildren = fs.existsSync(${JSON.stringify(childPidFile)}) ? fs.readFileSync(${JSON.stringify(childPidFile)}, "utf8").trim().split(/\\n+/).filter(Boolean).map(Number) : [];
if (priorChildren.length > 0) fs.appendFileSync(${JSON.stringify(startupOldAliveFile)}, String(alive(priorChildren[0])) + "\\n");
const child = cp.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
fs.appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
fs.appendFileSync(${JSON.stringify(childPidFile)}, String(child.pid) + "\\n");
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`;
		const manager = new MCPManager(process.cwd());
		try {
			const result = await manager.connectServers(
				{
					stdio: { type: "stdio", command: process.execPath, args: ["-e", serverScript], timeout: 1_000 },
				},
				{},
			);
			expect(result.errors.size).toBe(0);
			await waitFor(async () => (await readPidList(childPidFile)).length >= 1);
			const oldChildPid = (await readPidList(childPidFile))[0]!;
			expect(isAlive(oldChildPid)).toBe(true);

			await expect(manager.reconnectServer("stdio")).resolves.toBeDefined();
			await waitFor(async () => (await readPidList(childPidFile)).length >= 2);
			const childPids = await readPidList(childPidFile);
			const newChildPid = childPids.at(-1)!;
			expect(newChildPid).not.toBe(oldChildPid);
			expect(isAlive(oldChildPid)).toBe(false);
			expect(isAlive(newChildPid)).toBe(true);
			expect(
				(
					await Bun.file(startupOldAliveFile)
						.text()
						.catch(() => "")
				).trim(),
			).toBe("false");
		} finally {
			await manager.disconnectAll().catch(() => {});
			await Bun.file(pidFile)
				.delete()
				.catch(() => {});
			await Bun.file(childPidFile)
				.delete()
				.catch(() => {});
			await Bun.file(startupOldAliveFile)
				.delete()
				.catch(() => {});
		}
	});
});
