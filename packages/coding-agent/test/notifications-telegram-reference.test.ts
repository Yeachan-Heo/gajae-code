import { describe, expect, test } from "bun:test";
import {
	buildActionMessage,
	createAliasTable,
	decodeCallbackData,
	encodeCallbackData,
	routeInboundUpdate,
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
				{ aliasTable: table, messageRoutes: new Map(), pendingBySession: () => [], pairedChatId: "chat" },
			),
		).toEqual({ kind: "ignore" });
	});

	test("routeInboundUpdate routes callback aliases and fails closed for unknown aliases", () => {
		const table = createAliasTable();
		const alias = table.put({ sessionId: "s2", actionId: "a2", answer: "yes" });
		const ctx = { aliasTable: table, messageRoutes: new Map(), pendingBySession: () => [], pairedChatId: "42" };
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

	test("routeInboundUpdate: reply_to_message wins; ambiguous plain text is stale (tag commands removed)", () => {
		const messageRoutes = new Map([["10", { sessionId: "reply-session", actionId: "reply-action" }]]);
		const pending = [
			{ sessionId: "s1", actionId: "a1" },
			{ sessionId: "s2", actionId: "a2" },
		];
		const ctx = {
			aliasTable: createAliasTable(),
			messageRoutes,
			pendingBySession: (sessionId?: string) => pending.filter(item => !sessionId || item.sessionId === sessionId),
			pairedChatId: "42",
		};
		// reply_to_message routes to the replied message's action.
		expect(
			routeInboundUpdate(
				{ message: { chat: { id: 42 }, text: "looks good", reply_to_message: { message_id: 10 } } },
				ctx,
			),
		).toEqual({ kind: "reply", sessionId: "reply-session", actionId: "reply-action", answer: "looks good" });
		// Plain text with multiple pending asks is ambiguous; /answer tag commands are gone.
		expect(routeInboundUpdate({ message: { chat: { id: 42 }, text: "plain" } }, ctx)).toEqual({
			kind: "stale",
			reason: "ambiguous_plain_text",
		});
	});

	test("routeInboundUpdate plain text routes only when unambiguous", () => {
		const ctx = {
			aliasTable: createAliasTable(),
			messageRoutes: new Map(),
			pendingBySession: () => [{ sessionId: "only", actionId: "ask" }],
			pairedChatId: "42",
		};
		expect(routeInboundUpdate({ message: { chat: { id: 42 }, text: "answer" } }, ctx)).toEqual({
			kind: "reply",
			sessionId: "only",
			actionId: "ask",
			answer: "answer",
		});
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
