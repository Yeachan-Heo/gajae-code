import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	Agent,
	type AgentEvent,
	isNonDispatchedToolEvent,
	markNonDispatchedToolEvent,
	type RunSettlementProof,
} from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { logger } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ExtensionActions, ExtensionAPI } from "../src/extensibility/extensions/types";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
} from "../src/gjc-runtime/session-state-sidecar";
import { createNotificationsExtension } from "../src/sdk/bus";
import { createKindAwareReconciliation } from "../src/sdk/bus/kind-aware-reconciliation";
import type { InternalSdkSendOptions } from "../src/sdk/host/sdk-run-capability";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import {
	recordCommittedPromptFailure,
	registerCommittedPromptFailureWriter,
} from "../src/session/committed-prompt-failure";
import { readSdkRunCapability } from "../src/session/sdk-run-capability-internal";
import { SessionManager } from "../src/session/session-manager";

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
	sdkRunCapabilities?: unknown[];
}

function start(
	ctx: Record<string, unknown>,
	settings: Settings,
	acceptFailure: AcceptFailure = { armed: false },
): Map<string, (event: unknown, context: unknown) => unknown> {
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, context: unknown) => unknown) =>
			handlers.set(event, (payload, context) => {
				if (event !== "agent_start") return handler(payload, context);
				const start = payload as { type: string; sdkRunToken?: string };
				const capabilities = acceptFailure.sdkRunCapabilities ?? [];
				const index = start.sdkRunToken
					? capabilities.findIndex(capability => readSdkRunCapability(capability) === start.sdkRunToken)
					: 0;
				const capability = index >= 0 ? capabilities.splice(index, 1)[0] : undefined;
				return handler({ ...start, sdkRunToken: start.sdkRunToken ?? readSdkRunCapability(capability) }, context);
			}),
		registerCommand: () => {},
		getThinkingLevel: () => undefined,
		sendUserMessage: (
			_content: Parameters<ExtensionActions["sendUserMessage"]>[0],
			options?: InternalSdkSendOptions,
		) => {
			const commit = options?.onPreflightAcceptCommit;
			const accepted = options?.onPreflightAccepted;
			// The prompt never settles on its own: the deadline is the only terminal.
			const deliver = () => {
				acceptFailure.sdkRunCapabilities ??= [];
				acceptFailure.sdkRunCapabilities.push(options?.sdkRunCapability);
				return new Promise<never>(() => {}) as never;
			};
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
			recordCommittedPromptFailure: async (handle, failure, isCurrent) => {
				const writer = ctx.recordCommittedPromptFailure as
					| ((
							handle: string,
							failure: { code: "prompt_deadline_exceeded"; message: "Prompt deadline exceeded." },
							isCurrent: () => boolean,
					  ) => Promise<"persisted" | "stale">)
					| undefined;
				if (!writer) throw new Error("No committed receipt writer in this fixture");
				return writer(handle, failure, isCurrent);
			},
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
async function sendPrompt(session: BusSession, id: string): Promise<PromptAcknowledgement> {
	session.socket.send(
		JSON.stringify({ type: "control_request", id, operation: "turn.prompt", input: { text: `deadline ${id}` } }),
	);
	await waitFor(
		() => session.frames.some(frame => frame.type === "control_response" && frame.id === id),
		`prompt acknowledgement ${id}`,
	);
	return session.frames.find(frame => frame.type === "control_response" && frame.id === id) as never;
}

interface PromptAcknowledgement {
	ok?: boolean;
	error?: { code?: string; message?: string };
	result?: { commandId?: string; turnId?: string };
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
		let rejected: PromptAcknowledgement;
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

/** Drive the production AgentSession listener and its extension-event cloning. */
function productionToolEmitter(bus: BusSession) {
	const agent = new Agent({
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5"), tools: [], messages: [] },
	});
	let deliver: ((event: AgentEvent) => void) | undefined;
	const subscription = spyOn(agent, "subscribe").mockImplementation(listener => {
		deliver = listener;
		return () => {};
	});
	const clones: object[] = [];
	const runner = {
		hasHandlers: (type: string) => type === "tool_execution_start" || type === "tool_execution_end",
		emit: async (event: { type: string }) => {
			clones.push(event);
			await bus.handlers.get(event.type)?.(event, bus.sessionContext);
		},
	} as unknown as ExtensionRunner;
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
		extensionRunner: runner,
	});
	subscription.mockRestore();
	return {
		session,
		clones,
		emit: async (event: AgentEvent) => {
			if (!deliver) throw new Error("AgentSession did not subscribe to its agent");
			await deliver(event);
		},
	};
}

async function promptResult(session: BusSession): Promise<Record<string, unknown>> {
	const id = `result-${session.frames.length}`;
	session.socket.send(
		JSON.stringify({
			type: "query_request",
			id,
			query: "turn.result",
			input: { kind: "prompt", ...session.correlation },
		}),
	);
	await waitFor(
		() => session.frames.some(frame => frame.type === "query_response" && frame.id === id),
		"durable result",
	);
	const response = session.frames.find(frame => frame.type === "query_response" && frame.id === id)!;
	expect(response.ok).toBe(true);
	return response.result as Record<string, unknown>;
}

async function completeNaturally(session: BusSession): Promise<void> {
	await session.handlers.get("agent_end")?.(
		{
			type: "agent_end",
			stopReason: "completed",
			messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "finished" }] }],
		},
		session.sessionContext,
	);
	await waitFor(
		() =>
			session.frames.some(frame => frame.type === "agent_end" && frame.commandId === session.correlation.commandId),
		"natural terminal",
	);
	expect(await promptResult(session)).toMatchObject({
		status: "terminal_ok",
		receiptState: "present",
		content: { text: "finished" },
	});
	expect(session.deadlineTerminals()).toHaveLength(0);
}

for (const synthetic of [true, false]) {
	test(`AgentSession extension clones ${synthetic ? "preserve pairing-only provenance" : "renew genuine tool progress"} on the bus`, async () => {
		const bus = await acceptPrompt(`production-${synthetic}`, LEASE_MS, 60_000);
		const producer = productionToolEmitter(bus);
		try {
			await Bun.sleep(600);
			const start: AgentEvent = {
				type: "tool_execution_start",
				toolCallId: "production-tool",
				toolName: "read",
				args: {},
			};
			const end: AgentEvent = {
				type: "tool_execution_end",
				toolCallId: "production-tool",
				toolName: "read",
				result: { content: [{ type: "text", text: "tool result" }] },
				isError: false,
			};
			for (const original of [start, end]) {
				if (synthetic) markNonDispatchedToolEvent(original);
				await producer.emit(original);
				const clone = producer.clones.at(-1)!;
				expect(clone).not.toBe(original);
				expect(isNonDispatchedToolEvent(clone)).toBe(synthetic);
			}
			if (synthetic) {
				await waitFor(() => bus.deadlineTerminals().length > 0, "pairing-only production deadline");
				expect(Date.now() - bus.acceptedAt).toBeLessThan(600 + LEASE_MS);
			} else {
				await waitFor(() => Date.now() - bus.acceptedAt > LEASE_MS + 200, "original production deadline");
				expect(bus.deadlineTerminals()).toHaveLength(0);
				await completeNaturally(bus);
			}
		} finally {
			await producer.session.dispose();
			await shutdown(bus);
		}
	}, 30_000);
}

for (const boundary of ["claim", "fencing", "finalization"] as const) {
	test(`progress during ${boundary} releases the deadline claim before natural success`, async () => {
		const bus = await acceptPrompt(`release-${boundary}`, 800, 60_000);
		const producer = productionToolEmitter(bus);
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const realRename = fsPromises.rename.bind(fsPromises);
		let gated = false;
		const rename = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
			if (!gated && boundary !== "fencing" && String(to).includes(".sdk-reconciliation")) {
				const document = JSON.parse(await fsPromises.readFile(from, "utf8")) as {
					records: Array<{
						commandId: string;
						pendingOutcome?: { provenance: string };
						outcome?: { provenance: string };
						terminalAt?: number;
					}>;
				};
				const record = document.records.find(row => row.commandId === bus.correlation.commandId);
				if (
					record &&
					(boundary === "claim"
						? record.pendingOutcome?.provenance === "deadline"
						: record.outcome?.provenance === "deadline" && record.terminalAt !== undefined)
				) {
					gated = true;
					reached.resolve();
					await release.promise;
				}
			}
			return realRename(from, to);
		});
		if (boundary === "fencing")
			bus.sessionContext.abortPromptAndWait = async () => {
				if (!gated) {
					gated = true;
					reached.resolve();
					await release.promise;
				}
				return { status: "settled", terminalScope: {} };
			};
		try {
			await Promise.race([
				reached.promise,
				Bun.sleep(10_000).then(() => {
					throw new Error(`No ${boundary} gate`);
				}),
			]);
			await producer.emit({
				type: "tool_execution_end",
				toolCallId: `release-${boundary}`,
				toolName: "read",
				result: { content: [] },
				isError: false,
			});
			release.resolve();
			await Bun.sleep(100);
			expect(bus.terminals(bus.correlation)).toHaveLength(0);
			await completeNaturally(bus);
			await Bun.sleep(900);
			expect(bus.terminals(bus.correlation)).toHaveLength(1);
		} finally {
			release.resolve();
			rename.mockRestore();
			await producer.session.dispose();
			await shutdown(bus);
		}
	}, 30_000);
}

test("agent_failed followed by an empty agent_end remains failed with a missing receipt", async () => {
	const bus = await acceptPrompt("failure-empty", 60_000, 600_000);
	try {
		await bus.handlers.get("agent_failed")?.(
			{ type: "agent_failed", error: { code: "provider_down", message: "SECRET provider response" } },
			bus.sessionContext,
		);
		await bus.handlers.get("agent_end")?.(
			{ type: "agent_end", stopReason: "completed", messages: [] },
			bus.sessionContext,
		);
		await waitFor(() => bus.frames.some(frame => frame.type === "agent_failed" && frame.outcome), "failed terminal");
		expect(
			bus.frames.some(frame => frame.type === "agent_end" && frame.commandId === bus.correlation.commandId),
		).toBe(false);
		expect(await promptResult(bus)).toMatchObject({
			status: "failed",
			receiptState: "missing",
			error: { code: "provider_down" },
			outcome: { kind: "failed", provenance: "agent_failed" },
		});
		expect(JSON.stringify(bus.frames)).not.toContain("SECRET");
	} finally {
		await shutdown(bus);
	}
}, 30_000);

test("expiry diagnostics contain bounded lease state and exact correlation but no prompt data", async () => {
	const log = spyOn(logger, "error");
	const bus = await acceptPrompt("safe-diagnostic", 400, 60_000);
	try {
		await waitFor(() => bus.deadlineTerminals().length > 0, "diagnostic deadline");
		const call = log.mock.calls.find(
			([name, detail]) =>
				name === "sdk_prompt_terminal_failed" &&
				(detail as { commandId?: string })?.commandId === bus.correlation.commandId,
		);
		expect(call).toBeDefined();
		const detail = call![1] as Record<string, unknown>;
		expect(detail).toMatchObject({ ...bus.correlation, leaseMs: 400, maxMs: 60_000, generation: 0 });
		expect(detail.lastProgressAt).toBe(detail.acceptedAt);
		expect(detail.effectiveDeadline).toBe(Number(detail.acceptedAt) + 400);
		expect(JSON.stringify(detail)).not.toContain("deadline safe-diagnostic");
	} finally {
		log.mockRestore();
		await shutdown(bus);
	}
}, 30_000);

for (const terminal of ["cancel", "provider_failure"] as const) {
	test(`superseded fencing preserves a concurrent ${terminal} terminal`, async () => {
		const bus = await acceptPrompt(`race-${terminal}`, 800, 60_000);
		const release = Promise.withResolvers<void>();
		let gated = false;
		bus.sessionContext.abortPromptAndWait = async () => {
			if (!gated) {
				gated = true;
				await release.promise;
			}
			return { status: "settled", terminalScope: {} };
		};
		try {
			await waitFor(() => gated, "in-flight fencing");
			bus.handlers.get("tool_execution_end")?.(
				{
					type: "tool_execution_end",
					toolCallId: "race-tool",
					toolName: "read",
					result: { content: [] },
					isError: false,
				},
				bus.sessionContext,
			);
			if (terminal === "cancel") {
				bus.socket.send(
					JSON.stringify({
						type: "control_request",
						id: "race-cancel",
						operation: "turn.abort",
						input: {},
						idempotencyKey: "race-cancel",
					}),
				);
			} else {
				await bus.handlers.get("agent_failed")?.(
					{ type: "agent_failed", error: { code: "provider_down", message: "private failure" } },
					bus.sessionContext,
				);
				await bus.handlers.get("agent_end")?.(
					{ type: "agent_end", stopReason: "completed", messages: [] },
					bus.sessionContext,
				);
			}
			release.resolve();
			await waitFor(
				() => bus.frames.some(frame => frame.commandId === bus.correlation.commandId && frame.outcome),
				"race terminal",
			);
			const result = await promptResult(bus);
			if (terminal === "cancel") {
				expect(result).toMatchObject({
					status: "terminal_ok",
					outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
				});
			} else {
				expect(result).toMatchObject({
					status: "failed",
					receiptState: "missing",
					error: { code: "provider_down" },
					outcome: { kind: "failed", provenance: "agent_failed" },
				});
			}
			expect(bus.deadlineTerminals()).toHaveLength(0);
			await Bun.sleep(900);
			expect(
				bus.frames.filter(frame => frame.commandId === bus.correlation.commandId && frame.outcome),
			).toHaveLength(1);
		} finally {
			release.resolve();
			await shutdown(bus);
		}
	}, 30_000);
}

test("progress during fencing cannot supersede the acceptance-anchored hard maximum", async () => {
	const bus = await acceptPrompt("fencing-cap", 400, 400);
	const release = Promise.withResolvers<void>();
	let gated = false;
	bus.sessionContext.abortPromptAndWait = async () => {
		gated = true;
		await release.promise;
		return { status: "settled", terminalScope: {} };
	};
	try {
		await waitFor(() => gated, "hard-cap fencing");
		bus.handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolCallId: "cap-fence-tool", toolName: "read", args: {} },
			bus.sessionContext,
		);
		release.resolve();
		await waitFor(() => bus.deadlineTerminals().length > 0, "hard-cap terminal");
		expect(bus.deadlineTerminals()).toHaveLength(1);
		expect(await promptResult(bus)).toMatchObject({
			status: "failed",
			receiptState: "missing",
			outcome: { code: "prompt_deadline_exceeded" },
		});
	} finally {
		release.resolve();
		await shutdown(bus);
	}
}, 30_000);

test("a natural agent_end emitted by awaited fencing does not deadlock its expiry owner", async () => {
	const bus = await acceptPrompt("fencing-agent-end", 800, 60_000);
	bus.sessionContext.abortPromptAndWait = async () => {
		bus.handlers.get("tool_execution_end")?.(
			{
				type: "tool_execution_end",
				toolCallId: "settled-tool",
				toolName: "read",
				result: { content: [] },
				isError: false,
			},
			bus.sessionContext,
		);
		await bus.handlers.get("agent_end")?.(
			{
				type: "agent_end",
				stopReason: "completed",
				messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "settled receipt" }] }],
			},
			bus.sessionContext,
		);
		return { status: "settled", terminalScope: {} };
	};
	try {
		await waitFor(
			() => bus.frames.some(frame => frame.type === "agent_end" && frame.commandId === bus.correlation.commandId),
			"fencing-owned natural terminal",
		);
		expect(bus.deadlineTerminals()).toHaveLength(0);
		expect(await promptResult(bus)).toMatchObject({
			status: "terminal_ok",
			receiptState: "present",
			content: { text: "settled receipt" },
		});
	} finally {
		await shutdown(bus);
	}
}, 30_000);

test("deadline release retains acceptance and receipt evidence and refuses stale or non-deadline owners", async () => {
	let now = 100;
	const reconciliation = createKindAwareReconciliation({ now: () => now });
	const correlation = { commandId: "release-command", turnId: "release-turn" };
	const deadline = {
		kind: "failed",
		code: "prompt_deadline_exceeded",
		message: "Prompt deadline exceeded.",
		provenance: "deadline",
	} as const;
	await reconciliation.noteAccepted("prompt", correlation);
	await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
	await reconciliation.claimPendingOutcome("prompt", correlation, deadline, "present");
	await reconciliation.releaseDeadlineOutcome("prompt", correlation, () => false);
	expect(reconciliation.peekPendingOutcome("prompt", correlation)).toEqual(deadline);
	await reconciliation.finalizeOutcome("prompt", correlation, deadline, undefined, "retained receipt");
	now = 200;
	await reconciliation.releaseDeadlineOutcome("prompt", correlation, () => true);
	expect(reconciliation.lookup("prompt", correlation)).toMatchObject({
		status: "in_flight",
		acceptedAt: 100,
		startedAt: 100,
	});
	expect(reconciliation.peekPendingOutcome("prompt", correlation)).toBeUndefined();
	const cancelled = { kind: "stopped", reason: "cancelled", provenance: "client_cancel" } as const;
	await reconciliation.claimPendingOutcome("prompt", correlation, cancelled, "missing");
	await reconciliation.releaseDeadlineOutcome("prompt", correlation, () => true);
	expect(reconciliation.peekPendingOutcome("prompt", correlation)).toEqual(cancelled);
	await reconciliation.finalizeOutcome("prompt", correlation, cancelled);
	const settled = reconciliation.lookupResult("prompt", correlation);
	expect(settled).toMatchObject({
		status: "terminal_ok",
		acceptedAt: 100,
		receiptState: "present",
		content: { text: "retained receipt" },
		outcome: cancelled,
	});
	await reconciliation.releaseDeadlineOutcome("prompt", correlation, () => true);
	expect(reconciliation.lookupResult("prompt", correlation)).toEqual(settled);
});

for (const providerFailure of [false, true]) {
	test(`superseded finalization stays query-invisible through compensation${providerFailure ? " and preserves provider receipt" : ""}`, async () => {
		const bus = await acceptPrompt(`compensation-${providerFailure}`, 2_000, 60_000);
		const finalizeReached = Promise.withResolvers<void>();
		const releaseFinalize = Promise.withResolvers<void>();
		const compensationReached = Promise.withResolvers<void>();
		const releaseCompensation = Promise.withResolvers<void>();
		const realRename = fsPromises.rename.bind(fsPromises);
		let finalized = false;
		let compensated = false;
		let projected = false;
		bus.sessionContext.recordCommittedPromptFailure = async () => {
			projected = true;
			return "persisted";
		};
		const rename = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
			if (String(to).includes(".sdk-reconciliation")) {
				const document = JSON.parse(await fsPromises.readFile(from, "utf8")) as {
					records: Array<{ commandId: string; terminalAt?: number; outcome?: { provenance?: string } }>;
				};
				const row = document.records.find(record => record.commandId === bus.correlation.commandId);
				if (!finalized && row?.terminalAt !== undefined && row.outcome?.provenance === "deadline") {
					finalized = true;
					finalizeReached.resolve();
					await releaseFinalize.promise;
				} else if (finalized && !compensated && row && row.terminalAt === undefined) {
					compensated = true;
					compensationReached.resolve();
					await releaseCompensation.promise;
				}
			}
			return realRename(from, to);
		});
		try {
			await finalizeReached.promise;
			bus.handlers.get("tool_execution_end")?.(
				{
					type: "tool_execution_end",
					toolCallId: "compensation-progress",
					toolName: "read",
					result: { content: [] },
				},
				bus.sessionContext,
			);
			const diagnostic = providerFailure
				? bus.handlers.get("agent_failed")?.(
						{ type: "agent_failed", error: { code: "provider_down", message: "private provider text" } },
						bus.sessionContext,
					)
				: undefined;
			releaseFinalize.resolve();
			await compensationReached.promise;
			expect(await promptResult(bus)).toMatchObject({ status: "in_flight", receiptState: "absent" });
			expect(bus.deadlineTerminals()).toHaveLength(0);
			expect(projected).toBe(false);
			releaseCompensation.resolve();
			await diagnostic;
			await bus.handlers.get("agent_end")?.(
				{
					type: "agent_end",
					stopReason: "completed",
					messages: [
						{
							role: "assistant",
							stopReason: "stop",
							content: [{ type: "text", text: "retained provider receipt" }],
						},
					],
				},
				bus.sessionContext,
			);
			await waitFor(
				() => bus.frames.some(frame => frame.commandId === bus.correlation.commandId && frame.outcome),
				"compensated terminal",
			);
			expect(await promptResult(bus)).toMatchObject({
				status: providerFailure ? "failed" : "terminal_ok",
				receiptState: "present",
				content: { text: "retained provider receipt" },
				...(providerFailure ? { error: { code: "provider_down" } } : {}),
			});
			expect(projected).toBe(false);
			expect(
				bus.frames.filter(frame => frame.commandId === bus.correlation.commandId && frame.outcome),
			).toHaveLength(1);
		} finally {
			releaseFinalize.resolve();
			releaseCompensation.resolve();
			rename.mockRestore();
			await shutdown(bus);
		}
	}, 30_000);
}

for (const superseded of [false, true]) {
	test(`production deadline abort with an empty runtime terminal ${superseded ? "does not persist a superseded failure" : "projects committed failure into its sidecar"}`, async () => {
		const oldFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const oldId = process.env[GJC_COORDINATOR_SESSION_ID_ENV];
		const bus = await acceptPrompt(`sidecar-${superseded}`, 2_000, 60_000, { startAgent: false });
		const stateFile = path.join(bus.cwd, "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = `deadline-sidecar-${superseded}`;
		const auth = await AuthStorage.create(path.join(bus.cwd, "auth.db"));
		auth.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(auth);
		const settings = Settings.isolated({ "compaction.enabled": false });
		const manager = SessionManager.inMemory();
		const runner = new ExtensionRunner(
			[],
			{ flagValues: new Map(), pendingProviderRegistrations: [] } as never,
			bus.cwd,
			manager,
			modelRegistry,
			undefined,
			settings,
		);
		const releaseModel = Promise.withResolvers<void>();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: getBundledModel("anthropic", "claude-sonnet-4-5"),
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: createMockModel({
				responses: [
					async () => {
						await releaseModel.promise;
						return { content: ["   "] };
					},
					{ content: ["successor receipt"] },
				],
			}).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			extensionRunner: runner,
		});
		const events: string[] = [];
		const originalEmit = runner.emit.bind(runner);
		const consumer = spyOn(runner, "emit").mockImplementation(async (event, continueWhile, scope) => {
			events.push(event.type);
			await bus.handlers.get(event.type)?.(event, bus.sessionContext);
			return originalEmit(event, continueWhile, scope);
		});
		bus.sessionContext.getActivePromptHandle = () => session.activePromptHandle;
		let handle: string | undefined;
		let projections = 0;
		bus.sessionContext.recordCommittedPromptFailure = async (
			executionHandle: string,
			failure: { code: "prompt_deadline_exceeded"; message: "Prompt deadline exceeded." },
			isCurrent: () => boolean,
		) => {
			projections++;
			if (!handle) throw new Error("Expected captured execution handle");
			expect(executionHandle).toBe(handle);
			expect(await promptResult(bus)).toMatchObject({ status: "failed", outcome: { provenance: "deadline" } });
			return recordCommittedPromptFailure(session, executionHandle, failure, isCurrent);
		};
		bus.sessionContext.abortPromptAndWait = async (executionHandle: string, options: { graceMs: number }) => {
			if (superseded)
				await bus.handlers.get("tool_execution_end")?.(
					{
						type: "tool_execution_end",
						toolCallId: "before-abort-progress",
						toolName: "read",
						result: { content: [] },
					},
					bus.sessionContext,
				);
			const abort = session.abortPromptAndWait(executionHandle, options);
			releaseModel.resolve();
			return abort;
		};
		const sdkRunCapability = bus.acceptFailure.sdkRunCapabilities?.[0];
		expect(readSdkRunCapability(sdkRunCapability)).toBeDefined();
		// Forward the actual capability minted by ordinary bus admission; the
		// fixture never invents a run token or repairs missing production input.
		const prompt = session.prompt("wait for deadline", { sdkRunCapability });
		try {
			await waitFor(() => session.activePromptHandle !== undefined, "real runtime execution handle");
			handle = session.activePromptHandle;
			await waitFor(
				() => bus.frames.some(frame => frame.commandId === bus.correlation.commandId && frame.outcome),
				"production deadline terminal",
			);
			await prompt;
			await session.waitForIdle();
			expect(events).toContain("agent_end");
			expect(events).not.toContain("agent_failed");
			if (superseded) {
				expect(projections).toBe(0);
				expect(bus.deadlineTerminals()).toHaveLength(0);
			} else {
				expect(projections).toBe(1);
				expect(bus.deadlineTerminals()).toHaveLength(1);
			}
			const state = JSON.parse(await Bun.file(stateFile).text()) as Record<string, unknown>;
			if (superseded) {
				expect(state).not.toMatchObject({ error: { code: "prompt_deadline_exceeded" } });
				expect(state.run_failure).toBeUndefined();
			} else
				expect(state).toMatchObject({
					execution_state: "failed",
					receipt_state: "absent",
					run_failure: { code: "prompt_deadline_exceeded" },
				});
			// Retrying a captured predecessor failure after a clean successor must
			// neither borrow its identity nor replace its receipt.
			await session.prompt("successor");
			await session.waitForIdle();
			await waitFor(() => events.filter(event => event === "agent_end").length === 2, "successor terminal");
			await waitFor(
				() =>
					fs.existsSync(stateFile) &&
					JSON.parse(fs.readFileSync(stateFile, "utf8")).final_response?.text === "successor receipt",
				"successor receipt persistence",
			);
			const before = await Bun.file(stateFile).text();
			expect(
				await recordCommittedPromptFailure(
					session,
					handle!,
					{ code: "prompt_deadline_exceeded", message: "Prompt deadline exceeded." },
					() => true,
				),
			).toBe("stale");
			expect(await Bun.file(stateFile).text()).toBe(before);
		} finally {
			releaseModel.resolve();
			await prompt.catch(() => {});
			consumer.mockRestore();
			await session.dispose();
			auth.close();
			await shutdown(bus);
			if (oldFile === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
			else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = oldFile;
			if (oldId === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
			else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = oldId;
		}
	}, 30_000);
}

test("committed deadline projection retries only its exact handle and cannot be superseded after commitment", async () => {
	const bus = await acceptPrompt("projection-retry", 500, 60_000);
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let attempts = 0;
	bus.sessionContext.recordCommittedPromptFailure = async (
		handle: string,
		failure: unknown,
		isCurrent: () => boolean,
	) => {
		expect(handle).toBe("bus-deadline-run-handle");
		expect(failure).toEqual({ code: "prompt_deadline_exceeded", message: "Prompt deadline exceeded." });
		expect(isCurrent()).toBe(true);
		attempts++;
		if (attempts < 3) throw new Error("transient projection write failure");
		reached.resolve();
		await release.promise;
		expect(isCurrent()).toBe(true);
		return "persisted";
	};
	try {
		await reached.promise;
		expect(await promptResult(bus)).toMatchObject({ status: "failed", outcome: { provenance: "deadline" } });
		bus.handlers.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolCallId: "postcommit-progress", toolName: "read", result: { content: [] } },
			bus.sessionContext,
		);
		release.resolve();
		await waitFor(() => bus.deadlineTerminals().length === 1, "committed projection terminal");
		expect(attempts).toBe(3);
		expect(await promptResult(bus)).toMatchObject({ status: "failed", outcome: { provenance: "deadline" } });
	} finally {
		release.resolve();
		await shutdown(bus);
	}
}, 30_000);

test("a registered stalled projection cannot hold the committed wire terminal or mutate a successor", async () => {
	const bus = await acceptPrompt("projection-stalled", 500, 60_000);
	const producer = productionToolEmitter(bus);
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const settled = Promise.withResolvers<void>();
	const log = spyOn(logger, "error");
	let calls = 0;
	let writes = 0;
	let current: (() => boolean) | undefined;
	registerCommittedPromptFailureWriter(producer.session, async (handle, failure, isCurrent) => {
		calls++;
		expect(handle).toBe("bus-deadline-run-handle");
		expect(failure.code).toBe("prompt_deadline_exceeded");
		current = isCurrent;
		entered.resolve();
		// Never settles during the entire observation window. Release only
		// after a successor exists to exercise the late-write authority fence.
		await release.promise;
		if (isCurrent()) writes++;
		settled.resolve();
		return isCurrent() ? "persisted" : "stale";
	});
	bus.sessionContext.recordCommittedPromptFailure = (
		handle: string,
		failure: { code: "prompt_deadline_exceeded"; message: "Prompt deadline exceeded." },
		isCurrent: () => boolean,
	) => recordCommittedPromptFailure(producer.session, handle, failure, isCurrent);
	try {
		await entered.promise;
		const observationStarted = Date.now();
		expect(await promptResult(bus)).toMatchObject({ status: "failed", outcome: { provenance: "deadline" } });
		await waitFor(() => bus.deadlineTerminals().length === 1, "bounded stalled projection terminal", 13_000);
		expect(Date.now() - observationStarted).toBeLessThan(12_500);
		expect(calls).toBe(1);
		expect(current?.()).toBe(false);
		expect(
			log.mock.calls.some(
				([name, detail]) =>
					name === "sdk_prompt_failure_projection_unresolved" &&
					(detail as { commandId?: string; retryable?: boolean })?.commandId === bus.correlation.commandId &&
					(detail as { retryable?: boolean }).retryable === true,
			),
		).toBe(true);
		await bus.handlers.get("agent_end")?.(
			{ type: "agent_end", stopReason: "completed", messages: [] },
			bus.sessionContext,
		);
		const ack = await sendPrompt(bus, "after-stalled-projection");
		expect(ack.ok).toBe(true);
		const successor = { commandId: String(ack.result?.commandId), turnId: String(ack.result?.turnId) };
		await bus.handlers.get("agent_start")?.({ type: "agent_start" }, bus.sessionContext);
		release.resolve();
		await settled.promise;
		await Bun.sleep(100);
		expect(writes).toBe(0);
		expect(calls).toBe(1);
		expect(bus.deadlineTerminals()).toHaveLength(1);
		expect(bus.terminals(successor)).toHaveLength(0);
		await bus.handlers.get("agent_end")?.(
			{ type: "agent_end", stopReason: "completed", messages: [] },
			bus.sessionContext,
		);
		await waitFor(() => bus.terminals(successor).length === 1, "successor terminal after stalled projection");
		expect(bus.deadlineTerminals()).toHaveLength(1);
	} finally {
		release.resolve();
		log.mockRestore();
		await producer.session.dispose();
		await shutdown(bus);
	}
}, 30_000);

test("real atomic projection fsync timeout cannot publish predecessor failure before a successor", async () => {
	const oldFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	const oldId = process.env[GJC_COORDINATOR_SESSION_ID_ENV];
	const bus = await acceptPrompt("atomic-projection-timeout", 2_000, 60_000, { startAgent: false });
	const stateFile = path.join(bus.cwd, "runtime-state.json");
	process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
	process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "atomic-projection-timeout";
	const auth = await AuthStorage.create(path.join(bus.cwd, "auth.db"));
	auth.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(auth);
	const settings = Settings.isolated({ "compaction.enabled": false });
	const manager = SessionManager.inMemory();
	const runner = new ExtensionRunner(
		[],
		{ flagValues: new Map(), pendingProviderRegistrations: [] } as never,
		bus.cwd,
		manager,
		modelRegistry,
		undefined,
		settings,
	);
	const releaseModel = Promise.withResolvers<void>();
	const mock = createMockModel({
		responses: [
			async () => {
				await releaseModel.promise;
				return { content: ["   "] };
			},
			{ content: ["atomic successor receipt"] },
		],
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry,
		extensionRunner: runner,
	});
	const originalEmit = runner.emit.bind(runner);
	const events: string[] = [];
	const consumer = spyOn(runner, "emit").mockImplementation(async (event, continueWhile, scope) => {
		events.push(event.type);
		await bus.handlers.get(event.type)?.(event, bus.sessionContext);
		return originalEmit(event, continueWhile, scope);
	});
	const entered = Promise.withResolvers<void>();
	const releaseSync = Promise.withResolvers<void>();
	const projectionSettled = Promise.withResolvers<void>();
	const open = fsPromises.open;
	const rename = fsPromises.rename;
	let projectionStarted = false;
	let temporary: string | undefined;
	const syncSpies: Array<{ mockRestore(): void }> = [];
	let projectionCalls = 0;
	let projectionResult: "persisted" | "stale" | undefined;
	const publications: Record<string, unknown>[] = [];
	const openSpy = spyOn(fsPromises, "open").mockImplementation(async (file, flags, mode) => {
		const handle = await open(file, flags, mode);
		if (
			projectionStarted &&
			!temporary &&
			String(file).startsWith(`${stateFile}.`) &&
			String(file).endsWith(".tmp")
		) {
			const sync = handle.sync.bind(handle);
			const syncSpy = spyOn(handle, "sync").mockImplementation(async () => {
				const payload = (await Bun.file(String(file)).json()) as { run_failure?: { code?: string } };
				if (!temporary && payload.run_failure?.code === "prompt_deadline_exceeded") {
					temporary = String(file);
					entered.resolve();
					await releaseSync.promise;
				}
				await sync();
			});
			syncSpies.push(syncSpy);
		}
		return handle;
	});
	const renameSpy = spyOn(fsPromises, "rename").mockImplementation(async (source, destination) => {
		if (String(destination) === stateFile)
			publications.push((await Bun.file(String(source)).json()) as Record<string, unknown>);
		await rename(source, destination);
	});
	bus.sessionContext.getActivePromptHandle = () => session.activePromptHandle;
	bus.sessionContext.abortPromptAndWait = (handle: string, options: { graceMs: number }) => {
		const abort = session.abortPromptAndWait(handle, options);
		releaseModel.resolve();
		return abort;
	};
	bus.sessionContext.recordCommittedPromptFailure = async (
		handle: string,
		failure: { code: "prompt_deadline_exceeded"; message: "Prompt deadline exceeded." },
		isCurrent: () => boolean,
	) => {
		projectionCalls++;
		projectionStarted = true;
		try {
			// Invoke the actual AgentSession-registered writer and its atomic I/O.
			projectionResult = await recordCommittedPromptFailure(session, handle, failure, isCurrent);
			return projectionResult;
		} finally {
			projectionSettled.resolve();
		}
	};
	const capability = bus.acceptFailure.sdkRunCapabilities?.[0];
	expect(readSdkRunCapability(capability)).toBeDefined();
	const prompt = session.prompt("wait for atomic deadline", { sdkRunCapability: capability });
	let successorPrompt: Promise<void> | undefined;
	try {
		await entered.promise;
		const observationStarted = Date.now();
		expect(temporary).toBeDefined();
		const candidate = (await Bun.file(temporary!).json()) as Record<string, unknown>;
		expect(candidate.run_failure).toMatchObject({ code: "prompt_deadline_exceeded" });
		const before = await Bun.file(stateFile).text();
		const publicationBoundary = publications.length;
		expect(await promptResult(bus)).toMatchObject({ status: "failed", outcome: { provenance: "deadline" } });
		await waitFor(
			() => bus.deadlineTerminals().length === 1,
			"wire terminal while real fsync remains blocked",
			13_000,
		);
		expect(Date.now() - observationStarted).toBeGreaterThan(9_000);
		expect(Date.now() - observationStarted).toBeLessThan(12_500);
		expect(projectionCalls).toBe(1);
		expect(projectionResult).toBeUndefined();
		expect(await Bun.file(stateFile).text()).toBe(before);
		expect(publications).toHaveLength(publicationBoundary);
		await prompt;
		expect(events).not.toContain("agent_failed");
		const ack = await sendPrompt(bus, "atomic-successor");
		expect(ack.ok).toBe(true);
		const successor = { commandId: String(ack.result?.commandId), turnId: String(ack.result?.turnId) };
		const successorCapability = bus.acceptFailure.sdkRunCapabilities?.[0];
		expect(readSdkRunCapability(successorCapability)).toBeDefined();
		successorPrompt = session.prompt("atomic successor", { sdkRunCapability: successorCapability });
		await waitFor(
			() => events.filter(type => type === "agent_start").length === 2,
			"successor admitted while predecessor fsync is blocked",
		);
		// Inspect every rename, including the interval before successor publication:
		// final-file checks alone would miss a transient stale failure overwrite.
		releaseSync.resolve();
		await projectionSettled.promise;
		expect(projectionResult).toBe("stale");
		await successorPrompt;
		await session.waitForIdle();
		await waitFor(
			() =>
				fs.existsSync(stateFile) &&
				JSON.parse(fs.readFileSync(stateFile, "utf8")).final_response?.text === "atomic successor receipt",
			"atomic successor receipt persistence",
		);
		expect(await Bun.file(temporary!).exists()).toBe(false);
		const after = publications.slice(publicationBoundary);
		expect(after.length).toBeGreaterThan(0);
		expect(
			after.some(payload => payload.state === "running" && payload.run_provenance !== candidate.run_provenance),
		).toBe(true);
		expect(after.every(payload => payload.run_failure === undefined)).toBe(true);
		expect(await Bun.file(stateFile).json()).toMatchObject({
			execution_state: "terminal_ok",
			receipt_state: "present",
			final_response: { text: "atomic successor receipt" },
		});
		expect(mock.calls).toHaveLength(2);
		expect(projectionCalls).toBe(1);
		expect(bus.deadlineTerminals()).toHaveLength(1);
		expect(bus.terminals(successor)).toHaveLength(1);
	} finally {
		releaseSync.resolve();
		releaseModel.resolve();
		await Promise.allSettled([prompt, ...(successorPrompt ? [successorPrompt] : [])]);
		if (projectionStarted) await projectionSettled.promise;
		for (const spy of syncSpies) spy.mockRestore();
		openSpy.mockRestore();
		renameSpy.mockRestore();
		consumer.mockRestore();
		await session.dispose();
		auth.close();
		await shutdown(bus);
		if (oldFile === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = oldFile;
		if (oldId === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
		else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = oldId;
	}
}, 40_000);
