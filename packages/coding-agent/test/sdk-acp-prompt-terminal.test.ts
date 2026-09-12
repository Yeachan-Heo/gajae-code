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
	sendAssistantMessage(text: string, correlated?: boolean): void;
	sendIdle(): void;
	dispose(): void;
	queryCalls: string[];
	blockedAdvisoryQueryCount(): number;
	releaseBlockedAdvisoryQueries(): void;
	releaseIdleUpdate(): void;
	releaseWorkingUpdate(): void;
	releaseAgentMessageUpdate(): void;
	releaseFailureDiagnostic(): void;
	releasePromptAcknowledgement(): void;
	sendTerminal(frame: Record<string, unknown>): void;
	mutationInputs: Record<string, unknown>[];
	recoveryInputs: Record<string, unknown>[];
	releaseRecoveryResult(result: unknown): void;
	releaseRecoveryAcknowledgement(result: Record<string, unknown>, index?: number): void;
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
		uncertainPromptAcknowledgement?: boolean;
		deferRecoveryAcknowledgement?: boolean;
		retainRecoveryQuery?: boolean;
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
	const blockedAdvisoryQueries: Array<{ socket: TestSocket; id: string; result: unknown }> = [];
	const mutationInputs: Record<string, unknown>[] = [];
	const recoveryInputs: Record<string, unknown>[] = [];
	let recoveryQuery: { socket: TestSocket; id: unknown } | undefined;
	const recoveryAcknowledgements: Array<{ socket: TestSocket; id: unknown }> = [];
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
	const sendAssistantMessage = (text: string, correlated = false): void => {
		send({
			type: "event",
			...(correlated ? { sessionId, ...activeCorrelation() } : {}),
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
					if (frame.query === "turn.result" && options.retainRecoveryQuery) {
						recoveryInputs.push(frame.input as Record<string, unknown>);
						recoveryQuery = { socket, id: frame.id };
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
					promptSocket = socket;
					promptDeliveries++;
					mutationInputs.push(frame.input as Record<string, unknown>);
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
					if (options.uncertainPromptAcknowledgement) {
						socket.send(
							JSON.stringify({
								type: "control_response",
								id: frame.id,
								ok: false,
								error: { code: "uncertain_after_send", message: "fixture lost mutation response" },
							}),
						);
						return;
					}
					if (options.deferRecoveryAcknowledgement) {
						recoveryAcknowledgements.push({ socket, id: frame.id });
						return;
					}
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
		mutationInputs,
		recoveryInputs,
		releaseRecoveryResult: result => {
			if (!recoveryQuery) throw new Error("Expected retained recovery query");
			recoveryQuery.socket.send(JSON.stringify({ type: "query_response", id: recoveryQuery.id, ok: true, result }));
		},
		releaseRecoveryAcknowledgement: (result, index = 0) => {
			const acknowledgement = recoveryAcknowledgements[index];
			if (!acknowledgement) throw new Error("Expected retained mutation acknowledgement");
			acknowledgement.socket.send(
				JSON.stringify({ type: "control_response", id: acknowledgement.id, ok: true, result }),
			);
		},
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

/** Retain the original attachment's notification callback, including after replacement. */
async function createRecoveryFixture(
	acknowledgement: "held" | "rejected" | "accepted",
	blockedAgentMessageText?: string,
): Promise<Fixture & { notify(code?: string): void }> {
	let notify: ((error: SdkClientError) => void) | undefined;
	const original = AcpSdkAdapter.prototype.onReconnectFailed;
	const registration = vi.spyOn(AcpSdkAdapter.prototype, "onReconnectFailed").mockImplementation(function (
		this: AcpSdkAdapter,
		handler,
	) {
		notify = handler;
		return original.call(this, handler);
	});
	try {
		const fixture = await createFixture({
			retainRecoveryQuery: true,
			deferRecoveryAcknowledgement: acknowledgement === "held",
			uncertainPromptAcknowledgement: acknowledgement === "rejected",
			blockedAgentMessageText,
			cancelSettlementGraceMs: 25,
		});
		const callback = notify;
		if (!callback) throw new Error("Expected session reconnect failure subscription");
		return {
			...fixture,
			notify: (code = "uncertain_after_send") => callback(new SdkClientError(code, "fixture observation lost")),
		};
	} finally {
		registration.mockRestore();
	}
}

function retainedTerminal(fixture: Fixture, kind: "prompt" | "skill" = "prompt"): Record<string, unknown> {
	return {
		kind,
		clientRef: fixture.mutationInputs.at(-1)?.clientRef,
		commandId: "prompt-terminal-command",
		turnId: "prompt-terminal-turn",
		status: "terminal_ok",
		outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		receiptState: "present",
		content: { version: 1, type: "text", text: "retained report" },
	};
}

for (const kind of ["prompt", "skill"] as const) {
	for (const acknowledgement of ["held", "rejected", "accepted"] as const) {
		test(`ACP recovers ${kind} retained terminal after ${acknowledgement} acknowledgement without replay`, async () => {
			const fixture = await createRecoveryFixture(acknowledgement);
			try {
				const pending = fixture.agent.prompt({
					sessionId: fixture.sessionId,
					messageId: "00000000-0000-4000-8000-000000000001",
					prompt: [{ type: "text", text: kind === "skill" ? "/skill:review args" : "recover report" }],
					_meta: { clientRef: "caller-must-not-own-reference" },
				} as PromptRequest);
				await bounded(fixture.promptDelivered, "recovery mutation delivery");
				if (acknowledgement === "accepted") {
					fixture.sendAssistantMessage("retained ", true);
					await waitFor(
						() => fixture.updates.some(update => update.update.sessionUpdate === "agent_message_chunk"),
						"acknowledged stream barrier",
					);
				}
				fixture.notify();
				fixture.notify("reconnect_exhausted");
				await waitFor(() => fixture.recoveryInputs.length === 1, "single recovery query");
				const clientRef = fixture.mutationInputs[0]?.clientRef;
				expect(clientRef).toEqual(expect.any(String));
				expect(clientRef).not.toBe("caller-must-not-own-reference");
				expect(fixture.recoveryInputs).toEqual([
					acknowledgement === "accepted"
						? { kind, commandId: "prompt-terminal-command", turnId: "prompt-terminal-turn" }
						: { kind, clientRef },
				]);
				// Result builders omit sessionId: the exact session adapter supplies authority.
				fixture.releaseRecoveryResult(retainedTerminal(fixture, kind));
				expect(await bounded(pending, "retained terminal settlement")).toEqual({ stopReason: "end_turn" });
				await waitFor(() => idlePhaseUpdates(fixture.updates) >= 2, "retained text publication");
				const text = fixture.updates
					.flatMap(update =>
						update.update.sessionUpdate === "agent_message_chunk" && update.update.content.type === "text"
							? [update.update.content.text]
							: [],
					)
					.join("");
				expect(text).toBe("retained report");
				expect(fixture.promptDeliveryCount()).toBe(1);
				expect(fixture.recoveryInputs).toHaveLength(1);
			} finally {
				fixture.dispose();
			}
		});
	}
}

const unusableRecoveryPages: Array<[string, Record<string, unknown>]> = [
	["missing kind", { kind: undefined }],
	["wrong kind", { kind: "skill" }],
	["wrong session", { sessionId: "retired-session" }],
	["wrong reference", { clientRef: "retired-reference" }],
	["missing reference", { clientRef: undefined }],
	["partial correlation", { turnId: undefined }],
	["empty correlation", { commandId: " " }],
	["conflicting command alias", { command_id: "other-command" }],
	["conflicting turn alias", { turn_id: "other-turn" }],
	["accepted", { status: "accepted" }],
	["in flight", { status: "in_flight" }],
	["unknown", { status: "unknown" }],
	["missing successful receipt", { receiptState: "missing" }],
	["unknown successful receipt", { receiptState: "unknown" }],
	["blank text", { content: { version: 1, type: "text", text: " \n" } }],
	["wrong text version", { content: { version: 2, type: "text", text: "not v1" } }],
	["wrong content type", { content: { version: 1, type: "json", text: "not text" } }],
	["missing outcome", { outcome: undefined }],
	["unknown stopped reason", { outcome: { kind: "stopped", reason: "unknown", provenance: "agent" } }],
	["failure without evidence", { status: "failed", outcome: undefined }],
	[
		"oversized structured failure",
		{ status: "failed", outcome: undefined, error: { code: "failed", message: "x".repeat(513) } },
	],
	[
		"malformed structured failure code",
		{ status: "failed", outcome: undefined, error: { code: "bad code", message: "failure" } },
	],
];
for (const [label, page] of unusableRecoveryPages) {
	test(`ACP rejects ${label} retained evidence without replay or reattachment`, async () => {
		const fixture = await createRecoveryFixture("rejected");
		try {
			const pending = prompt(fixture, label);
			void pending.catch(() => undefined);
			await waitFor(() => fixture.recoveryInputs.length === 1, "recovery query");
			fixture.releaseRecoveryResult({ ...retainedTerminal(fixture), ...page });
			await expect(bounded(pending, "uncertain recovery rejection")).rejects.toMatchObject({
				code: "terminal_uncertain",
			});
			expect(fixture.promptDeliveryCount()).toBe(1);
			expect(fixture.recoveryInputs).toHaveLength(1);
			await expect(prompt(fixture, "must not automatically reattach")).rejects.toMatchObject({ code: "not_found" });
		} finally {
			fixture.dispose();
		}
	});
}

for (const page of [
	{
		status: "failed",
		outcome: { kind: "failed", code: "prompt_failed", message: "host failure", provenance: "agent_failed" },
		receiptState: "missing",
	},
	{
		status: "failed",
		outcome: undefined,
		error: { code: "retained_page_failed", message: "Retained page failed." },
		receiptState: "unknown",
	},
]) {
	test(`ACP preserves retained rejection ${page.error?.code ?? "prompt_failed"}`, async () => {
		const fixture = await createRecoveryFixture("rejected");
		try {
			const pending = prompt(fixture, "retained failure");
			void pending.catch(() => undefined);
			await waitFor(() => fixture.recoveryInputs.length === 1, "failed recovery query");
			fixture.releaseRecoveryResult({ ...retainedTerminal(fixture), ...page });
			await expect(bounded(pending, "retained failure")).rejects.toMatchObject({
				code: page.error?.code ?? "prompt_failed",
			});
			expect(fixture.promptDeliveryCount()).toBe(1);
			expect(fixture.recoveryInputs).toHaveLength(1);
		} finally {
			fixture.dispose();
		}
	});
}

for (const [label, patch] of [
	["missing kind", { kind: undefined }],
	["wrong kind", { kind: "skill" }],
	["wrong session", { sessionId: "foreign-session" }],
	["wrong ref", { clientRef: "foreign-reference" }],
	["wrong acknowledged turn", { turnId: "different-turn" }],
	["partial acknowledged correlation", { commandId: undefined }],
] as Array<[string, Record<string, unknown>]>) {
	test(`ACP post-ack recovery rejects ${label}`, async () => {
		const fixture = await createRecoveryFixture("accepted");
		try {
			const pending = prompt(fixture, "post-ack mismatch");
			void pending.catch(() => undefined);
			await bounded(fixture.promptDelivered, "accepted mutation");
			fixture.sendAssistantMessage("ack barrier");
			await waitFor(
				() => fixture.updates.some(update => update.update.sessionUpdate === "agent_message_chunk"),
				"ack stream barrier",
			);
			fixture.notify();
			await waitFor(() => fixture.recoveryInputs.length === 1, "post-ack query");
			expect(fixture.recoveryInputs[0]).toEqual({
				kind: "prompt",
				commandId: "prompt-terminal-command",
				turnId: "prompt-terminal-turn",
			});
			fixture.releaseRecoveryResult({ ...retainedTerminal(fixture), ...patch });
			await expect(bounded(pending, "post-ack rejection")).rejects.toMatchObject({ code: "terminal_uncertain" });
			expect(fixture.promptDeliveryCount()).toBe(1);
			expect(fixture.recoveryInputs).toHaveLength(1);
		} finally {
			fixture.dispose();
		}
	});
}

for (const reason of ["max_tokens", "max_turn_requests", "refusal", "cancelled"] as const) {
	test(`ACP recovers ${reason} without inventing an end-turn text receipt`, async () => {
		const fixture = await createRecoveryFixture("accepted");
		try {
			const pending = prompt(fixture, "non-text stopped evidence");
			await bounded(fixture.promptDelivered, "accepted mutation");
			fixture.sendAssistantMessage("ack barrier");
			await waitFor(
				() => fixture.updates.some(update => update.update.sessionUpdate === "agent_message_chunk"),
				"ack stream barrier",
			);
			fixture.notify("reconnect_exhausted");
			await waitFor(() => fixture.recoveryInputs.length === 1, "post-ack query");
			fixture.releaseRecoveryResult({
				...retainedTerminal(fixture),
				clientRef: undefined,
				content: undefined,
				receiptState: "missing",
				outcome: { kind: "stopped", reason, provenance: reason === "cancelled" ? "client_cancel" : "agent" },
			});
			expect(await bounded(pending, "retained non-text stop")).toEqual({ stopReason: reason });
			expect(fixture.promptDeliveryCount()).toBe(1);
			expect(fixture.recoveryInputs).toHaveLength(1);
		} finally {
			fixture.dispose();
		}
	});
}

for (const failure of ["unavailable", "timeout"] as const) {
	test(`ACP bounded recovery query ${failure} remains uncertain and ignores late results`, async () => {
		const fixture = await createRecoveryFixture("held");
		const queryResult = Promise.withResolvers<unknown>();
		let queries = 0;
		let expire: (() => void) | undefined;
		const originalQuery = AcpSdkAdapter.prototype.query;
		const querySpy = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(async function (
			this: AcpSdkAdapter,
			query,
			input,
			cursor,
		) {
			if (query !== "turn.result") return await originalQuery.call(this, query, input, cursor);
			queries++;
			if (failure === "unavailable") throw new Error("query unavailable");
			return await queryResult.promise;
		});
		const originalTimeout = globalThis.setTimeout;
		const observedTimeout = new Proxy(originalTimeout, {
			apply(target, thisArg, args: unknown[]): NodeJS.Timeout {
				const timer: NodeJS.Timeout = Reflect.apply(target, thisArg, args);
				if (args[1] === 5_000) {
					clearTimeout(timer);
					expire = () => {
						if (typeof args[0] === "function") Reflect.apply(args[0], undefined, args.slice(2));
					};
				}
				return timer;
			},
		});
		const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(observedTimeout);
		try {
			const pending = prompt(fixture, "bounded observation");
			void pending.catch(() => undefined);
			await bounded(fixture.promptDelivered, "held mutation");
			fixture.notify();
			await waitFor(() => queries === 1, "bounded query start");
			if (failure === "timeout") {
				expect(expire).toBeDefined();
				expire?.();
			}
			await expect(bounded(pending, "bounded uncertainty")).rejects.toMatchObject({
				code: "terminal_uncertain",
				message: expect.stringContaining(failure === "timeout" ? "timed out after 5000ms" : "query unavailable"),
			});
			queryResult.resolve(retainedTerminal(fixture));
			await Bun.sleep(0);
			expect(fixture.updates.some(update => update.update.sessionUpdate === "agent_message_chunk")).toBe(false);
			expect(queries).toBe(1);
			expect(fixture.promptDeliveryCount()).toBe(1);
			await expect(prompt(fixture, "no automatic reattach")).rejects.toMatchObject({ code: "not_found" });
		} finally {
			timerSpy.mockRestore();
			querySpy.mockRestore();
			queryResult.resolve(undefined);
			fixture.dispose();
		}
	});
}

test("ACP exact reserved terminal wins while recovery and publication are pending", async () => {
	const fixture = await createRecoveryFixture("accepted", "blocking stream");
	try {
		let settled = false;
		const pending = prompt(fixture, "reserved terminal").then(result => {
			settled = true;
			return result;
		});
		await bounded(fixture.promptDelivered, "accepted mutation");
		fixture.sendAssistantMessage("blocking stream");
		await bounded(fixture.agentMessageUpdateEntered, "blocked frame owner");
		fixture.notify();
		await waitFor(() => fixture.recoveryInputs.length === 1, "reserved terminal query");
		fixture.sendStopped("max_tokens");
		fixture.releaseRecoveryResult(retainedTerminal(fixture));
		// Query and terminal share a socket: its terminal ingress precedes its query response.
		await Bun.sleep(0);
		expect(settled).toBe(false);
		fixture.releaseAgentMessageUpdate();
		expect(await bounded(pending, "reserved terminal settlement")).toEqual({ stopReason: "max_tokens" });
		expect(fixture.recoveryInputs).toHaveLength(1);
	} finally {
		fixture.releaseAgentMessageUpdate();
		fixture.dispose();
	}
});

test("ACP recovery settlement is independent of advisory final-text backpressure", async () => {
	const fixture = await createRecoveryFixture("rejected", "retained report");
	try {
		const pending = prompt(fixture, "recover with blocked publication");
		await waitFor(() => fixture.recoveryInputs.length === 1, "recovery query");
		fixture.releaseRecoveryResult(retainedTerminal(fixture));
		expect(await bounded(pending, "settlement before publication")).toEqual({ stopReason: "end_turn" });
		await bounded(fixture.agentMessageUpdateEntered, "blocked recovered final text");
		expect(fixture.updates.some(update => update.update.sessionUpdate === "agent_message_chunk")).toBe(false);
	} finally {
		fixture.releaseAgentMessageUpdate();
		fixture.dispose();
	}
});

test("ACP old recovery cannot settle a same-id replacement record and adapter", async () => {
	const fixture = await createRecoveryFixture("accepted");
	const result = Promise.withResolvers<unknown>();
	const entered = Promise.withResolvers<void>();
	const originalQuery = AcpSdkAdapter.prototype.query;
	let queries = 0;
	const querySpy = vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(async function (
		this: AcpSdkAdapter,
		query,
		input,
		cursor,
	) {
		if (query !== "turn.result") return await originalQuery.call(this, query, input, cursor);
		queries++;
		entered.resolve();
		return await result.promise;
	});
	try {
		const first = prompt(fixture, "retired attachment recovery");
		await bounded(fixture.promptDelivered, "first mutation");
		fixture.sendAssistantMessage("ack barrier");
		await waitFor(
			() => fixture.updates.some(update => update.update.sessionUpdate === "agent_message_chunk"),
			"ack barrier",
		);
		fixture.notify();
		await bounded(entered.promise, "old adapter query");
		const oldPage = retainedTerminal(fixture);
		await fixture.agent.closeSession({ sessionId: fixture.sessionId });
		expect(await bounded(first, "explicitly closed predecessor")).toEqual({ stopReason: "cancelled" });
		await fixture.agent.loadSession({ sessionId: fixture.sessionId, cwd: fixture.cwd, mcpServers: [] });
		const { pending: successor } = await promptWhenDelivered(fixture, "replacement owner", 2);
		let successorSettled = false;
		void successor.then(() => {
			successorSettled = true;
		});
		fixture.notify();
		result.resolve(oldPage);
		await Bun.sleep(0);
		expect(successorSettled).toBe(false);
		expect(queries).toBe(1);
		expect(fixture.mutationInputs[0]?.clientRef).not.toBe(fixture.mutationInputs[1]?.clientRef);
		fixture.sendStopped("max_tokens");
		expect(await bounded(successor, "replacement terminal")).toEqual({ stopReason: "max_tokens" });
		expect(
			fixture.updates.some(
				update =>
					update.update.sessionUpdate === "agent_message_chunk" &&
					update.update.content.type === "text" &&
					update.update.content.text === "retained report",
			),
		).toBe(false);
	} finally {
		result.resolve(undefined);
		querySpy.mockRestore();
		fixture.dispose();
	}
});

for (const lateAck of ["identical", "mismatching"] as const) {
	test(`ACP recovered ${lateAck} late acknowledgement cannot abort or unfence a successor`, async () => {
		const fixture = await createRecoveryFixture("held");
		const firstAck = Promise.withResolvers<void>();
		const originalPrompt = AcpSdkAdapter.prototype.prompt;
		let calls = 0;
		const promptSpy = vi.spyOn(AcpSdkAdapter.prototype, "prompt").mockImplementation(async function (
			this: AcpSdkAdapter,
			input,
		) {
			const first = ++calls === 1;
			const acknowledgement = await originalPrompt.call(this, input);
			if (first) firstAck.resolve();
			return acknowledgement;
		});
		const cancelSpy = vi.spyOn(AcpSdkAdapter.prototype, "cancel");
		try {
			const first = prompt(fixture, "recover before ack");
			await bounded(fixture.promptDelivered, "first held mutation");
			fixture.notify();
			await waitFor(() => fixture.recoveryInputs.length === 1, "first result lookup");
			fixture.releaseRecoveryResult({
				...retainedTerminal(fixture),
				content: undefined,
				receiptState: "missing",
				outcome: { kind: "stopped", reason: "max_tokens", provenance: "agent" },
			});
			expect(await bounded(first, "recovered predecessor")).toEqual({ stopReason: "max_tokens" });
			const { pending: second } = await promptWhenDelivered(fixture, "successor with pending ack", 2);
			await fixture.agent.cancel({ sessionId: fixture.sessionId });
			expect(await bounded(second, "successor explicit cancellation")).toEqual({ stopReason: "cancelled" });
			fixture.releaseRecoveryAcknowledgement({
				accepted: true,
				commandId: lateAck === "identical" ? "prompt-terminal-command" : "prompt-terminal-command-2",
				turnId: lateAck === "identical" ? "prompt-terminal-turn" : "prompt-terminal-turn-2",
			});
			await bounded(firstAck.promise, "late predecessor acknowledgement");
			await Bun.sleep(0);
			expect(cancelSpy).toHaveBeenCalledTimes(1);
			await expect(prompt(fixture, "successor fence still held")).rejects.toMatchObject({ code: "conflict" });
			expect(fixture.promptDeliveryCount()).toBe(2);
			fixture.releaseRecoveryAcknowledgement(
				{ accepted: true, commandId: "prompt-terminal-command-2", turnId: "prompt-terminal-turn-2" },
				1,
			);
			const { pending: third } = await promptWhenDelivered(fixture, "successor fence released by its own ack", 3);
			fixture.releaseRecoveryAcknowledgement(
				{ accepted: true, commandId: "prompt-terminal-command-3", turnId: "prompt-terminal-turn-3" },
				2,
			);
			fixture.sendStopped("max_tokens");
			expect(await bounded(third, "third exact terminal")).toEqual({ stopReason: "max_tokens" });
			expect(fixture.recoveryInputs).toHaveLength(1);
		} finally {
			cancelSpy.mockRestore();
			promptSpy.mockRestore();
			fixture.dispose();
		}
	});
}

test("ACP recovery rejects retained correlation from a settled predecessor", async () => {
	const fixture = await createRecoveryFixture("accepted");
	try {
		const first = prompt(fixture, "retire first identity");
		await bounded(fixture.promptDelivered, "first accepted mutation");
		fixture.sendStopped("max_tokens");
		expect(await bounded(first, "first terminal")).toEqual({ stopReason: "max_tokens" });
		const { pending: second } = await promptWhenDelivered(fixture, "lookup second identity", 2);
		void second.catch(() => undefined);
		fixture.notify();
		await waitFor(() => fixture.recoveryInputs.length === 1, "second recovery query");
		fixture.releaseRecoveryResult(retainedTerminal(fixture));
		await expect(bounded(second, "retired result rejected")).rejects.toMatchObject({ code: "terminal_uncertain" });
		expect(fixture.promptDeliveryCount()).toBe(2);
		expect(fixture.recoveryInputs).toHaveLength(1);
	} finally {
		fixture.dispose();
	}
});

test("ACP rejects conflicting retained-result envelope correlation", async () => {
	const fixture = await createRecoveryFixture("rejected");
	try {
		const pending = prompt(fixture, "conflicting envelope");
		void pending.catch(() => undefined);
		await waitFor(() => fixture.recoveryInputs.length === 1, "recovery query");
		fixture.releaseRecoveryResult({ command_id: "foreign-envelope-command", result: retainedTerminal(fixture) });
		await expect(bounded(pending, "conflicting envelope rejection")).rejects.toMatchObject({
			code: "terminal_uncertain",
		});
		expect(fixture.promptDeliveryCount()).toBe(1);
		expect(fixture.recoveryInputs).toHaveLength(1);
	} finally {
		fixture.dispose();
	}
});

for (const ref of ["missing", "wrong"] as const) {
	test(`ACP pre-ack lookup still requires its ${ref} ref when acknowledgement arrives during recovery`, async () => {
		const fixture = await createRecoveryFixture("held");
		try {
			const pending = prompt(fixture, "ack crossed recovery read");
			void pending.catch(() => undefined);
			await bounded(fixture.promptDelivered, "held mutation");
			fixture.notify();
			await waitFor(() => fixture.recoveryInputs.length === 1, "pre-ack query");
			expect(fixture.recoveryInputs[0]).toEqual({ kind: "prompt", clientRef: fixture.mutationInputs[0]?.clientRef });
			fixture.releaseRecoveryAcknowledgement({
				accepted: true,
				commandId: "prompt-terminal-command",
				turnId: "prompt-terminal-turn",
			});
			fixture.sendAssistantMessage("ack barrier");
			await waitFor(
				() => fixture.updates.some(update => update.update.sessionUpdate === "agent_message_chunk"),
				"late ack barrier",
			);
			fixture.releaseRecoveryResult({
				...retainedTerminal(fixture),
				clientRef: ref === "missing" ? undefined : "foreign-ref",
			});
			await expect(bounded(pending, "original lookup authority")).rejects.toMatchObject({
				code: "terminal_uncertain",
			});
			expect(fixture.promptDeliveryCount()).toBe(1);
			expect(fixture.recoveryInputs).toHaveLength(1);
		} finally {
			fixture.dispose();
		}
	});
}

test("ACP changed connection during recovery fails uncertain without reattachment", async () => {
	const fixture = await createRecoveryFixture("held");
	try {
		const pending = prompt(fixture, "connection replacement during lookup");
		void pending.catch(() => undefined);
		await bounded(fixture.promptDelivered, "held mutation");
		fixture.notify();
		await waitFor(() => fixture.recoveryInputs.length === 1, "original attachment query");
		fixture.sendTerminal({ type: "hello", connectionId: "replacement-connection" });
		await expect(bounded(pending, "changed connection uncertainty")).rejects.toMatchObject({
			code: "terminal_uncertain",
		});
		expect(fixture.promptDeliveryCount()).toBe(1);
		expect(fixture.recoveryInputs).toHaveLength(1);
		await expect(prompt(fixture, "must explicitly reconcile ownership")).rejects.toMatchObject({ code: "not_found" });
	} finally {
		fixture.dispose();
	}
});
