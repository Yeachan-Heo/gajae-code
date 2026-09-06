import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { logger } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { mapAgentWireEventPayloadToAcpSessionUpdates } from "../src/modes/acp/acp-event-mapper";
import { toAgentWireEventPayload } from "../src/modes/shared/agent-wire/event-envelope";
import { createReconciliationStore, type ReconciliationStore } from "../src/sdk/bus/reconciliation-store";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";
import type { SdkFrame } from "../src/sdk/host/types";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

/**
 * The SDK-only host streams turn content to the connections that submitted the
 * turn by sending the same frame the notifications runtime sends:
 *
 *   { type: "event", kind: event.type, payload: toAgentWireEventPayload(event), ...correlation }
 *
 * Two properties make that frame usable by an ACP client, and both are easy to
 * break silently:
 *
 * - `payload.event` must be present, because that nested key is the only thing
 *   the ACP receiver keys on to decide a frame carries mappable content. A
 *   payload shaped any other way is delivered and then silently ignored.
 * - the payload must map to real session updates, so the client renders
 *   assistant text and tool calls instead of an empty turn.
 */

const SESSION_ID = "01a04638-0f98-73ee-b0a6-f6eac6bc8ee5";

/** The exact frame `streamTurnEvent` builds in sdk/host/session-runtime.ts. */
function streamedFrame(event: AgentSessionEvent, correlation: { commandId: string; turnId: string }) {
	return { type: "event", kind: event.type, payload: toAgentWireEventPayload(event), ...correlation };
}

const CORRELATION = {
	commandId: "b62529c0-91ab-4ee3-8025-62fbeb341ec5",
	turnId: "62f36efe-0d5e-430a-913a-2d37a4207c90",
};

function textDelta(delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: delta }] },
		assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0 },
	} as unknown as AgentSessionEvent;
}

function thinkingDelta(delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "thinking", thinking: delta }] },
		assistantMessageEvent: { type: "thinking_delta", delta, contentIndex: 0 },
	} as unknown as AgentSessionEvent;
}

function toolStart(): AgentSessionEvent {
	return {
		type: "tool_execution_start",
		toolCallId: "call_1",
		toolName: "read",
		args: { path: "README.md" },
	} as unknown as AgentSessionEvent;
}

function toolEnd(): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: "call_1",
		toolName: "read",
		args: { path: "README.md" },
		result: { output: "hello" },
		isError: false,
	} as unknown as AgentSessionEvent;
}

interface ControlResponse {
	ok?: boolean;
	result?: { commandId?: string; turnId?: string };
}

interface HostHarness {
	control(operation: string, input: Record<string, unknown>, connectionId?: string): Promise<ControlResponse>;
	emit(event: string, payload?: unknown): Promise<void>;
	setIdle(idle: boolean): void;
	/** Promote every queued (non-idle) submission whose promotion was deferred by `deferPromotion`. */
	promoteQueued(): void;
	clearFrames(): void;
	readonly sent: Array<{ connectionId: string; frame: SdkFrame }>;
	readonly broadcasts: SdkFrame[];
	stop(): Promise<void>;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

async function createHostHarness(
	sessionId: string,
	cwd: string,
	harnessOptions: {
		settleSubmission?: "never" | "resolve";
		onSessionEvent?: ExtensionContext["onSessionEvent"];
		reconciliationStore?: ReconciliationStore;
		/** Hold `onQueuedPromoted` for non-idle submissions until `promoteQueued()` is called. */
		deferPromotion?: boolean;
	} = {},
): Promise<HostHarness> {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const waiters = new Map<string, (frame: ControlResponse) => void>();
	const sent: Array<{ connectionId: string; frame: SdkFrame }> = [];
	const broadcasts: SdkFrame[] = [];
	let receive: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	let nextId = 0;
	let idle = true;
	const deferredPromotions: Array<() => void> = [];
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
		// Commit prompt preflight so `agent_start` owns the accepted correlation, then
		// hold the submission open: these tests never end the turn.
		sendUserMessage: async (
			_content: unknown,
			options?: {
				onPreflightAcceptCommit?: () => void | Promise<void>;
				onQueuedPromoted?: (promotion?: { startsOwnRun?: boolean; removed?: boolean }) => void;
			},
		) => {
			await options?.onPreflightAcceptCommit?.();
			if (!idle) {
				const promote = () => options?.onQueuedPromoted?.({ startsOwnRun: false });
				if (harnessOptions.deferPromotion) deferredPromotions.push(promote);
				else promote();
			}
			if (harnessOptions.settleSubmission === "resolve") return;
			return await new Promise<never>(() => {});
		},
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		agentDir: path.join(cwd, ".gjc", "agent"),
		...(harnessOptions.reconciliationStore
			? {
					terminalAbortSeams: {
						getReconciliationStore: () => harnessOptions.reconciliationStore,
						getTerminalTurnEpoch: () => undefined,
						getActivePromptHandle: () => undefined,
						cancelPendingPreflightForTerminalAbort: () => {},
						abortPromptAndWaitWithTerminal: async () => ({ status: "settled" }),
					},
				}
			: {}),
		createTransport: async ({ sessionId: id, stateRoot, token }) => ({
			sessionId: id,
			stateRoot,
			token,
			onFrame(handler) {
				receive = handler;
				return () => {
					if (receive === handler) receive = undefined;
				};
			},
			sendFrame(connectionId, frame) {
				sent.push({ connectionId, frame });
				const response = frame as ControlResponse & { id?: unknown };
				if (typeof response.id === "string") waiters.get(response.id)?.(response);
				return "written" as const;
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
		sdkBindings: () => [],
		isIdle: () => idle,
		abort: () => {},
		onSessionEvent:
			harnessOptions.onSessionEvent ??
			((listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			}),
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(cwd, ".gjc", "state", `${sessionId}.jsonl`),
			getSessionName: () => undefined,
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({}, ctx);
	return {
		control: (operation, input, connectionId = "client") => {
			const id = `frame-${nextId++}`;
			const { promise, resolve } = Promise.withResolvers<ControlResponse>();
			waiters.set(id, resolve);
			receive?.(connectionId, { type: "control_request", operation, input, id });
			return promise;
		},
		emit: async (event, payload = {}) => {
			for (const listener of listeners) listener(payload as AgentSessionEvent);
			await handlers.get(event)?.(payload, ctx);
		},
		clearFrames: () => {
			sent.length = 0;
			broadcasts.length = 0;
		},
		setIdle: value => {
			idle = value;
		},
		promoteQueued: () => {
			for (const promote of deferredPromotions.splice(0)) promote();
		},
		sent,
		broadcasts,
		stop: async () => {
			await handlers.get("session_shutdown")?.({}, ctx);
		},
	};
}

describe("streamed turn frames", () => {
	test("carry the nested event key the ACP receiver keys on", () => {
		// `receivedSdkEvent` sets its wire payload only when `payload.event` is an
		// object; without it the frame arrives and produces no session update.
		for (const event of [textDelta("hi"), thinkingDelta("mm"), toolStart(), toolEnd()]) {
			const frame = streamedFrame(event, CORRELATION);
			expect(frame.type).toBe("event");
			expect(frame.kind).toBe(event.type);
			expect(frame.payload.event).toBeDefined();
			expect(frame.payload.event_type).toBeDefined();
		}
	});

	test("carry the submitting invocation's correlation so the client can attribute them", () => {
		const frame = streamedFrame(textDelta("hi"), CORRELATION);
		expect(frame.commandId).toBe(CORRELATION.commandId);
		expect(frame.turnId).toBe(CORRELATION.turnId);
	});

	test("assistant text becomes an agent message chunk", () => {
		const updates = mapAgentWireEventPayloadToAcpSessionUpdates(
			streamedFrame(textDelta("STREAM-OK"), CORRELATION).payload,
			SESSION_ID,
		);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.update).toMatchObject({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "STREAM-OK" },
		});
		expect(updates[0]?.sessionId).toBe(SESSION_ID);
	});

	test("thinking becomes a thought chunk, not message text", () => {
		const updates = mapAgentWireEventPayloadToAcpSessionUpdates(
			streamedFrame(thinkingDelta("planning"), CORRELATION).payload,
			SESSION_ID,
		);
		expect(updates[0]?.update).toMatchObject({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "planning" },
		});
	});

	test("a tool call opens and then completes", () => {
		const started = mapAgentWireEventPayloadToAcpSessionUpdates(
			streamedFrame(toolStart(), CORRELATION).payload,
			SESSION_ID,
		);
		expect(started[0]?.update).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "call_1" });

		const ended = mapAgentWireEventPayloadToAcpSessionUpdates(
			streamedFrame(toolEnd(), CORRELATION).payload,
			SESSION_ID,
		);
		expect(ended[0]?.update).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "call_1",
			status: "completed",
		});
	});

	test("a non-assistant message produces no client update", () => {
		// The host echoes the user prompt and tool results through the same event,
		// and mirroring those back would duplicate the client's own transcript.
		const userMessage = {
			type: "message_update",
			message: { role: "user", content: [{ type: "text", text: "prompt" }] },
			assistantMessageEvent: { type: "text_delta", delta: "prompt", contentIndex: 0 },
		} as unknown as AgentSessionEvent;
		expect(
			mapAgentWireEventPayloadToAcpSessionUpdates(streamedFrame(userMessage, CORRELATION).payload, SESSION_ID),
		).toHaveLength(0);
	});
});

describe("SDK host turn streaming", () => {
	test("preserves producer order while a message_update extension handler is blocked", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-order-"));
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory(cwd);
		const extensionRuntime = new ExtensionRuntime();
		const eventBus = new EventBus();
		let harness: HostHarness | undefined;
		const extension = await loadExtensionFromFactory(
			api => {
				api.on("message_update", async event => {
					entered.resolve();
					await gate.promise;
					await harness?.emit("message_update", event);
				});
				api.on("message_end", event => harness?.emit("message_end", event));
				api.on("tool_execution_start", event => harness?.emit("tool_execution_start", event));
				api.on("tool_execution_update", event => harness?.emit("tool_execution_update", event));
				api.on("tool_execution_end", event => harness?.emit("tool_execution_end", event));
			},
			cwd,
			eventBus,
			extensionRuntime,
		);
		const mock = createMockModel({
			responses: [
				{ content: ["hello", " world", { type: "toolCall", id: "call_1", name: "read", arguments: {} }] },
				{ content: [] },
			],
		});
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: mock.model, tools: [], messages: [] }, streamFn: mock.stream }),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], extensionRuntime, cwd, sessionManager, modelRegistry),
		});
		const produced: AgentSessionEvent[] = [];
		const kinds = new Set([
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]);
		session.subscribe(event => {
			if (kinds.has(event.type)) produced.push(event);
		});
		harness = await createHostHarness(SESSION_ID, cwd, { onSessionEvent: listener => session.subscribe(listener) });
		let prompt: Promise<void> | undefined;
		try {
			await harness.control("turn.prompt", { text: "stream this" });
			await harness.emit("agent_start");
			harness.clearFrames();
			prompt = session.prompt("stream this");
			await entered.promise;
			await waitFor(
				() => produced.some(event => event.type === "tool_execution_start"),
				"tool start while extension is blocked",
			);
			const frames = () =>
				harness!.sent.filter(entry => entry.frame.type === "event" && kinds.has(String(entry.frame.kind)));
			expect(frames().map(entry => entry.frame.kind)).toEqual(produced.map(event => event.type));
			const final = produced.find(event => event.type === "message_end" && event.message.role === "assistant");
			expect(final).toMatchObject({
				message: {
					content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }, { type: "toolCall" }],
				},
			});
			gate.resolve();
			await prompt;
			expect(frames().map(entry => entry.frame.payload)).toEqual(produced.map(toAgentWireEventPayload));
			const textEvents = produced.flatMap(event =>
				event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
					? [event.assistantMessageEvent.delta]
					: [],
			);
			expect(textEvents.join("")).toBe("hello world");
			const finalIndex = produced.indexOf(final!);
			expect(finalIndex).toBeGreaterThan(produced.findIndex(event => event.type === "message_update"));
			expect(produced.findIndex(event => event.type === "tool_execution_start")).toBeGreaterThan(finalIndex);
			expect(frames().every(entry => entry.connectionId === "client")).toBe(true);
			expect(harness.broadcasts.filter(frame => kinds.has(String(frame.kind)))).toEqual([]);
		} finally {
			gate.resolve();
			await prompt?.catch(() => {});
			await harness.stop();
			await session.dispose();
			authStorage.close();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("holds content observed before the correlated agent_start reaches the wire", async () => {
		// The session subscription is synchronous while emitLifecycle("agent_start")
		// awaits durable persistence before publishing the start frame. Content
		// produced in that window must still follow the start on the wire.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-start-order-"));
		const inner = createReconciliationStore({ sessionFile: path.join(cwd, "session.jsonl"), sessionId: SESSION_ID });
		const startGate = Promise.withResolvers<void>();
		const startEntered = Promise.withResolvers<void>();
		let holdNextTransact = false;
		const slowStore: ReconciliationStore = {
			...inner,
			transact: async mutator => {
				if (holdNextTransact) {
					holdNextTransact = false;
					startEntered.resolve();
					await startGate.promise;
				}
				return inner.transact(mutator);
			},
		};
		const harness = await createHostHarness(SESSION_ID, cwd, { reconciliationStore: slowStore });
		try {
			await harness.control("turn.prompt", { text: "delayed start" });
			harness.clearFrames();
			holdNextTransact = true;
			const start = harness.emit("agent_start");
			await startEntered.promise;
			// Producer emits content while the start transition is still persisting.
			await harness.emit("message_update", textDelta("early"));
			await harness.emit("tool_execution_start", toolStart());
			const contentKinds = () =>
				harness.sent.filter(entry => entry.frame.type === "event").map(entry => String(entry.frame.kind));
			expect(contentKinds()).toEqual([]);
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_start")).toEqual([]);
			startGate.resolve();
			await start;
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_start")).toHaveLength(1);
			expect(contentKinds()).toEqual(["message_update", "tool_execution_start"]);
			// Content after the start is published immediately, in order.
			await harness.emit("message_update", textDelta(" late"));
			expect(contentKinds()).toEqual(["message_update", "tool_execution_start", "message_update"]);
			const deltas = harness.sent
				.filter(entry => entry.frame.type === "event" && entry.frame.kind === "message_update")
				.map(
					entry =>
						(entry.frame.payload as { event: { assistantMessageEvent: { delta: string } } }).event
							.assistantMessageEvent.delta,
				);
			expect(deltas).toEqual(["early", " late"]);
		} finally {
			startGate.resolve();
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("does not release pre-attachment content to an owner attached while the start was held", async () => {
		// Recipients are snapshotted when content is held. A second SDK prompt
		// attached during the slow start transaction owns the run from then on,
		// but must not receive deltas produced before it attached.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-held-attach-"));
		const inner = createReconciliationStore({ sessionFile: path.join(cwd, "session.jsonl"), sessionId: SESSION_ID });
		const startGate = Promise.withResolvers<void>();
		const startEntered = Promise.withResolvers<void>();
		let holdNextTransact = false;
		const slowStore: ReconciliationStore = {
			...inner,
			transact: async mutator => {
				if (holdNextTransact) {
					holdNextTransact = false;
					startEntered.resolve();
					await startGate.promise;
				}
				return inner.transact(mutator);
			},
		};
		const harness = await createHostHarness(SESSION_ID, cwd, {
			reconciliationStore: slowStore,
			deferPromotion: true,
		});
		try {
			const root = await harness.control("turn.prompt", { text: "root" }, "root-client");
			expect(root.ok).toBe(true);
			// A second prompt is accepted while the session is busy: it is queued as
			// steering and only attaches to the run when the producer consumes it.
			harness.setIdle(false);
			const attached = await harness.control("turn.prompt", { text: "attached" }, "attached-client");
			expect(attached.ok).toBe(true);
			harness.clearFrames();
			holdNextTransact = true;
			const start = harness.emit("agent_start");
			await startEntered.promise;
			await harness.emit("message_update", textDelta("before-attach"));
			// The queued prompt is consumed (attached) while the start is still held.
			harness.promoteQueued();
			await harness.emit("message_update", textDelta("after-attach"));
			startGate.resolve();
			await start;
			const delivered = harness.sent
				.filter(entry => entry.frame.type === "event" && entry.frame.kind === "message_update")
				.map(entry => ({
					to: entry.connectionId,
					commandId: entry.frame.commandId,
					delta: (entry.frame.payload as { event: { assistantMessageEvent: { delta: string } } }).event
						.assistantMessageEvent.delta,
				}));
			expect(delivered).toEqual([
				{ to: "root-client", commandId: root.result?.commandId, delta: "before-attach" },
				{ to: "root-client", commandId: root.result?.commandId, delta: "after-attach" },
				{ to: "attached-client", commandId: attached.result?.commandId, delta: "after-attach" },
			]);
		} finally {
			startGate.resolve();
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("bounds held content by dropping the oldest, never publishing before the start", async () => {
		// A wedged reconciliation write must not let the host buffer an entire
		// response, and must not invert the start/content boundary either. Past the
		// bound the oldest held content is dropped (one warning); nothing reaches
		// the wire until the correlated agent_start does.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-held-bound-"));
		const inner = createReconciliationStore({ sessionFile: path.join(cwd, "session.jsonl"), sessionId: SESSION_ID });
		const startGate = Promise.withResolvers<void>();
		const startEntered = Promise.withResolvers<void>();
		let holdNextTransact = false;
		const slowStore: ReconciliationStore = {
			...inner,
			transact: async mutator => {
				if (holdNextTransact) {
					holdNextTransact = false;
					startEntered.resolve();
					await startGate.promise;
				}
				return inner.transact(mutator);
			},
		};
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const releaseWarnings = () =>
			warn.mock.calls.filter(call => String(call[0]).includes("dropping oldest held turn content"));
		const harness = await createHostHarness(SESSION_ID, cwd, { reconciliationStore: slowStore });
		const contentFrames = () => harness.sent.filter(entry => entry.frame.type === "event");
		const deltas = () =>
			harness.sent
				.filter(entry => entry.frame.type === "event" && entry.frame.kind === "message_update")
				.map(
					entry =>
						(entry.frame.payload as { event: { assistantMessageEvent: { delta: string } } }).event
							.assistantMessageEvent.delta,
				);
		try {
			await harness.control("turn.prompt", { text: "long answer" });
			harness.clearFrames();
			holdNextTransact = true;
			const start = harness.emit("agent_start");
			await startEntered.promise;
			const bound = 256;
			const overflow = 40;
			for (let index = 0; index < bound; index++) await harness.emit("message_update", textDelta(`d${index}`));
			expect(contentFrames()).toHaveLength(0);
			expect(releaseWarnings()).toHaveLength(0);
			for (let index = bound; index < bound + overflow; index++)
				await harness.emit("message_update", textDelta(`d${index}`));
			// Still nothing on the wire: the start has not been published.
			expect(contentFrames()).toHaveLength(0);
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_start")).toHaveLength(0);
			expect(releaseWarnings()).toHaveLength(1);
			startGate.resolve();
			await start;
			expect(harness.broadcasts.filter(frame => frame.kind === "agent_start")).toHaveLength(1);
			// Only the newest `bound` events survive, in producer order.
			expect(deltas()).toEqual(Array.from({ length: bound }, (_, index) => `d${index + overflow}`));
			// Content after the start streams directly.
			await harness.emit("message_update", textDelta("direct"));
			expect(deltas().at(-1)).toBe("direct");
			expect(deltas()).toHaveLength(bound + 1);
			expect(releaseWarnings()).toHaveLength(1);
		} finally {
			warn.mockRestore();
			startGate.resolve();
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("sends one message update only to the accepted prompt owner", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-owner-"));
		const harness = await createHostHarness(SESSION_ID, cwd);
		try {
			const accepted = await harness.control("turn.prompt", { text: "stream this" });
			expect(accepted.ok).toBe(true);
			await harness.emit("agent_start");
			harness.clearFrames();

			const event = textDelta("delivered");
			await harness.emit("message_update", event);

			expect(harness.sent).toEqual([
				{
					connectionId: "client",
					frame: {
						type: "event",
						kind: "message_update",
						payload: { event_type: "message_update", event },
						commandId: accepted.result?.commandId,
						turnId: accepted.result?.turnId,
					},
				},
			]);
			expect(harness.broadcasts.filter(frame => frame.kind === "message_update")).toHaveLength(0);
		} finally {
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("does not stream an SDK-unowned turn", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-unowned-"));
		const harness = await createHostHarness(SESSION_ID, cwd);
		try {
			await harness.emit("agent_start");
			harness.clearFrames();

			await harness.emit("message_update", textDelta("private"));

			expect(harness.sent).toHaveLength(0);
			expect(harness.broadcasts).toHaveLength(0);
		} finally {
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("streams a shared in-run prompt only to both submitting connections", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-shared-"));
		const harness = await createHostHarness(SESSION_ID, cwd);
		try {
			const root = await harness.control("turn.prompt", { text: "root" }, "root-client");
			expect(root.ok).toBe(true);
			await harness.emit("agent_start");
			harness.setIdle(false);
			const attached = await harness.control("turn.prompt", { text: "attached" }, "attached-client");
			expect(attached.ok).toBe(true);
			harness.clearFrames();

			const event = textDelta("shared");
			await harness.emit("message_update", event);

			expect(harness.sent).toEqual([
				{
					connectionId: "root-client",
					frame: expect.objectContaining({
						kind: "message_update",
						commandId: root.result?.commandId,
						turnId: root.result?.turnId,
					}),
				},
				{
					connectionId: "attached-client",
					frame: expect.objectContaining({
						kind: "message_update",
						commandId: attached.result?.commandId,
						turnId: attached.result?.turnId,
					}),
				},
			]);
		} finally {
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("keeps independently pending prompt streams bound to their own sdk run tokens", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-token-isolation-"));
		const harness = await createHostHarness(SESSION_ID, cwd);
		try {
			const first = await harness.control("turn.prompt", { text: "first" }, "first-client");
			const second = await harness.control("turn.prompt", { text: "second" }, "second-client");
			const firstToken = `${first.result?.commandId}:${first.result?.turnId}`;
			const secondToken = `${second.result?.commandId}:${second.result?.turnId}`;

			await harness.emit("agent_start", { sdkRunToken: firstToken });
			harness.clearFrames();
			await harness.emit("message_update", textDelta("first-only"));
			expect(harness.sent.map(frame => frame.connectionId)).toEqual(["first-client"]);
			await harness.emit("agent_end", { sdkRunToken: firstToken, stopReason: "completed" });
			const firstTerminals = harness.broadcasts.filter(
				frame =>
					frame.kind === "agent_end" &&
					(frame.payload as { commandId?: unknown } | undefined)?.commandId === first.result?.commandId,
			);
			expect(firstTerminals).toHaveLength(1);
			expect((firstTerminals[0]?.payload as { outcome?: unknown } | undefined)?.outcome).toMatchObject({
				kind: "failed",
				code: "prompt_failed",
			});

			await harness.emit("agent_start", { sdkRunToken: secondToken });
			harness.clearFrames();
			await harness.emit("message_update", textDelta("second-only"));
			expect(harness.sent.map(frame => frame.connectionId)).toEqual(["second-client"]);
			await harness.emit("agent_end", { sdkRunToken: secondToken, stopReason: "completed" });
		} finally {
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("streams a tokenless shared batch to every accepted owner", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-tokenless-"));
		const harness = await createHostHarness(SESSION_ID, cwd);
		try {
			const first = await harness.control("turn.prompt", { text: "first" }, "first-client");
			const second = await harness.control("turn.prompt", { text: "second" }, "second-client");
			await harness.emit("agent_start");
			harness.clearFrames();
			await harness.emit("message_update", textDelta("shared"));
			expect(harness.sent.map(frame => frame.connectionId)).toEqual(["first-client", "second-client"]);
			await harness.emit("agent_end", { stopReason: "completed" });
			for (const accepted of [first, second]) {
				expect(
					harness.broadcasts.some(
						frame =>
							frame.kind === "agent_end" &&
							(frame.payload as { commandId?: unknown } | undefined)?.commandId === accepted.result?.commandId,
					),
				).toBe(true);
			}
		} finally {
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("attributes an out-of-order token terminal to its matching batch", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-out-of-order-"));
		const harness = await createHostHarness(SESSION_ID, cwd);
		try {
			const first = await harness.control("turn.prompt", { text: "first" }, "first-client");
			const second = await harness.control("turn.prompt", { text: "second" }, "second-client");
			const firstToken = `${first.result?.commandId}:${first.result?.turnId}`;
			const secondToken = `${second.result?.commandId}:${second.result?.turnId}`;
			await harness.emit("agent_start", { sdkRunToken: firstToken });
			await harness.emit("agent_start", { sdkRunToken: secondToken });
			harness.clearFrames();

			await harness.emit("agent_end", { sdkRunToken: secondToken, stopReason: "completed" });
			expect(
				harness.broadcasts.some(
					frame =>
						frame.kind === "agent_end" &&
						(frame.payload as { commandId?: unknown } | undefined)?.commandId === second.result?.commandId,
				),
			).toBe(true);
			expect(
				harness.broadcasts.some(
					frame =>
						frame.kind === "agent_end" &&
						(frame.payload as { commandId?: unknown } | undefined)?.commandId === first.result?.commandId,
				),
			).toBe(false);
			await harness.emit("agent_end", { sdkRunToken: firstToken, stopReason: "completed" });
		} finally {
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("preserves stream ownership across a continuation start with the same token", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-continuation-"));
		const harness = await createHostHarness(SESSION_ID, cwd);
		try {
			const accepted = await harness.control("turn.prompt", { text: "continue" }, "owner-client");
			const token = `${accepted.result?.commandId}:${accepted.result?.turnId}`;
			await harness.emit("agent_start", { sdkRunToken: token });
			await harness.emit("agent_start", { sdkRunToken: token });
			harness.clearFrames();
			await harness.emit("message_update", textDelta("still-owned"));
			expect(harness.sent.map(frame => frame.connectionId)).toEqual(["owner-client"]);
		} finally {
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("publishes one failed terminal when accepted work resolves without lifecycle evidence", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-no-start-"));
		const harness = await createHostHarness(SESSION_ID, cwd, { settleSubmission: "resolve" });
		try {
			const accepted = await harness.control("turn.prompt", { text: "no lifecycle" });
			expect(accepted.ok).toBe(true);
			await waitFor(
				() =>
					harness.broadcasts.some(
						frame =>
							frame.kind === "agent_end" &&
							(frame.payload as { commandId?: unknown } | undefined)?.commandId === accepted.result?.commandId,
					),
				"synthetic failed terminal publication",
			);
			const terminals = harness.broadcasts.filter(
				frame =>
					frame.kind === "agent_end" &&
					(frame.payload as { commandId?: unknown } | undefined)?.commandId === accepted.result?.commandId,
			);
			expect(terminals).toHaveLength(1);
			expect((terminals[0]?.payload as { outcome?: unknown } | undefined)?.outcome).toMatchObject({
				kind: "failed",
				code: "prompt_failed",
			});
		} finally {
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("ignores malformed legacy tool progress", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stream-malformed-"));
		const harness = await createHostHarness(SESSION_ID, cwd);
		try {
			const accepted = await harness.control("turn.prompt", { text: "guard progress" });
			expect(accepted.ok).toBe(true);
			await harness.emit("agent_start");
			harness.clearFrames();

			await expect(harness.emit("tool_execution_start")).resolves.toBeUndefined();

			expect(harness.sent).toHaveLength(0);
			expect(harness.broadcasts).toHaveLength(0);
		} finally {
			await harness.stop();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
