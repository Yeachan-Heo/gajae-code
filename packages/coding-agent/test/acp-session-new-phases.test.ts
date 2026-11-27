import { describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { logger, TempDir } from "@gajae-code/utils";
import packageJson from "../package.json" with { type: "json" };
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SessionIndex } from "../src/sdk/broker/session-index";

setDefaultTimeout(20_000);

type Fixture = { agent: AcpAgent; cwd: string; requests: Record<string, unknown>[]; dispose: () => void };

async function createFixture(attachFails: boolean): Promise<Fixture> {
	const tempDir = TempDir.createSync("@acp-new-phases-");
	const agentDir = path.join(tempDir.path(), "agent");
	const cwd = path.join(tempDir.path(), "workspace");
	const sessionId = "new-phases-session";
	const token = "new-phases-token";
	const abort = new AbortController();
	const requests: Record<string, unknown>[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "hello", connectionId: "new-phases" }));
			},
			async message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				if (frame.type === "broker_request") {
					requests.push(frame);
					if (frame.operation === "broker.status") {
						socket.send(
							JSON.stringify({
								type: "broker_response",
								id: frame.id,
								ok: true,
								result: { capabilities: { ephemeralSessions: true } },
							}),
						);
						return;
					}
					if (frame.operation === "session.create") {
						const endpointPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
						await fs.mkdir(path.dirname(endpointPath), { recursive: true });
						await Bun.write(
							endpointPath,
							JSON.stringify({ sessionId, pid: process.pid, url: `ws://127.0.0.1:${server.port}`, token }),
						);
						await fs.utimes(endpointPath, 0.001, 0.001);
						const index = await new SessionIndex(agentDir).open();
						await index.append({
							type: "host_registered",
							sessionId,
							locator: { cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") },
							endpointGeneration: 1,
							pid: process.pid,
							endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
						});
					}
					const result =
						frame.operation === "session.create"
							? {
									sessionId,
									endpointGeneration: 1,
									pid: process.pid,
									endpointMtimeMs: 1,
									endpoint: {
										sessionId,
										pid: process.pid,
										url: attachFails ? "ws://127.0.0.1:1" : `ws://127.0.0.1:${server.port}`,
										token,
									},
								}
							: {};
					socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result }));
					return;
				}
				if (frame.type === "event_replay") {
					socket.send(JSON.stringify({ type: "event_replay_result", id: frame.id, events: [] }));
					return;
				}
				if (frame.type === "register_provider") {
					socket.send(
						JSON.stringify({ type: "register_provider_result", id: frame.id, ok: true, leaseId: "lease" }),
					);
					return;
				}
				if (frame.type === "query_request") {
					const result =
						frame.query === "runtime.capabilities"
							? { promptTerminalOutcomeVersion: 1, primaryControlSurface: "sdk" }
							: frame.query === "config.list/get"
								? {
										page: {
											items: [{ mode: "default", model: "openai/gpt", thinking: "medium" }],
											complete: true,
										},
									}
								: frame.query === "models.list/current"
									? { page: { items: [{ provider: "openai", id: "gpt", name: "GPT" }], complete: true } }
									: frame.query === "providers.list/active"
										? {
												page: {
													items: [{ providerId: "openai", connectionKind: "credential" }],
													complete: true,
												},
											}
										: { page: { items: [], complete: true } };
					socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result }));
					return;
				}
				if (frame.type === "control_request")
					socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true, result: {} }));
			},
		},
	});
	const port = server.port;
	if (port === undefined) throw new Error("Expected fixture port");
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: packageJson.version,
		ownerId: "new-phases-owner",
		pid: process.pid,
		host: "127.0.0.1",
		port,
		url: `ws://127.0.0.1:${port}`,
		token,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});
	await fs.mkdir(cwd, { recursive: true });
	const agent = new AcpAgent(
		{
			sessionUpdate: async (_update: SessionNotification) => {},
			signal: abort.signal,
			closed: Promise.resolve(),
		} as AgentSideConnection,
		{ agentDir },
	);
	return {
		agent,
		cwd,
		requests,
		dispose: () => {
			abort.abort();
			server.stop(true);
			tempDir.removeSync();
		},
	};
}

describe("ACP newSession phase timing", () => {
	it("advertises extension understanding and preserves temporary initial attach and close", async () => {
		const fixture = await createFixture(false);
		try {
			const initialized = await fixture.agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
			expect(initialized._meta).toMatchObject({ gjc: { ephemeralSessions: true } });
			const response = await fixture.agent.newSession({
				cwd: fixture.cwd,
				mcpServers: [],
				_meta: { gjc: { ephemeral: true } },
			});
			expect(fixture.requests.find(request => request.operation === "session.create")?.input).toMatchObject({
				ephemeral: true,
			});
			const existing = { sessionId: response.sessionId, cwd: fixture.cwd, mcpServers: [] };
			const requestsBefore = fixture.requests.length;
			await expect(fixture.agent.loadSession(existing)).rejects.toMatchObject({ code: "operation_prohibited" });
			await expect(fixture.agent.resumeSession(existing)).rejects.toMatchObject({ code: "operation_prohibited" });
			expect(fixture.requests).toHaveLength(requestsBefore);
			await expect(fixture.agent.closeSession({ sessionId: response.sessionId })).resolves.toEqual({});
			expect(fixture.requests.filter(request => request.operation === "session.close")).toHaveLength(1);
		} finally {
			fixture.dispose();
		}
	});

	it("rejects nonboolean temporary intent before any broker mutation", async () => {
		const fixture = await createFixture(false);
		try {
			for (const ephemeral of [null, "true", 1, {}, []]) {
				await expect(
					fixture.agent.newSession({
						cwd: fixture.cwd,
						mcpServers: [],
						_meta: { gjc: { ephemeral } },
					}),
				).rejects.toMatchObject({ code: "invalid_input" });
			}
			expect(fixture.requests).toHaveLength(0);
		} finally {
			fixture.dispose();
		}
	});

	it("treats explicit false as ordinary creation", async () => {
		const fixture = await createFixture(false);
		try {
			const response = await fixture.agent.newSession({
				cwd: fixture.cwd,
				mcpServers: [],
				_meta: { gjc: { ephemeral: false } },
			});
			expect(fixture.requests.find(request => request.operation === "session.create")?.input).not.toHaveProperty(
				"ephemeral",
			);
			expect(fixture.requests.some(request => request.operation === "broker.status")).toBe(false);
			await expect(
				fixture.agent.resumeSession({
					sessionId: response.sessionId,
					cwd: fixture.cwd,
					mcpServers: [],
				}),
			).resolves.toBeDefined();
		} finally {
			fixture.dispose();
		}
	});

	it("logs one success event with all phase durations", async () => {
		const fixture = await createFixture(false);
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		try {
			const response = await fixture.agent.newSession({ cwd: fixture.cwd, mcpServers: [] });
			expect(response.sessionId).toBe("new-phases-session");
			expect(fixture.requests.find(request => request.operation === "session.create")?.input).not.toHaveProperty(
				"ephemeral",
			);
			const entries = debug.mock.calls.filter(([event]) => event === "acp_session_new_phases");
			expect(entries).toHaveLength(1);
			expect(entries[0]?.[1]).toMatchObject({ outcome: "ok", sessionId: response.sessionId });
			for (const phase of ["launchMs", "attachMs", "startupOptionsMs", "sessionStateMs", "totalMs"]) {
				expect(typeof (entries[0]?.[1] as Record<string, unknown>)[phase]).toBe("number");
			}
		} finally {
			debug.mockRestore();
			fixture.dispose();
		}
	});

	it("logs attach failure once and rethrows the original error", async () => {
		const fixture = await createFixture(true);
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		try {
			await expect(fixture.agent.newSession({ cwd: fixture.cwd, mcpServers: [] })).rejects.toThrow();
			const entries = debug.mock.calls.filter(([event]) => event === "acp_session_new_phases");
			expect(entries).toHaveLength(1);
			expect(entries[0]?.[1]).toMatchObject({ outcome: "error", sessionId: "new-phases-session" });
		} finally {
			debug.mockRestore();
			fixture.dispose();
		}
	});
});
