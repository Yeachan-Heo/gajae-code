import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import packageJson from "../package.json" with { type: "json" };
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";

type TestServer = {
	port: number | undefined;
	upgrade(request: Request): boolean;
	stop(closeActiveConnections?: boolean): void;
};

const directories: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(timeoutMs).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

test("AcpAgent detects broker endpoint changes (both url AND token) and reconnects promptly on replacement", async () => {
	const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acp-broker-replace-"));
	directories.push(fixtureRoot);
	const agentDir = path.join(fixtureRoot, ".gjc", "agent");
	await fs.mkdir(agentDir, { recursive: true });

	const requestLog: Array<{ server: number; frame: Record<string, unknown> }> = [];

	// Start first broker on port 0 (auto-assigned)
	let server1!: TestServer;
	const token1 = "token-broker-1";
	server1 = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token1)
				return new Response("Unauthorized", { status: 401 });
			if (!server1.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3 }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				requestLog.push({ server: 1, frame });
				// Always respond with empty session list
				socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: { sessions: [] } }));
			},
		},
	});
	servers.push(server1);

	const url1 = `ws://127.0.0.1:${server1.port!}`;
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: packageJson.version,
		ownerId: "test-owner",
		pid: process.pid,
		host: "127.0.0.1",
		port: server1.port!,
		url: url1,
		token: token1,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});

	// Create AcpAgent and make first request to verify initial connection works
	const agent = new AcpAgent({ signal: new AbortController().signal } as unknown as AgentSideConnection, { agentDir });
	const initialListResult = await bounded(agent.listSessions({}), "initial list sessions");
	expect(initialListResult).toMatchObject({ sessions: [] });
	expect(requestLog).toContainEqual(
		expect.objectContaining({
			server: 1,
			frame: expect.objectContaining({ type: "broker_request", operation: "session.list" }),
		}),
	);

	// Stop first broker and start second broker on different port with different token
	server1.stop(true);
	servers.splice(0);

	let server2!: TestServer;
	const token2 = "token-broker-2-different";
	server2 = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token2)
				return new Response("Unauthorized", { status: 401 });
			if (!server2.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3 }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				requestLog.push({ server: 2, frame });
				// Always respond with empty session list
				socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: { sessions: [] } }));
			},
		},
	});
	servers.push(server2);

	const url2 = `ws://127.0.0.1:${server2.port!}`;
	expect(url2).not.toBe(url1); // Different port

	// Update broker discovery to point to new broker
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: packageJson.version,
		ownerId: "test-owner",
		pid: process.pid,
		host: "127.0.0.1",
		port: server2.port!,
		url: url2,
		token: token2,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});

	// Make second request after broker replacement - should succeed promptly with no reconnect_exhausted
	// Concurrent callers racing the replacement must all land on the new broker; none may close a
	// connection another caller already rebuilt.
	const replacedBrokerListResults = await bounded(
		Promise.all([agent.listSessions({}), agent.listSessions({}), agent.listSessions({})]),
		"concurrent lists after broker replacement",
		3_000,
	);
	for (const result of replacedBrokerListResults) expect(result).toMatchObject({ sessions: [] });

	// Verify the post-replacement requests went to the new broker (server2), not the old one
	expect(requestLog.filter(r => r.server === 2)).toHaveLength(3);
	expect(requestLog.filter(r => r.server === 2)[0]).toMatchObject(
		expect.objectContaining({
			frame: expect.objectContaining({ type: "broker_request", operation: "session.list" }),
		}),
	);

	// Verify we never tried to reconnect to the dead broker (would have failed with timeout or other error)
	// All requests should be on the appropriate server for their time
	for (const [i, req] of requestLog.entries()) {
		if (i === 0) {
			// First request was to server1 before replacement
			expect(req.server).toBe(1);
		} else {
			// All subsequent requests should be to server2 after replacement
			expect(req.server).toBe(2);
		}
	}

	// Agent is automatically cleaned up via AbortSignal
	server2.stop(true);
});

test("AcpAgent detects broker token changes even on the same port", async () => {
	const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acp-broker-token-replace-"));
	directories.push(fixtureRoot);
	const agentDir = path.join(fixtureRoot, ".gjc", "agent");
	await fs.mkdir(agentDir, { recursive: true });

	const requestLog: Array<{ server: number; frame: Record<string, unknown> }> = [];

	// Start broker on fixed port
	let token = "token-1";
	let brokerPort = 0; // Will be auto-assigned from server1

	const createServer = (serverNum: number, currentToken: string, port: number) => {
		let srv!: TestServer;
		srv = Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch(request) {
				if (new URL(request.url).searchParams.get("token") !== currentToken)
					return new Response("Unauthorized", { status: 401 });
				if (!srv.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3 }));
				},
				message(socket, raw) {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					requestLog.push({ server: serverNum, frame });
					socket.send(
						JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: { sessions: [] } }),
					);
				},
			},
		});
		return srv;
	};

	const server1 = createServer(1, token, 0);
	servers.push(server1);
	// Capture server1's assigned port for server2 to use the same port
	brokerPort = server1.port!;

	const url1 = `ws://127.0.0.1:${server1.port!}`;
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: packageJson.version,
		ownerId: "test-owner",
		pid: process.pid,
		host: "127.0.0.1",
		port: server1.port!,
		url: url1,
		token,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});

	// Create AcpAgent and make first request
	const agent = new AcpAgent({ signal: new AbortController().signal } as unknown as AgentSideConnection, { agentDir });
	const initialListResult = await bounded(agent.listSessions({}), "initial list sessions");
	expect(initialListResult).toMatchObject({ sessions: [] });

	// Stop first server and start second on the same port with a different token
	server1.stop(true);
	servers.splice(0);

	// New token but same port (simulating broker restart with new token)
	token = "token-2-different";
	const server2 = createServer(2, token, brokerPort);
	servers.push(server2);

	const url2 = `ws://127.0.0.1:${server2.port!}`;
	// Assert that both servers use the same port for reliable token-only replacement testing
	expect(url1).toBe(url2);
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: packageJson.version,
		ownerId: "test-owner",
		pid: process.pid,
		host: "127.0.0.1",
		port: server2.port!,
		url: url2,
		token,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});

	// Make second request - should detect token change and reconnect to new broker
	const replacedTokenListResult = await bounded(agent.listSessions({}), "list after token replacement", 3_000);
	expect(replacedTokenListResult).toMatchObject({ sessions: [] });

	// Verify both requests completed successfully (not stuck with reconnect_exhausted)
	expect(requestLog.length).toBe(2);
	expect(requestLog[0].server).toBe(1);
	expect(requestLog[1].server).toBe(2);

	// Agent is automatically cleaned up via AbortSignal
	server2.stop(true);
});

test("AcpAgent never reacquires a broker connection when disposal overlaps a request", async () => {
	const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acp-broker-dispose-"));
	directories.push(fixtureRoot);
	const agentDir = path.join(fixtureRoot, ".gjc", "agent");
	await fs.mkdir(agentDir, { recursive: true });

	const token = "token-dispose";
	let opened = 0;
	let closed = 0;
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
				opened++;
				socket.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3 }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: { sessions: [] } }));
			},
			close() {
				closed++;
			},
		},
	});
	servers.push(server);
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: packageJson.version,
		ownerId: "test-owner",
		pid: process.pid,
		host: "127.0.0.1",
		port: server.port!,
		url: `ws://127.0.0.1:${server.port!}`,
		token,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});

	const controller = new AbortController();
	const agent = new AcpAgent({ signal: controller.signal } as unknown as AgentSideConnection, { agentDir });
	await bounded(agent.listSessions({}), "initial list sessions");
	expect(opened).toBe(1);

	// The request parks on the discovery read while disposal drops and closes the cached connection.
	// When it resumes it must not open a new connection that nothing will ever close.
	const overlapping = agent.listSessions({}).then(
		() => "resolved",
		() => "rejected",
	);
	controller.abort();
	expect(await bounded(overlapping, "request overlapping disposal")).toBe("rejected");
	await Bun.sleep(200);

	expect(opened).toBe(1);
	expect(closed).toBe(1);
});
