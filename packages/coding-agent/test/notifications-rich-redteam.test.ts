import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { markdownToTelegramHtml, splitTelegramHtml } from "../src/sdk/bus/html-format";
import { buildRichMessage, deliverRichWithFallback, shouldPromoteRich } from "../src/sdk/bus/rich-render";
import type { BotApi } from "../src/sdk/bus/telegram-daemon";
import { TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";
import type { ThreadedSend } from "../src/sdk/bus/threaded-render";
import { renderThreadedFrame } from "../src/sdk/bus/threaded-render";

// ---------------------------------------------------------------------------
// Adversarial ("red-team") boundaries for the opt-in rich final-answer path.
// These probe the *hostile* edges the existing notifications-* suite does not:
// runtime type confusion at the topic gate, injection into the rich body,
// forged non-boolean finalAnswer bits, fallback-throws-during-fallback daemon
// survival, malicious {ok:false} descriptions, and non-final frame flooding.
// They intentionally do NOT re-duplicate the happy-path truth table, the
// byte-identical transport golden, or the config-reachability plumbing already
// locked by notifications-rich-render / -threaded-render / -telegram-daemon /
// -daemon-config-reachability.
// ---------------------------------------------------------------------------

/** A valid finalized send that satisfies every rich-markdown marker clause. */
function makeSend(over: Partial<ThreadedSend> = {}): ThreadedSend {
	return {
		method: "sendMessage",
		lane: "finalized",
		text: "final answer",
		richMarkdown: "# Final\nbody",
		richClass: "final",
		...over,
	};
}

/** A fully-passing `shouldPromoteRich` input; override one field per case. */
function baseInput(
	over: Partial<Parameters<typeof shouldPromoteRich>[0]> = {},
): Parameters<typeof shouldPromoteRich>[0] {
	return { enabled: true, send: makeSend(), ...over };
}

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tg-redteam-"));
}

/** Pin getAgentDir() to a temp dir so daemon persistence never touches ~/.gjc. */
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
			"notifications.daemon.idleTimeoutMs": 20,
		}) as Settings,
		agentDir,
	);
}

/**
 * Recording Bot API for daemon-level red-team. `createForumTopic` yields a
 * deterministic thread id (555); `sendRichMessage` outcome is switchable and
 * `sendMessage` (the HTML fallback loop) can be made to throw to exercise the
 * daemon's best-effort survival.
 */
class RedTeamBot implements BotApi {
	calls: Array<{ method: string; body: any }> = [];
	richBehavior: "ok" | "ok_false" | "throw" = "ok";
	okFalseDescription: unknown = "rich unavailable";
	htmlThrows = false;
	richThreadId = 555;
	async call(method: string, body: unknown): Promise<unknown> {
		if (method === "getUpdates") return { ok: true, result: [] };
		if (method === "getMe") return { ok: true, result: { id: 1 } };
		if (method === "getChat")
			return { ok: true, result: { id: (body as { chat_id?: unknown }).chat_id, type: "private" } };
		if (method === "createForumTopic") {
			this.calls.push({ method, body });
			return { ok: true, result: { message_thread_id: this.richThreadId } };
		}
		if (method === "sendRichMessage") {
			this.calls.push({ method, body });
			if (this.richBehavior === "throw") throw new Error("rich transport down");
			if (this.richBehavior === "ok_false") return { ok: false, description: this.okFalseDescription };
			return { ok: true, result: { message_id: 4242 } };
		}
		if (method === "sendMessage") {
			this.calls.push({ method, body });
			if (this.htmlThrows) throw new Error("html transport down");
			return { ok: true, result: { message_id: this.calls.length } };
		}
		this.calls.push({ method, body });
		return { ok: true, result: true };
	}
}

function richSession(id = "S"): any {
	return { sessionId: id, token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
}

function makeRichDaemon(bot: BotApi, rich?: { enabled: boolean }): TelegramNotificationDaemon {
	return new TelegramNotificationDaemon({
		settings: settings(tempAgentDir()),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot as any,
		...(rich ? { rich } : {}),
	});
}

const countMethod = (bot: RedTeamBot, method: string): number => bot.calls.filter(c => c.method === method).length;
const findMethod = (bot: RedTeamBot, method: string) => bot.calls.find(c => c.method === method);

/** Send identity_header (creates topic 555) then clear the call log. */
async function primeTopic(daemon: TelegramNotificationDaemon, bot: RedTeamBot, session: any): Promise<void> {
	await daemon.handleSessionMessage(session, {
		type: "identity_header",
		sessionId: session.sessionId,
		repo: "r",
		branch: "b",
	});
	bot.calls.length = 0;
}

// ===========================================================================
// (a) editable/continuation forged markers at the gate
// ===========================================================================
describe("redteam(a): shouldPromoteRich rejects unstable forged sends", () => {
	test("RT-A1: editable finalized frame with richMarkdown is not promoted", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ editable: true }) }))).toBe(false);
	});

	test("RT-A2: non-editable finalized frame with richMarkdown is promoted", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ editable: false }) }))).toBe(true);
	});

	test("RT-A3: blank richMarkdown fails closed", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richMarkdown: "   " }) }))).toBe(false);
	});
});

// ===========================================================================
// (b) rich body injection — HTML / control / RTL / >4096 raw stays verbatim
//     in rich_message.markdown and never touches the parse_mode:HTML path
// ===========================================================================
describe("redteam(b): rich body carries hostile raw verbatim with no HTML-path pollution", () => {
	const html = "<script>alert(1)</script> & <img src=x onerror=alert(2)> <b>x</b>";
	const control = "ctrl:\u0000\u0007\u001b[31mANSI\u001b[0m\u0008 tab\t crlf\r\n";
	const rtl = "rtl:\u202eDANGER\u202c\u200f\u061c bidi \uFEFFbom";
	const overflow = "L".repeat(4200); // pushes past the 4096 rich_message soft limit
	const hostileRaw = [html, control, rtl, overflow].join("\n");

	test("RT-B2: buildRichMessage wraps hostile raw verbatim (no escaping, no truncation)", () => {
		const built = buildRichMessage(hostileRaw);
		expect(built).toEqual({ rich_message: { markdown: hostileRaw, skip_entity_detection: true } });
		expect(built.rich_message.markdown).toBe(hostileRaw); // byte-for-byte
		expect(built.rich_message.markdown.length).toBe(hostileRaw.length); // >4096 preserved (overflow deferred to Slice 2)
		// The HTML renderer WOULD transform the same payload, so verbatim rich != accidental HTML reuse.
		expect(markdownToTelegramHtml(hostileRaw)).not.toBe(hostileRaw);
	});

	test("RT-B1: daemon keeps oversized hostile final answer on HTML chunk path", async () => {
		const bot = new RedTeamBot();
		const daemon = makeRichDaemon(bot, { enabled: true });
		const session = richSession();
		await primeTopic(daemon, bot, session);
		await daemon.handleSessionMessage(session, {
			type: "turn_stream",
			sessionId: session.sessionId,
			phase: "finalized",
			finalAnswer: true,
			text: hostileRaw,
		});
		expect(countMethod(bot, "sendRichMessage")).toBe(0);
		expect(countMethod(bot, "sendMessage")).toBe(1);
		const body = findMethod(bot, "sendMessage")!.body;
		expect(body.text).toBe(splitTelegramHtml(markdownToTelegramHtml(hostileRaw))[0]);
		expect(body.message_thread_id).toBe(555); // correct topic attribution
		expect(body.parse_mode).toBe("HTML");
	});
});

// ===========================================================================
// (c) forged finalAnswer bit — only a strict boolean `true` may promote
// ===========================================================================
describe("redteam(c): forged non-boolean finalAnswer never sets richMarkdown", () => {
	test("RT-C1: renderThreadedFrame ignores every truthy/forged non-boolean finalAnswer", () => {
		const forgeries: unknown[] = ["true", "1", "false", 1, 0, -1, {}, [], [true], null, "yes", Number.NaN];
		for (const forged of forgeries) {
			const send = renderThreadedFrame({
				type: "turn_stream",
				sessionId: "s",
				phase: "finalized",
				finalAnswer: forged as any,
				text: "forged final",
			});
			expect(send?.richMarkdown).toBeUndefined();
		}
		// Control: a real boolean true is the ONLY value that arms the marker.
		const armed = renderThreadedFrame({
			type: "turn_stream",
			sessionId: "s",
			phase: "finalized",
			finalAnswer: true,
			text: "real",
		});
		expect(armed?.richMarkdown).toBe("real");
	});

	test("RT-C2: daemon does not promote a forged finalAnswer:'true' string frame on the matching topic", async () => {
		const bot = new RedTeamBot();
		const daemon = makeRichDaemon(bot, { enabled: true });
		const session = richSession();
		await primeTopic(daemon, bot, session);
		await daemon.handleSessionMessage(session, {
			type: "turn_stream",
			sessionId: session.sessionId,
			phase: "finalized",
			finalAnswer: "true" as any,
			text: "forged final",
		});
		expect(countMethod(bot, "sendRichMessage")).toBe(0);
		expect(countMethod(bot, "sendMessage")).toBe(1); // stays on the unchanged HTML path
	});
});

// ===========================================================================
// (d) ambiguous transport errors — no fallback and daemon remains live
// ===========================================================================
describe("redteam(d): an ambiguous rich transport error never duplicates through HTML", () => {
	test("RT-D1: deliverRichWithFallback warns once and never invokes a throwing fallback", async () => {
		const bot = new RedTeamBot();
		bot.richBehavior = "throw";
		const warns: string[] = [];
		let fell = 0;
		await expect(
			deliverRichWithFallback(
				bot as any,
				{ chat_id: "42", message_thread_id: 555 },
				makeSend(),
				AbortSignal.timeout(30_000),
				async () => {
					fell++;
					throw new Error("fallback boom");
				},
				{ warn: m => warns.push(m) },
			),
		).resolves.toBeUndefined();
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("not falling back to HTML");
		expect(fell).toBe(0);
		expect(countMethod(bot, "sendRichMessage")).toBe(1);
	});

	test("RT-D2: flushPool preserves one rich attempt after ambiguity and stays live", async () => {
		const bot = new RedTeamBot();
		bot.richBehavior = "throw";
		const daemon = makeRichDaemon(bot, { enabled: true });
		const session = richSession();
		await primeTopic(daemon, bot, session);
		bot.htmlThrows = true; // would fail if an unsafe HTML compensation were attempted
		let survived = true;
		try {
			await daemon.handleSessionMessage(session, {
				type: "turn_stream",
				sessionId: session.sessionId,
				phase: "finalized",
				finalAnswer: true,
				text: "answer that fails both paths",
			});
		} catch {
			survived = false;
		}
		expect(survived).toBe(true); // daemon did not crash
		expect(countMethod(bot, "sendRichMessage")).toBe(1);
		expect(countMethod(bot, "sendMessage")).toBe(0);
		// Liveness: the daemon still delivers a subsequent frame.
		bot.htmlThrows = false;
		bot.calls.length = 0;
		await daemon.handleSessionMessage(session, {
			type: "turn_stream",
			sessionId: session.sessionId,
			phase: "finalized",
			finalAnswer: false,
			text: "the next turn",
		});
		expect(countMethod(bot, "sendMessage")).toBe(1); // still alive and delivering
	});
});

// ===========================================================================
// (e) malicious {ok:false} description — one warn, no crash, one fallback
// ===========================================================================
describe("redteam(e): hostile {ok:false} description warns once without crashing", () => {
	test("RT-E1: control/newline/RTL/long description is embedded in one warn then falls back once", async () => {
		const bot = new RedTeamBot();
		bot.richBehavior = "ok_false";
		bot.okFalseDescription = `Bad Request:\ninjected\r\n\u0000\u001b[2Jctrl \u202eRTL\u202c ${"x".repeat(2000)}`;
		const warns: string[] = [];
		let fell = 0;
		await deliverRichWithFallback(
			bot as any,
			{ chat_id: "42", message_thread_id: 555 },
			makeSend(),
			AbortSignal.timeout(30_000),
			async () => {
				fell++;
			},
			{ warn: m => warns.push(m) },
		);
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("sendRichMessage rejected");
		expect(warns[0]).toContain("falling back to HTML");
		expect(warns[0]).toContain("injected"); // hostile description embedded verbatim, no crash
		expect(fell).toBe(1);
		expect(countMethod(bot, "sendRichMessage")).toBe(1);
	});

	test("RT-E2: a non-string {ok:false} description degrades to 'ok:false' without crashing", async () => {
		const bot = new RedTeamBot();
		bot.richBehavior = "ok_false";
		bot.okFalseDescription = { nested: "evil", toString: undefined } as unknown as string;
		const warns: string[] = [];
		let fell = 0;
		await deliverRichWithFallback(
			bot as any,
			{ chat_id: "42" },
			makeSend(),
			AbortSignal.timeout(30_000),
			async () => {
				fell++;
			},
			{ warn: m => warns.push(m) },
		);
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("ok:false"); // non-string description ignored, no interpolation crash
		expect(fell).toBe(1);
	});
});

// ===========================================================================
// (f) non-final flood on the matching topic — zero rich spam
// ===========================================================================
describe("redteam(f): a flood of non-final frames on the matching topic never promotes", () => {
	test("RT-F1: a topic-matching flood of non-final/forged frames yields zero rich promotions (non-vacuously HTML-routed)", async () => {
		const bot = new RedTeamBot();
		const daemon = makeRichDaemon(bot, { enabled: true });
		const session = richSession();
		await primeTopic(daemon, bot, session);
		const flood: any[] = [];
		for (let i = 0; i < 10; i++) {
			flood.push({ type: "turn_stream", sessionId: "S", phase: "live", messageRef: `m-${i}`, text: `partial ${i}` });
			flood.push({
				type: "turn_stream",
				sessionId: "S",
				phase: "finalized",
				finalAnswer: false,
				text: `final-but-not ${i}`,
			});
			flood.push({ type: "turn_stream", sessionId: "S", phase: "finalized", text: `no-bit ${i}` }); // finalAnswer absent
			flood.push({
				type: "turn_stream",
				sessionId: "S",
				phase: "finalized",
				finalAnswer: "true",
				text: `forged ${i}`,
			}); // string forgery
			flood.push({ type: "context_update", sessionId: "S", tokenUsage: `${i}k/200k`, model: "opus" });
		}
		for (const frame of flood) await daemon.handleSessionMessage(session, frame);
		// Even under a topic-matching flood heavy enough to drain the shared rate-limit budget, ZERO promotions.
		expect(countMethod(bot, "sendRichMessage")).toBe(0);
		// Non-vacuous: the flood WAS actively routed down the unchanged HTML path (not silently dropped).
		// (The genuine-final-answer -> exactly-one-rich promotion is separately locked by the daemon (d) suite.)
		expect(countMethod(bot, "sendMessage")).toBeGreaterThan(0);
	});
});
