import { expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection, PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { TempDir } from "@gajae-code/utils";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { ACP_PROMPT_INFERENCE_TIMEOUT_MS } from "../src/sdk/prompt-watchdog";

type TestSocket = { send(message: string): void };
type StoppedReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/**
 * Virtual timer source for the prompt watchdog. A normally completed turn must settle
 * with this clock frozen at zero: a settlement that needs the clock moved is the
 * watchdog rescuing a dead producer, not the terminal frame ending the turn.
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
			for (const [id, timer] of this.#timers) {
				if (timer.at <= target && timer.at < dueAt) {
					dueId = id;
					dueAt = timer.at;
				}
			}
			if (dueId === undefined) break;
			const timer = this.#timers.get(dueId);
			this.#timers.delete(dueId);
			this.#now = dueAt;
			timer?.handler();
		}
		this.#now = target;
	}
}

type Fixture = {
	agent: AcpAgent;
	sessionId: string;
	updates: SessionNotification[];
	clock: VirtualClock;
	queryCalls: string[];
	sendStopped(reason: StoppedReason): void;
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

function phaseUpdates(updates: SessionNotification[], phase: string): number {
	return updates.filter(
		update =>
			update.update.sessionUpdate === "session_info_update" &&
			(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === phase,
	).length;
}

/**
 * @param options.silentQueries Query ids the session host accepts and never answers,
 * reproducing a host that stops producing the moment it publishes its terminal frame.
 */
async function createFixture(options: { silentQueries?: string[] } = {}): Promise<Fixture> {
	const silent = new Set(options.silentQueries ?? []);
	const tempDir = TempDir.createSync("@acp-prompt-settle-");
	const agentDir = path.join(tempDir.path(), "agent");
	const cwd = path.join(tempDir.path(), "workspace");
	const token = "acp-prompt-settle-token";
	const sessionId = "prompt-settle-session";
	const commandId = "prompt-settle-command";
	const turnId = "prompt-settle-turn";
	const updates: SessionNotification[] = [];
	const queryCalls: string[] = [];
	const clock = new VirtualClock();
	const abort = new AbortController();
	let promptSocket: TestSocket | undefined;
	let server!: ReturnType<typeof Bun.serve>;

	const send = (frame: Record<string, unknown>): void => {
		if (!promptSocket) throw new Error("Expected a prompt socket");
		promptSocket.send(JSON.stringify(frame));
	};
	const sendStopped = (reason: StoppedReason): void => {
		send({
			type: "agent_end",
			sessionId,
			commandId,
			turnId,
			finalText: "the complete final report",
			outcome: { kind: "stopped", reason, provenance: reason === "cancelled" ? "client_cancel" : "agent" },
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
				socket.send(JSON.stringify({ type: "hello", connectionId: "acp-prompt-settle" }));
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
					queryCalls.push(String(frame.query));
					if (silent.has(String(frame.query))) return;
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
				if (frame.operation === "turn.prompt") promptSocket = socket;
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
	await waitFor(() => phaseUpdates(updates, "idle") > 0, "bootstrap update");

	return {
		agent,
		sessionId: created.sessionId,
		updates,
		clock,
		queryCalls,
		sendStopped,
		dispose: () => {
			abort.abort();
			server.stop(true);
			tempDir.removeSync();
		},
	};
}

/**
 * Runs a turn up to its acknowledged, started state. The pending prompt is returned
 * wrapped so its settlement is observed without leaving an unhandled rejection while
 * the test drives the host.
 */
async function startTurn(
	fixture: Fixture,
	text: string,
): Promise<{ settled: Promise<{ resolved?: { stopReason: StoppedReason }; rejected?: { code?: string } }> }> {
	const started = phaseUpdates(fixture.updates, "working");
	const pending = fixture.agent.prompt({
		sessionId: fixture.sessionId,
		messageId: "00000000-0000-4000-8000-000000000001",
		prompt: [{ type: "text", text }],
	} as PromptRequest) as Promise<{ stopReason: StoppedReason }>;
	const settled = pending.then(
		resolved => ({ resolved }),
		(error: unknown) => ({ rejected: error as { code?: string } }),
	);
	await waitFor(() => phaseUpdates(fixture.updates, "working") > started, "turn start");
	return { settled };
}

test("a completed turn settles on its terminal frame even when end-of-turn metadata never answers", async () => {
	// `context.get` and `session.metadata` are advisory decoration. A host that stops
	// producing right after publishing its terminal must not hold the ACP turn open.
	const fixture = await createFixture({ silentQueries: ["context.get", "session.metadata"] });
	try {
		const { settled } = await startTurn(fixture, "long running turn");
		fixture.sendStopped("end_turn");
		expect(await bounded(settled, "prompt completion")).toEqual({ resolved: { stopReason: "end_turn" } });
		// Settlement came from the terminal frame, not the inactivity watchdog: the
		// virtual clock never moved, so nothing near the bound could have fired.
		expect(fixture.clock.now()).toBe(0);
		expect(fixture.clock.pending).toBe(0);
		// The terminal was processed in full, not dropped: its final report reached the
		// client as an assistant chunk in the same pass that settled the turn.
		expect(
			fixture.updates
				.filter(update => update.update.sessionUpdate === "agent_message_chunk")
				.map(update => (update.update as { content: { text: string } }).content.text),
		).toEqual(["the complete final report"]);
	} finally {
		fixture.dispose();
	}
});

test("a completed turn settles exactly once for duplicate and late terminal frames", async () => {
	const fixture = await createFixture();
	try {
		const idleBefore = phaseUpdates(fixture.updates, "idle");
		const { settled } = await startTurn(fixture, "duplicated terminal");
		fixture.sendStopped("end_turn");
		fixture.sendStopped("end_turn");
		expect(await bounded(settled, "prompt completion")).toEqual({ resolved: { stopReason: "end_turn" } });
		await waitFor(() => fixture.queryCalls.includes("session.metadata"), "end-of-turn metadata query");
		// A late duplicate arriving after settlement must not re-run the end-of-turn work.
		fixture.sendStopped("end_turn");
		await Bun.sleep(50);
		expect(phaseUpdates(fixture.updates, "idle")).toBe(idleBefore + 1);
		expect(fixture.queryCalls.filter(query => query === "context.get")).toHaveLength(1);
		expect(fixture.queryCalls.filter(query => query === "session.metadata")).toHaveLength(1);
		expect(fixture.updates.filter(update => update.update.sessionUpdate === "agent_message_chunk")).toHaveLength(1);
	} finally {
		fixture.dispose();
	}
});

test("a producer that never publishes a terminal is still settled by the inactivity watchdog", async () => {
	const fixture = await createFixture();
	try {
		const { settled } = await startTurn(fixture, "dead producer");
		// The turn died right after `agent_start`, i.e. while awaiting the model, so the
		// inference bound is the one that has to catch it.
		fixture.clock.advance(ACP_PROMPT_INFERENCE_TIMEOUT_MS);
		expect(await bounded(settled, "watchdog settlement")).toMatchObject({
			rejected: { code: "prompt_abandoned" },
		});
	} finally {
		fixture.dispose();
	}
});
