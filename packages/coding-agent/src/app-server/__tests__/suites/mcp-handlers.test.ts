import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MCPManager } from "../../../runtime-mcp/manager";
import type { MCPServerConnection } from "../../../runtime-mcp/types";
import type { HandlerContext } from "../../suites/handlers";
import {
	mcpHandlers,
	mcpServerOauthLoginHandler,
	mcpServerReloadHandler,
	mcpServerResourceReadHandler,
	mcpServerStatusListHandler,
	mcpServerToolCallHandler,
} from "../../suites/mcp-handlers";

const dirs: string[] = [];
const managers: MCPManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) {
		await manager.disconnectAll();
		if (MCPManager.instance() === manager) MCPManager.resetForTests();
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join("/tmp", "gjc-mcp-suite-"));
	dirs.push(dir);
	const server = join(dir, "server.mjs");
	writeFileSync(
		server,
		`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const req = JSON.parse(line); if (req.id === undefined) continue;
  let result;
  if (req.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } };
  else if (req.method === "tools/list") result = { tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
  else if (req.method === "tools/call") result = { content: [{ type: "text", text: String(req.params.arguments.text) }] };
  else if (req.method === "resources/list") result = { resources: [{ uri: "fixture://hello", name: "hello", mimeType: "text/plain" }] };
  else if (req.method === "resources/templates/list") result = { resourceTemplates: [] };
  else if (req.method === "resources/read") result = { contents: [{ uri: req.params.uri, mimeType: "text/plain", text: "real resource" }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
}
`,
	);
	const manager = new MCPManager(dir);
	managers.push(manager);
	MCPManager.setInstance(manager);
	return { dir, server, manager };
}

async function connected() {
	const value = fixture();
	await value.manager.connectServers(
		{ fixture: { type: "stdio", command: process.execPath, args: [value.server] } },
		{},
	);
	return value;
}

test("MCP-001 status lists a real connected server and inventory", async () => {
	await connected();
	const result = await mcpServerStatusListHandler({ detail: "full" });
	expect(result.ok).toBe(true);
	if (!result.ok) return;

	expect(result.result).toMatchObject({
		data: [
			{
				name: "fixture",
				serverInfo: { name: "fixture" },
				tools: { echo: { name: "echo" } },
				resources: [{ uri: "fixture://hello" }],
			},
		],
	});
});

test("MCP-002 tool call returns real MCP content and unknown tools are notFound", async () => {
	await connected();
	const result = await mcpServerToolCallHandler({
		threadId: "thread",
		server: "fixture",
		tool: "echo",
		arguments: { text: "hello" },
	});
	expect(result).toEqual({ ok: true, result: { content: [{ type: "text", text: "hello" }] } });
	expect(await mcpServerToolCallHandler({ threadId: "thread", server: "fixture", tool: "missing" })).toEqual({
		ok: false,
		errorKey: "notFound",
	});
});

test("MCP-003 resource read returns real MCP contents and missing servers are notFound", async () => {
	await connected();
	const result = await mcpServerResourceReadHandler({ server: "fixture", uri: "fixture://hello" });
	expect(result).toEqual({
		ok: true,
		result: { contents: [{ uri: "fixture://hello", mimeType: "text/plain", text: "real resource" }] },
	});
	expect(await mcpServerResourceReadHandler({ server: "missing", uri: "fixture://hello" })).toEqual({
		ok: false,
		errorKey: "notFound",
	});
});

test("MCP-004 malformed pinned params are rejected and all genuinely backed methods are registered", async () => {
	expect(await mcpServerToolCallHandler({ server: "fixture", tool: "echo" })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(await mcpServerResourceReadHandler({ server: "fixture" })).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(Object.keys(mcpHandlers).sort()).toEqual([
		"config/mcpServer/reload",
		"mcpServer/oauth/login",
		"mcpServer/resource/read",
		"mcpServer/tool/call",
		"mcpServerStatus/list",
	]);
	expect(await mcpServerStatusListHandler({ detail: "invalid" })).toEqual({ ok: false, errorKey: "invalidParams" });
});

test("MCP-005 config/mcpServer/reload uses the live disconnect, rediscover, reconnect, and tool refresh seam", async () => {
	const value = await connected();
	const connect = value.manager.connectServers.bind(value.manager);
	let discoveries = 0;
	value.manager.discoverAndConnect = async () => {
		discoveries += 1;
		return connect({ fixture: { type: "stdio", command: process.execPath, args: [value.server] } }, {});
	};
	const snapshots: number[] = [];
	const result = await mcpServerReloadHandler({}, {
		mcpManager: value.manager,
		refreshMcpTools: async tools => {
			snapshots.push(tools.length);
		},
	} as HandlerContext & {
		mcpManager: MCPManager;
		refreshMcpTools: (tools: ReturnType<MCPManager["getTools"]>) => Promise<void>;
	});
	expect(result).toEqual({ ok: true, result: {} });
	expect(discoveries).toBe(1);
	expect(value.manager.getConnection("fixture")).toBeDefined();
	expect(snapshots).toEqual([1]);
});

test("MCP-006 config/mcpServer/reload reports an honest failure for sealed MCP connections", async () => {
	const value = await connected();
	value.manager.sealConnectionSet();
	expect(await mcpServerReloadHandler({}, { mcpManager: value.manager } as HandlerContext)).toEqual({
		ok: false,
		errorKey: "internalError",
	});
});

test("MCP-007 mcpServer/oauth/login returns the real authorization URL and reports completion persistence failure", async () => {
	const dir = mkdtempSync(join("/tmp", "gjc-mcp-oauth-suite-"));
	dirs.push(dir);
	const mcp = new MCPManager(dir);
	managers.push(mcp);
	const connection = {
		name: "oauth-fixture",
		config: {
			type: "http",
			url: "https://provider.example/mcp",
			oauth: {
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				callbackPort: 0,
			},
		},
	} as unknown as MCPServerConnection;
	(mcp as unknown as { getConnection: (name: string) => MCPServerConnection | undefined }).getConnection = name =>
		name === "oauth-fixture" ? connection : undefined;
	const notifications: unknown[] = [];
	const result = await mcpServerOauthLoginHandler({ name: "oauth-fixture", timeoutSecs: 1 }, {
		mcpManager: mcp,
		connectionId: "oauth-test",
		emitTo: (_connectionId, _method, params) => notifications.push(params),
	} as HandlerContext & { mcpManager: MCPManager });
	expect(result.ok).toBe(true);
	if (result.ok)
		expect((result.result as { authorizationUrl: string }).authorizationUrl).toContain("provider.example/authorize");
	await Bun.sleep(1_100);
	expect(notifications).toContainEqual(expect.objectContaining({ name: "oauth-fixture", success: false }));
});

test("MCP-008 mcpServer/oauth/login rejects an unknown server without claiming OAuth support", async () => {
	MCPManager.resetForTests();
	expect(await mcpServerOauthLoginHandler({ name: "missing" })).toEqual({ ok: false, errorKey: "notFound" });
});
