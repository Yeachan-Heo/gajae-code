import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";

class FakeWs extends EventTarget {
	static instances: FakeWs[] = [];
	static OPEN = 1;
	readyState = FakeWs.OPEN;
	sent: string[] = [];

	constructor(public url = "") {
		super();
		FakeWs.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
}

class FakeBotApi {
	calls: Array<{ method: string; body: Record<string, unknown> }> = [];

	async call(method: string, body: Record<string, unknown>): Promise<unknown> {
		this.calls.push({ method, body });
		if (method === "getChat") return { ok: true, result: { type: "private" } };
		if (method === "createForumTopic") return { ok: true, result: { message_thread_id: 77 } };
		if (method === "sendMessage") return { ok: true, result: { message_id: this.calls.length } };
		return { ok: true, result: true };
	}
}

function crashAtomicFs(): Record<string, unknown> {
	return {
		...(fs.promises as unknown as Record<string, unknown>),
		fsyncFile: async (_file: string) => undefined,
		fsyncDirectory: async (_directory: string) => undefined,
	};
}

async function daemonFixture() {
	FakeWs.instances = [];
	let nowMs = 0;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-daemon-2960-redteam-"));
	const isolated = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
	}) as Settings;
	const settings = new Proxy(isolated, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings,
		ownerId: "owner",
		botToken: "token",
		chatId: "42",
		botApi: bot,
		fs: crashAtomicFs() as any,
		WebSocketImpl: FakeWs as never,
		toolActivity: { enabled: true },
		now: () => nowMs,
	});
	await (daemon as any).loadTopics();
	return { bot, daemon, advance: (ms: number) => (nowMs += ms) };
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function connect(daemon: TelegramNotificationDaemon, sessionId = "S"): Promise<FakeWs> {
	daemon.connectSession(sessionId, `ws://${sessionId}`, "token");
	const socket = FakeWs.instances.at(-1)!;
	socket.dispatchEvent(new Event("open"));
	await daemon.handleSessionMessage(daemon.sessions.get(sessionId)!, {
		type: "event_replay_result",
		ok: true,
		id: `telegram-startup-replay:${sessionId}`,
		generation: 1,
		lastSeq: 0,
		events: [],
	});
	await settle();
	return socket;
}

async function sendIdentity(daemon: TelegramNotificationDaemon, sessionId = "S"): Promise<void> {
	await daemon.handleSessionMessage(daemon.sessions.get(sessionId)!, {
		type: "identity_header",
		sessionId,
		repo: "repo",
		branch: "branch",
	});
	await daemon.handleSessionMessage(daemon.sessions.get(sessionId)!, {
		type: "turn_stream",
		sessionId,
		phase: "finalized",
		text: "identity ready",
	});
	await (daemon as any).flushPool();
}

function calls(bot: FakeBotApi, method: string) {
	return bot.calls.filter(call => call.method === method);
}

test("#2960 red-team bare connect/drop stays topic-free through orphan grace scans", async () => {
	const { bot, daemon, advance } = await daemonFixture();
	const socket = await connect(daemon);
	socket.close();
	await settle();
	advance(60_001);
	await (daemon as any).observeOrphanedTopic("S");
	await settle();
	expect(calls(bot, "createForumTopic")).toHaveLength(0);
	expect(calls(bot, "deleteForumTopic")).toHaveLength(0);
});

test("#2960 red-team first user-facing frame creates once and targets the new thread", async () => {
	const { bot, daemon } = await daemonFixture();
	await connect(daemon);
	await sendIdentity(daemon);
	const creates = calls(bot, "createForumTopic");
	const sends = calls(bot, "sendMessage");
	expect(creates).toHaveLength(1);
	expect(sends).toHaveLength(2);
	expect(sends[0]!.body.message_thread_id).toBe(77);
});

test("#2960 red-team pre-topic buffered frame flushes once after lazy creation", async () => {
	const { bot, daemon } = await daemonFixture();
	await connect(daemon);
	await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
		type: "turn_stream",
		sessionId: "S",
		phase: "finalized",
		text: "buffered exactly once",
	});
	expect(calls(bot, "createForumTopic")).toHaveLength(0);
	await sendIdentity(daemon);
	expect(calls(bot, "createForumTopic")).toHaveLength(1);
	expect(calls(bot, "sendMessage").filter(call => call.body.text === "buffered exactly once")).toHaveLength(1);
	expect(
		calls(bot, "sendMessage").find(call => call.body.text === "buffered exactly once")!.body.message_thread_id,
	).toBe(77);
});

test("#2960 red-team durable-topic reconnect flushes pending frames without recreation", async () => {
	const { bot, daemon } = await daemonFixture();
	const original = await connect(daemon);
	await sendIdentity(daemon);
	original.close();
	await settle();
	bot.calls = [];
	daemon.connectSession("S", "ws://replacement", "replacement-token");
	const replacement = FakeWs.instances.at(-1)!;
	(daemon as any).rememberPendingThreadedFrame(
		daemon.sessions.get("S"),
		{ method: "sendMessage", lane: "finalized", text: "reconnect pending" },
		{ type: "turn_stream" },
	);
	replacement.dispatchEvent(new Event("open"));
	await (daemon as any).topicsPersistQueue;
	await (daemon as any).flushPool();
	await settle();
	expect(calls(bot, "createForumTopic")).toHaveLength(0);
	expect(calls(bot, "sendMessage").filter(call => call.body.text === "reconnect pending")).toHaveLength(1);
	expect(calls(bot, "sendMessage")[0]!.body.message_thread_id).toBe(77);
});

test("#2960 red-team identity, ask, and visible tool activity retain lazy creation paths", async () => {
	const identity = await daemonFixture();
	await connect(identity.daemon);
	await sendIdentity(identity.daemon);
	expect(calls(identity.bot, "createForumTopic")).toHaveLength(1);

	const ask = await daemonFixture();
	await connect(ask.daemon);
	await ask.daemon.handleSessionMessage(ask.daemon.sessions.get("S")!, {
		type: "action_needed",
		sessionId: "S",
		id: "ask-1",
		kind: "ask",
		question: "Proceed?",
	});
	expect(calls(ask.bot, "createForumTopic")).toHaveLength(1);
	await (ask.daemon as any).flushPool();
	expect(ask.bot.calls.some(call => call.body.message_thread_id === 77)).toBe(true);

	const tool = await daemonFixture();
	await connect(tool.daemon);
	await tool.daemon.handleSessionMessage(tool.daemon.sessions.get("S")!, {
		type: "tool_activity",
		sessionId: "S",
		toolCallId: "tool-1",
		toolName: "read",
		phase: "started",
	});
	expect(calls(tool.bot, "createForumTopic")).toHaveLength(0);
	await sendIdentity(tool.daemon);
	await (tool.daemon as any).flushPool();
	expect(calls(tool.bot, "createForumTopic")).toHaveLength(1);
	expect(
		tool.bot.calls.some(
			call => String(call.body.text).includes("read — started") && call.body.message_thread_id === 77,
		),
	).toBe(true);
});

test("#2960 red-team frame-free reconnect storm creates zero topics", async () => {
	const { bot, daemon } = await daemonFixture();
	for (let i = 0; i < 12; i++) {
		const socket = await connect(daemon, "S");
		socket.close();
		await settle();
	}
	expect(calls(bot, "createForumTopic")).toHaveLength(0);
	expect(calls(bot, "deleteForumTopic")).toHaveLength(0);
});
