import { expect, setDefaultTimeout, test, vi } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection, PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { getProviderFirstEventTimeoutFallbackMs } from "@gajae-code/ai/utils/idle-iterator";
import { logger, TempDir } from "@gajae-code/utils";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import {
	ACP_PROMPT_INACTIVITY_TIMEOUT_MS,
	ACP_PROMPT_INFERENCE_TIMEOUT_MS,
	ACP_PROMPT_TOOL_ACTIVITY_TIMEOUT_MS,
} from "../src/sdk/prompt-watchdog";
import {
	type ExactSessionAuthorityFixture,
	type ExactSessionAuthorityOptions,
	prepareExactSessionAuthority,
	publishExactSessionAuthority,
} from "./helpers/sdk-exact-session-authority";

setDefaultTimeout(60_000);

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

	/** The single armed watchdog timer; every re-arm replaces it, so the id changes with it. */
	get armed(): { id: number; at: number } | undefined {
		for (const [id, timer] of this.#timers) return { id, at: timer.at };
		return undefined;
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
	/** Sends one raw frame down the session socket, correlation included or omitted verbatim. */
	send(frame: Record<string, unknown>): void;
	sendAssistantText(text: string): void;
	sendStopped(reason: StoppedReason): void;
	sendToolStart(toolCallId: string): void;
	sendToolEnd(toolCallId: string): void;
	acknowledgePrompt(): void;
	dispose(): void;
};

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(45_000).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 45_000;
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

type FixtureOptions = {
	agentStartBeforeAcknowledgement?: boolean;
	deferFirstPromptAcknowledgement?: boolean;
	cancelSettlementGraceMs?: number;
};

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
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
	let deferredPromptAcknowledgement:
		| { socket: TestSocket; id: unknown; result: { commandId: string; turnId: string; accepted: true } }
		| undefined;

	const send = (frame: Record<string, unknown>): void => {
		if (!promptSocket) throw new Error("Expected a prompt socket");
		promptSocket.send(JSON.stringify(frame));
	};
	const acknowledgePrompt = (): void => {
		const deferred = deferredPromptAcknowledgement;
		if (!deferred) throw new Error("Expected a deferred prompt acknowledgement");
		deferredPromptAcknowledgement = undefined;
		deferred.socket.send(
			JSON.stringify({
				type: "control_response",
				id: deferred.id,
				ok: true,
				result: deferred.result,
			}),
		);
	};
	const sendAssistantText = (text: string): void => {
		send({
			type: "event",
			kind: "message_end",
			sessionId,
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
			kind: "tool_execution_start",
			sessionId,
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
			kind: "tool_execution_end",
			sessionId,
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
					if (frame.operation !== "session.create") {
						socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: {} }));
						return;
					}
					socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: authority }));
					setTimeout(() => void publishExactSessionAuthority(authorityOptions, authority), 10);
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
				if (frame.operation === "turn.prompt" && options.agentStartBeforeAcknowledgement)
					socket.send(JSON.stringify({ type: "agent_start", sessionId, commandId, turnId }));
				const result =
					frame.operation === "turn.prompt"
						? { commandId, turnId, accepted: true as const }
						: frame.operation === "turn.abort"
							? (() => {
									const scope = (frame.input as { scope?: string })?.scope === "owned" ? "owned" : "turn";
									return {
										ok: true,
										selection: scope,
										turn: "stopped",
										ownedWork: scope === "owned" ? "stopped" : "left_running",
										automaticDelivery: scope === "owned" ? "none" : "enabled",
										resumeOnOwnedCompletion: scope !== "owned",
									};
								})()
							: {};
				if (frame.operation === "turn.prompt" && options.deferFirstPromptAcknowledgement && turnCount === 1) {
					deferredPromptAcknowledgement = {
						socket,
						id: frame.id,
						result: { commandId, turnId, accepted: true },
					};
				} else {
					socket.send(
						JSON.stringify({
							type: "control_response",
							id: frame.id,
							ok: true,
							result,
						}),
					);
				}
				if (
					frame.operation === "turn.prompt" &&
					!options.agentStartBeforeAcknowledgement &&
					!(options.deferFirstPromptAcknowledgement && turnCount === 1)
				) {
					// Frames are FIFO on the socket, so the client records the acknowledged
					// correlation before this start frame reaches the session record.
					socket.send(JSON.stringify({ type: "agent_start", sessionId, commandId, turnId }));
				}
			},
		},
	});
	const port = server.port;
	if (port === undefined) throw new Error("Expected an ACP fixture server port");
	const authorityOptions: ExactSessionAuthorityOptions = {
		agentDir,
		cwd,
		sessionId,
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
	const agent = new AcpAgent(
		{
			sessionUpdate: async (update: SessionNotification) => updates.push(update),
			signal: abort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{
			agentDir,
			promptWatchdogClock: clock,
			...(options.cancelSettlementGraceMs === undefined
				? {}
				: { cancelSettlementGraceMs: options.cancelSettlementGraceMs }),
		},
	);
	const created = await bounded(agent.newSession({ cwd, mcpServers: [] }), "new session");
	await waitFor(() => idleUpdates(updates) > 0, "bootstrap update");

	return {
		agent,
		sessionId: created.sessionId,
		updates,
		clock,
		correlation: () => ({ commandId, turnId }),
		send,
		sendAssistantText,
		sendStopped,
		sendToolStart,
		sendToolEnd,
		acknowledgePrompt,
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

test("a prompt awaiting the model past the inference bound is rejected instead of hanging", async () => {
	const fixture = await createFixture();
	try {
		const { pending } = await startTurn(fixture);
		const { commandId, turnId } = fixture.correlation();
		const idleBefore = idleUpdates(fixture.updates);

		fixture.clock.advance(ACP_PROMPT_INFERENCE_TIMEOUT_MS + 1);

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
		expect(message).toContain(`${Math.round(ACP_PROMPT_INFERENCE_TIMEOUT_MS / 1_000)}s of silence`);
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
		fixture.clock.advance(ACP_PROMPT_INFERENCE_TIMEOUT_MS + 1);
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
		const idleBeforeTerminal = idleUpdates(fixture.updates);
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "prompt completion")).toEqual({ stopReason: "end_turn" });

		// The prompt settles on its terminal frame, ahead of the advisory end-of-turn
		// queries, so the phase publication is snapshotted once those have flushed.
		await waitFor(() => idleUpdates(fixture.updates) > idleBeforeTerminal, "end-of-turn idle update");
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
	// Widest per-provider first-event window (`alibaba-token-plan`, 600s) + the same budget.
	expect(ACP_PROMPT_INFERENCE_TIMEOUT_MS).toBe(640_000);
	// Slowest per-tool ceiling (`bash`/`ssh`, 3600s) + the same reconnect budget.
	expect(ACP_PROMPT_TOOL_ACTIVITY_TIMEOUT_MS).toBe(3_640_000);
	// A frame-free gap with nothing running must stay operationally useful; the wide
	// bound is only ever reachable while a tool call is observably in flight.
	expect(ACP_PROMPT_INACTIVITY_TIMEOUT_MS).toBeLessThan(10 * 60_000);
	expect(ACP_PROMPT_TOOL_ACTIVITY_TIMEOUT_MS).toBeGreaterThan(3_600_000);
	// Each bound is strictly wider than the evidence-free one it replaces, and the
	// inference bound stays far below the tool ceiling: thinking is not executing.
	expect(ACP_PROMPT_INFERENCE_TIMEOUT_MS).toBeGreaterThan(ACP_PROMPT_INACTIVITY_TIMEOUT_MS);
	expect(ACP_PROMPT_INFERENCE_TIMEOUT_MS).toBeLessThan(ACP_PROMPT_TOOL_ACTIVITY_TIMEOUT_MS);
	// The inference bound mirrors a constant that lives in another package. If that
	// widens or narrows, this fails instead of silently drifting.
	expect(getProviderFirstEventTimeoutFallbackMs("alibaba-token-plan")).toBe(600_000);
	expect(getProviderFirstEventTimeoutFallbackMs("kimi-code")).toBe(300_000);
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

		// Tool evidence is gone, but returning a tool result re-invokes the model, so the
		// gap that follows is an inference gap — the idle bound no longer governs it.
		fixture.clock.advance(ACP_PROMPT_INFERENCE_TIMEOUT_MS + 1);
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

test("a turn silent after agent_start is not killed while the model is still answering", async () => {
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

		// 49 of the 65 production expiries looked exactly like this: the host went quiet
		// right after `agent_start` because the provider was still reasoning. Nothing is
		// executing, but a dispatched model call has not answered, so the evidence-free
		// bound is the wrong one to apply.
		fixture.clock.advance(ACP_PROMPT_INACTIVITY_TIMEOUT_MS + 1);
		await Bun.sleep(10);
		expect(settled).toBe(false);

		// Still one tick short of the inference bound after the whole gap.
		fixture.clock.advance(ACP_PROMPT_INFERENCE_TIMEOUT_MS - ACP_PROMPT_INACTIVITY_TIMEOUT_MS - 2);
		await Bun.sleep(10);
		expect(settled).toBe(false);

		const chunks = textChunks(fixture.updates);
		fixture.sendAssistantText("done thinking");
		await waitFor(() => textChunks(fixture.updates) > chunks, "assistant chunk");
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "prompt completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("a turn silent after tool_execution_end is not killed while the model is re-invoked", async () => {
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
		fixture.sendToolStart("watchdog-inference-tool");
		await waitFor(() => toolCalls(fixture.updates) > started, "tool call start");
		const ended = toolCallUpdates(fixture.updates);
		fixture.sendToolEnd("watchdog-inference-tool");
		await waitFor(() => toolCallUpdates(fixture.updates) > ended, "tool call end");

		// The other 15 expiries: the tool result went back to the model and the next
		// provider call had not answered yet. No tool is running, so the wide tool bound is
		// correctly retired — but the turn is still legitimately silent.
		fixture.clock.advance(ACP_PROMPT_INACTIVITY_TIMEOUT_MS + 1);
		await Bun.sleep(10);
		expect(settled).toBe(false);

		fixture.clock.advance(ACP_PROMPT_INFERENCE_TIMEOUT_MS - ACP_PROMPT_INACTIVITY_TIMEOUT_MS - 2);
		await Bun.sleep(10);
		expect(settled).toBe(false);

		const chunks = textChunks(fixture.updates);
		fixture.sendAssistantText("after the tool");
		await waitFor(() => textChunks(fixture.updates) > chunks, "assistant chunk");
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "prompt completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("a turn with no tool running and no model call pending is still held to the narrow bound", async () => {
	const fixture = await createFixture();
	try {
		const { pending } = await startTurn(fixture);
		// The model answered, so no inference is pending; no tool ever started, so nothing
		// is executing. Nobody is working — this is the state the narrow bound exists for,
		// and widening it for inference must not have blinded it here.
		const chunks = textChunks(fixture.updates);
		fixture.sendAssistantText("answered, then died");
		await waitFor(() => textChunks(fixture.updates) > chunks, "assistant chunk");

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
		expect(message).toContain('"message_end"');
	} finally {
		fixture.dispose();
	}
});

/**
 * Abandons one turn and starts a second one, then hands back the settled turn's correlation.
 * This is the supported recovery flow: the watchdog rejects a turn, the client re-prompts, and
 * the slow-but-alive host then flushes the abandoned turn's frames onto the live turn's socket.
 */
async function abandonTurnThenStartAnother(
	fixture: Fixture,
): Promise<{ stale: { commandId: string; turnId: string }; pending: Promise<{ stopReason: StoppedReason }> }> {
	const { pending: abandoned } = await startTurn(fixture);
	const stale = fixture.correlation();
	fixture.clock.advance(ACP_PROMPT_INFERENCE_TIMEOUT_MS + 1);
	await bounded(
		abandoned.then(
			() => undefined,
			() => undefined,
		),
		"watchdog rejection",
	);
	const { pending } = await startTurn(fixture);
	expect(fixture.correlation().turnId).not.toBe(stale.turnId);
	return { stale, pending };
}

function staleEventFrame(
	stale: { commandId: string; turnId: string },
	eventType: string,
	event: Record<string, unknown>,
): Record<string, unknown> {
	return {
		type: "event",
		commandId: stale.commandId,
		turnId: stale.turnId,
		payload: { event_type: eventType, event },
	};
}

function correlationlessAssistantFrame(text: string): Record<string, unknown> {
	return {
		type: "event",
		payload: {
			event_type: "message_end",
			event: {
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text }] },
			},
		},
	};
}

test("a late acknowledgement tombstones a prompt rejected before ownership was known", async () => {
	const diagnostic = vi.spyOn(logger, "error").mockImplementation(() => {});
	const fixture = await createFixture({ deferFirstPromptAcknowledgement: true });
	try {
		const idleBefore = idleUpdates(fixture.updates);
		const abandoned = prompt(fixture, "withhold acknowledgement").then(
			() => undefined,
			(reason: unknown) => reason,
		);
		await waitFor(() => fixture.correlation().commandId.length > 0, "first prompt dispatch");
		const stale = fixture.correlation();
		const firstWatchdog = fixture.clock.armed;
		if (!firstWatchdog) throw new Error("Expected the pre-acknowledgement watchdog to be armed");

		fixture.clock.advance(firstWatchdog.at - fixture.clock.now() + 1);
		await waitFor(() => idleUpdates(fixture.updates) === idleBefore + 1, "pre-acknowledgement watchdog rejection");
		expect(fixture.clock.pending).toBe(0);
		const abandonedError = await bounded(abandoned, "watchdog rejection before acknowledgement");
		expect(abandonedError).toBeInstanceOf(Error);
		expect((abandonedError as Error).message).toContain("ACP prompt was abandoned");

		fixture.acknowledgePrompt();

		const { pending } = await startTurn(fixture);
		expect(fixture.correlation()).not.toEqual(stale);
		const armedBeforeStaleFrames = fixture.clock.armed;
		const chunksBefore = textChunks(fixture.updates);
		const toolCallsBefore = toolCalls(fixture.updates);
		const toolUpdatesBefore = toolCallUpdates(fixture.updates);
		const updateBoundary = fixture.updates.length;
		const privateMessage = "PRIVATE_LATE_MESSAGE_SENTINEL";
		const privateTool = "PRIVATE_LATE_TOOL_SENTINEL";
		const staleToolCallId = "late-stale-tool";

		fixture.send(
			staleEventFrame(stale, "message_update", {
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: privateMessage }] },
			}),
		);
		fixture.send(
			staleEventFrame(stale, "tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: staleToolCallId,
				toolName: "bash",
				args: { command: privateTool },
			}),
		);
		fixture.send({
			type: "event",
			payload: {
				event_type: "tool_execution_end",
				event: {
					type: "tool_execution_end",
					toolCallId: staleToolCallId,
					toolName: "bash",
					isError: false,
					result: { content: [{ type: "text", text: "correlationless tool completion" }] },
				},
			},
		});
		fixture.send(correlationlessAssistantFrame("correlationless session marker"));
		await waitFor(() => textChunks(fixture.updates) === chunksBefore + 1, "correlationless session publication");
		await waitFor(
			() => toolCallUpdates(fixture.updates) === toolUpdatesBefore + 1,
			"correlationless tool publication",
		);

		expect(toolCalls(fixture.updates)).toBe(toolCallsBefore);
		expect(fixture.clock.armed).toEqual(armedBeforeStaleFrames);
		const published = JSON.stringify(fixture.updates.slice(updateBoundary));
		const diagnostics = JSON.stringify(diagnostic.mock.calls);
		expect(published).not.toContain(privateMessage);
		expect(published).not.toContain(privateTool);
		expect(diagnostics).not.toContain(privateMessage);
		expect(diagnostics).not.toContain(privateTool);

		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "successor prompt completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		diagnostic.mockRestore();
		fixture.dispose();
	}
});

test("a foreign correlated frame waits for exact pre-acknowledgement ownership", async () => {
	const fixture = await createFixture({ deferFirstPromptAcknowledgement: true });
	try {
		const pending = prompt(fixture, "withhold acknowledgement");
		await waitFor(() => fixture.correlation().commandId.length > 0, "prompt dispatch");
		const chunksBefore = textChunks(fixture.updates);
		const updateBoundary = fixture.updates.length;
		const privateMessage = "PRIVATE_FOREIGN_PRE_ACK_SENTINEL";

		fixture.send(
			staleEventFrame({ commandId: "foreign-command", turnId: "foreign-turn" }, "message_end", {
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: privateMessage }] },
			}),
		);
		fixture.send(correlationlessAssistantFrame("pre-acknowledgement ingress marker"));
		await waitFor(() => textChunks(fixture.updates) > chunksBefore, "pre-acknowledgement frame ingress");

		expect(textChunks(fixture.updates)).toBe(chunksBefore + 1);
		expect(JSON.stringify(fixture.updates.slice(updateBoundary))).not.toContain(privateMessage);

		fixture.acknowledgePrompt();
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "prompt completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("a cancelled pre-acknowledgement prompt settles without its acknowledgement", async () => {
	const fixture = await createFixture({ deferFirstPromptAcknowledgement: true, cancelSettlementGraceMs: 25 });
	try {
		const pending = prompt(fixture, "cancel before acknowledgement");
		await waitFor(() => fixture.correlation().commandId.length > 0, "prompt dispatch");
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "cancel acknowledgement");
		expect(await bounded(pending, "pre-acknowledgement cancellation")).toEqual({ stopReason: "cancelled" });

		fixture.acknowledgePrompt();
	} finally {
		fixture.dispose();
	}
});

test("a settled turn's stale message frame does not narrow the live turn off the inference bound", async () => {
	const fixture = await createFixture();
	try {
		const { stale, pending } = await abandonTurnThenStartAnother(fixture);
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		const armedBefore = fixture.clock.armed;
		const chunks = textChunks(fixture.updates);
		fixture.send(
			staleEventFrame(stale, "message_update", {
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "flushed from the abandoned turn" }] },
			}),
		);
		fixture.send(correlationlessAssistantFrame("stale message ingress marker"));
		await waitFor(() => textChunks(fixture.updates) > chunks, "stale message frame ingress");

		// The live turn has emitted only `agent_start`: its own model call is still unanswered, so
		// the inference bound owns it. A frame belonging to a settled turn cannot clear that.
		expect(fixture.clock.armed).toEqual(armedBefore);
		expect(fixture.clock.armed?.at).toBe(fixture.clock.now() + ACP_PROMPT_INFERENCE_TIMEOUT_MS);
		fixture.clock.advance(ACP_PROMPT_INACTIVITY_TIMEOUT_MS + 1);
		await Bun.sleep(10);
		expect(settled).toBe(false);

		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "prompt completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("a settled turn's stale tool start does not pin the live turn to the tool bound", async () => {
	const fixture = await createFixture();
	try {
		const { stale, pending } = await abandonTurnThenStartAnother(fixture);

		const armedBefore = fixture.clock.armed;
		const chunks = textChunks(fixture.updates);
		fixture.send(
			staleEventFrame(stale, "tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "stale-turn-tool",
				toolName: "bash",
				args: { command: "sleep 100000" },
			}),
		);
		fixture.send(correlationlessAssistantFrame("stale tool ingress marker"));
		await waitFor(() => textChunks(fixture.updates) > chunks, "stale tool frame ingress");

		// Nothing is executing on the live turn, so the hour-wide tool bound must stay retired:
		// borrowing it from a settled turn would blind the safety net to a dead producer.
		expect(fixture.clock.armed).toEqual(armedBefore);
		expect(fixture.clock.armed?.at).toBe(fixture.clock.now() + ACP_PROMPT_INFERENCE_TIMEOUT_MS);
		fixture.clock.advance(ACP_PROMPT_INFERENCE_TIMEOUT_MS + 1);
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
		expect(message).toContain(`${Math.round(ACP_PROMPT_INFERENCE_TIMEOUT_MS / 1_000)}s of silence`);
	} finally {
		fixture.dispose();
	}
});

test("correlationless frames do not refresh the active prompt watchdog", async () => {
	const fixture = await createFixture();
	try {
		const { pending } = await startTurn(fixture);
		const armedBefore = fixture.clock.armed;
		if (!armedBefore) throw new Error("Expected an armed prompt watchdog");

		// Heartbeats and session-scoped events carry no command/turn identity. They can be
		// published as session activity, but must not be attributed to this prompt's watchdog.
		const chunks = textChunks(fixture.updates);
		fixture.send({ type: "activity", sessionId: fixture.sessionId, state: "idle" });
		fixture.send(correlationlessAssistantFrame("unowned"));
		await waitFor(() => textChunks(fixture.updates) > chunks, "correlationless frame ingress");

		expect(fixture.clock.armed).toEqual(armedBefore);
		fixture.clock.advance(armedBefore.at - fixture.clock.now() + 1);
		const error = await bounded(
			pending.then(
				() => undefined,
				(reason: unknown) => reason,
			),
			"watchdog rejection",
		);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain(`${Math.round(ACP_PROMPT_INFERENCE_TIMEOUT_MS / 1_000)}s of silence`);
		expect(message).toContain('"agent_start"');
		const idleToolUpdates = toolCallUpdates(fixture.updates);
		expect(fixture.clock.pending).toBe(0);
		fixture.send({
			type: "event",
			payload: {
				event_type: "tool_execution_end",
				event: {
					type: "tool_execution_end",
					toolCallId: "idle-session-tool",
					toolName: "bash",
					isError: false,
					result: { content: [{ type: "text", text: "idle session event" }] },
				},
			},
		});
		await waitFor(() => toolCallUpdates(fixture.updates) === idleToolUpdates + 1, "idle correlationless publication");
		expect(fixture.clock.pending).toBe(0);
	} finally {
		fixture.dispose();
	}
});

test("correlationless assistant text does not consume the prompt final text", async () => {
	const fixture = await createFixture();
	try {
		const { pending } = await startTurn(fixture);
		const chunksBefore = textChunks(fixture.updates);
		const correlationlessText = "CORRELATIONLESS_SESSION_TEXT";
		const finalText = "AUTHORITATIVE_PROMPT_FINAL_TEXT";

		fixture.send(correlationlessAssistantFrame(correlationlessText));
		await waitFor(() => textChunks(fixture.updates) === chunksBefore + 1, "correlationless assistant publication");
		const { commandId, turnId } = fixture.correlation();
		fixture.send({
			type: "agent_end",
			sessionId: fixture.sessionId,
			commandId,
			turnId,
			finalText,
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});

		expect(await bounded(pending, "prompt completion")).toEqual({ stopReason: "end_turn" });
		const published = fixture.updates
			.filter(update => update.update.sessionUpdate === "agent_message_chunk")
			.map(update => (update.update as { content: { text: string } }).content.text);
		expect(published.slice(-2)).toEqual([correlationlessText, finalText]);
	} finally {
		fixture.dispose();
	}
});

test("conflicting frame and event identities do not publish or refresh the active prompt", async () => {
	const fixture = await createFixture();
	try {
		const { pending } = await startTurn(fixture);
		const armedBefore = fixture.clock.armed;
		if (!armedBefore) throw new Error("Expected an armed prompt watchdog");
		const { commandId, turnId } = fixture.correlation();
		const chunksBefore = textChunks(fixture.updates);
		const updateBoundary = fixture.updates.length;
		const privateMessage = "PRIVATE_CONFLICTING_IDENTITY_SENTINEL";

		fixture.send({
			type: "event",
			commandId,
			turnId,
			payload: {
				event_type: "message_end",
				event: {
					type: "message_end",
					commandId: "foreign-command",
					turnId: "foreign-turn",
					message: { role: "assistant", content: [{ type: "text", text: privateMessage }] },
				},
			},
		});
		fixture.send(correlationlessAssistantFrame("conflicting identity ingress marker"));
		await waitFor(() => textChunks(fixture.updates) > chunksBefore, "conflicting identity frame ingress");

		expect(textChunks(fixture.updates)).toBe(chunksBefore + 1);
		expect(JSON.stringify(fixture.updates.slice(updateBoundary))).not.toContain(privateMessage);
		expect(fixture.clock.armed).toEqual(armedBefore);
		fixture.clock.advance(armedBefore.at - fixture.clock.now() + 1);
		const error = await bounded(
			pending.then(
				() => undefined,
				(reason: unknown) => reason,
			),
			"watchdog rejection",
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('"agent_start"');
	} finally {
		fixture.dispose();
	}
});
test("a pre-ack agent_start keeps the live prompt on the inference bound", async () => {
	const fixture = await createFixture({ agentStartBeforeAcknowledgement: true });
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

		fixture.clock.advance(ACP_PROMPT_INACTIVITY_TIMEOUT_MS + 1);
		await Bun.sleep(10);
		expect(settled).toBe(false);

		fixture.clock.advance(ACP_PROMPT_INFERENCE_TIMEOUT_MS - ACP_PROMPT_INACTIVITY_TIMEOUT_MS);
		const error = await bounded(
			pending.then(
				() => undefined,
				(reason: unknown) => reason,
			),
			"watchdog rejection",
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(`${Math.round(ACP_PROMPT_INFERENCE_TIMEOUT_MS / 1_000)}s of silence`);
	} finally {
		fixture.dispose();
	}
});
