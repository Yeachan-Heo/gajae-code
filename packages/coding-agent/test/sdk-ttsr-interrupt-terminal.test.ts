import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentOptions, type AgentTool } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Model, type ToolCall } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { z } from "zod";
import type { Rule } from "../src/capability/rule";
import { Settings } from "../src/config/settings";
import { TtsrManager } from "../src/export/ttsr";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "../src/extensibility/extensions";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";
import type { SdkFrame } from "../src/sdk/host/types";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { testBrokerDiscovery } from "./sdk-test-broker-discovery";

/**
 * An SDK-submitted turn that hits an interrupting TTSR rule is aborted and
 * resumed by the session itself (#8094). The resume continues the same SDK
 * prompt, so the prompt settles with the resumed run's outcome, not as a
 * client cancel recorded at the interrupt.
 */

function rule(partial: Partial<Rule> = {}): Rule {
	return {
		name: "no-danger",
		path: "/tmp/no-danger.md",
		content: "TTSR-SDK-REMINDER: never pass --danger.",
		condition: ["--danger"],
		scope: ["tool:probe"],
		interruptMode: "tool-only",
		repeatMode: "once",
		_source: { provider: "test", providerName: "test", path: "/tmp/no-danger.md", level: "project" },
		...partial,
	};
}

const otherRule = rule({
	name: "no-other",
	path: "/tmp/no-other.md",
	content: "TTSR-SDK-OTHER: never pass --other.",
	condition: ["--other"],
});

function assistant(model: Model, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} satisfies AssistantMessage;
}

function toolCallStream(model: Model, call: ToolCall, argDeltas: string[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistant(model, [call], "toolUse");
		stream.push({ type: "start", partial: message });
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
		for (const delta of argDeltas) stream.push({ type: "toolcall_delta", contentIndex: 0, delta, partial: message });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
		stream.push({ type: "done", reason: "toolUse", message });
		stream.end();
	});
	return stream;
}

function textStream(model: Model, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistant(model, [{ type: "text", text }], "stop");
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

/** A stream that stays open until its request is aborted. */
function hangingStream(
	model: Model,
	signal: AbortSignal | undefined,
	started: () => void,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial = assistant(model, [{ type: "text", text: "working" }], "stop");
		stream.push({ type: "start", partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "working", partial });
		started();
		const finish = () => {
			stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } });
			stream.end();
		};
		if (signal?.aborted) finish();
		else signal?.addEventListener("abort", finish, { once: true });
	});
	return stream;
}

type Scripted = { call: ToolCall; deltas: string[] } | { text: string } | { hang: true };

const blockedCall: ToolCall = {
	type: "toolCall",
	id: "call-blocked",
	name: "probe",
	arguments: { command: "run --danger now" },
};
const blocked: Scripted = { call: blockedCall, deltas: ['{"command":"run', " --danger", " a", " b", " c", ' now"}'] };
const otherCall: ToolCall = { type: "toolCall", id: "call-other", name: "probe", arguments: { command: "x --other" } };
const other: Scripted = { call: otherCall, deltas: ['{"command":"x', " --other", '"}'] };
const safeCall: ToolCall = { type: "toolCall", id: "call-safe", name: "probe", arguments: { command: "run safe" } };
const safe: Scripted = { call: safeCall, deltas: ['{"command":"run', " safe", '"}'] };

type Harness = Awaited<ReturnType<typeof createHarness>>;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createHarness(turns: Scripted[], rules: Rule[]) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-ttsr-"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic test model");
	const executed: unknown[] = [];
	const probe: AgentTool = {
		name: "probe",
		label: "Probe",
		description: "probe",
		parameters: z.object({ command: z.string() }),
		async execute(_toolCallId, args) {
			executed.push(args);
			return { content: [{ type: "text" as const, text: "probe ok" }] };
		},
	};
	let streamCalls = 0;
	const hangStarted = Promise.withResolvers<void>();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [probe], messages: [] },
		convertToLlm,
		streamFn: ((m, _context, options) => {
			const scripted = turns[streamCalls++] ?? { text: "Done" };
			if ("hang" in scripted) return hangingStream(m, options?.signal, () => hangStarted.resolve());
			return "call" in scripted ? toolCallStream(m, scripted.call, scripted.deltas) : textStream(m, scripted.text);
		}) satisfies AgentOptions["streamFn"],
	});
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.reminders": false });
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const ttsrManager = new TtsrManager({ interruptMode: "always", contextMode: "keep" });
	for (const entry of rules) ttsrManager.addRule(entry);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const frames: Array<{ connectionId: string; frame: SdkFrame }> = [];
	let receive: ((connectionId: string, frame: SdkFrame) => void) | undefined;
	let ctx: ExtensionContext;
	const sessionManager = SessionManager.inMemory(cwd);
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		ttsrManager,
		toolRegistry: new Map([[probe.name, probe]]),
		modelRegistry: {
			getApiKey: async () => "test-key",
			getAuthStorageOwner: () => undefined,
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
		} as never,
		extensionRunner: {
			hasHandlers: () => true,
			emitBeforeAgentStart: async () => undefined,
			emit: async (event: ExtensionEvent) => handlers.get(event.type)?.(event, ctx),
		} as never,
	});
	const sessionEvents: AgentSessionEvent[] = [];
	session.subscribe(event => sessionEvents.push(event));
	const api = {
		on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
		sendUserMessage: async (content: string, options: Parameters<AgentSession["sendUserMessage"]>[1]) =>
			session.sendUserMessage(content, options),
	} as unknown as ExtensionAPI;
	createSdkSessionRuntimeExtension(api, {
		agentDir: cwd,
		ensureBrokerImpl: async () => testBrokerDiscovery,
		settings,
		createTransport: async ({ sessionId, stateRoot, token }) => ({
			sessionId,
			stateRoot,
			token,
			onFrame: handler => {
				receive = handler;
				return () => {
					receive = undefined;
				};
			},
			sendFrame: (connectionId, frame) => {
				frames.push({ connectionId, frame });
				return "written" as const;
			},
			broadcastFrame: frame => {
				frames.push({ connectionId: "broadcast", frame });
			},
			start: async () => ({ url: "ws://127.0.0.1:1" }),
			stop: async () => {},
		}),
	});
	ctx = {
		cwd,
		sessionManager,
		isIdle: () => !agent.state.isStreaming,
		abort: () => session.abort(),
		sdkBindings: () => [],
		onSessionEvent: (listener: (event: AgentSessionEvent) => void) => session.subscribe(listener),
	} as unknown as ExtensionContext;
	const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 10_000) => {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
			await Bun.sleep(5);
		}
	};
	let requestSeq = 0;
	const request = async (frame: Record<string, unknown>) => {
		const id = `req-${++requestSeq}`;
		receive?.("client", { ...frame, id } as unknown as SdkFrame);
		await waitFor(() => frames.some(({ frame: f }) => "id" in f && f.id === id), `response ${id}`);
		return frames.find(({ frame: f }) => "id" in f && f.id === id)?.frame as unknown as {
			ok: boolean;
			result?: Record<string, unknown>;
		};
	};
	cleanups.push(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
		await session.dispose().catch(() => {});
		await fs.rm(cwd, { recursive: true, force: true });
	});
	await handlers.get("session_start")?.({}, ctx);

	const submit = async (text: string) => {
		const response = await request({ type: "control_request", operation: "turn.prompt", input: { text } });
		expect(response).toMatchObject({ ok: true });
		return { commandId: String(response.result?.commandId), turnId: String(response.result?.turnId) };
	};
	/** Poll until the prompt leaves in_flight; fail on a leak instead of hanging. */
	const settledStatus = async (ids: { commandId: string; turnId: string }, timeoutMs = 10_000) => {
		const deadline = Date.now() + timeoutMs;
		let status: Record<string, unknown> | undefined;
		while (Date.now() < deadline) {
			status = (
				await request({ type: "query_request", query: "turn.prompt_status", input: { kind: "prompt", ...ids } })
			).result;
			if (status?.status !== "in_flight") return status;
			await Bun.sleep(10);
		}
		throw new Error(`SDK prompt still in_flight: ${JSON.stringify(status)}`);
	};
	const correlated = (kind: string, ids: { commandId: string }) =>
		frames.filter(({ frame }) => {
			if (frame.type !== "event" || frame.kind !== kind) return false;
			const payload = (frame as unknown as { payload?: { commandId?: unknown } }).payload;
			return payload?.commandId === ids.commandId;
		});
	const ttsrTriggers = () =>
		sessionEvents.flatMap(event => (event.type === "ttsr_triggered" ? [event.rules.map(entry => entry.name)] : []));
	const assistantStops = () =>
		sessionEvents.flatMap(event =>
			event.type === "message_end" && event.message.role === "assistant"
				? [(event.message as AssistantMessage).stopReason]
				: [],
		);
	const settleAgent = async () => {
		await waitFor(() => !session.isStreaming && !session.isTtsrAbortPending, "settled session");
		await session.waitForIdle();
	};
	return {
		session,
		sessionManager,
		executed,
		hangStarted: hangStarted.promise,
		streamCalls: () => streamCalls,
		waitFor,
		request,
		submit,
		settledStatus,
		correlated,
		ttsrTriggers,
		assistantStops,
		settleAgent,
	};
}

async function expectCompleted(h: Harness, ids: { commandId: string; turnId: string }, text: string) {
	await h.waitFor(() => h.assistantStops().at(-1) === "stop", "final assistant stop");
	await h.settleAgent();
	expect(await h.settledStatus(ids)).toMatchObject({
		status: "terminal_ok",
		receiptState: "present",
		outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		content: { text },
	});
	// One owned lifecycle pair: the resume continues the prompt's run instead of ending it.
	expect(h.correlated("agent_start", ids)).toHaveLength(1);
	expect(h.correlated("agent_end", ids)).toHaveLength(1);
	expect(h.correlated("agent_end", ids)[0]?.frame).toMatchObject({
		payload: { outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" } },
	});
}

test("an SDK turn interrupted once by a tool-only TTSR rule settles completed with the resumed answer", async () => {
	const h = await createHarness([blocked, safe, { text: "All done." }], [rule()]);
	const ids = await h.submit("run the probe");
	await expectCompleted(h, ids, "All done.");
	expect(h.ttsrTriggers()).toEqual([["no-danger"]]);
	expect(h.assistantStops()).toEqual(["aborted", "toolUse", "stop"]);
	// The interrupted call never ran.
	expect(h.executed).not.toContainEqual({ command: "run --danger now" });
}, 30_000);

test("a non-interrupting TTSR rule keeps settling the SDK turn completed", async () => {
	const h = await createHarness([blocked, { text: "All done." }], [rule({ interruptMode: "never" })]);
	const ids = await h.submit("run the probe");
	await expectCompleted(h, ids, "All done.");
	expect(h.ttsrTriggers()).toEqual([["no-danger"]]);
	expect(h.assistantStops()).toEqual(["toolUse", "stop"]);
}, 30_000);

test("a second TTSR interrupt on the resumed stream still settles the SDK turn completed", async () => {
	const h = await createHarness([blocked, other, safe, { text: "Both handled." }], [rule(), otherRule]);
	const ids = await h.submit("run the probe twice");
	await expectCompleted(h, ids, "Both handled.");
	expect(h.ttsrTriggers()).toEqual([["no-danger"], ["no-other"]]);
	expect(h.assistantStops()).toEqual(["aborted", "aborted", "toolUse", "stop"]);
	expect(h.executed).not.toContainEqual({ command: "run --danger now" });
	expect(h.executed).not.toContainEqual({ command: "x --other" });
}, 30_000);

test("a client abort during the TTSR resume ends the SDK turn cancelled without hanging", async () => {
	const h = await createHarness([blocked, { hang: true }], [rule()]);
	const ids = await h.submit("run the probe");
	// The resumed run is streaming when the client cancels.
	await h.hangStarted;
	expect(h.streamCalls()).toBe(2);
	expect(await h.request({ type: "control_request", operation: "turn.abort", input: {} })).toMatchObject({ ok: true });
	await h.settleAgent();
	expect(await h.settledStatus(ids)).toMatchObject({
		status: "terminal_ok",
		outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
	});
	expect(h.correlated("agent_start", ids)).toHaveLength(1);
	expect(h.correlated("agent_end", ids)).toHaveLength(1);
	expect(h.assistantStops()).toEqual(["aborted", "aborted"]);
}, 30_000);

test("a client abort before the TTSR resume starts publishes the interrupted terminal", async () => {
	const h = await createHarness([blocked, { text: "never streamed" }], [rule()]);
	const ids = await h.submit("run the probe");
	// Abort inside the resume's scheduling delay, after the interrupted run ended.
	await h.waitFor(() => h.assistantStops().length === 1 && !h.session.isStreaming, "interrupted run ended");
	expect(h.session.isTtsrAbortPending).toBe(true);
	expect(await h.request({ type: "control_request", operation: "turn.abort", input: {} })).toMatchObject({ ok: true });
	await h.settleAgent();
	expect(await h.settledStatus(ids)).toMatchObject({
		status: "terminal_ok",
		outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
	});
	expect(h.correlated("agent_end", ids)).toHaveLength(1);
	expect(h.streamCalls()).toBe(1);
}, 30_000);

test("a TTSR resume whose continuation fails to start publishes the interrupted terminal", async () => {
	const h = await createHarness([blocked, { text: "never streamed" }], [rule()]);
	const refused = spyOn(h.session.agent, "continue").mockImplementationOnce(() =>
		Promise.reject(new Error("continue refused")),
	);
	const ids = await h.submit("run the probe");
	await h.waitFor(() => refused.mock.calls.length === 1, "refused resume");
	await h.settleAgent();
	expect(await h.settledStatus(ids)).toMatchObject({
		status: "terminal_ok",
		outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
	});
	expect(h.correlated("agent_end", ids)).toHaveLength(1);
	expect(h.streamCalls()).toBe(1);
}, 30_000);

test("a TTSR resume that throws after publishing its reminder settles the SDK turn and clears the interrupt", async () => {
	const h = await createHarness([blocked, { text: "next turn answer" }], [rule()]);
	const marker = spyOn(h.sessionManager, "appendTtsrInjection").mockImplementation(() => {
		throw new Error("marker append failed");
	});
	const ids = await h.submit("run the probe");
	await h.waitFor(() => marker.mock.calls.length > 0, "marker append attempt");
	// The resume threw after the reminder was published: the held terminal still publishes.
	expect(await h.settledStatus(ids)).toMatchObject({
		status: "terminal_ok",
		outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
	});
	expect(h.correlated("agent_end", ids)).toHaveLength(1);
	expect(h.session.isTtsrAbortPending).toBe(false);
	// The interrupt is not left pending, so the next SDK turn settles on its own.
	marker.mockRestore();
	const next = await h.submit("continue");
	expect(await h.settledStatus(next)).toMatchObject({
		status: "terminal_ok",
		outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		content: { text: "next turn answer" },
	});
}, 30_000);

test("a TTSR resume stopped by an uncertain reminder publication still settles the SDK turn", async () => {
	const h = await createHarness([blocked, { text: "never streamed" }], [rule()]);
	const append = h.sessionManager.appendCustomMessageEntry.bind(h.sessionManager);
	spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementation((...args: Parameters<typeof append>) => {
		if (args[0] === "ttsr-injection") throw new Error("disk unavailable");
		return append(...args);
	});
	const ids = await h.submit("run the probe");
	// The unclassified failure stops the retry and closes the session; the held terminal must still publish.
	expect(await h.settledStatus(ids)).toMatchObject({
		status: "terminal_ok",
		outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
	});
	expect(h.correlated("agent_end", ids)).toHaveLength(1);
	expect(h.streamCalls()).toBe(1);
}, 30_000);
