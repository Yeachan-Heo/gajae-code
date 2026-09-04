import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import packageJson from "../package.json" with { type: "json" };
import { AcpAgent, acpSkillInvocation } from "../src/modes/acp/acp-agent";
import { brokerProcessIncarnation, writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SessionIndex } from "../src/sdk/broker/session-index";

type TestServer = {
	port: number | undefined;
	upgrade(request: Request): boolean;
	stop(closeActiveConnections?: boolean): void;
};

const directories: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(timeoutMs).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

type SessionListResponse = Record<string, unknown>;

async function createSessionListBroker(
	responder: (input: Record<string, unknown>) => SessionListResponse,
): Promise<{ directory: string; agentDir: string; requests: Array<Record<string, unknown>> }> {
	const directory = await mkdtemp(path.join(tmpdir(), "gjc-sdk-acp-session-list-"));
	directories.push(directory);
	const agentDir = path.join(directory, ".gjc", "agent");
	const token = "acp-session-list-token";
	const requests: Array<Record<string, unknown>> = [];
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
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				requests.push(frame);
				const input = (frame.input ?? {}) as Record<string, unknown>;
				socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ...responder(input) }));
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
	return { directory, agentDir, requests };
}

test("ACP advertised skill commands require one complete canonical text block", () => {
	expect(acpSkillInvocation([{ type: "text", text: " /skill:deep-interview clarify choices " }])).toEqual({
		name: "deep-interview",
		args: "clarify choices",
	});
	expect(acpSkillInvocation([{ type: "text", text: "/skill:" }])).toBeUndefined();
	expect(
		acpSkillInvocation([
			{ type: "text", text: "/skill:deep-interview" },
			{ type: "text", text: "extra context" },
		]),
	).toBeUndefined();
	expect(acpSkillInvocation([{ type: "text", text: "/skill:not-advertised" }])).toEqual({
		name: "not-advertised",
		args: "",
	});
});
test("production ACP routes zero-session SDK globals through the broker adapter", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "gjc-sdk-acp-production-"));
	directories.push(directory);
	const agentDir = path.join(directory, ".gjc", "agent");
	const token = "acp-broker-token";
	const requests: Array<Record<string, unknown>> = [];
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
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				requests.push(frame);
				socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: { sessions: [] } }));
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

	const abort = new AbortController();
	const agent = new AcpAgent({ signal: abort.signal } as unknown as AgentSideConnection, { agentDir });
	const result = await agent.extMethod("_gjc/sdk/global", { operation: "session.list" });

	expect(result).toMatchObject({ ok: true, result: { sessions: [] } });
	expect(requests).toEqual([
		expect.objectContaining({ type: "broker_request", operation: "session.list", input: {} }),
	]);
	expect(requests[0]).not.toHaveProperty("sessionId");
	const lifecycle = await agent.extMethod("_gjc/sdk/global", {
		operation: "session.create",
		input: { cwd: directory },
		idempotencyKey: "must-not-reach-broker",
	});
	expect(lifecycle).toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
	expect(JSON.stringify(lifecycle)).not.toContain(token);
	expect(requests).toHaveLength(1);
	abort.abort();
});

test("production ACP drains session.list continuation pages before returning sessions", async () => {
	const pageOne = {
		sessionId: "page-one",
		locator: { cwd: "/workspace", worktreeRoot: null, stateRoot: "/workspace/.gjc/state" },
		live: true,
	};
	const pageTwo = {
		sessionId: "page-two",
		locator: { cwd: "/workspace", worktreeRoot: null, stateRoot: "/workspace/.gjc/state" },
		live: false,
	};
	const fixture = await createSessionListBroker(input =>
		input.cursor === undefined
			? { ok: true, result: { sessions: [pageOne], continuationCursor: "page-2" } }
			: { ok: true, result: { sessions: [pageTwo] } },
	);
	const abort = new AbortController();
	const agent = new AcpAgent({ signal: abort.signal } as unknown as AgentSideConnection, {
		agentDir: fixture.agentDir,
	});
	try {
		const listed = await agent.listSessions({});
		expect(listed.sessions.map(session => session.sessionId)).toEqual(["page-one", "page-two"]);
		expect(fixture.requests.map(request => request.input)).toEqual([{}, { cursor: "page-2" }]);
	} finally {
		abort.abort();
	}
});

test("production ACP rejects an ok:false session.list continuation instead of returning page one", async () => {
	const pageOne = {
		sessionId: "page-one",
		locator: { cwd: "/workspace", worktreeRoot: null, stateRoot: "/workspace/.gjc/state" },
		live: true,
	};
	const fixture = await createSessionListBroker(input =>
		input.cursor === undefined
			? { ok: true, result: { sessions: [pageOne], continuationCursor: "page-2" } }
			: { ok: false, error: { code: "continuation_failed", message: "page two failed" } },
	);
	const abort = new AbortController();
	const agent = new AcpAgent({ signal: abort.signal } as unknown as AgentSideConnection, {
		agentDir: fixture.agentDir,
	});
	try {
		await expect(agent.listSessions({})).rejects.toMatchObject({
			code: "continuation_failed",
			message: "page two failed",
		});
		expect(fixture.requests.map(request => request.input)).toEqual([{}, { cursor: "page-2" }]);
	} finally {
		abort.abort();
	}
});

test("production ACP rejects repeated session.list cursors without returning partial sessions", async () => {
	const fixture = await createSessionListBroker(() => ({
		ok: true,
		result: { sessions: [{ sessionId: "page" }], continuationCursor: "repeat" },
	}));
	const abort = new AbortController();
	const agent = new AcpAgent({ signal: abort.signal } as unknown as AgentSideConnection, {
		agentDir: fixture.agentDir,
	});
	try {
		await expect(agent.listSessions({})).rejects.toMatchObject({
			code: "protocol_error",
			message: "session.list returned a repeated continuation cursor.",
		});
		expect(fixture.requests.map(request => request.input)).toEqual([{}, { cursor: "repeat" }]);
	} finally {
		abort.abort();
	}
});

test("production ACP rejects malformed session.list continuation pages without partial sessions", async () => {
	const fixture = await createSessionListBroker(input =>
		input.cursor === undefined
			? { ok: true, result: { sessions: [{ sessionId: "page-one" }], continuationCursor: "page-2" } }
			: { ok: true, result: { sessions: "not-an-array" } },
	);
	const abort = new AbortController();
	const agent = new AcpAgent({ signal: abort.signal } as unknown as AgentSideConnection, {
		agentDir: fixture.agentDir,
	});
	try {
		await expect(agent.listSessions({})).rejects.toMatchObject({
			code: "protocol_error",
			message: "session.list returned a malformed page.",
		});
		expect(fixture.requests.map(request => request.input)).toEqual([{}, { cursor: "page-2" }]);
	} finally {
		abort.abort();
	}
});
test("production ACP preserves lifecycle, turn, replay, and connection ownership contracts over SDK WebSockets", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "gjc-sdk-acp-contract-"));
	directories.push(directory);
	const agentDir = path.join(directory, ".gjc", "agent");
	const cwd = path.join(directory, "workspace");
	const token = "acp-contract-token";
	const hostIncarnation = brokerProcessIncarnation(process.pid);
	const brokerSessions: Record<string, unknown>[] = [
		{
			sessionId: "owned-session",
			locator: { cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") },
			live: true,
			endpointGeneration: 1,
			...(hostIncarnation === undefined ? {} : { processIncarnation: hostIncarnation, hostIncarnation }),
		},
	];
	const lifecycleInputs: Record<string, unknown>[] = [];
	const brokerRequests: Record<string, unknown>[] = [];
	const promptInputs: Record<string, unknown>[] = [];
	const currentPromptCorrelation = (): { commandId: string; turnId: string } => ({
		commandId: `prompt-command-${promptInputs.length}`,
		turnId: `prompt-turn-${promptInputs.length}`,
	});
	const skillInputs: Record<string, unknown>[] = [];
	const controlOperations: string[] = [];
	const abortFrames: Record<string, unknown>[] = [];
	const updates: SessionNotification[] = [];
	const providerRegistrations: Array<Record<string, unknown>> = [];
	let closeSessionTransport: (() => void) | undefined;
	let reconnectingSessionTransport = false;
	let promptSocket: { send(message: string): void } | undefined;
	let holdSkillPreflight = false;
	let pendingSkillControlId: string | undefined;
	let abortAcknowledged = true;
	let promptDeliveredWhileBusy = false;
	const sessionCloseLedger = new Map<string, Record<string, unknown>>();
	let makeNextSessionCloseUncertain = true;
	let rejectNextSessionClose = false;
	let activeModelPreset = "test-preset";
	let completeNextPromptBeforeAck = false;
	/** Queries `#sessionState` issues before `session/new` can answer. */
	const SESSION_STATE_QUERIES = new Set(["config.list/get", "models.profiles.list", "providers.list/active"]);
	let queryStallMs = 0;

	let server!: ReturnType<typeof Bun.serve>;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				const connectionId = reconnectingSessionTransport ? "acp-contract-reconnected" : "acp-contract";
				reconnectingSessionTransport = false;
				socket.send(JSON.stringify({ type: "hello", connectionId }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				if (frame.type === "register_provider") {
					closeSessionTransport = () => socket.close();
					providerRegistrations.push(frame);
					socket.send(
						JSON.stringify({ type: "register_provider_result", id: frame.id, ok: true, leaseId: "lease" }),
					);
					return;
				}
				if (frame.type === "broker_request") {
					brokerRequests.push(frame);
					if (frame.operation === "session.create" || frame.operation === "session.resume") {
						lifecycleInputs.push(frame.input as Record<string, unknown>);
						socket.send(
							JSON.stringify({
								type: "broker_response",
								id: frame.id,
								ok: true,
								result: {
									sessionId: "owned-session",
									endpointGeneration: 1,
									pid: process.pid,
									endpointMtimeMs,
									endpoint: {
										sessionId: "owned-session",
										pid: process.pid,
										url: `ws://127.0.0.1:${server.port}`,
										token,
									},
								},
							}),
						);
						return;
					}
					if (frame.operation === "session.list") {
						const input = frame.input as Record<string, unknown>;
						socket.send(
							JSON.stringify({
								type: "broker_response",
								id: frame.id,
								ok: true,
								result:
									input.resolveSessionId === "owned-session"
										? { savedSession: { id: "owned-session", path: path.join(cwd, "owned-session.jsonl") } }
										: { sessions: brokerSessions },
							}),
						);
						return;
					}
					if (frame.operation === "session.get_endpoint") {
						const respond = () =>
							socket.send(
								JSON.stringify({
									type: "broker_response",
									id: frame.id,
									ok: true,
									result: {
										sessionId: "owned-session",
										endpoint: {
											url: `ws://127.0.0.1:${server.port}`,
											token,
										},
									},
								}),
							);
						respond();
						return;
					}
					if (frame.operation === "session.close") {
						const idempotencyKey = String(frame.idempotencyKey);
						const replay = sessionCloseLedger.get(idempotencyKey);
						if (replay) {
							const replayError = replay.error as Record<string, unknown> | undefined;
							const response = replayError?.code === "terminal_uncertain" ? { ok: true, result: {} } : replay;
							sessionCloseLedger.set(idempotencyKey, response);
							socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ...response }));
							return;
						}
						if (makeNextSessionCloseUncertain) {
							makeNextSessionCloseUncertain = false;
							const response = {
								ok: false,
								error: {
									code: "terminal_uncertain",
									message: "session close outcome is uncertain",
									cleanup: {},
								},
							};
							sessionCloseLedger.set(idempotencyKey, response);
							socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ...response }));
							return;
						}
						const response = rejectNextSessionClose
							? {
									ok: false,
									error: { code: "close_refused", message: "session close rejected" },
								}
							: { ok: true, result: {} };
						rejectNextSessionClose = false;
						sessionCloseLedger.set(idempotencyKey, response);
						socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ...response }));
						return;
					}
					socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: {} }));
					return;
				}
				if (frame.type === "event_replay") {
					socket.send(
						JSON.stringify({
							type: "event_replay_result",
							id: frame.id,
							ok: true,
							generation: 1,
							lastSeq: 0,
							events: [],
						}),
					);
					return;
				}
				if (frame.type === "query_request") {
					if (frame.query === "runtime.capabilities") {
						socket.send(
							JSON.stringify({
								type: "query_response",
								id: frame.id,
								ok: true,
								result: { promptTerminalOutcomeVersion: 1 },
							}),
						);
						return;
					}
					if (frame.query === "context.get") {
						socket.send(
							JSON.stringify({
								type: "query_response",
								id: frame.id,
								ok: true,
								result: { usage: { tokens: 0, contextWindow: 200_000, percent: 0, source: "provider_anchor" } },
							}),
						);
						return;
					}
					const items =
						frame.query === "config.list/get"
							? [{ mode: "default", model: "openai/gpt", modelPreset: activeModelPreset, thinking: "medium" }]
							: frame.query === "models.profiles.list"
								? [
										{ id: "codex-medium", displayName: "Codex Medium", source: "builtin", available: true },
										{ id: "test-preset", displayName: "Test Preset", source: "configured", available: true },
										{
											id: "needs-auth",
											displayName: "Needs Authentication",
											source: "configured",
											available: false,
										},
									]
								: frame.query === "skill.list/state"
									? [
											{ name: "deep-interview", description: "Interview requirements" },
											{ name: "ralplan", description: "Build a consensus plan" },
											{ name: "ultragoal", description: "Execute durable goals" },
											{ name: "team", description: "Run parallel workers" },
										]
									: frame.query === "session.metadata"
										? [{ sessionId: "owned-session", name: "MCP List Request", cwd }]
										: frame.query === "transcript.list"
											? [
													{
														id: "user-1",
														role: "user",
														textSummary: "Earlier request",
														body: "Earlier request",
														content: [{ type: "text", text: "Earlier request" }],
													},
													{
														id: "assistant-1",
														role: "assistant",
														textSummary: "Earlier response",
														body: "Earlier thought\nEarlier response",
														content: [
															{ type: "thinking", thinking: "Earlier thought" },
															{ type: "text", text: "Earlier response" },
															{
																type: "toolCall",
																id: "replay-tool-1",
																name: "read",
																arguments: { path: "missing.ts" },
															},
														],
													},
													{
														id: "result-1",
														role: "toolResult",
														textSummary: "File not found",
														body: "File not found",
														content: [{ type: "text", text: "File not found" }],
														toolCallId: "replay-tool-1",
														toolName: "read",
														isError: true,
													},
												]
											: [];
					const sendQueryResponse = () =>
						socket.send(
							JSON.stringify({
								type: "query_response",
								id: frame.id,
								ok: true,
								result: { page: { items, complete: true } },
							}),
						);
					// Session-state queries answer slowly on purpose. Bootstrap updates used to be
					// scheduled on a fixed 50ms timer taken before these ran, so a slow host let
					// them overtake the session/new response and reference an unknown session.
					if (queryStallMs > 0 && SESSION_STATE_QUERIES.has(String(frame.query)))
						setTimeout(sendQueryResponse, queryStallMs);
					else sendQueryResponse();
					return;
				}
				if (frame.type === "control_request") {
					if (typeof frame.operation === "string") controlOperations.push(frame.operation);
					if (frame.operation === "turn.abort") abortFrames.push(frame);
					if (frame.operation === "model.profile.set") {
						const input = frame.input as Record<string, unknown>;
						if (input.id === "needs-auth") {
							socket.send(
								JSON.stringify({
									type: "control_response",
									id: frame.id,
									ok: false,
									error: {
										code: "authentication_failed",
										message: 'Model preset "needs-auth" has no usable provider credentials.',
									},
								}),
							);
							return;
						}
						if (typeof input.id === "string") activeModelPreset = input.id;
					}
					if (frame.operation === "turn.prompt") {
						promptInputs.push(frame.input as Record<string, unknown>);
						promptSocket = socket;
						// This real-host activity frame precedes acknowledgement, so it must
						// not settle a normal fresh prompt below the acknowledgement boundary.
						if (promptInputs.length === 1)
							socket.send(JSON.stringify({ type: "activity", sessionId: "owned-session", state: "idle" }));
						if (promptDeliveredWhileBusy)
							socket.send(JSON.stringify({ type: "activity", sessionId: "owned-session", state: "busy" }));
						if (completeNextPromptBeforeAck) {
							completeNextPromptBeforeAck = false;
							socket.send(
								JSON.stringify({
									type: "agent_end",
									sessionId: "owned-session",
									...currentPromptCorrelation(),
									finalText: "fast",
									outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
								}),
							);
						}
					}
					if (frame.operation === "skill.invoke") {
						skillInputs.push(frame.input as Record<string, unknown>);
						promptSocket = socket;
						if (holdSkillPreflight) {
							pendingSkillControlId = String(frame.id);
							return;
						}
					}
					if (frame.operation === "turn.abort" && pendingSkillControlId) {
						socket.send(
							JSON.stringify({
								type: "control_response",
								id: pendingSkillControlId,
								ok: false,
								error: { code: "busy", message: "Skill preflight was cancelled before execution." },
							}),
						);
						pendingSkillControlId = undefined;
						socket.send(
							JSON.stringify({
								type: "control_response",
								id: frame.id,
								ok: true,
								result: { aborted: true, disposition: "preflight_cancelled" },
							}),
						);
						return;
					}
					socket.send(
						JSON.stringify({
							type: "control_response",
							id: frame.id,
							ok: true,
							result:
								frame.operation === "turn.prompt"
									? { ...currentPromptCorrelation(), accepted: true }
									: frame.operation === "skill.invoke"
										? { commandId: "skill-command", turnId: "skill-turn", accepted: true }
										: frame.operation === "turn.abort"
											? abortAcknowledged
												? (() => {
														const scope =
															(frame.input as { scope?: string })?.scope === "turn" ? "turn" : "owned";
														return {
															ok: true,
															selection: scope,
															turn: "stopped",
															ownedWork: scope === "owned" ? "stopped" : "left_running",
															automaticDelivery: scope === "owned" ? "none" : "enabled",
															resumeOnOwnedCompletion: scope !== "owned",
														};
													})()
												: { aborted: false }
											: {},
						}),
					);
				}
			},
		},
	});
	servers.push(server);
	await mkdir(cwd, { recursive: true });
	const endpointPath = path.join(cwd, ".gjc", "state", "sdk", "owned-session.json");
	await mkdir(path.dirname(endpointPath), { recursive: true });
	await Bun.write(
		endpointPath,
		JSON.stringify({
			sessionId: "owned-session",
			pid: process.pid,
			url: `ws://127.0.0.1:${server.port}`,
			token,
		}),
	);
	const endpointMtimeMs = (await stat(endpointPath)).mtimeMs;
	const processIncarnation = brokerProcessIncarnation(process.pid);
	if (!processIncarnation) throw new Error("Test process incarnation is unavailable.");
	brokerSessions[0] = {
		...brokerSessions[0],
		pid: process.pid,
		processIncarnation,
		hostIncarnation: processIncarnation,
		endpointMtimeMs,
	};
	const index = await new SessionIndex(agentDir).open();
	await index.append({
		type: "host_registered",
		sessionId: "owned-session",
		locator: { cwd: cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") },
		endpointGeneration: 1,
		pid: process.pid,
		processIncarnation,
		hostIncarnation: processIncarnation,
		endpointMtimeMs,
	});
	await index.checkpointLiveHeartbeats();
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: packageJson.version,
		ownerId: "test-owner",
		pid: process.pid,
		incarnation: processIncarnation,
		host: "127.0.0.1",
		port: server.port!,
		url: `ws://127.0.0.1:${server.port}`,
		token,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});

	const controller = new AbortController();
	const agent = new AcpAgent(
		{
			sessionUpdate: async (update: SessionNotification) => {
				updates.push(update);
			},
			signal: controller.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir, startupOptions: { modelPreset: "codex-medium" } },
	);
	const initialized = await bounded(agent.initialize({ protocolVersion: 1, clientCapabilities: {} }), "initialize");
	// Legacy MCP HTTP+SSE is deprecated and unimplemented, so it must not be advertised.
	expect(initialized.agentCapabilities?.mcpCapabilities).toEqual({ http: true });
	// Make session-state resolution outlast the old fixed bootstrap timer, reproducing a
	// slow host: without the fix the skill list overtakes the response below.
	queryStallMs = 120;
	const created = await bounded(
		agent.newSession({
			cwd,
			additionalDirectories: [],
			mcpServers: [
				{
					name: "Air",
					command: "/Applications/Air.app/Contents/bin/mcp-proxy",
					args: ["--stdio"],
					env: [{ name: "AIR_MODE", value: "acp" }],
				},
				{
					type: "http",
					name: "remote",
					url: "https://mcp.example.test/api",
					headers: [{ name: "Authorization", value: "Bearer test" }],
				},
			],
		}),
		"new session",
	);
	expect(created.sessionId).toBe("owned-session");
	// The client only learns the sessionId from this response, so any session/update
	// published before it names a session the client cannot route and is dropped —
	// which is how the skill list went missing in Paseo. ACP's session-setup sequence
	// allows updates before the response only for session/load.
	expect(updates.filter(update => update.sessionId === created.sessionId)).toEqual([]);
	queryStallMs = 0;
	expect(initialized.agentCapabilities?.sessionCapabilities).not.toHaveProperty("additionalDirectories");
	expect(created.configOptions).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: "model",
				name: "Preset",
				currentValue: "test-preset",
				options: [
					{ value: "codex-medium", name: "Codex Medium" },
					{ value: "test-preset", name: "Test Preset" },
				],
			}),
		]),
	);
	const selectedPreset = await bounded(
		agent.setSessionConfigOption({
			sessionId: created.sessionId,
			configId: "model",
			value: "codex-medium",
		}),
		"set model preset",
	);
	expect(controlOperations).toContain("model.profile.set");
	expect(selectedPreset.configOptions).toEqual(
		expect.arrayContaining([expect.objectContaining({ id: "model", currentValue: "codex-medium" })]),
	);
	expect(
		await agent.extMethod("session/set_model", {
			sessionId: created.sessionId,
			modelId: "test-preset",
		}),
	).toEqual({});
	expect(activeModelPreset).toBe("test-preset");
	await agent.setSessionConfigOption({
		sessionId: created.sessionId,
		configId: "model",
		value: "codex-medium",
	});
	await expect(
		agent.setSessionConfigOption({
			sessionId: created.sessionId,
			configId: "model",
			value: "needs-auth",
		}),
	).rejects.toMatchObject({ code: "authentication_failed" });
	expect(
		(
			await bounded(
				agent.setSessionConfigOption({
					sessionId: created.sessionId,
					configId: "thinking",
					value: "medium",
				}),
				"refresh state after unavailable preset",
			)
		).configOptions,
	).toEqual(expect.arrayContaining([expect.objectContaining({ id: "model", currentValue: "codex-medium" })]));
	expect(promptInputs).toHaveLength(0);
	expect(lifecycleInputs).toEqual([
		expect.objectContaining({
			cwd,
			modelPreset: "codex-medium",
			readinessTimeoutMs: 30_500,
			mcpServers: [
				{
					name: "Air",
					command: "/Applications/Air.app/Contents/bin/mcp-proxy",
					args: ["--stdio"],
					env: { AIR_MODE: "acp" },
				},
				{
					type: "http",
					name: "remote",
					url: "https://mcp.example.test/api",
					headers: { Authorization: "Bearer test" },
				},
			],
		}),
	]);
	await waitFor(
		() => closeSessionTransport !== undefined && providerRegistrations.length > 0,
		"ACP provider registration",
	);
	await index.refresh();
	expect(index.listSessions().sessions).toEqual([expect.objectContaining({ sessionId: "owned-session", live: true })]);
	const initialProviderRegistrationCount = providerRegistrations.length;
	reconnectingSessionTransport = true;
	closeSessionTransport!();
	await waitFor(
		() => providerRegistrations.length > initialProviderRegistrationCount,
		"ACP provider re-registration after transport reconnect",
	);
	await index.refresh();
	expect(index.listSessions().sessions).toEqual([expect.objectContaining({ sessionId: "owned-session", live: true })]);
	expect(providerRegistrations.slice(initialProviderRegistrationCount)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ connectionId: "acp-contract-reconnected", expectedLeaseId: "lease" }),
		]),
	);
	await waitFor(
		() => updates.some(update => update.update.sessionUpdate === "available_commands_update"),
		"ACP available commands",
	);
	const availableCommands = updates.find(update => update.update.sessionUpdate === "available_commands_update")
		?.update as { availableCommands?: Array<{ name: string }> };
	expect(availableCommands.availableCommands?.map(command => command.name)).toEqual(
		expect.arrayContaining(["skill:deep-interview", "skill:ralplan", "skill:ultragoal", "skill:team"]),
	);
	const skillPrompt = agent.prompt({
		sessionId: created.sessionId,
		prompt: [{ type: "text", text: "/skill:deep-interview clarify ACP choices" }],
	});
	await waitFor(() => skillInputs.length === 1 && promptSocket !== undefined, "ACP skill invocation");
	expect(skillInputs).toEqual([{ name: "deep-interview", args: "clarify ACP choices" }]);
	expect(promptInputs).toHaveLength(0);
	promptSocket!.send(
		JSON.stringify({
			type: "agent_end",
			sessionId: created.sessionId,
			commandId: "skill-command",
			turnId: "skill-turn",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		}),
	);
	await expect(bounded(skillPrompt, "ACP skill prompt completion")).resolves.toMatchObject({ stopReason: "end_turn" });
	holdSkillPreflight = true;
	const preflightCancelledSkill = agent.prompt({
		sessionId: created.sessionId,
		prompt: [{ type: "text", text: "/skill:deep-interview cancel before start" }],
	});
	await waitFor(() => pendingSkillControlId !== undefined, "pending ACP skill preflight");
	await agent.cancel({ sessionId: created.sessionId });
	await expect(bounded(preflightCancelledSkill, "preflight-cancelled ACP skill")).resolves.toEqual({
		stopReason: "cancelled",
	});
	await Bun.sleep(100);
	holdSkillPreflight = false;
	const listedOwned = await bounded(agent.listSessions({ cwd }), "list owned session");
	expect(listedOwned.sessions).toEqual([
		expect.objectContaining({
			sessionId: created.sessionId,
			cwd,
		}),
	]);
	await expect(agent.newSession({ cwd, additionalDirectories: ["relative"], mcpServers: [] })).rejects.toMatchObject({
		code: "unsupported",
	});
	await expect(agent.newSession({ cwd, additionalDirectories: ["/shared"], mcpServers: [] })).rejects.toMatchObject({
		code: "unsupported",
	});
	await expect(
		agent.loadSession({ sessionId: created.sessionId, cwd, additionalDirectories: ["/shared"], mcpServers: [] }),
	).rejects.toMatchObject({ code: "unsupported" });
	await expect(
		agent.resumeSession({ sessionId: created.sessionId, cwd, additionalDirectories: ["/shared"], mcpServers: [] }),
	).rejects.toMatchObject({ code: "unsupported" });
	await expect(
		agent.unstable_forkSession({
			sessionId: created.sessionId,
			cwd,
			additionalDirectories: ["/shared"],
			mcpServers: [],
		}),
	).rejects.toMatchObject({ code: "unsupported" });
	expect(await agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" })).toEqual({});
	await expect(agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" })).rejects.toMatchObject({
		code: "unsupported",
		message: "ACP plan mode is not available because this ACP session has no host plan-mode lifecycle.",
	});
	expect(controlOperations).not.toContain("mode.plan.set");
	expect(lifecycleInputs).toEqual([expect.objectContaining({ cwd, modelPreset: "codex-medium" })]);

	let firstSettled = false;
	const firstPrompt = agent
		.prompt({
			sessionId: created.sessionId,
			prompt: [
				{ type: "resource_link", name: "README", uri: "file:///workspace/README.md" },
				{ type: "image", data: "image-bytes", mimeType: "image/png" },
			],
		})
		.then(value => {
			firstSettled = true;
			return value;
		});
	await waitFor(() => promptInputs.length === 1 && promptSocket !== undefined, "first prompt delivery");
	expect(promptInputs[0]).toEqual({
		text: "[Resource: README]\nURI: file:///workspace/README.md",
		images: [{ data: "image-bytes", mimeType: "image/png" }],
	});
	await expect(
		agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "second" }] }),
	).rejects.toThrow("ACP session already has an active prompt.");
	await Bun.sleep(20);
	expect(firstSettled).toBe(false);
	promptSocket!.send(
		JSON.stringify({
			type: "event",
			payload: {
				event_type: "agent_end",
				event: { type: "agent_end", commandId: "stale-command", messages: [] },
			},
		}),
	);
	await Bun.sleep(20);
	expect(firstSettled).toBe(false);
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
	await Bun.sleep(20);
	expect(firstSettled).toBe(false);
	for (const event of [
		{
			type: "tool_execution_start",
			toolCallId: "tool-read-1",
			toolName: "read",
			args: { path: "README.md" },
		},
		{
			type: "tool_execution_update",
			toolCallId: "tool-read-1",
			toolName: "read",
			args: { path: "README.md" },
			partialResult: { content: [{ type: "text", text: "Reading README.md" }] },
		},
		{
			type: "tool_execution_end",
			toolCallId: "tool-read-1",
			toolName: "read",
			isError: false,
			result: { content: [{ type: "text", text: "# Gajae Code" }] },
		},
	]) {
		promptSocket!.send(
			JSON.stringify({
				type: "event",
				kind: event.type,
				sessionId: created.sessionId,
				...currentPromptCorrelation(),
				payload: { event_type: event.type, event },
			}),
		);
	}
	await waitFor(
		() =>
			updates.filter(
				update => update.update.sessionUpdate === "tool_call" || update.update.sessionUpdate === "tool_call_update",
			).length === 3,
		"ACP tool lifecycle",
	);
	expect(
		updates
			.filter(
				update => update.update.sessionUpdate === "tool_call" || update.update.sessionUpdate === "tool_call_update",
			)
			.map(update => update.update),
	).toEqual([
		expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "tool-read-1", status: "pending" }),
		expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "tool-read-1", status: "in_progress" }),
		expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "tool-read-1", status: "completed" }),
	]);
	promptSocket!.send(
		JSON.stringify({
			type: "event",
			payload: {
				event_type: "message_update",
				event: {
					type: "message_update",
					message: { role: "assistant", content: [{ type: "text", text: "first" }] },
					assistantMessageEvent: { type: "text_delta", delta: "first" },
				},
			},
		}),
	);
	for (const text of ["first", "second"]) {
		promptSocket!.send(
			JSON.stringify({
				type: "event",
				payload: {
					event_type: "message_end",
					event: {
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text }] },
					},
				},
			}),
		);
	}
	await waitFor(
		() => updates.filter(update => update.update.sessionUpdate === "agent_message_chunk").length === 2,
		"per-message ACP chunks",
	);
	expect(
		updates
			.filter(update => update.update.sessionUpdate === "agent_message_chunk")
			.map(update => (update.update as { content: { text: string } }).content.text),
	).toEqual(["first", "second"]);
	// Activity is advisory rendering state; only the correlated normalized terminal settles.
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "busy" }));
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
	promptSocket!.send(
		JSON.stringify({
			type: "agent_end",
			sessionId: created.sessionId,
			...currentPromptCorrelation(),
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		}),
	);
	expect(await bounded(firstPrompt, "first prompt completion")).toEqual({ stopReason: "end_turn" });
	await waitFor(
		() =>
			updates.some(
				update =>
					update.update.sessionUpdate === "session_info_update" &&
					(update.update as { title?: string }).title === "MCP List Request",
			),
		"ACP session title update",
	);
	expect(await bounded(agent.listSessions({ cwd }), "list titled session")).toEqual(
		expect.objectContaining({
			sessions: [
				expect.objectContaining({
					sessionId: created.sessionId,
					title: "MCP List Request",
					updatedAt: expect.any(String),
				}),
			],
		}),
	);
	const usageUpdate = updates.find(update => update.update.sessionUpdate === "usage_update");
	expect(usageUpdate?.update).toMatchObject({ sessionUpdate: "usage_update", size: 200_000, used: 0 });

	let cancelledSettled = false;
	const cancelledPrompt = agent
		.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "cancel me" }] })
		.then(value => {
			cancelledSettled = true;
			return value;
		});
	await waitFor(() => promptInputs.length === 2, "second prompt delivery");
	await bounded(agent.cancel({ sessionId: created.sessionId }), "cancel acknowledgement");
	expect(controlOperations).toContain("turn.abort");
	// A client cancel is a C04 terminal abort with scope "turn": it ends the turn
	// but leaves exact owned subagents and background tasks running. Each cancel
	// carries a fresh bounded idempotency key for deterministic replay.
	expect(abortFrames.at(-1)).toMatchObject({
		operation: "turn.abort",
		input: { mode: "terminal", scope: "turn" },
		idempotencyKey: expect.any(String),
	});
	await Bun.sleep(20);
	expect(cancelledSettled).toBe(false);
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "busy" }));
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
	promptSocket!.send(
		JSON.stringify({
			type: "agent_end",
			sessionId: created.sessionId,
			...currentPromptCorrelation(),
			outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
		}),
	);
	expect(await bounded(cancelledPrompt, "cancelled prompt completion")).toEqual({ stopReason: "cancelled" });
	expect(
		updates.filter(update => {
			const payload = update.update as {
				sessionUpdate?: string;
				content?: { text?: string };
			};
			return payload.sessionUpdate === "agent_message_chunk" && /failed/i.test(payload.content?.text ?? "");
		}),
	).toHaveLength(0);
	// `_meta.gjc.abortScope: "turn"` matches the default now: the turn aborts and
	// exact owned subagents and background tasks keep running, same as a plain
	// cancel.
	await bounded(
		agent.cancel({ sessionId: created.sessionId, _meta: { gjc: { abortScope: "turn" } } }),
		"turn-scope cancel acknowledgement",
	);
	expect(abortFrames.at(-1)).toMatchObject({
		operation: "turn.abort",
		input: { mode: "terminal", scope: "turn" },
		idempotencyKey: expect.any(String),
	});
	const abortFailurePrompt = agent.prompt({
		sessionId: created.sessionId,
		prompt: [{ type: "text", text: "abort failure" }],
	});
	await waitFor(() => promptInputs.length === 3, "abort failure prompt delivery");
	abortAcknowledged = false;
	await expect(
		bounded(agent.cancel({ sessionId: created.sessionId }), "failed cancel acknowledgement"),
	).rejects.toThrow("SDK did not acknowledge cancellation");
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "busy" }));
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
	promptSocket!.send(
		JSON.stringify({
			type: "agent_end",
			sessionId: created.sessionId,
			...currentPromptCorrelation(),
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		}),
	);
	expect(await bounded(abortFailurePrompt, "abort-failure prompt completion")).toEqual({ stopReason: "end_turn" });
	abortAcknowledged = true;
	promptDeliveredWhileBusy = true;
	const steeringPrompt = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "steer me" }] });
	await waitFor(() => promptInputs.length === 4, "steering prompt delivery");
	promptDeliveredWhileBusy = false;
	// The host sent busy before the acknowledgement. Idle no longer completes a
	// prompt; the correlated normalized terminal is the only settlement authority.
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
	promptSocket!.send(
		JSON.stringify({
			type: "agent_end",
			sessionId: created.sessionId,
			...currentPromptCorrelation(),
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		}),
	);
	expect(await bounded(steeringPrompt, "steering prompt completion")).toEqual({ stopReason: "end_turn" });

	completeNextPromptBeforeAck = true;
	const fastPrompt = agent.prompt({
		sessionId: created.sessionId,
		prompt: [{ type: "text", text: "complete before acknowledgement" }],
	});
	expect(await bounded(fastPrompt, "pre-acknowledgement prompt completion")).toEqual({ stopReason: "end_turn" });
	await waitFor(
		() =>
			updates.some(
				update =>
					update.update.sessionUpdate === "agent_message_chunk" &&
					(update.update as { content?: { text?: string } }).content?.text === "fast",
			),
		"pre-acknowledgement detached final text",
	);
	expect(
		updates.some(
			update =>
				update.update.sessionUpdate === "agent_message_chunk" &&
				(update.update as { content?: { text?: string } }).content?.text === "fast",
		),
	).toBe(true);

	await expect(
		agent.prompt({
			sessionId: created.sessionId,
			prompt: [
				{
					type: "resource",
					resource: { uri: "file:///workspace/archive.bin", blob: "bytes", mimeType: "application/octet-stream" },
				},
			],
		}),
	).rejects.toThrow("Unsupported embedded resource MIME type");
	await expect(
		agent.newSession({
			cwd,
			mcpServers: [{ type: "http", name: "invalid", url: "file:///tmp/mcp", headers: [] }],
		}),
	).rejects.toThrow("must use HTTP or HTTPS");
	const secretUrlFailure = await agent
		.newSession({
			cwd,
			mcpServers: [
				{
					type: "http",
					name: "secret-url",
					url: "not-a-url?token=super-secret",
					headers: [],
				},
			],
		})
		.catch((error: unknown) => error);
	expect(secretUrlFailure).toMatchObject({ code: "invalid_input" });
	expect(String((secretUrlFailure as Error).message)).not.toContain("super-secret");
	await expect(
		agent.newSession({
			cwd,
			mcpServers: [
				{ name: "duplicate", command: "/usr/bin/true", args: [], env: [] },
				{ name: "duplicate", command: "/usr/bin/true", args: [], env: [] },
			],
		}),
	).rejects.toThrow("unique safe names");
	const secretEnvironmentFailure = await agent
		.newSession({
			cwd,
			mcpServers: [
				{
					name: "secret-env",
					command: "/usr/bin/true",
					args: [],
					env: [
						{ name: "TOKEN", value: "super-secret" },
						{ name: "TOKEN", value: "duplicate-secret" },
					],
				},
			],
		})
		.catch((error: unknown) => error);
	expect(secretEnvironmentFailure).toMatchObject({ code: "invalid_input" });
	expect(String((secretEnvironmentFailure as Error).message)).not.toContain("super-secret");
	const secretHeaderFailure = await agent
		.newSession({
			cwd,
			mcpServers: [
				{
					type: "http",
					name: "secret-header",
					url: "https://mcp.example.test",
					headers: [{ name: "Authorization", value: "Bearer super-secret\r\nInjected: true" }],
				},
			],
		})
		.catch((error: unknown) => error);
	expect(secretHeaderFailure).toMatchObject({ code: "invalid_input" });
	expect(String((secretHeaderFailure as Error).message)).not.toContain("super-secret");
	await expect(
		agent.newSession({
			cwd,
			mcpServers: Array.from({ length: 65 }, (_, index) => ({
				name: `server-${index}`,
				command: "/usr/bin/true",
				args: [],
				env: [],
			})),
		}),
	).rejects.toMatchObject({ code: "unsupported" });

	const observerAbort = new AbortController();
	const observer = new AcpAgent({ signal: observerAbort.signal } as unknown as AgentSideConnection, { agentDir });
	await bounded(observer.listSessions({}), "observer list");
	const brokerRequestCount = brokerRequests.length;
	// Enumerating a session through `session/list` must not confer destructive
	// lifecycle authority over it. Both calls resolve as local no-ops, and the
	// decisive assertion is that neither reaches the broker: a `session.delete`
	// here would mean one connection could destroy another connection's session
	// after merely listing it.
	expect(await bounded(observer.closeSession({ sessionId: created.sessionId }), "observer close")).toEqual({});
	expect(await bounded(observer.deleteSession({ sessionId: created.sessionId }), "observer delete")).toEqual({});
	expect(brokerRequests).toHaveLength(brokerRequestCount);
	expect(
		brokerRequests.filter(
			request =>
				(request.operation === "session.delete" || request.operation === "session.close") &&
				(request.input as { sessionId?: string } | undefined)?.sessionId === created.sessionId,
		),
	).toHaveLength(0);
	observerAbort.abort();

	await bounded(agent.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] }), "owned session reload");
	expect(updates).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				sessionId: created.sessionId,
				update: expect.objectContaining({
					sessionUpdate: "user_message_chunk",
					content: { type: "text", text: "Earlier request" },
				}),
			}),
			expect.objectContaining({
				sessionId: created.sessionId,
				update: expect.objectContaining({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Earlier response" },
				}),
			}),
			expect.objectContaining({
				sessionId: created.sessionId,
				update: expect.objectContaining({
					sessionUpdate: "agent_thought_chunk",
					content: { type: "text", text: "Earlier thought" },
				}),
			}),
			expect.objectContaining({
				sessionId: created.sessionId,
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: "replay-tool-1",
					title: "read: missing.ts",
					status: "pending",
				}),
			}),
			expect.objectContaining({
				sessionId: created.sessionId,
				update: expect.objectContaining({
					sessionUpdate: "tool_call_update",
					toolCallId: "replay-tool-1",
					status: "failed",
					title: "Failed: read: missing.ts",
					content: [{ type: "content", content: { type: "text", text: "File not found" } }],
				}),
			}),
			expect.objectContaining({
				sessionId: created.sessionId,
				update: expect.objectContaining({
					sessionUpdate: "session_info_update",
					_meta: {
						gjcTranscriptImageReplay: { available: false, reason: "historical_transcript_images_unavailable" },
					},
				}),
			}),
		]),
	);
	controller.abort();
}, 30_000);
