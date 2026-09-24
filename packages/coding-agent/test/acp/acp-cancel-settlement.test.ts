import { expect, setDefaultTimeout, test, vi } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection, PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { logger, TempDir } from "@gajae-code/utils";
import packageJson from "../../package.json" with { type: "json" };
import { AcpAgent } from "../../src/modes/acp/acp-agent";
import { AcpSdkAdapter } from "../../src/sdk/acp/adapter";
import { writeBrokerDiscovery } from "../../src/sdk/broker/discovery";
import { SdkClientError } from "../../src/sdk/client";
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
	promptClientRef(): string;
	newSessionAgain(): Promise<void>;
	sendStopped(reason: StoppedReason): void;
	sendFailed(code: string): void;
	sendToolStart(toolCallId: string): void;
	sendToolEnd(toolCallId: string): void;
	/** Emits a `hello` with a NEW connectionId, simulating an SDK transport identity change. */
	reconnect(): void;
	/** Rejects the still-pending turn.prompt control request with a control error. */
	rejectPendingPromptAcknowledgement(): void;
	/** Acknowledges the still-pending turn.prompt control request with its exact correlation. */
	acknowledgePendingPrompt(correlation?: { commandId: string; turnId: string }): void;
	/** Whether a prompt control request is currently awaiting an acknowledgement. */
	hasPendingPromptAcknowledgement(): boolean;
	watchdogDeadline(): number | undefined;
	advanceWatchdog(ms: number): void;
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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
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
		deferPromptAcknowledgement?: boolean | number;
		primaryControlSurface?: "cli" | "sdk";
		liveSessionIndex?: boolean;
		virtualPromptWatchdog?: boolean;
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
		let lastPromptClientRef: string | undefined;
		let watchdogNow = 0;
		let watchdogTimerSeq = 0;
		const watchdogTimers = new Map<number, { deadline: number; handler: () => void }>();
		const promptWatchdogClock = {
			now: () => watchdogNow,
			schedule: (handler: () => void, delayMs: number): (() => void) => {
				const id = ++watchdogTimerSeq;
				watchdogTimers.set(id, { deadline: watchdogNow + delayMs, handler });
				return () => watchdogTimers.delete(id);
			},
		};
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
						const input = frame.input as Record<string, unknown> | undefined;
						const resolvingSavedSession =
							frame.operation === "session.list" && input?.resolveSessionId === sessionId;
						let result: unknown;
						if (frame.operation === "session.list") {
							result = resolvingSavedSession
								? {
										sessions: [],
										savedSession: { id: sessionId, path: path.join(cwd, "saved-session.jsonl") },
									}
								: {
										sessions: [
											{
												sessionId,
												locator: {
													cwd,
													worktreeRoot: null,
													stateRoot: path.join(cwd, ".gjc", "state"),
												},
												live: options.liveSessionIndex === true,
											},
										],
									};
						} else result = authority;
						socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result }));
						if (frame.operation === "session.create" || frame.operation === "session.resume") {
							const indexSeq = authorityIndexSeq++;
							setTimeout(
								() => void publishExactSessionAuthority({ ...authorityOptions, indexSeq }, authority),
								10,
							);
						}
						return;
					}
					if (frame.type === "query_request") {
						queryCalls.push(String(frame.query));
						if (frame.query === "runtime.capabilities") promptSocket = socket;
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
								? {
										promptTerminalOutcomeVersion: 1,
										primaryControlSurface: options.primaryControlSurface ?? "sdk",
									}
								: frame.query === "context.get"
									? { usage: { tokens: 0, contextWindow: 200_000, percent: 0, source: "test" } }
									: { page: { items, complete: true } };
						socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result }));
						return;
					}
					if (frame.type !== "control_request") return;
					if (frame.operation === "turn.prompt" || frame.operation === "skill.invoke") {
						promptSocket = socket;
						promptNumber++;
						const input = frame.input as Record<string, unknown> | undefined;
						lastPromptClientRef = typeof input?.clientRef === "string" ? input.clientRef : undefined;
						delivered.resolve();
						if (
							(options.deferPromptAcknowledgement === true && !deferredPromptAckUsed) ||
							options.deferPromptAcknowledgement === promptNumber
						) {
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
								frame.operation === "turn.prompt" || frame.operation === "skill.invoke"
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
					if (
						(frame.operation === "turn.prompt" || frame.operation === "skill.invoke") &&
						!options.deferPromptAcknowledgement
					) {
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
		let authorityIndexSeq = 1;
		await writeBrokerDiscovery(agentDir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: packageJson.version,
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
				...(options.virtualPromptWatchdog ? { promptWatchdogClock } : {}),
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
			promptClientRef: () => {
				if (!lastPromptClientRef) throw new Error("Expected a turn.prompt clientRef");
				return lastPromptClientRef;
			},
			newSessionAgain: async () => {
				await bounded(agent.newSession({ cwd, mcpServers: [] }), "new session after retirement");
			},
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
			acknowledgePendingPrompt: (correlation?: { commandId: string; turnId: string }) => {
				const pending = pendingPromptAck;
				if (!pending) throw new Error("Expected a pending prompt acknowledgement");
				pendingPromptAck = undefined;
				pending.socket.send(
					JSON.stringify({
						type: "control_response",
						id: pending.id,
						ok: true,
						result: { ...(correlation ?? activeCorrelation()), accepted: true },
					}),
				);
			},
			hasPendingPromptAcknowledgement: () => pendingPromptAck !== undefined,
			watchdogDeadline: () =>
				[...watchdogTimers.values()].reduce<number | undefined>(
					(deadline, timer) => Math.min(deadline ?? Number.POSITIVE_INFINITY, timer.deadline),
					undefined,
				),
			advanceWatchdog: (ms: number) => {
				watchdogNow += ms;
				for (;;) {
					const due = [...watchdogTimers.entries()].find(([, timer]) => timer.deadline <= watchdogNow);
					if (!due) break;
					watchdogTimers.delete(due[0]);
					due[1].handler();
				}
			},
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

type TransportRecoveryFixture = Fixture & { signalTransportFailure(error: SdkClientError): void };

async function createTransportRecoveryFixture(
	options: { deferPromptAcknowledgement?: boolean; liveSessionIndex?: boolean } = {},
): Promise<TransportRecoveryFixture> {
	const notifications: Array<(error: SdkClientError) => void> = [];
	const original = AcpSdkAdapter.prototype.onReconnectFailed;
	const registration = vi.spyOn(AcpSdkAdapter.prototype, "onReconnectFailed").mockImplementation(function (
		this: AcpSdkAdapter,
		handler,
	) {
		// The Broker adapter registers a zero-argument handler to discard itself;
		// these fixtures explicitly signal only the session-bound Error callback.
		if (handler.length > 0) notifications.push(handler);
		return original.call(this, handler);
	});
	try {
		const fixture = await createFixture(options);
		if (notifications.length === 0) throw new Error("Expected session reconnect failure subscription");
		return {
			...fixture,
			signalTransportFailure: error => {
				for (const notify of notifications) notify(error);
			},
		};
	} finally {
		registration.mockRestore();
	}
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
		let settleCount = 0;
		const pending = prompt(fixture, "reconnect before abort acknowledgement").then(
			resolved => {
				settleCount++;
				return { resolved };
			},
			(error: unknown) => {
				settleCount++;
				return { rejected: error as { code?: string } };
			},
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		const cancel = fixture.agent.cancel({ sessionId: fixture.sessionId }).catch(() => undefined);
		await bounded(fixture.abortDelivered, "abort delivery");
		fixture.reconnect();
		const promptOutcome = await bounded(pending, "connection-closed before abort acknowledgement");
		expect(promptOutcome).toEqual({
			rejected: expect.objectContaining({ code: "connection_closed" }),
		});
		expect(settleCount).toBe(1);
		abortGate.resolve();
		await bounded(cancel, "abort completion");
		expect(settleCount).toBe(1);
		expect(await bounded(pending, "retired prompt after late abort acknowledgement")).toEqual(promptOutcome);
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
		let settleCount = 0;
		const pending = prompt(fixture, "reconnect before failed abort").then(
			resolved => {
				settleCount++;
				return { resolved };
			},
			(error: unknown) => {
				settleCount++;
				return { rejected: error as { code?: string } };
			},
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		const cancel = fixture.agent.cancel({ sessionId: fixture.sessionId });
		const cancelOutcome = cancel.then(
			() => ({ resolved: true }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await bounded(fixture.abortDelivered, "abort delivery");
		fixture.reconnect();
		const promptOutcome = await bounded(pending, "connection-closed before failed abort acknowledgement");
		expect(promptOutcome).toEqual({
			rejected: expect.objectContaining({ code: "connection_closed" }),
		});
		expect(settleCount).toBe(1);
		abortGate.resolve();
		const abortOutcome = await bounded(cancelOutcome, "failed abort result");
		if (!("rejected" in abortOutcome)) throw new Error("Expected abort failure");
		expect(
			abortOutcome.rejected.code === "abort_unacknowledged" || abortOutcome.rejected.code === "uncertain_after_send",
		).toBe(true);
		expect(settleCount).toBe(1);
		expect(await bounded(pending, "retired prompt after failed abort acknowledgement")).toEqual(promptOutcome);
		// The synthetic hello invalidates the old Router attachment; allow its bounded
		// reconciliation to publish the successor before sending the follow-up prompt.
		await Bun.sleep(2_500);
		const next = prompt(fixture, "prompt after failed abort reconnect");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "prompt after failed abort reconnect");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "prompt after failed abort reconnect completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		abortGate.resolve();
		fixture.dispose();
	}
});

test("a failed abort during provider preflight leaves the prompt recoverable", async () => {
	const fixture = await createFixture({
		abortAcknowledgement: { turn: "no_active_turn", terminal: "terminal_no_effect" },
	});
	const providerPreflight = Promise.withResolvers<void>();
	const releaseProviderPreflight = Promise.withResolvers<void>();
	const ensureProviders = vi.spyOn(AcpSdkAdapter.prototype, "ensureProviders").mockImplementation(async () => {
		providerPreflight.resolve();
		await releaseProviderPreflight.promise;
	});
	try {
		const pending = prompt(fixture, "abort during provider preflight");
		await bounded(providerPreflight.promise, "provider preflight");
		await expect(fixture.agent.cancel({ sessionId: fixture.sessionId })).rejects.toMatchObject({
			code: "abort_unacknowledged",
		});
		releaseProviderPreflight.resolve();
		await bounded(fixture.promptDelivered, "prompt delivery after failed preflight abort");
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "prompt recovery after failed preflight abort")).toEqual({
			stopReason: "end_turn",
		});
	} finally {
		releaseProviderPreflight.resolve();
		ensureProviders.mockRestore();
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

test("uncertain abort recovers a terminal missing-receipt result as failure without replay", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 25 });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockResolvedValue({
		kind: "prompt",
		status: "terminal_ok",
		receiptState: "missing",
		commandId: "cancel-settlement-command-1",
		turnId: "cancel-settlement-turn-1",
		outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
	});
	try {
		const pending = prompt(fixture, "abort with a missing terminal receipt").then(
			resolved => ({ resolved }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				),
			"prompt start before uncertain abort",
		);
		fixture.sendToolStart("aborted-tool");
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "bounded uncertain-abort recovery");
		expect(await bounded(pending, "terminal failure recovery")).toEqual({
			rejected: expect.objectContaining({ code: "prompt_failed" }),
		});
		expect(query).toHaveBeenCalledWith("turn.result", {
			kind: "prompt",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		await waitFor(() => idleWithGjcRunningFalse(fixture.updates) > 1, "idle after terminal failure recovery");
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

const stoppedReceiptRecoveryCases: Array<{
	name: string;
	reason: string;
	receiptState: "present" | "missing";
	expected: { stopReason: StoppedReason };
}> = [
	{
		name: "refusal without receipt",
		reason: "refusal",
		receiptState: "missing",
		expected: { stopReason: "refusal" },
	},
	{
		name: "max_tokens without receipt",
		reason: "max_tokens",
		receiptState: "missing",
		expected: { stopReason: "max_tokens" },
	},
	{
		name: "refusal with receipt",
		reason: "refusal",
		receiptState: "present",
		expected: { stopReason: "refusal" },
	},
];

for (const testCase of stoppedReceiptRecoveryCases) {
	test(`uncertain abort handles ${testCase.name}`, async () => {
		const fixture = await createFixture();
		const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
			new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
				operation: "turn.abort",
			}),
		);
		const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockResolvedValue({
			kind: "prompt",
			status: "terminal_ok",
			receiptState: testCase.receiptState,
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: testCase.reason, provenance: "agent" },
		});
		try {
			const pending = prompt(fixture, `uncertain abort ${testCase.name}`).then(
				result => ({ result }),
				(error: unknown) => ({ error: error as { code?: string } }),
			);
			await bounded(fixture.promptDelivered, "prompt delivery");
			await waitFor(
				() =>
					fixture.updates.some(
						update =>
							update.update.sessionUpdate === "session_info_update" &&
							(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
					),
				"prompt start before uncertain abort",
			);
			await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "bounded uncertain-abort recovery");
			const settled = await bounded(pending, "terminal stop-reason settlement");
			expect(settled).toEqual({ result: testCase.expected });
			expect(query).toHaveBeenCalledWith("turn.result", {
				kind: "prompt",
				commandId: "cancel-settlement-command-1",
				turnId: "cancel-settlement-turn-1",
			});
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(fixture.promptDeliveryCount()).toBe(1);
		} finally {
			cancel.mockRestore();
			query.mockRestore();
			fixture.dispose();
		}
	});
}

test("uncertain abort preserves the exact retained failed-result error", async () => {
	const fixture = await createFixture();
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockResolvedValue({
		kind: "prompt",
		status: "failed",
		receiptState: "missing",
		commandId: "cancel-settlement-command-1",
		turnId: "cancel-settlement-turn-1",
		error: { code: "prompt_failed", message: "The exact retained prompt failure." },
	});
	try {
		const pending = prompt(fixture, "abort with an exact failed result").then(
			() => undefined,
			(error: unknown) => error as { code?: string; message?: string },
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				),
			"prompt start before uncertain abort",
		);
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "bounded exact failed-result recovery");
		expect(await bounded(pending, "exact failed-result prompt settlement")).toEqual(
			expect.objectContaining({ code: "prompt_failed", message: "The exact retained prompt failure." }),
		);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("uncertain abort keeps ownership when turn.result exceeds its five-second deadline", async () => {
	const fixture = await createFixture();
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const queryResponse = Promise.withResolvers<Record<string, unknown>>();
	const originalQuery = AcpSdkAdapter.prototype.query;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result") return queryResponse.promise;
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const pending = prompt(fixture, "abort with a status query beyond deadline").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await waitFor(() => query.mock.calls.some(([name]) => name === "turn.result"), "bounded result query start");
		expect(await bounded(cancellation, "five-second uncertain abort deadline")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "prompt after query deadline")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(query.mock.calls.filter(([name]) => name === "turn.result")).toHaveLength(1);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);

		const blocked = await prompt(fixture, "query timeout must keep owner fenced").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);

		const idleBeforeLateTerminal = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendStopped("end_turn");
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeLateTerminal,
			"idle after exact terminal following query timeout",
		);
		const next = prompt(fixture, "prompt after exact terminal following timeout");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor after query timeout")).toEqual({ stopReason: "end_turn" });
	} finally {
		queryResponse.resolve({});
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("an acknowledged overlapping cancel keeps the uncertain abort owner fenced", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 25 });
	let cancelCalls = 0;
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockImplementation(async () => {
		cancelCalls++;
		if (cancelCalls === 1)
			throw new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
				operation: "turn.abort",
			});
		return {
			ok: true,
			selection: "turn",
			turn: "stopped",
			ownedWork: "left_running",
			automaticDelivery: "enabled",
			resumeOnOwnedCompletion: true,
		};
	});
	const queryResponse = Promise.withResolvers<Record<string, unknown>>();
	const originalQuery = AcpSdkAdapter.prototype.query;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result") return queryResponse.promise;
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		let promptSettled = false;
		const pending = prompt(fixture, "two cancel acknowledgements with one uncertain abort").then(
			resolved => {
				promptSettled = true;
				return { resolved };
			},
			(error: unknown) => {
				promptSettled = true;
				return { rejected: error as { code?: string } };
			},
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				),
			"prompt start before uncertain abort",
		);
		fixture.sendToolStart("overlapping-cancel-pending-tool");
		const firstCancel = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => ({ resolved: true }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await waitFor(() => query.mock.calls.length === 1, "first cancel recovery query");
		const runningFalseBeforeSecondCancel = idleWithGjcRunningFalse(fixture.updates);
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "second cancel acknowledgement");
		expect(cancelCalls).toBe(2);
		await Bun.sleep(60);
		expect(promptSettled).toBe(false);
		expect(idleWithGjcRunningFalse(fixture.updates)).toBe(runningFalseBeforeSecondCancel);

		const blocked = await prompt(fixture, "must remain fenced after overlapping cancel").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);
		const workingBeforeUnresolvedResult = fixture.updates.filter(
			update =>
				update.update.sessionUpdate === "session_info_update" &&
				(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
		).length;
		queryResponse.resolve({
			kind: "prompt",
			status: "in_flight",
			receiptState: "absent",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		expect(await bounded(pending, "uncertain prompt settlement")).toEqual({
			rejected: expect.objectContaining({ code: "terminal_uncertain" }),
		});
		expect(await bounded(firstCancel, "first uncertain cancel result")).toEqual({
			rejected: expect.objectContaining({ code: "terminal_uncertain" }),
		});
		await waitFor(
			() =>
				fixture.updates.filter(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				).length > workingBeforeUnresolvedResult,
			"background owner remains reported as working",
		);

		const idleBeforeLateTerminal = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendStopped("end_turn");
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeLateTerminal,
			"idle after exact late terminal",
		);
		const next = prompt(fixture, "prompt after overlapping abort terminal");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		queryResponse.resolve({});
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

const exactReportedTerminal: Record<string, unknown> = {
	kind: "prompt",
	status: "terminal_ok",
	receiptState: "present",
	commandId: "cancel-settlement-command-1",
	turnId: "cancel-settlement-turn-1",
	content: { version: 1, type: "text", text: "retained", byteLength: 8, truncated: false },
	outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
};

const invalidUncertainAbortResults: Array<{ name: string; result: Record<string, unknown> }> = [
	{ name: "wrong invocation kind", result: { ...exactReportedTerminal, kind: "skill" } },
	{ name: "wrong session", result: { ...exactReportedTerminal, sessionId: "another-session" } },
	{ name: "wrong client reference", result: { ...exactReportedTerminal, clientRef: "another-client" } },
	{ name: "wrong command id", result: { ...exactReportedTerminal, commandId: "another-command" } },
	{ name: "wrong turn id", result: { ...exactReportedTerminal, turnId: "another-turn" } },
	{ name: "blank turn id", result: { ...exactReportedTerminal, turnId: "" } },
	{ name: "malformed command id", result: { ...exactReportedTerminal, commandId: 42 } },
	{
		name: "conflicting envelope and result identities",
		result: {
			kind: "prompt",
			commandId: "outer-command",
			turnId: "cancel-settlement-turn-1",
			result: exactReportedTerminal,
		},
	},
];

for (const invalid of invalidUncertainAbortResults) {
	test(`uncertain abort retains ownership for ${invalid.name} turn.result identity`, async () => {
		const fixture = await createFixture({ cancelSettlementGraceMs: 25 });
		const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
			new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
				operation: "turn.abort",
			}),
		);
		const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockResolvedValue(invalid.result);
		try {
			const pending = prompt(fixture, `abort with ${invalid.name}`).then(
				resolved => ({ resolved }),
				(error: unknown) => ({ rejected: error as { code?: string } }),
			);
			await bounded(fixture.promptDelivered, "prompt delivery");
			await waitFor(
				() =>
					fixture.updates.some(
						update =>
							update.update.sessionUpdate === "session_info_update" &&
							(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
					),
				"prompt start before uncertain abort",
			);
			fixture.sendToolStart("invalid-result-pending-tool");
			await expect(fixture.agent.cancel({ sessionId: fixture.sessionId })).rejects.toMatchObject({
				code: "terminal_uncertain",
			});
			expect(await bounded(pending, "fenced prompt settlement")).toEqual({
				rejected: expect.objectContaining({ code: "terminal_uncertain" }),
			});
			expect(query).toHaveBeenCalledWith("turn.result", {
				kind: "prompt",
				commandId: "cancel-settlement-command-1",
				turnId: "cancel-settlement-turn-1",
			});
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(fixture.promptDeliveryCount()).toBe(1);

			const blocked = await prompt(fixture, "invalid evidence must not release the owner").then(
				() => undefined,
				(error: unknown) => error as { code?: string },
			);
			expect(blocked).toEqual(expect.objectContaining({ code: "conflict" }));
			expect(fixture.promptDeliveryCount()).toBe(1);

			const idleBeforeLateTerminal = idleWithGjcRunningFalse(fixture.updates);
			fixture.sendStopped("end_turn");
			await waitFor(
				() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeLateTerminal,
				"idle after exact late terminal",
			);
			const next = prompt(fixture, "prompt after exact late terminal");
			await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
			fixture.sendStopped("end_turn");
			expect(await bounded(next, "successor prompt completion")).toEqual({ stopReason: "end_turn" });
		} finally {
			cancel.mockRestore();
			query.mockRestore();
			fixture.dispose();
		}
	});
}

test("uncertain abort keeps its unresolved owner fenced through session reattachment", async () => {
	const fixture = await createFixture({ liveSessionIndex: true, primaryControlSurface: "cli" });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result")
			return Promise.resolve({
				kind: "prompt",
				status: "in_flight",
				receiptState: "absent",
				commandId: "cancel-settlement-command-1",
				turnId: "cancel-settlement-turn-1",
			});
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const pending = prompt(fixture, "abort with unresolved terminal evidence").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				),
			"prompt start before uncertain abort",
		);
		fixture.sendToolStart("aborted-tool");
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await waitFor(() => query.mock.calls.length === 1, "single exact turn.result recovery query");
		expect(await bounded(cancellation, "bounded uncertain-abort recovery")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "uncertain prompt settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(query).toHaveBeenCalledWith("turn.result", {
			kind: "prompt",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);

		const blocked = await prompt(fixture, "must not overtake uncertain turn").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);

		await bounded(fixture.agent.closeSession({ sessionId: fixture.sessionId }), "local session detach");
		await fixture.newSessionAgain();
		const blockedAfterReattach = await prompt(fixture, "must remain fenced after reattachment").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blockedAfterReattach).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);

		const idleBeforeLateTerminal = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendStopped("end_turn");
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeLateTerminal,
			"idle after exact late terminal",
		);
		const next = prompt(fixture, "prompt after exact terminal");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor prompt completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("uncertain abort transport callback recovers an exact missing-receipt terminal", async () => {
	const fixture = await createTransportRecoveryFixture();
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockResolvedValue({
		...exactReportedTerminal,
		receiptState: "missing",
		content: undefined,
	});
	try {
		const pending = prompt(fixture, "abort recovery from the transport callback").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				),
			"prompt start before transport uncertainty",
		);
		fixture.sendToolStart("callback-pending-tool");
		fixture.signalTransportFailure(
			new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
				operation: "turn.abort",
			}),
		);
		expect(await bounded(pending, "callback terminal recovery")).toEqual(
			expect.objectContaining({ code: "prompt_failed" }),
		);
		expect(query).toHaveBeenCalledWith("turn.result", {
			kind: "prompt",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		expect(fixture.promptDeliveryCount()).toBe(1);
		await waitFor(() => idleWithGjcRunningFalse(fixture.updates) > 1, "idle after callback recovery");
	} finally {
		query.mockRestore();
		fixture.dispose();
	}
});

test("uncertain provider transport notification does not reconcile the active prompt", async () => {
	const fixture = await createTransportRecoveryFixture();
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query");
	try {
		const pending = prompt(fixture, "unrelated provider uncertainty");
		await bounded(fixture.promptDelivered, "prompt delivery");
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				),
			"prompt start before unrelated transport uncertainty",
		);
		fixture.signalTransportFailure(
			new SdkClientError("uncertain_after_send", "Provider registration response was lost after dispatch.", {
				operation: "register_provider",
			}),
		);
		expect(query).not.toHaveBeenCalledWith("turn.result", expect.anything());
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "active prompt completion")).toEqual({ stopReason: "end_turn" });
		expect(fixture.promptDeliveryCount()).toBe(1);
	} finally {
		query.mockRestore();
		fixture.dispose();
	}
});

test("an exact terminal reserved during recovery cannot let a stale query settle its successor", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 25 });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const queryResponse = Promise.withResolvers<Record<string, unknown>>();
	const originalQuery = AcpSdkAdapter.prototype.query;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result") return queryResponse.promise;
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const first = prompt(fixture, "terminal races the uncertain abort lookup").then(
			resolved => ({ resolved }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await bounded(fixture.promptDelivered, "first prompt delivery");
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				),
			"first prompt start",
		);
		fixture.sendToolStart("terminal-race-pending-tool");
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => ({ resolved: true }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await waitFor(() => query.mock.calls.length === 1, "deferred exact recovery query");
		fixture.sendStopped("end_turn");
		expect(await bounded(first, "reserved exact terminal")).toEqual({ resolved: { stopReason: "cancelled" } });
		await waitFor(() => idleWithGjcRunningFalse(fixture.updates) > 1, "idle after reserved terminal");

		let successorSettled = false;
		const successor = prompt(fixture, "successor after exact terminal").then(result => {
			successorSettled = true;
			return result;
		});
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: fixture.sessionId,
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		fixture.sendToolStart("successor-after-duplicate-probe");
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "tool_call" &&
						(update.update as { toolCallId?: string }).toolCallId === "successor-after-duplicate-probe",
				),
			"successor frame after duplicate terminal",
		);
		queryResponse.resolve({
			kind: "prompt",
			status: "in_flight",
			receiptState: "absent",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		expect(await bounded(cancellation, "cancellation after exact terminal")).toEqual({ resolved: true });
		await Bun.sleep(20);
		expect(successorSettled).toBe(false);
		expect(fixture.promptDeliveryCount()).toBe(2);
		fixture.sendStopped("end_turn");
		expect(await bounded(successor, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		queryResponse.resolve({});
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("an invalid correlated terminal keeps an uncertain abort owner background-fenced", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 25 });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const queryResponse = Promise.withResolvers<Record<string, unknown>>();
	const originalQuery = AcpSdkAdapter.prototype.query;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result") return queryResponse.promise;
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const pending = prompt(fixture, "malformed terminal during uncertain abort recovery").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				),
			"prompt start before uncertain abort",
		);
		fixture.sendToolStart("malformed-terminal-pending-tool");
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await waitFor(() => query.mock.calls.length === 1, "deferred exact recovery query");
		const workingUpdatesBeforeMalformed = fixture.updates.filter(
			update =>
				update.update.sessionUpdate === "session_info_update" &&
				(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
		).length;
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: fixture.sessionId,
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: "not_a_terminal_reason", provenance: "agent" },
		});
		expect(await bounded(pending, "invalid terminal rejection")).toMatchObject({ code: "connection_closed" });
		await waitFor(
			() =>
				fixture.updates.filter(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				).length > workingUpdatesBeforeMalformed,
			"background owner remains reported as working",
		);
		const blocked = await prompt(fixture, "malformed terminal must not release uncertain owner").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);
		queryResponse.resolve({
			kind: "prompt",
			status: "in_flight",
			receiptState: "absent",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		expect(await bounded(cancellation, "uncertain abort query result")).toMatchObject({
			code: "terminal_uncertain",
		});

		const idleBeforeValidTerminal = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendStopped("end_turn");
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeValidTerminal,
			"idle after valid late terminal",
		);
		const next = prompt(fixture, "prompt after valid late terminal");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		queryResponse.resolve({});
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("uncertain abort before prompt acknowledgement promotes clientRef recovery across reattachment", async () => {
	const fixture = await createFixture({
		deferPromptAcknowledgement: true,
		liveSessionIndex: true,
		primaryControlSurface: "cli",
	});
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	let clientRef = "";
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result")
			return Promise.resolve({
				kind: "prompt",
				status: "in_flight",
				receiptState: "absent",
				clientRef,
				commandId: "cancel-settlement-command-1",
				turnId: "cancel-settlement-turn-1",
			});
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const pending = prompt(fixture, "abort before prompt acknowledgement").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt acknowledgement");
		clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "clientRef abort recovery")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "uncertain pre-ack prompt settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "prompt", clientRef });
		expect(query).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		fixture.rejectPendingPromptAcknowledgement();

		const blocked = await prompt(fixture, "pre-ack abort must keep successor fenced").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);

		await bounded(fixture.agent.closeSession({ sessionId: fixture.sessionId }), "local CLI detach");
		await fixture.newSessionAgain();
		const blockedAfterReattach = await prompt(fixture, "pre-ack abort remains fenced after reattachment").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blockedAfterReattach).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);

		const idleBeforeLateTerminal = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendStopped("end_turn");
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeLateTerminal,
			"idle after pre-ack abort terminal",
		);
		const next = prompt(fixture, "prompt after pre-ack abort terminal");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor prompt completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("pre-ack clientRef recovery maps terminal end_turn without receipt to prompt_failed", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	let clientRef = "";
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result")
			return Promise.resolve({
				kind: "prompt",
				status: "terminal_ok",
				receiptState: "missing",
				clientRef,
				commandId: "cancel-settlement-command-1",
				turnId: "cancel-settlement-turn-1",
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			});
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const pending = prompt(fixture, "pre-ack missing-receipt terminal").then(
			result => ({ result }),
			(error: unknown) => ({ error: error as { code?: string } }),
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt ACK");
		clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => ({ resolved: true }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		expect(await bounded(cancellation, "clientRef missing-receipt recovery")).toEqual({ resolved: true });
		expect(await bounded(pending, "pre-ack prompt failure")).toEqual({
			error: expect.objectContaining({ code: "prompt_failed" }),
		});
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "prompt", clientRef });
		expect(query).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		fixture.rejectPendingPromptAcknowledgement();
		const next = prompt(fixture, "prompt after pre-ack missing-receipt failure");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("uncertain skill invocation uses kind-specific clientRef recovery and retains its owner", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	let clientRef = "";
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result")
			return Promise.resolve({
				kind: "skill",
				status: "in_flight",
				receiptState: "absent",
				clientRef,
				commandId: "cancel-settlement-command-1",
				turnId: "cancel-settlement-turn-1",
			});
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const pending = prompt(fixture, "/skill:fixture-skill run").then(
			result => ({ result }),
			(error: unknown) => ({ error: error as { code?: string } }),
		);
		await bounded(fixture.promptDelivered, "skill invocation dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred skill invocation ACK");
		clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => ({ resolved: true }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		expect(await bounded(cancellation, "skill clientRef recovery")).toEqual({
			rejected: expect.objectContaining({ code: "terminal_uncertain" }),
		});
		expect(await bounded(pending, "uncertain skill result")).toEqual({
			error: expect.objectContaining({ code: "terminal_uncertain" }),
		});
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "skill", clientRef });
		expect(query).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		fixture.rejectPendingPromptAcknowledgement();
		const blocked = await prompt(fixture, "skill owner must remain fenced").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);

		const idleBeforeLateSkillTerminal = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendStopped("end_turn");
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeLateSkillTerminal,
			"idle after exact skill terminal",
		);
		const next = prompt(fixture, "prompt after skill terminal proof");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("uncertain abort before prompt acknowledgement keeps a provisional owner if clientRef lookup fails", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockRejectedValue(new Error("fixture query unavailable"));
	try {
		const pending = prompt(fixture, "abort before ack with unavailable status").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt acknowledgement");
		const clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "unavailable clientRef recovery")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "unavailable pre-ack prompt settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "prompt", clientRef });
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		fixture.rejectPendingPromptAcknowledgement();
		const blocked = await prompt(fixture, "unavailable clientRef result must keep the owner").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("an in-flight clientRef result reconciles an exact terminal already deferred before ACK", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const queryResponse = Promise.withResolvers<Record<string, unknown>>();
	const originalQuery = AcpSdkAdapter.prototype.query;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result") return queryResponse.promise;
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const pending = prompt(fixture, "deferred terminal before pre-ack recovery identity");
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt ACK");
		const clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => ({ resolved: true }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await waitFor(() => query.mock.calls.length === 1, "clientRef terminal recovery query");
		fixture.sendStopped("end_turn");
		const idleBeforeStatusIdentity = idleWithGjcRunningFalse(fixture.updates);
		await Bun.sleep(20);
		expect(idleWithGjcRunningFalse(fixture.updates)).toBe(idleBeforeStatusIdentity);
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "prompt", clientRef });
		expect(query).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		queryResponse.resolve({
			kind: "prompt",
			status: "in_flight",
			receiptState: "absent",
			clientRef,
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		expect(await bounded(pending, "deferred exact terminal settlement")).toEqual({ stopReason: "cancelled" });
		expect(await bounded(cancellation, "cancel after recovered terminal")).toEqual({ resolved: true });
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeStatusIdentity,
			"idle after exact deferred terminal reconciliation",
		);
		const next = prompt(fixture, "prompt after deferred terminal reconciliation");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
		fixture.rejectPendingPromptAcknowledgement();
	} finally {
		queryResponse.resolve({});
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("a foreign-session terminal cannot be promoted by the delayed prompt ACK", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const queryResponse = Promise.withResolvers<Record<string, unknown>>();
	const originalQuery = AcpSdkAdapter.prototype.query;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result") return queryResponse.promise;
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const pending = prompt(fixture, "reject a foreign-session terminal candidate").then(
			result => ({ result }),
			(error: unknown) => ({ error: error as { code?: string } }),
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt ACK");
		const clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => ({ resolved: true }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await waitFor(() => query.mock.calls.length === 1, "clientRef identity lookup");
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: "foreign-session",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		const idleBeforeForeignTerminal = idleWithGjcRunningFalse(fixture.updates);
		await Bun.sleep(20);
		expect(idleWithGjcRunningFalse(fixture.updates)).toBe(idleBeforeForeignTerminal);
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "prompt", clientRef });
		queryResponse.resolve({
			kind: "prompt",
			status: "in_flight",
			receiptState: "absent",
			clientRef,
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		expect(await bounded(pending, "uncertain prompt settlement")).toEqual({
			error: expect.objectContaining({ code: "terminal_uncertain" }),
		});
		expect(await bounded(cancellation, "cancel after in-flight evidence")).toEqual({
			rejected: expect.objectContaining({ code: "terminal_uncertain" }),
		});
		expect(fixture.promptDeliveryCount()).toBe(1);
		const blocked = await prompt(fixture, "foreign session must not release the owner").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		fixture.rejectPendingPromptAcknowledgement();
		fixture.sendStopped("end_turn");
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeForeignTerminal,
			"idle after the matching terminal",
		);
		const next = prompt(fixture, "prompt after foreign candidate rejection");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		queryResponse.resolve({});
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("a foreign-session terminal cannot reserve an acknowledged prompt at ingress", async () => {
	const fixture = await createFixture();
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const queryResponse = Promise.withResolvers<Record<string, unknown>>();
	const originalQuery = AcpSdkAdapter.prototype.query;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result") return queryResponse.promise;
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		let promptSettled = false;
		const pending = prompt(fixture, "reject a foreign-session terminal after prompt ACK").then(
			result => {
				promptSettled = true;
				return { result };
			},
			(error: unknown) => {
				promptSettled = true;
				return { error: error as { code?: string } };
			},
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				),
			"acknowledged prompt working phase",
		);
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => ({ resolved: true }),
			(error: unknown) => ({ rejected: error as { code?: string } }),
		);
		await waitFor(() => query.mock.calls.length === 1, "pending exact recovery read");
		const idleBeforeForeignFrame = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: "foreign-session",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		await Bun.sleep(20);
		expect(promptSettled).toBe(false);
		expect(idleWithGjcRunningFalse(fixture.updates)).toBe(idleBeforeForeignFrame);
		queryResponse.resolve({
			kind: "prompt",
			status: "in_flight",
			receiptState: "absent",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		expect(await bounded(cancellation, "uncertain result after foreign frame")).toEqual({
			rejected: expect.objectContaining({ code: "terminal_uncertain" }),
		});
		expect(await bounded(pending, "prompt remains uncertain after foreign frame")).toEqual({
			error: expect.objectContaining({ code: "terminal_uncertain" }),
		});
		const blocked = await prompt(fixture, "foreign ingress must keep owner fenced").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);

		const idleBeforeExactTerminal = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendStopped("end_turn");
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeExactTerminal,
			"idle after exact late terminal",
		);
		const next = prompt(fixture, "prompt after exact terminal following foreign frame");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		queryResponse.resolve({});
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("a foreign-session progress frame cannot refresh a matching prompt watchdog", async () => {
	const fixture = await createFixture({ virtualPromptWatchdog: true });
	const routedActivityFrames: Record<string, unknown>[] = [];
	const originalAcceptFrame = AcpSdkAdapter.prototype.acceptFrame;
	const acceptFrame = vi.spyOn(AcpSdkAdapter.prototype, "acceptFrame").mockImplementation(function (
		this: AcpSdkAdapter,
		frame,
	) {
		if (frame.type === "activity" && frame.state === "busy") routedActivityFrames.push(frame);
		return originalAcceptFrame.call(this, frame);
	});
	try {
		let settled = false;
		const pending = prompt(fixture, "foreign progress must not refresh this turn").then(
			result => {
				settled = true;
				return { result };
			},
			(error: unknown) => {
				settled = true;
				return { error: error as { code?: string } };
			},
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
				),
			"prompt start before foreign progress",
		);
		const initialDeadline = fixture.watchdogDeadline();
		if (initialDeadline === undefined) throw new Error("Expected an armed prompt watchdog");
		fixture.advanceWatchdog(initialDeadline - 1);
		fixture.sendTerminal({
			type: "event",
			kind: "message_update",
			sessionId: "foreign-session",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			payload: {
				event_type: "message_update",
				event: {
					type: "message_update",
					role: "assistant",
					content: [{ type: "text", text: "foreign activity" }],
				},
			},
		});
		fixture.sendTerminal({
			type: "event",
			kind: "message_update",
			sessionId: fixture.sessionId,
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			payload: {
				event_type: "message_update",
				event: {
					type: "message_update",
					sessionId: "foreign-session",
					role: "assistant",
					content: [{ type: "text", text: "foreign nested activity" }],
				},
			},
		});
		fixture.sendTerminal({
			type: "activity",
			sessionId: "foreign-session",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			state: "busy",
		});
		fixture.sendTerminal({
			type: "hello",
			sessionId: "foreign-session",
			connectionId: "foreign-session-connection",
		});
		await Bun.sleep(20);
		expect(settled).toBe(false);
		expect(fixture.watchdogDeadline()).toBe(initialDeadline);
		fixture.sendTerminal({
			type: "activity",
			sessionId: fixture.sessionId,
			routerSessionId: "forged-foreign-router-session",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			state: "busy",
		});
		await waitFor(() => routedActivityFrames.length > 0, "activity frame accepted from the attached session");
		expect(routedActivityFrames[routedActivityFrames.length - 1]?.routerSessionId).toBe(fixture.sessionId);
		const deadlineFromExactRouterAttachment = fixture.watchdogDeadline();
		if (deadlineFromExactRouterAttachment === undefined) throw new Error("Expected re-armed prompt watchdog");
		expect(deadlineFromExactRouterAttachment).toBeGreaterThan(initialDeadline);
		fixture.advanceWatchdog(1);
		await Bun.sleep(0);
		expect(settled).toBe(false);
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "prompt watchdog after foreign progress")).toEqual({
			result: { stopReason: "end_turn" },
		});
		expect(fixture.promptDeliveryCount()).toBe(1);
	} finally {
		acceptFrame.mockRestore();
		fixture.dispose();
	}
});

test("pre-ack clientRef recovery rejects a terminal result from another client", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	let clientRef = "";
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result")
			return Promise.resolve({
				kind: "prompt",
				status: "terminal_ok",
				receiptState: "present",
				clientRef: "foreign-client-ref",
				commandId: "cancel-settlement-command-1",
				turnId: "cancel-settlement-turn-1",
				content: { version: 1, type: "text", text: "foreign", byteLength: 7, truncated: false },
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			});
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const pending = prompt(fixture, "reject a foreign pre-ack terminal result").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt acknowledgement");
		clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "foreign clientRef recovery")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "foreign terminal prompt settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "prompt", clientRef });
		expect(query).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		fixture.rejectPendingPromptAcknowledgement();
		const blocked = await prompt(fixture, "foreign result must not release owner").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("a pre-ack terminal is reconciled only after its late acknowledgement proves identity", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result") return Promise.reject(new Error("fixture query unavailable"));
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const pending = prompt(fixture, "terminal frame before delayed prompt acknowledgement").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt acknowledgement");
		const clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "clientRef query failure")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "uncertain pre-ack prompt settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "prompt", clientRef });
		expect(query).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);

		const idleBeforeCandidate = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendStopped("end_turn");
		await Bun.sleep(20);
		expect(idleWithGjcRunningFalse(fixture.updates)).toBe(idleBeforeCandidate);
		const blockedBeforeAck = await prompt(fixture, "candidate terminal remains provisional").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blockedBeforeAck).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);

		fixture.acknowledgePendingPrompt();
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeCandidate,
			"idle after exact candidate/ACK reconciliation",
		);
		const next = prompt(fixture, "prompt after pre-ack terminal reconciliation");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("a retired prompt ACK cannot bind a provisional uncertain abort owner", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: 2 });
	const firstPrompt = prompt(fixture, "create a retired prompt correlation");
	await bounded(fixture.promptDelivered, "first prompt dispatch");
	fixture.sendStopped("end_turn");
	expect(await bounded(firstPrompt, "first prompt terminal")).toEqual({ stopReason: "end_turn" });

	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockRejectedValue(new Error("fixture query unavailable"));
	try {
		const secondPrompt = prompt(fixture, "uncertain prompt reusing a retired ACK").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await waitFor(() => fixture.promptDeliveryCount() === 2, "second prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred second prompt ACK");
		const clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "provisional owner status lookup")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(secondPrompt, "uncertain second prompt")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "prompt", clientRef });
		expect(cancel).toHaveBeenCalledTimes(1);
		fixture.acknowledgePendingPrompt({
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: fixture.sessionId,
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		await Bun.sleep(20);
		const blocked = await prompt(fixture, "retired ACK must not release uncertain owner").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(2);
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("a foreign pre-ack terminal candidate does not hide the exact terminal", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName === "turn.result") return Promise.reject(new Error("fixture query unavailable"));
		return originalQuery.call(this, queryName, input, cursor);
	});
	try {
		const pending = prompt(fixture, "multiple pre-ack terminal candidates").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt ACK");
		const clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "clientRef lookup failure")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "uncertain prompt settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "prompt", clientRef });
		const idleBeforeCandidates = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: fixture.sessionId,
			commandId: "foreign-command",
			turnId: "foreign-turn",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		fixture.sendStopped("end_turn");
		await Bun.sleep(20);
		expect(idleWithGjcRunningFalse(fixture.updates)).toBe(idleBeforeCandidates);
		const blocked = await prompt(fixture, "candidate frames stay private before ACK").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);

		fixture.acknowledgePendingPrompt();
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeCandidates,
			"exact candidate reconciled after ACK",
		);
		const next = prompt(fixture, "prompt after exact candidate");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("candidate overflow triggers one exact read-only lookup after delayed ACK", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	let resultCalls = 0;
	let clientRef = "";
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName !== "turn.result") return originalQuery.call(this, queryName, input, cursor);
		resultCalls++;
		if (resultCalls === 1) return Promise.reject(new Error("fixture clientRef lookup unavailable"));
		return Promise.resolve({
			kind: "prompt",
			status: "terminal_ok",
			receiptState: "present",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			clientRef,
			content: { version: 1, type: "text", text: "retained", byteLength: 8, truncated: false },
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
	});
	try {
		const pending = prompt(fixture, "overflow provisional terminal candidates").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt ACK");
		clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "clientRef lookup failure")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "uncertain prompt settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(resultCalls).toBe(1);
		for (let index = 0; index < 16; index++) {
			fixture.sendTerminal({
				type: "agent_end",
				sessionId: fixture.sessionId,
				commandId: `foreign-command-${index}`,
				turnId: `foreign-turn-${index}`,
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			});
		}
		fixture.sendStopped("end_turn");
		await Bun.sleep(30);
		const idleBeforeAck = idleWithGjcRunningFalse(fixture.updates);
		fixture.acknowledgePendingPrompt();
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeAck,
			"exact result lookup after candidate overflow",
		);
		expect(resultCalls).toBe(2);
		expect(query).toHaveBeenLastCalledWith("turn.result", {
			kind: "prompt",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		const next = prompt(fixture, "prompt after exact overflow recovery");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("overflow follow-up timeout retains the exact abort owner", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	const followUp = Promise.withResolvers<Record<string, unknown>>();
	let resultCalls = 0;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName !== "turn.result") return originalQuery.call(this, queryName, input, cursor);
		resultCalls++;
		return resultCalls === 1 ? Promise.reject(new Error("clientRef lookup unavailable")) : followUp.promise;
	});
	try {
		const pending = prompt(fixture, "overflow followed by an unresolved exact lookup").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt ACK");
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "clientRef lookup failure")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "provisional owner settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		for (let index = 0; index < 16; index++)
			fixture.sendTerminal({
				type: "agent_end",
				sessionId: fixture.sessionId,
				commandId: `foreign-command-${index}`,
				turnId: `foreign-turn-${index}`,
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			});
		fixture.sendStopped("end_turn");
		await Bun.sleep(30);
		fixture.acknowledgePendingPrompt();
		await waitFor(() => query.mock.calls.length === 2, "exact overflow follow-up query");
		expect(query).toHaveBeenLastCalledWith("turn.result", {
			kind: "prompt",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		const blockedWhileLookupPending = await prompt(fixture, "overflow follow-up is still pending").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blockedWhileLookupPending).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);
		await Bun.sleep(5_100);
		expect(resultCalls).toBe(2);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		const blocked = await prompt(fixture, "overflow follow-up timeout must keep owner fenced").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });

		const idleBeforeLateTerminal = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendStopped("end_turn");
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeLateTerminal,
			"idle after exact terminal following lookup timeout",
		);
		const next = prompt(fixture, "successor after exact terminal following timeout");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor after timeout")).toEqual({ stopReason: "end_turn" });
	} finally {
		followUp.resolve({});
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("overflow follow-up rejects foreign terminal identity and keeps owner fenced", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	let resultCalls = 0;
	let clientRef = "";
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName !== "turn.result") return originalQuery.call(this, queryName, input, cursor);
		resultCalls++;
		if (resultCalls === 1) return Promise.reject(new Error("clientRef lookup unavailable"));
		return Promise.resolve({
			kind: "prompt",
			status: "terminal_ok",
			receiptState: "present",
			commandId: "cancel-settlement-command-1",
			turnId: "foreign-turn",
			clientRef,
			content: { version: 1, type: "text", text: "foreign", byteLength: 7, truncated: false },
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
	});
	try {
		const pending = prompt(fixture, "overflow followed by mismatched exact lookup").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt ACK");
		clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "clientRef lookup failure")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "provisional owner settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		for (let index = 0; index < 16; index++)
			fixture.sendTerminal({
				type: "agent_end",
				sessionId: fixture.sessionId,
				commandId: `foreign-command-${index}`,
				turnId: `foreign-turn-${index}`,
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			});
		fixture.sendStopped("end_turn");
		await Bun.sleep(30);
		const idleBeforeAck = idleWithGjcRunningFalse(fixture.updates);
		fixture.acknowledgePendingPrompt();
		await waitFor(() => query.mock.calls.length === 2, "foreign exact follow-up query");
		await Bun.sleep(20);
		expect(resultCalls).toBe(2);
		expect(idleWithGjcRunningFalse(fixture.updates)).toBe(idleBeforeAck);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		const blocked = await prompt(fixture, "foreign lookup result must keep owner fenced").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });

		const idleBeforeLateTerminal = idleWithGjcRunningFalse(fixture.updates);
		fixture.sendStopped("end_turn");
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeLateTerminal,
			"idle after exact late terminal",
		);
		const next = prompt(fixture, "successor after exact late terminal");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("overflow follow-up accepts an exact retained failed terminal", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	let resultCalls = 0;
	let clientRef = "";
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName !== "turn.result") return originalQuery.call(this, queryName, input, cursor);
		resultCalls++;
		if (resultCalls === 1) return Promise.reject(new Error("clientRef lookup unavailable"));
		return Promise.resolve({
			kind: "prompt",
			status: "failed",
			receiptState: "present",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			clientRef,
			outcome: {
				kind: "failed",
				code: "prompt_failed",
				message: "The exact retained prompt failure.",
				provenance: "agent_failed",
				phase: "post_start",
			},
		});
	});
	try {
		const pending = prompt(fixture, "overflow followed by exact failed status").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt ACK");
		clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "clientRef lookup failure")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "provisional owner settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		for (let index = 0; index < 16; index++)
			fixture.sendTerminal({
				type: "agent_end",
				sessionId: fixture.sessionId,
				commandId: `foreign-command-${index}`,
				turnId: `foreign-turn-${index}`,
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			});
		fixture.sendStopped("end_turn");
		await Bun.sleep(30);
		const idleBeforeAck = idleWithGjcRunningFalse(fixture.updates);
		fixture.acknowledgePendingPrompt();
		await waitFor(() => query.mock.calls.length === 2, "exact failed-result lookup");
		await waitFor(
			() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeAck,
			"idle after exact failed-result proof",
		);
		expect(resultCalls).toBe(2);
		expect(query).toHaveBeenLastCalledWith("turn.result", {
			kind: "prompt",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		const next = prompt(fixture, "prompt after exact failed terminal proof");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("session retirement makes an overflow follow-up response stale for a recreated session", async () => {
	const fixture = await createFixture({ deferPromptAcknowledgement: true });
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const originalQuery = AcpSdkAdapter.prototype.query;
	const followUp = Promise.withResolvers<Record<string, unknown>>();
	let resultCalls = 0;
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
		this: AcpSdkAdapter,
		queryName,
		input,
		cursor,
	) {
		if (queryName !== "turn.result") return originalQuery.call(this, queryName, input, cursor);
		resultCalls++;
		return resultCalls === 1 ? Promise.reject(new Error("clientRef lookup unavailable")) : followUp.promise;
	});
	try {
		const pending = prompt(fixture, "retire session while overflow lookup is pending").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt ACK");
		const clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "clientRef lookup failure")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "provisional owner settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "prompt", clientRef });
		for (let index = 0; index < 16; index++)
			fixture.sendTerminal({
				type: "agent_end",
				sessionId: fixture.sessionId,
				commandId: `foreign-command-${index}`,
				turnId: `foreign-turn-${index}`,
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			});
		fixture.sendStopped("end_turn");
		await Bun.sleep(30);
		fixture.acknowledgePendingPrompt();
		await waitFor(() => query.mock.calls.length === 2, "pending exact overflow follow-up lookup");
		expect(query).toHaveBeenLastCalledWith("turn.result", {
			kind: "prompt",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		});
		await bounded(fixture.agent.deleteSession({ sessionId: fixture.sessionId }), "session retirement during lookup");
		await fixture.newSessionAgain();
		let successorSettled = false;
		const successor = prompt(fixture, "prompt in recreated session").then(result => {
			successorSettled = true;
			return result;
		});
		await waitFor(() => fixture.promptDeliveryCount() === 2, "recreated-session prompt dispatch");
		followUp.resolve({
			kind: "prompt",
			status: "terminal_ok",
			receiptState: "present",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			content: { version: 1, type: "text", text: "stale", byteLength: 5, truncated: false },
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: fixture.sessionId,
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		await Bun.sleep(20);
		expect(successorSettled).toBe(false);
		expect(fixture.promptDeliveryCount()).toBe(2);
		fixture.sendStopped("end_turn");
		expect(await bounded(successor, "recreated-session terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		followUp.resolve({});
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

const overflowFollowUpCases: Array<{
	name: string;
	result?: Record<string, unknown>;
	envelope?: Record<string, unknown>;
	clientRef?: string;
	rejects?: boolean;
	terminal: boolean;
}> = [
	{ name: "query rejection", rejects: true, terminal: false },
	{
		name: "in-flight status",
		result: {
			kind: "prompt",
			status: "in_flight",
			receiptState: "absent",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
		},
		terminal: false,
	},
	{
		name: "terminal missing receipt",
		result: {
			kind: "prompt",
			status: "terminal_ok",
			receiptState: "missing",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		},
		terminal: true,
	},
	{
		name: "failed receipt without normalized outcome",
		result: {
			kind: "prompt",
			status: "failed",
			receiptState: "missing",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			error: { code: "prompt_failed", message: "The retained late-ACK failure." },
		},
		terminal: true,
	},
	{
		name: "wrong invocation kind",
		result: {
			kind: "skill",
			status: "terminal_ok",
			receiptState: "present",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		},
		terminal: false,
	},
	{
		name: "wrong session",
		result: {
			kind: "prompt",
			status: "terminal_ok",
			receiptState: "present",
			sessionId: "foreign-session",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		},
		terminal: false,
	},
	{
		name: "wrong client reference",
		clientRef: "foreign-client-ref",
		result: {
			kind: "prompt",
			status: "terminal_ok",
			receiptState: "present",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		},
		terminal: false,
	},
	{
		name: "conflicting envelope and result identities",
		envelope: { kind: "prompt", commandId: "foreign-command", turnId: "cancel-settlement-turn-1" },
		result: {
			kind: "prompt",
			status: "terminal_ok",
			receiptState: "present",
			commandId: "cancel-settlement-command-1",
			turnId: "cancel-settlement-turn-1",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		},
		terminal: false,
	},
];

for (const followUpCase of overflowFollowUpCases) {
	test(`overflow follow-up ${followUpCase.name} ${followUpCase.terminal ? "releases only exact owner" : "retains owner fence"}`, async () => {
		const fixture = await createFixture({ deferPromptAcknowledgement: true });
		const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
			new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
				operation: "turn.abort",
			}),
		);
		const originalQuery = AcpSdkAdapter.prototype.query;
		let resultCalls = 0;
		let clientRef = "";
		const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(function (
			this: AcpSdkAdapter,
			queryName,
			input,
			cursor,
		) {
			if (queryName !== "turn.result") return originalQuery.call(this, queryName, input, cursor);
			resultCalls++;
			if (resultCalls === 1) return Promise.reject(new Error("clientRef lookup unavailable"));
			if (followUpCase.rejects) return Promise.reject(new Error("exact follow-up unavailable"));
			if (followUpCase.envelope)
				return Promise.resolve({
					...followUpCase.envelope,
					result: { ...followUpCase.result, clientRef: followUpCase.clientRef ?? clientRef },
				});
			return Promise.resolve({
				...followUpCase.result,
				clientRef: followUpCase.clientRef ?? clientRef,
			});
		});
		try {
			const pending = prompt(fixture, `overflow follow-up ${followUpCase.name}`).then(
				() => undefined,
				(error: unknown) => error as { code?: string },
			);
			await bounded(fixture.promptDelivered, "prompt dispatch");
			await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt ACK");
			clientRef = fixture.promptClientRef();
			const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
				() => undefined,
				(error: unknown) => error as { code?: string },
			);
			expect(await bounded(cancellation, "clientRef lookup failure")).toMatchObject({
				code: "terminal_uncertain",
			});
			expect(await bounded(pending, "provisional owner settlement")).toMatchObject({
				code: "terminal_uncertain",
			});
			for (let index = 0; index < 16; index++)
				fixture.sendTerminal({
					type: "agent_end",
					sessionId: fixture.sessionId,
					commandId: `foreign-command-${index}`,
					turnId: `foreign-turn-${index}`,
					outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
				});
			fixture.sendStopped("end_turn");
			await Bun.sleep(30);
			const idleBeforeAck = idleWithGjcRunningFalse(fixture.updates);
			fixture.acknowledgePendingPrompt();
			await waitFor(() => query.mock.calls.length === 2, "exact overflow follow-up lookup");
			expect(query).toHaveBeenLastCalledWith("turn.result", {
				kind: "prompt",
				commandId: "cancel-settlement-command-1",
				turnId: "cancel-settlement-turn-1",
			});
			expect(resultCalls).toBe(2);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(fixture.promptDeliveryCount()).toBe(1);

			if (followUpCase.terminal) {
				await waitFor(
					() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeAck,
					"idle after exact follow-up terminal proof",
				);
			} else {
				await Bun.sleep(20);
				const blocked = await prompt(fixture, "unusable follow-up evidence must keep owner").then(
					() => undefined,
					(error: unknown) => error as { code?: string },
				);
				expect(blocked).toMatchObject({ code: "conflict" });
				expect(fixture.promptDeliveryCount()).toBe(1);
				fixture.sendStopped("end_turn");
				await waitFor(
					() => idleWithGjcRunningFalse(fixture.updates) > idleBeforeAck,
					"idle after exact late terminal",
				);
			}
			const next = prompt(fixture, "successor after follow-up evidence");
			await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
			fixture.sendStopped("end_turn");
			expect(await bounded(next, "successor terminal")).toEqual({ stopReason: "end_turn" });
		} finally {
			cancel.mockRestore();
			query.mockRestore();
			fixture.dispose();
		}
	});
}

test("local CLI detach preserves an unresolved abort owner across reattachment", async () => {
	const fixture = await createFixture({
		deferPromptAcknowledgement: true,
		primaryControlSurface: "cli",
		liveSessionIndex: true,
	});
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockRejectedValue(new Error("fixture query unavailable"));
	try {
		const pending = prompt(fixture, "local detach keeps provisional abort owner").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt dispatch");
		await waitFor(() => fixture.hasPendingPromptAcknowledgement(), "deferred prompt ACK");
		const clientRef = fixture.promptClientRef();
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "provisional abort status lookup")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(pending, "uncertain prompt settlement")).toMatchObject({
			code: "terminal_uncertain",
		});
		expect(query).toHaveBeenCalledWith("turn.result", { kind: "prompt", clientRef });
		fixture.rejectPendingPromptAcknowledgement();
		query.mockRestore();
		await bounded(fixture.agent.closeSession({ sessionId: fixture.sessionId }), "local CLI detach");
		await fixture.newSessionAgain();
		const blocked = await prompt(fixture, "owner survives local detach").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(blocked).toMatchObject({ code: "conflict" });
		expect(fixture.promptDeliveryCount()).toBe(1);
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});

test("successful remote session retirement releases an unresolved abort owner", async () => {
	const fixture = await createFixture();
	const cancel = vi.spyOn(AcpSdkAdapter.prototype, "cancel").mockRejectedValue(
		new SdkClientError("uncertain_after_send", "SDK abort response was lost after dispatch.", {
			operation: "turn.abort",
		}),
	);
	const query = vi.spyOn(AcpSdkAdapter.prototype, "query").mockResolvedValue({
		kind: "prompt",
		status: "in_flight",
		receiptState: "absent",
		commandId: "cancel-settlement-command-1",
		turnId: "cancel-settlement-turn-1",
	});
	try {
		const pending = prompt(fixture, "retire session with uncertain abort").then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		const cancellation = fixture.agent.cancel({ sessionId: fixture.sessionId }).then(
			() => undefined,
			(error: unknown) => error as { code?: string },
		);
		expect(await bounded(cancellation, "uncertain abort recovery")).toMatchObject({ code: "terminal_uncertain" });
		expect(await bounded(pending, "uncertain prompt settlement")).toMatchObject({ code: "terminal_uncertain" });
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fixture.promptDeliveryCount()).toBe(1);
		await bounded(fixture.agent.deleteSession({ sessionId: fixture.sessionId }), "remote session retirement");
		query.mockRestore();
		await fixture.newSessionAgain();
		const next = prompt(fixture, "prompt after definitive session retirement");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "prompt after owner retirement");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "prompt after owner retirement")).toEqual({ stopReason: "end_turn" });
	} finally {
		cancel.mockRestore();
		query.mockRestore();
		fixture.dispose();
	}
});
