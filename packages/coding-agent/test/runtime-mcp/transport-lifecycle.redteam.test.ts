import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { liveOwnedProcessCount } from "../../src/runtime/process-lifecycle";
import { MCPManager } from "../../src/runtime-mcp/manager";
import { HttpTransport } from "../../src/runtime-mcp/transports/http";

const servers: Bun.Server<unknown>[] = [];
const managers: MCPManager[] = [];
const tmpFiles: string[] = [];

function tmpPath(name: string): string {
	const path = join("/tmp", `gjc-u8-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	tmpFiles.push(path);
	return path;
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

afterEach(async () => {
	for (const manager of managers.splice(0)) {
		await manager.disconnectAll().catch(() => {});
	}
	for (const server of servers.splice(0)) {
		await server.stop(true);
	}
	for (const path of tmpFiles.splice(0)) {
		await Bun.file(path)
			.delete()
			.catch(() => {});
	}
});

describe("MCP transport lifecycle red-team regressions", () => {
	test("stdio stdout EOF while process is alive reconnects after killing the old owned child tree", async () => {
		const before = liveOwnedProcessCount();
		const pidFile = tmpPath("stdio-pids");
		const childPidFile = tmpPath("stdio-child-pids");
		const serverScript = `
const fs = require("fs");
const cp = require("child_process");
const child = cp.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
fs.appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
fs.appendFileSync(${JSON.stringify(childPidFile)}, String(child.pid) + "\\n");
const rl = require("readline").createInterface({ input: process.stdin });
let sawTools = false;
rl.on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "redteam", version: "1" } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ok", inputSchema: { type: "object" } }] } }) + "\\n", () => {
      if (!sawTools) {
        sawTools = true;
        process.stdout.end();
      }
    });
  }
});
setInterval(()=>{},1000);
`;
		const manager = new MCPManager(process.cwd());
		managers.push(manager);
		const result = await manager.connectServers(
			{
				red: {
					type: "stdio",
					command: process.execPath,
					args: ["-e", serverScript],
					timeout: 1_000,
				},
			},
			{},
		);
		expect(result.errors.size).toBe(0);
		expect(result.connectedServers).toEqual(["red"]);

		await waitFor(async () => (await readPidList(pidFile)).length >= 1, 1_000);
		const connection = manager.getConnection("red");
		expect(connection).toBeDefined();
		connection!.transport.onClose?.();
		await waitFor(async () => {
			const serverPids = await readPidList(pidFile);
			const childPids = await readPidList(childPidFile);
			return serverPids.length >= 2 && childPids.length >= 2;
		}, 3_500);
		const serverPids = await readPidList(pidFile);
		const childPids = await readPidList(childPidFile);
		expect(serverPids.length).toBeGreaterThanOrEqual(2);
		expect(childPids.length).toBeGreaterThanOrEqual(2);
		const oldServerPid = serverPids[0]!;
		const oldChildPid = childPids[0]!;
		const newServerPid = serverPids.at(-1)!;
		const newChildPid = childPids.at(-1)!;
		expect(newServerPid).not.toBe(oldServerPid);
		expect(newChildPid).not.toBe(oldChildPid);
		await waitFor(() => !isAlive(oldServerPid) && !isAlive(oldChildPid), 2_000);
		expect(isAlive(newServerPid)).toBe(true);
		expect(isAlive(newChildPid)).toBe(true);
		expect(liveOwnedProcessCount()).toBe(before + 1);

		await manager.disconnectServer("red");
		await waitFor(() => !isAlive(newServerPid) && !isAlive(newChildPid), 2_000);
		await waitFor(() => liveOwnedProcessCount() === before, 2_000);
	});

	test("HTTP response that sends headers then stalls its body rejects within configured timeout", async () => {
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			fetch() {
				return new Response(new ReadableStream({ start() {} }), {
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		servers.push(server);
		const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 75 });
		await transport.connect();
		const started = Date.now();
		await expect(transport.request("tools/list")).rejects.toThrow("Request timeout after 75ms");
		expect(Date.now() - started).toBeLessThan(1_000);
		await transport.close();
	});

	test("Streamable HTTP text/event-stream request aborts per-request reader after matching response", async () => {
		let cancelCount = 0;
		const originalCancel = ReadableStream.prototype.cancel;
		ReadableStream.prototype.cancel = function (...args: Parameters<ReadableStream["cancel"]>) {
			cancelCount++;
			return originalCancel.apply(this, args);
		};
		try {
			const server = Bun.serve({
				port: 0,
				idleTimeout: 255,
				async fetch(req) {
					const request = (await req.json()) as { id: string | number };
					const stream = new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n\n`,
								),
							);
						},
					});
					return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
				},
			});
			servers.push(server);
			const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 500 });
			await transport.connect();
			await expect(transport.request("tools/list")).resolves.toEqual({ ok: true });
			await waitFor(() => cancelCount > 0, 1_000);
			await transport.close();
		} finally {
			ReadableStream.prototype.cancel = originalCancel;
		}
	});

	test("initial listTools rejection closes transport and leaves server unregistered", async () => {
		let deleteCount = 0;
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			async fetch(req) {
				if (req.method === "DELETE") {
					deleteCount++;
					return new Response(null, { status: 202 });
				}
				if (req.method === "GET") {
					return new Response(null, { status: 405 });
				}
				const request = (await req.json()) as { id: string | number; method: string };
				if (request.method === "initialize") {
					return Response.json(
						{
							jsonrpc: "2.0",
							id: request.id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "bad", version: "1" },
							},
						},
						{ headers: { "Mcp-Session-Id": "bad-session" } },
					);
				}
				if (request.method === "initialized" || request.method === "notifications/initialized") {
					return new Response(null, { status: 202 });
				}
				return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "boom" } });
			},
		});
		servers.push(server);
		const manager = new MCPManager(process.cwd());
		managers.push(manager);
		const result = await manager.connectServers({ bad: { type: "http", url: server.url.href, timeout: 500 } }, {});
		expect(result.connectedServers).toEqual([]);
		expect(result.errors.get("bad")).toContain("boom");
		expect(manager.getConnection("bad")).toBeUndefined();
		expect(manager.getConnectionStatus("bad")).toBe("disconnected");
		await waitFor(() => deleteCount > 0, 1_000);
	});

	test("disconnectServer during reconnect backoff prevents late reconnect and new child spawn", async () => {
		const pidFile = tmpPath("backoff-pids");
		const serverScript = `
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "backoff", version: "1" } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ok", inputSchema: { type: "object" } }] } }) + "\\n", () => process.exit(0));
  }
});
`;
		const manager = new MCPManager(process.cwd());
		managers.push(manager);
		const result = await manager.connectServers(
			{ backoff: { type: "stdio", command: process.execPath, args: ["-e", serverScript], timeout: 750 } },
			{},
		);
		expect(result.errors.size).toBe(0);
		await waitFor(() => manager.getConnectionStatus("backoff") === "connecting", 1_000);
		await manager.disconnectServer("backoff");
		const pidsAtDisconnect = await readPidList(pidFile);
		await Bun.sleep(750);
		expect(await readPidList(pidFile)).toEqual(pidsAtDisconnect);
		expect(manager.getConnectionStatus("backoff")).toBe("disconnected");
	});
});

mkdirSync("artifacts", { recursive: true });
