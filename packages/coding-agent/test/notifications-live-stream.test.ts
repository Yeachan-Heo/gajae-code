import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../src/config/settings";
import { getNotificationConfig } from "../src/sdk/bus/config";
import { createNotificationsExtension } from "../src/sdk/bus/index";
import type { NotificationSessionContext } from "../src/sdk/bus/session-control";
import { NotificationSessionController } from "../src/sdk/bus/session-control";
import { type EnsureDaemonResult, TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";
import { TelegramDaemonController } from "../src/sdk/bus/telegram-daemon-control";
import { readEndpoint } from "../src/sdk/bus/telegram-reference";
import { renderThreadedFrame } from "../src/sdk/bus/threaded-render";
import {
	cleanupFixtureRoots,
	createNotificationFixtureRoot,
	type FixtureRootCleanup,
	isolatedNotificationSettings,
	registerNotificationRuntime,
} from "./helpers/notification-settings";

// ---------------------------------------------------------------------------
// 1) Pure render contract: streamed turn frames become editable, and live +
//    finalized share ONE coalesce key when a messageRef is present.
// ---------------------------------------------------------------------------

test("turn_stream live and finalized share one coalesce key when a messageRef is present", () => {
	const live = renderThreadedFrame({
		type: "turn_stream",
		sessionId: "S",
		phase: "live",
		text: "partial",
		messageRef: "7",
	});
	const final = renderThreadedFrame({
		type: "turn_stream",
		sessionId: "S",
		phase: "finalized",
		text: "done",
		messageRef: "7",
	});
	expect(live?.lane).toBe("live");
	expect(final?.lane).toBe("finalized");
	expect(live?.coalesceKey).toBe("turn:7");
	expect(final?.coalesceKey).toBe("turn:7"); // same message -> edited in place
	expect(live?.editable).toBe(true);
	expect(final?.editable).toBe(true);
});

test("finalized turn_stream without a messageRef keeps legacy keyless behaviour (fresh message)", () => {
	const final = renderThreadedFrame({ type: "turn_stream", sessionId: "S", phase: "finalized", text: "done" });
	expect(final?.coalesceKey).toBeUndefined();
	expect(final?.editable).toBeFalsy(); // not editable -> daemon posts a fresh message
});

// ---------------------------------------------------------------------------
// 2) Core emit: message_update -> throttled live turn_stream frames, durable
//    Telegram preference with env override, and redaction-aware finalization.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000, label = "condition"): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return;
		await sleep(25);
	}
	throw new Error(`timeout waiting for ${label}`);
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type Frame = { type: string; phase?: string; text?: string; messageRef?: string };

const cleanupRoots: FixtureRootCleanup[] = [];
const openSockets: WebSocket[] = [];
const envKeys = [
	"GJC_NOTIFICATIONS",
	"GJC_NOTIFICATIONS_STREAM",
	"GJC_NOTIFICATIONS_STREAM_INTERVAL_MS",
	"GJC_NOTIFICATIONS_TURN_MAX",
] as const;
let savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
	for (const ws of openSockets.splice(0)) {
		try {
			ws.close();
		} catch {}
	}
	await cleanupFixtureRoots(cleanupRoots);
	for (const k of envKeys) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	savedEnv = {};
});

function setEnv(over: Partial<Record<(typeof envKeys)[number], string>>): void {
	for (const k of envKeys) savedEnv[k] = process.env[k];
	for (const k of envKeys) delete process.env[k];
	for (const [k, v] of Object.entries(over)) process.env[k] = v;
}

async function bootSession(
	settingsOverrides: Record<string, unknown> = {},
	options: {
		ensureTelegramDaemon?: (input: {
			settings: Settings;
			cwd: string;
			sessionId: string;
		}) => Promise<EnsureDaemonResult>;
	} = {},
): Promise<{
	handlers: Map<string, Handler>;
	ctx: NotificationSessionContext;
	frames: Frame[];
	settings: Settings;
	controller: NotificationSessionController;
}> {
	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-stream-"));
	const agentDir = path.join(cwd, ".gjc", "agent");
	const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
	cleanupRoots.push(cleanup);
	const botToken = settingsOverrides["notifications.telegram.botToken"];
	const chatId = settingsOverrides["notifications.telegram.chatId"];
	if (typeof botToken === "string" && typeof chatId === "string") {
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			`notifications:\n  enabled: true\n  daemon:\n    idleTimeoutMs: 20\n  telegram:\n    botToken: ${JSON.stringify(botToken)}\n    chatId: ${JSON.stringify(chatId)}\n`,
		);
	}
	// Live streaming and per-turn finals are verbose-mode contracts. Lean defers
	// settled answers to agent_end and suppresses live frames (#2863).
	const settings = isolatedNotificationSettings(agentDir, {
		"notifications.verbosity": "verbose",
		...settingsOverrides,
	});
	const controller = new NotificationSessionController({
		eligible: true,
		getConfig: () => getNotificationConfig(settings),
	});
	createNotificationsExtension(api, { settings, controller, ensureTelegramDaemon: options.ensureTelegramDaemon });
	const sid = `stream-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => "Stream Test",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
		getContextUsage: () => undefined,
		getModel: () => undefined,
	} as NotificationSessionContext;

	registerNotificationRuntime(cleanup, {
		key: `notification-session:${sid}`,
		shutdown: async () => {
			await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
			if (typeof botToken === "string" && typeof chatId === "string") {
				const stopped = await new TelegramDaemonController(settings).stop();
				if (!stopped.ok) throw new Error(`Failed to stop fixture Telegram daemon: ${stopped.message}`);
			}
		},
	});
	await handlers.get("session_start")!({ type: "session_start" }, ctx);
	await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sid}.json`);
	await waitFor(() => fs.existsSync(endpointFile), 4000, "endpoint file");
	const { url, token } = readEndpoint(endpointFile);

	const frames: Frame[] = [];
	const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	openSockets.push(ws);
	ws.addEventListener("message", ev => frames.push(JSON.parse(String((ev as MessageEvent).data))));
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("ws error")));
	});
	await sleep(250);
	return { handlers, ctx, frames, settings, controller };
}

const assistant = (content: string) => ({ type: "message_update", message: { role: "assistant", content } });

test("lean suppresses live frames even when streaming is enabled", async () => {
	setEnv({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_STREAM: "1", GJC_NOTIFICATIONS_STREAM_INTERVAL_MS: "1" });
	const { handlers, ctx, frames } = await bootSession({ "notifications.verbosity": "lean" });
	const streams = () => frames.filter(f => f.type === "turn_stream");

	await handlers.get("message_update")!(assistant("partial while tools run"), ctx);
	await handlers.get("turn_end")!(
		{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "partial while tools run" } },
		ctx,
	);
	await sleep(200);
	expect(streams().some(f => f.phase === "live")).toBe(false);
	expect(streams().some(f => f.phase === "finalized")).toBe(false);

	await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
	await waitFor(() => streams().some(f => f.phase === "finalized"), 3000, "settled lean frame");
	expect(streams().filter(f => f.phase === "finalized")).toHaveLength(1);
	expect(streams().find(f => f.phase === "finalized")!.text).toContain("partial while tools run");
}, 15_000);

test("message_update emits a live turn_stream whose messageRef matches the finalized turn", async () => {
	setEnv({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_STREAM: "1", GJC_NOTIFICATIONS_STREAM_INTERVAL_MS: "100000" });
	const { handlers, ctx, frames } = await bootSession();
	const streams = () => frames.filter(f => f.type === "turn_stream");

	await handlers.get("message_update")!(assistant("Hello, streaming"), ctx);
	await waitFor(() => streams().some(f => f.phase === "live"), 3000, "live frame");
	const live = streams().find(f => f.phase === "live")!;
	expect(live.text).toContain("Hello, streaming");
	expect(live.messageRef).toBe("1");

	await handlers.get("turn_end")!(
		{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Hello, streaming — done" } },
		ctx,
	);
	await waitFor(() => streams().some(f => f.phase === "finalized"), 3000, "finalized frame");
	const final = streams().find(f => f.phase === "finalized")!;
	expect(final.text).toContain("done");
	expect(final.messageRef).toBe("1"); // same message as the live edits
}, 15_000);

test("rapid live updates are throttled to a single frame within the interval", async () => {
	setEnv({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_STREAM: "1", GJC_NOTIFICATIONS_STREAM_INTERVAL_MS: "100000" });
	const { handlers, ctx, frames } = await bootSession();
	const live = () => frames.filter(f => f.type === "turn_stream" && f.phase === "live");

	await handlers.get("message_update")!(assistant("one"), ctx);
	await handlers.get("message_update")!(assistant("one two"), ctx);
	await handlers.get("message_update")!(assistant("one two three"), ctx);
	await waitFor(() => live().length >= 1, 3000, "first live frame");
	await sleep(200);
	expect(live().length).toBe(1); // later updates fall inside the throttle window
}, 15_000);

test("defers a finalized turn during ownership preflight and flushes it once with the live message reference", async () => {
	setEnv({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_STREAM_INTERVAL_MS: "100000" });
	let deferEnsure = false;
	const ensureEntered = Promise.withResolvers<void>();
	const releaseEnsure = Promise.withResolvers<void>();
	const { handlers, ctx, frames, settings, controller } = await bootSession(
		{
			"notifications.enabled": true,
			"notifications.telegram.botToken": "123456:secret-token",
			"notifications.telegram.chatId": "42",
		},
		{
			ensureTelegramDaemon: async () => {
				if (!deferEnsure) return "attached";
				ensureEntered.resolve();
				await releaseEnsure.promise;
				return "attached";
			},
		},
	);
	deferEnsure = true;
	const streams = () => frames.filter(frame => frame.type === "turn_stream");
	await handlers.get("message_update")!(assistant("partial before preference save"), ctx);
	await waitFor(() => streams().some(frame => frame.phase === "live"), 3000, "live frame");
	const liveRef = streams().find(frame => frame.phase === "live")?.messageRef;

	settings.set("notifications.telegram.streaming.enabled", false);
	const reconciliation = controller.reconcileCurrentSession(ctx);
	await Promise.race([
		ensureEntered.promise,
		Bun.sleep(3000).then(() => {
			throw new Error("deferred ensure was not entered");
		}),
	]);
	await handlers.get("turn_end")!(
		{ type: "turn_end", message: { role: "assistant", content: "authoritative final during preflight" } },
		ctx,
	);
	await sleep(50);
	expect(streams().some(frame => frame.phase === "finalized")).toBe(false);

	releaseEnsure.resolve();
	await Promise.race([
		reconciliation,
		Bun.sleep(3000).then(() => {
			throw new Error("reconciliation did not settle after ensure release");
		}),
	]);
	await waitFor(() => streams().some(frame => frame.phase === "finalized"), 3000, "deferred finalized frame");
	const finalized = streams().filter(frame => frame.phase === "finalized");
	expect(finalized).toHaveLength(1);
	expect(finalized[0]?.messageRef).toBe(liveRef);
	expect(finalized[0]?.text).toContain("authoritative final during preflight");
}, 20_000);

test("a durable Telegram streaming disable before the first live frame leaves the final keyless", async () => {
	setEnv({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_STREAM_INTERVAL_MS: "100000" });
	const { handlers, ctx, frames } = await bootSession({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
		"notifications.telegram.streaming.enabled": false,
	});

	await handlers.get("message_update")!(assistant("should not stream"), ctx);
	await sleep(200);
	expect(frames.filter(frame => frame.type === "turn_stream" && frame.phase === "live")).toHaveLength(0);

	await handlers.get("turn_end")!(
		{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "final only" } },
		ctx,
	);
	await waitFor(
		() => frames.some(frame => frame.type === "turn_stream" && frame.phase === "finalized"),
		3000,
		"finalized",
	);
	const final = frames.find(frame => frame.type === "turn_stream" && frame.phase === "finalized")!;
	expect(final.messageRef).toBeUndefined();
}, 15_000);

test("a configured Telegram destination enables durable streaming by default", async () => {
	setEnv({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_STREAM_INTERVAL_MS: "100000" });
	const { handlers, ctx, frames } = await bootSession({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
	});

	await handlers.get("message_update")!(assistant("enabled by durable default"), ctx);
	await waitFor(
		() => frames.some(frame => frame.type === "turn_stream" && frame.phase === "live"),
		3000,
		"durable-default live frame",
	);
	const live = frames.find(frame => frame.type === "turn_stream" && frame.phase === "live")!;
	expect(live.text).toContain("enabled by durable default");
	expect(live.messageRef).toBeDefined();
}, 15_000);

test("an explicit streaming environment disable takes precedence over the durable Telegram default", async () => {
	setEnv({
		GJC_NOTIFICATIONS: "1",
		GJC_NOTIFICATIONS_STREAM: "off",
		GJC_NOTIFICATIONS_STREAM_INTERVAL_MS: "100000",
	});
	const { handlers, ctx, frames } = await bootSession({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
	});

	await handlers.get("message_update")!(assistant("disabled by environment"), ctx);
	await sleep(200);
	expect(frames.filter(frame => frame.type === "turn_stream" && frame.phase === "live")).toHaveLength(0);

	await handlers.get("turn_end")!(
		{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "env-disabled final" } },
		ctx,
	);
	await waitFor(
		() => frames.some(frame => frame.type === "turn_stream" && frame.phase === "finalized"),
		3000,
		"finalized",
	);
	const final = frames.find(frame => frame.type === "turn_stream" && frame.phase === "finalized")!;
	expect(final.messageRef).toBeUndefined();
}, 15_000);

test("a mid-turn disable retains the streamed message for its authoritative final, then cleanly restarts next turn", async () => {
	setEnv({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_STREAM_INTERVAL_MS: "100000" });
	const { handlers, ctx, frames, settings, controller } = await bootSession({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
	});
	const liveFrames = () => frames.filter(frame => frame.type === "turn_stream" && frame.phase === "live");

	await handlers.get("message_update")!(assistant("before durable disable"), ctx);
	await waitFor(() => liveFrames().length === 1, 3000, "initial live frame");
	const firstLive = liveFrames()[0]!;

	settings.set("notifications.telegram.streaming.enabled", false);
	await controller.reconcileCurrentSession(ctx);
	await handlers.get("message_update")!(assistant("must not add another live frame"), ctx);
	await sleep(200);
	expect(liveFrames()).toHaveLength(1);

	await handlers.get("turn_end")!(
		{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "authoritative final" } },
		ctx,
	);
	await waitFor(
		() => frames.some(frame => frame.type === "turn_stream" && frame.phase === "finalized"),
		3000,
		"finalized",
	);
	const final = frames.find(frame => frame.type === "turn_stream" && frame.phase === "finalized")!;
	expect(final.text).toContain("authoritative final");
	expect(final.messageRef).toBe(firstLive.messageRef);

	settings.set("notifications.telegram.streaming.enabled", true);
	await controller.reconcileCurrentSession(ctx);
	await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
	await handlers.get("message_update")!(assistant("new turn after re-enable"), ctx);
	await waitFor(() => liveFrames().length === 2, 3000, "re-enabled live frame");
	expect(liveFrames()[1]!.messageRef).not.toBe(firstLive.messageRef);
}, 15_000);

test("an atomic redact-and-disable refresh suppresses all later turn content", async () => {
	setEnv({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_STREAM_INTERVAL_MS: "100000" });
	const { handlers, ctx, frames, settings, controller } = await bootSession({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
	});

	await handlers.get("message_update")!(assistant("visible before privacy refresh"), ctx);
	await waitFor(
		() => frames.some(frame => frame.type === "turn_stream" && frame.phase === "live"),
		3000,
		"initial live frame",
	);
	const frameCountAtRefresh = frames.length;
	await settings.commitAtomicBatch([
		{ path: "notifications.redact", op: "set", value: true },
		{ path: "notifications.telegram.streaming.enabled", op: "set", value: false },
	]);
	await controller.reconcileCurrentSession(ctx);

	await handlers.get("message_update")!(assistant("secret after privacy refresh"), ctx);
	await handlers.get("turn_end")!(
		{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "secret final after privacy refresh" } },
		ctx,
	);
	await sleep(200);

	const laterTurnFrames = frames.slice(frameCountAtRefresh).filter(frame => frame.type === "turn_stream");
	expect(laterTurnFrames).toEqual([]);
}, 15_000);

// ---------------------------------------------------------------------------
// 3) Telegram delivery: streamed frames edit ONE message in place; a keyless
//    finalized frame still posts a fresh message (no regression when off).
// ---------------------------------------------------------------------------

function daemonSettings(agentDir: string) {
	return isolatedNotificationSettings(agentDir, {
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
		"notifications.daemon.idleTimeoutMs": 20,
	});
}

class FakeBotApi {
	calls: Array<{ method: string; body: any }> = [];
	async call(method: string, body: unknown): Promise<unknown> {
		this.calls.push({ method, body });
		if (method === "getChat")
			return { ok: true, result: { id: (body as { chat_id?: unknown }).chat_id, type: "private" } };
		if (method === "createForumTopic") return { ok: true, result: { message_thread_id: this.calls.length } };
		if (method === "sendMessage") return { ok: true, result: { message_id: this.calls.length } };
		return { ok: true, result: true };
	}
}

async function bootDaemon() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-stream-daemon-"));
	const agentDir = path.join(root, ".gjc", "agent");
	cleanupRoots.push(await createNotificationFixtureRoot(root, agentDir));
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: daemonSettings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot as never,
	});
	const session = { sessionId: "S", token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
	await daemon.handleSessionMessage(session as never, {
		type: "identity_header",
		sessionId: "S",
		repo: "gajae-code",
		branch: "dev",
	});
	return { daemon, bot, session };
}

test("streamed turn frames edit ONE Telegram message in place (send once, then edit)", async () => {
	const { daemon, bot, session } = await bootDaemon();

	await daemon.handleSessionMessage(session as never, {
		type: "turn_stream",
		sessionId: "S",
		phase: "live",
		text: "Hello",
		messageRef: "1",
	});
	await daemon.handleSessionMessage(session as never, {
		type: "turn_stream",
		sessionId: "S",
		phase: "live",
		text: "Hello world",
		messageRef: "1",
	});
	await daemon.handleSessionMessage(session as never, {
		type: "turn_stream",
		sessionId: "S",
		phase: "finalized",
		text: "Hello world!",
		messageRef: "1",
	});

	// The identity header is also a sendMessage, so scope to the turn's text.
	const turnSends = bot.calls.filter(c => c.method === "sendMessage" && String(c.body.text).includes("Hello"));
	const edits = bot.calls.filter(c => c.method === "editMessageText");
	expect(turnSends.length).toBe(1); // exactly one message created for the turn
	expect(edits.length).toBe(2); // subsequent live + finalized edit it in place
	// Every edit targets the same single message.
	const editIds = new Set(edits.map(e => e.body.message_id));
	expect(editIds.size).toBe(1);
	expect(typeof edits[0]!.body.message_id).toBe("number");
	expect(edits.at(-1)!.body.text).toContain("Hello world!");
	// Ordering: the turn's send precedes every edit.
	const turnSendIdx = bot.calls.findIndex(c => c.method === "sendMessage" && String(c.body.text).includes("Hello"));
	const firstEditIdx = bot.calls.findIndex(c => c.method === "editMessageText");
	expect(turnSendIdx).toBeLessThan(firstEditIdx);
}, 60_000);

test("a finalized turn frame without a messageRef posts a fresh message (no in-place edit)", async () => {
	const { daemon, bot, session } = await bootDaemon();
	await daemon.handleSessionMessage(session as never, {
		type: "turn_stream",
		sessionId: "S",
		phase: "finalized",
		text: "All done",
	});
	expect(bot.calls.filter(c => c.method === "editMessageText").length).toBe(0);
	expect(bot.calls.some(c => c.method === "sendMessage" && String(c.body.text).includes("All done"))).toBe(true);
}, 60_000);
// ---------------------------------------------------------------------------
// 4) Finalized turn-text cap: default lets full turns reach split-capable
//    clients (Telegram daemon / Slack bridge) instead of being truncated;
//    GJC_NOTIFICATIONS_TURN_MAX can lower the cap for summary-style mirrors.
// ---------------------------------------------------------------------------

const longAssistantTurn = (chars: number) => ({
	type: "turn_end",
	turnIndex: 0,
	message: { role: "assistant", content: "가".repeat(chars) },
});

async function finalizedTextFor(
	over: Partial<Record<(typeof envKeys)[number], string>>,
	chars = 5000,
): Promise<string> {
	setEnv(over);
	const { handlers, ctx, frames } = await bootSession();
	await handlers.get("turn_end")!(longAssistantTurn(chars), ctx);
	await waitFor(() => frames.some(f => f.type === "turn_stream" && f.phase === "finalized"), 3000, "finalized");
	return frames.find(f => f.type === "turn_stream" && f.phase === "finalized")!.text ?? "";
}

test("finalized turn text defaults to full-turn delivery for split-capable clients", async () => {
	const text = await finalizedTextFor({ GJC_NOTIFICATIONS: "1" });
	expect(text.length).toBe(5000); // full turn, untruncated
	expect(text.endsWith("…")).toBe(false);
}, 60_000);

test("GJC_NOTIFICATIONS_TURN_MAX can lower the finalized cap for summary mirrors", async () => {
	const text = await finalizedTextFor({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_TURN_MAX: "3500" });
	expect(text.length).toBeLessThanOrEqual(3500);
	expect(text.endsWith("…")).toBe(true); // truncated with an ellipsis
}, 60_000);

test("GJC_NOTIFICATIONS_TURN_MAX is clamped to a finite ceiling (never unbounded)", async () => {
	const text = await finalizedTextFor({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_TURN_MAX: "10000000" }, 45000);
	expect(text.length).toBe(40000); // clamped to TURN_TEXT_MAX_CEILING, not the requested 10M
	expect(text.endsWith("…")).toBe(true); // still truncated at the ceiling
}, 60_000);

test("non-finite GJC_NOTIFICATIONS_TURN_MAX falls back to the full-turn ceiling", async () => {
	const text = await finalizedTextFor({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_TURN_MAX: "Infinity" });
	expect(text.length).toBe(5000); // invalid env does not force summary truncation
	expect(text.endsWith("…")).toBe(false);
}, 60_000);

test("live frames are NOT raised by the turn cap (stay one editable preview)", async () => {
	setEnv({
		GJC_NOTIFICATIONS: "1",
		GJC_NOTIFICATIONS_STREAM: "1",
		GJC_NOTIFICATIONS_STREAM_INTERVAL_MS: "100000",
		GJC_NOTIFICATIONS_TURN_MAX: "40000",
	});
	const { handlers, ctx, frames } = await bootSession();
	await handlers.get("message_update")!(assistant("가".repeat(5000)), ctx);
	await waitFor(() => frames.some(f => f.type === "turn_stream" && f.phase === "live"), 3000, "live frame");
	const live = frames.find(f => f.type === "turn_stream" && f.phase === "live")!;
	expect(live.text!.length).toBeLessThanOrEqual(3500); // live preview stays capped regardless of TURN_MAX
}, 60_000);

// Pro round-6 regression: a live (editable) frame whose HTML splits must NOT fan
// out into stale non-coalesced continuation messages. The daemon edits the one
// streamed message with a single edit-safe preview chunk; the full authoritative
// text arrives with the finalized frame.
test("a split live preview edits one message and never fans out continuation sends", async () => {
	const { daemon, bot, session } = await bootDaemon();
	// First live frame creates the streamed message.
	await daemon.handleSessionMessage(session as never, {
		type: "turn_stream",
		sessionId: "S",
		phase: "live",
		text: "seed",
		messageRef: "1",
	});
	bot.calls.length = 0;
	// A long live frame whose rendered HTML spans multiple Telegram chunks.
	await daemon.handleSessionMessage(session as never, {
		type: "turn_stream",
		sessionId: "S",
		phase: "live",
		text: "가".repeat(9000),
		messageRef: "1",
	});
	// The preview edits the ONE message; a live frame never requeues continuations.
	expect(bot.calls.filter(c => c.method === "editMessageText").length).toBeGreaterThanOrEqual(1);
	expect(bot.calls.filter(c => c.method === "sendMessage").length).toBe(0);
	// A follow-up flush drains any queued items: still no continuation sendMessage.
	await daemon.handleSessionMessage(session as never, {
		type: "turn_stream",
		sessionId: "S",
		phase: "live",
		text: `${"가".repeat(9000)} more`,
		messageRef: "1",
	});
	expect(bot.calls.filter(c => c.method === "sendMessage").length).toBe(0);
}, 60_000);
