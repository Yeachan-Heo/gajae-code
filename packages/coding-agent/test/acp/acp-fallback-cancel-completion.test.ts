import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import * as path from "node:path";
import {
	type AgentSideConnection,
	type Client,
	ClientSideConnection,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	ndJsonStream,
	type PromptRequest,
	RequestError,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { AcpAgent, acpRequestFailure } from "@gajae-code/coding-agent/modes/acp/acp-agent";
import { createAcpConnection } from "@gajae-code/coding-agent/modes/acp/acp-mode";
import { TempDir } from "@gajae-code/utils";
import { AcpSdkAdapterError } from "../../src/sdk/acp";
import { writeBrokerDiscovery } from "../../src/sdk/broker/discovery";
import { DEFAULT_READINESS_TIMEOUT_MS, MAX_READINESS_TIMEOUT_MS } from "../../src/sdk/broker/startup-budget";
import {
	type ExactSessionAuthorityFixture,
	type ExactSessionAuthorityOptions,
	prepareExactSessionAuthority,
	publishExactSessionAuthority,
} from "../helpers/sdk-exact-session-authority";

setDefaultTimeout(60_000);

type TestSocket = { send(message: string): void };
class TestClient implements Client {
	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(_params: SessionNotification): Promise<void> {}

	async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
		return { terminalId: "test-terminal" };
	}
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(45_000).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

describe("ACP production cancellation completion", () => {
	let tempDir: TempDir;
	let connectionAbort: AbortController;
	let server: Bun.Server<undefined> | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@acp-cancel-completion-");
		connectionAbort = new AbortController();
	});

	afterEach(() => {
		connectionAbort.abort();
		server?.stop(true);
		tempDir.removeSync();
	});

	it("settles acknowledged and rejected cancellation exactly once without failed assistant chunks", async () => {
		const agentDir = path.join(tempDir.path(), "agent");
		const cwd = path.join(tempDir.path(), "workspace");
		const token = "acp-cancel-token";
		const updates: SessionNotification[] = [];
		const promptWaiters: Array<PromiseWithResolvers<void>> = [];
		const controlOperations: string[] = [];
		let promptSocket: TestSocket | undefined;
		let promptCount = 0;
		let abortAcknowledged = true;
		let createInput: Record<string, unknown> | undefined;

		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (new URL(request.url).searchParams.get("token") !== token)
					return new Response("Unauthorized", { status: 401 });
				if (!server.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "hello", connectionId: "acp-cancel-completion" }));
				},
				message(socket, raw) {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					if (frame.type === "register_provider") {
						socket.send(
							JSON.stringify({ type: "register_provider_result", id: frame.id, ok: true, leaseId: "lease" }),
						);
						return;
					}
					if (frame.type === "broker_request") {
						if (frame.operation === "session.create") {
							createInput = frame.input as Record<string, unknown>;
							socket.send(
								JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: authority }),
							);
							setTimeout(() => void publishExactSessionAuthority(authorityOptions, authority), 10);
							return;
						}
						const result = {};
						socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result }));
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
						const items =
							frame.query === "config.list/get"
								? [{ mode: "default", model: "openai/gpt", thinking: "medium" }]
								: frame.query === "models.list/current"
									? [{ provider: "openai", id: "gpt", name: "GPT" }]
									: frame.query === "providers.list/active"
										? [{ provider: "openai", connectionKind: "credential" }]
										: [];
						const result =
							frame.query === "context.get"
								? { usage: { tokens: 0, contextWindow: 200_000, percent: 0, source: "test" } }
								: { page: { items, complete: true } };
						socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result }));
						return;
					}
					if (frame.type !== "control_request") return;
					if (typeof frame.operation === "string") controlOperations.push(frame.operation);
					if (frame.operation === "turn.prompt") {
						promptSocket = socket;
						promptCount += 1;
						promptWaiters.shift()?.resolve();
					}
					socket.send(
						JSON.stringify({
							type: "control_response",
							id: frame.id,
							ok: true,
							result:
								frame.operation === "turn.prompt"
									? {
											commandId: `prompt-command-${promptCount}`,
											turnId: `prompt-turn-${promptCount}`,
											accepted: true,
										}
									: frame.operation === "turn.abort"
										? abortAcknowledged
											? (() => {
													const scope =
														(frame.input as { scope?: string })?.scope === "owned" ? "owned" : "turn";
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
				},
			},
		});
		const port = server.port;
		if (port === undefined) throw new Error("Expected ACP fixture server port");
		const authorityOptions: ExactSessionAuthorityOptions = {
			agentDir,
			cwd,
			sessionId: "cancel-session",
			url: `ws://127.0.0.1:${port}`,
			token,
		};
		const authority: ExactSessionAuthorityFixture = await prepareExactSessionAuthority(authorityOptions);

		await writeBrokerDiscovery(agentDir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "test-owner",
			pid: process.pid,
			host: "127.0.0.1",
			port,
			url: `ws://127.0.0.1:${port}`,
			token,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});

		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				updates.push(notification);
			},
			signal: connectionAbort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, { agentDir });
		const created = await bounded(acp.newSession({ cwd, mcpServers: [] }), "new session");
		// A launch that declares no MCP servers still pays the host's cold start, so it must
		// ask for more than the broker's bare default; leaving it there made an MCP-less ACP
		// client the only caller whose `session/new` died on a concurrent host start.
		const requestedReadiness = createInput?.readinessTimeoutMs;
		expect(typeof requestedReadiness).toBe("number");
		expect(requestedReadiness as number).toBeGreaterThan(DEFAULT_READINESS_TIMEOUT_MS);
		expect(requestedReadiness as number).toBeLessThanOrEqual(MAX_READINESS_TIMEOUT_MS);
		expect(createInput).not.toHaveProperty("mcpServers");
		expect(created.configOptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "model",
					name: "Model",
					currentValue: "openai/gpt",
					options: [{ value: "openai/gpt", name: "GPT" }],
				}),
			]),
		);
		await bounded(
			acp.setSessionConfigOption({
				sessionId: created.sessionId,
				configId: "model",
				value: "openai/gpt",
			}),
			"set model",
		);
		expect(controlOperations).toContain("model.set");
		expect(controlOperations).not.toContain("model.profile.set");

		const firstDelivered = Promise.withResolvers<void>();
		promptWaiters.push(firstDelivered);
		let firstResolutions = 0;
		const firstPrompt = acp
			.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-0000000000fc",
				prompt: [{ type: "text", text: "cancel acknowledged" }],
			} as PromptRequest)
			.then(response => {
				firstResolutions++;
				return response;
			});
		await bounded(firstDelivered.promise, "first prompt delivery");
		await bounded(acp.cancel({ sessionId: created.sessionId }), "first cancel acknowledgement");
		// Activity is advisory only; the authoritative normalized terminal settles the prompt.
		promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "busy" }));
		promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
		promptSocket!.send(
			JSON.stringify({
				type: "agent_end",
				sessionId: created.sessionId,
				commandId: "prompt-command-1",
				turnId: "prompt-turn-1",
				outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
			}),
		);
		expect(await bounded(firstPrompt, "first prompt completion")).toEqual({ stopReason: "cancelled" });
		expect(firstResolutions).toBe(1);

		const secondDelivered = Promise.withResolvers<void>();
		promptWaiters.push(secondDelivered);
		let secondResolutions = 0;
		const secondPrompt = acp
			.prompt({
				sessionId: created.sessionId,
				messageId: "00000000-0000-4000-8000-0000000000fd",
				prompt: [{ type: "text", text: "cancel rejected" }],
			} as PromptRequest)
			.then(response => {
				secondResolutions++;
				return response;
			});
		await bounded(secondDelivered.promise, "second prompt delivery");
		abortAcknowledged = false;
		await expect(
			bounded(acp.cancel({ sessionId: created.sessionId }), "second cancel acknowledgement"),
		).rejects.toThrow("SDK did not acknowledge cancellation");
		promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "busy" }));
		promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
		promptSocket!.send(
			JSON.stringify({
				type: "agent_end",
				sessionId: created.sessionId,
				commandId: "prompt-command-2",
				turnId: "prompt-turn-2",
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			}),
		);
		expect(await bounded(secondPrompt, "second prompt completion")).toEqual({ stopReason: "end_turn" });
		expect(secondResolutions).toBe(1);

		expect(
			updates.filter(update => {
				const payload = update.update as {
					sessionUpdate?: string;
					content?: Array<{ content?: { text?: string } }>;
				};
				return (
					payload.sessionUpdate === "agent_message_chunk" &&
					payload.content?.some(item => /failed/i.test(item.content?.text ?? ""))
				);
			}),
		).toHaveLength(0);
	});
});

describe("ACP request failure codes", () => {
	let connectionAbort: AbortController;

	beforeEach(() => {
		connectionAbort = new AbortController();
	});

	afterEach(() => {
		connectionAbort.abort();
	});

	function agent(): AcpAgent {
		return new AcpAgent({ signal: connectionAbort.signal } as unknown as AgentSideConnection, {
			agentDir: "/tmp",
		});
	}

	it("rejects an unknown ext method with method-not-found instead of a successful result", async () => {
		const error = await agent()
			.extMethod("does/not-exist", {})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RequestError);
		expect((error as RequestError).code).toBe(-32601);
	});
	it("maps adapter error codes and preserves their discriminators", () => {
		const cases = [
			{ code: "authentication_failed", expectedCode: -32000 },
			{ code: "invalid_input", expectedCode: -32602 },
			{ code: "unsupported", expectedCode: -32602 },
			{ code: "unsupported_content", expectedCode: -32602 },
			{ code: "conflict", expectedCode: -32603 },
		];

		for (const { code, expectedCode } of cases) {
			const failure = acpRequestFailure(new AcpSdkAdapterError(code, `failure: ${code}`));

			expect(failure).toBeInstanceOf(RequestError);
			expect(failure).toMatchObject({
				code: expectedCode,
				data: { code },
			});
		}

		const requestError = RequestError.invalidParams({ code: "already_request_error" }, "already wrapped");
		expect(acpRequestFailure(requestError)).toBe(requestError);
		expect(requestError.code).toBe(-32602);
	});

	// The proxy has two arms: a synchronous `try/catch` and a `.catch` on a returned
	// Promise. Every real agent method is `async`, so the Promise arm is the production
	// path — a sync throw would leave it unproven and a deleted `.catch` would still
	// look green here.
	it("maps rejected connection-boundary promises through the request-error proxy", async () => {
		const initialize = spyOn(AcpAgent.prototype, "initialize").mockImplementation(async () => {
			throw new AcpSdkAdapterError("authentication_failed", "authenticate first");
		});
		const clientToAgent = new TransformStream();
		const agentToClient = new TransformStream();
		const clientConnection = new ClientSideConnection(
			() => new TestClient(),
			ndJsonStream(clientToAgent.writable, agentToClient.readable),
		);
		const serverConnection = createAcpConnection(ndJsonStream(agentToClient.writable, clientToAgent.readable));

		try {
			const error = await clientConnection
				.initialize({ protocolVersion: 1, clientCapabilities: {} })
				.catch((reason: unknown) => reason);

			expect(error).toBeInstanceOf(RequestError);
			expect(error).toMatchObject({
				code: -32000,
				data: { code: "authentication_failed" },
			});
		} finally {
			initialize.mockRestore();
			const closeConnection = (connection: unknown): void => {
				(connection as { connection: { close(error?: Error): void } }).connection.close();
			};
			closeConnection(clientConnection);
			closeConnection(serverConnection);
			await Promise.allSettled([clientConnection.closed, serverConnection.closed]);
		}
	});

	// A second code over the same async arm, so the wire proof is not a single-value
	// coincidence: `invalid_input` must reach the client as `-32602`, not `-32000`.
	it("maps a rejected invalid-input promise to invalid-params on the wire", async () => {
		const initialize = spyOn(AcpAgent.prototype, "initialize").mockRejectedValue(
			new AcpSdkAdapterError("invalid_input", "protocolVersion is required"),
		);
		const clientToAgent = new TransformStream();
		const agentToClient = new TransformStream();
		const clientConnection = new ClientSideConnection(
			() => new TestClient(),
			ndJsonStream(clientToAgent.writable, agentToClient.readable),
		);
		const serverConnection = createAcpConnection(ndJsonStream(agentToClient.writable, clientToAgent.readable));

		try {
			const error = await clientConnection
				.initialize({ protocolVersion: 1, clientCapabilities: {} })
				.catch((reason: unknown) => reason);

			expect(error).toBeInstanceOf(RequestError);
			expect(error).toMatchObject({ code: -32602, data: { code: "invalid_input" } });
		} finally {
			initialize.mockRestore();
			const closeConnection = (connection: unknown): void => {
				(connection as { connection: { close(error?: Error): void } }).connection.close();
			};
			closeConnection(clientConnection);
			closeConnection(serverConnection);
			await Promise.allSettled([clientConnection.closed, serverConnection.closed]);
		}
	});
});
