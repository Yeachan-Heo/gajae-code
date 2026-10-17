import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NotificationServer } from "@gajae-code/natives";
import type { ExtensionAPI } from "../src/extensibility/extensions";
import { createNotificationsExtension } from "../src/sdk/bus";
import {
	cleanupFixtureRoots,
	createNotificationFixtureRoot,
	type FixtureRootCleanup,
	isolatedNotificationSettings,
	registerNotificationRuntime,
} from "./helpers/notification-settings";

type Frame = Record<string, unknown>;
type Handler = (event: unknown, ctx: unknown) => unknown;
const roots: FixtureRootCleanup[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	await cleanupFixtureRoots(roots);
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await Bun.sleep(10);
	}
}

async function boot() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bus-stream-"));
	const agentDir = path.join(cwd, "agent");
	const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
	roots.push(cleanup);
	const handlers = new Map<string, Handler>();
	const submission = Promise.withResolvers<void>();
	const api = {
		on: (type: string, handler: Handler) => handlers.set(type, handler),
		registerCommand: () => {},
		getThinkingLevel: () => undefined,
		sendUserMessage: async (_text: unknown, options: { onPreflightAcceptCommit?: () => Promise<void> }) => {
			await options?.onPreflightAcceptCommit?.();
			return await submission.promise;
		},
	} as unknown as ExtensionAPI;
	createNotificationsExtension(api, { settings: isolatedNotificationSettings(agentDir) });
	const sessionId = crypto.randomUUID();
	const ctx = {
		cwd,
		sessionMetadata: { kind: "main", taskDepth: 0 },
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => cwd,
			getSessionName: () => "stream probe",
			getBranch: () => [],
		},
		getContextUsage: () => undefined,
		getActivePromptHandle: () => undefined,
		getSystemPrompt: () => ["test"],
		isIdle: () => true,
		hasPendingMessages: () => false,
		getPendingMessageCounts: () => ({ steering: 0, followUp: 0, nextTurn: 0 }),
	};
	const emit = async (event: Frame) => await handlers.get(String(event.type))?.(event, ctx);
	registerNotificationRuntime(cleanup, {
		key: sessionId,
		shutdown: async () => {
			submission.resolve();
			await emit({ type: "session_shutdown" });
		},
	});
	await emit({ type: "session_start" });
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => Bun.file(endpointFile).size > 0, "endpoint");
	const endpoint = await Bun.file(endpointFile).json();
	const connect = async (capabilities: string[], helloCapabilities?: string[]) => {
		const frames: Frame[] = [];
		const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
		sockets.push(socket);
		socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
		await waitFor(() => frames.some(frame => frame.type === "hello"), "hello");
		if (helloCapabilities) {
			socket.send(JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: helloCapabilities }));
		}
		socket.send(JSON.stringify({ type: "event_replay", id: "caps", capabilities }));
		await waitFor(() => frames.some(frame => frame.type === "event_replay_result"), "negotiation");
		return {
			socket,
			frames,
			content: () =>
				frames.filter(frame => frame.type === "event" && String(frame.kind).startsWith("tool_execution_")),
		};
	};
	return { emit, connect };
}

const caps = ["turn_stream", "session_host_observer_v1"];
const start = { type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "probe" } };
const update = (text: string) => ({
	type: "tool_execution_update",
	toolCallId: "bash-1",
	toolName: "bash",
	args: {},
	partialResult: { content: [{ type: "text", text }] },
});
const end = {
	type: "tool_execution_end",
	toolCallId: "bash-1",
	toolName: "bash",
	result: { content: [{ type: "text", text: "authoritative final" }] },
	isError: false,
};

test("bus observers receive intact snapshots only with both caps, without cross-session or replay leakage", async () => {
	const host = await boot();
	const observer = await host.connect(caps);
	const none = await host.connect([]);
	const streamOnly = await host.connect(["turn_stream"]);
	const observerOnly = await host.connect(["session_host_observer_v1"]);
	const foreignHost = await boot();
	const foreign = await foreignHost.connect(caps);
	await host.emit({ type: "agent_start" });
	for (const event of [start, update("one"), update("one\ntwo"), end]) await host.emit(event);
	await waitFor(() => observer.content().length === 4, "observer tool lifecycle");
	expect(observer.content().map(frame => (frame.payload as { event: unknown }).event)).toEqual([
		start,
		update("one"),
		update("one\ntwo"),
		end,
	]);
	for (const frame of observer.content()) {
		expect(frame.commandId).toBeUndefined();
		expect(frame.turnId).toBeUndefined();
	}
	for (const client of [none, streamOnly, observerOnly, foreign]) expect(client.content()).toEqual([]);
	const replay = await host.connect(caps);
	expect(replay.content()).toEqual([]);
	observer.socket.close();
	await waitFor(() => observer.socket.readyState === WebSocket.CLOSED, "disconnect");
	await host.emit(update("after close"));
	await waitFor(() => replay.content().length === 1, "remaining observer");
	expect(observer.content()).toHaveLength(4);
	await host.emit({ type: "session_shutdown" });
	await host.emit(update("after shutdown"));
	expect(replay.content()).toHaveLength(1);
}, 30_000);

test("bus owner keeps correlation and gets no duplicate observer copy", async () => {
	const host = await boot();
	const owner = await host.connect(caps);
	const observer = await host.connect(caps);
	owner.socket.send(
		JSON.stringify({ type: "control_request", id: "prompt", operation: "turn.prompt", input: { text: "probe" } }),
	);
	await waitFor(
		() => owner.frames.some(frame => frame.type === "control_response" && frame.id === "prompt"),
		"accept",
	);
	const response = owner.frames.find(frame => frame.type === "control_response" && frame.id === "prompt");
	expect(response?.ok).toBe(true);
	await host.emit({ type: "agent_start" });
	for (const event of [start, update("one"), end]) await host.emit(event);
	await waitFor(() => owner.content().length === 3 && observer.content().length === 3, "owner and observer");
	const correlation = response?.result as { commandId: string; turnId: string };
	for (const frame of owner.content())
		expect(frame).toMatchObject({ commandId: correlation.commandId, turnId: correlation.turnId });
	for (const frame of observer.content()) expect(frame.commandId).toBeUndefined();
}, 30_000);

test("native replay capabilities admit observers before delayed negotiation callbacks", async () => {
	const delayedCallbacks: Array<() => void> = [];
	const registerCapabilities = NotificationServer.prototype.onNegotiatedCapabilities;
	const capabilitySpy = spyOn(NotificationServer.prototype, "onNegotiatedCapabilities");
	capabilitySpy.mockImplementation(function (
		this: NotificationServer,
		callback: Parameters<NotificationServer["onNegotiatedCapabilities"]>[0],
	) {
		registerCapabilities.call(this, (error, connectionId, negotiated) => {
			delayedCallbacks.push(() => callback(error, connectionId, negotiated));
		});
	});
	try {
		const host = await boot();
		const observer = await host.connect(["session_host_observer_v1"], ["turn_stream"]);
		await host.emit({ type: "agent_start" });
		for (const event of [start, update("one"), update("one\ntwo"), end]) await host.emit(event);
		await waitFor(() => observer.content().length === 4, "observer stream before capability callback");
		expect(observer.content().map(frame => (frame.payload as { event: unknown }).event)).toEqual([
			start,
			update("one"),
			update("one\ntwo"),
			end,
		]);
		await waitFor(() => delayedCallbacks.length >= 2, "hello and replay capability callbacks");

		// Deliver the older hello snapshot after replay has added observer capability.
		delayedCallbacks[0]!();
		await host.emit(update("after delayed hello"));
		await waitFor(() => observer.content().length === 5, "observer stream after delayed hello");
		expect((observer.content()[4]?.payload as { event: unknown }).event).toEqual(update("after delayed hello"));
	} finally {
		for (const deliver of delayedCallbacks.splice(0)) deliver();
		capabilitySpy.mockRestore();
	}
}, 30_000);
