import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { AsyncJobManager } from "../../async";
import type { Settings } from "../../config/settings";
import type { ExtensionAPI, ExtensionContext, ExtensionTranscriptEntry } from "../../extensibility/extensions";
import {
	registerOwnedRegistration,
	resetTerminalAbortRegistriesForTests,
	type TurnRegistrationKey,
	unregisterOwnedRegistration,
} from "../../session/terminal-abort";
import { Broker } from "../broker/broker";
import { createKindAwareReconciliation } from "../bus/kind-aware-reconciliation";
import { createPromptReconciliation } from "../bus/prompt-reconciliation";
import { createReconciliationStore } from "../bus/reconciliation-store";
import { BROKER_RUNTIME_ABORT_CAPABILITY_FIELD, setBrokerRuntimeAbortCapabilityForTest } from "./control/runtime-gate";
import { CursorRegistry, QueryHandlers, type QueryResponse, RevisionStore } from "./query";
import {
	createInvocationReconciliation,
	createSdkSessionRuntimeExtension,
	createSdkSurfaceFactory,
	type SdkOnlyInvocationRecord,
	type SdkOnlyReconciliationStore,
	SessionSdkSessionRuntime,
	type SessionSdkTransport,
} from "./session-runtime";
import { createSdkCapabilities, createSdkSurfacePolicy } from "./surface-policy";
import type { SdkFrame } from "./types";
import { SdkTransportLifecycleError } from "./websocket-transport";

function memoryTransport(): SessionSdkTransport & {
	feed(connectionId: string, frame: SdkFrame): void;
	readonly sent: SdkFrame[];
	readonly broadcasts: SdkFrame[];
} {
	let handler: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	const sent: SdkFrame[] = [];
	const broadcasts: SdkFrame[] = [];
	let started = false;
	return {
		sessionId: "session-runtime-test",
		stateRoot: "/tmp/gjc-session-runtime-test",
		token: "test-token",
		sent,
		broadcasts,
		onFrame(next) {
			handler = next;
			return () => {
				if (handler === next) handler = undefined;
			};
		},
		sendFrame(_connectionId, frame) {
			sent.push(frame);
		},
		start: async () => {
			started = true;
			return { url: "ws://127.0.0.1:1" };
		},
		stop: async () => {
			started = false;
		},
		broadcastFrame(frame) {
			broadcasts.push(frame);
		},
		feed(connectionId, frame) {
			if (!started) throw new Error("transport is not started");
			handler?.(connectionId, frame);
		},
	};
}

function admissionBarrier(target: number) {
	const ready = Promise.withResolvers<void>();
	let admitted = 0;
	return {
		onFrameAdmitted() {
			admitted += 1;
			if (admitted === target) ready.resolve();
		},
		ready: ready.promise,
	};
}

function extensionContext(
	sessionId: string,
	cwd: string,
	options: {
		goalState?: unknown;
		branch?: unknown[];
		liveState?: { isStreaming: boolean; steeringQueueDepth: number; followupQueueDepth: number };
		transcript?: ExtensionTranscriptEntry[];
	} = {},
): ExtensionContext {
	return {
		cwd,
		workflowGate: undefined,
		sdkBindings: () => [],
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(cwd, `${sessionId}.json`),
			getSessionName: () => undefined,
			getBranch: () => options.branch ?? [],
		},
		getTranscript: () => options.transcript ?? [],
		getGoalState: () => options.goalState,
	} as unknown as ExtensionContext;
}

function goalModeEntry(sessionId: string, tokensUsed: number): Record<string, unknown> {
	return {
		type: "mode_change",
		id: `goal-${sessionId}`,
		parentId: null,
		timestamp: new Date(1_000).toISOString(),
		mode: "goal",
		data: {
			goal: {
				id: `goal-${sessionId}`,
				objective: "Preserve the active SDK goal",
				status: "active",
				tokensUsed,
				timeUsedSeconds: 2,
				createdAt: 1_000,
				updatedAt: 2_000,
			},
		},
	};
}

async function queryGoalState(
	ctx: ExtensionContext,
	sessionId: string,
	liveState?: { isStreaming: boolean; steeringQueueDepth: number; followupQueueDepth: number },
): Promise<unknown> {
	const surface = createSdkSurfaceFactory({
		ctx,
		id: sessionId,
		api: {} as ExtensionAPI,
		getLiveState: () => liveState ?? { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 },
	}).query;
	const store = new RevisionStore(sessionId);
	const cursors = new CursorRegistry("goal-test-token", store);
	const response = await new QueryHandlers(surface, sessionId, store, cursors).dispatch({
		query: "goal.list/get",
		connectionId: "goal-test-connection",
	});
	if (!response.ok) throw new Error(`goal query failed: ${JSON.stringify(response)}`);
	return response.page?.items[0];
}

async function queryLastAssistant(ctx: ExtensionContext, sessionId: string): Promise<QueryResponse> {
	const surface = createSdkSurfaceFactory({
		ctx,
		id: sessionId,
		api: {} as ExtensionAPI,
	}).query;
	const store = new RevisionStore(sessionId);
	const response = await new QueryHandlers(
		surface,
		sessionId,
		store,
		new CursorRegistry("last-assistant-test-token", store),
	).dispatch({
		query: "session.last_assistant",
		connectionId: "last-assistant-test-connection",
	});
	return response;
}

test("session.last_assistant returns the latest projected readable text past non-text assistant tails", async () => {
	const sessionId = "last-assistant-readable-tail";
	const transcript: ExtensionTranscriptEntry[] = [
		{
			id: "visible-readable",
			role: "assistant",
			textSummary: "first line second line",
			ts: new Date(1).toISOString(),
			content: [
				{ type: "text", text: "first line" },
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "second line" },
			],
		},
		...Array.from(
			{ length: 2_000 },
			(_, index): ExtensionTranscriptEntry => ({
				id: `tool-tail-${index}`,
				role: "assistant",
				textSummary: "",
				ts: new Date(index + 2).toISOString(),
				body: index % 3 === 0 ? "" : index % 3 === 1 ? " \n\t " : undefined,
				content:
					index % 3 === 2
						? [
								{ type: "thinking", thinking: "not readable" },
								{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} },
							]
						: undefined,
			}),
		),
	];
	const ctx = extensionContext(sessionId, "/tmp", {
		transcript,
		branch: [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "raw private tail" }] },
			},
		],
	});

	expect(await queryLastAssistant(ctx, sessionId)).toMatchObject({
		ok: true,
		page: { items: ["first line\nsecond line"] },
	});
});

test("session.last_assistant returns resource_gone when the projected transcript has no readable assistant text", async () => {
	const sessionId = "last-assistant-empty";
	const ctx = extensionContext(sessionId, "/tmp", {
		transcript: [
			{
				id: "user",
				role: "user",
				textSummary: "hello",
				ts: new Date(1).toISOString(),
				body: "hello",
			},
			{
				id: "thinking-only",
				role: "assistant",
				textSummary: "",
				ts: new Date(2).toISOString(),
				content: [{ type: "thinking", thinking: "private reasoning" }],
			},
		],
	});

	expect(await queryLastAssistant(ctx, sessionId)).toMatchObject({ ok: false, error: { code: "resource_gone" } });
});

test("native prompt reconciliation fails closed for an explicitly empty assistant result", () => {
	const reconciliation = createPromptReconciliation();
	const correlation = { commandId: "native-empty-command", turnId: "native-empty-turn" };
	reconciliation.admit("native-empty-ref");
	reconciliation.noteAccepted(correlation, "native-empty-ref");
	reconciliation.noteTransition(correlation, { type: "agent_end", finalText: "" });
	expect(reconciliation.lookup({ clientRef: "native-empty-ref" })).toMatchObject({
		status: "failed",
		error: { code: "prompt_failed" },
		receiptState: "missing",
	});
	reconciliation.noteTransition(correlation, { type: "agent_end", finalText: "late text" });
	expect(reconciliation.lookup({ clientRef: "native-empty-ref" })).toMatchObject({
		status: "failed",
		receiptState: "present",
	});
});

test("broker reconciliation fails closed for an empty prompt and persists the first terminal result", async () => {
	let records: unknown[] = [];
	const store = {
		load: async () => records,
		transact: async (mutator: (current: never[]) => never[]) => {
			records = mutator(records as never);
		},
	} as never;
	const reconciliation = createKindAwareReconciliation({ store });
	const correlation = { commandId: "broker-empty-command", turnId: "broker-empty-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "broker-empty-ref");
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_end",
		content: { version: 1, type: "text", text: "", byteLength: 0, truncated: false },
	});
	const settled = reconciliation.lookupResult("prompt", { clientRef: "broker-empty-ref" });
	expect(settled).toMatchObject({ status: "failed", error: { code: "prompt_failed" } });
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_end",
		content: { version: 1, type: "text", text: "late text", byteLength: 9, truncated: false },
	});
	const reloaded = createKindAwareReconciliation({ store });
	await reloaded.hydrateFromStore();
	expect(reloaded.lookupResult("prompt", { clientRef: "broker-empty-ref" })).toMatchObject({
		status: "failed",
		error: { code: "prompt_failed" },
		content: { text: "late text", byteLength: 9, truncated: false },
	});
	expect(reloaded.lookup("prompt", { clientRef: "broker-empty-ref" })).toMatchObject({ receiptState: "present" });
	const noOpCorrelation = { commandId: "broker-noop-command", turnId: "broker-noop-turn" };
	await reconciliation.noteAccepted("prompt", noOpCorrelation, "broker-noop-ref");
	await reconciliation.finalizeOutcome(
		"prompt",
		noOpCorrelation,
		{ kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
		undefined,
		"",
	);
	expect(reconciliation.lookupResult("prompt", { clientRef: "broker-noop-ref" })).toMatchObject({
		status: "terminal_ok",
	});
});

test("session-host prompt reconciliation fails closed when the accepted result is empty", async () => {
	const reconciliation = createInvocationReconciliation();
	const correlation = { commandId: "host-empty-command", turnId: "host-empty-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "host-empty-ref");
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_end",
		content: { version: 1, type: "text", text: "", byteLength: 0, truncated: false },
	});
	expect(reconciliation.lookup("prompt", { clientRef: "host-empty-ref" })).toMatchObject({
		status: "failed",
		error: { code: "prompt_failed" },
	});
});

describe("SDK goal snapshot lifecycle", () => {
	test("recovers an active nonzero-activity goal from the durable session projection", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-goal-recovery-"));
		try {
			const sessionId = "runtime-recreated";
			const branch = [goalModeEntry(sessionId, 17)];
			const liveGoal = {
				enabled: true,
				mode: "active",
				goal: { ...(branch[0] as { data: { goal: Record<string, unknown> } }).data.goal },
			};
			const live = await queryGoalState(
				extensionContext(sessionId, cwd, { goalState: liveGoal, branch }),
				sessionId,
				{ isStreaming: true, steeringQueueDepth: 1, followupQueueDepth: 0 },
			);
			const recreated = await queryGoalState(extensionContext(sessionId, cwd, { branch }), sessionId);

			expect(live).toMatchObject({ enabled: true, goal: { status: "active", tokensUsed: 17 } });
			expect(recreated).toEqual(live);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("keeps fresh session/worktree projections isolated while an active turn has activity", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-goal-isolation-"));
		try {
			const first = await queryGoalState(
				extensionContext("fresh-session-a", path.join(root, "a"), {
					branch: [goalModeEntry("fresh-session-a", 11)],
				}),
				"fresh-session-a",
			);
			const second = await queryGoalState(
				extensionContext("fresh-session-b", path.join(root, "b"), {
					branch: [goalModeEntry("fresh-session-b", 23)],
				}),
				"fresh-session-b",
			);

			expect(first).toMatchObject({ goal: { id: "goal-fresh-session-a", tokensUsed: 11 } });
			expect(second).toMatchObject({ goal: { id: "goal-fresh-session-b", tokensUsed: 23 } });
			expect(first).not.toEqual(second);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("returns an explicit no-active-goal diagnostic for the zero-activity control", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-goal-empty-"));
		try {
			const result = await queryGoalState(extensionContext("zero-activity", cwd), "zero-activity");
			expect(result).toMatchObject({ enabled: false, goal: null, reason: "no_active_goal" });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("returns a recoverable diagnostic when durable active-goal state is malformed", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-goal-corrupt-"));
		try {
			const result = await queryGoalState(
				extensionContext("corrupt-goal", cwd, {
					branch: [{ ...goalModeEntry("corrupt-goal", 19), data: { goal: { status: "active" } } }],
				}),
				"corrupt-goal",
			);
			expect(result).toMatchObject({
				reason: "goal_state_unavailable",
				recoverable: true,
				goal: null,
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

test("preserves an agent failure code in host prompt reconciliation", async () => {
	const reconciliation = createInvocationReconciliation();
	const correlation = { commandId: "failed-command", turnId: "failed-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "failed-ref");
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_failed",
		error: Object.assign(new Error("provider unavailable"), { code: "provider_unavailable" }),
	});
	await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
	expect(reconciliation.lookup("prompt", { clientRef: "failed-ref" })).toMatchObject({
		status: "failed",
		error: { code: "provider_unavailable", message: "Prompt submission failed." },
	});
});

test("SDK-only finalizeOutcome keeps legacy recordError positional compatibility", async () => {
	const compatReconciliation = createInvocationReconciliation();
	const compatCorrelation = { commandId: "finalize-compat-command", turnId: "finalize-compat-turn" };
	await compatReconciliation.noteAccepted("prompt", compatCorrelation, "finalize-compat-ref");
	await compatReconciliation.claimPendingOutcome("prompt", compatCorrelation, {
		kind: "failed",
		code: "prompt_failed",
		message: "Prompt submission failed.",
	});
	// Legacy positional recordError as the 4th argument: must be applied as the
	// error override and never invoked as a function (exact-head review P1).
	await compatReconciliation.finalizeOutcome("prompt", compatCorrelation, undefined, {
		code: "legacy_error",
		message: "legacy message",
	});
	expect(compatReconciliation.lookup("prompt", { clientRef: "finalize-compat-ref" })).toMatchObject({
		status: "failed",
		error: { code: "legacy_error", message: "legacy message" },
	});
	// The isCurrent callback shape still fences a stale finalize to a no-op.
	const second = createInvocationReconciliation();
	const secondCorrelation = { commandId: "finalize-fence-command", turnId: "finalize-fence-turn" };
	await second.noteAccepted("prompt", secondCorrelation, "finalize-fence-ref");
	await second.claimPendingOutcome("prompt", secondCorrelation, {
		kind: "failed",
		code: "prompt_failed",
		message: "Prompt submission failed.",
	});
	// A stale isCurrent=false fence must no-op the finalize entirely: the record
	// stays accepted (never invoked with a legacy object, never half-finalized).
	await second.finalizeOutcome("prompt", secondCorrelation, undefined, () => false);
	expect(second.lookup("prompt", { clientRef: "finalize-fence-ref" })).toMatchObject({
		status: "accepted",
	});
	await second.finalizeOutcome("prompt", secondCorrelation, undefined, () => true);
	expect(second.lookup("prompt", { clientRef: "finalize-fence-ref" })).toMatchObject({
		status: "failed",
	});
});

test("SDK-only terminal outcomes survive result projection and durable reload", async () => {
	let records: unknown[] = [];
	const store = {
		path: null,
		load: async () => records,
		transact: async (mutator: (current: never[]) => never[]) => {
			records = mutator(records as never);
		},
	} as never;
	const stopped = { kind: "stopped", reason: "cancelled", provenance: "client_cancel" } as const;
	const reconciliation = createInvocationReconciliation({ store });
	const correlation = { commandId: "outcome-command", turnId: "outcome-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "outcome-ref");
	await reconciliation.claimPendingOutcome("prompt", correlation, stopped);
	await reconciliation.finalizeOutcome("prompt", correlation);
	const projected = reconciliation.lookupResult("prompt", { clientRef: "outcome-ref" });
	expect(projected).toMatchObject({ status: "terminal_ok", outcome: stopped, receiptState: "unknown" });
	expect(reconciliation.lookup("prompt", { clientRef: "outcome-ref" })).toMatchObject({ outcome: stopped });

	const reopened = createInvocationReconciliation({ store });
	await reopened.hydrate();
	expect(reopened.lookupResult("prompt", { clientRef: "outcome-ref" })).toMatchObject({
		status: "terminal_ok",
		outcome: stopped,
	});

	const direct = createInvocationReconciliation();
	const directCorrelation = { commandId: "direct-outcome-command", turnId: "direct-outcome-turn" };
	await direct.noteAccepted("prompt", directCorrelation, "direct-outcome-ref");
	await direct.noteTransition("prompt", directCorrelation, { type: "agent_end", outcome: stopped });
	expect(direct.lookupResult("prompt", { clientRef: "direct-outcome-ref" })).toMatchObject({
		status: "terminal_ok",
		outcome: stopped,
	});
});

test("a late agent failure never overwrites the reason an already terminal record carries", async () => {
	const reconciliation = createInvocationReconciliation();
	const correlation = { commandId: "first-reason-command", turnId: "first-reason-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "first-reason-ref");
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_failed",
		error: Object.assign(new Error("stream interrupted"), { code: "upstream_stream_interrupted" }),
	});
	await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
	const claimed = reconciliation.lookup("prompt", { clientRef: "first-reason-ref" });
	expect(claimed).toMatchObject({
		status: "failed",
		error: { code: "upstream_stream_interrupted", message: "Prompt submission failed." },
		terminalAt: expect.any(Number),
	});
	// First reason wins: a second, different late failure neither replaces the recorded
	// reason nor re-stamps the terminal. The sleep makes a re-stamped terminalAt observable.
	await Bun.sleep(2);
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_failed",
		error: Object.assign(new Error("transport reset"), { code: "transport_reset" }),
	});
	expect(reconciliation.lookup("prompt", { clientRef: "first-reason-ref" })).toEqual(claimed);
});

test("a failed acceptance persist rolls back the provisional record and reservation", async () => {
	let records: unknown[] = [];
	let failNext = true;
	const store = {
		path: null,
		load: async () => records,
		transact: async (mutator: (current: never[]) => never[]) => {
			const candidate = mutator(records as never);
			if (failNext) {
				failNext = false;
				throw new Error("accept persist failed");
			}
			records = candidate;
		},
	} as never;
	const reconciliation = createInvocationReconciliation({ store });
	const first = { commandId: "accept-failed-command", turnId: "accept-failed-turn" };
	reconciliation.admit("prompt", "accept-failed-ref");
	await expect(reconciliation.noteAccepted("prompt", first, "accept-failed-ref")).rejects.toThrow(
		"accept persist failed",
	);
	reconciliation.release("prompt", "accept-failed-ref");
	expect(reconciliation.lookup("prompt", first)).toEqual({ status: "unknown", receiptState: "unknown" });

	const retry = { commandId: "accept-retry-command", turnId: "accept-retry-turn" };
	reconciliation.admit("prompt", "accept-failed-ref");
	await reconciliation.noteAccepted("prompt", retry, "accept-failed-ref");
	expect(reconciliation.lookup("prompt", { clientRef: "accept-failed-ref" })).toMatchObject({
		status: "accepted",
		commandId: retry.commandId,
		turnId: retry.turnId,
	});
});

test("a failed uncertainty persist restores the durable deadline terminal until retry succeeds", async () => {
	let records: unknown[] = [];
	let failNext = false;
	const store = {
		path: null,
		load: async () => records,
		transact: async (mutator: (current: never[]) => never[]) => {
			const candidate = mutator(records as never);
			if (failNext) {
				failNext = false;
				throw new Error("uncertainty persist failed");
			}
			records = candidate;
		},
	} as never;
	const reconciliation = createInvocationReconciliation({ store });
	const correlation = { commandId: "uncertain-command", turnId: "uncertain-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "uncertain-ref");
	await reconciliation.finalizeOutcome("prompt", correlation, {
		kind: "failed",
		code: "prompt_deadline_exceeded",
		message: "deadline",
	});
	failNext = true;
	await expect(reconciliation.markUncertain("prompt", correlation)).rejects.toThrow("uncertainty persist failed");
	expect(reconciliation.lookup("prompt", { clientRef: "uncertain-ref" })).toMatchObject({
		status: "failed",
		error: { code: "prompt_deadline_exceeded" },
	});
	const reloadedBeforeRetry = createInvocationReconciliation({ store });
	await reloadedBeforeRetry.hydrate();
	expect(reloadedBeforeRetry.lookup("prompt", { clientRef: "uncertain-ref" })).toMatchObject({
		status: "failed",
		error: { code: "prompt_deadline_exceeded" },
	});
	await reconciliation.markUncertain("prompt", correlation, undefined, 50);
	expect(reconciliation.lookup("prompt", { clientRef: "uncertain-ref" })).toMatchObject({ status: "accepted" });
	expect(records).toEqual([expect.objectContaining({ deadlineRecoveryPending: true, deadlineMaxAt: 50 })]);
	expect(reconciliation.listDeadlineRecoveryPendingPrompts()).toEqual([
		{ correlation, acceptedAt: expect.any(Number), deadlineMaxAt: 50 },
	]);
});

test("SDK-only markUncertain persists an active-schema record without quarantining siblings", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-uncertain-reload-"));
	try {
		const sessionFile = path.join(root, "session.jsonl");
		await Bun.write(sessionFile, "");
		const store = createReconciliationStore({ sessionFile, sessionId: "uncertain-reload" });
		const reconciliation = createInvocationReconciliation({ store });
		const correlation = { commandId: "uncertain-reload-command", turnId: "uncertain-reload-turn" };
		const sibling = { commandId: "uncertain-sibling-command", turnId: "uncertain-sibling-turn" };
		await reconciliation.noteAccepted("prompt", correlation, "uncertain-reload-ref");
		await reconciliation.finalizeOutcome("prompt", correlation, {
			kind: "failed",
			code: "prompt_deadline_exceeded",
			message: "deadline",
		});
		await reconciliation.noteAccepted("skill", sibling, "uncertain-sibling-ref");
		await reconciliation.finalizeOutcome("skill", sibling, {
			kind: "stopped",
			code: "cancelled",
			message: "cancelled",
		});

		await reconciliation.markUncertain("prompt", correlation, undefined, 5_000);
		const active = store
			.snapshot()
			.find(record => record.kind === "prompt" && record.commandId === correlation.commandId) as
			| Record<string, unknown>
			| undefined;
		expect(active).toMatchObject({ status: "accepted", deadlineRecoveryPending: true, deadlineMaxAt: 5_000 });
		expect(active?.terminalAt).toBeUndefined();
		expect(active?.receiptState).toBeUndefined();
		expect(active?.outcome).toBeUndefined();
		expect(active?.pendingOutcome).toBeUndefined();
		expect(active?.pendingReceiptState).toBeUndefined();

		const reopenedStore = createReconciliationStore({ sessionFile, sessionId: "uncertain-reload" });
		const reopened = createInvocationReconciliation({ store: reopenedStore });
		await reopened.hydrate();
		expect(reopened.lookup("prompt", { clientRef: "uncertain-reload-ref" })).toMatchObject({ status: "accepted" });
		expect(reopened.lookup("skill", { clientRef: "uncertain-sibling-ref" })).toMatchObject({
			status: "terminal_ok",
		});
		expect((await readdir(root)).some(name => name.includes("corrupt"))).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("durable reload keeps agent_end terminal across a paused successor transition", async () => {
	let records: unknown[] = [];
	let pauseWrites = 0;
	const writeStarted = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const releaseWrite = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const store = {
		path: null,
		load: async () => records,
		transact: async (mutator: (current: never[]) => never[]) => {
			const candidate = mutator(records as never);
			if (pauseWrites > 0) {
				const index = 2 - pauseWrites;
				pauseWrites -= 1;
				writeStarted[index]?.resolve();
				await releaseWrite[index]?.promise;
			}
			records = candidate;
		},
	} as never;
	const reconciliation = createInvocationReconciliation({ store });
	const correlation = { commandId: "durable-race-command", turnId: "durable-race-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "durable-race-ref");
	pauseWrites = 2;
	const terminal = reconciliation.noteTransition("prompt", correlation, {
		type: "agent_end",
		content: { version: 1, type: "text", text: "completed", byteLength: 9, truncated: false },
	});
	await writeStarted[0]!.promise;
	// A successor lifecycle event arrives while the terminal write is held. It
	// must observe the staged terminal record and never resurrect in_flight state.
	await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
	releaseWrite[0]!.resolve();
	releaseWrite[1]!.resolve();
	await terminal;
	const reloaded = createInvocationReconciliation({ store });
	await reloaded.hydrate();
	expect(reloaded.lookup("prompt", { clientRef: "durable-race-ref" })).toMatchObject({
		status: "terminal_ok",
		terminalAt: expect.any(Number),
	});
});

test("agent_end is not swallowed when deadline persistence fails", async () => {
	let records: unknown[] = [];
	let pauseNext = false;
	let failNext = false;
	const persistStarted = Promise.withResolvers<void>();
	const releasePersist = Promise.withResolvers<void>();
	const store = {
		path: null,
		load: async () => records,
		transact: async (mutator: (current: never[]) => never[]) => {
			const candidate = mutator(records as never);
			if (pauseNext) {
				pauseNext = false;
				persistStarted.resolve();
				await releasePersist.promise;
			}
			if (failNext) {
				failNext = false;
				throw new Error("held store failed");
			}
			records = candidate;
		},
	} as never;
	const reconciliation = createInvocationReconciliation({ store });
	const correlation = { commandId: "finalize-race-command", turnId: "finalize-race-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "finalize-race-ref");
	pauseNext = true;
	failNext = true;
	const deadline = reconciliation.finalizeOutcome("prompt", correlation, {
		kind: "failed",
		code: "prompt_deadline_exceeded",
		message: "deadline",
	});
	await persistStarted.promise;
	const terminal = reconciliation.noteTransition("prompt", correlation, {
		type: "agent_end",
		content: { version: 1, type: "text", text: "completed", byteLength: 9, truncated: false },
	});
	releasePersist.resolve();
	await expect(deadline).rejects.toThrow("held store failed");
	await terminal;
	const reloaded = createInvocationReconciliation({ store });
	await reloaded.hydrate();
	expect(reloaded.lookup("prompt", { clientRef: "finalize-race-ref" })).toMatchObject({
		status: "terminal_ok",
		terminalAt: expect.any(Number),
	});
});

test("a rejected internal finalization commit is sunk without an unhandled rejection", async () => {
	let records: unknown[] = [];
	let failNext = false;
	const store = {
		path: null,
		load: async () => records,
		transact: async (mutator: (current: never[]) => never[]) => {
			const candidate = mutator(records as never);
			if (failNext) {
				failNext = false;
				throw new Error("internal finalization failed");
			}
			records = candidate;
		},
	} as never;
	const reconciliation = createInvocationReconciliation({ store });
	const correlation = { commandId: "finalize-unhandled-command", turnId: "finalize-unhandled-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "finalize-unhandled-ref");
	failNext = true;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		await expect(
			reconciliation.finalizeOutcome("prompt", correlation, {
				kind: "failed",
				code: "prompt_deadline_exceeded",
				message: "deadline",
			}),
		).rejects.toThrow("internal finalization failed");
		await Bun.sleep(25);
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("agent_end upgrades a durable deadline terminal when it races a successful finalize", async () => {
	let records: unknown[] = [];
	const store = {
		path: null,
		load: async () => records,
		transact: async (mutator: (current: never[]) => never[]) => {
			records = mutator(records as never);
		},
	} as never;
	const reconciliation = createInvocationReconciliation({ store });
	const correlation = { commandId: "upgrade-race-command", turnId: "upgrade-race-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "upgrade-race-ref");
	await reconciliation.finalizeOutcome("prompt", correlation, {
		kind: "failed",
		code: "prompt_deadline_exceeded",
		message: "deadline",
	});
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_end",
		content: { version: 1, type: "text", text: "completed", byteLength: 9, truncated: false },
	});
	const reloaded = createInvocationReconciliation({ store });
	await reloaded.hydrate();
	expect(reloaded.lookup("prompt", { clientRef: "upgrade-race-ref" })).toMatchObject({ status: "terminal_ok" });
});

test("an empty late agent_end cannot upgrade a durable prompt deadline failure", async () => {
	let records: unknown[] = [];
	const store = {
		path: null,
		load: async () => records,
		transact: async (mutator: (current: never[]) => never[]) => {
			records = mutator(records as never);
		},
	} as never;
	const reconciliation = createInvocationReconciliation({ store });
	const correlation = { commandId: "empty-deadline-command", turnId: "empty-deadline-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "empty-deadline-ref");
	await reconciliation.finalizeOutcome("prompt", correlation, {
		kind: "failed",
		code: "prompt_deadline_exceeded",
		message: "deadline",
	});
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_end",
		content: { version: 1, type: "text", text: "", byteLength: 0, truncated: false },
	});
	expect(reconciliation.lookup("prompt", { clientRef: "empty-deadline-ref" })).toMatchObject({
		status: "failed",
		error: { code: "prompt_deadline_exceeded" },
	});
	const reloaded = createInvocationReconciliation({ store });
	await reloaded.hydrate();
	expect(reloaded.lookup("prompt", { clientRef: "empty-deadline-ref" })).toMatchObject({
		status: "failed",
		error: { code: "prompt_deadline_exceeded" },
	});
});

test("whitespace and provider failures stay actionable across a late empty agent_end", async () => {
	let records: unknown[] = [];
	const store = {
		path: null,
		load: async () => records,
		transact: async (mutator: (current: never[]) => never[]) => {
			records = mutator(records as never);
		},
	} as never;
	const reconciliation = createInvocationReconciliation({ store });
	const whitespace = { commandId: "whitespace-command", turnId: "whitespace-turn" };
	await reconciliation.noteAccepted("prompt", whitespace, "whitespace-ref");
	await reconciliation.noteTransition("prompt", whitespace, {
		type: "agent_end",
		content: { version: 1, type: "text", text: " \t\n ", byteLength: 4, truncated: false },
	});
	expect(reconciliation.lookup("prompt", { clientRef: "whitespace-ref" })).toMatchObject({
		status: "failed",
		error: { code: "prompt_failed", message: "Prompt submission failed." },
	});

	const providerFailure = { commandId: "provider-command", turnId: "provider-turn" };
	await reconciliation.noteAccepted("prompt", providerFailure, "provider-ref");
	await reconciliation.noteTransition("prompt", providerFailure, {
		type: "agent_failed",
		error: Object.assign(new Error("provider leaked detail"), { code: "provider_unavailable" }),
	});
	await reconciliation.noteTransition("prompt", providerFailure, {
		type: "agent_end",
		content: { version: 1, type: "text", text: "", byteLength: 0, truncated: false },
	});
	expect(reconciliation.lookup("prompt", { clientRef: "provider-ref" })).toMatchObject({
		status: "failed",
		error: { code: "provider_unavailable", message: "Prompt submission failed." },
	});
});

test("an empty prompt terminal remains failed after a late real failure", async () => {
	let records: unknown[] = [];
	let writes = 0;
	const store = {
		path: null,
		load: async () => records,
		transact: async (mutator: (current: never[]) => never[]) => {
			writes += 1;
			const candidate = mutator(records as never);
			if (writes === 3) throw new Error("upgrade persist failed");
			records = candidate;
		},
	} as never;
	const reconciliation = createInvocationReconciliation({ store });
	const correlation = { commandId: "upgrade-failure-command", turnId: "upgrade-failure-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "upgrade-failure-ref");
	await reconciliation.finalizeOutcome("prompt", correlation, {
		kind: "failed",
		code: "prompt_deadline_exceeded",
		message: "deadline",
	});
	await expect(
		reconciliation.noteTransition("prompt", correlation, {
			type: "agent_end",
			content: { version: 1, type: "text", text: "completed", byteLength: 9, truncated: false },
		}),
	).rejects.toThrow("upgrade persist failed");
	expect(reconciliation.lookup("prompt", { clientRef: "upgrade-failure-ref" })).toMatchObject({
		status: "failed",
		error: { code: "prompt_deadline_exceeded" },
	});
	const stale = createInvocationReconciliation({ store });
	await stale.hydrate();
	expect(stale.lookup("prompt", { clientRef: "upgrade-failure-ref" })).toMatchObject({
		status: "failed",
		error: { code: "prompt_deadline_exceeded" },
	});
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_end",
		content: { version: 1, type: "text", text: "completed", byteLength: 9, truncated: false },
	});
	const reloaded = createInvocationReconciliation({ store });
	await reloaded.hydrate();
	expect(reloaded.lookup("prompt", { clientRef: "upgrade-failure-ref" })).toMatchObject({ status: "terminal_ok" });
});

test("late cancellation and non-text activity upgrade deadline terminals", async () => {
	const makeStore = () => {
		let records: unknown[] = [];
		return {
			path: null,
			load: async () => records,
			transact: async (mutator: (current: never[]) => never[]) => {
				records = mutator(records as never);
			},
		} as never;
	};
	const cancelled = createInvocationReconciliation({ store: makeStore() });
	const cancelledCorrelation = { commandId: "late-cancel-command", turnId: "late-cancel-turn" };
	await cancelled.noteAccepted("prompt", cancelledCorrelation, "late-cancel-ref");
	await cancelled.finalizeOutcome("prompt", cancelledCorrelation, {
		kind: "failed",
		code: "prompt_deadline_exceeded",
		message: "deadline",
	});
	await cancelled.noteTransition("prompt", cancelledCorrelation, {
		type: "agent_end",
		outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
	});
	expect(cancelled.lookup("prompt", { clientRef: "late-cancel-ref" })).toMatchObject({ status: "terminal_ok" });

	const activity = createInvocationReconciliation({ store: makeStore() });
	const activityCorrelation = { commandId: "late-activity-command", turnId: "late-activity-turn" };
	await activity.noteAccepted("prompt", activityCorrelation, "late-activity-ref");
	await activity.finalizeOutcome("prompt", activityCorrelation, {
		kind: "failed",
		code: "prompt_deadline_exceeded",
		message: "deadline",
	});
	await activity.noteTransition("prompt", activityCorrelation, { type: "agent_end", hasActivity: true });
	expect(activity.lookup("prompt", { clientRef: "late-activity-ref" })).toMatchObject({ status: "terminal_ok" });
});
test("finalization without an explicit outcome follows the noteTransition evidence predicate", async () => {
	const makeLocalStore = () => {
		let records: unknown[] = [];
		return {
			path: null,
			load: async () => records,
			transact: async (mutator: (current: never[]) => never[]) => {
				records = mutator(records as never);
			},
		} as never;
	};
	const contentBearing = createInvocationReconciliation({ store: makeLocalStore() });
	const contentCorrelation = { commandId: "final-content-command", turnId: "final-content-turn" };
	await contentBearing.noteAccepted("prompt", contentCorrelation, "final-content-ref");
	await contentBearing.finalizeOutcome("prompt", contentCorrelation, undefined, undefined, undefined, {
		content: { version: 1, type: "text", text: "completed", byteLength: 9, truncated: false },
	});
	expect(contentBearing.lookup("prompt", { clientRef: "final-content-ref" })).toMatchObject({
		status: "terminal_ok",
	});

	const activityBearing = createInvocationReconciliation({ store: makeLocalStore() });
	const activityCorrelation = { commandId: "final-activity-command", turnId: "final-activity-turn" };
	await activityBearing.noteAccepted("prompt", activityCorrelation, "final-activity-ref");
	await activityBearing.finalizeOutcome("prompt", activityCorrelation, undefined, undefined, undefined, {
		hasActivity: true,
	});
	expect(activityBearing.lookup("prompt", { clientRef: "final-activity-ref" })).toMatchObject({
		status: "terminal_ok",
	});

	const stoppedOutcome = createInvocationReconciliation({ store: makeLocalStore() });
	const stoppedCorrelation = { commandId: "final-stopped-command", turnId: "final-stopped-turn" };
	await stoppedOutcome.noteAccepted("prompt", stoppedCorrelation, "final-stopped-ref");
	await stoppedOutcome.finalizeOutcome("prompt", stoppedCorrelation, undefined, undefined, undefined, {
		outcomeKind: "stopped",
	});
	expect(stoppedOutcome.lookup("prompt", { clientRef: "final-stopped-ref" })).toMatchObject({
		status: "terminal_ok",
	});

	const evidenceFree = createInvocationReconciliation({ store: makeLocalStore() });
	const emptyCorrelation = { commandId: "final-empty-command", turnId: "final-empty-turn" };
	await evidenceFree.noteAccepted("prompt", emptyCorrelation, "final-empty-ref");
	await evidenceFree.finalizeOutcome("prompt", emptyCorrelation);
	expect(evidenceFree.lookup("prompt", { clientRef: "final-empty-ref" })).toMatchObject({
		status: "failed",
		error: { code: "prompt_failed" },
	});
	const legacyArg5 = createInvocationReconciliation({ store: makeLocalStore() });
	const legacyCorrelation = { commandId: "final-legacy-command", turnId: "final-legacy-turn" };
	await legacyArg5.noteAccepted("prompt", legacyCorrelation, "final-legacy-ref");
	await legacyArg5.finalizeOutcome("prompt", legacyCorrelation, undefined, undefined, {
		content: { version: 1, type: "text", text: "legacy", byteLength: 6, truncated: false },
	});
	await legacyArg5.noteTransition("prompt", legacyCorrelation, {
		type: "agent_end",
		content: { version: 1, type: "text", text: "later", byteLength: 5, truncated: false },
	});
	expect(legacyArg5.lookupResult("prompt", { clientRef: "final-legacy-ref" })).toMatchObject({
		status: "terminal_ok",
		content: { text: "legacy", byteLength: 6, truncated: false },
	});

	const explicitFailure = createInvocationReconciliation({ store: makeLocalStore() });
	const failureCorrelation = { commandId: "final-failure-command", turnId: "final-failure-turn" };
	await explicitFailure.noteAccepted("prompt", failureCorrelation, "final-failure-ref");
	await explicitFailure.finalizeOutcome("prompt", failureCorrelation, {
		kind: "failed",
		code: "provider_rejected",
		message: "provider rejected",
	});
	expect(explicitFailure.lookup("prompt", { clientRef: "final-failure-ref" })).toMatchObject({
		status: "failed",
		receiptState: "unknown",
		outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed" },
		error: { code: "prompt_failed" },
	});
});

test("provider failures outrank later stopped outcomes in both SDK-only terminal paths", async () => {
	const providerError = Object.assign(new Error("provider rejected"), { code: "provider_rejected" });
	const transition = createInvocationReconciliation();
	const transitionCorrelation = { commandId: "precedence-transition-command", turnId: "precedence-transition-turn" };
	await transition.noteAccepted("prompt", transitionCorrelation, "precedence-transition-ref");
	await transition.noteTransition("prompt", transitionCorrelation, { type: "agent_failed", error: providerError });
	await transition.noteTransition("prompt", transitionCorrelation, {
		type: "agent_end",
		outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
	});
	expect(transition.lookupResult("prompt", { clientRef: "precedence-transition-ref" })).toMatchObject({
		status: "failed",
		error: { code: "provider_rejected" },
	});

	const finalized = createInvocationReconciliation();
	const finalizedCorrelation = { commandId: "precedence-finalize-command", turnId: "precedence-finalize-turn" };
	await finalized.noteAccepted("prompt", finalizedCorrelation, "precedence-finalize-ref");
	await finalized.noteTransition("prompt", finalizedCorrelation, { type: "agent_failed", error: providerError });
	await finalized.claimPendingOutcome("prompt", finalizedCorrelation, {
		kind: "failed",
		code: "prompt_deadline_exceeded",
		message: "deadline",
	});
	await finalized.finalizeOutcome("prompt", finalizedCorrelation);
	expect(finalized.lookupResult("prompt", { clientRef: "precedence-finalize-ref" })).toMatchObject({
		status: "failed",
		error: { code: "provider_rejected" },
	});

	const generic = createInvocationReconciliation();
	const genericCorrelation = { commandId: "precedence-generic-command", turnId: "precedence-generic-turn" };
	await generic.noteAccepted("prompt", genericCorrelation, "precedence-generic-ref");
	await generic.noteTransition("prompt", genericCorrelation, {
		type: "agent_failed",
		error: Object.assign(new Error("generic failure"), { code: "agent_failed" }),
	});
	await generic.noteTransition("prompt", genericCorrelation, {
		type: "agent_end",
		outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
	});
	expect(generic.lookupResult("prompt", { clientRef: "precedence-generic-ref" })).toMatchObject({
		status: "failed",
		error: { code: "agent_failed", message: "Prompt submission failed." },
	});
});

test("a reason attached after a prompt settled is never replaced by a later failure", async () => {
	const reconciliation = createInvocationReconciliation();
	const correlation = { commandId: "late-reason-command", turnId: "late-reason-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "late-reason-ref");
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_end",
		content: { version: 1, type: "text", text: "completed", byteLength: 9, truncated: false },
	});
	const claimed = reconciliation.lookup("prompt", { clientRef: "late-reason-ref" }) as Record<string, unknown>;
	expect(claimed).toEqual({
		status: "terminal_ok",
		commandId: "late-reason-command",
		turnId: "late-reason-turn",
		clientRef: "late-reason-ref",
		acceptedAt: expect.any(Number),
		terminalAt: expect.any(Number),
		receiptState: "present",
		content: { version: 1, type: "text", text: "completed", byteLength: 9, truncated: false },
	});
	// A failure delivered after the record settled enriches it with the sanitized reason and
	// leaves the terminal claim itself (status, terminalAt, identity) untouched.
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_failed",
		error: Object.assign(new Error("late provider failure"), { code: "upstream_error" }),
	});
	const enriched = reconciliation.lookup("prompt", { clientRef: "late-reason-ref" });
	expect(enriched).toEqual({ ...claimed, error: { code: "upstream_error", message: "Prompt submission failed." } });
	// First reason wins on the enrichment path too: a second, different late failure changes
	// nothing. The sleep makes a re-stamped terminalAt observable.
	await Bun.sleep(2);
	await reconciliation.noteTransition("prompt", correlation, {
		type: "agent_failed",
		error: Object.assign(new Error("transport reset"), { code: "transport_reset" }),
	});
	expect(reconciliation.lookup("prompt", { clientRef: "late-reason-ref" })).toEqual(enriched);
});

test("redacts a persisted host failure during hydration", async () => {
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-reconciliation-"));
	const sessionId = "hydrated-failure";
	try {
		await Bun.write(
			path.join(stateRoot, ".sdk-reconciliation", `${sessionId}.json`),
			JSON.stringify({
				version: 1,
				sessionId,
				records: [
					{
						kind: "prompt",
						commandId: "persisted-command",
						turnId: "persisted-turn",
						status: "failed",
						acceptedAt: 1,
						terminalAt: Date.now(),
						error: { code: "unsafe code!", message: "secret provider payload" },
					},
				],
			}),
		);
		const reconciliation = createInvocationReconciliation({ stateRoot, sessionId });
		await reconciliation.hydrate();
		expect(
			reconciliation.lookup("prompt", { commandId: "persisted-command", turnId: "persisted-turn" }),
		).toMatchObject({
			status: "failed",
			error: { code: "internal", message: "Prompt submission failed." },
		});
	} finally {
		await rm(stateRoot, { recursive: true, force: true });
	}
});
test("retains terminal host reconciliation records past the 15-minute window", async () => {
	// #4547: terminal records must stay canonical until per-kind capacity
	// eviction; age must never expire them on the SDK-only host path.
	const realNow = Date.now;
	let clock = 1_000_000;
	Date.now = () => clock;
	try {
		const reconciliation = createInvocationReconciliation();
		const promptCorrelation = { commandId: "aged-command", turnId: "aged-turn" };
		const skillCorrelation = { commandId: "aged-skill-command", turnId: "aged-skill-turn" };
		reconciliation.admit("prompt", "aged-ref");
		reconciliation.admit("skill", "aged-skill-ref");
		await reconciliation.noteAccepted("prompt", promptCorrelation, "aged-ref");
		await reconciliation.noteAccepted("skill", skillCorrelation, "aged-skill-ref");
		await reconciliation.noteTransition("prompt", promptCorrelation, {
			type: "agent_end",
			content: { version: 1, type: "text", text: "completed", byteLength: 9, truncated: false },
		});
		await reconciliation.noteTransition("skill", skillCorrelation, { type: "agent_end" });

		clock += 15 * 60_000 + 1;
		expect(reconciliation.lookup("prompt", { clientRef: "aged-ref" })).toMatchObject({
			status: "terminal_ok",
		});
		expect(reconciliation.lookup("skill", { clientRef: "aged-skill-ref" })).toMatchObject({
			status: "terminal_ok",
		});
		expect(() => reconciliation.admit("prompt", "aged-ref")).toThrowError(/never reuse a clientRef/);
	} finally {
		Date.now = realNow;
	}
});

test("capacity eviction still releases the clientRef and reports honest unknown", async () => {
	// The removal of age eviction must not weaken the oldest-terminal-first
	// capacity trim: at the cap the oldest terminal is evicted and its
	// clientRef becomes admissible again with the prior outcome unknown.
	const reconciliation = createInvocationReconciliation();
	const first = { commandId: "capacity-command-1", turnId: "capacity-turn-1" };
	reconciliation.admit("prompt", "capacity-ref-1");
	await reconciliation.noteAccepted("prompt", first, "capacity-ref-1");
	await reconciliation.noteTransition("prompt", first, { type: "agent_end" });
	const TERMINAL_CAPACITY = 512;
	for (let index = 2; index <= TERMINAL_CAPACITY + 1; index++) {
		const correlation = { commandId: `capacity-command-${index}`, turnId: `capacity-turn-${index}` };
		reconciliation.admit("prompt", `capacity-ref-${index}`);
		await reconciliation.noteAccepted("prompt", correlation, `capacity-ref-${index}`);
		await reconciliation.noteTransition("prompt", correlation, {
			type: "agent_end",
			content: { version: 1, type: "text", text: "completed", byteLength: 9, truncated: false },
		});
	}
	expect(reconciliation.lookup("prompt", { clientRef: "capacity-ref-1" })).toEqual({
		status: "unknown",
		receiptState: "unknown",
	});
	expect(() => reconciliation.admit("prompt", "capacity-ref-1")).not.toThrow();
	const retained = {
		commandId: `capacity-command-${TERMINAL_CAPACITY + 1}`,
		turnId: `capacity-turn-${TERMINAL_CAPACITY + 1}`,
	};
	expect(reconciliation.lookup("prompt", retained)).toMatchObject({ status: "terminal_ok" });
});

describe("SessionSdkSessionRuntime", () => {
	test("has no notification adapter or native notification import edge", async () => {
		const source = await readFile(new URL("./session-runtime.ts", import.meta.url), "utf8");
		expect(source).not.toContain("../bus");
		expect(source).not.toContain("@gajae-code/natives");
		expect(source).not.toContain("NotificationServer");
	});

	test("hosts control, replay, and reverse frames with notifications disabled", async () => {
		const transport = memoryTransport();
		const runtime = new SessionSdkSessionRuntime({
			transport,
			eventRevision: () => 7,
			control: async (_connectionId, frame) => ({ id: frame.id, ok: true, result: { operation: frame.operation } }),
			query: async (_connectionId, frame) => ({ id: frame.id, ok: true, result: { query: frame.query } }),
		});
		await runtime.start();
		runtime.emitEvent({ kind: "session_ready", sessionId: transport.sessionId });
		transport.feed("client", {
			type: "event_replay",
			id: "replay",
			sinceGeneration: runtime.generation,
			sinceSeq: 0,
		});
		transport.feed("client", {
			type: "control_request",
			id: "control",
			operation: "runtime.capabilities",
			input: {},
		});
		transport.feed("client", { type: "query_request", id: "query", query: "Q18", input: {} });
		await Bun.sleep(0);
		expect(transport.broadcasts).toContainEqual(expect.objectContaining({ kind: "session_ready", revision: 7 }));
		expect(transport.sent).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "event_replay_result", id: "replay", ok: true }),
				expect.objectContaining({ type: "control_response", id: "control", ok: true }),
				expect.objectContaining({ type: "query_response", id: "query", ok: true }),
			]),
		);
		await runtime.stop();
	});
	test("SDK-only host publishes one replayable bash_folded frame per fold and drops the subscription on shutdown", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-bash-folded-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: async () => {},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		createSdkSessionRuntimeExtension(api, { agentDir: cwd, createTransport: async () => transport });
		const listeners = new Set<(event: { jobId: string; generation: string; reason: string }) => void>();
		const ctx = {
			...extensionContext(transport.sessionId, cwd),
			onJobFold: (listener: (event: { jobId: string; generation: string; reason: string }) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		} as unknown as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			expect(listeners.size).toBe(1);
			for (const listener of listeners) listener({ jobId: "bg_7", generation: "bg_7:1", reason: "steer" });
			transport.feed("client", { type: "event_replay", id: "fold-replay", sinceSeq: 0 });
			await Bun.sleep(0);
			const replay = transport.sent.find(
				frame => frame.type === "event_replay_result" && frame.id === "fold-replay",
			) as { events?: Array<{ kind?: unknown; payload?: Record<string, unknown> }> } | undefined;
			const folded = replay?.events?.filter(event => event.kind === "bash_folded") ?? [];
			expect(folded).toEqual([
				expect.objectContaining({
					kind: "bash_folded",
					payload: {
						type: "bash_folded",
						sessionId: transport.sessionId,
						jobId: "bg_7",
						generation: "bg_7:1",
						reason: "steer",
					},
				}),
			]);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
		}
		expect(listeners.size).toBe(0);
	});

	test("SDK-only host logs a bash_folded publication failure and keeps the fold replayable", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-bash-folded-fail-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: async () => {},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const broadcastFrame = transport.broadcastFrame?.bind(transport);
		let failNextBroadcast = false;
		transport.broadcastFrame = frame => {
			if (failNextBroadcast && frame.kind === "bash_folded") {
				failNextBroadcast = false;
				throw new Error("broadcast socket closed");
			}
			broadcastFrame?.(frame);
		};
		createSdkSessionRuntimeExtension(api, { agentDir: cwd, createTransport: async () => transport });
		const listeners = new Set<(event: { jobId: string; generation: string; reason: string }) => void>();
		const ctx = {
			...extensionContext(transport.sessionId, cwd),
			onJobFold: (listener: (event: { jobId: string; generation: string; reason: string }) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		} as unknown as ExtensionContext;
		const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
		const warn = spyOn(logger, "warn").mockImplementation((message, data) => {
			warnings.push({ message: String(message), data: data as Record<string, unknown> | undefined });
		});
		try {
			await handlers.get("session_start")?.({}, ctx);
			failNextBroadcast = true;
			// The listener call must not throw back into the manager: publication failure is evidence, not a fold error.
			for (const listener of listeners) listener({ jobId: "bg_9", generation: "bg_9:1", reason: "chord" });
			expect(warnings.filter(entry => entry.message === "sdk: bash_folded publication failed")).toEqual([
				expect.objectContaining({
					data: expect.objectContaining({ jobId: "bg_9", reason: "chord", error: "broadcast socket closed" }),
				}),
			]);
			// The frame was appended to the ring before the broadcast failed, so it still replays.
			transport.feed("client", { type: "event_replay", id: "fold-replay-fail", sinceSeq: 0 });
			await Bun.sleep(0);
			const replay = transport.sent.find(
				frame => frame.type === "event_replay_result" && frame.id === "fold-replay-fail",
			) as { events?: Array<{ kind?: unknown; payload?: Record<string, unknown> }> } | undefined;
			expect(replay?.events?.filter(event => event.kind === "bash_folded")).toEqual([
				expect.objectContaining({ payload: expect.objectContaining({ jobId: "bg_9", reason: "chord" }) }),
			]);
		} finally {
			warn.mockRestore();
			await handlers.get("session_shutdown")?.({}, ctx);
		}
	});

	test("SDK-only host admits, replays, and conflicts terminal abort requests durably", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-abort-"));
		const operatorCapability = "runtime-terminal-abort-capability";
		setBrokerRuntimeAbortCapabilityForTest(operatorCapability);
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: async (_content: string, options: { onPreflightAcceptCommit?: () => Promise<void> }) => {
				await options?.onPreflightAcceptCommit?.();
				await neverSettlingPromise();
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		let activeHandle: string | undefined = "exact-run-handle";
		let activeEpoch: number | undefined = 7;
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			onSdkRequest: undefined,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => activeEpoch,
				getActivePromptHandle: () => activeHandle,
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return {
						status: "settled",
						terminalScope: {
							abortedAttemptEpoch: activeEpoch,
							lineageIdHash: "runtime-test-lineage",
						},
					};
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const waitForFrame = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id)) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for control frame ${id}`);
					await Bun.sleep(20);
				}
			};
			const request = {
				type: "control_request",
				id: "terminal-abort-1",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "terminal-key-1",
			} as SdkFrame;
			transport.feed("client", request);
			await waitForFrame("terminal-abort-1");
			// The steering snapshot seam is captured at ADMISSION (before the
			// durable transaction and settlement) — mirrors the production
			// wiring in session.ts (review thread P1).
			expect(captureCalls).toBeGreaterThanOrEqual(1);
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
			expect(transport.sent).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "control_response",
						id: "terminal-abort-1",
						ok: true,
						result: expect.objectContaining({ turn: "stopped" }),
					}),
				]),
			);

			transport.feed("client", { ...request, id: "terminal-abort-replay" });
			await waitForFrame("terminal-abort-replay");
			// An in-memory dispatch-cache replay short-circuits before the
			// surface: terminalAbort never runs, so no snapshot is captured and
			// nothing to discard (the durable-replay discard is covered by the
			// seeded-row test below).
			expect(seamCalls).toHaveLength(1);
			expect(transport.sent).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "control_response",
						id: "terminal-abort-replay",
						ok: true,
					}),
				]),
			);

			transport.feed("client", {
				...request,
				id: "terminal-abort-conflict",
				input: { mode: "terminal", scope: "owned" },
			});
			await waitForFrame("terminal-abort-conflict");
			expect(seamCalls).toHaveLength(1);
			expect(transport.sent).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "control_response",
						id: "terminal-abort-conflict",
						ok: false,
						error: expect.objectContaining({ code: "idempotency_conflict" }),
					}),
				]),
			);

			activeHandle = undefined;
			activeEpoch = undefined;
			const idleRequest = { ...request, id: "terminal-abort-idle", idempotencyKey: "terminal-idle-key" };
			transport.feed("client", idleRequest);
			await waitForFrame("terminal-abort-idle");
			expect(seamCalls).toHaveLength(1);
			activeHandle = "later-run-handle";
			activeEpoch = 8;
			transport.feed("client", { ...idleRequest, id: "terminal-abort-idle-replay" });
			await waitForFrame("terminal-abort-idle-replay");
			expect(seamCalls).toHaveLength(1);
			expect(transport.sent).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "control_response",
						id: "terminal-abort-idle-replay",
						ok: true,
						result: expect.objectContaining({ turn: "no_active_turn" }),
					}),
				]),
			);

			// A separately connected, explicitly confirmed local operator may stop
			// the active turn and its exact owned work without weakening ordinary
			// connection ownership checks.
			transport.feed("local-operator", {
				type: "control_request",
				id: "terminal-operator-abort",
				operation: "turn.abort",
				input: {
					mode: "terminal",
					scope: "owned",
					operator: true,
					[BROKER_RUNTIME_ABORT_CAPABILITY_FIELD]: operatorCapability,
				},
				confirm: true,
				idempotencyKey: "terminal-operator-key",
			} as SdkFrame);
			await waitForFrame("terminal-operator-abort");
			expect(seamCalls).toEqual([
				{ handle: "exact-run-handle", scope: "turn" },
				{ handle: "later-run-handle", scope: "owned" },
			]);
			expect(transport.sent.find(frame => frame.id === "terminal-operator-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped", ownedWork: "stopped" }),
			});
			const operatorKeyHash = createHash("sha256").update("terminal-operator-key").digest("hex");
			const deliveryDeadline = Date.now() + 15_000;
			while (
				reconciliationStore.snapshotTerminalScopes().find(record => record.idempotencyKeyHash === operatorKeyHash)
					?.responseState !== "sent"
			) {
				if (Date.now() > deliveryDeadline) throw new Error("Timed out waiting for operator delivery receipt");
				await Bun.sleep(20);
			}
		} finally {
			setBrokerRuntimeAbortCapabilityForTest(undefined);
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host correlates a steering-queued prompt when the unwind promotes it to a run", async () => {
		// Review thread P2: a prompt accepted while the session reports busy
		// (finished prompt unwinding) is queued as steering with NO pending entry
		// at accept; when the unwind continuation actually promotes it to its own
		// run, the promotion hook must create the ownership correlation so the
		// submitting connection can terminal-abort that turn.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-unwind-promoted-"));
		let idle = true;
		let promoted: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
		const queuedDispositions: boolean[] = [];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: (
				_content: string,
				options:
					| {
							onPreflightAccepted?: () => void;
							onPreflightAcceptCommit?: () => void;
							onQueuedPromoted?: (promotion: { startsOwnRun?: boolean; removed?: boolean }) => void;
							queuedAtDispatch?: boolean;
					  }
					| undefined,
			) =>
				Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
					queuedDispositions.push(options?.queuedAtDispatch === true);
					promoted = options?.onQueuedPromoted;
					options?.onPreflightAccepted?.();
					return {};
				}),
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = {
			...extensionContext(transport.sessionId, cwd),
			isIdle: () => idle,
		} as unknown as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			const prompt = (connectionId: string, id: string) =>
				transport.feed(connectionId, {
					type: "control_request",
					id,
					operation: "turn.prompt",
					input: { text: id, images: [] },
				} as SdkFrame);
			const waitResponse = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
					await Bun.sleep(20);
				}
			};
			// A submits while idle and STARTS its run: owner becomes conn-a.
			prompt("conn-a", "unwind-a");
			await waitResponse("unwind-a");
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// B submits while the session still reports busy (unwinding): the prompt
			// is queued as steering and NO pending entry is created at accept.
			idle = false;
			prompt("conn-b", "unwind-b");
			await waitResponse("unwind-b");
			expect(queuedDispositions).toEqual([false, true]);
			expect(promoted).toBeDefined();
			// The unwind continuation promotes the queued steer to its own run: the
			// correlation hook fires before agent_start...
			promoted!({ startsOwnRun: true });
			// ...and B's run starts: ownership transfers to conn-b.
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// B's own terminal abort now stops its turn (previously no_active_turn).
			transport.feed("conn-b", {
				type: "control_request",
				id: "unwind-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "unwind-abort-key",
			} as SdkFrame);
			await waitResponse("unwind-abort");
			expect(transport.sent.find(frame => frame.id === "unwind-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host re-reads the active prompt after an idle reservation wins the race", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-race-active-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: async (_content: string, options: { onPreflightAcceptCommit?: () => Promise<void> }) => {
				await options?.onPreflightAcceptCommit?.();
				await neverSettlingPromise();
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		// The FIRST active-prompt read sees no turn (idle abort request); a
		// prompt then wins the race and every later read sees it active —
		// exactly the window where writeNoEffect awaits the store.
		let promptReads = 0;
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => (promptReads++ === 0 ? undefined : 7),
				getActivePromptHandle: () => (promptReads === 0 ? undefined : "won-race-handle"),
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return {
						status: "settled",
						terminalScope: { scopeId: "scope-race", abortedAttemptEpoch: 7, lineageIdHash: "race-lineage" },
					};
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			transport.feed("client", {
				type: "control_request",
				id: "race-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "race-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "race-abort")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the race abort response");
				await Bun.sleep(20);
			}
			// The prompt that won the race is ACTIVE-terminalized, never reported
			// as no_active_turn, and the durable no-effect reservation was replaced
			// by the stopped marker so a same-key retry replays stopped.
			expect(seamCalls).toEqual([{ handle: "won-race-handle", scope: "turn" }]);
			expect(transport.sent.find(frame => frame.id === "race-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			transport.feed("client", {
				type: "control_request",
				id: "race-replay",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "race-key",
			} as SdkFrame);
			const replayDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "race-replay")) {
				if (Date.now() > replayDeadline) throw new Error("Timed out waiting for the race replay");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "race-replay")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(seamCalls).toHaveLength(1);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only operator abort never adopts a turn that starts after idle admission", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-operator-idle-race-"));
		const capability = "operator-idle-race-capability";
		setBrokerRuntimeAbortCapabilityForTest(capability);
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: string[] = [];
		let promptReads = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => (promptReads++ === 0 ? undefined : 9),
				getActivePromptHandle: () => (promptReads === 0 ? undefined : "successor-handle"),
				getActivePromptOwnerConnectionId: () => "successor-owner",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async handle => {
					seamCalls.push(handle);
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			transport.feed("local-operator", {
				type: "control_request",
				id: "operator-idle-race",
				operation: "turn.abort",
				input: {
					mode: "terminal",
					operator: true,
					[BROKER_RUNTIME_ABORT_CAPABILITY_FIELD]: capability,
				},
				confirm: true,
				idempotencyKey: "operator-idle-race-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "operator-idle-race")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for operator idle-race response");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "operator-idle-race")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn", terminal: "terminal_no_effect" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			setBrokerRuntimeAbortCapabilityForTest(undefined);
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host re-reads the active prompt AND its owner after an owner-mismatch reservation race", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-owner-race-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		// Connection A owns the active prompt when the abort is read; while the
		// no-effect reservation awaits the store, A's prompt finishes and
		// connection B's pending prompt wins the race. The aborting connection
		// (B) must re-read handle, epoch, AND owner and fall through to ACTIVE
		// terminalization instead of returning no_active_turn and leaving a
		// durable reservation that blocks B's own running prompt forever
		// (review thread P1).
		let reads = 0;
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getActivePromptHandle: () => {
					reads += 1;
					return reads === 1 ? "owner-a-handle" : "winner-b-handle";
				},
				getTerminalTurnEpoch: () => (reads === 1 ? 1 : 2),
				getActivePromptOwnerConnectionId: () => (reads === 1 ? "conn-a" : "conn-b"),
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return {
						status: "settled",
						terminalScope: {
							scopeId: "scope-owner-race",
							abortedAttemptEpoch: 2,
							lineageIdHash: "owner-lineage",
						},
					};
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			// The aborting connection is "conn-b"; the first owner read is
			// "conn-a", so this enters the owner-mismatch branch.
			transport.feed("conn-b", {
				type: "control_request",
				id: "owner-race-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "owner-race-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "owner-race-abort")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the owner race abort response");
				await Bun.sleep(20);
			}
			// B's now-owned prompt is ACTIVE-terminalized with B's run handle,
			// never reported no_active_turn.
			expect(seamCalls).toEqual([{ handle: "winner-b-handle", scope: "turn" }]);
			expect(transport.sent.find(frame => frame.id === "owner-race-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			// The durable no-effect reservation was replaced by the stopped
			// marker, so a same-key retry replays stopped instead of
			// no_active_turn.
			transport.feed("conn-b", {
				type: "control_request",
				id: "owner-race-replay",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "owner-race-key",
			} as SdkFrame);
			const replayDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "owner-race-replay")) {
				if (Date.now() > replayDeadline) throw new Error("Timed out waiting for the owner race replay");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "owner-race-replay")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(seamCalls).toHaveLength(1);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host records the OBSERVED agent_end publication on the terminal stopped row", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-published-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (_handle, _options) => {
					// The aborted run's loop exit publishes the correlated
					// agent_end lifecycle event before settlement returns.
					await handlers.get("agent_end")?.({ type: "agent_end" }, ctx);
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			transport.feed("client", {
				type: "control_request",
				id: "published-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "published-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "published-abort")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the published abort response");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "published-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			// The correlated agent_end was OBSERVED, so the durable row claims
			// terminalPublished (AC 19) — never assumed.
			const scopes = reconciliationStore.snapshotTerminalScopes();
			expect(scopes).toHaveLength(1);
			expect(scopes[0]).toMatchObject({ turnDisposition: "stopped", terminalPublished: true });
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host resolves EVERY concurrent terminal-publication waiter for one aborted turn", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-concurrent-publish-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		let seamCount = 0;
		let captureCalls = 0;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				captureTerminalAbortSteeringSnapshot: () => {
					captureCalls += 1;
					return captureCalls;
				},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					// The turn emits exactly ONE correlated agent_end no matter how
					// many concurrent aborts stop it; both waiters are installed just
					// before their seam call, so fire it once BOTH have landed.
					seamCount += 1;
					if (seamCount === 2) {
						await handlers.get("agent_end")?.({ type: "agent_end" }, ctx);
					}
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const abort = (id: string, idempotencyKey: string) =>
				transport.feed("client", {
					type: "control_request",
					id,
					operation: "turn.abort",
					input: { mode: "terminal" },
					idempotencyKey,
				} as SdkFrame);
			// Two concurrent aborts of the SAME active turn with DISTINCT keys:
			// both are admitted and both await the single agent_end.
			abort("conc-abort-1", "conc-key-1");
			abort("conc-abort-2", "conc-key-2");
			const deadline = Date.now() + 15_000;
			while (
				!transport.sent.some(frame => frame.id === "conc-abort-1" && frame.type === "control_response") ||
				!transport.sent.some(frame => frame.id === "conc-abort-2" && frame.type === "control_response")
			) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the concurrent abort responses");
				await Bun.sleep(20);
			}
			// The onControlResponseDelivery observer writes responseState asynchronously
			// after the transport send; wait for BOTH durable rows to settle before
			// asserting, so the test is not racy on the observer's transactTerminalState
			// microtask drain.
			while (
				reconciliationStore.snapshotTerminalScopes().length < 2 ||
				reconciliationStore.snapshotTerminalScopes().some(scope => scope.responseState !== "sent")
			) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for durable responseState to settle");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "conc-abort-1")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(transport.sent.find(frame => frame.id === "conc-abort-2")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			// BOTH durable rows observed the single publication — a latest-wins
			// single slot would leave one of them terminalPublished:false (review
			// thread P2).
			const scopes = reconciliationStore.snapshotTerminalScopes();
			expect(scopes).toHaveLength(2);
			for (const scope of scopes) {
				expect(scope).toMatchObject({ turnDisposition: "stopped", terminalPublished: true });
				// The stopped result was actually written: the delivery observer
				// matched the response payload hash (which must include the public
				// `ok` field) and advanced the durable state — a shape mismatch
				// would leave responseState pending despite the successful write
				// (review thread P2).
				expect(scope.responseState).toBe("sent");
			}
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("delayed predecessor and maintenance ends cannot resolve a successor publication waiter", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-epoch-isolation-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: async (_content: string, options: { onPreflightAcceptCommit?: () => Promise<void> }) => {
				await options?.onPreflightAcceptCommit?.();
				await neverSettlingPromise();
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		let activeEpoch = 1;
		let activeHandle = "predecessor";
		let abortCalls = 0;
		const abortRelease = Promise.withResolvers<void>();
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => activeEpoch,
				getActivePromptHandle: () => activeHandle,
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async () => {
					abortCalls += 1;
					await abortRelease.promise;
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			transport.feed("client", {
				type: "control_request",
				id: "predecessor-prompt",
				operation: "turn.prompt",
				input: { text: "predecessor" },
			} as SdkFrame);
			while (!transport.sent.some(frame => frame.id === "predecessor-prompt")) await Bun.sleep(10);
			await handlers.get("agent_start")?.({}, ctx); // lifecycle epoch 1
			await handlers.get("agent_end")?.(
				{ type: "agent_end", stopReason: "maintenance", maintenanceOutcome: "completed" },
				ctx,
			);
			transport.feed("client", {
				type: "control_request",
				id: "successor-prompt",
				operation: "turn.prompt",
				input: { text: "successor" },
			} as SdkFrame);
			while (!transport.sent.some(frame => frame.id === "successor-prompt")) await Bun.sleep(10);
			activeEpoch = 2;
			activeHandle = "successor";
			await handlers.get("agent_start")?.({}, ctx); // lifecycle epoch 2
			transport.feed("client", {
				type: "control_request",
				id: "successor-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "successor-abort-key",
			} as SdkFrame);
			while (abortCalls < 1) await Bun.sleep(10);
			await handlers.get("agent_end")?.({ type: "agent_end" }, ctx); // delayed predecessor
			await handlers.get("agent_end")?.(
				{ type: "agent_end", stopReason: "maintenance", maintenanceOutcome: "completed" },
				ctx,
			);
			abortRelease.resolve();
			await Bun.sleep(50);
			expect(transport.sent.some(frame => frame.id === "successor-abort")).toBe(false);
			await handlers.get("agent_end")?.({ type: "agent_end" }, ctx); // successor
			const deadline = Date.now() + 5_000;
			while (!transport.sent.some(frame => frame.id === "successor-abort")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for successor abort response");
				await Bun.sleep(10);
			}
			expect(reconciliationStore.snapshotTerminalScopes()).toContainEqual(
				expect.objectContaining({
					turnContinuationFence: expect.objectContaining({ abortedAttemptEpoch: 2 }),
					terminalPublished: true,
				}),
			);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host never claims terminalPublished without observing the agent_end publication", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-unpublished-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (_handle, _options) => {
					// The worker settles but the lifecycle listener never completes:
					// the durable row must NOT claim the terminal event reached
					// clients (review thread P2).
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			transport.feed("client", {
				type: "control_request",
				id: "unpublished-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "unpublished-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "unpublished-abort")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the unpublished abort response");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "unpublished-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			// No agent_end was observed: the durable stopped row reports
			// terminalPublished:false, the fail-safe direction.
			const scopes = reconciliationStore.snapshotTerminalScopes();
			expect(scopes).toHaveLength(1);
			expect(scopes[0]).toMatchObject({ turnDisposition: "stopped", terminalPublished: false });
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host cancels only the preflights admitted at abort time, never a pipelined successor", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-preflight-snapshot-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			// Hold every prompt preflight open: acceptance is never signalled, so
			// each submission stays pending until the abort (or nothing) settles it.
			// Deferred via Promise.withResolvers per the repository contract.
			sendUserMessage: () => Promise.withResolvers<void>().promise,
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				// No active turn: the abort takes the idle no-effect path, which is
				// where cancelRequesterPreflights runs after the durable reservation.
				getTerminalTurnEpoch: () => undefined,
				getActivePromptHandle: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (_handle, _options) => {
					throw new Error("seam must not be called for an idle abort");
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const prompt = (id: string) =>
				transport.feed("conn-a", {
					type: "control_request",
					id,
					operation: "turn.prompt",
					input: { text: `hold-${id}`, images: [] },
				} as SdkFrame);
			prompt("pre-1");
			// Let the serialized (ordered) turn.prompt work register its preflight
			// callback, so the abort's admission snapshot below sees it.
			await Bun.sleep(0);
			transport.feed("conn-a", {
				type: "control_request",
				id: "pre-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "pre-snapshot-key",
			} as SdkFrame);
			// A successor prompt pipelined by the SAME connection while the abort
			// awaits the reconciliation transaction: its preflight lands in the
			// live bucket AFTER the abort's admission snapshot and must survive.
			prompt("pre-2");
			const deadline = Date.now() + 15_000;
			while (
				!transport.sent.some(frame => frame.id === "pre-abort" && frame.type === "control_response") ||
				!transport.sent.some(frame => frame.id === "pre-1" && frame.type === "control_response")
			) {
				if (Date.now() > deadline)
					throw new Error("Timed out waiting for the abort and admitted-preflight responses");
				await Bun.sleep(20);
			}
			// The admitted preflight is cancelled by the abort.
			expect(transport.sent.find(frame => frame.id === "pre-1")).toMatchObject({
				ok: false,
				error: expect.objectContaining({ code: "busy" }),
			});
			expect(transport.sent.find(frame => frame.id === "pre-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			// The successor preflight was NOT part of the abort's snapshot: it is
			// neither cancelled nor failed, so no control response is emitted for it.
			expect(transport.sent.some(frame => frame.id === "pre-2" && frame.type === "control_response")).toBe(false);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host tracks ownership for skill-invoked turns so a foreign abort cannot stop them", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-skill-owner-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = {
			...extensionContext(transport.sessionId, cwd),
			// Declare the binding so the surface policy installs skill.invoke, and
			// accept the preflight so the skill turn is ADMITTED under conn-a.
			sdkBindings: () => ["invokeSkill"],
			invokeSkill: async (_name: string, _args: unknown, options: { onPreflightAccepted?: () => void }) => {
				options.onPreflightAccepted?.();
				return { accepted: true };
			},
		} as unknown as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			// Client A starts a skill: skill.invoke runs a real prompt through
			// submit(), so the ACCEPTING connection must own the active turn.
			transport.feed("conn-a", {
				type: "control_request",
				id: "skill-a",
				operation: "skill.invoke",
				input: { name: "some-skill", args: "" },
			} as SdkFrame);
			const skillDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "skill-a" && frame.type === "control_response")) {
				if (Date.now() > skillDeadline) throw new Error("Timed out waiting for the skill acceptance");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "skill-a")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ accepted: true }),
			});
			// Ownership is associated when the accepted submission STARTS its run
			// (agent_start), not at acceptance: fire the lifecycle event so the
			// skill run is owned by conn-a (review thread P1).
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// Client B's terminal abort must NOT stop A's skill run: owner is A.
			transport.feed("conn-b", {
				type: "control_request",
				id: "skill-abort-b",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "skill-abort-b-key",
			} as SdkFrame);
			const abortDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "skill-abort-b" && frame.type === "control_response")) {
				if (Date.now() > abortDeadline) throw new Error("Timed out waiting for the foreign abort response");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "skill-abort-b")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
			// A's own terminal abort still stops its skill run.
			transport.feed("conn-a", {
				type: "control_request",
				id: "skill-abort-a",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "skill-abort-a-key",
			} as SdkFrame);
			const ownDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "skill-abort-a" && frame.type === "control_response")) {
				if (Date.now() > ownDeadline) throw new Error("Timed out waiting for the owner abort response");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "skill-abort-a")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host does not transfer ownership to a queued submission until its run starts", async () => {
		// While client A's prompt is streaming, client B's prompt is accepted as
		// queued steering/follow-up: the owner must STAY with A until B's run
		// actually starts (agent_start), or B could terminal-abort A's running
		// turn while A is refused (review thread P1).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-queued-owner-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: async (
				_content: string,
				options: { onPreflightAccepted?: () => void; onPreflightAcceptCommit?: () => void } | undefined,
			) => {
				await options?.onPreflightAcceptCommit?.();
				options?.onPreflightAccepted?.();
				// Production-faithful: an accepted run stays in-flight for the whole
				// test; sendUserMessage resolution (turn completion) never precedes
				// agent_start (#4668 success-retirement).
				await neverSettlingPromise();
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const prompt = (connectionId: string, id: string) =>
				transport.feed(connectionId, {
					type: "control_request",
					id,
					operation: "turn.prompt",
					input: { text: id, images: [] },
				} as SdkFrame);
			const waitResponse = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
					await Bun.sleep(20);
				}
			};
			// A submits and STARTS its run: owner becomes conn-a.
			prompt("conn-a", "prompt-a");
			await waitResponse("prompt-a");
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// B submits and is ACCEPTED, but only queued (agent_start not fired).
			prompt("conn-b", "prompt-b");
			await waitResponse("prompt-b");
			expect(transport.sent.find(frame => frame.id === "prompt-b")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ accepted: true }),
			});
			// B's abort must NOT stop A's streaming turn: the owner is still A.
			transport.feed("conn-b", {
				type: "control_request",
				id: "queued-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "queued-abort-key",
			} as SdkFrame);
			await waitResponse("queued-abort");
			expect(transport.sent.find(frame => frame.id === "queued-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
			// B's run now STARTS: ownership transfers to conn-b, and B's own abort
			// stops it.
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			transport.feed("conn-b", {
				type: "control_request",
				id: "queued-abort-2",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "queued-abort-2-key",
			} as SdkFrame);
			await waitResponse("queued-abort-2");
			expect(transport.sent.find(frame => frame.id === "queued-abort-2")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host retires steering-queued submissions so a later agent-initiated turn is not mis-owned", async () => {
		// While client A's prompt streams, client B's plain prompt is accepted as
		// queued STEERING and consumed inside the current run — it emits no
		// agent_start, so its pending entry must be retired. Otherwise the next
		// agent-initiated monitor/cron turn's agent_start would shift the stale
		// entry and let B terminal-abort a turn it did not submit (review thread
		// P1).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stale-owner-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: (
				_content: string,
				options: { onPreflightAccepted?: () => void; onPreflightAcceptCommit?: () => void } | undefined,
			) =>
				Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
					options?.onPreflightAccepted?.();
					return {};
				}),
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		let idle = true;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = {
			...extensionContext(transport.sessionId, cwd),
			isIdle: () => idle,
		} as unknown as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			const prompt = (connectionId: string, id: string) =>
				transport.feed(connectionId, {
					type: "control_request",
					id,
					operation: "turn.prompt",
					input: { text: id, images: [] },
				} as SdkFrame);
			const waitResponse = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
					await Bun.sleep(20);
				}
			};
			// A submits while idle and STARTS its run: owner becomes conn-a.
			prompt("conn-a", "stale-a");
			await waitResponse("stale-a");
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// A's turn is now streaming: B's plain prompt is queued as steering and
			// consumed in-run — its pending entry must NOT be created.
			idle = false;
			prompt("conn-b", "stale-b");
			await waitResponse("stale-b");
			// A later AGENT-INITIATED turn starts: the pending queue is empty, so
			// the predecessor's conn-a owner is cleared and no SDK client owns it.
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// A's stale owner must NOT stop the agent-initiated turn.
			transport.feed("conn-a", {
				type: "control_request",
				id: "stale-owner-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "stale-owner-abort-key",
			} as SdkFrame);
			await waitResponse("stale-owner-abort");
			expect(transport.sent.find(frame => frame.id === "stale-owner-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host retires a follow-up queued while streaming so a later agent-initiated turn is not mis-owned", async () => {
		// While client A's prompt streams, client B's follow-up is consumed by the
		// active loop (agent-loop.ts getFollowUpMessages) with NO new agent_start.
		// Its pending entry must not survive to a later agent-initiated turn, or
		// B could terminal-abort an unrelated monitor/cron turn (review thread
		// P1).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stale-followup-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: (
				_content: string,
				options: { onPreflightAccepted?: () => void; onPreflightAcceptCommit?: () => void } | undefined,
			) =>
				Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
					options?.onPreflightAccepted?.();
					return {};
				}),
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		let idle = true;
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = {
			...extensionContext(transport.sessionId, cwd),
			isIdle: () => idle,
		} as unknown as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			const waitResponse = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
					await Bun.sleep(20);
				}
			};
			// A starts its run while idle: owner becomes conn-a.
			transport.feed("conn-a", {
				type: "control_request",
				id: "fu-a",
				operation: "turn.prompt",
				input: { text: "a", images: [] },
			} as SdkFrame);
			await waitResponse("fu-a");
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// A streams: B's follow-up is consumed in-run -> NO pending entry.
			idle = false;
			transport.feed("conn-b", {
				type: "control_request",
				id: "fu-b",
				operation: "turn.follow_up",
				input: { text: "follow up b" },
			} as SdkFrame);
			await waitResponse("fu-b");
			// A later agent-initiated turn starts: the pending queue is empty, so
			// B's stale connection is never associated as owner.
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			transport.feed("conn-b", {
				type: "control_request",
				id: "stale-followup-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "stale-followup-abort-key",
			} as SdkFrame);
			await waitResponse("stale-followup-abort");
			expect(transport.sent.find(frame => frame.id === "stale-followup-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("agent-initiated successor activity cannot renew a stale predecessor deadline", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stale-deadline-owner-"));
		try {
			const harness = await invocationHarness("stale-deadline-owner", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 25 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const prompt = await harness.control("turn.prompt", { text: "predecessor" });
			expect(prompt.ok).toBe(true);
			const ids = { commandId: prompt.result?.commandId, turnId: prompt.result?.turnId };
			await harness.emit("agent_start");
			// Empty drain represents an agent-initiated successor with no SDK owner.
			await harness.emit("agent_start");
			for (let i = 0; i < 3; i += 1) {
				await harness.emit("tool_execution_start");
				await Bun.sleep(15);
			}
			expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host retires an accepted-then-failed submission so a later agent-initiated turn is not mis-owned", async () => {
		// An idle submission is accepted (pending entry pushed) and then REJECTS
		// before agent_start (e.g. the busy retry expires). The failed entry must
		// be retired — a later agent-initiated monitor/cron turn must not inherit
		// the failed submission's connection as owner (review thread P1).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-failed-owner-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: (
				content: string | { text: string }[],
				options: { onPreflightAccepted?: () => void; onPreflightAcceptCommit?: () => void } | undefined,
			) => {
				const commit = Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
					options?.onPreflightAccepted?.();
					return {};
				});
				const text = typeof content === "string" ? content : (content[0]?.text ?? "");
				// The "fail-b" submission is accepted, then its run REJECTS.
				if (text === "fail-b")
					return commit.then(() => {
						throw new Error("provider failed after acceptance");
					});
				return commit;
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const prompt = (connectionId: string, id: string, text: string) =>
				transport.feed(connectionId, {
					type: "control_request",
					id,
					operation: "turn.prompt",
					input: { text, images: [] },
				} as SdkFrame);
			const waitResponse = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
					await Bun.sleep(20);
				}
			};
			// A submits while idle and STARTS its run: owner becomes conn-a.
			prompt("conn-a", "ok-a", "ok-a");
			await waitResponse("ok-a");
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			// B submits while idle (entry pushed), then its run REJECTS.
			transport.feed("conn-b", {
				type: "control_request",
				id: "fail-b",
				operation: "turn.prompt",
				input: { text: "fail-b", images: [], clientRef: "fail-b-ref" },
			} as SdkFrame);
			await waitResponse("fail-b");
			expect(transport.sent.find(frame => frame.id === "fail-b")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ accepted: true }),
			});

			// B's accepted receipt is redacted to {} once its submission rejects,
			// so select its record by the stable clientRef instead.
			// Let the async rejection settle and retire B's pending entry.
			await Bun.sleep(50);
			// The rejected submission must TERMINALIZE as failed (#4668 review
			// P1): agent_failed alone is diagnostic-only, so the settlement also
			// writes agent_end. Before that fix B stayed accepted forever.
			{
				const ids = { clientRef: "fail-b-ref" };
				transport.feed("conn-b", {
					type: "query_request",
					id: "fail-b-status",
					query: "turn.prompt_status",
					input: { kind: "prompt", ...ids },
				} as SdkFrame);
				// waitResponse polls control_response only; queries get query_response.
				const statusDeadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === "fail-b-status")) {
					if (Date.now() > statusDeadline) throw new Error("Timed out waiting for fail-b-status");
					await Bun.sleep(20);
				}
				expect(transport.sent.find(frame => frame.id === "fail-b-status")).toMatchObject({
					ok: true,
					result: expect.objectContaining({ status: "failed" }),
				});
			}
			// A later agent-initiated turn starts: the pending queue is empty, so
			// B's failed submission is never associated as owner.
			await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			transport.feed("conn-b", {
				type: "control_request",
				id: "failed-owner-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "failed-owner-abort-key",
			} as SdkFrame);
			await waitResponse("failed-owner-abort");
			expect(transport.sent.find(frame => frame.id === "failed-owner-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host refuses terminal aborts of UNOWNED agent-initiated turns", async () => {
		// An agent-initiated turn (monitor/cron follow-up) has NO accepting SDK
		// connection: the active handle exists but the owner is undefined, so
		// every client must be refused — never authorized by an absent or stale
		// owner (review thread P1).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-unowned-turn-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				// Active turn exists, but NO owner is recorded (no prompt/skill was
				// accepted by any SDK connection) — the seam getter is absent so the
				// runtime-tracked owner (undefined) is consulted.
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "agent-initiated-handle",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			transport.feed("client", {
				type: "control_request",
				id: "unowned-abort",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "unowned-abort-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "unowned-abort" && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the unowned abort response");
				await Bun.sleep(20);
			}
			// No owner: the abort is refused without touching the seam.
			expect(transport.sent.find(frame => frame.id === "unowned-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn", terminal: "terminal_no_effect" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host replays a no_effect_reserved row as uncertainty, never a fabricated no_active_turn", async () => {
		// A transitional no-effect reservation (the abort may still transition to
		// active while the reservation is awaited) must never replay as a
		// definitive no_active_turn: a duplicate in that window would otherwise
		// get no_active_turn while the original stops the prompt (review thread
		// P2).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-reserved-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => undefined,
				getActivePromptHandle: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async () => ({ status: "settled" }),
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const keyHash = createHash("sha256").update("reserved-key").digest("hex");
			const inputHash = createHash("sha256")
				.update(JSON.stringify({ mode: "terminal", scope: "turn" }))
				.digest("hex");
			// Seed a mid-flight reserved reservation directly (the abort's own
			// writeNoEffect produces this disposition while the recheck is
			// pending).
			await reconciliationStore.transactTerminalState(state => ({
				scopes: [
					{
						selection: "turn",
						idempotencyKeyHash: keyHash,
						idempotencyInputHash: inputHash,
						turnDisposition: "no_effect_reserved",
						terminalPublished: false,
						ownedWorkDisposition: "not_requested",
						automaticDeliveryDisposition: "enabled",
						resumeOnOwnedCompletion: true,
						turnContinuationFence: {
							state: "retained",
							abortedAttemptEpoch: 0,
							blockedContinuationIds: [],
							predecessorTombstones: [],
							ownedCompletionPolicy: "enabled",
						},
						responseState: "pending",
						responsePayloadHash: inputHash,
						acceptedAt: Date.now(),
					},
					...state.scopes,
				],
				keys: state.keys,
			}));
			transport.feed("client", {
				type: "control_request",
				id: "reserved-replay",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "reserved-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "reserved-replay" && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the reserved-row replay");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "reserved-replay")).toMatchObject({
				ok: true,
				result: expect.objectContaining({
					turn: "uncertain",
					reason: "reservation_in_flight",
					replay: expect.objectContaining({ responseState: "pending" }),
				}),
			});
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host does not advance a pending marker's response state for a mismatched replayed payload", async () => {
		// When >256 concurrent requests evict an in-flight abort from the dispatch
		// cache, a same-key retry replays the PENDING marker as pending_replay. The
		// delivery observer must NOT mark the original marker sent for the
		// retry's uncertainty response: it only advances when the written
		// response's payload matches the row's stored hash (review thread P2).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-pending-state-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => undefined,
				getActivePromptHandle: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async () => ({ status: "settled" }),
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const keyHash = createHash("sha256").update("pending-key").digest("hex");
			const inputHash = createHash("sha256")
				.update(JSON.stringify({ mode: "terminal", scope: "turn" }))
				.digest("hex");
			// Seed the ORIGINAL in-flight marker: pending, with the input-hash
			// placeholder as its payload hash.
			await reconciliationStore.transactTerminalState(state => ({
				scopes: [
					{
						selection: "turn",
						idempotencyKeyHash: keyHash,
						idempotencyInputHash: inputHash,
						turnDisposition: "pending",
						terminalPublished: false,
						ownedWorkDisposition: "not_requested",
						automaticDeliveryDisposition: "enabled",
						resumeOnOwnedCompletion: true,
						turnContinuationFence: {
							state: "retained",
							abortedAttemptEpoch: 0,
							blockedContinuationIds: [],
							predecessorTombstones: [],
							ownedCompletionPolicy: "enabled",
						},
						responseState: "pending",
						responsePayloadHash: inputHash,
						acceptedAt: Date.now(),
					},
					...state.scopes,
				],
				keys: state.keys,
			}));
			transport.feed("client", {
				type: "control_request",
				id: "pending-replay",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "pending-key",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "pending-replay" && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the pending-row replay");
				await Bun.sleep(20);
			}
			// The retry replays the pending marker as pending_replay...
			expect(transport.sent.find(frame => frame.id === "pending-replay")).toMatchObject({
				ok: true,
				result: expect.objectContaining({
					turn: "uncertain",
					reason: "replay_pending",
					replay: expect.objectContaining({ responseState: "pending" }),
				}),
			});
			// ...but the ORIGINAL marker's durable state must NOT be advanced by
			// the retry's mismatched payload.
			await Bun.sleep(50);
			expect(reconciliationStore.snapshotTerminalScopes()[0]!.responseState).toBe("pending");
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host replays an EVICTED no-effect reservation as no_active_turn, not uncertain", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-evicted-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const admissions = admissionBarrier(9);
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			onFrameAdmitted: admissions.onFrameAdmitted,
			terminalAbortSeams: {
				maxDurableTerminalReservationsForTests: 8,
				getReconciliationStore: () => reconciliationStore,
				// No active turn: every idle abort reserves a no-effect row.
				getTerminalTurnEpoch: () => undefined,
				getActivePromptHandle: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const idleAbort = (id: string, idempotencyKey: string) =>
				transport.feed("client", {
					type: "control_request",
					id,
					operation: "turn.abort",
					input: { mode: "terminal" },
					idempotencyKey,
				} as SdkFrame);
			// Fill the completed-scope bound (256) and overflow once so the FIRST
			// no-effect row is evicted into a tombstone that preserves its
			// turnDisposition (review thread P2).
			for (let index = 0; index < 9; index++) idleAbort(`idle-${index}`, `evict-key-${index}`);
			await admissions.ready;
			await reconciliationStore.drain?.();
			expect(seamCalls).toHaveLength(0);
			// The overflowed reservation now exists only as a tombstone; replaying
			// its key must return the original no_active_turn/terminal_no_effect
			// result deterministically, never a fabricated uncertainty.
			transport.feed("client", {
				type: "control_request",
				id: "evicted-replay",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "evict-key-0",
			} as SdkFrame);
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "evicted-replay")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the evicted-key replay");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "evicted-replay")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn", terminal: "terminal_no_effect" }),
			});
			// A truly fresh key still reports no_active_turn with no seam call.
			transport.feed("client", {
				type: "control_request",
				id: "fresh-idle",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "fresh-key",
			} as SdkFrame);
			while (!transport.sent.some(frame => frame.id === "fresh-idle")) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for the fresh-key idle abort");
				await Bun.sleep(20);
			}
			expect(transport.sent.find(frame => frame.id === "fresh-idle")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn", terminal: "terminal_no_effect" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host rejects a same-key different-scope race atomically inside the durable transaction", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-race-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			const race = {
				type: "control_request",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "race-key",
			} as SdkFrame;
			// Both requests pass the earlier snapshot check before either durable
			// row lands; the serialized transaction must reject the second
			// (different scope) atomically instead of appending a duplicate-key
			// row that would make later replay of the first ambiguous (review
			// thread P2).
			transport.feed("client", { ...race, id: "race-turn" });
			transport.feed("client", { ...race, id: "race-owned", input: { mode: "terminal", scope: "owned" } });
			// The winner's stopped response awaits the bounded agent_end
			// publication observation, so await both responses instead of a fixed
			// sleep (review thread P2).
			const raceDeadline = Date.now() + 15_000;
			while (
				!transport.sent.some(frame => frame.id === "race-turn" && frame.type === "control_response") ||
				!transport.sent.some(frame => frame.id === "race-owned" && frame.type === "control_response")
			) {
				if (Date.now() > raceDeadline)
					throw new Error("Timed out waiting for the same-key different-scope race responses");
				await Bun.sleep(20);
			}
			const turnResponse = transport.sent.find(frame => frame.id === "race-turn");
			const ownedResponse = transport.sent.find(frame => frame.id === "race-owned");
			expect(turnResponse).toMatchObject({ type: "control_response", ok: true });
			expect(ownedResponse).toMatchObject({
				type: "control_response",
				ok: false,
				error: expect.objectContaining({ code: "idempotency_conflict" }),
			});
			// Only the admitted request reached the session seam; the loser never
			// touched the run.
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
			// Exactly ONE durable row exists for the key: the winner's.
			expect(reconciliationStore.snapshotTerminalScopes().filter(s => s.idempotencyKeyHash).length).toBe(1);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host cancels exact owned jobs before reporting stopped_owned", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-owned-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		resetTerminalAbortRegistriesForTests();
		AsyncJobManager.setInstance(manager);
		AsyncJobManager.registerForEndpoint("owned-ep", manager);
		const gate = Promise.withResolvers<string>();
		let jobId: string | undefined;
		let registration: TurnRegistrationKey | undefined;
		try {
			jobId = manager.register("bash", "owned job", () => gate.promise);
			const generation = manager.getJob(jobId)?.generation;
			expect(generation).toBeTypeOf("string");
			registration = {
				endpointId: "owned-ep",
				endpointGeneration: 1,
				lineageIdHash: "sdk-owned-lineage",
				promptAttemptEpoch: 7,
				jobId,
				jobGeneration: generation as string,
			};
			registerOwnedRegistration(registration as never, { isJobTerminal: () => false });
			const seamCalls: Array<{ handle: string; scope: string }> = [];
			createSdkSessionRuntimeExtension(api, {
				agentDir: cwd,
				createTransport: async () => transport,
				terminalAbortSeams: {
					getReconciliationStore: () => reconciliationStore,
					getTerminalTurnEpoch: () => 7,
					getActivePromptHandle: () => "exact-run-handle",
					getActivePromptOwnerConnectionId: () => "client",
					cancelPendingPreflightForTerminalAbort: () => {},
					abortPromptAndWaitWithTerminal: async (handle, options) => {
						seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
						return {
							status: "settled",
							terminalScope: {
								scopeId: "scope-owned",
								abortedAttemptEpoch: 7,
								lineageIdHash: "sdk-owned-lineage",
							},
						};
					},
				},
			});
			const ctx = extensionContext(transport.sessionId, cwd);
			await handlers.get("session_start")?.({}, ctx);
			transport.feed("client", {
				type: "control_request",
				id: "owned-abort",
				operation: "turn.abort",
				input: { mode: "terminal", scope: "owned" },
				idempotencyKey: "owned-key",
			} as SdkFrame);
			// Let the background job unwind within the 500ms owned-settlement
			// grace so quiescence is provable.
			void Bun.sleep(50).then(() => gate.resolve("done"));
			const ownedDeadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === "owned-abort" && frame.type === "control_response")) {
				if (Date.now() > ownedDeadline) throw new Error("Timed out waiting for the owned abort response");
				await Bun.sleep(20);
			}
			const response = transport.sent.find(frame => frame.id === "owned-abort");
			expect(response).toMatchObject({
				type: "control_response",
				ok: true,
				result: expect.objectContaining({ turn: "stopped", ownedWork: "stopped" }),
			});
			expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "owned" }]);
			// The exact owned job was cancelled by settleOwnedWork before the
			// stopped disposition was reported.
			const settledStatus = jobId ? manager.getJob(jobId)?.status : undefined;
			expect(settledStatus).toBeDefined();
			expect(["cancelled", "completed", "failed"]).toContain(settledStatus as string);
		} finally {
			gate.resolve("done");
			if (registration) unregisterOwnedRegistration(registration as never);
			AsyncJobManager.unregisterManager(manager);
			AsyncJobManager.setInstance(undefined);
			await manager.dispose({ timeoutMs: 100 }).catch(() => {});
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host bounds completed terminal rows and retains key tombstones", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-bound-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const admissions = admissionBarrier(12);
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			onFrameAdmitted: admissions.onFrameAdmitted,
			terminalAbortSeams: {
				maxDurableTerminalReservationsForTests: 8,
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => undefined,
				getActivePromptHandle: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async () => ({ status: "settled" }),
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			// Idle terminal aborts with distinct keys must not grow the
			// reconciliation document without limit: completed rows are bounded
			// and evicted keys become compact tombstones (review thread P2).
			for (let index = 0; index < 12; index++) {
				transport.feed("client", {
					type: "control_request",
					id: `bound-${index}`,
					operation: "turn.abort",
					input: { mode: "terminal" },
					idempotencyKey: `bound-key-${index}`,
				} as SdkFrame);
			}
			// Yield once so every fire-and-forget frame handler can admit its first
			// serialized transaction, then drain the exact durable queue. Polling all
			// responses under the file's five-second deadline made scheduler load part
			// of the persistence contract.
			await admissions.ready;
			await reconciliationStore.drain?.();
			expect(transport.sent.length).toBeGreaterThanOrEqual(12);
			expect(reconciliationStore.snapshotTerminalScopes().length).toBeLessThanOrEqual(8);
			expect(reconciliationStore.snapshotTerminalKeys().length).toBeGreaterThan(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("SDK-only host bounds distinct-key terminal markers on UNCERTAIN finalization", async () => {
		// Many concurrent terminal aborts (distinct keys) of one turn that fails
		// to settle must not leave an arbitrarily large reconciliation document:
		// the pending->uncertain finalize applies the same 256-row bound and
		// retains key tombstones (review thread P2).
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-uncertain-bound-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const admissions = admissionBarrier(12);
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			onFrameAdmitted: admissions.onFrameAdmitted,
			terminalAbortSeams: {
				maxDurableTerminalReservationsForTests: 8,
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "exact-run-handle",
				getActivePromptOwnerConnectionId: () => "client",
				cancelPendingPreflightForTerminalAbort: () => {},
				// The turn never settles: every abort finalizes its pending marker
				// to UNCERTAIN (worker_unsettled).
				abortPromptAndWaitWithTerminal: async () => ({ status: "unfenced" }),
			},
		});
		const ctx = extensionContext(transport.sessionId, cwd);
		try {
			await handlers.get("session_start")?.({}, ctx);
			for (let index = 0; index < 12; index++) {
				transport.feed("client", {
					type: "control_request",
					id: `uncertain-${index}`,
					operation: "turn.abort",
					input: { mode: "terminal" },
					idempotencyKey: `uncertain-key-${index}`,
				} as SdkFrame);
			}
			await admissions.ready;
			await reconciliationStore.drain?.();
			expect(transport.sent.length).toBeGreaterThanOrEqual(12);
			// The uncertain finalizes evicted the oldest rows into tombstones.
			expect(reconciliationStore.snapshotTerminalScopes().length).toBeLessThanOrEqual(8);
			expect(reconciliationStore.snapshotTerminalKeys().length).toBeGreaterThan(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("native-like and loopback transports share the same SDK contract matrix", async () => {
		const nativePolicy = createSdkSurfacePolicy({
			bindings: ["sdkControl", "cycleModel", "getSkillState"],
			workflowGateAvailable: false,
		});
		const loopbackPolicy = createSdkSurfacePolicy({
			bindings: ["sdkControl", "cycleModel", "getSkillState"],
			workflowGateAvailable: false,
		});
		expect([...loopbackPolicy.installedControls]).toEqual([...nativePolicy.installedControls]);
		expect([...loopbackPolicy.installedQueries]).toEqual([...nativePolicy.installedQueries]);
		expect(createSdkCapabilities(loopbackPolicy, true)).toEqual(createSdkCapabilities(nativePolicy, true));

		const nativeTransport = memoryTransport();
		const loopbackTransport = memoryTransport();
		const makeRuntime = (transport: ReturnType<typeof memoryTransport>) =>
			new SessionSdkSessionRuntime({
				transport,
				control: async (_connectionId, frame) => ({
					id: frame.id,
					ok: true,
					result: { operation: frame.operation },
				}),
				query: async (_connectionId, frame) => ({ id: frame.id, ok: true, result: { query: frame.query } }),
			});
		const nativeRuntime = makeRuntime(nativeTransport);
		const loopbackRuntime = makeRuntime(loopbackTransport);
		await Promise.all([nativeRuntime.start(), loopbackRuntime.start()]);
		for (const transport of [nativeTransport, loopbackTransport]) {
			transport.feed("client", {
				type: "control_request",
				id: "control",
				operation: "runtime.capabilities",
				input: {},
			});
			transport.feed("client", { type: "query_request", id: "query", query: "turn.prompt_status", input: {} });
		}
		await Bun.sleep(0);
		expect(loopbackTransport.sent).toEqual(nativeTransport.sent);
		await Promise.all([nativeRuntime.stop(), loopbackRuntime.stop()]);
	});
	test("failed extension stop retains retry state before replacement start", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-extension-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const transports: Array<{ starts: number; stops: number }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: path.join(cwd, ".gjc", "agent"),
			createTransport: async ({ sessionId, stateRoot, token }) => {
				const stats = { starts: 0, stops: 0 };
				const failFirstStop = transports.length === 0;
				transports.push(stats);
				let frameHandler: ((connectionId: string, frame: SdkFrame) => void) | undefined;
				return {
					sessionId,
					stateRoot,
					token,
					onFrame(handler) {
						frameHandler = handler;
						return () => {
							if (frameHandler === handler) frameHandler = undefined;
						};
					},
					sendFrame: () => {},
					start: async () => {
						stats.starts += 1;
						const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
						await mkdir(path.dirname(endpoint), { recursive: true });
						await writeFile(endpoint, JSON.stringify({ sessionId, token, pid: process.pid }));
						return { url: `ws://127.0.0.1:${30_000 + stats.starts}` };
					},
					stop: async () => {
						stats.stops += 1;
						if (failFirstStop && stats.stops === 1)
							throw new SdkTransportLifecycleError(
								"endpoint_remove_failed",
								"injected endpoint removal failure",
							);
					},
				};
			},
		});
		const firstContext = extensionContext("extension-first", cwd);
		try {
			await handlers.get("session_start")?.({}, firstContext);
			expect(transports).toHaveLength(1);
			expect(transports[0]?.starts).toBe(1);
			await expect(handlers.get("session_shutdown")?.({}, firstContext)).rejects.toMatchObject({
				code: "endpoint_remove_failed",
			});
			expect(transports[0]?.stops).toBe(1);

			await handlers.get("session_shutdown")?.({}, firstContext);
			expect(transports[0]?.stops).toBe(2);

			await handlers.get("session_switch")?.({}, extensionContext("extension-replacement", cwd));
			expect(transports).toHaveLength(2);
			expect(transports[1]?.starts).toBe(1);
			await handlers.get("session_shutdown")?.({}, firstContext);
			expect(transports[1]?.stops).toBe(1);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("keeps a local SDK-only host alive through broker failure and registers after recovery", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-broker-recovery-"));
		const agentDir = path.join(cwd, ".gjc", "agent");
		await mkdir(path.dirname(agentDir), { recursive: true });
		await writeFile(agentDir, "blocked");
		const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as any;
		const sessionId = "broker-recovery";
		const endpointUrl = "ws://127.0.0.1:1";
		createSdkSessionRuntimeExtension(api, {
			agentDir,
			createTransport: async ({ stateRoot, token }) => ({
				sessionId,
				stateRoot,
				token,
				onFrame: () => undefined,
				sendFrame: () => {},
				start: async () => {
					const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
					await mkdir(path.dirname(endpoint), { recursive: true });
					await writeFile(endpoint, JSON.stringify({ sessionId, token, pid: process.pid, url: endpointUrl }));
					return { url: endpointUrl };
				},
				stop: async () => {},
			}),
		});
		const context = extensionContext(sessionId, cwd);
		let broker: Broker | undefined;
		try {
			await handlers.get("session_start")?.({}, context);
			await rm(agentDir);
			await mkdir(agentDir, { recursive: true });
			broker = new Broker({ agentDir });
			await broker.start();
			await handlers.get("turn_start")?.({}, context);
			expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 })).toMatchObject(
				{
					ok: true,
					result: { sessionId, token: expect.any(String) },
				},
			);
			await handlers.get("session_shutdown")?.({}, context);
			// DR-1 keeps the unregistered row listed, so the two refusals stay distinct:
			// a matching generation on a terminal row is terminally gone (no endpoint will
			// ever be issued again, and close takes its signal fallback), while a rotated
			// generation is still merely stale and worth re-reading.
			expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 })).toMatchObject(
				{
					ok: false,
					error: { code: "resource_gone", message: "session endpoint record is gone" },
				},
			);
			expect(await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 2 })).toMatchObject(
				{
					ok: false,
					error: { code: "endpoint_stale", message: "session endpoint is stale" },
				},
			);
		} finally {
			await broker?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("rejects lifecycle-required SDK-only startup when broker registration fails", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-broker-required-"));
		const agentDir = path.join(cwd, ".gjc", "agent");
		await mkdir(path.dirname(agentDir), { recursive: true });
		await writeFile(agentDir, "blocked");
		const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as any;
		createSdkSessionRuntimeExtension(api, {
			agentDir,
			brokerRegistrationRequired: true,
			lifecycleRequestId: "broker-required-marker",
			createTransport: async ({ sessionId, stateRoot, token }) => ({
				sessionId,
				stateRoot,
				token,
				onFrame: () => undefined,
				sendFrame: () => {},
				start: async () => ({ url: "ws://127.0.0.1:1" }),
				stop: async () => {},
			}),
		});
		try {
			await expect(
				handlers.get("session_start")?.({}, extensionContext("broker-required", cwd)),
			).rejects.toBeDefined();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
interface PreflightHooks {
	onPreflightAccepted?: () => void;
	onPreflightAcceptCommit?: () => void | Promise<void>;
}

interface ResponseFrame {
	id?: string;
	ok?: boolean;
	code?: string;
	error?: { code: string; message: string };
	result?: { status?: string; commandId?: string; turnId?: string; error?: { code: string; message: string } };
}

interface InvocationHarness {
	control(operation: string, input: Record<string, unknown>): Promise<ResponseFrame>;
	query(name: string, input: Record<string, unknown>): Promise<ResponseFrame>;
	emit(event: string, payload?: unknown): Promise<void>;
	switchSession(sessionId: string): Promise<void>;
	branch(sessionId: string): Promise<void>;
	requestOnSession(sessionId: string, frame: Record<string, unknown>): Promise<ResponseFrame>;
	sendToSession(sessionId: string, frame: Record<string, unknown>): void;
	sent(sessionId: string): SdkFrame[];
	readonly broadcasts: SdkFrame[];
	stop(): Promise<void>;
}

/**
 * Drives the SDK host through its wire surface: control/query frames in,
 * response frames out. Nothing reaches into the reconciliation maps.
 */
async function invocationHarness(
	sessionId: string,
	cwd: string,
	hooks: {
		sendUserMessage?: (content: unknown, options?: PreflightHooks & { deliverAs?: string }) => Promise<unknown>;
		invokeSkill?: (name: string, args?: string, options?: PreflightHooks) => Promise<unknown>;
		abort?: () => void;
		isIdle?: () => boolean;
		settings?: Settings;
		/** Throw to inject a durable-write failure for matching transitions. */
		persistInterceptor?: (transition: { type: string }) => void;
		/** Hold one matching durable transition until the test releases it. */
		persistHold?: { type: string; onEntered: () => void; release: Promise<void> };
		onLifecycleDrainTimeout?: () => void;
		onFailureDiagnosticKeyCount?: (count: number) => void;
		agentFailedWriteFailures?: number;
		branch?: unknown[];
		onInvocationCompletionReconciled?: (kind: string, correlation: { commandId: string; turnId: string }) => void;
	},
): Promise<InvocationHarness> {
	const waiters = new Map<string, (frame: ResponseFrame) => void>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
	const broadcasts: SdkFrame[] = [];
	let deliver: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	const deliveries = new Map<string, (connectionId: string, frame: SdkFrame) => void>();
	const sentFrames = new Map<string, SdkFrame[]>();
	let nextId = 0;
	const api = {
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: async (content: unknown, options?: PreflightHooks & { deliverAs?: string }) => {
			const result = await hooks.sendUserMessage?.(content, options);
			return result === undefined ? "completed" : result;
		},
	} as unknown as ExtensionAPI;
	const interceptorStore = hooks.persistInterceptor
		? createInterceptorReconciliationStore(
				hooks.persistInterceptor,
				hooks.agentFailedWriteFailures,
				hooks.persistHold,
			)
		: undefined;
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		...(hooks.onLifecycleDrainTimeout ? { onLifecycleDrainTimeoutForTests: hooks.onLifecycleDrainTimeout } : {}),
		...(interceptorStore
			? {
					terminalAbortSeams: {
						getReconciliationStore: () => interceptorStore,
						getTerminalTurnEpoch: () => undefined,
						getActivePromptHandle: () => undefined,
						cancelPendingPreflightForTerminalAbort: () => {},
						abortPromptAndWaitWithTerminal: async () => ({ status: "settled", terminalScope: {} }),
					},
				}
			: {}),
		...(hooks.onFailureDiagnosticKeyCount
			? { onFailureDiagnosticKeyCountForTests: hooks.onFailureDiagnosticKeyCount }
			: {}),
		...(hooks.onInvocationCompletionReconciled
			? { onInvocationCompletionReconciledForTests: hooks.onInvocationCompletionReconciled }
			: {}),
		...(hooks.settings ? { settings: hooks.settings } : {}),
		createTransport: async ({ sessionId: id, stateRoot, token }) => ({
			sessionId: id,
			stateRoot,
			token,
			onFrame(handler) {
				deliver = handler;
				deliveries.set(id, handler);
				return () => {
					if (deliver === handler) deliver = undefined;
					if (deliveries.get(id) === handler) deliveries.delete(id);
				};
			},
			sendFrame(_connectionId, frame) {
				const response = frame as ResponseFrame;
				const frames = sentFrames.get(id) ?? [];
				frames.push(frame);
				sentFrames.set(id, frames);
				if (typeof response.id === "string") waiters.get(response.id)?.(response);
			},
			broadcastFrame(frame) {
				broadcasts.push(frame);
			},
			start: async () => ({ url: "ws://127.0.0.1:1" }),
			stop: async () => {},
		}),
	});
	const ctx = {
		cwd,
		workflowGate: undefined,
		sdkBindings: () => (hooks.invokeSkill ? ["invokeSkill"] : []),
		isIdle: hooks.isIdle ?? (() => true),
		abort: hooks.abort ?? (() => {}),
		...(hooks.invokeSkill ? { invokeSkill: hooks.invokeSkill } : {}),
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(cwd, ".gjc", "state", `${sessionId}.jsonl`),
			getSessionName: () => undefined,
			getBranch: () => hooks.branch ?? [],
		},
	};
	await handlers.get("session_start")?.({}, ctx);
	const request = (frame: Record<string, unknown>): Promise<ResponseFrame> => {
		const id = `frame-${nextId}`;
		nextId += 1;
		const { promise, resolve } = Promise.withResolvers<ResponseFrame>();
		waiters.set(id, resolve);
		deliver?.("client", { ...frame, id } as SdkFrame);
		return promise;
	};
	return {
		control: (operation, input) => request({ type: "control_request", operation, input }),
		query: (name, input) => request({ type: "query_request", query: name, input }),
		broadcasts,
		emit: async (event, payload) => {
			await handlers.get(event)?.(payload ?? {}, ctx);
		},
		stop: async () => {
			await handlers.get("session_shutdown")?.({}, ctx);
		},
		switchSession: async sessionId => {
			await handlers.get("session_switch")?.(
				{},
				{
					...ctx,
					sessionManager: {
						...ctx.sessionManager,
						getSessionId: () => sessionId,
						getSessionFile: () => path.join(cwd, ".gjc", "state", `${sessionId}.jsonl`),
					},
				},
			);
		},
		branch: async sessionId => {
			await handlers.get("session_branch")?.(
				{},
				{
					...ctx,
					sessionManager: {
						...ctx.sessionManager,
						getSessionId: () => sessionId,
						getSessionFile: () => path.join(cwd, ".gjc", "state", `${sessionId}.jsonl`),
					},
				},
			);
		},
		requestOnSession: (sessionId, frame) => {
			const id = `frame-${nextId}`;
			nextId += 1;
			const { promise, resolve } = Promise.withResolvers<ResponseFrame>();
			waiters.set(id, resolve);
			deliveries.get(sessionId)?.("client", { ...frame, id } as SdkFrame);
			return promise;
		},
		sendToSession: (sessionId, frame) => {
			deliveries.get(sessionId)?.("client", frame as SdkFrame);
		},
		sent: sessionId => sentFrames.get(sessionId) ?? [],
	};
}

/** Reconciliation store used to inject durable-write failures from tests: wraps a
 * session-file-backed store and fails the write whenever the staged records contain
 * the intermediate failed-without-terminal state an agent_failed transition persists. */
function createInterceptorReconciliationStore(
	interceptor: (transition: { type: string }) => void,
	agentFailedWriteFailures = 1,
	persistHold?: { type: string; onEntered: () => void; release: Promise<void> },
): SdkOnlyReconciliationStore {
	const failureCounts = new Map<string, number>();
	let holdConsumed = false;
	const backing = createInterceptorBackingStore();
	return {
		path: null,
		load: async () => backing.records.map(record => ({ ...record })),
		async transact(mutator) {
			const records = mutator(backing.records.map(record => ({ ...record })));
			let transitionType: "agent_failed" | "agent_end" | undefined;
			for (const record of records as Array<{ status?: string; terminalAt?: number; commandId?: string }>) {
				// The intermediate durable state an agent_failed write produces:
				// the reason is set but the row is not terminal yet. Tests choose how
				// many consecutive writes fail before the recovery replay succeeds.
				const identity = String(record?.commandId ?? "unknown");
				const failureCount = failureCounts.get(identity) ?? 0;
				if (record?.terminalAt === undefined && (record as { error?: unknown }).error !== undefined)
					transitionType ??= "agent_failed";
				if (
					record?.terminalAt === undefined &&
					(record as { error?: unknown }).error !== undefined &&
					failureCount < agentFailedWriteFailures
				) {
					transitionType = "agent_failed";
					failureCounts.set(identity, failureCount + 1);
					interceptor({ type: "agent_failed" });
					throw Object.assign(new Error("injected persistence failure"), { code: "io_error" });
				}
				const previous = backing.records.find(candidate => candidate.commandId === record.commandId);
				if (record?.terminalAt !== undefined && previous?.terminalAt === undefined) {
					transitionType = "agent_end";
					interceptor({ type: "agent_end" });
				}
			}
			if (persistHold && !holdConsumed && persistHold.type === transitionType) {
				holdConsumed = true;
				persistHold.onEntered();
				await persistHold.release;
			}
			backing.records = records;
		},
		snapshotTerminalScopes: () => [],
		snapshotTerminalKeys: () => [],
		transactTerminalScopes: async () => {},
		transactTerminalState: async () => {},
	};
}

function createInterceptorBackingStore(): { records: SdkOnlyInvocationRecord[] } {
	return { records: [] };
}

/** Polls a status query until the invocation reports a terminal reconciliation state. */
async function settledStatus(
	harness: InvocationHarness,
	name: string,
	input: Record<string, unknown>,
): Promise<NonNullable<ResponseFrame["result"]>> {
	// Wall-clock budget instead of a fixed poll count: CI runners can starve the
	// event loop long enough to exhaust 200 ~1ms polls before a 25ms deadline
	// timer is dispatched, failing a correct implementation on timing alone.
	// The contract is unchanged — the status must still reach a terminal
	// reconciliation state with the asserted shape within a bounded horizon.
	const budgetEndsAt = Date.now() + 10_000;
	for (;;) {
		const frame = await harness.query(name, input);
		const result = frame.result;
		if (result && (result.status === "failed" || result.status === "terminal_ok")) return result;
		if (Date.now() > budgetEndsAt) throw new Error(`${name} never reported a terminal reconciliation status`);
		await Bun.sleep(1);
	}
}

function neverSettlingPromise(): Promise<void> {
	return Promise.withResolvers<void>().promise;
}

describe("post-acceptance invocation terminalization", () => {
	test.each([
		{ status: 402, code: "provider_http_402" },
		{ status: 429, code: "provider_http_429" },
		{ status: 500, code: "provider_rejected" },
	])("terminalizes a streamed provider HTTP $status rejection and permits a healthy abort_and_prompt replacement", async ({
		status,
		code,
	}) => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-provider-http-${status}-`));
		try {
			let prompts = 0;
			const harness = await invocationHarness(`provider-http-${status}`, cwd, {
				sendUserMessage: async (_content, options) => {
					prompts += 1;
					await options?.onPreflightAcceptCommit?.();
					if (prompts === 1) await neverSettlingPromise();
				},
			});
			const failed = await harness.control("turn.prompt", { text: "provider rejects", clientRef: `http-${status}` });
			expect(failed.ok).toBe(true);
			const failedIds = { commandId: failed.result?.commandId, turnId: failed.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_end", {
				messages: [
					{
						role: "assistant",
						stopReason: "error",
						errorStatus: status,
						transportFailure: { kind: "transport", status },
					},
				],
			});

			const terminal = await settledStatus(harness, "turn.result", {
				kind: "prompt",
				clientRef: `http-${status}`,
			});
			expect(terminal).toMatchObject({
				status: "failed",
				error: { code, message: "Prompt submission failed." },
				terminalAt: expect.any(Number),
			});
			const stable = await harness.query("turn.result", { kind: "prompt", ...failedIds });
			expect(stable.result).toEqual(terminal);

			const replacement = await harness.control("turn.abort_and_prompt", { text: "replacement" });
			expect(replacement).toMatchObject({ ok: true, result: { accepted: true } });
			const replacementIds = { commandId: replacement.result?.commandId, turnId: replacement.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_end", {
				messages: [
					{ role: "assistant", stopReason: "error", errorStatus: 429 },
					{ role: "assistant", stopReason: "stop" },
				],
			});
			expect(await settledStatus(harness, "turn.prompt_status", replacementIds)).toMatchObject({
				status: "terminal_ok",
			});
			expect(prompts).toBe(2);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("classifies a statusless provider error completion as rejected", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-provider-statusless-"));
		try {
			const harness = await invocationHarness("provider-statusless", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "provider rejects" });
			expect(accepted.ok).toBe(true);
			const ids = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
			expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
				status: "failed",
				error: { code: "provider_rejected" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("upgrades a generic agent_failed diagnostic when agent_end proves provider rejection", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-provider-statusless-upgrade-"));
		try {
			const harness = await invocationHarness("provider-statusless-upgrade", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "provider rejects" });
			expect(accepted.ok).toBe(true);
			const ids = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("generic agent failure"), { code: "agent_failed" }),
			});
			await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
			expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
				status: "failed",
				error: { code: "provider_rejected" },
			});
			const failures = harness.broadcasts.filter(frame => frame.kind === "agent_failed");
			expect(failures.at(-1)).toMatchObject({ payload: { error: { code: "provider_rejected" } } });
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("preserves a specific agent_failed diagnostic when agent_end is statusless", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-provider-statusless-specific-"));
		try {
			const harness = await invocationHarness("provider-statusless-specific", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "provider unavailable" });
			expect(accepted.ok).toBe(true);
			const ids = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider unavailable"), { code: "provider_unavailable" }),
			});
			await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
			expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
				status: "failed",
				error: { code: "provider_unavailable" },
			});
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_failed")).toHaveLength(1);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("upgrades every shared generic diagnostic on a statusless provider end", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-provider-statusless-shared-"));
		try {
			let promoted: ((promotion: { startsOwnRun?: boolean }) => void) | undefined;
			const harness = await invocationHarness("provider-statusless-shared", cwd, {
				sendUserMessage: async (content, options) => {
					await options?.onPreflightAcceptCommit?.();
					if (content === "attached") {
						promoted = (options as { onQueuedPromoted?: (promotion: { startsOwnRun?: boolean }) => void })
							?.onQueuedPromoted;
						return;
					}
					await neverSettlingPromise();
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			const attached = await harness.control("turn.follow_up", { text: "attached" });
			expect(attached.ok).toBe(true);
			promoted?.({ startsOwnRun: false });
			const firstIds = { commandId: first.result?.commandId, turnId: first.result?.turnId };
			const attachedIds = { commandId: attached.result?.commandId, turnId: attached.result?.turnId };
			await harness.emit("agent_failed", { error: Object.assign(new Error("generic"), { code: "agent_failed" }) });
			await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
			expect(await settledStatus(harness, "turn.prompt_status", firstIds)).toMatchObject({
				status: "failed",
				error: { code: "provider_rejected" },
			});
			expect(await settledStatus(harness, "turn.prompt_status", attachedIds)).toMatchObject({
				status: "failed",
				error: { code: "provider_rejected" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("does not misclassify a local malformed-tool circuit breaker as provider rejection", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-local-malformed-tool-"));
		try {
			const harness = await invocationHarness("local-malformed-tool", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "local malformed tool" });
			expect(accepted.ok).toBe(true);
			const ids = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_end", {
				messages: [
					{
						role: "assistant",
						stopReason: "error",
						errorMessage:
							"Stopping after 3 consecutive turns of malformed tool calls; the model did not produce a usable tool call or answer.",
					},
				],
			});
			expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
				status: "failed",
				error: { code: "prompt_failed" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("does not misclassify a local composer policy breaker as provider rejection", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-local-composer-policy-"));
		try {
			const harness = await invocationHarness("local-composer-policy", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "local composer policy" });
			expect(accepted.ok).toBe(true);
			const ids = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_end", {
				messages: [
					{
						role: "assistant",
						stopReason: "error",
						errorMessage:
							"Composer bash policy blocked repository file I/O again after its one automatic recovery turn.",
					},
				],
			});
			expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
				status: "failed",
				error: { code: "prompt_failed" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("terminalizes when provider end metadata exposes a throwing accessor", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-provider-throwing-metadata-"));
		try {
			const harness = await invocationHarness("provider-throwing-metadata", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "provider metadata" });
			expect(accepted.ok).toBe(true);
			const ids = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			const event = {} as Record<string, unknown>;
			Object.defineProperty(event, "messages", {
				get() {
					throw new Error("provider metadata accessor failed");
				},
			});
			await harness.emit("agent_end", event);
			expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
				status: "failed",
				error: { code: "prompt_failed" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("binds a delayed predecessor provider failure to its own batch after a replacement starts", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-delayed-provider-batch-"));
		try {
			const firstInflight = Promise.withResolvers<void>();
			const secondInflight = Promise.withResolvers<void>();
			let prompts = 0;
			const harness = await invocationHarness("delayed-provider-batch", cwd, {
				sendUserMessage: async (_content, options) => {
					prompts += 1;
					await options?.onPreflightAcceptCommit?.();
					if (prompts === 1) await firstInflight.promise;
					if (prompts === 2) await secondInflight.promise;
				},
				persistInterceptor: () => {},
			});
			const first = await harness.control("turn.prompt", { text: "first", clientRef: "delayed-first" });
			expect(first.ok).toBe(true);
			const firstIds = { commandId: first.result?.commandId, turnId: first.result?.turnId };
			await harness.emit("agent_start");
			const replacement = await harness.control("turn.abort_and_prompt", { text: "replacement" });
			expect(replacement).toMatchObject({ ok: true, result: { accepted: true } });
			const replacementIds = { commandId: replacement.result?.commandId, turnId: replacement.result?.turnId };
			await harness.emit("agent_start");
			expect((await harness.query("turn.prompt_status", replacementIds)).result?.status).toBe("in_flight");
			await harness.emit("agent_end", {
				messages: [{ role: "assistant", stopReason: "error", errorStatus: 402 }],
			});
			expect(await settledStatus(harness, "turn.prompt_status", firstIds)).toMatchObject({
				status: "failed",
				error: { code: "provider_http_402" },
			});
			expect((await harness.query("turn.prompt_status", replacementIds)).result?.status).toBe("in_flight");
			await harness.emit("agent_end", {
				messages: [{ role: "assistant", stopReason: "stop", content: "completed" }],
			});
			expect(await settledStatus(harness, "turn.prompt_status", replacementIds)).toMatchObject({
				status: "terminal_ok",
			});
			firstInflight.resolve();
			secondInflight.resolve();
			expect(prompts).toBe(2);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test.each([
		{ operation: "switchSession" as const, label: "session switch" },
		{ operation: "branch" as const, label: "session branch" },
	])("keeps a held 402/429 predecessor terminal across $label", async ({ operation }) => {
		for (const { status, code } of [
			{ status: 402, code: "provider_http_402" },
			{ status: 429, code: "provider_http_429" },
		]) {
			const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-${operation}-provider-race-`));
			try {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const firstInflight = Promise.withResolvers<void>();
				const secondInflight = Promise.withResolvers<void>();
				let timeoutWarnings = 0;
				const diagnosticKeyCounts: number[] = [];
				let prompts = 0;
				const harness = await invocationHarness(`${operation}-provider-race`, cwd, {
					persistInterceptor: () => {},
					onLifecycleDrainTimeout: () => {
						timeoutWarnings += 1;
					},
					onFailureDiagnosticKeyCount: count => {
						diagnosticKeyCounts.push(count);
					},
					persistHold: { type: "agent_failed", onEntered: entered.resolve, release: release.promise },
					agentFailedWriteFailures: 0,
					sendUserMessage: async (_content, options) => {
						prompts += 1;
						await options?.onPreflightAcceptCommit?.();
						if (prompts === 1) await firstInflight.promise;
						if (prompts === 2) await secondInflight.promise;
					},
				});
				const first = await harness.control("turn.prompt", {
					text: "first",
					clientRef: `${operation}-${status}-first`,
				});
				expect(first.ok).toBe(true);
				const firstIds = { commandId: first.result?.commandId, turnId: first.result?.turnId };
				await harness.emit("agent_start");
				const end = harness.emit("agent_end", {
					messages: [{ role: "assistant", stopReason: "error", errorStatus: status }],
				});
				await entered.promise;
				const lifecycleChange = harness[operation](`${operation}-successor`);
				await Bun.sleep(10);
				const [oldControl, oldQuery, oldReplay, oldProvider, oldReverse] = await Promise.all([
					harness.requestOnSession(`${operation}-provider-race`, {
						type: "control_request",
						operation: "turn.prompt",
						input: {},
					}),
					harness.requestOnSession(`${operation}-provider-race`, {
						type: "query_request",
						query: "turn.prompt_status",
						input: {},
					}),
					harness.requestOnSession(`${operation}-provider-race`, {
						type: "event_replay",
						sinceGeneration: 0,
						sinceSeq: 0,
					}),
					harness.requestOnSession(`${operation}-provider-race`, {
						type: "register_provider",
						capability: "fs",
						definitions: {},
					}),
					harness.requestOnSession(`${operation}-provider-race`, {
						type: "reverse_response",
						leaseId: "old-lease",
						ok: true,
						result: {},
					}),
				]);
				harness.sendToSession(`${operation}-provider-race`, { type: "provider_heartbeat", leaseId: "old-lease" });
				harness.sendToSession(`${operation}-provider-race`, { type: "lease_release", leaseId: "old-lease" });
				expect(
					[oldControl, oldQuery, oldReplay, oldProvider, oldReverse].map(
						response => response.error?.code ?? response.code,
					),
				).toEqual([
					"session_quiescing",
					"session_quiescing",
					"session_quiescing",
					"session_quiescing",
					"session_quiescing",
				]);
				expect(
					harness.sent(`${operation}-provider-race`).filter(frame => frame.type === "transport_error"),
				).toHaveLength(3);
				release.resolve();
				await Promise.all([end, lifecycleChange]);
				expect(timeoutWarnings).toBe(0);
				expect(diagnosticKeyCounts.at(-1)).toBe(0);
				const failure = harness.broadcasts.find(frame => {
					const payload = frame.payload;
					return (
						frame.kind === "agent_failed" &&
						typeof payload === "object" &&
						payload !== null &&
						(payload as { commandId?: unknown }).commandId === firstIds.commandId &&
						(payload as { turnId?: unknown }).turnId === firstIds.turnId
					);
				});
				expect(failure).toMatchObject({ kind: "agent_failed", payload: { error: { code } } });
				expect(harness.broadcasts.filter(frame => frame.kind === "agent_end").length).toBeGreaterThan(0);

				const successor = await harness.control("turn.prompt", { text: "successor" });
				expect(successor.ok).toBe(true);
				const successorIds = { commandId: successor.result?.commandId, turnId: successor.result?.turnId };
				await harness.emit("agent_start");
				await harness.emit("agent_end", {
					messages: [{ role: "assistant", stopReason: "stop", content: "completed" }],
				});
				secondInflight.resolve();
				expect(await settledStatus(harness, "turn.prompt_status", successorIds)).toMatchObject({
					status: "terminal_ok",
				});
				firstInflight.resolve();
				expect(prompts).toBe(2);
				await harness.stop();
			} finally {
				await Bun.sleep(50);
				await rm(cwd, { recursive: true, force: true });
			}
		}
	});

	test.each([
		{ operation: "switchSession" as const, label: "session switch" },
		{ operation: "branch" as const, label: "session branch" },
	])("bounds a stalled 402/429 lifecycle drain during $label", async ({ operation }) => {
		for (const status of [402, 429]) {
			const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-${operation}-provider-stall-`));
			try {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const firstInflight = Promise.withResolvers<void>();
				let timeoutWarnings = 0;
				const harness = await invocationHarness(`${operation}-provider-stall`, cwd, {
					persistInterceptor: () => {},
					onLifecycleDrainTimeout: () => {
						timeoutWarnings += 1;
					},
					persistHold: { type: "agent_failed", onEntered: entered.resolve, release: release.promise },
					agentFailedWriteFailures: 0,
					sendUserMessage: async (_content, options) => {
						await options?.onPreflightAcceptCommit?.();
						await firstInflight.promise;
					},
				});
				const first = await harness.control("turn.prompt", { text: "first" });
				expect(first.ok).toBe(true);
				await harness.emit("agent_start");
				const end = harness.emit("agent_end", {
					messages: [{ role: "assistant", stopReason: "error", errorStatus: status }],
				});
				await entered.promise;
				const startedAt = Date.now();
				const lifecycleChange = harness[operation](`${operation}-stall-successor`);
				await lifecycleChange;
				expect(Date.now() - startedAt).toBeLessThan(1_500);
				expect(timeoutWarnings).toBe(1);
				release.resolve();
				firstInflight.resolve();
				await end;
				await harness.stop();
			} finally {
				await Bun.sleep(50);
				await rm(cwd, { recursive: true, force: true });
			}
		}
	});

	test("deduplicates repeated agent_failed diagnostics for one invocation", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-agent-failed-dedupe-"));
		try {
			const inflight = Promise.withResolvers<void>();
			const harness = await invocationHarness("agent-failed-dedupe", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await inflight.promise;
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const correlation = accepted.result;
			await harness.emit("agent_start");
			const failure = { error: Object.assign(new Error("provider failed"), { code: "provider_rejected" }) };
			await harness.emit("agent_failed", failure);
			await harness.emit("agent_failed", failure);
			expect(
				harness.broadcasts.filter(
					frame =>
						frame.kind === "agent_failed" &&
						(frame.payload as { commandId?: string }).commandId === correlation?.commandId &&
						(frame.payload as { turnId?: string }).turnId === correlation?.turnId,
				),
			).toHaveLength(1);
			await harness.emit("agent_end");
			inflight.resolve();
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("routes a delayed predecessor agent_end after replacement completion to the retired owner", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-delayed-retired-owner-"));
		try {
			const firstInflight = Promise.withResolvers<void>();
			const secondInflight = Promise.withResolvers<void>();
			let prompts = 0;
			const harness = await invocationHarness("retired-owner-a", cwd, {
				persistInterceptor: () => {},
				sendUserMessage: async (_content, options) => {
					prompts += 1;
					await options?.onPreflightAcceptCommit?.();
					if (prompts === 1) await firstInflight.promise;
					if (prompts === 2) await secondInflight.promise;
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			const firstIds = { commandId: first.result?.commandId, turnId: first.result?.turnId };
			await harness.emit("agent_start");
			await harness.switchSession("retired-owner-b");
			await harness.emit("agent_end", {
				messages: [{ role: "assistant", stopReason: "error", errorStatus: 402 }],
			});
			const failure = harness.broadcasts.find(frame => {
				const payload = frame.payload;
				return (
					frame.kind === "agent_failed" &&
					typeof payload === "object" &&
					payload !== null &&
					(payload as { commandId?: unknown }).commandId === firstIds.commandId &&
					(payload as { turnId?: unknown }).turnId === firstIds.turnId
				);
			});
			expect(failure).toMatchObject({ kind: "agent_failed", payload: { error: { code: "provider_http_402" } } });
			const successor = await harness.control("turn.prompt", { text: "successor" });
			expect(successor.ok).toBe(true);
			const successorIds = { commandId: successor.result?.commandId, turnId: successor.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_end", {
				messages: [{ role: "assistant", stopReason: "stop", content: "completed" }],
			});
			secondInflight.resolve();
			expect(await settledStatus(harness, "turn.prompt_status", successorIds)).toMatchObject({
				status: "terminal_ok",
			});
			firstInflight.resolve();
			expect(prompts).toBe(2);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("fails closed for tokenless delayed events when a session id is reused", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-reused-session-retired-owner-"));
		try {
			const firstInflight = Promise.withResolvers<void>();
			const harness = await invocationHarness("reused-session", cwd, {
				persistInterceptor: () => {},
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await firstInflight.promise;
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			const firstIds = { commandId: first.result?.commandId, turnId: first.result?.turnId };
			await harness.emit("agent_start");
			await harness.switchSession("different-session");
			await harness.switchSession("reused-session");
			await harness.emit("agent_start");
			await harness.emit("agent_end", {
				messages: [{ role: "assistant", stopReason: "error", errorStatus: 402 }],
			});
			const failure = harness.broadcasts.find(frame => {
				const payload = frame.payload;
				return (
					frame.kind === "agent_failed" &&
					typeof payload === "object" &&
					payload !== null &&
					(payload as { commandId?: unknown }).commandId === firstIds.commandId &&
					(payload as { turnId?: unknown }).turnId === firstIds.turnId
				);
			});
			expect(failure).toBeUndefined();
			firstInflight.resolve();
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a prompt killed by a provider stream interrupt reports a terminal failed status", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-prompt-"));
		try {
			const harness = await invocationHarness("terminalize-prompt", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("stream interrupted"), { code: "upstream_stream_interrupted" }),
			});
			await harness.emit("agent_end");
			// Provider text is redacted on the wire by contract (sanitizePromptFailure);
			// the failure reason survives as the safe-token code.
			expect(await settledStatus(harness, "turn.prompt_status", { commandId, turnId })).toMatchObject({
				status: "failed",
				error: { code: "upstream_stream_interrupted", message: "Prompt submission failed." },
			});
			await harness.stop();
		} finally {
			// Let the reconciliation store finish its atomic write before the state root disappears.
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a canceled prompt reports a terminal failed status instead of hanging", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-abort-"));
		try {
			const harness = await invocationHarness("terminalize-abort", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				abort: () => {},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			const { commandId, turnId } = accepted.result ?? {};
			await harness.emit("agent_start");
			await harness.emit("agent_failed", { error: Object.assign(new Error("turn aborted"), { code: "aborted" }) });
			await harness.emit("agent_end");
			expect(await settledStatus(harness, "turn.prompt_status", { commandId, turnId })).toMatchObject({
				status: "failed",
				error: { code: "aborted" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("immediate prompt after abort ack is not terminalized by the aborted turn's delayed agent_end", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-abort-immediate-prompt-"));
		try {
			const firstInflight = Promise.withResolvers<void>();
			const successorStarted = Promise.withResolvers<void>();
			let prompts = 0;
			const harness = await invocationHarness("abort-immediate-prompt", cwd, {
				sendUserMessage: async (_content, options) => {
					prompts += 1;
					await options?.onPreflightAcceptCommit?.();
					if (prompts === 1) {
						await firstInflight.promise;
						return;
					}
					successorStarted.resolve();
					await Promise.withResolvers<void>().promise;
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			const firstIds = { commandId: first.result?.commandId, turnId: first.result?.turnId };
			await harness.emit("agent_start");
			expect(await harness.control("turn.abort", {})).toMatchObject({ ok: true });
			firstInflight.reject(Object.assign(new Error("turn aborted"), { code: "aborted" }));
			const second = await harness.control("turn.prompt", { text: "successor" });
			expect(second.ok).toBe(true);
			const secondIds = { commandId: second.result?.commandId, turnId: second.result?.turnId };
			expect(secondIds.commandId).not.toBe(firstIds.commandId);
			expect(secondIds.turnId).not.toBe(firstIds.turnId);
			await harness.emit("agent_start");
			await successorStarted.promise;
			await harness.emit("agent_end", {
				messages: [{ role: "assistant", content: "predecessor delayed" }],
			});
			expect(await harness.query("turn.prompt_status", secondIds)).toMatchObject({
				result: { status: expect.stringMatching(/accepted|in_flight/) },
			});
			expect(await settledStatus(harness, "turn.prompt_status", firstIds)).toMatchObject({
				status: "failed",
				error: { code: "aborted" },
			});
			const firstResult = await harness.query("turn.result", { kind: "prompt", ...firstIds });
			expect(firstResult).toMatchObject({
				result: { status: "failed", content: { text: "predecessor delayed" } },
			});
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "completed" }] });
			expect(await settledStatus(harness, "turn.prompt_status", secondIds)).toMatchObject({
				status: "terminal_ok",
			});
			expect(await harness.query("turn.result", { kind: "prompt", ...secondIds })).toMatchObject({
				result: {
					status: "terminal_ok",
					content: { text: "completed", byteLength: 9, truncated: false },
				},
			});
			expect(await harness.query("turn.result", { kind: "prompt", ...firstIds })).toMatchObject({
				result: { content: { text: "predecessor delayed" } },
			});
			expect(prompts).toBe(2);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("successor tool progress renews its deadline while a predecessor batch awaits agent_end", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-successor-progress-"));
		try {
			const firstInflight = Promise.withResolvers<void>();
			const successorStarted = Promise.withResolvers<void>();
			let prompts = 0;
			const harness = await invocationHarness("successor-progress", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 25 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					prompts += 1;
					await options?.onPreflightAcceptCommit?.();
					if (prompts === 1) {
						await firstInflight.promise;
						return;
					}
					successorStarted.resolve();
					await Promise.withResolvers<void>().promise;
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			expect(await harness.control("turn.abort", {})).toMatchObject({ ok: true });
			firstInflight.reject(Object.assign(new Error("turn aborted"), { code: "aborted" }));
			const successor = await harness.control("turn.prompt", { text: "successor" });
			expect(successor.ok).toBe(true);
			const successorIds = { commandId: successor.result?.commandId, turnId: successor.result?.turnId };
			await harness.emit("agent_start");
			await successorStarted.promise;
			for (let index = 0; index < 4; index += 1) {
				await harness.emit("tool_execution_start");
				await Bun.sleep(15);
			}
			expect(await harness.query("turn.prompt_status", successorIds)).toMatchObject({
				result: { status: expect.stringMatching(/accepted|in_flight/) },
			});
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "completed" }] });
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "completed" }] });
			expect(await settledStatus(harness, "turn.prompt_status", successorIds)).toMatchObject({
				status: "terminal_ok",
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("reused-session successor tool progress renews its active deadline", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-reused-successor-progress-"));
		try {
			const firstInflight = Promise.withResolvers<void>();
			const successorStarted = Promise.withResolvers<void>();
			let prompts = 0;
			const harness = await invocationHarness("reused-successor-progress", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 25 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					prompts += 1;
					await options?.onPreflightAcceptCommit?.();
					if (prompts === 1) {
						await firstInflight.promise;
						return;
					}
					successorStarted.resolve();
					await Promise.withResolvers<void>().promise;
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			await harness.switchSession("reused-successor-progress-other");
			await harness.switchSession("reused-successor-progress");
			const successor = await harness.control("turn.prompt", { text: "successor" });
			expect(successor.ok).toBe(true);
			const successorIds = { commandId: successor.result?.commandId, turnId: successor.result?.turnId };
			await harness.emit("agent_start");
			await successorStarted.promise;
			for (let index = 0; index < 4; index += 1) {
				await harness.emit("tool_execution_start");
				await Bun.sleep(15);
			}
			expect(await harness.query("turn.prompt_status", successorIds)).toMatchObject({
				result: { status: expect.stringMatching(/accepted|in_flight/) },
			});
			await harness.emit("agent_end");
			firstInflight.resolve();
			await harness.stop();
			expect(prompts).toBe(2);
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("abort_and_prompt starts exactly one successor and is not duplicated by delayed abort teardown", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-abort-and-prompt-once-"));
		try {
			const firstInflight = Promise.withResolvers<void>();
			const abortReleased = Promise.withResolvers<void>();
			let prompts = 0;
			const harness = await invocationHarness("abort-and-prompt-once", cwd, {
				sendUserMessage: async (_content, options) => {
					prompts += 1;
					await options?.onPreflightAcceptCommit?.();
					if (prompts === 1) {
						await firstInflight.promise;
						return;
					}
				},
				abort: () => abortReleased.promise,
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			const replacement = harness.control("turn.abort_and_prompt", { text: "replacement" });
			firstInflight.reject(Object.assign(new Error("turn aborted"), { code: "aborted" }));
			await harness.emit("agent_end");
			abortReleased.resolve();
			const accepted = await replacement;
			expect(accepted.ok).toBe(true);
			const successorIds = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "completed" }] });
			expect(await settledStatus(harness, "turn.prompt_status", successorIds)).toMatchObject({
				status: "terminal_ok",
			});
			expect(prompts).toBe(2);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a failed skill invocation still reports a terminal failed status", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-skill-"));
		try {
			const harness = await invocationHarness("terminalize-skill", cwd, {
				invokeSkill: async (_name, _args, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const accepted = await harness.control("skill.invoke", { name: "ralplan" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("skill provider stream interrupted"), { code: "upstream_error" }),
			});
			await harness.emit("agent_end");
			expect(await settledStatus(harness, "skill.invoke_status", { commandId, turnId })).toMatchObject({
				status: "failed",
				error: { code: "upstream_error" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("a completed prompt reports a terminal successful status", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-completed-prompt-"));
		try {
			const harness = await invocationHarness("terminalize-completed-prompt", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			expect(await settledStatus(harness, "turn.prompt_status", { commandId, turnId })).toMatchObject({
				status: "terminal_ok",
				terminalAt: expect.any(Number),
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("captures exact bounded content from actual prompt agent_end messages", async () => {
		const cases = [
			{ name: "short", agent: "SDK_OK", expected: "SDK_OK", bytes: 6, truncated: false },
			{ name: "max", agent: "x".repeat(16_384), expected: "x".repeat(16_384), bytes: 16_384, truncated: false },
			{ name: "blank", agent: " ", expected: undefined, bytes: 0, truncated: false },
			{
				name: "overflow",
				agent: `${"😀".repeat(4_096)}tail`,
				expected: "😀".repeat(4_096),
				bytes: 16_384,
				truncated: true,
			},
		] as const;
		for (const testCase of cases) {
			const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-terminal-content-${testCase.name}-`));
			try {
				const harness = await invocationHarness(`terminal-content-${testCase.name}`, cwd, {
					sendUserMessage: async (_content, options) => {
						await options?.onPreflightAcceptCommit?.();
						await Promise.withResolvers<void>().promise;
					},
				});
				const accepted = await harness.control("turn.prompt", { text: "hello" });
				await harness.emit("agent_start");
				await harness.emit("agent_end", { messages: [{ role: "assistant", content: testCase.agent }] });
				const result = await settledStatus(harness, "turn.result", {
					kind: "prompt",
					commandId: accepted.result?.commandId,
					turnId: accepted.result?.turnId,
				});
				if (testCase.expected === undefined) {
					expect(result).toMatchObject({ status: "failed" });
					expect((result as Record<string, unknown>).content).toBeUndefined();
				} else {
					expect(result).toMatchObject({
						status: "terminal_ok",
						content: {
							text: testCase.expected,
							byteLength: testCase.bytes,
							truncated: testCase.truncated,
						},
					});
				}
				await harness.stop();
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		}
	});
	test("does not reuse a previous branch assistant for a new textless prompt", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminal-order-previous-assistant-"));
		try {
			const harness = await invocationHarness("terminal-order-previous-assistant", cwd, {
				branch: [{ type: "message", message: { role: "assistant", content: "PREVIOUS" } }],
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await Promise.withResolvers<void>().promise;
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "textless" });
			const selector = {
				kind: "prompt" as const,
				commandId: accepted.result?.commandId,
				turnId: accepted.result?.turnId,
			};
			await harness.emit("agent_start");
			await harness.emit("agent_end", { messages: [] });
			const result = await settledStatus(harness, "turn.result", selector);
			expect((result as Record<string, unknown>).content).toBeUndefined();
			await harness.stop();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("reconciles contract-valid skill completion and agent_end ordering", async () => {
		const cases = [
			{
				name: "completion-real-agent-real",
				order: "completion-first",
				completion: "completion",
				agent: "agent",
				expected: "completion",
			},
			{
				name: "completion-blank-agent-real",
				order: "completion-first",
				completion: " ",
				agent: "agent",
				expected: "agent",
			},
			{
				name: "completion-none-agent-real",
				order: "completion-first",
				completion: null,
				agent: "agent",
				expected: "agent",
			},
			{
				name: "agent-real-completion-real",
				order: "agent-first",
				completion: "completion",
				agent: "agent",
				expected: "agent",
			},
			{
				name: "agent-real-completion-blank",
				order: "agent-first",
				completion: " ",
				agent: "agent",
				expected: "agent",
			},
			{
				name: "agent-blank-completion-real",
				order: "agent-first",
				completion: "completion",
				agent: " ",
				expected: "completion",
			},
			{
				name: "agent-blank-completion-none",
				order: "agent-first",
				completion: null,
				agent: " ",
				expected: undefined,
			},
			{
				name: "agent-none-completion-real",
				order: "agent-first",
				completion: "completion",
				agent: null,
				expected: "completion",
			},
			{
				name: "agent-none-completion-blank",
				order: "agent-first",
				completion: " ",
				agent: null,
				expected: undefined,
			},
		] as const;
		for (const testCase of cases) {
			const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-skill-terminal-order-${testCase.name}-`));
			const completion = Promise.withResolvers<unknown>();
			const completionReconciled = Promise.withResolvers<void>();
			try {
				const harness = await invocationHarness(`skill-terminal-order-${testCase.name}`, cwd, {
					onInvocationCompletionReconciled: kind => {
						if (kind === "skill") completionReconciled.resolve();
					},
					invokeSkill: async (_name, _args, options) => {
						await options?.onPreflightAcceptCommit?.();
						return await completion.promise;
					},
				});
				const accepted = await harness.control("skill.invoke", { name: "ralplan" });
				const selector = {
					kind: "skill" as const,
					commandId: accepted.result?.commandId,
					turnId: accepted.result?.turnId,
				};
				await harness.emit("agent_start");
				const emitAgentEnd = () =>
					harness.emit("agent_end", {
						messages: testCase.agent === null ? [] : [{ role: "assistant", content: testCase.agent }],
					});
				if (testCase.order === "completion-first") {
					completion.resolve(testCase.completion);
					await completionReconciled.promise;
					await emitAgentEnd();
				} else {
					await emitAgentEnd();
					completion.resolve(testCase.completion);
					await completionReconciled.promise;
				}
				const result = await harness.query("turn.result", selector);
				const content = (result.result as { content?: { text?: string } } | undefined)?.content;
				expect(content?.text).toBe(testCase.expected);
				await harness.stop();
			} finally {
				completion.resolve(undefined);
				await rm(cwd, { recursive: true, force: true });
			}
		}
	}, 30_000);
	test("a queued follow-up prompt is not terminalized before the turn runs", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-followup-"));
		try {
			const turnRunning = Promise.withResolvers<void>();
			const harness = await invocationHarness("terminalize-followup", cwd, {
				sendUserMessage: async (_content, options) => {
					if (options?.deliverAs === "followUp") {
						await options?.onPreflightAcceptCommit?.();
						// #queueFollowUp resolves immediately; the turn has not run yet.
						return;
					}
					await options?.onPreflightAcceptCommit?.();
					await turnRunning.promise;
				},
			});
			const accepted = await harness.control("turn.follow_up", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			// The follow-up submission must NOT report terminal_ok while the turn is still pending.
			const status = await harness.query("turn.prompt_status", { commandId, turnId });
			expect(status.result?.status).toMatch(/accepted|in_flight|unknown/);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("an unpromoted follow-up does not acquire a deadline lease", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-unpromoted-followup-"));
		try {
			let promoted: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
			const harness = await invocationHarness("unpromoted-followup", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 25 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					promoted = (options as { onQueuedPromoted?: (promotion: { startsOwnRun: boolean }) => void } | undefined)
						?.onQueuedPromoted;
				},
			});
			const accepted = await harness.control("turn.follow_up", { text: "queued" });
			expect(accepted.ok).toBe(true);
			const ids = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await Bun.sleep(100);
			expect((await harness.query("turn.prompt_status", ids)).result?.status).not.toBe("failed");
			promoted?.({ startsOwnRun: true });
			expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("a prompt queued as steer while streaming is not terminalized before the turn runs", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-prompt-while-busy-"));
		try {
			const harness = await invocationHarness("terminalize-prompt-while-busy", cwd, {
				sendUserMessage: async (_content, options) => {
					// Session is streaming: sendUserMessage diverts to #queueSteer and resolves.
					await options?.onPreflightAcceptCommit?.();
				},
				isIdle: () => false,
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			// The diverted prompt must NOT report terminal_ok while the turn is still pending.
			const status = await harness.query("turn.prompt_status", { commandId, turnId });
			expect(status.result?.status).toMatch(/accepted|in_flight|unknown/);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("a queued prompt stays non-terminal even if isIdle flips during the accept window", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-race-"));
		let idle = false;
		try {
			const harness = await invocationHarness("terminalize-race", cwd, {
				sendUserMessage: async (_content, options) => {
					// The session is streaming when the submission starts (divert to steer).
					// During accept()->persist(), the prior turn unwinds and isIdle flips to true.
					await options?.onPreflightAcceptCommit?.();
					idle = true;
				},
				isIdle: () => idle,
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			// The snapshot taken at dispatch time (idle=false) must hold: the prompt was
			// queued, so it must not report terminal_ok even though isIdle is now true.
			const status = await harness.query("turn.prompt_status", { commandId, turnId });
			expect(status.result?.status).toMatch(/accepted|in_flight|unknown/);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a pre-acceptance failure rejects the submission without creating a record", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-preflight-"));
		try {
			const harness = await invocationHarness("terminalize-preflight", cwd, {
				sendUserMessage: async () => {
					throw Object.assign(new Error("session is busy"), { code: "busy" });
				},
			});
			const rejected = await harness.control("turn.prompt", { text: "hello", clientRef: "preflight-ref" });
			expect(rejected.ok).toBe(false);
			const status = await harness.query("turn.prompt_status", { clientRef: "preflight-ref" });
			expect(status.result as Record<string, unknown>).toEqual({ status: "unknown", receiptState: "unknown" });
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a later provider error enriches but never re-opens an already terminal prompt", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-once-"));
		try {
			const inflight = Promise.withResolvers<void>();
			const harness = await invocationHarness("terminalize-once", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await inflight.promise;
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			const { commandId, turnId } = accepted.result ?? {};
			await harness.emit("agent_start");
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "completed" }] });
			const claimed = await settledStatus(harness, "turn.prompt_status", { commandId, turnId });
			expect(claimed).toMatchObject({ status: "terminal_ok" });
			inflight.reject(Object.assign(new Error("late provider failure"), { code: "upstream_error" }));
			await Bun.sleep(20);
			// A lifecycle frame arriving after the terminal must not resurrect the record either.
			await harness.emit("agent_start");
			const settled = await harness.query("turn.prompt_status", { commandId, turnId });
			// The late reason attaches to the settled record, so `error` is the only field that may
			// appear; status, terminalAt, and identity stay exactly as claimed.
			const { error: _claimedReason, ...claimedTerminal } = claimed;
			const { error: _lateReason, ...settledTerminal } = settled.result ?? {};
			expect(settledTerminal).toEqual(claimedTerminal);
			// The recorded reason is the sanitized late failure: never fabricated, never raw.
			expect(settled.result?.error).toEqual({ code: "upstream_error", message: "Prompt submission failed." });
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("accepted-control zero-execution bound (#4668)", () => {
	// Short deterministic deadline for the zero-progress lease.
	const zeroProgressSettings = {
		get: (key: string) =>
			key === "sdk.promptDeadlineMs" ? 25 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
	} as unknown as Settings;

	test("an accepted prompt that never reaches agent_start terminalizes with prompt_deadline_exceeded", async () => {
		// Defect repro: the SDK accepts turn.prompt (durable command/turn IDs are
		// returned), but the run wedges between acceptance and agent_start, so
		// session stats stay at zero with no failure surface. Before the fix the
		// deadline lease was only created at agent_start, leaving the record
		// accepted forever; the lease is now anchored at durable acceptance.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-zero-progress-prompt-"));
		try {
			const harness = await invocationHarness("zero-progress-prompt", cwd, {
				settings: zeroProgressSettings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					// Accepted, then permanently no execution progress and no agent_start.
					await neverSettlingPromise();
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			expect(accepted.ok).toBe(true);
			const { commandId, turnId } = accepted.result ?? {};
			expect(commandId).toEqual(expect.any(String));
			expect(turnId).toEqual(expect.any(String));
			// The acceptance receipt alone is not execution: still only "accepted".
			const initial = await harness.query("turn.prompt_status", { commandId, turnId });
			expect(initial.result?.status).toBe("accepted");
			// Bounded zero-progress: the prompt terminalizes with an actionable error.
			expect(await settledStatus(harness, "turn.prompt_status", { commandId, turnId })).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded", message: "Prompt deadline exceeded." },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("an abort_and_prompt replacement of a zero-execution turn is also bounded", async () => {
		// The issue observed both the original turn.prompt AND the replacement
		// turn.abort_and_prompt accepted with permanently zero activity. Both the
		// superseded original and the replacement must terminalize with an
		// actionable error instead of remaining accepted forever.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-zero-progress-replacement-"));
		try {
			const harness = await invocationHarness("zero-progress-replacement", cwd, {
				settings: zeroProgressSettings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const original = await harness.control("turn.prompt", { text: "original" });
			expect(original.ok).toBe(true);
			const replacement = await harness.control("turn.abort_and_prompt", { text: "replacement" });
			expect(replacement.ok).toBe(true);
			const originalIds = { commandId: original.result?.commandId, turnId: original.result?.turnId };
			const replacementIds = { commandId: replacement.result?.commandId, turnId: replacement.result?.turnId };
			expect(replacementIds.commandId).toEqual(expect.any(String));
			expect(await settledStatus(harness, "turn.prompt_status", originalIds)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
			});
			expect(await settledStatus(harness, "turn.prompt_status", replacementIds)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("every promoted follow-up in a drained batch receives a zero-progress lease", async () => {
		// Red-team finding (#4668): agent_start leased only the head of the
		// drained batch, so follow-ups promoted together beyond the head had no
		// deadline and could remain accepted with zero execution forever.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-lease-batch-"));
		try {
			const promoted: Array<((promotion: { startsOwnRun: boolean }) => void) | undefined> = [];
			const harness = await invocationHarness("lease-batch", cwd, {
				settings: zeroProgressSettings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					if ((options as { deliverAs?: string } | undefined)?.deliverAs === "followUp") {
						promoted.push(
							(options as { onQueuedPromoted?: (promotion: { startsOwnRun: boolean }) => void } | undefined)
								?.onQueuedPromoted,
						);
						return;
					}
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			const followUpB = await harness.control("turn.follow_up", { text: "b" });
			const followUpC = await harness.control("turn.follow_up", { text: "c" });
			expect(followUpB.ok).toBe(true);
			expect(followUpC.ok).toBe(true);
			expect(promoted).toHaveLength(2);
			// The unwind promotes both queued follow-ups into ONE run: a single
			// agent_start drains the batch.
			promoted[0]?.({ startsOwnRun: true });
			promoted[1]?.({ startsOwnRun: true });
			await harness.emit("agent_start");
			const idsB = { commandId: followUpB.result?.commandId, turnId: followUpB.result?.turnId };
			const idsC = { commandId: followUpC.result?.commandId, turnId: followUpC.result?.turnId };
			for (const ids of [idsB, idsC]) {
				expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
					status: "failed",
					error: { code: "prompt_deadline_exceeded" },
				});
			}
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("agent_failed reaches every prompt in the active drained batch", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-failed-batch-"));
		try {
			const promoted: Array<((promotion: { startsOwnRun: boolean }) => void) | undefined> = [];
			const harness = await invocationHarness("failed-batch", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					if ((options as { deliverAs?: string } | undefined)?.deliverAs === "followUp") {
						promoted.push(
							(options as { onQueuedPromoted?: (promotion: { startsOwnRun: boolean }) => void } | undefined)
								?.onQueuedPromoted,
						);
					}
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "completed" }] });
			const followUpB = await harness.control("turn.follow_up", { text: "b" });
			const followUpC = await harness.control("turn.follow_up", { text: "c" });
			promoted[0]?.({ startsOwnRun: true });
			promoted[1]?.({ startsOwnRun: true });
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider failed"), { code: "provider_unavailable" }),
			});
			await harness.emit("agent_end");
			for (const response of [followUpB, followUpC]) {
				const ids = { commandId: response.result?.commandId, turnId: response.result?.turnId };
				expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
					status: "failed",
					error: { code: "provider_unavailable" },
				});
			}
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a non-empty agent_start re-entry preserves the replaced turn's lease and leases the replacement", async () => {
		// Red-team finding (#4668): a second agent_start without a prior agent_end
		// replaces the tracked invocation. The replaced turn's acceptance lease
		// must be retained (clearing it would leave its record accepted with no
		// zero-progress bound) and the replacement must be leased too.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-lease-reentry-"));
		try {
			let promoted: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
			const harness = await invocationHarness("lease-reentry", cwd, {
				settings: zeroProgressSettings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					if ((options as { deliverAs?: string } | undefined)?.deliverAs === "followUp") {
						promoted = (
							options as { onQueuedPromoted?: (promotion: { startsOwnRun: boolean }) => void } | undefined
						)?.onQueuedPromoted;
						return;
					}
					// The first turn accepts and then never makes progress.
					await neverSettlingPromise();
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			const followUp = await harness.control("turn.follow_up", { text: "replacement" });
			expect(followUp.ok).toBe(true);
			promoted?.({ startsOwnRun: true });
			// Re-entry with a non-empty drain while the first turn never ended.
			await harness.emit("agent_start");
			const idsFirst = { commandId: first.result?.commandId, turnId: first.result?.turnId };
			const idsFollowUp = { commandId: followUp.result?.commandId, turnId: followUp.result?.turnId };
			expect(await settledStatus(harness, "turn.prompt_status", idsFirst)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
			});
			expect(await settledStatus(harness, "turn.prompt_status", idsFollowUp)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a promoted follow-up that never reaches agent_start terminalizes with prompt_deadline_exceeded", async () => {
		// Review finding (#4668 P1): before the promotion-boundary lease, a queued
		// follow-up that was durably accepted and promoted but whose agent_start
		// never arrived had no lease and stayed accepted indefinitely.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-promote-no-start-"));
		try {
			let promoted: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
			const harness = await invocationHarness("promote-no-start", cwd, {
				settings: zeroProgressSettings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					if ((options as { deliverAs?: string } | undefined)?.deliverAs === "followUp") {
						promoted = (
							options as { onQueuedPromoted?: (promotion: { startsOwnRun: boolean }) => void } | undefined
						)?.onQueuedPromoted;
						return;
					}
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			const followUp = await harness.control("turn.follow_up", { text: "promoted" });
			expect(followUp.ok).toBe(true);
			// Promotion to its own run fires, but the run's agent_start never arrives.
			promoted?.({ startsOwnRun: true });
			const ids = { commandId: followUp.result?.commandId, turnId: followUp.result?.turnId };
			expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("tool progress renews the deadlines of every correlation attached to the active run", async () => {
		// Review finding (#4668): progress renewal covered only the head
		// invocation, so an in-run consumed correlation sharing a long run would
		// false-fire prompt_deadline_exceeded before the shared agent_end.
		// Production dispatch of the in-run consumption itself is covered by
		// agent-session-promotion-identity.test.ts; this exercises the runtime
		// renewal wiring at the SDK boundary.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-renew-attached-"));
		try {
			let promoted: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
			const harness = await invocationHarness("renew-attached", cwd, {
				settings: zeroProgressSettings,
				sendUserMessage: async (content, options) => {
					await options?.onPreflightAcceptCommit?.();
					if (content === "consumed") {
						promoted = (
							options as { onQueuedPromoted?: (promotion: { startsOwnRun: boolean }) => void } | undefined
						)?.onQueuedPromoted;
						return;
					}
					await neverSettlingPromise();
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			const consumed = await harness.control("turn.follow_up", { text: "consumed" });
			expect(consumed.ok).toBe(true);
			promoted?.({ startsOwnRun: false });
			const ids = { commandId: consumed.result?.commandId, turnId: consumed.result?.turnId };
			// Past the 25ms lease, repeated tool activity keeps the attached
			// correlation alive: without renewal it would already be
			// prompt_deadline_exceeded by the first sleep boundary.
			for (let i = 0; i < 3; i += 1) {
				await harness.emit("tool_execution_start");
				await Bun.sleep(15);
			}
			const midRun = await harness.query("turn.prompt_status", ids);
			expect(midRun.result?.status).not.toBe("failed");
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "completed" }] });
			const final = await harness.query("turn.prompt_status", ids);
			expect(final.result?.status).toBe("terminal_ok");
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("an in-run consumed follow-up is not parked for an unrelated later agent_start", async () => {
		// Review finding (#4668 P1): a follow-up consumed inside the running turn
		// used to be appended to pending; a later unrelated agent_start would
		// drain the stale correlation, mis-assign abort ownership, and could
		// fabricate a prompt_deadline_exceeded. The consumed submission must
		// attach to the in-flight run and terminalize with it instead.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-inrun-consume-"));
		let idle = true;
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		let promoted: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: async (
				content: string,
				options:
					| {
							onPreflightAcceptCommit?: () => Promise<void>;
							onQueuedPromoted?: (promotion: { startsOwnRun?: boolean; removed?: boolean }) => void;
					  }
					| undefined,
			) => {
				await options?.onPreflightAcceptCommit?.();
				if (content === "consumed") {
					promoted = options?.onQueuedPromoted;
					return;
				}
				await neverSettlingPromise();
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "inrun-handle",
				getActivePromptOwnerConnectionId: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = { ...extensionContext(transport.sessionId, cwd), isIdle: () => idle } as ExtensionContext;
		const waitFrame = async (id: string) => {
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === id)) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
				await Bun.sleep(20);
			}
			return transport.sent.find(frame => frame.id === id);
		};
		try {
			await handlers.get("session_start")?.({}, ctx);
			// conn-a's prompt starts its run and streams.
			transport.feed("conn-a", {
				type: "control_request",
				id: "inrun-a",
				operation: "turn.prompt",
				input: { text: "running" },
			} as SdkFrame);
			await waitFrame("inrun-a");
			idle = false;
			await handlers.get("agent_start")?.({}, ctx);
			// conn-b's prompt is queued while streaming, then CONSUMED inside the
			// running turn (no new agent_start for it).
			transport.feed("conn-b", {
				type: "control_request",
				id: "inrun-b",
				operation: "turn.prompt",
				input: { text: "consumed" },
			} as SdkFrame);
			const acceptedB = (await waitFrame("inrun-b")) as { result?: { commandId?: string; turnId?: string } };
			promoted?.({ startsOwnRun: false });
			// The consuming run ends. The consumed submission must terminalize
			// WITH it (terminal_ok, never a fabricated prompt_deadline_exceeded):
			// with the bug it would still be parked in pending as merely accepted.
			await handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: "completed" }] }, ctx);
			const statusOf = async (ids: { commandId?: string; turnId?: string }, frameId: string) => {
				transport.feed("conn-a", {
					type: "query_request",
					id: frameId,
					query: "turn.prompt_status",
					input: ids,
				} as SdkFrame);
				return (await waitFrame(frameId)) as { result?: { status?: string; error?: { code?: string } } };
			};
			const idsB = { commandId: acceptedB.result?.commandId, turnId: acceptedB.result?.turnId };
			expect((await statusOf(idsB, "inrun-status-b")).result?.status).toBe("terminal_ok");
			// A separate later turn starts: the consumed correlation must NOT be
			// drained into it, so conn-b owns nothing and its abort is refused.
			transport.feed("conn-c", {
				type: "control_request",
				id: "inrun-c",
				operation: "turn.prompt",
				input: { text: "later" },
			} as SdkFrame);
			await waitFrame("inrun-c");
			await handlers.get("agent_start")?.({}, ctx);
			transport.feed("conn-b", {
				type: "control_request",
				id: "inrun-abort-b",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "inrun-abort-b-key",
			} as SdkFrame);
			expect(await waitFrame("inrun-abort-b")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a prompt diverted to steering by the dispatch race is not terminalized before consumption", async () => {
		// Exact-head review (#4668 P1): isIdle() is sampled before dispatch, but a
		// stream can begin before sendUserMessage() runs. The diverted submission
		// resolves at queue time with no promotion hook fired yet; the settlement
		// path must NOT treat it as an own-run completion. The synchronous
		// in-run disposition (startsOwnRun:false, reported by agent-session at
		// the divert) attaches the correlation to the in-flight run instead, and
		// it terminalizes with that run's agent_end.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-dispatch-race-"));
		try {
			const harness = await invocationHarness("dispatch-race", cwd, {
				sendUserMessage: async (content, options) => {
					await options?.onPreflightAcceptCommit?.();
					if (content === "raced") {
						// Production divert: agent-session reports the actual queue
						// disposition synchronously when the plain prompt lands in the
						// steering queue of a session that started streaming mid-dispatch.
						(
							options as { onQueuedPromoted?: (promotion: { startsOwnRun: boolean }) => void } | undefined
						)?.onQueuedPromoted?.({ startsOwnRun: false });
						return;
					}
					// The first turn accepts and then keeps streaming.
					await neverSettlingPromise();
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			const raced = await harness.control("turn.prompt", { text: "raced" });
			expect(raced.ok).toBe(true);
			const idsRaced = { commandId: raced.result?.commandId, turnId: raced.result?.turnId };
			// Settlement ran (the submission resolved) but the raced prompt must
			// still be non-terminal: with the bug it was already agent_end here.
			const midRun = await harness.query("turn.prompt_status", idsRaced);
			expect(midRun.result?.status).not.toBe("terminal_ok");
			expect(midRun.result?.status).not.toBe("failed");
			// The in-flight run ends: the diverted correlation terminalizes with it.
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "completed" }] });
			expect(await settledStatus(harness, "turn.prompt_status", idsRaced)).toMatchObject({
				status: "terminal_ok",
			});
			const idsFirst = { commandId: first.result?.commandId, turnId: first.result?.turnId };
			expect(await settledStatus(harness, "turn.prompt_status", idsFirst)).toMatchObject({
				status: "terminal_ok",
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("the dispatch-race diverted prompt drops its acceptance-anchored lease until consumption", async () => {
		// Concurrency review (#4668 P1): the idle snapshot leased this prompt at
		// acceptance, but the divert placed it in the steering queue where
		// nothing renews the lease. It must NOT false-fire
		// prompt_deadline_exceeded while legitimately queued; the lease returns
		// at the real consumption boundary.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-dispatch-race-lease-"));
		try {
			let consumed: ((promotion: { startsOwnRun?: boolean }) => void) | undefined;
			const harness = await invocationHarness("dispatch-race-lease", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 25 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (content, options) => {
					await options?.onPreflightAcceptCommit?.();
					if (content === "raced") {
						// Production divert: agent-session reports the in-run
						// disposition synchronously; consumption happens later.
						(
							options as { onDispatchDisposition?: (promotion: { startsOwnRun: boolean }) => void } | undefined
						)?.onDispatchDisposition?.({ startsOwnRun: false });
						consumed = (
							options as { onQueuedPromoted?: (promotion: { startsOwnRun?: boolean }) => void } | undefined
						)?.onQueuedPromoted;
						return;
					}
					// The first turn accepts and then keeps streaming.
					await neverSettlingPromise();
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			const raced = await harness.control("turn.prompt", { text: "raced" });
			expect(raced.ok).toBe(true);
			const idsRaced = { commandId: raced.result?.commandId, turnId: raced.result?.turnId };
			// Far past the 25ms lease while queued: the acceptance-anchored lease
			// was dropped at the divert disposition, so no false deadline fire.
			await Bun.sleep(120);
			const queued = await harness.query("turn.prompt_status", idsRaced);
			expect(queued.result?.status).not.toBe("failed");
			// Real consumption re-leases and attaches to the in-flight run.
			consumed?.({ startsOwnRun: false });
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "completed" }] });
			expect(await settledStatus(harness, "turn.prompt_status", idsRaced)).toMatchObject({
				status: "terminal_ok",
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a queued prompt removed before consumption terminalizes as a bounded failure", async () => {
		// Lifecycle review (#4668 P1): queue.message.remove, queue editing,
		// clearQueue, and the abort purge drop queued messages without
		// consumption. The accepted submission must terminalize as a bounded
		// client-visible failure instead of staying accepted forever.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-queue-removed-"));
		try {
			let promoted: ((promotion: { startsOwnRun?: boolean; removed?: boolean }) => void) | undefined;
			const harness = await invocationHarness("queue-removed", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					promoted = (
						options as { onQueuedPromoted?: (promotion: { startsOwnRun?: boolean; removed?: boolean }) => void }
					)?.onQueuedPromoted;
					// Queued as steer: resolves at queue time, never runs.
				},
				isIdle: () => false,
			});
			const queued = await harness.control("turn.prompt", { text: "queued" });
			expect(queued.ok).toBe(true);
			const ids = { commandId: queued.result?.commandId, turnId: queued.result?.turnId };
			expect(promoted).toBeDefined();
			// The message is removed from the steering queue without consumption.
			promoted?.({ startsOwnRun: false, removed: true });
			expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
				status: "failed",
				error: { code: "cancelled" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("deadline recovery preserves a failed run reason when agent_failed and agent_end re-record writes fail", async () => {
		// Exact-head review P1: a failed agent_failed write followed by a
		// successful agent_end used to classify the run terminal_ok. The
		// boundary now replays the sanitized reason first.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-end-reason-replay-"));
		let failedWrites = 0;
		try {
			const harness = await invocationHarness("end-reason-replay", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 25 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				persistInterceptor: transition => {
					if (transition.type === "agent_failed") {
						failedWrites += 1;
						throw Object.assign(new Error("injected persistence failure"), { code: "io_error" });
					}
				},
				agentFailedWriteFailures: 2,
			});
			const submitted = await harness.control("turn.prompt", { text: "run", clientRef: "end-reason-ref" });
			expect(submitted.ok).toBe(true);
			await harness.emit("agent_start");
			// The first agent_failed write and the agent_end re-record both fail.
			// The deadline owner must retain the sanitized reason and replay the
			// compound reason+boundary transition after persistence recovers.
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider exploded"), { code: "provider_unavailable" }),
			});
			await harness.emit("agent_end");
			const settled = await settledStatus(harness, "turn.prompt_status", { clientRef: "end-reason-ref" });
			expect(failedWrites).toBeGreaterThan(0);
			expect(settled.status).toBe("failed");
			expect(settled.error?.code).toBe("provider_unavailable");
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a rejected skill terminalizes failed after a transient persistence failure", async () => {
		// Exact-head review P1: skills have no deadline lease, so when an accepted
		// skill.invoke rejects and the first agent_failed write fails transiently,
		// the recovery must be a bounded kind-aware retry that keeps the compound
		// reason-then-boundary order — never a stranded accepted row and never
		// terminal_ok.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-skill-rejection-"));
		let failedWrites = 0;
		try {
			const harness = await invocationHarness("skill-rejection", cwd, {
				invokeSkill: async (_name, _args, options) => {
					await options?.onPreflightAcceptCommit?.();
					throw Object.assign(new Error("skill exploded after acceptance"), { code: "skill_runtime" });
				},
				persistInterceptor: transition => {
					if (transition.type === "agent_failed") {
						failedWrites += 1;
						throw Object.assign(new Error("injected persistence failure"), { code: "io_error" });
					}
				},
			});
			const submitted = await harness.control("skill.invoke", {
				name: "explode",
				args: "",
				clientRef: "skill-rejection-ref",
			});
			expect(submitted.ok).toBe(true);
			// Skills surface through skill.invoke_status (kind coerced to skill).
			let settled: { status?: string; error?: { code?: string } } | undefined;
			for (let attempt = 0; attempt < 600 && settled === undefined; attempt += 1) {
				const frame = await harness.query("skill.invoke_status", { clientRef: "skill-rejection-ref" });
				const result = frame.result as { status?: string; error?: { code?: string } } | undefined;
				if (result && (result.status === "failed" || result.status === "terminal_ok")) settled = result;
				else await Bun.sleep(10);
			}
			if (settled === undefined) throw new Error("skill rejection never reported a terminal reconciliation status");
			expect(failedWrites).toBeGreaterThan(0);
			expect(settled.status).toBe("failed");
			expect(settled.error?.code).toBe("skill_runtime");
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("an active skill keeps retrying a failed terminal persistence boundary", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-skill-terminal-retry-"));
		let failedWrites = 0;
		try {
			const harness = await invocationHarness("skill-terminal-retry", cwd, {
				invokeSkill: async (_name, _args, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				persistInterceptor: transition => {
					if (transition.type === "agent_end" && failedWrites < 2) {
						failedWrites += 1;
						throw Object.assign(new Error("injected terminal persistence failure"), { code: "io_error" });
					}
				},
			});
			const submitted = await harness.control("skill.invoke", {
				name: "hang",
				args: "",
				clientRef: "skill-terminal-retry-ref",
			});
			expect(submitted.ok).toBe(true);
			await harness.emit("agent_start");
			await harness.emit("agent_end");
			let settled: { status?: string } | undefined;
			for (let attempt = 0; attempt < 500 && settled === undefined; attempt += 1) {
				const frame = await harness.query("skill.invoke_status", { clientRef: "skill-terminal-retry-ref" });
				const result = frame.result as { status?: string } | undefined;
				if (result?.status === "terminal_ok") settled = result;
				else await Bun.sleep(10);
			}
			if (settled === undefined) throw new Error("active skill terminal recovery never converged");
			expect(failedWrites).toBe(2);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("retains skill terminal recovery across session replacement", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-skill-terminal-replacement-"));
		let failFirstTerminalWrite = true;
		try {
			const harness = await invocationHarness("skill-terminal-replacement", cwd, {
				invokeSkill: async (_name, _args, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				persistInterceptor: transition => {
					if (transition.type === "agent_end" && failFirstTerminalWrite) {
						failFirstTerminalWrite = false;
						throw Object.assign(new Error("injected terminal persistence failure"), { code: "io_error" });
					}
				},
			});
			const submitted = await harness.control("skill.invoke", {
				name: "replacement-hang",
				args: "",
				clientRef: "skill-terminal-replacement-ref",
			});
			expect(submitted.ok).toBe(true);
			await harness.emit("agent_start");
			await harness.emit("agent_end");
			await Bun.sleep(50);
			await harness.switchSession("skill-terminal-replacement-next");
			await Bun.sleep(1_100);
			let settled: { status?: string; error?: { code?: string } } | undefined;
			for (let attempt = 0; attempt < 500 && settled === undefined; attempt += 1) {
				const frame = await harness.query("skill.invoke_status", { clientRef: "skill-terminal-replacement-ref" });
				const result = frame.result as { status?: string; error?: { code?: string } } | undefined;
				if (result?.status === "terminal_ok" || result?.status === "failed") settled = result;
				else await Bun.sleep(10);
			}
			expect(settled?.status).toBe("terminal_ok");
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a rejected prompt replays its failure reason, never a bare terminal_ok", async () => {
		// Exact-head review HIGH: after failed agent_failed persistence, recovery
		// replayed only agent_end, so an abandoned/rejected prompt became durable
		// terminal_ok and lost its failure reason. Inject persistence failures for
		// EVERY agent_failed write so the outcome can only come from the compound
		// manager replay, and a bare agent_end could never see an error.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-rejection-replay-"));
		let failedWrites = 0;
		try {
			const harness = await invocationHarness("rejection-replay", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 25 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					throw Object.assign(new Error("provider failed after acceptance"), { code: "provider_unavailable" });
				},
				persistInterceptor: transition => {
					if (transition.type === "agent_failed") {
						failedWrites += 1;
						throw Object.assign(new Error("injected persistence failure"), { code: "io_error" });
					}
				},
			});
			const submitted = await harness.control("turn.prompt", { text: "reject-me", clientRef: "rejection-ref" });
			expect(submitted.ok).toBe(true);
			const ids = { clientRef: "rejection-ref" };
			const settled = await settledStatus(harness, "turn.prompt_status", ids);
			// The compound replay re-recorded the reason before the boundary:
			// failed/provider_unavailable, never terminal_ok, and never a bare
			// agent_end classification.
			expect(failedWrites).toBeGreaterThan(0);
			expect(settled.status).toBe("failed");
			expect(settled.error?.code).toBe("provider_unavailable");
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a removed queued prompt records its cancellation reason before the terminal boundary", async () => {
		// Exact-head review #4: a failed agent_failed write followed by a
		// successful agent_end used to terminalize the cancellation as
		// terminal_ok (no error on the row). The reason must be durable first;
		// a failed reason write must never fall through to agent_end.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-removed-reason-"));
		try {
			let promoted: ((promotion: { startsOwnRun?: boolean; removed?: boolean }) => void) | undefined;
			const harness = await invocationHarness("removed-reason", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					promoted = (
						options as { onQueuedPromoted?: (promotion: { startsOwnRun?: boolean; removed?: boolean }) => void }
					)?.onQueuedPromoted;
				},
				isIdle: () => false,
			});
			const queued = await harness.control("turn.prompt", { text: "queued" });
			expect(queued.ok).toBe(true);
			const ids = { commandId: queued.result?.commandId, turnId: queued.result?.turnId };
			promoted?.({ startsOwnRun: false, removed: true });
			expect(await settledStatus(harness, "turn.prompt_status", ids)).toMatchObject({
				status: "failed",
				error: { code: "cancelled" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("an in-run attached correlation inherits the shared run's agent_failed diagnostic", async () => {
		// Exact-head review P1: agent_failed previously transitioned only the head
		// invocation, so a failed shared run's ATTACHED submissions reached agent_end
		// with no error and were marked terminal_ok.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-attached-failed-"));
		try {
			let promoted: ((promotion: { startsOwnRun?: boolean }) => void) | undefined;
			const harness = await invocationHarness("attached-failed", cwd, {
				sendUserMessage: async (content, options) => {
					await options?.onPreflightAcceptCommit?.();
					if (content === "attached") {
						promoted = (
							options as { onQueuedPromoted?: (promotion: { startsOwnRun?: boolean }) => void } | undefined
						)?.onQueuedPromoted;
						return;
					}
					await neverSettlingPromise();
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			const attached = await harness.control("turn.follow_up", { text: "attached" });
			expect(attached.ok).toBe(true);
			promoted?.({ startsOwnRun: false });
			const idsAttached = { commandId: attached.result?.commandId, turnId: attached.result?.turnId };
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider unavailable"), { code: "provider_unavailable" }),
			});
			await harness.emit("agent_end");
			expect(await settledStatus(harness, "turn.prompt_status", idsAttached)).toMatchObject({
				status: "failed",
				error: { code: "provider_unavailable" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("agent_failed is diagnostic until agent_end terminalizes the run", async () => {
		// Exact-head review (#4668 P1): agent_failed is an additive diagnostic;
		// ownership, lifecycle state, and the deadline remain until agent_end.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-agent-failed-"));
		try {
			const harness = await invocationHarness("agent-failed", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					// The failing turn accepts and then never makes progress on its own.
					await neverSettlingPromise();
				},
			});
			const failing = await harness.control("turn.prompt", { text: "failing" });
			expect(failing.ok).toBe(true);
			const idsFailing = { commandId: failing.result?.commandId, turnId: failing.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider unavailable"), { code: "provider_unavailable" }),
			});
			const diagnosticFrames = harness.broadcasts.filter(frame => frame.kind === "agent_failed");
			expect(diagnosticFrames).toHaveLength(1);
			expect(diagnosticFrames[0]).toMatchObject({
				kind: "agent_failed",
				payload: {
					type: "agent_failed",
					sessionId: "agent-failed",
					...idsFailing,
					error: { code: "provider_unavailable", message: "Prompt submission failed." },
				},
			});
			expect(JSON.stringify(diagnosticFrames[0])).not.toContain("provider unavailable");
			expect((await harness.query("turn.prompt_status", idsFailing)).result?.status).toBe("in_flight");
			await harness.emit("agent_end");
			expect(await settledStatus(harness, "turn.prompt_status", idsFailing)).toMatchObject({
				status: "failed",
				error: { code: "provider_unavailable" },
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("an accepted prompt that settles before agent_start cannot mis-own a later turn", async () => {
		// Red-team finding (#4668): a successful own-turn submission resolving
		// after acceptance but before agent_start left its pending ownership
		// entry behind, so a later agent_start drained the stale entry and made
		// the old requester an owner of a turn it did not start.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-settle-early-owner-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: async (
				content: string,
				options: { onPreflightAcceptCommit?: () => Promise<void> } | undefined,
			) => {
				await options?.onPreflightAcceptCommit?.();
				if (content === "hangs") await neverSettlingPromise();
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		const seamCalls: Array<{ handle: string; scope: string }> = [];
		createSdkSessionRuntimeExtension(api, {
			agentDir: cwd,
			createTransport: async () => transport,
			terminalAbortSeams: {
				getReconciliationStore: () => reconciliationStore,
				getTerminalTurnEpoch: () => 7,
				getActivePromptHandle: () => "settle-early-handle",
				getActivePromptOwnerConnectionId: () => undefined,
				cancelPendingPreflightForTerminalAbort: () => {},
				abortPromptAndWaitWithTerminal: async (handle, options) => {
					seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
					return { status: "settled", terminalScope: {} };
				},
			},
		});
		const ctx = { ...extensionContext(transport.sessionId, cwd), isIdle: () => true } as ExtensionContext;
		try {
			await handlers.get("session_start")?.({}, ctx);
			const waitFrame = async (id: string) => {
				const deadline = Date.now() + 15_000;
				while (!transport.sent.some(frame => frame.id === id)) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
					await Bun.sleep(20);
				}
				return transport.sent.find(frame => frame.id === id);
			};
			// conn-a's prompt is accepted and settles successfully BEFORE any
			// agent_start: its pending ownership entry must be retired.
			transport.feed("conn-a", {
				type: "control_request",
				id: "settle-early-a",
				operation: "turn.prompt",
				input: { text: "settles" },
			} as SdkFrame);
			const acceptedA = (await waitFrame("settle-early-a")) as { result?: { commandId?: string; turnId?: string } };
			const idsA = { commandId: acceptedA.result?.commandId, turnId: acceptedA.result?.turnId };
			const statusDeadline = Date.now() + 15_000;
			let settledStatus: string | undefined;
			for (;;) {
				transport.feed("conn-a", {
					type: "query_request",
					id: "settle-early-status",
					query: "turn.prompt_status",
					input: idsA,
				} as SdkFrame);
				const statusFrame = (await waitFrame("settle-early-status")) as {
					result?: { status?: string };
				};
				transport.sent.splice(transport.sent.indexOf(statusFrame), 1);
				settledStatus = statusFrame.result?.status;
				if (statusFrame.result?.status === "terminal_ok" || statusFrame.result?.status === "failed") break;
				if (Date.now() > statusDeadline) throw new Error("settled prompt never reported terminal_ok");
				await Bun.sleep(20);
			}
			expect(settledStatus).toBe("failed");
			// conn-b's prompt is accepted and hangs; its run then starts.
			transport.feed("conn-b", {
				type: "control_request",
				id: "settle-early-b",
				operation: "turn.prompt",
				input: { text: "hangs" },
			} as SdkFrame);
			await waitFrame("settle-early-b");
			await handlers.get("agent_start")?.({}, ctx);
			// conn-a must NOT be an owner of conn-b's turn.
			transport.feed("conn-a", {
				type: "control_request",
				id: "settle-early-abort-a",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "settle-early-abort-a-key",
			} as SdkFrame);
			expect(await waitFrame("settle-early-abort-a")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "no_active_turn" }),
			});
			expect(seamCalls).toHaveLength(0);
			// conn-b owns its turn and can terminal-abort it.
			transport.feed("conn-b", {
				type: "control_request",
				id: "settle-early-abort-b",
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: "settle-early-abort-b-key",
			} as SdkFrame);
			expect(await waitFrame("settle-early-abort-b")).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
			expect(seamCalls).toEqual([{ handle: "settle-early-handle", scope: "turn" }]);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("goal.list/get on a session without a goal returns a diagnostic state, not resource_gone", async () => {
		// During the zero-activity incident goal.list/get degraded to a bare
		// resource_gone ("snapshot payload is unavailable"), which was
		// indistinguishable from snapshot-store corruption. The query must remain
		// available with a diagnostically useful payload.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-goal-diagnostic-"));
		try {
			const harness = await invocationHarness("goal-diagnostic", cwd, {});
			const frame = await harness.query("goal.list/get", {});
			expect(frame.ok).toBe(true);
			const page = (frame as unknown as { page?: { items?: unknown[]; complete?: boolean } }).page;
			expect(page?.complete).toBe(true);
			expect(page?.items?.[0]).toMatchObject({
				enabled: false,
				goal: null,
				reason: "no_active_goal",
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

test("SDK-only host never advances a finalized uncertain row for a mismatched replayed payload", async () => {
	// Review thread P2: before the payload-hash fix, an uncertain/no-effect row
	// kept the input-hash placeholder, and the response-state advance trusted
	// ANY non-pending placeholder — so a same-key retry whose response differed
	// from the original (e.g. pending_replay delivered late) could mark the
	// durable row sent. Finalization now stores the EXACT final payload hash,
	// so a mismatched delivery must leave the row pending.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-uncertain-payload-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	const seamCalls: Array<{ handle: string; scope: string }> = [];
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			getActivePromptOwnerConnectionId: () => "client",
			cancelPendingPreflightForTerminalAbort: () => {},
			abortPromptAndWaitWithTerminal: async (handle, options) => {
				seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
				return { status: "settled", terminalScope: {} };
			},
		},
	});
	const ctx = extensionContext(transport.sessionId, cwd);
	try {
		await handlers.get("session_start")?.({}, ctx);
		const keyHash = createHash("sha256").update("uncertain-key").digest("hex");
		const inputHash = createHash("sha256")
			.update(JSON.stringify({ mode: "terminal", scope: "turn" }))
			.digest("hex");
		// Seed a FINALIZED uncertain row with responseState still pending (the
		// original response was never delivered). Post-fix finalization stores
		// the exact payload hash; simulating the pre-fix placeholder state must
		// not let a mismatched retry delivery advance the row.
		await reconciliationStore.transactTerminalState(state => ({
			scopes: [
				{
					selection: "turn",
					idempotencyKeyHash: keyHash,
					idempotencyInputHash: inputHash,
					turnDisposition: "uncertain",
					terminalPublished: false,
					ownedWorkDisposition: "uncertain",
					automaticDeliveryDisposition: "none",
					resumeOnOwnedCompletion: false,
					turnContinuationFence: {
						state: "retained",
						abortedAttemptEpoch: 0,
						blockedContinuationIds: [],
						predecessorTombstones: [],
						ownedCompletionPolicy: "disabled",
					},
					responseState: "pending",
					responsePayloadHash: inputHash,
					acceptedAt: Date.now(),
				},
				...state.scopes,
			],
			keys: state.keys,
		}));
		transport.feed("client", {
			type: "control_request",
			id: "uncertain-replay",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "uncertain-key",
		} as SdkFrame);
		const deadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "uncertain-replay" && frame.type === "control_response")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the uncertain-row replay");
			await Bun.sleep(20);
		}
		// The retry replays the finalized row (its payload differs from the
		// seeded placeholder), so the delivery must NOT advance the row.
		await Bun.sleep(50);
		expect(reconciliationStore.snapshotTerminalScopes()[0]!.responseState).toBe("pending");
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host FIFO-expires tombstones instead of failing the finalization at the cap", async () => {
	// Review thread P2: a long-lived session fills the evicted-key tombstone
	// collection with unique terminal-abort keys. The next finalization must
	// FIFO-expire the oldest tombstones instead of throwing — the destructive
	// stop may already have succeeded, and throwing would leave the client
	// with an error and its durable row pending, with subsequent aborts
	// repeating the failure.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-tombstone-cap-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			getActivePromptOwnerConnectionId: () => undefined,
			cancelPendingPreflightForTerminalAbort: () => {},
			abortPromptAndWaitWithTerminal: async (_handle, _options) => ({ status: "settled", terminalScope: {} }),
		},
	});
	const ctx = extensionContext(transport.sessionId, cwd);
	try {
		await handlers.get("session_start")?.({}, ctx);
		// Fill the tombstone collection to the 4096 cap.
		await reconciliationStore.transactTerminalState(state => ({
			scopes: state.scopes,
			keys: Array.from({ length: 4096 }, (_, i) => ({
				keyHash: createHash("sha256").update(`cap-key-${i}`).digest("hex"),
				inputHash: createHash("sha256").update(`cap-input-${i}`).digest("hex"),
				turnDisposition: "stopped" as const,
				ownedWorkDisposition: "left_running" as const,
				responseState: "pending" as const,
				responsePayloadHash: createHash("sha256").update("p").digest("hex"),
			})),
		}));
		// The next idle abort finalizes a no-effect reservation: the oldest
		// tombstone expires instead of the finalization throwing.
		transport.feed("client", {
			type: "control_request",
			id: "cap-abort",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "cap-abort-key",
		} as SdkFrame);
		const deadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "cap-abort" && frame.type === "control_response")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the cap abort response");
			await Bun.sleep(20);
		}
		expect(transport.sent.find(frame => frame.id === "cap-abort")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "no_active_turn", terminal: "terminal_no_effect" }),
		});
		// The collection stays bounded at the cap.
		expect(reconciliationStore.snapshotTerminalKeys()).toHaveLength(4096);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host cancels only the aborting requester's preflight while another connection is admitted", async () => {
	// Review thread P1: a queued requester's terminal abort rejects its own
	// wrapper callback but must NOT invoke the session-wide preflight abort
	// while another connection has an active pending admission — the seam
	// cancels the session's single controller, which would kill the other
	// connection's preflight while the aborting requester's queued admission
	// may still start on the newly reset controller.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-preflight-scope-"));
	let seamCancels = 0;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: async (_content: string, options: { onPreflightAcceptCommit?: () => Promise<void> }) => {
			await options?.onPreflightAcceptCommit?.();
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			getActivePromptOwnerConnectionId: () => undefined,
			cancelPendingPreflightForTerminalAbort: () => {
				seamCancels++;
			},
			abortPromptAndWaitWithTerminal: async (_handle, _options) => ({ status: "settled", terminalScope: {} }),
		},
	});
	const ctx = extensionContext(transport.sessionId, cwd);
	try {
		await handlers.get("session_start")?.({}, ctx);
		const waitResponse = async (id: string) => {
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
				await Bun.sleep(20);
			}
		};
		// Two connections admit prompts while idle; both preflights are pending.
		transport.feed("conn-a", {
			type: "control_request",
			id: "preflight-a",
			operation: "turn.prompt",
			input: { text: "a" },
		} as SdkFrame);
		await waitResponse("preflight-a");
		transport.feed("conn-b", {
			type: "control_request",
			id: "preflight-b",
			operation: "turn.prompt",
			input: { text: "b" },
		} as SdkFrame);
		await waitResponse("preflight-b");
		// Conn B terminal-aborts before its run starts: only B's wrapper
		// preflight may be cancelled; A's active preflight must survive.
		transport.feed("conn-b", {
			type: "control_request",
			id: "preflight-abort-b",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "preflight-abort-b-key",
		} as SdkFrame);
		await waitResponse("preflight-abort-b");
		// The session-wide seam was never invoked while another connection's
		// preflight was pending — only the aborting requester's wrapper
		// callback was rejected.
		expect(seamCancels).toBe(0);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host keeps the idle-submitted prompt's owner when isIdle flips during the accept window", async () => {
	// Review thread P1: the production AgentSession begins its in-flight
	// bookkeeping BEFORE the preflight acceptance callback, so re-reading
	// isIdle() inside accept() would observe the session as already streaming
	// and record no pending owner — the submitting connection could then never
	// terminal-abort its own prompt (the abort would report no_active_turn and
	// ACP would treat the cancellation as unacknowledged). The startsOwnTurn
	// decision must come from the PRE-DISPATCH idle snapshot.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-startsown-snapshot-"));
	let idle = true;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: async (_content: string, options: { onPreflightAcceptCommit?: () => Promise<void> }) => {
			await options?.onPreflightAcceptCommit?.();
			// The session's in-flight bookkeeping begins during the accept
			// window: a re-read of isIdle() now reports streaming.
			idle = false;
			// Production-faithful: the accepted run stays in-flight; sendUserMessage
			// resolution (turn completion) never precedes agent_start (#4668
			// success-retirement).
			await neverSettlingPromise();
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			getActivePromptOwnerConnectionId: () => undefined,
			cancelPendingPreflightForTerminalAbort: () => {},
			abortPromptAndWaitWithTerminal: async () => ({ status: "settled", terminalScope: {} }),
		},
	});
	const ctx = { ...extensionContext(transport.sessionId, cwd), isIdle: () => idle } as ExtensionContext;
	try {
		await handlers.get("session_start")?.({}, ctx);
		transport.feed("client", {
			type: "control_request",
			id: "idle-owner-prompt",
			operation: "turn.prompt",
			input: { text: "hello" },
		} as SdkFrame);
		const deadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "idle-owner-prompt" && frame.type === "control_response")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the idle prompt acceptance");
			await Bun.sleep(20);
		}
		expect(transport.sent.find(frame => frame.id === "idle-owner-prompt")).toMatchObject({ ok: true });
		// The run starts: the dispatch-time idle snapshot recorded the pending
		// owner for the submitting connection.
		await handlers.get("agent_start")?.({}, ctx);
		transport.feed("client", {
			type: "control_request",
			id: "idle-owner-abort",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "idle-owner-abort-key",
		} as SdkFrame);
		const abortDeadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "idle-owner-abort" && frame.type === "control_response")) {
			if (Date.now() > abortDeadline) throw new Error("Timed out waiting for the idle-prompt abort");
			await Bun.sleep(20);
		}
		expect(transport.sent.find(frame => frame.id === "idle-owner-abort")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "stopped" }),
		});
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host advances a finalized stopped row when the retry replay matches the stored replay hash", async () => {
	// Review thread P2: a row finalized with responseState still pending (the
	// process exited before the original response was written) stores the
	// ORIGINAL payload hash; a same-key retry delivers the replay-shaped
	// payload (replay envelope appended). The finalization now also stores the
	// replay-shaped hash, so the written retry response advances the row from
	// pending to sent instead of leaving it durably pending forever.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stopped-replay-advance-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	let captureCalls = 0;
	let discardCalls = 0;
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			getActivePromptOwnerConnectionId: () => "client",
			cancelPendingPreflightForTerminalAbort: () => {},
			captureTerminalAbortSteeringSnapshot: () => {
				captureCalls += 1;
				return captureCalls;
			},
			discardTerminalAbortSteeringSnapshot: () => {
				discardCalls += 1;
			},
			abortPromptAndWaitWithTerminal: async (_handle, _options) => {
				return { status: "settled", terminalScope: {} };
			},
		},
	});
	const ctx = extensionContext(transport.sessionId, cwd);
	try {
		await handlers.get("session_start")?.({}, ctx);
		const keyHash = createHash("sha256").update("stopped-replay-key").digest("hex");
		const inputHash = createHash("sha256")
			.update(JSON.stringify({ mode: "terminal", scope: "turn" }))
			.digest("hex");
		const result = {
			ok: true,
			selection: "turn",
			turn: "stopped",
			ownedWork: "left_running",
			automaticDelivery: "enabled",
			resumeOnOwnedCompletion: true,
		};
		const payloadHash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
		const replayResult = {
			...result,
			// The replay envelope carries the POST-CAS publication flag the
			// stopped-row CAS observed (agent_end published); the seeded
			// replay-shaped hash must match that exact envelope (review
			// thread P2).
			replay: { responseState: "pending", responsePayloadHash: payloadHash, terminalPublished: true },
		};
		const replayPayloadHash = createHash("sha256").update(JSON.stringify(replayResult)).digest("hex");
		// Seed the POST-finalization durable state: the original stopped result
		// hash plus the replay-shaped hash a same-key retry delivers.
		await reconciliationStore.transactTerminalState(state => ({
			scopes: [
				{
					selection: "turn",
					idempotencyKeyHash: keyHash,
					idempotencyInputHash: inputHash,
					turnDisposition: "stopped",
					terminalPublished: true,
					ownedWorkDisposition: "left_running",
					automaticDeliveryDisposition: "enabled",
					resumeOnOwnedCompletion: true,
					turnContinuationFence: {
						state: "retained",
						abortedAttemptEpoch: 0,
						blockedContinuationIds: [],
						predecessorTombstones: [],
						ownedCompletionPolicy: "disabled",
					},
					responseState: "pending",
					responsePayloadHash: payloadHash,
					replayPayloadHash,
					acceptedAt: Date.now(),
					terminalAt: Date.now(),
				},
				...state.scopes,
			],
			keys: state.keys,
		}));
		transport.feed("client", {
			type: "control_request",
			id: "stopped-replay",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "stopped-replay-key",
		} as SdkFrame);
		const deadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "stopped-replay" && frame.type === "control_response")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the stopped-row replay");
			await Bun.sleep(20);
		}
		// The written replay's payload matches the stored replay-shaped hash, so
		// the delivery observer advances the durable row to sent.
		const stateDeadline = Date.now() + 15_000;
		while (reconciliationStore.snapshotTerminalScopes()[0]!.responseState !== "sent") {
			if (Date.now() > stateDeadline) throw new Error("Timed out waiting for the stopped-row response state");
			await Bun.sleep(20);
		}
		expect(transport.sent.find(frame => frame.id === "stopped-replay")).toMatchObject({
			ok: true,
			result: expect.objectContaining({
				turn: "stopped",
				replay: expect.objectContaining({ responseState: "pending" }),
			}),
		});
		// The durable replay (dispatch-cache eviction equivalent: the row was
		// seeded before this runtime admitted anything) captured a snapshot at
		// admission and then DISCARDED it — the replay path never settles, so
		// the FIFO holds no stale entry for a later real abort to consume
		// (review thread P1).
		expect(captureCalls).toBe(1);
		expect(discardCalls).toBe(1);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host does not assign a follow-up requester ownership until the follow-up actually starts", async () => {
	// Review thread P1: a turn.follow_up accepted while ctx.isIdle() is true
	// but the follow-up is never promoted (compaction, transcript ending in a
	// user/tool-result message) must not record the requester in pending — a
	// later unrelated agent_start would shift the stale entry and let the
	// follow-up connection terminal-abort a turn it did not submit. Ownership
	// correlates only when the queued follow-up is actually promoted.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-followup-stale-"));
	const idle = true;
	let promoted: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: (
			_content: string,
			options:
				| {
						onPreflightAccepted?: () => void;
						onPreflightAcceptCommit?: () => void;
						onQueuedPromoted?: (promotion: { startsOwnRun?: boolean; removed?: boolean }) => void;
				  }
				| undefined,
		) =>
			Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
				promoted = options?.onQueuedPromoted;
				options?.onPreflightAccepted?.();
				return {};
			}),
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	const seamCalls: Array<{ handle: string; scope: string }> = [];
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			cancelPendingPreflightForTerminalAbort: () => {},
			abortPromptAndWaitWithTerminal: async (handle, options) => {
				seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
				return { status: "settled", terminalScope: {} };
			},
		},
	});
	const ctx = {
		...extensionContext(transport.sessionId, cwd),
		isIdle: () => idle,
	} as unknown as ExtensionContext;
	try {
		await handlers.get("session_start")?.({}, ctx);
		const waitResponse = async (id: string) => {
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
				await Bun.sleep(20);
			}
		};
		// B submits a follow-up while idle. The follow-up is QUEUED (never starts
		// inline), and with no promotion (e.g. compaction holds the continuation)
		// no pending ownership entry may exist — even though isIdle is true.
		transport.feed("conn-b", {
			type: "control_request",
			id: "followup-b",
			operation: "turn.follow_up",
			input: { text: "followup-b" },
		} as SdkFrame);
		await waitResponse("followup-b");
		// The promotion hook exists but is NOT fired in this scenario.
		expect(promoted).toBeDefined();
		// An unrelated turn starts: the pending queue is empty, so the owner is
		// NOT conn-b.
		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		// B's abort must NOT stop the unrelated turn.
		transport.feed("conn-b", {
			type: "control_request",
			id: "followup-abort",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "followup-abort-key",
		} as SdkFrame);
		await waitResponse("followup-abort");
		expect(transport.sent.find(frame => frame.id === "followup-abort")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "no_active_turn" }),
		});
		expect(seamCalls).toHaveLength(0);
		// When the follow-up IS promoted, B owns its run and can abort it.
		promoted!({ startsOwnRun: true });
		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		transport.feed("conn-b", {
			type: "control_request",
			id: "followup-abort-2",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "followup-abort-key-2",
		} as SdkFrame);
		await waitResponse("followup-abort-2");
		expect(transport.sent.find(frame => frame.id === "followup-abort-2")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "stopped" }),
		});
		expect(seamCalls).toEqual([{ handle: "exact-run-handle", scope: "turn" }]);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host lets every connection whose follow-up was promoted abort the shared run", async () => {
	// Review thread P2: two connections submit follow-ups while idle before any
	// scheduled continuation starts; ONE continuation drains both into one run.
	// The per-message promotion hooks (fired at actual dequeue) must make BOTH
	// connections owners of that run, so each can terminal-abort work it
	// submitted, while a foreign connection still cannot.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-multi-followup-"));
	const promoted: Array<(promotion: { startsOwnRun: boolean }) => void> = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: (
			_content: string,
			options:
				| {
						onPreflightAccepted?: () => void;
						onPreflightAcceptCommit?: () => void;
						onQueuedPromoted?: (promotion: { startsOwnRun?: boolean; removed?: boolean }) => void;
				  }
				| undefined,
		) =>
			Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
				if (options?.onQueuedPromoted) promoted.push(options.onQueuedPromoted);
				options?.onPreflightAccepted?.();
				return "completed";
			}),
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	const seamCalls: Array<{ handle: string; scope: string }> = [];
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			cancelPendingPreflightForTerminalAbort: () => {},
			abortPromptAndWaitWithTerminal: async (handle, options) => {
				seamCalls.push({ handle, scope: options.terminal?.scope ?? "none" });
				return { status: "settled", terminalScope: {} };
			},
		},
	});
	const ctx = extensionContext(transport.sessionId, cwd);
	try {
		await handlers.get("session_start")?.({}, ctx);
		const waitResponse = async (id: string) => {
			const deadline = Date.now() + 15_000;
			while (!transport.sent.some(frame => frame.id === id && frame.type === "control_response")) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
				await Bun.sleep(20);
			}
		};
		const followUp = (connectionId: string, id: string) =>
			transport.feed(connectionId, {
				type: "control_request",
				id,
				operation: "turn.follow_up",
				input: { text: id },
			} as SdkFrame);
		// A and B submit follow-ups while idle: no pending entries at accept.
		followUp("conn-a", "fu-a");
		await waitResponse("fu-a");
		followUp("conn-b", "fu-b");
		await waitResponse("fu-b");
		expect(promoted).toHaveLength(2);
		// ONE continuation drains both follow-ups into one run: both per-message
		// hooks fire at dequeue, then the run starts.
		for (const hook of promoted) hook({ startsOwnRun: true });
		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		// Both submitting connections can terminal-abort the shared run.
		for (const [connectionId, id] of [
			["conn-a", "multi-abort-a"],
			["conn-b", "multi-abort-b"],
		] as const) {
			transport.feed(connectionId, {
				type: "control_request",
				id,
				operation: "turn.abort",
				input: { mode: "terminal" },
				idempotencyKey: `${id}-key`,
			} as SdkFrame);
			await waitResponse(id);
			expect(transport.sent.find(frame => frame.id === id)).toMatchObject({
				ok: true,
				result: expect.objectContaining({ turn: "stopped" }),
			});
		}
		expect(seamCalls).toHaveLength(2);
		// A foreign connection still cannot stop the run.
		transport.feed("conn-c", {
			type: "control_request",
			id: "multi-abort-c",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "multi-abort-c-key",
		} as SdkFrame);
		await waitResponse("multi-abort-c");
		expect(transport.sent.find(frame => frame.id === "multi-abort-c")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "no_active_turn" }),
		});
		expect(seamCalls).toHaveLength(2);
		// Review thread P1: EVERY follow-up batched into the shared run must
		// reach a terminal record. A promotion that only transitioned the first
		// invocation left the remaining follow-ups durably accepted — their
		// result lookups would never complete and a restart would report them
		// failed even though they ran in the shared turn.
		await handlers.get("agent_end")?.({ type: "agent_end", stopReason: "cancelled", messages: [] }, ctx);
		{
			const terminalDeadline = Date.now() + 15_000;
			const promptStatuses = () =>
				reconciliationStore
					.snapshot()
					.filter(record => record.kind === "prompt")
					.map(record => record.status);
			while (promptStatuses().some(status => status !== "terminal_ok")) {
				if (Date.now() > terminalDeadline)
					throw new Error("Timed out waiting for the batched follow-up records to terminalize");
				await Bun.sleep(20);
			}
		}
		const batchedTerminals = reconciliationStore
			.snapshot()
			.filter(record => record.kind === "prompt" && record.status === "terminal_ok");
		expect(batchedTerminals).toHaveLength(2);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only host rebinds the steering snapshot when the requester's turn wins the owner race", async () => {
	// Review thread P1: an abort admitted while another connection owns the
	// active turn captures its snapshot under that OLD turn; when the durable
	// no-effect reservation reveals that the ABORTING requester's own prompt
	// became active, the fall-through terminalizes that turn and must REBIND
	// the admission snapshot to it — otherwise the settlement rejects the
	// still-old token and the requester's turn keeps running.
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-snapshot-rebind-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	const reconciliationStore = createReconciliationStore({
		sessionFile: path.join(cwd, "session.json"),
		sessionId: transport.sessionId,
	});
	let ownerReads = 0;
	let rebindCalls = 0;
	const settledOptions: Array<{ scope?: string; steeringSnapshotToken?: number }> = [];
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => transport,
		terminalAbortSeams: {
			getReconciliationStore: () => reconciliationStore,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "exact-run-handle",
			// First read: another connection owns the turn. The recheck after
			// the durable reservation: the aborting requester now owns it.
			getActivePromptOwnerConnectionId: () => (ownerReads++ === 0 ? undefined : "client"),
			cancelPendingPreflightForTerminalAbort: () => {},
			captureTerminalAbortSteeringSnapshot: () => 42,
			rebindTerminalAbortSteeringSnapshot: () => {
				rebindCalls += 1;
			},
			abortPromptAndWaitWithTerminal: async (_handle, options) => {
				settledOptions.push({
					scope: options.terminal?.scope,
					steeringSnapshotToken: options.terminal?.steeringSnapshotToken,
				});
				return { status: "settled", terminalScope: {} };
			},
		},
	});
	const ctx = extensionContext(transport.sessionId, cwd);
	try {
		await handlers.get("session_start")?.({}, ctx);
		transport.feed("client", {
			type: "control_request",
			id: "owner-race-abort",
			operation: "turn.abort",
			input: { mode: "terminal" },
			idempotencyKey: "owner-race-key",
		} as SdkFrame);
		const deadline = Date.now() + 15_000;
		while (!transport.sent.some(frame => frame.id === "owner-race-abort" && frame.type === "control_response")) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for the owner-race abort response");
			await Bun.sleep(20);
		}
		// The fall-through terminalized the requester's rechecked turn: the
		// admission snapshot was rebound to it and the settlement received the
		// token instead of a stale rejection.
		expect(rebindCalls).toBe(1);
		expect(settledOptions).toEqual([{ scope: "turn", steeringSnapshotToken: 42 }]);
		expect(transport.sent.find(frame => frame.id === "owner-race-abort")).toMatchObject({
			ok: true,
			result: expect.objectContaining({ turn: "stopped" }),
		});
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await rm(cwd, { recursive: true, force: true });
	}
});
