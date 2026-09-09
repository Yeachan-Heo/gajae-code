import { expect, setDefaultTimeout, test, vi } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection, PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { logger, TempDir } from "@gajae-code/utils";
import packageJson from "../package.json" with { type: "json" };
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { AcpSdkAdapter } from "../src/sdk/acp/adapter";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SdkClientError } from "../src/sdk/client";
import {
	type ExactSessionAuthorityFixture,
	type ExactSessionAuthorityOptions,
	prepareExactSessionAuthority,
	publishExactSessionAuthority,
} from "./helpers/sdk-exact-session-authority";

setDefaultTimeout(75_000);

type TestSocket = { send(message: string): void };
type StoppedReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
type FailedCode = "prompt_failed" | "prompt_deadline_exceeded";
type AdvisoryQuery = "context.get" | "session.metadata";

type Fixture = {
	agent: AcpAgent;
	sessionId: string;
	cwd: string;
	updates: SessionNotification[];
	promptDelivered: Promise<void>;
	workingUpdateEntered: Promise<void>;
	idleUpdateEntered: Promise<void>;
	agentMessageUpdateEntered: Promise<void>;
	failureDiagnosticEntered: Promise<void>;
	terminalReservationEntered: Promise<void>;
	promptDeliveryCount(): number;
	sendStopped(reason: StoppedReason): void;
	sendFailed(code: FailedCode): void;
	sendDiagnostic(): void;
	sendAssistantMessage(text: string): void;
	sendIdle(): void;
	dispose(): void;
	queryCalls: string[];
	turnResultInputs: unknown[];
	invocationOperations: string[];
	blockedAdvisoryQueryCount(): number;
	releaseBlockedAdvisoryQueries(): void;
	releaseIdleUpdate(): void;
	releaseWorkingUpdate(): void;
	releaseAgentMessageUpdate(): void;
	releaseFailureDiagnostic(): void;
	releasePromptAcknowledgement(): void;
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

async function createFixture(
	options: {
		terminalBeforeAcknowledgement?: boolean;
		preAcknowledgementTerminal?: Record<string, unknown>;
		preAcknowledgementFrames?: Record<string, unknown>[];
		promptAcknowledgement?: Record<string, unknown>;
		cancelSettlementGraceMs?: number;
		abortAcknowledgement?: Record<string, unknown>;
		blockedAdvisoryQuery?: AdvisoryQuery;
		blockIdleUpdate?: boolean;
		blockWorkingReconciliation?: boolean;
		blockInitialWorkingUpdate?: boolean;
		rejectBlockedWorkingUpdate?: boolean;
		blockFailureDiagnosticUpdate?: boolean;
		blockedAgentMessageText?: string;
		deferSecondPromptAcknowledgement?: boolean;
		deferFirstPromptAcknowledgement?: boolean;
		reusePromptCorrelationOnSecond?: boolean;
		failBrokerSessionClose?: boolean;
		observeTerminalReservation?: boolean;
		turnResult?: Record<string, unknown>;
		turnResultUnavailable?: boolean;
		turnResultStalled?: boolean;
		turnResultError?: { code: string; message: string };
	} = {},
): Promise<Fixture> {
	const tempDir = TempDir.createSync("@sdk-acp-prompt-terminal-");
	const agentDir = path.join(tempDir.path(), "agent");
	const cwd = path.join(tempDir.path(), "workspace");
	const token = "sdk-acp-prompt-terminal-token";
	const sessionId = "prompt-terminal-session";
	const commandId = "prompt-terminal-command";
	const turnId = "prompt-terminal-turn";
	const updates: SessionNotification[] = [];
	const queryCalls: string[] = [];
	const turnResultInputs: unknown[] = [];
	const invocationOperations: string[] = [];
	const blockedAdvisoryQueries: Array<{ socket: TestSocket; id: string; result: unknown }> = [];
	const idleUpdateRelease = Promise.withResolvers<void>();
	const idleUpdateEntered = Promise.withResolvers<void>();
	const workingUpdateRelease = Promise.withResolvers<void>();
	const workingUpdateEntered = Promise.withResolvers<void>();
	const agentMessageUpdateRelease = Promise.withResolvers<void>();
	const agentMessageUpdateEntered = Promise.withResolvers<void>();
	const failureDiagnosticRelease = Promise.withResolvers<void>();
	const failureDiagnosticEntered = Promise.withResolvers<void>();
	const terminalReservationEntered = Promise.withResolvers<void>();
	let blockNextIdleUpdate = false;
	let blockNextWorkingUpdate = options.blockInitialWorkingUpdate === true;
	const delivered = Promise.withResolvers<void>();
	const abort = new AbortController();
	let promptSocket: TestSocket | undefined;
	let promptDeliveries = 0;
	let deferredPromptAcknowledgement: (() => void) | undefined;
	const activeCorrelation = (): { commandId: string; turnId: string } => {
		const suffix = promptDeliveries > 1 && !options.reusePromptCorrelationOnSecond ? `-${promptDeliveries}` : "";
		return { commandId: `${commandId}${suffix}`, turnId: `${turnId}${suffix}` };
	};
	let blockAdvisoryQuery = false;
	let server!: ReturnType<typeof Bun.serve>;

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
	const sendDiagnostic = (): void => {
		const correlation = activeCorrelation();
		send({
			type: "agent_failed",
			sessionId,
			...correlation,
			error: { code: "provider_unavailable", message: "diagnostic from fixture" },
		});
	};
	const sendFailed = (code: FailedCode): void => {
		const correlation = activeCorrelation();
		const outcome = {
			kind: "failed" as const,
			code,
			message: `${code} from fixture`,
			provenance: code === "prompt_failed" ? ("agent_failed" as const) : ("deadline" as const),
		};
		send({
			type: "agent_failed",
			sessionId,
			...correlation,
			outcome,
		});
		send({
			type: "agent_end",
			sessionId,
			...correlation,
			outcome,
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
				promptSocket = socket;
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
					if (options.failBrokerSessionClose && frame.operation === "session.close") {
						socket.send(
							JSON.stringify({
								type: "broker_response",
								id: frame.id,
								ok: false,
								error: { code: "close_uncertain", message: "close outcome uncertain" },
							}),
						);
						return;
					}
					if (frame.operation === "session.list") {
						if ((frame.input as { resolveSessionId?: string } | undefined)?.resolveSessionId === sessionId) {
							socket.send(
								JSON.stringify({
									type: "broker_response",
									id: frame.id,
									ok: true,
									result: {
										sessions: [],
										savedSession: { id: sessionId, path: path.join(cwd, "saved-session.jsonl") },
									},
								}),
							);
							return;
						}
						socket.send(
							JSON.stringify({
								type: "broker_response",
								id: frame.id,
								ok: true,
								result: {
									sessions: [
										{
											sessionId,
											locator: { cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") },
											live: false,
										},
									],
								},
							}),
						);
						return;
					}
					// Every broker interaction (session.list, session.get_endpoint,
					// session.create) is answered with the exact authority: the
					// router's reconcile resolves the session through this fixture.
					socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: authority }));
					setTimeout(() => void publishExactSessionAuthority(authorityOptions, authority), 10);
					return;
				}
				if (frame.type === "query_request") {
					queryCalls.push(String(frame.query));
					if (frame.query === "turn.result") {
						turnResultInputs.push(frame.input);
						if (options.turnResultStalled) return;
						socket.send(
							JSON.stringify({
								type: "query_response",
								id: frame.id,
								ok: !options.turnResultUnavailable && !options.turnResultError,
								...(options.turnResultError
									? { error: options.turnResultError }
									: options.turnResultUnavailable
										? { error: { code: "session_unavailable", message: "live session query unavailable" } }
										: { result: options.turnResult ?? { status: "unknown", receiptState: "unknown" } }),
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
						frame.query === "runtime.capabilities"
							? { promptTerminalOutcomeVersion: 1, primaryControlSurface: "sdk" }
							: frame.query === "context.get"
								? { usage: { tokens: 0, contextWindow: 200_000, percent: 0, source: "test" } }
								: { page: { items, complete: true } };
					if (
						blockAdvisoryQuery &&
						frame.query === options.blockedAdvisoryQuery &&
						blockedAdvisoryQueries.length === 0
					) {
						blockedAdvisoryQueries.push({ socket, id: String(frame.id), result });
						return;
					}
					socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result }));
					return;
				}
				if (frame.type !== "control_request") return;
				if (frame.operation === "turn.prompt" || frame.operation === "skill.invoke") {
					invocationOperations.push(String(frame.operation));
					promptSocket = socket;
					promptDeliveries++;
					delivered.resolve();
					if (options.preAcknowledgementFrames)
						for (const deferredFrame of options.preAcknowledgementFrames) sendTerminal(deferredFrame);
					else if (options.terminalBeforeAcknowledgement)
						sendTerminal(
							options.preAcknowledgementTerminal ?? {
								type: "agent_end",
								sessionId,
								commandId,
								turnId,
								outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
							},
						);
				}
				const response = JSON.stringify({
					type: "control_response",
					id: frame.id,
					ok: true,
					result:
						frame.operation === "turn.prompt" || frame.operation === "skill.invoke"
							? (options.promptAcknowledgement ?? { ...activeCorrelation(), accepted: true })
							: frame.operation === "turn.abort"
								? (options.abortAcknowledgement ??
									(() => {
										const scope = (frame.input as { scope?: string })?.scope === "owned" ? "owned" : "turn";
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
				});

				if (
					frame.operation === "turn.prompt" &&
					((options.deferFirstPromptAcknowledgement && promptDeliveries === 1) ||
						(options.deferSecondPromptAcknowledgement && promptDeliveries === 2))
				)
					deferredPromptAcknowledgement = () =>
						socket.send(
							JSON.stringify({
								type: "control_response",
								id: frame.id,
								ok: true,
								result: { accepted: true, commandId },
							}),
						);
				else socket.send(response);
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
				if (
					options.blockFailureDiagnosticUpdate &&
					update.update.sessionUpdate === "session_info_update" &&
					(update.update as { _meta?: { gjcAgentFailed?: boolean } })._meta?.gjcAgentFailed === true
				) {
					failureDiagnosticEntered.resolve();
					await failureDiagnosticRelease.promise;
				}
				if (
					options.blockedAgentMessageText &&
					update.update.sessionUpdate === "agent_message_chunk" &&
					update.update.content.type === "text" &&
					update.update.content.text === options.blockedAgentMessageText
				) {
					agentMessageUpdateEntered.resolve();
					await agentMessageUpdateRelease.promise;
				}
				if (
					blockNextIdleUpdate &&
					update.update.sessionUpdate === "session_info_update" &&
					(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle"
				) {
					blockNextIdleUpdate = false;
					idleUpdateEntered.resolve();
					await idleUpdateRelease.promise;
				}
				if (
					blockNextWorkingUpdate &&
					update.update.sessionUpdate === "session_info_update" &&
					(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working"
				) {
					blockNextWorkingUpdate = false;
					workingUpdateEntered.resolve();
					await workingUpdateRelease.promise;
					if (options.rejectBlockedWorkingUpdate) throw new Error("blocked working update rejected");
				}
				updates.push(update);
			},
			signal: abort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{
			agentDir,
			...(options.observeTerminalReservation
				? {
						promptWatchdogClock: {
							now: () => Date.now(),
							schedule: () => {
								let armed = true;
								return () => {
									if (!armed) return;
									armed = false;
									terminalReservationEntered.resolve();
								};
							},
						},
					}
				: {}),
			...(options.cancelSettlementGraceMs === undefined
				? {}
				: { cancelSettlementGraceMs: options.cancelSettlementGraceMs }),
		},
	);
	const created = await bounded(agent.newSession({ cwd, mcpServers: [] }), "new session");
	await waitFor(
		() =>
			updates.some(
				update =>
					update.update.sessionUpdate === "session_info_update" &&
					(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
			),
		"bootstrap update",
	);
	blockNextIdleUpdate = options.blockIdleUpdate === true;
	blockAdvisoryQuery = true;

	return {
		agent,
		sessionId: created.sessionId,
		cwd,
		updates,
		promptDelivered: delivered.promise,
		workingUpdateEntered: workingUpdateEntered.promise,
		idleUpdateEntered: idleUpdateEntered.promise,
		agentMessageUpdateEntered: agentMessageUpdateEntered.promise,
		failureDiagnosticEntered: failureDiagnosticEntered.promise,
		terminalReservationEntered: terminalReservationEntered.promise,
		promptDeliveryCount: () => promptDeliveries,
		sendStopped,
		sendFailed,
		sendDiagnostic,
		sendAssistantMessage,
		sendIdle,
		queryCalls,
		turnResultInputs,
		invocationOperations,
		blockedAdvisoryQueryCount: () => blockedAdvisoryQueries.length,
		releaseBlockedAdvisoryQueries: () => {
			for (const blocked of blockedAdvisoryQueries.splice(0))
				blocked.socket.send(
					JSON.stringify({ type: "query_response", id: blocked.id, ok: true, result: blocked.result }),
				);
		},
		releaseIdleUpdate: () => {
			blockNextWorkingUpdate = options.blockWorkingReconciliation === true;
			idleUpdateRelease.resolve();
		},
		releaseWorkingUpdate: () => workingUpdateRelease.resolve(),
		releaseAgentMessageUpdate: () => agentMessageUpdateRelease.resolve(),
		releaseFailureDiagnostic: () => failureDiagnosticRelease.resolve(),
		releasePromptAcknowledgement: () => deferredPromptAcknowledgement?.(),
		sendTerminal,
		dispose: () => {
			agentMessageUpdateRelease.resolve();
			failureDiagnosticRelease.resolve();
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

async function promptWhenDelivered(
	fixture: Fixture,
	text: string,
	expectedDeliveryCount: number,
): Promise<{ pending: Promise<{ stopReason: StoppedReason }> }> {
	for (;;) {
		const candidate = prompt(fixture, text);
		const outcome = await Promise.race([
			candidate.then(
				() => ({ kind: "settled" as const }),
				error => ({ kind: "rejected" as const, error }),
			),
			waitFor(
				() => fixture.promptDeliveryCount() === expectedDeliveryCount,
				`${text} delivery acknowledgement`,
			).then(() => ({ kind: "delivered" as const })),
		]);
		if (outcome.kind === "delivered") return { pending: candidate };
		if (
			outcome.kind === "rejected" &&
			outcome.error instanceof Error &&
			"code" in outcome.error &&
			outcome.error.code === "conflict"
		) {
			await Bun.sleep(0);
			continue;
		}
		throw outcome.kind === "rejected" ? outcome.error : new Error(`${text} settled before delivery barrier`);
	}
}

for (const reason of ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const) {
	test(`ACP prompt preserves the ${reason} terminal stop reason`, async () => {
		const fixture = await createFixture();
		try {
			const contextQueriesBefore = fixture.queryCalls.filter(query => query === "context.get").length;
			const metadataQueriesBefore = fixture.queryCalls.filter(query => query === "session.metadata").length;
			const idleUpdatesBefore = fixture.updates.filter(
				update =>
					update.update.sessionUpdate === "session_info_update" &&
					(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
			).length;
			const pending = prompt(fixture, reason);
			await bounded(fixture.promptDelivered, "prompt delivery");
			fixture.sendStopped(reason);
			expect(await bounded(pending, `${reason} prompt completion`)).toEqual({ stopReason: reason });
			// The prompt settles on its terminal frame, so the advisory end-of-turn queries
			// and the phase publication land after it rather than gating it.
			await waitFor(() => idlePhaseUpdates(fixture.updates) > idleUpdatesBefore, "end-of-turn idle update");
			expect(fixture.queryCalls.filter(query => query === "context.get")).toHaveLength(contextQueriesBefore + 1);
			expect(fixture.queryCalls.filter(query => query === "session.metadata")).toHaveLength(
				metadataQueriesBefore + 1,
			);
			expect(
				fixture.updates.filter(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
				),
			).toHaveLength(idleUpdatesBefore + 1);
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
		await expect(bounded(pending, "prompt failure")).rejects.toMatchObject({
			code: "prompt_failed",
			message: "Prompt submission failed.",
		});
	} finally {
		fixture.dispose();
	}
});

test("ACP publishes final text from an explicit failure-only terminal", async () => {
	const fixture = await createFixture();
	try {
		const pending = prompt(fixture, "failure final text");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendDiagnostic();
		fixture.sendTerminal({
			type: "agent_failed",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			outcome: {
				kind: "failed",
				code: "prompt_failed",
				message: "failure with final text",
				provenance: "agent_failed",
			},
			finalText: "partial answer before failure",
		});
		await expect(bounded(pending, "failure settlement")).rejects.toMatchObject({ code: "prompt_failed" });
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "agent_message_chunk" &&
						(update.update as { content: { text: string } }).content.text === "partial answer before failure",
				),
			"failure final text publication",
		);
		await waitFor(
			() =>
				fixture.updates
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "idle",
			"failure idle phase",
		);
		const finalTextIndex = fixture.updates.findIndex(
			update =>
				update.update.sessionUpdate === "agent_message_chunk" &&
				(update.update as { content: { text: string } }).content.text === "partial answer before failure",
		);
		const finalIdleIndex = fixture.updates.findLastIndex(
			update =>
				update.update.sessionUpdate === "session_info_update" &&
				(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
		);
		expect(finalTextIndex).toBeLessThan(finalIdleIndex);
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

test("ACP preserves cancellation when runtime abort failure precedes agent_end", async () => {
	const fixture = await createFixture();
	try {
		const pending = prompt(fixture, "runtime cancellation");
		await bounded(fixture.promptDelivered, "prompt delivery");
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "cancel acknowledgement");
		fixture.sendTerminal({
			type: "agent_failed",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			error: { code: "aborted", message: "Agent run failed." },
		});
		fixture.sendStopped("cancelled");
		expect(await bounded(pending, "runtime cancellation settlement")).toEqual({ stopReason: "cancelled" });
	} finally {
		fixture.dispose();
	}
});

test("ACP rejects a successor that reuses a retained prompt correlation", async () => {
	const fixture = await createFixture({ reusePromptCorrelationOnSecond: true });
	try {
		const failed = prompt(fixture, "retained correlation owner");
		await bounded(fixture.promptDelivered, "first prompt delivery");
		fixture.sendFailed("prompt_failed");
		await expect(bounded(failed, "first failure settlement")).rejects.toMatchObject({ code: "prompt_failed" });

		const replacement = prompt(fixture, "reused correlation");
		void replacement.catch(() => undefined);
		await waitFor(() => fixture.promptDeliveryCount() === 2, "replacement prompt delivery");
		await expect(bounded(replacement, "reused correlation rejection")).rejects.toMatchObject({
			code: "invalid_prompt_acknowledgement",
		});
	} finally {
		fixture.dispose();
	}
});

test("ACP malformed correlated agent_failed remains diagnostic until agent_end", async () => {
	const fixture = await createFixture();
	try {
		const idleBefore = idlePhaseUpdates(fixture.updates);
		const pending = prompt(fixture, "malformed failure phase");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendTerminal({
			type: "agent_failed",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			error: { code: 503, message: "invalid diagnostic" },
		});
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(idlePhaseUpdates(fixture.updates)).toBe(idleBefore);
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "malformed failure terminal settlement")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("ACP agent_failed cannot terminalize with a stopped outcome", async () => {
	const fixture = await createFixture();
	try {
		const pending = prompt(fixture, "stopped outcome on failure event");
		await bounded(fixture.promptDelivered, "prompt delivery");
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		fixture.sendTerminal({
			type: "agent_failed",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		fixture.sendStopped("cancelled");
		expect(await bounded(pending, "authoritative stopped terminal")).toEqual({ stopReason: "cancelled" });
	} finally {
		fixture.dispose();
	}
});

test("ACP preserves an explicit prompt deadline terminal classifier after its diagnostic", async () => {
	const fixture = await createFixture();
	try {
		const pending = prompt(fixture, "failure-only deadline");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendTerminal({
			type: "agent_failed",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			error: { code: "prompt_deadline_exceeded", message: "deadline diagnostic" },
		});
		fixture.sendFailed("prompt_deadline_exceeded");
		await expect(bounded(pending, "deadline failure")).rejects.toMatchObject({
			code: "prompt_deadline_exceeded",
			message: "Prompt deadline exceeded.",
		});
	} finally {
		fixture.dispose();
	}
});

test("ACP preserves a wrapped normalized failure without tearing down the session", async () => {
	const fixture = await createFixture();
	try {
		const pending = prompt(fixture, "wrapped malformed failure");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendTerminal({
			type: "event",
			payload: {
				event_type: "agent_failed",
				event: {
					type: "agent_failed",
					sessionId: "prompt-terminal-session",
					commandId: "prompt-terminal-command",
					turnId: "prompt-terminal-turn",
					outcome: {
						kind: "failed",
						code: "prompt_failed",
						message: "wrapped failure",
						provenance: "agent_failed",
					},
				},
			},
		});
		await expect(bounded(pending, "wrapped malformed failure settlement")).rejects.toMatchObject({
			code: "prompt_failed",
		});
		const next = prompt(fixture, "prompt after wrapped malformed failure");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "prompt after wrapped malformed failure")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("ACP keeps a wrapped failure without outcome diagnostic-only and keeps the session usable", async () => {
	const fixture = await createFixture();
	try {
		const idleBefore = idlePhaseUpdates(fixture.updates);
		const pending = prompt(fixture, "wrapped malformed failure");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendTerminal({
			type: "event",
			payload: {
				event_type: "agent_failed",
				event: {
					type: "agent_failed",
					sessionId: "prompt-terminal-session",
					commandId: "prompt-terminal-command",
					turnId: "prompt-terminal-turn",
				},
			},
		});
		await Promise.resolve();
		expect(idlePhaseUpdates(fixture.updates)).toBe(idleBefore);
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "wrapped diagnostic terminal settlement")).toEqual({ stopReason: "end_turn" });

		const next = prompt(fixture, "prompt after wrapped malformed failure");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "prompt after wrapped malformed failure")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("ACP keeps generic correlated agent_failed additive until authoritative agent_end", async () => {
	const fixture = await createFixture();
	try {
		const contextQueriesBefore = fixture.queryCalls.filter(query => query === "context.get").length;
		const metadataQueriesBefore = fixture.queryCalls.filter(query => query === "session.metadata").length;
		const pending = prompt(fixture, "failure-only terminal");
		await bounded(fixture.promptDelivered, "prompt delivery");
		await waitFor(
			() => fixture.updates.some(update => update.update.sessionUpdate === "user_message_chunk"),
			"user prompt publication",
		);
		const updatesBefore = fixture.updates.length;
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		fixture.sendDiagnostic();
		await Promise.resolve();
		expect(fixture.updates).toHaveLength(updatesBefore);
		expect(settled).toBe(false);
		expect(fixture.queryCalls.filter(query => query === "context.get")).toHaveLength(contextQueriesBefore);
		expect(fixture.queryCalls.filter(query => query === "session.metadata")).toHaveLength(metadataQueriesBefore);
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "authoritative agent_end settlement")).toEqual({ stopReason: "end_turn" });
		await waitFor(() => fixture.updates.length > updatesBefore, "post-settlement failure diagnostic update");
	} finally {
		fixture.dispose();
	}
});

test("ACP blocked generic failure diagnostic cannot delay authoritative agent_end", async () => {
	const fixture = await createFixture({ blockFailureDiagnosticUpdate: true });
	try {
		const pending = prompt(fixture, "blocked generic failure diagnostic");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendDiagnostic();
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "authoritative terminal behind diagnostic")).toEqual({ stopReason: "end_turn" });
		await bounded(fixture.failureDiagnosticEntered, "entered post-settlement failure diagnostic");
		await expect(prompt(fixture, "successor blocked by failure diagnostic")).rejects.toMatchObject({
			code: "conflict",
		});
		fixture.releaseFailureDiagnostic();
		const { pending: successor } = await promptWhenDelivered(fixture, "successor after failure diagnostic", 2);
		fixture.sendStopped("end_turn");
		expect(await bounded(successor, "successor after failure diagnostic")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.releaseFailureDiagnostic();
		fixture.dispose();
	}
});

test("ACP correlationless failure diagnostic cannot delay authoritative agent_end", async () => {
	const fixture = await createFixture({ blockFailureDiagnosticUpdate: true });
	try {
		const pending = prompt(fixture, "correlationless diagnostic ordering");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendTerminal({
			type: "agent_failed",
			sessionId: "prompt-terminal-session",
			error: { code: "background_warning", message: "correlationless advisory" },
		});
		await Promise.resolve();
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "terminal behind correlationless diagnostic")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.releaseFailureDiagnostic();
		fixture.dispose();
	}
});

test("ACP reconnect retirement flushes buffered failure diagnostics", async () => {
	const fixture = await createFixture();
	try {
		const pending = prompt(fixture, "diagnostic before reconnect");
		await bounded(fixture.promptDelivered, "prompt delivery");
		const updatesBefore = fixture.updates.length;
		fixture.sendTerminal({
			type: "agent_start",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
		});
		await waitFor(
			() =>
				fixture.updates
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "working",
			"foreground working phase",
		);
		fixture.sendDiagnostic();
		fixture.sendTerminal({ type: "hello", connectionId: "replacement-connection" });
		await expect(bounded(pending, "reconnect prompt rejection")).rejects.toMatchObject({
			code: "connection_closed",
		});
		await waitFor(
			() =>
				fixture.updates
					.slice(updatesBefore)
					.some(
						update =>
							update.update.sessionUpdate === "session_info_update" &&
							(update.update as { _meta?: { gjcAgentFailed?: boolean } })._meta?.gjcAgentFailed === true,
					),
			"reconnect-retired failure diagnostic",
		);
		await waitFor(
			() =>
				fixture.updates
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "idle",
			"reconnect idle phase",
		);
	} finally {
		fixture.dispose();
	}
});

test("ACP terminal settlement does not await final-text delivery", async () => {
	const fixture = await createFixture({ blockedAgentMessageText: "detached final report" });
	const queryEntered = Promise.withResolvers<void>();
	const originalQuery = AcpSdkAdapter.prototype.query;
	const querySpy = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(async function (
		this: AcpSdkAdapter,
		query,
		input,
		cursor,
	) {
		queryEntered.resolve();
		return await originalQuery.call(this, query, input, cursor);
	});
	try {
		const idleBefore = idlePhaseUpdates(fixture.updates);
		const queriesBefore = fixture.queryCalls.length;
		const pending = prompt(fixture, "blocked final text");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			finalText: "detached final report",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		expect(await bounded(pending, "settlement before final-text delivery")).toEqual({ stopReason: "end_turn" });
		await bounded(fixture.agentMessageUpdateEntered, "entered final-text delivery");
		expect(
			fixture.updates.some(
				update =>
					update.update.sessionUpdate === "agent_message_chunk" &&
					update.update.content.type === "text" &&
					update.update.content.text === "detached final report",
			),
		).toBe(false);
		expect(idlePhaseUpdates(fixture.updates)).toBe(idleBefore);
		expect(fixture.queryCalls).toHaveLength(queriesBefore);
		let queryAdmitted = false;
		void queryEntered.promise.then(() => {
			queryAdmitted = true;
		});
		await Promise.resolve();
		expect(queryAdmitted).toBe(false);
		await expect(prompt(fixture, "successor blocked by predecessor final text")).rejects.toMatchObject({
			code: "conflict",
		});
		fixture.releaseAgentMessageUpdate();
		await waitFor(
			() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "agent_message_chunk" &&
						update.update.content.type === "text" &&
						update.update.content.text === "detached final report",
				),
			"detached final-text delivery",
		);
		await waitFor(() => idlePhaseUpdates(fixture.updates) > idleBefore, "idle after final-text delivery");
		const { pending: successor } = await promptWhenDelivered(fixture, "successor after final-text delivery", 2);
		fixture.sendStopped("end_turn");
		expect(await bounded(successor, "successor after final-text delivery")).toEqual({ stopReason: "end_turn" });
	} finally {
		querySpy.mockRestore();
		fixture.releaseAgentMessageUpdate();
		fixture.dispose();
	}
});

test("ACP final-text delivery fence survives same-id record replacement", async () => {
	const fixture = await createFixture({ blockedAgentMessageText: "reattached predecessor text" });
	try {
		const first = prompt(fixture, "final text across reattachment");
		await bounded(fixture.promptDelivered, "first prompt delivery");
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			finalText: "reattached predecessor text",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		expect(await bounded(first, "first terminal settlement")).toEqual({ stopReason: "end_turn" });
		await bounded(fixture.agentMessageUpdateEntered, "entered predecessor final-text delivery");
		await bounded(fixture.agent.closeSession({ sessionId: fixture.sessionId }), "session close during final text");
		await bounded(
			fixture.agent.loadSession({ sessionId: fixture.sessionId, cwd: fixture.cwd, mcpServers: [] }),
			"same-id final-text reattachment",
		);
		await expect(prompt(fixture, "successor blocked across final-text replacement")).rejects.toMatchObject({
			code: "conflict",
		});
		fixture.releaseAgentMessageUpdate();
		const { pending: successor } = await promptWhenDelivered(fixture, "successor after replaced final text", 2);
		fixture.sendStopped("end_turn");
		expect(await bounded(successor, "successor after replaced final text")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.releaseAgentMessageUpdate();
		fixture.dispose();
	}
});

test("ACP successor terminal decoration does not wait for a predecessor advisory query", async () => {
	const fixture = await createFixture({ blockedAdvisoryQuery: "context.get" });
	try {
		const first = prompt(fixture, "blocked predecessor decoration");
		await bounded(fixture.promptDelivered, "first prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(first, "first terminal settlement")).toEqual({ stopReason: "end_turn" });
		await waitFor(() => fixture.blockedAdvisoryQueryCount() === 1, "blocked predecessor advisory query");

		const idleBefore = idlePhaseUpdates(fixture.updates);
		const second = prompt(fixture, "independent successor decoration");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "second prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(second, "second terminal settlement")).toEqual({ stopReason: "end_turn" });
		await waitFor(() => idlePhaseUpdates(fixture.updates) > idleBefore, "successor idle decoration");
		const updatesAfterSuccessor = fixture.updates.length;
		fixture.releaseBlockedAdvisoryQueries();
		await Bun.sleep(0);
		expect(fixture.updates).toHaveLength(updatesAfterSuccessor);
	} finally {
		fixture.releaseBlockedAdvisoryQueries();
		fixture.dispose();
	}
});

test("ACP predecessor terminal metadata cannot overwrite a background successor", async () => {
	const fixture = await createFixture({ blockedAdvisoryQuery: "context.get" });
	try {
		const first = prompt(fixture, "background metadata isolation");
		await bounded(fixture.promptDelivered, "first prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(first, "first terminal settlement")).toEqual({ stopReason: "end_turn" });
		await waitFor(() => fixture.blockedAdvisoryQueryCount() === 1, "blocked predecessor advisory query");
		fixture.sendTerminal({ type: "agent_start", sessionId: "prompt-terminal-session" });
		await waitFor(
			() =>
				fixture.updates
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "working",
			"background working phase",
		);
		const updatesBeforeRelease = fixture.updates.length;
		fixture.releaseBlockedAdvisoryQueries();
		await Bun.sleep(0);
		expect(fixture.updates).toHaveLength(updatesBeforeRelease);
		fixture.sendTerminal({ type: "agent_end", sessionId: "prompt-terminal-session" });
	} finally {
		fixture.releaseBlockedAdvisoryQueries();
		fixture.dispose();
	}
});

test("ACP retires overlapping anonymous background runs independently", async () => {
	const fixture = await createFixture();
	try {
		const foreground = prompt(fixture, "establish anonymous lifecycle");
		await bounded(fixture.promptDelivered, "foreground prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(foreground, "foreground settlement")).toEqual({ stopReason: "end_turn" });
		await waitFor(() => idlePhaseUpdates(fixture.updates) > 0, "foreground idle phase");

		fixture.sendTerminal({ type: "agent_start", sessionId: "prompt-terminal-session" });
		fixture.sendTerminal({ type: "activity", sessionId: "prompt-terminal-session", state: "busy" });
		fixture.sendTerminal({ type: "agent_start", sessionId: "prompt-terminal-session" });
		fixture.sendTerminal({ type: "activity", sessionId: "prompt-terminal-session", state: "busy" });
		await waitFor(
			() =>
				fixture.updates
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "working",
			"anonymous background working phase",
		);
		const idleBeforeFirstTerminal = idlePhaseUpdates(fixture.updates);
		fixture.sendTerminal({ type: "agent_end", sessionId: "prompt-terminal-session" });
		fixture.sendTerminal({ type: "activity", sessionId: "prompt-terminal-session", state: "idle" });
		await Bun.sleep(0);
		expect(idlePhaseUpdates(fixture.updates)).toBe(idleBeforeFirstTerminal);
		fixture.sendTerminal({ type: "agent_end", sessionId: "prompt-terminal-session" });
		fixture.sendTerminal({ type: "activity", sessionId: "prompt-terminal-session", state: "idle" });
		await waitFor(
			() => idlePhaseUpdates(fixture.updates) > idleBeforeFirstTerminal,
			"final anonymous background idle phase",
		);
	} finally {
		fixture.dispose();
	}
});

test("ACP successor waits only while ready predecessor metadata is being delivered", async () => {
	const fixture = await createFixture({ blockIdleUpdate: true });
	try {
		const first = prompt(fixture, "blocked predecessor metadata delivery");
		await bounded(fixture.promptDelivered, "first prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(first, "first terminal settlement")).toEqual({ stopReason: "end_turn" });
		await bounded(fixture.idleUpdateEntered, "entered predecessor metadata delivery");
		await expect(prompt(fixture, "successor blocked by metadata delivery")).rejects.toMatchObject({
			code: "conflict",
		});
		const idleBeforeRelease = idlePhaseUpdates(fixture.updates);
		fixture.releaseIdleUpdate();
		await waitFor(() => idlePhaseUpdates(fixture.updates) > idleBeforeRelease, "released stale idle metadata");
		const { pending: successor } = await promptWhenDelivered(fixture, "successor after metadata delivery", 2);
		fixture.sendStopped("end_turn");
		expect(await bounded(successor, "successor after metadata delivery")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.releaseIdleUpdate();
		fixture.dispose();
	}
});

test("ACP background start during metadata delivery reconverges to working", async () => {
	const fixture = await createFixture({ blockIdleUpdate: true });
	try {
		const first = prompt(fixture, "background during metadata delivery");
		await bounded(fixture.promptDelivered, "first prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(first, "first terminal settlement")).toEqual({ stopReason: "end_turn" });
		await bounded(fixture.idleUpdateEntered, "entered predecessor metadata delivery");
		fixture.sendTerminal({ type: "agent_start", sessionId: "prompt-terminal-session" });
		await waitFor(
			() =>
				fixture.updates
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "working",
			"initial background working phase",
		);
		fixture.releaseIdleUpdate();
		await waitFor(
			() =>
				fixture.updates
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "working",
			"reconciled background working phase",
		);
		fixture.sendTerminal({ type: "agent_end", sessionId: "prompt-terminal-session" });
	} finally {
		fixture.releaseIdleUpdate();
		fixture.dispose();
	}
});

test("ACP metadata delivery fence survives same-id record replacement", async () => {
	const fixture = await createFixture({ blockIdleUpdate: true });
	try {
		const first = prompt(fixture, "metadata across reattachment");
		await bounded(fixture.promptDelivered, "first prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(first, "first terminal settlement")).toEqual({ stopReason: "end_turn" });
		await bounded(fixture.idleUpdateEntered, "entered predecessor metadata delivery");
		await bounded(fixture.agent.closeSession({ sessionId: fixture.sessionId }), "session close during metadata");
		await bounded(
			fixture.agent.loadSession({ sessionId: fixture.sessionId, cwd: fixture.cwd, mcpServers: [] }),
			"same-id metadata reattachment",
		);
		await expect(prompt(fixture, "successor blocked across record replacement")).rejects.toMatchObject({
			code: "conflict",
		});
		fixture.releaseIdleUpdate();
		const { pending: successor } = await promptWhenDelivered(fixture, "successor after replaced metadata", 2);
		fixture.sendStopped("end_turn");
		expect(await bounded(successor, "successor after replaced metadata")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.releaseIdleUpdate();
		fixture.dispose();
	}
});

test("ACP prompt phase fence survives same-id record replacement", async () => {
	const fixture = await createFixture({ blockIdleUpdate: true });
	try {
		const first = prompt(fixture, "phase across reattachment");
		await bounded(fixture.promptDelivered, "first prompt delivery");
		fixture.sendFailed("prompt_failed");
		await expect(bounded(first, "failed prompt settlement")).rejects.toMatchObject({ code: "prompt_failed" });
		await bounded(fixture.idleUpdateEntered, "entered predecessor phase delivery");
		await bounded(fixture.agent.closeSession({ sessionId: fixture.sessionId }), "session close during phase");
		await bounded(
			fixture.agent.loadSession({ sessionId: fixture.sessionId, cwd: fixture.cwd, mcpServers: [] }),
			"same-id phase reattachment",
		);
		fixture.sendTerminal({ type: "agent_start", sessionId: "prompt-terminal-session" });
		const successor = prompt(fixture, "successor across phase replacement");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.releaseIdleUpdate();
		await waitFor(
			() =>
				fixture.updates
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "working",
			"background working phase after replacement",
		);
		fixture.sendTerminal({ type: "agent_end", sessionId: "prompt-terminal-session" });
		fixture.sendStopped("end_turn");
		expect(await bounded(successor, "successor after replaced phase")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.releaseIdleUpdate();
		fixture.dispose();
	}
});

test("ACP uncertain teardown retains active prompt correlation for same-id reattachment", async () => {
	const fixture = await createFixture({ failBrokerSessionClose: true, reusePromptCorrelationOnSecond: true });
	try {
		const first = prompt(fixture, "prompt closed uncertainly");
		void first.catch(() => undefined);
		await bounded(fixture.promptDelivered, "first prompt delivery");
		await expect(fixture.agent.closeSession({ sessionId: fixture.sessionId })).rejects.toMatchObject({
			code: "terminal_uncertain",
		});
		expect(await bounded(first, "closed prompt settlement")).toEqual({ stopReason: "cancelled" });
		await bounded(
			fixture.agent.loadSession({ sessionId: fixture.sessionId, cwd: fixture.cwd, mcpServers: [] }),
			"same-id reattachment",
		);
		const replacement = prompt(fixture, "reused correlation after uncertain close");
		void replacement.catch(() => undefined);
		await waitFor(() => fixture.promptDeliveryCount() === 2, "replacement prompt delivery");
		await expect(bounded(replacement, "retained-correlation rejection")).rejects.toMatchObject({
			code: "invalid_prompt_acknowledgement",
		});
	} finally {
		fixture.releaseBlockedAdvisoryQueries();
		fixture.dispose();
	}
});

test("ACP terminal processing preserves FIFO behind an earlier correlated update", async () => {
	const fixture = await createFixture({ blockInitialWorkingUpdate: true });
	try {
		const pending = prompt(fixture, "FIFO terminal");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendTerminal({
			type: "agent_start",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
		});
		fixture.sendStopped("end_turn");
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		fixture.releaseWorkingUpdate();
		expect(await bounded(pending, "FIFO terminal settlement")).toEqual({ stopReason: "end_turn" });
		expect(
			fixture.updates.some(
				update =>
					update.update.sessionUpdate === "session_info_update" &&
					(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "working",
			),
		).toBe(true);
	} finally {
		fixture.releaseWorkingUpdate();
		fixture.dispose();
	}
});

test("ACP background publication failure remains fatal after a prompt generation starts", async () => {
	const fixture = await createFixture({
		blockInitialWorkingUpdate: true,
		rejectBlockedWorkingUpdate: true,
		observeTerminalReservation: true,
	});
	try {
		fixture.sendTerminal({ type: "agent_start", sessionId: "prompt-terminal-session" });
		await bounded(fixture.workingUpdateEntered, "entered background working publication");
		const pending = prompt(fixture, "prompt during failed background publication");
		void pending.catch(() => undefined);
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendStopped("end_turn");
		await bounded(fixture.terminalReservationEntered, "terminal reservation");
		fixture.releaseWorkingUpdate();
		await expect(bounded(pending, "background publication session failure")).rejects.toMatchObject({
			code: "frame_processing_failed",
		});
	} finally {
		fixture.releaseWorkingUpdate();
		fixture.dispose();
	}
});

test("ACP failure settlement cannot publish stale phase state over a replacement prompt", async () => {
	const fixture = await createFixture({ blockIdleUpdate: true });
	try {
		const failed = prompt(fixture, "first prompt fails");
		await bounded(fixture.promptDelivered, "first prompt delivery");
		fixture.sendFailed("prompt_failed");
		await expect(bounded(failed, "first failure settlement")).rejects.toMatchObject({ code: "prompt_failed" });
		const updatesAfterFailure = fixture.updates.length;

		const replacement = prompt(fixture, "replacement prompt");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "replacement prompt delivery");
		fixture.releaseIdleUpdate();
		fixture.sendStopped("end_turn");
		expect(await bounded(replacement, "replacement terminal settlement")).toEqual({ stopReason: "end_turn" });
		await waitFor(
			() =>
				fixture.updates
					.slice(updatesAfterFailure)
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "idle",
			"successor phase reconciliation",
		);
	} finally {
		fixture.releaseIdleUpdate();
		fixture.dispose();
	}
});

test("ACP reconciliation releases a successor whose delayed acknowledgement is invalid", async () => {
	const fixture = await createFixture({ blockIdleUpdate: true, deferSecondPromptAcknowledgement: true });
	try {
		const failed = prompt(fixture, "first prompt metadata fails");
		await bounded(fixture.promptDelivered, "first prompt delivery");
		fixture.sendFailed("prompt_failed");
		await expect(bounded(failed, "first failure settlement")).rejects.toMatchObject({ code: "prompt_failed" });

		const updatesAfterFailure = fixture.updates.length;
		const replacement = prompt(fixture, "replacement with invalid acknowledgement");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "replacement prompt delivery");
		fixture.releaseIdleUpdate();
		fixture.releasePromptAcknowledgement();
		await expect(bounded(replacement, "invalid acknowledgement rejection")).rejects.toMatchObject({
			code: "invalid_prompt_acknowledgement",
		});
		await waitFor(
			() =>
				fixture.updates
					.slice(updatesAfterFailure)
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "idle",
			"invalid acknowledgement idle reconciliation",
		);
	} finally {
		fixture.releaseIdleUpdate();
		fixture.releasePromptAcknowledgement();
		fixture.dispose();
	}
});

test("ACP preflight cancellation fences a delayed prompt acknowledgement", async () => {
	const fixture = await createFixture({
		deferFirstPromptAcknowledgement: true,
		abortAcknowledgement: {
			ok: true,
			selection: "turn",
			turn: "stopped",
			terminal: "terminal_no_effect",
			disposition: "preflight_cancelled",
		},
	});
	try {
		const pending = prompt(fixture, "preflight cancellation with delayed acknowledgement");
		await bounded(fixture.promptDelivered, "prompt delivery");
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "preflight cancellation");
		expect(await bounded(pending, "preflight-cancelled settlement")).toEqual({ stopReason: "cancelled" });
		await expect(prompt(fixture, "blocked successor")).rejects.toMatchObject({ code: "conflict" });

		fixture.releasePromptAcknowledgement();
		const { pending: successor } = await promptWhenDelivered(
			fixture,
			"successor after acknowledgement retirement",
			2,
		);
		fixture.sendStopped("end_turn");
		expect(await bounded(successor, "successor completion")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.releasePromptAcknowledgement();
		fixture.dispose();
	}
});

test("ACP settles once when agent_end arrives after correlated agent_failed", async () => {
	const fixture = await createFixture();
	try {
		let settleCount = 0;
		const pending = prompt(fixture, "failure then late end").then(
			result => {
				settleCount++;
				return result;
			},
			error => {
				settleCount++;
				throw error;
			},
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		const idleBeforeFailure = idlePhaseUpdates(fixture.updates);
		fixture.sendFailed("prompt_failed");
		await expect(bounded(pending, "agent_failed settlement")).rejects.toMatchObject({ code: "prompt_failed" });
		await waitFor(() => idlePhaseUpdates(fixture.updates) > idleBeforeFailure, "failure idle phase");
		const updatesAfterFailure = fixture.updates.length;
		const queriesAfterFailure = fixture.queryCalls.length;

		fixture.sendStopped("end_turn");
		await Bun.sleep(30);

		expect(settleCount).toBe(1);
		expect(fixture.updates).toHaveLength(updatesAfterFailure);
		expect(fixture.queryCalls).toHaveLength(queriesAfterFailure);
	} finally {
		fixture.dispose();
	}
});

test("ACP ignores agent_failed correlated to another turn", async () => {
	const fixture = await createFixture();
	try {
		let settled = false;
		const pending = prompt(fixture, "correlation isolation").finally(() => {
			settled = true;
		});
		await bounded(fixture.promptDelivered, "prompt delivery");
		const updatesBefore = fixture.updates.length;
		fixture.sendTerminal({
			type: "agent_failed",
			sessionId: "prompt-terminal-session",
			commandId: "foreign-command",
			turnId: "foreign-turn",
			error: { code: "provider_unavailable", message: "foreign failure" },
		});
		await Bun.sleep(30);

		expect(settled).toBe(false);
		expect(fixture.updates).toHaveLength(updatesBefore);
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "matching terminal settlement")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("ACP prompt settles exactly once when terminal arrives before acknowledgement", async () => {
	const fixture = await createFixture({ terminalBeforeAcknowledgement: true });
	try {
		const contextQueriesBefore = fixture.queryCalls.filter(query => query === "context.get").length;
		const metadataQueriesBefore = fixture.queryCalls.filter(query => query === "session.metadata").length;
		const idleUpdatesBefore = fixture.updates.filter(
			update =>
				update.update.sessionUpdate === "session_info_update" &&
				(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
		).length;
		let settleCount = 0;
		const pending = prompt(fixture, "fast terminal").then(result => {
			settleCount++;
			return result;
		});
		expect(await bounded(pending, "pre-acknowledgement completion")).toEqual({ stopReason: "end_turn" });
		expect(settleCount).toBe(1);
		await waitFor(() => idlePhaseUpdates(fixture.updates) > idleUpdatesBefore, "end-of-turn idle update");
		expect(fixture.queryCalls.filter(query => query === "context.get")).toHaveLength(contextQueriesBefore + 1);
		expect(fixture.queryCalls.filter(query => query === "session.metadata")).toHaveLength(metadataQueriesBefore + 1);
		expect(
			fixture.updates.filter(
				update =>
					update.update.sessionUpdate === "session_info_update" &&
					(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
			),
		).toHaveLength(idleUpdatesBefore + 1);
	} finally {
		fixture.dispose();
	}
});

test("ACP deferred terminal remains FIFO behind an earlier deferred publication", async () => {
	const fixture = await createFixture({
		blockInitialWorkingUpdate: true,
		preAcknowledgementFrames: [
			{
				type: "agent_start",
				sessionId: "prompt-terminal-session",
				commandId: "prompt-terminal-command",
				turnId: "prompt-terminal-turn",
			},
			{
				type: "agent_end",
				sessionId: "prompt-terminal-session",
				commandId: "prompt-terminal-command",
				turnId: "prompt-terminal-turn",
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			},
		],
	});
	try {
		const pending = prompt(fixture, "deferred FIFO terminal");
		await bounded(fixture.promptDelivered, "prompt delivery");
		await bounded(fixture.workingUpdateEntered, "deferred working update barrier");
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		fixture.releaseWorkingUpdate();
		expect(await bounded(pending, "deferred FIFO terminal settlement")).toEqual({ stopReason: "end_turn" });
		await waitFor(
			() =>
				fixture.updates
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "idle",
			"deferred terminal idle phase",
		);
	} finally {
		fixture.releaseWorkingUpdate();
		fixture.dispose();
	}
});

test("ACP rejects malformed acknowledgement and drops a stale pre-ack terminal", async () => {
	const fixture = await createFixture({
		terminalBeforeAcknowledgement: true,
		preAcknowledgementTerminal: {
			type: "agent_end",
			sessionId: "prompt-terminal-session",
			commandId: "stale-command",
			turnId: "stale-turn",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		},
		promptAcknowledgement: { accepted: true, commandId: "prompt-terminal-command" },
	});
	try {
		const pending = prompt(fixture, "malformed acknowledgement");
		await bounded(fixture.promptDelivered, "prompt delivery");
		const updatesBefore = fixture.updates.length;
		const queriesBefore = fixture.queryCalls.length;
		await expect(bounded(pending, "malformed acknowledgement rejection")).rejects.toMatchObject({
			code: "invalid_prompt_acknowledgement",
		});
		await waitFor(() => fixture.updates.length === updatesBefore + 1, "malformed acknowledgement idle update");
		expect((fixture.updates.at(-1)?.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase).toBe("idle");
		expect(fixture.queryCalls).toHaveLength(queriesBefore);
	} finally {
		fixture.dispose();
	}
});

test("ACP drops a mismatched pre-ack terminal without publication or queries", async () => {
	const fixture = await createFixture({
		terminalBeforeAcknowledgement: true,
		preAcknowledgementTerminal: {
			type: "agent_end",
			sessionId: "prompt-terminal-session",
			commandId: "other-command",
			turnId: "other-turn",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		},
	});
	const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
	try {
		let settled = false;
		const pending = prompt(fixture, "mismatched pre-ack").then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await bounded(fixture.promptDelivered, "prompt delivery");
		await waitFor(
			() =>
				errorSpy.mock.calls.some(
					([event, detail]) =>
						event === "acp_prompt_terminal_dropped" &&
						(detail as { sessionId?: string; terminalType?: string })?.sessionId === "prompt-terminal-session" &&
						(detail as { terminalType?: string })?.terminalType === "agent_end",
				),
			"deferred mismatched terminal drop log",
		);
		expect(errorSpy).toHaveBeenCalledWith("acp_prompt_terminal_dropped", {
			sessionId: "prompt-terminal-session",
			terminalType: "agent_end",
			reason: "correlation_mismatch",
			commandId: "other-command",
			turnId: "other-turn",
			expectedCommandId: "prompt-terminal-command",
			expectedTurnId: "prompt-terminal-turn",
		});
		const updatesBefore = fixture.updates.length;
		const queriesBefore = fixture.queryCalls.length;
		await Bun.sleep(30);
		expect(settled).toBe(false);
		expect(fixture.updates).toHaveLength(updatesBefore);
		expect(fixture.queryCalls).toHaveLength(queriesBefore);
		fixture.dispose();
		await bounded(pending, "mismatched prompt cleanup");
	} finally {
		errorSpy.mockRestore();
		fixture.dispose();
	}
});

test("ACP logs incomplete-correlation terminals dropped from an acknowledged prompt", async () => {
	const fixture = await createFixture();
	const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
	try {
		const pending = prompt(fixture, "incomplete terminal correlation");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		await waitFor(
			() => errorSpy.mock.calls.some(([event]) => event === "acp_prompt_terminal_dropped"),
			"incomplete terminal drop log",
		);
		expect(errorSpy).toHaveBeenCalledWith("acp_prompt_terminal_dropped", {
			sessionId: "prompt-terminal-session",
			terminalType: "agent_end",
			reason: "incomplete_correlation",
			commandId: "prompt-terminal-command",
			expectedCommandId: "prompt-terminal-command",
			expectedTurnId: "prompt-terminal-turn",
		});
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "prompt completion after incomplete terminal")).toEqual({ stopReason: "end_turn" });
	} finally {
		errorSpy.mockRestore();
		fixture.dispose();
	}
});

for (const terminalType of ["agent_end"] as const) {
	test(`ACP rejects a matching ${terminalType} without a normalized outcome before idle`, async () => {
		const fixture = await createFixture();
		try {
			const pending = prompt(fixture, `malformed ${terminalType}`);
			await bounded(fixture.promptDelivered, "prompt delivery");
			const updatesBefore = fixture.updates.length;
			const queriesBefore = fixture.queryCalls.length;
			fixture.sendTerminal({
				type: terminalType,
				sessionId: "prompt-terminal-session",
				commandId: "prompt-terminal-command",
				turnId: "prompt-terminal-turn",
				finalText: "must not publish",
				error: { message: "malformed terminal" },
			});
			await expect(bounded(pending, `${terminalType} rejection`)).rejects.toMatchObject({
				code: "connection_closed",
			});
			await Bun.sleep(30);
			// The turn ended, so the client's running phase is released — but an invalid
			// terminal carries no trustworthy usage or title, so nothing is queried for it.
			expect(fixture.queryCalls).toHaveLength(queriesBefore);
			expect(
				fixture.updates
					.slice(updatesBefore)
					.filter(
						update =>
							update.update.sessionUpdate === "session_info_update" &&
							(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
					),
			).toHaveLength(1);
			expect(fixture.updates).toHaveLength(updatesBefore + 1);
		} finally {
			fixture.dispose();
		}
	});
}

test("ACP malformed agent_failed waits for agent_end before replacement prompt", async () => {
	const fixture = await createFixture();
	try {
		const failed = prompt(fixture, "malformed failure terminal");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendTerminal({
			type: "agent_failed",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			error: { code: 503, message: "invalid diagnostic" },
		});
		fixture.sendStopped("end_turn");
		expect(await bounded(failed, "malformed failure terminal settlement")).toEqual({ stopReason: "end_turn" });
		const updatesAfterFailure = fixture.updates.length;

		const { pending: replacement } = await promptWhenDelivered(fixture, "replacement after malformed failure", 2);
		fixture.sendStopped("end_turn");
		expect(await bounded(replacement, "replacement completion")).toEqual({ stopReason: "end_turn" });
		await waitFor(
			() =>
				fixture.updates
					.slice(updatesAfterFailure)
					.some(
						update =>
							update.update.sessionUpdate === "session_info_update" &&
							(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
					),
			"replacement idle update",
		);
		expect(
			fixture.updates
				.slice(updatesAfterFailure)
				.filter(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
				),
		).not.toHaveLength(0);
	} finally {
		fixture.dispose();
	}
});

test("ACP derives the settlement-grace failure wording from the safe contract", async () => {
	const fixture = await createFixture();
	try {
		const pending = prompt(fixture, "unsettled prompt resources");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendTerminal({
			type: "agent_failed",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			error: {
				code: "terminal_uncertain",
				message: "Prompt resources did not settle before the terminalization grace expired.",
			},
		});
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			outcome: {
				kind: "failed",
				code: "prompt_failed",
				message: "Prompt resources did not settle before the terminalization grace expired.",
				provenance: "agent_failed",
			},
		});
		await expect(bounded(pending, "unsettled prompt rejection")).rejects.toMatchObject({
			code: "prompt_failed",
			message: "Prompt submission failed.",
		});
	} finally {
		fixture.dispose();
	}
});

// Observed against a Paseo review session: the SDK refused to publish a terminal because
// agent-owned async work outlived the turn, and the ACP session was left running forever.
test("ACP releases the running phase and accepts a new prompt after a settlement-grace rejection", async () => {
	const fixture = await createFixture();
	try {
		const pending = prompt(fixture, "unsettled prompt resources");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendTerminal({
			type: "agent_failed",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			error: {
				code: "terminal_uncertain",
				message: "Prompt resources did not settle before the terminalization grace expired.",
			},
		});
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			outcome: {
				kind: "failed",
				code: "prompt_failed",
				message: "Prompt resources did not settle before the terminalization grace expired.",
				provenance: "agent_failed",
			},
		});
		await expect(bounded(pending, "unsettled prompt rejection")).rejects.toMatchObject({
			code: "prompt_failed",
		});
		// the wedged session refused every later turn with `conflict`, which surfaced in
		// the client as a permanent "a foreground turn is already active".
		const { pending: next } = await promptWhenDelivered(fixture, "prompt after rejection", 2);
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "prompt after rejection")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("ACP settles a cancelled prompt when the aborted turn never publishes a terminal", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 25 });
	try {
		const pending = prompt(fixture, "cancel without terminal");
		await bounded(fixture.promptDelivered, "prompt delivery");
		const updatesBefore = fixture.updates.length;
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "cancel acknowledgement");
		expect(await bounded(pending, "cancelled settlement")).toEqual({ stopReason: "cancelled" });
		await waitFor(
			() =>
				fixture.updates
					.slice(updatesBefore)
					.some(
						update =>
							update.update.sessionUpdate === "session_info_update" &&
							(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
					),
			"cancelled idle phase",
		);
		expect(
			fixture.updates
				.slice(updatesBefore)
				.filter(
					update =>
						update.update.sessionUpdate === "session_info_update" &&
						(update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase === "idle",
				),
		).toHaveLength(1);
		const next = prompt(fixture, "prompt after cancel");
		await waitFor(() => fixture.promptDeliveryCount() === 2, "successor prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(next, "prompt after cancel")).toEqual({ stopReason: "end_turn" });
	} finally {
		fixture.dispose();
	}
});

test("ACP cancel grace preserves background activity that starts after acknowledgement", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 25 });
	try {
		const pending = prompt(fixture, "cancel with background successor");
		await bounded(fixture.promptDelivered, "prompt delivery");
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "cancel acknowledgement");
		fixture.sendTerminal({ type: "agent_start", sessionId: "prompt-terminal-session" });
		expect(await bounded(pending, "cancelled foreground settlement")).toEqual({ stopReason: "cancelled" });
		await waitFor(
			() =>
				fixture.updates
					.filter(update => update.update.sessionUpdate === "session_info_update")
					.map(update => (update.update as { _meta?: { gjcPhase?: string } })._meta?.gjcPhase)
					.at(-1) === "working",
			"background working after cancel grace",
		);
		fixture.sendTerminal({ type: "agent_end", sessionId: "prompt-terminal-session" });
	} finally {
		fixture.dispose();
	}
});

test("ACP keeps the authoritative terminal when it arrives inside the cancel grace", async () => {
	const fixture = await createFixture({ cancelSettlementGraceMs: 1_000 });
	try {
		const pending = prompt(fixture, "cancel with terminal");
		await bounded(fixture.promptDelivered, "prompt delivery");
		await bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "cancel acknowledgement");
		fixture.sendStopped("refusal");
		expect(await bounded(pending, "terminal settlement")).toEqual({ stopReason: "refusal" });
	} finally {
		fixture.dispose();
	}
});

test("ACP rejects a no_active_turn disposition as a cancel acknowledgement", async () => {
	const fixture = await createFixture({
		abortAcknowledgement: { ok: true, selection: "turn", turn: "no_active_turn", terminal: "terminal_no_effect" },
	});
	try {
		// no_active_turn provides no proof the worker was stopped (it can also be a
		// requester-ownership no-op after an SDK reconnect): the cancel must NOT
		// settle as acknowledged (review thread P1).
		await expect(
			bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "no-active-turn cancel acknowledgement"),
		).rejects.toThrow("SDK did not acknowledge cancellation");
	} finally {
		fixture.dispose();
	}
});

test("ACP rejects an uncertain disposition as a cancel acknowledgement without settling the prompt", async () => {
	const fixture = await createFixture({
		cancelSettlementGraceMs: 25,
		abortAcknowledgement: {
			ok: true,
			selection: "turn",
			turn: "uncertain",
			ownedWork: "uncertain",
			automaticDelivery: "none",
			resumeOnOwnedCompletion: false,
			reason: "owned_unsettled",
		},
	});
	try {
		const pending = prompt(fixture, "cancel into uncertainty");
		await bounded(fixture.promptDelivered, "prompt delivery");
		// uncertain proves nothing was stopped: the cancel is refused and the
		// prompt must NOT settle as cancelled (the real terminal decides it).
		await expect(
			bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "uncertain cancel acknowledgement"),
		).rejects.toThrow("SDK did not acknowledge cancellation");
		await Bun.sleep(60);
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Bun.sleep(30);
		expect(settled).toBe(false);
	} finally {
		fixture.dispose();
	}
});

test("ACP rejects a cancel acknowledgement that is neither terminal nor legacy", async () => {
	const fixture = await createFixture({ abortAcknowledgement: { ok: true, result: {} } });
	try {
		await expect(
			bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "unacknowledged cancel"),
		).rejects.toThrow("SDK did not acknowledge cancellation");
	} finally {
		fixture.dispose();
	}
});

test("ACP rejects a terminal disposition that echoes a foreign scope", async () => {
	const fixture = await createFixture({
		abortAcknowledgement: {
			ok: true,
			selection: "owned",
			turn: "stopped",
			ownedWork: "stopped",
			automaticDelivery: "none",
			resumeOnOwnedCompletion: false,
		},
	});
	try {
		// The default cancel requests scope "turn"; a disposition answering
		// selection "owned" belongs to another abort and must not settle this one.
		await expect(
			bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), "foreign-scope cancel"),
		).rejects.toThrow("SDK did not acknowledge cancellation");
	} finally {
		fixture.dispose();
	}
});

test("ACP rejects the deterministic no_effect and no_store dispositions as cancel acknowledgements", async () => {
	for (const turn of ["no_effect", "no_store"]) {
		const fixture = await createFixture({
			abortAcknowledgement: { ok: true, selection: "turn", turn, terminal: "terminal_no_effect" },
		});
		try {
			// A no-effect disposition is no proof the worker was stopped: the
			// cancel is refused (review thread P1).
			await expect(
				bounded(fixture.agent.cancel({ sessionId: fixture.sessionId }), `${turn} cancel acknowledgement`),
			).rejects.toThrow("SDK did not acknowledge cancellation");
		} finally {
			fixture.dispose();
		}
	}
});

test("ACP suppresses partial and duplicate terminals after settlement", async () => {
	const fixture = await createFixture();
	const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
	try {
		const pending = prompt(fixture, "late terminal suppression");
		await bounded(fixture.promptDelivered, "prompt delivery");
		fixture.sendStopped("end_turn");
		expect(await bounded(pending, "terminal completion")).toEqual({ stopReason: "end_turn" });
		// Settlement precedes the advisory end-of-turn work, so the suppression baseline is
		// taken once that work has flushed.
		await waitFor(() => idlePhaseUpdates(fixture.updates) > 1, "end-of-turn idle update");
		const updatesAfterSettlement = fixture.updates.length;
		const queriesAfterSettlement = fixture.queryCalls.length;
		fixture.sendTerminal({
			type: "agent_end",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			finalText: "late partial",
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		fixture.sendTerminal({
			type: "agent_failed",
			sessionId: "prompt-terminal-session",
			commandId: "prompt-terminal-command",
			turnId: "prompt-terminal-turn",
			finalText: "late duplicate",
			outcome: {
				kind: "failed",
				code: "prompt_failed",
				message: "late duplicate",
				provenance: "agent_failed",
			},
		});
		await Bun.sleep(30);
		expect(fixture.updates).toHaveLength(updatesAfterSettlement);
		expect(fixture.queryCalls).toHaveLength(queriesAfterSettlement);
		expect(errorSpy.mock.calls.some(([event]) => event === "acp_prompt_terminal_dropped")).toBe(false);
	} finally {
		errorSpy.mockRestore();
		fixture.dispose();
	}
});

test("ACP keeps correlationless session updates publishable after terminal settlement", async () => {
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
		await waitFor(
			() => fixture.updates.filter(update => update.update.sessionUpdate === "agent_message_chunk").length === 3,
			"post-terminal correlationless assistant update",
		);
		const lastChunk = fixture.updates.filter(update => update.update.sessionUpdate === "agent_message_chunk").at(-1);
		expect((lastChunk?.update as { content?: { text?: string } }).content?.text).toBe("after terminal");
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

for (const scenario of [
	"terminal",
	"failed",
	"failure_detail",
	"empty_content",
	"blank_content",
	"cancelled",
	"refusal",
	"max_tokens",
	"max_turn_requests",
	"pending",
	"unknown",
	"missing",
	"mismatch",
	"unavailable",
	"stalled",
] as const) {
	test(`ACP uncertain abort recovery reads exact status without replay: ${scenario}`, async () => {
		const explicitStop =
			scenario === "cancelled" ||
			scenario === "refusal" ||
			scenario === "max_tokens" ||
			scenario === "max_turn_requests";
		let recover: ((error: SdkClientError) => void) | undefined;
		const subscribe = AcpSdkAdapter.prototype.onReconnectFailed;
		const subscription = vi.spyOn(AcpSdkAdapter.prototype, "onReconnectFailed").mockImplementation(function (
			this: AcpSdkAdapter,
			handler,
		) {
			recover = handler;
			return subscribe.call(this, handler);
		});
		const fixture = await createFixture({
			abortAcknowledgement: { ok: false, reason: "resources_pending" },
			turnResultUnavailable: scenario === "unavailable",
			turnResultStalled: scenario === "stalled",
			turnResult: {
				commandId: scenario === "mismatch" ? "another-command" : "prompt-terminal-command",
				turnId: "prompt-terminal-turn",
				status:
					scenario === "pending"
						? "in_flight"
						: scenario === "unknown"
							? "unknown"
							: scenario === "failed" || scenario === "failure_detail"
								? "failed"
								: "terminal_ok",
				receiptState:
					scenario === "missing" || explicitStop ? "missing" : scenario === "pending" ? "absent" : "present",
				content:
					scenario === "empty_content" || explicitStop
						? undefined
						: { version: 1, type: "text", text: scenario === "blank_content" ? " \n " : "Recovered result" },
				error: { code: "provider_rejected", message: "Provider rejected execution." },
				outcome:
					scenario === "failure_detail"
						? undefined
						: scenario === "failed"
							? {
									kind: "failed",
									code: "prompt_failed",
									message: "aborted tool failed",
									provenance: "agent_failed",
								}
							: { kind: "stopped", reason: explicitStop ? scenario : "end_turn", provenance: "agent" },
			},
		});
		try {
			const pending = prompt(fixture, "abort with pending resource settlement");
			void pending.catch(() => undefined);
			await bounded(fixture.promptDelivered, "prompt delivery");
			fixture.sendTerminal({
				type: "tool_execution_start",
				sessionId: fixture.sessionId,
				commandId: "prompt-terminal-command",
				turnId: "prompt-terminal-turn",
				toolCallId: "aborted-tool",
				toolName: "bash",
				args: { command: "offline regression" },
			});
			await expect(fixture.agent.cancel({ sessionId: fixture.sessionId })).rejects.toBeDefined();
			fixture.sendTerminal({
				type: "agent_failed",
				sessionId: fixture.sessionId,
				commandId: "prompt-terminal-command",
				turnId: "prompt-terminal-turn",
				error: { code: "terminal_uncertain", message: "resources_pending" },
			});
			// A diagnostic failure after abort cannot supply an authoritative outcome.
			await Bun.sleep(30);
			expect(recover).toBeDefined();
			recover!(new SdkClientError("uncertain_after_send", "mutation outcome uncertain"));
			recover!(new SdkClientError("uncertain_after_send", "repeated heartbeat failure"));
			if (scenario === "terminal" || explicitStop)
				expect(await bounded(pending, "status recovery")).toEqual({
					stopReason: explicitStop ? scenario : "end_turn",
				});
			else
				await expect(bounded(pending, "bounded uncertain recovery")).rejects.toMatchObject({
					code:
						scenario === "failed"
							? "prompt_failed"
							: scenario === "failure_detail"
								? "provider_rejected"
								: "terminal_uncertain",
				});
			expect(fixture.queryCalls.filter(query => query === "turn.result")).toHaveLength(1);
			expect(fixture.promptDeliveryCount()).toBe(1);
		} finally {
			fixture.dispose();
			subscription.mockRestore();
		}
	});
}

for (const race of ["replacement", "authoritative_terminal"] as const) {
	test(`ACP pending status recovery cannot override ${race} after its deadline`, async () => {
		let recover: ((error: SdkClientError) => void) | undefined;
		const subscribe = AcpSdkAdapter.prototype.onReconnectFailed;
		const subscription = vi.spyOn(AcpSdkAdapter.prototype, "onReconnectFailed").mockImplementation(function (
			this: AcpSdkAdapter,
			handler,
		) {
			recover = handler;
			return subscribe.call(this, handler);
		});
		const fixture = await createFixture({ turnResultStalled: true, failBrokerSessionClose: race === "replacement" });
		try {
			const first = prompt(fixture, "status recovery race");
			void first.catch(() => undefined);
			await bounded(fixture.promptDelivered, "initial prompt delivery");
			await Bun.sleep(30);
			recover!(new SdkClientError("uncertain_after_send", "uncertain mutation"));
			await waitFor(() => fixture.queryCalls.includes("turn.result"), "pending status query");
			if (race === "replacement") {
				await expect(fixture.agent.closeSession({ sessionId: fixture.sessionId })).rejects.toMatchObject({
					code: "terminal_uncertain",
				});
				expect(await bounded(first, "retired prompt")).toEqual({ stopReason: "cancelled" });
				await fixture.agent.loadSession({ sessionId: fixture.sessionId, cwd: fixture.cwd, mcpServers: [] });
			} else {
				fixture.sendStopped("refusal");
				expect(await bounded(first, "authoritative ingress terminal")).toEqual({ stopReason: "refusal" });
			}
			let replacementSettled = false;
			const replacement = prompt(fixture, "replacement prompt");
			void replacement.then(
				() => {
					replacementSettled = true;
				},
				() => {
					replacementSettled = true;
				},
			);
			await waitFor(() => fixture.promptDeliveryCount() === 2, "replacement delivery");
			// Allow the original five-second status deadline to reject. It must neither
			// retire this attachment nor settle a successor that owns a new correlation.
			await Bun.sleep(5_100);
			expect(replacementSettled).toBe(false);
			fixture.sendStopped("end_turn");
			expect(await bounded(replacement, "successor terminal")).toEqual({ stopReason: "end_turn" });
			expect(fixture.queryCalls.filter(query => query === "turn.result")).toHaveLength(1);
			expect(fixture.promptDeliveryCount()).toBe(2);
		} finally {
			fixture.dispose();
			subscription.mockRestore();
		}
	});
}

for (const scenario of ["skill", "wrong_kind", "sensitive_error"] as const) {
	test(`ACP recovery preserves invocation kind and bounded query diagnostics: ${scenario}`, async () => {
		let recover: ((error: SdkClientError) => void) | undefined;
		const subscribe = AcpSdkAdapter.prototype.onReconnectFailed;
		const subscription = vi.spyOn(AcpSdkAdapter.prototype, "onReconnectFailed").mockImplementation(function (
			this: AcpSdkAdapter,
			handler,
		) {
			recover = handler;
			return subscribe.call(this, handler);
		});
		const secret = `Bearer private-token /private/transcript ${"sensitive".repeat(1_000)}`;
		const fixture = await createFixture({
			turnResultError: scenario === "sensitive_error" ? { code: "session_unavailable", message: secret } : undefined,
			turnResult: {
				kind: scenario === "wrong_kind" ? "prompt" : "skill",
				commandId: "prompt-terminal-command",
				turnId: "prompt-terminal-turn",
				status: "terminal_ok",
				receiptState: "present",
				content: { version: 1, type: "text", text: "Skill result" },
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			},
		});
		try {
			const pending = prompt(fixture, "/skill:review inspect");
			void pending.catch(() => undefined);
			await bounded(fixture.promptDelivered, "skill dispatch");
			await Bun.sleep(30);
			recover!(new SdkClientError("uncertain_after_send", secret));
			if (scenario === "skill") {
				expect(await bounded(pending, "skill recovery")).toEqual({ stopReason: "end_turn" });
			} else {
				const error = await bounded(
					pending.then(
						() => undefined,
						error => error,
					),
					"recovery rejection",
				);
				expect(error).toMatchObject({ code: "terminal_uncertain" });
				expect(error.message).toContain("kind=skill");
				expect(error.message).not.toContain("private-token");
				expect(error.message).not.toContain("/private/transcript");
				expect(error.message.length).toBeLessThan(512);
				if (scenario === "sensitive_error") expect(error.message).toContain("status query unavailable");
			}
			expect(fixture.turnResultInputs).toEqual([
				{ kind: "skill", commandId: "prompt-terminal-command", turnId: "prompt-terminal-turn" },
			]);
			expect(fixture.invocationOperations).toEqual(["skill.invoke"]);
		} finally {
			fixture.dispose();
			subscription.mockRestore();
		}
	});
}

for (const scenario of [
	"prompt_failed",
	"prompt_deadline_exceeded",
	"error_detail",
	"accepted",
	"in_flight",
	"unknown",
	"absent_receipt",
	"missing_receipt_field",
] as const) {
	test(`ACP separates failed execution from unknown receipt availability: ${scenario}`, async () => {
		let recover: ((error: SdkClientError) => void) | undefined;
		const subscribe = AcpSdkAdapter.prototype.onReconnectFailed;
		const subscription = vi.spyOn(AcpSdkAdapter.prototype, "onReconnectFailed").mockImplementation(function (
			this: AcpSdkAdapter,
			handler,
		) {
			recover = handler;
			return subscribe.call(this, handler);
		});
		const authoritative =
			scenario === "prompt_failed" || scenario === "prompt_deadline_exceeded" || scenario === "error_detail";
		const classifier =
			scenario === "error_detail"
				? "provider_rejected"
				: scenario === "prompt_deadline_exceeded"
					? scenario
					: "prompt_failed";
		const fixture = await createFixture({
			turnResult: {
				kind: "prompt",
				commandId: "prompt-terminal-command",
				turnId: "prompt-terminal-turn",
				status: scenario === "accepted" || scenario === "in_flight" || scenario === "unknown" ? scenario : "failed",
				receiptState:
					scenario === "absent_receipt" ? "absent" : scenario === "missing_receipt_field" ? undefined : "unknown",
				error: { code: classifier, message: "Execution failed." },
				outcome:
					scenario === "error_detail"
						? undefined
						: {
								kind: "failed",
								code: classifier,
								message: "Execution failed.",
								provenance: scenario === "prompt_deadline_exceeded" ? "deadline" : "agent_failed",
							},
			},
		});
		try {
			const pending = prompt(fixture, "failed execution without receipt");
			void pending.catch(() => undefined);
			await bounded(fixture.promptDelivered, "initial dispatch");
			if (!authoritative) fixture.sendDiagnostic();
			await Bun.sleep(30);
			recover!(new SdkClientError("uncertain_after_send", "uncertain transport"));
			await expect(bounded(pending, "failed status recovery")).rejects.toMatchObject({
				code: authoritative ? classifier : "terminal_uncertain",
				...(authoritative ? { message: "Execution failed." } : {}),
			});
			expect(fixture.turnResultInputs).toEqual([
				{ kind: "prompt", commandId: "prompt-terminal-command", turnId: "prompt-terminal-turn" },
			]);
			expect(fixture.invocationOperations).toEqual(["turn.prompt"]);
			expect(fixture.updates.filter(update => update.update.sessionUpdate === "agent_message_chunk")).toEqual([]);
			if (authoritative) {
				// A new prompt on the same attachment proves unknown receipt availability
				// did not invoke failSession/teardown. This is new work, not a replay.
				const successor = prompt(fixture, "distinct successor");
				void successor.catch(() => undefined);
				await waitFor(() => fixture.promptDeliveryCount() === 2, "same attachment successor");
				fixture.sendStopped("refusal");
				expect(await bounded(successor, "successor terminal")).toEqual({ stopReason: "refusal" });
				expect(fixture.turnResultInputs).toHaveLength(1);
				expect(fixture.invocationOperations).toEqual(["turn.prompt", "turn.prompt"]);
				expect(fixture.updates.filter(update => update.update.sessionUpdate === "agent_message_chunk")).toEqual([]);
			}
		} finally {
			fixture.dispose();
			subscription.mockRestore();
		}
	});
}
