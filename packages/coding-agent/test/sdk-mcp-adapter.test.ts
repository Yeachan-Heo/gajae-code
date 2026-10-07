import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { VERSION } from "@gajae-code/utils";
import { Broker } from "../src/sdk/broker/broker";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { SessionLifecycleService } from "../src/sdk/lifecycle";
import { createSdkMcpServer } from "../src/sdk/mcp";
import { OPERATIONS } from "../src/sdk/protocol/operation-registry";
import type { SessionRouter } from "../src/sdk/router";

const dirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop(true);
	for (const dir of dirs.splice(0)) {
		await brokerOwnerForTest(path.join(dir, "agent"))?.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

async function fixture() {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-mcp-"));
	dirs.push(repo);
	const agentDir = path.join(repo, "agent");
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
				if (frame.type === "event_replay") {
					socket.send(
						JSON.stringify({
							type: "event_replay_result",
							id: frame.id,
							ok: true,
							generation: typeof frame.sinceGeneration === "number" ? frame.sinceGeneration : 1,
							lastSeq: 0,
							events: [],
						}),
					);
					return;
				}
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
	const stateRoot = path.join(repo, ".gjc", "state");
	const sdkDir = path.join(stateRoot, "sdk");
	fs.mkdirSync(sdkDir, { recursive: true });
	const endpointPath = path.join(sdkDir, `${sessionId}.json`);
	fs.writeFileSync(
		endpointPath,
		JSON.stringify({ sessionId, pid: process.pid, url: `ws://127.0.0.1:${server.port}`, token }),
	);
	const broker = new Broker({ agentDir, packageGeneration: "test" });
	await broker.start();
	await broker.index.append({
		type: "host_registered",
		sessionId,
		locator: { cwd: repo, worktreeRoot: null, stateRoot },
		endpointGeneration: 1,
		pid: process.pid,
		endpointMtimeMs: fs.statSync(endpointPath).mtimeMs,
	});
	await broker.heartbeatSessions();
	return { repo, agentDir, sessionId, endpointPath, sent: () => sends };
}

test("SDK MCP initialize negotiates supported versions and reports server version", async () => {
	const mcp = createSdkMcpServer({ agentDir: process.cwd() });
	const cases = [
		{ protocolVersion: "2025-06-18", expected: "2025-06-18" },
		{ protocolVersion: "unsupported", expected: "2025-06-18" },
		{ protocolVersion: undefined, expected: "2025-06-18" },
	] as const;

	for (const input of cases) {
		const response = await mcp.handleJsonRpc({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			...(input.protocolVersion === undefined ? {} : { params: { protocolVersion: input.protocolVersion } }),
		});
		const result = response.result as {
			protocolVersion: string;
			serverInfo: { version: string };
		};
		expect(result.protocolVersion).toBe(input.expected);
		expect(result.serverInfo.version).toBe(VERSION);
		expect(result.serverInfo.version.length).toBeGreaterThan(0);
	}
});

function sessionListRouter(
	responses: Array<Record<string, unknown>>,
	requests: Array<Record<string, unknown>>,
): SessionRouter {
	return {
		async start(): Promise<void> {},
		async stop(): Promise<void> {},
		async listBrokerSessions(input: Record<string, unknown>): Promise<Record<string, unknown>> {
			requests.push(input);
			const response = responses.shift();
			if (!response) throw new Error("Unexpected session.list request.");
			return response;
		},
	} as unknown as SessionRouter;
}

test("MCP SDK schemas exclude endpoint credentials and reject G02 before any WebSocket send", async () => {
	const { agentDir, sessionId, sent } = await fixture();
	const mcp = createSdkMcpServer({ agentDir });
	expect(JSON.stringify(mcp.tools)).not.toContain("get_endpoint");
	await expect(mcp.callTool("gjc_session_control", { sessionId, operation: "session.get_endpoint" })).resolves.toEqual(
		{ ok: false, error: expect.objectContaining({ code: "unknown_operation" }) },
	);
	await expect(mcp.callTool("gjc_session_global", { operation: "session.get_endpoint" })).resolves.toEqual({
		ok: false,
		error: expect.objectContaining({ code: "endpoint_credential_forbidden" }),
	});
	expect(sent()).toBe(0);
	await mcp.close();
});

test("MCP lifecycle responses never expose broker endpoint credentials", async () => {
	const { repo, agentDir } = await fixture();
	const lifecycleService = new SessionLifecycleService({
		global: async () => ({
			ok: true,
			result: {
				sessionId: "created-session",
				endpoint: { url: "ws://session.example.test?token=url-secret", token: "session-secret" },
				token: "result-secret",
			},
		}),
	});
	const mcp = createSdkMcpServer({ agentDir, lifecycleService });
	const result = await mcp.callTool("gjc_session_global", {
		operation: "session.create",
		input: { cwd: repo },
		idempotencyKey: "create-1",
	});
	expect(result).toEqual({ ok: true, operation: "session.create", result: { sessionId: "created-session" } });
	expect(JSON.stringify(result)).not.toContain("secret");
	await mcp.close();
});

test("MCP forwards the lifecycle startup budget to the lifecycle service", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-mcp-startup-budget-"));
	dirs.push(repo);
	const agentDir = path.join(repo, "agent");
	let forwardedTimeoutMs: number | undefined;
	const lifecycleService = new SessionLifecycleService({
		global: async (_operation, _input, options) => {
			forwardedTimeoutMs = options.timeoutMs;
			return { ok: true, result: { sessionId: "created-session" } };
		},
	});
	const mcp = createSdkMcpServer({ agentDir, lifecycleService });
	const result = await mcp.callTool("gjc_session_global", {
		operation: "session.create",
		input: { cwd: repo, readinessTimeoutMs: 4_000 },
		idempotencyKey: "forward-startup-budget",
	});
	expect(result).toEqual({ ok: true, operation: "session.create", result: { sessionId: "created-session" } });
	expect(forwardedTimeoutMs).toBe(9_000);
	await mcp.close();
});

test("MCP forwards the bounded idempotency key on control envelopes", async () => {
	// Terminal abort requires the key on the control frame: the control
	// tool must expose it AND forward it, or every {mode:"terminal"} control
	// through this surface is rejected with invalid_input (review thread P1).
	const { agentDir, sessionId } = await fixture();
	const mcp = createSdkMcpServer({ agentDir });
	try {
		const control = mcp.tools.find(tool => tool.name === "gjc_session_control")!;
		expect(control.inputSchema).toMatchObject({ properties: { idempotencyKey: { type: "string" } } });
		const result = await mcp.callTool("gjc_session_control", {
			sessionId,
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "term-key-mcp",
		});
		expect(result).toMatchObject({ ok: true });
		expect((result as { echoed?: Record<string, unknown> }).echoed).toMatchObject({
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "term-key-mcp",
		});
	} finally {
		await mcp.close();
	}
});

test("MCP global schema exposes and requires caller lifecycle idempotency keys", async () => {
	const { repo, agentDir } = await fixture();
	const mcp = createSdkMcpServer({ agentDir });
	const global = mcp.tools.find(tool => tool.name === "gjc_session_global")!;
	expect(global.inputSchema).toMatchObject({ properties: { idempotencyKey: { type: "string" } } });
	await expect(
		mcp.callTool("gjc_session_global", { operation: "session.create", input: { cwd: repo } }),
	).resolves.toMatchObject({
		ok: false,
		error: { code: "invalid_input" },
	});
	await mcp.close();
});

test("MCP rejects unknown operation names before Router startup or connection", async () => {
	const { agentDir, sessionId } = await fixture();
	const mcp = createSdkMcpServer({ agentDir });
	for (const [tool, args] of [
		["gjc_session_control", { sessionId, operation: "not.real" }],
		["gjc_session_query", { sessionId, query: "not.real" }],
		["gjc_session_global", { operation: "not.real" }],
	] as const)
		expect(await mcp.callTool(tool, args)).toMatchObject({ ok: false, error: { code: "unknown_operation" } });
	await mcp.close();
});

test("MCP fails closed on corrupt endpoint records without exposing discovery details", async () => {
	const { agentDir, sessionId, endpointPath } = await fixture();
	fs.writeFileSync(endpointPath, "not-json");
	const mcp = createSdkMcpServer({ agentDir });
	const result = await mcp.callTool("gjc_session_query", { sessionId, query: "session.metadata" });
	expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
	await mcp.close();
});

test("MCP fails closed on unreadable endpoint records without exposing discovery details", async () => {
	if (process.platform === "win32") return;
	const { agentDir, sessionId, endpointPath } = await fixture();
	fs.chmodSync(endpointPath, 0o000);
	try {
		const mcp = createSdkMcpServer({ agentDir });
		const result = await mcp.callTool("gjc_session_query", { sessionId, query: "session.metadata" });
		expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
		await mcp.close();
	} finally {
		fs.chmodSync(endpointPath, 0o600);
	}
});

test("MCP rejects every registry-prohibited operation without sending a frame or exposing secret input", async () => {
	const { agentDir, sessionId, sent } = await fixture();
	const mcp = createSdkMcpServer({ agentDir });
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
	await mcp.close();
});

test("MCP rejects secret-bearing config patches before Router startup", async () => {
	const { agentDir, sessionId, sent } = await fixture();
	const mcp = createSdkMcpServer({ agentDir });
	const result = await mcp.callTool("gjc_session_control", {
		sessionId,
		operation: "config.patch",
		input: { patch: { apiKey: "mcp-secret" } },
	});
	expect(result).toMatchObject({ ok: false, error: { code: "secret_field_forbidden" } });
	expect(JSON.stringify(result)).not.toContain("mcp-secret");
	expect(sent()).toBe(0);
	await mcp.close();
});

test("MCP SDK control/query tools use Router-owned live attachments and unknown sessions are typed", async () => {
	const { agentDir, sessionId } = await fixture();
	const mcp = createSdkMcpServer({ agentDir });
	await expect(
		mcp.callTool("gjc_session_control", { sessionId, operation: "turn.prompt", input: { text: "hello" } }),
	).resolves.toMatchObject({ ok: true, echoed: { operation: "turn.prompt" } });
	await expect(
		mcp.callTool("gjc_session_query", { sessionId, query: "session.metadata", cursor: "next" }),
	).resolves.toMatchObject({ ok: true, echoed: { query: "session.metadata", cursor: "next" } });
	await expect(
		mcp.callTool("gjc_session_query", { sessionId: "missing", query: "session.metadata" }),
	).resolves.toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
	await mcp.close();
});

test("MCP rejects repeated session.list cursors without returning partial sessions", async () => {
	const { agentDir } = await fixture();
	const requests: Array<Record<string, unknown>> = [];
	const mcp = createSdkMcpServer({
		agentDir,
		router: sessionListRouter(
			[
				{ ok: true, result: { sessions: [{ sessionId: "first" }], continuationCursor: "repeat" } },
				{ ok: true, result: { sessions: [{ sessionId: "second" }], continuationCursor: "repeat" } },
			],
			requests,
		),
	});
	try {
		const result = await mcp.callTool("gjc_session_list");
		expect(result).toEqual({
			ok: false,
			error: { code: "protocol_error", message: "session.list returned a repeated continuation cursor." },
		});
		expect(requests).toEqual([{}, { cursor: "repeat" }]);
	} finally {
		await mcp.close();
	}
});

test("MCP rejects malformed session.list continuation pages without returning partial sessions", async () => {
	const { agentDir } = await fixture();
	const requests: Array<Record<string, unknown>> = [];
	const mcp = createSdkMcpServer({
		agentDir,
		router: sessionListRouter(
			[
				{ ok: true, result: { sessions: [{ sessionId: "first" }], continuationCursor: "page-2" } },
				{ ok: true, result: { sessions: "not-an-array" } },
			],
			requests,
		),
	});
	try {
		const result = await mcp.callTool("gjc_session_list");
		expect(result).toEqual({
			ok: false,
			error: { code: "protocol_error", message: "session.list returned a malformed page." },
		});
		expect(requests).toEqual([{}, { cursor: "page-2" }]);
	} finally {
		await mcp.close();
	}
});
