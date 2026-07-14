/**
 * Full-pipeline end-to-end QA of the rich final-answer promotion path.
 *
 * Unlike notifications-e2e.test.ts (which drives the rich-free reference client)
 * and the daemon unit suites (which call `handleSessionMessage` directly), this
 * exercises the REAL stack end-to-end for the rich path:
 *
 *   napi `NotificationServer` (Rust WS core) + a real WebSocket + the real
 *   `TelegramNotificationDaemon` discovered via `scanRoots()` -> `connectSession()`
 *
 * A finalized `turn_stream` frame with `finalAnswer:true` is broadcast over the
 * live socket (via `srv.pushFrame`) and must travel the whole daemon path —
 * WS message event -> handleSessionMessage -> renderThreadedFrame -> flushPool ->
 * shouldPromoteRich -> deliverRichWithFallback -> `sendRichMessage` — with only
 * the Telegram HTTP API faked by a capturing `BotApi`. The daemon attaches over a
 * REAL WebSocket to the napi server; the test never calls `handleSessionMessage`
 * itself. `scanRoots()` is driven directly (no `run()` loop) so no owner
 * heartbeat/poller/lifecycle machinery is involved, but the socket is real.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Workspace-local built napi bindings (see notifications-e2e.test.ts for why the
// relative path is used instead of the @gajae-code/natives package resolution).
import { NotificationServer } from "../../natives/native/index.js";
import { Settings } from "../src/config/settings";
import { markdownToTelegramHtml, TELEGRAM_PARSE_MODE } from "../src/sdk/bus/html-format";
import {
	type BotApi,
	registerNotificationRoot,
	type TelegramDaemonFs,
	TelegramNotificationDaemon,
} from "../src/sdk/bus/telegram-daemon";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return;
		await sleep(25);
	}
	throw new Error(`timed out waiting for: ${label}`);
}

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-rich-e2e-"));
}

/** Isolate getAgentDir() to a temp dir so daemon persistence never touches ~/.gjc/agent. */
function setPrivateAgentDir(s: Settings, agentDir: string): Settings {
	return new Proxy(s, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function settings(agentDir: string): Settings {
	return setPrivateAgentDir(
		Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": "123456:secret-token",
			"notifications.telegram.chatId": "42",
		}) as Settings,
		agentDir,
	);
}

/**
 * Capturing Telegram Bot API: records every method+body and fakes ONLY the HTTP
 * responses (getChat -> private, createForumTopic -> a fixed thread id, and an
 * ok:true for sendRichMessage/sendMessage). Everything else the daemon does is
 * the real code path.
 */
class CapturingBotApi implements BotApi {
	readonly calls: Array<{ method: string; body: any }> = [];
	constructor(private readonly threadId: number) {}
	async call(method: string, body: unknown): Promise<unknown> {
		this.calls.push({ method, body });
		switch (method) {
			case "getChat":
				return { ok: true, result: { id: (body as { chat_id?: unknown })?.chat_id, type: "private" } };
			case "getMe":
				return { ok: true, result: { id: 1, username: "gjc_bot" } };
			case "createForumTopic":
				return { ok: true, result: { message_thread_id: this.threadId } };
			case "editForumTopic":
				return { ok: true, result: true };
			case "sendRichMessage":
				return { ok: true, result: { message_id: 4242 } };
			case "sendMessage":
				return { ok: true, result: { message_id: this.calls.length } };
			default:
				return { ok: true, result: true };
		}
	}
}

const count = (bot: CapturingBotApi, method: string): number => bot.calls.filter(c => c.method === method).length;
const find = (bot: CapturingBotApi, method: string) => bot.calls.find(c => c.method === method);

const THREAD_ID = 9001;
// Heading + GFM table: markdown that renders to distinctly non-raw Telegram HTML,
// so an HTML fallback is visibly different from the promoted raw markdown.
const RICH_TEXT = "# H\n\n| a | b |\n|---|---|\n| 1 | 2 |";

interface Harness {
	sessionId: string;
	srv: InstanceType<typeof NotificationServer>;
	bot: CapturingBotApi;
	daemon: TelegramNotificationDaemon;
	stop: () => Promise<void>;
}

/**
 * Boot the real napi server, register its endpoint as a notification root, then
 * connect the real daemon to it over a REAL WebSocket via `scanRoots()`.
 */
async function connectRealPipeline(rich?: { enabled: boolean }): Promise<Harness> {
	const agentDir = tempAgentDir();
	const s = settings(agentDir);
	const cwd = path.join(agentDir, "repo");
	const sessionId = "rich-e2e";

	// Register the session's notification root so the daemon's scanRoots discovers it.
	await registerNotificationRoot({ settings: s, cwd, sessionId });
	// The napi server writes its endpoint file under <stateRoot>/sdk/<id>.json,
	// which is exactly where registerNotificationRoot points the daemon to scan.
	const stateRoot = path.join(cwd, ".gjc", "state");
	const srv = new NotificationServer(sessionId, "tok", stateRoot, true);
	srv.onSdkFrame((error, inbound) => {
		if (error || !inbound) return;
		const frame = JSON.parse(inbound.json) as Record<string, unknown>;
		if (frame.type !== "event_replay") return;
		srv.sendTo(
			inbound.connectionId,
			JSON.stringify({
				type: "event_replay_result",
				id: frame.id,
				ok: true,
				generation: 1,
				lastSeq: 1,
				events: [
					{
						type: "event",
						name: "identity_header",
						payload: { type: "identity_header", sessionId, repo: "rich-e2e", branch: "test" },
					},
				],
			}),
		);
	});
	const ep = await srv.start();
	expect(ep.url).toContain("ws://127.0.0.1:");

	const bot = new CapturingBotApi(THREAD_ID);
	const daemon = new TelegramNotificationDaemon({
		settings: s,
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
		fs: fs.promises as unknown as TelegramDaemonFs,
		pidAlive: () => true,
		...(rich ? { rich } : {}),
	});

	const stop = async () => {
		daemon.requestStop();
		srv.stop();
		// Let the server-initiated close reach the daemon's socket so dropSession
		// clears the per-session liveness interval before the test ends.
		await sleep(80);
	};

	try {
		// REAL WS path: scanRoots -> readEndpoint -> connectSession -> new WebSocket(...)
		// to the napi server. NOT a direct handleSessionMessage call.
		await daemon.scanRoots();
		await waitFor(
			() => daemon.sessions.has(sessionId) && srv.clientCount() >= 1,
			8000,
			"daemon WS connect to napi server",
		);
	} catch (err) {
		await stop();
		throw err;
	}

	return { sessionId, srv, bot, daemon, stop };
}

/** Drive the identity_header over the wire and wait until its topic + HTML header are sent. */
async function driveIdentity(h: Harness, title: string): Promise<void> {
	h.srv.pushFrame(
		JSON.stringify({ type: "identity_header", sessionId: h.sessionId, repo: "r", branch: "b", machine: "m", title }),
	);
	// The identity path creates/stores the forum topic (createForumTopic) and then
	// sends the one-time identity header via sendMessage; waiting on the header send
	// guarantees the topic is stored before the finalized turn arrives.
	await waitFor(
		() => count(h.bot, "createForumTopic") >= 1 && count(h.bot, "sendMessage") >= 1,
		8000,
		"forum topic created + identity header delivered",
	);
}

test("rich e2e: NotificationServer + real WS + daemon scanRoots -> finalAnswer promotes to sendRichMessage", async () => {
	const h = await connectRealPipeline({ enabled: true });
	try {
		await driveIdentity(h, "Rich E2E");
		expect(count(h.bot, "createForumTopic")).toBe(1);
		const htmlBefore = count(h.bot, "sendMessage");

		// finalized turn with finalAnswer:true, broadcast over the real WS.
		h.srv.pushFrame(
			JSON.stringify({
				type: "turn_stream",
				sessionId: h.sessionId,
				phase: "finalized",
				finalAnswer: true,
				text: RICH_TEXT,
			}),
		);
		await waitFor(() => count(h.bot, "sendRichMessage") >= 1, 8000, "final answer promoted to sendRichMessage");

		// Exactly one rich send, carrying the ORIGINAL markdown into the matched topic.
		expect(count(h.bot, "sendRichMessage")).toBe(1);
		const rich = find(h.bot, "sendRichMessage")!;
		expect(rich.body.rich_message.markdown).toBe(RICH_TEXT);
		expect(rich.body.message_thread_id).toBe(THREAD_ID);
		expect(rich.body.chat_id).toBe("42");

		// The final answer did NOT also leak out on the HTML sendMessage path.
		expect(count(h.bot, "sendMessage")).toBe(htmlBefore);
	} finally {
		await h.stop();
	}
}, 30000);

test("rich e2e (off): a finalAnswer frame over the real WS stays on the HTML sendMessage path", async () => {
	const h = await connectRealPipeline({ enabled: false });
	try {
		await driveIdentity(h, "Rich E2E Off");
		const htmlBefore = count(h.bot, "sendMessage");
		const beforeTurn = h.bot.calls.length;

		h.srv.pushFrame(
			JSON.stringify({
				type: "turn_stream",
				sessionId: h.sessionId,
				phase: "finalized",
				finalAnswer: true,
				text: RICH_TEXT,
			}),
		);
		await waitFor(() => count(h.bot, "sendMessage") > htmlBefore, 8000, "final answer delivered as HTML");

		// Rich is off: the promotion never fires; the existing HTML path is unchanged.
		expect(count(h.bot, "sendRichMessage")).toBe(0);
		const finalHtml = h.bot.calls.slice(beforeTurn).find(c => c.method === "sendMessage")!;
		expect(finalHtml.body.parse_mode).toBe(TELEGRAM_PARSE_MODE);
		expect(finalHtml.body.message_thread_id).toBe(THREAD_ID);
		// The body is the rendered HTML, never the raw markdown.
		expect(finalHtml.body.text).toBe(markdownToTelegramHtml(RICH_TEXT));
		expect(finalHtml.body.text).not.toBe(RICH_TEXT);
	} finally {
		await h.stop();
	}
}, 30000);

test("rich e2e (lead-in): a finalized turn with finalAnswer:false is not promoted (the bit gates rich, not phase)", async () => {
	const h = await connectRealPipeline({ enabled: true });
	try {
		await driveIdentity(h, "Rich E2E Lead-in");
		const htmlBefore = count(h.bot, "sendMessage");
		const beforeTurn = h.bot.calls.length;

		// Rich enabled + matching topic, but finalAnswer:false: a finalized pre-ask
		// lead-in must stay on the HTML path (renderThreadedFrame sets no richMarkdown).
		h.srv.pushFrame(
			JSON.stringify({
				type: "turn_stream",
				sessionId: h.sessionId,
				phase: "finalized",
				finalAnswer: false,
				text: RICH_TEXT,
			}),
		);
		await waitFor(() => count(h.bot, "sendMessage") > htmlBefore, 8000, "lead-in delivered as HTML");
		// Give any (incorrect) rich promotion time to surface before asserting absence.
		await sleep(120);

		expect(count(h.bot, "sendRichMessage")).toBe(0);
		const leadIn = h.bot.calls.slice(beforeTurn).find(c => c.method === "sendMessage")!;
		expect(leadIn.body.parse_mode).toBe(TELEGRAM_PARSE_MODE);
		expect(leadIn.body.message_thread_id).toBe(THREAD_ID);
	} finally {
		await h.stop();
	}
}, 30000);
