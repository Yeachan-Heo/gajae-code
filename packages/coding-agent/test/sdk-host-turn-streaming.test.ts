import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { mapAgentWireEventPayloadToAcpSessionUpdates } from "../src/modes/acp/acp-event-mapper";
import { toAgentWireEventPayload } from "../src/modes/shared/agent-wire/event-envelope";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";
import type { SdkFrame } from "../src/sdk/host/types";
import type { AgentSessionEvent } from "../src/session/agent-session";

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
	harnessOptions: { settleSubmission?: "never" | "resolve" } = {},
): Promise<HostHarness> {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const waiters = new Map<string, (frame: ControlResponse) => void>();
	const sent: Array<{ connectionId: string; frame: SdkFrame }> = [];
	const broadcasts: SdkFrame[] = [];
	let receive: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	let nextId = 0;
	let idle = true;
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
			if (!idle) options?.onQueuedPromoted?.({ startsOwnRun: false });
			if (harnessOptions.settleSubmission === "resolve") return;
			return await new Promise<never>(() => {});
		},
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		agentDir: path.join(cwd, ".gjc", "agent"),
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
			await handlers.get(event)?.(payload, ctx);
		},
		clearFrames: () => {
			sent.length = 0;
			broadcasts.length = 0;
		},
		setIdle: value => {
			idle = value;
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
