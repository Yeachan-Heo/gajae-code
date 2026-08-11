import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { brokerProcessIncarnation } from "../src/sdk/broker/discovery";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { SdkClient } from "../src/sdk/client";
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
	const url = `ws://127.0.0.1:${server.port}`;
	const dir = path.join(repo, ".gjc", "state", "sdk");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ url, token }));
	return { repo, sessionId, url, sent: () => sends };
}

/**
 * Writes a valid broker discovery record so the broker-bound MCP flow resolves
 * the fixture broker through `ensureBroker` (external discovery) instead of
 * spawning a real one. `connect` stubs route on this URL.
 */
function brokerFixture(
	repo: string,
	session: { sessionId: string; url: string; token: string },
	sessions?: Array<Record<string, unknown>>,
) {
	const agentDir = path.join(repo, "agent");
	const brokerDir = path.join(agentDir, "sdk");
	fs.mkdirSync(brokerDir, { recursive: true });
	const incarnation = brokerProcessIncarnation(process.pid);
	if (!incarnation) throw new Error(`Current process incarnation is unavailable for pid ${process.pid}.`);
	const url = "ws://broker.example.test";
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
			url,
			token: "broker-discovery-secret",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		}),
	);
	return {
		agentDir,
		url,
		/** Fake broker client whose `global` answers session.list/get_endpoint. */
		client: () =>
			({
				global: async (operation: string, input: Record<string, unknown>) => {
					if (operation === "session.list") {
						const rows =
							sessions ??
							([
								{
									sessionId: session.sessionId,
									locator: { repo, stateRoot: path.join(repo, ".gjc", "state") },
									endpointGeneration: 1,
									pid: process.pid,
									live: true,
									indexSeq: 1,
									ambiguous: false,
									terminal: false,
								},
							] satisfies Array<Record<string, unknown>>);
						if (rows.length > 100) {
							if (input.cursor === "page-2")
								return { ok: true, result: { indexSeq: 1, sessions: rows.slice(100), warnings: [] } };
							return {
								ok: true,
								result: {
									indexSeq: 1,
									sessions: rows.slice(0, 100),
									warnings: [],
									continuationCursor: "page-2",
								},
							};
						}
						return { ok: true, result: { indexSeq: 1, sessions: rows, warnings: [] } };
					}
					if (operation === "session.get_endpoint" && input.sessionId === session.sessionId)
						return { ok: true, result: { sessionId: session.sessionId, url: session.url, token: session.token } };
					return { ok: false, error: { code: "resource_gone", message: "session endpoint record is gone" } };
				},
				close: async () => {},
			}) as never,
	};
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

test("MCP forwards the lifecycle startup budget to the broker client deadline", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-mcp-startup-budget-"));
	dirs.push(repo);
	const agentDir = path.join(repo, "agent");
	const broker = new Broker({ agentDir });
	let forwardedTimeoutMs: number | undefined;
	await broker.start();
	try {
		const result = await createSdkMcpServer({
			repo,
			agentDir,
			connect: async () =>
				({
					global: async (
						_operation: string,
						_input: Record<string, unknown>,
						options?: { timeoutMs?: number },
					) => {
						forwardedTimeoutMs = options?.timeoutMs;
						return { ok: true, result: { sessionId: "created-session" } };
					},
					close: async () => {},
				}) as never,
		}).callTool("gjc_session_global", {
			operation: "session.create",
			input: { cwd: repo, readinessTimeoutMs: 4_000 },
			idempotencyKey: "forward-startup-budget",
		});
		expect(result).toEqual({ ok: true, result: { sessionId: "created-session" } });
		expect(forwardedTimeoutMs).toBe(9_000);
	} finally {
		await broker.stop();
	}
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

test("MCP surfaces typed broker resolution failures", async () => {
	const { repo, sessionId } = fixture();
	const broker = brokerFixture(repo, { sessionId, url: "ws://127.0.0.1:1", token: "session-token" });
	const mcp = createSdkMcpServer({
		repo,
		agentDir: broker.agentDir,
		connect: async (url, _token) => {
			if (url === broker.url) {
				return {
					global: async (operation: string) => {
						if (operation === "session.list")
							return {
								ok: true,
								result: {
									indexSeq: 1,
									sessions: [{ sessionId, live: true, ambiguous: false }],
									warnings: [],
								},
							};
						return { ok: false, error: { code: "endpoint_stale", message: "session endpoint is stale" } };
					},
					close: async () => {},
				} as never;
			}
			throw new Error("must not reach the session endpoint");
		},
	});
	const result = await mcp.callTool("gjc_session_query", { sessionId, query: "session.metadata" });
	expect(result).toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
});

test("MCP treats an unreachable broker as a typed error (broker-down)", async () => {
	const { repo, sessionId } = fixture();
	const broker = brokerFixture(repo, { sessionId, url: "ws://127.0.0.1:1", token: "session-token" });
	// Point the discovery record at a closed port so the real broker connect fails.
	const brokerPath = path.join(broker.agentDir, "sdk", "broker.json");
	const record = JSON.parse(fs.readFileSync(brokerPath, "utf8")) as Record<string, unknown>;
	fs.writeFileSync(brokerPath, JSON.stringify({ ...record, url: "ws://127.0.0.1:1", port: 1 }));
	const result = await createSdkMcpServer({ repo, agentDir: broker.agentDir }).callTool("gjc_session_control", {
		sessionId,
		operation: "turn.prompt",
		input: { text: "hello" },
	});
	expect(result).toMatchObject({
		ok: false,
		error: { code: expect.stringMatching(/^(unavailable|connection_closed|reconnect_exhausted)$/) },
	});
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
	const { repo, sessionId, url } = fixture();
	const broker = brokerFixture(repo, { sessionId, url, token: "sdk-mcp-test-token" });
	const mcp = createSdkMcpServer({
		repo,
		agentDir: broker.agentDir,
		connect: async (target, token) => (target === broker.url ? broker.client() : SdkClient.connect(target, token)),
	});
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
test("MCP session list and resolution see entries beyond the first 100-session page", async () => {
	const { repo, url } = fixture();
	// The broker's session.list page limit is 100; the live session is the
	// 150th row, so list/resolution must exhaust cursor pagination.
	const rows = Array.from({ length: 150 }, (_, index) => ({
		sessionId: `sess-${index + 1}`,
		live: index === 149,
		ambiguous: false,
	}));
	const broker = brokerFixture(repo, { sessionId: "sess-150", url, token: "sdk-mcp-test-token" }, rows);
	const mcp = createSdkMcpServer({
		repo,
		agentDir: broker.agentDir,
		connect: async (target, token) => (target === broker.url ? broker.client() : SdkClient.connect(target, token)),
	});
	const listed = (await mcp.callTool("gjc_session_list", {})) as {
		ok: boolean;
		sessions: Array<{ sessionId: string }>;
	};
	expect(listed.ok).toBe(true);
	expect(listed.sessions).toHaveLength(150);
	expect(listed.sessions).toContainEqual({ sessionId: "sess-150" });
	// withSession resolves the beyond-page row and reaches its live endpoint.
	await expect(
		mcp.callTool("gjc_session_control", {
			sessionId: "sess-150",
			operation: "turn.prompt",
			input: { text: "hello" },
		}),
	).resolves.toMatchObject({ ok: true, echoed: { operation: "turn.prompt" } });
});
