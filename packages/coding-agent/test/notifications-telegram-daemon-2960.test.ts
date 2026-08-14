import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import {
	type TelegramDaemonFs,
	TelegramNotificationDaemon,
	writeTopicRegistryAtomic,
} from "../src/sdk/bus/telegram-daemon";

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
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-daemon-2960-"));
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
	});
	await (daemon as any).loadTopics();
	return { bot, daemon };
}

async function settle(): Promise<void> {
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

test("#2960 bare connect and disconnect do not create or delete a topic", async () => {
	const { bot, daemon } = await daemonFixture();
	const socket = await connect(daemon);
	socket.close();
	await settle();
	expect(bot.calls.filter(call => call.method === "createForumTopic")).toHaveLength(0);
	expect(bot.calls.filter(call => call.method === "deleteForumTopic")).toHaveLength(0);
});

test("#2960 the first outbound frame lazily creates one topic and delivers", async () => {
	const { bot, daemon } = await daemonFixture();
	await connect(daemon);
	await sendIdentity(daemon);
	expect(bot.calls.filter(call => call.method === "createForumTopic")).toHaveLength(1);
	expect(bot.calls.filter(call => call.method === "sendMessage")).toHaveLength(2);
	expect((daemon as any).topics.get("S")).toMatchObject({
		leaseOwner: expect.any(String),
		leaseExpiresAt: expect.any(Number),
		authorityState: "active",
	});
});
test("topic closure archives remotely without deleting the retained record", async () => {
	const { bot, daemon } = await daemonFixture();
	await connect(daemon);
	await sendIdentity(daemon);

	await (daemon as any).archiveTopic("S");
	await (daemon as any).archiveTopic("S");

	expect(bot.calls.filter(call => call.method === "closeForumTopic").map(call => call.body.message_thread_id)).toEqual(
		[77],
	);
	expect(bot.calls.some(call => call.method === "deleteForumTopic")).toBe(false);
	expect((daemon as any).topics.get("S")).toMatchObject({ topicId: "77", authorityState: "inactive" });
});
test("concurrent archive callers dispatch one remote close", async () => {
	const { bot, daemon } = await daemonFixture();
	await connect(daemon);
	await sendIdentity(daemon);

	const closeStarted = Promise.withResolvers<void>();
	const releaseClose = Promise.withResolvers<void>();
	const originalCall = bot.call.bind(bot);
	bot.call = async (method, body) => {
		if (method !== "closeForumTopic") return originalCall(method, body);
		bot.calls.push({ method, body });
		closeStarted.resolve();
		await releaseClose.promise;
		return { ok: true, result: true };
	};

	const first = (daemon as any).archiveTopic("S");
	await closeStarted.promise;
	const second = (daemon as any).archiveTopic("S");
	releaseClose.resolve();
	await Promise.all([first, second]);

	expect(bot.calls.filter(call => call.method === "closeForumTopic")).toHaveLength(1);
});

test("#2960 a frame before topic creation is buffered and flushed after lazy creation", async () => {
	const { bot, daemon } = await daemonFixture();
	await connect(daemon);
	await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
		type: "turn_stream",
		sessionId: "S",
		phase: "finalized",
		text: "buffered output",
	});
	expect(bot.calls.filter(call => call.method === "createForumTopic")).toHaveLength(0);
	expect(bot.calls.filter(call => call.method === "sendMessage")).toHaveLength(0);
	await sendIdentity(daemon);
	expect(bot.calls.filter(call => call.method === "createForumTopic")).toHaveLength(1);
	expect(bot.calls.some(call => String(call.body.text).includes("buffered output"))).toBe(true);
});

test("#2960 reconnect attaches to an existing topic and flushes without creating another", async () => {
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
		{ method: "sendMessage", lane: "finalized", text: "reconnect buffered" },
		{ type: "turn_stream" },
	);
	replacement.dispatchEvent(new Event("open"));
	await (daemon as any).topicsPersistQueue;
	await (daemon as any).flushPool();
	await settle();
	expect(bot.calls.filter(call => call.method === "createForumTopic")).toHaveLength(0);
	expect(bot.calls.some(call => String(call.body.text).includes("reconnect buffered"))).toBe(true);
});
test("Windows uses native write-through replacement after durable file flush", async () => {
	const calls: string[] = [];
	const serialized = `${JSON.stringify({ version: 2, topics: {} }, null, 2)}\n`;
	const expectedDestination = {
		dev: 0n,
		ino: 0n,
		nlink: 1n,
		parentDev: 0n,
		parentIno: 0n,
		size: 0n,
		mtimeNs: 0n,
		sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
	};
	const fsImpl: TelegramDaemonFs = {
		...fs.promises,
		mkdir: async (directory, options) => {
			await fs.promises.mkdir(directory, options);
		},
		writeFile: async () => {
			calls.push("write");
		},
		chmod: async () => {
			calls.push("chmod");
		},
		fsyncFile: async () => {
			calls.push("file");
		},
		readFile: async () => {
			calls.push("read");
			return serialized;
		},
		lstat: async () => ({
			dev: 0n,
			ino: 0n,
			nlink: 1n,
			size: 0n,
			mtimeNs: 0n,
			isFile: () => true,
		}),
		unlink: async () => {
			calls.push("unlink");
		},
	};
	await writeTopicRegistryAtomic(
		fsImpl,
		"C:\\topics.json",
		{ version: 2, topics: {} },
		"win32",
		() => ({
			ok: true,
			code: undefined,
			osCode: undefined,
			mutationState: "committed",
			durabilityState: "durable",
			reason: "none",
			primitive: "move_file_ex_write_through",
			phase: "complete",
		}),
		expectedDestination,
	);
	expect(calls).toEqual(["read", "write", "chmod", "file", "read", "read"]);
	await expect(
		writeTopicRegistryAtomic(fsImpl, "C:\\topics.json", { version: 2, topics: {} }, "win32", () => {
			throw new Error("native replacement must not run without a validated destination identity");
		}),
	).rejects.toThrow("topic registry durability is unavailable");
});
test("Windows rejects native write-through replacement failures", async () => {
	const fsImpl: TelegramDaemonFs = {
		...fs.promises,
		mkdir: async (directory, options) => {
			await fs.promises.mkdir(directory, options);
		},
		writeFile: async () => undefined,
		chmod: async () => undefined,
		fsyncFile: async () => undefined,
		unlink: async () => undefined,
		readFile: async () => `${JSON.stringify({ version: 2, topics: {} }, null, 2)}\n`,
		lstat: async () => ({
			dev: 0n,
			ino: 0n,
			nlink: 1n,
			size: 0n,
			mtimeNs: 0n,
			isFile: () => true,
		}),
	};
	await expect(
		writeTopicRegistryAtomic(
			fsImpl,
			"C:\\topics.json",
			{ version: 2, topics: {} },
			"win32",
			() => ({
				ok: false,
				code: "identity_mismatch",
				osCode: 5,
				mutationState: "unchanged",
				durabilityState: "unavailable",
				reason: "identity_mismatch",
				primitive: "move_file_ex_write_through",
				phase: "replace",
			}),
			{
				dev: 0n,
				ino: 0n,
				nlink: 1n,
				parentDev: 0n,
				parentIno: 0n,
				size: 0n,
				mtimeNs: 0n,
				sha256: crypto
					.createHash("sha256")
					.update(`${JSON.stringify({ version: 2, topics: {} }, null, 2)}\n`)
					.digest("hex"),
			},
		),
	).rejects.toThrow("topic registry durability is unavailable");
});
