import { expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection, PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { TempDir } from "@gajae-code/utils";

type TestSocket = { send(message: string): void };
type StoppedReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
type FailedCode = "prompt_failed" | "prompt_deadline_exceeded";

type Fixture = {
	agent: AcpAgent;
	sessionId: string;
	updates: SessionNotification[];
	promptDelivered: Promise<void>;
	sendStopped(reason: StoppedReason): void;
	sendFailed(code: FailedCode): void;
	sendAssistantMessage(text: string): void;
	sendIdle(): void;
	dispose(): void;
};

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(2_000).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function createFixture(options: { terminalBeforeAcknowledgement?: boolean } = {}): Promise<Fixture> {
	const tempDir = TempDir.createSync("@sdk-acp-prompt-terminal-");
	const agentDir = path.join(tempDir.path(), "agent");
	const cwd = path.join(tempDir.path(), "workspace");
	const token = "sdk-acp-prompt-terminal-token";
	const sessionId = "prompt-terminal-session";
	const commandId = "prompt-terminal-command";
	const turnId = "prompt-terminal-turn";
	const updates: SessionNotification[] = [];
	const delivered = Promise.withResolvers<void>();
	const abort = new AbortController();
	let promptSocket: TestSocket | undefined;
	let server!: ReturnType<typeof Bun.serve>;

	const send = (frame: Record<string, unknown>): void => {
		if (!promptSocket) throw new Error("Expected prompt socket");
		promptSocket.send(JSON.stringify(frame));
	};
	const sendStopped = (reason: StoppedReason): void => {
		send({
			type: "agent_end",
			sessionId,
			commandId,
			turnId,
			outcome: { kind: "stopped", reason, provenance: reason === "cancelled" ? "client_cancel" : "agent" },
		});
	};
	const sendFailed = (code: FailedCode): void => {
		send({
			type: "agent_failed",
			sessionId,
			commandId,
			turnId,
			outcome: {
				kind: "failed",
				code,
				message: `${code} from fixture`,
				provenance: code === "prompt_failed" ? "agent_failed" : "deadline",
			},
		});
	};
	const sendAssistantMessage = (text: string): void => {
		send({
			type: "event",
			payload: {
				event_type: "message_end",
				event: {
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text }] },
				},
			},
		});
	};
	const sendIdle = (): void => send({ type: "activity", sessionId, state: "idle" });

	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "hello", connectionId: "sdk-acp-prompt-terminal" }));
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
							? { sessionId, endpoint: { url: `ws://127.0.0.1:${server.port}`, token } }
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
						frame.query === "runtime.capabilities"
							? { promptTerminalOutcomeVersion: 1 }
							: frame.query === "context.get"
								? { usage: { tokens: 0, contextWindow: 200_000, percent: 0, source: "test" } }
								: { page: { items } };
					socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result }));
					return;
				}
				if (frame.type !== "control_request") return;
				if (frame.operation === "turn.prompt") {
					promptSocket = socket;
					delivered.resolve();
					if (options.terminalBeforeAcknowledgement) sendStopped("end_turn");
				}
				socket.send(
					JSON.stringify({
						type: "control_response",
						id: frame.id,
						ok: true,
						result: frame.operation === "turn.prompt" ? { commandId, turnId, accepted: true } : {},
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
	const agent = new AcpAgent(
		{
			sessionUpdate: async (update: SessionNotification) => updates.push(update),
			signal: abort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);
	const created = await bounded(agent.newSession({ cwd, mcpServers: [] }), "new session");

	return {
		agent,
		sessionId: created.sessionId,
		updates,
		promptDelivered: delivered.promise,
		sendStopped,
		sendFailed,
		sendAssistantMessage,
		sendIdle,
		dispose: () => {
			abort.abort();
			server.stop(true);
			tempDir.removeSync();
		},
	};
}

function prompt(fixture: Fixture, text: string): Promise<{ stopReason: StoppedReason }> {
	return fixture.agent.prompt({
		sessionId: fixture.sessionId,
		messageId: "00000000-0000-4000-8000-000000000001",
		prompt: [{ type: "text", text }],
	} as PromptRequest) as Promise<{ stopReason: StoppedReason }>;
}

for (const reason of ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const) {
	test(`ACP prompt preserves the ${reason} terminal stop reason`, async () => {
		const fixture = await createFixture();
		try {
			const pending = prompt(fixture, reason);
			await bounded(fixture.promptDelivered, "prompt delivery");
			fixture.sendStopped(reason);
			expect(await bounded(pending, `${reason} prompt completion`)).toEqual({ stopReason: reason });
		} finally {
			fixture.dispose();
		}
	});
}

test("ACP prompt rejects prompt_failed terminal outcomes with their code", async () => {
	const fixture = await createFixture();
	try {
		const pending = prompt(fixture, "failed prompt");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendFailed("prompt_failed");
		await expect(bounded(pending, "prompt failure")).rejects.toMatchObject({ code: "prompt_failed" });
	} finally {
		fixture.dispose();
	}
});

test("ACP prompt rejects prompt_deadline_exceeded terminal outcomes with their code", async () => {
	const fixture = await createFixture();
	try {
		const pending = prompt(fixture, "deadline exceeded");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendFailed("prompt_deadline_exceeded");
		await expect(bounded(pending, "deadline failure")).rejects.toMatchObject({ code: "prompt_deadline_exceeded" });
	} finally {
		fixture.dispose();
	}
});

test("ACP prompt settles exactly once when terminal arrives before acknowledgement", async () => {
	const fixture = await createFixture({ terminalBeforeAcknowledgement: true });
	try {
		let settleCount = 0;
		const pending = prompt(fixture, "fast terminal").then(result => {
			settleCount++;
			return result;
		});
		expect(await bounded(pending, "pre-acknowledgement completion")).toEqual({ stopReason: "end_turn" });
		expect(settleCount).toBe(1);
	} finally {
		fixture.dispose();
	}
});

test("ACP delivers assistant updates before terminal settlement and drops later updates", async () => {
	const fixture = await createFixture();
	try {
		const order: string[] = [];
		const pending = prompt(fixture, "ordered updates").then(result => {
			order.push("resolved");
			return result;
		});
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendAssistantMessage("first");
		fixture.sendAssistantMessage("second");
		await waitFor(
			() => fixture.updates.filter(update => update.update.sessionUpdate === "agent_message_chunk").length === 2,
			"assistant updates",
		);
		order.push(
			...fixture.updates.filter(update => update.update.sessionUpdate === "agent_message_chunk").map(() => "update"),
		);
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "terminal completion")).toEqual({ stopReason: "end_turn" });
		expect(order).toEqual(["update", "update", "resolved"]);
		fixture.sendAssistantMessage("after terminal");
		await Bun.sleep(30);
		expect(fixture.updates.filter(update => update.update.sessionUpdate === "agent_message_chunk")).toHaveLength(2);
	} finally {
		fixture.dispose();
	}
});

test("ACP activity idle alone does not settle a prompt", async () => {
	const fixture = await createFixture();
	try {
		let settled = false;
		const pending = prompt(fixture, "idle does not settle").then(result => {
			settled = true;
			return result;
		});
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendIdle();
		await Bun.sleep(30);
		expect(settled).toBe(false);
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "terminal completion after idle")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});
