import { describe, expect, test, vi } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@gajae-code/utils";
import * as configValue from "../../src/config/resolve-config-value";
import { loadMCPJsonFile } from "../../src/discovery/mcp-json";
import * as mcpClient from "../../src/runtime-mcp/client";
import { createMCPManager, MCPManager, resolveExactConfigStartupTimeoutMs } from "../../src/runtime-mcp/manager";
import { legacyEraObservation } from "../../src/runtime-mcp/protocol";
import { MCPTool } from "../../src/runtime-mcp/tool-bridge";
import type { JsonRpcMessage, MCPServerConfig, MCPServerConnection, MCPTransport } from "../../src/runtime-mcp/types";
import { MCPExpectedFailure } from "../../src/runtime-mcp/types";
import { legacyMcpMethodNotFound } from "../mcp-test-utils";

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
function makeConnection(name: string, close: () => Promise<void>): MCPServerConnection {
	return {
		name,
		config: { type: "http", url: "http://127.0.0.1:1" },
		transport: {
			connected: true,
			async request() {
				throw new Error("unused");
			},
			async notify() {},
			close,
		} satisfies MCPTransport,
		serverInfo: { name: "test", version: "1" },
		capabilities: { tools: {} },
		protocol: legacyEraObservation({
			preference: "auto",
			effectiveVersion: "2025-03-26",
			negotiation: "legacy-fallback",
			downgradeReason: "legacy-server-signal",
			serverInfo: { name: "test", version: "1" },
			capabilities: { tools: true },
		}),
	};
}

function stdioServerScript(behavior: "failTools" | "malformedTools" | "okTools"): string {
	return `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    ${behavior === "failTools" ? "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom' } }) + '\\n');" : behavior === "malformedTools" ? "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: 'invalid' } }) + '\\n');" : "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');"}
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
	// The long startup ceiling is ACP-scoped (PR #3164 Option B): a slow gateway
	// gets its configured window only when the caller supplies an explicit
	// budget, as ACP lifecycle launches do. Without one, the short default
	// applies so an ordinary consumer cannot be hung by a large `timeout`.
	test("honors a configured startup timeout for a slow stdio gateway on an ACP-scoped budget", async () => {
		const manager = new MCPManager(process.cwd(), null, { maxStartupTimeoutMs: 30_500 });
		const delayedServer = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'slow-gateway', version: '1' } } }) + '\\n');
    }, 2200);
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;

		try {
			const result = await manager.connectServers(
				{
					"slow-gateway": {
						command: process.execPath,
						args: ["-e", delayedServer],
						timeout: 5_000,
					},
				},
				{},
			);

			expect(result.errors).toEqual(new Map());
			expect(result.connectedServers).toEqual(["slow-gateway"]);
		} finally {
			await manager.disconnectAll();
		}
	});

	test("uses the 30-second default only for exact-config servers that omit timeout", () => {
		expect(
			resolveExactConfigStartupTimeoutMs([
				{ command: "configured-long", timeout: 5_000 },
				{ command: "configured-short", timeout: 1_000 },
			]),
		).toBe(5_500);
		expect(
			resolveExactConfigStartupTimeoutMs([{ command: "configured", timeout: 5_000 }, { command: "default" }]),
		).toBe(30_500);
		expect(resolveExactConfigStartupTimeoutMs([{ command: "configured-long", timeout: 35_000 }])).toBe(35_500);
		expect(resolveExactConfigStartupTimeoutMs([{ command: "invalid", timeout: 0 }])).toBe(30_500);
		expect(resolveExactConfigStartupTimeoutMs([])).toBe(250);
	});

	test("honors default and configured connection timeouts for an explicit tools-only config", async () => {
		const cwd = await mkdtempExact("gjc-mcp-explicit-timeout-");
		const configPath = join(cwd, "mcp.json");
		const delayedServer = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'slow-exact', version: '1' } } }) + '\\n');
    }, 2200);
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
		const manager = new MCPManager(cwd, null, { toolsOnly: true });

		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						"slow-exact": {
							command: process.execPath,
							args: ["-e", delayedServer],
							timeout: 5_000,
						},
						"slow-default": {
							command: process.execPath,
							args: ["-e", delayedServer],
						},
					},
				}),
			);

			const result = await manager.discoverAndConnect({ configPath });

			expect(result.errors).toEqual(new Map());
			expect(result.connectedServers).toEqual(["slow-exact", "slow-default"]);
		} finally {
			await manager.disconnectAll();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	// The same slow gateway must NOT be able to hang an ordinary consumer for
	// ~30s: without an ACP budget the short default ceiling applies and startup
	// stops waiting instead of blocking out the configured `timeout`. It stops
	// *waiting* only — the declared window is the operator's, so the connection
	// keeps running and lands in the background.
	test("does not block a non-ACP consumer for the configured window", async () => {
		const manager = new MCPManager(process.cwd());
		const delayedServer = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'slow-gateway', version: '1' } } }) + '\\n');
    }, 2200);
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;

		const startedAt = Date.now();
		try {
			const result = await manager.connectServers(
				{
					"slow-gateway": {
						command: process.execPath,
						args: ["-e", delayedServer],
						timeout: 5_000,
					},
				},
				{},
			);

			// Startup returned at the short default ceiling rather than waiting for
			// the 2.2s handshake behind a 5s configured timeout.
			expect(result.connectedServers).toEqual([]);
			expect(Date.now() - startedAt).toBeLessThan(2_200);
			// The 5s window the operator declared has not elapsed, so the gateway is
			// still connecting rather than reported as a startup failure.
			expect(result.errors.has("slow-gateway")).toBe(false);
			expect(manager.getConnectionStatus("slow-gateway")).toBe("connecting");
			await waitFor(() => manager.getConnectedServers().includes("slow-gateway"));
		} finally {
			await manager.disconnectAll();
		}
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
					mcpBinding: { resourceOrigin: server.url.origin, tokenEndpoint: tokenUrl },
				}),
				forceRefreshOAuthCredential: async () => {
					throw new Error(`${rawFailure}:${refreshToken}`);
				},
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

			expect(debugSpy).toHaveBeenCalledWith("MCP OAuth refresh failed");
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
	test.each([
		{
			name: "missing HTTP binding",
			type: "http" as const,
			binding: undefined,
			tokenUrl: "https://tokens.example/refresh",
		},
		{
			name: "mismatched HTTP origin",
			type: "http" as const,
			binding: { resourceOrigin: "https://other.example", tokenEndpoint: "https://tokens.example/refresh" },
			tokenUrl: "https://tokens.example/refresh",
		},
		{
			name: "missing SSE binding",
			type: "sse" as const,
			binding: undefined,
			tokenUrl: "https://tokens.example/refresh",
		},
		{
			name: "tampered token endpoint",
			type: "http" as const,
			binding: { resourceOrigin: "https://mcp.example", tokenEndpoint: "https://tokens.example/refresh" },
			tokenUrl: "https://attacker.example/refresh",
		},
	])("fails closed without refreshing an OAuth credential with $name", async ({ type, binding, tokenUrl }) => {
		const manager = new MCPManager(process.cwd());
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const forceRefresh = vi.fn(async () => {
			throw new Error("must not refresh");
		});
		const access = "BOUNDARY_ACCESS_VALUE";
		const refresh = "BOUNDARY_REFRESH_VALUE";
		manager.setAuthStorage({
			get: () => ({
				type: "oauth",
				access,
				refresh,
				expires: Date.now() - 1,
				...(binding ? { mcpBinding: binding } : {}),
			}),
			forceRefreshOAuthCredential: forceRefresh,
		} as never);

		try {
			const failure = await manager
				.prepareConfig({
					type,
					url: "https://mcp.example/path",
					headers: { "X-Public": "value" },
					auth: {
						type: "oauth",
						credentialId: "BOUNDARY_CREDENTIAL_ID",
						tokenUrl,
					},
				})
				.then(
					() => new Error("Expected OAuth binding validation to reject"),
					error => error,
				);

			expect(failure).toBeInstanceOf(MCPExpectedFailure);
			expect((failure as MCPExpectedFailure).message).toBe("MCP server operation failed");
			expect((failure as MCPExpectedFailure).cause).toBeUndefined();
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(forceRefresh).not.toHaveBeenCalled();
			const diagnostics = JSON.stringify(failure);
			for (const value of [access, refresh, "BOUNDARY_CREDENTIAL_ID", tokenUrl]) {
				expect(diagnostics).not.toContain(value);
			}
		} finally {
			vi.restoreAllMocks();
		}
	});
	test("refreshes and injects OAuth only for the exact bound endpoint origin", async () => {
		const manager = new MCPManager(process.cwd());
		const forceRefresh = vi.fn(async () => ({
			type: "oauth" as const,
			access: "new-access",
			refresh: "new-refresh",
			expires: Date.now() + 3_600_000,
			mcpBinding: {
				resourceOrigin: "https://mcp.example",
				tokenEndpoint: "https://tokens.example/refresh",
			},
		}));
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		manager.setAuthStorage({
			get: () => ({
				type: "oauth",
				access: "old-access",
				refresh: "old-refresh",
				expires: Date.now() - 1,
				mcpBinding: {
					resourceOrigin: "https://mcp.example",
					tokenEndpoint: "https://tokens.example/refresh",
				},
			}),
			forceRefreshOAuthCredential: forceRefresh,
		} as never);

		try {
			const resolved = await manager.prepareConfig({
				type: "http",
				url: "https://mcp.example/another/path?query=1",
				auth: {
					type: "oauth",
					credentialId: "credential",
				},
			});

			if (resolved.type !== "http") throw new Error("Expected HTTP MCP config");
			expect(resolved.headers?.Authorization).toBe("Bearer new-access");
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(forceRefresh).toHaveBeenCalledWith("credential", expect.objectContaining({ access: "old-access" }), {
				clientId: undefined,
				clientSecret: undefined,
			});
		} finally {
			vi.restoreAllMocks();
		}
	});
	test("fails closed when authoritative refresh returns a missing MCP binding", async () => {
		const manager = new MCPManager(process.cwd());
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		manager.setAuthStorage({
			get: () => ({
				type: "oauth",
				access: "old-access",
				refresh: "__remote__",
				expires: Date.now() - 1,
				mcpBinding: {
					resourceOrigin: "https://mcp.example",
					tokenEndpoint: "https://tokens.example/refresh",
				},
			}),
			forceRefreshOAuthCredential: async () => ({
				type: "oauth",
				access: "untrusted-new-access",
				refresh: "__remote__",
				expires: Date.now() + 3_600_000,
			}),
		} as never);

		try {
			await expect(
				manager.prepareConfig({
					type: "http",
					url: "https://mcp.example/path",
					auth: { type: "oauth", credentialId: "credential" },
				}),
			).rejects.toThrow("MCP server operation failed");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});
	test("propagates unexpected tools-only OAuth resolution failures", async () => {
		const cwd = await mkdtempExact("gjc-mcp-oauth-unexpected-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		const failure = new Error("unexpected credential storage failure");
		try {
			manager.setAuthStorage({
				get: () => {
					throw failure;
				},
			} as never);
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						auth: {
							type: "http",
							url: "http://127.0.0.1:1",
							auth: { type: "oauth", credentialId: "credential" },
						},
					},
				}),
			);

			await expect(manager.discoverAndConnect({ configPath })).rejects.toBe(failure);
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getAllServerNames()).toEqual([]);
			expect(manager.getTools()).toEqual([]);
		} finally {
			await manager.disconnectAll();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("preserves normal-mode config resolution failure identity", async () => {
		const manager = new MCPManager(process.cwd());
		const failure = Object.assign(new Error("normal config resolution failed"), { code: "ENOENT" });
		const resolverSpy = vi.spyOn(configValue, "resolveConfigValue").mockRejectedValue(failure);
		try {
			await expect(
				manager.prepareConfig({
					type: "http",
					url: "http://127.0.0.1:1",
					headers: { Authorization: "!resolve-token" },
				}),
			).rejects.toBe(failure);
		} finally {
			resolverSpy.mockRestore();
		}
	});
	test("fails tools-only servers before connecting when config resolution fails or is missing", async () => {
		const cwd = await mkdtempExact("gjc-mcp-config-resolution-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		const resolutionFailure = Object.assign(new Error("config path unavailable"), { code: "ENOENT" });
		const resolverSpy = vi.spyOn(configValue, "resolveConfigValue").mockImplementation(async value => {
			if (value === "!missing-token") return undefined;
			throw resolutionFailure;
		});
		const connectSpy = vi.spyOn(mcpClient, "connectToServer").mockImplementation(async () => {
			throw new Error("config resolution should prevent connection");
		});
		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						path: {
							type: "http",
							url: "http://127.0.0.1:1",
							headers: { Authorization: "!path-token" },
						},
						missing: {
							type: "http",
							url: "http://127.0.0.1:2",
							headers: { Authorization: "!missing-token" },
						},
					},
				}),
			);

			const result = await manager.discoverAndConnect({ configPath });
			expect(Array.from(result.errors)).toEqual([
				["path", "MCP server unavailable"],
				["missing", "MCP server unavailable"],
			]);
			expect(result.connectedServers).toEqual([]);
			expect(connectSpy).not.toHaveBeenCalled();
			expect(manager.getConnectedServers()).toEqual([]);
		} finally {
			await manager.disconnectAll();
			resolverSpy.mockRestore();
			connectSpy.mockRestore();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("fails closed when a forced 401 refresh fails", async () => {
		let deleteCount = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "DELETE") {
					deleteCount++;
					return new Response(null, { status: 204 });
				}
				if (req.method === "GET") return new Response(null, { status: 405 });
				const request = (await req.json()) as { id?: string | number; method?: string };
				const id = request.id ?? 0;
				if (request.method === "initialize") {
					return Response.json(
						{
							jsonrpc: "2.0",
							id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "auth-retry", version: "1" },
							},
						},
						{ headers: { "Mcp-Session-Id": "auth-retry-session" } },
					);
				}
				if (request.method === "tools/list") {
					return new Response("denied", { status: 401 });
				}
				if (request.method === "server/discover") return legacyMcpMethodNotFound(id);
				return new Response(null, { status: 202 });
			},
		});
		const cwd = await mkdtempExact("gjc-mcp-auth-callback-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		const failure = new Error("SECRET_REFRESH_FAILURE");
		const forceRefresh = vi.fn(async () => {
			throw failure;
		});
		try {
			manager.setAuthStorage({
				get: () => ({
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60 * 60_000,
					mcpBinding: {
						resourceOrigin: server.url.origin,
						tokenEndpoint: "https://auth.example/token",
					},
				}),
				forceRefreshOAuthCredential: forceRefresh,
			} as never);
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						auth: {
							type: "http",
							url: server.url.href,
							auth: { type: "oauth", credentialId: "credential" },
						},
					},
				}),
			);

			const result = await manager.discoverAndConnect({ configPath });
			expect(result.errors.get("auth")).toBe("MCP server unavailable");
			expect(JSON.stringify(result.errors)).not.toContain(failure.message);
			expect(forceRefresh).toHaveBeenCalledTimes(1);
			expect(deleteCount).toBe(1);
			expect(manager.getConnectedServers()).toEqual([]);
		} finally {
			await manager.disconnectAll();
			await server.stop(true);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("routes a remote OAuth 401 refresh through authoritative storage", async () => {
		const authorizationHeaders: string[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") return new Response(null, { status: 204 });
				if (request.method === "GET") return new Response(null, { status: 405 });
				const body = await request.text();
				authorizationHeaders.push(request.headers.get("authorization") ?? "");
				const rpc = JSON.parse(body) as { id?: string | number; method?: string };
				if (rpc.method === "initialize") {
					return Response.json(
						{
							jsonrpc: "2.0",
							id: rpc.id ?? 0,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "remote-auth-retry", version: "1" },
							},
						},
						{ headers: { "Mcp-Session-Id": "remote-auth-retry-session" } },
					);
				}
				if (rpc.method === "tools/list") return new Response("denied", { status: 401 });
				if (rpc.method === "server/discover") return legacyMcpMethodNotFound(rpc.id ?? 0);
				return new Response(null, { status: 202 });
			},
		});
		const cwd = await mkdtempExact("gjc-mcp-remote-auth-retry-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		const binding = { resourceOrigin: server.url.origin, tokenEndpoint: "https://auth.example/token" };
		const forceRefresh = vi.fn(async () => ({
			type: "oauth" as const,
			access: "remote-new-access",
			refresh: "__remote__",
			expires: Date.now() + 60 * 60_000,
			mcpBinding: binding,
		}));
		manager.setAuthStorage({
			get: () => ({
				type: "oauth",
				access: "remote-old-access",
				refresh: "__remote__",
				expires: Date.now() + 60 * 60_000,
				mcpBinding: binding,
			}),
			forceRefreshOAuthCredential: forceRefresh,
		} as never);

		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						remote: {
							type: "http",
							url: server.url.href,
							auth: { type: "oauth", credentialId: "credential" },
						},
					},
				}),
			);
			const result = await manager.discoverAndConnect({ configPath });
			expect(result.errors.get("remote")).toBe("MCP server unavailable");
			expect(forceRefresh).toHaveBeenCalledTimes(1);
			expect(authorizationHeaders).toContain("Bearer remote-old-access");
			expect(authorizationHeaders).toContain("Bearer remote-new-access");
		} finally {
			await manager.disconnectAll();
			await server.stop(true);
			await rm(cwd, { recursive: true, force: true });
			vi.restoreAllMocks();
		}
	});
	test("fails soft per server for malformed HTTP initialize and stdio tools/list results", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const request = (await req.json()) as { id?: string | number };
				return Response.json({
					jsonrpc: "2.0",
					id: request.id ?? 0,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: [],
						serverInfo: { name: "malformed", version: "1" },
					},
				});
			},
		});
		const cwd = await mkdtempExact("gjc-mcp-malformed-results-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						"http-initialize": { type: "http", url: server.url.href },
						"stdio-tools": {
							type: "stdio",
							command: process.execPath,
							args: ["-e", stdioServerScript("malformedTools")],
						},
					},
				}),
			);

			const result = await manager.discoverAndConnect({ configPath });
			expect(result.connectedServers).toEqual([]);
			expect(result.tools).toEqual([]);
			expect(Array.from(result.errors)).toEqual([
				["http-initialize", "MCP server unavailable"],
				["stdio-tools", "MCP server unavailable"],
			]);
			expect(manager.getConnectedServers()).toEqual([]);
		} finally {
			await manager.disconnectAll();
			await server.stop(true);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("keeps typed malformed and missing response failures generic in tools-only startup", async () => {
		const cwd = await mkdtempExact("gjc-mcp-typed-startup-failures-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		const failures = new Map<string, MCPExpectedFailure>([
			["malformed-json", new MCPExpectedFailure(new SyntaxError("Unexpected token < in JSON"))],
			["missing-body", new MCPExpectedFailure(new Error("MCP response body missing"))],
			["missing-response", new MCPExpectedFailure(new Error("MCP response missing"))],
			["typed", new MCPExpectedFailure()],
		]);
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(async name => {
			throw failures.get(name)!;
		});

		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: Object.fromEntries(
						Array.from(failures.keys(), name => [name, { type: "http", url: "http://127.0.0.1:1" }]),
					),
				}),
			);

			const result = await manager.discoverAndConnect({ configPath });
			expect(result.connectedServers).toEqual([]);
			expect(result.tools).toEqual([]);
			expect(Array.from(result.errors)).toEqual(
				Array.from(failures.keys(), name => [name, "MCP server unavailable"]),
			);
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getAllServerNames()).toEqual([]);
			expect(manager.getTools()).toEqual([]);
		} finally {
			await manager.disconnectAll();
			vi.restoreAllMocks();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("does not open a transport when onConnecting throws before authentication resolves", async () => {
		const manager = new MCPManager(process.cwd());
		const primaryFailure = new Error("onConnecting failure");
		const connectSpy = vi.spyOn(mcpClient, "connectToServer");
		const listToolsSpy = vi.spyOn(mcpClient, "listTools");
		try {
			await expect(
				manager.connectServers({ late: { type: "http", url: "http://127.0.0.1:1" } }, {}, () => {
					throw primaryFailure;
				}),
			).rejects.toBe(primaryFailure);
			expect(connectSpy).not.toHaveBeenCalled();
			expect(listToolsSpy).not.toHaveBeenCalled();
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getAllServerNames()).toEqual([]);
			expect(manager.getTools()).toEqual([]);
		} finally {
			await manager.disconnectAll();
			vi.restoreAllMocks();
		}
	});
	test("awaits a pending sibling transport before propagating an unexpected tools-only failure", async () => {
		const cwd = await mkdtempExact("gjc-mcp-pending-sibling-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		const primaryFailure = new Error("untyped tools/list failure");
		const closeRelease = Promise.withResolvers<void>();
		const closeStarted = Promise.withResolvers<void>();
		const pendingTools = Promise.withResolvers<never>();
		let pendingCloseFinished = false;
		let pendingCloseCalls = 0;
		const badConnection = makeConnection("bad", async () => {});
		const pendingConnection = makeConnection("pending", async () => {
			pendingCloseCalls++;
			closeStarted.resolve();
			await closeRelease.promise;
			pendingCloseFinished = true;
		});
		const connectSpy = vi.spyOn(mcpClient, "connectToServer").mockImplementation(async name => {
			return name === "bad" ? badConnection : pendingConnection;
		});
		const listToolsSpy = vi.spyOn(mcpClient, "listTools").mockImplementation(async connection => {
			if (connection.name === "bad") throw primaryFailure;
			return pendingTools.promise;
		});
		let load: Promise<unknown> | undefined;

		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						bad: { type: "http", url: "http://127.0.0.1:1" },
						pending: { type: "http", url: "http://127.0.0.1:2" },
					},
				}),
			);

			const activeLoad = manager.discoverAndConnect({ configPath });
			load = activeLoad;
			await closeStarted.promise;
			expect(connectSpy).toHaveBeenCalledTimes(2);
			expect(listToolsSpy).toHaveBeenCalledTimes(2);

			const rejectedAfterCleanup = activeLoad.then(
				() => {
					throw new Error("Expected tools-only startup to reject");
				},
				error => {
					expect(pendingCloseFinished).toBe(true);
					throw error;
				},
			);
			closeRelease.resolve();

			await expect(rejectedAfterCleanup).rejects.toBe(primaryFailure);
			expect(pendingCloseCalls).toBe(1);
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getAllServerNames()).toEqual([]);
			expect(manager.getTools()).toEqual([]);
		} finally {
			closeRelease.resolve();
			if (load) await load.catch(() => undefined);
			await manager.disconnectAll();
			vi.restoreAllMocks();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("propagates untyped expected-looking tools/list failures after awaited cleanup", async () => {
		const cwd = await mkdtempExact("gjc-mcp-list-unexpected-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		const primaryFailure = Object.assign(new Error("MCP error -32000: expected-looking tools/list failure"), {
			code: "ECONNREFUSED",
		});
		const closeRelease = Promise.withResolvers<void>();
		const closeStarted = Promise.withResolvers<void>();
		let badCloseCalls = 0;
		let closeCompletionSentinel = false;
		const zeroCloseFailure = new Error("zero transport close failure");
		const zeroClose = vi.fn(async () => {
			throw zeroCloseFailure;
		});
		const badConnection = makeConnection("bad", async () => {
			badCloseCalls++;
			closeStarted.resolve();
			await closeRelease.promise;
			closeCompletionSentinel = true;
		});
		const zeroConnection = makeConnection("zero", zeroClose);
		const connectSpy = vi.spyOn(mcpClient, "connectToServer").mockImplementation(async name => {
			return name === "bad" ? badConnection : zeroConnection;
		});
		const listToolsSpy = vi.spyOn(mcpClient, "listTools").mockImplementation(async connection => {
			if (connection.name === "bad") throw primaryFailure;
			return [];
		});
		let load: Promise<unknown> | undefined;

		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						zero: { type: "http", url: "http://127.0.0.1:1" },
						bad: { type: "http", url: "http://127.0.0.1:2" },
					},
				}),
			);

			const activeLoad = manager.discoverAndConnect({ configPath });
			load = activeLoad;
			await closeStarted.promise;
			expect(connectSpy).toHaveBeenCalledTimes(2);
			expect(listToolsSpy).toHaveBeenCalledTimes(2);
			expect(manager.getConnectedServers()).toEqual(["zero"]);

			const rejectedAfterCleanup = activeLoad.then(
				() => {
					throw new Error("Expected the load to reject");
				},
				error => {
					expect(closeCompletionSentinel).toBe(true);
					throw error;
				},
			);

			closeRelease.resolve();
			await expect(rejectedAfterCleanup).rejects.toBe(primaryFailure);
			expect(badCloseCalls).toBe(1);
			expect(zeroClose).toHaveBeenCalledTimes(1);
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getAllServerNames()).toEqual([]);
			expect(manager.getTools()).toEqual([]);
		} finally {
			closeRelease.resolve();
			if (load) await load.catch(() => undefined);
			await manager.disconnectAll();
			vi.restoreAllMocks();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("rolls back a published normalized sibling tool before propagating an unexpected tools-only failure", async () => {
		const cwd = await mkdtempExact("gjc-mcp-normalized-rollback-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		const successfulServer = "Mixed-Case";
		const primaryFailure = Object.assign(new Error("MCP error -32000: expected-looking tools/list failure"), {
			code: "ECONNREFUSED",
		});
		const releaseFailure = Promise.withResolvers<void>();
		const publishedTool = Promise.withResolvers<void>();
		const successfulClose = vi.fn(async () => {});
		const failingClose = vi.fn(async () => {});
		const successfulConnection = makeConnection(successfulServer, successfulClose);
		const failingConnection = makeConnection("failing", failingClose);
		const originalFromTools = MCPTool.fromTools;
		vi.spyOn(MCPTool, "fromTools").mockImplementation((connection, tools, reconnect) => {
			const mcpTools = originalFromTools(connection, tools, reconnect);
			if (connection.name === successfulServer && mcpTools.length > 0) publishedTool.resolve();
			return mcpTools;
		});
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(async name => {
			return name === successfulServer ? successfulConnection : failingConnection;
		});
		vi.spyOn(mcpClient, "listTools").mockImplementation(async connection => {
			if (connection.name === successfulServer) {
				return [{ name: "real-tool", inputSchema: { type: "object" } }] as never;
			}
			await releaseFailure.promise;
			throw primaryFailure;
		});
		let load: Promise<unknown> | undefined;

		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						[successfulServer]: { type: "http", url: "http://127.0.0.1:1" },
						failing: { type: "http", url: "http://127.0.0.1:2" },
					},
				}),
			);
			const activeLoad = manager.discoverAndConnect({ configPath });
			load = activeLoad;

			await publishedTool.promise;
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__mixed_case_real_tool"]);

			const rejectedAfterCleanup = activeLoad.then(
				() => {
					throw new Error("Expected the load to reject");
				},
				error => {
					expect(successfulClose).toHaveBeenCalledTimes(1);
					expect(failingClose).toHaveBeenCalledTimes(1);
					expect(manager.getTools()).toEqual([]);
					throw error;
				},
			);
			releaseFailure.resolve();

			await expect(rejectedAfterCleanup).rejects.toBe(primaryFailure);
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getAllServerNames()).toEqual([]);
			expect(manager.getTools()).toEqual([]);
		} finally {
			releaseFailure.resolve();
			if (load) await load.catch(() => undefined);
			await manager.disconnectAll();
			vi.restoreAllMocks();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("fails closed when tools-only tool names collide", async () => {
		const cwd = await mkdtempExact("gjc-mcp-tool-collision-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		let closeCalls = 0;
		const connection = makeConnection("exact", async () => {
			closeCalls++;
		});
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([
			{ name: "same-tool", inputSchema: { type: "object" } },
			{ name: "same_tool", inputSchema: { type: "object" } },
		] as never);

		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						exact: { type: "http", url: "http://127.0.0.1:1" },
					},
				}),
			);

			await expect(manager.discoverAndConnect({ configPath })).rejects.toThrow(
				"MCP tool catalog contains duplicate tool names",
			);
			expect(closeCalls).toBe(1);
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getAllServerNames()).toEqual([]);
			expect(manager.getTools()).toEqual([]);
		} finally {
			await manager.disconnectAll();
			vi.restoreAllMocks();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("forces tools-only stdio servers to avoid inherited environment", async () => {
		const cwd = await mkdtempExact("gjc-mcp-stdio-isolation-");
		const configPath = join(cwd, "exact.json");
		const manager = new MCPManager(cwd, null, { toolsOnly: true });
		let capturedConfig: MCPServerConfig | undefined;
		let closeCalls = 0;
		const connection = makeConnection("stdio", async () => {
			closeCalls++;
		});
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(async (_name, config) => {
			capturedConfig = config;
			return connection;
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						stdio: {
							type: "stdio",
							command: "ignored",
							noInheritEnv: false,
						},
					},
				}),
			);

			await expect(manager.discoverAndConnect({ configPath })).resolves.toMatchObject({
				connectedServers: ["stdio"],
				tools: [],
			});
			expect(capturedConfig).toMatchObject({ type: "stdio", noInheritEnv: true });
			await manager.disconnectAll();
			expect(closeCalls).toBe(1);
		} finally {
			await manager.disconnectAll();
			vi.restoreAllMocks();
			await rm(cwd, { recursive: true, force: true });
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
					case "server/discover":
						return legacyMcpMethodNotFound(id);
					default:
						return Response.json({ jsonrpc: "2.0", id, result: {} });
				}
			},
		});
		const secondRequestMethods: string[] = [];
		const secondServer = Bun.serve({
			port: 0,
			async fetch(req) {
				secondRequestMethods.push(req.method);
				return new Response(null, { status: 503 });
			},
		});
		const cwd = await mkdtempExact("gjc-mcp-exact-");
		const configPath = join(cwd, "exact.json");
		const secondConfigPath = join(cwd, "second.json");
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
				secondConfigPath,
				JSON.stringify({
					mcpServers: {
						second: { type: "http", url: secondServer.url.href, timeout: 1_000 },
					},
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
			// auto preference probes server/discover first; this stub answers like a real legacy server.
			expect(requestMethods).toEqual([
				"server/discover",
				"initialize",
				"notifications/initialized",
				"tools/list",
				"tools/call",
			]);
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
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__exact_tool"]);
			result.tools.length = 0;
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__exact_tool"]);
			const toolSnapshot = manager.getTools();
			toolSnapshot.length = 0;
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__exact_tool"]);
			const firstCatalog = manager.getTools().map(tool => tool.name);
			const firstRequestCount = requestMethods.length;
			await expect(manager.discoverAndConnect({ configPath })).rejects.toThrow(
				"Tools-only MCP manager already loaded an explicit config",
			);
			await expect(manager.discoverAndConnect({ configPath: secondConfigPath })).rejects.toThrow(
				"Tools-only MCP manager already loaded an explicit config",
			);
			expect(requestMethods).toHaveLength(firstRequestCount);
			expect(secondRequestMethods).toEqual([]);
			expect(manager.getTools().map(tool => tool.name)).toEqual(firstCatalog);
			await expect(manager.disconnectServer("exact")).rejects.toThrow(
				"Tools-only MCP manager does not allow raw MCP access",
			);
			expect(manager.getConnectedServers()).toEqual(["exact"]);
			expect(manager.getServerResources("exact")).toBeUndefined();
			expect(manager.getServerPrompts("exact")).toBeUndefined();
			expect(manager.getServerInstructions().size).toBe(0);
			expect(resourceListCalls).toBe(0);
			expect(promptListCalls).toBe(0);
			expect(toolChanges).toBe(0);

			await manager.refreshServerTools("exact");
			expect(toolListCalls).toBe(1);
			await expect(manager.reconnectServer("exact")).resolves.toBeDefined();
		} finally {
			await manager.disconnectAll();
			await normalManager.disconnectAll();
			await server.stop(true);
			await secondServer.stop(true);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("validates exact quiet config shapes before connecting", async () => {
		const cwd = await mkdtempExact("gjc-mcp-malformed-exact-");
		const configPath = join(cwd, "exact.json");
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
				const manager = new MCPManager(cwd, null, { toolsOnly: true });
				try {
					const result = await manager.discoverAndConnect({ configPath });
					expect(result.connectedServers, name).toEqual([]);
					expect(result.tools, name).toEqual([]);
					expect(Array.from(result.errors), name).toEqual([["$config", "MCP configuration unavailable"]]);
				} finally {
					await manager.disconnectAll();
				}
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
				if (request.method === "server/discover") return legacyMcpMethodNotFound(id);
				return Response.json({ jsonrpc: "2.0", id, result: {} });
			},
		});
		const cwd = await mkdtempExact("gjc-mcp-config-diagnostics-");
		const configPath = join(cwd, "exact.json");
		const managers: MCPManager[] = [];
		const discoverExact = async () => {
			const manager = new MCPManager(cwd, null, { toolsOnly: true });
			managers.push(manager);
			return manager.discoverAndConnect({ configPath });
		};
		try {
			const missing = await discoverExact();
			expect(Array.from(missing.errors)).toEqual([["$config", "MCP configuration unavailable"]]);

			await Bun.write(configPath, "{");
			const invalid = await discoverExact();
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
			const partial = await discoverExact();
			expect(partial.connectedServers).toEqual(["valid"]);
			expect(Array.from(partial.errors)).toEqual([["$config", "MCP configuration unavailable"]]);
		} finally {
			for (const manager of managers) {
				await manager.disconnectAll();
			}
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
				if ("method" in body && body.method === "server/discover") return legacyMcpMethodNotFound(id);
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
				if ("method" in body && body.method === "server/discover") return legacyMcpMethodNotFound(id);
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
				if ("method" in body && body.method === "server/discover") return legacyMcpMethodNotFound(id);
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
				if ("method" in body && body.method === "server/discover") return legacyMcpMethodNotFound(id);
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
