import { expect, setDefaultTimeout, test, vi } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection, PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { logger, TempDir } from "@gajae-code/utils";
import { AcpAgent } from "../../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../../src/sdk/broker/discovery";
import {
	type ExactSessionAuthorityFixture,
	type ExactSessionAuthorityOptions,
	prepareExactSessionAuthority,
	publishExactSessionAuthority,
} from "../helpers/sdk-exact-session-authority";

setDefaultTimeout(75_000);

type TestSocket = { send(message: string): void };
type StoppedReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

type Fixture = {
	agent: AcpAgent;
	sessionId: string;
	updates: SessionNotification[];
	promptDelivered: Promise<void>;
	abortDelivered: Promise<void>;
	promptDeliveryCount(): number;
	sendStopped(reason: StoppedReason): void;
	sendFailed(code: string): void;
	sendToolStart(toolCallId: string): void;
	sendToolEnd(toolCallId: string): void;
	/** Emits a `hello` with a NEW connectionId, simulating an SDK transport identity change. */
	reconnect(): void;
	/** Rejects the still-pending turn.prompt control request with a control error. */
	rejectPendingPromptAcknowledgement(): void;
	/** Whether a prompt control request is currently awaiting an acknowledgement. */
	hasPendingPromptAcknowledgement(): boolean;
	/** Simulates a wedged ACP client transport: every subsequent session/update write never settles. */
	hangSessionUpdates(): void;
	/** Releases a previously hung session/update transport. */
	releaseSessionUpdates(): void;
	sendIdle(): void;
	dispose(): void;
	queryCalls: string[];
	sendTerminal(frame: Record<string, unknown>): void;
};

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(60_000).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

/** ACP `session_info_update` frames that release the client's running phase. */
function idlePhaseUpdates(updates: SessionNotification[]): number {
	return updates.filter(
		update =>
			update.update.sessionUpdate === "session_info_update" &&
			(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
	).length;
}

function idleWithGjcRunningFalse(updates: SessionNotification[]): number {
	return updates.filter(
		update =>
			update.update.sessionUpdate === "session_info_update" &&
			(update.update as { _meta?: { gjcRunning?: boolean } })._meta?.gjcRunning === false,
	).length;
}

export function createFixture(
	options: {
		cancelSettlementGraceMs?: number;
		deferPromptAcknowledgement?: boolean;
		abortAcknowledgement?:
			| Record<string, unknown>
			| (() => Record<string, unknown> | Promise<Record<string, unknown>>);
	} = {},
): Promise<Fixture> {
	return (async () => {
		const tempDir = TempDir.createSync("@acp-cancel-settlement-");
		const agentDir = path.join(tempDir.path(), "agent");
		const cwd = path.join(tempDir.path(), "workspace");
		const token = "acp-cancel-settlement-token";
		const sessionId = "cancel-settlement-session";
		const updates: SessionNotification[] = [];
		const queryCalls: string[] = [];
		const delivered = Promise.withResolvers<void>();
		const abortDelivered = Promise.withResolvers<void>();
		const abort = new AbortController();
		let promptSocket: TestSocket | undefined;
		let server!: ReturnType<typeof Bun.serve>;
		let pendingPromptAck: { socket: TestSocket; id: unknown } | undefined;
		let deferredPromptAckUsed = false;
		let hangUpdates = false;
		let promptNumber = 0;
		const releaseHang = Promise.withResolvers<void>();
		const activeCorrelation = () => ({
			commandId: `cancel-settlement-command-${promptNumber}`,
			turnId: `cancel-settlement-turn-${promptNumber}`,
		});

		const send = (frame: Record<string, unknown>): void => {
			if (!promptSocket) throw new Error("Expected prompt socket");
			promptSocket.send(JSON.stringify(frame));
		};
		const sendTerminal = (frame: Record<string, unknown>): void => send(frame);
		const sendStopped = (reason: StoppedReason): void => {
			const correlation = activeCorrelation();
			send({
				type: "agent_end",
				sessionId,
				...correlation,
				outcome: { kind: "stopped", reason, provenance: reason === "cancelled" ? "client_cancel" : "agent" },
			});
		};
		const sendFailed = (code: string): void => {
			const correlation = activeCorrelation();
			send({
				type: "agent_failed",
				sessionId,
				...correlation,
				outcome: {
					kind: "failed",
					code,
					message: `${code} from fixture`,
					provenance: code === "prompt_failed" ? "agent_failed" : "deadline",
				},
			});
		};
		const sendToolStart = (toolCallId: string): void => {
			const correlation = activeCorrelation();
			send({
				type: "event",
				kind: "tool_execution_start",
				sessionId,
				...correlation,
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
			const correlation = activeCorrelation();
			send({
				type: "event",
				kind: "tool_execution_end",
				sessionId,
				...correlation,
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
					socket.send(JSON.stringify({ type: "hello", connectionId: "acp-cancel-settlement" }));
				},
				async message(socket, raw) {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					if (frame.type === "register_provider") {
						socket.send(
							JSON.stringify({ type: "register_provider_result", id: frame.id, ok: true, leaseId: "lease" }),
						);
						return;
					}
					if (frame.type === "broker_request") {
						socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: authority }));
						setTimeout(() => void publishExactSessionAuthority(authorityOptions, authority), 10);
						return;
					}
					if (frame.type === "query_request") {
						queryCalls.push(String(frame.query));
						const items =
							frame.query === "config.list/get"
								? [{ mode: "default", model: "openai/gpt", thinking: "medium" }]
								: frame.query === "models.list/current"
									? [{ provider: "openai", id: "gpt", name: "GPT" }]
									: frame.query === "providers.list/active"
										? [{ provider: "openai", connectionKind: "credential" }]
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
						promptNumber++;
						delivered.resolve();
						if (options.deferPromptAcknowledgement && !deferredPromptAckUsed) {
							deferredPromptAckUsed = true;
							pendingPromptAck = { socket, id: frame.id };
							return;
						}
					}
					if (frame.operation === "turn.abort") abortDelivered.resolve();
					const correlation = activeCorrelation();
					const abortAcknowledgement =
						frame.operation === "turn.abort" && typeof options.abortAcknowledgement === "function"
							? await options.abortAcknowledgement()
							: options.abortAcknowledgement;
					socket.send(
						JSON.stringify({
							type: "control_response",
							id: frame.id,
							ok: true,
							result:
								frame.operation === "turn.prompt"
									? { ...correlation, accepted: true }
									: frame.operation === "turn.abort"
										? (abortAcknowledgement ??
											(() => {
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
											})())
										: {},
						}),
					);
					if (frame.operation === "turn.prompt" && !options.deferPromptAcknowledgement) {
						// The host starts the turn; the client observes the working phase.
						socket.send(JSON.stringify({ type: "agent_start", sessionId, ...correlation }));
					}
				},
			},
		});
		const port = server.port;
		if (port === undefined) throw new Error("Expected ACP fixture server port");
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
				sessionUpdate: async (update: SessionNotification) => {
					updates.push(update);
					if (hangUpdates) await releaseHang.promise;
				},
				signal: abort.signal,
				closed: Promise.withResolvers<void>().promise,
			} as unknown as AgentSideConnection,
			{
				agentDir,
				...(options.cancelSettlementGraceMs === undefined
					? {}
					: { cancelSettlementGraceMs: options.cancelSettlementGraceMs }),
			},
		);
		const created = await bounded(agent.newSession({ cwd, mcpServers: [] }), "new session");
		await waitFor(() => idlePhaseUpdates(updates) > 0, "bootstrap update");

		return {
			agent,
			sessionId: created.sessionId,
			updates,
			promptDelivered: delivered.promise,
			abortDelivered: abortDelivered.promise,
			promptDeliveryCount: () => promptNumber,
			sendStopped,
			sendFailed,
			sendToolStart,
			sendToolEnd,
			reconnect: () => send({ type: "hello", connectionId: "acp-cancel-settlement-reconnected", sessionId }),
			rejectPendingPromptAcknowledgement: () => {
				const pending = pendingPromptAck;
				if (!pending) throw new Error("Expected a pending prompt acknowledgement");
				pendingPromptAck = undefined;
				pending.socket.send(
					JSON.stringify({
						type: "control_response",
						id: pending.id,
						ok: false,
						error: { code: -32603, message: "turn aborted before acknowledgement" },
					}),
				);
			},
			hasPendingPromptAcknowledgement: () => pendingPromptAck !== undefined,
			hangSessionUpdates: () => {
				hangUpdates = true;
			},
			releaseSessionUpdates: () => {
				hangUpdates = false;
				releaseHang.resolve();
			},
			sendIdle,
			queryCalls,
			sendTerminal,
			dispose: () => {
				releaseHang.resolve();
				abort.abort();
				server.stop(true);
				tempDir.removeSync();
			},
		};
	})();
}

function prompt(fixture: Fixture, text: string): Promise<{ stopReason: StoppedReason }> {
	return fixture.agent.prompt({
		sessionId: fixture.sessionId,
		messageId: "00000000-0000-4000-8000-000000000001",
		prompt: [{ type: "text", text }],
	} as PromptRequest) as Promise<{ stopReason: StoppedReason }>;
}

// Issue #4324 regression contract: prompt with complete correlation, correlated async/tool
// activity outstanding, session/cancel ACK'd, terminal suppressed past the cancellation
// settlement grace, exact-once cancelled settlement, second prompt accepted, late terminal
// fenced, idle/gjcRunning consistent.
test("cancel ACK with a suppressed terminal settles the prompt exactly once as cancelled after grace", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 25 });
	try {
		let settleCount = 0;
		const pending = prompt(fixture, "cancel with suppressed terminal").then(result => {
			settleCount++;
			return result;
		});
		await bounded(fixture.promptDelivered, "prompt delivery");
		// The turn owns correlated async activity; keep a tool call outstanding.
		fixture.sendToolStart("tool-1");
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "cancel acknowledgement");
		const idleRunningFalseBeforeSettle = idleWithGjcRunningFalse(fixture.updates);
		expect(await bounded(pending, "cancelled settlement")).toEqual({ stopReason: "cancelled" });
		expect(settleCount).toBe(1);
		// The cancelled settlement releases the running phase exactly once.
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleRunningFalseBeforeSettle,
			"cancelled-settlement idle with gjcRunning false",
		);
		// The next prompt must be accepted, not refused with `conflict`.
		const next = prompt(fixture, "prompt after cancel");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "second prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "prompt after cancel")).toEqual({ stopReason: "end_turn" });
		const idleBeforeSecond = idlePhaseUpdates(fixture.updates);
		await waitFor(() => idlePhaseUpdates(fixture.updates) > idleBeforeSecond, "second-turn end-of-turn idle");
	} finally {
		fixture.dispose();
	}
});

test("a late terminal after cancelled settlement stays closed and cannot double-settle", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 25 });
	const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
	try {
		let settleCount = 0;
		const pending = prompt(fixture, "cancel then late terminal").then(result => {
			settleCount++;
			return result;
		});
		await bounded(fixture.promptDelivered, "prompt delivery");
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "cancel acknowledgement");
		expect(await bounded(pending, "cancelled settlement")).toEqual({ stopReason: "cancelled" });
		expect(settleCount).toBe(1);
		await waitFor(() => idlePhaseUpdates(fixture.updates) > 1, "cancelled idle publication");
		const updatesAfterSettlement = fixture.updates.length;
		const queriesAfterSettlement = fixture.queryCalls.length;
		// The aborted run's terminal arrives after the grace: it must stay closed.
		fixture.sendStopped("cancelled");
		fixture.sendFailed("prompt_failed");
		await Bun.sleep(30);
		expect(settleCount).toBe(1);
		expect(fixture.updates).toHaveLength(updatesAfterSettlement);
		expect(fixture.queryCalls).toHaveLength(queriesAfterSettlement);
		expect(errorSpy.mock.calls.some(([event]) => event === "acp_prompt_terminal_dropped")).toBe(false);
	} finally {
		errorSpy.mockRestore();
		fixture.dispose();
	}
});

test("an SDK transport identity change around cancellation settlement does not leave the turn active", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 5_000 });
	try {
		let settleCount = 0;
		let settled: { stopReason: StoppedReason } | undefined;
		const pending = prompt(fixture, "cancel across reconnect").then(result => {
			settleCount++;
			settled = result;
			return result;
		});
		await bounded(fixture.promptDelivered, "prompt delivery");
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "cancel acknowledgement");
		// SDK WebSocket reconnect around cancellation settlement (issue suspected path).
		fixture.reconnect();
		const result = await bounded(pending, "cancelled settlement after reconnect");
		expect(settleCount).toBe(1);
		expect(result).toEqual({ stopReason: "cancelled" });
		expect(settled).toEqual({ stopReason: "cancelled" });
		// The turn is over; a follow-up prompt must be accepted.
		const next = prompt(fixture, "prompt after reconnect");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "second prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "prompt after reconnect")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("a reconnect before abort acknowledgement does not report the prompt as cancelled", async () => {
	const abortGate = Promise.withResolvers<void>();
	const fixture = await createFixture({
		cancelSettlementGraceMs: 5_000,
		abortAcknowledgement: async () => {
			await abortGate.promise;
			return { aborted: true };
		},
	});
	try {
		const pending = prompt(fixture, "reconnect before abort acknowledgement").then(
			resolved => ({ resolved }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		const cancel = fixture.agent.cancel({ sessionId: fixture.sessionId }).catch(() => undefined);
		await bounded(fixture.abortDelivered, "abort delivery");
		fixture.reconnect();
		expect(await Promise.race([pending, Bun.sleep(250).then(() => ({ pending: true }))])).toEqual({ pending: true });
		abortGate.resolve();
		await bounded(cancel, "abort completion");
	} finally {
		abortGate.resolve();
		fixture.dispose();
	}
});

test("a reconnect before a failed abort does not leave the prompt cancelled", async () => {
	const abortGate = Promise.withResolvers<void>();
	const fixture = await createFixture({
		cancelSettlementGraceMs: 5_000,
		abortAcknowledgement: async () => {
			await abortGate.promise;
			return { turn: "no_active_turn", terminal: "terminal_no_effect" };
		},
	});
	try {
		const pending = prompt(fixture, "reconnect before failed abort").then(
			resolved => ({ resolved }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		const cancel = fixture.agent.cancel({ sessionId: fixture.sessionId });
		const cancelOutcome = cancel.then(
			() => ({ resolved: true }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await bounded(fixture.abortDelivered, "abort delivery");
		fixture.reconnect();
		expect(await Promise.race([pending, Bun.sleep(250).then(() => ({ pending: true }))])).toEqual({ pending: true });
		abortGate.resolve();
		const abortOutcome = await bounded(cancelOutcome, "failed abort result");
		if (!("rejected" in abortOutcome)) throw new Error("Expected abort failure");
		expect(
			abortOutcome.rejected.code === "abort_unacknowledged" || abortOutcome.rejected.code === "uncertain_after_send",
		).toBe(true);
		const promptOutcome = await Promise.race([pending, Bun.sleep(250).then(() => ({ pending: true }))]);
		expect("resolved" in promptOutcome ? promptOutcome.resolved.stopReason : undefined).not.toBe("cancelled");
	} finally {
		abortGate.resolve();
		fixture.dispose();
	}
});

test("a prompt acknowledgement rejected mid-cancel still settles the prompt exactly once as cancelled and releases the phase", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 25, deferPromptAcknowledgement: true });
	try {
		let settleCount = 0;
		const pending = prompt(fixture, "cancel before prompt acknowledgement").then(result => {
			settleCount++;
			return result;
		});
		await bounded(fixture.promptDelivered, "prompt delivery");
		expect(fixture.hasPendingPromptAcknowledgement()).toBe(true);
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "cancel acknowledgement");
		// The SDK rejects the still-pending turn.prompt control request after the abort.
		fixture.rejectPendingPromptAcknowledgement();
		const runningFalseBeforeSettle = idleWithGjcRunningFalse(fixture.updates);
		expect(await bounded(pending, "cancelled settlement")).toEqual({ stopReason: "cancelled" });
		expect(settleCount).toBe(1);
		// The catch-path cancel must still release the running phase (gjcRunning:false).
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > runningFalseBeforeSettle,
			"catch-path cancelled idle with gjcRunning false",
		);
		const next = prompt(fixture, "prompt after rejected ack");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "second prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "prompt after rejected ack")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("a wedged ACP transport cannot hold the acknowledged cancel settlement hostage", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 25 });
	try {
		let settleCount = 0;
		const pending = prompt(fixture, "cancel into wedged transport").then(result => {
			settleCount++;
			return result;
		});
		await bounded(fixture.promptDelivered, "prompt delivery");
		// The client stops draining the stream: every session/update write now hangs.
		fixture.hangSessionUpdates();
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "cancel acknowledgement");
		// The prompt must settle as cancelled even though the advisory idle update can
		// never be delivered — settlement is not gated behind the transport write.
		expect(await bounded(pending, "cancelled settlement across wedged transport")).toEqual({
			stopReason: "cancelled",
		});
		expect(settleCount).toBe(1);
		// Once the client drains again, the released turn is idle and the next prompt
		// is accepted rather than refused with `conflict`.
		fixture.releaseSessionUpdates();
		await waitFor(() => idleWithGjcRunningFalse(fixture.updates) >= 1, "released idle after wedged cancel");
		const next = prompt(fixture, "prompt after wedged transport");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "second prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "prompt after wedged transport")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("idle is emitted exactly once for a cancelled settlement and stays consistent with the next turn", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 25 });
	try {
		const idleBefore = idlePhaseUpdates(fixture.updates);
		const runningFalseBefore = idleWithGjcRunningFalse(fixture.updates);
		const pending = prompt(fixture, "idle consistency");
		await bounded(fixture.promptDelivered, "prompt delivery");
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "cancel acknowledgement");
		expect(await bounded(pending, "cancelled settlement")).toEqual({ stopReason: "cancelled" });
		await waitFor(() => idleWithGjcRunningFalse(fixture.updates) > runningFalseBefore, "cancelled-settlement idle");
		expect(idlePhaseUpdates(fixture.updates)).toBe(idleBefore + 1);
		const workingBefore = fixture.updates.filter(
			update =>
				update.update.sessionUpdate === "session_info_update" &&
				(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
		).length;
		const next = prompt(fixture, "idle consistency next turn");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "second prompt delivery");
		// The host reports the new turn as working.
		await waitFor(
			() =>
				fixture.updates.filter(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				).length > workingBefore,
			"next-turn working update",
		);
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "next turn completion")).toEqual({ stopReason: "end_turn" });
		await waitFor(() => idlePhaseUpdates(fixture.updates) >= idleBefore + 2, "next-turn idle update");
	} finally {
		fixture.dispose();
	}
});
