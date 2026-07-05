import { describe, expect, test } from "bun:test";
import {
	buildActionMessage,
	createAliasTable,
	decodeCallbackData,
	encodeCallbackData,
	routeInboundUpdate,
	sendTelegramHtmlChunks,
	telegramUpdateToReply,
} from "../src/notifications/telegram-reference";

describe("telegram reference client helpers", () => {
	test("callback data round-trips and stays within 64 bytes", () => {
		const data = encodeCallbackData("wg_run_stage_1", 2);
		expect(data.length).toBeLessThanOrEqual(64);
		expect(decodeCallbackData(data)).toEqual({ id: "wg_run_stage_1", index: 2 });
		expect(decodeCallbackData("garbage")).toBeNull();
	});

	test("alias table put/get/delete/serialize-load", () => {
		const table = createAliasTable();
		const alias = table.put({ sessionId: "session-with-a-long-id", actionId: "action-with-a-long-id", answer: 7 });
		expect(alias.length).toBeLessThanOrEqual(64);
		expect(table.get(alias)).toEqual({
			sessionId: "session-with-a-long-id",
			actionId: "action-with-a-long-id",
			answer: 7,
		});
		const serialized = table.serialize();
		const loaded = createAliasTable();
		loaded.load(serialized);
		expect(loaded.get(alias)).toEqual({
			sessionId: "session-with-a-long-id",
			actionId: "action-with-a-long-id",
			answer: 7,
		});
		expect(loaded.delete(alias)).toBe(true);
		expect(loaded.get(alias)).toBeUndefined();
	});

	test("routeInboundUpdate enforces allowlist before aliases", () => {
		const table = createAliasTable();
		const alias = table.put({ sessionId: "s1", actionId: "a1", answer: 0 });
		expect(
			routeInboundUpdate(
				{ callback_query: { data: alias, message: { chat: { id: "bad" } } } },
				{ aliasTable: table, messageRoutes: new Map(), pairedChatId: "chat" },
			),
		).toEqual({ kind: "ignore" });
	});

	test("routeInboundUpdate routes callback aliases and fails closed for unknown aliases", () => {
		const table = createAliasTable();
		const alias = table.put({ sessionId: "s2", actionId: "a2", answer: "yes" });
		const ctx = { aliasTable: table, messageRoutes: new Map(), pairedChatId: "42" };
		expect(routeInboundUpdate({ callback_query: { data: alias, message: { chat: { id: 42 } } } }, ctx)).toEqual({
			kind: "reply",
			sessionId: "s2",
			actionId: "a2",
			answer: "yes",
		});
		expect(routeInboundUpdate({ callback_query: { data: "missing", message: { chat: { id: 42 } } } }, ctx)).toEqual({
			kind: "stale",
			reason: "unknown_alias",
		});
	});

	test("routeInboundUpdate: reply_to_message wins; plain text without routing context is ignored", () => {
		const messageRoutes = new Map([["10", { sessionId: "reply-session", actionId: "reply-action" }]]);
		const ctx = {
			aliasTable: createAliasTable(),
			messageRoutes,
			pairedChatId: "42",
		};
		// reply_to_message routes to the replied message's action.
		expect(
			routeInboundUpdate(
				{ message: { chat: { id: 42 }, text: "looks good", reply_to_message: { message_id: 10 } } },
				ctx,
			),
		).toEqual({ kind: "reply", sessionId: "reply-session", actionId: "reply-action", answer: "looks good" });
		// Plain text without an alias or reply-to message does not guess from global pending asks.
		expect(routeInboundUpdate({ message: { chat: { id: 42 }, text: "plain" } }, ctx)).toEqual({ kind: "ignore" });
	});

	test("routeInboundUpdate ignores no-topic plain text even when exactly one ask is pending globally", () => {
		const ctx = {
			aliasTable: createAliasTable(),
			messageRoutes: new Map(),
			pairedChatId: "42",
		};
		expect(routeInboundUpdate({ message: { chat: { id: 42 }, text: "answer" } }, ctx)).toEqual({ kind: "ignore" });
	});

	test("buildActionMessage renders full options in body with compact inline keyboard", () => {
		const m = buildActionMessage({ kind: "ask", id: "a1", question: "Proceed?", options: ["Yes", "No"] });
		expect(m.text).toContain("Proceed?");
		expect(m.text).toContain("1. Yes\n2. No");
		expect(m.inline_keyboard).toHaveLength(1);
		expect(m.inline_keyboard?.[0]?.[0]?.text).toBe("1");
		expect(m.inline_keyboard?.[0]?.[1]?.text).toBe("2");
		expect(decodeCallbackData(m.inline_keyboard![0]![0]!.callback_data)).toEqual({ id: "a1", index: 0 });
	});

	test("buildActionMessage renders free-text ask and idle ping", () => {
		const freeText = buildActionMessage({ kind: "ask", id: "a1", question: "Name?" });
		expect(freeText.inline_keyboard).toBeUndefined();
		expect(freeText.text).toContain("reply with text");

		const idle = buildActionMessage({ kind: "idle", id: "i1", summary: "done" });
		expect(idle.inline_keyboard).toBeUndefined();
		expect(idle.text).toContain("done");
	});

	test("sendTelegramHtmlChunks awaits chunks sequentially and attaches keyboard to final chunk", async () => {
		const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		const releases: Array<() => void> = [];
		const send = async (method: string, body: unknown): Promise<Response> => {
			calls.push({ method, body: body as Record<string, unknown> });
			await new Promise<void>(resolve => releases.push(resolve));
			return new Response(JSON.stringify({ ok: true }));
		};
		const keyboard = [[{ text: "1", callback_data: "r:0:a1" }]];
		const sending = sendTelegramHtmlChunks(send, "42", "a".repeat(4100), keyboard);

		await Bun.sleep(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body.reply_markup).toBeUndefined();
		releases.shift()?.();
		await Bun.sleep(0);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.body.reply_markup).toEqual({ inline_keyboard: keyboard });
		releases.shift()?.();
		await sending;
		expect(calls.map(call => call.method)).toEqual(["sendMessage", "sendMessage"]);
	});

	test("telegramUpdateToReply maps a button tap to an option index", () => {
		const update = { callback_query: { id: "cq1", data: encodeCallbackData("a1", 1) } };
		expect(telegramUpdateToReply(update, "tok", undefined)).toEqual({
			type: "reply",
			id: "a1",
			answer: 1,
			token: "tok",
		});
	});

	test("telegramUpdateToReply maps free text to the latest pending ask", () => {
		const update = { message: { text: "looks good" } };
		expect(telegramUpdateToReply(update, "tok", "a9")).toEqual({
			type: "reply",
			id: "a9",
			answer: "looks good",
			token: "tok",
		});
		expect(telegramUpdateToReply(update, "tok", undefined)).toBeNull();
	});

	test("telegramUpdateToReply ignores irrelevant updates", () => {
		expect(telegramUpdateToReply({}, "tok", "a1")).toBeNull();
		expect(telegramUpdateToReply({ callback_query: { data: "bad" } }, "tok", "a1")).toBeNull();
	});
});
