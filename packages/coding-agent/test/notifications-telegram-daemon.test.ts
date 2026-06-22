import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import {
	acquireDaemonOwnership,
	DAEMON_VERSION,
	daemonPaths,
	ensureTelegramDaemonRunning,
	registerNotificationRoot,
	releaseDaemonOwnership,
	renewDaemonHeartbeat,
	TelegramNotificationDaemon,
} from "../src/notifications/telegram-daemon";
import { runDaemonInternal, runDaemonSmoke } from "../src/notifications/telegram-daemon-cli";

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

class FakeWs extends EventTarget {
	static OPEN = 1;
	readyState = 1;
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
		if (method === "createForumTopic") return { ok: true, result: { message_thread_id: this.calls.length } };
		if (method === "sendMessage") return { ok: true, result: { message_id: this.calls.length } };
		return { ok: true, result: true };
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
			override async scanRoots(): Promise<void> {}
		}
		await runDaemonInternal(["--agent-dir", agentDir, "--owner-id", "owner"], {
			SettingsImpl: { init: async () => s },
			DaemonImpl: OneShotDaemon,
			processPid: 222,
		});
		const state = JSON.parse(fs.readFileSync(daemonPaths(agentDir).state, "utf8")) as {
			pid: number;
			ownerId: string;
		};
		expect(state.pid).toBe(222);
		expect(state.ownerId).toBe("owner");
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
		FakeWs.instances[0]!.readyState = 3;
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

		// Endpoint discovery files live at <cwd>/.gjc/state/notifications/<sessionId>.json.
		const writeEndpoint = async (cwd: string, sessionId: string, url: string) => {
			await registerNotificationRoot({ settings: s, cwd, sessionId });
			const dir = path.join(cwd, ".gjc", "state", "notifications");
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
		const endpointDir = path.join(roots.roots[0]!, "notifications");
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

test("daemon registers in-thread config commands and drops stale rpc/answer commands", async () => {
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
	expect(cmds).not.toContain("answer");
	expect(cmds).not.toContain("attach");
	expect(cmds).not.toContain("detach");
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
test("image_attachment frame uploads via sendPhoto into the session topic", async () => {
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
		type: "image_attachment",
		sessionId: "S",
		source: "computer",
		mime: "image/png",
		data: "AAAA",
	});
	const createTopic = bot.calls.find(c => c.method === "createForumTopic");
	const photo = bot.calls.find(c => c.method === "sendPhoto");
	expect(createTopic).toBeTruthy();
	expect(photo).toBeTruthy();
	expect(photo!.body.photo).toBe("AAAA");
	expect(Number(photo!.body.message_thread_id)).toBeGreaterThan(0);
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

describe("telegram daemon reconnect reconciliation", () => {
	function endpointFor(agentDir: string, cwd: string, s: Settings, sessionId: string) {
		return (async () => {
			await registerNotificationRoot({ settings: s, cwd, sessionId });
			const roots = JSON.parse(fs.readFileSync(daemonPaths(agentDir).roots, "utf8")) as { roots: string[] };
			const dir = path.join(roots.roots[0]!, "notifications");
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
		const dir = path.join(roots.roots[0]!, "notifications");
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
