import { describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import {
	markdownToTelegramHtml,
	splitTelegramHtml,
	TELEGRAM_MESSAGE_LIMIT,
	TELEGRAM_PARSE_MODE,
} from "../src/sdk/bus/html-format";
import { deliverRichWithFallback } from "../src/sdk/bus/rich-render";
import {
	acquireDaemonOwnership,
	type BotApi,
	DAEMON_GENERATION,
	DAEMON_VERSION,
	daemonPaths,
	ensureTelegramDaemonRunning,
	ensureTelegramDaemonRunningDetailed,
	registerNotificationRoot,
	releaseDaemonOwnership,
	renewDaemonHeartbeat,
	TelegramBotTransport,
	type TelegramDaemonFs,
	type TelegramDaemonOptions,
	TelegramEventDispatchState,
	TelegramNotificationDaemon,
	TelegramUpdatePoller,
	TOOL_ACTIVITY_CAPABILITY,
	unregisterNotificationRoot,
} from "../src/sdk/bus/telegram-daemon";
import { runDaemonInternal, runDaemonSmoke } from "../src/sdk/bus/telegram-daemon-cli";

const THREADED_FALLBACK_NOTICE =
	"Flat Telegram private chat supports outbound notifications and inline ask buttons only. Enable Threaded Mode in @BotFather > Bot Settings > Threads Settings for free-text replies and session commands.";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-daemon-test-"));
}

function settings(agentDir: string): Settings {
	// Isolate getAgentDir() to the temp dir so daemon persistence (aliases,
	// topics, lock/state/roots) never writes into the real global ~/.gjc/agent.
	return setPrivateAgentDir(
		Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": "123456:secret-token",
			"notifications.telegram.chatId": "42",
			"notifications.daemon.idleTimeoutMs": 20,
		}) as Settings,
		agentDir,
	);
}

function setPrivateAgentDir(s: Settings, agentDir: string) {
	return new Proxy(s, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function topicStateFs(onTopicStateWrite: () => Promise<void>): TelegramDaemonFs {
	return {
		mkdir: (file, opts) => fs.promises.mkdir(file, opts).then(() => undefined),
		readFile: (file, encoding) => fs.promises.readFile(file, encoding),
		writeFile: async (file, data, opts) => {
			if (file.includes("telegram-topics.json")) await onTopicStateWrite();
			await fs.promises.writeFile(file, data, opts);
		},
		rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath).then(() => undefined),
		unlink: file => fs.promises.unlink(file),
		open: async (file, flags, mode) => fs.promises.open(file, flags, mode),
		readdir: file => fs.promises.readdir(file),
		chmod: (file, mode) => fs.promises.chmod(file, mode),
	};
}

class FakeWs extends EventTarget {
	static OPEN = 1;
	readyState = 1;
	setReadyState(readyState: number): void {
		this.readyState = readyState;
	}
	sent: string[] = [];
	constructor(public url = "") {
		super();
		FakeWs.instances.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
	emit(data: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
	}
	static instances: FakeWs[] = [];
}

class FakeBotApi {
	calls: Array<{ method: string; body: any }> = [];
	updates: any[] = [];
	activeGetUpdates = 0;
	maxConcurrentGetUpdates = 0;
	botUsername: string | undefined = undefined;
	async call(method: string, body: unknown): Promise<unknown> {
		this.calls.push({ method, body });
		if (method === "getUpdates") {
			this.activeGetUpdates++;
			this.maxConcurrentGetUpdates = Math.max(this.maxConcurrentGetUpdates, this.activeGetUpdates);
			await Promise.resolve();
			this.activeGetUpdates--;
			const result = this.updates;
			this.updates = [];
			return { ok: true, result };
		}
		if (method === "getMe")
			return { ok: true, result: this.botUsername ? { id: 1, username: this.botUsername } : { id: 1 } };
		if (method === "getChat")
			return { ok: true, result: { id: (body as { chat_id?: unknown }).chat_id, type: "private" } };
		if (method === "getFile") return { ok: true, result: { file_path: "docs/file_7.bin" } };
		if (method === "createForumTopic") return { ok: true, result: { message_thread_id: this.calls.length } };
		if (method === "sendMessage") return { ok: true, result: { message_id: this.calls.length } };
		return { ok: true, result: true };
	}
}
async function unavailableControlHarness(fsImpl?: TelegramDaemonFs) {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		rich: { enabled: false },
		WebSocketImpl: FakeWs as any,
		...(fsImpl ? { fs: fsImpl } : {}),
	});
	daemon.connectSession("S", "ws://s", "ts");
	await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
		type: "identity_header",
		sessionId: "S",
		repo: "r",
		branch: "b",
	});
	const threadId = bot.calls.find(call => call.method === "sendMessage")!.body.message_thread_id as number;
	bot.calls = [];
	return { agentDir, bot, daemon, threadId };
}

type TopicAuthorityState = {
	topics: Record<
		string,
		{ name?: string; nameOwner?: string; nameReconcilePending?: boolean; userNameUpdateId?: number }
	>;
};

async function readTopicAuthorityState(agentDir: string): Promise<TopicAuthorityState> {
	return JSON.parse(
		await fs.promises.readFile(path.join(daemonPaths(agentDir).dir, "telegram-topics.json"), "utf8"),
	) as TopicAuthorityState;
}

function forumTopicEditedUpdate(
	updateId: number,
	threadId: number,
	name: string,
	{
		chat = { id: 42 },
		from = { id: 42, is_bot: false },
	}: {
		chat?: { id: number | string };
		from?: { id: number; is_bot?: boolean } | null;
	} = {},
) {
	return {
		update_id: updateId,
		message: {
			chat,
			...(from === null ? {} : { from }),
			message_thread_id: threadId,
			forum_topic_edited: { name },
		},
	};
}

async function identityTopicHarness({
	agentDir = tempAgentDir(),
	bot = new FakeBotApi(),
	fs: fsImpl,
	ownerId = "owner",
	title = "Generated title",
}: {
	agentDir?: string;
	bot?: FakeBotApi;
	fs?: TelegramDaemonFs;
	ownerId?: string;
	title?: string;
} = {}) {
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId,
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		fs: fsImpl,
	});
	const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
	await daemon.handleSessionMessage(session as never, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title,
	});
	return {
		agentDir,
		bot,
		daemon,
		session,
		threadId: bot.calls.find(call => call.method === "sendMessage")!.body.message_thread_id as number,
	};
}

class ReplayRenameBotApi extends FakeBotApi {
	threadId: number | undefined;
	getChatFailure: (() => unknown) | undefined;

	override async call(method: string, body: unknown): Promise<unknown> {
		if (method === "getUpdates") {
			this.calls.push({ method, body });
			const offset = (body as { offset?: number }).offset ?? 0;
			if (this.threadId !== undefined && offset <= 50) {
				return {
					ok: true,
					result: [
						forumTopicEditedUpdate(50, this.threadId, "First focus"),
						forumTopicEditedUpdate(51, this.threadId, "Later focus"),
					],
				};
			}
			return { ok: true, result: [] };
		}
		if (method === "getChat" && this.getChatFailure) {
			const failure = this.getChatFailure;
			this.getChatFailure = undefined;
			this.calls.push({ method, body });
			return failure();
		}
		return super.call(method, body);
	}
}

class FailingCallbackAckBotApi extends FakeBotApi {
	override async call(method: string, body: unknown): Promise<unknown> {
		if (method === "answerCallbackQuery") {
			this.calls.push({ method, body });
			throw new Error("callback ack failed");
		}
		return super.call(method, body);
	}
}

describe("telegram daemon", () => {
	test("N concurrent ensureTelegramDaemonRunning creates exactly one owner", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		let spawns = 0;
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				ensureTelegramDaemonRunning(
					{ settings: s, cwd: path.join(agentDir, `cwd-${i}`), sessionId: `s${i}` },
					{
						spawn: () => {
							spawns++;
							return { unref() {} };
						},
						pidAlive: () => true,
						pid: 111,
					},
				),
			),
		);
		expect(results.filter(r => r === "owner_spawned")).toHaveLength(1);
		expect(results.filter(r => r === "attached")).toHaveLength(7);
		expect(spawns).toBe(1);
	});

	test("ensureTelegramDaemonRunning ignores blank Telegram credentials when another adapter enables notifications", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.telegram.botToken": " ",
				"notifications.telegram.chatId": "\t",
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "discord-app",
				"notifications.discord.guildId": "discord-guild",
				"notifications.discord.parentChannelId": "discord-parent",
			}) as Settings,
			agentDir,
		);
		let spawns = 0;
		const result = await ensureTelegramDaemonRunning(
			{ settings: s, cwd: path.join(agentDir, "cwd"), sessionId: "s1" },
			{
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
				pidAlive: () => true,
				pid: 111,
			},
		);

		expect(result).toBe("disabled");
		expect(spawns).toBe(0);
		expect(fs.existsSync(daemonPaths(agentDir).roots)).toBe(false);
	});

	test("concurrent root registrations persist every root", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				registerNotificationRoot({ settings: s, cwd: path.join(agentDir, `cwd-${i}`), sessionId: `s${i}` }),
			),
		);
		const registry = JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8")) as {
			roots: string[];
			sessions: Record<string, string>;
		};
		expect(registry.roots).toHaveLength(12);
		expect(Object.keys(registry.sessions)).toHaveLength(12);
		for (let i = 0; i < 12; i++) {
			expect(registry.sessions[`s${i}`]).toBe(path.join(agentDir, `cwd-${i}`, ".gjc", "state"));
		}
	});

	test("unregistering a session removes only its unreferenced root", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const sharedCwd = path.join(agentDir, "shared");
		const otherCwd = path.join(agentDir, "other");
		await registerNotificationRoot({ settings: s, cwd: sharedCwd, sessionId: "shared-a" });
		await registerNotificationRoot({ settings: s, cwd: sharedCwd, sessionId: "shared-b" });
		await registerNotificationRoot({ settings: s, cwd: otherCwd, sessionId: "other" });

		expect(await unregisterNotificationRoot({ settings: s, cwd: sharedCwd, sessionId: "shared-a" })).toMatchObject({
			remainingRoots: 2,
		});
		expect(await unregisterNotificationRoot({ settings: s, cwd: sharedCwd, sessionId: "shared-b" })).toMatchObject({
			remainingRoots: 1,
		});

		const registry = JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8")) as {
			roots: string[];
			sessions: Record<string, string>;
		};
		expect(registry.roots).toEqual([path.join(otherCwd, ".gjc", "state")]);
		expect(registry.sessions).toEqual({ other: path.join(otherCwd, ".gjc", "state") });
	});

	test("fake Bot API observes one getUpdates loop", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
		});
		await daemon.pollOnce();
		await daemon.pollOnce();
		expect(bot.maxConcurrentGetUpdates).toBe(1);
	});

	test("TelegramUpdatePoller isolates handler failures and backs off before retrying an update", async () => {
		const calls: Array<{ method: string; body: any }> = [];
		const processed: string[] = [];
		const sleeps: number[] = [];
		const bot = {
			async call(method: string, body: unknown): Promise<unknown> {
				calls.push({ method, body });
				if (calls.length === 1) {
					return {
						ok: true,
						result: [
							{ update_id: 10, value: "bad" },
							{ update_id: 11, value: "retry" },
							{ update_id: 12, value: "later" },
						],
					};
				}
				return { ok: true, result: [] };
			},
		};
		const poller = new TelegramUpdatePoller({
			botApi: bot,
			runtime: { sleep: async (ms: number) => void sleeps.push(ms) } as any,
			backoff: { next: () => 500, reset() {} } as any,
			processUpdate: async update => {
				const value = (update as { value: string }).value;
				processed.push(value);
				if (value === "bad") throw new Error("boom");
				return value === "retry" ? "retry" : "consumed";
			},
		});

		expect(await poller.pollOnce()).toBe(3);
		expect(await poller.pollOnce()).toBe(0);
		expect(calls.map(call => call.body.offset)).toEqual([0, 11]);
		expect(processed).toEqual(["bad", "retry"]);
		expect(sleeps).toEqual([500]);
	});

	test("TelegramBotTransport keeps JSON and multipart Bot API details outside daemon", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const transport = new TelegramBotTransport({
			botToken: "tok",
			apiBase: "https://telegram.test",
			fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(url), init: init ?? {} });
				return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
			}) as typeof fetch,
		});

		await transport.call("sendMessage", { chat_id: "42", text: "hello" });
		await transport.call("sendPhoto", { chat_id: "42", photo: Buffer.from("x").toString("base64") });

		expect(requests[0].url).toBe("https://telegram.test/bottok/sendMessage");
		expect(requests[0].init.headers).toEqual({ "content-type": "application/json" });
		expect(requests[0].init.body).toBe(JSON.stringify({ chat_id: "42", text: "hello" }));
		expect(requests[1].url).toBe("https://telegram.test/bottok/sendPhoto");
		expect(requests[1].init.body).toBeInstanceOf(FormData);
	});

	test("TelegramBotTransport noRetry performs one application request", async () => {
		let attempts = 0;
		const transport = new TelegramBotTransport({
			botToken: "tok",
			apiBase: "https://telegram.test",
			fetchImpl: (async () => {
				attempts++;
				throw new Error("connection reset after write");
			}) as unknown as typeof fetch,
		});
		await expect(
			transport.call("sendMessage", { chat_id: "42", text: "Selected!" }, { noRetry: true }),
		).rejects.toThrow("connection reset");
		expect(attempts).toBe(1);
	});

	test("TelegramEventDispatchState groups dispatch state without changing maps", () => {
		const state = new TelegramEventDispatchState();
		state.busy.add("S");
		state.inboundReactions.set(7, { messageId: 70 });
		state.seenUpdateIds.add(99);

		expect([...state.busy]).toEqual(["S"]);
		expect(state.inboundReactions.get(7)).toEqual({ messageId: 70 });
		expect(state.seenUpdateIds.has(99)).toBe(true);
	});

	test("stale dead-pid lock is stolen by exactly one contender", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const paths = daemonPaths(agentDir);
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(paths.lock, "");
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				pid: 999,
				ownerId: "old",
				tokenFingerprint: "fp",
				chatId: "42",
				startedAt: 0,
				heartbeatAt: 0,
				roots: [],
				version: 1,
			}),
		);
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				acquireDaemonOwnership({
					settings: s,
					tokenFingerprint: "fp",
					chatId: "42",
					pidAlive: () => false,
					pid: 222,
				}),
			),
		);
		expect(results.filter(r => r.acquired)).toHaveLength(1);
	});

	test("fresh heartbeat is not stolen", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const paths = daemonPaths(agentDir);
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(paths.lock, "");
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				pid: 999,
				ownerId: "old",
				tokenFingerprint: "fp",
				chatId: "42",
				startedAt: 100,
				heartbeatAt: 100,
				roots: [],
				version: 1,
				generation: DAEMON_GENERATION,
			}),
		);
		const result = await acquireDaemonOwnership({
			settings: s,
			tokenFingerprint: "fp",
			chatId: "42",
			pidAlive: () => true,
			now: () => 101,
		});
		expect(result).toEqual({ acquired: false, attached: true });
	});

	test("live owner token/chat mismatch blocks attach without registering a root", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const paths = daemonPaths(agentDir);
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(paths.lock, "");
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				pid: 999,
				ownerId: "old",
				tokenFingerprint: "old-fp",
				chatId: "old-chat",
				startedAt: 100,
				heartbeatAt: 100,
				roots: [],
				version: DAEMON_VERSION,
			}),
		);
		const beforeState = fs.readFileSync(paths.state, "utf8");
		const signals: Array<[number, string]> = [];
		const unlinked: string[] = [];
		const baseFs = topicStateFs(async () => undefined);
		const recordingFs: TelegramDaemonFs = {
			...baseFs,
			unlink: async file => {
				unlinked.push(file);
				await fs.promises.unlink(file);
			},
		};

		let spawns = 0;
		const result = await ensureTelegramDaemonRunning(
			{ settings: s, cwd: path.join(agentDir, "new-session"), sessionId: "new-session" },
			{
				now: () => 101,
				pidAlive: pid => pid === 999,
				sendSignal: (pid, signal) => signals.push([pid, signal]),
				fs: recordingFs,
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			},
		);

		expect(result).toBe("blocked");
		expect(spawns).toBe(0);
		expect(signals).toEqual([]);
		expect(unlinked).toEqual([]);
		expect(fs.existsSync(paths.lock)).toBe(true);
		expect(fs.readFileSync(paths.state, "utf8")).toBe(beforeState);
		expect(fs.existsSync(paths.roots)).toBe(false);
		expect(JSON.parse(fs.readFileSync(paths.state, "utf8"))).toMatchObject({
			ownerId: "old",
			tokenFingerprint: "old-fp",
			chatId: "old-chat",
		});
	});

	// -----------------------------------------------------------------------
	// #2028: a rolling upgrade can leave a still-live PRE-upgrade daemon owning
	// the lock. Its persisted schema `version` is unchanged (1), so a freshly
	// upgraded host used to treat it as a fresh live owner and silently attach —
	// the old daemon speaks the old protocol without ask-ack/controls, so the new
	// host's Selected acks are dropped. The persisted operational `generation`
	// lets the new host detect the mismatch and reload instead of attaching.
	// -----------------------------------------------------------------------
	function liveOwnerState(extra: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			pid: 999,
			ownerId: "old",
			tokenFingerprint: "e60b05c186ca",
			chatId: "42",
			startedAt: 100,
			heartbeatAt: 100,
			roots: [],
			version: 1,
			...extra,
		};
	}

	function writeLiveOwner(agentDir: string, extra: Record<string, unknown> = {}): void {
		const paths = daemonPaths(agentDir);
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(paths.state, JSON.stringify(liveOwnerState(extra)));
		fs.writeFileSync(paths.lock, "");
	}

	test("#2028 acquire flags a reload for a live pre-upgrade owner missing the generation field", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		writeLiveOwner(agentDir); // no generation field == pre-upgrade daemon
		const result = await acquireDaemonOwnership({
			settings: s,
			tokenFingerprint: "e60b05c186ca",
			chatId: "42",
			pidAlive: () => true,
			now: () => 101,
		});
		expect(result).toEqual({ acquired: false, attached: false, reloadRequired: true });
	});

	test("#2028 acquire attaches to a current-generation live owner (no reload)", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		writeLiveOwner(agentDir, { generation: DAEMON_GENERATION });
		const result = await acquireDaemonOwnership({
			settings: s,
			tokenFingerprint: "e60b05c186ca",
			chatId: "42",
			pidAlive: () => true,
			now: () => 101,
		});
		expect(result).toEqual({ acquired: false, attached: true });
	});

	test("#2028 acquire does not downgrade a NEWER-generation live owner (attaches)", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		writeLiveOwner(agentDir, { generation: DAEMON_GENERATION + 1 });
		const result = await acquireDaemonOwnership({
			settings: s,
			tokenFingerprint: "e60b05c186ca",
			chatId: "42",
			pidAlive: () => true,
			now: () => 101,
		});
		expect(result).toEqual({ acquired: false, attached: true });
	});

	test("#2028 acquiring ownership stamps the current daemon generation into state", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const result = await acquireDaemonOwnership({
			settings: s,
			tokenFingerprint: "e60b05c186ca",
			chatId: "42",
			pid: 111,
			randomId: () => "owner",
		});
		expect(result.acquired).toBe(true);
		const state = JSON.parse(fs.readFileSync(daemonPaths(agentDir).state, "utf8"));
		expect(state.generation).toBe(DAEMON_GENERATION);
	});

	test("#2028 ensureTelegramDaemonRunning reloads a live pre-upgrade owner via a safe SIGTERM handoff", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		// Pre-upgrade daemon, still alive with a fresh heartbeat (so it is a fresh
		// live owner that a version-only check would attach to).
		writeLiveOwner(agentDir, { heartbeatAt: Date.now() });
		const paths = daemonPaths(agentDir);
		const alive = new Set<number>([999, 4242]);
		const signals: Array<[number, string]> = [];
		let oldAliveAtSpawn: boolean | undefined;
		const spawns: Array<{ command: string; args: string[] }> = [];
		const cwd = path.join(agentDir, "new-session");
		const result = await ensureTelegramDaemonRunning(
			{ settings: s, cwd, sessionId: "new-session" },
			{
				pid: 4242,
				pidAlive: pid => alive.has(pid),
				sendSignal: (pid, sig) => {
					signals.push([pid, sig]);
					if (sig === "SIGTERM") alive.delete(999);
				},
				sleep: async () => undefined,
				spawn: (command, args) => {
					oldAliveAtSpawn = alive.has(999);
					spawns.push({ command, args });
					return { unref() {} };
				},
			},
		);
		expect(result).toBe("owner_spawned");
		// Cooperative handoff: the old poller is SIGTERM'd and must be dead before a
		// replacement poller spawns (no Telegram getUpdates 409 overlap).
		expect(signals).toContainEqual([999, "SIGTERM"]);
		expect(signals.some(([, sig]) => sig === "SIGKILL")).toBe(false);
		expect(spawns).toHaveLength(1);
		expect(oldAliveAtSpawn).toBe(false);
		const after = JSON.parse(fs.readFileSync(paths.state, "utf8"));
		expect(after.ownerId).not.toBe("old");
		expect(after.generation).toBe(DAEMON_GENERATION);
		// The new session's root is persisted so the replacement daemon serves it.
		expect(after.roots).toContain(path.join(cwd, ".gjc", "state"));
	});

	test("detailed ensure reports reloaded only for the existing fresh-owner reloadRequired handoff", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		writeLiveOwner(agentDir, { heartbeatAt: Date.now() }); // Missing generation requests #2028 reload.
		const alive = new Set<number>([999, 4242]);
		const signals: Array<[number, string]> = [];
		const result = await ensureTelegramDaemonRunningDetailed(
			{ settings: s, cwd: path.join(agentDir, "new-session"), sessionId: "new-session" },
			{
				pid: 4242,
				pidAlive: pid => alive.has(pid),
				sendSignal: (pid, signal) => {
					signals.push([pid, signal]);
					if (signal === "SIGTERM") alive.delete(999);
				},
				sleep: async () => undefined,
				spawn: () => ({ unref() {} }),
			},
		);
		expect(result).toBe("reloaded");
		expect(signals).toContainEqual([999, "SIGTERM"]);
	});

	test("detailed ensure keeps a stale-heartbeat live PID attached even when generation is older", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		writeLiveOwner(agentDir, { heartbeatAt: 100 }); // Missing generation, but stale heartbeat is fail-closed.
		const signals: Array<[number, string]> = [];
		let spawns = 0;
		const result = await ensureTelegramDaemonRunningDetailed(
			{ settings: s, cwd: path.join(agentDir, "new-session"), sessionId: "new-session" },
			{
				pid: 4242,
				now: () => 100_000,
				pidAlive: () => true,
				sendSignal: (pid, signal) => signals.push([pid, signal]),
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			},
		);
		expect(result).toBe("attached");
		expect(signals).toEqual([]);
		expect(spawns).toBe(0);
	});

	test("#2028 ensureTelegramDaemonRunning reuses a current-generation live owner without a reload", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		writeLiveOwner(agentDir, { generation: DAEMON_GENERATION, heartbeatAt: Date.now() });
		const paths = daemonPaths(agentDir);
		const signals: Array<[number, string]> = [];
		let spawns = 0;
		const result = await ensureTelegramDaemonRunning(
			{ settings: s, cwd: path.join(agentDir, "new-session"), sessionId: "new-session" },
			{
				pid: 4242,
				pidAlive: () => true,
				sendSignal: (pid, sig) => signals.push([pid, sig]),
				sleep: async () => undefined,
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			},
		);
		expect(result).toBe("attached");
		expect(signals).toHaveLength(0);
		expect(spawns).toBe(0);
		// Still the original owner; the new session's root is registered onto it.
		expect(JSON.parse(fs.readFileSync(paths.state, "utf8")).ownerId).toBe("old");
		expect(fs.existsSync(paths.roots)).toBe(true);
	});

	test("idle self-exit after timeout releases ownership", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		await acquireDaemonOwnership({
			settings: s,
			tokenFingerprint: "fp",
			chatId: "42",
			pid: process.pid,
			randomId: () => "owner",
		});
		let now = 0;
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: new FakeBotApi(),
			idleTimeoutMs: 10,
			now: () => (now += 11),
			setTimeoutImpl: ((cb: () => void) => {
				cb();
				return 0;
			}) as any,
		});
		await daemon.run();
		expect(fs.existsSync(daemonPaths(agentDir).lock)).toBe(false);
	});

	test("runDaemonInternal rewrites persisted owner pid to daemon process pid", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		await acquireDaemonOwnership({
			settings: s,
			tokenFingerprint: "e60b05c186ca",
			chatId: "42",
			pid: 111,
			randomId: () => "owner",
		});
		class OneShotDaemon extends TelegramNotificationDaemon {
			#options: TelegramDaemonOptions;

			constructor(options: TelegramDaemonOptions) {
				super(options);
				this.#options = options;
			}

			override async run(): Promise<void> {
				await renewDaemonHeartbeat({
					settings: this.#options.settings,
					ownerId: this.#options.ownerId,
					pid: this.#options.pid,
				});
			}
		}
		await runDaemonInternal(["--agent-dir", agentDir, "--owner-id", "owner"], {
			SettingsImpl: { init: async () => s },
			DaemonImpl: OneShotDaemon,
			processPid: 222,
			readDaemonState: async () => undefined,
		});
		const state = JSON.parse(fs.readFileSync(daemonPaths(agentDir).state, "utf8")) as {
			pid: number;
			ownerId: string;
		};
		expect(state.pid).toBe(222);
		expect(state.ownerId).toBe("owner");
	});

	test("runDaemonInternal stops when persisted ownership moves to another owner", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		let tick: (() => void) | undefined;
		let stopReason: string | undefined;
		let resolveRun!: () => void;
		class StubDaemon {
			requestStop(reason?: string): void {
				stopReason = reason;
				resolveRun();
			}
			run(): Promise<void> {
				return new Promise<void>(resolve => {
					resolveRun = resolve;
				});
			}
		}
		const run = runDaemonInternal(["--agent-dir", agentDir, "--owner-id", "owner"], {
			SettingsImpl: { init: async () => s },
			DaemonImpl: StubDaemon,
			readDaemonState: async () => ({ ownerId: "replacement", heartbeatAt: 1 }) as never,
			setInterval: callback => {
				tick = callback;
				return 1 as unknown as Timer;
			},
			clearInterval: () => {},
		});
		for (let attempt = 0; attempt < 100 && !tick; attempt++) await Bun.sleep(1);
		expect(tick).toBeDefined();
		tick!();
		await run;
		expect(stopReason).toBe("stop");
	});

	test("runDaemonInternal stops after persisted heartbeat remains stalled", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		let tick: (() => void) | undefined;
		let now = 0;
		let stopReason: string | undefined;
		let resolveRun!: () => void;
		class StubDaemon {
			requestStop(reason?: string): void {
				stopReason = reason;
				resolveRun();
			}
			run(): Promise<void> {
				return new Promise<void>(resolve => {
					resolveRun = resolve;
				});
			}
		}
		const run = runDaemonInternal(["--agent-dir", agentDir, "--owner-id", "owner"], {
			SettingsImpl: { init: async () => s },
			DaemonImpl: StubDaemon,
			now: () => now,
			readDaemonState: async () => ({ ownerId: "owner", heartbeatAt: 1 }) as never,
			setInterval: callback => {
				tick = callback;
				return 1 as unknown as Timer;
			},
			clearInterval: () => {},
		});
		for (let attempt = 0; attempt < 100 && !tick; attempt++) await Bun.sleep(1);
		expect(tick).toBeDefined();
		tick!();
		await Bun.sleep(0);
		now = Number.MAX_SAFE_INTEGER;
		tick!();
		await run;
		expect(stopReason).toBe("stop");
	});

	test("runDaemonInternal exits before constructing daemon for blank Telegram credentials with another adapter configured", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.telegram.botToken": " ",
				"notifications.telegram.chatId": "\t",
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "discord-app",
				"notifications.discord.guildId": "discord-guild",
				"notifications.discord.parentChannelId": "discord-parent",
			}) as Settings,
			agentDir,
		);
		let daemonConstructed = false;
		class StubDaemon {
			constructor() {
				daemonConstructed = true;
			}
			async run(): Promise<void> {}
			requestStop(): void {}
		}

		await runDaemonInternal(["--agent-dir", agentDir, "--owner-id", "owner"], {
			SettingsImpl: { init: async () => s },
			DaemonImpl: StubDaemon,
			pidAlive: () => true,
		});

		expect(daemonConstructed).toBe(false);
	});

	test("requests startup replay and restores identity from replay envelopes", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		const socket = FakeWs.instances[0]!;
		socket.dispatchEvent(new Event("open"));
		const session = daemon.sessions.get("S")!;
		const liveDuringReplay = {
			type: "action_needed",
			kind: "ask",
			id: "live",
			question: "Now?",
			options: ["Yes"],
		};
		await daemon.handleSessionMessage(session, liveDuringReplay);
		expect(session.pending.has("live")).toBe(false);
		expect(socket.sent.map(frame => JSON.parse(frame))).toContainEqual({
			type: "event_replay",
			id: "telegram-startup-replay:S",
			sinceGeneration: 1,
			sinceSeq: 0,
		});
		await daemon.handleSessionMessage(session, {
			type: "event_replay_result",
			id: "telegram-startup-replay:S",
			generation: 1,
			lastSeq: 4,
			events: [
				{
					type: "event",
					name: "action_needed",
					payload: { type: "action_needed", kind: "ask", id: "stale", question: "Old?", options: ["No"] },
				},
				{
					type: "event",
					name: "identity_header",
					payload: { type: "identity_header", sessionId: "S", repo: "gajae-code", branch: "dev" },
				},
				{
					type: "event",
					name: "action_needed",
					payload: liveDuringReplay,
				},
				{
					type: "event",
					name: "turn_stream",
					payload: {
						type: "turn_stream",
						sessionId: "S",
						phase: "finalized",
						text: "already-delivered-history",
					},
				},
			],
		});
		expect(bot.calls.some(call => call.method === "createForumTopic")).toBe(true);
		expect(session.pending.has("stale")).toBe(false);
		expect(session.pending.has("live")).toBe(true);
		expect(
			bot.calls.filter(call => call.method === "sendMessage" && String(call.body.text).includes("Now?")).length,
		).toBe(1);
		expect(bot.calls.some(call => String(call.body.text).includes("already-delivered-history"))).toBe(false);

		daemon.connectSession("S", "ws://s-reconnected", "ts-2");
		const replacementSocket = FakeWs.instances[1]!;
		replacementSocket.dispatchEvent(new Event("open"));
		expect(replacementSocket.sent.map(frame => JSON.parse(frame))).toContainEqual({
			type: "event_replay",
			id: "telegram-startup-replay:S",
			sinceGeneration: 1,
			sinceSeq: 4,
		});
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "event_replay_result",
			id: "telegram-startup-replay:S",
			generation: 1,
			lastSeq: 5,
			events: [
				{
					type: "event",
					generation: 1,
					seq: 5,
					name: "turn_stream",
					payload: {
						type: "turn_stream",
						sessionId: "S",
						phase: "finalized",
						text: "delivered-before-reconnect",
					},
				},
			],
		});
		expect(bot.calls.some(call => String(call.body.text).includes("delivered-before-reconnect"))).toBe(false);
	});

	test("callback alias from session B routes only to session B", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("A", "ws://a", "ta");
		daemon.connectSession("B", "ws://b", "tb");
		await daemon.handleSessionMessage(daemon.sessions.get("B")!, {
			type: "action_needed",
			kind: "ask",
			id: "askB",
			question: "Q",
			options: ["Y"],
		});
		const alias = bot.calls.find(c => c.method === "sendMessage")!.body.reply_markup.inline_keyboard[0][0]
			.callback_data;
		await daemon.handleTelegramUpdate({
			update_id: 1,
			callback_query: { id: "cb", data: alias, message: { chat: { id: 42 } } },
		});
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(JSON.parse(FakeWs.instances[1]!.sent[0]!)).toEqual({ type: "reply", id: "askB", answer: 0, token: "tb" });
		expect(bot.calls.some(c => c.method === "answerCallbackQuery")).toBe(true);
	});

	test("callback alias reply is delivered when Telegram callback ack fails", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FailingCallbackAckBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask",
			question: "Q",
			options: ["Y"],
		});
		const alias = bot.calls.find(c => c.method === "sendMessage")!.body.reply_markup.inline_keyboard[0][0]
			.callback_data;

		await daemon.handleTelegramUpdate({
			update_id: 1,
			callback_query: { id: "cb", data: alias, message: { chat: { id: 42 } } },
		});

		expect(JSON.parse(FakeWs.instances[0]!.sent[0]!)).toEqual({ type: "reply", id: "ask", answer: 0, token: "ts" });
		expect(bot.calls.some(c => c.method === "answerCallbackQuery")).toBe(true);
	});

	test("successful model lists render bounded labels and short aliases in the owning topic", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "control_command_result",
			sessionId: "S",
			requestId: "tg:8",
			status: "ok",
			message: "Select a model.",
			modelChoices: [
				{ selector: "provider/gpt-5", label: "GPT\n5" },
				{ selector: "provider/long", label: "x".repeat(100) },
				{ selector: "provider/private", label: "https://private.example.invalid/model" },
			],
		});

		const sent = bot.calls.find(call => call.method === "sendMessage")!.body;
		const buttons = sent.reply_markup.inline_keyboard.flat();
		expect(buttons).toHaveLength(2);
		expect(sent.message_thread_id).toBeDefined();
		expect(sent.text).toBe("✅ Select a model.");
		expect(JSON.stringify(sent)).not.toContain("provider/gpt-5");
		expect(buttons[0].text).toBe("1. GPT 5");
		expect(Buffer.byteLength(buttons[1].text, "utf8")).toBeLessThanOrEqual(52);
		expect(
			buttons.every((button: { callback_data: string }) => Buffer.byteLength(button.callback_data, "utf8") <= 64),
		).toBe(true);
		expect(buttons.every((button: { callback_data: string }) => button.callback_data.startsWith("m:"))).toBe(true);
	});

	test("model choice callbacks are chat-authorized and forward one session-bound control command", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "control_command_result",
			sessionId: "S",
			requestId: "tg:8",
			status: "ok",
			message: "Select a model.",
			modelChoices: [{ selector: "provider/gpt-5", label: "GPT 5" }],
		});
		const alias = bot.calls.find(call => call.method === "sendMessage")!.body.reply_markup.inline_keyboard[0][0]
			.callback_data;

		await daemon.handleTelegramUpdate({
			update_id: 9,
			callback_query: { id: "wrong", data: alias, message: { chat: { id: 99 } } },
		});
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(
			bot.calls.some(
				call =>
					call.method === "answerCallbackQuery" &&
					call.body.callback_query_id === "wrong" &&
					call.body.text === "Not authorized",
			),
		).toBe(true);

		await daemon.handleTelegramUpdate({
			update_id: 9,
			callback_query: { id: "right", data: alias, message: { chat: { id: 42 } } },
		});
		expect(JSON.parse(FakeWs.instances[0]!.sent[0]!)).toEqual({
			type: "control_command",
			sessionId: "S",
			token: "ts",
			requestId: "tg:model:9",
			updateId: 9,
			command: { name: "model", action: "set", selector: "provider/gpt-5" },
		});
		expect(
			bot.calls.some(call => call.method === "answerCallbackQuery" && call.body.callback_query_id === "right"),
		).toBe(true);
	});

	test("model aliases cannot cross a same-socket logical-session rekey", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("transport", "ws://transport", "tt");
		const session = daemon.sessions.get("transport")!;
		await daemon.handleSessionMessage(session, {
			type: "control_command_result",
			sessionId: "old-logical",
			requestId: "tg:model:old",
			status: "ok",
			message: "Select a model.",
			modelChoices: [{ selector: "provider/old", label: "Old" }],
		});
		const staleAlias = bot.calls.find(call => call.method === "sendMessage" && call.body.reply_markup)!.body
			.reply_markup.inline_keyboard[0][0].callback_data;

		await daemon.handleSessionMessage(session, {
			type: "config_update",
			sessionId: "new-logical",
		});
		const threadId = bot.calls.find(call => call.method === "sendMessage" && call.body.reply_markup)!.body
			.message_thread_id;
		await daemon.handleTelegramUpdate({
			update_id: 19,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "/usage", message_id: 19 },
		});
		expect(JSON.parse(FakeWs.instances[0]!.sent[0]!)).toMatchObject({
			type: "control_command",
			sessionId: "new-logical",
			command: { name: "usage" },
		});
		FakeWs.instances[0]!.sent = [];
		await daemon.handleTelegramUpdate({
			update_id: 20,
			callback_query: { id: "old-menu", data: staleAlias, message: { chat: { id: 42 } } },
		});
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(
			bot.calls.some(
				call => call.method === "answerCallbackQuery" && call.body.text === "Button is stale. Run /model again.",
			),
		).toBe(true);

		await daemon.handleSessionMessage(session, {
			type: "control_command_result",
			sessionId: "new-logical",
			requestId: "tg:model:new",
			status: "ok",
			message: "Select a model.",
			modelChoices: [{ selector: "provider/new", label: "New" }],
		});
		const freshAlias = bot.calls.filter(call => call.method === "sendMessage" && call.body.reply_markup).at(-1)!.body
			.reply_markup.inline_keyboard[0][0].callback_data;
		await daemon.handleTelegramUpdate({
			update_id: 21,
			callback_query: { id: "new-menu", data: freshAlias, message: { chat: { id: 42 } } },
		});
		expect(JSON.parse(FakeWs.instances[0]!.sent[0]!)).toMatchObject({
			type: "control_command",
			sessionId: "new-logical",
			command: { name: "model", action: "set", selector: "provider/new" },
		});
	});

	test("model aliases expire after ten minutes using the injected daemon clock", async () => {
		FakeWs.instances = [];
		let now = 0;
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			now: () => now,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "control_command_result",
			sessionId: "S",
			requestId: "tg:model:ttl",
			status: "ok",
			message: "Select a model.",
			modelChoices: [{ selector: "provider/gpt-5", label: "GPT 5" }],
		});
		const alias = bot.calls.find(call => call.method === "sendMessage" && call.body.reply_markup)!.body.reply_markup
			.inline_keyboard[0][0].callback_data;
		now = 10 * 60 * 1_000;
		await daemon.handleTelegramUpdate({
			update_id: 22,
			callback_query: { id: "expired", data: alias, message: { chat: { id: 42 } } },
		});
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(
			bot.calls.some(
				call => call.method === "answerCallbackQuery" && call.body.text === "Button is stale. Run /model again.",
			),
		).toBe(true);
	});

	test("a fresh model menu replaces every prior alias for its logical session", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		const session = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(session, {
			type: "control_command_result",
			sessionId: "S",
			requestId: "tg:model:one",
			status: "ok",
			message: "Select a model.",
			modelChoices: [
				{ selector: "provider/old-one", label: "Old one" },
				{ selector: "provider/old-two", label: "Old two" },
			],
		});
		const oldAliases = bot.calls
			.find(call => call.method === "sendMessage" && call.body.reply_markup)!
			.body.reply_markup.inline_keyboard.flat()
			.map((button: { callback_data: string }) => button.callback_data);
		await daemon.handleSessionMessage(session, {
			type: "control_command_result",
			sessionId: "S",
			requestId: "tg:model:two",
			status: "ok",
			message: "Select a model.",
			modelChoices: [{ selector: "provider/fresh", label: "Fresh" }],
		});
		const freshAlias = bot.calls.filter(call => call.method === "sendMessage" && call.body.reply_markup).at(-1)!.body
			.reply_markup.inline_keyboard[0][0].callback_data;
		for (const [index, alias] of oldAliases.entries()) {
			await daemon.handleTelegramUpdate({
				update_id: 30 + index,
				callback_query: { id: `old-${index}`, data: alias, message: { chat: { id: 42 } } },
			});
		}
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		await daemon.handleTelegramUpdate({
			update_id: 32,
			callback_query: { id: "fresh", data: freshAlias, message: { chat: { id: 42 } } },
		});
		expect(JSON.parse(FakeWs.instances[0]!.sent[0]!)).toMatchObject({
			command: { name: "model", action: "set", selector: "provider/fresh" },
		});
	});

	test("failed model keyboard delivery falls back to the generic control result", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const originalCall = bot.call.bind(bot);
		bot.call = async (method: string, body: unknown): Promise<unknown> => {
			if (method === "sendMessage" && (body as { reply_markup?: unknown }).reply_markup) {
				bot.calls.push({ method, body });
				throw new Error("keyboard rejected");
			}
			return originalCall(method, body);
		};
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "control_command_result",
			sessionId: "S",
			requestId: "tg:model:fallback",
			status: "ok",
			message: "Select a model.",
			modelChoices: [{ selector: "provider/gpt-5", label: "GPT 5" }],
		});
		const attemptedKeyboard = bot.calls.find(call => call.method === "sendMessage" && call.body.reply_markup)!;
		const alias = attemptedKeyboard.body.reply_markup.inline_keyboard[0][0].callback_data;
		expect(
			bot.calls.some(
				call => call.method === "sendMessage" && !call.body.reply_markup && call.body.text === "✅ Select a model.",
			),
		).toBe(true);
		await daemon.handleTelegramUpdate({
			update_id: 40,
			callback_query: { id: "failed-menu", data: alias, message: { chat: { id: 42 } } },
		});
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(
			bot.calls.some(
				call => call.method === "answerCallbackQuery" && call.body.text === "Button is stale. Run /model again.",
			),
		).toBe(true);
	});

	test("model choices from a prior daemon are stale after restart", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const firstBot = new FakeBotApi();
		const first = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: firstBot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		first.connectSession("S", "ws://s", "ts");
		await first.handleSessionMessage(first.sessions.get("S")!, {
			type: "control_command_result",
			sessionId: "S",
			requestId: "tg:8",
			status: "ok",
			message: "Select a model.",
			modelChoices: [{ selector: "provider/gpt-5", label: "GPT 5" }],
		});
		const alias = firstBot.calls.find(call => call.method === "sendMessage")!.body.reply_markup.inline_keyboard[0][0]
			.callback_data;

		const secondBot = new FakeBotApi();
		const secondAgentDir = tempAgentDir();
		const second = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(secondAgentDir), secondAgentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: secondBot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		second.connectSession("S", "ws://s", "ts");
		await second.handleTelegramUpdate({
			update_id: 10,
			callback_query: { id: "stale", data: alias, message: { chat: { id: 42 } } },
		});
		expect(FakeWs.instances[1]!.sent).toHaveLength(0);
		expect(
			secondBot.calls.some(
				call => call.method === "answerCallbackQuery" && call.body.text === "Button is stale. Run /model again.",
			),
		).toBe(true);
	});

	test("model choice aliases are one-shot and duplicate taps become stale", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "control_command_result",
			sessionId: "S",
			requestId: "tg:8",
			status: "ok",
			message: "Select a model.",
			modelChoices: [{ selector: "provider/gpt-5", label: "GPT 5" }],
		});
		const alias = bot.calls.find(call => call.method === "sendMessage")!.body.reply_markup.inline_keyboard[0][0]
			.callback_data;
		const callback = (updateId: number) =>
			daemon.handleTelegramUpdate({
				update_id: updateId,
				callback_query: { id: `tap-${updateId}`, data: alias, message: { chat: { id: 42 } } },
			});

		await callback(11);
		await callback(12);
		expect(FakeWs.instances[0]!.sent).toHaveLength(1);
		expect(
			bot.calls.some(
				call => call.method === "answerCallbackQuery" && call.body.text === "Button is stale. Run /model again.",
			),
		).toBe(true);
	});

	test("disconnected model-choice sessions fail closed and consume their aliases", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "control_command_result",
			sessionId: "S",
			requestId: "tg:8",
			status: "ok",
			message: "Select a model.",
			modelChoices: [{ selector: "provider/gpt-5", label: "GPT 5" }],
		});
		const alias = bot.calls.find(call => call.method === "sendMessage")!.body.reply_markup.inline_keyboard[0][0]
			.callback_data;
		FakeWs.instances[0]!.close();

		await daemon.handleTelegramUpdate({
			update_id: 13,
			callback_query: { id: "closed", data: alias, message: { chat: { id: 42 } } },
		});
		await daemon.handleTelegramUpdate({
			update_id: 14,
			callback_query: { id: "duplicate", data: alias, message: { chat: { id: 42 } } },
		});
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(
			bot.calls.filter(
				call => call.method === "answerCallbackQuery" && call.body.text === "Button is stale. Run /model again.",
			),
		).toHaveLength(2);
	});

	test("invalid model results keep generic control rendering and create no keyboard", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "identity_header",
			sessionId: "S",
			repo: "repo",
			branch: "branch",
		});
		bot.calls = [];
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "control_command_result",
			sessionId: "S",
			requestId: "tg:model:9",
			status: "error",
			message: "Model is unavailable.",
			modelChoices: [{ selector: "provider/gpt-5", label: "GPT 5" }],
		});
		const sent = bot.calls.find(call => call.method === "sendMessage")!.body;
		expect(sent.text).toBe("❌ Model is unavailable.");
		expect(sent.reply_markup).toBeUndefined();
	});

	test("model choice delivery survives a callback acknowledgement failure", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FailingCallbackAckBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "control_command_result",
			sessionId: "S",
			requestId: "tg:8",
			status: "ok",
			message: "Select a model.",
			modelChoices: [{ selector: "provider/gpt-5", label: "GPT 5" }],
		});
		const alias = bot.calls.find(call => call.method === "sendMessage")!.body.reply_markup.inline_keyboard[0][0]
			.callback_data;

		await daemon.handleTelegramUpdate({
			update_id: 15,
			callback_query: { id: "ack-fails", data: alias, message: { chat: { id: 42 } } },
		});
		expect(JSON.parse(FakeWs.instances[0]!.sent[0]!)).toMatchObject({
			type: "control_command",
			command: { name: "model", action: "set", selector: "provider/gpt-5" },
		});
		expect(bot.calls.some(call => call.method === "answerCallbackQuery")).toBe(true);
	});

	test("unknown and expired aliases are stale guidance with zero frames", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("A", "ws://a", "ta");
		await daemon.handleTelegramUpdate({
			callback_query: { id: "cb", data: "missing", message: { chat: { id: 42 } } },
		});
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(bot.calls.some(c => c.method === "sendMessage" && String(c.body.text).includes("stale"))).toBe(true);
		await daemon.handleTelegramUpdate({
			callback_query: { id: "cb2", data: "expired", message: { chat: { id: 42 } } },
		});
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
	});

	test("stale callbacks in non-private chats do not send guidance messages", async () => {
		FakeWs.instances = [];
		const bot = new FakeBotApi();
		bot.call = (async (method: string, body: any) => {
			bot.calls.push({ method, body });
			if (method === "getChat") return { ok: true, result: { id: body.chat_id, type: "supergroup" } };
			if (method === "sendMessage") return { ok: true, result: { message_id: bot.calls.length } };
			return { ok: true, result: true };
		}) as any;
		const agentDir = tempAgentDir();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "-10042",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("A", "ws://a", "ta");

		await daemon.handleTelegramUpdate({
			callback_query: { id: "cb", data: "missing", message: { chat: { id: -10042 } } },
		});

		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(bot.calls.some(c => c.method === "answerCallbackQuery" && c.body.text === "Button is stale")).toBe(true);
		expect(bot.calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
	});

	test("known alias with dead target is stale guidance with zero frames", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask",
			question: "Q",
			options: ["Y"],
		});
		const alias = bot.calls.find(c => c.method === "sendMessage")!.body.reply_markup.inline_keyboard[0][0]
			.callback_data;
		FakeWs.instances[0]!.setReadyState(3);
		await daemon.handleTelegramUpdate({ callback_query: { id: "cb", data: alias, message: { chat: { id: 42 } } } });
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(bot.calls.some(c => c.method === "answerCallbackQuery" && c.body.text === "Button is stale")).toBe(true);
		expect(bot.calls.some(c => c.method === "sendMessage" && String(c.body.text).includes("stale"))).toBe(true);

		bot.calls = [];
		daemon.sessions.delete("S");
		await daemon.handleTelegramUpdate({ callback_query: { id: "cb2", data: alias, message: { chat: { id: 42 } } } });
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(bot.calls.some(c => c.method === "sendMessage" && String(c.body.text).includes("stale"))).toBe(true);
	});

	test("known alias with non-pending target is stale guidance with zero frames", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask",
			question: "Q",
			options: ["Y"],
		});
		const alias = bot.calls.find(c => c.method === "sendMessage")!.body.reply_markup.inline_keyboard[0][0]
			.callback_data;
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, { type: "action_resolved", id: "ask" });
		await daemon.handleTelegramUpdate({ callback_query: { id: "cb", data: alias, message: { chat: { id: 42 } } } });
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(bot.calls.some(c => c.method === "sendMessage" && String(c.body.text).includes("stale"))).toBe(true);
	});

	test("action_resolved clears reply message routes for that ask", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask",
			question: "Q",
			options: ["Y"],
		});
		const askMessageId = [...daemon.messageRoutes.entries()].find(
			([, route]) => route.sessionId === "S" && route.actionId === "ask",
		)?.[0];
		expect(askMessageId).toBeDefined();
		daemon.messageRoutes.set("same-session-other", { sessionId: "S", actionId: "other" });
		daemon.messageRoutes.set("other-session", { sessionId: "T", actionId: "ask" });

		await daemon.handleSessionMessage(daemon.sessions.get("S")!, { type: "action_resolved", id: "ask" });

		expect(daemon.messageRoutes.has(askMessageId!)).toBe(false);
		expect(daemon.messageRoutes.get("same-session-other")).toEqual({ sessionId: "S", actionId: "other" });
		expect(daemon.messageRoutes.get("other-session")).toEqual({ sessionId: "T", actionId: "ask" });
	});

	test("delayed close from replaced socket preserves fresh reply message routes", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://old", "old-token");
		const oldSocket = FakeWs.instances[0]!;
		daemon.connectSession("S", "ws://new", "new-token");
		const newSocket = FakeWs.instances[1]!;
		const newSession = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(newSession, {
			type: "action_needed",
			kind: "ask",
			id: "ask-new",
			question: "Q",
			options: ["Y"],
		});
		const askMessageId = [...daemon.messageRoutes.entries()].find(
			([, route]) => route.sessionId === "S" && route.actionId === "ask-new",
		)?.[0];
		expect(askMessageId).toBeDefined();

		oldSocket.close();

		expect(daemon.sessions.get("S")).toBe(newSession);
		expect(daemon.messageRoutes.has(askMessageId!)).toBe(true);
		await daemon.handleTelegramUpdate({
			message: { chat: { id: 42 }, text: "ok", reply_to_message: { message_id: Number(askMessageId) } },
		});
		expect(JSON.parse(newSocket.sent.at(-1)!)).toEqual({
			type: "reply",
			id: "ask-new",
			answer: "ok",
			token: "new-token",
		});
	});

	test("reply_to_message routes and non-paired chat leaks nothing", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		daemon.messageRoutes.set("55", { sessionId: "S", actionId: "A" });
		daemon.sessions.get("S")!.pending.set("A", { sessionId: "S", actionId: "A" });
		await daemon.handleTelegramUpdate({
			message: { chat: { id: "bad" }, text: "x", reply_to_message: { message_id: 55 } },
		});
		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(bot.calls).toHaveLength(0);
		await daemon.handleTelegramUpdate({
			message: { chat: { id: 42 }, text: "ok", reply_to_message: { message_id: 55 } },
		});
		expect(JSON.parse(FakeWs.instances[0]!.sent[0]!)).toEqual({ type: "reply", id: "A", answer: "ok", token: "ts" });
	});

	test("plain text answers a pending ask as free-input instead of injecting a new turn", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		// Emit an ask: creates the forum topic, registers the pending ask, sends the message.
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Name it?",
			options: ["a", "b"],
		});
		const askSend = bot.calls.find(c => c.method === "sendMessage");
		const threadId = askSend!.body.message_thread_id;

		// A plain free-text message in that topic answers the pending ask...
		await daemon.handleTelegramUpdate({
			update_id: 1,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "my typed answer", message_id: 99 },
		});

		const sent = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame));
		expect(sent).toContainEqual({ type: "reply", id: "ask1", answer: "my typed answer", token: "ts" });
		// ...and must NOT be injected as a new user turn.
		expect(sent.some(frame => frame.type === "user_message")).toBe(false);
		const visibleReceipt = bot.calls.find(
			c => c.method === "sendMessage" && c.body.message_thread_id === threadId && c.body.text === "Selected!",
		);
		expect(visibleReceipt).toBeUndefined();
	});

	test("deduplicates pending ask text before semantic acknowledgement completes", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		let markAckStarted: () => void = () => {};
		const ackStarted = new Promise<void>(resolve => {
			markAckStarted = resolve;
		});
		let releaseAck: () => void = () => {};
		const ackGate = new Promise<unknown>(resolve => {
			releaseAck = () => resolve({ ok: true, result: { message_id: 999 } });
		});
		class BlockingAckBotApi extends FakeBotApi {
			override async call(method: string, body: unknown): Promise<unknown> {
				if (method === "sendMessage" && (body as { text?: unknown }).text === "Selected!") {
					this.calls.push({ method, body });
					markAckStarted();
					return ackGate;
				}
				return super.call(method, body);
			}
		}
		const bot = new BlockingAckBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Name it?",
			options: ["a", "b"],
		});
		const askSend = bot.calls.find(c => c.method === "sendMessage");
		const threadId = askSend!.body.message_thread_id;
		const update = {
			update_id: 1,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "my typed answer", message_id: 99 },
		};
		await daemon.handleTelegramUpdate(update);
		const acknowledgement = daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "ask_selected_ack_request",
			mode: "live",
			requestId: "ack-1",
			commitKey: "commit-1",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		await ackStarted;
		await daemon.handleTelegramUpdate(update);
		const repliesBeforeAck = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame)).filter(
			frame => frame.type === "reply" && frame.id === "ask1",
		);
		expect(repliesBeforeAck).toHaveLength(1);
		releaseAck();
		await acknowledgement;
		expect(FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame))).toContainEqual({
			type: "ask_selected_ack_result",
			requestId: "ack-1",
			commitKey: "commit-1",
			outcome: { status: "delivered", messageId: 999 },
		});
	});

	test("deduplicates a semantic acknowledgement and sends Selected without HTML or retry metadata", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		const session = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(session, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Proceed?",
			options: ["yes", "no"],
		});
		await daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_request",
			mode: "live",
			requestId: "ack-1",
			commitKey: "commit-1",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		await daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_request",
			mode: "live",
			requestId: "ack-2",
			commitKey: "commit-1",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		const selectedCalls = bot.calls.filter(call => call.method === "sendMessage" && call.body.text === "Selected!");
		expect(selectedCalls).toHaveLength(1);
		expect(selectedCalls[0]?.body.parse_mode).toBeUndefined();
		const results = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame)).filter(
			frame => frame.type === "ask_selected_ack_result",
		);
		expect(results).toEqual([
			{
				type: "ask_selected_ack_result",
				requestId: "ack-1",
				commitKey: "commit-1",
				outcome: { status: "delivered", messageId: selectedCalls[0] ? bot.calls.indexOf(selectedCalls[0]) + 1 : 0 },
			},
			{
				type: "ask_selected_ack_result",
				requestId: "ack-2",
				commitKey: "commit-1",
				outcome: { status: "delivered", messageId: selectedCalls[0] ? bot.calls.indexOf(selectedCalls[0]) + 1 : 0 },
			},
		]);
	});

	test("reports an ambiguous Selected send failure after one application attempt", async () => {
		FakeWs.instances = [];
		class FailingSelectedBotApi extends FakeBotApi {
			override async call(method: string, body: unknown): Promise<unknown> {
				if (method === "sendMessage" && (body as { text?: unknown }).text === "Selected!") {
					this.calls.push({ method, body });
					throw new Error("connection reset after write");
				}
				return super.call(method, body);
			}
		}
		const agentDir = tempAgentDir();
		const bot = new FailingSelectedBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		const session = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(session, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Proceed?",
			options: ["yes"],
		});
		await daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_request",
			mode: "live",
			requestId: "ack-1",
			commitKey: "commit-1",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		await daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_request",
			mode: "live",
			requestId: "ack-2",
			commitKey: "commit-1",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		expect(bot.calls.filter(call => call.method === "sendMessage" && call.body.text === "Selected!")).toHaveLength(1);
		expect(FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame))).toContainEqual({
			type: "ask_selected_ack_result",
			requestId: "ack-1",
			commitKey: "commit-1",
			outcome: { status: "unknown", reason: "transport_ambiguous" },
		});
		expect(FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame))).toContainEqual({
			type: "ask_selected_ack_result",
			requestId: "ack-2",
			commitKey: "commit-1",
			outcome: { status: "unknown", reason: "transport_ambiguous" },
		});
	});

	test("rejects an expired acknowledgement without a Telegram send", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		const session = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(session, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Proceed?",
			options: ["yes"],
		});
		await daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_request",
			mode: "live",
			requestId: "ack-expired",
			commitKey: "commit-expired",
			actionId: "ask1",
			deadlineAt: Date.now() - 1,
		});

		expect(bot.calls.filter(call => call.method === "sendMessage" && call.body.text === "Selected!")).toHaveLength(0);
		expect(FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame))).toContainEqual({
			type: "ask_selected_ack_result",
			requestId: "ack-expired",
			commitKey: "commit-expired",
			outcome: { status: "failed", reason: "expired" },
		});
	});

	test("sends a live acknowledgement in flat private chat without a topic", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		const session = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(session, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Proceed?",
			options: ["yes"],
		});
		(daemon as unknown as { topics: Map<string, unknown> }).topics.delete("S");
		await daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_request",
			mode: "live",
			requestId: "ack-flat",
			commitKey: "commit-flat",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});

		const selected = bot.calls.find(call => call.method === "sendMessage" && call.body.text === "Selected!");
		expect(selected?.body).toEqual({ chat_id: "42", text: "Selected!" });
		expect(FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame))).toContainEqual({
			type: "ask_selected_ack_result",
			requestId: "ack-flat",
			commitKey: "commit-flat",
			outcome: expect.objectContaining({ status: "delivered" }),
		});
	});

	test("uses persisted topic authority for recovery without reopening an accepted ask", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		const session = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(session, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Proceed?",
			options: ["yes"],
		});
		await daemon.handleSessionMessage(session, { type: "action_resolved", id: "ask1" });
		expect(session.pending.has("ask1")).toBe(false);
		const restarted = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner-restarted",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		await restarted.loadTopics();
		restarted.connectSession("S", "ws://s-restarted", "ts-restarted");
		const recoveredSession = restarted.sessions.get("S")!;
		await restarted.handleSessionMessage(recoveredSession, {
			type: "ask_selected_ack_request",
			mode: "recovery",
			requestId: "recovery-1",
			commitKey: "commit-recovery",
			sessionId: "S",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		expect(recoveredSession.pending.has("ask1")).toBe(false);
		expect(bot.calls.filter(call => call.method === "sendMessage" && call.body.text === "Selected!")).toHaveLength(1);
		const sendsBeforeWrongSession = bot.calls.length;
		await restarted.handleSessionMessage(recoveredSession, {
			type: "ask_selected_ack_request",
			mode: "recovery",
			requestId: "recovery-2",
			commitKey: "commit-wrong-session",
			sessionId: "other",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		expect(bot.calls).toHaveLength(sendsBeforeWrongSession);
		expect(FakeWs.instances[1]!.sent.map(frame => JSON.parse(frame))).toContainEqual({
			type: "ask_selected_ack_result",
			requestId: "recovery-2",
			commitKey: "commit-wrong-session",
			outcome: { status: "failed", reason: "route_missing" },
		});
	});

	test("coalesces overlapping acknowledgement requests for the same commit", async () => {
		FakeWs.instances = [];
		const selectedStarted = Promise.withResolvers<void>();
		const releaseSelected = Promise.withResolvers<unknown>();
		class BlockingSelectedBotApi extends FakeBotApi {
			override async call(method: string, body: unknown): Promise<unknown> {
				if (method === "sendMessage" && (body as { text?: unknown }).text === "Selected!") {
					this.calls.push({ method, body });
					selectedStarted.resolve();
					return releaseSelected.promise;
				}
				return super.call(method, body);
			}
		}
		const agentDir = tempAgentDir();
		const bot = new BlockingSelectedBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		const session = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(session, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Proceed?",
			options: ["yes"],
		});
		const first = daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_request",
			mode: "live",
			requestId: "ack-1",
			commitKey: "same-commit",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		await selectedStarted.promise;
		await daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_request",
			mode: "live",
			requestId: "ack-2",
			commitKey: "same-commit",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		await daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_cancel",
			requestId: "ack-1",
			commitKey: "same-commit",
		});
		expect(bot.calls.filter(call => call.method === "sendMessage" && call.body.text === "Selected!")).toHaveLength(1);
		releaseSelected.resolve({ ok: true, result: { message_id: 88 } });
		await first;
		const results = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame)).filter(
			frame => frame.type === "ask_selected_ack_result",
		);
		expect(results).toContainEqual({
			type: "ask_selected_ack_result",
			requestId: "ack-1",
			commitKey: "same-commit",
			outcome: { status: "failed", reason: "cancelled" },
		});
		expect(results).toContainEqual({
			type: "ask_selected_ack_result",
			requestId: "ack-2",
			commitKey: "same-commit",
			outcome: { status: "delivered", messageId: 88 },
		});
	});

	test("endpoint replacement reuses the in-flight acknowledgement tombstone without a second POST", async () => {
		FakeWs.instances = [];
		const selectedStarted = Promise.withResolvers<void>();
		const releaseSelected = Promise.withResolvers<unknown>();
		class BlockingSelectedBotApi extends FakeBotApi {
			override async call(method: string, body: unknown): Promise<unknown> {
				if (method === "sendMessage" && (body as { text?: unknown }).text === "Selected!") {
					this.calls.push({ method, body });
					selectedStarted.resolve();
					return releaseSelected.promise;
				}
				return super.call(method, body);
			}
		}
		const agentDir = tempAgentDir();
		const bot = new BlockingSelectedBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as never,
		});
		daemon.connectSession("S", "ws://s", "ts");
		const session = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(session, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Proceed?",
			options: ["yes"],
		});
		const request = daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_request",
			mode: "live",
			requestId: "ack-drop",
			commitKey: "commit-drop",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		await selectedStarted.promise;
		(daemon as unknown as { dropSession(session: unknown, reason: string): void }).dropSession(
			session,
			"session_closed",
		);
		daemon.connectSession("S", "ws://replacement", "replacement-token");
		const replacement = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(replacement, {
			type: "ask_selected_ack_request",
			mode: "recovery",
			requestId: "ack-replacement",
			commitKey: "commit-drop",
			sessionId: "S",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		expect(bot.calls.filter(call => call.method === "sendMessage" && call.body.text === "Selected!")).toHaveLength(1);
		expect(FakeWs.instances[1]!.sent.map(frame => JSON.parse(frame))).toContainEqual({
			type: "ask_selected_ack_result",
			requestId: "ack-replacement",
			commitKey: "commit-drop",
			outcome: { status: "unknown", reason: "transport_ambiguous" },
		});
		releaseSelected.resolve({ ok: true, result: { message_id: 88 } });
		await request;
		const results = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame)).filter(
			frame => frame.type === "ask_selected_ack_result" && frame.requestId === "ack-drop",
		);
		expect(results).toEqual([
			{
				type: "ask_selected_ack_result",
				requestId: "ack-drop",
				commitKey: "commit-drop",
				outcome: { status: "unknown", reason: "transport_ambiguous" },
			},
		]);
	});

	test("cancels a drained acknowledgement before the Telegram application attempt", async () => {
		FakeWs.instances = [];
		const routeCheckStarted = Promise.withResolvers<void>();
		const releaseRouteCheck = Promise.withResolvers<void>();
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: setPrivateAgentDir(settings(agentDir), agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		const session = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(session, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Proceed?",
			options: ["yes"],
		});
		const routeCheckedDaemon = daemon as unknown as { pairedChatIsPrivate(): Promise<boolean> };
		routeCheckedDaemon.pairedChatIsPrivate = async () => {
			routeCheckStarted.resolve();
			await releaseRouteCheck.promise;
			return true;
		};
		const request = daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_request",
			mode: "live",
			requestId: "ack-cancel",
			commitKey: "commit-cancel",
			actionId: "ask1",
			deadlineAt: Date.now() + 8_000,
		});
		await routeCheckStarted.promise;
		await daemon.handleSessionMessage(session, {
			type: "ask_selected_ack_cancel",
			requestId: "ack-cancel",
			commitKey: "commit-cancel",
		});
		releaseRouteCheck.resolve();
		await request;
		expect(bot.calls.filter(call => call.method === "sendMessage" && call.body.text === "Selected!")).toHaveLength(0);
		expect(FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame))).toContainEqual({
			type: "ask_selected_ack_result",
			requestId: "ack-cancel",
			commitKey: "commit-cancel",
			outcome: { status: "failed", reason: "cancelled" },
		});
	});

	test("no-topic plain text does not answer the only pending ask", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Name it?",
			options: ["a", "b"],
		});

		await daemon.handleTelegramUpdate({
			update_id: 2,
			message: { chat: { id: 42 }, text: "my typed answer", message_id: 100 },
		});

		const sent = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame));
		expect(sent.some(frame => frame.type === "reply")).toBe(false);
		expect(sent.some(frame => frame.type === "user_message")).toBe(false);
	});

	test("plain text injects a user turn when no ask is pending", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		// Create the topic + pending via an ask, then resolve it so nothing is pending.
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Name it?",
			options: ["a", "b"],
		});
		const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, { type: "action_resolved", id: "ask1" });

		await daemon.handleTelegramUpdate({
			update_id: 7,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "start a new task", message_id: 100 },
		});

		const sent = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame));
		expect(sent.some(frame => frame.type === "user_message" && frame.text === "start a new task")).toBe(true);
		expect(sent.some(frame => frame.type === "reply")).toBe(false);
	});

	test("telegram control command forwards control_command instead of user_message", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "identity_header",
			sessionId: "S",
			repo: "r",
			branch: "b",
		});
		const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;

		await daemon.handleTelegramUpdate({
			update_id: 8,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "/context", message_id: 101 },
		});

		const sent = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame));
		expect(sent).toContainEqual({
			type: "control_command",
			sessionId: "S",
			token: "ts",
			requestId: "tg:8",
			updateId: 8,
			threadId: String(threadId),
			command: { name: "context" },
		});
		expect(sent.some(frame => frame.type === "user_message")).toBe(false);
	});
	test("unavailable private threaded controls publish seen state before one exact notice", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "identity_header",
			sessionId: "S",
			repo: "r",
			branch: "b",
		});
		const threadId = bot.calls.find(call => call.method === "sendMessage")!.body.message_thread_id;
		daemon.sessions.delete("S");
		bot.calls = [];
		const update = {
			update_id: 81,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "/usage", message_id: 101 },
		};
		await daemon.handleTelegramUpdate(update);
		await daemon.handleTelegramUpdate(update);
		expect(bot.calls.filter(call => call.method === "sendMessage").map(call => call.body.text)).toEqual([
			"Session control unavailable: this local GJC session is disconnected.",
		]);
	});
	test.each([
		"writeFile",
		"rename",
	] as const)("unavailable control %s failure is silent and does not retain the update in memory", async failingMethod => {
		let fail = true;
		const fsImpl: TelegramDaemonFs = {
			mkdir: (file, opts) => fs.promises.mkdir(file, opts).then(() => undefined),
			readFile: (file, encoding) => fs.promises.readFile(file, encoding),
			writeFile: (file, data, opts) =>
				fail && failingMethod === "writeFile" && file.includes("telegram-seen-updates")
					? Promise.reject(new Error("disk failure"))
					: fs.promises.writeFile(file, data, opts),
			rename: (oldPath, newPath) =>
				fail && failingMethod === "rename" && newPath.includes("telegram-seen-updates")
					? Promise.reject(new Error("rename failure"))
					: fs.promises.rename(oldPath, newPath).then(() => undefined),
			unlink: file => fs.promises.unlink(file),
			open: (file, flags, mode) => fs.promises.open(file, flags, mode),
			readdir: file => fs.promises.readdir(file),
			chmod: (file, mode) => fs.promises.chmod(file, mode),
		};
		const { bot, daemon, threadId } = await unavailableControlHarness(fsImpl);
		daemon.sessions.delete("S");
		const update = {
			update_id: 82,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "/usage", message_id: 102 },
		};
		await daemon.handleTelegramUpdate(update);
		expect(bot.calls.filter(call => call.method === "sendMessage")).toHaveLength(0);
		fail = false;
		await daemon.handleTelegramUpdate(update);
		expect(bot.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
	});

	test("unavailable control publishes state before notice and restart suppresses it", async () => {
		const { agentDir, bot, daemon, threadId } = await unavailableControlHarness();
		daemon.sessions.delete("S");
		let persistedBeforeSend = false;
		const originalCall = bot.call.bind(bot);
		bot.call = async (method, body) => {
			if (method === "sendMessage") persistedBeforeSend = fs.existsSync(daemonPaths(agentDir).seenUpdates);
			return originalCall(method, body);
		};
		const update = {
			update_id: 83,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "/usage", message_id: 103 },
		};
		await daemon.handleTelegramUpdate(update);
		expect(persistedBeforeSend).toBe(true);
		const restarted = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: "other",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		await restarted.loadTopics();
		await restarted.loadSeenUpdateIds();
		bot.calls = [];
		await restarted.handleTelegramUpdate(update);
		expect(bot.calls).toEqual([]);
	});

	test("private and media boundaries do not emit unavailable control notices", async () => {
		const { agentDir, bot, daemon, threadId } = await unavailableControlHarness();
		daemon.sessions.delete("S");
		bot.calls = [];
		Reflect.set(daemon, "pairedChatPrivate", undefined);
		const originalCall = bot.call.bind(bot);
		bot.call = async (method, body) => {
			if (method === "getChat") return { ok: true, result: { id: 42, type: "group" } };
			return originalCall(method, body);
		};
		await daemon.handleTelegramUpdate({
			update_id: 84,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "/usage", message_id: 104 },
		});
		expect(bot.calls.filter(call => call.method === "sendMessage")).toHaveLength(0);
		expect(fs.existsSync(daemonPaths(agentDir).seenUpdates)).toBe(false);
		bot.call = originalCall;
		bot.calls = [];
		await daemon.handleTelegramUpdate({
			update_id: 85,
			message: {
				chat: { id: 42 },
				message_thread_id: threadId,
				caption: "/usage",
				photo: [{ file_id: "photo" }],
				message_id: 105,
			},
		});
		expect(bot.calls.filter(call => call.method === "sendMessage")).toHaveLength(0);
	});

	test("non-open sockets publish once even when the unavailable notice send fails", async () => {
		const { bot, daemon, threadId } = await unavailableControlHarness();
		FakeWs.instances[0]!.setReadyState(3);
		let sendAttempts = 0;
		const originalCall = bot.call.bind(bot);
		bot.call = async (method, body) => {
			if (method === "sendMessage") {
				sendAttempts += 1;
				throw new Error("network failure");
			}
			return originalCall(method, body);
		};
		const update = {
			update_id: 86,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "/usage", message_id: 106 },
		};
		await daemon.handleTelegramUpdate(update);
		await daemon.handleTelegramUpdate(update);
		expect(sendAttempts).toBe(1);
	});

	test("session cleanup leaves its former topic unknown", async () => {
		const { bot, daemon, threadId } = await unavailableControlHarness();
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, { type: "session_closed", sessionId: "S" });
		bot.calls = [];
		await daemon.handleTelegramUpdate({
			update_id: 87,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "/usage", message_id: 107 },
		});
		expect(bot.calls).toEqual([]);
	});

	test("invalid telegram control command returns usage once without answering pending ask", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Name it?",
			options: ["a", "b"],
		});
		const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;
		const askMessageId = bot.calls.findIndex(c => c.method === "sendMessage") + 1;

		await daemon.handleTelegramUpdate({
			update_id: 9,
			message: {
				chat: { id: 42 },
				message_thread_id: threadId,
				text: "/reasoning impossible",
				message_id: 102,
				reply_to_message: { message_id: askMessageId },
			},
		});

		const sent = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame));
		expect(sent.some(frame => frame.type === "reply")).toBe(false);
		expect(sent.some(frame => frame.type === "user_message")).toBe(false);
		const usageMessages = () =>
			bot.calls.filter(c => c.method === "sendMessage" && String(c.body.text).startsWith("Usage: /reasoning"));
		expect(usageMessages()).toHaveLength(1);
		await daemon.handleTelegramUpdate({
			update_id: 9,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "/reasoning impossible", message_id: 102 },
		});
		expect(usageMessages()).toHaveLength(1);
	});

	test("wrong-suffix telegram control command is consumed, not injected or ask-answered", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
		});
		Object.assign(daemon, { botUsername: "GajaeCodeBot" });
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Name it?",
			options: ["a", "b"],
		});
		const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;
		bot.calls = [];

		await daemon.handleTelegramUpdate({
			update_id: 10,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "/context@OtherBot", message_id: 103 },
		});

		const sent = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame));
		expect(sent.some(frame => frame.type === "reply")).toBe(false);
		expect(sent.some(frame => frame.type === "user_message")).toBe(false);
		expect(sent.some(frame => frame.type === "control_command")).toBe(false);
		expect(bot.calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
	});

	test("persisted seen update ids suppress duplicate threaded injection after restart", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "identity_header",
			sessionId: "S",
			repo: "r",
			branch: "b",
		});
		const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;

		await daemon.handleTelegramUpdate({
			update_id: 77,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "repeat once", message_id: 100 },
		});

		const sent = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame));
		expect(sent.some(frame => frame.type === "user_message" && frame.text === "repeat once")).toBe(true);
		const seenState = JSON.parse(fs.readFileSync(daemonPaths(agentDir).seenUpdates, "utf8")) as {
			updateIds: number[];
		};
		expect(seenState.updateIds).toContain(77);

		FakeWs.instances = [];
		const restarted = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner-2",
			botToken: "tok",
			chatId: "42",
			botApi: new FakeBotApi(),
			WebSocketImpl: FakeWs as any,
		});
		await restarted.loadTopics();
		await restarted.loadSeenUpdateIds();
		restarted.connectSession("S", "ws://s2", "ts2");

		await restarted.handleTelegramUpdate({
			update_id: 77,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "repeat once", message_id: 101 },
		});

		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
	});

	test("runDaemonSmoke exits without polling and emits no token", async () => {
		const agentDir = tempAgentDir();
		await runDaemonSmoke({ agentDir });
		expect(fs.readdirSync(daemonPaths(agentDir).dir).join("\n")).not.toContain("secret-token");
	});

	test("heartbeat renew and release helpers honor owner id", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		await acquireDaemonOwnership({
			settings: s,
			tokenFingerprint: "fp",
			chatId: "42",
			pid: process.pid,
			randomId: () => "owner",
		});
		expect(await renewDaemonHeartbeat({ settings: s, ownerId: "other" })).toBe(false);
		expect(await renewDaemonHeartbeat({ settings: s, ownerId: "owner" })).toBe(true);
		await releaseDaemonOwnership({ settings: s, ownerId: "other" });
		expect(fs.existsSync(daemonPaths(agentDir).lock)).toBe(true);
		await releaseDaemonOwnership({ settings: s, ownerId: "owner" });
		expect(fs.existsSync(daemonPaths(agentDir).lock)).toBe(false);
	});

	test("scan timer connects new sessions while a getUpdates long-poll is in flight", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		await acquireDaemonOwnership({
			settings: s,
			tokenFingerprint: "fp",
			chatId: "42",
			pid: process.pid,
			randomId: () => "owner",
		});

		// Endpoint discovery files live at <cwd>/.gjc/state/sdk/<sessionId>.json.
		const writeEndpoint = async (cwd: string, sessionId: string, url: string) => {
			await registerNotificationRoot({ settings: s, cwd, sessionId });
			const dir = path.join(cwd, ".gjc", "state", "sdk");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ url, token: "tok" }));
		};

		// Session A exists from the start so the run loop reaches the long-poll branch.
		await writeEndpoint(path.join(agentDir, "cwd-a"), "A", "ws://a");

		// getUpdates blocks (simulating the 25s long-poll) until released, so the
		// run loop's own scanRoots call cannot pick up session B.
		let releasePoll: () => void = () => {};
		const pollGate = new Promise<void>(resolve => {
			releasePoll = resolve;
		});
		const inner = new FakeBotApi();
		const gatedBot = {
			get calls() {
				return inner.calls;
			},
			async call(method: string, body: unknown): Promise<unknown> {
				if (method === "getUpdates") {
					await pollGate;
					return { ok: true, result: [] };
				}
				return inner.call(method, body);
			},
		};

		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: gatedBot,
			WebSocketImpl: FakeWs as any,
			scanIntervalMs: 5,
			idleTimeoutMs: 60_000,
			createLifecycleControlServer: null,
		});

		const until = async (pred: () => boolean, ms = 2000) => {
			const start = Date.now();
			while (!pred()) {
				if (Date.now() - start > ms) throw new Error("condition not met in time");
				await new Promise(r => setTimeout(r, 5));
			}
		};

		const runPromise = daemon.run();
		await until(() => daemon.sessions.has("A"));

		// Session B starts AFTER the loop is blocked in the long-poll. The scan timer
		// (not the long-poll-gated loop scan) must connect it promptly.
		await writeEndpoint(path.join(agentDir, "cwd-b"), "B", "ws://b");
		await until(() => daemon.sessions.has("B"));
		expect(daemon.sessions.has("B")).toBe(true);

		// Stop: hand ownership to another owner so the next heartbeat renew fails,
		// then release the long-poll so the loop can observe it and exit.
		fs.writeFileSync(
			daemonPaths(agentDir).state,
			JSON.stringify({ version: DAEMON_VERSION, ownerId: "other", pid: 1, heartbeatAt: 0 }),
		);
		releasePoll();
		await runPromise;
	});

	test("pollOnce survives a transient getUpdates failure instead of crashing", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		let calls = 0;
		const bot = {
			async call(method: string): Promise<unknown> {
				if (method === "getUpdates") {
					calls++;
					const err = new Error("The socket connection was closed unexpectedly.") as Error & { code?: string };
					err.code = "ECONNRESET";
					throw err;
				}
				return { ok: true, result: [] };
			},
		};
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			setTimeoutImpl: ((cb: () => void) => {
				cb();
				return 0;
			}) as any,
		});
		// Must resolve (not reject): the run loop relies on this never throwing.
		await expect(daemon.pollOnce()).resolves.toBe(0);
		expect(calls).toBe(1);
	});

	test("default botApi retries transient network failures before delivering", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts++;
			if (attempts < 3) {
				const err = new Error("socket reset") as Error & { code?: string };
				err.code = "ECONNRESET";
				throw err;
			}
			return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			fetchImpl,
			setTimeoutImpl: ((cb: () => void) => {
				cb();
				return 0;
			}) as any,
		});
		const res = (await (daemon as any).botApi.call("sendMessage", { chat_id: 42, text: "hi" })) as {
			result?: { message_id?: number };
		};
		expect(attempts).toBe(3);
		expect(res.result?.message_id).toBe(7);
	});
});

describe("telegram daemon connection-drop resilience (repro-first)", () => {
	// Phase 1 / AC-1: half-open daemon->session WebSocket. The socket stays
	// readyState OPEN, accepts send(), and never dispatches 'close'. On current
	// code there is no per-session liveness, so a stale half-open socket lives in
	// the sessions map forever and scanRoots() (which skips when sessions.has(id))
	// never reconnects. This test asserts the DESIRED post-fix recovery and is
	// therefore RED on current code.
	test("AC-1/AC-2: half-open session socket is detected and reconnected", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const cwd = path.join(agentDir, "sess-cwd");
		await registerNotificationRoot({ settings: s, cwd, sessionId: "S" });
		const roots = JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8")) as { roots: string[] };
		const endpointDir = path.join(roots.roots[0]!, "sdk");
		fs.mkdirSync(endpointDir, { recursive: true });
		fs.writeFileSync(path.join(endpointDir, "S.json"), JSON.stringify({ url: "ws://s", token: "ts" }));

		let now = 0;
		const liveness: Array<() => void> = [];
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: new FakeBotApi(),
			WebSocketImpl: FakeWs as any,
			now: () => now,
			setIntervalImpl: ((cb: () => void) => {
				liveness.push(cb);
				return 0;
			}) as any,
			clearIntervalImpl: (() => {}) as any,
		});

		await daemon.scanRoots();
		expect(FakeWs.instances).toHaveLength(1);
		expect(daemon.sessions.has("S")).toBe(true);

		// The native server advertises the ping/pong capability so ack-based
		// liveness can start; then the link goes half-open (no further frames,
		// socket never closes, no pong will arrive).
		FakeWs.instances[0]!.emit({ type: "hello", protocolVersion: 2, capabilities: ["client_ping_pong"] });

		// Advance past the heartbeat TTL and fire any liveness probe. Post-fix this
		// detects the missing pong, drops the stale session, and reconnects.
		now += 25_000;
		for (const cb of liveness) cb();
		await Promise.resolve();
		await daemon.scanRoots();

		expect(FakeWs.instances).toHaveLength(2);
		expect(daemon.sessions.get("S")?.ws).toBe(FakeWs.instances[1] as unknown as WebSocket);
		expect(FakeWs.instances[1]!.readyState).toBe(FakeWs.OPEN);
	});

	// Phase 1 / AC-7: a getUpdates rejection during an internet outage must not
	// kill the daemon. On current code run() awaits pollOnce() with no try/catch,
	// so the rejection unwinds run() and releases ownership. This asserts the
	// DESIRED survival (run resolves) and is RED on current code (run rejects).
	test("AC-7: getUpdates rejection during outage does not terminate the daemon", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		await acquireDaemonOwnership({
			settings: s,
			tokenFingerprint: "fp",
			chatId: "42",
			pid: process.pid,
			randomId: () => "owner",
		});

		let now = 0;
		let getUpdatesCalls = 0;
		const bot = {
			calls: [] as Array<{ method: string; body: any }>,
			async call(method: string, body: unknown): Promise<unknown> {
				this.calls.push({ method, body });
				if (method === "getUpdates") {
					getUpdatesCalls++;
					if (getUpdatesCalls === 1) {
						// Drop the only session so the next loop iteration idle-exits
						// once the daemon survives the rejection (post-fix path).
						daemon.sessions.get("S")?.ws.close();
						throw new Error("network down: getUpdates rejected");
					}
					return { ok: true, result: [] };
				}
				return { ok: true, result: true };
			},
		};

		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
			idleTimeoutMs: 10,
			now: () => (now += 1000),
			setTimeoutImpl: ((cb: () => void) => {
				cb();
				return 0;
			}) as any,
			setIntervalImpl: (() => 0) as any,
			clearIntervalImpl: (() => {}) as any,
		});
		daemon.connectSession("S", "ws://s", "ts");

		await expect(daemon.run()).resolves.toBeUndefined();
		expect(getUpdatesCalls).toBeGreaterThanOrEqual(1);
	});
});

test("daemon registers in-thread config and lifecycle commands and drops stale rpc/answer commands", async () => {
	const s = settings(tempAgentDir());
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	await daemon.registerBotCommands();
	const call = bot.calls.find((c: any) => c.method === "setMyCommands");
	expect(call).toBeTruthy();
	const cmds = (call!.body.commands as Array<{ command: string }>).map(c => c.command);
	expect(cmds).toContain("verbose");
	expect(cmds).toContain("lean");
	expect(cmds).toContain("redact");
	const verbose = (call!.body.commands as Array<{ command: string; description: string }>).find(
		command => command.command === "verbose",
	);
	expect(verbose?.description).toBe("Mirror bounded tool-owned summaries + provider-displayable reasoning summaries");
	expect(cmds).toContain("session_create");
	expect(cmds).toContain("session_recent");
	expect(cmds).toContain("session_close");
	expect(cmds).toContain("model");
	expect(cmds).toContain("session_resume");
	expect(cmds).not.toContain("answer");
	expect(cmds).not.toContain("attach");
	expect(cmds).not.toContain("detach");
});
test("forum lifecycle commands fail closed even when addressed to this bot username", async () => {
	const bot = new FakeBotApi();
	bot.call = (async (method: string, body: any) => {
		bot.calls.push({ method, body });
		if (method === "getChat") return { ok: true, result: { id: body.chat_id, type: "supergroup" } };
		if (method === "sendMessage") return { ok: true, result: { message_id: bot.calls.length } };
		return { ok: true, result: true };
	}) as any;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(tempAgentDir()),
		ownerId: "owner",
		botToken: "tok",
		chatId: "-10042",
		botApi: bot,
	});
	Object.assign(daemon, { lifecycleControlActive: true, botUsername: "GajaeCodeBot" });

	await daemon.handleTelegramUpdate({
		update_id: 101,
		message: { chat: { id: -10042, type: "supergroup" }, text: "/session_recent", message_id: 1 },
	});
	await daemon.handleTelegramUpdate({
		update_id: 102,
		message: { chat: { id: -10042, type: "supergroup" }, text: "/session_recent@OtherBot", message_id: 2 },
	});
	await daemon.handleTelegramUpdate({
		update_id: 103,
		message: { chat: { id: -10042, type: "supergroup" }, text: "/session_recent@GajaeCodeBot", message_id: 3 },
	});

	expect(bot.calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
	expect(bot.calls.filter(c => c.method === "getChat")).toHaveLength(0);
});

test("forum lifecycle commands fail closed when bot username is unavailable", async () => {
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(tempAgentDir()),
		ownerId: "owner",
		botToken: "tok",
		chatId: "-10042",
		botApi: bot,
	});
	Object.assign(daemon, { lifecycleControlActive: true });

	await daemon.handleTelegramUpdate({
		update_id: 104,
		message: { chat: { id: -10042, type: "supergroup" }, text: "/session_recent@GajaeCodeBot", message_id: 4 },
	});

	expect(bot.calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
});

test("non-addressable forum lifecycle commands in known topics are dropped", async () => {
	let updateId = 200;
	const exercise = async (text: string, botUsername?: string): Promise<void> => {
		FakeWs.instances = [];
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: settings(tempAgentDir()),
			ownerId: "owner",
			botToken: "tok",
			chatId: "-10042",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		Object.assign(daemon, { lifecycleControlActive: true, botUsername });
		daemon.connectSession("S", "ws://s", "ts");
		const session = daemon.sessions.get("S")!;
		await daemon.handleSessionMessage(session, { type: "identity_header", sessionId: "S", repo: "r", branch: "b" });
		const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;
		bot.calls = [];

		await daemon.handleTelegramUpdate({
			update_id: updateId++,
			message: {
				chat: { id: -10042, type: "supergroup" },
				message_thread_id: threadId,
				message_id: updateId,
				text,
			},
		});

		expect(FakeWs.instances[0]!.sent).toHaveLength(0);
		expect(bot.calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
	};

	await exercise("/session_recent", "GajaeCodeBot");
	await exercise("/session_recent@OtherBot", "GajaeCodeBot");
	await exercise("/session_recent@GajaeCodeBot");
});

test("ensureTelegramDaemonRunning spawns the daemon subcommand with owner-id and agent-dir", async () => {
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	let captured: { command: string; args: string[] } | undefined;
	const res = await ensureTelegramDaemonRunning(
		{ settings: s, cwd: path.join(agentDir, "cwd"), sessionId: "s1" },
		{
			spawn: (command, args) => {
				captured = { command, args };
				return { unref() {} };
			},
			pidAlive: () => true,
			pid: 111,
		},
	);
	expect(res).toBe("owner_spawned");
	expect(captured).toBeTruthy();
	expect(captured!.args).toContain("notify");
	expect(captured!.args).toContain("daemon-internal");
	expect(captured!.args).toContain("--owner-id");
	const ai = captured!.args.indexOf("--agent-dir");
	expect(ai).toBeGreaterThanOrEqual(0);
	expect(captured!.args[ai + 1]).toBe(agentDir);
});
test("image_attachment frame uploads via sendPhoto into an identified session topic", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	const session = {
		sessionId: "S",
		token: "tok",
		ws: { readyState: 1, send() {} },
		pending: new Map(),
	};
	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
	});
	await daemon.handleSessionMessage(session as any, {
		type: "image_attachment",
		sessionId: "S",
		source: "computer",
		mime: "image/png",
		data: "AAAA",
	});
	const createTopic = bot.calls.find(c => c.method === "createForumTopic");
	const photo = bot.calls.find(c => c.method === "sendPhoto");
	expect(createTopic).toBeTruthy();
	expect(createTopic!.body.name).toBe("gajae-code/dev");
	expect(photo).toBeTruthy();
	expect(photo!.body.photo).toBe("AAAA");
	expect(Number(photo!.body.message_thread_id)).toBeGreaterThan(0);
});

describe("telegram topic name template (#1909)", () => {
	async function createdTopicName(
		identity: { repo?: string; branch?: string; title?: string },
		topics?: { nameTemplate?: string },
	): Promise<string | undefined> {
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			topics,
		});
		const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
		await daemon.handleSessionMessage(session as never, {
			type: "identity_header",
			sessionId: "S",
			...identity,
		});
		return bot.calls.find(c => c.method === "createForumTopic")?.body.name as string | undefined;
	}

	test("unset template preserves the built-in {repo}/{branch} - {title} composition", async () => {
		expect(await createdTopicName({ repo: "gajae-code", branch: "dev", title: "Fix flaky retries" })).toBe(
			"gajae-code/dev - Fix flaky retries",
		);
	});

	test("configured template renders the session title first", async () => {
		expect(
			await createdTopicName(
				{ repo: "gajae-code", branch: "dev", title: "Fix flaky retries" },
				{ nameTemplate: "{title} · {repo}/{branch}" },
			),
		).toBe("Fix flaky retries · gajae-code/dev");
	});

	test("a referenced placeholder with no value falls back to the default composition (no dangling separator)", async () => {
		// Before a session title exists, the title-first template must NOT render
		// "· gajae-code/dev"; it falls back to the built-in composition instead.
		expect(
			await createdTopicName({ repo: "gajae-code", branch: "dev" }, { nameTemplate: "{title} · {repo}/{branch}" }),
		).toBe("gajae-code/dev");
	});

	test("a repo-less session with a template falls back to the session-id default", async () => {
		expect(await createdTopicName({}, { nameTemplate: "{title} · {repo}/{branch}" })).toBe("GJC S");
	});

	test("a blank template is ignored so behavior is unchanged", async () => {
		expect(
			await createdTopicName({ repo: "gajae-code", branch: "dev", title: "Ship it" }, { nameTemplate: "   " }),
		).toBe("gajae-code/dev - Ship it");
	});

	test("a title-only template renders just the title, falling back when the title is absent", async () => {
		expect(
			await createdTopicName({ repo: "gajae-code", branch: "dev", title: "Ship it" }, { nameTemplate: "{title}" }),
		).toBe("Ship it");
		expect(await createdTopicName({ repo: "gajae-code", branch: "dev" }, { nameTemplate: "{title}" })).toBe(
			"gajae-code/dev",
		);
	});

	test("unknown placeholders are left verbatim", async () => {
		expect(
			await createdTopicName(
				{ repo: "gajae-code", branch: "dev", title: "Ship it" },
				{ nameTemplate: "{title} [{env}]" },
			),
		).toBe("Ship it [{env}]");
	});

	test("a later title header renames the topic using the configured template", async () => {
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			topics: { nameTemplate: "{title} · {repo}/{branch}" },
		});
		const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
		await daemon.handleSessionMessage(session as never, {
			type: "identity_header",
			sessionId: "S",
			repo: "gajae-code",
			branch: "dev",
		});
		await daemon.handleSessionMessage(session as never, {
			type: "identity_header",
			sessionId: "S",
			repo: "gajae-code",
			branch: "dev",
			title: "Second title",
		});
		expect(bot.calls.filter(c => c.method === "createForumTopic").map(c => c.body.name)).toEqual(["gajae-code/dev"]);
		expect(bot.calls.filter(c => c.method === "editForumTopic").map(c => c.body.name)).toEqual([
			"Second title · gajae-code/dev",
		]);
	});
});

test("identity-less threaded frames wait for identity instead of creating fallback topics", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };

	await daemon.handleSessionMessage(session as any, {
		type: "image_attachment",
		sessionId: "S",
		source: "computer",
		mime: "image/png",
		data: "AAAA",
	});
	expect(bot.calls.find(c => c.method === "createForumTopic")).toBeUndefined();
	expect(bot.calls.find(c => c.method === "sendPhoto")).toBeUndefined();

	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
	});
	const createTopic = bot.calls.find(c => c.method === "createForumTopic");
	const photo = bot.calls.find(c => c.method === "sendPhoto");
	expect(createTopic).toBeTruthy();
	expect(createTopic!.body.name).toBe("gajae-code/dev");
	expect(photo).toBeTruthy();
	expect(photo!.body.message_thread_id).toBeGreaterThan(0);
});
test("transient topic rename failure is retried on the next identity header", async () => {
	class RetryRenameBotApi extends FakeBotApi {
		editAttempts = 0;
		override async call(method: string, body: unknown): Promise<unknown> {
			if (method === "editForumTopic") {
				this.editAttempts++;
				this.calls.push({ method, body });
				if (this.editAttempts === 1) throw new Error("temporary rename failure");
				return { ok: true, result: true };
			}
			return super.call(method, body);
		}
	}

	const agentDir = tempAgentDir();
	const bot = new RetryRenameBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };

	await daemon.handleSessionMessage(session as any, {
		type: "action_needed",
		kind: "ask",
		id: "ask1",
		question: "Name it?",
		options: ["a", "b"],
	});
	expect(bot.calls.find(c => c.method === "createForumTopic")!.body.name).toBe("GJC S");

	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Readable title",
	});
	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Readable title",
	});

	const edits = bot.calls.filter(c => c.method === "editForumTopic");
	expect(edits).toHaveLength(2);
	expect(edits.map(c => c.body.name)).toEqual(["gajae-code/dev - Readable title", "gajae-code/dev - Readable title"]);
});

test("a delayed user topic rename is immediately restored after a completed daemon edit", async () => {
	const { agentDir, bot, daemon, session, threadId } = await identityTopicHarness({ title: "First title" });
	await daemon.handleSessionMessage(session as never, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Generated title",
	});
	bot.calls = [];

	await daemon.handleTelegramUpdate(forumTopicEditedUpdate(41, threadId, "My focus"));
	const persisted = await readTopicAuthorityState(agentDir);
	expect(bot.calls.filter(c => c.method === "editForumTopic").map(c => c.body.name)).toEqual(["My focus"]);
	expect(persisted.topics.S).toMatchObject({ name: "My focus", nameOwner: "user", nameReconcilePending: false });

	bot.calls = [];
	await daemon.handleSessionMessage(session as never, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Later generated title",
	});
	expect(bot.calls.filter(c => c.method === "editForumTopic")).toHaveLength(0);
});

test("bot-originated topic edit service messages do not claim user ownership", async () => {
	const { bot, daemon, session, threadId } = await identityTopicHarness({ title: "First title" });
	bot.calls = [];

	for (const [updateId, name, overrides] of [
		[42, "Bot echo", { from: { id: 42, is_bot: true } }],
		[43, "Wrong user", { from: { id: 7, is_bot: false } }],
		[44, "String chat", { chat: { id: "42" } }],
		[45, "Unknown bot status", { from: { id: 42 } }],
		[46, "Missing sender", { from: null }],
	] as const) {
		await daemon.handleTelegramUpdate(forumTopicEditedUpdate(updateId, threadId, name, overrides));
	}
	expect(bot.calls.filter(c => c.method === "editForumTopic")).toHaveLength(0);
	await daemon.handleSessionMessage(session as never, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Second title",
	});
	expect(bot.calls.filter(c => c.method === "editForumTopic").map(c => c.body.name)).toEqual([
		"gajae-code/dev - Second title",
	]);
});

test("a user rename racing an in-flight daemon edit is restored after the daemon edit", async () => {
	class RacingRenameBotApi extends FakeBotApi {
		readonly daemonEditStarted = Promise.withResolvers<void>();
		readonly releaseDaemonEdit = Promise.withResolvers<void>();

		override async call(method: string, body: unknown): Promise<unknown> {
			const name = (body as { name?: unknown } | null)?.name;
			if (method === "editForumTopic" && name === "gajae-code/dev - Generated title") {
				this.calls.push({ method, body });
				this.daemonEditStarted.resolve();
				await this.releaseDaemonEdit.promise;
				return { ok: true, result: true };
			}
			return super.call(method, body);
		}
	}

	const bot = new RacingRenameBotApi();
	const { daemon, session, threadId } = await identityTopicHarness({ bot, title: "First title" });
	bot.calls = [];

	const identityUpdate = daemon.handleSessionMessage(session as never, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Generated title",
	});
	await bot.daemonEditStarted.promise;
	await daemon.handleTelegramUpdate(forumTopicEditedUpdate(43, threadId, "My focus"));
	const laterIdentity = daemon.handleSessionMessage(session as never, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Later generated title",
	});
	await laterIdentity;
	expect(bot.calls.filter(c => c.method === "editForumTopic").map(c => c.body.name)).toEqual([
		"gajae-code/dev - Generated title",
	]);
	bot.releaseDaemonEdit.resolve();
	await identityUpdate;

	expect(bot.calls.filter(c => c.method === "editForumTopic").map(c => c.body.name)).toEqual([
		"gajae-code/dev - Generated title",
		"My focus",
	]);
	bot.calls = [];
	await daemon.handleSessionMessage(session as never, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Another generated title",
	});
	expect(bot.calls.some(c => c.method === "editForumTopic")).toBe(false);
});

test("concurrent user renames persist the newest pending ownership state", async () => {
	const firstWriteStarted = Promise.withResolvers<void>();
	const releaseFirstWrite = Promise.withResolvers<void>();
	let blockNextTopicWrite = false;
	const fsImpl = topicStateFs(async () => {
		if (blockNextTopicWrite) {
			blockNextTopicWrite = false;
			firstWriteStarted.resolve();
			await releaseFirstWrite.promise;
		}
	});
	const { agentDir, daemon, threadId } = await identityTopicHarness({ fs: fsImpl });

	blockNextTopicWrite = true;
	const firstRename = daemon.handleTelegramUpdate(forumTopicEditedUpdate(45, threadId, "First focus"));
	await firstWriteStarted.promise;
	const secondRename = daemon.handleTelegramUpdate(forumTopicEditedUpdate(46, threadId, "Latest focus"));
	releaseFirstWrite.resolve();
	await Promise.all([firstRename, secondRename]);

	const state = await readTopicAuthorityState(agentDir);
	expect(state.topics.S).toMatchObject({
		name: "Latest focus",
		nameOwner: "user",
		nameReconcilePending: false,
	});
});

test("topic-state write failure retries the rename before later Telegram updates", async () => {
	let failNextTopicWrite = false;
	const fsImpl = topicStateFs(async () => {
		if (failNextTopicWrite) {
			failNextTopicWrite = false;
			throw new Error("injected topic-state write failure");
		}
	});
	const bot = new ReplayRenameBotApi();
	const { agentDir, daemon, threadId } = await identityTopicHarness({ bot, fs: fsImpl });
	bot.threadId = threadId;
	failNextTopicWrite = true;

	await daemon.pollOnce();
	const failedState = await readTopicAuthorityState(agentDir);
	expect(failedState.topics.S).not.toMatchObject({ name: "First focus", nameOwner: "user" });

	await daemon.pollOnce();
	await daemon.pollOnce();
	const persistedState = await readTopicAuthorityState(agentDir);
	expect(persistedState.topics.S).toMatchObject({
		name: "Later focus",
		nameOwner: "user",
		nameReconcilePending: false,
		userNameUpdateId: 51,
	});
	expect(bot.calls.filter(call => call.method === "getUpdates").map(call => call.body.offset)).toEqual([0, 0, 52]);
	expect(bot.calls.filter(call => call.method === "editForumTopic").map(call => call.body.name)).toEqual([
		"First focus",
		"Later focus",
	]);
});

test.each([
	[
		"thrown getChat",
		() => {
			throw new Error("getChat unavailable");
		},
	],
	["getChat ok:false", () => ({ ok: false, description: "temporary failure" })],
	["malformed getChat", () => ({ ok: true, result: {} })],
])("indeterminate %s retries a forum rename before dispatching later updates", async (_name, getChatFailure) => {
	const bot = new ReplayRenameBotApi();
	const { agentDir } = await identityTopicHarness({ bot, ownerId: "creator" });
	bot.threadId = bot.calls.find(call => call.method === "sendMessage")!.body.message_thread_id;
	bot.calls = [];
	bot.getChatFailure = getChatFailure;

	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "retry",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	await daemon.loadTopics();

	await daemon.pollOnce();
	const beforePrivacySucceeds = await readTopicAuthorityState(agentDir);
	expect(beforePrivacySucceeds.topics.S).not.toMatchObject({ nameOwner: "user" });
	expect(bot.calls.filter(call => call.method === "getUpdates").map(call => call.body.offset)).toEqual([0]);

	await daemon.pollOnce();
	await daemon.pollOnce();
	const durableState = await readTopicAuthorityState(agentDir);
	expect(durableState.topics.S).toMatchObject({
		name: "Later focus",
		nameOwner: "user",
		userNameUpdateId: 51,
	});
	expect(bot.calls.filter(call => call.method === "getUpdates").map(call => call.body.offset)).toEqual([0, 0, 52]);
});

test("remote-success user-name reconciliation retries after its pending-clear write fails", async () => {
	let successfulTopicWritesBeforeFailure: number | undefined;
	const fsImpl = topicStateFs(async () => {
		if (successfulTopicWritesBeforeFailure === undefined) return;
		if (successfulTopicWritesBeforeFailure > 0) {
			successfulTopicWritesBeforeFailure--;
			return;
		}
		successfulTopicWritesBeforeFailure = undefined;
		throw new Error("injected pending-clear write failure");
	});
	const firstBot = new FakeBotApi();
	const {
		agentDir,
		daemon: firstDaemon,
		session,
		threadId,
	} = await identityTopicHarness({ bot: firstBot, fs: fsImpl });
	successfulTopicWritesBeforeFailure = 1;
	await firstDaemon.handleTelegramUpdate(forumTopicEditedUpdate(44, threadId, "My focus"));
	expect(firstBot.calls.filter(c => c.method === "editForumTopic").map(c => c.body.name)).toEqual(["My focus"]);
	const persistedState = await readTopicAuthorityState(agentDir);
	expect(persistedState.topics.S).toMatchObject({
		name: "My focus",
		nameOwner: "user",
		nameReconcilePending: true,
	});

	const retryBot = new FakeBotApi();
	const restarted = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner-2",
		botToken: "tok",
		chatId: "42",
		botApi: retryBot,
	});
	await restarted.loadTopics();
	await restarted.handleSessionMessage(session as never, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Later generated title",
	});
	expect(retryBot.calls.filter(c => c.method === "editForumTopic").map(c => c.body.name)).toEqual(["My focus"]);
});

test.each([
	[
		"throw",
		() => {
			throw new Error("temporary reconciliation failure");
		},
	],
	["ok:false", () => ({ ok: false, description: "temporary reconciliation failure" })],
])("user-name reconciliation %s remains retryable after restart", async (_name, failure) => {
	class FailingUserRenameBotApi extends FakeBotApi {
		override async call(method: string, body: unknown): Promise<unknown> {
			if (method === "editForumTopic" && (body as { name?: unknown }).name === "My focus") {
				this.calls.push({ method, body });
				return failure();
			}
			return super.call(method, body);
		}
	}

	const failingBot = new FailingUserRenameBotApi();
	const { agentDir, daemon: firstDaemon, session, threadId } = await identityTopicHarness({ bot: failingBot });
	await firstDaemon.handleTelegramUpdate(forumTopicEditedUpdate(47, threadId, "My focus"));
	await firstDaemon.handleSessionMessage(session as never, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Later generated title",
	});

	const retryBot = new FakeBotApi();
	const restarted = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner-2",
		botToken: "tok",
		chatId: "42",
		botApi: retryBot,
	});
	await restarted.loadTopics();
	await restarted.handleSessionMessage(session as never, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Later generated title",
	});
	expect(retryBot.calls.filter(c => c.method === "editForumTopic").map(c => c.body.name)).toEqual(["My focus"]);
});
test("live sessions with the same repo branch create distinct topics", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		WebSocketImpl: FakeWs as any,
	});
	daemon.connectSession("S1", "ws://s1", "t1");
	daemon.connectSession("S2", "ws://s2", "t2");
	const first = daemon.sessions.get("S1")!;
	const second = daemon.sessions.get("S2")!;

	await daemon.handleSessionMessage(first, {
		type: "identity_header",
		sessionId: "S1",
		repo: "gajae-code",
		branch: "dev",
	});
	await daemon.handleSessionMessage(second, {
		type: "identity_header",
		sessionId: "S2",
		repo: "gajae-code",
		branch: "dev",
	});
	await daemon.handleSessionMessage(second, {
		type: "turn_stream",
		sessionId: "S2",
		text: "second session output",
	});

	const creates = bot.calls.filter(c => c.method === "createForumTopic");
	const sends = bot.calls.filter(c => c.method === "sendMessage");
	expect(creates).toHaveLength(2);
	expect(creates.map(c => c.body.name)).toEqual(["gajae-code/dev", "gajae-code/dev"]);
	expect(sends).toHaveLength(3);
	expect(sends[0]!.body.message_thread_id).not.toBe(sends[1]!.body.message_thread_id);
	expect(sends[2]!.body.message_thread_id).toBe(sends[1]!.body.message_thread_id);
});

test("transient identity for an existing repo branch does not create a duplicate topic", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	const live = { sessionId: "LIVE", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
	const transient = { sessionId: "DEAD", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };

	await daemon.handleSessionMessage(live as any, {
		type: "identity_header",
		sessionId: "LIVE",
		repo: "gajae-code",
		branch: "dev",
	});
	await daemon.handleSessionMessage(transient as any, {
		type: "identity_header",
		sessionId: "DEAD",
		repo: "gajae-code",
		branch: "dev",
	});

	expect(bot.calls.filter(c => c.method === "createForumTopic")).toHaveLength(1);
	expect(bot.calls.filter(c => c.method === "sendMessage")).toHaveLength(1);
});

test("stale identity after loadTopics reuses the persisted repo branch owner", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const firstDaemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	const live = { sessionId: "LIVE", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
	await firstDaemon.handleSessionMessage(live as any, {
		type: "identity_header",
		sessionId: "LIVE",
		repo: "gajae-code",
		branch: "dev",
	});

	const restartedDaemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	await restartedDaemon.loadTopics();
	const stale = { sessionId: "DEAD", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
	await restartedDaemon.handleSessionMessage(stale as any, {
		type: "identity_header",
		sessionId: "DEAD",
		repo: "gajae-code",
		branch: "dev",
	});

	expect(bot.calls.filter(c => c.method === "createForumTopic").map(c => c.body.name)).toEqual(["gajae-code/dev"]);
	const threadedSends = bot.calls.filter(c => c.method === "sendMessage").map(c => c.body.message_thread_id);
	expect(threadedSends).toHaveLength(1);
	expect(Number(threadedSends[0])).toBeGreaterThan(0);
});

test("threaded mode off: frames fall back to the flat paired chat with a one-time notice", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	// Threaded Mode is off: createForumTopic yields no message_thread_id, so
	// ensureTopic fails and the daemon must route flat instead of dropping.
	bot.call = (async (method: string, body: any) => {
		bot.calls.push({ method, body });
		if (method === "createForumTopic") return { ok: true, result: {} };
		if (method === "getChat") return { ok: true, result: { type: "private" } };
		if (method === "sendMessage") return { ok: true, result: { message_id: bot.calls.length } };
		return { ok: true, result: true };
	}) as any;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		rich: { enabled: false },
	});
	const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };

	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "S",
		repo: "r",
		branch: "b",
	});
	await daemon.handleSessionMessage(session as any, {
		type: "context_update",
		sessionId: "S",
		lastMessage: "hello world",
	});
	await daemon.handleSessionMessage(session as any, {
		type: "action_needed",
		sessionId: "S",
		id: "ask1",
		kind: "ask",
		question: "Proceed?",
		options: ["Yes", "No"],
	});

	const sends = bot.calls.filter(c => c.method === "sendMessage");
	// Everything is delivered flat (no message_thread_id) since topics are unavailable.
	expect(sends.length).toBeGreaterThan(0);
	expect(sends.every(c => c.body.message_thread_id === undefined)).toBe(true);
	// The nudge is sent exactly once with the requested copy.
	const notices = sends.filter(c => String(c.body.text).includes(THREADED_FALLBACK_NOTICE));
	expect(notices).toHaveLength(1);
	// The ask still carries its inline keyboard in flat mode.
	const ask = sends.find(c => String(c.body.text).includes("Proceed?"));
	expect(ask).toBeTruthy();
	expect(ask!.body.reply_markup?.inline_keyboard?.length).toBeGreaterThan(0);
});

test("threaded mode off: multiple sessions share a single fallback notice", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	bot.call = (async (method: string, body: any) => {
		bot.calls.push({ method, body });
		if (method === "createForumTopic") return { ok: true, result: {} };
		if (method === "getChat") return { ok: true, result: { type: "private" } };
		if (method === "sendMessage") return { ok: true, result: { message_id: bot.calls.length } };
		return { ok: true, result: true };
	}) as any;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	for (const sessionId of ["A", "B", "C"]) {
		await daemon.handleSessionMessage(
			{ sessionId, token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() } as any,
			{ type: "identity_header", sessionId, repo: "r", branch: sessionId },
		);
	}
	const sends = bot.calls.filter(c => c.method === "sendMessage");
	expect(sends.every(c => c.body.message_thread_id === undefined)).toBe(true);
	expect(sends.filter(c => String(c.body.text).includes(THREADED_FALLBACK_NOTICE))).toHaveLength(1);
});

test("threaded mode off: image_attachment uploads flat without message_thread_id", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	bot.call = (async (method: string, body: any) => {
		bot.calls.push({ method, body });
		if (method === "createForumTopic") return { ok: true, result: {} };
		if (method === "getChat") return { ok: true, result: { type: "private" } };
		if (method === "sendPhoto") return { ok: true, result: { message_id: bot.calls.length } };
		if (method === "sendMessage") return { ok: true, result: { message_id: bot.calls.length } };
		return { ok: true, result: true };
	}) as any;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	await daemon.handleSessionMessage(
		{ sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() } as any,
		{ type: "identity_header", sessionId: "S", repo: "r", branch: "b" },
	);
	await daemon.handleSessionMessage(
		{ sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() } as any,
		{ type: "image_attachment", sessionId: "S", source: "computer", mime: "image/png", data: "AAAA" },
	);
	const photo = bot.calls.find(c => c.method === "sendPhoto");
	expect(photo).toBeTruthy();
	expect(photo!.body.photo).toBe("AAAA");
	expect(photo!.body.message_thread_id).toBeUndefined();
	const notice = bot.calls.filter(
		c => c.method === "sendMessage" && String(c.body.text).includes(THREADED_FALLBACK_NOTICE),
	);
	expect(notice).toHaveLength(1);
});

test("non-private chat: fails closed before topic creation or flat delivery", async () => {
	for (const chatType of ["supergroup", "group", "channel"]) {
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		// Even if the target chat would accept forum topic creation, the paired chat
		// contract is private-only, so the daemon must fail closed before creating
		// topics or sending session content into a shared chat.
		bot.call = (async (method: string, body: any) => {
			bot.calls.push({ method, body });
			if (method === "createForumTopic") return { ok: true, result: { message_thread_id: 777 } };
			if (method === "getChat") return { ok: true, result: { type: chatType } };
			if (method === "sendMessage") return { ok: true, result: { message_id: bot.calls.length } };
			return { ok: true, result: true };
		}) as any;
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
		});
		const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };

		await daemon.handleSessionMessage(session as any, {
			type: "identity_header",
			sessionId: "S",
			repo: "r",
			branch: "b",
		});
		await daemon.handleSessionMessage(session as any, {
			type: "context_update",
			sessionId: "S",
			lastMessage: "secret",
		});
		await daemon.handleSessionMessage(session as any, {
			type: "action_needed",
			sessionId: "S",
			id: "ask1",
			kind: "ask",
			question: "Proceed?",
			options: ["Yes"],
		});

		expect(bot.calls.filter(c => c.method === "createForumTopic")).toHaveLength(0);
		expect(bot.calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
	}
});

test("threaded off + unresolvable getChat: fails closed", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	bot.call = (async (method: string, body: any) => {
		bot.calls.push({ method, body });
		if (method === "createForumTopic") return { ok: true, result: {} };
		if (method === "getChat") throw new Error("getChat failed");
		if (method === "sendMessage") return { ok: true, result: { message_id: bot.calls.length } };
		return { ok: true, result: true };
	}) as any;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };

	await daemon.handleSessionMessage(session as any, { type: "context_update", sessionId: "S", lastMessage: "secret" });
	expect(bot.calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
});

test("identity_header without a title names the topic repo/branch", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	const session = {
		sessionId: "S",
		token: "tok",
		ws: { readyState: 1, send() {} },
		pending: new Map(),
	};
	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
	});
	const createTopic = bot.calls.find(c => c.method === "createForumTopic");
	expect(createTopic).toBeTruthy();
	expect(createTopic!.body.name).toBe("gajae-code/dev");
});

test("identity_header with repo/branch and a title composes repo/branch - title", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	const session = {
		sessionId: "S",
		token: "tok",
		ws: { readyState: 1, send() {} },
		pending: new Map(),
	};
	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
		title: "Rebuild notifications",
	});
	const createTopic = bot.calls.find(c => c.method === "createForumTopic");
	expect(createTopic).toBeTruthy();
	expect(createTopic!.body.name).toBe("gajae-code/dev - Rebuild notifications");
});

test("identity_header without title or repo falls back to the GJC session label", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	const session = {
		sessionId: "abcdef123456",
		token: "tok",
		ws: { readyState: 1, send() {} },
		pending: new Map(),
	};
	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "abcdef123456",
	});
	const createTopic = bot.calls.find(c => c.method === "createForumTopic");
	expect(createTopic).toBeTruthy();
	expect(createTopic!.body.name).toBe("GJC 123456");
});
test("activity busy frame sends a typing chat action into the session topic", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
	// Create the topic first so the typing action has somewhere to go.
	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "S",
		repo: "r",
		branch: "b",
	});
	await daemon.handleSessionMessage(session as any, { type: "activity", sessionId: "S", state: "busy" });
	const typing = bot.calls.find(c => c.method === "sendChatAction");
	expect(typing).toBeTruthy();
	expect(typing!.body.action).toBe("typing");
	expect(Number(typing!.body.message_thread_id)).toBeGreaterThan(0);
	// Idle clears busy; activity idle itself sends no chat action.
	bot.calls = [];
	await daemon.handleSessionMessage(session as any, { type: "activity", sessionId: "S", state: "idle" });
	expect(bot.calls.some(c => c.method === "sendChatAction")).toBe(false);
});

test("session_closed deletes the topic and resume creates a fresh visible topic", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	let now = 0;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		now: () => now,
	});
	const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };

	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "S",
		repo: "r",
		branch: "b",
	});
	const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;
	for (let i = 0; i < 25; i++) {
		await daemon.handleSessionMessage(session as any, {
			type: "turn_stream",
			sessionId: "S",
			phase: "finalized",
			text: `queued-before-delete-${i}`,
		});
	}
	bot.calls = [];

	await daemon.handleSessionMessage(session as any, { type: "session_closed", sessionId: "S" });
	const deleted = bot.calls.find(c => c.method === "deleteForumTopic");
	expect(deleted).toBeTruthy();
	expect(deleted!.body.message_thread_id).toBe(threadId);

	now = 10_000;
	bot.calls = [];
	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "S",
		repo: "r",
		branch: "b",
		title: "resumed",
	});
	const create = bot.calls.find(c => c.method === "createForumTopic");
	const send = bot.calls.find(c => c.method === "sendMessage");
	expect(create).toBeTruthy();
	expect(create!.body.name).toBe("r/b - resumed");
	expect(send).toBeTruthy();
	expect(send!.body.message_thread_id).toBeTruthy();
	expect(bot.calls.some(c => c.method === "reopenForumTopic")).toBe(false);
	expect(bot.calls.some(c => c.method === "sendMessage" && String(c.body.text).includes("queued-before-delete"))).toBe(
		false,
	);
});

test("session_closed clears reply message routes for the closed session", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		WebSocketImpl: FakeWs as any,
	});
	daemon.connectSession("S", "ws://s", "ts");
	daemon.connectSession("T", "ws://t", "tt");
	daemon.messageRoutes.set("s-ask", { sessionId: "S", actionId: "ask" });
	daemon.messageRoutes.set("s-other", { sessionId: "S", actionId: "other" });
	daemon.messageRoutes.set("t-ask", { sessionId: "T", actionId: "ask" });

	await daemon.handleSessionMessage(daemon.sessions.get("S")!, { type: "session_closed", sessionId: "S" });

	expect([...daemon.messageRoutes.values()].some(route => route.sessionId === "S")).toBe(false);
	expect(daemon.messageRoutes.get("t-ask")).toEqual({ sessionId: "T", actionId: "ask" });
});

test("session_closed tombstones its endpoint generation so scans do not recreate an empty topic", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	const cwd = path.join(agentDir, "repo");
	await registerNotificationRoot({ settings: s, cwd, sessionId: "S" });
	const endpointDir = path.join(cwd, ".gjc", "state", "sdk");
	fs.mkdirSync(endpointDir, { recursive: true });
	fs.writeFileSync(path.join(endpointDir, "S.json"), JSON.stringify({ url: "ws://live", token: "ts", pid: 4242 }));

	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		WebSocketImpl: FakeWs as any,
		pidAlive: (pid: number) => pid === 4242,
	});

	const waitForCreate = async () => {
		for (let i = 0; i < 20; i++) {
			const create = bot.calls.find(c => c.method === "createForumTopic");
			if (create) return create;
			await new Promise(resolve => setTimeout(resolve, 1));
		}
		throw new Error("createForumTopic was not called");
	};

	const waitForTopicRecord = async () => {
		const topicsFile = path.join(daemonPaths(agentDir).dir, "telegram-topics.json");
		for (let i = 0; i < 20; i++) {
			if (fs.existsSync(topicsFile) && fs.readFileSync(topicsFile, "utf8").includes('"S"')) return;
			await new Promise(resolve => setTimeout(resolve, 1));
		}
		throw new Error("topic registry was not persisted");
	};

	await daemon.scanRoots();
	expect(FakeWs.instances).toHaveLength(1);
	FakeWs.instances[0]!.dispatchEvent(new Event("open"));
	await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
		type: "event_replay_result",
		id: "telegram-startup-replay:S",
		generation: 1,
		lastSeq: 0,
		events: [],
	});
	await waitForCreate();
	await waitForTopicRecord();

	bot.calls = [];
	await daemon.handleSessionMessage(daemon.sessions.get("S")!, { type: "session_closed", sessionId: "S" });
	expect(bot.calls.some(c => c.method === "deleteForumTopic")).toBe(true);
	expect(daemon.sessions.has("S")).toBe(false);

	bot.calls = [];
	await daemon.scanRoots();
	expect(FakeWs.instances).toHaveLength(1);
	expect(bot.calls.some(c => c.method === "createForumTopic")).toBe(false);

	fs.writeFileSync(path.join(endpointDir, "S.json"), JSON.stringify({ url: "ws://resumed", token: "ts2", pid: 4242 }));
	await daemon.scanRoots();
	expect(FakeWs.instances).toHaveLength(2);
	FakeWs.instances[1]!.dispatchEvent(new Event("open"));
	const resumedCreate = await waitForCreate();
	expect(resumedCreate.body.name).toBe("GJC S");
});

test("inbound thread message gets a queued reaction, flipped to consumed on ack", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		WebSocketImpl: FakeWs as any,
	});
	daemon.connectSession("S", "ws://s", "ts");
	const session = daemon.sessions.get("S")!;
	// Create the topic and learn its thread id from the pinned identity message.
	await daemon.handleSessionMessage(session, { type: "identity_header", sessionId: "S", repo: "r", branch: "b" });
	const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;
	bot.calls = [];

	await daemon.handleTelegramUpdate({
		update_id: 7,
		message: { chat: { id: 42 }, message_thread_id: threadId, message_id: 555, text: "steer me" },
	});
	// The user turn is forwarded to the session…
	expect(JSON.parse(FakeWs.instances[0]!.sent[0]!)).toMatchObject({
		type: "user_message",
		text: "steer me",
		updateId: 7,
	});
	// …and the originating message gets the queued reaction.
	const queued = bot.calls.find(c => c.method === "setMessageReaction");
	expect(queued).toBeTruthy();
	expect(queued!.body.message_id).toBe(555);
	expect(queued!.body.reaction[0].emoji).toBe("👀");

	bot.calls = [];
	await daemon.handleSessionMessage(session, { type: "inbound_ack", sessionId: "S", updateId: 7, state: "consumed" });
	const consumed = bot.calls.find(c => c.method === "setMessageReaction");
	expect(consumed).toBeTruthy();
	expect(consumed!.body.message_id).toBe(555);
	expect(consumed!.body.reaction[0].emoji).toBe("✅");
});

test("inbound photo is downloaded and forwarded as an image in the user_message", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const fetchImpl = (async () => ({
		ok: true,
		arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
	})) as unknown as typeof fetch;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		fetchImpl,
		WebSocketImpl: FakeWs as any,
	});
	daemon.connectSession("S", "ws://s", "ts");
	const session = daemon.sessions.get("S")!;
	await daemon.handleSessionMessage(session, { type: "identity_header", sessionId: "S", repo: "r", branch: "b" });
	const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;

	await daemon.handleTelegramUpdate({
		update_id: 11,
		message: {
			chat: { id: 42 },
			message_thread_id: threadId,
			message_id: 100,
			photo: [{ file_id: "small" }, { file_id: "large" }],
		},
	});

	const frame = JSON.parse(FakeWs.instances[0]!.sent[0]!);
	expect(frame.type).toBe("user_message");
	expect(frame.images).toHaveLength(1);
	expect(frame.images[0].mime).toBe("image/jpeg");
	expect(Buffer.from(frame.images[0].data, "base64")).toEqual(Buffer.from([1, 2, 3, 4]));
	// The largest photo size is the one resolved/downloaded.
	expect(bot.calls.some(c => c.method === "getFile" && c.body.file_id === "large")).toBe(true);
});

test("redacts token-shaped download URLs from attachment failure logs", async () => {
	const botToken = "123456789:ABCDEF_ghijklmnopqrstuvwxyz012345";
	let downloadedUrl = "";
	const fetchImpl = (async (url: string | URL | Request) => {
		downloadedUrl = String(url);
		throw new Error(`fetch failed: ${downloadedUrl}`);
	}) as unknown as typeof fetch;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(tempAgentDir()),
		ownerId: "owner",
		botToken,
		chatId: "42",
		fetchImpl,
	});
	const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

	try {
		await expect(
			(
				daemon as unknown as { downloadTelegramFile(filePath: string): Promise<Buffer | undefined> }
			).downloadTelegramFile("photos/file.jpg"),
		).resolves.toBeUndefined();

		const logged = JSON.stringify([...warnSpy.mock.calls, ...errorSpy.mock.calls]);
		expect(downloadedUrl).toBe(`https://api.telegram.org/file/bot${botToken}/photos/file.jpg`);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logged).toContain("<redacted>");
		expect(logged).not.toContain(botToken);
		expect(logged).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}/);
	} finally {
		warnSpy.mockRestore();
		errorSpy.mockRestore();
	}
});

test("redacts token-shaped URLs from getUpdates poll failure logs", async () => {
	const botToken = "123456789:ABCDEF_ghijklmnopqrstuvwxyz012345";
	const botApi: BotApi = {
		async call(method: string): Promise<unknown> {
			if (method === "getUpdates") {
				throw new Error(`fetch failed: https://api.telegram.org/bot${botToken}/getUpdates`);
			}
			return { ok: true, result: [] };
		},
	};
	const daemon = new TelegramNotificationDaemon({
		settings: settings(tempAgentDir()),
		ownerId: "owner",
		botToken,
		chatId: "42",
		botApi,
		setTimeoutImpl: ((callback: () => void) => {
			callback();
			return 0;
		}) as unknown as typeof setTimeout,
	});
	const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

	try {
		await expect(daemon.pollOnce()).resolves.toBe(0);

		const logged = JSON.stringify([...warnSpy.mock.calls, ...errorSpy.mock.calls]);
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(logged).toContain("<redacted>");
		expect(logged).not.toContain(botToken);
		expect(logged).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}/);
	} finally {
		warnSpy.mockRestore();
		errorSpy.mockRestore();
	}
});

test("inbound document is saved to a tmp file and its path injected into the text", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const fetchImpl = (async () => ({
		ok: true,
		arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer,
	})) as unknown as typeof fetch;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		fetchImpl,
		WebSocketImpl: FakeWs as any,
	});
	daemon.connectSession("S", "ws://s", "ts");
	const session = daemon.sessions.get("S")!;
	await daemon.handleSessionMessage(session, { type: "identity_header", sessionId: "S", repo: "r", branch: "b" });
	const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;

	await daemon.handleTelegramUpdate({
		update_id: 12,
		message: {
			chat: { id: 42 },
			message_thread_id: threadId,
			message_id: 101,
			caption: "look",
			document: { file_id: "doc-1", mime_type: "application/pdf", file_name: "report.pdf" },
		},
	});

	const frame = JSON.parse(FakeWs.instances[0]!.sent[0]!);
	expect(frame.type).toBe("user_message");
	expect(frame.images).toHaveLength(0);
	expect(frame.text).toContain("look");
	const match = String(frame.text).match(/saved to (\S+report\.pdf)/);
	expect(match).toBeTruthy();
	expect(fs.existsSync(match![1]!)).toBe(true);
	expect(fs.readFileSync(match![1]!)).toEqual(Buffer.from([9, 9, 9]));
	// Security: the saved file must be private (0600, no group/other access) inside
	// a private 0700 per-session directory under the system temp root — not a
	// predictable, world-readable /tmp path.
	const dest = match![1]!;
	const fileMode = fs.statSync(dest).mode & 0o777;
	const dirMode = fs.statSync(path.dirname(dest)).mode & 0o777;
	expect(fileMode).toBe(0o600);
	expect(fileMode & 0o077).toBe(0);
	expect(dirMode & 0o077).toBe(0);
	expect(dest.startsWith(os.tmpdir())).toBe(true);
});

test("inbound document with a path-traversal filename stays sandboxed in the private temp dir", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const fetchImpl = (async () => ({
		ok: true,
		arrayBuffer: async () => new Uint8Array([7]).buffer,
	})) as unknown as typeof fetch;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		fetchImpl,
		WebSocketImpl: FakeWs as any,
	});
	daemon.connectSession("S", "ws://s", "ts");
	const session = daemon.sessions.get("S")!;
	await daemon.handleSessionMessage(session, { type: "identity_header", sessionId: "S", repo: "r", branch: "b" });
	const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;

	await daemon.handleTelegramUpdate({
		update_id: 21,
		message: {
			chat: { id: 42 },
			message_thread_id: threadId,
			message_id: 200,
			document: { file_id: "doc-evil", mime_type: "application/octet-stream", file_name: "../../../etc/passwd" },
		},
	});

	const frame = JSON.parse(FakeWs.instances[0]!.sent[0]!);
	const match = String(frame.text).match(/saved to (\S+)/);
	expect(match).toBeTruthy();
	const dest = match![1]!;
	const base = path.basename(dest);
	const dir = path.dirname(dest);
	// The attacker-controlled name must be sanitized so it cannot traverse:
	// no path separators and no ".." segments survive.
	expect(base.includes("/")).toBe(false);
	expect(base.includes("\\")).toBe(false);
	expect(base).not.toContain("..");
	// The real saved file lives directly inside the private per-session temp dir
	// (under the system temp root), not at the attacker-referenced location.
	expect(path.dirname(fs.realpathSync(dest))).toBe(fs.realpathSync(dir));
	expect(dir.startsWith(os.tmpdir())).toBe(true);
	expect(fs.realpathSync(dest)).not.toBe("/etc/passwd");
});

test("daemon attachment temp dirs are removed by the shutdown cleanup path", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const fetchImpl = (async () => ({
		ok: true,
		arrayBuffer: async () => new Uint8Array([1, 1]).buffer,
	})) as unknown as typeof fetch;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		fetchImpl,
		WebSocketImpl: FakeWs as any,
	});
	daemon.connectSession("S", "ws://s", "ts");
	const session = daemon.sessions.get("S")!;
	await daemon.handleSessionMessage(session, { type: "identity_header", sessionId: "S", repo: "r", branch: "b" });
	const threadId = bot.calls.find(c => c.method === "sendMessage")!.body.message_thread_id;

	await daemon.handleTelegramUpdate({
		update_id: 22,
		message: {
			chat: { id: 42 },
			message_thread_id: threadId,
			message_id: 201,
			document: { file_id: "doc-x", mime_type: "application/pdf", file_name: "keep.pdf" },
		},
	});

	const frame = JSON.parse(FakeWs.instances[0]!.sent[0]!);
	const dir = path.dirname(String(frame.text).match(/saved to (\S+)/)![1]!);
	expect(fs.existsSync(dir)).toBe(true);
	// run()'s `finally` invokes cleanupAllAttachmentDirs() on daemon shutdown;
	// exercise that exact cleanup path here.
	await (daemon as any).cleanupAllAttachmentDirs();
	expect(fs.existsSync(dir)).toBe(false);
});

test("outbound file_attachment frame triggers a sendDocument upload to the topic", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		WebSocketImpl: FakeWs as any,
	});
	daemon.connectSession("S", "ws://s", "ts");
	const session = daemon.sessions.get("S")!;
	await daemon.handleSessionMessage(session, { type: "identity_header", sessionId: "S", repo: "r", branch: "b" });
	bot.calls = [];

	const data = Buffer.from([5, 6, 7]).toString("base64");
	await daemon.handleSessionMessage(session, {
		type: "file_attachment",
		sessionId: "S",
		name: "out.pdf",
		mime: "application/pdf",
		data,
		caption: "here",
	});

	const doc = bot.calls.find(c => c.method === "sendDocument");
	expect(doc).toBeTruthy();
	expect(doc!.body.document).toBe(data);
	expect(doc!.body.fileName).toBe("out.pdf");
	expect(doc!.body.mime).toBe("application/pdf");
	expect(Number(doc!.body.message_thread_id)).toBeGreaterThan(0);
});

describe("telegram daemon reconnect reconciliation", () => {
	function endpointFor(agentDir: string, cwd: string, s: Settings, sessionId: string) {
		return (async () => {
			await registerNotificationRoot({ settings: s, cwd, sessionId });
			const roots = JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8")) as { roots: string[] };
			const dir = path.join(roots.roots[0]!, "sdk");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ url: "ws://s", token: "ts" }));
		})();
	}

	test("identity-guarded replacement survives delayed old close and old message", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		await endpointFor(agentDir, path.join(agentDir, "cwd"), s, "S");

		let now = 0;
		const liveness: Array<() => void> = [];
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
			now: () => now,
			setIntervalImpl: ((cb: () => void) => {
				liveness.push(cb);
				return 0;
			}) as any,
			clearIntervalImpl: (() => {}) as any,
		});
		await daemon.scanRoots();
		FakeWs.instances[0]!.emit({ type: "hello", protocolVersion: 2, capabilities: ["client_ping_pong"] });
		now += 25_000;
		for (const cb of liveness) cb();
		await daemon.scanRoots();
		const replacement = daemon.sessions.get("S");
		expect(FakeWs.instances).toHaveLength(2);
		expect(replacement?.ws).toBe(FakeWs.instances[1] as unknown as WebSocket);

		// Delayed old close from the superseded socket must not delete the replacement.
		FakeWs.instances[0]!.dispatchEvent(new Event("close"));
		expect(daemon.sessions.get("S")).toBe(replacement);

		// Delayed old message from the superseded socket must not produce a send.
		bot.calls = [];
		FakeWs.instances[0]!.emit({ type: "action_needed", kind: "ask", id: "old", question: "Q", options: ["Y"] });
		await Promise.resolve();
		expect(bot.calls).toHaveLength(0);
	});

	test("legacy server without ping/pong capability does not start ack liveness", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		await endpointFor(agentDir, path.join(agentDir, "cwd"), s, "S");

		let now = 0;
		const liveness: Array<() => void> = [];
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: new FakeBotApi(),
			WebSocketImpl: FakeWs as any,
			now: () => now,
			setIntervalImpl: ((cb: () => void) => {
				liveness.push(cb);
				return 0;
			}) as any,
			clearIntervalImpl: (() => {}) as any,
		});
		await daemon.scanRoots();
		// Legacy server: advertises capabilities WITHOUT client_ping_pong.
		FakeWs.instances[0]!.emit({ type: "hello", protocolVersion: 1, capabilities: ["threaded"] });
		expect(liveness).toHaveLength(0);
		now += 100_000;
		for (const cb of liveness) cb();
		await daemon.scanRoots();
		// No ack-based force-drop: the single original socket remains; half-open ack
		// recovery is simply unavailable for a non-capable server.
		expect(FakeWs.instances).toHaveLength(1);
		expect(daemon.sessions.has("S")).toBe(true);
	});

	test("AC-3/AC-5: after reconnect a replayed ask renders one re-ask and future frames flow", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		await endpointFor(agentDir, path.join(agentDir, "cwd"), s, "S");

		let now = 0;
		const liveness: Array<() => void> = [];
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
			now: () => now,
			setIntervalImpl: ((cb: () => void) => {
				liveness.push(cb);
				return 0;
			}) as any,
			clearIntervalImpl: (() => {}) as any,
		});
		await daemon.scanRoots();
		FakeWs.instances[0]!.emit({ type: "hello", protocolVersion: 2, capabilities: ["client_ping_pong"] });
		now += 25_000;
		for (const cb of liveness) cb();
		await daemon.scanRoots();
		const replacement = daemon.sessions.get("S")!;
		expect(replacement.ws).toBe(FakeWs.instances[1] as unknown as WebSocket);

		// AC-3: the native server replays its single buffered ask to the fresh
		// client; the daemon renders exactly one fresh re-ask in the topic.
		bot.calls = [];
		await daemon.handleSessionMessage(replacement, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Resume?",
			options: ["Yes", "No"],
		});
		const reAsks = bot.calls.filter(c => c.method === "sendMessage" && c.body.reply_markup?.inline_keyboard);
		expect(reAsks).toHaveLength(1);

		// AC-5: future streamed frames after reconnect are delivered to the topic.
		bot.calls = [];
		await daemon.handleSessionMessage(replacement, {
			type: "turn_stream",
			sessionId: "S",
			phase: "finalized",
			text: "post-reconnect output",
		});
		expect(bot.calls.some(c => c.method === "sendMessage" && String(c.body.text).includes("post-reconnect"))).toBe(
			true,
		);
	});
});

describe("telegram daemon reconnect answer routing", () => {
	test("AC-4: a button tap after reconnect routes a reply through the replacement socket", async () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const cwd = path.join(agentDir, "cwd");
		await registerNotificationRoot({ settings: s, cwd, sessionId: "S" });
		const roots = JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8")) as { roots: string[] };
		const dir = path.join(roots.roots[0]!, "sdk");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "S.json"), JSON.stringify({ url: "ws://s", token: "ts" }));

		let now = 0;
		const liveness: Array<() => void> = [];
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			rich: { enabled: false },
			WebSocketImpl: FakeWs as any,
			now: () => now,
			setIntervalImpl: ((cb: () => void) => {
				liveness.push(cb);
				return 0;
			}) as any,
			clearIntervalImpl: (() => {}) as any,
		});
		await daemon.scanRoots();
		FakeWs.instances[0]!.emit({ type: "hello", protocolVersion: 2, capabilities: ["client_ping_pong"] });
		now += 25_000;
		for (const cb of liveness) cb();
		await daemon.scanRoots();
		const replacement = daemon.sessions.get("S")!;

		// The native server replays the buffered ask to the reconnected client.
		await daemon.handleSessionMessage(replacement, {
			type: "action_needed",
			kind: "ask",
			id: "ask1",
			question: "Resume?",
			options: ["Yes", "No"],
		});
		const alias = bot.calls.find(c => c.method === "sendMessage" && c.body.reply_markup)!.body.reply_markup
			.inline_keyboard[0][0].callback_data;

		// A button tap on the fresh re-ask must route a reply over the new socket.
		await daemon.handleTelegramUpdate({
			update_id: 1,
			callback_query: { id: "cb", data: alias, message: { chat: { id: 42 } } },
		});
		const sent = (replacement.ws as unknown as { sent: string[] }).sent;
		const replyFrame = sent.map(x => JSON.parse(x)).find(m => m.type === "reply");
		expect(replyFrame).toEqual({ type: "reply", id: "ask1", answer: 0, token: "ts" });
	});
});

test("pollOnce resolves to 0 when the in-flight getUpdates is aborted", async () => {
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	const bot = {
		call: (_method: string, _body: unknown, opts?: { signal?: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				opts?.signal?.addEventListener("abort", () =>
					reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
				);
			}),
	};
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
	const ac = new AbortController();
	const pending = daemon.pollOnce(ac.signal);
	ac.abort();
	expect(await pending).toBe(0);
});

test("pollOnce backs off on a Telegram 409 conflict instead of processing updates", async () => {
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	const sleeps: number[] = [];
	const bot = {
		call: async () => ({
			ok: false,
			error_code: 409,
			description: "Conflict: terminated by other getUpdates request",
		}),
	};
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		setTimeoutImpl: ((cb: () => void, ms?: number) => {
			sleeps.push(ms ?? 0);
			cb();
			return 0;
		}) as unknown as typeof setTimeout,
	});
	expect(await daemon.pollOnce()).toBe(0);
	expect(await daemon.pollOnce()).toBe(0);
	expect(await daemon.pollOnce()).toBe(0);
	expect(await daemon.pollOnce()).toBe(0);
	expect(await daemon.pollOnce()).toBe(0);
	expect(await daemon.pollOnce()).toBe(0);
	expect(sleeps).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000]);
});

test("TelegramUpdatePoller logs getUpdates failures only on transition and reports suppressed recovery", async () => {
	const sleeps: number[] = [];
	let calls = 0;
	const bot = {
		async call() {
			calls += 1;
			if (calls <= 3) throw new Error(`network-${calls}`);
			return { ok: true, result: [] };
		},
	};
	const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
	const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
	try {
		const poller = new TelegramUpdatePoller({
			botApi: bot,
			runtime: { sleep: async (ms: number) => void sleeps.push(ms) } as any,
			backoff: { next: () => 500, reset() {} } as any,
			processUpdate: async () => "consumed",
		});

		expect(await poller.pollOnce()).toBe(0);
		expect(await poller.pollOnce()).toBe(0);
		expect(await poller.pollOnce()).toBe(0);
		expect(await poller.pollOnce()).toBe(0);

		const getUpdatesFailures = errorSpy.mock.calls.filter(
			call => call[0] === "notifications daemon: getUpdates failed",
		);
		expect(getUpdatesFailures).toHaveLength(1);
		expect(getUpdatesFailures[0]?.[1]).toMatchObject({ error: "Error: network-1", suppressedCount: 0 });
		const recoveries = infoSpy.mock.calls.filter(
			call => call[0] === "notifications daemon: Telegram getUpdates recovered",
		);
		expect(recoveries).toHaveLength(1);
		expect(recoveries[0]?.[1]).toMatchObject({ from: "getUpdates_failed", suppressedCount: 2, updateCount: 0 });
		expect(sleeps).toEqual([1_000, 1_000, 1_000]);
	} finally {
		errorSpy.mockRestore();
		infoSpy.mockRestore();
	}
});

test("TelegramUpdatePoller treats non-conflict API failures as unhealthy until a verified success", async () => {
	const sleeps: number[] = [];
	let calls = 0;
	const bot = {
		async call() {
			calls += 1;
			if (calls <= 2) return { ok: false, error_code: 401, description: "Unauthorized" };
			return { ok: true, result: [] };
		},
	};
	const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
	const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
	try {
		const poller = new TelegramUpdatePoller({
			botApi: bot,
			runtime: { sleep: async (ms: number) => void sleeps.push(ms) } as any,
			backoff: { next: () => 500, reset() {} } as any,
			processUpdate: async () => "consumed",
		});

		expect(await poller.pollOnce()).toBe(0);
		expect(await poller.pollOnce()).toBe(0);
		expect(await poller.pollOnce()).toBe(0);

		const apiFailures = errorSpy.mock.calls.filter(
			call => call[0] === "notifications daemon: Telegram getUpdates API failed",
		);
		expect(apiFailures).toHaveLength(1);
		expect(apiFailures[0]?.[1]).toMatchObject({
			errorCode: 401,
			description: "Unauthorized",
			suppressedCount: 0,
		});
		const recoveries = infoSpy.mock.calls.filter(
			call => call[0] === "notifications daemon: Telegram getUpdates recovered",
		);
		expect(recoveries).toHaveLength(1);
		expect(recoveries[0]?.[1]).toMatchObject({ from: "api_failure", suppressedCount: 1, updateCount: 0 });
		expect(sleeps).toEqual([1_000, 1_000]);
	} finally {
		errorSpy.mockRestore();
		infoSpy.mockRestore();
	}
});

test("TelegramUpdatePoller treats malformed update items as unhealthy and does not advance the offset", async () => {
	const calls: Array<{ offset: unknown }> = [];
	const sleeps: number[] = [];
	let attempt = 0;
	const bot = {
		async call(_method: string, body: { offset?: unknown }) {
			calls.push({ offset: body.offset });
			attempt += 1;
			if (attempt <= 2) return { ok: true, result: [{}] };
			return { ok: true, result: [] };
		},
	};
	const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
	const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
	try {
		const poller = new TelegramUpdatePoller({
			botApi: bot,
			runtime: { sleep: async (ms: number) => void sleeps.push(ms) } as any,
			backoff: { next: () => 500, reset() {} } as any,
			processUpdate: async () => {
				throw new Error("malformed update should not be processed");
			},
		});

		expect(await poller.pollOnce()).toBe(0);
		expect(await poller.pollOnce()).toBe(0);
		expect(await poller.pollOnce()).toBe(0);

		const apiFailures = errorSpy.mock.calls.filter(
			call => call[0] === "notifications daemon: Telegram getUpdates API failed",
		);
		expect(apiFailures).toHaveLength(1);
		expect(apiFailures[0]?.[1]).toMatchObject({
			description: "Malformed getUpdates response",
			suppressedCount: 0,
		});
		const recoveries = infoSpy.mock.calls.filter(
			call => call[0] === "notifications daemon: Telegram getUpdates recovered",
		);
		expect(recoveries).toHaveLength(1);
		expect(recoveries[0]?.[1]).toMatchObject({ from: "api_failure", suppressedCount: 1, updateCount: 0 });
		expect(calls.map(call => call.offset)).toEqual([0, 0, 0]);
		expect(sleeps).toEqual([1_000, 1_000]);
	} finally {
		errorSpy.mockRestore();
		infoSpy.mockRestore();
	}
});

test("TelegramUpdatePoller skips a poisoned update but still advances past valid updates in the same batch", async () => {
	const calls: Array<{ offset: unknown }> = [];
	const sleeps: number[] = [];
	const processed: number[] = [];
	let attempt = 0;
	const bot = {
		async call(_method: string, body: { offset?: unknown }) {
			calls.push({ offset: body.offset });
			attempt += 1;
			if (attempt === 1) {
				return { ok: true, result: [{ update_id: 5 }, {}, { update_id: 7 }] };
			}
			return { ok: true, result: [] };
		},
	};
	const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
	const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
	try {
		const poller = new TelegramUpdatePoller({
			botApi: bot,
			runtime: { sleep: async (ms: number) => void sleeps.push(ms) } as any,
			backoff: { next: () => 500, reset() {} } as any,
			processUpdate: async (update: any) => {
				processed.push(update.update_id);
				return "consumed";
			},
		});

		// A poisoned middle entry must not wedge the offset: the valid updates on
		// either side are still processed and the offset advances past them.
		expect(await poller.pollOnce()).toBe(0);
		// The second poll resumes AFTER the highest valid update_id (7 -> offset 8),
		// proving the poison did not stall the stream.
		expect(await poller.pollOnce()).toBe(0);

		expect(processed).toEqual([5, 7]);
		expect(calls.map(call => call.offset)).toEqual([0, 8]);
		const apiFailures = errorSpy.mock.calls.filter(
			call => call[0] === "notifications daemon: Telegram getUpdates API failed",
		);
		expect(apiFailures).toHaveLength(1);
		expect(apiFailures[0]?.[1]).toMatchObject({ description: "Malformed getUpdates response" });
	} finally {
		errorSpy.mockRestore();
		infoSpy.mockRestore();
	}
});

test("requestStop aborts the active long poll and run() exits, releasing ownership", async () => {
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	await acquireDaemonOwnership({
		settings: s,
		tokenFingerprint: "e60b05c186ca",
		chatId: "42",
		pid: process.pid,
		randomId: () => "owner",
	});
	let markPollStarted!: () => void;
	const pollStarted = new Promise<void>(resolve => {
		markPollStarted = resolve;
	});
	const bot = {
		call: (method: string, _body: unknown, opts?: { signal?: AbortSignal }) => {
			if (method === "getUpdates") {
				return new Promise((_resolve, reject) => {
					opts?.signal?.addEventListener("abort", () =>
						reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
					);
					markPollStarted();
				});
			}
			return Promise.resolve({ ok: true, result: true });
		},
	};
	class NoScan extends TelegramNotificationDaemon {
		override async scanRoots(): Promise<void> {}
	}
	const daemon = new NoScan({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		WebSocketImpl: FakeWs as any,
		setTimeoutImpl: ((cb: () => void) => {
			cb();
			return 0;
		}) as any,
	});
	daemon.connectSession("S", "ws://s", "t");
	const runPromise = daemon.run();
	await pollStarted;
	daemon.requestStop("signal");
	await runPromise;
	expect(fs.existsSync(daemonPaths(agentDir).lock)).toBe(false);
});

test("run() loop exits when an owner-scoped control request asks it to stop", async () => {
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	await acquireDaemonOwnership({
		settings: s,
		tokenFingerprint: "e60b05c186ca",
		chatId: "42",
		pid: process.pid,
		randomId: () => "owner",
	});
	let cleared = false;
	class NoScan extends TelegramNotificationDaemon {
		override async scanRoots(): Promise<void> {}
	}
	const daemon = new NoScan({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: new FakeBotApi(),
		control: {
			shouldStop: async owner => owner === "owner",
			clear: async () => {
				cleared = true;
			},
		},
		setTimeoutImpl: ((cb: () => void) => {
			cb();
			return 0;
		}) as any,
	});
	await daemon.run();
	expect(cleared).toBe(true);
	expect(fs.existsSync(daemonPaths(agentDir).lock)).toBe(false);
});

test("run() persists aliases before releasing ownership on exit", async () => {
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	await acquireDaemonOwnership({
		settings: s,
		tokenFingerprint: "e60b05c186ca",
		chatId: "42",
		pid: process.pid,
		randomId: () => "owner",
	});
	let now = 0;
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: new FakeBotApi(),
		idleTimeoutMs: 10,
		now: () => (now += 11),
		setTimeoutImpl: ((cb: () => void) => {
			cb();
			return 0;
		}) as any,
	});
	daemon.aliasTable.put({ sessionId: "S", actionId: "ask", answer: 0 });
	await daemon.run();
	expect(fs.existsSync(daemonPaths(agentDir).aliases)).toBe(true);
});

test("a fresh daemon scanRoots reconnects an existing session endpoint", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	const cwd = path.join(agentDir, "repo");
	await registerNotificationRoot({ settings: s, cwd, sessionId: "live-session" });
	const endpointDir = path.join(cwd, ".gjc", "state", "sdk");
	fs.mkdirSync(endpointDir, { recursive: true });
	fs.writeFileSync(path.join(endpointDir, "live-session.json"), JSON.stringify({ url: "ws://live", token: "tok" }));
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: new FakeBotApi(),
		WebSocketImpl: FakeWs as any,
	});
	await daemon.scanRoots();
	expect(daemon.sessions.has("live-session")).toBe(true);
	expect(FakeWs.instances.some(ws => ws.url.startsWith("ws://live"))).toBe(true);
});

test("connectSession eagerly creates a Telegram topic on connect (before any frame)", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		WebSocketImpl: FakeWs as any,
	});
	daemon.connectSession("sess-abc123", "ws://x", "tok");
	// FakeWs does not auto-dispatch "open"; fire it to exercise the connect hook.
	FakeWs.instances[0]!.dispatchEvent(new Event("open"));
	await new Promise(r => setTimeout(r, 10));
	const createTopic = bot.calls.find(c => c.method === "createForumTopic");
	expect(createTopic).toBeTruthy();
	// Provisional name uses the session id tail until identity_header renames it.
	expect(createTopic!.body.name).toBe("GJC abc123");
});

test("identity_header during an in-flight eager create still renames the topic", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	let releaseCreate: (tid: string) => void = () => {};
	const createGate = new Promise<string>(r => {
		releaseCreate = r;
	});
	const bot = new FakeBotApi();
	bot.call = (async (method: string, body: any) => {
		bot.calls.push({ method, body });
		if (method === "createForumTopic") {
			const tid = await createGate; // stay in-flight until released
			return { ok: true, result: { message_thread_id: Number(tid) } };
		}
		if (method === "getChat") return { ok: true, result: { type: "private" } };
		if (method === "editForumTopic") return { ok: true, result: true };
		if (method === "sendMessage") return { ok: true, result: { message_id: bot.calls.length } };
		return { ok: true, result: true };
	}) as any;
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		WebSocketImpl: FakeWs as any,
	});
	daemon.connectSession("sess-xyz999", "ws://x", "tok");
	// Eager create starts and blocks in-flight on createGate.
	FakeWs.instances[0]!.dispatchEvent(new Event("open"));
	await Promise.resolve();
	// identity_header arrives live while replay is pending, then appears in the
	// replay snapshot too. The barrier must apply it exactly once.
	const session = daemon.sessions.get("sess-xyz999")!;
	const identity = {
		type: "identity_header",
		sessionId: "sess-xyz999",
		repo: "myrepo",
		branch: "mybranch",
	};
	await daemon.handleSessionMessage(session, identity);
	const replayP = daemon.handleSessionMessage(session, {
		type: "event_replay_result",
		id: "telegram-startup-replay:sess-xyz999",
		generation: 1,
		lastSeq: 1,
		events: [{ type: "event", name: "identity_header", payload: identity }],
	});
	await Promise.resolve();
	releaseCreate("777"); // now resolve the single shared create
	await replayP;
	// Exactly one topic created (provisional name), then renamed to identity name.
	expect(bot.calls.filter(c => c.method === "createForumTopic")).toHaveLength(1);
	expect(bot.calls.find(c => c.method === "createForumTopic")!.body.name).toBe("GJC xyz999");
	const edit = bot.calls.find(c => c.method === "editForumTopic");
	expect(edit).toBeTruthy();
	expect(edit!.body.name).toBe("myrepo/mybranch");
});

test("scanRoots connects only live endpoints (skips stale + dead-PID records)", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	const cwd = path.join(agentDir, "repo");
	await registerNotificationRoot({ settings: s, cwd, sessionId: "live" });
	await registerNotificationRoot({ settings: s, cwd, sessionId: "stale" });
	await registerNotificationRoot({ settings: s, cwd, sessionId: "dead" });
	const endpointDir = path.join(cwd, ".gjc", "state", "sdk");
	fs.mkdirSync(endpointDir, { recursive: true });
	fs.writeFileSync(path.join(endpointDir, "live.json"), JSON.stringify({ url: "ws://live", token: "t", pid: 4242 }));
	fs.writeFileSync(
		path.join(endpointDir, "stale.json"),
		JSON.stringify({ url: "ws://stale", token: "t", pid: 4242, stale: true }),
	);
	fs.writeFileSync(path.join(endpointDir, "dead.json"), JSON.stringify({ url: "ws://dead", token: "t", pid: 999999 }));
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: new FakeBotApi(),
		WebSocketImpl: FakeWs as any,
		// Only pid 4242 is "alive"; 999999 is dead.
		pidAlive: (pid: number) => pid === 4242,
	});
	await daemon.scanRoots();
	expect(daemon.sessions.has("live")).toBe(true);
	expect(daemon.sessions.has("stale")).toBe(false);
	expect(daemon.sessions.has("dead")).toBe(false);
	expect(FakeWs.instances.every(ws => ws.url.startsWith("ws://live"))).toBe(true);
});

test("scanRoots reaps stale and dead-PID session topics after the orphan grace window", async () => {
	FakeWs.instances = [];
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	const cwd = path.join(agentDir, "repo");
	await registerNotificationRoot({ settings: s, cwd, sessionId: "stale" });
	await registerNotificationRoot({ settings: s, cwd, sessionId: "dead" });
	const endpointDir = path.join(cwd, ".gjc", "state", "sdk");
	fs.mkdirSync(endpointDir, { recursive: true });
	fs.writeFileSync(
		path.join(endpointDir, "stale.json"),
		JSON.stringify({ url: "ws://stale", token: "t", stale: true }),
	);
	fs.writeFileSync(path.join(endpointDir, "dead.json"), JSON.stringify({ url: "ws://dead", token: "t", pid: 999999 }));
	fs.mkdirSync(daemonPaths(agentDir).dir, { recursive: true });
	fs.writeFileSync(
		path.join(daemonPaths(agentDir).dir, "telegram-topics.json"),
		JSON.stringify({
			topics: {
				stale: { topicId: "101", identitySent: true, createdAt: 0, name: "stale" },
				dead: { topicId: "102", identitySent: true, createdAt: 0, name: "dead" },
			},
		}),
	);
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		WebSocketImpl: FakeWs as any,
		pidAlive: () => false,
		now: () => 120_000,
	});
	await daemon.loadTopics();
	await daemon.scanRoots();
	expect(
		bot.calls
			.filter(c => c.method === "deleteForumTopic")
			.map(c => c.body.message_thread_id)
			.sort(),
	).toEqual([101, 102]);
	expect(daemon.sessions.size).toBe(0);
});

test("scanRoots reaps missing endpoint topics only when all roots are readable and grace has elapsed", async () => {
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	const cwd = path.join(agentDir, "repo");
	await registerNotificationRoot({ settings: s, cwd, sessionId: "missing" });
	fs.mkdirSync(path.join(cwd, ".gjc", "state", "sdk"), { recursive: true });
	fs.mkdirSync(daemonPaths(agentDir).dir, { recursive: true });
	fs.writeFileSync(
		path.join(daemonPaths(agentDir).dir, "telegram-topics.json"),
		JSON.stringify({ topics: { missing: { topicId: "201", identitySent: true, createdAt: 0, name: "missing" } } }),
	);
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		now: () => 120_000,
	});
	await daemon.loadTopics();
	await daemon.scanRoots();
	expect(bot.calls.filter(c => c.method === "deleteForumTopic").map(c => c.body.message_thread_id)).toEqual([201]);

	const blockedAgentDir = tempAgentDir();
	const blockedSettings = setPrivateAgentDir(settings(blockedAgentDir), blockedAgentDir);
	await registerNotificationRoot({
		settings: blockedSettings,
		cwd: path.join(blockedAgentDir, "unreadable"),
		sessionId: "kept",
	});
	fs.mkdirSync(daemonPaths(blockedAgentDir).dir, { recursive: true });
	fs.writeFileSync(
		path.join(daemonPaths(blockedAgentDir).dir, "telegram-topics.json"),
		JSON.stringify({ topics: { kept: { topicId: "202", identitySent: true, createdAt: 0, name: "kept" } } }),
	);
	const blockedBot = new FakeBotApi();
	const blockedDaemon = new TelegramNotificationDaemon({
		settings: blockedSettings,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: blockedBot,
		now: () => 120_000,
	});
	await blockedDaemon.loadTopics();
	await blockedDaemon.scanRoots();
	expect(blockedBot.calls.some(c => c.method === "deleteForumTopic")).toBe(false);
});

test("runDaemonInternal wires SIGTERM to the daemon stop method", async () => {
	const agentDir = tempAgentDir();
	const s = setPrivateAgentDir(settings(agentDir), agentDir);
	let stopped = false;
	let resolveRun: (() => void) | undefined;
	class StubDaemon {
		constructor(public opts: unknown) {}
		requestStop(): void {
			stopped = true;
			resolveRun?.();
		}
		run(): Promise<void> {
			return new Promise<void>(resolve => {
				resolveRun = resolve;
			});
		}
	}
	const originalOnce = process.once.bind(process);
	const originalOff = process.off.bind(process);
	let sigtermHandler: (() => void) | undefined;
	(process as any).once = (event: string, handler: () => void) => {
		if (event === "SIGTERM") sigtermHandler = handler;
		// Do not register real signal handlers in-process; just capture them.
		return process;
	};
	(process as any).off = () => process;
	try {
		const runPromise = runDaemonInternal(["--agent-dir", agentDir, "--owner-id", "owner"], {
			SettingsImpl: { init: async () => s },
			DaemonImpl: StubDaemon as any,
		});
		await new Promise(resolve => setTimeout(resolve, 5));
		expect(sigtermHandler).toBeTruthy();
		sigtermHandler?.();
		await runPromise;
		expect(stopped).toBe(true);
	} finally {
		(process as any).once = originalOnce;
		(process as any).off = originalOff;
	}
});

test("a long finalized turn is scheduled through the pool, not burst in one grant", async () => {
	const agentDir = tempAgentDir();
	const bot = new FakeBotApi();
	const now = 0;
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		now: () => now,
	});
	const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };

	await daemon.handleSessionMessage(session as any, {
		type: "identity_header",
		sessionId: "S",
		repo: "r",
		branch: "b",
	});
	bot.calls = [];

	// A finalized turn with NO messageRef renders keyless (legacy fresh-send).
	// Its rendered HTML spans multiple Telegram chunks.
	const raw = "가".repeat(9000);
	const expectedChunks = splitTelegramHtml(markdownToTelegramHtml(raw));
	expect(expectedChunks.length).toBeGreaterThan(1); // sanity: the turn really splits

	await daemon.handleSessionMessage(session as any, {
		type: "turn_stream",
		sessionId: "S",
		phase: "finalized",
		text: raw,
	});

	// One granted slot -> exactly one Telegram send; the remaining chunks are
	// re-submitted to the pool rather than fanned out against the single token.
	const firstFlush = bot.calls.filter(c => c.method === "sendMessage");
	expect(firstFlush).toHaveLength(1);
	expect(firstFlush[0]!.body.text).toBe(expectedChunks[0]);

	// A follow-up flush drains the queued continuation chunks (each consumed a
	// token) ahead of the newer frame, preserving order and dropping nothing.
	bot.calls = [];
	await daemon.handleSessionMessage(session as any, {
		type: "turn_stream",
		sessionId: "S",
		phase: "finalized",
		text: "tail",
	});
	const rest = bot.calls.filter(c => c.method === "sendMessage").map(c => c.body.text);
	expect(rest).toEqual([...expectedChunks.slice(1), markdownToTelegramHtml("tail")]);
});
// ---------------------------------------------------------------------------
// Rev 3 rich final-answer promotion verification (Slice 1). Proves that the
// off state is byte-identical (transport golden + daemon HTML body), documents
// the multipart FormData contract, and pins the exact rich-promotion counts,
// topic-match matrix, transport-level ok:false fallback, version-skew
// tolerance, and the long-string split seam. Config reachability lives in
// notifications-daemon-config-reachability.test.ts.
// ---------------------------------------------------------------------------

/** FakeBotApi with a deterministic topic id and a switchable sendRichMessage outcome. */
class RichFakeBotApi extends FakeBotApi {
	richBehavior: "ok" | "ok_false" | "throw" = "ok";
	richThreadId = 555;
	/** When true, createForumTopic yields no thread id, forcing flat delivery. */
	threadedOff = false;
	override async call(method: string, body: unknown): Promise<unknown> {
		if (method === "createForumTopic") {
			this.calls.push({ method, body });
			return this.threadedOff
				? { ok: true, result: {} }
				: { ok: true, result: { message_thread_id: this.richThreadId } };
		}
		if (method === "sendRichMessage") {
			this.calls.push({ method, body });
			if (this.richBehavior === "throw") throw new Error("rich transport down");
			if (this.richBehavior === "ok_false") return { ok: false, description: "rich unavailable" };
			return { ok: true, result: { message_id: 4242 } };
		}
		return super.call(method, body);
	}
}

function richSession(id = "S"): any {
	return { sessionId: id, token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
}

function makeRichDaemon(bot: FakeBotApi, rich?: { enabled: boolean }): TelegramNotificationDaemon {
	return new TelegramNotificationDaemon({
		settings: settings(tempAgentDir()),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot as any,
		...(rich ? { rich } : {}),
	});
}

/**
 * Drive an identity_header (creates the topic) then a finalized turn_stream,
 * resetting call history in between so only the finalized turn's calls remain.
 */
async function driveFinalizedTurn(
	daemon: TelegramNotificationDaemon,
	bot: FakeBotApi,
	session: any,
	raw: string,
	finalAnswer = true,
): Promise<void> {
	await daemon.handleSessionMessage(session, {
		type: "identity_header",
		sessionId: session.sessionId,
		repo: "r",
		branch: "b",
	});
	bot.calls.length = 0;
	await daemon.handleSessionMessage(session, {
		type: "turn_stream",
		sessionId: session.sessionId,
		phase: "finalized",
		finalAnswer,
		text: raw,
	});
}

const countMethod = (bot: FakeBotApi, method: string): number => bot.calls.filter(c => c.method === method).length;
const findMethod = (bot: FakeBotApi, method: string) => bot.calls.find(c => c.method === method);

describe("telegram daemon rich final-answer promotion (Rev 3 verification)", () => {
	// (a) TRANSPORT GOLDEN --------------------------------------------------
	test("(a) transport serializes off-state sendMessage variants byte-identically", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const transport = new TelegramBotTransport({
			botToken: "tok",
			apiBase: "https://telegram.test",
			fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(url), init: init ?? {} });
				return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
			}) as typeof fetch,
		});

		// The exact bodies flushPool / the ask path hand to botApi.call in the off state.
		const single = { chat_id: "42", message_thread_id: 100, text: "Hello <b>world</b>", parse_mode: "HTML" };
		const longText = "x".repeat(4200);
		const longChunk = { chat_id: "42", message_thread_id: 100, text: longText, parse_mode: "HTML" };
		const ask = {
			chat_id: "42",
			message_thread_id: 100,
			text: "Pick one option",
			parse_mode: "HTML",
			reply_markup: {
				inline_keyboard: [
					[
						{ text: "1", callback_data: "a:1" },
						{ text: "2", callback_data: "a:2" },
					],
				],
			},
		};

		await transport.call("sendMessage", single);
		await transport.call("sendMessage", longChunk);
		await transport.call("sendMessage", ask);

		// Byte-identical JSON with the exact pre-rich field order.
		expect(requests[0].init.body).toBe(
			'{"chat_id":"42","message_thread_id":100,"text":"Hello <b>world</b>","parse_mode":"HTML"}',
		);
		expect(requests[1].init.body).toBe(
			`{"chat_id":"42","message_thread_id":100,"text":"${longText}","parse_mode":"HTML"}`,
		);
		expect(requests[2].init.body).toBe(
			'{"chat_id":"42","message_thread_id":100,"text":"Pick one option","parse_mode":"HTML",' +
				'"reply_markup":{"inline_keyboard":[[{"text":"1","callback_data":"a:1"},{"text":"2","callback_data":"a:2"}]]}}',
		);
		for (const r of requests) {
			expect(r.url).toBe("https://telegram.test/bottok/sendMessage");
			expect(r.init.headers).toEqual({ "content-type": "application/json" });
		}
	});

	// (b) FormData semantics ------------------------------------------------
	test("(b) sendPhoto/sendDocument multipart carries fields, file names, and blob types", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const transport = new TelegramBotTransport({
			botToken: "tok",
			apiBase: "https://telegram.test",
			fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(url), init: init ?? {} });
				return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
			}) as typeof fetch,
		});

		await transport.call("sendPhoto", {
			chat_id: "42",
			message_thread_id: 7,
			photo: Buffer.from("PNGDATA").toString("base64"),
			mime: "image/png",
			caption: "shot",
			parse_mode: "HTML",
		});
		await transport.call("sendDocument", {
			chat_id: "42",
			message_thread_id: 9,
			document: Buffer.from("DOCDATA").toString("base64"),
			mime: "application/pdf",
			fileName: "notes.pdf",
			caption: "doc",
			parse_mode: "HTML",
		});
		// Defaults: no mime -> image/png; no mime/fileName -> octet-stream/"file"; no thread -> field omitted.
		await transport.call("sendPhoto", { chat_id: "42", photo: Buffer.from("Z").toString("base64") });
		await transport.call("sendDocument", { chat_id: "42", document: Buffer.from("Z").toString("base64") });

		expect(requests[0].url).toBe("https://telegram.test/bottok/sendPhoto");
		const photo = requests[0].init.body as FormData;
		expect(photo).toBeInstanceOf(FormData);
		expect(photo.get("chat_id")).toBe("42");
		expect(photo.get("message_thread_id")).toBe("7");
		expect(photo.get("caption")).toBe("shot");
		expect(photo.get("parse_mode")).toBe("HTML");
		const photoFile = photo.get("photo") as File;
		expect(photoFile).toBeInstanceOf(Blob);
		expect(photoFile.name).toBe("image");
		expect(photoFile.type).toBe("image/png");
		expect(await photoFile.text()).toBe("PNGDATA");

		expect(requests[1].url).toBe("https://telegram.test/bottok/sendDocument");
		const doc = requests[1].init.body as FormData;
		expect(doc.get("chat_id")).toBe("42");
		expect(doc.get("message_thread_id")).toBe("9");
		expect(doc.get("caption")).toBe("doc");
		expect(doc.get("parse_mode")).toBe("HTML");
		const docFile = doc.get("document") as File;
		expect(docFile).toBeInstanceOf(Blob);
		expect(docFile.name).toBe("notes.pdf");
		expect(docFile.type).toBe("application/pdf");
		expect(await docFile.text()).toBe("DOCDATA");

		const photoDefaults = requests[2].init.body as FormData;
		expect((photoDefaults.get("photo") as File).type).toBe("image/png");
		const docDefaults = requests[3].init.body as FormData;
		expect(docDefaults.has("message_thread_id")).toBe(false);
		expect(docDefaults.has("caption")).toBe(false);
		expect(docDefaults.has("parse_mode")).toBe(false);
		const docDefaultFile = docDefaults.get("document") as File;
		expect(docDefaultFile.name).toBe("file");
		expect(docDefaultFile.type).toBe("application/octet-stream");
	});

	// (c) off-state fake BotApi: no rich, byte-identical HTML body -----------
	test("(c) off states never call sendRichMessage and emit a byte-identical HTML body", async () => {
		const raw = "Just plain final answer text";
		const goldenBody =
			'{"chat_id":"42","message_thread_id":555,"text":"Just plain final answer text","parse_mode":"HTML"}';
		const offStates: Array<{ label: string; rich?: { enabled: boolean } }> = [
			{ label: "enabled false", rich: { enabled: false } },
		];
		for (const state of offStates) {
			const bot = new RichFakeBotApi();
			const daemon = makeRichDaemon(bot, state.rich);
			await driveFinalizedTurn(daemon, bot, richSession(), raw);
			expect(countMethod(bot, "sendRichMessage")).toBe(0);
			expect(countMethod(bot, "sendMessage")).toBe(1);
			const body = findMethod(bot, "sendMessage")!.body;
			// Byte-identical to the pre-rich HTML path (field order included).
			expect(JSON.stringify(body)).toBe(goldenBody);
			expect(body.text).toBe(markdownToTelegramHtml(raw));
			expect(body.parse_mode).toBe(TELEGRAM_PARSE_MODE);
		}
	});

	// (d) exact counts ------------------------------------------------------
	test("(d) on+matching topic promotes exactly one sendRichMessage and no sendMessage", async () => {
		const raw = "# Final\n\nThe answer.";
		const bot = new RichFakeBotApi();
		const daemon = makeRichDaemon(bot, { enabled: true });
		await driveFinalizedTurn(daemon, bot, richSession(), raw);
		expect(countMethod(bot, "sendRichMessage")).toBe(1);
		expect(countMethod(bot, "sendMessage")).toBe(0);
		expect(findMethod(bot, "sendRichMessage")!.body).toEqual({
			chat_id: "42",
			message_thread_id: 555,
			rich_message: { markdown: raw },
		});
	});

	test("(d) editable finalized messageRef stays on HTML edit path and never promotes rich", async () => {
		const bot = new RichFakeBotApi();
		const daemon = makeRichDaemon(bot, { enabled: true });
		const session = richSession();
		await daemon.handleSessionMessage(session, { type: "identity_header", sessionId: "S", repo: "r", branch: "b" });
		expect(bot.calls.length).toBeGreaterThan(0);
		bot.calls.length = 0;

		await daemon.handleSessionMessage(session, {
			type: "turn_stream",
			sessionId: "S",
			phase: "live",
			text: "Hello",
			messageRef: "1",
		});
		await daemon.handleSessionMessage(session, {
			type: "turn_stream",
			sessionId: "S",
			phase: "finalized",
			finalAnswer: true,
			text: "Hello world!",
			messageRef: "1",
		});

		expect(countMethod(bot, "sendRichMessage")).toBe(0);
		expect(countMethod(bot, "editMessageText")).toBeGreaterThanOrEqual(1);
		expect(countMethod(bot, "sendMessage")).toBe(1);
		expect(findMethod(bot, "sendMessage")!.body.text).toBe(markdownToTelegramHtml("Hello"));
	});

	test("(d) editable multi-chunk finalized continuations strip rich markers and never re-promote", async () => {
		const bot = new RichFakeBotApi();
		const daemon = makeRichDaemon(bot, { enabled: true });
		const session = richSession();
		await daemon.handleSessionMessage(session, { type: "identity_header", sessionId: "S", repo: "r", branch: "b" });
		expect(bot.calls.length).toBeGreaterThan(0);
		bot.calls.length = 0;

		await daemon.handleSessionMessage(session, {
			type: "turn_stream",
			sessionId: "S",
			phase: "live",
			text: "seed",
			messageRef: "1",
		});
		const raw = "가".repeat(9000);
		const chunks = splitTelegramHtml(markdownToTelegramHtml(raw));
		expect(chunks.length).toBeGreaterThan(1);

		await daemon.handleSessionMessage(session, {
			type: "turn_stream",
			sessionId: "S",
			phase: "finalized",
			finalAnswer: true,
			text: raw,
			messageRef: "1",
		});

		expect(countMethod(bot, "sendRichMessage")).toBe(0);

		bot.calls.length = 0;
		await daemon.handleSessionMessage(session, {
			type: "turn_stream",
			sessionId: "S",
			phase: "finalized",
			finalAnswer: true,
			text: "tail",
			messageRef: "1",
		});

		expect(countMethod(bot, "sendRichMessage")).toBe(0);
		const sends = bot.calls.filter(c => c.method === "sendMessage");
		expect(sends.length).toBeGreaterThan(0);
		expect(sends.every(c => c.body.parse_mode === TELEGRAM_PARSE_MODE)).toBe(true);
	});

	test("(d) oversized rich finals skip promotion and drain HTML chunks through the pool", async () => {
		const raw = "B".repeat(9000);
		const chunks = splitTelegramHtml(markdownToTelegramHtml(raw));
		expect(chunks.length).toBeGreaterThan(1);
		const bot = new RichFakeBotApi();
		bot.richBehavior = "throw";
		const daemon = makeRichDaemon(bot, { enabled: true });
		const session = richSession();
		await driveFinalizedTurn(daemon, bot, session, raw);
		expect(countMethod(bot, "sendRichMessage")).toBe(0);
		// Fairness: oversized rich payloads stay on the HTML path, where only the
		// first chunk is delivered on this token and the rest are requeued.
		const first = bot.calls.filter(c => c.method === "sendMessage");
		expect(first).toHaveLength(1);
		expect(first[0]!.body.text).toBe(chunks[0]);
		// A follow-up flush drains the requeued continuations (ahead of the newer frame).
		bot.calls.length = 0;
		await daemon.handleSessionMessage(session, {
			type: "turn_stream",
			sessionId: session.sessionId,
			phase: "finalized",
			text: "tail",
		});
		const rest = bot.calls.filter(c => c.method === "sendMessage");
		expect(rest.map(c => c.body.text)).toEqual([...chunks.slice(1), markdownToTelegramHtml("tail")]);
		expect(rest.every(c => c.body.message_thread_id === 555 && c.body.parse_mode === TELEGRAM_PARSE_MODE)).toBe(true);
	});

	test("(d) sendRichMessage ok:false falls back to a single HTML chunk", async () => {
		const raw = "One short final answer";
		const bot = new RichFakeBotApi();
		bot.richBehavior = "ok_false";
		const daemon = makeRichDaemon(bot, { enabled: true });
		await driveFinalizedTurn(daemon, bot, richSession(), raw);
		expect(countMethod(bot, "sendRichMessage")).toBe(1);
		expect(countMethod(bot, "sendMessage")).toBe(1);
		expect(findMethod(bot, "sendMessage")!.body.text).toBe(markdownToTelegramHtml(raw));
	});

	test("(d) deliverRichWithFallback warns exactly once per failure and never on success", async () => {
		const send = { method: "sendMessage", lane: "finalized", text: "<b>x</b>", richMarkdown: "raw md" } as any;
		const base = { chat_id: "42", message_thread_id: 555 };

		const okBot = new RichFakeBotApi();
		const okWarns: string[] = [];
		let okFallbacks = 0;
		await deliverRichWithFallback(
			okBot as any,
			base,
			send,
			async () => {
				okFallbacks++;
			},
			{ warn: m => okWarns.push(m) },
		);
		expect(countMethod(okBot, "sendRichMessage")).toBe(1);
		expect(okFallbacks).toBe(0);
		expect(okWarns).toHaveLength(0);

		const throwBot = new RichFakeBotApi();
		throwBot.richBehavior = "throw";
		const throwWarns: string[] = [];
		let throwFallbacks = 0;
		await deliverRichWithFallback(
			throwBot as any,
			base,
			send,
			async () => {
				throwFallbacks++;
			},
			{ warn: m => throwWarns.push(m) },
		);
		expect(throwFallbacks).toBe(1);
		expect(throwWarns).toHaveLength(1);
		expect(throwWarns[0]).toContain("sendRichMessage failed");

		const okFalseBot = new RichFakeBotApi();
		okFalseBot.richBehavior = "ok_false";
		const okFalseWarns: string[] = [];
		let okFalseFallbacks = 0;
		await deliverRichWithFallback(
			okFalseBot as any,
			base,
			send,
			async () => {
				okFalseFallbacks++;
			},
			{ warn: m => okFalseWarns.push(m) },
		);
		expect(okFalseFallbacks).toBe(1);
		expect(okFalseWarns).toHaveLength(1);
		expect(okFalseWarns[0]).toContain("rich unavailable");
	});

	// (e) global rich matrix ---------------------------------------------------
	test("(e) global rich promotes in threaded and flat delivery", async () => {
		const raw = "Matrix final answer";

		const threadedBot = new RichFakeBotApi();
		await driveFinalizedTurn(makeRichDaemon(threadedBot, { enabled: true }), threadedBot, richSession(), raw);
		expect(countMethod(threadedBot, "sendRichMessage")).toBe(1);
		expect(findMethod(threadedBot, "sendRichMessage")!.body.message_thread_id).toBe(555);

		const flatBot = new RichFakeBotApi();
		flatBot.threadedOff = true;
		await driveFinalizedTurn(makeRichDaemon(flatBot, { enabled: true }), flatBot, richSession(), raw);
		expect(countMethod(flatBot, "sendRichMessage")).toBe(1);
		expect(findMethod(flatBot, "sendRichMessage")!.body.message_thread_id).toBeUndefined();
	});

	// (f) transport-level ok:false -> HTML fallback -------------------------
	test("(f) transport-level {ok:false} sendRichMessage response falls back to HTML", async () => {
		const fetchCalls: Array<{ method: string; body: any }> = [];
		const jsonResponse = (obj: unknown) =>
			new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).split("/").pop() ?? "";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			fetchCalls.push({ method, body });
			if (method === "getChat") return jsonResponse({ ok: true, result: { id: 42, type: "private" } });
			if (method === "getMe") return jsonResponse({ ok: true, result: { id: 1 } });
			if (method === "createForumTopic") return jsonResponse({ ok: true, result: { message_thread_id: 555 } });
			if (method === "sendRichMessage") return jsonResponse({ ok: false, description: "rich off at transport" });
			return jsonResponse({ ok: true, result: { message_id: fetchCalls.length } });
		}) as typeof fetch;
		const transport = new TelegramBotTransport({ botToken: "tok", apiBase: "https://telegram.test", fetchImpl });
		const daemon = new TelegramNotificationDaemon({
			settings: settings(tempAgentDir()),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: transport,
			rich: { enabled: true },
		});
		const session = richSession();
		await daemon.handleSessionMessage(session, { type: "identity_header", sessionId: "S", repo: "r", branch: "b" });
		fetchCalls.length = 0;
		await daemon.handleSessionMessage(session, {
			type: "turn_stream",
			sessionId: "S",
			phase: "finalized",
			finalAnswer: true,
			text: "Transport ok false answer",
		});
		expect(fetchCalls.filter(c => c.method === "sendRichMessage")).toHaveLength(1);
		const htmlSends = fetchCalls.filter(c => c.method === "sendMessage");
		expect(htmlSends.length).toBeGreaterThan(0);
		expect(htmlSends[0].body.text).toBe(markdownToTelegramHtml("Transport ok false answer"));
	});

	// default-on: a finalAnswer-bearing frame reaching a rich-unset daemon promotes rich
	test("default-on: finalAnswer frame on a rich-unset daemon promotes rich", async () => {
		const raw = "# Heading here";
		const bot = new RichFakeBotApi();
		const daemon = makeRichDaemon(bot); // no rich option defaults on
		await driveFinalizedTurn(daemon, bot, richSession(), raw, true);
		expect(countMethod(bot, "sendRichMessage")).toBe(1);
		expect(countMethod(bot, "sendMessage")).toBe(0);
		expect(findMethod(bot, "sendRichMessage")!.body.rich_message.markdown).toBe(raw);
	});

	// long-string seam: a 4096+ finalized message splits identically in the off state
	test("long-string seam: 4096+ off-state finalized message keeps the existing HTML split", async () => {
		const raw = "C".repeat(9000);
		const chunks = splitTelegramHtml(markdownToTelegramHtml(raw));
		expect(chunks.length).toBeGreaterThan(1);
		const bot = new RichFakeBotApi();
		const daemon = makeRichDaemon(bot, { enabled: false }); // off
		await driveFinalizedTurn(daemon, bot, richSession(), raw);
		expect(countMethod(bot, "sendRichMessage")).toBe(0);
		const sends = bot.calls.filter(c => c.method === "sendMessage");
		// Off state uses the unchanged HTML path. Upstream fans the split across
		// pool drains (first chunk now, the rest re-queued), so this flush leads
		// with chunk[0]; the full multi-chunk drain is covered by the pool test
		// above. The point here: no rich promotion, and chunks stay limit-bounded.
		expect(sends.length).toBeGreaterThanOrEqual(1);
		expect(sends[0]!.body.text).toBe(chunks[0]);
		expect(sends.every(c => c.body.text.length <= TELEGRAM_MESSAGE_LIMIT)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// G006: rich overflow boundary. Oversized finalized answers stay on the HTML
// chunk path instead of probing rich and then falling back in the same pool
// drain. The lower-level fallback helper still degrades oversized rich failures
// to split HTML when called directly; the daemon-level contract is that normal
// routing avoids the predictable over-limit rich miss entirely.
// ---------------------------------------------------------------------------
describe("telegram daemon rich overflow boundary (G006)", () => {
	test("(g) 4096+ finalized payload skips rich and drains HTML chunks through the pool", async () => {
		const raw = "D".repeat(9000);
		const html = markdownToTelegramHtml(raw);
		const chunks = splitTelegramHtml(html);
		expect(html.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT); // genuine 4096+ overflow
		expect(chunks.length).toBeGreaterThan(1); // must actually split into multiple messages

		const bot = new RichFakeBotApi();
		bot.richBehavior = "ok_false";
		const daemon = makeRichDaemon(bot, { enabled: true });
		const session = richSession();
		await driveFinalizedTurn(daemon, bot, session, raw);

		// Oversized rich payloads are not promoted, so the granted pool slot maps to
		// one HTML sendMessage and continuations are drained on later slots.
		expect(countMethod(bot, "sendRichMessage")).toBe(0);
		const first = bot.calls.filter(c => c.method === "sendMessage");
		expect(first).toHaveLength(1);
		expect(first[0]!.body.text).toBe(chunks[0]);
		bot.calls.length = 0;
		await daemon.handleSessionMessage(session, {
			type: "turn_stream",
			sessionId: session.sessionId,
			phase: "finalized",
			text: "tail",
		});
		const rest = bot.calls.filter(c => c.method === "sendMessage");
		const allChunkTexts = [chunks[0], ...rest.map(c => c.body.text)];
		expect(allChunkTexts).toEqual([...chunks, markdownToTelegramHtml("tail")]); // no content dropped
		expect(rest.every(c => c.body.text.length <= TELEGRAM_MESSAGE_LIMIT)).toBe(true);
		expect(rest.every(c => c.body.message_thread_id === 555 && c.body.parse_mode === TELEGRAM_PARSE_MODE)).toBe(true);
	});

	test("(g) rich {ok:false} at 4096+ overflow warns exactly once and runs the chunked HTML fallback once", async () => {
		const raw = "E".repeat(9000);
		const html = markdownToTelegramHtml(raw);
		const chunks = splitTelegramHtml(html);
		expect(html.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);
		expect(chunks.length).toBeGreaterThan(1);

		const bot = new RichFakeBotApi();
		bot.richBehavior = "ok_false";
		const send = { method: "sendMessage", lane: "finalized", text: html, richMarkdown: raw } as any;
		const base = { chat_id: "42", message_thread_id: 555 };
		const warns: string[] = [];
		let fallbacks = 0;
		// Mirror the daemon's sendHtmlFallback closure (telegram-daemon.ts) verbatim.
		const sendHtmlFallback = async () => {
			fallbacks++;
			for (const text of splitTelegramHtml(send.text)) {
				await bot.call("sendMessage", {
					chat_id: base.chat_id,
					message_thread_id: base.message_thread_id,
					text,
					parse_mode: TELEGRAM_PARSE_MODE,
				});
			}
		};
		await deliverRichWithFallback(bot as any, base, send, sendHtmlFallback, { warn: m => warns.push(m) });

		expect(countMethod(bot, "sendRichMessage")).toBe(1);
		expect(fallbacks).toBe(1); // fallback invoked exactly once for the whole overflow
		expect(warns).toHaveLength(1); // one diagnostic, NOT one per chunk
		expect(warns[0]).toContain("sendRichMessage failed");
		const sends = bot.calls.filter(c => c.method === "sendMessage");
		expect(sends).toHaveLength(chunks.length);
		expect(sends.map(c => c.body.text)).toEqual(chunks);
		expect(sends.every(c => c.body.text.length <= TELEGRAM_MESSAGE_LIMIT)).toBe(true);
	});

	test("(g) normal-length (<= limit) traffic is unchanged: promoted -> one rich send; off -> one HTML send", async () => {
		const raw = "A concise final answer well under the Telegram limit.";
		expect(markdownToTelegramHtml(raw).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT); // no overflow

		// Promoted + ok:true -> exactly one sendRichMessage, and NO HTML fallback/split.
		const onBot = new RichFakeBotApi();
		await driveFinalizedTurn(makeRichDaemon(onBot, { enabled: true }), onBot, richSession(), raw);
		expect(countMethod(onBot, "sendRichMessage")).toBe(1);
		expect(countMethod(onBot, "sendMessage")).toBe(0);

		// Off -> the unchanged single HTML sendMessage (no rich, no split).
		const offBot = new RichFakeBotApi();
		await driveFinalizedTurn(makeRichDaemon(offBot, { enabled: false }), offBot, richSession(), raw);
		expect(countMethod(offBot, "sendRichMessage")).toBe(0);
		expect(countMethod(offBot, "sendMessage")).toBe(1);
		expect(findMethod(offBot, "sendMessage")!.body.text).toBe(markdownToTelegramHtml(raw));
	});
});

describe("telegram daemon action-needed rich delivery (G004)", () => {
	function makeAskDaemon(bot: FakeBotApi, rich: { enabled: boolean }) {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot as any,
			WebSocketImpl: FakeWs as any,
			rich,
		});
		daemon.connectSession("S", "ws://s", "ts");
		return daemon;
	}

	test("ask rich success: one sendRichMessage with reply_markup, route registered, callback + free-text reply route", async () => {
		FakeWs.instances = [];
		const bot = new RichFakeBotApi();
		const daemon = makeAskDaemon(bot, { enabled: true });
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask",
			question: "Q",
			options: ["Y", "N"],
		});
		const rich = bot.calls.filter(c => c.method === "sendRichMessage");
		expect(rich).toHaveLength(1);
		expect(countMethod(bot, "sendMessage")).toBe(0);
		expect(rich[0]!.body.rich_message.markdown).toContain("Q");
		expect(rich[0]!.body.reply_markup.inline_keyboard).toBeTruthy();
		expect(rich[0]!.body.message_thread_id).toBe(555);
		expect(daemon.messageRoutes.get("4242")).toEqual({ sessionId: "S", actionId: "ask" });

		const alias = rich[0]!.body.reply_markup.inline_keyboard[0][0].callback_data;
		await daemon.handleTelegramUpdate({
			update_id: 1,
			callback_query: { id: "cb", data: alias, message: { chat: { id: 42 } } },
		});
		expect(JSON.parse(FakeWs.instances[0]!.sent.at(-1)!)).toEqual({
			type: "reply",
			id: "ask",
			answer: 0,
			token: "ts",
		});

		await daemon.handleTelegramUpdate({
			update_id: 2,
			message: { chat: { id: 42 }, text: "typed answer", reply_to_message: { message_id: 4242 } },
		});
		expect(JSON.parse(FakeWs.instances[0]!.sent.at(-1)!)).toEqual({
			type: "reply",
			id: "ask",
			answer: "typed answer",
			token: "ts",
		});
	});

	for (const behavior of ["ok_false", "throw"] as const) {
		test(`ask rich ${behavior}: HTML fallback registers last-chunk id and routes replies`, async () => {
			FakeWs.instances = [];
			const bot = new RichFakeBotApi();
			bot.richBehavior = behavior;
			const daemon = makeAskDaemon(bot, { enabled: true });
			await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
				type: "action_needed",
				kind: "ask",
				id: "ask",
				question: "Q",
				options: ["Y", "N"],
			});
			expect(countMethod(bot, "sendRichMessage")).toBe(1);
			const htmlSends = bot.calls.filter(c => c.method === "sendMessage");
			expect(htmlSends.length).toBeGreaterThanOrEqual(1);
			expect(htmlSends.at(-1)!.body.reply_markup.inline_keyboard).toBeTruthy();
			const askEntry = [...daemon.messageRoutes.entries()].find(
				([, route]) => route.sessionId === "S" && route.actionId === "ask",
			);
			expect(askEntry).toBeDefined();
			await daemon.handleTelegramUpdate({
				update_id: 1,
				message: { chat: { id: 42 }, text: "typed", reply_to_message: { message_id: Number(askEntry![0]) } },
			});
			expect(JSON.parse(FakeWs.instances[0]!.sent.at(-1)!)).toEqual({
				type: "reply",
				id: "ask",
				answer: "typed",
				token: "ts",
			});
		});
	}

	test("idle rich: one sendRichMessage without reply_markup and no message route", async () => {
		FakeWs.instances = [];
		const bot = new RichFakeBotApi();
		const daemon = makeAskDaemon(bot, { enabled: true });
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "idle",
			id: "idle1",
			summary: "all done",
		});
		expect(countMethod(bot, "sendRichMessage")).toBe(1);
		expect(countMethod(bot, "sendMessage")).toBe(0);
		const rich = findMethod(bot, "sendRichMessage")!;
		expect(rich.body.rich_message.markdown).toContain("Agent idle");
		expect(rich.body.reply_markup).toBeUndefined();
		expect(daemon.messageRoutes.size).toBe(0);
	});

	test("off (rich.enabled=false) ask: byte-identical HTML, zero sendRichMessage", async () => {
		FakeWs.instances = [];
		const bot = new RichFakeBotApi();
		const daemon = makeAskDaemon(bot, { enabled: false });
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask",
			question: "Q",
			options: ["Y", "N"],
		});
		expect(countMethod(bot, "sendRichMessage")).toBe(0);
		const sends = bot.calls.filter(c => c.method === "sendMessage");
		expect(sends).toHaveLength(1);
		expect(sends[0]!.body.parse_mode).toBe(TELEGRAM_PARSE_MODE);
		expect(sends[0]!.body.reply_markup.inline_keyboard).toBeTruthy();
		const askEntry = [...daemon.messageRoutes.entries()].find(
			([, route]) => route.sessionId === "S" && route.actionId === "ask",
		);
		expect(askEntry).toBeDefined();
	});
});

describe("telegram daemon /rich toggle (G005)", () => {
	function richDaemonWithSettings(bot: FakeBotApi, s: Settings, enabled: boolean) {
		return new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot as any,
			rich: { enabled },
		});
	}

	test("/rich off persists the setting, updates runtime, and confirms in-topic", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new RichFakeBotApi();
		const daemon = richDaemonWithSettings(bot, s, true);

		await daemon.handleTelegramUpdate({
			update_id: 501,
			message: { chat: { id: 42 }, message_thread_id: 555, text: "/rich off", message_id: 1 },
		});
		const confirm = bot.calls.find(c => c.method === "sendMessage" && c.body.text === "Rich messages: off");
		expect(confirm).toBeDefined();
		expect(confirm!.body.message_thread_id).toBe(555);
		expect(s.get("notifications.telegram.rich.enabled")).toBe(false);

		// Runtime is toggled immediately: the next finalized final is HTML, not rich.
		bot.calls.length = 0;
		await driveFinalizedTurn(daemon, bot, richSession(), "answer after off");
		expect(countMethod(bot, "sendRichMessage")).toBe(0);
		expect(countMethod(bot, "sendMessage")).toBe(1);
	});

	test("/rich on re-enables rich at runtime and persists true", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new RichFakeBotApi();
		const daemon = richDaemonWithSettings(bot, s, false);

		await daemon.handleTelegramUpdate({
			update_id: 502,
			message: { chat: { id: 42 }, text: "/rich on", message_id: 1 },
		});
		expect(bot.calls.some(c => c.method === "sendMessage" && c.body.text === "Rich messages: on")).toBe(true);
		expect(s.get("notifications.telegram.rich.enabled")).toBe(true);

		bot.calls.length = 0;
		await driveFinalizedTurn(daemon, bot, richSession(), "answer after on");
		expect(countMethod(bot, "sendRichMessage")).toBe(1);
	});

	test("/rich works with no connected session (handled before WS-dependent injection)", async () => {
		const bot = new RichFakeBotApi();
		const daemon = makeRichDaemon(bot, { enabled: true }); // no connectSession
		await daemon.handleTelegramUpdate({
			update_id: 601,
			message: { chat: { id: 42 }, text: "/rich off", message_id: 1 },
		});
		expect(bot.calls.some(c => c.method === "sendMessage" && c.body.text === "Rich messages: off")).toBe(true);
	});

	test("invalid /rich arg returns usage guidance and is not injected", async () => {
		const bot = new RichFakeBotApi();
		const daemon = makeRichDaemon(bot, { enabled: true });
		await daemon.handleTelegramUpdate({
			update_id: 602,
			message: { chat: { id: 42 }, text: "/rich maybe", message_id: 1 },
		});
		expect(bot.calls.some(c => c.method === "sendMessage" && c.body.text === "Usage: /rich on|off")).toBe(true);
	});

	test("/rich off while an ask is pending is a config command, not an ask answer", async () => {
		FakeWs.instances = [];
		const bot = new RichFakeBotApi();
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot as any,
			WebSocketImpl: FakeWs as any,
			rich: { enabled: true },
		});
		daemon.connectSession("S", "ws://s", "ts");
		await daemon.handleSessionMessage(daemon.sessions.get("S")!, {
			type: "action_needed",
			kind: "ask",
			id: "ask",
			question: "Q",
			options: ["Y", "N"],
		});
		const threadId = bot.calls.find(c => c.method === "sendRichMessage")?.body.message_thread_id;
		const before = FakeWs.instances[0]!.sent.length;
		bot.calls.length = 0;

		await daemon.handleTelegramUpdate({
			update_id: 701,
			message: { chat: { id: 42 }, message_thread_id: threadId, text: "/rich off", message_id: 9 },
		});

		const afterFrames = FakeWs.instances[0]!.sent.slice(before).map(f => JSON.parse(f));
		expect(afterFrames.some(f => f.type === "reply")).toBe(false); // ask NOT answered
		expect(bot.calls.some(c => c.method === "sendMessage" && c.body.text === "Rich messages: off")).toBe(true);
	});

	test("settings write failure leaves runtime unchanged and warns the user", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		(s as any).set = () => {
			throw new Error("disk full");
		};
		const bot = new RichFakeBotApi();
		const daemon = richDaemonWithSettings(bot, s, true);

		await daemon.handleTelegramUpdate({
			update_id: 801,
			message: { chat: { id: 42 }, text: "/rich off", message_id: 1 },
		});
		expect(bot.calls.some(c => c.method === "sendMessage" && String(c.body.text).includes("unchanged"))).toBe(true);

		// Runtime stays rich because the persistence failed.
		bot.calls.length = 0;
		await driveFinalizedTurn(daemon, bot, richSession(), "still rich");
		expect(countMethod(bot, "sendRichMessage")).toBe(1);
	});

	test("a non-paired chat cannot toggle rich", async () => {
		const bot = new RichFakeBotApi();
		const daemon = makeRichDaemon(bot, { enabled: true });
		await daemon.handleTelegramUpdate({
			update_id: 901,
			message: { chat: { id: -99999 }, text: "/rich off", message_id: 1 },
		});
		expect(bot.calls.some(c => c.method === "sendMessage" && String(c.body.text).startsWith("Rich messages"))).toBe(
			false,
		);
	});

	test("/rich in a non-private paired chat is rejected (fail-closed, no toggle)", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(settings(agentDir), agentDir);
		const bot = new RichFakeBotApi();
		// Paired chat resolves to a group/supergroup, not a private DM.
		bot.call = (async (method: string, body: any) => {
			bot.calls.push({ method, body });
			if (method === "getChat") return { ok: true, result: { id: body.chat_id, type: "supergroup" } };
			if (method === "sendMessage") return { ok: true, result: { message_id: bot.calls.length } };
			return { ok: true, result: true };
		}) as any;
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot as any,
			rich: { enabled: true },
		});
		await daemon.handleTelegramUpdate({
			update_id: 951,
			message: { chat: { id: 42, type: "supergroup" }, text: "/rich off", message_id: 1 },
		});
		// No toggle confirmation is sent and the persisted setting is untouched.
		expect(bot.calls.some(c => c.method === "sendMessage" && String(c.body.text).startsWith("Rich messages"))).toBe(
			false,
		);
		expect(s.get("notifications.telegram.rich.enabled")).toBe(true);
	});

	test("/rich confirms success only after a durable flushOrThrow (swallowed background save)", async () => {
		const agentDir = tempAgentDir();
		// The real Settings.set is a synchronous fire-and-forget whose background
		// #saveNow swallows write errors, so flushOrThrow() is the only signal of a
		// failed config.yml write. Simulate set() succeeding while flushOrThrow()
		// rejects, and assert /rich does NOT confirm success.
		const base = setPrivateAgentDir(settings(agentDir), agentDir);
		const s = new Proxy(base, {
			get(target, prop) {
				if (prop === "set") return async () => undefined;
				if (prop === "flushOrThrow")
					return async () => {
						throw new Error("config.yml write failed");
					};
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as Settings;
		const bot = new RichFakeBotApi();
		bot.call = (async (method: string, body: any) => {
			bot.calls.push({ method, body });
			if (method === "getChat") return { ok: true, result: { id: body.chat_id, type: "private" } };
			if (method === "sendMessage") return { ok: true, result: { message_id: bot.calls.length } };
			return { ok: true, result: true };
		}) as any;
		const daemon = new TelegramNotificationDaemon({
			settings: s,
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot as any,
			rich: { enabled: true },
		});
		await daemon.handleTelegramUpdate({
			update_id: 952,
			message: { chat: { id: 42, type: "private" }, text: "/rich off", message_id: 1 },
		});
		// A durable-write failure is reported as "unchanged"; success is never confirmed.
		expect(
			bot.calls.some(
				c => c.method === "sendMessage" && c.body.text === "Rich messages: unchanged (settings write failed)",
			),
		).toBe(true);
		expect(bot.calls.some(c => c.method === "sendMessage" && c.body.text === "Rich messages: off")).toBe(false);
	});
});

describe("Telegram tool activity capability and routing", () => {
	test("advertises tool_activity_v1 and routes new threaded frame kinds", () => {
		FakeWs.instances = [];
		const agentDir = tempAgentDir();
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: new FakeBotApi(),
			WebSocketImpl: FakeWs as any,
		});
		daemon.connectSession("S", "ws://s", "ts");
		FakeWs.instances[0]!.dispatchEvent(new Event("open"));
		const hello = FakeWs.instances[0]!.sent.map(frame => JSON.parse(frame)).find(frame => frame.type === "hello");
		expect(hello.capabilities).toContain(TOOL_ACTIVITY_CAPABILITY);
		const threadedFrames = (TelegramNotificationDaemon as any).THREADED_FRAMES as Set<string>;
		expect(threadedFrames.has("tool_activity")).toBe(true);
		expect(threadedFrames.has("reasoning_summary")).toBe(true);
	});
	test("parallel tool bubbles retain in-flight entries and evict completed entries", async () => {
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
		const sendToolActivity = async (toolCallId: "A" | "B", phase: "started" | "completed") =>
			daemon.handleSessionMessage(session as never, {
				type: "tool_activity",
				sessionId: "S",
				toolCallId,
				toolName: `tool-${toolCallId}`,
				phase,
			});
		await daemon.handleSessionMessage(session as never, {
			type: "identity_header",
			sessionId: "S",
			repo: "repo",
			branch: "branch",
		});
		bot.calls = [];

		const liveMessages = (daemon as unknown as { liveMessages: Map<string, number> }).liveMessages;
		await sendToolActivity("A", "started");
		await sendToolActivity("B", "started");
		expect(liveMessages.get("S:tool:A")).toBe(1);
		expect(liveMessages.get("S:tool:B")).toBe(2);

		await sendToolActivity("A", "completed");
		expect(bot.calls.filter(call => call.method === "editMessageText")).toEqual([
			expect.objectContaining({
				body: expect.objectContaining({ message_id: 1, text: expect.stringContaining("tool-A — ok") }),
			}),
		]);
		expect(liveMessages.has("S:tool:A")).toBe(false);
		expect(liveMessages.get("S:tool:B")).toBe(2);

		await sendToolActivity("B", "completed");
		const sends = bot.calls.filter(call => call.method === "sendMessage");
		const edits = bot.calls.filter(call => call.method === "editMessageText");
		expect(sends).toHaveLength(2);
		expect(edits).toHaveLength(2);
		expect(edits.map(call => call.body.message_id)).toEqual([1, 2]);
		expect(edits.map(call => call.body.text)).toEqual([
			expect.stringContaining("tool-A — ok"),
			expect.stringContaining("tool-B — ok"),
		]);
		expect(liveMessages.has("S:tool:A")).toBe(false);
		expect(liveMessages.has("S:tool:B")).toBe(false);
		(
			daemon as unknown as { recordLiveMessage(sessionId: string, coalesceKey: string, messageId: number): void }
		).recordLiveMessage("S", "turn:one", 101);
		(
			daemon as unknown as { recordLiveMessage(sessionId: string, coalesceKey: string, messageId: number): void }
		).recordLiveMessage("S", "turn:two", 102);
		expect(liveMessages.has("S:turn:one")).toBe(false);
		expect(liveMessages.get("S:turn:two")).toBe(102);
	});

	test("failed terminal tool delivery evicts its key before a later reuse", async () => {
		const agentDir = tempAgentDir();
		const bot = new FakeBotApi();
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: "owner",
			botToken: "tok",
			chatId: "42",
			botApi: bot,
			WebSocketImpl: FakeWs as any,
		});
		const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
		const sendToolActivity = async (phase: "started" | "completed") =>
			daemon.handleSessionMessage(session as never, {
				type: "tool_activity",
				sessionId: "S",
				toolCallId: "A",
				toolName: "tool-A",
				phase,
			});
		await daemon.handleSessionMessage(session as never, {
			type: "identity_header",
			sessionId: "S",
			repo: "repo",
			branch: "branch",
		});
		bot.calls = [];
		await sendToolActivity("started");
		const liveMessages = (daemon as unknown as { liveMessages: Map<string, number> }).liveMessages;
		expect(liveMessages.get("S:tool:A")).toBe(1);

		const normalCall = bot.call.bind(bot);
		bot.call = (async (method: string, body: unknown) => {
			bot.calls.push({ method, body });
			if (method === "editMessageText" || method === "sendMessage") throw new Error("terminal delivery failed");
			return normalCall(method, body);
		}) as typeof bot.call;
		await sendToolActivity("completed");
		expect(liveMessages.has("S:tool:A")).toBe(false);

		bot.call = normalCall;
		bot.calls = [];
		await sendToolActivity("started");
		expect(bot.calls.some(call => call.method === "editMessageText")).toBe(false);
		expect(bot.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
		expect(liveMessages.has("S:tool:A")).toBe(true);
	});
});
