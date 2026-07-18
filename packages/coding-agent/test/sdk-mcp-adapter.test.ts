import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { brokerProcessIncarnation } from "../src/sdk/broker/discovery";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { createSdkMcpServer } from "../src/sdk/mcp";
import { OPERATIONS } from "../src/sdk/protocol/operation-registry";

const dirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop(true);
	for (const dir of dirs.splice(0)) {
		await brokerOwnerForTest(path.join(dir, "agent"))?.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function fixture() {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-mcp-"));
	dirs.push(repo);
	const token = "sdk-mcp-test-token";
	let sends = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "mcp-test-conn" }));
			},
			message(socket, raw) {
				sends++;
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				socket.send(
					JSON.stringify({
						type: frame.type === "query_request" ? "query_response" : "control_response",
						id: frame.id,
						ok: true,
						echoed: frame,
					}),
				);
			},
		},
	});
	servers.push(server);
	const sessionId = "live-session";
	const dir = path.join(repo, ".gjc", "state", "sdk");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${sessionId}.json`),
		JSON.stringify({ url: `ws://127.0.0.1:${server.port}`, token }),
	);
	return { repo, sessionId, sent: () => sends };
}

test("MCP SDK schemas exclude endpoint credentials and reject G02 before any WebSocket send", async () => {
	const { repo, sessionId, sent } = fixture();
	const mcp = createSdkMcpServer({ repo });
	expect(JSON.stringify(mcp.tools)).not.toContain("get_endpoint");
	await expect(mcp.callTool("gjc_session_control", { sessionId, operation: "session.get_endpoint" })).resolves.toEqual(
		{ ok: false, error: expect.objectContaining({ code: "unknown_operation" }) },
	);
	await expect(mcp.callTool("gjc_session_global", { operation: "session.get_endpoint" })).resolves.toEqual({
		ok: false,
		error: expect.objectContaining({ code: "endpoint_credential_forbidden" }),
	});
	expect(sent()).toBe(0);
});

test("MCP lifecycle responses never expose broker endpoint credentials", async () => {
	const { repo } = fixture();
	const agentDir = path.join(repo, "agent");
	const brokerDir = path.join(agentDir, "sdk");
	fs.mkdirSync(brokerDir, { recursive: true });
	const incarnation = brokerProcessIncarnation(process.pid);
	if (!incarnation) throw new Error(`Current process incarnation is unavailable for pid ${process.pid}.`);
	fs.writeFileSync(
		path.join(brokerDir, "broker.json"),
		JSON.stringify({
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "mcp-owner",
			pid: process.pid,
			incarnation,
			host: "127.0.0.1",
			port: 1,
			url: "ws://broker.example.test",
			token: "broker-discovery-secret",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		}),
	);
	const mcp = createSdkMcpServer({
		repo,
		agentDir,
		connect: async () =>
			({
				global: async () => ({
					ok: true,
					result: {
						sessionId: "created-session",
						endpoint: { url: "ws://session.example.test?token=url-secret", token: "session-secret" },
						token: "result-secret",
					},
				}),
				close: async () => {},
			}) as never,
	});
	const result = await mcp.callTool("gjc_session_global", {
		operation: "session.create",
		input: { cwd: repo },
		idempotencyKey: "create-1",
	});
	expect(result).toEqual({ ok: true, result: { sessionId: "created-session" } });
	expect(JSON.stringify(result)).not.toContain("secret");
});

test("MCP global schema exposes and requires caller lifecycle idempotency keys", async () => {
	const { repo } = fixture();
	const mcp = createSdkMcpServer({ repo });
	const global = mcp.tools.find(tool => tool.name === "gjc_session_global")!;
	expect(global.inputSchema).toMatchObject({ properties: { idempotencyKey: { type: "string" } } });
	await expect(
		mcp.callTool("gjc_session_global", { operation: "session.create", input: { cwd: repo } }),
	).resolves.toMatchObject({
		ok: false,
		error: { code: "invalid_input" },
	});
});

test("MCP rejects unknown operation names before discovery or connection", async () => {
	const { repo, sessionId } = fixture();
	let connects = 0;
	const mcp = createSdkMcpServer({
		repo,
		connect: async () => {
			connects++;
			throw new Error("must not connect");
		},
	});
	for (const [tool, args] of [
		["gjc_session_control", { sessionId, operation: "not.real" }],
		["gjc_session_query", { sessionId, query: "not.real" }],
		["gjc_session_global", { operation: "not.real" }],
	] as const)
		expect(await mcp.callTool(tool, args)).toMatchObject({ ok: false, error: { code: "unknown_operation" } });
	expect(connects).toBe(0);
});

test("MCP preserves corrupt endpoint discovery errors with a relative path", async () => {
	const { repo, sessionId } = fixture();
	const endpoint = path.join(repo, ".gjc", "state", "sdk", `${sessionId}.json`);
	fs.writeFileSync(endpoint, "not-json");
	const result = await createSdkMcpServer({ repo }).callTool("gjc_session_query", {
		sessionId,
		query: "session.metadata",
	});
	expect(result).toMatchObject({ ok: false, error: { code: "discovery_error", path: `${sessionId}.json` } });
});

test("MCP preserves unreadable endpoint discovery errors", async () => {
	if (process.platform === "win32") return;
	const { repo, sessionId } = fixture();
	const endpoint = path.join(repo, ".gjc", "state", "sdk", `${sessionId}.json`);
	fs.chmodSync(endpoint, 0o000);
	try {
		const result = await createSdkMcpServer({ repo }).callTool("gjc_session_query", {
			sessionId,
			query: "session.metadata",
		});
		expect(result).toMatchObject({ ok: false, error: { code: "discovery_error", path: `${sessionId}.json` } });
	} finally {
		fs.chmodSync(endpoint, 0o600);
	}
});

test("MCP rejects every registry-prohibited operation without sending a frame or exposing secret input", async () => {
	const { repo, sessionId, sent } = fixture();
	const mcp = createSdkMcpServer({ repo });
	const blocked = OPERATIONS.filter(
		operation =>
			(operation.kind === "control" || operation.kind === "global") &&
			(operation.adapterDispositions.mcp === "prohibited" || operation.adapterDispositions.mcp === "machine_only"),
	);
	for (const operation of blocked) {
		const tool = operation.kind === "global" ? "gjc_session_global" : "gjc_session_control";
		const args =
			operation.kind === "global"
				? { operation: operation.sdkId, input: { token: "mcp-secret" } }
				: { sessionId, operation: operation.sdkId, input: { token: "mcp-secret" } };
		const result = await mcp.callTool(tool, args);
		expect(result).toMatchObject({ ok: false, error: expect.any(Object) });
		expect(JSON.stringify(result)).not.toContain("mcp-secret");
	}
	expect(sent()).toBe(0);
});

test("MCP rejects secret-bearing config patches before endpoint discovery", async () => {
	const { repo, sessionId, sent } = fixture();
	const result = await createSdkMcpServer({ repo }).callTool("gjc_session_control", {
		sessionId,
		operation: "config.patch",
		input: { patch: { apiKey: "mcp-secret" } },
	});
	expect(result).toMatchObject({ ok: false, error: { code: "secret_field_forbidden" } });
	expect(JSON.stringify(result)).not.toContain("mcp-secret");
	expect(sent()).toBe(0);
});

test("MCP SDK control/query tools use discovered live session endpoints and unknown sessions are typed", async () => {
	const { repo, sessionId } = fixture();
	const mcp = createSdkMcpServer({ repo });
	await expect(
		mcp.callTool("gjc_session_control", { sessionId, operation: "turn.prompt", input: { text: "hello" } }),
	).resolves.toMatchObject({ ok: true, echoed: { operation: "turn.prompt" } });
	await expect(
		mcp.callTool("gjc_session_query", { sessionId, query: "session.metadata", cursor: "next" }),
	).resolves.toMatchObject({ ok: true, echoed: { query: "session.metadata", cursor: "next" } });
	await expect(
		mcp.callTool("gjc_session_query", { sessionId: "missing", query: "session.metadata" }),
	).resolves.toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
});
