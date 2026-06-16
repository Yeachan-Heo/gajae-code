import { describe, expect, test } from "bun:test";
import { MCPManager } from "../../src/runtime-mcp/manager";
import type { JsonRpcMessage } from "../../src/runtime-mcp/types";

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
				bad: { command: "node", args: ["-e", stdioServerScript("failTools")], timeout: 1_000 },
			},
			{},
		);

		expect(result.connectedServers).toEqual([]);
		expect(result.errors.get("bad")).toContain("boom");
		expect(manager.getConnectedServers()).toEqual([]);
		await expect(manager.waitForConnection("bad")).rejects.toThrow("MCP server not connected: bad");
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
