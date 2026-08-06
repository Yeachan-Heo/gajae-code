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
	const sessionCloseLedger = new Map<string, Record<string, unknown>>();
	let makeNextSessionCloseUncertain = true;
	let rejectNextSessionClose = false;
	let holdPermissionModeSet = false;
	let releasePermissionModeSet: (() => void) | undefined;
	let activeModelPreset = "test-preset";
	let completeNextPromptBeforeAck = false;

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
					if (frame.operation === "session.create" || frame.operation === "session.resume") {
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
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							result: { page: { items, complete: true } },
						}),
					);
					return;
				}
				if (frame.operation === "permission_mode.set" && holdPermissionModeSet) {
					releasePermissionModeSet = () => {
						socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true, result: {} }));
					};
					return;
				}
				if (frame.type === "control_request") {
					if (typeof frame.operation === "string") controlOperations.push(frame.operation);
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
									commandId: "prompt-command",
									turnId: "prompt-turn",
									finalText: "fast",
									outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
								}),
							);
						}
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
	expect(initialized.agentCapabilities?.mcpCapabilities).toEqual({ http: true, sse: true });
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
		() => updates.some(update => update.update.sessionUpdate === "available_commands_update"),
		"ACP available commands",
	);
	const availableCommands = updates.find(update => update.update.sessionUpdate === "available_commands_update")
		?.update as { availableCommands?: Array<{ name: string }> };
	expect(availableCommands.availableCommands?.map(command => command.name)).toEqual(
		expect.arrayContaining(["skill:deep-interview", "skill:ralplan", "skill:ultragoal", "skill:team"]),
	);
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
			commandId: "prompt-command",
			turnId: "prompt-turn",
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
	await Bun.sleep(20);
	expect(cancelledSettled).toBe(false);
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "busy" }));
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
	promptSocket!.send(
		JSON.stringify({
			type: "agent_end",
			sessionId: created.sessionId,
			commandId: "prompt-command",
			turnId: "prompt-turn",
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
			commandId: "prompt-command",
			turnId: "prompt-turn",
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
			commandId: "prompt-command",
			turnId: "prompt-turn",
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
	expect(await bounded(observer.closeSession({ sessionId: created.sessionId }), "observer close")).toEqual({});
	expect(await bounded(observer.deleteSession({ sessionId: created.sessionId }), "observer delete")).toEqual({});
	expect(brokerRequests).toHaveLength(brokerRequestCount + 1);
	expect(brokerRequests.at(-1)).toMatchObject({
		operation: "session.delete",
		input: { sessionId: created.sessionId },
		idempotencyKey: `acp:session.delete:${created.sessionId}`,
	});
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
	expect(providerRegistrations).toHaveLength(registrationsBeforeLiveAttach + 1);
	const requestsBeforeRepeatedMcp = brokerRequests.length;
	await bounded(
		loader.resumeSession({
			sessionId: created.sessionId,
			cwd,
			mcpServers: [{ name: "Air", command: "/Applications/Air.app/Contents/bin/mcp-proxy", args: [], env: [] }],
		}),
		"attached session MCP replay",
	);
	expect(brokerRequests).toHaveLength(requestsBeforeRepeatedMcp);

	const liveMcpAbort = new AbortController();
	const liveMcpLoader = new AcpAgent(
		{
			sessionUpdate: async () => {},
			signal: liveMcpAbort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);
	const requestsBeforeLiveMcp = brokerRequests.length;
	await bounded(
		liveMcpLoader.loadSession({
			sessionId: created.sessionId,
			cwd,
			mcpServers: [{ name: "Air", command: "/Applications/Air.app/Contents/bin/mcp-proxy", args: [], env: [] }],
		}),
		"live session MCP replay",
	);
	expect(brokerRequests.slice(requestsBeforeLiveMcp)).toEqual([
		expect.objectContaining({ operation: "session.list", input: { cwd } }),
		expect.objectContaining({
			operation: "session.get_endpoint",
			input: { sessionId: created.sessionId, endpointGeneration: 1 },
		}),
	]);
	liveMcpAbort.abort();
	const firstGenerationCloseStart = brokerRequests.filter(request => request.operation === "session.close").length;
	const closeResults = await Promise.allSettled([
		loader.closeSession({ sessionId: created.sessionId }),
		loader.closeSession({ sessionId: created.sessionId }),
	]);
	expect(closeResults[0]).toEqual(closeResults[1]);
	expect(closeResults[0]).toMatchObject({ status: "rejected", reason: { code: "terminal_uncertain" } });
	const firstGenerationClose = brokerRequests
		.filter(request => request.operation === "session.close")
		.slice(firstGenerationCloseStart);
	expect(firstGenerationClose).toHaveLength(1);
	const firstGenerationKey = firstGenerationClose[0].idempotencyKey;

	holdPermissionModeSet = true;
	brokerSessions = [{ sessionId: created.sessionId, locator: { repo: cwd }, live: true, endpointGeneration: 2 }];
	const provisionalResume = loader.resumeSession({ sessionId: created.sessionId, cwd, mcpServers: [] });
	await waitFor(() => releasePermissionModeSet !== undefined, "held permission mode initialization");
	const provisionalCloseStart = brokerRequests.filter(request => request.operation === "session.close").length;
	const provisionalClose = loader.closeSession({ sessionId: created.sessionId });
	expect(brokerRequests.filter(request => request.operation === "session.close")).toHaveLength(provisionalCloseStart);
	holdPermissionModeSet = false;
	releasePermissionModeSet!();
	releasePermissionModeSet = undefined;
	await expect(bounded(provisionalResume, "provisional attachment cancellation")).rejects.toThrow(
		"closed while attaching",
	);
	await bounded(provisionalClose, "first generation close retry");
	const provisionalCloseRequests = brokerRequests
		.filter(request => request.operation === "session.close")
		.slice(provisionalCloseStart);
	expect(provisionalCloseRequests).toHaveLength(1);
	expect(provisionalCloseRequests[0].idempotencyKey).toBe(firstGenerationKey);

	await bounded(
		loader.resumeSession({ sessionId: created.sessionId, cwd, mcpServers: [] }),
		"second generation attach",
	);
	rejectNextSessionClose = true;
	const secondGenerationCloseStart = brokerRequests.filter(request => request.operation === "session.close").length;
	await expect(loader.closeSession({ sessionId: created.sessionId })).rejects.toMatchObject({
		code: "terminal_uncertain",
	});
	const secondGenerationClose = brokerRequests
		.filter(request => request.operation === "session.close")
		.slice(secondGenerationCloseStart);
	expect(secondGenerationClose).toHaveLength(1);
	const secondGenerationKey = secondGenerationClose[0].idempotencyKey;
	expect(secondGenerationKey).not.toBe(firstGenerationKey);

	await bounded(loader.listSessions({ cwd }), "re-establish close scope after definitive rejection");
	const definitiveRetryStart = brokerRequests.filter(request => request.operation === "session.close").length;
	await bounded(loader.closeSession({ sessionId: created.sessionId }), "definitive close retry");
	const definitiveRetry = brokerRequests
		.filter(request => request.operation === "session.close")
		.slice(definitiveRetryStart);
	expect(definitiveRetry).toHaveLength(1);
	expect(definitiveRetry[0].idempotencyKey).not.toBe(secondGenerationKey);
	brokerSessions = [{ sessionId: created.sessionId, locator: { repo: cwd }, live: true, endpointGeneration: 1 }];

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
	await waitFor(() => promptInputs.length === 6, "delete prompt delivery");
	await expect(
		bounded(agent.deleteSession({ sessionId: created.sessionId }), "owned session delete"),
	).resolves.toEqual({});
	expect(await bounded(deletingPromptError, "deleted prompt rejection")).toMatchObject({
		message: "ACP session was deleted.",
	});
	const closeRequests = brokerRequests.filter(request => request.operation === "session.close");
	expect(
		closeRequests.every(request => typeof request.idempotencyKey === "string" && request.idempotencyKey.length > 0),
	).toBe(true);
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
	await waitFor(() => promptInputs.length === 7, "frame failure prompt delivery");
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
	).rejects.toThrow("Unknown session, not found");
	frameFailureAbort.abort();

	brokerSessions = [];
	const followupAbort = new AbortController();
	const followupAgent = new AcpAgent(
		{
			sessionUpdate: async () => {},
			signal: followupAbort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);
	await bounded(
		followupAgent.loadSession({
			sessionId: created.sessionId,
			cwd,
			mcpServers: [
				{ name: "Air", command: "/Applications/Air.app/Contents/bin/mcp-proxy", args: ["--stdio"], env: [] },
			],
		}),
		"offline session reload with MCP servers",
	);
	expect(lifecycleInputs.at(-1)).toEqual(
		expect.objectContaining({
			cwd,
			sessionId: created.sessionId,
			readinessTimeoutMs: 30_500,
			mcpServers: [{ name: "Air", command: "/Applications/Air.app/Contents/bin/mcp-proxy", args: ["--stdio"] }],
		}),
	);
	expect(
		await followupAgent.extMethod("session/set_model", {
			sessionId: created.sessionId,
			modelId: "openai/gpt",
		}),
	).toEqual({});
	expect(controlOperations.at(-1)).toBe("model.set");
	const followupPrompt = followupAgent.prompt({
		sessionId: created.sessionId,
		prompt: [{ type: "text", text: "follow up" }],
	});
	await waitFor(() => promptInputs.length === 8, "restored-session follow-up prompt delivery");
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "busy" }));
	promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
	promptSocket!.send(
		JSON.stringify({
			type: "agent_end",
			sessionId: created.sessionId,
			commandId: "prompt-command",
			turnId: "prompt-turn",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		}),
	);
	expect(await bounded(followupPrompt, "restored-session follow-up prompt completion")).toEqual({
		stopReason: "end_turn",
	});
	followupAbort.abort();
	loaderAbort.abort();
	controller.abort();
}, 30_000);
