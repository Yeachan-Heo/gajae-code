import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { markNonDispatchedToolEvent, type RunSettlementProof } from "@gajae-code/agent-core";
import type { Settings } from "../src/config/settings";
import type { ExtensionActions, ExtensionAPI } from "../src/extensibility/extensions/types";
import { createNotificationsExtension } from "../src/sdk/bus";

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

function start(
	ctx: Record<string, unknown>,
	settings: Settings,
	acceptFailure: AcceptFailure = { armed: false },
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
	} = {},
): Promise<BusSession> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-sdk-bus-deadline-${label}-`));
	dirs.push(cwd);
	const sessionId = `sdk-bus-deadline-${label}-${Date.now()}`;
	const sessionContext = context(cwd, sessionId, options.abortPromptAndWait);
	const acceptFailure: AcceptFailure = { armed: false };
	const handlers = start(sessionContext, deadlineSettings(cwd, leaseMs, maxRuntimeMs), acceptFailure);
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

test("non-attributable bus events never renew the accepted prompt deadline", async () => {
	// AC-1 + AC-3: streaming chatter and tool updates are not progress, so the
	// zero-activity expiry at acceptedAt + leaseMs is preserved.
	const session = await acceptPrompt("chatter", LEASE_MS, 60_000);
	try {
		await Bun.sleep(600);
		session.handlers.get("tool_execution_update")?.(
			{ type: "tool_execution_update", toolCallId: "chatter-tool", output: "tick" },
			session.sessionContext,
		);
		session.handlers.get("message_update")?.(
			{ type: "message_update", messageId: "chatter-message", delta: "still thinking" },
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
		session.handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolCallId: `cap-tool-${Date.now()}`, toolName: "read", args: {} },
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

test("a deadline expiry attempt in flight is superseded by real progress during fencing", async () => {
	// HIGH: after the durable claim, terminal fencing still awaits the run's
	// settlement proof. Attributable progress in that window must renew the
	// lease and prevent the deadline terminal from being published.
	const fenceStarted = Promise.withResolvers<void>();
	const releaseFence = Promise.withResolvers<void>();
	const session = await acceptPrompt("fence-supersede", 400, 60_000, {
		abortPromptAndWait: async () => {
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
		await Bun.sleep(300);
		expect(session.terminals(session.correlation)).toHaveLength(0);
		expect(session.deadlineTerminals()).toHaveLength(0);
		await waitFor(() => session.deadlineTerminals().length > 0, "rescheduled fencing deadline terminal");
		expect(session.deadlineTerminals()).toHaveLength(1);
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
