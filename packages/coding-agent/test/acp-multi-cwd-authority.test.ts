import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { AcpAgent } from "../src/modes/acp/acp-agent";

type BrokerSession = { sessionId: string; locator: { repo: string } };
type BrokerRequest = { operation?: string; input?: Record<string, unknown>; idempotencyKey?: string };
type TestServer = { port: number | undefined; upgrade(request: Request): boolean; stop(close?: boolean): void };

const directories: string[] = [];
const servers: TestServer[] = [];

async function createHarness(): Promise<{
	agent: AcpAgent;
	abort: AbortController;
	agentDir: string;
	cwdA: string;
	cwdB: string;
	requests: BrokerRequest[];
	setSessions(sessions: BrokerSession[]): void;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acp-multi-cwd-"));
	directories.push(root);
	const agentDir = path.join(root, ".gjc", "agent");
	const cwdA = path.join(root, "workspace-a");
	const cwdB = path.join(root, "workspace-b");
	const token = "multi-cwd-token";
	const requests: BrokerRequest[] = [];
	let brokerSessions: BrokerSession[] = [];
	let server!: TestServer;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3 }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as BrokerRequest & { id?: string };
				requests.push(frame);
				if (frame.operation === "session.list") {
					const requestedId = frame.input?.resolveSessionId;
					const requestedCwd = frame.input?.cwd;
					const match = brokerSessions.find(
						session =>
							session.sessionId === requestedId &&
							typeof requestedCwd === "string" &&
							path.resolve(session.locator.repo) === path.resolve(requestedCwd),
					);
					const result =
						typeof requestedId === "string"
							? match
								? {
										savedSession: {
											id: match.sessionId,
											path: path.join(match.locator.repo, `${match.sessionId}.jsonl`),
										},
									}
								: { sessions: [] }
							: { sessions: brokerSessions };
					socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result }));
					return;
				}
				socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: {} }));
			},
		},
	}) as TestServer;
	servers.push(server);
	await fs.mkdir(path.join(agentDir, "sdk"), { recursive: true });
	await Promise.all([fs.mkdir(cwdA, { recursive: true }), fs.mkdir(cwdB, { recursive: true })]);
	await Bun.write(
		path.join(agentDir, "sdk", "broker.json"),
		JSON.stringify({
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "test-owner",
			pid: process.pid,
			host: "127.0.0.1",
			port: server.port,
			url: `ws://127.0.0.1:${server.port}`,
			token,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		}),
	);
	const abort = new AbortController();
	const agent = new AcpAgent(
		{ signal: abort.signal, closed: Promise.withResolvers<void>().promise } as unknown as AgentSideConnection,
		{ agentDir },
	);
	return {
		agent,
		abort,
		agentDir,
		cwdA,
		cwdB,
		requests,
		setSessions(sessions) {
			brokerSessions = sessions;
		},
	};
}

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

test("one ACP connection keeps independent cwd authority for distinct broker sessions", async () => {
	const harness = await createHarness();
	harness.setSessions([
		{ sessionId: "session-a", locator: { repo: harness.cwdA } },
		{ sessionId: "session-b", locator: { repo: harness.cwdB } },
	]);

	expect(await harness.agent.listSessions({ cwd: harness.cwdA })).toMatchObject({
		sessions: [{ sessionId: "session-a", cwd: harness.cwdA }],
	});
	expect(await harness.agent.listSessions({ cwd: path.join(harness.cwdB, ".") })).toMatchObject({
		sessions: [{ sessionId: "session-b", cwd: harness.cwdB }],
	});
	await expect(harness.agent.closeSession({ sessionId: "session-a" })).resolves.toEqual({});
	await expect(harness.agent.closeSession({ sessionId: "session-b" })).resolves.toEqual({});
	expect(harness.requests.filter(request => request.operation === "session.close")).toEqual([
		expect.objectContaining({ idempotencyKey: "acp:session.close:session-a" }),
		expect.objectContaining({ idempotencyKey: "acp:session.close:session-b" }),
	]);
	harness.abort.abort();
});

test("a cross-cwd session id conflict revokes prior authority for the connection lifetime", async () => {
	const harness = await createHarness();
	harness.setSessions([{ sessionId: "shared", locator: { repo: harness.cwdA } }]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	harness.setSessions([{ sessionId: "shared", locator: { repo: harness.cwdB } }]);
	await expect(harness.agent.listSessions({ cwd: harness.cwdB })).rejects.toMatchObject({ code: "conflict" });

	harness.setSessions([{ sessionId: "shared", locator: { repo: harness.cwdA } }]);
	await expect(harness.agent.listSessions({ cwd: harness.cwdA })).rejects.toMatchObject({ code: "conflict" });
	const beforeLifecycle = harness.requests.length;
	await expect(
		harness.agent.loadSession({ sessionId: "shared", cwd: harness.cwdA, mcpServers: [] }),
	).rejects.toMatchObject({
		code: "conflict",
	});
	await expect(harness.agent.closeSession({ sessionId: "shared" })).rejects.toMatchObject({ code: "conflict" });
	await expect(harness.agent.deleteSession({ sessionId: "shared" })).rejects.toMatchObject({ code: "conflict" });
	expect(harness.requests).toHaveLength(beforeLifecycle);
	harness.abort.abort();
});

test("a cwd-less broker observation revokes a session id relocated after scoped issuance", async () => {
	const harness = await createHarness();
	harness.setSessions([{ sessionId: "relocated", locator: { repo: harness.cwdA } }]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	harness.setSessions([{ sessionId: "relocated", locator: { repo: harness.cwdB } }]);
	await expect(harness.agent.listSessions({})).resolves.toMatchObject({
		sessions: [{ sessionId: "relocated", cwd: harness.cwdB }],
	});
	const beforeLifecycle = harness.requests.length;
	await expect(harness.agent.closeSession({ sessionId: "relocated" })).rejects.toMatchObject({ code: "conflict" });
	await expect(harness.agent.deleteSession({ sessionId: "relocated" })).rejects.toMatchObject({ code: "conflict" });
	expect(harness.requests).toHaveLength(beforeLifecycle);
	harness.abort.abort();
});

test("delete validates current scoped authority before any remote lifecycle mutation", async () => {
	const harness = await createHarness();
	harness.setSessions([{ sessionId: "moved-before-delete", locator: { repo: harness.cwdA } }]);
	await harness.agent.listSessions({ cwd: harness.cwdA });

	harness.setSessions([{ sessionId: "moved-before-delete", locator: { repo: harness.cwdB } }]);
	const lifecycleBefore = harness.requests.filter(
		request => request.operation === "session.close" || request.operation === "session.delete",
	).length;
	await expect(harness.agent.deleteSession({ sessionId: "moved-before-delete" })).rejects.toMatchObject({
		code: "conflict",
	});
	expect(
		harness.requests.filter(
			request => request.operation === "session.close" || request.operation === "session.delete",
		),
	).toHaveLength(lifecycleBefore);
	harness.abort.abort();
});

test("a duplicate id across broker workspaces fails before any scoped authority is committed", async () => {
	const harness = await createHarness();
	harness.setSessions([
		{ sessionId: "safe", locator: { repo: harness.cwdA } },
		{ sessionId: "duplicate", locator: { repo: harness.cwdA } },
		{ sessionId: "duplicate", locator: { repo: harness.cwdB } },
	]);

	await expect(harness.agent.listSessions({ cwd: harness.cwdA })).rejects.toMatchObject({ code: "conflict" });
	const beforeLifecycle = harness.requests.length;
	await expect(harness.agent.closeSession({ sessionId: "duplicate" })).rejects.toMatchObject({ code: "conflict" });
	await expect(harness.agent.closeSession({ sessionId: "safe" })).resolves.toEqual({});
	expect(harness.requests).toHaveLength(beforeLifecycle);
	harness.abort.abort();
});

test("session cursors use exact decimal grammar and paginate within one cwd", async () => {
	const harness = await createHarness();
	harness.setSessions(
		Array.from({ length: 60 }, (_, index) => ({ sessionId: `session-${index}`, locator: { repo: harness.cwdA } })),
	);
	const malformed = ["", "10px", "0x10", " 10", "+10", "-1", "1e2", "10:20", "10.5", "01", "9007199254740992"];
	for (const cursor of malformed) {
		const before = harness.requests.length;
		await expect(harness.agent.listSessions({ cwd: harness.cwdA, cursor })).rejects.toThrow(
			"Invalid ACP session cursor",
		);
		expect(harness.requests).toHaveLength(before);
	}
	const first = await harness.agent.listSessions({ cwd: harness.cwdA });
	expect(first.sessions).toHaveLength(50);
	expect(first.nextCursor).toBe("50");
	const second = await harness.agent.listSessions({ cwd: harness.cwdA, cursor: first.nextCursor });
	expect(second.sessions).toHaveLength(10);
	expect(second.nextCursor).toBeUndefined();
	harness.abort.abort();
});
