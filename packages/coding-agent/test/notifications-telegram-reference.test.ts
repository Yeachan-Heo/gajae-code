import { describe, expect, test } from "bun:test";
import {
	buildActionMarkdown,
	buildActionMessage,
	createAliasTable,
	decodeCallbackData,
	encodeCallbackData,
	routeInboundUpdate,
	sendTelegramHtmlChunks,
	telegramDisableNotification,
	telegramUpdateToReply,
} from "../src/sdk/bus/telegram-reference";

describe("Telegram presentation helpers", () => {
	test("sound policies preserve audible defaults and make important/none opt-in", () => {
		expect(telegramDisableNotification(undefined, "finalized")).toBeUndefined();
		expect(telegramDisableNotification("all", "live")).toBeUndefined();
		expect(telegramDisableNotification("important", "ask")).toBeUndefined();
		expect(telegramDisableNotification("important", "ask", false)).toBe(true);
		expect(telegramDisableNotification("important", "idle")).toBeUndefined();
		expect(telegramDisableNotification("important", "idle", false)).toBe(true);
		expect(telegramDisableNotification("important", "live")).toBe(true);
		expect(telegramDisableNotification("important", "finalized")).toBe(true);
		expect(telegramDisableNotification("none", "ask")).toBe(true);
	});
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
	test.each(["\n", "\r\n", "\r"])("buildActionMarkdown preserves multiline asks with %j line endings", lineEnding => {
		const question = [
			"Deep Interview · Round 4 · Ambiguity 39.5%",
			"Component: 칸반·이슈 관리",
			"Target: 제약 명확성",
			"Why now: 동시 수정 규칙이 필요해요.",
			"동일 이슈의 충돌은 어떻게 처리할까요?",
		].join(lineEnding);

		expect(buildActionMarkdown({ kind: "ask", question })).toBe(
			[
				"❓ **Deep Interview · Round 4 · Ambiguity 39.5%**  ",
				"**Component: 칸반·이슈 관리**  ",
				"**Target: 제약 명확성**  ",
				"**Why now: 동시 수정 규칙이 필요해요.**  ",
				"**동일 이슈의 충돌은 어떻게 처리할까요?**",
				"",
				"(reply with text)",
			].join("\n"),
		);
	});
	test("buildActionMarkdown keeps the single-line ask wire shape", () => {
		expect(buildActionMarkdown({ kind: "ask", question: "Proceed?" })).toBe("❓ **Proceed?**\n\n(reply with text)");
	});
	test("buildActionMarkdown keeps blank lines without malformed emphasis", () => {
		expect(buildActionMarkdown({ kind: "ask", question: "A \t\n\n \t\nB" })).toBe(
			"❓ **A**  \n  \n  \n**B**\n\n(reply with text)",
		);
	});
	test("renders only a valid recommended option in copied HTML and Markdown labels", () => {
		const longSensitiveLabel = "<&_*".repeat(1024);
		const options = ["First", longSensitiveLabel, "Third"];
		const html = buildActionMessage({
			kind: "ask",
			id: "a1",
			question: "Proceed?",
			options,
			recommendedIndex: 1,
		});
		const markdown = buildActionMarkdown({ kind: "ask", question: "Proceed?", options, recommendedIndex: 1 });

		expect(html.text).toContain("(Recommended)");
		expect(html.text).toContain("&lt;&amp;_*");
		expect(html.inline_keyboard?.flat().some(button => button.text.includes("Recommended"))).toBe(false);
		expect(html.text).not.toContain("First (Recommended)");
		expect(html.inline_keyboard?.flat().map(button => button.text)).toEqual(["1", "2", "3"]);
		expect(decodeCallbackData(html.inline_keyboard![0]![1]!.callback_data)).toEqual({ id: "a1", index: 1 });
		expect(markdown).toContain(`${longSensitiveLabel} (Recommended)`);
	});

	test.each([
		undefined,
		-1,
		3,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		"1",
		null,
	])("ignores malformed recommendedIndex %p", recommendedIndex => {
		const options = ["First", "Second", "Third"];
		expect(
			buildActionMessage({ kind: "ask", id: "a1", question: "Proceed?", options, recommendedIndex }).text,
		).not.toContain("(Recommended)");
		expect(buildActionMarkdown({ kind: "ask", question: "Proceed?", options, recommendedIndex })).not.toContain(
			"(Recommended)",
		);
	});

	test("buildActionMessage renders free-text ask and idle ping", () => {
		const freeText = buildActionMessage({ kind: "ask", id: "a1", question: "Name?" });
		expect(freeText.inline_keyboard).toBeUndefined();
		expect(freeText.text).toContain("reply with text");

		const idle = buildActionMessage({ kind: "idle", id: "i1", summary: "done" });
		expect(idle.inline_keyboard).toBeUndefined();
		expect(idle.text).toContain("done");
	});

	test("buildActionMessage idle sessionTag renders the escaped short tag", () => {
		const tagged = buildActionMessage({ kind: "idle", id: "i1", sessionTag: "a1b2c3" });
		expect(tagged.text).toBe("🟢 Agent idle · a1b2c3");
		// The tag is HTML-escaped like any other rendered fragment.
		const hostile = buildActionMessage({ kind: "idle", id: "i2", sessionTag: "<b>x</b>" });
		expect(hostile.text).toBe("🟢 Agent idle · &lt;b&gt;x&lt;/b&gt;");
		// Asks ignore the tag entirely.
		const ask = buildActionMessage({ kind: "ask", id: "a1", question: "Q?", sessionTag: "a1b2c3" });
		expect(ask.text).not.toContain("a1b2c3");
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
		expect(Object.hasOwn(calls[0]!.body, "disable_notification")).toBe(false);
		releases.shift()?.();
		await Bun.sleep(0);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.body.reply_markup).toEqual({ inline_keyboard: keyboard });
		expect(Object.hasOwn(calls[1]!.body, "disable_notification")).toBe(false);
		releases.shift()?.();
		await sending;
		expect(calls.map(call => call.method)).toEqual(["sendMessage", "sendMessage"]);
		const sendImmediately = async (_method: string, body: unknown): Promise<Response> => {
			calls.push({ method: "sendMessage", body: body as Record<string, unknown> });
			return new Response(JSON.stringify({ ok: true }));
		};
		calls.length = 0;
		await sendTelegramHtmlChunks(sendImmediately, "42", "a".repeat(4100), keyboard, "all");
		expect(calls.every(call => !Object.hasOwn(call.body, "disable_notification"))).toBe(true);
		calls.length = 0;
		await sendTelegramHtmlChunks(sendImmediately, "42", "a".repeat(4100), keyboard, "none");
		expect(calls.every(call => call.body.disable_notification === true)).toBe(true);
		calls.length = 0;
		await sendTelegramHtmlChunks(sendImmediately, "42", "a".repeat(4100), keyboard, "important", "idle");
		expect(calls.slice(0, -1).every(call => call.body.disable_notification === true)).toBe(true);
		expect(Object.hasOwn(calls.at(-1)!.body, "disable_notification")).toBe(false);
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

describe("buildActionMarkdown", () => {
	test("ask: heading, blank line, and numbered options as raw markdown", () => {
		const md = buildActionMarkdown({ kind: "ask", question: "Proceed?", options: ["Yes", "No"] });
		expect(md).toContain("Proceed?");
		expect(md).toContain("1. Yes\n2. No");
		expect(md).not.toContain("<b>");
	});

	test("ask without options falls back to the free-text hint", () => {
		const md = buildActionMarkdown({ kind: "ask", question: "Name?" });
		expect(md).toContain("Name?");
		expect(md).toContain("(reply with text)");
	});

	test("idle with and without summary", () => {
		expect(buildActionMarkdown({ kind: "idle", summary: "done" })).toBe("🟢 Agent idle\ndone");
		expect(buildActionMarkdown({ kind: "idle" })).toBe("🟢 Agent idle");
	});

	test("idle sessionTag marks flat fallback identity without leaking full session ids", () => {
		expect(buildActionMarkdown({ kind: "idle", sessionTag: "a1b2c3" })).toBe("🟢 Agent idle · a1b2c3");
		expect(buildActionMarkdown({ kind: "idle", summary: "done", sessionTag: "a1b2c3" })).toBe(
			"🟢 Agent idle · a1b2c3\ndone",
		);
		// Asks never carry a session tag: identity stays container-owned.
		expect(buildActionMarkdown({ kind: "ask", question: "Q?", sessionTag: "a1b2c3" })).not.toContain("a1b2c3");
	});
});
