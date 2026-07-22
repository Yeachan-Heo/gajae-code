import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
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
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(timeoutMs).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

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
		packageGeneration: "test",
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

test("production ACP preserves lifecycle, turn, replay, and connection ownership contracts over SDK WebSockets", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "gjc-sdk-acp-contract-"));
	directories.push(directory);
	const agentDir = path.join(directory, ".gjc", "agent");
	const cwd = path.join(directory, "workspace");
	const token = "acp-contract-token";
	let brokerSessions: Record<string, unknown>[] = [
		{ sessionId: "owned-session", locator: { repo: cwd }, live: true, endpointGeneration: 1 },
	];
	const lifecycleInputs: Record<string, unknown>[] = [];
	const brokerRequests: Record<string, unknown>[] = [];
	const promptInputs: Record<string, unknown>[] = [];
	const controlOperations: string[] = [];
	const updates: SessionNotification[] = [];
	const providerRegistrations: Array<Record<string, unknown>> = [];
	let promptSocket: { send(message: string): void } | undefined;
	let abortAcknowledged = true;
	let promptDeliveredWhileBusy = false;
	let holdEndpointResponse = false;
	let releaseEndpointResponse: (() => void) | undefined;

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
				socket.send(JSON.stringify({ type: "hello", connectionId: "acp-contract" }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				if (frame.type === "register_provider") {
					providerRegistrations.push(frame);
					socket.send(
						JSON.stringify({ type: "register_provider_result", id: frame.id, ok: true, leaseId: "lease" }),
					);
					return;
				}
				if (frame.type === "broker_request") {
					brokerRequests.push(frame);
					if (frame.operation === "session.create") {
						lifecycleInputs.push(frame.input as Record<string, unknown>);
						socket.send(
							JSON.stringify({
								type: "broker_response",
								id: frame.id,
								ok: true,
								result: {
									sessionId: "owned-session",
									endpoint: { url: `ws://127.0.0.1:${server.port}`, token },
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
										endpoint: { url: `ws://127.0.0.1:${server.port}`, token },
									},
								}),
							);
						if (holdEndpointResponse) {
							releaseEndpointResponse = respond;
							return;
						}
						respond();
						return;
					}
					socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: {} }));
					return;
				}
				if (frame.type === "query_request") {
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
							? [{ mode: "default", model: "openai/gpt", thinking: "medium" }]
							: frame.query === "models.list/current"
								? [{ provider: "openai", id: "gpt", name: "GPT" }]
								: frame.query === "transcript.list"
									? [
											{
												id: "user-1",
												role: "user",
												textSummary: "Earlier request",
												body: "Earlier request",
											},
											{
												id: "assistant-1",
												role: "assistant",
												textSummary: "Earlier response",
												body: "Earlier response",
											},
										]
									: [];
					socket.send(
						JSON.stringify({ type: "query_response", id: frame.id, ok: true, result: { page: { items } } }),
					);
					return;
				}
				if (frame.type === "control_request") {
					if (typeof frame.operation === "string") controlOperations.push(frame.operation);
					if (frame.operation === "turn.prompt") {
						promptInputs.push(frame.input as Record<string, unknown>);
						promptSocket = socket;
						// This real-host activity frame precedes acknowledgement, so it must
						// not settle a normal fresh prompt below the acknowledgement boundary.
						if (promptInputs.length === 1)
							socket.send(JSON.stringify({ type: "activity", sessionId: "owned-session", state: "idle" }));
						if (promptDeliveredWhileBusy)
							socket.send(JSON.stringify({ type: "activity", sessionId: "owned-session", state: "busy" }));
					}
					socket.send(
						JSON.stringify({
							type: "control_response",
							id: frame.id,
							ok: true,
							result:
								frame.operation === "turn.prompt"
									? { commandId: "prompt-command", turnId: "prompt-turn", accepted: true }
									: frame.operation === "turn.abort"
										? { aborted: abortAcknowledged }
										: {},
						}),
					);
				}
			},
		},
	});
	servers.push(server);
	await mkdir(cwd, { recursive: true });
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "test",
		ownerId: "test-owner",
		pid: process.pid,
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
	expect(initialized.agentCapabilities?.mcpCapabilities).toBeUndefined();
	const created = await bounded(agent.newSession({ cwd, mcpServers: [] }), "new session");
	expect(created.sessionId).toBe("owned-session");
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
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "busy" }));
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
	expect(await bounded(firstPrompt, "first prompt completion")).toEqual({ stopReason: "end_turn" });
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
	await Bun.sleep(20);
	expect(cancelledSettled).toBe(false);
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "busy" }));
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
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
	expect(await bounded(abortFailurePrompt, "abort-failure prompt completion")).toEqual({ stopReason: "end_turn" });
	abortAcknowledged = true;
	promptDeliveredWhileBusy = true;
	const steeringPrompt = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "steer me" }] });
	await waitFor(() => promptInputs.length === 4, "steering prompt delivery");
	promptDeliveredWhileBusy = false;
	// The host sent busy before the acknowledgement. The first valid idle after
	// that boundary must finish the steering prompt without a second busy frame.
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
	expect(await bounded(steeringPrompt, "steering prompt completion")).toEqual({ stopReason: "end_turn" });

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
		agent.newSession({ cwd, mcpServers: [{ type: "http", name: "unavailable", url: "http://127.0.0.1" }] as never }),
	).rejects.toThrow("MCP servers are unsupported under SDK-backed ACP.");

	const observerAbort = new AbortController();
	const observer = new AcpAgent({ signal: observerAbort.signal } as unknown as AgentSideConnection, { agentDir });
	await bounded(observer.listSessions({}), "observer list");
	const brokerRequestCount = brokerRequests.length;
	expect(await bounded(observer.closeSession({ sessionId: created.sessionId }), "observer close")).toEqual({});
	expect(await bounded(observer.deleteSession({ sessionId: created.sessionId }), "observer delete")).toEqual({});
	expect(brokerRequests).toHaveLength(brokerRequestCount);
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
					sessionUpdate: "session_info_update",
					_meta: {
						gjcTranscriptImageReplay: { available: false, reason: "historical_transcript_images_unavailable" },
					},
				}),
			}),
		]),
	);
	const loaderAbort = new AbortController();
	const loader = new AcpAgent(
		{
			sessionUpdate: async () => {},
			signal: loaderAbort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);
	const registrationsBeforeLiveAttach = providerRegistrations.length;
	const brokerRequestsBeforeLiveAttach = brokerRequests.length;
	await bounded(
		Promise.all([
			loader.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] }),
			loader.resumeSession({ sessionId: created.sessionId, cwd, mcpServers: [] }),
		]),
		"concurrent live attach",
	);
	const liveAttachRequests = brokerRequests.slice(brokerRequestsBeforeLiveAttach);
	expect(liveAttachRequests.filter(request => request.operation === "session.resume")).toHaveLength(0);
	expect(liveAttachRequests.filter(request => request.operation === "session.get_endpoint")).toEqual([
		expect.objectContaining({ input: { sessionId: created.sessionId, endpointGeneration: 1 } }),
	]);
	expect(providerRegistrations).toHaveLength(registrationsBeforeLiveAttach + 2);
	const racingAbort = new AbortController();
	const racingLoader = new AcpAgent(
		{ signal: racingAbort.signal, closed: Promise.withResolvers<void>().promise } as unknown as AgentSideConnection,
		{ agentDir },
	);
	await bounded(racingLoader.listSessions({ cwd }), "scope racing loader");
	holdEndpointResponse = true;
	const staleAttach = racingLoader.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] });
	await waitFor(() => releaseEndpointResponse !== undefined, "held endpoint response");
	await bounded(racingLoader.closeSession({ sessionId: created.sessionId }), "close racing loader");
	holdEndpointResponse = false;
	releaseEndpointResponse!();
	releaseEndpointResponse = undefined;
	await expect(bounded(staleAttach, "stale attachment rejection")).rejects.toThrow("closed while attaching");
	await expect(
		racingLoader.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "stale" }] }),
	).rejects.toThrow("Unsupported ACP session");
	racingAbort.abort();

	brokerSessions = [
		{ sessionId: created.sessionId, locator: { repo: cwd }, live: true, endpointGeneration: 1 },
		{ sessionId: created.sessionId, locator: { repo: cwd }, live: true, endpointGeneration: 2 },
	];
	const conflictAbort = new AbortController();
	const conflictingLoader = new AcpAgent(
		{ signal: conflictAbort.signal, closed: Promise.withResolvers<void>().promise } as unknown as AgentSideConnection,
		{ agentDir },
	);
	const brokerRequestsBeforeConflict = brokerRequests.length;
	await expect(conflictingLoader.resumeSession({ sessionId: created.sessionId, cwd, mcpServers: [] })).rejects.toThrow(
		"Broker returned duplicate session id",
	);
	expect(brokerRequests.slice(brokerRequestsBeforeConflict)).toEqual([
		expect.objectContaining({ operation: "session.list", input: { cwd } }),
	]);
	conflictAbort.abort();

	brokerSessions = [
		{ sessionId: created.sessionId, locator: { repo: path.join(directory, "other-workspace") }, live: true },
	];
	const scopeConflictAbort = new AbortController();
	const scopeConflictingLoader = new AcpAgent(
		{
			signal: scopeConflictAbort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);
	const brokerRequestsBeforeScopeConflict = brokerRequests.length;
	await expect(
		scopeConflictingLoader.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] }),
	).rejects.toThrow("Broker returned conflicting session scope");
	expect(brokerRequests.slice(brokerRequestsBeforeScopeConflict)).toEqual([
		expect.objectContaining({ operation: "session.list", input: { cwd } }),
	]);
	scopeConflictAbort.abort();
	brokerSessions = [{ sessionId: created.sessionId, locator: { repo: cwd }, live: true, endpointGeneration: 1 }];
	const deletingPrompt = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "delete me" }] });
	const deletingPromptError = deletingPrompt.then(
		() => undefined,
		(error: unknown) => error,
	);
	await waitFor(() => promptInputs.length === 5, "delete prompt delivery");
	await expect(
		bounded(agent.deleteSession({ sessionId: created.sessionId }), "owned session delete"),
	).resolves.toEqual({});
	expect(await bounded(deletingPromptError, "deleted prompt rejection")).toMatchObject({
		message: "ACP session was deleted.",
	});
	const closeRequests = brokerRequests.filter(request => request.operation === "session.close");
	expect(new Set(closeRequests.map(request => request.idempotencyKey))).toEqual(
		new Set([`acp:session.close:${created.sessionId}`]),
	);
	expect(brokerRequests).toContainEqual(
		expect.objectContaining({
			operation: "session.delete",
			idempotencyKey: `acp:session.delete:${created.sessionId}`,
		}),
	);
	brokerSessions = [{ sessionId: created.sessionId, locator: { repo: cwd }, live: true, endpointGeneration: 1 }];
	const frameFailureAbort = new AbortController();
	let rejectFrameUpdates = false;
	let frameBootstrapPublished = false;
	const frameFailureAgent = new AcpAgent(
		{
			sessionUpdate: async () => {
				if (rejectFrameUpdates) throw new Error("delivery broke");
				frameBootstrapPublished = true;
			},
			signal: frameFailureAbort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);
	await bounded(
		frameFailureAgent.resumeSession({ sessionId: created.sessionId, cwd, mcpServers: [] }),
		"frame failure attach",
	);
	await waitFor(() => frameBootstrapPublished, "frame failure bootstrap");
	const frameFailurePrompt = frameFailureAgent.prompt({
		sessionId: created.sessionId,
		prompt: [{ type: "text", text: "frame failure" }],
	});
	await waitFor(() => promptInputs.length === 6, "frame failure prompt delivery");
	rejectFrameUpdates = true;
	promptSocket!.send(
		JSON.stringify({
			type: "event",
			payload: { event: { type: "auto_compaction_start", reason: "manual", action: "manual" } },
		}),
	);
	await expect(bounded(frameFailurePrompt, "frame failure prompt rejection")).rejects.toMatchObject({
		code: "frame_processing_failed",
		message: "ACP session frame processing failed: delivery broke",
	});
	await expect(
		frameFailureAgent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "closed" }] }),
	).rejects.toThrow("Unsupported ACP session");
	frameFailureAbort.abort();
	loaderAbort.abort();
	controller.abort();
}, 30_000);
