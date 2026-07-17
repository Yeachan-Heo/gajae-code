import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection, PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpAgent } from "@gajae-code/coding-agent/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "@gajae-code/coding-agent/sdk/broker/discovery";
import { TempDir } from "@gajae-code/utils";

type TestSocket = { send(message: string): void };

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(2_000).then(() => {
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
		let promptSocket: TestSocket | undefined;
		let abortAcknowledged = true;

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
						const result =
							frame.operation === "session.create"
								? {
										sessionId: "cancel-session",
										endpoint: { url: `ws://127.0.0.1:${server!.port}`, token },
									}
								: {};
						socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result }));
						return;
					}
					if (frame.type === "query_request") {
						const items =
							frame.query === "config.list/get"
								? [{ mode: "default", model: "openai/gpt", thinking: "medium" }]
								: frame.query === "models.list/current"
									? [{ provider: "openai", id: "gpt", name: "GPT" }]
									: [];
						const result =
							frame.query === "context.get"
								? { usage: { tokens: 0, contextWindow: 200_000, percent: 0, source: "test" } }
								: { page: { items } };
						socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result }));
						return;
					}
					if (frame.type !== "control_request") return;
					if (frame.operation === "turn.prompt") {
						promptSocket = socket;
						promptWaiters.shift()?.resolve();
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
				},
			},
		});
		const port = server.port;
		if (port === undefined) throw new Error("Expected ACP fixture server port");

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
		promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "busy" }));
		promptSocket!.send(JSON.stringify({ type: "activity", sessionId: created.sessionId, state: "idle" }));
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
