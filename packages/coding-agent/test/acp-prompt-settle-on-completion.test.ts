import { expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AgentSideConnection,
	CancelNotification,
	PromptRequest,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import { TempDir } from "@gajae-code/utils";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { ACP_PROMPT_INFERENCE_TIMEOUT_MS } from "../src/sdk/prompt-watchdog";

setDefaultTimeout(20_000);

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
		Bun.sleep(10_000).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
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
async function createFixture(
	options: {
		silentQueries?: string[];
		terminalBeforeAcknowledgement?: boolean;
		rejectFinalTextUpdate?: boolean;
		/** Deferred per-turn.prompt response (default: accepted); awaited before answering. */
		promptResponse?: () => unknown | Promise<unknown>;
		/** Queue of per-turn.abort responses; falls back to { aborted: true }. */
		abortResponses?: Array<unknown | (() => unknown | Promise<unknown>)>;
		/** Overrides the post-acknowledgement cancel settlement grace. */
		cancelSettlementGraceMs?: number;
	} = {},
): Promise<Fixture> {
	const silent = new Set(options.silentQueries ?? []);
	const abortResponseQueue = [...(options.abortResponses ?? [])];
	// Queue entries may be factories for deferred responses (the test drives
	// the response ordering of overlapping cancels).
	const resolveAbortResponse = (entry: unknown): unknown =>
		typeof entry === "function" ? (entry as () => unknown | Promise<unknown>)() : entry;
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
			async message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
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
				if (frame.type === "broker_request") {
					const endpointMtimeMs = 1;
					if (frame.operation === "session.create") {
						const endpointPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
						await fs.mkdir(path.dirname(endpointPath), { recursive: true });
						await Bun.write(
							endpointPath,
							JSON.stringify({ sessionId, pid: process.pid, url: `ws://127.0.0.1:${server.port}`, token }),
						);
						await fs.utimes(endpointPath, 0.001, 0.001);
						const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
						const index = await new SessionIndex(agentDir).open();
						await index.append({
							type: "host_registered",
							sessionId,
							locator: { cwd: cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") },
							endpointGeneration: 1,
							pid: process.pid,
							endpointMtimeMs,
						});
					}
					const result =
						frame.operation === "session.create"
							? {
									sessionId,
									endpointGeneration: 1,
									pid: process.pid,
									endpointMtimeMs,
									endpoint: { sessionId, pid: process.pid, url: `ws://127.0.0.1:${server.port}`, token },
								}
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
				if (frame.operation === "turn.prompt" && options.terminalBeforeAcknowledgement)
					socket.send(
						JSON.stringify({
							type: "event",
							commandId,
							payload: {
								event_type: "agent_end",
								event: {
									type: "agent_end",
									turnId,
									finalText: "the complete final report",
									outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
								},
							},
						}),
					);
				const promptReply =
					frame.operation === "turn.prompt"
						? options.promptResponse
							? await options.promptResponse()
							: { ok: true, result: { commandId, turnId, accepted: true } }
						: undefined;
				const queuedAbortReply = frame.operation === "turn.abort" ? abortResponseQueue.shift() : undefined;
				const abortReply = await resolveAbortResponse(queuedAbortReply ?? { aborted: true });
				socket.send(
					JSON.stringify({
						type: "control_response",
						id: frame.id,
						ok: promptReply === undefined ? true : (promptReply as { ok?: boolean }).ok !== false,
						result:
							promptReply !== undefined
								? (promptReply as { result?: unknown }).result
								: frame.operation === "turn.abort"
									? abortReply
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
			sessionUpdate: async (update: SessionNotification) => {
				if (options.rejectFinalTextUpdate && update.update.sessionUpdate === "agent_message_chunk")
					throw new Error("client update failed");
				updates.push(update);
			},
			signal: abort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{
			agentDir,
			promptWatchdogClock: clock,
			cancelSettlementGraceMs: options.cancelSettlementGraceMs ?? 5_000,
		},
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
		// client as a detached assistant chunk without holding settlement.
		await waitFor(
			() => fixture.updates.some(update => update.update.sessionUpdate === "agent_message_chunk"),
			"detached final text",
		);
		expect(
			fixture.updates
				.filter(update => update.update.sessionUpdate === "agent_message_chunk")
				.map(update => (update.update as { content: { text: string } }).content.text),
		).toEqual(["the complete final report"]);
	} finally {
		fixture.dispose();
	}
});

test("a pre-acknowledgement terminal uses correlation carried by its event payload", async () => {
	const fixture = await createFixture({ terminalBeforeAcknowledgement: true });
	try {
		const pending = fixture.agent.prompt({
			sessionId: fixture.sessionId,
			messageId: "00000000-0000-4000-8000-000000000002",
			prompt: [{ type: "text", text: "fast completed turn" }],
		} as PromptRequest) as Promise<{ stopReason: StoppedReason }>;
		expect(await bounded(pending, "pre-acknowledgement prompt completion")).toEqual({
			stopReason: "end_turn",
		});
		await waitFor(
			() => fixture.updates.some(update => update.update.sessionUpdate === "agent_message_chunk"),
			"pre-acknowledgement detached final text",
		);
		expect(
			fixture.updates
				.filter(update => update.update.sessionUpdate === "agent_message_chunk")
				.map(update => (update.update as { content: { text: string } }).content.text),
		).toEqual(["the complete final report"]);
		expect(fixture.clock.now()).toBe(0);
		expect(fixture.clock.pending).toBe(0);
	} finally {
		fixture.dispose();
	}
});

test("a terminal settlement is not reversed by a final-text publication failure", async () => {
	const fixture = await createFixture({ terminalBeforeAcknowledgement: true, rejectFinalTextUpdate: true });
	try {
		const pending = fixture.agent.prompt({
			sessionId: fixture.sessionId,
			messageId: "00000000-0000-4000-8000-000000000003",
			prompt: [{ type: "text", text: "terminal update failure" }],
		} as PromptRequest) as Promise<{ stopReason: StoppedReason }>;
		const outcome = await bounded(
			pending.then(
				() => undefined,
				(error: unknown) => error as { code?: string },
			),
			"deferred terminal processing failure",
		);
		expect(outcome).toBeUndefined();
		expect(fixture.clock.pending).toBe(0);
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
		await waitFor(() => phaseUpdates(fixture.updates, "idle") === idleBefore + 1, "single terminal idle update");
		await waitFor(
			() => fixture.updates.filter(update => update.update.sessionUpdate === "agent_message_chunk").length === 1,
			"single detached final text",
		);
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

test("cancel intent survives a failing second attempt while the first is still pending", async () => {
	// Review thread P2: when two cancels genuinely overlap and the later SDK
	// request fails BEFORE the earlier one is acknowledged, the later failure
	// must not clear record.cancelRequested — the earlier attempt can still
	// stop the turn, and a concurrent prompt-preflight rejection must then
	// settle as cancelled instead of surfacing the transport error.
	let promptFrameArrived: () => void = () => {};
	const promptFrameSeen = new Promise<void>(resolve => {
		promptFrameArrived = resolve;
	});
	const promptGate = Promise.withResolvers<void>();
	let releaseAbortA: () => void = () => {};
	const abortAGate = new Promise<void>(resolve => {
		releaseAbortA = resolve;
	});
	const fixture = await createFixture({
		promptResponse: async () => {
			promptFrameArrived();
			await promptGate.promise;
			return { ok: false, error: { code: "busy", message: "preflight busy" } };
		},
		abortResponses: [
			// First cancel: its acknowledgement is deferred (still in flight
			// when the second attempt fails).
			async () => {
				await abortAGate;
				return { ok: true, result: { aborted: true } };
			},
			// Second cancel: the turn is not (yet) stopped -> no_active_turn,
			// which is NOT an acknowledgement.
			{ ok: true, result: { turn: "no_active_turn", terminal: "terminal_no_effect" } },
		],
		cancelSettlementGraceMs: 60_000,
	});
	try {
		const pending = fixture.agent.prompt({
			sessionId: fixture.sessionId,
			messageId: "00000000-0000-4000-8000-000000000001",
			prompt: [{ type: "text", text: "hold the turn" }],
		} as PromptRequest) as Promise<{ stopReason: StoppedReason }>;
		const settled = pending.then(
			resolved => ({ resolved }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await bounded(promptFrameSeen, "prompt frame arrival");
		// First cancel: still pending (its acknowledgement is gated).
		const cancelAPromise = fixture.agent.cancel({ sessionId: fixture.sessionId } as CancelNotification);
		// Second overlapping cancel fails while the first is in flight.
		await expect(fixture.agent.cancel({ sessionId: fixture.sessionId } as CancelNotification)).rejects.toMatchObject({
			code: "abort_unacknowledged",
		});
		// The first attempt then acknowledges: the cancellation intent must
		// still be set, so the prompt-preflight rejection settles as cancelled.
		releaseAbortA();
		await cancelAPromise;
		promptGate.resolve();
		const outcome = await bounded(settled, "prompt settlement after overlapping cancels");
		expect("resolved" in outcome ? outcome.resolved?.stopReason : outcome.rejected?.code).toBe("cancelled");
	} finally {
		fixture.dispose();
	}
});

test("any successful cancel resolves the waiter immediately while an earlier attempt is pending", async () => {
	// Review thread P2: when two cancels overlap and the LATER attempt is
	// acknowledged while the earlier one is still unanswered, the shared
	// waiter promise must resolve immediately — aggregating, not serializing
	// in request order — or a prompt rejection awaiting cancelAttempt can
	// hang past the cancellation grace bound.
	let promptFrameArrived: () => void = () => {};
	const promptFrameSeen = new Promise<void>(resolve => {
		promptFrameArrived = resolve;
	});
	const promptGate = Promise.withResolvers<void>();
	let releaseAbortA: () => void = () => {};
	const abortAGate = new Promise<void>(resolve => {
		releaseAbortA = resolve;
	});
	const fixture = await createFixture({
		promptResponse: async () => {
			promptFrameArrived();
			await promptGate.promise;
			return { ok: false, error: { code: "busy", message: "preflight busy" } };
		},
		abortResponses: [
			// First cancel: still unanswered while the second acknowledges.
			async () => {
				await abortAGate;
				return { ok: true, result: { aborted: true } };
			},
			// Second cancel: acknowledged immediately.
			{ ok: true, result: { aborted: true } },
		],
		cancelSettlementGraceMs: 60_000,
	});
	try {
		const pending = fixture.agent.prompt({
			sessionId: fixture.sessionId,
			messageId: "00000000-0000-4000-8000-000000000001",
			prompt: [{ type: "text", text: "hold the turn" }],
		} as PromptRequest) as Promise<{ stopReason: StoppedReason }>;
		const settled = pending.then(
			resolved => ({ resolved }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await bounded(promptFrameSeen, "prompt frame arrival");
		// First cancel: pending.
		const cancelAPromise = fixture.agent.cancel({ sessionId: fixture.sessionId } as CancelNotification);
		// Second cancel acknowledges while the first is still unanswered.
		await fixture.agent.cancel({ sessionId: fixture.sessionId } as CancelNotification);
		// The prompt-preflight rejection settles as cancelled immediately —
		// it must not wait for the unanswered first attempt.
		promptGate.resolve();
		const outcome = await bounded(settled, "prompt settlement after the later success");
		expect("resolved" in outcome ? outcome.resolved?.stopReason : outcome.rejected?.code).toBe("cancelled");
		// The first attempt's late acknowledgement resolves cleanly afterwards.
		releaseAbortA();
		await cancelAPromise;
	} finally {
		fixture.dispose();
	}
});

test("a failed cancel wave re-arms the aggregation for the next wave", async () => {
	// Review thread P2: after a cancel wave ends with every attempt failing,
	// the aggregate must be cleared — a later cancellation wave needs a fresh
	// resolver, or the prompt path observes the stale resolved-false promise
	// immediately and reports cancelled while the retry is still pending (and
	// even after the retry fails with abort_unacknowledged).
	let promptFrameArrived: () => void = () => {};
	const promptFrameSeen = new Promise<void>(resolve => {
		promptFrameArrived = resolve;
	});
	const promptGate = Promise.withResolvers<void>();
	let releaseAbortB: () => void = () => {};
	const abortBGate = new Promise<void>(resolve => {
		releaseAbortB = resolve;
	});
	const fixture = await createFixture({
		promptResponse: async () => {
			promptFrameArrived();
			await promptGate.promise;
			return { ok: false, error: { code: "busy", message: "preflight busy" } };
		},
		abortResponses: [
			// Wave 1: the only attempt fails (no_active_turn is not an
			// acknowledgement).
			{ ok: true, result: { turn: "no_active_turn", terminal: "terminal_no_effect" } },
			// Wave 2: the retry is still pending when the prompt rejects.
			async () => {
				await abortBGate;
				return { ok: true, result: { turn: "no_active_turn", terminal: "terminal_no_effect" } };
			},
		],
		cancelSettlementGraceMs: 60_000,
	});
	try {
		const pending = fixture.agent.prompt({
			sessionId: fixture.sessionId,
			messageId: "00000000-0000-4000-8000-000000000001",
			prompt: [{ type: "text", text: "hold the turn" }],
		} as PromptRequest) as Promise<{ stopReason: StoppedReason }>;
		const settled = pending.then(
			resolved => ({ resolved }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await bounded(promptFrameSeen, "prompt frame arrival");
		// Wave 1 fails entirely: the aggregate resolves false and re-arms.
		await expect(fixture.agent.cancel({ sessionId: fixture.sessionId } as CancelNotification)).rejects.toMatchObject({
			code: "abort_unacknowledged",
		});
		// Wave 2: the retry is in flight when the prompt preflight rejects.
		const retryPromise = fixture.agent.cancel({ sessionId: fixture.sessionId } as CancelNotification);
		promptGate.resolve();
		// The retry then fails too: the prompt must NOT settle as cancelled on
		// a stale false from the previous wave — it awaits the NEW attempt and
		// surfaces the transport error.
		releaseAbortB();
		const outcome = await bounded(settled, "prompt settlement after the failed wave");
		expect("rejected" in outcome).toBe(true);
		await expect(retryPromise).rejects.toMatchObject({ code: "abort_unacknowledged" });
	} finally {
		fixture.dispose();
	}
});
