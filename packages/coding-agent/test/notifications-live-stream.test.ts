import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNotificationsExtension } from "../src/sdk/bus/index";
import { TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";
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
// 2) Core emit: message_update -> throttled live turn_stream frames, opt-in and
//    redaction-aware, with the finalized turn carrying the same messageRef.
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

async function bootSession(): Promise<{ handlers: Map<string, Handler>; ctx: unknown; frames: Frame[] }> {
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
	createNotificationsExtension(api, { settings: isolatedNotificationSettings(agentDir) });
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
	} as never;

	registerNotificationRuntime(cleanup, {
		key: `notification-session:${sid}`,
		shutdown: async () => {
			await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
		},
	});
	await handlers.get("session_start")!({ type: "session_start" }, ctx);
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
	return { handlers, ctx, frames };
}

const assistant = (content: string) => ({ type: "message_update", message: { role: "assistant", content } });

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
});

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
});

test("no live frames are emitted when streaming is disabled, and finalized carries no messageRef", async () => {
	setEnv({ GJC_NOTIFICATIONS: "1" }); // GJC_NOTIFICATIONS_STREAM unset -> off
	const { handlers, ctx, frames } = await bootSession();

	await handlers.get("message_update")!(assistant("should not stream"), ctx);
	await sleep(200);
	expect(frames.filter(f => f.type === "turn_stream" && f.phase === "live").length).toBe(0);

	await handlers.get("turn_end")!(
		{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "final only" } },
		ctx,
	);
	await waitFor(() => frames.some(f => f.type === "turn_stream" && f.phase === "finalized"), 3000, "finalized");
	const final = frames.find(f => f.type === "turn_stream" && f.phase === "finalized")!;
	expect(final.messageRef).toBeUndefined();
});

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
});

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
});
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
});

test("GJC_NOTIFICATIONS_TURN_MAX can lower the finalized cap for summary mirrors", async () => {
	const text = await finalizedTextFor({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_TURN_MAX: "3500" });
	expect(text.length).toBeLessThanOrEqual(3500);
	expect(text.endsWith("…")).toBe(true); // truncated with an ellipsis
});

test("GJC_NOTIFICATIONS_TURN_MAX is clamped to a finite ceiling (never unbounded)", async () => {
	const text = await finalizedTextFor({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_TURN_MAX: "10000000" }, 45000);
	expect(text.length).toBe(40000); // clamped to TURN_TEXT_MAX_CEILING, not the requested 10M
	expect(text.endsWith("…")).toBe(true); // still truncated at the ceiling
});

test("non-finite GJC_NOTIFICATIONS_TURN_MAX falls back to the full-turn ceiling", async () => {
	const text = await finalizedTextFor({ GJC_NOTIFICATIONS: "1", GJC_NOTIFICATIONS_TURN_MAX: "Infinity" });
	expect(text.length).toBe(5000); // invalid env does not force summary truncation
	expect(text.endsWith("…")).toBe(false);
});

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
});

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
});
