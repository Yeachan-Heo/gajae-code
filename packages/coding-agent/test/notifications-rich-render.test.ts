import { describe, expect, test } from "bun:test";
import {
	buildRichMessage,
	deliverRichActionWithFallback,
	deliverRichWithFallback,
	shouldPromoteRich,
} from "../src/sdk/bus/rich-render";
import type { BotApi } from "../src/sdk/bus/telegram-daemon";
import type { ThreadedSend } from "../src/sdk/bus/threaded-render";

/** A valid finalized send that satisfies the rich-markdown marker clauses. */
function makeSend(over: Partial<ThreadedSend> = {}): ThreadedSend {
	return {
		method: "sendMessage",
		lane: "finalized",
		richClass: "final",
		text: "final answer",
		richMarkdown: "# Final\nbody",
		...over,
	};
}

/** A fully-passing `shouldPromoteRich` input; override one field per case. */
function baseInput(
	over: Partial<Parameters<typeof shouldPromoteRich>[0]> = {},
): Parameters<typeof shouldPromoteRich>[0] {
	return { enabled: true, send: makeSend(), ...over };
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

describe("shouldPromoteRich truth table", () => {
	test("happy path: every clause holds -> true", () => {
		expect(shouldPromoteRich(baseInput())).toBe(true);
	});

	test("enabled false -> false", () => {
		expect(shouldPromoteRich(baseInput({ enabled: false }))).toBe(false);
	});

	test("enabled undefined -> false", () => {
		expect(shouldPromoteRich(baseInput({ enabled: undefined }))).toBe(false);
	});

	test("editable finalized send -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ editable: true }) }))).toBe(false);
	});

	test("non-editable finalized send -> true", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ editable: false }) }))).toBe(true);
	});

	test("method other than sendMessage -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ method: "sendPhoto" }) }))).toBe(false);
	});

	test("lane other than finalized -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ lane: "live" }) }))).toBe(false);
	});

	test("richClass absent -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richClass: undefined }) }))).toBe(false);
	});

	// The type only permits richClass "final"; these forge invalid runtime classes
	// (a buggy/hostile frame) to prove the gate still fail-closes on non-final.
	test("forged richClass ask/idle -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richClass: "ask" as unknown as "final" }) }))).toBe(false);
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richClass: "idle" as unknown as "final" }) }))).toBe(false);
	});

	test("forged richClass system -> false (system metadata frames are not rich-promoted)", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richClass: "system" as unknown as "final" }) }))).toBe(
			false,
		);
	});

	test("richMarkdown empty string -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richMarkdown: "" }) }))).toBe(false);
	});

	test("richMarkdown undefined -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richMarkdown: undefined }) }))).toBe(false);
	});

	test("oversized richMarkdown -> false (HTML chunk path owns long finalized turns)", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richMarkdown: "x".repeat(4097) }) }))).toBe(false);
	});
	test("send.text empty string -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ text: "" }) }))).toBe(false);
	});

	test("send.text undefined -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ text: undefined }) }))).toBe(false);
	});
});

describe("buildRichMessage", () => {
	test("wraps raw markdown verbatim in rich_message shape", () => {
		expect(buildRichMessage("# Title\n**bold** & <raw>")).toEqual({
			rich_message: { markdown: "# Title\n**bold** & <raw>" },
		});
	});

	test("preserves an empty string without substitution", () => {
		expect(buildRichMessage("")).toEqual({ rich_message: { markdown: "" } });
	});
	test("includes reply_markup extras when supplied", () => {
		expect(
			buildRichMessage("answer", { reply_markup: { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] } }),
		).toEqual({
			rich_message: { markdown: "answer" },
			reply_markup: { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] },
		});
	});
});

describe("deliverRichWithFallback", () => {
	test("success (ok:true): one sendRichMessage call, correct body, no fallback, no warn", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true, result: { message_id: 1 } }));
		let fallbacks = 0;
		const warns: string[] = [];
		const send = makeSend({ richMarkdown: "# Final\nbody" });
		await deliverRichWithFallback(
			bot,
			{ chat_id: 42, message_thread_id: 7 },
			send,
			async () => {
				fallbacks++;
			},
			{ warn: m => warns.push(m) },
		);
		expect(calls.length).toBe(1);
		expect(calls[0]!.method).toBe("sendRichMessage");
		expect(calls[0]!.body).toEqual({
			chat_id: 42,
			message_thread_id: 7,
			rich_message: { markdown: "# Final\nbody" },
		});
		expect(fallbacks).toBe(0);
		expect(warns.length).toBe(0);
	});

	test("success body omits message_thread_id when base has none", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true }));
		await deliverRichWithFallback(bot, { chat_id: "chat-xyz" }, makeSend({ richMarkdown: "hi" }), async () => {});
		expect(calls[0]!.body).toEqual({ chat_id: "chat-xyz", rich_message: { markdown: "hi" } });
	});

	test("null response counts as success: no fallback, no warn", async () => {
		const { bot } = makeBot(() => null);
		let fallbacks = 0;
		const warns: string[] = [];
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				fallbacks++;
			},
			{ warn: m => warns.push(m) },
		);
		expect(fallbacks).toBe(0);
		expect(warns.length).toBe(0);
	});

	test("thrown error: warns exactly once before running fallback (order)", async () => {
		const events: string[] = [];
		const bot: BotApi = {
			async call(): Promise<unknown> {
				events.push("call");
				throw new Error("boom");
			},
		};
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				events.push("fallback");
			},
			{
				warn: m => {
					events.push("warn");
					expect(m).toContain("boom");
				},
			},
		);
		expect(events).toEqual(["call", "warn", "fallback"]);
	});

	test("{ok:false} with description: warns once with description then falls back once", async () => {
		const { bot } = makeBot(() => ({ ok: false, description: "Bad Request: rich unsupported" }));
		let fallbacks = 0;
		const warns: string[] = [];
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				fallbacks++;
			},
			{ warn: m => warns.push(m) },
		);
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain("Bad Request: rich unsupported");
		expect(warns[0]).toContain("falling back to HTML");
		expect(fallbacks).toBe(1);
	});

	test("{ok:false} without description: warns once with ok:false then falls back once", async () => {
		const { bot } = makeBot(() => ({ ok: false }));
		let fallbacks = 0;
		const warns: string[] = [];
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				fallbacks++;
			},
			{ warn: m => warns.push(m) },
		);
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain("ok:false");
		expect(fallbacks).toBe(1);
	});

	test("no log provided: failure still falls back without crashing", async () => {
		const bot: BotApi = {
			async call(): Promise<unknown> {
				throw new Error("boom");
			},
		};
		let fallbacks = 0;
		await deliverRichWithFallback(bot, { chat_id: 1 }, makeSend(), async () => {
			fallbacks++;
		});
		expect(fallbacks).toBe(1);
	});

	test("no log provided: success neither crashes nor falls back", async () => {
		const { bot } = makeBot(() => ({ ok: true }));
		let fallbacks = 0;
		await deliverRichWithFallback(bot, { chat_id: 1 }, makeSend(), async () => {
			fallbacks++;
		});
		expect(fallbacks).toBe(0);
	});
});
describe("deliverRichActionWithFallback", () => {
	test("rich success: one sendRichMessage with top-level reply_markup, returns id, usedRich, no fallback/warn", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true, result: { message_id: 77 } }));
		let fallbacks = 0;
		const warns: string[] = [];
		const replyMarkup = { inline_keyboard: [[{ text: "A", callback_data: "x" }]] };
		const res = await deliverRichActionWithFallback(
			bot,
			{ chat_id: 42, message_thread_id: 7 },
			{ markdown: "❓ **Proceed?**\n\n1. Yes\n2. No", replyMarkup },
			async () => {
				fallbacks++;
				return 999;
			},
			{ warn: (m: string) => warns.push(m) },
		);
		expect(res).toEqual({ messageId: 77, usedRich: true, usedFallback: false });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe("sendRichMessage");
		expect(calls[0]!.body).toEqual({
			chat_id: 42,
			message_thread_id: 7,
			rich_message: { markdown: "❓ **Proceed?**\n\n1. Yes\n2. No" },
			reply_markup: replyMarkup,
		});
		expect(fallbacks).toBe(0);
		expect(warns).toHaveLength(0);
	});

	test("no replyMarkup: reply_markup omitted from the rich body (idle)", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true, result: { message_id: 5 } }));
		const res = await deliverRichActionWithFallback(
			bot,
			{ chat_id: "c" },
			{ markdown: "🟢 Agent idle" },
			async () => 0,
		);
		expect(res).toEqual({ messageId: 5, usedRich: true, usedFallback: false });
		expect(calls[0]!.body).toEqual({ chat_id: "c", rich_message: { markdown: "🟢 Agent idle" } });
	});

	test("success without result.message_id: usedRich true, messageId undefined", async () => {
		const { bot } = makeBot(() => ({ ok: true }));
		const res = await deliverRichActionWithFallback(bot, { chat_id: 1 }, { markdown: "x" }, async () => 0);
		expect(res).toEqual({ messageId: undefined, usedRich: true, usedFallback: false });
	});

	test("requireMessageId + rich success without message_id: falls back to HTML for a routable id", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true })); // ok but no result.message_id
		let fallbacks = 0;
		const res = await deliverRichActionWithFallback(
			bot,
			{ chat_id: 1 },
			{ markdown: "ask?", requireMessageId: true },
			async () => {
				fallbacks++;
				return 888;
			},
		);
		expect(res).toEqual({ messageId: 888, usedRich: false, usedFallback: true });
		expect(calls.filter(c => c.method === "sendRichMessage")).toHaveLength(1);
		expect(fallbacks).toBe(1);
	});

	test("ok:false: warns exactly once, runs htmlFallback, returns its id, usedFallback", async () => {
		const { bot, calls } = makeBot(() => ({ ok: false, description: "no rich" }));
		const warns: string[] = [];
		let fallbacks = 0;
		const res = await deliverRichActionWithFallback(
			bot,
			{ chat_id: 1 },
			{ markdown: "x", replyMarkup: { inline_keyboard: [] } },
			async () => {
				fallbacks++;
				return 321;
			},
			{ warn: (m: string) => warns.push(m) },
		);
		expect(res).toEqual({ messageId: 321, usedRich: false, usedFallback: true });
		expect(calls.filter(c => c.method === "sendRichMessage")).toHaveLength(1);
		expect(fallbacks).toBe(1);
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("sendRichMessage(action) failed");
	});

	test("throw: warns once then falls back to HTML and returns the fallback id", async () => {
		const { bot } = makeBot(() => {
			throw new Error("transport down");
		});
		const warns: string[] = [];
		let fallbacks = 0;
		const res = await deliverRichActionWithFallback(
			bot,
			{ chat_id: 1 },
			{ markdown: "x" },
			async () => {
				fallbacks++;
				return 654;
			},
			{ warn: (m: string) => warns.push(m) },
		);
		expect(res).toEqual({ messageId: 654, usedRich: false, usedFallback: true });
		expect(fallbacks).toBe(1);
		expect(warns).toHaveLength(1);
	});
});
