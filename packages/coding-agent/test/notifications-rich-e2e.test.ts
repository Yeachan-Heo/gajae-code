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
import { markdownToTelegramHtml, splitTelegramHtml, TELEGRAM_PARSE_MODE } from "../src/sdk/bus/html-format";
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
	readonly calls: Array<{ method: string; body: any; options?: { noRetry?: boolean; signal?: AbortSignal } }> = [];
	richOutcome: "ok" | "ok_false" | "throw" | "abort" | "timeout" | "malformed" | "pending_until_abort" = "ok";
	htmlOutcomes: Array<"ok" | "ok_false" | "throw" | "malformed"> = [];
	readonly richStarted = Promise.withResolvers<void>();
	constructor(private readonly threadId: number) {}
	async call(method: string, body: unknown, options?: { noRetry?: boolean; signal?: AbortSignal }): Promise<unknown> {
		this.calls.push({ method, body, options });
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
				if (this.richOutcome === "pending_until_abort") {
					this.richStarted.resolve();
					const pending = Promise.withResolvers<unknown>();
					options?.signal?.addEventListener(
						"abort",
						() => pending.reject(new DOMException("rich request aborted", "AbortError")),
						{ once: true },
					);
					return pending.promise;
				}
				if (this.richOutcome === "throw") throw new Error("rich transport unavailable");
				if (this.richOutcome === "abort") throw new DOMException("rich request aborted", "AbortError");
				if (this.richOutcome === "timeout") throw new DOMException("rich request timed out", "TimeoutError");
				if (this.richOutcome === "malformed") return { unexpected: true };
				if (this.richOutcome === "ok_false") return { ok: false, description: "rich unavailable" };
				return { ok: true, result: { message_id: 4242 } };
			case "sendMessage": {
				const outcome = this.htmlOutcomes.shift() ?? "ok";
				if (outcome === "throw") throw new Error("HTML transport unavailable");
				if (outcome === "malformed") return { unexpected: true };
				if (outcome === "ok_false") return { ok: false, description: "HTML rejected" };
				return { ok: true, result: { message_id: this.calls.length } };
			}
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
const LONG_HTML_MARKDOWN = ["a".repeat(3800), "b".repeat(3800), "c".repeat(3800)].join("\n\n");

interface Harness {
	sessionId: string;
	srv: InstanceType<typeof NotificationServer>;
	bot: CapturingBotApi;
	daemon: TelegramNotificationDaemon;
	ephemeralTurns: Array<{
		sessionId: string;
		requestId: string;
		threadId: string;
		updateId: number;
		messageId: number;
	}>;
	inboundKinds: string[];
	stop: () => Promise<void>;
}

/**
 * Boot the real napi server, register its endpoint as a notification root, then
 * connect the real daemon to it over a REAL WebSocket via `scanRoots()`.
 */
async function connectRealPipeline(rich?: { enabled: boolean }, respondToEphemeralTurns = true): Promise<Harness> {
	const agentDir = tempAgentDir();
	try {
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
			const frame = JSON.parse(inbound.json);
			if (frame.type === "event_replay") {
				srv.sendTo(
					inbound.connectionId,
					JSON.stringify({
						type: "event_replay_result",
						id: frame.id,
						ok: true,
						generation: 4,
						lastSeq: 1,
						events: [
							{
								type: "event",
								name: "identity_header",
								payload: {
									type: "identity_header",
									sessionId,
									repo: "rich-e2e",
									branch: "test",
									machine: "test",
								},
							},
						],
					}),
				);
				return;
			}
		});
		const ephemeralTurns: Array<{
			sessionId: string;
			requestId: string;
			threadId: string;
			updateId: number;
			messageId: number;
		}> = [];
		const inboundKinds: string[] = [];
		srv.onInbound((error, inbound) => {
			if (error || !inbound) return;
			inboundKinds.push(inbound.kind);
			if (inbound.kind !== "ephemeral_turn") return;
			if (
				inbound.requestId === undefined ||
				inbound.threadId === undefined ||
				inbound.updateId === undefined ||
				inbound.messageId === undefined
			)
				return;
			ephemeralTurns.push({
				sessionId: inbound.sessionId,
				requestId: inbound.requestId,
				threadId: inbound.threadId,
				updateId: inbound.updateId,
				messageId: inbound.messageId,
			});
			if (!respondToEphemeralTurns) return;
			srv.pushFrame(
				JSON.stringify({
					type: "ephemeral_turn_result",
					sessionId: inbound.sessionId,
					requestId: inbound.requestId,
					threadId: inbound.threadId,
					updateId: inbound.updateId,
					messageId: inbound.messageId,
					status: "ok",
					text: RICH_TEXT,
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
			try {
				daemon.requestStop();
				srv.stop();
				// Let the server-initiated close reach the daemon's socket so dropSession
				// clears the per-session liveness interval before the test ends.
				await sleep(80);
			} finally {
				await fs.promises.rm(agentDir, { recursive: true, force: true });
			}
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
			await waitFor(() => daemon.sessions.get(sessionId)?.hostGeneration === 4, 8000, "generation-4 replay");
			srv.pushFrame(JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: ["ephemeral_turn_v1"] }));
			await waitFor(() => daemon.sessions.get(sessionId)?.ephemeralCapable === true, 8000, "ephemeral capability");
		} catch (err) {
			await stop();
			throw err;
		}

		return { sessionId, srv, bot, daemon, ephemeralTurns, inboundKinds, stop };
	} catch (err) {
		await fs.promises.rm(agentDir, { recursive: true, force: true });
		throw err;
	}
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
		expect(rich.body.rich_message).toEqual({ markdown: RICH_TEXT, skip_entity_detection: true });
		expect(rich.body.message_thread_id).toBe(THREAD_ID);
		expect(rich.body.chat_id).toBe("42");

		// The final answer did NOT also leak out on the HTML sendMessage path.
		expect(count(h.bot, "sendMessage")).toBe(htmlBefore);
	} finally {
		await h.stop();
	}
}, 30000);
test("rich e2e: /btw ignores mismatched and duplicate results before delivering the matching real-WebSocket result once", async () => {
	const h = await connectRealPipeline(undefined, false);
	try {
		await driveIdentity(h, "Rich BTW E2E");
		const htmlBefore = count(h.bot, "sendMessage");
		await h.daemon.handleTelegramUpdate({
			update_id: 77,
			message: { chat: { id: 42 }, message_thread_id: THREAD_ID, text: "/btw table?", message_id: 701 },
		});
		await waitFor(() => h.ephemeralTurns.length === 1, 8000, "/btw ephemeral turn received by NotificationServer");
		expect(h.inboundKinds).toEqual(["ephemeral_turn"]);
		const inbound = h.ephemeralTurns[0]!;
		const result = {
			type: "ephemeral_turn_result",
			sessionId: inbound.sessionId,
			requestId: inbound.requestId,
			threadId: inbound.threadId,
			updateId: inbound.updateId,
			messageId: inbound.messageId,
			status: "ok",
			text: RICH_TEXT,
		};
		for (const mismatch of [
			{ ...result, requestId: "btw:00000000-0000-4000-8000-000000000000" },
			{ ...result, sessionId: `${inbound.sessionId}-other` },
			{ ...result, threadId: String(THREAD_ID + 1) }, // Wrong Telegram topic/thread.
			{ ...result, updateId: inbound.updateId + 1 },
			{ ...result, messageId: inbound.messageId + 1 },
		]) {
			h.srv.pushFrame(JSON.stringify(mismatch));
		}
		await sleep(100);
		expect(count(h.bot, "sendRichMessage")).toBe(0);
		expect(count(h.bot, "sendMessage")).toBe(htmlBefore);

		h.srv.pushFrame(JSON.stringify(result));
		await waitFor(() => count(h.bot, "sendRichMessage") === 1, 8000, "matching /btw rich table delivery");
		h.srv.pushFrame(JSON.stringify(result));
		await sleep(100);
		const rich = find(h.bot, "sendRichMessage")!;
		expect(rich.body).toEqual({
			chat_id: "42",
			message_thread_id: THREAD_ID,
			reply_parameters: { message_id: 701 },
			rich_message: { markdown: RICH_TEXT, skip_entity_detection: true },
		});
		expect(rich.body.rich_message.blocks).toBeUndefined();
		expect(rich.body.rich_message.media).toBeUndefined();
		expect(rich.body.media).toBeUndefined();
		expect(rich.options).toEqual(expect.objectContaining({ noRetry: true, signal: expect.any(AbortSignal) }));
		expect(count(h.bot, "sendRichMessage")).toBe(1);
		expect(count(h.bot, "sendMessage")).toBe(htmlBefore);
	} finally {
		await h.stop();
	}
}, 30000);

test("rich e2e: /btw Bot API outcomes fall back only after definite ok:false", async () => {
	for (const outcome of ["ok_false", "throw", "abort", "timeout", "malformed"] as const) {
		const h = await connectRealPipeline(undefined, false);
		try {
			await driveIdentity(h, `Rich BTW ${outcome}`);
			h.bot.calls.length = 0;
			h.bot.richOutcome = outcome;
			await h.daemon.handleTelegramUpdate({
				update_id: 78,
				message: { chat: { id: 42 }, message_thread_id: THREAD_ID, text: "/btw outcome?", message_id: 702 },
			});
			await waitFor(() => h.ephemeralTurns.length === 1, 8000, `${outcome} ephemeral turn`);
			const inbound = h.ephemeralTurns[0]!;
			h.srv.pushFrame(
				JSON.stringify({
					type: "ephemeral_turn_result",
					sessionId: inbound.sessionId,
					requestId: inbound.requestId,
					threadId: inbound.threadId,
					updateId: inbound.updateId,
					messageId: inbound.messageId,
					status: "ok",
					text: RICH_TEXT,
				}),
			);
			await waitFor(() => count(h.bot, "sendRichMessage") === 1, 8000, `${outcome} rich call`);
			await sleep(100);
			const rich = find(h.bot, "sendRichMessage")!;
			expect(rich.body).toEqual({
				chat_id: "42",
				message_thread_id: THREAD_ID,
				reply_parameters: { message_id: 702 },
				rich_message: { markdown: RICH_TEXT, skip_entity_detection: true },
			});
			expect(rich.options).toEqual(expect.objectContaining({ noRetry: true, signal: expect.any(AbortSignal) }));

			const html = h.bot.calls.filter(call => call.method === "sendMessage");
			if (outcome === "ok_false") {
				expect(html).toHaveLength(1);
				expect(html[0]!.body).toEqual({
					chat_id: "42",
					message_thread_id: THREAD_ID,
					reply_parameters: { message_id: 702 },
					text: markdownToTelegramHtml(RICH_TEXT),
					parse_mode: TELEGRAM_PARSE_MODE,
				});
				expect(html[0]!.options).toEqual(
					expect.objectContaining({ noRetry: true, signal: expect.any(AbortSignal) }),
				);
			} else {
				expect(html).toHaveLength(0);
			}
			expect(
				h.bot.calls.filter(call => call.method === "sendRichMessage" || call.method === "sendMessage"),
			).toHaveLength(outcome === "ok_false" ? 2 : 1);
		} finally {
			await h.stop();
		}
	}
}, 60000);
test("rich e2e: /btw HTML chunks stop after rejection or ambiguity and reply only on the first call", async () => {
	const chunks = splitTelegramHtml(markdownToTelegramHtml(LONG_HTML_MARKDOWN));
	expect(chunks.length).toBeGreaterThan(2);
	for (const scenario of [
		{
			label: "all accepted",
			outcomes: [] as Array<"ok" | "ok_false" | "throw" | "malformed">,
			expectedCalls: chunks.length,
		},
		{ label: "first rejected", outcomes: ["ok_false"] as const, expectedCalls: 1 },
		{ label: "first throw", outcomes: ["throw"] as const, expectedCalls: 1 },
		{ label: "first malformed", outcomes: ["malformed"] as const, expectedCalls: 1 },
		{ label: "second rejected", outcomes: ["ok", "ok_false", "ok"] as const, expectedCalls: 2 },
	]) {
		const h = await connectRealPipeline(undefined, false);
		try {
			await driveIdentity(h, `HTML ${scenario.label}`);
			h.bot.calls.length = 0;
			h.bot.htmlOutcomes = [...scenario.outcomes];
			await h.daemon.handleTelegramUpdate({
				update_id: 79,
				message: { chat: { id: 42 }, message_thread_id: THREAD_ID, text: "/btw long?", message_id: 703 },
			});
			await waitFor(() => h.ephemeralTurns.length === 1, 8000, `${scenario.label} ephemeral turn`);
			const inbound = h.ephemeralTurns[0]!;
			h.srv.pushFrame(
				JSON.stringify({
					type: "ephemeral_turn_result",
					sessionId: inbound.sessionId,
					requestId: inbound.requestId,
					threadId: inbound.threadId,
					updateId: inbound.updateId,
					messageId: inbound.messageId,
					status: "ok",
					text: LONG_HTML_MARKDOWN,
				}),
			);
			await waitFor(
				() => h.bot.calls.filter(call => call.method === "sendMessage").length >= scenario.expectedCalls,
				8000,
				`${scenario.label} HTML calls`,
			);
			await sleep(100);
			const html = h.bot.calls.filter(call => call.method === "sendMessage");
			expect(count(h.bot, "sendRichMessage"), scenario.label).toBe(0);
			expect(html, scenario.label).toHaveLength(scenario.expectedCalls);
			expect(
				html.map(call => call.body.text),
				scenario.label,
			).toEqual(chunks.slice(0, scenario.expectedCalls));
			expect(html[0]!.body.reply_parameters, scenario.label).toEqual({ message_id: 703 });
			expect(
				html.slice(1).every(call => call.body.reply_parameters === undefined),
				scenario.label,
			).toBe(true);
			expect(
				html.every(call => call.options?.noRetry === true && call.options.signal instanceof AbortSignal),
				scenario.label,
			).toBe(true);
		} finally {
			await h.stop();
		}
	}
}, 60000);

test("rich e2e: daemon shutdown aborts an in-flight /btw rich call without fallback", async () => {
	const h = await connectRealPipeline(undefined, false);
	try {
		await driveIdentity(h, "Rich shutdown abort");
		h.bot.calls.length = 0;
		h.bot.richOutcome = "pending_until_abort";
		await h.daemon.handleTelegramUpdate({
			update_id: 80,
			message: { chat: { id: 42 }, message_thread_id: THREAD_ID, text: "/btw stop?", message_id: 704 },
		});
		await waitFor(() => h.ephemeralTurns.length === 1, 8000, "shutdown abort ephemeral turn");
		const inbound = h.ephemeralTurns[0]!;
		h.srv.pushFrame(
			JSON.stringify({
				type: "ephemeral_turn_result",
				sessionId: inbound.sessionId,
				requestId: inbound.requestId,
				threadId: inbound.threadId,
				updateId: inbound.updateId,
				messageId: inbound.messageId,
				status: "ok",
				text: RICH_TEXT,
			}),
		);
		await waitFor(() => count(h.bot, "sendRichMessage") === 1, 8000, "pending rich call");
		const rich = find(h.bot, "sendRichMessage")!;
		expect(rich.options).toEqual(expect.objectContaining({ noRetry: true, signal: expect.any(AbortSignal) }));
		expect(rich.options!.signal!.aborted).toBe(false);
		h.daemon.requestStop("signal");
		await waitFor(() => rich.options!.signal!.aborted, 8000, "delivery abort signal");
		await sleep(100);
		expect(count(h.bot, "sendRichMessage")).toBe(1);
		expect(count(h.bot, "sendMessage")).toBe(0);
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
