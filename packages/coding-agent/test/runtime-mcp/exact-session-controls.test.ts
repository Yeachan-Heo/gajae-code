import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mcpClient from "../../src/runtime-mcp/client";
import { MCPManager } from "../../src/runtime-mcp/manager";
import { legacyEraObservation } from "../../src/runtime-mcp/protocol";
import { attachExactMcpControls, getExactMcpControls, revokeExactMcpControls } from "../../src/runtime-mcp/redaction";
import { DeferredMCPTool, MCPTool } from "../../src/runtime-mcp/tool-bridge";
import type { MCPServerConnection, MCPToolCallResult, MCPTransport } from "../../src/runtime-mcp/types";
import type { AgentSession } from "../../src/session/agent-session";

const managers: MCPManager[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.disconnectAll();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function connection(name: string, calls: string[]): MCPServerConnection {
	let connected = true;
	const transport: MCPTransport = {
		get connected() {
			return connected;
		},
		request: (async method => {
			calls.push(method);
			return { content: [{ type: "text", text: "ok" }] } satisfies MCPToolCallResult;
		}) as MCPTransport["request"],
		async notify() {},
		async close() {
			connected = false;
		},
	};
	return {
		name,
		config: { type: "http", url: "http://127.0.0.1:1" },
		transport,
		serverInfo: { name, version: "1" },
		capabilities: { tools: {} },
		protocol: legacyEraObservation({
			preference: "auto",
			effectiveVersion: "2025-03-26",
			negotiation: "legacy-fallback",
			downgradeReason: "legacy-server-signal",
			serverInfo: { name, version: "1" },
			capabilities: { tools: true },
		}),
	};
}

describe("exact-config MCP session controls", () => {
	test("capability attachment is revocable and session-identity scoped", () => {
		const first = {} as AgentSession;
		const second = {} as AgentSession;
		attachExactMcpControls(first, {
			grantSource: "root-interactive-exact-config",
			configPath: "/tmp/first-mcp.json",
		});

		expect(getExactMcpControls(first)?.configPath).toBe("/tmp/first-mcp.json");
		expect(getExactMcpControls(second)).toBeUndefined();
		revokeExactMcpControls(first);
		expect(getExactMcpControls(first)).toBeUndefined();
	});

	test("suspend blocks stale wrappers locally and resume republishes working tools", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-exact-mcp-control-"));
		roots.push(root);
		const configPath = join(root, "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({ mcpServers: { exact: { type: "http", url: "http://127.0.0.1:1" } } }),
		);
		const calls: string[] = [];
		const live = connection("exact", calls);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(live);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "lookup", inputSchema: { type: "object" } }]);
		const manager = new MCPManager(root, null, { toolsOnly: true });
		managers.push(manager);
		await manager.discoverAndConnect({ configPath });
		const staleTool = manager.getTools()[0];
		expect(staleTool).toBeDefined();

		const suspension = await manager.prepareExactServerControl("suspend", "exact");
		expect(suspension.result.status).toBe("suspended");
		expect(suspension.tools).toHaveLength(0);
		await suspension.commit();
		expect(manager.isExactServerSuppressed("exact")).toBe(true);

		const staleResult = await staleTool!.execute("stale", {}, () => {}, {} as never);
		expect(staleResult.details?.isError).toBe(true);
		expect(calls).toEqual([]);

		const resumption = await manager.prepareExactServerControl("resume", "exact");
		expect(resumption.result.status).toBe("resumed");
		expect(resumption.tools).toHaveLength(1);
		await resumption.commit();
		expect(manager.isExactServerSuppressed("exact")).toBe(false);

		const freshTool = manager.getTools()[0];
		const freshResult = await freshTool!.execute("fresh", {}, () => {}, {} as never);
		expect(freshResult.details?.isError).toBeFalsy();
		expect(calls).toEqual(["tools/call"]);
	});

	test("an invalidated MCP tool does not replay after reconnect", async () => {
		const firstCallStarted = Promise.withResolvers<void>();
		const failFirstCall = Promise.withResolvers<void>();
		const reconnectStarted = Promise.withResolvers<void>();
		const finishReconnect = Promise.withResolvers<void>();
		const first = connection("exact", []);
		first.transport.request = (async () => {
			firstCallStarted.resolve();
			await failFirstCall.promise;
			throw new Error("ECONNRESET");
		}) as MCPTransport["request"];
		const replacementCalls: string[] = [];
		const replacement = connection("exact", replacementCalls);
		const tool = new MCPTool(first, { name: "lookup", inputSchema: { type: "object" } }, async () => {
			reconnectStarted.resolve();
			await finishReconnect.promise;
			return replacement;
		});

		const execution = tool.execute("race", {}, () => {}, {} as never);
		await firstCallStarted.promise;
		failFirstCall.resolve();
		await reconnectStarted.promise;
		tool.invalidateForSessionControl();
		finishReconnect.resolve();

		const result = await execution;
		expect(result.details?.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "MCP error: MCP server is suspended for this session" }]);
		expect(replacementCalls).toEqual([]);
	});

	test("an invalidated deferred MCP tool does not replay after reconnect", async () => {
		const firstCallStarted = Promise.withResolvers<void>();
		const failFirstCall = Promise.withResolvers<void>();
		const reconnectStarted = Promise.withResolvers<void>();
		const finishReconnect = Promise.withResolvers<void>();
		const first = connection("exact", []);
		first.transport.request = (async () => {
			firstCallStarted.resolve();
			await failFirstCall.promise;
			throw new Error("ECONNRESET");
		}) as MCPTransport["request"];
		const replacementCalls: string[] = [];
		const replacement = connection("exact", replacementCalls);
		const tool = new DeferredMCPTool(
			"exact",
			{ name: "lookup", inputSchema: { type: "object" } },
			async () => first,
			undefined,
			async () => {
				reconnectStarted.resolve();
				await finishReconnect.promise;
				return replacement;
			},
		);

		const execution = tool.execute("race", {}, () => {}, {} as never);
		await firstCallStarted.promise;
		failFirstCall.resolve();
		await reconnectStarted.promise;
		tool.invalidateForSessionControl();
		finishReconnect.resolve();

		const result = await execution;
		expect(result.details?.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "MCP error: MCP server is suspended for this session" }]);
		expect(replacementCalls).toEqual([]);
	});

	test("an unavailable reconnect preserves the published predecessor", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-exact-mcp-reconnect-"));
		roots.push(root);
		const configPath = join(root, "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({ mcpServers: { exact: { type: "http", url: "http://127.0.0.1:1" } } }),
		);
		const live = connection("exact", []);
		const connect = vi.spyOn(mcpClient, "connectToServer").mockResolvedValueOnce(live);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "lookup", inputSchema: { type: "object" } }]);
		const manager = new MCPManager(root, null, { toolsOnly: true });
		managers.push(manager);
		await manager.discoverAndConnect({ configPath });
		expect(manager.getTools()).toHaveLength(1);
		connect.mockRejectedValueOnce(new Error("replacement refused"));

		const reconnect = await manager.prepareExactServerControl("reconnect", "exact");
		expect(reconnect.result.status).toBe("unavailable");
		await reconnect.abort();
		expect(manager.getConnectionStatus("exact")).toBe("connected");
		expect(manager.getTools()).toHaveLength(1);
		expect(live.transport.connected).toBe(true);
	});
});
