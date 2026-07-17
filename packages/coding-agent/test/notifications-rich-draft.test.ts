import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { markdownToTelegramHtml } from "../src/sdk/bus/html-format";
import {
	buildRichDraft,
	DRAFT_DEBOUNCE_MS,
	DraftStreamState,
	deliverDraft,
	shouldStreamDraft,
} from "../src/sdk/bus/rich-draft";
import type { BotApi } from "../src/sdk/bus/telegram-daemon";
import { TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";
import { renderThreadedFrame, type ThreadedSend } from "../src/sdk/bus/threaded-render";

// ===========================================================================
// Pure helpers
// ===========================================================================

/** A valid LIVE send that satisfies the draft-marker clauses; override one field per case. */
function makeLiveSend(over: Partial<ThreadedSend> = {}): ThreadedSend {
	return {
		method: "sendMessage",
		lane: "live",
		text: "<b>partial</b>",
		coalesceKey: "turn:S",
		richDraftMarkdown: "partial **md**",
		...over,
	};
}

/** A fully-passing `shouldStreamDraft` input; override one field per case. */
function baseDraftInput(
	over: Partial<Parameters<typeof shouldStreamDraft>[0]> = {},
): Parameters<typeof shouldStreamDraft>[0] {
	return { enabled: true, send: makeLiveSend(), ...over };
}

/** Recording BotApi whose response (or throw) is driven by `handler`. */
function makeBot(handler: (method: string, body: unknown) => unknown): {
	bot: BotApi;
	calls: Array<{ method: string; body: unknown }>;
} {
	const calls: Array<{ method: string; body: unknown }> = [];
	const bot: BotApi = {
		async call(method: string, body: unknown): Promise<unknown> {
			calls.push({ method, body });
			return handler(method, body);
		},
	};
	return { bot, calls };
}

// ===========================================================================
// shouldStreamDraft truth table (fail-closed; LIVE-lane sibling of shouldPromoteRich)
// ===========================================================================

describe("shouldStreamDraft truth table", () => {
	test("happy path: every clause holds -> true", () => {
		expect(shouldStreamDraft(baseDraftInput())).toBe(true);
	});

	test("enabled false -> false (off-state streams nothing)", () => {
		expect(shouldStreamDraft(baseDraftInput({ enabled: false }))).toBe(false);
	});

	test("enabled undefined -> false", () => {
		expect(shouldStreamDraft(baseDraftInput({ enabled: undefined }))).toBe(false);
	});

	test("method other than sendMessage -> false", () => {
		expect(shouldStreamDraft(baseDraftInput({ send: makeLiveSend({ method: "sendPhoto" }) }))).toBe(false);
	});

	test("lane other than live -> false (finalized never streams a draft)", () => {
		expect(shouldStreamDraft(baseDraftInput({ send: makeLiveSend({ lane: "finalized" }) }))).toBe(false);
		expect(shouldStreamDraft(baseDraftInput({ send: makeLiveSend({ lane: "idle" }) }))).toBe(false);
	});

	test("richDraftMarkdown empty string -> false", () => {
		expect(shouldStreamDraft(baseDraftInput({ send: makeLiveSend({ richDraftMarkdown: "" }) }))).toBe(false);
	});

	test("richDraftMarkdown undefined -> false (e.g. a context_update live send)", () => {
		expect(shouldStreamDraft(baseDraftInput({ send: makeLiveSend({ richDraftMarkdown: undefined }) }))).toBe(false);
	});
});

// ===========================================================================
// buildRichDraft payload shape
// ===========================================================================

describe("buildRichDraft", () => {
	test("wraps raw markdown + draft id in the sendRichMessageDraft shape", () => {
		expect(buildRichDraft(3, "# Title\n**bold** & <raw>")).toEqual({
			draft_id: 3,
			rich_message: { markdown: "# Title\n**bold** & <raw>" },
		});
	});

	test("preserves an empty string and any draft id without substitution", () => {
		expect(buildRichDraft(0, "")).toEqual({ draft_id: 0, rich_message: { markdown: "" } });
	});

	test("preserves hostile/control/RTL bytes verbatim (no escaping, no truncation)", () => {
		const raw = `<b>x</b>\u0000\u001b[2K\u202e${"z".repeat(5000)}`;
		const out = buildRichDraft(7, raw);
		expect(out.rich_message.markdown).toBe(raw);
		expect(out.rich_message.markdown.length).toBe(raw.length);
	});
});

// ===========================================================================
// DraftStreamState: debounce (>=1.5s), monotonic draft id, per-session, reset
// ===========================================================================

describe("DraftStreamState debounce & monotonic draft id", () => {
	test("DRAFT_DEBOUNCE_MS floor is at least 1.5s", () => {
		expect(DRAFT_DEBOUNCE_MS).toBeGreaterThanOrEqual(1_500);
	});

	test("first claim always succeeds and returns draft id 1", () => {
		const s = new DraftStreamState();
		expect(s.tryClaim("S", 1_000)).toBe(1);
	});

	test("a claim under the debounce floor is skipped (undefined), floor is relative to last SENT", () => {
		const s = new DraftStreamState();
		expect(s.tryClaim("S", 0)).toBe(1); // sent at t=0
		expect(s.tryClaim("S", DRAFT_DEBOUNCE_MS - 1)).toBeUndefined(); // 1499ms < floor
		expect(s.tryClaim("S", DRAFT_DEBOUNCE_MS - 1)).toBeUndefined(); // still measured from t=0
		expect(s.tryClaim("S", DRAFT_DEBOUNCE_MS)).toBe(2); // exactly at the floor -> send, id increments
	});

	test("draft ids increase monotonically only across actual sends (skips do not bump)", () => {
		const s = new DraftStreamState();
		expect(s.tryClaim("S", 0)).toBe(1);
		expect(s.tryClaim("S", 500)).toBeUndefined(); // skipped
		expect(s.tryClaim("S", 2_000)).toBe(2);
		expect(s.tryClaim("S", 2_100)).toBeUndefined(); // skipped
		expect(s.tryClaim("S", 4_000)).toBe(3);
	});

	test("debounce windows are per session; draft ids are globally monotonic", () => {
		const s = new DraftStreamState();
		expect(s.tryClaim("A", 0)).toBe(1);
		expect(s.tryClaim("B", 0)).toBe(2); // debounce is per-session, but the draft id is daemon-global (no cross-session collision)
		expect(s.tryClaim("A", 100)).toBeUndefined(); // A still debounced
		expect(s.tryClaim("B", 100)).toBeUndefined();
	});

	test("reset clears a session's window so the next claim sends immediately with a fresh id", () => {
		const s = new DraftStreamState();
		expect(s.tryClaim("S", 0)).toBe(1);
		expect(s.tryClaim("S", 100)).toBeUndefined(); // debounced
		s.reset("S");
		expect(s.tryClaim("S", 100)).toBe(2); // window resets; the global draft id keeps incrementing (never reused)
		s.reset("Other"); // resetting an unknown session is a harmless no-op
	});

	test("custom debounce floor is honoured", () => {
		const s = new DraftStreamState(50);
		expect(s.tryClaim("S", 0)).toBe(1);
		expect(s.tryClaim("S", 49)).toBeUndefined();
		expect(s.tryClaim("S", 50)).toBe(2);
	});
});

// ===========================================================================
// deliverDraft: best-effort, warn-once on failure, no fallback, never throws
// ===========================================================================

describe("deliverDraft best-effort delivery", () => {
	test("success (ok:true): one sendRichMessageDraft call with the correct body, no warn", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true, result: { message_id: 1 } }));
		const warns: string[] = [];
		await deliverDraft(bot, { chat_id: 42, message_thread_id: 7 }, 2, "live **preview**", {
			warn: m => warns.push(m),
		});
		expect(calls.length).toBe(1);
		expect(calls[0]!.method).toBe("sendRichMessageDraft");
		expect(calls[0]!.body).toEqual({
			chat_id: 42,
			message_thread_id: 7,
			draft_id: 2,
			rich_message: { markdown: "live **preview**" },
		});
		expect(warns.length).toBe(0);
	});

	test("body omits message_thread_id when base has none", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true }));
		await deliverDraft(bot, { chat_id: "chat-xyz" }, 1, "hi");
		expect(calls[0]!.body).toEqual({ chat_id: "chat-xyz", draft_id: 1, rich_message: { markdown: "hi" } });
	});

	test("null response counts as success: no warn", async () => {
		const { bot } = makeBot(() => null);
		const warns: string[] = [];
		await deliverDraft(bot, { chat_id: 1 }, 1, "x", { warn: m => warns.push(m) });
		expect(warns.length).toBe(0);
	});

	test("thrown transport error: warns exactly once, never throws, no fallback send", async () => {
		const calls: string[] = [];
		const bot: BotApi = {
			async call(): Promise<unknown> {
				calls.push("call");
				throw new Error("boom");
			},
		};
		const warns: string[] = [];
		await deliverDraft(bot, { chat_id: 1 }, 1, "x", { warn: m => warns.push(m) });
		expect(calls).toEqual(["call"]); // no retry / no second HTML send
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain("sendRichMessageDraft failed");
		expect(warns[0]).toContain("boom");
	});

	test("{ok:false} with description: warns once with the description embedded", async () => {
		const { bot } = makeBot(() => ({ ok: false, description: "Bad Request: draft unsupported" }));
		const warns: string[] = [];
		await deliverDraft(bot, { chat_id: 1 }, 1, "x", { warn: m => warns.push(m) });
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain("Bad Request: draft unsupported");
	});

	test("{ok:false} without a usable description degrades to 'ok:false'", async () => {
		const { bot } = makeBot(() => ({ ok: false, description: { nested: "obj" } }));
		const warns: string[] = [];
		await deliverDraft(bot, { chat_id: 1 }, 1, "x", { warn: m => warns.push(m) });
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain("ok:false");
	});

	test("no log provided: a failure is still a silent, crash-free no-op", async () => {
		const bot: BotApi = {
			async call(): Promise<unknown> {
				throw new Error("boom");
			},
		};
		await deliverDraft(bot, { chat_id: 1 }, 1, "x"); // must not throw
	});
});

// ===========================================================================
// threaded-render: the live-only draft marker is additive and does NOT disturb
// the existing finalAnswer -> richMarkdown contract.
// ===========================================================================

describe("renderThreadedFrame draft marker (finalAnswer contract unchanged)", () => {
	test("a live turn_stream carries the RAW markdown as richDraftMarkdown, and still has NO richMarkdown", () => {
		const raw = "streaming **bold** with `code`";
		const send = renderThreadedFrame({ type: "turn_stream", sessionId: "s", phase: "live", text: raw });
		expect(send?.lane).toBe("live");
		expect(send?.richDraftMarkdown).toBe(raw);
		// richMarkdown is the rich-FINAL marker and MUST remain undefined for live frames.
		expect(send?.richMarkdown).toBeUndefined();
		// text stays the HTML-rendered fallback, not the raw markdown.
		expect(send?.text).not.toBe(raw);
		expect(send?.text).toContain("<b>bold</b>");
	});

	test("a finalAnswer turn_stream is unchanged: richMarkdown = raw, and it never sets richDraftMarkdown", () => {
		const raw = "**final** answer";
		const send = renderThreadedFrame({
			type: "turn_stream",
			sessionId: "s",
			phase: "finalized",
			finalAnswer: true,
			text: raw,
		});
		expect(send?.lane).toBe("finalized");
		expect(send?.richMarkdown).toBe(raw); // pre-existing contract intact
		expect(send?.richDraftMarkdown).toBeUndefined(); // draft marker is live-only
	});

	test("a finalized non-finalAnswer turn_stream has neither marker", () => {
		const send = renderThreadedFrame({
			type: "turn_stream",
			sessionId: "s",
			phase: "finalized",
			finalAnswer: false,
			text: "done",
		});
		expect(send?.richMarkdown).toBeUndefined();
		expect(send?.richDraftMarkdown).toBeUndefined();
	});
});

// ===========================================================================
// Daemon-level: opt-in gating, additive live delivery, debounce, reset, and the
// off-state invariant (zero drafts, unchanged HTML path).
// ===========================================================================

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-rich-draft-test-"));
}

function draftSettings(agentDir: string): Settings {
	const base = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
		"notifications.daemon.idleTimeoutMs": 20,
	}) as Settings;
	return new Proxy(base, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

/** Records calls; deterministic private chat + topic 555; accepts sendRichMessageDraft. */
class DraftFakeBotApi {
	calls: Array<{ method: string; body: any }> = [];
	threadId = 555;
	async call(method: string, body: unknown): Promise<unknown> {
		this.calls.push({ method, body });
		if (method === "getMe") return { ok: true, result: { id: 1 } };
		if (method === "getChat")
			return { ok: true, result: { id: (body as { chat_id?: unknown }).chat_id, type: "private" } };
		if (method === "createForumTopic") return { ok: true, result: { message_thread_id: this.threadId } };
		if (method === "sendMessage") return { ok: true, result: { message_id: this.calls.length } };
		if (method === "sendRichMessageDraft") return { ok: true, result: { message_id: this.calls.length } };
		return { ok: true, result: true };
	}
}

function draftSession(id = "S"): any {
	return { sessionId: id, token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
}

function makeDraftDaemon(
	bot: DraftFakeBotApi,
	opts: { richDraft?: { enabled: boolean }; rich?: { enabled: boolean }; now?: () => number },
): TelegramNotificationDaemon {
	return new TelegramNotificationDaemon({
		settings: draftSettings(tempAgentDir()),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot as any,
		...(opts.rich ? { rich: opts.rich } : {}),
		...(opts.richDraft ? { richDraft: opts.richDraft } : {}),
		...(opts.now ? { now: opts.now } : {}),
	});
}

/** Drive an identity_header (creates topic 555) then clear call history. */
async function establishTopic(daemon: TelegramNotificationDaemon, bot: DraftFakeBotApi, session: any): Promise<void> {
	await daemon.handleSessionMessage(session, {
		type: "identity_header",
		sessionId: session.sessionId,
		repo: "r",
		branch: "b",
	});
	bot.calls.length = 0;
}

async function live(daemon: TelegramNotificationDaemon, session: any, text: string): Promise<void> {
	await daemon.handleSessionMessage(session, {
		type: "turn_stream",
		sessionId: session.sessionId,
		phase: "live",
		text,
	});
}

async function finalized(daemon: TelegramNotificationDaemon, session: any, text: string): Promise<void> {
	await daemon.handleSessionMessage(session, {
		type: "turn_stream",
		sessionId: session.sessionId,
		phase: "finalized",
		finalAnswer: true,
		text,
	});
}

const countMethod = (bot: DraftFakeBotApi, method: string): number => bot.calls.filter(c => c.method === method).length;
const findMethod = (bot: DraftFakeBotApi, method: string) => bot.calls.find(c => c.method === method);

describe("daemon draft streaming (opt-in, off by default)", () => {
	describe("off state streams zero drafts and keeps the unchanged HTML path", () => {
		const offStates: Array<{ label: string; richDraft?: { enabled: boolean } }> = [
			{ label: "richDraft undefined" },
			{ label: "richDraft enabled:false" },
		];
		for (const state of offStates) {
			test(state.label, async () => {
				const bot = new DraftFakeBotApi();
				const daemon = makeDraftDaemon(bot, {
					rich: { enabled: false },
					richDraft: state.label === "richDraft enabled:false" ? { enabled: false } : undefined,
				});
				const session = draftSession();
				await establishTopic(daemon, bot, session);
				await live(daemon, session, "live partial");
				await finalized(daemon, session, "final answer");
				expect(countMethod(bot, "sendRichMessageDraft")).toBe(0);
				// Non-vacuous: both frames WERE delivered down the unchanged HTML path.
				expect(countMethod(bot, "sendMessage")).toBe(2);
			});
		}
	});

	test("on streams exactly one rich draft AND still sends the live HTML (additive)", async () => {
		const bot = new DraftFakeBotApi();
		// Draft streaming requires rich enabled (off state stays byte-identical) PLUS
		// the separate richDraft opt-in.
		const daemon = makeDraftDaemon(bot, { rich: { enabled: true }, richDraft: { enabled: true } });
		const session = draftSession();
		await establishTopic(daemon, bot, session);

		await live(daemon, session, "streaming **preview**");
		expect(countMethod(bot, "sendRichMessageDraft")).toBe(1);
		expect(countMethod(bot, "sendMessage")).toBe(1); // live HTML unchanged, still sent
		expect(findMethod(bot, "sendRichMessageDraft")!.body).toEqual({
			chat_id: "42",
			message_thread_id: 555,
			draft_id: 1,
			rich_message: { markdown: "streaming **preview**" },
		});
		expect(findMethod(bot, "sendMessage")!.body.text).toBe(markdownToTelegramHtml("streaming **preview**"));
	});

	test("debounce: rapid live frames are throttled to >=1.5s spacing (fake clock)", async () => {
		let clock = 1_000_000;
		const bot = new DraftFakeBotApi();
		const daemon = makeDraftDaemon(bot, {
			rich: { enabled: true },
			richDraft: { enabled: true },
			now: () => clock,
		});
		const session = draftSession();
		await establishTopic(daemon, bot, session);

		await live(daemon, session, "partial 1"); // t0 -> draft 1
		expect(countMethod(bot, "sendRichMessageDraft")).toBe(1);

		await live(daemon, session, "partial 2"); // same clock -> debounced
		expect(countMethod(bot, "sendRichMessageDraft")).toBe(1);

		clock += DRAFT_DEBOUNCE_MS - 1; // still under the floor from t0
		await live(daemon, session, "partial 3");
		expect(countMethod(bot, "sendRichMessageDraft")).toBe(1);

		clock += 1; // now exactly one debounce window since the last SENT draft
		await live(daemon, session, "partial 4"); // -> draft 2
		expect(countMethod(bot, "sendRichMessageDraft")).toBe(2);
		expect(findMethod(bot, "sendRichMessageDraft")!.body.draft_id).toBe(1); // first recorded draft id
		expect(bot.calls.filter(c => c.method === "sendRichMessageDraft").at(-1)!.body.draft_id).toBe(2);

		// Draft streaming is additive to the unchanged HTML live path: under
		// upstream's editable streaming the first live frame sends and the rest
		// edit it in place, so 4 live frames = 1 sendMessage + 3 editMessageText.
		expect(countMethod(bot, "sendMessage")).toBe(1);
		expect(countMethod(bot, "editMessageText")).toBe(3);
	});

	test("a finalized frame resets the draft window so the next live frame drafts immediately", async () => {
		const clock = 2_000_000;
		const bot = new DraftFakeBotApi();
		const daemon = makeDraftDaemon(bot, {
			rich: { enabled: true },
			richDraft: { enabled: true },
			now: () => clock,
		});
		const session = draftSession();
		await establishTopic(daemon, bot, session);

		await live(daemon, session, "partial 1"); // draft 1
		expect(countMethod(bot, "sendRichMessageDraft")).toBe(1);

		await finalized(daemon, session, "done"); // ends the turn: resets the draft window, rich final sent
		expect(countMethod(bot, "sendRichMessageDraft")).toBe(1); // a finalized frame NEVER drafts

		// Same frozen clock: without the reset this would be debounced; the reset lets it draft.
		await live(daemon, session, "next-turn partial");
		expect(countMethod(bot, "sendRichMessageDraft")).toBe(2);
	});

	test("rich disabled suppresses drafts even when richDraft is opted in (off byte-identity)", async () => {
		const bot = new DraftFakeBotApi();
		// richDraft opted in, but rich globally off: the off state must emit ZERO rich
		// Bot API calls (drafts included) so it stays byte-identical to the HTML path.
		const daemon = makeDraftDaemon(bot, { rich: { enabled: false }, richDraft: { enabled: true } });
		const session = draftSession();
		await establishTopic(daemon, bot, session);
		await live(daemon, session, "streaming preview");
		expect(countMethod(bot, "sendRichMessageDraft")).toBe(0);
	});
});
