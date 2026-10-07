import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentOptions, markNonDispatchedToolEvent, ThinkingLevel } from "@gajae-code/agent-core";
import { createAttemptMinter } from "@gajae-code/agent-core/attempt-scope";
import { CompactionCancelledError } from "@gajae-code/agent-core/compaction";
import { type AssistantMessage, getBundledModel, type Model, type UserMessage } from "@gajae-code/ai/core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { logger } from "@gajae-code/utils";
import { createTestSession } from "../../../test/utilities";
import { AsyncJobManager } from "../../async";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { ExtensionAPI, ExtensionContext, ExtensionTranscriptEntry } from "../../extensibility/extensions";
import { ExtensionRunner } from "../../extensibility/extensions/runner";
import { AgentSession } from "../../session/agent-session";
import { AuthStorage } from "../../session/auth-storage";
import { SessionManager } from "../../session/session-manager";
import {
	registerOwnedRegistration,
	resetTerminalAbortRegistriesForTests,
	type TurnRegistrationKey,
	unregisterOwnedRegistration,
} from "../../session/terminal-abort";
import { Broker } from "../broker/broker";
import type { BrokerDiscovery } from "../broker/discovery";
import { SessionIndex, type SessionIndexEvent } from "../broker/session-index";
import { createKindAwareReconciliation } from "../bus/kind-aware-reconciliation";
import { createPromptReconciliation } from "../bus/prompt-reconciliation";
import {
	createReconciliationStore,
	type ReconciliationStoreDocument,
	reconciliationStorePath,
} from "../bus/reconciliation-store";
import { PromptDeadlineManager } from "../prompt-deadline-manager";
import { BROKER_RUNTIME_ABORT_CAPABILITY_FIELD, setBrokerRuntimeAbortCapabilityForTest } from "./control/runtime-gate";
import { SESSION_HOST_OBSERVER_CAPABILITY, TURN_STREAM_CAPABILITY } from "./host";
import { PromptImageUploadStore } from "./prompt-image-upload";
import { CursorRegistry, QueryHandlers, type QueryResponse, RevisionStore } from "./query";
import {
	type CreateSdkSessionRuntimeOptions,
	createInvocationReconciliation,
	createSdkSessionRuntimeExtension,
	createSdkSurfaceFactory,
	RetainedTerminalBoundaryRegistry,
	type SdkOnlyInvocationRecord,
	type SdkOnlyReconciliationStore,
	type SdkOnlyTerminalAbortSeams,
	SessionSdkSessionRuntime,
	type SessionSdkTransport,
} from "./session-runtime";
import { createSdkCapabilities, createSdkSurfacePolicy } from "./surface-policy";
import type { SdkFrame } from "./types";
import { SdkTransportLifecycleError } from "./websocket-transport";

setDefaultTimeout(30_000);

test("retained terminal claims survive more than 1024 later boundaries", () => {
	const claims = new RetainedTerminalBoundaryRegistry();
	const target = "publishable-target";
	const laterBoundaries = Array.from({ length: 1_024 }, (_, index) => `later-${index}`);
	const releaseTarget = claims.retain([target]);
	try {
		expect(claims.claim(target)).toBe(true);
		claims.setPublicationResult(target, true);
		for (const key of laterBoundaries) {
			const releaseLater = claims.retain([key]);
			try {
				expect(claims.claim(key)).toBe(true);
				claims.setPublicationResult(key, true);
			} finally {
				releaseLater();
			}
		}
		expect(claims.size).toBe(1_024);
		expect(claims.hasClaimed(target)).toBe(true);
		expect(claims.publicationResult(target)).toBe(true);
		expect(claims.hasClaimed("later-0")).toBe(false);
		expect(claims.claim(target)).toBe(false);
	} finally {
		releaseTarget();
	}

	expect(claims.size).toBe(1_024);
	expect(claims.hasClaimed(target)).toBe(true);
	expect(claims.publicationResult(target)).toBe(true);
	expect(claims.claim("after-release")).toBe(true);
	expect(claims.hasClaimed(target)).toBe(false);
	expect(claims.publicationResult(target)).toBeUndefined();
	expect(claims.size).toBe(1_024);
});

test("terminal boundary history trims as soon as retained publishers release", () => {
	const claims = new RetainedTerminalBoundaryRegistry();
	const target = "held-target";
	const laterBoundaries = Array.from({ length: 1_024 }, (_, index) => `held-later-${index}`);
	const release = claims.retain([target, ...laterBoundaries]);
	try {
		for (const key of [target, ...laterBoundaries]) {
			expect(claims.claim(key)).toBe(true);
			claims.setPublicationResult(key, true);
		}
		expect(claims.size).toBe(1_025);
		expect(claims.hasClaimed(target)).toBe(true);
		expect(claims.publicationResult(target)).toBe(true);
	} finally {
		release();
	}

	expect(claims.size).toBe(1_024);
	expect(claims.hasClaimed(target)).toBe(false);
	expect(claims.publicationResult(target)).toBeUndefined();
});

test("runtime capabilities preserve explicit primary control surface", () => {
	const policy = createSdkSurfacePolicy({ bindings: [], workflowGateAvailable: false });
	expect(createSdkCapabilities(policy)).toMatchObject({ primaryControlSurface: "sdk" });
	expect(createSdkCapabilities(policy, false, "sdk")).toMatchObject({ primaryControlSurface: "sdk" });
	expect(createSdkCapabilities(policy, false, "cli")).toMatchObject({ primaryControlSurface: "cli" });
});

test("thinking.set uses the control setter and reports the applied session level", async () => {
	const sessionContext = await createTestSession({ inMemory: true });
	const { session, tempDir: cwd, cleanup } = sessionContext;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: async () => {},
		setThinkingLevel: () => {
			throw new Error("thinking.set must not use the legacy setter");
		},
		setThinkingLevelForControl: async (level: ThinkingLevel, persist: boolean) => {
			expect(persist).toBe(false);
			await session.setThinkingLevelForControl(level, persist);
		},
	} as unknown as ExtensionAPI;
	const response = Promise.withResolvers<SdkFrame>();
	const transport = memoryTransport(frame => {
		if (frame.type === "control_response" && frame.id === "thinking-set") response.resolve(frame);
	});
	createSdkSessionRuntimeExtension(api, { agentDir: cwd, createTransport: async () => transport });
	const ctx = extensionContext(transport.sessionId, cwd);
	try {
		await handlers.get("session_start")?.({}, ctx);
		transport.feed("client", {
			type: "control_request",
			id: "thinking-set",
			operation: "thinking.set",
			input: { level: ThinkingLevel.Medium },
		} as SdkFrame);
		await response.promise;
		expect(session.thinkingLevel).toBe(ThinkingLevel.Medium);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		await cleanup();
	}
});

function memoryTransport(onSend?: (frame: SdkFrame) => void): SessionSdkTransport & {
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
			onSend?.(frame);
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

test("session.last_assistant returns null when the projected transcript has no readable assistant text", async () => {
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

	expect(await queryLastAssistant(ctx, sessionId)).toMatchObject({ ok: true, page: { items: [null] } });
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
		error: { code: "legacy_error", message: "Prompt submission failed." },
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

test("a deadline-deferred stopped outcome reloads consistently before terminal commit", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-deferred-stop-reload-"));
	try {
		const sessionFile = path.join(root, "session.jsonl");
		await Bun.write(sessionFile, "");
		const store = createReconciliationStore({ sessionFile, sessionId: "deferred-stop-reload" });
		const reconciliation = createInvocationReconciliation({ store });
		const correlation = { commandId: "deferred-stop-command", turnId: "deferred-stop-turn" };
		await reconciliation.noteAccepted("prompt", correlation, "deferred-stop-ref");
		await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
		await reconciliation.claimPendingOutcome("prompt", correlation, {
			kind: "failed",
			code: "prompt_deadline_exceeded",
			message: "Prompt deadline exceeded.",
			provenance: "deadline",
		});
		expect(
			await reconciliation.stagePendingTerminalOutcome("prompt", correlation, {
				kind: "stopped",
				reason: "cancelled",
				provenance: "client_cancel",
			}),
		).toMatchObject({ kind: "stopped", reason: "cancelled" });
		expect(reconciliation.lookup("prompt", correlation)).toMatchObject({ status: "in_flight" });
		const staged = store.snapshot().find(record => record.commandId === correlation.commandId) as
			| (SdkOnlyInvocationRecord & { pendingOutcome?: unknown })
			| undefined;
		expect(staged?.pendingOutcome).toMatchObject({ kind: "stopped", reason: "cancelled" });
		expect(staged?.terminalAt).toBeUndefined();

		const reopened = createInvocationReconciliation({
			store: createReconciliationStore({ sessionFile, sessionId: "deferred-stop-reload" }),
		});
		await reopened.hydrate();
		expect(reopened.lookup("prompt", { clientRef: "deferred-stop-ref" })).toMatchObject({
			status: "terminal_ok",
			outcome: { kind: "stopped", reason: "cancelled" },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("deferred terminal staging preserves the acceptance-time hard maximum across restart", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-deferred-max-reload-"));
	try {
		const sessionFile = path.join(root, "session.jsonl");
		await Bun.write(sessionFile, "");
		const sessionId = "deferred-max-reload";
		const store = createReconciliationStore({ sessionFile, sessionId });
		const reconciliation = createInvocationReconciliation({ store });
		const correlation = { commandId: "deferred-max-command", turnId: "deferred-max-turn" };
		await reconciliation.noteAccepted("prompt", correlation, "deferred-max-ref");
		await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
		const acceptedAt = store.snapshot().find(record => record.commandId === correlation.commandId)?.acceptedAt;
		if (acceptedAt === undefined) throw new Error("Accepted prompt record is missing its timestamp.");
		const deadlineMaxAt = acceptedAt + 1_000;
		await reconciliation.stagePendingTerminalOutcome(
			"prompt",
			correlation,
			{ kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
			true,
			deadlineMaxAt,
		);
		expect(store.snapshot().find(record => record.commandId === correlation.commandId)).toMatchObject({
			deadlineRecoveryPending: true,
			deadlineMaxAt,
		});

		const reopened = createInvocationReconciliation({
			store: createReconciliationStore({ sessionFile, sessionId }),
		});
		await reopened.hydrate();
		const recovery = reopened.listDeadlineRecoveryPendingPrompts()[0];
		expect(recovery?.deadlineMaxAt).toBe(deadlineMaxAt);
		const now = deadlineMaxAt - 100;
		const manager = new PromptDeadlineManager({
			reconciliation: reopened,
			getLeaseMs: () => 20_000,
			getMaxMs: () => 120_000,
			now: () => now,
		});
		manager.recoverPending(correlation, recovery?.acceptedAt ?? acceptedAt, recovery?.deadlineMaxAt);
		expect(manager.deadlineAt(correlation)).toBe(deadlineMaxAt);
		manager.clearAll();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("staging after a failed deadline claim preserves the acceptance-time hard maximum", async () => {
	const backing = { records: [] as SdkOnlyInvocationRecord[] };
	let failNextWrite = false;
	const store: SdkOnlyReconciliationStore = {
		path: null,
		load: async () => backing.records.map(record => ({ ...record })),
		transact: async mutator => {
			const candidate = mutator(backing.records.map(record => ({ ...record })));
			if (failNextWrite) {
				failNextWrite = false;
				throw new Error("injected transient deadline claim failure");
			}
			backing.records = candidate;
		},
		snapshotTerminalScopes: () => [],
		snapshotTerminalKeys: () => [],
		transactTerminalScopes: async () => {},
		transactTerminalState: async () => {},
	};
	const reconciliation = createInvocationReconciliation({ store });
	const correlation = { commandId: "deferred-max-command", turnId: "deferred-max-turn" };
	await reconciliation.noteAccepted("prompt", correlation, "deferred-max-ref");
	await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
	const acceptedAt = backing.records.find(record => record.commandId === correlation.commandId)?.acceptedAt;
	if (acceptedAt === undefined) throw new Error("Accepted prompt record is missing its timestamp.");
	const deadlineMaxAt = acceptedAt + 1_000;
	failNextWrite = true;
	await expect(
		reconciliation.claimPendingOutcome(
			"prompt",
			correlation,
			{
				kind: "failed",
				code: "prompt_deadline_exceeded",
				message: "Prompt deadline exceeded.",
				provenance: "deadline",
			},
			deadlineMaxAt,
		),
	).rejects.toThrow("injected transient deadline claim failure");
	await reconciliation.stagePendingTerminalOutcome(
		"prompt",
		correlation,
		{ kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
		true,
		deadlineMaxAt,
	);
	expect(backing.records.find(record => record.commandId === correlation.commandId)).toMatchObject({
		deadlineRecoveryPending: true,
		deadlineMaxAt,
	});

	const reopened = createInvocationReconciliation({ store });
	await reopened.hydrate();
	const recovery = reopened.listDeadlineRecoveryPendingPrompts()[0];
	expect(recovery?.deadlineMaxAt).toBe(deadlineMaxAt);
	const manager = new PromptDeadlineManager({
		reconciliation: reopened,
		getLeaseMs: () => 20_000,
		getMaxMs: () => 120_000,
		now: () => deadlineMaxAt - 100,
	});
	manager.recoverPending(correlation, recovery?.acceptedAt ?? acceptedAt, recovery?.deadlineMaxAt);
	expect(manager.deadlineAt(correlation)).toBe(deadlineMaxAt);
	manager.clearAll();
});

test("uncertain recovery retains a staged stopped intent for restart", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-deferred-stop-uncertain-"));
	try {
		const sessionFile = path.join(root, "session.jsonl");
		await Bun.write(sessionFile, "");
		const sessionId = "deferred-stop-uncertain";
		const store = createReconciliationStore({ sessionFile, sessionId });
		const reconciliation = createInvocationReconciliation({ store });
		const correlation = { commandId: "deferred-stop-uncertain-command", turnId: "deferred-stop-uncertain-turn" };
		await reconciliation.noteAccepted("prompt", correlation, "deferred-stop-uncertain-ref");
		await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
		await reconciliation.claimPendingOutcome("prompt", correlation, {
			kind: "failed",
			code: "prompt_deadline_exceeded",
			message: "Prompt deadline exceeded.",
			provenance: "deadline",
		});
		await reconciliation.stagePendingTerminalOutcome("prompt", correlation, {
			kind: "stopped",
			reason: "cancelled",
			provenance: "client_cancel",
		});
		await reconciliation.markUncertain("prompt", correlation, undefined, 10_000);
		const staged = store.snapshot().find(record => record.commandId === correlation.commandId) as
			| (SdkOnlyInvocationRecord & { pendingOutcome?: unknown })
			| undefined;
		expect(staged).toMatchObject({ status: "in_flight", deadlineRecoveryPending: true });
		expect(staged?.pendingOutcome).toMatchObject({ kind: "stopped", reason: "cancelled" });

		const reopened = createInvocationReconciliation({
			store: createReconciliationStore({ sessionFile, sessionId }),
		});
		await reopened.hydrate();
		expect(reopened.lookup("prompt", { clientRef: "deferred-stop-uncertain-ref" })).toMatchObject({
			status: "in_flight",
		});
		const recoveryRows = reopened.listDeadlineRecoveryPendingPrompts();
		expect(recoveryRows).toHaveLength(1);
		expect(recoveryRows[0]).toMatchObject({
			correlation,
			pendingOutcome: { kind: "stopped", reason: "cancelled" },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Q26 keeps deadline restart uncertainty nonterminal and hides pending outcome", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-q26-deadline-recovery-"));
	const sessionId = "q26-deadline-recovery";
	let harness: InvocationHarness | undefined;
	try {
		const sessionFile = path.join(cwd, ".gjc", "state", `${sessionId}.jsonl`);
		const store = createReconciliationStore({ sessionFile, sessionId });
		const reconciliation = createInvocationReconciliation({ store });
		const correlation = { commandId: "q26-deadline-command", turnId: "q26-deadline-turn" };
		await reconciliation.hydrate();
		await reconciliation.noteAccepted("prompt", correlation, "q26-deadline-ref");
		await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
		await reconciliation.claimPendingOutcome("prompt", correlation, {
			kind: "failed",
			code: "prompt_deadline_exceeded",
			message: "Prompt deadline exceeded.",
			provenance: "deadline",
		});
		await reconciliation.stagePendingTerminalOutcome("prompt", correlation, {
			kind: "stopped",
			reason: "cancelled",
			provenance: "client_cancel",
		});
		await reconciliation.markUncertain("prompt", correlation, undefined, Date.now() + 60_000);
		await reconciliation.noteTransition("prompt", correlation, {
			type: "agent_failed",
			error: Object.assign(new Error("provider unavailable"), { code: "provider_unavailable" }),
		});
		expect(store.snapshot().find(record => record.commandId === correlation.commandId)).toMatchObject({
			status: "in_flight",
			deadlineRecoveryPending: true,
			pendingOutcome: { kind: "stopped" },
		});

		harness = await invocationHarness(sessionId, cwd, {
			settings: {
				get: (key: string) =>
					key === "sdk.promptDeadlineMs" ? 60_000 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
			} as unknown as Settings,
			terminalAbortSeams: { getReconciliationStore: () => store },
		});
		const result = await harness.query("turn.prompt_status", correlation);
		expect(result.result?.status).toBe("in_flight");
		expect(result.result).not.toHaveProperty("outcome");
		expect(result.result).not.toHaveProperty("pendingOutcome");
	} finally {
		await harness?.stop();
		await rm(cwd, { recursive: true, force: true });
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

	test("uses a custom capability provider for live delivery without transport negotiation hooks", async () => {
		const transport = memoryTransport();
		const runtime = new SessionSdkSessionRuntime({
			transport,
			connectionCapabilities: connectionId =>
				connectionId === "observer"
					? new Set([TURN_STREAM_CAPABILITY, SESSION_HOST_OBSERVER_CAPABILITY])
					: new Set(),
		});
		await runtime.start();
		transport.feed("observer", { type: "event_replay", id: "replay", sinceSeq: 0 });
		runtime.sendFrameToCapabilities([TURN_STREAM_CAPABILITY, SESSION_HOST_OBSERVER_CAPABILITY], {
			type: "event",
			kind: "message_update",
			payload: {},
		});
		expect(transport.sent).toContainEqual({ type: "event", kind: "message_update", payload: {} });
		await runtime.stop();
	});
	test("ignores late negotiated capabilities after the authoritative connection closes", async () => {
		const transport = memoryTransport();
		let closeConnection: ((connectionId: string) => void) | undefined;
		let negotiateCapabilities: ((connectionId: string, capabilities: readonly string[]) => void) | undefined;
		const hookedTransport: SessionSdkTransport = {
			...transport,
			onConnectionClose(handler) {
				closeConnection = handler;
				return () => {
					if (closeConnection === handler) closeConnection = undefined;
				};
			},
			onNegotiatedCapabilities(handler) {
				negotiateCapabilities = handler;
				return () => {
					if (negotiateCapabilities === handler) negotiateCapabilities = undefined;
				};
			},
		};
		const liveCapabilities = new Map<string, ReadonlySet<string>>();
		const providerReads: string[] = [];
		const runtime = new SessionSdkSessionRuntime({
			transport: hookedTransport,
			connectionCapabilities: connectionId => {
				providerReads.push(connectionId);
				return liveCapabilities.get(connectionId);
			},
		});
		await runtime.start();
		try {
			if (!closeConnection || !negotiateCapabilities) throw new Error("transport callbacks were not registered");
			const capabilities = [TURN_STREAM_CAPABILITY, SESSION_HOST_OBSERVER_CAPABILITY];
			liveCapabilities.set("observer", new Set(capabilities));
			negotiateCapabilities("observer", capabilities);
			expect(runtime.connectionIdsWithCapabilities(capabilities)).toEqual(["observer"]);

			liveCapabilities.delete("observer");
			closeConnection("observer");
			negotiateCapabilities("observer", capabilities);
			providerReads.length = 0;
			expect(runtime.connectionIdsWithCapabilities(capabilities)).toEqual([]);
			expect(providerReads).toEqual([]);
		} finally {
			await runtime.stop();
		}
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
		createTestRuntimeExtension(api, { agentDir: cwd, createTransport: async () => transport });
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
		createTestRuntimeExtension(api, { agentDir: cwd, createTransport: async () => transport });
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
				{ type: "agent_end", stopReason: "maintenance", maintenanceOutcome: "compacted" },
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
				{ type: "agent_end", stopReason: "maintenance", maintenanceOutcome: "compacted" },
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
		createTestRuntimeExtension(api, {
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

	test.each([
		"ordinary",
		"terminal",
	] as const)("SDK-only %s abort cancels only its admitted preflight snapshot", async mode => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-preflight-snapshot-"));
		const signals = new Map<string, AbortSignal>();
		const acceptCallbacks = new Map<string, () => void | Promise<void>>();
		let rootAbortCalls = 0;
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			// Keep actual admission capabilities pending, rather than inventing
			// an acceptance or terminal. Record before the runtime can reject.
			sendUserMessage: (
				content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
				options: PreflightHooks | undefined,
			) => {
				const text = typeof content === "string" ? content : content.find(block => block.type === "text")?.text;
				if (text !== undefined && options?.preflightSignal) signals.set(text, options.preflightSignal);
				if (text !== undefined && options?.onPreflightAcceptCommit)
					acceptCallbacks.set(text, options.onPreflightAcceptCommit);
				return Promise.withResolvers<void>().promise;
			},
		} as unknown as ExtensionAPI;
		const transport = memoryTransport();
		const reconciliationStore = createReconciliationStore({
			sessionFile: path.join(cwd, "session.json"),
			sessionId: transport.sessionId,
		});
		createTestRuntimeExtension(api, {
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
		const ctx = {
			...extensionContext(transport.sessionId, cwd),
			abort: async () => {
				rootAbortCalls++;
			},
		};
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
			transport.feed("conn-b", {
				type: "control_request",
				id: "foreign-preflight",
				operation: "turn.prompt",
				input: { text: "foreign-pending", images: [] },
			} as SdkFrame);
			const readyDeadline = Date.now() + 2_000;
			while (!signals.has("hold-pre-1")) {
				if (Date.now() >= readyDeadline) throw new Error("Owned preflight was not admitted.");
				await Bun.sleep(10);
			}
			transport.feed("conn-a", {
				type: "control_request",
				id: "pre-abort",
				operation: "turn.abort",
				input: mode === "terminal" ? { mode: "terminal" } : {},
				idempotencyKey: "pre-snapshot-key",
			} as SdkFrame);
			// A successor prompt pipelined by the SAME connection while the abort
			// awaits the reconciliation transaction: its preflight lands in the
			// live bucket AFTER the abort's admission snapshot and must survive.
			prompt("pre-2");
			const deadline = Date.now() + 15_000;
			while (
				!transport.sent.some(frame => frame.id === "pre-abort" && frame.type === "control_response") ||
				!transport.sent.some(frame => frame.id === "pre-1" && frame.type === "control_response") ||
				!signals.has("foreign-pending")
			) {
				if (Date.now() > deadline)
					throw new Error("Timed out waiting for the abort and admitted-preflight responses");
				await Bun.sleep(20);
			}
			expect(rootAbortCalls).toBe(0);
			expect(signals.get("hold-pre-1")?.aborted).toBe(true);
			expect(signals.get("foreign-pending")?.aborted).toBe(false);
			// Prompt controls are serialized. Commit the untouched foreign
			// admission through its real callback so the later request can enter.
			const acceptForeign = acceptCallbacks.get("foreign-pending");
			expect(acceptForeign).toBeDefined();
			await acceptForeign!();
			while (!signals.has("hold-pre-2")) {
				if (Date.now() > deadline) throw new Error("Later admission did not enter after foreign acceptance.");
				await Bun.sleep(10);
			}
			expect(signals.get("hold-pre-2")?.aborted).toBe(false);
			expect(transport.sent.find(frame => frame.id === "foreign-preflight")).toMatchObject({
				ok: true,
				result: { accepted: true },
			});
			// The admitted preflight is cancelled by the abort.
			expect(transport.sent.find(frame => frame.id === "pre-1")).toMatchObject({
				ok: false,
				error: expect.objectContaining({ code: "busy" }),
			});
			expect(transport.sent.find(frame => frame.id === "pre-abort")).toMatchObject({
				ok: true,
				result: expect.objectContaining(mode === "terminal" ? { turn: "no_active_turn" } : { aborted: true }),
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
			sendUserMessage: (_content: string, options: PreflightHooks | undefined) =>
				Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
					options?.onPreflightAccepted?.();
					if (!idle) options?.onQueuedPromoted?.({ startsOwnRun: false });
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
		createTestRuntimeExtension(api, {
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
				content: string,
				options:
					| {
							onPreflightAccepted?: () => void;
							onPreflightAcceptCommit?: () => void;
							onQueuedPromoted?: (promotion: { startsOwnRun?: boolean; removed?: boolean }) => void;
					  }
					| undefined,
			) =>
				Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
					options?.onPreflightAccepted?.();
					if (content === "follow up b") options?.onQueuedPromoted?.({ startsOwnRun: false });
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
		createTestRuntimeExtension(api, {
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

	test("a successor run cannot satisfy or be aborted for a stale predecessor deadline", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stale-deadline-owner-"));
		let abortCalls = 0;
		let ledgerReads = 0;
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
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => 2,
					getActivePromptHandle: () => "successor-run",
					pendingToolExecutions: () => {
						ledgerReads += 1;
						return [];
					},
					abortPromptAndWaitWithTerminal: async () => {
						abortCalls += 1;
						return { status: "settled" };
					},
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
			const status = await harness.query("turn.prompt_status", ids);
			expect(status.result?.status).toBe("in_flight");
			expect(abortCalls).toBe(0);
			expect(ledgerReads).toBe(0);
			expect(
				harness.broadcasts.some(frame => {
					const payload = frame.payload as { commandId?: string; turnId?: string } | undefined;
					return (
						frame.kind === "agent_failed" &&
						payload?.commandId === ids.commandId &&
						payload?.turnId === ids.turnId
					);
				}),
			).toBe(false);
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
		createTestRuntimeExtension(api, {
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
			// The rejected submission must TERMINALIZE as failed (#4668 review
			// P1): agent_failed alone is diagnostic-only, so the settlement also
			// writes agent_end. Before that fix B stayed accepted forever.
			{
				const ids = { clientRef: "fail-b-ref" };
				const statusDeadline = Date.now() + 15_000;
				let status: Record<string, unknown> | undefined;
				for (let attempt = 0; status === undefined; attempt += 1) {
					const id = `fail-b-status-${attempt}`;
					transport.feed("conn-b", {
						type: "query_request",
						id,
						query: "turn.prompt_status",
						input: { kind: "prompt", ...ids },
					} as SdkFrame);
					while (!transport.sent.some(frame => frame.id === id)) {
						if (Date.now() > statusDeadline) throw new Error("Timed out waiting for fail-b-status");
						await Bun.sleep(20);
					}
					const response = transport.sent.find(frame => frame.id === id);
					const result = response?.result as Record<string, unknown> | undefined;
					if (result?.status === "failed") status = response;
					else await Bun.sleep(20);
					if (Date.now() > statusDeadline) throw new Error("Timed out waiting for fail-b-status");
				}
				expect(status).toMatchObject({
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
			createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
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
		createTestRuntimeExtension(api, {
			agentDir,
			ensureBrokerImpl: async () => {
				if (!broker) throw Object.assign(new Error("injected unavailable broker"), { code: "acquire_timeout" });
				return testBrokerDiscovery;
			},
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
			await chmod(agentDir, 0o700);
			broker = new Broker({ agentDir });
			await broker.start();
			// Optional registration now completes independently of the event handler.
			const deadline = Date.now() + 15_000;
			await handlers.get("turn_start")?.({}, context);
			let endpoint = await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 });
			while (!endpoint.ok && Date.now() < deadline) {
				await Bun.sleep(20);
				await handlers.get("turn_start")?.({}, context);
				endpoint = await broker.handleRequest("session.get_endpoint", { sessionId, endpointGeneration: 1 });
			}
			expect(endpoint).toMatchObject({
				ok: true,
				result: { sessionId, token: expect.any(String) },
			});
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

	test("optional blocked broker registration leaves startup and turns responsive and fences shutdown", async () => {
		const gate = Promise.withResolvers<BrokerDiscovery>();
		let attempts = 0;
		const harness = await brokerRegistrationHarness({
			ensureBrokerImpl: () => {
				attempts += 1;
				return gate.promise;
			},
		});
		const publication = spyOn(SessionSdkSessionRuntime.prototype, "registerWithBroker");
		try {
			await harness.emit("session_start");
			await Promise.all([harness.emit("turn_start"), harness.emit("turn_start")]);
			expect(attempts).toBe(1);
			expect(harness.turnStarts()).toBe(2);
			// Recovery arms only once the startup attempt settles.
			expect(harness.recoveryActive()).toBe(false);
			await harness.emit("session_shutdown");
			expect(harness.stops()).toBe(1);
			gate.resolve(testBrokerDiscovery);
			await Bun.sleep(0);
			await harness.emit("turn_start");
			expect(attempts).toBe(1);
			expect(publication).not.toHaveBeenCalled();
			// An attempt that settles after shutdown must not arm recovery either.
			expect(harness.recoveryActive()).toBe(false);
		} finally {
			gate.resolve(testBrokerDiscovery);
			await harness.dispose();
			publication.mockRestore();
		}
	});

	test("optional rejected broker registration reports diagnostics and retries without blocking turns", async () => {
		const first = Promise.withResolvers<BrokerDiscovery>();
		const retry = Promise.withResolvers<BrokerDiscovery>();
		let attempts = 0;
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		const harness = await brokerRegistrationHarness({
			ensureBrokerImpl: () => (++attempts === 1 ? first.promise : retry.promise),
		});
		try {
			await harness.emit("session_start");
			first.reject(Object.assign(new Error("injected broker contention"), { code: "acquire_timeout" }));
			await Bun.sleep(0);
			expect(warning).toHaveBeenCalledWith("sdk broker registration unavailable", { code: "acquire_timeout" });
			// The settled startup attempt armed recovery, and its failure holds the next tick.
			expect(harness.recoveryActive()).toBe(true);
			harness.recover();
			await harness.emit("turn_start");
			harness.recover();
			expect(attempts).toBe(2);
			expect(harness.turnStarts()).toBe(1);
			expect(harness.stops()).toBe(0);
			retry.reject(Object.assign(new Error("injected retry failure"), { code: "acquire_timeout" }));
			await Bun.sleep(0);
			expect(
				warning.mock.calls.filter(([message]) => message === "sdk broker registration unavailable"),
			).toHaveLength(2);
		} finally {
			first.resolve(testBrokerDiscovery);
			retry.resolve(testBrokerDiscovery);
			await harness.dispose();
			warning.mockRestore();
		}
	});

	test("optional broker publication completing after shutdown is unregistered with its ownership proof", async () => {
		const published = Promise.withResolvers<SessionIndexEvent>();
		const release = Promise.withResolvers<void>();
		const unregistered = Promise.withResolvers<void>();
		const append = SessionIndex.prototype.append;
		const unregister = SessionIndex.prototype.unregisterIfCurrent;
		const publication = spyOn(SessionIndex.prototype, "append").mockImplementation(async function (
			this: SessionIndex,
			input,
		) {
			const event = await append.call(this, input);
			if (input.type === "host_registered") {
				published.resolve(event);
				await release.promise;
			}
			return event;
		});
		const cleanup = spyOn(SessionIndex.prototype, "unregisterIfCurrent").mockImplementation(async function (
			this: SessionIndex,
			...args
		) {
			const result = await unregister.apply(this, args);
			unregistered.resolve();
			return result;
		});
		const harness = await brokerRegistrationHarness({ ensureBrokerImpl: async () => testBrokerDiscovery });
		try {
			await harness.emit("session_start");
			const ownership = await published.promise;
			await harness.emit("session_shutdown");
			expect(cleanup).not.toHaveBeenCalled();
			release.resolve();
			await unregistered.promise;
			expect(cleanup).toHaveBeenCalledWith(ownership);
			expect(harness.recoveryActive()).toBe(false);
		} finally {
			release.resolve();
			await harness.dispose();
			publication.mockRestore();
			cleanup.mockRestore();
		}
	});

	for (const outcome of ["success", "failure"] as const) {
		test(`required broker registration blocks startup and turns until ${outcome}`, async () => {
			const gate = Promise.withResolvers<BrokerDiscovery>();
			const entered = Promise.withResolvers<void>();
			let attempts = 0;
			const harness = await brokerRegistrationHarness({
				brokerRegistrationRequired: true,
				lifecycleRequestId: "required-registration-marker",
				ensureBrokerImpl: () => {
					attempts += 1;
					entered.resolve();
					return gate.promise;
				},
			});
			let startupSettled = false;
			let turnSettled = false;
			const startup = harness.emit("session_start").then(
				() => {
					startupSettled = true;
					return undefined;
				},
				error => {
					startupSettled = true;
					return error;
				},
			);
			await entered.promise;
			const turn = harness.emit("turn_start").then(
				() => {
					turnSettled = true;
					return undefined;
				},
				error => {
					turnSettled = true;
					return error;
				},
			);
			try {
				await Bun.sleep(0);
				expect(startupSettled).toBe(false);
				expect(turnSettled).toBe(false);
				expect(harness.turnStarts()).toBe(0);
				expect(attempts).toBe(1);
				expect(harness.recoveryActive()).toBe(false);
				if (outcome === "failure") {
					const error = Object.assign(new Error("required broker unavailable"), { code: "acquire_timeout" });
					gate.reject(error);
					expect(await startup).toBe(error);
					expect(await turn).toBe(error);
					expect(harness.stops()).toBe(1);
					expect(harness.turnStarts()).toBe(0);
					expect(harness.recoveryActive()).toBe(false);
				} else {
					gate.resolve(testBrokerDiscovery);
					expect(await startup).toBeUndefined();
					expect(await turn).toBeUndefined();
					expect(harness.turnStarts()).toBe(1);
					expect(harness.recoveryActive()).toBe(true);
					await harness.emit("turn_start");
					expect(attempts).toBe(1);
				}
			} finally {
				gate.resolve(testBrokerDiscovery);
				await Promise.all([startup, turn]);
				await harness.dispose();
			}
		});
	}

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
		createTestRuntimeExtension(api, {
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

// Production discovery deliberately launches a daemon that outlives its caller.
// Unit fixtures must never launch it: shutting down a host does not own that daemon.
function createTestRuntimeExtension(api: ExtensionAPI, options: CreateSdkSessionRuntimeOptions): void {
	createSdkSessionRuntimeExtension(api, {
		...options,
		ensureBrokerImpl: options.ensureBrokerImpl ?? (async () => testBrokerDiscovery),
	});
}

const testBrokerDiscovery: BrokerDiscovery = {
	version: 1,
	protocolVersion: 3,
	packageGeneration: "test",
	ownerId: "test-broker",
	pid: process.pid,
	incarnation: "test-incarnation",
	host: "127.0.0.1",
	port: 1,
	url: "ws://127.0.0.1:1",
	token: "test-token",
	startedAt: 0,
	heartbeatAt: 0,
};

async function brokerRegistrationHarness(
	options: Pick<
		CreateSdkSessionRuntimeOptions,
		"ensureBrokerImpl" | "brokerRegistrationRequired" | "lifecycleRequestId"
	>,
) {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-registration-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const broadcasts: SdkFrame[] = [];
	let stops = 0;
	let recovery: (() => void) | undefined;
	let recoveryActive = false;
	const timer = { unref() {} } as NodeJS.Timeout;
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	createTestRuntimeExtension(api, {
		...options,
		agentDir: path.join(cwd, "agent"),
		setIntervalImpl: ((callback: () => void) => {
			recovery = callback;
			recoveryActive = true;
			return timer;
		}) as typeof setInterval,
		clearIntervalImpl: (() => {
			recoveryActive = false;
		}) as typeof clearInterval,
		createTransport: async ({ sessionId, stateRoot, token }) => ({
			sessionId,
			stateRoot,
			token,
			onFrame: () => undefined,
			sendFrame: () => {},
			broadcastFrame: frame => {
				broadcasts.push(frame);
			},
			start: async () => {
				const url = "ws://127.0.0.1:1";
				await Bun.write(
					path.join(stateRoot, "sdk", `${sessionId}.json`),
					JSON.stringify({
						sessionId,
						token,
						pid: process.pid,
						url,
					}),
				);
				return { url };
			},
			stop: async () => {
				stops += 1;
			},
		}),
	});
	const context = extensionContext("broker-registration", cwd);
	const emit = async (event: string): Promise<void> => {
		await handlers.get(event)?.({}, context);
	};
	return {
		emit,
		recover: () => recovery?.(),
		recoveryActive: () => recoveryActive,
		stops: () => stops,
		turnStarts: () => broadcasts.filter(frame => frame.type === "event" && frame.kind === "turn_start").length,
		dispose: async () => {
			await emit("session_shutdown");
			await Bun.sleep(0);
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

interface PreflightHooks {
	onDispatchDisposition?: (promotion: { startsOwnRun: boolean }) => void;
	onPreflightAccepted?: () => void;
	onPreflightAcceptCommit?: () => void | Promise<void>;
	expectedSdkRunToken?: string;
	preflightSignal?: AbortSignal;
	queuedAtDispatch?: boolean;
	onQueuedPromoted?: (promotion: { startsOwnRun?: boolean; removed?: boolean }) => void;
}

interface ResponseFrame {
	id?: string;
	ok?: boolean;
	code?: string;
	error?: { code: string; message: string };
	result?: {
		status?: string;
		commandId?: string;
		turnId?: string;
		id?: string;
		accepted?: boolean;
		error?: { code: string; message: string };
	};
}

interface InvocationHarness {
	control(operation: string, input: Record<string, unknown>): Promise<ResponseFrame>;
	controlAs(
		connectionId: string,
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey?: string,
	): Promise<ResponseFrame>;
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
		/** Hold successive matching durable transitions, consumed in arrival order. */
		persistHolds?: Array<{ type: string; onEntered: () => void; release: Promise<void> }>;
		/** Throw to inject a publication failure for a matching broadcast frame. */
		broadcastInterceptor?: (frame: SdkFrame) => void;
		onLifecycleDrainTimeout?: () => void;
		onFailureDiagnosticKeyCount?: (count: number) => void;
		agentFailedWriteFailures?: number;
		onDurableAttempt?: (attempt: {
			type: string | undefined;
			commandId?: string;
			turnId?: string;
			outcome: "rejected" | "committed";
		}) => void;
		branch?: unknown[];
		onInvocationCompletionReconciled?: (kind: string, correlation: { commandId: string; turnId: string }) => void;
		/** Override/extend the INTERNAL terminal-abort seams the runtime is threaded. */
		terminalAbortSeams?: Partial<SdkOnlyTerminalAbortSeams>;
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
				hooks.persistHolds ?? (hooks.persistHold ? [hooks.persistHold] : undefined),
				hooks.onDurableAttempt,
			)
		: undefined;
	createTestRuntimeExtension(api, {
		agentDir: cwd,
		...(hooks.onLifecycleDrainTimeout ? { onLifecycleDrainTimeoutForTests: hooks.onLifecycleDrainTimeout } : {}),
		...(interceptorStore || hooks.terminalAbortSeams
			? {
					terminalAbortSeams: {
						getTerminalTurnEpoch: () => undefined,
						getActivePromptHandle: () => undefined,
						cancelPendingPreflightForTerminalAbort: () => {},
						abortPromptAndWaitWithTerminal: async () => ({ status: "settled", terminalScope: {} }),
						...(interceptorStore ? { getReconciliationStore: () => interceptorStore } : {}),
						...hooks.terminalAbortSeams,
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
		createTransport: async ({ sessionId: id, stateRoot, token }) => {
			let open = false;
			return {
				sessionId: id,
				stateRoot,
				token,
				isConnectionOpen: () => open,
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
					// Interception precedes recording: a frame whose publication throws never
					// reached the wire, so it must not appear in the observed broadcasts.
					hooks.broadcastInterceptor?.(frame);
					broadcasts.push(frame);
				},
				start: async () => {
					open = true;
					return { url: "ws://127.0.0.1:1" };
				},
				stop: async () => {
					open = false;
				},
			};
		},
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
	const request = (frame: Record<string, unknown>, connectionId = "client"): Promise<ResponseFrame> => {
		const id = `frame-${nextId}`;
		nextId += 1;
		const { promise, resolve } = Promise.withResolvers<ResponseFrame>();
		waiters.set(id, resolve);
		deliver?.(connectionId, { ...frame, id } as SdkFrame);
		return promise;
	};
	return {
		control: (operation, input) => request({ type: "control_request", operation, input }),
		controlAs: (connectionId, operation, input, idempotencyKey) =>
			request(
				{
					type: "control_request",
					operation,
					input,
					...(idempotencyKey === undefined ? {} : { idempotencyKey }),
				},
				connectionId,
			),
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

test.each(["natural", "removed"] as const)("SDK-only text follow-up has a durable terminal (%s)", async mode => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-sdk-only-text-followup-${mode}-`));
	let harness: InvocationHarness | undefined;
	let promotion: PreflightHooks["onQueuedPromoted"];
	try {
		harness = await invocationHarness(`sdk-only-text-followup-${mode}`, cwd, {
			sendUserMessage: async (content, options) => {
				await options?.onPreflightAcceptCommit?.();
				if (options?.deliverAs === "followUp") {
					expect(content).toBe("queued generic follow-up");
					options.onDispatchDisposition?.({ startsOwnRun: false });
					promotion = options.onQueuedPromoted;
					return;
				}
				await neverSettlingPromise();
			},
		});
		const root = await harness.controlAs("connection-root", "turn.prompt", { text: "root text" });
		expect(root).toMatchObject({ ok: true, result: { accepted: true } });
		await harness.emit("agent_start");
		const followUp = await harness.controlAs("connection-followup", "turn.follow_up", {
			text: "queued generic follow-up",
		});
		expect(followUp).toMatchObject({ ok: true, result: { accepted: true } });
		const correlation = { commandId: followUp.result?.commandId, turnId: followUp.result?.turnId };
		expect(await harness.query("turn.result", { kind: "prompt", ...correlation })).toMatchObject({
			result: { status: "accepted" },
		});
		expect(promotion).toBeDefined();
		promotion?.({ startsOwnRun: false, ...(mode === "removed" ? { removed: true } : {}) });
		if (mode === "natural")
			await harness.emit("agent_end", {
				messages: [{ role: "assistant", stopReason: "stop", content: "root complete" }],
			});
		expect(await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation })).toMatchObject(
			mode === "natural" ? { status: "terminal_ok" } : { status: "failed", error: { code: "cancelled" } },
		);
		await harness.emit("agent_start");
		await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: "unrelated" }] });
		expect(
			harness.broadcasts.filter(
				frame =>
					frame.type === "event" &&
					frame.kind === "agent_end" &&
					(frame.payload as { commandId?: string; turnId?: string } | undefined)?.commandId ===
						correlation.commandId &&
					(frame.payload as { commandId?: string; turnId?: string } | undefined)?.turnId === correlation.turnId,
			),
		).toHaveLength(1);
	} finally {
		await harness?.stop();
		await rm(cwd, { recursive: true, force: true });
	}
});

test.each([
	"accepting",
	"accepted",
] as const)("SDK-only ordinary abort fences a real %s prompt before agent_start", async phase => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-owned-preflight-${phase}-`));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const clientRef = `owned-before-start-${phase}`;
	const manager = SessionManager.inMemory(cwd);
	const sessionId = manager.getSessionId();
	const store = createReconciliationStore({ sessionFile: path.join(cwd, "session.jsonl"), sessionId });
	const originalRename = fsPromises.rename;
	let held = false;
	let modelCalls = 0;
	let rootAbortCalls = 0;
	let ownedSignal: AbortSignal | undefined;
	let harness: InvocationHarness | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	const renameSpy = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
		if (phase === "accepting" && !held && String(to) === store.path) {
			const document = (await Bun.file(String(from)).json()) as ReconciliationStoreDocument;
			if (document.records.some(record => record.clientRef === clientRef && record.status === "accepted")) {
				held = true;
				entered.resolve();
				await release.promise;
			}
		}
		await originalRename(from, to);
	});
	try {
		authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const mock = createMockModel({
			responses: [
				() => {
					modelCalls++;
					return { content: ["unexpected model execution"] };
				},
			],
		});
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		harness = await invocationHarness(sessionId, cwd, {
			isIdle: () => !session!.isStreaming,
			abort: () => {
				rootAbortCalls++;
			},
			terminalAbortSeams: { getReconciliationStore: () => store },
			sendUserMessage: (content, options) => {
				if (typeof content !== "string") throw new Error("Expected a text-only admission.");
				const { deliverAs, ...admissionOptions } = options ?? {};
				if (deliverAs !== undefined) throw new Error("Expected an ordinary prompt admission.");
				ownedSignal = admissionOptions.preflightSignal;
				return session!.sendUserMessage(content, {
					...admissionOptions,
					onPreflightAcceptCommit: async () => {
						await admissionOptions.onPreflightAcceptCommit?.();
						if (phase === "accepted") {
							entered.resolve();
							await release.promise;
						}
					},
				});
			},
		});
		session.subscribe(async event => {
			await harness?.emit(event.type, event);
		});
		const prompt = harness.controlAs("owner", "turn.prompt", { text: "cancel before execution", clientRef });
		await entered.promise;
		if (phase === "accepted") expect(await prompt).toMatchObject({ ok: true, result: { accepted: true } });
		expect(ownedSignal?.aborted).toBe(false);
		expect(modelCalls).toBe(0);
		expect(await harness.controlAs("owner", "turn.abort", {})).toMatchObject({ ok: true, result: { aborted: true } });
		expect(ownedSignal?.aborted).toBe(true);
		expect(rootAbortCalls).toBe(0);
		release.resolve();
		if (phase === "accepting") expect(await prompt).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await settledStatus(harness, "turn.result", { kind: "prompt", clientRef })).toMatchObject({
			status: "failed",
		});
		await session.waitForIdle();
		expect(modelCalls).toBe(0);
		expect(rootAbortCalls).toBe(0);
		const document = (await Bun.file(store.path!).json()) as ReconciliationStoreDocument;
		const durable = document.records.find(record => record.clientRef === clientRef);
		expect(durable?.status).toBe("failed");
		expect(durable?.terminalAt).toBeNumber();
	} finally {
		release.resolve();
		await session?.waitForIdle().catch(() => undefined);
		await harness?.stop();
		await session?.dispose();
		authStorage?.close();
		renameSpy.mockRestore();
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);

test("SDK-only ordinary abort preserves real foreign and later admissions behind a cancelled durable preflight", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-real-admission-snapshot-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const foreignStarted = Promise.withResolvers<void>();
	const releaseForeign = Promise.withResolvers<void>();
	const manager = SessionManager.inMemory(cwd);
	const sessionId = manager.getSessionId();
	const store = createReconciliationStore({ sessionFile: path.join(cwd, "session.jsonl"), sessionId });
	const originalRename = fsPromises.rename;
	const signals = new Map<string, AbortSignal | undefined>();
	const modelCalls: string[] = [];
	let held = false;
	let rootAbortCalls = 0;
	let harness: InvocationHarness | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	const renameSpy = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
		if (!held && String(to) === store.path) {
			const document = (await Bun.file(String(from)).json()) as ReconciliationStoreDocument;
			if (
				document.records.some(record => record.clientRef === "cancel-owned-real" && record.status === "accepted")
			) {
				held = true;
				entered.resolve();
				await release.promise;
			}
		}
		await originalRename(from, to);
	});
	try {
		authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const mock = createMockModel({
			responses: [
				() => {
					modelCalls.push("seed");
					return { content: ["natural seed completed"] };
				},
				async () => {
					modelCalls.push("foreign");
					foreignStarted.resolve();
					await releaseForeign.promise;
					return { content: ["foreign admission completed"] };
				},
				() => {
					modelCalls.push("later-owner");
					return { content: ["later owner admission completed"] };
				},
			],
		});
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		harness = await invocationHarness(sessionId, cwd, {
			isIdle: () => !session!.isStreaming,
			abort: () => {
				rootAbortCalls++;
			},
			terminalAbortSeams: { getReconciliationStore: () => store },
			sendUserMessage: (content, options) => {
				if (typeof content !== "string") throw new Error("Expected text-only real admission.");
				signals.set(content, options?.preflightSignal);
				const { deliverAs, ...admissionOptions } = options ?? {};
				if (deliverAs !== undefined && deliverAs !== "steer" && deliverAs !== "followUp")
					throw new Error("Unsupported real admission delivery mode.");
				return session!.sendUserMessage(content, {
					...admissionOptions,
					...(deliverAs === undefined ? {} : { deliverAs }),
				});
			},
		});
		session.subscribe(async event => {
			await harness?.emit(event.type, event);
		});
		expect(
			await harness.controlAs("seed-owner", "turn.prompt", { text: "seed-real", clientRef: "seed-real" }),
		).toMatchObject({ ok: true, result: { accepted: true } });
		expect(await settledStatus(harness, "turn.result", { kind: "prompt", clientRef: "seed-real" })).toMatchObject({
			status: "terminal_ok",
		});
		await session.waitForIdle();
		const owned = harness.controlAs("owner", "turn.prompt", {
			text: "cancel-owned-real",
			clientRef: "cancel-owned-real",
		});
		await entered.promise;
		expect(modelCalls).toEqual(["seed"]);
		expect(signals.get("cancel-owned-real")?.aborted).toBe(false);
		const foreign = harness.controlAs("foreign", "turn.prompt", { text: "foreign-real", clientRef: "foreign-real" });
		expect(await harness.controlAs("owner", "turn.abort", {})).toMatchObject({ ok: true, result: { aborted: true } });
		expect(signals.get("cancel-owned-real")?.aborted).toBe(true);
		expect(rootAbortCalls).toBe(0);
		release.resolve();
		expect(await owned).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(
			await settledStatus(harness, "turn.result", { kind: "prompt", clientRef: "cancel-owned-real" }),
		).toMatchObject({ status: "failed" });
		expect(await foreign).toMatchObject({ ok: true, result: { accepted: true } });
		await foreignStarted.promise;
		const later = harness.controlAs("owner", "turn.prompt", {
			text: "later-owner-real",
			clientRef: "later-owner-real",
		});
		expect(await later).toMatchObject({ ok: true, result: { accepted: true } });
		expect(signals.get("foreign-real")?.aborted).toBe(false);
		expect(signals.get("later-owner-real")?.aborted).toBe(false);
		expect(modelCalls).toEqual(["seed", "foreign"]);
		const pendingDocument = (await Bun.file(store.path!).json()) as ReconciliationStoreDocument;
		const pendingLater = pendingDocument.records.find(record => record.clientRef === "later-owner-real");
		expect(pendingLater?.status).toBe("accepted");
		expect(pendingLater?.startedAt).toBeUndefined();
		expect(pendingLater?.terminalAt).toBeUndefined();
		releaseForeign.resolve();
		await session.waitForIdle();
		expect(modelCalls).toEqual(["seed", "foreign", "later-owner"]);
		expect(rootAbortCalls).toBe(0);
		for (const clientRef of ["foreign-real", "later-owner-real"]) {
			expect(await settledStatus(harness, "turn.result", { kind: "prompt", clientRef })).toMatchObject({
				status: "terminal_ok",
			});
		}
		const document = (await Bun.file(store.path!).json()) as ReconciliationStoreDocument;
		for (const [clientRef, status] of [
			["cancel-owned-real", "failed"],
			["foreign-real", "terminal_ok"],
			["later-owner-real", "terminal_ok"],
		] as const) {
			const record = document.records.find(candidate => candidate.clientRef === clientRef);
			expect(record?.status).toBe(status);
			expect(record?.terminalAt).toBeNumber();
		}
	} finally {
		release.resolve();
		releaseForeign.resolve();
		await session?.waitForIdle().catch(() => undefined);
		await harness?.stop();
		await session?.dispose();
		authStorage?.close();
		renameSpy.mockRestore();
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);

test.each([
	"ordinary",
	"terminal",
] as const)("SDK-only %s abort cancels only its generic queued owner behind a real active AgentSession run", async mode => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-sdk-queued-text-${mode}-`));
	const rootGate = Promise.withResolvers<void>();
	const rootStarted = Promise.withResolvers<void>();
	const failedRemovalWrite = Promise.withResolvers<void>();
	const modelCalls: number[] = [];
	let rootAbortCalls = 0;
	let queuedPreflightSignal: AbortSignal | undefined;
	let harness: InvocationHarness | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	try {
		authStorage = await AuthStorage.create(path.join(cwd, "testauth.db"));
		const mock = createMockModel({
			responses: [
				async () => {
					modelCalls.push(Date.now());
					rootStarted.resolve();
					await rootGate.promise;
					return { content: ["root completed"] };
				},
				() => {
					modelCalls.push(Date.now());
					return { content: ["unrelated follow-up completed"] };
				},
			],
		});
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const hooks: Parameters<typeof invocationHarness>[2] = {
			isIdle: () => !session!.isStreaming,
			abort: () => {
				rootAbortCalls += 1;
			},
			sendUserMessage: (content, options) => {
				if (content === "cancel only this queued text") queuedPreflightSignal = options?.preflightSignal;
				return session!.sendUserMessage(content as never, options as never);
			},
			...(mode === "ordinary"
				? {
						persistInterceptor: transition => {
							if (transition.type === "agent_failed") failedRemovalWrite.resolve();
						},
						agentFailedWriteFailures: 1,
						onDurableAttempt: attempt => {
							if (attempt.type === "agent_failed" && attempt.outcome === "rejected")
								failedRemovalWrite.resolve();
						},
					}
				: {
						terminalAbortSeams: {
							getTerminalTurnEpoch: () => (session?.isStreaming ? 17 : undefined),
							getActivePromptHandle: () => (session?.isStreaming ? "root-run-handle" : undefined),
							getActivePromptOwnerConnectionId: () => (session?.isStreaming ? "connection-root" : undefined),
							cancelPendingPreflightForTerminalAbort: () => {},
							abortPromptAndWaitWithTerminal: async () => {
								rootAbortCalls += 1;
								return { status: "settled", terminalScope: {} };
							},
						},
					}),
		};
		harness = await invocationHarness(`queued-text-${mode}`, cwd, hooks);
		session.subscribe(async event => {
			await harness?.emit(event.type, event);
		});

		const root = await harness.controlAs("connection-root", "turn.prompt", { text: "root owned by B" });
		expect(root).toMatchObject({ ok: true, result: { accepted: true } });
		await rootStarted.promise;
		const unrelated = await harness.controlAs("connection-other", "turn.prompt", {
			text: "keep unrelated queued text",
		});
		expect(unrelated).toMatchObject({ ok: true, result: { accepted: true } });
		const queued = await harness.controlAs("connection-requester", "turn.prompt", {
			text: "cancel only this queued text",
		});
		expect(queued).toMatchObject({ ok: true, result: { accepted: true } });
		const correlation = { commandId: queued.result?.commandId, turnId: queued.result?.turnId };
		expect(queuedPreflightSignal).toBeInstanceOf(AbortSignal);
		expect(queuedPreflightSignal?.aborted).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([
			"keep unrelated queued text",
			"cancel only this queued text",
		]);

		let abortCompleted = false;
		const abortRequest =
			mode === "ordinary"
				? harness.controlAs("connection-requester", "turn.abort", { mode: "turn" })
				: harness.controlAs("connection-requester", "turn.abort", { mode: "terminal" }, "queued-text-terminal");
		const observedAbort = abortRequest.then(response => {
			abortCompleted = true;
			return response;
		});
		if (mode === "ordinary") {
			await failedRemovalWrite.promise;
			await Bun.sleep(0);
			expect(abortCompleted).toBe(false);
		}
		const abortResponse = await observedAbort;
		if (mode === "ordinary") expect(abortResponse).toMatchObject({ ok: true, result: { aborted: true } });
		else
			expect(abortResponse).toMatchObject({
				ok: true,
				result: { turn: "no_active_turn", terminal: "terminal_no_effect" },
			});
		expect(queuedPreflightSignal?.aborted).toBe(true);
		expect(rootAbortCalls).toBe(0);
		expect(session.isStreaming).toBe(true);
		expect(session.getQueuedMessages().steering).toEqual(["keep unrelated queued text"]);
		expect(await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation })).toMatchObject({
			status: "failed",
			error: { code: "cancelled" },
		});
		const repeatedAbort = await harness.controlAs(
			"connection-requester",
			"turn.abort",
			mode === "ordinary" ? { mode: "turn" } : { mode: "terminal" },
			mode === "terminal" ? "queued-text-terminal-retry" : undefined,
		);
		if (mode === "ordinary")
			expect(repeatedAbort).toMatchObject({ ok: true, result: { aborted: false, turn: "no_active_turn" } });
		else
			expect(repeatedAbort).toMatchObject({
				ok: true,
				result: { turn: "no_active_turn", terminal: "terminal_no_effect" },
			});
		expect(rootAbortCalls).toBe(0);
		expect(session.isStreaming).toBe(true);
		expect(session.getQueuedMessages().steering).toEqual(["keep unrelated queued text"]);

		rootGate.resolve();
		await session.waitForIdle();
		const userMessages = session.agent.state.messages.filter(
			(message): message is UserMessage => message.role === "user",
		);
		const userText = (message: (typeof userMessages)[number]): string =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("");
		expect(userMessages.map(userText)).toEqual(["root owned by B", "keep unrelated queued text"]);
		expect(modelCalls).toHaveLength(2);
		expect(
			harness.broadcasts.filter(
				frame =>
					frame.type === "event" &&
					frame.kind === "agent_end" &&
					(frame.payload as { commandId?: string; turnId?: string } | undefined)?.commandId ===
						correlation.commandId &&
					(frame.payload as { commandId?: string; turnId?: string } | undefined)?.turnId === correlation.turnId,
			),
		).toHaveLength(1);
	} finally {
		rootGate.resolve();
		await session?.waitForIdle().catch(() => undefined);
		await harness?.stop();
		await session?.dispose();
		authStorage?.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
test("SDK-only host retains accepted staged bytes until terminal and releases rejected images", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-only-staged-image-"));
	const originalRedeem = PromptImageUploadStore.prototype.redeem;
	const releases: string[] = [];
	const redeemSpy = spyOn(PromptImageUploadStore.prototype, "redeem").mockImplementation(function (
		this: PromptImageUploadStore,
		owner,
		ids,
	) {
		const reservation = originalRedeem.call(this, owner, ids);
		return {
			images: reservation.images,
			release: () => {
				releases.push("released");
				reservation.release();
			},
		};
	});
	let harness: InvocationHarness | undefined;
	try {
		const sent: unknown[] = [];
		const queuedPromotions: Array<NonNullable<PreflightHooks["onQueuedPromoted"]>> = [];
		const activeHarness = await invocationHarness("sdk-only-image-test", cwd, {
			sendUserMessage: async (content, options) => {
				sent.push(content);
				if (options?.onQueuedPromoted) queuedPromotions.push(options.onQueuedPromoted);
				await options?.onPreflightAcceptCommit?.();
				await Promise.withResolvers<void>().promise;
			},
		});
		harness = activeHarness;
		const bytes = Buffer.from(
			await Bun.file(new URL("../../../test/fixtures/sdk-inline-image-large.png", import.meta.url)).arrayBuffer(),
		);
		expect(bytes.length).toBeGreaterThan(256 * 1024);
		const digest = createHash("sha256").update(bytes).digest("hex");
		const stage = async (): Promise<string> => {
			const begun = await activeHarness.control("turn.image.begin", {
				mimeType: "image/png",
				byteLength: bytes.length,
				sha256: digest,
			});
			const id = begun.result?.id;
			expect(begun.ok).toBe(true);
			if (!id) throw new Error("Host did not return a staged image ID.");
			expect(id).toMatch(/^[0-9a-f]{8}-/);
			let sequence = 0;
			for (let offset = 0; offset < bytes.length; offset += 96 * 1024) {
				const data = bytes.subarray(offset, offset + 96 * 1024).toString("base64");
				expect(Buffer.byteLength(JSON.stringify({ id, sequence, data }))).toBeLessThan(256 * 1024);
				expect((await activeHarness.control("turn.image.append", { id, sequence, data })).ok).toBe(true);
				sequence++;
			}
			expect((await activeHarness.control("turn.image.finish", { id })).ok).toBe(true);
			return id;
		};
		const id = await stage();
		const accepted = await harness.control("turn.prompt", { text: "Read image", stagedImages: [{ id }] });
		expect(accepted).toMatchObject({ ok: true, result: { accepted: true } });
		expect(releases).toEqual([]);
		expect((sent[0] as Array<{ type: string; data?: string }>)[1]?.data).toBe(bytes.toString("base64"));
		const rejectedId = await stage();
		expect(
			await harness.control("turn.prompt", {
				text: "Reject this",
				stagedImages: [{ id: rejectedId }],
				clientRef: " ",
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_input" } });
		expect(releases).toHaveLength(1);
		expect(sent).toHaveLength(1);
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("agent_end", {
			messages: [{ role: "assistant", stopReason: "stop", content: "Completed." }],
		});
		expect(releases).toHaveLength(2);
		await harness.emit("agent_end", {
			messages: [{ role: "assistant", stopReason: "stop", content: "Completed." }],
		});
		expect(releases).toHaveLength(2);
		const racedId = await stage();
		const removed = await harness.control("turn.prompt", {
			text: "Diverted after idle snapshot",
			stagedImages: [{ id: racedId }],
		});
		expect(removed).toMatchObject({ ok: true, result: { accepted: true } });
		expect(releases).toHaveLength(2);
		queuedPromotions[1]?.({ startsOwnRun: false, removed: true });
		expect(
			await settledStatus(harness, "turn.result", {
				kind: "prompt",
				commandId: removed.result?.commandId,
				turnId: removed.result?.turnId,
			}),
		).toMatchObject({ status: "failed", error: { code: "cancelled" } });
		expect(releases).toHaveLength(3);
		await harness.stop();
		harness = undefined;
		expect(releases).toHaveLength(3);
	} finally {
		await harness?.stop();
		redeemSpy.mockRestore();
		await rm(cwd, { recursive: true, force: true });
	}
});

test.each(["natural", "removed"] as const)("SDK-only staged diversion has a durable terminal (%s)", async mode => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-only-diverted-image-"));
	let harness: InvocationHarness | undefined;
	let promotion: PreflightHooks["onQueuedPromoted"];
	try {
		harness = await invocationHarness(`sdk-only-diverted-${mode}`, cwd, {
			sendUserMessage: async (content, options) => {
				await options?.onPreflightAcceptCommit?.();
				if (Array.isArray(content)) {
					options?.onDispatchDisposition?.({ startsOwnRun: false });
					promotion = options?.onQueuedPromoted;
					return;
				}
				await neverSettlingPromise();
			},
		});
		const original = await harness.control("turn.prompt", { text: "original" });
		expect(original.ok).toBe(true);
		await harness.emit("agent_start");
		const bytes = Buffer.from(
			await Bun.file(new URL("../../../test/fixtures/sdk-inline-image-large.png", import.meta.url)).arrayBuffer(),
		);
		const begun = await harness.control("turn.image.begin", {
			mimeType: "image/png",
			byteLength: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
		expect(begun.ok).toBe(true);
		const id = begun.result?.id;
		let sequence = 0;
		for (let offset = 0; offset < bytes.length; offset += 96 * 1024) {
			expect(
				await harness.control("turn.image.append", {
					id,
					sequence: sequence++,
					data: bytes.subarray(offset, offset + 96 * 1024).toString("base64"),
				}),
			).toMatchObject({ ok: true });
		}
		expect(await harness.control("turn.image.finish", { id })).toMatchObject({ ok: true });
		const admitted = await harness.control("turn.prompt", { text: "joined image", stagedImages: [{ id }] });
		expect(admitted).toMatchObject({ ok: true, result: { accepted: true } });
		const correlation = { commandId: admitted.result?.commandId, turnId: admitted.result?.turnId };
		expect((await harness.query("turn.result", { kind: "prompt", ...correlation })).result?.status).toBe("accepted");
		expect(promotion).toBeDefined();
		promotion?.({ startsOwnRun: false, ...(mode === "removed" ? { removed: true } : {}) });
		if (mode === "natural")
			await harness.emit("agent_end", {
				messages: [{ role: "assistant", stopReason: "stop", content: "image done" }],
			});
		expect(await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation })).toMatchObject(
			mode === "natural" ? { status: "terminal_ok" } : { status: "failed", error: { code: "cancelled" } },
		);
		await harness.emit("agent_start");
		await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: "unrelated" }] });
		expect(
			harness.broadcasts.filter(
				frame =>
					frame.type === "event" &&
					frame.kind === "agent_end" &&
					(frame.payload as { commandId?: string; turnId?: string } | undefined)?.commandId ===
						correlation.commandId &&
					(frame.payload as { commandId?: string; turnId?: string } | undefined)?.turnId === correlation.turnId,
			),
		).toHaveLength(1);
	} finally {
		await harness?.stop();
		await rm(cwd, { recursive: true, force: true });
	}
});

test.each([
	"ordinary",
	"terminal",
] as const)("SDK-only %s abort cancels only its accepted image queue owner behind a real active AgentSession run", async mode => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-sdk-queued-image-${mode}-`));
	const rootGate = Promise.withResolvers<void>();
	const rootStarted = Promise.withResolvers<void>();
	const failedRemovalWrite = Promise.withResolvers<void>();
	const modelCalls: number[] = [];
	let rootAbortCalls = 0;
	let imagePreflightSignal: AbortSignal | undefined;
	let harness: InvocationHarness | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	try {
		authStorage = await AuthStorage.create(path.join(cwd, "testauth.db"));
		const mock = createMockModel({
			responses: [
				async () => {
					modelCalls.push(Date.now());
					rootStarted.resolve();
					await rootGate.promise;
					return { content: ["B root completed"] };
				},
				() => {
					modelCalls.push(Date.now());
					return { content: ["unrelated queued steer completed"] };
				},
			],
		});
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(cwd),
			settings,
			modelRegistry,
		});
		const hooks: Parameters<typeof invocationHarness>[2] = {
			isIdle: () => !session!.isStreaming,
			abort: () => {
				rootAbortCalls += 1;
			},
			sendUserMessage: (content, sendOptions) => {
				if (
					Array.isArray(content) &&
					content.some(block => typeof block === "object" && block !== null && block.type === "image")
				)
					imagePreflightSignal = sendOptions?.preflightSignal;
				return session!.sendUserMessage(content as never, sendOptions as never);
			},
			...(mode === "ordinary"
				? {
						persistInterceptor: transition => {
							if (transition.type === "agent_failed") failedRemovalWrite.resolve();
						},
						agentFailedWriteFailures: 1,
						onDurableAttempt: attempt => {
							if (attempt.type === "agent_failed" && attempt.outcome === "rejected")
								failedRemovalWrite.resolve();
						},
					}
				: {
						terminalAbortSeams: {
							getTerminalTurnEpoch: () => (session?.isStreaming ? 17 : undefined),
							getActivePromptHandle: () => (session?.isStreaming ? "B-root-handle" : undefined),
							getActivePromptOwnerConnectionId: () => (session?.isStreaming ? "B" : undefined),
							cancelPendingPreflightForTerminalAbort: () => {},
							abortPromptAndWaitWithTerminal: async () => {
								rootAbortCalls += 1;
								return { status: "settled", terminalScope: {} };
							},
						},
					}),
		};
		harness = await invocationHarness(`queued-image-${mode}`, cwd, hooks);
		session.subscribe(async event => {
			await harness?.emit(event.type, event);
		});

		const rootAccepted = await harness.controlAs("B", "turn.prompt", { text: "B owns the active root" });
		expect(rootAccepted).toMatchObject({ ok: true, result: { accepted: true } });
		await rootStarted.promise;
		const keepQueued = await harness.controlAs("C", "turn.prompt", { text: "keep unrelated queue item" });
		expect(keepQueued).toMatchObject({ ok: true, result: { accepted: true } });

		const imageBytes = Buffer.from(
			await Bun.file(new URL("../../../test/fixtures/sdk-inline-image-large.png", import.meta.url)).arrayBuffer(),
		);
		const begun = await harness.controlAs("A", "turn.image.begin", {
			mimeType: "image/png",
			byteLength: imageBytes.length,
			sha256: createHash("sha256").update(imageBytes).digest("hex"),
		});
		const imageId = begun.result?.id;
		expect(begun.ok).toBe(true);
		if (typeof imageId !== "string") throw new Error("SDK host did not return a staged image ID.");
		let sequence = 0;
		for (let offset = 0; offset < imageBytes.length; offset += 96 * 1024) {
			const data = imageBytes.subarray(offset, offset + 96 * 1024).toString("base64");
			expect(
				await harness.controlAs("A", "turn.image.append", { id: imageId, sequence: sequence++, data }),
			).toMatchObject({ ok: true });
		}
		expect(await harness.controlAs("A", "turn.image.finish", { id: imageId })).toMatchObject({ ok: true });
		const acceptedImage = await harness.controlAs("A", "turn.prompt", {
			text: "cancel exact queued image",
			stagedImages: [{ id: imageId }],
		});
		expect(acceptedImage).toMatchObject({ ok: true, result: { accepted: true } });
		const imageCorrelation = {
			commandId: acceptedImage.result?.commandId,
			turnId: acceptedImage.result?.turnId,
		};
		expect(imagePreflightSignal).toBeInstanceOf(AbortSignal);
		expect(imagePreflightSignal?.aborted).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual(["keep unrelated queue item", "cancel exact queued image"]);

		let abortCompleted = false;
		const abortRequest =
			mode === "ordinary"
				? harness.controlAs("A", "turn.abort", { mode: "turn" })
				: harness.controlAs("A", "turn.abort", { mode: "terminal" }, `queued-image-${mode}-key`);
		const observedAbort = abortRequest.then(response => {
			abortCompleted = true;
			return response;
		});
		if (mode === "ordinary") {
			await failedRemovalWrite.promise;
			await Bun.sleep(0);
			expect(abortCompleted).toBe(false);
		}
		const abortResponse = await observedAbort;
		if (mode === "ordinary") expect(abortResponse).toMatchObject({ ok: true, result: { aborted: true } });
		else
			expect(abortResponse).toMatchObject({
				ok: true,
				result: { turn: "no_active_turn", terminal: "terminal_no_effect" },
			});
		expect(imagePreflightSignal?.aborted).toBe(true);
		expect(rootAbortCalls).toBe(0);
		expect(session.isStreaming).toBe(true);
		expect(session.getQueuedMessages().steering).toEqual(["keep unrelated queue item"]);
		expect(await settledStatus(harness, "turn.result", { kind: "prompt", ...imageCorrelation })).toMatchObject({
			status: "failed",
			error: { code: "cancelled" },
		});
		if (mode === "ordinary") {
			const repeatedAbort = await harness.controlAs("A", "turn.abort", { mode: "turn" });
			expect(repeatedAbort).toMatchObject({
				ok: true,
				result: { aborted: false, turn: "no_active_turn" },
			});
			expect(rootAbortCalls).toBe(0);
			expect(session.isStreaming).toBe(true);
			expect(session.getQueuedMessages().steering).toEqual(["keep unrelated queue item"]);
		}

		rootGate.resolve();
		await session.waitForIdle();
		const userMessages = session.agent.state.messages;
		const hasUserText = (text: string): boolean =>
			userMessages.some(message => {
				if (message.role !== "user") return false;
				return typeof message.content === "string"
					? message.content === text
					: message.content.some(block => block.type === "text" && block.text === text);
			});
		expect(hasUserText("keep unrelated queue item")).toBe(true);
		expect(hasUserText("cancel exact queued image")).toBe(false);
		expect(
			userMessages.some(
				message =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some(block => block.type === "image" && block.data === imageBytes.toString("base64")),
			),
		).toBe(false);
		expect(modelCalls).toHaveLength(2);
		const correlatedTerminals = harness.broadcasts.filter(
			frame =>
				frame.type === "event" &&
				frame.kind === "agent_end" &&
				(frame.payload as { commandId?: string; turnId?: string } | undefined)?.commandId ===
					imageCorrelation.commandId &&
				(frame.payload as { commandId?: string; turnId?: string } | undefined)?.turnId === imageCorrelation.turnId,
		);
		expect(correlatedTerminals).toHaveLength(1);
	} finally {
		rootGate.resolve();
		await session?.waitForIdle().catch(() => undefined);
		await harness?.stop();
		await session?.dispose();
		authStorage?.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK-only ordinary abort selects its owned root ahead of same-connection queued input", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-only-owned-root-selection-"));
	let harness: InvocationHarness | undefined;
	let idle = true;
	let rootAborts = 0;
	let queuedSignal: AbortSignal | undefined;
	let queuedPromotion: PreflightHooks["onQueuedPromoted"];
	try {
		harness = await invocationHarness("sdk-only-owned-root-selection", cwd, {
			isIdle: () => idle,
			abort: () => {
				rootAborts++;
			},
			sendUserMessage: async (content, options) => {
				await options?.onPreflightAcceptCommit?.();
				if (content === "root") await neverSettlingPromise();
				else {
					queuedSignal = options?.preflightSignal;
					queuedPromotion = options?.onQueuedPromoted;
					options?.onDispatchDisposition?.({ startsOwnRun: false });
				}
			},
		});
		expect(await harness.control("turn.prompt", { text: "root" })).toMatchObject({ ok: true });
		idle = false;
		await harness.emit("agent_start");
		expect(await harness.control("turn.prompt", { text: "queued for later" })).toMatchObject({ ok: true });
		expect(queuedSignal?.aborted).toBe(false);
		expect(await harness.control("turn.abort", {})).toMatchObject({ ok: true, result: { aborted: true } });
		expect(rootAborts).toBe(1);
		expect(queuedSignal?.aborted).toBe(false);
		queuedPromotion?.({ startsOwnRun: false, removed: true });
	} finally {
		await harness?.stop();
		await rm(cwd, { recursive: true, force: true });
	}
});

/** Reconciliation store used to inject durable-write failures from tests: wraps a
 * session-file-backed store and fails the write whenever the staged records contain
 * the intermediate failed-without-terminal state an agent_failed transition persists. */
function createInterceptorReconciliationStore(
	interceptor: (transition: { type: string }) => void,
	agentFailedWriteFailures = 1,
	persistHolds?: Array<{ type: string; onEntered: () => void; release: Promise<void> }>,
	// TEST-ONLY observability. `interceptor` fires only on REJECTED agent_failed
	// writes, so a successful recovery write is invisible to it. This observer sees
	// EVERY durable attempt with its correlation and whether it committed, so a
	// branch test can assert the third attempt actually happened instead of
	// inferring it from a missing callback.
	onDurableAttempt?: (attempt: {
		type: string | undefined;
		commandId?: string;
		turnId?: string;
		outcome: "rejected" | "committed";
	}) => void,
): SdkOnlyReconciliationStore {
	const failureCounts = new Map<string, number>();
	let nextHold = 0;
	const backing = createInterceptorBackingStore();
	return {
		path: null,
		load: async () => backing.records.map(record => ({ ...record })),
		async transact(mutator) {
			const records = mutator(backing.records.map(record => ({ ...record })));
			let transitionType: string | undefined;
			for (const record of records as Array<{
				status?: string;
				terminalAt?: number;
				commandId?: string;
				pendingOutcome?: unknown;
			}>) {
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
					onDurableAttempt?.({
						type: "agent_failed",
						commandId: record?.commandId,
						turnId: (record as { turnId?: string }).turnId,
						outcome: "rejected",
					});
					throw Object.assign(new Error("injected persistence failure"), { code: "io_error" });
				}
				const previous = backing.records.find(candidate => candidate.commandId === record.commandId);
				const previousPendingOutcome = (
					previous as
						| (SdkOnlyInvocationRecord & { pendingOutcome?: { kind?: string; code?: string; reason?: string } })
						| undefined
				)?.pendingOutcome;
				const pendingOutcome = record.pendingOutcome as
					| { kind?: string; code?: string; reason?: string }
					| undefined;
				if (record.terminalAt === undefined && pendingOutcome !== undefined) {
					if (previousPendingOutcome === undefined) transitionType ??= "deadline_claim";
					else if (
						pendingOutcome.kind !== previousPendingOutcome.kind ||
						pendingOutcome.code !== previousPendingOutcome.code ||
						pendingOutcome.reason !== previousPendingOutcome.reason
					)
						transitionType = "pending_terminal_outcome";
				}
				if (record?.terminalAt !== undefined && previous?.terminalAt === undefined) {
					transitionType = "agent_end";
					interceptor({ type: "agent_end" });
				}
			}
			if (transitionType === "pending_terminal_outcome") interceptor({ type: transitionType });
			const hold = persistHolds?.[nextHold];
			if (hold && hold.type === transitionType) {
				nextHold += 1;
				hold.onEntered();
				await hold.release;
			}
			for (const record of records as Array<{ commandId?: string; turnId?: string }>)
				onDurableAttempt?.({
					type: transitionType,
					commandId: record?.commandId,
					turnId: record?.turnId,
					outcome: "committed",
				});
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

function typedContextOverflowStream(model: Model, onEmitted?: () => void): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage & {
			transportFailure: { kind: "transport"; status: number; openaiErrorCode: string };
		} = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "",
			errorStatus: 400,
			timestamp: Date.now(),
			transportFailure: { kind: "transport", status: 400, openaiErrorCode: "context_length_exceeded" },
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
		onEmitted?.();
	});
	return stream;
}

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

async function createTerminalizationSession(
	cwd: string,
	streamFn: AgentOptions["streamFn"],
	settingsOverrides: Record<string, unknown> = {},
	withExtensions = false,
): Promise<{ session: AgentSession; authStorage: AuthStorage; model: Model }> {
	const authStorage = await AuthStorage.create(path.join(cwd, "testauth.db"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	const fallback = getBundledModel("openai", "gpt-4o-mini");
	if (!model || !fallback) throw new Error("Expected bundled test models");
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	authStorage.setRuntimeApiKey(fallback.provider, "test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"contextPromotion.enabled": false,
		"fallback.maxAttempts": 3,
		"retry.baseDelayMs": 1,
		...settingsOverrides,
	});
	settings.setModelRole("default", selector(model));
	const agent = new Agent({
		getApiKey: provider => `${provider}-key`,
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn,
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const modelRegistry = new ModelRegistry(authStorage);
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		extensionRunner: withExtensions
			? new ExtensionRunner(
					[],
					{ flagValues: new Map(), pendingProviderRegistrations: [] } as never,
					cwd,
					sessionManager,
					modelRegistry,
					undefined,
					settings,
				)
			: undefined,
	});
	session.setConfiguredModelChain("default", [selector(model), selector(fallback)], "test");
	return { session, authStorage, model };
}

function deferredRealSendUserMessage(session: AgentSession) {
	return async (content: unknown, options?: PreflightHooks & { deliverAs?: string }): Promise<void> => {
		await options?.onPreflightAcceptCommit?.();
		const { onPreflightAcceptCommit: _onPreflightAcceptCommit, ...dispatchOptions } = options ?? {};
		void session.sendUserMessage(content as string, dispatchOptions as never);
		await neverSettlingPromise();
	};
}

function realSendUserMessage(session: AgentSession) {
	return async (content: unknown, options?: PreflightHooks & { deliverAs?: string }): Promise<void> => {
		await options?.onPreflightAcceptCommit?.();
		const { onPreflightAcceptCommit: _onPreflightAcceptCommit, ...dispatchOptions } = options ?? {};
		await session.sendUserMessage(content as string, dispatchOptions as never);
	};
}

test.each([
	"clearContext",
	"newSession",
	"compact",
] as const)("SDK %s disconnect cancels only its accepted publication owner before disposal", async operation => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-sdk-${operation}-publication-`));
	const entered = Promise.withResolvers<void>();
	const freshEntered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let harness: InvocationHarness | undefined;
	let submission: Promise<void> | undefined;
	let providerCalls = 0;
	try {
		const real = await createTerminalizationSession(cwd, (model, context, options) => {
			providerCalls++;
			if (providerCalls === 2) freshEntered.resolve();
			if (providerCalls === 1)
				options?.signal?.addEventListener(
					"abort",
					() => {
						if (operation === "compact") session?.abortCompaction();
						aborted.resolve();
					},
					{ once: true },
				);
			return createMockModel({
				responses: [
					async () => {
						if (providerCalls === 1) {
							entered.resolve();
							await release.promise;
						}
						return { content: ["fresh independent completion"] };
					},
				],
			}).stream(model, context, options);
		});
		session = real.session;
		authStorage = real.authStorage;
		const send = realSendUserMessage(session);
		harness = await invocationHarness(`disconnect-publication-${operation}`, cwd, {
			isIdle: () => !session?.isStreaming,
			sendUserMessage: (content, options) => {
				submission = send(content, options);
				void submission.catch(() => undefined);
				return submission;
			},
		});
		session.subscribe(event => harness?.emit(event.type, event));
		expect((await harness.control("turn.prompt", { text: "cancel this disconnected owner" })).ok).toBe(true);
		await entered.promise;
		const transition = operation === "compact" ? session.compact() : session[operation]();
		void transition.catch(() => undefined);
		await aborted.promise;
		release.resolve();
		if (operation === "compact") await expect(transition).rejects.toBeInstanceOf(CompactionCancelledError);
		else expect(await transition).toBe(true);
		if (!submission) throw new Error("Expected the accepted actual SDK submission promise.");
		await expect(submission).rejects.toMatchObject({ code: "cancelled" });
		const fresh = await harness.control("turn.prompt", { text: "run a fresh independent prompt" });
		expect(fresh.ok).toBe(true);
		await freshEntered.promise;
		await expect(submission).resolves.toBeUndefined();
		expect(
			await settledStatus(harness, "turn.result", {
				kind: "prompt",
				commandId: fresh.result?.commandId,
				turnId: fresh.result?.turnId,
			}),
		).toMatchObject({ status: "terminal_ok" });
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "fresh independent completion" }],
		});
		expect(providerCalls).toBe(2);
	} finally {
		release.resolve();
		await session?.dispose();
		authStorage?.close();
		await harness?.stop();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK disconnect preserves an already published projected terminal's actual submission", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-publishing-disconnect-"));
	const delivered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let harness: InvocationHarness | undefined;
	let submission: Promise<void> | undefined;
	let restoreEmission: (() => void) | undefined;
	let terminalCount = 0;
	try {
		const real = await createTerminalizationSession(
			cwd,
			(model, context, options) =>
				createMockModel({ responses: [{ content: ["projected completion"] }] }).stream(model, context, options),
			{},
			true,
		);
		session = real.session;
		authStorage = real.authStorage;
		const send = realSendUserMessage(session);
		harness = await invocationHarness("publishing-disconnect", cwd, {
			isIdle: () => !session?.isStreaming,
			sendUserMessage: (content, options) => {
				submission = send(content, options);
				void submission.catch(() => undefined);
				return submission;
			},
		});
		session.subscribe(event => (event.type === "agent_end" ? undefined : harness?.emit(event.type, event)));
		const runner = session.extensionRunner;
		if (!runner) throw new Error("Expected the real projected terminal extension bridge.");
		const emit = runner.emit.bind(runner);
		const emission = spyOn(runner, "emit").mockImplementation(async event => {
			const result = await emit(event);
			if (event.type === "agent_end") {
				terminalCount++;
				await harness?.emit(event.type, event);
				delivered.resolve();
				await release.promise;
			}
			return result;
		});
		restoreEmission = () => emission.mockRestore();
		const accepted = await harness.control("turn.prompt", { text: "publish then disconnect this owner" });
		expect(accepted.ok).toBe(true);
		await delivered.promise;
		expect(
			await settledStatus(harness, "turn.result", {
				kind: "prompt",
				commandId: accepted.result?.commandId,
				turnId: accepted.result?.turnId,
			}),
		).toMatchObject({ status: "terminal_ok", content: { text: "projected completion" } });
		const transition = session.clearContext();
		release.resolve();
		expect(await transition).toBe(true);
		if (!submission) throw new Error("Expected the actual publishing SDK submission promise.");
		await expect(submission).resolves.toBeUndefined();
		expect(terminalCount).toBe(1);
	} finally {
		release.resolve();
		restoreEmission?.();
		await session?.dispose();
		authStorage?.close();
		await harness?.stop();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK disposal rejects an accepted real submission whose terminal bridge is disconnected", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-dispose-publication-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let harness: InvocationHarness | undefined;
	let submission: Promise<void> | undefined;
	try {
		const real = await createTerminalizationSession(cwd, (model, context, options) =>
			createMockModel({
				responses: [
					async () => {
						entered.resolve();
						await release.promise;
						return { content: ["completed"] };
					},
				],
			}).stream(model, context, options),
		);
		session = real.session;
		authStorage = real.authStorage;
		const send = realSendUserMessage(session);
		harness = await invocationHarness("dispose-publication", cwd, {
			isIdle: () => !session?.isStreaming,
			sendUserMessage: (content, options) => {
				submission = send(content, options);
				void submission.catch(() => undefined);
				return submission;
			},
		});
		session.subscribe(event => harness?.emit(event.type, event));
		expect((await harness.control("turn.prompt", { text: "dispose this accepted prompt" })).ok).toBe(true);
		await entered.promise;
		const disposal = session.dispose();
		release.resolve();
		if (!submission) throw new Error("Expected the actual accepted submission promise.");
		await expect(submission).rejects.toMatchObject({ code: "cancelled" });
		await disposal;
	} finally {
		release.resolve();
		await session?.dispose();
		authStorage?.close();
		await harness?.stop();
		await rm(cwd, { recursive: true, force: true });
	}
});

test.each([
	false,
	true,
])("SDK terminal publication rejection is observed independently of its cohort waiter (queued=%s)", async queued => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-publication-rejection-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const rejected = Promise.withResolvers<void>();
	const failure = new Error("Injected terminal extension delivery failure.");
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let harness: InvocationHarness | undefined;
	let rootSubmission: Promise<void> | undefined;
	let providerCalls = 0;
	let targetToken: string | undefined;
	let injected = false;
	const projectedTerminals: Array<{ calls: number; token: string | undefined }> = [];
	let restoreFault: (() => void) | undefined;
	process.on("unhandledRejection", onUnhandled);
	try {
		const real = await createTerminalizationSession(
			cwd,
			(model, context, options) => {
				providerCalls++;
				return createMockModel({
					responses: [
						async () => {
							if (providerCalls === 1) {
								entered.resolve();
								await release.promise;
							}
							return { content: ["completed"] };
						},
					],
				}).stream(model, context, options);
			},
			{},
			true,
		);
		session = real.session;
		authStorage = real.authStorage;
		const runner = session.extensionRunner;
		if (!runner) throw new Error("Expected the actual extension runner.");
		const emit = runner.emit.bind(runner);
		const fault = spyOn(runner, "emit").mockImplementation(async (event, ...args) => {
			if (event.type === "agent_end") projectedTerminals.push({ calls: providerCalls, token: event.sdkRunToken });
			if (!injected && event.type === "agent_end" && event.sdkRunToken === targetToken) {
				injected = true;
				rejected.resolve();
				throw failure;
			}
			return emit(event, ...args);
		});
		restoreFault = () => fault.mockRestore();
		const send = realSendUserMessage(session);
		harness = await invocationHarness("publication-rejection", cwd, {
			isIdle: () => !session?.isStreaming,
			sendUserMessage: (content, options) => {
				const submission = send(content, options);
				if (!rootSubmission) rootSubmission = submission;
				void submission.catch(() => undefined);
				return submission;
			},
		});
		session.subscribe(event => harness?.emit(event.type, event));
		const active = await harness.control("turn.prompt", { text: "active prompt" });
		expect(active.ok).toBe(true);
		await entered.promise;
		const target = queued ? await harness.control("turn.follow_up", { text: "queued prompt" }) : active;
		expect(target.ok).toBe(true);
		targetToken = `${target.result?.commandId}:${target.result?.turnId}`;
		release.resolve();
		await rejected.promise;
		if (!rootSubmission) throw new Error("Expected the actual root submission promise.");
		if (queued) await rootSubmission;
		else await expect(rootSubmission).rejects.toBe(failure);
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(injected).toBe(true);
		expect(providerCalls).toBe(queued ? 2 : 1);
		expect(projectedTerminals).toHaveLength(queued ? 2 : 1);
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		restoreFault?.();
		release.resolve();
		await session?.dispose().catch(error => {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([failure]);
		});
		authStorage?.close();
		await harness?.stop();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("SDK turn.steer preserves its expected run token and propagates a stale-run rejection", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-turn-steer-run-token-"));
	const staleToken = "ended-command:ended-turn";
	const clientRef = "stale-steer-ref";
	const calls: Array<{ content: unknown; deliverAs?: string; expectedSdkRunToken?: string }> = [];
	let harness: InvocationHarness | undefined;
	try {
		harness = await invocationHarness("steer-run-token", cwd, {
			sendUserMessage: async (content, options) => {
				calls.push({
					content,
					deliverAs: options?.deliverAs,
					expectedSdkRunToken: options?.expectedSdkRunToken,
				});
				if (options?.expectedSdkRunToken === staleToken)
					throw Object.assign(new Error("The expected SDK run is not active."), { code: "turn_not_active" });
				return "completed";
			},
		});

		const rejected = await harness.control("turn.steer", {
			text: "stale steer",
			expectedSdkRunToken: staleToken,
			clientRef,
		});
		expect(rejected).toMatchObject({ ok: false, error: { code: "turn_not_active" } });
		expect(calls).toEqual([{ content: "stale steer", deliverAs: "steer", expectedSdkRunToken: staleToken }]);
		expect(await harness.query("turn.steer_status", { clientRef })).toMatchObject({
			ok: true,
			result: { status: "rejected" },
		});
	} finally {
		if (harness) await harness.stop();
		await rm(cwd, { recursive: true, force: true });
	}
});

describe("post-acceptance invocation terminalization", () => {
	test.each([
		false,
		true,
	])("a returning SDK bridge waits for its real overflow continuation terminal (managed=%s)", async managed => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-overflow-returning-bridge-"));
		let harness: InvocationHarness | undefined;
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		let submission: Promise<void> | undefined;
		let submissionSettled = false;
		let providerCalls = 0;
		const recoveryEntered = Promise.withResolvers<void>();
		const releaseRecovery = Promise.withResolvers<void>();
		try {
			const real = await createTerminalizationSession(cwd, (model, context, options) => {
				providerCalls++;
				if (providerCalls === 1) return typedContextOverflowStream(model);
				return createMockModel({
					responses: [
						async () => {
							recoveryEntered.resolve();
							await releaseRecovery.promise;
							return { content: ["FINAL_OVERFLOW_RECOVERY"] };
						},
					],
				}).stream(model, context, options);
			});
			session = real.session;
			authStorage = real.authStorage;
			if (!managed) session.setConfiguredModelChain("default", [selector(real.model)], "returning-overflow-test");
			const send = realSendUserMessage(session);
			harness = await invocationHarness("overflow-returning-bridge", cwd, {
				isIdle: () => !session?.isStreaming,
				sendUserMessage: (content, options) => {
					submission = send(content, options);
					void submission.then(
						() => {
							submissionSettled = true;
						},
						() => {
							submissionSettled = true;
						},
					);
					return submission;
				},
			});
			session.subscribe(event => harness?.emit(event.type, event));
			const accepted = await harness.control("turn.prompt", { text: "finish after the context overflow" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			expect(correlation.commandId).toBeDefined();
			expect(correlation.turnId).toBeDefined();
			await recoveryEntered.promise;
			expect(submissionSettled).toBe(false);
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_end")).toHaveLength(0);
			expect((await harness.query("turn.result", { kind: "prompt", ...correlation })).result).toMatchObject({
				status: expect.stringMatching(/^(accepted|in_flight)$/),
			});
			releaseRecovery.resolve();
			const terminal = await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation });
			expect(terminal).toMatchObject({
				...correlation,
				status: "terminal_ok",
				content: { text: "FINAL_OVERFLOW_RECOVERY" },
				outcome: { kind: "stopped", reason: "end_turn" },
			});
			expect(terminal.error).toBeUndefined();
			if (!submission) throw new Error("Expected the actual accepted overflow submission promise.");
			await submission;
			expect(submissionSettled).toBe(true);
			await session.waitForIdle();
			const ends = harness.broadcasts.filter(frame => frame.kind === "agent_end");
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({
				payload: { ...correlation, outcome: { kind: "stopped", reason: "end_turn" } },
			});
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_start")).toHaveLength(managed ? 1 : 2);
			expect(providerCalls).toBe(2);
		} finally {
			releaseRecovery.resolve();
			await session?.dispose();
			authStorage?.close();
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("preserves prompt correlation across a real overflow retry", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-overflow-retry-correlation-"));
		let harness: InvocationHarness | undefined;
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		let providerCalls = 0;
		try {
			const real = await createTerminalizationSession(cwd, async (model, context, options) => {
				providerCalls++;
				if (providerCalls === 1) return typedContextOverflowStream(model);
				return createMockModel({ responses: [{ content: ["recovered"] }] }).stream(model, context, options);
			});
			session = real.session;
			authStorage = real.authStorage;

			harness = await invocationHarness("overflow-retry-correlation", cwd, {
				isIdle: () => !session?.isStreaming,
				sendUserMessage: deferredRealSendUserMessage(session),
			});
			session.subscribe(async event => {
				await harness?.emit(event.type, event);
			});
			const accepted = await harness.control("turn.prompt", { text: "finish the outstanding work" });
			expect(accepted.ok).toBe(true);
			const correlation = {
				commandId: accepted.result?.commandId,
				turnId: accepted.result?.turnId,
			};

			const terminal = await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation });
			expect(terminal).toMatchObject({
				status: "terminal_ok",
				commandId: correlation.commandId,
				turnId: correlation.turnId,
			});
			const ends = harness.broadcasts.filter(frame => frame.kind === "agent_end");
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({
				payload: {
					commandId: correlation.commandId,
					turnId: correlation.turnId,
				},
			});
			expect(providerCalls).toBe(2);
		} finally {
			await session?.dispose();
			authStorage?.close();
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("preserves prompt correlation across a todo-reminder continuation", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-todo-reminder-continuation-"));
		let harness: InvocationHarness | undefined;
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		let providerCalls = 0;
		const secondEntered = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		try {
			const real = await createTerminalizationSession(
				cwd,
				async (model, context, options) => {
					providerCalls++;
					return createMockModel({
						responses: [
							providerCalls === 2
								? async () => {
										secondEntered.resolve();
										await releaseSecond.promise;
										return { content: ["FINAL"] };
									}
								: { content: ["FIRST"] },
						],
					}).stream(model, context, options);
				},
				{ "todo.enabled": true, "todo.reminders": true, "todo.reminders.max": 1 },
			);
			session = real.session;
			authStorage = real.authStorage;

			session.setTodoPhases([
				{ name: "Work", tasks: [{ content: "finish the outstanding work", status: "pending" }] },
			]);
			harness = await invocationHarness("todo-reminder-continuation", cwd, {
				isIdle: () => !session?.isStreaming,
				sendUserMessage: realSendUserMessage(session),
			});
			session.subscribe(async event => {
				await harness?.emit(event.type, event);
			});
			const accepted = await harness.control("turn.prompt", { text: "finish the outstanding work" });
			expect(accepted.ok).toBe(true);
			const correlation = {
				commandId: accepted.result?.commandId,
				turnId: accepted.result?.turnId,
			};
			expect(correlation.commandId).toBeDefined();
			expect(correlation.turnId).toBeDefined();
			await secondEntered.promise;
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_end")).toHaveLength(0);
			expect((await harness.query("turn.result", { kind: "prompt", ...correlation })).result).toMatchObject({
				status: expect.stringMatching(/^(accepted|in_flight)$/),
			});
			releaseSecond.resolve();
			const terminal = await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation });
			expect(terminal).toMatchObject({
				status: "terminal_ok",
				commandId: correlation.commandId,
				turnId: correlation.turnId,
				content: { text: "FINAL" },
			});
			expect(terminal.error).toBeUndefined();
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_start")).toHaveLength(2);
			const ends = harness.broadcasts.filter(frame => frame.kind === "agent_end");
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({
				payload: {
					commandId: correlation.commandId,
					turnId: correlation.turnId,
				},
			});
			expect(providerCalls).toBe(2);
		} finally {
			releaseSecond.resolve();
			await session?.dispose();
			authStorage?.close();
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("terminalizes cancellation during a todo-reminder continuation", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-todo-reminder-cancel-"));
		let harness: InvocationHarness | undefined;
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		let providerCalls = 0;
		let secondSignal: AbortSignal | undefined;
		const secondEntered = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		try {
			const real = await createTerminalizationSession(
				cwd,
				async (model, context, options) => {
					providerCalls++;
					if (providerCalls === 2) {
						secondSignal = options?.signal;
						secondEntered.resolve();
					}
					const response =
						providerCalls === 2
							? async () => {
									await releaseSecond.promise;
									return { content: ["completed"] };
								}
							: { content: ["started"] };
					return createMockModel({ responses: [response] }).stream(model, context, options);
				},
				{ "todo.enabled": true, "todo.reminders": true, "todo.reminders.max": 1 },
			);
			session = real.session;
			authStorage = real.authStorage;
			session.setTodoPhases([
				{ name: "Work", tasks: [{ content: "finish the outstanding work", status: "pending" }] },
			]);
			harness = await invocationHarness("todo-reminder-cancel", cwd, {
				isIdle: () => !session?.isStreaming,
				sendUserMessage: realSendUserMessage(session),
			});
			session.subscribe(async event => {
				await harness?.emit(event.type, event);
			});
			const accepted = await harness.control("turn.prompt", { text: "finish the outstanding work" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			expect(correlation.commandId).toBeDefined();
			expect(correlation.turnId).toBeDefined();
			await secondEntered.promise;
			expect(secondSignal?.aborted).toBe(false);
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_end")).toHaveLength(0);
			await session.abort();
			expect(secondSignal?.aborted).toBe(true);
			releaseSecond.resolve();
			await session.waitForIdle();
			const terminal = await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation });
			expect(terminal).toMatchObject(correlation);
			const ends = harness.broadcasts.filter(frame => frame.kind === "agent_end");
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({ payload: correlation });
			expect(providerCalls).toBe(2);
		} finally {
			releaseSecond.resolve();
			await session?.dispose();
			authStorage?.close();
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("terminalizes a synchronous throw during a todo-reminder continuation", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-todo-reminder-throw-"));
		let harness: InvocationHarness | undefined;
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		let providerCalls = 0;
		try {
			const real = await createTerminalizationSession(
				cwd,
				(model, context, options) => {
					providerCalls++;
					if (providerCalls === 2) throw new Error("todo continuation stream failed synchronously");
					return createMockModel({ responses: [{ content: ["started"] }] }).stream(model, context, options);
				},
				{ "todo.enabled": true, "todo.reminders": true, "todo.reminders.max": 1, "retry.enabled": false },
			);
			session = real.session;
			session.setConfiguredModelChain("default", [selector(real.model)], "terminal-throw-test");
			authStorage = real.authStorage;
			session.setTodoPhases([
				{ name: "Work", tasks: [{ content: "finish the outstanding work", status: "pending" }] },
			]);
			harness = await invocationHarness("todo-reminder-throw", cwd, {
				isIdle: () => !session?.isStreaming,
				sendUserMessage: realSendUserMessage(session),
			});
			session.subscribe(async event => {
				await harness?.emit(event.type, event);
			});
			const accepted = await harness.control("turn.prompt", { text: "finish the outstanding work" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			expect(correlation.commandId).toBeDefined();
			expect(correlation.turnId).toBeDefined();
			const terminal = await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation });
			expect(terminal).toMatchObject({
				...correlation,
				status: "failed",
				outcome: { kind: "failed" },
				error: { code: "provider_rejected" },
			});
			// Wait for session to settle and ensure no further continuations are queued
			await session?.waitForIdle();
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_start")).toHaveLength(2);
			const ends = harness.broadcasts.filter(frame => {
				const payload = frame.payload as { commandId?: string; turnId?: string } | undefined;
				return (
					frame.kind === "agent_end" &&
					payload?.commandId === correlation.commandId &&
					payload?.turnId === correlation.turnId
				);
			});
			expect(ends.map(frame => frame.payload)).toEqual([
				expect.objectContaining({
					...correlation,
					outcome: expect.objectContaining({ kind: "failed" }),
				}),
			]);
			expect(providerCalls).toBe(2);
			await session.waitForIdle();
			expect((await harness.query("turn.result", { kind: "prompt", ...correlation })).result).toMatchObject({
				...correlation,
				status: "failed",
				outcome: { kind: "failed" },
			});
		} finally {
			await session?.dispose();
			authStorage?.close();
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("terminalizes a second overflow during overflow maintenance", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-overflow-maintenance-failure-"));
		let harness: InvocationHarness | undefined;
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const real = await createTerminalizationSession(cwd, model => {
				return typedContextOverflowStream(model);
			});
			session = real.session;
			authStorage = real.authStorage;
			harness = await invocationHarness("overflow-maintenance-failure", cwd, {
				isIdle: () => !session?.isStreaming,
				sendUserMessage: deferredRealSendUserMessage(session),
			});
			session.subscribe(async event => {
				await harness?.emit(event.type, event);
			});
			const accepted = await harness.control("turn.prompt", { text: "retry the outstanding work" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			const terminal = await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation });
			expect(terminal).toMatchObject({
				status: "failed",
				commandId: correlation.commandId,
				turnId: correlation.turnId,
			});
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_end")).toHaveLength(1);
		} finally {
			await session?.dispose();
			authStorage?.close();
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("terminalizes cancellation during a scheduled overflow retry", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-overflow-retry-cancel-"));
		let harness: InvocationHarness | undefined;
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		let providerCalls = 0;
		const overflowEmitted = Promise.withResolvers<void>();
		try {
			const real = await createTerminalizationSession(
				cwd,
				model => {
					providerCalls++;
					return typedContextOverflowStream(
						model,
						providerCalls === 1 ? () => overflowEmitted.resolve() : undefined,
					);
				},
				{ "retry.baseDelayMs": 1_000 },
			);
			session = real.session;
			authStorage = real.authStorage;
			session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
			harness = await invocationHarness("overflow-retry-cancel", cwd, {
				isIdle: () => !session?.isStreaming,
				sendUserMessage: deferredRealSendUserMessage(session),
			});
			session.subscribe(async event => {
				await harness?.emit(event.type, event);
			});
			const accepted = await harness.control("turn.prompt", { text: "cancel the retry" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await overflowEmitted.promise;
			await harness.control("turn.cancel", correlation);
			const terminal = await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation });
			expect(terminal.status).toBe("failed");
			expect(terminal).toMatchObject(correlation);
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_end")).toHaveLength(1);
			await session.waitForIdle();
			expect(
				harness.broadcasts.filter(
					frame =>
						frame.kind === "agent_end" &&
						(frame.payload as { commandId?: string }).commandId === correlation.commandId,
				),
			).toHaveLength(1);
		} finally {
			await session?.dispose();
			authStorage?.close();
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("terminalizes a synchronous throw from the overflow retry stream", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-overflow-retry-throw-"));
		let harness: InvocationHarness | undefined;
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		let providerCalls = 0;
		try {
			const real = await createTerminalizationSession(cwd, async model => {
				providerCalls++;
				if (providerCalls === 2) throw new Error("retry stream failed synchronously");
				return typedContextOverflowStream(model);
			});
			session = real.session;
			authStorage = real.authStorage;
			harness = await invocationHarness("overflow-retry-throw", cwd, {
				isIdle: () => !session?.isStreaming,
				sendUserMessage: deferredRealSendUserMessage(session),
			});
			session.subscribe(async event => {
				await harness?.emit(event.type, event);
			});
			const accepted = await harness.control("turn.prompt", { text: "retry with a throwing provider" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			const terminal = await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation });
			expect(terminal).toMatchObject({
				status: "failed",
				commandId: correlation.commandId,
				turnId: correlation.turnId,
			});
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_end")).toHaveLength(1);
		} finally {
			await session?.dispose();
			authStorage?.close();
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("preserves external prompt correlation across a retryable provider error", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-retryable-provider-correlation-"));
		let harness: InvocationHarness | undefined;
		try {
			harness = await invocationHarness("retryable-provider-correlation", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const accepted = await harness.control("turn.prompt", {
				text: "recover after a provider overload",
				clientRef: "retryable-provider-correlation",
			});
			expect(accepted.ok).toBe(true);
			const correlation = {
				commandId: accepted.result?.commandId,
				turnId: accepted.result?.turnId,
			};
			const retryScope = {};

			for (let attempt = 0; attempt < 3; attempt++) {
				await harness.emit("agent_start", { lifecycleScope: retryScope });
			}
			await harness.emit("agent_end", {
				messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] }],
			});

			const terminal = await settledStatus(harness, "turn.result", { kind: "prompt", ...correlation });
			expect(terminal).toMatchObject({
				status: "terminal_ok",
				commandId: correlation.commandId,
				turnId: correlation.turnId,
				outcome: { kind: "stopped", reason: "end_turn" },
			});
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_end").at(-1)).toMatchObject({
				payload: {
					commandId: correlation.commandId,
					turnId: correlation.turnId,
					outcome: { kind: "stopped", reason: "end_turn" },
				},
			});
		} finally {
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

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
				error: { code, message: "Provider failure after execution started." },
				outcome: {
					kind: "failed",
					code: "prompt_failed",
					message: "Provider failure after execution started.",
					provenance: "agent_failed",
					phase: "post_start",
					category: "provider_rejected",
					providerCode: code,
				},
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
				const lifecycleChange = harness[operation](`${operation}-stall-successor`);
				await lifecycleChange;
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

	test("tokenless retry boundaries release replacement terminal publication and replay", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "sdk-tokenless-retry-reopen-"));
		const sessionId = "tokenless-retry-reopen";
		const harness = await invocationHarness(sessionId, cwd, {});
		const scopes = createAttemptMinter();
		const activity = spyOn(SessionSdkSessionRuntime.prototype, "reportActivity");
		try {
			// Accepted ordinary retries suppress predecessor ends. Three attempts
			// therefore share one public lifecycle boundary, not three unmatched ends.
			const lifecycleScope = scopes.mint("main");
			for (let attempt = 0; attempt < 3; attempt++) {
				await harness.emit("agent_start", { lifecycleScope });
			}
			await harness.emit("agent_end");
			for (let turn = 0; turn < 2; turn++) {
				await harness.emit("agent_start", { lifecycleScope: scopes.mint("main") });
				await harness.emit("agent_end");
			}
			await harness.switchSession("different-session");
			await harness.switchSession(sessionId);
			const priorEnds = harness.broadcasts.filter(frame => frame.kind === "agent_end").length;
			await harness.emit("agent_start", { lifecycleScope: scopes.mint("main") });
			await harness.emit("agent_end");
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_end")).toHaveLength(priorEnds + 1);
			expect(activity.mock.calls.at(-1)?.[0]).toBe("idle");
			expect(await harness.requestOnSession(sessionId, { type: "event_replay", sinceSeq: 0 })).toMatchObject({
				type: "event_replay_result",
				events: expect.arrayContaining([expect.objectContaining({ kind: "agent_end" })]),
			});
		} finally {
			activity.mockRestore();
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("tokenless retry preserves attached owners alongside newly promoted SDK work", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "sdk-tokenless-retry-owners-"));
		const promotions: Array<(promotion: { startsOwnRun: boolean }) => void> = [];
		const harness = await invocationHarness("tokenless-retry-owners", cwd, {
			sendUserMessage: async (_content, options) => {
				await options?.onPreflightAcceptCommit?.();
				if (options?.onQueuedPromoted) promotions.push(options.onQueuedPromoted);
				options?.onPreflightAccepted?.();
			},
		});
		try {
			const lifecycleScope = createAttemptMinter().mint("main");
			await harness.emit("agent_start", { lifecycleScope });
			const attached = await harness.control("turn.follow_up", { text: "attached work" });
			const queued = await harness.control("turn.follow_up", { text: "promoted work" });
			expect(attached.ok).toBe(true);
			expect(queued.ok).toBe(true);
			expect(promotions).toHaveLength(2);
			promotions[0]!({ startsOwnRun: false });
			promotions[1]!({ startsOwnRun: true });
			await harness.emit("agent_start", { lifecycleScope });
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "shared retry final" }] });
			for (const accepted of [attached, queued]) {
				expect(
					await harness.query("turn.result", {
						kind: "prompt",
						commandId: accepted.result?.commandId,
						turnId: accepted.result?.turnId,
					}),
				).toMatchObject({
					result: {
						status: "terminal_ok",
						receiptState: "present",
						content: { text: "shared retry final" },
					},
				});
			}
		} finally {
			await harness.stop();
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
				error: { code: "upstream_stream_interrupted", message: "Provider failure after execution started." },
				outcome: {
					kind: "failed",
					code: "prompt_failed",
					message: "Provider failure after execution started.",
					provenance: "agent_failed",
					phase: "post_start",
					category: "provider_transport",
					providerCode: "upstream_stream_interrupted",
				},
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
	test("unowned predecessor end cannot publish a queued successor receipt", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "sdk-unowned-predecessor-"));
		const promotions: Array<(promotion: { startsOwnRun: boolean }) => void> = [];
		const harness = await invocationHarness("unowned-predecessor", cwd, {
			sendUserMessage: async (_content, options) => {
				await options?.onPreflightAcceptCommit?.();
				if (options?.onQueuedPromoted) promotions.push(options.onQueuedPromoted);
				options?.onPreflightAccepted?.();
			},
		});
		try {
			await harness.emit("agent_start");
			const accepted = await harness.control("turn.follow_up", { text: "queued verification" });
			expect(accepted.ok).toBe(true);
			expect(promotions).toHaveLength(1);
			promotions[0]!({ startsOwnRun: true });
			await harness.emit("agent_start");
			const selector = {
				kind: "prompt",
				commandId: accepted.result?.commandId,
				turnId: accepted.result?.turnId,
			};
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "predecessor final" }] });
			expect(await harness.query("turn.result", selector)).toMatchObject({
				result: { status: "in_flight", receiptState: "absent" },
			});
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "verification final" }] });
			expect(await harness.query("turn.result", selector)).toMatchObject({
				result: {
					status: "terminal_ok",
					turnId: accepted.result?.turnId,
					receiptState: "present",
					content: { text: "verification final" },
				},
			});
		} finally {
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("unowned run stays paired after predecessor SDK references retire", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "sdk-unowned-retirement-"));
		const promotions: Array<(promotion: { startsOwnRun: boolean }) => void> = [];
		const harness = await invocationHarness("unowned-retirement", cwd, {
			sendUserMessage: async (_content, options) => {
				await options?.onPreflightAcceptCommit?.();
				if (options?.onQueuedPromoted) promotions.push(options.onQueuedPromoted);
				options?.onPreflightAccepted?.();
			},
		});
		try {
			const first = await harness.control("turn.follow_up", { text: "first" });
			expect(promotions).toHaveLength(1);
			promotions[0]!({ startsOwnRun: true });
			await harness.emit("agent_start");
			await harness.emit("agent_start");
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "first final" }] });
			expect(
				await harness.query("turn.result", {
					kind: "prompt",
					commandId: first.result?.commandId,
					turnId: first.result?.turnId,
				}),
			).toMatchObject({ result: { status: "terminal_ok", content: { text: "first final" } } });
			const next = await harness.control("turn.follow_up", { text: "next" });
			expect(promotions).toHaveLength(2);
			promotions[1]!({ startsOwnRun: true });
			await harness.emit("agent_start");
			const selector = { kind: "prompt", commandId: next.result?.commandId, turnId: next.result?.turnId };
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "unowned final" }] });
			expect(await harness.query("turn.result", selector)).toMatchObject({
				result: { status: "in_flight", receiptState: "absent" },
			});
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "next final" }] });
			expect(await harness.query("turn.result", selector)).toMatchObject({
				result: { status: "terminal_ok", content: { text: "next final" } },
			});
		} finally {
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("unowned run retains attached invocation across predecessor completion", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "sdk-unowned-attached-"));
		const promotions: Array<(promotion: { startsOwnRun: boolean }) => void> = [];
		const harness = await invocationHarness("unowned-attached", cwd, {
			sendUserMessage: async (_content, options) => {
				await options?.onPreflightAcceptCommit?.();
				if (options?.onQueuedPromoted) promotions.push(options.onQueuedPromoted);
				options?.onPreflightAccepted?.();
			},
		});
		try {
			await harness.control("turn.follow_up", { text: "predecessor" });
			expect(promotions).toHaveLength(1);
			promotions[0]!({ startsOwnRun: true });
			await harness.emit("agent_start");
			await harness.emit("agent_start");
			const attached = await harness.control("turn.follow_up", { text: "attach to current unowned run" });
			expect(attached.ok).toBe(true);
			expect(promotions).toHaveLength(2);
			promotions[1]!({ startsOwnRun: false });
			const selector = {
				kind: "prompt",
				commandId: attached.result?.commandId,
				turnId: attached.result?.turnId,
			};
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "predecessor final" }] });
			expect(await harness.query("turn.result", selector)).toMatchObject({
				result: { status: expect.stringMatching(/accepted|in_flight/), receiptState: "absent" },
			});
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "attached final" }] });
			expect(await harness.query("turn.result", selector)).toMatchObject({
				result: { status: "terminal_ok", content: { text: "attached final" } },
			});
		} finally {
			await harness.stop();
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
						key === "sdk.promptDeadlineMs" ? 2_000 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
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
				await Bun.sleep(800);
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
			{ name: "blank", agent: " ", expected: undefined, bytes: 0, truncated: false, status: "failed" },
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
					expect(result).toMatchObject({ status: testCase.status });
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
	test("fails closed when an assistant turn has only empty reasoning and zero token usage", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminal-zero-token-empty-"));
		try {
			const harness = await invocationHarness("terminal-zero-token-empty", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await Promise.withResolvers<void>().promise;
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			await harness.emit("agent_start");
			await harness.emit("agent_end", {
				messages: [
					{
						role: "assistant",
						content: [{ type: "thinking", thinking: "" }],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
					},
				],
			});
			const result = await settledStatus(harness, "turn.result", {
				kind: "prompt",
				commandId: accepted.result?.commandId,
				turnId: accepted.result?.turnId,
			});
			expect(result).toMatchObject({
				status: "failed",
				error: { code: "prompt_failed", message: "Agent run failed after execution started." },
				outcome: {
					kind: "failed",
					code: "prompt_failed",
					message: "Agent run failed after execution started.",
					provenance: "agent_failed",
					phase: "post_start",
					category: "agent_runtime",
				},
			});
			const successor = await harness.control("turn.prompt", { text: "successor" });
			expect(successor).toMatchObject({ ok: true, result: { accepted: true } });
			await harness.emit("agent_start");
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "completed" }] });
			expect(
				await settledStatus(harness, "turn.result", {
					kind: "prompt",
					commandId: successor.result?.commandId,
					turnId: successor.result?.turnId,
				}),
			).toMatchObject({ status: "terminal_ok" });
			await harness.stop();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("preserves valid textless terminal evidence", async () => {
		const cases = [
			{
				name: "reasoning-only",
				content: [{ type: "thinking", thinking: "private reasoning" }],
				usage: { totalTokens: 0 },
			},
			{
				name: "redacted-reasoning-only",
				content: [{ type: "redactedThinking", data: "encrypted reasoning" }],
				usage: { totalTokens: 0 },
			},
			{
				name: "tool-only",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
				usage: { totalTokens: 0 },
			},
			{
				name: "positive-token-usage",
				content: [{ type: "thinking", thinking: "" }],
				usage: { totalTokens: 1 },
			},
		] as const;
		for (const testCase of cases) {
			const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-terminal-valid-${testCase.name}-`));
			try {
				const harness = await invocationHarness(`terminal-valid-${testCase.name}`, cwd, {
					sendUserMessage: async (_content, options) => {
						await options?.onPreflightAcceptCommit?.();
						await Promise.withResolvers<void>().promise;
					},
				});
				const accepted = await harness.control("turn.prompt", { text: "hello" });
				await harness.emit("agent_start");
				await harness.emit("agent_end", {
					messages: [
						{
							role: "assistant",
							content: testCase.content,
							...(testCase.usage === undefined ? {} : { usage: testCase.usage }),
						},
					],
				});
				expect(
					await settledStatus(harness, "turn.result", {
						kind: "prompt",
						commandId: accepted.result?.commandId,
						turnId: accepted.result?.turnId,
					}),
				).toMatchObject({ status: "terminal_ok" });
				await harness.stop();
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		}
	});
	test("preserves earlier complete tool activity before a trailing empty assistant", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminal-earlier-tool-activity-"));
		try {
			const harness = await invocationHarness("terminal-earlier-tool-activity", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await Promise.withResolvers<void>().promise;
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			await harness.emit("agent_start");
			await harness.emit("agent_end", {
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.txt" } }],
						usage: { totalTokens: 1 },
					},
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "text", text: "contents" }],
					},
					{
						role: "assistant",
						content: [{ type: "thinking", thinking: "" }],
						usage: { totalTokens: 0 },
					},
				],
			});
			expect(
				await settledStatus(harness, "turn.result", {
					kind: "prompt",
					commandId: accepted.result?.commandId,
					turnId: accepted.result?.turnId,
				}),
			).toMatchObject({ status: "terminal_ok" });
			await harness.stop();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test.each([
		{ name: "usage-omitted", content: [{ type: "thinking", thinking: "" }], omitUsage: true },
		{ name: "usage-null", content: [{ type: "thinking", thinking: "" }], usage: null },
		{ name: "primitive-usage", content: [{ type: "thinking", thinking: "" }], usage: "bad" },
		{ name: "array-usage", content: [{ type: "thinking", thinking: "" }], usage: [] },
		{ name: "missing-total-tokens", content: [{ type: "thinking", thinking: "" }], usage: { input: 0 } },
		{
			name: "undefined-total-tokens",
			content: [{ type: "thinking", thinking: "" }],
			usage: { totalTokens: undefined },
		},
		{ name: "negative-total-tokens", content: [{ type: "thinking", thinking: "" }], usage: { totalTokens: -1 } },
		{
			name: "nan-total-tokens",
			content: [{ type: "thinking", thinking: "" }],
			usage: { totalTokens: Number.NaN },
		},
		{
			name: "infinite-total-tokens",
			content: [{ type: "thinking", thinking: "" }],
			usage: { totalTokens: Number.POSITIVE_INFINITY },
		},
		{
			name: "incomplete-tool-call",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: {},
					incompleteArguments: true,
					incompleteArgumentsReason: "truncated",
				},
			],
			usage: { totalTokens: 0 },
		},
		{
			name: "malformed-tool-arguments",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: null }],
			usage: { totalTokens: 0 },
		},
		{
			name: "orphaned-incomplete-reason",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: {},
					incompleteArgumentsReason: "malformed",
				},
			],
			usage: { totalTokens: 0 },
		},
	] as const)("fails closed without independent terminal evidence ($name)", async testCase => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), `gjc-terminal-malformed-${testCase.name}-`));
		try {
			const harness = await invocationHarness(`terminal-malformed-${testCase.name}`, cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await Promise.withResolvers<void>().promise;
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			await harness.emit("agent_start");
			await harness.emit("agent_end", {
				messages: [
					{
						role: "assistant",
						content: testCase.content,
						...("omitUsage" in testCase ? {} : { usage: testCase.usage }),
					},
				],
			});
			expect(
				await settledStatus(harness, "turn.result", {
					kind: "prompt",
					commandId: accepted.result?.commandId,
					turnId: accepted.result?.turnId,
				}),
			).toMatchObject({
				status: "failed",
				error: { code: "prompt_failed", message: "Agent run failed after execution started." },
				outcome: {
					kind: "failed",
					code: "prompt_failed",
					message: "Agent run failed after execution started.",
					provenance: "agent_failed",
					phase: "post_start",
					category: "agent_runtime",
				},
			});
			await harness.stop();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 60_000);
	test("preserves explicit cancellation for an empty zero-token turn", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminal-empty-cancelled-"));
		try {
			const harness = await invocationHarness("terminal-empty-cancelled", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await Promise.withResolvers<void>().promise;
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "hello" });
			await harness.emit("agent_start");
			await harness.emit("agent_end", {
				stopReason: "cancelled",
				messages: [
					{
						role: "assistant",
						content: [{ type: "thinking", thinking: "" }],
						usage: { totalTokens: 0 },
					},
				],
			});
			expect(
				await settledStatus(harness, "turn.result", {
					kind: "prompt",
					commandId: accepted.result?.commandId,
					turnId: accepted.result?.turnId,
				}),
			).toMatchObject({
				status: "terminal_ok",
				outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
			});
			await harness.stop();
		} finally {
			await rm(cwd, { recursive: true, force: true });
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
	test.each([
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
	] as const)("reconciles contract-valid skill completion and agent_end ordering ($name)", async testCase => {
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
	}, 30_000);
	test("a queued follow-up prompt is not terminalized before the turn runs", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-terminalize-followup-"));
		try {
			const turnRunning = Promise.withResolvers<void>();
			const harness = await invocationHarness("terminalize-followup", cwd, {
				sendUserMessage: async (_content, options) => {
					if (options?.deliverAs === "followUp") {
						await options?.onPreflightAcceptCommit?.();
						options.preflightSignal?.addEventListener(
							"abort",
							() => options.onQueuedPromoted?.({ startsOwnRun: false, removed: true }),
							{ once: true },
						);
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
	test("a promoted follow-up without agent_start remains nonterminal", async () => {
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
			const correlated = () =>
				harness.broadcasts.filter(frame => {
					const payload = frame.payload as { commandId?: string; turnId?: string } | undefined;
					return payload?.commandId === ids.commandId && payload?.turnId === ids.turnId;
				});
			await Bun.sleep(100);
			expect((await harness.query("turn.prompt_status", ids)).result?.status).toBe("accepted");
			promoted?.({ startsOwnRun: true });
			await Bun.sleep(100);
			expect((await harness.query("turn.prompt_status", ids)).result?.status).toMatch(/accepted|in_flight/);
			expect(correlated().filter(frame => frame.kind === "agent_failed")).toEqual([]);
			expect(correlated().filter(frame => frame.kind === "agent_end")).toEqual([]);
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
					options?.preflightSignal?.addEventListener(
						"abort",
						() => options.onQueuedPromoted?.({ startsOwnRun: false, removed: true }),
						{ once: true },
					);
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
		let queuedPromotion: PreflightHooks["onQueuedPromoted"];
		try {
			const harness = await invocationHarness("terminalize-race", cwd, {
				sendUserMessage: async (_content, options) => {
					// The session is streaming when the submission starts (divert to steer).
					// During accept()->persist(), the prior turn unwinds and isIdle flips to true.
					await options?.onPreflightAcceptCommit?.();
					options?.preflightSignal?.addEventListener(
						"abort",
						() => options.onQueuedPromoted?.({ startsOwnRun: false, removed: true }),
						{ once: true },
					);
					queuedPromotion = options?.onQueuedPromoted;
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
			queuedPromotion?.({ startsOwnRun: false, removed: true });
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

	test("a later provider error never changes or re-opens an already terminal prompt", async () => {
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
			// A rejected submission after terminal publication is only a cleanup diagnostic.
			expect(settled.result).toEqual(claimed);
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

	test("an accepted prompt that never reaches agent_start remains recoverable", async () => {
		// Acceptance does not prove that queued/preflight work can no longer run.
		// Keep its status nonterminal until the exact submission is fenced or starts.
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
			await Bun.sleep(80);
			expect(await harness.query("turn.prompt_status", { commandId, turnId })).toMatchObject({
				result: { status: "accepted" },
			});
			expect(
				correlatedFrames(harness, { commandId, turnId }).filter(frame => frame.kind === "agent_failed"),
			).toEqual([]);
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a running prompt deadline stops its exact turn and keeps normal terminals working", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-terminal-frame-"));
		const epoch = 19;
		const abortCalls: Array<{ handle: string; scope?: string; expectedEpoch?: number }> = [];
		let harness: InvocationHarness | undefined;
		try {
			harness = await invocationHarness("deadline-terminal-frame", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 100 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => "deadline-terminal-run",
					pendingToolExecutions: () => [],
					abortPromptAndWaitWithTerminal: async (handle, options) => {
						abortCalls.push({
							handle,
							scope: options.terminal?.scope,
							expectedEpoch: options.terminal?.expectedEpoch,
						});
						await harness?.emit("agent_end", { stopReason: "cancelled" });
						return {
							status: "settled",
							terminalScope: { abortedAttemptEpoch: epoch, lineageIdHash: "deadline-terminal-frame-lineage" },
						};
					},
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "deadline" });
			expect(accepted.ok).toBe(true);
			const correlation = {
				commandId: accepted.result?.commandId,
				turnId: accepted.result?.turnId,
			};
			await harness.emit("agent_start");

			// An abort can synthesize pairing-only tool boundaries for a call that
			// never ran. Those are cleanup, not fresh progress that may renew the
			// deadline currently terminating this prompt.
			const syntheticStart = {
				type: "tool_execution_start",
				toolCallId: "deadline-cleanup",
				toolName: "read",
				args: {},
			};
			const syntheticEnd = {
				type: "tool_execution_end",
				toolCallId: "deadline-cleanup",
				toolName: "read",
				result: { content: "aborted" },
				isError: true,
			};
			markNonDispatchedToolEvent(syntheticStart);
			markNonDispatchedToolEvent(syntheticEnd);
			await harness.emit("tool_execution_start", syntheticStart);
			await harness.emit("tool_execution_end", syntheticEnd);

			const settled = await settledStatus(harness, "turn.prompt_status", correlation);
			expect(settled).toMatchObject({
				status: "failed",
				outcome: {
					kind: "failed",
					code: "prompt_deadline_exceeded",
					provenance: "deadline",
					phase: "post_start",
				},
				error: { code: "prompt_deadline_exceeded" },
			});
			expect(abortCalls).toEqual([{ handle: "deadline-terminal-run", scope: "owned", expectedEpoch: epoch }]);
			const correlated = () =>
				harness!.broadcasts.filter(frame => {
					const payload = frame.payload as { commandId?: string; turnId?: string } | undefined;
					return payload?.commandId === correlation.commandId && payload?.turnId === correlation.turnId;
				});
			// The deadline remains a failure after the exact run is stopped; it must not
			// turn its own cancellation into a successful prompt result.
			const framesDeadline = Date.now() + 10_000;
			while (Date.now() < framesDeadline && !correlated().some(frame => frame.kind === "agent_end"))
				await Bun.sleep(5);
			expect(correlated().filter(frame => frame.kind === "agent_end")).toEqual([
				expect.objectContaining({
					payload: expect.objectContaining({
						outcome: expect.objectContaining({
							kind: "failed",
							code: "prompt_deadline_exceeded",
							provenance: "deadline",
						}),
					}),
				}),
			]);
			expect(correlated().filter(frame => frame.kind === "agent_failed")).toEqual([]);

			// A late real boundary is idempotent for the retired correlation.
			await harness.emit("agent_end", { messages: [] });
			expect(correlated().filter(frame => frame.kind === "agent_failed")).toHaveLength(0);
			expect(correlated().filter(frame => frame.kind === "agent_end")).toHaveLength(1);
			expect(await harness.query("turn.prompt_status", correlation)).toMatchObject({ result: settled });

			// Control: the ordinary agent-produced terminal path remains live.
			const control = await harness.control("turn.prompt", { text: "normal terminal" });
			const controlCorrelation = {
				commandId: control.result?.commandId,
				turnId: control.result?.turnId,
			};
			await harness.emit("agent_start");
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "done" }] });
			expect(await settledStatus(harness, "turn.prompt_status", controlCorrelation)).toMatchObject({
				status: "terminal_ok",
			});
			const controlTerminals = harness.broadcasts.filter(frame => {
				const payload = frame.payload as { commandId?: string; turnId?: string } | undefined;
				return (
					frame.kind === "agent_end" &&
					payload?.commandId === controlCorrelation.commandId &&
					payload?.turnId === controlCorrelation.turnId
				);
			});
			expect(controlTerminals).toHaveLength(1);
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	/** Frames broadcast for one correlation, in publication order. */
	const correlatedFrames = (harness: InvocationHarness, correlation: { commandId?: string; turnId?: string }) =>
		harness.broadcasts.filter(frame => {
			const payload = frame.payload as { commandId?: string; turnId?: string } | undefined;
			return payload?.commandId === correlation.commandId && payload?.turnId === correlation.turnId;
		});

	test("prompt agent_end waits for durable reconciliation before publication", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-prompt-terminal-durable-first-"));
		let terminalWriteAttempts = 0;
		let storageAvailable = false;
		let harness: InvocationHarness | undefined;
		try {
			harness = await invocationHarness("prompt-terminal-durable-first", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 60_000 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				persistInterceptor: transition => {
					if (transition.type !== "agent_end" || storageAvailable) return;
					terminalWriteAttempts += 1;
					throw Object.assign(new Error("injected terminal persistence failure"), { code: "io_error" });
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "durable before terminal" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "done" }] });
			expect(terminalWriteAttempts).toBeGreaterThan(0);
			expect((await harness.query("turn.prompt_status", correlation)).result).toMatchObject({ status: "in_flight" });
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toEqual([]);

			storageAvailable = true;
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "done" }] });
			expect(await settledStatus(harness, "turn.prompt_status", correlation)).toMatchObject({
				status: "terminal_ok",
				outcome: { kind: "stopped", reason: "end_turn" },
			});
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toHaveLength(1);
		} finally {
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a prompt deadline stays nonterminal when its dispatched tool cannot be fenced", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-deadline-tool-boundary-"));
		const activeTools = new Set(["sdk-only-mutating-tool"]);
		let boundaryWaitStarted = false;
		const epoch = 23;
		const abortCalls: Array<{ handle: string; scope?: string; expectedEpoch?: number }> = [];
		const pendingLedgerReads: string[] = [];
		let harness: InvocationHarness | undefined;
		try {
			harness = await invocationHarness("sdk-only-deadline-tool-boundary", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 250 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => "sdk-only-deadline-handle",
					pendingToolExecutions: handle => {
						pendingLedgerReads.push(handle);
						if (activeTools.size > 0) boundaryWaitStarted = true;
						return [...activeTools];
					},
					abortPromptAndWaitWithTerminal: async (handle, options) => {
						abortCalls.push({
							handle,
							scope: options.terminal?.scope,
							expectedEpoch: options.terminal?.expectedEpoch,
						});
						return { status: "unfenced" };
					},
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "sdk-only deadline" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "sdk-only-mutating-tool",
				toolName: "apply_patch",
				args: {},
			});
			const boundaryWaitDeadline = Date.now() + 2_000;
			while (!boundaryWaitStarted && Date.now() < boundaryWaitDeadline) await Bun.sleep(10);
			expect(boundaryWaitStarted).toBe(true);
			expect(abortCalls).toHaveLength(0);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toEqual([]);
			const abortDeadline = Date.now() + 10_000;
			while (abortCalls.length === 0 && Date.now() < abortDeadline) await Bun.sleep(10);
			expect(activeTools).toEqual(new Set(["sdk-only-mutating-tool"]));
			expect(pendingLedgerReads).toContain("sdk-only-deadline-handle");
			expect(abortCalls).toEqual([{ handle: "sdk-only-deadline-handle", scope: "owned", expectedEpoch: epoch }]);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toEqual([]);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toEqual([]);
			const status = await harness.query("turn.prompt_status", correlation);
			expect(status.result?.status).toMatch(/accepted|in_flight/);
		} finally {
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a captured cancelled end stays private and recoverable while tools are unproven", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-captured-uncertain-"));
		const sessionId = "deadline-captured-uncertain";
		const sessionFile = path.join(cwd, ".gjc", "state", `${sessionId}.jsonl`);
		await Bun.write(sessionFile, "");
		const store = createReconciliationStore({ sessionFile, sessionId });
		const activeTools = new Set(["unfenced-tool"]);
		let boundaryWaitStarted = false;
		let abortCalls = 0;
		let harness: InvocationHarness | undefined;
		try {
			harness = await invocationHarness(sessionId, cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 150 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				terminalAbortSeams: {
					getReconciliationStore: () => store,
					getTerminalTurnEpoch: () => 109,
					getActivePromptHandle: () => "deadline-captured-uncertain-run",
					pendingToolExecutions: () => {
						if (activeTools.size > 0) boundaryWaitStarted = true;
						return [...activeTools];
					},
					abortPromptAndWaitWithTerminal: async () => {
						abortCalls += 1;
						return { status: "unfenced" };
					},
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "capture uncertain end" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "unfenced-tool",
				toolName: "apply_patch",
				args: {},
			});
			const waitDeadline = Date.now() + 10_000;
			while (!boundaryWaitStarted && Date.now() < waitDeadline) await Bun.sleep(10);
			expect(boundaryWaitStarted).toBe(true);
			await harness.emit("agent_end", { stopReason: "cancelled" });
			const recoveryDeadline = Date.now() + 15_000;
			while (
				!store.snapshot().some(record => {
					if (record.commandId !== correlation.commandId) return false;
					const pending = record as SdkOnlyInvocationRecord & {
						pendingOutcome?: unknown;
						deadlineRecoveryPending?: boolean;
					};
					return pending.deadlineRecoveryPending === true && pending.pendingOutcome !== undefined;
				})
			) {
				if (Date.now() >= recoveryDeadline) throw new Error("Captured deadline terminal was not durably deferred.");
				await Bun.sleep(10);
			}
			expect(abortCalls).toBe(0);
			expect((await harness.query("turn.prompt_status", correlation)).result).toMatchObject({ status: "in_flight" });
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toEqual([]);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toEqual([]);
			const durable = store.snapshot().find(record => record.commandId === correlation.commandId) as
				| (SdkOnlyInvocationRecord & { pendingOutcome?: unknown; deadlineRecoveryPending?: boolean })
				| undefined;
			expect(durable).toMatchObject({
				status: "in_flight",
				deadlineRecoveryPending: true,
				pendingOutcome: { kind: "stopped", reason: "cancelled" },
			});
			const reopened = createInvocationReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId }),
			});
			await reopened.hydrate();
			expect(reopened.lookup("prompt", correlation)).toMatchObject({ status: "in_flight" });
			const recoveryRows = reopened.listDeadlineRecoveryPendingPrompts();
			expect(recoveryRows).toHaveLength(1);
			expect(recoveryRows[0]).toMatchObject({
				correlation,
				pendingOutcome: { kind: "stopped", reason: "cancelled" },
			});

			activeTools.clear();
			const terminal = await settledStatus(harness, "turn.prompt_status", correlation).catch(async error => {
				const status = await harness!.query("turn.prompt_status", correlation);
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}; final status=${JSON.stringify(status.result)}; pending tools=${activeTools.size}; abort calls=${abortCalls}`,
				);
			});
			expect(terminal).toMatchObject({
				status: "terminal_ok",
				outcome: { kind: "stopped", reason: "cancelled" },
			});
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toHaveLength(1);
		} finally {
			await harness?.stop();
			await Bun.sleep(10);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("an unproven real end stays private until exact settlement evidence exists", async () => {
		// A matching lifecycle end still cannot settle a recovered deadline record
		// when the exact run/tool observation is unavailable.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-unprovable-"));
		const sessionId = "deadline-unprovable";
		const sessionFile = path.join(cwd, "session.json");
		await Bun.write(sessionFile, "");
		const store = createReconciliationStore({ sessionFile, sessionId });
		let abortCalls = 0;
		let harness: InvocationHarness | undefined;
		try {
			harness = await invocationHarness(sessionId, cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 100 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				terminalAbortSeams: {
					getReconciliationStore: () => store,
					getTerminalTurnEpoch: () => 17,
					getActivePromptHandle: () => "unobservable-tool-run",
					abortPromptAndWaitWithTerminal: async () => {
						abortCalls += 1;
						return { status: "settled" };
					},
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "unprovable" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider unavailable"), { code: "provider_unavailable" }),
			});
			const recoveryDeadline = Date.now() + 5_000;
			while (
				!store
					.snapshot()
					.some(
						record =>
							record.commandId === correlation.commandId &&
							(record as SdkOnlyInvocationRecord & { deadlineRecoveryPending?: boolean })
								.deadlineRecoveryPending === true,
					)
			) {
				if (Date.now() >= recoveryDeadline) throw new Error("Prompt deadline recovery was not durably marked.");
				await Bun.sleep(10);
			}
			expect(abortCalls).toBe(0);
			expect(await harness.query("turn.prompt_status", correlation)).toMatchObject({
				result: { status: "in_flight" },
			});
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toHaveLength(1);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toEqual([]);
			await harness.emit("agent_end", { stopReason: "cancelled" });
			await Bun.sleep(100);
			expect(await harness.query("turn.prompt_status", correlation)).toMatchObject({
				result: { status: "in_flight" },
			});
			expect((await harness.query("turn.prompt_status", correlation)).result).not.toHaveProperty("outcome");
			expect((await harness.query("turn.prompt_status", correlation)).result).not.toHaveProperty("pendingOutcome");
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toEqual([]);
			const durable = store.snapshot().find(record => record.commandId === correlation.commandId) as
				| (SdkOnlyInvocationRecord & { pendingOutcome?: unknown; deadlineRecoveryPending?: boolean })
				| undefined;
			expect(durable).toMatchObject({
				status: "in_flight",
				deadlineRecoveryPending: true,
				pendingOutcome: { kind: "failed", providerCode: "provider_unavailable" },
			});
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toHaveLength(1);
		} finally {
			await harness?.stop();
			await Bun.sleep(10);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a drained tool boundary renews the lease before the exact run is stopped", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-tool-settled-"));
		const activeTools = new Set(["bash-call"]);
		let boundaryWaitStarted = false;
		const epoch = 61;
		const abortCalls: Array<{ handle: string; scope?: string; expectedEpoch?: number }> = [];
		let harness: InvocationHarness | undefined;
		try {
			harness = await invocationHarness("deadline-tool-settled", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 250 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => "deadline-tool-run",
					pendingToolExecutions: () => {
						if (activeTools.size > 0) boundaryWaitStarted = true;
						return [...activeTools];
					},
					abortPromptAndWaitWithTerminal: async (handle, options) => {
						abortCalls.push({
							handle,
							scope: options.terminal?.scope,
							expectedEpoch: options.terminal?.expectedEpoch,
						});
						await harness?.emit("agent_end", { stopReason: "cancelled" });
						return {
							status: "settled",
							terminalScope: { abortedAttemptEpoch: epoch, lineageIdHash: "deadline-tool-lineage" },
						};
					},
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "finish the tool first" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "bash-call",
				toolName: "bash",
				args: {},
			});
			const boundaryDeadline = Date.now() + 10_000;
			while (!boundaryWaitStarted && Date.now() < boundaryDeadline) await Bun.sleep(10);
			expect(boundaryWaitStarted).toBe(true);
			expect(abortCalls).toHaveLength(0);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toEqual([]);
			activeTools.clear();
			await harness.emit("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: "bash-call",
				toolName: "bash",
				isError: false,
			});
			await Bun.sleep(30);
			expect(abortCalls).toHaveLength(0);
			const abortDeadline = Date.now() + 2_000;
			while (abortCalls.length === 0 && Date.now() < abortDeadline) await Bun.sleep(10);
			expect(abortCalls).toEqual([{ handle: "deadline-tool-run", scope: "owned", expectedEpoch: epoch }]);
			expect(await settledStatus(harness, "turn.prompt_status", correlation)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
				outcome: { kind: "failed", code: "prompt_deadline_exceeded", provenance: "deadline" },
			});
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toEqual([]);
			await harness.stop();
		} finally {
			await harness?.stop();
			await Bun.sleep(10);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("deadline autosave completes before deferred terminal reconciliation", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-flush-order-"));
		const releaseTerminalWrite = Promise.withResolvers<void>();
		const epoch = 71;
		let harness: InvocationHarness | undefined;
		let terminalWriteStarted = false;
		let correlation: { commandId?: string; turnId?: string } = {};
		let statusBeforeFlush: string | undefined;
		const runGit = async (args: string[]): Promise<string> => {
			const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
			return stdout;
		};
		try {
			await runGit(["init", "--initial-branch=deadline"]);
			await runGit(["config", "user.email", "test@example.com"]);
			await runGit(["config", "user.name", "Test"]);
			await runGit(["config", "commit.gpgsign", "false"]);
			await writeFile(path.join(cwd, "work.ts"), "export const value = 'before';\n");
			await runGit(["add", "work.ts"]);
			await runGit(["commit", "-m", "initial"]);
			await writeFile(path.join(cwd, "work.ts"), "export const value = 'deadline';\n");
			harness = await invocationHarness("deadline-flush-order", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs"
							? 100
							: key === "sdk.promptMaxRuntimeMs"
								? 60_000
								: key === "sdk.flushWorktreeOnDeadline"
									? true
									: undefined,
					has: (key: string) => key === "sdk.flushWorktreeOnDeadline",
					getAgentDir: () => path.join(cwd, ".gjc", "agent"),
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => "deadline-flush-run",
					pendingToolExecutions: () => [],
					abortPromptAndWaitWithTerminal: async () => {
						await harness?.emit("agent_end", { stopReason: "cancelled" });
						statusBeforeFlush = (await harness?.query("turn.prompt_status", correlation))?.result?.status;
						return {
							status: "settled",
							terminalScope: { abortedAttemptEpoch: epoch, lineageIdHash: "deadline-flush-lineage" },
						};
					},
				},
				persistInterceptor: () => {},
				agentFailedWriteFailures: 0,
				persistHolds: [
					{
						type: "agent_end",
						onEntered: () => {
							terminalWriteStarted = true;
						},
						release: releaseTerminalWrite.promise,
					},
				],
			});
			const accepted = await harness.control("turn.prompt", { text: "autosave before terminal" });
			expect(accepted.ok).toBe(true);
			correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			const terminalWriteDeadline = Date.now() + 10_000;
			while (!terminalWriteStarted && Date.now() < terminalWriteDeadline) await Bun.sleep(10);
			expect(terminalWriteStarted).toBe(true);
			expect(statusBeforeFlush).toBe("in_flight");
			expect((await harness.query("turn.prompt_status", correlation)).result).toMatchObject({
				status: "in_flight",
			});
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toEqual([]);
			expect(await runGit(["show", "HEAD:work.ts"])).toBe("export const value = 'deadline';\n");
			releaseTerminalWrite.resolve();
			expect(await settledStatus(harness, "turn.prompt_status", correlation)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
				outcome: { kind: "failed", code: "prompt_deadline_exceeded", provenance: "deadline" },
			});
		} finally {
			releaseTerminalWrite.resolve();
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a broadcast failure keeps the deadline boundary replayable and reconciled", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-stop-publication-loss-"));
		const epoch = 53;
		let harness: InvocationHarness | undefined;
		let abortCalls = 0;
		let publicationFailed = false;
		let correlation: { commandId?: string; turnId?: string } = {};
		try {
			harness = await invocationHarness("deadline-stop-publication-loss", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 100 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => "deadline-publication-loss-run",
					pendingToolExecutions: () => [],
					abortPromptAndWaitWithTerminal: async () => {
						abortCalls += 1;
						await harness?.emit("agent_end", { stopReason: "cancelled" });
						return {
							status: "settled",
							terminalScope: {
								abortedAttemptEpoch: epoch,
								lineageIdHash: "deadline-publication-loss-lineage",
							},
						};
					},
				},
				broadcastInterceptor: frame => {
					const payload = frame.payload as { commandId?: string; turnId?: string } | undefined;
					if (
						frame.kind === "agent_end" &&
						payload?.commandId === correlation.commandId &&
						payload?.turnId === correlation.turnId
					) {
						publicationFailed = true;
						throw Object.assign(new Error("injected terminal publication failure"), { code: "io_error" });
					}
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "lost terminal" });
			expect(accepted.ok).toBe(true);
			correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			const abortDeadline = Date.now() + 2_000;
			while (abortCalls === 0 && Date.now() < abortDeadline) await Bun.sleep(10);
			expect(abortCalls).toBe(1);
			const publicationDeadline = Date.now() + 2_000;
			while (!publicationFailed && Date.now() < publicationDeadline) await Bun.sleep(10);
			expect(publicationFailed).toBe(true);
			// The ring append is authoritative even when this immediate broadcast
			// fails; the deadline must reconcile it once without appending a duplicate.
			await Bun.sleep(150);
			expect(await settledStatus(harness, "turn.prompt_status", correlation)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
				outcome: { kind: "failed", code: "prompt_deadline_exceeded", provenance: "deadline" },
			});
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toEqual([]);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toEqual([]);
			await harness.requestOnSession("deadline-stop-publication-loss", {
				type: "event_replay",
				sinceGeneration: 0,
				sinceSeq: 0,
			});
			const replay = harness
				.sent("deadline-stop-publication-loss")
				.filter(frame => frame.type === "event_replay_result")
				.at(-1) as
				| {
						events?: Array<{
							kind?: unknown;
							payload?: { commandId?: string; turnId?: string; outcome?: unknown };
						}>;
				  }
				| undefined;
			const replayedEnds =
				replay?.events?.filter(
					frame =>
						frame.kind === "agent_end" &&
						frame.payload?.commandId === correlation.commandId &&
						frame.payload?.turnId === correlation.turnId,
				) ?? [];
			expect(replayedEnds).toHaveLength(1);
			expect(replayedEnds[0]?.payload).toMatchObject({
				outcome: { kind: "failed", code: "prompt_deadline_exceeded", provenance: "deadline" },
			});
		} finally {
			await harness?.stop();
			await Bun.sleep(10);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a queued prompt deadline stays recoverable while another turn is active", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-independent-turn-"));
		let idle = true;
		let promptDeadlineMs = 600_000;
		let promoted: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
		let abortCalls = 0;
		try {
			const harness = await invocationHarness("deadline-independent-turn", cwd, {
				isIdle: () => idle,
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs"
							? promptDeadlineMs
							: key === "sdk.promptMaxRuntimeMs"
								? 600_000
								: undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					if ((options as { deliverAs?: string } | undefined)?.deliverAs === "followUp") {
						promoted = (
							options as { onQueuedPromoted?: (promotion: { startsOwnRun: boolean }) => void } | undefined
						)?.onQueuedPromoted;
						return;
					}
					await neverSettlingPromise();
				},
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => 2,
					getActivePromptHandle: () => "independent-active-run",
					pendingToolExecutions: () => [],
					abortPromptAndWaitWithTerminal: async () => {
						abortCalls += 1;
						return { status: "unfenced" };
					},
				},
			});
			const active = await harness.control("turn.prompt", { text: "independent run" });
			expect(active.ok).toBe(true);
			await harness.emit("agent_start");
			idle = false;
			promptDeadlineMs = 100;
			const queued = await harness.control("turn.follow_up", { text: "queued prompt" });
			expect(queued.ok).toBe(true);
			const activeIds = { commandId: active.result?.commandId, turnId: active.result?.turnId };
			const queuedIds = { commandId: queued.result?.commandId, turnId: queued.result?.turnId };
			// The short lease belongs to an unconsumed queue entry, not to the root
			// run: it stays accepted past two lease periods without borrowing root abort.
			await Bun.sleep(250);
			expect(await harness.query("turn.prompt_status", queuedIds)).toMatchObject({ result: { status: "accepted" } });
			expect(abortCalls).toBe(0);
			expect(correlatedFrames(harness, queuedIds).filter(frame => frame.kind === "agent_failed")).toHaveLength(0);
			promoted?.({ startsOwnRun: true });
			promptDeadlineMs = 600_000;
			await Bun.sleep(150);
			expect((await harness.query("turn.prompt_status", queuedIds)).result?.status).toMatch(/accepted|in_flight/);
			expect(await harness.query("turn.prompt_status", activeIds)).toMatchObject({
				result: { status: "in_flight" },
			});
			expect(abortCalls).toBe(0);
			expect(correlatedFrames(harness, queuedIds).filter(frame => frame.kind === "agent_failed")).toHaveLength(0);
			expect(correlatedFrames(harness, queuedIds).filter(frame => frame.kind === "agent_end")).toHaveLength(0);
			expect(correlatedFrames(harness, activeIds).filter(frame => frame.kind === "agent_end")).toHaveLength(0);

			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "done" }] });
			expect(await settledStatus(harness, "turn.prompt_status", activeIds)).toMatchObject({
				status: "terminal_ok",
			});
			idle = true;
			await harness.emit("agent_start");
			expect(await harness.query("turn.prompt_status", queuedIds)).toMatchObject({
				result: { status: "in_flight" },
			});
			await harness.emit("agent_end", { messages: [{ role: "assistant", content: "queued run" }] });
			expect(await settledStatus(harness, "turn.prompt_status", queuedIds)).toMatchObject({
				status: "terminal_ok",
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("agent_start during a pending deadline claim preserves the expiring correlation", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-start-race-"));
		const claimEntered = Promise.withResolvers<void>();
		const releaseClaim = Promise.withResolvers<void>();
		const epoch = 83;
		let harness: InvocationHarness | undefined;
		let startPromise: Promise<void> | undefined;
		let claimWasEntered = false;
		let handleReads = 0;
		let abortCalls = 0;
		try {
			harness = await invocationHarness("deadline-start-race", cwd, {
				settings: zeroProgressSettings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				persistInterceptor: () => {},
				agentFailedWriteFailures: 0,
				persistHolds: [
					{
						type: "deadline_claim",
						onEntered: () => {
							claimWasEntered = true;
							claimEntered.resolve();
						},
						release: releaseClaim.promise,
					},
				],
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => {
						handleReads += 1;
						return "deadline-start-race-run";
					},
					pendingToolExecutions: () => [],
					abortPromptAndWaitWithTerminal: async (_handle, _options) => {
						abortCalls += 1;
						await startPromise;
						await harness?.emit("agent_end", { stopReason: "cancelled" });
						return {
							status: "settled",
							terminalScope: { abortedAttemptEpoch: epoch, lineageIdHash: "deadline-start-race-lineage" },
						};
					},
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "start while expiring" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			const claimDeadline = Date.now() + 2_000;
			while (!claimWasEntered && Date.now() < claimDeadline) await Bun.sleep(5);
			expect(claimWasEntered).toBe(true);
			await claimEntered.promise;
			startPromise = harness.emit("agent_start");
			const captureDeadline = Date.now() + 2_000;
			while (handleReads === 0 && Date.now() < captureDeadline) await Bun.sleep(5);
			expect(handleReads).toBeGreaterThan(0);
			releaseClaim.resolve();
			await startPromise;
			expect(await settledStatus(harness, "turn.prompt_status", correlation)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
				outcome: { kind: "failed", code: "prompt_deadline_exceeded", provenance: "deadline" },
			});
			expect(abortCalls).toBe(1);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_start")).toHaveLength(1);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toHaveLength(1);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toHaveLength(0);
		} finally {
			releaseClaim.resolve();
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("agent_start during an expiry claim keeps the queued correlation owned", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-start-race-"));
		const claimEntered = Promise.withResolvers<void>();
		const releaseClaim = Promise.withResolvers<void>();
		const activeTools = new Set(["delayed-tool"]);
		const epoch = 83;
		let harness: InvocationHarness | undefined;
		let startPromise: Promise<void> | undefined;
		let claimWasEntered = false;
		let handleReads = 0;
		let boundaryWaitStarted = false;
		let abortCalls = 0;
		let terminalEventPromise: Promise<void> | undefined;
		try {
			harness = await invocationHarness("deadline-start-race", cwd, {
				settings: zeroProgressSettings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				persistInterceptor: () => {},
				agentFailedWriteFailures: 0,
				persistHolds: [
					{
						type: "deadline_claim",
						onEntered: () => {
							claimWasEntered = true;
							claimEntered.resolve();
						},
						release: releaseClaim.promise,
					},
				],
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => {
						handleReads += 1;
						return "deadline-start-race-run";
					},
					pendingToolExecutions: () => {
						if (activeTools.size > 0) boundaryWaitStarted = true;
						else if (boundaryWaitStarted && terminalEventPromise === undefined)
							terminalEventPromise = harness?.emit("agent_end", { stopReason: "cancelled" });
						return [...activeTools];
					},
					abortPromptAndWaitWithTerminal: async () => {
						abortCalls += 1;
						return { status: "unfenced" };
					},
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "start while expiring" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			const claimDeadline = Date.now() + 2_000;
			while (!claimWasEntered && Date.now() < claimDeadline) await Bun.sleep(5);
			expect(claimWasEntered).toBe(true);
			startPromise = harness.emit("agent_start");
			const captureDeadline = Date.now() + 2_000;
			while (handleReads === 0 && Date.now() < captureDeadline) await Bun.sleep(5);
			expect(handleReads).toBeGreaterThan(0);
			releaseClaim.resolve();
			await startPromise;
			const boundaryDeadline = Date.now() + 10_000;
			while (!boundaryWaitStarted && Date.now() < boundaryDeadline) await Bun.sleep(5);
			expect(boundaryWaitStarted).toBe(true);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_start")).toHaveLength(1);
			activeTools.clear();
			const terminalEventDeadline = Date.now() + 2_000;
			while (terminalEventPromise === undefined && Date.now() < terminalEventDeadline) await Bun.sleep(5);
			expect(terminalEventPromise).toBeDefined();
			await terminalEventPromise;
			expect(await settledStatus(harness, "turn.prompt_status", correlation)).toMatchObject({
				status: "terminal_ok",
				outcome: { kind: "stopped", reason: "cancelled" },
			});
			expect(abortCalls).toBeLessThanOrEqual(1);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toHaveLength(1);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toHaveLength(0);
		} finally {
			releaseClaim.resolve();
			await harness?.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a sibling publication failure does not hide the expiring correlation's end", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-sibling-publication-"));
		const epoch = 89;
		let promptDeadlineMs = 600_000;
		let harness: InvocationHarness | undefined;
		let promotedB: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
		let promotedC: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
		let targetIds: { commandId?: string; turnId?: string } = {};
		let siblingIds: { commandId?: string; turnId?: string } = {};
		let abortCalls = 0;
		try {
			harness = await invocationHarness("deadline-sibling-publication", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs"
							? promptDeadlineMs
							: key === "sdk.promptMaxRuntimeMs"
								? 60_000
								: undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					const callback = (
						options as { onQueuedPromoted?: (promotion: { startsOwnRun: boolean }) => void } | undefined
					)?.onQueuedPromoted;
					if ((options as { deliverAs?: string } | undefined)?.deliverAs === "followUp") {
						if (promotedB === undefined) promotedB = callback;
						else promotedC = callback;
						return;
					}
					await neverSettlingPromise();
				},
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => "deadline-shared-run",
					pendingToolExecutions: () => [],
					abortPromptAndWaitWithTerminal: async () => {
						abortCalls += 1;
						await harness?.emit("agent_end", {
							sdkRunToken: `${targetIds.commandId}:${targetIds.turnId}`,
							stopReason: "cancelled",
						});
						return {
							status: "settled",
							terminalScope: { abortedAttemptEpoch: epoch, lineageIdHash: "deadline-shared-lineage" },
						};
					},
				},
				broadcastInterceptor: frame => {
					const payload = frame.payload as { commandId?: string; turnId?: string } | undefined;
					if (
						frame.kind === "agent_end" &&
						payload?.commandId === siblingIds.commandId &&
						payload?.turnId === siblingIds.turnId
					)
						throw Object.assign(new Error("sibling boundary publication failed"), { code: "io_error" });
				},
			});
			const lead = await harness.control("turn.prompt", { text: "shared lead" });
			expect(lead.ok).toBe(true);
			await harness.emit("agent_start");
			const followUpB = await harness.control("turn.follow_up", { text: "deadline target" });
			const followUpC = await harness.control("turn.follow_up", { text: "shared sibling" });
			expect(followUpB.ok).toBe(true);
			expect(followUpC.ok).toBe(true);
			targetIds = { commandId: followUpB.result?.commandId, turnId: followUpB.result?.turnId };
			siblingIds = { commandId: followUpC.result?.commandId, turnId: followUpC.result?.turnId };
			promptDeadlineMs = 100;
			promotedB?.({ startsOwnRun: true });
			promptDeadlineMs = 600_000;
			promotedC?.({ startsOwnRun: true });
			await harness.emit("agent_start");
			expect(await settledStatus(harness, "turn.prompt_status", targetIds)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
				outcome: { kind: "failed", code: "prompt_deadline_exceeded", provenance: "deadline" },
			});
			expect(abortCalls).toBe(1);
			expect(correlatedFrames(harness, targetIds).filter(frame => frame.kind === "agent_end")).toHaveLength(1);
			expect(correlatedFrames(harness, targetIds).filter(frame => frame.kind === "agent_failed")).toHaveLength(0);
			expect(correlatedFrames(harness, siblingIds).filter(frame => frame.kind === "agent_end")).toHaveLength(0);
		} finally {
			await harness?.stop();
			await Bun.sleep(10);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a deferred cancelled end preserves its provider failure", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-provider-cancelled-"));
		const epoch = 97;
		let harness: InvocationHarness | undefined;
		let abortCalls = 0;
		try {
			harness = await invocationHarness("deadline-provider-cancelled", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 100 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				agentFailedWriteFailures: 2,
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => "deadline-provider-cancelled-run",
					pendingToolExecutions: () => [],
					abortPromptAndWaitWithTerminal: async () => {
						abortCalls += 1;
						await harness?.emit("agent_failed", {
							error: Object.assign(new Error("provider unavailable"), { code: "provider_unavailable" }),
						});
						await harness?.emit("agent_end", { stopReason: "cancelled" });
						return {
							status: "settled",
							terminalScope: {
								abortedAttemptEpoch: epoch,
								lineageIdHash: "deadline-provider-cancelled-lineage",
							},
						};
					},
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "provider fails during cancellation" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			expect(await settledStatus(harness, "turn.prompt_status", correlation)).toMatchObject({
				status: "failed",
				error: { code: "provider_unavailable" },
			});
			expect(abortCalls).toBe(1);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toHaveLength(1);
			expect(
				correlatedFrames(harness, correlation).find(frame => frame.kind === "agent_end")?.payload,
			).toMatchObject({
				outcome: { kind: "failed", code: "prompt_failed", providerCode: "provider_unavailable" },
			});
		} finally {
			await harness?.stop();
			await Bun.sleep(10);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a deferred terminal retries a transient outcome-staging failure", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-stage-retry-"));
		const epoch = 101;
		let harness: InvocationHarness | undefined;
		let stageFailures = 0;
		let abortCalls = 0;
		try {
			harness = await invocationHarness("deadline-stage-retry", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 100 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				persistInterceptor: transition => {
					if (transition.type === "pending_terminal_outcome" && stageFailures === 0) {
						stageFailures += 1;
						throw Object.assign(new Error("injected pending terminal persistence failure"), {
							code: "io_error",
						});
					}
				},
				agentFailedWriteFailures: 0,
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => "deadline-stage-retry-run",
					pendingToolExecutions: () => [],
					abortPromptAndWaitWithTerminal: async () => {
						abortCalls += 1;
						await harness?.emit("agent_end", { stopReason: "cancelled" });
						return {
							status: "settled",
							terminalScope: { abortedAttemptEpoch: epoch, lineageIdHash: "deadline-stage-retry-lineage" },
						};
					},
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "retry terminal staging" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			expect(await settledStatus(harness, "turn.prompt_status", correlation)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
				outcome: { kind: "failed", code: "prompt_deadline_exceeded", provenance: "deadline" },
			});
			expect(stageFailures).toBe(1);
			expect(abortCalls).toBe(1);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toHaveLength(1);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toHaveLength(0);
		} finally {
			await harness?.stop();
			await Bun.sleep(10);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a durable deadline claim can settle after deferred outcome staging fails", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-stage-recovery-owner-"));
		const epoch = 107;
		let harness: InvocationHarness | undefined;
		let stageAttempts = 0;
		let abortCalls = 0;
		try {
			harness = await invocationHarness("deadline-stage-recovery-owner", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 100 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				persistInterceptor: transition => {
					if (transition.type !== "pending_terminal_outcome") return;
					stageAttempts += 1;
					throw Object.assign(new Error("injected persistent pending terminal failure"), {
						code: "io_error",
					});
				},
				agentFailedWriteFailures: 0,
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => "deadline-stage-recovery-run",
					pendingToolExecutions: () => [],
					abortPromptAndWaitWithTerminal: async () => {
						abortCalls += 1;
						await harness?.emit("agent_end", { stopReason: "cancelled" });
						return {
							status: "settled",
							terminalScope: { abortedAttemptEpoch: epoch, lineageIdHash: "deadline-stage-recovery-lineage" },
						};
					},
				},
			});
			const accepted = await harness.control("turn.prompt", { text: "recover terminal staging" });
			expect(accepted.ok).toBe(true);
			const correlation = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			const stagingDeadline = Date.now() + 2_000;
			while (stageAttempts === 0 && Date.now() < stagingDeadline) await Bun.sleep(10);
			expect(stageAttempts).toBeGreaterThan(0);
			expect(await settledStatus(harness, "turn.prompt_status", correlation)).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
				outcome: { kind: "failed", code: "prompt_deadline_exceeded", provenance: "deadline" },
			});
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_end")).toHaveLength(1);
			expect(correlatedFrames(harness, correlation).filter(frame => frame.kind === "agent_failed")).toEqual([]);
			expect(abortCalls).toBe(1);
		} finally {
			await harness?.stop();
			await Bun.sleep(10);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("abort_and_prompt with no started turn keeps both correlations recoverable", async () => {
		// The issue observed both the original turn.prompt AND the replacement
		// turn.abort_and_prompt accepted with permanently zero activity. Neither
		// accepted correlation is terminal until the runtime can prove it cannot run.
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
			await Bun.sleep(100);
			for (const ids of [originalIds, replacementIds]) {
				expect((await harness.query("turn.prompt_status", ids)).result?.status).toMatch(/accepted|in_flight/);
				expect(
					correlatedFrames(harness, ids).filter(
						frame => frame.kind === "agent_failed" || frame.kind === "agent_end",
					),
				).toEqual([]);
			}
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a zero-progress drained batch stays nonterminal without an exact run proof", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-lease-batch-"));
		let promptDeadlineMs = 600_000;
		let harness: InvocationHarness | undefined;
		try {
			const promoted: Array<((promotion: { startsOwnRun: boolean }) => void) | undefined> = [];
			harness = await invocationHarness("lease-batch", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs"
							? promptDeadlineMs
							: key === "sdk.promptMaxRuntimeMs"
								? 60_000
								: undefined,
				} as unknown as Settings,
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
			promptDeadlineMs = 250;
			const followUpB = await harness.control("turn.follow_up", { text: "b" });
			const followUpC = await harness.control("turn.follow_up", { text: "c" });
			expect(followUpB.ok).toBe(true);
			expect(followUpC.ok).toBe(true);
			expect(promoted).toHaveLength(2);
			const idsB = { commandId: followUpB.result?.commandId, turnId: followUpB.result?.turnId };
			const idsC = { commandId: followUpC.result?.commandId, turnId: followUpC.result?.turnId };
			// The unwind promotes both queued follow-ups into ONE run: a single
			// agent_start drains the batch.
			promoted[0]?.({ startsOwnRun: true });
			promoted[1]?.({ startsOwnRun: true });
			promptDeadlineMs = 600_000;
			await harness.emit("agent_start");
			await Bun.sleep(300);
			for (const ids of [idsB, idsC]) {
				expect((await harness.query("turn.prompt_status", ids)).result?.status).toMatch(/accepted|in_flight/);
				expect(correlatedFrames(harness, ids).filter(frame => frame.kind === "agent_failed")).toEqual([]);
			}
			expect(correlatedFrames(harness, idsB).filter(frame => frame.kind === "agent_end")).toEqual([]);
			expect(correlatedFrames(harness, idsC).filter(frame => frame.kind === "agent_end")).toEqual([]);
		} finally {
			await harness?.stop();
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

	test("a replacement deadline stops its own turn but does not fail an unproven predecessor", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-lease-reentry-"));
		const epoch = 43;
		let promptDeadlineMs = 10_000;
		let harness: InvocationHarness | undefined;
		let replacementToken = "";
		let abortCalls = 0;
		try {
			let promoted: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
			harness = await invocationHarness("lease-reentry", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs"
							? promptDeadlineMs
							: key === "sdk.promptMaxRuntimeMs"
								? 60_000
								: undefined,
				} as unknown as Settings,
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
				terminalAbortSeams: {
					getTerminalTurnEpoch: () => epoch,
					getActivePromptHandle: () => "replacement-run",
					pendingToolExecutions: () => [],
					abortPromptAndWaitWithTerminal: async () => {
						abortCalls += 1;
						await harness?.emit("agent_end", { sdkRunToken: replacementToken, stopReason: "cancelled" });
						return {
							status: "settled",
							terminalScope: { abortedAttemptEpoch: epoch, lineageIdHash: "replacement-run-lineage" },
						};
					},
				},
			});
			const first = await harness.control("turn.prompt", { text: "first" });
			expect(first.ok).toBe(true);
			await harness.emit("agent_start");
			promptDeadlineMs = 1_000;
			const followUp = await harness.control("turn.follow_up", { text: "replacement" });
			expect(followUp.ok).toBe(true);
			replacementToken = `${followUp.result?.commandId}:${followUp.result?.turnId}`;
			promoted?.({ startsOwnRun: true });
			// Re-entry with a non-empty drain while the first turn never ended.
			await harness.emit("agent_start");
			const idsFirst = { commandId: first.result?.commandId, turnId: first.result?.turnId };
			const idsFollowUp = { commandId: followUp.result?.commandId, turnId: followUp.result?.turnId };
			expect((await harness.query("turn.prompt_status", idsFirst)).result?.status).toBe("in_flight");
			const followUpStatus = await settledStatus(harness, "turn.prompt_status", idsFollowUp).catch(async error => {
				const current = await harness!.query("turn.prompt_status", idsFollowUp);
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}; replacement=${JSON.stringify(current.result)}; abort calls=${abortCalls}`,
				);
			});
			expect(followUpStatus).toMatchObject({
				status: "failed",
				error: { code: "prompt_deadline_exceeded" },
				outcome: { kind: "failed", code: "prompt_deadline_exceeded", provenance: "deadline" },
			});
			expect(abortCalls).toBeGreaterThan(0);
		} finally {
			await harness?.stop();
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a promoted follow-up without agent_start remains recoverable", async () => {
		// A promotion callback is not proof that its own run has started or that the
		// queued submission can no longer execute.
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
			await Bun.sleep(100);
			expect((await harness.query("turn.prompt_status", ids)).result?.status).toMatch(/accepted|in_flight/);
			expect(correlatedFrames(harness, ids).filter(frame => frame.kind === "agent_failed")).toEqual([]);
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
			const renewalSettings = {
				get: (key: string) =>
					key === "sdk.promptDeadlineMs" ? 2_000 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
			} as unknown as Settings;
			let promoted: ((promotion: { startsOwnRun: boolean }) => void) | undefined;
			const harness = await invocationHarness("renew-attached", cwd, {
				settings: renewalSettings,
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
			// Past the initial 2s lease, repeated tool activity keeps the
			// attached correlation alive. Each interval stays well within one
			// renewed lease while their cumulative duration exceeds the original.
			for (let i = 0; i < 3; i += 1) {
				await harness.emit("tool_execution_start");
				await Bun.sleep(800);
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
		createTestRuntimeExtension(api, {
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
			idle = true;
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
						key === "sdk.promptDeadlineMs" ? 2_000 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
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
			// Far past the 2s lease while queued: the acceptance-anchored lease
			// was dropped at the divert disposition, so no false deadline fire.
			await Bun.sleep(2_200);
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

	test("F3 the deadline compound recovery replays the diagnostic after a true expiry", async () => {
		// The prompt sibling of the skill recovery: when a prompt settlement's durable
		// writes fail, ownership goes to the deadline lease instead of the skill loop, and
		// its expiry replays the cached reason before the boundary. A real 25ms lease is
		// armed so the replay is driven by an actual matched expiry, not by calling the
		// replay directly. Every durable attempt is observed with its correlation.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-deadline-compound-diagnostic-"));
		const attempts: Array<{ type: string | undefined; commandId?: string; turnId?: string; outcome: string }> = [];
		try {
			const harness = await invocationHarness("deadline-compound-diagnostic", cwd, {
				settings: {
					get: (key: string) =>
						key === "sdk.promptDeadlineMs" ? 25 : key === "sdk.promptMaxRuntimeMs" ? 60_000 : undefined,
				} as unknown as Settings,
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				persistInterceptor: () => {},
				agentFailedWriteFailures: 2,
				onDurableAttempt: attempt => attempts.push(attempt),
			});
			const submitted = await harness.control("turn.prompt", {
				text: "deadline compound carrier",
				clientRef: "deadline-compound-ref",
			});
			expect(submitted.ok).toBe(true);
			const commandId = (submitted.result as { commandId?: string } | undefined)?.commandId;
			const turnId = (submitted.result as { turnId?: string } | undefined)?.turnId;
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider exploded sk-ant-secret-DEADLINE"), {
					code: "provider_unavailable",
					providerDiagnostic: {
						category: "provider_unavailable",
						httpStatus: 503,
						code: "overloaded_error",
						evidence: "structured_code",
					},
				}),
			});
			await harness.emit("agent_end");
			const settled = await settledStatus(harness, "turn.prompt_status", { clientRef: "deadline-compound-ref" });

			const correlated = attempts.filter(attempt => attempt.commandId === commandId && attempt.turnId === turnId);
			expect(
				correlated.filter(attempt => attempt.type === "agent_failed" && attempt.outcome === "rejected"),
			).toHaveLength(2);
			expect(correlated.some(attempt => attempt.type === "agent_failed" && attempt.outcome === "committed")).toBe(
				true,
			);

			expect(settled.status).toBe("failed");
			expect(settled.error?.code).toBe("provider_unavailable");
			expect((settled as { outcome?: { providerDiagnostic?: unknown } }).outcome?.providerDiagnostic).toEqual({
				category: "provider_unavailable",
				httpStatus: 503,
				code: "overloaded_error",
				evidence: "structured_code",
			});
			expect(JSON.stringify(settled)).not.toContain("sk-ant-secret-DEADLINE");
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("F3 the cached lifecycle path records the diagnostic on the third durable attempt", async () => {
		// The ORIGINAL lifecycle route: agent_failed durable write fails, the agent_end
		// inline re-record of the cached reason fails too, and scheduleSkillTerminalRecovery
		// replays it. `agentFailedWriteFailures: 2` is explicit because the fixture store
		// only rejects while its budget lasts. Every durable attempt is observed with its
		// correlation, so the third (successful) write is asserted, never inferred from a
		// missing callback.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-skill-cached-lifecycle-"));
		const attempts: Array<{ type: string | undefined; commandId?: string; turnId?: string; outcome: string }> = [];
		try {
			const harness = await invocationHarness("skill-cached-lifecycle", cwd, {
				invokeSkill: async (_name, _args, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				persistInterceptor: () => {},
				agentFailedWriteFailures: 2,
				onDurableAttempt: attempt => attempts.push(attempt),
			});
			const submitted = await harness.control("skill.invoke", {
				name: "cached-lifecycle-hang",
				args: "",
				clientRef: "skill-cached-lifecycle-ref",
			});
			expect(submitted.ok).toBe(true);
			const commandId = (submitted.result as { commandId?: string } | undefined)?.commandId;
			const turnId = (submitted.result as { turnId?: string } | undefined)?.turnId;
			expect(typeof commandId).toBe("string");
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider rejected sk-ant-secret-CACHED"), {
					code: "provider_rejected",
					providerDiagnostic: {
						category: "auth",
						httpStatus: 401,
						code: "authentication_error",
						evidence: "structured_code",
					},
				}),
			});
			await harness.emit("agent_end");
			let settled:
				| { status?: string; receiptState?: string; error?: { code?: string }; outcome?: Record<string, unknown> }
				| undefined;
			for (let attempt = 0; attempt < 600 && settled === undefined; attempt += 1) {
				const frame = await harness.query("skill.invoke_status", { clientRef: "skill-cached-lifecycle-ref" });
				const result = frame.result as
					| {
							status?: string;
							receiptState?: string;
							error?: { code?: string };
							outcome?: Record<string, unknown>;
					  }
					| undefined;
				if (result?.status === "failed" || result?.status === "terminal_ok") settled = result;
				else await Bun.sleep(10);
			}
			if (settled === undefined) throw new Error("cached lifecycle recovery never converged on a terminal status");

			// Branch execution, correlated to the public submission IDs.
			const correlated = attempts.filter(attempt => attempt.commandId === commandId && attempt.turnId === turnId);
			const rejectedFailureWrites = correlated.filter(
				attempt => attempt.type === "agent_failed" && attempt.outcome === "rejected",
			);
			const committedFailureWrites = correlated.filter(
				attempt => attempt.type === "agent_failed" && attempt.outcome === "committed",
			);
			// Two rejections: the initial agent_failed write and the agent_end inline
			// re-record of the cached reason.
			expect(rejectedFailureWrites).toHaveLength(2);
			// The third attempt actually committed; it is observed, not inferred.
			expect(committedFailureWrites.length).toBeGreaterThanOrEqual(1);
			expect(correlated.some(attempt => attempt.type === "agent_end" && attempt.outcome === "committed")).toBe(true);

			// Public durable receipt keeps the cached carrier and every legacy field.
			expect(settled.status).toBe("failed");
			expect(settled.error?.code).toBe("provider_rejected");
			expect((settled.outcome as { providerCode?: string } | undefined)?.providerCode).toBe("provider_rejected");
			expect((settled.outcome as { providerDiagnostic?: unknown } | undefined)?.providerDiagnostic).toEqual({
				category: "auth",
				httpStatus: 401,
				code: "authentication_error",
				evidence: "structured_code",
			});
			expect(JSON.stringify(settled)).not.toContain("sk-ant-secret-CACHED");
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("F3 the skill rejection recovery replays the diagnostic after the initial and first recovery writes fail", async () => {
		// Entry fault: an accepted skill.invoke rejects after preflight commit, so no
		// lifecycle agent_start/agent_end is emitted at all. The rejected settlement
		// writes its own agent_failed, that write fails, ownership moves to the
		// rejection recovery intent and scheduleSkillRecovery becomes the owner. With
		// `agentFailedWriteFailures: 2` the FIRST scheduleSkillRecovery write also
		// fails, so only its next attempt can record the reason. This is NOT the
		// lifecycle agent_end inline re-record path, which is covered separately.
		// Observability is fixture-only.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-skill-scheduled-diagnostic-"));
		let agentFailedWriteAttempts = 0;
		try {
			const harness = await invocationHarness("skill-scheduled-diagnostic", cwd, {
				invokeSkill: async (_name, _args, options) => {
					await options?.onPreflightAcceptCommit?.();
					throw Object.assign(new Error("provider rejected sk-ant-secret-SCHEDULED"), {
						code: "provider_rejected",
						providerDiagnostic: {
							category: "auth",
							httpStatus: 401,
							code: "authentication_error",
							evidence: "structured_code",
						},
					});
				},
				persistInterceptor: transition => {
					if (transition.type === "agent_failed") agentFailedWriteAttempts += 1;
				},
				agentFailedWriteFailures: 2,
			});
			const submitted = await harness.control("skill.invoke", {
				name: "explode-with-diagnostic",
				args: "",
				clientRef: "skill-scheduled-diagnostic-ref",
			});
			expect(submitted.ok).toBe(true);
			let settled:
				| { status?: string; receiptState?: string; error?: { code?: string }; outcome?: Record<string, unknown> }
				| undefined;
			for (let attempt = 0; attempt < 600 && settled === undefined; attempt += 1) {
				const frame = await harness.query("skill.invoke_status", {
					clientRef: "skill-scheduled-diagnostic-ref",
				});
				const result = frame.result as
					| {
							status?: string;
							receiptState?: string;
							error?: { code?: string };
							outcome?: Record<string, unknown>;
					  }
					| undefined;
				if (result?.status === "failed" || result?.status === "terminal_ok") settled = result;
				else await Bun.sleep(10);
			}
			if (settled === undefined) throw new Error("scheduled skill recovery never converged on a terminal status");
			// Branch reachability: the fixture store counts only REJECTED agent_failed
			// writes, so exactly two means the initial rejection write and the first
			// scheduleSkillRecovery write both failed. The terminal below therefore came
			// from a later recovery attempt, not from either of those two writes.
			expect(agentFailedWriteAttempts).toBe(2);
			// Legacy skill terminal semantics are unchanged by the replay.
			expect(settled.status).toBe("failed");
			expect(settled.error?.code).toBe("provider_rejected");
			expect((settled.outcome as { providerCode?: string } | undefined)?.providerCode).toBe("provider_rejected");
			expect((settled.outcome as { providerDiagnostic?: unknown } | undefined)?.providerDiagnostic).toEqual({
				category: "auth",
				httpStatus: 401,
				code: "authentication_error",
				evidence: "structured_code",
			});
			expect(JSON.stringify(settled)).not.toContain("sk-ant-secret-SCHEDULED");
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("F3 skill terminal recovery preserves the provider diagnostic after a failed durable failure write", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-skill-diagnostic-recovery-"));
		let failedFailureWrites = 0;
		try {
			const harness = await invocationHarness("skill-diagnostic-recovery", cwd, {
				invokeSkill: async (_name, _args, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
				persistInterceptor: transition => {
					// The first durable agent_failed write fails, so the reason survives only
					// in the in-memory cache and must be replayed with its carrier intact.
					// This guards the recovery replay reachable from this route; the
					// double-failure scheduled-recovery branch is not reached by this input
					// and is reported as unverified rather than claimed.
					if (transition.type === "agent_failed" && failedFailureWrites < 2) {
						failedFailureWrites += 1;
						throw Object.assign(new Error("injected diagnostic persistence failure"), { code: "io_error" });
					}
				},
			});
			const submitted = await harness.control("skill.invoke", {
				name: "diagnostic-hang",
				args: "",
				clientRef: "skill-diagnostic-recovery-ref",
			});
			expect(submitted.ok).toBe(true);
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider rejected sk-ant-secret-SKILL"), {
					code: "provider_rejected",
					providerDiagnostic: {
						category: "auth",
						httpStatus: 401,
						code: "authentication_error",
						evidence: "structured_code",
					},
				}),
			});
			await harness.emit("agent_end");
			let settled:
				| { status?: string; receiptState?: string; error?: { code?: string }; outcome?: Record<string, unknown> }
				| undefined;
			for (let attempt = 0; attempt < 600 && settled === undefined; attempt += 1) {
				const frame = await harness.query("skill.invoke_status", { clientRef: "skill-diagnostic-recovery-ref" });
				const result = frame.result as
					| {
							status?: string;
							receiptState?: string;
							error?: { code?: string };
							outcome?: Record<string, unknown>;
					  }
					| undefined;
				if (result?.status === "failed" || result?.status === "terminal_ok") settled = result;
				else await Bun.sleep(10);
			}
			if (settled === undefined) throw new Error("skill diagnostic recovery never converged on a terminal status");
			expect(failedFailureWrites).toBeGreaterThan(0);
			// Legacy skill terminal semantics are untouched by the replay.
			expect(settled.status).toBe("failed");
			expect(settled.error?.code).toBe("provider_rejected");
			expect(settled.receiptState).toBe("missing");
			expect((settled.outcome as { providerDiagnostic?: unknown } | undefined)?.providerDiagnostic).toEqual({
				category: "auth",
				httpStatus: 401,
				code: "authentication_error",
				evidence: "structured_code",
			});
			expect(JSON.stringify(settled)).not.toContain("sk-ant-secret-SKILL");
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

	test("publishes the provider diagnostic on the real agent_failed frame", async () => {
		// R4: the wire frame is built by the publisher, not by the reconciler, and
		// it used the code/message-only sanitizer. A client therefore never saw the
		// classification the adapter produced, however well the durable row kept it.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-diagnostic-publish-"));
		try {
			const harness = await invocationHarness("diagnostic-publish", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const submitted = await harness.control("turn.prompt", { text: "failing", clientRef: "publish-ref" });
			expect(submitted.ok).toBe(true);
			const ids = { commandId: submitted.result?.commandId, turnId: submitted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider rejected sk-ant-secret-PUBLISH"), {
					code: "provider_rejected",
					providerDiagnostic: {
						category: "auth",
						httpStatus: 401,
						code: "authentication_error",
						evidence: "structured_code",
					},
				}),
			});

			const frames = harness.broadcasts.filter(frame => frame.kind === "agent_failed");
			expect(frames).toHaveLength(1);
			expect(frames[0]).toMatchObject({
				kind: "agent_failed",
				payload: {
					type: "agent_failed",
					sessionId: "diagnostic-publish",
					...ids,
					error: {
						code: "provider_rejected",
						message: "Prompt submission failed.",
						providerDiagnostic: {
							category: "auth",
							httpStatus: 401,
							code: "authentication_error",
							evidence: "structured_code",
						},
					},
				},
			});
			// The published frame carries the bounded classification and nothing else.
			expect(JSON.stringify(frames[0])).not.toContain("sk-ant-secret-PUBLISH");
			expect(JSON.stringify(frames[0])).not.toContain("provider rejected");

			await harness.emit("agent_end");
			const settled = await settledStatus(harness, "turn.prompt_status", { clientRef: "publish-ref" });
			expect(settled.status).toBe("failed");
			expect(settled.error?.code).toBe("provider_rejected");
			expect(
				(settled as { outcome?: { providerDiagnostic?: Record<string, unknown> } }).outcome?.providerDiagnostic,
			).toEqual({
				category: "auth",
				httpStatus: 401,
				code: "authentication_error",
				evidence: "structured_code",
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("keeps the provider diagnostic through failed-write recovery and rejects a forged one", async () => {
		// R4: when the first agent_failed write fails, the reason is replayed from
		// an in-memory record before the boundary. That replay rebuilt a bare Error
		// from code/message, so the diagnostic was lost exactly when durability was
		// already in doubt.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-diagnostic-recovery-"));
		let failedWrites = 0;
		try {
			const harness = await invocationHarness("diagnostic-recovery", cwd, {
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
				agentFailedWriteFailures: 1,
			});
			const submitted = await harness.control("turn.prompt", { text: "run", clientRef: "recovery-ref" });
			expect(submitted.ok).toBe(true);
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider exploded"), {
					code: "provider_unavailable",
					providerDiagnostic: {
						category: "provider_unavailable",
						httpStatus: 503,
						code: "overloaded_error",
						evidence: "structured_code",
					},
				}),
			});
			await harness.emit("agent_end");

			const settled = await settledStatus(harness, "turn.prompt_status", { clientRef: "recovery-ref" });
			expect(failedWrites).toBeGreaterThan(0);
			expect(settled.status).toBe("failed");
			expect(settled.error?.code).toBe("provider_unavailable");
			expect(
				(settled as { outcome?: { providerDiagnostic?: Record<string, unknown> } }).outcome?.providerDiagnostic,
			).toEqual({
				category: "provider_unavailable",
				httpStatus: 503,
				code: "overloaded_error",
				evidence: "structured_code",
			});
			await harness.stop();
		} finally {
			await Bun.sleep(50);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("never publishes a malformed or forged diagnostic from a failure cause", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-diagnostic-forged-"));
		try {
			const harness = await invocationHarness("diagnostic-forged", cwd, {
				sendUserMessage: async (_content, options) => {
					await options?.onPreflightAcceptCommit?.();
					await neverSettlingPromise();
				},
			});
			const submitted = await harness.control("turn.prompt", { text: "failing", clientRef: "forged-ref" });
			expect(submitted.ok).toBe(true);
			await harness.emit("agent_start");
			await harness.emit("agent_failed", {
				error: Object.assign(new Error("provider rejected"), {
					code: "provider_rejected",
					providerDiagnostic: {
						category: "quota",
						evidence: "message_text",
						detail: "sk-ant-secret-FORGED",
						requestId: "req_leak",
					},
				}),
			});

			const frames = harness.broadcasts.filter(frame => frame.kind === "agent_failed");
			expect(frames).toHaveLength(1);
			expect((frames[0]?.payload as { error?: Record<string, unknown> })?.error).toEqual({
				code: "provider_rejected",
				message: "Prompt submission failed.",
			});
			expect(JSON.stringify(frames[0])).not.toContain("sk-ant-secret-FORGED");
			expect(JSON.stringify(frames[0])).not.toContain("req_leak");
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
		createTestRuntimeExtension(api, {
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
	createTestRuntimeExtension(api, {
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
	createTestRuntimeExtension(api, {
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
	createTestRuntimeExtension(api, {
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
	createTestRuntimeExtension(api, {
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
	createTestRuntimeExtension(api, {
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

test.each([
	"hold",
	"fail",
	"removed-before-shutdown",
	"timeout",
	"failed-stop",
] as const)("SDK-only shutdown joins queued terminal publication (%s)", async mode => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-queued-shutdown-"));
	let removeQueued: (() => void) | undefined;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	let queued = false;
	let queueSignal: AbortSignal | undefined;
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: (_content: string, options: PreflightHooks | undefined) =>
			Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
				queued = true;
				queueSignal = options?.preflightSignal;
				removeQueued = () => {
					if (!queued) return;
					queued = false;
					options?.onQueuedPromoted?.({ startsOwnRun: false, removed: true });
				};
				queueSignal?.addEventListener("abort", removeQueued, { once: true });
				options?.onPreflightAccepted?.();
				return {};
			}),
	} as unknown as ExtensionAPI;
	const transport = memoryTransport();
	let transportStops = 0;
	const originalStop = transport.stop.bind(transport);
	const stopSpy = spyOn(transport, "stop").mockImplementation(async () => {
		transportStops++;
		if (mode === "failed-stop" && transportStops === 1) throw new Error("Injected first transport stop failure");
		await originalStop();
	});
	const sessionFile = path.join(cwd, "session.json");
	const store = createReconciliationStore({ sessionFile, sessionId: transport.sessionId });
	let transportCreations = 0;
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		createTransport: async () => {
			transportCreations++;
			return transport;
		},
		terminalAbortSeams: {
			getReconciliationStore: () => store,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "unrelated-handle",
			cancelPendingPreflightForTerminalAbort: () => {},
			abortPromptAndWaitWithTerminal: async () => ({ status: "settled", terminalScope: {} }),
		},
	});
	const ctx = { ...extensionContext(transport.sessionId, cwd), isIdle: () => true } as unknown as ExtensionContext;
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const target = reconciliationStorePath(sessionFile, transport.sessionId);
	const originalRename = fsPromises.rename.bind(fsPromises);
	let commandId: string | undefined;
	let armed = false;
	let interrupted = false;
	const fault = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
		if (armed && String(to) === target) {
			const document = (await Bun.file(String(from)).json()) as ReconciliationStoreDocument;
			if (document.records.some(record => record.commandId === commandId && record.terminalAt !== undefined)) {
				interrupted = true;
				started.resolve();
				if (mode === "fail" || mode === "failed-stop")
					throw Object.assign(new Error("Injected queued terminal EIO"), { code: "EIO" });
				await release.promise;
			}
		}
		return originalRename(from, to);
	});
	const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
		const deadline = Date.now() + 15_000;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
			await Bun.sleep(10);
		}
	};
	let shutdown: Promise<void> | undefined;
	try {
		await handlers.get("session_start")?.({}, ctx);
		transport.feed("requester", {
			type: "control_request",
			id: "followup",
			operation: "turn.follow_up",
			input: { text: "unconsumed followup" },
		} as SdkFrame);
		await waitFor(() => transport.sent.some(frame => frame.id === "followup"), "follow-up admission");
		const accepted = transport.sent.find(frame => frame.id === "followup") as ResponseFrame;
		expect(accepted.ok).toBe(true);
		commandId = accepted.result?.commandId;
		expect(commandId).toBeDefined();
		await waitFor(() => queued && queueSignal !== undefined, "queued follow-up");
		armed = true;
		if (mode === "removed-before-shutdown") {
			removeQueued?.();
			await started.promise;
		}
		let settled = false;
		shutdown = Promise.resolve(handlers.get("session_shutdown")?.({}, ctx));
		void shutdown.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await started.promise;
		expect(interrupted).toBe(true);
		expect(queueSignal?.aborted).toBe(true);
		expect(queued).toBe(false);
		if (mode === "fail" || mode === "timeout" || mode === "failed-stop") {
			await expect(shutdown).rejects.toMatchObject({ code: "sdk_reconciliation_teardown_failed" });
			expect(transportStops).toBe(1);
			if (mode === "fail" || mode === "timeout") {
				await expect(Promise.resolve(handlers.get("session_start")?.({}, ctx))).rejects.toMatchObject({
					code: "sdk_reconciliation_teardown_failed",
				});
				expect(transportCreations).toBe(1);
				if (mode === "timeout") {
					release.resolve();
					const deadline = Date.now() + 5_000;
					while (
						!((await Bun.file(target).json()) as ReconciliationStoreDocument).records.some(
							record => record.commandId === commandId && record.terminalAt !== undefined,
						)
					) {
						if (Date.now() > deadline) throw new Error("Timed out awaiting original publisher after teardown");
						await Bun.sleep(10);
					}
					await handlers.get("session_start")?.({}, ctx);
					expect(transportCreations).toBe(2);
					await handlers.get("session_shutdown")?.({}, ctx);
				}
			}
			if (mode === "failed-stop") {
				await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, ctx))).rejects.toMatchObject({
					code: "sdk_reconciliation_teardown_failed",
				});
				expect(transportStops).toBe(2);
			}
		} else {
			await Bun.sleep(25);
			expect(settled).toBe(false);
			expect(transportStops).toBe(0);
			transport.feed("requester", {
				type: "control_request",
				id: "draining-followup",
				operation: "turn.follow_up",
				input: { text: "must not enter during drain" },
			} as SdkFrame);
			await waitFor(() => transport.sent.some(frame => frame.id === "draining-followup"), "fenced admission");
			expect(transport.sent.find(frame => frame.id === "draining-followup")).toMatchObject({
				ok: false,
				error: { code: "session_quiescing" },
			});
			const pending = (await Bun.file(target).json()) as ReconciliationStoreDocument;
			expect(pending.records.find(record => record.commandId === commandId)?.terminalAt).toBeUndefined();
			release.resolve();
			await shutdown;
			expect(transportStops).toBe(1);
			const durable = (await Bun.file(target).json()) as ReconciliationStoreDocument;
			expect(durable.records.find(record => record.commandId === commandId)?.terminalAt).toBeDefined();
		}
	} finally {
		release.resolve();
		await shutdown?.catch(() => undefined);
		fault.mockRestore();
		stopSpy.mockRestore();
		await rm(cwd, { recursive: true, force: true });
	}
});

test.each([
	false,
	true,
])("SDK-only queued terminal recovery permits replacement after EIO (early shutdown=%s)", async earlyShutdown => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-terminal-recovery-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	let transport = memoryTransport();
	const sessionId = transport.sessionId;
	const sessionFile = path.join(cwd, `${sessionId}.json`);
	const store = createReconciliationStore({ sessionFile, sessionId });
	let creations = 0;
	let queued = false;
	let queueSignal: AbortSignal | undefined;
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: (_content: string, hooks?: PreflightHooks) =>
			Promise.resolve(hooks?.onPreflightAcceptCommit?.()).then(() => {
				queued = true;
				queueSignal = hooks?.preflightSignal;
				queueSignal?.addEventListener(
					"abort",
					() => {
						if (!queued) return;
						queued = false;
						hooks?.onQueuedPromoted?.({ startsOwnRun: false, removed: true });
					},
					{ once: true },
				);
				hooks?.onPreflightAccepted?.();
				return {};
			}),
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		settings: {
			get: (key: string) =>
				key === "sdk.promptDeadlineMs" ? 1_500 : key === "sdk.promptMaxRuntimeMs" ? 15_000 : undefined,
		} as unknown as Settings,
		createTransport: async () => {
			creations++;
			transport = memoryTransport();
			return transport;
		},
		terminalAbortSeams: {
			getReconciliationStore: () => store,
			getTerminalTurnEpoch: () => 7,
			getActivePromptHandle: () => "unrelated-handle",
			cancelPendingPreflightForTerminalAbort: () => {},
			abortPromptAndWaitWithTerminal: async () => ({ status: "settled", terminalScope: {} }),
		},
	});
	const ctx = { ...extensionContext(sessionId, cwd), isIdle: () => true } as unknown as ExtensionContext;
	const target = reconciliationStorePath(sessionFile, sessionId);
	const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string): Promise<void> => {
		const deadline = Date.now() + 10_000;
		while (!(await predicate())) {
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
			await Bun.sleep(10);
		}
	};
	let requestId = 0;
	const request = async (frame: Record<string, unknown>): Promise<ResponseFrame> => {
		const id = `terminal-recovery-${++requestId}`;
		transport.feed("requester", { ...frame, id } as SdkFrame);
		await waitFor(() => transport.sent.some(candidate => candidate.id === id), id);
		return transport.sent.find(candidate => candidate.id === id) as ResponseFrame;
	};
	const originalRename = fsPromises.rename.bind(fsPromises);
	let commandId: string | undefined;
	let injected = false;
	const fault = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
		if (!injected && commandId && String(to) === target) {
			const document = (await Bun.file(String(from)).json()) as ReconciliationStoreDocument;
			if (document.records.some(record => record.commandId === commandId && record.terminalAt !== undefined)) {
				injected = true;
				throw Object.assign(new Error("Injected terminal publication failure"), { code: "EIO" });
			}
		}
		return originalRename(from, to);
	});
	try {
		await handlers.get("session_start")?.({}, ctx);
		const accepted = await request({
			type: "control_request",
			operation: "turn.follow_up",
			input: { text: "queued input" },
		});
		expect(accepted.ok).toBe(true);
		commandId = accepted.result?.commandId;
		const turnId = accepted.result?.turnId;
		expect(commandId).toBeDefined();
		await waitFor(() => queued && queueSignal !== undefined, "queued admission");
		expect(await request({ type: "control_request", operation: "turn.abort", input: {} })).toMatchObject({
			ok: true,
			result: { aborted: false, reason: "queue_terminal_unconfirmed" },
		});
		expect(injected).toBe(true);
		expect(queueSignal?.aborted).toBe(true);
		expect(queued).toBe(false);
		fault.mockRestore();
		const initial = (await Bun.file(target).json()) as ReconciliationStoreDocument;
		expect(initial.records.find(record => record.commandId === commandId)?.terminalAt).toBeUndefined();
		if (earlyShutdown)
			await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, ctx))).rejects.toMatchObject({
				code: "sdk_reconciliation_teardown_failed",
			});
		await waitFor(async () => {
			const durable = (await Bun.file(target).json()) as ReconciliationStoreDocument;
			return durable.records.some(record => record.commandId === commandId && record.terminalAt !== undefined);
		}, "original-owner terminal recovery");
		const durable = (await Bun.file(target).json()) as ReconciliationStoreDocument;
		expect(durable.records.find(record => record.commandId === commandId)).toMatchObject({
			status: "failed",
			error: { code: "cancelled" },
		});
		if (!earlyShutdown) await handlers.get("session_shutdown")?.({}, ctx);
		await handlers.get("session_start")?.({}, ctx);
		expect(creations).toBe(2);
		expect(
			await request({ type: "query_request", query: "turn.result", input: { kind: "prompt", commandId, turnId } }),
		).toMatchObject({
			ok: true,
			result: { status: "failed", error: { code: "cancelled" } },
		});
	} finally {
		fault.mockRestore();
		await Promise.resolve(handlers.get("session_shutdown")?.({}, ctx)).catch(() => undefined);
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
	let queueSignal: AbortSignal | undefined;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		sendUserMessage: (_content: string, options: PreflightHooks | undefined) =>
			Promise.resolve(options?.onPreflightAcceptCommit?.()).then(() => {
				let queued = true;
				queueSignal = options?.preflightSignal;
				promoted = promotion => {
					if (!queued) return;
					queued = false;
					options?.onQueuedPromoted?.(promotion);
				};
				queueSignal?.addEventListener(
					"abort",
					() => {
						if (!queued) return;
						queued = false;
						options?.onQueuedPromoted?.({ startsOwnRun: false, removed: true });
					},
					{ once: true },
				);
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
	createTestRuntimeExtension(api, {
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
		expect(queueSignal?.aborted).toBe(true);
		// The cancelled input cannot be promoted. A fresh follow-up receives fresh authority.
		transport.feed("conn-b", {
			type: "control_request",
			id: "followup-b-next",
			operation: "turn.follow_up",
			input: { text: "fresh followup" },
		} as SdkFrame);
		await waitResponse("followup-b-next");
		expect(queueSignal?.aborted).toBe(false);
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
	createTestRuntimeExtension(api, {
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
	createTestRuntimeExtension(api, {
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

describe("rejection terminalization idempotency", () => {
	test("cleanup rejection after success preserves the sole correlated wire terminal and durable result", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-cleanup-rejection-"));
		const cleanup = Promise.withResolvers<void>();
		const harness = await invocationHarness("cleanup-rejection", cwd, {
			sendUserMessage: async (_content, options) => {
				await options?.onPreflightAcceptCommit?.();
				await cleanup.promise;
			},
		});
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const accepted = await harness.control("turn.prompt", { text: "complete before cleanup" });
			expect(accepted.ok).toBe(true);
			const ids = { commandId: accepted.result?.commandId, turnId: accepted.result?.turnId };
			await harness.emit("agent_start");
			await harness.emit("agent_end", {
				messages: [{ role: "assistant", content: [{ type: "text", text: "Completed." }], stopReason: "stop" }],
			});
			const before = await settledStatus(harness, "turn.result", { kind: "prompt", ...ids });
			expect(before.status).toBe("terminal_ok");
			cleanup.reject(new Error("post-turn cleanup failed"));
			await Bun.sleep(50);
			const after = await harness.query("turn.result", { kind: "prompt", ...ids });
			expect(after.result).toEqual(before);
			expect(warning).toHaveBeenCalledWith("SDK submission cleanup failed after terminal publication", {
				kind: "prompt",
				...ids,
				error: { code: "internal", message: "Prompt submission failed." },
			});
			const correlated = harness.broadcasts.filter(
				frame => (frame.payload as { commandId?: string } | undefined)?.commandId === ids.commandId,
			);
			expect(correlated.filter(frame => frame.kind === "agent_failed")).toHaveLength(0);
			const terminals = correlated.filter(frame => frame.kind === "agent_end");
			expect(terminals).toHaveLength(1);
			expect(terminals[0]).toMatchObject({
				payload: { ...ids, outcome: (before as { outcome?: unknown }).outcome },
			});
		} finally {
			warning.mockRestore();
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
