import { expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection, PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { TempDir } from "@gajae-code/utils";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { ACP_PROMPT_INACTIVITY_TIMEOUT_MS, ACP_PROMPT_TOOL_ACTIVITY_TIMEOUT_MS } from "../src/sdk/prompt-watchdog";

type TestSocket = { send(message: string): void };
type StoppedReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/**
 * Virtual timer source for the prompt watchdog. Every watchdog assertion moves this
 * clock instead of sleeping, so a 60min tool-activity bound costs no wall time.
 */
class VirtualClock {
	#now = 0;
	#nextId = 1;
	readonly #timers = new Map<number, { at: number; handler: () => void }>();

	now(): number {
		return this.#now;
	}

	schedule(handler: () => void, delayMs: number): () => void {
		const id = this.#nextId++;
		this.#timers.set(id, { at: this.#now + delayMs, handler });
		return () => {
			this.#timers.delete(id);
		};
	}

	get pending(): number {
		return this.#timers.size;
	}

	advance(ms: number): void {
		const target = this.#now + ms;
		for (;;) {
			let dueId: number | undefined;
			let dueAt = Number.POSITIVE_INFINITY;
			for (const [id, timer] of this.#timers)
				if (timer.at <= target && timer.at < dueAt) {
					dueId = id;
					dueAt = timer.at;
				}
			if (dueId === undefined) break;
			const due = this.#timers.get(dueId);
			this.#timers.delete(dueId);
			this.#now = dueAt;
			due?.handler();
		}
		this.#now = target;
	}
}

type Fixture = {
	agent: AcpAgent;
	sessionId: string;
	updates: SessionNotification[];
	clock: VirtualClock;
	/** Correlation the fixture host acknowledged for the turn currently in flight. */
	correlation(): { commandId: string; turnId: string };
	sendAssistantText(text: string): void;
	sendStopped(reason: StoppedReason): void;
	sendToolStart(toolCallId: string): void;
	sendToolEnd(toolCallId: string): void;
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

function workingUpdates(updates: SessionNotification[]): number {
	return updates.filter(
		update =>
			update.update.sessionUpdate === "session_info_update" &&
			(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
	).length;
}

function idleUpdates(updates: SessionNotification[]): number {
	return updates.filter(
		update =>
			update.update.sessionUpdate === "session_info_update" &&
			(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
	).length;
}

function textChunks(updates: SessionNotification[]): number {
	return updates.filter(update => update.update.sessionUpdate === "agent_message_chunk").length;
}

/** ACP `tool_call` updates, i.e. tool executions the host reported as started. */
function toolCalls(updates: SessionNotification[]): number {
	return updates.filter(update => update.update.sessionUpdate === "tool_call").length;
}

/** ACP `tool_call_update` updates, i.e. tool executions the host reported as finished. */
function toolCallUpdates(updates: SessionNotification[]): number {
	return updates.filter(update => update.update.sessionUpdate === "tool_call_update").length;
}

async function createFixture(): Promise<Fixture> {
	const tempDir = TempDir.createSync("@acp-prompt-watchdog-");
	const agentDir = path.join(tempDir.path(), "agent");
	const cwd = path.join(tempDir.path(), "workspace");
	const token = "acp-prompt-watchdog-token";
	const sessionId = "prompt-watchdog-session";
	const updates: SessionNotification[] = [];
	const clock = new VirtualClock();
	const abort = new AbortController();
	let turnCount = 0;
	let commandId = "";
	let turnId = "";
	let promptSocket: TestSocket | undefined;
	let server!: ReturnType<typeof Bun.serve>;

	const send = (frame: Record<string, unknown>): void => {
		if (!promptSocket) throw new Error("Expected a prompt socket");
		promptSocket.send(JSON.stringify(frame));
	};
	const sendAssistantText = (text: string): void => {
		send({
			type: "event",
			commandId,
			turnId,
			payload: {
				event_type: "message_end",
				event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } },
			},
		});
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
	const sendToolStart = (toolCallId: string): void => {
		send({
			type: "event",
			commandId,
			turnId,
			payload: {
				event_type: "tool_execution_start",
				event: {
					type: "tool_execution_start",
					toolCallId,
					toolName: "bash",
					args: { command: "sleep 100000" },
				},
			},
		});
	};
	const sendToolEnd = (toolCallId: string): void => {
		send({
			type: "event",
			commandId,
			turnId,
			payload: {
				event_type: "tool_execution_end",
				event: {
					type: "tool_execution_end",
					toolCallId,
					toolName: "bash",
					isError: false,
					result: { content: [{ type: "text", text: "done" }] },
				},
			},
		});
	};

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
				socket.send(JSON.stringify({ type: "hello", connectionId: "acp-prompt-watchdog" }));
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
								: frame.query === "providers.list/active"
									? [{ providerId: "openai", connectionKind: "credential" }]
									: [];
					const result =
						frame.query === "runtime.capabilities"
							? { promptTerminalOutcomeVersion: 1 }
							: frame.query === "context.get"
								? { usage: { tokens: 0, contextWindow: 200_000, percent: 0, source: "test" } }
								: { page: { items, complete: true } };
					socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result }));
					return;
				}
				if (frame.type !== "control_request") return;
				if (frame.operation === "turn.prompt") {
					promptSocket = socket;
					turnCount += 1;
					commandId = `watchdog-command-${turnCount}`;
					turnId = `watchdog-turn-${turnCount}`;
				}
				socket.send(
					JSON.stringify({
						type: "control_response",
						id: frame.id,
						ok: true,
						result:
							frame.operation === "turn.prompt"
								? { commandId, turnId, accepted: true }
								: frame.operation === "turn.abort"
									? { aborted: true }
									: {},
					}),
				);
				// Frames are FIFO on the socket, so the client records the acknowledged
				// correlation before this start frame reaches the session record.
				if (frame.operation === "turn.prompt")
					socket.send(JSON.stringify({ type: "agent_start", sessionId, commandId, turnId }));
			},
		},
	});
	const port = server.port;
	if (port === undefined) throw new Error("Expected an ACP fixture server port");
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
		{ agentDir, promptWatchdogClock: clock },
	);
	const created = await bounded(agent.newSession({ cwd, mcpServers: [] }), "new session");
	await waitFor(() => idleUpdates(updates) > 0, "bootstrap update");

	return {
		agent,
		sessionId: created.sessionId,
		updates,
		clock,
		correlation: () => ({ commandId, turnId }),
		sendAssistantText,
		sendStopped,
		sendToolStart,
		sendToolEnd,
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

/**
 * Runs a turn up to its acknowledged, started state; the host then goes silent.
 * The pending prompt is returned wrapped, because an async function would await it.
 */
async function startTurn(fixture: Fixture): Promise<{ pending: Promise<{ stopReason: StoppedReason }> }> {
	const started = workingUpdates(fixture.updates);
	const pending = prompt(fixture, "work");
	await waitFor(() => workingUpdates(fixture.updates) > started, "turn start");
	return { pending };
}

test("a prompt that goes silent past the inactivity bound is rejected instead of hanging", async () => {
	const fixture = await createFixture();
	try {
		const { pending } = await startTurn(fixture);
		const { commandId, turnId } = fixture.correlation();
		const idleBefore = idleUpdates(fixture.updates);

		fixture.clock.advance(ACP_PROMPT_INACTIVITY_TIMEOUT_MS + 1);

		const error = await bounded(
			pending.then(
				() => undefined,
				(reason: unknown) => reason,
			),
			"watchdog rejection",
		);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("ACP prompt was abandoned");
		expect(message).toContain(`${Math.round(ACP_PROMPT_INACTIVITY_TIMEOUT_MS / 1_000)}s of silence`);
		expect(message).toContain("the SDK session host stopped producing frames");
		expect(message).toContain('"agent_start"');
		expect(message).toContain(`commandId=${commandId}`);
		expect(message).toContain(`turnId=${turnId}`);
		// The client's running phase is released, so the composer stops spinning.
		expect(idleUpdates(fixture.updates)).toBe(idleBefore + 1);
	} finally {
		fixture.dispose();
	}
});

test("a prompt refreshed by frames just under the bound is never rejected", async () => {
	const fixture = await createFixture();
	try {
		const { pending } = await startTurn(fixture);
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		for (let round = 0; round < 5; round++) {
			const chunks = textChunks(fixture.updates);
			fixture.clock.advance(ACP_PROMPT_INACTIVITY_TIMEOUT_MS - 1);
			expect(settled).toBe(false);
			fixture.sendAssistantText(`slow chunk ${round}`);
			await waitFor(() => textChunks(fixture.updates) > chunks, `assistant chunk ${round}`);
			// The frame re-armed a live watchdog; the bound is per-gap, not per-turn.
			expect(fixture.clock.pending).toBe(1);
		}

		// Total elapsed silence is five times the bound, but no single gap ever reached it.
		expect(settled).toBe(false);
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "prompt completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("a session accepts a new prompt after a watchdog rejection", async () => {
	const fixture = await createFixture();
	try {
		const { pending: abandoned } = await startTurn(fixture);
		const firstCommandId = fixture.correlation().commandId;
		fixture.clock.advance(ACP_PROMPT_INACTIVITY_TIMEOUT_MS + 1);
		await bounded(
			abandoned.then(
				() => undefined,
				() => undefined,
			),
			"watchdog rejection",
		);

		const { pending: recovered } = await startTurn(fixture);
		expect(fixture.correlation().commandId).not.toBe(firstCommandId);
		fixture.sendStopped("end_turn");
		expect(await bounded(recovered, "recovered prompt completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("a normal agent_end settles the prompt once and disarms the watchdog", async () => {
	const fixture = await createFixture();
	try {
		const { pending } = await startTurn(fixture);
		// The turn is being watched, so the disarm assertion below cannot pass vacuously.
		expect(fixture.clock.pending).toBe(1);
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "prompt completion")).toEqual({ stopReason: "end_turn" });

		const updatesAfterSettle = fixture.updates.length;
		const idleAfterSettle = idleUpdates(fixture.updates);
		expect(fixture.clock.pending).toBe(0);

		fixture.clock.advance(ACP_PROMPT_INACTIVITY_TIMEOUT_MS * 3);
		await Bun.sleep(10);

		// No second settlement: no rejection, no extra phase publication.
		expect(fixture.updates.length).toBe(updatesAfterSettle);
		expect(idleUpdates(fixture.updates)).toBe(idleAfterSettle);
		expect(await bounded(pending, "settled prompt")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("the watchdog bounds stay pinned to their derivation", () => {
	// Slowest tool default (`bash`, 300s) + one SDK reconnect budget (2 x 20s heartbeat).
	expect(ACP_PROMPT_INACTIVITY_TIMEOUT_MS).toBe(340_000);
	// Slowest per-tool ceiling (`bash`/`ssh`, 3600s) + the same reconnect budget.
	expect(ACP_PROMPT_TOOL_ACTIVITY_TIMEOUT_MS).toBe(3_640_000);
	// A frame-free gap with nothing running must stay operationally useful; the wide
	// bound is only ever reachable while a tool call is observably in flight.
	expect(ACP_PROMPT_INACTIVITY_TIMEOUT_MS).toBeLessThan(10 * 60_000);
	expect(ACP_PROMPT_TOOL_ACTIVITY_TIMEOUT_MS).toBeGreaterThan(3_600_000);
});

test("a tool call running past the idle bound is protected while it runs, not after it ends", async () => {
	const fixture = await createFixture();
	try {
		const { pending } = await startTurn(fixture);
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		const started = toolCalls(fixture.updates);
		fixture.sendToolStart("watchdog-tool-1");
		await waitFor(() => toolCalls(fixture.updates) > started, "tool call start");

		// A `bash` that blocks far past the idle bound is evidenced as running, so the
		// silence it produces is legitimate and must not be rejected.
		fixture.clock.advance(ACP_PROMPT_TOOL_ACTIVITY_TIMEOUT_MS - 1);
		await Bun.sleep(10);
		expect(settled).toBe(false);

		const ended = toolCallUpdates(fixture.updates);
		fixture.sendToolEnd("watchdog-tool-1");
		await waitFor(() => toolCallUpdates(fixture.updates) > ended, "tool call end");

		// Evidence is gone: the next frame-free gap is bounded by the idle bound again.
		fixture.clock.advance(ACP_PROMPT_INACTIVITY_TIMEOUT_MS + 1);
		const error = await bounded(
			pending.then(
				() => undefined,
				(reason: unknown) => reason,
			),
			"watchdog rejection",
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("ACP prompt was abandoned");
		expect((error as Error).message).toContain('"tool_execution_end"');
	} finally {
		fixture.dispose();
	}
});

test("a tool call still in flight keeps the wide bound armed across silent gaps", async () => {
	const fixture = await createFixture();
	try {
		const { pending } = await startTurn(fixture);
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		const started = toolCalls(fixture.updates);
		fixture.sendToolStart("watchdog-tool-a");
		await waitFor(() => toolCalls(fixture.updates) > started, "first tool call start");

		// A second tool starting and finishing must not retire the evidence held by the
		// first one, which is still running.
		const ended = toolCallUpdates(fixture.updates);
		fixture.sendToolStart("watchdog-tool-b");
		fixture.sendToolEnd("watchdog-tool-b");
		await waitFor(() => toolCallUpdates(fixture.updates) > ended, "second tool call end");

		fixture.clock.advance(ACP_PROMPT_INACTIVITY_TIMEOUT_MS * 3);
		await Bun.sleep(10);
		expect(settled).toBe(false);

		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "prompt completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});
