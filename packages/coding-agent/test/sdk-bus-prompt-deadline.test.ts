import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { markNonDispatchedToolEvent, type RunSettlementProof } from "@gajae-code/agent-core";
import { logger } from "@gajae-code/utils";
import type { Settings } from "../src/config/settings";
import type { ExtensionActions, ExtensionAPI } from "../src/extensibility/extensions/types";
import { createNotificationsExtension } from "../src/sdk/bus";
import { TOOL_CALL_BOUNDARY_GRACE_MS } from "../src/sdk/prompt-tool-boundary";

/**
 * The notification/SDK bus host route and the SDK-only host route are mutually
 * exclusive (`src/sdk/session.ts`), and the bus route wins whenever it is
 * eligible. The SDK-only route bounds an accepted prompt with the progress-aware
 * lease `min(lastAttributableProgressAt + sdk.promptDeadlineMs, acceptedAt +
 * sdk.promptMaxRuntimeMs)`, while the bus route armed a single fixed timer from
 * `sdk.promptDeadlineMs` at acceptance: no renewal on attributable tool
 * boundaries and no maximum-runtime bound at all.
 *
 * These cases drive the real bus wiring over its own transport and assert the
 * observable terminal, not the timer.
 */

const dirs: string[] = [];
const sockets: WebSocket[] = [];
/** Captured before any scheduling spy so re-entry always reaches the real timer. */
const realSetTimeout = globalThis.setTimeout;

afterEach(async () => {
	await Promise.all(sockets.splice(0).map(closeSocket));
	for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

async function closeSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	socket.addEventListener("close", () => resolve(), { once: true });
	socket.close();
	await Promise.race([promise, Bun.sleep(500)]);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

function deadlineSettings(cwd: string, leaseMs: number, maxRuntimeMs: number): Settings {
	return {
		get: (key: string) => {
			if (key === "sdk.promptDeadlineMs") return leaseMs;
			if (key === "sdk.promptMaxRuntimeMs") return maxRuntimeMs;
			return undefined;
		},
		getAgentDir: () => cwd,
	} as unknown as Settings;
}

function context(
	cwd: string,
	sessionId: string,
	abortPromptAndWait: (handle: string, options: { graceMs: number }) => Promise<RunSettlementProof> = async () => ({
		status: "settled",
		terminalScope: {},
	}),
): Record<string, unknown> {
	return {
		cwd,
		sessionMetadata: { kind: "main", taskDepth: 0 },
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => cwd,
			getSessionName: () => "bus prompt deadline",
			getUsageStatistics: () => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
			getBranch: () => [],
		},
		getContextUsage: () => ({ tokens: 3, contextWindow: 100, percent: 3 }),
		model: { provider: "fixture-provider", id: "fixture-model" },
		getThinkingLevel: () => "low",
		// A bound execution handle plus a settled abort proof is what lets the
		// deadline reach its real terminal instead of failing closed as uncertain.
		getActivePromptHandle: () => "bus-deadline-run-handle",
		abortPromptAndWait,
		getSystemPrompt: () => ["test"],
		isIdle: () => true,
		hasPendingMessages: () => false,
		getPendingMessageCounts: () => ({ steering: 0, followUp: 0, nextTurn: 0 }),
		resolveTool: () => undefined,
	};
}

/** Toggle that makes the very next accepted prompt fail its durable-accept commit. */
interface AcceptFailure {
	armed: boolean;
}

/**
 * The run resource ledger's `kind: "tool"` entries for the bound handle, as a
 * test double. AgentLoop takes that lease SYNCHRONOUSLY before it invokes a
 * tool's `execute` and releases it at the call's real end, so adding/removing an
 * id here models the true execution boundary — independently of whether the
 * corresponding `tool_execution_start` has finished crossing the asynchronous
 * extension fanout yet (#5637).
 */
type LedgerTools = Set<string>;

function start(
	ctx: Record<string, unknown>,
	settings: Settings,
	acceptFailure: AcceptFailure = { armed: false },
	ledgerTools?: LedgerTools,
): Map<string, (event: unknown, context: unknown) => unknown> {
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: () => {},
		getThinkingLevel: () => undefined,
		sendUserMessage: (
			_content: Parameters<ExtensionActions["sendUserMessage"]>[0],
			options?: Parameters<ExtensionActions["sendUserMessage"]>[1],
		) => {
			const commit = options?.onPreflightAcceptCommit;
			const accepted = options?.onPreflightAccepted;
			// The prompt never settles on its own: the deadline is the only terminal.
			const deliver = () => new Promise<never>(() => {}) as never;
			if (acceptFailure.armed) {
				acceptFailure.armed = false;
				// Reject AFTER the durable accept committed, which is the boundary the
				// bus rolls back through `discardPromptAcceptance`.
				return Promise.resolve(commit?.()).then(() => {
					throw Object.assign(new Error("injected prompt delivery failure"), { code: "delivery_failed" });
				});
			}
			if (commit)
				return Promise.resolve(commit()).then(() => {
					accepted?.();
					return deliver();
				});
			accepted?.();
			return deliver();
		},
	} as unknown as ExtensionAPI;
	createNotificationsExtension(api, {
		settings,
		terminalAbortSeams: {
			getTerminalTurnEpoch: () => undefined,
			cancelPendingPreflightForTerminalAbort: () => {},
			abortPromptAndWaitWithTerminal: (handle, seamOptions) =>
				(
					ctx as {
						abortPromptAndWait: (handle: string, options: { graceMs: number }) => Promise<RunSettlementProof>;
					}
				).abortPromptAndWait(handle, seamOptions),
			// Omitted entirely when the case does not opt in, which is also the
			// older-host fallback: the deadline then uses the event-derived set alone.
			...(ledgerTools
				? {
						pendingToolExecutions: (handle: string) =>
							handle === "bus-deadline-run-handle" ? [...ledgerTools] : [],
					}
				: {}),
		},
	});
	void handlers.get("session_start")?.({ type: "session_start" }, ctx);
	return handlers;
}

interface BusSession {
	handlers: Map<string, (event: unknown, context: unknown) => unknown>;
	sessionContext: Record<string, unknown>;
	frames: Record<string, unknown>[];
	correlation: { commandId: string; turnId: string };
	extraCorrelations: { commandId: string; turnId: string }[];
	extraAcks: { ok?: boolean; error?: { code?: string } }[];
	acceptedAt: number;
	deadlineTerminals: (correlation?: { commandId: string; turnId: string }) => Record<string, unknown>[];
	terminals: (correlation: { commandId: string; turnId: string }) => Record<string, unknown>[];
	socket: WebSocket;
	cwd: string;
	acceptFailure: AcceptFailure;
	/** Deadline callbacks the bus scheduled, captured around acceptance only. */
	scheduled: (() => void)[];
}

/** Send one `turn.prompt` on an established session and return its acknowledgement. */
async function sendPrompt(
	session: BusSession,
	id: string,
): Promise<{
	ok?: boolean;
	error?: { code?: string; message?: string };
	result?: { commandId?: string; turnId?: string };
}> {
	session.socket.send(
		JSON.stringify({ type: "control_request", id, operation: "turn.prompt", input: { text: `deadline ${id}` } }),
	);
	await waitFor(
		() => session.frames.some(frame => frame.type === "control_response" && frame.id === id),
		`prompt acknowledgement ${id}`,
	);
	return session.frames.find(frame => frame.type === "control_response" && frame.id === id) as never;
}

/** Accept one prompt over the real bus transport, optionally binding an agent run. */
async function acceptPrompt(
	label: string,
	leaseMs: number,
	maxRuntimeMs: number,
	options: {
		startAgent?: boolean;
		extraPrompts?: string[];
		captureSchedule?: boolean;
		abortPromptAndWait?: (handle: string, options: { graceMs: number }) => Promise<RunSettlementProof>;
		ledgerTools?: LedgerTools;
	} = {},
): Promise<BusSession> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-sdk-bus-deadline-${label}-`));
	dirs.push(cwd);
	const sessionId = `sdk-bus-deadline-${label}-${Date.now()}`;
	const sessionContext = context(cwd, sessionId, options.abortPromptAndWait);
	const acceptFailure: AcceptFailure = { armed: false };
	const handlers = start(
		sessionContext,
		deadlineSettings(cwd, leaseMs, maxRuntimeMs),
		acceptFailure,
		options.ledgerTools,
	);
	const scheduled: (() => void)[] = [];

	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});

	// Capture the deadline callback the bus schedules for THIS acceptance, and
	// only for the acceptance window, so the spy cannot perturb anything else.
	const scheduleSpy = options.captureSchedule
		? spyOn(globalThis, "setTimeout").mockImplementation(((
				callback: () => void,
				delayMs?: number,
				...rest: unknown[]
			) => {
				// The deadline is armed AFTER the awaited durable accept, so its
				// remaining delay is the lease minus however long that write took.
				// Match the whole upper half of the lease window: with the long lease
				// these cases use, nothing else schedules anywhere near it.
				if (delayMs !== undefined && delayMs > leaseMs / 2 && delayMs <= leaseMs) scheduled.push(callback);
				return realSetTimeout(callback, delayMs, ...rest);
			}) as never)
		: undefined;
	try {
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: `${label}-prompt`,
				operation: "turn.prompt",
				input: { text: `deadline ${label}` },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === `${label}-prompt`),
			"prompt acknowledgement",
		);
		// The deadline is armed after the durable accept, which can settle after the
		// acknowledgement frame: hold the capture window until it is actually armed.
		if (options.captureSchedule) await waitFor(() => scheduled.length > 0, "captured deadline schedule");
	} finally {
		scheduleSpy?.mockRestore();
	}
	const acknowledgement = frames.find(
		frame => frame.type === "control_response" && frame.id === `${label}-prompt`,
	) as { ok?: boolean; result?: { commandId?: string; turnId?: string } };
	expect(acknowledgement.ok).toBe(true);
	const correlation = {
		commandId: String(acknowledgement.result?.commandId),
		turnId: String(acknowledgement.result?.turnId),
	};
	const acceptedAt = Date.now();

	const extraCorrelations: { commandId: string; turnId: string }[] = [];
	const extraAcks: { ok?: boolean; error?: { code?: string } }[] = [];
	for (const extra of options.extraPrompts ?? []) {
		socket.send(
			JSON.stringify({
				type: "control_request",
				id: extra,
				operation: "turn.prompt",
				input: { text: `deadline ${extra}` },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_response" && frame.id === extra),
			`prompt acknowledgement ${extra}`,
		);
		const extraAck = frames.find(frame => frame.type === "control_response" && frame.id === extra) as {
			ok?: boolean;
			result?: { commandId?: string; turnId?: string };
		};
		extraAcks.push(extraAck);
		extraCorrelations.push({
			commandId: String(extraAck.result?.commandId),
			turnId: String(extraAck.result?.turnId),
		});
	}

	if (options.startAgent !== false)
		await handlers.get("agent_start")?.({ type: "agent_start", runId: "bus-deadline-run-handle" }, sessionContext);

	return {
		socket,
		cwd,
		acceptFailure,
		scheduled,
		extraCorrelations,
		extraAcks,
		handlers,
		sessionContext,
		frames,
		correlation,
		acceptedAt,
		deadlineTerminals: (target = correlation) =>
			frames.filter(
				frame =>
					frame.type === "agent_failed" &&
					frame.commandId === target.commandId &&
					frame.turnId === target.turnId &&
					(frame.error as { code?: string } | undefined)?.code === "prompt_deadline_exceeded",
			),
		terminals: target =>
			frames.filter(
				frame =>
					(frame.type === "agent_failed" || frame.type === "agent_end") &&
					frame.commandId === target.commandId &&
					frame.turnId === target.turnId,
			),
	};
}

async function shutdown(session: BusSession): Promise<void> {
	// The harness prompt deliberately never settles, so reconciliation cannot go
	// quiescent and teardown reports a drain timeout. That is harness shape, not a
	// deadline assertion, and it must not mask the assertion under test.
	try {
		await session.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, session.sessionContext);
	} catch (error) {
		if ((error as { code?: string }).code !== "sdk_reconciliation_teardown_failed") throw error;
	}
}

const LEASE_MS = 1_000;

test("attributable tool progress renews the accepted prompt deadline on the bus route", async () => {
	// AC-2: a prompt that is demonstrably alive must not be terminalized at the
	// original acceptance-anchored fixed point.
	const session = await acceptPrompt("renew", LEASE_MS, 60_000);
	try {
		// Fresh attributable progress at ~60% of the lease renews it to ~1.6x.
		await Bun.sleep(600);
		session.handlers.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolCallId: "renew-tool", toolName: "read", isError: false },
			session.sessionContext,
		);

		// Past the ORIGINAL fixed deadline, with margin for timer jitter.
		await waitFor(() => Date.now() - session.acceptedAt > LEASE_MS + 250, "original fixed deadline to pass");
		expect(session.deadlineTerminals()).toHaveLength(0);

		// The renewed deadline still terminalizes exactly once: renewal bounds, it
		// does not disable.
		await waitFor(() => session.deadlineTerminals().length > 0, "renewed deadline terminal");
		expect(Date.now() - session.acceptedAt).toBeGreaterThan(LEASE_MS + 300);
		await Bun.sleep(200);
		expect(session.deadlineTerminals()).toHaveLength(1);
		expect((session.deadlineTerminals()[0]?.error as { message?: string }).message).toBe("Prompt deadline exceeded.");
	} finally {
		await shutdown(session);
	}
}, 30_000);

test("tool_execution_update renews the accepted prompt deadline on the bus route", async () => {
	// #5575: periodic output from a long-running tool is attributable progress, so
	// a `tool_execution_update` at ~60% of the lease renews the terminal deadline
	// past the original acceptance-anchored fixed point.
	const session = await acceptPrompt("update-renew", LEASE_MS, 60_000);
	try {
		await Bun.sleep(600);
		session.handlers.get("tool_execution_update")?.(
			{ type: "tool_execution_update", toolCallId: "update-renew-tool", output: "tick" },
			session.sessionContext,
		);

		// Past the ORIGINAL fixed deadline, with margin for timer jitter.
		await waitFor(() => Date.now() - session.acceptedAt > LEASE_MS + 250, "original fixed deadline to pass");
		expect(session.deadlineTerminals()).toHaveLength(0);

		// The renewed deadline still terminalizes exactly once: renewal bounds, it
		// does not disable.
		await waitFor(() => session.deadlineTerminals().length > 0, "renewed deadline terminal");
		expect(Date.now() - session.acceptedAt).toBeGreaterThan(LEASE_MS + 300);
		await Bun.sleep(200);
		expect(session.deadlineTerminals()).toHaveLength(1);
		expect((session.deadlineTerminals()[0]?.error as { message?: string }).message).toBe("Prompt deadline exceeded.");
	} finally {
		await shutdown(session);
	}
}, 30_000);

test("non-attributable bus events never renew the accepted prompt deadline", async () => {
	// AC-1 + AC-3: streaming text chatter is not progress, so the zero-activity
	// expiry at acceptedAt + leaseMs is preserved. Tool boundaries — including
	// `tool_execution_update` — ARE attributable now, so they are covered by the
	// renewal cases, not here.
	const session = await acceptPrompt("chatter", LEASE_MS, 60_000);
	try {
		await Bun.sleep(600);
		session.handlers.get("message_update")?.(
			{ type: "message_update", messageId: "chatter-message", delta: "still thinking" },
			session.sessionContext,
		);
		session.handlers.get("message_end")?.(
			{ type: "message_end", messageId: "chatter-message", message: { role: "assistant", content: [] } },
			session.sessionContext,
		);

		await waitFor(() => session.deadlineTerminals().length > 0, "zero-progress deadline terminal");
		// Had the chatter renewed, the terminal could not land this early.
		expect(Date.now() - session.acceptedAt).toBeLessThan(600 + LEASE_MS);
		expect(session.deadlineTerminals()).toHaveLength(1);
	} finally {
		await shutdown(session);
	}
}, 30_000);

test("turn.prompt specifically refuses a second submission while one is in flight", async () => {
	// Narrow fact about `turn.prompt` only: it sets rejectWhenBusy. This does NOT
	// generalise to the route — `turn.follow_up` and `skill.invoke` use different
	// admission paths and DO co-accept. The attribution invariant itself is proven
	// separately by the co-accepted follow-up case below.
	const session = await acceptPrompt("attribution", LEASE_MS, 60_000, {
		startAgent: false,
		extraPrompts: ["queued"],
	});
	try {
		expect(session.extraAcks[0]?.ok).toBe(false);
		expect(session.extraAcks[0]?.error?.code).toBe("busy");
	} finally {
		await shutdown(session);
	}
}, 30_000);

test("sustained attributable progress still terminalizes at the maximum runtime", async () => {
	// AC-4: renewal is bounded by sdk.promptMaxRuntimeMs, anchored to the
	// original acceptance — never re-anchored by progress.
	const maxRuntimeMs = 1_800;
	const session = await acceptPrompt("cap", 700, maxRuntimeMs);
	const progress = setInterval(() => {
		// Each call is started AND completed: an unmatched start means the tool is
		// still executing, which the deadline now waits a bounded grace for (#5637).
		// Both events are equally attributable, so the renewal under test is
		// unchanged — this only stops the fixture from claiming a growing pile of
		// tools is permanently mid-execution.
		const toolCallId = `cap-tool-${Date.now()}`;
		session.handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolCallId, toolName: "read", args: {} },
			session.sessionContext,
		);
		session.handlers.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolCallId, toolName: "read", isError: false },
			session.sessionContext,
		);
	}, 250);
	try {
		await waitFor(() => session.deadlineTerminals().length > 0, "maximum runtime terminal");
		const elapsed = Date.now() - session.acceptedAt;
		// Progress kept the lease alive well past its 700 ms inactivity window ...
		expect(elapsed).toBeGreaterThan(1_200);
		// ... but the acceptance-anchored hard cap still closed it.
		expect(elapsed).toBeLessThan(maxRuntimeMs + 900);
		expect(session.deadlineTerminals()).toHaveLength(1);
	} finally {
		clearInterval(progress);
		await shutdown(session);
	}
}, 30_000);

test("a stale deadline callback cannot terminalize after its submission was cleared", async () => {
	// AC-7 identity fencing: the scheduled work captured at acceptance is replayed
	// AFTER its submission has been cleared by a real terminalization, while a
	// live successor prompt owns the session. The stale callback must be inert and
	// must not touch the successor's authoritative state.
	const session = await acceptPrompt("stale", 60_000, 600_000, { captureSchedule: true });
	try {
		expect(session.scheduled).toHaveLength(1);

		// Terminalize the first prompt for real; this clears its submission.
		await session.handlers.get("agent_end")?.(
			{ type: "agent_end", stopReason: "completed", messages: [] },
			session.sessionContext,
		);
		await waitFor(() => session.terminals(session.correlation).length > 0, "first prompt terminal");
		expect(session.terminals(session.correlation)).toHaveLength(1);

		// A live successor owns the session now.
		const successorAck = await sendPrompt(session, "successor");
		expect(successorAck.ok).toBe(true);
		const successor = {
			commandId: String(successorAck.result?.commandId),
			turnId: String(successorAck.result?.turnId),
		};
		await session.handlers.get("agent_start")?.(
			{ type: "agent_start", runId: "bus-deadline-run-handle" },
			session.sessionContext,
		);

		// Replay the stale scheduled work from the cleared submission.
		session.scheduled[0]?.();
		await Bun.sleep(150);

		// No resurrection of the settled prompt, and the successor is untouched.
		expect(session.terminals(session.correlation)).toHaveLength(1);
		expect(session.terminals(successor)).toHaveLength(0);
		expect(session.deadlineTerminals(successor)).toHaveLength(0);

		// Positive control: the successor still terminalizes normally afterwards.
		await session.handlers.get("agent_end")?.(
			{ type: "agent_end", stopReason: "completed", messages: [] },
			session.sessionContext,
		);
		await waitFor(() => session.terminals(successor).length > 0, "successor terminal");
		expect(session.terminals(successor)).toHaveLength(1);
	} finally {
		await shutdown(session);
	}
}, 30_000);

test("a rolled-back durable acceptance leaves no armed deadline", async () => {
	// AC-8: drive the bus's real accept-rollback boundary, then prove both the
	// observable rejection and that no deadline survives it. The positive control
	// on the same live socket proves the channel would have shown a terminal.
	const leaseMs = 500;
	const session = await acceptPrompt("rollback", leaseMs, 60_000, { startAgent: false });
	try {
		// Settle the first prompt so the route is idle enough to admit another.
		await session.handlers.get("agent_start")?.(
			{ type: "agent_start", runId: "bus-deadline-run-handle" },
			session.sessionContext,
		);
		await session.handlers.get("agent_end")?.(
			{ type: "agent_end", stopReason: "completed", messages: [] },
			session.sessionContext,
		);
		await waitFor(() => session.terminals(session.correlation).length > 0, "priming terminal");

		// Fail the durable acceptance write itself. That is the real boundary:
		// `recordPromptAccepted` throws, the control preflight is rejected, and the
		// bus rolls the process-local registration back via `discardPromptAcceptance`.
		const realRename = fsPromises.rename.bind(fsPromises);
		let failRenames = true;
		const renameSpy = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
			if (failRenames && String(to).startsWith(session.cwd))
				throw Object.assign(new Error("injected durable acceptance failure"), { code: "EACCES" });
			await realRename(from, to);
		});
		let rejected: Awaited<ReturnType<typeof sendPrompt>>;
		try {
			rejected = await sendPrompt(session, "rolled-back");
		} finally {
			failRenames = false;
			renameSpy.mockRestore();
		}
		expect(rejected.ok).toBe(false);
		const rolledBack = rejected.result?.commandId
			? { commandId: String(rejected.result.commandId), turnId: String(rejected.result.turnId) }
			: undefined;

		// Well past the lease: a surviving armed deadline would have fired by now.
		await Bun.sleep(leaseMs * 3);
		if (rolledBack) expect(session.terminals(rolledBack)).toHaveLength(0);
		const deadlineFrames = session.frames.filter(
			frame =>
				frame.type === "agent_failed" &&
				(frame.error as { code?: string } | undefined)?.code === "prompt_deadline_exceeded",
		);
		expect(deadlineFrames).toHaveLength(0);

		// Positive control on the same socket: a healthy prompt still gets its
		// deadline terminal, so the absence above is real, not a dead channel.
		const healthy = await sendPrompt(session, "healthy");
		expect(healthy.ok).toBe(true);
		const healthyCorrelation = {
			commandId: String(healthy.result?.commandId),
			turnId: String(healthy.result?.turnId),
		};
		await session.handlers.get("agent_start")?.(
			{ type: "agent_start", runId: "bus-deadline-run-handle" },
			session.sessionContext,
		);
		await waitFor(
			() => session.deadlineTerminals(healthyCorrelation).length > 0,
			"positive-control deadline terminal",
		);
		expect(session.deadlineTerminals(healthyCorrelation)).toHaveLength(1);
	} finally {
		await shutdown(session);
	}
}, 30_000);

test("client cancellation releases the deadline instead of publishing a second terminal", async () => {
	// AC-10: `turn.abort` is a real bus-wired cleanup path that clears the armed
	// deadline. After a cancel, no deadline terminal may appear past the lease.
	const leaseMs = 500;
	const session = await acceptPrompt("cancel", leaseMs, 60_000);
	try {
		const abortId = "cancel-abort";
		session.socket.send(
			JSON.stringify({
				type: "control_request",
				id: abortId,
				operation: "turn.abort",
				input: {},
				idempotencyKey: "cancel-abort-key",
			}),
		);
		await waitFor(
			() => session.frames.some(frame => frame.type === "control_response" && frame.id === abortId),
			"abort acknowledgement",
		);
		await waitFor(() => session.terminals(session.correlation).length > 0, "cancellation terminal");
		expect(session.terminals(session.correlation)).toHaveLength(1);

		// Past the original lease the released deadline must stay silent.
		await Bun.sleep(leaseMs * 3);
		expect(session.terminals(session.correlation)).toHaveLength(1);
		expect(session.deadlineTerminals()).toHaveLength(0);
	} finally {
		await shutdown(session);
	}
}, 30_000);

test("a prompt accepted with no agent_start keeps its pre-change public outcome", async () => {
	// AC-9 is a behaviour-PRESERVATION contract, not a new capability: with no
	// bound run there is no execution handle to fence, so the deadline path fails
	// closed. This asserts the exact public outcome, and the same assertion is run
	// against the unmodified base source to prove it is unchanged.
	const leaseMs = 500;
	const session = await acceptPrompt("unbound", leaseMs, 60_000, { startAgent: false });
	try {
		await waitFor(() => session.terminals(session.correlation).length > 0, "unbound prompt terminal");
		const terminal = session.terminals(session.correlation)[0]!;
		expect(terminal.type).toBe("agent_failed");
		expect((terminal.error as { code?: string }).code).toBe("terminal_uncertain");
		expect(session.deadlineTerminals()).toHaveLength(0);
		await Bun.sleep(200);
		expect(session.terminals(session.correlation)).toHaveLength(1);
	} finally {
		await shutdown(session);
	}
}, 30_000);

test("current-run tool progress cannot renew a co-accepted follow-up correlation", async () => {
	// Attribution invariant, on the real bus. Unlike `turn.prompt` (which sets
	// rejectWhenBusy), `turn.follow_up` is admitted while a run is active, so a
	// SECOND accepted correlation genuinely co-exists with the running one.
	// Renewal resolves its submission by the active correlation's own key, so the
	// running prompt's tool progress must not extend the follow-up's lease.
	const leaseMs = 900;
	const session = await acceptPrompt("followup", leaseMs, 60_000);
	const progress = setInterval(() => {
		session.handlers.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolCallId: `fu-tool-${Date.now()}`, toolName: "read", isError: false },
			session.sessionContext,
		);
	}, 200);
	try {
		const followUpId = "co-accepted-follow-up";
		session.socket.send(
			JSON.stringify({
				type: "control_request",
				id: followUpId,
				operation: "turn.follow_up",
				input: { text: "co-accepted follow up" },
			}),
		);
		await waitFor(
			() => session.frames.some(frame => frame.type === "control_response" && frame.id === followUpId),
			"follow-up acknowledgement",
		);
		const ack = session.frames.find(frame => frame.type === "control_response" && frame.id === followUpId) as {
			ok?: boolean;
			result?: { commandId?: string; turnId?: string };
		};
		expect(ack.ok).toBe(true);
		const followUp = { commandId: String(ack.result?.commandId), turnId: String(ack.result?.turnId) };
		expect(followUp.commandId).not.toBe(session.correlation.commandId);
		const followUpAcceptedAt = Date.now();

		// The follow-up is bounded by ITS OWN acceptance despite continuous
		// attributable progress attributed to the running correlation.
		await waitFor(() => session.terminals(followUp).length > 0, "co-accepted follow-up terminal");
		expect(Date.now() - followUpAcceptedAt).toBeLessThan(leaseMs * 2);
		// The running prompt is the one being renewed, so it has no deadline terminal.
		expect(session.deadlineTerminals()).toHaveLength(0);
	} finally {
		clearInterval(progress);
		await shutdown(session);
	}
}, 30_000);
test("a deadline expiry attempt in flight is superseded by real progress during the durable claim", async () => {
	// HIGH: the firing timer registers its attempt, then awaits the durable
	// claim. Real tool progress arriving while that claim is blocked must
	// supersede the attempt: no fencing, no deadline terminal, and the lease
	// reschedules. The rename gate makes "during the claim" deterministic —
	// no timing race between progress and claim resolution.
	const leaseMs = 400;
	const session = await acceptPrompt("supersede", leaseMs, 60_000);
	const realRename = fsPromises.rename.bind(fsPromises);
	const releaseClaim = Promise.withResolvers<void>();
	let claimGated = false;
	const renameSpy = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
		if (!claimGated && String(to).startsWith(session.cwd)) {
			claimGated = true;
			await releaseClaim.promise;
		}
		return await realRename(from, to);
	});
	try {
		// The deadline (armed at acceptance) fires into the gated claim.
		await waitFor(() => renameSpy.mock.calls.length > 0, "deadline claim to reach durable write");
		expect(session.deadlineTerminals()).toHaveLength(0);
		// Real attributable progress while the claim is blocked.
		session.handlers.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolCallId: "supersede-tool", toolName: "read", isError: false },
			session.sessionContext,
		);
		await Bun.sleep(50);
		releaseClaim.resolve();
		// The superseded attempt must stay silent: no fencing, no terminal.
		await Bun.sleep(300);
		expect(session.terminals(session.correlation)).toHaveLength(0);
		expect(session.deadlineTerminals()).toHaveLength(0);
		// The lease rescheduled from the progress: the renewed deadline still
		// terminalizes exactly once, proving backoff rather than a dropped timer.
		await waitFor(() => session.deadlineTerminals().length > 0, "rescheduled deadline terminal");
		expect(session.deadlineTerminals()).toHaveLength(1);
		expect((session.deadlineTerminals()[0]?.error as { message?: string }).message).toBe("Prompt deadline exceeded.");
	} finally {
		releaseClaim.resolve();
		renameSpy.mockRestore();
		await shutdown(session);
	}
}, 30_000);

test("progress during fencing is attributed to the deadline's own abort and never supersedes", async () => {
	// HIGH: after the durable claim, terminal fencing still awaits the run's
	// settlement proof. Progress in THAT window arrives after the attempt has
	// already aborted the run, so it is the abort's own teardown, not evidence
	// of a live prompt: it must be discounted and the terminal published. The
	// pre-abort window is the one that still backs off on real progress — see
	// the durable-claim supersession case above.
	const fenceStarted = Promise.withResolvers<void>();
	const releaseFence = Promise.withResolvers<void>();
	// The abort count is the discriminator: both behaviours eventually publish
	// exactly one terminal, but a superseding attempt gets there only by backing
	// off, re-arming and aborting the run a SECOND time.
	let aborts = 0;
	const session = await acceptPrompt("fence-supersede", 400, 60_000, {
		abortPromptAndWait: async () => {
			aborts += 1;
			if (aborts > 1) return { status: "settled", terminalScope: {} };
			fenceStarted.resolve();
			await releaseFence.promise;
			return { status: "settled", terminalScope: {} };
		},
	});
	try {
		await fenceStarted.promise;
		expect(session.terminals(session.correlation)).toHaveLength(0);
		session.handlers.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolCallId: "fence-tool", toolName: "read", isError: false },
			session.sessionContext,
		);
		await Bun.sleep(50);
		releaseFence.resolve();
		await waitFor(() => session.deadlineTerminals().length > 0, "post-fencing deadline terminal");
		expect(session.deadlineTerminals()).toHaveLength(1);
		// One abort: the post-fence progress was discounted, not treated as
		// evidence of a live prompt.
		expect(aborts).toBe(1);
		await Bun.sleep(200);
		expect(session.terminals(session.correlation)).toHaveLength(1);
	} finally {
		releaseFence.resolve();
		await shutdown(session);
	}
}, 30_000);

test("pairing-only synthetic tool progress never renews the bus deadline", async () => {
	// MEDIUM: a start/end pair the loop never dispatched proves pairing, not
	// progress. Marked exactly like agent-loop's synthetic pairs, it must leave
	// the acceptance-anchored deadline unchanged — the prompt still expires.
	const session = await acceptPrompt("pairing", LEASE_MS, 60_000);
	try {
		await Bun.sleep(600);
		const start = { type: "tool_execution_start", toolCallId: "pairing-tool", toolName: "read", args: {} };
		const end = {
			type: "tool_execution_end",
			toolCallId: "pairing-tool",
			toolName: "read",
			result: { content: "synthetic" },
			isError: false,
		};
		markNonDispatchedToolEvent(start);
		markNonDispatchedToolEvent(end);
		session.handlers.get("tool_execution_start")?.(start, session.sessionContext);
		session.handlers.get("tool_execution_end")?.(end, session.sessionContext);
		await waitFor(() => session.deadlineTerminals().length > 0, "unrenewed deadline terminal");
		// Had the pairing-only events renewed, the terminal could not land this early.
		expect(Date.now() - session.acceptedAt).toBeLessThan(600 + LEASE_MS);
		expect(session.deadlineTerminals()).toHaveLength(1);
	} finally {
		await shutdown(session);
	}
}, 30_000);

/** Poll for a condition on a bounded budget WITHOUT throwing, so the caller asserts. */
async function settleWithin(predicate: () => boolean, budgetMs: number): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
}

/** Read the session's durable reconciliation records straight off disk. */
function reconciliationRecords(cwd: string): Record<string, unknown>[] {
	const found: Record<string, unknown>[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (path.basename(dir) !== ".sdk-reconciliation" || !entry.name.endsWith(".json")) continue;
			const document = JSON.parse(fs.readFileSync(full, "utf8")) as { records?: Record<string, unknown>[] };
			found.push(...(document.records ?? []));
		}
	};
	walk(cwd);
	return found;
}

test("a deadline that aborts a genuinely dispatched tool still publishes its terminal frame", async () => {
	// AC-1/AC-2, and the live `--mode acp` hang this PR is about. The expiry
	// attempt fences the run through `abortPromptAndWaitWithTerminal`; that abort
	// tears down the tool that was actually running, and agent-loop emits its
	// `tool_execution_end` WITHOUT the non-dispatched marker, because the tool
	// really started (`const dispatched = record.started`, agent-loop.ts:5173).
	// So the abort's own teardown reaches `renewPromptDeadline` as ordinary
	// attributable progress and bumps the lease generation of the very lease the
	// attempt is expiring. Before the fix the post-fence check then read
	// "superseded", the attempt backed off, re-armed, and the re-armed attempt
	// walked into the identical trap — the durable record stayed frozen on its
	// pending claim and the client's `session/prompt` never saw a terminal frame.
	// Comfortably longer than acceptance so the expiry cannot fire before the
	// harness has wired the abort-time emitter below.
	const leaseMs = 1_500;
	let aborts = 0;
	let abortProgress = 0;
	let live: BusSession | undefined;
	const session = await acceptPrompt("self-abort", leaseMs, 60_000, {
		abortPromptAndWait: async () => {
			aborts += 1;
			// The aborted turn pairs off its still-pending tool here. Deliberately
			// NOT marked non-dispatched: that marker is reserved for calls the loop
			// never dispatched, and this one ran.
			if (live) {
				abortProgress += 1;
				live.handlers.get("tool_execution_end")?.(
					{ type: "tool_execution_end", toolCallId: "self-abort-tool", toolName: "bash", isError: false },
					live.sessionContext,
				);
			}
			return { status: "settled", terminalScope: {} };
		},
	});
	live = session;
	try {
		// Generous relative to the 1.5 s lease, but bounded: a self-superseding
		// attempt never converges, so this must fail as a missing frame rather
		// than as a suite timeout.
		await settleWithin(() => session.deadlineTerminals().length > 0, 8_000);
		// The premise of the case: the abort really did emit the aborted tool's
		// attributable end event. Without this the assertions below are vacuous.
		expect(abortProgress).toBeGreaterThan(0);
		// AC-1: the terminal frame reached the wire, carrying the deadline code.
		expect(session.deadlineTerminals()).toHaveLength(1);
		expect((session.deadlineTerminals()[0]?.error as { message?: string }).message).toBe("Prompt deadline exceeded.");
		// The first attempt settled it: no back-off/re-arm churn.
		expect(aborts).toBe(1);

		// AC-2: the durable record is finalized, not frozen mid-claim. The e2e
		// fingerprint of the bug was exactly `status:"in_flight"` +
		// `pendingReceiptState:"missing"` with the pending claim still set.
		const record = reconciliationRecords(session.cwd).find(
			entry =>
				entry.kind === "prompt" &&
				entry.commandId === session.correlation.commandId &&
				entry.turnId === session.correlation.turnId,
		);
		expect(record).toBeDefined();
		expect(record?.status).toBe("failed");
		expect(typeof record?.terminalAt).toBe("number");
		expect(record?.pendingOutcome).toBeUndefined();
		expect(record?.pendingReceiptState).toBeUndefined();
		expect((record?.error as { code?: string } | undefined)?.code).toBe("prompt_deadline_exceeded");
	} finally {
		await shutdown(session);
	}
}, 30_000);

test("the deadline abort lands after the running tool call reaches its boundary", async () => {
	// #5637 AC-1: terminal fencing aborts the run BEFORE it waits for settlement,
	// so a tool aborted mid-write leaves a torn artifact behind. Expiry must now
	// wait for the dispatched call's own `tool_execution_end` first.
	//
	// Driven as a MAXIMUM-RUNTIME expiry: the boundary event is attributable
	// progress, so under an inactivity lease it would renew the prompt and the
	// abort would (correctly) never happen. The acceptance-anchored hard cap
	// cannot be renewed past, so the abort still deterministically lands — just
	// at the boundary instead of through the tool.
	const maxRuntimeMs = 800;
	const order: string[] = [];
	const session = await acceptPrompt("boundary-order", 60_000, maxRuntimeMs, {
		abortPromptAndWait: async () => {
			order.push("abort");
			return { status: "settled", terminalScope: {} };
		},
	});
	try {
		// A dispatched call that will SUCCEED slowly: a failing tool routes through
		// the error path and would make the ordering assertion vacuous.
		session.handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolCallId: "boundary-tool", toolName: "read", args: {} },
			session.sessionContext,
		);

		// Proving a NEGATIVE inside a window, which a poll cannot express: well past
		// the hard cap the abort must NOT have fired, because the tool is still
		// running. Without the boundary wait it would have fired at ~800 ms.
		await Bun.sleep(2_500);
		expect(order).toEqual([]);
		expect(session.deadlineTerminals()).toHaveLength(0);

		// The tool reaches its boundary, comfortably inside the grace.
		order.push("tool_execution_end");
		session.handlers.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolCallId: "boundary-tool", toolName: "read", isError: false },
			session.sessionContext,
		);

		await waitFor(() => order.includes("abort"), "deadline abort after the tool boundary");
		expect(order).toEqual(["tool_execution_end", "abort"]);
		// Classification is untouched: still the same terminal deadline failure.
		await waitFor(() => session.deadlineTerminals().length > 0, "boundary deadline terminal");
		expect(session.deadlineTerminals()).toHaveLength(1);
		expect((session.deadlineTerminals()[0]?.error as { code?: string }).code).toBe("prompt_deadline_exceeded");
		expect((session.deadlineTerminals()[0]?.error as { message?: string }).message).toBe("Prompt deadline exceeded.");
	} finally {
		await shutdown(session);
	}
}, 30_000);

test("a tool still executing when the boundary grace expires is force-terminated and recorded", async () => {
	// #5637 AC-2: the wait is bounded. A tool that never reaches its boundary must
	// still be force-terminated exactly as before — and the fact that the run was
	// killed WHILE a tool was executing must survive in a structured form rather
	// than being indistinguishable from a clean expiry.
	const maxRuntimeMs = 800;
	const diagnostics: Array<Record<string, unknown>> = [];
	const forcedWarnings: Array<Record<string, unknown>> = [];
	const errorSpy = spyOn(logger, "error").mockImplementation(((event: unknown, fields?: unknown) => {
		if (event === "sdk_prompt_terminal_failed") diagnostics.push((fields ?? {}) as Record<string, unknown>);
	}) as never);
	const realWarn = logger.warn.bind(logger);
	const warnSpy = spyOn(logger, "warn").mockImplementation(((event: unknown, fields?: unknown) => {
		if (event === "sdk_prompt_deadline_forced_mid_tool") {
			forcedWarnings.push((fields ?? {}) as Record<string, unknown>);
			return;
		}
		return realWarn(event as never, fields as never);
	}) as never);
	const session = await acceptPrompt("boundary-forced", 60_000, maxRuntimeMs);
	try {
		session.handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolCallId: "stuck-tool", toolName: "bash", args: {} },
			session.sessionContext,
		);

		await waitFor(() => session.deadlineTerminals().length > 0, "forced deadline terminal", 25_000);
		// Bounded, not disabled — pinned in BOTH directions.
		//
		// The lower bound is a discriminating FRACTION of the grace, not a tight
		// epsilon around it: `acceptedAt` is stamped after the acknowledgement frame
		// round-trips, while the deadline is armed from the earlier SERVER-side
		// durable accept, so this measures `real_elapsed - skew`. Under full-suite
		// load that skew reaches hundreds of ms, and a tight epsilon then measures
		// harness scheduling rather than the deadline. Without the boundary wait this
		// terminal fires at ~maxRuntimeMs (800 ms), so half a grace still fails
		// loudly on any regression that removes the wait.
		const elapsed = Date.now() - session.acceptedAt;
		expect(elapsed).toBeGreaterThan(maxRuntimeMs + TOOL_CALL_BOUNDARY_GRACE_MS / 2);
		expect(elapsed).toBeLessThan(maxRuntimeMs + 2 * TOOL_CALL_BOUNDARY_GRACE_MS);
		expect(session.deadlineTerminals()).toHaveLength(1);
		// Classification is byte-identical to a clean expiry — downstream retry
		// classifiers branch on these and must not move.
		expect((session.deadlineTerminals()[0]?.error as { code?: string }).code).toBe("prompt_deadline_exceeded");
		expect((session.deadlineTerminals()[0]?.error as { message?: string }).message).toBe("Prompt deadline exceeded.");

		// The structured record of the forced mid-tool kill: ids only.
		expect(forcedWarnings).toHaveLength(1);
		expect(forcedWarnings[0]?.pendingToolCallIds).toEqual(["stuck-tool"]);
		expect(forcedWarnings[0]?.graceMs).toBe(TOOL_CALL_BOUNDARY_GRACE_MS);
		expect(forcedWarnings[0]?.commandId).toBe(session.correlation.commandId);
		expect(forcedWarnings[0]?.turnId).toBe(session.correlation.turnId);
		// ... and the distinct terminal diagnostic reason.
		const reason = String(diagnostics.at(-1)?.reason ?? "");
		expect(reason).toContain("Prompt deadline exceeded.");
		expect(reason).toContain("still executing");
	} finally {
		warnSpy.mockRestore();
		errorSpy.mockRestore();
		await shutdown(session);
	}
}, 40_000);

test("a tool that ends before expiry leaves the deadline path unchanged", async () => {
	// Control: with nothing executing at expiry the boundary wait must not exist —
	// no grace, no extra delay, and the original diagnostic reason verbatim. This
	// passes both with and without the boundary wait, which is what makes the two
	// cases above pin the behavioural delta rather than the new code's existence.
	const maxRuntimeMs = 800;
	const diagnostics: Array<Record<string, unknown>> = [];
	const errorSpy = spyOn(logger, "error").mockImplementation(((event: unknown, fields?: unknown) => {
		if (event === "sdk_prompt_terminal_failed") diagnostics.push((fields ?? {}) as Record<string, unknown>);
	}) as never);
	const session = await acceptPrompt("boundary-idle", 60_000, maxRuntimeMs);
	try {
		session.handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolCallId: "quick-tool", toolName: "read", args: {} },
			session.sessionContext,
		);
		session.handlers.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolCallId: "quick-tool", toolName: "read", isError: false },
			session.sessionContext,
		);

		await waitFor(() => session.deadlineTerminals().length > 0, "idle-path deadline terminal");
		expect(Date.now() - session.acceptedAt).toBeLessThan(maxRuntimeMs + 900);
		expect(session.deadlineTerminals()).toHaveLength(1);
		expect((session.deadlineTerminals()[0]?.error as { code?: string }).code).toBe("prompt_deadline_exceeded");
		expect(String(diagnostics.at(-1)?.reason ?? "")).toBe("Prompt deadline exceeded.");
	} finally {
		errorSpy.mockRestore();
		await shutdown(session);
	}
}, 30_000);

/**
 * Capture `sdk_prompt_deadline_forced_mid_tool` without swallowing other warnings.
 * Returns the collected records and a restore handle.
 */
function captureForcedWarnings(): { records: Array<Record<string, unknown>>; restore: () => void } {
	const records: Array<Record<string, unknown>> = [];
	const realWarn = logger.warn.bind(logger);
	const spy = spyOn(logger, "warn").mockImplementation(((event: unknown, fields?: unknown) => {
		if (event === "sdk_prompt_deadline_forced_mid_tool") {
			records.push((fields ?? {}) as Record<string, unknown>);
			return;
		}
		return realWarn(event as never, fields as never);
	}) as never);
	return { records, restore: () => spy.mockRestore() };
}

test("a tool the ledger reports running is not killed while its start event is stuck behind a slow extension", async () => {
	// #5637 review thread P1: `runningToolCallIds` is populated from
	// `tool_execution_start` travelling the ASYNCHRONOUS extension fanout, while
	// the tool is ALREADY executing — AgentLoop publishes the event without
	// awaiting it and invokes `execute` on the next line. A user extension
	// registered ahead of the bus extension can therefore hold that event for as
	// long as it likes, leaving the event-derived set EMPTY mid-`apply_patch`.
	//
	// Driven as a MAXIMUM-RUNTIME expiry so the boundary events, which are
	// attributable progress, cannot renew the prompt out from under the case.
	const maxRuntimeMs = 800;
	const order: string[] = [];
	// The REAL execution boundary: taken synchronously before `execute`, released
	// at the call's real end.
	const ledgerTools: LedgerTools = new Set();
	const forced = captureForcedWarnings();
	const session = await acceptPrompt("ledger-authority", 60_000, maxRuntimeMs, {
		ledgerTools,
		abortPromptAndWait: async () => {
			order.push("abort");
			return { status: "settled", terminalScope: {} };
		},
	});
	// The slow PRECEDING extension: every tool event queues here instead of
	// reaching the bus, and drains only when the extension lets go.
	const stalledFanout: Array<() => void> = [];
	const publishThroughSlowExtension = (type: string, event: Record<string, unknown>) => {
		stalledFanout.push(() => void session.handlers.get(type)?.(event, session.sessionContext));
	};
	try {
		// AgentLoop reserves the lease, then calls the file-mutating tool. The bus
		// has observed NOTHING at this point — that is the whole bug.
		ledgerTools.add("mutating-tool");
		publishThroughSlowExtension("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "mutating-tool",
			toolName: "apply_patch",
			args: {},
		});

		// Proving a NEGATIVE inside a window, which a poll cannot express: well past
		// the hard cap the abort must NOT have fired, because a tool really is
		// running. Before this fix the event-derived set was empty here, the idle
		// branch was taken, and the abort landed mid-write at ~800 ms.
		await Bun.sleep(2_500);
		expect(order).toEqual([]);
		expect(session.deadlineTerminals()).toHaveLength(0);

		// The tool finishes for real: the ledger releases first, the held events
		// drain afterwards, exactly as the real ordering would have it.
		order.push("tool_execution_end");
		ledgerTools.delete("mutating-tool");
		publishThroughSlowExtension("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "mutating-tool",
			toolName: "apply_patch",
			isError: false,
		});
		for (const deliver of stalledFanout.splice(0)) deliver();

		await waitFor(() => order.includes("abort"), "deadline abort after the real tool boundary");
		expect(order).toEqual(["tool_execution_end", "abort"]);
		// It settled at the boundary; nothing was force-killed mid-tool.
		expect(forced.records).toEqual([]);
		await waitFor(() => session.deadlineTerminals().length > 0, "ledger-authority deadline terminal");
		await Bun.sleep(200);
		expect(session.deadlineTerminals()).toHaveLength(1);
		expect((session.deadlineTerminals()[0]?.error as { code?: string }).code).toBe("prompt_deadline_exceeded");
	} finally {
		forced.restore();
		await shutdown(session);
	}
}, 30_000);

test("a tool_execution_end delivered before its own start never forces a spurious mid-tool kill", async () => {
	// #5637 review thread P1, mirror case. The fanout is unordered across
	// listeners, so a finished call's end can reach the bus before its start. The
	// late start used to add an id that could never be removed again: the deadline
	// then burned the whole 5 s grace and reported a forced mid-tool kill for a
	// tool that had already returned. The ledger — empty throughout here, because
	// the call really is over — is the authority.
	const maxRuntimeMs = 800;
	const diagnostics: Array<Record<string, unknown>> = [];
	const errorSpy = spyOn(logger, "error").mockImplementation(((event: unknown, fields?: unknown) => {
		if (event === "sdk_prompt_terminal_failed") diagnostics.push((fields ?? {}) as Record<string, unknown>);
	}) as never);
	const ledgerTools: LedgerTools = new Set();
	const forced = captureForcedWarnings();
	const session = await acceptPrompt("end-before-start", 60_000, maxRuntimeMs, { ledgerTools });
	try {
		session.handlers.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolCallId: "raced-tool", toolName: "read", isError: false },
			session.sessionContext,
		);
		session.handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolCallId: "raced-tool", toolName: "read", args: {} },
			session.sessionContext,
		);

		await waitFor(() => session.deadlineTerminals().length > 0, "unraced deadline terminal", 25_000);
		// The discriminator: the cap WITHOUT the grace. A stale id would have held
		// the terminal back by the full TOOL_CALL_BOUNDARY_GRACE_MS.
		expect(Date.now() - session.acceptedAt).toBeLessThan(maxRuntimeMs + TOOL_CALL_BOUNDARY_GRACE_MS - 500);
		expect(session.deadlineTerminals()).toHaveLength(1);
		expect(forced.records).toEqual([]);
		// Classification and diagnostic stay the clean-expiry ones.
		expect((session.deadlineTerminals()[0]?.error as { code?: string }).code).toBe("prompt_deadline_exceeded");
		expect(String(diagnostics.at(-1)?.reason ?? "")).toBe("Prompt deadline exceeded.");
	} finally {
		forced.restore();
		errorSpy.mockRestore();
		await shutdown(session);
	}
}, 40_000);

test("an empty ledger reading ends the wait even when a stale start event is still unmatched", async () => {
	// #5637 review thread P2. The reverse direction of the ledger-authority case
	// above, and the reason the pending set is a REPLACE rather than a union: the
	// same asynchrony that delays a `tool_execution_start` also delays its END.
	// The reachable ordering is start delivered -> real tool finishes and releases
	// its lease -> end lost or stuck behind another extension. The ledger is then
	// empty while `runningToolCallIds` still holds the id, and a union would burn
	// the whole 5 s grace and record a forced mid-tool kill for a call that had
	// already returned.
	const maxRuntimeMs = 800;
	const diagnostics: Array<Record<string, unknown>> = [];
	const errorSpy = spyOn(logger, "error").mockImplementation(((event: unknown, fields?: unknown) => {
		if (event === "sdk_prompt_terminal_failed") diagnostics.push((fields ?? {}) as Record<string, unknown>);
	}) as never);
	const ledgerTools: LedgerTools = new Set();
	const forced = captureForcedWarnings();
	const session = await acceptPrompt("ledger-released", 60_000, maxRuntimeMs, { ledgerTools });
	try {
		// AgentLoop takes the lease and publishes the start, which DOES reach the
		// bus this time: the event-derived set now holds the id.
		ledgerTools.add("released-tool");
		session.handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolCallId: "released-tool", toolName: "apply_patch", args: {} },
			session.sessionContext,
		);

		// The tool finishes for real and its lease is released. Its
		// `tool_execution_end` never arrives — lost, or parked indefinitely behind
		// another extension — so the id is stranded in `runningToolCallIds`.
		ledgerTools.delete("released-tool");

		await waitFor(() => session.deadlineTerminals().length > 0, "released-ledger deadline terminal", 25_000);
		expect(session.deadlineTerminals()).toHaveLength(1);
		// PRIMARY signal, and one that cannot flake: this is the ORDINARY deadline
		// terminal, not the forced-mid-tool one. The forced path names the grace
		// and the pending count in its diagnostic reason.
		const reason = String(diagnostics.at(-1)?.reason ?? "");
		expect(reason).toBe("Prompt deadline exceeded.");
		expect(reason).not.toContain("Forced after");
		expect(forced.records).toEqual([]);
		expect((session.deadlineTerminals()[0]?.error as { code?: string }).code).toBe("prompt_deadline_exceeded");
		// SECONDARY bound: the terminal lands at the cap, not at cap + grace. Split
		// halfway so a loaded runner has ~2.5 s of slack on either side of the
		// discriminator.
		expect(Date.now() - session.acceptedAt).toBeLessThan(maxRuntimeMs + TOOL_CALL_BOUNDARY_GRACE_MS / 2);
	} finally {
		forced.restore();
		errorSpy.mockRestore();
		await shutdown(session);
	}
}, 40_000);

test("repeated tool_execution_updates at an already-due hard cap open exactly one boundary wait", async () => {
	// #5637 review thread P2. `tool_execution_update` is attributable progress by
	// design (a multi-minute compile must not trip the inactivity lease), and at an
	// already-due HARD CAP `promptDeadlineAt` is pinned to `acceptedAt + maxMs`, so
	// every update re-arms a ZERO-delay timer that walks straight past the re-arm
	// check. Without a per-submission fence each one opened ANOTHER grace wait and
	// they piled up concurrently through the whole 5 s grace.
	const maxRuntimeMs = 600;
	const ledgerTools: LedgerTools = new Set(["compiling-tool"]);
	const forced = captureForcedWarnings();
	const session = await acceptPrompt("one-wait", 60_000, maxRuntimeMs, { ledgerTools });
	// One boundary wait arms exactly one timer at the grace, and the wait is
	// otherwise unobservable from outside the bus. Scoped to the update storm so
	// the spy cannot see session teardown's unrelated timers.
	let boundaryWaits = 0;
	const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delayMs?: number,
		...rest: unknown[]
	) => {
		if (delayMs === TOOL_CALL_BOUNDARY_GRACE_MS) boundaryWaits += 1;
		return realSetTimeout(callback, delayMs, ...rest);
	}) as never);
	const storm = setInterval(() => {
		session.handlers.get("tool_execution_update")?.(
			{ type: "tool_execution_update", toolCallId: "compiling-tool", output: "tick" },
			session.sessionContext,
		);
	}, 50);
	try {
		await waitFor(() => session.deadlineTerminals().length > 0, "single-wait deadline terminal", 25_000);
		clearInterval(storm);
		// The storm ran for the cap plus the whole grace, i.e. ~100 updates; each
		// one of them used to start its own wait.
		expect(boundaryWaits).toBe(1);
		expect(forced.records).toHaveLength(1);
		expect(forced.records[0]?.pendingToolCallIds).toEqual(["compiling-tool"]);
		// Bounded by the cap plus ONE grace, never a pile of overlapping ones. The
		// lower bound is half a grace for the same reason as the forced case above:
		// `acceptedAt` lags the server-side accept the deadline is armed from, so a
		// tight epsilon measures harness skew instead of the deadline.
		const elapsed = Date.now() - session.acceptedAt;
		expect(elapsed).toBeGreaterThan(maxRuntimeMs + TOOL_CALL_BOUNDARY_GRACE_MS / 2);
		expect(elapsed).toBeLessThan(maxRuntimeMs + 2 * TOOL_CALL_BOUNDARY_GRACE_MS);
		await Bun.sleep(300);
		expect(session.deadlineTerminals()).toHaveLength(1);
	} finally {
		clearInterval(storm);
		timerSpy.mockRestore();
		forced.restore();
		await shutdown(session);
	}
}, 60_000);
