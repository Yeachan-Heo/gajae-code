import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MCPManager } from "../../../runtime-mcp/manager";
import type { MCPServerConnection } from "../../../runtime-mcp/types";
import type { HandlerContext } from "../../suites/handlers";
import {
	mcpHandlers,
	mcpServerReloadHandler,
	mcpServerResourceReadHandler,
	mcpServerStatusListHandler,
	mcpServerToolCallHandler,
	projectWireJson,
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

function wireManager(connection: MCPServerConnection): MCPManager {
	return {
		getAllServerNames: () => [connection.name],
		getConnection: (name: string) => (name === connection.name ? connection : undefined),
	} as unknown as MCPManager;
}

function wireConnection(inputSchema: unknown): MCPServerConnection {
	const transport: MCPServerConnection["transport"] = {
		connected: true,
		request: async <T = unknown>() => ({}) as T,
		notify: async () => {},
		close: async () => {},
	};
	return {
		name: "fixture",
		config: { type: "stdio", command: "fixture" },
		transport,
		serverInfo: { name: "fixture", version: "1" },
		capabilities: { tools: {} },
		tools: [{ name: "echo", inputSchema: inputSchema as { type: "object" } }],
	};
}

test("MCP wire projection rejects unsupported values instead of silently pruning them", () => {
	class CustomPayload {
		value = 1;
		toJSON() {
			return { value: 2 };
		}
	}
	const accessor: Record<string, unknown> = {};
	Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
	const hidden: Record<string, unknown> = {};
	Object.defineProperty(hidden, "value", { value: 1 });
	const symbolProperty: Record<string, unknown> = {};
	Object.defineProperty(symbolProperty, Symbol("extra"), { enumerable: true, value: 1 });
	const cyclicArray: unknown[] = [];
	cyclicArray.push(cyclicArray);
	const cyclicObject: Record<string, unknown> = {};
	cyclicObject.self = cyclicObject;
	const sparseArray: unknown[] = [];
	sparseArray.length = 1;
	const cases: Array<[string, unknown]> = [
		["Date", new Date(0)],
		["Map", new Map([["value", 1]])],
		["class instance", new CustomPayload()],
		["accessor", accessor],
		["hidden property", hidden],
		["undefined", { value: undefined }],
		["infinity", { value: Number.POSITIVE_INFINITY }],
		["NaN", { value: Number.NaN }],
		["function", { value: () => 1 }],
		["symbol", { value: Symbol("value") }],
		["enumerable symbol property", symbolProperty],
		["cyclic array", cyclicArray],
		["cyclic object", cyclicObject],
		["sparse array", sparseArray],
	];
	for (const [label, value] of cases) expect(() => projectWireJson(value), label).toThrow();
});

test("MCP wire projection round-trips a deeply nested JSON schema", () => {
	const schema = {
		type: "object",
		properties: {
			settings: {
				type: "object",
				properties: {
					name: { type: "string" },
					flags: { type: "array", items: { type: "boolean" } },
					metadata: {
						type: "object",
						properties: { count: { type: "integer" }, enabled: { type: "boolean" } },
						required: ["count"],
					},
				},
				required: ["name"],
			},
			values: { type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } },
		},
		required: ["settings"],
	};
	Object.defineProperty(schema, Symbol("normalization-stamp"), { value: true });
	expect(projectWireJson(schema)).toEqual(schema);
});

test("MCP status returns internalError when cached MCP data violates the JSON-only invariant", async () => {
	const result = await mcpServerStatusListHandler(
		{ detail: "toolsAndAuthOnly" },
		{ mcpManager: wireManager(wireConnection(new Date(0))) },
	);
	expect(result).toEqual({ ok: false, errorKey: "internalError" });
});

test("MCP-001 status lists a real connected server and inventory", async () => {
	const value = await connected();
	const result = await mcpServerStatusListHandler({ detail: "full" }, { mcpManager: value.manager });
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
	const value = await connected();
	const context = { mcpManager: value.manager };
	const result = await mcpServerToolCallHandler(
		{
			threadId: "thread",
			server: "fixture",
			tool: "echo",
			arguments: { text: "hello" },
		},
		context,
	);
	expect(result).toEqual({ ok: true, result: { content: [{ type: "text", text: "hello" }] } });
	expect(await mcpServerToolCallHandler({ threadId: "thread", server: "fixture", tool: "missing" }, context)).toEqual({
		ok: false,
		errorKey: "notFound",
	});
});

test("MCP-003 resource read returns real MCP contents and missing servers are notFound", async () => {
	const value = await connected();
	const context = { mcpManager: value.manager };
	const result = await mcpServerResourceReadHandler({ server: "fixture", uri: "fixture://hello" }, context);
	expect(result).toEqual({
		ok: true,
		result: { contents: [{ uri: "fixture://hello", mimeType: "text/plain", text: "real resource" }] },
	});
	expect(await mcpServerResourceReadHandler({ server: "missing", uri: "fixture://hello" }, context)).toEqual({
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
